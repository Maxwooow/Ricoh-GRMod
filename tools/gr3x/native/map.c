// Copyright (C) 2026 DoYitNow (original GR IV algorithm)
// SPDX-License-Identifier: GPL-2.0-only
// IIIx 1.60 port. Layout evidence: ImageMapParameter::CreatMap 0x5365d900,
// SetupWaveDetectParameter 0x5365fd24, SRO setup 0x5365fc40.
// 304-byte map; 24 native primary pointers; 34-byte primary records;
// 3 strips, 28-byte SRO records. These differ from the GR IV implementation.
#include <stdint.h>
typedef struct { uint32_t id, xn, xd, yn, yd; } Ratio;
extern const Ratio ratios[7];
#define VIEW_BYTES (304 + 12 * 36)

static uint32_t divide(uint64_t n, uint32_t d) {
    uint32_t q=0, r=0, hi=n>>32, lo=n;
    for (unsigned b=0;b<64;++b) {
        unsigned bit=hi>>31;
        hi=(hi<<1)|(lo>>31);lo<<=1;r=(r<<1)|bit;q<<=1;
        if(r>=d){r-=d;++q;}
    }
    return q;
}
static void copy(void *d,const void *s,unsigned bytes) {
    uint8_t *a=d;const uint8_t *b=s;
    for(unsigned i=0;i<bytes;++i)a[i]=b[i];
}
uint32_t crop_identity(uint32_t id) { return id>=4 && id<=10 ? id : 0; }

uint32_t *crop_make_view(uint32_t *map,uint32_t id) {
    if(!crop_identity(id))return map;
    unsigned n=id-4;
    const Ratio *r=ratios+n;
    uint8_t *view=(uint8_t *)map[1]+36+n*VIEW_BYTES;
    copy(view,map,304);
    for(unsigned process=0;process<4;++process)for(unsigned mag=0;mag<3;++mag){
        uint16_t *src=(uint16_t *)map[1+process*6+mag];
        uint16_t *out=(uint16_t *)(view+304+(process*3+mag)*36);
        copy(out,src,34);
        ((uint32_t *)view)[1+process*6+mag]=(uint32_t)out;
        unsigned sizeH=divide((uint64_t)src[3]*r->xn,r->xd)&~1u;
        unsigned sizeV=divide((uint64_t)src[4]*r->yn,r->yd)&~1u;
        unsigned originH=(src[1]+(src[3]-sizeH)*src[5]/2)&~1u;
        unsigned originV=(src[2]+(src[4]-sizeV)*src[6]/2)&~1u;
        out[1]=originH;out[2]=originV;
        out[3]=out[7]=out[9]=sizeH;
        out[4]=out[8]=out[10]=sizeV;
        uint32_t *sro=(uint32_t *)map[0x90/4];
        uint16_t *strip=(uint16_t *)sro[process*6+mag];
        unsigned prior=0;
        for(unsigned i=0;i<3;++i){
            if(!src[14+i]){out[11+i]=out[14+i]=0;continue;}
            unsigned next=i+1;
            while(next<3 && !src[14+next])++next;
            unsigned stop=src[5];
            if(next<3){
                unsigned threshold=strip[2+next]+strip[8+next];
                stop=threshold>originH?divide(threshold-originH+sizeH-1,sizeH):0;
                if(stop>src[5])stop=src[5];
            }
            out[14+i]=stop-prior;
            out[11+i]=stop>prior?originH+prior*sizeH-strip[2+i]:0;
            prior=stop;
        }
    }
    return (uint32_t *)view;
}

void crop_clone_tail(uint32_t *dst,uint32_t *src){
    for(unsigned n=0;n<7;++n){
        uint8_t *a=(uint8_t *)dst[1]+36+n*VIEW_BYTES;
        uint8_t *b=(uint8_t *)src[1]+36+n*VIEW_BYTES;
        copy(a,dst,304);copy(a+304,b+304,12*36);
        for(unsigned process=0;process<4;++process)for(unsigned mag=0;mag<3;++mag)
            ((uint32_t *)a)[1+process*6+mag]=(uint32_t)(a+304+(process*3+mag)*36);
    }
}
