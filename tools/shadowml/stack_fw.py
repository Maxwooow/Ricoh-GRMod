# SPDX-License-Identifier: GPL-2.0-only
"""Dynamic stack depth below the shadow core's frame in the firmware emulation: (a) the stock Y builder 0x538F75FC run for real in the
base image, (b) our stub + module in the hooked image. usage: stack_fw.py [pre/RTOS.bin] [base/RTOS.bin]  (env SHADOWML_MODEL optional)"""
import os, random, struct, sys
import test_fw as T
import numpy as np, ref
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_LR

YB = 0x538F75FC
def track(core, lo, hi, entry_pc=None):
    """min SP while pc in [lo,hi) (or from entry_pc until return)"""
    st = dict(min=None, entry=None, depth=0)
    mu = core.mu
    if entry_pc is None:
        def h(uc, a, s, u):
            if lo <= a < hi:
                sp = uc.reg_read(UC_ARM_REG_SP)
                if st['entry'] is None: st['entry'] = sp
                if st['min'] is None or sp < st['min']: st['min'] = sp
        mu.hook_add(UC_HOOK_CODE, h)
    else:
        act = dict(lr=None)
        def h(uc, a, s, u):
            if a == entry_pc and act['lr'] is None:
                act['lr'] = uc.reg_read(UC_ARM_REG_LR); st['entry'] = uc.reg_read(UC_ARM_REG_SP); st['min'] = st['entry']
            elif act['lr'] is not None:
                sp = uc.reg_read(UC_ARM_REG_SP)
                if sp < st['min']: st['min'] = sp
                if a == act['lr'] and sp >= st['entry']: act['lr'] = None
        mu.hook_add(UC_HOOK_CODE, h)
    return st

def main():
    PRE, BASE = T.PRE, T.BASE
    TH = T.TH
    dngs = TH.dng_scenes(); rnd = random.Random(31); rng = np.random.default_rng(31)
    pool = TH.thr_pool(rng)
    pad = lambda P: bytes(P) + bytes(T.P_SIZE - len(P))
    hooked = T.Core(PRE)
    base = T.Core(BASE, hooked=False, realy=True)
    from unicorn import UC_HOOK_INTR
    nsvc = [0]
    base.mu.mem_map(0, 0x10000)
    for r in (0x20000000,): base.mu.mem_map(r, 0x400000)
    def intr(uc, no, u): nsvc[0] += 1; uc.reg_write(T.UC_ARM_REG_R0, 0)    # OS service call (lock etc.): pretend success
    base.mu.hook_add(UC_HOOK_INTR, intr)
    ctxp = hooked.ctx; bp = struct.unpack('<I', bytes(hooked.mu.mem_read(ctxp + 4, 4)))[0]
    blob0 = bytes(hooked.mu.mem_read(bp, struct.unpack('<I', bytes(hooked.mu.mem_read(ctxp + 8, 4)))[0]))
    mp = os.environ.get('SHADOWML_MODEL')
    if mp: blob0 = open(mp, 'rb').read()
    models = [blob0] + [TH.rand_blob(rnd, pool) for _ in range(8)]
    sb_ = track(hooked, T.HOOK, bp)           # hook word .. end of code (ctx, code, stub precede the blob)
    sa_ = track(base, 0, 0, entry_pc=YB)
    cases = []
    for fn, w, h, R, G, B, C in dngs:
        for mode in (0, 3, 1, 2):
            cases.append(('dng', pad(TH.make_P(mode, w, h, R, G, B, C, rng)), mode, rnd.randrange(2)))
    for i in range(150):
        w, h, R, G, B, C = TH.scene(rng)
        mode = rnd.choice([0, 0, 3, 1, 2])
        cases.append(('rnd', pad(TH.make_P(mode, w, h, R, G, B, C, rng)), mode, rnd.randrange(2)))
    res = {}
    ycalls = 0
    nfail = [0]
    for k, (kind, P, mode, hl) in enumerate(cases):
        blob = blob0 if k % 3 else rnd.choice(models)
        hooked.mu.mem_write(T.SLOT, bytes(4)); hooked.set_model(blob)
        idx = rnd.choice([0, 10, 25, 40, 60, 80, 95, 120])
        for st in (sa_, sb_): st['min'] = None; st['entry'] = None
        hooked.run(P, 0, hl, idx, mode)
        try: base.run(P, 0, hl, idx, mode)
        except Exception: nfail[0] += 1
        path = 'live' if mode in (1, 2) else 'still'
        for nm, st in (('a', sa_), ('b', sb_)):
            if st['entry'] is None: continue
            d = st['entry'] - st['min']
            key = (nm, path, kind)
            res[key] = max(res.get(key, 0), d)
        if sa_['entry'] is not None: ycalls += 1
    print('svc calls', nsvc[0], 'base runs that faulted (stock Y builder needs OS objects):', nfail[0])
    print('Y builder reached in', ycalls, 'of', len(cases), 'base runs')
    for k in sorted(res): print(k, res[k])
main()
