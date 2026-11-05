// SPDX-License-Identifier: GPL-2.0-only
/* GR III 2.10 / GR IIIx 1.60: own adjustment parameters for the nine added films (looks 64..72).
 *
 * The camera keeps parameters only for its own looks, in the settings record. The films render
 * through Standard (look 11) and use Standard's fields of the active Image Control set (T6c). Here
 * those fields belong, per photo set, to one "owner": the film selected in that set, or else
 * Standard. The other owners' values wait in a table, saved as its own record (HTData 12):
 *   - before a set's look is changed (the firmware's own setter then writes the look and pushes
 *     the whole record to the live parameters), the old owner's values move from the fields to
 *     the table and the new owner's values from the table to the fields;
 *   - everything else (the parameter screen, the setters, development) is the firmware as T6c.
 * The fields always hold the values of the look in use, in the record the firmware saves, so the
 * record and the table cannot disagree about it: a lost table write only loses changes to looks
 * that were not selected. A start without a table gives every look the values the fields hold
 * (the values T6c shared), so the first start of this firmware changes nothing on the camera.
 *
 * GR IV's module (tools/slotparams/slot_params.c) also routed getters and setters; GR III's
 * parameter screen only reads the live values, and its setters act on the selected look of the
 * active set, so this port needs only the look change, the load and the save.
 * Built position independent: tools/gr3x/compile_slots.py. Addresses: GR III 2.10 = IIIx 1.60.
 */
#include <stdint.h>

#define STANDARD 11u
#define FIRST 64u
#define FILMS 9u
#define OWNERS (FILMS + 1u)       /* Standard and the nine films */
#define SETS 3u                   /* photo Image Control sets 0..2 */
#define NP 9u                     /* Standard's parameters */
#define SET_STRIDE 0xe2u
#define LOOK_OF_SET 0x1c2u        /* + 2 * set */
#define REC_ID 12u
#define REC_MAGIC 0x33505247u     /* 'GRP3' */
#define REC_VERSION 1u
#define STATE_MAGIC 0x33534c54u
#define TBYTES (OWNERS * SETS * NP)                 /* 270 */
#define TWORDS ((TBYTES + 3u) / 4u)
#define REC_WORDS (3u + TWORDS + 1u)

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

typedef struct {
    uint32_t magic, loaded, dirty, last_write;
    uint8_t t[OWNERS][SETS][NP];
    uint8_t pad[TWORDS * 4u - TBYTES];
    uint32_t rec[REC_WORDS];
} State;

/* Offset in the settings record of Standard's parameter j in set 0 (value byte; the byte after
 * it is the firmware's own "use the default" flag and is never touched). */
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

/* Owner index of a look: Standard 0, film k (64 + k) k + 1, anything else -1. */
static int owner_of(uint32_t look) {
    if (look == STANDARD) return 0;
    if (look >= FIRST && look < FIRST + FILMS) return (int)(look - FIRST + 1u);
    return -1;
}

/* Who owns Standard's fields of a set: the film selected there, else Standard. */
static int owner(const uint8_t *rec, uint32_t set) {
    int o = owner_of(rec[LOOK_OF_SET + 2u * set]);
    return o < 0 ? 0 : o;
}

/* Hook at the entry of the firmware's "look of photo set n" setter, before it runs. */
void sp_style(uint8_t *ud, uint32_t look, uint32_t set) {
    State *s = state();
    uint8_t *rec = record_of(ud);
    if (!s || !s->loaded || !rec || set >= SETS) return;
    int from = owner(rec, set), to = owner_of(look);
    if (to < 0) to = 0;
    if (from == to) return;
    volatile uint8_t *f = rec;
    for (uint32_t j = 0; j < NP; j++) s->t[from][set][j] = f[field(j, set)];
    for (uint32_t j = 0; j < NP; j++) f[field(j, set)] = s->t[to][set][j];
    s->dirty = 1;
}

static uint32_t checksum(const uint32_t *w, uint32_t n) {
    uint32_t sum = 0x6a09e667u;
    for (uint32_t i = 0; i < n; i++) sum = (sum ^ w[i]) * 0x01000193u + i;
    return sum;
}

static void copy_bytes(volatile uint8_t *d, const volatile uint8_t *src, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) d[i] = src[i];
}

static int read_record(State *s) {
    void *st = ht_store();
    if (!st) return 0;
    if (store_size(st, REC_ID) != REC_WORDS * 4u) return 0;
    if (!store_read(st, REC_ID, REC_WORDS * 4u, s->rec)) return 0;
    if (s->rec[0] != REC_MAGIC || s->rec[1] != REC_VERSION || s->rec[2] != TBYTES) return 0;
    if (s->rec[REC_WORDS - 1u] != checksum(s->rec, REC_WORDS - 1u)) return 0;
    const volatile uint8_t *b = (const volatile uint8_t *)&s->rec[3];
    for (uint32_t i = 0; i < TBYTES; i++) if (b[i] > 0x20u) return 0;
    copy_bytes(&s->t[0][0][0], b, TBYTES);
    return 1;
}

static void write_record(State *s) {
    void *st = ht_store();
    if (!st) return;
    s->rec[0] = REC_MAGIC; s->rec[1] = REC_VERSION; s->rec[2] = TBYTES;
    for (uint32_t i = 3; i < REC_WORDS - 1u; i++) s->rec[i] = 0;
    copy_bytes((volatile uint8_t *)&s->rec[3], &s->t[0][0][0], TBYTES);
    s->rec[REC_WORDS - 1u] = checksum(s->rec, REC_WORDS - 1u);
    s->last_write = store_write(st, REC_ID, REC_WORDS * 4u, s->rec) ? 1u : 2u;
    if (s->last_write == 1u) s->dirty = 0;
}

/* After the firmware's settings load (once, at start, in the settings object's constructor).
 * Calls only the store and the allocator: nothing here may ask for the settings object. */
void sp_after_load(uint8_t *ud) {
    uint8_t *rec = record_of(ud);
    if (state() || !rec) return;
    State *s = (State *)heap_alloc(sizeof(State));
    if (!s) return;
    for (uint32_t i = 0; i < sizeof(State) / 4u; i++) ((volatile uint32_t *)s)[i] = 0;
    if (!read_record(s)) {
        volatile uint8_t *f = rec;
        for (uint32_t set = 0; set < SETS; set++)
            for (uint32_t o = 0; o < OWNERS; o++)
                for (uint32_t j = 0; j < NP; j++) s->t[o][set][j] = f[field(j, set)];
        s->dirty = 1;
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
