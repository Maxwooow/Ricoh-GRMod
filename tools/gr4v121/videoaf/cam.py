# SPDX-License-Identifier: GPL-2.0-only
"""A harness that runs parts of the GR IV 1.21 RTOS (official or patched) in unicorn, for the movie AF tests.

Real camera code is executed wherever the tests are about it: the wobbling module's travel state 0x5362FF98 and lens
move 0x53630DFC, the lens interface 0x5360E2E8 -> 0x539526D4, the lens control's dispatcher 0x539544DC and relative
move 0x539530CC, and everything appended by the build.  What surrounds it is replaced: operator new, the timer, the
file service, the per-area contrast evaluation, the vote (when a test wants to choose its result), the lens itself."""
import struct
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import *

BASE = 0x53000000
O, W, ZAF, INFO, LENS, LCO, BUF, HEAP, HOLD, VT, FAKE = (0x60000000, 0x60020000, 0x60030000, 0x60031000, 0x60038000, 0x60039000,
                                                       0x60100000, 0x60200000, 0x60040000, 0x60041000, 0x60042000)
B = INFO + 0x10
STACK, SENTINEL = 0x70000000, 0x7ff00000
OPEN, WRITE, CLOSE = FAKE, FAKE + 4, FAKE + 8
STEP, VOTE, AREA_A, AREA_B, RAMP_OK = 0x5361f6c8, 0x5362cb08, 0x5362f820, 0x5362b998, 0x5362c930
TRAVEL, MOVE, LENS_MOVE, LENS_KIND, LENS_590A, LENS_POSITION, STOP = 0x5362ff98, 0x53630dfc, 0x5360e2e8, 0x5360e6c4, 0x5360e4e4, 0x5360e934, 0x536123c4
LENS_COMMAND, SIGNAL, DISPATCH, RELATIVE = 0x539526d4, 0x53903bc8, 0x539544dc, 0x539530cc
MONITOR, RESTART, LENS_STATE, PARENT, LENS_OBJECT, SLOT, MARK = 0x536228ac, 0x5360a4f0, 0x5360f0f0, 0x60044000, 0x60045000, 0x5583907c, 0x54
DECISION, KEEP_PHASE, ASK_CALL = 0x53614ec4, 0x536229cc, 0x53615130
LENS_TAKE, LENS_GIVE_BACK, LENS_QUERY = 0x5360e2c0, 0x5360e758, 0x539533f8


class Cam:
    def __init__(self, image):
        self.image = image
        mu = self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(image) + 0xfff) & ~0xfff); mu.mem_write(BASE, image)
        self.tramp = BASE + ((len(image) + 0xfff) & ~0xfff) + 0x1000; mu.mem_map(self.tramp, 0x1000)   # within reach of a bl from and to the image
        mu.mem_map(0x55000000, 0x1000000); mu.mem_map(O, 0x400000); mu.mem_map(STACK - 0x100000, 0x100000); mu.mem_map(SENTINEL, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20)); mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)   # VFP on
        self.bad = []
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, lambda uc, access, address, size, value, data: self.bad.append((hex(uc.reg_read(UC_ARM_REG_PC)), hex(address))) or False)
        self.tick = 1000; self.allocs = []; self.opened = None; self.written = None; self.closed = 0; self.events = []
        self.hooks = {}
        self.native(0x53909154, lambda c: (c.allocs.append(c.r(0)), HEAP)[1])
        self.native(0x5391aaa0, lambda c: HOLD)
        self.native(0x5391d79c, self._tick)
        self.native(0x5391d7ac, lambda c: (c.r(2) - c.r(1)) * 1000 if c.r(2) != c.r(1) else 1 << 26)   # as the camera's: 2^26 for no time at all
        self.native(0x537d0668, lambda c: HOLD)
        self.native(OPEN, self._open); self.native(WRITE, self._write); self.native(CLOSE, self._close)
        self.native(STOP, lambda c: (c.events.append(('stop', c.r(0))), 0)[1])
        self.w32(HOLD + 0xc, HOLD + 0x100); self.w32(HOLD + 0x14, HOLD + 0x200); self.w32(HOLD + 0x200, VT)
        self.w32(VT + 0x20, OPEN); self.w32(VT + 0x2c, WRITE); self.w32(VT + 0x24, CLOSE)
        self.w32(O + 0x15c8, W); self.w32(O + 0x60, ZAF); self.w32(ZAF + 4, INFO); self.w32(O + 0x4c, LENS); self.w32(LENS + 0xc, LCO); self.w32(LENS + 0x14, 2)
        self.w32(W + 0xf8c, LENS)
        self.w32(O + 0x48, PARENT); self.w32(O + 0x50, LENS_OBJECT); self.w8(O + 0x6548, 1); self.w8(O + 0x85ca, 1)   # recording; the standby monitor is watching
        mu.mem_write(O + 0x651c, struct.pack('<f', 59.96))
        for i, v in enumerate((2500, 60, 120, 60, 120)): self.w16(O + 0x6576 + 2 * i, v)
        self.w16(W + 0x3c, 110); mu.mem_write(W + 0x30, struct.pack('<f', 2.83))
        for o in (0xec, 0xf0, 0xf4): self.w32(W + o, BUF)

    # memory and registers
    def r(self, n): return self.mu.reg_read(UC_ARM_REG_R0 + n) if n < 13 else self.mu.reg_read({13: UC_ARM_REG_SP, 14: UC_ARM_REG_LR, 15: UC_ARM_REG_PC}[n])
    def w8(self, a, v): self.mu.mem_write(a, bytes([v & 255]))
    def w16(self, a, v): self.mu.mem_write(a, struct.pack('<H', v & 0xffff))
    def w32(self, a, v): self.mu.mem_write(a, struct.pack('<I', v & 0xffffffff))
    def r8(self, a): return self.mu.mem_read(a, 1)[0]
    def r16(self, a): return struct.unpack('<H', self.mu.mem_read(a, 2))[0]
    def r32(self, a): return struct.unpack('<I', self.mu.mem_read(a, 4))[0]
    def s32(self, a): return struct.unpack('<i', self.mu.mem_read(a, 4))[0]
    def word(self, a): return struct.unpack_from('<I', self.image, a - BASE)[0]
    def target(self, a): return a + 8 + ((self.word(a) & 0xffffff ^ 0x800000) - 0x800000) * 4

    # replaced functions: f(cam) returns the value for r0, or None to let the real code run
    def native(self, address, f):
        if address in self.hooks: self.mu.hook_del(self.hooks[address][0])
        def code(uc, a, size, data):
            ret = self.hooks[address][1](self)
            if ret is not None:
                uc.reg_write(UC_ARM_REG_R0, ret & 0xffffffff); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        self.hooks[address] = (self.mu.hook_add(UC_HOOK_CODE, code, begin=address, end=address), f)
    def real(self, address):
        if address in self.hooks: self.mu.hook_del(self.hooks.pop(address)[0])
    def _tick(self, c): c.tick += 17; return c.tick
    def _open(self, c): c.opened = bytes(c.mu.mem_read(c.r(1), 16)).split(b'\0')[0].decode(); c.w32(c.r(3), 7); return 1
    def _write(self, c): c.written = bytes(c.mu.mem_read(c.r(2), c.r(3))); return 1
    def _close(self, c): c.closed += 1; return 1

    def call(self, address, *args, stack=()):
        self.bad.clear()
        for i, v in enumerate(args): self.mu.reg_write(UC_ARM_REG_R0 + i, v & 0xffffffff)
        sp = STACK - 0x1000 - 4 * len(stack)
        for i, v in enumerate(stack): self.w32(sp + 4 * i, v)
        self.mu.reg_write(UC_ARM_REG_SP, sp); self.mu.reg_write(UC_ARM_REG_LR, SENTINEL)
        self.mu.emu_start(address, SENTINEL, count=2000000)
        assert self.mu.reg_read(UC_ARM_REG_PC) == SENTINEL and not self.bad, (hex(self.mu.reg_read(UC_ARM_REG_PC)), self.bad)
        return self.mu.reg_read(UC_ARM_REG_R0)

    def phase(self, values, reliabilities, direction=1, valid=1, running=1):
        self.w8(B + 0x1560, running); self.w16(B + 4, len(values)); self.w8(B + 0x10, valid); self.w8(B + 0x11, direction)
        for i, (v, q) in enumerate(zip(values, reliabilities)): self.w16(B + 0x18 + 2 * i, v); self.w8(B + 0x209 + 9 * i, q)

    def zaf_extras(self, position, mids, dirs=0, good=31, margin=20):
        """what else the phase result block holds (0x53638c90, 0x53638B5C): the lens position of the block's lens sample, a direction per area,
        the factory's quality flags, and per area the two ends (signed lens units) of where its own conversion puts the focus"""
        self.w32(B + 0x14, position)
        for i, m in enumerate(mids):
            self.w32(B + 0x1038 + 4 * i, m + margin); self.w32(B + 0x12cc + 4 * i, m - margin)
            self.w8(B + 0x162 + i, dirs >> i & 1); self.w8(B + 0x208 + 9 * i, good >> i & 1)
            for o in (5, 6, 7): self.w8(B + 0x208 + 9 * i + o, 0)

    def wobbler(self, base=3, cap=48, direction=1, count=0, areas=5, state=5, climb=1):
        """the wobbling module's fields the travel state and the lens move read"""
        self.w8(W + 5, areas); self.w16(W + 0x10, base); self.w16(W + 0x1a, base); self.w16(W + 0x1e, cap); self.w16(W + 0xe, 120)
        self.w8(W + 0x21, direction); self.w8(W + 0x23, direction); self.w8(W + 0x22, 1); self.w16(W + 0x16, 0); self.w8(W + 0x20, 0)
        self.w32(W + 0xc78, count); self.w8(W + 0xc88, 3); self.w8(W + 0xd42, 0); self.w16(W + 0xcb0, climb); self.w8(W + 0xe5, state); self.w8(W + 9, 1)   # climb: steps of this climb so far; at 0 the camera sets its count anew (0x53630468)
        self.w8(W + 0xd40, 1)   # the count goes up every second step, as in the camera's recordings
        self.w32(W + 0x134, 1000); self.w32(W + 0x130, 1000)

    def standby_lens(self, holder=0, sent=None, taken=True):
        """The lens as it is in standby on the camera: nobody holds it (lens + 0x14 = 0; the movie AF holds it, as user 2,
        from the beginning of a search, 0x53626C9C, to its end, 0x5361476C), and the lens interface 0x5360E2E8 runs as it is,
        so a move from someone who does not hold the lens is not taken.  What reaches the lens control (0x539526D4) is
        appended to `sent` as (amount, speed, direction); the lens state the give-back asks for (0x539533F8) is "at rest"."""
        self.w32(LENS + 0x14, holder); self.real(LENS_MOVE)
        self.commands = sent if sent is not None else []
        self.native(LENS_COMMAND, lambda c: (c.commands.append((c.r32(c.r(13)), c.r32(c.r(13) + 4), c.r(3))), 0 if taken else 1)[1])
        self.native(LENS_QUERY, lambda c: 0)
        return self.commands

    def trampoline(self):
        """in place of the wobbling step: the real travel state, then the real lens move with its step and speed (as 0x53630fc4 ..)"""
        bl = lambda at, to: 0xeb000000 | (((to - (at + 8)) >> 2) & 0xffffff)
        words = [0xe92d4010,                                                  # push {r4, lr}
                 0xe3004000 | ((W & 0xf000) << 4) | (W & 0xfff),              # movw r4, #lo
                 0xe3404000 | (((W >> 16) & 0xf000) << 4) | ((W >> 16) & 0xfff),  # movt r4, #hi
                 0xe1a00004, 0xe3a01001, 0,                                   # mov r0, r4; mov r1, #1; bl travel
                 0xe1a00004, 0xe1d411ba, 0xe1d420be, 0xe3a03001, 0,           # mov r0, r4; ldrh r1, [r4, #0x1a]; ldrh r2, [r4, #0xe]; mov r3, #1; bl move
                 0xe3a00000, 0xe8bd8010]                                      # mov r0, #0; pop {r4, pc}
        words[5] = bl(self.tramp + 20, TRAVEL); words[10] = bl(self.tramp + 40, MOVE)
        self.mu.mem_write(self.tramp, struct.pack(f'<{len(words)}I', *words))
        return self.tramp
