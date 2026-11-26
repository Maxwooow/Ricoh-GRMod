# SPDX-License-Identifier: GPL-2.0-only
"""Unicorn helper for test_fw.py: run real GR IV 1.11 RTOS functions (ARM32) with a bump allocator for operator new."""
import os, struct, sys
from unicorn import UC_HOOK_MEM_UNMAPPED, Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UcError
from unicorn.arm_const import *

# The decoded RTOS section to run (never committed); test_fw.py sets it.
RTOS = os.environ.get('RTOS_BIN') or 'RTOS.bin'
BASE = 0x53000000
RAM_COPY = 0x53000450         # the start-up data copy: source, destination, length (as build.ts reads it)
HEAP = 0x55800000
STACK_TOP = 0x7e100000
SENTINEL = 0x7e000010
ALLOC_FNS = (0x53909154, 0x539091c8)   # operator new / new[]
FREE_FNS = (0x53909190, 0x53909204)
NOPS = (0x53916230,)          # assert / log helper: return at once

class Emu:
    def __init__(self):
        self.rt = open(RTOS, 'rb').read()
        RAM_SRC, RAM_DST, RAM_LEN = struct.unpack_from('<3I', self.rt, RAM_COPY - BASE)
        mu = self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(self.rt) + 0xfffff) & ~0xfffff
        mu.mem_map(BASE, size); mu.mem_write(BASE, self.rt)
        mu.mem_map(0x55000000, 0x01000000)
        mu.mem_write(RAM_DST, self.rt[RAM_SRC - BASE: RAM_SRC - BASE + RAM_LEN])
        mu.mem_map(0x60000000, 0x04000000)   # scratch for test objects
        mu.mem_map(0x7e000000, 0x00200000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.heap = HEAP
        self.insn = 0
        for a in ALLOC_FNS + FREE_FNS:
            mu.hook_add(UC_HOOK_CODE, self._hook, begin=a, end=a + 4)
        for a in NOPS:
            mu.hook_add(UC_HOOK_CODE, self._hook, begin=a, end=a + 4)
        mu.mem_write(SENTINEL, struct.pack('<I', 0xe320f000))
        def bad(uc, access, addr, size, val, user):
            print('UNMAPPED access %d addr %#x pc %#x lr %#x' % (access, addr, uc.reg_read(UC_ARM_REG_PC), uc.reg_read(UC_ARM_REG_LR)))
            return False
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, bad)
    def _hook(self, uc, addr, size, user):
        if addr in ALLOC_FNS:
            n = uc.reg_read(UC_ARM_REG_R0)
            p = self.heap; self.heap += (n + 15) & ~15
            uc.mem_write(p, bytes(n))
            uc.reg_write(UC_ARM_REG_R0, p)
        elif addr in NOPS:
            uc.reg_write(UC_ARM_REG_R0, 0)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    def call(self, fn, *args, stack=(), count=200_000_000):
        mu = self.mu
        regs = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3]
        for r, v in zip(regs, args[:4]): mu.reg_write(r, v & 0xffffffff)
        extra = list(args[4:]) + list(stack)
        sp = STACK_TOP - 0x40
        sp -= 4 * len(extra)
        for i, v in enumerate(extra): mu.mem_write(sp + 4 * i, struct.pack('<I', v & 0xffffffff))
        mu.reg_write(UC_ARM_REG_SP, sp)
        mu.reg_write(UC_ARM_REG_LR, SENTINEL)
        mu.emu_start(fn, SENTINEL, count=count)
        return mu.reg_read(UC_ARM_REG_R0)
    def w32(self, a, v): self.mu.mem_write(a, struct.pack('<I', v & 0xffffffff))
    def r32(self, a): return struct.unpack('<I', bytes(self.mu.mem_read(a, 4)))[0]
    def w16(self, a, v): self.mu.mem_write(a, struct.pack('<H', v & 0xffff))
    def r16(self, a): return struct.unpack('<H', bytes(self.mu.mem_read(a, 2)))[0]
    def rb(self, a, n): return bytes(self.mu.mem_read(a, n))
    def wb(self, a, b): self.mu.mem_write(a, bytes(b))
