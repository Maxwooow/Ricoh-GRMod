// Copyright (C) 2026 DoYitNow
// SPDX-License-Identifier: GPL-2.0-only

/* Custom AE/WB views share the allocation of native primary record zero.
 * Keep the original 400-byte Map, 48 factory slots, CIS, PPU and SRO layouts.
 * Each appended view owns 12 records: four processes by three crop magnitudes.
 */
#include <stdint.h>

typedef struct {
    uint32_t id, xn, xd, yn, yd;
} Ratio;

extern const Ratio ratios[CUSTOM_COUNT];

/* Avoid an external __aeabi division dependency in the appended ARM image.
 * The compiler verifies nonzero denominators and results within native u16.
 */
static uint32_t divide(uint64_t n, uint32_t d) {
    uint32_t q = 0, r = 0, hi = n >> 32, lo = n;
    for (unsigned b = 0; b < 64; ++b) {
        unsigned bit = hi >> 31;
        hi = (hi << 1) | (lo >> 31);
        lo <<= 1;
        r = (r << 1) | bit;
        q <<= 1;
        if (r >= d) {
            r -= d;
            ++q;
        }
    }
    return q;
}

uint32_t crop_identity(uint32_t id) {
    for (unsigned n = 0; n < CUSTOM_COUNT; ++n) {
        if (ratios[n].id == id)
            return id;
    }
    return 0;
}

static void copy(void *d, const void *s, unsigned bytes) {
    uint8_t *a = d;
    const uint8_t *b = s;
    for (unsigned i = 0; i < bytes; ++i)
        a[i] = b[i];
}

uint32_t *crop_make_view(uint32_t *map, uint32_t id) {
    unsigned n;
    for (n = 0; n < CUSTOM_COUNT; ++n) {
        if (ratios[n].id == id)
            break;
    }
    if (n == CUSTOM_COUNT)
        return map;

    const Ratio *r = ratios + n;
    uint8_t *view = (uint8_t *)map[1] + 48 + n * VIEW_BYTES;
    copy(view, map, 400);
    for (unsigned process = 0; process < 4; ++process) {
        for (unsigned mag = 0; mag < 3; ++mag) {
            uint16_t *src = (uint16_t *)map[1 + process * 12 + mag];
            uint16_t *out = (uint16_t *)(view + 400 + (process * 3 + mag) * 48);
            copy(out, src, 46);
            ((uint32_t *)view)[1 + process * 12 + mag] = (uint32_t)out;

            /* u16 record indices: origin H/V 1/2, block size 3/4,
             * native counts 5/6, repeated AE sizes 7..10. Keep counts 64/62.
             */
            unsigned spanH = divide((uint64_t)src[3] * src[5] * r->xn, r->xd);
            unsigned spanV = divide((uint64_t)src[4] * src[6] * r->yn, r->yd);
            unsigned sizeH = divide(spanH, src[5]) & ~1u;
            unsigned sizeV = divide(spanV, src[6]) & ~1u;
            unsigned countH = src[5], countV = src[6];
            unsigned originH = (src[1] + (src[3] * src[5] - sizeH * countH) / 2) & ~1u;
            unsigned originV = (src[2] + (src[4] * src[6] - sizeV * countV) / 2) & ~1u;
            out[1] = originH;
            out[2] = originV;
            out[3] = out[7] = out[9] = sizeH;
            out[4] = out[8] = out[10] = sizeV;
            out[5] = countH;
            out[6] = countV;

            /* Native SRO records have no aspect-dependent physical data.
             * Partition the centered grid at each real strip start+lead;
             * inactive strips get zero count and zero local origin.
             */
            uint32_t *sro = (uint32_t *)map[0xF0 / 4];
            uint16_t *strip = (uint16_t *)sro[process * 12 + mag];
            unsigned prior = 0, strips = sro[0xE0 / 4];
            for (unsigned i = 0; i < 4; ++i) {
                if (i >= strips) {
                    out[15 + i] = out[11 + i] = 0;
                    continue;
                }
                unsigned stop = countH;
                if (i + 1 < strips) {
                    unsigned threshold = strip[2 + i + 1] + strip[14 + i + 1];
                    stop = threshold > originH ? divide(threshold - originH + sizeH - 1, sizeH) : 0;
                    if (stop > countH)
                        stop = countH;
                }
                out[15 + i] = stop - prior;
                out[11 + i] = stop > prior ? originH + prior * sizeH - strip[2 + i] : 0;
                prior = stop;
            }
        }
    }
    return (uint32_t *)view;
}

void crop_clone_tail(uint32_t *dst, uint32_t *src) {
    for (unsigned n = 0; n < CUSTOM_COUNT; ++n) {
        uint8_t *a = (uint8_t *)dst[1] + 48 + n * VIEW_BYTES;
        uint8_t *b = (uint8_t *)src[1] + 48 + n * VIEW_BYTES;
        /* Copy records, then bind all pointer fields to the destination
         * owner. A raw tail copy would retain source primary/CIS/PPU/SRO.
         */
        copy(a, dst, 400);
        copy(a + 400, b + 400, 12 * 48);
        for (unsigned process = 0; process < 4; ++process) {
            for (unsigned mag = 0; mag < 3; ++mag)
                ((uint32_t *)a)[1 + process * 12 + mag] = (uint32_t)(a + 400 + (process * 3 + mag) * 48);
        }
    }
}
