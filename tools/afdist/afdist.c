// SPDX-License-Identifier: GPL-2.0-only
// The focus distance while autofocusing (GR IV 1.20 / 1.21; core/src/fw/gr4v120/aspect/afdist.ts): the number under the
// shooting screen's distance scale.
//
//   afdist(ctx, 0, views)              the shooting screen has made its views: make the number's view
//   afdist(ctx, 1 | 2, lv, scale)      the distance scale has been hidden (1) or shown (2): the number with it
//
// Position independent, no data sections: every firmware address comes in `struct ctx`, written by afdist.ts.
// The number's view is a child of the screen's root view; its address and what it shows are kept in three words added
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
};

#define MAGIC 0x41464453u          // "SDFA"
#define SCALE_ITEM 26u
#define VIEW_WORDS 0x128u          // the scale's own size: our words follow
#define W_VIEW 0u                  // the number's view
#define W_SHOWN 1u                 // the distance its text was made from, mm; ~0: none
#define W_LAYOUT 2u                // the layout it was placed for + 1; 0: not placed
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
  scale[VIEW_WORDS / 4u + W_VIEW] = 0; scale[VIEW_WORDS / 4u + W_SHOWN] = ~0u; scale[VIEW_WORDS / 4u + W_LAYOUT] = 0;
  d.type = 0; d.pad[0] = d.pad[1] = d.pad[2] = 0; d.x = 0; d.y = 0; d.w = 100; d.h = 20;
  t = c->factory(&d);
  if (!ram(t)) return;
  c->add_child(root, t);
  c->set_align(t, 1); c->set_font(t, 0x14, 0x14); c->set_edge(t, 1);     // as the screen's own small text (view 8)
  c->set_visible(t, 0);
  scale[VIEW_WORDS / 4u + W_VIEW] = (u32)t;
}

// The number goes with the scale in the autofocus settings only (Focus 0..4, 14, 15): manual focus and snap keep the
// camera's own screen.
static void update(const struct ctx *c, const u8 *lv, u32 *scale, u32 shown) {
  u32 *w, focus, mm, layout;
  const u8 *info;
  void *t;
  char text[12];
  if (!ram(scale) || !ram(lv)) return;
  w = scale + VIEW_WORDS / 4u;
  t = (void *)w[W_VIEW];
  if (!ram(t)) return;
  info = *(const u8 *const *)(lv + 0x4ec);
  focus = ram(info) ? info[0x998] : 9u;
  if (!shown || !(focus <= 4u || focus == 14u || focus == 15u)) { c->set_visible(t, 0); return; }
  mm = *(const u32 *)(info + 0x6e8);
  if (mm != w[W_SHOWN]) { w[W_SHOWN] = mm; format(c->flags & 1u, mm, text); c->set_text(t, text); }
  layout = lv[0x2d4]; if (layout > 3u) layout = 0;
  if (w[W_LAYOUT] != layout + 1u) {
    s32 at[2];
    at[0] = c->positions[layout * 0x60u + SCALE_ITEM * 2u] + 2;
    at[1] = c->positions[layout * 0x60u + SCALE_ITEM * 2u + 1u] + 202;      // the scale is 200 high
    c->move(t, at);
    w[W_LAYOUT] = layout + 1u;
  }
  c->set_visible(t, 1);
}

u32 afdist(const struct ctx *c, u32 which, u32 a, u32 b) {
  if (c->magic != MAGIC) return 0;
  if (which == 0) create(c, (void **)a);
  else if (which == 1 || which == 2) update(c, (const u8 *)a, (u32 *)b, which - 1u);
  return 0;
}
