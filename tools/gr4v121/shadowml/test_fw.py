# SPDX-License-Identifier: GPL-2.0-only
"""Runs the built firmware's RTOS (with shadowLearn) in the unicorn emulator, calling the shadow-correction core 0x539487f8 as the
camera does, against the same firmware without it (the base RTOS) and against ref.py:

  1. Auto, stills (mode 0 and 3), live view and movie (mode 1, 2): strength, level, gain table, 8-bit LUT, return value and every
     other byte of the core's state equal those of the stock code (base RTOS) fed with t from ref.py: a unicorn hook at the hook
     word jumps to the common code with r3 = t, r7 = 1 (or to the stock zero path for t < 0 / the forced-zero bytes).
     Inputs: the DNG planes (hl 0 / 1, many ISO indexes), random scenes, random models in the model slot.
  2. Live-view sequences: the throttled results (period 4) and the camera's five-frame smoothing against the reference model of
     both; stills in between never disturb the live-view state.
  3. Fixed levels (Low / Medium / High / Off) and the forced-zero bytes: identical to the base RTOS without any injection.
  4. The stub's calls: the module is entered with an 8-byte aligned stack, idx as the fifth argument, ctx / P / mode / hl in
     r0-r3; the operator new is never called; the registers r4-r11 are preserved.
  5. Instruction counts of the core with and without the hook.
  6. The image against the build without shadowLearn: only the hook word, TB[4], the zero-fill literal and the appended
     area (zero padding in the other build) differ before its record.

usage: test_fw.py PRE.rtos BASE.rtos   (needs unicorn, numpy, gcc for test_host's C build)
  PRE.rtos: the decoded RTOS of a build with shadowLearn, BASE.rtos: the same build without it (tools/testfw/build.ts writes
  the decoded RTOS next to a test build). Optional real-photo scenes: see test_host.py."""
import os
import random
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE)]
if len(sys.argv) < 3:
    sys.exit(__doc__)
PRE, BASE = sys.argv[1], sys.argv[2]

import numpy as np
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_PC, UC_ARM_REG_R0, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R7, UC_ARM_REG_R9, UC_ARM_REG_R11, UC_ARM_REG_SP

import fwemu
import ref
import test_host as TH

F_CORE, HOOK, COMMON, ZERO_PATH, ALLOC, GAIN = 0x539487f8, 0x5394896C, 0x53948AA0, 0x53948d4c, 0x53909154, 0x54081834
SB, PREC, THIS, OUTB, CURVE, LVL, MODEL = 0x60000000, 0x60100000, 0x60800000, 0x60810000, 0x60820000, 0x60830000, 0x60700000
P_SIZE = 0x70000
RAMSTATE = (0x553A2838, 0x40)       # the live-view smoothing state of the core (flag, position, ring)
SLOT = 0x5583903C
SCRATCH_SLOT = 0x55839014
PERIOD = 4
TB4_STOCK_FIX = 0x400               # the base RTOS has the old Auto gain; the injected runs patch it, as the build does


def word(buf, addr): return struct.unpack_from('<I', buf, addr - 0x53000000)[0]


class Core:
    """One emulator of the core. inject: None (run the image as it is) or a ModelFeeder (the base RTOS fed with t)."""

    def __init__(self, rtos, feeder=None, hooked=None, realy=False):
        fwemu.RTOS = rtos
        self.e = e = fwemu.Emu()
        self.mu = e.mu
        self.rtos = open(rtos, 'rb').read()
        self.feeder = feeder
        self.allocs = 0
        self.alloc_sizes = []
        self.fail_alloc = False
        self.insn = 0
        self.count_on = False
        self.entries = []          # (sp, r0..r3, [sp]) at every entry of the module
        mu = e.mu
        def skip(uc, addr, size, user): uc.reg_write(UC_ARM_REG_PC, uc.reg_read(fwemu.UC_ARM_REG_LR))
        if not realy: mu.hook_add(UC_HOOK_CODE, skip, begin=0x5391FF0C, end=0x5391FF0C + 4)    # the Y-array builder: not needed (the planes are given)
        def on_alloc(uc, a, s, u):
            self.allocs += 1
            if self.fail_alloc: uc.reg_write(UC_ARM_REG_R0, 0); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(fwemu.UC_ARM_REG_LR))
        mu.hook_add(UC_HOOK_CODE, on_alloc, begin=ALLOC, end=ALLOC)
        def on_any(uc, a, s, u):
            if self.count_on: self.insn += 1
        mu.hook_add(UC_HOOK_CODE, on_any)
        if feeder is not None:
            mu.mem_write(GAIN, struct.pack('<I', TB4_STOCK_FIX))
            mu.hook_add(UC_HOOK_CODE, self._inject, begin=HOOK, end=HOOK + 4)
        elif hooked is False:
            pass
        else:
            self.code, self.ctx = self.locate()
            def on_entry(uc, a, s, u):
                sp = uc.reg_read(UC_ARM_REG_SP)
                self.entries.append((sp, [uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R0 + 1, UC_ARM_REG_R0 + 2, UC_ARM_REG_R3)],
                                     struct.unpack('<I', bytes(uc.mem_read(sp, 4)))[0]))
            mu.hook_add(UC_HOOK_CODE, on_entry, begin=self.code, end=self.code)
            # the argument of the module's one call of operator new (the firmware's own hook at the function turns r0 into the result at once)
            sites = [self.code + 4 * i for i in range(0x6C0) if word(self.rtos, self.code + 4 * i) & 0xFFFFFFF0 == 0xE12FFF30]
            assert len(sites) == 1, 'one indirect call in the module'
            mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, u: self.alloc_sizes.append(uc.reg_read(UC_ARM_REG_R0)), begin=sites[0], end=sites[0])

    def locate(self):
        w = word(self.rtos, HOOK)
        assert w >> 24 == 0xEA, 'hook word is not a branch'
        off = struct.unpack('<i', struct.pack('<I', (w & 0xFFFFFF) << 8))[0] >> 8
        stub = HOOK + 8 + 4 * off
        dec = lambda x: ((x >> 4) & 0xF000) | (x & 0xFFF)
        ctx = (dec(word(self.rtos, stub + 36)) << 16) | dec(word(self.rtos, stub + 32))
        bl = word(self.rtos, stub + 52)
        code = stub + 52 + 8 + 4 * (struct.unpack('<i', struct.pack('<I', (bl & 0xFFFFFF) << 8))[0] >> 8)
        self.stub = stub
        return code, ctx

    def set_model(self, blob):
        """put a model blob into the emulator (hooked image only): ctx.blob / blob_len point at it"""
        self.mu.mem_write(MODEL, bytes(blob))
        self.mu.mem_write(self.ctx + 4, struct.pack('<II', MODEL, len(blob)))

    def _inject(self, uc, addr, size, user):
        sb = uc.reg_read(UC_ARM_REG_R9)
        P = uc.reg_read(UC_ARM_REG_R9 + 1)           # r10 = sl = record
        fp = uc.reg_read(UC_ARM_REG_R11)
        rb = lambda a, n: bytes(uc.mem_read(a, n))
        forced = rb(sb + 0x8A, 1)[0] | rb(sb + 0x8B, 1)[0]
        mode = rb(sb + 0x8D, 1)[0]
        hl = struct.unpack('<I', rb(fp - 0x438, 4))[0]
        idx = uc.reg_read(UC_ARM_REG_R7)
        t = self.feeder.t(rb(P, P_SIZE), mode, hl, idx)
        self.last_t = t
        if forced or t < 0:
            uc.reg_write(UC_ARM_REG_PC, ZERO_PATH)
        else:
            uc.reg_write(UC_ARM_REG_R3, t); uc.reg_write(UC_ARM_REG_R7, 1); uc.reg_write(UC_ARM_REG_PC, COMMON)

    # ---- one call of the core
    def run(self, P, setting, hl, idx44, mode, b8a=0, b8b=0, lv_flag=True, reset=True, align8=False):
        e, mu = self.e, self.mu
        if reset:
            mu.mem_write(THIS, bytes(0x900)); mu.mem_write(OUTB, bytes(0x2000)); mu.mem_write(CURVE, bytes(0x800)); mu.mem_write(LVL, bytes(8))
            e.w32(0x553A2854, 0); mu.mem_write(0x553A2844, bytes(2)); mu.mem_write(0x553A2848, bytes(10))
        mu.mem_write(SB, bytes(0x200))
        mu.mem_write(PREC, bytes(P))
        if mode in (1, 2) and lv_flag: e.w32(PREC + 0x4D2B4, 1)
        e.w32(SB + 0x130, PREC)
        mu.mem_write(SB + 0x53, bytes([hl])); mu.mem_write(SB + 0x54, bytes([setting]))
        e.w16(SB + 0x44, idx44); mu.mem_write(SB + 0x8D, bytes([mode]))
        mu.mem_write(SB + 0x8A, bytes([b8a])); mu.mem_write(SB + 0x8B, bytes([b8b]))
        e.w32(THIS + 0x828, CURVE)
        self.allocs = 0; self.alloc_sizes = []; self.entries = []; self.insn = 0
        self.count_on = True
        args = (THIS, THIS + 0x14, OUTB, SB, LVL) + ((0,) if align8 else ())
        r = e.call(F_CORE, *args, count=20_000_000)
        self.count_on = False
        return r

    def state(self):
        e = self.e
        return dict(level=e.r16(LVL), strength=e.r16(THIS + 0x822), this=e.rb(THIS, 0x900), lut=e.rb(OUTB, 0x2000), curve=e.rb(CURVE, 0x800), lvl=e.rb(LVL, 8),
                    ram=e.rb(RAMSTATE[0], RAMSTATE[1]), sb=e.rb(SB, 0x200))


class Feeder:
    """t from the reference for the base RTOS (a throttled live view keeps its own ref.Seq)."""

    def __init__(self, blob, throttle=True):
        self.blob, self.seq = blob, ref.Seq(blob, PERIOD if throttle else 1)
        self.log = []

    def t(self, P, mode, hl, idx):
        t = self.seq.call(P, mode, hl, idx)
        self.log.append(t)
        return t


def same_state(a, b):
    return all(a[k] == b[k] for k in a)


def main():
    import test_host as TH
    dngs = TH.dng_scenes()
    rnd = random.Random(31)
    rng = np.random.default_rng(31)
    pool = TH.thr_pool(rng)
    bad = []
    cnt = dict(auto=0, t_pos=0, t_zero=0, t_neg=0, lv=0, fixed=0, forced=0, seq_frames=0, levels=set())

    def pad(P): return bytes(P) + bytes(P_SIZE - len(P))
    pre_img = open(PRE, 'rb').read()
    model_default = None

    # ---------------------------------------------------------------- 1. Auto: stills, live view, movie; one hooked emulator, one fed base emulator per model
    hooked = Core(PRE)
    model_default = bytes(hooked.mu.mem_read(struct.unpack('<I', bytes(hooked.mu.mem_read(hooked.ctx + 4, 4)))[0], struct.unpack('<I', bytes(hooked.mu.mem_read(hooked.ctx + 8, 4)))[0]))
    assert ref.parse_blob(model_default) is not None, 'the image carries a valid model'
    models = [model_default, ref.constant_blob(0), ref.constant_blob(0x800), ref.constant_blob(300), ref.constant_blob(-1)] + [TH.rand_blob(rnd, pool) for _ in range(10)] + [ref.placeholder_blob()]
    fed = {id(m): None for m in models}
    def feeder_core(blob):
        return Core(BASE, Feeder(blob, throttle=False))
    cases = []
    for fn, w, h, R, G, B, C in dngs:
        for mode in (0, 3):
            for hl in (0, 1):
                cases.append((fn, pad(TH.make_P(mode, w, h, R, G, B, C, rng)), mode, hl))
    for i in range(120):
        w, h, R, G, B, C = TH.scene(rng)
        mode = rnd.choice([0, 0, 3, 1, 2])
        cases.append((f'rnd{i}', pad(TH.make_P(mode, w, h, R, G, B, C, rng)), mode, rnd.randrange(2)))
    stock = {}
    for k, (tag, P, mode, hl) in enumerate(cases):
        blob = models[0] if k % 3 else rnd.choice(models)
        key = blob
        if key not in stock: stock[key] = feeder_core(blob)
        s = stock[key]
        idx = rnd.choice([0, 10, 25, 40, 60, 80, 95, 96, 97, 120])
        # throttling is off in the fed run: make the hooked run compute (a fresh live-view state word each call)
        hooked.mu.mem_write(SLOT, bytes(4))
        hooked.set_model(blob)
        s.feeder.seq = ref.Seq(blob, 1)
        for lvflag in ((True,) if mode in (1, 2) else (True,)):
            slot0 = hooked.e.r32(SCRATCH_SLOT)
            rh = hooked.run(P, 0, hl, idx, mode, lv_flag=lvflag)
            rs = s.run(P, 0, hl, idx, mode, lv_flag=lvflag)
            cnt['auto'] += 1
            t = s.feeder.log[-1] if s.feeder.log else None
            sh, ss = hooked.state(), s.state()
            if rh != rs or not same_state(sh, ss):
                bad.append(('auto', tag, mode, hl, idx, rh, rs, [k for k in sh if sh[k] != ss[k]], t))
            cnt['t_neg'] += t < 0; cnt['t_zero'] += t == 0; cnt['t_pos'] += t > 0
            cnt['levels'].add(ss['level'])
            if mode in (1, 2): cnt['lv'] += 1
            # the module was entered exactly once per computing call, with an aligned stack, ctx, P, mode, hl, idx as arguments
            for sp, regs, a5 in hooked.entries:
                if sp % 8 or regs[1] != PREC or regs[2] != mode or regs[3] != hl or a5 != min(idx, 0x60) or regs[0] != hooked.ctx:
                    bad.append(('call args', tag, hex(sp), [hex(r) for r in regs], a5))
            # the scratch: operator new is called once (2 x 776 bytes) while its pointer word is zero, never after that
            if hooked.allocs > (1 if slot0 == 0 else 0) or any(x != 2 * 776 for x in hooked.alloc_sizes): bad.append(('operator new', tag, hooked.alloc_sizes))
            if hooked.allocs: cnt['allocs'] = cnt.get('allocs', 0) + 1
            if hooked.e.r32(SCRATCH_SLOT) == 0 and rh != -1 and hooked.entries: bad.append(('no scratch', tag))
        stock_entries = len(hooked.entries)
    # a failing operator new: the call gives -1 (the camera's "no correction"), the pointer word stays 0, and the next call retries and works
    P0 = cases[0][1]
    f0 = Core(PRE); f0.set_model(models[0]); f0.fail_alloc = True
    fb = feeder_core(models[0]); fb.feeder.seq = ref.Seq(models[0], 1)
    fb.feeder.t = lambda P, mode, hl, idx: -1
    ra = f0.run(P0, 0, 0, 40, 0); rb_ = fb.run(P0, 0, 0, 40, 0)
    ok_fail = f0.allocs == 1 and f0.e.r32(SCRATCH_SLOT) == 0 and ra == rb_ and same_state(f0.state(), fb.state())
    f0.fail_alloc = False
    f0.run(P0, 0, 0, 40, 0)
    ok_fail &= f0.allocs == 1 and f0.e.r32(SCRATCH_SLOT) != 0
    if not ok_fail: bad.append(('failed allocation',))
    print(f'   operator new fails: -1 / no correction, pointer word stays 0, retried on the next call: {"ok" if ok_fail else "FAILED"}; one allocation of 1552 bytes in {cnt.get("allocs", 0)} of the Auto calls')
    print(f'1. Auto, hooked image vs the base image fed with t from ref.py: {cnt["auto"]} calls ({len(dngs) * 4} DNG, 120 random), models {len(models)}; '
          f't<0: {cnt["t_neg"]}, t=0: {cnt["t_zero"]}, t>0: {cnt["t_pos"]}; levels reached {sorted(cnt["levels"])}; mismatches {len(bad)}', flush=True)

    # ---------------------------------------------------------------- 1b. both stack alignments of the core's entry (the camera's is 8-aligned; the harness's default is not)
    n_al = 0
    for k in range(40):
        tag, P, mode, hl = cases[k * 7 % len(cases)]
        hooked.mu.mem_write(SLOT, bytes(4)); hooked.set_model(models[0])
        for al in (False, True):
            rh = hooked.run(P, 0, hl, 40, mode, align8=al)
            t = ref.shadowml_ref(models[0], bytes(P), mode, hl, 40)
            sp0 = hooked.entries[0][0] if hooked.entries else None
            n_al += 1
            if hooked.entries and sp0 % 8: bad.append(('unaligned module stack', tag, al))
    print(f'   both entry alignments of the core: {n_al} calls, module always entered 8-byte aligned')

    # ---------------------------------------------------------------- 2. live-view sequences (period 4) with stills in between, smoothing
    nseq = 0
    smooth_ok = smooth_changes = 0
    TC = ref_tables()
    for q in range(24):
        mode = rnd.choice([1, 1, 2])
        blob = rnd.choice(models[:3] + models[5:])
        hk = Core(PRE); hk.set_model(blob)
        fd = Feeder(blob, throttle=True)
        st = Core(BASE, fd)
        scs = [TH.scene(rng) for _ in range(3)]
        idx = rnd.choice([30, 50, 70, 96])
        first = True
        for step in range(rnd.randrange(8, 26)):
            w, h, R, G, B, C = rnd.choice(scs) if rnd.random() < 0.6 or step == 0 else scs[0]
            hl = 0
            still = rnd.random() < 0.2
            m = 0 if still else mode
            P = pad(TH.make_P(m, w, h, R, G, B, C, rng))
            if still:
                # a still shot between two live-view frames: its own, fresh core state (reset), the live-view state word must stay
                before = struct.unpack('<I', bytes(hk.mu.mem_read(SLOT, 4)))[0]
                sv = Feeder(blob, throttle=False)
                # the fed emulator's t for a still comes from the same Feeder object, which keeps the live-view Seq state apart
                rh = hk.run(P, 0, hl, idx, 0, reset=False); rs = st.run(P, 0, hl, idx, 0, reset=False)
                after = struct.unpack('<I', bytes(hk.mu.mem_read(SLOT, 4)))[0]
                if before != after: bad.append(('still touched the live-view state', q, step))
            else:
                rh = hk.run(P, 0, hl, idx, m, reset=first); rs = st.run(P, 0, hl, idx, m, reset=first)
                first = False
                nseq += 1
                cnt['seq_frames'] += 1
            sh, ss = hk.state(), st.state()
            if rh != rs or not same_state(sh, ss):
                bad.append(('seq', q, step, m, rh, rs, [k for k in sh if sh[k] != ss[k]]))
        # independent model of the five-frame average over the live-view frames of this sequence (stills interleaved do not enter it:
        # they reset nothing, but they do write the ring when mode 0 skips it) -> only checked for sequences without stills
    print(f'2. live-view / movie sequences (period {PERIOD}, stills in between): {nseq} frames, hooked == fed, live-view state word untouched by stills; mismatches {len(bad)}', flush=True)

    # ---------------------------------------------------------------- 2b. smoothing against its definition, no stills: strength = mean of the last five raw strengths (the first frame fills the ring)
    nsm = nsm_bad = changed = 0
    for q in range(12):
        mode = rnd.choice([1, 2])
        scs = [sc for sc in (TH.scene(rng, 0) for _ in range(6)) if ref.features(*sc[2:], sc[0], sc[1], 0, 96, mode) is not None][:4]
        ml = sorted(ref.features(*sc[2:], sc[0], sc[1], 0, 96, mode)[11] for sc in scs)
        # a model whose output follows the scene (mean log luminance), so that the strength changes from frame to frame
        blob = ref.build_blob([('split', 'meanlog', ml[len(ml) // 2], ('leaf', 150), ('leaf', 1500)), ('split', 'q50', ml[1], ('leaf', 0), ('leaf', 300))])
        hk = Core(PRE); hk.set_model(blob)
        # frames whose t alternates between 0 and 512 (placeholder) so the average is visible
        seq = ref.Seq(blob, PERIOD)
        raws = []
        idx = rnd.choice([20, 40, 60])
        cap = TC[idx]
        for step in range(30):
            w, h, R, G, B, C = rnd.choice(scs)
            P = pad(TH.make_P(mode, w, h, R, G, B, C, rng))
            hk.run(P, 0, 0, idx, mode, reset=(step == 0))
            t = seq.call(P, mode, 0, idx)
            raw = 0 if t < 0 else ((min(t, cap) * 0x400) >> 11)
            if step == 0: ring = [raw] * 5; pos = 0
            ring[pos] = raw; pos = (pos + 1) % 5
            want = sum(ring) // 5
            got = hk.state()['strength']
            nsm += 1
            if got != want:
                nsm_bad += 1; bad.append(('smoothing', q, step, got, want, raw, ring))
            changed += want != raw
    print(f'   five-frame smoothing against its definition (ring of the last five raw strengths, first frame fills it): {nsm} frames, {nsm_bad} mismatches, {changed} frames where the average differs from the raw strength')

    # ---------------------------------------------------------------- 3. fixed levels and the forced-zero bytes: the hooked image equals the base image exactly
    base_plain = Core(BASE, hooked=False)
    nf = 0
    for k in range(160):
        tag, P, mode, hl = cases[rnd.randrange(len(cases))]
        setting = rnd.choice([1, 2, 3, 4, 5, 9, 255]) if k < 110 else 0
        b8a, b8b = (0, 0) if k < 110 else rnd.choice([(1, 0), (0, 1), (1, 1), (7, 0)])
        idx = rnd.choice([0, 20, 50, 96, 200])
        hooked.mu.mem_write(SLOT, bytes(4))
        rh = hooked.run(P, setting, hl, idx, mode, b8a, b8b)
        rs = base_plain.run(P, setting, hl, idx, mode, b8a, b8b)
        nf += 1
        cnt['fixed' if k < 110 else 'forced'] += 1
        if rh != rs or not same_state(hooked.state(), base_plain.state()):
            bad.append(('fixed/forced', tag, setting, b8a, b8b, mode, rh, rs, [kk for kk in hooked.state() if hooked.state()[kk] != base_plain.state()[kk]]))
        if k >= 110 and hooked.state()['strength'] != 0: bad.append(('forced zero not zero', tag))
        if hooked.entries: bad.append(('module called for a fixed level / forced zero', tag, setting))
    print(f'3. fixed levels (Low / Medium / High / Off / other bytes) {cnt["fixed"]} and forced-zero bytes {cnt["forced"]}: hooked image == base image in return value, strength, level, tables and all state; mismatches {len(bad)}', flush=True)

    # ---------------------------------------------------------------- 5. instruction counts of the whole core
    ins = {'base Auto (stock, all-zero Y)': [], 'hooked still': [], 'hooked LV computing': [], 'hooked LV held': [], 'fixed level Low': []}
    p5 = dngs[:6] or [(f'rnd{i}',) + tuple(TH.scene(rng)) for i in range(4)]   # without DNG scenes: random ones (the counts then say less about real photos)
    for fn, w, h, R, G, B, C in p5:
        for m, key in ((0, 'hooked still'), (1, 'hooked LV computing')):
            P = pad(TH.make_P(m, w, h, R, G, B, C, rng))
            hooked.mu.mem_write(SLOT, bytes(4)); hooked.set_model(model_default)
            hooked.run(P, 0, 0, 40, m); ins[key].append(hooked.insn)
            if m == 1:
                hooked.run(P, 0, 0, 40, m, reset=False); ins['hooked LV held'].append(hooked.insn)
        P = pad(TH.make_P(0, w, h, R, G, B, C, rng))
        base_plain.run(P, 0, 0, 40, 0); ins['base Auto (stock, all-zero Y)'].append(base_plain.insn)
        hooked.run(P, 1, 0, 40, 0); ins['fixed level Low'].append(hooked.insn)
    for k, v in ins.items(): print(f'5. instructions of the whole core, {k}: min {min(v):,} mean {int(np.mean(v)):,} max {max(v):,}')

    # ---------------------------------------------------------------- 6. image diff
    a, b = open(BASE, 'rb').read(), pre_img
    base = 0x53000000
    # Both sections end with the build's record and a 16-byte trailer (record length, 'GRMODAR3', the checksum compensation
    # word); the build with shadowLearn may be a container frame longer. Up to the base build's record: only the hook word,
    # TB[4], the zero-fill literal (when the base had not extended it) and, after everything the base appended, bytes that were
    # zero padding there may differ.
    rec_a = len(a) - 16 - struct.unpack_from('<I', a, len(a) - 16)[0]
    OFFICIAL_END = 0x5440CE00       # the official RTOS length; everything a build appends lies beyond it
    ZERO_FILL = 0x53000460
    diff = [i for i in range(rec_a) if a[i] != b[i]]
    words = {HOOK - base, GAIN - base, ZERO_FILL - base}
    appended = [i for i in diff if base + i >= OFFICIAL_END]
    over = [hex(base + i) for i in appended if a[i] != 0]
    first = appended[0] if appended else None
    tail_nonzero = [hex(base + i) for i in range(first, rec_a) if a[i] != 0] if first is not None else []
    outside = [hex(base + i) for i in diff if base + i < OFFICIAL_END and (i & ~3) not in words] + over + tail_nonzero
    print(f'6. image vs the build without shadowLearn: lengths {len(a)} / {len(b)}; {len(diff)} bytes differ before the base record: '
          f'hook word {sum(1 for i in diff if (i & ~3) == HOOK - base)}, TB[4] {sum(1 for i in diff if (i & ~3) == GAIN - base)}, '
          f'zero-fill literal {sum(1 for i in diff if (i & ~3) == ZERO_FILL - base)}, appended area {len(appended)} bytes from '
          f'{hex(base + first) if first is not None else None} (base: zero from there to its record: {not over and not tail_nonzero}); anywhere else: {len(outside)} {outside[:5]}')
    if outside or first is None or (base + first) % 16: bad.append(('image differs elsewhere', outside[:5]))
    hw, gw = word(b, HOOK), word(b, GAIN)
    print(f'   hook word {word(a, HOOK):#010x} -> {hw:#010x}, TB[4] word {word(a, GAIN):#010x} -> {gw:#010x}')
    # the stub's non-branch words against clang's assembler, the branches by target / condition
    bad += check_stub(b, hooked)
    for x in bad[:12]: print('MISMATCH', x)
    print('RESULT', 'FAIL' if bad else 'all passed')
    sys.exit(1 if bad else 0)


ISO_LIMITER = 0x54081848             # the core's ISO limiter: 97 halfwords (index = round(8*Sv)-8, clamped at 0x60)


def ref_tables():
    img = open(BASE, 'rb').read()
    return list(struct.unpack_from('<97H', img, ISO_LIMITER - 0x53000000))


def check_stub(img, core):
    out = []
    stub = core.stub
    src = ['ldrb r0,[r9,#0x8a]', 'ldrb r1,[r9,#0x8b]', 'orrs r0,r0,r1', None, 'mov r4,sp', 'bic sp,sp,#7', 'sub sp,sp,#8', 'str r7,[sp]', None, None,
           'mov r1,r10', 'ldrb r2,[r9,#0x8d]', 'ldr r3,[fp,#-0x438]', None, 'mov sp,r4', 'cmp r0,#0', None, 'mov r3,r0', 'mov r7,#1', None]
    with tempfile.TemporaryDirectory() as t:
        s = Path(t) / 's.s'
        s.write_text('.syntax unified\n.arm\n' + '\n'.join(x if x else 'nop' for x in src) + '\n')
        import gen                    # the module's compiler: clang / ld.lld / llvm-objcopy, else zig's
        cc, _, objcopy = gen.tools()
        subprocess.run([str(c) for c in cc + ['-c', s, '-o', Path(t) / 's.o']], check=True)
        subprocess.run([str(c) for c in objcopy + ['-O', 'binary', '-j', '.text', Path(t) / 's.o', Path(t) / 's.bin']], check=True)
        ref_words = struct.unpack('<%dI' % len(src), (Path(t) / 's.bin').read_bytes())
    n_ok = 0
    for i, x in enumerate(src):
        w = word(img, stub + 4 * i)
        if x is None: continue
        n_ok += 1
        if w != ref_words[i]: out.append(('stub word differs from clang', i, x, hex(w), hex(ref_words[i])))
    def tgt(i):
        w = word(img, stub + 4 * i); d = struct.unpack('<i', struct.pack('<I', (w & 0xFFFFFF) << 8))[0] >> 8
        return w >> 28, stub + 4 * i + 8 + 4 * d, (w >> 24) & 15
    for i, (cond, target, op) in {3: (1, ZERO_PATH, 0xA), 16: (0xB, ZERO_PATH, 0xA), 19: (0xE, COMMON, 0xA)}.items():
        c, tg, o = tgt(i)
        if (c, tg, o) != (cond, target, op): out.append(('stub branch', i, hex(c), hex(tg)))
    c, tg, o = tgt(13)
    if c != 0xE or tg != core.code or o != 0xB: out.append(('stub bl', hex(tg), hex(core.code)))
    print(f'   stub: {n_ok} non-branch words equal clang\'s assembler, 4 branches / 1 bl checked by condition and target; {len(out)} problems')
    return out


if __name__ == '__main__':
    main()
