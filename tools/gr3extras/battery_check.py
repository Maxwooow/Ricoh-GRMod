# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the GR III / IIIx battery percentage (core/src/fw/gr3x/battery.ts).

    python3 tools/gr3extras/battery_check.py RELEASE OFFICIAL.rtos BUILT.rtos [--diag] [--without PLAIN.rtos]
                                             [--iconbin BUILT.iconbin] [--sheet SHEET.png]

RELEASE is 2.10, 2.20 or 2.21 (GR IIIx 1.60 / 1.70 / 1.71 are the same programs); BUILT a build with
`batteryPercent` (--diag: with `batteryDiag`); PLAIN the same build without it. Development tool, not
part of the program; needs unicorn.

The camera's own code runs in Unicorn, in the official image and in the built one: the two callers
of GetBatteryIcon (the shooting screen's call site in UpdateViewBattery, run from its loads to the
instruction after the call, and the playback function, with the power object's three getters
replaced by stubs), and GetBatteryIcon itself. CpuInformationService's holder, service and double
buffer are built in RAM at the camera's addresses, with a synthetic 16-byte report. Checks:
 1. static: GetBatteryIcon's first word is a branch, the rest of it unchanged; the start-up zero
    fill reaches round 10's end, so the shown byte starts at 0; with --without: inside the official
    image the build differs from PLAIN in that one word only;
 2. no usable report (holder not built, no service, no buffer, source not "battery", charge over
    100), every on-battery / step / external-power input: the official icon (diagnostic: "?" on
    battery); the shown byte stays 0;
 3. every charge 0..101 x step 0..5 x buffer index 0 / 1 / 0x8000 / 0x8001 x {on battery, external
    power 1 / 2}, from nothing shown: the icon of the rule in battery.ts (a plain model here);
    on external power and off battery the official icon;
 4. the sub-CPU's own pairs: for every Remain 0..1000 (0.1 %) and every previous step, the step and
    byte 3 GR III's sub-CPU makes (its code at 0xFFFE77A2, modelled here) are never "disagreeing";
 5. sessions (slow discharge with load noise, charging): the shown step is kept between calls by
    the hysteresis, every call gives the model's icon;
 6. every call keeps r4-r11 and SP as the official code does, writes only below SP and the shown
    byte, and reads only the image, the stack, the guard, holder + 4, the service's index and
    buffer words, and the report's bytes 0 and 3.
With --iconbin: the twelve icons the hook names are 60 x 40 and inside ICONBIN (--sheet: drawn
next to the camera's bars).
"""
import random, re, struct, sys
from pathlib import Path
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_READ
from unicorn.arm_const import *

REPO = Path(__file__).resolve().parents[2]
args = sys.argv[1:]
flag = lambda k: (args.pop(args.index(k) + 1), args.remove(k))[0] if k in args else None
diag = '--diag' in args
if diag: args.remove('--diag')
without, iconbin, sheet = flag('--without'), flag('--iconbin'), flag('--sheet')
rel, official, built = args[:3]
BASE = 0x53000000
TABLE = {'2.10': None, '2.20': 'core/src/fw/gr3x170/addresses.ts', '2.21': 'core/src/fw/gr3x171/addresses.ts'}[rel]
table = dict((int(a, 16), int(b, 16)) for a, b in re.findall(r'\[(0x[0-9a-f]{8}), (0x[0-9a-f]{8})\]', (REPO / TABLE).read_text())) if TABLE else None
adr = (lambda a: table[a]) if table else (lambda a: a)
RAMSRC, RAMLEN = {'2.10': (0x5407b540, 0x3a080), '2.20': (0x5407b640, 0x3a0c0), '2.21': (0x54084640, 0x3a300)}[rel]
RAM = 0x55000000
ICON = adr(0x532abce0); GUARD = adr(0x55349090); HOLDER = adr(0x55348f6c); SHOWN = adr(0x558043a4)
FILL_LITERAL, FILL_END = adr(0x53000460), adr(0x558043c0)
MARGIN = 4

off = open(official, 'rb').read(); img = open(built, 'rb').read()
w = lambda image, va: struct.unpack_from('<I', image, va - BASE)[0]
def btarget(image, at):
    x = w(image, at); imm = x & 0xffffff
    return at + 8 + 4 * (imm - (1 << 24) if imm & 0x800000 else imm)

failures = 0
def check(ok, what):
    global failures
    if not ok:
        failures += 1
        if failures <= 30: print('FAIL', what)

# --- the camera's code around GetBatteryIcon, found in the official image ---------------------------
assert w(off, ICON) == 0xe3510001 and w(off, ICON + 4) == 0xe1a0c00d, 'GetBatteryIcon'
END = ICON + 0xe4  # the playback function follows GetBatteryIcon
assert w(off, END) == 0xe1a0c00d and w(off, END + 0x50) >> 24 == 0xea and btarget(off, END + 0x50) == ICON, 'playback caller'
ASSERT = btarget(off, ICON + 0x84)
assert btarget(off, ICON + 0xd8) == ASSERT
calls = [BASE + i for i in range(0, 0x400000, 4) if off[i + 3] == 0xeb and btarget(off, BASE + i) == ICON]
assert len(calls) == 1, calls
SHOOT = calls[0] - 0x10  # ldr r3,[r4,#0x4e8]; mov r2,r6; mov r1,r7; ldrb r3,[r3,#0x26c]; bl GetBatteryIcon
assert w(off, SHOOT) == 0xe59434e8 and w(off, SHOOT + 12) == 0xe5d3326c, 'shooting screen call site'
PB_GET = btarget(off, END + 0x10)
PB_FNS = [btarget(off, END + k) for k in (0x1c, 0x28, 0x34)]  # on battery, step, external power
assert w(off, END + 0x14) == 0xe5904000  # ldr r4,[r0]

# --- 1. static ----------------------------------------------------------------------------------
check(w(img, ICON) >> 24 == 0xea and btarget(img, ICON) >= BASE + len(off), 'built GetBatteryIcon starts with a branch to appended code')
for a in range(ICON + 4, END + 0x54, 4):
    check(w(img, a) == w(off, a), f'GetBatteryIcon / playback word {a:#x} unchanged')
check(w(img, FILL_LITERAL) == FILL_END, 'the start-up zero fill reaches round 10\'s end (the shown byte starts at 0)')
check(FILL_END - 0x4c <= SHOWN < FILL_END, 'the shown byte is in round 10\'s zero-filled words')
HOOK = btarget(img, ICON)
if without:
    plain = open(without, 'rb').read()
    def moved(i):
        x, y = struct.unpack_from('<I', plain, i)[0], struct.unpack_from('<I', img, i)[0]
        return x >> 24 == y >> 24 and (x >> 25) & 7 == 5 and min(btarget(plain, BASE + i), btarget(img, BASE + i)) >= BASE + len(off)
    def isicon(i):  # the icon directory's address and bounds (movw / movt of a new directory or count)
        x, y = struct.unpack_from('<I', plain, i)[0], struct.unpack_from('<I', img, i)[0]
        return (x & 0xfff0f000) == (y & 0xfff0f000) and (x & 0x0ff00000) in (0x03000000, 0x03400000)
    only = [BASE + i for i in range(0, len(off), 4) if plain[i:i + 4] != img[i:i + 4] and not moved(i)]
    icon_words = [a for a in only if isicon(a - BASE)]
    check(sorted(set(only) - set(icon_words)) == [ICON], f'build vs plain inside the official image: {[hex(x) for x in only]}')
    check(len(icon_words) <= 9, f'icon directory words: {[hex(x) for x in icon_words]}')
    print(f'1. static: against the plain build only GetBatteryIcon\'s first word and {len(icon_words)} icon directory / bound words differ')
else:
    print('1. static: done')

# --- the emulator ---------------------------------------------------------------------------------
STOP, SVC, BUFFERS, OBJ, STACK_TOP = 0x1000, 0x60000000, (0x60001000, 0x60002000), 0x61000000, 0x7f100000
SP0 = STACK_TOP - 0x100

class Camera:
    def __init__(self, image):
        self.image = image
        self.uc = uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        uc.mem_map(BASE, (len(image) + 0xfff) & ~0xfff); uc.mem_write(BASE, image)
        uc.mem_map(RAM, 0x01000000); uc.mem_write(RAM, image[RAMSRC - BASE:RAMSRC - BASE + RAMLEN])
        for a, n in ((STOP, 0x1000), (SVC, 0x3000), (OBJ, 0x2000), (STACK_TOP - 0x10000, 0x10000)): uc.mem_map(a, n)
        uc.mem_write(ASSERT, struct.pack('<I', 0xe12fff1e))  # the assert logs and returns
        self.writes, self.reads, self.log, self.stubs = [], [], False, False
        uc.hook_add(UC_HOOK_MEM_WRITE, lambda u, a, addr, size, v, d: self.log and self.writes.append((addr, size)))
        uc.hook_add(UC_HOOK_MEM_READ, lambda u, a, addr, size, v, d: self.log and self.reads.append((addr, size)))
        uc.mem_write(SHOWN, b'\0')

    def report(self, s):
        uc = self.uc
        uc.mem_write(GUARD, struct.pack('<I', 0 if s is None else 1)); uc.mem_write(HOLDER, bytes(8))
        if s is None: return
        uc.mem_write(HOLDER + 4, struct.pack('<I', SVC if s.get('service', True) else 0))
        uc.mem_write(SVC, bytes(0x100))
        index = s.get('index', 0)
        uc.mem_write(SVC + 0xac, struct.pack('<I', index))
        readable = ((index - 1) & 1) if index & 0x8000 else index & 1
        bufs = list(BUFFERS)
        if not s.get('buffer', True): bufs[readable] = 0
        uc.mem_write(SVC + 0x5c, struct.pack('<II', *bufs))
        for k, b in enumerate(BUFFERS):
            uc.mem_write(b, bytes(20))
            # report at buffer + 4: byte 0 source | flags << 4, 1 voltage x10, 2 step, 3 charge
            uc.mem_write(b + 4, bytes([0x10 | s.get('source', 1), 38, s.get('step', 4), s.get('percent', 50)]) if k == readable else bytes([0x11, 41, 4, 77]))

    shown = lambda self: self.uc.mem_read(SHOWN, 1)[0]
    def set_shown(self, v): self.uc.mem_write(SHOWN, bytes([v]))

    def run(self, start, until, regs):
        uc = self.uc
        names = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
                 UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]
        for r, v in zip(names, regs): uc.reg_write(r, v)
        uc.reg_write(UC_ARM_REG_SP, SP0); uc.reg_write(UC_ARM_REG_LR, STOP)
        self.writes.clear(); self.reads.clear(); self.log = True
        uc.emu_start(start, until, count=3000)
        self.log = False
        return [uc.reg_read(r) for r in names] + [uc.reg_read(UC_ARM_REG_SP)]

    def icon(self, way, r1, r2, r3):
        """way 0: GetBatteryIcon; 1: the shooting screen's call site; 2: the playback function.
        Returns (icon, registers r4-r11 and SP after)."""
        filler = [0x12345678, 0, 0, 0, 0x44444444, 0x55555555, 0x66666666, 0x77777777, 0x88888888, 0x99999999, 0xaaaaaaaa, 0xbbbbbbbb]
        if way == 0:
            out = self.run(ICON, STOP, filler[:1] + [r1, r2, r3] + filler[4:])
        elif way == 1:
            self.uc.mem_write(OBJ + 0x4e8, struct.pack('<I', OBJ + 0x1000)); self.uc.mem_write(OBJ + 0x1000 + 0x26c, bytes([r3]))
            regs = filler[:]; regs[4], regs[6], regs[7] = OBJ, r2, r1
            out = self.run(SHOOT, SHOOT + 0x14, regs)
        else:
            # The stubs are written once (Unicorn keeps translated code); they load the values from OBJ + 0x1c00.
            if not self.stubs:
                mov = lambda v: 0xe3000000 | ((v & 0xf000) << 4) | (v & 0xfff)  # movw r0,#v
                self.uc.mem_write(OBJ + 0x1800, struct.pack('<I', OBJ + 0x1900))
                self.uc.mem_write(PB_GET, struct.pack('<III', mov(0x1800), 0xe3460100, 0xe12fff1e))  # movw r0,#0x1800; movt r0,#0x6100
                for k, f in enumerate(PB_FNS): self.uc.mem_write(f, struct.pack('<IIII', mov(0x1c00 + 4 * k), 0xe3460100, 0xe5900000, 0xe12fff1e))  # ldr r0,[r0]
                self.stubs = True
            self.uc.mem_write(OBJ + 0x1c00, struct.pack('<III', r1, r2, r3))
            out = self.run(END, STOP, [0xcafe] + filler[1:])
        return out[0], out[4:]

def implied(p): return 4 if p >= 50 else 3 if p >= 20 else 2 if p >= 5 else 1
def model(r1, r2, s, shown, official):
    if r1 != 1: return official, shown
    if s is None or not s.get('service', True) or not s.get('buffer', True) or s.get('source', 1) != 1 or s['percent'] > 100:
        return ('unknown' if diag else official), shown
    p = s['percent']
    if r2 > 4 or abs(implied(p) - max(r2, 1)) > 1: return ('disagrees' if diag else official), shown
    if shown == 0 or p < 5: b = (p + 5) // 10
    else:
        b = shown - 1
        if p >= b * 10 + 5 + MARGIN or p + 5 + MARGIN <= b * 10: b = (p + 5) // 10
    return (official if b == 0 else ('pct', b)), b + 1

cam, ref = Camera(img), Camera(off)
official_icons, official_regs = {}, {}
for way in range(3):
    for r1 in range(3):
        for r2 in range(6):
            for r3 in range(4):
                ref.report(None)
                official_icons[way, r1, r2, r3], official_regs[way, r1, r2, r3] = ref.icon(way, r1, r2, r3)
o = official_icons
check(o[0, 1, 4, 0] == 0x106 and o[0, 1, 0, 0] == 0x105 and o[0, 1, 2, 0] == 0x108 and o[0, 0, 0, 1] == 0x103 and o[0, 0, 0, 0] == 0x26c,
      'official icons: bars 0x105..0x108, external power 0x103 / 0x26c')
check(all(o[0, k[1], k[2], k[3]] == v for k, v in o.items()), 'both callers give GetBatteryIcon\'s icon')

# the icon numbers of the build: what the hook gives for 10 %, "?" and "!" (checked against the model below)
cam.report({'percent': 10, 'step': 2}); cam.set_shown(0); FIRST = cam.icon(0, 1, 2, 0)[0]
cam.set_shown(0); cam.report({'percent': 100, 'step': 4}); LAST = cam.icon(0, 1, 4, 0)[0]
check(LAST == FIRST + 9 and FIRST > 0x26c, f'10 % is icon {FIRST}, 100 % icon {LAST}')
UNKNOWN, DISAGREES = FIRST + 10, FIRST + 11
def resolve(v): return UNKNOWN if v == 'unknown' else DISAGREES if v == 'disagrees' else FIRST + v[1] - 1 if isinstance(v, tuple) else v

sp = SP0
allowed = [(BASE, BASE + len(img)), (sp - 0x100, sp + 0x40), (GUARD, GUARD + 4), (HOLDER + 4, HOLDER + 8), (SVC + 0xac, SVC + 0xb0),
           (SVC + 0x5c, SVC + 0x64), (SHOWN, SHOWN + 1), (OBJ, OBJ + 0x2000)] + [(b + 4, b + 5) for b in BUFFERS] + [(b + 7, b + 8) for b in BUFFERS]
def side_effects(way, r1, r2, r3, after, what):
    check(after == official_regs[way, r1, r2, r3], f'{what}: r4-r11 / SP {[hex(x) for x in after]} not as in the official run')
    for a, n in cam.writes: check(sp - 0x100 <= a < sp or (a == SHOWN and n == 1), f'{what}: write at {a:#x}')
    for a, n in cam.reads: check(any(lo <= a and a + n <= hi for lo, hi in allowed), f'{what}: read at {a:#x} ({n})')

# --- 2. no usable report --------------------------------------------------------------------------
n = 0
for s in [None, {'service': False, 'percent': 50}, {'buffer': False, 'percent': 50}, {'source': 0, 'percent': 50}, {'source': 4, 'percent': 50},
          {'source': 5, 'percent': 50}, {'percent': 101}, {'percent': 255}]:
    for way in range(3):
        for r1 in range(3):
            for r2 in range(6):
                for r3 in range(4):
                    cam.report(s); cam.set_shown(0)
                    got, after = cam.icon(way, r1, r2, r3)
                    want = resolve(model(r1, r2, s, 0, o[way, r1, r2, r3])[0])
                    check(got == want, f'no report {s} way {way} r1={r1} r2={r2} r3={r3}: {got:#x} want {want:#x}')
                    check(cam.shown() == 0, f'no report {s}: shown byte changed')
                    side_effects(way, r1, r2, r3, after, f'no report {s}'); n += 1
print(f'2. no usable report: {n} calls')

# --- 3. every charge x step x buffer x power ------------------------------------------------------
n = 0; seen = set()
for index in (0, 1, 0x8000, 0x8001):
    for p in range(102):
        for r2 in range(6):
            for r1, r3 in ((1, 0), (0, 1), (0, 2), (2, 2)):
                way = (p + r2 + index) % 3
                s = {'index': index, 'percent': p, 'step': r2}
                cam.report(s); cam.set_shown(0)
                got, after = cam.icon(way, r1, r2, r3)
                want, shown = model(r1, r2, s, 0, o[way, r1, r2, r3])
                check(got == resolve(want) and cam.shown() == shown, f'index {index:#x} p={p} r1={r1} r2={r2} way {way}: {got} want {resolve(want)}, shown {cam.shown()} want {shown}')
                side_effects(way, r1, r2, r3, after, f'p={p} r2={r2}'); n += 1; seen.add(got)
print(f'3. every charge 0..101, step 0..5, both buffers, on battery / external power: {n} calls, icons {sorted(hex(x) for x in seen)}')

# --- 4. the sub-CPU's pairs (GR III RX code 0xFFFE77A2..0xFFFE7832) -------------------------------------
def subcpu_step(remain, prev):
    r = remain
    if r > 600: return 4
    if r >= 551: return prev if prev == 3 else 4
    if r >= 501: return prev if prev == 4 else 3
    if r > 300: return 3
    if r >= 251: return prev if prev == 2 else 3
    if r >= 201: return prev if prev == 3 else 2
    if r > 150: return 2
    if r >= 101: return prev if prev == 1 else 2
    if r >= 51: return prev if prev == 2 else 1
    if r != 0: return prev if prev == 0 else 1
    return 0
n = bad = 0
for remain in range(1001):
    for prev in (0, 1, 2, 3, 4, 255):
        step, p = subcpu_step(remain, prev), (remain + 5) // 10
        s = {'percent': p, 'step': step}
        cam.report(s); cam.set_shown(0)
        got, after = cam.icon(0, 1, step, 0)
        want, _ = model(1, step, s, 0, o[0, 1, step, 0])
        check(got == resolve(want), f'sub-CPU pair remain {remain} step {step}: {got} want {resolve(want)}')
        bad += want == 'disagrees' or (not diag and abs(implied(p) - max(step, 1)) > 1); n += 1
check(bad == 0, f'{bad} of the sub-CPU\'s own pairs disagree')
print(f'4. the sub-CPU\'s (charge, step) pairs for Remain 0..1000 and every previous step: {n}, none disagrees')

# --- 5. sessions ----------------------------------------------------------------------------------
rnd = random.Random(3); n = changes = 0
for k in range(30):
    remain, prev, shown, last = rnd.uniform(700, 1000), 255, 0, None
    cam.set_shown(0)
    for t in range(450):
        remain = max(0.0, remain - rnd.uniform(0, 3)) if t < 400 else min(1000.0, remain + 15)
        r = max(0, min(1000, round(remain + rnd.uniform(-40, 40))))  # load: the voltage jumps
        prev = subcpu_step(r, prev)
        s = {'percent': (r + 5) // 10, 'step': prev, 'index': rnd.choice((0, 1, 0x8000, 0x8001))}
        cam.report(s)
        way = rnd.randrange(3)
        got, after = cam.icon(way, 1, prev, 0)
        want, shown = model(1, prev, s, shown, o[way, 1, prev, 0])
        check(got == resolve(want) and cam.shown() == shown, f'session {k} t={t} p={s["percent"]} step {prev}: {got} want {resolve(want)}')
        side_effects(way, 1, prev, 0, after, 'session')
        changes += last is not None and got != last; last = got; n += 1
print(f'5. sessions: 30, {n} calls, the icon changed {changes} times')
print('6. registers, stack, reads and writes: checked on every call above')

if iconbin:
    icons = open(iconbin, 'rb').read()
    root = None
    src = (REPO / 'core/src/fw/gr3x/adj.ts').read_text()
    low = adr(int(re.search(r'iconRootSites: \[\[adr\((0x[0-9a-f]{8})\)', src).group(1), 16))
    a, b = w(img, low), w(img, low + 4)
    root = ((((b >> 4) & 0xf000) | (b & 0xfff)) << 16) | ((a >> 4) & 0xf000) | (a & 0xfff)
    def o_(va): return va - RAM + RAMSRC - BASE if RAM <= va < RAM + RAMLEN else va - BASE
    def icon(image, rt, i):
        wd, ht, at = struct.unpack_from('<HHI', image, o_(struct.unpack_from('<I', image, o_(rt + 4 * i))[0]))
        return wd, ht, at
    pxs = []
    for i in range(FIRST, FIRST + 12):
        wd, ht, at = icon(img, root, i)
        check((wd, ht) == (60, 40) and at * 4 + 9600 <= len(icons), f'icon {i}: {wd}x{ht} at {at * 4:#x}')
        pxs.append(icons[at * 4: at * 4 + 9600])
    check(len(set(pxs)) == 12, 'twelve different icons')
    cams = []
    for i in (0x106, 0x107, 0x108, 0x105):
        wd, ht, at = icon(img, root, i); cams.append(icons[at * 4: at * 4 + 9600])
    print(f'icons: {FIRST}..{FIRST + 11} are 60 x 40 inside ICONBIN')
    if sheet:
        from PIL import Image
        im = Image.new('RGB', (8 * 130 + 10, 2 * 90 + 10), (90, 120, 90))
        for k, px in enumerate(cams + pxs):
            t = Image.frombytes('RGBA', (60, 40), px).resize((120, 80), Image.NEAREST)
            im.paste(t, (10 + (k % 8) * 130, 10 + (k // 8) * 90), t)
        im.save(sheet)

if failures:
    print(f'{failures} FAILED'); sys.exit(1)
print(rel, 'diagnostic' if diag else '', 'all checks passed')
