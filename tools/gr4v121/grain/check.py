# SPDX-License-Identifier: GPL-2.0-only
"""Run the compiled grain module (grain-code.ts) in unicorn and compare it with model.py byte for byte.

Checks: every Strength x Size on pictures of several sizes (main, screennail-like, thumbnail-like),
the off cases (no stash bit, Grainy look, bad values), the colour plane untouched, the bytes outside
the picture untouched, every allocation released, and an instruction count for a full-size picture.
"""
import base64
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_BLOCK
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_SP

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import model  # noqa: E402

ROOT = HERE.parent.parent.parent
# 1.21 uses the 1.20 port's module and tables (core/overlays.mjs): they name no firmware address.
CODE = base64.b64decode(re.search(r"GRAIN_CODE = '([^']+)'", (ROOT / 'core/src/fw/gr4v120/aspect/grain-code.ts').read_text()).group(1))
TABLES = (ROOT / 'core/src/fw/gr4v120/aspect/grain-tables.ts').read_text()
AMP = np.array(json.loads(re.search(r'GRAIN_AMP: readonly number\[\] = (\[[^\]]*\])', TABLES).group(1)), dtype=np.uint8).reshape(3, 256)
OCT = json.loads(re.search(r'GRAIN_OCTAVES: readonly number\[\] = (\[[^\]]*\])', TABLES).group(1))
GAIN = np.array(json.loads(re.search(r'GRAIN_GAIN: readonly number\[\] = (\[[^\]]*\])', TABLES).group(1)), dtype=np.uint8)
MEDIUM = tuple(tuple(OCT[(4 + o) * 2:(4 + o) * 2 + 2]) for o in range(4))

CODE_AT, STUBS, CTX, STASH, TAB, CFG, STACK, HEAP, PIC = 0x54400000, 0x54500000, 0x55000000, 0x55001000, 0x55002000, 0x55003000, 0x5f000000, 0x60000000, 0x70000000
FN = {'cache': 0, 'invalidate': 4, 'clean': 8, 'alloc': 12, 'release': 16}


class Run:
    def __init__(self):
        u = self.u = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        u.mem_map(CODE_AT, 0x200000)
        u.mem_map(CTX, 0x10000)
        u.mem_map(STACK - 0x100000, 0x100000)
        u.mem_map(HEAP, 0x4000000)
        u.mem_map(PIC, 0x8000000)
        u.mem_write(CODE_AT, CODE)
        for off in FN.values():
            u.mem_write(STUBS + off, struct.pack('<I', 0xe12fff1e))  # bx lr
        self.live = {}
        self.top = HEAP
        self.count = 0
        self.flushed = []
        u.hook_add(UC_HOOK_CODE, self.stub, begin=STUBS, end=STUBS + 0x20)
        self.counting = False
        u.hook_add(UC_HOOK_BLOCK, self.block, begin=CODE_AT, end=CODE_AT + len(CODE))

    def block(self, u, addr, size, _):
        if self.counting:
            self.count += size // 4

    def stub(self, u, addr, size, _):
        off = addr - STUBS
        if off == FN['alloc']:
            n = u.reg_read(UC_ARM_REG_R0)
            a = (self.top + 63) & ~63
            self.top = a + n
            u.mem_write(a, bytes([0xa5]) * n)  # not zero: the module must not rely on it
            self.live[a] = n
            u.reg_write(UC_ARM_REG_R0, a)
        elif off == FN['release']:
            a = u.reg_read(UC_ARM_REG_R0)
            assert a in self.live, hex(a)
            del self.live[a]
        elif off == FN['cache']:
            u.reg_write(UC_ARM_REG_R0, 0x1234)
        else:
            self.flushed.append((off, u.reg_read(UC_ARM_REG_R1)))

    def call(self, pictures, stash, count=False):
        """pictures: [(Y, C), ...] (at most 3; the first is listed twice). Returns their Y planes after the call."""
        u = self.u
        u.mem_write(TAB, AMP.tobytes() + bytes(OCT) + GAIN.tobytes())
        u.mem_write(CTX, struct.pack('<11I', STUBS + 0, STUBS + 4, STUBS + 8, STUBS + 12, STUBS + 16, STASH, TAB, TAB + 768, TAB + 792, model.FULL_WIDTH, 0x324e5247))
        u.mem_write(STASH, struct.pack('<I', stash))
        cfg = bytearray(0x60)
        at, layout = PIC, []
        for n, (Y, C) in enumerate(pictures):
            h, w = Y.shape
            stride = (w + 31) & ~31
            planes = np.full((2, h + 4, stride), 0x5a, dtype=np.uint8)
            planes[0, :h, :w] = Y
            planes[1, :h, :w] = C
            u.mem_write(at, planes.tobytes())
            u.mem_write(CFG + 0x200 + 0x40 * n, struct.pack('<B3xIIIHHHHHH4x', 1, at, at + planes[0].nbytes, 0, w, h, stride, h, 0, 0))
            struct.pack_into('<I', cfg, 0x3c + 4 * (n + 1), CFG + 0x200 + 0x40 * n)
            layout.append((at, planes.shape, h, w, C))
            at += (planes.nbytes + 0xffff) & ~0xffff
        struct.pack_into('<I', cfg, 0x3c, CFG + 0x200)  # the first picture twice: done once
        u.mem_write(CFG, bytes(cfg))
        u.reg_write(UC_ARM_REG_R0, CTX)
        u.reg_write(UC_ARM_REG_R1, CFG)
        u.reg_write(UC_ARM_REG_SP, STACK)
        u.reg_write(UC_ARM_REG_LR, 0x54600000)
        self.count = 0
        self.counting = count
        u.emu_start(CODE_AT, 0x54600000)
        self.counting = False
        assert not self.live, 'allocation not released'
        outs = []
        for at, shape, h, w, C in layout:
            out = np.frombuffer(u.mem_read(at, int(np.prod(shape))), dtype=np.uint8).reshape(shape)
            rest = out.copy(); rest[0, :h, :w] = 0x5a; rest[1, :h, :w] = 0x5a
            assert (rest == 0x5a).all(), 'wrote outside the picture'
            assert (out[1, :h, :w] == C).all(), 'colour plane changed'
            outs.append(out[0, :h, :w].copy())
        return outs


def stash(on, strength, size, written=True):
    return 0x10011 | (0x2000000 if written else 0) | (0x100000 if on else 0) | (strength << 21) | (size << 23)


def picture(h, w, seed, noise=6.0):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    Y = (128 + 110 * np.sin(xx / w * 6.3) * np.cos(yy / h * 3.1) + rng.normal(0, noise, (h, w))).clip(0, 255).astype(np.uint8)
    Y[:, :8] = 0; Y[:, -8:] = 255
    C = rng.integers(0, 256, (h, w), dtype=np.uint8)
    return Y, C


def expect(pictures):
    """What the module gives: the strength from the largest picture's texture, the same for all."""
    big = max((Y for Y, _ in pictures), key=lambda y: y.shape[1])
    amp = model.auto_amp(AMP, GAIN, model.texture(big))
    return [model.apply(Y, amp, MEDIUM) for Y, _ in pictures]


def main():
    r = Run()
    n = 0
    seen = set()
    for (h, w) in ((96, 6192), (240, 1600), (120, 160), (481, 1280), (50, 3001)):
        for noise in (0.0, 0.4, 1.0, 2.0, 3.5, 9.0):
            pics = [picture(h, w, h + w, noise)]
            seen.add(model.texture(pics[0][0]))
            for st in (stash(True, 1, 1), stash(True, 0, 2), stash(True, 3, 3)):  # Strength and Size do not count
                got = r.call(pics, st)
                assert all((g == e).all() for g, e in zip(got, expect(pics))), f'{w}x{h} noise {noise}: differs'
                n += 1
            for st in (stash(False, 2, 2), stash(True, 2, 2, written=False), 0x100000 | 0x10011, 0):
                assert (r.call(pics, st)[0] == pics[0][0]).all(), f'grain where there should be none: {st:#x}'
                n += 1
    # A picture too dark to measure: full strength.
    Y, C = picture(96, 2048, 5); Y[:] = 12
    assert model.texture(Y) == 64 and (r.call([(Y, C)], stash(True, 1, 1))[0] == expect([(Y, C)])[0]).all(); n += 1
    # Main picture, screennail and thumbnail in one call: one strength, from the largest.
    for noise in (0.5, 4.0):
        pics = [picture(120, 160, 3, 0.0), picture(96, 6192, 4, noise), picture(240, 1280, 5, 1.0)]
        got = r.call(pics, stash(True, 1, 1))
        assert all((g == e).all() for g, e in zip(got, expect(pics))), 'several pictures'
        n += 1
    assert len(seen) >= 5 and min(seen) < 6 and max(seen) > 20, sorted(seen)
    # Speed: a full-size strip, scaled to a full picture (the measuring is a fixed 0.3 M pixels).
    r.call([picture(64, 6192, 1)], stash(True, 1, 1), count=True); c64 = r.count
    r.call([picture(128, 6192, 1)], stash(True, 1, 1), count=True); c128 = r.count
    full = c64 + (c128 - c64) * (4128 - 64) / 64
    print(f'{n} cases byte-exact (textures measured: {sorted(seen)}); instructions for 6192x4128: {full / 1e6:.0f} M')


if __name__ == '__main__':
    main()
