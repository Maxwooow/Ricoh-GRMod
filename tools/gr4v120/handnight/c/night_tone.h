/* SPDX-License-Identifier: GPL-2.0-only
 *
 * night_tone: night brightening "③a+" applied in place to the merged Bayer frame.  Line-by-line translation of
 * ../night_tone_ref.py (the bit-exact specification; the rule and the units are described there).
 *
 * Rules (as mf_core): C99, integer only, no malloc / libc / library calls (no 64-bit division helpers), no
 * static or global data (no .data/.bss/.rodata, no jump tables): the tables are built in the scratch area.
 * Single thread.  Both passes go row by row and only keep per-row / per-grid-cell state, so a later version
 * can split the rows into bands for the three cores (pass-1 sums are plain integer sums) and the per-quad
 * loops (quad_y, the gain loop) are written for NEON (no branches besides clamps, int32 lanes, the 64-bit
 * products are VMULL.S32 / VMLAL.S32).
 */
#ifndef NIGHT_TONE_H
#define NIGHT_TONE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NT_OK            0
#define NT_ERR_ARG      (-1)   /* bad size, levels, gains, ISO, luminance parameters or scratch alignment */
#define NT_ERR_SCRATCH  (-3)   /* scratch area too small (see night_tone_scratch_bytes) */
#define NT_VERSION       2     /* night_tone_ref.VERSION */

/* luminance model of the statistics (does not change which gain is applied, only where L is measured):
 * Y = (0.30 R + 0.59 G + 0.11 B) / (white - black) * scale * (1 + k1 r2 + k2 r2^2),
 * r2 = squared distance of the quad centre from the window centre / squared half diagonal. */
struct night_tone_lum {
    int32_t scale_q16;   /* exposure scale, 65536 = 1.0; 4096 .. 1048576 */
    int32_t vig_k1_q16;  /* vignetting coefficients, |k| <= 4.0 */
    int32_t vig_k2_q16;
};

struct night_tone_info {
    /* stops in Q8 (256 = 1 stop) */
    int32_t g_q8;          /* global gain applied */
    int32_t d_q8;          /* extra lift at full weight (darkest areas) */
    int32_t n_q8;          /* noise limit N = max(0, 0.9 + log2(25600 / ISO)), at most the n_max of night_tone_set_n_max */
    int32_t g_full_q8;     /* AGC mean-target gain (no highlight cap) */
    int32_t g_cap_q8;      /* AGC gain after the highlight constraint */
    int32_t dark_lift_q8;  /* g + d: total lift of the darkest areas (effective ISO = ISO * 2^(dark_lift/256)) */
    /* the same in Q16 */
    int32_t g_q16, d_q16, n_q16, g_full_q16, g_cap_q16;
    uint32_t pixels;       /* w * h */
    uint32_t clip_before;  /* pixels >= white before */
    uint32_t clip_after;   /* pixels >= white after */
    int32_t clip_delta_ppm;/* (after - before) per million pixels, truncated toward 0 */
    int32_t changed;       /* 0: g = d = 0, the image was not touched */
};

/* bytes of scratch for a w x h window (the context is at its start), 0 if the size is not usable
 * (w, h even, 32 .. 16384).  6192 x 4128: 1 127 664 bytes (two 258 x 387 int32 grids = 799 KB, zone sums per
 * half-res row 248 KB, the rest row counters and tables). */
uint32_t night_tone_scratch_bytes(int32_t w, int32_t h);

struct night_tone_ctx;   /* lives at the start of the scratch area */

/* Single thread: init, stats_rows(0, h), plan, apply_rows(0, h), finish.  Same result as the steps below. */
int32_t night_tone_apply(uint16_t *bayer, int32_t w, int32_t h, int32_t stride, int32_t black, int32_t white,
                         const uint16_t wb_q12[4], int32_t iso, const struct night_tone_lum *lum,
                         void *scratch, uint32_t scratch_bytes, struct night_tone_info *out);

/* The steps (for the worker threads):
 *   1. night_tone_init (one thread): checks every argument and builds the tables; *ctx = the scratch area.  An error
 *      here is the only one the image can see, and nothing has been written yet.
 *   2. night_tone_stats_rows(ctx, y0, y1), pass 1, read only, any number of threads at once on disjoint bands that
 *      together cover rows 0 .. h exactly once.  y0, y1 in pixel rows: y0 a multiple of 16, y1 a multiple of 16 or
 *      h (a band holds whole 16-row grid rows; each band writes only its own grid rows and half-res rows).
 *      Or night_tone_stats_feed instead (below).
 *   3. night_tone_plan(ctx, out) (one thread, after every band of step 2): AGC, g / d / N, the guided filter on the
 *      grid, the gain table.  out (may be NULL) gets g, d, N, ... and clip_before; out->changed = 0: stop here, the
 *      image is not touched (steps 4 and 5 do nothing).
 *   4. night_tone_apply_rows(ctx, y0, y1), pass 2, in place, any number of threads at once on disjoint bands
 *      covering 0 .. h: y0, y1 even (whole 2x2 blocks; the grid interpolation is per half-res row, so any even split
 *      is safe).
 *   5. night_tone_finish(ctx, out) (one thread, after every band of step 4): clip_after and clip_delta_ppm. */
int32_t night_tone_init(uint16_t *bayer, int32_t w, int32_t h, int32_t stride, int32_t black, int32_t white,
                        const uint16_t wb_q12[4], int32_t iso, const struct night_tone_lum *lum,
                        void *scratch, uint32_t scratch_bytes, struct night_tone_ctx **ctx);
/* optional, after init and before plan (mf18): cap the noise limit N at n_max_q16 (stops Q16, >= 0), i.e. the global gain
 * and the total lift g + d stay at or below it (ref.apply n_max_q16).  Without the call N is not capped. */
int32_t night_tone_set_n_max(struct night_tone_ctx *ctx, int32_t n_max_q16);
/* optional, after init and before plan (final build): cap the dark lift d at d_max_q16 (stops Q16, >= 0) once it is planned
 * (d = min(d, d_max)); the global gain g is not changed (ref.apply d_max_q16).  Without the call d is not capped. */
int32_t night_tone_set_d_max(struct night_tone_ctx *ctx, int32_t d_max_q16);
int32_t night_tone_stats_rows(struct night_tone_ctx *ctx, int32_t y0, int32_t y1);
int32_t night_tone_plan(struct night_tone_ctx *ctx, struct night_tone_info *out);
int32_t night_tone_apply_rows(struct night_tone_ctx *ctx, int32_t y0, int32_t y1);
int32_t night_tone_finish(struct night_tone_ctx *ctx, struct night_tone_info *out);

/* Optional replacement of step 2 by the producer of the image (for example the merge's output stage, while the row
 * pair is still in the cache): half-res row y (pixel rows 2y, 2y + 1 = r0, r1, the final values of those rows).  Every
 * y in 0 .. h/2 - 1 exactly once; the 8 half-res rows 8m .. 8m + 7 of one grid row by one thread, 8m first (the
 * others in any order); different grid rows from any threads.  The bayer pointer given to init is then only used
 * by step 4. */
int32_t night_tone_stats_feed(struct night_tone_ctx *ctx, int32_t y, const uint16_t *r0, const uint16_t *r1);

#ifdef __cplusplus
}
#endif

#endif
