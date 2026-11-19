# SPDX-License-Identifier: GPL-2.0-only
"""Run the film grain's hooks inside a built RTOS image (unicorn): the development step's settings
hook (0x5393914C), the JPEG step's hook (0x53727E14) through the module to the step's own code,
and the camera's grain wrapper (0x538C9854). Usage: fw_check.py <rtos.bin> [official rtos.bin, for the menu cases]
[--no-halation-ui: a build without the Halation row, where nothing sets HAL_FLAG; it is then 0 as after start-up]"""
import struct
import sys
from pathlib import Path

import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import *

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check  # noqa: E402
import model  # noqa: E402

BASE, RAM_SRC, RAM_DST, RAM_LEN = 0x53000000, 0x543b3100, 0x55000000, 0x58500
LOOK_STASH, FRAME_LOOK = 0x55839024, 0x55839038
STACK, HEAP, PIC, ARG, REC = 0x5f000000, 0x60000000, 0x70000000, 0x5e000000, 0x5e100000
ALLOC, FREE, CACHE, INVAL, CLEAN = 0x539084bc, 0x539084f8, 0x53918010, 0x539180a0, 0x5391808c


def emu(rtos):
    u = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    size = (len(rtos) + 0xfffff) & ~0xfffff
    u.mem_map(BASE, size)
    u.mem_write(BASE, rtos)
    u.mem_map(RAM_DST, 0x1000000)
    u.mem_write(RAM_DST, rtos[RAM_SRC - BASE:RAM_SRC - BASE + RAM_LEN])
    u.mem_map(ARG, 0x200000)
    u.mem_map(STACK - 0x100000, 0x100000)
    u.mem_map(HEAP, 0x4000000)
    u.mem_map(PIC, 0x8000000)
    st = {'top': HEAP, 'live': set()}

    def stub(u, addr, size, _):
        if addr == ALLOC:
            n = u.reg_read(UC_ARM_REG_R0); a = (st['top'] + 63) & ~63; st['top'] = a + n; st['live'].add(a)
            u.reg_write(UC_ARM_REG_R0, a)
        elif addr == FREE:
            st['live'].remove(u.reg_read(UC_ARM_REG_R0))
        elif addr == CACHE:
            u.reg_write(UC_ARM_REG_R0, 0x1234)
        else:
            pass
        u.reg_write(UC_ARM_REG_PC, u.reg_read(UC_ARM_REG_LR))
    for a in (ALLOC, FREE, CACHE, INVAL, CLEAN):
        u.hook_add(UC_HOOK_CODE, stub, begin=a, end=a)
    return u, st


def w(u, a):
    return struct.unpack('<I', u.mem_read(a, 4))[0]


def dev_case(rtos, look, on, strength, size, raw_dev):
    u, _ = emu(rtos)
    u.mem_write(LOOK_STASH, struct.pack('<I', 0x10a11 | 0x3f00000))   # stale grain bits must be replaced
    u.mem_write(FRAME_LOOK, struct.pack('<I', 0x10b12))
    u.mem_write(ARG + 0x2ac, bytes([0 if raw_dev else 1]))
    rec = bytearray(0x800); rec[0x79c] = look; rec[0x7b5] = on; rec[0x7b6] = size; rec[0x7b7] = strength
    u.mem_write(REC, bytes(rec))
    regs = {UC_ARM_REG_R0: 0x1111, UC_ARM_REG_R1: ARG, UC_ARM_REG_R2: look, UC_ARM_REG_R3: REC, UC_ARM_REG_SP: STACK}
    for r, v in regs.items(): u.reg_write(r, v)
    u.emu_start(0x5393914c, 0x53939150)
    for r, v in regs.items(): assert u.reg_read(r) == v, 'register changed'
    assert bool(u.reg_read(UC_ARM_REG_CPSR) & (1 << 30)) == (look == 0xb), 'flags of the compare'
    want = 0x2000000 | ((0x100000 | (min(strength, 3) if strength <= 2 else 0) << 21 | (size if size <= 2 else 0) << 23) if on and look != 28 else 0)
    assert w(u, LOOK_STASH) == 0x10a11 | want, hex(w(u, LOOK_STASH))
    assert w(u, FRAME_LOOK) == (0x10b12 | want if raw_dev else 0x10b12), hex(w(u, FRAME_LOOK))


def jpeg_case(rtos, strength, size, noise):
    u, st = emu(rtos)
    Y, C = check.picture(96, 1024, 7, noise)
    h, wd = Y.shape; stride = 1024
    u.mem_write(PIC, Y.tobytes()); u.mem_write(PIC + 0x100000, C.tobytes())
    u.mem_write(ARG + 0x1000, struct.pack('<B3xIIIHHHHHH4x', 1, PIC, PIC + 0x100000, 0, wd, h, stride, h, 0, 0))
    cfg = bytearray(0x60); struct.pack_into('<4I', cfg, 0x3c, ARG + 0x1000, 0, 0, 0)
    u.mem_write(ARG + 0x2000, bytes(cfg))
    u.mem_write(ARG + 8, struct.pack('<I', ARG + 0x2000))
    u.mem_write(FRAME_LOOK, struct.pack('<I', 0x2000000 | 0x100000 | strength << 21 | size << 23 | 0x10011))
    regs = {UC_ARM_REG_R0: 0xa0, UC_ARM_REG_R1: ARG, UC_ARM_REG_R2: 0xa2, UC_ARM_REG_R3: 0xa3}
    for i, r in enumerate((UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11)):
        regs[r] = 0xb0 + i
    for r, v in regs.items(): u.reg_write(r, v)
    u.reg_write(UC_ARM_REG_SP, STACK); u.reg_write(UC_ARM_REG_IP, STACK); u.reg_write(UC_ARM_REG_LR, 0x12345678)
    u.emu_start(0x53727e14, 0x53727e18)
    for r, v in regs.items(): assert u.reg_read(r) == v, 'register changed'
    assert u.reg_read(UC_ARM_REG_SP) == STACK - 44 and u.reg_read(UC_ARM_REG_IP) == STACK
    saved = struct.unpack('<11I', u.mem_read(STACK - 44, 44))
    assert list(saved[:8]) == [0xb0 + i for i in range(8)] and saved[8] == STACK and saved[9] == 0x12345678, 'frame of the step'
    assert not st['live'], 'allocation not released'
    got = np.frombuffer(u.mem_read(PIC, h * stride), dtype=np.uint8).reshape(h, stride)[:, :wd]
    assert (got == check.expect([(Y, C)])[0]).all(), 'picture differs from the model'
    assert not (got == Y).all()


class Ended(Exception):
    pass


def run_menu(rtos, start, regs, stubs, ends, mem=()):
    """Run from `start` until one of `ends` (address -> name) is reached; `stubs` address -> r0."""
    u, _ = emu(rtos)
    for a, data in mem:
        u.mem_write(a, data)
    hit = []

    def stop(u, addr, size, _):
        if addr in ends:
            hit.append((ends[addr], u.reg_read(UC_ARM_REG_R0), u.reg_read(UC_ARM_REG_R1)))
            u.emu_stop()
        elif addr in stubs:
            u.reg_write(UC_ARM_REG_R0, stubs[addr])
            u.reg_write(UC_ARM_REG_PC, u.reg_read(UC_ARM_REG_LR))
    for a in list(ends) + list(stubs):
        u.hook_add(UC_HOOK_CODE, stop, begin=a, end=a)
    for r, v in regs.items():
        u.reg_write(r, v)
    u.reg_write(UC_ARM_REG_SP, STACK)
    u.reg_write(UC_ARM_REG_LR, 0x5e000100)
    u.emu_start(start, 0x5e000100, count=20000)
    assert hit, f'{start:#x}: no end reached'
    return hit[0]


HAL_FLAG = 0x55839028


def menu_cases(rtos, official, hal_flag=7):
    """Fn and Fn guide of the parameter screens, every row kind, against the official image. With the
    Halation row (halation-ui.ts) its Fn hook sets HAL_FLAG for every row, so a stale value is left in it
    here; without it nothing writes the word, which is zero from start-up."""
    n = 0
    ctrl = ARG + 0x10000
    looks = set()
    for kind in range(0x14):
        for style in (11, 18, 28, 33, 38, 40, 45, 52):
            for movie in (0, 1):
                mem = [(ctrl + 0x19c, bytes([style])), (ctrl + 0x1ac, bytes([movie])), (ctrl + 0x188, struct.pack('<I', 0x1234)), (HAL_FLAG, struct.pack('<I', hal_flag))]
                # Shooting, Fn: 0x531CC944 (0x535AC790: the guide is shown; 0x531CBDCC: the row's kind).
                ends = {0x531cc77c: 'plain', 0x53185054: 'submenu'}
                stubs = {0x535ac790: 1, 0x531cbdcc: kind}
                got = run_menu(rtos, 0x531cc944, {UC_ARM_REG_R0: ctrl}, stubs, ends, mem)
                ref = run_menu(official, 0x531cc944, {UC_ARM_REG_R0: ctrl}, stubs, ends, mem)
                if kind == 0x10:
                    assert got[0] == 'plain', f'Grain Effect still opens its submenu (style {style})'
                elif kind == 8 and got[0] == 'submenu':
                    looks.add(style)   # the Halation row
                else:
                    assert got[0] == ref[0], f'shooting Fn, kind {kind}: {got} / {ref}'
                n += 1
        # Shooting, Fn guide: 0x531CBFAC; the first 0x535ACD84 call gets r1 = shown.
        if kind == 8:
            continue
        stubs = {0x531cbdcc: kind, 0x532406a4: 0, 0x53241548: 0, 0x533ce7d0: 1, 0x533c73dc: 1}
        mem = [(ctrl + 0x188, struct.pack('<I', 0x1234)), (ctrl + 0x18c, struct.pack('<I', 0x5678))]
        got = run_menu(rtos, 0x531cbfac, {UC_ARM_REG_R0: ctrl}, stubs, {0x535acd84: 'guide'}, mem)
        ref = run_menu(official, 0x531cbfac, {UC_ARM_REG_R0: ctrl}, stubs, {0x535acd84: 'guide'}, mem)
        assert got[2] == (0 if kind == 0x10 else ref[2]), f'shooting guide, kind {kind}: {got} / {ref}'
        assert ref[2] == (1 if kind in (0xd, 0x10) else 0)
        # RAW development, Fn (from the kind's compare, r3 the kind) and Fn guide (r4 the kind).
        ends = {0x531ab5bc: 'plain', 0x53185054: 'submenu'}
        stubs = {0x532406a4: 0, 0x53240c98: 0, 0x5337b490: 0}
        got = run_menu(rtos, 0x531ab758, {UC_ARM_REG_R3: kind, UC_ARM_REG_R4: ctrl, UC_ARM_REG_R11: STACK - 0x100}, stubs, ends, [(ctrl + 0x194, struct.pack('<I', 0))])
        ref = run_menu(official, 0x531ab758, {UC_ARM_REG_R3: kind, UC_ARM_REG_R4: ctrl, UC_ARM_REG_R11: STACK - 0x100}, stubs, ends, [(ctrl + 0x194, struct.pack('<I', 0))])
        assert got[0] == ('plain' if kind == 0x10 else ref[0]), f'RAW Fn, kind {kind}: {got} / {ref}'
        stubs = {0x5337aeb8: 1, 0x5337aba0: 1}
        regs = {UC_ARM_REG_R4: kind, UC_ARM_REG_R5: 0x1234, UC_ARM_REG_R6: 0x5678, UC_ARM_REG_R11: STACK}
        got = run_menu(rtos, 0x531aa550, regs, stubs, {0x535acd84: 'guide'})
        ref = run_menu(official, 0x531aa550, regs, stubs, {0x535acd84: 'guide'})
        assert got[2] == (0 if kind == 0x10 else ref[2]), f'RAW guide, kind {kind}: {got} / {ref}'
        n += 4
    return n, looks


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    rtos = Path(args[0]).read_bytes()
    official = Path(args[1]).read_bytes() if len(args) > 1 else None
    hal_flag = 0 if '--no-halation-ui' in sys.argv else 7
    n = 0
    if official:
        m, looks = menu_cases(rtos, official, hal_flag)
        n += m
        print(f'menus: {m} cases; Halation row opens the submenu for styles {sorted(looks)}')
    for look in (11, 0xb, 17, 28, 40):
        for on in (0, 1, 7):
            for strength, size in ((0, 0), (2, 1), (1, 2), (3, 3)):
                for raw_dev in (False, True):
                    dev_case(rtos, look, on, strength, size, raw_dev); n += 1
    for strength, size, noise in ((0, 0, 0.3), (1, 1, 1.5), (2, 2, 4.0), (1, 0, 9.0)):
        jpeg_case(rtos, strength, size, noise); n += 1
    u, _ = emu(rtos)
    u.reg_write(UC_ARM_REG_SP, STACK); u.reg_write(UC_ARM_REG_LR, 0x5e000100); u.reg_write(UC_ARM_REG_R0, 0)
    u.emu_start(0x538c9854, 0x5e000100)
    assert u.reg_read(UC_ARM_REG_R0) == 1 and u.reg_read(UC_ARM_REG_SP) == STACK, 'camera grain wrapper'
    print(f'{n + 1} firmware cases passed')


if __name__ == '__main__':
    main()
