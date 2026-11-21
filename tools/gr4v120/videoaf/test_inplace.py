# SPDX-License-Identifier: GPL-2.0-only
"""The two in-place changes of the movie AF (core/src/fw/gr4v120/aspect/videoaf.ts), the camera's own code run in unicorn on
the official image and on a build, side by side.

usage: test_inplace.py OFFICIAL_RTOS.bin PATCHED_RTOS.bin

1. The wobbling module's step cap, 0x5362a8a0 .. 0x5362a8c4 (r2 = speed / 100, the basic step at [fp, #-0x28], r0 = the
   module's flag + 0xd60, r4 = the module): official max(speed / 100, basic step), or speed / 100 alone with the flag;
   patched max(speed / 100, 16 x basic step), with the flag as before. Nothing stubbed.
2. The focus area by focus mode on the interface side: GetFocusAreaSize 0x533ae04c (its two size helpers and, for modes 0,
   14 and 15, the settings model's aspect ratio stubbed) and the area-type dispatch 0x533ae664 .. 0x533ae6fc. Only mode 8
   (MovieRecording) changes: 590 x 380 auto area (type 5) -> the 64 x 52 single frame (type 1) of mode 3.
Every other word the build changed is left as it is in the official image (only the words above are switched)."""
import itertools, struct, sys
from pathlib import Path
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import *

BASE = 0x53000000
O, OUT, STACK, SENTINEL = 0x60000000, 0x60028000, 0x70000000, 0x7ff00000
W = O + 0x20000
CAP = {0x5362a8ac: 0xe3500000, 0x5362a8b0: 0x11a03002, 0x5362a8b4: 0x01a03203, 0x5362a8b8: 0xe1520003, 0x5362a8bc: 0x81a03002}
AREA = {0x533ae094: 0x533ae0e8, 0x533ae690: 0x533ae79c}
SIZE_STUBS = {0x53911d14: 0, 0x53911d30: 0, 0x539154f8: 0, 0x532406a4: 0, 0x53240c38: 0, 0x5329ccc4: 0}

official, built = Path(sys.argv[1]).read_bytes(), Path(sys.argv[2]).read_bytes()
word = lambda img, a: struct.unpack_from('<I', img, a - BASE)[0]
fails = 0
def check(name, ok):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name); fails += not ok
check('the build has the step cap and the focus area words as declared', all(word(built, a) == w for a, w in {**CAP, **AREA}.items()))
PATCHES = {a: (word(official, a), w) for a, w in {**CAP, **AREA}.items()}

mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
mu.mem_map(BASE, (len(official) + 0xfff) & ~0xfff); mu.mem_write(BASE, official)
mu.mem_map(0x55000000, 0x1000000); mu.mem_map(O, 0x40000); mu.mem_map(STACK - 0x100000, 0x100000); mu.mem_map(SENTINEL, 0x1000)
mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20)); mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
bad, stubs, calls, stop_at = [], {}, [], [()]
mu.hook_add(UC_HOOK_MEM_UNMAPPED, lambda uc, access, address, size, value, data: bad.append((hex(uc.reg_read(UC_ARM_REG_PC)), hex(address))) or False)
def on_code(uc, address, size, data):
    if address in stubs:
        calls.append((address, [uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)]))
        uc.reg_write(UC_ARM_REG_R0, stubs[address]); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    elif address in stop_at[0]: uc.emu_stop()
mu.hook_add(UC_HOOK_CODE, on_code, begin=BASE, end=BASE + len(official))
def use(patched):
    for a, (before, after) in PATCHES.items():
        mu.mem_write(a, struct.pack('<I', after if patched else before)); mu.ctl_remove_cache(a, a + 4)
def run(start, stop, count):
    calls.clear(); bad.clear(); stop_at[0] = (stop,)
    mu.emu_start(start, SENTINEL, count=count)
    assert mu.reg_read(UC_ARM_REG_PC) == stop and not bad, (hex(mu.reg_read(UC_ARM_REG_PC)), bad)

# 1. the step cap
n = changed = 0; ok = True
for speed100, base, flag in itertools.product([0, 1, 3, 10, 40, 200, 3000], [0, 1, 3, 6, 16, 50, 400], [0, 1]):
    got = []
    for patched in (False, True):
        use(patched); mu.mem_write(O, bytes(0x40000)); stubs.clear(); before = bytes(mu.mem_read(W, 0x1000))
        mu.reg_write(UC_ARM_REG_FP, STACK - 0x800); mu.mem_write(STACK - 0x800 - 0x28, struct.pack('<I', base))
        mu.reg_write(UC_ARM_REG_R4, W); mu.reg_write(UC_ARM_REG_R0, flag); mu.reg_write(UC_ARM_REG_R2, speed100)
        run(0x5362a8a0, 0x5362a8c4, 100)
        after = bytearray(mu.mem_read(W, 0x1000)); got.append(struct.unpack_from('<H', after, 0x1e)[0]); after[0x1e:0x20] = before[0x1e:0x20]
        ok &= bytes(after) == before
    b = max(base, 1)
    stock = speed100 if (flag or speed100 >= b) else b
    want = stock if flag else max(speed100, b * 16) & 0xffff
    ok &= got == [stock, want]; n += 1; changed += got[0] != got[1]
check(f'wobbling step cap: {n} cases (speed / 100 x basic step x flag), {changed} differ: official max(speed / 100, basic step), patched max(speed / 100, 16 x basic step), with the flag as before; nothing else written', ok)

# 2. the focus area by mode
rows = {}
for mode in range(16):
    got = []
    for patched in (False, True):
        use(patched); mu.mem_write(O, bytes(0x40000)); stubs.clear(); stubs.update(SIZE_STUBS)
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2), (OUT, 0, mode)): mu.reg_write(r, v)
        mu.reg_write(UC_ARM_REG_SP, STACK - 0x1000); mu.reg_write(UC_ARM_REG_LR, SENTINEL)
        run(0x533ae04c, SENTINEL, 400000)
        size = next(((c[1][1], c[1][2]) for c in calls if c[0] == 0x53911d30), None)
        stubs.clear(); stubs.update(SIZE_STUBS); mu.reg_write(UC_ARM_REG_SL, mode)
        mu.reg_write(UC_ARM_REG_SP, STACK - 0x1000); mu.reg_write(UC_ARM_REG_LR, 0x533ae6fc)
        run(0x533ae664, 0x533ae6fc, 200)
        got.append((size, mu.reg_read(UC_ARM_REG_SL)))
    rows[mode] = got
check('focus area: mode 8 (MovieRecording) 590 x 380 type 5 -> 64 x 52 type 1, the same as mode 3 (SelectMovieRecording); modes 0 .. 7 and 9 .. 15 unchanged',
      rows[8] == [((590, 380), 5), ((64, 52), 1)] and rows[3][0] == ((64, 52), 1) and all(rows[m][0] == rows[m][1] for m in range(16) if m != 8))
print('ALL PASS' if not fails else f'{fails} FAILED'); sys.exit(1 if fails else 0)
