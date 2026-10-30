/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: power-off pictures chosen in the camera (Ricoh GR IV, firmware 1.20; ported from 1.11).
 *
 * The camera's "End Screen" line (Setup > Display) opens a submenu of two lines (see shutdown.ts):
 *   Type      the camera's own End Screen list (type 1 / type 2: whether the shooting statistics
 *             are shown), unchanged;
 *   Picture   the same list in picture mode (the camera has one object of it; shutdown.ts sets
 *             the mode when the list is opened from this line), showing 1 + n rows:
 *               row 0            the camera's own picture (1.20: the one of its power-off picture
 *                                setting, see factory_index);
 *               rows 1 .. n      the added pictures, by name.
 * The picture list has one tick; the footer graphic above it shows a 520x200 thumbnail of the
 * focused row. Picking one is remembered in a record of the camera's own settings store (APData)
 * and the power-off screen shows that picture. The list's handlers come here only in picture
 * mode; in its own mode the camera's code runs as before.
 *
 * The pictures are files of the firmware's RES section (A:\Resource\Jpeg\GRMOD<k>.jpg, 720x480),
 * reached through the camera's table of full-screen JPEGs, which GR Mod copies and extends (the
 * added pictures get numbers 13, 14, ...; 1.20 has 13 of its own). The power-off picture request
 * (0x531BAA50) asks for the chosen number (0x53264274), or runs as before for the camera's own.
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

#define APP_GET          ((get0_fn)0x532406a4u)
#define USERDATA_GET     ((get1_fn)0x53240c38u)
#define SETTING_ROOT     ((get0_fn)0x53750008u)   /* +0x28: the power-off picture setting (1.20) */
#define DISPLAY_GET      ((get1_fn)0x53240998u)
#define JPEG_REQUEST     ((u32_2_fn)0x53264274u)
#define LIST_SELECTED    ((u32_1_fn)0x53593e34u)
#define LIST_ITEM        ((item_fn)0x53593d64u)
#define LIST_FOCUS       ((set2_fn)0x53594a50u)
#define LIST_MOVE        ((move_fn)0x53594880u)
#define ITEM_CHECK       ((set2_fn)0x5359e00cu)
#define ITEM_TEXT        ((set2_fn)0x5359e0acu)
#define SUB_LINE_TEXT    ((set2_fn)0x535a64b4u)
#define GRAPHIC_ICON     ((set2_fn)0x5359a104u)
#define GRAPHIC_VISIBLE  ((set2_fn)0x535acd84u)
#define STORAGE          ((get0_fn)0x53aa958cu)
#define STORE_EXISTS     ((u32 (*)(void *, u32))0x53aa65d4u)
#define STORE_SIZE       ((u32 (*)(void *, u32))0x53aa6524u)
#define STORE_READ       ((u32 (*)(void *, u32, u32, void *))0x53aa6680u)
#define STORE_WRITE      ((u32 (*)(void *, u32, u32, const void *))0x53aa6764u)

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

static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u;
}

/* The picture the camera shows itself, as an index of factory_icon, or -1 (none of the four).
 * 1.20 keeps it in its power-off picture setting (0x53750008() + 0x28, APData record 7): byte
 * 0x15 the choice (0..4 a picture of the table 0x53FC5600: GoodBye, GB_HDF, GB_Mono, GB_20th on
 * A:, GB_30th on B:; above 50 a downloaded B:\GB_DL.jpg), byte 0x14 what it falls back to when
 * that file is missing (0x5378F5C0). factory_icon has the four A: pictures in the table's order;
 * GB_30th and a downloaded picture have no thumbnail here. */
static int factory_index(void) {
  u8 *root = (u8 *)SETTING_ROOT(), *s;
  u32 choice, fallback;
  if (!ram(root)) return -1;
  s = *(u8 **)(root + 0x28);
  if (!ram(s)) return -1;
  choice = s[0x15];
  fallback = s[0x14];
  if (choice <= 3) return (int)choice;
  if (choice == 4 || choice > 50) return -1;
  return fallback <= 3 ? (int)fallback : -1;
}

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

/* Up / down (0x532259C4 / 0x53225A08): at the first / last row, `stop` (key repeat) keeps the
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
  if (ok(k) && row == 0) {
    int f = factory_index();
    icon = f >= 0 ? k->factory_icon[f] : 0;
  }
  else if (ok(k) && row < rows(k)) icon = k->icon[row - 1];
  if (icon) GRAPHIC_ICON(graphic, icon);
  GRAPHIC_VISIBLE(graphic, icon != 0);
}

/* The submenu's "Picture" line: the name of the current choice. */
void sd_line(void *submenu, void *line, const struct sd_ctx *k) {
  (void)submenu;
  if (ok(k)) SUB_LINE_TEXT(line, k->factory_text + chosen_row(k));
}
