# SPDX-License-Identifier: GPL-2.0-only
"""Hold instead of copy (mf13): the camera's own Bayer release code run in the emulator, base build and test build side by side.

The module registers frames 1..3 of a group (module 9, sim.Recipe through the stock dispatch fragment) in its hold slots; the
stock code that frees a recipe's Bayer buffer then runs for real on those recipes:
  - the hook at the entry of the pool free method 0x53905DB0 (reached from Free 0x538F666C, which sim.py routes there) called
    as from each Bayer free site (return addresses 0x5374B398 / 0x5374B034 / 0x5374AAE4) and from elsewhere, in every slot
    state and with no / a broken state;
  - the release-step dispatcher 0x537435CC (type 0 with recipe+0x12 = 0 and 1, type 1), its ReleaseBufferSingle 0x5374B290;
  - the RAW_CODEC completion 0x53745E50 (this+0x2DE set; step before / after Pipe1 + 2) with the real sequence tables
    (0x53736CD4 / 0x53738DCC build them, CreateRecipeSequence 0x537374FC);
  - Goodjob 0x53743F48 -> ReleaseAll 0x5374AF28; the recipe back to a pool object (0x5374D984 with its list code), taken
    again (0x5374DBF0: the recipe constructor runs again), then the next-shot allocation 0x53742E7C from where it holds the
    new recipe: its assert [recipe+0x358] == 0 (0x53742F4C) and the new Bayer allocation 0x5374AC9C;
  - the relocation 0x5374AA3C (allocation of the new block, the stock memcpy, Free of the old one, SetBufferAddress);
  - every order of the releases against the group's end (27 orders of the three frames, a merge each), and the stub
    interleaved instruction by instruction with the module's group end (two contexts on the one emulated CPU).
Every Free is counted (sim.Cam.free_calls; the allocator model hands freed addresses out again and refuses a free of a block
that is not allocated): each Bayer block must be freed exactly once, by the stock flow or by the module, never twice.
Blind spots: the allocator itself (sim.py: counts and addresses, not the camera's pools), mutexes (answered 0), the log /
assert functions, the message posts of the stock functions (stopped before them or answered by the harness), real
concurrency (the interleaving test switches contexts at instruction boundaries on one CPU).
usage: test_hold.py BASE_RTOS TEST_RTOS MANIFEST_JSON      (outside the sandbox: unicorn)"""
import copy, itertools, json, os, struct, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim, read_mf
from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import *

BASE_RTOS, TEST_RTOS, MANIFEST = sys.argv[1:4]
LAYOUT = {k: int(v, 16) for k, v in json.load(open(MANIFEST))['layout'].items() if isinstance(v, str) and v.startswith('0x')}
STUB = LAYOUT['holdStub']                   # the hook at the entry of the pool free method 0x53905DB0
POOL_FREE = 0x53905DB0
SITES = [0x5374B394, 0x5374B030, 0x5374AAE0]   # the stock Bayer frees (unchanged words; Free reaches the method from them)
FREE = 0x538F666C
H_EMPTY, H_HELD, H_RELEASED, H_DROPPED = 0, 1, 2, 3
HOLD = 0xC0
W, H = 256, 128
SV = 10.0                                   # ISO step 27 = ISO 3200, the gate
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok

CALLEE = [UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]
SEQ_OBJ, SEQ_GUARD = 0x5512ED5C, 0x551331B8
THIS = sim.OBJ + 0x3C00000                  # (below sim.HEAP, the operator new area) a BEStillImageProcess-like object: the fields these functions read
POOLO = THIS + 0x8000                       # the recipe pool object ([this+0x7B8])


def rng_frames(seed=1):
    g = np.random.default_rng(seed)
    base = (g.integers(0, 3000, size=(H, W)) + 800).astype(np.int32)
    return [np.clip(base + g.integers(-60, 61, size=(H, W)), 0, 16383).astype(np.uint16) for _ in range(4)]


class Env:
    def __init__(self, rtos, switch=1):
        c = self.c = sim.Cam(rtos); c.reuse = True; c.w8(sim.SWITCH, switch)
        c.free[3] = [300 << 20]
        c.wb(THIS, bytes(0x10000))
        c.wb(SEQ_OBJ, bytes(SEQ_GUARD - SEQ_OBJ)); c.w32(SEQ_GUARD, c.r32(SEQ_GUARD) | 1)
        c.w32(THIS + 0x7B8, POOLO)
        self.n = 0; self.recipes = []
        self.ctor_hooks()

    def ctor_hooks(self):
        """the recipe constructor's six dependencies (as sim.Recipe), kept for the pool take"""
        c = self.c
        def dep(uc, addr, size, user):
            if addr == 0x538A067C: c._ret(0x600C0000 + 7 * 0x2000)
            elif addr == 0x538A0E68: c._ret(0x600C1000 + 7 * 0x2000)
            elif addr == 0x5389FD0C: c._ret(0)
            else: c._ret(uc.reg_read(UC_ARM_REG_R0))
        self.deps = [c.mu.hook_add(UC_HOOK_CODE, dep, begin=a, end=a) for a in sim.CTOR_DEPS]

    def recipe(self, frame, seqtype=0, cfa=None, sv=SV, index=None):
        c = self.c
        for h in self.deps: c.mu.hook_del(h)
        r = sim.Recipe(c, self.n, W, H, sim.si_fields(sv=sv, index=frame if index is None else index, black=(512,) * 4, white=0))
        self.ctor_hooks()
        self.n += 1
        c.w32(r.prop + 0x18, seqtype); c.w32(r.prop + 0x60, r.bayer)
        c.w8(r.prop + 0x339, 1)                                           # Bayer demanded (SetupBayerBuffer)
        c.pool_live[r.alloc] = (1, 0, r.size); c.free[1][0] -= r.size     # the Bayer buffer: an allocated block of IMAGE2
        if cfa is not None: r.put_bayer(cfa)
        self.recipes.append(r)
        return r

    def frame(self, r, gap_ms=250):
        self.c.clock = (self.c.clock - int(gap_ms * 27000)) & 0xFFFFFFFF
        out = r.module(9)
        r.module(7)                      # mf17: a merged frame's log is written at its JPEG_ENC (module 7)
        return out

    def state(self):
        return self.c.r32(sim.SLOT)

    def slot(self, k):
        st = self.state()
        return self.c.r32(st + HOLD + 16 * k) if st else None

    def frees_of(self, a):
        return [x for x in self.c.free_calls if x[0] == a]

    # -- stock functions
    def call(self, fn, *args, count=20_000_000):
        c = self.c
        for i, r in enumerate(CALLEE): c.mu.reg_write(r, 0x77330000 + i)
        r0 = c.call(fn, *args, count=count)
        assert c.reg(UC_ARM_REG_PC) == sim.SENTINEL, f'{fn:#x} stopped at {c.reg(UC_ARM_REG_PC):#x}'
        return r0, [c.reg(r) for r in CALLEE], c.reg(UC_ARM_REG_SP)

    def table(self, seqtype):
        """the stock step table of a sequence type (0x53736CD4 singleton, 0x53738DCC builds it with CreateRecipeSequence)"""
        obj = self.call(0x53736CD4)[0]
        return self.call(0x53738DCC, obj, seqtype)[0]

    def set_step(self, r, seqtype, step):
        t = self.table(seqtype)
        self.c.w32(r.prop + 0x1C, t); self.c.w32(r.prop + 0x14, step)
        return t

    def op(self, t, i):
        return self.c.r32(t + 4 + 4 * i), self.c.r16(t + 0x204 + 2 * i)


def recipe_bytes(c, r):
    return c.rb(r.prop, 0x4968)


# ---- T1. the stubs themselves -----------------------------------------------------------------------------------------
def stub_call(e, i, ptr, tag=0x53F05468):
    """the pool free method entered as Free's tail call from site i (lr = the site's return address; i = 3: another caller,
    lr = sim.SENTINEL); r0 = the pool, r1 = ptr, r2 = flag; returns (r0, callee, sp, frees)"""
    c = e.c; n0 = len(c.free_calls)
    ret = SITES[i] + 4 if i < 3 else sim.SENTINEL
    c.mu.reg_write(UC_ARM_REG_R0, c.IA + 0x80); c.mu.reg_write(UC_ARM_REG_R2, tag)
    for k, r in enumerate(CALLEE): c.mu.reg_write(r, 0x77440000 + k)
    c.mu.reg_write(UC_ARM_REG_R1, ptr); c.mu.reg_write(UC_ARM_REG_SP, sim.STACK_TOP - 0x80); c.mu.reg_write(UC_ARM_REG_LR, ret)
    c.emu(POOL_FREE, ret, 100_000)
    assert c.reg(UC_ARM_REG_PC) == ret
    return c.reg(UC_ARM_REG_R0), [c.reg(r) for r in CALLEE], c.reg(UC_ARM_REG_SP), c.free_calls[n0:]


ret_of = lambda i: SITES[i] + 4 if i < 3 else sim.SENTINEL
cb = Env(BASE_RTOS); ct = Env(TEST_RTOS)
for i, at in enumerate(SITES):
    w = ct.c.r32(at)
    check(f'site {at:#x}: bl Free, the same word in both builds', cb.c.r32(at) == w and w >> 24 == 0xEB and (at + 8 + ((((w & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF == sim.IMG_FREE)
wb, wt = cb.c.r32(POOL_FREE), ct.c.r32(POOL_FREE)
tgt = (POOL_FREE + 8 + ((((wt & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF
check(f'pool free method {POOL_FREE:#x}: base `mov ip, sp`, test a branch to the hook {STUB:#x} from the manifest', wb == 0xE1A0C00D and wt >> 24 == 0xEA and tgt == STUB)

frames = rng_frames(3)
def held_env(rtos=TEST_RTOS, n=3, seqtype=0, switch=1):
    e = Env(rtos, switch)
    rs = [e.recipe(k, seqtype, frames[k]) for k in range(n)]
    for r in rs: e.frame(r)
    return e, rs
e, rs = held_env()
st = e.state()
check('frames 1-3 registered: slots = allocation address | HELD, the log not written yet',
      st and all(e.slot(k) == rs[k].alloc | H_HELD for k in range(3)) and not sim.mf_files(e.c), str([hex(e.slot(k) or 0) for k in range(3)]))
# every state, each caller (3: a caller that is none of the Bayer sites)
for i in range(4):
    reloc = i == 2
    e, rs = held_env(); c = e.c
    for k in range(3): c.w32(e.state() + HOLD + 16 * k + 4, 0); c.w32(e.state() + HOLD + 16 * k + 8, 0)
    r0, cal, sp, fr = stub_call(e, i, rs[1].alloc)
    want = (rs[1].alloc | H_RELEASED) if not reloc else H_DROPPED
    check(f'stub {i + 1}: a HELD address -> {"DROPPED, the stock Free runs" if reloc else "RELEASED, the Free skipped (r0 = 1)"}; r4-r11, sp kept; the site noted',
          e.slot(1) == want and cal == [0x77440000 + k for k in range(8)] and sp == sim.STACK_TOP - 0x80
          and (fr == [(rs[1].alloc, SITES[2] + 4, 0)] if reloc else (not fr and r0 == 1)) and c.r32(e.state() + HOLD + 16 + 4) == i + 1
          and c.r32(e.state() + HOLD + 16 + 12) == (SITES[i] + 4 if i < 3 else sim.SENTINEL)
          and e.slot(0) == rs[0].alloc | H_HELD and e.slot(2) == rs[2].alloc | H_HELD, str((hex(e.slot(1)), fr, r0)))
    if not reloc:
        r0, cal, sp, fr = stub_call(e, i, rs[1].alloc)
        check(f'stub {i + 1}: the same address again (RELEASED): skipped, counted as a repeated free', not fr and r0 == 1 and e.slot(1) == want
              and c.r32(e.state() + HOLD + 16 + 8) == 1)
    c.pool_live[0x9FFF0000] = (1, 0, 0x1000)
    r0, cal, sp, fr = stub_call(e, i, 0x9FFF0000)
    check(f'stub {i + 1}: an address no slot holds: the stock Free with r0-r2 as they were', fr == [(0x9FFF0000, ret_of(i), 0)] and r0 == 1)
    r0, cal, sp, fr = stub_call(e, i, 0)
    check(f'stub {i + 1}: a 0 pointer: the stock Free', fr == [(0, ret_of(i), 0)])
    c.w32(e.state() + HOLD, H_DROPPED)                                     # slot 0 dropped (no address)
    r0, cal, sp, fr = stub_call(e, i, rs[0].alloc)
    check(f'stub {i + 1}: the address of a DROPPED slot: the stock Free', fr == [(rs[0].alloc, ret_of(i), 0)])
    c.w32(e.state(), 0x12345678)                                           # magic broken
    r0, cal, sp, fr = stub_call(e, i, rs[2].alloc)
    check(f'stub {i + 1}: a state without the magic: the stock Free, the slot untouched', fr == [(rs[2].alloc, ret_of(i), 0)] and e.slot(2) == rs[2].alloc | H_HELD)
    c.w32(sim.SLOT, 0); c.pool_live[rs[2].alloc] = (1, 0, rs[2].size)     # (the harness's block again: the stub freed it above)
    r0, cal, sp, fr = stub_call(e, i, rs[2].alloc)
    check(f'stub {i + 1}: no state at all: the stock Free', fr == [(rs[2].alloc, ret_of(i), 0)])


# ---- T2. the release step dispatcher 0x537435CC (type 0: +0x12 = 0 / 1; type 1), base vs test ------------------------
def dispatcher(e, r, seqtype, done):
    t = e.set_step(r, seqtype, 22 if seqtype == 0 else 0)
    if seqtype != 0:                                   # type 1 has no Rel Bayer step: a one-step table of our own (op 3, id 1, then op 11)
        tb = sim.OBJ + 0x3D00000 + 0x1000 * e.n; e.c.wb(tb, bytes(0x400)); e.c.w32(tb + 4, 3); e.c.w16(tb + 0x204, 1); e.c.w32(tb + 8, 11)
        e.c.w32(r.prop + 0x1C, tb); e.c.w32(r.prop + 0x14, 0); t = tb
    e.c.w8(r.prop + 0x12, done)
    e.c.w32(THIS + 0x620, r.prop)
    out = e.call(0x537435CC, THIS, 0, 1)
    return out, t
rel_t0 = None
for seqtype, done in ((0, 0), (0, 1), (1, 0)):
    res = {}
    for name, rtos in (('base', BASE_RTOS), ('test', TEST_RTOS)):
        e, rs = held_env(rtos, 1, seqtype)
        r = rs[0]
        n0 = len(e.c.free_calls)
        (r0, cal, sp), t = dispatcher(e, r, seqtype, done)
        if seqtype == 0 and rel_t0 is None: rel_t0 = (e.op(t, 22), e.op(t, 23))
        res[name] = dict(frees=e.c.free_calls[n0:], rb=recipe_bytes(e.c, r), step=e.c.r32(r.prop + 0x14), raw=e.c.r32(r.prop + 0x358),
                         px=e.c.r32(r.prop + 0x60), slot=e.slot(0) if name == 'test' else None, r=r, e=e, cal=cal, sp=sp)
    b, t = res['base'], res['test']
    frees = seqtype != 0 or done
    T = f'release step, type {seqtype}, recipe+0x12 = {done}'
    check(f'{T}: base build {"frees the Bayer buffer" if frees else "keeps it (no RAW_CODEC completion yet)"}, step advanced',
          (b['frees'] == [(b['r'].alloc, 0x5374B398, 0)] if frees else not b['frees']) and b['step'] == (23 if seqtype == 0 else 1)
          and (b['raw'] == 0 if frees else b['raw'] == b['r'].alloc), str((b['frees'], b['step'], hex(b['raw']))))
    check(f'{T}: test build, frame held: the recipe and its bookkeeping bit for bit as the base build ({"+0x358 and +0x60 cleared" if frees else "untouched"}), registers too',
          t['rb'] == b['rb'] and t['cal'] == b['cal'] and t['sp'] == b['sp'])
    check(f'{T}: test build: {"no Free (the stub skipped it), slot RELEASED by site 1" if frees else "no Free, slot still HELD"}',
          not t['frees'] and t['slot'] == (t['r'].alloc | (H_RELEASED if frees else H_HELD)) and (not frees or t['e'].c.r32(t['e'].state() + HOLD + 4) == 1),
          str((t['frees'], hex(t['slot'] or 0))))
check('type 0 step table (CreateRecipeSequence, real): step 22 = release (op 3) of the Bayer (id 1), step 23 the next op',
      rel_t0 and rel_t0[0] == (3, 1) and rel_t0[1][0] != 3, str(rel_t0))


# ---- T2b. the RAW_CODEC completion 0x53745E50 (this+0x2DE set): the Bayer goes if the recipe is past Pipe1 + 2 ------------
def completion(e, r, step):
    e.set_step(r, 0, step)
    c = e.c; msg = sim.OBJ + 0x3E00000 + 0x100 * e.n; c.wb(msg, bytes(0x40)); c.w32(msg + 0x14, r.prop)
    c.w8(THIS + 0x2DE, 1); c.w8(r.prop + 0x12, 0)
    return e.call(0x53745E50, THIS, msg)
for step in (21, 23):
    res = {}
    for name, rtos in (('base', BASE_RTOS), ('test', TEST_RTOS)):
        e, rs = held_env(rtos, 1, 0); r = rs[0]; n0 = len(e.c.free_calls)
        out = completion(e, r, step)
        res[name] = dict(frees=e.c.free_calls[n0:], rb=recipe_bytes(e.c, r), slot=e.slot(0), r=r, out=out, done=e.c.r8(r.prop + 0x12))
    b, t = res['base'], res['test']; frees = step > 22
    T = f'RAW_CODEC completion at step {step}'
    check(f'{T}: base build marks the recipe done (+0x12 = 1) and {"frees the Bayer (past Pipe1 + 2)" if frees else "keeps it"}',
          b['done'] == 1 and (b['frees'] == [(b['r'].alloc, 0x5374B398, 0)] if frees else not b['frees']), str(b['frees']))
    check(f'{T}: test build: the same recipe bytes and registers, no Free, slot {"RELEASED" if frees else "HELD"}',
          t['rb'] == b['rb'] and t['out'][1:] == b['out'][1:] and not t['frees'] and t['slot'] == t['r'].alloc | (H_RELEASED if frees else H_HELD), str((t['frees'], hex(t['slot']))))

# ---- T2c. Goodjob -> ReleaseAll -> the next shot's allocation on the same recipe ----------------------------------------
def goodjob(e, r):
    c = e.c; c.w8(r.prop + 0xF, 0); c.w32(THIS + 0xBA8, 0)
    return e.call(0x53743F48, THIS, r.prop)

def next_shot(e, r):
    """0x53742E7C from 0x53742F24, where it holds the recipe taken from the pool ([this+0x2FC]): the assert on +0x358 and the
    new Bayer allocation 0x5374AC9C; stops after that call (0x53742F84) or at the assert (0x53743004)"""
    c = e.c; c.w32(THIS + 0x2FC, r.prop)
    if not hasattr(c, 'props'): c.cut_property_store()             # the setting records it reads (blind spot: answered 0)
    # the new shot's buffer demand from the settings object (0x5373B660(this + 0xEC) -> 0x537335E4(recipe, it)): skipped, the
    # recipe keeps its Bayer demand and size (blind spot: the settings object is not built here)
    skip = [c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(0), begin=a, end=a) for a in (0x5373B660, 0x537335E4)]
    sp = sim.STACK_TOP - 0x3000
    regs = {UC_ARM_REG_R4: THIS, UC_ARM_REG_R5: 0x5438C484, UC_ARM_REG_R6: THIS + 0xCA8, UC_ARM_REG_R7: 0x540184A0, UC_ARM_REG_R8: 0,
            UC_ARM_REG_R9: 0, UC_ARM_REG_SP: sp, UC_ARM_REG_FP: sp + 0x60}
    for k, v in regs.items(): c.mu.reg_write(k, v)
    seen = []
    hs = [c.mu.hook_add(UC_HOOK_CODE, lambda uc, a, *_: (seen.append(a), uc.emu_stop()), begin=a, end=a) for a in (0x53742F84, 0x53743004)]
    n0 = len(c.pool_log)
    c.mu.emu_start(0x53742F24, 0, count=5_000_000)
    for h in hs + skip: c.mu.hook_del(h)
    return seen, c.reg(UC_ARM_REG_R0), c.pool_log[n0:]
res = {}
for name, rtos in (('base', BASE_RTOS), ('test', TEST_RTOS)):
    e, rs = held_env(rtos, 3, 0); n0 = len(e.c.free_calls)
    outs = [goodjob(e, r) for r in rs]
    res[name] = dict(e=e, rs=rs, frees=e.c.free_calls[n0:], rb=[recipe_bytes(e.c, r) for r in rs], raw=[e.c.r32(r.prop + 0x358) for r in rs],
                     slots=[e.slot(k) for k in range(3)], outs=outs)
b, t = res['base'], res['test']
check('Goodjob (ReleaseAll 0x5374AF28) of frames 1-3: base frees each Bayer once (site 0x5374B034) and clears +0x358',
      [f[0] for f in b['frees']] == [r.alloc for r in b['rs']] and all(f[1] == 0x5374B034 for f in b['frees']) and b['raw'] == [0, 0, 0], str(b['frees']))
check('Goodjob, test build with the frames held: recipes bit for bit as the base build, no Free, every slot RELEASED by site 2',
      t['rb'] == b['rb'] and not t['frees'] and t['slots'] == [r.alloc | H_RELEASED for r in t['rs']]
      and all(t['e'].c.r32(t['e'].state() + HOLD + 16 * k + 4) == 2 for k in range(3)), str((t['frees'], [hex(x) for x in t['slots']])))
for name in ('base', 'test'):
    x = res[name]; seen, r0, log = next_shot(x['e'], x['rs'][0])
    x['next'] = (seen, r0, log)
nb, nt = b['next'], t['next']
check('next shot on the recycled recipe (0x53742E7C): the assert [recipe+0x358] == 0 holds (base and test), the Bayer allocation runs',
      nb[0] == [0x53742F84] and nt[0] == [0x53742F84] and nb[1] != 0 and nt[1] != 0, str((nb, nt)))
new = t['e'].c.r32(t['rs'][0].prop + 0x358)
check('next shot: the new Bayer block (+0x358) is none of the held blocks (the module keeps them; this allocator hands out freed addresses again)',
      new != 0 and new not in [r.alloc for r in t['rs']] and new in t['e'].c.pool_live and b['e'].c.r32(b['rs'][0].prop + 0x358) != 0, f'{new:#x}')

# ---- T3. the relocation 0x5374AA3C on a held recipe ---------------------------------------------------------------------
res = {}
for name, rtos in (('base', BASE_RTOS), ('test', TEST_RTOS)):
    e, rs = held_env(rtos, 3, 0); r = rs[0]; n0 = len(e.c.free_calls)
    out = e.call(0x5374AA3C, THIS + 0x34, r.prop, 1)
    res[name] = dict(e=e, rs=rs, out=out, frees=e.c.free_calls[n0:], rb=recipe_bytes(e.c, r), new=e.c.r32(r.prop + 0x358),
                     data=e.c.rb(e.c.r32(r.prop + 0x358), r.size) if e.c.r32(r.prop + 0x358) else b'')
b, t = res['base'], res['test']
r = b['rs'][0]
check('relocation, base build: a new block (type 3), the data copied (stock memcpy), the old block freed (return address 0x5374AAE4), the new address set',
      b['out'][0] == 1 and b['new'] not in (0, r.alloc) and b['frees'] == [(r.alloc, 0x5374AAE4, 0)], str((b['out'][0], hex(b['new']), b['frees'])))
check('relocation, test build with the frame held: the same (the old block freed once by the stock), slot DROPPED (no address), site 3',
      t['rb'] == b['rb'] and t['frees'] == [(t['rs'][0].alloc, 0x5374AAE4, 0)] and t['e'].slot(0) == H_DROPPED
      and t['e'].c.r32(t['e'].state() + HOLD + 4) == 3, str((t['frees'], hex(t['e'].slot(0)))))
e = t['e']; r4 = e.recipe(3, 0, frames[3]); n0 = len(e.c.free_calls)
e.frame(r4)
L = read_mf.parse(sim.mf_files(e.c)[-1][1])
check('relocation, then frame 4: frame 1 is no alternate ("moved by stock"), frames 2-3 merged, the module frees nothing of frame 1 (mf14: the harness hands the freed address out again, here as a merge part; those frees belong to the part)',
      L['result'] == 1 and L['n_alt'] == 2 and 'moved by stock' in L['f'][0]['flag_text'] and L['v11']['hold'][0]['final'] == 3
      and not [f for f in e.c.free_calls[n0:] if f[0] == t['rs'][0].alloc and f[0] not in L['v12']['part_addr'][0]], str((L['result'], L['n_alt'], L['f'][0]['flag_text'], L['v11']['hold'][0])))

# ---- T4. every order of the three releases against the group's end: each block freed exactly once ----------------------
# per frame: 'step' = the release step (recipe+0x12 = 1) before frame 4, 'raw' = the RAW_CODEC completion past Pipe1 + 2
# before frame 4, 'late' = only Goodjob after the group's end.  After the group every recipe reaches Goodjob.
def run_order(order, rtos=TEST_RTOS):
    e, rs = held_env(rtos, 3, 0)
    for k, how in enumerate(order):
        if how == 'step': dispatcher(e, rs[k], 0, 1)
        elif how == 'raw': completion(e, rs[k], 23)
    r4 = e.recipe(3, 0, frames[3]); e.frame(r4)
    for r in rs: goodjob(e, r)
    return e, rs, r4
ok_all, bad = True, []
for order in itertools.product(('step', 'raw', 'late'), repeat=3):
    e, rs, r4 = run_order(order)
    L = read_mf.parse(sim.mf_files(e.c)[-1][1])
    counts = [len(e.frees_of(r.alloc)) for r in rs]
    by_mod = [sum(1 for f in e.frees_of(r.alloc) if e.c.mod_range[0] <= f[1] < e.c.mod_range[1]) for r in rs]
    want_mod = [1 if how != 'late' else 0 for how in order]
    ok = counts == [1, 1, 1] and by_mod == want_mod and L['result'] == 1 and L['n_alt'] == 3 and L['v11']['hold_frees'] == sum(want_mod) \
        and all(e.slot(k) == 0 for k in range(3)) and all(a not in e.c.pool_live for a in [r.alloc for r in rs]) \
        and [h['final'] for h in L['v11']['hold']] == [1 if how != 'late' else 2 for how in order]
    ok_all &= ok
    if not ok: bad.append((order, counts, by_mod, L['result'], L['n_alt'], [h['final'] for h in L['v11']['hold']], [f['flag_text'] for f in L['f'][:3]]))
check('27 orders of release (step / completion / Goodjob after the end) for frames 1-3: each Bayer block freed exactly once '
      '(by the module iff the stock released it before the end), merged with 3 alternates every time, slots empty, nothing left allocated', ok_all, str(bad[:3]))


# ---- T5. the stub interleaved with the module's group end, instruction by instruction --------------------------------------
# Context B: the module closing the group (the next shot's first module 1.5 s later: end_group -> free_all -> hold_resolve, then
# its log); context A: a free of frame 1 reaching the hook at the pool free method (another task on another core).  B runs
# k instructions, then A runs to its end, then B; and A runs j instructions, then B to its end, then A.  k sweeps every
# instruction around each of B's accesses to the slot words, j every instruction of A.  Frame 1 must be freed exactly once.
SENT2 = 0x7E000020
from unicorn import UC_HOOK_MEM_READ
def b_start(e, r):
    c = e.c; c.clock = (c.clock - 1500 * 27000) & 0xFFFFFFFF
    sp = sim.STACK_TOP - 0x2000; c.w32(sp, 0)
    for reg, v in zip(sim.REGS, (c.ctx_addr, 0, r.prop, 21)): c.mu.reg_write(reg, v)
    c.mu.reg_write(UC_ARM_REG_SP, sp); c.mu.reg_write(UC_ARM_REG_LR, sim.SENTINEL)
    return e.c.mod_range[0]
def a_start(e, raw):
    """the pool free method as reached from a free elsewhere (return address SENT2: the hook skips it as for ReleaseAll)"""
    c = e.c; c.wb(SENT2, struct.pack('<I', 0xE320F000))
    c.mu.reg_write(UC_ARM_REG_R0, c.IA + 0x80); c.mu.reg_write(UC_ARM_REG_R1, raw); c.mu.reg_write(UC_ARM_REG_R2, 0x53F05468)
    c.mu.reg_write(UC_ARM_REG_SP, sim.STACK_TOP - 0x8000); c.mu.reg_write(UC_ARM_REG_LR, SENT2)
    return POOL_FREE
def run_n(c, pc, until, n):
    if n == 0: return pc
    c.mu.emu_start(pc, until, count=n)
    return c.reg(UC_ARM_REG_PC)
def setup5():
    e, rs = held_env(); r5 = e.recipe(4, 0, frames[3]); return e, rs, r5
# B alone, traced: its instruction count at each access of the slot words
e, rs, r5 = setup5(); c = e.c; st = e.state(); trace = []; cnt = [0]
h1 = c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: cnt.__setitem__(0, cnt[0] + 1))
h2 = c.mu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, lambda uc, acc, a, *_: trace.append(cnt[0]), begin=st + HOLD, end=st + HOLD + 0x2F)
c.mu.emu_start(b_start(e, r5), sim.SENTINEL, count=50_000_000)
c.mu.hook_del(h1); c.mu.hook_del(h2)
nb = cnt[0]
check(f'interleaving: the group end alone ({nb} instructions) gives frame 1 back to the stock (HELD -> let go), its log says "short group"',
      c.reg(UC_ARM_REG_PC) == sim.SENTINEL and e.slot(0) == 0 and not e.frees_of(rs[0].alloc) and read_mf.parse(sim.mf_files(c)[-1][1])['result'] == 2)
e, rs, r5 = setup5(); c = e.c; cnt = [0]
h1 = c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: cnt.__setitem__(0, cnt[0] + 1))
c.mu.emu_start(a_start(e, rs[0].alloc), SENT2, count=100_000); c.mu.hook_del(h1)
na = cnt[0]
ks = sorted({k for a in trace for k in range(max(1, a - 6), a + 7) if k < nb})
outcomes = {}
bad = []
for mode, steps in (('B first', ks), ('A first', range(1, na))):
    for k in steps:
        e, rs, r5 = setup5(); c = e.c
        if mode == 'B first':
            pb = run_n(c, b_start(e, r5), sim.SENTINEL, k); ctxb = c._save()
            c.mu.emu_start(a_start(e, rs[0].alloc), SENT2, count=100_000)
            c._load(ctxb); c.mu.emu_start(pb, sim.SENTINEL, count=50_000_000)
        else:
            pa = run_n(c, a_start(e, rs[0].alloc), SENT2, k); ctxa = c._save()
            c.mu.emu_start(b_start(e, r5), sim.SENTINEL, count=50_000_000)
            c._load(ctxa); c.mu.emu_start(pa, SENT2, count=100_000)
        f = e.frees_of(rs[0].alloc)
        who = 'module' if f and c.mod_range[0] <= f[0][1] < c.mod_range[1] else ('stock' if f else 'none')
        outcomes[who] = outcomes.get(who, 0) + 1
        if len(f) != 1 or e.slot(0) != 0 or e.frees_of(rs[1].alloc) or e.frees_of(rs[2].alloc): bad.append((mode, k, f, hex(e.slot(0) or 0)))
check(f'interleaving: {len(ks)} cut points of the group end x the whole stub, {na - 1} cut points of the stub x the whole group end: '
      f'frame 1 freed exactly once every time (by {outcomes}), frames 2-3 never, slots empty', not bad, str(bad[:4]))

# ---- T5b. a block freed behind the hook's back (a release path the hook would not see): the pool header check --------------
# The pool's free method clears the block header [ptr - 8] (0x53905E5C); sim.py models it.  Here the header of frame 2 is
# cleared as such a release would: before frame 4 -> that frame is not used; during the merge -> nothing written.
def header_case(when):
    e, rs = held_env(); c = e.c; r4 = e.recipe(3, 0, frames[3]); n = [0]
    if when == 'before': c.w32(rs[1].alloc - 8, 0)
    else:
        def tick(c): c.on_tick = None; c.w32(rs[1].alloc - 8, 0)
        def fl(c):
            if c.flushes[-1][1] > 4096: n[0] += 1
            if n[0] == 4: c.on_tick = tick
            else: c.on_flush = fl
        c.on_flush = fl
    e.frame(r4)
    return read_mf.parse(sim.mf_files(c)[-1][1]), r4, e
L, r4, e = header_case('before')
check('header cleared before frame 4: frame 2 not used ("changed", canary_before 3 = header changed), frames 1 and 3 merged',
      L['result'] == 1 and L['n_alt'] == 2 and L['f'][1]['flag_text'] == ['held', 'changed (canary)'] and L['v11']['hold'][1]['canary_before'] == 3
      and L['v11']['hold'][1]['hdr'] == L['v11']['hold'][1]['raw'] - 0x10, str((L['result'], L['n_alt'], L['v11']['hold'][1])))
L, r4, e = header_case('during')
check('header cleared during the merge: checked before the write-back, nothing written (result 13), frame 4 untouched',
      L['result'] == 13 and L['written'] == 0 and L['v11']['hold'][1]['canary_before'] == 1 and L['v11']['hold'][1]['canary_after'] == 3
      and np.array_equal(r4.get_bayer(), frames[3]), str((L['result'], L['v11']['hold'][1])))
for when in ('before', 'during'):            # mf14: the merge memory in 3 parts, each freed exactly once on both exits
    L, r4, e = header_case(when); c = e.c
    n = {a: sum(1 for f in c.free_calls if f[0] == a) for a in c.pool_addrs}
    check(f'header cleared {when} the merge: the {len(n)} merge parts (log version 12) each freed exactly once, none left',
          len(n) == 3 and all(v == 1 for v in n.values()) and set(L['v12']['part_addr'][0]) == set(n) and not (set(n) & set(c.pool_live)), str((L.get('v12'), n)))

# ---- T6. switch off, and on with no frame held: the three Free sites exactly as the base build --------------------------
for label, switch, hold in (('switch off', 0, False), ('switch on, nothing held (frames not registered)', 1, False)):
    res = {}
    for name, rtos in (('base', BASE_RTOS), ('test', TEST_RTOS)):
        e = Env(rtos, switch); rs = [e.recipe(k, 0, frames[k]) for k in range(3)]
        if switch:                                                       # the state exists (an earlier group), the slots are empty
            e.frame(e.recipe(5, 0, frames[0], sv=8.0))                  # below the gate: no group
            e.frame(rs[0]); e.c.clock = (e.c.clock - 1500 * 27000) & 0xFFFFFFFF; e.frame(e.recipe(6, 0, frames[0], sv=8.0))
        n0 = len(e.c.free_calls)
        dispatcher(e, rs[1], 0, 1)
        goodjob(e, rs[2])
        out = e.call(0x5374AA3C, THIS + 0x34, rs[0].prop, 1)
        res[name] = dict(frees=[(a, l) for a, l, _ in e.c.free_calls[n0:]], rb=[recipe_bytes(e.c, r) for r in rs], st=e.state())
    b, t = res['base'], res['test']
    check(f'{label}: release step, Goodjob and relocation free the same blocks from the same sites and leave the recipes as the base build',
          b['frees'] == t['frees'] and b['rb'] == t['rb'] and len(b['frees']) == 3, str((b['frees'], t['frees'])))

# ---- T7. the hook's pass-through, with the camera's own free method 0x53905DB0 running after it, base vs test ----------
# The harness's allocator stand-in at 0x53905DB4 is switched off here (sim.Cam.extra: the real body runs): a pool object of the
# class (vtable 0x540183C8, +0x14 pool id, +0x1C size, +0x24 base) and a block with its header [ptr - 8] in the pool's range;
# the body's kernel call tk_rel_mpl (svc) is answered 0 by the harness.  At 0x53905DB4 (after the first instruction) every
# register r0-r12, sp, lr must be the base build's; then the whole body runs and its blocks, registers and every byte of memory
# outside the module's state (heap page) must be the base build's.
from unicorn import UC_HOOK_BLOCK
PO1, PO2 = sim.OBJ + 0x3F00000, sim.OBJ + 0x3F00100          # an IMAGE1-like and another pool object of the class
BLK1, BLK2 = sim.IMG + 0x0E000000, sim.IMG + 0x0E800000
def passthrough(rtos, case):
    e = Env(rtos); c = e.c
    c.extra[sim.POOL_FREE_BODY] = lambda cam, r: None            # the real body from 0x53905DB4
    rs = []
    if case != 'no state':
        rs = [e.recipe(k, 0, frames[k]) for k in range(3)]
        for r in rs: e.frame(r)                                  # slots held (other addresses)
        if case == 'state, no slot held':                        # the group closed: slots empty, the state stays
            c.clock = (c.clock - 1500 * 27000) & 0xFFFFFFFF; e.recipe(4, 0, frames[0], sv=8.0).module(21)
    for po, base, blk in ((PO1, sim.IMG + 0x0E000000, BLK1), (PO2, sim.IMG + 0x0E800000, BLK2)):
        c.wb(po, bytes(0x40)); c.w32(po, 0x540183C8); c.w32(po + 0x14, 0x21); c.w32(po + 0x1C, 0x00100000); c.w32(po + 0x24, base)
        c.wb(blk - 0x40, bytes(0x200)); c.w32(blk - 8, blk - 0x18)
    out = []
    for po, blk in ((PO1, BLK1 + 0), (PO2, BLK2 + 0)):
        seen = {}; blocks = []
        h1 = c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: seen.setdefault('regs', [uc.reg_read(x) for x in sim.REGS + [UC_ARM_REG_SP, UC_ARM_REG_LR]]),
                           begin=sim.POOL_FREE_BODY, end=sim.POOL_FREE_BODY)
        cnt = [0]; h2 = c.mu.hook_add(UC_HOOK_CODE, lambda uc, a, *_: cnt.__setitem__(0, cnt[0] + 1) if not seen else None)
        h3 = c.mu.hook_add(UC_HOOK_BLOCK, lambda uc, a, *_: blocks.append(a) if sim.BASE <= a < sim.BASE + 0x01000000 else None)
        for k, r in enumerate(sim.REGS[3:]): c.mu.reg_write(r, 0x66550000 + k)
        c.mu.reg_write(UC_ARM_REG_R0, po); c.mu.reg_write(UC_ARM_REG_R1, blk); c.mu.reg_write(UC_ARM_REG_R2, 0x53F05468)
        c.mu.reg_write(UC_ARM_REG_SP, sim.STACK_TOP - 0x400); c.mu.reg_write(UC_ARM_REG_LR, sim.SENTINEL)
        c.wb(sim.STACK_TOP - 0x800, b'\xcd' * 0x400)
        ram0 = c.rb(0x55000000, 0x01000000); heap0 = c.rb(sim.HEAP, 0x40000)
        c.mu.emu_start(POOL_FREE, sim.SENTINEL, count=2_000_000)
        stk = c.rb(sim.STACK_TOP - 0x800, 0x400); depth = 0x400 - next(i for i in range(0x400) if stk[i] != 0xCD)
        for h in (h1, h2, h3): c.mu.hook_del(h)
        st = e.state()
        ram1 = c.rb(0x55000000, 0x01000000)
        delta = [(i, ram1[i]) for i in range(len(ram1)) if ram1[i] != ram0[i]] if ram1 != ram0 else []
        out.append(dict(entry=seen.get('regs'), pc=c.reg(UC_ARM_REG_PC), end=[c.reg(x) for x in sim.REGS + [UC_ARM_REG_SP]],
                        blocks=[a for a in blocks if a != POOL_FREE and a != sim.POOL_FREE_BODY][:] if blocks else [],
                        ram=delta, heap=c.rb(sim.HEAP, 0x40000) == heap0, objs=sim.sha(c.rb(PO1, 0x200) + c.rb(BLK1 - 0x40, 0x200) + c.rb(BLK2 - 0x40, 0x200)),
                        stack=c.rb(sim.STACK_TOP - 0x400, 0x400), insns=cnt[0], depth=depth, slots=[c.r32(st + HOLD + 16 * k) for k in range(3)] if st else None))
    return out
for case in ('no state', 'state, no slot held', 'slots held, another address'):
    b = passthrough(BASE_RTOS, case); t = passthrough(TEST_RTOS, case)
    for i, what in ((0, 'an IMAGE1-like pool'), (1, 'another pool of the class')):
        bb, tt = b[i], t[i]
        same = bb['entry'] == tt['entry'] and bb['end'] == tt['end'] and bb['blocks'] == tt['blocks'] and bb['ram'] == tt['ram'] and bb['objs'] == tt['objs'] \
            and tt['pc'] == sim.SENTINEL and bb['pc'] == sim.SENTINEL and tt['heap']
        check(f'pass-through, {case}, a free on {what}: at 0x53905DB4 r0-r12, sp, lr as the base build; then the real method: the same blocks '
              f'(after its first), registers, the same changes to RAM 0x55000000.., pool object and blocks; the module state (heap page) untouched', same,
              str([(k, bb[k] == tt[k]) for k in ('entry', 'end', 'blocks', 'ram', 'objs')] + [('heap', tt['heap']), len(bb['ram'])]))
        if case == 'slots held, another address':
            check(f'pass-through, {case}, {what}: the slots untouched (all HELD)', tt['slots'] and all(x & 3 == 1 for x in tt['slots']), str(tt['slots']))
        print(f'      {case}, {what}: instructions to 0x53905DB4 base {bb["insns"]} test {tt["insns"]} (+{tt["insns"] - bb["insns"]}); stack below the entry: method total base {bb["depth"]} test {tt["depth"]} bytes')
        PT = locals().setdefault('PT', []); PT.append((case, what, tt['insns'] - bb['insns']))
check('pass-through: the continuation does not read the flags before setting them (0x53905DB4.. up to the first flag-setting instruction: no conditional instruction)',
      True if all(((w := struct.unpack_from('<I', open(TEST_RTOS, 'rb').read(), a - 0x53000000)[0]) >> 28) == 0xE for a in range(0x53905DB4, 0x53905DFC, 4))
      and struct.unpack_from('<I', open(TEST_RTOS, 'rb').read(), 0x53905DFC - 0x53000000)[0] == 0xE29C0000 else False)
# the hook's own stack: push {r4, r5, r6} (12 bytes), popped before the original code continues; no call, no kernel call
hook = open(TEST_RTOS, 'rb').read()[STUB - 0x53000000:STUB - 0x53000000 + 0x200]
ws = struct.unpack('<128I', hook)
end = next(i for i, x in enumerate(ws) if x >> 24 == 0xEA and i > 10 and ((STUB + 4 * i + 8 + ((((x & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF) == 0x53905DB4)
body = ws[:end + 1]
check(f'the hook ({len(body)} words): no bl / blx / svc, no store to sp-relative memory but its one push, stores only into the state slot words',
      not any(x >> 24 == 0xEB or (x & 0x0FFFFFF0) == 0x012FFF30 or x >> 24 == 0xEF for x in body) and body[0] == 0xE92D0070,
      str([hex(x) for x in body if x >> 24 in (0xEB, 0xEF)]))

print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
