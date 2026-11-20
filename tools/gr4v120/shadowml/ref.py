# SPDX-License-Identifier: GPL-2.0-only
"""Bit-exact Python reference of tools/gr4v120/shadowml/shadowml.c (the learned Auto for Shadow Correction) and the model-blob writer.

Everything is integer arithmetic that mirrors the C code operation by operation.

The module decides the strength t (0..0x800) that the camera's shadow-correction core feeds into its own strength / level /
gain-table stages (strength = min(t, ISO cap) * gain >> 11; with the Auto gain raised to High, strength = min(t, cap) / 2).

Call:      shadowml(ctx, P, mode, hl, idx) -> i32   (t in 0..0x800, or -1: keep the camera's own zero strength)
  P     the shooting record (sb[0x130]); the module only reads the AWB statistic planes in it:
          mode 1, 2 (live view, movie):  R P+0x4D2C0, Gr P+0x512C0, B P+0x592C0, count P+0x5F2C0 (u32 per block),
                                         grid: w = u16[P+0x392A8], h = u16[P+0x392AA]
          other modes (0 still / RAW development, 3):  R P+0x14BD0, Gr P+0x18BD0, B P+0x20BD0, count P+0x26BD0,
                                         grid: w = u16[P+0xBB8], h = u16[P+0xBBA]
        block i = y * w + x (the row stride is w, as in the AWB's own use); w, h >= 1 and w * h <= 4096, else -1.
  hl    the highlight flag (Y shift of the core): the raw is 1 EV darker, so every channel is doubled.
  idx   ISO index (min(sb[0x44], 0x60)).

Features (the vector F[0..NF-1], i32; L = luminance of a block, see below; lg = log2 in Q8 (1/256 stop); frac = Q12):

  0..10  q01 q02 q05 q10 q25 q50 q75 q90 q95 q98 q99      lg of the p-th percentile of L over the counted blocks
  11     meanlog        mean of lg(L) over the counted blocks
  12..16 in1 .. in5     fraction of blocks within k stops below the median (L between median / 2^k and the median, both ends in)
  17     nearclip       fraction of blocks with max(R, G, B) >= NEARCLIP (after the hl doubling)
  18     cvb            lg of (mean L of the centre blocks / mean L of the border blocks)  (0 if either set is empty)
  19     idx            ISO index, clamped to 0..96
  20     mode           0..3 (clamped)
  21     hl             0 or 1
  22     valid          fraction of the w * h blocks that are counted
  23     d01 d05 d10    q50 - q01, q50 - q05, q50 - q10      (shadow depth below the median, Q8 stops)
  26     u99            q99 - q50
  27     rg             lg of (sum of R / sum of G) over the counted blocks (clamped, hl-doubled channels; 0 colour cast = 0)
  28     bg             the same for B / G

Per block: counted when count != 0; R, Gr, B clamped to 0xFFFF, doubled if hl; L = Gr (the green plane alone, so that L does not
depend on the white balance; the colour enters only through rg and bg), x = max(L, 1) lies in bin b = 16 e + m, e = floor(log2 x), m = the 4 bits after the leading one (b = 0..271). The percentile
bin is the first bin whose cumulative count reaches ceil(n p / 100); its lg is lgc(b) = 256 e + FRAC[m], FRAC[m] =
lg8(33 + 2 m) - 1280 (log2 of the bin centre). mean = (sum_b hist[b] lgc(b) + n/2) / n. The median bin mb is the 50 % bin;
in_k counts the bins max(0, mb - 16 k) .. mb. Centre blocks: y in [h/4, h - h/4) and x in [w/4, w - w/4) (integer /4).
lg8(x) (x >= 1) is the exact integer recipe in lg8() below.

Model blob (u32 little endian words; built by build_blob()):

  w0 magic 'SHMB' (0x424D4853)   w1 format 1   w2 NF (must equal this file's NF)   w3 n_trees (<= 4096)   w4 n_nodes (<= 65536)
  w5 mul (i32, Q16)   w6 off (i32)   w7 lo (i32)   w8 hi (i32)   w9 total bytes = 40 + 4 n_trees + 8 n_nodes (must be <= ctx blob_len)
  roots  u32[n_trees]   node index of every tree's root
  nodes  8 bytes each:  i32 a;  u8 feat;  u8 0;  u16 child
         feat == 0xFF: leaf, value a.      else: split, go to node `child` if F[feat] <= a (signed), to child + 1 otherwise
         (feat < NF, child + 1 < n_nodes, at most 32 levels).
  t = clamp(off + ((S * mul + 0x8000) >> 16), lo, hi), S = the (wrapping 32 bit) sum of the leaf values of all trees;
  then t is limited to 0x800; a negative t, or any structural error in the blob, gives -1.
  n_trees = 0 is the "constant t" model (t = clamp(off)).
"""
import struct

import numpy as np

NF = 29
NAMES = ['q01', 'q02', 'q05', 'q10', 'q25', 'q50', 'q75', 'q90', 'q95', 'q98', 'q99', 'meanlog', 'in1', 'in2', 'in3', 'in4', 'in5',
         'nearclip', 'cvb', 'idx', 'mode', 'hl', 'valid', 'd01', 'd05', 'd10', 'u99', 'rg', 'bg']
PCT = [1, 2, 5, 10, 25, 50, 75, 90, 95, 98, 99]
NBINS = 272
NEARCLIP = 0xE00
CHMAX = 0xFFFF
MAXBLOCKS = 4096
MAXDEPTH = 32
MAXTREES = 4096
MAXNODES = 65536
MAGIC = 0x4C444853          # ctx magic 'SHDL'
BLOB_MAGIC = 0x424D4853     # 'SHMB'
BLOB_VERSION = 1
HEADER_BYTES = 40
T_MAX = 0x800
MAXPERIOD = 64

# offsets in the shooting record
STILL = dict(R=0x14BD0, G=0x18BD0, B=0x20BD0, C=0x26BD0, W=0xBB8, H=0xBBA)
LV = dict(R=0x4D2C0, G=0x512C0, B=0x592C0, C=0x5F2C0, W=0x392A8, H=0x392AA)
P_STILL_MIN = lambda n: 0x26BD0 + 4 * n   # bytes of P the module reads on the still path (n = w * h)
P_LV_MIN = lambda n: 0x5F2C0 + 4 * n


def const_header():
    return ('/* GENERATED by tools/gr4v120/shadowml/gen.py from tools/gr4v120/shadowml/ref.py -- do not edit. */\n'
            f'#define SHADOWML_MAGIC 0x{MAGIC:08x}u /* \'SHDL\' */\n'
            f'#define SHADOWML_BLOB_MAGIC 0x{BLOB_MAGIC:08x}u /* \'SHMB\' */\n'
            f'#define SHADOWML_NF {NF}u\n#define SHADOWML_NBINS {NBINS}u\n#define SHADOWML_NEARCLIP {NEARCLIP}u\n'
            f'#define SHADOWML_CHMAX {CHMAX}u\n#define SHADOWML_MAXBLOCKS {MAXBLOCKS}u\n#define SHADOWML_MAXDEPTH {MAXDEPTH}u\n'
            f'#define SHADOWML_MAXTREES {MAXTREES}u\n#define SHADOWML_MAXNODES {MAXNODES}u\n#define SHADOWML_HEADER {HEADER_BYTES}u\n'
            f'#define SHADOWML_TMAX {T_MAX}\n#define SHADOWML_MAXPERIOD {MAXPERIOD}u\n')


def lg8(x):
    """256 * log2(x) for an integer 1 <= x < 2^32: the exponent, then 8 bits of the fraction by repeated squaring of the Q15 mantissa."""
    e = x.bit_length() - 1
    m = ((x << (31 - e)) & 0xFFFFFFFF) >> 16
    f = 0
    for _ in range(8):
        m = (m * m) >> 15
        f <<= 1
        if m >= 65536:
            m >>= 1
            f |= 1
    return e * 256 + f


FRAC = [lg8(33 + 2 * m) - 1280 for m in range(16)]


def lgc(b):
    return (b >> 4) * 256 + FRAC[b & 15]


def planes_of(P, mode):
    """(R, Gr, B, count, w, h) from the shooting record bytes, or None when the grid is not usable (the module returns -1)."""
    o = LV if mode in (1, 2) else STILL
    w, h = struct.unpack_from('<H', P, o['W'])[0], struct.unpack_from('<H', P, o['H'])[0]
    if w == 0 or h == 0 or w * h > MAXBLOCKS:
        return None
    n = w * h
    rd = lambda k: np.frombuffer(P, '<u4', count=n, offset=o[k]).astype(np.int64)
    return rd('R'), rd('G'), rd('B'), rd('C'), w, h


def features(R, G, B, C, w, h, hl, idx, mode):
    """The feature vector (list of NF ints) or None when no block is counted. R, G, B, C: arrays of w * h u32 values."""
    hl = 1 if hl else 0
    R, G, B, C = (np.asarray(a, dtype=np.int64) for a in (R, G, B, C))
    r = np.minimum(R, CHMAX) << hl
    g = np.minimum(G, CHMAX) << hl
    b = np.minimum(B, CHMAX) << hl
    valid = C != 0
    n = int(valid.sum())
    if n == 0:
        return None
    L = g
    x = np.maximum(L, 1)
    e = np.frexp(x.astype(np.float64))[1].astype(np.int64) - 1
    m = ((x << (31 - e)) >> 27) & 15
    bins = (e * 16 + m)[valid]
    hist = np.bincount(bins, minlength=NBINS).astype(np.int64)
    yy, xx = np.divmod(np.arange(w * h), w)
    centre = (yy >= (h >> 2)) & (yy < h - (h >> 2)) & (xx >= (w >> 2)) & (xx < w - (w >> 2)) & valid
    border = valid & ~centre
    nc, nb = int(centre.sum()), int(border.sum())
    sc, sb = int(L[centre].sum()), int(L[border].sum())
    nclip = int(((np.maximum(np.maximum(r, g), b) >= NEARCLIP) & valid).sum())
    # percentile bins
    qb = []
    cum, bi = 0, 0
    for p in PCT:
        k = ((n * p + 99) * 0x51EB851F) >> 37
        while True:
            cum2 = cum + int(hist[bi])
            if cum2 >= k:
                break
            cum, bi = cum2, bi + 1
        qb.append(bi)
        # cum stays the count before bin bi; the next (larger) percentile continues from the same bin
    q = [lgc(bb) for bb in qb]
    total = sum(int(hist[bb]) * lgc(bb) for bb in range(NBINS))
    meanlog = (total + (n >> 1)) // n
    mb = qb[5]
    inn = []
    for k in range(1, 6):
        lo = max(0, mb - 16 * k)
        c = int(hist[lo:mb + 1].sum())
        inn.append(((c << 12) + (n >> 1)) // n)
    nearclip = ((nclip << 12) + (n >> 1)) // n
    cvb = 0 if nc == 0 or nb == 0 else lg8(max(sc, 1)) - lg8(nc) - lg8(max(sb, 1)) + lg8(nb)
    sr, sgg, sbb = int(r[valid].sum()), int(g[valid].sum()), int(b[valid].sum())
    rg = lg8(max(sr, 1)) - lg8(max(sgg, 1))
    bg = lg8(max(sbb, 1)) - lg8(max(sgg, 1))
    nblk = w * h
    validf = ((n << 12) + (nblk >> 1)) // nblk
    F = q + [meanlog] + inn + [nearclip, cvb, min(idx, 96), min(mode, 3), hl, validf, q[5] - q[0], q[5] - q[2], q[5] - q[3], q[10] - q[5], rg, bg]
    assert len(F) == NF
    return [int(v) for v in F]


def parse_blob(blob, blob_len=None):
    """(nt, nn, mul, off, lo, hi, roots, nodes) or None when the blob is not valid for this module."""
    blen = len(blob) if blob_len is None else blob_len
    if blen < HEADER_BYTES or len(blob) < blen:
        return None
    w = struct.unpack_from('<IIIIIiiiiI', blob, 0)
    magic, ver, nf, nt, nn, mul, off, lo, hi, total = w
    if magic != BLOB_MAGIC or ver != BLOB_VERSION or nf != NF or nt > MAXTREES or nn > MAXNODES:
        return None
    if total != HEADER_BYTES + 4 * nt + 8 * nn or total > blen or lo > hi:
        return None
    roots = struct.unpack_from(f'<{nt}I', blob, HEADER_BYTES) if nt else ()
    nodes = [struct.unpack_from('<iBBH', blob, HEADER_BYTES + 4 * nt + 8 * i) for i in range(nn)]
    return nt, nn, mul, off, lo, hi, roots, nodes


def eval_model(blob, F, blob_len=None):
    """The model output t (or -1), F the feature vector."""
    pm = parse_blob(blob, blob_len)
    if pm is None:
        return -1
    nt, nn, mul, off, lo, hi, roots, nodes = pm
    s = 0
    for t in range(nt):
        cur = roots[t]
        if cur >= nn:
            return -1
        for _ in range(MAXDEPTH + 1):
            a, feat, _pad, child = nodes[cur]
            if feat == 0xFF:
                s = (s + a) & 0xFFFFFFFF
                break
            if feat >= NF or child + 1 >= nn:
                return -1
            cur = child if F[feat] <= a else child + 1
        else:
            return -1
    s = s - (1 << 32) if s >= 1 << 31 else s
    v = off + ((s * mul + 0x8000) >> 16)
    v = min(max(v, lo), hi)
    v = min(v, T_MAX)
    return -1 if v < 0 else v


def shadowml_ref(blob, P, mode, hl, idx, blob_len=None, magic_ok=True, want_features=False):
    """The module's result for a shooting record P (bytes) and the call arguments (with want_features: (result, F or None))."""
    F = None
    t = -1
    if magic_ok and parse_blob(blob, blob_len) is not None:
        pl = planes_of(P, mode)
        if pl is not None:
            F = features(*pl, hl, idx, mode)
            if F is not None:
                t = eval_model(blob, F, blob_len)
    return (t, F) if want_features else t


class Seq:
    """The module with its throttling state (live view / movie: compute on every `period`-th call, hold in between); a still call
    (mode not 1 or 2) never touches the state. state: one u32, bits 0..7 = calls still to hold, bits 8..19 = held result + 1."""

    def __init__(self, blob, period, state=0, blob_len=None):
        self.blob, self.period, self.blob_len = blob, period, blob_len
        self.state = state

    def call(self, P, mode, hl, idx, magic_ok=True):
        if not magic_ok:
            return -1
        per = min(self.period, MAXPERIOD)
        if mode not in (1, 2) or per <= 1:
            return shadowml_ref(self.blob, P, mode, hl, idx, self.blob_len)
        w = self.state
        if (w & 255) != 0 and (w & 255) < per and (w >> 20) == 0 and ((w >> 8) & 4095) <= T_MAX + 1:
            self.state = w - 1
            return ((w >> 8) & 4095) - 1
        r = shadowml_ref(self.blob, P, mode, hl, idx, self.blob_len)
        self.state = (per - 1) | ((r + 1) << 8)
        return r


# ---------------------------------------------------------------------------------------------------------------- blob writer
def build_blob(trees, mul=65536, off=0, lo=0, hi=T_MAX):
    """trees: list of nested tuples, ('leaf', value) or ('split', feature, threshold, left, right) (left taken when F[feature] <= threshold).
    Children of a node are stored side by side. Returns the blob bytes."""
    nodes = []

    def put(tree, slot):
        if tree[0] == 'leaf':
            nodes[slot] = (int(tree[1]), 0xFF, 0, 0)
            return
        _, feat, thr, left, right = tree
        if isinstance(feat, str):
            feat = NAMES.index(feat)
        c = len(nodes)
        nodes.extend([None, None])
        nodes[slot] = (int(thr), feat, 0, c)
        put(left, c)
        put(right, c + 1)

    roots = []
    for t in trees:
        roots.append(len(nodes))
        nodes.append(None)
        put(t, roots[-1])
    nt, nn = len(roots), len(nodes)
    total = HEADER_BYTES + 4 * nt + 8 * nn
    out = struct.pack('<IIIIIiiiiI', BLOB_MAGIC, BLOB_VERSION, NF, nt, nn, mul, off, lo, hi, total)
    out += struct.pack(f'<{nt}I', *roots)
    for a, f, p, c in nodes:
        out += struct.pack('<iBBH', a, f, p, c)
    return out


def placeholder_blob():
    """TEMPORARY placeholder model (until the trained trees replace it): t = 2 * 256 (the camera's Low) when the 1 % quantile lies more
    than 4 stops below the median (d01 = q50 - q01 > 4 * 256), else 0."""
    return build_blob([('split', 'd01', 4 * 256, ('leaf', 0), ('leaf', 2 * 256))])


def constant_blob(t):
    return build_blob([], off=t)
