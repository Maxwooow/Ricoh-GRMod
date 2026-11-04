# SPDX-License-Identifier: GPL-2.0-only
"""Reference of tools/gr4v120/hdrgain/hdrgain.c in Python: the gain map of a Y plane and its JPEG, bit for bit.

Tables come from core/src/fw/gr4v120/aspect/hdrgain.ts (tools/gr4v120/hdrgain/tables.ts prints them as JSON).
"""
import numpy as np


def gain_map(y, code):
    """Average of 4 x 4 pixels (edges repeated) through the table; y is uint8 H x W."""
    h, w = y.shape
    gw, gh = (w + 3) // 4, (h + 3) // 4
    p = np.pad(y, ((0, gh * 4 - h), (0, gw * 4 - w)), mode='edge').astype(np.int64)
    s = p.reshape(gh, 4, gw, 4).sum(axis=(1, 3))
    return np.asarray(code, np.uint8)[(s + 8) >> 4]


C = dict(FIX_0_298631336=2446, FIX_0_390180644=3196, FIX_0_541196100=4433, FIX_0_765366865=6270, FIX_0_899976223=7373,
         FIX_1_175875602=9633, FIX_1_501321110=12299, FIX_1_847759065=15137, FIX_1_961570560=16069, FIX_2_053119869=16819,
         FIX_2_562915447=20995, FIX_3_072711026=25172)


def _descale(x, n):
    return (x + (1 << (n - 1))) >> n


def _pass(d, rows, first):
    """One pass of jfdctint over axis: d[..., k] for k = 0..7 (k along the transformed axis)."""
    g = C
    t0 = d[0] + d[7]; t7 = d[0] - d[7]
    t1 = d[1] + d[6]; t6 = d[1] - d[6]
    t2 = d[2] + d[5]; t5 = d[2] - d[5]
    t3 = d[3] + d[4]; t4 = d[3] - d[4]
    t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2
    out = [None] * 8
    if first:
        out[0] = (t10 + t11) << 2
        out[4] = (t10 - t11) << 2
        sh = 11
    else:
        out[0] = _descale(t10 + t11, 2)
        out[4] = _descale(t10 - t11, 2)
        sh = 15
    z1 = (t12 + t13) * g['FIX_0_541196100']
    out[2] = _descale(z1 + t13 * g['FIX_0_765366865'], sh)
    out[6] = _descale(z1 + t12 * -g['FIX_1_847759065'], sh)
    z1 = t4 + t7; z2 = t5 + t6; z3 = t4 + t6; z4 = t5 + t7
    z5 = (z3 + z4) * g['FIX_1_175875602']
    t4 = t4 * g['FIX_0_298631336']; t5 = t5 * g['FIX_2_053119869']; t6 = t6 * g['FIX_3_072711026']; t7 = t7 * g['FIX_1_501321110']
    z1 = z1 * -g['FIX_0_899976223']; z2 = z2 * -g['FIX_2_562915447']; z3 = z3 * -g['FIX_1_961570560']; z4 = z4 * -g['FIX_0_390180644']
    z3 = z3 + z5; z4 = z4 + z5
    out[7] = _descale(t4 + z1 + z3, sh)
    out[5] = _descale(t5 + z2 + z4, sh)
    out[3] = _descale(t6 + z2 + z3, sh)
    out[1] = _descale(t7 + z1 + z4, sh)
    return out


def fdct(blocks):
    """blocks: N x 8 x 8 int64 (level shifted). jfdctint: rows, then columns."""
    rows = [blocks[:, :, k] for k in range(8)]          # row pass: along x
    r = _pass(rows, 8, True)
    b = np.stack(r, axis=2)
    cols = [b[:, k, :] for k in range(8)]               # column pass: along y
    c = _pass(cols, 8, False)
    return np.stack(c, axis=1)


def encode(gm, t):
    """The gain map JPEG as the module writes it."""
    gh, gw = gm.shape
    bw = (gw + 7) & ~7
    bh = (gh + 7) & ~7
    p = np.pad(gm, ((0, bh - gh), (0, bw - gw)), mode='edge').astype(np.int64) - 128
    blocks = p.reshape(bh // 8, 8, bw // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 8, 8)
    d = fdct(blocks).reshape(-1, 64)
    recip = np.asarray(t['recip'], np.int64)
    half = np.asarray(t['half'], np.int64)
    a = np.abs(d)
    q = ((a + half) * recip) >> 20
    q = np.where(d < 0, -q, q)
    zz = np.asarray(t['zigzag'])
    head = bytearray(bytes.fromhex(t['head']))
    s = t['sof']
    head[s:s + 2] = gh.to_bytes(2, 'big')
    head[s + 2:s + 4] = gw.to_bytes(2, 'big')
    out = bytearray()
    acc = 0
    n = 0

    def put(code, length):
        nonlocal acc, n
        if not length:
            return
        acc = (acc << length) | (code & ((1 << length) - 1))
        n += length
        while n >= 8:
            n -= 8
            v = (acc >> n) & 0xff
            out.append(v)
            if v == 0xff:
                out.append(0)
        acc &= (1 << n) - 1

    dc, ac = t['dc'], t['ac']
    prev = 0
    for blk in q:
        diff = int(blk[0]) - prev
        prev = int(blk[0])
        m = abs(diff).bit_length()
        put(dc[m] & 0xffff, dc[m] >> 16)
        if m:
            put(diff - 1 if diff < 0 else diff, m)
        run = 0
        for k in range(1, 64):
            v = int(blk[zz[k]])
            if not v:
                run += 1
                continue
            while run > 15:
                put(ac[0xf0] & 0xffff, ac[0xf0] >> 16)
                run -= 16
            if abs(v) > 1023:
                v = -1023 if v < 0 else 1023
            m = abs(v).bit_length()
            sym = run << 4 | m
            put(ac[sym] & 0xffff, ac[sym] >> 16)
            put(v - 1 if v < 0 else v, m)
            run = 0
        if run:
            put(ac[0] & 0xffff, ac[0] >> 16)
    if n:
        put(0x7f, 8 - n)
    return bytes(head) + bytes(out) + b'\xff\xd9'
