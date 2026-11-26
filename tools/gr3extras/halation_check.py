# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the GR III / IIIx halation switch (core/src/fw/gr3x/halation-switch.ts).

    python3 tools/gr3extras/halation_check.py RELEASE OFFICIAL.rtos ON.rtos OFF.rtos ABSENT.rtos [--mono K] [--films N] [--peak]

RELEASE is 2.10, 2.20 or 2.21 (GR IIIx 1.60 / 1.70 / 1.71 are the same programs). ON, OFF and ABSENT are
the same build (round 10, the same films) with `halationSwitch` true, false and not given; film K (default 2)
has a grey preset. Development tool, not part of the program. Runs the built images' own code in Unicorn:

 1. The JPEG step (ON and ABSENT): from JpegEncodeMacroProcess::Execute's entry through the built chain
    (the halation stub, the module, back to Execute + 4) on synthetic YCbCr 4:2:2 pictures (night lamps,
    a grey ramp, coloured highlights; several sizes), for red and white at Weak / Medium / Strong of a
    film; the planes after it are compared byte for byte with GR Mod's reference (halateYcc,
    tools/gr3extras/halation_ref.mts, on the film's light tables as the image holds them): ON with
    GR Mod 0.9's white (scatter / lower glow), ABSENT with the 0.8.2 glow. The registers at Execute + 4
    are those the official first instruction leaves (r0..r3, lr as on entry, ip = sp, r4..r11, sp);
    the heap blocks are all given back; on a small picture every write lands in the planes, the
    module's blocks or the stack. Nothing changes for an invalid stash, level off, a factory look, a
    look past the films. The module and the scatter's parameters are GR IV's (bytes of
    core/src/fw/aspect/halation-code.ts; 'HSC1'), ABSENT's the 0.8.2 module (halation-code-089.ts).
    With --peak: the heap each colour / level takes on a 6000 x 4000 picture (run until its first
    cache call, when every block is taken).
 2. OFF: Execute's code is the official one (no halation module, no 'HAL4' context anywhere); the
    words of the official image the build changes are ABSENT's less the JPEG entry and the Halation
    and Colour rows' hooks; ON changes the same words as ABSENT.
 3. The development step's adapter (0x536db7f8, ldrb r2,[r3,#0x77c]) in each build, for looks 0..30,
    60..90, 255 and Toning states 0..11: the stash word (look, level, valid, white: GR IV's states;
    ON: a black-and-white film's level is white), r2 the look as the camera sees it, every other
    register and the flags as on entry.
 4. The parameter screen's rows (official, ABSENT, ON, OFF): GetBaseKindDetailControl (0x531aca98, its
    asserts recorded) for those looks, photo sets 0..3, stills and movies; then, for sets 0..2, the rows
    the screen shows (line count 0x531afab8, line valid 0x531afa10, line kind 0x531b01d0 by focus):
    a film has Standard's rows plus Halation (kind 15) and Colour (kind 10) in stills with the switch
    on or absent, Standard's rows only (and no assert) with it off; every other look as official.
"""
import base64, json, os, re, struct, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import *

REPO = Path(__file__).resolve().parents[2]
BASE = 0x53000000
args = sys.argv[1:]
opt = lambda name, default=None: args[args.index(name) + 1] if name in args else default
rel, official, on_path, off_path, absent_path = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--mono', '--films'))][:5]
MONO = int(opt('--mono', 2)); FILMS = int(opt('--films', 3))
TABLE = {'2.10': None, '2.20': 'core/src/fw/gr3x170/addresses.ts', '2.21': 'core/src/fw/gr3x171/addresses.ts'}[rel]
table = dict((int(a, 16), int(b, 16)) for a, b in re.findall(r'\[(0x[0-9a-f]{8}), (0x[0-9a-f]{8})\]', (REPO / TABLE).read_text())) if TABLE else None
adr = (lambda a: table[a]) if table else (lambda a: a)
OFF_IMG = open(official, 'rb').read()
IMG = {'on': open(on_path, 'rb').read(), 'off': open(off_path, 'rb').read(), 'absent': open(absent_path, 'rb').read(), 'official': OFF_IMG}

EXECUTE, DEVELOP = adr(0x535047d4), adr(0x536db7f8)
BASE_DEFAULT, BASE_TARGET = adr(0x531acb24), adr(0x531acbbc)
BASE_FN = BASE_DEFAULT - 0x8c
IS_VALID, LINE_COUNT, KIND = adr(0x531afa20) - 0x10, adr(0x531afabc) - 4, adr(0x531b01f4) - 0x24
# The Halation and Colour rows' hook words (halation-rows.ts, round 10: no backup / restore thunks).
ROW_SITES = [adr(a) for a in (0x531afa20, 0x531afa24, 0x531afabc, 0x531afacc, 0x531affa0, 0x531affa8, 0x531b01f4, 0x531b01f8, 0x531b0254,
                              0x531ae84c, 0x531b0564, 0x531af6ec, 0x531af700, 0x531b0d28,
                              0x531adcbc, 0x531adce0, 0x531adca0, 0x531b0514, 0x531af494, 0x531af4a8, 0x531b0d8c)]
STASH_VALID, STASH_WHITE, FILM_STYLE = 0x10000, 0x20000, 32
# a window of round 10's RAM gap around the stash (the stash at +8: 0x55804378 in 2.10)
GAP = adr(0x55804378) - 8
RAM, RAM_N = 0x55000000, 0x1000000
HEAP, HEAP_END = 0x58000000, 0x5C000000
STACK, STACK_TOP = 0x5E000000, 0x5E0F0000
STOP = 0x5F0F0000
CONFIG, PICTURE, PLANES = 0x5F000000, 0x5F000400, 0x60000000
CTL, REC = 0x5D000000, 0x5D010000
CALLEE = [UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]
R = [globals()['UC_ARM_REG_R%d' % i] for i in range(13)]


class Fail(Exception):
    pass


def check(cond, what):
    if not cond:
        raise Fail(what)


word = lambda img, a: struct.unpack_from('<I', img, a - BASE)[0]


def branch(at, w):
    off = w & 0xFFFFFF
    return at + 8 + 4 * (off - 0x1000000 if off & 0x800000 else off)


movw = lambda w: ((w >> 4) & 0xF000) | (w & 0xFFF)
module_bytes = lambda name, f: base64.b64decode(re.search(r"export const %s = '([^']*)'" % name, (REPO / 'core/src/fw/aspect' / f).read_text()).group(1))
MODULE_09, MODULE_089 = module_bytes('HALATION_CODE', 'halation-code.ts'), module_bytes('HALATION_CODE_089', 'halation-code-089.ts')


def machine(img):
    uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    uc.mem_map(BASE, (len(img) + 0xFFFFF) & ~0xFFFFF)
    uc.mem_write(BASE, img)
    for a, n in ((RAM, RAM_N), (HEAP, HEAP_END - HEAP), (STACK, 0x100000), (CTL, 0x100000), (CONFIG, 0x100000), (PLANES, 0x8000000)):
        uc.mem_map(a, n)
    return uc


# ------------------------------------------------------------------ 1. the JPEG step
class Jpeg:
    def __init__(self, img, scatter):
        self.img = img
        first = word(img, EXECUTE)
        check(first >> 24 == 0xEA, 'JPEG step: no branch at the entry')
        s = branch(EXECUTE, first)
        check(word(img, s) == 0xE92D500F and word(img, s + 4) == 0xE5911008, 'JPEG step: the halation stub is the first of the chain')
        self.stub, self.ctx = s, movw(word(img, s + 8)) | (movw(word(img, s + 12)) << 16)
        check(word(img, s + 16) >> 24 == 0xEB, 'halation stub: call')
        self.module = branch(s + 16, word(img, s + 16))
        check(word(img, s + 20) == 0xE8BD500F, 'halation stub: pop')
        # the end of the chain: the official first word, then Execute + 4
        check(word(img, s + 24) == 0xE1A0C00D and branch(s + 28, word(img, s + 28)) == EXECUTE + 4, 'halation stub: back to Execute')
        w = lambda i: word(img, self.ctx + 4 * i)
        self.fns = [w(i) for i in range(5)]
        self.stash, self.lut, self.looks, self.count, self.scatter = w(5), w(6), w(7), w(8), w(9)
        check(word(img, self.ctx + 56) == 0x344C4148, "context magic 'HAL4'")
        self.map = img[self.ctx + 60 - BASE:self.ctx + 124 - BASE]
        check(self.count == FILMS and [self.map[FILM_STYLE + k] for k in range(FILMS)] == list(range(1, FILMS + 1)) and sum(1 for x in self.map if x) == FILMS, 'look map: the films at 32 + k')
        want = MODULE_09 if scatter else MODULE_089
        check(img[self.module - BASE:self.module - BASE + len(want)] == want, 'module bytes: %s' % ('0.9 (halation-code.ts)' if scatter else '0.8.2 (halation-code-089.ts)'))
        if scatter:
            check(word(img, self.scatter) == 0x31435348, "struct scatter 'HSC1' at context word 9")
            k = struct.unpack_from('<10H', img, self.scatter + 4 - BASE)
            # HALATION.scatter (k 0.08 / 0.15, radii 0.004 / 0.02 / 0.06, weights .5 / .35 / .15) and whiteStrong.gain 25
            check(k == (328, 614, 16, 82, 246, 128, 90, 38, 25, 0), 'struct scatter parameters %r' % (k,))
        else:
            check(self.scatter == 0, 'ABSENT: context word 9 is 0')
        self.uc = machine(img)
        self.uc.hook_add(UC_HOOK_CODE, self._fn, begin=min(self.fns), end=max(self.fns))
        self.stop_at_sync = False

    def _fn(self, uc, at, size, _):
        ret = lambda v=None: (v is not None and uc.reg_write(UC_ARM_REG_R0, v), uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR)))
        cache, inval, clean, alloc, release = self.fns
        if at == cache:
            ret(0x12345678)
        elif at in (inval, clean):
            self.syncs += 1
            if self.stop_at_sync:
                uc.emu_stop()
            ret()
        elif at == alloc:
            n = uc.reg_read(UC_ARM_REG_R0)
            a = self.heap
            self.heap = (a + n + 63) & ~63
            check(self.heap <= HEAP_END, 'heap pool exhausted')
            self.live[a] = n
            self.peak = max(self.peak, sum(self.live.values()))
            ret(a)
        elif at == release:
            p = uc.reg_read(UC_ARM_REG_R0)
            check(p in self.live, 'release of a block not given')
            del self.live[p]
            ret()

    def tables(self, film):
        e = self.map[FILM_STYLE + film]
        t = self.img[self.looks + (e - 1) * 520 + 8 - BASE:][:512]
        s = None
        if self.scatter:
            sp = word(self.img, self.scatter + 36)
            s = self.img[sp + (e - 1) * 512 - BASE:][:512]
        return t, s

    def run(self, Y, C, w, h, stash, watch=False, peak=False):
        uc = self.uc
        uc.mem_write(PLANES, Y.tobytes())
        cplane = PLANES + ((w * h + 0xFFFF) & ~0xFFFF)
        uc.mem_write(cplane, C.tobytes())
        uc.mem_write(PICTURE, struct.pack('<B3xIII4H2H4x', 1, PLANES, cplane, w * h, w, h, w, h, 0, 0))
        uc.mem_write(CONFIG, bytes(0x100))
        uc.mem_write(CONFIG + 0x3C, struct.pack('<I', PICTURE))
        uc.mem_write(CONFIG + 0x800, struct.pack('<III', 0, 0, CONFIG))     # the process: its configuration at +8
        uc.mem_write(self.stash, struct.pack('<I', stash))
        self.heap, self.live, self.syncs, self.peak = HEAP, {}, 0, 0
        regs = [0xA0000000 + i for i in range(13)]
        regs[1] = CONFIG + 0x800
        for i in range(13):
            uc.reg_write(R[i], regs[i])
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP); uc.reg_write(UC_ARM_REG_LR, STOP)
        hooks = []
        if watch:
            writes = []
            planes = ((PLANES, PLANES + w * h), (cplane, cplane + w * h))

            def on_write(uc_, access, addr, size, value, _):
                if any(a <= addr and addr + size <= b for a, b in planes) or STACK <= addr < STACK_TOP:
                    return
                if any(a <= addr and addr + size <= a + n for a, n in self.live.items()):
                    return
                writes.append(addr)
            hooks.append(uc.hook_add(UC_HOOK_MEM_WRITE, on_write))
        self.stop_at_sync = peak
        uc.emu_start(EXECUTE, EXECUTE + 4, count=0)
        for x in hooks:
            uc.hook_del(x)
        if peak:
            return self.peak
        check(uc.reg_read(UC_ARM_REG_PC) == EXECUTE + 4, 'the chain does not end at Execute + 4')
        out = [uc.reg_read(R[i]) for i in range(13)]
        check(out[:4] == regs[:4] and out[4:12] == regs[4:12], 'registers at Execute + 4')
        check(out[12] == STACK_TOP and uc.reg_read(UC_ARM_REG_SP) == STACK_TOP and uc.reg_read(UC_ARM_REG_LR) == STOP, 'ip = sp, sp and lr at Execute + 4')
        check(not self.live, '%d heap blocks not given back' % len(self.live))
        if watch:
            check(not writes, 'writes outside: %s' % [hex(a) for a in writes[:5]])
        y = np.frombuffer(bytes(uc.mem_read(PLANES, w * h)), np.uint8).reshape(h, w)
        c = np.frombuffer(bytes(uc.mem_read(cplane, w * h)), np.uint8).reshape(h, w)
        return y, c


def to_ycc(rgb):
    a = rgb.astype(np.float64)
    Rr, G, B = a[..., 0], a[..., 1], a[..., 2]
    Y = 0.299 * Rr + 0.587 * G + 0.114 * B
    Cb = 128 - 0.168736 * Rr - 0.331264 * G + 0.5 * B
    Cr = 128 + 0.5 * Rr - 0.418688 * G - 0.081312 * B
    C = np.empty_like(Y)
    C[:, 0::2] = (Cb[:, 0::2] + Cb[:, 1::2]) / 2
    C[:, 1::2] = (Cr[:, 0::2] + Cr[:, 1::2]) / 2
    q = lambda v: np.clip(np.rint(v), 0, 255).astype(np.uint8)
    return q(Y), q(C)


def pictures():
    """Synthetic pictures: night lamps, a day scene with a grey ramp and specular highlights."""
    out = []
    for name, w, h in (('night', 640, 426), ('day', 1024, 682), ('odd', 482, 331)):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
        rng = np.random.default_rng(w)
        if name == 'day':
            rgb = np.stack([90 + 60 * (1 - yy / h)] * 3, -1) + np.array([10, 20, 40]) * (1 - yy / h)[..., None]      # sky
            rgb[h // 2:h // 2 + h // 8, :, :] = (np.arange(w) * 255.0 / (w - 1))[None, :, None]       # grey ramp 0..255
            for _ in range(25):
                cx, cy, r = rng.uniform(0, w), rng.uniform(0, h // 2), rng.uniform(1, 6)
                rgb[(xx - cx) ** 2 + (yy - cy) ** 2 < r * r] = 255
        else:
            rgb = np.stack([15 + 40 * yy / h, 18 + 30 * yy / h, 30 + 20 * xx / w], -1)
            lamps = [((255, 255, 255), 9), ((255, 190, 90), 6), ((255, 40, 30), 7), ((60, 120, 255), 5), ((250, 250, 235), 3), ((235, 228, 220), 12)]
            for k in range(14):
                col, r = lamps[k % len(lamps)]
                cx, cy = rng.uniform(0, w), rng.uniform(0, h)
                d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
                m = np.clip(1.2 - d / r, 0, 1)[..., None]
                rgb = rgb * (1 - m) + np.array(col) * m
            rgb[h // 3:h // 3 + 3, w // 5:4 * w // 5] = 255          # a bright tube
        Y, C = to_ycc(np.clip(rgb, 0, 255)[:, :w & ~1])
        out.append((name, Y, C, w & ~1, h))
    return out


def reference(cases):
    with tempfile.TemporaryDirectory() as tmp:
        jobs = []
        for i, (Y, C, w, h, level, colour, white, table_, strong) in enumerate(cases):
            yp, cp = os.path.join(tmp, 'y%d' % i), os.path.join(tmp, 'c%d' % i)
            Y.tofile(yp); C.tofile(cp)
            jobs.append(dict(w=w, h=h, level=level, colour=colour, white=white, table=base64.b64encode(table_).decode(),
                             strong=base64.b64encode(strong).decode() if strong else None, y=yp, c=cp, outY=yp + '.o', outC=cp + '.o'))
        with open(os.path.join(tmp, 'cases.json'), 'w') as f:
            json.dump(jobs, f)
        subprocess.run(['npx', 'vite-node', str(REPO / 'tools/gr3extras/halation_ref.mts'), os.path.join(tmp, 'cases.json')], check=True, cwd=REPO,
                       stdout=subprocess.DEVNULL)
        return [(np.fromfile(j['outY'], np.uint8).reshape(j['h'], j['w']), np.fromfile(j['outC'], np.uint8).reshape(j['h'], j['w'])) for j in jobs]


def jpeg_checks():
    pics = pictures()
    report = {}
    for which, scatter in (('on', True), ('absent', False)):
        j = Jpeg(IMG[which], scatter)
        cases, got = [], []
        for film in range(FILMS):
            table_, strong = j.tables(film)
            for name, Y, C, w, h in pics:
                if film and name != 'night':
                    continue
                for colour in ('red', 'white'):
                    for level in (1, 2, 3):
                        stash = (FILM_STYLE + film) | (level << 8) | STASH_VALID | (STASH_WHITE if colour == 'white' else 0)
                        y, c = j.run(Y, C, w, h, stash)
                        cases.append((Y, C, w, h, level, colour, 'scatter' if scatter else 'classic', table_, strong))
                        got.append(('%s film %d %s %s %d' % (which, film, name, colour, level), y, c, int((y != Y).sum())))
        # the other white too, to show the two whites are told apart on these pictures
        other = [(i, x[:6] + ('classic' if scatter else 'scatter',) + x[7:]) for i, x in enumerate(cases) if x[5] == 'white']
        refs = reference(cases + [x for _, x in other])
        for (label, y, c, changed), (ry, rc) in zip(got, refs):
            check(np.array_equal(y, ry) and np.array_equal(c, rc), '%s: module and reference differ' % label)
            check(changed > 0, '%s: nothing changed' % label)
        for (i, _), (ry, rc) in zip(other, refs[len(cases):]):
            if not (scatter and cases[i][4] == 3):     # Strong: the same glow, from another start (differs only where the light does)
                check(not (np.array_equal(got[i][1], ry) and np.array_equal(got[i][2], rc)), '%s: the other white gives the same picture' % got[i][0])
        report[which] = len(got)
        # nothing to do
        name, Y, C, w, h = pics[0]
        for stash in (FILM_STYLE | (2 << 8), FILM_STYLE | STASH_VALID, FILM_STYLE | STASH_VALID | STASH_WHITE, 11 | (2 << 8) | STASH_VALID,
                      17 | (3 << 8) | STASH_VALID | STASH_WHITE, (FILM_STYLE + FILMS) | (2 << 8) | STASH_VALID, 0):
            y, c = j.run(Y, C, w, h, stash)
            check(np.array_equal(y, Y) and np.array_equal(c, C), '%s: stash %#x changed the picture' % (which, stash))
        # every write of the module, on a small picture
        for colour, level in (('white', 1), ('white', 2), ('white', 3), ('red', 2)):
            j.run(Y[:120, :160].copy(), C[:120, :160].copy(), 160, 120, FILM_STYLE | (level << 8) | STASH_VALID | (STASH_WHITE if colour == 'white' else 0), watch=True)
        if '--peak' in args:
            Y6, C6 = np.full((4000, 6000), 120, np.uint8), np.full((4000, 6000), 128, np.uint8)
            peaks = {}
            for colour in ('red', 'white'):
                for level in (1, 2, 3):
                    peaks['%s %d' % (colour, level)] = j.run(Y6, C6, 6000, 4000, FILM_STYLE | (level << 8) | STASH_VALID | (STASH_WHITE if colour == 'white' else 0), peak=True)
            report[which + ' heap 6000x4000'] = peaks
        print('JPEG step %s: %d cases same as the reference (%s white), nothing-to-do cases unchanged, writes in place' % (which, len(got), '0.9' if scatter else '0.8.2'))
    return report


# ------------------------------------------------------------------ 2. OFF: the official JPEG step
def changed_words(img):
    n = len(OFF_IMG)
    a, b = np.frombuffer(OFF_IMG[:n & ~3], '<u4'), np.frombuffer(img[:n & ~3], '<u4')
    return set((BASE + 4 * np.nonzero(a != b)[0]).tolist())


def off_checks():
    off, absent, on = IMG['off'], IMG['absent'], IMG['on']
    check(off[EXECUTE - BASE:EXECUTE - BASE + 0x400] == OFF_IMG[EXECUTE - BASE:EXECUTE - BASE + 0x400], 'OFF: Execute is not the official code')
    check(b'HAL4' not in off[len(OFF_IMG):] and MODULE_09[:64] not in off and MODULE_089[:64] not in off, 'OFF: a halation module or context is in the image')
    ca, co, cn = changed_words(absent), changed_words(off), changed_words(on)
    check(cn == ca, 'ON changes other words of the official image than ABSENT: %s' % [hex(x) for x in sorted(cn ^ ca)][:8])
    gone = ca - co
    check(co - ca == set(), 'OFF changes words ABSENT does not: %s' % [hex(x) for x in sorted(co - ca)][:8])
    check(gone == set(ROW_SITES) | {EXECUTE}, 'OFF: the words given back are not the rows\' hooks and the JPEG entry: %s' % [hex(x) for x in sorted(gone ^ (set(ROW_SITES) | {EXECUTE}))][:8])
    check(BASE_DEFAULT in co and word(off, BASE_DEFAULT) >> 24 == 0xEA, 'OFF: the base column hook')
    for a in gone:
        check(word(off, a) == word(OFF_IMG, a), 'OFF: %#x not official' % a)
    print('OFF: Execute official, no module or context; changes the words ABSENT changes less the JPEG entry and the %d row hooks; ON changes the same words as ABSENT' % len(ROW_SITES))
    return dict(changed_absent=len(ca), changed_off=len(co))


# ------------------------------------------------------------------ 3. the development step's adapter
LOOKS = list(range(0, 31)) + list(range(60, 91)) + [255]


def expected_stash(which, look, state):
    film = 64 <= look < 64 + FILMS
    level, white = 0, 0
    if film:
        s = 0 if state >= 7 else state
        if s >= 4:
            level, white = s - 3, 1
        else:
            level = {0: 0, 1: 1, 2: 3, 3: 2}[s]
        if which == 'on' and look - 64 == MONO and level:
            white = 1
    style = look - 32 if look >= 64 else look
    return style | (level << 8) | STASH_VALID | (white << 17)


def develop_checks():
    out = {}
    for which in ('on', 'absent', 'off'):
        img = IMG[which]
        check(word(img, DEVELOP) >> 24 == 0xEA and word(OFF_IMG, DEVELOP) == 0xE5D3277C, 'development read: hooked')
        uc = machine(img)
        n = 0
        for look in LOOKS:
            for state in range(12):
                rec = bytearray(0x800); rec[0x77c] = look; rec[0x786] = state
                uc.mem_write(REC, bytes(rec))
                regs = [0x1000 * (i + 1) + look for i in range(13)]; regs[3] = REC
                for i in range(13):
                    uc.reg_write(R[i], regs[i])
                uc.reg_write(UC_ARM_REG_SP, STACK_TOP); uc.reg_write(UC_ARM_REG_LR, 0x5A5A5A5A)
                flags = (look * 7 + state) & 15
                uc.reg_write(UC_ARM_REG_CPSR, 0x13 | (flags << 28))
                uc.mem_write(GAP, bytes(0x50))
                uc.emu_start(DEVELOP, DEVELOP + 4, count=2000)
                check(uc.reg_read(UC_ARM_REG_PC) == DEVELOP + 4, 'adapter: did not come back')
                o = [uc.reg_read(R[i]) for i in range(13)]
                film = 64 <= look < 64 + FILMS
                # r2: every film number (64..83, image-control.ts maps all twenty) reads as Standard
                check(o[2] == (11 if 64 <= look < 84 else look), 'adapter: r2 for look %d' % look)
                check(o[:2] + o[3:] == regs[:2] + regs[3:] and uc.reg_read(UC_ARM_REG_SP) == STACK_TOP and uc.reg_read(UC_ARM_REG_LR) == 0x5A5A5A5A, 'adapter: registers')
                check(uc.reg_read(UC_ARM_REG_CPSR) >> 28 == flags, 'adapter: flags')
                # the stash word (round 10's 0x55804378): the only word of the RAM gap written
                gap = struct.unpack('<20I', bytes(uc.mem_read(GAP, 0x50)))
                check([i for i, v in enumerate(gap) if v] == [2], 'adapter: writes in the RAM gap %r' % (gap,))
                stash = GAP + 8
                got = struct.unpack('<I', bytes(uc.mem_read(stash, 4)))[0]
                want = expected_stash(which, look, state)
                check(got == want, '%s adapter: look %d state %d: stash %#x, expected %#x' % (which, look, state, got, want))
                n += 1
        out[which] = n
    print('development step: %d looks x 12 states in each build: stash as expected (ON: film %d white), registers and flags kept' % (len(LOOKS), MONO))
    return out


# ------------------------------------------------------------------ 4. the parameter screen's rows
class Rows:
    def __init__(self, img):
        self.img = img
        for f, w0 in ((BASE_FN, 0xE1A0C00D), (IS_VALID, 0xE1A0C00D), (LINE_COUNT, 0xE1A0C00D), (KIND, 0xE1A0C00D)):
            check(word(OFF_IMG, f) == w0, 'rows: function at %#x' % f)
        check(word(OFF_IMG, BASE_FN + 0xC) == 0xE1A04001 and word(OFF_IMG, BASE_FN + 0x18) == 0xE1A06000, 'rows: GetBaseKindDetailControl')
        self.assert_fn = branch(BASE_TARGET + 0x1C, word(OFF_IMG, BASE_TARGET + 0x1C))
        self.focus_fn = branch(KIND + 0x14, word(OFF_IMG, KIND + 0x14))
        self.uc = machine(img)
        self.uc.hook_add(UC_HOOK_CODE, self._hook, begin=min(self.assert_fn, self.focus_fn), end=max(self.assert_fn, self.focus_fn))

    def _hook(self, uc, at, size, _):
        if at == self.assert_fn:
            if uc.reg_read(UC_ARM_REG_R0) == 0:
                self.asserts.append(uc.reg_read(UC_ARM_REG_R3))
        elif at == self.focus_fn:
            uc.reg_write(UC_ARM_REG_R0, self.focus)
        else:
            return
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def call(self, fn, *a):
        uc = self.uc
        regs = [0x12340000 + i for i in range(13)]
        for i, v in enumerate(a):
            regs[i] = v
        for i in range(13):
            uc.reg_write(R[i], regs[i])
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP); uc.reg_write(UC_ARM_REG_LR, STOP)
        uc.emu_start(fn, STOP, count=5000)
        check(uc.reg_read(UC_ARM_REG_PC) == STOP and uc.reg_read(UC_ARM_REG_SP) == STACK_TOP, 'rows: %#x did not return' % fn)
        check([uc.reg_read(r) for r in CALLEE] == regs[4:12], 'rows: callee-saved registers')
        return uc.reg_read(UC_ARM_REG_R0)

    def screen(self, look, set_, movie):
        uc = self.uc
        ctl = bytearray(0x200); ctl[0x198:0x19e] = bytes([look, set_, 0, 0, 0, movie]); ctl[0x194:0x198] = struct.pack('<I', CTL + 0x100)
        uc.mem_write(CTL, bytes(ctl))
        self.asserts = []
        col = self.call(BASE_FN, CTL, look)
        asserts = self.asserts
        rows = None
        if set_ < 3:
            uc.mem_write(CTL + 0x19a, bytes([col]))
            tab = movw(word(self.img, adr(0x531b01f4))) | (movw(word(self.img, adr(0x531b01f8))) << 16)
            raw = struct.unpack_from('<I', self.img, tab + 8 * (12 * set_ + col) + 4 - BASE)[0]
            rows = []
            for i in range(raw):
                self.focus = i
                if self.call(IS_VALID, CTL, set_, col, i):
                    rows.append(self.call(KIND, CTL))
            check(self.call(LINE_COUNT, CTL, set_, col) == len(rows), 'rows: line count')
        check(not self.asserts or self.asserts == asserts, 'rows: an assert in the line functions')
        return col, asserts, rows


def rows_checks():
    R_ = {k: Rows(IMG[k]) for k in ('official', 'absent', 'on', 'off')}
    n = 0
    for movie in (0, 1):
        for s in range(4):
            for look in LOOKS:
                o = R_['official'].screen(look, s, movie)
                film = 64 <= look < 64 + FILMS and s < 3
                std = R_['official'].screen(11, s, movie)[2]
                for which in ('absent', 'on', 'off'):
                    b = R_[which].screen(look, s, movie)
                    if not film:
                        check(b == o, '%s rows: look %d set %d movie %d: %r, official %r' % (which, look, s, movie, b, o))
                    elif which == 'off':
                        check(b == (0, [], std) and o[0] == 0 and o[1] == [0x375] and o[2] == std, 'off rows: film %d set %d movie %d: %r' % (look, s, movie, b))
                    else:
                        check(b[1] == [] and b[2] == std + ([15, 10] if not movie else []), '%s rows: film %d set %d movie %d: %r' % (which, look, s, movie, b))
                    n += 1
    print('rows: %d screens: films have Standard\'s rows + Halation (15) and Colour (10) in stills when on or absent, Standard\'s rows (no assert) when off; other looks as official' % n)
    return n


try:
    rep = dict(release=rel, off=off_checks(), develop=develop_checks(), rows=rows_checks(), jpeg=jpeg_checks())
    print(json.dumps(dict(ok=True, **rep)))
except Fail as e:
    sys.exit('FAIL: %s' % e)
