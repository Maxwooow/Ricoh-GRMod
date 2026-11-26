/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef GRMOD_AFPLAIN_STOCK_POINT_API_H
#define GRMOD_AFPLAIN_STOCK_POINT_API_H
#include <stdint.h>
/* Stock "move the AF frame" sequence of the official GR IV 1.20 RTOS, taken from the earlier
 * half-press point-move work (afs1/runtime/stock_point_api.h, there limited to Select 1 and
 * Pinpoint 4).  Used here for Follow (tracking, 5) and Continuous (6): the stock point setter
 * 533ae354 itself accepts every mode 1..6 and 15, and the frame-size table 533ae04c gives
 * the same 64x52 frame to modes 1, 2, 3, 5 and 6.
 * The Common RPC inside 5377e7b8 waits for its acknowledgement without a timeout, exactly as it
 * does when the user moves the frame by touch. */
typedef struct { int32_t x, y; } Gr4Point;
typedef struct { uint32_t width, height; } Gr4Size;
typedef struct { int32_t x, y; uint32_t width, height; } Gr4UiRect;
typedef struct { uint32_t width, height, x, y; uint8_t ny, nx, pad[2]; } Gr4Area;
enum { GR4_POINT_PREPARE_FAILED=1, GR4_POINT_ALREADY_CURRENT=2, GR4_POINT_NOT_OBSERVED=3, GR4_POINT_APPLIED=4, GR4_POINT_APPLIED_MIRROR_MISMATCH=5 };
typedef struct { Gr4Point clamped, ui_readback; Gr4Area before, desired, actual; uint32_t status; } Gr4PointResult;
static inline int gr4_area_equal(const Gr4Area *a,const Gr4Area *b){
 return a->width==b->width&&a->height==b->height&&a->x==b->x&&a->y==b->y&&a->ny==b->ny&&a->nx==b->nx;
}
static inline uint32_t gr4_apply_stock_point(uintptr_t userdata,uintptr_t focus_model,uintptr_t geometry,uintptr_t ops,uint32_t mode,Gr4Point target,Gr4PointResult *r){
 Gr4Size size={0,0};Gr4UiRect rect={0,0,0,0};int32_t left,top;const Gr4Area *want,*effective;
 r->clamped=target;
 ((void(*)(uintptr_t,Gr4Point*,uint32_t))0x533aeae4u)(focus_model,&r->clamped,mode);
 ((void(*)(Gr4Size*,uintptr_t,uint32_t))0x533ae8fcu)(&size,focus_model,mode);
 if(!size.width||!size.height||size.width>720u||size.height>480u)return r->status=GR4_POINT_PREPARE_FAILED;
 left=r->clamped.x-(int32_t)(size.width/2u);top=r->clamped.y-(int32_t)(size.height/2u);
 ((void(*)(Gr4UiRect*,int32_t,int32_t,int32_t,int32_t))0x5391224cu)(&rect,left,top,left+(int32_t)size.width,top+(int32_t)size.height);
 r->desired=(Gr4Area){0,0,0,0,1,1,{0,0}};
 if(!((uint32_t(*)(uintptr_t,const Gr4UiRect*,Gr4Area*))0x533b0290u)(geometry,&rect,&r->desired))return r->status=GR4_POINT_PREPARE_FAILED;
 ((void(*)(uintptr_t,Gr4Area*))0x5377d520u)(ops,&r->before);r->actual=r->before;
 if(gr4_area_equal(&r->before,&r->desired))return r->status=GR4_POINT_ALREADY_CURRENT;
 ((void(*)(uintptr_t,const Gr4Area*))0x5377f448u)(ops,&r->desired);
 ((void(*)(uintptr_t,Gr4Area*))0x5377d520u)(ops,&r->actual);
 if(!gr4_area_equal(&r->actual,&r->desired))return r->status=GR4_POINT_NOT_OBSERVED;
 ((void(*)(uintptr_t,const Gr4Point*))0x533aec04u)(focus_model,&r->clamped);
 ((void(*)(uintptr_t))0x533aee88u)(focus_model);
 ((void(*)(uintptr_t,Gr4Point*))0x5329bca8u)(userdata,&r->ui_readback);
 want=(const Gr4Area*)(userdata+0x80u);effective=(const Gr4Area*)(userdata+0xbc4u);
 if(r->ui_readback.x!=r->clamped.x||r->ui_readback.y!=r->clamped.y||!gr4_area_equal(want,&r->desired)||!gr4_area_equal(effective,&r->desired))
  return r->status=GR4_POINT_APPLIED_MIRROR_MISMATCH;
 return r->status=GR4_POINT_APPLIED;
}
#endif
