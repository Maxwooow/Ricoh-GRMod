# SPDX-License-Identifier: GPL-2.0-only
"""Menu-switch tests of the multi-frame NR test build: the list's "set", "is current" and the still-menu line's draw
function, run on CURRENT() as the camera has it after a settings reset (each of the 30 factory records of
UserDataInitValue, run here), through the camera's own setters, change lists and live-copy rebuilds.
Replaced (blind spots): the property store (calls into 0x53770000..0x5378FFFF return 0: the setters' messages to other
tasks), kernel calls (E_OK), mutexes, operator new / delete, the line drawing primitives (record what they are asked).
mf17 (night mode): "On" no longer forces continuous drive (NIGHT_DRIVE: the live view's rule switches single drive); the
second line "Night brightening" (its byte, default On); our padding bytes never written by UserDataInitValue; the UI tick
(which 5): auto-ISO slowest shutter 1/30 and upper limit ISO 25600 through the camera's own (hard-float) setters, the user's
values kept and put back at Off, the live-view rule (ComPropIf values, dwell, hysteresis) switching the drive with the stock
setter and back, its guards; the settings-save hook (which 4) writing the user's values straight into CUR.  mf22 (NIGHT_REVIEW):
Instant Review > Display Time Off through the stock setter 0x5333E5F8 while on, the user's value as a code in our flag byte, put
back at Off and at the save, every Display Time value, a value no menu gives, the user's own change, the next power-on, no
collision with the limits' and the drive rule's bits.
usage: test_ui.py TEST_RTOS MANIFEST_JSON"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim
from unicorn import UC_HOOK_CODE

TEST_RTOS, MANIFEST = sys.argv[1:3]
L = {k: int(v, 16) for k, v in json.load(open(MANIFEST))['layout'].items()}
CUR = sim.CUR
DRIVE, FORMAT, LNR, TIMER = 0x46F, 0x49E, 0x4A8, 0x47A
SETTERS = {DRIVE: 0x532FB170, FORMAT: 0x532FD208, LNR: 0x532FDCF4, TIMER: 0x532FBACC}
TOP_SET_ICON, TOP_SET_TITLE, LIST_SET_ITEM = 0x5359D6F4, 0x5359D48C, 0x5359E1BC
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok


def cam(record=0):
    c = sim.Cam(TEST_RTOS); c.factory_settings(record); c.cut_property_store()
    c.calls = []
    for off, a in SETTERS.items():
        c.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, user, off=off: c.calls.append((off, uc.reg_read(sim.REGS[1]))), begin=a, end=a)
    return c


def state(c):
    return {k: c.r8(CUR + k) for k in (DRIVE, FORMAT, LNR, TIMER)} | {'live_' + hex(k): c.r8(CUR + k + 0xB44) for k in (DRIVE, FORMAT, LNR)} | {'switch': c.r8(sim.SWITCH)}


def user_sets(c, off, v):
    c.call(0x532406A4); c.call(SETTERS[off], c.call(0x53240C38), v)


def menu(c, v):
    c.calls.clear(); c.call(L['listSet'], 0, v)


check('switch byte is inside the 0xB44 bytes the settings save keeps', 0x9AE < 0xB44 and sim.SWITCH == CUR + 4 + 0x9AE)

# 1. all 30 factory records: on, then off puts the three settings back
for rec in range(30):
    c = cam(rec)
    s0 = state(c)
    menu(c, 1); s1 = state(c); on_calls = list(c.calls)
    menu(c, 0); s2 = state(c)
    ok_on = s1[DRIVE] == s0[DRIVE] and s1[FORMAT] == 2 and s1[LNR] == 2 and s1[TIMER] == 0 and s1['live_0x46f'] == s0[DRIVE] and s1['live_0x49e'] == 2 and s1['live_0x4a8'] == 2 \
        and s1['switch'] == (1 | s0[DRIVE] << 1 | s0[FORMAT] << 4 | s0[LNR] << 6)
    ok_off = s2[DRIVE] == s0[DRIVE] and s2[FORMAT] == s0[FORMAT] and s2[LNR] == s0[LNR] and s2['switch'] == 0 and s2['live_0x46f'] == s0[DRIVE]
    check(f'factory record {rec:2d} (drive {s0[DRIVE]}, format {s0[FORMAT]}, LNR {s0[LNR]}, self-timer {s0[TIMER]}): on = RAW+JPEG, LNR off, self-timer off, drive as it was (mf17); '
          f'setters in the order format, LNR, self-timer', ok_on and [o for o, _ in on_calls] == [FORMAT, LNR, TIMER], f'{s1} {on_calls}')
    check(f'factory record {rec:2d}: off puts drive, format and LNR back (self-timer stays off)', ok_off, f'{s2}')

# 2. the user's own settings: bracket, RAW only, LNR on, self-timer 2 s
c = cam(0)
for off, v in ((DRIVE, 2), (FORMAT, 1), (LNR, 1), (TIMER, 1)): user_sets(c, off, v)
s0 = state(c)
menu(c, 1); s1 = state(c); menu(c, 0); s2 = state(c)
check('user settings bracket / RAW / LNR on: on (drive stays bracket) then off restores them', s0[DRIVE] == 2 and s0[FORMAT] == 1 and s0[LNR] == 1
      and s1[DRIVE] == 2 and s1[FORMAT] == 2 and s1[LNR] == 2 and (s2[DRIVE], s2[FORMAT], s2[LNR]) == (2, 1, 1), f'{s0} {s1} {s2}')

# 3. the user changes the file format while the switch is on: off leaves the user's new choice
c = cam(0); s0 = state(c)
menu(c, 1); user_sets(c, FORMAT, 0); menu(c, 0); s2 = state(c)
check('format changed to JPEG while on: off keeps JPEG, restores drive and LNR', s2[FORMAT] == 0 and s2[DRIVE] == s0[DRIVE] and s2[LNR] == s0[LNR] and s2['switch'] == 0,
      f'{s0} {s2}')
c = cam(0); s0 = state(c)
menu(c, 1); user_sets(c, DRIVE, 1); menu(c, 0); s2 = state(c)
check('drive changed to continuous by the user while on: off keeps it (only our own switch is undone), restores format and LNR',
      s2[DRIVE] == 1 and s2[FORMAT] == s0[FORMAT] and s2[LNR] == s0[LNR], f'{s2}')

# 4. repeated values do nothing
c = cam(0); menu(c, 1); s1 = state(c)
menu(c, 1); check('on when already on: no setter called, nothing changes', not c.calls and state(c) == s1)
menu(c, 0); s2 = state(c)
menu(c, 0); check('off when already off: no setter called, nothing changes', not c.calls and state(c) == s2)
menu(c, 2); check('value 2 (not a list value): ignored', not c.calls and state(c) == s2)

# 5. "is current" and the drawing
c = cam(0)
cur = lambda v: c.call(L['listCurrent'], 0, v)
check('is current: off -> 0 current, 1 not', cur(0) == 1 and cur(1) == 0)
menu(c, 1)
check('is current: on -> 1 current, 0 not', cur(1) == 1 and cur(0) == 0)
drawn = []
for a, name in ((TOP_SET_ICON, 'icon'), (TOP_SET_TITLE, 'title'), (LIST_SET_ITEM, 'item')):
    c.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, user, name=name: (drawn.append((name, uc.reg_read(sim.REGS[1]), uc.reg_read(sim.REGS[2]))), c._ret(0)), begin=a, end=a)
c.call(L['topDraw'], 0, 0x61000000); on_draw = list(drawn); drawn.clear()
menu(c, 0); c.call(L['topDraw'], 0, 0x61000000); off_draw = list(drawn); drawn.clear()
check('menu line: icon On (330) / Off (329), title text 1022', [d[:2] for d in on_draw] == [('icon', 330), ('title', 1022)] and [d[:2] for d in off_draw] == [('icon', 329), ('title', 1022)],
      f'{on_draw} {off_draw}')
c.call(L['listDraw'], 0, 0x61000000, 0); c.call(L['listDraw'], 0, 0x61000000, 1); c.call(L['listDraw'], 0, 0x61000000, 2)
check('list items: Off (icon 329, text 2), On (icon 330, text 1), nothing for a third', drawn == [('item', 329, 2), ('item', 330, 1)], str(drawn))

# ---- mf17: night mode ---------------------------------------------------------------------------------------------------
from unicorn import UC_HOOK_MEM_WRITE
import struct
NB = {'flags': 0x49, 'tv_lo': 0x4A, 'tv_hi': 0x7A, 'up_lo': 0xFA, 'up_hi': 0x46E, 'tone': 0x79}
OURS = [0x49, 0x4A, 0x4B, 0x79, 0x7A, 0x7B, 0xFA, 0xFB, 0x46E, 0x46F]
c = sim.Cam(TEST_RTOS); writes = set()
def wr(uc, access, addr, size, value, user):
    for i in range(size):
        o = (addr + i - 0x5508BA28) % 0xB44
        if 0x5508BA28 <= addr + i < 0x5508BA28 + 30 * 0xB44: writes.add(o)
c.mu.hook_add(UC_HOOK_MEM_WRITE, wr, begin=0x5508BA28, end=0x5508BA28 + 30 * 0xB44)
c.call(0x53546C24)
check(f'our 10 padding bytes (offsets {[hex(o) for o in OURS]} of CUR + 4) are never written by UserDataInitValue in any of its 30 records '
      f'(it writes {len(writes)} of the 0xB44 bytes), all inside the saved block', not (set(OURS) & writes) and max(OURS) < 0xB44 and 0x9AE not in writes,
      str(sorted(set(OURS) & writes)))
U = CUR + 4
f32 = sim.f32
def fbits(x): return struct.unpack('<I', struct.pack('<f', x))[0]
TV_NIGHT, SV_NIGHT, TV_60, SV_12800 = 0x40A00000, 0x41500000, 0x40C00000, 0x41400000

def ncam(record=0, tv=TV_60, up=SV_12800):
    c = cam(record); c.w32(sim.APP_Q, 0x08000000); c.w8(CUR + 0xB76, 0)
    c.calls_f = []
    for a, n in ((0x532B6D50, 'tvmin'), (0x532B6A28, 'isoup')):
        c.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, user, n=n: c.calls_f.append((n, uc.reg_read(sim.REGS[0]), hex(c.mu.reg_read(sim.UC_ARM_REG_S0)))), begin=a, end=a)
    user_sets_f(c, 0x532B6D50, tv); user_sets_f(c, 0x532B6A28, up); c.calls_f.clear()
    return c

def user_sets_f(c, fn, bits):
    c.call(0x532406A4); k = c.call(0x53240C38)
    c.mu.reg_write(sim.UC_ARM_REG_S0, bits); c.call(fn, k)

def tick(c, n=1, dt_ms=100):
    for i in range(n):
        c.module_call(5, 0, 0); c.clock = (c.clock - int(dt_ms * 27000)) & 0xFFFFFFFF

def nb(c, k): return c.r8(U + NB[k])
def nb32(c, lo, hi): return c.r16(U + NB[lo]) | c.r16(U + NB[hi]) << 16

# the user's values through the stock setters first (as the menus would)
c = ncam()
check('setup: the user\'s slowest shutter 1/60 (0x40C00000) and ISO upper limit 12800 (0x41400000) through the stock setters (s0)',
      c.r32(CUR + 0x108) == TV_60 and c.r32(CUR + 0x100) == SV_12800 and c.r32(CUR + 0xC4C) == TV_60, hex(c.r32(CUR + 0x108)))
menu(c, 1); tick(c)
check('night on, first UI tick: CUR+0x108 = 1/30 (0x40A00000) and CUR+0x100 = ISO 25600 (0x41500000), stored and live copies, through the setters with s0',
      c.r32(CUR + 0x108) == TV_NIGHT and c.r32(CUR + 0x100) == SV_NIGHT and c.r32(CUR + 0xC4C) == TV_NIGHT and c.r32(CUR + 0xC44) == SV_NIGHT
      and [x[0] for x in c.calls_f] == ['tvmin', 'isoup'] and c.calls_f[0][1] == CUR, str((hex(c.r32(CUR + 0x108)), c.calls_f)))
check('night on: the user\'s two values kept in our bytes, flag "limits ours" set', nb32(c, 'tv_lo', 'tv_hi') == TV_60 and nb32(c, 'up_lo', 'up_hi') == SV_12800 and nb(c, 'flags') & 1,
      str((hex(nb32(c, 'tv_lo', 'tv_hi')), hex(nb32(c, 'up_lo', 'up_hi')), nb(c, 'flags'))))
c.calls_f.clear(); tick(c, 3)
check('night on: later ticks call no setter again', not c.calls_f)
menu(c, 0)
check('night off: both put back with the setters, flag cleared', c.r32(CUR + 0x108) == TV_60 and c.r32(CUR + 0x100) == SV_12800 and c.r32(CUR + 0xC4C) == TV_60
      and not nb(c, 'flags') & 1 and [x[0] for x in c.calls_f] == ['tvmin', 'isoup'], str((hex(c.r32(CUR + 0x108)), c.calls_f)))
c = ncam(up=0x41600000)                                   # the user's upper limit is above 25600 (51200): kept
menu(c, 1); tick(c)
check('night on with the user\'s upper limit ISO 51200: only raised, never lowered (stays 51200); slowest shutter 1/30', c.r32(CUR + 0x100) == 0x41600000 and c.r32(CUR + 0x108) == TV_NIGHT)
c = ncam(); menu(c, 1); tick(c); user_sets_f(c, 0x532B6D50, 0x40800000); menu(c, 0)
check('the user sets 1/15 while night is on: off keeps 1/15 (only our own value is put back), the upper limit restored',
      c.r32(CUR + 0x108) == 0x40800000 and c.r32(CUR + 0x100) == SV_12800, hex(c.r32(CUR + 0x108)))
c = ncam(); menu(c, 1); tick(c); c.module_call(4, 0, 0)
check('settings save at power-off (which 4): the user\'s values written straight into CUR (what the save copies), flag cleared, no setter called',
      c.r32(CUR + 0x108) == TV_60 and c.r32(CUR + 0x100) == SV_12800 and not nb(c, 'flags') & 1 and [x[0] for x in c.calls_f] == ['tvmin', 'isoup'],
      str((hex(c.r32(CUR + 0x108)), c.calls_f)))
tick(c)
check('after it (the next power-on): the first UI tick applies the night values again', c.r32(CUR + 0x108) == TV_NIGHT and nb(c, 'flags') & 1)
c = ncam(); w8 = c.w8; c.w32(sim.APP_Q, 0x0800000D); menu(c, 1); tick(c)
check('night on, but another screen (playback): nothing applied yet', c.r32(CUR + 0x108) == TV_60 and not nb(c, 'flags') & 1)
c = ncam(); menu(c, 0); tick(c)
check('switch off: the UI tick does nothing', c.r32(CUR + 0x108) == TV_60 and not nb(c, 'flags'))

# the live-view rule: ComPropIf E (slot 0x5537B2A0), X = [E+0x518], D = [X], Tv / Av / Sv at D+0x4D8 / 4DC / 4E0
E, X, D = sim.OBJ + 0x3A00000, sim.OBJ + 0x3A01000, sim.OBJ + 0x3A02000
def live(c, ev, av=3.0, sv=10.0, ok=True):
    c.wb(E, bytes(0x600)); c.w32(E, 0x53FC54D8 if ok else 0x53FC54DC); c.w32(E + 0x518, X); c.w32(X, D); c.w32(0x5537B2A0, E)
    c.w32(D + 0x4D8, f32(ev - av + sv - 5)); c.w32(D + 0x4DC, f32(av)); c.w32(D + 0x4E0, f32(sv))
def drive(c): return c.r8(CUR + DRIVE), c.r8(CUR + DRIVE + 0xB44)
c = ncam(); menu(c, 1); live(c, 2.0); c.calls.clear()
tick(c, 5, 100)
check('dark live view (EV100 2.0) for 0.5 s: no switch yet (dwell 1 s)', drive(c) == (0, 0) and not [x for x in c.calls if x[0] == DRIVE])
tick(c, 8, 100)
check('dark for more than 1 s, single drive, no self-timer: continuous with the stock setter 0x532FB170 (stored and live), flag "drive ours"',
      drive(c) == (1, 1) and (DRIVE, 1) in c.calls and nb(c, 'flags') & 2, str((drive(c), c.calls)))
live(c, 4.4); c.calls.clear(); tick(c, 20, 100)
check('EV100 4.4 (between 3.9 and 4.9: hysteresis): stays continuous', drive(c) == (1, 1) and not c.calls)
live(c, 5.5); tick(c, 5, 100)
check('bright (EV100 5.5) for 0.5 s: still continuous', drive(c) == (1, 1))
tick(c, 8, 100)
check('bright for more than 1 s: back to single with the stock setter, flag cleared', drive(c) == (0, 0) and (DRIVE, 0) in c.calls and not nb(c, 'flags') & 2, str((drive(c), c.calls)))
live(c, 1.0); tick(c, 15); live(c, 1.0); c.module_call(4, 0, 0)
check('dark again (continuous), then the settings save at power-off: drive written back to single in CUR, flag cleared', c.r8(CUR + DRIVE) == 0 and not nb(c, 'flags') & 2)
c = ncam(); menu(c, 1); live(c, 1.0); tick(c, 15); menu(c, 0)
check('dark (continuous by the rule), then night off: drive single again (setter), limits back', drive(c) == (0, 0) and c.r32(CUR + 0x108) == TV_60)
c = ncam(); menu(c, 1); live(c, 1.0); tick(c, 15); user_sets(c, DRIVE, 2); tick(c); live(c, 6.0); tick(c, 15)
check('the user picks bracket while the rule had continuous: the flag is dropped, bracket kept when it gets bright', c.r8(CUR + DRIVE) == 2 and not nb(c, 'flags') & 2)
c = ncam(); user_sets(c, TIMER, 1); menu(c, 1); user_sets(c, TIMER, 1); live(c, 1.0); tick(c, 15)
check('self-timer on: the rule never switches the drive', drive(c) == (0, 0))
c = ncam(); user_sets(c, DRIVE, 1); menu(c, 1); live(c, 6.0); tick(c, 15)
check('the user\'s own continuous drive: never switched to single when bright', drive(c) == (1, 1) and not nb(c, 'flags') & 2)
c = ncam(); menu(c, 1); live(c, 1.0, ok=False); tick(c, 15)
check('no valid ComPropIf (vtable differs): no reading, no switch, nd_ev "not read"', drive(c) == (0, 0))
c = ncam(); menu(c, 1); live(c, 1.0); c.w32(sim.APP_Q, 0x0800000D); tick(c, 15)
check('dark but not the shooting screen: no switch', drive(c) == (0, 0))
st = c.r32(sim.SLOT)
c = ncam(); menu(c, 1); tick(c); st = c.r32(sim.SLOT); live(c, 1.0)
SEQ, ENT = sim.OBJ + 0x3B00000, sim.OBJ + 0x3B10000
c.wb(SEQ, bytes(0x400)); c.wb(ENT, bytes(6 * 0x1A50)); c.w32(SEQ + 0x90, ENT); c.w8(ENT + 2 * 0x1A50 + 0x20, 1); c.w32(st + 0x38, SEQ)
tick(c, 15)
check('dark, a front-end plan in use (entry 2 of [SEQ+0x90]): no switch while it is busy', drive(c) == (0, 0))
c.w8(ENT + 2 * 0x1A50 + 0x20, 0); tick(c, 2)
check('... and the switch as soon as the front end is idle', drive(c) == (1, 1))
c = ncam(); menu(c, 1); tick(c); st = c.r32(sim.SLOT); LVC = sim.OBJ + 0x3C00000; c.wb(LVC, bytes(0x100)); c.w32(st + 0x30, LVC); c.w8(LVC + 0xE3, 1); live(c, 1.0); tick(c, 15)
check('shutting down (LiveViewControl +0xE3): no switch, nothing applied', drive(c) == (0, 0))

# ---- mf22: NIGHT_REVIEW, Instant Review > Display Time Off while the switch is on --------------------------------------
REV_SET, REV_RT, REV_SETTER = 0x914, 0x1458, 0x5333E5F8
def rcam(record=0, user=500):
    c = ncam(record); c.calls_r = []
    c.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, user_, : c.calls_r.append(uc.reg_read(sim.REGS[1])), begin=REV_SETTER, end=REV_SETTER)
    if user is not None:
        c.call(0x532406A4); c.call(REV_SETTER, c.call(0x53240C38), user & 0xFFFFFFFF)
    c.calls_r.clear()
    return c
def rv(c): return c.r32(CUR + REV_SET), c.r32(CUR + REV_RT)
fac = sorted({(lambda c: c.r32(CUR + REV_SET))(cam(r)) for r in range(30)})
check(f'Display Time: CUR+0x914 = CUR+4+0x910, inside the saved 0xB44 bytes; factory values over the 30 records {fac} (ms)', 0x910 < 0xB44 and all(v in (0, 500, 1000, 2000, 3000, 0xFFFFFFFF) for v in fac))
c = rcam(user=2000)
check('the stock setter 0x5333E5F8 (CUR, 2000): CUR+0x914 and the copy CUR+0x1458 both 2000 when it returns (its change list runs 0x53277AF0)', rv(c) == (2000, 2000), str(rv(c)))
c = rcam(user=500); menu(c, 1); tick(c)
check('night on, first UI tick: Display Time Off (CUR+0x914 = 0, +0x1458 = 0) through the stock setter (r1 = 0); flag bit 2, the user\'s 500 ms as code 2 in bits 3..5; the limits too (bit 0)',
      rv(c) == (0, 0) and c.calls_r == [0] and nb(c, 'flags') == (1 | 4 | 2 << 3), str((rv(c), c.calls_r, hex(nb(c, 'flags')))))
c.calls_r.clear(); tick(c, 3)
check('night on: later ticks call the Display Time setter no more', not c.calls_r)
menu(c, 0)
check('night off: Display Time 500 ms again through the setter (both words), the flag byte all clear (limits back too)',
      rv(c) == (500, 500) and c.calls_r == [500] and nb(c, 'flags') == 0 and c.r32(CUR + 0x108) == TV_60, str((rv(c), c.calls_r, hex(nb(c, 'flags')))))
for user in (0, 1000, 2000, 3000, -1):
    c = rcam(user=user); menu(c, 1); tick(c); on = (rv(c), list(c.calls_r)); c.calls_r.clear(); menu(c, 0)
    want_on_calls = [] if user == 0 else [0]
    want_off_calls = [] if user == 0 else [user & 0xFFFFFFFF]
    check(f'user\'s Display Time {user if user >= 0 else "Hold"}: on -> Off ({"no setter call: already Off" if user == 0 else "setter"}), off -> theirs again',
          on[0] == (0, 0) and on[1] == want_on_calls and rv(c) == (user & 0xFFFFFFFF,) * 2 and c.calls_r == want_off_calls and not nb(c, 'flags') & 0x3C,
          str((on, rv(c), c.calls_r, hex(nb(c, 'flags')))))
c = rcam(user=500); menu(c, 1); tick(c); c.call(0x532406A4); c.call(REV_SETTER, c.call(0x53240C38), 2000); c.calls_r.clear(); menu(c, 0)
check('the user sets 2 s while night is on: off keeps 2 s (only our Off is undone), no setter call', rv(c) == (2000, 2000) and not c.calls_r and not nb(c, 'flags') & 0x3C)
c = rcam(user=None); c.w32(CUR + REV_SET, 1234); c.w32(CUR + REV_RT, 1234); menu(c, 1); tick(c)
check('a Display Time no menu gives (1234 ms): left alone, no flag, no setter call', rv(c) == (1234, 1234) and not c.calls_r and not nb(c, 'flags') & 0x3C)
c = rcam(user=1000); menu(c, 1); tick(c); c.calls_r.clear(); c.module_call(4, 0, 0)
saved = c.rb(U, 0xB44)
check('settings save at power-off (which 4): CUR+0x914 = the user\'s 1000 ms written straight in (what the save copies), flag and code cleared, no setter call; '
      'the limits written back the same way', c.r32(CUR + REV_SET) == 1000 and not c.calls_r and nb(c, 'flags') == 0 and c.r32(CUR + 0x108) == TV_60
      and struct.unpack_from('<I', saved, 0x910)[0] == 1000 and saved[0x49] == 0, str((rv(c), hex(nb(c, 'flags')))))
tick(c)
check('after it, if the camera goes on: the next UI tick sets Off again with the setter (the user\'s 1000 kept again)', rv(c) == (0, 0) and c.calls_r == [0] and nb(c, 'flags') >> 3 & 7 == 3)
c2 = rcam(user=None); c2.wb(U, saved); c2.w32(CUR + REV_RT, struct.unpack_from('<I', saved, 0x910)[0]); menu(c2, 1) if not c2.r8(sim.SWITCH) & 1 else None; tick(c2)
check('next power-on from that saved block (the user\'s 1000 ms, no flag): the first UI tick keeps 1000 and sets Off',
      rv(c2) == (0, 0) and nb(c2, 'flags') >> 3 & 7 == 3 and nb(c2, 'flags') & 4, str((rv(c2), hex(nb(c2, 'flags')))))
# a battery pull saves nothing: every block the save can have written holds the user's value (checked at every point of a session)
c = rcam(user=2000); seen = []
for step in ('menu on', 'tick', 'user drive', 'tick', 'save'):
    if step == 'menu on': menu(c, 1)
    elif step == 'tick': tick(c)
    elif step == 'user drive': user_sets(c, DRIVE, 2)
    elif step == 'save': c.module_call(4, 0, 0)
    seen.append(c.r32(CUR + REV_SET))
check('a whole session (on, ticks, a drive change, the save): only the save writes a block to the card, and at the save CUR+0x914 is the user\'s 2000; '
      'a battery pull keeps the last clean save, which the save hook made the same way', seen[-1] == 2000 and seen[1] == 0, str(seen))
# no collision with the other two: the drive rule's bit 1 and the limits' bit 0
c = rcam(user=3000); menu(c, 1); live(c, 1.0); tick(c, 15)
f_on = nb(c, 'flags')
live(c, 6.0); tick(c, 15); f_bright = nb(c, 'flags')
c.calls_r.clear(); menu(c, 0)
check('with the drive rule: dark -> flags limits | drive | Display Time (0x07 | code 5 << 3), bright -> the drive bit alone cleared, Display Time bits kept; '
      'off -> all three put back (single drive, 1/60, 3 s)',
      f_on == (1 | 2 | 4 | 5 << 3) and f_bright == (1 | 4 | 5 << 3) and rv(c) == (3000, 3000) and drive(c) == (0, 0) and c.r32(CUR + 0x108) == TV_60 and nb(c, 'flags') == 0,
      str((hex(f_on), hex(f_bright), rv(c), drive(c), hex(nb(c, 'flags')))))
c = rcam(user=500); menu(c, 1); tick(c); live(c, 1.0); tick(c, 15); c.module_call(4, 0, 0)
check('dark (continuous by the rule) + Display Time ours, then the save: drive single, 1/60, 500 ms all written into CUR, flag byte 0',
      c.r8(CUR + DRIVE) == 0 and c.r32(CUR + 0x108) == TV_60 and c.r32(CUR + REV_SET) == 500 and nb(c, 'flags') == 0)
c = rcam(user=500); c.w32(sim.APP_Q, 0x0800000D); menu(c, 1); tick(c)
check('night on, another screen (playback): Display Time not touched yet', rv(c) == (500, 500) and not nb(c, 'flags') & 4)

# the second menu line: night brightening, byte bit 0 = off, default on (mf17..mf19; the final build has no such line)
if not L.get('toneSet'):
    check('final build: no night brightening line (layout toneSet / toneDraw / toneCurrent 0)', not L.get('toneDraw') and not L.get('toneCurrent'))
    print('ALL PASS' if not fails else f'{fails} FAILED')
    sys.exit(1 if fails else 0)
c = cam(0)
TB = U + 0x79
tcur = lambda v: c.call(L['toneCurrent'], 0, v)
check('night brightening: byte 0 at a factory reset = On (current: 1 yes, 0 no)', c.r8(TB) == 0 and tcur(1) == 1 and tcur(0) == 0)
c.calls.clear(); c.call(L['toneSet'], 0, 0)
check('night brightening Off: bit 0 set, no camera setter called, current 0', c.r8(TB) == 1 and not c.calls and tcur(0) == 1 and tcur(1) == 0)
c.call(L['toneSet'], 0, 2); check('value 2: ignored', c.r8(TB) == 1)
c.call(L['toneSet'], 0, 1); check('night brightening On again: bit 0 clear', c.r8(TB) == 0 and tcur(1) == 1)
drawn.clear()
for a2, name in ((TOP_SET_ICON, 'icon'), (TOP_SET_TITLE, 'title')):
    c.mu.hook_add(UC_HOOK_CODE, lambda uc, addr, size, user, name=name: (drawn.append((name, uc.reg_read(sim.REGS[1]))), c._ret(0)), begin=a2, end=a2)
c.call(L['toneDraw'], 0, 0x61000000); d_on = list(drawn); drawn.clear(); c.call(L['toneSet'], 0, 0); c.call(L['toneDraw'], 0, 0x61000000)
check('night brightening line: icon On (330) / Off (329), title text 1023', d_on == [('icon', 330), ('title', 1023)] and drawn == [('icon', 329), ('title', 1023)], str((d_on, drawn)))

print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
