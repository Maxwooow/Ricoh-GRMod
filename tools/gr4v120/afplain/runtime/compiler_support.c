/* SPDX-License-Identifier: GPL-2.0-only */
#include <stdint.h>
/* ARM compiler aggregate-zero intrinsic. Kept local to this linked PIC module;
 * volatile byte stores prevent generating a recursive library clear call. */
void __aeabi_memclr8(void*p,uint32_t n){volatile uint8_t*d=p;uint32_t i;for(i=0;i<n;i++)d[i]=0;}
