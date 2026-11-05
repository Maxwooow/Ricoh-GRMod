// SPDX-License-Identifier: GPL-2.0-only
/* GR III 2.10 / GR IIIx 1.60, round 7 (as GR Mod 0.8.2): own parameters and the Halation setting
 * of up to twenty added films (looks 64..83), as GR IV's added slots have them.
 *
 * Successor of slots2.c (kept unchanged for round 6's files). The same: the films render through
 * Standard (look 11) and use Standard's fields of the photo Image Control set; per set, one
 * "owner" (the film selected there, or Standard) has its values in those fields, the others wait
 * in a table (HTData record 12); before a set's look changes the values are swapped (sp_style);
 * the parameter screen's Cancel puts the Halation settings back (sp_hal_backup / restore); at
 * start a set left on a film this build does not have gets Standard and Standard's own values.
 * What is new (GR IV 0.8.2):
 *   - each film's Halation setting per photo set is a byte: bits 0..1 the strength (0 off,
 *     1 weak, 2 medium, 3 strong), bit 2 the colour (0 red, 1 white). The parameter screen shows
 *     two lines for a film (halation-rows.ts): "Halation" like GR III's own Grain Effect (Off /
 *     1 / 2 / 3: sp_hal, sp_hal_put, sp_hal_text) and "Colour" (red / white: sp_col, sp_col_put).
 *     sp_hal_level gives the development step the strength and the colour of the frame's film;
 *   - a fingerprint of each film's preset is kept with the table (record version 3). At start a
 *     film whose preset changed starts again from the neutral values (4 for all nine fields,
 *     Halation off) in every photo set: in the table, in the record being loaded and in the
 *     stored records (modes, U1..U3) whose set has it selected. Films beyond the build's count
 *     keep their values and fingerprints (added back with the same preset, they get them back);
 *   - a stored record (modes, U1..U3) whose set has a film this build does not have gets
 *     Standard there, with Standard's values (the settings guard, guard.ts, would give it
 *     Standard anyway; this also gives the fields back);
 *   - before a mode recall copies a stored record into use, the owners' values go to the table
 *     (sp_before_recall; up to round 6 a recall lost what was adjusted since the last look change);
 *   - version-2 (round 6) and version-1 records are taken over, as made with this build's
 *     presets: version 2's levels 0 / 1 / 2 (off, weak, strong) become off / weak / strong red.
 * Round 8 (as GR Mod 0.8.4), built with -DHIDDEN_FILMS (compile_slots.py slots4): after the prints
 * one word, bit k set when film k is hidden from the Image Control lists. A hidden film selected in
 * the standard photo set (set 0; the custom sets 1 and 2 keep their look) is handled at start like a
 * film this build does not have: the settings guard gives the set Standard, the film's values go to
 * its table row (shown again with the same preset, it gets them back) and Standard's come back, in
 * the record being loaded and in the stored ones.
 * Built position independent: tools/gr3x/compile_slots.py slots3. Addresses: GR III 2.10 = IIIx 1.60.
 */
#include <stdint.h>

#define STANDARD 11u
#define FIRST 64u
#define FILMS 20u
#define OWNERS (FILMS + 1u)
#define SETS 3u
#define NP 9u
#define NEUTRAL 4u
#define SET_STRIDE 0xe2u
#define LOOK_OF_SET 0x1c2u        /* + 2 * set */
#define ACTIVE_SET 0x1c0u
#define MOVIE 0x44u
#define STORED 7u                 /* the stored records at ud + 8 .. ud + 0x20 (modes, U1..U3) */
#define REC_ID 12u
#define REC_MAGIC 0x33505247u     /* 'GRP3' */
#define REC_VERSION 3u
#define STATE_MAGIC 0x33534c54u   /* 'TLS3' */
#define TBYTES (OWNERS * SETS * NP)                  /* 567 */
#define HBYTES (FILMS * SETS)                        /* 60 */
#define ABYTES (TBYTES + HBYTES)                     /* 627 */
#define AWORDS ((ABYTES + 3u) / 4u)
#define REC_WORDS (3u + FILMS + AWORDS + 1u)         /* 181: magic, version, size, prints, table, sum */
/* Version 2 (slots2.c, round 6): no prints, levels 0..2. */
#define V2_WORDS (3u + AWORDS + 1u)                  /* 161 */
/* Version 1 (slots.c): nine films. */
#define V1_OWNERS 10u
#define V1_TBYTES (V1_OWNERS * SETS * NP)            /* 270 */
#define V1_WORDS (3u + (V1_TBYTES + 3u) / 4u + 1u)   /* 72 */
#define STRENGTH 3u
#define WHITE 4u
#define SETTINGS_MAX 8u

typedef void *(*singleton_fn)(void);
typedef uint32_t (*write_fn)(void *, uint32_t, uint32_t, const void *);
typedef uint32_t (*read_fn)(void *, uint32_t, uint32_t, void *);
typedef uint32_t (*size_fn)(void *, uint32_t);
typedef void *(*alloc_fn)(uint32_t);

#define storage_singleton ((singleton_fn)0x53828014u)
#define store_write ((write_fn)0x53829a08u)
#define store_read ((read_fn)0x53829fccu)
#define store_size ((size_fn)0x53829e50u)
#define heap_alloc ((alloc_fn)0x536af2a8u)
/* Zeroed at every start (the start-up fill is extended to the heap base 0x55804380). */
#define GAP ((volatile uint32_t *)0x55804374u)
/* The settings record (the pointer the date imprint reads too). */
#define SETTINGS ((uint8_t *volatile *)0x55063f34u)

typedef struct {
    uint32_t magic, loaded, dirty, last_write, films;
    uint8_t t[OWNERS][SETS][NP];
    uint8_t h[FILMS][SETS];
    uint8_t pad[AWORDS * 4u - ABYTES];
    uint32_t fp[FILMS];
    uint32_t rec[REC_WORDS];
    uint32_t backed_up;
    uint8_t hb[FILMS][SETS];      /* the settings when the parameter screen opened (Cancel) */
} State;

static uint32_t field(uint32_t j, uint32_t set) {
    uint32_t base;
    switch (j) {
    case 0: base = 0x1c8u; break;  /* saturation */
    case 1: base = 0x1d4u; break;  /* hue */
    case 2: base = 0x1e0u; break;  /* high/low key */
    case 3: base = 0x1f2u; break;  /* contrast */
    case 4: base = 0x204u; break;  /* contrast (highlight) */
    case 5: base = 0x216u; break;  /* contrast (shadow) */
    case 6: base = 0x228u; break;  /* sharpness */
    case 7: base = 0x278u; break;  /* shading */
    default: base = 0x28au; break; /* clarity */
    }
    return base + set * SET_STRIDE;
}

static State *state(void) {
    State *s = (State *)GAP[0];
    return s && s->magic == STATE_MAGIC ? s : 0;
}

static void *ht_store(void) {
    uint8_t *f = (uint8_t *)storage_singleton();
    return f ? *(void **)(f + 0x14) : 0;
}

static uint8_t *record_of(uint8_t *ud) {
    return ud ? *(uint8_t **)(ud + 4) : 0;
}

/* Stored record i (0..6) of the settings object, or 0. */
static uint8_t *stored_of(uint8_t *ud, uint32_t i) {
    return ud ? *(uint8_t **)(ud + 8u + 4u * i) : 0;
}

/* Owner index of a look: Standard 0, film k (64 + k, k below the build's count) k + 1, else -1. */
static int owner_of(const State *s, uint32_t look) {
    if (look == STANDARD) return 0;
    if (look >= FIRST && look - FIRST < s->films) return (int)(look - FIRST + 1u);
    return -1;
}

static int owner(const State *s, const uint8_t *rec, uint32_t set) {
    int o = owner_of(s, rec[LOOK_OF_SET + 2u * set]);
    return o < 0 ? 0 : o;
}

static void swap(State *s, uint8_t *rec, uint32_t set, int from, int to) {
    volatile uint8_t *f = rec;
    for (uint32_t j = 0; j < NP; j++) s->t[from][set][j] = f[field(j, set)];
    for (uint32_t j = 0; j < NP; j++) f[field(j, set)] = s->t[to][set][j];
    s->dirty = 1;
}

/* Hook at the entry of the firmware's "look of photo set n" setter, before it runs. */
void sp_style(uint8_t *ud, uint32_t look, uint32_t set) {
    State *s = state();
    uint8_t *rec = record_of(ud);
    if (!s || !s->loaded || !rec || set >= SETS) return;
    int from = owner(s, rec, set), to = owner_of(s, look);
    if (to < 0) to = 0;
    if (from != to) swap(s, rec, set, from, to);
}

static uint32_t checksum(const uint32_t *w, uint32_t n) {
    uint32_t sum = 0x6a09e667u;
    for (uint32_t i = 0; i < n; i++) sum = (sum ^ w[i]) * 0x01000193u + i;
    return sum;
}

static void copy_bytes(volatile uint8_t *d, const volatile uint8_t *src, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) d[i] = src[i];
}

/* 3: version 3 read (with prints), 2: version 2 taken over, 1: version 1 taken over (t of owners
 * 0..9 only), 0: none. */
static int read_record(State *s) {
    void *st = ht_store();
    if (!st) return 0;
    uint32_t size = store_size(st, REC_ID);
    if (size == REC_WORDS * 4u) {
        const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3u + FILMS];
        if (!store_read(st, REC_ID, REC_WORDS * 4u, s->rec)) return 0;
        if (s->rec[0] != REC_MAGIC || s->rec[1] != REC_VERSION || s->rec[2] != ABYTES) return 0;
        if (s->rec[REC_WORDS - 1u] != checksum(s->rec, REC_WORDS - 1u)) return 0;
        for (uint32_t i = 0; i < TBYTES; i++) if (b[i] > 0x20u) return 0;
        for (uint32_t i = TBYTES; i < ABYTES; i++) if (b[i] >= SETTINGS_MAX) return 0;
        for (uint32_t k = 0; k < FILMS; k++) s->fp[k] = s->rec[3u + k];
        copy_bytes(&s->t[0][0][0], b, TBYTES);
        copy_bytes(&s->h[0][0], b + TBYTES, HBYTES);
        return 3;
    }
    if (size == V2_WORDS * 4u) {
        const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3];
        if (!store_read(st, REC_ID, V2_WORDS * 4u, s->rec)) return 0;
        if (s->rec[0] != REC_MAGIC || s->rec[1] != 2u || s->rec[2] != ABYTES) return 0;
        if (s->rec[V2_WORDS - 1u] != checksum(s->rec, V2_WORDS - 1u)) return 0;
        for (uint32_t i = 0; i < TBYTES; i++) if (b[i] > 0x20u) return 0;
        for (uint32_t i = TBYTES; i < ABYTES; i++) if (b[i] > 2u) return 0;
        copy_bytes(&s->t[0][0][0], b, TBYTES);
        /* Round 6's Weak and Strong (red): strength 1 and 3. */
        for (uint32_t i = 0; i < HBYTES; i++) { uint8_t v = b[TBYTES + i]; (&s->h[0][0])[i] = (uint8_t)(v == 2u ? 3u : v); }
        return 2;
    }
    if (size == V1_WORDS * 4u) {
        const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3];
        if (!store_read(st, REC_ID, V1_WORDS * 4u, s->rec)) return 0;
        if (s->rec[0] != REC_MAGIC || s->rec[1] != 1u || s->rec[2] != V1_TBYTES) return 0;
        if (s->rec[V1_WORDS - 1u] != checksum(s->rec, V1_WORDS - 1u)) return 0;
        for (uint32_t i = 0; i < V1_TBYTES; i++) if (b[i] > 0x20u) return 0;
        copy_bytes(&s->t[0][0][0], b, V1_TBYTES);   /* same layout for owners 0..9 */
        return 1;
    }
    return 0;
}

static void write_record(State *s) {
    void *st = ht_store();
    if (!st) return;
    s->rec[0] = REC_MAGIC; s->rec[1] = REC_VERSION; s->rec[2] = ABYTES;
    for (uint32_t i = 3; i < REC_WORDS - 1u; i++) s->rec[i] = 0;
    for (uint32_t k = 0; k < FILMS; k++) s->rec[3u + k] = s->fp[k];
    volatile uint8_t *b = (volatile uint8_t *)&s->rec[3u + FILMS];
    copy_bytes(b, &s->t[0][0][0], TBYTES);
    copy_bytes(b + TBYTES, &s->h[0][0], HBYTES);
    s->rec[REC_WORDS - 1u] = checksum(s->rec, REC_WORDS - 1u);
    s->last_write = store_write(st, REC_ID, REC_WORDS * 4u, s->rec) ? 1u : 2u;
    if (s->last_write == 1u) s->dirty = 0;
}

/* In a record, the fields of the sets that have film k selected become neutral. */
static void neutral_fields(uint8_t *rec, uint32_t k) {
    volatile uint8_t *f = rec;
    if (!rec) return;
    for (uint32_t set = 0; set < SETS; set++) {
        if (f[LOOK_OF_SET + 2u * set] != FIRST + k) continue;
        for (uint32_t j = 0; j < NP; j++) f[field(j, set)] = (uint8_t)NEUTRAL;
    }
}

/* Film k starts again from neutral: its table rows, its Halation, and the fields of every set that
 * has it selected (the record being loaded and the stored ones). */
static void neutral_film(State *s, uint8_t *ud, uint32_t k) {
    for (uint32_t set = 0; set < SETS; set++) {
        for (uint32_t j = 0; j < NP; j++) s->t[k + 1u][set][j] = (uint8_t)NEUTRAL;
        s->h[k][set] = 0;
    }
    neutral_fields(record_of(ud), k);
    for (uint32_t i = 0; i < STORED; i++) neutral_fields(stored_of(ud, i), k);
    s->dirty = 1;
}

/* A set's look that the settings guard turns into Standard after the load: a film this build does
 * not have, or (round 8) a hidden film in the standard photo set. */
#ifdef HIDDEN_FILMS
static int away(uint32_t look, uint32_t set, uint32_t films, uint32_t hidden) {
    if (look >= FIRST + films && look < FIRST + FILMS) return 1;
    return set == 0u && look >= FIRST && look < FIRST + films && ((hidden >> (look - FIRST)) & 1u) != 0u;
}
#else
#define away(look, set, films, hidden) ((look) >= FIRST + (films) && (look) < FIRST + FILMS)
#endif

/* After the firmware's settings load (once, at start). `films`: the build's number of films;
 * `prints`: their presets' fingerprints (round 8: then the hidden films). Calls only the store and
 * the allocator: nothing here may ask for the settings object. */
void sp_after_load(uint8_t *ud, uint32_t films, const uint32_t *prints) {
    uint8_t *rec = record_of(ud);
    if (state() || !rec || films < 1u || films > FILMS || !prints) return;
#ifdef HIDDEN_FILMS
    uint32_t hidden = prints[films];
#else
    uint32_t hidden = 0u;
#endif
    State *s = (State *)heap_alloc(sizeof(State));
    if (!s) return;
    for (uint32_t i = 0; i < sizeof(State) / 4u; i++) ((volatile uint32_t *)s)[i] = 0;
    s->films = films;
    int got = read_record(s);
    if (got < 2) {
        /* Owners without values (all of them, or the films a version-1 record did not have):
         * the values the fields hold now. */
        volatile uint8_t *f = rec;
        for (uint32_t set = 0; set < SETS; set++)
            for (uint32_t o = got == 1 ? V1_OWNERS : 0u; o < OWNERS; o++)
                for (uint32_t j = 0; j < NP; j++) s->t[o][set][j] = f[field(j, set)];
        s->dirty = 1;
    }
    if (got == 3) {
        for (uint32_t k = 0; k < films; k++) {
            if (s->fp[k] == prints[k]) continue;
            neutral_film(s, ud, k);
            s->fp[k] = prints[k];
        }
    } else {
        /* Taken as made with this build's presets. */
        for (uint32_t k = 0; k < films; k++) s->fp[k] = prints[k];
        s->dirty = 1;
    }
    /* A set left on a film this build does not have: back to Standard and its own values (the
     * fields hold the missing film's values, which stay in its table row). */
    for (uint32_t set = 0; set < SETS; set++) {
        uint32_t look = rec[LOOK_OF_SET + 2u * set];
        if (away(look, set, films, hidden)) {
            swap(s, rec, set, (int)(look - FIRST + 1u), 0);
            ((volatile uint8_t *)rec)[LOOK_OF_SET + 2u * set] = (uint8_t)STANDARD;
        }
    }
    /* The same in the stored records: Standard's values (in the fields of the record being
     * loaded when Standard owns that set there, else in the table). */
    for (uint32_t i = 0; i < STORED; i++) {
        volatile uint8_t *u = stored_of(ud, i);
        if (!u) continue;
        for (uint32_t set = 0; set < SETS; set++) {
            uint32_t look = u[LOOK_OF_SET + 2u * set];
            if (!away(look, set, films, hidden)) continue;
            int std_here = owner(s, rec, set) == 0;
            for (uint32_t j = 0; j < NP; j++) u[field(j, set)] = std_here ? rec[field(j, set)] : s->t[0][set][j];
            u[LOOK_OF_SET + 2u * set] = (uint8_t)STANDARD;
        }
    }
    s->loaded = 1;
    s->magic = STATE_MAGIC;
    GAP[0] = (uint32_t)s;
}

/* A mode recall (U1..U3, guard.ts) is about to copy a stored record over the record in use without
 * the look setters: the values of each set's owner go to the table first, so that what was adjusted
 * there is kept (the copied record's fields then belong to its own owners). */
void sp_before_recall(uint8_t *ud) {
    State *s = state();
    uint8_t *rec = record_of(ud);
    volatile uint8_t *f = rec;
    if (!s || !s->loaded || !rec) return;
    for (uint32_t set = 0; set < SETS; set++) {
        int o = owner(s, rec, set);
        for (uint32_t j = 0; j < NP; j++) {
            uint8_t v = f[field(j, set)];
            if (s->t[o][set][j] != v) { s->t[o][set][j] = v; s->dirty = 1; }
        }
    }
}

/* After the firmware's settings save (at power off): the table, if it changed. */
void sp_after_save(void) {
    State *s = state();
    if (s && s->loaded && s->dirty) write_record(s);
}

static volatile uint8_t *setting_of(uint32_t look, uint32_t set) {
    State *s = state();
    if (!s || !s->loaded || set >= SETS || look < FIRST || look - FIRST >= s->films) return 0;
    return &s->h[look - FIRST][set];
}

static uint32_t setting(uint32_t look, uint32_t set) {
    volatile uint8_t *v = setting_of(look, set);
    return v && *v < SETTINGS_MAX ? *v : 0u;
}

static void put_setting(uint32_t look, uint32_t set, uint32_t value) {
    volatile uint8_t *v = setting_of(look, set);
    State *s = state();
    if (!v || value >= SETTINGS_MAX || *v == value) return;
    *v = (uint8_t)value;
    s->dirty = 1;
}

/* The parameter screen's Halation line: the strength (0 off, 1..3) of the film in a photo set. */
uint32_t sp_hal(uint32_t look, uint32_t set) {
    return setting(look, set) & STRENGTH;
}

void sp_hal_put(uint32_t look, uint32_t set, uint32_t strength) {
    if (strength > STRENGTH) return;
    put_setting(look, set, (setting(look, set) & ~STRENGTH) | strength);
}

/* The Colour line: 0 red, 1 white. */
uint32_t sp_col(uint32_t look, uint32_t set) {
    return (setting(look, set) & WHITE) ? 1u : 0u;
}

void sp_col_put(uint32_t look, uint32_t set, uint32_t white) {
    if (white > 1u) return;
    put_setting(look, set, (setting(look, set) & ~WHITE) | (white ? WHITE : 0u));
}

/* The Halation line's value text (a 3-byte buffer), as Grain Effect's: "--", "1", "2", "3". */
void sp_hal_text(uint32_t look, uint32_t set, uint8_t *text) {
    uint32_t v = sp_hal(look, set);
    if (!text) return;
    text[0] = v == 0u ? '-' : (uint8_t)('0' + v);
    text[1] = v == 0u ? '-' : 0;
    text[2] = 0;
}

/* The development step: the strength of the frame's film in the active photo set, with the
 * colour at bit 9 (the stash word has the strength at bits 8..15 and white at bit 17); 0 when
 * the camera is in movie mode or the look is not a film of this build. */
uint32_t sp_hal_level(uint32_t look) {
    const uint8_t *rec = *SETTINGS;
    uint32_t v;
    if (!rec || rec[MOVIE] != 0u) return 0u;
    v = setting(look, rec[ACTIVE_SET]);
    return (v & STRENGTH) | ((v & WHITE) ? 0x200u : 0u);
}

/* The parameter screen opens (the camera backs its parameters up): keep the settings. */
void sp_hal_backup(void) {
    State *s = state();
    if (!s || !s->loaded) return;
    copy_bytes(&s->hb[0][0], &s->h[0][0], HBYTES);
    s->backed_up = 1;
}

/* Cancel (the camera restores its parameters): the settings as they were. */
void sp_hal_restore(void) {
    State *s = state();
    if (!s || !s->loaded || !s->backed_up) return;
    for (uint32_t i = 0; i < HBYTES; i++)
        if ((&s->h[0][0])[i] != (&s->hb[0][0])[i]) { (&s->h[0][0])[i] = (&s->hb[0][0])[i]; s->dirty = 1; }
}
