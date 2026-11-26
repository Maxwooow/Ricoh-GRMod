# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the GR III / IIIx HDR gain map (core/src/fw/gr3x/hdrgain.ts).

    python3 tools/gr3extras/hdr_check.py RELEASE OFFICIAL.rtos BUILT.rtos TABLES.json [WITHOUT.rtos] [--film K] [--big]

RELEASE is 2.10, 2.20 or 2.21 (GR IIIx 1.60 / 1.70 / 1.71 are the same programs); TABLES.json is
`npx vite-node tools/gr4v120/hdrgain/tables.ts` (GR IV's tables: the GR III build must carry the
same). WITHOUT.rtos: the same build without the gain map. --film K: set the look word to film K
with halation level 2 before each encode (a build with films: the halation module then really runs
before the encoder). --big: also one 6000 x 4000 picture (slow). Development tool.

What runs is the camera's own code of each image, official and built, in Unicorn:
  1. The code the gain map relies on is GR III 2.10's in this release too: JpegEncodeMacroProcess::
     Execute and the 11 ExifJpegWriter methods, the generic write and the write in pieces (shape
     compare: instructions equal up to branch targets and movw/movt values).
  2. A synthetic camera JPEG: a header (SOI, APP1 Exif with a thumbnail-sized payload, APP7 "RICOH"
     whose length runs 2 bytes past the header, over the stream's SOI, as GR IV's camera writes it)
     and a main stream (SOI, DQT .. EOI) encoded from a synthetic YCbCr picture.
  3. The encode step: Execute is called through its vtable slot (as the camera does), with a
     configuration like the camera's (main picture, screennail, thumbnail; output descriptors with
     the main stream at +0x4C). Its body is replaced by a return (the encoder is hardware); in a
     built image whatever chain sits at Execute's entry (halation, date imprint) runs before it,
     our module after it. Order, return value, callee-saved registers and sp are checked.
  4. The write: the camera's generic JPEG write with an ExifJpegWriter holding header and stream;
     its Seek / Write calls make the file. The official image's file is header + stream. The built
     image's file must be the official one byte for byte once the inserted segments (XMP, ISO
     21496-1 version, MPF) and the gain map after the EOI are taken out; the inserted segments
     and the gain map are parsed (Ultra HDR / ISO 21496-1 form, MPF offsets) and the gain map is
     compared with tools/gr4v120/hdrgain/ref.py byte for byte (from the Y plane the encoder got).
  5. Fallbacks, each the official file byte for byte: a stream that was not encoded, a header that
     is not SOI + APPn, a header whose APPn segments end anywhere else, a short stream, no memory.
     The other header form the module accepts (APP7 ending at the header's end, stream from DQT).
  6. Burst: more pictures than gain maps kept, a writer that pins one; every memory write of the
     module and the stubs lands on the stack, its heap blocks or its state word.
"""
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_HOOK_BLOCK
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5,
                               UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11,
                               UC_ARM_REG_R12, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gr4v120', 'hdrgain'))
import ref  # noqa: E402  GR IV's reference of the module (the module is the same code)

BASE = 0x53000000
# Per release: Execute, JpegEncodeMacroProcess's vtable, ExifJpegWriter's vtable, the generic write,
# the write in pieces, the assertion, the pause between pieces, the pieces' setting, operator new /
# delete, the state word; RAM image (source, length). 2.20 / 2.21 from tools/port/addrmap.py.
A = {
    '2.10': dict(execute=0x535047D4, cache=(0x536BBCC0, 0x536BBCAC), pvt=0x53C629E8, wvt=0x53D31258, write=0x535FC588, write2=0x535FC724, assrt=0x536B93D0, pause=0x536B0A74,
                 pieces=0x55357EC4, alloc=0x536AF2A8, free=0x536AF2E4, state=0x55804390, ram=(0x5407B540, 0x3A080), stash=0x55804378),
    '2.20': dict(execute=0x535048C4, cache=(0x536BBDB0, 0x536BBD9C), pvt=0x53C62328, wvt=0x53D30C38, write=0x535FC678, write2=0x535FC814, assrt=0x536B94C0, pause=0x536B0B64,
                 pieces=0x55357EC4, alloc=0x536AF398, free=0x536AF3D4, state=0x55803C50, ram=(0x5407B640, 0x3A0C0), stash=0x55803C38),
    '2.21': dict(execute=0x53507214, cache=(0x536BF338, 0x536BF324), pvt=0x53C6A838, wvt=0x53D39188, write=0x535FF0F0, write2=0x535FF28C, assrt=0x536BCA48, pause=0x536B404C,
                 pieces=0x55358194, alloc=0x536B2880, free=0x536B28BC, state=0x55803F10, ram=(0x54084640, 0x3A300), stash=0x55803EF8),
}
FLUSH = 0x53000930
SLOT_EXECUTE = 10

HEAP, HEAP_END = 0x58000000, 0x5C000000
STACK, STACK_TOP = 0x5E000000, 0x5E0F0000
DATA = 0x5F000000
STOP, SEEK_FN, WRITE_FN = 0x5F0F0000, 0x5F0F0100, 0x5F0F0200
PLANES, STREAM, STREAM2, PREVIEW, HEADER = 0x60000000, 0x68000000, 0x6A000000, 0x6B000000, 0x6B800000
CALLEE = [UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]


class Fail(Exception):
    pass


def check(cond, what):
    if not cond:
        raise Fail(what)


_md = Cs(CS_ARCH_ARM, CS_MODE_ARM)


def shape(img, a, n):
    out = []
    for i in _md.disasm(img[a - BASE:a - BASE + 4 * n], a):
        o = i.op_str
        if i.mnemonic in ('movw', 'movt'):
            o = o.split(',')[0]
        elif i.mnemonic.startswith('b') and o.startswith('#'):
            t = int(o[1:], 16)
            o = 'T+%d' % (t - a) if a <= t < a + 4 * n else 'EXT'
        out.append(i.mnemonic + ' ' + o)
    return out


class Machine:
    def __init__(self, rtos, a, t, stubs=None):
        self.a, self.t = a, t
        self.uc = uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        uc.mem_map(BASE, 0x03000000)
        uc.mem_write(BASE, rtos)
        src, n = a['ram']
        uc.mem_write(0x55000000, rtos[src - BASE:src - BASE + n])
        for at, size in ((HEAP, HEAP_END - HEAP), (STACK, 0x100000), (DATA, 0x100000), (PLANES, 0x08000000), (STREAM, 0x02000000),
                         (STREAM2, 0x01000000), (PREVIEW, 0x800000), (HEADER, 0x100000)):
            uc.mem_map(at, size)
        for f in (STOP, SEEK_FN, WRITE_FN):
            uc.mem_write(f, struct.pack('<I', 0xE12FFF1E))
        self.heap_next, self.live, self.alloc_limit = HEAP, {}, None
        self.file, self.pos, self.asserts, self.events = bytearray(), 0, 0, []
        self.watch, self.bad_writes, self.insns, self.counting = False, [], 0, False
        self.stubs = stubs or (0, 0)
        self.module = None
        uc.hook_add(UC_HOOK_CODE, self._alloc, begin=a['alloc'], end=a['alloc'])
        uc.hook_add(UC_HOOK_CODE, self._free, begin=a['free'], end=a['free'])
        uc.hook_add(UC_HOOK_CODE, self._flush, begin=FLUSH, end=FLUSH)
        # the picture modules' cache calls (flush for reading, clean: system calls on the camera)
        for f in a['cache']:
            uc.hook_add(UC_HOOK_CODE, lambda uc, x, s, u: self._ret(), begin=f, end=f)
        uc.hook_add(UC_HOOK_CODE, self._body, begin=a['execute'] + 4, end=a['execute'] + 4)
        uc.hook_add(UC_HOOK_CODE, self._assert, begin=a['assrt'], end=a['assrt'])
        uc.hook_add(UC_HOOK_CODE, lambda uc, x, s, u: self._ret(), begin=a['pause'], end=a['pause'])
        uc.hook_add(UC_HOOK_CODE, self._seek, begin=SEEK_FN, end=SEEK_FN)
        uc.hook_add(UC_HOOK_CODE, self._write, begin=WRITE_FN, end=WRITE_FN)
        uc.hook_add(UC_HOOK_BLOCK, self._block)
        uc.hook_add(UC_HOOK_MEM_WRITE, self._memw)

    def _ret(self, value=None):
        if value is not None:
            self.uc.reg_write(UC_ARM_REG_R0, value)
        self.uc.reg_write(UC_ARM_REG_PC, self.uc.reg_read(UC_ARM_REG_LR))

    def _alloc(self, uc, x, s, u):
        n = uc.reg_read(UC_ARM_REG_R0)
        if self.alloc_limit is not None and n > self.alloc_limit:
            return self._ret(0)
        p = (self.heap_next + 63) & ~63
        check(p + n < HEAP_END, 'emulated heap exhausted')
        self.heap_next = p + n + 64
        uc.mem_write(p, b'\xa5' * min(n, 4096))
        self.live[p] = n
        self._ret(p)

    def _free(self, uc, x, s, u):
        p = uc.reg_read(UC_ARM_REG_R0)
        check(p in self.live, f'free of a block not allocated: {p:#x}')
        del self.live[p]
        self._ret()

    def _flush(self, uc, x, s, u):
        addr, n = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
        check(addr % 64 == 0 and n % 64 == 0 and n > 0, f'flush not on cache lines: {addr:#x} {n:#x}')
        self._ret()

    def _body(self, uc, x, s, u):
        # The encoder: Execute's body returns at once; the scratch registers get junk.
        self.events.append('body')
        self.body_y = bytes(uc.mem_read(self.y_plane, self.y_size)) if self.y_size else b''
        for r in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R12):
            uc.reg_write(r, 0xDEAD0000 | r)
        self._ret(0x0E5EC0DE)

    def _assert(self, uc, x, s, u):
        if uc.reg_read(UC_ARM_REG_R0) == 0:
            self.asserts += 1
        self._ret()

    def _seek(self, uc, x, s, u):
        self.pos = uc.reg_read(UC_ARM_REG_R2)
        self._ret(1)

    def _write(self, uc, x, s, u):
        addr, n = uc.reg_read(UC_ARM_REG_R2), uc.reg_read(UC_ARM_REG_R3)
        d = bytes(uc.mem_read(addr, n))
        if len(self.file) < self.pos + n:
            self.file.extend(b'\0' * (self.pos + n - len(self.file)))
        self.file[self.pos:self.pos + n] = d
        self.pos += n
        self.writes += 1
        self._ret(1)

    def _block(self, uc, a, size, u):
        if self.module and a == self.module:
            self.events.append('module:%d' % uc.reg_read(UC_ARM_REG_R1))
        if self.counting:
            self.insns += size // 4

    def _memw(self, uc, access, addr, size, value, u):
        if not self.watch:
            return
        pc = uc.reg_read(UC_ARM_REG_PC)
        if not (self.module <= pc < self.module_end or self.stubs[0] <= pc < self.stubs[1]):
            return
        if STACK <= addr < STACK_TOP or (addr == self.a['state'] and size == 4):
            return
        for p, n in self.live.items():
            if p <= addr and addr + size <= p + n:
                return
        self.bad_writes.append((pc, addr, size))

    def call(self, fn, *args):
        uc = self.uc
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3), args):
            uc.reg_write(r, v)
        for i, r in enumerate(CALLEE):
            uc.reg_write(r, 0x1110 + i)
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP)
        uc.reg_write(UC_ARM_REG_LR, STOP)
        try:
            uc.emu_start(fn, STOP)
        except UcError as e:
            raise Fail(f'emulation stopped at {uc.reg_read(UC_ARM_REG_PC):#x}: {e}')
        for i, r in enumerate(CALLEE):
            check(uc.reg_read(r) == 0x1110 + i, f'register r{4 + i} not kept by {fn:#x}')
        check(uc.reg_read(UC_ARM_REG_SP) == STACK_TOP, f'sp not kept by {fn:#x}')
        return uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)

    def w32(self, at, v):
        self.uc.mem_write(at, struct.pack('<I', v & 0xFFFFFFFF))

    def r32(self, at):
        return struct.unpack('<I', self.uc.mem_read(at, 4))[0]


# ---------------------------------------------------------------- a synthetic camera JPEG

def synthetic(w, h, seed):
    """A picture with sky (clipped), a gradient, mid tones and shadows; YCbCr planes (4:2:2 C)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    y = 40 + 180 * (xx / w) + 30 * np.sin(yy / 37.0) + rng.normal(0, 6, (h, w))
    y[: h // 4] = 255                                    # clipped sky
    y[h // 4: h // 3, : w // 2] = 250                    # near-white highlight
    y[-h // 5:, -w // 5:] = 12                           # shadow
    y = np.clip(y, 0, 255).astype(np.uint8)
    cb = np.clip(128 + 20 * np.sin(xx / 53.0), 0, 255).astype(np.uint8)
    cr = np.clip(128 + 20 * np.cos(yy / 41.0), 0, 255).astype(np.uint8)
    return y, cb, cr


def camera_jpeg(y, cb, cr, form=2):
    """(header, stream). The stream: SOI, DQT .. EOI (no JFIF APP0). The header: SOI, APP1 Exif
    (TIFF header and a thumbnail-sized payload), APP7 "RICOH" (maker note, screennail-sized
    payload). Form 2: APP7's length runs 2 bytes past the header, over the stream's SOI (GR IV test
    073); form 1: APP7 ends with the header and the stream starts with DQT."""
    buf = io.BytesIO()
    Image.merge('YCbCr', [Image.fromarray(c) for c in (y, cb, cr)]).save(buf, 'JPEG', quality=93, subsampling=1)
    j = buf.getvalue()
    i = j.find(b'\xff\xdb')
    stream = j[:2] + j[i:]
    rng = np.random.default_rng(7)
    exif = b'Exif\0\0' + b'II*\0\x08\0\0\0' + bytes(6) + rng.integers(0, 256, 9000, np.uint8).tobytes()
    app1 = b'\xff\xe1' + struct.pack('>H', len(exif) + 2) + exif
    note = b'RICOH\0' + rng.integers(0, 256, 30000, np.uint8).tobytes()
    if form == 2:
        app7 = b'\xff\xe7' + struct.pack('>H', len(note) + 2 + 2) + note    # its last two bytes are the stream's SOI
        return b'\xff\xd8' + app1 + app7, stream
    app7 = b'\xff\xe7' + struct.pack('>H', len(note) + 2) + note
    return b'\xff\xd8' + app1 + app7, stream[2:]


def picture(m, at, y, packed=False):
    h, w = y.shape
    stride = w if packed else (w + 63) & ~63
    yp = (at + 0x40 + 63) & ~63
    cp = (yp + stride * h + 63) & ~63
    plane = np.zeros((h, stride), np.uint8)
    plane[:, :w] = y
    m.uc.mem_write(yp, plane.tobytes())
    m.uc.mem_write(cp, bytes([128]) * (stride * h))
    m.uc.mem_write(at, struct.pack('<BBBBIIIHHHHHH4s', 1, 0, 0, 0, yp, cp, stride * h, w, h, stride, h, 0, 0, b'\0' * 4))
    return yp, stride, cp + stride * h


def run_execute(m, y, stream, stream_at=STREAM, desc_slot=0x4C, packed=False):
    """Execute, through its vtable slot, on a configuration with the picture and its main stream.
    Returns the Y plane the encoder got (after the chain at Execute's entry)."""
    cfg, msg, desc, proc = DATA + 0x1000, DATA + 0x2000, DATA + 0x3000, DATA + 0x5000
    m.uc.mem_write(cfg, b'\0' * 0x100)
    m.uc.mem_write(desc, b'\0' * 0x100)
    yp, stride, end = picture(m, PLANES, y, packed)
    m.y_plane, m.y_size = yp, stride * y.shape[0]
    pv = (end + 0x1000) & ~0xFFF
    _, _, pv_end = picture(m, pv, np.full((480, 720), 100, np.uint8))
    th = (pv_end + 0x1000) & ~0xFFF
    picture(m, th, np.full((120, 160), 100, np.uint8))
    m.w32(cfg + 0x3C, PLANES); m.w32(cfg + 0x40, pv); m.w32(cfg + 0x44, th); m.w32(cfg + 0x48, 0)
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
    m.uc.mem_write(proc, b'\0' * 0x100)
    m.w32(proc, m.a['pvt'])
    m.events = []
    fn = m.r32(m.a['pvt'] + 4 * SLOT_EXECUTE)
    r0, r1 = m.call(fn, proc, msg, 0x2222, 0x3333)
    check(r0 == 0x0E5EC0DE, 'Execute\'s return value not kept')
    check(m.events.count('body') == 1, f'Execute\'s body not run exactly once: {m.events}')
    y_enc = np.frombuffer(m.body_y, np.uint8).reshape(y.shape[0], stride)[:, :y.shape[1]]
    return y_enc


def write_file(m, header, stream, stream_at=STREAM, pieces=False):
    """The camera's generic JPEG write (or the write in pieces of 4 KB) with an ExifJpegWriter."""
    w, info, f, fvt = DATA + 0x8000, DATA + 0x8200, DATA + 0x8400, DATA + 0x8600
    m.uc.mem_write(w, b'\0' * 0x100)
    m.w32(w, m.a['wvt']); m.w32(w + 0x10, info); m.w32(info + 4, 0x77); m.w32(w + 0x14, f)
    m.w32(f, fvt); m.w32(fvt + 0x14, WRITE_FN); m.w32(fvt + 0x18, SEEK_FN)
    m.uc.mem_write(HEADER, header)
    m.uc.mem_write(stream_at, stream)
    for i, v in enumerate((0, HEADER, len(header), len(header), stream_at, len(stream))):
        m.w32(w + 0x54 + 4 * i, v)
    m.file, m.pos, m.asserts, m.writes = bytearray(), 0, 0, 0
    if pieces:
        m.uc.mem_write(m.a['pieces'], struct.pack('<BBBBII', 1, 0, 0, 0, 4096, 1))
    r, _ = m.call(m.a['write2'] if pieces else m.a['write'], w)
    m.uc.mem_write(m.a['pieces'], b'\0' * 12)
    check(r == 1, 'write failed')
    check(m.asserts == 0, 'an assertion of the writer failed')
    return bytes(m.file)


# ---------------------------------------------------------------- the file

def segments(b, start=2):
    out, i = [], start
    while i + 4 <= len(b) and b[i] == 0xFF and b[i + 1] not in (0xDA, 0xD8):
        n = struct.unpack('>H', b[i + 2:i + 4])[0]
        out.append((b[i + 1], i, b[i + 4:i + 2 + n]))
        i += 2 + n
    return out


def first_eoi(b, at):
    i = at
    while b[i + 1] != 0xDA:
        i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    while True:
        i = b.index(b'\xff', i)
        if b[i + 1] == 0xD9:
            return i + 2
        i += 2 if b[i + 1] == 0 or 0xD0 <= b[i + 1] <= 0xD7 else 1


def xmp_attrs(payload):
    import re
    return dict(re.findall(rb'([A-Za-z]+:[A-Za-z]+)="([^"]*)"', payload))


def iso_metadata(b):
    """ISO 21496-1 gain map metadata (the form libultrahdr writes, one channel)."""
    minv, wv, flags = struct.unpack('>HHB', b[:5])
    v = struct.unpack('>IIIIiIiIIIiIiI', b[5:5 + 56])
    return dict(min_version=minv, writer_version=wv, flags=flags, base_headroom=v[0] / v[1], alt_headroom=v[2] / v[3],
                gain_min=v[4] / v[5], gain_max=v[6] / v[7], gamma=v[8] / v[9], base_offset=v[10] / v[11], alt_offset=v[12] / v[13])


def check_file(data, camera, header, stream, gm, params, w, h):
    """The built file against the official one: returns the parsed parts."""
    H = len(header)
    p = 2 if stream[:2] == b'\xff\xd8' else 0
    check(data[:H + p] == camera[:H + p], 'camera header (and the SOI that ends APP7) changed')
    ins = segments(data, H + p)
    kinds = [s[0] for s in ins]
    check(kinds[:4] == [0xE1, 0xE2, 0xE2, 0xDB], f'inserted segments {kinds[:4]}')
    S = ins[3][1] - (H + p)
    check(data[:H + p] + data[H + p + S:H + p + S + len(stream) - p] == camera, 'without the inserted segments: not the official file')
    end = H + S + len(stream)
    check(first_eoi(data, H + p + S) == end, 'the primary picture does not end with the camera\'s EOI')
    check(data[end:] == gm, 'the gain map after the EOI is not the one kept')
    # XMP: Google's container, hdrgm:Version, the gain map's length
    xmp = ins[0][2]
    check(xmp.startswith(b'http://ns.adobe.com/xap/1.0/\0'), 'XMP namespace')
    a = xmp_attrs(xmp)
    check(a.get(b'hdrgm:Version') == b'1.0' and a.get(b'Item:Semantic') in (b'Primary', b'GainMap'), 'XMP: hdrgm and the container')
    check(f'Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="{len(gm)}"'.encode() in xmp, 'XMP: the gain map item and its length')
    # ISO 21496-1 version segment: namespace, minimum version 0, writer version 0
    check(ins[1][2] == b'urn:iso:std:iso:ts:21496:-1\0' + bytes(4), 'ISO 21496-1 version segment')
    # MPF: two pictures, the primary at 0, the gain map at its place (offset from the MPF's TIFF header)
    mpf = ins[2][2]
    check(mpf[:8] == b'MPF\0MM\0*', 'MPF header')
    tiff = ins[2][1] + 8
    count = struct.unpack('>I', mpf[4 + 30:4 + 34])[0]
    e1 = struct.unpack('>IIIHH', mpf[4 + 50:4 + 66])
    e2 = struct.unpack('>IIIHH', mpf[4 + 66:4 + 82])
    check(count == 2 and e1 == (0x30000, end, 0, 0, 0), f'MPF primary {count} {e1}')
    check(e2[1] == len(gm) and tiff + e2[2] == end, f'MPF gain map {e2}')
    # the gain map: a greyscale JPEG of a quarter of the size, its XMP (hdrgm) and ISO 21496-1 metadata
    gseg = segments(gm)
    check(gm[:2] == b'\xff\xd8' and gm[-2:] == b'\xff\xd9', 'gain map: SOI .. EOI')
    gx = xmp_attrs(gseg[0][2])
    check(gseg[0][0] == 0xE1 and gx[b'hdrgm:Version'] == b'1.0' and float(gx[b'hdrgm:GainMapMax']) == params['stops'] and float(gx[b'hdrgm:HDRCapacityMax']) == params['stops']
          and gx[b'hdrgm:BaseRenditionIsHDR'] == b'False', f'gain map XMP {gx}')
    check(gseg[1][0] == 0xE2 and gseg[1][2].startswith(b'urn:iso:std:iso:ts:21496:-1\0'), 'gain map: ISO 21496-1 segment')
    iso = iso_metadata(gseg[1][2][28:])
    check(iso['min_version'] == 0 and abs(iso['alt_headroom'] - params['stops']) < 1e-9 and abs(iso['gain_max'] - params['stops']) < 1e-9
          and iso['gain_min'] == 0 and iso['gamma'] == 1 and iso['base_headroom'] == 0, f'ISO 21496-1 metadata {iso}')
    im = Image.open(io.BytesIO(gm))
    im.load()
    check(im.mode == 'L' and im.size == ((w + 3) // 4, (h + 3) // 4), f'gain map picture {im.mode} {im.size}')
    # the primary as a JPEG of its own (what a viewer without HDR shows): the official picture
    prim = Image.open(io.BytesIO(data[:end]))
    prim.load()
    check(prim.size == (w, h), 'primary picture size')
    return dict(inserted=S, gm_bytes=len(gm), gm_size=list(im.size), iso=iso), np.asarray(im)


def kept(m):
    st = m.r32(m.a['state'])
    check(HEAP <= st < HEAP_END, 'no state')
    es = [struct.unpack('<8I', m.uc.mem_read(st + 16 + 32 * i, 32)) for i in range(8)]
    return [e for e in es if e[0]]


def newest_gm(m):
    e = max(kept(m), key=lambda x: x[1])
    return bytes(m.uc.mem_read(e[4], e[5])), e


def main():
    args = [x for x in sys.argv[1:] if not x.startswith('--')]
    film = None
    if '--film' in sys.argv:
        film = int(sys.argv[sys.argv.index('--film') + 1])
        args.remove(str(film))
    big = '--big' in sys.argv
    rel, official, built, tables = args[:4]
    without = args[4] if len(args) > 4 else None
    a = A[rel]
    off = open(official, 'rb').read()
    img = open(built, 'rb').read()
    t = json.load(open(tables))

    # ---- 1. the code relied on is 2.10's (shape), in the official image of this release
    if rel != '2.10':
        d = os.environ.get('GRMOD_RTOS_DIR')
        if not d:
            print('(shape compare against 2.10 left out: GRMOD_RTOS_DIR names the directory of gr3_v210.rtos)')
        else:
            g210 = open(os.path.join(d, 'gr3_v210.rtos'), 'rb').read()
            b = A['2.10']
            check(shape(off, a['execute'], 129) == shape(g210, b['execute'], 129), 'Execute differs from 2.10')
            for k, n in enumerate((19, 9, 76, 38, 11, 85, 89, 29, 41, 23, 2)):   # the methods' lengths (2.10)
                f, f0 = struct.unpack_from('<I', off, a['wvt'] - BASE + 4 * k)[0], struct.unpack_from('<I', g210, b['wvt'] - BASE + 4 * k)[0]
                check(shape(off, f, n) == shape(g210, f0, n), f'writer method {k} differs from 2.10')
            for k in ('write', 'write2'):
                check(shape(off, a[k], 104) == shape(g210, b[k], 104), f'{k} differs from 2.10')
            print('Execute, the 11 writer methods and both writes: 2.10\'s code')
    ex = struct.unpack_from('<I', off, a['pvt'] - BASE + 4 * SLOT_EXECUTE)[0]
    check(ex == a['execute'], 'official: Execute\'s vtable slot')

    # ---- what the build changed inside the official image
    changed = [BASE + i for i in range(0, len(off), 4) if off[i:i + 4] != img[i:i + 4]]
    slots = [a['pvt'] + 4 * SLOT_EXECUTE, a['wvt'] + 36, a['wvt'] + 40]
    for s in slots:
        check(s in changed, f'slot {s:#x} not changed')
    if without:
        base = open(without, 'rb').read()
        def moved(i):
            x, y = struct.unpack_from('<I', base, i)[0], struct.unpack_from('<I', img, i)[0]
            if x >> 25 == y >> 25 == 0x75:   # b / bl, cond al
                tx = BASE + i + 8 + 4 * (((x & 0xFFFFFF) ^ 0x800000) - 0x800000)
                ty = BASE + i + 8 + 4 * (((y & 0xFFFFFF) ^ 0x800000) - 0x800000)
                return min(tx, ty) >= BASE + len(off)
            # movw / movt of the same register (an address in the appended code that moved), or a
            # pointer into the appended code (both values there)
            if x & 0x0FF00000 in (0x03000000, 0x03400000) and x & 0xFFF0F000 == y & 0xFFF0F000:
                return True
            return BASE + len(off) <= min(x, y) and max(x, y) < 0x55000000
        only = [BASE + i for i in range(0, len(off), 4) if base[i:i + 4] != img[i:i + 4] and not moved(i)]
        check(sorted(only) == sorted(slots), f'against the build without: {[hex(x) for x in only]}')
        print('against the build without the gain map: only the three slot words differ inside the official image')

    # ---- the context and tables in the built image (GR IV's, the state word GR III's)
    magic = img.find(struct.pack('<I', 0x31524448), len(off))
    while magic > 0 and magic % 4:
        magic = img.find(struct.pack('<I', 0x31524448), magic + 1)
    check(magic > 0, 'no gain map context in the image')
    ctx = magic - 20 * 4
    cw = struct.unpack_from('<22I', img, ctx)
    rd = lambda at, n: img[at - BASE:at - BASE + n]
    check(cw[0] == FLUSH and cw[1] == a['alloc'] and cw[2] == a['free'] and cw[3] == a['state'], 'context: firmware addresses')
    check(list(rd(cw[4], 256)) == t['code'] and list(rd(cw[5], 64)) == t['zigzag'], 'context: code / zigzag tables')
    check(list(struct.unpack('<64I', rd(cw[6], 256))) == t['recip'] and list(struct.unpack('<64H', rd(cw[7], 128))) == t['half'], 'context: quantiser tables')
    check(list(struct.unpack('<12I', rd(cw[8], 48))) == t['dc'] and list(struct.unpack('<256I', rd(cw[9], 1024))) == t['ac'], 'context: Huffman tables')
    check(rd(cw[10], cw[11]).hex() == t['head'] and cw[12] == t['sof'] and rd(cw[13], cw[14]).hex() == t['xmpPre'] and rd(cw[15], cw[16]).hex() == t['xmpPost']
          and rd(cw[17], cw[18]).hex() == t['iso'], 'context: gain map head, XMP, ISO')
    check(cw[19] == 0 and cw[21] == 0, 'context: no diagnostics, no counters')
    mod = bytes.fromhex(t['module'])
    check(img.find(mod, len(off)) > 0, 'module (GR IV\'s code) not in the image')
    module = BASE + img.find(mod, len(off))
    stubs = sorted([struct.unpack_from('<I', img, s - BASE)[0] for s in slots])
    stub_range = (stubs[0], stubs[-1] + 0x80)
    print(f'context {BASE + ctx:#x}, module {module:#x}, stubs {[hex(s) for s in stubs]}')

    def film_on(m, on=True):
        # film k is look 32 + k in the stash (jpeg-stage.ts), halation level 2; only for the main picture (slow)
        if film is not None:
            m.w32(a['stash'], ((32 + film) | 2 << 8 | 0x10000) if on else 0)

    def machine(image):
        m = Machine(image, a, t, stub_range)
        if image is img:
            m.module, m.module_end = module, module + len(mod)
        return m

    mo, mb = machine(off), machine(img)
    params = t['params']
    w, h = 1504, 1000
    y, cb, cr = synthetic(w, h, 1)
    header, stream = camera_jpeg(y, cb, cr)
    # ---- 3. the encode step
    y_off = run_execute(mo, y, stream)
    check(mo.events == ['body'], f'official: {mo.events}')
    if without:
        # the same build without the gain map: the same chain at Execute's entry
        mw = machine(base)
        film_on(mw)
        y_off = run_execute(mw, y, stream)
        check(mw.events == ['body'], f'without: {mw.events}')
    film_on(mb)
    mb.counting = True
    y_enc = run_execute(mb, y, stream)
    mb.counting = False
    film_on(mb, False)
    ev = mb.events
    check(ev[-2:] == ['body', 'module:1'] and ev.count('module:1') == 1, f'built: the module after the encoder {ev}')
    check(np.array_equal(y_enc, y_off), 'the picture the encoder gets differs from the run without the gain map (or the official run)')
    print(f'encode step: {mb.insns} instructions; chain before the encoder: {"yes, picture changed by it" if not np.array_equal(y_enc, y) else "nothing changed the picture"}')
    gm, e = newest_gm(mb)
    check(e[3] == (w | h << 16), 'kept size')
    gm_ref = ref.encode(ref.gain_map(y_enc, t['code']), t)
    check(gm == gm_ref, f'gain map differs from the reference ({len(gm)} vs {len(gm_ref)} bytes)')
    # ---- 4. the write
    camera = write_file(mo, header, stream)
    check(camera == header + stream, 'official: the file is not header + stream')
    data = write_file(mb, header, stream)
    info, gm_pic = check_file(data, camera, header, stream, gm, params, w, h)
    err = np.abs(gm_pic.astype(int) - ref.gain_map(y_enc, t['code']).astype(int))
    check(err.mean() < 2 and np.percentile(err, 99) <= 16, f'gain map decodes to something else (error mean {err.mean():.2f}, 99% {np.percentile(err, 99)})')
    check(gm_pic[: (h // 4) // 4 - 2].mean() > 200 and gm_pic[-(h // 5) // 4 + 2:, -(w // 5) // 4 + 2:].max() <= 4, f'gain map: sky lifted, shadows not ({gm_pic[: (h // 4) // 4 - 2].mean()}, {gm_pic[-(h // 5) // 4 + 2:, -(w // 5) // 4 + 2:].max()})')
    seg = write_file(mb, header, stream, pieces=True)
    check(seg == data and mb.writes > 8, 'write in pieces: not the same file')
    camera2 = write_file(mo, header, stream, pieces=True)
    check(camera2 == camera, 'official write in pieces')
    print(json.dumps(dict(picture=[w, h], **{k: v for k, v in info.items() if k != 'iso'})))
    print('ISO 21496-1:', json.dumps(info['iso']))
    out = os.environ.get('HDR_CHECK_OUT')
    if out:
        open(os.path.join(out, f'synthetic_{rel}_official.jpg'), 'wb').write(camera)
        open(os.path.join(out, f'synthetic_{rel}_hdr.jpg'), 'wb').write(data)

    # ---- 5. fallbacks: the official file, byte for byte
    other = bytearray(stream); other[5000] ^= 0x55; other = bytes(other)
    check(write_file(mb, header, other) == write_file(mo, header, other), 'stream not encoded: not the official file')
    bad = bytearray(header); bad[3] = 0xDB; bad = bytes(bad)       # APP1 marker made DQT
    check(write_file(mb, bad, stream) == bad + stream, 'header not SOI + APPn: not the official file')
    for shift in (1, 4, -1, -4):                                        # APP7 ending elsewhere
        hb = bytearray(header)
        i = segments(header)[-1][1]
        n = struct.unpack('>H', hb[i + 2:i + 4])[0] + shift
        hb[i + 2:i + 4] = struct.pack('>H', n)
        hb = bytes(hb)
        check(write_file(mb, hb, stream) == hb + stream, f'APP7 ending {shift} bytes elsewhere: not the official file')
    short = stream[:8000] + b'\xff\xd9'
    check(write_file(mb, header, short) == header + short, 'short stream: not the official file')
    # the other form the module accepts: APP7 ends with the header, the stream starts with DQT
    h1, s1 = camera_jpeg(y, cb, cr, form=1)
    run_execute(mb, y, s1)
    gm1, _ = newest_gm(mb)
    d1 = write_file(mb, h1, s1)
    check_file(d1, h1 + s1, h1, s1, gm1, params, w, h)
    print('fallbacks ok (stream not encoded, odd headers, short stream: the official file; header form 1: gain map)')

    # ---- 6. burst, pins, memory, writes watched (small pictures)
    m = machine(img)
    m.watch = True
    smalls = []
    for k in range(11):
        hh, ww = 597 + k, 901 + 3 * k
        yy, cbb, crr = synthetic(ww, hh, 10 + k)
        hdr_k, s_k = camera_jpeg(yy, cbb, crr)
        smalls.append((yy, hdr_k, s_k))
        ye = run_execute(m, yy, s_k, stream_at=STREAM2, packed=(k == 3), desc_slot=(0x58 if k == 4 else 0x4C))
        if k in (3, 4):
            check(newest_gm(m)[0] == ref.encode(ref.gain_map(ye, t['code']), t), f'small picture {k}: gain map differs from the reference')
        if k == 0:
            first = write_file(m, hdr_k, s_k, stream_at=STREAM2)
            check(len(first) > len(hdr_k) + len(s_k) + 1000, 'small: gain map written')
    used = kept(m)
    check(len(used) == 8, 'eight kept')
    dims = lambda k: smalls[k][0].shape[1] | smalls[k][0].shape[0] << 16
    check(any(u[3] == dims(0) for u in used), 'pinned gain map given up')
    check(write_file(m, smalls[0][1], smalls[0][2], stream_at=STREAM2) == first, 'pinned picture written again: same file')
    check(not any(u[3] == dims(1) for u in used), 'oldest unpinned kept')
    lost = write_file(m, smalls[1][1], smalls[1][2], stream_at=STREAM2)
    check(lost == smalls[1][1] + smalls[1][2], 'given-up picture: the official file')
    newest = write_file(m, smalls[10][1], smalls[10][2], stream_at=STREAM2)
    check(len(newest) > len(smalls[10][1]) + len(smalls[10][2]) + 1000, 'newest: gain map')
    check(not m.bad_writes, f'writes outside the module\'s memory: {m.bad_writes[:5]}')
    m.alloc_limit = 4096
    yy, h5, s5 = smalls[5]
    s5 = bytearray(s5); s5[3000] ^= 1; s5 = bytes(s5)
    run_execute(m, yy, s5, stream_at=STREAM2)
    m.alloc_limit = None
    check(write_file(m, h5, s5, stream_at=STREAM2) == h5 + s5, 'memory ran out: not the official file')
    m2 = machine(img)
    m2.alloc_limit = 0
    run_execute(m2, yy, s5, stream_at=STREAM2)
    check(m2.r32(a['state']) == 0 and write_file(m2, h5, s5, stream_at=STREAM2) == h5 + s5, 'no memory at all: not the official file')
    print('burst, pins, memory, writes ok')

    if big:
        w, h = 6000, 4000
        y, cb, cr = synthetic(w, h, 3)
        header, stream = camera_jpeg(y, cb, cr)
        mb.counting, mb.insns = True, 0
        y_enc = run_execute(mb, y, stream)
        mb.counting = False
        gm, _ = newest_gm(mb)
        check(gm == ref.encode(ref.gain_map(y_enc, t['code']), t), '6000 x 4000: gain map differs from the reference')
        camera = write_file(mo, header, stream)
        info, _ = check_file(write_file(mb, header, stream), camera, header, stream, gm, params, w, h)
        print(f'6000 x 4000: {mb.insns} instructions in the encode step; {json.dumps({k: v for k, v in info.items() if k != "iso"})}')
    print(f'{rel}: ok')


if __name__ == '__main__':
    try:
        main()
    except Fail as e:
        print('FAIL:', e)
        sys.exit(1)
