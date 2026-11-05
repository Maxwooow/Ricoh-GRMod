# SPDX-License-Identifier: GPL-2.0-only
"""
The HDR gain map's line of the still shooting menu (0.8.9, test 075; `core/src/fw/aspect/datestamp-menu.ts`,
`hdrTopDraw` / `installHdrMenu` / `stillMenuForModels`), checked in an emulator on a built RTOS:

 1. The menu builder (TopMenuController) builds, for every model (0 GR IV, 1 HDF, 2 Monochrome), the
    official still menu of that model (run on the official image) with "HDR" right after Color Space
    and, when the build has the date imprint's menu, its line at the end; the other four menus are
    the official ones. Page starts: at the same official items.
 2. The line draws the icon ON (setting byte 0) or OFF (1) and the title HDR_TEXT, whatever the other
    bits of the byte.
 3. The factory hands out the list controller (Horizon Correction's) for the line's id; list
    SetCurrentMenu maps the id to the new record; the record: two values, Off / On drawn with the
    camera's icons and texts, set writes 1 (Off) or 0 (On), "is current" follows bit 0. Every
    official id maps to the same submenu / list record as on the reference image.
 4. Text HDR_TEXT is "HDR" in all 21 languages.
 5. The settings guard's fix keeps 0 and 1 in the switch byte and makes anything else 0 (On).

    python3 menu_check.py BUILT.bin OFFICIAL.bin [REFERENCE.bin]

BUILT.bin, OFFICIAL.bin (and REFERENCE.bin, the same build without the HDR gain map, for the other
records; default: OFFICIAL.bin): RTOS sections (decoded).
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as dm  # noqa: E402

HDR_ID = 0x020001d0
HDR_TEXT = 974
DATE_ID = 0x020001a0
COLOR_SPACE = 0x0200008d
I_OFF, I_ON = 310, 311
T_OFF, T_ON = 2, 1
SWITCH = 0x10e                      # in the user settings object (CURRENT() + 4 + 0x10A)
LIST_SET_CURRENT = 0x531d5e8c
SUB_SET_CURRENT = 0x531e1bd0
SELECT_SITE = (0x531d6868, 0x531d6878)
SUB_SITE = (0x531e2064, 0x531e206c)
GUARD_SAVE = 0x533e1c04
BUILDER = 0x531b3ecc
HORIZON = 0x02000094
SWITCH_BYTE = 0x55084dd8 + 4 + 0x10a

failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
    return cond


def menus(img, model):
    e = dm.Emu(img, model)
    e.call(BUILDER, (0x70000000,))
    check(not [c for c in e.calls if c[0] == 'ASSERT'], f'builder asserted (model {model})')
    out = []
    for m in range(5):
        raw = bytes(e.mu.mem_read(0x70000000 + 0x230 + m * 0x38c, 0x38c))
        n = raw[0x8b]
        out.append({'ids': [struct.unpack_from('<I', raw, 0x1bc + 4 * k)[0] for k in range(n)],
                    'draws': [struct.unpack_from('<I', raw, 0x8c + 8 * k)[0] for k in range(n)],
                    'pages': list(raw[0x80:0x80 + raw[0x68]]), 'raw': raw})
    return out


def check_menus(new, off):
    has_date = False
    for model in (0, 1, 2):
        a, b = menus(new, model), menus(off, model)
        for m in range(1, 5):
            check(a[m]['raw'] == b[m]['raw'], f'model {model}: menu {m} differs from the official one')
        want = []
        for i in b[0]['ids']:
            want.append(i)
            if i == COLOR_SPACE:
                want.append(HDR_ID)
        got = a[0]['ids']
        if got and got[-1] == DATE_ID:
            has_date = True
            want.append(DATE_ID)
        check(got == want, f'model {model}: still menu items {[hex(x) for x in got]} vs {[hex(x) for x in want]}')
        # Page starts at the same official items.
        firsts_off = [b[0]['ids'][p] for p in b[0]['pages']]
        firsts_new = [a[0]['ids'][p] for p in a[0]['pages']]
        check(firsts_off == firsts_new, f'model {model}: page starts {firsts_new} vs {firsts_off}')
        # Official items draw as officially.
        for k, i in enumerate(b[0]['ids']):
            check(a[0]['draws'][got.index(i)] == b[0]['draws'][k], f'model {model}: item {i:#x} draw')
        print(f'  model {model}: {len(got)} items, pages {a[0]["pages"]}, HDR at {got.index(HDR_ID)} (after Color Space)')
    return has_date


def check_draw(new):
    m = menus(new, 1)[0]
    draw = m['draws'][m['ids'].index(HDR_ID)]
    for raw in (0, 1, 2, 3, 0xfe, 0xff):
        e = dm.Emu(new, 1)
        e.mu.mem_write(SWITCH_BYTE, bytes([raw]))
        e.call(draw, (0x70000000, 0x70100000))
        icons = [c for c in e.calls if c[0] == 'top-icon']
        titles = [c for c in e.calls if c[0] == 'top-title']
        want_icon = I_OFF if raw & 1 else I_ON
        check(len(icons) == 1 and icons[0][1] == 0x70100000 and icons[0][2] == want_icon, f'line icon for byte {raw}: {icons}')
        check(len(titles) == 1 and titles[0][1] == 0x70100000 and titles[0][2] == HDR_TEXT, f'line title for byte {raw}: {titles}')
        check(e.byte(SWITCH_BYTE) == raw, f'line draw changed the byte {raw}')
    print('  line: icon ON / OFF by bit 0, title', HDR_TEXT)


def check_list(new, ref):
    rec = dm.set_current(new, LIST_SET_CURRENT, 0x1a4, HDR_ID)
    check(isinstance(rec, int) and rec != 0xee, f'list SetCurrentMenu(HDR): {rec}')
    table = new.movw_movt(*SELECT_SITE)
    base = table + rec * 0x4c
    r = new.rd(base, 0x4c)
    title = struct.unpack_from('<H', r, 4)[0]
    count, draw, setf, cur = (struct.unpack_from('<I', r, o)[0] for o in (0x0c, 0x14, 0x24, 0x2c))
    check(title == HDR_TEXT, f'list title {title}')
    e = dm.Emu(new)
    check(e.call(count, (0x70000000,)) == 2, 'list: two values')
    for v, (icon, text) in enumerate(((I_OFF, T_OFF), (I_ON, T_ON))):
        e = dm.Emu(new)
        e.call(draw, (0x70000000, 0x70100000, v))
        items = [c for c in e.calls if c[0] == 'list-item']
        check(items == [('list-item', 0x70100000, icon, text)], f'list draw {v}: {items}')
    e = dm.Emu(new)
    e.call(draw, (0x70000000, 0x70100000, 2))
    check(not [c for c in e.calls if c[0] == 'list-item'], 'list draw past the values')
    for before in (0, 1, 7, 0xff):
        for v in (0, 1, 2):
            e = dm.Emu(new)
            e.mu.mem_write(SWITCH_BYTE, bytes([before]))
            e.call(setf, (0x70000000, v))
            want = before if v > 1 else (1 if v == 0 else 0)
            check(e.byte(SWITCH_BYTE) == want, f'list set {v} on byte {before}: {e.byte(SWITCH_BYTE)}')
    for raw in (0, 1, 2, 3):
        for v in (0, 1):
            e = dm.Emu(new)
            e.mu.mem_write(SWITCH_BYTE, bytes([raw]))
            got = e.call(cur, (0x70000000, v))
            on = (raw & 1) == 0
            check(got == (1 if (v == 1) == on else 0), f'list is-current {v} for byte {raw}: {got}')
    # Every other id maps as on the reference (the same build without the gain map, or the official image).
    # (the record's content: the gain map's list comes before records added later, e.g. the ADJ slots')
    def record(img, fn, offset, site, size, cid):
        r = dm.set_current(img, fn, offset, cid)
        if not isinstance(r, int) or r == 0xee:
            return r
        raw = img.rd(img.movw_movt(*site) + r * size, size)
        # Words pointing into the appended area (functions of additions) only say "an addition's".
        return tuple(-1 if dm.BASE + dm.OFFICIAL_LEN <= w < 0x55000000 else w for w in struct.unpack(f'<{size // 4}I', raw))
    for fn, offset, site, size, first, n in ((SUB_SET_CURRENT, 0x174, SUB_SITE, 0x64, 0x02000085, 0xa0), (LIST_SET_CURRENT, 0x1a4, SELECT_SITE, 0x4c, 0x02000073, 0xdf)):
        for cid in list(range(first, first + n + 2)) + list(range(0x020001a0, 0x020001c8)):
            a, b = record(new, fn, offset, site, size, cid), record(ref, fn, offset, site, size, cid)
            check(a == b, f'SetCurrentMenu({cid:#x}): another record than on the reference')
    check(dm.factory_class(new, HDR_ID) == dm.factory_class(ref, HORIZON), 'factory: the HDR id gives the list controller')
    for cid in (HDR_ID - 1, HDR_ID + 1, 0x020001cf, 0x020001d2):
        check(dm.factory_class(new, cid) == dm.factory_class(ref, cid), f'factory: id {cid:#x} (not ours)')
    print('  list record', rec, 'at', hex(base), ': Off / On, set / is-current on bit 0; other ids as the reference')


def check_texts(new):
    for lang in range(21):
        check(dm.text(new, lang, HDR_TEXT) == 'HDR', f'text {HDR_TEXT}, language {lang}: {dm.text(new, lang, HDR_TEXT)!r}')
    print('  text', HDR_TEXT, '"HDR" in 21 languages')


def check_guard(new):
    w = new.u32(GUARD_SAVE)
    if not check(w >> 24 == 0xea, 'no settings guard'):
        return
    stub = GUARD_SAVE + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4
    bls = [stub + 4 * k + 8 + (((x & 0xffffff) ^ 0x800000) - 0x800000) * 4 for k in range(12) if ((x := new.u32(stub + 4 * k)) >> 24) == 0xeb]
    fix = bls[1]
    for raw in range(256):
        e = dm.Emu(new)
        settings = 0x70400000
        e.mu.mem_write(settings + SWITCH, bytes([raw]))
        e.mu.mem_write(settings + SWITCH - 1, b'\x5a')
        e.mu.mem_write(settings + SWITCH + 1, b'\xa5')
        e.call(fix, (settings, 0))
        check(e.byte(settings + SWITCH) == (raw if raw <= 1 else 0), f'guard fix: switch byte {raw} -> {e.byte(settings + SWITCH)}')
        check(e.byte(settings + SWITCH - 1) == 0x5a and e.byte(settings + SWITCH + 1) == 0xa5, 'guard fix: bytes next to the switch changed')
    print('  guard fix', hex(fix), ': 0 / 1 kept, anything else 0 (On)')


def main():
    new, off = dm.Image(sys.argv[1]), dm.Image(sys.argv[2])
    ref = dm.Image(sys.argv[3]) if len(sys.argv) > 3 else off
    date = check_menus(new, off)
    print('  date imprint line:', 'yes' if date else 'no')
    check_draw(new)
    check_list(new, ref)
    check_texts(new)
    check_guard(new)
    if failures:
        print('FAILED:')
        for f in failures[:60]:
            print('  -', f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
