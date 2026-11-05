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
 *     whole record to the live values (0x532750f8), so the values are swapped just before they run
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
 * Taken over from rounds 6..9 (tools/gr3x/native/slots*.c, the same HTData record with another
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

extern uint8_t *storage_singleton(void);
extern uint32_t store_write(void *store, uint32_t id, uint32_t size, const void *data);
extern uint32_t store_read(void *store, uint32_t id, uint32_t size, void *data);
extern uint32_t store_size(void *store, uint32_t id);
extern void *heap_alloc(uint32_t size);
extern uint32_t prior_native_save(uint8_t *ud);
extern uint32_t prior_native_load(uint8_t *ud);
extern volatile uint32_t sp_gap[];      /* zeroed at every start; [0] = state */
extern uint8_t settings_object[];       /* UserDataModel (0x55063f30): the record in use at +4, the stored ones after it */
/* The fingerprint of each film's preset in this build; after them one word, bit k set when film k
 * is hidden from the Image Control lists. */
extern const uint32_t slot_prints[];

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
static const uint32_t TONING_SETTER[3] = {0x5325d3cc, 0x5325f90c, 0x53261eac};

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

/* Hook at the entry of the camera's "look of set c" setter (photo 0x5327b394.., movie
 * 0x5327b54c..), before it writes the look and pushes the record to the live values. */
void sp_style_set(uint8_t *ud, uint32_t look, uint32_t c) {
    State *s = state();
    uint8_t *rec = record_of(ud, 0);
    if (!s || !s->loaded || !rec || c >= COMBOS) return;
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
    s->loaded = 1;
    s->magic = STATE_MAGIC;
    sp_gap[0] = (uint32_t)s;
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
    return r;
}
