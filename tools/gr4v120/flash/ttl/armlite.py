# SPDX-License-Identifier: GPL-2.0-only
"""A small ARM (A32, integer only) interpreter on capstone, for running the compiled probe and its stubs where a JIT emulator
is not available. Unknown instructions raise; nothing is guessed. Not a general emulator."""
import struct
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
from capstone.arm import *

M = 0xffffffff


class Unsupported(Exception):
    pass


class Arm:
    def __init__(self):
        self.r = [0] * 16
        self.n = self.z = self.c = self.v = 0
        self.regions = []            # (base, bytearray)
        self.hooks = {}              # address -> function(cpu); the hook returns to lr itself (cpu.ret(value))
        self.md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
        self.md.detail = True
        self.steps = 0
        self.sp_min = M
        self.writes = []             # (address, size) of every store, for checks
        self.s = {}                  # single precision registers as bits, for vmov to and from core registers

    # memory
    def map(self, base, data):
        buf = bytearray(data)
        self.regions.append((base, buf))
        return buf

    def find(self, a, n):
        for base, buf in self.regions:
            if base <= a and a + n <= base + len(buf): return buf, a - base
        raise Unsupported(f'unmapped access {a:#x}+{n} at pc {self.r[15]:#x}')

    def rd(self, a, n=4):
        buf, o = self.find(a, n)
        return int.from_bytes(buf[o:o + n], 'little')

    def wr(self, a, v, n=4):
        buf, o = self.find(a, n)
        buf[o:o + n] = (v & ((1 << (8 * n)) - 1)).to_bytes(n, 'little')
        self.writes.append((a, n))

    # helpers
    def ret(self, value=None):
        if value is not None: self.r[0] = value & M
        self.r[15] = self.r[14]

    def cond(self, cc):
        n, z, c, v = self.n, self.z, self.c, self.v
        t = {ARM_CC_EQ: z, ARM_CC_NE: not z, ARM_CC_HS: c, ARM_CC_LO: not c, ARM_CC_MI: n, ARM_CC_PL: not n, ARM_CC_VS: v, ARM_CC_VC: not v,
             ARM_CC_HI: c and not z, ARM_CC_LS: (not c) or z, ARM_CC_GE: n == v, ARM_CC_LT: n != v, ARM_CC_GT: (not z) and n == v,
             ARM_CC_LE: z or n != v, ARM_CC_AL: True}
        if cc not in t: raise Unsupported(f'condition {cc}')
        return bool(t[cc])

    def reg(self, capreg):
        m = {ARM_REG_SP: 13, ARM_REG_LR: 14, ARM_REG_PC: 15, ARM_REG_SB: 9, ARM_REG_SL: 10, ARM_REG_FP: 11, ARM_REG_IP: 12}
        if capreg in m: return m[capreg]
        if ARM_REG_R0 <= capreg <= ARM_REG_R12: return capreg - ARM_REG_R0
        raise Unsupported(f'register {capreg}')

    def get(self, k, pc):
        return (pc + 8) & M if k == 15 else self.r[k]

    def shifted(self, v, op, pc):
        t, n = op.shift.type, op.shift.value
        if t == 0: return v, None
        kinds = {ARM_SFT_LSL: 'lsl', ARM_SFT_LSR: 'lsr', ARM_SFT_ASR: 'asr'}
        by_reg = {ARM_SFT_LSL_REG: 'lsl', ARM_SFT_LSR_REG: 'lsr', ARM_SFT_ASR_REG: 'asr'}
        if t in kinds: return self.shift_by(v, kinds[t], n)
        if t in by_reg: return self.shift_by(v, by_reg[t], self.get(self.reg(n), pc) & 0xff)
        raise Unsupported(f'shift {t}')

    @staticmethod
    def shift_by(v, kind, n):
        """(result, carry out or None when the amount is 0), amounts 0..255 as the processor defines them."""
        if n == 0: return v, None
        if kind == 'lsl': return ((v << n) & M, (v >> (32 - n)) & 1) if n <= 32 else (0, 0)
        if kind == 'lsr': return (v >> n, (v >> (n - 1)) & 1) if n <= 32 else (0, 0)
        sv = v - (1 << 32) if v >> 31 else v
        return ((sv >> n) & M, (sv >> (n - 1)) & 1) if n < 32 else ((M if v >> 31 else 0), v >> 31)

    def operand(self, op, pc):
        if op.type == ARM_OP_IMM: return op.imm & M, None
        if op.type == ARM_OP_REG: return self.shifted(self.get(self.reg(op.reg), pc), op, pc)
        raise Unsupported('operand')

    def address(self, i, op, pc):
        """(address to use, writeback value or None, base register)"""
        base = self.reg(op.mem.base)
        b = self.get(base, pc)
        off = op.mem.disp
        if op.mem.index:
            x, _ = self.shifted(self.get(self.reg(op.mem.index), pc), op, pc)
            off = -x if op.subtracted else x
        return b, off, base

    def load_store(self, i, pc, size, load, signed=False):
        o = i.operands
        post = len(o) == 3 or (i.writeback and '],' in i.op_str)
        b, off, base = self.address(i, o[1], pc)
        if post and len(o) == 3:
            x, _ = self.operand(o[2], pc)
            off = -x if o[2].subtracted else x
        a = b if post else (b + off) & M
        t = self.reg(o[0].reg)
        if load:
            v = self.rd(a, size)
            if i.writeback: self.r[base] = (b + off) & M
            if t == 15: self.r[15] = v & ~1; return True
            self.r[t] = v
        else:
            self.wr(a, self.get(t, pc), size)
            if i.writeback: self.r[base] = (b + off) & M
        return False

    def flags_nz(self, v):
        self.n, self.z = v >> 31, int(v == 0)

    def add(self, a, b, carry, setf):
        full = a + b + carry
        r = full & M
        if setf:
            self.flags_nz(r); self.c = int(full > M); self.v = int(((a ^ r) & (b ^ r)) >> 31)
        return r

    def step(self):
        pc = self.r[15]
        if pc in self.hooks:
            self.hooks[pc](self)
            return
        buf, o = self.find(pc, 4)
        try:
            i = next(self.md.disasm(bytes(buf[o:o + 4]), pc))
        except StopIteration:
            raise Unsupported(f'undecodable word at {pc:#x}')
        self.steps += 1
        nxt = (pc + 4) & M
        if not self.cond(i.cc):
            self.r[15] = nxt
            return
        o = i.operands
        d = i.id
        setf = i.update_flags
        branched = False
        if d in (ARM_INS_MOV, ARM_INS_MOVW, ARM_INS_MVN, ARM_INS_LSL, ARM_INS_LSR, ARM_INS_ASR):
            if d in (ARM_INS_LSL, ARM_INS_LSR, ARM_INS_ASR) and len(o) == 3:
                v = self.get(self.reg(o[1].reg), pc)
                n = o[2].imm if o[2].type == ARM_OP_IMM else self.get(self.reg(o[2].reg), pc) & 0xff
                v, carry = self.shift_by(v, {ARM_INS_LSL: 'lsl', ARM_INS_LSR: 'lsr', ARM_INS_ASR: 'asr'}[d], n)
            else:
                v, carry = self.operand(o[1], pc)
                if d == ARM_INS_MVN: v = ~v & M
            if setf:
                self.flags_nz(v)
                if carry is not None: self.c = carry
            t = self.reg(o[0].reg)
            if t == 15: self.r[15] = v & ~1; branched = True
            else: self.r[t] = v
        elif d == ARM_INS_MOVT:
            t = self.reg(o[0].reg); self.r[t] = (self.r[t] & 0xffff) | ((o[1].imm & 0xffff) << 16)
        elif d in (ARM_INS_ADD, ARM_INS_SUB, ARM_INS_RSB, ARM_INS_CMP, ARM_INS_CMN, ARM_INS_ADC, ARM_INS_SBC):
            if d in (ARM_INS_CMP, ARM_INS_CMN):
                a = self.get(self.reg(o[0].reg), pc); b, _ = self.operand(o[1], pc); t = None; setf = True
            else:
                a = self.get(self.reg(o[1].reg), pc); b, _ = self.operand(o[2], pc); t = self.reg(o[0].reg)
            if d in (ARM_INS_ADD, ARM_INS_CMN): r = self.add(a, b, 0, setf)
            elif d == ARM_INS_ADC: r = self.add(a, b, self.c, setf)
            elif d in (ARM_INS_SUB, ARM_INS_CMP): r = self.add(a, ~b & M, 1, setf)
            elif d == ARM_INS_SBC: r = self.add(a, ~b & M, self.c, setf)
            else: r = self.add(b, ~a & M, 1, setf)
            if t is not None:
                if t == 15: raise Unsupported('arithmetic to pc')
                self.r[t] = r
                if t == 13: self.sp_min = min(self.sp_min, r)
        elif d in (ARM_INS_AND, ARM_INS_ORR, ARM_INS_EOR, ARM_INS_BIC, ARM_INS_TST, ARM_INS_TEQ):
            if d in (ARM_INS_TST, ARM_INS_TEQ):
                a = self.get(self.reg(o[0].reg), pc); b, carry = self.operand(o[1], pc); t = None; setf = True
            else:
                a = self.get(self.reg(o[1].reg), pc); b, carry = self.operand(o[2], pc); t = self.reg(o[0].reg)
            r = {ARM_INS_AND: a & b, ARM_INS_TST: a & b, ARM_INS_ORR: a | b, ARM_INS_EOR: a ^ b, ARM_INS_TEQ: a ^ b, ARM_INS_BIC: a & ~b & M}[d]
            if setf:
                self.flags_nz(r)
                if carry is not None: self.c = carry
            if t is not None: self.r[t] = r
        elif d == ARM_INS_MUL:
            r = (self.get(self.reg(o[1].reg), pc) * self.get(self.reg(o[2].reg), pc)) & M
            if setf: self.flags_nz(r)
            self.r[self.reg(o[0].reg)] = r
        elif d == ARM_INS_MLA:
            self.r[self.reg(o[0].reg)] = (self.get(self.reg(o[1].reg), pc) * self.get(self.reg(o[2].reg), pc) + self.get(self.reg(o[3].reg), pc)) & M
        elif d in (ARM_INS_UMULL, ARM_INS_UMLAL):
            full = self.get(self.reg(o[2].reg), pc) * self.get(self.reg(o[3].reg), pc)
            lo, hi = self.reg(o[0].reg), self.reg(o[1].reg)
            if d == ARM_INS_UMLAL: full = (full + (self.r[hi] << 32 | self.r[lo])) & 0xffffffffffffffff
            if setf: raise Unsupported('umull with flags')
            self.r[lo], self.r[hi] = full & M, full >> 32
        elif d == ARM_INS_VMOV:                                    # core register <-> single precision register, as bits (stubs only)
            core = [x for x in o if x.type == ARM_OP_REG and not ARM_REG_S0 <= x.reg <= ARM_REG_S31]
            single = [x for x in o if x.type == ARM_OP_REG and ARM_REG_S0 <= x.reg <= ARM_REG_S31]
            if len(o) != 2 or len(core) != 1 or len(single) != 1: raise Unsupported(f'{pc:#x}: {i.mnemonic} {i.op_str}')
            if o[0] is core[0] or o[0].reg == core[0].reg: self.r[self.reg(core[0].reg)] = self.s.get(single[0].reg - ARM_REG_S0, 0)
            else: self.s[single[0].reg - ARM_REG_S0] = self.get(self.reg(core[0].reg), pc)
        elif d == ARM_INS_CLZ:
            v = self.get(self.reg(o[1].reg), pc); self.r[self.reg(o[0].reg)] = 32 - v.bit_length()
        elif d == ARM_INS_UBFX:
            v = self.get(self.reg(o[1].reg), pc); self.r[self.reg(o[0].reg)] = (v >> o[2].imm) & ((1 << o[3].imm) - 1)
        elif d == ARM_INS_BFI:
            t = self.reg(o[0].reg); lsb, width = o[2].imm, o[3].imm; mask = ((1 << width) - 1) << lsb
            self.r[t] = (self.r[t] & ~mask & M) | ((self.get(self.reg(o[1].reg), pc) << lsb) & mask)
        elif d == ARM_INS_BFC:
            t = self.reg(o[0].reg); lsb, width = o[1].imm, o[2].imm
            self.r[t] &= ~(((1 << width) - 1) << lsb) & M
        elif d == ARM_INS_RSC: raise Unsupported('rsc')
        elif d == ARM_INS_UXTB: self.r[self.reg(o[0].reg)] = self.get(self.reg(o[1].reg), pc) & 0xff
        elif d == ARM_INS_UXTH: self.r[self.reg(o[0].reg)] = self.get(self.reg(o[1].reg), pc) & 0xffff
        elif d == ARM_INS_LDR: branched = self.load_store(i, pc, 4, True)
        elif d == ARM_INS_LDRB: self.load_store(i, pc, 1, True)
        elif d == ARM_INS_LDRH: self.load_store(i, pc, 2, True)
        elif d == ARM_INS_STR: self.load_store(i, pc, 4, False)
        elif d == ARM_INS_STRB: self.load_store(i, pc, 1, False)
        elif d == ARM_INS_STRH: self.load_store(i, pc, 2, False)
        elif d in (ARM_INS_LDRD, ARM_INS_STRD):
            if i.writeback or o[2].mem.index: raise Unsupported('ldrd/strd form')
            a = (self.get(self.reg(o[2].mem.base), pc) + o[2].mem.disp) & M
            for k in (0, 1):
                t = self.reg(o[k].reg)
                if d == ARM_INS_LDRD: self.r[t] = self.rd(a + 4 * k)
                else: self.wr(a + 4 * k, self.r[t])
        elif d == ARM_INS_PUSH:
            regs = sorted(self.reg(x.reg) for x in o)
            sp = (self.r[13] - 4 * len(regs)) & M
            for k, t in enumerate(regs): self.wr(sp + 4 * k, self.get(t, pc))
            self.r[13] = sp; self.sp_min = min(self.sp_min, sp)
        elif d == ARM_INS_POP:
            regs = sorted(self.reg(x.reg) for x in o)
            sp = self.r[13]
            for k, t in enumerate(regs):
                v = self.rd(sp + 4 * k)
                if t == 15: self.r[15] = v & ~1; branched = True
                else: self.r[t] = v
            self.r[13] = (sp + 4 * len(regs)) & M
        elif d in (ARM_INS_LDM, ARM_INS_LDMIB, ARM_INS_LDMDA, ARM_INS_LDMDB, ARM_INS_STM, ARM_INS_STMIB, ARM_INS_STMDA, ARM_INS_STMDB):
            base = self.reg(o[0].reg)
            regs = sorted(self.reg(x.reg) for x in o[1:])
            n = len(regs)
            b = self.get(base, pc)
            first = {ARM_INS_LDM: b, ARM_INS_STM: b, ARM_INS_LDMIB: b + 4, ARM_INS_STMIB: b + 4, ARM_INS_LDMDA: b - 4 * n + 4,
                     ARM_INS_STMDA: b - 4 * n + 4, ARM_INS_LDMDB: b - 4 * n, ARM_INS_STMDB: b - 4 * n}[d] & M
            up = d in (ARM_INS_LDM, ARM_INS_STM, ARM_INS_LDMIB, ARM_INS_STMIB)
            load = d in (ARM_INS_LDM, ARM_INS_LDMIB, ARM_INS_LDMDA, ARM_INS_LDMDB)
            if base in regs and i.writeback: raise Unsupported('ldm/stm with the base in the list and writeback')
            for k, t in enumerate(regs):
                if load:
                    v = self.rd(first + 4 * k)
                    if t == 15: self.r[15] = v & ~1; branched = True
                    else: self.r[t] = v
                else: self.wr(first + 4 * k, self.get(t, pc))
            if i.writeback:
                self.r[base] = (b + 4 * n if up else b - 4 * n) & M
                if base == 13: self.sp_min = min(self.sp_min, self.r[13])
        elif d == ARM_INS_B: self.r[15] = o[0].imm & M; branched = True
        elif d == ARM_INS_BL: self.r[14] = nxt; self.r[15] = o[0].imm & M; branched = True
        elif d == ARM_INS_BX: self.r[15] = self.get(self.reg(o[0].reg), pc) & ~1; branched = True
        elif d == ARM_INS_BLX:
            if o[0].type != ARM_OP_REG: raise Unsupported('blx imm')
            t = self.get(self.reg(o[0].reg), pc)
            if t & 1: raise Unsupported('blx to thumb')
            self.r[14] = nxt; self.r[15] = t; branched = True
        else:
            raise Unsupported(f'{pc:#x}: {i.mnemonic} {i.op_str}')
        if not branched: self.r[15] = nxt

    def call(self, address, args=(), sp=None, stop=0xfffffff0, limit=5_000_000):
        for k, a in enumerate(args): self.r[k] = a & M
        if sp is not None: self.r[13] = sp
        self.r[14] = stop
        self.r[15] = address
        n = 0
        while self.r[15] != stop:
            self.step(); n += 1
            if n > limit: raise Unsupported('step limit')
        return self.r[0]
