# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the live-view shade of added ratios (core/src/fw/gr4v120/aspect/shade.ts). NOT part
of the program.

    python3 draw_check.py BUILT-RTOS OFFICIAL-RTOS PLAIN-RTOS [--tone dark|light] [--other-lines]
                          [--setting BYTE:SHIFT:MASK:ARGB,ARGB,...]

BUILT-RTOS / OFFICIAL-RTOS: RTOS sections (decoded). BUILT-RTOS is a build with the shade; its
added ratios are read from the record at the end of its RTOS section. PLAIN-RTOS is the same build
without the shade. --tone is the tone BUILT-RTOS was made with. --other-lines when another
addition of BUILT-RTOS changes which grid lines the native Draw and the layout draw: in 3 the lines
are then only checked to lie in the window, not compared with the official Draw's, and in 4 only the
diagonals' points are checked (each one shown runs corner to corner of the window, or of the bounds
without an added ratio). --setting (GR IV 1.20 / 1.21, gr4v120/aspect/viewmenu.ts): the shade is chosen
in the camera, a field of a setting byte (address, shift, mask) picks it; the ARGB colour each stored
code must give (0: no shade). Every Draw case of the 720x480 canvas then runs with each code (the
bits below the field set, those above clear), the others with code 0. Needs the Python packages unicorn and capstone.

 0. The live-view mode (0x538B40C8) and its check (0x5366440C), patched, plain and official, for
    every capture aspect (factory, each added ratio, an unknown one) and, for the check, every
    stored mode: with an added ratio the patched mode and check answer exactly as the official
    ones do for 3:2; for every other aspect as the plain build (and for factory ones as official).
 1. Static: the live-view mode calls are the patched ones and the official ones are the capture
    aspect getter calls; the grid view's constructor
    clears +0xF4..+0xF7 with one word store of a register that is zero there; the object is 0xF8
    bytes, and none of its first 40 methods reads +0xF6 or +0xF7; the UI palette's colours 16 and
    19 are 0x80000000 (black at half opacity) and 0x40555555 (grey at a quarter).
 2. UpdateViewGrid's tail (0x53190318), patched and official, for grid off / on and every still
    aspect (factory, each added ratio, an unknown one, no user settings): SetVisible gets the
    official arguments unless an added ratio is selected, and then (view, 1); the mark +0xF6 is
    1 | 2 * (grid on); the restored registers are the official ones.
 3. GridView::Draw (vtable slot 19) for every mark, aspect, grid style, several canvases and grid
    frames, with the camera's own rectangle fill (the 32-bit path) writing into a canvas in memory
    and the camera's own grid and base view Draw (only the line drawer is stubbed and its
    rectangles recorded): without the mark or an added ratio only the native Draw runs on the
    frame as it is and no pixel changes; with them every pixel outside the ratio's window becomes
    the tone's palette colour and every pixel inside stays, the window is the one the photo's
    720x480 screen crop has (GR Mod's geometry, here recomputed with fractions); then, grid on,
    the native Draw runs with the frame narrowed to the ratio and centred (on the full frame the
    bands' window) and draws exactly the lines it draws for a frame of that shape (the official
    Draw's), all inside the window; afterwards the frame and the base Draw's copy of it (+0x44)
    are the original frame, or the copy is untouched when the view is not visible; grid off, the
    base view Draw only. Callee-saved registers and SP are kept.
 4. The grid view's layout (0x5359b944), patched and official, for both grid styles, three frame
    sizes and every still aspect, with the line views' setters stubbed and their arguments
    recorded: without an added ratio every call is the official one; with one the two diagonals
    get the corners of the ratio's window (the bands' fractions and rounding, centred), (x0,y0)-
    (x1,y1) and (x0,y1)-(x1,y0), and every other call (frames, colour, visibility) is official.
"""
import struct
import sys
from fractions import Fraction

from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4,
                               UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9,
                               UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC,
                               UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC)

BASE = 0x53000000
RAMVA, RAMIMG, RAMLEN = 0x55000000, 0x543b3100, 0x58500
STOP = 0x100
LIVE_MODE_FN = 0x538b40c8
MODE_CHECK_FN = 0x5366440c
LIVE_MODE_CALLS = (0x538b40e0, 0x53664424)
CAPTURE_ASPECT = 0x5377d960
SETTINGS_PROP = 0x53750008
IS_MOVIE = 0x5377cab8  # the capture settings' movie test (0x53750008's +4); the shade asks it
MODE_OVERRIDE = (0x53891e48, 0x53891f18)
ASSERT = 0x539154f8
TONES = {'dark': 16, 'light': 19}
GRID_VTABLE = 0x53ecee00
GRID_DRAW_SLOT = GRID_VTABLE + 19 * 4
GRID_DRAW = 0x5359bb14
VIEW_BASE_DRAW = 0x535ab380
GRID_CTOR = 0x5359b71c
GRID_CTOR_CLEAR = 0x5359b780
GRID_ALLOC_CALL = 0x535ad72c
SET_VISIBLE = 0x535acd84
UPDATE_GRID_VISIBLE = 0x53190318
CURRENT_USERDATA = 0x53240c38
FILL_FACTORY, FILL_GET = 0x5323d7f0, 0x5323d968
PALETTE = 0x540781ec
ASPECT_BYTE = 0x49f
MARK = 0xf6
GRID_LINE = 0x5359b814
FRAME_OFF, DRAWN_OFF, DRAWN_FLAG = 0x30, 0x44, 0x40
SENTINEL = (0x5a5a5a5a,) * 4
SHADE = 0x80000000
CANVAS_FILL = 0x11223344
PROP = 0x600e0000
OBJ = 0x600e1000

LAYOUT = 0x5359b944
LINE_SET_POINTS = 0x5359191c
LINE_SET_COLOUR = 0x53591a74

# Scratch memory.
STACK = 0x600f0000
USERDATA = 0x600a0000
VIEW = 0x60090000
CTX = 0x60080000
FRAME = 0x600c0000
PIXELS = 0x61000000

failures = []
MOVIE = 0  # what the movie test answers (movie mode: non-zero)


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
        # Asked by the shade's "added ratio selected" (any function that runs it): movie mode or not.
        self.base = {SETTINGS_PROP: ('settings', PROP), IS_MOVIE: ('movie', MOVIE)}
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


def expected_window(ratio, width, height):
    fx, fy = fractions_of(ratio)
    if height == 0:
        height = width * 2 // 3
    h = height * fy.numerator // fy.denominator
    w = width * fx.numerator // fx.denominator
    return w, h, (width - w) >> 1, (height - h) >> 1, height


# --- 0. live-view mode and its check ---------------------------------------------------------------
def live_mode(img, capture):
    """The live-view mode function with the capture aspect getter answering `capture`."""
    e = Emu(img)
    e.w32(PROP + 4, 0x600e0800)
    e.stubs = {SETTINGS_PROP: ('settings', PROP), CAPTURE_ASPECT: ('capture', capture),
               MODE_OVERRIDE[0]: ('override object', 0x600e0400), MODE_OVERRIDE[1]: ('override', 0), ASSERT: ('assert', None)}
    e.run(LIVE_MODE_FN, {UC_ARM_REG_R4: 0x4444})
    return e.mu.reg_read(UC_ARM_REG_R0), [c[0] for c in e.calls if c[0] in ('capture', 'assert')], e.mu.reg_read(UC_ARM_REG_R4)


def mode_check(img, capture, stored):
    """The live-view mode check of an object whose stored mode (+0x8D) is `stored`."""
    e = Emu(img)
    e.w32(OBJ + 0x3bc, 0x600e0800)
    e.w8(OBJ + 0x8d, stored)
    e.stubs = {CAPTURE_ASPECT: ('capture', capture), ASSERT: ('assert', None)}
    e.run(MODE_CHECK_FN, {UC_ARM_REG_R0: OBJ, UC_ARM_REG_R4: 0x4444})
    return e.mu.reg_read(UC_ARM_REG_R0), [c[0] for c in e.calls if c[0] in ('capture', 'assert')], e.mu.reg_read(UC_ARM_REG_R4)


def live_checks(new, old, plain, ids):
    captures = [0, 1, 2, 3, *ids, 7 + len(ids)]
    n = 0
    for x in captures:
        got, ocalls, r4 = live_mode(new, x)
        want = live_mode(old, 0) if x in ids else live_mode(plain, x)
        check(r4 == 0x4444, f'live-view mode capture {x}: r4 not kept')
        check(got == want[0], f'live-view mode capture {x}: {got}, want {want[0]}')
        check(ocalls == want[1], f'live-view mode capture {x}: calls {ocalls}, want {want[1]}')
        if x < 4:
            check(got == live_mode(old, x)[0], f'live-view mode capture {x}: not the official answer')
        if x in ids:
            check(live_mode(plain, x)[0] == x, f'plain build: live-view mode of added ratio {x} is not its identity')
        n += 1
        for stored in [0, 1, 2, 3, *ids, 0x80]:
            got = mode_check(new, x, stored)
            want = mode_check(old, 0, stored) if x in ids else mode_check(plain, x, stored)
            check(got[0] == want[0] and got[1] == want[1] and got[2] == 0x4444, f'mode check capture {x} stored {stored}: {got}, want {want}')
            if x < 4:
                check(got[0] == mode_check(old, x, stored)[0], f'mode check capture {x} stored {stored}: not the official answer')
            n += 1
    print(f'live-view mode and check: {n} cases; an added ratio gives the official 3:2 answers ('
          f'mode {live_mode(old, 0)[0]}), everything else the plain build\'s')


# --- 1. static ----------------------------------------------------------------------------------
def static(new, old):
    md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
    def bl_target(img, va):
        w = img.u32(va)
        if w >> 24 != 0xeb:
            return None
        off = w & 0xffffff
        if off & 0x800000:
            off -= 0x1000000
        return va + 8 + 4 * off
    for va in LIVE_MODE_CALLS:
        check(bl_target(old, va) == CAPTURE_ASPECT, f'official {va:#x} is not the capture aspect call')
        t = bl_target(new, va)
        check(t is not None and t >= BASE + 0x140b600, f'{va:#x} does not call into the appended area')
    check(old.u32(GRID_DRAW_SLOT) == GRID_DRAW, 'official GridView::Draw slot')
    check(new.u32(GRID_DRAW_SLOT) != GRID_DRAW and new.u32(GRID_DRAW_SLOT) >= BASE + 0x140b600, 'patched Draw slot points into the appended area')
    ins = next(md.disasm(new.R[GRID_CTOR_CLEAR - BASE:GRID_CTOR_CLEAR - BASE + 4], GRID_CTOR_CLEAR))
    check((ins.mnemonic, ins.op_str) == ('str', 'r5, [r4, #0xf4]'), f'constructor clear is {ins.mnemonic} {ins.op_str}')
    zero = None
    for i in md.disasm(old.R[GRID_CTOR - BASE:GRID_CTOR_CLEAR - BASE], GRID_CTOR):
        if i.op_str.startswith('r5,') and i.mnemonic in ('mov', 'ldr', 'add', 'sub', 'movw'):
            zero = (i.mnemonic, i.op_str)
    check(zero == ('mov', 'r5, #0'), f'r5 at the constructor clear is set by {zero}')
    alloc = list(md.disasm(old.R[GRID_ALLOC_CALL - 0x18 - BASE:GRID_ALLOC_CALL - BASE], GRID_ALLOC_CALL - 0x18))
    check(any(i.mnemonic == 'mov' and i.op_str == 'r0, #0xf8' for i in alloc), 'the grid view is allocated with 0xF8 bytes')
    readers = []
    for k in range(40):
        f = old.u32(GRID_VTABLE + 4 * k)
        if not (BASE <= f < BASE + len(old.R)):
            continue
        for i in md.disasm(old.R[f - BASE:f - BASE + 0x800], f):
            if i.address > f and old.u32(i.address) == 0xe1a0c00d:
                break
            if '#0xf6]' in i.op_str or '#0xf7]' in i.op_str:
                readers.append(f'{k}:{i.address:#x}')
    check(not readers, f'grid view methods touch +0xF6/+0xF7: {readers}')
    check(old.u32(PALETTE + 16 * 4) == 0x80000000, f'palette colour 16 is {old.u32(PALETTE + 64):#x}')
    check(old.u32(PALETTE + 19 * 4) == 0x40555555, 'palette colour 19')
    print('static: live-view mode calls patched (official: the capture aspect getter); constructor clears +0xF4..+0xF7 with a zero register; object 0xF8 bytes,'
          ' +0xF6/+0xF7 unused by its methods; colours 16 / 19 = 0x80000000 / 0x40555555')


# --- 2. UpdateViewGrid ------------------------------------------------------------------------------
def update_grid(img, aspects, patched):
    out = {}
    for grid in (0, 1, 2):
        for aspect in aspects:
            e = Emu(img)
            e.stubs = {SET_VISIBLE: ('visible', None), CURRENT_USERDATA: ('userdata', 0 if aspect is None else USERDATA)}
            if aspect is not None:
                e.w8(USERDATA + ASPECT_BYTE, aspect)
            e.w8(VIEW + MARK, 0x55)
            # The frame the tail restores: r4, r5, r6, r7, fp, sp, lr at fp - 0x1C.
            saved = [0x44, 0x55, 0x66, 0x77, 0xbb, STACK - 0x100, STOP]
            for k, v in enumerate(saved):
                e.w32(FRAME - 0x1c + 4 * k, v)
            e.run(UPDATE_GRID_VISIBLE, {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R5: grid, UC_ARM_REG_R6: VIEW, UC_ARM_REG_R11: FRAME,
                                        UC_ARM_REG_R4: 0x1234, UC_ARM_REG_R7: 0x5678})
            regs = [e.mu.reg_read(r) for r in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R11, UC_ARM_REG_SP)]
            visible = [c[1:] for c in e.calls if c[0] == 'visible']
            out[(grid, aspect)] = (visible, e.r8(VIEW + MARK), regs)
    return out


# --- 3. GridView::Draw ------------------------------------------------------------------------------
def rect_at(e, va):
    return struct.unpack('<4i', bytes(e.mu.mem_read(va, 16)))


def record_lines(e, lines, seen=None):
    """Line rectangles handed to the line drawer (stubbed); with `seen`, entries of the native
    grid Draw and of the base view Draw, with the frame at that moment."""
    def hook(uc, addr, size, ud):
        if addr == GRID_LINE:
            lines.append(rect_at(e, uc.reg_read(UC_ARM_REG_R2)))
        elif seen is not None:
            name = 'grid draw' if addr == GRID_DRAW else 'base draw'
            seen.append((name, uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), rect_at(e, VIEW + FRAME_OFF)))
    for va in (GRID_LINE, GRID_DRAW, VIEW_BASE_DRAW):
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=va, end=va)


def native_lines(img, frame, style):
    """The lines the image's own GridView::Draw draws for a frame (x, y, w, h)."""
    e = Emu(img)
    e.stubs = {GRID_LINE: ('line', None)}
    lines = []
    record_lines(e, lines)
    e.mu.mem_write(VIEW + FRAME_OFF, struct.pack('<4i', *frame))
    e.w8(VIEW + 0x9e, 1)
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf7, 0x80)  # a custom grid chosen in the camera (1.20 / 1.21): laid out with the camera's lines
    e.run(GRID_DRAW, {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R1: CTX})
    return lines


SETTING = None


def draw(img, aspect, mark, width, height, userdata=True, frame=(0, 0, 720, 480), style=0, visible=1, code=0):
    """The Draw slot with the camera's own grid Draw, base view Draw and fill; only the line drawer
    is stubbed (its rectangles are recorded). The view has its two line views (the diagonals) as
    children, visible as after a 4x4 layout; their Draw is stubbed and recorded with their visible
    flag at that moment."""
    e = Emu(img)
    e.stubs = {
        CURRENT_USERDATA: ('userdata', USERDATA if userdata else 0), FILL_FACTORY: ('factory', 0x600d0000), FILL_GET: ('filler', 0x600d0100),
        GRID_LINE: ('line', None), CHILD_DRAW: ('child draw', None),
    }
    lines, seen = [], []
    record_lines(e, lines, seen)
    children = []
    e.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, ud: children.append((uc.reg_read(UC_ARM_REG_R0), e.r8(uc.reg_read(UC_ARM_REG_R0) + 0x9e))),
                  begin=CHILD_DRAW, end=CHILD_DRAW)
    e.w32(CHILD_VTABLE + 19 * 4, CHILD_DRAW)
    for k, c in enumerate(CHILD):
        e.w32(c, CHILD_VTABLE)
        e.w8(c + 0x9e, 1)
        e.w32(CHILD_LIST + 4 * k, c)
    e.w32(VIEW + 0xc, CHILD_LIST)
    e.w32(VIEW + 0x10, CHILD_LIST + 4 * len(CHILD))
    e.w32(VIEW + 0xec, CHILD[0])
    e.w32(VIEW + 0xf0, CHILD[1])
    e.w8(USERDATA + ASPECT_BYTE, aspect)
    if SETTING:
        byte, shift, mask, _ = SETTING
        # The bits below the field set (Direct Flash's), the ones above clear (the custom grid's
        # choice: the camera's lines, laid out as such, mark +0xF7 = 0x80; grid/check.py covers it).
        e.w8(byte, ((1 << shift) - 1) | (code << shift))
        e.w8(VIEW + 0xf7, 0x80)
    e.w8(VIEW + MARK, mark)
    e.w8(VIEW + 0x9e, visible)
    e.w8(VIEW + 0xf4, style)
    e.mu.mem_write(VIEW + FRAME_OFF, struct.pack('<4i', *frame))
    e.mu.mem_write(VIEW + DRAWN_OFF, struct.pack('<4I', *SENTINEL))
    e.w8(VIEW + DRAWN_FLAG, 0x77)
    e.w8(CTX + 2, 5)  # 32-bit surface
    e.w32(CTX + 8, PIXELS)
    e.w16(CTX + 0x18, width)
    e.w16(CTX + 0x1a, height)
    rows = height or (width * 2 // 3)
    e.mu.mem_write(PIXELS, struct.pack('<I', CANVAS_FILL) * (width * rows))
    keep = {r: 0x1000 + r for r in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11)}
    e.run(img.u32(GRID_DRAW_SLOT), {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R1: CTX, **keep})
    kept = all(e.mu.reg_read(r) == v for r, v in keep.items()) and e.mu.reg_read(UC_ARM_REG_SP) == STACK
    px = struct.unpack(f'<{width * rows}I', bytes(e.mu.mem_read(PIXELS, 4 * width * rows))) if width else ()
    after = {'calls': [s[:3] for s in seen], 'frames': [s[3] for s in seen], 'lines': lines,
             'frame': rect_at(e, VIEW + FRAME_OFF), 'drawn': tuple(x & 0xffffffff for x in rect_at(e, VIEW + DRAWN_OFF)),
             'flag': e.r8(VIEW + DRAWN_FLAG), 'children': children, 'children after': tuple(e.r8(c + 0x9e) for c in CHILD)}
    return px, after, kept, rows


def window_of(ratio, frame):
    """The frame narrowed to the ratio and centred: the fractions and rounding of the bands."""
    fx, fy = fractions_of(ratio)
    x, y, w, h = frame
    ww = w * fx.numerator // fx.denominator
    wh = h * fy.numerator // fy.denominator
    return x + ((w - ww) >> 1), y + ((h - wh) >> 1), ww, wh


# --- 4. the layout's diagonals -------------------------------------------------------------------
CHILD = (0x60091000, 0x60092000)
CHILD_VTABLE = 0x60093000
CHILD_FRAME = 0x60093800
CHILD_DRAW = 0x60093900
CHILD_LIST = 0x60093a00


def layout(img, style, w, h, aspect):
    """The calls of the grid view's layout to its two line views (frame, points, colour, visibility), in order."""
    e = Emu(img)
    e.stubs = {LINE_SET_POINTS: ('points', None), LINE_SET_COLOUR: ('colour', None), SET_VISIBLE: ('visible', None),
               CHILD_FRAME: ('child frame', None), CURRENT_USERDATA: ('userdata', USERDATA if aspect is not None else 0)}
    calls = []

    def hook(uc, addr, size, ud):
        r0, r1, r2, r3 = (uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3))
        if addr == LINE_SET_POINTS:
            calls.append(('points', r0, struct.unpack('<2i', bytes(uc.mem_read(r1, 8))), struct.unpack('<2i', bytes(uc.mem_read(r2, 8))), r3))
        elif addr == LINE_SET_COLOUR:
            calls.append(('colour', r0, r1 & 0xff))
        elif addr == SET_VISIBLE and r0 in CHILD:
            calls.append(('visible', r0, r1 & 0xff))
        elif addr == CHILD_FRAME:
            calls.append(('frame', r0, struct.unpack('<4i', bytes(uc.mem_read(r1, 16)))))
    for va in (LINE_SET_POINTS, LINE_SET_COLOUR, SET_VISIBLE, CHILD_FRAME):
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=va, end=va)
    e.w32(CHILD_VTABLE + 0x18, CHILD_FRAME)
    for c in CHILD:
        e.w32(c, CHILD_VTABLE)
    e.w32(VIEW + 0xec, CHILD[0])
    e.w32(VIEW + 0xf0, CHILD[1])
    e.mu.mem_write(VIEW + 0x20, struct.pack('<4i', 0, 0, w, h))
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf5, TONES['dark'])
    if aspect is not None:
        e.w8(USERDATA + ASPECT_BYTE, aspect)
    e.run(LAYOUT, {UC_ARM_REG_R0: VIEW})
    return calls


def layout_window(ratio, w, h):
    fx, fy = fractions_of(ratio)
    ww = w * fx.numerator // fx.denominator
    wh = h * fy.numerator // fy.denominator
    x0, y0 = (w - ww) >> 1, (h - wh) >> 1
    return x0, y0, x0 + ww, y0 + wh


def layout_checks(new, old, ids, other_lines=False):
    n = diagonals = 0
    for style in (0, 1):
        for (w, h) in [(720, 480), (720, 240), (640, 480)]:
            for aspect in [None, 0, 1, *ids, 7 + len(ids)]:
                got = layout(new, style, w, h, aspect)
                want = layout(old, style, w, h, aspect)
                what = f'layout style {style} {w}x{h} aspect {aspect}'
                x0, y0, x1, y1 = layout_window(ids[aspect], w, h) if aspect in ids else (0, 0, w, h)
                corners = {CHILD[0]: ((x0, y0), (x1, y1)), CHILD[1]: ((x0, y1), (x1, y0))}
                if other_lines:
                    # Another addition decides which diagonals are shown: each point call it makes is checked.
                    points = [c for c in got if c[0] == 'points']
                    check(all(c[1] in corners and (c[2], c[3]) == corners[c[1]] for c in points), f'{what}: diagonals {points}, want the corners {corners}')
                    diagonals += len(points)
                    n += 1
                    continue
                if aspect in ids:
                    want = [(c[0], c[1], *corners[c[1]], c[4]) if c[0] == 'points' else c for c in want]
                    diagonals += sum(1 for c in want if c[0] == 'points')
                check(got == want, f'{what}: {got}, want {want}')
                n += 1
    check(diagonals > 0, 'the official layout set no diagonal points')
    rest = 'each diagonal shown' if other_lines else 'everything else official'
    print(f'layout: {n} cases; with an added ratio the diagonals ({diagonals} point calls) run corner to corner of its window; {rest}')


def movie_checks(new, old, ids):
    """Movie mode: the aspect setting keeps an added ratio, the screen shows none of it: SetVisible as
    the grid, the native Draw on the whole frame (no band, the lines on the whole picture), the
    official diagonals."""
    global MOVIE
    MOVIE = 1
    n = 0
    try:
        aspects = [0, *ids]
        a = update_grid(new, aspects, True)
        for (grid, aspect), (visible, mark, regs) in a.items():
            check(visible == [(VIEW, grid)], f'movie: UpdateViewGrid grid={grid} aspect={aspect}: SetVisible {visible}')
            n += 1
        full = (0, 0, 720, 480)
        for aspect in aspects:
            for mark in (1, 3):
                for style in (0, 1):
                    for code in (range(SETTING[2] + 1) if SETTING else (0,)):
                        px, after, kept, _ = draw(new, aspect, mark, 720, 480, style=style, code=code)
                        what = f'movie: Draw aspect {aspect} mark {mark} style {style} code {code}'
                        check(kept, what + ': registers or SP not kept')
                        check(after['calls'] == [('grid draw', VIEW, CTX), ('base draw', VIEW, CTX)], f'{what}: calls {after["calls"]}')
                        check(after['frames'] == [full, full], f'{what}: frames {after["frames"]}')
                        check(after['lines'] == native_lines(new, full, style), f'{what}: lines differ from the native Draw')
                        check(after['children'] == [(c, 1) for c in CHILD], f'{what}: line views drawn {after["children"]}')
                        check(all(p == CANVAS_FILL for p in px), what + ': pixels changed')
                        n += 1
        for style in (0, 1):
            for aspect in aspects:
                got, want = layout(new, style, 720, 480, aspect), layout(old, style, 720, 480, aspect)
                check(got == want, f'movie: layout style {style} aspect {aspect}: {got}, want {want}')
                n += 1
    finally:
        MOVIE = 0
    print(f'movie mode: {n} cases; with an added ratio selected nothing of it is drawn (grid view, Draw, diagonals as official)')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = sys.argv[1:]
    tone = opts[opts.index('--tone') + 1] if '--tone' in opts else 'dark'
    args = [a for a in args if a not in TONES]
    global SHADE, SETTING
    SHADE = Image(args[1]).u32(PALETTE + TONES[tone] * 4)
    if '--setting' in opts:
        spec = opts[opts.index('--setting') + 1]
        args = [a for a in args if a != spec]
        byte, shift, mask, argbs = spec.split(':')
        SETTING = (int(byte, 0), int(shift, 0), int(mask, 0), [int(x, 16) for x in argbs.split(',')])
        if len(SETTING[3]) != SETTING[2] + 1:
            raise SystemExit('--setting: one colour per code')
    new, old, plain = Image(args[0]), Image(args[1]), Image(args[2])
    ratios = new.ratios()
    if not ratios:
        raise SystemExit('no ratio record in BUILT-RTOS')
    ids = {7 + k: parse_ratio(r) for k, r in enumerate(ratios)}
    other_lines = '--other-lines' in opts
    print('added ratios:', ', '.join(f'{i} = {r}' for i, r in zip(ids, ratios)))
    static(new, old)
    if SETTING:
        print('shade chosen in the camera: ' + ', '.join(f'code {c} {v:#010x}' for c, v in enumerate(SETTING[3])))
    else:
        print(f'tone {tone}: colour {TONES[tone]} = {SHADE:#010x}')
    live_checks(new, old, plain, ids)

    aspects = [0, 1, 2, 3, *ids, 7 + len(ids), 255, None]
    a = update_grid(new, aspects, True)
    o = update_grid(old, aspects, False)
    n = 0
    for (grid, aspect), (visible, mark, regs) in a.items():
        ovis, omark, oregs = o[(grid, aspect)]
        added = aspect in ids
        want = [(VIEW, 1)] if added else ovis
        check(ovis == [(VIEW, grid)], f'official UpdateViewGrid grid={grid}: {ovis}')
        check(visible == want, f'UpdateViewGrid grid={grid} aspect={aspect}: SetVisible {visible}, want {want}')
        check(mark == (3 if grid else 1), f'UpdateViewGrid grid={grid} aspect={aspect}: mark {mark}')
        check(omark == 0x55, 'official UpdateViewGrid wrote the mark byte')
        check(regs == oregs, f'UpdateViewGrid grid={grid} aspect={aspect}: registers {regs} vs official {oregs}')
        n += 1
    print(f'UpdateViewGrid: {n} cases; SetVisible as official unless an added ratio is selected, then (view, 1); mark 1 | 2 * grid on')

    canvases = [(720, 480), (720, 0), (960, 640), (640, 480), (0, 480)]
    full = (0, 0, 720, 480)
    n = 0
    shaded_cases = 0
    line_cases = 0
    for (width, height) in canvases:
        frames = [full, (8, 6, 704, 468), (0, 37, 720, 405)] if (width, height) == (720, 480) else [full]
        for aspect in [0, 2, 3, *ids, 7 + len(ids)]:
            for frame in frames:
                for mark in (0, 1, 3):
                    for style in ((0, 1) if mark == 3 else (0,)):
                        for code in (range(SETTING[2] + 1) if SETTING and (width, height) == (720, 480) else (0,)):
                          if SETTING:
                              SHADE = SETTING[3][code]
                          px, after, kept, rows = draw(new, aspect, mark, width, height, frame=frame, style=style, code=code)
                          n += 1
                          what = f'Draw {width}x{height} frame {frame} aspect {aspect} mark {mark} style {style} code {code}'
                          check(kept, what + ': registers or SP not kept')
                          check(after['children after'] == (1, 1), f'{what}: line views\' visible flags after Draw {after["children after"]}')
                          if (mark & 1) and aspect in ids and not (mark & 2):
                              check(all(v == 0 for _, v in after['children']), f'{what}: grid off, but line views drawn visible: {after["children"]}')
                          else:
                              check(after['children'] == [(c, 1) for c in CHILD], f'{what}: line views drawn {after["children"]}, want both, visible')
                          both = [('grid draw', VIEW, CTX), ('base draw', VIEW, CTX)]
                          if not (mark & 1) or aspect not in ids:
                              # The native Draw on the frame as it is.
                              check(after['calls'] == both, f'{what}: calls {after["calls"]}')
                              check(after['frames'] == [frame, frame], f'{what}: frames {after["frames"]}')
                              check(after['lines'] == native_lines(new, frame, style), f'{what}: lines differ from the native Draw')
                              check(after['frame'] == frame and after['drawn'] == tuple(x & 0xffffffff for x in frame) and after['flag'] == 1,
                                    f'{what}: frame {after["frame"]}, drawn {after["drawn"]}, flag {after["flag"]}')
                              check(all(p == CANVAS_FILL for p in px), what + ': pixels changed')
                              continue
                          if mark & 2:
                              # The camera's own lines, drawn in the window as for a picture of that shape.
                              win = window_of(ids[aspect], frame)
                              check(after['calls'] == both, f'{what}: calls {after["calls"]}')
                              check(after['frames'] == [win, win], f'{what}: frame during the native Draw {after["frames"]}, want {win}')
                              want = native_lines(new, win, style)
                              check(after['lines'] == want, f'{what}: lines {after["lines"]}, want {want}')
                              if not other_lines:
                                  check(want == native_lines(old, win, style), f'{what}: the lines differ from the official Draw\'s')
                              x, y, w, h = win
                              check(all(x <= lx and lx + lw <= x + w and y <= ly and ly + lh <= y + h for lx, ly, lw, lh in after['lines']),
                                    f'{what}: a line outside the window {win}: {after["lines"]}')
                              if not other_lines:
                                  check(len(after['lines']) == (4 if style == 0 else 6), f'{what}: {len(after["lines"])} lines')
                              check(after['frame'] == frame and after['drawn'] == tuple(v & 0xffffffff for v in frame) and after['flag'] == 1,
                                    f'{what}: after: frame {after["frame"]}, drawn {after["drawn"]}, flag {after["flag"]}')
                              line_cases += 1
                          else:
                              check(after['calls'] == [('base draw', VIEW, CTX)] and not after['lines'], f'{what}: calls {after["calls"]}')
                              check(after['frame'] == frame, f'{what}: frame {after["frame"]}')
                          if style or frame != full:
                              continue
                          if width == 0:
                              check(not px, what)
                              continue
                          w, h, left, top, H = expected_window(ids[aspect], width, height)
                          check(H == rows, what + ': rows')
                          bad = 0
                          for y in range(rows):
                              inside_y = top <= y < top + h
                              row = px[y * width:(y + 1) * width]
                              for x in range(width):
                                  want = CANVAS_FILL if (inside_y and left <= x < left + w) or SHADE == 0 else SHADE
                                  if row[x] != want:
                                      bad += 1
                          check(bad == 0, f'{what}: {bad} pixels wrong (window {w}x{h}+{left}+{top})')
                          if (width, height) == (720, 480):
                              sw, sh, sl, st = screen_crop(ids[aspect])
                              check((w, h, left, top) == (sw, sh, sl, st), f'{what}: window {w}x{h}+{left}+{top}, photo screen crop {sw}x{sh}+{sl}+{st}')
                              # The lines' window on the full frame is the bands' window.
                              check(window_of(ids[aspect], full) == (left, top, w, h), f'{what}: lines window {window_of(ids[aspect], full)}, bands window {(left, top, w, h)}')
                          shaded_cases += 1
            # No user settings at all: the native Draw only.
            if aspect in ids and width:
                px, after, kept, _ = draw(new, aspect, 3, width, height, userdata=False)
                check(after['calls'] == [('grid draw', VIEW, CTX), ('base draw', VIEW, CTX)] and after['frames'] == [full, full]
                      and all(p == CANVAS_FILL for p in px) and kept, f'Draw {width}x{height} without user settings')
                n += 1
            # Not visible: the native Draw draws no line; the frame comes back and its copy is left alone.
            if aspect in ids and (width, height) == (720, 480):
                px, after, kept, _ = draw(new, aspect, 3, width, height, visible=0)
                check(kept and not after['lines'] and after['frame'] == full and after['drawn'] == SENTINEL and after['flag'] == 0,
                      f'Draw not visible, aspect {aspect}: {after}')
                n += 1
    print(f'GridView::Draw: {n} cases, {shaded_cases} with the shade (every pixel checked), {line_cases} with grid lines in the window')
    for r, k in zip(ratios, ids):
        w, h, left, top, _ = expected_window(ids[k], 720, 480)
        print(f'  {r}: on 720x480 the window is {w}x{h}+{left}+{top}, dark bands {"above and below" if h < 480 else "left and right"}')
        for style, name in ((0, '3x3'), (1, '4x4')):
            ls = native_lines(new, window_of(ids[k], full), style)
            ys = sorted({ly for lx, ly, lw, lh in ls if lh == 2})
            xs = sorted({lx for lx, ly, lw, lh in ls if lw == 2})
            print(f'    {name}: horizontal lines at y = {ys}, vertical at x = {xs}')

    layout_checks(new, old, ids, other_lines)
    movie_checks(new, old, ids)

    if failures:
        print(f'{len(failures)} FAILED:')
        for f in failures[:40]:
            print('  ' + f)
        sys.exit(1)
    print('all shade checks passed')


if __name__ == '__main__':
    main()
