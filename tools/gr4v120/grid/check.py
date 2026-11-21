# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of custom grid lines (core/src/fw/gr4v120/aspect/grid.ts, installCustomGrid). NOT part of
the program.

    python3 check.py BUILT-RTOS OFFICIAL-RTOS --grid '{"g3":[...8],"g4":[...8]}' [--window] [--select BYTE:BIT]

BUILT-RTOS / OFFICIAL-RTOS: RTOS sections (decoded). --grid: the build's custom grid, each line
true / false (or 1 / 0), in the order top, centre, bottom horizontal; left, centre, right vertical;
diagonal from the top left, from the bottom left. --window when BUILT-RTOS also keeps the grid in
an added ratio's photo area (the live-view shade, aspect/shade.ts); its added ratios are read from
the record. --select (GR IV 1.20 / 1.21, the custom styles chosen in the camera's Grid Style list,
gr4v120/aspect/viewmenu.ts): the setting byte's address and the bit that chooses the custom lines;
every case then runs with the bit clear and set (the byte's other bits set too). Needs the Python
package unicorn.

 1. GridView::Draw (0x5359bb14) of BUILT-RTOS for both styles and several frames (3:2, added
    ratios' windows, the camera's 1:1, 4:3 and 16:9), with the line
    drawer (0x5359b814) stubbed: exactly the lines that are on, in order, each 2 pixels wide across
    the frame at k * (length / divisions) - 1 from its edge, drawn with the camera's colour byte
    +0xF5 (unchanged afterwards); then the base view Draw, once. For a style set to the camera's
    own lines they are exactly the official Draw's. With --select: the custom lines only with the
    bit set and a style that has lines of its own, otherwise exactly the official Draw's; a view
    whose layout mark (+0xF7) is not the one for what is chosen is laid out first, once (the
    mark then right); with the right mark, no layout.
 2. The layout (0x5359b944) of BUILT-RTOS for both styles and five sizes (3:2, 3:1, 1:1, 4:3,
    16:9), with the line views'
    setters stubbed: each diagonal that is on gets its two points (corner to corner of the bounds,
    or with --window and an added ratio selected of the ratio's window, centred), thickness 2, the
    grid's colour and SetVisible 1; each one that is off gets SetVisible 0 only. Both line views get
    the whole bounds first, as officially. +0xF5 is untouched. For a style set to the camera's own
    lines and no added ratio selected, every call is the official layout's. With --select: the
    custom diagonals only as in 1, otherwise the camera's (both for 4x4, none for 3x3; the
    official layout's without an added ratio); the mark +0xF7 is 0x81 / 0x80 afterwards.
"""
import json
import struct
import sys
from fractions import Fraction

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_SP,
                               UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC)

BASE = 0x53000000
RAMVA, RAMIMG, RAMLEN = 0x55000000, 0x543b3100, 0x58500
STOP = 0x100
GRID_DRAW = 0x5359bb14
LAYOUT = 0x5359b944
DRAW_LINE = 0x5359b814
VIEW_BASE_DRAW = 0x535ab380
SET_POINTS = 0x5359191c
SET_COLOUR = 0x53591a74
SET_VISIBLE = 0x535acd84
CURRENT_USERDATA = 0x53240c38
# The shade's "added ratio selected" asks first whether the camera is in movie mode: the setting root and its
# capture settings' movie test (core/src/fw/gr4v120/aspect/shade.ts). Answered: not in movie mode.
SETTINGS_PROP = 0x53750008
IS_MOVIE = 0x5377cab8
PROP = 0x600e0000
ASPECT_BYTE = 0x49f
COLOUR = 16

# Scratch memory.
STACK = 0x600f0000
USERDATA = 0x600a0000
VIEW = 0x60090000
CTX = 0x60080000
PIXELS = 0x61000000
CHILD = (0x60091000, 0x60092000)
CHILD_VTABLE = 0x60093000
CHILD_FRAME = 0x60093800
STRAIGHT = {
    0: [(False, 1, 3), (False, 1, 2), (False, 2, 3), (True, 1, 3), (True, 1, 2), (True, 2, 3)],
    1: [(False, 1, 4), (False, 2, 4), (False, 3, 4), (True, 1, 4), (True, 2, 4), (True, 3, 4)],
}
CAMERA = {'g3': [True, False, True, True, False, True, False, False], 'g4': [True] * 8}

failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


class Image:
    def __init__(self, path):
        self.R = open(path, 'rb').read()

    def u32(self, va):
        if RAMVA <= va < RAMVA + RAMLEN:
            va = RAMIMG + va - RAMVA
        return struct.unpack_from('<I', self.R, va - BASE)[0]

    def ratios(self):
        """The ratio texts of the record at the end of the RTOS section (see package.ts)."""
        R = self.R
        magic = R[-12:-4]
        if not magic.startswith(b'GRMODAR'):
            return []
        length = struct.unpack_from('<I', R, len(R) - 16)[0]
        rec = R[len(R) - 16 - length:len(R) - 16]
        out, p = [], 1
        for _ in range(rec[0]):
            n = rec[p]
            ratio = rec[p + 1:p + 1 + n].decode('ascii')
            p += 1 + n
            p += 1 + rec[p]
            out.append(ratio)
        return out


class Emu:
    def __init__(self, img):
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, max((len(img.R) + 0xfffff) & ~0xfffff, 0x1600000))
        mu.mem_write(BASE, img.R)
        mu.mem_map(RAMVA, 0x1000000)
        mu.mem_write(RAMVA, img.R[RAMIMG - BASE:RAMIMG - BASE + RAMLEN])
        mu.mem_map(0x60000000, 0x100000)
        mu.mem_map(PIXELS, 0x400000)
        mu.mem_map(0, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.mu = mu
        self.calls = []
        self.stubs = {}
        self.base = {SETTINGS_PROP: ('settings', PROP), IS_MOVIE: ('movie', 0)}
        mu.hook_add(UC_HOOK_CODE, self._hook)

    def _hook(self, uc, addr, size, ud):
        if addr in self.stubs or addr in self.base:
            lr = uc.reg_read(UC_ARM_REG_LR)
            args = tuple(uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1))
            name, ret = self.stubs[addr] if addr in self.stubs else self.base[addr]
            self.calls.append((name,) + args)
            if ret is not None:
                uc.reg_write(UC_ARM_REG_R0, ret)
            uc.reg_write(UC_ARM_REG_PC, lr)

    def run(self, start, regs, sp=STACK):
        mu = self.mu
        for r, v in regs.items():
            mu.reg_write(r, v)
        mu.reg_write(UC_ARM_REG_SP, sp)
        mu.reg_write(UC_ARM_REG_LR, STOP)
        mu.emu_start(start, STOP, count=20_000_000)
        if mu.reg_read(UC_ARM_REG_PC) != STOP:
            raise RuntimeError(f'{start:#x} did not return')

    def w8(self, a, v):
        self.mu.mem_write(a, bytes([v & 0xff]))

    def r8(self, a):
        return self.mu.mem_read(a, 1)[0]

    def w16(self, a, v):
        self.mu.mem_write(a, struct.pack('<H', v & 0xffff))

    def w32(self, a, v):
        self.mu.mem_write(a, struct.pack('<I', v & 0xffffffff))


# --- the geometry GR Mod gives a ratio (core/src/fw/gr4v120/aspect/geometry.ts), with fractions ----------
def parse_ratio(text):
    fields = text.split(':')
    return Fraction(fields[0]) / (Fraction(fields[1]) if len(fields) == 2 else 1)


def nearest4(value):
    return 4 * ((value + 2) // 4)


def screen_crop(ratio, width=720, height=480):
    if ratio >= Fraction(width, height):
        w, h = width, nearest4(Fraction(width) / ratio)
    else:
        w, h = nearest4(Fraction(height) * ratio), height
    return int(w), int(h), (width - int(w)) // 2, (height - int(h)) // 2


def fractions_of(ratio):
    w, h, _, _ = screen_crop(ratio)
    actual = Fraction(w, h)
    return min(Fraction(1), actual / Fraction(3, 2)), min(Fraction(1), Fraction(3, 2) / actual)


def rect(e, va):
    return struct.unpack('<4i', bytes(e.mu.mem_read(va, 16)))


def set_choice(e, select, chosen, mark=None):
    """With --select: the setting byte (the bit as chosen, every other bit set) and the view's layout mark."""
    if select is None:
        return
    byte, bit = select
    e.w8(byte, (0xff & ~bit) | (bit if chosen else 0))
    if mark is not None:
        e.w8(VIEW + 0xf7, mark)


def children(e):
    e.w32(CHILD_VTABLE + 0x18, CHILD_FRAME)
    for c in CHILD:
        e.w32(c, CHILD_VTABLE)
    e.w32(VIEW + 0xec, CHILD[0])
    e.w32(VIEW + 0xf0, CHILD[1])


def draw_lines(img, style, frame, select=None, chosen=False, mark=None):
    e = Emu(img)
    e.stubs = {DRAW_LINE: ('line', None), VIEW_BASE_DRAW: ('base draw', None), SET_POINTS: ('points', None), SET_COLOUR: ('colour', None),
               SET_VISIBLE: ('visible', None), CHILD_FRAME: ('child frame', None), CURRENT_USERDATA: ('userdata', 0)}
    lines = []
    layouts = []

    def hook(uc, addr, size, ud):
        lines.append((rect(e, uc.reg_read(UC_ARM_REG_R2)), e.r8(VIEW + 0xf5)))
    e.mu.hook_add(UC_HOOK_CODE, hook, begin=DRAW_LINE, end=DRAW_LINE)
    e.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, ud: layouts.append(uc.reg_read(UC_ARM_REG_R0)), begin=LAYOUT, end=LAYOUT)
    children(e)
    e.mu.mem_write(VIEW + 0x20, struct.pack('<4i', 0, 0, frame[2], frame[3]))
    e.mu.mem_write(VIEW + 0x30, struct.pack('<4i', *frame))
    e.w8(VIEW + 0x9e, 1)
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf5, COLOUR)
    set_choice(e, select, chosen, mark)
    e.run(GRID_DRAW, {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R1: CTX})
    return lines, [c[0] for c in e.calls if c[0] == 'base draw'], e.r8(VIEW + 0xf5), layouts, e.r8(VIEW + 0xf7)


def expected_lines(cfg, style, frame):
    x, y, w, h = frame
    out = []
    for i, (vertical, k, n) in enumerate(STRAIGHT[style]):
        if not cfg[i]:
            continue
        if vertical:
            out.append(((x + k * (w // n) - 1, y, 2, h), COLOUR))
        else:
            out.append(((x, y + k * (h // n) - 1, w, 2), COLOUR))
    return out


def layout(img, style, w, h, aspect=None, select=None, chosen=False):
    e = Emu(img)
    e.stubs = {SET_POINTS: ('points', None), SET_COLOUR: ('colour', None), SET_VISIBLE: ('visible', None),
               CHILD_FRAME: ('child frame', None), CURRENT_USERDATA: ('userdata', USERDATA if aspect is not None else 0)}
    calls = []

    def hook(uc, addr, size, ud):
        r0, r1, r2, r3 = (uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3))
        if addr == SET_POINTS:
            calls.append(('points', r0, struct.unpack('<2i', bytes(uc.mem_read(r1, 8))), struct.unpack('<2i', bytes(uc.mem_read(r2, 8))), r3))
        elif addr == SET_COLOUR:
            calls.append(('colour', r0, r1 & 0xff))
        elif addr == SET_VISIBLE:
            calls.append(('visible', r0, r1 & 0xff))
        elif addr == CHILD_FRAME:
            calls.append(('frame', r0, rect(e, r1)))
    for va in (SET_POINTS, SET_COLOUR, SET_VISIBLE, CHILD_FRAME):
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=va, end=va)
    children(e)
    e.mu.mem_write(VIEW + 0x20, struct.pack('<4i', 0, 0, w, h))
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf5, COLOUR)
    e.w8(VIEW + 0xf7, 0x5a)
    set_choice(e, select, chosen)
    if aspect is not None:
        e.w8(USERDATA + ASPECT_BYTE, aspect)
    e.run(LAYOUT, {UC_ARM_REG_R0: VIEW})
    return calls, e.r8(VIEW + 0xf5), e.r8(VIEW + 0xf7)


def window(ratio, w, h):
    fx, fy = fractions_of(ratio)
    ww = w * fx.numerator // fx.denominator
    wh = h * fy.numerator // fy.denominator
    x0, y0 = (w - ww) >> 1, (h - wh) >> 1
    return x0, y0, x0 + ww, y0 + wh


def expected_layout(cfg, w, h, win=None):
    x0, y0, x1, y1 = win or (0, 0, w, h)
    out = [('frame', c, (0, 0, w, h)) for c in CHILD]
    for d, c in enumerate(CHILD):
        if not cfg[6 + d]:
            out.append(('visible', c, 0))
            continue
        pts = ((x0, y0), (x1, y1)) if d == 0 else ((x0, y1), (x1, y0))
        out += [('points', c, pts[0], pts[1], 2), ('colour', c, COLOUR), ('visible', c, 1)]
    return out


def main():
    opts = sys.argv[1:]
    grid_json = opts[opts.index('--grid') + 1]
    args = [a for a in opts if not a.startswith('--') and a != grid_json]
    grid = {k: [bool(v) for v in vs] for k, vs in json.loads(grid_json).items()}
    if any(len(grid[k]) != 8 for k in ('g3', 'g4')):
        raise SystemExit('--grid: eight lines per style')
    in_window = '--window' in opts
    select = None
    if '--select' in opts:
        b, bit = opts[opts.index('--select') + 1].split(':')
        select = (int(b, 0), int(bit, 0))
        args = [a for a in args if a != opts[opts.index('--select') + 1]]
    new, old = Image(args[0]), Image(args[1])
    cfgs = {0: grid['g3'], 1: grid['g4']}
    camera = {0: grid['g3'] == CAMERA['g3'], 1: grid['g4'] == CAMERA['g4']}
    choices = (False, True) if select else (True,)

    def active(style, chosen):
        return chosen and (select is None or not camera[style])

    # 1. Straight lines.
    n = 0
    for style in (0, 1):
        # 3:2, added ratios' windows, and the camera's own 1:1, 4:3 and 16:9 (the frame fitted to the live picture).
        for frame in [(0, 0, 720, 480), (0, 120, 720, 240), (60, 0, 600, 480), (8, 6, 704, 468), (0, 108, 720, 264),
                      (120, 0, 480, 480), (40, 0, 640, 480), (0, 38, 720, 404)]:
            for chosen in choices:
                on = active(style, chosen)
                right = 0x80 | (1 if on else 0)
                for mark in ((right, right ^ 1, 0) if select else (None,)):
                    got, base, after, laid, mark_after = draw_lines(new, style, frame, select, chosen, mark)
                    want = expected_lines(cfgs[style] if on else CAMERA['g3' if style == 0 else 'g4'], style, frame)
                    what = f'Draw style {style} frame {frame} chosen {chosen} mark {mark}'
                    check(got == want, f'{what}: lines {got}, want {want}')
                    check(base == ['base draw'], f'{what}: base Draw {base}')
                    check(after == COLOUR, f'{what}: colour byte {after} afterwards')
                    if select:
                        check(laid == ([] if mark == right else [VIEW]), f'{what}: layouts {laid}')
                        check(mark_after == right, f'{what}: mark {mark_after:#x} afterwards, want {right:#x}')
                    if camera[style] or not on:
                        off, obase, _, _, _ = draw_lines(old, style, frame)
                        check([r for r, _ in got] == [r for r, _ in off], f'{what}: camera grid differs from the official Draw: {got} / {off}')
                    n += 1
    print(f'straight lines: {n} cases; the lines that are on, at the native places, in the camera\u2019s colour')

    # 2. Diagonals.
    ids = {7 + k: parse_ratio(r) for k, r in enumerate(new.ratios())} if in_window else {}
    n = 0
    for style in (0, 1):
        for (w, h) in [(720, 480), (720, 240), (480, 480), (640, 480), (720, 404)]:
            cases = [(None, None)] + ([(a, window(r, w, h)) for a, r in ids.items()] + [(0, None)] if in_window else [])
            for aspect, win in cases:
                for chosen in choices:
                    on = active(style, chosen)
                    got, after, mark = layout(new, style, w, h, aspect, select, chosen)
                    want = expected_layout(cfgs[style] if on else CAMERA['g3' if style == 0 else 'g4'], w, h, win)
                    what = f'layout style {style} {w}x{h} aspect {aspect} chosen {chosen}'
                    check(sorted(got, key=str) == sorted(want, key=str), f'{what}: {got}, want {want}')
                    check([c for c in got if c[0] == 'frame'] == [c for c in want if c[0] == 'frame'], f'{what}: line view frames first')
                    check(after == COLOUR, f'{what}: colour byte changed to {after}')
                    if select:
                        check(mark == 0x80 | (1 if on else 0), f'{what}: mark {mark:#x}')
                    if (camera[style] or not on) and win is None:
                        off, _, _ = layout(old, style, w, h, aspect)
                        check(sorted(got, key=str) == sorted(off, key=str), f'{what}: camera grid differs from the official layout: {got} / {off}')
                    n += 1
    print(f'diagonals: {n} cases; each one on gets its points{" (the window with an added ratio)" if in_window else ""}, thickness 2, colour and shown; off ones hidden')

    if failures:
        print(f'{len(failures)} FAILED:')
        for f in failures[:40]:
            print('  ' + f)
        sys.exit(1)
    print('all grid checks passed')


if __name__ == '__main__':
    main()
