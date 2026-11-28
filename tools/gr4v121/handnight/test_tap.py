# SPDX-License-Identifier: GPL-2.0-only
"""One press = 4 frames (mf14, hook H2 at 0x5367EFEC, mfmod.c which 3; the research notes T7j): the camera's own
front-end burst chain run in the emulator, base build, the mf13 build (optional) and the test build side by side.

Per frame: step 0x31D (0x53680178, H1 at 0x53680244) and 0x3FE (0x53680340, picks the next plan); between frames plan 1's
steps 0x206 (0x5367EFC0, H2 at 0x5367EFEC: F2 = F1), 0x20B (0x5367F4D4) and 0x2FE (0x5368288C, picks plan 2 / 1 / 3).  The
press starts with the stock RELEASE_CHECK_REQUEST handler 0x5367EB24 and its first plan 1; the release is the stock
RELEASE_STOP_EXE handler 0x53681000, injected at every point of the chain; a second press is 0x5367EB24 again.  The planner's
6 plan entries ([SEQ+0x88+8], 0x1A50 bytes each: in use +0x20, trigger +0x1A2C, ShootingInfo +0x10) are set as the running
plan needs; the planner queries (0x536849BC, 0x53684a54, 0x53684AFC, 0x53684b50, 0x53684B8C, 0x53684c70, 0x53684D04) run.
Replaced by Python (blind spots): the plan starter 0x53688988 (records the plan; the plan's other steps 0x201..0x205,
0x301..0x31C, 0x401..0x4FE are not run), the RELEASE_START handler (F5 = 1, SEQ+0x116 = 0 as 0x53681448 does first), the
release check itself (SEQ+0xF4 set before 0x206 unless a test fails it), the debug flag 0x53892BC0 (0), count notifications
0x53689cb4 / 0x53689E18, AE / record 0x5376E938 / 0x53770264 and their holder 0x53750a58, event flags 0x53903BC8 /
0x53903C80, log 0x53915138, idle notification 0x53680FCC, fail-factor report 0x536827F4, assert (recorded), the FE post
(sim.py), the timer (sim.py's clock, moved by the tests only: its step is 0 here).
usage: test_tap.py BASE_RTOS TEST_RTOS MANIFEST_JSON [--mf13 MF13_RTOS]      (outside the sandbox: unicorn)"""
import json, os, struct, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim, read_mf
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

BASE_RTOS, TEST_RTOS, MANIFEST = sys.argv[1:4]
MF13_RTOS = sys.argv[sys.argv.index('--mf13') + 1] if '--mf13' in sys.argv else None
LAYOUT = {k: int(v, 16) for k, v in json.load(open(MANIFEST))['layout'].items() if isinstance(v, str) and v.startswith('0x')}
TAP_STUB = LAYOUT['tapStub']
SITE = 0x5367EFEC
DECIDE, FINISH, S206, S20B, S2FE = 0x53680178, 0x53680340, 0x5367EFC0, 0x5367F4D4, 0x5368288C
STOP, CHECK_REQ = 0x53681000, 0x5367EB24
T_PLAN2, T_PLAN1, T_PREP, T_SHUT = 0x42408802, 0x4240880F, 0x4C409E03, 0x4C409E04
STUBS = {0x53688988: 'plan', 0x53892BC0: 'flag', 0x53689cb4: 'notify1', 0x53689E18: 'notify2', 0x5376E938: 'ae', 0x53770264: 'rec',
         0x53903BC8: 'event', 0x53903C80: 'event2', 0x53915138: 'log', 0x53680FCC: 'idle', 0x536827F4: 'report', 0x53916230: 'assert'}
QUIET = ('flag', 'log', 'ae', 'rec', 'event', 'event2')
F = sim.OBJ + 0x03000000
SEQ, ENT, SI, DBG, HOLDER, MSG = F, F + 0x100000, F + 0x40000, F + 0x31000, F + 0x30000, F + 0x50000
PL = SEQ + 0x88
US = 27                                     # timer ticks per microsecond (27 MHz down-counter)
LIMIT = 2_000_000
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok


class Chain:
    def __init__(self, rtos, switch=1, step=30, drive=1, mem=None):
        c = self.c = sim.Cam(rtos); c.step = 0
        if mem is not None: c.free[1] = [mem]
        self.ev = []
        c.wb(SEQ, bytes(0x1000)); c.wb(ENT, bytes(6 * 0x1A50 + 0x100)); c.wb(SI, bytes(0x1000)); c.wb(DBG, bytes(0x400)); c.wb(MSG, bytes(0x40))
        c.w32(PL + 8, ENT); c.w32(SEQ + 0xA4, DBG); c.w8(SI + 0x7BC, drive); c.w32(SI + 0xBA0, sim.f32(1 + step / 3)); c.w8(sim.SWITCH, switch); c.w32(SI + 0xB9C, sim.f32(6.0)); c.w32(SI + 0xB98, sim.f32(3.0))   # (mf17: EV100 from a usual exposure)
        def stub(uc, addr, size, user):
            n = STUBS[addr]
            if n == 'plan': self.ev.append(('plan', uc.reg_read(UC_ARM_REG_R1)))
            elif n not in QUIET: self.ev.append((n,))
            c._ret(0)
        for a in STUBS: c.mu.hook_add(UC_HOOK_CODE, stub, begin=a, end=a)
        c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(HOLDER), begin=0x53750a58, end=0x53750a58)
        self.h2_calls = 0
        def h2(uc, *_): self.h2_calls += 1
        c.mu.hook_add(UC_HOOK_CODE, h2, begin=SITE, end=SITE)

    def plan(self, trig, extra=()):
        c = self.c
        for i in range(6): c.w8(ENT + i * 0x1A50 + 0x20, 0)
        c.w8(ENT + 0x20, 1); c.w32(ENT + 0x10, SI); c.w32(ENT + 0x1A2C, trig)
        for i, t in extra:
            e = ENT + i * 0x1A50; c.w8(e + 0x20, 1); c.w32(e + 0x10, SI); c.w32(e + 0x1A2C, t)
        return ENT

    def run(self, fn, *a):
        k = len(self.ev); r = self.c.call(fn, *a)
        return r, [p for n, *p in self.ev[k:] if n == 'plan' for p in p], [e for e in self.ev[k:] if e[0] != 'plan']

    def b(self, o): return self.c.r8(SEQ + o)

    def snap(self):
        c = self.c
        ram = bytearray(c.rb(0x55000000, 0x01000000)); ram[sim.SWITCH - 0x55000000] = 0      # (the switch byte itself left out)
        return dict(seq=sim.sha(c.rb(SEQ, 0x1000)), si=sim.sha(c.rb(SI, 0x1000)), ent=sim.sha(c.rb(ENT, 6 * 0x1A50)), ram=sim.sha(bytes(ram)),
                    posts=[p['msg'] for p in c.fe_posts])


def press(rtos, switch=1, stop=None, cond=None, cond_at=None, second=None, reruns=12, dt=None, step=30, drive=1, mem=None, start_f5=True,
          first_check_stop=False, frames_max=10, chain=None):
    """One press.  stop = (point, frame): 'pre31d' / 'post31d' (frame k's 0x31D), 'pre206' / 'post206' / 'post20b' (plan 1 after
    frame k); None: held through the burst.  cond(ch, k, run): applied in plan 1 after frame cond_at (or every frame), before 0x206.
    second = ('plan1' | 'plan2', k): a second press during plan 1 after frame k / during frame k+1's plan 2 (before its 0x31D),
    its release at the next frame's 0x31D.  dt: microseconds the clock moves before each plan-1 run.
    Returns the trace: list of (kind, values) and the chain."""
    ch = chain or Chain(rtos, switch, step, drive, mem); c = ch.c; tr = []
    for i in range(6): c.w8(ENT + i * 0x1A50 + 0x20, 0)
    r, pl, ev = ch.run(CHECK_REQ, SEQ, MSG); tr.append(('check_request', r, pl))
    ch.plan(T_PLAN1); c.w8(SEQ + 0xF4, 1)
    if first_check_stop: c.w8(SEQ + 0xF5, 1); r, pl, ev = ch.run(STOP, SEQ, MSG); tr.append(('stop', 'check0', ch.b(0xF1), ch.b(0xF3)))
    ch.run(S206, SEQ, ENT); ch.run(S20B, SEQ, ENT); r, pl, ev = ch.run(S2FE, SEQ, ENT); tr.append(('first_check', pl, ev, ch.b(0xF2), ch.b(0x116)))
    if pl or first_check_stop: return tr, ch
    if start_f5: c.w8(SEQ + 0xF5, 1); c.w8(SEQ + 0x116, 0)
    stop_point = dict([stop]) if stop else {}
    pending2 = None
    for k in range(1, frames_max + 1):
        ch.plan(T_PLAN2)
        def at(point):
            if stop_point.get(point) == k: r, pl, ev = ch.run(STOP, SEQ, MSG); tr.append(('stop', point, k, ch.b(0xF1), ch.b(0xF3)))
        at('pre31d')
        if second == ('plan2', k - 1): r, pl, ev = ch.run(CHECK_REQ, SEQ, MSG); tr.append(('second', 'plan2', r, pl, c.r32(SEQ + 0x104)))
        if pending2 == k: r, pl, ev = ch.run(STOP, SEQ, MSG); tr.append(('stop', 'second release', k, ch.b(0xF1)))
        r, pl, ev = ch.run(DECIDE, SEQ, ENT)
        tr.append(('frame', k, r, c.r32(SEQ + 0x104), ch.b(0xF8), c.r8(SI + 0x959), c.r8(SI + 0x95A)))
        at('post31d')
        r, pl, ev = ch.run(FINISH, SEQ, ENT); tr.append(('3fe', k, pl, ev))
        if pl != [1]: return tr, ch
        for run in range(reruns):
            if dt is not None: c.clock = (c.clock - dt * US) & 0xFFFFFFFF
            ch.plan(T_PLAN1); c.w8(SEQ + 0xF4, 1)
            if cond and (cond_at is None or cond_at == k): cond(ch, k, run)
            if run == 0: at('pre206')
            if second == ('plan1', k) and run == 0:
                r, pl, ev = ch.run(CHECK_REQ, SEQ, MSG); tr.append(('second', 'plan1', r, pl, c.r32(SEQ + 0x104))); pending2 = k + 1
            r, pl, ev = ch.run(S206, SEQ, ENT); f2 = ch.b(0xF2)
            if run == 0: at('post206')
            ch.run(S20B, SEQ, ENT)
            if run == 0: at('post20b')
            r, pl, ev = ch.run(S2FE, SEQ, ENT)
            tr.append(('plan1', k, run, f2, c.r8(SI + 0x959), ch.b(0xF8), pl, ev))
            if pl != [1]: break
        if pl != [2]: return tr, ch
    return tr, ch


def frames(tr): return [t[3] for t in tr if t[0] == 'frame']        # SEQ+0x104 at each 0x31D (the count incl. that frame)
def end(tr):
    last = [t for t in tr if t[0] in ('3fe', 'plan1', 'first_check')][-1]
    return (last[0], last[-2] if last[0] != 'first_check' else last[1])
def asserts(ch): return sum(1 for e in ch.ev if e[0] == 'assert')


def h2_state(ch):
    """the module's tap fields: struct state (mfmod.c) ends with cont_tick, cont_n, cont_seq, h2_seq, h2_cont, h2[16] (5 words
    each); the ring in call order"""
    c = ch.c; st = c.r32(sim.SLOT)
    if not st: return None
    size = c.allocs[st]
    w = struct.unpack('<%dI' % (5 + 80), c.rb(st + size - 4 * (5 + 80), 4 * (5 + 80)))
    ring = [w[5 + 5 * i:10 + 5 * i] for i in range(16)]
    return dict(cont_tick=w[0], cont_n=w[1], cont_seq=w[2], seq=w[3], cont=w[4], ring=[ring[(w[3] + i) % 16] for i in range(16) if ring[(w[3] + i) % 16][0] or ring[(w[3] + i) % 16][2]])


# ---- 0. the hook word and the stub ---------------------------------------------------------------------------------------
base_rt, test_rt = open(BASE_RTOS, 'rb').read(), open(TEST_RTOS, 'rb').read()
wd = lambda rt, a: struct.unpack_from('<I', rt, a - sim.BASE)[0]
check('H2 site: base word 0xE5D430F1 (ldrb r3, [r4, #0xF1]); test build: bl to the tap stub', wd(base_rt, SITE) == 0xE5D430F1 and
      wd(test_rt, SITE) == (0xEB000000 | (((TAP_STUB - SITE - 8) >> 2) & 0xFFFFFF)), hex(wd(test_rt, SITE)))
check('H2 stub starts with the stock load', wd(test_rt, TAP_STUB) == 0xE5D430F1)

# ---- 1. the stub alone: registers kept, r3 = the answer ----------------------------------------------------------------
import random
rng = random.Random(7)
def at_site(rtos, switch, f1, f3=0, x11a=0, f8=1, n=2, cont=True, age_us=1000, drive=1, regs=None):
    """run from 0x5367EFEC to 0x5367EFF0 (one stock instruction or the bl to the stub and back)"""
    ch = Chain(rtos, switch, 30, drive); c = ch.c
    if cont and switch:                                  # a real H1 continue for this count first (state, record)
        c.w32(SEQ + 0x104, n - 1); c.w8(SEQ + 0xF1, f1); ch.plan(T_PLAN2); ch.run(DECIDE, SEQ, ENT)
        c.clock = (c.clock - age_us * US) & 0xFFFFFFFF
    c.w32(SEQ + 0x104, n); c.w8(SEQ + 0xF1, f1); c.w8(SEQ + 0xF3, f3); c.w8(SEQ + 0x11A, x11a); c.w8(SEQ + 0xF8, f8)
    ch.plan(T_PLAN1)
    vals = regs or [rng.getrandbits(32) for _ in range(13)]
    vals[0] = PL; vals[1] = SI; vals[2] = x11a; vals[12] = f3; vals[4] = SEQ; vals[5] = ENT; vals[6] = PL
    sp = sim.STACK_TOP - 0x400
    for r, v in zip(sim.REGS, vals): c.mu.reg_write(r, v)
    c.mu.reg_write(UC_ARM_REG_SP, sp); c.mu.reg_write(UC_ARM_REG_LR, 0x5367F030)
    above = c.rb(sp, 0x100)
    c.emu(SITE, SITE + 4, 10_000_000)
    out = [c.reg(r) for r in sim.REGS]
    return dict(pc=c.reg(UC_ARM_REG_PC), r3=out[3], kept=[out[i] for i in (0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12)] == [vals[i] for i in (0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12)],
                sp=c.reg(UC_ARM_REG_SP) == sp, above=c.rb(sp, 0x100) == above, ram=sim.sha(c.rb(0x55000000, 0x01000000)), seq=sim.sha(c.rb(SEQ, 0x1000)))
for f1 in (0, 1):
    for f3, x11a in ((0, 0), (1, 0), (0, 1)):
        regs = [rng.getrandbits(32) for _ in range(13)]
        b = at_site(BASE_RTOS, 0, f1, f3, x11a, cont=False, regs=list(regs))
        off = at_site(TEST_RTOS, 0, f1, f3, x11a, cont=False, regs=list(regs))
        on = at_site(TEST_RTOS, 1, f1, f3, x11a, regs=list(regs))
        want = 0 if (f1 and not f3 and not x11a) else f1
        check(f'stub, F1 {f1} F3 {f3} 0x11A {x11a}: base r3 = F1; switch off = base (registers, stack above sp, RAM, SEQ)',
              b['pc'] == off['pc'] == SITE + 4 and b['r3'] == f1 and {k: v for k, v in b.items()} == {k: v for k, v in off.items()})
        check(f'stub, F1 {f1} F3 {f3} 0x11A {x11a}, switch on, group open: r3 = {want}; r0-r2, r4-r12, sp, the stack above sp kept',
              on['pc'] == SITE + 4 and on['r3'] == want and on['kept'] and on['sp'] and on['above'], str(on))

# ---- 2. the camera failure first: mf13 + tap = 1 frame, then plan 3 ------------------------------------------------------
POINTS = [('pre31d', k) for k in range(1, 5)] + [('post31d', k) for k in range(1, 5)] + [(p, k) for p in ('pre206', 'post206', 'post20b') for k in range(1, 4)]
if MF13_RTOS:
    for st in (('pre31d', 1), ('post31d', 1), ('pre206', 1)):
        tr, _ = press(MF13_RTOS, 1, st)
        check(f'mf13, release {st[0]} of frame 1 (a tap): 1 frame, then plan 3 (the camera failure reproduced)', frames(tr) == [1] and end(tr) == ('plan1', [3]), str((frames(tr), end(tr))))
    tr, _ = press(MF13_RTOS, 1, None)
    check('mf13, held: 4 frames, then plan 3 from frame 4\'s 0x3FE', frames(tr) == [1, 2, 3, 4] and end(tr) == ('3fe', [3]), str((frames(tr), end(tr))))
tr, _ = press(BASE_RTOS, 0, ('pre31d', 1))
check('base build, tap: 1 frame, then plan 3 (from 0x3FE: no H1)', frames(tr) == [1] and end(tr) == ('3fe', [3]), str((frames(tr), end(tr))))

# ---- 3. held press: exactly mf13; switch off = base -----------------------------------------------------------------------
if MF13_RTOS:
    for dt in (None, 300_000):
        a, ca = press(MF13_RTOS, 1, None, dt=dt); b, cb = press(TEST_RTOS, 1, None, dt=dt)
        sa, sb = ca.snap(), cb.snap()
        check(f'held press{" (0.3 s per frame)" if dt else ""}: test build = mf13 (every step, plan, flag, SEQ / SI / plan entries, RAM 0x55000000.., FE posts)',
              a == b and sa == sb, str((frames(b), end(b))))
        check('held press: H2 called once per plan 1 (4 incl. the press\'s first check), every answer the stock 0', cb.h2_calls == 4 and h2_state(cb)['cont'] == 0
              and all(e[3] == 0 for e in h2_state(cb)['ring']), str((cb.h2_calls, h2_state(cb))))
for st in [None, ('pre31d', 1), ('post206', 2), ('post20b', 3)]:
    for drive in (1, 0, 2, 4):
        a, ca = press(BASE_RTOS, 0, st, drive=drive); b, cb = press(TEST_RTOS, 0, st, drive=drive)
        check(f'switch off, drive {drive}, release {st}: = base build (trace, SEQ / SI / plan entries, RAM, FE posts)', a == b and ca.snap() == cb.snap())
for drive in (0, 2, 4, 5):
    for st in (None, ('pre31d', 1), ('pre206', 1)):
        a, ca = press(BASE_RTOS, 0, st, drive=drive); b, cb = press(TEST_RTOS, 1, st, drive=drive)
        check(f'switch on, drive {drive} (not continuous), release {st}: = base build (H2 stock: no module state, RAM too)', a == b and ca.snap() == cb.snap())

# ---- 4. a tap: the release at every point of the chain -> 4 frames, then plan 3 -------------------------------------------
for st in POINTS:
    tr, ch = press(TEST_RTOS, 1, st)
    hs = h2_state(ch)
    check(f'tap, release {st[0]} of frame {st[1]}: 4 frames (count 1, 2, 3, 4), then plan 3 from frame 4\'s 0x3FE; no assert',
          frames(tr) == [1, 2, 3, 4] and end(tr) == ('3fe', [3]) and not asserts(ch), str((frames(tr), end(tr))))
    bt, _ = press(BASE_RTOS, 0, st)
    print(f'      base build, same release: {len(frames(bt))} frame(s), ends {end(bt)}; test build H2 calls {ch.h2_calls}, "no stop" answers {hs["cont"]}')
    check(f'tap, release {st[0]} of frame {st[1]}: every "no stop" of H2 with F1 set, F8 set, count 1..3, H1\'s continue < 2 s old',
          all((e[2] & 0x7FF) == (1 | 2 | 128 | 256 | 512 | 1024) and e[3] == 0 for e in hs['ring'] if e[2] & 2048) and hs['cont'] == sum(1 for e in hs['ring'] if e[2] & 2048))

# ---- 5. aborts during the group (tap released before frame 1's 0x31D; condition in plan 1 after frame k) ----------------
def prep(ch, k, run): ch.c.w16(PL + 4, 1); ch.plan(T_PLAN1, [(1, T_PREP)])
def shut(ch, k, run): ch.c.w16(PL + 6, 2); ch.plan(T_PLAN1, [(2, T_SHUT)])
def sflag(o, v=1):
    def f(ch, k, run): ch.c.w8(SEQ + o, v)
    return f
def chkfail(ch, k, run): ch.c.w8(SEQ + 0xF4, 0)
def chkfail122(ch, k, run): ch.c.w8(SEQ + 0xF4, 0); ch.c.w8(SEQ + 0x122, 1)
def shutprep_handler(ch, k, run): ch.c.w8(SEQ + 0x11E, 1)      # what the shutdown preparation handler 0x53681ba8 sets in a release check (with F1)
ABORTS = [('shutdown preparation queued (planner slot +4)', prep, True), ('shutdown queued (planner slot +6)', shut, True),
          ('fail factor SEQ+0x113', sflag(0x113), False), ('interval cancel SEQ+0x11A', sflag(0x11A), False), ('cancel SEQ+0xF3', sflag(0xF3), False),
          ('shutdown preparation SEQ+0x11E', shutprep_handler, False), ('check failed, stop factor SEQ+0x122', chkfail122, False)]
for name, f, h2_answers in ABORTS:
    for k in (1, 2, 3):
        tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), cond=f, cond_at=k)
        check(f'tap + {name} in plan 1 after frame {k}: the burst ends there (frames {list(range(1, k + 1))}, plan 3); no assert',
              frames(tr) == list(range(1, k + 1)) and end(tr) == ('plan1', [3]) and not asserts(ch), str((frames(tr), end(tr))))
        if MF13_RTOS and k == 1:
            a, ca = press(MF13_RTOS, 1, ('pre31d', 1), cond=f, cond_at=1)
            same = a == tr and ca.snap() == ch.snap()
            check(f'tap + {name} after frame 1: {"= mf13 in every step, flag and RAM (H2 answers the stock byte)" if not h2_answers else "the same plans as mf13"}',
                  same if not h2_answers else ([t for t in a if t[0] in ('frame', '3fe')] == [t for t in tr if t[0] in ('frame', '3fe')] and end(a) == end(tr)),
                  str((frames(a), end(a), frames(tr), end(tr))))
    for k in (1, 2, 3):                                                  # held: the condition behaves as on mf13
        if not MF13_RTOS: break
        a, ca = press(MF13_RTOS, 1, None, cond=f, cond_at=k); b, cb = press(TEST_RTOS, 1, None, cond=f, cond_at=k)
        check(f'held + {name} after frame {k}: = mf13 (trace, SEQ / SI / plan entries, RAM, FE posts)', a == b and ca.snap() == cb.snap(),
              str((frames(a), end(a), frames(b), end(b))))
# F3 before frame 1: the release during the first release check (count 0) -> no frame, as stock
for rt, sw, name in [(BASE_RTOS, 0, 'base'), (TEST_RTOS, 1, 'test')] + ([(MF13_RTOS, 1, 'mf13')] if MF13_RTOS else []):
    tr, ch = press(rt, sw, first_check_stop=True)
    if name == 'base': ref_tr, ref_snap = tr, ch.snap()
    check(f'{name} build: release during the press\'s first release check: F3 set, no frame, idle (no plan; stock){" (= base: trace, flags)" if name != "base" else ""}',
          tr[1][3] == 1 and not frames(tr) and tr[-1][1] == [] and ('idle',) in tr[-1][2] and (name == 'base' or (tr == ref_tr and (ch.snap()['seq'], ch.snap()['si']) == (ref_snap['seq'], ref_snap['si']))),
          str(tr))

# ---- 6. the time limit (fake tick): the failing check without a stop factor --------------------------------------------
for dt, want_runs in ((250_000, 7), (500_000, 3), (700_000, 2), (1_000_000, 1), (1_999_999, 1)):
    tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), cond=chkfail, cond_at=1, dt=dt)
    runs = [t for t in tr if t[0] == 'plan1']
    check(f'tap + release check failing without a stop factor, {dt / 1e6:g} s per plan-1 run: plan 1 again while H1\'s continue is < 2 s old,'
          f' then the stock cancel (plan 3); 1 frame', frames(tr) == [1] and end(tr) == ('plan1', [3]) and len(runs) == want_runs + 1
          and [t[3] for t in runs] == [0] * want_runs + [1], str([(t[2], t[3], t[6]) for t in runs]))
tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), dt=2_000_000)
check('tap, every plan-1 run 2.0 s after H1\'s continue: stock (1 frame, plan 3)', frames(tr) == [1] and end(tr) == ('plan1', [3]), str((frames(tr), end(tr))))
tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), dt=1_999_999)
check('tap, every plan-1 run 1.999999 s after H1\'s continue: 4 frames', frames(tr) == [1, 2, 3, 4] and end(tr) == ('3fe', [3]), str((frames(tr), end(tr))))
a, _ = press(BASE_RTOS, 0, None, cond=chkfail, cond_at=1, reruns=12, dt=500_000); b, _ = press(TEST_RTOS, 1, None, cond=chkfail, cond_at=1, reruns=12, dt=500_000)
check('held + failing check (no stop factor): plan 1 again and again, as the base build (12 runs; the time limit is only for a released button)',
      a == b and len([t for t in b if t[0] == 'plan1']) == 12)
tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), cond=chkfail, cond_at=1, dt=600_000, reruns=40)
hs = h2_state(ch)
check('after the limit H2 stays stock for that count (H1\'s record dropped): no later "no stop"', hs['cont_n'] == 0 and end(tr) == ('plan1', [3]))

# ---- 7. a second press ------------------------------------------------------------------------------------------------
for k in (1, 2, 3):
    tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), second=('plan1', k))
    sec = [t for t in tr if t[0] == 'second'][0]
    check(f'second press during plan 1 after frame {k}: accepted (count reset, plan 1); {k} + 4 frames, at most 4 per count, then plan 3',
          sec[3] == [1] and sec[4] == 0 and frames(tr) == list(range(1, k + 1)) + [1, 2, 3, 4] and end(tr) == ('3fe', [3]), str((sec, frames(tr), end(tr))))
for k in (1, 2, 3):
    tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), second=('plan2', k))
    sec = [t for t in tr if t[0] == 'second'][0]
    check(f'second press during plan 2 of frame {k + 1} (the first released): ignored (no plan, count kept); 4 frames, plan 3',
          sec[3] == [] and sec[4] == k and frames(tr) == [1, 2, 3, 4] and end(tr) == ('3fe', [3]), str((sec, frames(tr), end(tr))))

# ---- 8. ISO gate and memory gate at frame 1: a gated frame stays a single shot on a tap -------------------------------
MB = 1 << 20
GATE = int(__import__('re').search(r'#define ISO_GATE_STEP (\d+)', open(os.path.join(HERE, 'mfmod.c')).read()).group(1))   # 24 final build, 27 mf13..mf19
for name, kw in ((f'ISO step {GATE - 1} (below the gate)', dict(step=GATE - 1)), (f'ISO step {GATE - 3}', dict(step=GATE - 3)), ('IMAGE2 400 MB free (memory gate)', dict(mem=400 * MB)),
                 ('IMAGE2 500 MB - 1 free', dict(mem=500 * MB - 1))):
    for st in (None, ('pre31d', 1), ('post31d', 1)):
        tr, ch = press(TEST_RTOS, 1, st, **kw)
        check(f'{name}, release {st}: 1 frame, plan 3 from frame 1\'s 0x3FE (H2 never reached)', frames(tr) == [1] and end(tr) == ('3fe', [3]) and ch.h2_calls == 1,
              str((frames(tr), end(tr), ch.h2_calls)))
        if MF13_RTOS:
            a, ca = press(MF13_RTOS, 1, st, **kw)
            check(f'{name}, release {st}: = mf13 (trace, SEQ / SI / plan entries, FE posts)', a == tr and {k: v for k, v in ca.snap().items() if k != 'ram'} == {k: v for k, v in ch.snap().items() if k != 'ram'})
# forced: a plan 1 after a burst H1 ended (gate, memory, count 4) with F8 and F1 set -> H2 answers the stock byte
for name, kw, n_after in (('ISO gate', dict(step=GATE - 1), 1), ('memory gate', dict(mem=400 * MB), 1), ('count 4', dict(), 4)):
    tr, ch = press(TEST_RTOS, 1, ('pre31d', 1) if n_after == 1 else None, **kw)
    c = ch.c
    for n in ((1, 2, 3) if n_after == 4 else (1,)):
        c.w8(SEQ + 0xF8, 1); c.w8(SEQ + 0xF1, 1); c.w32(SEQ + 0x104, n); ch.plan(T_PLAN1); c.w8(SEQ + 0xF4, 1)
        ch.run(S206, SEQ, ENT)
        check(f'forced plan 1 after {name} (F8 1, F1 1, count {n}): H2 answers the stock 1 (F2 = 1)', ch.b(0xF2) == 1)

# ---- 9. the log: the h2 ring goes into the group's log (version 12, tap block), read_mf prints it -------------------------
ch = Chain(TEST_RTOS, 1, 30)
tr, ch = press(TEST_RTOS, 1, ('pre31d', 1), chain=ch)
c = ch.c; c.step = 2700
W, H = 256, 128
rg = np.random.default_rng(5)
base_img = (rg.integers(0, 2000, size=(H, W), dtype=np.int32) + 600).astype(np.uint16)
for i in range(4):
    c.clock = (c.clock - 240 * 27000) & 0xFFFFFFFF
    r = sim.Recipe(c, i, W, H, sim.si_fields(sv=11.0, index=i)); c.w32(r.prop + 0x60, r.bayer); r.put_bayer(base_img)
    for m in (9, 4, 7, 8): r.module(m)
L = read_mf.parse(sim.mf_files(c)[0][1]) if sim.mf_files(c) else None
t = L and L.get('tap')
check('log: version 15..22 with the tap block (limit 2 s, the ring as the module has it)', L is not None and L['log_version'] in (15, 16, 17, 18, 19, 20, 21, 22) and t and t['h2_limit_us'] == LIMIT
      and t['h2_cont'] == 3 and t['h2_seq'] == ch.h2_calls - 1 and [tuple(e.values()) for e in t['ring']] == [tuple(e) for e in h2_state(ch)['ring']], str(t))
if L: print('\n'.join(read_mf.summary_tap(t)))

print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
