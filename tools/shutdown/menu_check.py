# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the power-off pictures' camera menu (core/src/fw/aspect/shutdown.ts).

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn (firmware
services the code reaches are fakes; everything GR Mod wrote and the native code between runs as
built), next to the official image where that is the reference:

 1. The power-off picture request: the factory picture of each model without a record, the chosen
    picture with one, the factory picture for a record of a picture no longer listed or a foreign one.
 2. TopMenuController's builder: Setup is the official menu but for item 10 (End Screen), which
    opens the submenu id and is drawn as Setup's other submenu lines (no value, title 701); the
    other menus are those of the date imprint's checks (unchanged here).
 3. The controller factory: every official id as officially (End Screen 0x020000C4 included), the
    submenu id as every submenu, the picture id makes one End Screen object (0x16C, its constructor,
    kept before it runs) and hands out the same one afterwards; the date imprint's ids still work.
 4. SubMenuController::SetCurrentMenu: official ids as officially, the date imprint's and the new
    id to their records; the new record (title, lines, ids), the official records unchanged; the
    submenu drawn by SubMenuController (0x531E271C) from it; its two line value functions.
 5. The End Screen class, both instances: the camera's own (any other object) runs the official
    code (each patched entry reaches the official instruction after it with the same registers);
    the picture list builds 1 + n rows of type 0x15 and gets the "Picture" title; refresh (texts,
    one tick, cursor), confirm (the record), up / down at both ends, footer thumbnails.
 6. Settings store APData bound, settings save, start-up zero fill, texts and thumbnails.

    python3 menu_check.py BUILT.RTOS BUILT.ICONBIN OFFICIAL.RTOS N [datestamp]

N: number of pictures. `datestamp`: the build also has the date imprint's menu entry.
Needs the Python packages unicorn and capstone.
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'datestamp'))
import menu_check as dm  # noqa: E402
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE  # noqa: E402
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4,  # noqa: E402
                               UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_SB,
                               UC_ARM_REG_SL, UC_ARM_REG_FP, UC_ARM_REG_IP, UC_ARM_REG_SP, UC_ARM_REG_LR,
                               UC_ARM_REG_PC)

BASE = 0x53000000
RAMVA, RAMIMG, RAMLEN = 0x55000000, 0x5437b640, 0x57480
RET = 0x100
FAKE = 0x60200000
MODE = 0x558372f0
MENU_ID, PICTURE_ID, END_SCREEN = 0x020001a3, 0x020001a4, 0x020000c4
T_TYPE, T_PICTURE, T_FACTORY = 853, 854, 855
TITLE = 701
TYPE_NAMES = ['タイプ', 'Type', 'Type', 'Typ', 'Tipo', 'Tipo', 'Tipo', 'Type', 'Type', 'Typ', 'Tyyppi',
              'Typ', 'Typ', 'Típus', 'Tip', 'Τύπος', 'Тип', '유형', '類型', '类型', 'แบบ']
PICTURE_NAMES = ['画像', 'Picture', 'Image', 'Bild', 'Imagen', 'Imagem', 'Immagine', 'Afbeelding', 'Billede', 'Bild', 'Kuva',
                 'Obraz', 'Obrázek', 'Kép', 'Resim', 'Εικόνα', 'Изображение', '이미지', '圖片', '图片', 'ภาพ']
HANDLERS = {'refresh': (0x532240e4, 1), 'confirm': (0x53223fa4, 1), 'up': (0x53223f14, 2), 'down': (0x53223f58, 2), 'footer': (0x5322419c, 1)}

R = open(sys.argv[1], 'rb').read()
ICON = open(sys.argv[2], 'rb').read()
OFF_PATH = sys.argv[3]
N = int(sys.argv[4])
DATESTAMP = len(sys.argv) > 5 and sys.argv[5] == 'datestamp'
OK = []


def check(cond, what):
    OK.append((bool(cond), what))
    print(('PASS ' if cond else 'FAIL ') + what)
    return cond


def make():
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, max((len(R) + 0xfffff) & ~0xfffff, 0x1500000))
    mu.mem_write(BASE, R)
    mu.mem_map(RAMVA, 0x1000000)
    mu.mem_write(RAMVA, R[RAMIMG - BASE:RAMIMG - BASE + RAMLEN])
    mu.mem_map(0x60000000, 0x400000)
    mu.mem_map(0, 0x1000)
    return mu


def u32(mu, a): return struct.unpack('<I', mu.mem_read(a, 4))[0]
def w32(mu, a, v): mu.mem_write(a, struct.pack('<I', v & 0xffffffff))


class World:
    """Fakes for the firmware services; `log` records calls."""
    def __init__(self, mu, variant=0, edition=2, selected=0, record=None, picture=True):
        self.mu, self.log, self.store = mu, [], {}
        if record is not None: self.store[74] = record
        self.variant, self.edition, self.selected = variant, edition, selected
        self.app, self.userdata, self.display, self.storage, self.ap = FAKE, FAKE + 0x100, FAKE + 0x200, FAKE + 0x300, FAKE + 0x400
        self.controller, self.widget, self.graphic, self.variant_root = FAKE + 0x1000, FAKE + 0x2000, FAKE + 0x3000, FAKE + 0x4000
        w32(mu, self.storage + 8, self.ap)
        w32(mu, self.controller + 0x168, self.widget)
        w32(mu, self.controller + 0x164, self.graphic)
        w32(mu, MODE, 1 if picture else 0)
        a, b, c = FAKE + 0x5000, FAKE + 0x5100, FAKE + 0x5200
        w32(mu, self.variant_root + 8, a); w32(mu, a + 0xc, b); w32(mu, b + 0x20, c); w32(mu, c + 0x48, variant)
        self.fns = {
            0x5323ea84: lambda r: self.app,
            0x5323f018: lambda r: self.userdata,
            0x5323ed78: lambda r: self.display,
            0x5323ff28: lambda r: FAKE + 0x600,
            0x5323f378: lambda r: FAKE + 0x6000,
            0x533e0324: lambda r: self.edition,
            0x5372b620: lambda r: self.variant_root,
            0x53a81480: lambda r: self.storage,
            0x53a7e2b8: lambda r: 1 if r[1] in self.store else 0,
            0x53a7e208: lambda r: len(self.store.get(r[1], b'')),
            0x53a7e434: self.read,
            0x53a7e518: self.write,
            0x53570b6c: lambda r: self.selected,
            0x53570a9c: lambda r: 0x7000 + r[1],
            0x5357ad40: lambda r: self.rec('check', r[0] - 0x7000, r[1]),
            0x5357ade0: lambda r: self.rec('text', r[0] - 0x7000, r[1]),
            0x53571788: lambda r: self.rec('focus', r[1]),
            0x535715b8: lambda r: self.rec('move', r[1] - (1 << 32) if r[1] >> 31 else r[1], r[2]),
            0x53576e38: lambda r: self.rec('icon', r[1]),
            0x53589ab4: lambda r: self.rec('visible', r[1]),
            0x5357094c: lambda r: self.rec('list_init', r[1], r[2], bytes(mu.mem_read(r[1], r[2]))),
            0x5357f2b0: lambda r: self.rec('title', r[0], r[1]),
            0x535711e4: lambda r: self.rec('shown', r[0], r[1]),
            0x535831e8: lambda r: self.rec('line_text', r[0], r[1]),
            0x5357a428: lambda r: self.rec('top_icon', r[0], r[1]),
            0x5357a1c0: lambda r: self.rec('top_title', r[0], r[1]),
            0x538e09b0: lambda r: FAKE + 0x8000,
            0x53570e84: lambda r: 0,
        }
        mu.hook_add(UC_HOOK_CODE, self.hook)

    def rec(self, *x):
        self.log.append(x)
        return 0

    def read(self, r):
        data = self.store.get(r[1])
        if data is None or len(data) != r[2]: return 0
        self.mu.mem_write(r[3], data)
        return 1

    def write(self, r):
        self.store[r[1]] = bytes(self.mu.mem_read(r[3], r[2]))
        self.log.append(('write', r[1], self.store[r[1]]))
        return 1

    def hook(self, uc, address, size, _):
        if address in self.fns:
            regs = [uc.reg_read(x) for x in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)]
            v = self.fns[address](regs)
            uc.reg_write(UC_ARM_REG_R0, (v or 0) & 0xffffffff)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))


def call(mu, fn, args=(), stop=RET):
    for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), args): mu.reg_write(r, v)
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
    mu.reg_write(UC_ARM_REG_LR, RET)
    mu.emu_start(fn, stop, count=2_000_000)
    return mu.reg_read(UC_ARM_REG_R0)


def cstr(mu, a):
    b = bytes(mu.mem_read(a, 64))
    return b.split(b'\0')[0].decode('latin1')


def text(mu, row, tid):
    d = u32(mu, u32(mu, 0x543d4ac0 + 4 * row) + 4 * tid)
    if not d: return None
    units = mu.mem_read(d, 1)[0]
    return bytes(mu.mem_read(u32(mu, d + 4), 2 * (units - 1))).decode('utf-16-le')


REC = lambda choice: struct.pack('<II', 0x4f44534d, choice)
mv = lambda x: ((x >> 4) & 0xf000) | (x & 0xfff)


def _ids():
    mu = make()
    w = u32(mu, 0x531b9488); stub = 0x531b9488 + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4
    ctx = mv(u32(mu, stub)) | (mv(u32(mu, stub + 4)) << 16)
    return [u32(mu, ctx + 24 + 8 + 16 + 4 * k) for k in range(N)]


IDS = _ids()
print('ids', [hex(i) for i in IDS])

# --- 1. power-off picture request.
print('1. power-off picture')


def picture(variant, edition, record):
    mu = make(); w = World(mu, variant=variant, edition=edition, record=record)
    seen = {}

    def at_request(uc, address, size, _):
        d = uc.reg_read(UC_ARM_REG_R3)
        seen['id'] = uc.reg_read(UC_ARM_REG_SB)
        seen['wh'] = (uc.reg_read(UC_ARM_REG_R8), uc.reg_read(UC_ARM_REG_R7))
        seen['path'] = cstr(uc, u32(uc, d + 4))
        uc.emu_stop()
    mu.hook_add(UC_HOOK_CODE, at_request, begin=0x53262598, end=0x53262598)
    call(mu, 0x531b9488, (w.controller,))
    return seen


for variant, edition, want in ((0, 0, 'GoodBye'), (0, 1, 'GB_Mono'), (0, 2, 'GB_HDF'), (5, 0, 'GB_20th')):
    s = picture(variant, edition, None)
    check(want in s.get('path', ''), f'no record, variant {variant} edition {edition}: factory {s.get("path")}')
s = picture(0, 2, REC(IDS[-1]))
check(s.get('path', '').endswith(f'GRMOD{N}.jpg') and s['id'] == 11 + N and s['wh'] == (720, 480), f'record = last picture: {s}')
s = picture(0, 2, REC(0xdead))
check('GB_HDF' in s.get('path', ''), f'record of a picture no longer listed: factory {s.get("path")}')
s = picture(0, 2, struct.pack('<II', 0x32424753, 1))
check('GB_HDF' in s.get('path', ''), f'foreign record: factory {s.get("path")}')

# --- 2. the menus as built.
print('2. menus')
new, off = dm.Image(sys.argv[1]), dm.Image(OFF_PATH)
for model in (0, 1, 2):
    nm, om = dm.built_menus(new, model), dm.built_menus(off, model)
    for m in (1, 2, 3):
        check(nm[m] == om[m], f'model {model}: menu tab {m} as officially')
    if not DATESTAMP:
        check(nm[0] == om[0], f'model {model}: still menu as officially')
    diff = [k for k in range(0x38c) if nm[4][k] != om[4][k]]
    draw, ident = 0x8c + 10 * 8, 0x1bc + 10 * 4
    check(all(draw <= k < draw + 4 or ident <= k < ident + 4 for k in diff), f'model {model}: Setup differs only in item 10 ({[hex(k) for k in diff]})')
    ids, draws = dm.runtime(nm[4])
    check(ids[10] == MENU_ID, f'model {model}: Setup item 10 opens {ids[10]:#x}')
    setup_line = draws[10]
mu = make(); w = World(mu)
call(mu, setup_line, (FAKE + 0x900, 0x7777))
check(w.log == [('top_icon', 0x7777, 0), ('top_title', 0x7777, TITLE)], f'Setup line: {w.log}')

# --- 3. the controller factory.
print('3. controller factory')
ids = set()
for d in (0x53d9cdb0, 0x53d9d4d0, 0x53d9d13c, 0x53d9c438, 0x53d9ca10):
    ids |= {off.u32(d + 0x1bc + 4 * k) for k in range(38)}
ids = sorted(i for i in ids if i and i != 0x10000000)
bad = [hex(c) for c in ids if dm.factory_class(new, c) != dm.factory_class(off, c)]
check(not bad, f'{len(ids)} official ids as officially (End Screen included); differing: {bad}')
check(dm.factory_class(new, MENU_ID) == dm.factory_class(off, 0x020000d0), 'submenu id: the submenu controller')
if DATESTAMP:
    check(dm.factory_class(new, 0x020001a0) == dm.factory_class(off, 0x020000d0), 'date imprint submenu id')
    check(dm.factory_class(new, 0x020001a1) == dm.factory_class(off, 0x02000094), 'date imprint list id')
check(dm.factory_class(new, PICTURE_ID + 1) == dm.factory_class(off, PICTURE_ID + 1), 'id after the new ones as officially')


# The picture id: the End Screen list's own object (the official path for 0x020000C4), in picture mode.
check(dm.factory_class(new, PICTURE_ID) == dm.factory_class(off, END_SCREEN), 'picture id: the End Screen list object, as officially for 0x020000C4')


def mode_after(cid, before, cached=0x7abc0000):
    e = dm.Emu(new)
    e.mu.mem_write(0x70000000 + 0x180, struct.pack('<I', cached))
    e.mu.mem_write(MODE, struct.pack('<I', before))
    # Other ids construct their (uncached) controllers, which need more than this emulation has:
    # only the mode is checked for them.
    end = cid in (PICTURE_ID, END_SCREEN)
    r = e.call(0x53185f7c, (0x70000000, cid), limit=200000, strict=end)
    return r, e.u32(MODE), e.mu.reg_read(UC_ARM_REG_SP) if end else 0x600f0000


for cid, before, want in ((PICTURE_ID, 0, 1), (PICTURE_ID, 1, 1), (END_SCREEN, 1, 0), (END_SCREEN, 0, 0), (MENU_ID, 1, 1), (MENU_ID, 0, 0), (0x020000c3, 1, 1)):
    r, mode, sp = mode_after(cid, before)
    obj_ok = r == 0x7abc0000 if cid in (PICTURE_ID, END_SCREEN) else True
    check(mode == want and obj_ok and sp == 0x600f0000, f'factory({cid:#x}) with mode {before}: mode {mode}, object {r:#x}')



def key_map(img, fn, cid):
    """Run a key-mapper function (0x53255A0C has-own-map, 0x532544A4 pick-map) with `cid` as the
    current controller id; returns its result and the last instruction it ran (the map chosen)."""
    e = dm.Emu(img)
    e.stubs[0x5325ca14] = lambda: cid
    e.stubs[0x5323ebf8] = lambda: 0x70100000
    last = []
    e.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, u: last.append(a) if fn <= a < fn + 0x2000 else None)
    r = e.call(fn, (0x70200000, 5), limit=20000, strict=False)
    return r, last[-1] if last else None


for fn in (0x53255a0c, 0x532544a4):
    a, b = key_map(new, fn, PICTURE_ID), key_map(off, fn, END_SCREEN)
    check(a == b, f'key map {fn:#x}: the picture list as the End Screen list ({a} vs {b})')
    for cid in (END_SCREEN, MENU_ID, 0x020000c3, 0x020000d0):
        check(key_map(new, fn, cid) == key_map(off, fn, cid), f'key map {fn:#x}: {cid:#x} as officially')

# --- 4. the submenu.
print('4. submenu')
sub_sites = [(0x531e2064, 0x531e206c), (0x531e20cc, 0x531e20d4), (0x531e2438, 0x531e2444), (0x531e2668, 0x531e266c), (0x531e2734, 0x531e2740)]
tables = {new.movw_movt(*s) for s in sub_sites}
check(len(tables) == 1, 'submenu table sites agree')
st = tables.pop()
number = 20 if DATESTAMP else 19
check(new.rd(st, 19 * 0x64) == off.rd(0x53da6718, 19 * 0x64), 'submenu table: official records (and what followed them) as before')
if DATESTAMP:
    check(new.u16(st + 19 * 0x64 + 2) == 841, 'submenu table: the date imprint record kept')
bad = []
for cid in range(0x02000085, 0x02000085 + 0xa2):
    if dm.set_current(new, 0x531e1bd0, 0x174, cid) != dm.set_current(off, 0x531e1bd0, 0x174, cid): bad.append(hex(cid))
check(not bad, f'SetCurrentMenu: official ids as officially ({bad})')
check(dm.set_current(new, 0x531e1bd0, 0x174, MENU_ID) == number, f'SetCurrentMenu(submenu id) = record {number}')
if DATESTAMP:
    check(dm.set_current(new, 0x531e1bd0, 0x174, 0x020001a0) == 19, 'SetCurrentMenu(date imprint id) = record 19')
check(dm.set_current(new, 0x531e1bd0, 0x174, PICTURE_ID) == dm.set_current(off, 0x531e1bd0, 0x174, PICTURE_ID), 'SetCurrentMenu(picture id) as officially')
rec = st + number * 0x64
reset = 0x53da6718 + 17 * 0x64
check(new.u16(rec + 2) == TITLE and new.rd(rec + 6, 1)[0] == 2 and new.u16(rec + 8) == T_TYPE and new.u16(rec + 10) == T_PICTURE, 'record: title, lines, line texts')
check(new.u32(rec + 0x14) == END_SCREEN and new.u32(rec + 0x18) == PICTURE_ID, 'record: line ids')
same = [o for o in range(0, 0x64) if not (2 <= o < 4 or 8 <= o < 12 or 0x14 <= o < 0x1c or 0x3c <= o < 0x4c)]
check(all(new.rd(rec + o, 1) == off.rd(reset + o, 1) for o in same), 'record: other fields as Reset\'s')
line_type, line_picture = new.u32(rec + 0x3c), new.u32(rec + 0x44)
for byte, want in ((0, 6), (1, 7)):
    mu = make(); w = World(mu)
    mu.mem_write(w.userdata + 0x988, bytes([byte]))
    call(mu, line_type, (FAKE + 0x900, 0x7777))
    check(w.log == [('line_text', 0x7777, want)], f'Type line, setting {byte}: {w.log}')
for record, want in [(None, T_FACTORY), (REC(0xdead), T_FACTORY)] + [(REC(IDS[k]), T_FACTORY + 1 + k) for k in range(N)]:
    mu = make(); w = World(mu, record=record)
    call(mu, line_picture, (FAKE + 0x900, 0x7777))
    check(w.log == [('line_text', 0x7777, want)], f'Picture line, record {record and record.hex()}: {w.log}')


def setup(e, this):
    for o in (0x15c, 0x160, 0x164, 0x168, 0x16c, 0x170):
        e.mu.mem_write(this + o, struct.pack('<I', 0x70700000 + o * 0x100))
    e.mu.mem_write(this + 0x174, bytes([number]))
    return 0x531e271c


e, seen = dm.views(new, 0, setup)
texts = [c[1] for c in seen if c[0] == hex(0x53583014)]
titles = [c[1] for c in seen if c[0] == hex(0x5357f2b0)]
values = [c[1] for c in seen if c[0] == hex(0x535831e8)]
check(texts == [T_TYPE, T_PICTURE] and titles == [TITLE], f'SubMenuController draws the record: title {titles} lines {texts} values {values}')

# --- 5. the End Screen class.
print('5. End Screen list, both modes')


def native_reaches(at, regs, expect):
    """Run a patched entry in the camera's mode; it must reach the official instruction after the
    patched one with the registers `expect` gives (None: free there), without running module code."""
    mu = make(); w = World(mu, picture=False)
    seen = {}

    def stop(uc, address, size, _):
        seen['regs'] = [uc.reg_read(x) for x in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5,
                                                     UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_SB, UC_ARM_REG_SL, UC_ARM_REG_FP,
                                                     UC_ARM_REG_IP, UC_ARM_REG_SP, UC_ARM_REG_LR)]
        uc.emu_stop()
    mu.hook_add(UC_HOOK_CODE, stop, begin=at + 4, end=at + 4)
    names = (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
             UC_ARM_REG_R8, UC_ARM_REG_SB, UC_ARM_REG_SL, UC_ARM_REG_FP, UC_ARM_REG_IP, UC_ARM_REG_SP, UC_ARM_REG_LR)
    for r, v in zip(names, regs): mu.reg_write(r, v)
    mu.mem_write(regs[0] + 0x168, struct.pack('<I', 0x60255550))
    mu.mem_write(regs[0] + 0x15c, struct.pack('<I', 0x60255660))
    mu.mem_write(regs[11] - 0x34, b'\0\0')
    mu.emu_start(at, RET, count=400)
    got = seen.get('regs')
    want = expect(list(regs))
    if got: got = [g if x is not None else None for g, x in zip(got, want)]
    return got == want, got, want, w.log


base = [FAKE + 0x1000, 0x11, 0x22, 0x33, 0x44, FAKE + 0x1000, 0x66, 0x77, 0x88, 0x99, 0xaa, 0x600e0100, 0xcc, 0x600e0000, 0x12345678]
for name, (at, _) in HANDLERS.items():
    def expect(r, name=name):
        if name == 'confirm': r[0] = 0x60255550; r[12] = None  # ip: free (the next official instruction sets it)
        elif name == 'refresh': r[1] = r[2] = r[3] = None; r[12] = r[13]  # refresh(this): r1..r3 free
        else: r[12] = r[13]
        return r
    good, got, want, log = native_reaches(at, base, expect)
    if name == 'refresh':
        check(good and log == [('shown', 0x60255550, 2), ('title', 0x60255660, TITLE)], f'camera\'s mode refresh: 2 rows shown, title {TITLE}, then official ({log})' + ('' if good else f' {got} vs {want}'))
    else:
        check(good and not log, f'camera\'s mode {name}: reaches {at + 4:#x} as officially' + ('' if good else f' {got} vs {want}'))
good, got, want, log = native_reaches(0x53223bd4, base, lambda r: r[:13] + r[13:])
check(not good and got and got[1] != base[1], 'row types: the appended array')
mu = make(); w = World(mu)
call(mu, 0x53223ba0, (w.controller,))
init = [x for x in w.log if x[0] == 'list_init']
check(init and init[0][2] == 1 + N and init[0][3] == bytes([0x15] * (1 + N)), f'constructor: {init[0][2] if init else None} rows, types {init[0][3].hex() if init else None}')
check(new.u32(0x53223e9c) == off.u32(0x53223e9c), 'constructor title as officially')
mu = make(); w = World(mu)
w32(mu, w.controller + 0x15c, 0x7171)
call(mu, 0x532240e4, (w.controller,))
check(w.log[:2] == [('shown', w.widget, 1 + N), ('title', 0x7171, T_PICTURE)], f'picture mode refresh: {1 + N} rows shown, title {T_PICTURE} ({w.log[:2]})')

for record, chosen in ((None, 0), (REC(0xdead), 0)) + tuple((REC(IDS[k]), 1 + k) for k in range(N)):
    mu = make(); w = World(mu, record=record)
    call(mu, 0x532240e4, (w.controller,))
    texts = [x[2] for x in w.log if x[0] == 'text']
    ticks = [x[2] for x in w.log if x[0] == 'check']
    focus = [x[1] for x in w.log if x[0] == 'focus']
    check(texts == list(range(T_FACTORY, T_FACTORY + 1 + N)) and ticks == [int(r == chosen) for r in range(1 + N)] and focus == [chosen],
          f'refresh, record {record and record.hex()}: texts {texts} ticks {ticks} focus {focus}')
for row, want in [(0, REC(0))] + [(1 + k, REC(IDS[k])) for k in range(N)]:
    mu = make(); w = World(mu, selected=row)
    r = call(mu, 0x53223fa4, (w.controller,))
    hit = [x for x in w.log if x[0] == 'write']
    texts = [x[2] for x in w.log if x[0] == 'text']
    check(r == 1 and hit and hit[0] == ('write', 74, want) and len(texts) == 1 + N, f'confirm row {row}: {hit[:1]}')
mu = make(); w = World(mu, selected=1 + N)
check(call(mu, 0x53223fa4, (w.controller,)) == 0 and not [x for x in w.log if x[0] == 'write'], 'confirm past the last row: nothing')
for fn, row, stop, want in ((0x53223f14, 0, 1, []), (0x53223f14, 0, 0, [-1]), (0x53223f14, 1, 1, [-1]),
                            (0x53223f58, N, 1, []), (0x53223f58, N, 0, [1]), (0x53223f58, 0, 1, [1])):
    mu = make(); w = World(mu, selected=row)
    call(mu, fn, (w.controller, stop))
    moves = [x[1] for x in w.log if x[0] == 'move']
    check(moves == want, f'{"up" if fn == 0x53223f14 else "down"} at row {row}, stop {stop}: moves {moves}')
for row, edition, variant, want in [(0, 2, 0, 993), (0, 1, 0, 994), (0, 0, 0, 992), (0, 0, 5, 995)] + [(1 + k, 2, 0, 996 + k) for k in range(N)]:
    mu = make(); w = World(mu, selected=row, edition=edition, variant=variant)
    call(mu, 0x5322419c, (w.controller,))
    icons = [x[1] for x in w.log if x[0] == 'icon']; vis = [x[1] for x in w.log if x[0] == 'visible']
    check(icons == [want] and vis == [1], f'footer row {row} (edition {edition} variant {variant}): icon {icons} visible {vis}')

# --- 6. store, save, zero fill, catalogs.
print('6. store, save, start-up, catalogs')
mu = make()
mu.reg_write(UC_ARM_REG_SB, 16); mu.reg_write(UC_ARM_REG_SP, 0x600f0000); w32(mu, 0x600f0000, 0)
mu.emu_start(0x53a80adc, 0x53a80ae4, count=100)
check(u32(mu, 0x600f0000) == 75, f'APData record count argument: {u32(mu, 0x600f0000)}')
mu = make(); w = World(mu, record=REC(IDS[0]))
calls = []


def stop_native(uc, address, size, _):
    calls.append(address)
    uc.reg_write(UC_ARM_REG_R0, 7); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))


mu.hook_add(UC_HOOK_CODE, stop_native, begin=0x533e1c08, end=0x533e1c08)
r = call(mu, 0x533e1c04, (FAKE + 0x9000,))
writes = [x for x in w.log if x[0] == 'write']
check(calls and r == 7 and writes == [('write', 74, REC(IDS[0]))], f'settings save: native reached {bool(calls)}, result {r}, writes {writes}')
check(new.u32(0x53000460) == 0x55837300 and off.u32(0x53000460) == 0x558372d4, 'start-up zero fill reaches the heap (clears the picture list pointer)')
mu = make()
for row in range(21):
    got = [text(mu, row, t) for t in range(T_TYPE, T_FACTORY + 1 + N)]
    factory = {0: 'オリジナル', 18: '原廠', 19: '原厂'}.get(row, 'Original')
    names = got[3:]
    check(got[:3] == [TYPE_NAMES[row], PICTURE_NAMES[row], factory] and len(names) == N and all(names), f'texts, row {row}: {got}')
    check(text(mu, row, T_FACTORY + 1 + N) is None, f'texts, row {row}: nothing after the names')
print('  texts zh-CN', [text(mu, 19, t) for t in range(T_TYPE, T_FACTORY + 1 + N)])
for i in range(4 + N):
    d = u32(mu, 0x543d3ac0 + 4 * (992 + i))
    fmt, wd, ht, z, o = struct.unpack('<HHHHI', bytes(mu.mem_read(d, 12)))
    px = ICON[o * 4: o * 4 + wd * ht * 4]
    check((fmt, wd, ht, z) == (1, 520, 200, 0) and len(px) == 520 * 200 * 4 and px[3] == 255, f'icon {992 + i}: {(fmt, wd, ht)} at {o * 4}')
fails = [w for c, w in OK if not c]
print('ALL PASS (%d checks)' % len(OK) if not fails else 'FAILURES: %d\n  ' % len(fails) + '\n  '.join(fails))
sys.exit(1 if fails else 0)
