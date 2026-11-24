# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of test 084 (core/src/fw/gr4v121/aspect/viewmenu.ts): the live-view shade's still
menu line and list, its UI palette colours, the custom grids in the Grid Style list and the setup
menu line's icon, and the names of the two Flash Modes flash TTL meters.

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn (the harness of
tools/gr4v121/datestamp/menu_check.py), next to the official image:

    python3 check.py BUILT-RTOS OFFICIAL-RTOS [--shade] [--grid '{"g3":[...8],"g4":[...8]}' | --framing g3,g4] [--ttl]

 --shade (a build with added ratios):
  1. The still menu (TopMenuController's builder, models 0..2): the shade's line right after Aspect
     Ratio; its draw function shows the icon of the stored level and the title for every byte.
  2. The controller factory gives its id the list controller; SetCurrentMenu maps it to an added
     record; the list: title, five values (icons, texts), is current and set for every byte (bits
     3..5; the other bits kept; 5..7 count as 75 %).
  3. The 32-bit fill's palette lookup reads 256 words: the official palette's 48, then what follows
     it in the image, with 0xC0000000 at 0xF0 and 0x40000000 at 0xF1.
 --grid (the build's custom grid):
  4. Grid Style (list record 93 of the list table as the build has it): count; draw of the camera's
     values exactly as officially, of the custom ones their icon and text; is current and set for
     every style and every value of the byte (bit 6; the other bits kept), set calling the camera's
     setter with the style; the setup menu line's icon as officially, or the custom one's.
 --framing (a build with framing guides, core/src/fw/gr4v121/aspect/framing.ts): the presets that are values of
     their own (g3: Custom Grid 1, g4: Custom Grid 2); 4 as for --grid, their names "Custom Grid 1 / 2"; the
     palette check of 3 leaves out the guides' colours (0xE0..0xE7, checked by tools/gr4v121/framing/check.py).
 --ttl:
  5. Texts 135 and 137: the official text with " (TTL)" ("（TTL）" in Japanese and Chinese), every row.
 Always: 6. texts and icons the options add (sizes, the lookup bounds).
"""
import json
import struct
import sys
from pathlib import Path

from unicorn import UC_HOOK_CODE

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as dm  # noqa: E402
from menu_check import Image, Emu  # noqa: E402

failures = dm.failures
check = dm.check

CURRENT = 0x550832a8
VIEW_BYTE = CURRENT + 4 + 0x109
STYLE_BYTE = CURRENT + 0x8d9
SHADE_LIST = 0x020001d3
ASPECT_RATIO = 0x0200008a
T_CUSTOM = {'g3': 1030, 'g4': 1031}
T_SHADE, T_LEVELS = 1032, [1033, 1034, 1035, 1036, 1037]
I_CUSTOM = {'g3': 1120, 'g4': 1121}
I_LEVELS = [1122, 1123, 1124, 1125, 1126]
CODES = [1, 0, 2, 3, 4]  # list position -> stored code
CAMERA = {'g3': [True, False, True, True, False, True, False, False], 'g4': [True] * 8}
PALETTE, PALETTE_LOOKUP = 0x540799dc, 0x539278c0
GRID_SET_STYLE = 0x533393a8
GRID_LINE_DRAW = 0x531b3430
LIST_TABLE_SITE = (0x531d8864, 0x531d8874)
BUILDER = 0x531b5878
TEXT_CATALOG = dm.TEXT_CATALOG
SHADE_NAMES_EN = 'Matte Brightness'


def list_record(img, rec):
    return img.rd(img.movw_movt(*LIST_TABLE_SITE) + rec * 0x4c, 0x4c)


def handlers(r):
    return {k: struct.unpack_from('<I', r, o)[0] for k, o in (('count', 0x0c), ('draw', 0x14), ('set', 0x24), ('current', 0x2c))}


# --- 1-3. The shade -------------------------------------------------------------------------------
def still_ids(img, model):
    """The still tab's controller ids, in order, from the narrow or the wide layout."""
    e = Emu(img, model)
    this = 0x70000000
    e.call(BUILDER, (this,))
    check(not [c for c in e.calls if c[0] == 'ASSERT'], f'builder asserted (model {model})')
    blk = bytes(e.mu.mem_read(this + 0x230, 0x38c))
    n = blk[0x8b]
    narrow = [struct.unpack_from('<I', blk, 0x1bc + 4 * k)[0] for k in range(min(n, 38))]
    wide = [struct.unpack('<I', e.mu.mem_read(this + 0x13ec + k * 4, 4))[0] for k in range(n)]
    ids = wide if SHADE_LIST in wide else narrow
    draws = {}
    if SHADE_LIST in narrow:
        draws = {i: struct.unpack_from('<I', blk, 0x8c + 8 * k)[0] for k, i in enumerate(narrow)}
    else:
        draws = {i: struct.unpack('<I', e.mu.mem_read(this + 0x1734 + k * 8, 4))[0] for k, i in enumerate(wide)}
    return ids, draws


def shade_code(raw):
    c = (raw >> 3) & 7
    return 0 if c > 4 else c


def check_shade(new, off):
    for model in (0, 1, 2):
        ids, draws = still_ids(new, model)
        check(SHADE_LIST in ids and ids.index(SHADE_LIST) == ids.index(ASPECT_RATIO) + 1, f'model {model}: shade line not after Aspect Ratio: {[hex(i) for i in ids]}')
    print('  still menu: the line right after Aspect Ratio (models 0, 1, 2)')
    draw = draws[SHADE_LIST]
    for raw in range(256):
        e = Emu(new)
        e.mu.mem_write(VIEW_BYTE, bytes([raw]))
        e.call(draw, (0x70000000, 0x70700000))
        calls = [c[:3] for c in e.calls if c[0] in ('top-icon', 'top-title')]
        want = [('top-icon', 0x70700000, I_LEVELS[CODES.index(shade_code(raw))]), ('top-title', 0x70700000, T_SHADE)]
        check(calls == want, f'shade line byte {raw:#x}: {calls}')
        check(e.byte(VIEW_BYTE) == raw, f'shade line changed the byte {raw:#x}')
    print('  line: icon of the stored level and title, every byte')

    lst = dm.factory_class(off, 0x02000094)
    check(dm.factory_class(new, SHADE_LIST) == lst, 'factory: shade list id')
    rec = dm.set_current(new, 0x531d7e68, 0x1a4, SHADE_LIST)
    check(isinstance(rec, int) and rec > 126, f'SetCurrentMenu(shade list): {rec}')
    h = handlers(list_record(new, rec))
    check(struct.unpack_from('<H', list_record(new, rec), 4)[0] == T_SHADE, 'shade list title')
    check(Emu(new).call(h['count'], (0x70000000,)) == 5, 'shade list count')
    for i in range(6):
        e = Emu(new)
        e.call(h['draw'], (0x70000000, 0x70700000, i))
        items = [c for c in e.calls if c[0] == 'list-item']
        check(items == ([('list-item', 0x70700000, I_LEVELS[i], T_LEVELS[i])] if i < 5 else []), f'shade list draw {i}: {items}')
    for raw in range(256):
        cur = []
        for i in range(6):
            e = Emu(new)
            e.mu.mem_write(VIEW_BYTE, bytes([raw]))
            cur.append(e.call(h['current'], (0x70000000, i)))
            check(e.byte(VIEW_BYTE) == raw, 'is current changed the byte')
        check(cur == [1 if CODES[i] == shade_code(raw) else 0 for i in range(5)] + [0], f'shade list byte {raw:#x}: current {cur}')
        for i in range(6):
            e = Emu(new)
            e.mu.mem_write(VIEW_BYTE, bytes([raw]))
            e.call(h['set'], (0x70000000, i))
            want = (raw & ~0x38) | (CODES[i] << 3) if i < 5 else raw
            check(e.byte(VIEW_BYTE) == want, f'shade list set {i} on {raw:#x}: {e.byte(VIEW_BYTE):#x}')
    print(f'  list (record {rec}): title, 5 values, is current / set for every byte')

    check(off.movw_movt(PALETTE_LOOKUP, PALETTE_LOOKUP + 4) == PALETTE, 'official palette lookup')
    table = new.movw_movt(PALETTE_LOOKUP, PALETTE_LOOKUP + 4)
    check(new.u32(PALETTE_LOOKUP + 8) == 0xe7930100, 'palette lookup instruction')
    got = [new.u32(table + 4 * i) for i in range(256)]
    want = [off.u32(PALETTE + 4 * i) for i in range(256)]
    want[0xf0], want[0xf1] = 0xc0000000, 0x40000000
    if FRAMING:
        for i in range(0xe0, 0xe8):
            got[i] = want[i]
    check(got == want, 'palette copy')
    check(want[1] == 0xff000000 and want[16] == 0x80000000, 'palette colours 1 / 16')
    print(f'  palette: lookup reads {table:#x}; 1 {got[1]:#x}, 0xF0 {got[0xf0]:#x}, 16 {got[16]:#x}, 0xF1 {got[0xf1]:#x}')


# --- 4. Grid Style --------------------------------------------------------------------------------
def check_grid(new, off, grid, values=None):
    if values is None:
        values = [s for s in ('g3', 'g4') if grid[s] != CAMERA[s]]
    n = 2 + len(values)
    rn, ro = handlers(list_record(new, 93)), handlers(list_record(off, 93))
    check(struct.unpack_from('<H', list_record(new, 93), 4)[0] == 558, 'Grid Style title')
    check(Emu(new).call(rn['count'], (0x70000000,)) == n, 'Grid Style count')
    for i in range(n + 1):
        out = []
        for img, h in ((new, rn), (off, ro)):
            e = Emu(img)
            e.call(h['draw'], (0x70000000, 0x70700000, i))
            out.append([c for c in e.calls if c[0] == 'list-item'])
        if i < 2:
            check(out[0] == out[1] and len(out[0]) == 1, f'Grid Style draw {i}: {out[0]} vs official {out[1]}')
        elif i < n:
            s = values[i - 2]
            check(out[0] == [('list-item', 0x70700000, I_CUSTOM[s], T_CUSTOM[s])], f'Grid Style draw {i}: {out[0]}')
        else:
            check(out[0] == [], f'Grid Style draw {i}: {out[0]}')
    for style in (0, 1):
        for raw in range(256):
            chosen = bool(raw & 0x40)
            active = chosen and ('g3' if style == 0 else 'g4') in values
            cur = []
            for i in range(n + 1):
                e = Emu(new)
                e.mu.mem_write(VIEW_BYTE, bytes([raw]))
                e.mu.mem_write(STYLE_BYTE, bytes([style]))
                cur.append(e.call(rn['current'], (0x70000000, i)))
            want = [0] * (n + 1)
            if active:
                want[2 + values.index('g3' if style == 0 else 'g4')] = 1
            else:
                want[style] = 1
            check(cur == want, f'Grid Style style {style} byte {raw:#x}: current {cur}, want {want}')
            if raw % 37 == 0 or raw in (0x40, 0xbf):
                for i in range(n + 1):
                    e = Emu(new)
                    e.stubs[GRID_SET_STYLE] = lambda e=e: e.calls.append(('set style', e.mu.reg_read(dm.UC_ARM_REG_R1))) or 0
                    e.mu.mem_write(VIEW_BYTE, bytes([raw]))
                    e.mu.mem_write(STYLE_BYTE, bytes([style]))
                    e.call(rn['set'], (0x70000000, i))
                    sets = [c[1] for c in e.calls if c[0] == 'set style']
                    if i < n:
                        st = i if i < 2 else (0 if values[i - 2] == 'g3' else 1)
                        check(sets == [st], f'Grid Style set {i} (byte {raw:#x}): camera setter {sets}')
                        check(e.byte(VIEW_BYTE) == ((raw | 0x40) if i >= 2 else (raw & ~0x40)), f'Grid Style set {i} on {raw:#x}: {e.byte(VIEW_BYTE):#x}')
                    else:
                        check(sets == [] and e.byte(VIEW_BYTE) == raw, f'Grid Style set {i}: {sets}')
            if raw in (0, 0x40, 0xbf, 0xff):
                icons = []
                for img in (new, off):
                    e = Emu(img)
                    e.mu.mem_write(VIEW_BYTE, bytes([raw]))
                    e.mu.mem_write(STYLE_BYTE, bytes([style]))
                    e.call(GRID_LINE_DRAW, (0x70000000, 0x70700000))
                    icons.append([c[:3] for c in e.calls if c[0] in ('top-icon', 'top-title')])
                want = icons[1] if not active else [('top-icon', 0x70700000, I_CUSTOM['g3' if style == 0 else 'g4'])] + icons[1][1:]
                check(icons[0] == want and len(icons[1]) == 2, f'Grid Style line style {style} byte {raw:#x}: {icons[0]} (official {icons[1]})')
    print(f'  Grid Style: {n} values ({", ".join(values)} custom); draw, is current, set, line icon for both styles and every byte')


# --- 5-6. Texts and icons -------------------------------------------------------------------------
def official_text(img, l, tid):
    """A text of the official image (its own language roots, not the relocated catalog)."""
    rec = img.u32(img.u32(0x55002118 + 4 * l) + 4 * tid)
    units = img.rd(rec, 1)[0]
    return img.rd(img.u32(rec + 4), 2 * units).decode('utf-16le').split('\x00')[0]


def check_ttl(new, off):
    for tid in (135, 137):
        for l in range(21):
            o = official_text(off, l, tid)
            want = o + ('（TTL）' if any('぀' <= ch <= 'ヿ' or '一' <= ch <= '鿿' for ch in o) else ' (TTL)')
            check(dm.text(new, l, tid) == want, f'text {tid} row {l}: {dm.text(new, l, tid)!r}')
    print('  flash modes:', [dm.text(new, l, t) for t in (135, 137) for l in (1, 19)])
    for tid in (134, 136, 132):
        check(all(dm.text(new, l, tid) == official_text(off, l, tid) for l in range(21)), f'text {tid} changed')


def check_assets(new, shade, grid):
    texts = ([T_SHADE] + T_LEVELS if shade else []) + ([T_CUSTOM[s] for s in grid] if grid else [])
    for t in texts:
        check(all(dm.text(new, l, t) for l in range(21)), f'text {t} missing')
    if texts:
        print('  texts:', [dm.text(new, 1, t) for t in texts], [dm.text(new, 19, t) for t in texts])
    if shade:
        check(dm.text(new, 1, T_SHADE) == SHADE_NAMES_EN, 'shade line English name')
    if FRAMING:
        for s in grid or []:
            want = 'Custom Grid ' + ('1' if s == 'g3' else '2')
            check(dm.text(new, 1, T_CUSTOM[s]) == want, f'framing preset name {dm.text(new, 1, T_CUSTOM[s])!r}, want {want!r}')
    icons = [(i, 40, 40) for i in (I_LEVELS if shade else [])] + [(I_CUSTOM[s], 60, 40) for s in (grid or [])]
    for i, w, h in icons:
        d = new.u32(dm.ICON_CATALOG + i * 4)
        check(d != 0 and struct.unpack('<4H', new.rd(d, 8)) == (1, w, h, 0), f'icon {i}')
    for low in (0x5440ddc4, 0x5440dde4):
        w = new.u32(low)
        check((((w >> 4) & 0xf000) | (w & 0xfff)) >= max([i for i, _, _ in icons] or [0]), f'icon bound at {low:#x}')
    if icons:
        print('  icons', [i for i, _, _ in icons])


FRAMING = False


def main():
    global FRAMING
    opts = sys.argv[1:]
    grid = None
    values = None
    if '--framing' in opts:
        spec = opts[opts.index('--framing') + 1]
        values = [v for v in spec.split(',') if v]
        FRAMING = True
        opts = [o for o in opts if o != spec]
    if '--grid' in opts:
        spec = opts[opts.index('--grid') + 1]
        grid = {k: [bool(v) for v in vs] for k, vs in json.loads(spec).items()}
        opts = [o for o in opts if o != spec]
    args = [o for o in opts if not o.startswith('--')]
    new, off = Image(args[0]), Image(args[1])
    shade = '--shade' in opts
    if shade:
        print('1-3. shade')
        check_shade(new, off)
    if grid:
        print('4. Grid Style')
        check_grid(new, off, grid)
    if values is not None:
        print('4. Grid Style (framing guides)')
        check_grid(new, off, None, values)
    if '--ttl' in opts:
        print('5. flash TTL names')
        check_ttl(new, off)
    print('6. texts and icons')
    custom = values if values is not None else [s for s in ('g3', 'g4') if grid and grid[s] != CAMERA[s]]
    check_assets(new, shade, custom)
    if failures:
        print(f'{len(failures)} FAILURES')
        for f in failures[:60]:
            print('  ', f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
