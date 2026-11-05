/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: date imprint for the Ricoh GR IV (firmware 1.11).
 *
 * Called at the start of JpegEncodeMacroProcess::Execute with the process configuration. The
 * configuration lists the YCbCr 4:2:2 pictures the JPEG encoder is about to compress (main picture,
 * screennail, thumbnail, ...). The date is drawn into each of them, bottom right, in orange
 * seven-segment digits scaled to the picture, as "'YY MM DD" or "YYYY.MM.DD hh:mm".
 *
 * Since GR Mod 0.8.3 "bottom right" is that of the picture as it is shown: a photo taken with the
 * camera held upright (or upside down) is stored as the sensor sees it, with an EXIF Orientation
 * that viewers apply, and the imprint is drawn turned so that it reads normally there.
 *
 * Since 0.8.4 either style can be followed by the name of the picture's look (its Image Control),
 * in fourteen-segment capitals drawn like the digits (the idea of PR #9 by jaylee / sjclijie).
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
#ifdef SETTING_RECORD
  /* GR III: the setting byte is at `offset` in the user-settings record, whose address is kept
   * at `record` (0 until the settings are loaded: off). */
  const u8 *const volatile *record;
  u32 offset;
#else
  const u8 *setting;                                 /* bit 0: on, bit 1: with year and time, bit 2: as stored */
#endif
#ifdef GR3_WORDS
  const volatile u32 *words;                         /* GR III test builds: halation stash, halation status */
#endif
  /* Since GR Mod 0.8.2: the look of the picture, left by the development step (GR IV 0x539113F8) as
   * look | level << 8 | 0x10000 (see lookstash.ts); 0 when the build has no such word. */
  const volatile u32 *look;
  const u8 *mono_looks;                              /* 64 bytes: 1 for a black-and-white look */
  u32 (*mono_model)(void);                           /* 0x533EF000: 1 on the GR IV Monochrome */
  /* Since 0.8.3: the orientation of the picture, value | 0x100 (see `orientation`); 0 without. */
  const volatile u32 *orient;
  /* Since 0.8.4: the look of the picture being made, as LOOK_STASH's word, left at the start of the
   * exposure (and in RAW development by the development step; see lookstash.ts); and per look
   * (0..63) its name as glyphs: {count, glyph...} (u16), or 0. */
  const volatile u32 *frame_look;
  const u16 *const *names;
#ifdef DFDIAG
  /* Test builds only: the RAM word holding the Direct Flash planner's diagnostic buffer (see
   * tools/directflash/directflash.c, DIAG), printed on the 720x480 picture. */
  const volatile u32 *df_slot;
#endif
};

/* The setting byte (see `datestamp.ts`): anything above 15 counts as off. */
#define SETTING_ON 1u
#define SETTING_LONG 2u
#define SETTING_AS_STORED 4u /* 0.8.3: "Follow Orientation" off */
#define SETTING_NAME 8u      /* 0.8.4: with the look's name */
#define SETTING_MAX 15u
/* Longest name drawn (in glyphs; GR Mod's names are at most 16). */
#define MAXNAME 24u

/* Glyph codes besides the digits 0..15. */
#define G_APOSTROPHE 16
#define G_SPACE 17
#define G_DOT 18
#define G_COLON 19

struct colour { u8 y, cb, cr; };

/* How the picture is shown, from the camera's direction as the shooting record keeps it (what the
 * EXIF writer at 0x537FEBC4 turns into the Orientation tag: 1 -> 8, 2 -> 3, 3 -> 6, else -> 1). */
#define O_NONE 0u   /* EXIF 1: as stored */
#define O_LEFT 1u   /* EXIF 8: shown turned a quarter anticlockwise */
#define O_HALF 2u   /* EXIF 3: shown upside down */
#define O_RIGHT 3u  /* EXIF 6: shown turned a quarter clockwise */
#define LOOK_VALID 0x10000u
#define ORIENT_VALID 0x100u

/* The stored pixel of shown pixel (x, y), for a stored picture of W x H. */
static void stored_at(u32 o, s32 W, s32 H, s32 x, s32 y, s32 *sx, s32 *sy) {
  if (o == O_NONE) { *sx = x; *sy = y; }
  else if (o == O_HALF) { *sx = W - 1 - x; *sy = H - 1 - y; }
  else if (o == O_RIGHT) { *sx = y; *sy = H - 1 - x; }
  else { *sx = W - 1 - y; *sy = x; }
}

/* The imprint colour: the orange of a film camera's date back. */
static struct colour orange(void) {
  struct colour c;
  c.y = 150; c.cb = 56; c.cr = 204;
  return c;
}

/* Glyph codes are 16 bits: the digits 0..15 and G_* above (seven-segment digits and marks), or
 * (0.8.4) a letter of the look's name: G_LETTER | its fourteen segments (see `letter_segs`). */
typedef u16 glyph;
#define G_LETTER 0x4000u
#define is_letter(g) (((g) & G_LETTER) != 0)

static int narrow(u32 g) { return g == G_APOSTROPHE || g == G_DOT || g == G_COLON; }
static int punct(u32 g) { return g == G_DOT || g == G_COLON; }

/* Left edge and width of each glyph at digit height H, starting at 0; returns the advance of the
 * whole run (without a gap after the last glyph). The marks ' . : are T wide; . and : sit closer to
 * their neighbours (half the gap). A space advances H/2. A letter is 13/16 H wide (a digit 9/16 H:
 * the diagonals need the room), with the digits' gap. */
static s32 layout(const glyph *glyphs, u32 count, s32 H, s32 *left, s32 *width) {
  s32 W = (H * 9) >> 4, WL = (H * 13) >> 4, T = (H * 9) >> 6, gap = (H * 5) >> 4, x = 0, end = 0;
  u32 i;
  if (T < 2) T = 2;
  for (i = 0; i < count; i++) {
    u32 g = glyphs[i];
    if (i > 0 && (punct(g) || punct(glyphs[i - 1]))) x -= gap >> 1;
    left[i] = x;
    width[i] = g == G_SPACE ? 0 : narrow(g) ? T : is_letter(g) ? WL : W;
    end = x + width[i];
    x += (g == G_SPACE ? (H >> 1) : width[i]) + gap;
  }
  return end;
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

/* A glyph is drawn as a few shapes, each with the box (1/4 px, inclusive) outside of which it has
 * no ink: a bar (in_bar), a slanted bar (a strip of half thickness t around the line through
 * (x0,y0)-(x1,y1), of length len, cut by the box) or a box. The shapes of a glyph do not overlap. */
#define S_BAR 0
#define S_SLANT 1
#define S_BOX 2
struct shape { s32 kind, x0, y0, x1, y1, t, len, bx0, by0, bx1, by1; };

static s32 isqrt(u32 v) {
  u32 r = 0, bit = 1u << 30;
  while (bit > v) bit >>= 2;
  while (bit) {
    if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; } else r >>= 1;
    bit >>= 2;
  }
  return (s32)r;
}

static void bar(struct shape *s, s32 x0, s32 y0, s32 x1, s32 y1, s32 t) {
  s->kind = S_BAR; s->x0 = x0; s->y0 = y0; s->x1 = x1; s->y1 = y1; s->t = t;
  if (y0 == y1) { s->bx0 = x0; s->bx1 = x1; s->by0 = y0 - t; s->by1 = y0 + t; }
  else { s->bx0 = x0 - t; s->bx1 = x0 + t; s->by0 = y0; s->by1 = y1; }
}

static void box(struct shape *s, s32 bx0, s32 by0, s32 bx1, s32 by1) {
  s->kind = S_BOX; s->bx0 = bx0; s->by0 = by0; s->bx1 = bx1; s->by1 = by1;
}

/* The slanted bar from corner (x0,y0) towards the centre (x1,y1), within the box. */
static void slant(struct shape *s, s32 x0, s32 y0, s32 x1, s32 y1, s32 t, s32 bx0, s32 by0, s32 bx1, s32 by1) {
  s32 dx = x1 - x0, dy = y1 - y0;
  s->kind = S_SLANT; s->x0 = x0; s->y0 = y0; s->x1 = x1; s->y1 = y1; s->t = t;
  s->len = isqrt((u32)(dx * dx + dy * dy));
  s->bx0 = bx0; s->by0 = by0; s->bx1 = bx1; s->by1 = by1;
}

static int shape_hit(const struct shape *s, s32 qx, s32 qy) {
  if (qx < s->bx0 || qx > s->bx1 || qy < s->by0 || qy > s->by1) return 0;
  if (s->kind == S_BOX) return 1;
  if (s->kind == S_BAR) return in_bar(qx, qy, s->x0, s->y0, s->x1, s->y1, s->t);
  return abs32((qx - s->x0) * (s->y1 - s->y0) - (qy - s->y0) * (s->x1 - s->x0)) <= s->t * s->len;
}

/* The shapes of glyph g in a cell of w x h (1/4 px), bar half thickness t; returns their number.
 * Digits and marks exactly as up to 0.8.3 (seven segments with gaps at the joints). Letters
 * (0.8.4): the same bars for a..f, the middle bar split in two (g1, g2), a short bar up and one
 * down from the middle, and four slanted bars between them, a little thinner. */
static u32 glyph_shapes(u32 g, s32 w, s32 h, s32 t, s32 T, struct shape *s) {
  s32 gp = t / 2 + 1; /* gap at the joints (t is a small positive number, /2 is a shift) */
  s32 l = t, r = w - t, top = t, mid = h >> 1, bot = h - t, cx = w >> 1;
  u32 n = 0, seg;
  if (g == G_SPACE) return 0;
  if (g == G_APOSTROPHE) { /* short bar at the top: qy < 5/16 h */
    box(&s[n++], T * 2 - t, -(1 << 20), T * 2 + t, ((h * 5) >> 4) - 1); return n;
  }
  if (g == G_DOT) { /* square on the baseline */
    box(&s[n++], T * 2 - t, h - 2 * t, T * 2 + t, 1 << 20); return n;
  }
  if (g == G_COLON) { /* two squares, at 5/16 and 11/16 of the height */
    box(&s[n++], T * 2 - t, ((h * 5) >> 4) - t, T * 2 + t, ((h * 5) >> 4) + t);
    box(&s[n++], T * 2 - t, ((h * 11) >> 4) - t, T * 2 + t, ((h * 11) >> 4) + t);
    return n;
  }
  seg = is_letter(g) ? g & 0x3fffu : segments(g);
  if (seg & 0x01) bar(&s[n++], l + gp, top, r - gp, top, t);
  if (seg & 0x02) bar(&s[n++], r, top + gp, r, mid - gp, t);
  if (seg & 0x04) bar(&s[n++], r, mid + gp, r, bot - gp, t);
  if (seg & 0x08) bar(&s[n++], l + gp, bot, r - gp, bot, t);
  if (seg & 0x10) bar(&s[n++], l, mid + gp, l, bot - gp, t);
  if (seg & 0x20) bar(&s[n++], l, top + gp, l, mid - gp, t);
  if (!is_letter(g)) {
    if (seg & 0x40) bar(&s[n++], l + gp, mid, r - gp, mid, t);
    return n;
  }
  if (seg & 0x40) bar(&s[n++], l + gp, mid, cx - gp, mid, t);
  if (seg & 0x80) bar(&s[n++], cx + gp, mid, r - gp, mid, t);
  if (seg & 0x200) bar(&s[n++], cx, top + gp, cx, mid - gp, t);
  if (seg & 0x1000) bar(&s[n++], cx, mid + gp, cx, bot - gp, t);
  {
    /* The slanted bars run from a corner towards the centre, cut to the room between the bars. */
    s32 d = (t * 3) >> 2, x1 = l + t + (gp >> 1), x2 = cx - t - (gp >> 1), x3 = cx + t + (gp >> 1), x4 = r - t - (gp >> 1);
    s32 y1 = top + t + (gp >> 1), y2 = mid - t - (gp >> 1), y3 = mid + t + (gp >> 1), y4 = bot - t - (gp >> 1);
    if (seg & 0x100) slant(&s[n++], l, top, cx, mid, d, x1, y1, x2, y2);
    if (seg & 0x400) slant(&s[n++], r, top, cx, mid, d, x3, y1, x4, y2);
    if (seg & 0x800) slant(&s[n++], l, bot, cx, mid, d, x1, y3, x2, y4);
    if (seg & 0x2000) slant(&s[n++], r, bot, cx, mid, d, x3, y3, x4, y4);
  }
  return n;
}

#define MAXGLYPH 64
#define MAXSHAPES 16

/* Plausible RAM address (the camera's DDR, 0x40000000..0xBFFFFFFF); anything else is not
 * dereferenced. With RAW+JPEG the scaled-down main picture of the smaller sizes lives above
 * 0xA0000000 (seen at 0xB1069CC0, test firmware 015). */
#define RAM_LOW 0x40000000u
static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= RAM_LOW && a < 0xc0000000u && (a & 3) == 0;
}
#ifdef STRICT_PLANES
/* GR III test builds: the configuration and the picture descriptors are read wherever they are
 * (the configuration is part of a process object, below 0x5d000000), but only picture planes above
 * the RTOS data and heaps (0x55..-0x5c8..) are written. */
#define PLANE_LOW 0x5d000000u
static int plane(const void *p) {
  u32 a = (u32)p;
  return a >= PLANE_LOW && a < 0xc0000000u && (a & 3) == 0;
}
#else
#define plane(p) ram(p)
#define PLANE_LOW RAM_LOW
#endif

static void sync(const struct ctx *k, void *cache, struct picture *p, u32 y0, u32 y1, int clean) {
  u32 a, b;
  a = (u32)p->y + y0 * p->stride; b = (u32)p->y + y1 * p->stride;
  a &= ~63u; b = (b + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
  a = (u32)p->c + y0 * p->stride; b = (u32)p->c + y1 * p->stride;
  a &= ~63u; b = (b + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
}

/* Draw `count` glyphs with their top left corner at (x0, y0) of the picture as it is shown
 * (orientation `o`), digit height H. With `bg` (test builds only, always O_NONE), the box behind
 * them is filled with black first. The caller has checked that the box lies inside the picture and
 * handles the cache.
 *
 * Each pixel is sampled at 2 x 2 points and blended by the share of them inside the glyph. Only
 * the pixels of each row that are inside a shape's box are looked at (0.8.4; the result is the
 * same as sampling every pixel of the cell, as up to 0.8.3, at a fraction of the cost). */
static void text_at(struct picture *p, const glyph *glyphs, u32 count, s32 x0, s32 y0, s32 H, struct colour col, int bg, u32 o) {
  s32 T, total;
  s32 left[MAXGLYPH], width[MAXGLYPH];
  u32 i;
  T = (H * 9) >> 6;
  if (T < 2) T = 2;
  if (count > MAXGLYPH) return;
  total = layout(glyphs, count, H, left, width);
  for (i = 0; i < count; i++) left[i] += x0;
  if (bg) {
    s32 py, px;
    for (py = -2; py < H + 2; py++) {
      u8 *yrow = p->y + (u32)(y0 + py) * p->stride;
      u8 *crow = p->c + (u32)(y0 + py) * p->stride;
      for (px = -2; px < total + 2; px++) { yrow[x0 + px] = 16; crow[(x0 + px) & ~1] = 128; crow[((x0 + px) & ~1) + 1] = 128; }
    }
  }
  for (i = 0; i < count; i++) {
    struct shape s[MAXSHAPES];
    u32 n, j;
    s32 qH = H * 4, qT = T * 2; /* half thickness in 1/4 px: T/2 * 4 */
    s32 py;
    n = glyph_shapes(glyphs[i], width[i] * 4, qH, qT, T, s);
    if (!n) continue;
    for (py = 0; py < H; py++) {
      s32 qa = py * 4 + 1, qb = py * 4 + 3;
      s32 sx0[MAXSHAPES], sx1[MAXSHAPES];
      u32 act[MAXSHAPES], na = 0, ns = 0, a, b;
      /* The shapes this row's sample points can be in, and their pixel spans. */
      for (j = 0; j < n; j++) {
        s32 p0, p1;
        if (s[j].by1 < qa || s[j].by0 > qb) continue;
        act[na++] = j;
        p0 = s[j].bx0 >> 2;       /* the first pixel whose sample points (4 px + 1, + 3) reach bx0 */
        p1 = (s[j].bx1 - 1) >> 2; /* the last whose first sample point is within bx1 */
        if (p0 < 0) p0 = 0;
        if (p1 > width[i] - 1) p1 = width[i] - 1;
        if (p0 > p1) continue;
        /* Insert in order of start, then merge overlapping or touching spans. */
        for (a = ns; a > 0 && sx0[a - 1] > p0; a--) { sx0[a] = sx0[a - 1]; sx1[a] = sx1[a - 1]; }
        sx0[a] = p0; sx1[a] = p1; ns++;
      }
      if (!ns) continue;
      for (a = 0, b = 1; b < ns; b++) {
        if (sx0[b] <= sx1[a] + 1) { if (sx1[b] > sx1[a]) sx1[a] = sx1[b]; }
        else { a++; sx0[a] = sx0[b]; sx1[a] = sx1[b]; }
      }
      ns = a + 1;
      for (a = 0; a < ns; a++) {
        s32 px;
        for (px = sx0[a]; px <= sx1[a]; px++) {
          u32 cov = 0, sx, sy, q;
          for (sy = 0; sy < 2; sy++) for (sx = 0; sx < 2; sx++) {
            s32 qx = px * 4 + 1 + (s32)sx * 2, qy = py * 4 + 1 + (s32)sy * 2;
            for (q = 0; q < na; q++) if (shape_hit(&s[act[q]], qx, qy)) { cov++; break; }
          }
          if (cov) {
            s32 X, Y;
            u8 *yp, *cp;
            stored_at(o, p->width, p->height, left[i] + px, y0 + py, &X, &Y);
            yp = p->y + (u32)Y * p->stride + (u32)X;
            cp = p->c + (u32)Y * p->stride + (u32)(X & ~1);
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
static s32 text_width(const glyph *glyphs, u32 count, s32 H) {
  s32 left[MAXGLYPH], width[MAXGLYPH];
  if (count > MAXGLYPH) return 1 << 20;
  return layout(glyphs, count, H, left, width);
}

/* The picture is a window into a larger buffer: the planes start at the window's top left, `stride`
 * and `c_height` are those of the buffer (on the camera, 6208 and 4128: the whole sensor). */
static int picture_ok(const struct picture *p) {
  u32 w = p->width, h = p->height;
  if (p->format != 1 || !plane(p->y) || !plane(p->c) || w < 120 || h < 80 || p->stride < w || p->c_height < h) return 0;
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

/* Whether the photo is black and white: from its look (and the camera model) when the build
 * leaves the look; otherwise, as up to 0.8.1, from its colours. -1: decide from the colours. */
static int mono_by_look(const struct ctx *k) {
  u32 v;
  if (!k->look) return -1;
  v = *k->look;
  if (!(v & LOOK_VALID)) return -1;
  if ((v & 0xffu) < 64u && k->mono_looks[v & 0xffu]) return 1;
  return k->mono_model() ? 1 : 0;
}

/* Draw into the rectangle (rx, ry, rw, rh) of the picture (stored coordinates), bottom right as
 * the picture is shown (orientation `o`): the date (`nd` glyphs) and after it, `nn` glyphs of the
 * look's name (the two spaces before it included; 0: none). `mono`: -1 decide from the picture's
 * colours, else 0 / 1.
 *
 * The line with the name is drawn only where it fits with a margin on either side: at the date's
 * height, else made smaller (down to 3/4 of it), else with the name cut short at that height (at
 * least one letter left); otherwise the date alone is drawn, as without the name. */
static void draw(const struct ctx *k, void *cache, struct picture *p, s32 rx, s32 ry, s32 rw, s32 rh, const glyph *glyphs, u32 nd, u32 nn, struct colour col, int mono, u32 o) {
  s32 H, H0, margin, x0, y0, tw, W = p->width, PH = p->height;
  s32 vx, vy, vw, vh, VH, r0, r1;
  u32 count = nd + nn;
  /* Digit height ~ 1/26 of the shorter side, at least 7 px. */
  H0 = (s32)(((u32)(rw < rh ? rw : rh) * 2521u) >> 16);
  if (H0 < 7) H0 = 7;
  /* The rectangle as shown, in a picture of ? x VH. */
  if (o == O_NONE) { vx = rx; vy = ry; vw = rw; vh = rh; VH = PH; }
  else if (o == O_HALF) { vx = W - rx - rw; vy = PH - ry - rh; vw = rw; vh = rh; VH = PH; }
  else if (o == O_RIGHT) { vx = PH - ry - rh; vy = rx; vw = rh; vh = rw; VH = W; }
  else { vx = ry; vy = W - rx - rw; vw = rh; vh = rw; VH = W; }
  H = H0;
  if (nn > 2) {
    s32 Hmin = (H0 * 3) >> 2;
    for (;;) {
      if (text_width(glyphs, count, H) + 3 * H <= vw) break; /* margin 3/2 H on each side */
      if (H > Hmin) { H--; continue; }
      do count--; while (count > nd + 2 && glyphs[count - 1] == G_SPACE);
      if (count <= nd + 2) { count = nd; H = H0; break; }
    }
  } else count = nd;
  margin = (H * 3) >> 1;
  tw = text_width(glyphs, count, H);
  x0 = vx + vw - margin - tw;
  y0 = vy + vh - margin - H;
  if (x0 < 2 || y0 < 2 || y0 + H + 2 > VH) return;
  /* Only where it fits into the photo: on a tall photo (an XPan shot held upright) the long style
   * at the smallest digit height is wider than the thumbnail's photo; that picture gets none. */
  if (x0 < vx || y0 < vy) return;
  if (mono < 0) mono = is_mono(k, cache, p, rx, ry, rw, rh);
  if (mono) { col.cb = 128; col.cr = 128; } /* light only, like on black-and-white film */
  /* The stored rows the box covers. */
  if (o == O_NONE) { r0 = y0; r1 = y0 + H + 1; }
  else if (o == O_HALF) { r0 = PH - 1 - (y0 + H); r1 = PH - y0; }
  else if (o == O_RIGHT) { r0 = PH - 1 - (x0 + tw); r1 = PH - x0; }
  else { r0 = x0; r1 = x0 + tw + 1; }
  sync(k, cache, p, (u32)r0, (u32)r1, 0);
  text_at(p, glyphs, count, x0, y0, H, col, 0, o);
  sync(k, cache, p, (u32)r0, (u32)r1, 1);
}

/* The orientation of the picture: left at the start of the exposure (the camera's direction) or,
 * in RAW development, by the development step (see lookstash.ts and datestamp.ts); O_NONE without.
 * GR III builds (-DGR3_PACKED; GR III has no room for two more words): one byte, value | 0x80. */
static u32 orientation(const struct ctx *k) {
  u32 v;
  if (!k->orient) return O_NONE;
#ifdef GR3_PACKED
  v = *(const volatile u8 *)k->orient;
  if (!(v & 0x80u)) return O_NONE;
#else
  v = *k->orient;
  if (!(v & ORIENT_VALID)) return O_NONE;
#endif
  return v & 3u;
}

/* The look of the picture being made, as LOOK_STASH's word (only the look and LOOK_VALID are
 * used); 0 without. GR III builds (-DGR3_PACKED): a halfword, look | 0x8000. */
static u32 frame_look(const struct ctx *k) {
  if (!k->frame_look) return 0;
#ifdef GR3_PACKED
  {
    u32 h = *(const volatile u16 *)k->frame_look;
    return (h & 0x8000u) ? ((h & 0xffu) | LOOK_VALID) : 0;
  }
#else
  return *k->frame_look;
#endif
}

#ifdef DIAG
/* Test builds: the configuration and the four pictures it points at, as hex, top left of every
 * 720-pixel-wide picture. Rows 0..2: config words 0x30..0x5c, 4 per row; then per picture 2 rows of 16 bytes
 * (or "-" for no picture); then 32 bytes at config[0x38]. */
static u32 hex_bytes(const u8 *b, u32 n, glyph *out) {
  u32 i, m = 0;
  for (i = 0; i < n; i++) {
    out[m++] = b[i] >> 4; out[m++] = b[i] & 15;
    if ((i & 3) == 3 && i + 1 < n) out[m++] = 17;
  }
  return m;
}
static void hex_word_le(u32 v, glyph *out) {
  s32 i;
  for (i = 7; i >= 0; i--) { out[i] = v & 15; v >>= 4; }
}
static int wide_ram(const void *p) {
  u32 a = (u32)p;
  return a >= PLANE_LOW && a < 0xc0000000u;
}
/* Why picture_ok refuses a picture, as a hex digit: 1 format, 2 planes outside 0x40000000..0xc0000000,
 * 4 size, 8 stride / CbCr height. 0 = accepted. */
static u32 refusal(const struct picture *p) {
  u32 r = 0, w = p->width, h = p->height;
  if (p->format != 1) r |= 1;
  if (!plane(p->y) || !plane(p->c)) r |= 2;
  if (w < 120 || h < 80 || w > 12000 || h > 12000) r |= 4;
  if (p->stride < w || p->c_height < h) r |= 8;
  return r;
}
/* Called first thing on every Execute, whatever the pictures are: the dump goes on every
 * 720-pixel-wide picture of the configuration whose planes look like memory at all. Row 0:
 * marker "A" then per slot the refusal digit (F = no picture). */
static void diag(const struct ctx *k, void *cache, u32 *config) {
  glyph line[MAXGLYPH];
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
#ifdef STRICT_PLANES
    if (p->c_height < (u32)(Hm + 8)) continue;
#endif
    sync(k, cache, p, 0, (u32)(Hm + 8), 0);
    n = 0;
    line[n++] = 10; line[n++] = 17;
    for (i = 0; i < 4; i++) {
      struct picture *q = (struct picture *)config[(0x3c >> 2) + i];
      line[n++] = ram(q) ? (glyph)refusal(q) : 15;
    }
    line[n++] = 17; line[n++] = (glyph)s;
#ifdef GR3_WORDS
    /* then the halation stash and the halation module's status (wide pictures only) */
    if (p->width >= 640 && ram((const void *)k->words)) {
      line[n++] = 17; hex_word_le(k->words[0], line + n); n += 8;
      line[n++] = 17; hex_word_le(k->words[1], line + n); n += 8;
    }
#endif
    text_at(p, line, n, 4, 4, Hm, white, 1, O_NONE); row++;
    sync(k, cache, p, 0, (u32)(Hm + 8), 1);
    if (p->width != 720 || p->height < 400) continue;
#ifdef STRICT_PLANES
    if (p->c_height < 340) continue;
#endif
    sync(k, cache, p, 0, 340, 0);
    for (j = 0; j < 3; j++) {
      n = 0;
      for (i = 0; i < 4; i++) { hex_word_le(config[(0x30 >> 2) + j * 4 + i], line + n); n += 8; line[n++] = 17; }
      text_at(p, line, n - 1, 4, 4 + (s32)row * step, Hd, white, 1, O_NONE); row++;
    }
    for (j = 0; j < 4; j++) {
      const u8 *q = (const u8 *)config[(0x3c >> 2) + j];
      if (!ram(q)) { line[0] = 15; line[1] = 15; text_at(p, line, 2, 4, 4 + (s32)row * step, Hd, white, 1, O_NONE); row += 2; continue; }
      n = hex_bytes(q, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1, O_NONE); row++;
      n = hex_bytes(q + 16, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1, O_NONE); row++;
    }
    {
      const u8 *q = (const u8 *)config[0x38 >> 2];
      if (ram(q)) {
        n = hex_bytes(q, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1, O_NONE); row++;
        n = hex_bytes(q + 16, 16, line); text_at(p, line, n, 4, 4 + (s32)row * step, Hd, white, 1, O_NONE); row++;
      }
    }
    sync(k, cache, p, 0, 340, 1);
  }
}
#endif


#ifdef DFDIAG
/* Direct Flash diagnostics (test builds only): the planner's two latest records, as labelled rows
 * of numbers (APEX values with two decimals), top left of the 720x480 picture on a black box. */
#define L_A 247u
#define L_C 57u
#define L_D 4623u
#define L_E 249u
#define L_F 241u
#define L_I 4617u
#define L_K 9328u
#define L_L 56u
#define L_M 1334u
#define L_N 8502u
#define L_O 63u
#define L_R 8435u
#define L_S 237u
#define L_T 4609u
#define L_V 3120u
#define G_MINUS (G_LETTER | 0xc0u)
#define DF_WORDS 32
static u32 dec_digit(u32 *v, u32 pw, glyph *out, u32 n, u32 *started) {
  u32 d = 0;
  while (*v >= pw) { *v -= pw; d++; }
  if (d || *started || pw == 1u) { out[n++] = (glyph)d; *started = 1; }
  return n;
}
static u32 dec_u(u32 v, glyph *out) {
  u32 n = 0, started = 0;
  if (v > 9999999u) v = 9999999u;
  n = dec_digit(&v, 1000000u, out, n, &started);
  n = dec_digit(&v, 100000u, out, n, &started);
  n = dec_digit(&v, 10000u, out, n, &started);
  n = dec_digit(&v, 1000u, out, n, &started);
  n = dec_digit(&v, 100u, out, n, &started);
  n = dec_digit(&v, 10u, out, n, &started);
  return dec_digit(&v, 1u, out, n, &started);
}
static u32 dec_s(s32 v, glyph *out) {
  u32 n = 0;
  if (v < 0) { out[n++] = G_MINUS; v = -v; }
  return n + dec_u((u32)v, out + n);
}
/* v / 100 with two decimals. */
static u32 dec_x100(s32 v, glyph *out) {
  u32 n = 0, u, ip = 0;
  if (v < 0) { out[n++] = G_MINUS; v = -v; }
  u = (u32)v;
  while (u >= 100u) { u -= 100u; ip++; }
  n += dec_u(ip, out + n);
  out[n++] = G_DOT;
  out[n++] = 0;
  while (u >= 10u) { u -= 10u; out[n - 1]++; }
  out[n++] = (glyph)u;
  return n;
}
/* `fields`: up to 6 field numbers, 5 bits each, the first in the low bits. */
static void df_row(struct picture *p, s32 row, u32 l1, u32 l2, const s32 *r, u32 fields, u32 count, u32 x100mask) {
  glyph line[MAXGLYPH];
  u32 n = 0, i;
  struct colour white = { 235, 128, 128 };
  line[n++] = (glyph)(G_LETTER | l1);
  if (l2) line[n++] = (glyph)(G_LETTER | l2);
  for (i = 0; i < count && n < MAXGLYPH - 12; i++) {
    line[n++] = G_SPACE; line[n++] = G_SPACE;
    u32 f = (fields >> (5 * i)) & 31u;
    n += (x100mask >> i) & 1 ? dec_x100(r[f], line + n) : dec_s(r[f], line + n);
  }
  text_at(p, line, n, 6, 6 + row * 22, 16, white, 1, O_NONE);
}
static void df_diag(const struct ctx *k, void *cache, u32 *config) {
#define F5(a, b, c, d, e, f) ((u32)(a) | (u32)(b) << 5 | (u32)(c) << 10 | (u32)(d) << 15 | (u32)(e) << 20 | (u32)(f) << 25)
  const u32 *buf;
  u32 s, j, calls;
  if (!k->df_slot) return;
  buf = (const u32 *)*k->df_slot;
  for (s = 0; s < 4; s++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + s];
    s32 row = 0; /* rows 0..6: the last call; 8..14: the one before */
    glyph line[MAXGLYPH];
    struct colour white = { 235, 128, 128 };
    if (!ram(p) || p->width != 720 || p->height < 400 || p->stride < p->width || !ram(p->y) || !ram(p->c)) continue;
    sync(k, cache, p, 0, 360, 0);
    if (!ram(buf)) {
      line[0] = (glyph)(G_LETTER | L_D); line[1] = (glyph)(G_LETTER | L_F); line[2] = G_SPACE; line[3] = 0;
      text_at(p, line, 4, 6, 6, 16, white, 1, O_NONE);
      sync(k, cache, p, 0, 360, 1);
      continue;
    }
    calls = buf[0];
    for (j = 0; j < 2; j++) {
      const s32 *r = (const s32 *)(buf + 1 + ((calls - j) & 1) * DF_WORDS);
      df_row(p, row++, L_N, 0, r, F5(0, 1, 2, 3, 4, 0), 5, 0);       /* call reason program mode kind */
      df_row(p, row++, L_M, 0, r, F5(5, 6, 7, 8, 0, 0), 4, 0);       /* ND-setting ISO-auto output distance(mm) */
      df_row(p, row++, L_E, L_V, r, F5(9, 10, 11, 12, 13, 14), 6, 0x3f); /* Ev F70 F74 sync Tv-hi Tv-lo */
      df_row(p, row++, L_O, L_F, r, F5(15, 16, 17, 0, 0, 0), 3, 0x7);  /* the camera's own Tv Av Sv */
      df_row(p, row++, L_D, L_F, r, F5(18, 19, 20, 21, 22, 23), 6, 0x37); /* Tv Av Sv ND ambient-err flash-err */
      df_row(p, row++, L_S, L_V, r, F5(24, 25, 28, 29, 30, 31), 6, 0x3f); /* Sv-lo Sv-hi F10 F14 Fa0 Fa4 */
      df_row(p, row++, L_A, L_V, r, F5(26, 27, 0, 0, 0, 0), 2, 0x3);  /* Av-lo Av-hi */
      row = 8;
    }
    sync(k, cache, p, 0, 360, 1);
  }
}
#endif

static u32 two_digits(u32 v, glyph *out) {
  u32 t = 0;
  while (v >= 100) v -= 100;
  while (v >= 10) { v -= 10; t++; }
  out[0] = (glyph)t; out[1] = (glyph)v;
  return 2;
}

/* Entry: k = context, config = JpegEncodeMacroProcess configuration. */
void datestamp(const struct ctx *k, u32 *config) {
  u8 time[16];
  glyph glyphs[MAXGLYPH];
  u32 n = 0, nd, nn = 0, i, j, setting;
  struct picture *seen[4];
  void *cache, *platform;
#ifdef SETTING_RECORD
  {
    const u8 *r = *k->record;
    if (!ram(r) || k->offset >= 0x1000u) return;
    setting = r[k->offset];
  }
#else
  setting = *k->setting;
#endif
#ifdef DFDIAG
  if (ram(config)) df_diag(k, k->cache(), config);
#endif
  if (setting > SETTING_MAX || !(setting & SETTING_ON) || !ram(config)) return;
#ifdef DIAG
  diag(k, k->cache(), config);
#endif
  for (i = 0; i < 16; i++) time[i] = 0;
  platform = k->platform();
  if (!platform) return;
  k->get_time(((void **)platform)[1], time);
  {
    u32 year = time[0] | (u32)time[1] << 8, month = time[2], day = time[3], hour = time[4], minute = time[5];
    if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return;
    if (setting & SETTING_LONG) {      /* 2026.10.08 17:34 */
      if (hour > 23 || minute > 59) return;
      glyphs[n++] = 2; glyphs[n++] = 0;
      n += two_digits(year, glyphs + n);
      glyphs[n++] = G_DOT;
      n += two_digits(month, glyphs + n);
      glyphs[n++] = G_DOT;
      n += two_digits(day, glyphs + n);
      glyphs[n++] = G_SPACE;
      n += two_digits(hour, glyphs + n);
      glyphs[n++] = G_COLON;
      n += two_digits(minute, glyphs + n);
    } else {                           /* '26 10 08 */
      glyphs[n++] = G_APOSTROPHE;
      n += two_digits(year, glyphs + n);
      glyphs[n++] = G_SPACE;
      n += two_digits(month, glyphs + n);
      glyphs[n++] = G_SPACE;
      n += two_digits(day, glyphs + n);
    }
  }
  nd = n;
  /* The look's name: the look of the picture being made (left at the start of the exposure, or in
   * RAW development), else the look the development step last saw. */
  if ((setting & SETTING_NAME) && k->names) {
    u32 v = frame_look(k);
    if (!(v & LOOK_VALID) && k->look) v = *k->look;
    if ((v & LOOK_VALID) && (v & 0xffu) < 64u) {
      const u16 *name = k->names[v & 0xffu];
      if (ram(name) && name[0] > 0) {
        u32 m = name[0] > MAXNAME ? MAXNAME : name[0];
        glyphs[n++] = G_SPACE; glyphs[n++] = G_SPACE;
        for (i = 0; i < m; i++) glyphs[n++] = name[1 + i];
        nn = n - nd;
      }
    }
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
    int mono;
    u32 o;
    if (!mainp) return;
    mono = mono_by_look(k);
    o = (setting & SETTING_AS_STORED) ? O_NONE : orientation(k);
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
      /* The thumbnail (160 x 120) gets the date alone. */
      draw(k, cache, p, (pw - rw) >> 1, (ph - rh) >> 1, rw, rh, glyphs, nd, pw <= 160 ? 0 : nn, orange(), mono, o);
    }
  }
}
