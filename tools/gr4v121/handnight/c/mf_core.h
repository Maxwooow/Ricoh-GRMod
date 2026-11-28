/* SPDX-License-Identifier: GPL-2.0-only
 *
 * mf_core: integer core of the burst merge, a line-by-line translation of ../ref.py (the bit-exact
 * specification).  Rules for this file and mf_core.c:
 *   - C99, integer only (no float/double), no malloc, no stdio, no libc calls (no memcpy/memset/division
 *     helpers either): the caller passes every buffer and a scratch area.
 *   - no static/global data at all (no .data/.bss/.rodata, no switch jump tables): the firmware modules
 *     are position independent (see tools/gr4v121/flash/ttl/gen.py).  Tables (noise table, reciprocal
 *     table) are inputs.
 *   - 32-bit arithmetic only unless noted.  Half-resolution gray = sum of a 2x2 Bayer block, at most
 *     4*65535 = 262140 (19 bits); a 16x16 tile L1 cost is at most 67 M.  Both fit int32_t.
 *   - every function returns 0 / a result >= 0, or a negative MF_ERR_* on a bad argument.
 *   - NEON: with __ARM_NEON (and not -DMF_NO_NEON) the inner loops use ARMv7 NEON intrinsics (no AArch64-only ones);
 *     the plain C kernels are the reference and give the same bits.  Camera build: -target arm-freestanding-eabihf
 *     -mfloat-abi=softfp -mfpu=neon-vfpv4 (soft-float calling convention, see fw_check.py).
 *
 * Image conventions
 *   - CFA input: uint16_t mosaic, `stride` in pixels (>= width), height and width even.
 *   - gray / pyramid levels: int32_t, tightly packed (stride = width of the level).
 *
 * Mirror padding (the reflection rule)
 *   ref.py uses np.pad(mode='reflect') (edge pixel not repeated): padded index -1 is pixel 1, -2 is pixel 2,
 *   n is pixel n-2, ...  np.pad applies this repeatedly when the pad is larger than the image, so the
 *   padded image is the periodic extension with period 2*(n-1):
 *       mf_reflect(i, n) = fold(i mod 2(n-1)), fold(k) = k if k < n else 2(n-1) - k,   n == 1 -> 0.
 *   The C core never builds padded copies; it calls mf_reflect (with an inside fast path).  ref.py's
 *   padded arrays are finite (pad per level, _pads()), so ref.py itself never reads beyond the pad; as
 *   long as the offsets stay clamped to +-MAX_OFFSET the two agree everywhere (check_c.py asserts the
 *   bound for the tile cost and tests mf_reflect against np.pad for pads up to several image widths).
 */
#ifndef MF_CORE_H
#define MF_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MF_OK            0
#define MF_ERR_ARG      (-1)   /* bad argument (size, k not a power-of-two box, value out of bound) */
#define MF_ERR_UNIMPL   (-2)   /* not implemented yet */
#define MF_ERR_SCRATCH  (-3)   /* scratch area too small */

/* constants copied from ref.py (keep in sync) */
#define MF_NLEVELS       4
#define MF_MAX_OFFSET    176   /* MAX_OFFSET: clamp of the total offset, half-res pixels */
#define MF_NOISE_BINS    256   /* NOISE_BINS */
#define MF_MAX_FRAMES    8     /* MAX_FRAMES */
#define MF_SPEC          10    /* ref.py VERSION this core implements */

/* ---- reflection --------------------------------------------------------------------------- */

/* index of the np.pad(mode='reflect') extension; any int i, n >= 1 */
int32_t mf_reflect(int32_t i, int32_t n);

/* ---- gray / pyramid ----------------------------------------------------------------------- */

/* ref.gray2: out[y*(w/2)+x] = sum of cfa[2y..2y+1][2x..2x+1].  h, w even, > 0.  out: (h/2)*(w/2) */
int32_t mf_gray2(const uint16_t *cfa, int32_t h, int32_t w, int32_t stride, int32_t *out);

/* ref.down: k x k box mean, round half up, k*k a power of two (k = 1,2,4,..,64); crops to multiples of
 * k.  src is h x w packed.  dst: (h/k)*(w/k).  Output sizes need > 0. */
int32_t mf_down(const int32_t *src, int32_t h, int32_t w, int32_t k, int32_t *dst);

/* ref.pyramid with LEVEL_FACTORS (1,2,4,4): g0 (h x w) is level 0; fills l1, l2, l3.
 * Level sizes: mf_level_dims.  */
int32_t mf_pyramid(const int32_t *g0, int32_t h, int32_t w, int32_t *l1, int32_t *l2, int32_t *l3);
/* sizes of level `lv` (0..3) for a level-0 size h x w; returns MF_ERR_ARG if empty */
int32_t mf_level_dims(int32_t h, int32_t w, int32_t lv, int32_t *oh, int32_t *ow);

/* ---- alignment pieces --------------------------------------------------------------------- */

/* L1 cost of the tile with origin (y0, x0) in ref (size h x w), compared with alt at (y0+oy, x0+ox).
 * Both images are mirror padded (mf_reflect) as ref.py's _cost_list does.  Tiles may stick out of the
 * image (last tile).  Equals _cost_list(...)[0].  Returns the cost (>= 0). */
int32_t mf_tile_cost(const int32_t *ref, const int32_t *alt, int32_t h, int32_t w, int32_t tile,
                     int32_t y0, int32_t x0, int32_t oy, int32_t ox);

/* ref.block_means: floor mean per Bayer pixel (sum / (tile*tile*4)) of non-overlapping tile blocks;
 * partial edge blocks are filled by mirror reflection.  out: ceil(h/tile) * ceil(w/tile) */
int32_t mf_block_means(const int32_t *g0, int32_t h, int32_t w, int32_t tile, int32_t *out);

/* ref.tile_noise for one value: ntab[min(max(mean_pix - black, 0) >> nshift, 255)] */
int32_t mf_tile_noise(int32_t mean_pix, int32_t black, const int32_t *ntab, int32_t nshift);
/* the same for n values */
int32_t mf_tile_noise_n(const int32_t *mean_pix, int32_t n, int32_t black, const int32_t *ntab,
                        int32_t nshift, int32_t *out);

/* ref.imedian for values with |v| <= bound: the lower middle element of the sorted values
 * (element (n-1)/2), by counting.  hist: scratch of mf_imedian_hist_size(bound) int32_t.
 * Returns the median, or INT32_MIN if n < 1 or a value is out of bound (bound 1..1024). */
int32_t mf_imedian(const int32_t *v, int32_t n, int32_t bound, int32_t *hist);
int32_t mf_imedian_hist_size(int32_t bound);

/* ---- TODO: alignment and merge (not implemented yet, intended signatures) -------------------
 *
 * mf_align_pair: ref.align_pair.  Alignment of one alternate frame to the reference.
 *   ref_lv[4], alt_lv[4] : pyramids (mf_pyramid) of the gray images, level sizes from mf_level_dims
 *   h0, w0               : level-0 (half-res gray) size
 *   e0a                  : Q8 noise per 16x16 level-0 tile, ceil(h0/16) x ceil(w0/16) (tile_noise of block_means)
 *   oy, ox               : out, ceil(h0/16) x ceil(w0/16) level-0 offsets (half-res px)
 *   g                    : out, g[0] = global y offset, g[1] = global x offset
 *   scratch              : caller's scratch area (candidate lists, per-level offsets); size = mf_scratch_size()
 *   ties are broken by the key (cost, |dy|+|dx|, scan order) as in _search, compared lexicographically
 *   (do not pack it into 32 bits: ref.py packs it into int64).
 *
 * mf_merge: ref.merge.  Whole burst merge.
 *   ref                  : reference Bayer frame, uint16, stride in pixels
 *   alt                  : n_alt (<= MF_MAX_FRAMES-1) pointers to alternate frames, same size and stride
 *   width, height        : even
 *   black                : integer black level (mean of the CFA levels)
 *   ntab, nshift         : noise table of ref.noise_table (MF_NOISE_BINS int32 entries) and its shift
 *   rcp                  : reciprocal table RCP[0..64*MF_MAX_FRAMES] (int32 would overflow: RCP[1] = 2^24, fits)
 *   out                  : merged frame, uint16, out_stride in pixels (may equal ref for in-place? no: separate)
 *   scratch              : size = mf_scratch_size(width, height, n_alt)
 * The weight division (S << 16) // E needs a 64-bit numerator (S up to 2.4e6): TODO decide between a
 * 64/32 helper and an equivalent 32-bit formulation (see check notes).
 */
/* bytes of scratch mf_merge needs: both pyramids (about 1.33 half-res int32 planes each), per-tile data and a few
 * rows per alternate for the row pipeline */
int32_t mf_scratch_size(int32_t width, int32_t height, int32_t n_alt);
/* bytes of scratch mf_align_pair needs for a level-0 size h0 x w0 */
int32_t mf_align_scratch_size(int32_t h0, int32_t w0);

int32_t mf_align_pair(const int32_t *const ref_lv[MF_NLEVELS], const int32_t *const alt_lv[MF_NLEVELS],
                      int32_t h0, int32_t w0, const int32_t *e0a, int32_t *oy, int32_t *ox, int32_t g[2],
                      void *scratch, uint32_t scratch_bytes);

/* optional outputs of mf_merge_ex (do not change the result): per alternate the brightness gain k (Q12, 0 when not
 * estimated), whether the alternate is used (|k-1| <= 8 %), its global offset (half-res px), and the sum of its final
 * per-pixel weights (W6, 0..64) over the half-res pixels; wcount = half-res pixels summed, strips = strips done */
struct mf_stats {
    int32_t k_q12[MF_MAX_FRAMES - 1], used[MF_MAX_FRAMES - 1], gy[MF_MAX_FRAMES - 1], gx[MF_MAX_FRAMES - 1];
    uint32_t wsum[MF_MAX_FRAMES - 1], wcount, strips;
};
#define MF_ERR_STOP     (-4)   /* stop() asked to stop (time limit); out is incomplete */

/* alt frames are read only (the brightness normalisation is applied as they are read; up to the frozen v7 core they
 * were normalised in place, so callers must not rely on either) */
int32_t mf_merge(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                 int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                 const int32_t *rcp, int32_t green_diag, int32_t white, uint16_t *out, int32_t out_stride,
                 void *scratch, uint32_t scratch_bytes);
/* mf_merge with an optional stop check: stop(stop_ctx, i) is called after alternate i's alignment (i < MF_MAX_FRAMES)
 * and after each output strip (i = MF_MAX_FRAMES + strip); a non-zero answer returns MF_ERR_STOP at once.  stop and st
 * may be 0.  vmax (ref.py v8): largest value of the sensor container ((1 << bits) - 1); normalised alternate pixels and the
 * output are limited to it; vmax <= 0 or >= 65535 = no limit (v7, what mf_merge does).  With vmax = 0 the output is the
 * same as mf_merge's whenever MF_OK is returned.  ntab_w, nshift_w (ref.py v9): a second noise table (MF_NOISE_BINS entries,
 * same format as ntab) and its shift, used only for the expected noise of the weights (pixel ratio and block check); ntab
 * keeps driving the alignment noise and so the brightness gain.  ntab_w = 0: ntab and nshift are used (v8, what mf_merge
 * does; nshift_w is then ignored).  ref.weights_noise_table builds the v9 weights table. */
int32_t mf_merge_ex(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                    int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                    const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                    void *scratch, uint32_t scratch_bytes, int32_t (*stop)(void *, int32_t), void *stop_ctx,
                    struct mf_stats *st);

/* ---- parallel merge ---------------------------------------------------------------------------------------------
 * The caller supplies the threads.  mf_merge_mt cuts the work into jobs and hands them to par->run:
 *   run(par_ctx, job, arg, count) must call job(arg, i, slot) exactly once for every i in 0 .. count-1, possibly
 *   concurrently, and return when all calls have returned, with their memory writes visible to the caller (a barrier).
 *   slot (0 .. n-1) names the thread making the call: two calls with the same slot never overlap, and slot 0 is the
 *   thread that called mf_merge_mt (run's caller).  Which thread takes which index is free (results do not depend on it).
 * Work split (results bit-identical to mf_merge_ex for every n and every assignment of jobs to threads):
 *   phase 1, for the reference and then each alternate in turn: the gray/level-1 pass and the level-2/3 reductions in
 *   row bands, each alignment level's tile search in tile-row bands, the 9 global level-0 candidates, the level-0 cost
 *   and refinement passes in tile-row bands, the brightness-gain tiles in tile-row bands (histogram and medians stay
 *   serial).  The alternates are not aligned concurrently: each would need its own pyramid (34 MB at 6304 x 4210).
 *   phase 2: the output in bands of whole strips (MF_STRIP_ROWS half-res rows), one job per band with the row-pipeline
 *   state of its slot; a band recomputes the two difference rows above and below it (halo, read-only inputs).
 * Stop: stop(stop_ctx, i) is called only on slot 0 (after each alternate, and after each strip that slot 0 finishes);
 * its answer, or a store of 1 into par->stop by the caller from any thread (__atomic_store_n or a volatile store), makes
 * every job return at its next strip / band, and mf_merge_mt returns MF_ERR_STOP (out incomplete).  par->stop must be 0
 * at the call.  par == 0, n <= 1 or run == 0: everything runs inline on the calling thread (= mf_merge_ex). */
#define MF_MAX_THREADS  4
typedef void (*mf_job)(void *arg, int32_t index, int32_t slot);
struct mf_par {
    int32_t n;                                               /* threads (slots), 1 .. MF_MAX_THREADS */
    void (*run)(void *par_ctx, mf_job job, void *arg, int32_t count);
    void *par_ctx;
    int32_t stop;                                            /* 0; 1 = stop (read with relaxed atomic loads) */
    /* progress, written by mf_merge_mt for the caller to read at any time (relaxed atomics; never read by the merge, results
     * do not depend on them): */
    uint32_t ref_done;                                       /* 1 once the reference pyramid is made (phase 1) */
    uint32_t strips_done;                                    /* output strips finished in phase 2, all threads (0 at its start) */
    /* optional timing marks (0: none): mark(par_ctx, stage) is called on the calling thread when the merge enters a stage
     * (MF_ST_*, below), between jobs, never inside one; results do not depend on it.  Phase 1 enters the stages once per
     * frame (the reference: MF_ST_PYR only), phase 2 once each. */
    void (*mark)(void *par_ctx, int32_t stage);
};
#define MF_ST_PYR     0     /* phase 1: a frame's gray image and pyramid (and, for the reference, the alignment noise) */
#define MF_ST_COARSE  1     /* phase 1: searches of levels 3 and 2 */
#define MF_ST_LEVEL1  2     /* phase 1: search of level 1 (and its median) */
#define MF_ST_LEVEL0  3     /* phase 1: level 0: the 9 global candidates, the costs at the global offset, the refinement */
#define MF_ST_GAIN    4     /* phase 1: the brightness gain of the alternate */
#define MF_ST_P2SETUP 5     /* phase 2: tables and per-thread state */
#define MF_ST_ROWS    6     /* phase 2: the row pipeline (every output strip) */
#define MF_ST_END     7     /* phase 2: after the last strip (statistics) until mf_merge_* returns */
#define MF_STAGES     8
/* scratch for mf_merge_mt with `threads` threads (1 .. MF_MAX_THREADS); mf_scratch_size = threads 1.  Each thread more
 * adds one row-pipeline state (about 70 bytes per pixel column per alternate + 52) and a row of tile sums. */
int32_t mf_scratch_size_mt(int32_t width, int32_t height, int32_t n_alt, int32_t threads);
/* Output on top of the scratch (mf13): the first mf_scratch_out_room(width, height) bytes of the scratch hold only the two
 * pyramids, which phase 1 alone uses; mf_merge_mt / mf_merge_ex write `out` only in phase 2.  So `out` may lie inside
 * [scratch, scratch + mf_scratch_out_room) (out_stride * height * 2 bytes from out must fit there); the result is the same
 * bits as with a separate output.  Any other overlap of out with the scratch or the inputs is not allowed. */
int32_t mf_scratch_out_room(int32_t width, int32_t height);
int32_t mf_merge_mt(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                    int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                    const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                    void *scratch, uint32_t scratch_bytes, int32_t (*stop)(void *, int32_t), void *stop_ctx,
                    struct mf_par *par, struct mf_stats *st);

/* ---- the scratch in parts (mf14) ----------------------------------------------------------------------------------
 * The same merge with the scratch in MF_PARTS separate areas instead of one, so that no single block of memory is large:
 *   part 0: the reference pyramid's level 0 (h/2 x w/2 int32), read in phase 1 only;
 *   part 1: the alternate pyramid's level 0 (the same size), read in phase 1 only;
 *   part 2: everything else (levels 1..3 of both pyramids, per-tile data, offsets, tables, the per-thread row pipelines).
 * mf_parts_size_mt gives the bytes each part needs (part 0 = part 1 = 4 * (h/2) * (w/2); at 6304 x 4210: 26 539 840 each).
 * Every part must be 16-byte aligned.  The output may be one area (out, mem->out2 = 0) or two row bands: full-res rows
 * 0 .. out_split-1 at out, rows out_split .. height-1 at mem->out2 (out_split even, 0 < out_split < height), both with
 * out_stride.  Like mf_scratch_out_room for the one-area scratch, the output (either band) may lie inside part 0 or part 1
 * (phase 2 alone writes it, phase 1 alone reads those parts); any other overlap is not allowed.  Results: the same bits as
 * mf_merge_mt for every split. */
#define MF_PARTS 3
struct mf_mem {
    void *part[MF_PARTS];
    uint32_t bytes[MF_PARTS];
    uint16_t *out2;                                          /* 0: one output area */
    int32_t out_split;
};
int32_t mf_parts_size_mt(int32_t width, int32_t height, int32_t n_alt, int32_t threads, uint32_t bytes[MF_PARTS]);
int32_t mf_merge_parts(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                       int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                       const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                       const struct mf_mem *mem, int32_t (*stop)(void *, int32_t), void *stop_ctx,
                       struct mf_par *par, struct mf_stats *st);

#ifdef __cplusplus
}
#endif
#endif
