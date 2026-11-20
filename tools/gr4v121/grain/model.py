# SPDX-License-Identifier: GPL-2.0-only
"""Film grain (grain.c): the tables, and a numpy model that gives the same bytes as the module.

`python3 model.py` writes core/src/fw/gr4v120/aspect/grain-tables.ts (shared by 1.21) (the tables the build puts in
the firmware). Look: texture that still shows when the photo is seen
whole on a phone, but never reads as a fault: luminance only, soft clumps of a few sizes instead of
pixel noise, strongest in the midtones, fading out towards skin, sky and deep shadow.
"""
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
OUT = ROOT / 'core' / 'src' / 'fw' / 'gr4v120' / 'aspect' / 'grain-tables.ts'   # shared by 1.21 (core/overlays.mjs)

FULL_WIDTH = 6192
OCTAVES = 4
# Strength (weak, medium, strong): standard deviation of the grain in the midtones, in levels of 255.
PEAK = (2.2, 3.2, 4.4)
# Brightness response (of the Y value): 1 in the midtones, less towards skin / sky and deep shadows.
CURVE_AT = (0, 8, 24, 48, 80, 110, 140, 165, 190, 215, 240, 255)
CURVE = (0, .15, .40, .72, .95, 1.0, .88, .60, .30, .12, .03, 0)
# Size (small, medium, large): grid shift (1 << shift pixels) and share of each octave (amplitude).
SIZES = (((1, .75), (2, .25)), ((1, .55), (2, .30), (3, .15)), ((1, .35), (2, .40), (3, .25)))


def amp_table():
    i = np.arange(256)
    c = np.interp(i, CURVE_AT, CURVE)
    return np.array([np.round(16 * p * c) for p in PEAK], dtype=np.uint8)


def mix(v):
    v = np.uint32(v)
    v ^= v >> np.uint32(16); v = np.uint32((int(v) * 0x7feb352d) & 0xffffffff)
    v ^= v >> np.uint32(15); v = np.uint32((int(v) * 0x846ca68b) & 0xffffffff)
    v ^= v >> np.uint32(16)
    return int(v)


def raw_row(n, seed, o, r):
    s = mix((seed ^ ((r * 0x9e3779b1) & 0xffffffff) ^ ((o * 0x85ebca77) & 0xffffffff)) & 0xffffffff) or 1
    out = np.empty((n + 3) // 4 * 4, dtype=np.int8)
    for i in range(0, n, 4):
        s ^= (s << 13) & 0xffffffff; s ^= s >> 17; s ^= (s << 5) & 0xffffffff
        out[i:i + 4] = np.frombuffer(struct.pack('<I', s), dtype=np.int8)
    return out[:n].astype(np.int32)


def smooth(a, b, c):
    v = a + 2 * b + c
    return (v[:-2] + 2 * v[1:-1] + v[2:]).astype(np.int32)


def layers(w, oct_):
    L = 0
    while L < 8 and (w << (L + 1)) <= FULL_WIDTH + (FULL_WIDTH >> 1) - (FULL_WIDTH >> 3):
        L += 1
    out = []
    for s, wt in oct_:
        if not wt:
            continue
        if s >= L:
            s -= L
        else:
            wt >>= L - s; s = 0
        if wt:
            out.append((s, wt))
    return out


def seed_of(Y):
    h, w = Y.shape
    seed = (w * 0x10001 + h) & 0xffffffff
    for y in range(16):
        r = Y[((y * 2 + 1) * h) >> 5]
        for x in range(16):
            seed = (seed * 31 + int(r[((x * 2 + 1) * w) >> 5])) & 0xffffffff
    return mix(seed)


def lerp(v, n, r):
    """n values: the row(s) v (one value every 1 << r) spread linearly, as grain.c does."""
    j = np.arange(n); i = j >> r; k = j & ((1 << r) - 1)
    return v[..., i] + (((v[..., i + 1] - v[..., i]) * k) >> r)


def grain_field(h, w, oct_, seed):
    """The grain (before the amplitude) at every pixel of a picture of h x w, as grain.c makes it."""
    ls = layers(w, oct_)
    f = min(s for s, _ in ls)
    gwf = (w >> f) + 3
    R = np.zeros((h, gwf), dtype=np.int64)
    for o, (s, wt) in enumerate(ls):
        gw = (w >> s) + 3
        gh = ((h - 1) >> s) + 2
        raws = [raw_row(gw + 2, seed, o, r) for r in range(gh + 2)]
        S = np.stack([smooth(raws[r], raws[r + 1], raws[r + 2]) for r in range(gh)]).astype(np.int64) * wt
        g = 1 << s
        y = np.arange(h); gy = y >> s; fy = (y & (g - 1))[:, None]
        vy = S[gy] + (((S[gy + 1] - S[gy]) * fy) >> s) if s else S[:h]
        R += lerp(vy, gwf, s - f) if s > f else vy[:, :gwf]
    return lerp(R, w, f) if f else R[:, :w]


def apply(Y, amp, oct_):
    """Y (uint8, h x w) with grain, exactly as the module does it."""
    acc = grain_field(*Y.shape, oct_, seed_of(Y))
    a = amp[Y].astype(np.int64)
    v = Y.astype(np.int64) + ((acc * a + (1 << 19)) >> 20)
    return np.clip(v, 0, 255).astype(np.uint8)


# Automatic strength. The picture's own fine texture t (see `texture`): about 7.9 * sigma of its
# noise, a little under (the quarter of the blocks with the least). The grain's share is what is
# missing to the texture the medium strength gives a clean picture, and at least half.
AUTO_FLOOR = 0.5


def gain_table():
    out = []
    for t in range(64):
        sigma = (t + 0.5) / 7.9 / 0.93
        share = np.sqrt(max(PEAK[1] ** 2 - sigma ** 2, 0.0)) / PEAK[1]
        out.append(int(round(255 * max(share, AUTO_FLOOR))))
    return np.array(out, dtype=np.uint8)


def texture(Y):
    """As grain.c: the picture's own fine texture, 0..63, or 64 when it cannot be measured."""
    h, w = Y.shape
    vals = []
    for j in range(64):
        y0 = ((2 * j + 1) * h) >> 7
        y0 = 0 if y0 < 4 else y0 - 4
        y0 = min(y0, h - 8)
        for i in range(64):
            x0 = ((2 * i + 1) * w) >> 7
            x0 = 0 if x0 < 4 else x0 - 4
            x0 = min(x0, w - 8)
            b = Y[y0:y0 + 8, x0:x0 + 8].astype(np.int64)
            mean = int(b.sum()) >> 6
            if mean < 24 or mean > 230:
                continue
            vals.append(min(int(np.abs(np.diff(b, axis=1)).sum()) >> 3, 63))
    if len(vals) < 256:
        return 64
    hist = np.bincount(vals, minlength=64)
    c = 0
    for i in range(64):
        c += int(hist[i])
        if c * 4 >= len(vals):
            return i
    return 63


def auto_amp(amp, gain, t):
    """The amplitude table of a picture whose texture is t."""
    g = int(gain[t]) if t < 64 else 255
    return ((amp[1].astype(np.int64) * (g + 1)) >> 8).astype(np.uint8)


def octave_tables():
    """Weights so that each Size's grain has a standard deviation of 65536 (amp 16 = one level)."""
    rng_seed = 12345
    h, w = 160, FULL_WIDTH
    unit = {}
    for s in range(4):
        f = grain_field(h, w, ((s, 1),), rng_seed + s)
        unit[s] = float(f[8:-8, 8:-8].std())
    out = []
    for size in SIZES:
        norm = np.sqrt(sum(a * a for _, a in size))
        row = []
        for s, a in size:
            wt = int(round(65536 * a / norm / unit[s]))
            if not 0 < wt < 256:
                sys.exit(f'weight {wt} out of range')
            row.append((s, wt))
        row += [(0, 0)] * (OCTAVES - len(row))
        out.append(tuple(row))
    return tuple(out)


def main():
    amp = amp_table()
    octs = octave_tables()
    flat = [b for size in octs for oct_ in size for b in oct_]
    OUT.write_text(
        '// SPDX-License-Identifier: GPL-2.0-only\n'
        '// GENERATED by tools/gr4v121/grain/model.py -- do not edit.\n'
        '/** Amplitude of the grain per Y value (1/16 level), for Strength weak, medium, strong. */\n'
        f'export const GRAIN_AMP: readonly number[] = [{", ".join(map(str, amp.flatten().tolist()))}];\n'
        '/** Per Size (small, medium, large): four octaves of {grid shift, weight}. */\n'
        f'export const GRAIN_OCTAVES: readonly number[] = [{", ".join(map(str, flat))}];\n'
        '/** Automatic strength: share of the amplitude (255: all) by the picture\'s own fine texture (0..63). */\n'
        f'export const GRAIN_GAIN: readonly number[] = [{", ".join(map(str, gain_table().tolist()))}];\n'
        f'export const GRAIN_FULL_WIDTH = {FULL_WIDTH};\n')
    print(OUT, octs)


if __name__ == '__main__':
    main()
