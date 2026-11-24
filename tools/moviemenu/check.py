# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the two movie-menu options, GR IV 1.20 and 1.21: 4K movies (build option movie4k,
core/src/fw/gr4v120/aspect/movie4k.ts) and the shake reduction for movies by sensor shift (movieSr, moviesr.ts).
Both releases' addresses are written here: [1.20, 1.21].

NOT part of the program. Runs the firmware's own functions in Unicorn, on a build without the options and on a
build with them (the calls they make out replaced by recorders):

  A. the image: below the official end the two builds differ only at the places the two files name;
  B. the state for the shake reduction unit (0x537BB254), still / movie, both settings, the Sensor Shift bit, Movie
     SR in effect (and the composition adjustment holding the sensor, when Sensor Shift is in the build): a still as
     without the options; a movie reports field 0x13 exactly for "Sensor Shift" and field 0x14 as before;
  C. the margin (0x5365C850 at set-up, 0x5365AB38 while the live view runs): as without the options but for a
     movie live view, where it is Movie SR as the camera side has it at set-up, kept until the next set-up; 1 before
     any set-up; every register but r3 as without the options;
  D. the unit's property handler: 0xFA builds the state as 0xF9 does, every other property goes where it went;
  E. Movie SR's list: three rows, their icons and texts, set (the bit, the camera's setter, the state sent),
     current; the icon of the setting on the menu line and on the screen;
  F. 4K: the setting taken where the live view is started; the switch, the sensor's drive mode and the size recorded follow it, for 60p / 30p / 24p, whatever the setting becomes afterwards;
  G. the Frame Rate record's set (the list's OK: 60p clears 4K, then the camera's own code; the camera's two functions that set a
     row before OK do not), the Resolution list (4K at 60p sets
     30p), the menu line and the two submenu lines.

    python3 check.py 1.20|1.21 BUILT-WITHOUT-RTOS BUILT-WITH-RTOS [shift]      (shift: Sensor Shift is in both builds)
"""
import itertools
import random
import struct
import sys
from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import *

release, without_path, with_path = sys.argv[1:4]
with_shift = 'shift' in sys.argv[4:]
if release not in ('1.20', '1.21'): sys.exit('release: 1.20 or 1.21')
B = lambda a120, a121: a121 if release == '1.21' else a120
BASE = 0x53000000
OFFICIAL_END = BASE + B(0x140b600, 0x140ce00)
DATA_SRC = B(0x543b3100, 0x543b4900)
plain = open(without_path, 'rb').read(); img = open(with_path, 'rb').read()
u32 = lambda d, a: struct.unpack_from('<I', d, a - BASE)[0]

S = 0x550832a8
MOVIE_BYTE, FRAME_RATE, SR_KEPT, SR_LIVE = S + 0x775, S + 0x772, S + 0x77f, S + 0x12c3
LATCH, SHIFT_STATE = 0x55839044, 0x55839048
SR_HOLDER = B(0x550b9b20, 0x550b9b28)
SR_STATE, SR_SETTER, SR_STATE_MOVIE = B(0x537bb254, 0x537bbf6c), B(0x537b986c, 0x537ba584), B(0x537bb2d8, 0x537bbff0)
PROPS, GET_MODE, GET_STILL_SR, GET_MOVIE_SR, GET_RATE = B(0x53750008, 0x53750a58), B(0x5377cab8, 0x5377d748), B(0x5377db08, 0x5377e798), B(0x5377db4c, 0x5377e7dc), B(0x5377da3c, 0x5377e6cc)
MARGIN_SETUP_FN, MARGIN_SETUP_END, MARGIN_UPDATE_FN, MARGIN_UPDATE_END = B(0x5365c850, 0x5365d190), B(0x5365c8a0, 0x5365d1e0), B(0x5365ab38, 0x5365b478), B(0x5365ab98, 0x5365b4d8)
MARGIN_SETUP, MARGIN_UPDATE = B(0x5365c87c, 0x5365d1bc), B(0x5365ab70, 0x5365b4b0)
PROP_HANDLER, SR_PROPERTY = B(0x536af4bc, 0x536afdfc), B(0x536af4dc, 0x536afe1c)
PROP_TARGETS = {B(0x537bb254, 0x537bbf6c): 'state', B(0x537bb32c, 0x537bc044): 'c044', B(0x537bb360, 0x537bc078): 'c078', B(0x537bb7f4, 0x537bc50c): 'c50c', B(0x536ade88, 0x536ae7c8): 'e7c8'}
ICON_OF, LINE_ICON_CALL, SCREEN_ICON_TAIL = B(0x53390e18, 0x533916c8), B(0x531b2c78, 0x531b305c), B(0x533a6aec, 0x533a739c)
MOVIE_SR_SET, APP_GET, SETTINGS_GET, RESOURCES_GET = B(0x533337ac, 0x53333ffc), B(0x532406a4, 0x53240cac), B(0x53240c38, 0x53241240), B(0x53240f98, 0x532415a0)
LIST_SET_ITEM, LIST_TEXT_ROW, LIST_AFTER_SET = B(0x5359e1bc, 0x5359eae4), B(0x5359e0ac, 0x5359e9d4), B(0x531daa64, 0x531db06c)
SELECT_LOW, SELECT_HIGH = B(0x531d825c, 0x531d8864), B(0x531d826c, 0x531d8874)
SWITCH, DRIVE_MODE, MOVIE_SIZE = B(0x538ad500, 0x538ae1a8), B(0x536568d4, 0x53657214), B(0x538b376c, 0x538b4414)
START_SIZE_CALL, LATCH_4K = B(0x5365ba0c, 0x5365c34c), 0x55839045
DM_STUBS = [(B(0x53891e48, 0x53892af0), 0x5e000800), (B(0x53891f18, 0x53892bc0), 0), (B(0x538f83f4, 0x538f908c), 1), (B(0x538f83d8, 0x538f9070), 0), (B(0x539154f8, 0x53916230), 0), (B(0x538ade68, 0x538aeb10), 0x5e000900)]
FR_SET, FR_SET_CLOSE, FR_SET_KEPT, FRAME_RATE_SET, FRAME_RATE_TEXT = B(0x531d4d08, 0x531d5310), B(0x531dc390, 0x531dc998), B(0x531d4d38, 0x531d5340), B(0x53332cb0, 0x53333500), B(0x5338f348, 0x5338fbf8)
LINE_VALUE_TEXT, TOP_SET_TITLE, SUBMENU_LINE_TEXT = B(0x5359d740, 0x5359e068), B(0x5359d48c, 0x5359ddb4), B(0x535a64b4, 0x535a6ddc)
MOVIE_MENU, FRAME_RATE_LINE_DRAW = B(0x53dc7bd0, 0x53dc9238), B(0x531b2a0c, 0x531b2df0)
T = dict(title=1044, resolution=1045, fhd=1046, uhd=1047, uhd30=1048, uhd24=1049, sensor=1050, electronic=1051, off=2)
ICON_OFF, ICON_ON, ICON_E = 467, 469, 740
FR_MENU_ID, RES_LIST_ID, FR_LIST_ID = 0x020001e0, 0x020001e1, 0x020000a0
STOP, SCR, STK = 0x5f000000, 0x5e000000, 0x5e800000
REGS = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_R12]


def mov16(d, low, high):
    imm = lambda w: ((w >> 4) & 0xf000) | (w & 0xfff)
    return imm(u32(d, low)) | (imm(u32(d, high)) << 16)


def target(d, at):
    w = u32(d, at); off = w & 0xffffff; off -= 0x1000000 if off & 0x800000 else 0
    assert (w >> 25) & 7 == 5, hex(w)
    return at + 8 + off * 4


class Emu:
    def __init__(self, d):
        self.mu = mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, 0x0b000000); mu.mem_write(BASE, d)
        mu.mem_write(0x55000000, d[DATA_SRC - BASE:DATA_SRC - BASE + 0x58500])
        mu.mem_map(SCR, 0x01000000); mu.mem_map(STOP, 0x1000)
        self.stubs = {}; self.log = []; self.stops = {STOP}; self.stopped = None
        mu.hook_add(UC_HOOK_CODE, self._code)
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, lambda uc, access, addr, size, value, ud: self.log.append(('BAD', hex(addr), hex(uc.reg_read(UC_ARM_REG_PC)))) or False)

    def _code(self, mu, addr, size, _):
        if addr in self.stops: self.stopped = addr; mu.emu_stop(); return
        f = self.stubs.get(addr)
        if f is None: return
        v = f(self)
        if v is not None: mu.reg_write(UC_ARM_REG_R0, v & 0xffffffff)
        mu.reg_write(UC_ARM_REG_PC, mu.reg_read(UC_ARM_REG_LR))

    def r(self, i): return self.mu.reg_read(REGS[i])
    def w32(self, a, v): self.mu.mem_write(a, struct.pack('<I', v & 0xffffffff))
    def r8(self, a): return self.mu.mem_read(a, 1)[0]
    def w8(self, a, v): self.mu.mem_write(a, bytes([v & 0xff]))

    def call(self, at, args=(), regs=None, stops=(), lr=STOP):
        mu = self.mu; self.log = []; self.stopped = None; self.stops = {STOP} | set(stops)
        for i, v in enumerate(REGS): mu.reg_write(v, 0x0bad0000 + i)
        for i, v in enumerate(args): mu.reg_write(REGS[i], v)
        for i, v in (regs or {}).items(): mu.reg_write(REGS[i], v)
        mu.reg_write(UC_ARM_REG_SP, STK); mu.reg_write(UC_ARM_REG_LR, lr); mu.reg_write(UC_ARM_REG_CPSR, 0x1d3)
        self.before = [self.r(i) for i in range(13)]
        try: mu.emu_start(at, 0, count=300000)
        except UcError as e: self.log.append(('ERR', str(e), hex(mu.reg_read(UC_ARM_REG_PC))))
        assert not [l for l in self.log if l[0] in ('BAD', 'ERR')], (hex(at), self.log)
        return self.r(0)

    def kept(self, which=(4, 5, 6, 7, 8, 9, 10, 11)):
        return self.mu.reg_read(UC_ARM_REG_SP) == STK and all(self.r(i) == self.before[i] for i in which)


# ---- A: the image
select = mov16(img, SELECT_LOW, SELECT_HIGH); select_plain = mov16(plain, SELECT_LOW, SELECT_HIGH)
sr_record = select + 62 * 0x4c
named = {SR_STATE_MOVIE, SR_PROPERTY, MARGIN_SETUP, MARGIN_UPDATE, LINE_ICON_CALL, SCREEN_ICON_TAIL, SWITCH, START_SIZE_CALL}
if sr_record < OFFICIAL_END: named |= {sr_record + o for o in (0x0c, 0x14, 0x24, 0x2c)}
named |= {MOVIE_MENU + 0x8c + 12 * 8, MOVIE_MENU + 0x1bc + 12 * 4}
# may differ: the menus' shared places (the controller factory, the two "current menu" functions, the end of the official
# list records), which another addition's menu changes as well; Movie SR's record in the official table when the table is copied later
shared = {B(0x531871bc, 0x531871bc), B(0x531d7860, 0x531d7e68), B(0x531e361c, 0x531e3c24), B(0x531d87a0, 0x531d8da8)} | {B(0x53dcd470, 0x53dceb08) + 62 * 0x4c + o for o in (0x0c, 0x14, 0x24, 0x2c)}
other = []
for at in range(BASE, OFFICIAL_END, 4):
    a, b = u32(plain, at), u32(img, at)
    if a == b or at in named or at in shared: continue
    if a >= OFFICIAL_END and b >= OFFICIAL_END and a < 0x55000000 and b < 0x55000000: continue
    if (a & 0x0fb00000) == 0x03000000 and (b & 0x0fb00000) == 0x03000000 and (a & 0xf000) == (b & 0xf000): continue
    if (a >> 24) in (0xea, 0xeb) and (b >> 24) == (a >> 24) and target(plain, at) >= OFFICIAL_END and target(img, at) >= OFFICIAL_END: continue
    if (a >> 24) == 0xe2 and (b >> 24) == 0xe2 and (a ^ b) < 0x100: continue                  # a count: records of a table copied with one more
    other.append(at)
assert not other, 'unexpected differences below the official end: ' + ' '.join(hex(x) for x in other[:12])
assert all(u32(plain, at) != u32(img, at) for at in named), [hex(a) for a in named if u32(plain, a) == u32(img, a)]
print(f'A. image: {len(named)} named places differ from the build without the options; the rest below the official end is the same, a shared place of the menus or an address of the appended area')

rng = random.Random(5)
P = SCR + 0x100


def machine(d):
    e = Emu(d)
    e.w32(P + 4, 0x1234); e.w32(SR_HOLDER + 4, SCR + 0x2000); e.w32(SCR + 0x2000 + 0x60, SCR + 0x3000)
    return e


# ---- B: the state for the unit
def state(e, mode, still, movie, bit, live, held):
    e.w8(MOVIE_BYTE, bit); e.w8(SR_LIVE, live)
    st = bytearray(0x2c); st[6] = 0xA5 if held else 0; e.mu.mem_write(SHIFT_STATE, bytes(st))
    e.stubs.update({PROPS: lambda e: P, GET_MODE: lambda e: mode, GET_STILL_SR: lambda e: still, GET_MOVIE_SR: lambda e: movie})
    calls = []
    e.stubs[SR_SETTER] = lambda e: calls.append((e.r(1), e.r(2))) or None
    e.call(SR_STATE, [SCR + 0x1000])
    assert e.kept(), 'registers'
    return calls


ep, ew = machine(plain), machine(img); n = 0
for mode, still, movie, bit, live, held in itertools.product((0, 1), (0, 1), (0, 1, 7), (0, 1, 2, 3, 0xff), (0, 1), (0, 1) if with_shift else (0,)):
    got = state(ew, mode, still, movie, bit, live, held)
    if mode == 0: assert got == state(ep, mode, still, movie, bit, live, held), ('still', got)
    else:
        mech = 1 if (bit & 1) and not movie and not held else 0      # Movie SR as the camera side has it, whatever the settings' byte says
        assert got == [(0x13, mech), (0x14, 1 if movie else 0)], (mode, still, movie, bit, live, held, got)
        assert state(ep, mode, still, movie, bit, live, held) == [(0x13, 0), (0x14, 1 if movie else 0)]
    n += 1
print(f'B. the state for the unit: {n} combinations; a movie reports the sensor shift exactly for "Sensor Shift"' + (' and not while the composition adjustment holds the sensor' if with_shift else ''))


# ---- C: the margin
def margin(e, fn, end, flags, f97a4, msr):
    obj = SCR + 0x20000
    e.mu.mem_write(obj, b'\0' * 0xa000); e.w32(obj + 0x6c, flags); e.w8(obj + 0x97a4, f97a4); e.w32(obj + 0x3bc, SCR + 0x500); e.w32(obj + 0x3a4, SCR + 0x600)
    e.stubs[GET_MOVIE_SR] = lambda e: msr
    e.w8(obj + 0x874c, 0x77)
    e.call(fn, [obj], stops=[end])
    assert e.stopped == end
    return e.r8(obj + 0x874c), [e.r(i) for i in (0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12)], e.mu.reg_read(UC_ARM_REG_SP)


n = 0
for flags, f97a4, msr in itertools.product((0, 1, 2, 3), (0, 1), (0, 1, 5)):
    ew.w8(LATCH, 0)
    official = lambda fn, end, m=msr: margin(ep, fn, end, flags, f97a4, m)
    on_path = not (flags & 2) and ((flags & 1) or f97a4)
    # before any set-up: as without the options
    assert margin(ew, MARGIN_UPDATE_FN, MARGIN_UPDATE_END, flags, f97a4, msr) == official(MARGIN_UPDATE_FN, MARGIN_UPDATE_END)
    got = margin(ew, MARGIN_SETUP_FN, MARGIN_SETUP_END, flags, f97a4, msr); want = official(MARGIN_SETUP_FN, MARGIN_SETUP_END)
    assert got[1:] == want[1:] and got[0] == ((1 if msr else 0) if on_path else want[0]), (flags, f97a4, msr, got[0])
    for later in (0, 1):                            # while the live view runs, whatever Movie SR becomes
        got = margin(ew, MARGIN_UPDATE_FN, MARGIN_UPDATE_END, flags, f97a4, later); want = official(MARGIN_UPDATE_FN, MARGIN_UPDATE_END, later)
        assert got[1:] == want[1:] and got[0] == ((1 if msr else 0) if on_path else want[0]), (flags, f97a4, msr, later, got[0])
    n += 1
print(f'C. the margin: {n} combinations; for a movie live view it is Movie SR at set-up, kept while the live view runs')


# ---- D: the unit's property handler
def prop(e, number):
    """Where the handler goes with a property: the first address outside it (below the official end), and r0 there; None: it returns."""
    msg = SCR + 0x4000; obj = SCR + 0x5000
    e.mu.mem_write(msg, struct.pack('<IHH', 0, number, 0)); e.w32(obj + 0x60, SCR + 0x3000)
    out = []

    def leave(mu, addr, size, _):
        if addr < OFFICIAL_END and not (PROP_HANDLER <= addr < PROP_HANDLER + 0x1a0): out.append((addr, mu.reg_read(UC_ARM_REG_R0))); mu.emu_stop()
    h = e.mu.hook_add(UC_HOOK_CODE, leave)
    e.call(PROP_HANDLER, [obj, msg])
    e.mu.hook_del(h)
    return out[0] if out else None


n = 0
for number in range(0, 0x140):
    got = prop(ew, number)
    if number == 0xfa: assert got == (SR_STATE, SCR + 0x3000) == prop(ew, 0xf9) and prop(ep, number) is None, got
    else: assert got == prop(ep, number), (hex(number), got)
    n += 1
print(f'D. property handler: 0xFA builds the state; the other {n - 1} properties as without the options')

# ---- E: Movie SR's list and icons
H = {k: u32(img, sr_record + o) for k, o in (('count', 0x0c), ('draw', 0x14), ('set', 0x24), ('current', 0x2c))}
assert all(v >= OFFICIAL_END for v in H.values())
assert u32(img, sr_record) == 0x00010000 and u32(img, sr_record + 4) & 0xffff == 415
assert ew.call(H['count'], [SCR]) == 3
rows = []
ew.stubs[LIST_SET_ITEM] = lambda e: rows.append((e.r(0), e.r(1), e.r(2))) or None
for i in range(5): ew.call(H['draw'], [SCR, SCR + 0x700, i])
assert rows == [(SCR + 0x700, ICON_OFF, T['off']), (SCR + 0x700, ICON_ON, T['sensor']), (SCR + 0x700, ICON_E, T['electronic'])], rows
n = 0
for i, bit, live in itertools.product(range(4), (0, 1, 2, 3), (0, 1)):
    ew.w8(MOVIE_BYTE, bit); ew.w8(SR_LIVE, live); log = []
    ew.stubs[APP_GET] = lambda e: 0x5e00a000
    ew.stubs[SETTINGS_GET] = lambda e: log.append(('settings', e.r(0))) or S
    ew.stubs[MOVIE_SR_SET] = lambda e: log.append(('set', e.r(0), e.r(1))) or 1
    ew.stubs[SR_STATE] = lambda e: log.append(('state', e.r(0))) or None
    ew.call(H['set'], [SCR, i]); assert ew.kept()
    if i > 2: assert log == [] and ew.r8(MOVIE_BYTE) == bit
    else:
        assert log == [('settings', 0x5e00a000), ('set', S, 1 if i == 2 else 0), ('state', SCR + 0x3000)], (i, log)
        assert ew.r8(MOVIE_BYTE) == (bit & ~1) | (1 if i == 1 else 0)
    ew.w8(MOVIE_BYTE, bit); mode = 2 if live else (bit & 1)
    for j in range(4): assert ew.call(H['current'], [SCR, j]) == int(j == mode), (bit, live, j)
    n += 1
del ew.stubs[SR_STATE]
# the setter with no unit yet: nothing is sent
ew.w32(SR_HOLDER + 4, 0); log = []; ew.stubs[SR_STATE] = lambda e: log.append('state') or None; ew.call(H['set'], [SCR, 1]); assert 'state' not in log and len(log) == 2; ew.w32(SR_HOLDER + 4, SCR + 0x2000); del ew.stubs[SR_STATE]
for site, tail in ((LINE_ICON_CALL, False), (SCREEN_ICON_TAIL, True)):
    assert target(plain, site) == ICON_OF
    for v, variant, bit in itertools.product((0, 1, 2, 0xff), (0, 1, 2), (0, 1, 2, 3)):
        ew.w8(MOVIE_BYTE, bit)
        got = ew.call(site, [SCR, v, variant], stops=[site + 4] if not tail else [])
        want = ep.call(site, [SCR, v, variant], stops=[site + 4] if not tail else [])
        if variant == 0 and v != 0: want = ICON_E
        elif variant == 0 and (bit & 1): want = ICON_ON
        assert got == want, (hex(site), v, variant, bit, got, want)
        n += 1
print(f'E. Movie SR: the list (Off / Sensor Shift / Electronic), its set and current, the icons ({n})')

# ---- F: 4K
def start(e, byte, before):
    """The live view is started: the call of the size function there. Returns what the switch's byte holds afterwards."""
    e.w8(MOVIE_BYTE, byte); e.w8(LATCH_4K, before); e.w8(LATCH_4K - 1, 0x77); e.w8(LATCH_4K + 1, 0x88)
    e.call(START_SIZE_CALL, [0x1234], stops=[MOVIE_SIZE, START_SIZE_CALL + 4])
    assert e.stopped == MOVIE_SIZE and e.r(0) == 0x1234 and e.mu.reg_read(UC_ARM_REG_LR) == START_SIZE_CALL + 4 and e.kept((0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11)), (byte, before)
    assert e.r8(MOVIE_BYTE) == byte and e.r8(LATCH_4K - 1) == 0x77 and e.r8(LATCH_4K + 1) == 0x88
    return e.r8(LATCH_4K)


def drive(e, fps):
    obj = SCR + 0x30000; e.mu.mem_write(obj, b'\0' * 0x1000); e.w32(obj + 0x3bc, SCR + 0x500); e.w32(obj + 0x39c, SCR + 0x700)
    for a, v in DM_STUBS: e.stubs[a] = (lambda v: lambda e: v)(v)
    e.stubs[PROPS] = lambda e: SCR + 0x900
    e.stubs[GET_RATE] = lambda e: fps
    mode = e.call(DRIVE_MODE, [obj, 1])
    obj = SCR + 0x40000; e.mu.mem_write(obj, b'\0' * 0x100)
    e.call(MOVIE_SIZE, [obj])
    return mode, e.r8(obj + 9), e.call(SWITCH, [0x1234])


n = 0
assert target(plain, START_SIZE_CALL) == MOVIE_SIZE
for fps, byte, before in itertools.product((0, 1, 2), (0, 1, 2, 3, 0xfd, 0xff), (0, 1)):
    uhd = bool(byte & 2)
    ep.w8(MOVIE_BYTE, byte); ep.w8(LATCH_4K, before)
    assert drive(ep, fps) == ((4, 3, 2)[fps], 2, 0)
    assert start(ew, byte, before) == int(uhd), (byte, before)
    for later in (byte, byte ^ 2, 0, 0xff):                    # the setting changed while the live view runs: the answers stay those of its start
        ew.w8(MOVIE_BYTE, later)
        assert drive(ew, fps) == ((4, 6 if uhd else 3, 5 if uhd else 2)[fps], 1 if uhd and fps else 2, int(uhd)), (fps, byte, later, drive(ew, fps))
        assert ew.r8(LATCH_4K) == int(uhd) and ew.r8(MOVIE_BYTE) == later
        n += 1
ew.w8(LATCH_4K, 0); ew.w8(MOVIE_BYTE, 0xff)                    # from start-up to the first live view: FHD
assert drive(ew, 1) == (3, 2, 0)
print(f'F. 4K: the setting is taken where the live view is started; the sensor\'s drive mode, the size recorded and the switch for 60p / 30p / 24p follow that until the next start ({n}): 4K at 30p (mode 6) and 24p (mode 5), 60p always FHD (mode 4)')

# ---- G: the menu
n = 0
# Frame Rate's record: its set function (the list's OK) clears the bit for 60p and goes on to the camera's; the two functions that set a
# row before OK (the row under the cursor, the row that was current) are the camera's own and call the camera's set directly
rate = select + 57 * 0x4c
assert u32(plain, select_plain + 57 * 0x4c + 0x24) == FR_SET and u32(img, rate + 0x24) >= OFFICIAL_END
assert [u32(img, rate + o) for o in (0x34, 0x3c)] == [FR_SET_CLOSE, FR_SET_KEPT] and u32(img, rate) == 0x00010200
assert target(img, FR_SET_CLOSE + 0x10) == FR_SET and target(img, FR_SET_KEPT + 4) == FR_SET and u32(img, FR_SET) == u32(plain, FR_SET) == 0xe1a0c00d
for i, byte in itertools.product((0, 1, 2), (0, 1, 2, 3)):
    ew.w8(MOVIE_BYTE, byte)
    ew.call(u32(img, rate + 0x24), [SCR + 0x800, i], stops=[FR_SET])
    assert ew.stopped == FR_SET and ew.r(0) == SCR + 0x800 and ew.r(1) == i and ew.mu.reg_read(UC_ARM_REG_LR) == STOP and ew.kept() and ew.r8(MOVIE_BYTE) == (byte & ~2 if i == 0 else byte), (i, byte)
    for how in (FR_SET_CLOSE, FR_SET_KEPT):                   # before OK: the bit is left alone
        ew.w8(MOVIE_BYTE, byte); ew.w8(SCR + 0x800 + 0x1a6, i)
        ew.call(how, [SCR + 0x800, i], stops=[FR_SET + 4])
        assert ew.stopped == FR_SET + 4 and ew.r(1) == i and ew.r8(MOVIE_BYTE) == byte, (i, byte)
    n += 1
# the Resolution list's record: the last one whose handlers are all in the appended area and whose style is Frame Rate's
res = None
for k in range(126, 200):
    r = select + k * 0x4c
    if r + 0x4c > BASE + len(img): break
    if u32(img, r) == 0x00010200 and all(u32(img, r + o) >= OFFICIAL_END for o in (0x0c, 0x14, 0x24, 0x2c)) and u32(img, r + 4) == 0: res = r
assert res is not None, 'the Resolution list record'
R = {k: u32(img, res + o) for k, o in (('count', 0x0c), ('draw', 0x14), ('set', 0x24), ('current', 0x2c))}
assert all(u32(img, res + o) == 0 for o in (0x10, 0x18, 0x1c, 0x20, 0x28, 0x30, 0x34, 0x38, 0x3c, 0x40, 0x44, 0x48)), 'the Resolution list sets a row by OK only'
assert ew.call(R['count'], [SCR]) == 2
rows = []
ew.stubs[LIST_TEXT_ROW] = lambda e: rows.append((e.r(0), e.r(1))) or None
for i in range(4): ew.call(R['draw'], [SCR, SCR + 0x700, i])
assert rows == [(SCR + 0x700, T['fhd']), (SCR + 0x700, T['uhd'])], rows
for how, i, byte, fps in itertools.product(('set',), range(3), (0, 1, 2, 3), (0, 1, 2)):
    ew.w8(MOVIE_BYTE, byte); ew.w8(FRAME_RATE, fps); log = []
    ew.stubs[APP_GET] = lambda e: 0x5e00a000
    ew.stubs[SETTINGS_GET] = lambda e: S
    ew.stubs[FRAME_RATE_SET] = lambda e: log.append(('rate', e.r(0), e.r(1))) or 1
    ew.stubs[LIST_AFTER_SET] = lambda e: log.append(('after', e.r(0))) or None
    ctrl = SCR + 0x800; ew.w8(ctrl + 0x1a6, i)
    ew.call(R[how], [ctrl, i]); assert ew.kept()
    want = [] if i > 1 else ([('rate', S, 1)] if i == 1 and fps == 0 else [])
    assert log == want and ew.r8(MOVIE_BYTE) == (byte if i > 1 else (byte & ~2) | (2 if i == 1 else 0)), (how, i, byte, fps, log)
    for rate_now in (0, 1, 2):                                # current: 4K only with the bit and a frame rate that has it
        ew.w8(FRAME_RATE, rate_now)
        for j in range(3): assert ew.call(R['current'], [ctrl, j]) == int(j == int(bool(ew.r8(MOVIE_BYTE) & 2) and rate_now != 0))
    n += 1
# the menu line and the submenu's two lines
line = u32(img, MOVIE_MENU + 0x8c + 12 * 8)
assert u32(plain, MOVIE_MENU + 0x8c + 12 * 8) == FRAME_RATE_LINE_DRAW and u32(plain, MOVIE_MENU + 0x1bc + 12 * 4) == FR_LIST_ID and u32(img, MOVIE_MENU + 0x1bc + 12 * 4) == FR_MENU_ID and line >= OFFICIAL_END
wide = [BASE + i for i in range(OFFICIAL_END - BASE, len(img) - 4, 4) if img[i:i + 4] == struct.pack('<I', FR_LIST_ID)]
sub = [a for a in wide if u32(img, a + 4) == RES_LIST_ID and u32(img, a + 8) == 0x10000000]
# (an addition that copies the submenu table afterwards leaves the earlier copy behind: the last one is in use)
assert len(sub) >= 1 and len({img[a - 0x14 - BASE:a - 0x14 - BASE + 0x64] for a in sub}) == 1, [hex(a) for a in wide]
sub = sub[-1] - 0x14
assert struct.unpack_from('<HHBB', img, sub + 2 - BASE)[0] == T['title'] and img[sub + 6 - BASE] == 2 and struct.unpack_from('<HH', img, sub + 8 - BASE) == (299, T['resolution']), 'submenu record'
line_rate, line_res = u32(img, sub + 0x3c), u32(img, sub + 0x44)
assert u32(img, sub + 0x14) == FR_LIST_ID and u32(img, sub + 0x40) == 0 and u32(img, sub + 0x48) == 0
for byte, fps in itertools.product((0, 1, 2, 3), (0, 1, 2)):
    ew.w8(MOVIE_BYTE, byte); ew.w8(FRAME_RATE, fps); log = []
    ew.stubs[APP_GET] = lambda e: 0x5e00a000
    ew.stubs[RESOURCES_GET] = lambda e: 0x5e00b000
    ew.stubs[LINE_VALUE_TEXT] = lambda e: log.append(('value', e.r(0), e.r(1))) or None
    ew.stubs[TOP_SET_TITLE] = lambda e: log.append(('title', e.r(0), e.r(1))) or None
    ew.stubs[SUBMENU_LINE_TEXT] = lambda e: log.append(('sub', e.r(0), e.r(1))) or None
    uhd = bool(byte & 2) and fps != 0
    ew.call(line, [SCR, SCR + 0x900]); assert ew.kept()
    assert log == [('value', SCR + 0x900, (T['uhd30'], T['uhd24'])[fps - 1] if uhd else 301 + fps), ('title', SCR + 0x900, T['title'])], (byte, fps, log)
    log.clear(); ew.call(line_rate, [SCR, SCR + 0x900]); assert ew.kept() and log == [('sub', SCR + 0x900, 301 + fps)], log
    log.clear(); ew.call(line_res, [SCR, SCR + 0x900]); assert ew.kept() and log == [('sub', SCR + 0x900, T['uhd'] if uhd else T['fhd'])], log
    n += 1
print(f'G. the menu: 60p confirmed sets FHD (not the row under the cursor, not the row set again on leaving), 4K at 60p sets 30p; the Resolution list (set by OK only), the line and the submenu\'s two lines ({n})')
print('ok')
