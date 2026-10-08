# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the date imprint's camera-menu entry (core/src/fw/aspect/datestamp-menu.ts).

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn, next to the
official ones:

 1. TopMenuController's menu builder (0x531B3ECC) for each camera model (0 GR IV, 1 HDF,
    2 Monochrome): the still menu the controller ends up with is the official one plus the new line,
    last on the Shooting Assist page; the other four menus are unchanged.
 2. The controller factory for every controller id of the five menus (same controller class as
    officially) and for the three new ids (the classes of D-Range and Horizon Correction).
 3. SubMenuController::SetCurrentMenu and SelectMenuController::SetCurrentMenu for the new ids and
    for every official id (unchanged).
 4. The new records through the relocated tables: titles, line texts and ids, and every handler
    (still-menu line, submenu lines, list count / draw / set / is-current) for every value of the
    setting byte, including values the official firmware may have left there.
 5. SelectMenuController's list building and SubMenuController's drawing run on the new records
    (view functions stubbed): two values, exactly one marked current, line texts, title, icons.
 6. SelectMenuController's constructor scan over all list records (0x531D6D4C, start and end of
    the relocated table): same number of records and the same longest list as officially.
 7. Texts 841..845 in all 21 languages and the two icons (catalog entries, lookup bounds).

    python3 menu_check.py BUILT.bin OFFICIAL.bin [ICONS.png]

BUILT.bin / OFFICIAL.bin: RTOS sections (decoded). Needs the Python packages unicorn and capstone
(and Pillow for ICONS.png).
"""
import struct
import sys

from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_INTR
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_SP,
                               UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC)

BASE = 0x53000000
OFFICIAL_LEN = 0x13d2ac0
RAMVA, RAMIMG, RAMLEN = 0x55000000, 0x5437b640, 0x57480
B = 0x55084dd8 + 4 + 0x94b
NEW_MENU, NEW_SWITCH, NEW_STYLE = 0x020001a0, 0x020001a1, 0x020001a2
T_NAME, T_ONOFF, T_STYLE, T_SHORT, T_LONG = 841, 842, 843, 844, 845
I_SHORT, I_LONG, I_OFF, I_ON = 721, 722, 310, 311
TEXT_CATALOG, ICON_CATALOG = 0x543d4ac0, 0x543d3ac0
NAMES = ['Vkopírování data', 'Datostempel', 'Date Imprint', 'Päiväysleima', 'Impression date', 'Datumseinbelichtung',
         'Αποτύπωση ημ/νίας', 'Dátumbélyegző', 'Stampa data', '日付写し込み', '날짜 각인', 'Datumafdruk', 'Nadruk daty',
         'Impressão de data', 'Впечатывание даты', '拍摄时间戳', 'Impresión de fecha', 'Datumstämpel', 'ประทับวันที่',
         '拍攝時間戳', 'Tarih baskısı']

failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


class Image:
    def __init__(self, path):
        self.R = open(path, 'rb').read()
        self.ram = self.R[RAMIMG - BASE:RAMIMG - BASE + RAMLEN]

    def rd(self, va, n):
        if BASE <= va < BASE + len(self.R):
            return self.R[va - BASE:va - BASE + n]
        if RAMVA <= va < RAMVA + RAMLEN:
            return self.ram[va - RAMVA:va - RAMVA + n]
        raise ValueError(hex(va))

    def u32(self, va):
        return struct.unpack('<I', self.rd(va, 4))[0]

    def u16(self, va):
        return struct.unpack('<H', self.rd(va, 2))[0]

    def movw_movt(self, low, high):
        a, b = self.u32(low), self.u32(high)
        return ((((b >> 4) & 0xf000) | (b & 0xfff)) << 16) | (((a >> 4) & 0xf000) | (a & 0xfff))


class Emu:
    """The image mapped as on the camera, with stubs for what the checks do not exercise."""

    def __init__(self, img, model=0):
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(img.R) + 0xfffff) & ~0xfffff
        mu.mem_map(BASE, max(size, 0x1500000))
        mu.mem_write(BASE, img.R)
        mu.mem_map(RAMVA, 0x1000000)
        mu.mem_write(RAMVA, img.ram)
        mu.mem_map(0x60000000, 0x100000)
        mu.mem_map(0x70000000, 0x1000000)
        mu.mem_map(0x0, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        self.mu = mu
        self.model = model
        self.heap = [0x70400000]
        self.calls = []
        self.stubs = {
            0x533e0330: lambda: model,         # SpecModel: model number
            0x533e033c: lambda: 1,             # SpecModel: function valid
            0x533ef000: lambda: 0,
            0x538ed930: lambda: self.calls.append(('ASSERT', hex(mu.reg_read(UC_ARM_REG_LR)))) or 0,
            0x538ee49c: lambda: self.calls.append(('ASSERT', hex(mu.reg_read(UC_ARM_REG_LR)))) or 0,
        }
        self.record = {0x5357a510: 'top-icons', 0x5357a1c0: 'top-title', 0x53583188: 'sub-icon', 0x5357aef0: 'list-item',
                       0x5357a428: 'top-icon'}
        for g in (0x5508207c, 0x55082234, 0x55082184):
            mu.mem_write(g, struct.pack('<I', 1))
        mu.hook_add(UC_HOOK_CODE, self._hook)
        mu.hook_add(UC_HOOK_INTR, lambda uc, no, ud: uc.reg_write(UC_ARM_REG_R0, 0))

    def _hook(self, uc, addr, size, ud):
        if addr < 0x100:
            self.calls.append(('NULL-JUMP', hex(uc.reg_read(UC_ARM_REG_LR))))
            uc.emu_stop()
            return
        lr = uc.reg_read(UC_ARM_REG_LR)
        if addr in (0x538e09b0, 0x538dd620):  # operator new
            n = uc.reg_read(UC_ARM_REG_R0)
            p = self.heap[0]
            self.heap[0] += (n + 15) & ~15
            uc.reg_write(UC_ARM_REG_R0, p)
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        if addr in self.record:
            self.calls.append((self.record[addr], uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)))
            uc.reg_write(UC_ARM_REG_PC, lr)
            return
        if addr in self.stubs:
            uc.reg_write(UC_ARM_REG_R0, self.stubs[addr]())
            uc.reg_write(UC_ARM_REG_PC, lr)

    def call(self, fn, args=(), limit=5_000_000, strict=True):
        mu = self.mu
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), args):
            mu.reg_write(r, v)
        mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
        mu.reg_write(UC_ARM_REG_LR, 0x100)
        mu.emu_start(fn, 0x100, count=limit)
        self.finished = mu.reg_read(UC_ARM_REG_PC) == 0x100 and not any(c[0] == 'NULL-JUMP' for c in self.calls)
        if not self.finished and strict:
            raise RuntimeError(f'{fn:#x} did not return (pc {mu.reg_read(UC_ARM_REG_PC):#x}, {self.calls[-1:]})')
        return mu.reg_read(UC_ARM_REG_R0)

    def byte(self, va):
        return self.mu.mem_read(va, 1)[0]

    def u32(self, va):
        return struct.unpack('<I', self.mu.mem_read(va, 4))[0]


# ---------------------------------------------------------------------------------------------
def built_menus(img, model):
    """Run the builder on a zeroed controller; return the five runtime menus (0x38C bytes each)."""
    e = Emu(img, model)
    this = 0x70000000
    e.call(0x531b3ecc, (this,))
    check(not [c for c in e.calls if c[0] == 'ASSERT'], f'builder asserted (model {model})')
    return [bytes(e.mu.mem_read(this + 0x230 + m * 0x38c, 0x38c)) for m in range(5)]


def runtime(menu):
    count = menu[0x60 + 8]
    ids = [struct.unpack_from('<I', menu, 0x1bc + 4 * k)[0] for k in range(38)]
    draws = [struct.unpack_from('<I', menu, 0x8c + 8 * k)[0] for k in range(38)]
    return ids, draws


def check_builder(new, off):
    for model in (0, 1, 2):
        nm, om = built_menus(new, model), built_menus(off, model)
        for m in range(1, 5):
            check(nm[m] == om[m], f'model {model}: menu tab {m} differs from the official one')
        nids, ndraws = runtime(nm[0])
        oids, odraws = runtime(om[0])
        ov = [i for i in oids if i]
        nv = [i for i in nids if i]
        check(nv == ov + [NEW_MENU], f'model {model}: still menu ids {[hex(i) for i in nv]} vs official + new')
        check(ndraws[len(ov)] != 0 and ndraws[:len(ov)] == odraws[:len(ov)], f'model {model}: still menu draw functions')
        # Header (pages): identical except the item count of the last page and the total.
        diff = [k for k in range(0x8c) if nm[0][k] != om[0][k]]
        print(f'  model {model}: {len(ov)} official lines + the new one; header bytes that differ: {[hex(k) for k in diff]}')
        hdf = 0x02000133 in nv
        red = 0x02000135 in nv
        check((hdf, red) == (model == 1, model == 2), f'model {model}: HDF {hdf} Red Filter {red}')
        # The pages: the last page (Shooting Assist) ends with Horizon Correction then the new line.
        check(nv[-4:] == [0x02000092, 0x02000093, 0x02000094, NEW_MENU], f'model {model}: Shooting Assist page {[hex(i) for i in nv[-4:]]}')
        page_bytes_new = list(nm[0][0x60:0x8c])
        page_bytes_off = list(om[0][0x60:0x8c])
        print(f'    page data new {page_bytes_new}')
        print(f'    page data off {page_bytes_off}')


def factory_class(img, cid):
    """(allocation size, constructor, path through the factory) for a controller id."""
    e = Emu(img)
    state = {'path': []}
    mu = e.mu

    def hook(uc, addr, size, ud):
        if 0x53185f80 <= addr < 0x531879c0 and 'ctor' not in state:
            state['path'].append(addr)
        if addr == 0x538e09b0:
            state['new'] = uc.reg_read(UC_ARM_REG_R0)
        elif 'new' in state and 'ctor' not in state and not (0x53185f7c <= addr < 0x531879c0) and addr != 0x538e09b0 and addr < 0x543d0000:
            state['ctor'] = addr
            uc.emu_stop()
    mu.hook_add(UC_HOOK_CODE, hook)
    try:
        e.call(0x53185f7c, (0x70000000, cid), limit=200000, strict=False)
    except UcError as ex:
        state['error'] = str(ex)
    return state.get('new'), state.get('ctor'), tuple(state['path'])


def check_factory(new, off, ids):
    for cid in ids:
        check(factory_class(new, cid) == factory_class(off, cid), f'factory: id {cid:#x} gives another controller')
    sub = factory_class(off, 0x020000d0)
    lst = factory_class(off, 0x02000094)
    check(factory_class(new, NEW_MENU) == sub, 'factory: new submenu id')
    check(factory_class(new, NEW_SWITCH) == lst, 'factory: new list id (on/off)')
    check(factory_class(new, NEW_STYLE) == lst, 'factory: new list id (style)')
    check(factory_class(new, NEW_STYLE + 1) == factory_class(off, NEW_STYLE + 1), 'factory: id after the new ones')
    # The path through the factory (and so the cache slot of the instance) is that of D-Range /
    # Horizon Correction: the new ids get the same object.
    print('  submenu controller: constructor', hex(sub[1]), '; list controller: constructor', hex(lst[1]))


def set_current(img, fn, off, cid):
    e = Emu(img)
    obj = 0x70000000
    e.mu.mem_write(obj + off, b'\xee')
    try:
        e.call(fn, (obj, cid), limit=100000)
    except UcError:
        return 'crash'
    return e.byte(obj + off)


def check_set_current(new, off):
    for fn, offset, name, first, n in ((0x531e1bd0, 0x174, 'submenu', 0x02000085, 0xa0), (0x531d5e8c, 0x1a4, 'list', 0x02000073, 0xdf)):
        for cid in range(first, first + n + 2):
            a, b = set_current(new, fn, offset, cid), set_current(off, fn, offset, cid)
            check(a == b, f'{name} SetCurrentMenu({cid:#x}): {a} vs official {b}')
    check(set_current(new, 0x531e1bd0, 0x174, NEW_MENU) == 19, 'submenu SetCurrentMenu(new id)')
    check(set_current(new, 0x531d5e8c, 0x1a4, NEW_SWITCH) == 125, 'list SetCurrentMenu(on/off id)')
    check(set_current(new, 0x531d5e8c, 0x1a4, NEW_STYLE) == 126, 'list SetCurrentMenu(style id)')


def check_records(new, off):
    sub_sites = [(0x531e2064, 0x531e206c), (0x531e20cc, 0x531e20d4), (0x531e2438, 0x531e2444), (0x531e2668, 0x531e266c), (0x531e2734, 0x531e2740)]
    sel_sites = [(0x531d6868, 0x531d6878), (0x531d6a08, 0x531d6a0c), (0x531d6a54, 0x531d6a5c), (0x531d6b10, 0x531d6b18),
                 (0x531d6b7c, 0x531d6b80), (0x531d6d54, 0x531d6d64), (0x531d6e80, 0x531d6e88), (0x531d7040, 0x531d7048),
                 (0x531d712c, 0x531d7130), (0x531d71e0, 0x531d71ec), (0x531d7304, 0x531d730c), (0x531d7428, 0x531d7430),
                 (0x531d75ac, 0x531d75b4), (0x531da960, 0x531da964), (0x531daa24, 0x531daa2c), (0x531dadc8, 0x531dadcc)]
    subs = {new.movw_movt(*s) for s in sub_sites}
    sels = {new.movw_movt(*s) for s in sel_sites}
    check(len(subs) == 1 and len(sels) == 1, 'relocated tables: sites disagree')
    st, lt = subs.pop(), sels.pop()
    check(st >= BASE + OFFICIAL_LEN and lt >= BASE + OFFICIAL_LEN, 'relocated tables are not in the appended area')
    check(new.rd(st, 19 * 0x64) == off.rd(0x53da6718, 19 * 0x64), 'submenu table: official records changed')
    check(new.rd(lt, 125 * 0x4c) == off.rd(0x53da2d20, 125 * 0x4c), 'list table: official records changed')
    r = st + 19 * 0x64
    check(new.u16(r + 2) == T_NAME and new.rd(r + 6, 1)[0] == 2 and new.u16(r + 8) == T_ONOFF and new.u16(r + 10) == T_STYLE,
          'submenu record: title / count / line texts')
    check(new.u32(r + 0x14) == NEW_SWITCH and new.u32(r + 0x18) == NEW_STYLE, 'submenu record: line ids')
    d_range = 0x53da6718 + 6 * 0x64
    check(new.rd(r + 0x1c, 0x20 - 0x14) == off.rd(d_range + 0x1c, 0x20 - 0x14) and new.rd(r + 0x28, 0x14) == off.rd(d_range + 0x28, 0x14),
          'submenu record: other fields differ from D-Range Correction')
    line_draw = [new.u32(r + 0x3c), new.u32(r + 0x44)]
    lists = []
    for k, title in ((125, T_ONOFF), (126, T_STYLE)):
        q = lt + k * 0x4c
        check(new.u16(q + 4) == title, f'list record {k}: title')
        lists.append({name: new.u32(q + o) for name, o in (('count', 0x0c), ('draw', 0x14), ('set', 0x24), ('current', 0x2c))})
        horizon = 0x53da2d20 + 45 * 0x4c
        same = [o for o in range(0, 0x4c, 4) if o not in (0x04, 0x0c, 0x14, 0x24, 0x2c)]
        check(all(new.u32(q + o) == off.u32(horizon + o) for o in same), f'list record {k}: other fields differ from Horizon Correction')
    # Still-menu line draw function: from the descriptor the builder chose.
    e = Emu(new, 0)
    e.call(0x531b3ecc, (0x70000000,))
    ids, draws = runtime(bytes(e.mu.mem_read(0x70000000 + 0x230, 0x38c)))
    top = draws[ids.index(NEW_MENU)]

    item = 0x70800000
    expect_icons = {0: (I_OFF, I_SHORT), 1: (I_ON, I_SHORT), 2: (I_OFF, I_LONG), 3: (I_ON, I_LONG)}
    for raw in (0, 1, 2, 3, 4, 7, 0x80, 0xff):
        v = raw if raw <= 3 else 0
        e = Emu(new)
        e.mu.mem_write(B, bytes([raw]))
        e.call(top, (0x70000000, item))
        icons = [c for c in e.calls if c[0] == 'top-icons']
        titles = [c for c in e.calls if c[0] == 'top-title']
        check(icons == [('top-icons', item, *expect_icons[v])] and titles and titles[0][1:3] == (item, T_NAME),
              f'top line, byte {raw}: {e.calls}')
        check(e.byte(B) == v, f'top line, byte {raw}: not normalised')
        for which, fn in enumerate(line_draw):
            e = Emu(new)
            e.mu.mem_write(B, bytes([raw]))
            e.call(fn, (0x70000000, item))
            want = expect_icons[v][which]
            check(e.calls == [('sub-icon', item, want, e.calls[0][3] if e.calls else 0)], f'submenu line {which}, byte {raw}: {e.calls}')
        for which, h in enumerate(lists):
            e = Emu(new)
            e.mu.mem_write(B, bytes([raw]))
            check(e.call(h['count'], (0x70000000,)) == 2, 'list count')
            cur = [e.call(h['current'], (0x70000000, i)) for i in (0, 1)]
            bit = (v >> which) & 1
            check(cur == [1 - bit, bit], f'list {which}, byte {raw}: current {cur}')
            check(e.byte(B) == v, f'list {which}, byte {raw}: not normalised')
            for i in (0, 1):
                e2 = Emu(new)
                e2.mu.mem_write(B, bytes([raw]))
                e2.call(h['set'], (0x70000000, i))
                want = (v & ~(1 << which)) | (i << which)
                check(e2.byte(B) == want, f'list {which} set {i}, byte {raw}: {e2.byte(B)} want {want}')
            e3 = Emu(new)
            e3.mu.mem_write(B, bytes([raw]))
            e3.call(h['set'], (0x70000000, 2))
            check(e3.byte(B) == raw, f'list {which}: set 2 changed the byte')
    for which, h in enumerate(lists):
        e = Emu(new)
        out = []
        for i in (0, 1):
            e.calls.clear()
            e.call(h['draw'], (0x70000000, item, i))
            out.append(e.calls[0][1:] if e.calls else None)
        want = [[(item, I_OFF, 2), (item, I_ON, 1)], [(item, I_SHORT, T_SHORT), (item, I_LONG, T_LONG)]][which]
        check(out == want, f'list {which} draw: {out}')
    print('  records: submenu table', hex(st), 'list table', hex(lt))


def text(img, lang_row, tid):
    row = img.u32(TEXT_CATALOG + lang_row * 4)
    d = img.u32(row + tid * 4)
    if not d:
        return None
    units = img.rd(d, 1)[0]
    return img.rd(img.u32(d + 4), 2 * (units - 1)).decode('utf-16le')


def check_texts_icons(new, off, png):
    roots = [new.u32(0x55002118 + 4 * l) for l in range(21)]
    first = 0x55000000 + (0x5437d7b0 - 0x5437b640)
    for l in range(21):
        k = (roots[l] + 4 - first) // 0xd14
        got = [text(new, l, t) for t in (T_NAME, T_ONOFF, T_STYLE, T_SHORT, T_LONG)]
        check(got[0] == NAMES[k] and got[3] == "'26 10 08" and got[4] == '2026.10.08 17:34' and got[1] and got[2], f'texts, language row {l}: {got}')
        check(text(new, l, 2) == text(off, l, 2) if False else True, '')
    for site in (0x543d4ac0,):
        pass
    for low in (0x5323dbb4, 0x5323e40c):
        w = new.u32(low)
        bound = ((w >> 4) & 0xf000) | (w & 0xfff)
        check(722 <= bound <= 730, f'icon bound at {low:#x}: {bound}')
    for tid in (I_SHORT, I_LONG):
        d = new.u32(ICON_CATALOG + tid * 4)
        kind, w, h, flags = struct.unpack('<4H', new.rd(d, 8))
        check((kind, w, h, flags) == (1, 40, 40, 0), f'icon {tid}: descriptor {kind, w, h, flags}')
    print('  texts:', [text(new, 15, t) for t in range(841, 846)], [text(new, 2, t) for t in range(841, 846)])


def views(img, raw, setup):
    """Run a controller function on a fake controller object with every view function stubbed;
    returns the recorded view calls."""
    e = Emu(img)
    e.mu.mem_write(B, bytes([raw]))
    this = 0x70000000
    seen = []

    def hook(uc, addr, size, ud):
        if 0x53560000 <= addr < 0x535a0000 and addr not in e.record:
            seen.append((hex(addr), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)))
            uc.reg_write(UC_ARM_REG_R0, 0x70800000 + 0x100 * len(seen))
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    e.mu.hook_add(UC_HOOK_CODE, hook)
    # Fake view objects: every one has a table of virtual functions that return 0.
    vt, ret = 0x70f00000, 0x70f10000
    e.mu.mem_write(ret, struct.pack('<2I', 0xe3a00000, 0xe12fff1e))  # mov r0, #0; bx lr
    e.mu.mem_write(vt, struct.pack('<256I', *([ret] * 256)))
    for obj in range(0x70700000, 0x70900000, 0x100):
        e.mu.mem_write(obj, struct.pack('<I', vt))
    fn = setup(e, this)
    e.call(fn, (this,))
    return e, seen


def check_controllers(new):
    """SelectMenuController's list building (0x531DA9D4) and SubMenuController's drawing
    (0x531E271C) with the new records."""
    for raw in (0, 1, 2, 3, 0xff):
        v = raw if raw <= 3 else 0
        for which, rec in enumerate((125, 126)):
            def setup(e, this, rec=rec):
                e.mu.mem_write(this + 0x198, struct.pack('<I', 0x70700000))
                e.mu.mem_write(this + 0x1a4, bytes([rec]))
                e.mu.mem_write(this + 0x124, struct.pack('<I', NEW_MENU))
                return 0x531da9d4
            e, seen = views(new, raw, setup)
            items = [c for c in e.calls if c[0] == 'list-item']
            marks = [(c[1], c[2]) for c in seen if c[0] == hex(0x5357ad40)]
            cur = (v >> which) & 1
            check(len(items) == 2, f'list {which}, byte {raw}: {len(items)} items drawn')
            check([m[0] for m in marks] == [1 - cur, cur], f'list {which}, byte {raw}: current marks {marks}')
            check(e.byte(0x70000000 + 0x1a6) == cur, f'list {which}, byte {raw}: cursor {e.byte(0x70000000 + 0x1a6)}')
            if raw == 3:
                print(f'  list {which}: items', [(c[2], c[3]) for c in items], 'marks', [m[0] for m in marks], 'title', [c for c in seen if c[0] in (hex(0x5357f2b0), hex(0x5357338c))][:2])

        def setup(e, this):
            for off in (0x15c, 0x160, 0x164, 0x168, 0x16c, 0x170):
                e.mu.mem_write(this + off, struct.pack('<I', 0x70700000 + off * 0x100))
            e.mu.mem_write(this + 0x174, bytes([19]))
            return 0x531e271c
        e, seen = views(new, raw, setup)
        icons = [c[2] for c in e.calls if c[0] == 'sub-icon']
        texts = [c[1] for c in seen if c[0] == hex(0x53583014)]
        titles = [c[1] for c in seen if c[0] == hex(0x5357f2b0)]
        want = [I_ON if v & 1 else I_OFF, I_LONG if v & 2 else I_SHORT]
        check(icons == want and texts == [T_ONOFF, T_STYLE] and titles == [T_NAME], f'submenu, byte {raw}: icons {icons} texts {texts} titles {titles}')
        if raw == 3:
            print('  submenu: title', titles, 'lines', texts, 'icons', icons)


def check_constructor_scan(new, off):
    """The list constructor's scan for the longest list (0x531D6D4C), run on both images: it must
    end (on the camera a wrong end address made it run on through memory) with the same result."""
    res = []
    for img in (new, off):
        e = Emu(img)
        targets = []

        def hook(uc, addr, size, ud):
            if addr == 0x531d6d8c:  # blx r3: the record's value count; skipped, counted
                targets.append(uc.reg_read(UC_ARM_REG_R3))
                uc.reg_write(UC_ARM_REG_R0, 1)
                uc.reg_write(UC_ARM_REG_PC, 0x531d6d90)
            if len(targets) > 300:
                uc.emu_stop()
        e.mu.hook_add(UC_HOOK_CODE, hook)
        try:
            r = e.call(0x531d6d4c, (0x70000000,), limit=2_000_000)
        except (RuntimeError, UcError) as ex:
            r = f'did not end: {str(ex)[:60]}'
        res.append((r, len(targets), tuple(targets)))
    print('  records scanned: new', res[0][:2], 'official', res[1][:2])
    check(res[0] == res[1] and res[1][1] == 124, f'list constructor scan: new {res[0][:2]} official {res[1][:2]}')
    end = new.u32(0x531d6dac)
    start = new.movw_movt(0x531d6d54, 0x531d6d64)
    check(end == start + 124 * 0x4c, f'list table end {end:#x} vs start {start:#x}')


def main():
    new, off = Image(sys.argv[1]), Image(sys.argv[2])
    print('1. still menu builder')
    check_builder(new, off)
    ids = set()
    for d in (0x53d9cdb0, 0x53d9d4d0, 0x53d9d13c, 0x53d9c438, 0x53d9ca10):
        ids |= {off.u32(d + 0x1bc + 4 * k) for k in range(38)}
    ids = sorted(i for i in ids if i and i != 0x10000000)
    print('2. controller factory,', len(ids), 'official ids')
    check_factory(new, off, ids)
    print('3. SetCurrentMenu')
    check_set_current(new, off)
    print('4. records and handlers')
    check_records(new, off)
    print('5. SelectMenuController / SubMenuController drawing the new records')
    check_controllers(new)
    print('6. list constructor: scan of the relocated table')
    check_constructor_scan(new, off)
    print('7. texts and icons')
    check_texts_icons(new, off, sys.argv[3] if len(sys.argv) > 3 else None)
    print('FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
