# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of Constant Light (core/src/fw/gr4v121/aspect/lamp.ts): the front lamp kept lit,
switched by a line of the still menu, an ADJ lever function and an Fn function.

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn (the harness of
tools/gr4v121/datestamp/menu_check.py), next to a build of the same recipe without Constant Light
(CONTROL):

 1. The still menu of every model (0 GR IV, 1 HDF, 2 Monochrome): the control's lines with the new
    one after AF Assist Light, the other four tabs the control's; in the official layout or the
    wide one (more than 38 lines), whichever the build has.
 2. The line: icon Off / On by the lamp's word, the title.
 3. The controller factory and SelectMenuController::SetCurrentMenu for the list id (every other id
    as in the control); the list's handlers.
 4. The lamp, on LED objects made by the camera's own constructors (the lamp, SelfLed,
    AfAssistLed) with a recording device: `set` (on, off, off while the self-timer or the auto
    focus has the lamp, no lamp object, not initialised); the camera's own AF assist and self-timer
    requests (their real on and off functions) with Constant Light on (the lamp is never switched
    off, their flags and the mutex as officially) and off (exactly as the control); the lamp's off
    called directly; `toggle`; the shutdown handler's entry.
 5. The ADJ function table: copied with one more record, the others the control's, every reference,
    the initialiser's walk, name and icon of every function, ADJ Mode Setting's list, the handlers;
    the slot getters (builds with soft focus) and the guard's slot bound.
 6. The Fn function 0x29: name and icon of every function, the list of the four buttons (as data
    and as the list controller's vector, filled by the camera's own code), the function switch for
    every function, pressed and released: 0x29 switches the lamp over on a press and nothing else,
    every other function goes where it goes in the control. The Movie button: its two lists (pressed,
    held) the same way, its switch 0x53398320 for every function and event (2 pressed, 3 held, 4):
    0x29 switches the lamp over on events 2 and 3, nothing and no assertion on 4.
 7. The text in the 21 languages, the icon.

    python3 check.py BUILT-RTOS CONTROL-RTOS
"""
import struct
import sys
from pathlib import Path

from unicorn import UC_HOOK_CODE, UcError
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5,
                               UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11,
                               UC_ARM_REG_R12, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as dm  # noqa: E402
from menu_check import Image, Emu  # noqa: E402

failures = dm.failures
check = dm.check

LAMP_WORD = 0x55839074
LAMP_LIST = 0x020001d4
AF_ASSIST = 0x02000075
T_NAME, T_ON, T_OFF = 1040, 1, 2
I_LAMP, I_OFF, I_ON = 738, 329, 330
FN_LAMP = 0x29
BUILDER = 0x531b5878
TABS, WIDE = 5, 42
C_ID, C_DRAW, C_VIS = 0x13ec, 0x1734, 0x1dc4
FACTORY_GET, SHUTDOWN = 0x53968e04, 0x53260068
LAMP_CTOR, SELF_CTOR, AF_CTOR = 0x539684b4, 0x539684dc, 0x53968958
LAMP_ON, LAMP_OFF = 0x53968210, 0x53968040
AF_ON, AF_OFF_IF_ON, SELF_ON, SELF_OFF = 0x53968974, 0x539689f8, 0x539684f8, 0x53968260
MUTEX_TAKE, MUTEX_GIVE = 0x53909f74, 0x53909ec0
ADJ_TABLE = 0x53dcb494
ADJ_SITES = [(0x531bdad0, 0x531bdae0), (0x531bf494, 0x531bf49c), (0x531bf630, 0x531bf638), (0x531bf6cc, 0x531bf6d4), (0x531bfbc8, 0x531bfbd0),
             (0x531c05dc, 0x531c05e4), (0x531c0638, 0x531c0640), (0x531c0730, 0x531c0738), (0x531c07bc, 0x531c07c4), (0x531c0848, 0x531c0850),
             (0x531c08f0, 0x531c08f8), (0x531c0a3c, 0x531c0a44), (0x531c0bdc, 0x531c0be4), (0x531c0cd8, 0x531c0cf0), (0x531c0fe4, 0x531c0fec),
             (0x531c10f0, 0x531c10f8), (0x531c119c, 0x531c11a4), (0x531c1204, 0x531c1214), (0x531c12c0, 0x531c12d0), (0x531c14a4, 0x531c14ac),
             (0x531c1668, 0x531c166c), (0x531c1828, 0x531c1830)]
FN_LIST_OFFICIAL = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
                    0x15, 0x16, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x2d, 0x2c, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x2b, 0x23, 0x24]
NAMES = ['Trvalé světlo', 'Konstant lys', 'Constant Light', 'Jatkuva valo', 'Lumière continue', 'Dauerlicht', 'Συνεχές φως', 'Folyamatos fény',
         'Luce continua', '補助光常時点灯', '보조광 상시 점등', 'Continu licht', 'Światło ciągłe', 'Luz contínua', 'Постоянный свет', '辅助灯常亮',
         'Luz continua', 'Konstant ljus', 'ไฟส่องต่อเนื่อง', '輔助燈常亮', 'Sürekli ışık']

# Where the LED objects are made for the checks; the device's on / off are two addresses that only record.
FACTORY, SELF_LED, AF_LED, LAMP, DEVICE, DEVICE_VT, DEV_ON, DEV_OFF = 0x70100000, 0x70100080, 0x70100100, 0x70100200, 0x70100300, 0x70100400, 0x70180000, 0x70180010
HANDLE = LAMP  # what the lamp's word holds while Constant Light is on


def appended(v):
    """An address in what the build appended: such addresses differ between the build and its control."""
    return v >= dm.BASE + dm.OFFICIAL_LEN and v < 0x55000000


def same_words(a, b):
    """Two tuples of words, equal but for addresses of appended code."""
    return len(a) == len(b) and all(x == y or (appended(x) and appended(y)) for x, y in zip(a, b))


def branch_target(img, at):
    w = img.u32(at)
    assert (w >> 24) in (0xea, 0xeb, 0x0a, 0x1a), f'{at:#x}: {w:#x} is not a branch'
    return at + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4


def bls(img, at, n=16):
    return [at + 4 * k + 8 + (((img.u32(at + 4 * k) & 0xffffff) ^ 0x800000) - 0x800000) * 4 for k in range(n) if img.u32(at + 4 * k) >> 24 == 0xeb]


# ------------------------------------------------------------------------------------------------
# 1. The still menu

def menus(img, model):
    """Per tab (header 0x8C, [(id, draw, vis)], count), in the official or the wide layout."""
    e = Emu(img, model)
    this = 0x70000000
    e.call(BUILDER, (this,))
    check(not [c for c in e.calls if c[0] == 'ASSERT'], f'builder asserted (model {model})')
    out = []
    wide = None
    for m in range(TABS):
        blk = bytes(e.mu.mem_read(this + 0x230 + m * 0x38c, 0x38c))
        n = blk[0x8b]
        narrow = [(struct.unpack_from('<I', blk, 0x1bc + 4 * k)[0], struct.unpack_from('<2I', blk, 0x8c + 8 * k), struct.unpack_from('<2I', blk, 0x254 + 8 * k)) for k in range(min(n, 38))]
        if wide is None:
            wide = n > 0 and all(i == 0 for i, _, _ in narrow)
        if wide:
            items = [(struct.unpack('<I', e.mu.mem_read(this + C_ID + (m * WIDE + k) * 4, 4))[0],
                      struct.unpack('<2I', e.mu.mem_read(this + C_DRAW + (m * WIDE + k) * 8, 8)),
                      struct.unpack('<2I', e.mu.mem_read(this + C_VIS + (m * WIDE + k) * 8, 8))) for k in range(n)]
        else:
            items = narrow
        out.append((blk[:0x8c], items, n))
    return out, wide


def check_menus(new, ctl):
    line = {}
    for model in (0, 1, 2):
        (nm, nwide), (cm, cwide) = menus(new, model), menus(ctl, model)
        for m in range(1, TABS):
            check(nm[m][2] == cm[m][2] and all(a[0] == b[0] and same_words(a[1] + a[2], b[1] + b[2]) for a, b in zip(nm[m][1], cm[m][1])), f'model {model}: tab {m} differs from the control')
        (ch, citems, cn), (nh, nitems, nn) = cm[0], nm[0]
        want = []
        for it in citems:
            want.append(it[0])
            if it[0] == AF_ASSIST:
                want.append(LAMP_LIST)
        nids, cids = [i for i, _, _ in nitems], [i for i, _, _ in citems]
        check(nids == want and nn == cn + 1, f'model {model}: still ids {[hex(i) for i in nids]}')
        kept = [it for it in nitems if it[0] != LAMP_LIST]
        check(len(kept) == len(citems) and all(a[0] == b[0] and same_words(a[1] + a[2], b[1] + b[2]) for a, b in zip(kept, citems)), f'model {model}: still lines other than the new one differ')
        ours = [it for it in nitems if it[0] == LAMP_LIST]
        check(len(ours) == 1 and ours[0][1][0] != 0 and ours[0][1][1] == 0 and ours[0][2] == (0, 0), f'model {model}: the new line {ours}')
        cfirst = [cids[f] for f in ch[0x80:0x80 + ch[0x68]]]
        nfirst = [nids[f] for f in nh[0x80:0x80 + nh[0x68]]]
        check(nh[0x68] == ch[0x68] and cfirst == nfirst, f'model {model}: page firsts {nfirst} / {cfirst}')
        check(nn <= (WIDE if nwide else 38), f'model {model}: {nn} lines')
        line[model] = ours[0][1][0] if ours else 0
        print(f'  model {model}: still menu {nn} lines (control {cn}; {"wide" if nwide else "official"} layout{"" if nwide == cwide else ", the control official"}), the new line after AF Assist Light; tabs 1..4 as the control')
    check(len(set(line.values())) == 1, 'the line has one draw function')
    return line[0]


# ------------------------------------------------------------------------------------------------
# 2-3. The line and the list

def check_line(new, draw):
    for word in (0, HANDLE, 1):
        e = Emu(new)
        e.mu.mem_write(LAMP_WORD, struct.pack('<I', word))
        e.call(draw, (0x70000000, 0x70700000))
        calls = [c for c in e.calls if c[0] in ('top-icon', 'top-title')]
        check(len(calls) == 2 and calls[0][:3] == ('top-icon', 0x70700000, I_ON if word else I_OFF) and calls[1][:3] == ('top-title', 0x70700000, T_NAME), f'line, word {word:#x}: {calls}')
        check(e.u32(LAMP_WORD) == word, 'line changed the word')
    print('  the line: icon Off / On, title', T_NAME)


def lamp_emu(img, word=0, initialised=1, lamp=True, af_has=0, self_has=0):
    """An emulator with the LED objects as the camera's own constructors make them, on a device
    that records: `events` gets 'on' / 'off' for the device calls, `mutex` the takes and gives."""
    e = Emu(img)
    mu = e.mu
    mu.mem_write(FACTORY, bytes(0x600))
    e.events, e.mutex = [], []
    e.stubs[FACTORY_GET] = lambda: FACTORY
    e.stubs[MUTEX_TAKE] = lambda: e.mutex.append('take') or 1
    e.stubs[MUTEX_GIVE] = lambda: e.mutex.append('give') or 0

    def hook(uc, addr, size, ud):
        e.events.append('on' if addr == DEV_ON else 'off')
        check(uc.reg_read(UC_ARM_REG_R0) == DEVICE, 'the device call is not for the lamp\'s device')
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    mu.hook_add(UC_HOOK_CODE, hook, begin=DEV_ON, end=DEV_ON)
    mu.hook_add(UC_HOOK_CODE, hook, begin=DEV_OFF, end=DEV_OFF)
    e.call(LAMP_CTOR, (LAMP,))
    e.call(SELF_CTOR, (SELF_LED, LAMP))
    e.call(AF_CTOR, (AF_LED, LAMP))
    # what the lamp's initialiser leaves: initialised, the device
    mu.mem_write(LAMP + 5, bytes([initialised]))
    mu.mem_write(LAMP + 8, struct.pack('<I', 0x70100500))
    mu.mem_write(LAMP + 0x10, struct.pack('<I', DEVICE))
    mu.mem_write(DEVICE, struct.pack('<I', DEVICE_VT))
    mu.mem_write(DEVICE_VT + 0x54, struct.pack('<2I', DEV_OFF, DEV_ON))
    mu.mem_write(FACTORY + 0xc, struct.pack('<3I', LAMP if lamp else 0, SELF_LED, AF_LED))
    mu.mem_write(SELF_LED + 8, bytes([self_has]))
    mu.mem_write(AF_LED + 8, bytes([af_has]))
    mu.mem_write(LAMP_WORD, struct.pack('<I', word))
    e.calls.clear()
    return e


def lamp_state(e):
    return (e.u32(LAMP_WORD), e.byte(LAMP + 4), e.byte(SELF_LED + 8), e.byte(AF_LED + 8), tuple(e.events), tuple(e.mutex))


def check_list(new, ctl, lamp_set):
    lst = dm.factory_class(ctl, 0x02000094)
    check(dm.factory_class(new, LAMP_LIST) == lst, 'factory: the list id')
    rec = dm.set_current(new, 0x531d7e68, 0x1a4, LAMP_LIST)
    for cid in list(range(0x02000073, 0x02000073 + 0xe3)) + list(range(0x020001a0, 0x020001e0)):
        if cid == LAMP_LIST:
            continue
        a, b = dm.set_current(new, 0x531d7e68, 0x1a4, cid), dm.set_current(ctl, 0x531d7e68, 0x1a4, cid)
        # the records of the additions made after this one: one further
        moved = isinstance(b, int) and isinstance(rec, int) and 126 < rec <= b < 0xee
        check(a == (b + 1 if moved else b), f'list SetCurrentMenu({cid:#x}): {a} vs control {b}')
        if moved:
            ra, rb = new.rd(new.movw_movt(0x531d8864, 0x531d8874) + a * 0x4c, 0x4c), ctl.rd(ctl.movw_movt(0x531d8864, 0x531d8874) + b * 0x4c, 0x4c)
            check(same_words(struct.unpack('<19I', ra), struct.unpack('<19I', rb)), f'list record of {cid:#x} differs from the control')
        if cid >= 0x020001a0:
            check(dm.factory_class(new, cid) == dm.factory_class(ctl, cid), f'factory: {cid:#x} (not ours)')
    check(isinstance(rec, int) and rec > 126, f'list record {rec}')
    table = new.movw_movt(0x531d8864, 0x531d8874)
    r = new.rd(table + rec * 0x4c, 0x4c)
    title = struct.unpack_from('<H', r, 4)[0]
    count, draw, setf, cur = (struct.unpack_from('<I', r, o)[0] for o in (0x0c, 0x14, 0x24, 0x2c))
    check(title == T_NAME, f'list title {title}')
    check(Emu(new).call(count, (0x70000000,)) == 2, 'list count')
    for i in range(3):
        e = Emu(new)
        e.call(draw, (0x70000000, 0x70700000, i))
        items = [c for c in e.calls if c[0] == 'list-item']
        want = [('list-item', 0x70700000, [I_OFF, I_ON][i], [T_OFF, T_ON][i])] if i < 2 else []
        check(items == want, f'list draw {i}: {items}')
    for word in (0, HANDLE):
        got = []
        for i in range(3):
            e = Emu(new)
            e.mu.mem_write(LAMP_WORD, struct.pack('<I', word))
            got.append(e.call(cur, (0x70000000, i)))
        check(got == ([0, 1, 0] if word else [1, 0, 0]), f'list is current, word {word:#x}: {got}')
    for word in (0, HANDLE):
        for i in range(3):
            e = lamp_emu(new, word)
            e.call(setf, (0x70000000, i))
            want_word = [0, HANDLE, word][i]
            want_events = [['off'], ['on'], []][i]
            check(e.u32(LAMP_WORD) == want_word and e.events == want_events, f'list set {i} on word {word:#x}: word {e.u32(LAMP_WORD):#x}, {e.events}')
    check(branch_target(new, setf + 12) == lamp_set, 'the list sets through `set`')
    print(f'  list {LAMP_LIST:#x}: record {rec}, title, Off / On, is current and set; every other id as the control')


# ------------------------------------------------------------------------------------------------
# 4. The lamp

REGS = (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
        UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11)


def check_lamp(new, ctl):
    check(ctl.u32(LAMP_OFF) == 0xe1a0c00d and ctl.u32(SHUTDOWN) == 0xe1a0c00d, 'control: the lamp\'s off and the shutdown handler are the official ones')
    shut_stub = branch_target(new, SHUTDOWN)
    lamp_set = bls(new, shut_stub)[0]
    # the objects as made: the vtables' on / off, the lamp in SelfLed and AfAssistLed
    e = lamp_emu(new)
    vt = e.u32(LAMP)
    check(new.u32(vt + 8) == LAMP_ON and new.u32(vt + 0xc) == LAMP_OFF, 'the lamp\'s vtable')
    check(e.u32(SELF_LED + 4) == LAMP and e.u32(AF_LED + 4) == LAMP, 'SelfLed / AfAssistLed do not hold the lamp')
    # set
    for word in (0, LAMP):
        e = lamp_emu(new, word)
        e.call(lamp_set, (1,))
        check(lamp_state(e) == (LAMP, 1, 0, 0, ('on',), ()), f'set(1), word {word:#x}: {lamp_state(e)}')
        e = lamp_emu(new, word)
        e.mu.mem_write(LAMP + 4, b'\x01')
        e.call(lamp_set, (0,))
        check(lamp_state(e) == (0, 0, 0, 0, ('off',), ()), f'set(0), word {word:#x}: {lamp_state(e)}')
        for kw in (dict(af_has=1), dict(self_has=1)):
            e = lamp_emu(new, word, **kw)
            e.mu.mem_write(LAMP + 4, b'\x01')
            e.call(lamp_set, (0,))
            check(e.u32(LAMP_WORD) == 0 and e.events == [] and e.byte(LAMP + 4) == 1, f'set(0) while the camera has the lamp ({kw}): {lamp_state(e)}')
    for name, kw in (('no lamp object', dict(lamp=False)), ('not initialised', dict(initialised=0))):
        for on in (0, 1):
            for word in (0, LAMP):
                e = lamp_emu(new, word, **kw)
                e.call(lamp_set, (on,))
                check(e.u32(LAMP_WORD) == word and e.events == [] and e.mutex == [], f'set({on}), {name}: {lamp_state(e)}')
    print('  set: on = the word set and the lamp lit; off = the word cleared and the lamp off unless the self-timer or the auto focus has it; nothing without an initialised lamp')
    # the camera's own requests, through its real functions
    sequences = {'AF assist': [(AF_ON, AF_LED), (AF_OFF_IF_ON, AF_LED)], 'self-timer': [(SELF_ON, SELF_LED), (SELF_OFF, SELF_LED)],
                 'AF assist, then self-timer': [(AF_ON, AF_LED), (AF_OFF_IF_ON, AF_LED), (SELF_ON, SELF_LED), (SELF_OFF, SELF_LED)],
                 'off without on': [(AF_OFF_IF_ON, AF_LED)]}
    for name, seq in sequences.items():
        runs = {}
        for key, img, word in (('on', new, LAMP), ('off', new, 0), ('control', ctl, 0)):
            e = lamp_emu(img, word)
            if word:
                e.mu.mem_write(LAMP + 4, b'\x01')
            for fn, obj in seq:
                e.call(fn, (obj,))
            runs[key] = lamp_state(e)
        check(runs['off'] == runs['control'], f'{name}, Constant Light off: {runs["off"]} (control {runs["control"]})')
        w, lit, sf, af, events, mutex = runs['on']
        check(w == LAMP and lit == 1 and sf == 0 and af == 0 and 'off' not in events and mutex == runs['control'][5], f'{name}, Constant Light on: {runs["on"]}')
        check([x for x in runs['control'][4] if x == 'on'] == list(events), f'{name}, Constant Light on: device calls {events}')
    print('  AF assist and the self-timer (their own functions): with Constant Light off as the control; with it on the lamp is never switched off, flags and mutex as officially')
    # the lamp's off, directly
    for word, want in ((0, ['off']), (LAMP, [])):
        e = lamp_emu(new, word)
        e.mu.mem_write(LAMP + 4, b'\x01')
        before = {}
        for k, r in enumerate(REGS[4:]):
            e.mu.reg_write(r, 0x1000 + k)
            before[r] = 0x1000 + k
        e.call(LAMP_OFF, (LAMP,))
        check(e.events == want and e.byte(LAMP + 4) == (1 if word else 0) and e.u32(LAMP_WORD) == word, f'the lamp\'s off, word {word:#x}: {lamp_state(e)}')
        check(all(e.mu.reg_read(r) == v for r, v in before.items()) and e.mu.reg_read(UC_ARM_REG_SP) == 0x600f0000, 'the lamp\'s off: registers')
    print('  the lamp\'s off: nothing while the word is set, else the official function (r4..r11, sp kept)')
    # shutdown
    for word in (0, LAMP):
        for kw in (dict(), dict(af_has=1)):
            e = lamp_emu(new, word, **kw)
            seen = {}

            def hook(uc, addr, size, ud, seen=seen):
                seen['regs'] = [uc.reg_read(r) for r in REGS] + [uc.reg_read(UC_ARM_REG_SP), uc.reg_read(UC_ARM_REG_LR), uc.reg_read(UC_ARM_REG_R12)]
                uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            e.mu.hook_add(UC_HOOK_CODE, hook, begin=SHUTDOWN + 4, end=SHUTDOWN + 4)
            for k, r in enumerate(REGS):
                e.mu.reg_write(r, 0x2000 + k)
            e.mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
            e.mu.reg_write(UC_ARM_REG_LR, 0x100)
            e.mu.emu_start(SHUTDOWN, 0x100, count=100000)
            want = [0x2000 + k for k in range(len(REGS))] + [0x600f0000, 0x100, 0x600f0000]
            check(seen.get('regs') == want, f'shutdown entry, word {word:#x}: registers {seen.get("regs")}')
            check(e.u32(LAMP_WORD) == 0 and e.events == (['off'] if word and not kw else []), f'shutdown, word {word:#x} {kw}: {lamp_state(e)}')
    print('  shutdown: the lamp off and the word cleared, then the handler as it was entered (every register)')
    return lamp_set


# ------------------------------------------------------------------------------------------------
# 5. ADJ

def check_adj(new, ctl, lamp_set):
    tabs = {new.movw_movt(a, b) for a, b in ADJ_SITES}
    ctabs = {ctl.movw_movt(a, b) for a, b in ADJ_SITES}
    check(len(tabs) == 1 and len(ctabs) == 1, f'ADJ table sites {tabs} {ctabs}')
    table, ctable = tabs.pop(), ctabs.pop()
    cn = (ctl.u32(0x531bdc0c) - ctable) // 0x5c
    fn = cn
    check(cn in (21, 22) and (ctable == ADJ_TABLE) == (cn == 21), f'control ADJ table: {cn} records at {ctable:#x}')
    check(new.u32(0x531bdc0c) == table + (fn + 1) * 0x5c, 'ADJ table end word')
    check(same_words(struct.unpack(f'<{fn * 23}I', new.rd(table, fn * 0x5c)), struct.unpack(f'<{fn * 23}I', ctl.rd(ctable, fn * 0x5c))), 'ADJ records before the new one differ from the control')
    crop = ctl.rd(ctable + 0x13 * 0x5c, 0x5c)
    rec = new.rd(table + fn * 0x5c, 0x5c)
    differ = {o for o in range(0, 0x5c, 4) if rec[o:o + 4] != crop[o:o + 4]}
    check(differ == {0x18, 0x20, 0x28, 0x30, 0x3c}, f'ADJ record {fn:#x}: words differing from Crop {sorted(differ)}')
    check(struct.unpack_from('<2I', rec, 0x3c) == (0, 0), 'ADJ record: disabled check')
    for img, name, base, n in ((new, 'new', table, fn + 1), (ctl, 'control', ctable, cn)):
        e = Emu(img)
        seen = {'recs': []}

        def rows(e=e, seen=seen):
            seen['rows'] = e.mu.reg_read(UC_ARM_REG_R2)
            return 0
        e.stubs[0x5359453c] = rows
        e.stubs[0x539091c8] = lambda: 0x70600000
        for f in (0x53909204, 0x53595818, 0x53595824):
            e.stubs[f] = lambda: 0

        def hook(uc, addr, size, ud, seen=seen):
            if addr == 0x531bdb08:
                seen['recs'].append(uc.reg_read(UC_ARM_REG_R4))
            elif addr == 0x531bdaec:
                uc.reg_write(UC_ARM_REG_R0, 5)
                uc.reg_write(UC_ARM_REG_PC, 0x531bdaf0)
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=0x531bdaec, end=0x531bdb0c)
        this = 0x70000000
        e.mu.mem_write(this + 0x1f8, struct.pack('<I', 0x70800000))
        e.call(0x531bdac8, (this,), limit=2_000_000)
        check(seen['recs'] == [base + k * 0x5c for k in range(n)] and seen.get('rows') == 5, f'ADJ initialiser ({name}): {len(seen["recs"])} records, rows {seen.get("rows")}')
        print(f'  ADJ initialiser ({name}): walks {len(seen["recs"])} records to the end and stops')
    for f in range(0x1a):
        a, b = Emu(new).call(0x5338fd34, (0x70000000, f)), Emu(ctl).call(0x5338fd34, (0x70000000, f))
        check(a == (T_NAME if f == fn else b), f'name of ADJ function {f:#x}: {a} (control {b})')
        for var in (0, 1):
            a, b = Emu(new).call(0x533916f0, (0x70000000, f, var)), Emu(ctl).call(0x533916f0, (0x70000000, f, var))
            check(a == ((I_LAMP if var == 0 else 0) if f == fn else b), f'icon of ADJ function {f:#x} variant {var}: {a} (control {b})')
    la, lb = new.movw_movt(0x531dce3c, 0x531dce4c), ctl.movw_movt(0x531dce3c, 0x531dce4c)
    na, nb = new.u32(0x531dce68) & 0xff, ctl.u32(0x531dce68) & 0xff
    fa, fb = list(new.rd(la, na)), list(ctl.rd(lb, nb))
    check(fa == fb + [fn], f'ADJ function list {fa} (control {fb})')
    print(f'  ADJ: function {fn:#x}, table at {table:#x} ({fn + 1} records, every reference), names / icons of 0..0x19, function list {fa}')
    draw, cur, setf, count = (struct.unpack_from('<I', rec, o)[0] for o in (0x18, 0x20, 0x28, 0x30))
    check(Emu(new).call(count, (0x70000000,)) == 2, 'ADJ count')
    for i in range(3):
        e = Emu(new)
        e.mu.mem_write(0x70000000 + 0x1f8, struct.pack('<I', 0x70800000))
        got = []
        e.stubs[0x5359468c] = lambda mu=e.mu: 0x70a00000 + mu.reg_read(UC_ARM_REG_R1)
        e.stubs[0x535a1a60] = lambda mu=e.mu: got.append((mu.reg_read(UC_ARM_REG_R0), mu.reg_read(UC_ARM_REG_R1))) or 0
        e.call(draw, (0x70000000, i))
        check(got == [(0x70a00000 + i, [T_OFF, T_ON, 0][i])], f'ADJ draw {i}: {got}')
    for word in (0, HANDLE):
        got = []
        for i in range(3):
            e = Emu(new)
            e.mu.mem_write(LAMP_WORD, struct.pack('<I', word))
            got.append(e.call(cur, (0x70000000, i)))
        check(got == ([0, 1, 0] if word else [1, 0, 0]), f'ADJ is current, word {word:#x}: {got}')
        for i in range(3):
            e = lamp_emu(new, word)
            e.call(setf, (0x70000000, i))
            check(e.u32(LAMP_WORD) == [0, HANDLE, word][i] and e.events == [['off'], ['on'], []][i], f'ADJ set {i} on word {word:#x}: {e.u32(LAMP_WORD):#x} {e.events}')
    check(branch_target(new, setf + 12) == lamp_set, 'the ADJ function sets through `set`')
    print('  ADJ handlers: count 2, texts Off / On, is current and set')
    # slot getters (soft focus's, when the build has it)
    if new.u32(0x532a0dd4) >> 24 == 0xea:
        for k in range(5):
            g = 0x532a0dd4 + 8 * k
            for v in (0, 0x0a, 0x14, 0x15, 0x16, 0x17, 0x1f, 0xff):
                e = Emu(new)
                e.mu.mem_write(0x70000000 + 0x920 + k, bytes([v]))
                got = e.call(g, (0x70000000,))
                check(got == (v if v <= fn else 0), f'slot getter {k}: {v:#x} -> {got:#x}')
        print(f'  slot getters: 0..{fn:#x} as kept, above: 0')
    else:
        print('  slot getters: the official ones (no soft focus in this build)')
    # the guard's fix: ADJ slots 1..5 (builds without soft focus) and 6..8
    save = 0x533f3f9c
    if new.u32(save) >> 24 == 0xea:
        fix = bls(new, branch_target(new, save), 12)[1]
        official_getters = new.u32(0x532a0dd4) >> 24 != 0xea
        for f in range(0x20):
            e = Emu(new)
            s = 0x70400000
            e.mu.mem_write(s + 0x920, bytes([f] * 5))
            e.mu.mem_write(s + 0x48d, bytes([f, f, f]))
            e.call(fix, (s, 0))
            got = [e.byte(s + 0x920 + j) for j in range(5)]
            if official_getters:
                check(got == [f if f <= fn and f != 0x0a else 0] * 5, f'guard: ADJ slots 1..5 with {f:#x}: {got}')
        print(f'  guard: ADJ slots hold functions up to {fn:#x}')
    return fn


# ------------------------------------------------------------------------------------------------
# 6. Fn

def fn_vector(img):
    """The list controller's vector +0x1B4, as the camera's own code (0x531DD104) fills it."""
    e = Emu(img)
    this = 0x70000000
    e.stubs[0x53242154] = lambda: 0x70200000
    e.stubs[0x53240cac] = lambda: 0x70200000
    e.stubs[0x53909190] = lambda: 0  # operator delete
    e.call(0x531dd104, (this,), limit=2_000_000)
    a, b = e.u32(this + 0x1b4), e.u32(this + 0x1b8)
    return list(e.mu.mem_read(a, b - a))


def run_switch(img, fn, released):
    """The Fn function switch 0x53399990 (this, shared pointer, function, released, key); returns what it called."""
    e = lamp_emu(img)
    sp_pair = 0x70300000
    e.mu.mem_write(sp_pair, struct.pack('<2I', 0x70300100, 0))
    trace = []
    switch_lo, switch_hi = 0x53399990, 0x5339c068

    state = {'prev': 0}

    def hook(uc, addr, size, ud):
        # every call out of the switch into the camera's code: recorded and skipped (r0 = 0);
        # into the appended code: let run (the lamp's own, on lamp_emu's objects)
        prev, state['prev'] = state['prev'], addr
        if switch_lo <= prev < switch_hi and not (switch_lo <= addr < switch_hi) and addr != 0x100:
            if addr >= dm.BASE + dm.OFFICIAL_LEN:
                trace.append('ours')
                return
            trace.append(addr)
            uc.reg_write(UC_ARM_REG_R0, 0)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            state['prev'] = 0
    e.mu.hook_add(UC_HOOK_CODE, hook)
    mu = e.mu
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000 - 8)
    mu.mem_write(0x600f0000 - 8, struct.pack('<2I', 0x2e, 0))
    for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), (0x70000000, sp_pair, fn, released)):
        mu.reg_write(r, v)
    mu.reg_write(UC_ARM_REG_LR, 0x100)
    try:
        mu.emu_start(0x53399990, 0x100, count=200000)
    except UcError as ex:
        trace.append(f'error {ex}')
    done = mu.reg_read(UC_ARM_REG_PC) == 0x100 and mu.reg_read(UC_ARM_REG_SP) == 0x600f0000 - 8
    return done, trace, e


def check_fn(new, ctl, lamp_set):
    for f in range(0x34):
        a, b = Emu(new).call(0x5339045c, (0x70000000, f)), Emu(ctl).call(0x5339045c, (0x70000000, f))
        check(a == (T_NAME if f == FN_LAMP else b), f'name of Fn function {f:#x}: {a} (control {b})')
        if f == FN_LAMP:
            # 0x26..0x29 share the name and the icon of Preview; only 0x26 is in a list and has a case
            check(b == Emu(ctl).call(0x5339045c, (0x70000000, 0x26)), f'control: the name of Fn function {f:#x}')
        for var in (0, 1, 2):
            a, b = Emu(new).call(0x53391d6c, (0x70000000, f, var)), Emu(ctl).call(0x53391d6c, (0x70000000, f, var))
            check(a == ((I_LAMP if var == 0 else 0) if f == FN_LAMP else b), f'icon of Fn function {f:#x} variant {var}: {a} (control {b})')
    la, lb = new.movw_movt(0x531dd10c, 0x531dd110), ctl.movw_movt(0x531dd10c, 0x531dd110)
    na, nb = new.u32(0x531dd120) & 0xff, ctl.u32(0x531dd120) & 0xff
    fa, fb = list(new.rd(la, na)), list(ctl.rd(lb, nb))
    check(fb == FN_LIST_OFFICIAL and lb == 0x53de6764 and fa == fb + [FN_LAMP], f'Fn function list {fa}')
    # the Movie button's two lists (pressed, held)
    for low, high, length, official_at, official_n in ((0x531dd190, 0x531dd194, 0x531dd1a4, 0x53de67fc, 35), (0x531dd214, 0x531dd218, 0x531dd228, 0x53de695c, 37)):
        ma, mb = list(new.rd(new.movw_movt(low, high), new.u32(length) & 0xff)), list(ctl.rd(ctl.movw_movt(low, high), ctl.u32(length) & 0xff))
        check(ctl.movw_movt(low, high) == official_at and len(mb) == official_n and ma == mb + [FN_LAMP], f'Movie button list {ma}')
    for model in (0, 1, 2):
        for fill, vec, least in ((0x531dd104, 0x1b4, 36), (0x531dd188, 0x1c0, 32), (0x531dd20c, 0x1cc, 34)):
            va, vb = fn_vector_model(new, model, fill, vec), fn_vector_model(ctl, model, fill, vec)
            check(va == vb + [FN_LAMP] and len(vb) >= least, f'model {model}: the list controller\'s vector +{vec:#x} {va} (control {vb})')
    print(f'  Fn: names / icons of 0..0x33, the lists of the four buttons ({len(fa)} functions) and of the Movie button, pressed and held ({FN_LAMP:#x} last in each), the vectors the camera builds from them for each model')
    # the switch
    toggles = 0
    for f in list(range(0x30)):
        for released in (0, 1):
            dn, tn, en = run_switch(new, f, released)
            dc, tc, ec = run_switch(ctl, f, released)
            if f == FN_LAMP:
                check(dn and 0x53916230 not in tn, f'switch, {f:#x} released {released}: {tn} {en.calls}')
                check(0x53916230 in tc, f'control switch, {f:#x}: no assertion {tc}')
                if released:
                    check(en.events == [] and en.u32(LAMP_WORD) == 0 and 'ours' not in tn[1:], f'switch, {f:#x} released: {en.events} {tn}')
                else:
                    check(en.events == ['on'] and en.u32(LAMP_WORD) == HANDLE, f'switch, {f:#x} pressed: {en.events}')
                    # after the lamp: what function 0 (none) does on a press
                    d0, t0, _ = run_switch(ctl, 0, 0)
                    check([t for t in tn if t != 'ours'] == t0, f'switch, {f:#x} pressed: then {tn} (function 0: {t0})')
                    toggles += 1
            else:
                check(dn == dc and [t for t in tn if t != 'ours'] == tc and en.events == [] and en.u32(LAMP_WORD) == 0, f'switch, function {f:#x} released {released}: {tn} (control {tc})')
    # a second press: off
    e = lamp_emu(new, HANDLE)
    toggle = bls(new, branch_target(new, 0x533999bc), 8)[0]
    e.call(toggle, ())
    check(e.u32(LAMP_WORD) == 0 and e.events == ['off'], f'toggle from on: {e.events}')
    e = lamp_emu(new, 0)
    e.call(toggle, ())
    check(e.u32(LAMP_WORD) == HANDLE and e.events == ['on'], f'toggle from off: {e.events}')
    check(branch_target(new, toggle + 24) == lamp_set, 'toggle goes through `set`')
    print(f'  the function switch: {FN_LAMP:#x} switches the lamp over on a press, nothing on release, no assertion; functions 0..0x2f otherwise as the control')


def fn_vector_model(img, model, fill=0x531dd104, vec=0x1b4):
    e = Emu(img, model)
    this = 0x70000000
    e.stubs[0x53242154] = lambda: 0x70200000
    e.stubs[0x53240cac] = lambda: 0x70200000
    e.stubs[0x53909190] = lambda: 0
    e.call(fill, (this,), limit=2_000_000)
    a, b = e.u32(this + vec), e.u32(this + vec + 4)
    return list(e.mu.mem_read(a, b - a))


def run_movie_switch(img, fn, event):
    """The Movie button's switch 0x53398320 (this, shared pointer, event) with `fn` as the button's function."""
    e = lamp_emu(img)
    sp_pair = 0x70300000
    e.mu.mem_write(sp_pair, struct.pack('<2I', 0x70300100, 0))
    trace = []
    lo, hi = 0x53398320, 0x53399990
    state = {'prev': 0}

    def hook(uc, addr, size, ud):
        prev, state['prev'] = state['prev'], addr
        if lo <= prev < hi and not (lo <= addr < hi) and addr != 0x100:
            if addr >= dm.BASE + dm.OFFICIAL_LEN:
                trace.append('ours')
                return
            trace.append(addr)
            # the button's function (pressed 0x5329F53C, held 0x5329F548); everything else returns 0
            uc.reg_write(UC_ARM_REG_R0, fn if addr in (0x5329f53c, 0x5329f548) else 0)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            state['prev'] = 0
    e.mu.hook_add(UC_HOOK_CODE, hook)
    mu = e.mu
    for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2), (0x70000000, sp_pair, event)):
        mu.reg_write(r, v)
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
    mu.reg_write(UC_ARM_REG_LR, 0x100)
    try:
        mu.emu_start(0x53398320, 0x100, count=200000)
    except UcError as ex:
        trace.append(f'error {ex}')
    done = mu.reg_read(UC_ARM_REG_PC) == 0x100 and mu.reg_read(UC_ARM_REG_SP) == 0x600f0000
    return done, trace, e


def check_movie_button(new, ctl):
    for f in range(0x30):
        for event in (2, 3, 4, 1, 5):
            dn, tn, en = run_movie_switch(new, f, event)
            dc, tc, ec = run_movie_switch(ctl, f, event)
            if f == FN_LAMP and event in (2, 3):
                check(dn and 0x53916230 not in tn and en.events == ['on'] and en.u32(LAMP_WORD) == HANDLE, f'Movie button, {f:#x} event {event}: {tn} {en.events}')
                check(0x53916230 in tc and dc, f'control Movie button, {f:#x} event {event}: {tc}')
                # the rest as function 0 (none)
                d0, t0, _ = run_movie_switch(ctl, 0, event)
                check([t for t in tn if t != 'ours'] == t0, f'Movie button, {f:#x} event {event}: {tn} (function 0: {t0})')
            elif f == FN_LAMP and event == 4:
                d0, t0, _ = run_movie_switch(ctl, 0, event)
                check(dn and tn == t0 and en.events == [] and en.u32(LAMP_WORD) == 0, f'Movie button, {f:#x} event 4: {tn}')
                check(0x53916230 in tc, f'control Movie button, {f:#x} event 4: {tc}')
            else:
                check(dn == dc and [t for t in tn if t != 'ours'] == tc and en.events == [] and en.u32(LAMP_WORD) == 0, f'Movie button, function {f:#x} event {event}: {tn} (control {tc})')
    print(f'  the Movie button\'s switch: {FN_LAMP:#x} switches the lamp over when pressed (event 2) and when held (3), nothing on event 4, no assertion; functions 0..0x2f otherwise as the control')


# ------------------------------------------------------------------------------------------------
# 7. Texts and the icon

def check_texts(new, ctl):
    roots = [new.u32(0x55002118 + 4 * l) for l in range(21)]
    first = 0x55000000 + (0x543b6a70 - 0x543b4900)
    for l in range(21):
        k = (roots[l] + 4 - first) // 0xdc4
        check(dm.text(new, l, T_NAME) == NAMES[k], f'text, row {l}: {dm.text(new, l, T_NAME)}')
        for t in (1, 2, 62, 884, 885, 926, 1018, 1019):
            try:
                same = dm.text(new, l, t) == dm.text(ctl, l, t)
            except Exception:
                same = True
            check(same, f'text {t} row {l}')
    print('  text', T_NAME, ':', dm.text(new, 2, T_NAME), '/', dm.text(new, 15, T_NAME), '/', dm.text(new, 0, T_NAME))
    for low in (0x5440ddc4, 0x5440dde4):
        w = new.u32(low)
        check((((w >> 4) & 0xf000) | (w & 0xfff)) >= I_LAMP, f'icon bound at {low:#x}')
    d = new.u32(dm.ICON_CATALOG + I_LAMP * 4)
    check(struct.unpack('<4H', new.rd(d, 8)) == (1, 40, 40, 0), 'icon')
    print('  icon', I_LAMP, '40x40')


def main():
    new, ctl = Image(sys.argv[1]), Image(sys.argv[2])
    print('1. still menu')
    draw = check_menus(new, ctl)
    print('2. the line')
    check_line(new, draw)
    print('4. the lamp')
    lamp_set = check_lamp(new, ctl)
    print('3. the list')
    check_list(new, ctl, lamp_set)
    print('5. ADJ')
    check_adj(new, ctl, lamp_set)
    print('6. Fn')
    check_fn(new, ctl, lamp_set)
    check_movie_button(new, ctl)
    print('7. text and icon')
    check_texts(new, ctl)
    if failures:
        print(f'{len(failures)} FAILURES')
        for f in failures[:60]:
            print('  ', f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
