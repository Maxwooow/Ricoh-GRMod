# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the exposure modes for movies (build option movieExposure, core/src/fw/gr4v120/aspect/movieexp.ts),
GR IV 1.20 and 1.21. Both releases' addresses are written here (the script is not one of the generated copies).

NOT part of the program. Runs the firmware's own update of the shooting mode (the part from the
mode dial to the exposure mode handed to the auto exposure, 0x53259A44..0x53259B30 in 1.20) in
Unicorn, on the official RTOS and on a build with the option, for every combination of the inputs:

  mode dial, still / movie, the user mode's own mode, the three "auto off" flags, ISO setting AUTO
  or not, ISO auto in M, the two Sn settings, shutter speed at B / T, the bulb gate, and the
  controller's own exposure setting (byte 0x0B).

Checked:
  1. official, movie: the virtual mode is P whatever the dial (what the manual says);
  2. built, still: exactly the official's still (modes, flags, every setter call);
  3. built, movie: exactly the official's STILL for the same inputs, except that the bulb / time
     exposure modes (9, 10) never come out: P (0) instead;
  4. built, movie, dial at P, ISO AUTO: exactly the official's movie.

The screen and the ISO button (test 089b), also on both images:
  5. the shooting screen's layout function (0x5318BBB0), for still and movie, both states and
     the two layouts of each: every item the official places is placed at the same position;
     for a movie the build also places shutter speed, aperture and ISO (items 30..32) where the
     still layout of the same size has them; for a still nothing changes;
  6. the item tables apart from that: unchanged;
  7. the buttons' ISO function (0x53396344): the official sends the ISO command (0x47) for a
     still only, the build for a still and a movie; with any of the function's other conditions
     set, neither sends it.

The dials and the values (test 089c):
  8. the function of a dial (0x533F7844), for every function the settings can give (0..6) and
     still / movie: the official gives "nothing" for a movie unless it is exposure compensation
     (3), the build gives the function as for a still; for a still both the same;
  9. the seven places that hand "movie" to CaptureReadyModel's texts (shutter speed, aperture, ISO
     icon, ISO value; shooting screen and exposure-setting view): each function is run up to its
     call of the text function, with still and movie; the official passes the movie flag, the
     build 0, and every other argument register is the same.

Bulb from the dial (test 089d):
 10. the shutter-speed step (0x5325A958) in M, one step slower at the slowest shutter speed, bulb
     state 0, with "ISO auto" answered no and yes: the official sets the bulb state when the
     answer is no (and steps plainly when yes); the build does the same for a still, and for a
     movie always steps plainly, without setting the bulb state.

    python3 check.py 1.20|1.21 OFFICIAL-RTOS BUILT-RTOS
"""
import itertools
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC, UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R11, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC

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


# ------------------------------------------------------------------------------------------------
# The screen and the ISO button

SCREEN = {'1.20': dict(layout=0x5318bbb0, layout_end=0x5318bca0, items=0x53dc08e0, positions=0x53dbf9bc,
                       iso=0x53396344, iso_end=0x53396438, settings=0x53240c38, getter=0x5329b310),
          '1.21': dict(layout=0x5318bb88, layout_end=0x5318bc78, items=0x53dc1ee8, positions=0x53dc0fc4,
                       iso=0x53396bf4, iso_end=0x53396ce8, settings=0x53240c38 + 0x608, getter=0x5329bb60)}
THIS = 0x62000000
STATE = THIS + 0x4000   # the shooting screen's values (this + 0x4EC); +0x980: still / movie
# 8, 9: per release: the dial function; the auto exposure's "movie"; (name, function, end, call of the text function, text function, movie from)
DIAL_FN = {'1.20': dict(fn=0x533f7844, end=0x533f789c, ae_movie=0x5377cab8, mapping=0x533f75d0),
         '1.21': dict(fn=0x533f7844 + 0x928, end=0x533f789c + 0x928, ae_movie=0x5377d748, mapping=0x533f75d0 + 0x928)}
TEXTS = {'1.20': [('shutter speed', 0x533a83cc, 0x533a842c, 0x533a8428, 0x533a8270, 'ae'),
                  ('aperture, screen', 0x5318c30c, 0x5318c410, 0x5318c350, 0x533a8688, 'state'),
                  ('aperture, setting', 0x531bd7b8, 0x531bd8e0, 0x531bd81c, 0x533a8688, 'ae'),
                  ('ISO icon, screen', 0x5318c4f0, 0x5318c544, 0x5318c518, 0x533a88fc, 'state'),
                  ('ISO icon, setting', 0x533a8998, 0x533a89e0, 0x533a89dc, 0x533a88fc, 'ae'),
                  ('ISO text, screen', 0x5318c544, 0x5318c654, 0x5318c594, 0x533a89e0, 'state'),
                  ('ISO text, setting', 0x533a8a94, 0x533a8b2c, 0x533a8b18, 0x533a89e0, 'ae')]}
_SHIFT = {'shutter speed': 0x8b0, 'aperture, screen': -0x28, 'aperture, setting': 0x60c, 'ISO icon, screen': -0x28,
          'ISO icon, setting': 0x8b0, 'ISO text, screen': -0x28, 'ISO text, setting': 0x8b0}
_TEXT121 = {0x533a8270: 0x533a8b20, 0x533a8688: 0x533a8f38, 0x533a88fc: 0x533a91ac, 0x533a89e0: 0x533a9290}
TEXTS['1.21'] = [(n, f + _SHIFT[n], e + _SHIFT[n], c + _SHIFT[n], _TEXT121[t], src) for n, f, e, c, t, src in TEXTS['1.20']]


class Function:
    """One function of the image; everything it calls is recorded and returns `result(target)`."""

    def __init__(self, path, begin, end, native=()):
        self.img = open(path, 'rb').read()
        self.begin, self.end, self.native = begin, end, native
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        self.uc.reg_write(UC_ARM_REG_C1_C0_2, self.uc.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))   # VFP on
        self.uc.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.uc.mem_map(BASE, (len(self.img) + 0xfff) & ~0xfff)
        self.uc.mem_write(BASE, self.img)
        for base in (LIVE, THIS, STACK):
            self.uc.mem_map(base, 0x10000)
        self.calls = []
        self.result = lambda target: 0
        self.on_call = lambda uc, target: None
        self.uc.hook_add(UC_HOOK_CODE, self.step)

    def step(self, uc, address, size, user):
        if self.begin <= address < self.end or any(a <= address < a + 8 for a in self.native):
            return
        self.calls.append((address, uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)))
        self.on_call(uc, address)
        uc.reg_write(UC_ARM_REG_R0, self.result(address))
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def run(self, r0, memory):
        uc = self.uc
        for base in (LIVE, THIS, STACK):
            uc.mem_write(base, bytes(0x10000))
        for a, data in memory.items():
            uc.mem_write(a, data)
        sp = STACK + 0x8000
        uc.reg_write(UC_ARM_REG_SP, sp); uc.reg_write(UC_ARM_REG_LR, 0x6fff0000); uc.reg_write(UC_ARM_REG_R0, r0)
        self.calls = []
        try:
            uc.emu_start(self.begin, 0x6fff0000, count=100000)
        except Exception:
            if uc.reg_read(UC_ARM_REG_PC) != 0x6fff0000:
                raise
        if uc.reg_read(UC_ARM_REG_SP) != sp:
            raise SystemExit('the stack is not where it was')


def placements(fn, movie, state, layout):
    """item -> (x, y) as the layout function places them (items 2..47: this + 0x15C + 4 * item)."""
    memory = {THIS + 0x2d6: bytes([movie]), THIS + 0x2dd: bytes([state]), THIS + 0x2d4: bytes([layout])}
    for item in range(2, 0x30):
        memory[THIS + 0x15c + 4 * item] = struct.pack('<I', 0x1000 + item)
    placed = {}

    def on_call(uc, target):
        r0, r1, r2 = (uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2))
        if STACK <= r0 < STACK + 0x10000:   # the point's own functions: (point, x, y)
            uc.mem_write(r0, struct.pack('<II', r1 & 0xffffffff, r2 & 0xffffffff))
        elif 0x1000 <= r0 < 0x1030:         # place(item's object, point)
            placed[r0 - 0x1000] = struct.unpack('<ii', uc.mem_read(r1, 8))
    fn.on_call = on_call
    fn.run(THIS, memory)
    return placed


def dial_checks(release, official, built):
    a = DIAL_FN[release]
    bad = []
    got = {}
    for name, path in (('official', official), ('built', built)):
        fn = Function(path, a['fn'], a['end'])
        for movie in (0, 1):
            for function in range(7):
                fn.result = lambda target, movie=movie, function=function: function if target == a['mapping'] else movie if target == a['ae_movie'] else LIVE
                fn.on_call = lambda uc, target: None
                fn.run(THIS, {})
                got[name, movie, function] = fn.uc.reg_read(UC_ARM_REG_R0)
    for movie in (0, 1):
        for function in range(7):
            o, n = got['official', movie, function], got['built', movie, function]
            if o != (function if not movie or function == 3 else 0):
                bad.append(('8 official dial function', movie, function, o))
            if n != function:
                bad.append(('8 built dial function', movie, function, n))
    print(f'{release}: dial function for a movie: official', [got['official', 1, f] for f in range(7)], 'built', [got['built', 1, f] for f in range(7)])
    return bad


STEP = {'1.20': dict(fn=0x5325a958, end=0x5325ab08, site=0x5325aa78, base_mode=0x5329b24c, bulb=0x5329b4d0, settings=0x53240c38,
                     iso_auto=0x53258b68, set_bulb=0x532b63f0, set_tv=0x5325a90c)}
STEP['1.21'] = dict(fn=0x5325a958 + 0x84c, end=0x5325ab08 + 0x84c, site=0x5325aa78 + 0x84c, base_mode=0x5329b24c + 0x850, bulb=0x5329b4d0 + 0x850,
                    settings=0x53240c38 + 0x608, iso_auto=0x53258b68 + 0x84c, set_bulb=0x532b63f0 + 0x850, set_tv=0x5325a90c + 0x84c)


def bulb_checks(release, official, built):
    a = STEP[release]
    bad = []
    got = {}
    for label, path in (('official', official), ('built', built)):
        img = open(path, 'rb').read()
        word = struct.unpack_from('<I', img, a['site'] - BASE)[0]
        target = a['site'] + 8 + ((word & 0xffffff) - (1 << 24 if word & 0x800000 else 0)) * 4
        native = () if target == a['iso_auto'] else (target, target + 8, target + 16)   # the appended five instructions
        fn = Function(path, a['fn'], a['end'], native=native)
        for movie in (0, 1):
            for iso_auto in (0, 1):
                fn.result = lambda t, iso_auto=iso_auto: {a['settings']: LIVE, a['base_mode']: 5, a['bulb']: 0, a['iso_auto']: iso_auto}.get(t, LIVE)
                fn.on_call = lambda uc, t: None
                uc = fn.uc
                for base in (LIVE, THIS, STACK):
                    uc.mem_write(base, bytes(0x10000))
                uc.mem_write(LIVE + 0xb76, bytes([movie])); uc.mem_write(LIVE + 4, struct.pack('<I', LIVE))
                uc.reg_write(UC_ARM_REG_SP, STACK + 0x8000); uc.reg_write(UC_ARM_REG_LR, 0x6fff0000)
                uc.reg_write(UC_ARM_REG_R0, THIS); uc.reg_write(UC_ARM_REG_R1, 0)   # the controller; 0: slower
                fn.calls = []
                try:
                    uc.emu_start(a['fn'], 0x6fff0000, count=20000)
                except Exception as e:   # noqa: BLE001
                    if uc.reg_read(UC_ARM_REG_PC) != 0x6fff0000:
                        raise SystemExit(f'shutter-speed step: {e}')
                targets = [c[0] for c in fn.calls]
                bulb = [c for c in fn.calls if c[0] == a['set_bulb']]
                got[label, movie, iso_auto] = ('bulb' if bulb and bulb[0][2] == 1 else 'step' if a['set_tv'] in targets else '?', a['iso_auto'] in targets)
    for movie in (0, 1):
        for iso_auto in (0, 1):
            o, n = got['official', movie, iso_auto], got['built', movie, iso_auto]
            if o != (('step' if iso_auto else 'bulb'), True):
                bad.append(('10 official step', movie, iso_auto, o))
            if n != (o if not movie else ('step', False)):
                bad.append(('10 built step', movie, iso_auto, n))
    print(f'{release}: M, slower at the limit, fixed ISO: official still {got["official", 0, 0][0]}, movie {got["official", 1, 0][0]}; built still {got["built", 0, 0][0]}, movie {got["built", 1, 0][0]}')
    return bad


def text_checks(release, official, built):
    ae_movie = DIAL_FN[release]['ae_movie']
    bad = []
    seen = []
    for name, begin, end, call, text, source in TEXTS[release]:
        got = {}
        for label, path in (('official', official), ('built', built)):
            fn = Function(path, begin, end)
            for movie in (0, 1):
                reached = {}

                def on_call(uc, target, reached=reached, fn=fn):
                    if target == text:
                        reached['r'] = tuple(uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2))
                        uc.emu_stop()
                fn.on_call = on_call
                fn.result = lambda target, movie=movie: movie if target == ae_movie else LIVE
                memory = {THIS + 0x4ec: struct.pack('<I', STATE), STATE + 0x980: bytes([movie]), LIVE + 4: struct.pack('<I', LIVE)}
                uc = fn.uc
                for base in (LIVE, THIS, STACK):
                    uc.mem_write(base, bytes(0x10000))
                for at, data in memory.items():
                    uc.mem_write(at, data)
                uc.reg_write(UC_ARM_REG_SP, STACK + 0x8000); uc.reg_write(UC_ARM_REG_LR, 0x6fff0000)
                uc.reg_write(UC_ARM_REG_R0, THIS); uc.reg_write(UC_ARM_REG_R1, THIS + 0x100); uc.reg_write(UC_ARM_REG_R2, 1)
                fn.calls = []
                try:
                    uc.emu_start(begin, 0x6fff0000, count=20000)
                except Exception as e:   # noqa: BLE001
                    if 'r' not in reached:
                        raise SystemExit(f'{name}: {e}')
                if 'r' not in reached:
                    bad.append(('9 the text function is not reached', name, label, movie)); continue
                got[label, movie] = reached['r']
        if len(got) != 4:
            continue
        for movie in (0, 1):
            o, n = got['official', movie], got['built', movie]
            if o[2] != movie:
                bad.append(('9 the official does not pass the movie flag', name, movie, o))
            if n[2] != 0:
                bad.append(('9 the build does not pass 0', name, movie, n))
            if o[:2] != n[:2]:
                bad.append(('9 other arguments differ', name, movie, o, n))
        seen.append(name)
    print(f'{release}: "movie" argument now 0 at:', ', '.join(seen))
    return bad


def screen_checks(release, official, built):
    a = SCREEN[release]
    bad = []
    off, new = Function(official, a['layout'], a['layout_end']), Function(built, a['layout'], a['layout_end'])
    added = 0
    for movie in (0, 1):
        for state in (0, 1):
            for layout in (movie, movie + 2):   # the layout follows still / movie (0x5318B39C): 0, 2 still; 1, 3 movie
                o, n = placements(off, movie, state, layout), placements(new, movie, state, layout)
                want = dict(o)
                if movie and state == 0:
                    still = placements(off, 0, 0, layout & ~1)   # the still layout of the same size
                    for item in (30, 31, 32):
                        if item in o or item not in still:
                            bad.append(('5 item not as expected in the official layouts', movie, state, layout, item))
                        want[item] = still[item]; added += 1
                if n != want:
                    bad.append(('5 placements', movie, state, layout, sorted(set(n.items()) ^ set(want.items()))))
    # 6. the tables, byte by byte
    oi, ni = off.img, new.img
    items, pos = a['items'] - BASE, a['positions'] - BASE
    changed = {i for i in range(0x60) if oi[items + i] != ni[items + i]}
    if changed != {0x30 + 30, 0x30 + 31, 0x30 + 32} or any(ni[items + i] != 1 for i in changed):
        bad.append(('6 item table', sorted(changed)))
    changed = {i // 4 for i in range(0, 0x600, 4) if oi[pos + i:pos + i + 4] != ni[pos + i:pos + i + 4]}
    want = {(layout * 0x180 + item * 8 + k) // 4 for layout in (1, 3) for item in (30, 31, 32) for k in (0, 4)}
    if changed != want:
        bad.append(('6 position table', sorted(changed)))
    # 7. the ISO function
    sent = {}
    for name, path in (('official', official), ('built', built)):
        fn = Function(path, a['iso'], a['iso_end'], native=(a['getter'],))
        for movie in (0, 1):
            for busy in range(-1, 6):   # -1: none of the other conditions; else the n-th other call answers 1
                order = []

                def result(target, order=order, busy=busy):
                    if target == a['settings']:
                        return LIVE
                    order.append(target)
                    seen = [t for t in dict.fromkeys(order)]
                    return 1 if busy >= 0 and seen.index(target) == busy + 2 and len(seen) <= 8 else 0
                fn.result = result
                fn.on_call = lambda uc, target: None
                fn.run(THIS, {LIVE + 0xb76: bytes([movie]), THIS: struct.pack('<I', 0x2000)})
                sent[name, movie, busy] = any(c[2] == 0x47 for c in fn.calls)
    for movie in (0, 1):
        for busy in range(-1, 6):
            o, n = sent['official', movie, busy], sent['built', movie, busy]
            if busy == -1 and (o, n) != ((movie == 0), True):
                bad.append(('7 ISO command', movie, o, n))
            if busy >= 0 and movie == 0 and o != n:
                bad.append(('7 ISO command with another condition, still', busy, o, n))
            if busy >= 0 and n and not sent['official', 0, busy]:
                bad.append(('7 ISO command sent although the official would not for a still', movie, busy))
    blocked = sum(1 for busy in range(6) if not sent['official', 0, busy])
    print(f'{release}: screen: {added} placements added for movies; ISO function: official still {sent["official", 0, -1]}, movie {sent["official", 1, -1]};'
          f' built still {sent["built", 0, -1]}, movie {sent["built", 1, -1]}; {blocked} of 6 other conditions block it')
    return bad


def main():
    release, official, built = sys.argv[1:4]
    adr = addresses(release)
    screen_bad = screen_checks(release, official, built) + dial_checks(release, official, built) + text_checks(release, official, built) + bulb_checks(release, official, built)
    for b in screen_bad[:20]:
        print('FAIL', b)
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
    bad += screen_bad
    print('FAILED' if bad else 'ok', len(bad))
    sys.exit(1 if bad else 0)


main()
