# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of GR III / IIIx added still-menu lines and the wide menus (core/src/fw/gr3x/menu-lines.ts),
with soft focus as their first user (extras' softFocusMenu).

    python3 tools/gr3extras/menu_check.py RELEASE OFFICIAL.rtos BUILT.rtos [WITHOUT.rtos]

RELEASE is 2.10, 2.20 or 2.21 (GR IIIx 1.60 / 1.70 / 1.71 are the same programs). BUILT has `adjSoftFocus` and
`softFocusMenu` (with `dateStamp` the still menu has 39 lines and the wide layout is in use; without it, 38 and the
official layout). WITHOUT is the same build without `softFocusMenu`: inside the official image the two then differ
only by the menu hooks listed below (and by where appended code now is). Development tool, not part of the program.

Runs the camera's own TopMenuController code in Unicorn, in the official image and in the built one, for both
models (0: GR III with ND filter, 1: HDF):
  - the menu builder (0x5319a778) on a fresh controller, the visibility of items answered as the camera would for
    the model (ND / HDF lines) and as "shown" for all others, in both images alike;
  - for every tab: the lines it keeps (count, page firsts, controller ids, draw member pointers): the built menu's
    are the official ones in the official order, plus in the still tab the soft focus line right after Image
    Control and the date imprint's at the end;
  - OK on every line of every tab (0x53198b38): the controller id it opens is the line's;
  - the line drawing (0x53199ba4) of every tab: the row count given to the list view and the draw member called
    for each row are the builder's, in order;
  - the list view's row creation (the call at 0x53198d6c): row count and kinds;
  - the soft focus list as the camera reaches it: SetCurrentMenu maps its id to its list record, the factory and
    the key map give Horizon Correction's controller; the record's count, draw, set and is-current, and the
    line's draw, for every value of the settings byte (0..3, 4, 0xff) and with no record (pointer 0): the line
    shows the value's icon and the ADJ function's name, the list draws Off / Low / Medium / High with their icons,
    set writes byte 0x9a1 of the record and nothing else, exactly one value is current (a value above 3 counts as
    Off and is set back to 0, nothing else written); callee-saved registers and the stack as they were.
"""
import os, re, struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import *

BASE = 0x53000000
HERE = os.path.dirname(os.path.abspath(__file__))
RAMSPEC = {'2.10': (0x5407b540, 0x3a080), '2.20': (0x5407b640, 0x3a0c0), '2.21': (0x54084640, 0x3a300)}
TABLES = {'2.20': 'core/src/fw/gr3x170/addresses.ts', '2.21': 'core/src/fw/gr3x171/addresses.ts'}
rel, official_path, built_path = sys.argv[1:4]
without_path = sys.argv[4] if len(sys.argv) > 4 else None
OFF = open(official_path, 'rb').read(); IMG = open(built_path, 'rb').read()
amap = {}
if rel != '2.10':
    src = open(os.path.join(HERE, '..', '..', TABLES[rel])).read()
    amap = {int(a, 16): int(b, 16) for a, b in re.findall(r'\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]', src)}
def A(x): return x if rel == '2.10' else amap[x]
def w32(img, a): return struct.unpack_from('<I', img, a - BASE)[0]
def bl_target(img, at):
    w = w32(img, at); assert (w >> 24) & 0xe == 0xa, hex(at)
    d = w & 0xffffff; d = d - (1 << 24) if d & 0x800000 else d
    return at + 8 + 4 * d
def movw_imm(w): return ((w >> 4) & 0xf000) | (w & 0xfff)

BUILDER = A(0x5319a778); MENU_TABLE = A(0x55001eb8)
OK = A(0x53198b54) - 0x1c; DRAW = A(0x53199ba4); ROWS_CALL = A(0x53198d6c); LIST_ROWS = A(0x53394610)
APP, SPEC_MODEL, MODEL_NUMBER = A(0x5320ad88), A(0x5320c09c), A(0x532dbee8)
ND_VIS, HDF_VIS = A(0x531966e4), A(0x53196708)
LINE_VALUE_ICON, TOP_SET_TITLE, LIST_SET_ITEM = A(0x5339de20), A(0x5339dc70), A(0x5339e8b0)
SET_CURRENT = A(0x531b9640); FACTORY = A(0x5316f3b8); KEY_MAP_READ = A(0x53221a4c)
SELECT_SITE = (A(0x531b9fdc), A(0x531b9fe8))
SETTINGS = A(0x55063f34); ALLOC = A(0x5316fcec)
NAME_R10 = A(0x53292900)
DISPATCH = bl_target(OFF, BUILDER + 0x200); PAGE_BLX = BUILDER + 0x168
assert w32(OFF, PAGE_BLX) == 0xe12fff33 and w32(OFF, OK) == 0xe1a0c00d and w32(OFF, DRAW) == 0xe1a0c00d
CURSOR = bl_target(OFF, OK + 0x18); OK_CALLS = [bl_target(OFF, OK + 0x34), bl_target(OFF, OK + 0x38), bl_target(OFF, OK + 0x3c)]
OK_TAIL = bl_target(OFF, OK + 0x54)
DRAW_COUNT = bl_target(OFF, DRAW + 0x2c); DRAW_STATE = bl_target(OFF, DRAW + 0x4c); LIST_ITEM = bl_target(OFF, DRAW + 0x88)
IMAGE_CONTROL, DATE_ID, SOFT_ID, HORIZON_ID, NO_ITEM = 0x02000012, 0x020001a0, 0x020001d1, 0x0200007d, 0x10000000
SOFT_BYTE = 0x9a1
RET = 0x30000000; STACK = 0x20000000; THIS = 0x11000000; REC = 0x12000000
fails = []
def check(cond, what):
    if not cond: fails.append(what); print('FAIL', what)

class Emu:
    def __init__(s, img):
        mu = s.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(img) + 0xfff) & ~0xfff); mu.mem_write(BASE, img)
        src, n = RAMSPEC[rel]; mu.mem_map(0x55000000, 0x900000); mu.mem_write(0x55000000, img[src - BASE:src - BASE + n])
        for a, n in ((0x10000000, 0x100000), (THIS, 0x10000), (REC, 0x1000), (STACK - 0x40000, 0x40000), (RET, 0x1000)): mu.mem_map(a, n)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20)); mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        s.stubs = {}; s.log = []
        mu.hook_add(UC_HOOK_CODE, s._code)
    def _code(s, mu, a, size, _):
        f = s.stubs.get(a)
        if f is None: return
        r = f(s)
        if r is False: return
        if isinstance(r, tuple): mu.reg_write(UC_ARM_REG_PC, r[1]); mu.reg_write(UC_ARM_REG_R0, r[0] & 0xffffffff); return
        if r is not None: mu.reg_write(UC_ARM_REG_R0, r & 0xffffffff)
        mu.reg_write(UC_ARM_REG_PC, mu.reg_read(UC_ARM_REG_LR))
    def reg(s, i): return s.mu.reg_read([UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
                                       UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_R12, UC_ARM_REG_SP, UC_ARM_REG_LR][i])
    def call(s, f, *args, until=RET):
        mu = s.mu
        for i, v in enumerate(args): mu.reg_write([UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3][i], v & 0xffffffff)
        saved = [0x4e000000 + 0x111 * k for k in range(4, 12)]
        for k, v in zip(range(4, 12), saved): mu.reg_write([UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11][k - 4], v)
        sp = STACK - 0x2000; mu.reg_write(UC_ARM_REG_SP, sp); mu.reg_write(UC_ARM_REG_LR, RET)
        mu.emu_start(f, until, count=3000000)
        pc = mu.reg_read(UC_ARM_REG_PC)
        if pc != until: raise RuntimeError('stopped at %x' % pc)
        if until == RET:
            check([s.reg(k) for k in range(4, 12)] == saved and s.reg(13) == sp, 'callee-saved registers / stack after %x' % f)
        return s.reg(0)
    def u32(s, a): return struct.unpack('<I', bytes(s.mu.mem_read(a, 4)))[0]
    def rd(s, a, n): return bytes(s.mu.mem_read(a, n))
    def wr(s, a, b): s.mu.mem_write(a, bytes(b))

def emu(img, model):
    e = Emu(img)
    e.stubs[APP] = lambda e: 0x10000100; e.stubs[SPEC_MODEL] = lambda e: 0x10000100; e.stubs[MODEL_NUMBER] = lambda e: model
    def dispatch(e):
        fn = e.reg(1)
        return 1 if fn == 0 else (model == 0) if fn == ND_VIS else (model == 1) if fn == HDF_VIS else 1
    e.stubs[DISPATCH] = dispatch
    def page(e): e.mu.reg_write(UC_ARM_REG_R0, 1); e.mu.reg_write(UC_ARM_REG_PC, PAGE_BLX + 4); return False
    e.stubs[PAGE_BLX] = page
    return e

def wide_of(img):
    """Lines a tab of the wide layout (the controller is 0x13bc + 5 tabs x 20 bytes a line), None for the official one."""
    n = movw_imm(w32(img, ALLOC))
    if n == 0x13bc: return None
    assert (n - 0x13bc) % 100 == 0, hex(n)
    return (n - 0x13bc) // 100

def build(img, model):
    """The builder's result: per tab (count, page firsts, [(id, draw0, draw1)])."""
    e = emu(img, model)
    e.wr(THIS, bytes(0x10000))
    e.call(BUILDER, THIS)
    W = wide_of(img)
    tabs = []
    for t in range(5):
        hdr = THIS + 0x228 + t * 0x384
        count = e.rd(hdr + 0x8b, 1)[0]; pages = e.rd(hdr + 0x68, 1)[0]; firsts = list(e.rd(hdr + 0x80, pages))
        if W is None:
            items = [(e.u32(THIS + 0x3e4 + (t * 0xe1 + i) * 4), e.u32(hdr + 0x8c + 8 * i), e.u32(hdr + 0x90 + 8 * i)) for i in range(count)]
        else:
            items_n = W
            cid = 0x13bc; cdraw = cid + 5 * items_n * 4
            items = [(e.u32(THIS + cid + (t * items_n + i) * 4), e.u32(THIS + cdraw + (t * items_n + i) * 8), e.u32(THIS + cdraw + (t * items_n + i) * 8 + 4)) for i in range(count)]
        tabs.append((count, firsts, items))
    return e, tabs

def ok_ids(e, tabs):
    got = []
    for t, (count, _, items) in enumerate(tabs):
        for i in range(count):
            e.wr(THIS + 0x1b0, [t]); e.mu.mem_write(THIS + 0x1ac, struct.pack('<I', 0x10000200))
            seen = []
            e.stubs[CURSOR] = lambda e, i=i: i
            for c in OK_CALLS: e.stubs[c] = lambda e: 0x10000100
            e.stubs[OK_TAIL] = lambda e, seen=seen: seen.append(e.reg(1))
            e.call(OK, THIS)
            got.append((t, i, seen[0] if seen else NO_ITEM))
    return got

def draws(e, tabs):
    out = []
    fns = {d for _, _, items in tabs for _, d, _ in items}
    for t, (count, _, items) in enumerate(tabs):
        e.wr(THIS + 0x1b0, [t]); e.mu.mem_write(THIS + 0x1ac, struct.pack('<I', 0x10000200))
        rec = {'count': None, 'calls': []}
        def cnt(e, rec=rec): rec['count'] = e.reg(1)
        e.stubs[DRAW_COUNT] = cnt; e.stubs[DRAW_STATE] = lambda e: 0
        e.stubs[LIST_ITEM] = lambda e: 0x7000 + e.reg(1)
        for f in fns: e.stubs[f] = lambda e, f=f, rec=rec: rec['calls'].append((f, e.reg(1), e.reg(0)))
        e.call(DRAW, THIS)
        for f in fns: del e.stubs[f]
        out.append(rec)
    return out

for model in (0, 1):
    eo, official = build(OFF, model)
    eb, built = build(IMG, model)
    W = wide_of(IMG)
    # the menus the build without the line has (with WITHOUT; End Screen pictures change Setup), else the official ones
    ref = build(open(without_path, 'rb').read(), model)[1] if without_path else official
    print(f'model {model}: still menu {official[0][0]} lines (official), {ref[0][0]} (without the line) -> {built[0][0]} ({"wide, %d lines a tab" % W if W else "official layout"})')
    # --- the lines kept
    for t in range(5):
        oc, of, oi = ref[t]; bc, bf, bi = built[t]
        if t == 0:
            exp = []
            for it in oi:
                exp.append(it[0])
                if it[0] == IMAGE_CONTROL: exp.append(SOFT_ID)
            if any(x[0] == DATE_ID for x in bi) and not any(x[0] == DATE_ID for x in oi): exp.append(DATE_ID)
            check([x[0] for x in bi] == exp, f'model {model} still tab: ids {[hex(x[0]) for x in bi]}')
            # official lines: their draw member pointers unchanged
            od = {x[0]: x[1:] for x in oi}
            check(all(x[1:] == od[x[0]] for x in bi if x[0] in od and od[x[0]][0] < BASE + len(OFF)), f'model {model} still tab: official draw functions')
            # pages start at the same official lines
            check(len(bf) == len(of) and all(bi[b][0] == oi[a][0] for a, b in zip(of, bf)), f'model {model} still tab: page firsts {of} -> {bf}')
        else:
            # a draw function in appended code (the End Screen submenu's line) is the same one at another address
            norm = lambda items: [(i, 'appended' if d >= BASE + len(OFF) else d, a) for i, d, a in items]
            check((bc, bf, norm(bi)) == (oc, of, norm(oi)), f'model {model} tab {t}: not the lines of the build without the line')
            if t == 4 and not without_path: check(bi == official[4][2], 'Setup: the official lines')
    # --- OK
    oko = ok_ids(eo, official); okb = ok_ids(eb, built)
    check(all(idv == built[t][2][i][0] for t, i, idv in okb), f'model {model}: OK opens the line\'s id (built)')
    check(all(idv == official[t][2][i][0] for t, i, idv in oko), f'model {model}: OK opens the line\'s id (official)')
    # --- drawing
    do = draws(eo, official); db = draws(eb, built)
    for t in range(5):
        check(db[t]['count'] == built[t][0] and do[t]['count'] == official[t][0], f'model {model} tab {t}: row count given to the list view')
        check([(f, row) for f, row, _ in db[t]['calls']] == [(x[1], 0x7000 + i) for i, x in enumerate(built[t][2])], f'model {model} tab {t}: draw calls (built)')
        check([(f, row) for f, row, _ in do[t]['calls']] == [(x[1], 0x7000 + i) for i, x in enumerate(official[t][2])], f'model {model} tab {t}: draw calls (official)')
        check(all(r0 == THIS for _, _, r0 in db[t]['calls']), f'model {model} tab {t}: draw member called on the controller')
print('builder / OK / drawing: compared for both models and all five tabs')

# --- the list view's rows
for img, name in ((OFF, 'official'), (IMG, 'built')):
    e = Emu(img); got = []
    def rows(e, got=got): got.append((e.reg(2), e.reg(3), e.rd(e.reg(1), e.reg(2) + 1))); return 0
    e.stubs[LIST_ROWS] = rows
    tgt = bl_target(img, ROWS_CALL)
    if tgt == LIST_ROWS:
        e.wr(0x10000400, [0x13] * 38 + [0]); e.call(LIST_ROWS, 0x10000200, 0x10000400, 38, 0x3a)
    else:
        e.call(tgt, 0x10000200, 0x10000400, 38, 0x3a)
    n = W if (name == 'built' and W) else 38
    check(got and got[0][0] == n and got[0][1] == 0x3a and got[0][2] == bytes([0x13] * n + [0]), f'{name}: list view rows {got[:1]}')
print('list view rows: %d of kind 0x13' % (W or 38))

# --- the soft focus list, reached as the camera reaches it
e = Emu(IMG)
writes = []
e.mu.hook_add(UC_HOOK_MEM_WRITE, lambda mu, acc, a, size, v, _: writes.append((a, size, v)) if not (STACK - 0x40000 <= a < STACK) else None)
e.wr(0x10000300, bytes(0x200))
e.call(SET_CURRENT, 0x10000300, SOFT_ID)
record_no = e.rd(0x10000300 + 0x198, 1)[0]
table = movw_imm(w32(IMG, SELECT_SITE[0])) | movw_imm(w32(IMG, SELECT_SITE[1])) << 16
rec = e.rd(table + record_no * 0x40, 0x40)
title, count_fn, draw_fn, set_fn, cur_fn = struct.unpack_from('<I', rec, 4)[0], *[struct.unpack_from('<I', rec, o)[0] for o in (8, 0x10, 0x18, 0x20)]
check(record_no > 117 and title > 0, f'SetCurrentMenu: soft focus list record {record_no}')
e.call(FACTORY, 0x10000300, SOFT_ID, until=FACTORY + 4); check(e.reg(1) == HORIZON_ID, 'factory: Horizon Correction\'s list controller')
e.wr(0x10000380, struct.pack('<I', SOFT_ID)); check(e.call(bl_target(IMG, KEY_MAP_READ), 0x10000380) == HORIZON_ID, 'key map: Horizon Correction\'s keys')
check(e.call(count_fn, 0x10000300) == 4, 'count 4')
items = []
e.stubs[LIST_SET_ITEM] = lambda e: items.append((e.reg(0), e.reg(1), e.reg(2)))
for k in range(6): e.call(draw_fn, 0x10000300, 0x7100, k)
icons = [x[1] for x in items]
check([(x[0], x[2]) for x in items] == [(0x7100, t) for t in (2, 9, 10, 11)] and icons[0] == 296 and len(set(icons)) == 4, f'list draw {items}')
# the record in use
rec0 = bytes((i * 37 + 11) & 0xff for i in range(0xb28))
e.mu.mem_write(SETTINGS, struct.pack('<I', REC))
def run(fn, *args, byte=None):
    r = bytearray(rec0)
    if byte is not None: r[SOFT_BYTE] = byte
    e.wr(REC, r); del writes[:]
    v = e.call(fn, *args)
    after = e.rd(REC, 0xb28)
    changed = [i for i in range(0xb28) if after[i] != r[i]]
    other = [a for a, size, _ in writes if not (a == REC + SOFT_BYTE and size == 1)]
    return v, after[SOFT_BYTE], changed, other
for k in range(5):
    v, b, ch, other = run(set_fn, 0x10000300, k, byte=0x00)
    check(b == (k if k < 4 else 0) and set(ch) <= {SOFT_BYTE} and not other, f'set {k}: byte {b}, changed {ch}, writes {other}')
for byte in (0, 1, 2, 3, 4, 0xff):
    cur = []
    for k in range(4):
        v, b, ch, other = run(cur_fn, 0x10000300, k, byte=byte)
        cur.append(v)
        check(b == (byte if byte <= 3 else 0) and set(ch) <= {SOFT_BYTE} and not other, f'is current {k} of byte {byte:#x}: byte {b}, writes {other}')
    check(cur == [int(k == (byte if byte <= 3 else 0)) for k in range(4)], f'byte {byte:#x}: current {cur}')
    seen = []
    e.stubs[LINE_VALUE_ICON] = lambda e, seen=seen: seen.append(('icon', e.reg(0), e.reg(1)))
    e.stubs[TOP_SET_TITLE] = lambda e, seen=seen: seen.append(('title', e.reg(0), e.reg(1), e.reg(2)))
    line_draw = next(x[1] for x in built[0][2] if x[0] == SOFT_ID)
    v, b, ch, other = run(line_draw, THIS, 0x7200, byte=byte)
    check(not ch and not other, f'line draw writes nothing (byte {byte:#x})')
    check(len(seen) == 2 and seen[0][1:] == (0x7200, icons[byte if byte <= 3 else 0]) and seen[1][1] == 0x7200 and seen[1][2] == seen[1][3] == title,
          f'line draw of byte {byte:#x}: {seen}')
adj_name = movw_imm(w32(IMG, NAME_R10)) if (w32(IMG, NAME_R10) & 0x0ff00000) == 0x03000000 else None
check(adj_name == title, f'the line and its list are named as the ADJ function ({title} / {adj_name})')
# no record yet (pointer 0)
e.mu.mem_write(SETTINGS, struct.pack('<I', 0)); del writes[:]
e.call(set_fn, 0x10000300, 2); check(not writes, 'set without a record writes nothing')
check([e.call(cur_fn, 0x10000300, k) for k in range(4)] == [1, 0, 0, 0], 'without a record: Off is current')
print('soft focus list: record %d, ids, count, draw, set, is current and the line, for bytes 0..4, 0xff and no record' % record_no)

if without_path:
    base = open(without_path, 'rb').read()
    n = min(len(OFF), len(base), len(IMG))
    def moved(i):
        x, y = w32(base, BASE + i), w32(IMG, BASE + i)
        if (x >> 25) & 7 == 5 and (y >> 25) & 7 == 5 and x >> 24 == y >> 24:
            return min(bl_target(base, BASE + i), bl_target(IMG, BASE + i)) >= BASE + len(OFF)
        if BASE + len(OFF) <= x < 0x55000000 and BASE + len(OFF) <= y < 0x55000000: return True  # a pointer to appended code
        return (x & 0x0ff00000) in (0x03000000, 0x03400000) and (x & 0xfff0f000) == (y & 0xfff0f000)
    diff = sorted(BASE + i for i in range(0, len(OFF), 4) if base[i:i + 4] != IMG[i:i + 4] and not moved(i))
    print('against the build without the line: words of the official image that differ:', [hex(x) for x in diff])
    # the menu hooks; the list table's 15 movw / movt pairs (datestamp.ts, a longer copy now) are 'moved' above
    allowed = {BUILDER, ALLOC, A(0x5319a950), A(0x5319a970), A(0x5319a97c), A(0x53198b54), A(0x53198b60), A(0x53199bc8), ROWS_CALL}
    check(set(diff) <= allowed, 'only the menu hooks differ: %s' % [hex(x) for x in sorted(set(diff) - allowed)])
print('FAILED: %d' % len(fails) if fails else 'all checks passed')
sys.exit(1 if fails else 0)
