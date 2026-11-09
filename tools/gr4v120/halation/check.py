# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the halation module in a built firmware (core/src/fw/gr4v120/aspect/halation.ts).

    python3 tools/gr4v120/halation/check.py BUILT.bin.rtos PHOTO.JPG [PHOTO.JPG ...] [--width W] [--full] [--dump DIR] [--style N]

BUILT.bin.rtos is the decoded RTOS section of a build (tools/testfw/build.ts and the extend tools
write it next to the file). The JPEG step's entry is followed (through the HDR gain map's wrapper
when there is one) to the halation stub, which names the context and the module. For each photo
(decoded, scaled to W wide unless --full, as a YCbCr 4:2:2 picture like the camera's), each colour
(red, white) and level (Weak, Medium, Strong) of the look (the first one with halation, or
--style):

 1. the module runs on the picture through its context, the cache and heap functions it is given
    returning at once (the heap from a pool that is checked to be given back);
 2. the planes after it are compared, byte for byte, with GR Mod's reference (tools/gr4v120/halation/ref.mts:
    halateYcc on the look's light tables as the image holds them; white the 0.9 scatter when the
    context has a `struct scatter`, else the 0.8.2 white glow);
 3. registers r4..r11 and sp are as before; (pictures of at most 640 wide) every memory write of
    the module lands in the picture's planes, the blocks it was given or the stack.
Also: the stash invalid / the level off / a look without halation leave the picture alone, and the
JPEG step's entry runs the module too (the chain before the encoder). With --full, instructions per
picture are counted. With --dump, the planes after each case are written to DIR (to compare builds).
"""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_HOOK_BLOCK
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
                               UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_SP, UC_ARM_REG_LR,
                               UC_ARM_REG_PC)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE)) if os.path.basename(os.path.dirname(HERE)) == 'tools' else os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
REF = os.path.join(HERE, 'ref.mts')

BASE = 0x53000000
JPEG_EXECUTE = 0x53727E10
RAM = 0x55000000          # the stash and the camera's other RAM words
HEAP = 0x58000000
HEAP_END = 0x5C000000
STACK = 0x5E000000
STACK_TOP = 0x5E0F0000
STOP = 0x5F0F0000
CONFIG = 0x5F000000
PICTURE = 0x5F000400
PLANES = 0x60000000
STASH_VALID, STASH_WHITE = 0x10000, 0x20000
SCATTER_MAGIC = 0x31435348
CALLEE = [UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_SP]


class Fail(Exception):
    pass


def check(cond, what):
    if not cond:
        raise Fail(what)


def branch(at, word):
    off = word & 0xFFFFFF
    if off & 0x800000:
        off -= 0x1000000
    return at + 8 + off * 4


def movw(word):
    return ((word >> 4) & 0xF000) | (word & 0xFFF)


class Image_:
    def __init__(self, rtos):
        self.rtos = rtos

    def word(self, a):
        return struct.unpack_from('<I', self.rtos, a - BASE)[0]

    def stub(self):
        """The halation stub, through the HDR gain map's wrapper when it comes first."""
        first = self.word(JPEG_EXECUTE)
        check(first >> 24 == 0xEA, 'JPEG step: no branch at the entry')
        at = branch(JPEG_EXECUTE, first)
        for _ in range(4):
            if self.word(at + 4) == 0xE5911008:      # ldr r1,[r1,#8]: the halation stub
                return at
            if self.word(at) == 0xE92D4013:          # the HDR wrapper: push {r0,r1,r4,lr}; ...; bl trampoline
                for x in range(at + 4, at + 32, 4):
                    if self.word(x) >> 24 == 0xEB:
                        t = branch(x, self.word(x))
                        check(self.word(t) >> 24 == 0xEA, 'HDR trampoline')
                        at = branch(t, self.word(t))
                        break
                continue
            if self.word(at) >> 24 == 0xEA:
                at = branch(at, self.word(at))
                continue
            break
        raise Fail('JPEG step: no halation stub found')

    def context(self):
        s = self.stub()
        ctx = movw(self.word(s + 8)) | (movw(self.word(s + 12)) << 16)
        bl = self.word(s + 16)
        check(bl >> 24 == 0xEB, 'halation stub: no call')
        return s, ctx, branch(s + 16, bl)


class Emu:
    def __init__(self, rtos):
        self.img = Image_(rtos)
        self.stub, self.ctx, self.module = self.img.context()
        w = lambda i: self.img.word(self.ctx + 4 * i)
        self.cache, self.invalidate, self.clean, self.alloc, self.release = (w(i) for i in range(5))
        self.stash, self.lut, self.looks, self.count, self.scatter = w(5), w(6), w(7), w(8), w(9)
        check(self.img.word(self.ctx + 56) == 0x344C4148, "context magic 'HAL4'")
        self.map = bytes(rtos[self.ctx + 60 - BASE:self.ctx + 124 - BASE])
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(rtos) + 0xFFFFF) & ~0xFFFFF
        self.uc.mem_map(BASE, size)
        self.uc.mem_write(BASE, bytes(rtos))
        for a, n in ((RAM, 0x1000000), (HEAP, HEAP_END - HEAP), (STACK, 0x100000), (CONFIG, 0x100000), (PLANES, 0x8000000)):
            self.uc.mem_map(a, n)
        self.uc.hook_add(UC_HOOK_CODE, self._fn, begin=min(self.cache, self.invalidate, self.clean, self.alloc, self.release),
                         end=max(self.cache, self.invalidate, self.clean, self.alloc, self.release))
        self.blocks = 0
        self.writes = None

    def _fn(self, uc, at, size, _):
        ret = lambda v=None: (v is not None and uc.reg_write(UC_ARM_REG_R0, v), uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR)))
        if at == self.cache:
            ret(0x12345678)
        elif at in (self.invalidate, self.clean):
            self.syncs += 1
            ret()
        elif at == self.alloc:
            n = uc.reg_read(UC_ARM_REG_R0)
            a = self.heap
            self.heap = (a + n + 63) & ~63
            check(self.heap <= HEAP_END, 'heap pool exhausted')
            self.live[a] = n
            ret(a)
        elif at == self.release:
            p = uc.reg_read(UC_ARM_REG_R0)
            check(p in self.live, f'release of {p:#x} not given')
            del self.live[p]
            ret()

    def looks_of(self):
        return [s for s in range(64) if self.map[s] and self.map[s] <= self.count]

    def tables(self, style):
        e = self.map[style]
        b = bytes(self.uc.mem_read(self.looks + (e - 1) * 520 + 8, 512))
        strong = None
        if self.scatter and self.img.word(self.scatter) == SCATTER_MAGIC:
            sp = self.img.word(self.scatter + 36)
            strong = bytes(self.uc.mem_read(sp + (e - 1) * 512, 512))
        return b, strong

    def run(self, Y, C, w, h, stash, entry=False, watch=False, count=False):
        uc = self.uc
        uc.mem_write(PLANES, Y.tobytes())
        cplane = PLANES + ((w * h + 0xFFFF) & ~0xFFFF)
        uc.mem_write(cplane, C.tobytes())
        uc.mem_write(PICTURE, struct.pack('<B3xIII4H2H4x', 1, PLANES, cplane, w * h, w, h, w, h, 0, 0))
        uc.mem_write(CONFIG, bytes(0x100))
        uc.mem_write(CONFIG + 0x3C, struct.pack('<I', PICTURE))
        uc.mem_write(self.stash, struct.pack('<I', stash))
        self.heap, self.live, self.syncs = HEAP, {}, 0
        saved = [0x11111111 * (i + 1) & 0xFFFFFFFF for i in range(8)]
        for r, v in zip(CALLEE[:8], saved):
            uc.reg_write(r, v)
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP)
        uc.reg_write(UC_ARM_REG_LR, STOP)
        hooks = []
        if watch:
            self.writes = []
            planes = ((PLANES, PLANES + w * h), (cplane, cplane + w * h))

            def on_write(uc_, access, addr, size, value, _):
                if any(a <= addr and addr + size <= b for a, b in planes):
                    return
                if STACK <= addr < STACK_TOP:
                    return
                if any(a <= addr and addr + size <= a + n for a, n in self.live.items()):
                    return
                self.writes.append(addr)
            hooks.append(uc.hook_add(UC_HOOK_MEM_WRITE, on_write))
        if count:
            self.blocks = 0

            def on_block(uc_, addr, size, _):
                self.blocks += size >> 2
            hooks.append(uc.hook_add(UC_HOOK_BLOCK, on_block))
        if entry:
            # The JPEG step's entry with the configuration as r1's object (+8); the encoder body is not run:
            # stop when the chain reaches the instruction after the entry.
            uc.mem_write(CONFIG + 0x800, struct.pack('<III', 0, 0, CONFIG))
            uc.reg_write(UC_ARM_REG_R0, 0)
            uc.reg_write(UC_ARM_REG_R1, CONFIG + 0x800)
            uc.emu_start(JPEG_EXECUTE, JPEG_EXECUTE + 4, count=0)
        else:
            uc.reg_write(UC_ARM_REG_R0, self.ctx)
            uc.reg_write(UC_ARM_REG_R1, CONFIG)
            uc.emu_start(self.module, STOP)
        for h_ in hooks:
            uc.hook_del(h_)
        if not entry:
            for r, v in zip(CALLEE[:8], saved):
                check(uc.reg_read(r) == v, 'callee-saved register changed')
            check(uc.reg_read(UC_ARM_REG_SP) == STACK_TOP, 'sp changed')
        check(not self.live, f'{len(self.live)} heap blocks not given back')
        if watch:
            check(not self.writes, f'writes outside: {[hex(a) for a in self.writes[:5]]}')
        y = np.frombuffer(bytes(uc.mem_read(PLANES, w * h)), np.uint8).reshape(h, w)
        c = np.frombuffer(bytes(uc.mem_read(cplane, w * h)), np.uint8).reshape(h, w)
        return y, c


def ycc(path, width):
    im = Image.open(path).convert('RGB')
    if width and im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    w, h = im.width & ~1, im.height
    a = np.asarray(im).astype(np.float64)[:, :w]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    Y = 0.299 * R + 0.587 * G + 0.114 * B
    Cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B
    Cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B
    C = np.empty_like(Y)
    C[:, 0::2] = (Cb[:, 0::2] + Cb[:, 1::2]) / 2
    C[:, 1::2] = (Cr[:, 0::2] + Cr[:, 1::2]) / 2
    q = lambda v: np.clip(np.rint(v), 0, 255).astype(np.uint8)
    return q(Y), q(C), w, h


def reference(tmp, Y, C, w, h, level, colour, table, strong, scatter):
    yp, cp = os.path.join(tmp, 'y'), os.path.join(tmp, 'c')
    Y.tofile(yp); C.tofile(cp)
    case = dict(w=w, h=h, level=level, colour=colour, white='scatter' if scatter else 'classic',
                table=base64.b64encode(table).decode(), strong=base64.b64encode(strong).decode() if strong else None,
                y=yp, c=cp, outY=yp + '.o', outC=cp + '.o')
    with open(os.path.join(tmp, 'case.json'), 'w') as f:
        json.dump(case, f)
    subprocess.run(['npx', 'tsx', REF, os.path.join(tmp, 'case.json')], check=True, cwd=ROOT)
    return (np.fromfile(yp + '.o', np.uint8).reshape(h, w), np.fromfile(cp + '.o', np.uint8).reshape(h, w))


def main():
    args = sys.argv[1:]
    opt = lambda name, default=None: (args[args.index(name) + 1] if name in args else default)
    width = 0 if '--full' in args else int(opt('--width', 2064))
    dump = opt('--dump')
    rest = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--width', '--dump', '--style'))]
    rtos = bytearray(open(rest[0], 'rb').read())
    photos = rest[1:]
    em = Emu(rtos)
    looks = em.looks_of()
    check(looks, 'no look with halation')
    style = int(opt('--style', looks[0]))
    scatter = bool(em.scatter) and em.img.word(em.scatter) == SCATTER_MAGIC
    table, strong = em.tables(style)
    print(f'stub {em.stub:#x} context {em.ctx:#x} module {em.module:#x}; looks {looks}; style {style}; scatter {"yes" if scatter else "no"}')
    if dump:
        os.makedirs(dump, exist_ok=True)
    report = {}
    with tempfile.TemporaryDirectory() as tmp:
        for k, photo in enumerate(photos):
            Y, C, w, h = ycc(photo, width)
            name = os.path.splitext(os.path.basename(photo))[0]
            for colour in ('red', 'white'):
                for level in (1, 2, 3):
                    stash = style | (level << 8) | STASH_VALID | (STASH_WHITE if colour == 'white' else 0)
                    y, c = em.run(Y, C, w, h, stash, count='--full' in args)
                    ry, rc = reference(tmp, Y, C, w, h, level, colour, table, strong, scatter)
                    same = np.array_equal(y, ry) and np.array_equal(c, rc)
                    changed = int((y != Y).sum())
                    entry = dict(same_as_reference=same, changed_luma=changed, syncs=em.syncs)
                    if '--full' in args:
                        entry['instructions'] = em.blocks
                    report[f'{name} {colour} {level}'] = entry
                    print(f'{name} {w}x{h} {colour} {level}: {"same" if same else "DIFFERENT"} as the reference, {changed} luma changed'
                          + (f', {em.blocks / 1e6:.0f}M instructions' if '--full' in args else ''))
                    check(same, f'{name} {colour} {level}: module and reference differ')
                    if dump:
                        np.save(os.path.join(dump, f'{name}_{colour}{level}.npy'), np.stack([y, c]))
            if k == 0:
                # nothing to do: stash invalid, level off, a look without halation
                for stash in (style | (2 << 8), style | STASH_VALID, (style ^ 0) | (4 << 8) | STASH_VALID):
                    y, c = em.run(Y, C, w, h, stash)
                    check(np.array_equal(y, Y) and np.array_equal(c, C), f'stash {stash:#x} changed the picture')
                free = [s for s in range(64) if not em.map[s]]
                y, c = em.run(Y, C, w, h, free[0] | (2 << 8) | STASH_VALID | STASH_WHITE)
                check(np.array_equal(y, Y) and np.array_equal(c, C), 'a look without halation changed the picture')
                # the JPEG step's entry runs the same
                stash = style | (2 << 8) | STASH_VALID | STASH_WHITE
                y0, c0 = em.run(Y, C, w, h, stash)
                y1, c1 = em.run(Y, C, w, h, stash, entry=True)
                check(np.array_equal(y0, y1) and np.array_equal(c0, c1), 'the JPEG step entry gives another picture')
                # every write of the module, on a small picture
                sY, sC, sw, sh = ycc(photo, 640)
                for colour, level in (('white', 1), ('white', 2), ('white', 3), ('red', 2)):
                    em.run(sY, sC, sw, sh, style | (level << 8) | STASH_VALID | (STASH_WHITE if colour == 'white' else 0), watch=True)
                print('nothing to do: unchanged; JPEG step entry: same; writes of the module: planes, its blocks, the stack only')
    print(json.dumps({'ok': True, 'cases': len(report)}))


if __name__ == '__main__':
    try:
        main()
    except Fail as e:
        sys.exit(f'FAIL: {e}')
