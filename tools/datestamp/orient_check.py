# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the date imprint's orientation (GR Mod 0.8.3).

NOT part of the program. Runs the compiled module (core/src/fw/aspect/datestamp-code.ts) in Unicorn
on synthetic pictures laid out like the camera's: the main picture as a window of the sensor
buffer, the 720x480 screennail and the 160x120 thumbnail with the photo inside black bars. The
orientation is in its own word, value | 0x100 (0 as stored, 1 / 2 / 3 = EXIF Orientation 8 / 3 / 6,
see lookstash.ts and datestamp.ts).

Checks, for L / M / S / XS of 3:2, 4:3, 16:9, 1:1 and the added XPan (65:24) and 5:4, both styles:

  - orientation 0 (and any build without a look word) draws exactly what the 0.8.2 module drew,
    byte for byte, on all three pictures (`--old FILE`: that module's datestamp-code.ts);
  - orientations 1, 2, 3: each picture turned the way a viewer applies the EXIF Orientation shows
    the imprint bottom right, reading normally: its light (Y) is exactly that of the imprint on an
    upright picture of the shown size (orientation 0), at the same place (+-1 pixel where the
    black bars of the screennail / thumbnail round differently); inside the photo area; orange; and
    nothing else in the picture changed.

  - the menu's "Follow Orientation" Off (bit 2 of the setting byte): as stored whatever the
    orientation word holds (the same pictures as orientation 0 and as 0.8.2); bytes above 7 draw
    nothing.

    python3 orient_check.py [--old OLD_datestamp-code.ts] [OUTDIR]

Needs the Python packages unicorn and Pillow (Pillow only with OUTDIR).
"""
import base64
import gc
import re
import struct
import sys
from pathlib import Path

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_BLOCK
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_SP, UC_ARM_REG_LR

ROOT = Path(__file__).resolve().parents[2]
ORG = 0x10000


def load_code(path):
    ts = Path(path).read_text()
    return base64.b64decode(re.search(r"DATESTAMP_CODE = '([^']+)'", ts).group(1))


CODE = load_code(ROOT / 'core/src/fw/aspect/datestamp-code.ts')

# (name, [(L), (M), (S), (XS)] main sizes, sensor window of the ratio (the L size))
RATIOS = [
    ('3:2', [(6192, 4128), (4944, 3296), (3504, 2336), (1920, 1280)]),
    ('4:3', [(5504, 4128), (4400, 3296), (3120, 2336), (1920, 1440)]),
    ('16:9', [(6192, 3480), (4944, 2784), (3504, 1968), (1920, 1080)]),
    ('1:1', [(4128, 4128), (3296, 3296), (2336, 2336), (1280, 1280)]),
    ('XPan', [(6192, 2272), (4944, 1812), (3504, 1284), (1920, 704)]),
    ('5:4', [(5160, 4128), (4120, 3296), (2920, 2336), (1600, 1280)]),
]
SIZES = ['L', 'M', 'S', 'XS']
BG_Y, BG_CB, BG_CR = 70, 120, 140      # photo
SN_Y = 120                             # photo part of screennail / thumbnail


def fit(W, H, sw, sh):
    """Photo of shape sw x sh centred in W x H (what the camera's screennail / thumbnail show)."""
    if W * sh > H * sw:
        rw, rh = H * sw // sh, H
    else:
        rw, rh = W, W * sh // sw
    return (W - rw) // 2, (H - rh) // 2, rw, rh


class Picture:
    """A picture in its own buffer: Y plane then CbCr plane (4:2:2, interleaved), `stride` bytes a row."""

    def __init__(self, base, w, h, stride, buf_h, window=(0, 0)):
        self.base, self.w, self.h, self.stride, self.buf_h = base, w, h, stride, buf_h
        self.y = base + window[1] * stride + window[0]
        self.c = base + stride * buf_h + window[1] * stride + window[0]
        self.size = (stride * buf_h * 2 + 0xfff) & ~0xfff


def run(code, setting, main_wh, src_wh, sn_wh=(720, 480), th_wh=(160, 120), look=None, mono=False,
        clock=(2026, 10, 8, 17, 34, 53), sensor=(6208, 4128), orient=None, frame=None, names=None, count=False):
    """main_wh: main picture; src_wh: the sensor window it was scaled from (its shape is the
    photo's); sn_wh / th_wh: screennail and thumbnail sizes (720x480 / 160x120, or turned for a
    reference); sensor: buffer stride and height of the main picture's buffer. look: None (no look
    word) or the word the development step left. orient: None (no orientation word) or its value
    (orientation | 0x100). frame: None or the FRAME_LOOK word (0.8.4); names: None or {look: [glyph,
    ...]}, the module's name table (0.8.4). count: also count the module's instructions ('instr').
    Returns the planes as bytes."""
    gc.collect()   # the previous emulator (its hook refers back to it) and its 50 MB of buffers
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(ORG, 0x10000)
    mu.mem_write(ORG, code)
    mu.mem_map(0x60000000, 0x100000)
    mu.mem_map(0x70000000, 0x100000)
    mw, mh = main_wh
    sw, sh = src_wh
    stride, buf_h = sensor
    ox = ((stride - 16 - sw) // 2) & ~1 if stride - 16 >= sw else 0
    oy = (buf_h - sh) // 2 if buf_h >= sh else 0
    M = Picture(0x80000000, mw, mh, stride, buf_h, (ox, oy))
    mu.mem_map(M.base, M.size)
    mu.mem_write(M.base, bytes([BG_Y]) * (stride * buf_h))
    mu.mem_write(M.base + stride * buf_h, (bytes([128, 128]) if mono else bytes([BG_CB, BG_CR])) * (stride * buf_h // 2))
    pics = {}
    for name, base, (W, H) in (('sn', 0x90000000, sn_wh), ('th', 0x92000000, th_wh)):
        st = (W + 15) & ~15
        P = Picture(base, W, H, st, H)
        mu.mem_map(base, P.size)
        y = bytearray(st * H)
        c = bytearray(bytes([128]) * (st * H))
        x0, y0, rw, rh = fit(W, H, sw, sh)
        for yy in range(y0, y0 + rh):
            y[yy * st + x0:yy * st + x0 + rw] = bytes([SN_Y]) * rw
            if not mono:
                c[yy * st + (x0 & ~1):yy * st + (x0 & ~1) + (rw & ~1)] = bytes([BG_CB, BG_CR]) * (rw // 2)
        mu.mem_write(P.y, bytes(y))
        mu.mem_write(P.c, bytes(c))
        P.area = (x0, y0, rw, rh)
        pics[name] = P

    STUB = 0x70000000
    for i in range(6):
        mu.mem_write(STUB + i * 16, struct.pack('<I', 0xe12fff1e))  # bx lr

    def hook(uc, addr, size, ud):
        i = (addr - STUB) // 16
        if i == 0:
            uc.reg_write(UC_ARM_REG_R0, 0x553a09c4)
        if i == 3:
            uc.reg_write(UC_ARM_REG_R0, 0x70001000)
        if i == 4:
            uc.mem_write(uc.reg_read(UC_ARM_REG_R1), struct.pack('<HBBBBB', *clock))
        if i == 5:
            uc.reg_write(UC_ARM_REG_R0, 0)
    mu.hook_add(UC_HOOK_CODE, hook, begin=STUB, end=STUB + 0x60)
    mu.mem_write(0x70001004, struct.pack('<I', 0x70002000))
    SET = 0x70003000
    mu.mem_write(SET, bytes([setting]))
    CTX = 0x70004000
    if look is None:
        mu.mem_write(CTX, struct.pack('<10I', *(STUB + i * 16 for i in range(5)), SET, 0, 0, 0, 0))
    else:
        LOOKW, TABLE = 0x70007000, 0x70007100
        mu.mem_write(LOOKW, struct.pack('<I', look))
        table = bytearray(64)
        for l in (13, 14, 15, 16, 25, 26, 27, 28, 29, 30):
            table[l] = 1
        mu.mem_write(TABLE, bytes(table))
        ORW = 0x70007200
        mu.mem_write(ORW, struct.pack('<I', orient or 0))
        FRW, NT = 0x70007300, 0x70008000
        mu.mem_write(FRW, struct.pack('<I', frame or 0))
        if names is not None:
            tab, a = [0] * 64, 0x70009000
            for style, gl in names.items():
                mu.mem_write(a, struct.pack('<%dH' % (len(gl) + 1), len(gl), *gl))
                tab[style] = a
                a += (2 * len(gl) + 2 + 3) & ~3
            mu.mem_write(NT, struct.pack('<64I', *tab))
        mu.mem_write(CTX, struct.pack('<12I', *(STUB + i * 16 for i in range(5)), SET, LOOKW, TABLE, STUB + 5 * 16, ORW if orient is not None else 0,
                                      FRW if frame is not None else 0, NT if names is not None else 0))

    def desc(a, P, w, h):
        mu.mem_write(a, struct.pack('<B3xIII HHHH HH 4x', 1, P.y, P.c, 0, w, h, P.stride, P.buf_h, 0, 0))
    D = 0x70005000
    desc(D, M, mw, mh)
    desc(D + 0x20, pics['sn'], *sn_wh)
    desc(D + 0x40, pics['th'], *th_wh)
    if stride - 16 >= sw and buf_h >= sh:
        desc(D + 0x60, M, sw, sh)   # the whole sensor window, same planes: skipped by the module
    CFG = 0x70006000
    mu.mem_write(CFG + 0x3c, struct.pack('<4I', D, D + 0x20, D + 0x40, D + 0x60 if stride - 16 >= sw and buf_h >= sh else 0))
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
    mu.reg_write(UC_ARM_REG_LR, 0x70000ff0)
    mu.reg_write(UC_ARM_REG_R0, CTX)
    mu.reg_write(UC_ARM_REG_R1, CFG)
    instr = [0]
    if count:
        mu.hook_add(UC_HOOK_BLOCK, lambda uc, a, size, ud: instr.__setitem__(0, instr[0] + (size >> 2)), begin=ORG, end=ORG + 0x10000)
    mu.emu_start(ORG, 0x70000ff0, count=800_000_000)
    out = {'main_buf': bytes(mu.mem_read(M.base, stride * buf_h * 2)), 'M': M, 'instr': instr[0]}
    for name, P in pics.items():
        out[name + '_buf'] = bytes(mu.mem_read(P.base, P.stride * P.buf_h * 2))
        out[name] = P
    return out


def plane(out, which, chroma=False):
    """The picture's Y (or CbCr) plane as rows of its width."""
    P = out[which]
    buf = out[which + '_buf'] if which != 'M' else out['main_buf']
    off = (P.c if chroma else P.y) - P.base
    return [buf[off + r * P.stride: off + r * P.stride + P.w] for r in range(P.h)]


def shown(rows, o):
    """Rows of the picture as a viewer shows it: o 0 as stored, 1 EXIF 8 (a quarter anticlockwise),
    2 EXIF 3 (half turn), 3 EXIF 6 (a quarter clockwise)."""
    H, W = len(rows), len(rows[0])
    if o == 0:
        return [bytes(r) for r in rows]
    if o == 2:
        return [bytes(reversed(rows[H - 1 - y])) for y in range(H)]
    if o == 3:   # shown (x, y) = stored (y, H-1-x): shown row y is stored column y, bottom to top
        return [bytes(rows[H - 1 - x][y] for x in range(H)) for y in range(W)]
    return [bytes(rows[x][W - 1 - y] for x in range(H)) for y in range(W)]   # o == 1


def view_xy(o, W, H, x, y):
    """Where stored pixel (x, y) of a W x H picture is shown."""
    if o == 0:
        return x, y
    if o == 2:
        return W - 1 - x, H - 1 - y
    if o == 3:
        return H - 1 - y, x
    return y, W - 1 - x


def bbox(rows, base):
    """Box of the pixels that differ from `base` (a value, or a list of rows)."""
    x0 = y0 = 1 << 30
    x1 = y1 = -1
    for y, r in enumerate(rows):
        ref = base[y] if isinstance(base, list) else None
        if ref is None:
            if r.count(base) == len(r):
                continue
            xs = [x for x in range(len(r)) if r[x] != base]
        else:
            if r == ref:
                continue
            xs = [x for x in range(len(r)) if r[x] != ref[x]]
        x0, x1 = min(x0, xs[0]), max(x1, xs[-1])
        y0, y1 = min(y0, y), max(y1, y)
    return None if x1 < 0 else (x0, y0, x1, y1)


def crop(rows, b):
    return [r[b[0]:b[2] + 1] for r in rows[b[1]:b[3] + 1]]


def untouched(which, out):
    """The picture as it was before the module ran (rows of Y)."""
    P = out[which]
    if which == 'M':
        return BG_Y
    x0, y0, rw, rh = P.area
    return [bytes(SN_Y if (x0 <= x < x0 + rw and y0 <= y < y0 + rh) else 0 for x in range(P.w)) for y in range(P.h)]


def main():
    args = sys.argv[1:]
    old = None
    if '--old' in args:
        i = args.index('--old')
        old = load_code(args[i + 1])
        del args[i:i + 2]
    outdir = Path(args[0]) if args else None
    if outdir:
        outdir.mkdir(parents=True, exist_ok=True)
    failures = []
    skipped = []
    checks = 0
    looks = [None, 0x10000 | 11, 0x10000 | 13, 0x10000 | (2 << 8) | 34]

    # 1. orientation 0: exactly the 0.8.2 output
    if old:
        n = 0
        for rname, sizes in RATIOS:
            for si, main_wh in enumerate(sizes):
                for setting in (1, 3):
                    for look in looks:
                        for mono in ((False, True) if look is None else (False,)):
                            a = run(old, setting, main_wh, sizes[0], look=look, mono=mono)
                            b = run(CODE, setting, main_wh, sizes[0], look=look, mono=mono, orient=None if look is None else 0x100)
                            for k in ('main_buf', 'sn_buf', 'th_buf'):
                                checks += 1
                                if a[k] != b[k]:
                                    failures.append(f'orientation 0 differs from 0.8.2: {rname} {SIZES[si]} setting {setting} look {look} mono {mono} {k}')
                            n += 1
        print(f'orientation 0 vs 0.8.2: {n} runs x 3 pictures', 'identical' if not failures else 'DIFFERENT', flush=True)
        # An orientation word without the valid bit (nothing left since start-up): as stored.
        a = run(old, 1, (4944, 3296), (6192, 4128), look=0x10000 | 11)
        b = run(CODE, 1, (4944, 3296), (6192, 4128), look=0x10000 | 11, orient=3)
        checks += 1
        if a['main_buf'] != b['main_buf']:
            failures.append('orientation word without the valid bit: orientation applied')

    # 2. orientations 1..3
    for rname, sizes in RATIOS:
        for si, main_wh in enumerate(sizes):
            for setting in (1, 3):
                sw, sh = sizes[0]
                mw, mh = main_wh
                # reference: an upright picture of the shown size
                ref_turned = run(CODE, setting, (mh, mw), (sh, sw), sn_wh=(480, 720), th_wh=(120, 160),
                                 look=0x10000 | 11, sensor=(((sh + 16 + 63) & ~63), sw), orient=0x100)
                ref_same = run(CODE, setting, main_wh, sizes[0], look=0x10000 | 11, orient=0x100)
                for o in (1, 2, 3):
                    got = run(CODE, setting, main_wh, sizes[0], look=0x10000 | 11, orient=0x100 | o)
                    ref = ref_same if o == 2 else ref_turned
                    for which in ('M', 'sn', 'th'):
                        checks += 1
                        tag = f'{rname} {SIZES[si]} setting {setting} orientation {o} {which}'
                        gy = plane(got, which)
                        W, H = len(gy[0]), len(gy)
                        sb = bbox(gy, untouched(which, got))
                        ry_ = plane(ref, which)
                        rb = bbox(ry_, untouched(which, ref))
                        if not sb or not rb:
                            if sb or rb:
                                failures.append(f'{tag}: imprint {sb}, upright reference {rb}')
                            else:
                                skipped.append(tag)
                            continue
                        # the box and the imprint as the picture is shown
                        corners = [view_xy(o, W, H, x, y) for x in (sb[0], sb[2]) for y in (sb[1], sb[3])]
                        b = (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))
                        VW, VH = (W, H) if o in (0, 2) else (H, W)
                        c1 = shown(crop(gy, sb), o)
                        # same place as on the upright picture of the shown size (+-1 px), bottom right
                        if max(abs(b[i] - rb[i]) for i in range(4)) > 1:
                            failures.append(f'{tag}: imprint at {b}, upright reference at {rb}')
                        # bottom right of the photo as shown: the gaps to its right and bottom edges are small
                        ax, ay, aw, ah = (0, 0, W, H) if which == 'M' else got[which].area
                        cs = [view_xy(o, W, H, x, y) for x in (ax, ax + aw - 1) for y in (ay, ay + ah - 1)]
                        vr, vb = max(c[0] for c in cs), max(c[1] for c in cs)
                        vl, vt = min(c[0] for c in cs), min(c[1] for c in cs)
                        if not (0 < vr - b[2] <= (vr - vl) // 4 and 0 < vb - b[3] <= (vb - vt) // 4 and b[0] >= vl and b[1] >= vt):
                            failures.append(f'{tag}: imprint {b} not bottom right of the shown photo {(vl, vt, vr, vb)}')
                        # reads normally: the light is exactly the upright one
                        c2 = crop(ry_, (rb[0], rb[1], rb[0] + b[2] - b[0], rb[1] + b[3] - b[1]))
                        if c1 != c2:
                            failures.append(f'{tag}: imprint differs from the upright one')
                        # inside the photo area of the screennail / thumbnail
                        if which != 'M':
                            x0, y0, rw, rh = got[which].area
                            if not (x0 <= sb[0] and sb[2] < x0 + rw and y0 <= sb[1] and sb[3] < y0 + rh):
                                failures.append(f'{tag}: imprint {sb} outside the photo area {got[which].area}')
                        # orange where fully lit
                        gc = plane(got, which, chroma=True)
                        lit = [(x, y) for y in range(sb[1], sb[3] + 1) for x in range(sb[0], sb[2] + 1) if gy[y][x] >= 145]
                        if not lit:
                            failures.append(f'{tag}: no fully lit pixel')
                        else:
                            x, y = lit[len(lit) // 2]
                            cb, cr = gc[y][x & ~1], gc[y][(x & ~1) + 1]
                            if not (cb < 80 and cr > 180):
                                failures.append(f'{tag}: not orange ({cb}, {cr})')
                        if outdir and si == 1 and setting == 3:
                            from PIL import Image
                            m = 40 if which == 'M' else 4
                            box = (max(0, sb[0] - m), max(0, sb[1] - m), min(W - 1, sb[2] + m), min(H - 1, sb[3] + m))
                            v = shown(crop(gy, box), o)
                            Image.frombytes('L', (len(v[0]), len(v)), b''.join(v)).save(outdir / f'{rname.replace(":", "x")}_{SIZES[si]}_o{o}_{which}.png')
        print(rname, 'orientations done', flush=True)
    # 3. the menu's "Follow Orientation" Off (bit 2 of the setting byte, 0.8.3): as stored, exactly
    #    as orientation 0 / the 0.8.2 module, whatever the orientation word says; bytes above 7 off.
    for rname, sizes in RATIOS[:1] + RATIOS[4:5]:
        for main_wh in sizes[:2]:
            for setting in (1, 3):
                flat = run(CODE, setting, main_wh, sizes[0], look=0x10000 | 11, orient=0x100)
                for o in (1, 2, 3):
                    off_ = run(CODE, setting | 4, main_wh, sizes[0], look=0x10000 | 11, orient=0x100 | o)
                    for k in ('main_buf', 'sn_buf', 'th_buf'):
                        checks += 1
                        if off_[k] != flat[k]:
                            failures.append(f'Follow Orientation off: {rname} {main_wh} setting {setting} orientation {o} {k} differs from as stored')
                if old:
                    o82 = run(old, setting, main_wh, sizes[0], look=0x10000 | 11)
                    checks += 1
                    if o82['main_buf'] != flat['main_buf']:
                        failures.append(f'as stored differs from 0.8.2: {rname} {main_wh} setting {setting}')
    # Off (bit 0 clear) or out of range (above 15; 0.8.4: bit 3 is the look's name, see name_check.py).
    for setting in (4, 6, 8, 10, 14, 16, 17, 0x80, 0xff):
        r = run(CODE, setting, (4944, 3296), (6192, 4128), look=0x10000 | 11, orient=0x103)
        checks += 1
        if r['main_buf'] != run(CODE, 0, (4944, 3296), (6192, 4128), look=0x10000 | 11, orient=0x103)['main_buf']:
            failures.append(f'setting {setting:#x} drew something')
    print('Follow Orientation off and other setting values done', flush=True)
    print('no imprint (does not fit the photo, as on the upright picture of that shape):', len(skipped), skipped[:8])
    print(f'{checks} checks;', 'FAILED:\n  ' + '\n  '.join(failures[:60]) if failures else 'all passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
