/* SPDX-License-Identifier: GPL-2.0-only
 *
 * night_tone: see night_tone.h and ../night_tone_ref.py (the specification; every step below names the line
 * of the reference it mirrors).  Signed right shifts are arithmetic (floor), as numpy's >>.
 *
 * Three steps for the merge's worker threads: pass 1 (statistics) and pass 2 (gain) go by row bands that write
 * disjoint memory; the plan between them is single-threaded and small.  The per-quad loops have ARMv7 NEON kernels
 * (#ifdef NT_NEON: __ARM_NEON and not -DNT_NO_NEON) beside the plain C ones, which are the reference; both give the
 * same bits (check_night_tone.py compares both builds with night_tone_ref.py).  NEON identities:
 *   (sum k v) >> 12 = sum (k >> 12) v + ((sum (k & 4095) v) >> 12)     (32-bit lanes; bounds in lum4)
 *   (y0 V) >> 18 = VQDMULH(y0, V << 13);  (k2 q) >> 18 = VQDMULH(q << 13, k2)
 *   (v G + 2^15) >> 16 = VQRDMULH(v << 15, G)
 * Quads near white (brightest value >= the threshold stored with each gain) go through the plain C kernel.
 * Camera builds in unicorn, 6192 x 4128 synthetic night frame (check_night_tone.py --arm), instructions:
 *   NEON:    init 1.8 M, pass 1 27 per 2x2 block (174 M), plan 20.5 M, pass 2 47-49 per block (303-312 M): ~510 M
 *   plain C: init 1.8 M, pass 1 68 per block (436 M),     plan 23.5 M, pass 2 148 per block (946 M):     ~1410 M
 */
#include "night_tone.h"

#if defined(__ARM_NEON) && !defined(NT_NO_NEON)
#define NT_NEON 1
#include <arm_neon.h>
#endif

#define EPS20      256
#define YLIM       (1 << 25)
#define TMIN8      (-12 * 256)
#define NTAB       2432
#define LN2_Q32    2977044472u
#define C016_Q30   171798692
#define C016_Q52   720575940379279ull
#define Y001_Q36   68719477
#define N0_Q16     58982
#define EX_MAX_Q16 (10 << 16)
#define ZONES      15
#define NZ         (ZONES * ZONES)
#define GRID       8
#define RAD        3
#define EPS_GF     ((int64_t)2401 << 19)
#define B_DIV      (49 * 32768 * 4)

/* ------------------------------------------------------------------------------------------ helpers */

static uint32_t clz64(uint64_t x)
{
    uint32_t hi = (uint32_t)(x >> 32);
    return hi ? (uint32_t)__builtin_clz(hi) : 32u + (uint32_t)__builtin_clz((uint32_t)x);
}

/* n / d, d >= 1, d < 2^62 (restoring division, no library call) */
static uint64_t udiv64(uint64_t n, uint64_t d)
{
    uint64_t q = 0, r = 0;
    int32_t b;
    if (n < d) return 0;
    for (b = 63 - (int32_t)clz64(n); b >= 0; b--) {
        r = (r << 1) | ((n >> b) & 1);
        if (r >= d) { r -= d; q |= (uint64_t)1 << b; }
    }
    return q;
}

/* floor(n / d) when the quotient is < 2^bits and 2^bits * d < 2^64 (binary search) */
static uint64_t udiv_bs(uint64_t n, uint64_t d, int32_t bits)
{
    uint64_t q = 0;
    int32_t b;
    for (b = bits - 1; b >= 0; b--) {
        uint64_t t = q | ((uint64_t)1 << b);
        if (t * d <= n) q = t;
    }
    return q;
}

/* floor(n / d) for d >= 2^16 and a quotient below 2^16 (+ a few): one 32-bit division on the top 16 bits of d, then
 * corrected to the exact floor by 64-bit products (n < 2^63) */
static uint64_t udiv_est(uint64_t n, uint64_t d)
{
    int32_t s = 48 - (int32_t)clz64(d);          /* d >> s in [2^15, 2^16) */
    uint64_t q;
    if (s < 0) s = 0;
    q = (uint32_t)(n >> s) / (uint32_t)(d >> s);
    while (q && q * d > n) q--;
    while ((q + 1) * d <= n) q++;
    return q;
}

/* floor(n / 49) */
static int32_t floordiv49(int32_t n)
{
    int32_t q = n / 49;
    if (n - q * 49 < 0) q--;
    return q;
}

/* ref.log2_q16, x >= 1 */
static int32_t log2_q16(uint64_t x)
{
    int32_t n = 63 - (int32_t)clz64(x), b;
    uint64_t m = n >= 30 ? x >> (n - 30) : x << (30 - n);
    int32_t r = n << 16;
    for (b = 15; b >= 0; b--) {
        m = (m * m) >> 30;
        if (m >= ((uint64_t)1 << 31)) { m >>= 1; r |= 1 << b; }
    }
    return r;
}

/* ref.exp2_q */
static uint64_t exp2_q(int64_t e, int32_t q)
{
    int32_t n = (int32_t)(e >> 16), sh, k;
    uint32_t f = (uint32_t)(e & 0xFFFF);
    uint32_t y = (uint32_t)(((uint64_t)f * LN2_Q32) >> 16), t = y;
    uint64_t s = ((uint64_t)1 << 32) + y, v;
    for (k = 2; k <= 12; k++) {
        t = (uint32_t)(((uint64_t)t * y) >> 32) / (uint32_t)k;
        s += t;
    }
    v = (s + 2) >> 2;
    sh = n + q - 30;
    if (sh >= 0) return v << sh;
    if (-sh >= 63) return 0;
    return (v + ((uint64_t)1 << (-sh - 1))) >> -sh;
}

static int32_t q8(int32_t x) { return (x + 128) >> 8; }
static int32_t clampi(int32_t v, int32_t lo, int32_t hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ------------------------------------------------------------------------------------------ context, layout */

#define CTX_BYTES 512   /* the context at the start of the scratch area (fixed size: same layout on 32 / 64 bit) */

struct night_tone_ctx {
    uint16_t *bayer;
    int32_t w, h, stride, black, white, span, iso;
    int32_t H2, W2, GH, GW, zh, zw, R4, k1, k2;
    int32_t k[4], kh[4], kl[4];
    int32_t *ga, *gb, *ring, *col1, *cc, *vt, *lt, *gt, *drow;
    int64_t *col2, *zrow;
    uint32_t *crow, *hist;
    int32_t g, d, n, g_full, g_cap, changed, planned, fast;
    uint32_t clip0;
    int32_t n_max;   /* the caller's cap of N (night_tone_set_n_max), Q16; 0x7fffffff: none */
    int32_t d_max;   /* the caller's cap of the dark lift d (night_tone_set_d_max), Q16; 0x7fffffff: none */
};
typedef char nt_ctx_fits[sizeof(struct night_tone_ctx) <= CTX_BYTES ? 1 : -1];

struct layout {
    uint32_t ga, gb, ring, col1, col2, zrow, crow, drow, hist, cc, vt, lt, gt, total;
};

static uint32_t a8(uint32_t n) { return (n + 7u) & ~7u; }

static int32_t layout_of(int32_t w, int32_t h, struct layout *L)
{
    uint32_t H2, W2, GH, GW, o = CTX_BYTES;
    if (w < 32 || h < 32 || w > 16384 || h > 16384 || ((w | h) & 1)) return NT_ERR_ARG;
    H2 = (uint32_t)h / 2; W2 = (uint32_t)w / 2; GH = H2 / GRID; GW = W2 / GRID;
    L->ga = o;   o += a8(GH * GW * 4);
    L->gb = o;   o += a8(GH * GW * 4);
    L->ring = o; o += a8(4 * GW * 4);
    L->col1 = o; o += a8(GW * 4);
    L->col2 = o; o += a8(GW * 8);
    L->zrow = o; o += a8(H2 * ZONES * 8);
    L->crow = o; o += a8(H2 * 4);
    L->drow = o; o += a8(H2 * 4);
    L->hist = o; o += a8(256 * 4);
    L->cc = o;   o += a8(W2 * 4);
    L->vt = o;   o += a8(4097 * 4);
    L->lt = o;   o += a8(1024 * 4);
    L->gt = o;   o += a8(2 * NTAB * 4);
    L->total = o;
    return NT_OK;
}

uint32_t night_tone_scratch_bytes(int32_t w, int32_t h)
{
    struct layout L;
    return layout_of(w, h, &L) ? 0 : L.total;
}

/* ------------------------------------------------------------------------------------------ per quad (plain C) */

/* ref.luminance for one quad: Y (Q20; |Y| < 2^25 by the argument checks) and the four black-subtracted values.
 * vt holds V << 13: (y0 * V) >> 18 == (y0 * (V << 13)) >> 31 */
static inline int32_t quad_y(const struct night_tone_ctx *c, const uint16_t *r0, const uint16_t *r1, int32_t x,
                             int32_t ry, int32_t *v)
{
    int64_t s;
    int32_t y0;
    v[0] = (int32_t)r0[2 * x] - c->black; v[1] = (int32_t)r0[2 * x + 1] - c->black;
    v[2] = (int32_t)r1[2 * x] - c->black; v[3] = (int32_t)r1[2 * x + 1] - c->black;
    s = (int64_t)c->k[0] * v[0] + (int64_t)c->k[1] * v[1] + (int64_t)c->k[2] * v[2] + (int64_t)c->k[3] * v[3];
    y0 = (int32_t)(s >> 12);                                              /* Q24, |y0| < 2^31 by the argument checks */
    return (int32_t)(((int64_t)y0 * c->vt[(ry + c->cc[x] + 128) >> 8]) >> 31);   /* index <= 4096 */
}

/* ref.log2_quads: log2(max(Y, 0) + 2^-12) in Q12 */
static inline int32_t quad_log2(const int32_t *lt, int32_t Y)
{
    uint32_t x = (uint32_t)(Y > 0 ? Y : 0) + EPS20;
    uint32_t lz = (uint32_t)__builtin_clz(x);
    return (11 - (int32_t)lz) * 4096 + lt[((x << lz) >> 21) & 1023];
}

static inline uint32_t clip4(const uint16_t *r0, const uint16_t *r1, int32_t x, uint32_t wh)
{
    return (uint32_t)(r0[2 * x] >= wh) + (r0[2 * x + 1] >= wh) + (r1[2 * x] >= wh) + (r1[2 * x + 1] >= wh);
}

/* pass 2 for one quad: Au = A (Q15) at the quad, Bx = B (Q16) x 256 at the quad.  gt holds pairs (gain Q16,
 * th = the smallest brightest value v with v * gain + 32768 >= span << 16, i.e. the quads near white). */
static inline void quad_apply(const struct night_tone_ctx *c, uint16_t *r0, uint16_t *r1, int32_t x, int32_t ry,
                              int32_t Au, int32_t Bx, int32_t *dclip)
{
    int32_t v[4], Y, I, t, ti, G, vm, j;
    uint32_t wh = (uint32_t)c->white;
    Y = quad_y(c, r0, r1, x, ry, v);
    I = quad_log2(c->lt, Y);
    t = ((Au * I) >> 15) + (Bx >> 12);
    ti = clampi((t >> 4) - TMIN8, 0, NTAB - 1);
    G = c->gt[2 * ti];
    vm = v[0] > v[1] ? v[0] : v[1];
    if (v[2] > vm) vm = v[2];
    if (v[3] > vm) vm = v[3];
    if (vm >= c->gt[2 * ti + 1]) {
        /* near white: highlight limit (brightest value to white at most, gain >= 1) and the change of the clipped
         * count; in every other quad all values stay below white before and after */
        int32_t d = 0;
        if ((int64_t)vm * G > ((int64_t)c->span << 16)) {
            int32_t lim = (int32_t)(((uint32_t)c->span << 16) / (uint32_t)vm);
            G = lim > 65536 ? lim : 65536;
        }
        for (j = 0; j < 4; j++) {
            int32_t r = c->black + (int32_t)(((int64_t)v[j] * G + 32768) >> 16);
            uint32_t o = (uint32_t)(r < 0 ? 0 : r);
            d += (int32_t)(o >= wh) - (int32_t)((uint32_t)(v[j] + c->black) >= wh);
            v[j] = (int32_t)o;
        }
        *dclip += d;
    } else {
        for (j = 0; j < 4; j++) {
            int32_t r = c->black + (int32_t)(((int64_t)v[j] * G + 32768) >> 16);
            v[j] = r < 0 ? 0 : r;
        }
    }
    r0[2 * x] = (uint16_t)v[0]; r0[2 * x + 1] = (uint16_t)v[1];
    r1[2 * x] = (uint16_t)v[2]; r1[2 * x + 1] = (uint16_t)v[3];
}

/* ------------------------------------------------------------------------------------------ NEON kernels */
#ifdef NT_NEON

/* constants of the NEON kernels (fast path: every k >> 12 fits 16 bits, which the luminance bound of night_tone_init
 * already implies (sum k < 2^27); the plain C kernels otherwise).
 * Luminance from the raw values x: sum kh v = sum kh x - ckh (mod 2^32; the true value fits int32),
 * sum kl v = sum kl x - ckl (exact, |.| < 2^30): (sum k v) >> 12 = (sum kh v) + ((sum kl v) >> 12). */
struct nk {
    uint16x4_t kh, kl;
    int32x4_t c;        /* ckh, ckl, k1, k2 */
    int32_t black, ryb; /* ryb = ry + 128 */
};

static inline int32x4_t lum4(const struct nk *K, uint16x4_t x0, uint16x4_t x1, uint16x4_t x2, uint16x4_t x3, int32x4_t idx)
{
    uint32x4_t A = vmull_lane_u16(x0, K->kh, 0), B = vmull_lane_u16(x0, K->kl, 0);
    int32x4_t y0, V, q;
    A = vmlal_lane_u16(A, x1, K->kh, 1); B = vmlal_lane_u16(B, x1, K->kl, 1);
    A = vmlal_lane_u16(A, x2, K->kh, 2); B = vmlal_lane_u16(B, x2, K->kl, 2);
    A = vmlal_lane_u16(A, x3, K->kh, 3); B = vmlal_lane_u16(B, x3, K->kl, 3);
    y0 = vaddq_s32(vsubq_s32(vreinterpretq_s32_u32(A), vdupq_lane_s32(vget_low_s32(K->c), 0)),
                   vshrq_n_s32(vsubq_s32(vreinterpretq_s32_u32(B), vdupq_lane_s32(vget_low_s32(K->c), 1)), 12));
    /* V (ref.vig_table) = 16384 + ((k1 i) >> 14) + ((k2 (i^2 >> 8)) >> 18); Y = (y0 V) >> 18 = VQDMULH(y0, V << 13) */
    q = vshlq_n_s32(vshrq_n_s32(vmulq_s32(idx, idx), 8), 13);
    V = vaddq_s32(vshrq_n_s32(vmulq_lane_s32(idx, vget_high_s32(K->c), 0), 14), vqdmulhq_lane_s32(q, vget_high_s32(K->c), 1));
    V = vaddq_s32(V, vdupq_n_s32(16384));
    return vqdmulhq_s32(y0, vshlq_n_s32(V, 13));
}

static inline int32x4_t gather4(const int32_t *t, uint32x4_t i)
{
    int32x4_t r = vld1q_dup_s32(t + vgetq_lane_u32(i, 0));
    r = vld1q_lane_s32(t + vgetq_lane_u32(i, 1), r, 1);
    r = vld1q_lane_s32(t + vgetq_lane_u32(i, 2), r, 2);
    return vld1q_lane_s32(t + vgetq_lane_u32(i, 3), r, 3);
}

/* ref.log2_quads for 4 quads */
static inline int32x4_t log2_4(const int32_t *lt, int32x4_t Y)
{
    uint32x4_t x = vreinterpretq_u32_s32(vaddq_s32(vmaxq_s32(Y, vdupq_n_s32(0)), vdupq_n_s32(EPS20)));
    uint32x4_t lz = vclzq_u32(x);
    uint32x4_t li = vandq_u32(vshrq_n_u32(vshlq_u32(x, vreinterpretq_s32_u32(lz)), 21), vdupq_n_u32(1023));
    return vaddq_s32(vshlq_n_s32(vsubq_s32(vdupq_n_s32(11), vreinterpretq_s32_u32(lz)), 12), gather4(lt, li));
}

static inline int32x4_t idx4(const struct night_tone_ctx *c, const struct nk *K, int32_t x)
{
    return vshrq_n_s32(vaddq_s32(vld1q_s32(c->cc + x), vdupq_n_s32(K->ryb)), 8);
}

static inline int32_t hsum(int32x4_t a)
{
    int32x2_t s = vadd_s32(vget_low_s32(a), vget_high_s32(a));
    return vget_lane_s32(vpadd_s32(s, s), 0);
}

/* pass 1, 8 quads from quad x: Y values to yb, their sum and the log2 sum; clipped values counted in cnt */
static inline void cell_neon(const struct night_tone_ctx *c, const struct nk *K, const uint16_t *r0, const uint16_t *r1,
                             int32_t x, int32_t *yb, int32_t *sy, int32_t *si, uint16x4_t *cnt)
{
    uint16x4_t wv = vdup_n_u16((uint16_t)c->white);
    int32x4_t ty, ti;
    int32_t hh;
    for (hh = 0; hh < 2; hh++) {
        uint16x4x2_t a = vld2_u16(r0 + 2 * x + 8 * hh), b = vld2_u16(r1 + 2 * x + 8 * hh);
        int32x4_t Y;
        *cnt = vsub_u16(*cnt, vcge_u16(a.val[0], wv));
        *cnt = vsub_u16(*cnt, vcge_u16(a.val[1], wv));
        *cnt = vsub_u16(*cnt, vcge_u16(b.val[0], wv));
        *cnt = vsub_u16(*cnt, vcge_u16(b.val[1], wv));
        Y = lum4(K, a.val[0], a.val[1], b.val[0], b.val[1], idx4(c, K, x + 4 * hh));
        vst1q_s32(yb + 4 * hh, Y);
        if (hh == 0) { ty = Y; ti = log2_4(c->lt, Y); }
        else { ty = vaddq_s32(ty, Y); ti = vaddq_s32(ti, log2_4(c->lt, Y)); }
    }
    *sy = hsum(ty); *si = hsum(ti);
}

/* pass 2, 4 quads from quad x: a0, b0 = A x 256, B x 256 at quad x, da, db their step per quad.  Returns 1 without
 * writing when one of the 4 quads is near white (the caller does those 4 quads in plain C). */
static inline int32_t grp_neon(const struct night_tone_ctx *c, const struct nk *K, uint16_t *r0, uint16_t *r1, int32_t x,
                               int32_t a0, int32_t da, int32_t b0, int32_t db, int32x4_t l0123)
{
    uint16x4x2_t a = vld2_u16(r0 + 2 * x), b = vld2_u16(r1 + 2 * x);
    uint16x4_t bk = vdup_n_u16((uint16_t)K->black);
    int32x4_t vb = vdupq_n_s32(K->black);
    int32x4_t Y = lum4(K, a.val[0], a.val[1], b.val[0], b.val[1], idx4(c, K, x)), I = log2_4(c->lt, Y);
    int32x4_t Au = vshrq_n_s32(vmlaq_n_s32(vdupq_n_s32(a0), l0123, da), 8);
    int32x4_t Bs = vshrq_n_s32(vmlaq_n_s32(vdupq_n_s32(b0), l0123, db), 12);
    int32x4_t t = vaddq_s32(vshrq_n_s32(vmulq_s32(Au, I), 15), Bs);
    uint32x4_t ti = vreinterpretq_u32_s32(vminq_s32(vmaxq_s32(vaddq_s32(vshrq_n_s32(t, 4), vdupq_n_s32(-TMIN8)), vdupq_n_s32(0)),
                                                    vdupq_n_s32(NTAB - 1)));
    int32x4x2_t gp;
    int32x4_t v0, v1, v2, v3;
    uint32x4_t near;
    uint32x2_t nr;
    gp.val[0] = vdupq_n_s32(0); gp.val[1] = vdupq_n_s32(0);
    gp = vld2q_lane_s32(c->gt + 2 * vgetq_lane_u32(ti, 0), gp, 0);
    gp = vld2q_lane_s32(c->gt + 2 * vgetq_lane_u32(ti, 1), gp, 1);
    gp = vld2q_lane_s32(c->gt + 2 * vgetq_lane_u32(ti, 2), gp, 2);
    gp = vld2q_lane_s32(c->gt + 2 * vgetq_lane_u32(ti, 3), gp, 3);
    v0 = vreinterpretq_s32_u32(vsubl_u16(a.val[0], bk)); v1 = vreinterpretq_s32_u32(vsubl_u16(a.val[1], bk));
    v2 = vreinterpretq_s32_u32(vsubl_u16(b.val[0], bk)); v3 = vreinterpretq_s32_u32(vsubl_u16(b.val[1], bk));
    near = vcgeq_s32(vmaxq_s32(vmaxq_s32(v0, v1), vmaxq_s32(v2, v3)), gp.val[1]);
    nr = vorr_u32(vget_low_u32(near), vget_high_u32(near));
    if (vget_lane_u32(vpmax_u32(nr, nr), 0)) return 1;
    /* black + ((v G + 2^15) >> 16) = black + VQRDMULH(v << 15, G); below 0 -> 0 by the saturating narrow */
    a.val[0] = vqmovun_s32(vaddq_s32(vqrdmulhq_s32(vshlq_n_s32(v0, 15), gp.val[0]), vb));
    a.val[1] = vqmovun_s32(vaddq_s32(vqrdmulhq_s32(vshlq_n_s32(v1, 15), gp.val[0]), vb));
    b.val[0] = vqmovun_s32(vaddq_s32(vqrdmulhq_s32(vshlq_n_s32(v2, 15), gp.val[0]), vb));
    b.val[1] = vqmovun_s32(vaddq_s32(vqrdmulhq_s32(vshlq_n_s32(v3, 15), gp.val[0]), vb));
    vst2_u16(r0 + 2 * x, a);
    vst2_u16(r1 + 2 * x, b);
    return 0;
}

static inline void nk_init(const struct night_tone_ctx *c, struct nk *K, int32_t ry)
{
    int32_t ckh = 0, ckl = 0, i;
    uint16_t kh[4], kl[4];
    for (i = 0; i < 4; i++) {
        kh[i] = (uint16_t)c->kh[i]; kl[i] = (uint16_t)c->kl[i];
        ckh += (int32_t)((uint32_t)c->kh[i] * (uint32_t)c->black);      /* mod 2^32 */
        ckl += c->kl[i] * c->black;
    }
    K->kh = vld1_u16(kh); K->kl = vld1_u16(kl);
    K->c = vsetq_lane_s32(ckh, vdupq_n_s32(0), 0);
    K->c = vsetq_lane_s32(ckl, K->c, 1);
    K->c = vsetq_lane_s32(c->k1, K->c, 2);
    K->c = vsetq_lane_s32(c->k2, K->c, 3);
    K->black = c->black; K->ryb = ry + 128;
}
#endif

/* ------------------------------------------------------------------------------------------ pass 1 */

static int32_t row_ry(const struct night_tone_ctx *c, int32_t y)
{
    int64_t dy = 2 * y + 1 - c->h / 2;
    return (int32_t)udiv_bs((uint64_t)(dy * dy) << 20, (uint64_t)c->R4, 22);
}

/* zone column sums of one quad row: the run [q, q + n) with Y values yb (sum sy) */
static inline void zone_add(const struct night_tone_ctx *c, int64_t *zr, int32_t *zx, int32_t *zend, int32_t q,
                            int32_t n, const int32_t *yb, int32_t sy)
{
    int32_t k;
    while (*zx < ZONES && q >= *zend) { (*zx)++; *zend += c->zw; }
    if (*zx >= ZONES) return;
    if (q + n <= *zend) { zr[*zx] += sy; return; }
    for (k = 0; k < n; k++) {
        while (*zx < ZONES && q + k >= *zend) { (*zx)++; *zend += c->zw; }
        if (*zx >= ZONES) return;
        zr[*zx] += yb[k];
    }
}

/* pass 1 for quad row y (rows r0, r1): cell sums of log2 (ga) and Y (gb) for the grid row y / 8 (assigned at the
 * first of its 8 rows, added at the others), the zone column sums of the row (zrow[y]), clipped values (crow[y]) */
static void stats_qrow(struct night_tone_ctx *c, int32_t y, const uint16_t *r0, const uint16_t *r1)
{
    int32_t cy = y / GRID, first = (y & (GRID - 1)) == 0, GW = c->GW, cx, x, k;
    int32_t *ia = cy < c->GH ? c->ga + cy * GW : 0, *ya = cy < c->GH ? c->gb + cy * GW : 0;
    int64_t *zr = c->zrow + (int64_t)y * ZONES;
    int32_t zon = y / c->zh < ZONES, zx = 0, zend = c->zw, ry = row_ry(c, y), yb[GRID];
    uint32_t clip = 0, wh = (uint32_t)c->white;
#ifdef NT_NEON
    uint16x4_t cnt = vdup_n_u16(0);
    struct nk K;
    nk_init(c, &K, ry);
#endif
    for (k = 0; k < ZONES; k++) zr[k] = 0;
    for (cx = 0; cx < GW; cx++) {
        int32_t sy = 0, si = 0;
        x = cx * GRID;
        __builtin_prefetch(r0 + 2 * x + 192);
        __builtin_prefetch(r1 + 2 * x + 192);
#ifdef NT_NEON
        if (c->fast) cell_neon(c, &K, r0, r1, x, yb, &sy, &si, &cnt);
        else
#endif
        for (k = 0; k < GRID; k++) {
            int32_t v[4];
            yb[k] = quad_y(c, r0, r1, x + k, ry, v);
            sy += yb[k];
            si += quad_log2(c->lt, yb[k]);
            clip += clip4(r0, r1, x + k, wh);
        }
        if (ia) {
            if (first) { ia[cx] = si; ya[cx] = sy; }
            else { ia[cx] += si; ya[cx] += sy; }
        }
        if (zon) zone_add(c, zr, &zx, &zend, x, GRID, yb, sy);
    }
#ifdef NT_NEON
    {
        uint32x2_t s = vpaddl_u16(cnt);
        clip += vget_lane_u32(vpadd_u32(s, s), 0);
    }
#endif
    for (x = GW * GRID; x < c->W2; x++) {       /* quads right of the grid: zones and clipped values only */
        int32_t v[4];
        yb[0] = quad_y(c, r0, r1, x, ry, v);
        clip += clip4(r0, r1, x, wh);
        if (zon) zone_add(c, zr, &zx, &zend, x, 1, yb, yb[0]);
    }
    c->crow[y] = clip;
}

/* ------------------------------------------------------------------------------------------ pass 2 */

static void apply_qrow(struct night_tone_ctx *c, int32_t y)
{
    uint16_t *r0 = c->bayer + (int64_t)(2 * y) * c->stride, *r1 = r0 + c->stride;
    int32_t GW = c->GW, ry = row_ry(c, y), dclip = 0, x, j, k;
    int32_t gy = clampi(2 * y - 7, 0, 16 * (c->GH - 1)), y0 = gy >> 4, fy = gy & 15, y1 = y0 + 1 < c->GH ? y0 + 1 : c->GH - 1;
    const int32_t *A0 = c->ga + y0 * GW, *A1 = c->ga + y1 * GW, *B0 = c->gb + y0 * GW, *B1 = c->gb + y1 * GW;
    int32_t av = A0[0] * (16 - fy) + A1[0] * fy, bv = B0[0] * (16 - fy) + B1[0] * fy, xe;
#ifdef NT_NEON
    int32x4_t l0123 = vdupq_n_s32(0);
    struct nk K;
    l0123 = vsetq_lane_s32(1, l0123, 1); l0123 = vsetq_lane_s32(2, l0123, 2); l0123 = vsetq_lane_s32(3, l0123, 3);
    nk_init(c, &K, ry);
#endif
    /* quads 0..3: grid column 0 (fx = 0) */
    for (x = 0; x < 4; x++) quad_apply(c, r0, r1, x, ry, (av * 16) >> 8, bv * 16, &dclip);
    /* segment j: quads 8j + 4 .. 8j + 11 between grid columns j and j + 1, fx = 1, 3, .., 15 */
    for (j = 0; j + 1 < GW; j++) {
        int32_t an = A0[j + 1] * (16 - fy) + A1[j + 1] * fy, bn = B0[j + 1] * (16 - fy) + B1[j + 1] * fy;
        int32_t a0 = av * 16 + (an - av), b0 = bv * 16 + (bn - bv), da = 2 * (an - av), db = 2 * (bn - bv);
        x = 8 * j + 4;
        __builtin_prefetch(r0 + 2 * x + 192);
        __builtin_prefetch(r1 + 2 * x + 192);
        for (k = 0; k < GRID; k += 4) {
            int32_t ak = a0 + k * da, bk = b0 + k * db, m;
#ifdef NT_NEON
            if (c->fast && !grp_neon(c, &K, r0, r1, x + k, ak, da, bk, db, l0123)) continue;
#endif
            for (m = 0; m < 4; m++) quad_apply(c, r0, r1, x + k + m, ry, (ak + m * da) >> 8, bk + m * db, &dclip);
        }
        av = an; bv = bn;
    }
    /* quads from 8 GW - 4: grid column GW - 1 (fx = 0) */
    xe = 8 * GW - 4;
    for (x = xe; x < c->W2; x++) quad_apply(c, r0, r1, x, ry, (av * 16) >> 8, bv * 16, &dclip);
    c->drow[y] = dclip;
}

/* ------------------------------------------------------------------------------------------ grid filters */

/* 7x7 clamped window sums (np.pad edge) of an int32 grid, written in place through a 4-row ring: column sums slide
 * down (add row y + 3, take away row y - 4, both clamped, before row y - 4 is written back), row sums slide right.
 * mode 0: (a, b) of the guided filter from Ils (a to the grid, b to gb); mode 1: floor(sum / 49). */
static void box_rows(int32_t *g, int32_t *gb, int32_t GH, int32_t GW, int32_t *ring, int32_t *col1, int64_t *col2, int32_t mode)
{
    int32_t y, x, k;
    for (x = 0; x < GW; x++) {          /* column sums of rows -3 .. 3 (clamped) */
        int32_t s1 = 0;
        int64_t s2 = 0;
        for (k = -RAD; k <= RAD; k++) {
            int32_t v = g[clampi(k, 0, GH - 1) * GW + x];
            s1 += v;
            s2 += (int64_t)v * v;
        }
        col1[x] = s1;
        if (mode == 0) col2[x] = s2;
    }
    for (y = 0; y < GH; y++) {
        int32_t *out = ring + (y & 3) * GW, s1 = 0;
        int64_t s2 = 0;
        if (y > 0) {
            const int32_t *add = g + clampi(y + RAD, 0, GH - 1) * GW, *sub = g + clampi(y - RAD - 1, 0, GH - 1) * GW;
            if (mode == 0) {
                for (x = 0; x < GW; x++) {
                    col1[x] += add[x] - sub[x];
                    col2[x] += (int64_t)add[x] * add[x] - (int64_t)sub[x] * sub[x];
                }
            } else {
                for (x = 0; x < GW; x++) col1[x] += add[x] - sub[x];
            }
        }
        if (y >= 4) {                   /* row y - 4 is read by no later step */
            int32_t *src = ring + ((y - 4) & 3) * GW, *dst = g + (y - 4) * GW;
            for (x = 0; x < GW; x++) dst[x] = src[x];
        }
        for (k = -RAD; k <= RAD; k++) {
            s1 += col1[clampi(k, 0, GW - 1)];
            if (mode == 0) s2 += col2[clampi(k, 0, GW - 1)];
        }
        for (x = 0; x < GW; x++) {
            if (x > 0) {
                int32_t xa = x + RAD < GW ? x + RAD : GW - 1, xs = x - RAD - 1 > 0 ? x - RAD - 1 : 0;
                s1 += col1[xa] - col1[xs];
                if (mode == 0) s2 += col2[xa] - col2[xs];
            }
            if (mode == 0) {
                int64_t vs = (49 * s2 - (int64_t)s1 * s1) >> 16;   /* >= 0 */
                int32_t a = (int32_t)udiv_est((uint64_t)vs << 15, (uint64_t)(vs + EPS_GF));
                out[x] = a;
                /* floor(n / (49 * 2^17)) = floor(floor(n / 2^17) / 49); |n >> 17| < 2^26 */
                gb[y * GW + x] = floordiv49((int32_t)(((int64_t)s1 * (32768 - a)) >> 17));
            } else {
                out[x] = floordiv49(s1);
            }
        }
    }
    for (y = GH - 4 > 0 ? GH - 4 : 0; y < GH; y++) {
        int32_t *src = ring + (y & 3) * GW, *dst = g + y * GW;
        for (x = 0; x < GW; x++) dst[x] = src[x];
    }
}

/* ------------------------------------------------------------------------------------------ the interface */

int32_t night_tone_init(uint16_t *bayer, int32_t w, int32_t h, int32_t stride, int32_t black, int32_t white,
                        const uint16_t wb_q12[4], int32_t iso, const struct night_tone_lum *lum,
                        void *scratch, uint32_t scratch_bytes, struct night_tone_ctx **ctx)
{
    struct layout L;
    struct night_tone_ctx *c;
    uint8_t *S = (uint8_t *)scratch;
    int32_t sc, k1, k2, span, i, x;
    int64_t kc[4];
    if (ctx) *ctx = 0;
    /* ---- ref.check_args (same order) */
    if (!bayer || !wb_q12 || !ctx || layout_of(w, h, &L) || stride < w) return NT_ERR_ARG;
    if (black < 0 || white > 65535 || white - black < 256) return NT_ERR_ARG;
    for (i = 0; i < 4; i++) if (wb_q12[i] < 256) return NT_ERR_ARG;
    if (iso < 25 || iso > 3276800) return NT_ERR_ARG;
    sc = lum ? lum->scale_q16 : 65536; k1 = lum ? lum->vig_k1_q16 : 0; k2 = lum ? lum->vig_k2_q16 : 0;
    if (sc < 4096 || sc > 1048576 || k1 > (4 << 16) || k1 < -(4 << 16) || k2 > (4 << 16) || k2 < -(4 << 16)) return NT_ERR_ARG;
    if (!scratch || scratch_bytes < L.total) return NT_ERR_SCRATCH;
    if ((uintptr_t)scratch & 7) return NT_ERR_ARG;
    /* ---- ref.coeffs: LUMW = 60, 59, 59, 22 (1/200) */
    span = white - black;
    for (i = 0; i < 4; i++) {
        int64_t lw = i == 0 ? 60 : (i == 3 ? 22 : 59);
        kc[i] = (int64_t)udiv64((uint64_t)(lw * wb_q12[i] * sc * 256 + 100 * (int64_t)span), (uint64_t)(200 * span));
        if (kc[i] > (1 << 30)) return NT_ERR_ARG;
    }
    c = (struct night_tone_ctx *)scratch;
    c->ga = (int32_t *)(S + L.ga); c->gb = (int32_t *)(S + L.gb); c->ring = (int32_t *)(S + L.ring);
    c->col1 = (int32_t *)(S + L.col1); c->col2 = (int64_t *)(S + L.col2); c->zrow = (int64_t *)(S + L.zrow);
    c->crow = (uint32_t *)(S + L.crow); c->drow = (int32_t *)(S + L.drow); c->hist = (uint32_t *)(S + L.hist);
    c->cc = (int32_t *)(S + L.cc); c->vt = (int32_t *)(S + L.vt); c->lt = (int32_t *)(S + L.lt); c->gt = (int32_t *)(S + L.gt);
    /* ---- ref.vig_table (checked before anything is written to the image) */
    {
        int64_t vmax = 0, y0max = ((kc[0] + kc[1] + kc[2] + kc[3]) * 65535) >> 12;
        for (i = 0; i <= 4096; i++) {
            int64_t r = (int64_t)i << 4;
            int64_t v = 16384 + (((int64_t)k1 * r) >> 18) + (((int64_t)k2 * ((r * r) >> 16)) >> 18);
            if (v < 4096 || v >= (1 << 17)) return NT_ERR_ARG;
            if (v > vmax) vmax = v;
            c->vt[i] = (int32_t)(v << 13);
        }
        if (y0max >= ((int64_t)1 << 31) || ((y0max * vmax) >> 18) >= YLIM) return NT_ERR_ARG;
    }
    c->bayer = bayer; c->w = w; c->h = h; c->stride = stride; c->black = black; c->white = white; c->span = span;
    c->iso = iso; c->H2 = h / 2; c->W2 = w / 2; c->GH = c->H2 / GRID; c->GW = c->W2 / GRID;
    c->zh = c->H2 / ZONES; c->zw = c->W2 / ZONES; c->k1 = k1; c->k2 = k2; c->planned = 0; c->changed = 0; c->n_max = 0x7fffffff; c->d_max = 0x7fffffff;
    c->fast = 1;
    for (i = 0; i < 4; i++) {
        c->k[i] = (int32_t)kc[i]; c->kh[i] = (int32_t)(kc[i] >> 12); c->kl[i] = (int32_t)(kc[i] & 4095);
        if (c->kh[i] > 65535) c->fast = 0;      /* NEON kernels: 16-bit coefficients */
    }
    /* ---- ref.log2_table */
    for (i = 0; i < 1024; i++) c->lt[i] = (log2_q16((uint64_t)(2049 + 2 * i)) - 11 * 65536 + 8) >> 4;
    c->R4 = (h / 2) * (h / 2) + (w / 2) * (w / 2);
    for (x = 0; x < c->W2; x++) {
        int64_t dx = 2 * x + 1 - w / 2;
        c->cc[x] = (int32_t)udiv_bs((uint64_t)(dx * dx) << 20, (uint64_t)c->R4, 22);
    }
    *ctx = c;
    return NT_OK;
}

/* ref.apply's n_max_q16: N = min(N, n_max) (so g <= n_max and g + d <= n_max); after init, before plan */
int32_t night_tone_set_n_max(struct night_tone_ctx *c, int32_t n_max_q16)
{
    if (!c || c->planned || n_max_q16 < 0) return NT_ERR_ARG;
    c->n_max = n_max_q16;
    return NT_OK;
}

/* ref.apply's d_max_q16 (final build): d = min(d, d_max) after d is planned (g is not changed); after init, before plan */
int32_t night_tone_set_d_max(struct night_tone_ctx *c, int32_t d_max_q16)
{
    if (!c || c->planned || d_max_q16 < 0) return NT_ERR_ARG;
    c->d_max = d_max_q16;
    return NT_OK;
}

int32_t night_tone_stats_rows(struct night_tone_ctx *c, int32_t y0, int32_t y1)
{
    int32_t y;
    if (!c || y0 < 0 || y1 > c->h || y0 >= y1 || (y0 & 15) || ((y1 & 15) && y1 != c->h)) return NT_ERR_ARG;
    for (y = y0 / 2; y < y1 / 2; y++) {
        const uint16_t *r0 = c->bayer + (int64_t)(2 * y) * c->stride;
        stats_qrow(c, y, r0, r0 + c->stride);
    }
    return NT_OK;
}

int32_t night_tone_stats_feed(struct night_tone_ctx *c, int32_t y, const uint16_t *r0, const uint16_t *r1)
{
    if (!c || !r0 || !r1 || y < 0 || y >= c->H2) return NT_ERR_ARG;
    stats_qrow(c, y, r0, r1);
    return NT_OK;
}

int32_t night_tone_plan(struct night_tone_ctx *c, struct night_tone_info *out)
{
    int32_t GH, GW, zh, zw, i, y, it, g_full, g_cap, N, gg, d, lo, hi, l2q;
    int64_t g, Yz[NZ];
    uint32_t clip0 = 0, n, kk, left, sumb, *hist;
    if (out) {
        uint32_t *o = (uint32_t *)out;
        for (i = 0; i < (int32_t)(sizeof(*out) / 4); i++) o[i] = 0;
    }
    if (!c) return NT_ERR_ARG;
    GH = c->GH; GW = c->GW; zh = c->zh; zw = c->zw; hist = c->hist;
    /* ---- zone means, clipped values, histogram of the cell means */
    for (i = 0; i < NZ; i++) Yz[i] = 0;
    for (y = 0; y < c->H2; y++) {
        clip0 += c->crow[y];
        if (y / zh < ZONES) for (i = 0; i < ZONES; i++) Yz[(y / zh) * ZONES + i] += c->zrow[(int64_t)y * ZONES + i];
    }
    for (i = 0; i < NZ; i++) {
        int64_t s = Yz[i];
        uint64_t cnt = (uint64_t)zh * (uint64_t)zw;
        Yz[i] = s >= 0 ? (int64_t)udiv64((uint64_t)s, cnt) : -(int64_t)udiv64((uint64_t)(-s) + cnt - 1, cnt);
    }
    for (i = 0; i < 256; i++) hist[i] = 0;
    for (i = 0; i < GH * GW; i++) hist[clampi(c->gb[i] >> 18, 0, 255)]++;
    /* ---- AGC (libcamera AgcMeanLuminance) */
    g = 65536;
    for (it = 0; it < 8; it++) {
        int64_t thr = (int64_t)udiv64(((uint64_t)1 << 36) + (uint64_t)g - 1, (uint64_t)g), ys = 0, yy, ex;
        for (i = 0; i < NZ; i++) {
            int64_t z = Yz[i];
            ys += z >= thr ? ((int64_t)1 << 36) : (-z >= thr ? -((int64_t)1 << 36) : z * g);
        }
        yy = ys >= 0 ? (int64_t)udiv64((uint64_t)ys, NZ) : -(int64_t)udiv64((uint64_t)(-ys) + NZ - 1, NZ);
        if (yy < Y001_Q36) yy = Y001_Q36;
        ex = (int64_t)udiv64(C016_Q52, (uint64_t)yy);
        if (ex > EX_MAX_Q16) ex = EX_MAX_Q16;
        g = (g * ex) >> 16;
        if (g < 1) g = 1;
        if (100 * (ex > 65536 ? ex - 65536 : 65536 - ex) < 65536) break;
    }
    g_full = log2_q16((uint64_t)g) - (16 << 16);
    n = (uint32_t)(GH * GW);
    kk = n - (98 * n) / 100;
    sumb = 0; left = kk;
    for (i = 255; i >= 0 && left; i--) {
        uint32_t take = hist[i] < left ? hist[i] : left;
        sumb += (uint32_t)i * take;
        left -= take;
    }
    l2q = log2_q16((uint64_t)2 * sumb + kk) - log2_q16((uint64_t)2 * kk);
    lo = (7 << 16) - l2q;
    hi = (10 << 16) - log2_q16(5) - l2q;
    g_cap = g_full > lo ? g_full : lo;
    if (g_cap > hi) g_cap = hi;
    N = N0_Q16 + log2_q16(25600) - log2_q16((uint64_t)c->iso);
    if (N < 0) N = 0;
    if (N > c->n_max) N = c->n_max;
    gg = g_cap < N ? g_cap : N;
    if (gg < 0) gg = 0;
    d = g_full - gg < N - gg ? g_full - gg : N - gg;
    if (d > c->d_max) d = c->d_max;
    if (d < 0) d = 0;
    c->g = gg; c->d = d; c->n = N; c->g_full = g_full; c->g_cap = g_cap; c->clip0 = clip0;
    c->changed = gg > 0 || d > 0; c->planned = 1;
    if (out) {
        out->g_q16 = gg; out->d_q16 = d; out->n_q16 = N; out->g_full_q16 = g_full; out->g_cap_q16 = g_cap;
        out->g_q8 = q8(gg); out->d_q8 = q8(d); out->n_q8 = q8(N); out->g_full_q8 = q8(g_full); out->g_cap_q8 = q8(g_cap);
        out->dark_lift_q8 = q8(gg + d); out->pixels = (uint32_t)c->w * (uint32_t)c->h; out->clip_before = clip0;
        out->clip_after = clip0; out->clip_delta_ppm = 0; out->changed = c->changed;
    }
    if (!c->changed) return NT_OK;
    /* ---- guided filter coefficients: a -> ga (Q15), b -> gb (Q16); then the box means A, B */
    box_rows(c->ga, c->gb, GH, GW, c->ring, c->col1, c->col2, 0);
    box_rows(c->ga, 0, GH, GW, c->ring, c->col1, c->col2, 1);
    box_rows(c->gb, 0, GH, GW, c->ring, c->col1, c->col2, 1);
    /* ---- ref.gain_table, with the near-white threshold of each entry */
    {
        int64_t G = (int64_t)exp2_q(gg, 16);
        for (i = 0; i < NTAB; i++) {
            int64_t P = (int64_t)exp2_q((int64_t)(i + TMIN8) * 256, 30), Lq = P - (1 << 18), wq;
            uint32_t gi;
            if (Lq <= 0) wq = 65536;
            else {
                int64_t Lv = (Lq * G) >> 16;
                wq = Lv >= C016_Q30 ? 0 : 65536 - (int64_t)udiv_est((uint64_t)Lv << 16, C016_Q30);
            }
            gi = (uint32_t)exp2_q(gg + ((wq * d) >> 16), 16);
            c->gt[2 * i] = (int32_t)gi;
            {   /* th = ceil(((span << 16) - 32768) / gi), all in 32 bits */
                uint32_t nn = ((uint32_t)c->span << 16) - 32768u, qq = nn / gi;
                c->gt[2 * i + 1] = (int32_t)(qq + (qq * gi != nn));
            }
        }
    }
    return NT_OK;
}

int32_t night_tone_apply_rows(struct night_tone_ctx *c, int32_t y0, int32_t y1)
{
    int32_t y;
    if (!c || !c->planned || y0 < 0 || y1 > c->h || y0 >= y1 || ((y0 | y1) & 1)) return NT_ERR_ARG;
    if (!c->changed) return NT_OK;
    for (y = y0 / 2; y < y1 / 2; y++) apply_qrow(c, y);
    return NT_OK;
}

int32_t night_tone_finish(struct night_tone_ctx *c, struct night_tone_info *out)
{
    int64_t dl = 0;
    int32_t y;
    uint64_t ppm;
    if (!c || !c->planned || !out) return NT_ERR_ARG;
    if (!c->changed) return NT_OK;
    for (y = 0; y < c->H2; y++) dl += c->drow[y];
    ppm = udiv64((uint64_t)(dl < 0 ? -dl : dl) * 1000000u, (uint64_t)c->w * (uint64_t)c->h);
    out->clip_after = (uint32_t)((int64_t)c->clip0 + dl);
    out->clip_delta_ppm = dl < 0 ? -(int32_t)ppm : (int32_t)ppm;
    return NT_OK;
}

int32_t night_tone_apply(uint16_t *bayer, int32_t w, int32_t h, int32_t stride, int32_t black, int32_t white,
                         const uint16_t wb_q12[4], int32_t iso, const struct night_tone_lum *lum,
                         void *scratch, uint32_t scratch_bytes, struct night_tone_info *out)
{
    struct night_tone_ctx *c;
    int32_t r;
    if (out) {
        uint32_t *o = (uint32_t *)out;
        for (r = 0; r < (int32_t)(sizeof(*out) / 4); r++) o[r] = 0;
    }
    r = night_tone_init(bayer, w, h, stride, black, white, wb_q12, iso, lum, scratch, scratch_bytes, &c);
    if (r) return r;
    night_tone_stats_rows(c, 0, h);
    night_tone_plan(c, out);
    night_tone_apply_rows(c, 0, h);
    if (out) night_tone_finish(c, out);
    return NT_OK;
}
