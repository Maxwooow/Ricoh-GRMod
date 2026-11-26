# SPDX-License-Identifier: GPL-2.0-only
"""Halation for every look (option halationAll: halation-all.ts, slot_params.c built with SP_EXT) in a built GR IV
1.20 RTOS.

Runs the patched RTOS in this release's emulator (../aspect/boot_checks.py, Machine), as test_wb_per_look.py:

 1. the parameter screens' row tables: every look group of every photo set has one Halation row (kind 8), shown for
    stills only; RAW development's lists have it, and every RAW development look may set parameter 8;
 2. parameter 8 through the firmware's own getter and setter (hooked by the module): a factory look other than Cinema
    keeps its setting in the module per photo set, Cinema Green and the added looks keep theirs where they did;
 3. the module's answers for the development step (`sp_hal_now`) and the parameter screens (`sp_hal_ui`);
 4. the development step's hook: the look and level it leaves for the JPEG step when shooting (a factory look's
    setting from the module, a Cinema or added look's from the picture's record), in RAW development (the record's),
    and the white glow for a black-and-white look;
 5. settings save and load: the halation table in record 13 and back.

    python3 tools/gr4v121/slotparams/test_halation_all.py RTOS

RTOS: the decoded RTOS section of a 1.20 build with added slots and halationAll. Needs unicorn.
"""
import os, sys, struct, random
from pathlib import Path
ASPECT = str(Path(__file__).resolve().parent.parent / 'aspect'); sys.path.insert(0, ASPECT); os.chdir(ASPECT)
src = open(os.path.join(ASPECT, 'boot_checks.py')).read()
src = src[:src.index("\nif __name__ == '__main__':")]
import types
bc = types.ModuleType('boot_checks'); bc.__file__ = os.path.join(ASPECT, 'boot_checks.py')
exec(compile(src, bc.__file__, 'exec'), bc.__dict__)
from unicorn import UC_PROT_ALL, UC_HOOK_INTR
from unicorn import arm_const as reg

# GR IV 1.20 addresses (slots.ts, halation-all.ts, halation-ui.ts, lookstash.ts, slot_params.c).
SETTINGS = 0x550832a8
SLOT_STATE = 0x55839020
P8_GET, P8_SET = 0x533ccb10, 0x533c3348        # parameter 8 getter and setter (hooked by the module)
LOOK_SITE = 0x5393a710                         # the development step's read of the look (hooked)
LOOK_STASH, FRAME_LOOK = 0x55839024, 0x55839038
SLIDER_POS = 0x531cc87c                        # halation-ui.ts: the slider position hook, first `bl` = current setting
SHOOT_ROWS, RAW_ROWS, RAW_HAS = 0x53dc61a4, 0x53dc5ee4, 0x53de7860
HEAP_ALLOC, HEAP_FREE = 0x53909154, 0x53909190
STORAGE, STORE_WRITE, STORE_READ, STORE_SIZE = 0x53aaab54, 0x53aa7d2c, 0x53aa7c48, 0x53aa7aec
SETTINGS_LOAD, SETTINGS_SAVE = 0x533f3b7c, 0x533f3f9c
BASE = 0x53000000
# State layout from the compiler (offsetof in slot_params.c with SP_EXT).
MAGIC, ST_XDIRTY, ST_HAL, SIZEOF_STATE, EXT_WORDS = 0x50534c54, 0x8EC, 0x10A4, 0x3120, 534
EXTRA, EXTRA_LEN = 0x55400000, 0x500000
HEAP, FAKE_STATE = 0x55600000, 0x558F0000
STOP = 0x53100000 + 0x4000

patched = open(sys.argv[1], 'rb').read()
def img(a, n): return patched[a - BASE:a - BASE + n]
def iw(a): return struct.unpack('<I', img(a, 4))[0]
def target(at, w): return at + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4

checks = []
def check(what, ok):
    checks.append(what); print(('ok    ' if ok else 'FAIL  ') + what)
    if not ok: raise SystemExit(1)

# ---- 1. the row tables (static)
shoot_ok = raw_ok = True
for e in range(4 * 22):
    ptr, n = iw(SHOOT_ROWS + e * 8), iw(SHOOT_ROWS + e * 8 + 4) & 0xffff
    pairs = img(ptr, n * 2)
    rows = [(pairs[2 * i], pairs[2 * i + 1]) for i in range(n)]
    if [k for f, k in rows].count(8) != 1 or (0, 8) not in rows: shoot_ok = False
    ptr, n = iw(RAW_ROWS + e * 8), iw(RAW_ROWS + e * 8 + 4) & 0xff
    if list(img(ptr, n)).count(8) != 1: raw_ok = False
check('shooting: every look group of the four photo sets has one Halation row (kind 8), for stills only', shoot_ok)
check('RAW development: every look group has one Halation row', raw_ok)
check('RAW development: every look (1..22) may set parameter 8', all(img(RAW_HAS + l * 19 + 8, 1)[0] == 1 for l in range(1, 23)))

# ---- the emulator
m = bc.Machine(patched)
m.uc.mem_map(EXTRA, EXTRA_LEN, UC_PROT_ALL)
def on_intr(uc, intno, data):
    if intno == 2: uc.reg_write(reg.UC_ARM_REG_R0, 0)
m.uc.hook_add(UC_HOOK_INTR, on_intr)
m.reset(bc.random_state(random.Random(5)))
m.uc.mem_write(EXTRA, bytes(EXTRA_LEN))
store = {}
heap = [HEAP]
def rd(a, n): return bytes(m.uc.mem_read(a, n))
def wr(a, b): m.uc.mem_write(a, b)
def u32(a): return struct.unpack('<I', rd(a, 4))[0]
def r(n): return m.uc.reg_read(getattr(reg, 'UC_ARM_REG_R%d' % n))
def s_alloc(mm):
    n = (r(0) + 15) & ~15; a = heap[0]; heap[0] += n; wr(a, bytes(n)); bc.ret(mm, a)
def s_store_size(mm): bc.ret(mm, len(store[r(1)]) if r(1) in store else 0)
def s_store_read(mm):
    d = store.get(r(1))
    if d is None or len(d) < r(2): bc.ret(mm, 0); return
    wr(r(3), d[:r(2)]); bc.ret(mm, 1)
def s_store_write(mm): store[r(1)] = rd(r(3), r(2)); bc.ret(mm, 1)
STORE_OBJ = 0x55700000
def s_storage(mm): wr(STORE_OBJ + 0x14, struct.pack('<I', STORE_OBJ + 0x100)); bc.ret(mm, STORE_OBJ)
def native_body(mm): bc.ret(mm, 0x1234ABCD)
native_calls = []
def native_p8(mm): native_calls.append((r(1), r(2), r(3))); bc.ret(mm, 0x77)
STUBS = {HEAP_ALLOC: s_alloc, HEAP_FREE: lambda mm: bc.ret(mm, 0), STORAGE: s_storage,
         STORE_WRITE: s_store_write, STORE_READ: s_store_read, STORE_SIZE: s_store_size,
         SETTINGS_LOAD + 4: native_body, SETTINGS_SAVE + 4: native_body,
         # past the module's hooks: the firmware's own parameter 8 getter and setter (Cinema's fields)
         P8_GET + 4: native_p8, P8_SET + 4: native_p8}

def call(addr, *args, stack=(), stop=STOP, setup=None):
    for i, v in enumerate(args): m.uc.reg_write(getattr(reg, 'UC_ARM_REG_R%d' % i), v)
    sp = bc.STACK + bc.STACK_SIZE - 0x1000
    for i, v in enumerate(stack): wr(sp + 4 * i, struct.pack('<I', v))
    m.uc.reg_write(reg.UC_ARM_REG_SP, sp)
    m.uc.reg_write(reg.UC_ARM_REG_LR, STOP)
    m.uc.reg_write(reg.UC_ARM_REG_CPSR, 0x13)
    if setup: setup()
    m.stubs = STUBS
    problem = m.run(addr, lambda pc: pc == stop, limit=2_000_000)
    m.stubs = {}
    assert not problem, "call %#x: %s (lr=%#x)" % (addr, problem, m.uc.reg_read(reg.UC_ARM_REG_LR))
    return r(0)

wr(0x55083244, struct.pack('<I', u32(0x55083244) | 1))   # the settings object is constructed
wr(FAKE_STATE, bytes(SIZEOF_STATE)); wr(FAKE_STATE, struct.pack('<III', MAGIC, 1, 0)); wr(SLOT_STATE, struct.pack('<I', FAKE_STATE))
STD, MONO, CY, CG, ADDED0 = 11, 13, 18, 19, 38
def hal(style, s): return rd(FAKE_STATE + ST_HAL + style * 4 + s, 1)[0]

# ---- 2. parameter 8 through the firmware's getter and setter
call(P8_SET, SETTINGS, 0, 0, STD, stack=(5,))
check('setter, Standard, photo set 0: kept in the module (Medium white), not by the firmware', hal(STD, 0) == 5 and not native_calls and u32(FAKE_STATE + ST_XDIRTY) == 1)
call(P8_SET, SETTINGS, 0, 2, STD, stack=(2,))
check('setter, Standard, photo set 2: its own entry', hal(STD, 2) == 2 and hal(STD, 0) == 5)
check('getter, Standard: the module\'s value per photo set', call(P8_GET, 0, 0, 0, STD) == 5 and call(P8_GET, 0, 0, 2, STD) == 2 and call(P8_GET, 0, 0, 1, STD) == 0)
call(P8_SET, SETTINGS, 0, 0, MONO, stack=(1,))
check('setter, Monotone (black and white): kept in the module as set', hal(MONO, 0) == 1)
native_calls.clear()
check('getter, Cinema Green: the firmware\'s own field', call(P8_GET, 0, 0, 0, CG) == 0x77 and native_calls == [(0, 0, CG)])
native_calls.clear(); call(P8_SET, SETTINGS, 0, 0, CG, stack=(3,))
check('setter, Cinema Green: the firmware\'s own field', native_calls and native_calls[-1][2] == CG and hal(CG, 0) == 0)
native_calls.clear()
check('getter, movies: the firmware (no halation for movies)', call(P8_GET, 0, 1, 0, STD) == 0x77)

# ---- 3. sp_hal_now / sp_hal_ui
stash_code = target(LOOK_SITE, iw(LOOK_SITE))
words = [iw(stash_code + 4 * i) for i in range(64)]
def movw_movt(ws, reg_no):
    for i in range(len(ws) - 1):
        a, b = ws[i], ws[i + 1]
        if (a & 0x0ff00000) == 0x03000000 and (b & 0x0ff00000) == 0x03400000 and ((a >> 12) & 15) == reg_no == ((b >> 12) & 15):
            lo = ((a >> 4) & 0xf000) | (a & 0xfff); hi = ((b >> 4) & 0xf000) | (b & 0xfff)
            yield i, lo | (hi << 16)
ptrs = [v for i, v in movw_movt(words, 12) if 0x53000000 <= v < 0x55000000]
check('the development step\'s hook names a word holding sp_hal_now, and the black-and-white table', len(ptrs) >= 2)
HAL_NOW = u32(ptrs[0]); MONO_TABLE = ptrs[1]
check('the black-and-white table has Monotone and not Standard', img(MONO_TABLE + MONO, 1)[0] == 1 and img(MONO_TABLE + STD, 1)[0] == 0)
def setup_set(s, style):
    def f():
        wr(SETTINGS + 0x152, bytes([s])); wr(SETTINGS + 0x153 + s, bytes([style]))
    return f
check('sp_hal_now: Standard in photo set 0 -> its setting', call(HAL_NOW, STD, setup=setup_set(0, STD)) == 5)
check('sp_hal_now: photo set 2 in use -> that set\'s', call(HAL_NOW, STD, setup=setup_set(2, STD)) == 2)
check('sp_hal_now: Cinema and added looks -> 0x100 (the record has it)', call(HAL_NOW, CY) == 0x100 and call(HAL_NOW, CG) == 0x100 and call(HAL_NOW, ADDED0) == 0x100)
hook = target(SLIDER_POS, iw(SLIDER_POS)); HAL_UI = target(hook, iw(hook))
check('sp_hal_ui: the screens\' current setting is the look of the photo set in use', call(HAL_UI, setup=setup_set(0, STD)) == 5 and call(HAL_UI, setup=setup_set(2, STD)) == 2)

# ---- 4. the development step's hook
STEP, RECORD = 0x55740000, 0x55750000
def develop(shooting, look, toning, s=0, style=None):
    def f():
        wr(STEP, bytes(0x400)); wr(RECORD, bytes(0x800))
        wr(STEP + 0x2ac, bytes([1 if shooting else 0])); wr(STEP + 0x2d0, struct.pack('<I', RECORD))
        wr(RECORD + 0x79c, bytes([look])); wr(RECORD + 0x7a6, bytes([toning]))
        setup_set(s, look if style is None else style)()
        wr(LOOK_STASH, bytes(4)); wr(FRAME_LOOK, bytes(4))
    call(stash_code, 0, STEP, 0, RECORD, setup=f, stop=LOOK_SITE + 4)
    w = u32(LOOK_STASH)
    return w & 0xff, (w >> 8) & 0xff, bool(w & 0x20000), bool(w & 0x10000)
check('shooting, Standard (set 0: Medium white): look 11, level 2, white', develop(True, STD, 0) == (STD, 2, True, True))
check('shooting, Standard, the record\'s Toning is not used', develop(True, STD, 2, s=2) == (STD, 3, False, True))
check('shooting, Monotone set to Weak red: the white glow', develop(True, MONO, 0) == (MONO, 1, True, True))
check('shooting, Cinema Yellow: the record\'s setting (Strong red)', develop(True, CY, 2) == (CY, 3, False, True))
check('shooting, an added look: the record\'s setting (Medium white)', develop(True, ADDED0, 5) == (ADDED0, 2, True, True))
check('RAW development, Standard: the record\'s setting (Strong white)', develop(False, STD, 6) == (STD, 3, True, True))
check('RAW development, Monotone with red: white', develop(False, MONO, 3) == (MONO, 2, True, True))
check('a setting of Off: level 0', develop(True, CY, 7) == (CY, 0, False, True))

# ---- 5. save and load
wr(FAKE_STATE + 8, struct.pack('<I', 1))
call(SETTINGS_SAVE, 0x55710000)
ext = store.get(13)
check('settings save writes record 13 with the halation table', ext is not None and len(ext) == EXT_WORDS * 4 and ext[8 + 1972 + STD * 4] == 5 and ext[8 + 1972 + STD * 4 + 2] == 2 and ext[8 + 1972 + MONO * 4] == 1)
wr(SLOT_STATE, b'\0' * 4)
cur = 0x55720000; wr(cur, rd(SETTINGS + 4, 0x800))
MODE_OBJ = 0x55730000; wr(MODE_OBJ, bytes(0x100))
call(SETTINGS_LOAD, MODE_OBJ, cur, 0, 0)
st = u32(SLOT_STATE)
check('settings load: the halation table comes back', st >= HEAP and rd(st + ST_HAL + STD * 4, 4) == bytes([5, 0, 2, 0]) and rd(st + ST_HAL + MONO * 4, 1) == b'\x01')
print('all %d checks passed' % len(checks))
