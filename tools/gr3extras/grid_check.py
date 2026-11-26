# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of GR III / IIIx custom grid lines (core/src/fw/gr3x/grid.ts).

    python3 tools/gr3extras/grid_check.py RELEASE OFFICIAL.rtos BUILT.rtos G3 G4 [WITHOUT.rtos]

RELEASE is 2.10, 2.20 or 2.21 (GR III's number; GR IIIx 1.60 / 1.70 / 1.71 are the same programs);
G3 and G4 the build's lines as eight 0/1 digits each (top, centre, bottom, left, centre, right,
diagonal from the top left, diagonal from the bottom left). Development tool, not part of the program.

Runs the camera's own GridView::Draw and layout (and its rectangle and point code) for both grid
styles and several frames, in the official image and in the built one, with the line drawer, the
line views' setters and the base view's Draw replaced by recorders. Checks that
  - every line the build draws that the camera also draws is the camera's, bit for bit;
  - the lines the camera does not draw (3x3 centre lines, 3x3 diagonals) are where grid.ts says;
  - lines that are off are not drawn, diagonals that are off are hidden;
  - the stack, the callee-saved registers and the stack guard are as in the official run;
  - with WITHOUT.rtos (the same build without the grid lines): inside the official image the two
    builds differ by the two hook words only (and by where other hooks' appended code now is).
"""
import struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import *

A = {
    '2.10': dict(draw=0x5339c3b0, layout=0x5339c1e0, line=0x5339c0b0, base=0x533ab9bc, setpts=0x53392384, setcol=0x533924dc, setvis=0x533ad3c0,
                 hook1=0x5339c484, hook2=0x5339c260, ram=(0x5407b540, 0x3a080)),
    '2.20': dict(draw=0x5339c4a0, layout=0x5339c2d0, line=0x5339c1a0, base=None, setpts=0x53392474, setcol=0x533925cc, setvis=0x533ad4b0,
                 hook1=0x5339c574, hook2=0x5339c350, ram=(0x5407b640, 0x3a0c0)),
    '2.21': dict(draw=0x5339edec, layout=0x5339ec1c, line=0x5339eaec, base=None, setpts=0x53394db4, setcol=0x53394f0c, setvis=0x533afdfc,
                 hook1=0x5339eec0, hook2=0x5339ec9c, ram=(0x54084640, 0x3a300)),
}
rel, official, built, g3s, g4s = sys.argv[1:6]
a = A[rel]
BASE = 0x53000000
off = open(official, 'rb').read(); img = open(built, 'rb').read()
G = {0: [c == '1' for c in g3s], 1: [c == '1' for c in g4s]}
CAMERA = {0: [1, 0, 1, 1, 0, 1, 0, 0], 1: [1, 1, 1, 1, 1, 1, 1, 1]}
def bl_target(image, at):
    w = struct.unpack_from('<I', image, at - BASE)[0]; imm = w & 0xffffff
    return at + 8 + 4 * (imm - (1 << 24) if imm & 0x800000 else imm)
# the base view's Draw: the call after the lines are done (Draw + 0x174), found in the official image
a['base'] = bl_target(off, a['draw'] + 0x174)
assert rel != '2.10' or a['base'] == 0x533ab9bc

changed = [BASE + i for i in range(0, len(off), 4) if off[i:i+4] != img[i:i+4]]
if len(sys.argv) > 6:
    base = open(sys.argv[6], 'rb').read()
    # a branch into the appended code whose target only moved (code appended after the grid's) is the same hook
    def moved(i):
        x, y = struct.unpack_from('<I', base, i)[0], struct.unpack_from('<I', img, i)[0]
        return x >> 24 == y >> 24 and (x >> 25) & 7 == 5 and min(bl_target(base, BASE + i), bl_target(img, BASE + i)) >= BASE + len(off)
    only = [BASE + i for i in range(0, len(off), 4) if base[i:i+4] != img[i:i+4] and not moved(i)]
    assert sorted(only) == sorted([a['hook1'], a['hook2']]), [hex(x) for x in only]
    print('against the build without the grid lines: only the two hook words differ inside the official image')
assert a['hook1'] in changed and a['hook2'] in changed
for h in (a['hook1'], a['hook2']):
    assert struct.unpack_from('<I', img, h - BASE)[0] >> 24 == 0xea and bl_target(img, h) >= BASE + len(off)

VIEW, CTX, STACK, RET, RAM = 0x10001000, 0x10003000, 0x20000000, 0x30000000, 0x55000000
SP0 = STACK - 0x400
def run(image, which, style, frame, visible=1):
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, (len(image) + 0xfff) & ~0xfff); mu.mem_write(BASE, image)
    src, n = a['ram']; mu.mem_map(RAM, (n + 0xfff) & ~0xfff); mu.mem_write(RAM, off[src - BASE:src - BASE + n])
    # the stack guard lives in RAM past the initialised part on some releases: map what the code asks for
    mu.mem_map(0x10000000, 0x10000); mu.mem_map(STACK - 0x10000, 0x10000); mu.mem_map(RET, 0x1000)
    x, y, w, h = frame
    view = bytearray(0x100)
    struct.pack_into('<4i', view, 0x20, 0, 0, w, h)      # bounds (the layout's diagonals)
    struct.pack_into('<4i', view, 0x30, x, y, w, h)      # frame (Draw's lines)
    view[0x9e] = visible; view[0xf4] = style; view[0xf5] = 16
    struct.pack_into('<II', view, 0xec, 0x10002000, 0x10002100)
    mu.mem_write(VIEW, bytes(view))
    # the two line views: objects whose virtual SetFrame (vtable + 0x18) is a recorder
    for lv in (0x10002000, 0x10002100): mu.mem_write(lv, struct.pack('<I', 0x10002800))
    mu.mem_write(0x10002800 + 0x18, struct.pack('<I', RET + 0x100))
    out = []
    def leave(v=0):
        mu.reg_write(UC_ARM_REG_R0, v)
        for r in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_IP): mu.reg_write(r, 0xdead0000)
        mu.reg_write(UC_ARM_REG_PC, mu.reg_read(UC_ARM_REG_LR))
    def code(mu_, pc, size, _):
        r = [mu.reg_read(q) for q in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)]
        if pc == RET: mu.emu_stop()
        elif pc == RET + 0x100: out.append(('frame', r[0]) + struct.unpack('<4i', bytes(mu.mem_read(r[1], 16)))); leave()
        elif pc == a['line']: assert r[0] == VIEW and r[1] == CTX; out.append(('line',) + struct.unpack('<4i', bytes(mu.mem_read(r[2], 16)))); leave()
        elif pc == a['base']: out.append(('base', r[0], r[1])); leave()
        elif pc == a['setpts']: out.append(('points', r[0]) + struct.unpack('<2i', bytes(mu.mem_read(r[1], 8))) + struct.unpack('<2i', bytes(mu.mem_read(r[2], 8))) + (r[3],)); leave()
        elif pc == a['setcol']: out.append(('colour', r[0], r[1])); leave()
        elif pc == a['setvis']: out.append(('visible', r[0], r[1])); leave()
    mu.hook_add(UC_HOOK_CODE, code)
    def unmapped(mu_, access, address, size, value, _):
        mu.mem_map(address & ~0xfff, 0x1000); return True
    from unicorn import UC_HOOK_MEM_UNMAPPED
    mu.hook_add(UC_HOOK_MEM_UNMAPPED, unmapped)
    saved = {UC_ARM_REG_R4: 0x44444444, UC_ARM_REG_R5: 0x55555555, UC_ARM_REG_R6: 0x66666666, UC_ARM_REG_R7: 0x77777777, UC_ARM_REG_R8: 0x88888888,
             UC_ARM_REG_R9: 0x99999999, UC_ARM_REG_R10: 0xaaaaaaaa, UC_ARM_REG_R11: 0xbbbbbbbb, UC_ARM_REG_SP: SP0}
    for k, v in saved.items(): mu.reg_write(k, v)
    mu.reg_write(UC_ARM_REG_R0, VIEW); mu.reg_write(UC_ARM_REG_R1, CTX); mu.reg_write(UC_ARM_REG_LR, RET)
    mu.emu_start(a[which], 0, count=20000)
    assert mu.reg_read(UC_ARM_REG_PC) == RET, '%s did not return (pc %#x)' % (which, mu.reg_read(UC_ARM_REG_PC))
    for k, v in saved.items(): assert mu.reg_read(k) == v, 'register / stack not restored'
    return out

def straight(style, frame):
    """grid.ts: [vertical?, k, divisions] -> the rectangle (x, y, w, h) of each of the six straight lines."""
    x, y, w, h = frame
    spec = {0: [(0, 1, 3), (0, 1, 2), (0, 2, 3), (1, 1, 3), (1, 1, 2), (1, 2, 3)], 1: [(0, 1, 4), (0, 2, 4), (0, 3, 4), (1, 1, 4), (1, 2, 4), (1, 3, 4)]}[style]
    return [(x + k * (w // n) - 1, y, 2, h) if v else (x, y + k * (h // n) - 1, w, 2) for v, k, n in spec]

frames = [(0, 0, 720, 480), (0, 0, 640, 480), (40, 0, 640, 480), (120, 0, 480, 480), (0, 37, 720, 405), (3, 5, 719, 479), (0, 0, 1920, 1080)]
for frame in frames:
    for style in (0, 1):
        # Draw
        o = run(off, 'draw', style, frame); b = run(img, 'draw', style, frame)
        assert o[-1][0] == 'base' and b[-1] == o[-1], 'the base view is drawn as before'
        want = straight(style, frame)
        cam = [('line',) + want[i] for i in range(6) if CAMERA[style][i]]
        assert sorted(o[:-1]) == sorted(cam), ('the camera does not draw what grid.ts says it does', frame, style, o, cam)
        mine = [('line',) + want[i] for i in range(6) if G[style][i]]
        assert b[:-1] == mine, ('lines', frame, style, b, mine)
        # layout
        o = run(off, 'layout', style, frame); b = run(img, 'layout', style, frame)
        x, y, w, h = frame
        d = {0x10002000: ('points', 0x10002000, 0, 0, w, h, 2), 0x10002100: ('points', 0x10002100, 0, h, w, 0, 2)}
        cam_pts = [e for e in o if e[0] == 'points']
        assert cam_pts == ([d[0x10002000], d[0x10002100]] if style else []), ('the camera lays the diagonals out as grid.ts says', o)
        for i, v in enumerate((0x10002000, 0x10002100)):
            mine = [e for e in b if e[1] == v and e[0] != 'frame']
            if G[style][6 + i]: assert mine == [d[v], ('colour', v, 16), ('visible', v, 1)], (frame, style, mine)
            else: assert mine == [('visible', v, 0)], (frame, style, mine)
        # everything before the diagonals (the layout of the two line views) is the camera's
        cut = lambda t: [e for e in t if e[0] not in ('points', 'colour', 'visible')]
        assert cut(o) == cut(b)
    # an invisible view draws nothing but the base view, as before
    assert run(off, 'draw', 0, frame, visible=0) == run(img, 'draw', 0, frame, visible=0)
print(rel, 'ok: %d frames, both styles' % len(frames))
