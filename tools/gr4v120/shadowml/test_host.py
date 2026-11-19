# SPDX-License-Identifier: GPL-2.0-only
"""Bit-exact test: shadowml.c (gcc, x86, via host.c) against ref.py. The C code is built twice: -O2 and with UBSan + ASan (-O1).

Inputs: the AWB statistic planes of the GR IV DNGs (makernote tag 0x0405), random synthetic scenes (odd grids, clipped / zero /
garbage blocks, empty scenes, mode and idx out of range, hl on and off), edge cases, and adversarial inputs: random trees,
corrupted model blobs, a wrong context magic, garbage in every byte of the record that the module does not read. Both the feature
vector and the result are compared, and the record must come back unchanged.

usage: test_host.py   (env SHADOWML_NRANDOM, SHADOWML_NSAN to scale; needs gcc, numpy; optional: $SHADOWML_DNG, a folder of GR IV DNGs, adds
real-photo scenes from their AWB statistic planes (makernote tag 0x0405), read by a `dngload.load405` on the Python path)"""
import ctypes
import glob
import os
import random
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

import ref

HERE = Path(__file__).resolve().parent
NRANDOM = int(os.environ.get('SHADOWML_NRANDOM', 12000))
NSAN = int(os.environ.get('SHADOWML_NSAN', 3000))


def build_libs(tmp):
    libs = {}
    for name, flags in (('o2', ['-O2']), ('san', ['-O1', '-g', '-fsanitize=undefined,address', '-fno-sanitize-recover=undefined'])):
        out = Path(tmp) / f'libshadowml_{name}.so'
        subprocess.run(['gcc', '-Wall', '-Wextra', '-shared', '-fPIC', *flags, str(HERE / 'host.c'), '-o', str(out)], check=True)
        libs[name] = out
    return libs


class Lib:
    def __init__(self, path):
        self.lib = lib = ctypes.CDLL(str(path))
        lib.host_run.restype = ctypes.c_int
        lib.host_run.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
                                 ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]

        lib.host_cfg.argtypes = [ctypes.c_int, ctypes.c_int]
        lib.host_allocs.restype = ctypes.c_int
        lib.host_slot.restype = ctypes.c_ulonglong

    def run(self, P, blob, mode, hl, idx, magic=ref.MAGIC, period=1, state=None):
        same, fok = ctypes.c_int(), ctypes.c_int()
        F = (ctypes.c_int * ref.NF)()
        r = self.lib.host_run(bytes(P), len(P), bytes(blob), len(blob), magic, mode, hl, idx, period, state, ctypes.byref(same), F, ctypes.byref(fok))
        return r, bool(same.value), (list(F) if fok.value else None)


# ---------------------------------------------------------------------------------------------------------------- inputs
def p_len(mode, w, h):
    """The number of bytes of P the module may read for this grid (everything below the last count plane entry)."""
    if w == 0 or h == 0 or w * h > ref.MAXBLOCKS:
        return (0x392AC if mode in (1, 2) else 0xBBC)
    return ref.P_LV_MIN(w * h) if mode in (1, 2) else ref.P_STILL_MIN(w * h)


def make_P(mode, w, h, R, G, B, C, rng, dims=None):
    """A record with the planes at the offsets of `mode`'s path, garbage everywhere else (and in the planes of the other path)."""
    o = ref.LV if mode in (1, 2) else ref.STILL
    n = w * h
    ln = p_len(mode, w, h) if dims is None else p_len(mode, *dims)
    P = bytearray(rng.integers(0, 256, ln, dtype=np.uint8).tobytes())
    dw, dh = (w, h) if dims is None else dims
    struct.pack_into('<H', P, o['W'], dw & 0xFFFF)
    struct.pack_into('<H', P, o['H'], dh & 0xFFFF)
    if dims is None or (dw and dh and dw * dh <= ref.MAXBLOCKS):
        for k, a in (('R', R), ('G', G), ('B', B), ('C', C)):
            P[o[k]:o[k] + 4 * n] = np.asarray(a, dtype='<u4').tobytes()
    return bytes(P)


def scene(rng, kind=None):
    """(w, h, R, G, B, C) a synthetic block-statistics scene (values in the camera's units: R ~ 300..2000, G up to ~4000)."""
    kind = kind if kind is not None else int(rng.integers(0, 9))
    if rng.random() < 0.5:
        w, h = 64, 62
    elif rng.random() < 0.15:
        w, h = [(1, 1), (1, 4096), (4096, 1), (2, 3), (3, 5), (5, 3), (7, 9), (63, 65), (64, 64), (33, 17), (4, 4), (1, 7)][int(rng.integers(0, 12))]
    else:
        w = int(rng.integers(1, 65)); h = int(rng.integers(1, 4096 // w + 1)); h = min(h, 70)
    n = w * h
    lum = np.exp(rng.normal(rng.uniform(5, 8.5), rng.uniform(0.2, 2.2), n))
    tint = rng.uniform(0.3, 1.0, (2,))
    G = lum
    R = lum * tint[0] * rng.uniform(0.8, 1.2, n)
    B = lum * tint[1] * rng.uniform(0.8, 1.2, n)
    C = np.full(n, 1584)
    if kind == 1:                       # many zero-count blocks
        C = np.where(rng.random(n) < rng.uniform(0.0, 1.0), 0, rng.integers(1, 1585, n))
    elif kind == 2:                     # all clipped
        R = G = B = np.full(n, rng.integers(3000, 70000))
    elif kind == 3:                     # all black
        R = G = B = np.zeros(n)
    elif kind == 4:                     # garbage u32 anywhere
        m = rng.random(n) < 0.3
        R = np.where(m, rng.integers(0, 2 ** 32, n, dtype=np.uint64), R)
        G = np.where(rng.random(n) < 0.3, rng.integers(0, 2 ** 32, n, dtype=np.uint64), G)
        B = np.where(rng.random(n) < 0.3, rng.integers(0, 2 ** 32, n, dtype=np.uint64), B)
        C = np.where(rng.random(n) < 0.3, rng.integers(0, 2 ** 32, n, dtype=np.uint64), C)
    elif kind == 5:                     # a bright window in a dark scene
        R, G, B = R * 0.05, G * 0.05, B * 0.05
        m = rng.random(n) < 0.1
        R, G, B = np.where(m, R * 40, R), np.where(m, G * 40, G), np.where(m, B * 40, B)
    elif kind == 6:                     # a single count
        C = np.zeros(n, dtype=np.int64); C[int(rng.integers(0, n))] = 1
    elif kind == 7:                     # 16 bit boundary values
        R, G, B = (rng.choice([0, 1, 0xFFFE, 0xFFFF, 0x10000, 0x10001, 0x7FFFFFFF, 0xFFFFFFFF], n) for _ in range(3))
    f = lambda a: np.clip(np.asarray(a, dtype=np.float64), 0, 2 ** 32 - 1).astype(np.uint64) if np.asarray(a).dtype.kind == 'f' else np.asarray(a, dtype=np.uint64)
    return w, h, f(R), f(G), f(B), f(C)


def thr_pool(rng, k=300):
    pool = []
    for _ in range(k):
        w, h, R, G, B, C = scene(rng)
        F = ref.features(R, G, B, C, w, h, int(rng.integers(0, 2)), int(rng.integers(0, 97)), int(rng.integers(0, 4)))
        if F: pool.append(F)
    return pool


def rand_tree(rnd, pool, depth):
    if depth == 0 or rnd.random() < 0.2:
        return ('leaf', rnd.choice([rnd.randint(-3000, 3000), rnd.randint(-2 ** 31, 2 ** 31 - 1)]))
    f = rnd.randrange(ref.NF)
    thr = rnd.choice(pool)[f] + rnd.choice([-1, 0, 0, 1])
    return ('split', f, thr, rand_tree(rnd, pool, depth - 1), rand_tree(rnd, pool, depth - 1))


def rand_blob(rnd, pool):
    r = rnd.random()
    if r < 0.15:
        return ref.constant_blob(rnd.choice([0, 1, 256, 512, 0x800, 0x801, -1, -5, 5000, rnd.randint(-2 ** 31, 2 ** 31 - 1)]))
    if r < 0.25:
        return ref.placeholder_blob()
    trees = [rand_tree(rnd, pool, rnd.randint(0, 6)) for _ in range(rnd.choice([1, 2, 5, 20, 60]))]
    small = rnd.random() < 0.7
    mul = rnd.choice([65536, 32768, 1024, -65536, 3, 2 ** 31 - 1, -2 ** 31, rnd.randint(-100000, 100000)]) if not small else rnd.choice([65536, 32768, 8192])
    lo = rnd.choice([0, 0, -1, -100, 100, rnd.randint(-2 ** 31, 2 ** 31 - 1)])
    hi = rnd.choice([0x800, 0x800, 0x7FF, 300, 2 ** 31 - 1, rnd.randint(-2 ** 31, 2 ** 31 - 1)])
    if small:
        lo, hi = rnd.choice([(0, 0x800), (0, 0x400), (-1, 0x800)])
    return ref.build_blob(trees, mul=mul, off=rnd.choice([0, 0, 100, -100, rnd.randint(-2 ** 31, 2 ** 31 - 1)]) if not small else rnd.choice([0, 128, -64]), lo=lo, hi=hi)


def corrupt(rnd, blob):
    b = bytearray(blob)
    kind = rnd.randrange(7)
    if kind == 0 and len(b):                       # flip random bytes
        for _ in range(rnd.randint(1, 6)): b[rnd.randrange(len(b))] = rnd.randrange(256)
    elif kind == 1:                                 # truncate
        b = b[:rnd.randrange(0, len(b) + 1)]
    elif kind == 2:                                 # extend with garbage
        b += bytes(rnd.randrange(256) for _ in range(rnd.randint(1, 40)))
    elif kind == 3 and len(b) >= 40:                # a header word
        struct.pack_into('<I', b, 4 * rnd.randrange(10), rnd.choice([0, 1, 2, 27, 28, 255, 256, 65535, 65536, 65537, 4096, 4097, 2 ** 32 - 1, rnd.getrandbits(32)]))
    elif kind == 4 and len(b) > 48:                 # a node: feat / child
        i = rnd.randrange(40 + 4 * struct.unpack_from('<I', b, 12)[0], len(b) - 7) & ~3
        b[i + 4] = rnd.choice([0, 26, 27, 254, 255]); struct.pack_into('<H', b, i + 6, rnd.choice([0, 1, 2, 65534, 65535, rnd.getrandbits(16)]))
    elif kind == 5 and len(b) > 44:                 # a root
        struct.pack_into('<I', b, 40 + 4 * rnd.randrange(min(5, struct.unpack_from('<I', b, 12)[0] or 1)) if struct.unpack_from('<I', b, 12)[0] else 40, rnd.choice([0, 1, 65535, 2 ** 32 - 1]))
    else:                                           # all random after the magic
        b = b[:4] + bytes(rnd.randrange(256) for _ in range(len(b) - 4))
    return bytes(b)


def loop_blob():
    """a tree whose child is itself: the depth limit must stop it (-1)"""
    b = bytearray(ref.build_blob([('split', 0, 0, ('leaf', 0), ('leaf', 1))]))
    struct.pack_into('<H', b, 40 + 4 + 6, 0)       # node 0's child -> 0 (nodes 0 and 1 are its own pair)
    return bytes(b)


def dng_scenes():
    out = []
    d_ = os.environ.get('SHADOWML_DNG')
    try:
        from dngload import load405
    except ImportError:
        load405 = None
    if not d_ or not Path(d_).is_dir() or load405 is None:
        print('no $SHADOWML_DNG folder (or no dngload on the path): the real-photo scenes are skipped')
        return out
    for g in [str(Path(d_) / '*.dng'), str(Path(d_) / '*.DNG')]:
        for f in sorted(glob.glob(g)):
            d = load405(f)
            w, h = d['w'], d['h']
            n = w * h
            out.append((os.path.basename(f), w, h, d['R'].ravel()[:n], d['G'].ravel()[:n], d['B'].ravel()[:n], d['C'].ravel()[:n]))
    return out


# ---------------------------------------------------------------------------------------------------------------- driver
class Stats:
    def __init__(self): self.n = 0; self.bad = []; self.neg = 0; self.pos = 0; self.zero = 0; self.feat = 0; self.unchanged = 0

    def check(self, lib, tag, P, blob, mode, hl, idx, magic=ref.MAGIC):
        r, same, F = lib.run(P, blob, mode, hl, idx, magic)
        t = ref.shadowml_ref(blob, P, mode, hl, idx, magic_ok=(magic == ref.MAGIC))
        pl = ref.planes_of(P, mode)
        Fr = ref.features(*pl, hl, idx, mode) if pl is not None else None     # the features are compared whatever the blob
        self.n += 1
        self.unchanged += same
        self.neg += r < 0; self.zero += r == 0; self.pos += r > 0
        # the feature vector is only defined (and compared) when the call got that far; the C side's F is for the usable grid
        if F is not None:
            self.feat += 1
        if r != t or not same or (Fr is not None and F != Fr) or (Fr is None and F is not None):
            self.bad.append((tag, r, t, same, mode, hl, idx, (F, Fr) if F != Fr else None))


def run_lib(name, lib, dngs, n_random, seed):
    st = Stats()
    rnd = random.Random(seed)
    rng = np.random.default_rng(seed)
    t0 = time.time()
    pool = thr_pool(rng)
    models = [open(os.environ.get('SHADOWML_MODEL') or str(Path(__file__).resolve().parent / 'model' / 'model_final.bin'), 'rb').read(), ref.placeholder_blob(), ref.constant_blob(300), ref.constant_blob(0), ref.constant_blob(-1), ref.constant_blob(0x900)] + [rand_blob(rnd, pool) for _ in range(12)]
    # 1. the DNGs: both paths (the same planes placed at the still and at the live-view offsets), hl 0 and 1, several models
    for fn, w, h, R, G, B, C in dngs:
        for mode in (0, 1, 2, 3):
            for hl in (0, 1):
                P = make_P(mode, w, h, R, G, B, C, rng)
                for blob in rnd.sample(models, 4) + [models[0]]:
                    st.check(lib, 'dng ' + fn, P, blob, mode, hl, rnd.choice([0, 20, 40, 96, 97, 200]))
    n_dng = st.n
    # 2. edge cases
    edge = []
    for kind in (2, 3, 6, 7):
        for _ in range(6): edge.append(scene(rng, kind))
    edge += [scene(rng, 1) for _ in range(8)]
    n1 = 5
    for w, h in ((1, 1), (1, 2), (2, 1), (2, 2), (3, 3), (4, 4), (5, 5), (4096, 1), (1, 4096), (64, 64), (64, 62), (63, 62), (65, 62)):
        n = w * h
        for fill in (0, 1, 2):
            C = np.full(n, 1584 if fill < 2 else 0)
            v = np.full(n, [100, 4000, 0][fill])
            edge.append((w, h, v, v, v, C))
    for w, h, R, G, B, C in edge:
        for mode in (0, 1):
            for hl in (0, 1):
                P = make_P(mode, w, h, R, G, B, C, rng)
                for blob in models[:7]:
                    st.check(lib, f'edge {w}x{h}', P, blob, mode, hl, 40)
    # invalid grids: no plane read may happen (P is exactly as long as the dimension fields)
    for mode in (0, 1, 2, 3, 9):
        for dims in ((0, 0), (0, 5), (5, 0), (64, 65), (4097, 1), (65535, 65535), (1, 4097), (256, 17), (257, 16)):
            P = make_P(mode, 1, 1, [1], [1], [1], [1], rng, dims=dims)
            st.check(lib, f'dims {dims}', P, models[0], mode, 0, 10)
    n_edge = st.n - n_dng
    # 3. random scenes with random models and arguments
    for i in range(n_random):
        w, h, R, G, B, C = scene(rng)
        mode = rnd.choice([0, 0, 1, 2, 3, 3, 4, 255, 2 ** 32 - 1, 2 ** 31])
        hl = rnd.choice([0, 1, 1, 2, 255, 2 ** 32 - 1])
        idx = rnd.choice([0, 1, 40, 95, 96, 97, 255, 100000, 2 ** 32 - 1, rnd.randrange(100)])
        P = make_P(mode, w, h, R, G, B, C, rng)
        r = rnd.random()
        if r < 0.55: blob = rnd.choice(models)
        elif r < 0.85: blob = rand_blob(rnd, pool)
        elif r < 0.97: blob = corrupt(rnd, rnd.choice(models))
        else: blob = loop_blob()
        st.check(lib, f'rnd {i}', P, blob, mode, hl, idx, magic=ref.MAGIC if rnd.random() < 0.98 else rnd.getrandbits(32))
    # 3b. sequences with the throttling state: live view / movie calls (period 1..70) mixed with stills; garbage as the initial state
    seqbad = ncalls = 0
    for q in range(max(20, n_random // 40)):
        period = rnd.choice([0, 1, 2, 4, 4, 4, 8, 64, 65, 1000])
        init = rnd.choice([0, 0, rnd.getrandbits(32), 0x00000103, 0x00080003, period | 0x500, 0xFFFFFFFF, 0x00100002, 0x00082001, 0x00080100 | 3, 0x00000001])
        blob = rnd.choice(models[:8])
        cstate = (ctypes.c_uint * 1)(init)
        seq = ref.Seq(blob, period, init)
        scs = [scene(rng) for _ in range(4)]
        for step in range(rnd.randrange(8, 40)):
            w, h, R, G, B, C = rnd.choice(scs)
            mode = rnd.choice([1, 1, 1, 2, 0, 3])
            hl = rnd.randrange(2); idx = rnd.randrange(97)
            P = make_P(mode, w, h, R, G, B, C, rng)
            r, same, _F = lib.run(P, blob, mode, hl, idx, period=period, state=cstate)
            t = seq.call(P, mode, hl, idx)
            ncalls += 1; st.unchanged += same
            if r != t or not same or cstate[0] != seq.state:
                seqbad += 1; st.bad.append(('seq', q, step, mode, period, r, t, cstate[0], seq.state))
        # a still never touches the state, a missing state pointer never throttles
    st.n += ncalls
    # 4. fixed adversarial blobs
    P = make_P(0, 64, 62, *scene(rng, 0)[2:], rng) if False else None
    w, h, R, G, B, C = 64, 62, *scene(rng, 0)[2:]
    R, G, B, C = (np.resize(a, w * h) for a in (R, G, B, C))
    P = make_P(0, w, h, R, G, B, C, rng)
    for blob in (loop_blob(), b'', b'SHMB', bytes(40), models[0][:67], models[0] + b'\1\2\3', bytes(rnd.randrange(256) for _ in range(500))):
        st.check(lib, 'fixed blob', P, blob, 0, 0, 10)
    # 5. the scratch: one allocation, kept; a failed allocation gives -1 (and is retried); the two halves are disjoint
    SCR = 776
    w, h, R, G, B, C = scene(rng, 0)
    PS, PL = make_P(0, w, h, R, G, B, C, rng), make_P(1, w, h, R, G, B, C, rng)
    blob = models[0]
    lib.lib.host_cfg(1, 1)
    ok = lib.run(PS, blob, 0, 0, 40)[0] == -1 and lib.run(PL, blob, 1, 0, 40)[0] == -1 and lib.lib.host_slot() == 0 and lib.lib.host_allocs() == 2
    lib.lib.host_cfg(0, 0)
    r1 = lib.run(PS, blob, 0, 0, 40)[0]
    ok &= r1 == ref.shadowml_ref(blob, bytes(PS), 0, 0, 40) and lib.lib.host_allocs() == 3 and lib.lib.host_slot() != 0
    half0 = ctypes.string_at(lib.lib.host_slot(), SCR)
    r2 = lib.run(PL, blob, 1, 0, 40)[0]
    ok &= r2 == ref.shadowml_ref(blob, bytes(PL), 1, 0, 40) and lib.lib.host_allocs() == 3          # no second allocation
    ok &= ctypes.string_at(lib.lib.host_slot(), SCR) == half0                                       # live view left the still half alone
    half1 = ctypes.string_at(lib.lib.host_slot() + SCR, SCR)
    lib.run(PS, blob, 3, 1, 12)
    ok &= ctypes.string_at(lib.lib.host_slot() + SCR, SCR) == half1                                 # a still left the live-view half alone
    # a bad blob never allocates
    lib.lib.host_cfg(0, 1)
    ok &= lib.run(PS, b'', 0, 0, 40)[0] == -1 and lib.lib.host_allocs() == 0
    lib.lib.host_cfg(0, 1)
    if not ok:
        st.bad.append(('scratch', r1, r2));
    print(f'{name}: {st.n} calls ({n_dng} DNG, {n_edge} edge, {n_random} random + fixed); results t<0: {st.neg}, t=0: {st.zero}, t>0: {st.pos}; '
          f'feature vectors compared {st.feat}; record unchanged {st.unchanged}/{st.n}; mismatches {len(st.bad)} ({time.time() - t0:.0f} s)', flush=True)
    for b in st.bad[:8]: print('MISMATCH', b)
    return len(st.bad)


def main():
    # the sanitizer build needs libasan loaded first: it runs in a child process of this script
    if os.environ.get('SHADOWML_SAN_CHILD'):
        dngs = dng_scenes()
        with tempfile.TemporaryDirectory() as t:
            sys.exit(1 if run_lib('x86 UBSan+ASan', Lib(build_libs(t)['san']), dngs, NSAN, 2) else 0)
    dngs = dng_scenes()
    print(f'{len(dngs)} DNG scenes')
    bad = 0
    with tempfile.TemporaryDirectory() as t:
        libs = build_libs(t)
        bad += run_lib('x86 -O2', Lib(libs['o2']), dngs, NRANDOM, 1)
    env = dict(os.environ, SHADOWML_SAN_CHILD='1', ASAN_OPTIONS='detect_leaks=0:abort_on_error=0')
    if sys.platform == 'darwin':
        asan = os.environ.get('GRMOD_ASAN_LIB') or subprocess.run(
            ['clang', '-print-file-name=libclang_rt.asan_osx_dynamic.dylib'], capture_output=True, text=True, check=True).stdout.strip()
        env.pop('LD_PRELOAD', None)
        env['DYLD_INSERT_LIBRARIES'] = asan
    else:
        env['LD_PRELOAD'] = subprocess.run(['gcc', '-print-file-name=libasan.so'], capture_output=True, text=True, check=True).stdout.strip()
    bad += subprocess.run([sys.executable, __file__], env=env).returncode != 0
    print('RESULT', 'FAIL' if bad else 'all passed')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
