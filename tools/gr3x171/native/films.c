// SPDX-License-Identifier: GPL-2.0-only
/* GR III 2.10 / GR IIIx 1.60, round 10: own adjustment parameters of the films (looks 64, ...),
 * GR IV's way (tools/slotparams/slot_params.c, GR Mod 0.8.4).
 *
 * The films are looks of their own (image-control.ts, round 10) that borrow the parameters of
 * Bleach Bypass (18): the parameters it has are Standard's nine and a Toning byte, in every photo
 * and movie set, and the films keep their Halation setting in that byte (GR IV: Cinema Yellow's
 * Toning; halation-rows.ts shows it as two rows). Everything that reads parameters for the
 * selected look (the setters, the active checks behind the live values, the full sync) takes a film
 * as Bleach Bypass. So for each photo / movie set (6 combinations) Bleach Bypass's fields belong to
 * one "owner": the film selected in that set, or else Bleach Bypass; the other owners' values wait
 * in a table here, saved as its own record of the settings store (HTData 12):
 *   - when a set's look changes owner, the old owner's values move from the fields to the table and
 *     the new owner's come back. GR III's setters of a set's look write the look and then push the
 *     whole record to the live values (0x53277880), so the values are swapped just before they run
 *     (GR IV swaps after, through its setters, which also push);
 *   - the movie sets' fields (and looks) are the same in all eight records (the camera's movie
 *     setters write all of them): a movie swap writes all eight.
 * The fields are always the selected look's values, in the record the camera saves, so the record
 * and the table cannot disagree about the look in use.
 *
 * As on GR IV: a fingerprint of each film's preset is kept with the table (a film whose preset
 * changed starts again from neutral, in the table, in the record in use and in the stored records,
 * modes and U1..U3, whose set has it selected); films beyond the build's count keep their values;
 * a set left on a film this build does not have, or on a hidden film in the standard photo or movie
 * set, gets its fields back for Bleach Bypass (the settings guard gives it Standard after the load);
 * before a mode recall copies a stored record into use, the owners' values go to the table.
 * In-camera RAW development (sp_raw_*): per base (the three photo sets) and look the RAW development
 * model keeps 17 bytes; the films use Bleach Bypass's row (RAW look 9) and, as there, the row
 * belongs to one owner per base.
 *
 * Taken over from rounds 6..9 (tools/gr3x171/native/slots*.c, the same HTData record with another
 * magic): there the films used Standard's fields. Their table's values become the films' (Toning
 * from their Halation: strength 0..3 and white, as GR IV's states), and in the record in use and
 * the stored records a photo set on a film gets Standard's own values back in Standard's fields and
 * the film's values in Bleach Bypass's.
 *
 * Linked by the generator (gen_films.py) with GR IV's relocation scheme (aspect/native-link.ts).
 */
#include <stdint.h>

#ifndef SLOT_COUNT
#error SLOT_COUNT (1..20) is set by gen_films.py
#endif
#define BLEACH 18u
#define STANDARD 11u
#define FIRST 64u
#define MAXFILMS 20u
#define OWNERS (MAXFILMS + 1u)        /* Bleach Bypass and up to twenty films */
#define COMBOS 6u                     /* photo sets 0..2, movie sets 0..2 */
#define NP 10u
#define TONING 7u                     /* parameter position of the Toning byte */
#define RECORDS 8u                    /* the record in use (ud + 4) and the seven stored (ud + 8 ..) */
#define REC_ID 12u
#define REC_MAGIC 0x41335247u         /* 'GR3A' */
#define REC_VERSION 10u
#define STATE_MAGIC 0x41534c54u
#define TBYTES (OWNERS * COMBOS * NP)
#define REC_WORDS (3u + OWNERS + (TBYTES + 3u) / 4u + 1u)

/* Rounds 6..9 (slots.c / slots2.c / slots3.c): Standard's nine fields per photo set. */
#define OLD_MAGIC 0x33505247u         /* 'GRP3' */
#define OLD_NP 9u
#define OLD_SETS 3u
#define OLD_TBYTES (OWNERS * OLD_SETS * OLD_NP)       /* 567 */
#define OLD_HBYTES (MAXFILMS * OLD_SETS)              /* 60 */
#define OLD_ABYTES (OLD_TBYTES + OLD_HBYTES)
#define OLD_AWORDS ((OLD_ABYTES + 3u) / 4u)
#define OLD_V3_WORDS (3u + MAXFILMS + OLD_AWORDS + 1u)   /* 181 */
#define OLD_V2_WORDS (3u + OLD_AWORDS + 1u)              /* 161 */
#define OLD_V1_OWNERS 10u
#define OLD_V1_TBYTES (OLD_V1_OWNERS * OLD_SETS * OLD_NP)
#define OLD_V1_WORDS (3u + (OLD_V1_TBYTES + 3u) / 4u + 1u) /* 72 */

#ifdef WB_PER_LOOK
/* White balance per look (built with -DWB_PER_LOOK: gen_films.py writes films-wb-native.ts; as GR
 * IV's wbPerLook, tools/gr4v120/slotparams/slot_params.c): each look remembers the still white
 * balance it was last used with and gets it back when it is chosen again (a look change in the
 * photo set in use, or another photo set chosen). The 28 fields of UserData's record, each a value
 * byte followed by a byte that the record's copy routine treats as its flag: StillWhiteBalance
 * 0x178, the G-M shift of the 13 modes from 0x17a, their B-A shift from 0x194,
 * StillWhiteBalanceColorTemp 0x1ae (a half-word); field k is at 0x178 + 2k. They are given back
 * through the camera's own setters (those its settings text interface calls: the value stored, then
 * the listeners told; bound by films-r10.ts, the G-M and B-A ones 0x20 apart), the mode last. The
 * custom WB capture and movie WB are not touched. Saved as a record of its own, HTData 14 (the
 * films' table is 12, the End Screen's 13; the camera uses 0 and 2..8; 0..15 are valid), so that a
 * build without the option reads record 12 as before. See docs/technical-notes.md. */
/* The photo sets Custom 1 and 2 have a white balance of their own, whatever their look: the rows
 * after the looks' (version 2; version 1 had the looks' rows only and is taken over). */
#define WB_N 28u
#define WB_BYTES 29u                       /* mode, 13 G-M, 13 B-A, colour temperature (2) */
#define WB_LOOKS 52u                       /* looks 0..31, then films 64..83 */
#define WB_ROWS (WB_LOOKS + 2u)            /* then Custom 1, Custom 2 */
#define WB_REC_ID 14u
#define WB_MAGIC 0x33575247u               /* 'GRW3' */
#define WB_VERSION 2u
#define WB_DATA (WB_ROWS + WB_ROWS * WB_BYTES)          /* 1620: have, values */
#define WB_REC_WORDS (3u + (WB_DATA + 3u) / 4u + 1u)    /* 409 */
#define WB_V1_DATA (WB_LOOKS + WB_LOOKS * WB_BYTES)     /* 1560 */
#define WB_V1_WORDS (3u + (WB_V1_DATA + 3u) / 4u + 1u)  /* 394 */
#define ACTIVE_SET 0x1c0u                  /* StillActiveImageControlSet: the photo set in use */
#endif

#ifdef LIVE_LAYOUT
/* The Image Control lists' order and hidden looks kept in the camera (core/src/fw/gr3x171/look-layout.ts,
 * custom-position.ts, films-r10.ts's RAW development list ask ll_query through the RAM word ll_word,
 * set when the settings are loaded; before that, or with no answer, they use the build's tables).
 * The entries in menu order: a look (11..22, films 64..), Custom 1 (LL_C1) or Custom 2 (LL_C2), bit 7
 * set when hidden. The build's layout (ll_default: count, entries) is the start; the camera's is HTData
 * record 15, used when it holds exactly the build's entries (another set of films: the build's). */
#define LL_MAX 40u
#define LL_C1 0x7eu
#define LL_C2 0x7fu
#define LL_HIDDEN 0x80u
#define LL_NONE 0xffffffffu                /* no answer: the build's tables */
#define LL_NATIVE 0xfffffffeu              /* past the list: the camera's own code */
#define LL_REC_ID 15u
#define LL_MAGIC 0x4c335247u               /* 'GR3L' */
#define LL_VERSION 1u
#define LL_REC_WORDS (3u + LL_MAX / 4u + 1u)  /* magic, version, count, entries, checksum */
#endif

extern uint8_t *storage_singleton(void);
extern uint32_t store_write(void *store, uint32_t id, uint32_t size, const void *data);
extern uint32_t store_read(void *store, uint32_t id, uint32_t size, void *data);
extern uint32_t store_size(void *store, uint32_t id);
extern void *heap_alloc(uint32_t size);
extern uint32_t prior_native_save(uint8_t *ud);
extern uint32_t prior_native_load(uint8_t *ud);
extern volatile uint32_t sp_gap[];      /* zeroed at every start; [0] = state */
extern uint8_t settings_object[];       /* UserDataModel (0x55064200): the record in use at +4, the stored ones after it */
/* The fingerprint of each film's preset in this build; after them one word, bit k set when film k
 * is hidden from the Image Control lists. */
extern const uint32_t slot_prints[];
#ifdef LIVE_LAYOUT
extern const uint8_t ll_default[];      /* the build's layout: count, then the entries */
extern volatile uint32_t ll_word[];     /* [0]: ll_query once the settings are loaded (zeroed at every start) */
/* The camera's menu screen of the lists' order (look-menu.ts): the End Screen list (GoodByeDisplaySetController)
 * in a mode of its own; its handlers come here with the controller. The camera's functions it calls and the
 * screen's title, from the build (look-menu.ts LM_FUNCTIONS, in this order). */
extern const uint32_t lm_ctx[];
enum { LM_SELECTED, LM_ITEM, LM_FOCUS, LM_MOVE, LM_CHECK, LM_TEXT, LM_VISIBLE, LM_SHOWN, LM_TITLE_SET, LM_APP, LM_UI_MODEL, LM_NAME,
       LM_TITLE, LM_SEPARATOR, LM_MOVING, LM_WORDS };
#endif
#ifdef WB_PER_LOOK
/* The camera's white balance setters (UserDataModel*, value): StillWhiteBalance, the first G-M and
 * B-A ones (the others follow 0x20 apart), StillWhiteBalanceColorTemp. */
extern uint8_t wb_mode_set[], wb_gm_set[], wb_ba_set[], wb_temp_set[];
#endif

/* Bleach Bypass's fields in a record, per parameter and combination (0 = none: no Clarity in movies). */
static const uint16_t FIELD[NP][COMBOS] = {
    {0x1ce, 0x2b0, 0x392, 0x58a, 0x63c, 0x6ee},   /* saturation */
    {0x1da, 0x2bc, 0x39e, 0x594, 0x646, 0x6f8},   /* hue */
    {0x1ee, 0x2d0, 0x3b2, 0x5a4, 0x656, 0x708},   /* high / low key */
    {0x200, 0x2e2, 0x3c4, 0x5b4, 0x666, 0x718},   /* contrast */
    {0x212, 0x2f4, 0x3d6, 0x5c4, 0x676, 0x728},   /* contrast (highlight) */
    {0x224, 0x306, 0x3e8, 0x5d4, 0x686, 0x738},   /* contrast (shadow) */
    {0x236, 0x318, 0x3fa, 0x5e4, 0x696, 0x748},   /* sharpness */
    {0x242, 0x324, 0x406, 0x5ee, 0x6a0, 0x752},   /* toning (a film: its Halation) */
    {0x286, 0x368, 0x44a, 0x62e, 0x6e0, 0x792},   /* shading */
    {0x296, 0x378, 0x45a, 0, 0, 0},               /* clarity */
};
/* Standard's fields of the photo sets (rounds 6..9 kept the films' values there). */
static const uint16_t STD_FIELD[OLD_NP][OLD_SETS] = {
    {0x1c8, 0x2aa, 0x38c}, {0x1d4, 0x2b6, 0x398}, {0x1e0, 0x2c2, 0x3a4}, {0x1f2, 0x2d4, 0x3b6}, {0x204, 0x2e6, 0x3c8},
    {0x216, 0x2f8, 0x3da}, {0x228, 0x30a, 0x3ec}, {0x278, 0x35a, 0x43c}, {0x28a, 0x36c, 0x44e},
};
/* The old parameter j as the new one: the nine without Toning. */
static const uint8_t OLD_TO_NEW[OLD_NP] = {0, 1, 2, 3, 4, 5, 6, 8, 9};

/* Neutral values ("0" on the parameter screen) the films start from and show as their default:
 * the middle of the -4..+4 scales; the Toning byte 0, Halation off (GR IV's state 0). */
static const uint8_t NEUTRAL[NP] = {4, 4, 4, 4, 4, 4, 4, 0, 4, 4};

/* Bleach Bypass's Toning field setters of the photo sets (UserDataModel*, value): the field, then
 * through the active check to the live value. */
static const uint32_t TONING_SETTER[3] = {0x5325fb54, 0x53262094, 0x53264634};

/* RAW development (RawDevelopmentModel): per base (0..2, the photo sets) and look 17 bytes; the
 * films use Bleach Bypass's (RAW look 9). */
#define RAW_BASES 3u
#define RAW_BLEACH 9u
#define RAW_FIRST 13u
#define RAW_LOOK 0x83u            /* + base: the base's look */
#define RAW_ROWS 0x86u            /* + base * 0xdd + look * 0x11 */
#define RAW_BASE_STRIDE 0xddu
#define RAW_ROW 0x11u
static const uint8_t RAW_POS[NP] = {0, 1, 2, 3, 4, 5, 6, 8, 13, 14};

typedef struct {
    uint8_t *model;
    uint8_t own[RAW_BASES];
    uint8_t v[RAW_BASES][OWNERS][RAW_ROW];
} Raw;

typedef struct {
    uint32_t magic, loaded, dirty, last_write;
    uint8_t t[OWNERS][COMBOS][NP];
    uint8_t pad[(TBYTES + 3u) / 4u * 4u - TBYTES];
    uint32_t fp[OWNERS];
    uint32_t rec[OLD_V3_WORDS > REC_WORDS ? OLD_V3_WORDS : REC_WORDS];
    Raw raw;
    uint8_t ot[OWNERS][OLD_SETS][OLD_NP];   /* rounds 6..9's table, when taken over */
    uint8_t oh[MAXFILMS][OLD_SETS];
#ifdef WB_PER_LOOK
    uint32_t wb_dirty, wb_pending, wb_last_write;
    uint32_t wb_rec[WB_REC_WORDS];          /* record 14 as stored: header, have, values, checksum */
#endif
#ifdef LIVE_LAYOUT
    uint32_t ll_dirty, ll_last_write;
    uint32_t lm_grab;                       /* the menu screen: 1 + the row being moved, 0 none */
    uint32_t ll_rec[LL_REC_WORDS];          /* record 15 as stored: header, entries, checksum */
#endif
} State;

static State *state(void) {
    State *s = (State *)sp_gap[0];
    return s && s->magic == STATE_MAGIC ? s : 0;
}

static void *ht_store(void) {
    uint8_t *s = storage_singleton();
    return s ? *(void **)(s + 0x14) : 0;
}

static uint8_t *record_of(uint8_t *ud, uint32_t i) {   /* 0: in use, 1..7: stored */
    return ud ? *(uint8_t **)(ud + 4u + 4u * i) : 0;
}

static uint32_t look_at(const uint8_t *rec, uint32_t c) {
    return rec[c < 3u ? 0x1c2u + 2u * c : 0x57eu + 2u * (c - 3u)];
}

/* Owner index of a look: Bleach Bypass 0, film k (below the build's count) k + 1, anything else -1. */
static int owner_of(uint32_t look) {
    if (look == BLEACH) return 0;
    if (look >= FIRST && look < FIRST + SLOT_COUNT) return (int)(look - FIRST + 1u);
    return -1;
}

static int owner(const uint8_t *rec, uint32_t c) {
    int o = owner_of(look_at(rec, c));
    return o < 0 ? 0 : o;
}

/* Not inlined: the generator pairs each symbol's movw with the movt that follows it. */
__attribute__((noinline)) static uint32_t print_of(uint32_t o) { return slot_prints[o - 1u]; }
__attribute__((noinline)) static uint32_t hidden_films(void) { return slot_prints[SLOT_COUNT]; }

/* Owner of a set's look that the settings guard turns into Standard after this load, else 0: a
 * film this build does not have (any set), or a hidden film in the standard photo or movie set. */
static uint32_t away_owner(uint32_t look, uint32_t c) {
    if (look >= FIRST + SLOT_COUNT && look < FIRST + MAXFILMS) return look - FIRST + 1u;
    if ((c == 0u || c == 3u) && look >= FIRST && look < FIRST + SLOT_COUNT && (hidden_films() >> (look - FIRST)) & 1u)
        return look - FIRST + 1u;
    return 0;
}

/* Write a field of combination c: one record for a photo set, all eight for a movie set. */
static void put_field(uint8_t *ud, uint32_t c, uint32_t f, uint8_t v) {
    for (uint32_t i = 0; i < (c < 3u ? 1u : RECORDS); i++) {
        volatile uint8_t *r = record_of(ud, i);
        if (r) r[f] = v;
    }
}

static void move_owner(State *s, uint8_t *ud, uint32_t c, int from, int to) {
    uint8_t *rec = record_of(ud, 0);
    for (uint32_t j = 0; j < NP; j++) if (FIELD[j][c]) s->t[from][c][j] = ((volatile uint8_t *)rec)[FIELD[j][c]];
    for (uint32_t j = 0; j < NP; j++) if (FIELD[j][c]) put_field(ud, c, FIELD[j][c], s->t[to][c][j]);
    s->dirty = 1;
}

#ifdef LIVE_LAYOUT
/* ---- the lists' order and hidden looks ------------------------------------------------------ */
static volatile uint8_t *ll_entries(State *s) { return (volatile uint8_t *)&s->ll_rec[3]; }

/* The entries in use: the camera's (record 15) once loaded, else the build's. */
static const volatile uint8_t *ll_now(uint32_t *n) {
    State *s = state();
    if (s && s->loaded && s->ll_rec[2] == ll_default[0]) { *n = s->ll_rec[2]; return ll_entries(s); }
    *n = ll_default[0] <= LL_MAX ? ll_default[0] : 0u;
    return &ll_default[1];
}

/* Is look x in list `kind`: 0 still (Image Control, ADJ: every look), 1 movie (the camera's ten, the
 * films), 2 RAW development's model (the camera's twelve), 3 the RAW development list (every look). */
static int ll_in(uint32_t x, uint32_t kind) {
    if (x == LL_C1 || x == LL_C2) return 0;
    if (kind == 0u || kind == 3u) return 1;
    if (kind == 1u) return x >= FIRST || (x >= 11u && x <= 22u && x != 14u && x != 20u);
    if (kind == 2u) return x >= 11u && x <= 22u;
    return 0;
}

static uint32_t ll_count(const volatile uint8_t *e, uint32_t n, uint32_t kind) {
    uint32_t c = 0;
    for (uint32_t i = 0; i < n; i++) if (!(e[i] & LL_HIDDEN) && ll_in(e[i], kind)) c++;
    return c;
}

/* What the lists ask (look-layout.ts, custom-position.ts, films-r10.ts):
 *   op 0  the length of list a;
 *   op 1  entry b of list a (LL_NATIVE past its end);
 *   op 2  the entry of look b in list a (its length when the list does not have it, as the camera's);
 *   op 3  the still lists with the two Custom entries: shown entry a as the camera's entry (looks
 *         0..n-1, Custom 1 n, Custom 2 n + 1), or with b = 1 the other way. */
uint32_t ll_query(uint32_t op, uint32_t a, uint32_t b) {
    uint32_t n, k = 0, pos = 0;
    const volatile uint8_t *e = ll_now(&n);
    if (!n) return LL_NONE;
    if (op == 0u) return a <= 3u ? ll_count(e, n, a) : LL_NONE;
    if (op == 1u) {
        if (a > 3u) return LL_NONE;
        for (uint32_t i = 0; i < n; i++) {
            if ((e[i] & LL_HIDDEN) || !ll_in(e[i], a)) continue;
            if (k++ == b) return e[i];
        }
        return LL_NATIVE;
    }
    if (op == 2u) {
        if (a > 3u) return LL_NONE;
        for (uint32_t i = 0; i < n; i++) {
            if ((e[i] & LL_HIDDEN) || !ll_in(e[i], a)) continue;
            if (e[i] == b) return k;
            k++;
        }
        return k;
    }
    if (op == 3u) {
        uint32_t looks = ll_count(e, n, 0u);
        for (uint32_t i = 0; i < n; i++) {
            uint32_t x = e[i];
            if (x & LL_HIDDEN) continue;
            uint32_t phys = x == LL_C1 ? looks : x == LL_C2 ? looks + 1u : k;
            if (b == 0u && pos == a) return phys;
            if (b != 0u && phys == a) return pos;
            if (x != LL_C1 && x != LL_C2) k++;
            pos++;
        }
        return a;
    }
    return LL_NONE;
}

static uint32_t checksum(const uint32_t *w, uint32_t n);

/* Record 15, if it holds exactly the build's entries (each once, Standard and the Custom entries shown). */
static void ll_read(State *s) {
    void *st = ht_store();
    uint32_t *r = s->ll_rec, n = ll_default[0];
    int ok = n >= 3u && n <= LL_MAX && st && store_size(st, LL_REC_ID) == LL_REC_WORDS * 4u &&
             store_read(st, LL_REC_ID, LL_REC_WORDS * 4u, r) && r[0] == LL_MAGIC && r[1] == LL_VERSION && r[2] == n &&
             r[LL_REC_WORDS - 1u] == checksum(r, LL_REC_WORDS - 1u);
    const volatile uint8_t *e = ll_entries(s);
    for (uint32_t i = 0; ok && i < n; i++) {
        uint32_t x = e[i] & ~LL_HIDDEN, found = 0;
        if ((e[i] & LL_HIDDEN) && (x == STANDARD || x == LL_C1 || x == LL_C2)) ok = 0;
        for (uint32_t j = 0; j < n; j++) if ((ll_default[1u + j] & ~LL_HIDDEN) == x) found++;
        for (uint32_t j = 0; j < i; j++) if ((e[j] & ~LL_HIDDEN) == x) found = 0;
        if (found != 1u) ok = 0;
    }
    if (!ok) {
        /* The build's. */
        for (uint32_t i = 0; i < LL_REC_WORDS; i++) ((volatile uint32_t *)r)[i] = 0;
        if (n > LL_MAX) n = 0;
        r[0] = LL_MAGIC; r[1] = LL_VERSION; r[2] = n;
        for (uint32_t i = 0; i < n; i++) ll_entries(s)[i] = ll_default[1u + i];
        s->ll_dirty = 0;
    }
}

/* ---- the menu screen (look-menu.ts) ---------------------------------------------------------- */
/* Its rows: the shown entries in order, a separator row ("Hidden"), then the hidden entries. OK takes the row
 * under the cursor (the title says so, the row is ticked); up / down then move it, across the separator it is
 * hidden or shown again (not Standard, the Custom entries or a look selected in a set: they stay above); OK
 * puts it down. Without a row taken up / down move the cursor. The list is made taller in this mode (six rows
 * instead of the End Screen list's two, whose picture is not shown); lm_camera gives the End Screen its own. */
#define LM_SEP 0xffu
typedef uint32_t (*lm1_fn)(void *);
typedef void *(*lm_item_fn)(void *, uint32_t);
typedef void (*lm2_fn)(void *, uint32_t);
typedef void (*lm_move_fn)(void *, int, uint32_t);
typedef void *(*lm0_fn)(void);
typedef uint32_t (*lm_name_fn)(void *, uint32_t);
typedef void *(*lm0p_fn)(void *);
typedef void (*lm_rect_fn)(void *, const int32_t *);

static void *lm_list(void *controller) { return *(void **)((uint8_t *)controller + 0x168); }

/* The entries the screen edits: the camera's (loaded), else none. */
static volatile uint8_t *lm_entries(State **ps, uint32_t *n) {
    State *s = state();
    *ps = s;
    if (!s || !s->loaded || s->ll_rec[2] != ll_default[0] || !ll_default[0] || ll_default[0] > LL_MAX) { *n = 0; return 0; }
    *n = s->ll_rec[2];
    return ll_entries(s);
}

/* The rows (entries' values, LM_SEP the separator): n + 1 of them. */
static void lm_rows(const volatile uint8_t *e, uint32_t n, uint8_t *rows) {
    uint32_t k = 0;
    for (uint32_t i = 0; i < n; i++) if (!(e[i] & LL_HIDDEN)) rows[k++] = e[i];
    rows[k++] = LM_SEP;
    for (uint32_t i = 0; i < n; i++) if (e[i] & LL_HIDDEN) rows[k++] = e[i];
}

/* The entries from the rows: above the separator shown, below it hidden. */
static void lm_store(State *s, volatile uint8_t *e, uint32_t n, const uint8_t *rows) {
    uint32_t k = 0, hidden = 0;
    for (uint32_t r = 0; r <= n; r++) {
        if (rows[r] == LM_SEP) { hidden = 1; continue; }
        e[k++] = (uint8_t)((rows[r] & ~LL_HIDDEN) | (hidden ? LL_HIDDEN : 0u));
    }
    s->ll_dirty = 1;
}

static uint32_t lm_text(uint32_t x) {
    if (x == LM_SEP) return lm_ctx[LM_SEPARATOR];
    void *ui = ((lm0p_fn)lm_ctx[LM_UI_MODEL])(((lm0_fn)lm_ctx[LM_APP])());
    x &= ~LL_HIDDEN;
    return ((lm_name_fn)lm_ctx[LM_NAME])(ui, x == LL_C1 ? 0x17u : x == LL_C2 ? 0x18u : x);
}

static void lm_row(void *list, const uint8_t *rows, uint32_t r, uint32_t grab) {
    void *item = ((lm_item_fn)lm_ctx[LM_ITEM])(list, r);
    ((lm2_fn)lm_ctx[LM_CHECK])(item, grab == r + 1u);
    ((lm2_fn)lm_ctx[LM_TEXT])(item, lm_text(rows[r]));
}

static void lm_title(void *controller, uint32_t moving) {
    ((lm2_fn)lm_ctx[LM_TITLE_SET])(*(void **)((uint8_t *)controller + 0x15c), lm_ctx[moving ? LM_MOVING : LM_TITLE]);
}

/* The list's place (ScrollListView's SetRect, its vtable + 0x18): x, y, width, height. */
static void lm_rect(void *list, int32_t y, int32_t h) {
    int32_t rect[4] = { 0, y, 720, h };
    ((lm_rect_fn)(*(uint32_t **)list)[6])(list, rect);
}

/* The End Screen list in the camera's own mode: its place again (under its picture, two rows). */
void lm_camera(void *controller) { lm_rect(lm_list(controller), 300, 120); }

/* The list opens: taller, its rows, the title, no footer picture, the cursor on the first, nothing taken. */
void lm_refresh(void *controller) {
    State *s; uint32_t n;
    uint8_t rows[LL_MAX + 1u];
    volatile uint8_t *e = lm_entries(&s, &n);
    void *list = lm_list(controller);
    lm_rect(list, 60, 360);
    ((lm2_fn)lm_ctx[LM_SHOWN])(list, n ? n + 1u : 0u);
    lm_title(controller, 0);
    ((lm2_fn)lm_ctx[LM_VISIBLE])(*(void **)((uint8_t *)controller + 0x164), 0);
    if (!n) return;
    s->lm_grab = 0;
    lm_rows(e, n, rows);
    for (uint32_t r = 0; r <= n; r++) lm_row(list, rows, r, 0);
    ((lm2_fn)lm_ctx[LM_FOCUS])(list, 0);
}

void lm_footer(void *controller) {
    ((lm2_fn)lm_ctx[LM_VISIBLE])(*(void **)((uint8_t *)controller + 0x164), 0);
}

/* Is look x selected in a photo or movie set of the record in use or a stored one (modes, U1..U3)? */
static int lm_in_use(uint32_t x) {
    for (uint32_t r = 0; r < RECORDS; r++) {
        const uint8_t *rec = record_of(settings_object, r);
        if (!rec) continue;
        for (uint32_t c = 0; c < COMBOS; c++) if (look_at(rec, c) == x) return 1;
    }
    return 0;
}

/* The row taken moves by one (`by` -1 / +1); across the separator its entry is hidden / shown. */
static void lm_carry(State *s, volatile uint8_t *e, uint32_t n, void *list, int by) {
    uint8_t rows[LL_MAX + 1u];
    uint32_t r = s->lm_grab - 1u, j = r + (uint32_t)by;
    if (r > n || j > n) return;
    lm_rows(e, n, rows);
    uint8_t x = rows[r];
    if (x == LM_SEP) return;
    if (rows[j] == LM_SEP && by > 0) {
        uint32_t look = x & ~LL_HIDDEN;
        if (look == STANDARD || look == LL_C1 || look == LL_C2 || lm_in_use(look)) return;
    }
    rows[r] = rows[j]; rows[j] = x;
    lm_store(s, e, n, rows);
    lm_rows(e, n, rows);
    s->lm_grab = j + 1u;
    lm_row(list, rows, r, s->lm_grab); lm_row(list, rows, j, s->lm_grab);
    /* The cursor follows by one row, as a key press moves it (setting it at j would scroll the list: the
     * camera's "focus" goes to the last row, then back). */
    ((lm_move_fn)lm_ctx[LM_MOVE])(list, by, 1);
}

/* Up / down: the row taken, or the cursor (as the End Screen list's: a single press wraps, the key
 * repeat `stop`s at the ends). */
void lm_up(void *controller, uint32_t stop) {
    State *s; uint32_t n;
    volatile uint8_t *e = lm_entries(&s, &n);
    void *list = lm_list(controller);
    if (n && s->lm_grab) { lm_carry(s, e, n, list, -1); return; }
    if (!((lm1_fn)lm_ctx[LM_SELECTED])(list) && stop) return;
    ((lm_move_fn)lm_ctx[LM_MOVE])(list, -1, 1);
}

void lm_down(void *controller, uint32_t stop) {
    State *s; uint32_t n;
    volatile uint8_t *e = lm_entries(&s, &n);
    void *list = lm_list(controller);
    if (n && s->lm_grab) { lm_carry(s, e, n, list, 1); return; }
    if (n && ((lm1_fn)lm_ctx[LM_SELECTED])(list) >= n && stop) return;
    ((lm_move_fn)lm_ctx[LM_MOVE])(list, 1, 1);
}

/* OK: take the row under the cursor (not the separator), or put the row taken down. Returns 1. */
uint32_t lm_toggle(void *controller) {
    State *s; uint32_t n;
    uint8_t rows[LL_MAX + 1u];
    volatile uint8_t *e = lm_entries(&s, &n);
    void *list = lm_list(controller);
    if (!n) return 1;
    lm_rows(e, n, rows);
    if (s->lm_grab) {
        uint32_t r = s->lm_grab - 1u;
        s->lm_grab = 0;
        if (r <= n) lm_row(list, rows, r, 0);
        lm_title(controller, 0);
        return 1;
    }
    uint32_t r = ((lm1_fn)lm_ctx[LM_SELECTED])(list);
    if (r > n || rows[r] == LM_SEP) return 1;
    s->lm_grab = r + 1u;
    lm_row(list, rows, r, s->lm_grab);
    lm_title(controller, 1);
    return 1;
}

static void ll_write(State *s) {
    void *st = ht_store();
    uint32_t *r = s->ll_rec;
    if (!st) return;
    r[0] = LL_MAGIC; r[1] = LL_VERSION;
    r[LL_REC_WORDS - 1u] = checksum(r, LL_REC_WORDS - 1u);
    s->ll_last_write = store_write(st, LL_REC_ID, LL_REC_WORDS * 4u, r) ? 1u : 2u;
    if (s->ll_last_write == 1u) s->ll_dirty = 0;
}
#endif

#ifdef WB_PER_LOOK
/* ---- white balance per look ----------------------------------------------------------------- */
typedef uint32_t (*wb_setter_fn)(void *ud, uint32_t value);

static uint32_t wb_off(uint32_t k) { return 0x178u + 2u * k; }

/* Field k's setter: StillWhiteBalance, the 13 G-M ones (0x20 apart), the 13 B-A ones, ColorTemp. */
static uint32_t wb_setter(uint32_t k) {
    if (k == 0u) return (uint32_t)wb_mode_set;
    if (k <= 13u) return (uint32_t)wb_gm_set + 0x20u * (k - 1u);
    if (k <= 26u) return (uint32_t)wb_ba_set + 0x20u * (k - 14u);
    return (uint32_t)wb_temp_set;
}

/* The row of a photo set's white balance: in the standard set (0) its look's (0..31 the camera's
 * looks, 32 + k film k), in Custom 1 / 2 the set's own (WB_LOOKS, WB_LOOKS + 1); -1 for any other. */
static int wb_index(uint32_t set, uint32_t look) {
    if (set == 1u || set == 2u) return (int)(WB_LOOKS + set - 1u);
    if (set != 0u) return -1;
    if (look < 32u) return (int)look;
    if (look >= FIRST && look < FIRST + MAXFILMS) return (int)(32u + look - FIRST);
    return -1;
}

static volatile uint8_t *wb_have(State *s) { return (volatile uint8_t *)&s->wb_rec[3]; }
static volatile uint8_t *wb_row(State *s, uint32_t i) { return (volatile uint8_t *)&s->wb_rec[3] + WB_ROWS + i * WB_BYTES; }

/* Field k of a record, and of a saved row (the colour temperature: two bytes, low first). */
static uint32_t wb_now(const volatile uint8_t *rec, uint32_t k) {
    uint32_t o = wb_off(k);
    return k == WB_N - 1u ? (uint32_t)rec[o] | ((uint32_t)rec[o + 1u] << 8) : rec[o];
}
static uint32_t wb_saved(const volatile uint8_t *v, uint32_t k) {
    return k == WB_N - 1u ? (uint32_t)v[k] | ((uint32_t)v[k + 1u] << 8) : v[k];
}

/* The white balance in the record now belongs to row `i`. */
static void wb_take(State *s, const volatile uint8_t *rec, int i) {
    if (i < 0) return;
    volatile uint8_t *v = wb_row(s, (uint32_t)i), *have = wb_have(s);
    for (uint32_t k = 0; k < WB_N - 1u; k++) {
        uint8_t x = rec[wb_off(k)];
        if (v[k] != x) { v[k] = x; s->wb_dirty = 1; }
    }
    for (uint32_t b = 0; b < 2u; b++) {
        uint8_t x = rec[wb_off(WB_N - 1u) + b];
        if (v[WB_N - 1u + b] != x) { v[WB_N - 1u + b] = x; s->wb_dirty = 1; }
    }
    if (!have[i]) { have[i] = 1; s->wb_dirty = 1; }
}

/* Row `i`'s white balance, if it has one, through the camera's setters, the mode last (a look or
 * set never used before keeps the white balance in use). */
static void wb_give(State *s, int i) {
    const volatile uint8_t *rec = record_of(settings_object, 0);
    if (i < 0 || !rec || !wb_have(s)[i]) return;
    const volatile uint8_t *v = wb_row(s, (uint32_t)i);
    for (uint32_t n = 0; n < WB_N; n++) {
        uint32_t k = (n + 1u) % WB_N, x = wb_saved(v, k);
        if (wb_now(rec, k) != x) ((wb_setter_fn)wb_setter(k))(settings_object, x);
    }
}

/* Hook at the entry of the StillActiveImageControlSet setter, before it runs: the row of the set
 * in use (its look's, or a Custom set's own) takes the white balance; the new set's row gets its
 * own afterwards. */
void sp_active(uint8_t *ud, uint32_t set) {
    State *s = state();
    const volatile uint8_t *rec = record_of(ud, 0);
    if (!s || !s->loaded || !rec || ud != settings_object) return;
    uint32_t a = rec[ACTIVE_SET];
    if (set >= 3u || a >= 3u || set == a) return;
    int from = wb_index(a, look_at((const uint8_t *)rec, a)), to = wb_index(set, look_at((const uint8_t *)rec, set));
    wb_take(s, rec, from);
    if (to >= 0 && to != from) s->wb_pending = (uint32_t)to + 1u;
}

/* After the camera's look or photo-set setter has run: the new row's white balance. */
void sp_wb_done(void) {
    State *s = state();
    if (!s || !s->loaded || !s->wb_pending) return;
    int i = (int)s->wb_pending - 1;
    s->wb_pending = 0;
    wb_give(s, i);
}
#endif

/* Hook at the entry of the camera's "look of set c" setter (photo 0x5327db1c.., movie
 * 0x5327dcd4..), before it writes the look and pushes the record to the live values. */
void sp_style_set(uint8_t *ud, uint32_t look, uint32_t c) {
    State *s = state();
    uint8_t *rec = record_of(ud, 0);
    if (!s || !s->loaded || !rec || c >= COMBOS) return;
#ifdef WB_PER_LOOK
    /* The standard photo set in use: its present look takes the white balance, `look` gets its own
     * after the setter (sp_wb_done). A Custom set keeps its own white balance whatever its look. */
    if (c == 0u && ud == settings_object && rec[ACTIVE_SET] == 0u && look_at(rec, 0u) != look) {
        int to = wb_index(0u, look);
        wb_take(s, rec, wb_index(0u, look_at(rec, 0u)));
        if (to >= 0) s->wb_pending = (uint32_t)to + 1u;
    }
#endif
    int from = owner(rec, c), to = owner_of(look);
    if (to < 0) to = 0;
    if (from != to) move_owner(s, ud, c, from, to);
}

/* A mode recall (U1..U3) is about to copy a stored record over the one in use without the look
 * setters: each set's owner's values go to the table first. */
void sp_before_recall(uint8_t *ud) {
    State *s = state();
    volatile uint8_t *rec = record_of(ud, 0);
    if (!s || !s->loaded || !rec) return;
    for (uint32_t c = 0; c < COMBOS; c++) {
        int o = owner((const uint8_t *)rec, c);
        for (uint32_t j = 0; j < NP; j++) {
            if (!FIELD[j][c]) continue;
            uint8_t v = rec[FIELD[j][c]];
            if (s->t[o][c][j] != v) { s->t[o][c][j] = v; s->dirty = 1; }
        }
    }
#ifdef WB_PER_LOOK
    /* The white balance in use belongs to the look in use (the recalled record's to its own). */
    if (ud == settings_object && rec[ACTIVE_SET] < 3u) wb_take(s, rec, wb_index(rec[ACTIVE_SET], look_at((const uint8_t *)rec, rec[ACTIVE_SET])));
    s->wb_pending = 0;
#endif
}

/* ---- Halation (the Toning byte: GR IV's states 0..11, aspect/halation-ui.ts) ------------------ */
/* State -> strength (0 off, 1 weak, 2 medium, 3 strong) | white << 2. */
static const uint8_t DECODE[12] = {0, 1, 3, 2, 5, 6, 7, 0, 0, 4, 4, 4};
/* Off states remembering strength (0..2 = weak, medium, strong) and colour: GR IV's 0, 7, 8, 9, 10, 11. */
static const uint8_t OFF_STATE[6] = {0, 7, 8, 9, 10, 11};
/* On states: strength 1..3 (weak, medium, strong) red 1, 3, 2; white 4, 5, 6. */
static const uint8_t ON_STATE[6] = {1, 3, 2, 4, 5, 6};
/* The strength (0..2) and colour an Off state remembers. */
static const uint8_t OFF_STRENGTH[12] = {0, 0, 2, 1, 0, 1, 2, 1, 2, 0, 1, 2};

static uint32_t encode(uint32_t strength, uint32_t white, uint32_t was) {
    if (was > 11u) was = 0;
    if (strength == 0u) return OFF_STATE[(white ? 3u : 0u) + OFF_STRENGTH[was]];
    return ON_STATE[(white ? 3u : 0u) + strength - 1u];
}

static volatile uint8_t *toning_of(uint32_t look, uint32_t set, State *s, int *field) {
    uint8_t *rec = record_of(settings_object, 0);
    int o = owner_of(look);
    *field = 0;
    if (!s || !s->loaded || !rec || set >= 3u || o < 1) return 0;
    if (owner(rec, set) == o) { *field = 1; return (volatile uint8_t *)rec + FIELD[TONING][set]; }
    return &s->t[o][set][TONING];
}

static uint32_t halation_state(uint32_t look, uint32_t set) {
    int field;
    volatile uint8_t *v = toning_of(look, set, state(), &field);
    return v && *v <= 11u ? *v : 0u;
}

static void put_state(uint32_t look, uint32_t set, uint32_t value) {
    State *s = state();
    int field;
    volatile uint8_t *v = toning_of(look, set, s, &field);
    if (!v || value > 11u || *v == value) return;
    if (field) ((uint32_t (*)(uint8_t *, uint32_t))TONING_SETTER[set])(settings_object, value);
    else { *v = (uint8_t)value; s->dirty = 1; }
}

/* The parameter screen's Halation line: the strength (0 off, 1..3) of the film in a photo set. */
uint32_t sp_hal(uint32_t look, uint32_t set) { return DECODE[halation_state(look, set)] & 3u; }
void sp_hal_put(uint32_t look, uint32_t set, uint32_t strength) {
    uint32_t was = halation_state(look, set);
    if (strength <= 3u) put_state(look, set, encode(strength, DECODE[was] >> 2 & 1u, was));
}
/* The Colour line: 0 red, 1 white. */
uint32_t sp_col(uint32_t look, uint32_t set) { return DECODE[halation_state(look, set)] >> 2 & 1u; }
void sp_col_put(uint32_t look, uint32_t set, uint32_t white) {
    uint32_t was = halation_state(look, set);
    if (white <= 1u) put_state(look, set, encode(DECODE[was] & 3u, white, was));
}
/* The Halation line's value text (a 3-byte buffer), as Grain Effect's: "--", "1", "2", "3". */
void sp_hal_text(uint32_t look, uint32_t set, uint8_t *text) {
    uint32_t v = sp_hal(look, set);
    if (!text) return;
    text[0] = v == 0u ? '-' : (uint8_t)('0' + v);
    text[1] = v == 0u ? '-' : 0;
    text[2] = 0;
}

/* ---- RAW development ------------------------------------------------------------------------- */
static int raw_owner(uint32_t look) {
    if (look == RAW_BLEACH) return 0;
    if (look >= RAW_FIRST && look < RAW_FIRST + SLOT_COUNT) return (int)(look - RAW_FIRST + 1u);
    return -1;
}
static volatile uint8_t *raw_row(uint8_t *m, uint32_t b) { return m + RAW_ROWS + b * RAW_BASE_STRIDE + RAW_BLEACH * RAW_ROW; }

static void raw_save(State *s, uint32_t b, int o) {
    volatile uint8_t *row = raw_row(s->raw.model, b);
    for (uint32_t i = 0; i < RAW_ROW; i++) s->raw.v[b][o][i] = row[i];
}
static void raw_restore(State *s, uint32_t b, int o) {
    volatile uint8_t *row = raw_row(s->raw.model, b);
    for (uint32_t i = 0; i < RAW_ROW; i++) row[i] = s->raw.v[b][o][i];
}

/* After the model has filled every look from the settings (opening a RAW file): Bleach Bypass's
 * row of base b holds the values of the owner of photo set b's fields; every other owner gets its
 * own (Bleach Bypass's row otherwise, with that owner's parameters). */
void sp_raw_init(uint8_t *model) {
    State *s = state();
    uint8_t *rec = record_of(settings_object, 0);
    if (!s || !s->loaded || !model || !rec) return;
    s->raw.model = model;
    for (uint32_t b = 0; b < RAW_BASES; b++) {
        int own = owner(rec, b);
        s->raw.own[b] = (uint8_t)own;
        volatile uint8_t *row = raw_row(model, b);
        for (uint32_t o = 0; o <= SLOT_COUNT; o++) {
            if ((int)o == own) continue;
            for (uint32_t i = 0; i < RAW_ROW; i++) s->raw.v[b][o][i] = row[i];
            for (uint32_t j = 0; j < NP; j++) s->raw.v[b][o][RAW_POS[j]] = s->t[o][b][j];
        }
    }
}

/* Bleach Bypass's row of base b now belongs to RAW look `look` (Bleach Bypass or a film). */
void sp_raw_own(uint8_t *model, uint32_t b, uint32_t look) {
    State *s = state();
    int o = raw_owner(look);
    if (!s || !s->loaded || !model || model != s->raw.model || b >= RAW_BASES || o < 0) return;
    if (s->raw.own[b] == (uint8_t)o) return;
    raw_save(s, b, s->raw.own[b]);
    raw_restore(s, b, o);
    s->raw.own[b] = (uint8_t)o;
}

/* Before the model applies a base's look (every change of look goes through it). */
void sp_raw_sync(uint8_t *model) {
    for (uint32_t b = 0; b < RAW_BASES; b++) sp_raw_own(model, b, model ? model[RAW_LOOK + b] : 0u);
}

/* ---- the record ------------------------------------------------------------------------------ */
static uint32_t checksum(const uint32_t *w, uint32_t n) {
    uint32_t sum = 0x6a09e667u;
    for (uint32_t i = 0; i < n; i++) sum = (sum ^ w[i]) * 0x01000193u + i;
    return sum;
}

static void copy_bytes(volatile uint8_t *d, const volatile uint8_t *src, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) d[i] = src[i];
}

/* 1: this round's table; 0: none. */
static int read_record(State *s) {
    void *st = ht_store();
    if (!st || store_size(st, REC_ID) != REC_WORDS * 4u) return 0;
    if (!store_read(st, REC_ID, REC_WORDS * 4u, s->rec)) return 0;
    if (s->rec[0] != REC_MAGIC || s->rec[1] != REC_VERSION || s->rec[2] != TBYTES) return 0;
    if (s->rec[REC_WORDS - 1u] != checksum(s->rec, REC_WORDS - 1u)) return 0;
    const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3u + OWNERS];
    for (uint32_t i = 0; i < TBYTES; i++) if (b[i] > 0x20u) return 0;
    for (uint32_t o = 0; o < OWNERS; o++) s->fp[o] = s->rec[3u + o];
    copy_bytes(&s->t[0][0][0], b, TBYTES);
    return 1;
}

static void write_record(State *s) {
    void *st = ht_store();
    if (!st) return;
    s->rec[0] = REC_MAGIC; s->rec[1] = REC_VERSION; s->rec[2] = TBYTES;
    for (uint32_t i = 3; i < REC_WORDS - 1u; i++) s->rec[i] = 0;
    for (uint32_t o = 0; o < OWNERS; o++) s->rec[3u + o] = s->fp[o];
    copy_bytes((volatile uint8_t *)&s->rec[3u + OWNERS], &s->t[0][0][0], TBYTES);
    s->rec[REC_WORDS - 1u] = checksum(s->rec, REC_WORDS - 1u);
    s->last_write = store_write(st, REC_ID, REC_WORDS * 4u, s->rec) ? 1u : 2u;
    if (s->last_write == 1u) s->dirty = 0;
}

#ifdef WB_PER_LOOK
/* Record 14, if it is there and whole; otherwise no look has a white balance yet. Version 1 (the
 * looks' rows only) is taken over: its rows move behind the two have bytes the Custom rows add, which
 * start without a white balance; it is written as version 2 at the next save. */
static void wb_read(State *s) {
    void *st = ht_store();
    uint32_t *r = s->wb_rec;
    uint32_t size = st ? store_size(st, WB_REC_ID) : 0u;
    int ok = 0;
    if (size == WB_REC_WORDS * 4u)
        ok = store_read(st, WB_REC_ID, WB_REC_WORDS * 4u, r) && r[0] == WB_MAGIC && r[1] == WB_VERSION && r[2] == WB_DATA &&
             r[WB_REC_WORDS - 1u] == checksum(r, WB_REC_WORDS - 1u);
    else if (size == WB_V1_WORDS * 4u && store_read(st, WB_REC_ID, WB_V1_WORDS * 4u, r) && r[0] == WB_MAGIC && r[1] == 1u &&
             r[2] == WB_V1_DATA && r[WB_V1_WORDS - 1u] == checksum(r, WB_V1_WORDS - 1u)) {
        volatile uint8_t *b = (volatile uint8_t *)&r[3];
        for (uint32_t i = WB_LOOKS * WB_BYTES; i-- > 0u;) b[WB_ROWS + i] = b[WB_LOOKS + i];
        for (uint32_t i = WB_LOOKS; i < WB_ROWS; i++) b[i] = 0;
        for (uint32_t i = WB_ROWS + WB_LOOKS * WB_BYTES; i < WB_DATA; i++) b[i] = 0;
        for (uint32_t i = 3u + (WB_DATA + 3u) / 4u; i < WB_REC_WORDS; i++) r[i] = 0;
        s->wb_dirty = 1;
        ok = 1;
    }
    for (uint32_t i = 0; ok && i < WB_ROWS; i++) if (wb_have(s)[i] > 1u) ok = 0;
    if (!ok) { for (uint32_t i = 0; i < WB_REC_WORDS; i++) ((volatile uint32_t *)r)[i] = 0; s->wb_dirty = 0; }
}

static void wb_write(State *s) {
    void *st = ht_store();
    uint32_t *r = s->wb_rec;
    if (!st) return;
    r[0] = WB_MAGIC; r[1] = WB_VERSION; r[2] = WB_DATA;
    r[WB_REC_WORDS - 1u] = checksum(r, WB_REC_WORDS - 1u);
    s->wb_last_write = store_write(st, WB_REC_ID, WB_REC_WORDS * 4u, r) ? 1u : 2u;
    if (s->wb_last_write == 1u) s->wb_dirty = 0;
}
#endif

/* Rounds 6..9: 3 (version 3, Halation strength / white), 2 (version 2, levels 0..2), 1 (version 1,
 * nine films, no Halation), 0 none. `ot` gets the old table (owner 0 Standard), `oh` the Halation. */
static int read_old(State *s, uint8_t ot[OWNERS][OLD_SETS][OLD_NP], uint8_t oh[MAXFILMS][OLD_SETS]) {
    void *st = ht_store();
    if (!st) return 0;
    uint32_t size = store_size(st, REC_ID), words, owners, version, prints = 0;
    if (size == OLD_V3_WORDS * 4u) { words = OLD_V3_WORDS; owners = OWNERS; version = 3; prints = MAXFILMS; }
    else if (size == OLD_V2_WORDS * 4u) { words = OLD_V2_WORDS; owners = OWNERS; version = 2; }
    else if (size == OLD_V1_WORDS * 4u) { words = OLD_V1_WORDS; owners = OLD_V1_OWNERS; version = 1; }
    else return 0;
    if (!store_read(st, REC_ID, words * 4u, s->rec)) return 0;
    if (s->rec[0] != OLD_MAGIC || s->rec[1] != version || s->rec[2] != (version == 1u ? OLD_V1_TBYTES : OLD_ABYTES)) return 0;
    if (s->rec[words - 1u] != checksum(s->rec, words - 1u)) return 0;
    const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3u + prints];
    uint32_t n = owners * OLD_SETS * OLD_NP;
    for (uint32_t i = 0; i < n; i++) if (b[i] > 0x20u) return 0;
    copy_bytes(&ot[0][0][0], b, n);
    if (version >= 2u) for (uint32_t i = 0; i < OLD_HBYTES; i++) {
        uint8_t v = b[OLD_TBYTES + i];
        if (version == 2u) v = v == 2u ? 3u : v;            /* round 6: off, weak, strong (red) */
        (&oh[0][0])[i] = v < 8u ? v : 0u;
    }
    return (int)version;
}

/* Halation of rounds 7..9 (bits 0..1 strength, bit 2 white) as a Toning state. */
static uint8_t old_halation(uint8_t h) {
    return (uint8_t)encode(h & 3u, h >> 2 & 1u, 0u);
}

/* Fields of combination c in a record become neutral where film o is selected. */
static void neutral_fields(uint8_t *ud, uint32_t o) {
    for (uint32_t i = 0; i < RECORDS; i++) {
        volatile uint8_t *rec = record_of(ud, i);
        if (!rec) continue;
        for (uint32_t c = 0; c < COMBOS; c++) {
            if (owner_of(look_at((const uint8_t *)rec, c)) != (int)o) continue;
            for (uint32_t j = 0; j < NP; j++) if (FIELD[j][c]) rec[FIELD[j][c]] = NEUTRAL[j];
        }
    }
}

static void neutral_owner(State *s, uint8_t *ud, uint32_t o) {
    for (uint32_t c = 0; c < COMBOS; c++)
        for (uint32_t j = 0; j < NP; j++) s->t[o][c][j] = FIELD[j][c] ? NEUTRAL[j] : 0u;
    neutral_fields(ud, o);
}

/* A record's photo set on film o that this has converted already: Standard's fields hold Standard's
 * values of the old table and Bleach Bypass's Toning the film's Halation. (The old table stays in
 * the store until the first save of this round's table: when that write did not happen after the
 * camera saved the converted records, the next start takes the old table over again.) */
static int converted(const volatile uint8_t *r, uint32_t set, uint32_t o, uint8_t ot[OWNERS][OLD_SETS][OLD_NP], const State *s) {
    for (uint32_t j = 0; j < OLD_NP; j++) if (r[STD_FIELD[j][set]] != ot[0][set][j]) return 0;
    return r[FIELD[TONING][set]] == s->t[o][set][TONING];
}

/* Rounds 6..9 kept a photo set's film in Standard's fields: those go to Bleach Bypass's fields
 * (Toning: the film's Halation), Standard's come back from the old table. A set converted already
 * keeps its fields: the film's values are those in Bleach Bypass's fields (Bleach Bypass's own
 * values of that set, which they replaced, are not known any more: neutral). */
static void take_over(State *s, uint8_t *ud, uint8_t ot[OWNERS][OLD_SETS][OLD_NP], uint8_t oh[MAXFILMS][OLD_SETS], int got) {
    uint8_t *rec = record_of(ud, 0);
    for (uint32_t k = 0; k < MAXFILMS; k++)
        for (uint32_t c = 0; c < COMBOS; c++)
            for (uint32_t j = 0; j < NP; j++) s->t[k + 1u][c][j] = FIELD[j][c] ? NEUTRAL[j] : 0u;
    for (uint32_t o = 1; o < (got == 1 ? OLD_V1_OWNERS : OWNERS); o++)
        for (uint32_t set = 0; set < OLD_SETS; set++) {
            for (uint32_t j = 0; j < OLD_NP; j++) s->t[o][set][OLD_TO_NEW[j]] = ot[o][set][j];
            s->t[o][set][TONING] = got >= 2 ? old_halation(oh[o - 1u][set]) : 0u;
        }
    /* Bleach Bypass's own values: its fields in the record in use. */
    for (uint32_t c = 0; c < COMBOS; c++)
        for (uint32_t j = 0; j < NP; j++) if (FIELD[j][c]) s->t[0][c][j] = ((volatile uint8_t *)rec)[FIELD[j][c]];
    for (uint32_t i = 0; i < RECORDS; i++) {
        volatile uint8_t *r = record_of(ud, i);
        if (!r) continue;
        for (uint32_t set = 0; set < OLD_SETS; set++) {
            uint32_t look = look_at((const uint8_t *)r, set);
            if (look < FIRST || look >= FIRST + MAXFILMS) continue;
            uint32_t o = look - FIRST + 1u;
            if (got == 1 && o >= OLD_V1_OWNERS) continue;
            if (converted(r, set, o, ot, s)) {
                if (i == 0u) for (uint32_t j = 0; j < NP; j++) {
                    s->t[o][set][j] = r[FIELD[j][set]];
                    s->t[0][set][j] = NEUTRAL[j];
                }
                continue;
            }
            for (uint32_t j = 0; j < OLD_NP; j++) {
                uint8_t v = r[STD_FIELD[j][set]];
                if (i == 0u) s->t[o][set][OLD_TO_NEW[j]] = v;
                r[FIELD[OLD_TO_NEW[j]][set]] = v;
                r[STD_FIELD[j][set]] = ot[0][set][j];
            }
            r[FIELD[TONING][set]] = s->t[o][set][TONING];
        }
    }
}

/* Settings load (once, at start): the table. Calls only the store and the allocator: nothing here
 * may ask for the settings object (the load runs while it is being made). */
uint32_t sp_load(uint8_t *ud) {
    uint32_t r = prior_native_load(ud);
    uint8_t *rec = record_of(ud, 0);
    if (state() || !rec) return r;
    State *s = (State *)heap_alloc(sizeof(State));
    if (!s) return r;
    for (uint32_t i = 0; i < sizeof(State) / 4u; i++) ((volatile uint32_t *)s)[i] = 0;
    int found = read_record(s);
    if (!found) {
        int got = read_old(s, s->ot, s->oh);
        if (got) {
            take_over(s, ud, s->ot, s->oh, got);
            /* Version 3 has the presets' fingerprints: a film whose preset changed starts neutral. */
            if (got == 3) for (uint32_t o = 1; o <= SLOT_COUNT; o++) if (s->rec[3u + o - 1u] != print_of(o)) neutral_owner(s, ud, o);
        }
        else {
            /* Bleach Bypass keeps its values; the films start neutral, also where one is selected. */
            for (uint32_t c = 0; c < COMBOS; c++)
                for (uint32_t j = 0; j < NP; j++) {
                    uint32_t f = FIELD[j][c];
                    s->t[0][c][j] = f ? ((volatile uint8_t *)rec)[f] : 0u;
                    for (uint32_t o = 1; o < OWNERS; o++) s->t[o][c][j] = f ? NEUTRAL[j] : 0u;
                }
            for (uint32_t o = 1; o <= SLOT_COUNT; o++) neutral_fields(ud, o);
        }
        for (uint32_t o = 1; o <= SLOT_COUNT; o++) s->fp[o] = print_of(o);
        s->dirty = 1;
    } else {
        /* A film that now holds another preset starts again from neutral; films beyond the build's
         * count keep their values and fingerprints. */
        for (uint32_t o = 1; o <= SLOT_COUNT; o++) {
            if (s->fp[o] == print_of(o)) continue;
            neutral_owner(s, ud, o);
            s->fp[o] = print_of(o);
            s->dirty = 1;
        }
    }
    /* A set the guard turns into Standard: its fields hold that film's values, which go to the
     * table (a film shown again with the same preset gets them back); Bleach Bypass's come back. */
    for (uint32_t c = 0; c < COMBOS; c++) {
        uint32_t o = away_owner(look_at(rec, c), c);
        if (!o) continue;
        for (uint32_t j = 0; j < NP; j++) {
            uint32_t f = FIELD[j][c];
            if (!f) continue;
            s->t[o][c][j] = ((volatile uint8_t *)rec)[f];
            put_field(ud, c, f, s->t[0][c][j]);
        }
        s->dirty = 1;
    }
    for (uint32_t i = 1; i < RECORDS; i++) {
        volatile uint8_t *u = record_of(ud, i);
        if (!u) continue;
        for (uint32_t c = 0; c < 3u; c++) {
            if (!away_owner(look_at((const uint8_t *)u, c), c)) continue;
            for (uint32_t j = 0; j < NP; j++) if (FIELD[j][c]) u[FIELD[j][c]] = owner(rec, c) == 0 ? rec[FIELD[j][c]] : s->t[0][c][j];
        }
    }
#ifdef WB_PER_LOOK
    wb_read(s);
#endif
#ifdef LIVE_LAYOUT
    ll_read(s);
#endif
    s->loaded = 1;
    s->magic = STATE_MAGIC;
    sp_gap[0] = (uint32_t)s;
#ifdef LIVE_LAYOUT
    if (ll_default[0] >= 3u && ll_default[0] <= LL_MAX) {
        /* movw / movt (the generator relocates those, not a literal word). */
        uint32_t q;
        __asm__("movw %0, #:lower16:ll_query\n\tmovt %0, #:upper16:ll_query" : "=r"(q));
        ll_word[0] = q;
    }
#endif
    return r;
}

/* Settings save (at power off): then the table, if it changed. */
uint32_t sp_save(uint8_t *ud) {
    uint32_t r = prior_native_save(ud);
    State *s = state();
    if (s && s->loaded && s->dirty) {
        write_record(s);
        if (s->last_write != 1u) write_record(s);   /* once more: until it is written, the next start takes the old table over again */
    }
#ifdef WB_PER_LOOK
    if (s && s->loaded && s->wb_dirty) wb_write(s);
#endif
#ifdef LIVE_LAYOUT
    if (s && s->loaded && s->ll_dirty) ll_write(s);
#endif
    return r;
}
