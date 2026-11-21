/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR IV (firmware 1.20 and 1.21) auto white balance, rewritten from scratch. Integer only, position independent, no global data,
 * no firmware address: the two the module reads (flash_mgr, seq_wait) come in the context, from the release's address table.
 * Behaviour: golden.py (float). Tables and constants: tables.py.
 *
 * awb2(ctx, obj, S, rec) is called in place of the camera's final stage call inside the Auto estimate (after that stage ran):
 *   obj  the Auto estimator object (gains at +4 R, +0xA B, 1.13 fixed point)
 *   S    the settings block (+0 .. +0x10 pointers to the per-block u32 arrays R, Gr, Gb, B, count; +0x14 stride;
 *        +0x1C x0, +0x1E y0, +0x20 w, +0x22 h; +0x24 Av word (-0x880: no exposure); +0x30 brightness Av + Tv - Sv in 1/256 EV;
 *        +0x34 white balance mode: 0 Auto, 1 Warmth Priority, 2 White Priority; +0x68 / +0x6E capture gain words)
 *   rec  0 in live view, the capture record for a still
 *
 * Live view computes on one call in AWB2_PERIOD, spread over two consecutive calls; the calls between repeat the state.
 *
 * One estimator and one state: live view filters the single-frame estimates; a still takes the live view state (the picture has
 * the white balance the screen showed) unless its own estimate is far from it or there is no state. The three modes share the
 * estimate and differ only in how much of a warm light's colour is deliberately left (nothing at and beyond daylight).
 */
#include "awb2_const.h"

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;
typedef short i16;
typedef unsigned long long u64;
typedef long long i64;

struct awb2_ctx {
  u32 magic;
  void *(*alloc)(u32 bytes);
  void **slot;                 /* persistent pointer to the scratch (0 at start-up) */
  const u32 *lnm;              /* [257]  2^24 ln(1 + i/256) */
  const i32 *ff;               /* [2][4096][2] filter spectra, Q(AWB2_FQ), (re, im) */
  const i32 *bias;             /* [4][4096] Q14: [1, e, tanh 2e] with a known brightness, map 3 alone without */
  const i32 *tw;               /* [32][2] cos, sin of 2 pi k / 64, Q30 */
  const i16 *tanh;             /* [AWB2_NTANH] Q12, tanh(2 e) at brightness steps of 16 from AWB2_E_LO */
  const u32 *exp2n;            /* [257] 2^30 2^(-i/256) */
  const u32 *atan;             /* [28] atan(2^-i) in turns, Q32 */
  const i32 *cs20;             /* [64][2] cos, sin of the bin angles, Q20 */
  const u32 *rc;               /* [9] ceil(2^20 / n) */
  const u32 *flash_mgr;        /* the word holding the flash data manager's pointer (0 until set up): +0x10 of the static object of its getter */
  const u8 *seq_wait;          /* the shooting sequence controller's +0x124, "still waiting for the flash charge" (see flash_fires) */
};

/* Diagnostic record: the first AWB2_DIAG_SIZE bytes of the state, little endian, for a build that copies them into the photo
 * (the state pointer is the word at ctx->slot). Written by every call; a capture fills the cap_ fields last. */
#define AWB2_DIAG_SIZE 64
#define AWB2_DIAG_MAGIC 0x31445741u      /* "AWD1" */
struct awb2_diag {
  u32 magic;
  u16 lv_calls, lv_done;       /* live view calls / completed computations since the state was made (wrap) */
  i32 lv_e30;                  /* S+0x30 of the last live view computation, as read */
  u8 lv_exp, lv_mode;          /* its brightness was accepted (1) or the unknown-brightness prior used (0); its S+0x34 */
  u8 cap_exp;                  /* the capture's brightness was accepted */
  u8 cap_path;                 /* 1 = live view state used, 2 = the capture's own estimate, 3 = nothing written (the camera's result stays),
                                  4 = not an Auto mode, 5 = flash: the camera's result stays */
  i32 lv_mu[2];                /* live view state when the capture came (u, v Q16), 0 if none */
  i32 cap_e30, cap_v24;        /* S+0x30, S+0x24 of the capture */
  i32 cap_z[2];                /* the capture's own estimate (u, v Q16), 0 if it had too little valid */
  u32 cap_r[2];                /* its variances Q32 */
  u16 cap_n, cap_valid;        /* blocks of the capture frame; of these valid */
  u16 cap_few, cap_bright;     /* rejected for too few counted pixels / a channel above 0xF6D (the rest: a channel below 4) */
  u16 cap_gr, cap_gb;          /* the gain words written (0 if none) */
  u16 lv_valid;                /* valid blocks of the last live view computation */
  u8 cap_mode, caps;           /* S+0x34 of the capture; captures since the state was made (wrap) */
};

typedef char awb2_diag_size_check[sizeof(struct awb2_diag) == AWB2_DIAG_SIZE ? 1 : -1];

struct awb2_state {
  struct awb2_diag d;
  /* work arrays */
  i32 are[4096], aim[4096];
  i32 bre[4096], bim[4096];
  /* live view state, model units (before the mode's retention): u, v in Q16 log units, variances Q32 */
  u32 have;
  i32 mu[2];
  u32 sg[2];
  u32 cand;
  i32 cz[2];
  u32 left;                    /* live view calls until the next computation */
  u32 phase;                   /* live view: 1 = the first half of a computation is in the work arrays */
  u32 pexp;                    /* its exposure */
  i32 pe30;
  u16 nvalid, nfew, nbright;   /* block counts of the last observe_a */
  u32 cfull, cgeom;            /* live view: the largest pixel count a block had so far, and the window it belongs to */
  u64 pu[64], pv[64];          /* softmax marginals (work) */
};

#ifdef AWB2_HOST
extern const unsigned char *awb2_host_base;
#define S_PTR(v) ((const u32 *)(awb2_host_base + (v)))
#define B_PTR(v) ((const u8 *)(awb2_host_base + (v)))
extern const unsigned char *awb2_host_fm;
extern unsigned char awb2_host_wait;
#define FLASH_MANAGER(ctx) ((void)(ctx), awb2_host_fm)
#define FLASH_WAITING(ctx) ((void)(ctx), awb2_host_wait)
#else
#define B_PTR(v) ((const u8 *)(v))
/* the flash data manager (0 until set up) and the shooting sequence controller's byte: their addresses are in awb2.ts */
#define FLASH_MANAGER(ctx) ((const u8 *)*(ctx)->flash_mgr)
#define FLASH_WAITING(ctx) (*(ctx)->seq_wait)
#define S_PTR(v) ((const u32 *)(v))
#endif

void awb2(const struct awb2_ctx *ctx, u8 *obj, const u8 *S, const void *rec);

static u32 rd16(const u8 *p) { return (u32)p[0] | ((u32)p[1] << 8); }
static u32 rd32(const u8 *p) { return rd16(p) | (rd16(p + 2) << 16); }
static void wr16(u8 *p, u32 v) { p[0] = (u8)v; p[1] = (u8)(v >> 8); }

static u32 bits32(u32 x) { return x ? 32 - (u32)__builtin_clz(x) : 0; }      /* one CLZ instruction on the camera's CPU */
static u32 bits64(u64 x) { u32 h = (u32)(x >> 32); return h ? 32 + bits32(h) : bits32((u32)x); }

/* floor(n / d), d != 0, by shift and subtract (no library call) */
static u64 udiv64(u64 n, u64 d) {
  u64 q = 0, r = 0;
  i32 i;
  for (i = 63; i >= 0; i--) {
    r = (r << 1) | ((n >> i) & 1);
    if (r >= d) { r -= d; q |= (u64)1 << i; }
  }
  return q;
}

/* 2^24 ln(x), x >= 1 */
static i32 ln24(const struct awb2_ctx *ctx, u32 x) {
  u32 n = bits32(x) - 1;
  u32 m = x << (31 - n);                     /* 1.0 <= m < 2.0 at bit 31 */
  u32 idx = (m >> 23) & 0xff, fr = (m >> 7) & 0xffff;
  u32 a = ctx->lnm[idx], b = ctx->lnm[idx + 1];
  return (i32)(n * (u32)AWB2_LN2Q24 + a + (u32)(((u64)(b - a) * fr + 32768) >> 16));
}

static i32 ln24_64(const struct awb2_ctx *ctx, u64 x) {
  u32 b = bits64(x);
  if (b <= 32) return ln24(ctx, (u32)x);
  return ln24(ctx, (u32)(x >> (b - 32))) + (i32)((b - 32) * (u32)AWB2_LN2Q24);
}

static u32 bin_of(i32 lg, i32 lx, i32 org) { return (u32)((lg - lx - org) >> 19) & 63; }

/* in-place 64-point FFT of the complex sequence re[k * st], im[k * st]; inv: e^{+i}, else e^{-i}. No scaling. */
static void fft64(const i32 *tw, i32 *re, i32 *im, u32 st, u32 inv) {
  u32 i, j, len, half, step, k;
  for (i = 0; i < 64; i++) {
    j = ((i & 1) << 5) | ((i & 2) << 3) | ((i & 4) << 1) | ((i & 8) >> 1) | ((i & 16) >> 3) | ((i & 32) >> 5);
    if (j > i) {
      i32 t = re[i * st]; re[i * st] = re[j * st]; re[j * st] = t;
      t = im[i * st]; im[i * st] = im[j * st]; im[j * st] = t;
    }
  }
  for (len = 2; len <= 64; len <<= 1) {
    half = len >> 1; step = 64 / len;
    for (k = 0; k < half; k++) {
      i32 c = tw[2 * k * step], s = tw[2 * k * step + 1];
      if (!inv) s = -s;
      for (i = k; i < 64; i += len) {
        u32 a = i * st, b = (i + half) * st;
        i32 xr = re[b], xi = im[b];
        i32 tr = (i32)(((i64)xr * c - (i64)xi * s + (1 << 29)) >> 30);
        i32 ti = (i32)(((i64)xr * s + (i64)xi * c + (1 << 29)) >> 30);
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

static void fft2d(const i32 *tw, i32 *re, i32 *im, u32 inv) {
  u32 i;
  for (i = 0; i < 64; i++) fft64(tw, re + 64 * i, im + 64 * i, 1, inv);
  for (i = 0; i < 64; i++) fft64(tw, re + i, im + i, 64, inv);
}

/* scales a histogram to a total of 2^20 */
static void normalise(i32 *h, u64 tot) {
  u64 inv;
  u32 i;
  if (!tot) return;
  inv = udiv64((u64)1 << 44, tot);
  for (i = 0; i < 4096; i++) if (h[i]) h[i] = (i32)(((u64)(u32)h[i] * inv) >> 24);
}

/* angle of (x, y) in turns, Q32 */
static u32 atan2_turn(const struct awb2_ctx *ctx, i32 y, i32 x) {
  u32 ang = 0, i;
  if (x < 0) { x = -x; y = -y; ang = 0x80000000u; }
  for (i = 0; i < 28; i++) {
    i32 xs = x >> i, ys = y >> i;
    if (y > 0) { x += ys; y -= xs; ang += ctx->atan[i]; }
    else { x -= ys; y += xs; ang -= ctx->atan[i]; }
  }
  return ang;
}

/* circular mean (bins, as turns Q32) and variance (log units^2, Q32, clamped) of a marginal of 64 weights */
static void circ(const struct awb2_ctx *ctx, const u64 *p, u32 *turn, u32 *var) {
  u64 tot = 0, T, mag;
  i64 C = 0, Sn = 0;
  u32 k, sh, b;
  i32 d;
  for (k = 0; k < 64; k++) tot += p[k];
  b = bits64(tot); sh = b > 30 ? b - 30 : 0;
  T = 0;
  for (k = 0; k < 64; k++) {
    u32 q = (u32)(p[k] >> sh);
    C += (i64)q * ctx->cs20[2 * k]; Sn += (i64)q * ctx->cs20[2 * k + 1];
    T += (u64)q << 20;
  }
  mag = (u64)(C < 0 ? -C : C) | (u64)(Sn < 0 ? -Sn : Sn);
  b = bits64(mag); sh = b > 28 ? b - 28 : 0;
  {
    i32 c = (i32)(C >> sh), s = (i32)(Sn >> sh);      /* arithmetic shifts */
    u64 m2 = (u64)((i64)c * c) + (u64)((i64)s * s);
    *turn = atan2_turn(ctx, s, c);
    if (!m2 || !(T >> sh)) { *var = AWB2_R_MAX; return; }
    d = ln24_64(ctx, T >> sh) - ln24_64(ctx, m2) / 2;
  }
  if (d <= 0) { *var = AWB2_R_MIN; return; }
  if (d > (5 << 20)) { *var = AWB2_R_MAX; return; }
  {
    u64 v = ((u64)(u32)d * AWB2_VARK) >> 10;
    *var = v < AWB2_R_MIN ? AWB2_R_MIN : v > AWB2_R_MAX ? AWB2_R_MAX : (u32)v;
  }
}

/* Single-frame estimate in two halves, so that live view can spread it over two frames.
 * First half: statistics -> histograms -> spectrum of the filtered sum (in bre / bim). Returns 0 when too little of the frame is valid. */
/* The pixel count of a block is on the frame's own scale: 1584 per block in a still (all 124 DNGs looked at), far fewer in the
 * small live view frames. Counts are brought to the still's scale by the largest count: of this frame for a still (`keep` 0),
 * of all frames of this window so far in live view (`keep` 1; one frame may have no block without clipped pixels). Until
 * 2026-11-14 the counts were compared with 1584 as they came: every live view block was "too few pixels", live view never had
 * an estimate, the screen showed the camera's own white balance and every picture its own estimate. */
static u32 observe_a(const struct awb2_ctx *ctx, struct awb2_state *st, const u8 *S, u32 keep) {
  const u32 *pr = S_PTR(rd32(S + 0)), *pgr = S_PTR(rd32(S + 4)), *pgb = S_PTR(rd32(S + 8)), *pb = S_PTR(rd32(S + 12)), *pc = S_PTR(rd32(S + 16));
  u32 stride = rd16(S + 0x14), x0 = rd16(S + 0x1c), y0 = rd16(S + 0x1e), w = rd16(S + 0x20), h = rd16(S + 0x22);
  u32 x, y, i, n = w * h;
  u64 t1 = 0, t2 = 0, wsum = 0;
  u32 nvalid = 0, nfew = 0, nbright = 0, cref = 0, cscale;
  const u32 *rc = ctx->rc;
  for (i = 0; i < 4096; i++) { st->are[i] = 0; st->aim[i] = 0; }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    u32 c = pc[(y0 + y) * stride + x0 + x];
    if (c > 0xffff) c = 0xffff;
    if (c > cref) cref = c;
  }
  if (keep) {
    u32 geom = w | (h << 8) | (stride << 16);
    if (st->cgeom != geom) { st->cgeom = geom; st->cfull = 0; }
    if (cref > st->cfull) st->cfull = cref;
    cref = st->cfull;
  }
  if (!cref) { st->nvalid = 0; st->nfew = (u16)n; st->nbright = 0; return 0; }
  cscale = (u32)udiv64((u64)1584 << 16, cref);                 /* Q16; 65536 exactly for a still */
  /* pass 1: validity, packed block values, histogram of block colours */
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    u32 k = (y0 + y) * stride + x0 + x, o = y * w + x;
    u32 rv = pr[k], gv = (pgr[k] + pgb[k] + 1) >> 1, bv = pb[k], c = pc[k];
    u32 mn = rv < gv ? rv : gv, mx = rv > gv ? rv : gv;
    if (bv < mn) mn = bv;
    if (bv > mx) mx = bv;
    if (c > 0xffff) c = 0xffff;
    c = (u32)(((u64)c * cscale + 0x8000) >> 16);
    if (c * 5 > 1584 && mn >= 4 && mx <= 0xF6D) {
      i32 lg = ln24(ctx, gv + 1);
      st->bre[o] = (i32)(rv | (gv << 16)); st->bim[o] = (i32)(bv | (1u << 16));
      st->are[bin_of(lg, ln24(ctx, rv + 1), AWB2_U0Q24) * 64 + bin_of(lg, ln24(ctx, bv + 1), AWB2_V0Q24)] += (i32)c;
      t1 += c; wsum += c; nvalid++;
    } else { st->bre[o] = 0; st->bim[o] = 0; if (c * 5 <= 1584) nfew++; else if (mx > 0xF6D) nbright++; }
  }
  st->nvalid = (u16)nvalid; st->nfew = (u16)nfew; st->nbright = (u16)nbright;
  if (wsum * 20 < (u64)n * 1584) return 0;
  /* pass 2: local colour contrast against the mean of the valid neighbours */
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    u32 o = y * w + x, cnt = 0, ar = 0, ag = 0, ab = 0, er, eg, eb, wt;
    i32 dy, dx, lg;
    if (!st->bim[o]) continue;
    for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) {
      u32 yy = y + (u32)dy, xx = x + (u32)dx, q;
      if ((!dy && !dx) || yy >= h || xx >= w) continue;
      q = yy * w + xx;
      if (!st->bim[q]) continue;
      cnt++; ar += (u32)st->bre[q] & 0xffff; ag += (u32)st->bre[q] >> 16; ab += (u32)st->bim[q] & 0xffff;
    }
    if (!cnt) continue;
    er = ((u32)st->bre[o] & 0xffff) * cnt; er = er > ar ? er - ar : ar - er;
    eg = ((u32)st->bre[o] >> 16) * cnt; eg = eg > ag ? eg - ag : ag - eg;
    eb = ((u32)st->bim[o] & 0xffff) * cnt; eb = eb > ab ? eb - ab : ab - eb;
    wt = (u32)(((u64)((er + eg + eb) << 4) * rc[cnt]) >> 20);        /* 16 x the summed contrast */
    if (!wt) continue;
    lg = ln24(ctx, eg + cnt);
    st->aim[bin_of(lg, ln24(ctx, er + cnt), AWB2_U0Q24) * 64 + bin_of(lg, ln24(ctx, eb + cnt), AWB2_V0Q24)] += (i32)wt;
    t2 += wt;
  }
  normalise(st->are, t1);
  normalise(st->aim, t2);
  /* one FFT for both real histograms (h1 + i h2), the two spectra separated by symmetry, times the filters, summed */
  fft2d(ctx->tw, st->are, st->aim, 0);
  for (i = 0; i < 4096; i++) {
    u32 m = (((64 - (i >> 6)) & 63) << 6) | ((64 - (i & 63)) & 63);
    i64 x1r = (i64)st->are[i] + st->are[m], x1i = (i64)st->aim[i] - st->aim[m];       /* 2 X1 */
    i64 x2r = (i64)st->aim[i] + st->aim[m], x2i = (i64)st->are[m] - st->are[i];       /* 2 X2 */
    const i32 *f1 = ctx->ff + 2 * i, *f2 = ctx->ff + 8192 + 2 * i;
    i64 zr = x1r * f1[0] - x1i * f1[1] + x2r * f2[0] - x2i * f2[1];
    i64 zi = x1r * f1[1] + x1i * f1[0] + x2r * f2[1] + x2i * f2[0];
    st->bre[i] = (i32)((zr + ((i64)1 << (AWB2_FQ + 18))) >> (AWB2_FQ + 19));           /* / 2, / 2^20, / 4096, to Q14 */
    st->bim[i] = (i32)((zi + ((i64)1 << (AWB2_FQ + 18))) >> (AWB2_FQ + 19));
  }
  return 1;
}

/* Second half: scores, brightness-dependent bias, softmax -> z = (u, v) Q16 and r = variances Q32. */
static void observe_b(const struct awb2_ctx *ctx, struct awb2_state *st, u32 has_exp, i32 e30, i32 *z, u32 *r) {
  u64 *pu = st->pu, *pv = st->pv;
  const i32 *b0 = ctx->bias;
  i32 eq, tq, smax;
  u32 i;
  fft2d(ctx->tw, st->bre, st->bim, 1);
  if (has_exp) {
    u32 k, f;
    if (e30 < AWB2_E_LO) e30 = AWB2_E_LO;
    if (e30 > AWB2_E_HI) e30 = AWB2_E_HI;
    eq = (e30 - 1024) * 4;
    k = (u32)(e30 - AWB2_E_LO) >> 4; f = (u32)(e30 - AWB2_E_LO) & 15;
    tq = ctx->tanh[k] + (((ctx->tanh[k + 1] - ctx->tanh[k]) * (i32)f + 8) >> 4);
  } else { eq = 0; tq = 0; b0 = ctx->bias + 3 * 4096; }
  smax = -0x7fffffff;
  for (i = 0; i < 4096; i++) {
    i32 s = st->bre[i] + b0[i] + (i32)(((i64)eq * ctx->bias[4096 + i] + 2048) >> 12) + (i32)(((i64)tq * ctx->bias[8192 + i] + 2048) >> 12);
    st->bre[i] = s;
    if (s > smax) smax = s;
  }
  for (i = 0; i < 64; i++) { pu[i] = 0; pv[i] = 0; }
  for (i = 0; i < 4096; i++) {
    u32 d = (u32)(smax - st->bre[i]), yq, k, f, a, b, p;
    if (d >= (21u << 14)) continue;
    yq = (u32)(((u64)d * AWB2_INVLN2Q16) >> 14);       /* (smax - s) / ln 2, Q16 */
    k = yq >> 16; f = (yq >> 8) & 0xff;
    a = ctx->exp2n[f]; b = ctx->exp2n[f + 1];
    p = (a - (u32)(((u64)(a - b) * (yq & 0xff) + 128) >> 8)) >> k;
    pu[i >> 6] += p; pv[i & 63] += p;
  }
  {
    u32 tu, tv;
    circ(ctx, pu, &tu, &r[0]);
    circ(ctx, pv, &tv, &r[1]);
    z[0] = AWB2_U0Q16 + (i32)(tu >> 15) + 1024;         /* (bin + 0.5) / 32 */
    z[1] = AWB2_V0Q16 + (i32)(tv >> 15) + 1024;
  }
}

/* live view filter (golden.Preview.update) */
static void kalman(struct awb2_state *st, const i32 *z, const u32 *r) {
  u32 a, far = 0;
  u64 sg[2];
  if (!st->have) { st->have = 1; st->cand = 0; for (a = 0; a < 2; a++) { st->mu[a] = z[a]; st->sg[a] = r[a]; } return; }
  for (a = 0; a < 2; a++) {
    i64 d = (i64)z[a] - st->mu[a];
    sg[a] = (u64)st->sg[a] + AWB2_KQ;
    if ((u64)(d * d) > (u64)AWB2_GATE * (sg[a] + r[a])) far = 1;
  }
  if (far) {
    u32 ok = st->cand;
    for (a = 0; ok && a < 2; a++) {
      i64 d = (i64)z[a] - st->cz[a];
      if (d < 0) d = -d;
      if (d > AWB2_CONF_SLACK && (u64)((d - AWB2_CONF_SLACK) * (d - AWB2_CONF_SLACK)) >= (u64)9 * ((u64)r[a] + AWB2_R_MIN)) ok = 0;
    }
    if (ok) { for (a = 0; a < 2; a++) { st->mu[a] = (z[a] + st->cz[a]) / 2; st->sg[a] = r[a]; } st->cand = 0; }
    else { for (a = 0; a < 2; a++) { st->cz[a] = z[a]; st->sg[a] = sg[a] > 0xffffffffu ? 0xffffffffu : (u32)sg[a]; } st->cand = 1; }
    return;
  }
  st->cand = 0;
  for (a = 0; a < 2; a++) {
    u32 k = (u32)udiv64(sg[a] << 16, sg[a] + r[a]);          /* Q16 gain */
    i64 d = (i64)z[a] - st->mu[a];
    st->mu[a] += (i32)((d * k + 32768) >> 16);
    st->sg[a] = (u32)((sg[a] * (65536 - k)) >> 16);
  }
}

/* the mode's retention of a warm light's colour, then the camera's gains */
static u32 gain(const struct awb2_ctx *ctx, u32 cq30, i32 uq16, u32 word) {
  i64 yq = ((i64)uq16 * AWB2_INVLN2Q16) >> 16;              /* u / ln 2, Q16 */
  i32 k = (i32)(yq >> 16) + 1;                               /* 2^(u / ln 2) = 2^k 2^-(1 - frac) */
  u32 g = 65536 - (u32)(yq & 0xffff), f = g >> 8, a, b, m;
  u64 v;
  if (g == 65536) { a = ctx->exp2n[256]; b = a; f = 255; }
  else { a = ctx->exp2n[f]; b = ctx->exp2n[f + 1]; }
  m = a - (u32)(((u64)(a - b) * (g & 0xff) + 128) >> 8);     /* Q30 */
  v = ((u64)cq30 * m) >> 30;                                 /* Q30 */
  if (k >= 17) return 0xffff;
  if (k < -13) return 1;
  v = k >= 0 ? (v << k) >> 17 : v >> (17 - k);               /* x 8192 */
  if (word) v = (v * word + 0x1000) >> 13;
  return v > 0xffff ? 0xffff : v < 1 ? 1 : (u32)v;
}

static void put(const struct awb2_ctx *ctx, u8 *obj, const u8 *S, const i32 *zin, u32 mode) {
  i64 xq = (((i64)zin[1] - zin[0]) * AWB2_INVLN2Q16) >> 16;  /* warmth, Q16 */
  i64 s = ((xq - AWB2_X_ZERO_Q16) * AWB2_X_SPAN_INV_Q16) >> 16;
  i32 k;
  if (s < 0) s = 0;
  if (s > 65536) s = 65536;
  k = (i32)((s * (mode == 0 ? AWB2_RETK_AUTO : mode == 1 ? AWB2_RETK_WARM : AWB2_RETK_WHITE) + 32768) >> 16);
  wr16(obj + 4, gain(ctx, AWB2_CR_Q30, zin[0] + k, rd16(S + 0x68)));
  wr16(obj + 0xA, gain(ctx, AWB2_CB_Q30, zin[1] - k, rd16(S + 0x6E)));
  obj[0xAF89] = 0;
}

/* Was this picture lit by the flash? The body decides once, in the release sequence before the exposure: it reads the ready bit of the flash (flash data manager +0x77 bit 0), and stores in its controller +0x124
 * "still waiting for the charge": cleared on entry, 1 if not ready, cleared again when the flash reports ready while it waits.
 * 0 = the main flash fires. Nothing sets it to 1 after the check (static reading of the firmware;
 * the rule has been in every build used on the camera since 2026-11-12).
 * The ready bit itself cannot be used here: read at the capture's AWB it was 0 in 9 of 10 fired frames (the flash has just
 * discharged), and live view's last reading of it was 0 in 17 of 35 more.
 * The flash type (manager +0x14: 0 none, 0x10 GF-2 class, 1..4 flashes that communicate) says whether there is a flash at all;
 * without one the controller byte is whatever the last check left. */
static u32 flash_fires(const struct awb2_ctx *ctx) {
  const u8 *fm = FLASH_MANAGER(ctx);
  return fm && fm[0x14] && FLASH_WAITING(ctx) == 0;
}

void awb2(const struct awb2_ctx *ctx, u8 *obj, const u8 *S, const void *rec) {
  struct awb2_state *st, *cw;
  u32 mode, w, h, stride, x0, y0, ok, has_exp;
  i32 e30, z[2];
  u32 r[2];
  if (ctx->magic != AWB2_MAGIC || !ctx->alloc || !ctx->slot || !ctx->flash_mgr || !ctx->seq_wait) return;
  st = (struct awb2_state *)*ctx->slot;
  mode = rd32(S + 0x34);
  if (mode > 2) {                                              /* not an Auto mode: the camera's result stays */
    if (st && !rec) { st->have = 0; st->left = 0; st->phase = 0; }
    if (st && rec) { st->d.cap_path = 4; st->d.cap_mode = (u8)mode; st->d.caps++; }
    return;
  }
  stride = rd16(S + 0x14); x0 = rd16(S + 0x1c); y0 = rd16(S + 0x1e); w = rd16(S + 0x20); h = rd16(S + 0x22);
  if (w < 1 || w > 64 || h < 1 || h > 64 || w * h > 4096) return;
  if ((u64)(y0 + h - 1) * stride + x0 + w > (1u << 24)) return;
  if (!st) {
    st = (struct awb2_state *)ctx->alloc(2 * sizeof(struct awb2_state));    /* [0] the state and live view's work arrays, [1] the capture's work arrays */
    if (!st) return;
    st->have = 0; st->cand = 0; st->left = 0; st->phase = 0; st->cfull = 0; st->cgeom = 0;
    { u8 *q = (u8 *)&st->d; u32 i; for (i = 0; i < sizeof(st->d); i++) q[i] = 0; }
    st->d.magic = AWB2_DIAG_MAGIC;
    *ctx->slot = st;
  }
  e30 = (i32)rd32(S + 0x30);
  has_exp = e30 >= -2560 && e30 <= 4608;                      /* EV -10 .. +18 */
  if (rec && (i32)rd32(S + 0x24) == -0x880) has_exp = 0;
  if (!rec) {
    st->d.lv_calls++;
    if (st->phase) {                                           /* the second half of the computation started on the previous call */
      st->phase = 0; st->left = AWB2_PERIOD - 2;
      observe_b(ctx, st, st->pexp, st->pe30, z, r);
      kalman(st, z, r);
      st->d.lv_done++; st->d.lv_e30 = st->pe30; st->d.lv_exp = (u8)st->pexp; st->d.lv_mode = (u8)mode; st->d.lv_valid = st->nvalid;
    } else if (st->left) st->left--;
    else if (observe_a(ctx, st, S, 1)) { st->phase = 1; st->pexp = has_exp; st->pe30 = e30; }
    else st->left = AWB2_PERIOD - 1;
    if (st->have) put(ctx, obj, S, st->mu, mode);
    return;
  }
  /* A capture computes in its own work arrays: live view calls can run while it does (they did with flash on the camera: captures
   * came out with the bias maps' answer for empty histograms), and a live view computation in progress stays intact. */
  cw = st + 1;
  /* A picture lit by the flash keeps the camera's own white balance: the exposure says "dim, lamp light" while the subject is
   * lit by the flash, and the estimate then turns flash-lit subjects blue. */
  if (flash_fires(ctx)) {
    st->d.caps++; st->d.cap_path = 5; st->d.cap_mode = (u8)mode; st->d.cap_gr = 0; st->d.cap_gb = 0; return;
  }
  z[0] = 0; z[1] = 0; r[0] = 0; r[1] = 0;
  ok = observe_a(ctx, cw, S, 0);
  if (ok) observe_b(ctx, cw, has_exp, e30, z, r);
  {
    struct awb2_diag *d = &st->d;
    d->caps++; d->cap_exp = (u8)has_exp; d->cap_mode = (u8)mode; d->cap_e30 = e30; d->cap_v24 = (i32)rd32(S + 0x24);
    d->lv_mu[0] = st->have ? st->mu[0] : 0; d->lv_mu[1] = st->have ? st->mu[1] : 0;
    d->cap_z[0] = z[0]; d->cap_z[1] = z[1]; d->cap_r[0] = r[0]; d->cap_r[1] = r[1];
    d->cap_n = (u16)(w * h); d->cap_valid = cw->nvalid; d->cap_few = cw->nfew; d->cap_bright = cw->nbright;
    d->cap_path = 3; d->cap_gr = 0; d->cap_gb = 0;
  }
  if (st->have) {
    i32 du = z[0] - st->mu[0], dv = z[1] - st->mu[1], dw = dv - du, dt = du + dv;
    if (dw < 0) dw = -dw;
    if (dt < 0) dt = -dt;
    if (!ok || (dw <= AWB2_FAR_W && dt <= AWB2_FAR_T)) { put(ctx, obj, S, st->mu, mode); st->d.cap_path = 1; ok = 0; }
  }
  if (ok) { put(ctx, obj, S, z, mode); st->d.cap_path = 2; }
  if (st->d.cap_path != 3) { st->d.cap_gr = (u16)rd16(obj + 4); st->d.cap_gb = (u16)rd16(obj + 0xA); }
}
