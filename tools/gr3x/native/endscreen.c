// SPDX-License-Identifier: GPL-2.0-only
/* GR III 2.10 / GR IIIx 1.60, round 6: power-off pictures chosen in the camera, as on GR IV
 * (tools/shutdown/shutdown.c; the menu is GR IV's, the storage and the picture choice are GR III's).
 *
 * Setup > Display > End Screen opens a submenu (see core/src/fw/gr3x/endscreen.ts):
 *   Type      the camera's own End Screen list (Type1 / Type2), unchanged;
 *   Picture   the same list (GoodByeDisplaySetController, one object) in picture mode, 1 + n rows:
 *               row 0       "Original": the factory picture this camera shows;
 *               rows 1..n   the added pictures, by name;
 *             the 520 x 200 footer graphic shows a thumbnail of the focused row.
 * In picture mode the list's refresh, confirm, up / down and footer come here (stubs pass the
 * context); in its own mode the camera's code runs as before.
 *
 * The choice is the picture's stable identity (GR Mod gives each picture one, so reordering or
 * renaming keeps the selection), 0 for the factory picture, kept in four padding bytes of the
 * camera's settings record: 0x9a9..0x9ab (after SetupAutoPowerOff's flag 0x9a8) and 0x9a3 (round
 * 5's picture byte) as the top byte. Like the End Screen type (setter 0x53243a08) it is written to
 * all eight copies of the record (*(0x55063f34 + 4 i), the current settings and the user modes), so
 * recalling U1-U3 does not change it. An identity no longer in the list (or round 5's picture
 * number, < 9 << 24 | 0) counts as the factory picture.
 *
 * The power-off picture (GoodByeController::RequestBackgroundJpeg 0x5319f180): at 0x5319f208 r7 is
 * the number of the camera's own picture in the full-screen JPEG table (2 GoodBye, 3 Collabo, 10..12);
 * es_pick gives the number of the chosen added picture (13 + row, the copied and extended table) or
 * r7 as it was.
 *
 * Position independent: no global data; firmware functions at their fixed addresses, everything
 * else from `struct es_ctx` (endscreen.ts). Built by tools/gr3x/compile_slots.py endscreen.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define MAX_PICTURES 8u
#define FACTORY 5u
#ifdef STORE_RECORD
/* Round 10 (GR IV's shutdown.c): the choice is a record of the camera's settings store, { magic,
 * choice }, written when a row is confirmed and again after every settings save (power off), like
 * the store's other records. GR IV keeps it in APData; GR III's APData has twelve records, all in
 * use and fixed in number, so it is HTData record 13 (the films' table is 12). A missing record (the
 * first start of this firmware) takes the choice that rounds 6..9 kept in the padding bytes. */
#define ES_CTX_MAGIC 0x34455347u   /* 'GSE4' */
#define REC_MAGIC 0x4f44534du      /* 'MSDO', GR IV's */
#define STORAGE     ((void *(*)(void))0x53828014u)
#define STORE_WRITE ((u32 (*)(void *, u32, u32, const void *))0x53829a08u)
#define STORE_READ  ((u32 (*)(void *, u32, u32, void *))0x53829fccu)
#define STORE_SIZE  ((u32 (*)(void *, u32))0x53829e50u)
#else
#define ES_CTX_MAGIC 0x33455347u   /* 'GSE3' */
#endif

struct es_ctx {
  u32 magic;
  u32 count;                   /* added pictures, 1..MAX_PICTURES */
  u32 factory_text;            /* text of row 0 ("Original"); the pictures' names follow it */
  u16 factory_icon[FACTORY];   /* thumbnails of the factory pictures by camera variant 0..4 */
  u16 icon[MAX_PICTURES];      /* thumbnails of the added pictures */
  u16 pad;
  u32 choice[MAX_PICTURES];    /* stable identities */
  u32 resource[MAX_PICTURES];  /* numbers in the extended JPEG table */
#ifdef STORE_RECORD
  u32 record;                  /* HTData record of the choice */
  u32 prior_save;              /* the settings save this hook continues */
#endif
};

typedef void *(*get0_fn)(void);
typedef u32 (*u32_1_fn)(void *);
typedef void *(*item_fn)(void *, u32);
typedef void (*set2_fn)(void *, u32);
typedef void (*move_fn)(void *, int, u32);

#define VARIANT_ROOT     ((get0_fn)0x53525d5cu)
#define LIST_SELECTED    ((u32_1_fn)0x53394820u)
#define LIST_ITEM        ((item_fn)0x53394758u)
#define LIST_FOCUS       ((set2_fn)0x53395430u)
#define LIST_MOVE        ((move_fn)0x53395260u)
#define ITEM_CHECK       ((set2_fn)0x5339e738u)
#define ITEM_TEXT        ((set2_fn)0x5339e7a0u)
#define SUB_LINE_TEXT    ((set2_fn)0x533a6ad0u)
#define GRAPHIC_ICON     ((set2_fn)0x5339a9a0u)
#define GRAPHIC_VISIBLE  ((set2_fn)0x533ad3c0u)
/* The record pointers: the current settings, then the other seven copies. */
#define RECORDS ((u8 *volatile *)0x55063f34u)
#define COPIES 8u

static int ok(const struct es_ctx *k) {
  return k && k->magic == ES_CTX_MAGIC && k->count >= 1 && k->count <= MAX_PICTURES;
}

static int row_of(const struct es_ctx *k, u32 choice) {
  u32 i;
  if (!choice) return -1;
  for (i = 0; i < k->count; i++) if (k->choice[i] == choice) return (int)i;
  return -1;
}

static u32 padding(void) {
  const volatile u8 *r = RECORDS[0];
  if (!r) return 0;
  return (u32)r[0x9a9] | (u32)r[0x9aa] << 8 | (u32)r[0x9ab] << 16 | (u32)r[0x9a3] << 24;
}

#ifdef STORE_RECORD
struct record { u32 magic, choice; };

static void *htdata(void) {
  u8 *s = (u8 *)STORAGE();
  return s ? *(void **)(s + 0x14) : 0;
}

static u32 stored_of(const struct es_ctx *k) {
  struct record r = { 0, 0 };
  void *ht = htdata();
  if (!ht) return 0;
  if (STORE_SIZE(ht, k->record) != sizeof r) return padding();
  if (!STORE_READ(ht, k->record, sizeof r, &r) || r.magic != REC_MAGIC) return 0;
  return r.choice;
}
#define stored() stored_of(k)
#else
#define stored() padding()
#endif

/* The chosen picture: an identity of the list, or 0 (factory). */
u32 es_get(const struct es_ctx *k) {
  u32 choice;
  if (!ok(k)) return 0;
  choice = stored();
  return row_of(k, choice) >= 0 ? choice : 0;
}

#ifdef STORE_RECORD
static u32 put_record(const struct es_ctx *k, u32 choice) {
  struct record r;
  void *ht = htdata();
  if (!ht) return 0;
  r.magic = REC_MAGIC;
  r.choice = choice;
  return STORE_WRITE(ht, k->record, sizeof r, &r);
}
#define put(choice) put_record(k, choice)
#else
static void put(u32 choice) {
  u32 i;
  for (i = 0; i < COPIES; i++) {
    volatile u8 *r = RECORDS[i];
    if (!r) continue;
    r[0x9a9] = (u8)choice; r[0x9aa] = (u8)(choice >> 8); r[0x9ab] = (u8)(choice >> 16); r[0x9a3] = (u8)(choice >> 24);
  }
}
#endif

/* ---- the power-off picture ------------------------------------------------------------------ */

u32 es_pick(u32 number, const struct es_ctx *k) {
  int row = ok(k) ? row_of(k, es_get(k)) : -1;
  return row >= 0 ? k->resource[row] : number;
}

#ifdef STORE_RECORD
/* Settings save (power off): the native save first, then the choice again (GR IV's sd_save). */
u32 es_save(void *ud, const struct es_ctx *k) {
  u32 result = ((u32 (*)(void *))k->prior_save)(ud);
  if (ok(k)) {
    u32 choice = es_get(k);
    if (choice) put(choice);
  }
  return result;
}
#endif

/* ---- the menu ------------------------------------------------------------------------------- */

static void *list(void *controller) { return *(void **)((u8 *)controller + 0x168); }

static u32 rows(const struct es_ctx *k) { return 1u + k->count; }

static u32 chosen_row(const struct es_ctx *k) {
  int picture = row_of(k, es_get(k));
  return picture >= 0 ? 1u + (u32)picture : 0u;
}

/* The factory picture this camera shows (as 0x5319f180 chooses it): its variant 0..4, else 0. */
static u32 factory_index(void) {
  u8 *node = (u8 *)VARIANT_ROOT();
  u32 variant;
  if (!node) return 0;
  node = *(u8 **)(node + 4);
  node = *(u8 **)(node + 0xc);
  node = *(u8 **)(node + 0x1c);
  variant = *(u32 *)(node + 0x48);
  return variant < FACTORY ? variant : 0;
}

static void update(void *controller, const struct es_ctx *k, int focus) {
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

void es_refresh(void *controller, const struct es_ctx *k) {
  if (ok(k)) update(controller, k, 1);
}

/* OK on a row (the caller then closes the list, as for the camera's own rows). */
u32 es_confirm(void *controller, const struct es_ctx *k) {
  u32 row;
  if (!ok(k)) return 1;
  row = LIST_SELECTED(list(controller));
  if (row >= rows(k)) return 1;
  put(row == 0 ? 0 : k->choice[row - 1]);
  update(controller, k, 0);
  return 1;
}

/* Up / down: at the first / last row `stop` (key repeat) keeps the cursor there, a single press
 * wraps around (LIST_MOVE wraps). */
void es_up(void *controller, u32 stop, const struct es_ctx *k) {
  void *widget = list(controller);
  (void)k;
  if (!LIST_SELECTED(widget) && stop) return;
  LIST_MOVE(widget, -1, 1);
}

void es_down(void *controller, u32 stop, const struct es_ctx *k) {
  void *widget = list(controller);
  if (ok(k) && LIST_SELECTED(widget) >= rows(k) - 1 && stop) return;
  LIST_MOVE(widget, 1, 1);
}

void es_footer(void *controller, const struct es_ctx *k) {
  void *graphic = *(void **)((u8 *)controller + 0x164);
  u32 row = LIST_SELECTED(list(controller)), icon = 0;
  if (ok(k) && row == 0) icon = k->factory_icon[factory_index()];
  else if (ok(k) && row < rows(k)) icon = k->icon[row - 1];
  if (icon) GRAPHIC_ICON(graphic, icon);
  GRAPHIC_VISIBLE(graphic, icon != 0);
}

/* The submenu's "Picture" line: the name of the current choice. */
void es_line(void *submenu, void *line, const struct es_ctx *k) {
  (void)submenu;
  if (ok(k)) SUB_LINE_TEXT(line, k->factory_text + chosen_row(k));
}
