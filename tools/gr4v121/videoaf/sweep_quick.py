# SPDX-License-Identifier: GPL-2.0-only
"""The patched build's travel frame over the camera's sub-states: whatever the camera's own code does with the vote,
a move at the fast speed must be the amount the module named, in the direction of the row of phase results, and only
in a frame in which the module named one.

usage: sweep_quick.py PATCHED_RTOS.bin"""
import json, sys, itertools
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cam import *
from layout import layout
image = Path(sys.argv[1]).read_bytes(); L = layout(image)
REL = [20] * 5
far = lambda k: [400 + k, 410, 390, 405, 395]
def travel_cam(direction, stock, ramp):
    c = Cam(image); c.wobbler(direction=direction)
    c.stock = stock; c.sent = []
    tramp = c.trampoline()
    c.native(STEP, lambda c: c.mu.reg_write(UC_ARM_REG_PC, tramp))
    c.native(VOTE, lambda c: c.stock); c.native(AREA_A, lambda c: 3); c.native(AREA_B, lambda c: 0); c.native(RAMP_OK, lambda c: ramp)
    c.position = 777
    c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0); c.native(LENS_POSITION, lambda c: c.position)
    c.native(LENS_MOVE, lambda c: (c.sent.append((c.r(2), c.r(3), c.r32(c.r(13)))), 1)[1])
    return c
cases = bad = fast_frames = turns = crashes = 0
kinds = {}
for wdir, rowdir, stock, c88, climb, d42, ramp, lead in itertools.product((0, 1), (0, 1), (0, 1, 2, 3), (0, 1, 2, 3, 4), (0, 1, 2, 7), (0, 1), (0, 1), (0, 25)):
    c = travel_cam(wdir, 3, ramp)
    try:
        for k in range(lead):                              # an old travel: frames without phase data first
            c.phase([100, 120, 90, 110, 130], [200] * 5); c.w8(W + 9, 1); c.call(L['wobbleStub'], O)
        c.w8(W + 0x21, wdir); c.w8(W + 0xe5, 5)
        c.phase(far(0), REL, direction=rowdir); c.w8(W + 9, 1); c.call(L['wobbleStub'], O)
        # the frame under test
        c.w8(W + 0x21, wdir); c.w8(W + 0xe5, 5); c.w8(W + 0xc88, c88); c.w16(W + 0xcb0, climb); c.w8(W + 0xd42, d42); c.stock = stock
        c.phase(far(1), REL, direction=rowdir); c.sent = []; c.w8(W + 9, 1)
        st = c.r32(SLOT)
        c.call(L['wobbleStub'], O)
    except AssertionError as e:
        crashes += 1; print('CRASH', (wdir, rowdir, stock, c88, climb, d42, ramp, lead), str(e)[:100]); continue
    cases += 1
    marked = [m for m in c.sent if m[1] & 0x8000]
    after_dir = c.r8(W + 0x21)
    if after_dir != wdir: turns += 1
    if marked:
        fast_frames += 1
        ok = len(marked) == 1 and marked[0][2] == rowdir and marked[0][0] == 111 and wdir == rowdir and climb != 0
        if not ok: bad += 1; print('BAD fast move', (wdir, rowdir, stock, c88, climb, d42, ramp, lead), c.sent)
    for m in c.sent:
        if not (m[1] & 0x8000) and m[1] != 120: bad += 1; print('BAD speed', m)
    if c.r16(W + 0x1e) != 48: bad += 1; print('BAD limit left at', c.r16(W + 0x1e), (wdir, rowdir, stock, c88, climb, d42, ramp, lead))
    if c.r16(st + MARK) != 0xffff: bad += 1; print('BAD name left standing')
    key = ('fast' if marked else 'turn' if after_dir != wdir else 'state %d' % c.r8(W + 0xe5))
    kinds[key] = kinds.get(key, 0) + 1
print(f'{cases} frames over direction of travel x row direction x the vote\'s result x sub-state (module + 0xC88) x steps of the climb x module + 0xD42 x ramp x young / old travel; crashes {crashes}')
print('outcomes:', kinds)
print('PROBLEMS' if bad or crashes else 'every fast move is the 111 units named, in the row\'s direction, never on the first step of a climb; every other move at 120; the camera\'s limit and the name are restored in every case')
sys.exit(1 if bad or crashes else 0)
