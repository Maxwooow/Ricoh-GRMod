# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the date imprint with the look's name (0.8.4; tools/datestamp/datestamp.c).

NOT part of the program. Runs the compiled module (core/src/fw/aspect/datestamp-code.ts) in Unicorn
with orient_check.py's pictures, for both styles with the name (setting bit 3), every orientation
(and "Follow Orientation" off), photos 3:2, 1:1 and XPan (also held upright), and names short, long
and too long for the picture:

  1. without a name for the look (none in the table, or no valid look word) the picture is exactly
     the date alone (the style without bit 3);
  2. the thumbnail always gets the date alone;
  3. in the main picture and the screennail the line is inside the photo, bottom right as the
     picture is shown, with at least about one digit height of margin on the left;
  4. the name is that of the look at the start of the exposure (FRAME_LOOK), else of LOOK_STASH;
  5. the line is never wider than the photo: a long name is drawn smaller or cut short, and where
     not even its first letter fits, the date alone is drawn;
  6. the number of instructions per picture (L 3:2), against the date alone.

    python3 name_check.py [OUTDIR]     # OUTDIR: PNGs of the main pictures (cropped) and screennails

Needs the Python packages unicorn, numpy (and Pillow for OUTDIR).
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import orient_check as oc  # noqa: E402

# The build's encoding (core/src/fw/aspect/datestamp.ts: lookNameGlyphs, LETTER_SEGMENTS).
A, B, C, D, E, F, G1, G2, UL, UM, UR, LL, LM, LR = (1 << i for i in range(14))
SEG = {
    'A': A | B | C | E | F | G1 | G2, 'B': A | B | C | D | G2 | UM | LM, 'C': A | D | E | F, 'D': A | B | C | D | UM | LM,
    'E': A | D | E | F | G1 | G2, 'F': A | E | F | G1 | G2, 'G': A | C | D | E | F | G2, 'H': B | C | E | F | G1 | G2,
    'I': A | D | UM | LM, 'J': B | C | D | E, 'K': E | F | G1 | UR | LR, 'L': D | E | F, 'M': B | C | E | F | UL | UR,
    'N': B | C | E | F | UL | LR, 'O': A | B | C | D | E | F, 'P': A | B | E | F | G1 | G2, 'Q': A | B | C | D | E | F | LR,
    'R': A | B | E | F | G1 | G2 | LR, 'S': A | C | D | F | G1 | G2, 'T': A | UM | LM, 'U': B | C | D | E | F, 'V': E | F | LL | UR,
    'W': B | C | E | F | LL | LR, 'X': UL | UR | LL | LR, 'Y': UL | UR | LM, 'Z': A | D | UR | LL,
    '+': G1 | G2 | UM | LM, '-': G1 | G2, '&': A | D | E | UL | G1 | LR | UM, '(': UR | LR, ')': UL | LL,
}


def encode(name):
    out = []
    for ch in name.upper():
        if ch.isdigit():
            g = int(ch)
        elif ch == '.':
            g = 18
        elif ch in SEG:
            g = 0x4000 | SEG[ch]
        else:
            g = 17
        if g == 17 and (not out or out[-1] == 17):
            continue
        out.append(g)
    while out and out[-1] == 17:
        out.pop()
    return out[:24]


NAMES = {11: encode('Standard'), 23: encode('Cross Processing'), 34: encode('GR Mod 12'), 40: encode('Hi-Contrast B&W Kodak Gold')}
LOOK = 0x10000
failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


def arr(out, which):
    P = out[which] if which != 'M' else out['M']
    buf = out[which + '_buf'] if which != 'M' else out['main_buf']
    off = P.y - P.base
    a = np.frombuffer(buf, np.uint8)
    return np.stack([a[off + r * P.stride: off + r * P.stride + P.w] for r in range(P.h)])


def shown(a, o):
    return a if o == 0 else np.rot90(a, {1: 1, 2: 2, 3: -1}[o])


def box(a, ref):
    d = np.argwhere(a != ref)
    if not len(d):
        return None
    (y0, x0), (y1, x1) = d.min(0), d.max(0)
    return int(x0), int(y0), int(x1), int(y1)


def run(setting, main_wh, src_wh, o, look, frame=None, names=NAMES, count=False):
    return oc.run(oc.CODE, setting, main_wh, src_wh, look=look, orient=0x100 | o, frame=frame, names=names, count=count)


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        from PIL import Image
    # (name, main w x h, sensor window w x h): photos 3:2 (size M), 1:1, XPan (65:24).
    scenarios = [('M32', (4944, 3296), (6192, 4128)), ('M11', (3296, 3296), (4128, 4128)), ('Mxpan', (4944, 1812), (6192, 2272))]
    n = 0
    for name, mwh, swh in scenarios:
        for o in (0, 1, 2, 3):
            for base in (1, 3) + ((5, 7) if o in (0, 3) else ()):   # short / long, Follow Orientation on (/ off)
                oo = 0 if base & 4 else o      # where the line goes (as stored when Follow Orientation is off)
                date = run(base, mwh, swh, o, LOOK | 23)
                planes = {k: arr(date, k) for k in ('M', 'sn', 'th')}
                # 1. no name for the look: the date alone
                for look, frame in ((LOOK | 24, None), (LOOK | 24, LOOK | 25), (0, 0)):
                    x = run(base | 8, mwh, swh, o, look, frame)
                    check(all(np.array_equal(arr(x, k), planes[k]) for k in ('M', 'sn', 'th')), f'{name} o{o} {base}: look {look:#x} frame {frame}: not the date alone')
                for look in (11, 23, 34, 40):
                    x = run(base | 8, mwh, swh, o, LOOK | 24, LOOK | look)
                    n += 1
                    # 2. thumbnail: the date alone
                    check(np.array_equal(arr(x, 'th'), planes['th']), f'{name} o{o} {base} look {look}: thumbnail is not the date alone')
                    for k in ('M', 'sn'):
                        P = x[k] if k != 'M' else x['M']
                        a = arr(x, k)
                        bx = box(a, oc.BG_Y if k == 'M' else planes[k])
                        if bx is None:
                            check(False, f'{name} o{o} {base} look {look} {k}: nothing drawn')
                            continue
                        # 3. inside the photo (stored coordinates), placed bottom right as shown
                        if k == 'M':
                            ax, ay, aw, ah = 0, 0, P.w, P.h
                        else:
                            ax, ay, aw, ah = P.area
                        x0, y0, x1, y1 = bx
                        check(ax <= x0 and x1 < ax + aw and ay <= y0 and y1 < ay + ah, f'{name} o{o} {base} look {look} {k}: {bx} outside the photo {P.area if k != "M" else (P.w, P.h)}')
                        s = shown(a, oo)
                        photo = np.zeros(a.shape, bool)
                        photo[ay:ay + ah, ax:ax + aw] = True
                        sp = shown(photo, oo)
                        rows, cols = np.where(sp)
                        px0, px1, py1 = cols.min(), cols.max(), rows.max()
                        sb = box(s, oc.BG_Y) if k == 'M' else box(s, shown(planes[k], oo))
                        if k == 'M' and sb:
                            h = sb[3] - sb[1] + 1
                            check(sb[0] - px0 >= h * 0.9, f'{name} o{o} {base} look {look} {k}: left margin {sb[0] - px0} for height {h}')
                            check(px1 - sb[2] >= h, f'{name} o{o} {base} look {look} {k}: right margin {px1 - sb[2]}')
                            check(py1 - sb[3] >= h * 0.9, f'{name} o{o} {base} look {look} {k}: bottom margin {py1 - sb[3]}')
                        # the name is there: the line is longer than the date alone (main picture)
                        if k == 'M':
                            db = box(shown(planes['M'], oo), oc.BG_Y)
                            check(sb[2] - sb[0] > db[2] - db[0], f'{name} o{o} {base} look {look}: no name drawn {sb} vs date {db}')
                    if out_dir and o in (0, 3) and base in (1, 3):
                        a = shown(arr(x, 'M'), o)
                        b = box(a, oc.BG_Y)
                        Image.fromarray(a[max(0, b[1] - 60):b[3] + 60, max(0, b[0] - 60):b[2] + 60]).save(out_dir / f'{name}_o{o}_s{base | 8}_look{look}_main.png')
                        Image.fromarray(shown(arr(x, 'sn'), o)).save(out_dir / f'{name}_o{o}_s{base | 8}_look{look}_sn.png')
                # 4. FRAME_LOOK wins over LOOK_STASH; without it LOOK_STASH counts
                a = run(base | 8, mwh, swh, o, LOOK | 11, LOOK | 23)
                b = run(base | 8, mwh, swh, o, LOOK | 23, 0)
                check(all(np.array_equal(arr(a, k), arr(b, k)) for k in ('M', 'sn', 'th')), f'{name} o{o} {base}: FRAME_LOOK / LOOK_STASH')
            print(f'  {name} orientation {o}: checked', flush=True)
    # 5. a picture too narrow even for the first letter: XPan screennail held upright with the long
    # date (checked above for inside / date alone); here a name too long at every size is cut short.
    x = run(11, (4944, 1812), (6192, 2272), 3, LOOK | 24, LOOK | 40)
    full = box(shown(arr(x, 'M'), 3), oc.BG_Y)
    print('  XPan upright, long date + long name: line', full, 'picture shown', (1812, 4944))
    # 6. cost (L 3:2, main + screennail + thumbnail), against the date alone
    costs = {}
    for setting, look, label in ((1, 23, 'short'), (3, 23, 'long'), (9, 11, 'short + Standard'), (9, 23, 'short + Cross Processing'),
                                 (11, 23, 'long + Cross Processing'), (11, 40, 'long + 26-letter name')):
        x = run(setting, (6192, 4128), (6192, 4128), 0, LOOK | look, LOOK | look, count=True)
        costs[label] = x['instr']
    for k, v in costs.items():
        print(f'  instructions, L 3:2, {k}: {v / 1e6:.1f} M')
    print(f'  {n} pictures with names checked')
    print('FAILED:\n  ' + '\n  '.join(failures[:40]) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
