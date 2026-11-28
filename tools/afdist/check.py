#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""The focus distance while autofocusing (core/src/fw/gr4v120/aspect/afdist.ts, afdist.c), on a built GR IV 1.20 or 1.21
image, in an emulator. The camera's own functions around it are stubs that record what they are called with.

    python3 tools/afdist/check.py 1.20|1.21 BUILT-RTOS [feet]

 1. The seven places changed: the scale's allocation, its constructor and destructor, the call that builds the shooting
    screen's views, the autofocus settings' case of the distance scale's function, its way out, the way out of the
    focus frames' function.
 1b. A new scale has the four added words cleared (the camera's own store kept); the destructor frees the number's
    view through its deleting destructor, once, before the base destructor (r0 the scale there), and nothing without one.
 2. The number's view when the screen has built its views: the camera's builder runs first with its own arguments; a
    text view 100 x 20 is made, added to the root view, set up and hidden; its address after the scale's view.
 3. The autofocus settings' case: with any of the request bytes 8, 0xB, 0xD, 0x11, 0x12 the scale is shown; with none
    the camera's own test follows (r0 as the camera has it there).
 4. The way out: the camera's instruction, registers and stack as before; the number shown with the scale in the
    autofocus settings only, with the text of the distance, as wide as its text, placed under the scale for each
    layout while no focus frame is shown, the text set only when the distance changes.
 4b. The focus frames: the number centred under the one shown frame; under all the frames of an area in focus; under
    the first of other frames (faces); over the frame near the screen's bottom line; kept on the screen at the edges;
    under the scale when the frames' view is hidden. The way out of the frames' function: the camera's instruction,
    registers and stack as before, the number placed and shown as the scale is; the camera's whole function for its
    early way out and for "hidden".
 5. The texts, metres or feet.
 6. The scale's whole function (the camera's code, 0x53189E30) for the half-press in an autofocus setting, for no
    request, for manual focus and hidden: the scale updated with the record's distance, shown or hidden as expected,
    the number with it.
"""
import re
import struct
import sys
from pathlib import Path
from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import *

release, path = sys.argv[1:3]
FEET = len(sys.argv) > 3 and sys.argv[3] == 'feet'
BASE = 0x53000000
REPO = Path(__file__).resolve().parents[2]
TABLE = {}
if release == '1.21':
    for m in re.finditer(r'\[0x([0-9a-f]{8}), 0x([0-9a-f]{8})\]', (REPO / 'core/src/fw/gr4v121/addresses.ts').read_text()):
        TABLE[int(m.group(1), 16)] = int(m.group(2), 16)
elif release != '1.20':
    sys.exit('release: 1.20 or 1.21')
adr = lambda a: TABLE[a] if TABLE else a

img = open(path, 'rb').read()
u32 = lambda a: struct.unpack_from('<I', img, a - BASE)[0]
LV_BUILD_CALL, BUILD_VIEWS, LV_PLACES = adr(0x5318bb90), adr(0x53184428), adr(0x53dbf9bc)
SCALE_FN, SCALE_AF_CASE, SCALE_SHOW, SCALE_HIDE, SCALE_EXIT, SCALE_ALLOC = adr(0x53189e30), adr(0x5318a0f0), adr(0x53189f88), adr(0x53189ec8), adr(0x53189e58), adr(0x535ad788)
FOCUS_REQUESTS, REQUEST_C = adr(0x5324105c), adr(0x533ace10)
FACTORY, ADD_CHILD, SET_VISIBLE, SET_TEXT, SET_ALIGN, SET_FONT, SET_EDGE, MOVE = (adr(a) for a in (0x535ad1b4, 0x535ab428, 0x535acd84, 0x53590490, 0x5359043c, 0x53590458, 0x53590590, 0x535ac024))
SCALE_UPDATE = adr(0x53593040)
SCALE_CTOR_CLEARS, SCALE_DTOR_BASE = adr(0x53592da0), adr(0x535926b0)
TEXT_WIDTH, SET_WIDTH, FRAMES_FN, FRAMES_EXIT = adr(0x53590be0), adr(0x535ac264), adr(0x5318d7d0), adr(0x5318d820)
GET_APP = adr(0x532406a4)
NAMES = {FACTORY: 'factory', ADD_CHILD: 'add', SET_VISIBLE: 'visible', SET_TEXT: 'text', SET_ALIGN: 'align', SET_FONT: 'font', SET_EDGE: 'edge', MOVE: 'move',
         BUILD_VIEWS: 'build', SCALE_UPDATE: 'update', TEXT_WIDTH: 'width', SET_WIDTH: 'setwidth'}
TEXT_PX = 46  # what the stub of the camera's text measuring answers
WIDE = TEXT_PX + 4
PLACED = 0x80000000

failures = []


def check(ok, what):
    if not ok:
        failures.append(what)
        print('  FAIL', what)
    return ok


def target(a):
    w = u32(a)
    off = w & 0xffffff
    if off & 0x800000:
        off -= 0x1000000
    return a + 8 + off * 4


# Three of the camera's functions the scale's function calls, read from its own calls: the model with the "no scale" flags,
# the model asked before the update, the depth of field's limits.
GET_MODEL, GET_Y, DOF_LIMIT = target(SCALE_FN + 0x4c), target(SCALE_SHOW + 0x18), target(SCALE_SHOW + 0x60)
# Two the focus frames' function calls first: a model, and "nothing to do now" (its early way out).
FRAMES_MODEL, FRAMES_BUSY = target(FRAMES_FN + 0x34), target(FRAMES_FN + 0x68)


# Where things are for the emulation.
RET, STACK = 0x100, 0x600f0000
# (the module takes only addresses of the camera's RAM for views)
LV, INFO, SCALE, ROOT, TEXT, X, APP, MODEL, Y, VIEWS, OBJ = 0x5f000000, 0x5f002000, 0x5f004000, 0x5f005000, 0x5f006000, 0x5f007000, 0x5f008000, 0x5f009000, 0x5f00b000, 0x5f00c000, 0x5f00d000
HOLDER, FRAME = 0x5f010000, 0x5f020000  # the view that holds the focus frames; the frames, 0x1000 apart (views 62..87)


class Run:
    """One call into the image; every call to one of the named camera functions is recorded and returns `returns`."""

    def __init__(self, focus=0, mm=1800, layout=0, requests=(), text=TEXT, shown_words=(None, 0xffffffff, 100, 0), display=0, frames=(), holder=(1, 0, 0), scale_visible=0):
        """`frames`: (number 0..25, x, y, width, height, kind) of the frames shown; `holder`: the frames' view (visible, x, y)."""
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(img) + 0x1fffff) & ~0xfffff)
        mu.mem_write(BASE, img)
        mu.mem_map(0x60000000, 0x100000)
        mu.mem_map(0x5f000000, 0x100000)
        mu.mem_map(0, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.mu, self.calls, self.other = mu, [], []
        self.returns = {FACTORY: TEXT, FOCUS_REQUESTS: X, GET_APP: APP, GET_MODEL: MODEL, GET_Y: Y, DOF_LIMIT: 1500, TEXT_WIDTH: TEXT_PX}
        w = lambda a, v: mu.mem_write(a, struct.pack('<I', v))
        w(LV + 0x4ec, INFO); w(LV + 0x4e8, OBJ)
        mu.mem_write(LV + 0x2d4, bytes([layout, display]))
        w(LV + 0x15c + 26 * 4, SCALE); w(LV + 0x15c, ROOT)
        w(VIEWS, ROOT); w(VIEWS + 26 * 4, SCALE)
        mu.mem_write(INFO + 0x998, bytes([focus]))
        w(INFO + 0x6e8, mm)
        mu.mem_write(INFO + 0xbf0, bytes([2]))
        w(SCALE + 0x128, TEXT if shown_words[0] is None else shown_words[0]); w(SCALE + 0x12c, shown_words[1]); w(SCALE + 0x130, shown_words[2]); w(SCALE + 0x134, shown_words[3])
        mu.mem_write(SCALE + 0x9e, bytes([scale_visible]))
        w(LV + 0x15c + 44 * 4, HOLDER)
        mu.mem_write(HOLDER + 0x9e, bytes([holder[0]])); mu.mem_write(HOLDER + 0x20, struct.pack('<4i', holder[1], holder[2], 720, 480))
        for i in range(26):
            w(LV + 0x15c + (62 + i) * 4, FRAME + 0x1000 * i)
        for i, x, y, fw, fh, kind in frames:
            mu.mem_write(FRAME + 0x1000 * i + 0x20, struct.pack('<4i', x, y, fw, fh))
            mu.mem_write(FRAME + 0x1000 * i + 0x9e, b'\x01'); mu.mem_write(FRAME + 0x1000 * i + 0xee, bytes([kind]))
        if text != TEXT:
            w(SCALE + 0x128, text)
        for byte in requests:
            mu.mem_write(X + byte, b'\x01')
        mu.hook_add(UC_HOOK_CODE, self._hook)

    def _hook(self, uc, addr, size, ud):
        if addr in NAMES or addr in self.returns:
            r = [uc.reg_read(x) for x in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)]
            if addr in NAMES:
                name = NAMES[addr]
                if name == 'text':
                    r[1] = bytes(uc.mem_read(r[1], 16)).split(b'\0')[0].decode()
                elif name == 'move':
                    r[1] = struct.unpack('<2i', bytes(uc.mem_read(r[1], 8)))
                elif name == 'factory':
                    r[0] = struct.unpack('<B3x4i', bytes(uc.mem_read(r[0], 20)))
                elif name == 'update':
                    r += list(struct.unpack('<4I', bytes(uc.mem_read(uc.reg_read(UC_ARM_REG_SP), 16))))
                n = {'factory': 1, 'add': 2, 'visible': 2, 'text': 2, 'align': 2, 'font': 3, 'edge': 2, 'move': 2, 'build': 4, 'update': 8, 'width': 1, 'setwidth': 2}[name]
                self.calls.append((name, *r[:n]))
            uc.reg_write(UC_ARM_REG_R0, self.returns.get(addr, 0))
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def go(self, start, stop, regs=(), count=200000):
        mu = self.mu
        mu.reg_write(UC_ARM_REG_SP, STACK)
        mu.reg_write(UC_ARM_REG_LR, RET)
        for r, v in regs:
            mu.reg_write(r, v)
        try:
            mu.emu_start(start, stop, count=count)
        except UcError as e:
            self.calls.append(('error', str(e), hex(mu.reg_read(UC_ARM_REG_PC))))
        return mu.reg_read(UC_ARM_REG_PC)

    def reg(self, r):
        return self.mu.reg_read(r)

    def word(self, a):
        return struct.unpack('<I', bytes(self.mu.mem_read(a, 4)))[0]


print(f'focus distance while autofocusing, {release}{", feet" if FEET else ""}: {path}')

# 1. the places
check(u32(SCALE_ALLOC) == 0xe3a00f4e, f'the scale is allocated with 0x138 bytes: {u32(SCALE_ALLOC):#x}')
check(u32(LV_BUILD_CALL) >> 24 == 0xeb and u32(SCALE_AF_CASE) >> 24 == 0xea and u32(SCALE_EXIT) >> 24 == 0xea and u32(FRAMES_EXIT) >> 24 == 0xea, 'the four branches')
CREATE, ASKED, NUMBER, UNDER = target(LV_BUILD_CALL), target(SCALE_AF_CASE), target(SCALE_EXIT), target(FRAMES_EXIT)
check(all(a >= BASE + 0x1400000 for a in (CREATE, ASKED, NUMBER, UNDER)), 'the stubs are appended code')
CLEARS, FREES = target(SCALE_CTOR_CLEARS), target(SCALE_DTOR_BASE)
check(u32(SCALE_CTOR_CLEARS) >> 24 == 0xea and u32(SCALE_DTOR_BASE) >> 24 == 0xea and CLEARS >= BASE + 0x1400000 and FREES >= BASE + 0x1400000, 'the constructor\'s and destructor\'s branches')
print('  the seven places changed')

# 1b. a new scale; a scale freed
def until(r, start, stop, regs):
    hit = {'at': False}
    r.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, ud: (hit.__setitem__('at', True), uc.emu_stop()) if a == stop else None)
    r.go(start, 0, regs, count=200)
    return hit['at']


r = Run(shown_words=(0xdeadbeef, 0xdeadbeef, 0xdeadbeef, 0xdeadbeef))
r.mu.mem_write(SCALE + 0xec, struct.pack('<I', 0xdeadbeef))
ok = until(r, CLEARS, SCALE_CTOR_CLEARS + 4, [(UC_ARM_REG_R4, SCALE), (UC_ARM_REG_R5, 0), (UC_ARM_REG_R6, 0x66), (UC_ARM_REG_R7, 0x77), (UC_ARM_REG_R8, 0x14)])
check(ok and [r.word(SCALE + o) for o in (0xec, 0x128, 0x12c, 0x130, 0x134)] == [0, 0, 0, 0, 0] and [r.reg(x) for x in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8)] == [SCALE, 0, 0x66, 0x77, 0x14],
      'a new scale: the camera\'s store and the four words cleared')
VT, DELETE = 0x5f00e000, 0x5f00f000
for text in (TEXT, 0):
    r = Run(text=text) if text else Run(shown_words=(0, 0, 0, 0))
    r.mu.mem_write(TEXT, struct.pack('<I', VT)); r.mu.mem_write(VT, struct.pack('<2I', 0x5f00f800, DELETE))
    r.mu.mem_write(DELETE, struct.pack('<I', 0xe12fff1e))  # bx lr
    freed = []
    r.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, ud: freed.append(uc.reg_read(UC_ARM_REG_R0)) if a == DELETE else None)
    ok = until(r, FREES, SCALE_DTOR_BASE + 4, [(UC_ARM_REG_R4, SCALE)])
    check(ok and freed == ([TEXT] if text else []) and r.reg(UC_ARM_REG_R0) == SCALE and r.reg(UC_ARM_REG_R4) == SCALE and r.word(SCALE + 0x128) == 0 and r.reg(UC_ARM_REG_SP) == STACK,
          f'a scale freed {"with" if text else "without"} a number: {[hex(x) for x in freed]}')
print('  a new scale has no number; the destructor frees the number\'s view once, then the camera\'s base destructor with the scale')

# 2. the number's view
r = Run()
pc = r.go(CREATE, RET, [(UC_ARM_REG_R0, LV), (UC_ARM_REG_R1, VIEWS), (UC_ARM_REG_R2, 0x1234), (UC_ARM_REG_R3, 0x5e), (UC_ARM_REG_R4, 0x44444444)])
want = [('build', LV, VIEWS, 0x1234, 0x5e), ('factory', (0, 0, 0, 100, 20)), ('add', ROOT, TEXT), ('align', TEXT, 1), ('font', TEXT, 0x14, 0x14), ('edge', TEXT, 1), ('visible', TEXT, 0)]
check(pc == RET and r.calls == want and r.reg(UC_ARM_REG_SP) == STACK and r.reg(UC_ARM_REG_R4) == 0x44444444, f'the view is made: {r.calls}')
check((r.word(SCALE + 0x128), r.word(SCALE + 0x12c), r.word(SCALE + 0x130), r.word(SCALE + 0x134)) == (TEXT, 0xffffffff, 100, 0), 'its address, "nothing shown yet", its width and "not placed" after the scale\'s view')
r = Run()
r.returns[FACTORY] = 0
pc = r.go(CREATE, RET, [(UC_ARM_REG_R0, LV), (UC_ARM_REG_R1, VIEWS)])
check(pc == RET and r.calls[-1][0] == 'factory' and r.word(SCALE + 0x128) == 0, f'no view from the factory: nothing more, no address kept: {r.calls}')
print('  the number\'s view: made after the camera\'s own views, child of the root, hidden')

# 3. the autofocus settings' case
for requests, shows in (((), False), ((8,), True), ((0xb,), True), ((0xd,), True), ((0x11,), True), ((0x12,), True), ((0xc,), False), ((9,), False), ((0xa,), False), ((8, 0x12), True)):
    r = Run(requests=requests)
    pc = r.go(ASKED, 0, [(UC_ARM_REG_R9, APP)], count=40)
    stops = {SCALE_SHOW: True, SCALE_AF_CASE + 4: False}
    r2 = Run(requests=requests)
    r2.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, ud: uc.emu_stop() if a in stops else None)
    r2.go(ASKED, 0, [(UC_ARM_REG_R9, APP)], count=40)
    at = r2.reg(UC_ARM_REG_PC)
    check(stops.get(at) is shows and (shows or r2.reg(UC_ARM_REG_R0) == APP), f'request bytes {requests}: {"the scale" if shows else "the camera\'s own test"} ({at:#x})')
print('  the autofocus settings: the scale with the half-press or another request; else the camera\'s own test (its byte 0xC)')

# 4. the way out
def out(shown, **kw):
    r = Run(**kw)
    regs = [(UC_ARM_REG_R4, LV), (UC_ARM_REG_R5, shown), (UC_ARM_REG_R6, SCALE), (UC_ARM_REG_R11, STACK + 0x40), (UC_ARM_REG_R7, 0x77), (UC_ARM_REG_R8, 0x88), (UC_ARM_REG_R9, 0x99), (UC_ARM_REG_R10, 0xaa)]
    stop = {'hit': False}
    r.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, ud: (stop.__setitem__('hit', True), uc.emu_stop()) if a == SCALE_EXIT + 4 else None)
    r.go(NUMBER, 0, regs)
    ok = stop['hit'] and r.reg(UC_ARM_REG_R12) == STACK + 0x40 - 0x30 and r.reg(UC_ARM_REG_SP) == STACK and \
        [r.reg(x) for x in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11)] == [LV, shown, SCALE, 0x77, 0x88, 0x99, 0xaa, STACK + 0x40]
    return ok, r


place = lambda x, y: PLACED | y << 16 | x
ok, r = out(1, focus=0, mm=1800)
first = '5.9FT' if FEET else '1.8M'
check(ok and r.calls == [('text', TEXT, first), ('width', TEXT), ('setwidth', TEXT, WIDE), ('move', TEXT, (2, 362)), ('visible', TEXT, 1)] and
      (r.word(SCALE + 0x12c), r.word(SCALE + 0x130), r.word(SCALE + 0x134)) == (1800, WIDE, place(2, 362)), f'shown in an autofocus setting: {r.calls}')
ok, r = out(1, focus=0, mm=1800, shown_words=(None, 1800, WIDE, place(2, 362)))
check(ok and r.calls == [('visible', TEXT, 1)], f'the same distance and place again: only shown: {r.calls}')
ok, r = out(1, focus=0, mm=1800, shown_words=(None, 1800, WIDE, place(2, 362)), layout=2)
check(ok and r.calls == [('move', TEXT, (2, 258)), ('visible', TEXT, 1)] and r.word(SCALE + 0x134) == place(2, 258), f'another layout (the scale at the bottom): placed again, over the scale: {r.calls}')
ok, r = out(1, focus=0, mm=900, shown_words=(None, 1800, WIDE, place(2, 362)))
check(ok and [c[0] for c in r.calls] == ['text', 'width', 'visible'], f'another distance, the same width: the text alone: {r.calls}')
r0 = Run(focus=0, mm=900, shown_words=(None, 1800, WIDE, place(2, 362))); r0.returns[TEXT_WIDTH] = 0
r0.go(NUMBER, SCALE_EXIT + 4, [(UC_ARM_REG_R4, LV), (UC_ARM_REG_R5, 1), (UC_ARM_REG_R6, SCALE), (UC_ARM_REG_R11, STACK + 0x40)])
check(('setwidth', TEXT, 100) in r0.calls, f'no width from the camera: as the view was made: {r0.calls}')
ok, r = out(0, focus=0)
check(ok and r.calls == [('visible', TEXT, 0)], f'the scale hidden: the number hidden: {r.calls}')
for focus in range(16):
    ok, r = out(1, focus=focus, mm=900)
    af = focus <= 4 or focus in (14, 15)
    check(ok and (r.calls[-1] == ('visible', TEXT, 1 if af else 0)) and (af or len(r.calls) == 1), f'Focus {focus}: the number {"shown" if af else "hidden"}: {r.calls}')
for text in (0, 0x1234, TEXT + 1):
    ok, r = out(1, focus=0, text=text)
    check(ok and r.calls == [], f'no view kept ({text:#x}): nothing: {r.calls}')
ok, r = out(1, focus=0, layout=7)
check(ok and ('move', TEXT, (2, 362)) in r.calls, f'an unknown layout: placed as the first: {r.calls}')
print('  the way out: registers, stack and the camera\'s instruction kept; the number with the scale in the autofocus settings, as wide as its text, under the scale while no frame is shown, its text set when the distance changes')

# 4b. the focus frames
def moved(r):
    m = [c[1 + 1] for c in r.calls if c[0] == 'move']
    return m[-1] if m else None


AREA = 0x1b
CASES = [
    ('one frame in the middle', [(0, 320, 200, 80, 80, 3)], (1, 0, 0), (360 - WIDE // 2, 284)),
    ('the frame is not the first view', [(7, 100, 100, 60, 40, 1)], (1, 0, 0), (130 - WIDE // 2, 144)),
    ('the several frames of an area in focus', [(0, 200, 150, 60, 60, AREA), (1, 260, 150, 60, 60, AREA), (2, 200, 210, 60, 60, AREA), (3, 260, 210, 60, 60, AREA)], (1, 0, 0), (260 - WIDE // 2, 274)),
    ('faces: the first frame alone', [(0, 400, 100, 120, 120, 2), (1, 100, 300, 60, 60, 0x16)], (1, 0, 0), (460 - WIDE // 2, 224)),
    ('the target (view 87)', [(25, 326, 206, 68, 68, 0)], (1, 0, 0), (360 - WIDE // 2, 278)),
    ('near the bottom line: over the frame', [(0, 320, 350, 80, 80, 3)], (1, 0, 0), (360 - WIDE // 2, 326)),
    ('just over the bottom line: under', [(0, 320, 300, 80, 116, 3)], (1, 0, 0), (360 - WIDE // 2, 420)),
    ('at the left edge', [(0, 0, 200, 30, 30, 3)], (1, 0, 0), (0, 234)),
    ('at the right edge', [(0, 690, 200, 30, 30, 3)], (1, 0, 0), (720 - WIDE, 234)),
    ('the frames\' view somewhere else', [(0, 320, 200, 80, 80, 3)], (1, 10, 20), (370 - WIDE // 2, 304)),
    ('the frames\' view hidden: under the scale', [(0, 320, 200, 80, 80, 3)], (0, 0, 0), (2, 362)),
    ('a frame without a size: under the scale', [(0, 320, 200, 0, 0, 3)], (1, 0, 0), (2, 362)),
]
for name, frames, holder, at in CASES:
    ok, r = out(1, focus=0, mm=1800, frames=frames, holder=holder)
    check(ok and moved(r) == at and r.calls[-1] == ('visible', TEXT, 1) and r.word(SCALE + 0x134) == place(*at), f'{name}: {moved(r)} (expected {at})')
# the way out of the frames' function
def frames_out(scale_visible, **kw):
    r = Run(scale_visible=scale_visible, **kw)
    canary = 0x5f00a000
    r.mu.mem_write(STACK + 0x40 - 0x30, struct.pack('<I', 0xc0ffee11))
    regs = [(UC_ARM_REG_R4, canary), (UC_ARM_REG_R5, LV), (UC_ARM_REG_R6, 0x66), (UC_ARM_REG_R7, HOLDER), (UC_ARM_REG_R8, 0x88), (UC_ARM_REG_R9, 0x99), (UC_ARM_REG_R10, 0xaa), (UC_ARM_REG_R11, STACK + 0x40)]
    stop = {'hit': False}
    r.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, ud: (stop.__setitem__('hit', True), uc.emu_stop()) if a == FRAMES_EXIT + 4 else None)
    r.go(UNDER, 0, regs)
    ok = stop['hit'] and r.reg(UC_ARM_REG_R2) == 0xc0ffee11 and r.reg(UC_ARM_REG_SP) == STACK and \
        [r.reg(x) for x in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11)] == [canary, LV, 0x66, HOLDER, 0x88, 0x99, 0xaa, STACK + 0x40]
    return ok, r


one = [(0, 320, 200, 80, 80, 3)]
ok, r = frames_out(1, focus=0, mm=1800, frames=one, shown_words=(None, 1800, WIDE, place(2, 362)))
check(ok and r.calls == [('move', TEXT, (360 - WIDE // 2, 284)), ('visible', TEXT, 1)], f'the frames placed, the scale shown: the number moved under the frame: {r.calls}')
ok, r = frames_out(1, focus=0, mm=1800, frames=one, shown_words=(None, 1800, WIDE, place(360 - WIDE // 2, 284)))
check(ok and r.calls == [('visible', TEXT, 1)], f'the same frame again: nothing moved: {r.calls}')
ok, r = frames_out(1, focus=0, mm=1800, shown_words=(None, 1800, WIDE, place(360 - WIDE // 2, 284)))
check(ok and r.calls == [('move', TEXT, (2, 362)), ('visible', TEXT, 1)], f'no frame any more: back under the scale: {r.calls}')
ok, r = frames_out(0, focus=0, mm=1800, frames=one)
check(ok and r.calls == [('visible', TEXT, 0)], f'the scale not shown: the number hidden: {r.calls}')
ok, r = frames_out(1, focus=9, mm=1800, frames=one)
check(ok and r.calls == [('visible', TEXT, 0)], f'manual focus: no number: {r.calls}')
ok, r = frames_out(1, focus=0, text=0, frames=one)
check(ok and r.calls == [], f'no view kept: nothing: {r.calls}')
# the camera's whole function: its early way out, and "hidden" (the frames' view hidden, then the way out)
for shown, busy, want in ((1, 1, [('move', TEXT, (360 - WIDE // 2, 284)), ('visible', TEXT, 1)]), (0, 0, [('visible', HOLDER, 0), ('move', TEXT, (360 - WIDE // 2, 284)), ('visible', TEXT, 1)])):
    r = Run(scale_visible=1, focus=0, mm=1800, frames=one, shown_words=(None, 1800, WIDE, place(2, 362)))
    r.returns[FRAMES_MODEL] = MODEL; r.returns[FRAMES_BUSY] = busy
    pc = r.go(FRAMES_FN, RET, [(UC_ARM_REG_R0, LV), (UC_ARM_REG_R1, 44), (UC_ARM_REG_R2, shown), (UC_ARM_REG_R4, 0x44), (UC_ARM_REG_R5, 0x55)])
    check(pc == RET and r.calls == want and r.reg(UC_ARM_REG_SP) == STACK and (r.reg(UC_ARM_REG_R4), r.reg(UC_ARM_REG_R5)) == (0x44, 0x55), f'the frames\' whole function ({"its early way out" if busy else "hidden"}): {r.calls}')
print('  the focus frames: the number centred under the frame (an area\'s frames together, of faces the first), over it near the bottom line, kept on the screen; the frames\' function leaves as before')

# 5. the texts
METRES = {0: '0.00M', 60: '0.06M', 104: '0.10M', 105: '0.11M', 120: '0.12M', 300: '0.30M', 345: '0.35M', 994: '0.99M', 995: '1.0M', 1000: '1.0M', 1049: '1.0M', 1050: '1.1M', 1800: '1.8M', 2500: '2.5M',
          5000: '5.0M', 9949: '9.9M', 9950: '10M', 10499: '10M', 10500: '11M', 12400: '12M', 29499: '29M', 29999: '30M', 30000: 'INF', 0x7fffffff: 'INF', 0xffffffff: 'INF'}
FEET_TEXTS = {60: '2.4IN', 120: '4.7IN', 300: '11.8IN', 303: '11.9IN', 305: '1.0FT', 1000: '3.3FT', 1800: '5.9FT', 3000: '9.8FT', 3033: '10FT', 5000: '16FT', 12400: '41FT', 29999: '98FT', 30000: 'INF'}
for mm, text in (FEET_TEXTS if FEET else METRES).items():
    ok, r = out(1, focus=0, mm=mm, shown_words=(None, 1, WIDE, 0))
    check(ok and r.calls[:1] == [('text', TEXT, text)], f'{mm} mm: {r.calls[:1]} (expected {text})')
print(f'  the texts: {len(FEET_TEXTS if FEET else METRES)} distances')

# 6. the scale's whole function
def whole(shown, focus, requests, display=0, mm=1800):
    r = Run(focus=focus, mm=mm, requests=requests, display=display)
    r.go(SCALE_FN, RET, [(UC_ARM_REG_R0, LV), (UC_ARM_REG_R1, 26), (UC_ARM_REG_R2, shown)])
    return r


def summary(r):
    upd = [c for c in r.calls if c[0] == 'update']
    vis = [c for c in r.calls if c[0] == 'visible']
    return upd, vis, [c for c in r.calls if c[0] in ('text', 'move', 'error')]


r = whole(1, 0, (8,))
upd, vis, rest = summary(r)
check(r.reg(UC_ARM_REG_PC) == RET and len(upd) == 1 and upd[0][1:3] == (SCALE, 1800) and vis == [('visible', TEXT, 1), ('visible', SCALE, 1)] and ('text', TEXT, first) in rest and not any(c[0] == 'error' for c in rest),
      f'half-press in an autofocus setting: the scale updated with the distance and shown, the number with it: {r.calls}')
r = whole(1, 0, ())
upd, vis, rest = summary(r)
check(r.reg(UC_ARM_REG_PC) == RET and upd == [] and vis == [('visible', TEXT, 0), ('visible', SCALE, 0)] and rest == [], f'an autofocus setting, nothing asked for: both hidden: {r.calls}')
r = whole(1, 9, ())
upd, vis, rest = summary(r)
check(r.reg(UC_ARM_REG_PC) == RET and len(upd) == 1 and vis == [('visible', TEXT, 0), ('visible', SCALE, 1)] and rest == [], f'manual focus: the scale as the camera shows it, no number: {r.calls}')
r = whole(0, 0, (8,))
upd, vis, rest = summary(r)
check(r.reg(UC_ARM_REG_PC) == RET and upd == [] and vis == [('visible', TEXT, 0), ('visible', SCALE, 0)], f'the item hidden by the screen: both hidden: {r.calls}')
for focus in (5, 6, 7, 8):
    r = whole(1, focus, (8,))
    upd, vis, rest = summary(r)
    check(r.reg(UC_ARM_REG_PC) == RET and upd == [] and vis == [('visible', TEXT, 0), ('visible', SCALE, 0)], f'Focus {focus} (never a scale): both hidden: {r.calls}')
print('  the scale\'s function: half-press in an autofocus setting shows the scale with the record\'s distance and the number; nothing asked: hidden; manual focus: the scale alone')

print('ok' if not failures else f'{len(failures)} FAILED')
sys.exit(1 if failures else 0)
