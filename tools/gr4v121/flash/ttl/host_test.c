/* SPDX-License-Identifier: GPL-2.0-only
 * Host test of flttl.c's logic (64-bit build, -DFLTTL_HOST: pointer fields at twice the camera's offsets).
 * cc -O1 -DFLTTL_HOST -Wall -o host_test host_test.c -lm && ./host_test [LOGS.bin]
 * Plays five shots (see `shots`) on a 16 x 16 block grid and checks every result against a plain floating point
 * calculation of the same definition; the five logs, as they went to the card, are written to LOGS.bin for test_arm.py
 * to compare with the ARM build byte for byte. Then the same five shots on the camera's 64 x 64 grid. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "flttl.c"

static u32 now_us, allocs, opens, writes, closes;
static struct log written;
static char written_name[32];
static u8 timer[16], timer_holder_obj[64], flash_obj[0x100], flash_holder_obj[64], record[0x600], ae_holder_obj[64];
static u8 fs_obj[16], file_holder_obj[64], vt[0x100];
static u8 *result, set[0x300], object[0x2a00], lvx[0x100], calc[0x40], settings_holder_obj[64], settings_obj[8];
static u32 rawdata[64 * 64 * 5], flash_mode_now;
static u8 *t_settings_holder(void) { return settings_holder_obj; }
static u32 t_flash_mode(void *s) { return s == settings_obj ? flash_mode_now : 99; }
static void *t_alloc(u32 n) { allocs++; void *p = malloc(n); memset(p, 0xaa, n); return p; }
static u8 *t_timer_holder(void) { return timer_holder_obj; }
static u32 t_tick(void *t) { (void)t; return 0x80000000u - now_us * 27u; }                  /* a down counter, 27 per microsecond */
static u32 t_elapsed(void *t, u32 a, u32 b, u32 unit) { (void)t; (void)unit; return (a - b) / 27u; }
static u8 *t_flash_holder(void) { return flash_holder_obj; }
static u8 *t_file_holder(void) { return file_holder_obj; }
static u8 *t_ae_holder(void) { return ae_holder_obj; }
static u32 t_open(u8 *fs, const char *name, u32 z, u32 *h, u32 z2) { (void)fs; (void)z; (void)z2; opens++; strcpy(written_name, name); *h = 77; return 1; }
static u32 t_write(u8 *fs, u32 h, const void *b, u32 n, u32 z) { (void)fs; (void)z; if (h == 77 && n == sizeof written) { memcpy(&written, b, n); writes++; } return n; }
static u32 t_close(u8 *fs, u32 h, u32 z) { (void)fs; (void)z; if (h == 77) closes++; return 1; }
#define PUT(base, off, value) (*(uptr *)((u8 *)(base) + (off)) = (uptr)(value))
static int fails;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)
static u32 bits(float f) { u32 b; memcpy(&b, &f, 4); return b; }
static float flt(u32 b) { float f; memcpy(&f, &b, 4); return f; }

/* distance mm, the camera's Dv, scene Ev, live view time, gain, X, what the pre-emission adds (pattern), expected level, flags */
static const struct shot { u32 mm; float dv, ev; u32 t_us, gain; float x; int pattern; u32 level, flags; } shots[5] = {
    {1200, 0.526f, 5.0f, 16000, 4096, 3.0f, 1, 60, F_PRE | F_MEASURED | F_VALID | F_APPLIED},                /* centre quarter lit */
    {400, -2.64f, 6.5f, 8000, 2048, 0.5f, 2, 42, F_PRE | F_MEASURED | F_VALID | F_APPLIED},                  /* a band of rows lit */
    {3000, 3.17f, 4.0f, 16000, 8192, 5.0f, 3, 0x40, F_PRE | F_MEASURED | F_VALID | F_APPLIED | F_SATURATED}, /* centre clipped */
    {2000, 2.0f, 5.0f, 16000, 4096, 4.0f, 4, 0x40, F_PRE | F_MEASURED | F_NO_RESPONSE},                         /* nothing came back */
    {9000, 6.34f, 5.0f, 16000, 4096, 6.5f, 5, 0x40, F_PRE | F_MEASURED | F_VALID | F_APPLIED | F_LOWER},        /* much nearer than focused */
};

/* green per pixel above black */
static u32 pixel(int pattern, int lit, u32 row, u32 col, u32 rows, u32 columns)
{
    u32 v = 200 + (row * 7 + col * 3) % 16;
    int centre = row >= rows / 4 && row < rows * 3 / 4 && col >= columns / 4 && col < columns * 3 / 4;
    if (!lit) return v;
    switch (pattern) {
    case 1: return v + (centre ? 600 : 50);
    case 2: return v + (row >= rows / 4 && row < rows * 5 / 8 ? 400 : 0);
    case 3: return v + (centre ? 3800 : 50);
    case 5: return v + 1500;
    case 4: return v + 5;
    case 6: return v + (row == rows / 2 && col % 5 == 0 ? 3000 : 0);   /* no pre-emission, a few blocks changed a lot */
    case 7: return v + (row < rows / 4 && col % 4 == 0 ? 80 : 0);      /* a quarter of the blocks of some rows, 10 % of the scene over those rows */
    default: return v;
    }
}

static void fill(int pattern, int lit, u32 rows, u32 columns)
{
    u32 row, col;
    for (row = 0; row < rows; row++)
        for (col = 0; col < columns; col++) {
            u32 g = pixel(pattern, lit, row, col, rows, columns), *q = rawdata + row * 5 * columns + columns + 4 * col;
            rawdata[row * 5 * columns + col] = row * col;
            q[0] = 100;
            q[1] = 100 * (256 + g / 2);
            q[2] = 100 * (256 + g);
            q[3] = 100 * (256 + g / 3);
        }
}

static int down(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? 1 : x > y ? -1 : 0; }

/* the definition, in floating point: Dv from the two frames */
static double reference(const struct shot *t, u32 rows, u32 columns, int *clipped)
{
    static double gain[4096];
    double row_gain[64], max_row = 0, a = 0, f = 0, top;
    u32 row, col, n = 0, k, sat = 0;
    for (row = 0; row < rows; row++) {
        row_gain[row] = 0;
        for (col = 0; col < columns; col++) {
            a += pixel(t->pattern, 0, row, col, rows, columns);
            row_gain[row] += pixel(t->pattern, 1, row, col, rows, columns) - pixel(t->pattern, 0, row, col, rows, columns);
        }
        if (row_gain[row] > max_row) max_row = row_gain[row];
    }
    for (row = 0; row < rows; row++)
        if (max_row > 0 && row_gain[row] >= max_row / 4)
            for (col = 0; col < columns; col++) gain[n++] = pixel(t->pattern, 1, row, col, rows, columns) - pixel(t->pattern, 0, row, col, rows, columns);
    qsort(gain, n, sizeof *gain, down);
    k = n / 4 ? n / 4 : 1;
    top = n ? gain[k - 1] : 0;
    for (k = 0; k < n && gain[k] >= top * 0.97; k++) { f += gain[k]; sat += gain[k] + 200 >= 2976; } /* the module takes whole bins */
    *clipped = k && sat * 4 > k;
    if (!k || f <= 0) return 1e9;
    return (t->level - 52.0) / 8 + log2(1e6 / t->t_us) - t->ev - log2((f / k) / (a / (rows * columns))) - (*clipped ? 1 : 0);
}

int main(int argc, char **argv)
{
    uptr slot = 0;
    struct ctx c = {0, &slot, t_alloc, t_timer_holder, t_tick, t_elapsed, t_flash_holder, t_file_holder, t_ae_holder, t_settings_holder, t_flash_mode};
    u32 i, pass, n, applied = 0;
    FILE *out = argc > 1 ? fopen(argv[1], "wb") : 0;

    result = calloc(1, 0x2e030);
    PUT(timer_holder_obj, P(0xc), timer); *(u32 *)(timer + 8) = 0xffffffffu;
    PUT(flash_holder_obj, P(0x10), flash_obj); flash_obj[0x14] = 0x10; for (i = 0; i < 32; i++) flash_obj[0x6c + i] = (u8)(i + 1);
    PUT(ae_holder_obj, P(8), record); *(u16 *)(record + 0x3e) = 0x10;
    PUT(file_holder_obj, P(0x14), fs_obj); PUT(fs_obj, 0, vt);
    PUT(vt, P(0x20), t_open); PUT(vt, P(0x2c), t_write); PUT(vt, P(0x24), t_close);
    PUT(object, P(8), set); PUT(set, P(8), result); PUT(object, P(0x1474), lvx); PUT(calc, P(0x18), record);
    *(u32 *)(object + P(0x1488)) = bits(3.0f); *(u32 *)(set + P(0x94)) = 1024; *(u32 *)(set + P(0x12c)) = bits(0.25f);
    PUT(result, RAW_POINTER, rawdata); PUT(settings_holder_obj, P(4), settings_obj);
    for (i = 0; i < 4; i++) *(u16 *)(result + BLACKS + 2 * i) = 256;

    /* the conversions */
    CHECK(log2q8(0, 1) == 0 && log2q8(0, 2) == 256 && log2q8(0, 1024) == 2560 && log2q8(1, 0) == 32 * 256 && log2q8(0, 0) == 0);
    for (i = 1; i < 2000000u; i += 1 + i / 7) CHECK(abs(log2q8(0, i) - (s32)floor(log2((double)i) * 256)) <= 1);
    for (i = 1; i < 4000; i += 13) CHECK(abs(log2q8(i, 0x80000000u) - (s32)floor(log2((double)i * 4294967296.0 + 2147483648.0) * 256)) <= 1);
    CHECK(f2q8(bits(1.0f)) == 256 && f2q8(bits(-2.5f)) == -640 && f2q8(bits(0.0f)) == 0 && f2q8(bits(1e-9f)) == 0 && f2q8(bits(100.75f)) == 25792 && f2q8(bits(1e12f)) == 0x7fffffff);
    for (i = 0; i < 6000; i++) { s32 q = (s32)i * 37 - 100000; CHECK(flt(q8tof(q)) == q / 256.0f && f2q8(q8tof(q)) == q); }

    flttl(&c, 1, 0, 0);                                             /* a pulse before any frame: no state yet, ignored */
    CHECK(slot == 0 && allocs == 0);
    CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f) && flttl(&c, 5, 0x40, 0xa) == 0x40 && flttl(&c, 3, 0x20, 0) == 0x20);
    flash_obj[0x14] = 0;                                            /* no flash attached: nothing */
    *(u16 *)result = 16; *(u16 *)(result + 2) = 16;
    flttl(&c, 0, (uptr)object, 0);
    CHECK(slot == 0 && allocs == 0);
    flash_obj[0x14] = 0x10;
    for (i = 0; i < 4; i++) {                                       /* the "free live view" delay: only GF-2 and a red-eye mode */
        flash_mode_now = i;
        CHECK(flttl(&c, 2, 0, 0) == (i == 1 || i == 3 ? 150u : 0u));
    }
    flash_obj[0x14] = 2; flash_mode_now = 1;
    CHECK(flttl(&c, 2, 0, 0) == 0);
    flash_obj[0x14] = 0x10;

    flash_mode_now = 0;                                             /* a flash mode without red-eye reduction: frames are not kept */
    *(u32 *)(lvx + 0xa0) = 16000;
    fill(1, 0, 16, 16);
    now_us = 500000; flttl(&c, 0, (uptr)object, 0);
    CHECK(slot != 0 && allocs == 1 && ((struct state *)slot)->have_pre == 0);
    flash_mode_now = 3;
    now_us = 516000; flttl(&c, 0, (uptr)object, 0);
    CHECK(((struct state *)slot)->have_pre == 1);

    for (pass = 0; pass < 2; pass++) {
        u32 rows = pass ? 64 : 16, columns = pass ? 64 : 16;
        *(u16 *)result = (u16)columns; *(u16 *)(result + 2) = (u16)rows;
        for (n = 0; n < 5; n++) {
            const struct shot *t = &shots[n];
            u32 t0 = 1000000u + (pass * 5 + n) * 3000000u, x_out, files = writes;
            int clipped;
            double want, got;
            *(u32 *)(record + 0x584) = t->mm; *(u32 *)(record + 0x84) = bits(t->dv); *(u32 *)(record + 0x140) = bits(t->ev);
            *(u32 *)(record + 0x64) = bits(t->ev + 1); *(u32 *)(lvx + 0xa0) = t->t_us; *(u32 *)(lvx + 0x9c) = t->gain;
            flash_obj[0x77] = 1; flash_obj[0x84] = 0;
            fill(t->pattern, 0, rows, columns);
            now_us = t0; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 16000; flttl(&c, 0, (uptr)object, 0);
            CHECK(slot != 0 && allocs == 1);
            now_us = t0 + 18000;
            CHECK(flttl(&c, 5, 70, 3) == 70 && flttl(&c, 5, 0x30, 0xa) == 0x30);   /* not the pre-emission; not the camera's 0x40 */
            CHECK(flttl(&c, 5, 0x40, 0xa) == t->level);
            flash_obj[0x6c] = (u8)t->level; flash_obj[0x84] = (u8)(t->level - 1);
            CHECK(flttl(&c, 4, bits(t->x), (uptr)calc) == bits(t->x));          /* before the pulse: X as it is */
            now_us = t0 + 20000; flttl(&c, 1, 0, 0);
            now_us = t0 + 30000;
            CHECK(flttl(&c, 3, 0x20, 0) == 0x21 && flttl(&c, 3, 0x21, 0) == 0x21);  /* "not ready" after the pulse is not taken */
            CHECK(flttl(&c, 4, bits(t->x), (uptr)calc) == bits(t->x));          /* nothing measured yet */
            fill(t->pattern, 1, rows, columns);
            now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
            fill(t->pattern, 0, rows, columns);
            now_us = t0 + 48000; flttl(&c, 0, (uptr)object, 0);                 /* the next frame, without: does not replace it */
            now_us = t0 + 200000;
            x_out = flttl(&c, 4, bits(t->x), (uptr)calc);
            CHECK(flttl(&c, 4, bits(t->x), (uptr)calc) == x_out);
            now_us = t0 + 700000;
            CHECK(flttl(&c, 3, 0x20, 0) == 0x20);                               /* 600 ms later it is taken */
            flash_obj[0x6c] = 60;
            now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);               /* live view is back: the file */
            CHECK(writes == files + 1 && opens == writes && closes == writes);
            CHECK(written.magic == LOG_MAGIC && written.version == VERSION && written.size == sizeof written && written.pulses == pass * 5 + n + 1);
            CHECK(written.flags == t->flags);
            CHECK(written.pre_level == t->level && written.pre_sent == t->level - 1 && written.distance_mm == t->mm);
            CHECK(written.columns == columns && written.rows == rows && written.count0 == 100 && written.black == 256);
            CHECK(written.pre_t_us == t->t_us && written.fl_t_us == t->t_us && written.pre_gain == t->gain && written.base_gain == 1024);
            CHECK(written.pre_age_us == 4000 && written.fl_after_us == 12000 && written.frames_after == 2 && written.held == 1 && written.held_first_us == 10000);
            CHECK(written.flash_at_pulse[0] == t->level && written.flash_at_write[0] == 60 && written.ev_bits == bits(t->ev) && written.rec64_bits == bits(t->ev + 1));
            CHECK(written.pulse_to_write_us == 980000 && written.av_lv_bits == bits(3.0f) && written.bv_set_bits == bits(0.25f));
            {   /* version 6: the level's X, the gain of all lit blocks, the 8 x 8 picture of both frames */
                double x = 2 * log2(t->mm / 1000.0) + 3.0 - log2(t->gain / 1024.0), all = 0, cp = 0, cf = 0;
                u32 r, k2, lit0 = t->pattern <= 3 ? rows / 4 : 0, lit1 = t->pattern == 2 ? rows * 5 / 8 : t->pattern <= 3 ? rows * 3 / 4 : rows; /* rows the module takes as lit */
                for (r = lit0; r < lit1; r++)
                    for (k2 = 0; k2 < columns; k2++) all += pixel(t->pattern, 1, r, k2, rows, columns) - pixel(t->pattern, 0, r, k2, rows, columns);
                CHECK(fabs(written.pre_x_q8 / 256.0 - x) < 0.02);
                CHECK(fabs((written.l_sum[0] + 4294967296.0 * written.l_sum[1]) / 100 - all) < 1);
                for (r = rows * 3 / 8; r < rows / 2; r++)                         /* cell (3, 5) */
                    for (k2 = columns * 5 / 8; k2 < columns * 6 / 8; k2++) { cp += pixel(t->pattern, 0, r, k2, rows, columns); cf += pixel(t->pattern, 1, r, k2, rows, columns); }
                CHECK(fabs(written.grid_pre[3 * 8 + 5] - cp * 100 / 8192) < 2 && fabs(written.grid_fl[3 * 8 + 5] - cf * 100 / 8192) < 2);
            }
            want = reference(t, rows, columns, &clipped);
            got = written.dv_q8 / 256.0;
            if (t->flags & F_VALID) {
                double delta = want - t->dv;
                CHECK(fabs(got - want) < 0.03);
                CHECK(!!(t->flags & F_SATURATED) == clipped);
                if (delta < -6) delta = -6;
                if (delta > 2) delta = 2;
                CHECK(fabs(flt(x_out) - (t->x + delta)) < 0.03);
                CHECK(written.x_in_bits == bits(t->x) && written.x_out_bits == x_out && written.applied == ++applied);
                CHECK(!!(t->flags & F_LOWER) == (want - t->dv < -6));
            } else {
                CHECK(x_out == bits(t->x) && written.x_out_bits == 0);
            }
            printf("%ux%u shot %u: flags %03x, pre level %u, Dv %.3f (plain calculation %.3f, camera's %.3f), X %.3f -> %.3f\n", columns, rows, n + 1,
                   written.flags, written.pre_level, got, want, t->dv, t->x, flt(x_out));
            if (!pass && out) fwrite(&written, sizeof written, 1, out);
        }
    }
    /* other things that must leave the camera's value alone (the grid is still 64 x 64) */
    {
        const struct shot *t = &shots[0];
        u32 t0 = 40000000u;
        *(u32 *)(record + 0x584) = t->mm; *(u32 *)(record + 0x84) = bits(t->dv); *(u32 *)(record + 0x140) = bits(t->ev);
        *(u32 *)(lvx + 0xa0) = t->t_us; *(u32 *)(lvx + 0x9c) = t->gain;
        fill(1, 0, 64, 64);
        now_us = t0; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 20000; flttl(&c, 1, 0, 0);
        *(u32 *)(lvx + 0x9c) = t->gain * 2;                         /* live view exposure changed between the frames */
        fill(1, 1, 64, 64);
        now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 200000;
        CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f));
        now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);
        CHECK((written.flags & (F_EXPOSURE | F_VALID | F_APPLIED)) == F_EXPOSURE);

        t0 = 42000000u;                                             /* the gain trimmed by 9 % between the frames: used all the same */
        *(u32 *)(lvx + 0x9c) = t->gain;
        fill(1, 0, 64, 64);
        now_us = t0; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 20000; flttl(&c, 1, 0, 0);
        *(u32 *)(lvx + 0x9c) = t->gain - t->gain / 11;
        fill(1, 1, 64, 64);
        now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 200000;
        CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) != bits(3.0f));
        now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);
        CHECK((written.flags & (F_EXPOSURE | F_VALID | F_APPLIED)) == (F_VALID | F_APPLIED));

        t0 = 43000000u;                                             /* the exposure time changed: not used */
        *(u32 *)(lvx + 0x9c) = t->gain;
        fill(1, 0, 64, 64);
        now_us = t0; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 20000; flttl(&c, 1, 0, 0);
        *(u32 *)(lvx + 0xa0) = t->t_us / 2;
        fill(1, 1, 64, 64);
        now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 200000;
        CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f));
        now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);
        CHECK((written.flags & (F_EXPOSURE | F_VALID | F_APPLIED)) == F_EXPOSURE);
        *(u32 *)(lvx + 0xa0) = t->t_us;

        {   /* the camera has no distance (third round: 0x1FFFFFE2 mm, "30 m"): the measurement is taken whole */
            float x_out;
            t0 = 44000000u;
            *(u32 *)(record + 0x584) = 0x1fffffe2u; *(u32 *)(record + 0x84) = bits(9.81f);
            fill(5, 0, 64, 64);
            now_us = t0; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 10000;
            CHECK(flttl(&c, 5, 0x40, 0xa) == 0x40);                 /* level as for 2 m: 52 - 4 + 8 (2 + 3 - 2) = 72, so 0x40 */
            flash_obj[0x6c] = 0x40;
            now_us = t0 + 20000; flttl(&c, 1, 0, 0);
            fill(5, 1, 64, 64);
            now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 200000;
            x_out = flt(flttl(&c, 4, bits(6.22f), (uptr)calc));
            now_us = t0 + 900000; flttl(&c, 0, (uptr)object, 0);
            CHECK((written.flags & (F_FAR | F_LOWER | F_VALID | F_APPLIED)) == (F_FAR | F_VALID | F_APPLIED));
            CHECK(fabs(x_out - (6.22 + written.dv_q8 / 256.0 - 9.81)) < 0.03 && x_out < 6.22 - 9);
            *(u32 *)(record + 0x584) = t->mm; *(u32 *)(record + 0x84) = bits(t->dv);
        }
        for (i = 6; i <= 7; i++) {                                  /* noise in a few blocks is not a pre-emission */
            t0 = i == 6 ? 45000000u : 46000000u;
            fill((int)i, 0, 64, 64);
            now_us = t0; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 20000; flttl(&c, 1, 0, 0);
            fill((int)i, 1, 64, 64);
            now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 200000;
            CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f));
            now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);
            CHECK((written.flags & (F_NO_RESPONSE | F_VALID | F_APPLIED)) == F_NO_RESPONSE);
        }

        t0 = 47200000u;
        *(u32 *)(lvx + 0x9c) = t->gain;
        fill(1, 0, 64, 64);
        now_us = t0; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 20000; flttl(&c, 1, 0, 0);
        fill(1, 1, 64, 64);
        now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 1300000;                                      /* a result older than 1.2 s is not used */
        CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f));
        now_us = t0 + 1400000; flttl(&c, 0, (uptr)object, 0);
        CHECK((written.flags & (F_VALID | F_APPLIED)) == F_VALID);

        t0 = 50000000u;
        *(u32 *)(record + 0x140) = bits(25.0f);                     /* a scene Ev that cannot be */
        fill(1, 0, 64, 64);
        now_us = t0; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 20000; flttl(&c, 1, 0, 0);
        fill(1, 1, 64, 64);
        now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
        now_us = t0 + 200000;
        CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f));
        now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);
        CHECK((written.flags & (F_EV | F_VALID | F_APPLIED)) == F_EV);
        *(u32 *)(record + 0x140) = bits(t->ev);

        /* the frame before the pulse is half a second old (fourth round): the second frame after the one with the
           pre-emission is compared instead, and gives the same result as a fresh frame before does (shot 1 above) */
        {
            double fresh = 0.434, got;
            u32 x1, x2;
            t0 = 52000000u;
            fill(1, 0, 64, 64);
            now_us = t0; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 480000;
            CHECK(flttl(&c, 5, 0x40, 0xa) == 60);
            flash_obj[0x6c] = 60;
            now_us = t0 + 500000; flttl(&c, 1, 0, 0);
            fill(1, 1, 64, 64);
            now_us = t0 + 520000; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 530000;
            x1 = flttl(&c, 4, bits(3.0f), (uptr)calc);              /* asked now: nothing usable yet */
            fill(1, 0, 64, 64);
            now_us = t0 + 536000; flttl(&c, 0, (uptr)object, 0);    /* the next frame may hold the rest of the emission: not taken */
            CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) == bits(3.0f));
            now_us = t0 + 552000; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 700000;
            x2 = flttl(&c, 4, bits(3.0f), (uptr)calc);
            now_us = t0 + 1400000; flttl(&c, 0, (uptr)object, 0);
            got = written.dv_q8 / 256.0;
            CHECK(x1 == bits(3.0f) && fabs(flt(x2) - (3.0 + fresh - t->dv)) < 0.03 && fabs(got - fresh) < 0.03);
            CHECK((written.flags & (F_AFTER | F_OLD_PRE | F_EXPOSURE | F_VALID | F_APPLIED)) == (F_AFTER | F_VALID | F_APPLIED));
            CHECK(written.x_after_us == 30000 && written.ref_after_us == 52000 && written.fl_after_us == 20000 && written.pre_age_us == 500000);
        }
        /* the frame before was exposed differently: the same way out */
        {
            t0 = 55000000u;
            *(u32 *)(lvx + 0x9c) = t->gain * 2;
            fill(1, 0, 64, 64);
            now_us = t0; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 20000; flttl(&c, 1, 0, 0);
            *(u32 *)(lvx + 0x9c) = t->gain;
            fill(1, 1, 64, 64);
            now_us = t0 + 32000; flttl(&c, 0, (uptr)object, 0);
            fill(1, 0, 64, 64);
            now_us = t0 + 48000; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 64000; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 200000;
            CHECK(flttl(&c, 4, bits(3.0f), (uptr)calc) != bits(3.0f));
            now_us = t0 + 1000000; flttl(&c, 0, (uptr)object, 0);
            CHECK((written.flags & (F_AFTER | F_EXPOSURE | F_VALID | F_APPLIED)) == (F_AFTER | F_VALID | F_APPLIED));
        }
        /* a focus distance of 87 mm: the pre-emission is not made weaker than level 20 */
        {
            t0 = 58000000u;
            *(u32 *)(record + 0x584) = 87;
            fill(1, 0, 64, 64);
            now_us = t0; flttl(&c, 0, (uptr)object, 0);
            now_us = t0 + 10000;
            CHECK(flttl(&c, 5, 0x40, 0xa) == 20);
        }
    }
    if (out) fclose(out);
    printf(fails ? "%d FAILED\n" : "host test: all checks passed\n", fails);
    return fails != 0;
}
