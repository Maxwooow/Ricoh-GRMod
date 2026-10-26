/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: Direct Flash ("直闪模式") for the Ricoh GR IV (firmware 1.11).
 *
 * Flash at a fixed power; the exposure is planned from the subject distance and the flash's guide
 * number, in the way of the GR III's GF-2 Flash Mode (its behaviour as Ricoh describes it, not
 * its code): f-number = GN x sqrt(ISO / 100) / distance.
 *
 * `df_plan(ae, ctx)` runs right after the camera's own still exposure for flash pictures
 * (0x5367A7B4, called from 0x5367AAA8) and replaces its result when Direct Flash applies. `ae` is
 * that function's object: ae + 0x28 is the exposure record, ae + 4 the flash program diagram
 * whose word at + 4 is the object the flash-sync limit (0x536792E0) takes.
 *
 * Exposure record fields, as the camera's own code uses them (APEX values in float):
 *   0x10 / 0x14   Sv upper / lower limit of the camera   0x64  Ev of the scene at ISO 100
 *   0x39 (u8)     exposure program: 0 P, 1 Tv, 2 Av, 3 M with ISO Auto, 4 M, 5 / 6 bulb / time
 *   0x3E (u16)    flash kind: 0 none detected, 1..4 flashes that communicate (P-TTL), 0x10 GF-2
 *   0x40 (u16)    exposure mode setting: 7 Snap Distance Priority
 *   0x70 / 0x74   Tv upper / lower limit                 0x9C (u8)  ISO Auto
 *   0xA0 / 0xA4   ISO Auto range (Sv)                    0x10C      the fixed ISO (Sv)
 *   0xEC / 0xF0   Av lower / upper limit                 0x55D (u8) ND setting: 0 auto, 1 on, 2 off
 *                                                                  (the camera sets 2 on the HDF model)
 *   results: 0xD0 Tv, 0xD4 Av, 0xD8 Sv, 0x560 (u8) ND in      0x584 (u32) subject distance in mm
 *
 * Hard-float ABI (VFPv3), position independent, no global data, no library calls.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;

struct ctx {
  const volatile u8 *direct;        /* setting byte (0x99B), 0 on every camera: bit 0 Direct Flash
                                     * chosen (with Flash On); bits 1..4 the background, bits 5..7
                                     * the slowest shutter speed (camera-menu choices, see below) */
  const volatile u8 *flash_mode;    /* live Flash Mode: 0 Flash On */
  const volatile u8 *flash_output;  /* Flash Output setting: 0 Auto, 1 1/1, 2 1/4 */
  float (*sync_tv)(void *apex, u32 flag, float av); /* 0x536792E0: fastest Tv the flash syncs with */
  const volatile u8 *gn;            /* setting byte (0x99A): bits 0..5 the guide number (ISO 100,
                                     * metres, full power), 0 = the default below; bits 6..7 exposure
                                     * priority: 2 Max Sync, else Standard (see `solve`) */
  float gn_default;                 /* 2 log2(GN) of the default guide number */
  const volatile u8 *tvmax;         /* setting byte (0x109, test 062): bits 0..2 the fastest shutter
                                     * speed (see TV_MAX_*), 0 = the camera's sync limit */
#ifdef DIAG
  /* Test builds only: a RAM word (zero at start) that holds a buffer, allocated with `alloc` on the
   * first call, where every call leaves what it saw and decided (see `diag_record`); the date
   * imprint's diagnostic build prints it on the 720x480 picture. */
  u32 *volatile diag_slot;
  void *(*alloc)(u32 size);
#endif
};

#define F(o) (*(volatile float *)(info + (o)))
#define B(o) (*(volatile u8 *)(info + (o)))
#define H(o) (*(volatile u16 *)(info + (o)))
#define W(o) (*(volatile u32 *)(info + (o)))

#define AV_F28 2.9708536f   /* f/2.8 */
#define AV_F16 8.0f         /* f/16 */
/*
 * Camera-menu choices in the setting byte `direct` (0: the default):
 *  background, bits 1..4: k, the background k/3 EV darker than a correct exposure; 1..15 (-0.3 ..
 *    -5.0 EV, test 061); 0: 3 (-1.0 EV);
 *  slowest shutter speed, bits 5..7: 0 1/30 s (Tv 5), 1..5 1/15 .. 1 s (Tv 4 .. 0), 6 1/60 s, 7 1/125 s.
 */
#define BG_DEFAULT 3u
/*
 * Test 062: the fastest shutter speed for Direct Flash (byte 0x109, bits 0..2): 0 the camera's
 * flash-sync limit (1/2500 .. 1/4000 s; the default, as before 062), 1 1/2000, 2 1/1000, 3 1/500,
 * 4 1/250, anything else the sync limit. A flash of some power (a speedlight at full power burns for about 1/1000 s)
 * is only partly caught by a shutter faster than its burn: the planner takes all of the flash, so
 * the picture was darker (about 3 EV with a Godox iT32 at 1/4000 s). The GF-2 burns short enough.
 */
/* Standard, too bright even at f/16 and the lowest ISO: the shutter no faster than this many EV
 * past the background chosen (no jump to the sync limit; test 062). */
#define BG_STRETCH 2.0f

/* log2(x) for x > 0, to well within 1/100 EV. */
static float log2_(float x)
{
  union { float f; u32 u; } v;
  float m, t, t2, s;
  int e;
  v.f = x;
  e = (int)((v.u >> 23) & 255) - 127;
  v.u = (v.u & 0x7fffffu) | 0x3f800000u; /* 1 <= m < 2 */
  m = v.f;
  t = (m - 1.0f) / (m + 1.0f);
  t2 = t * t;
  s = t * (1.0f + t2 * (1.0f / 3 + t2 * (1.0f / 5 + t2 * (1.0f / 7 + t2 * (1.0f / 9)))));
  return (float)e + s * 2.8853900817779268f; /* 2 / ln 2 */
}

/* 2^y, to well within 1/100 EV. */
static float exp2_(float y)
{
  union { float f; u32 u; } v;
  float r, t, s;
  int n;
  if (y < -120.0f) y = -120.0f;
  if (y > 120.0f) y = 120.0f;
  n = (int)y;
  if ((float)n > y) n--;             /* floor */
  r = y - (float)n;                  /* 0 <= r < 1 */
  t = r * 0.6931471805599453f;       /* ln 2 */
  s = 1.0f + t * (1.0f + t * (1.0f / 2 + t * (1.0f / 6 + t * (1.0f / 24 + t * (1.0f / 120 + t * (1.0f / 720 + t * (1.0f / 5040)))))));
  v.u = (u32)(n + 127) << 23;
  return s * v.f;
}

static float clamp(float v, float lo, float hi)
{
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return v;
}

struct plan {
  float tv, av, sv;
  float err; /* EV the subject (flash + ambient light) is above (+) or below (-) a correct exposure */
  float bg;  /* EV the background (ambient light only) is above (+) or below (-) a correct exposure */
  float want; /* the shutter speed of the balance chosen (within the slowest and the fastest) */
};

struct limits {
  float sv_lo, sv_hi, av_lo, av_hi, tv_lo, tv_hi, ev, c;
  float b;                           /* the background chosen, b EV darker */
  int sync_first;                    /* exposure priority Max Sync */
  int fastest;                       /* exposure priority Fastest Shutter (test 059) */
  void *apex;
  const struct ctx *k;
};

/*
 * The subject is lit by the flash and by the ambient light together; the two add up. As shares of
 * a correct exposure (1):
 *   flash    F = 2^(f - 5 - (Av - Sv))        f: the Av of a correct flash exposure at ISO 100
 *   ambient  A = 2^(Ev - 5 - (Av - Sv) - Tv)  (an ND in front of the lens takes 2 EV of both)
 * F + A = 1 fixes Av - Sv for a given Tv:  Av - Sv = log2(2^(f - 5) + 2^(Ev - 5 - Tv)).
 * A / F = 2^(Ev - f0 - Tv) depends on the shutter speed alone (f0: f without the ND), and the
 * background, lit by the ambient light only, is exposed at A. A background b EV darker than a
 * correct exposure (A = 2^-b, F = 1 - 2^-b) is Tv = Ev - f0 + c, c = b + log2(1 - 2^-b): c = 0 for
 * b = 1, the flash and the ambient light half each.
 * Then Tv within its limits: in a dim place no slower than the slowest speed chosen (1/30 s by
 * default), the flash giving what the ambient light does not (all of it in the dark); in a bright
 * one no faster than the flash syncs with, the ambient light giving more and the flash filling in. Av - Sv as above, with the lowest ISO that
 * gets an aperture of f/2.8 or smaller, within the limits.
 */
static void solve_at(const struct limits *l, float f0, int nd, float av_lo, struct plan *p)
{
  float f = f0 - 2.0f * (float)nd;
  float e = l->ev - 5.0f - 2.0f * (float)nd;
  float tv = clamp(l->ev - f0 + l->c, l->tv_lo, l->tv_hi);
  float x = 0, sv = 0, av = 0, th = 0;
  int pass;
  p->want = tv;
  for (pass = 0; pass < 2; pass++) {
    x = log2_(exp2_(f - 5.0f) + exp2_(e - tv));
    sv = clamp(av_lo - x, l->sv_lo, l->sv_hi);
    av = clamp(sv + x, av_lo, l->av_hi);
    th = l->k->sync_tv(l->apex, 1, av);
    if (th > l->tv_hi) th = l->tv_hi;
    if (tv <= th) break;
    tv = th; /* faster than the flash syncs with: the ambient light gives more, the flash less */
  }
  if (tv > th) tv = th;
  /* Test 058: too bright even at the smallest aperture and the lowest ISO (a strong flash close by
   * in daylight): the balance above assumed a correct exposure, so the background is lighter than
   * chosen. The shutter faster, to a correct exposure of the subject where the ambient light's
   * share allows; test 062: no faster than BG_STRETCH EV past the background chosen (the flash
   * alone too bright: the shutter cannot help, it used to jump to the sync limit). */
  if (x - (av - sv) > 0.01f && tv < th) {
    float fl = exp2_(f - 5.0f), lim = exp2_(av - sv);
    float tb = e - (av - sv) + l->b + BG_STRETCH;
    float t = fl >= lim * 0.999f ? tb : e - log2_(lim - fl);
    if (t > tb) t = tb;
    if (t > th) t = th;
    if (t > tv) {
      tv = t;
      x = log2_(fl + exp2_(e - tv));
    }
  }
  p->tv = tv;
  p->av = av;
  p->sv = sv;
  p->err = x - (av - sv);
  p->bg = e - (av - sv) - tv;
}

static float absf(float v)
{
  return v < 0 ? -v : v;
}

/*
 * Exposure priority Max Sync (bit 6 of the guide-number byte): where the flash-sync limit holds the
 * shutter speed back from the balance chosen, try a smaller aperture (and with it a higher ISO, the
 * sum staying correct): the camera's limit is faster beyond f/4 (Av 4) and beyond f/5 (Av 4.67).
 * Taken when the shutter speed gets faster and the exposure is no worse.
 */
#define AV_SYNC_FASTEST 4.70f
#define AV_SYNC_FASTER 4.02f

/*
 * Exposure priority Fastest Shutter (test 059; bits 6..7 of the guide-number byte = 2): the shutter
 * as fast as the flash syncs with, wherever the subject can still be correctly exposed; the
 * background then as dark as that makes it (the background chosen is not used). For each of the
 * camera's sync limits (an aperture of at least Av 4.67, 4, or any): the fastest shutter speed it
 * allows, the lowest ISO with an aperture at least that, and where even the widest aperture and the
 * highest ISO are too dark at that speed, the shutter speed slower until the ambient light makes
 * up the rest (no slower than the slowest chosen). Taken: a correct exposure first, then the
 * fastest shutter speed, then the lowest ISO.
 */
static void fast_at(const struct limits *l, float f0, int nd, float floor, struct plan *p)
{
  float f = f0 - 2.0f * (float)nd;
  float e = l->ev - 5.0f - 2.0f * (float)nd;
  float tv = l->k->sync_tv(l->apex, 1, floor), x, sv, av, th, fl;
  int pass;
  if (tv > l->tv_hi) tv = l->tv_hi;
  fl = exp2_(f - 5.0f);
  {
    float t0 = tv, x0 = 0, s0 = 0, a0 = 0, h0 = 0;
    for (pass = 0; pass < 2; pass++) {
      x = log2_(fl + exp2_(e - tv));
      sv = clamp(floor - x, l->sv_lo, l->sv_hi);
      av = clamp(sv + x, floor, l->av_hi);
      th = l->k->sync_tv(l->apex, 1, av);
      if (th > l->tv_hi) th = l->tv_hi;
      if (pass) {
        /* the faster speed needs a wider aperture that no longer syncs with it: back */
        if (th < tv) { tv = t0; x = x0; sv = s0; av = a0; th = h0; }
        break;
      }
      if (th <= tv) break;
      x0 = x; s0 = sv; a0 = av; h0 = th;
      t0 = tv;
      tv = th; /* the aperture this needs syncs faster than the floor's: try that speed */
    }
  }
  if (x - (av - sv) < -0.001f) {
    /* too dark at this speed: slower, for the ambient light to make up the rest */
    float lim = exp2_(av - sv);
    tv = e - log2_(lim - fl);
    if (tv < l->tv_lo) tv = l->tv_lo;
    x = log2_(fl + exp2_(e - tv));
  }
  th = l->k->sync_tv(l->apex, 1, av);
  if (th > l->tv_hi) th = l->tv_hi;
  if (tv > th) tv = th;
  if (x - (av - sv) > 0.01f && tv < th) {
    /* too bright even at the smallest aperture and lowest ISO: as fast as that aperture syncs */
    tv = th;
    x = log2_(fl + exp2_(e - tv));
  }
  p->tv = tv;
  p->av = av;
  p->sv = sv;
  p->want = tv;
  p->err = x - (av - sv);
  p->bg = e - (av - sv) - tv;
}

static int better_fast(const struct plan *q, const struct plan *p)
{
  int qa = absf(q->err) <= 0.02f, pa = absf(p->err) <= 0.02f;
  if (qa != pa) return qa;
  if (!qa) {
    if (absf(q->err) < absf(p->err) - 0.01f) return 1;
    if (absf(q->err) > absf(p->err) + 0.01f) return 0;
    return q->tv > p->tv + 0.01f;
  }
  if (q->tv > p->tv + 0.01f) return 1;
  if (q->tv < p->tv - 0.01f) return 0;
  return q->sv < p->sv - 0.01f;
}

static void solve(const struct limits *l, float f0, int nd, struct plan *p)
{
  struct plan q;
  float floors[2];
  int i;
  if (l->fastest) {
    floors[0] = AV_SYNC_FASTEST;
    floors[1] = AV_SYNC_FASTER;
    fast_at(l, f0, nd, l->av_lo, p);
    for (i = 0; i < 2; i++) {
      if (floors[i] <= l->av_lo || floors[i] > l->av_hi) continue;
      fast_at(l, f0, nd, floors[i], &q);
      if (better_fast(&q, p)) *p = q;
    }
    return;
  }
  solve_at(l, f0, nd, l->av_lo, p);
  if (!l->sync_first) return;
  floors[0] = AV_SYNC_FASTEST;
  floors[1] = AV_SYNC_FASTER;
  for (i = 0; i < 2; i++) {
    if (!(p->tv < p->want - 0.01f) || floors[i] <= p->av || floors[i] > l->av_hi) continue;
    solve_at(l, f0, nd, floors[i], &q);
    if (q.tv > p->tv + 0.01f && absf(q.err) <= absf(p->err) + 0.001f) *p = q;
  }
}


#ifdef DIAG
/* Buffer: word 0 the number of calls, then two records of DIAG_WORDS words (the last call's at
 * index calls & 1). Fields (x100 for APEX values): see `D_*`. */
#define DIAG_WORDS 32
#define DIAG_BYTES (4 + 2 * DIAG_WORDS * 4)
enum { D_CALL, D_REASON, D_PROGRAM, D_MODE, D_KIND, D_ND_MODE, D_ISO_AUTO, D_OUTPUT, D_MM, D_EV, D_F70, D_F74, D_SYNC,
       D_TV_HI, D_TV_LO, D_OFF_TV, D_OFF_AV, D_OFF_SV, D_TV, D_AV, D_SV, D_ND, D_BG, D_ERR, D_SV_LO, D_SV_HI,
       D_AV_LO, D_AV_HI, D_F10, D_F14, D_FA0, D_FA4 };
static s32 x100(float v)
{
  float r = v * 100.0f;
  return (s32)(r < 0 ? r - 0.5f : r + 0.5f);
}
static s32 *diag_record(const struct ctx *k)
{
  u32 *buf = (u32 *)*k->diag_slot, n, i;
  if (!buf) {
    if (!k->alloc) return 0;
    buf = (u32 *)k->alloc(DIAG_BYTES);
    if (!buf) return 0;
    for (i = 0; i < DIAG_BYTES / 4; i++) buf[i] = 0;
    *k->diag_slot = (u32)buf;
  }
  n = ++buf[0];
  {
    s32 *r = (s32 *)(buf + 1 + (n & 1) * DIAG_WORDS);
    for (i = 0; i < DIAG_WORDS; i++) r[i] = 0;
    r[D_CALL] = (s32)n;
    return r;
  }
}
#define REC(field, value) do { if (rec) rec[field] = (s32)(value); } while (0)
#define RECF(field, value) do { if (rec) rec[field] = x100(value); } while (0)
#else
#define REC(field, value) do { } while (0)
#define RECF(field, value) do { } while (0)
#endif

void df_plan(u8 *ae, const struct ctx *k)
{
  u8 *info;
  void *apex;
  struct limits l;
  struct plan p, q;
  u32 mm, kind, nd_mode, i, setting;
  float f0, a, b;
  int nd;
#ifdef DIAG
  s32 *rec = diag_record(k);
#endif

  REC(D_REASON, 1);
  setting = *k->direct;
  if (!(setting & 1u) || *k->flash_mode != 0) return;
  REC(D_REASON, 2);
  info = *(u8 **)(ae + 0x28);
  if (!info || !*(u8 **)(ae + 4)) return;
  apex = *(void **)(*(u8 **)(ae + 4) + 4);
  if (!apex) return;
  REC(D_PROGRAM, B(0x39));
  REC(D_MODE, H(0x40));
  REC(D_KIND, H(0x3e));
  REC(D_ND_MODE, B(0x55d));
  REC(D_ISO_AUTO, B(0x9c));
  REC(D_OUTPUT, *k->flash_output);
  REC(D_MM, W(0x584));
  RECF(D_EV, F(0x64));
  RECF(D_F70, F(0x70));
  RECF(D_F74, F(0x74));
  RECF(D_OFF_TV, F(0xd0));
  RECF(D_OFF_AV, F(0xd4));
  RECF(D_OFF_SV, F(0xd8));
  RECF(D_F10, F(0x10));
  RECF(D_F14, F(0x14));
  RECF(D_FA0, F(0xa0));
  RECF(D_FA4, F(0xa4));
  REC(D_REASON, 3);
  if (B(0x39) > 4) return;          /* bulb, time */
  REC(D_REASON, 4);
  if (H(0x40) == 7) return;         /* Snap Distance Priority */
  kind = H(0x3e);
  REC(D_REASON, 5);
  if (kind >= 1 && kind <= 4) return; /* a P-TTL flash: Flash On as it is */
  mm = W(0x584);
  REC(D_REASON, 6);
  if (mm == 0) return;              /* no distance */
  if (mm < 100) mm = 100;
  if (mm > 8000) mm = 8000;          /* as the camera's own use of it */

  i = *k->gn & 63u;                      /* bits 0..5: the guide number; bit 6: Max Sync */
  f0 = (i ? 2.0f * log2_((float)i) : k->gn_default) - 2.0f * (log2_((float)mm) - 9.965784284662087f); /* - 2 log2(mm / 1000) */
  if (*k->flash_output == 2) f0 -= 2.0f; /* 1/4 power */
  {
    /* Test 061: the EV compensation on the flash too. The camera took it off the scene's Ev (0x64)
     * already (0x536789FC: the compensation 0x108, plus 0xE4 when 0xFC is 0, within -8..8), so only
     * the ambient light followed it; taken off the flash's f as well, the subject and the background
     * are both brighter by it (the background still the chosen EV below that). */
    float c = F(0x108);
    if (!B(0xfc)) c += F(0xe4);
    c = clamp(c, -8.0f, 8.0f);
    f0 -= c;
  }

  l.k = k;
  l.apex = apex;
  i = (*k->gn >> 6) & 3u;                /* bits 6..7: 2 Max Sync (test 059's Fastest Shutter), else Standard
                                          * (test 059's Max Sync; test 060 has no Low ISO any more) */
  l.sync_first = i != 2;
  l.fastest = i == 2;
  i = (setting >> 1) & 15u;
  if (i == 0 || i > 15) i = BG_DEFAULT;  /* test 061: to -5.0 EV (k = 15) */
  a = (float)i * (1.0f / 3.0f);          /* the background a EV darker */
  l.b = a;
  l.c = a + log2_(1.0f - exp2_(-a));
  l.ev = F(0x64);
  l.sv_lo = F(0x14);
  l.sv_hi = F(0x10);
  if (B(0x9c)) {
    a = F(0xa0);
    b = F(0xa4);
    if (a > b) { float t = a; a = b; b = t; }
    if (a > l.sv_lo) l.sv_lo = a;
    if (b < l.sv_hi) l.sv_hi = b;
    if (l.sv_lo > l.sv_hi) l.sv_hi = l.sv_lo;
  } else {
    l.sv_lo = l.sv_hi = clamp(F(0x10c), l.sv_lo, l.sv_hi);
  }
  l.av_lo = F(0xec);
  l.av_hi = F(0xf0);
  if (l.av_lo < AV_F28) l.av_lo = AV_F28;
  if (l.av_hi > AV_F16) l.av_hi = AV_F16;
  if (l.av_lo > l.av_hi) l.av_lo = l.av_hi;
  l.tv_hi = F(0x70);
  i = *k->tvmax & 7u;                    /* test 062: the fastest shutter speed chosen */
  if (i >= 1 && i <= 4) {
    a = 12.0f - (float)i;                /* 1/2000, 1/1000, 1/500, 1/250 */
    if (a < l.tv_hi) l.tv_hi = a;
  }
  i = setting >> 5;                      /* the slowest shutter speed chosen (the camera's own setting of
                                          * a minimum shutter speed is not for Direct Flash) */
  l.tv_lo = i == 0 ? 5.0f : i <= 5 ? (float)(5 - (int)i) : (float)i;
  if (l.tv_lo > l.tv_hi) l.tv_lo = l.tv_hi;

  nd_mode = B(0x55d);
  nd = nd_mode == 1;
  solve(&l, f0, nd, &p);
  if (nd_mode == 0 && p.err >= 1.0f) {
    /* ND Auto: put the ND in when the picture would be too bright even at f/16 and the lowest ISO
     * (a subject too close, or a scene too bright for the fastest shutter speed the flash syncs
     * with), and it helps. */
    solve(&l, f0, 1, &q);
    if (q.err > -1.0f && absf(q.err) < absf(p.err) - 0.5f) {
      p = q;
      nd = 1;
    }
  }
  F(0xd0) = p.tv;
  F(0xd4) = p.av;
  F(0xd8) = p.sv;
  B(0x560) = (u8)nd;
  REC(D_REASON, 0);
  RECF(D_TV, p.tv);
  RECF(D_AV, p.av);
  RECF(D_SV, p.sv);
  REC(D_ND, nd);
  RECF(D_BG, p.bg);
  RECF(D_ERR, p.err);
  RECF(D_SV_LO, l.sv_lo);
  RECF(D_SV_HI, l.sv_hi);
  RECF(D_AV_LO, l.av_lo);
  RECF(D_AV_HI, l.av_hi);
  RECF(D_TV_LO, l.tv_lo);
#ifdef DIAG
  {
    float sy = k->sync_tv(apex, 1, p.av);
    RECF(D_SYNC, sy);
    RECF(D_TV_HI, sy < l.tv_hi ? sy : l.tv_hi);
  }
#endif
}
