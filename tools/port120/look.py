# SPDX-License-Identifier: GPL-2.0-only
"""Look at the same code in 1.11 and 1.20 (development tool; capstone, numpy).

    look.py dis ADDR [BEFORE AFTER]         disassemble ADDR (1.11) and its place in 1.20
    look.py dis b:ADDR [BEFORE AFTER]       disassemble 1.20 only
    look.py diff ADDR [ADDR120] [--win BEFORE AFTER]
                                            the function around ADDR (or the window) in both files,
                                            addresses shown as 1.11 addresses on both sides
    look.py refs ADDR [RANGE]               every branch, pointer and MOVW/MOVT pair of 1.11 that
                                            refers to ADDR, the matching place in 1.20 and what
                                            it refers to there (finds a function that changed
                                            inside through its unchanged callers)
"""
import collections
import difflib
import re
import struct
import sys
from pathlib import Path

import numpy as np
from capstone import CS_ARCH_ARM, CS_MODE_ARM, Cs

sys.path.insert(0, str(Path(__file__).resolve().parent))
import amap  # noqa: E402

m = amap.Map()
cs = Cs(CS_ARCH_ARM, CS_MODE_ARM)
BASE = amap.BASE


def word(tag, va):
    b = m.read(tag, va, 4)
    return struct.unpack('<I', b)[0] if b else 0


def text_of(tag, va, w):
    ins = list(cs.disasm(struct.pack('<I', w), va))
    return ('%s %s' % (ins[0].mnemonic, ins[0].op_str)) if ins else '.word 0x%08x' % w


def dump(tag, start, n, mark, other=None):
    lines = []
    for k in range(n):
        va = start + 4 * k
        w = word(tag, va)
        note = ''
        if other:
            q = other(va)
            note = '   ~ ' + (('0x%08x' % q) if q else '-')
        lines.append('%s %s 0x%08x: %08x  %-44s%s' % (tag, '>' if va == mark else ' ', va, w, text_of(tag, va, w), note))
    return '\n'.join(lines)


def cmd_dis(args):
    before = int(args[1]) if len(args) > 1 else 8
    after = int(args[2]) if len(args) > 2 else 16
    if args[0].startswith('b:'):
        vb = int(args[0][2:], 16)
        print(dump('B', vb - 4 * before, before + after, vb))
        return
    va = int(args[0], 16)
    print(dump('A', va - 4 * before, before + after, va, m.map))
    q = m.map(va)
    if q is None:
        for d in range(4, 0x4000, 4):
            q = m.map(va - d)
            if q is not None:
                q += d
                print('-- not mapped; placed after the nearest mapped word %d bytes before: 0x%08x' % (d, q))
                break
    else:
        print('-- mapped to 0x%08x' % q)
    if q:
        print(dump('B', q - 4 * before, before + after, q))


def movpairs(tag, start, end):
    res = {}
    for va in range(start, end, 4):
        w = word(tag, va)
        if (w & 0x0FF00000) != 0x03000000:
            continue
        rd = (w >> 12) & 15
        for k in range(1, 9):
            w2 = word(tag, va + 4 * k)
            if (w2 & 0x0FF00000) == 0x03400000 and ((w2 >> 12) & 15) == rd:
                val = (((w >> 4) & 0xF000) | (w & 0xFFF)) | ((((w2 >> 4) & 0xF000) | (w2 & 0xFFF)) << 16)
                res[va] = (rd, val, 'w')
                res[va + 4 * k] = (rd, val, 't')
                break
    return res


def listing(tag, start, end):
    """Instruction texts with every address rendered as a 1.11 address."""
    to111 = (lambda x: x) if tag == 'A' else m.back
    out, raw = [], []
    pairs = movpairs(tag, start - 32, end)
    for va in range(start, end, 4):
        w = word(tag, va)
        raw.append((va, w))
        if va in pairs and 0x53000000 <= pairs[va][1] < 0x56000000:
            rd, val, half = pairs[va]
            t = to111(val)
            cond = '' if (w >> 28) == 14 else '.c%x' % (w >> 28)
            out.append('mov%s%s r%d, =%s' % (half, cond, rd, ('0x%08x' % t) if t else '?0x%08x' % val))
            continue
        ins = list(cs.disasm(struct.pack('<I', w), va))
        if not ins:
            if 0x53000000 <= w < 0x56000000:
                t = to111(w)
                out.append('.word =%s' % (('0x%08x' % t) if t else '?0x%08x' % w))
            else:
                out.append('.word 0x%08x' % w)
            continue
        i = ins[0]
        s = '%s %s' % (i.mnemonic, i.op_str)
        if i.mnemonic.startswith('b') and i.op_str.startswith('#0x') and not i.mnemonic.startswith('bic'):
            t = to111(int(i.op_str[1:], 16))
            s = '%s %s' % (i.mnemonic, ('@0x%08x' % t) if t else '?0x%08x' % int(i.op_str[1:], 16))
        mm = re.search(r'\[pc, #(-?0x[0-9a-f]+|-?\d+)\]', i.op_str)
        if mm and i.mnemonic.startswith(('ldr', 'vldr')):
            lit = (va & ~3) + 8 + int(mm.group(1), 0)
            val = word(tag, lit)
            if 0x53000000 <= val < 0x56000000:
                t = to111(val)
                s = '%s %s, =%s' % (i.mnemonic, i.op_str.split(',')[0], ('0x%08x' % t) if t else '?0x%08x' % val)
            else:
                s = '%s %s, =0x%x' % (i.mnemonic, i.op_str.split(',')[0], val)
        out.append(s)
    return out, raw


def find_start(tag, va):
    for k in range(0, 0x4000, 4):
        if word(tag, va - k) == 0xE1A0C00D:
            return va - k
    return va


def find_end(tag, start, limit=2000):
    for k in range(4, 4 * limit, 4):
        if word(tag, start + k) == 0xE1A0C00D:
            return start + k
    return start + 4 * limit


def cmd_diff(args):
    win = None
    if '--win' in args:
        k = args.index('--win')
        win = (int(args[k + 1]), int(args[k + 2]))
        args = args[:k] + args[k + 3:]
    va = int(args[0], 16)
    if win:
        sa, ea = va - 4 * win[0], va + 4 * win[1]
    else:
        sa = find_start('A', va)
        ea = find_end('A', sa)
    if len(args) > 1:
        sb = int(args[1], 16) - (4 * win[0] if win else 0)
    else:
        sb = None
        for d in range(0, ea - sa, 4):
            q = m.map(sa + d)
            if q is not None:
                sb = q - d if win else find_start('B', q)
                break
        if sb is None:
            print('cannot place it in 1.20: give ADDR120')
            return
    eb = sb + (ea - sa) + 4 * 48 if win else find_end('B', sb)
    la, ra = listing('A', sa, ea)
    lb, rb = listing('B', sb, eb)
    print('1.11 0x%08x..0x%08x (%d words), 1.20 0x%08x..0x%08x (%d words)' % (sa, ea, len(la), sb, eb, len(lb)))
    sm = difflib.SequenceMatcher(a=la, b=lb, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                print('   0x%08x 0x%08x  %s' % (ra[i1 + k][0], rb[j1 + k][0], la[i1 + k]))
        else:
            for k in range(i1, i2):
                print('-  0x%08x %10s  %s' % (ra[k][0], '', la[k]))
            for k in range(j1, j2):
                print('+  %10s 0x%08x  %s' % ('', rb[k][0], lb[k]))


def cmd_refs(args):
    target = int(args[0], 16)
    rng = int(args[1]) if len(args) > 1 else 0
    lo, hi = target - rng, target + rng
    A = np.frombuffer(m.A[:len(m.A) // 4 * 4], dtype='<u4').astype(np.int64)
    pc = BASE + np.arange(len(A), dtype=np.int64) * 4
    imm = A & 0xFFFFFF
    t = pc + 8 + np.where(imm & 0x800000, imm - 0x1000000, imm) * 4
    t = np.where((A >> 28) == 0xF, t + ((A >> 24) & 1) * 2, t)
    t = np.where(((A >> 25) & 7) == 5, t, -1)
    votes = collections.Counter()

    def branch_b(q):
        w = word('B', q)
        if ((w >> 25) & 7) != 5:
            return None
        d = w & 0xFFFFFF
        if d & 0x800000:
            d -= 1 << 24
        return q + 8 + d * 4

    for i in np.nonzero((t >= lo) & (t <= hi))[0].tolist():
        site = BASE + 4 * i
        d = int(t[i]) - target
        q = m.map(site)
        r = branch_b(q) if q else None
        print('branch at 0x%08x -> 1.20 %s refers to %s (target%+d)' % (site, ('0x%08x' % q) if q else '-', ('0x%08x' % r) if r else '-', d))
        if r:
            votes[r - d] += 1
    for i in np.nonzero((A >= lo) & (A <= hi))[0].tolist():
        site = BASE + 4 * i
        d = int(A[i]) - target
        q = m.map(site)
        r = word('B', q) if q else None
        print('ptr    at 0x%08x -> 1.20 %s holds %s (target%+d)' % (site, ('0x%08x' % q) if q else '-', ('0x%08x' % r) if r is not None else '-', d))
        if r is not None:
            votes[r - d] += 1
    pa = movpairs('A', BASE, BASE + len(m.A) - 64)
    for site, (rd, val, half) in sorted(pa.items()):
        if half != 'w' or not (lo <= val <= hi):
            continue
        d = val - target
        q = m.map(site)
        r = None
        if q:
            pb = movpairs('B', q, q + 4)
            if q in pb:
                r = pb[q][1]
        print('movw   at 0x%08x -> 1.20 %s holds %s (target%+d)' % (site, ('0x%08x' % q) if q else '-', ('0x%08x' % r) if r else '-', d))
        if r:
            votes[r - d] += 1
    print('1.20 place of 0x%08x by vote:' % target, ', '.join('0x%08x x%d' % kv for kv in votes.most_common(4)) or 'none')


if __name__ == '__main__':
    {'dis': cmd_dis, 'diff': cmd_diff, 'refs': cmd_refs}[sys.argv[1]](sys.argv[2:])
