# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of the battery percentage (core/src/fw/gr4v121/aspect/battery.ts). NOT part of the
program.

    python3 check.py BUILT-RTOS OFFICIAL-RTOS [--diag] [--sequence CSV]

BUILT-RTOS / OFFICIAL-RTOS: RTOS sections (decoded); BUILT-RTOS is a build with the battery
percentage (--diag: its diagnostic variant, "?" and "!" instead of the camera's icon). --sequence:
a CSV with columns `step` and `percent` (for example the power reports of a set of photos, maker
note tag 0x0216), run in order as one session. Needs the Python packages unicorn and capstone.

 1. Static: GetBatteryIcon (0x533AA150) of BUILT-RTOS starts with a branch, OFFICIAL-RTOS with
    `cmp r1,#1`, and the rest of the function is the same; the start-up zero fill reaches the heap
    (0x55839080, over the unused sbrk arena), so the byte the hook keeps (0x55839040) starts at 0.
 2. Without a usable report (holder not built, no service, no buffer, a report that does not say
    "battery", a charge over 100), for every r1 0..2, r2 0..5, r3 0..3: the official icon, or
    with --diag and r1 = 1 the "?" icon.
 3. With a report in either buffer (index 0, 1, 0x8000, 0x8001), for every charge 0..101, step
    0..5 and power source, from no shown step: the icon the rules give (a plain model in this
    file); the official icon on external power.
 4. Hysteresis: long sessions (a slow fall with noise, a rise after charging, the CSV), the
    shown step kept between calls: every call gives the model's icon.
 5. Every call keeps r1-r11 and SP; it writes only to the stack below SP and to 0x55839014, and
    reads only the code, the stack, the holder's guard and object, the service's index and buffer
    words, the report's bytes 0 and 3, and 0x55839014.
"""
import csv
import random
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_READ, UC_HOOK_MEM_UNMAPPED
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4,
                               UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9,
                               UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_SP, UC_ARM_REG_LR)

BASE = 0x53000000
GET_BATTERY_ICON = 0x533aa150
FUNCTION_END = 0x533aa234
ASSERT = 0x53916230
ZERO_FILL_END = 0x53000460
HOLDER_GUARD = 0x5537efc4
HOLDER = 0x5537eea0
SHOWN = 0x55839040
ICON_10 = 1100   # 1.11: 1009
UNKNOWN, DISAGREES = ICON_10 + 10, ICON_10 + 11
MARGIN = 4

STOP = 0x1000
RAM = 0x55000000
SVC = 0x60000000
BUFFERS = (0x60001000, 0x60002000)
STACK_TOP = 0x7f100000

REGS = [UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
        UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]

failures = 0


def check(ok, what):
    global failures
    if not ok:
        failures += 1
        if failures <= 30:
            print('FAIL', what)


class Camera:
    """One RTOS image in Unicorn, with RAM, a service object and its two report buffers."""

    def __init__(self, rtos):
        self.rtos = rtos
        self.uc = uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(rtos) + 0xfff) & ~0xfff
        uc.mem_map(BASE, size)
        uc.mem_write(BASE, rtos)
        uc.mem_map(STOP, 0x1000)
        uc.mem_map(RAM, 0x01000000)
        uc.mem_map(SVC, 0x3000)
        uc.mem_map(STACK_TOP - 0x10000, 0x10000)
        # The camera's assert logs and returns.
        uc.mem_write(ASSERT, struct.pack('<I', 0xe12fff1e))
        self.writes, self.reads = [], []
        uc.hook_add(UC_HOOK_MEM_WRITE, lambda u, a, addr, size, v, d: self.writes.append((addr, size)))
        uc.hook_add(UC_HOOK_MEM_READ, lambda u, a, addr, size, v, d: self.reads.append((addr, size)))

    def report(self, state):
        """state: None (holder not built) or a dict: service, index, buffer, source, percent."""
        uc = self.uc
        uc.mem_write(HOLDER_GUARD, struct.pack('<I', 0 if state is None else 1))
        uc.mem_write(HOLDER, bytes(8))
        if state is None:
            return
        uc.mem_write(HOLDER + 4, struct.pack('<I', SVC if state.get('service', True) else 0))
        uc.mem_write(SVC, bytes(0x100))
        uc.mem_write(SVC + 0xac, struct.pack('<I', state.get('index', 0)))
        index = state.get('index', 0)
        readable = ((index - 1) & 1) if index & 0x8000 else index & 1
        buffers = list(BUFFERS)
        if not state.get('buffer', True):
            buffers[readable] = 0
        uc.mem_write(SVC + 0x5c, struct.pack('<II', *buffers))
        for k, b in enumerate(BUFFERS):
            uc.mem_write(b, bytes(20))
            if k == readable:
                # 16-byte report at buffer + 4: byte 0 source (+ flags), 1 voltage, 2 step, 3 charge.
                uc.mem_write(b + 4, bytes([0x10 | state.get('source', 1), 40, state.get('step', 4), state.get('percent', 50)]))
            else:
                uc.mem_write(b + 4, bytes([0x11, 40, 4, 77]))  # the other buffer: a different charge

    def shown(self):
        return self.uc.mem_read(SHOWN, 1)[0]

    def set_shown(self, v):
        self.uc.mem_write(SHOWN, bytes([v]))

    def call(self, r1, r2, r3):
        uc = self.uc
        values = [r1, r2, r3, 0x44444444, 0x55555555, 0x66666666, 0x77777777, 0x88888888, 0x99999999, 0xaaaaaaaa, 0xbbbbbbbb]
        for reg, v in zip(REGS, values):
            uc.reg_write(reg, v)
        uc.reg_write(UC_ARM_REG_R0, 0x12345678)
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP - 0x100)
        uc.reg_write(UC_ARM_REG_LR, STOP)
        self.writes.clear()
        self.reads.clear()
        uc.emu_start(GET_BATTERY_ICON, STOP, count=2000)
        after = [uc.reg_read(r) for r in REGS[3:]]
        kept = after == values[3:] and uc.reg_read(UC_ARM_REG_SP) == STACK_TOP - 0x100
        return uc.reg_read(UC_ARM_REG_R0), kept


def implied_step(p):
    return 4 if p >= 50 else 3 if p >= 20 else 2 if p >= 5 else 1


def model(r1, r2, report, shown, official, diag):
    """The icon and the new shown byte, from the rules in battery.ts."""
    if r1 != 1:
        return official, shown
    if report is None or not report.get('service', True) or not report.get('buffer', True) or report.get('source', 1) != 1 or report['percent'] > 100:
        return (UNKNOWN if diag else official), shown
    p = report['percent']
    if r2 > 4 or abs(implied_step(p) - max(r2, 1)) > 1:
        return (DISAGREES if diag else official), shown
    if shown == 0 or p < 5:
        b = (p + 5) // 10
    else:
        b = shown - 1
        if p >= b * 10 + 5 + MARGIN or p + 5 + MARGIN <= b * 10:
            b = (p + 5) // 10
    return (official if b == 0 else ICON_10 + b - 1), b + 1


def side_effects(cam, what):
    sp = STACK_TOP - 0x100
    for addr, size in cam.writes:
        check(sp - 0x100 <= addr < sp or (addr == SHOWN and size == 1), f'{what}: write at {addr:#x}')
    allowed = [(BASE, BASE + len(cam.rtos)), (sp - 0x100, sp), (HOLDER_GUARD, HOLDER_GUARD + 4), (HOLDER + 4, HOLDER + 8),
               (SVC + 0xac, SVC + 0xb0), (SVC + 0x5c, SVC + 0x64), (SHOWN, SHOWN + 1)]
    for b in BUFFERS:
        allowed += [(b + 4, b + 5), (b + 7, b + 8)]
    for addr, size in cam.reads:
        check(any(lo <= addr and addr + size <= hi for lo, hi in allowed), f'{what}: read at {addr:#x} ({size})')


def main():
    args = sys.argv[1:]
    diag = '--diag' in args
    sequence = None
    if '--sequence' in args:
        sequence = args[args.index('--sequence') + 1]
    files = [a for a in args if not a.startswith('--') and a != sequence]
    built, official = (open(f, 'rb').read() for f in files[:2])
    word = lambda img, a: struct.unpack_from('<I', img, a - BASE)[0]

    # 1. Static
    check(word(official, GET_BATTERY_ICON) == 0xe3510001, 'official GetBatteryIcon starts with cmp r1,#1')
    check((word(built, GET_BATTERY_ICON) & 0xff000000) == 0xea000000, 'built GetBatteryIcon starts with a branch')
    for a in range(GET_BATTERY_ICON + 4, FUNCTION_END, 4):
        check(word(built, a) == word(official, a), f'GetBatteryIcon word {a:#x} unchanged')
    check(word(built, ZERO_FILL_END) == 0x55839080, 'the start-up zero fill reaches the heap')
    print('1. static: done')

    cam, ref = Camera(built), Camera(official)
    officials = {}
    for r1 in range(3):
        for r2 in range(6):
            for r3 in range(4):
                ref.report(None)
                officials[r1, r2, r3] = ref.call(r1, r2, r3)[0]
    check(officials[1, 4, 0] == 0x105 and officials[1, 2, 0] == 0x107 and officials[0, 0, 1] == 0x102, 'official icons as expected')   # 1.11: 0xF5, 0xF7, 0xF2

    # 2. No usable report
    cases = [None, {'service': False, 'percent': 50}, {'buffer': False, 'percent': 50}, {'source': 0, 'percent': 50},
             {'source': 2, 'percent': 50}, {'percent': 101}, {'percent': 255}]
    n = 0
    for state in cases:
        for r1 in range(3):
            for r2 in range(6):
                for r3 in range(4):
                    cam.report(state)
                    cam.set_shown(0)
                    got, kept = cam.call(r1, r2, r3)
                    want, _ = model(r1, r2, state if state is None or 'percent' in state else None, 0, officials[r1, r2, r3], diag)
                    check(got == want and kept, f'no report {state} r1={r1} r2={r2} r3={r3}: {got} want {want} kept {kept}')
                    check(cam.shown() == 0, f'no report {state}: the shown byte stays 0')
                    side_effects(cam, f'no report {state}')
                    n += 1
    print(f'2. no usable report: {n} calls')

    # 3. Every charge, step, buffer index, from nothing shown
    n = 0
    for index in (0, 1, 0x8000, 0x8001):
        for p in range(0, 102):
            for r2 in range(6):
                for r1, r3 in ((1, 0), (0, 1), (2, 2)):
                    state = {'index': index, 'percent': p, 'step': r2}
                    cam.report(state)
                    cam.set_shown(0)
                    got, kept = cam.call(r1, r2, r3)
                    want, shown = model(r1, r2, state, 0, officials[r1, r2, r3], diag)
                    check(got == want and kept, f'index {index:#x} p={p} r1={r1} r2={r2}: {got} want {want} kept {kept}')
                    check(cam.shown() == shown, f'index {index:#x} p={p} r2={r2}: shown {cam.shown()} want {shown}')
                    side_effects(cam, f'p={p} r2={r2}')
                    n += 1
    print(f'3. every charge and step: {n} calls')

    # 4. Sessions
    def step_of(p, prev):
        # The camera's step, with its own hysteresis (photos: step 4 seen from 51, step 3 up to 59).
        edges = [(50, 59, 4), (20, 30, 3), (5, 14, 2)]
        for lo, hi, s in edges:
            if p >= hi or (p >= lo and prev >= s):
                return s
        return 1 if p >= 2 else 0

    sessions = []
    rnd = random.Random(11)
    for _ in range(40):
        level, prev, calls = rnd.uniform(60, 100), 4, []
        for _ in range(400):
            level = max(0.0, level - rnd.uniform(0, 0.3))
            p = max(0, min(100, round(level + rnd.uniform(-4, 4))))
            prev = step_of(p, prev)
            calls.append((p, prev))
        for _ in range(50):  # charged
            p = min(100, round(95 + rnd.uniform(-4, 4)))
            calls.append((p, 4))
        sessions.append(calls)
    if sequence:
        rows = list(csv.DictReader(open(sequence)))
        sessions.append([(int(r['percent']), int(r['step'])) for r in rows])
    n = changes = 0
    for calls in sessions:
        cam.set_shown(0)
        shown = 0
        last = None
        for p, r2 in calls:
            state = {'percent': p, 'step': r2, 'index': rnd.choice((0, 1, 0x8000, 0x8001))}
            cam.report(state)
            got, kept = cam.call(1, r2, 0)
            want, shown = model(1, r2, state, shown, officials[1, r2, 0], diag)
            check(got == want and kept and cam.shown() == shown, f'session p={p} r2={r2}: {got} want {want}, shown {cam.shown()} want {shown}')
            side_effects(cam, 'session')
            if last is not None and got != last:
                changes += 1
            last = got
            n += 1
    print(f'4. sessions: {len(sessions)}, {n} calls, the icon changed {changes} times')

    print('5. registers, stack, reads and writes: checked on every call above')
    if failures:
        print(f'{failures} FAILED')
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
