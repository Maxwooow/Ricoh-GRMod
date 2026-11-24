# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of Sensor Shift (build option sensorShift, core/src/fw/gr4v120/aspect/shift.ts and tools/shift/shift.c),
GR IV 1.20 and 1.21. The addresses here are 1.20's; for 1.21 they go through core/src/fw/gr4v121/addresses.ts.

NOT part of the program. Runs the hooks of a build with the option in Unicorn, the camera's functions they call
replaced by recorders, against a Python model of shift.c:

  A. the image: below the official end, the build differs from the same build without the option only at the places
     shift.ts names (and where an address of the appended area is written);
  B. the keys (SwitchModel::Notify), random sequences with the ADJ lever's handlers and screen updates in between:
     what is used up, the state, every word written to the shake reduction unit, every call into the screen;
  C. a state of random bytes, neither button set to the function: every key passes, nothing is written;
  D. the fast path of a switch message; E. the three value texts; F. the shake reduction state; G. the ISO icon;
  H. the key guide, alone and through the camera's own OSD items 36 and 38;
  I. the ADJ function: its record's handlers, its name and icon, the list of ADJ Mode Setting; every other
     function's name and icon as in the build without the option;
  J. the Fn function: name and icon, the Fn button's list (one more row, the others handed on), the held Movie
     button's list, the three function switches (the new number goes to the end, every other one where it went).

    python3 check.py 1.20|1.21 OFFICIAL-RTOS BUILT-WITHOUT-RTOS BUILT-WITH-RTOS
"""
import random
import re
import struct
import sys
from pathlib import Path
from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import *

release, official_path, without_path, with_path = sys.argv[1:5]
BASE = 0x53000000
REPO = Path(__file__).resolve().parents[2]
TABLE = {}
if release == '1.21':
    for m in re.finditer(r'\[0x([0-9a-f]{8}), 0x([0-9a-f]{8})\]', (REPO / 'core/src/fw/gr4v121/addresses.ts').read_text()):
        TABLE[int(m.group(1), 16)] = int(m.group(2), 16)
elif release != '1.20':
    sys.exit('release: 1.20 or 1.21')


def adr(a):
    return TABLE[a] if TABLE else a


official = open(official_path, 'rb').read()
plain = open(without_path, 'rb').read()
img = open(with_path, 'rb').read()
OFFICIAL_END = BASE + len(official)
u32 = lambda d, a: struct.unpack_from('<I', d, a - BASE)[0]
ST = adr(0x55839048)
RET = 0x100f0000
NOTIFY, FAST_CALL, FAST_PATH, SET_TEXT = adr(0x53272a80), adr(0x53183c14), adr(0x5325e67c), adr(0x53590490)
TV, AV, SV, SVI, SV_ICON_CALL, SV_ICON_OF = adr(0x5318c118), adr(0x5318c30c), adr(0x5318c544), adr(0x5318c4f0), adr(0x5318c518), adr(0x533a88fc)
LABEL_CALLS = [(adr(0x5318c1d0), 0), (adr(0x5318c208), 0), (adr(0x5318c3c8), 1), (adr(0x5318c400), 1), (adr(0x5318c60c), 2), (adr(0x5318c644), 2)]
GUIDE, ITEM36, ITEM38 = adr(0x5318e8f4), adr(0x5318eb48), adr(0x5318ea8c)
VIS_A, VIS_B = adr(0x53dc08e0), adr(0x53dbf95c)
LV_HOLDER, LV_VTABLE, SCREEN = adr(0x55081d40), adr(0x53dbf740), adr(0x55088534)
SETTINGS, APP_STATE, VIEW_STATE, SR_HOLDER = adr(0x550832a8), adr(0x55083138), adr(0x5508a010), adr(0x550b9b20)
SR_WRITE, SR_STATE, SR_STATE_ON = adr(0x536b2180), adr(0x537bb254), adr(0x537bb2b0)
GET_APP, GET_SETTINGS, SET_FN = adr(0x532406a4), adr(0x53240c38), adr(0x5333fbd8)
LIST_ITEM, ITEM_SET_TEXT, LIST_SET_ITEM = adr(0x53593d64), adr(0x535a1138), adr(0x5359e1bc)
ADJ_TABLE_LOW, ADJ_TABLE_HIGH, ADJ_TABLE_END = adr(0x531bd4c4), adr(0x531bd4d4), adr(0x531bd600)
ADJ_NAME_OF, ADJ_ICON_OF = adr(0x5338f484), adr(0x53390e40)
ADJ_LIST_LOW, ADJ_LIST_HIGH, ADJ_LIST_LENGTH = adr(0x531dc834), adr(0x531dc844), adr(0x531dc860)
FN_NAME_OF, FN_ICON_OF = adr(0x5338fbac), adr(0x533914bc)
SWITCHES = [(adr(0x5339910c), UC_ARM_REG_R2, adr(0x5339927c)), (adr(0x53397bd8), UC_ARM_REG_R10, adr(0x53397ad0)), (adr(0x53397ca0), UC_ARM_REG_R0, adr(0x53397ad0))]
HELD_LOW, HELD_HIGH, HELD_LENGTH = adr(0x531dcc0c), adr(0x531dcc10), adr(0x531dcc20)
SELECT_LOW, SELECT_HIGH = adr(0x531d825c), adr(0x531d826c)
FN_LIST = [adr(0x531d0be0), adr(0x531d3080), adr(0x531d5018), adr(0x531d6a18)]   # count, draw, set, current
# Only this check uses these (not in the address table): [1.20, 1.21].
BOTH = lambda a120, a121: a121 if release == '1.21' else a120
OSD_SET_GUIDE, VIEW_SHOW = BOTH(0x5359b518, 0x5359be40), BOTH(0x535acd84, 0x535ad6ac)
STACK_GUARD, STACK_FAIL, GET_VIEW_MODEL, ITEM36_CONTENT = BOTH(0x5438c484, 0x5438dc74), BOTH(0x53aa08d4, 0x53aa1e9c), BOTH(0x53240f38, 0x53241540), BOTH(0x5318e69c, 0x5318e674)
FN, ICON, ICON_DISP, T_NAME, T_ADJUST, T_OFF, T_CENTER = 0x2e, 739, 542, 1041, 1042, 2, 1043
PTR = (0x200009f8, 0x200009fc, 0x20000a00); REG = (0x40114400, 0x40114430, 0x40114460); BUF = (0x2000adf4, 0x2000adf8, 0x2000adfc)


def mov16(d, low, high):
    a, b = u32(d, low), u32(d, high)
    assert (a & 0x0ff00000) == 0x03000000 and (b & 0x0ff00000) == 0x03400000, (hex(low), hex(a), hex(b))
    imm = lambda w: ((w >> 4) & 0xf000) | (w & 0xfff)
    return imm(a) | (imm(b) << 16)


def branch(d, at):
    w = u32(d, at); off = w & 0xffffff; off -= 0x1000000 if off & 0x800000 else 0
    assert (w >> 25) & 7 == 5, hex(w)
    return at + 8 + off * 4


# ---- A: the image
adj_table = mov16(img, ADJ_TABLE_LOW, ADJ_TABLE_HIGH)
adj_fn = (u32(img, ADJ_TABLE_END) - adj_table) // 0x5c - 1
plain_table = mov16(plain, ADJ_TABLE_LOW, ADJ_TABLE_HIGH)
assert (u32(plain, ADJ_TABLE_END) - plain_table) // 0x5c == adj_fn, 'the build without the option does not have one ADJ function fewer'
select = mov16(img, SELECT_LOW, SELECT_HIGH)
fn_record = select + 73 * 0x4c
named = {NOTIFY, FAST_CALL, SV_ICON_CALL, GUIDE, SR_STATE_ON, ADJ_NAME_OF, ADJ_ICON_OF, FN_NAME_OF, FN_ICON_OF, HELD_LOW, HELD_HIGH, HELD_LENGTH, ADJ_LIST_LOW, ADJ_LIST_HIGH, ADJ_LIST_LENGTH, ADJ_TABLE_END}
named |= {c for c, _ in LABEL_CALLS} | {b for b, _, _ in SWITCHES}
if fn_record < OFFICIAL_END: named |= {fn_record + o for o in (0x0c, 0x14, 0x24, 0x2c)}
other = []
for at in range(BASE, OFFICIAL_END, 4):
    a, b = u32(plain, at), u32(img, at)
    if a == b or at in named: continue
    # an address of the appended area in both (a table or a helper that moved), or a MOVW / MOVT half of one, or a text / icon bound
    if a >= OFFICIAL_END and b >= OFFICIAL_END and a < 0x55000000 and b < 0x55000000: continue
    if (a & 0x0fb00000) == 0x03000000 and (b & 0x0fb00000) == 0x03000000 and (a & 0xf000) == (b & 0xf000): continue
    if (a >> 24) in (0xea, 0xeb) and (b >> 24) == (a >> 24) and branch(plain, at) >= OFFICIAL_END and branch(img, at) >= OFFICIAL_END: continue
    other.append(at)
assert not other, 'unexpected differences below the official end: ' + ' '.join(hex(x) for x in other[:12])
assert all(u32(plain, at) != u32(img, at) for at in named), [hex(a) for a in named if u32(plain, a) == u32(img, a)]
print(f'A. image: {len(named)} named places differ from the build without the option; the rest below the official end is the same or an address of the appended area')

ctx = [BASE + i for i in range(len(official) & ~3, len(img) - 4, 4) if img[i:i + 4] == b'shft']
assert len(ctx) == 1, ctx
ctx = ctx[0]
CTX = struct.unpack_from('<47I', img, ctx - BASE)
expect_ctx = (0x74666873, ST, SR_HOLDER + 4, LV_HOLDER + 4, LV_VTABLE, SCREEN, SETTINGS + 0x1469, SETTINGS + 0x146e, SETTINGS + 0xb69, SETTINGS + 0x925, APP_STATE + 0x25, VIEW_STATE + 0xb,
              VIS_A, VIS_B, SR_WRITE, SR_STATE, TV, AV, SV, SVI, ITEM36, ITEM38, LIST_ITEM, ITEM_SET_TEXT, LIST_SET_ITEM, GET_APP, GET_SETTINGS, SET_FN, FN_LIST[1], FN_LIST[2], FN_LIST[3],
              FN, ICON, ICON_DISP, T_NAME, T_ADJUST, T_OFF, T_CENTER) + PTR + REG + BUF
assert CTX == expect_ctx, [(i, hex(a), hex(b)) for i, (a, b) in enumerate(zip(CTX, expect_ctx)) if a != b]

REGS = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_R12, UC_ARM_REG_SP, UC_ARM_REG_LR]
SRMSG, DSP, LV, MODEL, EV, MSG, ADJ, LISTV, ITEM, CTRL, APP, SETT = 0x56700000, 0x56700100, 0x5a000000, 0x56701000, 0x10010000, 0x10010100, 0x5a002000, 0x5a003000, 0x5a004000, 0x5a005000, 0x5a006000, 0x5a007000
NAMES = {TV: 'TV', AV: 'AV', SV: 'SV', SVI: 'SVI'}


class M:
    """The image `image` with the camera's functions the module calls recorded; `stops`: addresses that end a run."""
    def __init__(s, image, stops=(), real_items=False):
        mu = Uc(UC_ARCH_ARM, UC_MODE_ARM); s.mu = mu
        mu.mem_map(BASE, (len(image) + 0xfffff) & ~0xfffff); mu.mem_write(BASE, image)
        mu.mem_map(0x55000000, 0x2000000); mu.mem_map(0x10000000, 0x100000); mu.mem_map(0x5a000000, 0x10000)
        mu.mem_write(SR_HOLDER + 4, struct.pack('<I', SRMSG)); mu.mem_write(SRMSG + 0x60, struct.pack('<I', DSP))
        mu.mem_write(LV_HOLDER + 4, struct.pack('<I', LV)); mu.mem_write(LV, struct.pack('<I', LV_VTABLE))
        mu.mem_write(MODEL + 0x760, struct.pack('<I', 0x12345678))
        s.log = []; s.stop = None; s.stops = set(stops) | {RET}
        rec = {}
        rec[SR_WRITE] = lambda r: (('W', r(0), r(1), r(2)), 0)
        rec[SR_STATE] = lambda r: (('DSP', r(0)), 0)
        for a, n in NAMES.items(): rec[a] = (lambda n: lambda r: ((n, r(0)), 1))(n)
        if not real_items:
            rec[ITEM36] = lambda r: (('I36', r(0), r(1), r(2)), 0)
            rec[ITEM38] = lambda r: (('I38', r(0), r(1), r(2)), 0)
        rec[LIST_ITEM] = lambda r: (('ITEM', r(0), r(1)), ITEM)
        rec[ITEM_SET_TEXT] = lambda r: (('TEXT', r(0), r(1)), 0)
        rec[LIST_SET_ITEM] = lambda r: (('ROW', r(0), r(1), r(2)), 0)
        rec[GET_APP] = lambda r: (None, APP)
        rec[GET_SETTINGS] = lambda r: (('GETSET', r(0)), SETT)
        rec[SET_FN] = lambda r: (('SETFN', r(0), r(1)), 0x77)
        for a in FN_LIST[1:]: rec[a] = (lambda a: lambda r: (('ORIG', a, r(0), r(1), r(2)), 0x55))(a)
        s.rec = rec

        def code(uc, addr, size, ud):
            r = lambda i: uc.reg_read(REGS[i])
            if addr in s.rec:
                entry, value = s.rec[addr](r)
                if entry: s.log.append(entry)
                uc.reg_write(UC_ARM_REG_R0, value); uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            elif addr in s.stops: s.stop = addr; uc.emu_stop()
        mu.hook_add(UC_HOOK_CODE, code)

        def bad(uc, access, addr, size, value, ud):
            s.log.append(('BAD', hex(addr), hex(uc.reg_read(UC_ARM_REG_PC)))); return False
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, bad)

    def run(s, pc, regs, flags=0):
        mu = s.mu; s.log = []; s.stop = None
        for k, v in zip(REGS, regs): mu.reg_write(k, v)
        mu.reg_write(UC_ARM_REG_CPSR, 0x13 | flags)
        mu.reg_write(UC_ARM_REG_SP, regs[13])
        try: mu.emu_start(pc, 0, count=200000)
        except UcError as e: s.log.append(('ERR', str(e), hex(mu.reg_read(UC_ARM_REG_PC))))
        return [mu.reg_read(k) for k in REGS], mu.reg_read(UC_ARM_REG_CPSR)

    def st(s): return bytes(s.mu.mem_read(ST, 0x2c))
    def setst(s, b): s.mu.mem_write(ST, bytes(b))

    def env(s, e):
        w = s.mu.mem_write
        w(SETTINGS + 0x1469, bytes([e['fn']])); w(SETTINGS + 0x146e, bytes([e['hold']])); w(SETTINGS + 0xb69, bytes([e['iso']])); w(SCREEN, struct.pack('<I', e['scr']))
        w(LV + 0x2d6, bytes([e['a']])); w(LV + 0x2dd, bytes([e['b']])); w(LV + 0x4e5, bytes([e['h5']])); w(LV + 0x4e6, bytes([e['h6']])); w(APP_STATE + 0x25, bytes([e['H1']])); w(VIEW_STATE + 0xb, bytes([e['H2']]))


def E(**k):
    e = dict(fn=0x2c, hold=0x25, iso=0, scr=0x08000000, a=0, b=0, h5=0, h6=0, H1=0, H2=0); e.update(k); return e


TA = img[VIS_A - BASE:VIS_A - BASE + 0x60]; TB = img[VIS_B - BASE:VIS_B - BASE + 0x60]
s8 = lambda v: v - 256 if v > 127 else v
in_lv = lambda e: e['scr'] in (0x08000000, 0x08000002, 0x08000003)


def vis(e, i):
    if e['H1'] or e['H2'] or e['h5'] or e['h6'] or e['a'] > 1 or e['b'] > 1: return 0
    return TB[e['b'] * 0x30 + i] if TA[e['a'] * 0x30 + i] else 0


guide = lambda e: [('I36', LV, 36, vis(e, 36)), ('I38', LV, 38, vis(e, 38))]
show = lambda e: [('TV', LV), ('AV', LV), ('SV', LV), ('SVI', LV)] + guide(e)


class Model:
    """shift.c, written again."""
    def __init__(s): s.mode = 0; s.vx = s.vy = s.r = 0; s.disable = 0; s.redir = 0; s.sroff = 0; s.eat = 0; s.cache = [0, 0, 0]; s.pad24 = 0; s.count = 0; s.label = b'\0' * 16; s.free = 0; s.pend = 0; s.conf = 0
    def armed_fn(s, e): return in_lv(e) and not e['iso'] and e['fn'] == FN
    def armed_hold(s, e): return in_lv(e) and not e['iso'] and e['hold'] == FN
    def active(s): return s.mode == 0xA5 or bool(s.vx or s.vy or s.r)

    def resume(s, e, log):
        if s.conf != 0xA5 or not in_lv(e): return False
        s.conf = 0
        if s.pend == 0xA5: s.pend = 0; s.mode = 0xA5; s.fmt(); s.apply(log); return True
        s.pend = 0
        if s.active(): s.mode = 0; s.vx = s.vy = s.r = 0; s.fmt(); s.apply(log); return True
        return False

    def lab(s, which, e):
        log = []
        if s.disable == 0x5A: return None, log
        if which == 0 and s.resume(e, log): log += guide(e)
        return (which if s.mode == 0xA5 else None), log

    def adj(s, op, i=0):
        if op == 'enter': s.pend = 0xA5 if s.active() else 0; s.conf = 0
        elif op == 'leave':
            if s.disable != 0x5A: s.conf = 0xA5
        elif op == 'set':
            if i <= 1: s.pend = 0xA5 if i else 0

    def fmt(s):
        p = lambda v: (b'-' if v < 0 else b'+') + b'%02d' % abs(v)
        s.label = b'X' + p(s.vx) + b'\0' + b'Y' + p(s.vy) + b'\0' + b'R' + p(s.r) + b'\0' + s.label[15:]

    def apply(s, log):
        any_ = bool(s.vx or s.vy or s.r); want = 0xA5 if (s.mode == 0xA5 or any_) else 0
        if s.sroff != want: s.sroff = want; log.append(('DSP', DSP))
        v = [-16384 * s.vx - 9998 * s.r, -16384 * s.vy + 13058 * s.r, -16384 * s.vy - 13013 * s.r]
        if any_ and s.redir != 0xA5:
            for k in range(3): log.append(('W', SRMSG, PTR[k], BUF[k])); s.count += 1
            s.redir = 0xA5; s.cache = [0x7fffffff] * 3
        if s.redir == 0xA5:
            for k in range(3):
                if s.cache[k] != v[k]: log.append(('W', SRMSG, REG[k], v[k] & 0xffffffff)); s.cache[k] = v[k]; s.count += 1
            if not any_:
                for k in range(3): log.append(('W', SRMSG, PTR[k], REG[k])); s.count += 1
                s.redir = 0

    def enter(s, e, log): s.mode = 0xA5; s.fmt(); s.apply(log); log += show(e)
    def leave(s, e, log): s.mode = 0; s.apply(log); log += show(e)

    def key(s, id, kind, val, e):
        log = []
        if s.disable == 0x5A: return 0, log
        if s.resume(e, log): log += show(e)
        on = s.mode == 0xA5
        if s.eat and id == s.eat:
            if kind == 2 and val == 0: s.eat = 0
            else:
                if kind == 1: s.eat = 0
                return 1, log
        if not on:
            if id == 27:
                if not s.armed_fn(e): return 0, log
                if kind == 2 and val == 0: s.eat = 27; s.enter(e, log)
                return 1, log
            if id == 28 and kind == 2 and val == 1 and s.armed_hold(e): s.eat = 28; s.enter(e, log); return 1, log
            return 0, log
        if not in_lv(e): s.mode = 0; s.apply(log); return 0, log
        if id == 35: s.leave(e, log); return 0, log
        if id == 28:
            if kind == 2 and val == 1 and e['hold'] == FN: s.eat = 28; s.leave(e, log); return 1, log
            return 0, log
        if id in (27, 8):
            if kind == 2 and val == 0: s.eat = id; s.leave(e, log)
            return 1, log
        if id == 4:
            if kind == 2 and val == 0: s.vx = s.vy = s.r = 0; s.fmt(); s.apply(log); log += show(e)
            return 1, log
        if 9 <= id <= 16 or 31 <= id <= 34 or id in (36, 37) or 40 <= id <= 43:
            if kind == 2:
                x, y, r = s.vx, s.vy, s.r
                if id == 12: x += 1
                elif id == 11: x -= 1
                elif id == 9: y += 1
                elif id == 10: y -= 1
                elif id in (31, 33, 36, 40, 42): r += 1
                elif id in (32, 34, 37, 41, 43): r -= 1
                m = 28 if s.free == 0xA5 else 28 - (abs(r) * 5 + 2) // 4
                if -18 <= r <= 18 and abs(x) <= m and abs(y) <= m and (x, y, r) != (s.vx, s.vy, s.r):
                    s.vx, s.vy, s.r = x, y, r; s.fmt(); s.apply(log); log += show(e)
            return 1, log
        return 0, log

    def pack(s): return struct.pack('<BbbbBBBB16s3iBBBBB', s.mode, s.vx, s.vy, s.r, s.disable, s.redir, s.sroff, s.eat, s.label, *s.cache, s.pad24, s.count & 0xff, s.free, s.pend, s.conf) + b'\0\0\0'


rng = random.Random(11)
m = M(img, stops=[NOTIFY + 4, FAST_PATH, SET_TEXT, SV_ICON_OF, SV_ICON_CALL + 4, SR_STATE_ON + 4, GUIDE + 4, FAST_CALL + 4])


def regs0():
    r = [rng.getrandbits(32) for _ in range(15)]; r[13] = 0x10080000; r[14] = RET; return r


def renv():
    return E(fn=rng.choice([FN, FN, 0x2c, 0x20, 0]), hold=rng.choice([FN, FN, 0x25, 0x20]), iso=rng.choice([0, 0, 0, 0, 1]), scr=rng.choice([0x08000000, 0x08000000, 0x08000002, 0x02000010, 0x08000001]),
             a=rng.choice([0, 0, 1, 2]), b=rng.choice([0, 0, 1, 5]), h5=rng.choice([0, 0, 0, 1]), h6=rng.choice([0, 0, 0, 1]), H1=rng.choice([0, 0, 0, 1]), H2=rng.choice([0, 0, 0, 1]))


record = adj_table + adj_fn * 0x5c
H = {k: u32(img, record + o) for k, o in (('enter', 0), ('leave', 8), ('draw', 0x18), ('current', 0x20), ('set', 0x28), ('count', 0x30))}
assert all(v >= OFFICIAL_END for v in H.values()) and u32(img, record + 4) == 0 and u32(img, record + 0xc) == 0 and u32(img, record + 0x3c) == 0
# the other records: as without the option (a handler of another addition may have moved in the appended area)
for o in range(0, adj_fn * 0x5c, 4):
    a, b = u32(plain, plain_table + o), u32(img, adj_table + o)
    assert a == b or (OFFICIAL_END <= a < 0x55000000 and OFFICIAL_END <= b < 0x55000000), ('the other ADJ records changed', hex(o), hex(a), hex(b))

# ---- B
IDS = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 27, 27, 28, 28, 28, 29, 31, 32, 33, 34, 35, 36, 37, 40, 43, 9, 10, 11, 12, 12, 12, 9, 9, 31, 31, 31]
n = 0; stats = {'enter27': 0, 'enter28': 0, 'leave28': 0, 'adj': 0}
for seq in range(300):
    mod = Model(); mod.pad24 = rng.choice([0, 0, 0x2c, 0xff]); mod.disable = rng.choice([0, 0, 0, 0, 0, 0x5A]); mod.free = rng.choice([0, 0, 0xA5])
    m.setst(mod.pack()); env = E(fn=rng.choice([FN, FN, 0x2c]), hold=rng.choice([FN, FN, 0x25]))
    for step in range(rng.randrange(20, 400)):
        if rng.random() < 0.04: env = renv()
        m.env(env)
        if rng.random() < 0.08:                    # the ADJ lever's strip: comes to the function, a value chosen, closes on it
            op = rng.choice(['enter', 'set', 'set', 'leave']); i = rng.randrange(0, 3)
            r = regs0(); r[0] = ADJ; r[1] = i
            out, cpsr = m.run(H[op], r); mod.adj(op, i)
            assert m.stop == RET and m.log == [] and m.st() == mod.pack() and out[4:12] == r[4:12] and out[13] == r[13], (op, i, m.st().hex(), mod.pack().hex())
            continue
        if rng.random() < 0.05:                    # a screen update (the shutter speed's text first)
            r = regs0(); r[0] = 0x5a000100; r[1] = 0x10020000; r[14] = 0x11111111
            was = mod.mode
            out, cpsr = m.run(LABEL_CALLS[0][0], r); exp, elog = mod.lab(0, env)
            if was != 0xA5 and mod.mode == 0xA5: stats['adj'] += 1
            assert m.stop == SET_TEXT and m.log == elog and m.st() == mod.pack() and out[1] == (ST + 8 if exp is not None else r[1]), (m.log, elog)
            continue
        id = rng.choice(IDS); kind = rng.choice([2, 2, 2, 1]); val = 0 if rng.random() < 0.6 else rng.randrange(1, 5)
        if kind == 1: val = rng.randrange(1, 4)
        m.mu.mem_write(EV, struct.pack('<II', kind | (rng.getrandbits(24) << 8), val))
        r = regs0(); r[0] = MODEL; r[1] = id; r[2] = EV
        was = mod.mode
        out, cpsr = m.run(NOTIFY, r)
        exp, elog = mod.key(id, kind, val, env)
        if was != 0xA5 and mod.mode == 0xA5 and id in (27, 28): stats['enter%d' % id] += 1
        if was != 0xA5 and mod.mode == 0xA5 and id not in (27, 28): stats['adj'] += 1
        if was == 0xA5 and mod.mode != 0xA5 and id == 28: stats['leave28'] += 1
        assert not [l for l in m.log if l[0] in ('BAD', 'ERR')], m.log
        if exp: assert m.stop == RET, (hex(m.stop or 0), id, kind, val)
        else:
            assert m.stop == NOTIFY + 4, (hex(m.stop or 0), id, kind, val, mod.__dict__)
            assert out[0:3] == r[0:3] and out[3] == 0x12345678 and out[12] == r[12]
        assert out[4:12] == r[4:12] and out[13] == r[13] and out[14] == r[14]
        assert m.log == elog, (m.log, elog, id, kind, val)
        assert m.st() == mod.pack(), (m.st().hex(), mod.pack().hex(), id, kind, val)
        n += 1
assert min(stats.values()) > 5, stats
print(f'B. keys: {n} events as the model', stats)

# ---- C
n = 0
for t in range(20000):
    g = bytearray(rng.getrandbits(8) for _ in range(0x2c))
    if g[0] == 0xA5: g[0] = 0
    if g[0x28] == 0xA5: g[0x28] = 0
    if rng.random() < 0.5: g[7] = 0
    e = renv(); e['fn'] = rng.choice([x for x in range(256) if x != FN]); e['hold'] = rng.choice([x for x in range(256) if x != FN]); e['scr'] = rng.choice([0x08000000, rng.getrandbits(32)])
    m.setst(g); m.env(e)
    id = rng.choice([i for i in range(1, 45) if i != g[7]])
    m.mu.mem_write(EV, struct.pack('<II', rng.choice([1, 2]), rng.randrange(0, 3)))
    r = regs0(); r[0] = MODEL; r[1] = id; r[2] = EV
    out, cpsr = m.run(NOTIFY, r)
    assert m.stop == NOTIFY + 4 and m.log == [] and m.st() == bytes(g) and out[0:3] == r[0:3] and out[3] == 0x12345678 and out[4:15] == r[4:15], (id, g.hex(), m.log)
    n += 1
print(f'C. a state of random bytes, neither button set to the function: {n} keys pass')

# ---- D
n = 0
for t in range(20000):
    mod = Model(); mod.mode = rng.choice([0, 0xA5, rng.getrandbits(8)]); mod.disable = rng.choice([0, 0, 0x5A])
    m.setst(mod.pack()); env = renv(); m.env(env)
    id = rng.choice([0x21600217, 0x21600217, 0x2160020b, 0x2160020c, 0x21600218, 0x21600209, 0x21600202, 0x21600203, 0x21600208, rng.getrandbits(32)])
    m.mu.mem_write(MSG, struct.pack('<5I', id, rng.getrandbits(1), 0, 0, 0))
    r = regs0(); r[0] = 0x56708500; r[1] = MSG; r[14] = 0x22220000
    out, cpsr = m.run(FAST_CALL, r)
    if mod.disable == 0x5A: exp = 0
    elif id == 0x21600217: exp = int(mod.mode == 0xA5 or mod.armed_fn(env))
    elif mod.mode != 0xA5: exp = 0
    else: exp = int(id in (0x2160020b, 0x2160020c))
    assert m.log == [] and m.st() == mod.pack()
    if exp: assert m.stop == FAST_CALL + 4
    else: assert m.stop == FAST_PATH and out[0] == r[0] and out[1] == r[1]
    assert out[4:12] == r[4:12] and out[13] == r[13] and out[14] == FAST_CALL + 4
    n += 1
print(f'D. fast path: {n}')

# ---- E
n = 0
for t in range(3000):
    mod = Model(); mod.mode = rng.choice([0, 0xA5, rng.getrandbits(8)]); mod.disable = rng.choice([0, 0, 0x5A]); mod.vx = rng.randrange(-28, 29); mod.fmt(); m.setst(mod.pack()); m.env(E())
    for site, which in LABEL_CALLS:
        r = regs0(); r[0] = 0x5a000100; r[1] = 0x10020000; r[14] = 0x11111111
        out, cpsr = m.run(site, r)
        assert m.stop == SET_TEXT and out[0] == r[0] and out[14] == site + 4 and out[4:12] == r[4:12] and out[13] == r[13] and m.log == []
        assert out[1] == (ST + 8 + 5 * which if (mod.mode == 0xA5 and mod.disable != 0x5A) else r[1])
        n += 1
print(f'E. the three texts: {n}; for example', bytes(m.mu.mem_read(ST + 8, 15)))

# ---- F
n = 0
for t in range(5000):
    mod = Model(); mod.sroff = rng.choice([0, 0xA5, rng.getrandbits(8)]); mod.disable = rng.choice([0, 0, 0x5A]); m.setst(mod.pack())
    r = regs0(); r[7] = rng.choice([0, 1, rng.getrandbits(32)]); r[14] = 0x22222222
    out, cpsr = m.run(SR_STATE_ON, r, flags=rng.getrandbits(4) << 28)
    force = (mod.sroff == 0xA5 and mod.disable != 0x5A); r7 = 0 if force else r[7]
    assert m.stop == SR_STATE_ON + 4 and out[7] == r7 and bool(cpsr & 0x40000000) == (r7 == 0) and out[0:7] == r[0:7] and out[8:14] == r[8:14] and m.log == []
    n += 1
print(f'F. shake reduction state: {n}')

# ---- G
n = 0
for t in range(5000):
    mod = Model(); mod.mode = rng.choice([0, 0xA5, rng.getrandbits(8)]); mod.disable = rng.choice([0, 0, 0x5A]); m.setst(mod.pack())
    r = regs0(); r[14] = 0x33333333
    out, cpsr = m.run(SV_ICON_CALL, r)
    if mod.mode == 0xA5 and mod.disable != 0x5A: assert m.stop == SV_ICON_CALL + 4 and out[0] == 0
    else: assert m.stop == SV_ICON_OF and out[0:3] == r[0:3] and out[14] == SV_ICON_CALL + 4
    assert out[4:12] == r[4:12] and out[13] == r[13] and m.log == []
    n += 1
print(f'G. ISO icon: {n}')

# ---- H
n = 0
for t in range(5000):
    mod = Model(); mod.mode = rng.choice([0, 0xA5, 0xA5, rng.getrandbits(8)]); mod.disable = rng.choice([0, 0, 0x5A]); m.setst(mod.pack())
    P = 0x10030000; m.mu.mem_write(P, bytes([0xcc]) * 0x40)
    r = regs0(); r[0] = LV; r[1] = P; r[2] = P + 8; r[3] = P + 0x20
    out, cpsr = m.run(GUIDE, r)
    mem = bytes(m.mu.mem_read(P, 0x40))
    if mod.mode == 0xA5 and mod.disable != 0x5A:
        assert m.stop == RET and out[0] == 1 and mem[0:2] == struct.pack('<H', ICON_DISP) and mem[8] == 0 and mem[0x20:0x22] == struct.pack('<H', T_CENTER)
        assert mem[2:8] == b'\xcc' * 6 and mem[9:0x20] == b'\xcc' * 0x17 and mem[0x22:] == b'\xcc' * 0x1e
    else: assert m.stop == GUIDE + 4 and out[0:12] == r[0:12] and out[12] == r[13] and out[14] == r[14] and mem == b'\xcc' * 0x40
    assert out[4:12] == r[4:12] and out[13] == r[13] and m.log == [] and m.st() == mod.pack()
    n += 1
# the camera's own items 38 (the guide) and 36 (in its place otherwise), through the hook
m2 = M(img, real_items=True)
V38, V36, VA2, VB2 = 0x5a001000, 0x5a001100, 0x5a001200, 0x5a001300
m2.mu.mem_write(LV + 0x15c + 4 * 38, struct.pack('<I', V38)); m2.mu.mem_write(LV + 0x15c + 4 * 36, struct.pack('<I', V36)); m2.mu.mem_write(LV + 0x2cc, struct.pack('<II', VA2, VB2))
m2.mu.mem_write(STACK_GUARD, struct.pack('<I', 0xdeadbeef))


def guide_rec(r):
    sp = m2.mu.reg_read(UC_ARM_REG_SP); a = bytes(m2.mu.mem_read(r(2), 11)); s0, s1 = struct.unpack('<II', m2.mu.mem_read(sp, 8))
    return (('GUIDE', r(0), r(1), a.split(b'\0')[0], r(3), s0, s1), 0)


m2.rec[OSD_SET_GUIDE] = guide_rec
m2.rec[VIEW_SHOW] = lambda r: (('SHOW', r(0), r(1)), 0)
m2.rec[GUIDE + 4] = lambda r: (('CAMERA',), 0)                        # the camera's own content function: no guide
m2.rec[GET_VIEW_MODEL] = lambda r: (None, APP)
m2.rec[STACK_FAIL] = lambda r: (('STACK',), 0)
m2.rec[ITEM36_CONTENT] = lambda r: (('CONTENT',), 1)                  # item 36's own content


def item(pc, i, shown, mode):
    stt = bytearray(0x2c); stt[0] = mode; m2.setst(stt)
    r = [0x1000 + k for k in range(15)]; r[0] = LV; r[1] = i; r[2] = shown; r[13] = 0x10080000; r[14] = RET
    out, _ = m2.run(pc, r)
    assert m2.stop == RET and out[4:12] == r[4:12] and out[13] == r[13] and not [l for l in m2.log if l[0] in ('BAD', 'ERR', 'STACK')], (m2.log, hex(m2.stop or 0))
    return list(m2.log)


assert item(ITEM38, 38, 1, 0xA5) == [('GUIDE', V38, ICON_DISP, b'', T_CENTER, 0, 0), ('SHOW', V38, 1)]
assert item(ITEM38, 38, 1, 0) == [('CAMERA',), ('SHOW', V38, 0)]
assert item(ITEM38, 38, 0, 0xA5) == [('SHOW', V38, 0)]
a = item(ITEM36, 36, 1, 0xA5)
assert [l for l in a if l[0] == 'SHOW'] == [('SHOW', V36, 0), ('SHOW', VB2, 0), ('SHOW', VA2, 0)] and ('CAMERA',) not in a, a
a = item(ITEM36, 36, 1, 0)
assert ('CAMERA',) in a and ('CONTENT',) in a, a
print(f'H. key guide: {n}; the camera\'s items 38 and 36 show the guide and make room for it')

# ---- I
m.mu.mem_write(ADJ + 0x1f8, struct.pack('<I', LISTV)); n = 0
for i in range(0, 4):
    m.setst(Model().pack()); r = regs0(); r[0] = ADJ; r[1] = i
    out, cpsr = m.run(H['draw'], r)
    assert m.stop == RET and m.log == [('ITEM', LISTV, i), ('TEXT', ITEM, {0: T_OFF, 1: T_ADJUST}.get(i, 0))], m.log; n += 1
for t in range(4000):
    mod = Model(); mod.pend = rng.choice([0, 0xA5, rng.getrandbits(8)]); mod.mode = rng.choice([0, 0, 0xA5]); mod.vx = rng.choice([0, 0, 3]); m.setst(mod.pack())
    i = rng.randrange(0, 4); r = regs0(); r[0] = ADJ; r[1] = i
    out, cpsr = m.run(H['current'], r); assert m.stop == RET and out[0] == int(i == (1 if mod.pend == 0xA5 else 0)) and m.st() == mod.pack()
    r = regs0(); r[0] = ADJ; out, cpsr = m.run(H['count'], r); assert out[0] == 2
    n += 1
mp = M(plain)


def lookup(mach, pc, r1, r2):
    """A name / icon lookup run to its return: the value, or where it fails."""
    r = [0] * 15; r[0] = 0x5a008000; r[1] = r1; r[2] = r2; r[13] = 0x10080000; r[14] = RET
    out, _ = mach.run(pc, r)
    return out[0] if mach.stop == RET and not mach.log else ('?', mach.log)


for fn in range(0, 0x40):
    for var in (0, 1, 2):
        got = (lookup(m, ADJ_NAME_OF, fn, 0), lookup(m, ADJ_ICON_OF, fn, var))
        if fn == adj_fn: assert got == (T_NAME, ICON if var == 0 else 0), got
        else: assert got == (lookup(mp, ADJ_NAME_OF, fn, 0), lookup(mp, ADJ_ICON_OF, fn, var)), (fn, var, got)
        got = (lookup(m, FN_NAME_OF, fn, 0), lookup(m, FN_ICON_OF, fn, var))
        if fn == FN: assert got == (T_NAME, ICON if var == 0 else 0), got
        else: assert got == (lookup(mp, FN_NAME_OF, fn, 0), lookup(mp, FN_ICON_OF, fn, var)), (fn, var, got)
        n += 1
lst = lambda d, low, high, length: d[mov16(d, low, high) - BASE:mov16(d, low, high) - BASE + (u32(d, length) & 0xff)]
assert lst(img, ADJ_LIST_LOW, ADJ_LIST_HIGH, ADJ_LIST_LENGTH) == lst(plain, ADJ_LIST_LOW, ADJ_LIST_HIGH, ADJ_LIST_LENGTH) + bytes([adj_fn])
print(f'I. ADJ function 0x{adj_fn:x}: handlers, name and icon, the list of ADJ Mode Setting; the other functions as without the option ({n})')

# ---- J
assert lst(img, HELD_LOW, HELD_HIGH, HELD_LENGTH) == lst(plain, HELD_LOW, HELD_HIGH, HELD_LENGTH) + bytes([FN])
assert [u32(plain, fn_record + o) for o in (0x0c, 0x14, 0x24, 0x2c)] == FN_LIST if select < OFFICIAL_END else True
W = {k: u32(img, fn_record + o) for k, o in (('count', 0x0c), ('draw', 0x14), ('set', 0x24), ('current', 0x2c))}
assert all(v >= OFFICIAL_END for v in W.values())
n = 0
for cnt in (39, 40, 1, 0, 200):
    m.mu.mem_write(CTRL + 0x1b4, struct.pack('<II', 0x5a009000, 0x5a009000 + cnt))
    r = regs0(); r[0] = CTRL; out, cpsr = m.run(W['count'], r); assert m.stop == RET and out[0] == (cnt + 1) & 0xff and m.log == []
    for i in list(range(0, cnt))[:45] + [cnt]:
        for saved in (0x2c, FN):
            m.mu.mem_write(SETTINGS + 0x925, bytes([saved]))
            r = regs0(); r[0] = CTRL; r[1] = ITEM; r[2] = i; out, cpsr = m.run(W['draw'], r)
            assert m.stop == RET and m.log == ([('ORIG', FN_LIST[1], CTRL, ITEM, i)] if i < cnt else [('ROW', ITEM, ICON, T_NAME)]), (m.log, i, cnt)
            assert out[4:12] == r[4:12] and out[13] == r[13]
            r = regs0(); r[0] = CTRL; r[1] = i; out, cpsr = m.run(W['set'], r)
            if i < cnt: assert m.stop == RET and len(m.log) == 1 and m.log[0][:4] == ('ORIG', FN_LIST[2], CTRL, i) and out[0] == 0x55
            else: assert m.stop == RET and m.log == [('GETSET', APP), ('SETFN', SETT, FN)] and out[0] == 0x77
            assert out[4:12] == r[4:12] and out[13] == r[13]
            r = regs0(); r[0] = CTRL; r[1] = i; out, cpsr = m.run(W['current'], r)
            if i < cnt: assert m.stop == RET and len(m.log) == 1 and m.log[0][:4] == ('ORIG', FN_LIST[3], CTRL, i) and out[0] == 0x55
            else: assert m.stop == RET and m.log == [] and out[0] == int(saved == FN)
            assert out[4:12] == r[4:12] and out[13] == r[13]
            n += 1


def leaves(d, bound, register, value):
    """Where a function switch goes with `value`: the first address below the official end that is not its bounds check."""
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, (len(d) + 0xfffff) & ~0xfffff); mu.mem_write(BASE, d); mu.mem_map(0x10000000, 0x100000)
    mu.reg_write(UC_ARM_REG_SP, 0x10080000); mu.reg_write(register, value); mu.reg_write(UC_ARM_REG_R6, 1)
    out = []

    def code(uc, addr, size, ud):
        if addr < OFFICIAL_END and addr not in (bound, bound + 4, bound + 8): out.append(addr); uc.emu_stop()
    mu.hook_add(UC_HOOK_CODE, code)
    try: mu.emu_start(bound, 0, count=200)
    except UcError as e: out.append(str(e))
    return out[0] if out else None


for bound, register, end in SWITCHES:
    for v in list(range(0, 0x40)) + [0xff, 0x12e]:
        got = leaves(img, bound, register, v)
        if v == FN: assert got == end, (hex(bound), hex(got))
        else: assert got == leaves(plain, bound, register, v) and got is not None, (hex(bound), v)
        n += 1
print(f'J. Fn function 0x{FN:x}: the Fn button\'s list, the held Movie button\'s list, the three switches ({n})')
print('ok')
