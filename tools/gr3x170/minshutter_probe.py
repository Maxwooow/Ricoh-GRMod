# SPDX-License-Identifier: GPL-2.0-only
"""ISO Setting › Minimum Shutter Speed to 30" (core/src/fw/gr3x170/minshutter.ts, issue #25), executed.

The camera's own list functions (create, rows, set, mark the current value, Down held) run on the
official RTOS and on the official RTOS with the build's patch sites applied, with the list widget,
the property services and the setting substituted (the label formatter and the Tv conversions are
the camera's own code). The built list must have 46 rows: the 31 official ones first (labels, the
Tv each sets and the marking exactly as the official list), then 1.3" .. 30" (Tv -1/3 .. -5) with
their marking; a Tv in no row marks none; Down held stops at the last row; the create function hands
46 row types (0x15) to the widget and keeps the stack and the callee-saved registers.

    python3 tools/gr3x170/minshutter_probe.py RTOS.bin patch-manifest.json
"""
import argparse, json, struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn import arm_const as A

if not __debug__: raise RuntimeError('Validation requires Python assertions')
B = 0x53000000
# The list's functions (minshutter.ts) and what they call.
KEYS, SET, CREATE, ROWS, CURRENT = 0x531cf7e8, 0x531cf880, 0x531cfa20, 0x531cfab0, 0x531cfb40
LIST_CREATE, ROW_AT, CURRENT_ROW, MOVE, CURSOR = 0x53394700, 0x53394848, 0x53394910, 0x53395350, 0x53395520
ROW_MARK, ROW_TEXT = 0x5339e828, 0x5339e8cc
PROPERTY, PROPERTY2, PROPERTY3 = 0x5320ae60, 0x5320b754, 0x5320b3f4
TV_FLAG, TV_PREPARE, TV_FROM_PAIR, PAIR_FROM_TV = 0x53d62cb4, 0x536c02d0, 0x536c0848, 0x536c0780
SETTING_SET, SETTING_GET = 0x53242840, 0x5324417c
STACK, STOP = 0x61000000, 0x60000000
OBJ, LIST, ROWBASE, PROP, BUF = 0x62000000, 0x62010000, 0x62020000, 0x62030000, 0x62040000
OFFICIAL, VALUES = 31, 46
NEW_LABELS = ['1.3"', '1.6"', '2"', '2.5"', '3"', '4"', '5"', '6"', '8"', '10"', '13"', '15"', '20"', '25"', '30"']

def apply_sites(data, manifest):
    out = bytearray(data)
    for s in manifest['sites']:
        at = (s['address'] if isinstance(s['address'], int) else int(s['address'], 16)) - B
        old, new = bytes.fromhex(s['expected']), bytes.fromhex(s['replacement'])
        assert out[at:at + 4] == old, hex(B + at)
        out[at:at + 4] = new
    return bytes(out)

class Cam:
    def __init__(s, R):
        c = s.c = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        c.mem_map(B, (len(R) + 0xfff) & ~0xfff); c.mem_write(B, bytes(R))
        src, dst, size = struct.unpack_from('<3I', R, 0x450)
        c.mem_map(dst, (size + 0xfff) & ~0xfff); c.mem_write(dst, bytes(R[src - B:src - B + size]))
        c.mem_map(STOP & ~0xfff, 0x1000); c.mem_map(STACK - 0x100000, 0x101000); c.mem_map(0x62000000, 0x100000)
        c.reg_write(A.UC_ARM_REG_C1_C0_2, c.reg_read(A.UC_ARM_REG_C1_C0_2) | (0xf << 20))
        c.reg_write(A.UC_ARM_REG_FPEXC, 0x40000000)
        s.stubs = {}; s.calls = 0
        c.hook_add(UC_HOOK_CODE, s._hook)
        c.mem_write(OBJ + 0x160, struct.pack('<I', LIST))
    def stub(s, at, fn): s.stubs[at] = fn
    def _hook(s, c, at, size, ud):
        f = s.stubs.get(at)
        if f is None: return
        r = f(c)
        if r is not None: c.reg_write(A.UC_ARM_REG_R0, r & 0xffffffff)
        c.reg_write(A.UC_ARM_REG_PC, c.reg_read(A.UC_ARM_REG_LR))
    def call(s, at, *args, s0=None):
        c = s.c; s.calls += 1
        for i, v in enumerate(args): c.reg_write(getattr(A, f'UC_ARM_REG_R{i}'), v)
        if s0 is not None: c.reg_write(A.UC_ARM_REG_S0, struct.unpack('<I', struct.pack('<f', s0))[0])
        saved = [0x4440 + i for i in range(4, 12)]
        for i, v in zip(range(4, 12), saved): c.reg_write(getattr(A, f'UC_ARM_REG_R{i}'), v)
        c.reg_write(A.UC_ARM_REG_SP, STACK); c.reg_write(A.UC_ARM_REG_LR, STOP)
        c.emu_start(at, STOP, count=2_000_000)
        assert c.reg_read(A.UC_ARM_REG_PC) == STOP, hex(c.reg_read(A.UC_ARM_REG_PC))
        assert c.reg_read(A.UC_ARM_REG_SP) == STACK, 'stack'
        assert [c.reg_read(getattr(A, f'UC_ARM_REG_R{i}')) for i in range(4, 12)] == saved, 'callee-saved registers'
        return c.reg_read(A.UC_ARM_REG_R0)
    def f32(s): return struct.unpack('<f', struct.pack('<I', s.c.reg_read(A.UC_ARM_REG_S0)))[0]
    def cstr(s, a): return bytes(s.c.mem_read(a, 32)).split(b'\0')[0].decode()

def run_list(R):
    """Everything the list does, through the camera's own functions."""
    cam = Cam(R); out = {}
    seen = {}
    def create(c):
        n = c.reg_read(A.UC_ARM_REG_R2)
        seen['args'] = (c.reg_read(A.UC_ARM_REG_R0), n, c.reg_read(A.UC_ARM_REG_R3))
        seen['types'] = bytes(c.mem_read(c.reg_read(A.UC_ARM_REG_R1), n))
    cam.stub(LIST_CREATE, create)
    cam.call(CREATE, OBJ)
    out['create'] = (seen['args'], seen['types'])
    rows = {}
    cam.stub(ROW_AT, lambda c: ROWBASE + 0x10 * c.reg_read(A.UC_ARM_REG_R1))
    cam.stub(PROPERTY, lambda c: PROP); cam.stub(PROPERTY2, lambda c: PROP)
    def label(c): rows[(c.reg_read(A.UC_ARM_REG_R0) - ROWBASE) // 0x10] = cam.cstr(c.reg_read(A.UC_ARM_REG_R1))
    cam.stub(ROW_TEXT, label)
    cam.call(ROWS, OBJ)
    out['labels'] = [rows[i] for i in sorted(rows)]
    n = len(out['labels'])
    tvs, cur = [], {'i': 0}
    cam.stub(CURRENT_ROW, lambda c: cur['i'])
    cam.stub(PROPERTY3, lambda c: PROP)
    cam.stub(TV_PREPARE, lambda c: 0)
    cam.stub(SETTING_SET, lambda c: tvs.append(cam.f32()))
    for i in range(n): cur['i'] = i; cam.call(SET, OBJ)
    out['tv'] = tvs
    marks = []
    for tv in tvs + [7.5, -6.0]:
        on, cursor = [], []
        cam.stub(SETTING_GET, lambda c, tv=tv: c.reg_write(A.UC_ARM_REG_S0, struct.unpack('<I', struct.pack('<f', tv))[0]))
        cam.stub(ROW_MARK, lambda c: on.append(((c.reg_read(A.UC_ARM_REG_R0) - ROWBASE) // 0x10, c.reg_read(A.UC_ARM_REG_R1))))
        cam.stub(CURSOR, lambda c: cursor.append(c.reg_read(A.UC_ARM_REG_R1)))
        cam.call(CURRENT, OBJ)
        marks.append((sorted(k for k, v in on if v == 1), len(on), cursor))
    out['marks'] = marks
    moves = []
    for i in range(n):
        mv = []
        cam.stub(MOVE, lambda c: mv.append((c.reg_read(A.UC_ARM_REG_R1), c.reg_read(A.UC_ARM_REG_R2))))
        cur['i'] = i
        # r1 -> event; [r1+4] -> key info; [[r1+4]+4] = repeat (held)
        cam.c.mem_write(BUF + 0x40, struct.pack('<II', 0, BUF + 0x50)); cam.c.mem_write(BUF + 0x50, struct.pack('<II', 0, 1))
        cam.call(KEYS, OBJ, BUF + 0x40)
        moves.append(mv)
    out['downHeld'] = moves
    out['calls'] = cam.calls
    return out

def verify(data, manifest):
    assert manifest.get('minShutter') is True
    o = run_list(data); p = run_list(apply_sites(data, manifest))
    n = len(p['labels'])
    assert len(o['labels']) == OFFICIAL and n == VALUES, (len(o['labels']), n)
    assert o['create'][0][1:] == (OFFICIAL, 0x3a) and o['create'][1] == bytes([0x15]) * OFFICIAL
    assert p['create'][0][1:] == (VALUES, 0x3a) and p['create'][1] == bytes([0x15]) * VALUES
    assert o['labels'][0] == '1/1000' and o['labels'][-1] == '1"', o['labels']
    assert p['labels'][:OFFICIAL] == o['labels'] and p['tv'][:OFFICIAL] == o['tv']
    assert p['labels'][OFFICIAL:] == NEW_LABELS, p['labels'][OFFICIAL:]
    assert all(abs(p['tv'][OFFICIAL + k] - (-(k + 1) / 3)) < 1e-4 for k in range(VALUES - OFFICIAL)), p['tv'][OFFICIAL:]
    for i in range(n): assert p['marks'][i] == ([i], VALUES, [i]), (i, p['marks'][i])
    for i in range(OFFICIAL): assert o['marks'][i] == ([i], OFFICIAL, [i])
    assert p['marks'][VALUES] == ([o['marks'][OFFICIAL][0][0]], VALUES, o['marks'][OFFICIAL][2]) and p['marks'][VALUES + 1] == ([], VALUES, [])
    assert all(m == [(1, 1)] for m in p['downHeld'][:VALUES - 1]) and p['downHeld'][VALUES - 1] == []
    assert o['downHeld'][:OFFICIAL - 1] == p['downHeld'][:OFFICIAL - 1] and o['downHeld'][OFFICIAL - 1] == []
    return dict(schema=1, values=n, official=OFFICIAL, labels=p['labels'], tv=[round(x, 4) for x in p['tv']],
                calls=o['calls'] + p['calls'])

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0]); ap.add_argument('rtos'); ap.add_argument('manifest')
    a = ap.parse_args()
    r = verify(open(a.rtos, 'rb').read(), json.load(open(a.manifest)))
    print(json.dumps({k: v for k, v in r.items() if k != 'tv'}))
    print('passed: 46 values, the official 31 first (labels, Tv set, marking), then 1.3" .. 30" (Tv -1/3 .. -5)')
