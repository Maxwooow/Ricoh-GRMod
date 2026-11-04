# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the ADJ lever slots (core/src/fw/aspect/adjslots.ts, tools/adjslots/adjslots.c).

NOT part of the program. Runs AdjModeController's own functions, as patched, in Unicorn, next to the
official ones (the harness of tools/datestamp/menu_check.py), with the view functions and the ADJ
function records' handlers replaced by stubs that record what they are given:

 1. The constructor (object of 0x3A0 bytes): every view made from the new table, in the official order
    of kinds (frames of N slots, the selection, icons of N slots), each in its official member and the
    frames / icons of the N slots in the new members; geometry (52 apart, right edge as officially, the
    name label narrower), parents renumbered; the taps registered on the N icons with their handlers.
 2. For many slot contents (empty, functions with and without a "disabled" handler, disabled ones,
    values above 0x14, the remembered slot anywhere, the fixed layout): the strip (icon and frame of
    every slot), "can ADJ be used", which icons can be touched, next and previous slot (wrap,
    skipping), the first slot on entry and the slot last used kept (0x91E only 0..4, slots 6..8 in the
    padding byte), a tap on every slot, the per-slot state functions.
 3. With five slots the new code (n5) does exactly what the official firmware does: the same calls with
    the same arguments, the same results, the same state (the official +0x200 area at the new place).
 4. No function reads or writes the official state area (+0x200..+0x277) any more, nor anything past
    the object.
 5. The menu: every menu as the official (or the reference build without the slots), ADJ Mode
    Setting's record with N lines and the record of lines 6..N (texts, ids, value icons), the
    controller factory for the lists, the lists (count, rows, set, is current for every value; other
    bits kept), texts in all 21 languages. SubMenuController's own code with every widget function
    real: every other submenu shows and moves as before (rows, texts, value icons, hidden rows, the
    list's place, focus and scroll for many keys); ADJ Mode Setting shows N lines (six in the list's
    area, scrolling with the cursor), OK on each line opens its list, the line is shown again on return.
 6. The settings guard: slots 6..N, the remembered slot, 0x91E.
 7. Every call the module and the stubs make goes to the start of a firmware function.

    python3 check.py IMAGES-DIR      (from tools/adjslots/images.ts)
    python3 check.py IMAGES-DIR NAME N [REF]   (one image, e.g. a test firmware's decoded RTOS, with N slots;
                                               REF: the same build without the slots, for the menus)
"""
import base64
import re
import struct
import sys
from pathlib import Path

import capstone
from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_SP

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as dm  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
failures = []
REFERENCE = None
CURRENT = 0x55084dd8
EXT = CURRENT + 4 + 0x489
POS_STILL = CURRENT + 0x91e
POS_FIXED = CURRENT + 0x91f
SLOTS = [CURRENT + 0x920 + k for k in range(5)]
FIXED_FLAG = CURRENT + 0x32
TABLE = 0x53d9f714
REC = 0x5c
FUNCTIONS = 0x15
FIXED_FUNCTIONS = [0x0f, 0x01, 0x07, 0x12, 0x11]
OFFICIAL_SIZE, NEW_SIZE = 0x294, 0x3a0
FRAMES, ICONS, STATE = 0x294, 0x2b4, 0x2d8
PITCH = 52
VTABLE_9 = 0x53d9f6c4
NAMED = {0x53576e38: 'icon', 0x53589ab4: 'show', 0x535888a8: 'touch', 0x5357013c: 'colour', 0x53588c5c: 'x', 0x535885a4: 'tap'}
STUBS = 0x70e00000
DISABLED = 0x70e10000
ICON_BASE = 1000


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


def frame_x(n, k):
    return 425 + 60 * k if n <= 5 else 665 - PITCH * (n - 1 - k)


def pitch(n):
    return 60 if n <= 5 else PITCH


def semantic(n, i):
    if i < 4:
        return ('v', i)
    if i < 4 + n:
        return ('frame', i - 4)
    if i == 4 + n:
        return ('sel',)
    if i < 5 + 2 * n:
        return ('icon', i - 5 - n)
    return ('v', i - 2 * (n - 5))


def official_member(i):
    """Official member i (+0x15C + 4 i) as a semantic view."""
    if 4 <= i <= 8:
        return ('frame', i - 4)
    if i == 9:
        return ('sel',)
    if 10 <= i <= 14:
        return ('icon', i - 10)
    return ('v', i)


class Cam:
    """One image with a controller, the stubs and the recorders."""

    def __init__(self, path, n, official=False, has_method=None, disabled=None):
        self.img = dm.Image(path)
        self.e = dm.Emu(self.img)
        self.mu = self.e.mu
        self.n = n
        self.official = official
        self.size = OFFICIAL_SIZE if official else NEW_SIZE
        self.log = []
        self.views = {}      # fake view -> creation index
        self.entries = []    # creation index -> (kind, x, y, w, h, parent)
        self.taps = []
        self.bad = []
        self.this = None
        self.fake = 0x70800000
        mu = self.mu
        # The ADJ function records: every handler a no-op (returns 1), the "disabled" one (0x3C) a stub
        # that returns DISABLED[f] for the functions in has_method (else none).
        has_method = set(range(FUNCTIONS)) if has_method is None else has_method
        has_method = set(has_method) - {0}   # function 0 (none) has no handlers, as in the camera
        code = []
        ret1 = STUBS
        code += [0xe3a00001, 0xe12fff1e]          # mov r0, #1; bx lr
        for f in range(FUNCTIONS):
            # movw r0, #lo(DISABLED + f); movt r0, #hi; ldrb r0, [r0]; bx lr
            a = DISABLED + f
            code += [0xe3000000 | ((a & 0xf000) << 4) | (a & 0xfff), 0xe3400000 | (((a >> 16) & 0xf000) << 4) | ((a >> 16) & 0xfff), 0xe5d00000, 0xe12fff1e]
        mu.mem_write(STUBS, struct.pack(f'<{len(code)}I', *code))
        mu.mem_write(DISABLED, bytes(disabled or [0] * FUNCTIONS))
        for f in range(FUNCTIONS):
            rec = TABLE + f * REC
            for off in (0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30):
                mu.mem_write(rec + off, struct.pack('<2I', ret1, 0))
            mu.mem_write(rec + 0x3c, struct.pack('<2I', STUBS + 8 + 16 * f if f in has_method else 0, 0))
        vt, ret = 0x70f00000, 0x70f10000
        mu.mem_write(ret, struct.pack('<2I', 0xe3a00000, 0xe12fff1e))
        mu.mem_write(vt, struct.pack('<256I', *([ret] * 256)))
        self.e.stubs[0x533817f0] = lambda: ICON_BASE + mu.reg_read(UC_ARM_REG_R1)
        mu.hook_add(UC_HOOK_CODE, self._hook)

    def _hook(self, uc, addr, size, ud):
        lr = uc.reg_read(UC_ARM_REG_LR)
        if addr == 0x538e0a24:
            n = uc.reg_read(UC_ARM_REG_R0)
            p = self.e.heap[0]
            self.e.heap[0] += (n + 15) & ~15
            uc.reg_write(UC_ARM_REG_R0, p)
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        # the vector of 0x531C02FC, the settings file loader and the user-mode recall (some functions'
        # panels load settings; the emulator would wipe the slots under test)
        if addr in (0x538e0a60, 0x538e09ec, 0x531c02fc, 0x533e17cc, 0x532a90b0):
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        # The exposure panel some functions show next to the strip (0x531BDD64: 0x531BC178, 0x531BC280,
        # 0x531BC43C, 0x531BC3A8, 0x531BC844; e.g. function 0x10's): it reads the exposure model of
        # another task, through mutexes and waits that assert when the kernel does not run, as here.
        # Nothing in it depends on the number of slots; skipped for the official image and the new ones.
        if addr in (0x531bc178, 0x531bc280, 0x531bc43c, 0x531bc3a8, 0x531bc844):
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        # The exposure mode asked of that model (0x537575EC, a mutex around another task's value; e.g.
        # 0x531BD1D0, "is it mode 7"): 0 here, for the official image and the new ones alike.
        if addr == 0x537575ec:
            uc.reg_write(UC_ARM_REG_R0, 0)
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        # a message to another task (it allocates from a heap object the emulator does not have)
        if addr == 0x538dc048:
            uc.reg_write(UC_ARM_REG_R0, 0)
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        if 0x53560000 <= addr < 0x535a0000:
            r0, r1, r2 = (uc.reg_read(x) for x in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2))
            ret = 0
            if addr == 0x53589ee4:
                self.fake += 0x100
                ret = self.fake
                uc.mem_write(ret, struct.pack('<I', 0x70f00000))
                self.views[ret] = len(self.entries)
                self.entries.append(struct.unpack('<6I', uc.mem_read(r0, 24)))
            elif addr == 0x535885a4:
                h = struct.unpack('<4I', uc.mem_read(r1, 16))
                fn = struct.unpack('<3I', uc.mem_read(h[0], 12))
                self.taps.append((self.name(r0), fn, h[2], h[3]))
            if addr in NAMED:
                self.log.append((NAMED[addr], self.name(r0), r1))
            uc.reg_write(UC_ARM_REG_R0, ret)
            uc.reg_write(UC_ARM_REG_PC, lr)

    def icon_taps(self):
        return [t for t in self.taps if isinstance(t[0], tuple) and t[0][0] == 'icon']

    def name(self, view):
        return semantic(self.n, self.views[view]) if view in self.views else hex(view)

    def watch(self):
        """Flag reads / writes of the official state area (new code) and past the object."""
        t = self.this

        def hook(uc, access, address, size, value, ud):
            if t + self.size <= address < t + self.size + 0x100:
                self.bad.append(('past the object', hex(address - t), hex(uc.reg_read(UC_ARM_REG_PC))))
            if not self.official and t + 0x200 <= address < t + 0x278:
                self.bad.append(('official state area', hex(address - t), hex(uc.reg_read(UC_ARM_REG_PC))))
        self.mu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, hook, begin=t, end=t + self.size + 0x100)

    def construct(self):
        size_word = self.img.u32(0x53186a48)
        check(size_word == (0xe3a00fa5 if self.official else 0xe3a00e3a), f'n{self.n}: object size word {size_word:#x}')
        self.this = self.e.call(0x538e09b0, (self.size + 0x100,))
        self.mu.mem_write(self.this, bytes(self.size + 0x100))
        self.watch()
        self.e.call(0x531c048c, (self.this,), limit=20_000_000)
        return self.this

    def set_slots(self, slots, ext=(0, 0, 0), fixed=0, pos=0, posx=0):
        mu = self.mu
        for k in range(5):
            mu.mem_write(SLOTS[k], bytes([slots[k]]))
        mu.mem_write(EXT, bytes([ext[0] | (posx << 5), ext[1], ext[2]]))
        mu.mem_write(POS_STILL, bytes([pos]))
        mu.mem_write(FIXED_FLAG, bytes([1 if fixed else 0]))

    def run(self, fn, *args):
        self.log = []
        r = self.e.call(fn, (self.this,) + args, limit=20_000_000)
        return r

    def u32(self, off):
        return self.e.u32(self.this + off)

    def byte(self, a):
        return self.e.byte(a)


# ------------------------------------------------------------------------------------------------
# A model of what the camera should do with N slots.

class Model:
    def __init__(self, n, slots, ext, fixed, has_method, disabled, softfocus=False):
        self.n, self.fixed = n, fixed
        self.has, self.dis = has_method, disabled
        self.fn = []
        for k in range(n):
            if fixed:
                f = FIXED_FUNCTIONS[k] if k < 5 else 0
            elif k < 5:
                f = slots[k]
                if softfocus and f > 0x14:
                    f = 0
            else:
                f = ext[k - 5] & 0x1f
                f = 0 if f > 0x14 else f
            self.fn.append(f)

    def disabled(self, f):
        return f != 0 and f in self.has and self.dis[f] != 0

    def usable(self, k):
        f = self.fn[k]
        return f != 0 and not self.disabled(f)

    def strip(self):
        out = []
        for k in range(self.n):
            f = self.fn[k]
            icon = ICON_BASE + f if self.usable(k) else 0
            out.append((icon, 1 if icon else 0))
        return out

    def can_open(self):
        return 1 if self.fixed or any(self.usable(k) for k in range(self.n)) else 0

    def step(self, p, d):
        for _ in range(self.n):
            p = (p + d) % self.n
            if self.usable(p):
                return p
        return p

    def enter(self, p):
        """(slot, kept position or None)."""
        if self.usable(p):
            return p, None
        q = p
        for _ in range(self.n):
            q = (q + 1) % self.n
            if self.fn[q] != 0 and not self.disabled(self.fn[q]):
                return q, q
        return q, None


def strip_of(cam):
    icons = {v[1]: v[2] for v in cam.log if v[0] == 'icon' and isinstance(v[1], tuple) and v[1][0] == 'icon'}
    shows = {v[1]: v[2] for v in cam.log if v[0] == 'show' and isinstance(v[1], tuple) and v[1][0] == 'frame'}
    return [(icons.get(('icon', k)), shows.get(('frame', k))) for k in range(cam.n)]


def position_of(cam):
    """The remembered slot as kept: (0x91E, the padding byte's bits 5..7)."""
    return cam.byte(POS_STILL), cam.byte(EXT) >> 5


# ------------------------------------------------------------------------------------------------

def check_constructor(cam):
    n = cam.n
    this = cam.construct()
    check(not cam.e.calls, f'n{n}: constructor: {cam.e.calls[:3]}')
    count = 39 + 2 * (n - 5)
    check(len(cam.entries) == count, f'n{n}: {len(cam.entries)} views made')
    for i, e in enumerate(cam.entries):
        s = semantic(n, i)
        if s[0] == 'frame':
            check(e[:5] == (11, frame_x(n, s[1]), 5, 50, 50) and e[5] & 0xffff == 0, f'n{n}: frame {s[1]}: {e}')
        elif s[0] == 'icon':
            check(e[:5] == (10, frame_x(n, s[1]) + 5, 10, 40, 40) and e[5] & 0xffff == 0, f'n{n}: icon {s[1]}: {e}')
        elif s[0] == 'sel':
            check(e[:5] == (10, frame_x(n, 0), 5, 50, 50), f'n{n}: selection: {e}')
    if n > 5:
        name = cam.entries[1]
        check(name[3] == min(400, frame_x(n, 0) - 5), f'n{n}: name label width {name[3]}')
        for i in range(15 + 2 * (n - 5), count):
            par = cam.entries[i][5] & 0xffff
            if par:
                check(semantic(n, par) == ('v', 25) or semantic(n, par)[0] == 'v' and semantic(n, par)[1] in (25, 26, 27, 28, 29),
                      f'n{n}: view {i} parent {par}')
    for i in range(39):
        v = cam.u32(0x15c + 4 * i)
        check(cam.name(v) == official_member(i), f'n{n}: member {i}: {cam.name(v)}')
    if not cam.official:
        for k in range(8):
            fv, iv = cam.u32(FRAMES + 4 * k), cam.u32(ICONS + 4 * k)
            check((cam.name(fv), cam.name(iv)) == ((('frame', k), ('icon', k)) if k < n else ('0x0', '0x0')), f'n{n}: slot {k} views {cam.name(fv)} {cam.name(iv)}')
    # taps: one per icon, in order, handler k (the other views' taps as officially)
    icon_taps = cam.icon_taps()
    handlers = [t[1][0] for t in icon_taps]
    check([t[0] for t in icon_taps] == [('icon', k) for k in range(n)], f'n{n}: taps on {[t[0] for t in icon_taps]}')
    check(all(t[1][1] == 0 and t[1][2] == this and t[2] == 0x531bb7c0 and t[3] == 0x531bb8ec for t in icon_taps), f'n{n}: tap functors {icon_taps[:2]}')
    others = [(t[0], t[1][0]) for t in cam.taps if t not in icon_taps]
    check(len(others) == 3, f'n{n}: other taps {others}')
    if n >= 5:
        check(handlers[:5] == [0x531bf9d8, 0x531bf9ec, 0x531bfa00, 0x531bfa14, 0x531bfa28], f'n{n}: official tap handlers {handlers[:5]}')
    # the state: two layouts of n, function 0, value 0, flag 1
    base = 0x200 if cam.official else STATE
    for lay in range(2):
        for k in range(n):
            a = base + lay * 12 * n + 12 * k
            st = cam.e.mu.mem_read(this + a, 12)
            check(st[0] == 0 and st[10] == 1, f'n{n}: state {lay} {k}: {bytes(st).hex()}')
    return cam.taps


SCENARIOS = []


def scenarios(wild=False):
    """(slots 1..5, slots 6..8, fixed, has_method, disabled). Values above 0x14 in slots 1..5 only with
    `wild` (soft focus builds: their getters read them as 0; the official firmware looks them up past
    its table, see softfocus.ts), always in slots 6..8."""
    import random
    rnd = random.Random(5)
    out = []
    base_has = set(range(FUNCTIONS)) - {3, 8, 12}
    out.append(([1, 2, 3, 4, 5], [6, 7, 8], 0, base_has, [0] * FUNCTIONS))
    out.append(([0, 0, 0, 0, 0], [0, 0, 0], 0, base_has, [0] * FUNCTIONS))
    out.append(([0, 0, 0, 0, 0], [0, 0, 9], 0, base_has, [0] * FUNCTIONS))
    out.append(([2, 0, 0, 0, 0], [0, 11, 0], 0, base_has, [0] * FUNCTIONS))
    out.append(([1, 2, 3, 4, 5], [6, 7, 8], 1, base_has, [0] * FUNCTIONS))
    out.append(([10, 21, 0x1f, 4, 5], [0x15, 0x1f, 10], 0, base_has, [0] * FUNCTIONS))
    dis = [0] * FUNCTIONS
    for f in (2, 6, 7, 11):
        dis[f] = 1
    out.append(([1, 2, 3, 6, 5], [7, 8, 11], 0, base_has, dis))
    out.append(([1, 2, 3, 6, 5], [7, 8, 11], 0, set(), dis))
    for _ in range(14):
        s = [rnd.choice([0, 0, 1, 2, 3, 6, 9, 10, 13, 16, 20, 21, 25]) for _ in range(5)]
        x = [rnd.choice([0, 0, 1, 4, 7, 14, 18, 20, 22]) for _ in range(3)]
        d = [rnd.choice([0, 0, 0, 1]) for _ in range(FUNCTIONS)]
        h = set(f for f in range(FUNCTIONS) if rnd.random() < 0.7)
        out.append((s, x, rnd.choice([0, 0, 0, 1]), h, d))
    if not wild:
        out = [([v if v <= 0x14 else 0 for v in sc[0]],) + sc[1:] for sc in out]
    return out


def run_scenario(path, n, official, sc, softfocus=False):
    slots, ext, fixed, has, dis = sc
    results = []
    m = Model(n, slots, ext, fixed, has, dis, softfocus)
    bad, calls = [], []
    for pos in range(n):
        # a controller of its own for each remembered slot: what the stubbed environment does with
        # many runs on one object is not the camera's
        cam = Cam(path, n, official, has, dis)
        cam.construct()
        p_off = pos if pos < 5 else 4
        posx = pos - 4 if pos >= 5 else 0
        cam.set_slots(slots, ext, fixed, p_off, posx if not official else 0)
        r = {}
        # strip
        cam.run(0x531bfa3c)
        r['strip'] = strip_of(cam)
        # can ADJ be used
        fn = cam.img.u32(VTABLE_9)
        r['open'] = cam.run(fn) & 0xff
        # touchable icons
        cam.run(0x531bd6bc)
        r['touch'] = [v[2] for v in cam.log if v[0] == 'touch' and isinstance(v[1], tuple) and v[1][0] == 'icon']
        # entry
        cam.mu.mem_write(cam.this + 0x1fc, bytes([0x7f]))
        cam.run(0x531bed64)
        r['enter'] = (cam.byte(cam.this + 0x1fc), position_of(cam))
        # next / previous from every slot
        nxt, prv = [], []
        for start in range(n):
            cam.set_slots(slots, ext, fixed, p_off, posx if not official else 0)
            cam.mu.mem_write(cam.this + 0x1fc, bytes([start]))
            cam.run(0x531bf6bc)
            nxt.append((cam.byte(cam.this + 0x1fc), position_of(cam)))
            cam.set_slots(slots, ext, fixed, p_off, posx if not official else 0)
            cam.mu.mem_write(cam.this + 0x1fc, bytes([start]))
            cam.run(0x531bf778)
            prv.append((cam.byte(cam.this + 0x1fc), position_of(cam)))
        r['next'], r['prev'] = nxt, prv
        r['x'] = [v[2] for v in cam.log if v[0] == 'x' and v[1] == ('sel',)]
        # taps
        taps = []
        for k, t in enumerate(cam.icon_taps()):
            cam.set_slots(slots, ext, fixed, p_off, posx if not official else 0)
            cam.mu.mem_write(cam.this + 0x1fc, bytes([(k + 1) % n]))
            cam.run(t[1][0])
            taps.append(cam.byte(cam.this + 0x1fc))
        r['taps'] = taps
        r['state'] = bytes(cam.mu.mem_read(cam.this + (0x200 if official else STATE), 24 * n))
        results.append(r)
        bad += cam.bad
        calls += [c for c in cam.e.calls if c[0] in ('ASSERT', 'NULL-JUMP')]
    check(not bad, f'n{n}: object accesses {sorted(set(bad))[:4]}')
    check(not calls, f'n{n} {slots}{ext}: {calls[:3]}')
    return results, m


def check_model(n, sc, results, m):
    slots, ext, fixed, has, dis = sc
    for pos, r in enumerate(results):
        what = f'n{n} {slots}{ext} fixed {fixed} pos {pos}'
        check(r['strip'] == m.strip(), f'{what}: strip {r["strip"]} want {m.strip()}')
        check(r['open'] == m.can_open(), f'{what}: can open {r["open"]} want {m.can_open()}')
        want_touch = [1 if f else 0 for f in m.fn]
        check(r['touch'][-n:] == want_touch, f'{what}: touchable {r["touch"]} want {want_touch}')
        # entry (free layout only: the fixed one starts at 0x91F)
        if not fixed:
            slot, kept = m.enter(pos)
            got_slot, (p91e, px) = r['enter']
            check(got_slot == slot, f'{what}: entry slot {got_slot} want {slot}')
            if kept is not None:
                check((p91e, px) == ((kept, 0) if kept < 5 else (4, kept - 4)), f'{what}: entry kept {(p91e, px)} for {kept}')
            check(p91e <= 4, f'{what}: 0x91E = {p91e}')
        for start in range(n):
            for d, got in ((1, r['next'][start]), (-1, r['prev'][start])):
                want = m.step(start, d)
                if not m.usable(want):
                    want = want  # nothing usable: the camera stays (it compares with the start)
                gs, (p91e, px) = got
                if m.usable(want) and want != start:
                    check(gs == want, f'{what}: step {d} from {start}: {gs} want {want}')
                    if not fixed:
                        check((p91e, px) == ((want, 0) if want < 5 else (4, want - 4)), f'{what}: step {d} from {start} kept {(p91e, px)}')
                else:
                    check(gs == start, f'{what}: step {d} from {start}: moved to {gs}')
                check(p91e <= 4, f'{what}: 0x91E = {p91e}')
        for k, got in enumerate(r['taps']):
            src = (k + 1) % n
            want = src if m.disabled(m.fn[k]) else k   # (an empty slot's icon cannot be touched)
            check(got == want, f'{what}: tap {k} (from {src}): {got} want {want}')
        x0 = frame_x(n, 0)
        check(all((x - x0) % pitch(n) == 0 and 0 <= (x - x0) // pitch(n) < n for x in r['x']), f'{what}: selection x {r["x"]}')


def compare_official(d):
    """n5 (the new code, five slots) against the official image: same results for every scenario."""
    off_taps = check_constructor(Cam(d / 'official.rtos', 5, True))
    new_taps = check_constructor(Cam(d / 'n5.rtos', 5, False))
    check([t[1][0] for t in off_taps] == [t[1][0] for t in new_taps], 'n5: tap handlers differ from the official ones')
    count = 0
    for sc in scenarios():
        a, _ = run_scenario(d / 'official.rtos', 5, True, sc)
        b, m = run_scenario(d / 'n5.rtos', 5, False, sc)
        for pos, (ra, rb) in enumerate(zip(a, b)):
            for key in ra:
                check(ra[key] == rb[key], f'n5 vs official, {sc[0]} fixed {sc[2]} pos {pos}: {key} {ra[key]} / {rb[key]}')
        check_model(5, sc, b, m)
        count += 1
    print(f'  n5 = official: constructor, {count} slot settings x 5 remembered slots (strip, can open, touch, entry, next, previous, taps, state)')


def check_slots(d, name, n, softfocus=False):
    check_constructor(Cam(d / name, n))
    count = 0
    for sc in scenarios(softfocus):
        res, m = run_scenario(d / name, n, False, sc, softfocus)
        check_model(n, sc, res, m)
        count += 1
    print(f'  {name}: constructor (views, geometry, taps), {count} slot settings x {n} remembered slots')


# ------------------------------------------------------------------------------------------------
# Menu

ADJ_MENU_ID = 0x020001c0
T0 = 970


ADJ_LIST_ID = ADJ_MENU_ID + 1
T_ADJ_MODE, T_SETTING1 = 460, 462
SUB_CTOR, SUB_SET_CURRENT, SUB_SHOW = 0x531e29c8, 0x531e1bd0, 0x531e271c
SUB_DOWN, SUB_UP, SUB_OK = 0x531e2040, 0x531e1ff8, 0x531e20a8
SUB_DRAW_CALL = 0x531e2544   # blx r2: a line's value draw (skipped and recorded)
OPEN_MENU, CURRENT_MENU = 0x53182e4c, 0x53183e14
VEC_ALLOCATOR = 0x538eb380   # ldr r3, [r0]: the vector's allocator (one that hands out emulator memory)
MALLOC, FREE, DELETE = 0x538e0a24, 0x538e0a60, 0x538e09ec
UI_STATE = 0x533ef18c
ADJ_RECORD = 10
FAKE_ALLOC = 0x70f00000


def sub_emu(img):
    """SubMenuController's own code with every widget function real; memory from the emulator."""
    e = dm.Emu(img)
    mu = e.mu
    e.record = dict(e.record)
    e.record.update({0x53583014: 'text', 0x5358304c: 'value-x', OPEN_MENU: 'open'})
    for a in (UI_STATE, DELETE, FREE):
        e.stubs[a] = (lambda: 0)

    def malloc():
        size = mu.reg_read(UC_ARM_REG_R0)
        p = e.heap[0]
        e.heap[0] += (size + 15) & ~15
        return p
    e.stubs[MALLOC] = malloc
    e.stubs[CURRENT_MENU] = (lambda: 0x020000d3)
    e.stubs[0x533817f0] = (lambda: ICON_BASE + mu.reg_read(UC_ARM_REG_R1))
    vt = FAKE_ALLOC + 0x100
    mu.mem_write(FAKE_ALLOC, struct.pack('<I', vt))
    mu.mem_write(vt, struct.pack('<4I', FAKE_ALLOC + 0x200, FAKE_ALLOC + 0x200, FAKE_ALLOC + 0x210, FAKE_ALLOC + 0x200))

    def hook(uc, addr, size, ud):
        if addr == VEC_ALLOCATOR:
            uc.reg_write(UC_ARM_REG_R0, FAKE_ALLOC)
        elif addr == FAKE_ALLOC + 0x210:
            n = uc.reg_read(UC_ARM_REG_R1)
            p = e.heap[0]
            e.heap[0] += (n * 16 + 15) & ~15
            uc.reg_write(UC_ARM_REG_R0, p)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif addr == FAKE_ALLOC + 0x200:
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif addr == SUB_DRAW_CALL:
            e.calls.append(('draw', uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2), uc.reg_read(UC_ARM_REG_R0) - e.this))
            uc.reg_write(UC_ARM_REG_PC, SUB_DRAW_CALL + 4)
    for a in (VEC_ALLOCATOR, SUB_DRAW_CALL):
        mu.hook_add(UC_HOOK_CODE, hook, begin=a, end=a)
    mu.hook_add(UC_HOOK_CODE, hook, begin=FAKE_ALLOC, end=FAKE_ALLOC + 0x300)
    e.this = 0x70000000
    mu.mem_write(e.this, bytes(0x200))
    e.call(SUB_CTOR, (e.this,))
    e.list = e.u32(e.this + 0x170)
    return e


def sub_open(img, cid):
    """The submenu of controller id `cid` as shown: (record, rows, list state) or None."""
    e = sub_emu(img)
    e.mu.mem_write(e.this + 0x174, b'\xff')
    e.call(SUB_SET_CURRENT, (e.this, cid))
    rec = e.byte(e.this + 0x174)
    if rec == 0xff:
        return None
    e.calls.clear()
    e.call(SUB_SHOW, (e.this,))
    per = {}
    for c in e.calls:
        if c[0] in ('text', 'value-x', 'sub-icon', 'draw'):
            per.setdefault(c[1], []).append(c[:1] + c[2:3] + (c[3:4] if c[0] == 'draw' else ()))
    vec, end = e.u32(e.list + 0xf4), e.u32(e.list + 0xf8)
    rows = [(e.byte(e.u32(vec + 4 * i) + 4), per.get(e.u32(e.u32(vec + 4 * i)))) for i in range((end - vec) // 4)]
    asserts = [c for c in e.calls if c[0] == 'ASSERT']
    return e, rec, rows, asserts


def sub_state(e):
    L = e.list
    return (e.byte(L + 0x108), struct.unpack('<H', e.mu.mem_read(L + 0x110, 2))[0], struct.unpack('<i', e.mu.mem_read(L + 0x114, 4))[0],
            struct.unpack('<4i', e.mu.mem_read(L + 0x20, 16)))


KEYS = {'d': (SUB_DOWN, 0), 'D': (SUB_DOWN, 1), 'u': (SUB_UP, 0), 'U': (SUB_UP, 1)}
KEY_RUN = 'dddddddddduuuuuuuuuuDDDDDDDDDUUUUUUUUUdUdUuuDD'


def sub_keys(e, keys):
    seq = [sub_state(e)]
    for k in keys:
        e.call(*(KEYS[k][:1] + ((e.this, KEYS[k][1]),)))
        seq.append(sub_state(e))
    return seq


def adj_model(n, keys):
    """ADJ Mode Setting with n lines: focus and the list's scroll (six rows of 60 shown)."""
    f, top = 0, 0
    out = [(n, 0, 0)]
    for k in keys:
        if k in 'dD':
            if not (k == 'D' and f == n - 1):
                f = (f + 1) % n
        else:
            if not (k == 'U' and f == 0):
                f = (f - 1) % n
        if f < top:
            top = f
        if f > top + 5:
            top = f - 5
        out.append((n, f, 60 * top))
    return out


def check_menu(d, name, n, other_menu_ids=(), reference=None):
    new = dm.Image(d / name)
    off = dm.Image(d / 'official.rtos')
    ref = dm.Image(d / reference) if reference else off
    lines = n - 5
    v = struct.unpack_from
    # Every menu (Customize Settings included) as the reference's: no item added.
    for model in (0, 1, 2):
        a = dm.built_menus(new, model)
        b = dm.built_menus(ref, model)
        for m in range(5):
            check(a[m] == b[m], f'{name}: menu {m} changed (model {model})')
    # Factory and SetCurrentMenu: lists for the line ids, nothing else new.
    for j in range(lines):
        check(dm.factory_class(new, ADJ_LIST_ID + j) == dm.factory_class(off, 0x020000a8), f'{name}: list controller {j}')
    for cid in (ADJ_MENU_ID, ADJ_LIST_ID + lines):
        check(dm.factory_class(new, cid) == dm.factory_class(ref, cid), f'{name}: controller id {cid:#x} is handed out')
    list_recs = [dm.set_current(new, 0x531d5e8c, 0x1a4, ADJ_LIST_ID + j) for j in range(lines)]
    for cid in (0x020000d3, 0x020000a8, 0x020000ac, 0x020000d0):
        fn = 0x531e1bd0 if cid in (0x020000d3, 0x020000d0) else 0x531d5e8c
        o = 0x174 if fn == 0x531e1bd0 else 0x1a4
        check(dm.set_current(new, fn, o, cid) == dm.set_current(off, fn, o, cid), f'{name}: SetCurrentMenu {cid:#x}')
    # The record of lines 6..N.
    sub_rec = dm.set_current(new, 0x531e1bd0, 0x174, ADJ_MENU_ID)
    subtab = new.movw_movt(0x531e2064, 0x531e206c)
    rec = new.rd(subtab + sub_rec * 0x64, 0x64)
    adj = new.rd(subtab + ADJ_RECORD * 0x64, 0x64)
    off_adj = off.rd(0x53da6718 + ADJ_RECORD * 0x64, 0x64)
    check(adj == off_adj[:6] + bytes([n]) + off_adj[7:], f'{name}: ADJ Mode Setting record: only its line count ({adj[6]})')
    check(v('<H', rec, 2)[0] == T_ADJ_MODE and rec[6] == lines, f'{name}: lines record title / lines')
    check([v('<H', rec, 8 + 2 * k)[0] for k in range(lines)] == [T0 + 1 + k for k in range(lines)], f'{name}: lines record texts')
    check([v('<I', rec, 0x14 + 4 * k)[0] for k in range(lines)] == [ADJ_LIST_ID + k for k in range(lines)], f'{name}: lines record ids')
    check([v('<I', rec, 0x28 + 4 * k)[0] for k in range(lines)] == [0x21c] * lines, f'{name}: lines record value x')
    check(rec[0] == off_adj[0] and rec[1] == off_adj[1], f'{name}: lines record head')
    # Lists: count / row draw are ADJ Mode Setting 1's; set and is current per value.
    seltab = new.movw_movt(0x531d6868, 0x531d6878)
    vec = list(range(20))
    for j in range(lines):
        r = new.rd(seltab + list_recs[j] * 0x4c, 0x4c)
        o = off.rd(0x53da2d20 + 67 * 0x4c, 0x4c)
        check(v('<H', r, 4)[0] == T0 + 1 + j, f'{name}: list {j} title')
        check(v('<I', r, 0x0c)[0] == v('<I', o, 0x0c)[0] and v('<I', r, 0x14)[0] == v('<I', o, 0x14)[0], f'{name}: list {j} count / draw')
        setf, cur = v('<I', r, 0x24)[0], v('<I', r, 0x2c)[0]
        for raw in (0, 1, 0x14, 0x15, 0x1f, 0x20 | 3, 0xe0 | 0x14, 0x60):
            for i, f in enumerate(vec + [0x30]):
                e = dm.Emu(new)
                this = 0x70000000
                vb = 0x70100000
                e.mu.mem_write(vb, bytes(vec))
                e.mu.mem_write(this + 0x1a8, struct.pack('<2I', vb, vb + len(vec)))
                e.mu.mem_write(EXT + j, bytes([raw]))
                ic = e.call(cur, (this, i))
                fval = raw & 0x1f
                fval = 0 if fval > 0x14 else fval
                want = 1 if i < len(vec) and vec[i] == fval else 0
                check(ic == want, f'{name}: list {j} byte {raw:#x} is-current {i}: {ic}')
                e.call(setf, (this, i))
                after = e.byte(EXT + j)
                if i < len(vec) and vec[i] <= 0x14:
                    check(after == (raw & 0xe0) | vec[i], f'{name}: list {j} byte {raw:#x} set {i}: {after:#x}')
                else:
                    check(after == raw, f'{name}: list {j} byte {raw:#x} set {i} (none): {after:#x}')
        # the line's value icon
        for raw in (0, 3, 0x14, 0x15, 0x27):
            e = dm.Emu(new)
            e.stubs[0x533817f0] = (lambda mu=e.mu: ICON_BASE + mu.reg_read(UC_ARM_REG_R1))
            e.mu.mem_write(EXT + j, bytes([raw]))
            draw = v('<I', rec, 0x3c + 8 * j)[0]
            e.call(draw, (0x70000000, 0x70700000))
            icons = [c for c in e.calls if c[0] == 'sub-icon']
            fval = raw & 0x1f
            fval = 0 if fval > 0x14 else fval
            check(icons == [('sub-icon', 0x70700000, ICON_BASE + fval, icons[0][3] if icons else 0)], f'{name}: line {j} icon for {raw:#x}: {icons}')

    # SubMenuController itself, every widget function real: every other submenu as in the reference
    # (rows, texts, value icon places and draws, rows hidden, the list's place, focus and scroll for
    # every key), ADJ Mode Setting with N lines.
    compared = 0
    for cid in range(0x02000085, 0x02000200):
        b = sub_open(ref, cid)
        a = sub_open(new, cid)
        if b is None and a is None:
            continue
        if b is None or a is None:
            if cid != ADJ_MENU_ID:
                check(False, f'{name}: submenu {cid:#x} opens in only one of the images')
            continue
        if a[1] == ADJ_RECORD or cid == ADJ_MENU_ID:
            continue
        ea, ra, rowa, asa = a
        eb, rb, rowb, asb = b
        check(ra == rb and rowa[:len(rowb)] == rowb and all(x == (0, None) for x in rowa[len(rowb):]) and len(rowa) == max(n, len(rowb))
              and asa == asb == [], f'{name}: submenu {cid:#x} rows {rowa} / {rowb}')
        check(sub_keys(ea, KEY_RUN) == sub_keys(eb, KEY_RUN), f'{name}: submenu {cid:#x} keys')
        compared += 1
    check(compared >= 17, f'{name}: only {compared} other submenus')
    # ADJ Mode Setting.
    ea, ra, rowa, asa = sub_open(new, 0x020000d3)
    eb, rb, rowb, asb = sub_open(off, 0x020000d3)
    check(ra == rb == ADJ_RECORD and asa == asb == [], f'{name}: ADJ Mode Setting record {ra} {asa}')
    want = rowb + [(1, [('text', T0 + 1 + j), ('value-x', 0x21c), ('draw', v('<I', rec, 0x3c + 8 * j)[0], v('<I', rec, 0x40 + 8 * j)[0] >> 1)]) for j in range(lines)]
    check(rowa == want, f'{name}: ADJ Mode Setting rows {rowa} / {want}')
    check(sub_state(ea)[3] == (0, 60, 720, 60 * min(n, 6)), f'{name}: ADJ Mode Setting list place {sub_state(ea)[3]}')
    for keys in (KEY_RUN, 'u' * 12, 'd' * 9 + 'u' * 4 + 'D' * 3, 'U' + 'u' + 'd' * 3):
        got = [s[:3] for s in sub_keys(sub_open(new, 0x020000d3)[0], keys)]
        check(got == adj_model(n, keys), f'{name}: ADJ Mode Setting keys {keys}: {got} / {adj_model(n, keys)}')
    # OK on every line: the line's list opens; the line is remembered and shown again on return.
    for i in range(n):
        e = sub_open(new, 0x020000d3)[0]
        for _ in range(i):
            e.call(SUB_DOWN, (e.this, 0))
        e.calls.clear()
        e.call(SUB_OK, (e.this,))
        opened = [c[2] for c in e.calls if c[0] == 'open']
        check(opened == [0x020000a8 + i if i < 5 else ADJ_LIST_ID + i - 5], f'{name}: OK on line {i} opens {[hex(x) for x in opened]}')
        depth = e.byte(e.this + 0x175)
        check(struct.unpack('<H', e.mu.mem_read(e.this + 0x176 + 2 * depth, 2))[0] == i, f'{name}: line {i} remembered')
        e.call(SUB_SHOW, (e.this,))
        st = sub_state(e)
        check(st[1] == i and st[2] <= 60 * i <= st[2] + 300, f'{name}: back on line {i}: {st}')
    print(f'  {name}: every menu as the reference (no new item), {compared} other submenus the same (rows, keys), '
          f'ADJ Mode Setting {n} lines (texts, value icons, list {60 * min(n, 6)} px, focus / scroll for every key, OK on every line '
          f'and back), {lines} lists (set / is current for every value)')
    # Texts.
    for row, want in ((1, [f'Setting{6 + k}' for k in range(lines)]), (0, [f'設定{6 + k}' for k in range(lines)]), (19, [f'设定{6 + k}' for k in range(lines)])):
        got = [dm.text(new, row, T0 + 1 + k) for k in range(lines)]
        check(got == want, f'{name}: texts row {row}: {got}')
    allrows = [[dm.text(new, row, T0 + 1 + k) for k in range(lines)] for row in range(21)]
    check(all(all(str(6 + k) in r[k] and '1' not in r[k] for k in range(lines)) for r in allrows), f'{name}: a text without its number {allrows}')
    def text_slot(img, row, tid):
        r = img.u32(dm.TEXT_CATALOG + row * 4)
        return img.u32(r + tid * 4)
    check(all(text_slot(new, row, T0) == 0 for row in range(21)), f'{name}: text {T0} is used')
    print('      texts:', allrows[1], allrows[0], allrows[19])


# ------------------------------------------------------------------------------------------------
# Guard

def check_guard(d, name, n, softfocus):
    new = dm.Image(d / name)
    save = 0x533e1c04
    w = new.u32(save)
    stub = save + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4
    bls = []
    for k in range(12):
        x = new.u32(stub + 4 * k)
        if (x >> 24) == 0xeb:
            bls.append(stub + 4 * k + 8 + (((x & 0xffffff) ^ 0x800000) - 0x800000) * 4)
    fix = bls[1]
    import random
    rnd = random.Random(8)
    count = 0
    for _ in range(400):
        e = dm.Emu(new)
        settings = 0x70400000
        b = [rnd.randrange(256) for _ in range(3)]
        p = rnd.choice([0, 1, 4, 5, 6, 0x7f, 0xff])
        e.mu.mem_write(settings + 0x48d, bytes(b))
        e.mu.mem_write(settings + 0x91e, bytes([p]))
        e.mu.mem_write(settings + 0x48c, bytes([0xa5]))
        e.mu.mem_write(settings + 0x490, bytes([0x5a]))
        e.call(fix, (settings, 0))
        got = [e.byte(settings + 0x48d + j) for j in range(3)]
        want = []
        for j in range(3):
            k = 5 + j
            if k >= n:
                want.append(0)
                continue
            f = b[j] & 0x1f
            ok = f <= 20 and (softfocus or f != 10)
            v = (b[j] & 0xe0) | (f if ok else 0)
            if j == 0:
                if (v >> 5) > n - 5:
                    v &= 0x1f
            else:
                v &= 0x1f
            want.append(v)
        check(got == want, f'{name}: guard {b} -> {got} want {want}')
        check(e.byte(settings + 0x91e) == (p if p <= 4 else 0), f'{name}: guard 0x91E {p}')
        check(e.byte(settings + 0x48c) == 0xa5 and e.byte(settings + 0x490) == 0x5a, f'{name}: guard touched a neighbour')
        count += 1
    print(f'  {name}: guard ({count} random settings): slots 6..{n}, remembered slot, 0x91E')


# ------------------------------------------------------------------------------------------------
# Calls of the module and the stubs

def check_calls(d, name):
    img = dm.Image(d / name)
    src = (ROOT / 'core' / 'src' / 'fw' / 'aspect' / 'adjslots-code.ts').read_text()
    code = base64.b64decode(re.search(r"ADJSLOTS_CODE = '([^']+)'", src).group(1))
    # find the module in the image
    at = img.R.find(code)
    check(at > 0, f'{name}: module not found')
    md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)
    regs, targets = {}, set()
    for i in md.disasm(code, 0x53000000 + at):
        m = re.match(r'(\w+), #(0x[0-9a-f]+|\d+)$', i.op_str)
        if i.mnemonic == 'movw' and m:
            regs[m.group(1)] = int(m.group(2), 0)
        elif i.mnemonic == 'movt' and m and m.group(1) in regs:
            regs[m.group(1)] |= int(m.group(2), 0) << 16
        elif i.mnemonic.startswith('ldr') or i.mnemonic in ('mov', 'add', 'sub') and not i.op_str.startswith('sp'):
            regs.pop(i.op_str.split(',')[0].strip(), None)
        elif i.mnemonic == 'blx':
            r = i.op_str.strip()
            if r in regs and regs[r] > 0x53000000:
                targets.add(regs[r])
        elif i.mnemonic.startswith('b') and i.op_str.startswith('#'):
            t = int(i.op_str[1:], 16)
            check(0x53000000 + at <= t < 0x53000000 + at + len(code), f'{name}: module branch out of itself {t:#x}')
    allowed = {0x5323ea84, 0x5323f018, 0x5323f378, 0x531bcd00, 0x531bd580, 0x533817f0, 0x5357013c, 0x53576e38, 0x53589ab4, 0x535888a8,
               0x53183e14, 0x538e09b0, 0x535885a4, 0x531831e8, 0x5333a114}
    check(targets <= allowed, f'{name}: module calls {sorted(hex(t) for t in targets - allowed)}')
    # each is a function the firmware itself calls (a bl to it exists in the official image)
    off = dm.Image(d / 'official.rtos')
    called = set()
    for o in range(0, 0x13d2ac0, 4):
        x = struct.unpack_from('<I', off.R, o)[0]
        if (x >> 24) in (0xeb, 0xea):
            called.add(0x53000000 + o + 8 + (((x & 0xffffff) ^ 0x800000) - 0x800000) * 4)
    for t in targets:
        check(t in called, f'{name}: {t:#x} is not a function the firmware calls')
    print(f'  {name}: module calls {len(targets)} firmware functions, all at their entries; no branch leaves it')


def main():
    global REFERENCE
    d = Path(sys.argv[1])
    REFERENCE = sys.argv[4] if len(sys.argv) > 4 else None
    # python3 check.py DIR [NAME N]: only the image DIR/NAME with N slots, built with soft focus and the
    # other menu additions (a test firmware's decoded RTOS); DIR also holds official.rtos.
    if len(sys.argv) > 3:
        images = ((sys.argv[2], int(sys.argv[3]), True),)
    else:
        print('controller, five slots through the new code:')
        compare_official(d)
        images = (('n6.rtos', 6, False), ('n7.rtos', 7, False), ('n8.rtos', 8, False), ('n8sf.rtos', 8, True), ('n8all.rtos', 8, True))
    for name, n, sf in images:
        print(f'{name}:')
        check_slots(d, name, n, sf)
        check_menu(d, name, n, other_menu_ids=(1,) if 'all' in name or len(sys.argv) > 3 else (),
                   reference=('n5all.rtos' if 'all' in name else REFERENCE))
        check_guard(d, name, n, sf)
        check_calls(d, name)
    if failures:
        print(f'{len(failures)} FAILURES')
        for f in failures[:int(__import__("os").environ.get("SHOW", "40"))]:
            print('  ', f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
