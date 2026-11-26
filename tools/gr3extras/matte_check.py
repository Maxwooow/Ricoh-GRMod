# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the GR III / IIIx matte live view (core/src/fw/gr3x/matte.ts). Development tool.

    python3 tools/gr3extras/matte_check.py RELEASE OFFICIAL.rtos BUILT.rtos PLAIN.rtos RATIOS [--tone dark|light] [--other-lines]

RELEASE is 2.10, 2.20 or 2.21 (GR IIIx 1.60 / 1.70 / 1.71 are the same programs). BUILT is a build with
the matte, PLAIN the same build without it (same ratios, same other additions); RATIOS the added ratios
in menu order, comma-separated (identities 4, 5, ...), e.g. 16:9,4:3,2.39:1,65:24. --tone is the tone
BUILT was made with. --other-lines when BUILT also has custom grid lines (grid.ts): the lines and the
diagonals are then only checked to lie in the window (and to run corner to corner of it).

Addresses: 2.10's, mapped through tools/port/gr3-p2-map.json / gr3-p3-map.json; the few that the maps
do not list are found from a mapped neighbour, with the code compared to 2.10's instruction by instruction.
The camera's own code runs throughout; only the functions named in each check are stubbed.

 0. What the live view's consumers receive. The live-view mode function (0x53669424, its result and
    the mode it stores at +4 of the converter object: the one the main controller copies to +0x751,
    which the face-detection descriptor, the aperture sites, the preview rectangles, the converter
    functions and LiveViewProcessRecipe read) and the secondary preview controller (0x53437170: the
    mode it gives the preview setup 0x5366632C and the aperture 0x53666770), for every capture aspect
    and movie mode on / off, in the official image, the plain build and the built one: with an added
    ratio the built image gives exactly the official answers for 3:2; the plain build gives the added
    identity (today's cropped live view); everything else is the plain build's. And the AF area limits
    (0x532AFBB4, Aspect Ratio setting): the same in the plain and built images, inside the photo's
    window on the 720x480 screen, which is the matte's window.
 1. Static: the two live-mode calls call into the appended code (officially the capture aspect getter),
    the constructor's clear is a word store of a zero register, the object is 0xF8 bytes, no method of
    the first 40 slots touches +0xF6 / +0xF7, the palette colours; inside the official image the built
    and plain images differ by the matte's words only.
 2. UpdateViewGrid's tail: SetVisible as official unless an added ratio is selected, then (view, 1);
    the mark; the registers.
 3. GridView::Draw with the camera's fill writing a canvas, its grid Draw and base view Draw: every
    pixel of the bands; the lines in the window (a 3:2 frame narrowed, any other frame as it is); the
    frame and its copy afterwards; registers and stack.
 4. The layout's diagonals: to the corners of the window with an added ratio and a 3:2 frame,
    everything else official.
 5. Movie mode: nothing of the added ratio is drawn (the diagonals as in PLAIN, which is official without other lines).
"""
import json, re, struct, sys
from fractions import Fraction
from pathlib import Path

from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4,
                               UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9,
                               UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC,
                               UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC, UC_ARM_REG_S0, UC_ARM_REG_IP)

REPO = Path(__file__).resolve().parents[2]
BASE = 0x53000000
RAMVA = 0x55000000
RAM = {'2.10': (0x5407b540, 0x3a080), '2.20': (0x5407b640, 0x3a0c0), '2.21': (0x54084640, 0x3a300)}
STOP = 0x100
md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


# --- addresses ---------------------------------------------------------------------------------------
class Addr:
    def __init__(self, rel, official, ref):
        self.rel, self.off, self.ref = rel, official, ref
        maps = []
        if rel in ('2.20', '2.21'):
            maps.append(json.loads((REPO / 'tools/port/gr3-p2-map.json').read_text())['addresses'])
        if rel == '2.21':
            maps.append(json.loads((REPO / 'tools/port/gr3-p3-map.json').read_text())['addresses'])
        self.maps = maps

    def m(self, a):
        for mp in self.maps:
            e = mp.get('0x%08x' % a)
            if not e or not e.get('ok', True):
                raise KeyError('0x%08x not mapped' % a)
            a = int(e['new'], 16)
        return a

    def near(self, a, anchor, n=24):
        """2.10's `a` in this release, from the mapped `anchor` (same function): the code between them is
        compared instruction by instruction (branch targets aside)."""
        b = self.m(anchor) - (anchor - a)
        lo = min(a, anchor)
        x = [(i.mnemonic, i.op_str if i.mnemonic not in ('bl', 'b', 'blx') and not i.mnemonic.startswith('b') else '') for i in md.disasm(self.ref.R[lo - BASE:lo - BASE + 4 * n], lo)]
        lo2 = lo - a + b
        y = [(i.mnemonic, i.op_str if i.mnemonic not in ('bl', 'b', 'blx') and not i.mnemonic.startswith('b') else '') for i in md.disasm(self.off.R[lo2 - BASE:lo2 - BASE + 4 * n], lo2)]
        mov = lambda t: [(mn, '' if mn.startswith(('movw', 'movt')) else op) for mn, op in t]
        if mov(x) != mov(y):
            raise SystemExit(f'{a:#x}: the code differs in {self.rel}: ' + str([(p, q) for p, q in zip(mov(x), mov(y)) if p != q][:3]))
        return b


class Image:
    def __init__(self, path, rel):
        self.R = open(path, 'rb').read()
        self.rel = rel

    def u32(self, va):
        return struct.unpack_from('<I', self.R, va - BASE)[0]

    def bl_target(self, va):
        w = self.u32(va)
        if (w >> 24) & 0xfe not in (0xea, 0xeb):
            return None
        off = w & 0xffffff
        if off & 0x800000:
            off -= 0x1000000
        return va + 8 + 4 * off


# --- the geometry GR Mod gives a ratio (core/src/fw/aspect/geometry.ts alignedCrop) --------------------
def parse_ratio(text):
    a, b = text.split(':')
    return Fraction(a) / Fraction(b)


def nearest4(v):
    return 4 * ((v + 2) // 4)


def screen_crop(ratio, width=720, height=480):
    if ratio >= Fraction(width, height):
        w, h = width, nearest4(Fraction(width) / ratio)
    else:
        w, h = nearest4(Fraction(height) * ratio), height
    w, h = int(w), int(h)
    return w, h, (width - w) // 2, (height - h) // 2


def expected_window(ratio, width, height):
    """The bands' window on a canvas: liveview.ts's row {w, 720, h, 480}, r0 * r1 / r2, centred."""
    sw, sh, _, _ = screen_crop(ratio)
    if height == 0:
        height = width * 2 // 3
    h = height * sh // 480
    w = width * sw // 720
    return w, h, (width - w) >> 1, (height - h) >> 1, height


def three_two(w, h):
    return abs(2 * w - 3 * h) <= (h >> 4)


def window_of(ratio, frame):
    sw, sh, _, _ = screen_crop(ratio)
    x, y, w, h = frame
    if not three_two(w, h):
        return frame
    ww, wh = w * sw // 720, h * sh // 480
    return x + ((w - ww) >> 1), y + ((h - wh) >> 1), ww, wh


# --- emulator --------------------------------------------------------------------------------------
PROP, OBJ, USERSET, USERDATA = 0x600e0000, 0x600e1000, 0x600a0000, 0x600a1000
STACK = 0x600f0000
VIEW, CTX, FRAME = 0x60090000, 0x60080000, 0x600c0000
PIXELS = 0x61000000
CHILD = (0x60091000, 0x60092000)
CHILD_VTABLE, CHILD_FRAME, CHILD_DRAW, CHILD_LIST = 0x60093000, 0x60093800, 0x60093900, 0x60093a00
SENTINEL = (0x5a5a5a5a,) * 4
CANVAS_FILL = 0x11223344
MARK, FRAME_OFF, DRAWN_OFF, DRAWN_FLAG, ASPECT_BYTE = 0xf6, 0x30, 0x44, 0x40, 0x4c2
A = {}
MOVIE = 0


class Emu:
    def __init__(self, img, ram_from):
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(img.R) + 0xfffff) & ~0xfffff)
        mu.mem_write(BASE, img.R)
        src, n = RAM[img.rel]
        mu.mem_map(RAMVA, 0x1000000)
        mu.mem_write(RAMVA, ram_from.R[src - BASE:src - BASE + n])
        mu.mem_map(0x60000000, 0x100000)
        mu.mem_map(PIXELS, 0x400000)
        mu.mem_map(0, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)

        def unmapped(uc, access, address, size, value, _):
            uc.mem_map(address & ~0xfff, 0x1000)
            return True
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, unmapped)
        self.mu, self.calls, self.stubs = mu, [], {}
        self.base = {A['root']: ('root', PROP), A['movie']: ('movie', None), A['usersettings']: ('usersettings', USERSET)}
        self.w32(PROP, 0x600e0800)
        self.w32(USERSET + 4, USERDATA)
        mu.hook_add(UC_HOOK_CODE, self._hook)

    def _hook(self, uc, addr, size, ud):
        if addr in self.stubs or addr in self.base:
            lr = uc.reg_read(UC_ARM_REG_LR)
            args = tuple(uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3))
            name, ret = self.stubs[addr] if addr in self.stubs else self.base[addr]
            if name == 'movie':
                ret = MOVIE
            if callable(ret):
                ret = ret(uc, args)
            self.calls.append((name,) + args)
            if ret is not None:
                uc.reg_write(UC_ARM_REG_R0, ret)
            # Caller-saved registers are not kept by a call; stubs whose arguments other hooks record keep them.
            if name not in ('line', 'child draw', 'points', 'colour', 'visible', 'child frame'):
                for r in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_IP):
                    uc.reg_write(r, 0xdead0000)
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

    def r32(self, a):
        return struct.unpack('<I', bytes(self.mu.mem_read(a, 4)))[0]


# --- 0. the live view's consumers --------------------------------------------------------------------
def live_mode(img, ram, capture, override):
    """The live-view mode function (r0 = converter object, r1 = 1: store): its result and the stored mode.
    `override`: the camera's flag 0x4A (the mode then comes from +0x6C2 of its object, 2 here)."""
    e = Emu(img, ram)
    e.w8(0x600e0400 + 0x6c2, 2)
    e.w8(OBJ + 4, 0x77)
    e.stubs = {A['capture']: ('capture', capture), A['flagobj']: ('flag object', 0x600e0400), A['flag']: ('flag', override)}
    e.run(A['livefn'], {UC_ARM_REG_R0: OBJ, UC_ARM_REG_R1: 1, UC_ARM_REG_R4: 0x4444, UC_ARM_REG_R5: 0x5555, UC_ARM_REG_R6: 0x6666})
    kept = [e.mu.reg_read(r) for r in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_SP)] == [0x4444, 0x5555, 0x6666, STACK]
    return e.mu.reg_read(UC_ARM_REG_R0), e.r8(OBJ + 4), kept, [c[0] for c in e.calls if c[0] == 'capture']


def secondary(img, ram, capture):
    """The secondary preview controller: the calls it makes (preview setup with its mode, aperture)."""
    e = Emu(img, ram)
    e.w32(0x600e2000 + 8, 0x600e3000)
    def zoom(uc, args):
        uc.reg_write(UC_ARM_REG_S0, 0x3f800000)
        return 0
    e.stubs = {A['singleton']: ('singleton', 0x600e2000), A['prevprep']: ('preview prepare', 0), A['zoom']: ('zoom', zoom),
               A['capture']: ('capture', capture), A['preview']: ('preview setup', 0), A['aperture']: ('aperture', 0)}
    e.run(A['secfn'], {UC_ARM_REG_R4: 0x4444, UC_ARM_REG_R5: 0x5555, UC_ARM_REG_R6: 0x6666})
    kept = [e.mu.reg_read(r) for r in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_SP)] == [0x4444, 0x5555, 0x6666, STACK]
    return [c for c in e.calls if c[0] in ('preview setup', 'aperture', 'preview prepare', 'capture', 'movie')], kept


def af_limits(img, ram, aspect):
    """The AF area limits (0x532AFBB4) with the Aspect Ratio setting `aspect`: (left, top, right, bottom)."""
    e = Emu(img, ram)
    e.w8(USERDATA + ASPECT_BYTE, aspect)
    out = []
    def rect(uc, args):
        sp = uc.reg_read(UC_ARM_REG_SP)
        out.append((args[1], args[2], args[3], struct.unpack('<I', bytes(uc.mem_read(sp, 4)))[0]))
        return None
    e.stubs = {A['ensure']: ('ensure', 0), A['afmode']: ('af mode', 0), A['rectset']: ('rect', rect), A['assert']: ('assert', None)}
    e.run(A['afrect'], {UC_ARM_REG_R0: 0x600e5000, UC_ARM_REG_R1: 0x600e5100})
    return out


def consumer_checks(new, old, plain, ids, names):
    n = 0
    captures = [0, 1, 2, 3, *ids, max(ids) + 1, 255]
    print('live-view mode (stored at +4, copied to the controller\'s +0x751) and secondary controller\'s mode, per capture aspect:')
    for x in captures:
        for override in (0, 1):
            got = live_mode(new, old, x, override)
            ref = live_mode(old, old, 0 if x in ids else x, override) if (x in ids or x < 4) else live_mode(plain, old, x, override)
            pl = live_mode(plain, old, x, override)
            check(got[2], f'live mode capture {x}: registers not kept')
            check(got[:2] == ref[:2] and got[3] == ref[3], f'live mode capture {x} override {override}: {got}, want {ref}')
            if x not in ids:
                check(got[:2] == pl[:2], f'live mode capture {x}: differs from the plain build')
            n += 1
            if override == 0 and x in ids:
                print(f'  {names[x]:>7} (id {x}): official 3:2 -> {ref[0]}, plain build -> {pl[0]} (stored {pl[1]}), matte -> {got[0]} (stored {got[1]})')
            if override and x in ids:
                check(got[0] == pl[0] == 2, f'live mode capture {x}: the camera\'s override is not kept')
    for movie in (0, 1):
        global MOVIE
        MOVIE = movie
        for x in captures:
            got, kept = secondary(new, old, x)
            ref, _ = secondary(old, old, 0 if x in ids else x) if (x in ids or x < 4) else secondary(plain, old, x)
            pl, _ = secondary(plain, old, x)
            check(kept, f'secondary capture {x}: registers not kept')
            check(got == ref, f'secondary capture {x} movie {movie}: {got}, want {ref}')
            if x not in ids:
                check(got == pl, f'secondary capture {x}: differs from the plain build')
            if x in ids and movie == 0:
                mode = lambda calls: [c[3] for c in calls if c[0] == 'preview setup']
                ap = lambda calls: [c[2] for c in calls if c[0] == 'aperture']
                print(f'  {names[x]:>7} secondary: preview setup mode official {mode(ref)} plain {mode(pl)} matte {mode(got)}; aperture flag official {ap(ref)} plain {ap(pl)} matte {ap(got)}')
            n += 1
    MOVIE = 0
    # AF area limits: the Aspect Ratio setting, unchanged by the matte, inside the window.
    print('AF area limits (left, top, right, bottom) on the 720x480 screen, and the matte\'s window:')
    for x in [0, 3, *ids]:
        got, pl, off = af_limits(new, old, x), af_limits(plain, old, x), af_limits(old, old, x) if x < 4 else None
        check(got == pl and len(got) == 1, f'AF limits {x}: {got} vs plain {pl}')
        if x < 4:
            check(got == off, f'AF limits {x}: {got} vs official {off}')
        if x in ids and got:
            w, h, left, top, _ = expected_window(ids[x], 720, 480)
            l, t, r, b = got[0]
            native = af_limits(old, old, 0)[0]
            check(l == max(native[0], left) and t == max(native[1], top) and r == min(native[2], left + w) and b == min(native[3], top + h),
                  f'AF limits {x}: {got[0]} is not the 3:2 limits {native} within the window {(left, top, left + w, top + h)}')
            print(f'  {names[x]:>7}: AF limits {got[0]} (3:2: {native}); window {left},{top}..{left + w},{top + h}')
        n += 1
    print(f'consumers: {n} cases; with an added ratio the live-view mode and the secondary controller are exactly 3:2\'s, the AF limits stay the photo\'s window')


# --- 1. static ---------------------------------------------------------------------------------------
def static(new, old, plain):
    for va in (A['livecall1'], A['livecall2']):
        check(old.bl_target(va) == A['capture'], f'official {va:#x} is not the capture aspect call')
        t = new.bl_target(va)
        check(t is not None and t >= BASE + len(old.R), f'{va:#x} does not call into the appended area')
    check(old.u32(A['slot']) == A['draw'], 'official GridView::Draw slot')
    check(new.u32(A['slot']) >= BASE + len(old.R), 'patched Draw slot points into the appended area')
    ins = next(md.disasm(new.R[A['ctorclear'] - BASE:A['ctorclear'] - BASE + 4], A['ctorclear']))
    check((ins.mnemonic, ins.op_str) == ('str', 'r5, [r4, #0xf4]'), f'constructor clear is {ins.mnemonic} {ins.op_str}')
    zero = None
    for i in md.disasm(old.R[A['ctor'] - BASE:A['ctorclear'] - BASE], A['ctor']):
        if i.op_str.startswith('r5,') and not i.mnemonic.startswith('str'):
            zero = (i.mnemonic, i.op_str)
    check(zero == ('mov', 'r5, #0'), f'r5 at the constructor clear is set by {zero}')
    alloc = list(md.disasm(old.R[A['ctorcall'] - 0x18 - BASE:A['ctorcall'] - BASE], A['ctorcall'] - 0x18))
    check(any(i.mnemonic == 'mov' and i.op_str == 'r0, #0xf8' for i in alloc), 'the grid view is allocated with 0xF8 bytes')
    readers = []
    vt = A['slot'] - 19 * 4
    for k in range(40):
        f = old.u32(vt + 4 * k)
        if not (BASE <= f < BASE + len(old.R)):
            continue
        for i in md.disasm(old.R[f - BASE:f - BASE + 0x800], f):
            if i.address > f and old.u32(i.address) == 0xe1a0c00d:
                break
            if '#0xf6]' in i.op_str or '#0xf7]' in i.op_str:
                readers.append(f'{k}:{i.address:#x}')
    check(not readers, f'grid view methods touch +0xF6/+0xF7: {readers}')
    check(old.u32(A['palette'] + 16 * 4) == 0x80000000, 'palette colour 16')
    check(old.u32(A['palette'] + 19 * 4) == 0x40555555, 'palette colour 19')
    # Inside the official image the built and plain images differ by the matte's words only (a branch whose
    # target moved because appended code moved is the same hook).
    words = {A['livecall1'], A['livecall2'], A['slot'], A['ctorclear'], A['tail'], A['diag1'], A['diag2']}
    def moved(i):
        x, y = struct.unpack_from('<I', plain.R, i)[0], struct.unpack_from('<I', new.R, i)[0]
        if x >> 25 & 7 == 5 and y >> 25 & 7 == 5 and x >> 24 == y >> 24:
            return min(plain.bl_target(BASE + i), new.bl_target(BASE + i)) >= BASE + len(old.R)
        return BASE + len(old.R) <= x < BASE + 0x4000000 and BASE + len(old.R) <= y < BASE + 0x4000000
    diff = {BASE + i for i in range(0, len(old.R), 4) if plain.R[i:i + 4] != new.R[i:i + 4] and not moved(i)}
    extra = sorted(diff - words)
    check(not extra, 'built vs plain: other words differ: ' + ', '.join(hex(x) for x in extra[:12]))
    check(words <= {BASE + i for i in range(0, len(old.R), 4) if old.R[i:i + 4] != new.R[i:i + 4]}, 'a matte word is official')
    print('static: live-mode calls patched (officially the capture aspect getter); constructor clears +0xF4..+0xF7 with a zero register; '
          'object 0xF8 bytes, +0xF6/+0xF7 unused by its methods; colours 16 / 19; built vs plain: the 7 matte words only')


# --- 2. UpdateViewGrid -------------------------------------------------------------------------------
def update_grid(img, ram, aspects):
    out = {}
    for grid in (0, 1, 2):
        for aspect in aspects:
            e = Emu(img, ram)
            e.stubs = {A['setvisible']: ('visible', None)}
            if aspect is None:
                e.w32(USERSET + 4, 0)
            else:
                e.w8(USERDATA + ASPECT_BYTE, aspect)
            e.w8(VIEW + MARK, 0x55)
            saved = [0x44, 0x55, 0x66, 0x77, 0xbb, STACK - 0x100, STOP]
            for k, v in enumerate(saved):
                e.w32(FRAME - 0x1c + 4 * k, v)
            e.run(A['tail'], {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R5: grid, UC_ARM_REG_R6: VIEW, UC_ARM_REG_R11: FRAME,
                              UC_ARM_REG_R4: 0x1234, UC_ARM_REG_R7: 0x5678})
            regs = [e.mu.reg_read(r) for r in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R11, UC_ARM_REG_SP)]
            out[(grid, aspect)] = ([c[1:3] for c in e.calls if c[0] == 'visible'], e.r8(VIEW + MARK), regs)
    return out


# --- 3. GridView::Draw -------------------------------------------------------------------------------
def rect_at(e, va):
    return struct.unpack('<4i', bytes(e.mu.mem_read(va, 16)))


def record_lines(e, lines, seen=None):
    def hook(uc, addr, size, ud):
        if addr == A['line']:
            lines.append(rect_at(e, uc.reg_read(UC_ARM_REG_R2)))
        elif seen is not None:
            name = 'grid draw' if addr == A['draw'] else 'base draw'
            seen.append((name, uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), rect_at(e, VIEW + FRAME_OFF)))
    for va in (A['line'], A['draw'], A['basedraw']):
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=va, end=va)


def native_lines(img, ram, frame, style):
    e = Emu(img, ram)
    e.stubs = {A['line']: ('line', None)}
    lines = []
    record_lines(e, lines)
    e.mu.mem_write(VIEW + FRAME_OFF, struct.pack('<4i', *frame))
    e.w8(VIEW + 0x9e, 1)
    e.w8(VIEW + 0xf4, style)
    e.run(A['draw'], {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R1: CTX})
    return lines


def draw(img, ram, aspect, mark, width, height, userdata=True, frame=(0, 0, 720, 480), style=0, visible=1):
    e = Emu(img, ram)
    e.stubs = {A['fillfactory']: ('factory', 0x600d0000), A['fillget']: ('filler', 0x600d0100),
               A['line']: ('line', None), CHILD_DRAW: ('child draw', None)}
    if not userdata:
        e.w32(USERSET + 4, 0)
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
    e.run(img.u32(A['slot']), {UC_ARM_REG_R0: VIEW, UC_ARM_REG_R1: CTX, **keep})
    kept = all(e.mu.reg_read(r) == v for r, v in keep.items()) and e.mu.reg_read(UC_ARM_REG_SP) == STACK
    px = struct.unpack(f'<{width * rows}I', bytes(e.mu.mem_read(PIXELS, 4 * width * rows))) if width else ()
    after = {'calls': [s[:3] for s in seen], 'frames': [s[3] for s in seen], 'lines': lines,
             'frame': rect_at(e, VIEW + FRAME_OFF), 'drawn': tuple(x & 0xffffffff for x in rect_at(e, VIEW + DRAWN_OFF)),
             'flag': e.r8(VIEW + DRAWN_FLAG), 'children': children, 'children after': tuple(e.r8(c + 0x9e) for c in CHILD)}
    return px, after, kept, rows


# --- 4. the layout's diagonals -------------------------------------------------------------------------
def layout(img, ram, style, w, h, aspect):
    e = Emu(img, ram)
    e.stubs = {A['setpoints']: ('points', None), A['setcolour']: ('colour', None), A['setvisible']: ('visible', None), CHILD_FRAME: ('child frame', None)}
    if aspect is None:
        e.w32(USERSET + 4, 0)
    calls = []

    def hook(uc, addr, size, ud):
        r0, r1, r2, r3 = (uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3))
        if addr == A['setpoints']:
            calls.append(('points', r0, struct.unpack('<2i', bytes(uc.mem_read(r1, 8))), struct.unpack('<2i', bytes(uc.mem_read(r2, 8))), r3))
        elif addr == A['setcolour']:
            calls.append(('colour', r0, r1 & 0xff))
        elif addr == A['setvisible'] and r0 in CHILD:
            calls.append(('visible', r0, r1 & 0xff))
        elif addr == CHILD_FRAME:
            calls.append(('frame', r0, struct.unpack('<4i', bytes(uc.mem_read(r1, 16)))))
    for va in (A['setpoints'], A['setcolour'], A['setvisible'], CHILD_FRAME):
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=va, end=va)
    e.w32(CHILD_VTABLE + 0x18, CHILD_FRAME)
    for c in CHILD:
        e.w32(c, CHILD_VTABLE)
    e.w32(VIEW + 0xec, CHILD[0])
    e.w32(VIEW + 0xf0, CHILD[1])
    e.mu.mem_write(VIEW + 0x20, struct.pack('<4i', 0, 0, w, h))
    e.w8(VIEW + 0xf4, style)
    e.w8(VIEW + 0xf5, 16)
    if aspect is not None:
        e.w8(USERDATA + ASPECT_BYTE, aspect)
    e.run(A['layout'], {UC_ARM_REG_R0: VIEW})
    return calls


def layout_window(ratio, w, h):
    if not three_two(w, h):
        return 0, 0, w, h
    sw, sh, _, _ = screen_crop(ratio)
    ww, wh = w * sw // 720, h * sh // 480
    x0, y0 = (w - ww) >> 1, (h - wh) >> 1
    return x0, y0, x0 + ww, y0 + wh


def layout_checks(new, old, ram, ids, other_lines):
    n = diagonals = 0
    for style in (0, 1):
        for (w, h) in [(720, 480), (720, 240), (640, 480), (1620, 1080)]:
            for aspect in [None, 0, 3, *ids, max(ids) + 1]:
                got = layout(new, ram, style, w, h, aspect)
                want = layout(old, ram, style, w, h, aspect)
                what = f'layout style {style} {w}x{h} aspect {aspect}'
                x0, y0, x1, y1 = layout_window(ids[aspect], w, h) if aspect in ids else (0, 0, w, h)
                corners = {CHILD[0]: ((x0, y0), (x1, y1)), CHILD[1]: ((x0, y1), (x1, y0))}
                if other_lines:
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
    check(diagonals > 0, 'no diagonal points were set')
    print(f'layout: {n} cases; with an added ratio the diagonals ({diagonals} point calls) run corner to corner of its window (3:2 frames), '
          + ('each diagonal shown' if other_lines else 'everything else official'))


def draw_checks(new, old, ram, ids, shade, other_lines):
    canvases = [(720, 480), (720, 0), (960, 640), (640, 480), (0, 480)]
    full = (0, 0, 720, 480)
    n = shaded = line_cases = 0
    for (width, height) in canvases:
        frames = [full, (8, 6, 704, 468), (0, 37, 720, 405), (120, 0, 480, 480)] if (width, height) == (720, 480) else [full]
        for aspect in [0, 3, *ids, max(ids) + 1]:
            for frame in frames:
                for mark in (0, 1, 3):
                    for style in ((0, 1) if mark == 3 else (0,)):
                        px, after, kept, rows = draw(new, ram, aspect, mark, width, height, frame=frame, style=style)
                        n += 1
                        what = f'Draw {width}x{height} frame {frame} aspect {aspect} mark {mark} style {style}'
                        check(kept, what + ': registers or SP not kept')
                        check(after['children after'] == (1, 1), f'{what}: line views\' flags after Draw {after["children after"]}')
                        if (mark & 1) and aspect in ids and not (mark & 2):
                            check(all(v == 0 for _, v in after['children']), f'{what}: grid off, but line views drawn visible: {after["children"]}')
                        else:
                            check(after['children'] == [(c, 1) for c in CHILD], f'{what}: line views drawn {after["children"]}')
                        both = [('grid draw', VIEW, CTX), ('base draw', VIEW, CTX)]
                        if not (mark & 1) or aspect not in ids:
                            check(after['calls'] == both, f'{what}: calls {after["calls"]}')
                            check(after['frames'] == [frame, frame], f'{what}: frames {after["frames"]}')
                            check(after['lines'] == native_lines(new, ram, frame, style), f'{what}: lines differ from the native Draw')
                            check(after['frame'] == frame and after['drawn'] == tuple(x & 0xffffffff for x in frame) and after['flag'] == 1, f'{what}: frame after')
                            check(all(p == CANVAS_FILL for p in px), what + ': pixels changed')
                            continue
                        if mark & 2:
                            win = window_of(ids[aspect], frame)
                            check(after['calls'] == both, f'{what}: calls {after["calls"]}')
                            check(after['frames'] == [win, win], f'{what}: frame during the native Draw {after["frames"]}, want {win}')
                            want = native_lines(new, ram, win, style)
                            check(after['lines'] == want, f'{what}: lines {after["lines"]}, want {want}')
                            if not other_lines:
                                check(want == native_lines(old, ram, win, style), f'{what}: the lines differ from the official Draw\'s')
                                check(len(after['lines']) == (4 if style == 0 else 6), f'{what}: {len(after["lines"])} lines')
                            x, y, w, h = win
                            check(all(x <= lx and lx + lw <= x + w and y <= ly and ly + lh <= y + h for lx, ly, lw, lh in after['lines']),
                                  f'{what}: a line outside the window {win}: {after["lines"]}')
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
                        for yy in range(rows):
                            inside_y = top <= yy < top + h
                            row = px[yy * width:(yy + 1) * width]
                            for xx in range(width):
                                want = CANVAS_FILL if inside_y and left <= xx < left + w else shade
                                if row[xx] != want:
                                    bad += 1
                        check(bad == 0, f'{what}: {bad} pixels wrong (window {w}x{h}+{left}+{top})')
                        if (width, height) == (720, 480):
                            sw, sh, sl, st = screen_crop(ids[aspect])
                            check((w, h, left, top) == (sw, sh, sl, st), f'{what}: window {w}x{h}+{left}+{top}, photo screen crop {sw}x{sh}+{sl}+{st}')
                            check(window_of(ids[aspect], full) == (left, top, w, h), f'{what}: lines window vs bands window')
                        shaded += 1
            if aspect in ids and width:
                px, after, kept, _ = draw(new, ram, aspect, 3, width, height, userdata=False)
                check(after['calls'] == [('grid draw', VIEW, CTX), ('base draw', VIEW, CTX)] and after['frames'] == [full, full]
                      and all(p == CANVAS_FILL for p in px) and kept, f'Draw {width}x{height} without user data')
                n += 1
            if aspect in ids and (width, height) == (720, 480):
                px, after, kept, _ = draw(new, ram, aspect, 3, width, height, visible=0)
                check(kept and not after['lines'] and after['frame'] == full and after['drawn'] == SENTINEL and after['flag'] == 0,
                      f'Draw not visible, aspect {aspect}: {after}')
                n += 1
    print(f'GridView::Draw: {n} cases, {shaded} with the matte (every pixel checked), {line_cases} with grid lines in the window')


def movie_checks(new, plain, ram, ids):
    global MOVIE
    MOVIE = 1
    n = 0
    try:
        aspects = [0, *ids]
        for (grid, aspect), (visible, mark, regs) in update_grid(new, ram, aspects).items():
            check(visible == [(VIEW, grid)], f'movie: UpdateViewGrid grid={grid} aspect={aspect}: SetVisible {visible}')
            n += 1
        full = (0, 0, 720, 480)
        for aspect in aspects:
            for mark in (1, 3):
                for style in (0, 1):
                    px, after, kept, _ = draw(new, ram, aspect, mark, 720, 480, style=style)
                    what = f'movie: Draw aspect {aspect} mark {mark} style {style}'
                    check(kept and after['calls'] == [('grid draw', VIEW, CTX), ('base draw', VIEW, CTX)] and after['frames'] == [full, full], what)
                    check(after['lines'] == native_lines(new, ram, full, style), f'{what}: lines differ from the native Draw')
                    check(all(p == CANVAS_FILL for p in px), what + ': pixels changed')
                    n += 1
        for style in (0, 1):
            for aspect in aspects:
                check(layout(new, ram, style, 720, 480, aspect) == layout(plain, ram, style, 720, 480, aspect), f'movie: layout style {style} aspect {aspect}')
                n += 1
    finally:
        MOVIE = 0
    print(f'movie mode: {n} cases; nothing of an added ratio is drawn (grid view and Draw as official, diagonals as the plain build\'s)')


def main():
    opts = sys.argv[1:]
    tone = opts[opts.index('--tone') + 1] if '--tone' in opts else 'dark'
    other_lines = '--other-lines' in opts
    args = [a for a in opts if not a.startswith('--') and a not in ('dark', 'light')]
    rel, offp, newp, plainp, ratios = args[:5]
    old, new, plain = Image(offp, rel), Image(newp, rel), Image(plainp, rel)
    # The 2.10 image the addresses are written for: the official 2.10 RTOS next to the release's, or the official itself.
    ref210 = Path(offp).with_name('gr3_v210.rtos')
    ref = Image(str(ref210), '2.10') if rel != '2.10' else old
    ad = Addr(rel, old, ref)
    m = ad.m
    A.update(capture=m(0x5354a778), root=m(0x53525d5c), movie=m(0x53549958), usersettings=m(0x5320b31c),
             livecall1=m(0x53669440), livecall2=m(0x534371c4), slot=m(0x53c0aab4), draw=m(0x5339c3b0), basedraw=m(0x533ab9bc),
             ctorclear=m(0x5339c01c), tail=m(0x53177538), setvisible=m(0x533ad3c0), fillfactory=m(0x5320804c), fillget=m(0x532081ec),
             diag1=m(0x5339c2d8), diag2=m(0x5339c318), setpoints=m(0x53392384), setcolour=m(0x533924dc), line=m(0x5339c0b0),
             flagobj=m(0x53654150), flag=m(0x53654220), singleton=m(0x536659ac), preview=m(0x5366632c),
             afrect=m(0x532afbb4), ensure=m(0x5320ad88))
    A['livefn'] = ad.near(0x53669424, 0x53669440)
    A['secfn'] = ad.near(0x53437170, 0x534371c4, 40)
    A['ctor'] = ad.near(0x5339bfb8, 0x5339c01c, 26)
    A['layout'] = ad.near(0x5339c1e0, 0x5339c2d8, 62)
    # Callees read from the official image's calls (the code around them compared above).
    A['prevprep'] = old.bl_target(A['secfn'] + 0x20)
    A['zoom'] = old.bl_target(A['secfn'] + 0x2c)
    A['aperture'] = old.bl_target(A['secfn'] + 0xc0)
    A['afmode'] = old.bl_target(A['afrect'] + 0x20)
    A['rectset'] = old.bl_target(A['afrect'] + 0x44)
    A['assert'] = old.bl_target(A['afrect'] + 0xa0)
    # the constructor's one caller (the grid view's factory)
    ctorcalls = [BASE + i for i in range(0, len(old.R), 4) if old.R[i + 3] == 0xeb and old.bl_target(BASE + i) == A['ctor']]
    check(len(ctorcalls) == 1, f'constructor callers {ctorcalls}')
    A['ctorcall'] = ctorcalls[0]
    pal = ref.R[0x53dbb1ec - BASE:0x53dbb1ec - BASE + 48 * 4]
    hits = [k for k in range(0, len(old.R), 4) if old.R[k:k + len(pal)] == pal] if rel != '2.10' else [0x53dbb1ec - BASE]
    check(len(hits) == 1, f'UI palette found {len(hits)} times')
    A['palette'] = BASE + hits[0]
    names = {4 + k: r for k, r in enumerate(ratios.split(','))}
    ids = {k: parse_ratio(r) for k, r in names.items()}
    shade = old.u32(A['palette'] + {'dark': 16, 'light': 19}[tone] * 4)
    print(f'GR III {rel}; added ratios ' + ', '.join(f'{i} = {r}' for i, r in names.items()) + f'; tone {tone} = {shade:#010x}')
    static(new, old, plain)
    consumer_checks(new, old, plain, ids, names)
    aspects = [0, 1, 2, 3, *ids, max(ids) + 1, 255, None]
    a = update_grid(new, old, aspects)
    o = update_grid(old, old, aspects)
    n = 0
    for (grid, aspect), (visible, mark, regs) in a.items():
        ovis, omark, oregs = o[(grid, aspect)]
        want = [(VIEW, 1)] if aspect in ids else ovis
        check(ovis == [(VIEW, grid)], f'official UpdateViewGrid grid={grid}: {ovis}')
        check(visible == want, f'UpdateViewGrid grid={grid} aspect={aspect}: SetVisible {visible}, want {want}')
        check(mark == (3 if grid else 1), f'UpdateViewGrid grid={grid} aspect={aspect}: mark {mark}')
        check(omark == 0x55, 'official UpdateViewGrid wrote the mark byte')
        check(regs == oregs, f'UpdateViewGrid grid={grid} aspect={aspect}: registers {regs} vs official {oregs}')
        n += 1
    print(f'UpdateViewGrid: {n} cases; SetVisible as official unless an added ratio is selected, then (view, 1); mark 1 | 2 * grid on')
    draw_checks(new, old, old, ids, shade, other_lines)
    for k, r in names.items():
        w, h, left, top, _ = expected_window(ids[k], 720, 480)
        print(f'  {r}: on 720x480 the window is {w}x{h}+{left}+{top}')
    layout_checks(new, old, old, ids, other_lines)
    movie_checks(new, plain, old, ids)
    if failures:
        print(f'{len(failures)} FAILED:')
        for f in failures[:40]:
            print('  ' + f)
        sys.exit(1)
    print('all matte checks passed')


if __name__ == '__main__':
    main()
