# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the Style list's value labels made wider (datestamp-menu.ts, ROW_VTABLE; test 052).

NOT part of the program. Rows of SelectMenuController's own class (constructor 0x5357AB24) are built
by that constructor, then the list is filled by the controller's own code (0x531DA9D4) with every
widget function real (only four functions that need the running UI are stubbed):

  - the Style list's four value labels (+0xFC of each row) are 100..(row width - 20, at most 680)
    wide; in a build without the widening (REFERENCE) they are 100..500;
  - everything else of the rows and of their widgets is byte for byte as in REFERENCE;
  - other lists (native records 3, 45, 60 and the date imprint's On/Off and Follow Orientation
    lists) leave the rows byte for byte as in REFERENCE;
  - the Style list's draw function keeps every callee-saved register and the stack, and leaves the
    label of a row of another class (0x53579F28) as it is.

    python3 list_width_check.py BUILT.rtos REFERENCE.rtos

Needs the Python packages unicorn and capstone.
"""
import sys, struct, random
NEW, OLD = sys.argv[1], sys.argv[2]
sys.argv = ['x']
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import menu_check as mc
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
from unicorn.arm_const import *
fails = []
def check(c, w):
    if not c: fails.append(w)
def rect(e, w, o=0x20): return struct.unpack('<4i', e.mu.mem_read(w + o, 16))
STUBS = {0x533ef18c: 0, 0x538e0a24: 0, 0x535711e4: 0, 0x53571788: 0}
def build(path, rec, raw, n, row_w):
    img = mc.Image(path)
    e = mc.Emu(img); e.record = {}
    for a, v in STUBS.items(): e.stubs[a] = (lambda v=v: v)
    e.mu.mem_write(mc.B, bytes([raw]))
    rows = []
    for i in range(n):
        it = 0x70100000 + i * 0x400
        e.mu.mem_write(it, bytes(0x300))
        # constructor (this, x, y, width, height)
        e.mu.mem_write(0x600f0000 - 0x100, b'')
        mu = e.mu
        mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
        mu.mem_write(0x600f0000, struct.pack('<I', 60))
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), (it, 20, 100 + 60 * i, row_w)):
            mu.reg_write(r, v)
        mu.reg_write(UC_ARM_REG_LR, 0x100)
        mu.emu_start(0x5357ab24, 0x100, count=5_000_000)
        rows.append(it)
    L, V, W = 0x70700000, 0x70780000, 0x707c0000
    e.mu.mem_write(L, bytes(0x200))
    e.mu.mem_write(W, struct.pack('<%dI' % n, *rows))
    e.mu.mem_write(V, struct.pack('<%dI' % n, *[W + 4 * i for i in range(n)]))
    e.mu.mem_write(L + 0xf4, struct.pack('<2I', V, V + 4 * n))
    this = 0x70000000
    e.mu.mem_write(this, bytes(0x400))
    e.mu.mem_write(this + 0x198, struct.pack('<I', L))
    e.mu.mem_write(this + 0x1a4, bytes([rec]))
    e.mu.mem_write(this + 0x124, struct.pack('<I', mc.NEW_MENU))
    e.call(0x531da9d4, (this,), strict=False)
    return e, rows
def dump(e, rows):
    return b''.join(bytes(e.mu.mem_read(r, 0x300)) + b''.join(bytes(e.mu.mem_read(e.u32(r + o), 0x120)) for o in range(0xec, 0x10c, 4) if 0x70400000 <= e.u32(r + o) < 0x70800000) for r in rows)
for row_w in (720, 700, 680, 640, 600):
    for raw in (1, 3, 9, 11, 0xff):
        a, ra = build(NEW, 126, raw, 4, row_w)
        b, rb = build(OLD, 126, raw, 4, row_w)
        texts = []
        for k, (x, y) in enumerate(zip(ra, rb)):
            la, lb = a.u32(x + 0xfc), b.u32(y + 0xfc)
            texts.append(a.mu.mem_read(la + 0xea, 2).hex())
            ra_, rb_ = rect(a, la), rect(b, lb)
            check(rb_ == (100, 10, 400, 40), f'051 row {k}: label {rb_}')
            check(ra_ == (100, 10, min(row_w - 20, 680) - 100, 40), f'052 width {row_w} byte {raw} row {k}: label {ra_}')
            # everything else of the row and its widgets as in 051
            for o in range(0xec, 0x10c, 4):
                wa, wb = a.u32(x + o), b.u32(y + o)
                if o == 0xfc:
                    da, db = bytearray(a.mu.mem_read(wa, 0x120)), bytearray(b.mu.mem_read(wb, 0x120))
                    for off in range(0x20, 0x40): da[off] = db[off] = 0   # local and drawn rectangles
                    for off in range(0x54, 0x64): da[off] = db[off] = 0
                    diff = [hex(i) for i in range(0x120) if da[i] != db[i]]
                    check(not diff, f'width {row_w} byte {raw} row {k}: label fields differ beyond its rectangles: {diff[:8]}')
                elif 0x70400000 <= wa < 0x70800000:
                    check(bytes(a.mu.mem_read(wa, 0x120)) == bytes(b.mu.mem_read(wb, 0x120)), f'width {row_w} byte {raw} row {k}: widget +{o:#x} differs')
            check(bytes(a.mu.mem_read(x, 0x300)) == bytes(b.mu.mem_read(y, 0x300)), f'row {k}: row object differs')
        if raw == 11:
            print(f'  row width {row_w}: labels', [rect(a, a.u32(x + 0xfc)) for x in ra], 'texts', texts, 'drawn rects', [rect(a, a.u32(x + 0xfc), 0x30) for x in ra])
# a native list (Horizon Correction's record 45, and the On/Off and Follow Orientation lists, 125 / 127): the same in 051 and 052
for rec in (45, 125, 127, 3, 60):
    a, ra = build(NEW, rec, 1, 4, 680)
    b, rb = build(OLD, rec, 1, 4, 680)
    check(dump(a, ra) == dump(b, rb), f'list record {rec}: rows differ between 051 and 052')
print('  native lists and our other two lists: rows identical in 051 and 052')
# registers: the Style list's draw function with random callee-saved registers, and with a row of another class
img = mc.Image(NEW)
lt = img.movw_movt(0x531d6868, 0x531d6878)
draw = img.u32(lt + 126 * 0x4c + 0x14)
for case in ('row', 'other'):
    e, rows = build(NEW, 126, 11, 1, 700)
    row = rows[0]
    lab = rows[0]
    if case == 'other':
        # a row of another class (0x53579F28, value column at 440): its label must stay as it is
        row = 0x70200000
        e.mu.mem_write(row, bytes(0x300))
        e.mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2), (row, 20, 400)): e.mu.reg_write(r, v)
        e.mu.reg_write(UC_ARM_REG_LR, 0x100)
        e.mu.emu_start(0x53579f28, 0x100, count=5_000_000)
        lab = row
    before = rect(e, e.u32(lab + 0xfc))
    regs = {r: random.randrange(1 << 32) for r in (UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11)}
    for r, v in regs.items(): e.mu.reg_write(r, v)
    e.mu.reg_write(UC_ARM_REG_R0, 0x70000000); e.mu.reg_write(UC_ARM_REG_R1, row); e.mu.reg_write(UC_ARM_REG_R2, 3)
    e.mu.reg_write(UC_ARM_REG_SP, 0x600f0000); e.mu.reg_write(UC_ARM_REG_LR, 0x100)
    e.mu.emu_start(draw, 0x100, count=5_000_000)
    check(all(e.mu.reg_read(r) == v for r, v in regs.items()), f'{case}: callee-saved registers changed')
    check(e.mu.reg_read(UC_ARM_REG_SP) == 0x600f0000, f'{case}: sp')
    after = rect(e, e.u32(lab + 0xfc))
    if case == 'row':
        check(after == (100, 10, 580, 40), f'row: label {after}')
    if case == 'other':
        check(after == before, f'other class: label changed {before} -> {after}')
    print(f'  {case}: registers kept, label {before} -> {after}')
print('ALL OK' if not fails else 'FAILED\n  ' + '\n  '.join(fails[:30]))
sys.exit(1 if fails else 0)
