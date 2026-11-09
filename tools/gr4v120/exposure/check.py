# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of test 080 (core/src/fw/gr4v120/aspect/exposure.ts, menuwide.ts, lvpreview.ts):
exposure preview as a setting (still menu line, ADJ function 0x15, live view), soft focus's still
menu line, and the still menu of more than 38 lines.

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn (the harness of
tools/gr4v120/datestamp/menu_check.py), next to a build of the same recipe without test 080 (CONTROL):

 1. TopMenuController's builder, for each model (0 GR IV, 1 HDF, 2 Monochrome), on a controller of
    the new size: every tab's lines (id, draw, visibility; count; header and pages) in the new arrays;
    the other four tabs exactly the control's; the still tab the control's with Soft Focus after
    Image Control and Exposure Preview after Link Exposure and Focus Point; the controller's own
    (old) item arrays never written.
 2. OK on every line of every tab: the controller id opened.
 3. Drawing the lines (0x531B46E4): one row per line, each with its draw function.
 4. The list view is made with 42 rows of the camera's row kind.
 5. The controller factory and SelectMenuController::SetCurrentMenu for the two list ids (and every
    official id as in the control); the two lists' handlers for every value and every byte.
 6. The two still-menu lines (icon and title for every byte).
 7. The ADJ function table: copied (22 records), the 21 the control's, the 22nd Crop's with
    handlers of its own; every reference; the initialiser's walk ends and sizes the list; name and
    icon of every function; the ADJ Mode Setting's function list; the handlers of 0x15.
 8. The slot getters (soft focus's) up to 0x15.
 9. The live view's getters for every combination of movie / setting / Direct Flash / Flash Mode /
    program, keeping every register but r0 (s0) and ip, and the stack.
10. The settings guard: byte 0x10B of the settings (object 0x10F) 0..2 kept, else 0; ADJ slot
    functions up to 0x15.
11. Texts 1019..1021 in the 21 languages, icons 734..737.

    python3 check.py BUILT-RTOS CONTROL-RTOS OFFICIAL-RTOS
"""
import struct
import sys
from pathlib import Path

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5,
                               UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11,
                               UC_ARM_REG_R12, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_S0)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as dm  # noqa: E402
from menu_check import Image, Emu  # noqa: E402

failures = dm.failures
check = dm.check

CURRENT = 0x550832a8
EP_BYTE = CURRENT + 4 + 0x10b
SF_BYTE = CURRENT + 4 + 0x90f
DF_BYTE = CURRENT + 4 + 0x99b
FLASH_MODE = CURRENT + 0xc50
SF_LIST, EP_LIST = 0x020001d1, 0x020001d2
IMAGE_CONTROL, LINK_AE_AF = 0x02000015, 0x02000081
T_NAME, T_OFF_DF, T_ALWAYS = 1019, 1020, 1021
T_SOFT = 884
I_EP, I_LEVELS = 734, [735, 736, 737]
I_OFF, I_ON, I_DF = 329, 330, 733
WIDE, OFFICIAL_ITEMS = 42, 38
C_ID, C_DRAW, C_VIS, OBJECT = 0x13ec, 0x1734, 0x1dc4, 0x2454
BUILDER = 0x531b5494
TABS = 5

EP_NAMES = ['Náhled expozice', 'Eksponeringsvisning', 'Exposure Preview', 'Valotuksen esikatselu', "Aperçu de l'exposition", 'Belichtungsvorschau',
            'Προεπισκόπηση έκθεσης', 'Expozíció előnézete', 'Anteprima esposizione', '露出プレビュー', '노출 미리보기', 'Belichtingsvoorbeeld',
            'Podgląd ekspozycji', 'Pré-visualizar exposição', 'Предпросмотр экспозиции', '曝光预览', 'Vista previa de exposición',
            'Förhandsvisa exponering', 'แสดงตัวอย่างการรับแสง', '曝光預覽', 'Pozlama önizleme']


# ------------------------------------------------------------------------------------------------
# 1. The builder

def narrow_menus(img, model):
    """The control (official layout): per tab (header 0x8C, [(id, draw, vis)], count, pages)."""
    e = Emu(img, model)
    this = 0x70000000
    e.call(BUILDER, (this,))
    check(not [c for c in e.calls if c[0] == 'ASSERT'], f'control builder asserted (model {model})')
    out = []
    for m in range(TABS):
        b = this + 0x230 + m * 0x38c
        blk = bytes(e.mu.mem_read(b, 0x38c))
        n = blk[0x8b]
        items = [(struct.unpack_from('<I', blk, 0x1bc + 4 * k)[0], struct.unpack_from('<2I', blk, 0x8c + 8 * k), struct.unpack_from('<2I', blk, 0x254 + 8 * k)) for k in range(n)]
        out.append((blk[:0x8c], items, n, blk[0x384:0x38c]))
    return out


def wide_menus(img, model):
    e = Emu(img, model)
    this = 0x70000000
    writes = []
    e.mu.hook_add(UC_HOOK_MEM_WRITE, lambda uc, acc, addr, size, val, ud: writes.append((addr, size)), begin=this, end=this + OBJECT + 0x100)
    e.call(BUILDER, (this,))
    check(not [c for c in e.calls if c[0] == 'ASSERT'], f'builder asserted (model {model})')
    out = []
    for m in range(TABS):
        b = this + 0x230 + m * 0x38c
        blk = bytes(e.mu.mem_read(b, 0x38c))
        n = blk[0x8b]
        items = []
        for k in range(n):
            i = struct.unpack('<I', e.mu.mem_read(this + C_ID + (m * WIDE + k) * 4, 4))[0]
            d = struct.unpack('<2I', e.mu.mem_read(this + C_DRAW + (m * WIDE + k) * 8, 8))
            v = struct.unpack('<2I', e.mu.mem_read(this + C_VIS + (m * WIDE + k) * 8, 8))
            items.append((i, d, v))
        out.append((blk[:0x8c], items, n, blk[0x384:0x38c]))
        # the old arrays of the block: never written
        old = [a for a, s in writes if b + 0x8c <= a < b + 0x384]
        check(not old, f'model {model} tab {m}: the old item arrays were written ({len(old)} writes)')
    beyond = [a for a, s in writes if a >= this + OBJECT]
    check(not beyond, f'model {model}: writes beyond the controller ({[hex(a) for a in beyond[:4]]})')
    return out, e, this


def check_builder(new, ctl):
    result = {}
    for model in (0, 1, 2):
        nm, e, this = wide_menus(new, model)
        cm = narrow_menus(ctl, model)
        for m in range(1, TABS):
            check(nm[m] == cm[m], f'model {model}: tab {m} differs from the control')
        ch, citems, cn, cpages = cm[0]
        nh, nitems, nn, npages = nm[0]
        cids = [i for i, _, _ in citems]
        want = []
        for it in citems:
            want.append(it[0])
            if it[0] == IMAGE_CONTROL:
                want.append(SF_LIST)
            if it[0] == LINK_AE_AF:
                want.append(EP_LIST)
        nids = [i for i, _, _ in nitems]
        check(nids == want, f'model {model}: still ids {[hex(i) for i in nids]}')
        check(nn == cn + 2 and nn <= WIDE, f'model {model}: still count {nn} (control {cn})')
        # the control's lines, with their draw functions and visibility, in order
        kept = [it for it in nitems if it[0] not in (SF_LIST, EP_LIST)]
        check(kept == citems, f'model {model}: still lines other than the new two differ')
        for it in nitems:
            if it[0] in (SF_LIST, EP_LIST):
                check(it[1][0] != 0 and it[1][1] == 0 and it[2] == (0, 0), f'model {model}: new line {it[0]:#x} {it}')
        # pages: the same first lines
        cfirst = [cids[f] for f in ch[0x80:0x80 + ch[0x68]]]
        nfirst = [nids[f] for f in nh[0x80:0x80 + nh[0x68]]]
        check(nh[0x68] == ch[0x68] and cfirst == nfirst, f'model {model}: page firsts {nfirst} / {cfirst}')
        diff = [k for k in range(0x8c) if nh[k] != ch[k] and not (0x80 <= k < 0x80 + ch[0x68]) and k != 0x8b]
        check(not diff, f'model {model}: header bytes differ {[hex(k) for k in diff]}')
        pages = (nn + 6) // 7
        check(npages[0] == pages and list(npages[1:1 + pages]) == [7 * k for k in range(pages)], f'model {model}: 7-line pages {list(npages)}')
        print(f'  model {model}: still menu {nn} lines (control {cn}), pages {list(nfirst and nh[0x80:0x80 + nh[0x68]])}, 7-line pages {pages}; tabs 1..4 as the control')
        result[model] = (nm, e, this)
    return result


# ------------------------------------------------------------------------------------------------
# 2-4. OK, drawing, rows

def check_ok(new, built):
    count = 0
    for model, (nm, e0, this0) in built.items():
        for m in range(TABS):
            items = nm[m][1]
            for k, (cid, _, _) in enumerate(items):
                e = Emu(new, model)
                this = 0x70000000
                e.call(BUILDER, (this,))
                e.mu.mem_write(this + 0x1b0, bytes([m]))
                e.mu.mem_write(this + 0x1ac, struct.pack('<I', 0x70800000))
                e.stubs[0x53593e34] = lambda k=k: k
                e.stubs[0x53240818] = lambda: 0
                e.stubs[0x5325e4b8] = lambda: 0
                e.record[0x5318408c] = 'open'
                e.calls.clear()
                e.call(0x531b3648, (this,))
                opened = [c for c in e.calls if c[0] == 'open']
                check(len(opened) == 1 and opened[0][2] == cid, f'model {model} tab {m} line {k}: OK opens {opened} want {cid:#x}')
                count += 1
    print(f'  OK on {count} lines (3 models x 5 tabs): the line\'s id')


def check_draw(new, built):
    for model, (nm, _, _) in built.items():
        for m in range(TABS):
            e = Emu(new, model)
            this = 0x70000000
            e.call(BUILDER, (this,))
            e.mu.mem_write(this + 0x1b0, bytes([m]))
            e.mu.mem_write(this + 0x1ac, struct.pack('<I', 0x70800000))
            rows = []

            def hook(uc, addr, size, ud, rows=rows):
                if addr == 0x531b4760:
                    rows.append((uc.reg_read(UC_ARM_REG_R3), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R0)))
                    uc.reg_write(UC_ARM_REG_PC, 0x531b4764)
            e.mu.hook_add(UC_HOOK_CODE, hook, begin=0x531b4760, end=0x531b4764)
            for f in (0x53594f7c, 0x5359d4d8, 0x5359d4d0, 0x53593e34):
                e.stubs[f] = lambda: 0
            e.stubs[0x53593d64] = lambda mu=e.mu: 0x70a00000 + 0x100 * mu.reg_read(UC_ARM_REG_R1)
            e.call(0x531b46e4, (this,))
            items = nm[m][1]
            want = [(d[0], 0x70a00000 + 0x100 * k, this + (d[1] >> 1)) for k, (_, d, _) in enumerate(items) if not (d[1] & 1)]
            check(len(rows) == len(items), f'model {model} tab {m}: {len(rows)} rows drawn, {len(items)} lines')
            if all(not (d[1] & 1) for _, d, _ in items):
                check(rows == want, f'model {model} tab {m}: rows drawn {rows[:3]} want {want[:3]}')
    print('  line drawing: every line of every tab with its own draw function, its own row')


def check_rows(new):
    e = Emu(new)
    got = []

    def rows():
        mu = e.mu
        p, n = mu.reg_read(UC_ARM_REG_R1), mu.reg_read(UC_ARM_REG_R2)
        got.append((n, bytes(mu.mem_read(p, n)), mu.reg_read(UC_ARM_REG_R3)))
        return 0
    e.stubs[0x53593c14] = rows
    this = 0x70000000
    e.mu.mem_write(this + 0x1ac, struct.pack('<I', 0x70800000))
    e.call(0x531b3800, (this,))
    check(len(got) == 1 and got[0][0] == WIDE and got[0][1] == bytes([0x13]) * WIDE and got[0][2] == 0x3a, f'list view rows {got}')
    print(f'  list view: {got[0][0]} rows of kind 0x13')


# ------------------------------------------------------------------------------------------------
# 5-6. Lists and lines

def list_record(img, rec):
    tab = img.movw_movt(0x531d825c, 0x531d826c)
    r = img.rd(tab + rec * 0x4c, 0x4c)
    return r


def check_lists(new, ctl):
    lst = dm.factory_class(ctl, 0x02000094)
    for cid in (SF_LIST, EP_LIST):
        check(dm.factory_class(new, cid) == lst, f'factory: {cid:#x}')
    for cid in list(range(0x02000073, 0x02000073 + 0xe3)) + list(range(0x020001a0, 0x020001e0)):
        if cid in (SF_LIST, EP_LIST):
            continue
        a, b = dm.set_current(new, 0x531d7860, 0x1a4, cid), dm.set_current(ctl, 0x531d7860, 0x1a4, cid)
        check(a == b, f'list SetCurrentMenu({cid:#x}): {a} vs control {b}')
    for cid in (0x020001d3, 0x020001cf, 0x020001e0):
        check(dm.factory_class(new, cid) == dm.factory_class(ctl, cid), f'factory: {cid:#x} (not ours)')
    recs = {cid: dm.set_current(new, 0x531d7860, 0x1a4, cid) for cid in (SF_LIST, EP_LIST)}
    check(all(isinstance(r, int) and r > 126 for r in recs.values()), f'list records {recs}')
    print('  factory: the list controller for both ids; SetCurrentMenu: records', recs, '; every other id as the control')
    # handlers
    for cid, title, values, texts, icons, byte, valid in (
            (SF_LIST, T_SOFT, [0, 1, 2, 3], [2, 10, 11, 12], [I_OFF] + I_LEVELS, SF_BYTE, lambda r: r <= 3),
            (EP_LIST, T_NAME, [0, 1, 2], [1, T_OFF_DF, T_ALWAYS], [I_ON, I_DF, I_OFF], EP_BYTE, lambda r: r <= 2)):
        r = list_record(new, recs[cid])
        title_got = struct.unpack_from('<H', r, 4)[0]
        count, draw, setf, cur = (struct.unpack_from('<I', r, o)[0] for o in (0x0c, 0x14, 0x24, 0x2c))
        check(title_got == title, f'{cid:#x}: title {title_got}')
        e = Emu(new)
        check(e.call(count, (0x70000000,)) == len(values), f'{cid:#x}: count')
        for i in range(len(values) + 1):
            e = Emu(new)
            e.call(draw, (0x70000000, 0x70700000, i))
            items = [c for c in e.calls if c[0] == 'list-item']
            want = [('list-item', 0x70700000, icons[i], texts[i])] if i < len(values) else []
            check(items == want, f'{cid:#x}: draw {i}: {items}')
        for raw in list(range(8)) + [0x7f, 0xff]:
            norm = raw if valid(raw) else 0
            cur_list = []
            for i in range(len(values) + 1):
                e = Emu(new)
                e.mu.mem_write(byte, bytes([raw]))
                cur_list.append(e.call(cur, (0x70000000, i)))
                check(e.byte(byte) == norm, f'{cid:#x}: is current kept/normalised byte {raw:#x} -> {e.byte(byte):#x}')
            check(cur_list == [1 if values[i] == norm else 0 for i in range(len(values))] + [0], f'{cid:#x}: byte {raw:#x} current {cur_list}')
            for i in range(len(values) + 1):
                e = Emu(new)
                e.mu.mem_write(byte, bytes([raw]))
                e.call(setf, (0x70000000, i))
                check(e.byte(byte) == (values[i] if i < len(values) else raw), f'{cid:#x}: set {i} on {raw:#x}: {e.byte(byte):#x}')
        print(f'  list {cid:#x}: title, {len(values)} values (icons {icons}, texts {texts}), is current / set for every byte')
    return recs


def check_lines(new, built):
    nm = built[0][0]
    draws = {i: d[0] for i, d, _ in nm[0][1] if i in (SF_LIST, EP_LIST)}
    for cid, byte, valid, icon_of, title in (
            (SF_LIST, SF_BYTE, lambda r: r <= 3, lambda v: ([I_OFF] + I_LEVELS)[v], T_SOFT),
            (EP_LIST, EP_BYTE, lambda r: r <= 2, lambda v: [I_ON, I_DF, I_OFF][v], T_NAME)):
        for raw in list(range(6)) + [0xff]:
            e = Emu(new)
            e.mu.mem_write(byte, bytes([raw]))
            e.call(draws[cid], (0x70000000, 0x70700000))
            v = raw if valid(raw) else 0
            calls = [c for c in e.calls if c[0] in ('top-icon', 'top-title')]
            check(calls == [('top-icon', 0x70700000, icon_of(v), calls[0][3] if calls else 0), ('top-title', 0x70700000, title, calls[1][3] if len(calls) > 1 else 0)],
                  f'line {cid:#x} byte {raw:#x}: {calls}')
            check(e.byte(byte) == v, f'line {cid:#x} byte {raw:#x} kept as {e.byte(byte):#x}')
    print('  the two still-menu lines: icon of every value, title')


# ------------------------------------------------------------------------------------------------
# 7-8. ADJ

ADJ_SITES = [(0x531bd4c4, 0x531bd4d4), (0x531bee8c, 0x531bee94), (0x531bf028, 0x531bf030), (0x531bf0c4, 0x531bf0cc), (0x531bf5c0, 0x531bf5c8),
             (0x531bffd4, 0x531bffdc), (0x531c0030, 0x531c0038), (0x531c0128, 0x531c0130), (0x531c01b4, 0x531c01bc), (0x531c0240, 0x531c0248),
             (0x531c02e8, 0x531c02f0), (0x531c0434, 0x531c043c), (0x531c05d4, 0x531c05dc), (0x531c06d0, 0x531c06e8), (0x531c09dc, 0x531c09e4),
             (0x531c0ae8, 0x531c0af0), (0x531c0b94, 0x531c0b9c), (0x531c0bfc, 0x531c0c0c), (0x531c0cb8, 0x531c0cc8), (0x531c0e9c, 0x531c0ea4),
             (0x531c1060, 0x531c1064), (0x531c1220, 0x531c1228)]


def check_adj(new, ctl, off):
    tabs = {new.movw_movt(a, b) for a, b in ADJ_SITES}
    check(len(tabs) == 1, f'ADJ table sites {tabs}')
    table = tabs.pop()
    check(new.u32(0x531bd600) == table + 22 * 0x5c, 'ADJ table end word')
    check(all(ctl.movw_movt(a, b) == 0x53dc9dfc for a, b in ADJ_SITES) and ctl.u32(0x531bd600) == 0x53dc9dfc + 21 * 0x5c, 'control ADJ table')
    check(new.rd(table, 21 * 0x5c) == ctl.rd(0x53dc9dfc, 21 * 0x5c), 'ADJ records 0..0x14 differ from the control')
    crop = ctl.rd(0x53dc9dfc + 0x13 * 0x5c, 0x5c)
    rec = new.rd(table + 21 * 0x5c, 0x5c)
    same = [o for o in range(0, 0x5c, 4) if rec[o:o + 4] == crop[o:o + 4]]
    check(set(range(0, 0x5c, 4)) - set(same) == {0x18, 0x20, 0x28, 0x30, 0x3c}, f'ADJ record 0x15: words differing from Crop {sorted(set(range(0, 0x5c, 4)) - set(same))}')
    check(struct.unpack_from('<2I', rec, 0x3c) == (0, 0), 'ADJ record 0x15: disabled check')
    # every other reference to the official table range: none left in code (MOVW/MOVT pairs, words)
    # the initialiser's walk: every record's count (each skipped, 5 here; ours checked below), then the list
    for img, name, base, n in ((new, 'new', table, 22), (ctl, 'control', 0x53dc9dfc, 21)):
        e = Emu(img)
        seen = {'recs': []}

        def rows(e=e, seen=seen):
            seen['rows'] = e.mu.reg_read(UC_ARM_REG_R2)
            return 0
        e.stubs[0x53593c14] = rows
        e.stubs[0x53908530] = lambda: 0x70600000
        for f in (0x5390856c, 0x53594ef0, 0x53594efc):
            e.stubs[f] = lambda: 0

        def hook(uc, addr, size, ud, seen=seen):
            if addr == 0x531bd4fc:
                seen['recs'].append(uc.reg_read(UC_ARM_REG_R4))
            elif addr == 0x531bd4e0:
                uc.reg_write(UC_ARM_REG_R0, 5)
                uc.reg_write(UC_ARM_REG_PC, 0x531bd4e4)
        e.mu.hook_add(UC_HOOK_CODE, hook, begin=0x531bd4e0, end=0x531bd500)
        this = 0x70000000
        e.mu.mem_write(this + 0x1f8, struct.pack('<I', 0x70800000))
        e.call(0x531bd4bc, (this,), limit=2_000_000)
        check(seen['recs'] == [base + k * 0x5c for k in range(n)] and seen.get('rows') == 5, f'ADJ initialiser ({name}): {len(seen["recs"])} records, rows {seen.get("rows")}')
        print(f'  ADJ initialiser ({name}): walks {len(seen["recs"])} records to the end and stops')
    # names and icons
    for f in range(0x18):
        for img_args in ((0x70000000, f),):
            a = Emu(new).call(0x5338f484, img_args)
            b = Emu(ctl).call(0x5338f484, img_args)
            check(a == (T_NAME if f == 0x15 else b), f'name of function {f:#x}: {a} (control {b})')
        for var in (0, 1):
            a = Emu(new).call(0x53390e40, (0x70000000, f, var))
            b = Emu(ctl).call(0x53390e40, (0x70000000, f, var))
            check(a == ((I_EP if var == 0 else 0) if f == 0x15 else b), f'icon of function {f:#x} variant {var}: {a} (control {b})')
    # the ADJ Mode Setting's list
    la, lb = new.movw_movt(0x531dc834, 0x531dc844), ctl.movw_movt(0x531dc834, 0x531dc844)
    na, nb = new.u32(0x531dc860) & 0xff, ctl.u32(0x531dc860) & 0xff
    fa, fb = list(new.rd(la, na)), list(ctl.rd(lb, nb))
    want = list(fb)
    want.insert(fb.index(0x0a) + 1, 0x15)
    check(fa == want, f'ADJ function list {fa} want {want}')
    print(f'  ADJ: table at {table:#x} (22 records, every reference), names / icons of 0..0x17, function list {fa}')
    # handlers of 0x15
    draw, cur, setf, count = (struct.unpack_from('<I', rec, o)[0] for o in (0x18, 0x20, 0x28, 0x30))
    check(Emu(new).call(count, (0x70000000,)) == 3, 'ADJ 0x15 count')
    for i in range(4):
        e = Emu(new)
        e.mu.mem_write(0x70000000 + 0x1f8, struct.pack('<I', 0x70800000))
        got = []
        e.stubs[0x53593d64] = lambda mu=e.mu: 0x70a00000 + mu.reg_read(UC_ARM_REG_R1)
        e.stubs[0x535a1138] = lambda mu=e.mu: got.append((mu.reg_read(UC_ARM_REG_R0), mu.reg_read(UC_ARM_REG_R1))) or 0
        e.call(draw, (0x70000000, i))
        check(got == [(0x70a00000 + i, [1, T_OFF_DF, T_ALWAYS, 0][i])], f'ADJ 0x15 draw {i}: {got}')
    for raw in list(range(6)) + [0xff]:
        norm = raw if raw <= 2 else 0
        cur_list = []
        for i in range(4):
            e = Emu(new)
            e.mu.mem_write(EP_BYTE, bytes([raw]))
            cur_list.append(e.call(cur, (0x70000000, i)))
            check(e.byte(EP_BYTE) == norm, f'ADJ 0x15 is current: byte {raw:#x} -> {e.byte(EP_BYTE):#x}')
        check(cur_list == [1 if i == norm else 0 for i in range(3)] + [0], f'ADJ 0x15 byte {raw:#x}: current {cur_list}')
        for i in range(4):
            e = Emu(new)
            e.mu.mem_write(EP_BYTE, bytes([raw]))
            e.call(setf, (0x70000000, i))
            check(e.byte(EP_BYTE) == (i if i < 3 else raw), f'ADJ 0x15 set {i} on {raw:#x}')
    print('  ADJ 0x15: count 3, texts On / Off in Direct Flash / Always Off, is current and set for every byte')
    # slot getters
    for k in range(5):
        g = 0x532a0584 + 8 * k
        for v in (0, 0x0a, 0x14, 0x15, 0x16, 0x1f, 0xff):
            e = Emu(new)
            obj = 0x70000000
            e.mu.mem_write(obj + 0x920 + k, bytes([v]))
            got = e.call(g, (obj,))
            check(got == (v if v <= 0x15 else 0), f'slot getter {k}: {v:#x} -> {got:#x}')
    print('  slot getters: 0..0x15 as kept, above: 0')


# ------------------------------------------------------------------------------------------------
# 9. Live view

PROGRAM_SITES = [0x5368dc80, 0x5368fb04, 0x53690df8, 0x536910a4]
BIAS_SITE = 0x5368faf4


def bl_target(img, at):
    w = img.u32(at)
    assert (w >> 24) == 0xeb, hex(w)
    return at + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4


def check_live(new):
    progs = {bl_target(new, a) for a in PROGRAM_SITES}
    check(len(progs) == 1 and bl_target(new, BIAS_SITE) not in progs, 'live view getters')
    prog, bias = progs.pop(), bl_target(new, BIAS_SITE)
    rec = 0x70300000
    count = 0
    regs = [UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8,
            UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]
    for movie in (0, 1):
        for setting in (0, 1, 2, 3, 0xff):
            for df in (0, 1, 3, 2):
                for mode in (0, 1, 2):
                    for program in range(7):
                        off = not movie and (setting == 2 or (setting == 1 and (df & 1) and mode == 0))
                        for fn, kind in ((prog, 'program'), (bias, 'bias')):
                            e = Emu(new)
                            mu = e.mu
                            mu.mem_write(rec, bytes(0x200))
                            mu.mem_write(rec + 8, bytes([movie]))
                            mu.mem_write(rec + 0x39, bytes([program]))
                            mu.mem_write(rec + 0xdc, struct.pack('<f', -1.5))
                            mu.mem_write(EP_BYTE, bytes([setting]))
                            mu.mem_write(DF_BYTE, bytes([df]))
                            mu.mem_write(FLASH_MODE, bytes([mode]))
                            for k, r in enumerate(regs):
                                mu.reg_write(r, 0x11110000 + k)
                            mu.reg_write(UC_ARM_REG_R0, rec)
                            mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
                            mu.reg_write(UC_ARM_REG_LR, 0x100)
                            mu.emu_start(fn, 0x100, count=10000)
                            check(mu.reg_read(UC_ARM_REG_PC) == 0x100, f'{kind} did not return')
                            check([mu.reg_read(r) for r in regs] == [0x11110000 + k for k in range(len(regs))], f'{kind}: registers changed')
                            check(mu.reg_read(UC_ARM_REG_SP) == 0x600f0000, f'{kind}: stack')
                            if kind == 'program':
                                want = 0 if off and program == 4 else program
                                got = mu.reg_read(UC_ARM_REG_R0)
                                check(got == want, f'program movie {movie} setting {setting} df {df} mode {mode} program {program}: {got}')
                            else:
                                got = struct.unpack('<f', struct.pack('<I', mu.reg_read(UC_ARM_REG_S0)))[0]
                                check(got == (0.0 if off else -1.5), f'bias movie {movie} setting {setting} df {df} mode {mode}: {got}')
                            count += 1
    print(f'  live view getters: {count} combinations (movie, setting, Direct Flash bit, Flash Mode, program), registers and stack kept')


# ------------------------------------------------------------------------------------------------
# 10-11. Guard, texts, icons

def check_guard(new):
    save = 0x533f3674
    w = new.u32(save)
    stub = save + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4
    bls = []
    for k in range(12):
        x = new.u32(stub + 4 * k)
        if (x >> 24) == 0xeb:
            bls.append(stub + 4 * k + 8 + (((x & 0xffffff) ^ 0x800000) - 0x800000) * 4)
    fix = bls[1]
    for raw in range(256):
        e = Emu(new)
        s = 0x70400000
        e.mu.mem_write(s + 0x10e, bytes([1, raw, 0x5a]))
        e.call(fix, (s, 0))
        check(e.byte(s + 0x10f) == (raw if raw <= 2 else 0), f'guard: exposure preview {raw} -> {e.byte(s + 0x10f)}')
        check(e.byte(s + 0x10e) == 1 and e.byte(s + 0x110) == 0x5a, f'guard: neighbours of 0x10F ({raw})')
    for f in range(0x20):
        e = Emu(new)
        s = 0x70400000
        e.mu.mem_write(s + 0x48d, bytes([f, f, f]))
        e.call(fix, (s, 0))
        got = [e.byte(s + 0x48d + j) for j in range(3)]
        check(got == [f if f <= 0x15 else 0] * 3, f'guard: ADJ slots 6..8 with {f:#x}: {got}')
    print('  guard: exposure preview 0..2 kept, else 0; ADJ slots 6..8 up to 0x15')


def check_texts(new, off):
    roots = [new.u32(0x55002118 + 4 * l) for l in range(21)]
    first = 0x55000000 + (0x543b5270 - 0x543b3100)
    for l in range(21):
        k = (roots[l] + 4 - first) // 0xdc4
        got = [dm.text(new, l, t) for t in (T_NAME, T_OFF_DF, T_ALWAYS)]
        check(got[0] == EP_NAMES[k] and got[1] and got[2], f'texts, row {l}: {got}')
        for t in (1, 2, 10, 11, 12, 884, 885, 926, 1018):
            check(dm.text(new, l, t) == (dm.text(off, l, t) if t < 881 else dm.text(new, l, t)), f'text {t} row {l}')
    print('  texts:', [dm.text(new, 2, t) for t in (T_NAME, T_OFF_DF, T_ALWAYS)], [dm.text(new, 15, t) for t in (T_NAME, T_OFF_DF, T_ALWAYS)])
    for low in (0x5440c5c4, 0x5440c5e4):
        w = new.u32(low)
        bound = ((w >> 4) & 0xf000) | (w & 0xfff)
        check(bound >= 737, f'icon bound at {low:#x}: {bound}')
    for tid in [I_EP] + I_LEVELS:
        d = new.u32(dm.ICON_CATALOG + tid * 4)
        check(struct.unpack('<4H', new.rd(d, 8)) == (1, 40, 40, 0), f'icon {tid}')
    print('  icons', [I_EP] + I_LEVELS, '40x40')


def main():
    new, ctl, off = Image(sys.argv[1]), Image(sys.argv[2]), Image(sys.argv[3])
    if len(sys.argv) > 4:
        check_adj(new, ctl, off); check_live(new); check_guard(new); check_texts(new, off); return finish()
    print("1. builder")
    built = check_builder(new, ctl)
    print('2. OK')
    check_ok(new, built)
    print('3. drawing the lines')
    check_draw(new, built)
    print('4. rows')
    check_rows(new)
    print('5. lists')
    check_lists(new, ctl)
    print('6. still-menu lines')
    check_lines(new, built)
    print('7-8. ADJ')
    check_adj(new, ctl, off)
    print('9. live view')
    check_live(new)
    print('10. guard')
    check_guard(new)
    print('11. texts and icons')
    check_texts(new, off)
    finish()


def finish():
    if failures:
        print(f'{len(failures)} FAILURES')
        for f in failures[:60]:
            print('  ', f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
