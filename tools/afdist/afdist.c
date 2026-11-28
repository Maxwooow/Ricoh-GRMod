// SPDX-License-Identifier: GPL-2.0-only
// The focus distance while autofocusing (GR IV 1.20 / 1.21; core/src/fw/gr4v120/aspect/afdist.ts): the number under the
// shooting screen's focus frame (under the distance scale while there is no frame).
//
//   afdist(ctx, 0, views)              the shooting screen has made its views: make the number's view
//   afdist(ctx, 1 | 2, lv, scale)      the distance scale has been hidden (1) or shown (2): the number with it
//   afdist(ctx, 3, lv)                 the focus frames have been placed: the number under them
//
// Position independent, no data sections: every firmware address comes in `struct ctx`, written by afdist.ts.
// The number's view is a child of the screen's root view; its address and what it shows are kept in four words added
// to the end of the scale's view (afdist.ts makes its allocation larger, has the scale's constructor clear them and
// its destructor free the number's view).
typedef unsigned char u8; typedef unsigned int u32; typedef int s32;

struct desc { u8 type; u8 pad[3]; s32 x, y, w, h; };   // what the camera's view factory reads

struct ctx {
  u32 magic;                                        // 0
  void *(*factory)(const struct desc *);            // 1  0x535AD1B4
  void (*add_child)(void *parent, void *child);     // 2  0x535AB428
  void (*set_visible)(void *view, u32 on);          // 3  0x535ACD84
  void (*set_text)(void *view, const char *text);   // 4  0x53590490 AsciiView::SetText
  void (*set_align)(void *view, u32 how);           // 5  0x5359043C
  void (*set_font)(void *view, u32 w, u32 h);       // 6  0x53590458
  void (*set_edge)(void *view, u32 how);            // 7  0x53590590
  void (*move)(void *view, const s32 *point);       // 8  0x535AC024
  const s32 *positions;                             // 9  0x53DBF9BC: x, y of each item, 0x30 items a layout
  u32 flags;                                        // 10 bit 0: feet and inches
  u32 (*text_width)(void *view);                    // 11 0x53590BE0: the width of an AsciiView's text, px
  void (*set_width)(void *view, u32 width);         // 12 0x535AC264
};

#define MAGIC 0x41464453u          // "SDFA"
#define SCALE_ITEM 26u
#define VIEW_WORDS 0x128u          // the scale's own size: our words follow
#define W_VIEW 0u                  // the number's view
#define W_SHOWN 1u                 // the distance its text was made from, mm; ~0: none
#define W_WIDTH 2u                 // the view's width, px (its text's and a margin)
#define W_PLACE 3u                 // where it was placed: PLACED | y << 16 | x; 0: not placed
#define PLACED 0x80000000u
// The screen (LiveViewController) and its views.
#define LV_VIEW(i) (0x15cu + 4u * (i))
#define LV_LAYOUT 0x2d4u
#define LV_INFO 0x4ecu
#define FRAMES_ITEM 44u            // the view that holds the focus frames
#define FRAME_FIRST 62u            // 25 frames (view type 5), then the 68 x 68 target (view 87)
#define FRAME_COUNT 25u
#define V_RECT 0x20u               // a view's x, y, width, height in its parent
#define V_VISIBLE 0x9eu
#define FRAME_KIND 0xeeu           // a frame's kind (0x53597AE4 sets it)
#define KIND_AREA 0x1bu            // one of the several frames of an area in focus (0x5318D350)
#define SCREEN_W 720
#define SCREEN_BOTTOM 440          // the screen's bottom line of information begins here
#define TEXT_H 20
#define GAP 4
#define MARGIN 4u
#define MAX_WIDTH 200u
#define INFINITY_MM 30000u         // the camera's own "far end" (0x5396A804)

static u32 ram(const void *p) { u32 a = (u32)p; return a >= 0x54000000u && a < 0x60000000u && !(a & 3u); }

static u32 put_dec(char *p, u32 v) {
  char t[6]; u32 n = 0, i;
  do { u32 q = v / 10u; t[n++] = (char)('0' + (v - q * 10u)); v = q; } while (v && n < 6u);
  for (i = 0; i < n; i++) p[i] = t[n - 1u - i];
  return n;
}

// 350 -> "0.35M", 1800 -> "1.8M", 12400 -> "12M", the far end -> "INF"; in feet: 350 -> "13.8IN", 1800 -> "5.9FT",
// 12400 -> "41FT". Capitals: the camera's own texts in this kind of view have no small letters.
static void format(u32 feet, u32 mm, char *o) {
  u32 n = 0;
  if (mm >= INFINITY_MM) { o[0] = 'I'; o[1] = 'N'; o[2] = 'F'; o[3] = 0; return; }
  if (feet) {
    u32 in10 = (mm * 100u + 127u) / 254u;                    // tenths of an inch
    if (in10 < 120u) {
      n += put_dec(o + n, in10 / 10u); o[n++] = '.'; o[n++] = (char)('0' + in10 % 10u); o[n++] = 'I'; o[n++] = 'N';
    } else {
      u32 ft10 = (mm * 100u + 1524u) / 3048u;                // tenths of a foot
      if (ft10 < 100u) { n += put_dec(o + n, ft10 / 10u); o[n++] = '.'; o[n++] = (char)('0' + ft10 % 10u); }
      else n += put_dec(o + n, (ft10 + 5u) / 10u);
      o[n++] = 'F'; o[n++] = 'T';
    }
  } else {
    u32 cm = (mm + 5u) / 10u, dm = (mm + 50u) / 100u;
    if (cm < 100u) { o[n++] = '0'; o[n++] = '.'; o[n++] = (char)('0' + cm / 10u); o[n++] = (char)('0' + cm % 10u); }
    else if (dm < 100u) { n += put_dec(o + n, dm / 10u); o[n++] = '.'; o[n++] = (char)('0' + dm % 10u); }
    else n += put_dec(o + n, (mm + 500u) / 1000u);
    o[n++] = 'M';
  }
  o[n] = 0;
}

static void create(const struct ctx *c, void **views) {
  struct desc d;
  u32 *scale = (u32 *)views[SCALE_ITEM];
  void *root = views[0], *t;
  if (!ram(scale) || !ram(root)) return;
  scale[VIEW_WORDS / 4u + W_VIEW] = 0; scale[VIEW_WORDS / 4u + W_SHOWN] = ~0u; scale[VIEW_WORDS / 4u + W_WIDTH] = 100; scale[VIEW_WORDS / 4u + W_PLACE] = 0;
  d.type = 0; d.pad[0] = d.pad[1] = d.pad[2] = 0; d.x = 0; d.y = 0; d.w = 100; d.h = TEXT_H;
  t = c->factory(&d);
  if (!ram(t)) return;
  c->add_child(root, t);
  c->set_align(t, 1); c->set_font(t, 0x14, 0x14); c->set_edge(t, 1);     // as the screen's own small text (view 8)
  c->set_visible(t, 0);
  scale[VIEW_WORDS / 4u + W_VIEW] = (u32)t;
}

// The focus frames the screen shows now, as one box (left, top, right, bottom on the screen): the first shown frame;
// with it the others when it is one of the several frames of an area in focus. 0: no frame is shown.
static u32 frames(const u8 *lv, s32 *box) {
  const u8 *holder = *(const u8 *const *)(lv + LV_VIEW(FRAMES_ITEM));
  u32 i, found = 0;
  s32 ox, oy;
  if (!ram(holder) || !holder[V_VISIBLE]) return 0;
  ox = ((const s32 *)(holder + V_RECT))[0]; oy = ((const s32 *)(holder + V_RECT))[1];
  for (i = 0; i <= FRAME_COUNT; i++) {
    const u8 *v = *(const u8 *const *)(lv + LV_VIEW(FRAME_FIRST + i));
    const s32 *r;
    s32 l, t;
    u32 area;
    if (!ram(v) || !v[V_VISIBLE]) continue;
    r = (const s32 *)(v + V_RECT);
    if (r[2] <= 0 || r[3] <= 0) continue;
    area = i < FRAME_COUNT && v[FRAME_KIND] == KIND_AREA;
    l = ox + r[0]; t = oy + r[1];
    if (!found) {
      box[0] = l; box[1] = t; box[2] = l + r[2]; box[3] = t + r[3]; found = 1;
      if (!area) break;
    } else if (area) {
      if (l < box[0]) box[0] = l;
      if (t < box[1]) box[1] = t;
      if (l + r[2] > box[2]) box[2] = l + r[2];
      if (t + r[3] > box[3]) box[3] = t + r[3];
    }
  }
  return found;
}

// The number goes with the scale in the autofocus settings only (Focus 0..4, 14, 15): manual focus and snap keep the
// camera's own screen. Its view is as wide as its text (and a margin), so the text is in the middle of it however the
// view aligns; it is placed centred under the focus frames (over them where the screen's bottom line would be in the
// way), and while no frame is shown under the scale as before.
static void update(const struct ctx *c, const u8 *lv, u32 *scale, u32 shown) {
  u32 *w, focus, mm, place;
  const u8 *info;
  void *t;
  char text[12];
  s32 box[4], x, y, width;
  if (!ram(scale) || !ram(lv)) return;
  w = scale + VIEW_WORDS / 4u;
  t = (void *)w[W_VIEW];
  if (!ram(t)) return;
  info = *(const u8 *const *)(lv + LV_INFO);
  focus = ram(info) ? info[0x998] : 9u;
  if (!shown || !(focus <= 4u || focus == 14u || focus == 15u)) { c->set_visible(t, 0); return; }
  mm = *(const u32 *)(info + 0x6e8);
  if (mm != w[W_SHOWN]) {
    u32 tw;
    w[W_SHOWN] = mm; format(c->flags & 1u, mm, text); c->set_text(t, text);
    tw = c->text_width(t);
    tw = tw ? tw + MARGIN : 100u;                                      // no width known: as the view was made
    if (tw > MAX_WIDTH) tw = MAX_WIDTH;
    if (tw != w[W_WIDTH]) { w[W_WIDTH] = tw; c->set_width(t, tw); }
  }
  width = (s32)w[W_WIDTH];
  if (frames(lv, box)) {
    x = (box[0] + box[2] - width) / 2;
    y = box[3] + GAP;
    if (y + TEXT_H > SCREEN_BOTTOM) y = box[1] - GAP - TEXT_H;
  } else {
    u32 layout = lv[LV_LAYOUT];
    if (layout > 3u) layout = 0;
    x = c->positions[layout * 0x60u + SCALE_ITEM * 2u] + 2;
    y = c->positions[layout * 0x60u + SCALE_ITEM * 2u + 1u];
    y = y + 202 + TEXT_H <= 480 ? y + 202 : y - 2 - TEXT_H;            // the scale is 200 high: under it, or over it at the bottom
  }
  if (x + width > SCREEN_W) x = SCREEN_W - width;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (y > 480 - TEXT_H) y = 480 - TEXT_H;
  place = PLACED | ((u32)y << 16) | (u32)x;
  if (place != w[W_PLACE]) {
    s32 at[2];
    at[0] = x; at[1] = y;
    c->move(t, at);
    w[W_PLACE] = place;
  }
  c->set_visible(t, 1);
}

u32 afdist(const struct ctx *c, u32 which, u32 a, u32 b) {
  if (c->magic != MAGIC) return 0;
  if (which == 0) create(c, (void **)a);
  else if (which == 1 || which == 2) update(c, (const u8 *)a, (u32 *)b, which - 1u);
  else if (which == 3 && ram((const void *)a)) {
    const u8 *scale = *(const u8 *const *)(a + LV_VIEW(SCALE_ITEM));
    if (ram(scale)) update(c, (const u8 *)a, (u32 *)scale, scale[V_VISIBLE]);
  }
  return 0;
}
