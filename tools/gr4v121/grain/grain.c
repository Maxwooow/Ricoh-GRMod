/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: film grain for the camera's Grain Effect (Ricoh GR IV, firmware 1.20).
 *
 * The camera's own grain (Granulation, 0x538C664C) is turned off by GR Mod; this module puts a
 * grain of its own on the finished pictures instead, at the start of
 * JpegEncodeMacroProcess::Execute (after the halation and the date imprint), when the camera's
 * Grain Effect is on. Only on / off counts (the user's wish: no choices, the camera finds the
 * balance): the camera's Strength and Size are not used. The size is the medium one; the strength
 * is the medium one for a clean picture and less, down to half, for a picture that already has
 * fine texture of its own (high ISO noise, busy detail), see `texture`.
 *
 * What it does, on the luminance (Y) only, never on the colours:
 *   - grain of two or three sizes at once (octaves): a value on a grid every 1, 2, 4 or 8 pixels,
 *     smoothed with a 3 x 3 binomial on the grid and spread bilinearly between grid points; the
 *     octaves' weights are given per Size. Pictures smaller than the main one (screennail,
 *     thumbnail) get the same grain as if the main picture were shrunk: grids scaled down, the
 *     octaves finer than a pixel weakened as averaging would;
 *   - its strength follows the brightness: a table (256 values, of 1/16 level) that
 *     is strongest in the midtones and fades out in the shadows and the highlights (skin, sky);
 *   - the noise is made from the picture's own pixels as a seed, a new grain for every picture.
 *
 * Which picture has grain: `stash` (FRAME_LOOK; bits 20..25 written by GR Mod's hook of the
 * development step, see grain.ts): bit 25 written, bit 20 Grain Effect on, bits 21..22 Strength,
 * 23..24 Size. (The hook leaves Grain Effect off for the Grainy look, which keeps the camera's grain.)
 *
 * Position-independent: no global data, every address comes in through `struct ctx`. No division.
 */
typedef unsigned char u8;
typedef signed char s8;
typedef unsigned short u16;
typedef short s16;
typedef unsigned int u32;
typedef int s32;

struct picture {
  u8 format;          /* 1: YCbCr 4:2:2, Cb/Cr interleaved in their own plane */
  u8 pad[3];
  u8 *y;
  u8 *c;
  u32 size;
  u16 width, height, stride, c_height;
  u16 x, y_off;
  u8 tail[4];
};

#define OCTAVES 4
struct octave { u8 shift, weight; };   /* grid every 1 << shift pixels; weight 0: unused */

struct ctx {
  void *(*cache)(void);                              /* 0x53918d48 */
  void (*invalidate)(void *cache, u32 addr, u32 n);  /* 0x53918dd8 */
  void (*clean)(void *cache, u32 addr, u32 n);       /* 0x53918dc4 */
  void *(*alloc)(u32 n);                             /* 0x53909154 */
  void (*release)(void *p);                          /* 0x53909190 */
  const volatile u32 *stash;
  const u8 *amp;              /* 3 x 256: amplitude per Y value, of 1/16 level, per Strength */
  const struct octave *oct;   /* 3 x OCTAVES, per Size */
  const u8 *gain;             /* 64: share of the amplitude (255: all) by the picture's own fine texture */
  u32 full_width;             /* width of the main picture the grain is made for (6192) */
  u32 magic;                  /* 'GRN2' */
};

#define GRAIN_WRITTEN 0x2000000u
#define GRAIN_ON 0x100000u

static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u && (a & 3) == 0;
}

static int picture_ok(const struct picture *p) {
  u32 w = p->width, h = p->height;
  if (p->format != 1 || !ram(p->y) || !ram(p->c) || w < 64 || h < 48 || p->stride < w || p->c_height < h) return 0;
  return w <= 12000 && h <= 12000;
}

static u32 mix(u32 v) {
  v ^= v >> 16; v *= 0x7feb352du;
  v ^= v >> 15; v *= 0x846ca68bu;
  v ^= v >> 16;
  return v;
}

/* Raw row r of octave o (n + 2 values, -128..127, four per xorshift step: the bytes of the state,
 * lowest first), smoothed horizontally (1 2 1): n values into out. */
static void hrow(s16 *out, u32 n, u32 seed, u32 o, u32 r) {
  u32 s = mix(seed ^ (r * 0x9e3779b1u) ^ (o * 0x85ebca77u)), i = 0, k;
  s32 p, q;
  if (!s) s = 1;
  s ^= s << 13; s ^= s >> 17; s ^= s << 5;
  p = (s8)s; q = (s8)(s >> 8);
  /* values 2, 3 of the first step, then four per step */
  out[0] = (s16)(p + 2 * q + (s8)(s >> 16)); p = q; q = (s8)(s >> 16);
  if (n > 1) { out[1] = (s16)(p + 2 * q + (s8)(s >> 24)); p = q; q = (s8)(s >> 24); }
  i = 2;
  while (i < n) {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    for (k = 0; k < 4 && i < n; k++, i++) {
      s32 v = (s8)(s >> (8 * k));
      out[i] = (s16)(p + 2 * q + v);
      p = q; q = v;
    }
  }
}

struct layer {
  u32 shift, weight, gw, next;  /* next: grid row s1 is for */
  s16 *h[3];                    /* horizontally smoothed raw rows next .. next + 2 */
  s32 *s0, *s1;                 /* smoothed grid rows next - 1, next, times the weight */
  s32 *vy;                      /* between them, at the current picture row */
};

/* Smoothed grid row next from h[0..2] (raw rows next .. next + 2), times the weight, into s1. */
static void vsmooth(struct layer *l) {
  u32 i;
  s32 wt = (s32)l->weight;
  const s16 *a = l->h[0], *b = l->h[1], *c = l->h[2];
  s32 *o = l->s1;
  u32 n = l->gw;
  for (i = 0; i < n; i++) o[i] = (a[i] + 2 * b[i] + c[i]) * wt;
}

/* Raw row r, horizontally smoothed, into h[2]. */
static void next_raw(struct layer *l, u32 seed, u32 o, u32 r) {
  hrow(l->h[2], l->gw, seed, o, r);
}

/* d[0..n) += the grid row v (one value every 1 << r entries of d) spread linearly between its points. */
static void expand_add(s32 *restrict d, const s32 *restrict v, u32 n, u32 r) {
  u32 g = 1u << r, full = n >> r, i, kk;
  if (r == 1) {
    for (i = 0; i < full; i++, d += 2) { s32 a0 = v[i], dd = v[i + 1] - a0; d[0] += a0; d[1] += a0 + (dd >> 1); }
  } else if (r == 2) {
    for (i = 0; i < full; i++, d += 4) {
      s32 a0 = v[i], dd = v[i + 1] - a0;
      d[0] += a0; d[1] += a0 + (dd >> 2); d[2] += a0 + (dd >> 1); d[3] += a0 + ((dd * 3) >> 2);
    }
  } else {
    for (i = 0; i < full; i++, d += g) {
      s32 a0 = v[i], dd = v[i + 1] - a0;
      for (kk = 0; kk < g; kk++) d[kk] += a0 + ((dd * (s32)kk) >> r);
    }
  }
  {
    s32 a0 = v[full], dd = v[full + 1] - a0;
    for (kk = 0; kk < (n & (g - 1)); kk++) d[kk] += a0 + ((dd * (s32)kk) >> r);
  }
}

static u8 grained(s32 v, s32 a, const u8 *amp) {
  v += (a * (s32)amp[v] + (1 << 19)) >> 20;
  return (u8)(v < 0 ? 0 : (v > 255 ? 255 : v));
}

/* The grain onto a row of Y: R (one value every 1 << f pixels) spread linearly between its points;
 * the amplitude by the value, 1/16 level per 2^16 of R. */
static void put(u8 *restrict yr, const s32 *restrict R, const u8 *restrict amp, u32 w, u32 f) {
  u32 g = 1u << f, full = w >> f, i, kk;
  if (f == 0) {
    for (i = 0; i < w; i++) yr[i] = grained(yr[i], R[i], amp);
    return;
  }
  if (f == 1) {
    for (i = 0; i < full; i++, yr += 2) {
      s32 a0 = R[i], dd = R[i + 1] - a0;
      yr[0] = grained(yr[0], a0, amp);
      yr[1] = grained(yr[1], a0 + (dd >> 1), amp);
    }
  } else {
    for (i = 0; i < full; i++, yr += g) {
      s32 a0 = R[i], dd = R[i + 1] - a0;
      for (kk = 0; kk < g; kk++) yr[kk] = grained(yr[kk], a0 + ((dd * (s32)kk) >> f), amp);
    }
  }
  {
    s32 a0 = R[full], dd = R[full + 1] - a0;
    for (kk = 0; kk < (w & (g - 1)); kk++) yr[kk] = grained(yr[kk], a0 + ((dd * (s32)kk) >> f), amp);
  }
}

static void sync(const struct ctx *k, void *cache, const struct picture *p, int clean) {
  u32 a = (u32)p->y & ~63u, b = ((u32)p->y + (u32)p->height * p->stride + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
}

static void grain(const struct ctx *k, void *cache, const struct picture *p, const u8 *amp, const struct octave *oct) {
  u32 w = p->width, h = p->height, L = 0, n = 0, o, x, y, seed, f = 31, gwf;
  struct layer ly[OCTAVES];
  s32 *acc;
  int ok = 1;
  /* Picture size relative to the main picture: 2^L times smaller (nearest power of two). */
  while (L < 8 && (w << (L + 1)) <= k->full_width + (k->full_width >> 1) - (k->full_width >> 3)) L++;
  for (o = 0; o < OCTAVES; o++) {
    u32 s = oct[o].shift, wt = oct[o].weight, j;
    struct layer *l = &ly[n];
    l->h[0] = l->h[1] = l->h[2] = 0; l->s0 = l->s1 = l->vy = 0;
    if (!wt) continue;
    if (s >= L) s -= L;
    else { wt >>= L - s; s = 0; }
    if (!wt) continue;
    l->shift = s; l->weight = wt;
    l->gw = (w >> s) + 3;
    for (j = 0; j < 3; j++) l->h[j] = (s16 *)k->alloc(l->gw * 2 + 8);
    l->s0 = (s32 *)k->alloc(l->gw * 4 + 8);
    l->s1 = (s32 *)k->alloc(l->gw * 4 + 8);
    l->vy = (s32 *)k->alloc(l->gw * 4 + 8);
    n++;
    if (!l->h[0] || !l->h[1] || !l->h[2] || !l->s0 || !l->s1 || !l->vy) { ok = 0; break; }
  }
  for (o = 0; o < n; o++) if (ly[o].shift < f) f = ly[o].shift;
  gwf = (w >> f) + 3;
  acc = ok && n ? (s32 *)k->alloc(gwf * 4 + 8) : 0;
  if (!acc) ok = 0;
  if (!ok) goto out;
  sync(k, cache, p, 0);

  /* A new grain for every picture: the seed from some of its pixels. */
  seed = w * 0x10001u + h;
  for (y = 0; y < 16; y++) {
    const u8 *r = p->y + ((y * 2 + 1) * h >> 5) * p->stride;
    for (x = 0; x < 16; x++) seed = seed * 31u + r[(x * 2 + 1) * w >> 5];
  }
  seed = mix(seed);

  for (o = 0; o < n; o++) {
    struct layer *l = &ly[o];
    s16 *t;
    /* h = raw rows 0..2; s0 = grid row 0, s1 = grid row 1 (not for a layer of every pixel, which
     * takes its rows straight from h) */
    next_raw(l, seed, o, 0); t = l->h[0]; l->h[0] = l->h[2]; l->h[2] = t;
    next_raw(l, seed, o, 1); t = l->h[1]; l->h[1] = l->h[2]; l->h[2] = t;
    next_raw(l, seed, o, 2);
    l->next = 0;
    if (!l->shift) continue;
    vsmooth(l);
    { s32 *u = l->s0; l->s0 = l->s1; l->s1 = u; }
    t = l->h[0]; l->h[0] = l->h[1]; l->h[1] = l->h[2]; l->h[2] = t;
    next_raw(l, seed, o, 3);
    vsmooth(l);
    l->next = 1;
  }

  for (y = 0; y < h; y++) {
    for (o = 0; o < n; o++) {
      struct layer *l = &ly[o];
      u32 s = l->shift, g = 1u << s, gy = y >> s, fy = y & (g - 1), i, gw = l->gw, r = s - f;
      const s32 *v;
      if (!s) {
        /* every pixel a grid point: grid row y from raw rows y..y+2 */
        const s16 *ha, *hb, *hc;
        s32 wt = (s32)l->weight, *t = l->vy;
        s16 *u;
        while (l->next < y) {
          u = l->h[0]; l->h[0] = l->h[1]; l->h[1] = l->h[2]; l->h[2] = u;
          l->next++;
          next_raw(l, seed, o, l->next + 2);
        }
        ha = l->h[0]; hb = l->h[1]; hc = l->h[2];
        for (i = 0; i < gw; i++) t[i] = (ha[i] + 2 * hb[i] + hc[i]) * wt;
        v = t;
      } else {
        while (l->next < gy + 1) {
          s32 *u = l->s0; s16 *t = l->h[0];
          l->s0 = l->s1; l->s1 = u;
          l->h[0] = l->h[1]; l->h[1] = l->h[2]; l->h[2] = t;
          l->next++;
          next_raw(l, seed, o, l->next + 2);
          vsmooth(l);
        }
        v = l->s0;
        if (fy) {
          const s32 *s0 = l->s0, *s1 = l->s1;
          s32 *t = l->vy;
          if (fy == g >> 1) for (i = 0; i < gw; i++) t[i] = s0[i] + ((s1[i] - s0[i]) >> 1);
          else for (i = 0; i < gw; i++) t[i] = s0[i] + (((s1[i] - s0[i]) * (s32)fy) >> s);
          v = t;
        }
      }
      /* onto the finest grid */
      if (!o && r) for (i = 0; i < gwf; i++) acc[i] = 0;
      if (!r) {
        if (!o) for (i = 0; i < gwf; i++) acc[i] = v[i];
        else for (i = 0; i < gwf; i++) acc[i] += v[i];
      } else expand_add(acc, v, gwf, r);
    }
    put(p->y + y * p->stride, acc, amp, w, f);
  }
  sync(k, cache, p, 1);
out:
  if (acc) k->release(acc);
  for (o = 0; o < n; o++) {
    u32 j;
    if (ly[o].vy) k->release(ly[o].vy);
    if (ly[o].s1) k->release(ly[o].s1);
    if (ly[o].s0) k->release(ly[o].s0);
    for (j = 0; j < 3; j++) if (ly[o].h[j]) k->release(ly[o].h[j]);
  }
}

/* How much fine texture the picture already has (sensor noise at high ISO, busy detail): 64 x 64
 * blocks of 8 x 8 pixels over the picture; per block the sum of the differences of neighbours along
 * the rows (about 63 times the standard deviation of noise); blocks near black or white do not
 * count. The value a quarter of the blocks stay under, in eighths (0..63); 64: too few blocks. */
static u32 texture(const struct picture *p) {
  u32 w = p->width, h = p->height, i, j, x, y, n = 0, c = 0;
  u16 hist[64];
  for (i = 0; i < 64; i++) hist[i] = 0;
  for (j = 0; j < 64; j++) {
    u32 y0 = ((2 * j + 1) * h) >> 7;
    y0 = y0 < 4 ? 0 : y0 - 4;
    if (y0 + 8 > h) y0 = h - 8;
    for (i = 0; i < 64; i++) {
      u32 x0 = ((2 * i + 1) * w) >> 7, sum = 0, dif = 0;
      x0 = x0 < 4 ? 0 : x0 - 4;
      if (x0 + 8 > w) x0 = w - 8;
      for (y = 0; y < 8; y++) {
        const u8 *r = p->y + (y0 + y) * p->stride + x0;
        s32 a = r[0];
        sum += (u32)a;
        for (x = 1; x < 8; x++) {
          s32 b = r[x], d = b - a;
          dif += (u32)(d < 0 ? -d : d);
          sum += (u32)b;
          a = b;
        }
      }
      sum >>= 6;
      if (sum < 24 || sum > 230) continue;
      dif >>= 3;
      hist[dif > 63 ? 63 : dif]++;
      n++;
    }
  }
  if (n < 256) return 64;
  for (i = 0; i < 64; i++) {
    c += hist[i];
    if (c * 4 >= n) return i;
  }
  return 63;
}

/* Entry: k = context, config = JpegEncodeMacroProcess configuration. */
void film_grain(const struct ctx *k, u32 *config) {
  u32 st = *k->stash, i, j, t, g, big = 4;
  struct picture *seen[4];
  u8 amp[256];
  void *cache;
  if (!(st & GRAIN_WRITTEN) || !(st & GRAIN_ON) || !ram(config) || !ram(k->amp) || !ram(k->oct) || !ram(k->gain)) return;
  if (k->full_width < 1000 || k->full_width > 12000) return;
  cache = k->cache();
  /* One picture per buffer (another entry with the same planes describes the whole sensor). */
  for (i = 0; i < 4; i++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + i];
    seen[i] = 0;
    if (!ram(p) || !picture_ok(p)) continue;
    for (j = 0; j < i; j++) if (seen[j] && seen[j]->y == p->y) break;
    if (j == i) seen[i] = p;
  }
  for (i = 0; i < 4; i++) if (seen[i] && (big == 4 || seen[i]->width > seen[big]->width)) big = i;
  if (big == 4) return;
  /* Automatic: Grain Effect is on or off. The strength is the medium one, less for a picture that
   * already has fine texture of its own (measured on the largest picture, the same for all of
   * them); the size the medium one. */
  {
    const struct picture *p = seen[big];
    u32 a = (u32)p->y & ~63u, b = ((u32)p->y + (u32)p->height * p->stride + 63) & ~63u;
    k->invalidate(cache, a, b - a);
    t = texture(p);
  }
  g = t < 64 ? k->gain[t] : 255u;
  for (i = 0; i < 256; i++) amp[i] = (u8)((k->amp[256 + i] * (g + 1)) >> 8);
  for (i = 0; i < 4; i++)
    if (seen[i]) grain(k, cache, seen[i], amp, k->oct + OCTAVES);
}
