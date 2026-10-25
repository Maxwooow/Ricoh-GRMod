# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of Direct Flash (core/src/fw/aspect/directflash.ts). NOT part of the program.

    python3 check.py BUILT-RTOS OFFICIAL-RTOS

BUILT-RTOS / OFFICIAL-RTOS: RTOS sections (decoded). Needs the Python package unicorn. The guide
number (byte 0x99A, 0 = 3), the background and the slowest shutter speed (bits 1..4 and 5..7 of
byte 0x99B) are the camera-menu choices (`directflash-menu.ts`, checked by menu_check.py); the
exposure is checked with the defaults and with other choices.

 1. The exposure: the wrapper at 0x5367AAA8 calls the flash program (stubbed) and then the module
    with the exposure object; the module, run on exposure records filled for 2000+ situations
    (distance, ISO Auto / fixed ISO and their ranges, Flash Output, ND setting, scene brightness,
    exposure program and mode, flash kind), leaves exactly what a straightforward Python version of
    the rule computes, within 1/1000 EV, and the camera's own flash-sync function (0x536792E0) is
    what limits the shutter. Every result is inside f/2.8..f/16, the ISO range, the sync limit and
    the slowest shutter speed chosen; the subject (flash + ambient light) is correctly exposed and
    the background as dark as chosen wherever the limits allow; with Flash Output 1/4 the plan is two stops brighter; where Direct Flash does not apply
    the record is left alone.
 2. The menus: the two menu lists, the ADJ lever and the Fn list, with and without slow sync, for
    every value index, setting byte (bit 0 off / on, other bits kept) and Flash Mode (0..3): count, text, icon, row draw,
    is-current and set; the other values reach the camera's own handlers with the same arguments.
 3. The current value's icon at its three places.
 4. Text 882 in all 21 languages and icon 733 (catalog entry, lookup bounds).
"""
import math
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_SP,
                               UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC, UC_ARM_REG_S0)

BASE = 0x53000000
RAMVA, RAMIMG, RAMLEN = 0x55000000, 0x5437b640, 0x57480
CURRENT = 0x55084dd8
BYTE = CURRENT + 4 + 0x99b
GN_BYTE = CURRENT + 4 + 0x99a
LIVE_FM = CURRENT + 0xbf8
OUTPUT = CURRENT + 0x114
CALL_SITE = 0x5367aaa8
FLASH_PROGRAM = 0x5367a7b4
SYNC = 0x536792e0
TEXT_ID, ICON_ID = 882, 733
APP, SETTINGS, GET_FM, SET_FM = 0x5323ea84, 0x5323f018, 0x532976ec, 0x532b1fdc
FLASH_ICON, LIST_ITEM, ITEM_SET_ICON, LABEL_SET_TEXT, ROW_SET = 0x53380cfc, 0x53570a9c, 0x5357dd98, 0x5357338c, 0x5357aef0
ADJ_RECORD = 0x53d9f714 + 9 * 0x5c
FN_RECORD = 0x53da09b4
ADJ = dict(flag=0x282, text=0x164, icons=0x1f8, slots=dict(text=0x10, icon=0x18, current=0x20, set=0x28, count=0x30),
           official=dict(text=0x531ba458, icon=0x531be3b8, current=0x531bb410, set=0x531bafd4, count=0x531ba16c))
FN = dict(flag=0x197, text=0x160, icons=0x178, slots=dict(text=0x04, icon=0x0c, current=0x14, set=0x1c, count=0x24),
          official=dict(text=0x531c0c5c, icon=0x531c22e8, current=0x531c12c4, set=0x531c0f10, count=0x531c0844))
LISTS = [dict(fixed=4, slots=dict(count=0x0c, draw=0x14, set=0x24, current=0x2c),
              official=dict(count=0x531cf1e0, draw=0x531d033c, set=0x531d2ae0, current=0x531d4388)),
         dict(fixed=2, slots=dict(count=0x0c, draw=0x14, set=0x24, current=0x2c),
              official=dict(count=0x531cf1e8, draw=0x531d03a0, set=0x531d2b10, current=0x531d43bc))]
ICON_SITES = [0x531b0800, 0x531e0d6c, 0x5339787c]
STOP = 0x100
NAMES = {0: 'ダイレクト発光', 1: 'Direct Flash', 19: '直闪模式', 18: '直閃模式'}

failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


def f32(v):
    return struct.unpack('<f', struct.pack('<f', v))[0]


class Image:
    def __init__(self, path):
        self.R = open(path, 'rb').read()

    def off(self, va):
        if RAMVA <= va < RAMVA + RAMLEN:
            va = RAMIMG + va - RAMVA
        return va - BASE

    def u32(self, va):
        return struct.unpack_from('<I', self.R, self.off(va))[0]

    def branch(self, at):
        w = self.u32(at)
        d = w & 0xffffff
        if d & 0x800000:
            d -= 1 << 24
        return at + 8 + d * 4

    def movw_movt(self, at):
        """The 32-bit value of a movw at `at` and the movt that follows (same register)."""
        a, b = self.u32(at), self.u32(at + 4)
        return ((((b >> 4) & 0xf000) | (b & 0xfff)) << 16) | (((a >> 4) & 0xf000) | (a & 0xfff))


class Emu:
    def __init__(self, img):
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, max((len(img.R) + 0xfffff) & ~0xfffff, 0x1600000))
        mu.mem_write(BASE, img.R)
        mu.mem_map(RAMVA, 0x1000000)
        mu.mem_write(RAMVA, img.R[RAMIMG - BASE:RAMIMG - BASE + RAMLEN])
        mu.mem_map(0x60000000, 0x100000)
        mu.mem_map(0x70000000, 0x100000)
        mu.mem_map(0, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        for g in (0x5508207c, 0x55082234, 0x55082184):  # singletons constructed
            mu.mem_write(g, struct.pack('<I', 1))
        self.mu = mu
        self.calls = []
        self.stubs = {}
        mu.hook_add(UC_HOOK_CODE, self._hook)

    def _hook(self, uc, addr, size, ud):
        if addr in self.stubs:
            lr = uc.reg_read(UC_ARM_REG_LR)
            args = tuple(uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2))
            name, ret = self.stubs[addr]
            self.calls.append((name,) + args)
            if ret is not None:
                uc.reg_write(UC_ARM_REG_R0, ret)
            uc.reg_write(UC_ARM_REG_PC, lr)

    def call(self, fn, *args):
        mu = self.mu
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), args):
            mu.reg_write(r, v)
        mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
        mu.reg_write(UC_ARM_REG_LR, STOP)
        mu.emu_start(fn, STOP, count=2_000_000)
        if mu.reg_read(UC_ARM_REG_PC) != STOP:
            raise RuntimeError(f'{fn:#x} did not return')
        return mu.reg_read(UC_ARM_REG_R0)

    def w8(self, a, v):
        self.mu.mem_write(a, bytes([v & 0xff]))

    def r8(self, a):
        return self.mu.mem_read(a, 1)[0]

    def w32(self, a, v):
        self.mu.mem_write(a, struct.pack('<I', v & 0xffffffff))

    def w16(self, a, v):
        self.mu.mem_write(a, struct.pack('<H', v & 0xffff))

    def wf(self, a, v):
        self.mu.mem_write(a, struct.pack('<f', v))

    def rf(self, a):
        return struct.unpack('<f', self.mu.mem_read(a, 4))[0]


# --- 1. Exposure ------------------------------------------------------------------------------
def sync_rule(av, hs):
    """The camera's flash-sync limit (0x536792E0) as read from its code, for the cross-check."""
    if hs:
        return 14.0
    if av <= f32(4.0001):
        return f32(11.333333)
    return f32(11.666667) if av <= f32(4.6668) else 12.0


def choices(s):
    """(GN, background EV darker, slowest Tv, Max Sync) from the two setting bytes, as the camera
    menu keeps them."""
    gn = (s['gnb'] & 63) or 3
    k = (s['byte'] >> 1) & 15
    if k == 0 or k > 9:
        k = 3
    n = s['byte'] >> 5
    return gn, k / 3, 5.0 if n == 0 else float(5 - n) if n <= 5 else float(n), (s['gnb'] >> 6) & 1


def reference(s, flip=False):
    """The rule, straightforwardly. Returns (tv, av, sv, nd, err, background) or None when Direct
    Flash does not apply."""
    if not s['byte'] & 1 or s['fm'] != 0 or s['program'] > 4 or s['mode'] == 7 or 1 <= s['kind'] <= 4 or s['mm'] == 0:
        return None
    gn, bg, slowest, sync_first = choices(s)
    mm = min(max(s['mm'], 100), 8000)
    f0 = 2 * math.log2(gn) - 2 * math.log2(mm / 1000)
    if s['output'] == 2:
        f0 -= 2
    sv_lo, sv_hi = s['sv_min'], s['sv_max']
    if s['isoauto']:
        a, b = sorted((s['auto_lo'], s['auto_hi']))
        sv_lo, sv_hi = max(sv_lo, a), min(sv_hi, b)
        if sv_lo > sv_hi:
            sv_hi = sv_lo
    else:
        sv_lo = sv_hi = min(max(s['fixed'], sv_lo), sv_hi)
    av_lo, av_hi = max(s['av_min'], 2.9708536), min(s['av_max'], 8.0)
    av_lo = min(av_lo, av_hi)
    tv_lo, tv_hi = slowest, s['tv_max']   # (the camera's own minimum, tv_min, is not for Direct Flash)
    tv_lo = min(tv_lo, tv_hi)
    c = bg + math.log2(1 - 2 ** -bg)

    def solve_at(nd, floor):
        # Flash share 2^(f - 5 - (av - sv)), ambient share 2^(ev - 5 - 2nd - (av - sv) - tv); sum 1.
        f = f0 - 2 * nd
        e = s['ev'] - 5 - 2 * nd
        tv = want = min(max(s['ev'] - f0 + c, tv_lo), tv_hi)
        for _ in range(2):
            x = math.log2(2 ** (f - 5) + 2 ** (e - tv))
            sv = min(max(floor - x, sv_lo), sv_hi)
            av = min(max(sv + x, floor), av_hi)
            th = min(sync_rule(f32(av), s['hs']), tv_hi)
            if tv <= th:
                break
            tv = th
        tv = min(tv, th)
        # Too bright at the smallest aperture and lowest ISO: the shutter faster (test 058), to a
        # correct exposure where the flash alone is not too bright, else up to the sync limit.
        if x - (av - sv) > 0.01 and tv < th:
            fl, lim = 2 ** (f - 5), 2 ** (av - sv)
            t = th if fl >= lim * 0.999 else e - math.log2(lim - fl)
            if not sync_first:
                t = min(t, e - (av - sv) + bg)   # Low ISO: to the background chosen
            t = min(t, th)
            if t > tv:
                tv = t; x = math.log2(fl + 2 ** (e - tv))
        return dict(tv=tv, av=av, sv=sv, err=x - (av - sv), bg=e - (av - sv) - tv, want=want)

    def solve(nd):
        p = solve_at(nd, av_lo)
        if sync_first:
            # Max Sync: a smaller aperture (higher ISO) where the sync limit holds the shutter back.
            for floor in (4.70, 4.02):
                if not p['tv'] < p['want'] - 0.01 or floor <= p['av'] or floor > av_hi:
                    continue
                q = solve_at(nd, floor)
                if q['tv'] > p['tv'] + 0.01 and abs(q['err']) <= abs(p['err']) + 0.001:
                    p = q
        return p

    nd = 1 if s['nd'] == 1 else 0
    p = solve(nd)
    if s['nd'] == 0:
        q = solve(1)
        use = p['err'] >= 1 and q['err'] > -1 and abs(q['err']) < abs(p['err']) - 0.5
        # flip: the other choice, for a situation right at the ND Auto threshold (float rounding).
        near = min(abs(p['err'] - 1), abs(q['err'] + 1), abs(abs(q['err']) - abs(p['err']) + 0.5)) < 1e-4
        if use != (flip and near):
            p, nd = q, 1
    return p['tv'], p['av'], p['sv'], nd, p['err'], p['bg']


def situations():
    base = dict(byte=1, gnb=0, fm=0, program=0, mode=0, kind=0x10, mm=1000, output=1, isoauto=1, auto_lo=5.0, auto_hi=10.0,
                fixed=7.0, sv_min=5.0, sv_max=15.0, av_min=2.9708536, av_max=8.0, tv_min=-5.0, tv_max=14.0, ev=5.0,
                nd=2, hs=0)
    yield dict(base)
    for mm in (50, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 8000, 20000):
        for iso in ((1, 5.0, 10.0), (1, 6.0, 8.0), (1, 5.0, 15.0), (0, 0, 0)):
            for fixed in (5.0, 7.0, 9.0):
                if not iso[0] and fixed != 7.0 and mm not in (500, 2000):
                    continue
                for output in (0, 1, 2):
                    for nd in (0, 1, 2):
                        for ev in (2.0, 8.0, 11.0, 13.0, 15.0):
                            for program in (0, 1, 2, 3, 4):
                                if program and (output, nd, ev) != (1, 2, 8.0):
                                    continue
                                s = dict(base, mm=mm, isoauto=iso[0], auto_lo=iso[1] or 5.0, auto_hi=iso[2] or 10.0, fixed=fixed,
                                         output=output, nd=nd, ev=ev, program=program)
                                yield s
    for k in [dict(byte=0), dict(byte=2), dict(byte=0xfe), dict(byte=0xff), dict(byte=0x1f), dict(gnb=1), dict(gnb=200), dict(fm=1), dict(fm=3), dict(program=5), dict(program=6), dict(mode=7), dict(kind=1),
              dict(kind=2), dict(kind=4), dict(kind=0), dict(mm=0), dict(hs=1, ev=15.0), dict(auto_lo=10.0, auto_hi=5.0),
              dict(av_min=3.5, av_max=7.0), dict(tv_min=6.0)]:
        yield dict(base, **k)


def check_exposure(img, gnb=0, high=0):
    """gnb: byte 0x99A; high: bits 1..7 of byte 0x99B, ORed into every situation's byte."""
    wrapper = img.branch(CALL_SITE)
    check(wrapper != FLASH_PROGRAM and wrapper >= BASE + 0x13d2ac0, 'the flash program call does not go to the wrapper')
    # The wrapper: push; mov r4,r0; bl flash program; mov r0,r4; movw/movt r1,ctx; pop; b module.
    check(img.branch(wrapper + 8) == FLASH_PROGRAM, 'the wrapper does not call the flash program first')
    ctx = img.movw_movt(wrapper + 16)
    module = img.branch(wrapper + 28)
    words = [img.u32(ctx + 4 * k) for k in range(6)]
    check(words[:5] == [BYTE, LIVE_FM, OUTPUT, SYNC, GN_BYTE], f'module context {[hex(w) for w in words]}')
    gn_default = 2 ** (struct.unpack('<f', struct.pack('<I', words[5]))[0] / 2)
    check(abs(gn_default - 3) < 1e-4, f'default guide number in the file {gn_default} (expected 3)')
    print(f'  wrapper {wrapper:#x}, module {module:#x}, context {ctx:#x}: default GN {gn_default:.3f}; byte 0x99A {gnb}, 0x99B bits {high:#x}')

    e = Emu(img)
    e.stubs[FLASH_PROGRAM] = ('flash program', None)
    ae, diag, apex, info = 0x70000000, 0x70001000, 0x70002000, 0x70003000
    e.w32(ae + 4, diag)
    e.w32(ae + 0x28, info)
    e.w32(diag + 4, apex)
    e.w32(apex + 4, info)
    n = applied = physics = balanced = borderline = faster = over = 0
    worst = 0.0
    sync_seen = set()
    for s in situations():
        s = dict(s, byte=s['byte'] | high, gnb=s['gnb'] or gnb)
        n += 1
        e.mu.mem_write(info, bytes(0x600))
        e.w8(BYTE, s['byte'])
        e.w8(GN_BYTE, s['gnb'])
        e.w8(LIVE_FM, s['fm'])
        e.w8(OUTPUT, s['output'])
        e.w8(info + 0x39, s['program'])
        e.w16(info + 0x3e, s['kind'])
        e.w16(info + 0x40, s['mode'])
        e.wf(info + 0x10, s['sv_max'])
        e.wf(info + 0x14, s['sv_min'])
        e.wf(info + 0x64, s['ev'])
        e.wf(info + 0x70, s['tv_max'])
        e.wf(info + 0x74, s['tv_min'])
        e.w8(info + 0x9c, s['isoauto'])
        e.wf(info + 0xa0, s['auto_lo'])
        e.wf(info + 0xa4, s['auto_hi'])
        e.wf(info + 0x10c, s['fixed'])
        e.wf(info + 0xec, s['av_min'])
        e.wf(info + 0xf0, s['av_max'])
        e.w8(info + 0x55d, s['nd'])
        e.w8(info + 0x5dd, s['hs'])
        e.w32(info + 0x584, s['mm'])
        for o, v in ((0xd0, 99.0), (0xd4, 98.0), (0xd8, 97.0)):
            e.wf(info + o, v)
        e.w8(info + 0x560, 0x77)
        e.calls.clear()
        e.call(wrapper, ae)
        check(e.calls[:1] == [('flash program', ae, e.calls[0][2] if e.calls else 0, e.calls[0][3] if e.calls else 0)],
              'the wrapper did not call the flash program with the exposure object')
        got = (e.rf(info + 0xd0), e.rf(info + 0xd4), e.rf(info + 0xd8), e.r8(info + 0x560))
        ref = reference(s)
        if ref is None:
            check(got == (99.0, 98.0, 97.0, 0x77), f'record changed where Direct Flash does not apply: {s} -> {got}')
            continue
        applied += 1
        alt = reference(s, flip=True)
        if alt != ref and alt[3] == got[3]:
            ref = alt  # right at the ND Auto threshold: either choice
            borderline += 1
        d = max(abs(a - b) for a, b in zip(got[:3], ref[:3]))
        worst = max(worst, d)
        check(d < 1e-3 and got[3] == ref[3], f'{s}: got {got}, expected {ref}')
        tv, av, sv, nd = got
        check(2.9708536 - 1e-4 <= av <= 8.0 + 1e-4, f'aperture outside f/2.8..f/16: {s} -> {got}')
        lo, hi = (min(s['auto_lo'], s['auto_hi']), max(s['auto_lo'], s['auto_hi'])) if s['isoauto'] else (s['fixed'], s['fixed'])
        lo, hi = max(lo, s['sv_min']), min(hi, s['sv_max'])
        check(lo - 1e-4 <= sv <= max(lo, hi) + 1e-4, f'ISO outside the range: {s} -> {got}')
        sync = sync_rule(av, s['hs'])
        sync_seen.add(round(sync, 3))
        gn, bg, slowest, sync_first = choices(s)
        check(tv <= sync + 1e-4 and tv >= min(slowest, sync, s['tv_max']) - 1e-4, f'shutter outside the slowest .. sync: {s} -> {got}')
        if s['nd'] == 2:
            check(nd == 0, f'ND used with ND Off: {s}')
        if sync_first:
            low = reference(dict(s, gnb=s['gnb'] & ~64))
            check(low is not None and tv >= low[0] - 1e-3, f'Max Sync slower than Low ISO: {s} -> {got} vs {low}')
            if low is not None and tv > low[0] + 1e-3:
                faster += 1
        # The physics, independently of the rule: flash and ambient shares of the subject's light.
        mm = min(max(s['mm'], 100), 8000)
        f = 2 * math.log2(gn) - 2 * math.log2(mm / 1000) - (2 if s['output'] == 2 else 0) - 2 * nd
        flash = 2 ** (f - 5 - (av - sv))
        amb = 2 ** (s['ev'] - 5 - 2 * nd - (av - sv) - tv)
        total = math.log2(flash + amb)
        at_limit = (av <= max(s['av_min'], 2.9708536) + 1e-4 and sv >= hi - 1e-4) or av >= min(s['av_max'], 8.0) - 1e-4
        if not at_limit:
            check(abs(total) < 2e-3, f'subject not correctly exposed ({total:+.3f} EV): {s} -> {got}')
            physics += 1
        else:
            check(abs(total - ref[4]) < 2e-3, f'error {total} vs rule {ref[4]}: {s}')
            # Test 058: still too bright at the smallest aperture and lowest ISO: Max Sync, the shutter as
            # fast as it syncs; Low ISO, the background no lighter than chosen.
            if total > 0.01 and av >= min(s['av_max'], 8.0) - 1e-4 and sv <= lo + 1e-4:
                if sync_first:
                    check(tv >= min(sync, s['tv_max']) - 1e-3, f'too bright ({total:+.3f} EV) with the shutter not at its limit: {s} -> {got}')
                else:
                    check(tv >= min(sync, s['tv_max']) - 1e-3 or math.log2(amb) <= -bg + 2e-3, f'too bright ({total:+.3f} EV), background {math.log2(amb):+.2f}: {s} -> {got}')
                over += 1
        # (At a sync limit, also one of a wider aperture: the rule's limits jump with the aperture.)
        tv_free = (min(slowest, s['tv_max']) + 1e-3 < tv < min(sync, s['tv_max']) - 1e-3
                   and all(abs(tv - f32(v)) > 1e-3 for v in (11.333333, 11.666667, 12.0, 14.0)))
        if tv_free and not at_limit:
            check(abs(math.log2(amb) + bg) < 2e-3, f'background {math.log2(amb):+.3f} EV, not {-bg}: {s} -> {got}')
            balanced += 1
    # Flash Output 1/4 is two stops brighter.
    pairs = 0
    for mm in (500, 1000, 2000, 3000, 5000, 8000):
        q = dict(next(situations()), mm=mm, isoauto=0, fixed=7.0, ev=-5.0)  # dark: the flash alone
        a = reference(dict(q, output=1, byte=1 | high, gnb=gnb))
        b = reference(dict(q, output=2, byte=1 | high, gnb=gnb))
        if 2.98 < b[1] and a[1] < 7.99:
            pairs += 1
            check(abs((a[1] - b[1]) - 2) < 1e-2, f'1/4 is not two stops: {a} {b}')
    check(pairs > 0, 'no distance to compare 1/1 and 1/4 at')
    print(f'  exposure: {n} situations, {applied} with Direct Flash, largest difference {worst:.2e} EV ({borderline} right at the ND Auto threshold), sync limits seen {sorted(sync_seen)}')
    gn, bg, slowest, sync_first = choices(dict(byte=1 | high, gnb=gnb))
    print(f'  subject correctly exposed in all {physics} not at an aperture / ISO limit; background {-bg:+.2f} EV in all {balanced} with a free shutter speed; too bright at f/16 and the lowest ISO: shutter at its limit in all {over}')
    if sync_first:
        print(f'  Max Sync: faster shutter speed than Low ISO in {faster} situations, never slower')
    # The camera's own sync function, called as the module does, is the rule above.
    for av in (2.97, 3.5, 4.0, 4.3, 4.7, 5.5, 8.0):
        for hs in (0, 1):
            e.w8(info + 0x5dd, hs)
            e.mu.reg_write(UC_ARM_REG_S0, struct.unpack('<I', struct.pack('<f', av))[0])
            e.call(SYNC, apex, 1)
            got = struct.unpack('<f', struct.pack('<I', e.mu.reg_read(UC_ARM_REG_S0)))[0]
            check(abs(got - sync_rule(f32(av), hs)) < 1e-6, f'sync limit at Av {av} (hs {hs}): camera {got}, rule {sync_rule(f32(av), hs)}')
    # A table of what to expect on the camera (dim room, ND off, Flash Output 1/1).
    print('  distance  ISO Auto 100-3200          fixed ISO 400')
    for mm in (500, 1000, 2000, 3000, 5000):
        r1 = reference(dict(next(situations()), mm=mm, byte=1 | high, gnb=gnb))
        r2 = reference(dict(next(situations()), mm=mm, isoauto=0, fixed=7.0, byte=1 | high, gnb=gnb))
        fmt = lambda r: f'f/{2 ** (r[1] / 2):4.1f} ISO {100 * 2 ** (r[2] - 5):5.0f} 1/{2 ** r[0]:4.0f}s'
        print(f'  {mm / 1000:4.1f} m    {fmt(r1)}    {fmt(r2)}')


# --- 2./3. Menus ------------------------------------------------------------------------------
def find_list_records(img):
    """Records 11 and 12 wherever the list table is now (the date imprint's menu moves it)."""
    out = []
    for k, L in enumerate(LISTS):
        found = None
        for at in range(0, len(img.R) - 0x30, 4):
            if struct.unpack_from('<4I', img.R, at) == (0x10000, 0x7f, 0, struct.unpack_from('<I', img.R, at + 12)[0]):
                draw = struct.unpack_from('<I', img.R, at + 0x14)[0]
                count = struct.unpack_from('<I', img.R, at + 0x0c)[0]
                if count >= BASE + 0x13d2ac0 and img.u32(count) == 0xe3a00000 | L['fixed'] and img.u32(count + 4) == 0xe2800001:
                    found = BASE + at
                    if at >= 0x13d2ac0:
                        break
        out.append(found)
    return out


def check_menus(img):
    e = Emu(img)
    e.stubs.update({SET_FM: ('SetFlashMode', 1), LABEL_SET_TEXT: ('label text', 0), ITEM_SET_ICON: ('item icon', 0),
                    LIST_ITEM: ('list item', 0x70008000), ROW_SET: ('row', 0)})
    sets = [('ADJ', ADJ_RECORD, ADJ), ('Fn', FN_RECORD, FN)]
    lists = find_list_records(img)
    check(all(lists), f'menu list records not found: {lists}')
    for k, rec in enumerate(lists):
        if rec:
            sets.append((f'menu list {k + 11}', rec, LISTS[k]))
    for name, rec, h in sets:
        for slot, off in h['slots'].items():
            got = img.u32(rec + off)
            check(got != h['official'][slot] and got >= BASE + 0x13d2ac0, f'{name}: {slot} handler not replaced')
            e.stubs[h['official'][slot]] = (f'official {slot}', 0x55)
        handler = {slot: img.u32(rec + off) for slot, off in h['slots'].items()}
        this = 0x70004000
        flags = [None] if 'fixed' in h else [0, 1]
        cases = 0
        for flag in flags:
            e.mu.mem_write(this, bytes(0x400))
            if flag is not None:
                e.w8(this + h['flag'], flag)
                e.w32(this + h['text'], 0x7000a000)
                e.w32(this + h['icons'], 0x7000b000)
            N = h['fixed'] if flag is None else (4 if flag else 2)
            e.calls.clear()
            check(e.call(handler['count'], this) == N + 1, f'{name}: count with flag {flag}')
            for byte in (0, 1, 7, 0x2c, 0xd3):
                for fm in (0, 1, 2, 3):
                    active = bool(byte & 1) and fm == 0
                    for i in range(N + 1):
                        cases += 1
                        e.w8(BYTE, byte)
                        e.w8(LIVE_FM, fm)
                        # current
                        e.calls.clear()
                        r = e.call(handler['current'], this, i)
                        if i == N:
                            check(r == int(active) and not any(c[0].startswith('official') for c in e.calls), f'{name}: current({i}) byte {byte} fm {fm} -> {r}')
                        elif active:
                            check(r == 0 and not any(c[0].startswith('official') for c in e.calls), f'{name}: current({i}) while Direct Flash -> {r}')
                        else:
                            check(r == 0x55 and ('official current', this, i, ) == e.calls[-1][:3], f'{name}: current({i}) not passed on: {e.calls}')
                        # set
                        e.calls.clear()
                        e.call(handler['set'], this, i)
                        if i == N:
                            check(e.r8(BYTE) == byte | 1 and ('SetFlashMode', CURRENT, 0) == e.calls[-1][:3], f'{name}: set({i}) -> byte {e.r8(BYTE)} calls {e.calls}')
                        else:
                            check(e.r8(BYTE) == byte & ~1 and ('official set', this, i) == e.calls[-1][:3], f'{name}: set({i}) -> byte {e.r8(BYTE)} calls {e.calls}')
                        e.w8(BYTE, byte)
                        # draw / text / icon
                        if 'draw' in handler:
                            e.calls.clear()
                            e.call(handler['draw'], this, 0x7000c000, i)
                            if i == N:
                                check(e.calls == [('row', 0x7000c000, ICON_ID, TEXT_ID)], f'{name}: draw({i}) {e.calls}')
                            else:
                                check(e.calls == [('official draw', this, 0x7000c000, i)], f'{name}: draw({i}) {e.calls}')
                        else:
                            e.calls.clear()
                            e.call(handler['text'], this, i)
                            if i == N:
                                check(e.calls == [('label text', 0x7000a000, TEXT_ID, 0)], f'{name}: text({i}) {e.calls}')
                            else:
                                check(e.calls[:1] == [('official text', this, i, e.calls[0][3] if e.calls else 0)], f'{name}: text({i}) {e.calls}')
                            e.calls.clear()
                            e.call(handler['icon'], this, i)
                            if i == N:
                                check(e.calls == [('list item', 0x7000b000, i, e.calls[0][3] if e.calls else 0), ('item icon', 0x70008000, ICON_ID, e.calls[1][3] if len(e.calls) > 1 else 0)], f'{name}: icon({i}) {e.calls}')
                            else:
                                check(e.calls[:1] == [('official icon', this, i, e.calls[0][3] if e.calls else 0)], f'{name}: icon({i}) {e.calls}')
        print(f'  {name}: {cases} cases')
    # Icon of the current value.
    e.stubs[FLASH_ICON] = ('official icon of value', 0x13e)
    target = None
    for site in ICON_SITES:
        t = img.branch(site)
        check(t != FLASH_ICON, f'{site:#x} still goes to the official icon function')
        check(target is None or t == target, 'the three sites do not share one function')
        target = t
    for byte in (0, 1, 2, 0x3b):
        for value in (0, 1, 2, 3):
            for variant in (0, 1):
                e.w8(BYTE, byte)
                e.calls.clear()
                r = e.call(target, 0x7000d000, value, variant)
                if byte & 1 and value == 0 and variant == 0:
                    check(r == ICON_ID and not e.calls, f'icon of current: byte {byte} value {value} -> {r}')
                else:
                    check(r == 0x13e and e.calls == [('official icon of value', 0x7000d000, value, variant)], f'icon of current: byte {byte} value {value} variant {variant} -> {r} {e.calls}')
    print('  icon of the current value: 32 cases')


# --- 4. Text and icon -------------------------------------------------------------------------
def check_resources(img):
    TEXT_CATALOG, ICON_CATALOG = 0x543d4ac0, 0x543d3ac0
    for lang, want in NAMES.items():
        row = img.u32(TEXT_CATALOG + lang * 4)
        d = img.u32(row + TEXT_ID * 4)
        units = img.R[img.off(d)]
        text = img.R[img.off(img.u32(d + 4)):img.off(img.u32(d + 4)) + (units - 1) * 2].decode('utf-16-le')
        check(text == want, f'text {TEXT_ID} language {lang}: {text!r} (expected {want!r})')
    filled = sum(1 for l in range(21) if img.u32(img.u32(TEXT_CATALOG + l * 4) + TEXT_ID * 4))
    check(filled == 21, f'text {TEXT_ID} in {filled} languages')
    d = img.u32(ICON_CATALOG + ICON_ID * 4)
    check(d != 0 and struct.unpack_from('<4H', img.R, img.off(d)) == (1, 40, 40, 0), f'icon {ICON_ID} descriptor')
    for site in (0x5323dbb4, 0x5323e40c):
        w = img.u32(site)
        check(((w >> 4) & 0xf000 | (w & 0xfff)) >= ICON_ID, f'icon lookup bound at {site:#x}')
    print(f'  text {TEXT_ID} in 21 languages, icon {ICON_ID} 40x40')


def main():
    new = Image(sys.argv[1])
    print('1. exposure (bytes 0: GN 3, background -1.0 EV, slowest 1/30 s, as on every camera)')
    check_exposure(new)
    print('1b. exposure (GN 12, background -2.0 EV, slowest 1/15 s)')
    check_exposure(new, 12, (6 << 1) | (1 << 5))
    print('1c. exposure (GN 36, background -0.3 EV, slowest 1/125 s)')
    check_exposure(new, 36, (1 << 1) | (7 << 5))
    print('1d. exposure (GN 2, background -3.0 EV, slowest 1 s; an unlisted GN 50)')
    check_exposure(new, 2, (9 << 1) | (5 << 5))
    check_exposure(new, 50, (12 << 1) | (3 << 5))
    print('1e. exposure priority Max Sync (bit 6 of 0x99A): defaults; GN 12 with -2.0 EV; GN 3 with -3.0 EV')
    check_exposure(new, 64)
    check_exposure(new, 64 | 12, 6 << 1)
    check_exposure(new, 64 | 3, 9 << 1)
    print('1f. test 058: GN 18, background -3.0 EV, slowest 1/125 s, Max Sync (a strong flash close by in daylight)')
    check_exposure(new, 64 | 18, (9 << 1) | (7 << 5))
    check_exposure(new, 18, (9 << 1) | (7 << 5))
    print('2./3. menus')
    check_menus(new)
    print('4. text and icon')
    check_resources(new)
    if failures:
        print(f'{len(failures)} FAILURES')
        for f in failures[:40]:
            print('  ' + f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
