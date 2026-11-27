/* SPDX-License-Identifier: GPL-2.0-only
 *
 * mf_core: integer core of the burst merge; see mf_core.h for the rules.  Translation of ../ref.py.
 *
 * Speed (the camera's Cortex-A7: in-order, 450 MHz, 32 KB L1, 1 MB L2, slow DRAM, hardware prefetcher off):
 *   - one pass over each frame where the reference implementation made several: gray + level 1 + 16x16 tile sums
 *     together; the level-0 cost at the global offset for all tiles as one row-by-row pass that also sums the
 *     alternate's tiles (brightness gain); the merge as a row pipeline that reads each alternate row pair for the
 *     differences and once more, a few rows later, for the weighted sum, with only a few rows of state per frame
 *     (all of it fits the L2 cache), instead of 32-row strips of int32 planes that did not;
 *   - the brightness normalisation of an alternate is applied where its pixels are read (bit-identical to
 *     ref.py's normalised copy), so the frames are not rewritten in place;
 *   - the per-pixel colour-plane selection, mirror checks and divisions are out of the inner loops (separate edge
 *     handling; thresholds instead of divisions where the weight is 0 or 64);
 *   - ARMv7 NEON kernels (#if MF_NEON) for the inner loops; the plain C kernels beside them are the reference and
 *     are used when NEON is not available, with -DMF_NO_NEON, or when a value range check fails (X.fast = 0: black
 *     outside 0..65535, nshift outside 0..31, a noise entry above MF_E_FAST).  In the NEON mode the |D| rows and
 *     the weight thresholds are uint16 with saturating sums: exact, because every weight-0 threshold is <= 61036.
 *     Both give identical results (check_merge.py, check_align.py, check_c.py, check_neon.py; neon_selftest.c checks
 *     the arithmetic identities the NEON kernels use: VQRDMULH normalisation, division by 9, thresholds).
 *   Results are unchanged: the order of integer sums is free, every rounding is the one of ref.py.
 *   ref.py v8 limit (vmax, X.top): normalised alternate pixels and the output are limited to vmax (65535 = no limit); in
 *   the NEON kernels one VMIN after norm8's saturating narrow and one before the output store.
 *   mf15 (phase 2, the same bits; ARM instruction counts in the emulator about 12 % lower on real GR IV crops): the weight
 *   thresholds per noise bin from a table made once per merge instead of per pixel (e_row); the ramp of the plane weights
 *   after the row from flags and stored sums, by one hardware division, instead of a test per 8 pixels and plane
 *   (wp_plane_neon, wp_ramp); D sums of two 8-pixel blocks without transfers to core registers (d_row); the weight sum in
 *   vector lanes (emit_row); each thread first takes the strips of its own region in order, so its row pipeline goes on
 *   without halo rows (band_claim).  The phase-2 tables live in the brightness histogram, which phase 1 alone uses. */
#include "mf_core.h"

#if defined(__ARM_NEON) && !defined(MF_NO_NEON)
#define MF_NEON 1
#include <arm_neon.h>
#endif

int32_t mf_reflect(int32_t i, int32_t n)
{
    int32_t p, k;
    if (n <= 1)
        return 0;
    p = 2 * (n - 1);
    if (i >= 0 && i < n)
        return i;
    k = i % p;
    if (k < 0)
        k += p;
    return k < n ? k : p - k;
}

/* per-row kernels are not inlined into their callers: no speed difference, a smaller module */
#define MF_NOINLINE __attribute__((noinline))

static inline int32_t refl(int32_t i, int32_t n)
{
    return (i >= 0 && i < n) ? i : mf_reflect(i, n);
}

/* Software prefetch of `bytes` bytes from p (one hint per 64-byte line).  The camera's CPU runs with its hardware data
 * prefetcher switched off (boot code, ACTLR.L1PCTL = 0), so loops that stream through the frames ask for the next row
 * themselves.  A hint only: no effect on any result. */
static inline void mf_pf(const void *p, int32_t bytes)
{
    const char *c = (const char *)p;
    int32_t i;
    for (i = 0; i < bytes; i += 64) __builtin_prefetch(c + i);
}

static int32_t ceil_div(int32_t a, int32_t b) { return (a + b - 1) / b; }
static int32_t iabs(int32_t a) { return a < 0 ? -a : a; }

/* ---- parallel jobs (struct mf_par, mf_core.h) ------------------------------------------------------------------ */

static int32_t par_threads(const struct mf_par *P)
{
    if (!P || !P->run || P->n <= 1) return 1;
    return P->n > MF_MAX_THREADS ? MF_MAX_THREADS : P->n;
}

static int32_t par_stopped(struct mf_par *P) { return P && __atomic_load_n(&P->stop, __ATOMIC_RELAXED); }
static void par_stop(struct mf_par *P) { if (P) __atomic_store_n(&P->stop, 1, __ATOMIC_RELAXED); }
static void par_mark(struct mf_par *P, int32_t stage) { if (P && P->mark) P->mark(P->par_ctx, stage); }

/* number of jobs for `items` units of work: 1 inline, else 16 per thread, at most one per item.  The threads take jobs as
 * they come free, so a thread that gets less CPU time takes fewer, and when the jobs run out the others wait at most for the
 * one small job each slow thread holds (camera run mf10: with 4 jobs per thread a starved worker held a twelfth of a pass) */
static int32_t par_jobs(const struct mf_par *P, int32_t items)
{
    int32_t n = par_threads(P), c = n > 1 ? 16 * n : 1;
    if (items < 1) return 1;
    return items < c ? items : c;
}

/* job i of `count` over `items`: [*a, *b) (items * count < 2^31) */
static void span(int32_t items, int32_t count, int32_t i, int32_t *a, int32_t *b)
{
    *a = items * i / count;
    *b = items * (i + 1) / count;
}

static void par_for(struct mf_par *P, mf_job job, void *arg, int32_t count)
{
    int32_t i;
    if (count < 1) return;
    if (par_threads(P) > 1 && count > 1) P->run(P->par_ctx, job, arg, count);
    else for (i = 0; i < count; i++) job(arg, i, 0);
}

#ifdef MF_NEON
static inline int32_t hsum_s32(int32x4_t v)
{
    int32x2_t t = vadd_s32(vget_low_s32(v), vget_high_s32(v));
    return vget_lane_s32(vpadd_s32(t, t), 0);
}
static inline uint32_t hsum_u32(uint32x4_t v)
{
    uint32x2_t t = vadd_u32(vget_low_u32(v), vget_high_u32(v));
    return vget_lane_u32(vpadd_u32(t, t), 0);
}
#endif

/* ---- gray / pyramid ----------------------------------------------------------------------- */

/* gray row (sum of each 2x2 block) of the Bayer row pair r0, r1 */
static void gray_row(const uint16_t *r0, const uint16_t *r1, int32_t w2, int32_t *g)
{
    int32_t x = 0;
#ifdef MF_NEON
    for (; x + 8 <= w2; x += 8) {
        uint16x8x2_t a = vld2q_u16(r0 + 2 * x), b = vld2q_u16(r1 + 2 * x);
        uint32x4_t lo = vaddq_u32(vaddl_u16(vget_low_u16(a.val[0]), vget_low_u16(a.val[1])),
                                  vaddl_u16(vget_low_u16(b.val[0]), vget_low_u16(b.val[1])));
        uint32x4_t hi = vaddq_u32(vaddl_u16(vget_high_u16(a.val[0]), vget_high_u16(a.val[1])),
                                  vaddl_u16(vget_high_u16(b.val[0]), vget_high_u16(b.val[1])));
        vst1q_s32(g + x, vreinterpretq_s32_u32(lo));
        vst1q_s32(g + x + 4, vreinterpretq_s32_u32(hi));
    }
#endif
    for (; x < w2; x++)
        g[x] = (int32_t)r0[2 * x] + r0[2 * x + 1] + r1[2 * x] + r1[2 * x + 1];
}

int32_t mf_gray2(const uint16_t *cfa, int32_t h, int32_t w, int32_t stride, int32_t *out)
{
    int32_t y, h2 = h / 2, w2 = w / 2;
    if (h < 2 || w < 2 || (h & 1) || (w & 1) || stride < w)
        return MF_ERR_ARG;
    for (y = 0; y < h2; y++) {
        const uint16_t *r0 = cfa + (int32_t)(2 * y) * stride;
        if (y + 1 < h2) mf_pf(r0 + 2 * stride, 4 * stride);
        gray_row(r0, r0 + stride, w2, out + y * w2);
    }
    return MF_OK;
}

/* output rows y0 .. y1-1 of mf_down (arguments checked by the caller) */
static MF_NOINLINE void down_rows(const int32_t *src, int32_t h, int32_t w, int32_t k, int32_t *dst, int32_t y0, int32_t y1)
{
    int32_t sh = 0, hh, ww, y, x, j, i;
    while ((1 << sh) < k)
        sh++;
    sh *= 2;                                     /* k*k = 1 << sh */
    hh = h / k;
    ww = w / k;
    for (y = y0; y < y1; y++) {
        const int32_t *r = src + y * k * w;
        int32_t *o = dst + y * ww;
        if (y + 1 < hh) mf_pf(r + k * w, 4 * k * w);
        x = 0;
#ifdef MF_NEON
        if (k == 2) {
            for (; x + 4 <= ww; x += 4) {
                int32x4x2_t a = vld2q_s32(r + 2 * x), b = vld2q_s32(r + w + 2 * x);
                int32x4_t s = vaddq_s32(vaddq_s32(a.val[0], a.val[1]), vaddq_s32(b.val[0], b.val[1]));
                vst1q_s32(o + x, vrshrq_n_s32(s, 2));
            }
        } else if (k == 4) {
            for (; x + 4 <= ww; x += 4) {
                int32x4_t s = vdupq_n_s32(0);
                for (j = 0; j < 4; j++) {
                    int32x4x4_t a = vld4q_s32(r + j * w + 4 * x);
                    s = vaddq_s32(s, vaddq_s32(vaddq_s32(a.val[0], a.val[1]), vaddq_s32(a.val[2], a.val[3])));
                }
                vst1q_s32(o + x, vrshrq_n_s32(s, 4));
            }
        }
#endif
        for (; x < ww; x++) {
            int32_t s = 0;
            for (j = 0; j < k; j++) {
                const int32_t *rr = r + j * w + x * k;
                for (i = 0; i < k; i++)
                    s += rr[i];
            }
            o[x] = (s + ((1 << sh) >> 1)) >> sh;
        }
    }
}

int32_t mf_down(const int32_t *src, int32_t h, int32_t w, int32_t k, int32_t *dst)
{
    if (k < 1 || k > 64 || (k & (k - 1)))
        return MF_ERR_ARG;
    if (h / k < 1 || w / k < 1)
        return MF_ERR_ARG;
    down_rows(src, h, w, k, dst, 0, h / k);
    return MF_OK;
}

struct down_arg { const int32_t *src; int32_t h, w, k, *dst, count; struct mf_par *P; };

static void down_job(void *p, int32_t i, int32_t slot)
{
    const struct down_arg *A = (const struct down_arg *)p;
    int32_t a, b;
    (void)slot;
    if (par_stopped(A->P)) return;
    span(A->h / A->k, A->count, i, &a, &b);
    down_rows(A->src, A->h, A->w, A->k, A->dst, a, b);
}

/* mf_down in row bands (valid arguments) */
static void par_down(struct mf_par *P, const int32_t *src, int32_t h, int32_t w, int32_t k, int32_t *dst)
{
    struct down_arg A;
    A.src = src; A.h = h; A.w = w; A.k = k; A.dst = dst; A.P = P; A.count = par_jobs(P, h / k);
    par_for(P, down_job, &A, A.count);
}

int32_t mf_level_dims(int32_t h, int32_t w, int32_t lv, int32_t *oh, int32_t *ow)
{
    int32_t l;
    /* LEVEL_FACTORS (1, 2, 4, 4) */
    if (lv < 0 || lv >= MF_NLEVELS)
        return MF_ERR_ARG;
    for (l = 1; l <= lv; l++) {
        int32_t f = (l == 1) ? 2 : 4;
        h /= f;
        w /= f;
    }
    if (h < 1 || w < 1)
        return MF_ERR_ARG;
    *oh = h;
    *ow = w;
    return MF_OK;
}

int32_t mf_pyramid(const int32_t *g0, int32_t h, int32_t w, int32_t *l1, int32_t *l2, int32_t *l3)
{
    int32_t r, h1, w1, h2, w2, h3, w3;
    if ((r = mf_level_dims(h, w, 3, &h3, &w3)) < 0)
        return r;
    mf_level_dims(h, w, 1, &h1, &w1);
    mf_level_dims(h, w, 2, &h2, &w2);
    (void)h3; (void)w3;
    if ((r = mf_down(g0, h, w, 2, l1)) < 0)
        return r;
    if ((r = mf_down(l1, h1, w1, 4, l2)) < 0)
        return r;
    return mf_down(l2, h2, w2, 4, l3);
}

/* sum of the tile x tile block (by, bx) of g (h x w), partial blocks mirror-filled (as mf_block_means) */
static int32_t blk_sum(const int32_t *g, int32_t h, int32_t w, int32_t tile, int32_t by, int32_t bx)
{
    int32_t s = 0, i, j;
    for (i = 0; i < tile; i++) {
        const int32_t *r = g + refl(by * tile + i, h) * w;
        for (j = 0; j < tile; j++)
            s += r[refl(bx * tile + j, w)];
    }
    return s;
}

/* level-1 row (2x2 mean of the gray rows ga, gb, round half up), w1 values.  With tacc: adds the sum of the 8 level-1
 * cells' 2x2 gray sums (= the 16x16 gray tile's row pair) of each of the nft full tiles to tacc[tx]. */
static void l1_row(const int32_t *ga, const int32_t *gb, int32_t w1, int32_t *o, int32_t *tacc, int32_t nft)
{
    int32_t i = 0;
#ifdef MF_NEON
    for (; i + 8 <= w1; i += 8) {
        int32x4x2_t a0 = vld2q_s32(ga + 2 * i), a1 = vld2q_s32(ga + 2 * i + 8);
        int32x4x2_t b0 = vld2q_s32(gb + 2 * i), b1 = vld2q_s32(gb + 2 * i + 8);
        int32x4_t p0 = vaddq_s32(vaddq_s32(a0.val[0], a0.val[1]), vaddq_s32(b0.val[0], b0.val[1]));
        int32x4_t p1 = vaddq_s32(vaddq_s32(a1.val[0], a1.val[1]), vaddq_s32(b1.val[0], b1.val[1]));
        vst1q_s32(o + i, vrshrq_n_s32(p0, 2));
        vst1q_s32(o + i + 4, vrshrq_n_s32(p1, 2));
        if (tacc && (i >> 3) < nft) tacc[i >> 3] += hsum_s32(vaddq_s32(p0, p1));
    }
#endif
    for (; i < w1; i++) {
        int32_t p = ga[2 * i] + ga[2 * i + 1] + gb[2 * i] + gb[2 * i + 1];
        o[i] = (p + 2) >> 2;
        if (tacc && (i >> 3) < nft) tacc[i >> 3] += p;
    }
}

/* gray_pass in pieces: level-1 rows j0 .. j1-1 (j0 a multiple of 8, so tile rows are not split), then the tail */
static MF_NOINLINE void gray_rows(const uint16_t *cfa, int32_t h, int32_t w, int32_t stride, int32_t *g0, int32_t *l1, int32_t *tsum,
                      int32_t *tacc, int32_t j0, int32_t j1)
{
    int32_t h2 = h / 2, w2 = w / 2, w1 = w2 / 2, j, tx;
    int32_t nft = w2 / 16, nfy = h2 / 16, ntx = ceil_div(w2, 16);
    for (j = j0; j < j1; j++) {
        int32_t *ga = g0 + 2 * j * w2, *gb = ga + w2;
        const uint16_t *r = cfa + 4 * j * stride;
        if (2 * j + 2 < h2) mf_pf(r + 4 * stride, 8 * stride);
        gray_row(r, r + stride, w2, ga);
        gray_row(r + 2 * stride, r + 3 * stride, w2, gb);
        if (tsum && j / 8 < nfy) {
            if (j % 8 == 0) for (tx = 0; tx < nft; tx++) tacc[tx] = 0;
            l1_row(ga, gb, w1, l1 + j * w1, tacc, nft);
            if (j % 8 == 7) for (tx = 0; tx < nft; tx++) tsum[(j / 8) * ntx + tx] = tacc[tx];
        } else
            l1_row(ga, gb, w1, l1 + j * w1, 0, 0);
    }
}

static void gray_tail(const uint16_t *cfa, int32_t h, int32_t w, int32_t stride, int32_t *g0, int32_t *tsum)
{
    int32_t h2 = h / 2, w2 = w / 2, h1 = h2 / 2, tx, ty;
    int32_t nft = w2 / 16, nfy = h2 / 16, ntx = ceil_div(w2, 16), nty = ceil_div(h2, 16);
    if (h2 & 1) gray_row(cfa + 4 * h1 * stride, cfa + (4 * h1 + 1) * stride, w2, g0 + 2 * h1 * w2);
    if (tsum)                                    /* partial (mirror-filled) tiles */
        for (ty = 0; ty < nty; ty++)
            for (tx = 0; tx < ntx; tx++)
                if (ty >= nfy || tx >= nft) tsum[ty * ntx + tx] = blk_sum(g0, h2, w2, 16, ty, tx);
}

struct gray_arg { const uint16_t *cfa; int32_t h, w, stride, *g0, *l1, *tsum, *tacc, ntx, count; struct mf_par *P; };

static void gray_job(void *p, int32_t i, int32_t slot)
{
    const struct gray_arg *A = (const struct gray_arg *)p;
    int32_t h1 = A->h / 4, a, b;
    if (par_stopped(A->P)) return;
    span(ceil_div(h1, 8), A->count, i, &a, &b);
    gray_rows(A->cfa, A->h, A->w, A->stride, A->g0, A->l1, A->tsum, A->tacc ? A->tacc + slot * A->ntx : 0, 8 * a, 8 * b < h1 ? 8 * b : h1);
}

/* One pass over a Bayer frame: gray g0 (h/2 x w/2), level 1 (= mf_down(g0, 2)) and, with tsum, the 16x16 tile sums of
 * g0 (mf_block_means' sums, ceil(h/32) x ceil(w/32) tiles; tacc: ceil(w/32) words of scratch per thread), in row bands. */
static void gray_pass(struct mf_par *P, const uint16_t *cfa, int32_t h, int32_t w, int32_t stride, int32_t *g0, int32_t *l1,
                      int32_t *tsum, int32_t *tacc)
{
    struct gray_arg A;
    A.cfa = cfa; A.h = h; A.w = w; A.stride = stride; A.g0 = g0; A.l1 = l1; A.tsum = tsum; A.tacc = tsum ? tacc : 0;
    A.ntx = ceil_div(w / 2, 16); A.P = P; A.count = par_jobs(P, ceil_div(h / 4, 8));
    par_for(P, gray_job, &A, A.count);
    gray_tail(cfa, h, w, stride, g0, tsum);
}

/* ---- alignment pieces --------------------------------------------------------------------- */

/* L1 distance of n rows of `tile` values, rows w apart (a: reference, b: alternate) */
static inline int32_t sad_rows(const int32_t *a, const int32_t *b, int32_t w, int32_t tile, int32_t n)
{
    int32_t i, j, cost = 0;
#ifdef MF_NEON
    if (tile == 16) {
        int32x4_t s0 = vdupq_n_s32(0), s1 = s0;
        for (i = 0; i < n; i++, a += w, b += w) {
            s0 = vabaq_s32(s0, vld1q_s32(a), vld1q_s32(b));
            s1 = vabaq_s32(s1, vld1q_s32(a + 4), vld1q_s32(b + 4));
            s0 = vabaq_s32(s0, vld1q_s32(a + 8), vld1q_s32(b + 8));
            s1 = vabaq_s32(s1, vld1q_s32(a + 12), vld1q_s32(b + 12));
        }
        return hsum_s32(vaddq_s32(s0, s1));
    }
    if (tile == 8) {
        int32x4_t s0 = vdupq_n_s32(0), s1 = s0;
        for (i = 0; i < n; i++, a += w, b += w) {
            s0 = vabaq_s32(s0, vld1q_s32(a), vld1q_s32(b));
            s1 = vabaq_s32(s1, vld1q_s32(a + 4), vld1q_s32(b + 4));
        }
        return hsum_s32(vaddq_s32(s0, s1));
    }
#endif
    for (i = 0; i < n; i++, a += w, b += w)
        for (j = 0; j < tile; j++)
            cost += iabs(a[j] - b[j]);
    return cost;
}

int32_t mf_tile_cost(const int32_t *ref, const int32_t *alt, int32_t h, int32_t w, int32_t tile,
                     int32_t y0, int32_t x0, int32_t oy, int32_t ox)
{
    int32_t i, j, cost = 0;
    int32_t ry1 = y0 + tile - 1, rx1 = x0 + tile - 1;
    int32_t cin = x0 >= 0 && rx1 < w && x0 + ox >= 0 && rx1 + ox < w;
    /* inside fast path: every index of ref and alt lies in the image */
    if (cin && y0 >= 0 && ry1 < h && y0 + oy >= 0 && ry1 + oy < h)
        return sad_rows(ref + y0 * w + x0, alt + (y0 + oy) * w + x0 + ox, w, tile, tile);
    if (cin) {                                   /* only rows mirrored */
        for (i = 0; i < tile; i++)
            cost += sad_rows(ref + refl(y0 + i, h) * w + x0, alt + refl(y0 + i + oy, h) * w + x0 + ox, w, tile, 1);
        return cost;
    }
    if (tile <= 16) {                            /* mirrored columns once per tile, not per pixel */
        int32_t ca[16], cb[16];
        for (j = 0; j < tile; j++) { ca[j] = refl(x0 + j, w); cb[j] = refl(x0 + j + ox, w); }
        for (i = 0; i < tile; i++) {
            const int32_t *a = ref + refl(y0 + i, h) * w, *b = alt + refl(y0 + i + oy, h) * w;
            for (j = 0; j < tile; j++) cost += iabs(a[ca[j]] - b[cb[j]]);
        }
        return cost;
    }
    for (i = 0; i < tile; i++) {
        int32_t ra = mf_reflect(y0 + i, h) * w, rb = mf_reflect(y0 + i + oy, h) * w;
        for (j = 0; j < tile; j++)
            cost += iabs(ref[ra + mf_reflect(x0 + j, w)] - alt[rb + mf_reflect(x0 + j + ox, w)]);
    }
    return cost;
}

int32_t mf_block_means(const int32_t *g0, int32_t h, int32_t w, int32_t tile, int32_t *out)
{
    int32_t ny, nx, by, bx, div;
    if (h < 1 || w < 1 || tile < 1 || tile > 64)
        return MF_ERR_ARG;
    ny = (h + tile - 1) / tile;
    nx = (w + tile - 1) / tile;
    div = tile * tile * 4;
    for (by = 0; by < ny; by++)
        for (bx = 0; bx < nx; bx++)
            out[by * nx + bx] = blk_sum(g0, h, w, tile, by, bx) / div;   /* s >= 0: floor */
    return MF_OK;
}

int32_t mf_tile_noise(int32_t mean_pix, int32_t black, const int32_t *ntab, int32_t nshift)
{
    int32_t x = mean_pix - black;
    if (x < 0)
        x = 0;
    x >>= nshift;
    if (x > MF_NOISE_BINS - 1)
        x = MF_NOISE_BINS - 1;
    return ntab[x];
}

int32_t mf_tile_noise_n(const int32_t *mean_pix, int32_t n, int32_t black, const int32_t *ntab,
                        int32_t nshift, int32_t *out)
{
    int32_t i;
    for (i = 0; i < n; i++)
        out[i] = mf_tile_noise(mean_pix[i], black, ntab, nshift);
    return MF_OK;
}

int32_t mf_imedian_hist_size(int32_t bound) { return 2 * bound + 1; }

int32_t mf_imedian(const int32_t *v, int32_t n, int32_t bound, int32_t *hist)
{
    int32_t i, k, acc = 0, nb;
    if (n < 1 || bound < 1 || bound > 1024)
        return INT32_MIN;
    nb = 2 * bound + 1;
    for (i = 0; i < nb; i++)
        hist[i] = 0;
    for (i = 0; i < n; i++) {
        if (v[i] < -bound || v[i] > bound)
            return INT32_MIN;
        hist[v[i] + bound]++;
    }
    k = (n - 1) / 2;                            /* index of the lower middle element */
    for (i = 0; i < nb; i++) {
        acc += hist[i];
        if (acc > k)
            return i - bound;
    }
    return INT32_MIN;                           /* not reached */
}

/* ---- alignment (ref.align_pair) ------------------------------------------------------------ */

/* per-level parameters of ref.py (LEVEL_FACTORS, LEVEL_TILES, LEVEL_RADII), as code: no data tables */
static int32_t lv_tile(int32_t l) { return l == 3 ? 8 : 16; }
static int32_t lv_rad(int32_t l) { return l == 0 ? 1 : (l == 1 ? 2 : 4); }
static int32_t lv_factor(int32_t l) { return l == 0 ? 1 : (l == 1 ? 2 : 4); }   /* relative to level l-1 */
static int32_t lv_scale(int32_t l) { return l == 0 ? 1 : (l == 1 ? 2 : (l == 2 ? 8 : 32)); }
static int32_t lv_lim(int32_t l) { int32_t s = lv_scale(l); return (MF_MAX_OFFSET + s - 1) / s; }
static int32_t clampi(int32_t v, int32_t lo, int32_t hi) { return v < lo ? lo : (v > hi ? hi : v); }

#define MF_GLOBAL_MARGIN 36    /* GLOBAL_MARGIN_Q8 */
#define MF_RATIO_LO_Q8   384   /* RATIO_LO_Q8 */
#define MF_MAX_STARTS    4     /* 3 upsampled (+ global at level 0); ref.py v10: no coarse-median start */

/* L1 costs of the 16x16 tile at rp (reference, rows rs apart) against the alternate at ap + j (rows as apart), j = 0 .. k-1
 * (k 1..5): out[j].  Each reference row is loaded once for the k positions (speed only: the sums are mf_tile_cost's). */
__attribute__((always_inline)) static inline void sad16_k(const int32_t *rp, int32_t rs, const int32_t *ap, int32_t as, int32_t k,
                                                          int32_t *out)
{
    int32_t i, j;
#ifdef MF_NEON
    int32x4_t s0 = vdupq_n_s32(0), s1 = s0, s2 = s0, s3 = s0, s4 = s0;
    for (i = 0; i < 16; i++, rp += rs, ap += as) {
        int32x4_t r;
        for (j = 0; j < 4; j++) {
            r = vld1q_s32(rp + 4 * j);
            s0 = vabaq_s32(s0, r, vld1q_s32(ap + 4 * j));
            if (k > 1) s1 = vabaq_s32(s1, r, vld1q_s32(ap + 4 * j + 1));
            if (k > 2) s2 = vabaq_s32(s2, r, vld1q_s32(ap + 4 * j + 2));
            if (k > 3) s3 = vabaq_s32(s3, r, vld1q_s32(ap + 4 * j + 3));
            if (k > 4) s4 = vabaq_s32(s4, r, vld1q_s32(ap + 4 * j + 4));
        }
    }
    out[0] = hsum_s32(s0);
    if (k > 1) out[1] = hsum_s32(s1);
    if (k > 2) out[2] = hsum_s32(s2);
    if (k > 3) out[3] = hsum_s32(s3);
    if (k > 4) out[4] = hsum_s32(s4);
#else
    for (j = 0; j < k; j++) out[j] = 0;
    for (i = 0; i < 16; i++, rp += rs, ap += as)
        for (j = 0; j < k; j++) {
            int32_t x, c = 0;
            for (x = 0; x < 16; x++) c += iabs(rp[x] - ap[x + j]);
            out[j] += c;
        }
#endif
}

/* costs of the 16x16 tile at rp (rows rs apart) against the alternate block at ap (rows as apart) shifted by (a, b),
 * a, b = 0 .. n-1 (n <= 9): c[a * n + b] */
static MF_NOINLINE void win16(const int32_t *rp, int32_t rs, const int32_t *ap, int32_t as, int32_t n, int32_t *c)
{
    int32_t a, b;
    for (a = 0; a < n; a++, ap += as)
        for (b = 0; b < n; b += 5) {
            int32_t k = n - b < 5 ? n - b : 5;
            switch (k) {                       /* constant k: unrolled bodies */
            case 1: sad16_k(rp, rs, ap + b, as, 1, c + a * n + b); break;
            case 2: sad16_k(rp, rs, ap + b, as, 2, c + a * n + b); break;
            case 3: sad16_k(rp, rs, ap + b, as, 3, c + a * n + b); break;
            case 4: sad16_k(rp, rs, ap + b, as, 4, c + a * n + b); break;
            default: sad16_k(rp, rs, ap + b, as, 5, c + a * n + b); break;
            }
        }
}

#define MF_GATHER_WORDS (256 + 24 * 24 + 84)   /* search_tile's buffer: a 16x16 reference tile, a (16 + 2 * 4)^2 alternate block,
                                                * the 9x9 costs of a window (kept off the stack: the back-end task's stack is small) */

/* rows y .. y+nr-1, columns x .. x+nc-1 of img (h x w), mirrored as mf_tile_cost (refl), into out (nc per row) */
static void gather(const int32_t *img, int32_t h, int32_t w, int32_t y, int32_t x, int32_t nr, int32_t nc, int32_t *out)
{
    int32_t i, j, cx[24];
    for (j = 0; j < nc; j++) cx[j] = refl(x + j, w);
    for (i = 0; i < nr; i++, out += nc) {
        const int32_t *r = img + refl(y + i, h) * w;
        for (j = 0; j < nc; j++) out[j] = r[cx[j]];
    }
}

/* ref._search for one tile: best offset over the union of (2*rad+1)^2 neighbourhoods of the starts.
 * A start equal to an earlier start is skipped, but the scan index still advances as in ref.py.
 * Key (cost, |dy|+|dx|, scan index), lexicographic, strictly smaller wins.
 * Speed (16x16 tiles, rad <= 4): the (2 rad + 1)^2 costs of a start come from win16 at once, on the frames themselves where the
 * tile and the start's whole window lie inside both images, else on mirrored copies of the tile and of the window's block
 * (the values mf_tile_cost reads); the copies and the costs live in gb (MF_GATHER_WORDS of the caller's).  A clamped offset is a position of the same
 * window (|start| <= lim), so its cost is looked up there.  Such a window is then decided at once: keys are unique (scan
 * index), so the sequential "strictly smaller wins" keeps the smallest key of all positions; the window's smallest key is its
 * smallest cost, then |dy|+|dx|, then scan index, and it replaces the best so far if smaller.  Without gb: mf_tile_cost per
 * position, sequentially.  Same costs, same smallest key: results unchanged. */
static void search_tile(const int32_t *ref, const int32_t *alt, int32_t h, int32_t w, int32_t tile,
                        int32_t y0, int32_t x0, const int32_t *sy, const int32_t *sx, int32_t nst,
                        int32_t rad, int32_t lim, int32_t *gb, int32_t *by, int32_t *bx, int32_t *bc)
{
    int32_t have = 0, bk_c = 0, bk_d = 0, bk_i = 0, idx = 0, s, t, dy, dx, n = 2 * rad + 1, rs = w, fast;
    int32_t *cw = gb ? gb + 256 + 24 * 24 : 0;
    const int32_t *rp = 0;
    fast = gb && tile == 16 && rad >= 0 && rad <= 4;
    if (fast) {
        if (y0 >= 0 && y0 + 16 <= h && x0 >= 0 && x0 + 16 <= w) rp = ref + y0 * w + x0;
        else { gather(ref, h, w, y0, x0, 16, 16, gb); rp = gb; rs = 16; }
    }
    for (s = 0; s < nst; s++) {
        int32_t dup = 0, win = 0, oy0 = sy[s] - rad, ox0 = sx[s] - rad;
        for (t = 0; t < s; t++)
            if (sy[t] == sy[s] && sx[t] == sx[s]) dup = 1;
        if (dup) { idx += n * n; continue; }
        if (fast && sy[s] >= -lim && sy[s] <= lim && sx[s] >= -lim && sx[s] <= lim) {
            int32_t m = 15 + n;
            if (y0 + oy0 >= 0 && y0 + oy0 + m <= h && x0 + ox0 >= 0 && x0 + ox0 + m <= w) {
                win16(rp, rs, alt + (y0 + oy0) * w + x0 + ox0, w, n, cw); win = 1;
            } else {
                gather(alt, h, w, y0 + oy0, x0 + ox0, m, m, gb + 256);
                win16(rp, rs, gb + 256, m, n, cw); win = 1;
            }
        }
        if (win) {
            int32_t cm, a, b, wa = 0, wb = 0, wd = 0, cl = oy0 < -lim || oy0 + n - 1 > lim || ox0 < -lim || ox0 + n - 1 > lim;
            /* the cost of window position (a, b): clamped offsets read their clamped position's cost */
#define MF_CW(a, b) (cl ? cw[(clampi(oy0 + (a), -lim, lim) - oy0) * n + clampi(ox0 + (b), -lim, lim) - ox0] : cw[(a) * n + (b)])
            cm = MF_CW(0, 0);
            for (a = 0; a < n; a++)
                for (b = 0; b < n; b++) cm = MF_CW(a, b) < cm ? MF_CW(a, b) : cm;
            if (!have || cm <= bk_c) {
                wd = 1 << 30;
                for (a = 0; a < n; a++)                          /* smallest |dy|+|dx| among the cheapest, first in scan order */
                    for (b = 0; b < n; b++)
                        if (MF_CW(a, b) == cm) {
                            int32_t d = iabs(a - rad) + iabs(b - rad);
                            if (d < wd) { wd = d; wa = a; wb = b; }
                        }
                if (!have || cm < bk_c || wd < bk_d) {           /* (equal cost and |d|: an earlier window's index is smaller) */
                    have = 1; bk_c = cm; bk_d = wd; bk_i = idx + wa * n + wb;
                    *by = clampi(oy0 + wa, -lim, lim); *bx = clampi(ox0 + wb, -lim, lim); *bc = cm;
                }
            }
#undef MF_CW
            idx += n * n;
            continue;
        }
        for (dy = -rad; dy <= rad; dy++)
            for (dx = -rad; dx <= rad; dx++, idx++) {
                int32_t oy, ox, c, d;
                oy = clampi(sy[s] + dy, -lim, lim);
                ox = clampi(sx[s] + dx, -lim, lim);
                c = mf_tile_cost(ref, alt, h, w, tile, y0, x0, oy, ox);
                d = (dy < 0 ? -dy : dy) + (dx < 0 ? -dx : dx);
                if (!have || c < bk_c || (c == bk_c && (d < bk_d || (d == bk_d && idx < bk_i)))) {
                    have = 1; bk_c = c; bk_d = d; bk_i = idx;
                    *by = oy; *bx = ox; *bc = c;
                }
            }
    }
}

/* ref._coarse_map for one coordinate: nearest and next-nearest coarse tile */
static void coarse_map(int32_t c, int32_t f, int32_t ptile, int32_t pn, int32_t *near, int32_t *other)
{
    int32_t span = f * ptile, j = c / span, rem = c - j * span;   /* c >= 0 */
    int32_t o = (2 * rem < span) ? j - 1 : j + 1;
    *near = clampi(j, 0, pn - 1);
    *other = clampi(o, 0, pn - 1);
}

/* ref._upsampled_starts for the tile with origin (y0, x0): the 3 upsampled candidates (v10: no coarse median) */
static int32_t upsampled_starts(const int32_t *py, const int32_t *px, int32_t pny, int32_t pnx, int32_t ptile,
                                int32_t f, int32_t y0, int32_t x0, int32_t tile, int32_t lim, int32_t *sy, int32_t *sx)
{
    int32_t ny_, oy_, nx_, ox_;
    coarse_map(y0 + tile / 2, f, ptile, pny, &ny_, &oy_);
    coarse_map(x0 + tile / 2, f, ptile, pnx, &nx_, &ox_);
    sy[0] = clampi(py[ny_ * pnx + nx_] * f, -lim, lim); sx[0] = clampi(px[ny_ * pnx + nx_] * f, -lim, lim);
    sy[1] = clampi(py[ny_ * pnx + ox_] * f, -lim, lim); sx[1] = clampi(px[ny_ * pnx + ox_] * f, -lim, lim);
    sy[2] = clampi(py[oy_ * pnx + nx_] * f, -lim, lim); sx[2] = clampi(px[oy_ * pnx + nx_] * f, -lim, lim);
    return 3;
}

/* scratch for mf_align_pair: per-level offsets of levels 3..1 (2 int32 per tile) + median histogram */
int32_t mf_align_scratch_size(int32_t h0, int32_t w0)
{
    int32_t l, h, w, n = 0;
    for (l = 1; l < MF_NLEVELS; l++) {
        if (mf_level_dims(h0, w0, l, &h, &w) < 0) return MF_ERR_ARG;
        n += 2 * ceil_div(h, lv_tile(l)) * ceil_div(w, lv_tile(l));
    }
    n += mf_imedian_hist_size(lv_lim(1));
    return n * (int32_t)sizeof(int32_t);
}

#ifndef MF_NEON
/* L1 cost and alternate sum of a 16-pixel row segment (plain C kernels) */
static inline void sad_sum16(const int32_t *a, const int32_t *b, int32_t *c, int32_t *s)
{
    int32_t j, cc = 0, ss = 0;
    for (j = 0; j < 16; j++) { cc += iabs(a[j] - b[j]); ss += b[j]; }
    *c += cc;
    if (s) *s += ss;
}

/* sum of 16 values */
static inline int32_t sum16(const int32_t *b)
{
    int32_t j, s = 0;
    for (j = 0; j < 16; j++) s += b[j];
    return s;
}
#endif

/* L1 cost (added to *c) and alternate sum (added to *s, if s) of the 16x16 tile at a / b, rows w apart (= 16 rows of sad_sum16) */
#define MF_PF_TILES 2
static inline void sad_sum_tile(const int32_t *a, const int32_t *b, int32_t w, int32_t *c, int32_t *s)
{
    int32_t i;
#ifdef MF_NEON
    int32x4_t d0 = vdupq_n_s32(0), d1 = d0, t0 = d0, t1 = d0;
    for (i = 0; i < 16; i++, a += w, b += w) {
        int32x4_t b0 = vld1q_s32(b), b1 = vld1q_s32(b + 4), b2 = vld1q_s32(b + 8), b3 = vld1q_s32(b + 12);
        d0 = vabaq_s32(d0, vld1q_s32(a), b0);
        d1 = vabaq_s32(d1, vld1q_s32(a + 4), b1);
        d0 = vabaq_s32(d0, vld1q_s32(a + 8), b2);
        d1 = vabaq_s32(d1, vld1q_s32(a + 12), b3);
        t0 = vaddq_s32(t0, vaddq_s32(b0, b1));
        t1 = vaddq_s32(t1, vaddq_s32(b2, b3));
    }
    *c += hsum_s32(vaddq_s32(d0, d1));
    if (s) *s += hsum_s32(vaddq_s32(t0, t1));
#else
    for (i = 0; i < 16; i++, a += w, b += w) sad_sum16(a, b, c, s);
#endif
}

/* sum of the 16x16 tile at b (rows w apart; < 2^31 for gray values, 256 * 262140 < 2^27) */
static inline int32_t sum_tile(const int32_t *b, int32_t w)
{
    int32_t i;
#ifdef MF_NEON
    int32x4_t t0 = vdupq_n_s32(0), t1 = t0;
    for (i = 0; i < 16; i++, b += w) {
        t0 = vaddq_s32(t0, vaddq_s32(vld1q_s32(b), vld1q_s32(b + 4)));
        t1 = vaddq_s32(t1, vaddq_s32(vld1q_s32(b + 8), vld1q_s32(b + 12)));
    }
    return hsum_s32(vaddq_s32(t0, t1));
#else
    int32_t t = 0;
    for (i = 0; i < 16; i++, b += w) t += sum16(b);
    return t;
#endif
}

/* level-0 cost of every 16x16 tile of tile rows ty0 .. ty1-1 at the offset (gy, gx) into cg; tiles inside the image (both
 * frames) row by row (streaming), the others with mf_tile_cost.  sag (optional): alternate sum of the inside tiles, -1 for
 * the others. */
static MF_NOINLINE void lv0_costs(const int32_t *ref, const int32_t *alt, int32_t h0, int32_t w0, int32_t gy, int32_t gx, int32_t *cg,
                      int32_t *sag, int32_t ty0, int32_t ty1)
{
    int32_t nx = ceil_div(w0, 16), ty, tx, i, txa, txb, rhs;
    txa = gx < 0 ? ceil_div(-gx, 16) : 0;
    rhs = w0 - 16 - (gx > 0 ? gx : 0);
    txb = rhs < 0 ? 0 : rhs / 16 + 1;
    if (txb > nx) txb = nx;
    if (txa > txb) txa = txb;
    for (ty = ty0; ty < ty1; ty++) {
        int32_t y0 = ty * 16, a0 = txa, b0 = txb, *c = cg + ty * nx, *s = sag ? sag + ty * nx : 0;
        if (!(y0 + 16 <= h0 && y0 + gy >= 0 && y0 + 15 + gy < h0)) a0 = b0 = 0;
        for (tx = a0; tx < b0; tx++) { c[tx] = 0; if (s) s[tx] = 0; }
        for (tx = a0; tx < b0; tx++) {         /* tile by tile, the sums kept in registers; the tile MF_PF_TILES ahead asked for */
            const int32_t *R = ref + y0 * w0 + 16 * tx, *A = alt + (y0 + gy) * w0 + gx + 16 * tx;
            if (tx + MF_PF_TILES < b0)
                for (i = 0; i < 16; i++) { __builtin_prefetch(R + i * w0 + 16 * MF_PF_TILES); __builtin_prefetch(A + i * w0 + 16 * MF_PF_TILES); }
            sad_sum_tile(R, A, w0, c + tx, s ? s + tx : 0);
        }
        for (tx = 0; tx < nx; tx++)
            if (tx < a0 || tx >= b0) {
                c[tx] = mf_tile_cost(ref, alt, h0, w0, 16, y0, tx * 16, gy, gx);
                if (s) s[tx] = -1;
            }
    }
}

/* the parallel steps of align_pair_int: one argument block, one job function per step */
struct al_arg {
    const int32_t *ref, *alt, *py, *px, *e0a;
    int32_t h, w, tile, rad, lim, ny, nx, pny, pnx, ptile, f, gmy, gmx, gy, gx, anysp, count;
    int32_t *fy, *fx, *sag;
    int64_t *tot;
    struct mf_par *P;
    int32_t *const *gb;                          /* per slot: MF_GATHER_WORDS for search_tile, or 0 (gb itself may be 0) */
};

/* levels 3..1: tile rows of one level */
static void al_level_job(void *p, int32_t i, int32_t slot)
{
    const struct al_arg *A = (const struct al_arg *)p;
    int32_t ty, tx, a, b, sy[MF_MAX_STARTS], sx[MF_MAX_STARTS];
    if (par_stopped(A->P)) return;
    span(A->ny, A->count, i, &a, &b);
    for (ty = a; ty < b; ty++)
        for (tx = 0; tx < A->nx; tx++) {
            int32_t nst, c, y0 = ty * A->tile, x0 = tx * A->tile;
            if (!A->py) { sy[0] = 0; sx[0] = 0; nst = 1; }
            else nst = upsampled_starts(A->py, A->px, A->pny, A->pnx, A->ptile, A->f, y0, x0, A->tile, A->lim,
                                        sy, sx);
            search_tile(A->ref, A->alt, A->h, A->w, A->tile, y0, x0, sy, sx, nst, A->rad, A->lim, A->gb ? A->gb[slot] : 0,
                        &A->fy[ty * A->nx + tx], &A->fx[ty * A->nx + tx], &c);
        }
}

/* level 0: total cost of global candidate k (dy = k / 3 - 1, dx = k % 3 - 1) */
static void al_global_job(void *p, int32_t k, int32_t slot)
{
    const struct al_arg *A = (const struct al_arg *)p;
    int32_t ty, tx, cy = clampi(A->gy + k / 3 - 1, -A->lim, A->lim), cx = clampi(A->gx + k % 3 - 1, -A->lim, A->lim);
    int64_t tot = 0;
    (void)slot;
    if (par_stopped(A->P)) return;
    if (A->anysp) {
        for (ty = 1; ty < A->ny; ty += 4)
            for (tx = 1; tx < A->nx; tx += 4)
                tot += mf_tile_cost(A->ref, A->alt, A->h, A->w, A->tile, ty * A->tile, tx * A->tile, cy, cx);
    } else
        for (ty = 0; ty < A->ny; ty++)
            for (tx = 0; tx < A->nx; tx++)
                tot += mf_tile_cost(A->ref, A->alt, A->h, A->w, A->tile, ty * A->tile, tx * A->tile, cy, cx);
    A->tot[k] = tot;
}

/* level 0: costs at the global offset (fx holds them until overwritten), tile rows */
static void al_cost_job(void *p, int32_t i, int32_t slot)
{
    const struct al_arg *A = (const struct al_arg *)p;
    int32_t a, b;
    (void)slot;
    if (par_stopped(A->P)) return;
    span(A->ny, A->count, i, &a, &b);
    lv0_costs(A->ref, A->alt, A->h, A->w, A->gy, A->gx, A->fx, A->sag, a, b);
}

/* level 0: per-tile refinement where the global offset is not good enough, tile rows */
static void al_refine_job(void *p, int32_t i, int32_t slot)
{
    const struct al_arg *A = (const struct al_arg *)p;
    int32_t ty, tx, a, b, sy[MF_MAX_STARTS], sx[MF_MAX_STARTS];
    if (par_stopped(A->P)) return;
    span(A->ny, A->count, i, &a, &b);
    for (ty = a; ty < b; ty++)
        for (tx = 0; tx < A->nx; tx++) {
            int32_t y0 = ty * A->tile, x0 = tx * A->tile, cg, t = ty * A->nx + tx;
            int64_t e0;
            cg = A->fx[t]; e0 = A->e0a[t];
            A->fy[t] = A->gy; A->fx[t] = A->gx;
            /* need = (cg*256)//e0 > RATIO_LO  <=>  cg*256 >= (RATIO_LO+1)*e0   (e0 >= 1) */
            if ((int64_t)cg * 256 >= (int64_t)(MF_RATIO_LO_Q8 + 1) * e0) {
                int32_t nst, by, bx, bc;
                nst = upsampled_starts(A->py, A->px, A->pny, A->pnx, A->ptile, A->f, y0, x0, A->tile, A->lim, sy, sx);
                sy[nst] = A->gy; sx[nst] = A->gx; nst++;
                search_tile(A->ref, A->alt, A->h, A->w, A->tile, y0, x0, sy, sx, nst, A->rad, A->lim, A->gb ? A->gb[slot] : 0, &by, &bx, &bc);
                if ((int64_t)bc + ((MF_GLOBAL_MARGIN * e0) >> 8) <= (int64_t)cg) { A->fy[t] = by; A->fx[t] = bx; }
            }
        }
}

/* ref.align_pair; the tile searches of each level, the 9 global candidates and the level-0 passes as jobs of P (0:
 * inline).  Returns MF_ERR_STOP if P was stopped meanwhile (outputs then incomplete). */
static int32_t align_pair_int(const int32_t *const ref_lv[MF_NLEVELS], const int32_t *const alt_lv[MF_NLEVELS],
                              int32_t h0, int32_t w0, const int32_t *e0a, int32_t *oy, int32_t *ox, int32_t g[2],
                              void *scratch, uint32_t scratch_bytes, int32_t *sag, int32_t *const *gb, struct mf_par *P)
{
    int32_t *sc = (int32_t *)scratch, *hist, *py = 0, *px = 0;
    int32_t pny = 0, pnx = 0, ptile = 0, gmy = 0, gmx = 0, l, need_bytes;
    struct al_arg A;
    need_bytes = mf_align_scratch_size(h0, w0);
    if (need_bytes < 0) return MF_ERR_ARG;
    if (scratch_bytes < (uint32_t)need_bytes) return MF_ERR_SCRATCH;
    hist = sc;
    sc += mf_imedian_hist_size(lv_lim(1));
    A.P = P; A.e0a = e0a; A.sag = sag; A.tot = 0; A.gy = A.gx = A.anysp = 0; A.gb = gb;
    /* levels 3..1 */
    for (l = MF_NLEVELS - 1; l >= 1; l--) {
        int32_t h, w, tile = lv_tile(l), ny, nx;
        int32_t *fy, *fx;
        mf_level_dims(h0, w0, l, &h, &w);
        ny = ceil_div(h, tile); nx = ceil_div(w, tile);
        fy = sc; fx = sc + ny * nx; sc += 2 * ny * nx;
        A.ref = ref_lv[l]; A.alt = alt_lv[l]; A.h = h; A.w = w; A.tile = tile; A.rad = lv_rad(l); A.lim = lv_lim(l);
        A.ny = ny; A.nx = nx; A.py = py; A.px = px; A.pny = pny; A.pnx = pnx; A.ptile = ptile;
        A.f = l + 1 < MF_NLEVELS ? lv_factor(l + 1) : 1; A.gmy = gmy; A.gmx = gmx; A.fy = fy; A.fx = fx;
        A.count = par_jobs(P, ny);
        if (l == MF_NLEVELS - 1) par_mark(P, MF_ST_COARSE);
        if (l == 1) par_mark(P, MF_ST_LEVEL1);
        par_for(P, al_level_job, &A, A.count);
        if (par_stopped(P)) return MF_ERR_STOP;
        py = fy; px = fx; pny = ny; pnx = nx; ptile = tile;
        if (l == 1) {                            /* level 1's median: the global offset's start (v10: the only median used) */
            gmy = mf_imedian(py, ny * nx, A.lim, hist);
            gmx = mf_imedian(px, ny * nx, A.lim, hist);
        }
    }
    /* level 0 */
    {
        int32_t tile = lv_tile(0), lim = MF_MAX_OFFSET, f = lv_factor(1);
        int32_t ny = ceil_div(h0, tile), nx = ceil_div(w0, tile), dy, dx, k = 0;
        int32_t g1y = gmy * f, g1x = gmx * f, gy = g1y, gx = g1x;
        int64_t btot = 0, tot[9];
        int32_t bd = 0, bk = 0, have = 0;
        A.ref = ref_lv[0]; A.alt = alt_lv[0]; A.h = h0; A.w = w0; A.tile = tile; A.rad = lv_rad(0); A.lim = lim;
        A.ny = ny; A.nx = nx; A.py = py; A.px = px; A.pny = pny; A.pnx = pnx; A.ptile = ptile; A.f = f; A.gmy = gmy; A.gmx = gmx;
        A.anysp = ny > 1 && nx > 1;              /* a tile with ty % 4 == 1 and tx % 4 == 1 exists */
        A.gy = g1y; A.gx = g1x; A.tot = tot;
        par_mark(P, MF_ST_LEVEL0);
        par_for(P, al_global_job, &A, 9);
        if (par_stopped(P)) return MF_ERR_STOP;
        for (dy = -1; dy <= 1; dy++)
            for (dx = -1; dx <= 1; dx++, k++) {
                int32_t cy = clampi(g1y + dy, -lim, lim), cx = clampi(g1x + dx, -lim, lim);
                int32_t d = (dy < 0 ? -dy : dy) + (dx < 0 ? -dx : dx);
                if (!have || tot[k] < btot || (tot[k] == btot && (d < bd || (d == bd && k < bk)))) {
                    have = 1; btot = tot[k]; bd = d; bk = k; gy = cy; gx = cx;
                }
            }
        g[0] = gy; g[1] = gx;
        A.gy = gy; A.gx = gx; A.fy = oy; A.fx = ox; A.count = par_jobs(P, ny);
        par_for(P, al_cost_job, &A, A.count);                       /* ox holds the costs until overwritten */
        if (par_stopped(P)) return MF_ERR_STOP;
        par_for(P, al_refine_job, &A, A.count);
        if (par_stopped(P)) return MF_ERR_STOP;
    }
    return MF_OK;
}

int32_t mf_align_pair(const int32_t *const ref_lv[MF_NLEVELS], const int32_t *const alt_lv[MF_NLEVELS],
                      int32_t h0, int32_t w0, const int32_t *e0a, int32_t *oy, int32_t *ox, int32_t g[2],
                      void *scratch, uint32_t scratch_bytes)
{
    return align_pair_int(ref_lv, alt_lv, h0, w0, e0a, oy, ox, g, scratch, scratch_bytes, 0, 0, 0);
}

/* ---- merge (ref.merge, v8) ---------------------------------------------------------- */

#define MF_W6_ONE   64
#define MF_PIX_LO   512    /* PIX_LO_Q8 */
#define MF_PIX_HI   800    /* PIX_HI_Q8 */
#define MF_BLK      8
#define MF_BLK_LO   845    /* BLK_LO_Q8 */
#define MF_BLK_HI   1280   /* BLK_HI_Q8 */
#define MF_RCP_BITS 24
#define MF_WP_RING  16     /* plane-weight rows kept per alternate (the pipeline needs rows y-1 .. y+8) */
#define MF_E_FAST   5000000  /* largest noise (x9) for which the NEON weight thresholds fit 32 bits */
/* cap of the weights' noise entries (v9: a separate weights table may hold large values).  Exactness of the cap: a 3x3 sum of
 * |D| is at most 9 * 2 * 65535 < 2^21 (G plane), so (S << 16) < 2^37 < (MF_PIX_LO + 1) * 2^28, and an 8x8 block's |sum of D|
 * is at most 64 * 2 * 65535 < 2^23, so (S << 13) < 2^36 < (MF_BLK_LO + 1) * 2^28: any noise >= 2^28 gives weight 64,
 * as the uncapped value does in ref.py. */
#define MF_E_CAP    ((int64_t)1 << 28)
#define MF_STRIP_ROWS 32   /* the stop callback and the stats count strips of 32 half-res rows */

/* min(floor(n / d), cap) for d >= 1, cap < 2048, without a division instruction or library call */
static uint32_t div_cap(uint64_t n, uint32_t d, uint32_t cap)
{
    uint32_t q = 0;
    int32_t b;
    if (n >= (uint64_t)cap * d) return cap;
    for (b = 10; b >= 0; b--) {
        uint32_t t = q | (1u << b);
        if ((uint64_t)t * d <= n) q = t;
    }
    return q;
}

/* brightness normalisation (ref.py v8): v -> black + (((v - black) * M + 2^23) >> 24), limited to 0..top (top = vmax,
 * or 65535 without a limit) */
static inline int32_t norm_px(int32_t v, int32_t black, int32_t M, int32_t top)
{
    int64_t t = ((int64_t)(v - black) * M + (1 << 23)) >> 24;      /* arithmetic shift = floor, as numpy */
    int64_t r = black + t;
    return (int32_t)(r < 0 ? 0 : (r > top ? top : r));
}

/* n / d for 64-bit n and 32-bit d >= 1, without a division library call */
static uint64_t udiv64(uint64_t n, uint32_t d)
{
    uint64_t q = 0, r = 0;
    int32_t b;
    for (b = 63; b >= 0; b--) {
        r = (r << 1) | ((n >> b) & 1);
        if (r >= d) { r -= d; q |= (uint64_t)1 << b; }
    }
    return q;
}

#define MF_NORM_MIN_TILES 50
#define MF_NORM_MAX_DEV   328
#define MF_NORM_HIST      16384   /* ratios above are counted at the top bin; such a median is rejected anyway */

static int32_t noise_k(int32_t e0, int32_t k)
{
    return k == 1 ? (int32_t)(((int64_t)e0 * 181) >> 8) : (e0 >> 1);
}

static int32_t ramp(uint32_t r, uint32_t lo, uint32_t hi)
{
    if (r <= lo) return MF_W6_ONE;
    if (r >= hi) return 0;
    return (int32_t)(((hi - r) * MF_W6_ONE) / (hi - lo));
}

/* ramp(min(floor(n / e), hi)) without dividing in the common cases: n < (lo+1)*e -> full, n >= hi*e -> 0.
 * ramp is monotone, so ramp(max over planes of r) == min over planes of ramp(r). */
static int32_t weight_of(uint64_t n, uint32_t e, uint32_t lo, uint32_t hi)
{
    if (n < (uint64_t)(lo + 1) * e) return MF_W6_ONE;
    if (n >= (uint64_t)hi * e) return 0;
    return ramp(div_cap(n, e, hi), lo, hi);
}

static inline int32_t mn(int32_t a, int32_t b) { return a < b ? a : b; }

#ifdef MF_NEON
/* norm_px of 8 pixels: VQRDMULH(a, b) = (2ab + 2^31) >> 32 (exact, floor), so with a = 2(v - black), b = M << 6:
 * (256 (v - black) M + 2^31) >> 32 = ((v - black) M + 2^23) >> 24.  Needs 0 <= M < 2^25 (b fits); the saturating
 * narrow is the limit to 0..65535, the vmin the limit to top (v8 vmax). */
static inline uint16x8_t norm8(uint16x8_t v, int32x4_t b2, int32x4_t m6, int32x4_t vb, uint16x8_t top)
{
    int32x4_t dl = vsubq_s32(vreinterpretq_s32_u32(vshll_n_u16(vget_low_u16(v), 1)), b2);
    int32x4_t dh = vsubq_s32(vreinterpretq_s32_u32(vshll_n_u16(vget_high_u16(v), 1)), b2);
    return vminq_u16(vcombine_u16(vqmovun_s32(vaddq_s32(vqrdmulhq_s32(dl, m6), vb)), vqmovun_s32(vaddq_s32(vqrdmulhq_s32(dh, m6), vb))),
                     top);
}
#endif

/* ---- merge layout ---------------------------------------------------------------------------- */

struct mf_layout {
    int32_t h2, w2, nbx, nt0, ntx, lv_h[MF_NLEVELS], lv_w[MF_NLEVELS], lvsz, al_bytes;
};

static int32_t layout(int32_t width, int32_t height, struct mf_layout *L)
{
    int32_t l;
    if (width <= 0 || height <= 0 || (width & 1) || (height & 1)) return MF_ERR_ARG;
    L->h2 = height / 2; L->w2 = width / 2;
    L->nbx = ceil_div(L->w2, MF_BLK);
    L->ntx = ceil_div(L->w2, 16);
    L->nt0 = ceil_div(L->h2, 16) * L->ntx;
    L->lvsz = 0;
    for (l = 0; l < MF_NLEVELS; l++) {
        if (mf_level_dims(L->h2, L->w2, l, &L->lv_h[l], &L->lv_w[l]) < 0) return MF_ERR_ARG;
        L->lvsz += L->lv_h[l] * L->lv_w[l];
    }
    L->al_bytes = mf_align_scratch_size(L->h2, L->w2);
    return L->al_bytes < 0 ? MF_ERR_ARG : MF_OK;
}

/* state of one used alternate in the row pipeline */
struct mf_alt {
    const uint16_t *a;
    const int32_t *ay, *ax;      /* level-0 offsets per 16x16 half-res tile */
    int32_t z, nrm, M;           /* index, normalisation needed (M != 2^24), M */
    uint32_t *ad;                /* |D| rows: 3 slots (row % 3) x 3 planes x w2; uint32, or (fast) uint16 limited to 65535 */
    uint8_t *wp;                 /* plane-weight rows: MF_WP_RING slots x (w2 + 2), mirror padded */
    int32_t *ba;                 /* signed D sums of the 8x8 blocks of the band in progress: 3 planes x nbx */
    uint8_t *bw;                 /* block weights: 2 bands (band & 1) x nbx */
    uint8_t *wf;                 /* final weights of the row being written: w2 */
};

/* everything the pipeline shares */
struct mf_ctx {
    const uint16_t *ref;
    int32_t stride, width, height, h2, w2, ntx, nbx, gd, black, nshift;   /* nshift: the weights table's (v9 nshift_w) */
    int32_t top;                 /* limit of normalised alternate pixels and of the output: vmax, or 65535 (no limit) */
    int32_t fast;                /* NEON kernels usable (value ranges checked); also: |D| rows and thresholds in uint16 */
    uint32_t *E;                 /* per-plane max(9 * noise, 1) of the plane-weight row being made: 3 x w2.  Fast mode
                                  * (mf15): instead uint32 A | Bt << 16 [plane][x] (3 x w2), A = ceil(513 E / 65536), Bt =
                                  * ceil(800 E / 65536) (weight 64 / 0 thresholds, <= 61036 for E <= MF_E_FAST), then from
                                  * word MF_E_BN uint8 noise bins [plane][x] (E = etab[bin]), from MF_E_OK w2 uint8 "decided"
                                  * flags and from MF_E_BX 3 x w2 uint16 3x3 sums of wp_plane_neon (5.5 w2 + 2 words) */
    uint32_t *vt;                /* 3 x (w2 + 2) vertical sums, mirror padded */
    int32_t *ebs;                /* block noise of the band being finished: 3 x nbx */
    uint32_t *etab;              /* 3 x 256: max(9 * noise_k(ntab_w[i]), 1) (v9: the weights table, ntab without one) */
    int32_t *ebtab;              /* 3 x 256: noise_k(ntab_w[i]) */
    uint32_t *abtab;             /* 3 x 256 (fast mode): A | Bt << 16 of etab[i] (see E) */
    uint32_t *rc;                /* rcp[den] of the row being written: w2 */
    /* phase 2, this slot's row pipeline where its last strip ended (band_rows): it goes on from there if the next strip it
     * takes is the adjacent one, else it starts afresh with the halo.  c_next: first row of that adjacent strip (-1: none) */
    int32_t c_next, c_y0, c_r, c_nwp, c_nb;
};

/* the fast mode's areas in X->E (mf15, see mf_ctx E), in words from X->E: bins, "decided" flags, 3x3 sums */
#define MF_E_BN(w2) (3 * (w2))
#define MF_E_OK(w2) (3 * (w2) + (3 * (w2) + 3) / 4)
#define MF_E_BX(w2) (MF_E_OK(w2) + ((w2) + 3) / 4)

/* scratch carving (one function for the size and the pointers): every region a multiple of 16 bytes.  Shared: both
 * pyramids, per-tile data, the offsets of every alternate, align scratch, noise tables.  Per thread (slot): a row of tile
 * sums, its struct mf_ctx, its struct mf_alt per alternate, its stats, and its row-pipeline buffers (a few rows per
 * alternate). */
struct mf_bufs {
    int32_t *rl[MF_NLEVELS], *al[MF_NLEVELS], *e0a, *tsum, *sag, *qt, *offs, *hist, *Ms, *alsc, *tacc;
    uint32_t *etab, *abtab;          /* phase 2 only: in hist (phase 1 only), see merge_any */
    int32_t *ebtab;
    struct mf_ctx *X;                /* [slot] */
    struct mf_alt *U;                /* [slot * (MF_MAX_FRAMES - 1) + alternate] */
    struct mf_stats *acc;            /* [slot] */
};

#define MF_WORDS(T) (((int64_t)sizeof(T) + 3) / 4)

/* Parts (mf14): with `split` the regions go to three parts, part 0 the reference's level 0, part 1 the alternate's level 0,
 * part 2 everything else in the same order; without it one cursor runs over one area (the layout up to mf13).  words[k]:
 * the words used in part k (all in words[0] without split).  base[k] 0: sizes only. */
static void carve(int32_t *const base[MF_PARTS], int32_t split, const struct mf_layout *L, int32_t n_alt, int32_t nth,
                  struct mf_bufs *B, int64_t words[MF_PARTS])
{
    int64_t *off = words;
    int32_t l, z, s, nal = n_alt > 0 ? n_alt : 1, w2 = L->w2, g = 2;
    off[0] = off[1] = off[2] = 0;
#define MF_PT(k) (split ? (k) : 0)
#define MF_AT(k) (base[MF_PT(k)] ? base[MF_PT(k)] + off[MF_PT(k)] : 0)
#define MF_TAKEP(k, dst, type, words) do { (dst) = (type *)(void *)MF_AT(k); off[MF_PT(k)] += ((int64_t)(words) + 3) & ~(int64_t)3; } while (0)
#define MF_TAKE(dst, type, words) MF_TAKEP(g, dst, type, words)
#define MF_SLOT(dst, type, words) do { if (base[MF_PT(g)]) (dst) = (type *)(void *)MF_AT(g); off[MF_PT(g)] += ((int64_t)(words) + 3) & ~(int64_t)3; } while (0)
    for (l = 0; l < MF_NLEVELS; l++) MF_TAKEP(l ? 2 : 0, B->rl[l], int32_t, L->lv_h[l] * L->lv_w[l]);
    for (l = 0; l < MF_NLEVELS; l++) MF_TAKEP(l ? 2 : 1, B->al[l], int32_t, L->lv_h[l] * L->lv_w[l]);
    MF_TAKE(B->e0a, int32_t, L->nt0);
    MF_TAKE(B->tsum, int32_t, L->nt0);
    MF_TAKE(B->sag, int32_t, L->nt0);
    MF_TAKE(B->qt, int32_t, L->nt0);
    MF_TAKE(B->offs, int32_t, 2 * (int64_t)nal * L->nt0);
    MF_TAKE(B->hist, int32_t, MF_NORM_HIST);
    MF_TAKE(B->Ms, int32_t, 2 * MF_MAX_FRAMES);
    MF_TAKE(B->alsc, int32_t, L->al_bytes / 4 + 1);
    MF_TAKE(B->tacc, int32_t, (int64_t)nth * L->ntx);
    MF_TAKE(B->X, struct mf_ctx, nth * MF_WORDS(struct mf_ctx));
    MF_TAKE(B->U, struct mf_alt, nth * (MF_MAX_FRAMES - 1) * MF_WORDS(struct mf_alt));
    MF_TAKE(B->acc, struct mf_stats, nth * MF_WORDS(struct mf_stats));
    for (s = 0; s < nth; s++) {
        struct mf_ctx *X = base[MF_PT(g)] ? B->X + s : 0;
        struct mf_alt *U = base[MF_PT(g)] ? B->U + s * (MF_MAX_FRAMES - 1) : 0;
        MF_SLOT(X->E, uint32_t, 9 * w2);
        MF_SLOT(X->vt, uint32_t, 3 * (w2 + 2));
        MF_SLOT(X->ebs, int32_t, 3 * L->nbx);
        MF_SLOT(X->rc, uint32_t, w2);
        for (z = 0; z < nal && z < MF_MAX_FRAMES - 1; z++) {
            MF_SLOT(U[z].ad, uint32_t, 9 * w2);
            MF_SLOT(U[z].wp, uint8_t, (MF_WP_RING * (w2 + 2) + 3) / 4);
            MF_SLOT(U[z].ba, int32_t, 3 * L->nbx);
            MF_SLOT(U[z].bw, uint8_t, (2 * L->nbx + 3) / 4);
            MF_SLOT(U[z].wf, uint8_t, (w2 + 3) / 4);
        }
    }
#undef MF_SLOT
#undef MF_TAKE
#undef MF_TAKEP
#undef MF_AT
#undef MF_PT
}

static int64_t carve_one(int32_t *base, const struct mf_layout *L, int32_t n_alt, int32_t nth, struct mf_bufs *B)
{
    int32_t *b3[MF_PARTS];
    int64_t w[MF_PARTS];
    b3[0] = b3[1] = b3[2] = base;
    carve(b3, 0, L, n_alt, nth, B, w);
    return w[0];
}

int32_t mf_scratch_size_mt(int32_t width, int32_t height, int32_t n_alt, int32_t threads)
{
    struct mf_layout L;
    struct mf_bufs B;
    int64_t words;
    if (n_alt < 0 || n_alt > MF_MAX_FRAMES - 1 || threads < 1 || threads > MF_MAX_THREADS) return MF_ERR_ARG;
    if (layout(width, height, &L) < 0) return MF_ERR_ARG;
    words = carve_one(0, &L, n_alt, threads, &B);
    if (words * 4 > 0x7fffffff) return MF_ERR_ARG;
    return (int32_t)(words * 4);
}

/* bytes at the start of the scratch that hold only the two pyramids (rl[0..3], al[0..3], carved first): they are read in
 * phase 1 only, so the output may overlay them (mf_merge_mt writes `out` in phase 2 only and never reads the pyramids there) */
int32_t mf_scratch_out_room(int32_t width, int32_t height)
{
    struct mf_layout L;
    int64_t words = 0;
    int32_t l;
    if (layout(width, height, &L) < 0) return MF_ERR_ARG;
    for (l = 0; l < MF_NLEVELS; l++) words += 2 * (((int64_t)L.lv_h[l] * L.lv_w[l] + 3) & ~(int64_t)3);
    if (words * 4 > 0x7fffffff) return MF_ERR_ARG;
    return (int32_t)(words * 4);
}

/* bytes of scratch of the single-thread merge */
int32_t mf_scratch_size(int32_t width, int32_t height, int32_t n_alt)
{
    return mf_scratch_size_mt(width, height, n_alt, 1);
}

int32_t mf_parts_size_mt(int32_t width, int32_t height, int32_t n_alt, int32_t threads, uint32_t bytes[MF_PARTS])
{
    struct mf_layout L;
    struct mf_bufs B;
    int32_t *b3[MF_PARTS];
    int64_t w[MF_PARTS];
    int32_t k;
    if (n_alt < 0 || n_alt > MF_MAX_FRAMES - 1 || threads < 1 || threads > MF_MAX_THREADS) return MF_ERR_ARG;
    if (layout(width, height, &L) < 0) return MF_ERR_ARG;
    b3[0] = b3[1] = b3[2] = 0;
    carve(b3, 1, &L, n_alt, threads, &B, w);
    for (k = 0; k < MF_PARTS; k++) {
        if (w[k] * 4 > 0x7fffffff) return MF_ERR_ARG;
        bytes[k] = (uint32_t)(w[k] * 4);
    }
    return MF_OK;
}

/* ---- merge kernels -------------------------------------------------------------------------- */

/* D (reference minus normalised alternate) of the three planes for the 2x2 blocks r0/r1 (reference) and a0/a1
 * (alternate); planes as ref.planes(): green_diag 0 -> (a, b+d, e), 1 -> (b, a+e, d) */
static inline void d_vals(const uint16_t *r0, const uint16_t *r1, const uint16_t *a0, const uint16_t *a1, int32_t gd,
                          int32_t nrm, int32_t black, int32_t M, int32_t top, int32_t *D)
{
    int32_t va = a0[0], vb = a0[1], vd = a1[0], ve = a1[1];
    if (nrm) { va = norm_px(va, black, M, top); vb = norm_px(vb, black, M, top); vd = norm_px(vd, black, M, top); ve = norm_px(ve, black, M, top); }
    if (gd) {
        D[0] = (int32_t)r0[1] - vb;
        D[1] = ((int32_t)r0[0] + r1[1]) - (va + ve);
        D[2] = (int32_t)r1[0] - vd;
    } else {
        D[0] = (int32_t)r0[0] - va;
        D[1] = ((int32_t)r0[1] + r1[0]) - (vb + vd);
        D[2] = (int32_t)r1[1] - ve;
    }
}

/* D at half-res pixel (r, x), mirror rules of d_row in all cases */
static inline void d_px(const struct mf_ctx *X, const struct mf_alt *U, int32_t r, int32_t x, int32_t *D)
{
    int32_t t = (r >> 4) * X->ntx + (x >> 4), qy = refl(r + U->ay[t], X->h2), qx = refl(x + U->ax[t], X->w2);
    const uint16_t *rr = X->ref + 2 * r * X->stride + 2 * x, *aa = U->a + 2 * qy * X->stride + 2 * qx;
    d_vals(rr, rr + X->stride, aa, aa + X->stride, X->gd, U->nrm, X->black, U->M, X->top, D);
}

/* |D| into the |D| rows: uint32, or uint16 limited to 65535 in the fast mode.  The limit changes no weight: a 3x3 sum
 * >= 65535 is >= every weight-0 threshold (<= 61036), and a sum below the threshold has no limited term. */
static inline void put_ad(void *ad, int32_t fast, int32_t i, int32_t d)
{
    uint32_t a = (uint32_t)iabs(d);
    if (fast) ((uint16_t *)ad)[i] = (uint16_t)(a > 65535 ? 65535 : a);
    else ((uint32_t *)ad)[i] = a;
}

#ifdef MF_NEON
/* 8 pixels of d_row (fast mode) at reference rows r0/r1 and alternate rows a0/a1 (pixel pairs): |D| per plane into a16
 * (plane k at a16 + k w2; 0: not stored), and the partial D sums of the three planes (4 lanes each, to be summed) */
static inline void d8_neon(const uint16_t *r0, const uint16_t *r1, const uint16_t *a0, const uint16_t *a1, int32_t gd, int32_t nrm,
                           int32x4_t b2, int32x4_t m6, int32x4_t vb, uint16x8_t vt, uint16_t *a16, int32_t w2, int32x4_t p[3])
{
    uint16x8x2_t R0 = vld2q_u16(r0), R1 = vld2q_u16(r1), A0 = vld2q_u16(a0), A1 = vld2q_u16(a1);
    uint16x8_t rs0, rg0, rg1, rs2, as0, ag0, ag1, as2;
    uint32x4_t grl, grh, gal, gah;
    if (nrm) {
        A0.val[0] = norm8(A0.val[0], b2, m6, vb, vt); A0.val[1] = norm8(A0.val[1], b2, m6, vb, vt);
        A1.val[0] = norm8(A1.val[0], b2, m6, vb, vt); A1.val[1] = norm8(A1.val[1], b2, m6, vb, vt);
    }
    if (gd) {
        rs0 = R0.val[1]; rg0 = R0.val[0]; rg1 = R1.val[1]; rs2 = R1.val[0];
        as0 = A0.val[1]; ag0 = A0.val[0]; ag1 = A1.val[1]; as2 = A1.val[0];
    } else {
        rs0 = R0.val[0]; rg0 = R0.val[1]; rg1 = R1.val[0]; rs2 = R1.val[1];
        as0 = A0.val[0]; ag0 = A0.val[1]; ag1 = A1.val[0]; as2 = A1.val[1];
    }
    grl = vaddl_u16(vget_low_u16(rg0), vget_low_u16(rg1)); grh = vaddl_u16(vget_high_u16(rg0), vget_high_u16(rg1));
    gal = vaddl_u16(vget_low_u16(ag0), vget_low_u16(ag1)); gah = vaddl_u16(vget_high_u16(ag0), vget_high_u16(ag1));
    if (a16) {
        vst1q_u16(a16, vabdq_u16(rs0, as0));
        vst1q_u16(a16 + w2, vcombine_u16(vqmovn_u32(vabdq_u32(grl, gal)), vqmovn_u32(vabdq_u32(grh, gah))));
        vst1q_u16(a16 + 2 * w2, vabdq_u16(rs2, as2));
    }
    p[0] = vsubq_s32(vreinterpretq_s32_u32(vpaddlq_u16(rs0)), vreinterpretq_s32_u32(vpaddlq_u16(as0)));
    p[1] = vsubq_s32(vreinterpretq_s32_u32(vaddq_u32(grl, grh)), vreinterpretq_s32_u32(vaddq_u32(gal, gah)));
    p[2] = vsubq_s32(vreinterpretq_s32_u32(vpaddlq_u16(rs2)), vreinterpretq_s32_u32(vpaddlq_u16(as2)));
}
#endif

/* D row r of alternate U: |D| per plane into |D| slot `slot` (3 x w2; -1: not stored) and the D sums of the 8-pixel
 * blocks added to U->ba (block columns mirror-filled at the right end) */
static MF_NOINLINE void d_row(const struct mf_ctx *X, const struct mf_alt *U, int32_t r, int32_t slot)
{
    int32_t w2 = X->w2, nbx = X->nbx, stride = X->stride, gd = X->gd, fast = X->fast, x, k, j, D[3];
    void *ad = slot < 0 ? 0 : fast ? (void *)((uint16_t *)U->ad + slot * 3 * w2) : (void *)(U->ad + slot * 3 * w2);
    const int32_t *oyr = U->ay + (r >> 4) * X->ntx, *oxr = U->ax + (r >> 4) * X->ntx;
    const uint16_t *r0 = X->ref + 2 * r * stride, *r1 = r0 + stride;
    int32_t *ba = U->ba, nfull = w2 / MF_BLK;
#ifdef MF_NEON
    int32x4_t vb = vdupq_n_s32(X->black), b2 = vdupq_n_s32(2 * X->black), m6 = vdupq_n_s32(U->M << 6);
    uint16x8_t vt = vdupq_n_u16((uint16_t)X->top);
#endif
    for (x = 0; x < nfull * MF_BLK; x += MF_BLK) {
        int32_t t = x >> 4, qy = refl(r + oyr[t], X->h2), qx = x + oxr[t], bx = x >> 3;
#ifdef MF_NEON
        /* two blocks (16 pixels, one 16-wide tile) at once: their D sums by pairwise adds, no transfer to core registers */
        if (fast && !(x & 15) && x + 16 <= nfull * MF_BLK && qx >= 0 && qx + 16 <= w2) {
            const uint16_t *a0 = U->a + 2 * qy * stride + 2 * qx, *a1 = a0 + stride;
            uint16_t *a16 = ad ? (uint16_t *)ad + x : 0;
            int32x4_t pa[3], pb[3];
            d8_neon(r0 + 2 * x, r1 + 2 * x, a0, a1, gd, U->nrm, b2, m6, vb, vt, a16, w2, pa);
            d8_neon(r0 + 2 * x + 16, r1 + 2 * x + 16, a0 + 16, a1 + 16, gd, U->nrm, b2, m6, vb, vt, a16 ? a16 + 8 : 0, w2, pb);
            for (k = 0; k < 3; k++) {
                int32x2_t sab = vpadd_s32(vadd_s32(vget_low_s32(pa[k]), vget_high_s32(pa[k])), vadd_s32(vget_low_s32(pb[k]), vget_high_s32(pb[k])));
                vst1_s32(ba + k * nbx + bx, vadd_s32(vld1_s32(ba + k * nbx + bx), sab));
            }
            x += MF_BLK;
            continue;
        }
#endif
        if (qx >= 0 && qx + MF_BLK <= w2) {
            const uint16_t *a0 = U->a + 2 * qy * stride + 2 * qx, *a1 = a0 + stride;
            int32_t s0 = 0, s1 = 0, s2 = 0;
#ifdef MF_NEON
            if (fast) {
                int32x4_t pa[3];
                d8_neon(r0 + 2 * x, r1 + 2 * x, a0, a1, gd, U->nrm, b2, m6, vb, vt, ad ? (uint16_t *)ad + x : 0, w2, pa);
                ba[bx] += hsum_s32(pa[0]); ba[nbx + bx] += hsum_s32(pa[1]); ba[2 * nbx + bx] += hsum_s32(pa[2]);
                continue;
            }
#endif
            for (j = 0; j < MF_BLK; j++) {
                d_vals(r0 + 2 * (x + j), r1 + 2 * (x + j), a0 + 2 * j, a1 + 2 * j, gd, U->nrm, X->black, U->M, X->top, D);
                if (ad) { put_ad(ad, fast, x + j, D[0]); put_ad(ad, fast, w2 + x + j, D[1]); put_ad(ad, fast, 2 * w2 + x + j, D[2]); }
                s0 += D[0]; s1 += D[1]; s2 += D[2];
            }
            ba[bx] += s0; ba[nbx + bx] += s1; ba[2 * nbx + bx] += s2;
        } else {
            int32_t s0 = 0, s1 = 0, s2 = 0;
            for (j = 0; j < MF_BLK; j++) {
                d_px(X, U, r, x + j, D);
                if (ad) { put_ad(ad, fast, x + j, D[0]); put_ad(ad, fast, w2 + x + j, D[1]); put_ad(ad, fast, 2 * w2 + x + j, D[2]); }
                s0 += D[0]; s1 += D[1]; s2 += D[2];
            }
            ba[bx] += s0; ba[nbx + bx] += s1; ba[2 * nbx + bx] += s2;
        }
    }
    if (x < w2) {                                /* partial last block: mirror-filled */
        int32_t s[3] = {0, 0, 0};
        if (ad)
            for (j = x; j < w2; j++) {
                d_px(X, U, r, j, D);
                for (k = 0; k < 3; k++) put_ad(ad, fast, k * w2 + j, D[k]);
            }
        for (j = 0; j < MF_BLK; j++) {
            d_px(X, U, r, refl(x + j, w2), D);
            for (k = 0; k < 3; k++) s[k] += D[k];
        }
        for (k = 0; k < 3; k++) ba[k * nbx + (x >> 3)] += s[k];
    }
}

/* mirror padding of a row stored at p[1 .. n] */
static inline void pad_u32(uint32_t *p, int32_t n) { p[0] = n > 1 ? p[2] : p[1]; p[n + 1] = n > 1 ? p[n - 1] : p[n]; }
static inline void pad_u8(uint8_t *p, int32_t n) { p[0] = n > 1 ? p[2] : p[1]; p[n + 1] = n > 1 ? p[n - 1] : p[n]; }

/* per-plane noise of the plane-weight row q: E[k][x] = max(9 * noise of the 3x3 mean of reference plane k, 1)
 * (ref.Reference.e9; the 3x3 sum is a vertical then a horizontal sum, both mirrored) */
static MF_NOINLINE void e_row(const struct mf_ctx *X, int32_t q)
{
    int32_t w2 = X->w2, stride = X->stride, gd = X->gd, x, k, ry[3];
    const uint16_t *p0[3], *p1[3];
    ry[0] = refl(q - 1, X->h2); ry[1] = q; ry[2] = refl(q + 1, X->h2);
    for (k = 0; k < 3; k++) { p0[k] = X->ref + 2 * ry[k] * stride; p1[k] = p0[k] + stride; }
    x = 0;
#ifdef MF_NEON
    for (; X->fast && x + 8 <= w2; x += 8) {
        uint32x4_t s0l = vdupq_n_u32(0), s0h = s0l, s1l = s0l, s1h = s0l, s2l = s0l, s2h = s0l;
        for (k = 0; k < 3; k++) {
            uint16x8x2_t R0 = vld2q_u16(p0[k] + 2 * x), R1 = vld2q_u16(p1[k] + 2 * x);
            uint16x8_t a = gd ? R0.val[1] : R0.val[0], g0 = gd ? R0.val[0] : R0.val[1];
            uint16x8_t g1 = gd ? R1.val[1] : R1.val[0], e = gd ? R1.val[0] : R1.val[1];
            s0l = vaddw_u16(s0l, vget_low_u16(a)); s0h = vaddw_u16(s0h, vget_high_u16(a));
            s1l = vaddq_u32(s1l, vaddl_u16(vget_low_u16(g0), vget_low_u16(g1)));
            s1h = vaddq_u32(s1h, vaddl_u16(vget_high_u16(g0), vget_high_u16(g1)));
            s2l = vaddw_u16(s2l, vget_low_u16(e)); s2h = vaddw_u16(s2h, vget_high_u16(e));
        }
        vst1q_u32(X->vt + 1 + x, s0l); vst1q_u32(X->vt + 1 + x + 4, s0h);
        vst1q_u32(X->vt + (w2 + 2) + 1 + x, s1l); vst1q_u32(X->vt + (w2 + 2) + 1 + x + 4, s1h);
        vst1q_u32(X->vt + 2 * (w2 + 2) + 1 + x, s2l); vst1q_u32(X->vt + 2 * (w2 + 2) + 1 + x + 4, s2h);
    }
#endif
    for (; x < w2; x++) {
        uint32_t s0 = 0, s1 = 0, s2 = 0;
        for (k = 0; k < 3; k++) {
            const uint16_t *a = p0[k] + 2 * x, *b = p1[k] + 2 * x;
            s0 += a[gd]; s1 += (uint32_t)a[1 - gd] + b[gd]; s2 += b[1 - gd];
        }
        X->vt[1 + x] = s0; X->vt[(w2 + 2) + 1 + x] = s1; X->vt[2 * (w2 + 2) + 1 + x] = s2;
    }
    for (k = 0; k < 3; k++) {
        uint32_t *v = X->vt + k * (w2 + 2), *E = X->E + k * w2;
        const uint32_t *tab = X->etab + k * MF_NOISE_BINS;
        pad_u32(v, w2);
        x = 0;
#ifdef MF_NEON
        if (X->fast) {
            /* fast mode (mf15): the noise bin of every pixel (uint8), then the packed thresholds A | Bt << 16 of that bin by
             * one lookup in X->abtab (made once per merge from etab, the same formulas as before per pixel) */
            uint8_t *bn = (uint8_t *)(X->E + MF_E_BN(w2)) + k * w2;
            uint32_t *AB = X->E + k * w2;
            const uint32_t *ab = X->abtab + k * MF_NOISE_BINS;
            uint32x4_t vbl = vdupq_n_u32((uint32_t)X->black), top = vdupq_n_u32(MF_NOISE_BINS - 1);
            int32x4_t vsh = vdupq_n_s32(-X->nshift);
            uint32x2_t mg = vdup_n_u32(0x38E38E39u);              /* floor(s / 9) = (s * 0x38E38E39) >> 33 */
            for (; x + 8 <= w2; x += 8) {
                uint32x4_t s0 = vaddq_u32(vaddq_u32(vld1q_u32(v + x), vld1q_u32(v + x + 1)), vld1q_u32(v + x + 2));
                uint32x4_t s1 = vaddq_u32(vaddq_u32(vld1q_u32(v + x + 4), vld1q_u32(v + x + 5)), vld1q_u32(v + x + 6));
                uint32x4_t m0 = vcombine_u32(vshrn_n_u64(vmull_u32(vget_low_u32(s0), mg), 32), vshrn_n_u64(vmull_u32(vget_high_u32(s0), mg), 32));
                uint32x4_t m1 = vcombine_u32(vshrn_n_u64(vmull_u32(vget_low_u32(s1), mg), 32), vshrn_n_u64(vmull_u32(vget_high_u32(s1), mg), 32));
                m0 = k == 1 ? vshrq_n_u32(m0, 2) : vshrq_n_u32(m0, 1);
                m1 = k == 1 ? vshrq_n_u32(m1, 2) : vshrq_n_u32(m1, 1);
                /* min(max(m - black, 0) >> nshift, 255): saturating subtract (black >= 0 here) */
                m0 = vminq_u32(vshlq_u32(vqsubq_u32(m0, vbl), vsh), top);
                m1 = vminq_u32(vshlq_u32(vqsubq_u32(m1, vbl), vsh), top);
                vst1_u8(bn + x, vmovn_u16(vcombine_u16(vmovn_u32(m0), vmovn_u32(m1))));
            }
            for (; x < w2; x++) {
                int32_t m = (int32_t)((v[x] + v[x + 1] + v[x + 2]) / (k == 1 ? 18u : 9u)) - X->black;
                if (m < 0) m = 0;
                m >>= X->nshift;
                bn[x] = (uint8_t)(m > MF_NOISE_BINS - 1 ? MF_NOISE_BINS - 1 : m);
            }
            for (x = 0; x + 4 <= w2; x += 4) {
                uint32_t b0 = bn[x], b1 = bn[x + 1], b2 = bn[x + 2], b3 = bn[x + 3];
                AB[x] = ab[b0]; AB[x + 1] = ab[b1]; AB[x + 2] = ab[b2]; AB[x + 3] = ab[b3];
            }
            for (; x < w2; x++) AB[x] = ab[bn[x]];
            continue;
        }
#endif
        for (; x < w2; x++) {
            int32_t m = (int32_t)((v[x] + v[x + 1] + v[x + 2]) / (k == 1 ? 18u : 9u)) - X->black;
            if (m < 0) m = 0;
            m >>= X->nshift;
            E[x] = tab[m > MF_NOISE_BINS - 1 ? MF_NOISE_BINS - 1 : m];
        }
    }
}

/* E of plane k at pixel x of the row in X->E: the stored value, or (fast mode) etab of the stored bin */
static inline uint32_t e_at(const struct mf_ctx *X, int32_t k, int32_t x)
{
    if (X->fast) return X->etab[k * MF_NOISE_BINS + ((const uint8_t *)(X->E + MF_E_BN(X->w2)))[k * X->w2 + x]];
    return X->E[k * X->w2 + x];
}

/* exact plane weight of pixel x (vt, E filled): min over planes of weight_of(3x3 sum of |D| << 16, E, PIX_LO, PIX_HI) */
static inline int32_t wp_px(const struct mf_ctx *X, int32_t x)
{
    int32_t k, w = MF_W6_ONE;
    for (k = 0; k < 3; k++) {
        const uint32_t *v = X->vt + k * (X->w2 + 2) + x;
        int32_t wv = weight_of((uint64_t)(v[0] + v[1] + v[2]) << 16, e_at(X, k, x), MF_PIX_LO, MF_PIX_HI);
        if (wv < w) w = wv;
    }
    return w;
}

#ifdef MF_NEON
/* vertical 3-sum of |D| (uint16 rows a, b, c, limited to 65535) at x .. x+7 */
static inline uint16x8_t vsum3(const uint16_t *a, const uint16_t *b, const uint16_t *c, int32_t x)
{
    return vqaddq_u16(vqaddq_u16(vld1q_u16(a + x), vld1q_u16(b + x)), vld1q_u16(c + x));
}

/* plane k of the plane-weight row (NEON, fast mode): 8 pixels per step in uint16 with saturating sums (exact decisions, see
 * put_ad), the 3x3 sum as a vertical sum slid along the row (vext for the horizontal neighbours), weight 64 / 0 by the
 * thresholds of e_row (box*65536 < 513e <=> box < A = ceil(513e / 65536); box*65536 >= 800e <=> box >= Bt).  Plane 0
 * stores the weights and the "decided" flags (0xFF: 64 or 0; 0: on the ramp), planes 1, 2 take the minimum / the and (mf15:
 * the flags instead of a test per step; the ramp afterwards, wp_ramp).  Returns the first pixel not done. */
static int32_t wp_plane_neon(const struct mf_ctx *X, const uint16_t *a, const uint16_t *b, const uint16_t *c, int32_t k,
                             uint8_t *o, uint8_t *okf)
{
    int32_t w2 = X->w2, x;
    const uint16_t *AB = (const uint16_t *)(X->E + k * w2);
    uint16_t *bxs = (uint16_t *)(X->E + MF_E_BX(w2)) + k * w2;  /* the 3x3 sums, for wp_ramp */
    uint16x8_t c64 = vdupq_n_u16(MF_W6_ONE), v0 = vsum3(a, b, c, 0), vp = vdupq_lane_u16(vget_low_u16(v0), 1);
    if (!k)
        for (x = 0; x + 16 <= w2; x += 8) {
            uint16x8_t v1 = vsum3(a, b, c, x + 8);
            uint16x8_t box = vqaddq_u16(vqaddq_u16(vextq_u16(vp, v0, 7), v0), vextq_u16(v0, v1, 1));
            uint16x8x2_t t = vld2q_u16(AB + 2 * x);
            uint16x8_t z = vcgeq_u16(box, t.val[1]);
            vst1q_u16(bxs + x, box);
            vst1_u8(o + x, vmovn_u16(vbicq_u16(c64, z)));
            vst1_u8(okf + x, vmovn_u16(vorrq_u16(vcltq_u16(box, t.val[0]), z)));
            vp = v0; v0 = v1;
        }
    else
        for (x = 0; x + 16 <= w2; x += 8) {
            uint16x8_t v1 = vsum3(a, b, c, x + 8);
            uint16x8_t box = vqaddq_u16(vqaddq_u16(vextq_u16(vp, v0, 7), v0), vextq_u16(v0, v1, 1));
            uint16x8x2_t t = vld2q_u16(AB + 2 * x);
            uint16x8_t z = vcgeq_u16(box, t.val[1]);
            vst1q_u16(bxs + x, box);
            vst1_u8(o + x, vmin_u8(vld1_u8(o + x), vmovn_u16(vbicq_u16(c64, z))));
            vst1_u8(okf + x, vand_u8(vld1_u8(okf + x), vmovn_u16(vorrq_u16(vcltq_u16(box, t.val[0]), z))));
            vp = v0; v0 = v1;
        }
    return x;
}

/* the pixels 0 .. x1-1 of the plane-weight row with a plane on the ramp (flag 0, rare), exactly: the ramp of each plane on it
 * from the stored 3x3 sum (box < Bt <= 61036 there, so no saturating sum was limited).  r = min(floor(box 2^16 / E), PIX_HI)
 * as div_cap, by one 32-bit division (box < 2^16, E >= 1; the camera's Cortex-A7 divides in hardware). */
static void wp_ramp(const struct mf_ctx *X, int32_t x1, const uint8_t *okf, uint8_t *o)
{
    int32_t w2 = X->w2, x, j, k;
    const uint8_t *bn = (const uint8_t *)(X->E + MF_E_BN(w2));
    const uint16_t *bxs = (const uint16_t *)(X->E + MF_E_BX(w2));
    for (x = 0; x < x1; x += 8) {
        const uint32_t *f = (const uint32_t *)(const void *)(okf + x);
        if ((f[0] & f[1]) == 0xFFFFFFFFu) continue;
        for (j = x; j < x + 8; j++) {
            if (okf[j]) continue;
            for (k = 0; k < 3; k++) {
                uint32_t e = X->E[k * w2 + j], sm = bxs[k * w2 + j];
                if (sm >= (e & 0xFFFF) && sm < (e >> 16)) {
                    uint32_t r = (sm << 16) / X->etab[k * MF_NOISE_BINS + bn[k * w2 + j]];
                    int32_t wv = ramp(r > MF_PIX_HI ? MF_PIX_HI : r, MF_PIX_LO, MF_PIX_HI);
                    if (wv < o[j]) o[j] = (uint8_t)wv;
                }
            }
        }
    }
}
#endif

/* plane-weight row q of alternate U (|D| rows refl(q-1), q, refl(q+1) present, E of row q made) */
static MF_NOINLINE void wp_row(const struct mf_ctx *X, const struct mf_alt *U, int32_t q)
{
    int32_t w2 = X->w2, x, k;
    const uint32_t *ra = U->ad + (refl(q - 1, X->h2) % 3) * 3 * w2, *rb = U->ad + (q % 3) * 3 * w2;
    const uint32_t *rc = U->ad + (refl(q + 1, X->h2) % 3) * 3 * w2;
    uint8_t *o = U->wp + (q & (MF_WP_RING - 1)) * (w2 + 2);
    x = 0;
#ifdef MF_NEON
    if (X->fast && w2 >= 16) {
        const uint16_t *sa = (const uint16_t *)U->ad + (refl(q - 1, X->h2) % 3) * 3 * w2;
        const uint16_t *sb = (const uint16_t *)U->ad + (q % 3) * 3 * w2, *sc = (const uint16_t *)U->ad + (refl(q + 1, X->h2) % 3) * 3 * w2;
        uint8_t *okf = (uint8_t *)(X->E + MF_E_OK(w2));             /* see mf_ctx E */
        const uint16_t *sp[3][3];
        int32_t x0 = 0;
        for (k = 0; k < 3; k++) {
            sp[k][0] = sa + k * w2; sp[k][1] = sb + k * w2; sp[k][2] = sc + k * w2;
            x0 = wp_plane_neon(X, sp[k][0], sp[k][1], sp[k][2], k, o + 1, okf);
        }
        wp_ramp(X, x0, okf, o + 1);
        for (k = 0; k < 3; k++) {                /* vertical sums of the last pixels (and their left neighbour) */
            uint32_t *v = X->vt + k * (w2 + 2) + 1;
            const uint16_t *a = sp[k][0], *b = sp[k][1], *c = sp[k][2];
            for (x = x0 - 1; x < w2; x++) v[x] = (uint32_t)a[x] + b[x] + c[x];
            pad_u32(v - 1, w2);
        }
        for (x = x0; x < w2; x++) o[1 + x] = (uint8_t)wp_px(X, x);
        pad_u8(o, w2);
        return;
    }
#endif
    for (k = 0; k < 3; k++) {
        uint32_t *v = X->vt + k * (w2 + 2) + 1;
        const uint32_t *a = ra + k * w2, *b = rb + k * w2, *c = rc + k * w2;
        for (x = 0; x < w2; x++) v[x] = a[x] + b[x] + c[x];
        pad_u32(v - 1, w2);
    }
    for (x = 0; x < w2; x++) o[1 + x] = (uint8_t)wp_px(X, x);
    pad_u8(o, w2);
}

/* plane sums of the reference over the 8x8 block at column x0 of the rows rp[0..7]; columns mirrored if `mir` */
static MF_NOINLINE void eb_sums(const struct mf_ctx *X, const uint16_t *const *rp, int32_t x0, int32_t mir, uint32_t *s)
{
    int32_t i, j, gd = X->gd, stride = X->stride;
    s[0] = s[1] = s[2] = 0;
    for (i = 0; i < MF_BLK; i++) {
        const uint16_t *r0 = rp[i], *r1 = r0 + stride;
        for (j = 0; j < MF_BLK; j++) {
            int32_t xx = 2 * (mir ? refl(x0 + j, X->w2) : x0 + j);
            s[0] += r0[xx + gd]; s[1] += (uint32_t)r0[xx + 1 - gd] + r1[xx + gd]; s[2] += r1[xx + 1 - gd];
        }
    }
}

/* block noise of band b: ebs[k][bx] = noise of the mean of reference plane k over the 8x8 block (mirror-filled) */
static MF_NOINLINE void eb_band(const struct mf_ctx *X, int32_t b)
{
    int32_t w2 = X->w2, nbx = X->nbx, i, k, bx;
    const uint16_t *rp[MF_BLK];
    for (i = 0; i < MF_BLK; i++) rp[i] = X->ref + 2 * refl(b * MF_BLK + i, X->h2) * X->stride;
    for (bx = 0; bx < nbx; bx++) {
        uint32_t s[3];
        int32_t x0 = bx * MF_BLK;
#ifdef MF_NEON
        if (x0 + MF_BLK <= w2) {
            uint32x4_t a0 = vdupq_n_u32(0), a1 = a0, a2 = a0;
            int32_t gd = X->gd, stride = X->stride;
#ifdef __clang__
#pragma clang loop unroll(disable)
#endif
            for (i = 0; i < MF_BLK; i++) {                      /* (fully unrolled it spills ~0.7 KB of stack) */
                uint16x8x2_t R0 = vld2q_u16(rp[i] + 2 * x0), R1 = vld2q_u16(rp[i] + stride + 2 * x0);
                a0 = vpadalq_u16(a0, gd ? R0.val[1] : R0.val[0]);
                a1 = vpadalq_u16(vpadalq_u16(a1, gd ? R0.val[0] : R0.val[1]), gd ? R1.val[1] : R1.val[0]);
                a2 = vpadalq_u16(a2, gd ? R1.val[0] : R1.val[1]);
            }
            s[0] = hsum_u32(a0); s[1] = hsum_u32(a1); s[2] = hsum_u32(a2);
        } else
#endif
            eb_sums(X, rp, x0, x0 + MF_BLK > w2, s);
        for (k = 0; k < 3; k++) {
            int32_t m = (int32_t)(s[k] / (k == 1 ? 2u * MF_BLK * MF_BLK : (uint32_t)MF_BLK * MF_BLK)) - X->black;
            if (m < 0) m = 0;
            m >>= X->nshift;
            X->ebs[k * nbx + bx] = X->ebtab[k * MF_NOISE_BINS + (m > MF_NOISE_BINS - 1 ? MF_NOISE_BINS - 1 : m)];
        }
    }
}

/* block weights of band b of alternate U from its D block sums and the band's block noise */
static MF_NOINLINE void bw_band(const struct mf_ctx *X, const struct mf_alt *U, int32_t b)
{
    int32_t nbx = X->nbx, bx, k;
    uint8_t *bw = U->bw + (b & 1) * nbx;
    for (bx = 0; bx < nbx; bx++) {
        int32_t v = MF_W6_ONE;
        for (k = 0; k < 3; k++) {
            int32_t e = X->ebs[k * nbx + bx];
            int32_t ev = weight_of((uint64_t)(uint32_t)iabs(U->ba[k * nbx + bx]) << 13, (uint32_t)(e > 0 ? e : 1),
                                   MF_BLK_LO, MF_BLK_HI);
            if (ev < v) v = ev;
        }
        bw[bx] = (uint8_t)v;
    }
}

/* final weights of output row y for every used alternate, rcp[den], and the two output Bayer rows */
static MF_NOINLINE void emit_row(const struct mf_ctx *X, struct mf_alt *U, int32_t nu, int32_t y, const int32_t *rcp, uint16_t *o2y,
                     int32_t out_stride, struct mf_stats *st)
{
    int32_t w2 = X->w2, width = X->width, stride = X->stride, ntx = X->ntx, u, x, j;
    for (u = 0; u < nu; u++) {
        const uint8_t *pu = U[u].wp + (refl(y - 1, X->h2) & (MF_WP_RING - 1)) * (w2 + 2);
        const uint8_t *pm = U[u].wp + (y & (MF_WP_RING - 1)) * (w2 + 2);
        const uint8_t *pd = U[u].wp + (refl(y + 1, X->h2) & (MF_WP_RING - 1)) * (w2 + 2);
        const uint8_t *bw = U[u].bw + ((y >> 3) & 1) * X->nbx;
        uint8_t *wf = U[u].wf;
        uint32_t s = 0;
        x = 0;
#ifdef MF_NEON
        uint32x4_t sv = vdupq_n_u32(0);                 /* the weight sum in lanes (at most 64 * w2 / 4 per lane) */
        for (; x + 16 <= w2; x += 16) {
            uint8x16_t v = vminq_u8(vminq_u8(vld1q_u8(pu + x), vld1q_u8(pu + x + 1)), vld1q_u8(pu + x + 2));
            v = vminq_u8(v, vminq_u8(vminq_u8(vld1q_u8(pm + x), vld1q_u8(pm + x + 1)), vld1q_u8(pm + x + 2)));
            v = vminq_u8(v, vminq_u8(vminq_u8(vld1q_u8(pd + x), vld1q_u8(pd + x + 1)), vld1q_u8(pd + x + 2)));
            v = vminq_u8(v, vcombine_u8(vdup_n_u8(bw[x >> 3]), vdup_n_u8(bw[(x >> 3) + 1])));
            vst1q_u8(wf + x, v);
            sv = vpadalq_u16(sv, vpaddlq_u8(v));
        }
        s = hsum_u32(sv);
#endif
        for (; x < w2; x++) {
            int32_t v = mn(mn(mn(pu[x], pu[x + 1]), pu[x + 2]), mn(mn(pm[x], pm[x + 1]), pm[x + 2]));
            v = mn(v, mn(mn(pd[x], pd[x + 1]), pd[x + 2]));
            v = mn(v, bw[x >> 3]);
            wf[x] = (uint8_t)v;
            s += (uint32_t)v;
        }
        if (st) st->wsum[U[u].z] += s;
    }
    x = 0;
#ifdef MF_NEON
    for (; x + 8 <= w2; x += 8) {                /* den = 64 + sum of the weights, then rcp[den] */
        uint16_t dd[8];
        uint16x8_t d = vdupq_n_u16(MF_W6_ONE);
        for (u = 0; u < nu; u++) d = vaddw_u8(d, vld1_u8(U[u].wf + x));
        vst1q_u16(dd, d);
        for (j = 0; j < 8; j++) X->rc[x + j] = (uint32_t)rcp[dd[j]];
    }
#endif
    for (; x < w2; x++) {
        int32_t d = MF_W6_ONE;
        for (u = 0; u < nu; u++) d += U[u].wf[x];
        X->rc[x] = (uint32_t)rcp[d];
    }
    for (j = 0; j < 2; j++) {
        int32_t yy = 2 * y + j, X0 = 0;
        const uint16_t *rr = X->ref + yy * stride;
        uint16_t *o = o2y + j * out_stride;           /* o2y: output row 2y (rows 2y, 2y + 1 are in one output band) */
#ifdef MF_NEON
        uint16x8_t vt = vdupq_n_u16((uint16_t)X->top);
        for (; X->fast && X0 + 16 <= width; X0 += 16) {
            uint16x8_t r0 = vld1q_u16(rr + X0), r1 = vld1q_u16(rr + X0 + 8);
            uint32x4_t a0 = vshll_n_u16(vget_low_u16(r0), 6), a1 = vshll_n_u16(vget_high_u16(r0), 6);
            uint32x4_t a2 = vshll_n_u16(vget_low_u16(r1), 6), a3 = vshll_n_u16(vget_high_u16(r1), 6);
            uint32x4_t c0 = vld1q_u32(X->rc + (X0 >> 1)), c1 = vld1q_u32(X->rc + (X0 >> 1) + 4);
            uint32x4x2_t z0 = vzipq_u32(c0, c0), z1 = vzipq_u32(c1, c1);
            uint32x4_t o0, o1, o2, o3;
            for (u = 0; u < nu; u++) {
                uint8x8_t w8 = vld1_u8(U[u].wf + (X0 >> 1));
                uint8x8x2_t wz;
                uint16x8_t wl, wh, v0, v1;
                int32_t t, sy, sx;
                if (!vget_lane_u64(vreinterpret_u64_u8(w8), 0)) continue;
                wz = vzip_u8(w8, w8); wl = vmovl_u8(wz.val[0]); wh = vmovl_u8(wz.val[1]);
                t = (y >> 4) * ntx + (X0 >> 5);
                sy = refl(yy + 2 * U[u].ay[t], X->height); sx = X0 + 2 * U[u].ax[t];
                if (sx >= 0 && sx + 16 <= width) {
                    const uint16_t *p = U[u].a + sy * stride + sx;
                    v0 = vld1q_u16(p); v1 = vld1q_u16(p + 8);
                } else {
                    uint16_t tmp[16];
                    int32_t i;
                    for (i = 0; i < 16; i++) tmp[i] = U[u].a[sy * stride + refl(sx + i, width)];
                    v0 = vld1q_u16(tmp); v1 = vld1q_u16(tmp + 8);
                }
                if (U[u].nrm) {
                    int32x4_t vb = vdupq_n_s32(X->black), b2 = vdupq_n_s32(2 * X->black), m6 = vdupq_n_s32(U[u].M << 6);
                    v0 = norm8(v0, b2, m6, vb, vt); v1 = norm8(v1, b2, m6, vb, vt);
                }
                a0 = vmlal_u16(a0, vget_low_u16(v0), vget_low_u16(wl)); a1 = vmlal_u16(a1, vget_high_u16(v0), vget_high_u16(wl));
                a2 = vmlal_u16(a2, vget_low_u16(v1), vget_low_u16(wh)); a3 = vmlal_u16(a3, vget_high_u16(v1), vget_high_u16(wh));
            }
            /* (num * rcp[den] + 2^23) >> 24, limited to 65535, then to top */
            o0 = vcombine_u32(vrshrn_n_u64(vmull_u32(vget_low_u32(a0), vget_low_u32(z0.val[0])), 24),
                              vrshrn_n_u64(vmull_u32(vget_high_u32(a0), vget_high_u32(z0.val[0])), 24));
            o1 = vcombine_u32(vrshrn_n_u64(vmull_u32(vget_low_u32(a1), vget_low_u32(z0.val[1])), 24),
                              vrshrn_n_u64(vmull_u32(vget_high_u32(a1), vget_high_u32(z0.val[1])), 24));
            o2 = vcombine_u32(vrshrn_n_u64(vmull_u32(vget_low_u32(a2), vget_low_u32(z1.val[0])), 24),
                              vrshrn_n_u64(vmull_u32(vget_high_u32(a2), vget_high_u32(z1.val[0])), 24));
            o3 = vcombine_u32(vrshrn_n_u64(vmull_u32(vget_low_u32(a3), vget_low_u32(z1.val[1])), 24),
                              vrshrn_n_u64(vmull_u32(vget_high_u32(a3), vget_high_u32(z1.val[1])), 24));
            vst1q_u16(o + X0, vminq_u16(vcombine_u16(vqmovn_u32(o0), vqmovn_u32(o1)), vt));
            vst1q_u16(o + X0 + 8, vminq_u16(vcombine_u16(vqmovn_u32(o2), vqmovn_u32(o3)), vt));
        }
#endif
        for (; X0 < width; X0++) {
            uint32_t acc = (uint32_t)rr[X0] * MF_W6_ONE;
            uint64_t v;
            for (u = 0; u < nu; u++) {
                int32_t wq = U[u].wf[X0 >> 1], t, sy, sx, a;
                if (!wq) continue;
                t = (y >> 4) * ntx + (X0 >> 5);
                sy = refl(yy + 2 * U[u].ay[t], X->height); sx = refl(X0 + 2 * U[u].ax[t], width);
                a = U[u].a[sy * stride + sx];
                if (U[u].nrm) a = norm_px(a, X->black, U[u].M, X->top);
                acc += (uint32_t)(wq * a);
            }
            v = ((uint64_t)acc * X->rc[X0 >> 1] + (1u << (MF_RCP_BITS - 1))) >> MF_RCP_BITS;
            o[X0] = (uint16_t)(v > (uint64_t)X->top ? (uint64_t)X->top : v);
        }
    }
}

/* ---- phase 2: the row pipeline over a band of output rows ------------------------------------------------------ */

struct band_arg {
    struct mf_ctx *X;                /* [slot] */
    struct mf_alt *U;                /* [slot * (MF_MAX_FRAMES - 1) + u] */
    struct mf_stats *acc;            /* [slot]: wsum, wcount, strips of the strips that slot finished */
    int32_t nu, rows, out_stride, out_split;   /* full-res rows >= out_split (even) are at out2 */
    const int32_t *rcp;
    uint16_t *out, *out2;
    int32_t (*stop)(void *, int32_t);
    void *stop_ctx;
    struct mf_par *P;
    int32_t nstrips, nreg;
    uint32_t *reg;                   /* [nreg] strips left in each slot's region: first | end << 16 (atomic) */
};

/* Output rows y0 .. y1-1 (y0 a multiple of MF_STRIP_ROWS).  D row r -> |D| (3-row ring) and block sums; plane-weight row
 * r-1 (needs D rows r-2..r); at a band's last row its block weights; output row y once plane-weight row y+1 and y's band
 * are known.  A run starting at y0 > 0 begins with D rows y0-2, y0-1 (for plane-weight row y0-1; their block sums are
 * discarded at row y0) and ends with D rows y1, y1+1 (for plane-weight row y1): the same values as one pass over all rows.
 * If this slot's previous strip ended at y0 (X->c_next), the run goes on with that state (rings, counters) instead: the same
 * as one longer run.  Returns early if P is stopped (checked after each strip; slot 0 asks stop() first). */
/* output row yy (full resolution) */
static inline uint16_t *orow(const struct band_arg *A, int32_t yy)
{
    return yy < A->out_split ? A->out + yy * A->out_stride : A->out2 + (yy - A->out_split) * A->out_stride;
}

static void band_rows(struct mf_ctx *X, struct mf_alt *U, int32_t nu, int32_t y0, int32_t y1, const struct band_arg *A, int32_t slot)
{
    int32_t h2 = X->h2, ntx = X->ntx, height = X->height, stride = X->stride, out_stride = A->out_stride, w2 = X->w2;
    int32_t r, i, u, ye = y0, nwp = 0, nb = y0 / MF_BLK, ys = y0, b0;
    const uint16_t *ref = X->ref;
    struct mf_stats *st = A->acc + slot;
#ifndef MF_FORCE_REPRIME                         /* (Mac test builds only: measures what the fresh starts cost) */
    if (y0 > 0 && X->c_next == y0) { ys = X->c_y0; r = X->c_r; nwp = X->c_nwp; nb = X->c_nb; }
    else
#endif
    {
        for (u = 0; u < nu; u++) for (i = 0; i < 3 * X->nbx; i++) U[u].ba[i] = 0;
        r = y0 >= 2 ? y0 - 2 : 0;
    }
    X->c_next = -1;
    b0 = ys / MF_BLK;
    for (; ye < y1; r++) {
        if (r < h2 && nu > 0) {
            int32_t b = r / MF_BLK;
            if (r + 1 < h2) {
                mf_pf(ref + (2 * r + 2) * stride, 4 * stride);
                for (u = 0; u < nu; u++) {
                    int32_t qn = r + 1 + U[u].ay[((r + 1) >> 4) * ntx + ntx / 2];
                    if (qn >= 0 && qn < h2) mf_pf(U[u].a + 2 * qn * stride, 4 * stride);
                }
            }
            if (r % MF_BLK == 0) for (u = 0; u < nu; u++) for (i = 0; i < 3 * X->nbx; i++) U[u].ba[i] = 0;
            for (u = 0; u < nu; u++) d_row(X, &U[u], r, r % 3);
            if (r >= 1 && r >= ys) { e_row(X, r - 1); for (u = 0; u < nu; u++) wp_row(X, &U[u], r - 1); nwp = r; }
            if (r == h2 - 1) { e_row(X, r); for (u = 0; u < nu; u++) wp_row(X, &U[u], r); nwp = h2; }
            if ((r % MF_BLK == MF_BLK - 1 || r == h2 - 1) && b >= b0) {
                for (i = r % MF_BLK + 1; i < MF_BLK; i++)                /* rows past the end: mirrored */
                    for (u = 0; u < nu; u++) d_row(X, &U[u], refl(b * MF_BLK + i, h2), -1);
                eb_band(X, b);
                for (u = 0; u < nu; u++) bw_band(X, &U[u], b);
                nb = b + 1;
            }
        } else if (r < h2) { nwp = r + 1; nb = r / MF_BLK + 1; }
        while (ye < y1 && (ye + 1 < nwp || nwp == h2) && ye / MF_BLK < nb) {
            if (ye + 1 < h2) {
                mf_pf(orow(A, 2 * ye + 2), 2 * out_stride);
                mf_pf(orow(A, 2 * ye + 3), 2 * out_stride);
                for (u = 0; u < nu; u++) {
                    int32_t qn = 2 * (ye + 1) + 2 * U[u].ay[((ye + 1) >> 4) * ntx + ntx / 2];
                    if (qn >= 0 && qn + 1 < height) mf_pf(U[u].a + qn * stride, 4 * stride);
                }
            }
            emit_row(X, U, nu, ye, A->rcp, orow(A, 2 * ye), out_stride, st);
            ye++;
            if (ye % MF_STRIP_ROWS == 0 || ye == h2) {
                st->wcount += (uint32_t)((ye - 1) % MF_STRIP_ROWS + 1) * (uint32_t)w2; st->strips++;
                __atomic_fetch_add(&A->P->strips_done, 1u, __ATOMIC_RELAXED);          /* progress for the caller only */
                if (slot == 0 && A->stop && A->stop(A->stop_ctx, MF_MAX_FRAMES + (ye - 1) / MF_STRIP_ROWS)) par_stop(A->P);
                if (par_stopped(A->P)) return;
            }
        }
    }
    X->c_next = y1; X->c_y0 = ys; X->c_r = r; X->c_nwp = nwp; X->c_nb = nb;
}

/* the strip a call of band_job works on (mf15): every call takes one strip that no other call takes.  The strips are cut into
 * one region per slot (slot s: strips s n / nreg .. (s + 1) n / nreg - 1); a slot takes the first strip left in its own
 * region, which most of the time continues its own pipeline (no halo rows, band_rows), and when its region is used up the
 * last strip left in the region with the most left.  As many calls as strips, so a call always finds one (a failed exchange
 * means another call took a strip).  Which call takes which strip does not change the result (band_rows). */
static int32_t band_claim(const struct band_arg *A, int32_t slot)
{
    uint32_t *own = A->reg + (slot < A->nreg ? slot : 0);
    for (;;) {
        uint32_t v = __atomic_load_n(own, __ATOMIC_RELAXED), f = v & 0xFFFF, e = v >> 16, best = 0;
        int32_t r, br = -1;
        if (f < e) {
            if (__atomic_compare_exchange_n(own, &v, (f + 1) | (e << 16), 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) return (int32_t)f;
            continue;
        }
        for (r = 0; r < A->nreg; r++) {
            uint32_t w = __atomic_load_n(A->reg + r, __ATOMIC_RELAXED), n = (w >> 16) - (w & 0xFFFF);
            if ((w >> 16) > (w & 0xFFFF) && n > best) { best = n; br = r; v = w; }
        }
        if (br < 0) continue;
        f = v & 0xFFFF; e = v >> 16;
        if (__atomic_compare_exchange_n(A->reg + br, &v, f | ((e - 1) << 16), 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) return (int32_t)e - 1;
    }
}

static void band_job(void *p, int32_t index, int32_t slot)
{
    const struct band_arg *A = (const struct band_arg *)p;
    int32_t y0, y1;
    (void)index;
    if (par_stopped(A->P)) return;
    y0 = band_claim(A, slot) * A->rows; y1 = y0 + A->rows;
    if (y1 > A->X[slot].h2) y1 = A->X[slot].h2;
    band_rows(&A->X[slot], A->U + slot * (MF_MAX_FRAMES - 1), A->nu, y0, y1, A, slot);
}

/* ---- phase 1 pieces ---------------------------------------------------------------------------------------------- */

/* min(floor(n / d), MF_NORM_HIST - 1) for d >= 1: the ratio bin of gain_job (= udiv64 then the top-bin limit; binary search on
 * the 14 bits of a quotient below 16383) */
static uint32_t div_hist(uint64_t n, uint32_t d)
{
    uint32_t q = 0;
    int32_t b;
    if (n >= (uint64_t)(MF_NORM_HIST - 1) * d) return MF_NORM_HIST - 1;
    for (b = 13; b >= 0; b--) {
        uint32_t t = q | (1u << b);
        if ((uint64_t)t * d <= n) q = t;
    }
    return q;
}

/* brightness gain k: per level-0 16x16 tile the ratio bin (or -1: tile not counted), tile rows */
struct gain_arg {
    const int32_t *tsum, *sag, *ay, *ax, *ag;
    int32_t *qt;
    int32_t h2, w2, ntx, nty, black, span, gy, gx, count;
    struct mf_par *P;
};

static void gain_job(void *p, int32_t idx, int32_t slot)
{
    const struct gain_arg *A = (const struct gain_arg *)p;
    int32_t h2 = A->h2, w2 = A->w2, ntx = A->ntx, ty, tx, i, a, b;
    int64_t b4 = (int64_t)4 * A->black * 256;
    (void)slot;
    if (par_stopped(A->P)) return;
    span(A->nty, A->count, idx, &a, &b);
    for (ty = a; ty < b; ty++)
        for (tx = 0; tx < ntx; tx++) {
            int32_t t = ty * ntx + tx, y0 = ty * 16, x0 = tx * 16;
            int64_t sr = A->tsum[t], sa = 0, mr;
            const int32_t *ag = A->ag;
            if (y0 + 16 <= h2 && x0 + 16 <= w2) {
                int32_t oyt = A->ay[t], oxt = A->ax[t];
                if (A->sag[t] >= 0 && oyt == A->gy && oxt == A->gx) sa = A->sag[t];
                else if (y0 + oyt >= 0 && y0 + 15 + oyt < h2 && x0 + oxt >= 0 && x0 + 15 + oxt < w2) {
                    sa = sum_tile(ag + (y0 + oyt) * w2 + x0 + oxt, w2);
                } else
                    for (i = 0; i < 16; i++) {
                        int32_t jj, sy = refl(y0 + i + oyt, h2);
                        for (jj = 0; jj < 16; jj++) sa += ag[sy * w2 + refl(x0 + jj + oxt, w2)];
                    }
            } else {
                int32_t ii, jj;
                for (ii = 0; ii < 16; ii++) {
                    int32_t qy = refl(y0 + ii, h2);
                    for (jj = 0; jj < 16; jj++) {
                        int32_t qx = refl(x0 + jj, w2), tt = (qy >> 4) * ntx + (qx >> 4);
                        sa += ag[refl(qy + A->ay[tt], h2) * w2 + refl(qx + A->ax[tt], w2)];
                    }
                }
            }
            mr = sr / 1024 - A->black;
            sr -= b4; sa -= b4;
            A->qt[t] = -1;
            if (20 * mr >= A->span && 5 * mr <= 4 * (int64_t)A->span && sr > 0 && sa > 0) {
                A->qt[t] = (int32_t)div_hist((uint64_t)sa << 12, (uint32_t)sr);   /* min(q, MF_NORM_HIST - 1) as before */
            }
        }
}

int32_t mf_merge(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                 int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                 const int32_t *rcp, int32_t green_diag, int32_t white, uint16_t *out, int32_t out_stride,
                 void *scratch, uint32_t scratch_bytes)
{
    return mf_merge_mt(ref, alt, n_alt, width, height, stride, black, ntab, nshift, rcp, green_diag, white, 0, 0, 0, out, out_stride,
                       scratch, scratch_bytes, 0, 0, 0, 0);
}

int32_t mf_merge_ex(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                    int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                    const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                    void *scratch, uint32_t scratch_bytes, int32_t (*stop)(void *, int32_t), void *stop_ctx,
                    struct mf_stats *st)
{
    return mf_merge_mt(ref, alt, n_alt, width, height, stride, black, ntab, nshift, rcp, green_diag, white, vmax, ntab_w, nshift_w, out, out_stride,
                       scratch, scratch_bytes, stop, stop_ctx, 0, st);
}

static int32_t merge_any(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                         int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                         const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                         void *scratch, uint32_t scratch_bytes, const struct mf_mem *mem, int32_t (*stop)(void *, int32_t),
                         void *stop_ctx, struct mf_par *par, struct mf_stats *st);

int32_t mf_merge_mt(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                    int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                    const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                    void *scratch, uint32_t scratch_bytes, int32_t (*stop)(void *, int32_t), void *stop_ctx,
                    struct mf_par *par, struct mf_stats *st)
{
    return merge_any(ref, alt, n_alt, width, height, stride, black, ntab, nshift, rcp, green_diag, white, vmax, ntab_w, nshift_w, out, out_stride,
                     scratch, scratch_bytes, 0, stop, stop_ctx, par, st);
}

int32_t mf_merge_parts(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                       int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                       const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                       const struct mf_mem *mem, int32_t (*stop)(void *, int32_t), void *stop_ctx,
                       struct mf_par *par, struct mf_stats *st)
{
    if (!mem) return MF_ERR_ARG;
    return merge_any(ref, alt, n_alt, width, height, stride, black, ntab, nshift, rcp, green_diag, white, vmax, ntab_w, nshift_w, out, out_stride,
                     0, 0, mem, stop, stop_ctx, par, st);
}

static int32_t merge_any(const uint16_t *ref, uint16_t *const *alt, int32_t n_alt, int32_t width,
                         int32_t height, int32_t stride, int32_t black, const int32_t *ntab, int32_t nshift,
                         const int32_t *rcp, int32_t green_diag, int32_t white, int32_t vmax, const int32_t *ntab_w, int32_t nshift_w, uint16_t *out, int32_t out_stride,
                         void *scratch, uint32_t scratch_bytes, const struct mf_mem *mem, int32_t (*stop)(void *, int32_t),
                         void *stop_ctx, struct mf_par *par, struct mf_stats *st)
{
    int32_t *b3[MF_PARTS];
    int64_t w3[MF_PARTS];
    uint16_t *out2 = out;
    int32_t out_split = height;
    struct mf_layout L;
    struct mf_bufs B;
    struct mf_par one;
    struct mf_par *P = par;
    struct band_arg BA;
    struct mf_ctx *X;
    int32_t *e0a, *offs, *hist, *Ms;
    int32_t z, k, i, s, need, h2, w2, ntx, nu, g[2], nth, fast, top, nstrips, per;
    int32_t *gbs[MF_MAX_THREADS], *const *gb;
    uint32_t reg[MF_MAX_THREADS];
    if (!P) { one.n = 1; one.run = 0; one.par_ctx = 0; one.stop = 0; one.ref_done = 0; one.strips_done = 0; one.mark = 0; P = &one; }
    nth = par_threads(P);
    if (n_alt < 0 || n_alt > MF_MAX_FRAMES - 1 || stride < width || out_stride < width) return MF_ERR_ARG;
    if (!ntab_w) { ntab_w = ntab; nshift_w = nshift; }             /* v9: no weights table = the alignment table (v8) */
    if (layout(width, height, &L) < 0) return MF_ERR_ARG;
    if (mem) {                                       /* parts (mf14): every part large enough, the output split even */
        uint32_t want[MF_PARTS];
        if (mf_parts_size_mt(width, height, n_alt, nth, want) < 0) return MF_ERR_ARG;
        for (k = 0; k < MF_PARTS; k++) {
            if (!mem->part[k] || ((uintptr_t)mem->part[k] & 15)) return MF_ERR_ARG;
            if (mem->bytes[k] < want[k]) return MF_ERR_SCRATCH;
            b3[k] = (int32_t *)mem->part[k];
        }
        if (mem->out2 && mem->out_split > 0 && mem->out_split < height) {
            if (mem->out_split & 1) return MF_ERR_ARG;
            out2 = mem->out2; out_split = mem->out_split;
        }
        carve(b3, 1, &L, n_alt, nth, &B, w3);
    } else {
        need = mf_scratch_size_mt(width, height, n_alt, nth);
        if (need < 0) return MF_ERR_ARG;
        if (scratch_bytes < (uint32_t)need) return MF_ERR_SCRATCH;
        carve_one((int32_t *)scratch, &L, n_alt, nth, &B);
    }
    h2 = L.h2; w2 = L.w2; ntx = L.ntx;
    if (st) {
        for (z = 0; z < MF_MAX_FRAMES - 1; z++) { st->k_q12[z] = 0; st->used[z] = 0; st->gy[z] = 0; st->gx[z] = 0; st->wsum[z] = 0; }
        st->wcount = 0; st->strips = 0;
    }
    e0a = B.e0a; offs = B.offs; hist = B.hist; Ms = B.Ms;
    /* phase 1 reuses each slot's phase-2 buffer X->E (9 * w2 words, unused until phase 2) as search_tile's gather buffer */
    for (s = 0; s < MF_MAX_THREADS; s++) gbs[s] = s < nth && 9 * (int64_t)w2 >= MF_GATHER_WORDS ? (int32_t *)(void *)B.X[s].E : 0;
    gb = gbs;

    /* phase 1: reference pyramid and alignment noise; align every alternate (offsets kept) */
    par_mark(P, MF_ST_PYR);
    gray_pass(P, ref, height, width, stride, B.rl[0], B.rl[1], B.tsum, B.tacc);
    if (par_stopped(P)) return MF_ERR_STOP;
    par_down(P, B.rl[1], L.lv_h[1], L.lv_w[1], 4, B.rl[2]);
    par_down(P, B.rl[2], L.lv_h[2], L.lv_w[2], 4, B.rl[3]);
    if (par_stopped(P)) return MF_ERR_STOP;
    for (i = 0; i < L.nt0; i++) e0a[i] = mf_tile_noise(B.tsum[i] / 1024, black, ntab, nshift);
    __atomic_store_n(&P->ref_done, 1u, __ATOMIC_RELAXED);                    /* progress for the caller only */
    for (z = 0; z < n_alt; z++) {
        struct gain_arg GA;
        int32_t cnt = 0, kq = 4096, r;
        par_mark(P, MF_ST_PYR);
        gray_pass(P, alt[z], height, width, stride, B.al[0], B.al[1], 0, 0);
        if (par_stopped(P)) return MF_ERR_STOP;
        par_down(P, B.al[1], L.lv_h[1], L.lv_w[1], 4, B.al[2]);
        par_down(P, B.al[2], L.lv_h[2], L.lv_w[2], 4, B.al[3]);
        if (par_stopped(P)) return MF_ERR_STOP;
        r = align_pair_int((const int32_t *const *)B.rl, (const int32_t *const *)B.al, h2, w2, e0a, offs + 2 * z * L.nt0,
                           offs + (2 * z + 1) * L.nt0, g, B.alsc, (uint32_t)L.al_bytes, B.sag, gb, P);
        if (r == MF_ERR_STOP) return r;
        if (r < 0) return MF_ERR_ARG;
        if (st) { st->gy[z] = g[0]; st->gx[z] = g[1]; }
        /* brightness gain k (Q12): median over level-0 16x16 tiles of (alt - black) / (ref - black), tiles whose
         * reference mean is 5 %..80 % of the range above black (ref.py v7); the tiles' ratios as jobs, the median serial */
        par_mark(P, MF_ST_GAIN);
        GA.tsum = B.tsum; GA.sag = B.sag; GA.ay = offs + 2 * z * L.nt0; GA.ax = offs + (2 * z + 1) * L.nt0; GA.ag = B.al[0];
        GA.qt = B.qt; GA.h2 = h2; GA.w2 = w2; GA.ntx = ntx; GA.nty = ceil_div(h2, 16); GA.black = black; GA.span = white - black;
        GA.gy = g[0]; GA.gx = g[1]; GA.P = P; GA.count = par_jobs(P, GA.nty);
        par_for(P, gain_job, &GA, GA.count);
        if (par_stopped(P)) return MF_ERR_STOP;
        for (i = 0; i < MF_NORM_HIST; i++) hist[i] = 0;
        for (i = 0; i < L.nt0; i++)
            if (B.qt[i] >= 0) { hist[B.qt[i]]++; cnt++; }
        if (cnt >= MF_NORM_MIN_TILES) {
            int32_t want = (cnt - 1) / 2, acc = 0;
            for (i = 0; i < MF_NORM_HIST; i++) { acc += hist[i]; if (acc > want) { kq = i; break; } }
        }
        Ms[2 * z] = (kq - 4096 > MF_NORM_MAX_DEV || 4096 - kq > MF_NORM_MAX_DEV) ? 0 : 1;   /* used? */
        Ms[2 * z + 1] = (int32_t)udiv64(((uint64_t)1 << 36) + (uint32_t)(kq / 2), (uint32_t)kq);
        if (st) { st->k_q12[z] = kq; st->used[z] = Ms[2 * z]; }
        if (stop && stop(stop_ctx, z)) { par_stop(P); return MF_ERR_STOP; }
    }

    /* phase 2: the row pipeline (band_rows), in bands of whole strips, each slot with its own pipeline state */
    par_mark(P, MF_ST_P2SETUP);
    fast = black >= 0 && black <= 65535 && nshift_w >= 0 && nshift_w <= 31;
    /* the phase-2 tables go into hist, which phase 1 alone uses (MF_NORM_HIST >= 9 x 256 words; mf15: no area of their own) */
    B.etab = (uint32_t *)hist; B.ebtab = hist + 3 * MF_NOISE_BINS; B.abtab = (uint32_t *)hist + 6 * MF_NOISE_BINS;
    top = (vmax > 0 && vmax < 65535) ? vmax : 65535;               /* v8: vmax <= 0 or >= 65535 = no limit (v7) */
    for (k = 0; k < 3; k++)
        for (i = 0; i < MF_NOISE_BINS; i++) {
            /* the weights' noise from the weights table (v9; = ntab without one): E9 = max(9 n, 1), Eb = n (ref.Reference
             * e9 / eb).  9 n in int64 (|n| < 2^31), limited to MF_E_CAP: exact, as a noise >= 2^28 gives weight 64 for every
             * input (see MF_E_CAP). */
            int32_t n = noise_k(ntab_w[i], k);
            int64_t e9 = (int64_t)9 * n, eb = n;
            B.ebtab[k * MF_NOISE_BINS + i] = (int32_t)(eb > MF_E_CAP ? MF_E_CAP : eb);
            B.etab[k * MF_NOISE_BINS + i] = (uint32_t)(e9 > MF_E_CAP ? MF_E_CAP : (e9 > 0 ? e9 : 1));
            if (B.etab[k * MF_NOISE_BINS + i] > MF_E_FAST) fast = 0;
        }
    if (fast)                                                       /* the fast mode's thresholds per bin (see mf_ctx E) */
        for (i = 0; i < 3 * MF_NOISE_BINS; i++) {
            uint32_t e = B.etab[i];
            B.abtab[i] = ((e * (MF_PIX_LO + 1) + 65535) >> 16) | (((e * MF_PIX_HI + 65535) >> 16) << 16);
        }
    nu = 0;
    for (z = 0; z < n_alt; z++) {
        if (!Ms[2 * z]) continue;                                   /* brightness off by more than 8 % */
        for (s = 0; s < nth; s++) {
            struct mf_alt *U = B.U + s * (MF_MAX_FRAMES - 1) + nu;           /* its buffers: carve() */
            U->a = alt[z]; U->ay = offs + 2 * z * L.nt0; U->ax = offs + (2 * z + 1) * L.nt0;
            U->z = z; U->M = Ms[2 * z + 1]; U->nrm = U->M != (1 << 24);
        }
        if (Ms[2 * z + 1] < 0 || Ms[2 * z + 1] >= (1 << 25)) fast = 0;   /* norm8's range (|k - 1| <= 8 % keeps M < 2^25) */
        nu++;
    }
    if (w2 < 16) fast = 0;                                          /* (wp_row's NEON pass needs 16; its C path reads uint32 |D| rows) */
#ifndef MF_NEON
    fast = 0;                                                       /* uint32 |D| rows, plain C kernels */
#endif
    for (s = 0; s < nth; s++) {
        X = B.X + s;
        X->ref = ref; X->stride = stride; X->width = width; X->height = height; X->h2 = h2; X->w2 = w2; X->ntx = ntx; X->nbx = L.nbx;
        X->gd = green_diag ? 1 : 0; X->black = black; X->nshift = nshift_w; X->top = top; X->fast = fast;
        X->etab = B.etab; X->ebtab = B.ebtab; X->abtab = B.abtab; X->c_next = -1;
        B.acc[s].wcount = 0; B.acc[s].strips = 0;
        for (z = 0; z < MF_MAX_FRAMES - 1; z++) B.acc[s].wsum[z] = 0;
    }
    nstrips = ceil_div(h2, MF_STRIP_ROWS);
    if (nstrips > 0xFFFF) return MF_ERR_ARG;                       /* (band_claim packs strip numbers in 16 bits) */
    __atomic_store_n(&P->strips_done, 0u, __ATOMIC_RELAXED);
    per = 1;    /* one strip per job: a slow thread holds at most one strip; a slot that takes the next strip goes on without a halo */
    BA.X = B.X; BA.U = B.U; BA.acc = B.acc; BA.nu = nu; BA.rows = per * MF_STRIP_ROWS; BA.out_stride = out_stride; BA.rcp = rcp;
    BA.out = out; BA.out2 = out2; BA.out_split = out_split; BA.stop = stop; BA.stop_ctx = stop_ctx; BA.P = P;
    BA.nstrips = ceil_div(nstrips, per); BA.nreg = nth; BA.reg = reg;
    for (s = 0; s < nth; s++)
        reg[s] = (uint32_t)(s * BA.nstrips / nth) | ((uint32_t)((s + 1) * BA.nstrips / nth) << 16);
    par_mark(P, MF_ST_ROWS);
    par_for(P, band_job, &BA, BA.nstrips);
    par_mark(P, MF_ST_END);
    if (st)                                                          /* sums: the same for any split and any order */
        for (s = 0; s < nth; s++) {
            for (z = 0; z < MF_MAX_FRAMES - 1; z++) st->wsum[z] += B.acc[s].wsum[z];
            st->wcount += B.acc[s].wcount; st->strips += B.acc[s].strips;
        }
    return par_stopped(P) ? MF_ERR_STOP : MF_OK;
}
