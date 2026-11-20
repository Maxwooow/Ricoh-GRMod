# SPDX-License-Identifier: GPL-2.0-only
"""Runs the real ARM module (the committed one, or as gen.py builds it with SHADOWML_FRESH=1; at 0x10000000) in the unicorn CPU emulator against ref.py: the DNG planes,
random scenes, edge cases and random / corrupted model blobs, with garbage in the stack. Checks the registers r4-r11 and sp, that
the record is not written, the deepest stack write (under 320 bytes) and counts executed instructions (per path).
usage: test_arm.py [n_random]   (needs unicorn)"""
import os
import random
import struct
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_PROT_ALL
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC

import gen
import ref
import test_host as TH

CODE, BLOB, CTX, PREC, STACK, RET = 0x10000000, 0x20000000, 0x30000000, 0x40000000, 0x60000000, 0x80000000
SCR, ALLOC, SLOT, SCR_BYTES = 0x50000000, 0x80000100, 0x30000200, 2 * 776
STACK_SIZE = 0x4000
P_SIZE = 0x70000


def build_code(extra=()):
    cc, ld, oc = gen.tools()
    with tempfile.TemporaryDirectory() as t:
        return gen.build(cc, ld, oc, Path(t), CODE, extra)


class Arm:
    def __init__(self, code):
        self.uc = uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        for base, size in ((CODE, 0x10000), (BLOB, 0x100000), (CTX, 0x1000), (PREC, P_SIZE), (STACK, STACK_SIZE), (RET, 0x1000), (SCR, 0x2000)):
            uc.mem_map(base, size, UC_PROT_ALL)
        uc.mem_write(CODE, code)
        uc.mem_write(RET, struct.pack('<I', 0xE320F000) * 2)
        self.insn = 0
        self.low = 0
        self.on = False
        def on_code(u, a, s, d):
            if self.on: self.insn += 1
        def on_w(u, access, a, s, v, d):
            if self.on: self.low = min(self.low, a)
        uc.hook_add(UC_HOOK_CODE, on_code)
        uc.hook_add(UC_HOOK_MEM_WRITE, on_w, begin=STACK, end=STACK + STACK_SIZE - 1)
        self.rng = np.random.default_rng(5)
        self.allocs = 0; self.fail_alloc = False; self.scr_over = 0
        def on_alloc(u, a, s, d):
            self.allocs += 1
            u.reg_write(UC_ARM_REG_R0, 0 if self.fail_alloc else SCR)
            u.reg_write(UC_ARM_REG_PC, u.reg_read(UC_ARM_REG_LR))
        uc.hook_add(UC_HOOK_CODE, on_alloc, begin=ALLOC, end=ALLOC)
        def on_scr(u, access, a, s, v, d): self.scr_over += 1
        uc.hook_add(UC_HOOK_MEM_WRITE, on_scr, begin=SCR + SCR_BYTES, end=SCR + 0x2000 - 1)
        uc.mem_write(SLOT, bytes(4))

    def call(self, P, blob, mode, hl, idx, magic=ref.MAGIC, measure=False, sp_off=0, period=1, state=None):
        uc = self.uc
        uc.mem_write(PREC, bytes(P))
        uc.mem_write(BLOB, bytes(blob))
        uc.mem_write(CTX, struct.pack('<IIIIIII', magic, BLOB, len(blob), period, CTX + 0x100 if state is not None else 0, ALLOC, SLOT))
        if state is not None: uc.mem_write(CTX + 0x100, struct.pack('<I', state))
        uc.mem_write(SCR, self.rng.integers(0, 256, SCR_BYTES, dtype=np.uint8).tobytes())          # garbage in the scratch as well
        uc.mem_write(STACK, self.rng.integers(0, 256, STACK_SIZE, dtype=np.uint8).tobytes())     # garbage in all of the scratch
        sp = STACK + STACK_SIZE - 16 - sp_off
        uc.mem_write(sp, struct.pack('<I', idx & 0xFFFFFFFF))         # the 5th argument
        regs = [0xA0A0A000 + i for i in range(8)]
        for i, v in enumerate(regs): uc.reg_write(UC_ARM_REG_R4 + i, v)
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), (CTX, PREC, mode, hl)): uc.reg_write(r, v & 0xFFFFFFFF)
        uc.reg_write(UC_ARM_REG_SP, sp); uc.reg_write(UC_ARM_REG_LR, RET)
        self.insn = 0; self.low = sp
        self.on = measure
        uc.emu_start(CODE, RET)
        r = uc.reg_read(UC_ARM_REG_R0)
        ok = all(uc.reg_read(UC_ARM_REG_R4 + i) == v for i, v in enumerate(regs)) and uc.reg_read(UC_ARM_REG_SP) == sp
        same = bytes(uc.mem_read(PREC, len(P))) == bytes(P)
        self.state = struct.unpack('<I', bytes(uc.mem_read(CTX + 0x100, 4)))[0]
        return (r - (1 << 32) if r >= 1 << 31 else r), ok, same


def committed_code():
    """The module as the program embeds it (gen.py's output, shadowml-code.ts)."""
    import base64, re
    return base64.b64decode(re.search(r"SHADOWML_CODE = '([^']*)'", gen.OUT_CODE.read_text()).group(1))


def main(n_random=1500):
    code = committed_code()
    print(f'module: the committed {gen.OUT_CODE.relative_to(gen.ROOT)} ({len(code)} bytes); SHADOWML_FRESH=1 compiles shadowml.c again instead')
    if os.environ.get('SHADOWML_FRESH'):
        code = build_code()
    arm = Arm(code)
    rnd = random.Random(21)
    rng = np.random.default_rng(21)
    dngs = TH.dng_scenes()
    pool = TH.thr_pool(rng)
    models = [open(os.environ.get('SHADOWML_MODEL') or str(Path(__file__).resolve().parent / 'model' / 'model_final.bin'), 'rb').read(), ref.placeholder_blob(), ref.constant_blob(300), ref.constant_blob(-1)] + [TH.rand_blob(rnd, pool) for _ in range(10)]
    n = bad = regbad = wbad = 0
    cost = {}
    deepest = 0
    t0 = time.time()
    def check(tag, P, blob, mode, hl, idx, magic=ref.MAGIC, measure=False):
        nonlocal n, bad, regbad, wbad, deepest
        r, ok, same = arm.call(P, blob, mode, hl, idx, magic, measure)
        t = ref.shadowml_ref(blob, P, mode, hl, idx, magic_ok=(magic == ref.MAGIC))
        n += 1
        if r != t: bad += 1; print('MISMATCH', tag, r, t, mode, hl, idx)
        regbad += not ok; wbad += not same
        if measure:
            cost.setdefault('LV' if mode in (1, 2) else 'still', []).append((arm.insn, r >= 0))
            deepest = max(deepest, STACK + STACK_SIZE - 16 - arm.low)
    for fn, w, h, R, G, B, C in dngs:
        for mode in (0, 1, 2, 3):
            for hl in (0, 1):
                P = TH.make_P(mode, w, h, R, G, B, C, rng)
                P = P + bytes(P_SIZE - len(P)) if len(P) < P_SIZE else P
                for blob in (models[0], rnd.choice(models[1:])):
                    check('dng ' + fn, P, blob, mode, hl, rnd.choice([0, 40, 96, 200]), measure=(hl == 0 and blob is models[0] and mode in (0, 1)))
    for i in range(n_random):
        w, h, R, G, B, C = TH.scene(rng)
        mode = rnd.choice([0, 0, 1, 2, 3, 4, 255])
        P = TH.make_P(mode, w, h, R, G, B, C, rng)
        P = P + bytes(P_SIZE - len(P))
        r = rnd.random()
        blob = rnd.choice(models) if r < 0.6 else (TH.rand_blob(rnd, pool) if r < 0.85 else TH.corrupt(rnd, rnd.choice(models)))
        check(f'rnd {i}', P, blob, mode, rnd.choice([0, 1, 255]), rnd.choice([0, 40, 96, 100000]), magic=ref.MAGIC if rnd.random() < 0.97 else 1, measure=(i < 30))
    # sequences with the throttling state (period 4 and others), garbage initial state, stills mixed in
    sq = 0
    for q in range(40):
        period = rnd.choice([0, 1, 2, 4, 4, 4, 8, 65])
        init = rnd.choice([0, 0, rnd.getrandbits(32), 0x00000103, 0x00080003, 0xFFFFFFFF, 0x00082001])
        blob = rnd.choice(models[:6]); seq = ref.Seq(blob, period, init); state = init
        scs = [TH.scene(rng) for _ in range(3)]
        for step in range(rnd.randrange(6, 25)):
            w, h, R, G, B, C = rnd.choice(scs)
            mode = rnd.choice([1, 1, 1, 2, 0, 3]); hl = rnd.randrange(2); idx = rnd.randrange(97)
            P = TH.make_P(mode, w, h, R, G, B, C, rng); P = P + bytes(P_SIZE - len(P))
            r, ok, same = arm.call(P, blob, mode, hl, idx, period=period, state=state)
            t = seq.call(P, mode, hl, idx)
            state = arm.state; n += 1; sq += 1
            if r != t or state != seq.state or not ok or not same: bad += 1; print('SEQ MISMATCH', q, step, r, t, state, seq.state)
    # the scratch: one allocation for the whole run, never written outside its two halves; a failed allocation gives -1 and is retried
    sc_bad = 0
    ok_allocs = arm.allocs == 1
    w, h, R, G, B, C = TH.scene(rng)
    PS = TH.make_P(0, w, h, R, G, B, C, rng); PS += bytes(P_SIZE - len(PS))
    arm.uc.mem_write(SLOT, bytes(4)); arm.fail_alloc = True; arm.allocs = 0
    r1 = arm.call(PS, models[0], 0, 0, 40)[0]; r2 = arm.call(PS, models[0], 0, 0, 40)[0]
    sc_bad += not (r1 == -1 and r2 == -1 and arm.allocs == 2 and struct.unpack('<I', bytes(arm.uc.mem_read(SLOT, 4)))[0] == 0)
    arm.fail_alloc = False
    r3 = arm.call(PS, models[0], 0, 0, 40)[0]; r4 = arm.call(PS, models[0], 0, 0, 40)[0]
    sc_bad += not (r3 == r4 == ref.shadowml_ref(models[0], PS, 0, 0, 40) and arm.allocs == 3 and struct.unpack('<I', bytes(arm.uc.mem_read(SLOT, 4)))[0] == SCR)
    sc_bad += arm.scr_over != 0 or not ok_allocs
    print(f'ARM scratch: one allocation over the run: {ok_allocs}; writes outside the two halves: {arm.scr_over}; failed-allocation / retry checks: {"ok" if not sc_bad else "FAILED"}')
    bad += sc_bad
    print(f'ARM (unicorn) throttled sequences: {sq} calls')
    print(f'ARM (unicorn) vs ref: {n} calls, {bad} mismatches; r4-r11/sp preserved: {n - regbad}/{n}; record unchanged: {n - wbad}/{n} ({time.time() - t0:.0f} s)')
    for k, v in cost.items():
        ins = [a for a, ok in v if ok]
        print(f'instructions per call, {k} path (committed trained model, full computation): min {min(ins):,} mean {int(np.mean(ins)):,} max {max(ins):,} ({len(ins)} calls)')
    print(f'deepest stack write: {deepest} bytes (limit 320)')
    sys.exit(1 if bad or regbad or wbad or deepest > 320 else 0)


if __name__ == '__main__':
    main(*[int(x) for x in sys.argv[1:]])
