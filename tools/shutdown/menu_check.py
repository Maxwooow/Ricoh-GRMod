# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the power-off pictures' camera menu (core/src/fw/aspect/shutdown.ts).

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn (firmware
services the code reaches are fakes; everything GR Mod wrote and the native code between runs as
built), next to the official image where that is the reference:

 1. The power-off picture request: the factory picture of each model without a record, the chosen
    picture with one, the factory picture for a record of a picture no longer listed or a foreign one.
    1.20 chooses the factory picture otherwise: from its End Screen object (the picture chosen with
    GR WORLD, else the camera's own; see factory_index in shutdown.c). There, without a valid record
    1.20's own code runs and must choose what the official image chooses, for each choice.
 2. TopMenuController's builder: Setup is the official menu but for item 10 (End Screen), which
    opens the submenu id and is drawn as Setup's other submenu lines (no value, title End Screen);
    the other menus are those of the date imprint's checks (unchanged here).
 3. The controller factory: every official id as officially (End Screen 0x020000C4 included), the
    submenu id as every submenu, the picture id makes one End Screen object (0x16C, its constructor,
    kept before it runs) and hands out the same one afterwards; the date imprint's ids still work.
 4. SubMenuController::SetCurrentMenu: official ids as officially, the date imprint's and the new
    id to their records; the new record (title, lines, ids), the official records unchanged; the
    submenu drawn by SubMenuController (0x531E271C) from it; its two line value functions.
 5. The End Screen class, both instances: the camera's own (any other object) runs the official
    code (each patched entry reaches the official instruction after it with the same registers);
    the picture list builds 1 + n rows of type 0x15 and gets the "Picture" title; refresh (texts,
    one tick, cursor), confirm (the record), up / down at both ends, footer thumbnails (on 1.20 the
    factory row's thumbnail is that of the picture 1.20's own code chooses, for every choice).
 6. Settings store APData bound, settings save, start-up zero fill, texts and thumbnails.

    python3 menu_check.py BUILT.RTOS BUILT.ICONBIN OFFICIAL.RTOS N [datestamp]

N: number of pictures. `datestamp`: the build also has the date imprint's menu entry. The images
are of 1.11 or of 1.20 (the file of GR IV 1.20 / GR IV Monochrome 1.10): addresses through
tools/port120/fwtarget.py, texts, icons and record numbers of that firmware.
Needs the Python packages unicorn and capstone.
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'datestamp'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'port120'))
import menu_check as dm  # noqa: E402
import fwtarget  # noqa: E402
from fwtarget import V  # noqa: E402
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE  # noqa: E402
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4,  # noqa: E402
                               UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_SB,
                               UC_ARM_REG_SL, UC_ARM_REG_FP, UC_ARM_REG_IP, UC_ARM_REG_SP, UC_ARM_REG_LR,
                               UC_ARM_REG_PC)

BASE = 0x53000000
RAMVA = 0x55000000
RET = 0x100
FAKE = 0x60200000
MENU_ID, PICTURE_ID, END_SCREEN = 0x020001a3, 0x020001a4, 0x020000c4
TYPE_NAMES = ['タイプ', 'Type', 'Type', 'Typ', 'Tipo', 'Tipo', 'Tipo', 'Type', 'Type', 'Typ', 'Tyyppi',
              'Typ', 'Typ', 'Típus', 'Tip', 'Τύπος', 'Тип', '유형', '類型', '类型', 'แบบ']
PICTURE_NAMES = ['画像', 'Picture', 'Image', 'Bild', 'Imagen', 'Imagem', 'Immagine', 'Afbeelding', 'Billede', 'Bild', 'Kuva',
                 'Obraz', 'Obrázek', 'Kép', 'Resim', 'Εικόνα', 'Изображение', '이미지', '圖片', '图片', 'ภาพ']
# The factory pictures in the order of the module's factory_icon (thumbnails 992..995).
FACTORY_FILES = ['A:\\Resource\\Jpeg\\GoodBye.jpg', 'A:\\Resource\\Jpeg\\GB_HDF.jpg', 'A:\\Resource\\Jpeg\\GB_Mono.jpg', 'A:\\Resource\\Jpeg\\GB_20th.jpg']

R = open(sys.argv[1], 'rb').read()
ICON = open(sys.argv[2], 'rb').read()
OFF_PATH = sys.argv[3]
OFF = open(OFF_PATH, 'rb').read()
N = int(sys.argv[4])
DATESTAMP = len(sys.argv) > 5 and sys.argv[5] == 'datestamp'
OK = []

dm.use(OFF)
T = fwtarget.active()
NEW120 = T is fwtarget.T120
RAMIMG, RAMLEN = T.ram_src, T.ram_len
MODE = T.heap - 0x10
T_TYPE = T.texts_own['shutdown']
T_PICTURE, T_FACTORY = T_TYPE + 1, T_TYPE + 2
TITLE = T.camera_texts['endScreen']
SUB = T.submenu_records + 1
HANDLERS = {'refresh': (V(0x532240e4), 1), 'confirm': (V(0x53223fa4), 1), 'up': (V(0x53223f14), 2), 'down': (V(0x53223f58), 2), 'footer': (V(0x5322419c), 1)}
REQUEST = V(0x531b9488)


def check(cond, what):
    OK.append((bool(cond), what))
    print(('PASS ' if cond else 'FAIL ') + what)
    return cond


def make(image=None):
    image = R if image is None else image
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, max((len(image) + 0xfffff) & ~0xfffff, 0x1500000))
    mu.mem_write(BASE, image)
    mu.mem_map(RAMVA, 0x1000000)
    mu.mem_write(RAMVA, image[RAMIMG - BASE:RAMIMG - BASE + RAMLEN])
    mu.mem_map(0x60000000, 0x400000)
    mu.mem_map(0, 0x1000)
    return mu


def u32(mu, a): return struct.unpack('<I', mu.mem_read(a, 4))[0]
def w32(mu, a, v): mu.mem_write(a, struct.pack('<I', v & 0xffffffff))


def word(image, va): return struct.unpack_from('<I', image, va - BASE)[0]


def branch(at, w):
    d = w & 0xffffff
    return at + 8 + ((d ^ 0x800000) - 0x800000) * 4


def cstr(mu, a):
    b = bytes(mu.mem_read(a, 64))
    return b.split(b'\0')[0].decode('latin1')


if NEW120:
    # 1.20's own End Screen picture (no 1.11 counterpart): the request ends with a tail call to SHOW
    # (display), which hands the End Screen object (VARIANT_ROOT() + 0x28) to CHOOSE(screen, path,
    # &width, &height); CHOOSE takes byte 0x15 (the choice made with GR WORLD: 0..4 its table, above
    # 50 the downloaded B:\GB_DL.jpg; each only when the file is there), else byte 0x14 (the
    # camera's own), under a semaphore (LOCK / UNLOCK); EXISTS(drive, path, 0) asks for the file.
    tail = next(REQUEST + k for k in range(4, 0x40, 4) if word(OFF, REQUEST + k) >> 24 == 0xea)
    SHOW = branch(tail, word(OFF, tail))
    at = next(SHOW + k for k in range(0, 0x100, 4) if word(OFF, SHOW + k) == 0xe5900028)  # ldr r0, [r0, #0x28]
    call_at = next(at + k for k in range(4, 0x40, 4) if word(OFF, at + k) >> 24 == 0xeb)
    CHOOSE, CHOOSE_RET = branch(call_at, word(OFF, call_at)), call_at + 4
    bls = [branch(CHOOSE + k, word(OFF, CHOOSE + k)) for k in range(0, 0x14c, 4) if word(OFF, CHOOSE + k) >> 24 == 0xeb]
    assert (SHOW, CHOOSE) == (0x53264390, 0x5378f5c0) and len(bls) == 7 and bls[1] == bls[4] == bls[6] and bls[3] == bls[5], [hex(b) for b in bls]
    LOCK, UNLOCK, EXISTS = bls[0], bls[2], bls[3]
    B30, DOWNLOADED = 'B:\\Resource\\Jpeg\\GB_30th.jpg', 'B:\\GB_DL.jpg'


class World:
    """Fakes for the firmware services; `log` records calls. `screen`: 1.20's End Screen object as
    (byte 0x14, byte 0x15), None for none; `exists`: the files EXISTS finds."""
    def __init__(self, mu, variant=0, edition=2, selected=0, record=None, picture=True, screen=None, exists=()):
        self.mu, self.log, self.store = mu, [], {}
        if record is not None: self.store[74] = record
        self.variant, self.edition, self.selected, self.exists = variant, edition, selected, set(exists)
        self.app, self.userdata, self.display, self.storage, self.ap = FAKE, FAKE + 0x100, FAKE + 0x200, FAKE + 0x300, FAKE + 0x400
        self.controller, self.widget, self.graphic, self.variant_root = FAKE + 0x1000, FAKE + 0x2000, FAKE + 0x3000, FAKE + 0x4000
        w32(mu, self.storage + 8, self.ap)
        w32(mu, self.controller + 0x168, self.widget)
        w32(mu, self.controller + 0x164, self.graphic)
        w32(mu, MODE, 1 if picture else 0)
        a, b, c = FAKE + 0x5000, FAKE + 0x5100, FAKE + 0x5200
        w32(mu, self.variant_root + 8, a); w32(mu, a + 0xc, b); w32(mu, b + 0x20, c); w32(mu, c + 0x48, variant)
        if screen is not None:
            s = FAKE + 0x5400
            mu.mem_write(s + 0x14, bytes(screen))
            w32(mu, s + 8, FAKE + 0x5500); w32(mu, s + 0x10, FAKE + 0x5600)
            w32(mu, self.variant_root + 0x28, s)
        self.fns = {
            V(0x5323ea84): lambda r: self.app,
            V(0x5323f018): lambda r: self.userdata,
            V(0x5323ed78): lambda r: self.display,
            V(0x5323ff28): lambda r: FAKE + 0x600,
            V(0x5323f378): lambda r: FAKE + 0x6000,
            V(0x533e0324): lambda r: self.edition,
            V(0x5372b620): lambda r: self.variant_root,
            V(0x53a81480): lambda r: self.storage,
            V(0x53a7e2b8): lambda r: 1 if r[1] in self.store else 0,
            V(0x53a7e208): lambda r: len(self.store.get(r[1], b'')),
            V(0x53a7e434): self.read,
            V(0x53a7e518): self.write,
            V(0x53570b6c): lambda r: self.selected,
            V(0x53570a9c): lambda r: 0x7000 + r[1],
            V(0x5357ad40): lambda r: self.rec('check', r[0] - 0x7000, r[1]),
            V(0x5357ade0): lambda r: self.rec('text', r[0] - 0x7000, r[1]),
            V(0x53571788): lambda r: self.rec('focus', r[1]),
            V(0x535715b8): lambda r: self.rec('move', r[1] - (1 << 32) if r[1] >> 31 else r[1], r[2]),
            V(0x53576e38): lambda r: self.rec('icon', r[1]),
            V(0x53589ab4): lambda r: self.rec('visible', r[1]),
            V(0x5357094c): lambda r: self.rec('list_init', r[1], r[2], bytes(mu.mem_read(r[1], r[2]))),
            V(0x5357f2b0): lambda r: self.rec('title', r[0], r[1]),
            V(0x535711e4): lambda r: self.rec('shown', r[0], r[1]),
            V(0x535831e8): lambda r: self.rec('line_text', r[0], r[1]),
            V(0x5357a428): lambda r: self.rec('top_icon', r[0], r[1]),
            V(0x5357a1c0): lambda r: self.rec('top_title', r[0], r[1]),
            V(0x538e09b0): lambda r: FAKE + 0x8000,
            V(0x53570e84): lambda r: 0,
        }
        if NEW120:
            self.fns[LOCK] = lambda r: 1
            self.fns[UNLOCK] = lambda r: 0
            self.fns[EXISTS] = lambda r: 1 if cstr(mu, r[1]) in self.exists else 0
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


def text(mu, row, tid):
    d = u32(mu, u32(mu, T.text_catalog + 4 * row) + 4 * tid)
    if not d: return None
    units = mu.mem_read(d, 1)[0]
    return bytes(mu.mem_read(u32(mu, d + 4), 2 * (units - 1))).decode('utf-16-le')


REC = lambda choice: struct.pack('<II', 0x4f44534d, choice)
mv = lambda x: ((x >> 4) & 0xf000) | (x & 0xfff)


def _ids():
    mu = make()
    w = u32(mu, REQUEST); stub = branch(REQUEST, w)
    ctx = mv(u32(mu, stub)) | (mv(u32(mu, stub + 4)) << 16)
    return [u32(mu, ctx + 24 + 8 + 16 + 4 * k) for k in range(N)]


IDS = _ids()
print('firmware', T.tag, 'ids', [hex(i) for i in IDS])
new, off = dm.Image(sys.argv[1]), dm.Image(OFF_PATH)

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
    call(mu, REQUEST, (w.controller,))
    return seen


def picture_120(image, record, screen, exists):
    """The request on 1.20: the number the JPEG reader is asked for (this program's pictures), or
    what 1.20's own code chooses (path, size, whether it was a choice of GR WORLD)."""
    mu = make(image); w = World(mu, record=record, screen=screen, exists=exists)
    seen = {}

    def at_reader(uc, address, size, _):
        seen['number'] = uc.reg_read(UC_ARM_REG_R1)
        uc.emu_stop()

    def at_choose(uc, address, size, _):
        seen['args'] = (uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2), uc.reg_read(UC_ARM_REG_R3))

    def after_choose(uc, address, size, _):
        path, pw, ph = seen.pop('args')
        seen['path'], seen['wh'], seen['chosen'] = cstr(uc, path), (u32(uc, pw), u32(uc, ph)), uc.reg_read(UC_ARM_REG_R0)
        uc.emu_stop()
    mu.hook_add(UC_HOOK_CODE, at_reader, begin=V(0x53262558), end=V(0x53262558))
    mu.hook_add(UC_HOOK_CODE, at_choose, begin=CHOOSE, end=CHOOSE)
    mu.hook_add(UC_HOOK_CODE, after_choose, begin=CHOOSE_RET, end=CHOOSE_RET)
    call(mu, REQUEST, (w.controller,))
    return seen


def jpeg_entry(img, number):
    """(width, height, path) of a number of the full-screen JPEG table as the reader loads it."""
    table = img.movw_movt(V(0x5326255c), V(0x5326256c))
    e = img.u32(table + 4 * number)
    wd, ht, p = struct.unpack('<HHI', img.rd(e, 8))
    return wd, ht, img.rd(p, 64).split(b'\0')[0].decode('latin1')


if not NEW120:
    for variant, edition, want in ((0, 0, 'GoodBye'), (0, 1, 'GB_Mono'), (0, 2, 'GB_HDF'), (5, 0, 'GB_20th')):
        s = picture(variant, edition, None)
        check(want in s.get('path', ''), f'no record, variant {variant} edition {edition}: factory {s.get("path")}')
    s = picture(0, 2, REC(IDS[-1]))
    check(s.get('path', '').endswith(f'GRMOD{N}.jpg') and s['id'] == 11 + N and s['wh'] == (720, 480), f'record = last picture: {s}')
    s = picture(0, 2, REC(0xdead))
    check('GB_HDF' in s.get('path', ''), f'record of a picture no longer listed: factory {s.get("path")}')
    s = picture(0, 2, struct.pack('<II', 0x32424753, 1))
    check('GB_HDF' in s.get('path', ''), f'foreign record: factory {s.get("path")}')
else:
    cases = [((0, 0x10), (), 'GoodBye.jpg', None), ((0, 1), (), 'GB_HDF.jpg', None), ((1, 2), (), 'GB_Mono.jpg', None),
             ((2, 3), (), 'GB_20th.jpg', None), ((2, 4), (B30,), B30, None), ((2, 4), (), 'GB_Mono.jpg', None),
             ((1, 0xff), (DOWNLOADED,), DOWNLOADED, None), ((1, 0xff), (), 'GB_HDF.jpg', None),
             ((1, 2), (), 'GB_Mono.jpg', REC(0xdead)), ((0, 3), (), 'GB_20th.jpg', struct.pack('<II', 0x32424753, 1))]
    for screen, extra, want, record in cases:
        files = FACTORY_FILES + list(extra)
        a, b = picture_120(R, record, screen, files), picture_120(OFF, None, screen, files)
        check(a == b and 'number' not in a and a.get('path', '').endswith(want) and a['wh'] == (720, 480),
              f'record {record and record.hex()}, End Screen bytes {screen}, {len(extra)} downloaded: 1.20\'s own choice {a} (official {b})')
    for k in (0, N - 1):
        s = picture_120(R, REC(IDS[k]), (1, 2), FACTORY_FILES)
        entry = jpeg_entry(new, s.get('number', 0))
        check(s.get('number') == T.jpeg_count + k and 'path' not in s and entry == (720, 480, f'A:\\Resource\\Jpeg\\GRMOD{k + 1}.jpg'),
              f'record = picture {k + 1}: number {s.get("number")}, table entry {entry}')
    check(jpeg_entry(new, T.jpeg_count - 1) == jpeg_entry(off, T.jpeg_count - 1), 'JPEG table: official entries as before')

# --- 2. the menus as built.
print('2. menus')
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
for d in (V(0x53d9cdb0), V(0x53d9d4d0), V(0x53d9d13c), V(0x53d9c438), V(0x53d9ca10)):
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
    r = e.call(V(0x53185f7c), (0x70000000, cid), limit=200000, strict=end)
    return r, e.u32(MODE), e.mu.reg_read(UC_ARM_REG_SP) if end else 0x600f0000


for cid, before, want in ((PICTURE_ID, 0, 1), (PICTURE_ID, 1, 1), (END_SCREEN, 1, 0), (END_SCREEN, 0, 0), (MENU_ID, 1, 1), (MENU_ID, 0, 0), (0x020000c3, 1, 1)):
    r, mode, sp = mode_after(cid, before)
    obj_ok = r == 0x7abc0000 if cid in (PICTURE_ID, END_SCREEN) else True
    check(mode == want and obj_ok and sp == 0x600f0000, f'factory({cid:#x}) with mode {before}: mode {mode}, object {r:#x}')



def key_map(img, fn, cid):
    """Run a key-mapper function (0x53255A0C has-own-map, 0x532544A4 pick-map) with `cid` as the
    current controller id; returns its result and the last instruction it ran (the map chosen)."""
    e = dm.Emu(img)
    e.stubs[V(0x5325ca14)] = lambda: cid
    e.stubs[V(0x5323ebf8)] = lambda: 0x70100000
    last = []
    e.mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, u: last.append(a) if fn <= a < fn + 0x2000 else None)
    r = e.call(fn, (0x70200000, 5), limit=20000, strict=False)
    return r, last[-1] if last else None


for fn in (V(0x53255a0c), V(0x532544a4)):
    a, b = key_map(new, fn, PICTURE_ID), key_map(off, fn, END_SCREEN)
    check(a == b, f'key map {fn:#x}: the picture list as the End Screen list ({a} vs {b})')
    for cid in (END_SCREEN, MENU_ID, 0x020000c3, 0x020000d0):
        check(key_map(new, fn, cid) == key_map(off, fn, cid), f'key map {fn:#x}: {cid:#x} as officially')

# --- 4. the submenu.
print('4. submenu')
sub_sites = [(V(0x531e2064), V(0x531e206c)), (V(0x531e20cc), V(0x531e20d4)), (V(0x531e2438), V(0x531e2444)), (V(0x531e2668), V(0x531e266c)), (V(0x531e2734), V(0x531e2740))]
tables = {new.movw_movt(*s) for s in sub_sites}
check(len(tables) == 1, 'submenu table sites agree')
st = tables.pop()
number = SUB + 1 if DATESTAMP else SUB
SET_CURRENT = V(0x531e1bd0)
check(new.rd(st, SUB * 0x64) == off.rd(V(0x53da6718), SUB * 0x64), 'submenu table: official records (and what followed them) as before')
if DATESTAMP:
    check(new.u16(st + SUB * 0x64 + 2) == T.texts_own['dateStamp'][0], 'submenu table: the date imprint record kept')
bad = []
for cid in range(0x02000085, 0x02000085 + 0xa2):
    if dm.set_current(new, SET_CURRENT, 0x174, cid) != dm.set_current(off, SET_CURRENT, 0x174, cid): bad.append(hex(cid))
check(not bad, f'SetCurrentMenu: official ids as officially ({bad})')
check(dm.set_current(new, SET_CURRENT, 0x174, MENU_ID) == number, f'SetCurrentMenu(submenu id) = record {number}')
if DATESTAMP:
    check(dm.set_current(new, SET_CURRENT, 0x174, 0x020001a0) == SUB, f'SetCurrentMenu(date imprint id) = record {SUB}')
check(dm.set_current(new, SET_CURRENT, 0x174, PICTURE_ID) == dm.set_current(off, SET_CURRENT, 0x174, PICTURE_ID), 'SetCurrentMenu(picture id) as officially')
rec = st + number * 0x64
reset = V(0x53da6718) + 17 * 0x64
check(off.u16(reset + 2) == T.camera_texts['reset'], 'the official Reset record (the template)')
check(new.u16(rec + 2) == TITLE and new.rd(rec + 6, 1)[0] == 2 and new.u16(rec + 8) == T_TYPE and new.u16(rec + 10) == T_PICTURE, 'record: title, lines, line texts')
check(new.u32(rec + 0x14) == END_SCREEN and new.u32(rec + 0x18) == PICTURE_ID, 'record: line ids')
same = [o for o in range(0, 0x64) if not (2 <= o < 4 or 8 <= o < 12 or 0x14 <= o < 0x1c or 0x3c <= o < 0x4c)]
check(all(new.rd(rec + o, 1) == off.rd(reset + o, 1) for o in same), 'record: other fields as Reset\'s')
line_type, line_picture = new.u32(rec + 0x3c), new.u32(rec + 0x44)
for byte, want in ((0, T.camera_texts['type1']), (1, T.camera_texts['type2'])):
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
    return V(0x531e271c)


e, seen = dm.views(new, 0, setup)
texts = [c[1] for c in seen if c[0] == hex(V(0x53583014))]
titles = [c[1] for c in seen if c[0] == hex(V(0x5357f2b0))]
values = [c[1] for c in seen if c[0] == hex(V(0x535831e8))]
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
good, got, want, log = native_reaches(V(0x53223bd4), base, lambda r: r[:13] + r[13:])
check(not good and got and got[1] != base[1], 'row types: the appended array')
mu = make(); w = World(mu)
call(mu, V(0x53223ba0), (w.controller,))
init = [x for x in w.log if x[0] == 'list_init']
check(init and init[0][2] == 1 + N and init[0][3] == bytes([0x15] * (1 + N)), f'constructor: {init[0][2] if init else None} rows, types {init[0][3].hex() if init else None}')
check(new.u32(V(0x53223e9c)) == off.u32(V(0x53223e9c)), 'constructor title as officially')
mu = make(); w = World(mu)
w32(mu, w.controller + 0x15c, 0x7171)
call(mu, HANDLERS['refresh'][0], (w.controller,))
check(w.log[:2] == [('shown', w.widget, 1 + N), ('title', 0x7171, T_PICTURE)], f'picture mode refresh: {1 + N} rows shown, title {T_PICTURE} ({w.log[:2]})')

for record, chosen in ((None, 0), (REC(0xdead), 0)) + tuple((REC(IDS[k]), 1 + k) for k in range(N)):
    mu = make(); w = World(mu, record=record)
    call(mu, HANDLERS['refresh'][0], (w.controller,))
    texts = [x[2] for x in w.log if x[0] == 'text']
    ticks = [x[2] for x in w.log if x[0] == 'check']
    focus = [x[1] for x in w.log if x[0] == 'focus']
    check(texts == list(range(T_FACTORY, T_FACTORY + 1 + N)) and ticks == [int(r == chosen) for r in range(1 + N)] and focus == [chosen],
          f'refresh, record {record and record.hex()}: texts {texts} ticks {ticks} focus {focus}')
for row, want in [(0, REC(0))] + [(1 + k, REC(IDS[k])) for k in range(N)]:
    mu = make(); w = World(mu, selected=row)
    r = call(mu, HANDLERS['confirm'][0], (w.controller,))
    hit = [x for x in w.log if x[0] == 'write']
    texts = [x[2] for x in w.log if x[0] == 'text']
    check(r == 1 and hit and hit[0] == ('write', 74, want) and len(texts) == 1 + N, f'confirm row {row}: {hit[:1]}')
mu = make(); w = World(mu, selected=1 + N)
check(call(mu, HANDLERS['confirm'][0], (w.controller,)) == 0 and not [x for x in w.log if x[0] == 'write'], 'confirm past the last row: nothing')
UP, DOWN = HANDLERS['up'][0], HANDLERS['down'][0]
for fn, row, stop, want in ((UP, 0, 1, []), (UP, 0, 0, [-1]), (UP, 1, 1, [-1]),
                            (DOWN, N, 1, []), (DOWN, N, 0, [1]), (DOWN, 0, 1, [1])):
    mu = make(); w = World(mu, selected=row)
    call(mu, fn, (w.controller, stop))
    moves = [x[1] for x in w.log if x[0] == 'move']
    check(moves == want, f'{"up" if fn == UP else "down"} at row {row}, stop {stop}: moves {moves}')


def footer(row, **world):
    mu = make(); w = World(mu, selected=row, **world)
    call(mu, HANDLERS['footer'][0], (w.controller,))
    return [x[1] for x in w.log if x[0] == 'icon'], [x[1] for x in w.log if x[0] == 'visible']


for k in range(N):
    icons, vis = footer(1 + k, edition=2, variant=0, screen=(1, 2))
    check(icons == [996 + k] and vis == [1], f'footer row {1 + k}: icon {icons} visible {vis}')
if not NEW120:
    for edition, variant, want in ((2, 0, 993), (1, 0, 994), (0, 0, 992), (0, 5, 995)):
        icons, vis = footer(0, edition=edition, variant=variant)
        check(icons == [want] and vis == [1], f'footer row 0 (edition {edition} variant {variant}): icon {icons} visible {vis}')
else:
    # The factory row's thumbnail is that of the picture 1.20's own code shows (every factory file
    # there, the 30th's and a downloaded picture too); none for those two, which have no thumbnail.
    files = FACTORY_FILES + [B30, DOWNLOADED]
    seen = []
    for default in range(5):
        for choice in (0, 1, 2, 3, 4, 5, 50, 51, 0xff):
            shown = picture_120(OFF, None, (default, choice), files).get('path')
            want = FACTORY_FILES.index(shown) if shown in FACTORY_FILES else None
            icons, vis = footer(0, screen=(default, choice))
            ok = (icons, vis) == (([992 + want], [1]) if want is not None else ([], [0]))
            check(ok, f'footer row 0, End Screen bytes ({default}, {choice}): 1.20 shows {shown}; icon {icons} visible {vis}')
            seen.append(want)
    check(set(seen) == {0, 1, 2, 3, None}, f'footer row 0: every factory thumbnail and none were met ({sorted(set(seen), key=str)})')
    icons, vis = footer(0)
    check(icons == [] and vis == [0], f'footer row 0, no End Screen object: icon {icons} visible {vis}')

# --- 6. store, save, zero fill, catalogs.
print('6. store, save, start-up, catalogs')
mu = make()
mu.reg_write(UC_ARM_REG_SB, 16); mu.reg_write(UC_ARM_REG_SP, 0x600f0000); w32(mu, 0x600f0000, 0)
mu.emu_start(V(0x53a80adc), V(0x53a80adc) + 8, count=100)
check(u32(mu, 0x600f0000) == 75, f'APData record count argument: {u32(mu, 0x600f0000)}')
check(off.u32(V(0x53a80adc) - 0x10) == 0xe3a09010, 'APData: 16 records officially (mov sb, #16)')
mu = make(); w = World(mu, record=REC(IDS[0]))
calls = []


def stop_native(uc, address, size, _):
    calls.append(address)
    uc.reg_write(UC_ARM_REG_R0, 7); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))


SAVE = V(0x533e1c04)
mu.hook_add(UC_HOOK_CODE, stop_native, begin=SAVE + 4, end=SAVE + 4)
r = call(mu, SAVE, (FAKE + 0x9000,))
writes = [x for x in w.log if x[0] == 'write']
check(calls and r == 7 and writes == [('write', 74, REC(IDS[0]))], f'settings save: native reached {bool(calls)}, result {r}, writes {writes}')
check(new.u32(V(0x53000460)) == T.heap and off.u32(V(0x53000460)) == T.bss_end, 'start-up zero fill reaches the heap (clears the picture list pointer)')
mu = make()
for row in range(21):
    got = [text(mu, row, t) for t in range(T_TYPE, T_FACTORY + 1 + N)]
    factory = {0: 'オリジナル', 18: '原廠', 19: '原厂'}.get(row, 'Original')
    names = got[3:]
    check(got[:3] == [TYPE_NAMES[row], PICTURE_NAMES[row], factory] and len(names) == N and all(names), f'texts, row {row}: {got}')
    check(text(mu, row, T_FACTORY + 1 + N) is None, f'texts, row {row}: nothing after the names')
print('  texts zh-CN', [text(mu, 19, t) for t in range(T_TYPE, T_FACTORY + 1 + N)])
for i in range(4 + N):
    d = u32(mu, T.icon_catalog + 4 * (992 + i))
    fmt, wd, ht, z, o = struct.unpack('<HHHHI', bytes(mu.mem_read(d, 12)))
    px = ICON[o * 4: o * 4 + wd * ht * 4]
    check((fmt, wd, ht, z) == (1, 520, 200, 0) and len(px) == 520 * 200 * 4 and px[3] == 255, f'icon {992 + i}: {(fmt, wd, ht)} at {o * 4}')
fails = [w for c, w in OK if not c]
print('ALL PASS (%d checks)' % len(OK) if not fails else 'FAILURES: %d\n  ' % len(fails) + '\n  '.join(fails))
sys.exit(1 if fails else 0)
