# SPDX-License-Identifier: GPL-2.0-only
"""The movie AF build (install.ts) in the emulator; real camera code wherever the hooks touch it (see cam.py).

usage: test_quick.py OFFICIAL_RTOS.bin PATCHED_RTOS.bin   (the RTOS section of the official firmware, and of a build with videoAf)"""
import json, struct, sys
from pathlib import Path
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_quick
from layout import layout, with_files
from cam import *

official_image = Path(sys.argv[1]).read_bytes(); built = Path(sys.argv[2]).read_bytes()
L = layout(built)
flags, fast, per_unit, fastest = L['flags'], L['fast'], L['perUnit'], L['fastest']
steps_on, direction_on, record_on, standby_on, follow_on = bool(flags & 1), bool(flags & 2), bool(flags & 4), bool(flags & 8) and not flags & 16, bool(flags & 16)
passed = [0]
def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok: sys.exit(1)
    passed[0] += 1
built_word = lambda a: struct.unpack_from('<I', built, a - BASE)[0]
check('the build gives the module no file service: context word 7 is a stub `mov r0, #0; bx lr` (the tests below put the camera\'s back to read the record)',
      built_word(L['ctx'] + 28) == L['noFiles'] and [built_word(L['noFiles']), built_word(L['noFiles'] + 4)] == [0xe3a00000, 0xe12fff1e])
image = with_files(built, L)
word = lambda a: struct.unpack_from('<I', image, a - BASE)[0]
target = lambda a: a + 8 + ((word(a) & 0xffffff ^ 0x800000) - 0x800000) * 4
md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
text = lambda a, n: [f'{i.mnemonic} {i.op_str}'.strip() for i in md.disasm(image[a - BASE:a - BASE + 4 * n], a)]
FAKE_STATE = HEAP + 0x8000                # a stand-in for the module's state where a test needs only its mark field
mark_speed = lambda units: (0x8000 | min(per_unit * units, fastest)) if (fast and min(per_unit * units, fastest) > 120) else 120

# ---- 1. what is installed
check('hooks: wobbling step call, stop slot, vote call, standby monitor call', target(0x53626a44) == L['wobbleStub'] and word(0x53ee06f8) == L['stopStub'] and target(0x5363003c) == L['voteStub'] and target(0x53627020) == L['monitorStub'])
check('context: magic, state word, flags, twelve natives', [word(L['ctx'] + 4 * i) for i in range(15)] == [0x51414656, 0x5583907c, flags, 0x53909154, 0x5391aaa0, 0x5391d79c, 0x5391d7ac, 0x537d0668, 0x5361f6c8, 0x5360e934, 0x5360a4f0, 0x5360f0f0, 0x53630dfc, LENS_TAKE, LENS_GIVE_BACK])
load = [f"movw r0, #{hex(L['ctx'] & 0xffff)}", f"movt r0, #{hex(L['ctx'] >> 16)}"]
check('vote stub: the official vote, then the module with (ctx, 2, result)', text(L['voteStub'], 9) == ['push {r4, lr}', 'bl #0x5362cb08', 'mov r2, r0'] + load + ['mov r1, #2', 'mov r3, #0', f"bl #{hex(L['code'])}", 'pop {r4, pc}'])
check('monitor stub: the official monitor with its arguments, then the module with (ctx, 3, object, scene flag)', text(L['monitorStub'], 11) == ['push {r4, r5, r6, lr}', 'mov r4, r0', 'mov r5, r3', 'bl #0x536228ac'] + load + ['mov r1, #3', 'mov r2, r4', 'mov r3, r5', f"bl #{hex(L['code'])}", 'pop {r4, r5, r6, pc}'])
if fast:
    check('fast hooks: the speed word is a call of the speed stub, the recording test a branch to the lens stub', word(0x53630e20) >> 24 == 0xeb and target(0x53630e20) == L['speedStub'] and word(0x539530fc) >> 24 == 0xea and target(0x539530fc) == L['lensStub'])
    stock, done = hex(L['speedStub'] + 72), hex(L['speedStub'] + 76)
    check('speed stub as written', text(L['speedStub'], 21) == ['movw r7, #0x907c', 'movt r7, #0x5583', 'ldr r7, [r7]', 'cmp r7, #0', f'beq #{stock}', 'ldrh r7, [r7, #0x54]', 'cmp r5, r7', f'blo #{stock}', 'cmp r5, #0x1000', f'bhs #{stock}',
          f'mov r7, #{hex(per_unit)}', 'mul r7, r5, r7', f'movw ip, #{hex(fastest)}', 'cmp r7, ip', 'movhi r7, ip', 'cmp r7, r2', 'orrhi r7, r7, #0x8000', f'bhi #{done}', 'mov r7, r2', 'cmp r3, r0', 'bx lr'])
    check('lens stub as written', text(L['lensStub'], 9) == ['tst r3, #0x8000', f"bne #{hex(L['lensStub'] + 20)}", 'tst ip, #1', 'bne #0x53953174', 'b #0x53953104', 'lsl r4, lr, #1', 'lsl ip, r3, #0x11', 'lsr ip, ip, #0x11', 'b #0x5395310c'])
else:
    check('no fast hooks: both words official', word(0x53630e20) == 0xe1a07002 and word(0x539530fc) == 0xe31c0001)
if follow_on:
    check('follow hooks: the branch to the phase reset is a no-op, the decision\'s request is a call of the ask stub', word(KEEP_PHASE) == 0xe1a00000 and word(ASK_CALL) >> 24 == 0xeb and target(ASK_CALL) == L['askStub'])
    check('ask stub: the module with (ctx, 4, object from r5); on 0 the request is left out and 0 returned, else the official request with its own arguments',
          text(L['askStub'], 12) == ['push {r0, r1, r2, r3, r4, lr}'] + load + ['mov r1, #4', 'mov r2, r5', 'mov r3, #0', f"bl #{hex(L['code'])}", 'cmp r0, #0', 'pop {r0, r1, r2, r3, r4, lr}', 'moveq r0, #0', 'bxeq lr', 'b #0x5360a4f0'])
else:
    check('no follow hooks: both words official', word(KEEP_PHASE) == 0x1a000010 and word(ASK_CALL) == 0xebffd4ee)

# ---- 2. the wobbling module's own lens move (real code), official against patched: what it sends to the lens
def lens_move(img, amount, base=3, speed=120, direction=1, last=1, flag22=1, backlash=5, mark=None):
    """mark: None = no module state yet; else the amount the module has named (0xffff: none)"""
    c = Cam(img); c.wobbler(base=base, direction=direction)
    c.w8(W + 0x23, last); c.w8(W + 0x22, flag22); c.w16(W + 0x16, backlash)
    if mark is not None: c.w32(SLOT, FAKE_STATE); c.w16(FAKE_STATE + MARK, mark)
    sent = []
    c.native(LENS_KIND, lambda c: (sent.append(('kind', c.r(1))), 0)[1]); c.native(LENS_590A, lambda c: (sent.append(('590a', c.r(1))), 0)[1])
    c.native(LENS_MOVE, lambda c: (sent.append(('move', c.r(1), c.r(2), c.r(3), c.r32(c.r(13)))), 1)[1])
    c.call(MOVE, W, amount, speed, 1)
    return sent, c.r8(W + 9), c.r8(W + 0x23)
strip = lambda sent: [e if e[0] != 'move' else e[:3] + e[4:] for e in sent]
speed_of = lambda sent: [e[3] for e in sent if e[0] == 'move']
same, expected = True, True
for base in (1, 3, 10):
    for amount in (1, 3, 6, 9, 24, 30, 63, 120, 150, 300, 0xfff, 0x1000, 0x3fff):
        for direction, last, flag22 in ((1, 1, 1), (0, 1, 1), (1, 0, 1), (0, 0, 0), (1, 0, 0)):
            a = lens_move(official_image, amount, base, 120, direction, last, flag22)
            for mark in (None, 0xffff, 24, amount, amount + 1):
                b = lens_move(image, amount, base, 120, direction, last, flag22, mark=mark)
                same &= strip(a[0]) == strip(b[0]) and a[1:] == b[1:] and speed_of(a[0]) == [120]
                named = fast and mark is not None and mark <= amount < 0x1000
                want = mark_speed(amount) if named else 120
                if speed_of(b[0]) != [want]: print('   unexpected', base, amount, mark, [hex(v) for v in speed_of(b[0])], hex(want))
                expected &= speed_of(b[0]) == [want]
check('wobbling lens move, 13 amounts x 3 basic steps x 5 direction cases x 5 states of the module: drive kind, direction, amount (with backlash) and flags as official', same)
check(f'  speed: only an amount the module has named (and below 0x1000) asks {per_unit} x amount, at most {fastest}, marked; with no state, no name or a larger name: 120 as the camera asked' if fast else '  speed: 120 as the camera asked, always', expected)

# ---- 3. the lens control's relative move (real code)
def relative(img, quiet, index, speed, amount=77, direction=1, d4=0):
    c = Cam(img)
    c.w8(LCO + 0x371, quiet); c.w8(LCO + 0x78, index); c.w8(LCO + 0x1ba, 45); c.w8(LCO + 0xd4, d4); c.w16(LCO + 0x1b8, 333)
    c.call(RELATIVE, LCO, direction, amount, speed)
    return dict(speed=c.r16(LCO + 0x1e2), amount=c.r16(LCO + 0x1e4), direction=c.r32(LCO + 0x1dc), motor=c.r8(LCO + 0x1e0), go=c.r8(LCO + 0x1d8), mode=c.r8(LCO + 0xc5))
ORDINARY_MAX, ORDINARY_MIN = [1500, 2000, 2500, 2500], [100, 60, 60, 60]
same = True
for quiet in (0, 1, 3):
    for index in range(4):
        for speed in (0, 10, 60, 120, 121, 500, 2500, 0x7fff):
            for d4 in (0, 1):
                same &= relative(official_image, quiet, index, speed, d4=d4) == relative(image, quiet, index, speed, d4=d4)
check('lens relative move, unmarked speeds (8 speeds x 4 indexes x recording property 0 / 1 / 3 x both modes): everything as official', same)
check('  official while recording: 2500 asked -> 120 with motor setting 30', relative(official_image, 1, 2, 2500) == dict(speed=120, amount=77, direction=1, motor=30, go=1, mode=3))
if fast:
    ok = True
    for quiet in (0, 1):
        for index in range(4):
            for speed in (10, 121, 280, 1000, 2400, 2500):
                r = relative(image, quiet, index, 0x8000 | speed, amount=33, direction=0)
                ok &= r == dict(speed=max(ORDINARY_MIN[index], min(ORDINARY_MAX[index], speed)), amount=33, direction=0, motor=45, go=1, mode=3)
    check('  marked speeds: the ordinary limits by index and the ordinary motor setting 45, recording or not; amount and direction as given', ok)
    check('  marked, other mode (object + 0xD4 set): the official code for that mode, untouched', relative(image, 1, 2, 0x8000 | 999, d4=1) == relative(official_image, 1, 2, 0x8000 | 999, d4=1))

# ---- 4. the whole way of one travel step: wobbling lens move -> lens interface -> command -> lens task's dispatcher -> relative move (all real code)
def chain(img, amount, base=3, quiet=1, index=2, mark=None):
    c = Cam(img); c.wobbler(base=base, direction=1)
    c.w8(LCO + 0x371, quiet); c.w8(LCO + 0x78, index); c.w8(LCO + 0x1ba, 45)
    if mark is not None: c.w32(SLOT, FAKE_STATE); c.w16(FAKE_STATE + MARK, mark)
    c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0); c.native(SIGNAL, lambda c: 0)
    c.call(MOVE, W, amount, 120, 1)
    queued = dict(pending=c.r8(LCO + 0xcc), command=c.r16(LCO + 0xd6), direction=c.r32(LCO + 0xd8), amount=c.r32(LCO + 0xdc), speed=c.r32(LCO + 0xe0), lens_amount=c.r16(LENS + 0x18))
    c.call(DISPATCH, LCO)
    return queued, dict(speed=c.r16(LCO + 0x1e2), amount=c.r16(LCO + 0x1e4), direction=c.r32(LCO + 0x1dc), motor=c.r8(LCO + 0x1e0), go=c.r8(LCO + 0x1d8))
q, r = chain(official_image, 60)
check('official, recording, a 60 unit step: command 0x8900 queued with speed 120; the lens task stores 120 units/s, motor setting 30', q == dict(pending=1, command=0x8900, direction=1, amount=60, speed=120, lens_amount=60) and r == dict(speed=120, amount=60, direction=1, motor=30, go=1))
if fast:
    q, r = chain(image, 60, mark=60)
    check(f'patched, the same step named by the module: queued with {min(per_unit * 60, fastest)} marked; the lens task stores {min(per_unit * 60, fastest)} units/s, motor setting 45', q['speed'] == (0x8000 | min(per_unit * 60, fastest)) and r == dict(speed=min(per_unit * 60, fastest, 2500), amount=60, direction=1, motor=45, go=1))
    check('patched, the same step not named (the camera\'s own step, or the return to the peak): 120 units/s, motor setting 30, as official', chain(image, 60, mark=0xffff) == chain(official_image, 60) and chain(image, 60) == chain(official_image, 60))
    q, r = chain(image, 0x3fff, mark=24)
    check('patched, the long sweep of the hold state (0x3fff) even with a name standing: 120 units/s, motor setting 30, as official', r['speed'] == 120 and r['motor'] == 30 and (q, r) == chain(official_image, 0x3fff))
    q, r = chain(image, 120, index=0, mark=120)
    check(f'patched, 120 units named, lens index 0: the ordinary limit of that index applies too ({min(1500, per_unit * 120, fastest)})', r['speed'] == min(1500, per_unit * 120, fastest) and r['motor'] == 45)

# ---- 5. the module around a stand-in for the wobbling step (which here only does what a test tells it to)
def module_cam(base=3, cap=48, direction=1, climb=1):
    c = Cam(image); c.wobbler(base=base, cap=cap, direction=direction, climb=climb)
    c.seen = []; c.act = None          # act: None, 'up' (count + 1), ('set', n), 'send' (a travel step is sent with the count as it is)
    def step(c):
        count = c.s32(W + 0xc78); st = c.r32(SLOT)
        c.seen.append((count, c.r16(W + 0x1e), c.r16(st + MARK) if st else None)); c.events.append(('step', c.r(0), c.r(1)))
        act = c.act
        if act == 'up': c.w32(W + 0xc78, count + 1)
        elif isinstance(act, tuple): c.w32(W + 0xc78, act[1])
        elif act == 'send':
            c.w16(W + 0x1a, min((count + 1) * c.r16(W + 0x10), c.r16(W + 0x1e))); c.w16(W + 0xcb0, c.r16(W + 0xcb0) + 1)
        return 0
    c.position = 777
    c.native(STEP, step); c.native(LENS_POSITION, lambda c: c.position)
    return c
Q = 72                                   # the module's FAST_Q8: 0.28 of the value
def fastc(left, base=3):
    """(count, limit during the step, amount named for the lens's ordinary speed) for a lens travelling the way of a row that leaves `left` for the step"""
    units = min(left * Q >> 8, 200); count = max(units // base - 1, 0); name = (count + 1) * base
    return (count, name, name) if name >= 24 else (count, 48, 0xffff)
QUIET, SMALL = (1, 48, 0xffff), (0, 48, 0xffff)      # two basic steps; the smallest step
OWN = lambda n: (n, 48, 0xffff)
def frames(c, n=1, act=None):
    c.act = act; c.seen = []; c.events = []
    out = [c.call(L['wobbleStub'], O) for _ in range(n)]
    c.act = None
    return list(c.seen)
REL = [20] * 5
TWO = [20, 20, 200, 200, 200]            # two reliable areas only
def feed(c, values, direction=1, rel=REL, act=None, valid=1, running=1):
    """a new phase result, then one frame"""
    c.phase(values, rel, direction=direction, valid=valid, running=running)
    return frames(c, 1, act)[0]
state = lambda c: c.r32(SLOT)
far = lambda k: [400 + k, 410, 390, 405, 395]         # a strong result (median 400 + k for k up to 5, then 405); every k another result
c = module_cam()
c.phase([100, 120, 90, 110, 130], [200] * 5)
seen = frames(c, 6)
check('no reliable area: the wobbling step runs every frame with (object, 1), nothing is written, nothing is named', c.events == [('step', O, 1)] * 6 and seen[1:] == [OWN(0)] * 5 and seen[0][:2] == (0, 48))
check('one allocation below 64 KB, state pointer in the RAM word, no name left standing after the step', len(c.allocs) == 1 and c.allocs[0] < 0x10000 and state(c) == HEAP and c.r16(HEAP + MARK) == 0xffff)
if steps_on:
    c = module_cam()
    a = feed(c, [200, 220, 190, 210, 230])
    check('one strong result (median 210, five reliable areas), travelling the phase way: not acted on; a quiet step of two basic steps by the value as it is', a == QUIET)
    b = feed(c, [201, 220, 190, 210, 230]); more = frames(c, 2)
    check('a second one agreeing: 0.28 x 210 = 59 units = count 18 (57 units), named for the lens\'s ordinary speed; the same in the frames after it', b == (18, 57, 57) == fastc(210) and more == [(18, 57, 57)] * 2)
    seen = frames(c, 30)
    check('  the row is acted on for 12 frames after its last result; then quiet steps by the value standing until that is 20 frames old; then the camera\'s own count', seen == [(18, 57, 57)] * 10 + [QUIET] * 8 + [OWN(0)] * 12)
    c = module_cam(); feed(c, [200, 220, 190, 210, 230]); b = feed(c, [500, 520, 480, 510, 530])
    check('210, then 510: the step is sized by 1.5 x the earlier value at most (315: 88 units = count 28, 87 units)', b == fastc(315) == (28, 87, 87))
    b = feed(c, [501, 520, 480, 510, 530])
    check('510 once more: now it counts in full (143 units = count 46, 141 units); the limit is 141 for the step and 48 again afterwards', b == (46, 141, 141) == fastc(510) and c.r16(W + 0x1e) == 48)
    c = module_cam(); feed(c, [500, 520, 480, 510, 530]); b = feed(c, [200, 220, 190, 210, 230])
    check('510, then 210: the later, smaller value sizes the step (count 18)', b == fastc(210))
    c = module_cam(); feed(c, [2000, 2100, 1900, 2050, 1950]); b = feed(c, [2001, 2100, 1900, 2050, 1950])
    check('huge values: never more than 200 units (count 65, 198 units)', b == (65, 198, 198) == fastc(2000))
    c = module_cam(); feed(c, [150, 152, 148, 151, 149]); b = feed(c, [151, 152, 148, 151, 149])
    check('a row of 150, the smallest there is (42 units): a fast step; the camera\'s limit is 42 for that step and 48 again afterwards', b == (13, 42, 42) == fastc(150) and c.r16(W + 0x1e) == 48)
    c = module_cam(); feed(c, [150, 152, 148, 151, 149]); c.position -= 6; b = feed(c, [151, 152, 148, 151, 149]); c.position -= 12; d = feed(c, [150, 153, 148, 151, 149]); c.position -= 3; e = feed(c, [151, 153, 148, 151, 149])
    check('  the lens has moved 6 units that way since: 36 units, still a fast step; 18 units: 24 units, the smallest fast step; 21 units: a quiet step', b == (11, 36, 36) and d == (7, 24, 24) and e == QUIET)
    c = module_cam(); feed(c, [140, 142, 138, 141, 139]); b = feed(c, [141, 142, 138, 141, 139])
    check('values of 140 (below 150) are no row: quiet steps of two basic steps, nothing named', b == QUIET)
    c = module_cam(); a = feed(c, [70, 72, 68, 71, 69]); b = feed(c, [50, 52, 48, 51, 49])
    check('median 70 (19 units): a quiet step of two basic steps; median 50 (14 units): the smallest step', a == QUIET and b == SMALL)
    c = module_cam(); feed(c, far(0)); feed(c, far(1)); b = feed(c, [300, 310, 320, 330, 340], rel=TWO)
    check('after a row of 400, a result from two areas only saying 310: it neither counts nor ends the row, and lowers what is left (count 28)', b == fastc(310))
    b2 = feed(c, far(2))
    check('  the next strong result goes on with the row', b2 == fastc(402))
    c = module_cam(); feed(c, far(0)); feed(c, far(1)); b = feed(c, far(2), rel=[200] * 5); b2 = feed(c, far(3), valid=0)
    check('a frame without a reliable area, and one without a phase direction: the row stands (count 36, 111 units)', b == b2 == fastc(400) == (36, 111, 111))
    c = module_cam(); feed(c, far(0)); feed(c, far(1)); b = feed(c, [300, 310, 320, 330, 340], rel=TWO, direction=0); b2 = feed(c, far(2))
    check('two areas for the other direction end the row (the camera\'s own count); one strong result after it is not acted on', b == OWN(0) and b2 == QUIET)
    c = module_cam(); feed(c, far(0)); feed(c, far(1)); b = feed(c, [120, 122, 118, 121, 119])
    check('three areas saying 120 ("near") end the row: a quiet step of two basic steps', b == QUIET)
    c = module_cam(); feed(c, far(0)); feed(c, far(1)); b = feed(c, far(2), running=0); b2 = feed(c, far(3))
    check('the phase module not running ends the row: nothing is written, and the next strong result is the first of a new row', b == OWN(0) and b2 == QUIET)
    c = module_cam(); feed(c, far(0)); frames(c, 31); b = feed(c, far(1))
    check('a strong result 32 frames after the last one starts a new row', b == QUIET)
    c = module_cam(); feed(c, far(0), direction=0); b = feed(c, far(1), direction=0)
    check('travelling against a row that says 400: the camera\'s own count, not named (the vote will turn it)', b == OWN(0))
    c = module_cam(); c.phase(far(0), REL, valid=0)
    check('no phase direction; the step raises its count three times: nothing is written, 0 1 2 seen', frames(c, 3, 'up') == [OWN(0), OWN(1), OWN(2)] and c.s32(W + 0xc78) == 3)
    c.phase([100, 120, 90, 110, 130], TWO)
    check('two reliable areas only: the camera\'s own count (3)', frames(c) == [OWN(3)])
    c.phase([60, 62, 58, 61, 59], REL, direction=0)
    check('three areas, against the travel, value 60 (the focus is just behind): the smallest step instead of the camera\'s own 3', frames(c) == [OWN(0)])
    c.w8(W + 0xe5, 8); feed(c, far(0)); b = feed(c, far(1))
    check('return to the peak (state 8), row or not: the camera\'s own count, not named', b == OWN(3)); c.w8(W + 0xe5, 5)
    c.w16(W + 0x10, 0); b = feed(c, far(2))
    check('basic step 0: nothing is written', b == OWN(3)); c.w16(W + 0x10, 3)
    c = module_cam(direction=0); feed(c, [200, 220, 190, 210, 230], direction=0); b = feed(c, [201, 220, 190, 210, 230], direction=0)
    check('the other way round (direction 0 both): count 18, named', b == (18, 57, 57))
    c = module_cam(base=10); feed(c, far(0)); b = feed(c, far(1))
    check('basic step 10: 111 units become count 10 (110 units), named', b == fastc(401, 10) == (10, 110, 110))
    # the first step of a climb
    c = module_cam(climb=0); feed(c, far(0)); b = feed(c, far(1)); c.w16(W + 0xcb0, 1); d = feed(c, far(2))
    check('a row of 400 on the first step of a climb (module + 0xCB0 == 0, where the camera sets its count anew): nothing written, nothing named; on the next step count 36 (111 units), named', b == OWN(0) and d == (36, 111, 111))
    # a fast step counts as sent only when the camera's step is the amount named
    c = module_cam(); feed(c, far(0)); feed(c, far(1), act=('set', 0)); b = feed(c, far(2))
    check('the step sets the count anew instead of sending the amount named: the fast step is not taken for sent, the next frame names it again', b == (36, 111, 111))
    c = module_cam(); feed(c, far(0))
    def other_amount(c):
        count = c.s32(W + 0xc78); st = c.r32(SLOT); c.seen.append((count, c.r16(W + 0x1e), c.r16(st + MARK))); c.w16(W + 0x1a, 3); c.w16(W + 0xcb0, c.r16(W + 0xcb0) + 1); return 0
    c.native(STEP, other_amount); feed(c, far(1)); b = feed(c, far(2))
    check('a step of another amount (3 units) is sent in that frame: not taken for the fast one either', b == (36, 111, 111))
    # one fast step, then quiet ones
    c = module_cam(); feed(c, [600, 610, 590, 605, 595]); a = feed(c, [601, 610, 590, 605, 595], act='send'); c.position -= 168   # the lens's own position counts down when the lens goes in direction 1
    b = frames(c, 3) + frames(c, 9, 'send')
    check('a row of 600: a 168 unit step is sent fast; in the next 12 frames only quiet steps: two basic steps until 52 units (5/16 of the step) have been added, then the smallest; nothing named',
          a == (55, 168, 168) == fastc(601) and b == [QUIET] * 11 + [SMALL])
    d1 = feed(c, [250, 255, 245, 252, 248]); d2 = feed(c, [251, 255, 245, 252, 248])
    check('  the lens has stopped for 10 frames by then: two new results of 250 are a row again (70 units are left, a second fast step of 69)', d1 == QUIET and d2 == (22, 69, 69) == fastc(251))
    c = module_cam(); feed(c, [600, 610, 590, 605, 595]); feed(c, [601, 610, 590, 605, 595], act='send'); c.position -= 168
    frames(c, 3); e1 = feed(c, [602, 610, 590, 605, 595]); e2 = feed(c, [603, 610, 590, 605, 595]); e3 = feed(c, [604, 610, 590, 605, 595])
    check('  results that appear within 8 frames of the lens stopping (taken before or during the move) are no row: quiet steps go on', e1 == e2 == e3 == QUIET)
    frames(c, 3); f1 = feed(c, [120, 122, 118, 121, 119]); f2 = feed(c, [121, 122, 118, 121, 119])
    check('  with 120 left by the value afterwards (33 units, less than 42): no second fast step, quiet ones', f1 == f2 == QUIET)
    c = module_cam(); feed(c, [20, 22, 18, 21, 19]); frames(c, 9); c.position -= 30; feed(c, [300, 310, 290, 305, 295]); b = feed(c, [301, 310, 290, 305, 295])
    check('the lens moved 30 units the phase way before the row (no fast step): 300 - 30 / 0.28 = 194 is left (54 units, named)', b == fastc(301 - 30 * 256 // Q) == (17, 54, 54))
    c = module_cam(); feed(c, [300, 310, 290, 305, 295]); c.position += 80; b = feed(c, [301, 310, 290, 305, 295])
    check('the lens moved the other way: nothing is taken off', b == fastc(301))
    # trust: the phase value has to follow the lens
    c = module_cam(); feed(c, far(0)); feed(c, far(1), act='send'); c.position -= 60
    seen = frames(c, 30)
    check('a fast step on a row of 400 is sent, the lens goes 60 units that way, and the median stays 400: trust is lost when the value could have shown the move (16 frames); from then on nothing is written',
          all(v[2] == 0xffff for v in seen) and seen[14] == QUIET and seen[-10:] == [OWN(0)] * 10)
    a = feed(c, far(2)); b = feed(c, far(3)); frames(c, 190); d = feed(c, far(4)); e = feed(c, far(5))
    check('  a new row of 400 while the module stays out (240 frames): nothing written', a == b == d == e == OWN(0))
    frames(c, 40); a = feed(c, far(6)); b = feed(c, far(7), act='send'); c.position -= 60
    check('  after 240 frames a new row is acted on again (a fast step)', a == QUIET and b[2] != 0xffff)
    frames(c, 300); a = feed(c, far(8)); b = feed(c, far(9)); frames(c, 200); d = feed(c, far(10)); e = feed(c, far(11))
    check('the same again right away: this time it stays out twice as long (nothing after 300 frames, a row acted on after 500)', a == b == OWN(0) and d == QUIET and e[2] != 0xffff)
    c = module_cam(); feed(c, far(0)); feed(c, far(1), act='send'); c.position -= 100; frames(c, 12); c.phase([120, 122, 118, 121, 119], REL)
    frames(c, 40); a = feed(c, far(2)); b = feed(c, far(3))
    check('the median falling to 120 for those 100 units: trust is kept (a new row of 400 is answered by a fast step again)', a == QUIET and b == fastc(403))

# ---- 6. the module with the camera's real travel state and real lens move in place of the step
def travel_cam(direction=1, base=3, stock=3, climb=1, img=None):
    c = Cam(img or image); c.wobbler(base=base, direction=direction, climb=climb)
    c.stock = stock; c.sent = []; c.votes = 0
    tramp = c.trampoline()
    c.native(STEP, lambda c: c.mu.reg_write(UC_ARM_REG_PC, tramp))
    def vote(c): c.votes += 1; return c.stock
    c.native(VOTE, vote); c.native(AREA_A, lambda c: 3); c.native(AREA_B, lambda c: 0)
    c.native(RAMP_OK, lambda c: 1)     # "the contrast is changing": the camera's own count does not go up in these tests
    c.position = 777
    c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0); c.native(LENS_POSITION, lambda c: c.position)
    c.native(LENS_MOVE, lambda c: (c.sent.append((c.r(2), c.r(3), c.r32(c.r(13)))), 1)[1])
    return c
def frame(c, values=None, direction=1, rel=REL, valid=1):
    if values is not None: c.phase(values, rel, direction=direction, valid=valid)
    c.sent = []; c.w8(W + 9, 1)
    c.call(L['wobbleStub'], O)
    return dict(direction=c.r8(W + 0x21), state=c.r8(W + 0xe5), verdict=c.r8(W + 0xe6), count=c.s32(W + 0xc78), step=c.r16(W + 0x1a), sent=list(c.sent))
NONE = ([100, 120, 90, 110, 130], 1, [200] * 5)       # a frame without a reliable area
c = travel_cam(direction=1, stock=3)
r = frame(c, *NONE)
check('real travel state, no reliable area, vote 3: one basic step (3 units) is sent at 120, direction 1', r['sent'] == [(3, 120, 1)] and r['verdict'] == 3 and c.votes == 1)
if steps_on:
    r0 = frame(c, far(0), 1); r = frame(c, far(1), 1)
    check(f'median 400 twice, travelling the phase way: first a quiet step (6 units at 120), then the camera\'s own code makes the step 111 units and sends it at {mark_speed(111) & 0x7fff}' + (' (marked)' if fast else ''),
          r0['sent'] == [(6, 120, 1)] and r['sent'] == [(111, mark_speed(111), 1)] and r['count'] == 36)
    c.position -= 111
    r = frame(c, far(2), 1)
    check('the next step, the phase value still 400: a quiet one of two basic steps at 120, unmarked', r['sent'] == [(6, 120, 1)])
    c = travel_cam(direction=1, stock=3); c.w32(W + 0xc78, 5)
    r = frame(c, [100, 120, 90, 110, 130], 1, TWO)
    check('the camera\'s own step of 18 units (two reliable areas only): sent at 120, unmarked, as official', r['sent'] == [(18, 120, 1)])
    c = travel_cam(direction=1, stock=3); c.native(RAMP_OK, lambda c: 0)      # the camera's own ramp is free to add to its count
    frame(c, [150, 152, 148, 151, 149], 1); r = frame(c, [151, 152, 148, 151, 149], 1); c.position -= 42; r2 = frame(c, [152, 153, 148, 151, 149], 1)
    c.call(L['stopStub'], O); head, rows = read_quick.parse(c.written)
    check('a fast step smaller than the camera\'s limit (42 units, limit 48) with the camera\'s ramp adding to its count: the limit is the amount named for that step, 42 units go out fast, the step counts as sent, and no second one follows',
          r['sent'] == [(42, mark_speed(42), 1)] and c.r16(W + 0x1e) == 48 and head['sized'] == 1 and r2['sent'] and r2['sent'][0][1] == 120)
    c = travel_cam(direction=1, stock=3); frame(c, far(0), 1); c.w16(W + 0xcb0, 0); r = frame(c, far(1), 1); r2 = frame(c, far(2), 1)
    check('the first step of a climb (module + 0xCB0 == 0) with the row standing: the camera\'s own code sets the count to 0 and sends one basic step at 120; the fast step (111 units) goes out on the next step',
          r['sent'] == [(3, 120, 1)] and r['count'] == 0 and r2['sent'] == [(111, mark_speed(111), 1)])
    c = travel_cam(direction=1, stock=3); frame(c, far(0), 1); c.w16(W + 0xcb0, 0); c.w32(W + 0xc90, 6); r = frame(c, far(1), 1); r2 = frame(c, far(2), 1)
    check('  the same with the camera\'s start count at 6 (module + 0xC90): its own step of 18 units goes out at 120, unmarked; then the fast step', r['sent'] == [(18, 120, 1)] and r['count'] == 5 and r2['sent'] == [(111, mark_speed(111), 1)])
    c.call(L['stopStub'], O); head, rows = read_quick.parse(c.written)
    check('  the file counts one fast step sent, on the step after the put-off one (mark 16, then marks 8 + 1)', head['sized'] == 1 and [r['marks'] & 25 for r in rows] == [0, 16, 9])
if direction_on:
    c = travel_cam(direction=0, stock=3)
    r1 = frame(c, far(0), 1)
    check('travelling in direction 0, one strong phase result for direction 1: nothing replaced yet', r1['direction'] == 0 and r1['verdict'] == 3)
    r2 = frame(c, far(1), 1)
    check('second agreeing result, the travel is young: vote 3 is replaced by 2; the camera\'s own code turns round (direction 1, count 0) and sends one basic step at 120', r2['direction'] == 1 and r2['verdict'] == 2 and r2['count'] == 0 and r2['sent'] == [(3, 120, 1)])
    if steps_on:
        r3 = frame(c, far(2), 1)
        check('next frame: the row\'s way now, so the fast step follows (111 units)', r3['sent'] == [(111, mark_speed(111), 1)] and r3['direction'] == 1)
    c = travel_cam(direction=0, stock=3)
    for k in range(21): frame(c, *NONE)
    r1 = frame(c, far(0), 1); r2 = frame(c, far(1), 1)
    check('the same after the camera has travelled in direction 0 for more than 20 frames: two results do not turn it', r2['direction'] == 0 and r2['verdict'] == 3)
    r3 = frame(c, far(2), 1)
    check('  the third does (three in a row, 180 or more left)', r3['direction'] == 1 and r3['verdict'] == 2)
    c = travel_cam(direction=0, stock=3)
    for k in range(21): frame(c, *NONE)
    for k in range(6): r = frame(c, [160 + k, 170, 150, 165, 155], 1)
    check('  a row of 165 (below 180) never turns such a travel', r['direction'] == 0 and r['verdict'] == 3)
    c = travel_cam(direction=1, stock=3)
    frame(c, far(0), 1); c.stock = 0; r = frame(c, far(1), 1)
    check('travelling the row\'s way, the vote says "peak passed" (0) with 400 left: replaced by 2, the camera goes on (state 5, not 7)' + (' and the fast step goes out' if steps_on else ''),
          r['state'] == 5 and r['verdict'] == 2 and r['direction'] == 1 and (not steps_on or r['sent'] == [(111, mark_speed(111), 1)]))
    if steps_on:
        r = frame(c, far(2), 1)
        check('  in the frames after the fast step (results are no row yet) the vote\'s 0 stands: the camera stops travelling (state 7)', r['state'] == 7 and r['verdict'] == 0)
    c = travel_cam(direction=1, stock=3)
    frame(c, far(0), 1); c.position -= 80; c.stock = 0; r = frame(c, far(1), 1)
    check('the same, but the lens has just moved 80 units that way (400 - 80 / 0.28 = 116 left, below 150): the vote\'s 0 stands, the camera stops travelling', r['state'] == 7 and r['verdict'] == 0)
    c = travel_cam(direction=1, stock=3)
    frame(c, far(0), 1); c.stock = 1; r = frame(c, far(1), 1)
    check('travelling the row\'s way, the vote says "turn round" (1): replaced by 2, no turn', r['direction'] == 1 and r['verdict'] == 2)
    c = travel_cam(direction=0, stock=3)
    frame(c, far(0), 1); c.position -= 80; r = frame(c, far(1), 1)
    check('against the travel, but the lens has just moved 80 units the row\'s way: no forced turn', r['direction'] == 0 and r['verdict'] == 3)
    c = travel_cam(direction=1, stock=3)
    frame(c, [140, 150, 130, 145, 135], 1); frame(c, [141, 150, 130, 145, 135], 1); c.stock = 0; r = frame(c, [142, 150, 130, 145, 135], 1)
    check('median 140 (below 150): the vote\'s 0 stands, the camera stops travelling (state 7)', r['state'] == 7 and r['verdict'] == 0)
    c = travel_cam(direction=0, stock=3)
    frame(c, far(0), 1, TWO); frame(c, far(9), 1, TWO); r = frame(c, far(1), 1, TWO)
    check('only two reliable areas: nothing replaced, no turn', r['direction'] == 0 and r['verdict'] == 3)
    c = travel_cam(direction=0, stock=3)
    frame(c, far(0), 1); frame(c, far(1), 0); frame(c, far(2), 1); frame(c, far(3), 0); r = frame(c, far(4), 1)
    check('results that never agree twice running: nothing replaced', r['direction'] == 0 and r['verdict'] == 3)
    # one forced turn, then none for 20 frames
    c = travel_cam(direction=0, stock=3)
    frame(c, far(0), 1); r = frame(c, far(1), 1)
    turned = r['direction'] == 1
    r = frame(c, far(2), 0); r = frame(c, far(3), 0); r = frame(c, far(4), 0)
    held = r['direction'] == 1
    for k in range(5, 22): r = frame(c, far(k), 0)
    check('after a forced turn the phase direction flips at once: no second forced turn for 20 frames, then one', turned and held and r['direction'] == 0)
    for k in range(22, 43): r = frame(c, far(k), 1)
    third = r['direction']
    for k in range(43, 68): r = frame(c, far(k), 0)
    check('a third forced turn within 42 frames is not made, and the module leaves the camera alone afterwards', third == 0 and r['direction'] == 0 and r['verdict'] == 3)
    # votes replaced for a long time while the lens gets nowhere (the end of its range, say); the fast step never goes out here (always the first step of a climb)
    c = travel_cam(direction=1, stock=3)
    frame(c, far(0), 1); c.stock = 0
    states = []
    for k in range(1, 140): c.w16(W + 0xcb0, 0); states.append(frame(c, far(k), 1)['state'])
    check('"peak passed" replaced by "go on" frame after frame, the lens standing: after 120 frames the vote stands again and the camera stops travelling', states[0] == 5 and states[100] == 5 and states[-1] == 7 and 110 <= states.index(7) <= 125)

# ---- 7. standby: the module may ask for a new search
def standby_cam(asked=1, lens_state=0):
    c = Cam(image); c.wobbler()
    c.native(STEP, lambda c: 0); c.native(MONITOR, lambda c: (c.events.append(('monitor', c.r(0), c.r(1), c.r(2), c.r(3))), 0)[1])
    c.position = 500; c.native(LENS_POSITION, lambda c: c.position)
    c.requests = []
    c.native(RESTART, lambda c: (c.requests.append((c.r(0), c.r(1), c.r(2), c.r(3))), asked)[1]); c.native(LENS_STATE, lambda c: lens_state)
    c.phase([20, 22, 18, 21, 19], REL); c.call(L['wobbleStub'], O)       # one focusing frame: the module's state exists
    return c
def idle(c, n, value=None, direction=1, rel=REL, fresh=True):
    for k in range(n):
        if value is not None: c.phase([value + (k % 7 if fresh else 0), value, value, value, value], rel, direction=direction)
        c.call(L['monitorStub'], O, 0x11, 0x22, 0)
c = standby_cam(); c.events = []; idle(c, 1, 20)
check('standby frame: the official monitor is called with its own arguments', c.events == [('monitor', O, 0x11, 0x22, 0)])
if standby_on:
    c = standby_cam(); idle(c, 300, 20)
    check('in focus by the phase data (value 20) for 300 standby frames: nothing asked', c.requests == [])
    c = standby_cam(); idle(c, 8, 300)
    early = list(c.requests); idle(c, 1, 300)
    check('value 300 with five reliable areas from the first standby frame: nothing in the first 8 frames, then one request (object + 0x48, 2, 2, 0), object + 0x85CB set, the next search\'s ramp flag set', early == [] and c.requests == [(PARENT, 2, 2, 0)] and c.r8(O + 0x85cb) == 1 and c.r8(O + 0x10cb0) == 1)
    idle(c, 200, 300)
    check('  while that request stands (object + 0x85CB) no second one', len(c.requests) == 1)
    c = standby_cam(); idle(c, 40, 20); idle(c, 3, 300); a = len(c.requests); idle(c, 1, 300)
    check('after a quiet standby: four agreeing results of 300 are needed (3: nothing; 4th: request)', a == 0 and len(c.requests) == 1)
    c = standby_cam(); idle(c, 40, 20); idle(c, 3, 300, 1); idle(c, 3, 300, 0); idle(c, 3, 300, 1)
    check('results that change direction: no request until four agree', c.requests == [])
    c = standby_cam(); idle(c, 40, 20); idle(c, 60, 300, fresh=False)
    check('the same result standing unchanged (no new phase result): no request', c.requests == [])
    c = standby_cam(asked=0); idle(c, 14, 300); idle(c, 60, 300, rel=[200] * 5)
    check('a refused request, and no reliable area from then on: when the module may ask again the row\'s last result is more than 8 frames old, so it does not', len(c.requests) == 1)
    c = standby_cam(); idle(c, 100, 140)
    check('value 140 (below 150): no request', c.requests == [])
    c = standby_cam(); idle(c, 100, 300, rel=TWO)
    check('only two reliable areas: no request', c.requests == [])
    for name, field in (('a request already standing (object + 0x85CB)', 0x85cb), ('object + 0x85CC set', 0x85cc), ('object + 0x85E5 set', 0x85e5), ('object + 0x10CE4 set', 0x10ce4), ('a search running (object + 0x85C9)', 0x85c9)):
        c = standby_cam(); c.w8(O + field, 1); idle(c, 100, 300)
        check(f'{name}: no request, as in the camera\'s own decision', c.requests == [])
    c = standby_cam(); c.w8(O + 0x85ca, 0); idle(c, 100, 300)
    check('the camera is not watching (object + 0x85CA clear): no request', c.requests == [])
    c = standby_cam(lens_state=1); idle(c, 100, 300)
    check('the lens state says no (0x5360F0F0 returns 1): no request', c.requests == [])
    c = standby_cam(); c.w8(O + 0x6548, 0); idle(c, 100, 300)
    check('not recording: no request', c.requests == [])
    c = standby_cam(asked=0); idle(c, 39, 300); a = len(c.requests); idle(c, 1, 300)
    check('the camera refuses the request (returns 0): object + 0x85CB stays 0, the module asks again 30 frames later', c.r8(O + 0x85cb) == 0 and a == 1 and len(c.requests) == 2)
    # a request that did not move the lens costs a wait; one that did does not
    def asked_search(c, moved):
        idle(c, 20, 300); n = len(c.requests)
        c.w8(O + 0x85cb, 0); c.position += moved; c.call(L['wobbleStub'], O)     # the search runs (one focusing frame here) and ends
        return n
    c = standby_cam(); n1 = asked_search(c, 3)
    idle(c, 120, 300); a = len(c.requests); idle(c, 1, 300)
    check('a search the module asked for ends 3 units from where it began: the next request waits 120 frames instead of 8', n1 == 1 and a == 1 and len(c.requests) == 2)
    c.w8(O + 0x85cb, 0); c.position += 2; c.call(L['wobbleStub'], O)
    idle(c, 240, 300); a = len(c.requests); idle(c, 1, 300)
    check('  and 240 frames after the next such search', a == 2 and len(c.requests) == 3)
    c = standby_cam(); n1 = asked_search(c, 60); idle(c, 8, 300); a = len(c.requests); idle(c, 1, 300)
    check('a search the module asked for moved the lens 60 units: the next request after 8 frames as usual', n1 == 1 and a == 1 and len(c.requests) == 2)
if standby_on or follow_on:
    # the row is counted across standby and search
    if steps_on:
        c = travel_cam(direction=1, stock=3); c.native(MONITOR, lambda c: 0); c.native(RESTART, lambda c: 1); c.native(LENS_STATE, lambda c: 0)
        frame(c, [20, 22, 18, 21, 19], 1)
        for k in range(11): c.phase(far(k % 3), REL); c.call(L['monitorStub'], O, 0, 0, 0)
        r = frame(c)
        check('a row seen in standby (from its seventh frame on: what the search\'s last frames left does not count) is acted on in the first travel frame of the search (no new result needed): the fast step goes out', r['sent'] == [(111, mark_speed(111), 1)])

# ---- 7b. keeping the focus without a search (versions 7 and 8)
def follow_cam(position=500, img=None, holder=0):
    c = Cam(img or image); c.wobbler()
    c.native(STEP, lambda c: 0); c.native(MONITOR, lambda c: 0)
    c.position = position; c.native(LENS_POSITION, lambda c: c.position)
    c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0)
    c.requests = []; c.native(RESTART, lambda c: (c.requests.append((c.r(0), c.r(1), c.r(2), c.r(3))), 1)[1]); c.native(LENS_STATE, lambda c: 0)
    c.phase([20, 22, 18, 21, 19], REL)
    if img is None: c.call(L['wobbleStub'], O)              # one focusing frame: the module's state exists
    c.sent = c.standby_lens(holder)                         # what reaches the lens control: (amount, speed, direction).  The search has ended: nobody holds the lens
    c.k = 0
    return c
def watch(c, n, value=None, direction=1, rel=REL, fresh=True, move=True, values=None):
    """n standby frames with a new phase result each (all areas about `value`, or the five `values`); the lens goes where it is sent, at once"""
    for _ in range(n):
        c.k += 1
        if values is not None: c.phase([values[0] + (c.k % 7 if fresh else 0)] + list(values[1:]), rel, direction=direction)
        elif value is not None: c.phase([value + (c.k % 7 if fresh else 0), value, value, value, value], rel, direction=direction)
        before = len(c.sent)
        c.call(L['monitorStub'], O, 0x11, 0x22, 0)
        if move:
            for amount, speed, d in c.sent[before:]: c.position += -amount if d == 1 else amount
def world(c, n, focus, ratio):
    """a small world with the camera's curve (recordings of version 8): a value unit is worth 0.18 lens units up to 17 units from the
    focus and `ratio` beyond; the lens goes where it is sent at once"""
    for _ in range(n):
        d = focus - c.position; a = abs(d)
        v = int(a / max(ratio, 0.31)) if d < 0 else int(a / 0.18 if a <= 17 else 17 / 0.18 + (a - 17) / ratio)     # (the far direction: one line, 0.31 at least)
        watch(c, 1, v, direction=0 if d > 0 else 1)
def searched(c, moved=0, frames=3):
    """the search asked for runs and ends: the camera holds the lens meanwhile, and gives it back"""
    c.w8(O + 0x85cb, 0); c.w32(LENS + 0x14, 2); c.position += moved
    for _ in range(frames): c.call(L['wobbleStub'], O)
    c.w32(LENS + 0x14, 0)
def head_of(c):
    c.call(L['stopStub'], O); return read_quick.parse(c.written)[0]
def ask(c):
    """the camera's own decision asks for a new search (the hooked call, r5 = the object): (what it gets back, the requests that went out)"""
    c.mu.reg_write(UC_ARM_REG_R5, O); n = len(c.requests)
    return c.call(L['askStub'], PARENT, 2, 2, 0), c.requests[n:]
if not standby_on:
    c = follow_cam() if follow_on else standby_cam()
    if follow_on: world(c, 100, 500 + 110, 0.37)
    else: idle(c, 100, 300)
    check('no request for a search from the module' + (' (a subject 110 units nearer: the lens goes there by steps instead)' if follow_on else ' (standby off)'), c.requests == [] and (not follow_on or abs(610 - c.position) <= 8))
if follow_on:
    spd = lambda units: mark_speed(units) if units >= 6 else 120     # steps straight are fast ones from 6 units
    U = lambda v: v * 49 >> 8 if v <= 100 else (100 * 49 + (v - 100) * 61) >> 8     # the lens units a step takes for a value: 0.19 x the first 100, 0.24 x the rest
    near = lambda units, v: units in (U(v) - 1, U(v), U(v) + 1, U(v) + 2)             # (the tests' values wander by up to 6)
    UF = lambda v: v * 80 >> 8                                                       # the far direction, the areas agreeing: 0.31 x the value (0.24 when they do not)
    far_ = lambda units, v: units in (UF(v) - 1, UF(v), UF(v) + 1, UF(v) + 2)
    c = follow_cam(); watch(c, 300, 8)
    check('in focus by the phase data (value 8) for 300 standby frames: the lens is left alone', c.sent == [])
    c = follow_cam()
    for k in range(300): watch(c, 1, 20, direction=k % 2)
    check('value 20, now to one side, now to the other, for 300 frames: the lens is left alone', c.sent == [])
    c = follow_cam(); watch(c, 60, 20, direction=0)
    check('value 20 to the near side all the time, no step straight in this recording yet: none for it (the first one has to be large enough to show whether the lens takes it)', c.sent == [])
    c = follow_cam(); world(c, 40, 500 + 30, 0.37); n0 = len(c.sent); c.position -= 8; watch(c, 80, 5, direction=0); quiet = len(c.sent)
    watch(c, 3, 20, direction=0); n3 = len(c.sent); watch(c, 7, 20, direction=0); one = c.sent[n3:]; watch(c, 40, 5, direction=0)
    check(f'after steps that moved the lens ({[m[0] for m in c.sent[:n0]]}) and 80 frames at value 5: value 20 to the near side gives one small step for the running mean (2 .. 4 units at 120) once that mean is 14, not before the fourth result; none when the value then reads 5',
          n0 >= 1 and quiet == n0 and n3 == n0 and len(one) == 1 and one[0][0] in (2, 3, 4) and one[0][1:] == (120, 0) and len(c.sent) == n0 + 1)
    c = follow_cam(); watch(c, 8, 60, direction=0); early = list(c.sent); watch(c, 1, 60, direction=0)
    check('value 60 for the near direction from the first standby frame: nothing in the first 8 frames, then the lens is sent 0.19 x 60 = 11 units that way, a fast step (marked) like every step straight of 6 units and more', early == [] and len(c.sent) == 1 and near(c.sent[0][0], 60) and c.sent[0][1:] == (spd(c.sent[0][0]), 0))
    watch(c, 40, 8, direction=0)
    check('  the value reads 8 afterwards: no further step', len(c.sent) == 1)
    w9 = c.r8(W + 9)
    c = follow_cam(); watch(c, 9, 300, direction=0); busy = c.r8(W + 9); watch(c, 8, 8, direction=0); still = c.r8(W + 9); watch(c, 1, 8, direction=0)
    check('the wobbling module\'s "lens has arrived" flag: cleared by its lens move as always; the lens\'s own callback sets it on the camera (not in this harness), and if that has not come 7 frames after the lens was seen to have stopped the module sets it',
          busy == 0 and still == 0 and c.r8(W + 9) == 1 and w9 == 1)
    c = follow_cam(); watch(c, 9, 300, direction=0)
    check('value 300 for the near direction: 0.19 x 100 + 0.24 x 200 = 66 units at the fast speed (marked)', len(c.sent) == 1 and near(c.sent[0][0], 300) and c.sent[0][1:] == (mark_speed(c.sent[0][0]), 0))
    c = follow_cam(); watch(c, 8, 8); watch(c, 12, 300, direction=1); early = list(c.sent); watch(c, 1, 300, direction=1)
    check('value 300 for the far direction: held for 12 frames, then 0.30 x 300 = 90 units at the fast speed', early == [] and len(c.sent) == 1 and far_(c.sent[0][0], 300) and c.sent[0][1:] == (mark_speed(c.sent[0][0]), 1))
    c = follow_cam(); watch(c, 8, 8); watch(c, 11, 300, direction=1); watch(c, 60, 8)
    check('a far reading of 300 for 11 frames, then in focus again (the subject slipped out of the frame for a moment): the lens is left alone', c.sent == [])
    c = follow_cam(); watch(c, 9, 40, direction=1); n1 = len(c.sent); watch(c, 11, 300, direction=1); n2 = len(c.sent); watch(c, 60, 8)
    check('the same slip right after a small step for the far direction (the subject was moving away slowly): the large value is a subject of its own and is held too', n1 == 1 and c.sent[0][2] == 1 and n2 == 1 and len(c.sent) == 1)
    c = follow_cam(); watch(c, 9, 120, direction=1); n100 = len(c.sent)
    check('value 120 for the far direction (the subject moves away slowly): followed after 8 frames like the near direction, no hold', n100 == 1 and c.sent[0][2] == 1 and far_(c.sent[0][0], 120) and c.sent[0][1] == spd(c.sent[0][0]))
    c = follow_cam(); watch(c, 60, values=[300, 310, 20, 15, 305], direction=1)
    check('far by three areas, but two still read "in focus" (the subject has not left the frame): the lens is left alone', c.sent == [])
    c = follow_cam(); watch(c, 9, values=[300, 310, 20, 15, 305], direction=0)
    check('near by three areas, two still on the old subject: followed (the nearer subject has the majority)', len(c.sent) == 1 and c.sent[0][2] == 0)
    c = follow_cam(); watch(c, 60, 120, direction=0, rel=TWO)
    check('only two reliable areas, value 120: the lens is left alone', c.sent == [])
    c = follow_cam(); watch(c, 8, 8); watch(c, 11, 300, direction=1, rel=TWO); early = list(c.sent); watch(c, 4, 300, direction=1, rel=TWO); one = list(c.sent); watch(c, 200, 300, direction=1, rel=TWO)
    h = head_of(c)
    check(f'only two reliable areas, but they say far 300 again and again (camera, version 10: seven times in 0.9 s, then the camera\'s own search): nothing for 11 frames, then a step of three quarters of 0.24 x 300 (54 units); with the value unchanged, three such steps at most ({len(c.sent)}); trust not lost',
          early == [] and len(one) == 1 and one[0][0] in range(52, 57) and one[0][2] == 1 and len(c.sent) == 3 and h['distrusts'] == 0)
    c = follow_cam(); watch(c, 8, 8); watch(c, 15, 300, direction=1, rel=TWO); n = len(c.sent); watch(c, 30, 300, direction=0, rel=TWO)
    check('  such a step, and then the two areas say the other direction: no step back on such data (the camera\'s own search is let through instead)', n == 1 and len(c.sent) == 1)
    c = follow_cam(); watch(c, 8, 8); watch(c, 15, 300, direction=1, rel=TWO); n = len(c.sent); world(c, 60, c.position - 40, 0.37)
    check(f'  such a step, then three areas again: the rest of the way as usual ({[m[0] for m in c.sent[1:]]})', n == 1 and len(c.sent) >= 2 and all(m[2] == 1 for m in c.sent))
    c = follow_cam()
    for k in range(40): watch(c, 1, 300, direction=1, rel=TWO if k % 3 else REL)
    check('  two areas and three in turn (far 300 from all): the three-area rules decide (hold, then one step), no extra step from the two-area row', len(c.sent) >= 1 and far_(c.sent[0][0], 300))
    c = follow_cam()
    for k in range(60): watch(c, 1, 300, direction=k % 2)
    check('results that change direction every time: the lens is left alone', c.sent == [])
    c = follow_cam(); watch(c, 60, 300, direction=0, fresh=False)
    check('the same result standing unchanged (no new phase result): the lens is left alone', c.sent == [])
    c = follow_cam(); c.w8(O + 0x6548, 0); watch(c, 60, 300, direction=0)
    check('not recording: the lens is left alone', c.sent == [])
    c = follow_cam(); world(c, 60, 500 + 110, 0.45)
    first = [m[0] for m in c.sent]
    check(f'a subject 110 units nearer, a value unit worth 0.45 lens units: steps {first}, all fast ones, ending within 8 units and not past the focus', len(first) in (3, 4, 5, 6) and near(first[0], 94 + 206) and abs(610 - c.position) <= 8 and c.position <= 610 and all(m[2] == 0 and m[1] == spd(m[0]) for m in c.sent))
    n = len(c.sent); focus2 = c.position - 110; world(c, 60, focus2, 0.45)
    second = [m[0] for m in c.sent[n:]]
    check(f'  the next one, 110 units farther: the share of the far direction ({second}), ending within 8 units', far_(second[0], 244) and abs(c.position - focus2) <= 8)
    c = follow_cam(); world(c, 60, 500 + 110, 0.28)
    check(f'a value unit worth 0.28 lens units: most of the way in one step, never past the focus (steps {[m[0] for m in c.sent]})', near(c.sent[0][0], 94 + 332) and c.position <= 610 and abs(610 - c.position) <= 8)
    # trust
    c = follow_cam(); watch(c, 120, 300, direction=0)
    check(f'the lens goes where it is sent but the value stays 300 (a subject moving away as fast, or a value that is no use): four steps ({len(c.sent)}), then none for 120 frames and a search is asked for; trust is not lost',
          len(c.sent) == 4 and len(c.requests) == 1)
    c = follow_cam()
    def wrong(c, n, focus, ratio=0.37):
        for _ in range(n):
            d = focus - c.position; watch(c, 1, int(abs(d) / ratio), direction=1 if d > 0 else 0)     # the direction the wrong way round
    wrong(c, 120, 500 + 110)
    h = None
    check(f'the phase direction is the wrong way round: the value rises by more than twice what the lens moved after each of two steps ({[m[0] for m in c.sent]}): trust lost, nothing more is sent',
          len(c.sent) == 2 and all(m[2] == 1 for m in c.sent) and c.position == 500 - sum(m[0] for m in c.sent))
    r, went = ask(c)
    check('  and the camera\'s own search is let through', r == 1 and went == [(PARENT, 2, 2, 0)])
    # what the camera showed with version 8 (2026-11-15): values that rise although the lens goes the right way, and a value that does not fall as it should
    c = follow_cam(); watch(c, 9, 124, direction=0); first = list(c.sent); watch(c, 7, 294, direction=0); mid = list(c.sent); watch(c, 4, 294, direction=0); second = c.sent[len(first):]
    watch(c, 30, 10, direction=0); h = head_of(c)
    check(f'a subject coming into the frame: value 124, a step ({first[0][0]} units), then the value reads 294 (camera: taken for a step the wrong way, taken back, trust lost): nothing is taken back, the next step waits for the lens and two results and takes what 294 says ({second[0][0] if second else None} units), trust is not lost',
          len(first) == 1 and near(first[0][0], 124) and mid == first and len(second) == 1 and near(second[0][0], 294) and second[0][2] == 0 and h['distrusts'] == 0 and len(c.sent) == 2)
    c = follow_cam(); watch(c, 9, 300, direction=0); n = len(c.sent); k = 0
    while len(c.sent) == n and k < 40: watch(c, 1, 100, direction=0); k += 1
    check(f'the value falls as it should (300, 66 units, then 100): the next step goes out on the first result that counts ({k} frames after the step), 0.19 x 100 = 19 units', n == 1 and k <= 12 and near(c.sent[1][0], 100) and c.sent[1][2] == 0)
    c = follow_cam(); watch(c, 8, 8); watch(c, 13, 395, direction=1); n = len(c.sent); k = 0
    while len(c.sent) == n and k < 60: watch(c, 1, 280, direction=1); k += 1
    check(f'the value does not fall as it should (far 395, {c.sent[0][0]} units, then 280 instead of 0 .. 200: camera, 55 more units on that one result and 65 units past the focus): the next step waits like a new far subject ({k} frames after the step; the hold of 12 frames after the lens has stopped)',
          n == 1 and far_(c.sent[0][0], 395) and k >= 20 and len(c.sent) == 2)
    c = follow_cam(); d = 0
    for _ in range(300):
        n = len(c.sent); watch(c, 1, 300, direction=d)
        if len(c.sent) > n: d ^= 1                  # every step lands with the value as large as before on the other side
    h = head_of(c)
    check(f'after every step the value reads 300 on the other side ({[(-m[0] if m[2] else m[0]) for m in c.sent]}): no step back for 0.3 s each time (18 frames), and after the third such step trust is lost (Sony: a lens that does not go one way)',
          h['distrusts'] == 1 and len(c.sent) == 3 and [m[2] for m in c.sent] == [0, 1, 0])
    # version 13: the factory's own limit of reliability, the newest result only, and no hunting without phase data (camera, version 12, a room with a lamp in the picture)
    ONE = [20, 200, 200, 200, 200]
    c = follow_cam(); watch(c, 60, 300, direction=0, rel=[100] * 5)
    check('five areas with a reliability of 100 (within the 128 the module counted up to version 12, outside the factory\'s 64): no area counts, the lens is left alone', c.sent == [])
    c = follow_cam(); watch(c, 60, 300, direction=0, rel=[60, 64, 20, 100, 128])
    check('three areas within 64, two outside: the three count, the lens goes', len(c.sent) >= 1 and near(c.sent[0][0], 300))
    c = follow_cam(); watch(c, 8, 300, direction=0); n8 = len(c.sent); watch(c, 1, 300, direction=0, rel=ONE); n9 = len(c.sent); watch(c, 1, 300, direction=0); n10 = len(c.sent)
    check('two good results, then one from a single area in the frame the step would go out: no step on the older ones; the next good result sends it', (n8, n9, n10) == (0, 0, 1))
    c = follow_cam(); watch(c, 8, 300, direction=0); watch(c, 1, 300, direction=0, rel=[200] * 5); n9 = len(c.sent)
    check('  the same with no good area in the result standing: no step', n9 == 0)
    def blind(c, n):
        """n standby frames without a reliable area in which the camera wants to search; the frames (from 1) in which it was let through"""
        out = []
        for k in range(n):
            watch(c, 1, 20, rel=[200] * 5)
            if ask(c)[0]: out.append(k + 1)
        return out
    c = follow_cam(); watch(c, 10, 20); first = blind(c, 40)[:1]; searched(c, 50); second = blind(c, 200)[:1]; searched(c, -80); third = blind(c, 400)[:1]
    check(f'no reliable area and the camera wants to search: let through after 30 frames ({first}); that search ends with still no data: the next one after 30 + 120 frames ({second}), the one after that after 30 + 240 ({third})',
          first == [31] and second[0] in range(150, 160) and third[0] in range(270, 282))
    searched(c, 10); watch(c, 12, 20); again = blind(c, 60)[:1]
    check('  usable phase data in between: the wait is 30 frames again', again == [31])
    c = follow_cam(); watch(c, 10, 300, rel=[200] * 5)
    out = []
    for k in range(120):
        watch(c, 1, 20, rel=ONE)
        if ask(c)[0]: out.append(k + 1)
    check('one good area reads 20 ("in focus") and no other counts: the camera\'s wish to search is refused (it went end to end on the camera while one area read 18 .. 48)', out == [])
    # version 12: rules taken from other makers, and what the pooled recordings showed
    c = follow_cam(); watch(c, 9, 300, direction=0); n = len(c.sent); k = 0
    while len(c.sent) == n and k < 40: watch(c, 1, 100, direction=0); k += 1
    check(f'the next step of a way goes out {k} frames after the one before (the lens stops at once here and is seen to have stopped two frames later; results count again 7 frames after that; up to version 11: 12 frames)', n == 1 and k == 9)
    c = follow_cam(); watch(c, 9, 300, direction=0); n = len(c.sent); k = 0
    while len(c.sent) == n and k < 100: watch(c, 1, 60, direction=1); k += 1
    check(f'Canon\'s rule against going back and forth: after a step, the value reads 60 on the other side (a small defocus): no step back for 60 frames ({k})', n == 1 and k == 60 and c.sent[1][2] == 1)
    c = follow_cam(); watch(c, 9, 300, direction=0); n = len(c.sent); k = 0
    while len(c.sent) == n and k < 100: watch(c, 1, 120, direction=1); k += 1
    check(f'  the value reads 120 on the other side (a large one): no step back for 18 frames ({k})', n == 1 and k == 18 and c.sent[1][2] == 1)
    c = follow_cam(); watch(c, 9, 300, direction=0); watch(c, 70, 8); n = len(c.sent); watch(c, 3, 120, direction=1)
    check('  long after the last step: the other direction is followed like any other (two results)', n == 1 and len(c.sent) == 2)
    c = follow_cam(); watch(c, 8, 8); watch(c, 14, values=[300, 420, 180, 310, 290], direction=1)
    mixed = list(c.sent)
    c = follow_cam(); watch(c, 8, 8); watch(c, 14, values=[300, 320, 290, 310, 300], direction=1)
    check(f'far 300, the five areas agreeing (290 .. 320): 0.31 of the value ({c.sent[0][0]} units); not agreeing (180 .. 420): 0.24 ({mixed[0][0]} units)', len(c.sent) == 1 and c.sent[0][0] in range(93, 98) and len(mixed) == 1 and mixed[0][0] in range(70, 75))
    c = follow_cam(); watch(c, 8, 20); watch(c, 1, 100, direction=0); watch(c, 1, 300, direction=0)
    check(f'the value goes from 100 to 300 between two results (a subject coming in): the step is sized by twice the one before, 200 ({c.sent[0][0] if c.sent else None} units; up to version 11: by 1.5 x)', len(c.sent) == 1 and near(c.sent[0][0], 200))
    c = follow_cam(); d = 0
    for _ in range(300):
        n = len(c.sent); watch(c, 1, 300, direction=d)
        if len(c.sent) > n: d ^= 1
    n = len(c.sent); searched(c, 40); goal = c.position + 80; world(c, 60, goal, 0.37)
    check(f'trust lost in standby, the camera\'s search has had its turn: the phase data counts again at once (Sony: back to phase when the contrast search is over), the next change is followed by steps ({[m[0] for m in c.sent[n:]]})', len(c.sent) > n and abs(c.position - goal) <= 8)
    c = follow_cam(); watch(c, 150, 120, direction=0)
    h = head_of(c)
    check(f'the lens goes but the value stays 120 (a subject coming nearer at the pace of the steps): followed step after step ({len(c.sent)} steps of {c.sent[0][0]} in 150 frames), no search asked for, trust kept', len(c.sent) >= 10 and c.requests == [] and h['distrusts'] == 0)
    # who holds the lens, and a lens that takes no step (camera, version 7, 2026-11-14: nine steps sent in standby, none taken, the module off for 4, 8, 16 s)
    c = follow_cam(); holders = []
    for _ in range(14): watch(c, 1, 300, direction=0); holders.append(c.r32(LENS + 0x14))
    check('a step straight from standby, nobody holding the lens: the module takes the lens as the movie AF does when a search begins (user 2), the move reaches the lens control, and the lens is given back when it has stopped',
          len(c.sent) >= 1 and holders[:8] == [0] * 8 and holders[8:10] == [2, 2] and holders[10] == 0 and c.requests == [])
    c = follow_cam(); watch(c, 9, 300, direction=0, move=False); sent9 = list(c.sent); held = c.r32(LENS + 0x14); watch(c, 2, 300, direction=0, move=False); r2 = list(c.requests)
    watch(c, 1, 300, direction=0, move=False); r3 = list(c.requests); back = c.r32(LENS + 0x14); w9 = c.r8(W + 9)
    check('the lens takes no step (its position is unchanged three frames after one of 72 units was sent): the module asks for a search in that very frame, the way the camera\'s own decision does; the lens is given back, the "arrived" flag set',
          len(sent9) == 1 and held == 2 and r2 == [] and r3 == [(PARENT, 2, 2, 0)] and back == 0 and w9 == 1 and c.r8(O + 0x85cb) == 1)
    r, went = ask(c)
    check('  and the camera\'s own wish to search is let through from then on', r == 1 and went == [(PARENT, 2, 2, 0)])
    searched(c, 80); watch(c, 8, 8); n = len(c.requests); watch(c, 8, 300, direction=1); early = len(c.requests) - n; watch(c, 12, 300, direction=1); late = len(c.requests) - n
    check('  the next change in the same recording (value 300, far): no step is tried any more; the module asks for a search, for a far subject after the hold of 18 frames', len(c.sent) == 1 and early == 0 and late == 1)
    searched(c, -80); watch(c, 8, 8); n = len(c.requests); watch(c, 1, 300, direction=0); one = len(c.requests) - n; watch(c, 1, 300, direction=0)
    check('  and for a near subject on the second result', one == 0 and len(c.requests) - n == 1 and len(c.sent) == 1)
    h = head_of(c)
    check(f"  the recording says so: steps straight {h['servos']}, not taken {h['untaken']}, none any more, trust lost {h['distrusts']} times, searches asked for {h['restarts']}", (h['servos'], h['taken'], h['untaken'], h['direct_dead'], h['distrusts'], h['restarts']) == (1, 0, 1, 1, 0, 3))
    c = follow_cam(); watch(c, 9, 80, direction=0, move=False); watch(c, 3, 80, direction=0, move=False); watch(c, 60, 80, direction=0, move=False); r80 = ask(c)
    check('no step to be had and the value is 80: the module does not ask (it does from 100), the camera\'s own wish to search is let through (from 60)', len(c.sent) == 1 and c.requests[:-1] == [] and r80[0] == 1)
    c = follow_cam(); watch(c, 9, 80, direction=0, move=False); watch(c, 3, 80, direction=0, move=False); watch(c, 60, 40, direction=0, move=False); r40 = ask(c)
    check('  the value is 40: refused (the picture is as good as in focus, and a search would pass the focus and come back)', r40 == (0, []))
    c = follow_cam(holder=4); watch(c, 9, 300, direction=0, move=False); r9 = list(c.requests); watch(c, 120, 300, direction=0, move=False)
    h = head_of(c)
    check('someone else holds the lens: nothing is sent to it and it stays theirs; the module asks for a search at once instead; trust not lost', c.sent == [] and c.r32(LENS + 0x14) == 4 and r9 == [(PARENT, 2, 2, 0)] and len(c.requests) == 1 and h['distrusts'] == 0)
    c = follow_cam(holder=4); c.native(RESTART, lambda c: 0); watch(c, 200, 300, direction=0, move=False)
    h = head_of(c)
    check('  and when the lens is theirs every time (three tries, 30 frames apart): no step is tried any more in this recording', c.sent == [] and h['direct_dead'] == 1 and h['distrusts'] == 0)
    c = follow_cam(); world(c, 40, 500 + 110, 0.37); n = len(c.sent); pos = c.position
    c.native(RESTART, lambda c: (c.requests.append((c.r(0), c.r(1), c.r(2), c.r(3))), 0)[1])       # (the camera refuses the requests here, so that none stands)
    watch(c, 60, 300, direction=0, move=False); tried = len(c.sent) - n; watch(c, 55, 300, direction=0, move=False); paused = len(c.sent) - n; watch(c, 60, 300, direction=0, move=False)
    h = head_of(c)
    check(f'steps that moved the lens ({n}), then the lens at the end of its range (no step taken): two tries, then none for 120 frames (the module asks for a search meanwhile: {len(c.requests)} requests), then two tries again; trust not lost',
          n >= 2 and tried == 2 and paused == 2 and len(c.sent) - n == 4 and len(c.requests) >= 2 and h['direct_dead'] == 0 and h['distrusts'] == 0 and h['untaken'] == 4)
    c = follow_cam(); watch(c, 120, 300, direction=0)
    h = head_of(c)
    check('the same, in the recording: four steps, trust not lost, one search asked for', len(c.sent) == 4 and h['distrusts'] == 0 and len(c.requests) == 1)
    c = follow_cam(); c.w8(O + 0x85cb, 1); watch(c, 60, 300, direction=0)
    check('a request for a search stands (object + 0x85CB): no step', c.sent == [])
    # a step straight from standby through the camera's whole lens chain (real code down to the lens control's relative move)
    def chain_follow(value):
        c = Cam(image); c.wobbler()
        c.native(STEP, lambda c: 0); c.native(MONITOR, lambda c: 0); c.native(LENS_POSITION, lambda c: 500); c.native(LENS_STATE, lambda c: 0); c.native(RESTART, lambda c: 1)
        c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0); c.native(SIGNAL, lambda c: 0); c.native(LENS_QUERY, lambda c: 0)
        c.w8(LCO + 0x371, 1); c.w8(LCO + 0x78, 2); c.w8(LCO + 0x1ba, 45)
        c.phase([20, 22, 18, 21, 19], REL); c.call(L['wobbleStub'], O)
        c.w32(LENS + 0x14, 0)                               # the search has ended: nobody holds the lens
        for k in range(9): c.phase([value + k % 7, value, value, value, value], REL, direction=0); c.call(L['monitorStub'], O, 0, 0, 0)
        queued = dict(pending=c.r8(LCO + 0xcc), command=c.r16(LCO + 0xd6), direction=c.r32(LCO + 0xd8), amount=c.r32(LCO + 0xdc), speed=c.r32(LCO + 0xe0))
        c.call(DISPATCH, LCO)
        return queued, dict(speed=c.r16(LCO + 0x1e2), amount=c.r16(LCO + 0x1e4), motor=c.r8(LCO + 0x1e0), go=c.r8(LCO + 0x1d8)), c.r8(W + 0x21), c.r8(W + 0x23)
    q1, r1, travel, last = chain_follow(300)
    check(f"a step of {q1['amount']} units straight from standby, through the lens interface, the command queue and the lens task: command 0x8900 queued with {min(per_unit * q1['amount'], fastest)} marked; the lens task stores that speed with motor setting 45; the wobbling module's travel direction is left as it was (1), its last direction is the step's (0)",
          q1['pending'] == 1 and q1['command'] == 0x8900 and q1['amount'] in (65, 66, 67, 68) and q1['speed'] == (0x8000 | min(per_unit * q1['amount'], fastest)) and r1 == dict(speed=min(per_unit * q1['amount'], fastest), amount=q1['amount'], motor=45, go=1) and (travel, last) == (1, 0))
    q2, r2, travel, last = chain_follow(60)
    check(f"a small one ({q2['amount']} units): a fast step too from 6 units on: queued with {min(per_unit * q2['amount'], fastest)} marked, the lens task stores that speed and motor setting 45",
          q2['pending'] == 1 and q2['amount'] in (11, 12) and q2['speed'] == (0x8000 | min(per_unit * q2['amount'], fastest)) and r2 == dict(speed=min(per_unit * q2['amount'], fastest), amount=q2['amount'], motor=45, go=1))
    # the camera's own decision to search again
    c = follow_cam(); watch(c, 20, 20)
    r, went = ask(c)
    check('the camera wants to search while the phase data says "in focus": refused (0 back, no request)', (r, went) == (0, []))
    watch(c, 30, 20, rel=[200] * 5); r45 = ask(c); watch(c, 1, 20, rel=[200] * 5); r46 = ask(c)
    check('no reliable area for 30 frames: still refused; for 31: let through, with the arguments as the camera gave them', r45 == (0, []) and r46 == (1, [(PARENT, 2, 2, 0)]))
    c = follow_cam(); watch(c, 9, 300, direction=0, move=False); r = ask(c)
    check('a step has just been sent: refused', len(c.sent) == 1 and r == (0, []))
    c = follow_cam()
    for k in range(89): watch(c, 1, 300, direction=k % 2)
    r44 = ask(c)
    for k in range(89, 101): watch(c, 1, 300, direction=k % 2)
    r50 = ask(c)
    check('usable phase data says "out of focus" but no step comes of it (the direction changes every time): refused for 90 frames, then let through', r44 == (0, []) and r50[0] == 1 and c.sent == [])
    c = follow_cam(); watch(c, 9, 300, direction=0); watch(c, 12, 60, direction=1); r12 = ask(c); watch(c, 40, 60, direction=1); r52 = ask(c); n = len(c.sent); watch(c, 10, 60, direction=1)
    check('after a step the value reads 60 on the other side and the module leaves it alone for a second (the rule against going back and forth): the camera\'s own search is refused meanwhile, and then the module takes the step back itself', r12 == (0, []) and r52 == (0, []) and n == 1 and len(c.sent) == 2)
    # refusing is not for ever: the phase data may say "in focus" and be wrong
    def wishing(c, n, value=20):
        """n standby frames in which the camera wants to search; the frames (counted from 1) in which it was let through"""
        out = []
        for k in range(n):
            watch(c, 1, value)
            if ask(c)[0]: out.append(k + 1)
        return out
    c = follow_cam(); watch(c, 10, 20); first = wishing(c, 200)
    check('the camera wants to search in every frame while the phase data says "in focus": refused for 180 frames after the first wish, then one search is let through as a test', first == [182])
    searched(c, 3); second = wishing(c, 400)
    check('  that search has ended (on the contrast peak) and the phase data reads 20 there, wherever the lens went: the two agree, and the next one is let through after 360 frames (counted from the seventh frame after the search)', second == [368])
    c2 = follow_cam(); watch(c2, 10, 20); wishing(c2, 182); searched(c2, 30); third = wishing(c2, 30, value=80)
    h = head_of(c2)
    check('  after a test search the phase data reads 80 twice (it does not agree with the picture): nothing is refused any more in this recording', third == list(range(2, 31)) and h['veto_off'] == 1)
    c2 = follow_cam(); watch(c2, 10, 20); wishing(c2, 182); searched(c2, 30); third = wishing(c2, 100, value=20)
    check('  a test search that moved the lens 30 units, the phase data reads 20 afterwards (the subject had moved): refusing goes on', third == [])
    c = follow_cam(); watch(c, 10, 20); a = wishing(c, 100); watch(c, 61, 20); b = wishing(c, 150)
    check('  the count begins anew when the camera has not wanted to search for 60 frames', a == [] and b == [])
    c = follow_cam(); watch(c, 20, 20); c.w8(O + 0x6548, 0); r = ask(c)
    check('not recording: let through', r == (1, [(PARENT, 2, 2, 0)]))
    c = Cam(image); c.requests = []; c.native(RESTART, lambda c: (c.requests.append((c.r(0), c.r(1), c.r(2), c.r(3))), 1)[1]); r = ask(c)
    check('before any focusing frame (no state yet): let through, nothing allocated', r == (1, [(PARENT, 2, 2, 0)]) and c.allocs == [])
    # the camera's real decision function around the hook
    def decide(c):
        b = [HEAP + 0x9000 + 4 * i for i in range(4)]
        c.w8(b[0], 1); c.w8(b[1], 0); c.w8(b[2], 1); c.w8(b[3], 0); c.w8(O + 0x85cb, 0)
        n = len(c.requests); c.call(DECISION, O, b[0], b[1], b[2], stack=(b[3], 0))
        return c.r8(O + 0x85cb), len(c.requests) - n
    c = follow_cam(img=official_image); a = decide(c)
    c = follow_cam(); watch(c, 20, 20); b = decide(c); watch(c, 46, 20, rel=[200] * 5); d = decide(c)
    check('the camera\'s real decision 0x53614ec4 with a reason to search: official: one request, object + 0x85CB = 1; patched, in focus by the phase data: none, 0x85CB = 0; patched, no usable phase data for 46 frames: one request, 0x85CB = 1',
          a == (1, 1) and b == (0, 0) and d == (1, 1))
if standby_on:
    c = standby_cam(); c.real(MONITOR); c.native(SIGNAL, lambda c: 0); c.real(RESTART)
    idle(c, 60, 300)
    check('with the camera\'s real monitor (which returns at once here: nothing to watch yet) and its real request function: request 2 stands at parent + 0x88, object + 0x85CB is 1', c.r32(PARENT + 0x88) == 2 and c.r8(O + 0x85cb) == 1)
# the camera's own request path (real code): what the request does to the parent object
c = Cam(image); c.native(SIGNAL, lambda c: (c.events.append(('signal', c.r(0), c.r(1))), 0)[1])
r1 = c.call(RESTART, PARENT, 2, 2, 0); first = (c.r32(PARENT + 0x88), list(c.events)); r2 = c.call(RESTART, PARENT, 2, 2, 0)
check('0x5360A4F0 (parent, 2, 2, 0) itself: stores request 2 at parent + 0x88, signals parent + 0x24 with 2, returns 1; a second call while it stands returns 0', r1 == 1 and first == (2, [('signal', PARENT + 0x24, 2)]) and r2 == 0)

# ---- 8. the recording
c = travel_cam(direction=0, stock=3)
c.native(MONITOR, lambda c: 0); c.native(RESTART, lambda c: 1); c.native(LENS_STATE, lambda c: 0)
for k in range(6): frame(c, far(k), 1)
c.position = 777
for k in range(6): frame(c, [30 + k, 31, 29, 30, 32], 1)
c.w32(LENS + 0x14, 0); c.native(LENS_QUERY, lambda c: 0)        # the search has ended: nobody holds the lens
for k in range(50):
    c.phase([300 + k % 5, 300, 300, 300, 300], REL); c.sent = []
    c.zaf_extras(c.position - 3, [-91, -92, -93, 94, -95], dirs=0b10111, good=0b11011)       # (what else the block says; only written to the file)
    c.call(L['monitorStub'], O, 0, 0, 1)
    for amount, speed, d in c.sent: c.position += -amount if d == 1 else amount        # the lens goes where it is sent
c.call(L['stopStub'], O)
if record_on:
    check('stop: the official callback ran, one file written, name C:\\VQ......BIN', ('stop', O) in c.events and c.opened and c.opened.startswith('C:\\VQ') and c.opened.endswith('.BIN') and c.closed == 1)
    head, rows = read_quick.parse(c.written)
    focusing = [r for r in rows if r['phase_of_step'] != read_quick.STANDBY]; waiting = [r for r in rows if r['phase_of_step'] == read_quick.STANDBY]
    check(f"file: version 13, {head['records']} records of {head['frames']} focusing frames; header: frame rate, the camera's speeds, flags, counters", head['version'] == 13 and head['frames'] == 12 and len(focusing) == 12
          and abs(head['frame_rate'] - 59.96) < 0.01 and head['lens_speed'] == [2500, 60, 120, 60, 120] and head['flags'] == flags and head['forced'] == (1 if direction_on else 0) and head['reversals'] == head['forced']
          and head['restarts'] == (1 if standby_on else 0) and head['sized'] == (1 if steps_on else 0) and (head['servos'] >= 1) == follow_on
          # (keeping the focus: the value stays 300 here although the lens goes: one step after the hold, a second one like a new far subject; trust is not lost for that)
          and (not follow_on or (head['servos'], head['taken'], head['untaken'], head['direct_dead'], head['distrusts']) == (2, 2, 0, 0, 0)))
    if follow_on:
        q = head['probes']
        check(f"  the first large step is in the file frame by frame ({len(q)} such steps): its size, the value it was sized by, the lens's movement since and every new result in the 16 frames after it",
              len(q) >= 1 and q[0]['units'] == next(r['step'] for r in waiting if r['marks'] & 128) and q[0]['direction'] == 1 and q[0]['frames'][0]['moved'] == q[0]['units']
              and all(f['new'] and f['valid'] and f['areas'] == 5 and f['median'] in range(300, 305) for f in q[0]['frames'][:10]) and any('lens stopped at +1' in line for line in read_quick.probe_lines(head)))
        f0, f1 = q[0]['pre'], q[0]['frames'][3]
        s16 = lambda v: v - 65536 if v > 32767 else v
        check('  with what else the phase block says, in those frames and in every standby record: the block\'s lens position less the lens\'s own (-3), the factory\'s own "how far" per area (the middle of its two ends: -91, -92, -93, 94, -95) and their median over the reliable areas (-92), the direction per area and the factory\'s quality flags',
              (f0['d14'], f0['mid'], f0['dirs'], f0['quality'], f0['moved']) == (-3, [-91, -92, -93, 94, -95], 0b10111, 0b11011, 0) and (f1['d14'], f1['mid'], f1['val'][1:], f1['rel']) == (-3, [-91, -92, -93, 94, -95], [300] * 4, REL)
              and all((s16(r['base']), s16(r['lens_speed']), r['last_amount']) == (-3, -92, 0b10111 | 0b11011 << 8) for r in waiting))
    check('focusing records: every frame with a vote; time from 0; lens position, phase values, the row and the age of the result, the vote and what replaced it, the step, the lens control\'s speed and motor fields',
          focusing[0]['t_us'] == 0 and all(r['base'] == 3 and r['stock_verdict'] == 3 for r in focusing) and (not direction_on or sum(1 for r in focusing if r['forced'] == 2) == 1) and focusing[-1]['median'] in range(29, 37)
          and (not steps_on or sum(1 for r in focusing if r['marks'] & 1) == 1) and [r['run'] for r in focusing[:2]] == [1, 2] and all(r['age'] == 0 for r in focusing))
    check('standby records: one in eight frames and the frames of a request or a step; the monitor\'s scene flag and the camera\'s fields', len(waiting) in range(7, 14) and all(r['direction'] == 1 and r['verdict'] == 1 for r in waiting)
          and (not standby_on or sum(1 for r in waiting if r['marks'] & 32) == 1) and waiting[0]['count'] == 1
          and (not follow_on or (sum(1 for r in waiting if r['marks'] & 128) == head['servos'] and all(r['step'] >= 6 for r in waiting if r['marks'] & 128)
                                 and waiting[0]['lens'] & 255 == 0 and any(r['lens'] & 0x1ff == 0x102 for r in waiting if r['marks'] & 128))))
    check('the reader\'s summary names the search and the standby', any('search' in line for line in read_quick.summary(head, rows)) and any('standby' in line for line in read_quick.summary(head, rows)))
    c.call(L['stopStub'], O)
    check('a second stop without frames writes nothing', c.closed == 1)
    c.phase(far(0), REL); c.call(L['wobbleStub'], O); c.call(L['stopStub'], O); head2, rows2 = read_quick.parse(c.written)
    check('the next recording starts clean: one frame, one record, no row carried over', c.closed == 2 and head2['frames'] == 1 and len(rows2) == 1 and rows2[0]['run'] == 1 and rows2[0]['t_us'] == 0)
else:
    check('recording off: no file', c.opened is None)
c = Cam(image); c.w32(O + 0x15c8, 0); c.native(STEP, lambda c: (c.events.append(('step', c.r(0), c.r(1))), 5)[1])
check('no wobbling object: the step is simply called and its result returned', c.call(L['wobbleStub'], O) == 5 and c.events == [('step', O, 1)])
c = Cam(image); c.wobbler(); c.native(VOTE, lambda c: 3)
check('the vote stub outside the module\'s step (no state yet): the official result', c.call(L['voteStub'], W, 1) == 3)
c = Cam(image); c.native(MONITOR, lambda c: 0); c.requests = []; c.native(RESTART, lambda c: (c.requests.append(1), 1)[1]); c.phase([300] * 5, REL)
for k in range(100): c.call(L['monitorStub'], O, 0, 0, 0)
check('the monitor stub before any focusing frame (no state yet): nothing asked, nothing allocated', c.requests == [] and c.allocs == [])
c = travel_cam(direction=0, stock=3, img=built)
c.native(MONITOR, lambda c: 0); c.native(RESTART, lambda c: 1); c.native(LENS_STATE, lambda c: 0)
for k in range(3): frame(c, far(k), 1)
c.call(L['stopStub'], O)
check('the build as it is (no file service): three focusing frames and the end of the recording open no file and write nothing; the official callback ran', c.opened is None and c.written is None and c.closed == 0 and ('stop', O) in c.events)
print(f'ALL PASS ({passed[0]} checks)')
