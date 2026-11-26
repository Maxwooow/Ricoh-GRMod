/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef GR4_120_STOCK_TIER_LV_H
#define GR4_120_STOCK_TIER_LV_H
#include "s1_model.h"
#include "tier_geometry.h"
struct aft_cache_plan {uint32_t y_address,y_bytes,uv_address,uv_bytes,allocation_begin,allocation_end;};
/* C=the still-held recipe at5366bc80; process=its LiveViewProcess owner.
 * All object pointers must be native live objects, not arbitrary input. Caller
 * provides Info+64 through aft_lv_visible in this same LV task, with current
 * limit raw fields. AF later compares the locked Common prefix independently.
 * Same-task handoff sampling and owned-snapshot publication remain caller work.
 * q/g/plan are disjoint from all source objects/pixels and one another. No write
 * before success. Do not use the old full720480 cache planner on this ROI. */
static inline uint32_t aft_rd8(uintptr_t p,uint32_t o){return *(const volatile uint8_t*)(p+o);}
static inline uint32_t aft_rd16(uintptr_t p,uint32_t o){return aft_rd8(p,o)|(aft_rd8(p,o+1u)<<8);}
static inline uint32_t aft_rd32(uintptr_t p,uint32_t o){return aft_rd16(p,o)|(aft_rd16(p,o+2u)<<16);}
/* Eight persistent recipes are created5366c9bc and destroyed5366c6d0.
 * Normal5366caf0 recycling releases slots/list nodes, not these objects.
 * Caller keeps the LiveViewProcess alive and excludes concurrent stop/free. */
static inline uint32_t aft_lv_recipe_live(uintptr_t process,uintptr_t c){
 uintptr_t pool;uint32_t i;
 if(!process||!c||((process|c)&3u))return 0;
 pool=aft_rd32(process,0x3b0);if(!pool||(pool&3u))return 0;
 for(i=0;i<8u;i++)if(aft_rd32(pool,8u+4u*i)==c)return 1;
 return 0;
}
/* Same LV task only: original538af658 chooses this16B virtual window;
 * original538af6e4 publishes the same bytes toCommon+6c0. No Common lock. */
static inline uint32_t aft_lv_visible(uintptr_t process,struct aft_rect*out){
 uintptr_t info;uint32_t i;struct aft_rect r;
 if(!process||!out||(process&3u))return 0;
 info=aft_rd32(process,0x3a0);if(!info||(info&3u))return 0;
 for(i=0;i<4u;i++)((uint32_t*)&r)[i]=aft_rd32(info,0x64+4u*i);
 if(!aft_rect_valid(&r))return 0;
 for(i=0;i<4u;i++)((volatile uint32_t*)out)[i]=((const uint32_t*)&r)[i];
 return 1;
}
/* Field facts gathered from the live recipe for the photo diagnostic (schema 3).
 * soft bits: 1 recipe state!=2, 2 c+bbd!=1, 4 manager slot table disagrees,
 * 8 visible window/crop differs from the profile-7 replay table. */
struct aft_lv_facts {uint32_t profile,format,state,soft,active_width,active_height,canvas_width,canvas_height,y_address;};
static inline void aft_lv_read_facts(uintptr_t c,uintptr_t process,struct aft_lv_facts*f){
 uintptr_t m=aft_rd32(c,0x330),b=aft_rd32(c,0x334);uint32_t slot=aft_rd32(c,0x31c),i;struct aft_rect expected;
 f->profile=(b&&!(b&3u))?aft_rd8(b,0xa):255u;f->format=aft_rd8(c,0xa08);f->state=aft_rd8(c,4);
 f->active_width=aft_rd16(c,0xa18);f->active_height=aft_rd16(c,0xa1a);f->canvas_width=aft_rd16(c,0xa1c);f->canvas_height=aft_rd16(c,0xa1e);
 f->y_address=aft_rd32(c,0xa0c);f->soft=(f->state!=2u?1u:0u)|(aft_rd8(c,0xbbd)!=1u?2u:0u);
 if(!m||(m&3u)||slot>=4u||aft_rd32(m,0xf4+4u*slot)!=aft_rd32(c,0x2e8)||aft_rd8(m,0x114+slot)!=0u||
    aft_rd16(m,0x214)!=f->canvas_width||aft_rd16(m,0x216)!=f->canvas_height)f->soft|=4u;
 if(aft_rd32(c,0xbf0)!=aft_rd32(process,0x94)||!aft_expected_visible(aft_rd8(process,0x8d),aft_rd32(c,0xbf0),&expected))f->soft|=8u;
 else{uintptr_t info=aft_rd32(process,0x3a0);if(!info||(info&3u))f->soft|=8u;else for(i=0;i<4u;i++)if(aft_rd32(info,0x64+4u*i)!=((const uint32_t*)&expected)[i])f->soft|=8u;}
}
/* 2026-11-10 real-camera finding (14 photos of a camera test build): live view runs
 * profile 3, not the profile 7 this code was replayed with, so the old exact
 * 720x480 table rejected every frame. The recipe's own AHIP descriptor
 * (c+a08..a22: format, Y/UV plane pointers, active WxH, canvas WxH, origin) is
 * what the native display path consumes; it is now the only source for the
 * sampler. Hard checks are limited to what the sampler needs to read safely:
 * NV12, even in-canvas geometry, plausible plane pointers. Everything else is
 * recorded as a soft bit and no longer rejects. *why receives the failing step. */
static inline uint32_t aft_lv_input(uint32_t enabled,uintptr_t c,uintptr_t process,
 uint32_t nonce,const struct aft_rect*common,uint32_t limiter,uint32_t afrange,
 struct s1_request*q,struct aft_geometry*g,struct aft_cache_plan*plan,uint32_t*why){
 uint32_t aw,ah,w,h,x,y,py,pu,ys,us,ye,ue,yb,ub,i,step=0,direct=0;uintptr_t b;
 struct aft_geometry t={0};struct aft_cache_plan p;
 do{
  step=1;if(enabled!=1u||!nonce||!common||!q||!g||!plan||!aft_rect_valid(common)||!aft_lv_recipe_live(process,c))break;
  step=2;if(aft_rd8(process,0x91)!=0u||aft_rd8(process,0x8c)!=0u||aft_rd8(c,0xbd4)!=0u)break;
  step=3;b=aft_rd32(c,0x334);if(!b||(b&3u))break;
  t.profile=aft_rd8(b,0xa);t.crop_q13=aft_rd32(c,0xbf0);t.lv_aspect=aft_rd8(process,0x8d);
  step=4;if(t.profile!=3u&&t.profile!=5u&&t.profile!=7u)break;
  if(aft_rd8(c,0xa08)==2u){
   w=aft_rd16(c,0xa18);h=aft_rd16(c,0xa1a);aw=aft_rd16(c,0xa1c);ah=aft_rd16(c,0xa1e);x=aft_rd16(c,0xa20);y=aft_rd16(c,0xa22);
   py=aft_rd32(c,0xa0c);pu=aft_rd32(c,0xa10);
  }else{
   /* v46/v47: between half-presses stock live view runs "direct" recipes (c+bbd=1): the display canvas is
    * written straight into the recipe's slot and no descriptor is filled (c+a08 stays 1).  The stock
    * display hand-over 5366bc80 itself shows such a recipe from c+2e8 + c+bdc with the manager's canvas
    * (m+214 x m+216, 1920x1088 on the camera; second plane right after it, the same layout 5366aa40
    * gives the descriptor path).  5366be20 has put the profile's nominal picture size into c+bea/bec
    * (538b3818/538b3960: 1152x480 for profile 3 - NOT the canvas, which is what v46 compared it with
    * and why every idle frame was refused on the camera), the active size into c+bd6/bd8 and its
    * centred origin inside the nominal picture into c+be0/be2.  c+bdc is only rewritten when the
    * origin is not a multiple of 8, so it may be a left-over 0..7; stock shows from base+bdc regardless. */
   uintptr_t m=aft_rd32(c,0x330);uint32_t base=aft_rd32(c,0x2e8),off=aft_rd32(c,0xbdc),nw,nh;
   step=5;if(aft_rd8(c,0xbbd)!=1u||!m||(m&3u)||!base||off>7u)break;
   w=aft_rd16(c,0xbd6);h=aft_rd16(c,0xbd8);aw=aft_rd16(m,0x214);ah=aft_rd16(m,0x216);x=aft_rd16(c,0xbe0);y=aft_rd16(c,0xbe2);
   nw=aft_rd16(c,0xbea);nh=aft_rd16(c,0xbec);
   step=10;if(!nw||!nh||nw>aw||nh>ah||w>nw||h>nh||x!=((nw-w)>>1)||y!=((nh-h)>>1)||base>0xf8000000u)break;
   py=base+off;pu=py+aw*ah;direct=1;
  }
  step=6;if(w<180u||h<140u||aw<w||ah<h||aw>4096u||ah>4096u||((aw|ah|w|h|x|y)&1u)||x>aw-w||y>ah-h)break;
  step=7;if(py<0x40000000u||pu<0x40000000u||py>0xf8000000u||pu>0xf8000000u||(py>=0x53000000u&&py<0x5a600000u)||(pu>=0x53000000u&&pu<0x5a600000u))break;
  step=8;if(pu<py||pu-py<aw*h)break;
  py+=y*aw+x;pu+=(y/2u)*aw+x;ys=(h-1u)*aw+w;us=(h/2u-1u)*aw+w;
  yb=py&~63u;ub=pu&~63u;ye=(py+ys+63u)&~63u;ue=(pu+us+63u)&~63u;
  step=9;if(ye<=yb||ue<=ub)break;
  t.nonce=nonce;t.visible=*common;t.active_width=w;t.active_height=h;t.origin_x=x;t.origin_y=y;t.canvas_width=aw;t.canvas_height=ah;
  t.limiter_raw=limiter;t.af_range_raw=afrange;t.pd_coverage=UINT32_MAX;t.signature=aft_geometry_signature(&t);
  p=(struct aft_cache_plan){yb,ye-yb,ub,ue-ub,yb,ue};
  q->format=S1_NV12_FULL;q->frame_flags=S1_FRAME_PROVEN;q->pixels=(const uint8_t*)(uintptr_t)py;q->pixel_bytes=ys;
  q->width=w;q->height=h;q->stride=aw;q->uv=(const uint8_t*)(uintptr_t)pu;q->uv_bytes=us;q->uv_stride=aw;
  for(i=0;i<sizeof(t)/4u;i++)((volatile uint32_t*)g)[i]=((const uint32_t*)&t)[i];
  for(i=0;i<sizeof(p)/4u;i++)((volatile uint32_t*)plan)[i]=((const uint32_t*)&p)[i];
  if(why)*why=0;return 1u+direct;   /* 1 descriptor, 2 direct canvas */
 }while(0);
 if(why)*why=step;return 0;
}
/* Caller proves recipe/process liveness and supplies a current Common visible
 * rectangle obtained with its native lock. No saved pixel pointer is touched.
 * Read-only token revalidation, not a substitute for caller synchronization. */
static inline uint32_t aft_lv_current_matches(const struct aft_geometry*saved,
 uintptr_t c,uintptr_t process,const struct aft_rect*common,uint32_t limiter,uint32_t afrange){
 struct aft_geometry t;uintptr_t m,b,info;uint32_t i;
 if(!saved||!common||!saved->nonce||limiter>2u||afrange>2u||
    !aft_lv_recipe_live(process,c)||aft_rd8(process,0x91)!=0u||aft_rd8(process,0x8c)!=0u||aft_rd8(c,0xbd4)!=0u)return 0;
 m=aft_rd32(c,0x330);b=aft_rd32(c,0x334);info=aft_rd32(process,0x3a0);
 if(!m||!b||!info||((m|b|info)&3u)||aft_rd32(process,0x3a8)!=m||aft_rd8(c,0xa08)!=2u||aft_rd8(c,0xbee)!=0u)return 0;
 t.nonce=saved->nonce;t.crop_q13=aft_rd32(c,0xbf0);t.lv_aspect=aft_rd8(process,0x8d);t.profile=aft_rd8(b,0xa);
 if((t.profile!=3u&&t.profile!=5u&&t.profile!=7u)||t.crop_q13!=aft_rd32(process,0x94)||!aft_expected_visible(t.lv_aspect,t.crop_q13,&t.visible))return 0;
 for(i=0;i<4u;i++)if(((const uint32_t*)common)[i]!=((const uint32_t*)&t.visible)[i]||aft_rd32(info,0x64+4u*i)!=((const uint32_t*)common)[i])return 0;
 t.active_width=aft_rd16(c,0xa18);t.active_height=aft_rd16(c,0xa1a);t.origin_x=aft_rd16(c,0xa20);t.origin_y=aft_rd16(c,0xa22);
 t.canvas_width=aft_rd16(c,0xa1c);t.canvas_height=aft_rd16(c,0xa1e);t.limiter_raw=limiter;t.af_range_raw=afrange;t.pd_coverage=UINT32_MAX;
 if(t.active_width!=aft_rd16(c,0xbd6)||t.active_height!=aft_rd16(c,0xbd8)||t.origin_x!=aft_rd16(c,0xbe0)||t.origin_y!=aft_rd16(c,0xbe2)||
    t.canvas_width!=aft_rd16(m,0x214)||t.canvas_height!=aft_rd16(m,0x216)||
    aft_rd32(c,0xbdc)!=((8u-(t.origin_x&7u))&7u))return 0;
 t.signature=aft_geometry_signature(&t);return aft_same_view(saved,&t);
}
#endif
