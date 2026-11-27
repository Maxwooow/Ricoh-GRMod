# SPDX-License-Identifier: GPL-2.0-only
"""Integer reference implementation of the burst merge (HDR+ style, spatial domain).

This file is the bit-exact specification for the camera module: every step uses integer
arithmetic only (add, subtract, shift, multiply, integer division of non-negative values,
table lookup).  The C module must reproduce `merge()` bit for bit.

Algorithm (the design notes of the research line, rounds 1 and 2):
  * frames[0] = reference (in the camera the last frame of a group); Bayer mosaics, uint16, H and W
    even, same exposure.
  * alignment on a half-resolution gray image (sum of each 2x2 Bayer block), 4-level pyramid
    (factors 1,2,4,4), non-overlapping tiles (16,16,16,8), integer offsets (2 Bayer px per step), L1.
    Levels 3..1: HDR+ 3-candidate upsampling (v10; up to v9 plus the coarse median), deduplicated, full local search
    (radii 4,4,2).  Level 0: global offset first; tiles not explained by it (cost/noise > RATIO_LO)
    search locally and keep the global offset unless clearly beaten (GLOBAL_MARGIN).
  * merge: per half-res pixel weight from the 3x3 sum of |difference| per colour plane over the expected
    noise (max over planes), 3x3 minimum, then capped by an 8x8-block signed-sum check (v6); the four
    Bayer pixels of a block share the weight; weighted mean with the reference
    at weight 64, integer division by a reciprocal table.  See the comment above merge().
  * no frame-level reject (removed in v4, design round 4): the per-pixel weights alone
    decide where an alternate frame is used.
  * v8 (2026-11-21): optional `vmax`, the largest value the sensor's container holds ((1 << bits) - 1, 16383 on
    the GR IV).  Given, every normalised alternate pixel is limited to 0..vmax (not 0..65535) before it is used
    (weights, block check, accumulation), and the merged output is limited to 0..vmax.  Why: in the camera run of
    2026-11-21 (test build mf06) a clipped 16383 alternate pixel normalised with k = 0.998 became 16413; the merged
    16393 did not fit the 14-bit raw and was stored as 9 (dark specks inside clipped highlights).  vmax=None is
    exactly v7.
  * v9 (2026-11-22): optional second noise table `ntab_w`, `nshift_w` (same format as ntab) for the expected noise of the
    per-pixel weights only (E9 of the 3x3 pixel ratio and Eb of the 8x8 block check); ntab keeps driving the alignment
    noise (e0a) and with it the brightness gain k.  ntab_w=None is exactly v8.  The v9 weights table is
    weights_noise_table(): a model of the real sensor gain (analysis 2026-11-22, follow-up): G variance per Bayer pixel
    = 1.004e-2 * ISO_real^0.843 * s + ISO_real / 50 (DN^2, s = DN above black), ISO_real = the nominal ISO of the frame's
    ISO step, 3 steps (1 EV) lower when highlight correction was applied (MakerNote 0x0069 byte 0, ShootingInfo +0xBB7).
    Why: with highlight correction off the real noise is 1.3-1.8x (sd) the camera table's, and the weights dropped
    (3-frame merges 2.2-2.5 dB at ISO 25600 black 2048, 2.9-3.6 dB at ISO 4000-5000).

  * v10 (2026-11-22): the coarse-median start is dropped from the upsampled candidates (levels 2 and 1, and the level-0
    refinement, which keeps the global offset as its 4th start).  Only level 1's median is still computed (the global
    offset's start).  The candidates are now HDR+'s three (the nearest coarse tile and the next-nearest in each dimension; IPOL
    reference code alignment.py upsampleAlignments).  Why: the alignment's speed on the camera (one start of four less at
    levels 2 and 1, one of five at level 0: 15 % fewer instructions of phase 1 on a real ISO 25600 group); on the 18 real
    camera groups of mf12 / mf13 the noise gain changes by -0.010 .. +0.029 dB (mean 0.000), the level ratio by <= 0.0004,
    the ghost leak of moved content by <= +0.001 (research notes, alignment speed).  ref.py v10 = v9 otherwise; ntab_w etc. unchanged.

Pyramid alignment structure is adapted from timothybrooks/hdr-plus (MIT License, Copyright (c) 2017
Timothy Brooks; https://github.com/timothybrooks/hdr-plus), align.cpp; parameters from the IPOL HDR+
reimplementation (Monod, Delon, Veit 2021, paper only).  The weights and merge are our own.
"""
import numpy as np

# ---------------------------------------------------------------------------------------------
# constants (all integers)
LEVEL_FACTORS = (1, 2, 4, 4)      # downsampling of each level relative to the finer one (level 0 = half-res gray)
LEVEL_TILES = (16, 16, 16, 8)     # alignment tile size per level (non-overlapping tiles)
LEVEL_RADII = (1, 2, 4, 4)        # search radius per level (level 1: upsampled level-2 error is <= 2)
MAX_OFFSET = 176                  # clamp of the total offset, half-resolution pixels
RATIO_LO_Q8 = 384                 # level-0 alignment: tile cost/noise (Q8) at or below which the global offset is kept (1.5)
RATIO_HI_Q8 = 1024                # tile cost/noise (Q8) above which a tile counts as textured / misaligned (4.0)
GLOBAL_MARGIN_Q8 = 36               # level-0 local offset must beat the global one by 36*E, E = e0/256 the expected mean |diff| per pixel (~3 std of a 256-pixel tile L1 sum)
NOISE_BINS = 256                  # noise table entries over the normalised signal range

# ---------------------------------------------------------------------------------------------
# noise table (built on the computer, an input of the integer core)

def noise_table(lam_s, lam_r, black, white):
    """Expected mean |difference| of two independent noisy half-res gray samples, Q8, indexed by
    (per-Bayer-pixel signal above black) >> shift.  Gray = sum of 4 Bayer pixels, so
    var_gray = 4 * var_pix and E|N(0, 2 var_gray)| = 2 * sqrt(var_gray / pi).
    lam_s, lam_r: DNG NoiseProfile terms for normalised signal (variance = lam_s*x + lam_r).
    Built with floats on the computer; the integer core only consumes the resulting table."""
    rng = white - black
    shift = max(0, int(rng - 1).bit_length() - 8)
    tbl = np.zeros(NOISE_BINS, dtype=np.int64)
    for b in range(NOISE_BINS):
        x = ((b << shift) + (1 << shift) // 2) / rng          # bin centre, normalised
        var_pix = (lam_s * min(x, 1.0) + lam_r) * rng * rng  # DN^2
        e = 2.0 * np.sqrt(4.0 * var_pix / np.pi)
        tbl[b] = max(1, int(round(256 * e)))
    return tbl, shift


# v9: the weights' noise model (real sensor gain).  The constants are built from floats on the computer (or when the camera
# module is patched, like the alignment table's slopes); the table itself is integer only, the same steps as the module's
# noise_table(): no division by the range, so it does not depend on black except through the bins.
W_SLOPE_C, W_SLOPE_P, W_FLOOR_DIV = 1.004e-2, 0.843, 50.0     # slope DN^2/DN = C * ISO_real^P, floor DN^2 = ISO_real / 50
W_K = 1024.0 ** 2 / np.pi * 65536                              # K * 2^16, K = 1024^2 / pi (entry = sqrt(K * var), as noise_table)


def weights_noise_consts(iso_real):
    """(A, B) of one nominal ISO: A = round(K 2^16 * 1.004e-2 * iso^0.843), B = round(K 2^16 * iso / 50).  In the camera, one
    pair per ISO step i of the firmware's ISO table (iso[i]); a frame uses step - 3 when highlight correction was applied."""
    iso = float(iso_real)
    return int(round(W_K * W_SLOPE_C * iso ** W_SLOPE_P)), int(round(W_K * iso / W_FLOOR_DIV))


def weights_noise_table(a, b, black, white):
    """the v9 weights table from weights_noise_consts (a, b) (integers): shift = noise_table's for the range white - black;
    entry[bin] = max(1, (isqrt(a * mc + b) + 128) >> 8), mc = min(bin centre, range), bin centre = (bin << shift) + (1 << shift) // 2.
    a * mc + b < 2^64 for every ISO up to 819200 and a range up to 65535 (a < 2.2e13)."""
    import math
    rng = int(white) - int(black)
    assert rng > 0
    shift = max(0, int(rng - 1).bit_length() - 8)
    tbl = np.zeros(NOISE_BINS, dtype=np.int64)
    for i in range(NOISE_BINS):
        mc = min((i << shift) + ((1 << shift) >> 1), rng)
        v = int(a) * mc + int(b)
        assert 0 <= v < 1 << 64
        tbl[i] = max(1, (math.isqrt(v) + 128) >> 8)
    return tbl, shift


def weights_noise_for(iso_label, hc_applied, black, white):
    """convenience for DNGs: ISO_real = label / 2 when highlight correction was applied, else the label.  (The camera uses the
    ISO table entry 3 steps lower, which is label / 2 for every label from ISO 160 up: 3200 -> 1600, 25600 -> 12800, ...)"""
    a, b = weights_noise_consts(iso_label / 2 if hc_applied else iso_label)
    return weights_noise_table(a, b, black, white)


# ---------------------------------------------------------------------------------------------
# integer helpers

def _check_int(*arrs):
    for a in arrs:
        assert np.issubdtype(np.asarray(a).dtype, np.integer), np.asarray(a).dtype


def gray2(cfa):
    """Half-resolution gray: sum of each 2x2 Bayer block (int64)."""
    c = cfa.astype(np.int64)
    return c[0::2, 0::2] + c[0::2, 1::2] + c[1::2, 0::2] + c[1::2, 1::2]


def down(img, k):
    """k x k box mean with round-half-up, k*k a power of two.  Crops to a multiple of k."""
    h, w = img.shape[0] // k * k, img.shape[1] // k * k
    s = img[:h, :w].reshape(h // k, k, w // k, k).sum(axis=(1, 3))
    sh = (k * k).bit_length() - 1
    assert 1 << sh == k * k
    return (s + (1 << sh >> 1)) >> sh


def _pad(img, p):
    return np.pad(img, p, mode='reflect')


# ---------------------------------------------------------------------------------------------
# alignment

def pyramid(g0):
    lv = [g0]
    for f in LEVEL_FACTORS[1:]:
        lv.append(down(lv[-1], f))
    return lv


def _pads():
    """mirror padding per level, enough for the clamped offset plus a tile."""
    pads, scale = [], 1
    for l, f in enumerate(LEVEL_FACTORS):
        if l:
            scale *= f
        pads.append(-(-MAX_OFFSET // scale) + LEVEL_TILES[l] + LEVEL_RADII[l] + 2)
    return pads


def imedian(a):
    """integer median: the lower middle element of the sorted values"""
    v = np.sort(np.asarray(a, dtype=np.int64).ravel())
    return int(v[(len(v) - 1) // 2])


OPS = {'absdiff': 0}               # operation counter (absolute differences), for the compute budget


def _cost_list(refp, altp, pad, tile, y0, x0, oy, ox, chunk=4096):
    """L1 cost of tiles with origins (y0, x0) (level pixels, 1-D arrays) at offsets (oy, ox)."""
    n = len(y0)
    out = np.empty(n, dtype=np.int64)
    if n == 0:
        return out
    i = np.arange(tile)
    W = refp.shape[1]
    rf, af = refp.ravel(), altp.ravel()
    for k0 in range(0, n, chunk):
        k1 = min(n, k0 + chunk)
        ry = (pad + y0[k0:k1])[:, None, None] + i[None, :, None]
        rx = (pad + x0[k0:k1])[:, None, None] + i[None, None, :]
        ref = rf[ry * W + rx]
        alt = af[(ry + oy[k0:k1, None, None]) * W + rx + ox[k0:k1, None, None]]
        out[k0:k1] = np.abs(ref - alt).sum(axis=(1, 2))
    OPS['absdiff'] += n * tile * tile
    return out


def _coarse_map(c, f, ptile, pn):
    """nearest and next-nearest coarse tile index (non-overlapping coarse tiles of size ptile) for fine
    coordinates c (tile centres, fine pixels); coarse tile j covers fine [f*ptile*j, f*ptile*(j+1))."""
    span = f * ptile
    j = c // span
    rem = c - j * span
    other = np.where(2 * rem < span, j - 1, j + 1)
    return np.clip(j, 0, pn - 1), np.clip(other, 0, pn - 1)


def _search(refp, altp, pad, tile, y0, x0, starts, rad, lim):
    """best offset per tile over the union of (2*rad+1)^2 neighbourhoods of the given starts.
    Starts equal to an earlier start of the same tile are skipped (counted once).
    Key = (cost, distance from its start, scan order)."""
    n = len(y0)
    best = np.full(n, np.iinfo(np.int64).max, dtype=np.int64)
    by = np.zeros(n, dtype=np.int64)
    bx = np.zeros(n, dtype=np.int64)
    bc = np.zeros(n, dtype=np.int64)
    idx = 0
    seen = []
    for sy, sx in starts:
        dup = np.zeros(n, dtype=bool)
        for qy, qx in seen:
            dup |= (qy == sy) & (qx == sx)
        seen.append((sy, sx))
        live = np.nonzero(~dup)[0]
        for dy in range(-rad, rad + 1):
            for dx in range(-rad, rad + 1):
                if len(live):
                    oy = np.clip(sy[live] + dy, -lim, lim)
                    ox = np.clip(sx[live] + dx, -lim, lim)
                    c = _cost_list(refp, altp, pad, tile, y0[live], x0[live], oy, ox)
                    k = (c << 16) + ((abs(dy) + abs(dx)) << 8) + idx
                    m = k < best[live]
                    sel = live[m]
                    best[sel], by[sel], bx[sel], bc[sel] = k[m], oy[m], ox[m], c[m]
                idx += 1
    return by, bx, bc


def _grid(h, w, tile):
    ny, nx = -(-h // tile), -(-w // tile)
    gy, gx = np.meshgrid(np.arange(ny), np.arange(nx), indexing='ij')
    return ny, nx, (gy * tile).ravel(), (gx * tile).ravel()


def align_pair(ref_lv, alt_lv, e0a, return_levels=False):
    """Alignment of alt to ref on non-overlapping tiles at every level.
    Returns (oy, ox, g) : level-0 offsets in half-res pixels, arrays (ny0, nx0) over 16x16 tiles with
    origin 16*index, and the global offset g = (gy, gx).
    e0a: Q8 expected mean |diff| (noise) of each level-0 alignment tile, array (ny0, nx0).
    Level 2..1: candidates = nearest coarse tile and its two next-nearest neighbours (v10; up to v9 also the coarse
    median), deduplicated, each with a full local search.  Level 0: global offset (2 x level-1 median refined by
    +-1 on every 4th tile row/column); a tile whose cost there is within RATIO_LO of noise keeps it;
    the others search locally and keep the global offset unless beaten by GLOBAL_MARGIN."""
    pads = _pads()
    L = len(LEVEL_FACTORS)
    levels = []
    prev = None
    for l in range(L - 1, 0, -1):
        tile, rad, pad = LEVEL_TILES[l], LEVEL_RADII[l], pads[l]
        h, w = ref_lv[l].shape
        ny, nx, y0, x0 = _grid(h, w, tile)
        refp, altp = _pad(ref_lv[l], pad), _pad(alt_lv[l], pad)
        lim = -(-MAX_OFFSET // int(np.prod(LEVEL_FACTORS[:l + 1])))
        if prev is None:
            z = np.zeros(ny * nx, dtype=np.int64)
            starts = [(z, z)]
        else:
            starts = _upsampled_starts(prev, LEVEL_FACTORS[l + 1], y0, x0, tile, lim)
        fy, fx, fc = _search(refp, altp, pad, tile, y0, x0, starts, rad, lim)
        prev = (fy.reshape(ny, nx), fx.reshape(ny, nx), tile)
        levels.append((l, prev[0], prev[1]))
        if l == 1:
            cost1 = fc.reshape(ny, nx)
    # level 0
    tile, rad, pad = LEVEL_TILES[0], LEVEL_RADII[0], pads[0]
    h, w = ref_lv[0].shape
    ny, nx, y0, x0 = _grid(h, w, tile)
    assert e0a.shape == (ny, nx)
    refp, altp = _pad(ref_lv[0], pad), _pad(alt_lv[0], pad)
    lim = MAX_OFFSET
    f = LEVEL_FACTORS[1]
    g1y, g1x = imedian(prev[0]) * f, imedian(prev[1]) * f
    sp = ((np.arange(ny)[:, None] % 4 == 1) & (np.arange(nx)[None, :] % 4 == 1)).ravel()
    if not sp.any():
        sp[:] = True
    bestk, gy, gx = None, g1y, g1x
    k = 0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cy, cx = int(np.clip(g1y + dy, -lim, lim)), int(np.clip(g1x + dx, -lim, lim))
            n = int(sp.sum())
            tot = int(_cost_list(refp, altp, pad, tile, y0[sp], x0[sp], np.full(n, cy), np.full(n, cx)).sum())
            key = (tot, abs(dy) + abs(dx), k)
            k += 1
            if bestk is None or key < bestk:
                bestk, gy, gx = key, cy, cx
    N = ny * nx
    GY, GX = np.full(N, gy, dtype=np.int64), np.full(N, gx, dtype=np.int64)
    cg = _cost_list(refp, altp, pad, tile, y0, x0, GY, GX)
    e0f = e0a.ravel()
    need = (cg * 256) // e0f > RATIO_LO_Q8
    oy, ox = GY.copy(), GX.copy()
    li = np.nonzero(need)[0]
    if len(li):
        st = _upsampled_starts(prev, f, y0[li], x0[li], tile, lim)
        st.append((GY[li], GX[li]))
        sy, sx, sc = _search(refp, altp, pad, tile, y0[li], x0[li], st, rad, lim)
        take = sc + ((GLOBAL_MARGIN_Q8 * e0f[li]) >> 8) <= cg[li]
        oy[li] = np.where(take, sy, GY[li])
        ox[li] = np.where(take, sx, GX[li])
    oy, ox = oy.reshape(ny, nx), ox.reshape(ny, nx)
    levels.append((0, oy, ox))
    _check_int(oy, ox)
    if return_levels:
        return oy, ox, (gy, gx), cost1, levels, need.reshape(ny, nx)
    return oy, ox, (gy, gx), cost1


def _upsampled_starts(prev, f, y0, x0, tile, lim):
    py, px, ptile = prev
    pny, pnx = py.shape
    cy, cx = y0 + tile // 2, x0 + tile // 2
    ny_, oy_ = _coarse_map(cy, f, ptile, pny)
    nx_, ox_ = _coarse_map(cx, f, ptile, pnx)
    st = []
    for iy, ix in ((ny_, nx_), (ny_, ox_), (oy_, nx_)):
        st.append((np.clip(py[iy, ix] * f, -lim, lim), np.clip(px[iy, ix] * f, -lim, lim)))
    return st                                                       # v10: no coarse-median start (HDR+: 3 candidates)


def block_means(g0, tile):
    """mean per Bayer pixel (gray/4) of non-overlapping tile x tile blocks (origin tile*index), floor;
    partial blocks at the edges are filled by mirror reflection."""
    h, w = g0.shape
    ny, nx = -(-h // tile), -(-w // tile)
    gp = np.pad(g0, ((0, ny * tile - h), (0, nx * tile - w)), mode='reflect')
    s = gp.reshape(ny, tile, nx, tile).sum(axis=(1, 3))
    return s // (tile * tile * 4)


def tile_noise(mean_pix, black, ntab, nshift):
    """Q8 expected mean |diff| of two half-res gray samples (noise only), from a mean level per Bayer pixel."""
    x = np.maximum(mean_pix - black, 0) >> nshift
    return ntab[np.minimum(x, NOISE_BINS - 1)]


# ---------------------------------------------------------------------------------------------
# merge (v3: per-pixel weights on the half-res grid, design round 2)
#
# For every alternate frame z and half-res pixel q (one 2x2 Bayer block), on three colour planes c of the
# block: R and B (one Bayer pixel each) and G (sum of the block's two greens):
#   D_c(q) = |ref_c(q) - alt_c(q + off(q))|, off(q) = offset of the 16x16 alignment tile holding q
#   S_c(q) = sum of D_c over the 3x3 neighbourhood of q (mirror at the edges)
#   E_c(q) = expected mean |diff| of one sample of plane c, from the noise table at the 3x3 mean level of
#            ref_c per Bayer pixel: R, B: e0 >> 1 ; G (sum of 2): (e0 * 181) >> 8  (e0 = table value for
#            the 4-pixel gray sum, so one pixel is e0/2 and two pixels e0/sqrt(2))
#   r(q)  = max over c of (S_c << 16) // (9 * E_c)            ratio of mean |diff| to noise, Q8
#   w(q)  = 64 if r <= PIX_LO_Q8, 0 if r >= PIX_HI_Q8, else ((PIX_HI_Q8 - r) * 64) // (PIX_HI_Q8 - PIX_LO_Q8)
#   w     = 3x3 minimum of w (mirror at the edges)
# (HDR+ judges each colour plane separately, Night Sight takes the minimum weight over colour channels;
# v3/v4 compared the gray sum only and missed equal-luminance colour changes.)
# The four Bayer pixels of q share w(q).  out = round((64*ref + sum_z w_z * alt_z(p + 2*off)) / (64 + sum_z w_z))
# computed as (num * RCP[den] + 2^(RCP_BITS-1)) >> RCP_BITS with RCP[d] = round(2^RCP_BITS / d).
# The alignment still uses the gray sum.

# Calibrated once (design round 5): with HI/LO kept at 2.5/1.6, LO is the smallest value on a 0.2 grid for which
# pure-noise bursts (synthetic, even shifts, 4 frames, two public DNGs, ISO 3200/800/200 equivalent) keep a
# mean weight >= 0.97 in every case.  Measured minimum mean weight: LO 1.6 -> 0.919, 1.8 -> 0.969,
# 2.0 -> 0.987.  Not to be tuned further.
PIX_LO_Q8 = 512                   # 2.0
PIX_HI_Q8 = 800                   # 3.125
# Block check (v6, design round 6): on 8x8 half-res blocks (non-overlapping, origin 8*index, mirror-filled at the
# edges), per colour plane c, M_c = |sum of (ref_c - alt_c(q + off))| over the 64 samples (signed sum, then
# absolute value: noise cancels, a uniform brightness offset does not).  Expected value under pure noise:
# 8 * e_c (e_c = expected mean |diff| of one sample, as above).  r2 = max over c of M_c / (8 e_c), Q8:
# (M_c << 13) // e_c_q8.  Block weight: 64 if r2 <= BLK_LO_Q8, 0 if r2 >= BLK_HI_Q8, linear in between.
# Under pure noise r2 is half-normal with mean 1: 3.3 ~ 1 % of blocks start to drop, 5.0 ~ 4 standard
# deviations.  Derived, not tuned.  Final weight per half-res pixel = min(pixel weight, its block weight).
# Brightness normalisation (v7, design round 8): GR IV bursts differ by 0.3-2 % in overall exposure from frame to
# frame.  After alignment, k = median over level-0 16x16 tiles of (alt tile gray sum - black) / (ref tile gray
# sum - black), Q12, using tiles whose reference mean lies in 5 %..80 % of the range above black; fewer than
# NORM_MIN_TILES tiles -> k = 4096.  |k - 4096| > NORM_MAX_DEV_Q12 (8 %) -> the frame is not used.  Then every
# alternate pixel v -> black + (((v - black) * M + 2^23) >> 24), M = round(2^36 / k), limited to 0..65535 (v8: 0..vmax),
# before the weights and the accumulation (alignment uses the raw frame).
NORM_MIN_TILES = 50
NORM_MAX_DEV_Q12 = 328            # 8 % of 4096
BLK = 8
BLK_LO_Q8 = 845                   # 3.3
BLK_HI_Q8 = 1280                  # 5.0
W6_ONE = 64
MAX_FRAMES = 8
RCP_BITS = 24
RCP = np.array([0] + [((1 << RCP_BITS) + d // 2) // d for d in range(1, W6_ONE * MAX_FRAMES + 1)], dtype=np.int64)


def _box3(a):
    p = np.pad(a, 1, mode='reflect')
    h, w = a.shape
    return sum(p[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3))


def _min3(a):
    p = np.pad(a, 1, mode='reflect')
    h, w = a.shape
    m = p[0:h, 0:w]
    for dy in range(3):
        for dx in range(3):
            m = np.minimum(m, p[dy:dy + h, dx:dx + w])
    return m


def _expand(t, tile, h, w):
    return np.repeat(np.repeat(t, tile, axis=0), tile, axis=1)[:h, :w]


def planes(cfa, green_diag=False):
    """R-or-B, G-sum, B-or-R planes of each 2x2 block (int64).  green_diag=False for RGGB/BGGR (greens at
    (0,1),(1,0)), True for GRBG/GBRG.  Which single plane is red does not matter here."""
    c = cfa.astype(np.int64)
    a, b, d, e = c[0::2, 0::2], c[0::2, 1::2], c[1::2, 0::2], c[1::2, 1::2]
    return (b, a + e, d) if green_diag else (a, b + d, e)


def _blk_sum(a, b=BLK):
    """sums over non-overlapping b x b blocks (origin b*index), partial edge blocks mirror-filled"""
    h, w = a.shape
    ny, nx = -(-h // b), -(-w // b)
    p = np.pad(a, ((0, ny * b - h), (0, nx * b - w)), mode='reflect')
    return p.reshape(ny, b, nx, b).sum(axis=(1, 3))


class Reference:
    """Everything the merge keeps about the reference frame."""

    def __init__(self, ref, black, ntab, nshift, green_diag=False, white=None, vmax=None, ntab_w=None, nshift_w=None):
        self.green_diag = green_diag
        if vmax is not None:
            vmax = int(vmax)
            assert 0 < vmax <= 65535, vmax
        self.vmax = vmax
        if white is None:
            raise ValueError('white level required (brightness normalisation)')
        self.white = int(white)
        assert ref.dtype == np.uint16 and ref.shape[0] % 2 == 0 and ref.shape[1] % 2 == 0
        self.ref, self.black, self.ntab, self.nshift = ref, black, ntab, nshift
        g = gray2(ref)
        self.g = g
        self.lv = pyramid(g)
        self.e0a = tile_noise(block_means(g, LEVEL_TILES[0]), black, ntab, nshift)
        # per-plane noise of a 3x3 sum: R and B one pixel each, G the sum of two
        self.pl = planes(ref, green_diag)
        if ntab_w is not None:                                      # v9: the weights' own noise table (None = ntab, v8)
            ntab, nshift = np.asarray(ntab_w, dtype=np.int64), int(nshift_w)
        e9 = []
        for k, p in enumerate(self.pl):
            m3 = _box3(p) // (18 if k == 1 else 9)                  # 3x3 mean level per Bayer pixel
            e0 = tile_noise(m3, black, ntab, nshift)
            e9.append(9 * (((e0 * 181) >> 8) if k == 1 else (e0 >> 1)))
        self.e9 = e9
        # block-check noise: e_c per 8x8 block from the block's mean level per Bayer pixel
        eb = []
        for k, p in enumerate(self.pl):
            mb = _blk_sum(p) // (BLK * BLK * (2 if k == 1 else 1))
            e0 = tile_noise(mb, black, ntab, nshift)
            eb.append(((e0 * 181) >> 8) if k == 1 else (e0 >> 1))
        self.eb = eb


VERSION = 10


def weights(R, alt):
    """Alignment and per-pixel weights of one alternate frame. Returns (w (h2,w2) 0..64, debug)."""
    alt_lv = pyramid(gray2(alt))
    ay, ax, g, _, levels, need = align_pair(R.lv, alt_lv, R.e0a, return_levels=True)
    dbg = dict(oy=ay, ox=ax, g=g, searched=float(need.mean()))
    h2, w2 = R.g.shape
    oyq, oxq = _expand(ay, LEVEL_TILES[0], h2, w2), _expand(ax, LEVEL_TILES[0], h2, w2)
    P = MAX_OFFSET + 2
    qy = np.arange(h2)[:, None] + oyq + P
    qx = np.arange(w2)[None, :] + oxq + P
    # brightness normalisation (v7)
    T0 = LEVEL_TILES[0]
    galt = _pad(alt_lv[0], P)[qy, qx]                               # alt gray aligned with level-0 offsets
    sr = _blk_sum(R.g, T0) - 4 * R.black * T0 * T0
    sa = _blk_sum(galt, T0) - 4 * R.black * T0 * T0
    mr = _blk_sum(R.g, T0) // (T0 * T0 * 4) - R.black                # mean per Bayer pixel above black
    span = R.white - R.black
    ok = (20 * mr >= span) & (5 * mr <= 4 * span) & (sr > 0) & (sa > 0)
    if int(ok.sum()) >= NORM_MIN_TILES:
        k = imedian((sa[ok] << 12) // sr[ok])
    else:
        k = 4096
    dbg['k'] = int(k)
    if abs(int(k) - 4096) > NORM_MAX_DEV_Q12:
        dbg.update(rejected=True, wmean=0.0)
        return None, dbg
    M = ((1 << 36) + k // 2) // k
    top = 65535 if R.vmax is None else R.vmax                       # v8: normalised pixels limited to vmax
    if M == 1 << 24:
        altn = alt                                                 # identity: used as it is
    else:
        altn = np.clip(R.black + (((alt.astype(np.int64) - R.black) * M + (1 << 23)) >> 24), 0, top).astype(np.uint16)
    dbg['altn'] = altn
    pa = planes(altn, R.green_diag)
    r = None
    r2 = None
    for k in range(3):
        apad = _pad(pa[k], P)
        Ds = R.pl[k] - apad[qy, qx]                                  # signed difference
        rk = (_box3(np.abs(Ds)) << 16) // np.maximum(R.e9[k], 1)
        r = rk if r is None else np.maximum(r, rk)
        bk = (np.abs(_blk_sum(Ds)) << 13) // np.maximum(R.eb[k], 1)
        r2 = bk if r2 is None else np.maximum(r2, bk)
    w = np.where(r <= PIX_LO_Q8, W6_ONE, np.where(r >= PIX_HI_Q8, 0, ((PIX_HI_Q8 - r) * W6_ONE) // (PIX_HI_Q8 - PIX_LO_Q8)))
    w = _min3(w)
    wb = np.where(r2 <= BLK_LO_Q8, W6_ONE, np.where(r2 >= BLK_HI_Q8, 0, ((BLK_HI_Q8 - r2) * W6_ONE) // (BLK_HI_Q8 - BLK_LO_Q8)))
    w = np.minimum(w, _expand(wb, BLK, h2, w2))
    OPS['merge_px'] = OPS.get('merge_px', 0) + h2 * w2
    dbg.update(rejected=False, wmean=float(w.mean()) / W6_ONE, w=w, offy=oyq, offx=oxq)
    return w, dbg


def merge(frames, black, ntab, nshift, return_debug=False, green_diag=False, white=None, vmax=None, ntab_w=None, nshift_w=None):
    """frames: list of uint16 Bayer mosaics, frames[0] = reference (in the camera: the last frame of the
    group).  black: integer black level (mean of the four CFA levels).  ntab, nshift: noise_table().
    white: white level (required; brightness normalisation picks tiles by level).
    vmax: v8, largest value of the sensor container ((1 << bits) - 1) or None (no limit, v7).
    ntab_w, nshift_w: v9, the weights' own noise table (weights_noise_table) or None (ntab for everything, v8)."""
    ref = frames[0]
    for f in frames:
        assert f.shape == ref.shape and f.dtype == np.uint16
    assert len(frames) <= MAX_FRAMES
    R = Reference(ref, black, ntab, nshift, green_diag, white, vmax, ntab_w, nshift_w)
    H, W = ref.shape
    num = ref.astype(np.int64) * W6_ONE
    den = np.full((H // 2, W // 2), W6_ONE, dtype=np.int64)
    dbg = []
    P = 2 * (MAX_OFFSET + 2)
    for alt in frames[1:]:
        w, d = weights(R, alt)
        dbg.append(d)
        if w is None or not w.any():
            continue
        ap = _pad(d['altn'].astype(np.int64), P)
        by = np.arange(H)[:, None] + 2 * np.repeat(np.repeat(d['offy'], 2, 0), 2, 1) + P
        bx = np.arange(W)[None, :] + 2 * np.repeat(np.repeat(d['offx'], 2, 0), 2, 1) + P
        wb = np.repeat(np.repeat(w, 2, 0), 2, 1)
        num += wb * ap[by, bx]
        den += w
    denb = np.repeat(np.repeat(den, 2, 0), 2, 1)
    out = (num * RCP[denb] + (1 << (RCP_BITS - 1))) >> RCP_BITS
    _check_int(out)
    assert int(out.max()) <= 65535
    if vmax is not None:
        out = np.minimum(out, R.vmax)                              # v8: second guard (the reference may exceed vmax)
    out = out.astype(np.uint16)
    return (out, dbg) if return_debug else out
