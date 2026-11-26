# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of GR III / IIIx's learned Auto for Shadow Correction (core/src/fw/gr3x/shadowml.ts).

    python3 tools/gr3extras/shadow_check.py RELEASE OFFICIAL.rtos WITHOUT.rtos BUILT.rtos

RELEASE is 2.10, 2.20 or 2.21 (GR IIIx 1.60 / 1.70 / 1.71 are the same programs); OFFICIAL.rtos the official decoded RTOS,
BUILT.rtos a build with shadowLearn and WITHOUT.rtos the same build without it (tools/testfw/build-gr3.ts writes them).
Development tool, not part of the program. Needs unicorn and numpy; uses GR IV's reference (tools/gr4v120/shadowml/ref.py)
with GR III's offsets of the statistics.

Runs the camera's own shadow-correction core (ToneControlTuning) as its caller does (this, this + 0x14, the output, the
settings S, &level; this[0x820] = 1), with the Y-array builder skipped (the statistics are given in the record P) and operator
new as a bump allocator, and compares everything the core leaves behind: its return value, the level, the object, the output
table, the curve, S, P, the RAM (all of 0x55000000..0x55900000, which holds the live-view smoothing state; the module's own
RAM word apart), r4-r11 and sp.
  1. Every setting but Auto (Low, Medium, High, Off and out-of-range values), every mode, hl, forced-zero bytes, ISO indexes:
     the built image is the official image (and the build without), and never enters the hook word or the module.
  2. Auto with a forced-zero byte (S+0x8A / 0x8B): the built image is the build without (the camera's zero path).
  3. Auto, stills (mode 0, 3), live view and movie (1, 2): the built image against the build without whose hook word is
     replaced, in the emulator, by the reference: t = ref.py's model output for GR III's planes, then the camera's common code
     with r3 = t, r7 = 1 (or its zero path for t < 0), with Auto's gain 0x400 as the build has it. Synthetic statistics (GR IV's
     test generator: 64 x 62 and odd grids, dark, clipped, empty, garbage), the embedded model and constant models (t = 0, 300,
     0x800, -1) so that every level is reached. The module is entered with ctx, P, mode, hl in r0-r3, idx on an 8-aligned stack.
  4. Live-view sequences (throttled: the module computes on every 4th call), with the camera's five-frame smoothing, against the
     reference sequence; stills in between do not disturb it.
  5. A failing operator new: the camera's no-correction result, the RAM word stays 0, the next call allocates (1560 bytes).
  6. The built image against the build without: inside the official image only the hook word and Auto's gain differ; the
     appended model is GR IV's model_final.bin; the context names it, the operator new and the RAM word.
"""
import hashlib
import random
import struct
import sys
from pathlib import Path

import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import *

REPO = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(REPO / 'tools/gr4v120/shadowml')]
import ref  # noqa: E402
import test_host as TH  # noqa: E402

# GR III's statistics structures in P (shadowml.c): stills at P+0xB80, live view / movie at P+0x39270.
for o, base in ((ref.STILL, 0xB80), (ref.LV, 0x39270)):
    o.update(R=base + 0x14018, G=base + 0x18018, B=base + 0x20018, C=base + 0x26018, W=base, H=base + 2)
LV_RAW = 0x39270 + 0x1400C           # the live view's raw-statistics pointer: the core gives no correction when it is 0
Y_STILL, Y_LV = 0xB80 + 0x24018, 0x39270 + 0x24018   # the Y arrays the camera's own Auto reads

A = {  # core, hook, common join, zero path, Y-array builder, operator new, gain table, RAM word, RAM image (source, length)
    '2.10': (0x536e9558, 0x536e96c4, 0x536e97f8, 0x536e9ad4, 0x536c2a30, 0x536af2a8, 0x53dc22d8, 0x5580439c, 0x5407b540, 0x3a080),
    '2.20': (0x536e9530, 0x536e969c, 0x536e97d0, 0x536e9aac, 0x536c2a08, 0x536af398, 0x53dc2410, 0x55803c5c, 0x5407b640, 0x3a0c0),
    '2.21': (0x536ed798, 0x536ed904, 0x536eda38, 0x536edd14, 0x536c5fd0, 0x536b2880, 0x53dcaed0, 0x55803f1c, 0x54084640, 0x3a300),
}
rel, official, without, built = sys.argv[1:5]
CORE, HOOK, COMMON, ZERO, BUILDER, ALLOC, GAINS, WORD, RSRC, RLEN = A[rel]
BASE, RAM, RAMSIZE = 0x53000000, 0x55000000, 0x900000
OFF, WO, IMG = (open(f, 'rb').read() for f in (official, without, built))
S, P, THIS, OUT, CURVE, LVL, HEAP, MODEL = 0x60000000, 0x60100000, 0x60800000, 0x60810000, 0x60820000, 0x60830000, 0x61000000, 0x60700000
P_SIZE = 0x70000
STACK, RET = 0x7e100000, 0x7e000010
PERIOD, BLOCK = 4, 2 * 776 + 8


def w32(image, at): return struct.unpack_from('<I', image, at - BASE)[0]
def b_target(image, at):
    x = w32(image, at); imm = x & 0xffffff
    return at + 8 + 4 * (imm - (1 << 24) if imm & 0x800000 else imm)
def dec(x): return ((x >> 4) & 0xF000) | (x & 0xFFF)


bad = []
def check(ok, *what):
    if not ok: bad.append(what)
    return ok


class Core:
    """One emulator of an image. feed: a function (P bytes, mode, hl, idx) -> t that replaces the hook word (the reference)."""

    def __init__(self, image, feed=None):
        self.image = image
        mu = self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(image) + 0xfffff) & ~0xfffff); mu.mem_write(BASE, image)
        mu.mem_map(RAM, RAMSIZE); mu.mem_write(RAM, image[RSRC - BASE:RSRC - BASE + RLEN])
        mu.mem_map(0x60000000, 0x02000000); mu.mem_map(0x7e000000, 0x00200000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.heap = HEAP; self.allocs = []; self.fail_alloc = False; self.entries = []; self.hits = set(); self.feed = feed; self.last_t = None
        def leave(uc, r0):
            uc.reg_write(UC_ARM_REG_R0, r0); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, u: leave(uc, 0), begin=BUILDER, end=BUILDER)   # the planes are given
        def on_alloc(uc, a, s, u):
            n = uc.reg_read(UC_ARM_REG_R0); self.allocs.append(n)
            if self.fail_alloc: leave(uc, 0); return
            at = self.heap; self.heap += (n + 15) & ~15; leave(uc, at)
        mu.hook_add(UC_HOOK_CODE, on_alloc, begin=ALLOC, end=ALLOC)
        mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, u: self.hits.add('hook'), begin=HOOK, end=HOOK)
        self.stub = self.code = self.ctx = None
        if w32(image, HOOK) >> 24 == 0xEA and b_target(image, HOOK) >= BASE + len(OFF):
            self.stub = b_target(image, HOOK)
            self.ctx = (dec(w32(image, self.stub + 36)) << 16) | dec(w32(image, self.stub + 32))
            self.code = b_target(image, self.stub + 52)
            def on_entry(uc, a, s, u):
                sp = uc.reg_read(UC_ARM_REG_SP)
                self.entries.append((sp, [uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)],
                                     struct.unpack('<I', bytes(uc.mem_read(sp, 4)))[0]))
            mu.hook_add(UC_HOOK_CODE, on_entry, begin=self.code, end=self.code)
        if feed is not None:
            mu.mem_write(GAINS + 8, struct.pack('<H', 0x400))      # the build's Auto gain
            mu.hook_add(UC_HOOK_CODE, self._inject, begin=HOOK, end=HOOK)
        def unmapped(uc, access, address, size, value, u):
            bad.append(('unmapped access', hex(address), hex(uc.reg_read(UC_ARM_REG_PC)))); return False
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, unmapped)

    def _inject(self, uc, a, s, u):
        rb = lambda at, n: bytes(uc.mem_read(at, n))
        sb_, p_, fp = uc.reg_read(UC_ARM_REG_R8), uc.reg_read(UC_ARM_REG_R9), uc.reg_read(UC_ARM_REG_R11)
        forced = rb(sb_ + 0x8A, 1)[0] | rb(sb_ + 0x8B, 1)[0]
        mode, hl, idx = rb(sb_ + 0x8D, 1)[0], struct.unpack('<I', rb(fp - 0x43C, 4))[0], uc.reg_read(UC_ARM_REG_R7)
        self.fed_args = (p_, mode, hl, idx)
        t = None if forced else self.feed(rb(p_, P_SIZE), mode, hl, idx)
        self.last_t = t
        if forced or t < 0: uc.reg_write(UC_ARM_REG_PC, ZERO)
        else: uc.reg_write(UC_ARM_REG_R3, t); uc.reg_write(UC_ARM_REG_R7, 1); uc.reg_write(UC_ARM_REG_PC, COMMON)

    def set_model(self, blob):
        self.mu.mem_write(MODEL, bytes(blob)); self.mu.mem_write(self.ctx + 4, struct.pack('<II', MODEL, len(blob)))

    def run(self, Pb, setting, hl, idx, mode, b8a=0, b8b=0, lv_flag=1, reset=True):
        mu = self.mu
        if reset:
            mu.mem_write(THIS, bytes(0x900)); mu.mem_write(OUT, bytes(0x2000)); mu.mem_write(CURVE, bytes(0x800)); mu.mem_write(LVL, bytes(8))
            mu.mem_write(CURVE, bytes(random.Random(5).randrange(256) for _ in range(0x800)))
        mu.mem_write(S, bytes(0x200)); mu.mem_write(P, bytes(Pb))
        mu.mem_write(P + LV_RAW, struct.pack('<I', lv_flag))
        mu.mem_write(S + 0x130, struct.pack('<I', P)); mu.mem_write(S + 0x44, struct.pack('<H', idx))
        for k, v in ((0x53, hl), (0x54, setting), (0x8D, mode), (0x8A, b8a), (0x8B, b8b)): mu.mem_write(S + k, bytes([v]))
        mu.mem_write(THIS + 0x81C, struct.pack('<I', OUT)); mu.mem_write(THIS + 0x828, struct.pack('<I', CURVE)); mu.mem_write(THIS + 0x820, b'\1')
        self.entries = []; self.hits = set(); self.last_t = None
        saved = {UC_ARM_REG_R4: 0x44444444, UC_ARM_REG_R5: 0x55555555, UC_ARM_REG_R6: 0x66666666, UC_ARM_REG_R7: 0x77777777,
                 UC_ARM_REG_R8: 0x88888888, UC_ARM_REG_R9: 0x99999999, UC_ARM_REG_R10: 0xaaaaaaaa, UC_ARM_REG_R11: 0xbbbbbbbb, UC_ARM_REG_SP: STACK - 0x2000}
        for k, v in saved.items(): mu.reg_write(k, v)
        mu.mem_write(STACK - 0x2000, struct.pack('<I', LVL))
        for r, v in ((UC_ARM_REG_R0, THIS), (UC_ARM_REG_R1, THIS + 0x14), (UC_ARM_REG_R2, OUT), (UC_ARM_REG_R3, S), (UC_ARM_REG_LR, RET)): mu.reg_write(r, v)
        mu.emu_start(CORE, RET, count=30_000_000)
        check(mu.reg_read(UC_ARM_REG_PC) == RET, 'the core did not return', hex(mu.reg_read(UC_ARM_REG_PC)))
        check(all(mu.reg_read(k) == v for k, v in saved.items()), 'r4-r11 / sp not restored')
        return mu.reg_read(UC_ARM_REG_R0)

    def state(self):
        rb = lambda at, n: bytes(self.mu.mem_read(at, n))
        ram = bytearray(rb(RAM, RAMSIZE)); o = WORD - RAM; ram[o:o + 4] = bytes(4)
        return dict(level=struct.unpack('<H', rb(LVL, 2))[0], this=rb(THIS, 0x900), out=rb(OUT, 0x2000), curve=rb(CURVE, 0x800),
                    lvl=rb(LVL, 8), s=rb(S, 0x200), p=hashlib.sha256(rb(P, P_SIZE)).digest(), ram=hashlib.sha256(bytes(ram)).digest())

    def word(self): return struct.unpack('<I', bytes(self.mu.mem_read(WORD, 4)))[0]


def sync(dst, src):
    """the RAM of `src` (the camera's live-view smoothing state) into `dst`, so that both start a comparison alike"""
    dst.mu.mem_write(RAM, bytes(src.mu.mem_read(RAM, RAMSIZE)))


def diff(a, b): return [k for k in a if a[k] != b[k]]
def P_of(mode, w, h, R, G, B, C, rng):
    Pb = bytearray(TH.make_P(mode, w, h, R, G, B, C, rng)); Pb += bytes(P_SIZE - len(Pb))
    # the camera's own Auto reads the Y arrays: give them plausible values (only the official / without runs use them)
    for y in (Y_STILL, Y_LV): Pb[y:y + 0x2000] = rng.integers(0, 0x240, 0x1000, dtype='<u2').tobytes()
    return bytes(Pb)


rng = np.random.default_rng(37); rnd = random.Random(37)
off, wo, img = Core(OFF), Core(WO), Core(IMG)
check(img.ctx is not None, 'the hook word is not a branch into the appended code')
scenes = [TH.scene(rng) for _ in range(60)]

# ---- 1. every setting but Auto: the official code, untouched
n1 = 0
for k, (w, h, R, G, B, C) in enumerate(scenes[:36]):
    for setting in (1, 2, 3, 4, 7, 255):
        mode = k % 4; Pb = P_of(mode, w, h, R, G, B, C, rng)
        hl, idx, f = k % 2, rnd.choice([0, 30, 80, 85, 96, 200]), rnd.choice([(0, 0), (0, 0), (1, 0), (0, 1)])
        rs = [c.run(Pb, setting, hl, idx, mode, *f) for c in (off, wo, img)]
        st = [c.state() for c in (off, wo, img)]
        check(rs[0] == rs[1] == rs[2] and not diff(st[0], st[2]) and not diff(st[1], st[2]), 'fixed setting', setting, mode, hl, idx, f, rs, diff(st[0], st[2]))
        check(not img.hits and not img.entries, 'fixed setting reached the hook', setting, mode)
        n1 += 1
print(f'1. settings Low / Medium / High / Off / out of range: {n1} calls, built = official = without: {"ok" if not bad else "FAILED"}', flush=True)

# ---- 2. Auto with a forced-zero byte
nb = len(bad)
for k in range(16):
    w, h, R, G, B, C = scenes[k]; mode = k % 4; Pb = P_of(mode, w, h, R, G, B, C, rng)
    f = [(1, 0), (0, 1), (1, 1), (7, 0)][k % 4]
    rs = [c.run(Pb, 0, k % 2, 40, mode, *f) for c in (wo, img)]
    st = [c.state() for c in (wo, img)]
    check(rs[0] == rs[1] and not diff(st[0], st[1]), 'forced zero', mode, f, diff(st[0], st[1]))
    check(not img.entries, 'forced zero entered the module')
print(f'2. Auto with S+0x8A / S+0x8B set: 16 calls, built = without (the zero path), module not entered: {"ok" if len(bad) == nb else "FAILED"}', flush=True)

# ---- 3. Auto: built against the reference
nb = len(bad)
model = bytes(img.mu.mem_read(w32(IMG, img.ctx + 4), w32(IMG, img.ctx + 8)))
check(ref.parse_blob(model) is not None, 'the image carries no valid model')
models = [model] * 3 + [ref.constant_blob(0), ref.constant_blob(300), ref.constant_blob(0x800), ref.build_blob([], off=-1, lo=-1)]
cur = {'blob': model}
fed = Core(WO, feed=lambda Pb, mode, hl, idx: ref.shadowml_ref(cur['blob'], Pb, mode, hl, idx))
sync(fed, img)
cnt = dict(calls=0, neg=0, zero=0, pos=0, levels=set(), lv=0)
for k in range(150):
    w, h, R, G, B, C = scenes[k % len(scenes)] if k < 60 else TH.scene(rng)
    mode = rnd.choice([0, 0, 3, 1, 2]); Pb = P_of(mode, w, h, R, G, B, C, rng)
    hl, idx = rnd.randrange(2), rnd.choice([0, 10, 25, 40, 60, 80, 84, 88, 95, 96, 97, 300])
    cur['blob'] = models[k % len(models)]; img.set_model(cur['blob'])
    blk = img.word()
    if blk: img.mu.mem_write(blk + 2 * 776, bytes(4))      # a fresh throttling state: every live-view call computes
    allocs0 = len(img.allocs)
    ri, rf = img.run(Pb, 0, hl, idx, mode), fed.run(Pb, 0, hl, idx, mode)
    si, sf = img.state(), fed.state()
    t = fed.last_t
    check(ri == rf and not diff(si, sf), 'auto', k, mode, hl, idx, t, ri, rf, diff(si, sf))
    check(len(img.entries) == 1, 'module entries', len(img.entries))
    for sp, r, a5 in img.entries:
        check(sp % 8 == 0 and r == [img.ctx, P, mode, hl] and a5 == min(idx, 0x60), 'call arguments', hex(sp), [hex(x) for x in r], a5)
    check(img.allocs[allocs0:] == ([BLOCK] if not blk else []), 'operator new', img.allocs[allocs0:])
    cnt['calls'] += 1; cnt['neg'] += t < 0; cnt['zero'] += t == 0; cnt['pos'] += t > 0; cnt['levels'].add(sf['level']); cnt['lv'] += mode in (1, 2)
print(f'3. Auto, built vs the build without fed with ref.py: {cnt["calls"]} calls ({cnt["lv"]} live view / movie); t<0 {cnt["neg"]}, '
      f't=0 {cnt["zero"]}, t>0 {cnt["pos"]}; levels {sorted(cnt["levels"])}: {"ok" if len(bad) == nb else "FAILED"}', flush=True)

# ---- 4. live-view sequences (throttled) with the camera's smoothing; a still in between
nb = len(bad)
img.set_model(model); cur['blob'] = model
for seq in range(3):
    blk = img.word(); img.mu.mem_write(blk + 2 * 776, bytes(4))
    rs = ref.Seq(model, PERIOD)
    fed.feed = lambda Pb, mode, hl, idx: rs.call(Pb, mode, hl, idx)
    first = True
    for fr in range(14):
        still = fr == 6
        mode = 0 if still else 1 + seq % 2
        w, h, R, G, B, C = TH.scene(rng, kind=0)
        Pb = P_of(mode, w, h, R, G, B, C, rng)
        ri, rf = img.run(Pb, 0, seq % 2, 40, mode, reset=first), fed.run(Pb, 0, seq % 2, 40, mode, reset=first)
        first = False
        si, sf = img.state(), fed.state()
        check(ri == rf and not diff(si, sf), 'live-view sequence', seq, fr, diff(si, sf))
fed.feed = lambda Pb, mode, hl, idx: ref.shadowml_ref(cur['blob'], Pb, mode, hl, idx)
print(f'4. live-view / movie sequences of 14 frames (throttled every {PERIOD}, the camera\'s smoothing, a still in between): {"ok" if len(bad) == nb else "FAILED"}', flush=True)

# ---- 5. a failing operator new
nb = len(bad)
c = Core(IMG); c.fail_alloc = True
w, h, R, G, B, C = TH.scene(rng, kind=0); Pb = P_of(0, w, h, R, G, B, C, rng)
fed.feed = lambda *a: -1
sync(fed, c)
ra, rb_ = c.run(Pb, 0, 0, 40, 0), fed.run(Pb, 0, 0, 40, 0)
check(c.allocs == [BLOCK] and c.word() == 0 and ra == rb_ and not diff(c.state(), fed.state()), 'failed allocation')
c.fail_alloc = False
fed.feed = lambda Pb, mode, hl, idx: ref.shadowml_ref(model, Pb, mode, hl, idx)
ra, rb_ = c.run(Pb, 0, 0, 40, 0), fed.run(Pb, 0, 0, 40, 0)
check(c.allocs == [BLOCK, BLOCK] and c.word() == HEAP and ra == rb_ and not diff(c.state(), fed.state()), 'retry after a failed allocation')
print(f'5. operator new fails: no correction, the RAM word stays 0, the next call allocates {BLOCK} bytes: {"ok" if len(bad) == nb else "FAILED"}', flush=True)

# ---- 6. the image
nb = len(bad)
changed = [BASE + i for i in range(0, len(OFF), 4) if WO[i:i + 4] != IMG[i:i + 4]]
def moved(at):   # a branch into the appended area whose target only moved (code appended after this addition's)
    x, y = w32(WO, at), w32(IMG, at)
    return x >> 24 == y >> 24 and (x >> 25) & 7 == 5 and min(b_target(WO, at), b_target(IMG, at)) >= BASE + len(OFF)
changed = [a for a in changed if not moved(a)]
check(sorted(changed) == sorted([HOOK, GAINS + 8]), 'words changed inside the official image', [hex(a) for a in changed])
check(w32(OFF, HOOK) == 0xE51B2454 and w32(OFF, GAINS + 8) == 0x100 and w32(IMG, GAINS + 8) == 0x400, 'hook / gain words')
final = (REPO / 'tools/gr4v120/shadowml/model/model_final.bin').read_bytes()
check(model == final, 'the embedded model is not model_final.bin')
ctxw = struct.unpack_from('<6I', IMG, img.ctx - BASE)
check(ctxw == (ref.MAGIC, ctxw[1], len(final), PERIOD, ALLOC, WORD), 'context', [hex(x) for x in ctxw])
check(w32(OFF, ALLOC) == 0xE1A0C00D and w32(OFF, ALLOC + 12) == 0xE1A05000, 'operator new')
print(f'6. image: inside the official image only the hook word and Auto\'s gain differ from the build without; model = model_final.bin '
      f'(sha256 {hashlib.sha256(final).hexdigest()[:16]}..); context: {"ok" if len(bad) == nb else "FAILED"}')

for b in bad[:20]: print('  FAIL', b)
print(rel, 'ok' if not bad else f'FAILED ({len(bad)})')
sys.exit(1 if bad else 0)
