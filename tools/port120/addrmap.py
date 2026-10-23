# SPDX-License-Identifier: GPL-2.0-only
"""Which address of firmware 1.20 holds what an address of 1.11 holds (development tool).

1.20 is 1.11's program rebuilt with additions: most functions and data are the same, moved. The
two RTOS images are compared word by word:

 1. Each word is normalised so that moving code does not change it: branch offsets, PC-relative
    loads, MOVW/MOVT immediates and values that look like addresses are masked. Words that are the
    only one of their 16-word neighbourhood in both images anchor a match, which is extended in
    both directions as long as the words agree: blocks (start in 1.11, start in 1.20, length).
 2. That map is refined: each word is now compared with every address it holds (pointer, branch
    target, literal of a PC-relative load, MOVW/MOVT pair) translated through the previous map; a
    word whose address is not mapped yet matches anything of its kind, words identical in both
    files always match. Repeated until it no longer changes, so that tables of pointers and code
    are matched exactly, not just up to relocation.

The result, .cache/map.json, is used by `amap.py` and `gen_table.py`. Addresses in the BSS (not
in either image) are mapped through pairs of pointers found at matched places.

    python3 addrmap.py          (numpy)
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwimage  # noqa: E402

BASE = fwimage.BASE
K = 16


# ---------------------------------------------------------------------------------- pass 1

def normalise(words):
    w = words.astype(np.uint32)
    n = w.copy()
    ptr = (w >= 0x53000000) & (w < 0x56000000)
    cond = w >> 28
    br = ((w >> 25) & 7) == 5
    n = np.where(br & (cond != 0xF), w & 0xFF000000, n)
    n = np.where(br & (cond == 0xF), w & 0xFE000000, n)
    lit = ((w & 0x0E000000) == 0x04000000) & (((w >> 16) & 15) == 15)
    n = np.where(lit, w & 0xFF7FF000, n)
    lith = ((w & 0x0E400090) == 0x00400090) & (((w >> 16) & 15) == 15)
    n = np.where(lith, w & 0xFF7FF0F0, n)
    vl = ((w & 0x0F300E00) == 0x0D100A00) & (((w >> 16) & 15) == 15)
    n = np.where(vl, w & 0xFF7FFF00, n)
    adr = ((w & 0x0FEF0000) == 0x028F0000) | ((w & 0x0FEF0000) == 0x024F0000)
    n = np.where(adr, w & 0xFFFFF000, n)
    mov = ((w & 0x0FF00000) == 0x03000000) | ((w & 0x0FF00000) == 0x03400000)
    n = np.where(mov, w & 0xFFF0F000, n)
    n = np.where(ptr, np.uint32(0xDEAD0000), n)
    return n


def kgram_hash(n, k=K):
    h = np.zeros(len(n) - k + 1, dtype=np.uint64)
    m = np.uint64(0x100000001B3)
    x = n.astype(np.uint64)
    for i in range(k):
        h = h * m + x[i:len(n) - k + 1 + i] + np.uint64(i * 0x9E3779B97F4A7C15 & 0xFFFFFFFFFFFFFFFF)
    return h


def unique_positions(h):
    order = np.argsort(h, kind='stable')
    hs = h[order]
    first = np.ones(len(hs), dtype=bool)
    first[1:] = hs[1:] != hs[:-1]
    last = np.ones(len(hs), dtype=bool)
    last[:-1] = hs[1:] != hs[:-1]
    uniq = first & last
    return hs[uniq], order[uniq]


def anchors_of(a, b):
    na, nb = normalise(a), normalise(b)
    ua, pa = unique_positions(kgram_hash(na))
    ub, pb = unique_positions(kgram_hash(nb))
    _, ia, ib = np.intersect1d(ua, ub, assume_unique=True, return_indices=True)
    return sorted(zip(pa[ia].tolist(), pb[ib].tolist())), na, nb


def extend(anchors, same, eq_block, na_len, nb_len):
    blocks = []
    covered = -1
    for i, j in anchors:
        if i < covered:
            continue
        if not all(same(i + k, j + k) for k in range(K)):
            continue
        s_i, s_j = i, j
        while s_i > 0 and s_j > 0 and s_i - 1 >= covered and same(s_i - 1, s_j - 1):
            s_i -= 1
            s_j -= 1
        e_i, e_j = i + K, j + K
        while e_i < na_len and e_j < nb_len:
            L = min(4096, na_len - e_i, nb_len - e_j)
            eq = eq_block(e_i, e_j, L)
            if eq.all():
                e_i += L
                e_j += L
                continue
            k = int(np.argmin(eq))
            e_i += k
            e_j += k
            break
        blocks.append((s_i, s_j, e_i - s_i))
        covered = e_i
    return blocks


# ---------------------------------------------------------------------------------- pass 2

class Translator:
    """A block map as a vectorised function on 1.11 addresses (-1 where not mapped)."""

    def __init__(self, blocks, len_a, bss):
        blocks = sorted(blocks)
        self.sa = np.array([x[0] for x in blocks], dtype=np.int64)
        self.sb = np.array([x[1] for x in blocks], dtype=np.int64)
        self.n = np.array([x[2] for x in blocks], dtype=np.int64)
        self.len_a = len_a
        pts = sorted(bss)
        self.bk = np.array([p[0] for p in pts], dtype=np.int64)
        self.bd = np.array([p[1] for p in pts], dtype=np.int64)

    def img(self, a):
        idx = (a - BASE) // 4
        k = np.searchsorted(self.sa, idx, side='right') - 1
        ok = (k >= 0) & (a >= BASE) & (a < BASE + self.len_a)
        kk = np.where(k >= 0, k, 0)
        ok &= idx < self.sa[kk] + self.n[kk]
        return np.where(ok, BASE + (self.sb[kk] + (idx - self.sa[kk])) * 4 + (a & 3), -1)

    def __call__(self, a):
        a = a.astype(np.int64)
        out = np.full(a.shape, -1, dtype=np.int64)
        ra, rb = fwimage.RAM['111'], fwimage.RAM['120']
        inram = (a >= ra['dst']) & (a < ra['dst'] + ra['length'])
        if inram.any():
            m = self.img(ra['src'] + (a[inram] - ra['dst']))
            good = (m >= rb['src']) & (m < rb['src'] + rb['length'])
            out[inram] = np.where(good, rb['dst'] + (m - rb['src']), -1)
        inimg = (a >= BASE) & (a < BASE + self.len_a)
        if inimg.any():
            out[inimg] = self.img(a[inimg])
        bss = (a >= ra['dst'] + ra['length']) & (a < 0x56000000)
        if bss.any() and len(self.bk):
            x = a[bss]
            k = np.searchsorted(self.bk, x, side='right') - 1
            kk = np.where(k >= 0, k, 0)
            exact = (k >= 0) & (self.bk[kk] == x)
            kn = np.minimum(kk + 1, len(self.bk) - 1)
            between = (k >= 0) & (kk + 1 < len(self.bk)) & (self.bd[kn] == self.bd[kk])
            out[bss] = np.where(exact | between, x + self.bd[kk], -1)
        return out


def canon(words, translate=None):
    """(kind and opcode, address or value, address-not-mapped) per word; addresses translated for 1.11."""
    w = words.astype(np.int64)
    n = len(w)
    pc = BASE + np.arange(n, dtype=np.int64) * 4
    hi = np.zeros(n, dtype=np.uint64)
    lo = w.astype(np.uint64)
    wild = np.zeros(n, dtype=bool)
    tr = translate if translate is not None else (lambda x: x)
    ptr = (w >= 0x53000000) & (w < 0x56000000)
    cond = w >> 28
    br = (((w >> 25) & 7) == 5) & ~ptr
    imm = w & 0xFFFFFF
    simm = np.where(imm & 0x800000, imm - 0x1000000, imm)
    tgt = pc + 8 + simm * 4
    tgt = np.where(br & (cond == 0xF), tgt + ((w >> 24) & 1) * 2, tgt)
    lit = ((w & 0x0E000000) == 0x04000000) & (((w >> 16) & 15) == 15) & ~ptr & ~br
    lith = ((w & 0x0E400090) == 0x00400090) & (((w >> 16) & 15) == 15) & ~ptr & ~br
    vl = ((w & 0x0F300E00) == 0x0D100A00) & (((w >> 16) & 15) == 15) & ~ptr & ~br
    up = (w >> 23) & 1
    off12 = w & 0xFFF
    offh = ((w >> 4) & 0xF0) | (w & 0xF)
    offv = (w & 0xFF) * 4
    lit_addr = np.where(lit, pc + 8 + np.where(up == 1, off12, -off12), 0)
    lit_addr = np.where(lith, pc + 8 + np.where(up == 1, offh, -offh), lit_addr)
    lit_addr = np.where(vl, (pc & ~3) + 8 + np.where(up == 1, offv, -offv), lit_addr)
    adr_add = ((w & 0x0FEF0000) == 0x028F0000) & ~ptr & ~br
    adr_sub = ((w & 0x0FEF0000) == 0x024F0000) & ~ptr & ~br
    rot = ((w >> 8) & 15) * 2
    v8 = w & 0xFF
    immv = np.where(rot == 0, v8, ((v8 >> rot) | (v8 << (32 - rot))) & 0xFFFFFFFF)
    adr_addr = np.where(adr_add, pc + 8 + immv, np.where(adr_sub, pc + 8 - immv, 0))
    movw = (w & 0x0FF00000) == 0x03000000
    movt = (w & 0x0FF00000) == 0x03400000
    val = ((w >> 4) & 0xF000) | (w & 0xFFF)
    rd = (w >> 12) & 15
    partner = np.full(n, -1, dtype=np.int64)
    for d in range(8, 0, -1):
        cand = np.zeros(n, dtype=bool)
        cand[:-d] = movw[:-d] & movt[d:] & (rd[:-d] == rd[d:])
        partner[cand] = np.nonzero(cand)[0] + d
    pair = partner >= 0
    pair_val = val | (val[np.where(pair, partner, 0)] << 16)
    pair_is_addr = pair & (pair_val >= 0x53000000) & (pair_val < 0x56000000)
    lonely = (movw | movt) & ~ptr & ~br
    lo = np.where(lonely, w & 0xFFF0F000, w).astype(np.uint64)
    for mask, kind, op, addr in ((ptr, 1, w * 0, w), (br, 2, w & 0xFF000000, tgt), (lit | lith | vl, 3, w & 0xFF7FF000, lit_addr), (adr_add | adr_sub, 4, w & 0xFFFFF000, adr_addr)):
        if not mask.any():
            continue
        t = tr(addr[mask])
        hi[mask] = (np.uint64(kind) << np.uint64(40)) | op[mask].astype(np.uint64)
        lo[mask] = np.where(t >= 0, t, -1).astype(np.int64).astype(np.uint64)
        wild[np.nonzero(mask)[0][t < 0]] = True
    if pair_is_addr.any():
        idx = np.nonzero(pair_is_addr)[0]
        t = tr(pair_val[idx])
        for j, off in ((idx, 0), (partner[idx], 1)):
            hi[j] = (np.uint64(5 + off) << np.uint64(40)) | (w[j] & 0xFFF0F000).astype(np.uint64)
            lo[j] = np.where(t >= 0, t, -1).astype(np.int64).astype(np.uint64)
            wild[j[t < 0]] = True
    return hi, lo, wild


def bss_pairs(blocks, a, b):
    pairs = {}
    ra = fwimage.RAM['111']
    for s_a, s_b, n in blocks:
        wa = a[s_a:s_a + n].astype(np.int64)
        wb = b[s_b:s_b + n].astype(np.int64)
        sel = (wa >= ra['dst'] + ra['length']) & (wa < 0x56000000)
        for x, y in zip(wa[sel].tolist(), wb[sel].tolist()):
            pairs.setdefault(x, {}).setdefault(y - x, 0)
            pairs[x][y - x] += 1
    return [(x, max(d.items(), key=lambda kv: kv[1])[0]) for x, d in pairs.items()]


def build():
    A, B = fwimage.rtos('111'), fwimage.rtos('120')
    a = np.frombuffer(A[:len(A) // 4 * 4], dtype='<u4')
    b = np.frombuffer(B[:len(B) // 4 * 4], dtype='<u4')
    anchors, na, nb = anchors_of(a, b)
    blocks = extend(anchors, lambda i, j: na[i] == nb[j], lambda i, j, L: na[i:i + L] == nb[j:j + L], len(na), len(nb))
    total = sum(x[2] for x in blocks)
    print('pass 1: %d blocks, %.2f%% of 1.11 matched up to relocation' % (len(blocks), 100.0 * total / len(a)), file=sys.stderr)
    hb, lb, _ = canon(b)
    for it in range(8):
        bss = bss_pairs(blocks, a, b)
        ha, la, wa = canon(a, Translator(blocks, len(A), bss))

        def same(i, j):
            return (ha[i] == hb[j] and (wa[i] or la[i] == lb[j])) or a[i] == b[j]

        def eq_block(i, j, L):
            return ((ha[i:i + L] == hb[j:j + L]) & (wa[i:i + L] | (la[i:i + L] == lb[j:j + L]))) | (a[i:i + L] == b[j:j + L])

        new = extend(anchors, same, eq_block, len(a), len(b))
        total = sum(x[2] for x in new)
        print('pass %d: %d blocks, %.2f%% matched exactly' % (it + 2, len(new), 100.0 * total / len(a)), file=sys.stderr)
        if new == blocks:
            break
        blocks = new
    out = {'blocks': blocks, 'bss': bss_pairs(blocks, a, b)}
    fwimage.CACHE.mkdir(exist_ok=True)
    (fwimage.CACHE / 'map.json').write_text(json.dumps(out))
    return out


if __name__ == '__main__':
    build()
