# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of a still menu of 43..49 lines (core/src/fw/gr4v120/aspect/menuwide.ts, 0.9.7: the wide
layout with room for 49 lines a tab, used when Handheld Night's line comes besides the six other added lines).
NOT part of the program.

    python3 tools/menuwide/check.py 1.20|1.21 NEW-RTOS CONTROL-RTOS OFFICIAL-RTOS

NEW-RTOS: a build with every addition that adds a still-menu line (HDR, Soft Focus, Exposure Preview, the live-view
shade, Constant Light, the date imprint) and Handheld Night: 43 lines on every model. CONTROL-RTOS: the same recipe
without Handheld Night (42 lines, the layout for 42 as before 0.9.7). The camera's own functions run, as patched, in
Unicorn (the harness of tools/gr4v12x/datestamp/menu_check.py and the steps of tools/gr4v12x/exposure/check.py).
A line's draw function is compared between the two builds as it is when it is the camera's own, and as "appended"
when it is one of GR Mod's (those are at other addresses in the two builds).

 0. Static: the layout each image was built for (the OK site's line count; the controller's size, the rows).
 1. TopMenuController's builder for each model (0 GR IV, 1 HDF, 2 Monochrome) on a controller of the new size: no
    write beyond it, the official item arrays never written; tabs 1..4 exactly the control's (lines, header, 7-line
    pages); the still tab the control's lines, in order, with Handheld Night's once, after Color Space or after the
    HDR line; the titled pages start at the same lines; seven 7-line pages (0, 7, ... 42) and the next tab's first
    two words after them as the control has them.
 2. OK on every line of every tab: the line's controller id.
 3. Drawing the lines: one row per line, each with its draw function.
 4. The list view is made with 49 rows of the camera's row kind.
 5. The page marks (0x531B449C) for every page being the current one: the first seven mark views shown, the current
    one with the current mark's picture, the other four hidden.
 6. The page of a line (0x531B4614) for every line: line / 7; next and previous page (0x531B4C00, 0x531B4D94) from
    every page: the neighbour, the last one reachable.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

from unicorn import UC_HOOK_MEM_WRITE

ROOT = Path(__file__).resolve().parents[2]
version, new_path, ctl_path, off_path = sys.argv[1:5]
DIR = {'1.20': 'gr4v120', '1.21': 'gr4v121'}[version]
MAP = {int(k, 16): int(v['new'], 16) for k, v in json.load(open(ROOT / 'tools/port/gr4-121-map.json'))['addresses'].items()} if version == '1.21' else None


def A(a):
    """An address of 1.20 in this release."""
    return a if MAP is None else MAP[a]


sys.path.insert(0, str(ROOT / 'tools' / DIR / 'datestamp'))
spec = importlib.util.spec_from_file_location('exposure_check', ROOT / 'tools' / DIR / 'exposure' / 'check.py')
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)
Image, Emu, check, failures = ex.Image, ex.Emu, ex.check, ex.failures

TABS, OBJECT = 5, 0x13ec
NIGHT, COLOR_SPACE, HDR = 0x020001d5, 0x0200008d, 0x020001d0
OK_SITE, ALLOC, ROWS_COUNT = A(0x531b3664), A(0x53188530), A(0x531b3860)
PAGE_MARKS, SET_PICTURE, SET_VISIBLE = A(0x531b449c), A(0x5359a104), A(0x535acd84)
LIST_ROWS = A(0x53593c14)


def tmc(a):
    """A function of TopMenuController's file, by its distance from the page marks' (first word checked in `same_code`)."""
    return PAGE_MARKS + (a - 0x531b449c)


def lv(a):
    """A function of the list view's file, by its distance from its row maker."""
    return LIST_ROWS + (a - 0x53593c14)


PAGE_OF_LINE, NEXT_PAGE, PREV_PAGE = tmc(0x531b4614), tmc(0x531b4c00), tmc(0x531b4d90)
REDRAW, LIST_SYNC, LIST_TAIL, TO_PAGE = tmc(0x531b4534), tmc(0x531b3f84), tmc(0x531b4684), tmc(0x531b4b44)
ROW_OF_LINE, LIST_SCROLL = lv(0x53593df8), lv(0x53594844)
# first words (position independent) of the functions reached by distance
FIRST_WORDS = ((PAGE_OF_LINE, 0xe92d4030), (NEXT_PAGE, 0xe1a0c00d), (PREV_PAGE, 0xe5d021b0), (REDRAW, 0xe1a0c00d), (LIST_SYNC, 0xe1a0c00d),
               (LIST_TAIL, 0xe1a0c00d), (TO_PAGE, 0xe5d031b0), (ROW_OF_LINE, 0xe5900120), (LIST_SCROLL, 0xe1a0c00d))


def layout(img):
    """The lines a tab the image was built for, read from the OK site (`mov r3, #n`); checked against the rest."""
    w = img.u32(OK_SITE)
    check(w & 0xffffff00 == 0xe3a03000, f'OK site: {w:#x}')
    n = w & 0xff
    size = OBJECT + TABS * n * 20
    a = img.u32(ALLOC)
    check(a & 0xfff0f000 == 0xe3000000 and (((a >> 4) & 0xf000) | (a & 0xfff)) == size, f'controller size: {a:#x}, want {size:#x}')
    return n


def use(n):
    """Point the shared steps at the layout for n lines a tab."""
    ex.WIDE = n
    ex.C_ID = OBJECT
    ex.C_DRAW = ex.C_ID + TABS * n * 4
    ex.C_VIS = ex.C_DRAW + TABS * n * 8
    ex.OBJECT = ex.C_VIS + TABS * n * 8


def same_code(new, ctl):
    """The official functions the checks reach by distance are where they are expected (first words, not patched)."""
    for at, word in FIRST_WORDS:
        check(new.u32(at) == word and ctl.u32(at) == word, f'function expected at {at:#x}: {new.u32(at):#x}')


def plain(tab, end):
    """A tab as `wide_menus` gives it, GR Mod's own draw functions (appended, at or after `end`) named 'appended'."""
    head, items, n, pages = tab
    return head, [(i, ('appended', d[1]) if d[0] >= end else d, v) for i, d, v in items], n, pages


def check_builder(new, ctl, n_new, n_ctl, end):
    built = {}
    for model in (0, 1, 2):
        use(n_ctl)
        cm, _, _ = ex.wide_menus(ctl, model)
        use(n_new)
        nm, e, this = ex.wide_menus(new, model)
        for m in range(1, TABS):
            check(plain(nm[m], end) == plain(cm[m], end), f'model {model}: tab {m} differs from the control')
            check(all(d[0] != 0 for _, d, _ in nm[m][1]), f'model {model}: tab {m} has a line without a draw function')
        ch, citems, cn, cpages = plain(cm[0], end)
        nh, nitems, nn, npages = plain(nm[0], end)
        cids = [i for i, _, _ in citems]
        nids = [i for i, _, _ in nitems]
        after = HDR if HDR in cids else COLOR_SPACE
        want = []
        for i in cids:
            want.append(i)
            if i == after:
                want.append(NIGHT)
        check(cids.count(after) == 1 and nids == want, f'model {model}: still ids {[hex(i) for i in nids]}')
        check(nn == cn + 1 and cn == 42 and nn <= n_new, f'model {model}: still count {nn} (control {cn})')
        check([it for it in nitems if it[0] != NIGHT] == citems, f'model {model}: still lines other than Handheld Night differ')
        night = [it for it in nitems if it[0] == NIGHT]
        check(len(night) == 1 and night[0][1] == ('appended', 0) and night[0][2] == (0, 0), f'model {model}: Handheld Night line {night}')
        cfirst = [cids[f] for f in ch[0x80:0x80 + ch[0x68]]]
        nfirst = [nids[f] for f in nh[0x80:0x80 + nh[0x68]]]
        check(nh[0x68] == ch[0x68] and cfirst == nfirst, f'model {model}: titled pages start at {nfirst} / {cfirst}')
        diff = [k for k in range(0x8c) if nh[k] != ch[k] and not (0x80 <= k < 0x80 + ch[0x68]) and k != 0x8b]
        check(not diff, f'model {model}: header bytes differ {[hex(k) for k in diff]}')
        check(list(npages) == [7, 0, 7, 14, 21, 28, 35, 42], f'model {model}: 7-line pages {list(npages)}')
        check(list(cpages) == [6, 0, 7, 14, 21, 28, 35, 0], f'model {model}: control\'s 7-line pages {list(cpages)}')
        # what follows the page bytes: the next tab's block (its first two words are the descriptor's)
        check(nm[1][0][:8] == cm[1][0][:8], f'model {model}: the movie tab\'s first words')
        print(f'  model {model}: still menu {nn} lines (control {cn}), Handheld Night after {after:#x}; titled pages at {list(nh[0x80:0x80 + nh[0x68]])}; '
              f'7-line pages {list(npages[1:1 + npages[0]])}; tabs 1..4 as the control')
        built[model] = (nm, e, this)
    return built


def controller(img, model, tab, page):
    e = Emu(img, model)
    this = 0x70000000
    e.call(ex.BUILDER, (this,))
    e.mu.mem_write(this + 0x1b0, bytes([tab]))
    e.mu.mem_write(this + 0x1b4 + 12 * tab, bytes([page]))
    return e, this


def check_marks(new):
    views = [0x70900000 + 0x100 * k for k in range(11)]
    for page in range(7):
        e, this = controller(new, 1, 0, page)
        table = new.movw_movt(PAGE_MARKS + 0x1c, PAGE_MARKS + 0x34)
        idx = list(new.rd(table, 11))
        for k, v in enumerate(views):
            e.mu.mem_write(this + (idx[k] + 0x56) * 4, struct.pack('<I', v))
        e.mu.mem_write(this + 0x1f0, bytes([0]))
        e.record[SET_PICTURE] = 'picture'
        e.record[SET_VISIBLE] = 'visible'
        e.calls.clear()
        e.call(PAGE_MARKS, (this,))
        shown = [(c[1], c[2]) for c in e.calls if c[0] == 'visible']
        pics = {c[1]: c[2] for c in e.calls if c[0] == 'picture'}
        check(shown == [(v, 1 if k < 7 else 0) for k, v in enumerate(views)], f'page marks, page {page}: shown {shown}')
        check(sorted(pics) == views[:7] and all(pics[v] == (0x1ef if k == page else 0x1f0) for k, v in enumerate(views[:7])), f'page marks, page {page}: pictures {pics}')
    print('  page marks: seven shown, the current page\'s with its own picture, four hidden (every page as the current one)')


def check_paging(new, lines):
    for line in range(lines):
        e, this = controller(new, 1, 0, 0)
        e.stubs[REDRAW] = lambda: 0
        e.call(PAGE_OF_LINE, (this, line))
        check(e.byte(this + 0x1b4) == line // 7, f'page of line {line}: {e.byte(this + 0x1b4)}')
    for fn, name, step in ((NEXT_PAGE, 'next', 1), (PREV_PAGE, 'previous', -1)):
        for page in range(7):
            e, this = controller(new, 1, 0, page)
            for f in (REDRAW, LIST_SYNC, LIST_TAIL, LIST_SCROLL):
                e.stubs[f] = lambda: 0
            e.record[ROW_OF_LINE] = 'row'
            e.mu.mem_write(this + 0x1ac, struct.pack('<I', 0x70800000))
            e.calls.clear()
            e.call(fn, (this, 0))
            to = (page + step) % 7
            check(e.byte(this + 0x1b4) == to, f'{name} page from {page}: {e.byte(this + 0x1b4)}')
            rows = [c for c in e.calls if c[0] == 'row']
            check(len(rows) == 1 and rows[0][1] == 0x70800000 and rows[0][2] == 7 * to, f'{name} page from {page}: the list goes to {rows}')
    print(f'  the page of each of the {lines} lines; next / previous page from every page, round the seven, the list at the page\'s first line')


def main():
    new, ctl = Image(new_path), Image(ctl_path)
    end = 0x53000000 + len(open(off_path, 'rb').read())
    n_new, n_ctl = layout(new), layout(ctl)
    check(n_new == 49 and n_ctl == 42, f'layouts: {n_new} lines a tab, control {n_ctl}')
    for img, n in ((new, n_new), (ctl, n_ctl)):
        check(img.u32(ROWS_COUNT) == 0xe3a02026, 'rows: the official count is still there (the call is redirected)')
    same_code(new, ctl)
    print(f'layout: {n_new} lines a tab (control {n_ctl})')
    print('1. builder')
    built = check_builder(new, ctl, n_new, n_ctl, end)
    use(n_new)
    print('2. OK')
    ex.check_ok(new, built)
    print('3. drawing')
    ex.check_draw(new, built)
    print('4. rows')
    ex.check_rows(new)
    print('5. page marks')
    check_marks(new)
    print('6. pages')
    check_paging(new, built[1][0][0][2])
    if failures:
        print(f'{len(failures)} FAILED')
        for f in failures[:40]:
            print('  FAIL', f)
        sys.exit(1)
    print('ok')


main()
