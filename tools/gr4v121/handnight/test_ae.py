# SPDX-License-Identifier: GPL-2.0-only
"""mf18 night mode's shutter limit (handnight.ts SHUTTER_CAP, the research notes T7o) in the emulator: the stock AE
program dispatcher 0x536A21C4 (P 0x536A2074 with its 4 program lines, Tv 0x536A0FC0, Av 0x536A1218, M+ISO auto 0x536A0D74,
M / B / T 0x536A0BE8) run on the base build and on the test build, whose I+0x74 getter 0x536A865C is hooked.  Swept: AE mode
(I+0x39) 0..6, auto ISO (I+0x9C) on / off, still / movie (byte I+8), the switch on / off, EV -6 .. +6 (s0 and I+0x64), program
line (I+0xC) 0..3, the user's Tv (I+0x94) 1/2 s and 1/250, the dispatcher's r1 0 / 1.
Expected: the test build = the base build bit for bit (Tv, Av, Sv, the warning flags I+0xF9 / +0xFA, every byte of the AE object
and of the program object) everywhere except switch on + still + auto ISO + mode P or Av, where it equals the base build run with
I+0x74 = max(I+0x74, 5.0) (the stock program with an absolute slowest Tv of 1/30 s; every byte but I+0x74 itself): Tv never slower than 1/30, at the ISO
upper limit (Sv 13 = ISO 25600) with the stock warning flags where the base build went slower.
Replaced (blind spot): 0x5396C000 (a helper of program lines 3..5, answers 4.0, as in the read-only study).  The AE object is
a zeroed stand-in with the fields the programs read (f/2.8 .. f/16, fastest Tv 1/2500, ISO 100 .. 25600, slowest auto-ISO Tv
1/30, absolute slowest Tv 30 s as the still setting writes it).
A test build without the hook (SHUTTER_CAP false = mf17) must equal the base build in every case.
usage: test_ae.py BASE_RTOS TEST_RTOS"""
import os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim
from unicorn import UC_HOOK_CODE, UcError
from unicorn.arm_const import *

BASE_RTOS, TEST_RTOS = sys.argv[1:3]
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok

DISPATCH, GETTER, HELPER = 0x536A21C4, 0x536A865C, 0x5396C000
THIS, I = sim.OBJ + 0x3900000, sim.OBJ + 0x3901000
f2u = lambda x: struct.unpack('<I', struct.pack('<f', x))[0]
u2f = lambda x: struct.unpack('<f', struct.pack('<I', x))[0]


def cam(rtos):
    c = sim.Cam(rtos)
    def helper(uc, *_):
        uc.reg_write(UC_ARM_REG_S0, f2u(4.0)); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    c.mu.hook_add(UC_HOOK_CODE, helper, begin=HELPER, end=HELPER)
    c.getter_calls = 0
    def getter(uc, *_): c.getter_calls += 1
    c.mu.hook_add(UC_HOOK_CODE, getter, begin=GETTER, end=GETTER)
    return c


def run(c, mode, auto, movie, sw, ev, line, user_tv, r1, t74=-5.0):
    c.wb(I, bytes(0x400)); c.wb(THIS, bytes(0x100))
    c.w32(THIS + 4, THIS + 0x80); c.w32(THIS + 0x84, I); c.w32(THIS + 8, I)
    for off, v in ((0xEC, 3.0), (0xF0, 9.0), (0x70, 11.33), (0xA0, 5.0), (0xA4, 13.0), (0x10C, 8.0), (0x20, 5.0), (0x74, t74),
                   (0x94, user_tv), (0x98, 3.0), (0x64, float(ev))):
        c.w32(I + off, f2u(v))
    c.w8(I + 0x39, mode); c.w8(I + 0x9C, auto); c.w8(I + 8, movie); c.w16(I + 0xC, line)
    c.w8(sim.SWITCH, 1 if sw else 0)
    c.mu.reg_write(UC_ARM_REG_S0, f2u(float(ev)))
    c.getter_calls = 0
    try:
        c.call(DISPATCH, THIS, r1, count=2_000_000)
    except UcError as e:
        return ('error', str(e), hex(c.reg(UC_ARM_REG_PC)))
    return (round(u2f(c.r32(I + 0xD0)), 6), round(u2f(c.r32(I + 0xD4)), 6), round(u2f(c.r32(I + 0xD8)), 6), c.r8(I + 0xF9), c.r8(I + 0xFA),
            c.rb(I, 0x400), c.rb(THIS, 0x100), c.getter_calls)


base, test = cam(BASE_RTOS), cam(TEST_RTOS)
check('base build: the getter 0x536A865C is the stock vldr s0, [r0, #0x74]; bx lr', base.r32(GETTER) == 0xED900A1D and base.r32(GETTER + 4) == 0xE12FFF1E)
HOOKED = (test.r32(GETTER) >> 24) == 0xEA                  # SHUTTER_CAP of the test build (false: mf17, no hook)
check('test build: the getter is a branch (the hook), the next word as stock' if HOOKED else 'test build without SHUTTER_CAP: the getter is the stock word',
      (HOOKED or test.r32(GETTER) == 0xED900A1D) and test.r32(GETTER + 4) == 0xE12FFF1E)
n = same = capped = changed = 0
bad_same, bad_cap, errors = [], [], []
slow_base = slow_test = 0
for mode in range(7):
    for auto in (1, 0):
        for movie in (0, 1):
            for sw in (0, 1):
                for line in ((0, 1, 2, 3) if mode == 0 else (0,)):
                    for user_tv in (1.0, 8.0):
                        for r1 in (0, 1):
                            for ev in range(-6, 7):
                                n += 1
                                b = run(base, mode, auto, movie, sw, ev, line, user_tv, r1)
                                t = run(test, mode, auto, movie, sw, ev, line, user_tv, r1)
                                if b[0] == 'error' or t[0] == 'error':
                                    errors.append((mode, auto, movie, sw, ev, line, b[:3], t[:3])); continue
                                target = HOOKED and sw and not movie and auto == 1 and mode in (0, 2)
                                if not target:
                                    same += 1
                                    if b[:7] != t[:7]: bad_same.append((mode, auto, movie, sw, ev, line, user_tv, r1, b[:5], t[:5]))
                                    continue
                                capped += 1
                                ref = run(base, mode, auto, movie, sw, ev, line, user_tv, r1, t74=5.0)   # the stock program, slowest Tv 1/30
                                m74 = lambda r: r[:5] + (r[5][:0x74] + r[5][0x78:], r[6])   # (I+0x74 itself: 5.0 in the reference run)
                                ok = m74(ref) == m74(t) and t[0] >= 5.0 - 1e-6
                                if b[0] < 5.0 - 1e-6:
                                    slow_base += 1
                                    ok = ok and abs(t[0] - 5.0) < 1e-6 and abs(t[2] - 13.0) < 1e-6 and (t[4] == 1)
                                    changed += 1
                                else:
                                    ok = ok and b[:7] == t[:7]
                                if t[0] < 5.0 - 1e-6: slow_test += 1
                                if not ok: bad_cap.append((mode, auto, movie, sw, ev, line, user_tv, r1, b[:5], t[:5], ref[:5]))
check(f'{n} cases, no emulation error in either build', not errors, str(errors[:3]))
check(f'outside the target (switch off, movie, fixed ISO, Tv / M+ISO auto / M / B / T): test build = base build in Tv, Av, Sv, the flags and every byte of both objects ({same} cases)',
      not bad_same, str(bad_same[:3]))
if HOOKED:
    check(f'target (switch on, still, auto ISO, P or Av): test build = the stock program with I+0x74 = 1/30, never slower than 1/30 ({capped} cases)', not bad_cap, str(bad_cap[:3]))
    check(f'target: where the base build went slower than 1/30 ({slow_base} cases) the test build gives exactly 1/30 at Sv 13 (ISO 25600) with I+0xFA set ({changed})',
          slow_base > 0 and changed == slow_base and slow_test == 0)
# a few rows to read
print('    examples (mode, auto ISO, EV -> base Tv / Sv / f9 fa | test Tv / Sv / f9 fa):')
for mode in (0, 2, 1, 4):
    for ev in (2, -1, -4):
        b = run(base, mode, 1, 0, 1, ev, 0, 1.0, 1); t = run(test, mode, 1, 0, 1, ev, 0, 1.0, 1)
        print(f'      mode {mode} EV {ev:+d}: base Tv {b[0]:6.3f} Sv {b[2]:6.3f} {b[3]}{b[4]} | test Tv {t[0]:6.3f} Sv {t[2]:6.3f} {t[3]}{t[4]}')
print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
