# SPDX-License-Identifier: GPL-2.0-only
"""Front-end tests of the multi-frame NR test build: the camera's per-frame decision of a burst (step 0x31D,
0x5367F838, with the stub at 0x5367F904) and its end-of-frame step (0x3FE, 0x5367FA00, which starts the next plan),
in the base build and in the test build, for frames already taken 0..4 x stop requested (SEQ+0xF1) 0 / 1 x switch off / on
x drive single / continuous / bracket x ISO step of the frame (ShootingInfo +0xBA0) below / at / above the gate (27 = ISO 3200 since mf13; 24, ISO 1600, up to mf12):
with the switch on, continuous drive, a frame below the gate is told to stop at once (an ordinary single shot).  mf17: the gate is
"ISO step >= 27 or EV100 = Av + Tv - (Sv - 5) <= 3.9"; the frames here have the user's usual exposure (Tv 6 = 1/60, Av 3 = f/2.8,
EV100 = 4 at ISO 3200, so the ISO line decides as before), plus cases with a slow shutter (Tv 3 = 1/8) where the EV line lets a
low-ISO frame in.  Replaced by Python: the plan starter 0x53688048 (records the plan), the debug
flag 0x53891F18 (0), the count notifications 0x53689374 / 0x536894D8, the AE/record calls 0x5376DCA8 / 0x5376F5D4 and
their holder 0x53750008, the event setter 0x53902F30, assert.
usage: test_fe.py BASE_RTOS TEST_RTOS"""
import os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

BASE_RTOS, TEST_RTOS = sys.argv[1:3]
DECIDE, FINISH = 0x5367F838, 0x5367FA00
STUBS = {0x53688048: 'plan', 0x53891F18: 'flag', 0x53689374: 'notify1', 0x536894D8: 'notify2', 0x5376DCA8: 'ae', 0x5376F5D4: 'rec',
         0x53902F30: 'event', 0x539154F8: 'assert'}
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok


GATE = int(__import__('re').search(r'#define ISO_GATE_STEP (\d+)', open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mfmod.c')).read()).group(1))   # 24 (ISO 1600) final build, 27 mf13..mf19
TV, AV = 6.0, 3.0                                   # 1/64 s, f/2.83: EV100 = 9 - (Sv - 5)
def ev100(step, tv=TV, av=AV): return av + tv - (1 + step / 3 - 5)
def gated_in(step, tv=TV, av=AV): return step >= GATE or round(ev100(step, tv, av) * 256) <= 998
def run(rtos, switch, before, f1, drive, step=GATE, mem=None, tv=TV, av=AV):
    c = sim.Cam(rtos); calls = []
    if mem is not None: c.free[1] = [mem]          # IMAGE2 free (one block)
    SEQ, ENTRY, SI, HOLD = sim.OBJ + 0x10000, sim.OBJ + 0x20000, sim.OBJ + 0x40000, sim.OBJ + 0x30000
    c.wb(SEQ, bytes(0x400)); c.wb(ENTRY, bytes(0x2000)); c.wb(SI, bytes(0x1000)); c.wb(HOLD, bytes(0x100))
    c.w32(ENTRY + 0x10, SI); c.w8(SI + 0x7BC, drive); c.w32(SEQ + 0x104, before); c.w8(SEQ + 0xF1, f1); c.w32(SEQ + 0xA4, sim.OBJ + 0x31000)
    c.w32(SEQ + 0x108, 0); c.w8(sim.SWITCH, switch); c.w32(SI + 0xBA0, sim.f32(1 + step / 3))
    c.w32(SI + 0xB9C, sim.f32(tv)); c.w32(SI + 0xB98, sim.f32(av))
    def stub(uc, addr, size, user):
        name = STUBS[addr]
        calls.append((name, [uc.reg_read(r) for r in sim.REGS[:3]] if name != 'plan' else uc.reg_read(UC_ARM_REG_R1)))
        c._ret(0)
    for a in STUBS: c.mu.hook_add(UC_HOOK_CODE, stub, begin=a, end=a)
    c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(HOLD), begin=0x53750008, end=0x53750008)
    for r, v in zip(sim.REGS[4:12], range(0x11110000, 0x11190000, 0x10000)): c.mu.reg_write(r, v)
    ret = c.call(DECIDE, SEQ, ENTRY)
    regs = [c.reg(r) for r in sim.REGS[4:12]] + [c.reg(UC_ARM_REG_SP)]
    state = dict(ret=ret, s959=c.r8(SI + 0x959), s95a=c.r8(SI + 0x95A), index=c.r32(SI + 0x960), count=c.r32(SEQ + 0x104), f8=c.r8(SEQ + 0xF8),
                 f0=c.r8(SEQ + 0xF0), f1=c.r8(SEQ + 0xF1), calls=list(calls), regs=regs, seq=sim.sha(c.rb(SEQ, 0x400)), si=sim.sha(c.rb(SI, 0x1000)))
    calls.clear()
    c.call(FINISH, SEQ, ENTRY)
    state['plans'] = [p for n, p in calls if n == 'plan']; state['after'] = [n for n, _ in calls]
    state['ram'] = sim.sha(c.rb(0x55000000, 0x01000000))
    return state


for drive, step, tv in [(1, 23, TV), (1, 24, TV), (1, 26, TV), (1, 27, TV), (1, 28, TV), (1, 30, TV), (1, 36, TV), (0, 26, TV), (0, 27, TV), (2, 26, TV), (2, 30, TV),
                        (1, 20, 3.0), (1, 23, 3.0), (1, 14, 3.0), (1, 18, 4.0)]:
    for before in range(5):
        for f1 in (0, 1):
            base = run(BASE_RTOS, 0, before, f1, drive, step, tv=tv)
            off = run(TEST_RTOS, 0, before, f1, drive, step, tv=tv)
            on = run(TEST_RTOS, 1, before, f1, drive, step, tv=tv)
            tag = f'drive {drive}, ISO step {step}, Tv {tv} (EV100 {ev100(step, tv):.2f}), {before} frames before this one, stop requested {f1}'
            check(f'{tag}: switch off = base build (decision, flags, plans, registers, objects, RAM)', off == base)
            if drive != 1:
                on_cmp = dict(on); on_cmp.pop('ram'); b2 = dict(base); b2.pop('ram')
                check(f'{tag}: switch on = base build (the hook is only on the continuous path)', on_cmp == b2)
                continue
            want_stop = before + 1 >= 4 or not gated_in(step, tv)
            ref = run(BASE_RTOS, 0, before, 1 if want_stop else 0, drive, step, tv=tv)    # the stock outcome for the answer the module gives
            o = dict(on); r = dict(ref)
            for k in ('ram', 'seq'): o.pop(k); r.pop(k)
            o.pop('f1'); r.pop('f1')
            check(f'{tag}: switch on -> {"stop" if want_stop else "continue"}, exactly the stock outcome of that answer', o == r,
                  f"on {on['ret'], on['s959'], on['s95a'], on['plans']} ref {ref['ret'], ref['s959'], ref['s95a'], ref['plans']}")
            check(f'{tag}: switch on -> next plan {3 if want_stop else 1}', on['plans'] == [3 if want_stop else 1], str(on['plans']))
            check(f'{tag}: switch on keeps the stop request byte as it was', on['f1'] == f1)
# ---- memory gate (log version 9): at frame 1 (no frame before), IMAGE2 free below 500 MB -> stop: an ordinary single shot ----
MB = 1 << 20
for mem in (500 * MB - 1, 500 * MB, 500 * MB + 1, 291 * MB, 698 * MB):
    for step in (27, 30):
        for before in range(5):
            for f1 in (0, 1):
                on = run(TEST_RTOS, 1, before, f1, 1, step, mem)
                want_stop = before + 1 >= 4 or (before == 0 and mem < 500 * MB)
                ref = run(BASE_RTOS, 0, before, 1 if want_stop else 0, 1, step, mem)
                o = dict(on); r = dict(ref)
                for k in ('ram', 'seq', 'f1'): o.pop(k); r.pop(k)
                tag = f'memory gate: IMAGE2 {mem} bytes free, ISO step {step}, {before} frames before, stop requested {f1}'
                check(f'{tag}: -> {"stop" if want_stop else "continue"}, exactly the stock outcome of that answer', o == r and on['plans'] == [3 if want_stop else 1],
                      f"on {on['ret'], on['plans']} ref {ref['ret'], ref['plans']}")
                check(f'{tag}: the stop request byte as it was', on['f1'] == f1)

# ---- the front-end ring (log version 8): each entry also holds the frame's ISO step and whether the gate answered ------------
def ring(steps):
    c = sim.Cam(TEST_RTOS)
    SEQ, ENTRY, SI, HOLD = sim.OBJ + 0x10000, sim.OBJ + 0x20000, sim.OBJ + 0x40000, sim.OBJ + 0x30000
    for a in STUBS: c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(0), begin=a, end=a)
    c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(HOLD), begin=0x53750008, end=0x53750008)
    c.w8(sim.SWITCH, 1); answers = []
    for st in steps:
        c.wb(SEQ, bytes(0x400)); c.wb(ENTRY, bytes(0x2000)); c.wb(SI, bytes(0x1000)); c.wb(HOLD, bytes(0x100))
        c.w32(ENTRY + 0x10, SI); c.w8(SI + 0x7BC, 1); c.w32(SEQ + 0xA4, sim.OBJ + 0x31000); c.w32(SI + 0xBA0, sim.f32(1 + st / 3))
        c.w32(SI + 0xB9C, sim.f32(TV)); c.w32(SI + 0xB98, sim.f32(AV))
        answers.append(c.call(DECIDE, SEQ, ENTRY))
    st = c.r32(sim.SLOT)
    mem = struct.unpack('<%dI' % 0x1000, c.rb(st, 0x4000)) if st else ()
    return c, st, mem, answers
c, st, mem, ans = ring([GATE - 1])
check(f'ring: a gated frame (ISO step {GATE - 1}) with no state yet makes no state (no allocation)', st == 0 and not c.allocs)
c, st, mem, ans = ring([30, 26, 27, 24])
want = [x | (0 if gated_in(x) else 0x10000) for x in (30, 26, 27, 24)]
at = next((i for i in range(len(mem) - 3) if list(mem[i:i + 4]) == want), None)
check(f'ring: entries ISO step 30, 26, 27, 24 in order, bit 16 where the gate ({GATE}) answered',
      st != 0 and at is not None and all(ans[i] == (0 if gated_in(x) else 1) for i, x in enumerate((30, 26, 27, 24)) if i), str(([hex(x) for x in want], ans)))

print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
