# SPDX-License-Identifier: GPL-2.0-only
"""White balance per look (option wbPerLook, slot_params.c built with SP_EXT) in a built GR IV 1.20 RTOS.

Runs the patched RTOS in this release's emulator (../aspect/boot_checks.py, Machine): the hooked "style of
set" and "photo set in use" setters, the slot-parameters module, the firmware's WB setters and their own
code all run as built. Stubbed: the heap (bump allocator), free, the settings store (record 12 kept in a
dict) and the two change-notification calls (no listeners: what the rest of the camera does with a WB
change is only seen on the camera). Settings save / load go through their real entries with the native
body stubbed, as the boot checks' settings test does. Checks a look change in the photo set in use and
in another set, a change of the photo set in use, save and load (record 12 stays version 4, the white
balances go to record 13), and PR #57's own version 5 record (its table and white balances taken, then
written as version 4 and record 13).

    python3 tools/gr4v121/slotparams/test_wb_per_look.py RTOS

RTOS: the decoded RTOS section of a 1.20 build with added slots and wbPerLook. Needs unicorn.
"""
import os, sys, struct, random
from pathlib import Path
ASPECT = str(Path(__file__).resolve().parent.parent / 'aspect'); sys.path.insert(0, ASPECT); os.chdir(ASPECT)
src = open(os.path.join(ASPECT, 'boot_checks.py')).read()
src = src[:src.index("\nif __name__ == '__main__':")]
import types
bc = types.ModuleType('boot_checks'); bc.__file__ = os.path.join(ASPECT, 'boot_checks.py')
exec(compile(src, bc.__file__, 'exec'), bc.__dict__)
from unicorn import UC_PROT_ALL
from unicorn import arm_const as reg

# GR IV 1.20 addresses (slots.ts, slot_params.c, gen_slotparams.py).
SETTINGS = 0x550832a8             # settings_object
SLOT_STATE = 0x55839020
STYLE_SET = [0x532bc6d4, 0x532bc864]   # "style of set" setters, photo standard and custom 1 (hooked)
ACTIVE_SET = 0x532bc544           # StillActiveImageControlSet setter (hooked)
WB_MODE_SETTER, WB_GM_DAYLIGHT, WB_TEMP = 0x532b8848, 0x532b8e78, 0x532bb538
HEAP_ALLOC, HEAP_FREE = 0x53909154, 0x53909190
STORAGE, STORE_WRITE, STORE_READ, STORE_SIZE = 0x53aaab54, 0x53aa7d2c, 0x53aa7c48, 0x53aa7aec
SETTINGS_LOAD, SETTINGS_SAVE = 0x533f3b7c, 0x533f3f9c
# State layout from the compiler (offsetof in slot_params.c with SP_EXT):
MAGIC, ST_LOADED, ST_DIRTY, ST_T, ST_XDIRTY, ST_HAVE, ST_WB, ST_HAL, SIZEOF_STATE = 0x50534c54, 4, 8, 0x10, 0x8EC, 0x8F0, 0x92A, 0x10A4, 0x3120
WB_FIRST, WB_BYTES, REC_WORDS, REC_WORDS_V5, EXT_WORDS = 0x11D, 33, 571, 1064, 534
EXTRA, EXTRA_LEN = 0x55400000, 0x500000
HEAP, FAKE_STATE = 0x55600000, 0x558F0000
STOP = 0x53100000 + 0x4000

patched = open(sys.argv[1], 'rb').read()
m = bc.Machine(patched)
m.uc.mem_map(EXTRA, EXTRA_LEN, UC_PROT_ALL)
# No RTOS in the emulator: every system call (svc) is logged and returns 0 (E_OK).
from unicorn import UC_HOOK_INTR
syscalls = {}
def on_intr(uc, intno, data):
    if intno != 2: return
    svc = struct.unpack('<I', bytes(uc.mem_read(uc.reg_read(reg.UC_ARM_REG_PC) - 4, 4)))[0] & 0xffffff
    key = (svc, uc.reg_read(reg.UC_ARM_REG_R12))
    syscalls[key] = syscalls.get(key, 0) + 1
    uc.reg_write(reg.UC_ARM_REG_R0, 0)
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
    d = store.get(r(1));
    if d is None or len(d) < r(2): bc.ret(mm, 0); return
    wr(r(3), d[:r(2)]); bc.ret(mm, 1)
def s_store_write(mm): store[r(1)] = rd(r(3), r(2)); bc.ret(mm, 1)
STORE_OBJ = 0x55700000
def s_storage(mm): wr(STORE_OBJ + 0x14, struct.pack('<I', STORE_OBJ + 0x100)); bc.ret(mm, STORE_OBJ)
def native_body(mm): bc.ret(mm, 0x1234ABCD)
STUBS = {HEAP_ALLOC: s_alloc, HEAP_FREE: lambda mm: bc.ret(mm, 0), STORAGE: s_storage,
         STORE_WRITE: s_store_write, STORE_READ: s_store_read, STORE_SIZE: s_store_size,
         SETTINGS_LOAD + 4: native_body, SETTINGS_SAVE + 4: native_body,
         # The change notifications (queue a change, collect the listeners): no listeners here. What the
         # rest of the camera does with a WB change can only be seen on the camera.
         0x532afbf0: lambda mm: bc.ret(mm, 0), 0x532af890: lambda mm: bc.ret(mm, 0)}

def call(addr, *args):
    for i, v in enumerate(args): m.uc.reg_write(getattr(reg, 'UC_ARM_REG_R%d' % i), v)
    m.uc.reg_write(reg.UC_ARM_REG_SP, bc.STACK + bc.STACK_SIZE - 0x1000)
    m.uc.reg_write(reg.UC_ARM_REG_LR, STOP)
    m.uc.reg_write(reg.UC_ARM_REG_CPSR, 0x13)
    m.stubs = STUBS
    problem = m.run(addr, lambda pc: pc == STOP, limit=2_000_000)
    m.stubs = {}
    assert not problem, "call %#x: %s (lr=%#x)" % (addr, problem, m.uc.reg_read(reg.UC_ARM_REG_LR))
    return r(0)

def wb(): return rd(SETTINGS + WB_FIRST, WB_BYTES)
def style(c): return rd(SETTINGS + 0x153 + c, 1)[0]
def have(look): return rd(FAKE_STATE + ST_HAVE + look, 1)[0]
def saved(look): return rd(FAKE_STATE + ST_WB + look * WB_BYTES, WB_BYTES)
checks = []
def checksum(words):   # slot_params.c checksum()
    v = 0x6a09e667
    for i, x in enumerate(words): v = (((v ^ x) * 0x01000193) + i) & 0xffffffff
    return v
def check(what, ok):
    checks.append(what); print(('ok    ' if ok else 'FAIL  ') + what)
    if not ok: raise SystemExit(1)

# The settings object is a C++ function-local static (accessor 0x53241240): mark it constructed (guard
# word 0x55083244, bit 0), as it is long before any menu change on the camera.
wr(0x55083244, struct.pack('<I', u32(0x55083244) | 1))
# A loaded module (as after the first settings load), no WB remembered yet.
wr(FAKE_STATE, bytes(SIZEOF_STATE)); wr(FAKE_STATE, struct.pack('<III', MAGIC, 1, 0)); wr(SLOT_STATE, struct.pack('<I', FAKE_STATE))
STD, CY, ADDED0, ADDED1 = 11, 18, 38, 39
wr(SETTINGS + 0x152, b'\x00'); wr(SETTINGS + 0x153, bytes([STD])); wr(SETTINGS + 0x154, bytes([ADDED0]))
P0 = bytes(random.Random(1).randrange(0, 9) for _ in range(WB_BYTES)); wr(SETTINGS + WB_FIRST, P0)

call(STYLE_SET[0], SETTINGS, CY)
check('look change in the active set: the look is now Cinema Yellow', style(0) == CY)
check('the old look (Standard) remembers its WB', have(STD) == 1 and saved(STD) == P0)
check('a look never used before keeps the WB in the settings', wb() == P0 and have(CY) == 0)

call(WB_MODE_SETTER, SETTINGS, 4); call(WB_GM_DAYLIGHT, SETTINGS, 7); call(WB_TEMP, SETTINGS, 0x1234)
P1 = wb()
check('the firmware WB setters changed the WB (mode, Daylight G-M, colour temperature)', P1 != P0 and P1[0] == 4 and P1[4] == 7 and P1[31:33] == b'\x34\x12')

call(STYLE_SET[0], SETTINGS, STD)
check('back to Standard: Cinema Yellow remembers its WB', have(CY) == 1 and saved(CY) == P1)
check('back to Standard: all 33 bytes of Standard\'s WB restored through the setters', wb() == P0)
call(STYLE_SET[0], SETTINGS, CY)
check('to Cinema Yellow again: its WB restored', wb() == P1)

call(STYLE_SET[1], SETTINGS, ADDED1)
check('look change in a set not in use: WB unchanged, nothing remembered', style(1) == ADDED1 and wb() == P1 and have(ADDED0) == 0 and have(ADDED1) == 0)

call(ACTIVE_SET, SETTINGS, 1)
check('photo set in use 0 -> 1: active look is the added look, which keeps the WB in the settings', rd(SETTINGS + 0x152, 1)[0] == 1 and wb() == P1)
call(WB_MODE_SETTER, SETTINGS, 2); P2 = wb()
call(ACTIVE_SET, SETTINGS, 0)
check('photo set in use 1 -> 0: the added look remembers its WB, Cinema Yellow\'s comes back', have(ADDED1) == 1 and saved(ADDED1) == P2 and wb() == P1)

check('a WB change marks the extended record for writing', u32(FAKE_STATE + ST_XDIRTY) == 1)
wr(FAKE_STATE + ST_DIRTY, struct.pack('<I', 1))
call(SETTINGS_SAVE, 0x55710000)
rec = store.get(12)
check('settings save writes record 12 as every build reads it (version 4, %d words)' % REC_WORDS, rec is not None and len(rec) == REC_WORDS * 4)
w = struct.unpack('<%dI' % REC_WORDS, rec)
check('record 12: magic GRP2, version 4, checksum valid', w[0] == 0x32505247 and w[1] == 4 and w[-1] == checksum(w[:-1]))
ext = store.get(13)
check('settings save writes record 13 (%d words)' % EXT_WORDS, ext is not None and len(ext) == EXT_WORDS * 4)
x = struct.unpack('<%dI' % EXT_WORDS, ext)
check('record 13: magic GRX1, its byte count, checksum valid', x[0] == 0x31585247 and x[1] == 2124 and x[-1] == checksum(x[:-1]))
wbblock = ext[8:]
check('record 13: the WB block holds Standard, Cinema Yellow and the added look', wbblock[STD] == 1 and wbblock[CY] == 1 and wbblock[ADDED1] == 1 and wbblock[58 + STD * 33:58 + STD * 33 + 33] == P0 and wbblock[58 + ADDED1 * 33:58 + ADDED1 * 33 + 33] == P2)

# A fresh start: the module loads the record it saved.
wr(SLOT_STATE, b'\0' * 4)
cur = 0x55720000; wr(cur, rd(SETTINGS + 4, 0x800))
MODE_OBJ = 0x55730000; wr(MODE_OBJ, bytes(0x100))   # settings mode: no user-mode snapshots
call(SETTINGS_LOAD, MODE_OBJ, cur, 0, 0)
st = u32(SLOT_STATE)
check('settings load at start: the module allocates its state (%#x bytes)' % SIZEOF_STATE, st >= HEAP and u32(st) == MAGIC)
check('settings load: the remembered WB of each look comes back from record 13', all(rd(st + ST_HAVE + k, 1)[0] == wbblock[k] for k in range(58)) and rd(st + ST_WB + CY * 33, 33) == P1)
check('settings load: record 13 read, nothing of it to write back', u32(st + ST_XDIRTY) == 0)

# PR #57's own record 12, version 5 (table + WB block), no record 13: taken, and written as version 4 + record 13.
t_saved = rd(st + ST_T, 2184)
ST_FP = 0x898
fp_now = struct.unpack('<21I', rd(st + ST_FP, 84))
check('the loaded state has this build\'s fingerprints for the 7 added looks', all(fp_now[1:8]))
v5 = [w[0], 5, w[2], *fp_now, *struct.unpack('<%dI' % (2184 // 4), t_saved), *struct.unpack('<%dI' % (1972 // 4), wbblock[:1972])]
v5.append(checksum(v5))
store[12] = struct.pack('<%dI' % len(v5), *v5); del store[13]
check('version 5 record has its size (%d words)' % REC_WORDS_V5, len(store[12]) == REC_WORDS_V5 * 4)
wr(SLOT_STATE, b'\0' * 4); call(SETTINGS_LOAD, MODE_OBJ, cur, 0, 0); st = u32(SLOT_STATE)
check('version 5 record: the parameter table is kept', rd(st + ST_T, 2184) == t_saved)
check('version 5 record: the white balances are kept', all(rd(st + ST_HAVE + k, 1)[0] == wbblock[k] for k in range(58)) and rd(st + ST_WB + CY * 33, 33) == P1)
check('version 5 record: both records marked for writing', u32(st + ST_DIRTY) == 1 and u32(st + ST_XDIRTY) == 1)
call(SETTINGS_SAVE, 0x55710000)
check('after the save: record 12 is version 4 again and record 13 holds the white balances', len(store[12]) == REC_WORDS * 4 and struct.unpack('<2I', store[12][:8])[1] == 4 and store.get(13, b'')[8:8 + 58 + 58 * 33] == wbblock[:58 + 58 * 33])
print('all %d checks passed' % len(checks))
print('RTOS calls answered with 0:', {f'svc {a} ip={b:#x}': n for (a, b), n in sorted(syscalls.items())})
