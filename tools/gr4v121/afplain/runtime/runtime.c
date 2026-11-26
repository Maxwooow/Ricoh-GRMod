/* SPDX-License-Identifier: GPL-2.0-only */
/* GR IV 1.20 subject AF, plain design (2026-11-10 rewrite).
 *
 * What it does, in order:
 *   LV task    a usable live-view frame is sampled every few frames to a 96x64 RGB
 *              thumbnail (three rotating buffers, per-buffer sequence counter).
 *   UI task    at half-press (just before the stock AF START is sent) the
 *              subject network runs on the newest thumbnail and the resulting box
 *              is mapped to the stock 60-byte face/eye region and published.
 *   AF task    when stock AF asks for the selected face region and the stock
 *              answer is empty, the published box is returned instead.
 *   UI task    when the stock in-focus sound is about to play for an AF that
 *              used the box, the stock short shutter sound is played instead.
 *   Photo      every JPEG/DNG gets a 96-byte record of the counters below.
 *
 * What it deliberately does not do: follow the START message through the
 * message system, keep leases/fences/nonces, wait for a frame, or reject on
 * settings it does not need. Tasks share only the thumbnail buffers and the
 * box slot, both through sequence counters; nothing here can block or abort
 * another task's request.
 *
 * Rules kept: manual point / non auto-area / movie -> stock. Stock face or eye
 * present -> stock. Otherwise the box. When the network has no answer (blank
 * frame, thumbnail too old, model error) the box is the middle of the frame,
 * never the stock multi-area choice. Only when no thumbnail was ever taken
 * (no geometry to map a box with) does stock AF decide. */
#include "runtime.h"
#include "subject_net.h"
#include "stock_tier_lv.h"
#include "diag_attach.h"
#include "stock_point_api.h"
#define U 0x550832a8u
#define F 0x550873e4u
#define SOUND 0x55087450u
#define CAF 0x550a56a4u
#define GEOMETRY 0x55084958u    /* stock UI-to-AF geometry service, as used by the earlier point-move build */
#define HEAP_BEGIN 0x59600000u
#define HEAP_END 0x5a600000u
#define PL_MAGIC 0x314e4c50u /* "PLN1" */
#define PL_BUFFERS 3u
#define TW 96u                  /* thumbnail fed to the subject network */
#define TH 64u
#define TBYTES (3u*TW*TH)       /* 18432; the buffers keep their earlier 18900 bytes (bench reads them) */
#define NET_WORK_BYTES 76800u   /* subject network scratch; the model header must ask for no more */
#define PL_WINDOW_TICKS 90u     /* collector calls a box stays offered after half-press */
#define PL_FRAME_MAX_AGE 90u    /* collector calls a thumbnail may be old (about 2-3 s; v41: older ones showed another scene) */
#define PL_SAMPLE_GAP 8u        /* collector calls between two thumbnails */
#define PL_CUE_TICKS 240u
#define PL_MODEL_STALE 9u       /* model_last when the thumbnail was too old to trust */
#define LR_CATEGORY 0x5360f610u
#define LR_REGION 0x5361b734u
#define LR_RECT 0x536129f0u
#define LR_FOCUS_SOUND 0x533a26acu
/* Zero-filled by the loader; lives in the 512 bytes reserved before the heap (0x55839080, after the
 * C library's unused sbrk arena 0x55839040..0x55839080, which other additions use). */
struct pl_static {
 volatile uint32_t state_word;                 /* 0 none, 1 allocating, 2 failed, else pl_state* */
 uint32_t seen;                                /* bit per hook that has fired */
 uint32_t frames_ok,frames_bad,last_bad_step;
 uint32_t s1_runs,s1_skips,s1_last_gate,model_ok,model_fail,model_last,frame_age;
 uint32_t cat_calls,supplied_cat,supplied_region,supplied_rect,native_wins,no_box;
 uint32_t sound_calls,sound_swaps,sound_last;
 uint32_t photo_seq,attach_last;
 uint32_t lv_profile,lv_format,lv_w,lv_h,lv_cw,lv_yhigh;
 uint32_t box[4],roi[4];int32_t score,presence;uint32_t gated,texture;
 uint32_t box_id,box_tick,used_id,now_tick;
 uint32_t t_model,t_unused,t_sample,t_lvtick,t_last_lv;   /* CPU cycles, see cyc() */
 uint32_t point_runs,point_last,point_mode,point_x,point_y;   /* AI start frame for Follow / Continuous */
 uint32_t late_state,late_ticks,late_wait,late_offered,late_task,late_other_task,late_others,lv_task;               /* box recomputed after the half-press: see late_compute(); the last five are unused since v46 */
 uint32_t lv_switch,rej_facts,hp_facts;        /* why usable live-view frames are rare: see recipe_facts() */
 uint32_t direct_ok,lv_direct,hp_direct;       /* thumbnails taken from a direct canvas; source of the newest thumbnail; of the one the half-press used */
};
typedef char static_fits[(sizeof(struct pl_static)<=0x200u)?1:-1];
struct pl_frame {volatile uint32_t seq;uint32_t tick;struct aft_geometry view;uint8_t rgb[18900];};
struct pl_state {
 uint32_t magic;
 volatile uint32_t published;                  /* (tick<<2)|buffer, 0 = none yet */
 uint32_t tick;                                /* LV task only */
 /* half-press without a fresh thumbnail (see late_compute): box id waiting for a frame, tick of that
  * half-press; three words unused since v46 */
 volatile uint32_t want_id,want_tick,unused_wait[3];
 struct pl_frame frame[PL_BUFFERS];
 volatile uint32_t s1_busy;                    /* UI task re-entry guard */
 uint8_t work_rgb[18900];struct aft_geometry work_view;
 uint16_t tab[2u*(TW+TH)];                     /* LV task only: sampling positions */
 uint32_t net_work[NET_WORK_BYTES/4u];         /* UI task only */
 uint32_t faces[150];                          /* UI task only: copy of the stock face list (10 x 60 bytes) */
 volatile uint32_t box_seq;                    /* odd while the UI task writes the box */
 struct aft_subject box;uint32_t box_id,box_tick;
 uint32_t latched,latch_id;struct aft_subject latch;   /* AF task only */
 volatile uint32_t cue_id,cue_tick;
};
typedef char state_bounded[(sizeof(struct pl_state)<=0x28000u)?1:-1];
typedef char context_layout[(sizeof(struct s1_module_ctx)==80u)?1:-1];
static struct pl_static*st(void){return(struct pl_static*)(uintptr_t)0x55839080u;}
/* Timing probe: the Cortex-A7 cycle counter.  Privileged modes only; each core has its own
 * counter, so a task that moves between cores gives one wrong sample now and then. */
static uint32_t cyc(void){
 uint32_t v;
 __asm__ volatile("mrs %0,cpsr":"=r"(v));
 if((v&0x1fu)==0x10u)return 0;                                  /* user mode: no access */
 __asm__ volatile("mrc p15,0,%0,c9,c12,0":"=r"(v));
 if(!(v&1u)||(v&8u)){v=(v|1u)&~8u;__asm__ volatile("mcr p15,0,%0,c9,c12,0"::"r"(v));}   /* enable, count every cycle */
 v=0x80000000u;__asm__ volatile("mcr p15,0,%0,c9,c12,1"::"r"(v));
 __asm__ volatile("mrc p15,0,%0,c9,c13,0":"=r"(v));
 return v;
}
static uint32_t r32(uintptr_t p,uint32_t o){return *(const volatile uint32_t*)(p+o);}
static uint8_t r8(uintptr_t p,uint32_t o){return *(const volatile uint8_t*)(p+o);}
static int span(uintptr_t p,uint32_t n){return p&&n&&p<=UINTPTR_MAX-(n-1u);}
static void barrier(void){__asm__ volatile("dmb sy":::"memory");}
static void zero(void*p,uint32_t n){volatile uint8_t*d=p;uint32_t i;for(i=0;i<n;i++)d[i]=0;}
static void copy(void*p,const void*q,uint32_t n){uint8_t*d=p;const uint8_t*s=q;uint32_t i;for(i=0;i<n;i++)d[i]=s[i];}
static int nonzero(const void*a,uint32_t n){const uint8_t*x=a;uint32_t i,v=0;for(i=0;i<n;i++)v|=x[i];return v!=0;}
static void bump(uint32_t*p){if(*p!=UINT32_MAX)(*p)++;}
static int cas(volatile uint32_t*p,uint32_t expected,uint32_t desired){
 uint32_t v,failed,i;
 for(i=0;i<8;i++){
  __asm__ volatile("ldrex %0,[%1]":"=&r"(v):"r"(p):"memory");
  if(v!=expected){__asm__ volatile("clrex":::"memory");return 0;}
  __asm__ volatile("strex %0,%2,[%1]":"=&r"(failed):"r"(p),"r"(desired):"memory");
  if(!failed){barrier();return 1;}
 }
 return 0;
}
/* Stock static-init guards of UserData (U) and the focus model (F). */
static int natives_ready(void){return (r32(0x55083244u,0)&1u)&&(r32(0x550873d8u,0)&1u);}
static int ctx_ok(const struct s1_module_ctx*k){
 return k&&k->magic==S1_MODULE_MAGIC&&k->enabled==1u&&(uintptr_t)k->state_word==0x55839080u&&
  k->model&&k->model_bytes&&k->reserved[0]>=0x54400000u&&k->reserved[0]<0x55000000u&&!(k->reserved[0]&3u);
}
static struct pl_state*state(void){
 uintptr_t p=st()->state_word;
 if((p&3u)||p<HEAP_BEGIN||p>HEAP_END-sizeof(struct pl_state))return 0;
 return ((struct pl_state*)p)->magic==PL_MAGIC?(struct pl_state*)p:0;
}
/* One allocation from stock heap 2 (the allocator the earlier builds used and
 * that initialised correctly on the camera). Whichever task gets here first
 * allocates; the others see 1 and simply skip this call. */
static struct pl_state*state_or_create(void){
 struct pl_state*s=state();
 if(s||st()->state_word)return s;
 if(!cas(&st()->state_word,0,1))return 0;
 s=((struct pl_state*(*)(uint32_t))0x53909154u)(sizeof(*s));
 if(!s||((uintptr_t)s&3u)||(uintptr_t)s<HEAP_BEGIN||(uintptr_t)s>HEAP_END-sizeof(*s)){barrier();st()->state_word=2;barrier();return 0;}
 zero(s,sizeof(*s));s->magic=PL_MAGIC;barrier();st()->state_word=(uint32_t)(uintptr_t)s;barrier();
 return s;
}
/* ---- live view: LV task ------------------------------------------------ */
/* Diagnostic only (record bytes 54/55). The stock frame loop 53662520 hands a recipe to the
 * display hand-over we hook either with its display descriptor filled (5366aa40, format 2) or
 * without; on the camera most calls are of the second sort. Low byte: the recipe's kind flags
 * c+bbc..bc3 (bit 0 bbd, 1 bbe, 2 bbf, 3 bc0, 4 bc1, 5 bc2, 6 bc3, 7 bbc). High byte: bits 0-3
 * c+8, 4-5 descriptor format c+a08, 6 process+3d8 (stock: display recipes are processed), 7 process+81. */
static uint32_t recipe_facts(uintptr_t c,uintptr_t process){
 uint32_t v=0,i;
 for(i=0;i<7u;i++)if(r8(c,0xbbdu+i))v|=1u<<i;
 if(r8(c,0xbbc))v|=128u;
 v|=(r32(c,8)&15u)<<8;v|=(r8(c,0xa08)&3u)<<12;
 if(r8(process,0x3d8))v|=1u<<14;
 if(r8(process,0x81))v|=1u<<15;
 return v;
}
static void collect(struct pl_state*s,uintptr_t c,uintptr_t process){
 struct s1_request q;struct aft_rect visible;struct aft_geometry g;struct aft_cache_plan plan;struct aft_lv_facts f;
 struct pl_frame*b;uint32_t why=0,next,tick,source;uintptr_t cache;
 if(!span(c,0xbf4)||!span(process,0x3b4)||(c&3u)||(process&3u)||!aft_lv_recipe_live(process,c))return;
 tick=++s->tick;if(!tick)tick=s->tick=1;st()->now_tick=tick;
 {uint32_t now=cyc();if(st()->t_last_lv)st()->t_lvtick=now-st()->t_last_lv;st()->t_last_lv=now;}
 aft_lv_read_facts(c,process,&f);
 st()->lv_switch=recipe_facts(c,process);
 zero(&q,sizeof(q));
 if(!aft_lv_visible(process,&visible)||!(source=aft_lv_input(1,c,process,tick,&visible,r8(U,0xc38),r8(U,0xc3a),&q,&g,&plan,&why))){
  if(!why)why=14u;bump(&st()->frames_bad);st()->last_bad_step=why;st()->rej_facts=st()->lv_switch;return;
 }
 /* A thumbnail is taken when the last one is PL_SAMPLE_GAP calls old (sampling
  * costs roughly half a million instructions in the LV task). On the camera
  * usable frames come in bursts between long runs of unusable recipes (v37:
  * gaps of 110 and 172 calls), so the first usable frame after a gap is always
  * taken at once. */
 if(s->published&&tick-(s->published>>2)<PL_SAMPLE_GAP)return;
 st()->lv_profile=f.profile;st()->lv_format=(f.format&15u)|(f.soft<<4);st()->lv_w=f.active_width;st()->lv_h=f.active_height;st()->lv_cw=f.canvas_width;st()->lv_yhigh=f.y_address>>24;
 next=((s->published&3u)+1u)%PL_BUFFERS;b=&s->frame[next];
 b->seq++;barrier();                           /* odd: being written */
 cache=((uintptr_t(*)(void))0x53918d48u)();
 ((void(*)(uintptr_t,uint32_t,uint32_t))0x53918dc4u)(cache,plan.y_address,plan.y_bytes);
 ((void(*)(uintptr_t,uint32_t,uint32_t))0x53918dc4u)(cache,plan.uv_address,plan.uv_bytes);
 barrier();q.max_samples=6300;why=cyc();
 if(s1_sample_thumb(&q,b->rgb,TW,TH,s->tab)!=S1_APPLY){b->tick=0;b->seq++;barrier();bump(&st()->frames_bad);st()->last_bad_step=15u;return;}
 st()->t_sample=cyc()-why;
 copy(&b->view,&g,sizeof(g));b->tick=tick;b->seq++;barrier();   /* even: complete */
 s->published=(tick<<2)|next;barrier();bump(&st()->frames_ok);st()->lv_direct=source==2u;if(source==2u)bump(&st()->direct_ok);
}
/* ---- half-press: UI task ----------------------------------------------- */
#define PL_FRESH_TICKS 10u      /* a thumbnail this new needs no second look after the half-press */
enum {LATE_NONE=0,LATE_WAITING=1,LATE_DONE=2,LATE_EXPIRED=3,LATE_NO_ANSWER=4,LATE_MAP=5,LATE_FRAME=6,LATE_DONE_AFTER_OFFER=7};
enum {GATE_OK=0,GATE_NOT_START=1,GATE_NATIVES=2,GATE_MOVIE=3,GATE_MODE=4,GATE_MANUAL=5,GATE_BUSY=6,GATE_NO_FRAME=7,GATE_OLD_FRAME=8,GATE_MAP=9};
static uint32_t mode_gate(void){
 if(!natives_ready())return GATE_NATIVES;
 if(r8(U,0xb76))return GATE_MOVIE;
 /* auto-area AF with no temporary focus override: the same bytes the earlier
  * build tested, which the camera passed on every half-press. */
 if(r8(U,0xc1d)||r8(U,0xdc)||r8(U,0xc20)||r8(U,0x7c)!=13u||r8(U,0xbc0)!=13u||r8(F,0x15)!=13u)return GATE_MODE;
 if(r8(F,8)||r8(F,0x10)||r8(F,0x12))return GATE_MANUAL;
 return GATE_OK;
}
/* Follow (5) or Continuous (6) AF with nothing overriding it: the modes in which, when the build
 * enables it, the network places the stock AF frame on the subject before stock AF starts. */
static uint32_t follow_mode(void){
 uint32_t m;
 if(!natives_ready()||r8(U,0xb76))return 0;
 m=r8(U,0xc1d);
 if((m!=5u&&m!=6u)||r8(U,0xdc)!=m||r8(U,0xc20)!=m||r8(U,0x7c)!=13u||r8(U,0xbc0)!=13u||r8(F,0x15)!=13u)return 0;
 return m;
}
enum {POINT_NO_FRAME=16,POINT_OLD_FRAME=17,POINT_NO_ANSWER=18,POINT_NOT_READY=19,POINT_ASPECT=20};
static int newest_frame(struct pl_state*s,uint32_t*age){
 uint32_t tries,p,seq;struct pl_frame*b;
 for(tries=0;tries<4u;tries++){
  p=s->published;barrier();if(!p)return 0;
  b=&s->frame[p&3u];seq=b->seq;barrier();if(seq&1u)continue;
  copy(s->work_rgb,b->rgb,TBYTES);copy(&s->work_view,&b->view,sizeof(b->view));
  *age=s->tick-b->tick;barrier();
  if(b->seq==seq&&b->tick&&s->work_view.nonce==b->tick)return 1;
 }
 return 0;
}
/* Stock objects the point-move sequence needs, and the full 3:2 frame the UI coordinates assume. */
static uint32_t point_ready(uint32_t mode,uintptr_t*ops_out){
 Gr4Area frame;uintptr_t ops=(r32(0x550831d4u,0)&1u)&&(r32(0x5537b2a0u,0)&1u)?r32(0x5537b2a4u,4):0;
 *ops_out=ops;
 if(!span(ops,0x51c)||(ops&3u)||((uint32_t(*)(uintptr_t))0x5377d4dcu)(ops)!=(mode==5u?3u:2u))return POINT_NOT_READY;   /* Common's AF kind: 3 tracking, 2 continuous (stock table 532a16d8) */
 zero(&frame,sizeof(frame));((void(*)(uintptr_t,Gr4Area*))0x5377d084u)(ops,&frame);
 if(!frame.width||!frame.height||frame.x||frame.y||frame.width*2u!=frame.height*3u||frame.width>0x10000000u)return POINT_ASPECT;
 return 0;
}
/* Follow AF in a faceFollow build (stock face detection kept running in Follow mode): the first
 * entry of the stock face list, read with the stock list getter the focus model itself uses
 * (533ac820 -> 5377ba40).  Entry: face, eye, eye, each {width,height,x,y} in 1/4096 of the 720x480
 * UI frame.  Target: the larger valid eye (stock rule: both sides above 20 units), else the face.
 * Returns 0 none, 1 face, 2 eye. */
static uint32_t face_target(struct pl_state*s,uintptr_t ops,Gr4Point*target){
 const uint32_t*f=s->faces,*e,*pick;uint32_t i,kind=1;
 zero(s->faces,sizeof(s->faces));
 ((void(*)(uintptr_t,uint32_t*))0x5377c6d0u)(ops,s->faces);
 if(!f[0]||!f[1]||f[0]>(720u<<12)||f[1]>(480u<<12)||f[2]>(720u<<12)-f[0]||f[3]>(480u<<12)-f[1])return 0;
 pick=f;
 for(i=1;i<3u;i++){
  e=f+4u*i;
  if(e[0]<=0x14000u||e[1]<=0x14000u||e[0]>f[0]||e[1]>f[1]||e[2]>(720u<<12)-e[0]||e[3]>(480u<<12)-e[1])continue;
  if(kind==1u||e[0]*(e[1]>>12)>pick[0]*(pick[1]>>12)){pick=e;kind=2;}
 }
 target->x=(int32_t)((pick[2]+pick[0]/2u)>>12);target->y=(int32_t)((pick[3]+pick[1]/2u)>>12);
 return kind;
}
/* Follow / Continuous AF: move the stock AF frame with the stock point-move sequence, onto the
 * stock face or eye when a faceFollow build sees one, otherwise onto the cell the network picks.
 * The stock tracker or continuous AF then starts from there. With no answer the frame stays where
 * the user left it. Nothing is offered to the face getter. */
static void place_frame(struct pl_state*s,const struct s1_module_ctx*k,uint32_t mode){
 struct subj_result result;struct subj_header h;Gr4PointResult p;Gr4Point target;uintptr_t ops=0;uint32_t age=0,status,col,row,face=0;
 bump(&st()->point_runs);st()->point_mode=mode;
 if(!cas(&s->s1_busy,0,1)){st()->point_last=GATE_BUSY;return;}
 target.x=target.y=0;
 if((k->reserved[1]&8u)&&mode==5u&&!point_ready(mode,&ops))face=face_target(s,ops,&target);
 if(face){
  status=0;st()->gated=255u-face;st()->score=0;st()->presence=0;      /* record: cell 254 = face, 253 = eye */
  st()->box[0]=st()->box[1]=st()->box[2]=st()->box[3]=0;
 }else{
  status=POINT_NO_FRAME;
  if(newest_frame(s,&age)){
   st()->frame_age=age;status=POINT_OLD_FRAME;
   if(age<=PL_FRAME_MAX_AGE){
    uint32_t t0=cyc();
    status=(uint32_t)subj_check(k->model,k->model_bytes,&h);
    if(!status&&(h.in_w!=TW||h.in_h!=TH))status=SUBJ_BAD_MODEL;
    zero(&result,sizeof(result));
    if(!status)status=(uint32_t)subj_run(s->work_rgb,k->model,k->model_bytes,s->net_work,sizeof(s->net_work),&result);
    st()->t_model=cyc()-t0;st()->model_last=status;
    status=status==SUBJ_OK?0u:POINT_NO_ANSWER;
   }
  }
  if(!status)status=point_ready(mode,&ops);
  if(!status){
   row=0;col=result.best_index;while(col>=result.grid_w){col-=result.grid_w;row++;}
   target.x=(int32_t)((2u*col+1u)*720u/(2u*result.grid_w));target.y=(int32_t)((2u*row+1u)*480u/(2u*result.grid_h));
   st()->gated=result.best_index;st()->score=result.best_score>>5;st()->presence=result.second_score>>5;
   st()->box[0]=result.x0_q16;st()->box[1]=result.y0_q16;st()->box[2]=result.x1_q16;st()->box[3]=result.y1_q16;
  }
 }
 if(!status){
  zero(&p,sizeof(p));
  status=gr4_apply_stock_point(U,F,GEOMETRY,ops,mode,target,&p);
  st()->point_x=(uint32_t)p.clamped.x;st()->point_y=(uint32_t)p.clamped.y;
 }
 st()->point_last=status;
 barrier();s->s1_busy=0;barrier();
}
static void half_press(struct pl_state*s,const struct s1_module_ctx*k,const uint32_t*r){
 struct subj_result result;struct aft_subject subject;struct aft_bbox box;uint32_t gate,age=0,status=PL_MODEL_STALE,i;
 if(r[1]!=0x42410808u)return;                  /* not the AF START send */
 if((k->reserved[1]&4u)&&(i=follow_mode())!=0){place_frame(s,k,i);return;}
 bump(&st()->s1_runs);
 gate=mode_gate();
 if(gate==GATE_OK&&!cas(&s->s1_busy,0,1))gate=GATE_BUSY;
 st()->hp_facts=st()->lv_switch;
 /* Not ours this time (v41: the record kept the previous half-press's box and "used" mark). */
 if(gate!=GATE_OK){bump(&st()->s1_skips);st()->s1_last_gate=gate;if(gate!=GATE_BUSY){st()->box_tick=0;s->want_id=0;st()->late_state=0;}return;}
 /* A new half-press withdraws the previous box before anything else. */
 s->box_seq++;barrier();s->box_id++;if(!s->box_id)s->box_id=1;s->box_tick=0;s->cue_id=0;s->box_seq++;barrier();
 st()->box_id=s->box_id;st()->box_tick=0;s->want_id=0;st()->late_state=0;st()->late_ticks=0;
 if(!newest_frame(s,&age))gate=GATE_NO_FRAME;
 st()->frame_age=age;st()->hp_direct=st()->lv_direct;
 if(gate==GATE_OK){
  zero(&result,sizeof(result));
  if(age<=PL_FRESH_TICKS)
  {uint32_t t0=cyc(),t1;struct subj_header h;
   status=(uint32_t)subj_check(k->model,k->model_bytes,&h);
   if(!status&&(h.in_w!=TW||h.in_h!=TH))status=SUBJ_BAD_MODEL;
   if(!status)status=(uint32_t)subj_run(s->work_rgb,k->model,k->model_bytes,s->net_work,sizeof(s->net_work),&result);
   t1=cyc();st()->t_model=t1-t0;}
  st()->model_last=status;
  if(status!=SUBJ_OK){
   /* no answer from the network: the middle 2x2 cells of its 12x8 grid, marked as cell 255 */
   result.x0_q16=5u*5461u;result.x1_q16=7u*5461u;result.y0_q16=3u*8192u;result.y1_q16=5u*8192u;
   result.best_score=0;result.second_score=0;result.best_index=255u;result.luma_variance=0;
  }
  {
   box.left=result.x0_q16;box.top=result.y0_q16;box.right=result.x1_q16;box.bottom=result.y1_q16;
   st()->box[0]=box.left;st()->box[1]=box.top;st()->box[2]=box.right;st()->box[3]=box.bottom;
   /* record: best and runner-up score (1/256 of a logit), chosen cell, luma variance */
   st()->score=result.best_score>>5;st()->presence=result.second_score>>5;st()->gated=result.best_index;st()->texture=result.luma_variance>255u?255u:result.luma_variance;
   if(aft_map_bbox(&s->work_view,&box,&subject)){
    s->box_seq++;barrier();copy(&s->box,&subject,sizeof(subject));s->box_tick=s->tick?s->tick:1u;s->box_seq++;barrier();
    for(i=0;i<4u;i++)st()->roi[i]=((const uint32_t*)&subject.face)[i];
    st()->box_tick=s->box_tick;bump(status==SUBJ_OK?&st()->model_ok:&st()->model_fail);
   }else{gate=GATE_MAP;bump(&st()->model_fail);}
  }
 }
 /* v46: thumbnails are now taken between half-presses too (direct canvas, see aft_lv_input), so this is
  * the exception: no thumbnail of the last 10 calls. The centre box (or none) stands; if a frame taken
  * after this half-press turns up, the box is recomputed once from it (late_compute). Stock AF keeps the
  * box it was offered first (v44), and waiting for that frame does not work: with every reader of the
  * category held back, no frame came in 150 ms (v46) - the frames follow the AF start. So no waiting. */
 if(gate==GATE_NO_FRAME||(gate==GATE_OK&&age>PL_FRESH_TICKS)){s->want_tick=s->tick;barrier();s->want_id=s->box_id;barrier();st()->late_state=LATE_WAITING;}
 st()->s1_last_gate=gate;if(gate!=GATE_OK)bump(&st()->s1_skips);
 barrier();s->s1_busy=0;barrier();
}
/* ---- stock AF asks for the selected face region: AF task ---------------- */
/* The half-press had no thumbnail of the last 10 calls: once the live-view task has published one taken
 * after it, the network runs on it here (about 34 M cycles, once per half-press) and the box is replaced.
 * Recorded as LATE_DONE_AFTER_OFFER: stock AF has usually taken the first box by then.
 * s1_busy keeps the half-press code and this computation apart; they share the work buffers. */
static uint32_t newer_frame(struct pl_state*s){
 uint32_t p=s->published,d;barrier();d=((p>>2)-s->want_tick)&0x3fffffffu;
 return p&&d&&d<=PL_WINDOW_TICKS?d:0;
}
static __attribute__((noinline)) void late_compute(struct pl_state*s,const struct s1_module_ctx*k,uint32_t id){
 struct subj_result result;struct subj_header h;struct aft_subject subject;struct aft_bbox box;
 uint32_t d,age=0,status,i,t0;
 if(s->want_id!=id)return;
 d=newer_frame(s);
 if(!d){
  if(s->tick-s->want_tick>PL_WINDOW_TICKS){s->want_id=0;barrier();st()->late_state=LATE_EXPIRED;}
  return;
 }
 if(!cas(&s->s1_busy,0,1))return;
 if(s->want_id==id&&s->box_id==id){
  s->want_id=0;barrier();
  status=LATE_FRAME;
  if(newest_frame(s,&age)&&age<=PL_FRAME_MAX_AGE){
   t0=cyc();zero(&result,sizeof(result));
   i=(uint32_t)subj_check(k->model,k->model_bytes,&h);
   if(!i&&(h.in_w!=TW||h.in_h!=TH))i=SUBJ_BAD_MODEL;
   if(!i)i=(uint32_t)subj_run(s->work_rgb,k->model,k->model_bytes,s->net_work,sizeof(s->net_work),&result);
   st()->t_model=cyc()-t0;
   status=LATE_NO_ANSWER;
   if(i==SUBJ_OK){
    box.left=result.x0_q16;box.top=result.y0_q16;box.right=result.x1_q16;box.bottom=result.y1_q16;
    status=LATE_MAP;
    if(aft_map_bbox(&s->work_view,&box,&subject)){
     s->box_seq++;barrier();copy(&s->box,&subject,sizeof(subject));s->box_tick=s->tick?s->tick:1u;s->box_seq++;barrier();
     st()->box[0]=box.left;st()->box[1]=box.top;st()->box[2]=box.right;st()->box[3]=box.bottom;
     st()->score=result.best_score>>5;st()->presence=result.second_score>>5;st()->gated=result.best_index;st()->texture=result.luma_variance>255u?255u:result.luma_variance;
     for(i=0;i<4u;i++)st()->roi[i]=((const uint32_t*)&subject.face)[i];
     st()->box_tick=s->box_tick;st()->model_last=SUBJ_OK;bump(&st()->model_ok);st()->late_ticks=d;
     status=LATE_DONE_AFTER_OFFER;
    }
   }
  }
  st()->late_state=status;
 }
 barrier();s->s1_busy=0;barrier();
}
static int box_now(struct pl_state*s,struct aft_subject*out,uint32_t*id){
 uint32_t tries,seq,tick;
 for(tries=0;tries<4u;tries++){
  seq=s->box_seq;barrier();if(seq&1u)continue;
  tick=s->box_tick;*id=s->box_id;copy(out,&s->box,sizeof(*out));barrier();
  if(s->box_seq!=seq)continue;
  return tick&&s->tick-tick<=PL_WINDOW_TICKS&&aft_rect_valid(&out->face);
 }
 return 0;
}
static uint32_t getter(struct pl_state*s,const struct s1_module_ctx*k,const uint32_t*r){
 uintptr_t out=r[1];uint32_t lr=r[13],id=0;struct aft_subject box;
 if((lr!=LR_CATEGORY&&lr!=LR_REGION&&lr!=LR_RECT)||r[2]||!span(out,60))return 0;   /* not ours: stock runs untouched */
 /* The stock answer always comes first; anything nonzero in it wins. */
 ((void(*)(uintptr_t,uintptr_t,uint32_t))(uintptr_t)k->reserved[0])(r[0],out,r[2]);
 if(lr==LR_CATEGORY)bump(&st()->cat_calls);
 /* faceFollow build in Follow mode: the face only decides where the tracking frame starts
  * (place_frame); stock AF keeps its ordinary tracking category instead of the face category. */
 if((k->reserved[1]&8u)&&follow_mode()==5u){s->latched=0;zero((void*)out,60);if(lr==LR_CATEGORY)bump(&st()->no_box);return 1;}
 if(nonzero((const void*)out,60)){s->latched=0;bump(&st()->native_wins);return 1;}
 if(lr==LR_CATEGORY){
  s->latched=0;
  if(mode_gate()!=GATE_OK){bump(&st()->no_box);return 1;}
  if(s->want_id)late_compute(s,k,s->want_id);
  if(!box_now(s,&box,&id)){bump(&st()->no_box);return 1;}
  copy(&s->latch,&box,sizeof(box));s->latch_id=id;s->latched=1;
  copy((void*)out,&box,60);bump(&st()->supplied_cat);return 1;
 }
 /* Region and rectangle reads follow the category decision of the same pass. */
 if(!s->latched)return 1;
 copy((void*)out,&s->latch,60);
 if(lr==LR_REGION){bump(&st()->supplied_region);st()->used_id=s->latch_id;s->cue_tick=s->tick;barrier();s->cue_id=s->latch_id;barrier();}
 else bump(&st()->supplied_rect);
 return 1;
}
/* ---- in-focus sound: UI task -------------------------------------------- */
static int wave_ok(uintptr_t p){return span(p,44)&&!(p&3u)&&r32(p,0)==0x46464952u&&r32(p,8)==0x45564157u;}
static uint32_t sound(struct pl_state*s,const struct s1_module_ctx*k,uint32_t*r){
 uint32_t id=s->cue_id;
 if(r[0]!=SOUND||r[13]!=LR_FOCUS_SOUND||r[1]!=r32(SOUND,12)||r[2]!=r32(SOUND,0x1c))return 0;
 bump(&st()->sound_calls);
 if(!(k->reserved[1]&2u)){st()->sound_last=1;return 0;}
 if(!id||id!=s->box_id||s->tick-s->cue_tick>PL_CUE_TICKS){st()->sound_last=2;return 0;}
 if(!wave_ok(r32(SOUND,4))||!r32(SOUND,0x14)){st()->sound_last=3;return 0;}
 s->cue_id=0;barrier();r[1]=r32(SOUND,4);r[2]=r32(SOUND,0x14);bump(&st()->sound_swaps);st()->sound_last=0;return 1;
}
/* ---- photo record -------------------------------------------------------- */
static void w16(uint8_t*p,uint32_t v){if(v>65535u)v=65535u;p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
static void w32(uint8_t*p,uint32_t v){w16(p,v&65535u);w16(p+2,v>>16);}
static uint32_t fnv(const uint8_t*p,uint32_t n){uint32_t h=2166136261u,i;for(i=0;i<n;i++)h=(h^p[i])*16777619u;return h;}
static int32_t clip16(int32_t v){return v>32767?32767:v<-32768?-32768:v;}
static uint32_t sat16(uint32_t v){return v>65535u?65535u:v;}
static void photo(const struct s1_module_ctx*k,uintptr_t owner,uint32_t op){
 uint8_t w[96];struct pl_static*d=st();struct pl_state*s;uint32_t i,flags=1u,capacity,since;uintptr_t maker;
 if(!span(owner,0x2a0)||r32(owner+0x124u,4)!=owner+0x134u){d->attach_last=0x100u;return;}
 maker=owner+0x124u;capacity=op==PL_OP_JPEG?0x7800u:r32(owner,0x29c);
 zero(w,sizeof(w));copy(w,"GRAFDIAG",8);w16(w+8,13);w16(w+10,96);
 if(k->reserved[1]&2u)flags|=2u;
 if(k->reserved[1]&4u)flags|=128u;                            /* AI start frame for Follow / Continuous is built in */
 if((k->reserved[1]&4u)&&follow_mode()&&(d->point_last==GR4_POINT_APPLIED||d->point_last==GR4_POINT_ALREADY_CURRENT||d->point_last==GR4_POINT_APPLIED_MIRROR_MISMATCH))flags|=256u;   /* ...and placed the frame for the latest half-press */
 if(k->reserved[1]&8u)flags|=512u;                            /* stock face detection kept on in Follow mode */
 if(state())flags|=4u;else if(d->state_word==2u)flags|=64u;
 if(d->box_tick)flags|=16u;                                  /* latest half-press produced a box */
 if(d->box_tick&&d->used_id==d->box_id)flags|=8u;            /* ...and stock AF read it as its region */
 if(op==PL_OP_DNG)flags|=32u;
 bump(&d->photo_seq);w32(w+12,flags);w16(w+16,d->photo_seq);w16(w+18,d->s1_runs);w16(w+20,d->s1_skips);
 w[22]=(uint8_t)d->s1_last_gate;w[23]=(uint8_t)d->model_last;w16(w+24,d->model_ok);w16(w+26,d->model_fail);
 w16(w+28,d->frames_ok);w16(w+30,d->frames_bad);w[32]=(uint8_t)d->last_bad_step;w[33]=(uint8_t)(d->frame_age>255u?255u:d->frame_age);
 w16(w+34,d->cat_calls);w16(w+36,d->supplied_cat);w16(w+38,d->supplied_region);w16(w+40,d->supplied_rect);w16(w+42,d->native_wins);w16(w+44,d->no_box);
 w16(w+46,d->sound_calls);w16(w+48,d->sound_swaps);w[50]=(uint8_t)d->sound_last;w[51]=(uint8_t)d->seen;
 /* schema 6: timing replaces the live-view facts (known since schema 4); schema 7: model time in 8192-cycle units;
  * schema 9: bytes 54/55 = facts of the last rejected recipe (recipe_facts; bits 6-7 of byte 55 as of the
  * latest half-press) instead of the benchmark time (v41 measured it: 6.1 cycles per multiply-accumulate);
  * schema 10: bytes 90/91 = late_box state and the ticks from the half-press to the frame it used, instead of
  * the thumbnail sampling time (v41/v43: 2.3 M cycles); schema 11: byte 91 = 2 ms waits (bits 0-5) and ticks (bits 6-7);
  * schema 12: byte 91 bits 0-5 in 4 ms; bytes 54..57 = task ids of the waiting task, of another reader that was kept
  * waiting, of the live-view task, and the number of such other reads (instead of recipe facts and frame interval);
  * schema 13: bytes 54/55 = recipe facts again; byte 56 bit 0 = the half-press used a direct-canvas thumbnail, bit 1 = the
  * newest thumbnail is one; byte 57 = direct-canvas thumbnails so far (stops at 255); byte 91 = ticks only */
 w16(w+52,sat16(d->t_model>>13));w[54]=(uint8_t)d->rej_facts;w[55]=(uint8_t)(((d->rej_facts>>8)&63u)|((d->hp_facts>>8)&192u));w[56]=(uint8_t)((d->hp_direct?1u:0u)|(d->lv_direct?2u:0u));w[57]=(uint8_t)(d->direct_ok>255u?255u:d->direct_ok);w[90]=(uint8_t)d->late_state;w[91]=(uint8_t)(d->late_ticks>255u?255u:d->late_ticks);
 if(natives_ready()){w[58]=(uint8_t)((r8(U,0xf4)&3u)|((r8(U,0xc38)&3u)<<2)|((r8(U,0xf6)&3u)<<4)|((r8(U,0xc3a)&3u)<<6));w[59]=r8(U,0xc1d);}else w[59]=255;
 for(i=0;i<4u;i++){w16(w+60+2*i,d->box[i]>65535u?65535u:d->box[i]);w16(w+68+2*i,d->roi[i]>>12);}
 if((flags&128u)&&(w[59]==5u||w[59]==6u)){w16(w+68,d->point_x);w16(w+70,d->point_y);w16(w+72,d->point_last);w16(w+74,d->point_runs);}   /* Follow / Continuous: the placed frame instead of a region */
 w16(w+76,(uint32_t)clip16(d->score)&65535u);w16(w+78,(uint32_t)clip16(d->presence)&65535u);w[80]=(uint8_t)d->gated;w[81]=(uint8_t)d->texture;
 since=d->box_tick?d->now_tick-d->box_tick:65535u;w16(w+82,since);w16(w+84,d->box_id&65535u);w16(w+86,d->used_id&65535u);w16(w+88,d->attach_last);
 w32(w+92,fnv(w,92));
 d->attach_last=aft19_diag_append96(maker,capacity,w);
 /* Second entry (tag 0xc7a2, schema 8): a 10x8 luminance miniature of the 96x64 thumbnail the
  * latest box was computed from, so geometry can be checked against the photo. */
 if(d->box_tick&&(s=state())!=0){
  uint32_t bx,by,x,y,sum;
  zero(w,sizeof(w));copy(w,"GRAFDIAG",8);w16(w+8,8);w16(w+10,96);w16(w+12,d->box_id&65535u);w16(w+14,d->photo_seq);
  for(by=0;by<8u;by++)for(bx=0;bx<10u;bx++){
   uint32_t xa=bx*TW/10u,xb=(bx+1u)*TW/10u;sum=0;
   for(y=by*8u;y<by*8u+8u;y++)for(x=xa;x<xb;x++){const uint8_t*p=s->work_rgb+3u*(y*TW+x);sum+=(77u*p[0]+150u*p[1]+29u*p[2])>>8;}
   w[16+by*10u+bx]=(uint8_t)(sum/(8u*(xb-xa)));
  }
  (void)aft19_diag_append96_tag(maker,capacity,w,0xc7a2u);
 }
}
uint32_t af_s1_dispatch(uint32_t op,uintptr_t a,uintptr_t b,const struct s1_module_ctx*k){
 struct pl_state*s;uint32_t*r=(uint32_t*)a;(void)b;
 if(!ctx_ok(k))return 0;
 /* The adapter calls this only for our own MakerNote tag and then skips the stock data
  * setter, which would otherwise zero the 96-byte payload. */
 if(op==PL_OP_SET_PRIVATE){st()->seen|=128u;return 1;}
 if(op==PL_OP_JPEG||op==PL_OP_DNG){st()->seen|=op==PL_OP_JPEG?16u:32u;photo(k,a,op);return 0;}
 if(!span(a,56))return 0;
 switch(op){
 case PL_OP_COLLECT:st()->seen|=2u;if(r[2]&&natives_ready()&&(s=state_or_create())!=0)collect(s,r[0],r[4]);return 0;
 case PL_OP_RUN:st()->seen|=1u;if((s=state_or_create())!=0)half_press(s,k,r);return 0;
 case PL_OP_GETTER:st()->seen|=4u;return (s=state())!=0?getter(s,k,r):0;
 /* End of a stock AF pass: region/rectangle reads outside a pass get the stock answer again. */
 case PL_OP_AF_END:st()->seen|=64u;if(r[5]==CAF&&(s=state())!=0)s->latched=0;return 0;
 case PL_OP_SOUND:st()->seen|=8u;return (s=state())!=0?sound(s,k,r):0;
 default:return 0;
 }
}
