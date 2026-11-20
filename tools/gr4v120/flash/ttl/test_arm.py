# SPDX-License-Identifier: GPL-2.0-only
"""Flash TTL as built into the firmware, run instruction by instruction (armlite.py): the six stubs are entered as
the camera enters them, the appended module runs from the patched image, the camera's own functions it calls are replaced
by Python. Same five shots as host_test.c on the 16 x 16 grid; the record of each shot must equal the host build's, byte
for byte, and X / the pre-emission level must come back as the host build returned them.

The context the stubs pass (struct ctx in flttl.c) is read from the image. When its file service is a native of the
camera, the records are written to the card and compared as written; when it is the build's own stub (GR Mod builds give
the module no file service), nothing may be opened and the record is compared in RAM after the shot (all but `files`,
which then stays 0).

usage: test_arm.py PATCHED_RTOS.bin HOST_LOGS.bin
  PATCHED_RTOS.bin: the RTOS section of a build with flashTtl;  HOST_LOGS.bin: from `host_test HOST_LOGS.bin`."""
import os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from armlite import Arm, M

RTOS = open(sys.argv[1], 'rb').read()
HOST = open(sys.argv[2], 'rb').read()
LOG = 644
BASE, RAM, HEAP, OBJ, STACK, STOP = 0x53000000, 0x55839000, 0x57000000, 0x58000000, 0x5a000000, 0xfffffff0
FRAME_CALL, FRAME_AE, PULSE_CALL, PULSE = 0x5368b3d0, 0x536918c0, 0x53797070, 0x537964f8
FREE_STEP_CALL, ADD_STEP, STATUS_CALL, STATUS_SET = 0x5368774c, 0x53684ca4, 0x53a9b70c, 0x537986e0
X_CALL, X_FN, LEVEL_CALL, LEVEL_SET = 0x536a5198, 0x5369ceb8, 0x536a562c, 0x536a3a04
word = lambda a: struct.unpack_from('<I', RTOS, a - BASE)[0]
target = lambda a: (a + 8 + 4 * ((word(a) & 0xffffff) - (1 << 24 if word(a) & 0x800000 else 0))) & M
FRAME_STUB, PULSE_STUB, DELAY_STUB, STATUS_STUB, X_STUB, LEVEL_STUB = (target(a) for a in (FRAME_CALL, PULSE_CALL, FREE_STEP_CALL, STATUS_CALL, X_CALL, LEVEL_CALL))
assert X_STUB != X_FN and LEVEL_STUB != LEVEL_SET and FRAME_STUB != FRAME_AE, 'this image does not have flash TTL'
assert len(HOST) == 5 * LOG, 'HOST_LOGS.bin is not five logs'
# The context: the frame stub loads it with movw r0 / movt r0 after its first two instructions.
mov_imm = lambda w: ((w >> 4) & 0xf000) | (w & 0xfff)
assert word(FRAME_STUB + 8) & 0xfff0f000 == 0xe3000000 and word(FRAME_STUB + 12) & 0xfff0f000 == 0xe3400000, 'frame stub: no movw / movt r0'
CTX = mov_imm(word(FRAME_STUB + 8)) | mov_imm(word(FRAME_STUB + 12)) << 16
assert word(CTX) == 0x4c54464c, 'context magic'
SLOT, ALLOC, TIMER_H, TICK, ELAPSED, FLASH_H, FILE_H, AE_H, SETTINGS_H, FLASH_MODE = (word(CTX + 4 * k) for k in range(1, 11))
FILES = not (word(FILE_H) == 0xe3a00000 and word(FILE_H + 4) == 0xe12fff1e)  # a native, not the build's `mov r0,#0; bx lr`
print(f'context at {CTX:#x}, state pointer in {SLOT:#x}, ' + ('records written to the card' if FILES else 'no file service: records compared in RAM'))
bits = lambda f: struct.unpack('<I', struct.pack('<f', f))[0]

fails = 0
def check(name, ok):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name); fails += not ok

cpu = Arm()
cpu.map(BASE, RTOS)
ram = cpu.map(RAM, bytes(0x1000))
heap = cpu.map(HEAP, bytes(0x10000))
obj = cpu.map(OBJ, bytes(0x50000))
stack = cpu.map(STACK, bytes(0x10000))
# objects (camera offsets)
TIMER, TIMER_HOLD, FLASH, FLASH_HOLD, RECORD, AE_HOLD, FS, FILE_HOLD, VT, SET, SETTINGS_HOLD, SETTINGS, TASK, LVX, CALC, FC, OBJECT, RESULT, RAW = (OBJ + k for k in
    (0x000, 0x040, 0x100, 0x200, 0x400, 0xa00, 0xa40, 0xa80, 0xb00, 0xc00, 0xe00, 0xe20, 0xe40, 0xe80, 0xf80, 0xfc0, 0x1000, 0x3000, 0x40000))
OPEN, WRITE, CLOSE = 0xf0000100, 0xf0000200, 0xf0000300
put = lambda a, v: cpu.wr(a, v)
put(TIMER_HOLD + 0xc, TIMER); put(TIMER + 8, 0xffffffff)
put(FLASH_HOLD + 0x10, FLASH); cpu.wr(FLASH + 0x14, 0x10, 1)
for i in range(32): cpu.wr(FLASH + 0x6c + i, i + 1, 1)
put(AE_HOLD + 8, RECORD); cpu.wr(RECORD + 0x3e, 0x10, 2)
put(FILE_HOLD + 0x14, FS); put(FS, VT); put(VT + 0x20, OPEN); put(VT + 0x2c, WRITE); put(VT + 0x24, CLOSE)
put(OBJECT + 8, SET); put(SET + 8, RESULT); put(TASK + 0x34, OBJECT); put(OBJECT + 0x1474, LVX); put(CALC + 0x18, RECORD)
put(OBJECT + 0x1488, bits(3.0)); put(SET + 0x94, 1024); put(SET + 0x12c, bits(0.25))
put(RESULT + 0x1400c, RAW); put(SETTINGS_HOLD + 4, SETTINGS)
cpu.wr(RESULT, 16, 2); cpu.wr(RESULT + 2, 16, 2)
for i in range(4): cpu.wr(RESULT + 0x14010 + 2 * i, 256, 2)

state = dict(mode=0, steps=[], sets=[], levels=[], now_us=0, allocs=0, heap=HEAP, ae_calls=0, pulse_calls=[], opens=[], written=[], closes=0, x=0, x_calls=[])
def h_alloc(c):
    n = c.r[0]; state['allocs'] += 1; a = state['heap']; state['heap'] += (n + 15) & ~15
    for k in range(n): heap[a - HEAP + k] = 0xaa                # operator new does not clear
    c.ret(a)
def h_open(c):
    name = bytearray()
    a = c.r[1]
    while c.rd(a, 1): name.append(c.rd(a, 1)); a += 1
    state['opens'].append((name.decode(), c.r[2], c.rd(c.r[13])))  # name, third argument, fifth argument (on the stack)
    c.wr(c.r[3], 77); c.ret(1)
def h_write(c):
    if c.r[1] == 77 and c.rd(c.r[13]) == 0:
        buf, o = c.find(c.r[2], c.r[3]); state['written'].append(bytes(buf[o:o + c.r[3]]))
    c.ret(c.r[3])
def h_close(c): state['closes'] += c.r[1] == 77 and c.r[2] == 0; c.ret(1)
def h_x(c):
    state['x_calls'].append((c.r[0], c.r[14])); c.s[0] = state['x']
    c.r[0] = c.r[1] = c.r[2] = c.r[3] = c.r[12] = 0xdead0000     # what a call may destroy
    c.ret()
cpu.hooks.update({
    ALLOC: h_alloc, TIMER_H: lambda c: c.ret(TIMER_HOLD), FLASH_H: lambda c: c.ret(FLASH_HOLD), AE_H: lambda c: c.ret(AE_HOLD),
    TICK: lambda c: c.ret((0x80000000 - state['now_us'] * 27) & M),
    ELAPSED: lambda c: c.ret(((c.r[1] - c.r[2]) & M) // 27),
    FRAME_AE: lambda c: (state.__setitem__('ae_calls', state['ae_calls'] + 1), c.ret(0x12345678))[1],
    PULSE: lambda c: (state['pulse_calls'].append((c.r[0], c.r[1], c.r[14])), c.ret(0))[1],
    OPEN: h_open, WRITE: h_write, CLOSE: h_close, X_FN: h_x,
    SETTINGS_H: lambda c: c.ret(SETTINGS_HOLD), FLASH_MODE: lambda c: c.ret(state['mode'] if c.r[0] == SETTINGS else 99),
    STATUS_SET: lambda c: (state['sets'].append((c.r[0], c.r[1], c.r[2], c.r[14])), c.ret(0))[1],
    LEVEL_SET: lambda c: (state['levels'].append((c.r[0], c.r[1], c.r[2], c.r[3], c.r[14])), c.ret(0))[1],
    **({FILE_H: lambda c: c.ret(FILE_HOLD)} if FILES else {}),
    ADD_STEP: lambda c: (state['steps'].append((c.r[0], c.r[1], c.r[2], c.r[3], c.rd(c.r[13]), c.rd(c.r[13] + 4), c.rd(c.r[13] + 8), c.rd(c.r[13] + 12), c.r[14])), c.ret(0))[1]})

SP0 = STACK + 0xf000
all_ok = True
def enter(stub, r0, r1, sp=None, r7=None):
    """Call a stub with the callee-saved registers the camera has there; they and sp must come back, nothing may be written into the image."""
    global all_ok
    saved = [0x44440000 + k for k in range(8)]
    saved[0] = TASK                                                 # the live view exposure task's object (frame stub reads [r4 + 0x34])
    if r7 is not None: saved[3] = r7
    for k in range(4, 12): cpu.r[k] = saved[k - 4]
    cpu.writes.clear()
    cpu.call(stub, (r0, r1, 0x9999, 0x8888), sp=sp or SP0, stop=STOP, limit=20_000_000)
    ok = cpu.r[13] == (sp or SP0) and [cpu.r[k] for k in range(4, 12)] == saved and not [a for a, n in cpu.writes if BASE <= a < BASE + len(RTOS)]
    all_ok &= ok
    return ok

def frame(): return enter(FRAME_STUB, OBJECT, 0)
def pulse(): return enter(PULSE_STUB, 0x1111, 0x2222)
def status(byte):
    """The status read stores its two bytes: r0 = the manager, r1 = first byte, r2 = second. Returns the first byte as stored."""
    state['sets'].clear()
    ok = enter(STATUS_STUB, FLASH, byte)
    got = state['sets'][0] if len(state['sets']) == 1 else (0, None, 0, 0)
    return got[1] if ok and got[0] == FLASH and got[2] == 0x9999 and got[3] == STOP else None
def level(value, flash_state):
    """The output level setter call: r0 = flash data, r1 = level; r7 = flash state. Returns the level as stored."""
    state['levels'].clear()
    ok = enter(LEVEL_STUB, FC, value, r7=flash_state)
    got = state['levels'][0] if len(state['levels']) == 1 else (0, None, 0, 0, 0)
    return got[1] if ok and got[0] == FC and got[2:] == (0x9999, 0x8888, STOP) else None
def x(value_bits):
    """The formula call: r0 = calculation object, X comes back in s0. Returns s0 after the stub."""
    state['x'] = value_bits; state['x_calls'].clear(); cpu.s.clear()
    ok = enter(X_STUB, CALC, 0x2222)
    return cpu.s.get(0) if ok and state['x_calls'] and state['x_calls'][0][0] == CALC and len(state['x_calls']) == 1 else None
def delay(mode, kind):
    """The add-step call for the "free live view" step as the plan builder makes it: four stack arguments, the first the delay."""
    state['mode'] = mode; cpu.wr(FLASH + 0x14, kind, 1); state['steps'].clear()
    sp = SP0 - 16
    for k, v in enumerate((0, 0x51, 0x52, 0x53)): cpu.wr(sp + 4 * k, v)
    ok = enter(DELAY_STUB, 0x1111, 0x2222, sp)
    return ok, state['steps'][0] if len(state['steps']) == 1 else None

def pixel(pattern, lit, row, col, rows=16, columns=16):
    v = 200 + (row * 7 + col * 3) % 16
    centre = rows // 4 <= row < rows * 3 // 4 and columns // 4 <= col < columns * 3 // 4
    if not lit: return v
    if pattern == 1: return v + (600 if centre else 50)
    if pattern == 2: return v + (400 if rows // 4 <= row < rows * 5 // 8 else 0)
    if pattern == 3: return v + (3800 if centre else 50)
    if pattern == 4: return v + 5
    if pattern == 5: return v + 1500
    return v
def fill(pattern, lit):
    raw = bytearray()
    for row in range(16):
        raw += struct.pack('<16I', *[row * col for col in range(16)])
        for col in range(16):
            g = pixel(pattern, lit, row, col)
            raw += struct.pack('<4I', 100, 100 * (256 + g // 2), 100 * (256 + g), 100 * (256 + g // 3))
    obj[RAW - OBJ:RAW - OBJ + len(raw)] = raw

want = lambda ms: (0x1111, 0x2222, 0x9999, 0x8888, ms, 0x51, 0x52, 0x53, STOP)
ok = pulse()
check('pulse before the first frame: no state, original call made with r0, r1, lr intact', ok and state['allocs'] == 0 and cpu.rd(SLOT) == 0 and state['pulse_calls'] == [(0x1111, 0x2222, STOP)])
check('X, level and status with no state: passed through', x(bits(3.0)) == bits(3.0) and level(0x40, 0xa) == 0x40 and status(0x20) == 0x20)
cpu.wr(FLASH + 0x14, 0, 1)
ok = frame()
check('no GF-2 class flash: the camera\'s AE still runs, nothing else', ok and state['ae_calls'] == 1 and state['allocs'] == 0 and cpu.rd(SLOT) == 0)
res = [delay(m, 0x10) for m in range(4)] + [delay(1, 2), delay(3, 0)]
check('free-live-view step: delay 150 ms with a GF-2 class flash in the two red-eye modes, else 0; the other arguments and lr untouched',
      all(ok for ok, _ in res) and [s for _, s in res] == [want(0), want(150), want(0), want(150), want(0), want(0)])
cpu.wr(FLASH + 0x14, 0x10, 1)

# distance mm, the camera's Dv, scene Ev, live view time, gain, X, pattern, expected pre-emission level (as host_test.c)
SHOTS = [(1200, 0.526, 5.0, 16000, 4096, 3.0, 1, 60), (400, -2.64, 6.5, 8000, 2048, 0.5, 2, 42), (3000, 3.17, 4.0, 16000, 8192, 5.0, 3, 0x40),
         (2000, 2.0, 5.0, 16000, 4096, 4.0, 4, 0x40), (9000, 6.34, 5.0, 16000, 4096, 6.5, 5, 0x40)]
for n, (mm, dv, ev, t_us, gain, xin, pattern, want_level) in enumerate(SHOTS):
    host = HOST[n * LOG:(n + 1) * LOG]
    host_x_out = struct.unpack_from("<I", host, 0xc4)[0] or bits(xin)   # x_out_bits; 0 when X was left alone
    t0 = 1000000 + n * 3000000
    put(RECORD + 0x584, mm); put(RECORD + 0x84, bits(dv)); put(RECORD + 0x140, bits(ev)); put(RECORD + 0x64, bits(ev + 1))
    put(LVX + 0xa0, t_us); put(LVX + 0x9c, gain)
    cpu.wr(FLASH + 0x77, 1, 1); cpu.wr(FLASH + 0x84, 0, 1)
    fill(pattern, 0)
    state['now_us'] = t0; frame()
    state['now_us'] = t0 + 16000; frame()
    state['now_us'] = t0 + 18000
    got = [level(70, 3), level(0x30, 0xa), level(0x40, 0xa)]
    cpu.wr(FLASH + 0x6c, want_level, 1); cpu.wr(FLASH + 0x84, want_level - 1, 1)
    before = x(bits(xin))
    state['now_us'] = t0 + 20000; pulse()
    state['now_us'] = t0 + 30000
    held = [status(0x20), status(0x21)]
    unmeasured = x(bits(xin))
    fill(pattern, 1)
    state['now_us'] = t0 + 32000; frame()
    fill(pattern, 0)
    state['now_us'] = t0 + 48000; frame()
    state['now_us'] = t0 + 200000
    out = [x(bits(xin)), x(bits(xin))]
    state['now_us'] = t0 + 700000
    late = status(0x20)
    cpu.wr(FLASH + 0x6c, 60, 1)
    state['now_us'] = t0 + 1000000; frame()
    if FILES:
        w = state['written'][n] if len(state['written']) == n + 1 else b''
    else:  # the record in RAM (struct state starts with it); `files` stays 0 without a file service
        rec = bytes(heap[cpu.rd(SLOT) - HEAP:cpu.rd(SLOT) - HEAP + LOG])
        w = rec if struct.unpack_from('<I', rec, 16)[0] == 0 and not state['written'] else b''
        host = host[:16] + bytes(4) + host[20:]
    check(f'shot {n + 1}: pre-emission level {got[2]:#x} for {mm} mm, other levels as they were; X {struct.unpack("<f", struct.pack("<I", out[0]))[0]:.3f} as the host build; '
          'status held for 600 ms; before the measurement X as it was',
          got == [70, 0x30, want_level] and before == bits(xin) and unmeasured == bits(xin) and out == [host_x_out, host_x_out] and held == [0x21, 0x21] and late == 0x20)
    check(f'shot {n + 1}: the record ' + ('written to the card' if FILES else 'in RAM') + f' ({len(w)} bytes) equals the host build\'s, byte for byte', w == host)
check('all stub calls: registers r4-r11 and sp preserved, no write into the image', all_ok)
check('operator new called once; the pointer is in the RAM slot', state['allocs'] == 1 and cpu.rd(SLOT) == HEAP)
if FILES:
    check('five files: open(name, 0, &handle, 0), one write, close each', len(state['opens']) == 5 and state['closes'] == 5 and
          all(len(nm) == 15 and nm.startswith('C:\\FT') and nm.endswith('.BIN') and a == 0 and b == 0 for nm, a, b in state['opens']) and len({nm for nm, _, _ in state['opens']}) == 5)
else:
    check('no file service: nothing opened, written or closed', not state['opens'] and not state['written'] and state['closes'] == 0)
depth = SP0 - cpu.sp_min
check(f'stack use {depth} bytes (limit 512)', 0 < depth <= 512)
print(f'{cpu.steps} instructions interpreted')
print('ALL PASS' if not fails else 'SOME CHECKS FAILED')
sys.exit(1 if fails else 0)
