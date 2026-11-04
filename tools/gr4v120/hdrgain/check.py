# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the HDR gain map in a built firmware (core/src/fw/gr4v120/aspect/hdrgain.ts).

    python3 tools/gr4v120/hdrgain/check.py BUILT.bin.rtos TABLES.json PHOTO.JPG [PHOTO.JPG ...] [--full] [--out DIR]

BUILT.bin.rtos is the decoded RTOS section that tools/testfw/build.ts writes next to a test build;
TABLES.json is the output of `npx vite-node tools/gr4v120/hdrgain/tables.ts`. For each camera JPEG:

 1. JpegEncodeMacroProcess::Execute of the built image is called (its entry word, so the hook chain
    before it runs too) with a configuration like the camera's: the main picture (the photo's Y,
    from decoding it), screennail and thumbnail pictures, and the output descriptors with the
    photo's own main stream at +0x4C. The function body itself is replaced by a return (the
    encoder is hardware), so what runs is: the hooks at its entry, our stub after it, the module.
 2. The gain map the module kept is compared with tools/gr4v120/hdrgain/ref.py, byte for byte.
 3. The camera's generic JPEG write (0x5382B814) is run with an ExifJpegWriter whose blocks are
    the photo's header (SOI..APP7) and main stream; its Seek / Write calls build the file.
 4. The file: camera header and main stream unchanged, XMP / ISO / MPF as expected, the gain map
    the one kept; libultrahdr (imagecodecs) decodes it, the highlights come out brighter.

Then: a stream with no gain map (2 blocks, or 3 with the diagnostics segment), a writer with odd
blocks, burst (more pictures than kept gain maps, one of them pinned by a writer), memory that runs
out, and (small pictures) every memory write of the module and the stubs checked to land on the
stack, the heap blocks it owns or its state word. Registers r4-r11 and sp are checked after each call.
With --full also the instruction count per picture.
"""
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image
from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_HOOK_BLOCK
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5,
                               UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11,
                               UC_ARM_REG_R12, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ref  # noqa: E402

BASE = 0x53000000
JPEG_EXECUTE = 0x53727E10
EXECUTE_BODY = JPEG_EXECUTE + 4
WRITE = 0x5382B814
WRITE_SEGMENTED = 0x5382B9B0
SEGMENTED = 0x5538E0CC        # u8 on, u32 bytes per piece, u32 pause
PAUSE = 0x53909C88
ASSERT = 0x539154F8
ALLOC = 0x539084BC
FREE = 0x539084F8
FLUSH = 0x53000930
SETTINGS = 0x550832A8

HEAP = 0x58000000
HEAP_END = 0x5C000000
STACK = 0x5E000000
STACK_TOP = 0x5E0F0000
DATA = 0x5F000000
STOP = 0x5F0F0000
SEEK_FN = 0x5F0F0100
WRITE_FN = 0x5F0F0200
PLANES = 0x60000000
STREAM = 0x68000000
STREAM2 = 0x6A000000
PREVIEW = 0x6B000000
HEADER = 0x6B800000

CALLEE = [UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_SP]


class Fail(Exception):
    pass


def check(cond, what):
    if not cond:
        raise Fail(what)


class Machine:
    def __init__(self, rtos, tables):
        self.t = tables
        self.uc = uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        uc.mem_map(BASE, 0x03000000)          # image and its RAM up to 0x56000000
        uc.mem_write(BASE, rtos)
        uc.mem_map(HEAP, HEAP_END - HEAP)
        uc.mem_map(STACK, 0x00100000)
        uc.mem_map(DATA, 0x00100000)
        uc.mem_map(PLANES, 0x08000000)
        uc.mem_map(STREAM, 0x02000000)
        uc.mem_map(STREAM2, 0x01000000)
        uc.mem_map(PREVIEW, 0x00800000)
        uc.mem_map(HEADER, 0x00100000)
        for a in (STOP, SEEK_FN, WRITE_FN):
            uc.mem_write(a, struct.pack('<I', 0xE12FFF1E))  # bx lr
        self.heap_next = HEAP
        self.live = {}
        self.freed = []
        self.alloc_limit = None
        self.flushes = []
        self.file = bytearray()
        self.file_ops = []
        self.asserts = 0
        self.module = rtos.find(bytes.fromhex(tables['module']))
        check(self.module > 0, 'module not found in the image')
        self.module += BASE
        self.module_end = self.module + len(bytes.fromhex(tables['module']))
        self.execute_ret = 0
        self.counting = False
        self.insns = 0
        self.watch = False
        self.bad_writes = []
        uc.hook_add(UC_HOOK_CODE, self._alloc, begin=ALLOC, end=ALLOC)
        uc.hook_add(UC_HOOK_CODE, self._free, begin=FREE, end=FREE)
        uc.hook_add(UC_HOOK_CODE, self._flush, begin=FLUSH, end=FLUSH)
        uc.hook_add(UC_HOOK_CODE, self._execute, begin=EXECUTE_BODY, end=EXECUTE_BODY)
        uc.hook_add(UC_HOOK_CODE, self._assert, begin=ASSERT, end=ASSERT)
        uc.hook_add(UC_HOOK_CODE, lambda uc, a, s, u: self._ret(), begin=PAUSE, end=PAUSE)
        uc.hook_add(UC_HOOK_CODE, self._seek, begin=SEEK_FN, end=SEEK_FN)
        uc.hook_add(UC_HOOK_CODE, self._write, begin=WRITE_FN, end=WRITE_FN)
        uc.hook_add(UC_HOOK_BLOCK, self._block)
        uc.hook_add(UC_HOOK_MEM_WRITE, self._memw)
        self.pos = 0

    # ---- hooks
    def _ret(self, value=None):
        uc = self.uc
        if value is not None:
            uc.reg_write(UC_ARM_REG_R0, value)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def _alloc(self, uc, a, s, u):
        n = uc.reg_read(UC_ARM_REG_R0)
        if self.alloc_limit is not None and n > self.alloc_limit:
            return self._ret(0)
        p = (self.heap_next + 63) & ~63
        check(p + n < HEAP_END, 'emulated heap exhausted')
        self.heap_next = p + n + 64
        uc.mem_write(p, bytes([0xA5]) * min(n, 4096))  # not zero: the module must not rely on it
        self.live[p] = n
        self._ret(p)

    def _free(self, uc, a, s, u):
        p = uc.reg_read(UC_ARM_REG_R0)
        check(p in self.live, f'free of a block not allocated: {p:#x}')
        del self.live[p]
        self.freed.append(p)
        self._ret()

    def _flush(self, uc, a, s, u):
        addr, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
        check(addr % 64 == 0 and n % 64 == 0 and n > 0, f'flush not on cache lines: {addr:#x} {n:#x}')
        self.flushes.append((addr, n))
        self._ret()

    def _execute(self, uc, a, s, u):
        # The encoder: Execute returns. Scratch registers get junk.
        for r in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R12):
            uc.reg_write(r, 0xDEAD0000 | r)
        self.execute_calls += 1
        self._ret(0x0E5EC0DE)

    def _assert(self, uc, a, s, u):
        if uc.reg_read(UC_ARM_REG_R0) == 0:
            self.asserts += 1
        self._ret()

    def _seek(self, uc, a, s, u):
        self.pos = uc.reg_read(UC_ARM_REG_R2)
        self.file_ops.append(('seek', self.pos))
        self._ret(1)

    def _write(self, uc, a, s, u):
        addr, n = uc.reg_read(UC_ARM_REG_R2), uc.reg_read(UC_ARM_REG_R3)
        data = bytes(uc.mem_read(addr, n))
        if len(self.file) < self.pos + n:
            self.file.extend(b'\0' * (self.pos + n - len(self.file)))
        self.file[self.pos:self.pos + n] = data
        self.file_ops.append(('write', addr, n))
        self.pos += n
        self._ret(1)

    def _block(self, uc, a, size, u):
        if self.counting:
            self.insns += size // 4

    def _memw(self, uc, access, addr, size, value, u):
        if not self.watch:
            return
        pc = uc.reg_read(UC_ARM_REG_PC)
        if not (self.module <= pc < self.module_end or self.stubs[0] <= pc < self.stubs[1]):
            return
        if STACK <= addr < STACK_TOP:
            return
        if addr == self.t['stateWord'] and size == 4:
            return
        for p, n in self.live.items():
            if p <= addr and addr + size <= p + n:
                return
        self.bad_writes.append((pc, addr, size))

    # ---- calls
    def call(self, fn, *args):
        uc = self.uc
        regs = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3]
        for r, v in zip(regs, args):
            uc.reg_write(r, v)
        for i, r in enumerate(CALLEE[:-1]):
            uc.reg_write(r, 0x1110 + i)
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP)
        uc.reg_write(UC_ARM_REG_LR, STOP)
        try:
            uc.emu_start(fn, STOP, timeout=0, count=0)
        except UcError as e:
            raise Fail(f'emulation stopped at {uc.reg_read(UC_ARM_REG_PC):#x}: {e}')
        for i, r in enumerate(CALLEE[:-1]):
            check(uc.reg_read(r) == 0x1110 + i, f'register r{4 + i} not kept by {fn:#x}')
        check(uc.reg_read(UC_ARM_REG_SP) == STACK_TOP, f'sp not kept by {fn:#x}')
        return uc.reg_read(UC_ARM_REG_R0)

    def w32(self, a, v):
        self.uc.mem_write(a, struct.pack('<I', v & 0xFFFFFFFF))

    def r32(self, a):
        return struct.unpack('<I', self.uc.mem_read(a, 4))[0]

    def state(self):
        return self.r32(self.t['stateWord'])


def split_camera_jpeg(b):
    """Camera header (SOI..APP7) and main stream (DQT..EOI)."""
    i = 2
    while b[i + 1] != 0xDB:
        i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    end = b.rfind(b'\xff\xd9') + 2
    return b[:i], b[i:end]


def picture(m, at, y, kind=1, packed=False):
    """A picture descriptor at `at` with the Y plane (and a grey CbCr plane) placed after it."""
    h, w = y.shape
    stride = w if packed else (w + 63) & ~63
    yp = (at + 0x40 + 63) & ~63
    cp = (yp + stride * h + 63) & ~63
    plane = np.zeros((h, stride), np.uint8)
    plane[:, :w] = y
    m.uc.mem_write(yp, plane.tobytes())
    m.uc.mem_write(cp, bytes([128]) * (stride * h))
    m.uc.mem_write(at, struct.pack('<BBBBIIIHHHHHH4s', kind, 0, 0, 0, yp, cp, stride * h, w, h, stride, h, 0, 0, b'\0' * 4))
    return cp + stride * h


def run_execute(m, y, stream, stream_at=STREAM, desc_slot=0x4C, packed=False):
    """Execute on a configuration with the photo's picture and main stream."""
    cfg, msg, desc = DATA + 0x1000, DATA + 0x2000, DATA + 0x3000
    m.uc.mem_write(cfg, b'\0' * 0x100)
    m.uc.mem_write(desc, b'\0' * 0x100)
    end = picture(m, PLANES, y, packed=packed)
    pv = (end + 0x1000) & ~0xFFF
    pv_y = np.full((480, 720), 100, np.uint8)
    pv_end = picture(m, pv, pv_y)
    th = (pv_end + 0x1000) & ~0xFFF
    picture(m, th, np.full((120, 160), 100, np.uint8))
    m.w32(cfg + 0x3C, PLANES)
    m.w32(cfg + 0x40, pv)
    m.w32(cfg + 0x44, th)
    m.w32(cfg + 0x48, 0)
    m.uc.mem_write(stream_at, stream)
    pvs = b'\xff\xdb\0\x43' + bytes(65)
    m.uc.mem_write(PREVIEW, pvs)
    for k, slot in enumerate((0x4C, 0x50, 0x54, 0x58)):
        d = desc + 0x20 * k
        if slot == desc_slot:
            m.w32(d, stream_at); m.w32(d + 12, len(stream))
        elif slot in (0x50, 0x54):
            m.w32(d, PREVIEW); m.w32(d + 12, len(pvs))
        else:
            continue
        m.w32(cfg + slot, d)
    m.w32(msg + 8, cfg)
    m.execute_calls = 0
    r = m.call(JPEG_EXECUTE, DATA + 0x5000, msg, 0x2222, 0x3333)
    check(r == 0x0E5EC0DE, 'Execute\'s return value not kept')
    check(m.execute_calls == 1, 'Execute body not run exactly once')


def write_file(m, header, stream, stream_at=STREAM, segmented=False):
    """The camera's generic JPEG write with an ExifJpegWriter holding header and main stream
    (`segmented`: the variant that writes each block in pieces of 4 KB with a pause between)."""
    w, info, f, fvt = DATA + 0x8000, DATA + 0x8200, DATA + 0x8400, DATA + 0x8600
    m.uc.mem_write(w, b'\0' * 0x100)
    m.w32(w, 0x53FDDE18)
    m.w32(w + 0x10, info)
    m.w32(info + 4, 0x77)
    m.w32(w + 0x14, f)
    m.w32(f, fvt)
    m.w32(fvt + 0x14, WRITE_FN)
    m.w32(fvt + 0x18, SEEK_FN)
    m.uc.mem_write(HEADER, header)
    m.uc.mem_write(stream_at, stream)
    for i, v in enumerate((0, HEADER, len(header), len(header), stream_at, len(stream))):
        m.w32(w + 0x54 + 4 * i, v)
    m.file = bytearray()
    m.file_ops = []
    m.asserts = 0
    if segmented:
        m.uc.mem_write(SEGMENTED, struct.pack('<BBBBII', 1, 0, 0, 0, 4096, 1))
    r = m.call(WRITE_SEGMENTED if segmented else WRITE, w)
    m.uc.mem_write(SEGMENTED, b'\0' * 12)
    check(r == 1, 'write failed')
    check(m.asserts == 0, 'an assertion of the writer failed')
    return bytes(m.file)


def strip_diag(b):
    """The file without the diagnostics segment (its counters change from file to file)."""
    for m, i, payload in segments(b):
        if m == 0xEF and payload.startswith(b'GRMODHDR'):
            return b[:i] + b[i + 4 + len(payload):]
    return b


def segments(b):
    out, i = [], 2
    while i + 4 <= len(b) and b[i] == 0xFF and b[i + 1] != 0xDA:
        n = struct.unpack('>H', b[i + 2:i + 4])[0]
        out.append((b[i + 1], i, b[i + 4:i + 2 + n]))
        i += 2 + n
    return out


def check_file(m, data, header, stream, gm, diag):
    t = m.t
    H, M = len(header), len(stream)
    check(data[:H] == header, 'camera header changed')
    segs = segments(data)
    ins = [s for s in segs if s[1] >= H]
    kinds = [s[0] for s in ins]
    want = [0xE1, 0xE2, 0xE2] + ([0xEF] if diag else []) + [0xDB]
    check(kinds[:len(want)] == want, f'inserted segments {kinds[:len(want)]}')
    xmp = ins[0][2]
    check(xmp.startswith(b'http://ns.adobe.com/xap/1.0/\0'), 'XMP namespace')
    check(f'Item:Length="{len(gm)}"'.encode() in xmp, 'XMP gain map length')
    check(ins[1][2] == bytes.fromhex(t['iso'])[4:], 'ISO version segment')
    mpf = ins[2][2]
    check(mpf[:4] == b'MPF\0', 'MPF')
    seg_end = ins[len(want) - 1][1]  # DQT = start of the camera's main stream
    S = seg_end - H
    check(data[H + S:H + S + M] == stream, 'main stream changed')
    check(data[H + S + M:] == gm, 'gain map at the end')
    tiff = ins[2][1] + 8
    count = struct.unpack('>I', mpf[4 + 30:4 + 34])[0]
    check(count == 2, 'MPF: two pictures')
    e1 = struct.unpack('>IIIHH', mpf[4 + 50:4 + 66])
    e2 = struct.unpack('>IIIHH', mpf[4 + 66:4 + 82])
    check(e1 == (0x30000, H + S + M, 0, 0, 0), f'MPF primary {e1}')
    check(e2[1] == len(gm) and tiff + e2[2] == H + S + M, f'MPF gain map {e2}')
    return S


def decode_check(data, sdr_y):
    import imagecodecs
    hdr = imagecodecs.ultrahdr_decode(data).astype(np.float32)[..., :3]
    lum = hdr.mean(axis=2)
    sdr = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'), np.float32) / 255
    lin = np.where(sdr <= 0.04045, sdr / 12.92, ((sdr + 0.055) / 1.055) ** 2.4).mean(axis=2)
    bright = sdr_y > 245
    dark = sdr_y < 100
    ratio_b = float(np.median(lum[bright] / np.maximum(lin[bright], 1e-4))) if bright.any() else None
    ratio_d = float(np.median(lum[dark] / np.maximum(lin[dark], 1e-4))) if dark.any() else None
    return ratio_b, ratio_d


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    full = '--full' in sys.argv
    outdir = None
    if '--out' in sys.argv:
        outdir = sys.argv[sys.argv.index('--out') + 1]
        args.remove(outdir)
    rtos = open(args[0], 'rb').read()
    t = json.load(open(args[1]))
    photos = args[2:]
    magic = rtos.find(struct.pack('<I', 0x31524448), 0x01000000)
    while magic > 0 and magic % 4:
        magic = rtos.find(struct.pack('<I', 0x31524448), magic + 1)
    check(magic > 0, 'no gain map context in the image')
    ctx = magic - 20 * 4
    t['diag'] = bool(struct.unpack('<I', rtos[ctx + 19 * 4:ctx + 20 * 4])[0] & 1)
    m = Machine(rtos, t)
    # stubs: the words the vtable slots point at and the JPEG entry's branch target, give or take
    vt = t['vtable']
    stubs = [m.r32(vt + 36), m.r32(vt + 40)]
    w = m.r32(JPEG_EXECUTE)
    stubs.append(JPEG_EXECUTE + 8 + (((w & 0xFFFFFF) ^ 0x800000) - 0x800000) * 4)
    m.stubs = (min(stubs) - 0x100, max(stubs) + 0x100)
    results = []
    seen_gm = {}
    for path in photos:
        b = open(path, 'rb').read()
        header, stream = split_camera_jpeg(b)
        im = Image.open(path)
        y = np.asarray(im.convert('YCbCr'), np.uint8)[..., 0].copy()
        name = os.path.basename(path)
        m.counting = full
        m.insns = 0
        run_execute(m, y, stream)
        m.counting = False
        st = m.state()
        check(HEAP <= st < HEAP_END, 'no state')
        # the newest entry
        e_off = 16
        entries = []
        for i in range(8):
            used, seq, fp, dims, gmp, gml, pins = struct.unpack('<8I', m.uc.mem_read(st + e_off + 32 * i, 32))[:7]
            if used:
                entries.append((seq, fp, dims, gmp, gml, pins))
        check(entries, 'no gain map kept')
        seq, fp, dims, gmp, gml, pins = max(entries)
        check(dims == (y.shape[1] | y.shape[0] << 16), 'kept size')
        gm_mod = bytes(m.uc.mem_read(gmp, gml))
        gmap = ref.gain_map(y, t['code'])
        gm_ref = ref.encode(gmap, t)
        check(gm_mod == gm_ref, f'{name}: gain map differs from the reference ({len(gm_mod)} vs {len(gm_ref)} bytes)')
        flushed = sum(n for _, n in m.flushes)
        m.flushes = []
        data = write_file(m, header, stream)
        diag = t['diag']
        S = check_file(m, data, header, stream, gm_mod, diag)
        seg = write_file(m, header, stream, segmented=True)
        check(strip_diag(seg) == strip_diag(data) and len(m.file_ops) > 8, 'segmented write: same file')
        rb, rd = decode_check(data, y)
        results.append(dict(photo=name, size=list(y.shape[::-1]), gainmap=list(gmap.shape[::-1]), gm_bytes=len(gm_mod), inserted=S,
                            insns=m.insns if full else None, highlights_x=rb, shadows_x=rd, flushed=flushed))
        seen_gm[name] = gm_mod
        if outdir:
            os.makedirs(outdir, exist_ok=True)
            open(os.path.join(outdir, name.replace('.JPG', '_HDR.JPG')), 'wb').write(data)
        print(json.dumps(results[-1]))

    # ---- a stream that has no gain map: the camera's two blocks (three with diagnostics)
    other = bytearray(stream)
    other[5000] ^= 0x55
    data = write_file(m, header, bytes(other))
    if t['diag']:
        segs = segments(data)
        check([s[0] for s in segs if s[1] >= len(header)][:2] == [0xEF, 0xDB], 'unknown stream: diagnostics then the stream')
        check(data[:len(header)] == header and data.endswith(bytes(other)), 'unknown stream: file')
    else:
        check(data == header + bytes(other), 'unknown stream: the camera\'s file')
    # ---- odd blocks: header that is not SOI + APPn, stream too short
    bad = bytearray(header)
    bad[3] = 0xDB
    data = write_file(m, bytes(bad), stream)
    check(data == bytes(bad) + stream, 'odd header: the camera\'s file')
    data = write_file(m, header, stream[:8000] + b'\xff\xd9')
    check(data == header + stream[:8000] + b'\xff\xd9', 'short stream: the camera\'s file')
    print('fallbacks ok')

    # ---- small pictures: burst, pin, memory, writes watched
    rng = np.random.default_rng(1)
    m.watch = True
    smalls = []
    for k in range(11):
        hgt, wid = 597 + k, 901 + 3 * k              # sizes not multiples of 4 or 8
        yy = (np.clip(rng.normal(150, 60, (hgt, wid)), 0, 255)).astype(np.uint8)
        yy[:, : wid // 3] = 255                     # clipped highlights
        buf = io.BytesIO()
        Image.fromarray(yy, 'L').save(buf, 'JPEG', quality=90)
        jb = buf.getvalue()
        i = jb.find(b'\xff\xdb')
        s2 = jb[i:]
        smalls.append((yy, s2))
        run_execute(m, yy, s2, stream_at=STREAM2, packed=(k == 3), desc_slot=(0x58 if k == 4 else 0x4C))
        if k in (3, 4):
            g = ref.encode(ref.gain_map(yy, t['code']), t)
            st = m.state()
            es = [struct.unpack('<8I', m.uc.mem_read(st + 16 + 32 * i, 32)) for i in range(8)]
            e = max(x for x in es if x[0])
            check(bytes(m.uc.mem_read(e[4], e[5])) == g, f'small picture {k}: gain map differs from the reference')
        if k == 0:
            first = write_file(m, header, s2, stream_at=STREAM2)
            check(first[-2:] == b'\xff\xd9' and len(first) > len(header) + len(s2) + 1000, 'small: gain map written')
            # the writer object keeps pinning picture 0 (same writer address, same blocks)
    st = m.state()
    used = [struct.unpack('<8I', m.uc.mem_read(st + 16 + 32 * i, 32)) for i in range(8)]
    check(all(u[0] for u in used), 'eight kept')
    # picture 0 was pinned by the writer, so it is still there; picture 1..3 were given up
    dims0 = smalls[0][0].shape[1] | smalls[0][0].shape[0] << 16
    check(any(u[3] == dims0 for u in used), 'pinned gain map given up')
    again = write_file(m, header, smalls[0][1], stream_at=STREAM2)
    check(strip_diag(again) == strip_diag(first), 'pinned picture written again: same file')
    dims1 = smalls[1][0].shape[1] | smalls[1][0].shape[0] << 16
    check(not any(u[3] == dims1 for u in used), 'oldest unpinned kept')
    lost = write_file(m, header, smalls[1][1], stream_at=STREAM2)
    check(len(lost) < len(header) + len(smalls[1][1]) + 400, 'given-up picture: no gain map')
    newest = write_file(m, header, smalls[10][1], stream_at=STREAM2)
    check(len(newest) > len(header) + len(smalls[10][1]) + 1000, 'newest: gain map')
    # once the writer has gone on to another file, the next picture gives that gain map up
    live = len(m.live)
    write_file(m, header, smalls[1][1], stream_at=STREAM2)
    yy9, s9 = smalls[9]
    s9 = bytearray(s9); s9[2000] ^= 1; s9 = bytes(s9)
    run_execute(m, yy9, s9, stream_at=STREAM2)
    st = m.state()
    kept = [struct.unpack('<8I', m.uc.mem_read(st + 16 + 32 * i, 32)) for i in range(8)]
    dims10 = smalls[10][0].shape[1] | smalls[10][0].shape[0] << 16
    check(not any(u[0] and u[3] == dims10 for u in kept), 'written gain map given up at the next picture')
    check(not any(u[0] and u[3] == dims0 for u in kept), 'picture 0 (written, then the writer went on) given up')
    check(len(m.live) == live - 1, 'heap blocks: two given up, one new')
    check(not m.bad_writes, f'writes outside the module\'s memory: {m.bad_writes[:5]}')
    # memory runs out: nothing kept for this picture, the camera's file
    m.alloc_limit = 4096
    yy, s3 = smalls[5]
    s3 = bytearray(s3); s3[3000] ^= 1; s3 = bytes(s3)
    run_execute(m, yy, s3, stream_at=STREAM2)
    m.alloc_limit = None
    plain = write_file(m, header, s3, stream_at=STREAM2)
    check(len(plain) < len(header) + len(s3) + 400, 'out of memory: no gain map')
    check(not m.bad_writes, f'writes outside the module\'s memory: {m.bad_writes[:5]}')
    # no picture of the stream's size: nothing kept
    run_execute(m, smalls[2][0][:-8], smalls[2][1], stream_at=STREAM2)
    # large, detailed gain maps: at most 1 MB of them kept, the newest always
    m.watch = False
    for k in range(4):
        big = np.clip(rng.normal(205, 45, (2400, 3600)), 0, 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(big, 'L').save(buf, 'JPEG', quality=80)
        jb = buf.getvalue()
        run_execute(m, big, jb[jb.find(b'\xff\xdb'):], stream_at=STREAM2)
        st = m.state()
        es = [struct.unpack('<8I', m.uc.mem_read(st + 16 + 32 * i, 32)) for i in range(8)]
        held = sum(e[5] for e in es if e[0])
        newest = max(e for e in es if e[0])
        check(held <= 1024 * 1024, f'kept {held} bytes of gain maps')
        check(newest[3] == (3600 | 2400 << 16) and newest[5] > 150000, f'large gain map {newest[5]} bytes kept')
    print('burst, pin, memory, 1 MB ok; heap blocks live:', len(m.live))
    print(json.dumps({'ok': True, 'photos': results}))


if __name__ == '__main__':
    try:
        main()
    except Fail as e:
        print('FAIL:', e)
        sys.exit(1)
