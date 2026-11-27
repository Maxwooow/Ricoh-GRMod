# SPDX-License-Identifier: GPL-2.0-only
"""night_tone: integer reference of the night brightening "③a+" on the merged Bayer frame (bit-exact spec of
c/night_tone.c).

Rule (no tuning parameters besides these):
  1. global gain from libcamera's shared AGC (AgcMeanLuminance, as published): 15x15 zone means, 8 iterations of
     g *= min(0.16 / max(mean(min(zone * g, 1)), 0.001), 10) (stop when |ex - 1| < 0.01); g_full = log2 of that.
     'Highlight' constraint: q[0.98, 1] (mean of the top 2 % of the 1/16-edge block means, 256-bin histogram) at
     least 0.5 and at most 0.8:  g_cap = log2(min(max(gain, 0.5 / q), 0.8 / q)).
  2. noise limit N = max(0, 0.9 + log2(25600 / ISO)), optionally capped by the caller (n_max); global g = max(0, min(g_cap, N)).
  3. dark lift d = max(0, min(g_full - g, N - g)); weight w = clip(1 - L / 0.16, 0, 1), L = smoothed local luminance
     after the global gain; per-quad gain 2^g * 2^(w d).  L: guided filter of log2(Y + 2^-12) (coefficients on the
     1/16-edge grid, box radius 3, eps 0.5, bilinear up), as the computer demonstration.
  4. the gain multiplies the black-subtracted Bayer values, the same for all four CFA positions of a quad;
     result limited to white: a quad whose brightest value would pass white gets the gain that puts that value
     exactly at white (never below 1), so no value is pushed past white and the colour ratio of the quad is
     kept (clipping each value separately turns saturated lamps pink: green is already at white, red and blue
     keep rising).  Values below 0 after the gain (noise under black) become 0; values that were already above
     white stay as they were.

Units: Y = luminance (0.30 R + 0.59 G + 0.11 B after white balance) relative to the white level, times the exposure
scale and the vignetting factor V(r2) = 1 + k1 r2 + k2 r2^2 (r2 = squared distance from the window centre / squared
half diagonal), all given by the caller.  1.0 = RAW white.

Fixed point: Y Q20 (EPS = 2^-12 = 256; the luminance of a full-scale 65535 value must stay below 32.0, checked from
the arguments), log2 Q12 per quad, statistics in Q16 stops, gains Q16.
No floating point anywhere; numpy int64 arrays mirror the C int32 / int64 arithmetic (>> is a floor shift in both)."""
import numpy as np

VERSION = 1

ERR_ARG = -1
ERR_SCRATCH = -3

EPS20 = 256                 # 2^-12 in Q20
YLIM = 1 << 25              # |Y| bound (32.0) the arguments must guarantee (64 Y of a cell fit int32)
TMIN8 = -12 * 256           # gain table: t (log2 of the local luminance) from -12 ...
NT = 2432                   # ... to -2.5 in 1/256 stop (above -2.5: L >= 0.16 for every g >= 0, w = 0)
LN2_Q32 = 2977044472        # round(ln 2 * 2^32)
C016_Q30 = 171798692        # round(0.16 * 2^30)
C016_Q52 = 720575940379279  # round(0.16 * 2^52)
Y001_Q36 = 68719477         # round(0.001 * 2^36)
N0_Q16 = 58982              # round(0.9 * 2^16)
EX_MAX_Q16 = 10 << 16
LUMW = (60, 59, 59, 22)     # luminance weights in 1/200 for R, Gr, Gb, B (0.30, 0.59 / 2, 0.59 / 2, 0.11)
ZONES = 15
GRID = 8                    # coefficient grid cell = 8x8 quads = 16x16 pixels
RAD = 3                     # box radius on the grid
EPS_GF = 2401 << 19         # 0.5 (log2^2) in the scaled variance unit 49^2 * 2^36 >> 16
B_DIV = 49 * 32768 * 4      # S1 (49 * Q18) * (1 - a) (Q15) -> Q16


# ---------------------------------------------------------------------------------------------- scalar helpers

def log2_q16(x):
    """floor-ish log2(x) in Q16 for an integer x >= 1 (bit-by-bit squaring of the Q30 mantissa, truncating)"""
    n = x.bit_length() - 1
    m = x >> (n - 30) if n >= 30 else x << (30 - n)
    r = n << 16
    for b in range(15, -1, -1):
        m = (m * m) >> 30
        if m >= 1 << 31:
            m >>= 1
            r |= 1 << b
    return r


def exp2_q(e, q):
    """round(2^(e / 2^16) * 2^q) for an integer e (Q16 stops): series of e^(f ln2) in Q32 (12 terms)"""
    n = e >> 16
    f = e & 0xFFFF
    y = (f * LN2_Q32) >> 16
    s = (1 << 32) + y
    t = y
    for k in range(2, 13):
        t = ((t * y) >> 32) // k
        s += t
    v = (s + 2) >> 2            # Q30
    sh = n + q - 30
    if sh >= 0:
        return v << sh
    if -sh >= 63:
        return 0
    return (v + (1 << (-sh - 1))) >> -sh


def log2_table():
    """per-quad log2 mantissa table, Q12: log2(1 + (i + 0.5) / 1024)"""
    return np.array([(log2_q16(2049 + 2 * i) - 11 * 65536 + 8) >> 4 for i in range(1024)], np.int64)


def vig_table(k1, k2):
    """V(r2) in Q14 for r2 = idx / 4096, idx 0..4096; k1, k2 Q16"""
    out = []
    for i in range(4097):
        r = i << 4
        out.append(16384 + ((k1 * r) >> 18) + ((k2 * ((r * r) >> 16)) >> 18))
    return np.array(out, np.int64)


def gain_table(g, d):
    """GT[i] = 2^(g + w d) in Q16 for t = (i + TMIN8) / 256, w = clip(1 - (2^t - 2^-12) 2^g / 0.16, 0, 1)"""
    G = exp2_q(g, 16)
    out = []
    for i in range(NT):
        P = exp2_q((i + TMIN8) << 8, 30)
        Lq = P - (1 << 18)
        if Lq <= 0:
            w = 65536
        else:
            L = (Lq * G) >> 16
            w = 0 if L >= C016_Q30 else 65536 - ((L << 16) // C016_Q30)
        out.append(exp2_q(g + ((w * d) >> 16), 16))
    return np.array(out, np.int64)


def q8(x):
    return (x + 128) >> 8


def scratch_bytes(w, h):
    """bytes of scratch night_tone_apply needs (same layout as the C code), 0 for unusable sizes"""
    if w < 32 or h < 32 or w > 16384 or h > 16384 or (w | h) & 1:
        return 0
    H2, W2 = h // 2, w // 2
    GH, GW = H2 // GRID, W2 // GRID
    a8 = lambda n: (n + 7) & ~7
    return (512 + 2 * a8(GH * GW * 4) + a8(4 * GW * 4) + a8(GW * 4) + a8(GW * 8) + a8(H2 * ZONES * 8) + 2 * a8(H2 * 4)
            + a8(256 * 4) + a8(W2 * 4) + a8(4097 * 4) + a8(1024 * 4) + a8(2 * NT * 4))


# ---------------------------------------------------------------------------------------------- the operator

def box49(a):
    """7x7 clamped (np.pad edge) window sum, any integer dtype -> int64"""
    p = np.pad(a.astype(np.int64), RAD, mode='edge')
    H, W = a.shape
    c = np.zeros((H + 2 * RAD, W), np.int64)
    for dx in range(2 * RAD + 1):
        c += p[:, dx:dx + W]
    s = np.zeros((H, W), np.int64)
    for dy in range(2 * RAD + 1):
        s += c[dy:dy + H]
    return s


def check_args(w, h, stride, black, white, wb, iso, lum, scratch_size):
    """the C argument checks (same order); returns 0 or an error"""
    if w < 32 or h < 32 or w > 16384 or h > 16384 or (w | h) & 1 or stride < w:
        return ERR_ARG
    if black < 0 or white > 65535 or white - black < 256:
        return ERR_ARG
    if any(c < 256 or c > 65535 for c in wb):
        return ERR_ARG
    if iso < 25 or iso > 3276800:
        return ERR_ARG
    sc, k1, k2 = lum if lum is not None else (65536, 0, 0)
    if sc < 4096 or sc > 1048576 or abs(k1) > (4 << 16) or abs(k2) > (4 << 16):
        return ERR_ARG
    if scratch_size < scratch_bytes(w, h):
        return ERR_SCRATCH
    return 0


def coeffs(black, white, wb, lum):
    sc = lum[0] if lum is not None else 65536
    span = white - black
    return [(LUMW[c] * wb[c] * sc * 256 + 100 * span) // (200 * span) for c in range(4)]


def luminance(P, black, k, V, rr, cc):
    """per-quad Y (Q20, signed, clamped) and the four black-subtracted planes"""
    v = [p.astype(np.int64) - black for p in P]
    s = k[0] * v[0] + k[1] * v[1] + k[2] * v[2] + k[3] * v[3]
    y0 = s >> 12                                     # Q24
    idx = (rr[:, None] + cc[None, :] + 128) >> 8     # <= 4096
    Y = (y0 * V[idx]) >> 18                          # C: high word of y0 * (V << 14)
    return Y, v


def log2_quads(Y, T):
    x = np.maximum(Y, 0) + EPS20                    # < 2^25
    n = np.frexp(x.astype(np.float64))[1].astype(np.int64) - 1   # exact floor(log2) for integers < 2^53
    m = (x << (31 - n)) & 0xFFFFFFFF
    return (n - 20) * 4096 + T[(m >> 21) & 1023]


def apply(bayer, black, white, wb, iso, lum=None, scratch_size=1 << 40, n_max_q16=None, d_max_q16=None):
    """bayer: (h, w) uint16 view of the window (RGGB at [0, 0]); wb: 4 gains Q12 (R, Gr, Gb, B); iso: integer ISO;
    lum: (exposure scale Q16, k1 Q16, k2 Q16) or None (1, 0, 0).  Returns (ret, out_array, info); out is a new array
    (the input is not changed), info is None on an error.  n_max_q16 (mf18, C night_tone_set_n_max): N = min(N, n_max_q16).
    d_max_q16 (final build, C night_tone_set_d_max): d = min(d, d_max_q16) once planned (g unchanged)."""
    h, w = bayer.shape
    r = check_args(w, h, w, black, white, wb, iso, lum, scratch_size)
    if r:
        return r, bayer.copy(), None
    if n_max_q16 is not None and n_max_q16 < 0:
        return ERR_ARG, bayer.copy(), None
    if d_max_q16 is not None and d_max_q16 < 0:
        return ERR_ARG, bayer.copy(), None
    k = coeffs(black, white, wb, lum)
    if max(k) > (1 << 30):
        return ERR_ARG, bayer.copy(), None
    sc, k1, k2 = lum if lum is not None else (65536, 0, 0)
    V = vig_table(k1, k2)
    if V.min() < 4096 or V.max() >= (1 << 17):
        return ERR_ARG, bayer.copy(), None
    y0max = (sum(k) * 65535) >> 12
    if y0max >= (1 << 31) or (y0max * int(V.max())) >> 18 >= YLIM:
        return ERR_ARG, bayer.copy(), None
    T = log2_table()
    H2, W2 = h // 2, w // 2
    GH, GW = H2 // GRID, W2 // GRID
    R4 = (h // 2) ** 2 + (w // 2) ** 2
    dy = 2 * np.arange(H2, dtype=np.int64) + 1 - h // 2
    dx = 2 * np.arange(W2, dtype=np.int64) + 1 - w // 2
    rr = (dy * dy << 20) // R4
    cc = (dx * dx << 20) // R4

    P = [bayer[0::2, 0::2], bayer[0::2, 1::2], bayer[1::2, 0::2], bayer[1::2, 1::2]]
    Y, v = luminance(P, black, k, V, rr, cc)
    I = log2_quads(Y, T)
    clip0 = int((bayer >= white).sum())

    # ---- statistics
    Ils = I[:GH * GRID, :GW * GRID].reshape(GH, GRID, GW, GRID).sum((1, 3))
    Yc = Y[:GH * GRID, :GW * GRID].reshape(GH, GRID, GW, GRID).sum((1, 3))
    zh, zw = H2 // ZONES, W2 // ZONES
    Yz = Y[:ZONES * zh, :ZONES * zw].reshape(ZONES, zh, ZONES, zw).sum((1, 3)) // (zh * zw)
    Yz = [int(x) for x in Yz.ravel()]
    g = 65536
    for _ in range(8):
        thr = ((1 << 36) + g - 1) // g
        ys = 0
        for z in Yz:
            ys += (1 << 36) if z >= thr else (-(1 << 36) if -z >= thr else z * g)
        y = ys // (ZONES * ZONES)
        ex = min(C016_Q52 // max(y, Y001_Q36), EX_MAX_Q16)
        g = max((g * ex) >> 16, 1)
        if 100 * abs(ex - 65536) < 65536:
            break
    g_full = log2_q16(g) - (16 << 16)
    hist = np.bincount(np.clip(Yc.ravel() >> 18, 0, 255), minlength=256)
    n = GH * GW
    kk = n - (98 * n) // 100
    sumb, left = 0, kk
    for b in range(255, -1, -1):
        take = min(left, int(hist[b]))
        sumb += b * take
        left -= take
        if left == 0:
            break
    l2q = log2_q16(2 * sumb + kk) - log2_q16(2 * kk)
    lo = (7 << 16) - l2q
    hi = (10 << 16) - log2_q16(5) - l2q
    g_cap = min(max(g_full, lo), hi)
    N = max(0, N0_Q16 + log2_q16(25600) - log2_q16(iso))
    if n_max_q16 is not None:
        N = min(N, n_max_q16)
    gg = max(0, min(g_cap, N))
    d = max(0, min(g_full - gg, N - gg))
    if d_max_q16 is not None:
        d = max(0, min(d, d_max_q16))
    info = dict(g_q16=gg, d_q16=d, n_q16=N, g_full_q16=g_full, g_cap_q16=g_cap, g_q8=q8(gg), d_q8=q8(d), n_q8=q8(N),
                g_full_q8=q8(g_full), g_cap_q8=q8(g_cap), dark_lift_q8=q8(gg + d), clip_before=clip0, pixels=w * h,
                changed=int(gg > 0 or d > 0))
    if not info['changed']:
        info.update(clip_after=clip0, clip_delta_ppm=0)
        return 0, bayer.copy(), info

    # ---- guided filter coefficients on the grid
    S1 = box49(Ils)
    S2 = box49(Ils * Ils)
    Vs = (49 * S2 - S1 * S1) >> 16
    a = (Vs << 15) // (Vs + EPS_GF)
    b = (S1 * (32768 - a)) // B_DIV
    A = box49(a) // 49
    B = box49(b) // 49

    # ---- per-quad gain
    GT = gain_table(gg, d)
    gy = np.clip(2 * np.arange(H2) - 7, 0, 16 * (GH - 1))
    gx = np.clip(2 * np.arange(W2) - 7, 0, 16 * (GW - 1))
    y0, fy = gy >> 4, (gy & 15)[:, None]
    y1 = np.minimum(y0 + 1, GH - 1)
    x0, fx = gx >> 4, gx & 15
    x1 = np.minimum(x0 + 1, GW - 1)
    HA = A[:, x0] * (16 - fx) + A[:, x1] * fx
    HB = B[:, x0] * (16 - fx) + B[:, x1] * fx
    Au = (HA[y0] * (16 - fy) + HA[y1] * fy) >> 8
    Bv = HB[y0] * (16 - fy) + HB[y1] * fy
    t = ((Au * I) >> 15) + (Bv >> 12)
    G = GT[np.clip((t >> 4) - TMIN8, 0, NT - 1)]
    span = white - black
    vmax = np.maximum(np.maximum(v[0], v[1]), np.maximum(v[2], v[3]))
    over = vmax * G > (span << 16)
    G = np.where(over, np.maximum(65536, (span << 16) // np.maximum(vmax, 1)), G)
    out = bayer.copy()
    for (oy, ox), vc in zip(((0, 0), (0, 1), (1, 0), (1, 1)), v):
        out[oy::2, ox::2] = np.maximum(black + ((vc * G + 32768) >> 16), 0).astype(np.uint16)
    clip1 = int((out >= white).sum())
    dl = clip1 - clip0
    ppm = (abs(dl) * 1000000) // (w * h)
    info.update(clip_after=clip1, clip_delta_ppm=ppm if dl >= 0 else -ppm)
    return 0, out, info
