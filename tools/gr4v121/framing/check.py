# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of framing guides (core/src/fw/gr4v121/aspect/framing.ts, installFramingGuides). NOT part of the
program.

    npx vite-node tools/gr4v121/framing/expect.ts GUIDES.json > EXPECT.json
    python3 check.py BUILT-RTOS OFFICIAL-RTOS EXPECT.json

BUILT-RTOS / OFFICIAL-RTOS: RTOS sections (decoded); BUILT-RTOS has the guides of GUIDES.json and no added ratio.
EXPECT.json: what the app computes for them (`framingRects`, the list its preview draws), the palette's ARGB words
and the setting byte and bit that choose the custom styles in the camera. Needs the Python package unicorn.

 1. The UI palette: the lookup of the 32-bit fill (0x539278C0) reads a copy of 256 words whose first 48 are the
    palette's, with the guides' colours at 0xE0.. .
 2. GridView::Draw (0x5359c43c) for both styles, eight frames (3:2, ratio windows, the camera's 1:1, 4:3, 16:9)
    and the bit clear and set, with the line drawer (0x5359c13c) stubbed: with the bit set and a style whose
    preset is a value of its own, exactly the rectangles of EXPECT.json, in order, each in its colour (the view's
    colour byte +0xF5 when the drawer is called), the colour byte as before afterwards; otherwise exactly the
    official Draw's lines. The base view Draw once. A view laid out for the other choice (+0xF7) is laid out
    first, once.
 3. The layout (0x5359c26c) for both styles and five sizes, the bit clear and set, the line views' setters
    stubbed: with the bit set and a preset of its own, each diagonal that is on gets its points (corner to corner),
    its width as thickness, its colour and SetVisible 1, each one off SetVisible 0; otherwise exactly the official
    layout's calls. +0xF5 untouched; +0xF7 = 0x81 / 0x80.
"""
import json
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_SP,
                               UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC)

BASE = 0x53000000
RAMVA, RAMIMG, RAMLEN = 0x55000000, 0x543b4900, 0x58500
STOP = 0x100
GRID_DRAW = 0x5359c43c
LAYOUT = 0x5359c26c
DRAW_LINE = 0x5359c13c
VIEW_BASE_DRAW = 0x535abca8
SET_POINTS = 0x53592244
SET_COLOUR = 0x5359239c
SET_VISIBLE = 0x535ad6ac
CURRENT_USERDATA = 0x53241240
SETTINGS_PROP = 0x53750a58
IS_MOVIE = 0x5377d748
PALETTE = 0x540799dc
PALETTE_LOOKUP = 0x539278c0
PROP = 0x600e0000
COLOUR = 16

STACK = 0x600f0000
VIEW = 0x60090000
CTX = 0x60080000
PIXELS = 0x61000000
CHILD = (0x60091000, 0x60092000)
CHILD_VTABLE = 0x60093000
CHILD_FRAME = 0x60093800
FRAMES = [(0, 0, 720, 480), (0, 120, 720, 240), (60, 0, 600, 480), (8, 6, 704, 468), (0, 108, 720, 264),
          (120, 0, 480, 480), (40, 0, 640, 480), (0, 38, 720, 404)]
SIZES = [(720, 480), (720, 240), (480, 480), (640, 480), (720, 404)]

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


def movw_movt(img, at):
    w0, w1 = img.u32(at), img.u32(at + 4)
    imm = lambda w: ((w >> 4) & 0xf000) | (w & 0xfff)
    return imm(w0) | (imm(w1) << 16)


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
            name, ret = self.stubs[addr] if addr in self.stubs else self.base[addr]
            self.calls.append(name)
            if ret is not None:
                uc.reg_write(UC_ARM_REG_R0, ret)
            uc.reg_write(UC_ARM_REG_PC, lr)

    def run(self, start, regs):
        mu = self.mu
        for r, v in regs.items():
            mu.reg_write(r, v)
        mu.reg_write(UC_ARM_REG_SP, STACK)
        mu.reg_write(UC_ARM_REG_LR, STOP)
        mu.emu_start(start, STOP, count=50_000_000)
        if mu.reg_read(UC_ARM_REG_PC) != STOP:
            raise RuntimeError(f'{start:#x} did not return')

    def w8(self, a, v):
        self.mu.mem_write(a, bytes([v & 0xff]))

    def r8(self, a):
        return self.mu.mem_read(a, 1)[0]

    def w32(self, a, v):
        self.mu.mem_write(a, struct.pack('<I', v & 0xffffffff))


def children(e):
    e.w32(CHILD_VTABLE + 0x18, CHILD_FRAME)
    for c in CHILD:
        e.w32(c, CHILD_VTABLE)
    e.w32(VIEW + 0xec, CHILD[0])
    e.w32(VIEW + 0xf0, CHILD[1])


def set_choice(e, select, chosen, mark=None):
    byte, bit = select
    e.w8(byte, (0xff & ~bit) | (bit if chosen else 0))
    if mark is not None:
        e.w8(VIEW + 0xf7, mark)


def draw(img, style, frame, select=None, chosen=False, mark=None):
    e = Emu(img)
    e.stubs = {DRAW_LINE: ('line', None), VIEW_BASE_DRAW: ('base draw', None), SET_POINTS: ('points', None), SET_COLOUR: ('colour', None),
               SET_VISIBLE: ('visible', None), CHILD_FRAME: ('child frame', None), CURRENT_USERDATA: ('userdata', 0)}
    rects, layouts = [], []

    def hook(uc, addr, size, ud):
        r = struct.unpack('<4i', bytes(e.mu.mem_read(uc.reg_read(UC_ARM_REG_R2), 16)))
        rects.append(list(r) + [e.r8(VIEW + 0xf5)])
    e.mu.hook_add(UC_HOOK_CODE, hook, begin=DRAW_LINE, end=DRAW_LINE)
    e.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, ud: layouts.append(1), begin=LAYOUT, end=LAYOUT)
    children(e)
    e.mu.mem_write(VIEW + 0x20, struct.pack('<4i', 0, 0, frame[2], frame[3]))
    e.mu.mem_write(VIEW + 0x30, struct.pack('<4i', *frame))
    e.w8(VIEW + 0x9e, 1)
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf5, COLOUR)
    if select:
        set_choice(e, select, chosen, mark)
    e.run(GRID_DRAW, {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R1: CTX})
    return rects, e.calls.count('base draw'), e.r8(VIEW + 0xf5), len(layouts), e.r8(VIEW + 0xf7)


def layout(img, style, w, h, select=None, chosen=False):
    e = Emu(img)
    e.stubs = {SET_POINTS: ('points', None), SET_COLOUR: ('colour', None), SET_VISIBLE: ('visible', None),
               CHILD_FRAME: ('child frame', None), CURRENT_USERDATA: ('userdata', 0)}
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
            calls.append(('frame', r0, struct.unpack('<4i', bytes(uc.mem_read(r1, 16)))))
    for va in (SET_POINTS, SET_COLOUR, SET_VISIBLE, CHILD_FRAME):
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=va, end=va)
    children(e)
    e.mu.mem_write(VIEW + 0x20, struct.pack('<4i', 0, 0, w, h))
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf5, COLOUR)
    e.w8(VIEW + 0xf7, 0x5a)
    if select:
        set_choice(e, select, chosen)
    e.run(LAYOUT, {UC_ARM_REG_R0: VIEW})
    return calls, e.r8(VIEW + 0xf5), e.r8(VIEW + 0xf7)


def main():
    built, official, expect = Image(sys.argv[1]), Image(sys.argv[2]), json.load(open(sys.argv[3]))
    select = tuple(expect['select'])

    # 1. Palette.
    copy = movw_movt(built, PALETTE_LOOKUP)
    check(movw_movt(official, PALETTE_LOOKUP) == PALETTE, 'official palette lookup')
    check(copy != PALETTE and copy >= BASE + len(official.R), f'palette lookup reads {copy:#x}, not a copy')
    if not failures:
        words = [built.u32(copy + 4 * i) for i in range(256)]
        check(words[:48] == [official.u32(PALETTE + 4 * i) for i in range(48)], 'palette copy: the first 48 words differ')
        for i, argb in enumerate(expect['palette']):
            check(words[0xe0 + i] == argb, f'palette copy {0xe0 + i:#x}: {words[0xe0 + i]:#010x}, want {argb:#010x}')
    print(f'palette: lookup reads the copy at {copy:#x}; {len(expect["palette"])} colours at 0xe0')

    # 2. Draw.
    n = 0
    for style in (0, 1):
        pre = expect['presets'][style]
        for k, frame in enumerate(FRAMES):
            assert tuple(pre['frames'][k]['frame']) == frame
            want_custom = [list(r) for r in pre['frames'][k]['rects']]
            off, obase, ocol, _, _ = draw(official, style, frame)
            for chosen in (False, True):
                on = chosen and pre['own']
                right = 0x80 | (1 if on else 0)
                for mark in (right, right ^ 1):
                    got, base, after, laid, mark_after = draw(built, style, frame, select, chosen, mark)
                    what = f'Draw style {style} frame {frame} chosen {chosen} mark {mark:#x}'
                    want = want_custom if on else off
                    check(got == want, f'{what}: {len(got)} rects {got[:4]}..., want {len(want)} {want[:4]}...')
                    check(base == 1, f'{what}: base Draw {base} times')
                    check(after == COLOUR, f'{what}: colour byte {after} afterwards')
                    check(laid == (0 if mark == right else 1), f'{what}: laid out {laid} times')
                    check(mark_after == right, f'{what}: mark {mark_after:#x} afterwards')
                    n += 1
    print(f'Draw: {n} cases; with the bit and a preset of its own the app\'s rectangles in order and colour, otherwise the official lines')

    # 3. Layout.
    n = 0
    for style in (0, 1):
        pre = expect['presets'][style]
        for (w, h) in SIZES:
            off, _, _ = layout(official, style, w, h)
            for chosen in (False, True):
                on = chosen and pre['own']
                got, after, mark = layout(built, style, w, h, select, chosen)
                what = f'layout style {style} {w}x{h} chosen {chosen}'
                if on:
                    want = [('frame', c, (0, 0, w, h)) for c in CHILD]
                    for d, c in enumerate(CHILD):
                        diag = pre['diagonals'][d]
                        if not diag:
                            want.append(('visible', c, 0))
                            continue
                        pts = ((0, 0), (w, h)) if d == 0 else ((0, h), (w, 0))
                        want += [('points', c, pts[0], pts[1], diag['width']), ('colour', c, diag['colour']), ('visible', c, 1)]
                else:
                    want = off
                check(got == want, f'{what}: {got}, want {want}')
                check(after == COLOUR, f'{what}: colour byte {after}')
                check(mark == 0x80 | (1 if on else 0), f'{what}: mark {mark:#x}')
                n += 1
    print(f'layout: {n} cases; diagonals with their own colour and thickness, or the official layout')

    if failures:
        print(f'{len(failures)} FAILED:')
        for f in failures[:30]:
            print('  ' + f)
        sys.exit(1)
    print('all framing checks passed')


if __name__ == '__main__':
    main()
