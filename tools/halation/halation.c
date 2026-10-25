/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: halation for the added Image Control slots and edited Cinema slots (Ricoh GR IV, firmware 1.11).
 *
 * Called at the start of JpegEncodeMacroProcess::Execute with the process configuration, like the
 * date imprint (tools/datestamp/datestamp.c), before it. The configuration lists the YCbCr 4:2:2
 * pictures the JPEG encoder is about to compress (main picture, screennail, thumbnail). When the
 * picture was developed with a look that has halation (an added slot, or Cinema Yellow / Green
 * with a preset) and its level ("Halation" on the parameter screen, the slider of Cinema's Toning)
 * is not off, the light of the highlights spreads
 * around them as on CineStill 800T (cinema film without its anti-halation layer): light that went
 * through the film comes back from the base and exposes the red layer again, a little the green.
 *   1. light: of the brighter of Y and red, through the look's own table (256 values, 0..16384),
 *      averaged down to a picture at most 1024 wide and high. The table (made by GR Mod) takes the
 *      value back through the look to the light it was, and starts softly (the square of the
 *      light above a start, in linear light): a lamp that brightens fades in instead of popping;
 *   2. spread with two widths together (a narrow fringe and a wider glow; three box passes each
 *      way for each), relative to the picture's width;
 *   3. the spread light times the level's gain picks, from a table, how much red, green and blue
 *      are lifted towards white ("screen"): red first, so the glow is red, orange near strong
 *      light, and white highlights stay white.
 * Every picture is done on its own, with the widths scaled to it, so the screennail and the
 * thumbnail match the main picture. The parameters (fitted to CineStill 800T pictures) and the
 * table are made by GR Mod (halation.ts); GR Mod's preview runs the same integer steps.
 *
 * Which look and level: `stash` (written by the development step that reads the frame's record,
 * see lookstash.ts): bits 0..7 the style, 8..15 the level (0 off, 1 weak, 2 medium, 3 strong), bit 16 valid,
 * bit 17 white.
 *
 * White (0.8.2, highlight diffusion like the GR IV HDF): the light of each highlight spreads in its
 * own colour (three maps: the light times red, green, blue over the brightest of them) and each
 * channel is lifted by its own map, all by the same table: a white lamp blooms white, a red sign red.
 *
 * Position-independent: no global data, every address comes in through `struct ctx`. No division
 * (the module must not need a run-time library).
 */
typedef unsigned char u8;
typedef unsigned short u16;
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

struct params {
  u16 narrow, wide;   /* box radius of the two spreads, in 1/4096 of the picture's width */
  u16 mix;            /* share of the narrow spread, of 256 */
  u16 pad[5];
};

/* One look with halation. */
struct look {
  u16 gain[4];        /* weak, medium, strong, 0: table index = light * gain >> 10 */
  u16 light[256];     /* light (0..16384) of a value (the brighter of Y and red) */
};

#define LUT_N 4096    /* lut[0..N) red, [N..2N) green, [2N..3N) blue: lift towards white, of 255;
                         [3N..4N) the lift of every channel for the white glow */

struct ctx {
  void *(*cache)(void);                              /* 0x538f0448 */
  void (*invalidate)(void *cache, u32 addr, u32 n);  /* 0x538f04d8 */
  void (*clean)(void *cache, u32 addr, u32 n);       /* 0x538f04c4 */
  void *(*alloc)(u32 n);                             /* 0x538e09b0 */
  void (*release)(void *p);                          /* 0x538e09ec */
  const volatile u32 *stash;
  const u8 *lut;
  const struct look *looks;
  u32 count;          /* entries of `looks` */
  u32 reserved;
  struct params p;
  u32 magic;          /* 'HAL4' */
  u8 look_map[64];    /* style -> entry of `looks` + 1, 0: no halation */
#ifdef STATUS
  volatile u32 *status; /* GR III test builds: how far the last call got (see `REPORT`) */
#endif
};

#define STASH_VALID 0x10000u
#define STASH_WHITE 0x20000u
#define SMALL_MAX 1024u
#define E_MAX 16384u

static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u && (a & 3) == 0;
}

#ifdef STATUS
/* Status word of GR III's diagnostic build, printed on the photo by the date module's diagnostics:
 * bits 0..7 how far the call got (1 entered, 2 no valid stash, 3 look without halation, 5 level,
 * 6 light, 8 done), 8..11 pictures processed, 12..15 pictures whose buffers could not be
 * allocated, 16..23 format byte of the first picture, 24..27 why the first picture was refused
 * (1 format, 2 planes, 4 size, 8 stride / CbCr height). */
#define REPORT(k, v) (*(k)->status = (v))
#define COUNT(k, v) (*(k)->status += (v))
#else
#define REPORT(k, v) ((void)0)
#define COUNT(k, v) ((void)0)
#endif

static int picture_ok(const struct picture *p) {
  u32 w = p->width, h = p->height;
  if (p->format != 1 || !ram(p->y) || !ram(p->c) || w < 64 || h < 48 || p->stride < w || p->c_height < h) return 0;
  return w <= 12000 && h <= 12000;
}

/* n / d for small numbers, by shift and subtract. */
static u32 udiv(u32 n, u32 d) {
  u32 q = 0, r = 0;
  s32 i;
  if (!d) return 0;
  for (i = 31; i >= 0; i--) {
    r = (r << 1) | ((n >> i) & 1);
    if (r >= d) { r -= d; q |= 1u << i; }
  }
  return q;
}

static void sync(const struct ctx *k, void *cache, const struct picture *p, int clean) {
  u32 a, b;
  a = (u32)p->y & ~63u; b = ((u32)p->y + (u32)p->height * p->stride + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
  a = (u32)p->c & ~63u; b = ((u32)p->c + (u32)p->height * p->stride + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
}

/* Box blur of radius r along one direction: n values `step` apart, through `tmp` (n values). */
static void box(u16 *v, u32 n, u32 step, u32 r, u32 recip, u16 *tmp) {
  u32 i, sum;
  s32 j;
  if (n < 2) return;
  for (i = 0; i < n; i++) tmp[i] = v[i * step];
  sum = 0;
  for (j = -(s32)r; j <= (s32)r; j++) sum += tmp[j < 0 ? 0 : ((u32)j >= n ? n - 1 : (u32)j)];
  for (i = 0; i < n; i++) {
    s32 out = (s32)i - (s32)r, in = (s32)i + (s32)r + 1;
    v[i * step] = (u16)((sum * recip) >> 16);
    sum -= tmp[out < 0 ? 0 : (u32)out];
    sum += tmp[(u32)in >= n ? n - 1 : (u32)in];
  }
}

/* Three box passes each way, radius from `rad` (1/4096 of the width sw). */
static void spread(u16 *v, u32 sw, u32 sh, u32 rad, u16 *tmp) {
  u32 r = (rad * sw + 2048) >> 12, recip, pass, x, y;
  if (r < 1) return;
  if (r > 200) r = 200;
  recip = udiv(65536u, 2 * r + 1);
  for (pass = 0; pass < 3; pass++) {
    for (y = 0; y < sh; y++) box(v + y * sw, sw, 1, r, recip, tmp);
    for (x = 0; x < sw; x++) box(v + x, sh, sw, r, recip, tmp);
  }
}

static s32 clamp8(s32 v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

/* Lift a colour towards white by h (0..255 of 255). */
static s32 lift(s32 v, u32 h) { return v + (s32)(((u32)(255 - v) * h * 257 + 32768) >> 16); }

static void halate(const struct ctx *k, void *cache, const struct picture *p, u32 gain, const u16 *light) {
  const struct params *P = &k->p;
  const u8 *lr = k->lut, *lg = k->lut + LUT_N, *lb = k->lut + 2 * LUT_N;
  u32 w = p->width, h = p->height, s = 0, q, F, sw, sh, x, y, i, n;
  u16 *small, *wide, *tmp, *row;
  u32 *acc;
  while ((w >> s) > SMALL_MAX || (h >> s) > SMALL_MAX) s++;
  F = 1u << s;
  sw = (w + F - 1) >> s; sh = (h + F - 1) >> s;
  n = sw * sh;
  small = (u16 *)k->alloc(n * 2 + 8);
  wide = (u16 *)k->alloc(n * 2 + 8);
  tmp = (u16 *)k->alloc((sw > sh ? sw : sh) * 2 + 8);
  acc = (u32 *)k->alloc(sw * 4 + 8);
  row = (u16 *)k->alloc(sw * 2 + 8);
  if (!small || !wide || !tmp || !acc || !row) { COUNT(k, 0x1000u); goto out; }
  COUNT(k, 0x100u);
  sync(k, cache, p, 0);

  /* 1. light (0..16384), of the brighter of Y and red through the look's table, averaged over F x F
   * blocks; from blocks of 4 x 4 on, every other pixel of every other row is enough */
  q = s >= 2 ? 1 : 0;
  for (y = 0; y < h; y += F) {
    u32 by = y >> s, yy, ylim = y + F > h ? h : y + F;
    for (x = 0; x < sw; x++) acc[x] = 0;
    for (yy = y; yy < ylim; yy += 1u << q) {
      const u8 *yr = p->y + yy * p->stride, *cr = p->c + yy * p->stride;
      for (x = 0; x < w; x += 1u << q) {
        s32 v = yr[x], red = v + ((91881 * ((s32)cr[x | 1] - 128) + 32768) >> 16);
        if (red > v) v = red;
        if (v > 255) v = 255;
        acc[x >> s] += light[v];
      }
    }
    for (x = 0; x < sw; x++) {
      u32 v = acc[x] >> (2 * (s - q));
      small[by * sw + x] = (u16)(v > E_MAX ? E_MAX : v);
    }
  }

  /* 2. the narrow and the wide spread, mixed */
  for (i = 0; i < n; i++) wide[i] = small[i];
  spread(small, sw, sh, P->narrow, tmp);
  spread(wide, sw, sh, P->wide, tmp);
  for (i = 0; i < n; i++) small[i] = (u16)((small[i] * P->mix + wide[i] * (256 - P->mix)) >> 8);

  /* 3. lift towards white by the table, bilinear from the small picture; per pair of pixels
   * (they share Cb and Cr): to RGB, lift, back */
  for (y = 0; y < h; y++) {
    s32 fy = (s32)(((y << 8) + 128) >> s) - 128, sy0, sy1, wy;
    u32 maxv = 0, idx;
    u8 *yr = p->y + y * p->stride, *cr = p->c + y * p->stride;
    if (fy < 0) fy = 0;
    sy0 = fy >> 8; wy = fy & 255; sy1 = sy0 + 1;
    if ((u32)sy0 >= sh) sy0 = (s32)sh - 1;
    if ((u32)sy1 >= sh) sy1 = (s32)sh - 1;
    for (i = 0; i < sw; i++) {
      u32 v = ((u32)small[(u32)sy0 * sw + i] * (u32)(256 - wy) + (u32)small[(u32)sy1 * sw + i] * (u32)wy) >> 8;
      row[i] = (u16)v;
      if (v > maxv) maxv = v;
    }
    idx = (maxv * gain) >> 10;
    if (lr[idx >= LUT_N ? LUT_N - 1 : idx] == 0) continue;
    for (x = 0; x + 1 < w; x += 2) {
      s32 fx = (s32)(((x << 8) + 128) >> s) - 128, sx0, sx1, wx, cb, crr, j, sb = 0, sr = 0;
      u32 l, hr, hg, hb;
      if (fx < 0) fx = 0;
      sx0 = fx >> 8; wx = fx & 255; sx1 = sx0 + 1;
      if ((u32)sx1 >= sw) sx1 = (s32)sw - 1;
      l = ((u32)row[sx0] * (u32)(256 - wx) + (u32)row[sx1] * (u32)wx) >> 8;
      idx = (l * gain) >> 10;
      if (idx >= LUT_N) idx = LUT_N - 1;
      hr = lr[idx];
      if (!hr) continue;
      hg = lg[idx]; hb = lb[idx];
      cb = (s32)cr[x] - 128; crr = (s32)cr[x + 1] - 128;
      for (j = 0; j < 2; j++) {
        s32 Y = yr[x + j];
        s32 R = clamp8(Y + ((91881 * crr + 32768) >> 16));
        s32 G = clamp8(Y - ((22554 * cb + 46802 * crr - 32768) >> 16));
        s32 B = clamp8(Y + ((116130 * cb + 32768) >> 16));
        R = lift(R, hr); G = lift(G, hg); B = lift(B, hb);
        yr[x + j] = (u8)clamp8((19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
        sb += -11059 * R - 21709 * G + 32768 * B;
        sr += 32768 * R - 27439 * G - 5329 * B;
      }
      cr[x] = (u8)clamp8(128 + ((sb + 65536) >> 17));
      cr[x + 1] = (u8)clamp8(128 + ((sr + 65536) >> 17));
    }
  }
  sync(k, cache, p, 1);
out:
  if (row) k->release(row);
  if (acc) k->release(acc);
  if (tmp) k->release(tmp);
  if (wide) k->release(wide);
  if (small) k->release(small);
}

/* The white glow: as halate, with a map per channel. */
static void halate_white(const struct ctx *k, void *cache, const struct picture *p, u32 gain, const u16 *light) {
  const struct params *P = &k->p;
  const u8 *lw = k->lut + 3 * LUT_N;
  u32 w = p->width, h = p->height, s = 0, q, F, sw, sh, x, y, i, n, c;
  u16 *map[3] = {0, 0, 0}, *row[3] = {0, 0, 0}, *wide = 0, *tmp = 0;
  u32 *acc = 0;
  while ((w >> s) > SMALL_MAX || (h >> s) > SMALL_MAX) s++;
  F = 1u << s;
  sw = (w + F - 1) >> s; sh = (h + F - 1) >> s;
  n = sw * sh;
  for (c = 0; c < 3; c++) {
    map[c] = (u16 *)k->alloc(n * 2 + 8);
    row[c] = (u16 *)k->alloc(sw * 2 + 8);
    if (!map[c] || !row[c]) { COUNT(k, 0x1000u); goto out; }
  }
  wide = (u16 *)k->alloc(n * 2 + 8);
  tmp = (u16 *)k->alloc((sw > sh ? sw : sh) * 2 + 8);
  acc = (u32 *)k->alloc(3 * sw * 4 + 8);
  if (!wide || !tmp || !acc) { COUNT(k, 0x1000u); goto out; }
  COUNT(k, 0x100u);
  sync(k, cache, p, 0);

  /* 1. light of the brightest channel through the look's table, shared out by colour */
  q = s >= 2 ? 1 : 0;
  for (y = 0; y < h; y += F) {
    u32 by = y >> s, yy, ylim = y + F > h ? h : y + F;
    for (x = 0; x < 3 * sw; x++) acc[x] = 0;
    for (yy = y; yy < ylim; yy += 1u << q) {
      const u8 *yr = p->y + yy * p->stride, *cr = p->c + yy * p->stride;
      for (x = 0; x < w; x += 1u << q) {
        s32 Y = yr[x], cb = (s32)cr[x & ~1u] - 128, crr = (s32)cr[x | 1] - 128;
        s32 R = clamp8(Y + ((91881 * crr + 32768) >> 16));
        s32 G = clamp8(Y - ((22554 * cb + 46802 * crr - 32768) >> 16));
        s32 B = clamp8(Y + ((116130 * cb + 32768) >> 16));
        s32 m = R > G ? (R > B ? R : B) : (G > B ? G : B);
        u32 l, f;
        if (!m) continue;
        l = light[m];
        if (!l) continue;
        f = udiv(l << 8, (u32)m);
        acc[x >> s] += (f * (u32)R) >> 8;
        acc[sw + (x >> s)] += (f * (u32)G) >> 8;
        acc[2 * sw + (x >> s)] += (f * (u32)B) >> 8;
      }
    }
    for (c = 0; c < 3; c++) for (x = 0; x < sw; x++) {
      u32 v = acc[c * sw + x] >> (2 * (s - q));
      map[c][by * sw + x] = (u16)(v > E_MAX ? E_MAX : v);
    }
  }

  /* 2. per channel: the narrow and the wide spread, mixed */
  for (c = 0; c < 3; c++) {
    u16 *m = map[c];
    for (i = 0; i < n; i++) wide[i] = m[i];
    spread(m, sw, sh, P->narrow, tmp);
    spread(wide, sw, sh, P->wide, tmp);
    for (i = 0; i < n; i++) m[i] = (u16)((m[i] * P->mix + wide[i] * (256 - P->mix)) >> 8);
  }

  /* 3. lift each channel by its own map */
  for (y = 0; y < h; y++) {
    s32 fy = (s32)(((y << 8) + 128) >> s) - 128, sy0, sy1, wy;
    u32 maxv = 0, idx;
    u8 *yr = p->y + y * p->stride, *cr = p->c + y * p->stride;
    if (fy < 0) fy = 0;
    sy0 = fy >> 8; wy = fy & 255; sy1 = sy0 + 1;
    if ((u32)sy0 >= sh) sy0 = (s32)sh - 1;
    if ((u32)sy1 >= sh) sy1 = (s32)sh - 1;
    for (c = 0; c < 3; c++) for (i = 0; i < sw; i++) {
      u32 v = ((u32)map[c][(u32)sy0 * sw + i] * (u32)(256 - wy) + (u32)map[c][(u32)sy1 * sw + i] * (u32)wy) >> 8;
      row[c][i] = (u16)v;
      if (v > maxv) maxv = v;
    }
    idx = (maxv * gain) >> 10;
    if (lw[idx >= LUT_N ? LUT_N - 1 : idx] == 0) continue;
    for (x = 0; x + 1 < w; x += 2) {
      s32 fx = (s32)(((x << 8) + 128) >> s) - 128, sx0, sx1, wx, cb, crr, j, sb = 0, sr = 0;
      u32 hc[3];
      if (fx < 0) fx = 0;
      sx0 = fx >> 8; wx = fx & 255; sx1 = sx0 + 1;
      if ((u32)sx1 >= sw) sx1 = (s32)sw - 1;
      for (c = 0; c < 3; c++) {
        idx = ((((u32)row[c][sx0] * (u32)(256 - wx) + (u32)row[c][sx1] * (u32)wx) >> 8) * gain) >> 10;
        hc[c] = lw[idx >= LUT_N ? LUT_N - 1 : idx];
      }
      if (!hc[0] && !hc[1] && !hc[2]) continue;
      cb = (s32)cr[x] - 128; crr = (s32)cr[x + 1] - 128;
      for (j = 0; j < 2; j++) {
        s32 Y = yr[x + j];
        s32 R = lift(clamp8(Y + ((91881 * crr + 32768) >> 16)), hc[0]);
        s32 G = lift(clamp8(Y - ((22554 * cb + 46802 * crr - 32768) >> 16)), hc[1]);
        s32 B = lift(clamp8(Y + ((116130 * cb + 32768) >> 16)), hc[2]);
        yr[x + j] = (u8)clamp8((19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
        sb += -11059 * R - 21709 * G + 32768 * B;
        sr += 32768 * R - 27439 * G - 5329 * B;
      }
      cr[x] = (u8)clamp8(128 + ((sb + 65536) >> 17));
      cr[x + 1] = (u8)clamp8(128 + ((sr + 65536) >> 17));
    }
  }
  sync(k, cache, p, 1);
out:
  if (acc) k->release(acc);
  if (tmp) k->release(tmp);
  if (wide) k->release(wide);
  for (c = 0; c < 3; c++) {
    if (row[c]) k->release(row[c]);
    if (map[c]) k->release(map[c]);
  }
}

/* Entry: k = context, config = JpegEncodeMacroProcess configuration. */
void halation(const struct ctx *k, u32 *config) {
  u32 st = *k->stash, style, level, i, j, gain, e;
  const struct look *look;
  struct picture *seen[4];
  void *cache;
#ifdef STATUS
  {
    u32 f = 0;
    if (ram(config) && ram((const void *)config[0x3c >> 2])) {
      const struct picture *p = (const struct picture *)config[0x3c >> 2];
      u32 w = p->width, h = p->height;
      f = (u32)p->format << 16;
      if (p->format != 1) f |= 1u << 24;
      if (!ram(p->y) || !ram(p->c)) f |= 2u << 24;
      if (w < 64 || h < 48 || w > 12000 || h > 12000) f |= 4u << 24;
      if (p->stride < w || p->c_height < h) f |= 8u << 24;
    }
    REPORT(k, f | 1);
    if (!(st & STASH_VALID) || !ram(config) || !ram(k->lut) || !ram(k->looks)) { REPORT(k, f | 2); return; }
    style = st & 0xff; level = (st >> 8) & 0xff;
    e = style < 64 ? k->look_map[style] : 0;
    if (!e || e > k->count) { REPORT(k, f | 3); return; }
    if (level < 1 || level > 3) { REPORT(k, f | 5); return; }
    look = &k->looks[e - 1];
    gain = look->gain[level - 1];
    if (!gain || k->p.mix > 256) { REPORT(k, f | 6); return; }
    for (i = 0; i < 256; i++) if (look->light[i] > E_MAX) { REPORT(k, f | 6); return; }
    REPORT(k, f | 7);
  }
#else
  if (!(st & STASH_VALID) || !ram(config) || !ram(k->lut) || !ram(k->looks)) return;
  style = st & 0xff; level = (st >> 8) & 0xff;
  if (style >= 64 || level < 1 || level > 3) return;
  e = k->look_map[style];
  if (!e || e > k->count) return;
  look = &k->looks[e - 1];
  gain = look->gain[level - 1];
  if (!gain || k->p.mix > 256) return;
  for (i = 0; i < 256; i++) if (look->light[i] > E_MAX) return;
#endif
  cache = k->cache();
  /* One picture per buffer (another entry with the same planes describes the whole sensor). */
  for (i = 0; i < 4; i++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + i];
    seen[i] = 0;
    if (!ram(p) || !picture_ok(p)) continue;
    for (j = 0; j < i; j++) if (seen[j] && seen[j]->y == p->y) break;
    if (j == i) seen[i] = p;
  }
  for (i = 0; i < 4; i++) {
    if (!seen[i]) continue;
    if (st & STASH_WHITE) halate_white(k, cache, seen[i], gain, look->light);
    else halate(k, cache, seen[i], gain, look->light);
  }
#ifdef STATUS
  if (seen[0] || seen[1] || seen[2] || seen[3]) *k->status = (*k->status & ~0xffu) | 8;
#endif
}
