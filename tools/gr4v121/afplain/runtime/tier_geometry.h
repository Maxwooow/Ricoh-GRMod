/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef GR4_120_TIER_GEOMETRY_H
#define GR4_120_TIER_GEOMETRY_H
#include <stdint.h>
#include <stddef.h>
#define AFT_GEOMETRY_VERSION 1u
/* Standard GR IV1.20 and the two whitelisted v120 baselines only; added
 * baseline IDs7/8 are65:24(actual30:11)/2.39:1(actual12:5).
 * These functions compute geometry; they do
 * not publish CommonState, call a UI point setter, or change lens search limits.
 * Caller supplies an immutable owned snapshot and disjoint output storage. */
struct aft_rect { uint32_t width,height,x,y; };
struct aft_bbox { uint32_t left,top,right,bottom; }; /* half-open Q16,0..65536 */
struct aft_geometry {
 uint32_t nonce,signature,crop_q13,lv_aspect,profile;
 struct aft_rect visible; /* original CommonState+6c0, Q12 global720x480 */
 uint32_t active_width,active_height,origin_x,origin_y,canvas_width,canvas_height;
 uint32_t limiter_raw,af_range_raw,pd_coverage; /* pd_coverageFFFFFFFF=unknown */
};
struct aft_subject { struct aft_rect face,eye_kind2,eye_kind1;uint32_t opaque[3]; };
enum { AFT_GEOMETRY_OK=1,AFT_GEOMETRY_INVALID=0 };
static inline int aft_rect_valid(const struct aft_rect*r){
 return r->width&&r->height&&r->x<=UINT32_MAX-r->width&&r->y<=UINT32_MAX-r->height;
}
static inline uint32_t aft_geometry_signature(const struct aft_geometry*g){
 const uint32_t *p=&g->crop_q13;uint32_t h=2166136261u,i,j;
 for(i=0;i<sizeof(*g)/4u-2u;i++)for(j=0;j<4u;j++)h=(h^((p[i]>>(8u*j))&255u))*16777619u;
 return h;
}
static inline uint32_t aft_same_view(const struct aft_geometry*a,const struct aft_geometry*b){
 const uint32_t*x,*y;uint32_t i;
 if(!a||!b||!a->nonce||a->nonce!=b->nonce||
    a->signature!=aft_geometry_signature(a)||b->signature!=aft_geometry_signature(b))return 0;
 x=&a->crop_q13;y=&b->crop_q13;
 for(i=0;i<sizeof(*a)/4u-2u;i++)if(x[i]!=y[i])return 0;
 return 1;
}
/* Exact original538aefc8 window+24 results with the native720x480Q12 base.
 * All24 entries (18 exposed baseline-menu combinations plus hidden4/5) are independently replayed, including original VFP rounding.
 * Keep separate from window+34, which differs for square aspect. */
static inline uint32_t aft_expected_visible(uint32_t aspect,uint32_t crop,struct aft_rect*out){
 static const uint32_t words[24][4]={
  {2949120u,1966080u,0u,0u},
  {2359296u,1572864u,294912u,196608u},
  {1651459u,1100973u,648831u,432554u},
  {2949120u,1658880u,0u,153600u},
  {2359296u,1327104u,294912u,319488u},
  {1651459u,928946u,648831u,518567u},
  {2621440u,1966080u,163840u,0u},
  {2097152u,1572864u,425984u,196608u},
  {1467963u,1100973u,740579u,432554u},
  {1966080u,1966080u,491520u,0u},
  {1572864u,1572864u,688128u,196608u},
  {1100973u,1100973u,924074u,432554u},
  {2457600u,1966080u,245760u,0u},
  {1966080u,1572864u,491520u,196608u},
  {1376215u,1100973u,786453u,432554u},
  {2949120u,1254945u,0u,355568u},
  {2359296u,1003956u,294912u,481062u},
  {1651459u,702748u,648831u,631666u},
  {2949120u,1081344u,0u,442368u},
  {2359296u,865075u,294912u,550503u},
  {1651459u,605535u,648831u,680273u},
  {2949120u,1228800u,0u,368640u},
  {2359296u,983040u,294912u,491520u},
  {1651459u,688108u,648831u,638987u}
 };
 uint32_t ci,i;
 if(!out||aspect>8u||aspect==6u)return 0;
 if(aspect>=7u)aspect--;
 if(crop==8192u)ci=0u;else if(crop==10240u)ci=1u;else if(crop==14629u)ci=2u;else return 0;
 for(i=0;i<4u;i++)((uint32_t*)out)[i]=words[aspect*3u+ci][i];
 return 1;
}
/* Compose the original pure aspect-fit, rectangle constructor/getters and
 * explicit-frame transform. This avoids a live global getter inside533af9e0.
 * The final intersection enforces the currently visible crop even at rounded
 * aspect edges. Normalized coordinates refer only to the active sampled ROI. */
static inline uint32_t aft_map_bbox(const struct aft_geometry*g,const struct aft_bbox*b,
                                    struct aft_subject*out){
 struct aft_rect ui={720u,480u,0u,0u},input,result;
 int32_t rect[4];struct aft_subject z={0};uint32_t l,t,r,d,vr,vb,i;
 if(!g||!b||!out||!g->nonce||g->signature!=aft_geometry_signature(g)||
    !aft_rect_valid(&g->visible)||!g->active_width||!g->active_height||
    b->right>65536u||b->bottom>65536u||b->left>=b->right||b->top>=b->bottom)return 0;
 if(!((uint32_t(*)(uintptr_t,const struct aft_rect*,struct aft_rect*))0x533b01d0)(0,&g->visible,&ui)||
    !aft_rect_valid(&ui)||ui.x+ui.width>720u||ui.y+ui.height>480u)return 0;
 l=ui.x+(uint32_t)(((uint64_t)ui.width*b->left)>>16);
 t=ui.y+(uint32_t)(((uint64_t)ui.height*b->top)>>16);
 r=ui.x+(uint32_t)(((uint64_t)ui.width*b->right)>>16);
 d=ui.y+(uint32_t)(((uint64_t)ui.height*b->bottom)>>16);
 if(r<=l||d<=t)return 0;
 ((void(*)(void*,int32_t,int32_t,int32_t,int32_t))0x5391224c)(rect,(int32_t)l,(int32_t)t,(int32_t)r,(int32_t)d);
 input.width=((uint32_t(*)(const void*))0x53912484)(rect);
 input.height=((uint32_t(*)(const void*))0x53912494)(rect);
 input.x=((uint32_t(*)(const void*))0x539123c8)(rect);
 input.y=((uint32_t(*)(const void*))0x539123d0)(rect);
 ((void(*)(struct aft_rect*,const struct aft_rect*,const struct aft_rect*,const struct aft_rect*))0x537a1af0)(&result,&input,&g->visible,&ui);
 if(!aft_rect_valid(&result))return 0;
 vr=g->visible.x+g->visible.width;vb=g->visible.y+g->visible.height;
 l=result.x<g->visible.x?g->visible.x:result.x;
 t=result.y<g->visible.y?g->visible.y:result.y;
 r=result.x+result.width;if(r>vr)r=vr;
 d=result.y+result.height;if(d>vb)d=vb;
 if(r<=l||d<=t)return 0;
 z.face=(struct aft_rect){r-l,d-t,l,t};
 for(i=0;i<sizeof(z)/4u;i++)((uint32_t*)out)[i]=((const uint32_t*)&z)[i];
 return 1;
}
#endif
