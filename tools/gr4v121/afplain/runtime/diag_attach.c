/* SPDX-License-Identifier: GPL-2.0-only */
#include "diag_attach.h"
typedef char pointer_is_arm32[(sizeof(uintptr_t)==4)?1:-1];
static int span(uintptr_t p,uint32_t n){return p&&n&&p<=UINTPTR_MAX-(n-1u);}
static uint32_t rd(uintptr_t p,uint32_t o){return *(const uint32_t*)(p+o);}
static int overlap(uintptr_t a,uint32_t n,uintptr_t b,uint32_t m){return a<=b+m-1u&&b<=a+n-1u;}
static int magic(const uint8_t*p){return p[0]=='G'&&p[1]=='R'&&p[2]=='A'&&p[3]=='F'&&p[4]=='D'&&p[5]=='I'&&p[6]=='A'&&p[7]=='G';}
static void copy(void*v,const void*p,uint32_t n){uint8_t*d=v;const uint8_t*s=p;uint32_t i;for(i=0;i<n;i++)d[i]=s[i];}
static uintptr_t alloc(uintptr_t pool,uint32_t n){uintptr_t v=rd(pool,0);return((uintptr_t(*)(uintptr_t,uint32_t,uint32_t,uint32_t))rd(v,8))(pool,n,0,0);}
static void release(uintptr_t pool,uintptr_t p){uintptr_t v=rd(pool,0);((void(*)(uintptr_t,uintptr_t,uint32_t))rd(v,12))(pool,p,0);}
uint32_t aft19_diag_append96_tag(uintptr_t maker,uint32_t capacity,const uint8_t wire[96],uint32_t tag){
 uintptr_t ifd,begin,end,cap,entry=0,data=0,pool=0;uint32_t i,n,used,need;
 if(!span((uintptr_t)wire,96)||!magic(wire))return AFT19_BAD_WIRE;
 if(!span(maker,16)||(maker&3u))return AFT19_BAD_MAKER;ifd=rd(maker,4);
 if(!span(ifd,0x38)||(ifd&3u))return AFT19_BAD_IFD;
 begin=rd(ifd,12);end=rd(ifd,16);cap=rd(ifd,20);
 if((begin|end|cap)&3u||end<begin||cap<end||cap-begin>4u*256u||!span(begin,cap-begin?cap-begin:4u))return AFT19_BAD_VECTOR;
 n=(uint32_t)(end-begin)/4u;
 if(overlap((uintptr_t)wire,96,maker,16)||overlap((uintptr_t)wire,96,ifd,0x38)||
    overlap((uintptr_t)wire,96,begin,cap-begin?cap-begin:4u))return AFT19_INPUT_ALIAS;
 for(i=0;i<n;i++){
  uintptr_t q=rd(begin,4u*i);
  if(!span(q,24)||(q&3u))return AFT19_BAD_VECTOR;
  if(*(const uint16_t*)(q+4)==tag){entry=q;break;}
 }
 if(entry){
  if(*(const uint16_t*)(entry+6)!=7u||rd(entry,8)!=96u)return AFT19_EXISTING_SCHEMA;
  data=rd(entry,16);if(!span(data,96)||!magic((const uint8_t*)data))return AFT19_EXISTING_DATA;
  if(overlap((uintptr_t)wire,96,entry,24)||overlap((uintptr_t)wire,96,data,96))return AFT19_INPUT_ALIAS;
 }
 used=((uint32_t(*)(uintptr_t))0x5380f520)(maker);
 need=entry&&*(const uint8_t*)(entry+20)?0u:108u;
 if(used>capacity||need>capacity-used)return AFT19_BYTE_CAPACITY;
 if(entry){copy((void*)data,wire,96);*(uint8_t*)(entry+20)=1;return AFT19_UPDATED;}
 if(cap-end<4u||!span(end,4))return AFT19_VECTOR_FULL;
 pool=((uintptr_t(*)(uint32_t))0x53905dc4)(4u);
 if(!span(pool,4)||!span(rd(pool,0),16))return AFT19_POOL_UNAVAILABLE;
 entry=alloc(pool,24);if(!span(entry,24))return AFT19_ENTRY_OOM;
 ((void(*)(uintptr_t,uint32_t,uint32_t,uint32_t,uint32_t))0x5380eaa8)(entry,tag,7,96,0);
 data=rd(entry,16);if(!span(data,96)){release(pool,entry);return AFT19_PAYLOAD_OOM;}
 ((void(*)(uintptr_t,uintptr_t))0x5380e318)(ifd,entry);
 if(rd(ifd,16)!=end+4u||rd(end,0)!=entry){
  /* Free only when the unchanged vector proves ownership was not transferred.
   * An unexpected changed vector is left untouched, including any ownership. */
  if(rd(ifd,12)==begin&&rd(ifd,16)==end&&rd(ifd,20)==cap){release(pool,data);release(pool,entry);}
  return AFT19_ADD_FAILED;
 }
 copy((void*)data,wire,96);*(uint8_t*)(entry+20)=1;return AFT19_APPENDED;
}
uint32_t aft19_diag_append96(uintptr_t maker,uint32_t capacity,const uint8_t wire[96]){return aft19_diag_append96_tag(maker,capacity,wire,AFT19_DIAG_TAG);}
