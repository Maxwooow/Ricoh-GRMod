// SPDX-License-Identifier: GPL-2.0-only
/* GR III 2.10 / GR IIIx 1.60, round 6: own parameters and the Halation level of up to twenty
 * added films (looks 64..83), as GR IV's added slots have them.
 *
 * Successor of slots.c (kept unchanged for the camera-tested nine-film files). What is the same:
 * the films render through Standard (look 11) and use Standard's fields of the photo Image
 * Control set; per set, one "owner" (the film selected there, or Standard) has its values in
 * those fields, the others wait in a table (HTData record 12); before a set's look changes the
 * values are swapped (sp_style). What is new:
 *   - room for twenty films, whatever number a build has (the table format does not depend on
 *     it), so a later build with more or fewer films reads the same record;
 *   - each film's Halation level per photo set (0 off, 1 weak, 2 strong), the value of the
 *     "Halation" line the parameter screen shows for a film (image-control.ts): read and set by
 *     the screen through sp_hal / sp_hal_put / sp_hal_text, read by the development step for the
 *     JPEG's halation through sp_hal_level (the film of the frame, the active photo set);
 *   - the parameter screen's Cancel puts the levels back as they were when it opened, as the
 *     camera does with every other parameter (sp_hal_backup / sp_hal_restore at its backup and
 *     restore of the parameters, 0x532c337c / 0x532c34a8);
 *   - the record is version 2; a version-1 record (nine films) is taken over (its nine films'
 *     values; Halation off);
 *   - at start, a photo set whose look is a film this build does not have (a build with fewer
 *     films was flashed) gets Standard, with Standard's own values swapped back in.
 * Built position independent: tools/gr3x/compile_slots.py slots2. Addresses: GR III 2.10 = IIIx 1.60.
 */
#include <stdint.h>

#define STANDARD 11u
#define FIRST 64u
#define FILMS 20u
#define OWNERS (FILMS + 1u)
#define SETS 3u
#define NP 9u
#define SET_STRIDE 0xe2u
#define LOOK_OF_SET 0x1c2u        /* + 2 * set */
#define ACTIVE_SET 0x1c0u
#define MOVIE 0x44u
#define REC_ID 12u
#define REC_MAGIC 0x33505247u     /* 'GRP3' */
#define REC_VERSION 2u
#define STATE_MAGIC 0x32534c54u   /* 'TLS2' */
#define TBYTES (OWNERS * SETS * NP)                  /* 567 */
#define HBYTES (FILMS * SETS)                        /* 60 */
#define ABYTES (TBYTES + HBYTES)                     /* 627 */
#define AWORDS ((ABYTES + 3u) / 4u)
#define REC_WORDS (3u + AWORDS + 1u)                 /* 161 */
/* Version 1 (slots.c): nine films. */
#define V1_OWNERS 10u
#define V1_TBYTES (V1_OWNERS * SETS * NP)            /* 270 */
#define V1_WORDS (3u + (V1_TBYTES + 3u) / 4u + 1u)   /* 72 */
#define LEVELS 3u

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
    uint32_t rec[REC_WORDS];
    uint32_t backed_up;
    uint8_t hb[FILMS][SETS];      /* the levels when the parameter screen opened (Cancel) */
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

/* 2: version 2 read, 1: version 1 taken over (t of owners 0..9 only), 0: none. */
static int read_record(State *s) {
    void *st = ht_store();
    if (!st) return 0;
    uint32_t size = store_size(st, REC_ID);
    const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3];
    if (size == REC_WORDS * 4u) {
        if (!store_read(st, REC_ID, REC_WORDS * 4u, s->rec)) return 0;
        if (s->rec[0] != REC_MAGIC || s->rec[1] != REC_VERSION || s->rec[2] != ABYTES) return 0;
        if (s->rec[REC_WORDS - 1u] != checksum(s->rec, REC_WORDS - 1u)) return 0;
        for (uint32_t i = 0; i < TBYTES; i++) if (b[i] > 0x20u) return 0;
        for (uint32_t i = TBYTES; i < ABYTES; i++) if (b[i] >= LEVELS) return 0;
        copy_bytes(&s->t[0][0][0], b, TBYTES);
        copy_bytes(&s->h[0][0], b + TBYTES, HBYTES);
        return 2;
    }
    if (size == V1_WORDS * 4u) {
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
    volatile uint8_t *b = (volatile uint8_t *)&s->rec[3];
    copy_bytes(b, &s->t[0][0][0], TBYTES);
    copy_bytes(b + TBYTES, &s->h[0][0], HBYTES);
    s->rec[REC_WORDS - 1u] = checksum(s->rec, REC_WORDS - 1u);
    s->last_write = store_write(st, REC_ID, REC_WORDS * 4u, s->rec) ? 1u : 2u;
    if (s->last_write == 1u) s->dirty = 0;
}

/* After the firmware's settings load (once, at start). `films`: the build's number of films.
 * Calls only the store and the allocator: nothing here may ask for the settings object. */
void sp_after_load(uint8_t *ud, uint32_t films) {
    uint8_t *rec = record_of(ud);
    if (state() || !rec || films < 1u || films > FILMS) return;
    State *s = (State *)heap_alloc(sizeof(State));
    if (!s) return;
    for (uint32_t i = 0; i < sizeof(State) / 4u; i++) ((volatile uint32_t *)s)[i] = 0;
    s->films = films;
    int got = read_record(s);
    if (got != 2) {
        /* Owners without values (all of them, or the films a version-1 record did not have):
         * the values the fields hold now. */
        volatile uint8_t *f = rec;
        for (uint32_t set = 0; set < SETS; set++)
            for (uint32_t o = got == 1 ? V1_OWNERS : 0u; o < OWNERS; o++)
                for (uint32_t j = 0; j < NP; j++) s->t[o][set][j] = f[field(j, set)];
        s->dirty = 1;
    }
    /* A set left on a film this build does not have: back to Standard and its own values (the
     * fields hold the missing film's values, which stay in its table row). */
    for (uint32_t set = 0; set < SETS; set++) {
        uint32_t look = rec[LOOK_OF_SET + 2u * set];
        if (look >= FIRST + films && look < FIRST + FILMS) {
            swap(s, rec, set, (int)(look - FIRST + 1u), 0);
            ((volatile uint8_t *)rec)[LOOK_OF_SET + 2u * set] = (uint8_t)STANDARD;
        }
    }
    s->loaded = 1;
    s->magic = STATE_MAGIC;
    GAP[0] = (uint32_t)s;
}

/* After the firmware's settings save (at power off): the table, if it changed. */
void sp_after_save(void) {
    State *s = state();
    if (s && s->loaded && s->dirty) write_record(s);
}

static volatile uint8_t *level_of(uint32_t look, uint32_t set) {
    State *s = state();
    if (!s || !s->loaded || set >= SETS || look < FIRST || look - FIRST >= s->films) return 0;
    return &s->h[look - FIRST][set];
}

/* The parameter screen: the film's level in a photo set (0 when there is none). */
uint32_t sp_hal(uint32_t look, uint32_t set) {
    volatile uint8_t *l = level_of(look, set);
    return l && *l < LEVELS ? *l : 0u;
}

void sp_hal_put(uint32_t look, uint32_t set, uint32_t value) {
    volatile uint8_t *l = level_of(look, set);
    State *s = state();
    if (!l || value >= LEVELS || *l == value) return;
    *l = (uint8_t)value;
    s->dirty = 1;
}

/* The list line's value text (a 3-byte buffer): "--", "W" (weak), "S" (strong). */
void sp_hal_text(uint32_t look, uint32_t set, uint8_t *text) {
    uint32_t v = sp_hal(look, set);
    if (!text) return;
    text[0] = v == 0u ? '-' : v == 1u ? 'W' : 'S';
    text[1] = v == 0u ? '-' : 0;
    text[2] = 0;
}

/* The development step: the level of the frame's film in the active photo set (0 when the
 * camera is in movie mode or the look is not a film of this build). */
uint32_t sp_hal_level(uint32_t look) {
    const uint8_t *rec = *SETTINGS;
    if (!rec || rec[MOVIE] != 0u) return 0u;
    return sp_hal(look, rec[ACTIVE_SET]);
}

/* The parameter screen opens (the camera backs its parameters up): keep the levels. */
void sp_hal_backup(void) {
    State *s = state();
    if (!s || !s->loaded) return;
    copy_bytes(&s->hb[0][0], &s->h[0][0], HBYTES);
    s->backed_up = 1;
}

/* Cancel (the camera restores its parameters): the levels as they were. */
void sp_hal_restore(void) {
    State *s = state();
    if (!s || !s->loaded || !s->backed_up) return;
    for (uint32_t i = 0; i < HBYTES; i++)
        if ((&s->h[0][0])[i] != (&s->hb[0][0])[i]) { (&s->h[0][0])[i] = (&s->hb[0][0])[i]; s->dirty = 1; }
}
