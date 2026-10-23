/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: power-off pictures chosen in the camera (Ricoh GR IV, firmware 1.11; built with
 * -DGRMOD_FW_120 for 1.20, the file of GR IV 1.20 and GR IV Monochrome 1.10, see below).
 *
 * The camera's "End Screen" line (Setup > Display) opens a submenu of two lines (see shutdown.ts):
 *   Type      the camera's own End Screen list (type 1 / type 2: whether the shooting statistics
 *             are shown), unchanged;
 *   Picture   the same list in picture mode (the camera has one object of it; shutdown.ts sets
 *             the mode when the list is opened from this line), showing 1 + n rows:
 *               row 0            factory picture (this camera's GoodBye / HDF / Monochrome / 20th);
 *               rows 1 .. n      the added pictures, by name.
 * The picture list has one tick; the footer graphic above it shows a 520x200 thumbnail of the
 * focused row. Picking one is remembered in a record of the camera's own settings store (APData)
 * and the power-off screen shows that picture. The list's handlers come here only in picture
 * mode; in its own mode the camera's code runs as before.
 *
 * The pictures are files of the firmware's RES section (A:\Resource\Jpeg\GRMOD<k>.jpg, 720x480),
 * reached through the camera's table of full-screen JPEGs, which GR Mod copies and extends (the
 * added pictures get numbers 12, 13, ...). The power-off picture request (0x531B9488) asks for
 * the chosen number, or runs as before for the factory picture.
 *
 * The record holds { magic, choice }: choice is the stable identity of an added picture (GR Mod
 * gives each picture one, so that reordering or renaming keeps the selection), 0 for the factory
 * picture. A record that is missing, of another size or magic, or names a picture that is no longer
 * in the list counts as 0. It is written when a row is confirmed and written again at every
 * settings save (power off), like the other records of the store.
 *
 * Same approach as the End Screen list of gr-custom-tool (Copyright (C) 2026 DoYitNow,
 * GPL-2.0-only), written anew for GR Mod's build: GR Mod's own record magic, files and catalog
 * numbers, menu layout, every entry taking its context from a stub.
 *
 * Position-independent: no global data; firmware functions are called at their fixed addresses,
 * everything else comes in through `struct sd_ctx` (built by shutdown.ts).
 *
 * Firmware 1.20 (GRMOD_FW_120): the same functions at other addresses (shutdown-fw120.h, written
 * by gen.py from core/src/fw/target120.ts), and the factory picture is chosen otherwise (see
 * factory_index). The power-off picture request of 1.20 draws the End Screen picture chosen at
 * power-off (factory, or one downloaded with GR WORLD); sd_background shows the picture of the
 * list instead when one is chosen, and leaves everything else to it.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define MAX_PICTURES 8u

struct sd_ctx {
  u32 magic;                 /* SD_CTX_MAGIC */
  u32 record;                /* APData record of the choice */
  u32 count;                 /* added pictures, 1..MAX_PICTURES */
  u32 factory_text;          /* text of row 0; the pictures' names follow it */
  u32 original_background;   /* the native picture request, continued past its first instruction */
  u32 prior_save;            /* the settings save this hook continues */
  u16 factory_icon[4];       /* thumbnails of the factory pictures 1, 2, 3, 11 (0: none) */
  u16 icon[MAX_PICTURES];    /* thumbnails of the added pictures */
  u32 choice[MAX_PICTURES];  /* stable identities */
  u32 resource[MAX_PICTURES];/* numbers in the extended JPEG table */
};

#define SD_CTX_MAGIC 0x31445347u  /* 'GSD1' */
#define REC_MAGIC 0x4f44534du     /* 'MSDO' */

typedef void *(*get0_fn)(void);
typedef void *(*get1_fn)(void *);
typedef u32 (*u32_1_fn)(void *);
typedef u32 (*u32_2_fn)(void *, u32);
typedef void *(*item_fn)(void *, u32);
typedef void (*set2_fn)(void *, u32);
typedef void (*move_fn)(void *, int, u32);

#ifdef GRMOD_FW_120
#include "shutdown-fw120.h"
#else
#define APP_GET          ((get0_fn)0x5323ea84u)
#define USERDATA_GET     ((get1_fn)0x5323f018u)
#define MODEL_GET        ((get1_fn)0x5323ff28u)
#define EDITION_GET      ((u32_1_fn)0x533e0324u)
#define VARIANT_ROOT     ((get0_fn)0x5372b620u)
#define DISPLAY_GET      ((get1_fn)0x5323ed78u)
#define JPEG_REQUEST     ((u32_2_fn)0x53262558u)
#define LIST_SELECTED    ((u32_1_fn)0x53570b6cu)
#define LIST_ITEM        ((item_fn)0x53570a9cu)
#define LIST_FOCUS       ((set2_fn)0x53571788u)
#define LIST_MOVE        ((move_fn)0x535715b8u)
#define ITEM_CHECK       ((set2_fn)0x5357ad40u)
#define ITEM_TEXT        ((set2_fn)0x5357ade0u)
#define SUB_LINE_TEXT    ((set2_fn)0x535831e8u)
#define GRAPHIC_ICON     ((set2_fn)0x53576e38u)
#define GRAPHIC_VISIBLE  ((set2_fn)0x53589ab4u)
#define STORAGE          ((get0_fn)0x53a81480u)
#define STORE_EXISTS     ((u32 (*)(void *, u32))0x53a7e2b8u)
#define STORE_SIZE       ((u32 (*)(void *, u32))0x53a7e208u)
#define STORE_READ       ((u32 (*)(void *, u32, u32, void *))0x53a7e434u)
#define STORE_WRITE      ((u32 (*)(void *, u32, u32, const void *))0x53a7e518u)
#endif

struct record { u32 magic, choice; };

static int ok(const struct sd_ctx *k) {
  return k && k->magic == SD_CTX_MAGIC && k->count >= 1 && k->count <= MAX_PICTURES;
}

static void *apdata(void) {
  u8 *s = (u8 *)STORAGE();
  return s ? *(void **)(s + 8) : 0;
}

/* Row of the added picture with this identity, or -1. */
static int row_of(const struct sd_ctx *k, u32 choice) {
  u32 i;
  if (!choice) return -1;
  for (i = 0; i < k->count; i++) if (k->choice[i] == choice) return (int)i;
  return -1;
}

/* The chosen picture: an identity of the list, or 0 (factory). */
u32 sd_get(const struct sd_ctx *k) {
  struct record r = { 0, 0 };
  void *ap = apdata();
  if (!ok(k) || !ap) return 0;
  if (!STORE_EXISTS(ap, k->record) || STORE_SIZE(ap, k->record) != sizeof r) return 0;
  if (!STORE_READ(ap, k->record, sizeof r, &r) || r.magic != REC_MAGIC) return 0;
  return row_of(k, r.choice) >= 0 ? r.choice : 0;
}

static u32 put(const struct sd_ctx *k, u32 choice) {
  struct record r;
  void *ap = apdata();
  if (!ap) return 0;
  r.magic = REC_MAGIC;
  r.choice = choice;
  return STORE_WRITE(ap, k->record, sizeof r, &r);
}

/* ---- the power-off picture ------------------------------------------------------------------ */

u32 sd_background(void *controller, const struct sd_ctx *k) {
  int row = ok(k) ? row_of(k, sd_get(k)) : -1;
  if (row >= 0) return JPEG_REQUEST(DISPLAY_GET(APP_GET()), k->resource[row]);
  return ((u32 (*)(void *))k->original_background)(controller);
}

/* Settings save (power off): the native save first, then the choice again. */
u32 sd_save(void *mode, const struct sd_ctx *k) {
  u32 result = ((u32 (*)(void *))k->prior_save)(mode);
  if (ok(k)) {
    u32 choice = sd_get(k);
    if (choice) put(k, choice);
  }
  return result;
}

/* ---- the menu ------------------------------------------------------------------------------- */

static void *list(void *controller) { return *(void **)((u8 *)controller + 0x168); }

static u32 rows(const struct sd_ctx *k) { return 1u + k->count; }

/* Row of the current choice: 0 factory, 1 + i the added picture i. */
static u32 chosen_row(const struct sd_ctx *k) {
  int picture = row_of(k, sd_get(k));
  return picture >= 0 ? 1u + (u32)picture : 0u;
}

#ifndef GRMOD_FW_120
/* The factory picture this camera shows (as 0x531B9488 chooses it), as an index of factory_icon. */
static u32 factory_index(void) {
  u8 *node = (u8 *)VARIANT_ROOT();
  u32 variant, edition;
  node = *(u8 **)(node + 8);
  node = *(u8 **)(node + 0xc);
  node = *(u8 **)(node + 0x20);
  variant = *(u32 *)(node + 0x48);
  if (variant == 5) return 3;        /* 11: 20th anniversary */
  if (variant != 0) return 0;        /*  1: GoodBye (the native function reports and uses 1) */
  edition = EDITION_GET(MODEL_GET(APP_GET()));
  return edition == 1 ? 2 : edition == 2 ? 1 : 0;   /* 3: Monochrome, 2: HDF, 1: GoodBye */
}
#else
/* The picture 1.20 shows without a choice of this list, as an index of factory_icon, 4 when it has
 * no thumbnail. 1.20 chooses it at power-off (0x5378F5C0) from its End Screen object (at +0x28 of
 * VARIANT_ROOT): byte 0x15, the choice made with GR WORLD, 0..4 a picture of its table (GoodBye,
 * HDF, Monochrome, 20th, 30th: the order of factory_icon), above 50 the downloaded picture
 * (B:\GB_DL.jpg); otherwise byte 0x14, the camera's own. The 30th's picture is not in the firmware. */
static u32 factory_index(void) {
  u8 *screen = *(u8 **)((u8 *)VARIANT_ROOT() + 0x28);
  u32 choice;
  if (!screen) return 4;
  choice = screen[0x15];
  if (choice > 50) return 4;
  if (choice > 4) choice = screen[0x14];
  return choice <= 3 ? choice : 4;
}
#endif

static void update(void *controller, const struct sd_ctx *k, int focus) {
  void *widget = list(controller);
  u32 chosen = chosen_row(k);
  u32 row;
  for (row = 0; row < rows(k); row++) {
    void *item = LIST_ITEM(widget, row);
    ITEM_CHECK(item, row == chosen);
    ITEM_TEXT(item, k->factory_text + row);
  }
  if (focus) LIST_FOCUS(widget, chosen);
}

/* The picture list: rows, ticks and texts, the cursor on the current choice (when it opens). */
void sd_refresh(void *controller, const struct sd_ctx *k) {
  if (ok(k)) update(controller, k, 1);
}

u32 sd_confirm(void *controller, const struct sd_ctx *k) {
  u32 row;
  if (!ok(k)) return 0;
  row = LIST_SELECTED(list(controller));
  if (row >= rows(k)) return 0;
  put(k, row == 0 ? 0 : k->choice[row - 1]);
  update(controller, k, 0);
  return 1;
}

/* Up / down (0x53223F14 / 0x53223F58): at the first / last row, `stop` (key repeat) keeps the
 * cursor there, a single press wraps around (LIST_MOVE does the wrapping). */
void sd_left(void *controller, u32 stop, const struct sd_ctx *k) {
  void *widget = list(controller);
  if (!LIST_SELECTED(widget) && stop) return;
  LIST_MOVE(widget, -1, 1);
  (void)k;
}

void sd_right(void *controller, u32 stop, const struct sd_ctx *k) {
  void *widget = list(controller);
  if (ok(k) && LIST_SELECTED(widget) >= rows(k) - 1 && stop) return;
  LIST_MOVE(widget, 1, 1);
}

void sd_footer(void *controller, const struct sd_ctx *k) {
  void *graphic = *(void **)((u8 *)controller + 0x164);
  u32 row = LIST_SELECTED(list(controller)), icon = 0;
#ifndef GRMOD_FW_120
  if (ok(k) && row == 0) icon = k->factory_icon[factory_index()];
#else
  if (ok(k) && row == 0) { u32 f = factory_index(); icon = f < 4 ? k->factory_icon[f] : 0; }
#endif
  else if (ok(k) && row < rows(k)) icon = k->icon[row - 1];
  if (icon) GRAPHIC_ICON(graphic, icon);
  GRAPHIC_VISIBLE(graphic, icon != 0);
}

/* The submenu's "Picture" line: the name of the current choice. */
void sd_line(void *submenu, void *line, const struct sd_ctx *k) {
  (void)submenu;
  if (ok(k)) SUB_LINE_TEXT(line, k->factory_text + chosen_row(k));
}
