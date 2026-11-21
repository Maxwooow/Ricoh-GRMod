# SPDX-License-Identifier: GPL-2.0-only
"""What became of a step sent straight from standby on the camera, version 7 (recording VQ621721, 2026-11-14: nine steps
sent, the lens's position unchanged after every one), shown in the emulator with the lens as it is in standby: held by
nobody.  The lens interface 0x5360D9A8 (real code here) takes a move only from the holder.

usage: untaken_quick.py PATCHED_RTOS.bin"""
import json, struct, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cam import *
from layout import layout

image = Path(sys.argv[1]).read_bytes(); L = layout(image)
for holder, name in ((0, 'nobody holds the lens (standby on the camera)'), (2, 'the movie AF holds it (what the tests of version 7 assumed)'), (4, 'someone else holds it')):
    c = Cam(image); c.wobbler()
    c.native(STEP, lambda c: 0); c.native(MONITOR, lambda c: 0); c.native(LENS_POSITION, lambda c: 500); c.native(LENS_STATE, lambda c: 0); c.native(RESTART, lambda c: 1)
    c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0)
    c.phase([20, 22, 18, 21, 19], [20] * 5); c.call(L['wobbleStub'], O)          # one focusing frame: the module's state exists
    sent = c.standby_lens(holder)
    holders = []
    for k in range(12):
        c.phase([300 + k % 7, 300, 300, 300, 300], [20] * 5, direction=0); c.call(L['monitorStub'], O, 0, 0, 0); holders.append(c.r32(LENS + 0x14))
    state = c.r32(SLOT); version = c.r32(state + 4)
    print(f'version {version}, {name}: the wobbling lens move was called {"(arrived flag cleared)" if 0 in [c.r8(W + 9)] else ""}; moves that reached the lens control: {sent}; holder after each frame: {holders}')
