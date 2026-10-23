# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the settings guard and the look stash (0.8.2) on 1.11 and 1.20 builds
(development tool; core/src/fw/aspect/guard.ts, lookstash.ts).

Builds with GR Mod's own builder (tools/port120/build.ts) and runs what the builds hold:

 1. The guard's fix(settings, adjust) on every value of every byte it looks at: a look the camera
    does not know (from 31 in 1.11, 33 in 1.20, whose looks 31 and 32 are the Monochrome's new
    ones) becomes Standard (11), the ratio above 3:2..16:9 becomes 3:2 without added ratios,
    an ADJ function 0x0A or above 0x14 becomes 0 without soft focus; nothing else changes.
 2. Its three hooks: the settings load (the prior load first, with the arguments as they came;
    then the loaded settings, the user modes' ten snapshots and the live settings are fixed; the
    prior result is returned), the settings save (the live settings and the snapshots fixed, then
    the prior save with the mode) and the user-mode recall (the recalled settings fixed, every
    register as it came at the prior recall).
 3. With the date imprint, the look stash: the hook of the development step's read of the look
    leaves `look | 0x10000` in the word 16 bytes into the 44 unused bytes before the heap, every
    register as officially; when shooting (the step's flag +0x2AC set) nothing else, in RAW
    development (flag 0) also the orientation of the record being developed (+0x2D0) by the EXIF
    writer's rule (+0x71E84 when +0x71E83 is set, else +0xD8; 1..3 kept, anything else 0) in the
    word 32 bytes in (0.8.3); the start-up zero fill reaches the heap; the imprint's context holds
    the two words, the table of the target's black-and-white looks and the Monochrome check, which
    returns 1 for edition 1 only.
 4. The exposure hook (0.8.3): at the start of each exposure the camera's direction, read through
    the variant root singleton (+4 -> +0x518 -> record -> +0xD8, every pointer checked), goes into
    the orientation word (4 / 5, lens up / down, as 0); every register as it came.

    python3 check_guard.py [111|120 ...]
"""
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_ratios  # noqa: E402
import fwtarget  # noqa: E402

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE  # noqa: E402
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4,  # noqa: E402
                               UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_SB,
                               UC_ARM_REG_SL, UC_ARM_REG_FP, UC_ARM_REG_IP, UC_ARM_REG_SP, UC_ARM_REG_LR,
                               UC_ARM_REG_PC)

BASE = 0x53000000
RAMVA = 0x55000000
FAKE = 0x60000000
RET = 0x100
REGS = (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
        UC_ARM_REG_R8, UC_ARM_REG_SB, UC_ARM_REG_SL, UC_ARM_REG_FP, UC_ARM_REG_IP, UC_ARM_REG_SP, UC_ARM_REG_LR)
LOOKS = (0x153, 0x154, 0x155, 0x156, 0x515, 0x516, 0x517, 0x518)
RATIO = 0x49F
ADJ = (0x920, 0x921, 0x922, 0x923, 0x924)
SIZE = 0xB44  # the longer user settings (1.20); 1.11's are 0xAE9
STANDARD = 11
failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


def branch(at, w):
    d = w & 0xFFFFFF
    return at + 8 + ((d ^ 0x800000) - 0x800000) * 4


class Machine:
    def __init__(self, rtos, t):
        self.t = t
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, max((len(rtos) + 0xFFFFF) & ~0xFFFFF, 0x1500000))
        mu.mem_write(BASE, rtos)
        mu.mem_map(RAMVA, 0x1000000)
        mu.mem_write(RAMVA, rtos[t.ram_src - BASE:t.ram_src - BASE + t.ram_len])
        mu.mem_map(FAKE, 0x400000)
        mu.mem_map(0, 0x1000)
        self.mu, self.rtos, self.stubs = mu, rtos, {}
        mu.hook_add(UC_HOOK_CODE, self._hook)

    def _hook(self, uc, address, size, _):
        if address in self.stubs:
            v = self.stubs[address](uc)
            if v is not None:
                uc.reg_write(UC_ARM_REG_R0, v & 0xFFFFFFFF)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def word(self, va):
        return struct.unpack('<I', self.mu.mem_read(va, 4))[0]

    def call(self, fn, args=(), lr=RET, stop=RET, regs=None):
        for r, v in zip(REGS, args):
            self.mu.reg_write(r, v)
        for r, v in (regs or {}).items():
            self.mu.reg_write(r, v)
        self.mu.reg_write(UC_ARM_REG_SP, FAKE + 0x3F0000)
        self.mu.reg_write(UC_ARM_REG_LR, lr)
        self.mu.emu_start(fn, stop, count=200000)
        return self.mu.reg_read(UC_ARM_REG_R0)


def branches(m, start, n=40):
    """(address, kind, target) of the b / bl of the function at `start`, in order: up to its
    tail branch (`b`) or its return (`pop {..., pc}`)."""
    out = []
    for k in range(n):
        at = start + 4 * k
        w = m.word(at)
        if (w >> 25) & 7 == 5 and w >> 28 == 0xE:
            out.append((at, 'bl' if w & (1 << 24) else 'b', branch(at, w)))
            if not w & (1 << 24):
                break
        elif (w & 0xFFFF8000) == 0xE8BD8000:
            break
    return out


def expected(offset, value, t, ratios, soft):
    if offset in LOOKS:
        return value if value < t.looks else STANDARD
    if offset == RATIO:
        return value if ratios or value <= 3 else 0
    if offset in ADJ:
        return value if soft or not (value == 0x0A or value > 0x14) else 0
    return value


def settings(m, at, fill):
    m.mu.mem_write(at, bytes((fill + i * 7) & 0xFF for i in range(SIZE)))


def check_build(tag, name, options, ratios, soft):
    out, summary = check_ratios.build(tag, name, options=options, ratios=ratios)
    rtos = (out.parent / (out.name + '.rtos')).read_bytes()
    t = fwtarget.select(rtos)
    V = fwtarget.V
    m = Machine(rtos, t)
    what = f'{tag} {name}'
    print(f'== {what}: {summary["inspect"]}')

    # --- the hooks and the guard's functions
    recall_at, save_at, load_at, current = V(0x532A90CC), V(0x533E1C04), V(0x533E17CC), V(0x5323F018)
    rw, sw, lw = m.word(recall_at), m.word(save_at), m.word(load_at)
    check(rw >> 24 == 0xEB and sw >> 24 == 0xEA and lw >> 24 == 0xEA, f'{what}: the three sites are hooked')
    recall, save, load = branch(recall_at, rw), branch(save_at, sw), branch(load_at, lw)
    rb, sb, lb = branches(m, recall), branches(m, save), branches(m, load)
    fix = rb[0][2]
    prior_recall = rb[-1][2]
    check([k for _, k, _ in rb] == ['bl', 'b'], f'{what}: recall wrapper calls fix, then the prior recall')
    check([k for _, k, _ in sb] == ['bl', 'bl', 'bl', 'b'] and sb[0][2] == current and sb[1][2] == fix, f'{what}: save wrapper: CURRENT, fix, fix_mode, prior save')
    fix_mode, prior_save = sb[2][2], sb[3][2]
    check([k for _, k, _ in lb] == ['bl', 'bl', 'bl', 'bl', 'bl'] and lb[1][2] == fix and lb[2][2] == fix_mode and lb[3][2] == current and lb[4][2] == fix,
          f'{what}: load wrapper: prior load, fix, fix_mode, CURRENT, fix')
    prior_load = lb[0][2]
    for p in (prior_recall, prior_save, prior_load):
        check(p >= BASE + t.rtos_len or p in (V(0x5323EA84),), f'{what}: prior hook {p:#x} is GR Mod\'s or the official call')

    # --- 1. fix() on every value of every byte it looks at
    buf = FAKE + 0x10000
    bad = []
    for off in LOOKS + (RATIO,) + ADJ:
        for value in list(range(64)) + [0x7F, 0xFF]:
            settings(m, buf, 0x5A)
            m.mu.mem_write(buf + off, bytes([value]))
            before = bytes(m.mu.mem_read(buf, SIZE))
            # values the guard fixes elsewhere in the filler are kept out of the comparison
            m.call(fix, (buf, 0))
            after = bytes(m.mu.mem_read(buf, SIZE))
            want = expected(off, value, t, ratios, soft)
            if after[off] != want:
                bad.append((hex(off), value, after[off], want))
            others = [o for o in range(SIZE) if o != off and after[o] != before[o] and expected(o, before[o], t, ratios, soft) == before[o]]
            if others:
                bad.append((hex(off), value, 'also changed', [hex(o) for o in others[:4]]))
    check(not bad, f'{what}: fix(): {bad[:6]}')
    print(f'   fix(): {len(LOOKS + (RATIO,) + ADJ) * 66} cases; looks kept below {t.looks}, ratio {"kept" if ratios else "above 3 -> 0"}, ADJ {"kept" if soft else "0x0A / above 0x14 -> 0"}')
    settings(m, buf, 0)
    m.mu.mem_write(buf + 0x153, bytes([t.looks]))
    m.call(fix, (buf + 4, 4))
    check(m.mu.mem_read(buf + 0x153, 1)[0] == STANDARD, f'{what}: fix(settings + 4, 4) works on the snapshot layout')
    m.call(fix, (0, 0))  # a null pointer: nothing

    # --- 2. the three wrappers
    def bad_settings(at, shift=0):
        settings(m, at - shift, 0)
        for o in LOOKS:
            m.mu.mem_write(at - shift + o, bytes([t.looks + 1]))
        m.mu.mem_write(at - shift + RATIO, bytes([9]))
        m.mu.mem_write(at - shift + ADJ[0], bytes([0x0A]))

    def fixed(at, shift=0):
        b = bytes(m.mu.mem_read(at - shift, SIZE))
        return all(b[o] == STANDARD for o in LOOKS) and b[RATIO] == (9 if ratios else 0) and b[ADJ[0]] == (0x0A if soft else 0)
    cur, mode, loaded = FAKE + 0x20000, FAKE + 0x30000, FAKE + 0x40004
    snaps = [FAKE + 0x50004 + 0x1000 * k for k in range(10)]
    m.mu.mem_write(mode, struct.pack('<11I', 0x4D4F4445, *snaps))
    seen = {}
    m.stubs[current] = lambda uc: cur

    def at_prior(uc, name):
        seen[name] = [uc.reg_read(r) for r in REGS[:13]] + [uc.reg_read(UC_ARM_REG_LR)]
        seen[name + '-look'] = uc.mem_read(loaded - 4 + 0x153, 1)[0]
        return 0x1234
    # load
    for s in [cur, loaded] + snaps:
        bad_settings(s, 0 if s == cur else 4)
    m.stubs[prior_load] = lambda uc: at_prior(uc, 'load')
    r = m.call(load, (mode, loaded))
    check(r == 0x1234 and seen['load'][:2] == [mode, loaded] and seen['load-look'] == t.looks + 1, f'{what}: load: the prior load first, with its arguments; its result returned')
    check(fixed(loaded, 4) and fixed(cur) and all(fixed(s, 4) for s in snaps), f'{what}: load: loaded settings, live settings and the ten snapshots fixed')
    del m.stubs[prior_load]
    # save
    for s in [cur] + snaps:
        bad_settings(s, 0 if s == cur else 4)
    m.stubs[prior_save] = lambda uc: at_prior(uc, 'save')
    m.call(save, (mode,))
    check(seen.get('save', [None])[0] == mode and fixed(cur) and all(fixed(s, 4) for s in snaps), f'{what}: save: live settings and snapshots fixed, then the prior save with the mode')
    del m.stubs[prior_save]
    # recall
    bad_settings(cur)
    m.stubs[prior_recall] = lambda uc: at_prior(uc, 'recall')
    sentinels = [0x11, 0x22, 0x33, 0x44, cur, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, FAKE + 0x3F0100, 0xCC]
    m.call(recall, sentinels)
    check(fixed(cur) and seen.get('recall') == sentinels + [RET], f'{what}: recall: the recalled settings fixed, registers as they came')
    del m.stubs[current]

    # --- 3. the look stash and the date imprint's context
    if options.get('dateStamp'):
        site = V(0x539113F8)
        stash = t.bss_end + 0x10
        hook = m.word(site)
        check(hook >> 24 == 0xEA, f'{what}: the development step\'s read of the look is hooked')
        check(m.word(V(0x53000460)) == t.heap, f'{what}: the start-up zero fill reaches the heap (clears the stash)')
        orient = t.bss_end + 0x20
        rec, arg, raw = FAKE + 0x60000, FAKE + 0x62000, FAKE + 0x100000
        bad = []
        cases = [(look, 1, 0, 0) for look in range(40)]  # shooting: the look only
        cases += [(7, 0, flag, d) for flag in (0, 1) for d in range(7)]  # RAW development: and the orientation
        for look, shooting, flag, d in cases:
            m.mu.mem_write(rec, bytes(0x800))
            m.mu.mem_write(rec + 0x79C, bytes([look]))
            m.mu.mem_write(arg, bytes(0x400))
            m.mu.mem_write(arg + 0x2AC, bytes([shooting]))
            m.mu.mem_write(arg + 0x2D0, struct.pack('<I', raw))
            m.mu.mem_write(raw, bytes(0x100))
            m.mu.mem_write(raw + 0x71E80, bytes(8))
            m.mu.mem_write(raw + 0x71E83, bytes([flag, d if flag else 0x77]))
            m.mu.mem_write(raw + 0xD8, bytes([0x77 if flag else d]))
            m.mu.mem_write(stash, b'\0\0\0\0')
            m.mu.mem_write(orient, struct.pack('<I', 0x5EED))
            regs = [0x10, arg, 0x12, rec, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, FAKE + 0x3F0100, 0x1C]
            m.call(site, regs, stop=site + 4)
            got = [m.mu.reg_read(r) for r in REGS[:13]]
            want = regs[:2] + [look] + regs[3:]
            want_orient = 0x5EED if shooting else ((d if d <= 3 else 0) | 0x100)
            if got != want or m.word(stash) != (look | 0x10000) or m.word(orient) != want_orient:
                bad.append((look, shooting, flag, d, hex(m.word(stash)), hex(m.word(orient)), [hex(g) for g in got[:4]]))
        check(not bad, f'{what}: look stash: {bad[:4]}')
        execute = V(0x537034B4)
        stub = branch(execute, m.word(execute))
        mv = lambda w: ((w >> 4) & 0xF000) | (w & 0xFFF)
        ctx = mv(m.word(stub + 8)) | (mv(m.word(stub + 12)) << 16)
        words = struct.unpack('<10I', m.mu.mem_read(ctx, 40))
        table = bytes(m.mu.mem_read(words[7], 64))
        check(words[6] == stash and words[8] == V(0x533EF000) and words[9] == orient,
              f'{what}: date imprint context: stash {words[6]:#x}, Monochrome check {words[8]:#x}, orientation {words[9]:#x}')
        check([i for i in range(64) if table[i]] == list(t.mono_looks), f'{what}: black-and-white looks {[i for i in range(64) if table[i]]}')
        for edition, want in ((0, 0), (1, 1), (2, 0), (3, 0)):
            m.stubs[V(0x5323EA84)] = lambda uc: FAKE + 0x70000
            m.stubs[V(0x5323FF28)] = lambda uc: FAKE + 0x71000
            m.stubs[V(0x533E0324)] = lambda uc, e=edition: e
            check(m.call(words[8]) == want, f'{what}: Monochrome check for edition {edition}')
        print(f'   look stash at {stash:#x}, orientation at {orient:#x}: {len(cases)} cases; context, table {list(t.mono_looks)}, Monochrome check')

        # --- 4. the exposure hook
        at = V(0x53628CD8)
        singleton = V(0x5537960C)
        check(m.word(at) >> 24 == 0xEA, f'{what}: the start of the exposure is hooked')
        obj, holder, record = FAKE + 0x80000, FAKE + 0x81000, FAKE + 0x82000
        bad = []
        for d in list(range(7)) + [None]:
            m.mu.mem_write(singleton, struct.pack('<2I', 0, obj if d is not None else 0x10))
            m.mu.mem_write(obj + 0x518, struct.pack('<I', holder))
            m.mu.mem_write(holder, struct.pack('<I', record))
            m.mu.mem_write(record + 0xD8, bytes([d or 0]))
            m.mu.mem_write(orient, struct.pack('<I', 0x5EED))
            regs = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, FAKE + 0x3F0100, 0x1C]
            m.call(at, regs, stop=at + 4)
            got = [m.mu.reg_read(r) for r in REGS[:14]]
            want = regs[:12] + [FAKE + 0x3F0000, FAKE + 0x3F0000]  # ip = sp (the displaced mov ip, sp)
            want_orient = 0x5EED if d is None else ((d if d <= 3 else 0) | 0x100)
            if got != want or m.word(orient) != want_orient:
                bad.append((d, hex(m.word(orient)), [hex(g) for g in got]))
        check(not bad, f'{what}: exposure hook: {bad[:3]}')
        print(f'   exposure hook at {at:#x}: direction through {singleton:#x}, 7 directions and a bad pointer')


def main():
    tags = sys.argv[1:] or ['111', '120']
    for tag in tags:
        check_build(tag, 'guard_date', {'dateStamp': True}, [], False)
        check_build(tag, 'guard_all', {'adjSoftFocus': True, 'dateStamp': True}, [{'name': 'XPan', 'ratio': '65:24'}], True)
    print('FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
