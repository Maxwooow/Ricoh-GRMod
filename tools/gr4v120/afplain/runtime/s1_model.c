/* SPDX-License-Identifier: GPL-2.0-only */
#include "s1_model.h"
#include <stddef.h>
#define MAGIC 0x53314d31u
#define MININT (-2147483647-1)
/* The tree model (s1_run and what only it uses) was replaced by subject_net.c on 2026-11-11.
 * It is kept for reference behind S1_TREE_MODEL and is not built into the camera module. */
#ifdef S1_TREE_MODEL
static uint32_t rd(const uint8_t *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
#endif
static int span(const void *p,uint32_t n){uintptr_t a=(uintptr_t)p;return a && n && a<=(uintptr_t)-1-(n-1);}
static int overlap(const void *a,uint32_t an,const void *b,uint32_t bn){uintptr_t x=(uintptr_t)a,y=(uintptr_t)b;return x<=y?y-x<an:x-y<bn;}
#ifdef S1_TREE_MODEL
static int32_t abs32(int32_t x){return x<0?-x:x;}
#endif
static int frame_ok(const struct s1_request *q){
 uint64_t need;uint32_t row;
 if(q->frame_flags!=S1_FRAME_PROVEN || q->width<9 || q->width>4096 || q->height<7 || q->height>4096 || q->stride>65536)return 0;
 if(q->format==S1_RGB888)row=q->width*3;
 else if(q->format==S1_NV12_FULL){
  uint64_t uvneed=(uint64_t)((q->height+1)/2-1)*q->uv_stride+((q->width+1)&~1u);
  row=q->width;
  if((q->stride&1) || q->uv_stride!=q->stride || q->uv_stride<((q->width+1)&~1u) || q->uv_bytes>0x2000000u || uvneed>q->uv_bytes || !span(q->uv,q->uv_bytes))return 0;
 }else if(q->format==S1_UYVY_FULL)row=((q->width+1)&~1u)*2;
 else return 0;
 if(q->stride<row)return 0;
 need=(uint64_t)(q->height-1)*q->stride+row;
 return q->pixel_bytes<=0x4000000u && need<=q->pixel_bytes && span(q->pixels,q->pixel_bytes);
}
#ifdef S1_TREE_MODEL
static int storage_ok(const struct s1_request *q,struct s1_workspace *w,void *out,uint32_t on){
 if(!span(q,sizeof(*q)) || !span(w,sizeof(*w)) || !span(out,on) || !frame_ok(q))return 0;
 if(overlap(w,sizeof(*w),q,sizeof(*q)) || overlap(out,on,q,sizeof(*q)) || overlap(w,sizeof(*w),out,on) || overlap(w,sizeof(*w),q->pixels,q->pixel_bytes) || overlap(out,on,q->pixels,q->pixel_bytes))return 0;
 if(q->format==S1_NV12_FULL && (overlap(w,sizeof(*w),q->uv,q->uv_bytes) || overlap(out,on,q->uv,q->uv_bytes)))return 0;
 return 1;
}
static int model_ok(const uint8_t *m,uint32_t n){
 uint32_t t,k,nodes,h=2166136261u,i;
 if(n<32 || n>32784 || !span(m,n) || rd(m)!=MAGIC || rd(m+4)!=1 || rd(m+8)!=29 || rd(m+12)!=(9u|(7u<<16)))return 0;
 t=rd(m+16);nodes=rd(m+20);if(!t || t>128 || !nodes || nodes>15*t || n!=32+4*t+16*nodes || (int32_t)rd(m+24)<-131072 || (int32_t)rd(m+24)>131072)return 0;
 for(i=0;i<n;i++)h=(h^(i>=28 && i<32?0:m[i]))*16777619u;
 if(h!=rd(m+28))return 0;
 for(i=0;i<t;i++)if(rd(m+32+4*i)>=nodes)return 0;
 for(i=0;i<nodes;i++){
  const uint8_t *p=m+32+4*t+16*i;int32_t f=(int32_t)rd(p),v=(int32_t)rd(p+8);uint32_t l=rd(p+8),r=rd(p+12);
  if(f==-1){if(rd(p+4) || r || v<-131072 || v>131072)return 0;}
  else {if(f<0 || f>=29 || l<=i || r<=i || l>=nodes || r>=nodes)return 0;}
 }
 k=nodes;return k!=0;
}
#endif
/* Full-range stock matrix,integer approximation. Exhaustive f32-formula
 * comparison has0LSB error forR/B and at most1LSB forG; no FPU state is used. */
static uint32_t sat1000(int32_t x){return x<=0?0:x>=255000?255u:(uint32_t)x/1000;}
static void pixel(const struct s1_request *q,uint32_t x,uint32_t y,uint32_t *rgb){
 const uint8_t *p=q->pixels+y*q->stride;int32_t yy,u,v;
 if(q->format==S1_RGB888){p+=3*x;rgb[0]=p[0];rgb[1]=p[1];rgb[2]=p[2];return;}
 if(q->format==S1_NV12_FULL){const uint8_t *c=q->uv+(y>>1)*q->uv_stride+(x&~1u);yy=p[x];u=(int32_t)c[0]-128;v=(int32_t)c[1]-128;}
 else {p+=2*(x&~1u);yy=p[1+2*(x&1)];u=(int32_t)p[0]-128;v=(int32_t)p[2]-128;}
 rgb[0]=sat1000(1000*yy+1402*v);rgb[1]=sat1000(1000*yy-344*u-714*v);rgb[2]=sat1000(1000*yy+1772*u);
}
#ifdef S1_TREE_MODEL
int s1_sample_rgb(const struct s1_request *q,uint8_t *out,uint32_t capacity){
 uint32_t x,y,rgb[3];
 if(!span(q,sizeof(*q)) || capacity<18900 || !span(out,18900))return S1_BAD_ARGUMENT;
 if(!frame_ok(q))return S1_BAD_FRAME;
 if(q->max_samples<6300)return S1_BUDGET;
 if(overlap(out,18900,q,sizeof(*q)) || overlap(out,18900,q->pixels,q->pixel_bytes) || (q->format==S1_NV12_FULL && overlap(out,18900,q->uv,q->uv_bytes)))return S1_BAD_ARGUMENT;
 for(y=0;y<70;y++)for(x=0;x<90;x++){
  uint32_t i=3*(y*90+x);pixel(q,((2*x+1)*q->width)/180,((2*y+1)*q->height)/140,rgb);out[i]=(uint8_t)rgb[0];out[i+1]=(uint8_t)rgb[1];out[i+2]=(uint8_t)rgb[2];
 }
 return S1_APPLY;
}
#endif
/* Thumbnail for the subject network: w x h RGB888 over the whole frame, each pixel the mean of a
 * 2x2 lattice of source samples.  tab is caller scratch of 2*(w+h) entries. */
int s1_sample_thumb(const struct s1_request *q,uint8_t *out,uint32_t w,uint32_t h,uint16_t *tab){
 uint32_t x,y,i,n=3*w*h,rgb[3],a[3];
 if(!span(q,sizeof(*q)) || !w || !h || w>256 || h>256 || !span(out,n) || !span(tab,4*(w+h)))return S1_BAD_ARGUMENT;
 if(!frame_ok(q))return S1_BAD_FRAME;
 if(overlap(out,n,q,sizeof(*q)) || overlap(out,n,q->pixels,q->pixel_bytes) || (q->format==S1_NV12_FULL && overlap(out,n,q->uv,q->uv_bytes)))return S1_BAD_ARGUMENT;
 for(i=0;i<2*w;i++)tab[i]=(uint16_t)(((2*i+1)*q->width)/(4*w));
 for(i=0;i<2*h;i++)tab[2*w+i]=(uint16_t)(((2*i+1)*q->height)/(4*h));
 for(y=0;y<h;y++)for(x=0;x<w;x++){
  a[0]=a[1]=a[2]=2;
  for(i=0;i<4;i++){pixel(q,tab[2*x+(i&1)],tab[2*w+2*y+(i>>1)],rgb);a[0]+=rgb[0];a[1]+=rgb[1];a[2]+=rgb[2];}
  *out++=(uint8_t)(a[0]>>2);*out++=(uint8_t)(a[1]>>2);*out++=(uint8_t)(a[2]>>2);
 }
 return S1_APPLY;
}
#ifdef S1_TREE_MODEL
static void sample(const struct s1_request *q,struct s1_workspace *w,int32_t *g){
 uint32_t x,y,c,sr=0,sg=0,sb=0,sy=0,sy2=0;
 for(x=0;x<90;x++)w->sample_x[x]=(uint16_t)(((2*x+1)*q->width)/180);
 for(y=0;y<70;y++)w->sample_y[y]=(uint16_t)(((2*y+1)*q->height)/140);
 for(c=0;c<63;c++){
  uint32_t r=c/9,col=c-r*9,a=0,b=0,d=0,e=0,e2=0;
  for(y=r*10;y<r*10+10;y++)for(x=col*10;x<col*10+10;x++){
   uint32_t rgb[3],yy;pixel(q,w->sample_x[x],w->sample_y[y],rgb);yy=(77u*rgb[0]+150u*rgb[1]+29u*rgb[2])>>8;
   a+=rgb[0];b+=rgb[1];d+=rgb[2];e+=yy;e2+=yy*yy;
  }
  sr+=a;sg+=b;sb+=d;sy+=e;sy2+=e2;
  w->cells[c][0]=(int32_t)(a/100);w->cells[c][1]=(int32_t)(b/100);w->cells[c][2]=(int32_t)(d/100);w->cells[c][3]=(int32_t)(e/100);w->cells[c][4]=(int32_t)(e2/100)-w->cells[c][3]*w->cells[c][3];
 }
 g[0]=(int32_t)(sr/6300);g[1]=(int32_t)(sg/6300);g[2]=(int32_t)(sb/6300);g[3]=(int32_t)(sy/6300);g[4]=(int32_t)(sy2/6300)-g[3]*g[3];
}
static void feature(const struct s1_workspace *w,const int32_t *g,uint32_t i,int32_t *f){
 uint32_t row=i/9,col=i-row*9,k;const int32_t *t=w->cells[i];int32_t lo=t[0],hi=t[0],dx=(int32_t)col-4,dy=(int32_t)row-3;
 for(k=0;k<5;k++)f[k]=t[k];f[5]=256;
 for(k=1;k<3;k++){if(t[k]<lo)lo=t[k];if(t[k]>hi)hi=t[k];}
 f[6]=t[0]-t[1];f[7]=t[2]-t[1];f[8]=hi-lo;
 for(k=0;k<3;k++)f[9+k]=t[k]-g[k];f[12]=t[3]-g[3];
 f[13]=t[3]-w->cells[row?i-9:i][3];f[14]=t[3]-w->cells[row<6?i+9:i][3];f[15]=t[3]-w->cells[col?i-1:i][3];f[16]=t[3]-w->cells[col<8?i+1:i][3];
 for(k=0;k<4;k++)f[17+k]=abs32(f[13+k]);
 for(k=0;k<4;k++)f[21+k]=g[k];f[25]=g[4];f[26]=(int32_t)(col*256/8);f[27]=(int32_t)(row*256/6);f[28]=(dx*dx+dy*dy)*8/25;
}
static uint32_t distance(uint32_t i,uint32_t current){int32_t dx=(int32_t)(i%9)-(int32_t)(current%9),dy=(int32_t)(i/9)-(int32_t)(current/9);return (uint32_t)(dx*dx*49+dy*dy*81);}
static void finish(struct s1_result *o,uint32_t status,uint32_t index,int32_t best,int32_t current,int32_t second,uint32_t steps,uint32_t variance){
 uint32_t x=index%9,y=index/9;
 o->status=status;o->index=index;o->x_q16=(2*x+1)*65536/18;o->y_q16=(2*y+1)*65536/14;o->ui_x=(2*x+1)*720/18;o->ui_y=(2*y+1)*480/14;o->score_q12=best;o->current_score_q12=current;o->runner_gap_q12=second==MININT?0:best-second;o->samples=6300;o->tree_steps=steps;o->global_variance=variance;
}
int s1_debug_features(const struct s1_request *q,struct s1_workspace *w,int32_t *out){
 int32_t g[5];uint32_t i;
 if(!q || !storage_ok(q,w,out,63*29*4))return S1_BAD_ARGUMENT;
 sample(q,w,g);for(i=0;i<63;i++)feature(w,g,i,out+29*i);return S1_APPLY;
}
int s1_run(const struct s1_request *q,struct s1_workspace *w,struct s1_result *out){
 uint32_t t,i,j,steps=0,current,besti=0,bestdist=0,trees;int32_t g[5],f[29],best=MININT,second=MININT,cur=MININT;
 if(!span(q,sizeof(*q)))return S1_BAD_ARGUMENT;if(q->enable!=1)return S1_OFF;
 if(!frame_ok(q))return S1_BAD_FRAME;
 if(!storage_ok(q,w,out,sizeof(*out)))return S1_BAD_ARGUMENT;
 if(q->current_x_q16>65535 || q->current_y_q16>65535 || q->min_score_q12<0 || q->min_score_q12>4096 || q->min_gain_q12<0 || q->min_gain_q12>8192 || q->min_global_variance>65025)return S1_BAD_ARGUMENT;
 if(!model_ok(q->model,q->model_bytes))return S1_BAD_MODEL;
 if(overlap(q->model,q->model_bytes,w,sizeof(*w)) || overlap(q->model,q->model_bytes,out,sizeof(*out)))return S1_BAD_ARGUMENT;
 trees=rd(q->model+16);if(q->max_samples<6300 || q->max_tree_steps<63*trees*4)return S1_BUDGET;
 current=((q->current_y_q16*7)>>16)*9+((q->current_x_q16*9)>>16);
 sample(q,w,g);if((uint32_t)g[4]<q->min_global_variance){finish(out,S1_BLANK,current,MININT,MININT,MININT,0,(uint32_t)g[4]);return S1_BLANK;}
 for(i=0;i<63;i++){
  int32_t score=(int32_t)rd(q->model+24);uint32_t dist=distance(i,current);feature(w,g,i,f);
  for(t=0;t<trees;t++){
   uint32_t node=rd(q->model+32+4*t);
   for(j=0;j<4;j++){
    const uint8_t *p=q->model+32+4*trees+16*node;int32_t fi=(int32_t)rd(p);steps++;
    if(fi==-1){score+=(int32_t)rd(p+8);break;}
    node=rd(p+(f[(uint32_t)fi]<=(int32_t)rd(p+4)?8:12));
   }
   if(j==4)return S1_BAD_MODEL;
  }
  if(i==current)cur=score;
  if(score>best || (score==best && dist<bestdist)){second=best;best=score;besti=i;bestdist=dist;}else if(score>second)second=score;
 }
 i=besti==current?S1_NO_CHANGE:(best<q->min_score_q12 || best-cur<q->min_gain_q12?S1_LOW_CONFIDENCE:S1_APPLY);
 finish(out,i,besti,best,cur,second,steps,(uint32_t)g[4]);return (int)i;
}
#endif
