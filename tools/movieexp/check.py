# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the movie exposure test (core/src/fw/gr4v120/aspect/movieexp.ts), GR IV 1.20 and 1.21.

NOT part of the program. Runs the firmware's own update of the shooting mode (the part from the
mode dial to the exposure mode handed to the auto exposure, 0x53259A44..0x53259B30 in 1.20) in
Unicorn, on the official RTOS and on a build with the test, for every combination of the inputs:

  mode dial, still / movie, the user mode's own mode, the three "auto off" flags, ISO setting AUTO
  or not, ISO auto in M, the two Sn settings, shutter speed at B / T, the bulb gate, and the
  controller's own exposure setting (byte 0x0B).

Checked:
  1. official, movie: the virtual mode is P whatever the dial (what the manual says);
  2. built, still: exactly the official's still (modes, flags, every setter call);
  3. built, movie: exactly the official's STILL for the same inputs, except that the bulb / time
     exposure modes (9, 10) never come out: P (0) instead;
  4. built, movie, dial at P, ISO AUTO: exactly the official's movie.

    python3 check.py 1.20|1.21 OFFICIAL-RTOS BUILT-RTOS
"""
import itertools
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R11, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC

BASE = 0x53000000
A120 = dict(start=0x53259a44, stop=0x53259b30, single=0x532406a4, settings=0x53240c38, log=0x539154f8,
            setters={0x532af6b8: 'base', 0x532af844: 'virtual', 0x532af9d0: 'virtual0', 0x532b0000: 'tvAuto', 0x532b018c: 'avAuto', 0x532b0318: 'svAuto'})
SHIFT121 = dict(start=0x84c, stop=0x84c, single=0x608, settings=0x608, log=0xd38, setters=0x850)
LIVE, CTRL, STACK = 0x60000000, 0x61000000, 0x70000000
DIALS = [3, 5, 6, 8, 9, 11, 12, 13]  # P, Tv, Av, M, Sn, U1..U3
USER_MODES = [0, 1, 2, 4, 5, 7]


def addresses(release):
    if release == '1.20':
        return A120
    s = SHIFT121
    return dict(start=A120['start'] + s['start'], stop=A120['stop'] + s['stop'], single=A120['single'] + s['single'],
                settings=A120['settings'] + s['settings'], log=A120['log'] + s['log'],
                setters={a + s['setters']: n for a, n in A120['setters'].items()})


class Machine:
    def __init__(self, path, adr):
        img = open(path, 'rb').read()
        self.adr = adr
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(img) + 0xfff) & ~0xfff
        self.uc.mem_map(BASE, size)
        self.uc.mem_write(BASE, img)
        for base in (LIVE, CTRL, STACK):
            self.uc.mem_map(base, 0x10000)
        self.calls = []
        ret = lambda uc: uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

        def single(uc, a, s, u):
            ret(uc)

        def settings(uc, a, s, u):
            uc.reg_write(UC_ARM_REG_R0, LIVE); ret(uc)

        def log(uc, a, s, u):
            self.calls.append(('LOG', 0)); ret(uc)

        def setter(uc, a, s, u):
            self.calls.append((adr['setters'][a], uc.reg_read(UC_ARM_REG_R1) & 0xff)); ret(uc)

        self.uc.hook_add(UC_HOOK_CODE, single, begin=adr['single'], end=adr['single'])
        self.uc.hook_add(UC_HOOK_CODE, settings, begin=adr['settings'], end=adr['settings'])
        self.uc.hook_add(UC_HOOK_CODE, log, begin=adr['log'], end=adr['log'])
        for a in adr['setters']:
            self.uc.hook_add(UC_HOOK_CODE, setter, begin=a, end=a)

    def run(self, live, ctrl):
        uc = self.uc
        uc.mem_write(LIVE, bytes(0x2000)); uc.mem_write(CTRL, bytes(0x100)); uc.mem_write(STACK, bytes(0x10000))
        for off, v in live.items():
            uc.mem_write(LIVE + off, bytes([v]))
        for off, v in ctrl.items():
            uc.mem_write(CTRL + off, bytes([v]))
        fp = STACK + 0x8000
        uc.reg_write(UC_ARM_REG_R11, fp); uc.reg_write(UC_ARM_REG_SP, fp - 0x4c)
        uc.reg_write(UC_ARM_REG_R4, CTRL); uc.reg_write(UC_ARM_REG_R5, 0x12345678)
        self.calls = []
        uc.emu_start(self.adr['start'], self.adr['stop'], count=20000)
        if uc.reg_read(UC_ARM_REG_PC) != self.adr['stop']:
            raise SystemExit(f'did not reach the end: pc 0x{uc.reg_read(UC_ARM_REG_PC):08x} {live} {ctrl}')
        flags = tuple(uc.mem_read(fp - k, 1)[0] for k in (0x33, 0x32, 0x31))
        return (uc.reg_read(UC_ARM_REG_R0) & 0xff, flags, tuple(self.calls))


def cases():
    for dial in DIALS:
        for user in (USER_MODES if dial >= 11 else [0]):
            for dis in itertools.product((0, 1), repeat=3):
                for iso_auto, m_iso_auto, sn_a, sn_b in itertools.product((0, 1), repeat=4):
                    for bulb in (0, 1, 2, 3):
                        for gate in (0, 1, 2):
                            for own in (7, 0, 4):
                                yield dict(dial=dial, user=user, dis=dis, iso_auto=iso_auto, m_iso_auto=m_iso_auto, sn_a=sn_a, sn_b=sn_b, bulb=bulb, gate=gate, own=own)


def inputs(c, movie):
    live = {0xb4b: c['user'], 0xb4c: c['dis'][0], 0xb4d: c['dis'][1], 0xb4e: c['dis'][2], 0xb74: c['gate'], 0xb76: movie,
            0xc18: c['sn_a'], 0xc35: c['sn_b'], 0xc3d: c['bulb'], 0xc3f: c['iso_auto'], 0xc40: c['m_iso_auto']}
    ctrl = {0x0b: c['own'], 0x15: c['dial'], 0x16: 1}
    return live, ctrl


def main():
    release, official, built = sys.argv[1:4]
    adr = addresses(release)
    off, new = Machine(official, adr), Machine(built, adr)
    n = 0
    bad = []
    seen_modes = {'official still': set(), 'official movie': set(), 'built movie': set()}
    replaced = 0

    def virtual(result):
        return [v for name, v in result[2] if name == 'virtual']

    for c in cases():
        n += 1
        os_, om = off.run(*inputs(c, 0)), off.run(*inputs(c, 1))
        ns, nm = new.run(*inputs(c, 0)), new.run(*inputs(c, 1))
        seen_modes['official still'].add(os_[0]); seen_modes['official movie'].add(om[0]); seen_modes['built movie'].add(nm[0])
        if virtual(om) != [0]:
            bad.append(('1 official movie is not P', c, om))
        if ns != os_:
            bad.append(('2 built still differs', c, os_, ns))
        want = os_
        if os_[0] in (9, 10):
            want = (0,) + os_[1:]; replaced += 1
        if nm != want:
            bad.append(('3 built movie is not the official still', c, want, nm))
        if nm[0] in (9, 10):
            bad.append(('3 bulb / time for a movie', c, nm))
        if c['dial'] == 3 and c['iso_auto'] == 1 and nm != om:
            bad.append(('4 built movie at P with ISO AUTO differs from the official movie', c, om, nm))
    for b in bad[:20]:
        print('FAIL', b)
    print(f'{release}: {n} cases x 4 runs; exposure modes seen:', {k: sorted(v) for k, v in seen_modes.items()}, f'; bulb / time replaced by P in {replaced} cases')
    print('FAILED' if bad else 'ok', len(bad))
    sys.exit(1 if bad else 0)


main()
