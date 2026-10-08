/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: date imprint for the Ricoh GR IV (firmware 1.11).
 *
 * Called at the start of JpegEncodeMacroProcess::Execute with the process configuration. The
 * configuration lists the YCbCr 4:2:2 pictures the JPEG encoder is about to compress (main picture,
 * screennail, thumbnail, ...). The date is drawn into each of them, bottom right, as a
 * seven-segment "'YY MM DD", scaled to the picture.
 *
 * Position-independent: no global data, every address comes in through `struct ctx`. No division
 * (the module must not need a run-time library).
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;

/* A picture as the image pipeline describes it (0x20 bytes). */
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

struct ctx {
  void *(*cache)(void);                              /* 0x538f0448 */
  void (*invalidate)(void *cache, u32 addr, u32 n);  /* 0x538f04d8 */
  void (*clean)(void *cache, u32 addr, u32 n);       /* 0x538f04c4 */
  void *(*platform)(void);                           /* 0x538f21a0 */
  void (*get_time)(void *clock, u8 *time);           /* 0x538ea9b0 */
  const u8 *setting;                                 /* bit 0..2: colour + 1 (0 = off) */
};

struct colour { u8 y, cb, cr; };

static struct colour colour_of(u32 index) {
  struct colour c;
  switch (index) {
  case 1: c.y = 250; c.cb = 128; c.cr = 128; break;  /* white */
  case 2: c.y = 205; c.cb = 16; c.cr = 160; break;   /* yellow */
  case 3: c.y = 84; c.cb = 94; c.cr = 228; break;    /* red */
  case 4: c.y = 12; c.cb = 128; c.cr = 128; break;   /* black */
  default: c.y = 150; c.cb = 56; c.cr = 204; break;  /* orange */
  }
  return c;
}

/* Segments a..g as bits 0..6. */
static u32 segments(u32 digit) {
  switch (digit) {
  case 0: return 0x3f; case 1: return 0x06; case 2: return 0x5b; case 3: return 0x4f; case 4: return 0x66;
  case 5: return 0x6d; case 6: return 0x7d; case 7: return 0x07; case 8: return 0x7f; case 9: return 0x6f;
  case 10: return 0x77; case 11: return 0x7c; case 12: return 0x39; case 13: return 0x5e; case 14: return 0x79; default: return 0x71;
  }
}

static s32 abs32(s32 v) { return v < 0 ? -v : v; }
static s32 min32(s32 a, s32 b) { return a < b ? a : b; }

/* Inside a bar from (x0,y0) to (x1,y1) (horizontal or vertical) of half thickness t, with pointed
 * ends. Coordinates in 1/4 pixel. */
static int in_bar(s32 px, s32 py, s32 x0, s32 y0, s32 x1, s32 y1, s32 t) {
  s32 along, across, len;
  if (y0 == y1) { along = px - x0; len = x1 - x0; across = abs32(py - y0); }
  else { along = py - y0; len = y1 - y0; across = abs32(px - x0); }
  if (along < 0 || along > len) return 0;
  return across <= min32(t, min32(along, len - along));
}

/* Coverage (0..4 samples) of a digit cell at 1/4-pixel coordinates (qx, qy) inside a cell of
 * size w x h (1/4 px), bar half-thickness t. */
static u32 digit_hit(u32 seg, s32 qx, s32 qy, s32 w, s32 h, s32 t) {
  s32 g = t / 2 + 1; /* gap at the joints (t is a small positive number, /2 is a shift) */
  s32 l = t, r = w - t, top = t, mid = h >> 1, bot = h - t;
  if ((seg & 0x01) && in_bar(qx, qy, l + g, top, r - g, top, t)) return 1;
  if ((seg & 0x02) && in_bar(qx, qy, r, top + g, r, mid - g, t)) return 1;
  if ((seg & 0x04) && in_bar(qx, qy, r, mid + g, r, bot - g, t)) return 1;
  if ((seg & 0x08) && in_bar(qx, qy, l + g, bot, r - g, bot, t)) return 1;
  if ((seg & 0x10) && in_bar(qx, qy, l, mid + g, l, bot - g, t)) return 1;
  if ((seg & 0x20) && in_bar(qx, qy, l, top + g, l, mid - g, t)) return 1;
  if ((seg & 0x40) && in_bar(qx, qy, l + g, mid, r - g, mid, t)) return 1;
  return 0;
}

#define MAXGLYPH 64

/* Plausible RAM address (the camera's DDR, 0x40000000..0xBFFFFFFF); anything else is not
 * dereferenced. With RAW+JPEG the scaled-down main picture of the smaller sizes lives above
 * 0xA0000000 (seen at 0xB1069CC0, test firmware 015). */
static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u && (a & 3) == 0;
}

static void sync(const struct ctx *k, void *cache, struct picture *p, u32 y0, u32 y1, int clean) {
  u32 a, b;
  a = (u32)p->y + y0 * p->stride; b = (u32)p->y + y1 * p->stride;
  a &= ~63u; b = (b + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
  a = (u32)p->c + y0 * p->stride; b = (u32)p->c + y1 * p->stride;
  a &= ~63u; b = (b + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
}

/* Draw `count` glyphs (0..15 hex digit, 16 apostrophe, 17 space) with their top left corner at
 * (x0, y0), digit height H. With `bg`, the box behind them is filled with black first. The caller
 * has checked that the box lies inside the picture and handles the cache. */
static void text_at(struct picture *p, const u8 *glyphs, u32 count, s32 x0, s32 y0, s32 H, struct colour col, int bg) {
  s32 W, T, gap, x, total;
  s32 left[MAXGLYPH], width[MAXGLYPH];
  u32 i;
  W = (H * 9) >> 4;            /* 0.56 H */
  T = (H * 9) >> 6;            /* bar thickness 0.14 H */
  if (T < 2) T = 2;
  gap = (H * 5) >> 4;          /* 0.31 H between digits */
  x = x0; total = 0;
  for (i = 0; i < count; i++) {
    u8 g = glyphs[i];
    width[i] = g == 16 ? T : g == 17 ? 0 : W;
    left[i] = x;
    x += g == 17 ? (H >> 1) : width[i] + gap;
  }
  total = x - x0;
  if (bg) {
    s32 py, px;
    for (py = -2; py < H + 2; py++) {
      u8 *yrow = p->y + (u32)(y0 + py) * p->stride;
      u8 *crow = p->c + (u32)(y0 + py) * p->stride;
      for (px = -2; px < total + 2; px++) { yrow[x0 + px] = 16; crow[(x0 + px) & ~1] = 128; crow[((x0 + px) & ~1) + 1] = 128; }
    }
  }
  {
    s32 py, px;
    s32 qW = W * 4, qH = H * 4, qT = T * 2; /* half thickness in 1/4 px: T/2 * 4 */
    for (py = 0; py < H; py++) {
      u8 *yrow = p->y + (u32)(y0 + py) * p->stride;
      u8 *crow = p->c + (u32)(y0 + py) * p->stride;
      for (i = 0; i < count; i++) {
        u8 g = glyphs[i];
        u32 seg;
        if (g == 17) continue;
        seg = g == 16 ? 0 : segments(g);
        for (px = 0; px < width[i]; px++) {
          u32 cov = 0, sx, sy;
          for (sy = 0; sy < 2; sy++) for (sx = 0; sx < 2; sx++) {
            s32 qx = px * 4 + 1 + (s32)sx * 2, qy = py * 4 + 1 + (s32)sy * 2;
            if (g == 16) { /* apostrophe: short bar at the top */
              if (qy < (qH * 5) >> 4 && abs32(qx - (T * 2)) <= qT) cov++;
            } else if (digit_hit(seg, qx, qy, qW, qH, qT)) cov++;
          }
          if (cov) {
            s32 X = left[i] + px;
            u8 *yp = yrow + X, *cp = crow + (X & ~1);
            *yp = (u8)(*yp + (((s32)col.y - *yp) * (s32)cov >> 2));
            cp[0] = (u8)(cp[0] + (((s32)col.cb - cp[0]) * (s32)cov >> 2));
            cp[1] = (u8)(cp[1] + (((s32)col.cr - cp[1]) * (s32)cov >> 2));
          }
        }
      }
    }
  }
}

/* Width of a run of glyphs drawn at height H (same arithmetic as text_at). */
static s32 text_width(const u8 *glyphs, u32 count, s32 H) {
  s32 W = (H * 9) >> 4, T = (H * 9) >> 6, gap = (H * 5) >> 4, total = 0;
  u32 i;
  if (T < 2) T = 2;
  for (i = 0; i < count; i++) total += glyphs[i] == 17 ? (H >> 1) : (glyphs[i] == 16 ? T : W) + gap;
  return total - gap;
}

/* The picture is a window into a larger buffer: the planes start at the window's top left, `stride`
 * and `c_height` are those of the buffer (on the camera, 6208 and 4128: the whole sensor). */
static int picture_ok(const struct picture *p) {
  u32 w = p->width, h = p->height;
  if (p->format != 1 || !ram(p->y) || !ram(p->c) || w < 120 || h < 80 || p->stride < w || p->c_height < h) return 0;
  return w <= 12000 && h <= 12000;
}

/* A black-and-white photo: the CbCr samples of a 24 x 16 grid over the photo are all neutral
 * (128 +- 2). The image controls of that kind leave no colour at all, so a few hundred points
 * are enough; a colour photo practically always has some colour somewhere among them. */
static int is_mono(const struct ctx *k, void *cache, struct picture *p, s32 rx, s32 ry, s32 rw, s32 rh) {
  u32 gx, gy;
  for (gy = 0; gy < 16; gy++) {
    s32 y = ry + (s32)(((u32)rh * (2 * gy + 1) * 2048u) >> 16);
    for (gx = 0; gx < 24; gx++) {
      s32 x = (rx + (s32)(((u32)rw * (2 * gx + 1) * 1365u) >> 16)) & ~1;
      u8 *c = p->c + (u32)y * p->stride + (u32)x;
      s32 cb, cr;
      k->invalidate(cache, (u32)c & ~63u, 64);
      cb = c[0]; cr = c[1];
      if (cb < 126 || cb > 130 || cr < 126 || cr > 130) return 0;
    }
  }
  return 1;
}

/* Draw into the rectangle (rx, ry, rw, rh) of the picture, bottom right. */
static void draw(const struct ctx *k, void *cache, struct picture *p, s32 rx, s32 ry, s32 rw, s32 rh, const u8 *glyphs, u32 count, struct colour col) {
  s32 H, margin, x0, y0;
  /* Digit height ~ 1/26 of the shorter side, at least 7 px. */
  H = (s32)(((u32)(rw < rh ? rw : rh) * 2521u) >> 16);
  if (H < 7) H = 7;
  margin = (H * 3) >> 1;
  x0 = rx + rw - margin - text_width(glyphs, count, H);
  y0 = ry + rh - margin - H;
  if (x0 < 2 || y0 < 2 || y0 + H + 2 > (s32)p->height) return;
  if (is_mono(k, cache, p, rx, ry, rw, rh)) { col.cb = 128; col.cr = 128; } /* light only, like on black-and-white film */
  sync(k, cache, p, (u32)y0, (u32)(y0 + H + 1), 0);
  text_at(p, glyphs, count, x0, y0, H, col, 0);
  sync(k, cache, p, (u32)y0, (u32)(y0 + H + 1), 1);
}

#ifdef DIAG
/* Test builds: the configuration and the four pictures it points at, as hex, top left of every
 * 720-pixel-wide picture. Rows 0..2: config words 0x30..0x5c, 4 per row; then per picture 2 rows of 16 bytes
 * (or "-" for no picture); then 32 bytes at config[0x38]. */
static u32 hex_bytes(const u8 *b, u32 n, u8 *out) {
  u32 i, m = 0;
  for (i = 0; i < n; i++) {
    out[m++] = b[i] >> 4; out[m++] = b[i] & 15;
    if ((i & 3) == 3 && i + 1 < n) out[m++] = 17;
  }
  return m;
}
static void hex_word_le(u32 v, u8 *out) {
  s32 i;
  for (i = 7; i >= 0; i--) { out[i] = v & 15; v >>= 4; }
}
static int wide_ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u;
}
/* Why picture_ok refuses a picture, as a hex digit: 1 format, 2 planes outside 0x40000000..0xc0000000,
 * 4 size, 8 stride / CbCr height. 0 = accepted. */
static u32 refusal(const struct picture *p) {
  u32 r = 0, w = p->width, h = p->height;
  if (p->format != 1) r |= 1;
  if (!ram(p->y) || !ram(p->c)) r |= 2;
  if (w < 120 || h < 80 || w > 12000 || h > 12000) r |= 4;
  if (p->stride < w || p->c_height < h) r |= 8;
  return r;
}
/* Called first thing on every Execute, whatever the pictures are: the dump goes on every
 * 720-pixel-wide picture of the configuration whose planes look like memory at all. Row 0:
 * marker "A" then per slot the refusal digit (F = no picture). */
static void diag(const struct ctx *k, void *cache, u32 *config) {
  u8 line[MAXGLYPH];
  u32 row, n, i, j, s;
  s32 Hd = 16, step = 22;
  struct colour white = { 250, 128, 128 };
  for (s = 0; s < 4; s++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + s];
    s32 Hm;
    if (!ram(p) || p->width < 160 || p->height < 100 || p->width > 12000 || p->stride < p->width || !wide_ram(p->y) || !wide_ram(p->c)) continue;
    for (j = 0; j < s; j++) {
      struct picture *q = (struct picture *)config[(0x3c >> 2) + j];
      if (ram(q) && q->y == p->y) break;
    }
    if (j < s) continue;
    row = 0;
    Hm = p->width == 720 ? Hd : (s32)(p->width >> 6);
    if (Hm < 16) Hm = 16;
    if (p->height < (u32)(Hm + 8)) continue;
    sync(k, cache, p, 0, (u32)(Hm + 8), 0);
    n = 0;
    line[n++] = 10; line[n++] = 17;
    for (i = 0; i < 4; i++) {
      struct picture *q = (struct picture *)config[(0x3c >> 2) + i];
      line[n++] = ram(q) ? (u8)refusal(q) : 15;
    }
    line[n++] = 17; line[n++] = (u8)s;
    text_at(p, line, n, 4, 4, Hm, white, 1); row++;
    sync(k, cache, p, 0, (u32)(Hm + 8), 1);
    if (p->width != 720 || p->height < 400) continue;
    sync(k, cache, p, 0, 340, 0);
    for (j = 0; j < 3; j++) {
      n = 0;
      for (i = 0; i < 4; i++) { hex_word_le(config[(0x30 >> 2) + j * 4 + i], line + n); n += 8; line[n++] = 17; }
      text_at(p, line, n - 1, 4, 4 + (s32)row * step, Hd, white, 1); row++;
    }
    for (j = 0; j < 4; j++) {
      const u8 *q = (const u8 *)config[(0x3c >> 2) + j];
      if (!ram(q)) { line[0] = 15; line[1] = 15; text_at(p, line, 2, 4, 4 + (s32)row * step, Hd, white, 1); row += 2; continue; }
      n = hex_bytes(q, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1); row++;
      n = hex_bytes(q + 16, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1); row++;
    }
    {
      const u8 *q = (const u8 *)config[0x38 >> 2];
      if (ram(q)) {
        n = hex_bytes(q, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1); row++;
        n = hex_bytes(q + 16, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1); row++;
      }
    }
    sync(k, cache, p, 0, 340, 1);
  }
}
#endif

static u32 two_digits(u32 v, u8 *out) {
  u32 t = 0;
  while (v >= 100) v -= 100;
  while (v >= 10) { v -= 10; t++; }
  out[0] = (u8)t; out[1] = (u8)v;
  return 2;
}

/* Entry: k = context, config = JpegEncodeMacroProcess configuration. */
void datestamp(const struct ctx *k, u32 *config) {
  u8 time[16];
  u8 glyphs[MAXGLYPH];
  u32 n = 0, i, j, setting;
  struct picture *seen[4];
  void *cache, *platform;
  setting = *k->setting & 7;
  if (setting == 0 || setting > 5 || !ram(config)) return;
#ifdef DIAG
  diag(k, k->cache(), config);
#endif
  for (i = 0; i < 16; i++) time[i] = 0;
  platform = k->platform();
  if (!platform) return;
  k->get_time(((void **)platform)[1], time);
  {
    u32 year = time[0] | (u32)time[1] << 8, month = time[2], day = time[3];
    if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return;
    glyphs[n++] = 16;                  /* ' */
    n += two_digits(year, glyphs + n);
    glyphs[n++] = 17;                  /* space */
    n += two_digits(month, glyphs + n);
    glyphs[n++] = 17;
    n += two_digits(day, glyphs + n);
  }
  cache = k->cache();
  /* The pictures, one per buffer. The first one is the main picture the encoder compresses: for
   * sizes below L the camera has already scaled the photo down into the top left of the sensor
   * buffer, and another entry with the same planes describes the buffer at full size; that one is
   * skipped (drawing there would land outside the photo). */
  for (i = 0; i < 4; i++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + i];
    seen[i] = 0;
    if (!ram(p) || !picture_ok(p)) continue;
    for (j = 0; j < i; j++) if (seen[j] && seen[j]->y == p->y) break;
    if (j == i) seen[i] = p;
  }
  /* The main picture is the first one; the smaller ones (screennail, thumbnail) show it inside
   * black bars when their shape differs: draw inside the part the photo takes up. */
  {
    struct picture *mainp = seen[0];
    if (!mainp) return;
    for (i = 0; i < 4; i++) {
      struct picture *p = seen[i];
      s32 pw, ph, rw, rh;
      if (!p) continue;
      pw = p->width; ph = p->height;
      rw = pw; rh = ph;
      if (p != mainp) {
        /* rw/rh = main shape, fitted in pw x ph. Compare pw*mh with ph*mw (no division). */
        u32 mw = mainp->width, mh = mainp->height;
        u32 a1 = (u32)pw * mh, a2 = (u32)ph * mw;
        if (a1 > a2 + (a2 >> 6)) {          /* picture wider than the photo: bars left and right */
          u32 t = (u32)ph * mw, q = 0, bit;
          /* rw = ph * mw / mh by shift-subtract division */
          for (bit = 1u << 14; bit; bit >>= 1) if ((q + bit) * mh <= t) q += bit;
          rw = (s32)q;
        } else if (a2 > a1 + (a1 >> 6)) {   /* taller: bars top and bottom */
          u32 t = (u32)pw * mh, q = 0, bit;
          for (bit = 1u << 14; bit; bit >>= 1) if ((q + bit) * mw <= t) q += bit;
          rh = (s32)q;
        }
      }
      draw(k, cache, p, (pw - rw) >> 1, (ph - rh) >> 1, rw, rh, glyphs, n, colour_of(setting - 1));
    }
  }
}
