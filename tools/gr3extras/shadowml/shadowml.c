/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod (experimental): a learned Auto for Shadow Correction on the Ricoh GR III / GR IIIx (2.10 / 2.20 / 2.21, IIIx 1.60 ..
 * 1.71): GR IV's module (tools/gr4v120/shadowml/shadowml.c, the same features, model blob and arithmetic, bit-exact with
 * tools/gr4v120/shadowml/ref.py) with GR III's offsets in the shooting record and one RAM word instead of two.
 *
 * The camera's own Auto decision of the shadow-correction core (ToneControlTuning, GR III 0x536E9558, GR IV 0x53947230) is
 * replaced by a strength t (0..0x800) that a gradient-boosted tree model computes from the AWB's block statistics. See the GR IV
 * source for the features; core/src/fw/gr3x/shadowml.ts for the hook.
 *
 *   i32 shadowml(const struct shadowml_ctx *ctx, const u8 *P, u32 mode, u32 hl, u32 idx)
 *
 * What differs from GR IV's module:
 *  - The block statistics. GR III's shooting record P keeps the same statistics structure as GR IV's (the Y-array builder,
 *    GR III 0x536C2A30 / GR IV 0x5391F1D4, fills it with the same code: grid w, h at +0 / +2, planes R +0x14018, Gr +0x18018,
 *    Gb +0x1C018, B +0x20018, Y +0x24018, count +0x26018), but at other places in P: stills at P+0xB80 (GR IV P+0xBB8), live
 *    view / movie at P+0x39270 (GR IV P+0x392A8); the core passes exactly these to the builder (0x536E95B0, 0x536E9B30).
 *  - The scratch and the live-view throttling state share one RAM word: the word keeps the pointer to one operator-new
 *    allocation of two scratch halves (stills, live view) followed by the state word (zeroed when it is allocated). If the
 *    allocation fails the call gives -1 (the camera's no-correction result) and the next call tries again; nothing is held then.
 *    GR IV kept the state in a RAM word of its own and checked the blob before allocating; here the allocation comes first.
 */
#include "shadowml_const.h"

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;
typedef long long i64;
typedef __UINTPTR_TYPE__ uptr;

struct shadowml_ctx {
  u32 magic;        /* SHADOWML_MAGIC */
  const u32 *blob;  /* the model blob (4-byte aligned) */
  u32 blob_len;     /* its length in bytes */
  u32 period;       /* live view / movie (mode 1, 2): compute on every period-th call and hold the result in between (0, 1: always compute) */
  void *(*alloc)(u32 bytes); /* the firmware's operator new; called once, for the scratch */
  uptr *slot;       /* the RAM word (zero at start-up) that keeps the scratch pointer */
};

struct acc { u32 n, sum, clip, sr, sb; };

/* The working memory of one computation (kept off the stack): live view / movie and stills have one each, as two disjoint halves of
 * one allocation, because both can run the core at the same time. */
struct scratch {
  u16 hist[SHADOWML_NBINS];
  u16 frac[16];
  i32 F[SHADOWML_NF];
  u32 qb[11];
  struct acc ac, ab;   /* centre and border sums */
};

/* The one allocation: the two halves and the live-view throttling state (touched by live view / movie only). */
struct block {
  struct scratch half[2];
  u32 state;
  u32 pad;
};

/* GR III's statistics structures in the shooting record P (see the header). */
#define ST_STILL 0xB80u
#define ST_LV 0x39270u
#define ST_R 0x14018u
#define ST_G 0x18018u
#define ST_B 0x20018u
#define ST_C 0x26018u

static u32 lg8(u32 x) { /* 256 log2(x), x >= 1 */
  u32 e = 31u - (u32)__builtin_clz(x);
  u32 m = (x << (31u - e)) >> 16, f = 0, i;
  for (i = 0; i < 8; i++) {
    m = (m * m) >> 15;
    f <<= 1;
    if (m >= 65536u) { m >>= 1; f |= 1u; }
  }
  return e * 256u + f;
}

static u32 udiv(u32 a, u32 b) { /* b in 1 .. 2^31 - 1 */
  u32 q = 0, r = 0;
  i32 i;
  for (i = 31; i >= 0; i--) {
    r = (r << 1) | ((a >> i) & 1u);
    if (r >= b) { r -= b; q |= 1u << i; }
  }
  return q;
}


/* len consecutive blocks of one row segment, for hl = 0 and hl = 1 (two copies: the shift is a constant in each). The sums are of
 * the clamped channels before the hl doubling (the caller shifts them); a doubled channel is near-clipped when the clamped one
 * reaches NEARCLIP >> hl. */
#define SEG(NAME, HL) \
static __attribute__((noinline)) void NAME(const u32 *R, const u32 *G, const u32 *B, const u32 *C, u32 len, u16 *hist, struct acc *a) { \
  u32 n = a->n, sum = a->sum, clip = a->clip, sr = a->sr, sb = a->sb, i; \
  for (i = 0; i < len; i++) { \
    u32 r = R[i], g = G[i], b = B[i], x, s, m; \
    if (!C[i]) continue; \
    if (r > SHADOWML_CHMAX) r = SHADOWML_CHMAX; \
    if (g > SHADOWML_CHMAX) g = SHADOWML_CHMAX; \
    if (b > SHADOWML_CHMAX) b = SHADOWML_CHMAX; \
    x = g << (HL); \
    if (!x) x = 1u; \
    s = (u32)__builtin_clz(x); \
    hist[((31u - s) << 4) | (((x << s) >> 27) & 15u)]++; \
    n++; sum += g; sr += r; sb += b; \
    m = r > g ? r : g; \
    if (b > m) m = b; \
    clip += m >= (SHADOWML_NEARCLIP >> (HL)); \
  } \
  a->n = n; a->sum = sum; a->clip = clip; a->sr = sr; a->sb = sb; \
}
SEG(seg0, 0)
SEG(seg1, 1)
static void seg(const u32 *R, const u32 *G, const u32 *B, const u32 *C, u32 len, u32 hl, u16 *hist, struct acc *a) {
  if (hl) seg1(R, G, B, C, len, hist, a); else seg0(R, G, B, C, len, hist, a);
}

/* the blob's header checks; 1 if usable */
static int blob_ok(const u32 *w, u32 blen) {
  u32 nt, nn;
  if (blen < SHADOWML_HEADER || w[0] != SHADOWML_BLOB_MAGIC || w[1] != 1u || w[2] != SHADOWML_NF) return 0;
  nt = w[3]; nn = w[4];
  if (nt > SHADOWML_MAXTREES || nn > SHADOWML_MAXNODES) return 0;
  if (w[9] != SHADOWML_HEADER + 4u * nt + 8u * nn || w[9] > blen || (i32)w[7] > (i32)w[8]) return 0;
  return 1;
}

/* the model output; 0 for a structural error, else 1 with *t set (before the negative test) */
static int model(const u32 *w, const i32 *F, i32 *t) {
  u32 nt = w[3], nn = w[4], k, d, s = 0;
  const u32 *roots = w + SHADOWML_HEADER / 4u;
  const u32 *nodes = roots + nt;
  i64 v;
  for (k = 0; k < nt; k++) {
    u32 cur = roots[k];
    if (cur >= nn) return 0;
    for (d = 0; d <= SHADOWML_MAXDEPTH; d++) {
      u32 a = nodes[2u * cur], b = nodes[2u * cur + 1u], feat = b & 255u, child = b >> 16;
      if (feat == 255u) { s += a; break; }
      if (feat >= SHADOWML_NF || child + 1u >= nn) return 0;
      cur = (F[feat] <= (i32)a) ? child : child + 1u;
    }
    if (d > SHADOWML_MAXDEPTH) return 0;
  }
  v = (i64)(i32)w[6] + (((i64)(i32)s * (i64)(i32)w[5] + 0x8000) >> 16);
  if (v < (i64)(i32)w[7]) v = (i64)(i32)w[7];
  if (v > (i64)(i32)w[8]) v = (i64)(i32)w[8];
  if (v > SHADOWML_TMAX) v = SHADOWML_TMAX;
  *t = (i32)v;
  return 1;
}

/* the feature vector (ref.py); 0 when the grid is unusable or no block is counted */
static int features(const u8 *P, u32 mode, u32 hl, u32 idx, struct scratch *sc_) {
  u16 *hist = sc_->hist, *frac = sc_->frac;
  i32 *F = sc_->F;
  u32 *qb = sc_->qb;
  struct acc *ac = &sc_->ac, *ab = &sc_->ab;
  const u32 *R, *G, *B, *C;
  u32 W, H, nblk, y, x0, x1, n, cum = 0, bi = 0, k, total, mb, j, nc, nb, sc, sb, clip;

  {
    const u8 *S = P + ((mode == 1u || mode == 2u) ? ST_LV : ST_STILL);
    R = (const u32 *)(S + ST_R); G = (const u32 *)(S + ST_G); B = (const u32 *)(S + ST_B); C = (const u32 *)(S + ST_C);
    W = *(const u16 *)S; H = *(const u16 *)(S + 2u);
  }
  nblk = W * H;
  if (W == 0 || H == 0 || nblk > SHADOWML_MAXBLOCKS) return 0;
  hl = hl ? 1u : 0u;
  for (j = 0; j < SHADOWML_NBINS; j++) hist[j] = 0;
  ac->n = ac->sum = ac->clip = ac->sr = ac->sb = 0;
  ab->n = ab->sum = ab->clip = ab->sr = ab->sb = 0;
  x0 = W >> 2; x1 = W - (W >> 2);
  for (y = 0; y < H; y++) {
    u32 o = y * W;
    if (y >= (H >> 2) && y < H - (H >> 2)) {
      seg(R + o, G + o, B + o, C + o, x0, hl, hist, ab);
      seg(R + o + x0, G + o + x0, B + o + x0, C + o + x0, x1 - x0, hl, hist, ac);
      seg(R + o + x1, G + o + x1, B + o + x1, C + o + x1, W - x1, hl, hist, ab);
    } else {
      seg(R + o, G + o, B + o, C + o, W, hl, hist, ab);
    }
  }
  nc = ac->n; nb = ab->n; sc = ac->sum << hl; sb = ab->sum << hl; clip = ac->clip + ab->clip;
  n = nc + nb;
  if (n == 0) return 0;
  for (j = 0; j < 16; j++) frac[j] = (u16)(lg8(33u + 2u * j) - 1280u);
#define QSTEP(i, p) do { \
    k = (u32)(((u64)(n * (p) + 99u) * 0x51EB851Full) >> 37); \
    for (;;) { u32 c2 = cum + hist[bi]; if (c2 >= k) break; cum = c2; bi++; } \
    qb[i] = bi; } while (0)
  QSTEP(0, 1u); QSTEP(1, 2u); QSTEP(2, 5u); QSTEP(3, 10u); QSTEP(4, 25u); QSTEP(5, 50u);
  QSTEP(6, 75u); QSTEP(7, 90u); QSTEP(8, 95u); QSTEP(9, 98u); QSTEP(10, 99u);
#undef QSTEP
  for (j = 0; j < 11; j++) F[j] = (i32)((qb[j] >> 4) * 256u + frac[qb[j] & 15u]);
  total = 0;
  for (j = 0; j < SHADOWML_NBINS; j++) total += hist[j] * ((j >> 4) * 256u + frac[j & 15u]);
  F[11] = (i32)udiv(total + (n >> 1), n);
  mb = qb[5];
  for (k = 1; k <= 5; k++) {
    u32 lo = mb > 16u * k ? mb - 16u * k : 0, c = 0;
    for (j = lo; j <= mb; j++) c += hist[j];
    F[11 + k] = (i32)udiv((c << 12) + (n >> 1), n);
  }
  F[17] = (i32)udiv((clip << 12) + (n >> 1), n);
  F[18] = (nc == 0 || nb == 0) ? 0 : (i32)(lg8(sc ? sc : 1u) - lg8(nc) - lg8(sb ? sb : 1u) + lg8(nb));
  F[19] = (i32)(idx < 96u ? idx : 96u);
  F[20] = (i32)(mode < 3u ? mode : 3u);
  F[21] = (i32)hl;
  F[22] = (i32)udiv((n << 12) + (nblk >> 1), nblk);
  F[23] = F[5] - F[0]; F[24] = F[5] - F[2]; F[25] = F[5] - F[3]; F[26] = F[10] - F[5];
  total = (ac->sum + ab->sum) << hl;   /* the sums of G, R and B over the counted blocks */
  if (!total) total = 1u;
  k = (ac->sr + ab->sr) << hl;
  F[27] = (i32)(lg8(k ? k : 1u) - lg8(total));
  k = (ac->sb + ab->sb) << hl;
  F[28] = (i32)(lg8(k ? k : 1u) - lg8(total));
  return 1;
}

/* the allocation (made on the first call; NULL if operator new fails, and the next call tries again) */
static struct block *block_of(const struct shadowml_ctx *ctx) {
  struct block *b;
  if (!ctx->alloc || !ctx->slot) return 0;
  b = (struct block *)*ctx->slot;
  if (!b) {
    struct block *n = (struct block *)ctx->alloc((u32)sizeof(struct block));
    if (!n) return 0;
    n->state = 0;
    if (!*ctx->slot) *ctx->slot = (uptr)n;      /* another task may have been first: use its allocation then */
    b = (struct block *)*ctx->slot;
  }
  return b;
}

static i32 compute(const struct shadowml_ctx *ctx, struct scratch *sc, const u8 *P, u32 mode, u32 hl, u32 idx) {
  i32 t;
  if (!blob_ok(ctx->blob, ctx->blob_len)) return -1;
  if (!features(P, mode, hl, idx, sc)) return -1;
  if (!model(ctx->blob, sc->F, &t)) return -1;
  return t < 0 ? -1 : t;
}

/* Throttling (live view and movie only): the state word holds the calls still to hold in bits 0..7 and the held result + 1 in bits
 * 8..19 (0 = nothing held). A word that is not plausible (calls >= period or 0, bits 20..31 set, a result above 0x800) is ignored:
 * the call computes. */
i32 shadowml(const struct shadowml_ctx *ctx, const u8 *P, u32 mode, u32 hl, u32 idx) {
  u32 per = ctx->period, *st, w;
  struct block *b;
  i32 r;
  if (ctx->magic != SHADOWML_MAGIC) return -1;
  b = block_of(ctx);
  if (!b) return -1;
  if (per > SHADOWML_MAXPERIOD) per = SHADOWML_MAXPERIOD;
  if (mode != 1u && mode != 2u) return compute(ctx, &b->half[0], P, mode, hl, idx);
  if (per <= 1u) return compute(ctx, &b->half[1], P, mode, hl, idx);
  st = &b->state;
  w = *st;
  if ((w & 255u) != 0 && (w & 255u) < per && (w >> 20) == 0 && ((w >> 8) & 4095u) <= SHADOWML_TMAX + 1u) {
    *st = w - 1u;
    return (i32)((w >> 8) & 4095u) - 1;
  }
  r = compute(ctx, &b->half[1], P, mode, hl, idx);
  *st = (per - 1u) | ((u32)(r + 1) << 8);
  return r;
}
