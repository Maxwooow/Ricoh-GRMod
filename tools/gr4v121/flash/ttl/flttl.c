/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: pre-flash (TTL) flash metering for the Ricoh GR IV with a GF-2 class flash, firmware 1.20. Second version
 * (after the first round on the camera), with the changes of the later rounds (README.md, "Camera rounds").
 *
 * What the camera does by itself (README.md): the body sets the GF-2's output from the focus distance,
 *   X = Dv + Av - (Sv - 5) + compensation,  A0 = 8 X + 52,  Dv = 2 log2(distance in metres)   (0x5369d7f8, 0x536a59f8).
 * In the two flash modes with red-eye reduction it also fires one small emission (output level 0x40) before the picture.
 *
 * What this adds, only when that pre-emission fires: the live view frame that catches the pre-emission is compared
 * with the frame before it, and the distance term is replaced by what the comparison says.
 *
 *   r   = (flash-lit part of the frame, pre-emission minus before) / (whole frame before), both green block sums less black
 *   Dv' = (P - 52) / 8 + Tv_lv - Ev - log2 r
 *
 * P is the pre-emission's output level, Tv_lv = log2(1 s / live view exposure time), Ev the scene brightness the camera's
 * own live view AE measured (exposure record + 0x140, Bv + 5).  Why: the pre-emission adds r times what the scene gives
 * the live view frame in its exposure time, so by itself it exposes like a scene of Ev + log2 r for that time; the level
 * that exposes the picture correctly follows with the camera's own formula above, and the picture's aperture and ISO, the
 * flash compensation and the ND filter keep working through it.  No constant of this module's own is involved.
 *
 * "The flash-lit part": rows are used only if the pre-emission reached them (the live view sensor reads rows one after
 * another, a short exposure catches the emission in a band); of the blocks in those rows the quarter that gained most
 * counts.  That is the nearest thing in the frame, which is what a flash must not burn out.
 *
 * The result is used only if everything is in order (FLAG bits below); otherwise the camera's distance stays.  It may
 * lower the distance term by at most 6 EV and raise it by at most 2 EV.  Where the camera has no distance (10 m or more;
 * third round: "30 m" with the subject at 0.8 m, ISO 10000, 4 EV less was still some 6 EV too much) there is no lower limit.
 *
 * The frame's raw block sums (result at data set + 8, pointer at + 0x1400C), as the camera's converter 0x5391ff0c and
 * 0x5368cb78 read them: per row of blocks, `columns` words of block luminance, then per block four words: pixel count,
 * red sum, green sum, blue sum.  Black levels per pixel: four u16 at result + 0x14010.
 *
 * Six hooks call `flttl`:
 *   which 0, a = live view exposure object: after the camera's per-frame live view AE (0x5368bd10).
 *   which 1: right before the pre-emission pulse (0x53797d00).
 *   which 2: the release plan adds its "free live view" step (0x5368808c); returns the step's delay in ms (150 in the
 *            red-eye modes with a GF-2, so that the frame with the pre-emission still arrives).
 *   which 3, a = flash status byte about to be stored (0x53a9ccd4); returns the byte to store ("not ready" while the
 *            GF-2 recharges after the pre-emission is not taken for 600 ms, as in the probe, or the picture's flash is
 *            cancelled).
 *   which 4, a = X (float bits), b = the flash calculation object: after 0x5369d7f8 (called at 0x536a5ad8); returns X.
 *   which 5, a = output level about to be put into the flash data, b = flash state (0xA = red-eye pre-emission), at
 *            0x536a5f6c; returns the level.  The pre-emission is set to what the camera's own formula gives for the
 *            focus distance at the live view's sensitivity, half an EV less, so that the live view frame does not clip.
 * More than 0.8 s after a pre-emission the first frame hook writes the shot's numbers (struct log) to "C:\FTxxxxxx.BIN".
 *
 * Soft float, position independent, no data sections, no library calls; `flttl` at offset 0.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;
typedef unsigned long long u64;
#ifdef FLTTL_HOST /* host test build: pointers are 8 bytes; pointer fields sit at twice the camera's offsets */
typedef unsigned long uptr;
#define P(o) (2 * (o))
#define RAW_POINTER 0x14010
#define BLACKS 0x14020
#else
typedef u32 uptr;
#define P(o) (o)
#define RAW_POINTER 0x1400c
#define BLACKS 0x14010
#endif

struct ctx {
    uptr magic;
    uptr *slot;                             /* RAM word, zero at start-up */
    void *(*alloc)(u32);                    /* operator new */
    u8 *(*timer_holder)(void);              /* + 0xC: elapsed timer */
    u32 (*tick)(void *);                    /* raw count of the timer */
    u32 (*elapsed)(void *, u32, u32, u32);  /* (timer, earlier, later, 0) -> microseconds */
    u8 *(*flash_holder)(void);              /* + 0x10: flash data manager */
    u8 *(*file_holder)(void);               /* + 0x14: file service */
    u8 *(*ae_holder)(void);                 /* + 8: exposure record */
    u8 *(*settings_holder)(void);           /* + 4: shooting settings */
    u32 (*flash_mode)(void *);              /* of the settings: 1 and 3 are the modes with red-eye reduction */
};

#define VERSION 9
#define LOG_MAGIC 0x4c545247u /* "GRTL" */
#define MAX_BLOCKS 4096u
#define MAX_ROWS 128u
#define BANDS 8
#define BINS 32
#define HOLD_READY_US 600000u
#define FREE_DELAY_MS 150
#define MEASURE_US 140000u     /* frames this long after the pulse are looked at */
#define PRE_AGE_US 100000u     /* the frame before must be this recent */
#define USE_US 1200000u        /* the result is used this long after the pulse (the picture's flash data is filled well within) */
#define LOWER_Q8 (6 * 256)     /* limits against the camera's distance term */
#define FAR_Q8 1700            /* the camera's distance term from here (10 m) is no measure: no lower limit */
#define FAR_MM 20000u          /* a focus distance beyond this is "none" (the camera gave 0x1FFFFFE2 mm, 30 m as the term) */
#define UNKNOWN_MM 2000u       /* the pre-emission level is then made for this distance */
#define RAISE_Q8 (2 * 256)
#define BIAS_Q8 0              /* added to the result; for tuning */
#define PRE_LEVEL 0x40
#define PRE_MIN 20             /* weakest pre-emission asked for.  8 was too weak to be seen when the focus distance was wrong
                                  (fourth round: 87 mm); 18 to 23 measured right at 0.3 to 0.6 m */
#define PRE_HEADROOM 4         /* in output steps of 1/8 EV: below "correctly exposed at the focus distance" */
#define FULL 2976u             /* a block counts as clipped from this green mean above black: 3/4 of 3969, the largest block mean the
                                  camera's frames showed (the first version's 2176 called half of all blocks clipped) */
#define GRID 8

#define F_PRE 0x001u          /* a frame before the pulse was there */
#define F_MEASURED 0x002u     /* a frame after the pulse was compared */
#define F_VALID 0x004u        /* the comparison gave a usable Dv */
#define F_APPLIED 0x008u      /* X was changed */
#define F_SATURATED 0x010u    /* more than a quarter of the counted blocks were clipped: 1 EV taken off */
#define F_EXPOSURE 0x020u     /* live view exposure time differed between the two frames, or the gain by more than a quarter */
#define F_NO_RESPONSE 0x040u  /* the pre-emission added less than 1/8 of the scene (counted blocks, or all blocks of the lit rows),
                                 or reached less than an eighth of the rows */
#define F_SHORT 0x080u        /* live view exposure time out of 2..200 ms */
#define F_EV 0x100u           /* scene Ev out of -3..18 */
#define F_LOWER 0x200u        /* limited: lowered by 6 EV */
#define F_RAISE 0x400u        /* limited: raised by 2 EV */
#define F_OLD_PRE 0x800u      /* the frame before the pulse was older than 100 ms */
#define F_EMPTY 0x1000u       /* a sum was zero */
#define F_AFTER 0x4000u       /* compared with a frame after the pre-emission (the frame before was old, or exposed differently) */
#define F_FAR 0x2000u         /* the camera had no usable distance (10 m or more): the measurement is taken without a lower limit */

struct log {
    u32 magic, version, size;
    u32 pulses, files, applied;
    u32 pulse_tick, pulse_to_write_us;
    u32 flags;
    u32 pre_level;                  /* as put into the flash data (before the accessory side's own correction) */
    u32 pre_sent;                   /* flash data manager + 0x84 at the pulse */
    u32 distance_mm;
    u32 columns, rows, count0;      /* count0: pixel count of the first block */
    u32 black;                      /* green black level used, per pixel */
    u32 blacks[2];                  /* the four u16 as stored */
    u32 pre_t_us, pre_gain, fl_t_us, fl_gain, base_gain;
    u32 pre_age_us, fl_after_us, frames_after;
    u32 n_all, n_lit, f_n, saturated;
    u32 a_sum[2], f_sum[2], fl_total[2]; /* low, high */
    u32 max_gain, max_green;        /* largest block gain; largest block green sum (with black) in the flash frame */
    u32 ev_bits, rec64_bits, av_lv_bits, bv_set_bits;
    s32 tv_q8, ev_q8, lr_q8, dv_q8, dv_stock_q8, delta_q8;
    u32 x_in_bits, x_out_bits;
    u32 band_pre[BANDS], band_fl[BANDS]; /* green less black, >> 8, per eighth of the rows */
    u8 flash_at_pulse[32], flash_at_write[32]; /* flash data manager + 0x6C.. */
    u32 record[8];
    u32 held, held_first_us;
    /* version 6 */
    u32 l_sum[2];                   /* gain of all blocks in the lit rows (f_sum is its largest quarter) */
    s32 pre_x_q8;                   /* X the pre-emission level was made from; 0 = by the distance steps */
    u16 grid_pre[GRID * GRID], grid_fl[GRID * GRID]; /* green less black per cell of the frame, >> 13: before, with the pre-emission */
    /* version 9 */
    u32 x_after_us;                 /* the first time X was asked for after the pulse */
    u32 ref_after_us;               /* F_AFTER: when the frame compared with came */
};

struct state {
    struct log log;
    u32 pending;       /* a pre-emission fired and its file is not written yet */
    u32 pre_cmd;       /* pre-emission level chosen by hook 5 for this shot, 0 = none */
    u32 have_pre, pre_tick, pre_t_us, pre_gain, pre_base, pre_av_bits, pre_columns, pre_rows;
    s32 pre_x_q8;
    u32 pre_sum[2];
    u32 best[2];       /* largest whole-frame green of the frames after the pulse */
    u32 fl_index, fl_columns, fl_rows, after_done;
    u32 row_gain[MAX_ROWS], count[BINS], clipped[BINS], sum_lo[BINS], sum_hi[BINS], band_pre[BANDS], band_fl[BANDS]; /* scratch */
    u32 cell_pre[GRID * GRID], cell_fl[GRID * GRID];
    u32 pre[MAX_BLOCKS];
    u32 fl[MAX_BLOCKS]; /* the frame with the pre-emission: green less black, bit 31 = clipped */
};

#ifdef LOG_BYTES
typedef char log_size_is_as_generated[sizeof(struct log) == LOG_BYTES ? 1 : -1];
#endif

static u32 rd32(const u8 *p, u32 o) { return *(const u32 *)(p + o); }
static u8 *rdp(const u8 *p, u32 o) { return (u8 *)*(const uptr *)(p + o); }
static void copy(u8 *d, const u8 *s, u32 n) { while (n--) *d++ = *s++; }
static u32 clz32(u32 x) { return (u32)__builtin_clz(x); }

/* log2(value) in 1/256; value = hi : lo, 0 gives 0 */
static s32 log2q8(u32 hi, u32 lo)
{
    u32 m, z, frac = 0, i;
    s32 n;
    if (hi) {
        z = clz32(hi);
        n = 63 - (s32)z;
        m = z ? (hi << z) | (lo >> (32 - z)) : hi;
    } else {
        if (!lo) return 0;
        z = clz32(lo);
        n = 31 - (s32)z;
        m = lo << z;
    }
    for (i = 0; i < 8; i++) { /* m is 1.x in Q31; square it, a bit of the fraction per step */
        u64 sq = (u64)m * m;
        if (sq >> 63) {
            frac = frac << 1 | 1;
            m = (u32)(sq >> 32);
        } else {
            frac <<= 1;
            m = (u32)(sq >> 31);
        }
    }
    return n * 256 + (s32)frac;
}

/* n / d, d not 0 (no library, and no divide instruction assumed) */
static u32 udiv(u32 n, u32 d)
{
    u32 q = 0, r = 0, i;
    for (i = 32; i-- > 0;) {
        r = r << 1 | ((n >> i) & 1u);
        if (r >= d) {
            r -= d;
            q |= 1u << i;
        }
    }
    return q;
}

/* IEEE single -> value * 256, rounded toward zero, saturated */
static s32 f2q8(u32 b)
{
    u32 e = (b >> 23) & 255, m = (b & 0x7fffffu) | 0x800000u;
    s32 shift = (s32)e - 142, v;
    if (e == 0) return 0;
    if (shift > 7) v = 0x7fffffff;
    else if (shift >= 0) v = (s32)(m << shift);
    else if (shift > -32) v = (s32)(m >> -shift);
    else v = 0;
    return b >> 31 ? -v : v;
}

/* value / 256 -> IEEE single */
static u32 q8tof(s32 q)
{
    u32 a = q < 0 ? (u32)-q : (u32)q, n, m;
    if (!a) return 0;
    n = 31 - clz32(a);
    m = n <= 23 ? a << (23 - n) : a >> (n - 23);
    return (q < 0 ? 0x80000000u : 0) | (n + 119) << 23 | (m & 0x7fffffu);
}

static void save(const struct ctx *c, struct state *s, u8 *timer, u32 now)
{
    char name[16];
    u32 i, v, handle = 0;
    u8 *fs, *record, *holder, *flash;
    struct log *g = &s->log;

    holder = c->flash_holder();
    flash = holder ? rdp(holder, P(0x10)) : 0;
    if (flash) copy(g->flash_at_write, flash + 0x6c, 32);
    holder = c->ae_holder();
    record = holder ? rdp(holder, P(8)) : 0;
    if (record) {
        g->record[0] = rd32(record, 0xd0); /* Tv, Av, Sv of the picture */
        g->record[1] = rd32(record, 0xd4);
        g->record[2] = rd32(record, 0xd8);
        g->record[3] = rd32(record, 0xe4); /* flash compensation term */
        g->record[4] = rd32(record, 0x84); /* the camera's distance term */
        g->record[5] = rd32(record, 0x140);
        g->record[6] = rd32(record, 0x584);
        g->record[7] = (u32)record[0xba] | (u32) * (u16 *)(record + 0x3e) << 16;
    }
    g->pulse_to_write_us = c->elapsed(timer, g->pulse_tick, now, 0);

    name[0] = 'C'; name[1] = ':'; name[2] = '\\'; name[3] = 'F'; name[4] = 'T';
    v = g->pulse_tick >> 8;
    for (i = 0; i < 6; i++) {
        u32 d = (v >> (20 - 4 * i)) & 15;
        name[5 + i] = (char)(d < 10 ? '0' + d : 'A' + d - 10);
    }
    name[11] = '.'; name[12] = 'B'; name[13] = 'I'; name[14] = 'N'; name[15] = 0;

    holder = c->file_holder();
    fs = holder ? rdp(holder, P(0x14)) : 0;
    if (!fs) return;
    {
        const u8 *vt = rdp(fs, 0);
        u32 (*open)(u8 *, const char *, u32, u32 *, u32) = (u32 (*)(u8 *, const char *, u32, u32 *, u32))rdp(vt, P(0x20));
        u32 (*write)(u8 *, u32, const void *, u32, u32) = (u32 (*)(u8 *, u32, const void *, u32, u32))rdp(vt, P(0x2c));
        u32 (*close)(u8 *, u32, u32) = (u32 (*)(u8 *, u32, u32))rdp(vt, P(0x24));
        if (!open(fs, name, 0, &handle, 0)) return;
        write(fs, handle, g, sizeof *g, 0);
        close(fs, handle, 0);
        g->files++;
    }
}

/* green sum of a block less black, never negative */
static u32 green(const u32 *q, u32 black)
{
    u32 b = black * q[0];
    return q[2] > b ? q[2] - b : 0;
}

/* the frame before the pulse: keep every block's green */
static void keep(struct state *s, const u32 *raw, u32 columns, u32 rows, u32 black)
{
    u32 row, col, *out = s->pre;
    u64 sum = 0;
    for (row = 0; row < rows; row++) {
        const u32 *q = raw + row * 5 * columns + columns;
        for (col = 0; col < columns; col++, q += 4) {
            u32 g = green(q, black);
            *out++ = g;
            sum += g;
        }
    }
    s->pre_sum[0] = (u32)sum;
    s->pre_sum[1] = (u32)(sum >> 32);
    s->pre_columns = columns;
    s->pre_rows = rows;
}

/* a frame after the pulse: its whole green */
static void frame_total(const u32 *raw, u32 columns, u32 rows, u32 black, u32 *out)
{
    u32 row, col;
    u64 total = 0;
    for (row = 0; row < rows; row++) {
        const u32 *q = raw + row * 5 * columns + columns;
        for (col = 0; col < columns; col++, q += 4) total += green(q, black);
    }
    out[0] = (u32)total;
    out[1] = (u32)(total >> 32);
}

/* the frame with the pre-emission: keep every block's green, and whether the block is clipped */
static void take(struct state *s, const u32 *raw, u32 columns, u32 rows, u32 black, u32 full)
{
    u32 row, col, *out = s->fl, max_green = 0;
    for (row = 0; row < rows; row++) {
        const u32 *q = raw + row * 5 * columns + columns;
        for (col = 0; col < columns; col++, q += 4) {
            u32 v = green(q, black) & 0x7fffffffu;
            if (q[0] && q[2] >= full * q[0]) v |= 0x80000000u;
            if (q[2] > max_green) max_green = q[2];
            *out++ = v;
        }
    }
    s->fl_columns = columns;
    s->fl_rows = rows;
    s->log.max_green = max_green;
}

/* compare the frame with the pre-emission (s->fl) with the one without (s->pre) */
static void measure(struct state *s, u32 flags, u32 ev_bits)
{
    struct log *g = &s->log;
    u32 *row_gain = s->row_gain, *count = s->count, *clipped = s->clipped, *sum_lo = s->sum_lo, *sum_hi = s->sum_hi;
    u32 columns = s->fl_columns, rows = s->fl_rows, t_us = g->fl_t_us, gain = g->fl_gain;
    u32 row, col, band, acc, i, max_gain = 0, max_row = 0, shift, limit, n_lit = 0, f_n = 0, sat = 0, dg, top, lit_gain = 0;
    const u32 *pre = s->pre, *fl = s->fl;
    u64 f_sum = 0, l_sum = 0;
    s32 tv, ev, lr, lr_all, dv;

    for (band = 0; band < BANDS; band++) g->band_pre[band] = g->band_fl[band] = 0;
    for (i = 0; i < GRID * GRID; i++) s->cell_pre[i] = s->cell_fl[i] = 0;
    band = 0;
    acc = 0;
    for (row = 0; row < rows; row++) {
        u32 rg = 0, bp = 0, bf = 0, cell = band * GRID, cacc = 0;
        for (col = 0; col < columns; col++, pre++, fl++) {
            u32 v = *fl & 0x7fffffffu, d = v > *pre ? v - *pre : 0;
            s->cell_pre[cell] += *pre >> 4;
            s->cell_fl[cell] += v >> 4;
            cacc += GRID;
            while (cacc >= columns && cell < band * GRID + GRID - 1) {
                cacc -= columns;
                cell++;
            }
            rg += d >> 6;
            if (d > max_gain) max_gain = d;
            bp += *pre >> 8;
            bf += v >> 8;
        }
        row_gain[row] = rg;
        if (rg > max_row) max_row = rg;
        g->band_pre[band] += bp;
        g->band_fl[band] += bf;
        acc += BANDS;
        while (acc >= rows && band < BANDS - 1) {
            acc -= rows;
            band++;
        }
    }
    for (i = 0; i < GRID * GRID; i++) {
        u32 x = s->cell_pre[i] >> 9, y = s->cell_fl[i] >> 9;
        g->grid_pre[i] = (u16)(x > 0xffffu ? 0xffffu : x);
        g->grid_fl[i] = (u16)(y > 0xffffu ? 0xffffu : y);
    }

    /* the quarter of the blocks in the lit rows that gained most */
    for (i = 0; i < BINS; i++) count[i] = clipped[i] = sum_lo[i] = sum_hi[i] = 0;
    limit = max_row >> 2;
    /* The bins span 0 .. 8 x the mean gain of the lit rows (or the largest gain, if that is less); what gains more shares
       the top bin.  Spanning 0 .. the largest gain, as before, put nearly every block into bin 0 whenever one block
       (a moving edge at a bright window, a reflection) gained far more than the rest: the "quarter" became all blocks. */
    for (row = 0; row < rows; row++)
        if (max_row && row_gain[row] >= limit) {
            lit_gain += row_gain[row];
            n_lit += columns;
        }
    top = n_lit ? udiv(lit_gain, n_lit) << 9 : 0; /* row_gain is in 1/64 */
    if (!top || top > max_gain) top = max_gain;
    shift = top >> 5 ? 27 - clz32(top) : 0; /* top >> shift < 32 */
    n_lit = 0;
    pre = s->pre;
    fl = s->fl;
    for (row = 0; row < rows; row++, pre += columns, fl += columns) {
        if (row_gain[row] < limit || !max_row) continue;
        n_lit += columns;
        for (col = 0; col < columns; col++) {
            u32 v = fl[col] & 0x7fffffffu, d = v > pre[col] ? v - pre[col] : 0, bin = d >> shift, lo;
            if (bin >= BINS) bin = BINS - 1;
            count[bin]++;
            l_sum += d;
            lo = sum_lo[bin] + d;
            if (lo < d) sum_hi[bin]++;
            sum_lo[bin] = lo;
            if (fl[col] >> 31) clipped[bin]++;
        }
    }
    for (i = BINS; i-- > 0;) {
        if (!count[i]) continue;
        f_n += count[i];
        sat += clipped[i];
        f_sum += (u64)sum_hi[i] << 32 | sum_lo[i];
        if (f_n >= n_lit >> 2) break;
    }

    g->columns = columns;
    g->rows = rows;
    g->pre_t_us = s->pre_t_us;
    g->pre_gain = s->pre_gain;
    g->n_all = columns * rows;
    g->n_lit = n_lit;
    g->f_n = f_n;
    g->saturated = sat;
    g->a_sum[0] = s->pre_sum[0];
    g->a_sum[1] = s->pre_sum[1];
    g->f_sum[0] = (u32)f_sum;
    g->f_sum[1] = (u32)(f_sum >> 32);
    g->fl_total[0] = s->best[0];
    g->fl_total[1] = s->best[1];
    g->l_sum[0] = (u32)l_sum;
    g->l_sum[1] = (u32)(l_sum >> 32);
    g->pre_x_q8 = s->pre_x_q8;
    g->max_gain = max_gain;
    g->ev_bits = ev_bits;

    tv = log2q8(0, 1000000u) - log2q8(0, t_us);
    ev = f2q8(ev_bits);
    lr = log2q8(g->f_sum[1], g->f_sum[0]) - log2q8(0, f_n) - log2q8(g->a_sum[1], g->a_sum[0]) + log2q8(0, g->n_all);
    dv = ((s32)g->pre_level - 52) * 32 + tv - ev - lr + BIAS_Q8;
    if (!(flags & F_PRE)) flags |= F_OLD_PRE;
    /* The gain the live view AE trims from frame to frame (a few percent) does not show in the frames compared: rows the
       pre-emission did not reach came out the same to 1 % while the gain differed by 2.6 to 8.6 % (first round, 4 shots). */
    dg = gain > s->pre_gain ? gain - s->pre_gain : s->pre_gain - gain;
    if (t_us != s->pre_t_us || dg > s->pre_gain >> 2) flags |= F_EXPOSURE;
    if (t_us < 2000u || t_us > 200000u) flags |= F_SHORT;
    if (!f_n || !(g->f_sum[0] | g->f_sum[1]) || !(g->a_sum[0] | g->a_sum[1])) flags |= F_EMPTY;
    else {
        /* Twice in the second round a frame without the pre-emission passed on the noise of a few blocks (moving edges):
           the lit rows as a whole had gained 5 and 10 % of the scene, where frames with the pre-emission showed 16 % and up. */
        lr_all = log2q8(g->l_sum[1], g->l_sum[0]) - log2q8(0, n_lit) - log2q8(g->a_sum[1], g->a_sum[0]) + log2q8(0, g->n_all);
        if (lr < -3 * 256 || lr_all < -3 * 256 || !(g->l_sum[0] | g->l_sum[1]) || n_lit * 8 < g->n_all) flags |= F_NO_RESPONSE;
    }
    if (ev < -3 * 256 || ev > 18 * 256) flags |= F_EV;
    if (sat * 4 > f_n) {
        flags |= F_SATURATED;
        dv -= 256;
    }
    if (!(flags & (F_OLD_PRE | F_EXPOSURE | F_SHORT | F_EMPTY | F_NO_RESPONSE | F_EV)) && (flags & F_PRE)) flags |= F_VALID;
    g->tv_q8 = tv;
    g->ev_q8 = ev;
    g->lr_q8 = lr;
    g->dv_q8 = dv;
    g->flags = flags;
}

u32 flttl(const struct ctx *c, u32 which, uptr a, uptr b)
{
    struct state *s = (struct state *)*c->slot;
    u8 *holder, *flash, *timer, *object, *set, *result, *lvx, *record;
    const u32 *raw;
    u32 now, columns, rows, black, full, t_us, gain, i;
    struct log *g;

    holder = c->timer_holder();
    timer = holder ? rdp(holder, P(0xc)) : 0;
    if (!timer) return which == 3 ? (u32)a & 255u : which == 4 || which == 5 ? (u32)a : 0;
    holder = c->flash_holder();
    flash = holder ? rdp(holder, P(0x10)) : 0;

    if (which == 2) { /* the delay of the release plan's "free live view" step */
        u8 *settings;
        u32 mode;
        if (!flash || flash[0x14] != 0x10) return 0;
        holder = c->settings_holder();
        settings = holder ? rdp(holder, P(4)) : 0;
        if (!settings) return 0;
        mode = c->flash_mode(settings);
        return mode == 1 || mode == 3 ? FREE_DELAY_MS : 0;
    }
    if (which == 3) { /* the flash's status byte, about to be stored */
        u32 status = (u32)a & 255u, after;
        if (!s || !s->pending || !flash || (status & 1) || !(flash[0x77] & 1)) return status;
        after = c->elapsed(timer, s->log.pulse_tick, c->tick(timer), 0);
        if (after >= HOLD_READY_US) return status;
        if (!s->log.held++) s->log.held_first_us = after;
        return status | 1;
    }
    if (which == 5) { /* output level going into the flash data; b = flash state */
        u32 level = (u32)a, mm;
        if ((u32)b != 0xa || level != PRE_LEVEL || !s || s->pending || !flash || flash[0x14] != 0x10) return level;
        holder = c->ae_holder();
        record = holder ? rdp(holder, P(8)) : 0;
        mm = record ? rd32(record, 0x584) : 0;
        if (mm > FAR_MM) mm = UNKNOWN_MM;
        s->pre_x_q8 = 0;
        if (mm && s->have_pre && s->pre_gain && s->pre_base && f2q8(s->pre_av_bits) > 0 && f2q8(s->pre_av_bits) < 10 * 256) {
            /* the camera's formula for the focus distance, with the live view's sensitivity in place of the picture's */
            s32 x = 2 * (log2q8(0, mm) - log2q8(0, 1000u)) + f2q8(s->pre_av_bits) - (log2q8(0, s->pre_gain) - log2q8(0, s->pre_base));
            s32 p = 52 - PRE_HEADROOM + (s32)((u32)(x + 0x40000) >> 5) - 0x2000;
            level = p < PRE_MIN ? PRE_MIN : p > PRE_LEVEL ? PRE_LEVEL : (u32)p;
            s->pre_x_q8 = x ? x : 1;
        } else if (mm && mm < 450u) level = PRE_LEVEL - 24; /* no live view frame yet: by distance, 3 EV less */
        else if (mm && mm < 800u) level = PRE_LEVEL - 16;
        else if (mm && mm < 1500u) level = PRE_LEVEL - 8;
        s->pre_cmd = level;
        return level;
    }
    if (which == 4) { /* X of the flash level formula; b = the calculation object, + 0x18: exposure record */
        u32 x = (u32)a, mm;
        s32 stock, delta;
        u32 since;
        if (!s || !s->pending || !b || !flash || flash[0x14] != 0x10) return x;
        g = &s->log;
        since = c->elapsed(timer, g->pulse_tick, c->tick(timer), 0);
        if (!g->x_after_us) g->x_after_us = since ? since : 1;
        if (!(g->flags & F_VALID)) return x;
        if (since > USE_US) return x;
        record = rdp((const u8 *)b, P(0x18));
        if (!record) return x;
        stock = f2q8(rd32(record, 0x84));
        delta = g->dv_q8 - stock;
        g->flags &= ~(F_LOWER | F_RAISE | F_FAR);
        mm = rd32(record, 0x584);
        if (stock >= FAR_Q8 || !mm || mm > FAR_MM) g->flags |= F_FAR;
        else if (delta < -LOWER_Q8) {
            delta = -LOWER_Q8;
            g->flags |= F_LOWER;
        }
        if (delta > RAISE_Q8) {
            delta = RAISE_Q8;
            g->flags |= F_RAISE;
        }
        g->dv_stock_q8 = stock;
        g->delta_q8 = delta;
        g->x_in_bits = x;
        g->x_out_bits = q8tof(f2q8(x) + delta);
        if (!(g->flags & F_APPLIED)) g->applied++;
        g->flags |= F_APPLIED;
        return g->x_out_bits;
    }
    if (which == 1) { /* the pre-emission is about to fire */
        if (!s || s->pending) return 0;
        g = &s->log;
        if (flash) copy(g->flash_at_pulse, flash + 0x6c, 32);
        g->pulse_tick = c->tick(timer);
        g->pre_level = s->pre_cmd ? s->pre_cmd : flash ? flash[0x6c] : PRE_LEVEL;
        g->pre_sent = flash ? flash[0x84] : 0;
        g->flags = 0;
        if (s->have_pre) {
            g->flags = F_PRE;
            if (c->elapsed(timer, s->pre_tick, g->pulse_tick, 0) > PRE_AGE_US) g->flags |= F_OLD_PRE;
        }
        g->frames_after = 0;
        g->held = 0;
        g->held_first_us = 0;
        g->x_in_bits = g->x_out_bits = 0;
        g->dv_stock_q8 = g->delta_q8 = 0;
        g->x_after_us = g->ref_after_us = 0;
        s->after_done = 0;
        s->best[0] = s->best[1] = 0;
        g->pulses++;
        s->pending = 1;
        return 0;
    }
    if (which != 0 || !a) return 0;
    if (!flash || flash[0x14] != 0x10) return 0; /* no GF-2 class flash */
    object = (u8 *)a;
    if (!s) {
        s = (struct state *)c->alloc(sizeof *s);
        if (!s) return 0;
        for (i = 0; i < sizeof *s; i++) ((u8 *)s)[i] = 0;
        s->log.magic = LOG_MAGIC;
        s->log.version = VERSION;
        s->log.size = sizeof s->log;
        *c->slot = (uptr)s;
    }
    g = &s->log;
    now = c->tick(timer);
    if (s->pending && c->elapsed(timer, g->pulse_tick, now, 0) > 800000u) {
        save(c, s, timer, now);
        s->pending = 0;
        s->pre_cmd = 0;
        s->have_pre = 0;
    }

    set = rdp(object, P(8));
    result = set ? rdp(set, P(8)) : 0; /* the result the camera's per-frame AE itself reads (0x5368cb78) */
    lvx = rdp(object, P(0x1474));      /* live view exposure as set: + 0xA0 time in microseconds, + 0x9C gain */
    if (!result || !lvx) return 0;
    columns = *(u16 *)result;
    rows = *(u16 *)(result + 2);
    raw = (const u32 *)rdp(result, RAW_POINTER);
    if (!columns || !rows || rows > MAX_ROWS || columns * rows > MAX_BLOCKS || !raw || ((uptr)raw & 3)) return 0;
    black = ((u32) * (u16 *)(result + BLACKS + 2) + *(u16 *)(result + BLACKS + 4)) >> 1;
    full = black + FULL;
    t_us = rd32(lvx, 0xa0);
    gain = rd32(lvx, 0x9c);

    if (!s->pending) {
        u8 *settings;
        u32 mode;
        holder = c->settings_holder();
        settings = holder ? rdp(holder, P(4)) : 0;
        mode = settings ? c->flash_mode(settings) : 0;
        if (mode != 1 && mode != 3) { /* no pre-emission in the other flash modes: nothing to keep */
            s->have_pre = 0;
            return 0;
        }
        keep(s, raw, columns, rows, black);
        s->have_pre = 1;
        s->pre_tick = now;
        s->pre_t_us = t_us;
        s->pre_gain = gain;
        s->pre_base = rd32(set, P(0x94));
        s->pre_av_bits = rd32(object, P(0x1488));
        return 0;
    }
    {
        u32 after = c->elapsed(timer, g->pulse_tick, now, 0), total[2], index, ev_bits;
        if (after > MEASURE_US) return 0;
        if ((g->flags & F_MEASURED) ? columns != s->fl_columns || rows != s->fl_rows : s->have_pre && (columns != s->pre_columns || rows != s->pre_rows)) return 0;
        holder = c->ae_holder();
        record = holder ? rdp(holder, P(8)) : 0;
        ev_bits = record ? rd32(record, 0x140) : 0;
        frame_total(raw, columns, rows, black, total);
        index = g->frames_after++;
        if (!(g->flags & F_MEASURED) || total[1] > s->best[1] || (total[1] == s->best[1] && total[0] > s->best[0])) {
            /* the frame with the most light so far: it is the one with the pre-emission */
            take(s, raw, columns, rows, black, full);
            s->best[0] = total[0];
            s->best[1] = total[1];
            s->fl_index = index;
            s->after_done = 0;
            g->count0 = raw[columns];
            g->black = black;
            g->blacks[0] = rd32(result, BLACKS);
            g->blacks[1] = rd32(result, BLACKS + 4);
            g->base_gain = rd32(set, P(0x94));
            g->distance_mm = record ? rd32(record, 0x584) : 0;
            g->rec64_bits = record ? rd32(record, 0x64) : 0;
            g->av_lv_bits = rd32(object, P(0x1488));
            g->bv_set_bits = rd32(set, P(0x12c));
            g->fl_t_us = t_us;
            g->fl_gain = gain;
            g->fl_after_us = after;
            g->pre_age_us = s->have_pre ? c->elapsed(timer, s->pre_tick, g->pulse_tick, 0) : 0;
            if (s->have_pre) measure(s, (g->flags & (F_PRE | F_OLD_PRE)) | F_MEASURED, ev_bits);
            else g->flags = F_MEASURED | F_OLD_PRE;
        } else if (!s->after_done && index >= s->fl_index + 2 && !(g->flags & F_VALID) && (g->flags & (F_OLD_PRE | F_EXPOSURE))) {
            /* The frame before the pulse is old (the camera's per-frame AE did not run for a while before the release:
               6 of 22 shots in the fourth round) or was exposed differently.  This frame, the second after the one with
               the pre-emission, has none of its light in any row and serves as well. */
            keep(s, raw, columns, rows, black);
            s->pre_t_us = t_us;
            s->pre_gain = gain;
            s->after_done = 1;
            g->ref_after_us = after;
            measure(s, F_PRE | F_MEASURED | F_AFTER, ev_bits);
        }
    }
    return 0;
}
