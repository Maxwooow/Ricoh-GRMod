# SPDX-License-Identifier: GPL-2.0-only
"""A small Renesas RX (RXv1) disassembler for the sub-CPU program of GR III / IIIx and GR IV (an RX113: the
firmware file's CPU section, 0x20000 bytes, mapped at 0xFFFE0000; extract it with core/src/fw/container.ts,
`sectionsOf(new Firmware(file).decoded)`, section "CPU"). Development tool, not part of the program.
Written from the RX instruction formats for the integer instructions the compiler emits (enough to read
the power code, see core/src/fw/gr3x/battery.ts); no floating point, no DSP accuracy guaranteed. Unknown
encodings print as `.byte`.

    python3 tools/gr3extras/rxdis.py CPU.bin ADDR [N]
"""
import struct, sys

BASE = 0xFFFE0000
SZ = ['b', 'w', 'l', 'uw']
SCALE = {'b': 1, 'w': 2, 'l': 4, 'uw': 2, 'ub': 1}
COND = ['eq', 'ne', 'geu', 'ltu', 'gtu', 'leu', 'pz', 'n', 'ge', 'lt', 'gt', 'le', 'o', 'no', 'ra', '??']
CR = {0: 'psw', 1: 'pc', 2: 'usp', 3: 'fpsw', 8: 'bpsw', 9: 'bpc', 10: 'isp', 11: 'fintv', 12: 'intb'}


def s8(x): return x - 256 if x & 0x80 else x
def s16(x): return x - 65536 if x & 0x8000 else x
def s24(x): return x - (1 << 24) if x & 0x800000 else x


class Dis:
    def __init__(self, data):
        self.d = data

    def b(self, a): return self.d[a - BASE]

    def u(self, a, n):
        v = 0
        for i in range(n): v |= self.b(a + i) << (8 * i)
        return v

    def imm(self, a, li):
        """li: 01 simm8, 10 simm16, 11 simm24, 00 imm32. Returns (value, length)."""
        if li == 1: return s8(self.b(a)), 1
        if li == 2: return s16(self.u(a, 2)), 2
        if li == 3: return s24(self.u(a, 3)), 3
        return self.u(a, 4), 4

    def mem(self, a, ld, rs, size):
        """Operand for ld 00 [rs], 01 dsp8[rs], 10 dsp16[rs], 11 rs. Returns (text, length)."""
        if ld == 3: return 'r%d' % rs, 0
        if ld == 0: return '[r%d]' % rs, 0
        if ld == 1: return '%d[r%d].%s' % (self.b(a) * SCALE[size], rs, size), 1
        return '%d[r%d].%s' % (self.u(a, 2) * SCALE[size], rs, size), 2

    def one(self, a):
        """(length, text, target or None)"""
        b0 = self.b(a); b1 = self.b(a + 1)
        hx = lambda v: ('#%d' % v) if -10 < v < 10 else ('#0x%x' % (v & 0xffffffff))
        if b0 == 0x00: return 1, 'brk', None
        if b0 == 0x01: return 1, 'dbt', None
        if b0 == 0x02: return 1, 'rts', None
        if b0 == 0x03: return 1, 'nop', None
        if b0 in (0x04, 0x05):
            t = (a + s24(self.u(a + 1, 3))) & 0xffffffff
            return 4, ('bra.a' if b0 == 4 else 'bsr.a') + ' 0x%x' % t, t
        if b0 == 0x06:
            mx = SZ[b1 >> 6]; op = (b1 >> 2) & 0xf; ld = b1 & 3
            if op == 8:
                op2 = self.b(a + 2); b3 = self.b(a + 3)
                names = {0: 'sbb', 2: 'adc', 4: 'max', 5: 'min', 6: 'emul', 7: 'emulu', 8: 'div', 9: 'divu', 0xc: 'tst', 0xd: 'xor', 0x10: 'xchg', 0x11: 'itof'}
                src, n = self.mem(a + 4, ld, b3 >> 4, mx)
                return 4 + n, '%s %s.%s, r%d' % (names.get(op2, '?%x' % op2), src, mx, b3 & 15), None
            names = ['sub', 'cmp', 'add', 'mul', 'and', 'or']
            b2 = self.b(a + 2)
            src, n = self.mem(a + 3, ld, b2 >> 4, mx)
            return 3 + n, '%s %s.%s, r%d' % (names[op] if op < 6 else '?', src, mx, b2 & 15), None
        if 0x08 <= b0 <= 0x0f or 0x10 <= b0 <= 0x1f:
            d = b0 & 7; d = d + 8 if d < 3 else d
            t = a + d
            nm = 'bra.s' if b0 < 0x10 else ('beq.s' if b0 < 0x18 else 'bne.s')
            return 1, '%s 0x%x' % (nm, t), t
        if 0x20 <= b0 <= 0x2f:
            t = (a + s8(b1)) & 0xffffffff
            return 2, 'b%s.b 0x%x' % (COND[b0 & 15], t), t
        if 0x38 <= b0 <= 0x3b:
            t = (a + s16(self.u(a + 1, 2))) & 0xffffffff
            return 3, ['bra.w', 'bsr.w', 'beq.w', 'bne.w'][b0 - 0x38] + ' 0x%x' % t, t
        if 0x3c <= b0 <= 0x3e:
            sz = SZ[b0 - 0x3c]; rd = (b1 >> 4) & 7; dsp = ((b1 >> 7) << 4 | (b1 & 15)) * SCALE[sz]
            return 3, 'mov.%s #%d, %d[r%d]' % (sz, self.b(a + 2), dsp, rd), None
        if b0 == 0x3f:
            return 3, 'rtsd #%d, r%d-r%d' % (self.b(a + 2) * 4, b1 >> 4, b1 & 15), None
        if 0x40 <= b0 <= 0x57:
            names = ['sub', 'cmp', 'add', 'mul', 'and', 'or']
            ld = b0 & 3
            src, n = self.mem(a + 2, ld, b1 >> 4, 'ub')
            return 2 + n, '%s %s%s, r%d' % (names[(b0 - 0x40) >> 2], src, '' if ld == 3 else '.ub', b1 & 15), None
        if 0x58 <= b0 <= 0x5f:
            sz = 'b' if b0 < 0x5c else 'w'; ld = b0 & 3
            src, n = self.mem(a + 2, ld, b1 >> 4, sz)
            return 2 + n, 'movu.%s %s, r%d' % (sz, src, b1 & 15), None
        if 0x60 <= b0 <= 0x66:
            nm = ['sub', 'cmp', 'add', 'mul', 'and', 'or', 'mov.l'][b0 - 0x60]
            return 2, '%s #%d, r%d' % (nm, b1 >> 4, b1 & 15), None
        if b0 == 0x67: return 2, 'rtsd #%d' % (b1 * 4), None
        if 0x68 <= b0 <= 0x6d:
            nm = ['shlr', 'shar', 'shll'][(b0 - 0x68) >> 1]
            return 2, '%s #%d, r%d' % (nm, ((b0 & 1) << 4) | (b1 >> 4), b1 & 15), None
        if b0 == 0x6e: return 2, 'pushm r%d-r%d' % (b1 >> 4, b1 & 15), None
        if b0 == 0x6f: return 2, 'popm r%d-r%d' % (b1 >> 4, b1 & 15), None
        if 0x70 <= b0 <= 0x73:
            v, n = self.imm(a + 2, b0 & 3)
            return 2 + n, 'add %s, r%d, r%d' % (hx(v), b1 >> 4, b1 & 15), None
        if 0x74 <= b0 <= 0x77:
            li = b0 & 3; op = b1 >> 4; r = b1 & 15
            if li == 1 and op == 4: return 3, 'mov.l #%d, r%d' % (self.b(a + 2), r), None
            if li == 1 and op == 5: return 3, 'cmp #%d, r%d' % (self.b(a + 2), r), None
            if li == 1 and b1 == 0x60: return 3, 'int #%d' % self.b(a + 2), None
            if li == 1 and b1 == 0x70: return 3, 'mvtipl #%d' % self.b(a + 2), None
            v, n = self.imm(a + 2, li)
            nm = {0: 'cmp', 1: 'mul', 2: 'and', 3: 'or'}.get(op, '?')
            return 2 + n, '%s %s, r%d' % (nm, hx(v), r), None
        if 0x78 <= b0 <= 0x7d:
            nm = ['bset', 'bclr', 'btst'][(b0 - 0x78) >> 1]
            return 2, '%s #%d, r%d' % (nm, ((b0 & 1) << 4) | (b1 >> 4), b1 & 15), None
        if b0 == 0x7e:
            op = b1 >> 4; r = b1 & 15
            nm = {0: 'not', 1: 'neg', 2: 'abs', 3: 'sat', 4: 'rorc', 5: 'rolc', 8: 'push.b', 9: 'push.w', 0xa: 'push.l', 0xb: 'pop', 0xc: 'pushc', 0xe: 'popc'}.get(op, '?')
            return 2, '%s %s' % (nm, ('cr%d' % r) if op in (0xc, 0xe) else 'r%d' % r), None
        if b0 == 0x7f:
            op = b1 >> 4; r = b1 & 15
            nm = {0: 'jmp', 1: 'jsr', 4: 'bra.l', 5: 'bsr.l'}.get(op)
            if nm: return 2, '%s r%d' % (nm, r), None
            return 2, {0x83: 'scmpu', 0x87: 'smovu', 0x8b: 'smovb', 0x8f: 'smovf', 0x93: 'suntil.b', 0x94: 'rtfi', 0x95: 'rte', 0x96: 'wait', 0x88: 'sstr.b', 0x8a: 'sstr.l', 0x80: 'suntil.b', 0x82: 'suntil.l', 0x84: 'swhile.b', 0x86: 'swhile.l'}.get(b1, '.7f %02x' % b1), None
        if 0x80 <= b0 <= 0xbf:
            if b0 >= 0xb0:
                sz = 'w' if b0 & 8 else 'b'
                dsp = (((b0 & 7) << 2) | ((b1 >> 7) << 1) | ((b1 >> 3) & 1)) * SCALE[sz]
                return 2, 'movu.%s %d[r%d], r%d' % (sz, dsp, (b1 >> 4) & 7, b1 & 7), None
            sz = SZ[(b0 >> 4) & 3]
            dsp = (((b0 & 7) << 2) | ((b1 >> 7) << 1) | ((b1 >> 3) & 1)) * SCALE[sz]
            if b0 & 8: return 2, 'mov.%s %d[r%d], r%d' % (sz, dsp, (b1 >> 4) & 7, b1 & 7), None
            return 2, 'mov.%s r%d, %d[r%d]' % (sz, b1 & 7, dsp, (b1 >> 4) & 7), None
        if 0xc0 <= b0 <= 0xef:
            sz = SZ[(b0 >> 4) & 3]; ldd = (b0 >> 2) & 3; lds = b0 & 3
            rs = b1 >> 4; rd = b1 & 15
            if ldd != 3 and lds == 3: rs, rd = rd, rs  # store: 11sz ld11 rdst rsrc
            src, n1 = self.mem(a + 2, lds, rs, sz)
            dst, n2 = self.mem(a + 2 + n1, ldd, rd, sz)
            return 2 + n1 + n2, 'mov.%s %s, %s' % (sz, src, dst), None
        if 0xf0 <= b0 <= 0xf3:
            ld = b0 & 3; rd = b1 >> 4
            dst, n = self.mem(a + 2, ld, rd, 'b')
            return 2 + n, '%s #%d, %s' % ('bclr' if b1 & 8 else 'bset', b1 & 7, dst), None
        if 0xf4 <= b0 <= 0xf7:
            ld = b0 & 3; rd = b1 >> 4
            if (b1 & 0xc) == 8:
                sz = SZ[b1 & 3]; src, n = self.mem(a + 2, ld, rd, sz)
                return 2 + n, 'push.%s %s' % (sz, src), None
            dst, n = self.mem(a + 2, ld, rd, 'b')
            return 2 + n, '%s #%d, %s' % ('btst' if not b1 & 8 else 'push?', b1 & 7, dst), None
        if 0xf8 <= b0 <= 0xfb:
            ld = b0 & 3; rd = b1 >> 4; li = (b1 >> 2) & 3; sz = SZ[b1 & 3]
            dst, n = self.mem(a + 2, ld, rd, sz)
            v, m = self.imm(a + 2 + n, li)
            return 2 + n + m, 'mov.%s %s, %s' % (sz, hx(v), dst), None
        if b0 == 0xfc:
            b2 = self.b(a + 2); rs = b2 >> 4; rd = b2 & 15
            reg = {0x07: 'neg', 0x0b: 'adc', 0x0f: 'abs', 0x3b: 'not', 0x4b: 'stz?'}
            if b1 in reg: return 3, '%s r%d, r%d' % (reg[b1], rs, rd), None
            groups = {0x00: 'sbb', 0x10: 'max', 0x14: 'min', 0x18: 'emul', 0x1c: 'emulu', 0x20: 'div', 0x24: 'divu', 0x30: 'tst', 0x34: 'xor', 0x40: 'xchg', 0x44: 'itof',
                      0x60: 'bset', 0x64: 'bclr', 0x68: 'btst', 0x6c: 'bnot', 0x80: 'fsub', 0x84: 'fcmp', 0x88: 'fadd', 0x8c: 'fmul', 0x90: 'fdiv', 0x94: 'ftoi', 0x98: 'round'}
            g = b1 & 0xfc; ld = b1 & 3
            if g in groups:
                nm = groups[g]
                if nm in ('bset', 'bclr', 'btst', 'bnot'):
                    dst, n = self.mem(a + 3, ld, rd, 'b')
                    return 3 + n, '%s r%d, %s' % (nm, rs, dst), None
                src, n = self.mem(a + 3, ld, rs, 'l' if ld != 3 else 'l')
                return 3 + n, '%s %s, r%d' % (nm, src, rd), None
            if 0xd0 <= b1 <= 0xdb:  # sccnd: 1111 1100 1101 sz ld rd cnd
                sz = SZ[(b1 >> 2) & 3]; ld = b1 & 3
                dst, n = self.mem(a + 3, ld, rs, sz)
                return 3 + n, 'sc%s.%s %s' % (COND[rd], sz, dst), None
            if 0xe0 <= b1 <= 0xff:  # bmcnd #imm3, dsp[rd]
                ld = b1 & 3; bit = (b1 >> 2) & 7
                dst, n = self.mem(a + 3, ld, rs, 'b')
                c = rd
                return 3 + n, ('bnot' if c == 15 else 'bm%s' % COND[c]) + ' #%d, %s' % (bit, dst), None
            return 3, '.fc %02x %02x' % (b1, b2), None
        if b0 == 0xfd:
            b2 = self.b(a + 2); hi = b2 >> 4; lo = b2 & 15
            if b1 <= 0x07: return 3, ['mulhi', 'mullo', '?', '?', 'machi', 'maclo', '?', '?'][b1] + ' r%d, r%d' % (hi, lo), None
            if b1 == 0x17: return 3, ('mvtachi' if hi == 0 else 'mvtaclo') + ' r%d' % lo, None
            if b1 == 0x18: return 3, 'racw #%d' % (1 + (hi & 1)), None
            if b1 == 0x1f: return 3, {0: 'mvfachi', 2: 'mvfaclo', 1: 'mvfacmi'}.get(hi, '?') + ' r%d' % lo, None
            if 0x20 <= b1 <= 0x2f:
                sz = SZ[b1 & 3]; pre = b1 & 4
                if b1 & 8: return 3, 'mov.%s %s, r%d' % (sz, ('[-r%d]' if pre else '[r%d+]') % hi, lo), None
                return 3, 'mov.%s r%d, %s' % (sz, lo, ('[-r%d]' if pre else '[r%d+]') % hi), None
            if 0x30 <= b1 <= 0x3f:
                sz = 'w' if b1 & 1 else 'b'; pre = b1 & 4
                return 3, 'movu.%s %s, r%d' % (sz, ('[-r%d]' if pre else '[r%d+]') % hi, lo), None
            reg = {0x60: 'shlr', 0x61: 'shar', 0x62: 'shll', 0x64: 'rotr', 0x65: 'revw', 0x66: 'rotl', 0x67: 'revl'}
            if b1 in reg: return 3, '%s r%d, r%d' % (reg[b1], hi, lo), None
            if b1 == 0x68: return 3, 'mvtc r%d, %s' % (hi, CR.get(lo, 'cr%d' % lo)), None
            if b1 == 0x6a: return 3, 'mvfc %s, r%d' % (CR.get(hi, 'cr%d' % hi), lo), None
            if b1 in (0x6c, 0x6d, 0x6e, 0x6f):
                return 3, '%s #%d, r%d' % ('rotr' if b1 < 0x6e else 'rotl', ((b1 & 1) << 4) | hi, lo), None
            if 0x70 <= b1 <= 0x7f and (b1 & 3) == 0 or (b1 & 0xf3) == 0x70:
                li = (b1 >> 2) & 3
                v, n = self.imm(a + 3, li)
                nm = {2: 'adc', 4: 'max', 5: 'min', 6: 'emul', 7: 'emulu', 8: 'div', 9: 'divu', 0xc: 'tst', 0xd: 'xor', 0xe: 'stz', 0xf: 'stnz'}.get(hi, '?')
                return 3 + n, '%s %s, r%d' % (nm, hx(v), lo), None
            if (b1 & 0xf3) == 0x73:
                li = (b1 >> 2) & 3
                v, n = self.imm(a + 3, li)
                return 3 + n, 'mvtc %s, %s' % (hx(v), CR.get(lo, 'cr%d' % lo)), None
            if 0x80 <= b1 <= 0xdf:
                nm = ['shlr', 'shar', 'shll'][(b1 - 0x80) >> 5]
                return 3, '%s #%d, r%d, r%d' % (nm, b1 & 31, hi, lo), None
            if 0xe0 <= b1 <= 0xff:
                bit = b1 & 31
                c = hi
                return 3, ('bnot' if c == 15 else 'bm%s' % COND[c]) + ' #%d, r%d' % (bit, lo), None
            return 3, '.fd %02x %02x' % (b1, b2), None
        if b0 == 0xfe:
            b2 = self.b(a + 2); sz = SZ[(b1 >> 4) & 3]; ri = b1 & 15; rb = b2 >> 4; r = b2 & 15
            k = b1 >> 6
            if k == 0: return 3, 'mov.%s r%d, [r%d, r%d]' % (sz, r, ri, rb), None
            if k == 1: return 3, 'mov.%s [r%d, r%d], r%d' % (sz, ri, rb, r), None
            if k == 3: return 3, 'movu.%s [r%d, r%d], r%d' % (sz, ri, rb, r), None
            return 3, '.fe %02x %02x' % (b1, b2), None
        if b0 == 0xff:
            b2 = self.b(a + 2); op = b1 >> 4
            nm = {0: 'sub', 2: 'add', 3: 'mul', 4: 'and', 5: 'or'}.get(op, '?')
            return 3, '%s r%d, r%d, r%d' % (nm, b2 & 15, b2 >> 4, b1 & 15), None
        return 1, '.byte 0x%02x' % b0, None

    def dis(self, a, n=30):
        out = []
        for _ in range(n):
            try:
                l, t, tg = self.one(a)
            except IndexError:
                break
            out.append((a, bytes(self.d[a - BASE:a - BASE + l]).hex(), t))
            a += l
        return out


def load(path):
    return Dis(open(path, 'rb').read())


if __name__ == '__main__':
    d = load(sys.argv[1]); a = int(sys.argv[2], 0); n = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    for x, h, t in d.dis(a, n): print('%08x  %-16s %s' % (x, h, t))
