# SPDX-License-Identifier: GPL-2.0-only
"""mf24 KEEP_LAST_ONLY (mfmod.c, the research notes T7u) in the emulator.
S. The stock side, base build: SetupModuleConfig case 8 (run for real through the dispatch fragment) puts the store configuration at
   recipe+0xCF4 and copies recipe+0x43 into its +0x72; the store handler 0x53731F14 (run for real from its entry up to its first item
   or its finish) posts the JPEG / RAW items of a frame with +0x72 = 0 and none with +0x72 = 1 (SI+0xB16 = 0, and SI+0xB16 = 1 with
   +0x73 = 0); with SI+0xB16 = 1 and +0x73 = 1 it takes the files from SI+0x7D9 (the reason the module leaves that case alone).
G. Groups in the camera's order (camera mf21 / mf22 module marks: frames 1-3's store setups after frame 4's module 9): frames 1-3
   modules 9, 10, 2, 4, 6, 7; frame 4 module 9 (the merge); frames 1-3 module 8; frame 4 modules 10, 2, 4, 7, 8 -- then the stock store
   handler on each frame's configuration: a merged group stores only frame 4 (the merged frame), frames 1-3 no item; the mf23 build and
   the KEEP_LAST_ONLY 0 build store all four; the memory (every block back, the same frees as mf23).
C. Every way that must store as stock: not merged (frame 4's exposure differs), a short group (3 frames: frames 2, 3; frame 1 under
   KEEP_FIRST), the power key during the
   merge, the power key after it (before the stores), a frame's store set up before the merge's result, an alternate not used, later
   than 20 s, a recipe reused before its store, the store's other path, a single shot below the gate; two merged groups in a row.
Replaced (blind spots): as sim.py; the store handler's item posting and the storage service (numbering, the card) are not run: a frame
whose handler posts no item gets no file and so no number [C, mfmod.c KEEP_LAST_ONLY].
usage: test_keep.py BASE_RTOS TEST_RTOS MANIFEST_JSON [MF23_RTOS [KEEP0_RTOS]]"""
import os, struct, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim, read_mf
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

BASE, TEST = sys.argv[1:3]
MF23 = sys.argv[4] if len(sys.argv) > 4 else None
KEEP0 = sys.argv[5] if len(sys.argv) > 5 else None
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok

W, H = 256, 128
CFG, NOFILE, MULTI = 0xCF4, 0x72, 0x73
SEQ, SIF, LVC = sim.OBJ + 0x3800000, sim.OBJ + 0x3810000, sim.OBJ + 0x3820000
M, M2, SLOTS = sim.OBJ + 0x3A00000, sim.OBJ + 0x3A20000, sim.OBJ + 0x3A30000
rg = np.random.default_rng(24)
IMG = (rg.integers(0, 2000, size=(H, W), dtype=np.int32) + 600)


def cam(rtos):
    c = sim.Cam(rtos, slice_=200000); c.w8(sim.SWITCH, 1)
    c.wb(LVC, bytes(0x100))
    return c


def fe(c, n, sv=11.0):
    c.wb(SEQ, bytes(0x400)); c.wb(SIF, bytes(0x1000)); c.w32(SEQ + 0x104, n); c.w8(SIF + 0x7BC, 1); c.w32(SIF + 0xBA0, sim.f32(sv))
    c.w32(SIF + 0xB9C, sim.f32(6.0)); c.w32(SIF + 0xB98, sim.f32(3.0))
    return c.module_call(1, SEQ, 0, SIF)


def recipe(c, slot, i, sv=11.0):
    r = sim.Recipe(c, slot, W, H, sim.si_fields(sv=sv, index=i)); c.w32(r.prop + 0x60, r.bayer)
    r.put_bayer(np.clip(IMG + rg.integers(-30, 31, size=(H, W)), 0, 16383).astype(np.uint16))
    c.w8(r.params + 0xD, 1); c.w8(r.params + 0xC, 1); c.w8(r.params + 0x1F, 0); c.w32(r.prop + 0x18, 0)
    return r


def store_items(c, r):
    """the stock store handler 0x53731F14 on recipe r's configuration (r1 = recipe+0xCF4), from its entry to its first item
    (0x53732110 JPEG, 0x537321CC RAW) or its finish 0x537322BC (no item); returns 'jpeg' / 'raw' / 'none' / None (else)"""
    got = []
    def stop(uc, addr, *_): got.append(addr); uc.emu_stop()
    hs = [c.mu.hook_add(UC_HOOK_CODE, stop, begin=a, end=a) for a in (0x53732110, 0x537321CC, 0x537322BC)]
    h2 = c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(M2), begin=0x538E2E9C, end=0x538E2E9C)
    c.wb(M, bytes(0x9000)); c.wb(M2, bytes(0x100)); c.wb(SLOTS, bytes(0x4000)); c.w32(M + 0x89FC, SLOTS)
    c.mu.reg_write(UC_ARM_REG_SP, sim.STACK_TOP - 0x1000)
    c.run(0x53731F14, sim.SENTINEL, {UC_ARM_REG_R0: M, UC_ARM_REG_R1: r.prop + CFG, UC_ARM_REG_LR: sim.SENTINEL}, count=200000)
    for h in hs + [h2]: c.mu.hook_del(h)
    return {0x53732110: 'jpeg', 0x537321CC: 'raw', 0x537322BC: 'none'}.get(got[0]) if got else None


# ---- S: the stock side ----------------------------------------------------------------------------------------------------
c = cam(BASE)
r = recipe(c, 0, 0)
c.w8(r.prop + 0x43, 0); out = r.module(8)
req_cfg = c.r32(out['post'][1] + 8) if out['post'][1] else None
check('S: SetupModuleConfig case 8 (the stock fragment): the store module gets the configuration at recipe+0xCF4 (its +0x34 the recipe\'s SI, '
      '+0x38 its params), +0x72 = recipe+0x43 = 0', req_cfg == r.prop + CFG and c.r32(r.prop + CFG + 0x34) == r.shoot and c.r32(r.prop + CFG + 0x38) == r.params
      and c.r8(r.prop + CFG + NOFILE) == 0, str((hex(req_cfg or 0), hex(c.r32(r.prop + CFG + 0x34)))))
c.w8(r.prop + 0x43, 1); r.module(8)
check('S: recipe+0x43 = 1 (the stock retake / error stop) -> configuration +0x72 = 1', c.r8(r.prop + CFG + NOFILE) == 1)
res = {}
for b16 in (0, 1):
    for multi in (0, 1):
        for nf in (0, 1):
            c.w8(r.prop + 0x43, 0); r.module(8)
            c.w8(r.shoot + 0xB16, b16); c.w8(r.shoot + 0x7D9, 2); c.w8(r.prop + CFG + MULTI, multi); c.w8(r.prop + CFG + NOFILE, nf)
            res[(b16, multi, nf)] = store_items(c, r)
c.w8(r.shoot + 0xB16, 0)
check('S: the store handler (stock, run for real): SI+0xB16 = 0 (a normal still): +0x72 = 0 -> the JPEG item first, +0x72 = 1 -> no item at all (its '
      'finish), whatever +0x73; SI+0xB16 = 1 / +0x73 = 0: +0x72 = 1 -> no item; SI+0xB16 = 1 / +0x73 = 1: the files from SI+0x7D9, +0x72 ignored '
      '(the module leaves that case alone)',
      res[(0, 0, 0)] == res[(0, 1, 0)] == 'jpeg' and res[(0, 0, 1)] == res[(0, 1, 1)] == res[(1, 0, 1)] == 'none' and res[(1, 1, 1)] == res[(1, 1, 0)] == 'jpeg', str(res))
c.w8(r.params + 0xC, 0); c.w8(r.params + 0xD, 1); c.w8(r.prop + CFG + NOFILE, 0); c.w8(r.prop + CFG + MULTI, 0)
check('S: (the handler path itself) RAW only (params +0xC 0, +0xD 1): the RAW item; the module never writes params', store_items(c, r) == 'raw')


# ---- G: groups in the camera's order -------------------------------------------------------------------------------------
def group(rtos=TEST, c=None, sv4=11.0, n=4, slots=(0, 1, 2, 3), early=(), key_merge=False, key_after=False, late_ms=0, reuse=None, alt_sv=None,
          b16=None, gap_before=True):
    """one press: frames' modules in the camera's order; early: frames (0..2) whose store setup comes before frame 4's module 9;
    key_merge / key_after: the power key (LiveViewControl +0xE3) during the merge / after it; late_ms: time between the merge and the
    stores; reuse: (k, new index) frame k's recipe re-prepared for another frame (module 9) before its store; alt_sv: frame 2's Sv;
    b16: (k) frame k's SI+0xB16 = 1 and +0x73 = 1.  Returns (cam, recipes, the items per frame, the logs)"""
    c = c or cam(rtos)
    st = c.r32(sim.SLOT)
    if gap_before: c.clock = (c.clock - 3 * 27000000) & 0xFFFFFFFF
    c._fe = 0; rs = []
    for i in range(n):
        c.clock = (c.clock - 240 * 27000) & 0xFFFFFFFF
        while getattr(c, 'ctx_addr', None) and c._fe < min(n, i + 2): c._fe += 1; fe(c, c._fe, sv=sv4 if c._fe == 4 else 11.0)
        sv = sv4 if i == 3 else (alt_sv if (i == 1 and alt_sv) else 11.0)
        r = recipe(c, slots[i], i, sv=sv); rs.append(r)
        if b16 is not None and i == b16: c.w8(r.shoot + 0xB16, 1); c.w8(r.prop + 0x44, 1)
        if i < 3:
            for m in (9, 10, 2, 4, 6, 7): r.module(m)
            if i in early: r.module(8)
        else:
            st = c.r32(sim.SLOT)
            if key_merge:
                c.w32(st + 0x30, LVC); c.w8(LVC + 0xE3, 0)
                c.on_tick = lambda cc: cc.w8(LVC + 0xE3, 1) if cc.r32(cc.r32(sim.SLOT) + 4) else None
            r.module(9)
            c.on_tick = None
    st = c.r32(sim.SLOT)
    if key_after: c.w32(st + 0x30, LVC); c.w8(LVC + 0xE3, 1)
    c.clock = (c.clock - int((late_ms or 300) * 27000)) & 0xFFFFFFFF
    if reuse is not None:
        k, idx = reuse
        rr = recipe(c, slots[k], idx); rr.module(9)                  # another frame in that recipe
    for i in range(min(n, 3)):
        if i not in early and (reuse is None or i != reuse[0]): rs[i].module(8)
    if reuse is not None: rr.module(8)                               # the new frame's own store
    if n == 4:
        for m in (10, 2, 4, 7, 8): rs[3].module(m)
    if key_after: c.w8(LVC + 0xE3, 0)
    items = [store_items(c, r) for r in rs]
    logs = [read_mf.parse(b) for nm, b in c.files if nm.startswith('C:\\MF')]
    return c, rs, items, logs


def nofile(c, rs): return [c.r8(r.prop + CFG + NOFILE) for r in rs]


c, rs, items, logs = group()
g = logs[-1] if logs else {}
kp = g.get('v22', {}).get('keep', [])
check('G: a merged group: frames 1-3 store nothing (configuration +0x72 = 1 -> the stock handler posts no item), frame 4 (the merged frame) its JPEG; '
      'the log says merged, frames 1-3 "no file"', g.get('result') == 1 and items == ['none', 'none', 'none', 'jpeg'] and nofile(c, rs) == [1, 1, 1, 0]
      and [w & 0xFF for w in kp] == [3, 3, 3], str((g.get('result'), items, nofile(c, rs), kp)))
check('G: recipe+0x43 itself never written (the stock\'s per-recipe request stays 0; the next frame in that recipe gets +0x72 = 0 from it)',
      [c.r8(r.prop + 0x43) for r in rs] == [0, 0, 0, 0])
check('G: the memory: every block of the group back (held frames freed or handed back, the merge blocks freed)', not c.pool_live, str(c.pool_live))
free_test = sorted(f[0] for f in c.free_calls)
cb, rsb, itb, lb = group(BASE)
check('G: the base build (no module): all four frames store their files', itb == ['jpeg'] * 4 and nofile(cb, rsb) == [0] * 4, str(itb))
for name, rt in (('mf23', MF23), ('KEEP_LAST_ONLY 0', KEEP0)):
    if not rt: continue
    cx, rsx, itx, lx = group(rt)
    check(f'G: the {name} build: merged, all four frames store their files (+0x72 never written)', (lx[-1].get('result') if lx else None) == 1 and itx == ['jpeg'] * 4
          and nofile(cx, rsx) == [0] * 4, str(itx))
    check(f'G: the {name} build frees the same blocks in the same order as the test build (the memory path unchanged)',
          sorted(f[0] for f in cx.free_calls) == free_test and not cx.pool_live, str((len(cx.free_calls), len(c.free_calls))))
# a second group right after: its own frames, nothing carried over
c2, rs2, it2, l2 = group(c=c, slots=(4, 5, 0, 1))
check('G: two merged groups in a row: the second\'s frames 1-3 store nothing, its frame 4 its files; the first group\'s decisions not reused',
      it2 == ['none', 'none', 'none', 'jpeg'] and [w & 0xFF for w in l2[-1]['v22']['prev_keep']] == [3, 3, 3], str((it2, l2[-1].get('v22'))))

# ---- C: every way that stores as stock -------------------------------------------------------------------------------------
def case(label, want_items, want_kp, **kw):
    c, rs, items, logs = group(**kw)
    g = logs[-1] if logs else {}
    kp = [w & 0xFF for w in g.get('v22', {}).get('keep', [])] if g else None
    if not g and want_kp is None: kp = None
    ok = items == want_items and (want_kp is None or kp == want_kp)
    check(f'C: {label}: files {want_items}' + (f', keep {[read_mf.KEEP[x] for x in want_kp]}' if want_kp else ''), ok, str((items, kp, g.get('result'))))
    return c, rs, items, logs


case('not merged (frame 4 at another Sv: no alternate)', ['jpeg'] * 4, [9, 9, 9], sv4=11.333)
case('a short group (3 frames, the next shot 1 s later): frame 1 no file (KEEP_FIRST: its store set up with frame 2 in the group), frames 2, 3 stored', ['none', 'jpeg', 'jpeg'], None, n=3)
cx, rsx, itx, lx = case('the power key during the merge (stopped, no log)', ['jpeg'] * 4, None, key_merge=True)
check('C: the power key during the merge: no group log, frame 4 untouched (stopped)', not lx and not cx.sunk, str(cx.sunk))
case('the power key after the merge, before the stores', ['jpeg', 'jpeg', 'jpeg', 'jpeg'], [4, 4, 4], key_after=True)
case('frame 1\'s store set up before frame 4\'s module 9 (before the result), while frame 1 is the group\'s only frame: stored (KEEP_FIRST: frame 2 not '
     'in the group yet; tools/gr4v121/handnight/test_groups.py F: the camera\'s order, frame 2 in the group)', ['jpeg', 'none', 'none', 'jpeg'], [11, 3, 3], early=(0,))
case('frame 2 at another Sv (not an alternate)', ['none', 'jpeg', 'none', 'jpeg'], [3, 7, 3], alt_sv=11.333)
case('the stores 21 s after the group\'s end (KEEP_WAIT_US 20 s; the waiting log goes out at frame 1\'s store, before frames 2-3 are decided)', ['jpeg'] * 4, [5, 1, 1], late_ms=21000)
cx, rsx, itx, lx = case('frame 1\'s recipe reused for another frame (module 9) before its store (the new frame\'s store keeps its files)', ['jpeg', 'none', 'none', 'jpeg'], [8, 1, 1], reuse=(0, 0))   # (the log goes out at that module 9)
st = cx.r32(sim.SLOT)
check('C: ... the reused recipe\'s new frame keeps its files (+0x72 0), the old note dropped ("gone")', cx.r8(rsx[0].prop + CFG + NOFILE) == 0)
case('frame 2 on the store\'s other path (SI+0xB16 1, +0x73 1)', ['none', 'jpeg', 'none', 'jpeg'], [3, 6, 3], b16=1)
# a single shot below the gate (ISO 800): not ours, its file
c = cam(TEST); c.clock = (c.clock - 3 * 27000000) & 0xFFFFFFFF
r = recipe(c, 0, 0, sv=8.0); c.w8(r.shoot + 0x7BC, 0)
for m in (9, 10, 2, 4, 6, 7, 8): r.module(m)
check('C: a single shot below the gate: its files (+0x72 0)', store_items(c, r) == 'jpeg' and c.r8(r.prop + CFG + NOFILE) == 0)

print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
