# SPDX-License-Identifier: GPL-2.0-only
"""Playback magnification of photos in added ratios: the decode buffer (build revision 2).

  python3 playback_check.py FILE

To magnify a photo the camera decodes the whole JPEG (PlayJob CreateMainImage, 0x536a1d3c). This
runs that function of the firmware in the emulator, with the camera's services replaced by
stand-ins, for every photo size of the four factory ratios and of the ratios added to FILE:

  - on the official firmware, where a height that is not a multiple of 8 makes the JPEG decode step
    give up with result 3 before anything is decoded (the reason this check exists);
  - on FILE, where every size must reach the decode request, with a buffer at least as large as
    the decoder asks for, and where the factory sizes must behave exactly as on the official one.

Really executed: 0x536a1d3c, 0x536a1ccc, ImageMemory::Alloc 0x5369ec58 (and the code FILE adds
behind its size call), 0x536a174c / 0x536a17a4, ConvertToYcc 0x536bf248 / 0x536bf008, the stride
rule 0x536be2c8 and DecodeJpeg 0x536bedcc with its size check. Replaced: the memory pool, reading
the file, the JPEG header probe (it reports the photo's size and 4:2:2) and the decode request.
"""
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED, UcError
from unicorn.arm_const import (UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_R0, UC_ARM_REG_SP)

import common
from gr4_editor.firmware import _load_bytes
from gr4_editor.crops import read_crops

BASE = 0x53000000
OFFICIAL_LENGTH = 0x13D2AC0
DATA = (0x5437B640, 0x55000000, 0x57480)   # start-up copy: source, destination, length
STACK_TOP = 0x7FF00000
HEAP = 0x60000000
RETURN = 0x7F000000

CREATE_MAIN_IMAGE = 0x536A1D3C
ALLOC_SIZE_CALL = 0x5369ECE8
CALC_IMAGE_BUFFER_SIZE = 0x53696AA4
REPORT = 0x538EE49C       # (condition, expression, file, line, function, format, ...)
ASSERT = 0x538ED930


class Emu:
    def __init__(self, image):
        uc = self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        uc.mem_map(BASE, 0x2000000)
        uc.mem_write(BASE, bytes(image))
        uc.mem_map(DATA[1], 0x1000000)
        uc.mem_write(DATA[1], bytes(image[DATA[0] - BASE:DATA[0] - BASE + DATA[2]]))
        uc.mem_map(STACK_TOP - 0x200000, 0x200000)
        uc.mem_map(HEAP, 0x1000000)
        uc.mem_map(RETURN & ~0xFFF, 0x1000)
        uc.reg_write(UC_ARM_REG_C1_C0_2, uc.reg_read(UC_ARM_REG_C1_C0_2) | (0xF << 20))
        uc.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        uc.hook_add(UC_HOOK_CODE, self._code)
        uc.hook_add(UC_HOOK_MEM_UNMAPPED, self._unmapped)
        self.heap = HEAP + 0x1000
        self.stubs = {}
        self.reports = []
        self.fault = None

    def alloc(self, n):
        self.heap = (self.heap + 15) & ~15
        a = self.heap
        self.heap += max(n, 1)
        return a

    def r32(self, a):
        return struct.unpack('<I', self.uc.mem_read(a, 4))[0]

    def w32(self, a, v):
        self.uc.mem_write(a, struct.pack('<I', v & 0xFFFFFFFF))

    def w16(self, a, v):
        self.uc.mem_write(a, struct.pack('<H', v & 0xFFFF))

    def w8(self, a, v):
        self.uc.mem_write(a, bytes([v & 0xFF]))

    def text(self, a):
        return bytes(self.uc.mem_read(a, 200)).split(b'\0')[0].decode('latin1')

    def reg(self, i):
        return self.uc.reg_read(UC_ARM_REG_R0 + i)

    def stack(self, i):
        return self.r32(self.uc.reg_read(UC_ARM_REG_SP) + 4 * i)

    def _code(self, uc, address, size, user):
        if address == RETURN:
            uc.emu_stop()
            return
        f = self.stubs.get(address)
        if f is not None:
            r = f(self)
            if r is not None:
                uc.reg_write(UC_ARM_REG_R0, r & 0xFFFFFFFF)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def _unmapped(self, uc, access, address, size, value, user):
        self.fault = (address, uc.reg_read(UC_ARM_REG_PC))
        return False

    def call(self, address, *args):
        uc = self.uc
        for i, a in enumerate(args):
            uc.reg_write(UC_ARM_REG_R0 + i, a & 0xFFFFFFFF)
        uc.reg_write(UC_ARM_REG_SP, STACK_TOP - 0x1000)
        uc.reg_write(UC_ARM_REG_LR, RETURN)
        try:
            uc.emu_start(address, RETURN + 4, count=5_000_000)
        except UcError as e:
            raise SystemExit('emulation stopped: %s at pc=%#x, fault %s' % (e, uc.reg_read(UC_ARM_REG_PC), self.fault))
        if uc.reg_read(UC_ARM_REG_PC) != RETURN:
            raise SystemExit('the function did not return (pc=%#x)' % uc.reg_read(UC_ARM_REG_PC))
        return uc.reg_read(UC_ARM_REG_R0)


def create_main_image(image, width, height):
    """-> (result, bytes allocated for the picture, decode request sent, stride width, stride height, failed checks)"""
    e = Emu(image)

    def report(e_):
        if e_.reg(0) == 0:
            fmt = e_.text(e_.stack(1))
            try:
                msg = fmt % tuple(e_.stack(2 + i) for i in range(fmt.count('%')))
            except (TypeError, ValueError):
                msg = fmt
            e_.reports.append('%s:%d %s: %s' % (e_.text(e_.reg(2)), e_.reg(3), e_.text(e_.stack(0)), msg))

    def failed_assert(e_):
        if e_.reg(0) == 0:
            e_.reports.append('ASSERT %s:%d %s' % (e_.text(e_.reg(2)), e_.reg(3), e_.text(e_.reg(1))))

    e.stubs[REPORT] = report
    e.stubs[ASSERT] = failed_assert
    e.stubs[0x53A786C0] = lambda e_: (_ for _ in ()).throw(SystemExit('stack check failed'))
    e.stubs[0x538EC838] = lambda e_: 0          # debug print
    e.stubs[0x538EBBEC] = lambda e_: 0
    e.stubs[0x538E09B0] = lambda e_: e_.alloc(e_.reg(0))   # operator new
    e.stubs[0x538E0A24] = lambda e_: e_.alloc(e_.reg(0))
    e.stubs[0x538E09EC] = lambda e_: 0          # operator delete
    e.stubs[0x538E0A60] = lambda e_: 0

    allocations = []
    pool = [0x70000000]

    def pool_alloc(e_):
        size = e_.reg(1)
        allocations.append(size)
        a = pool[0]
        pool[0] += (size + 0xFFF) & ~0xFFF
        return a

    e.stubs[0x538CECDC] = lambda e_: 0x1234     # the pool
    e.stubs[0x538CF100] = pool_alloc
    e.stubs[0x538CED44] = lambda e_: 0
    manager = e.alloc(0x40)
    e.stubs[0x5369E444] = lambda e_: manager

    def new_image(e_):
        a = e_.alloc(0x20)
        e_.w16(a + 8, 0x10)
        e_.w8(a + 0x1C, 5)
        e_.w8(a + 0x1D, 5)
        return a

    e.stubs[0x5369E850] = new_image
    e.stubs[0x5369E8EC] = lambda e_: 0
    e.stubs[0x53695538] = lambda e_: 0x1000
    e.stubs[0x53695800] = lambda e_: e_.alloc(0x40)
    e.stubs[0x536D8794] = lambda e_: 0          # "is a movie": no

    def read_image(e_):                         # pretend the JPEG file was read
        memory = e_.reg(2)
        e_.w32(memory, 0x71000000)
        e_.w32(memory + 4, 0x800000)
        return 0

    e.stubs[0x536BEAAC] = read_image

    def probe(e_):                              # JPEG header: the photo's size, 4:2:2
        out = e_.reg(3)
        e_.w32(out, width)
        e_.w32(out + 4, height)
        e_.w8(e_.stack(0), 3)
        return 0

    e.stubs[0x536BED28] = probe
    e.stubs[0x5369EED4] = lambda e_: 0
    e.stubs[0x536A0370] = lambda e_: 0
    decoded = []

    def decode(e_):
        decoded.append(True)
        return 1

    e.stubs[0x536A0168] = decode

    job = e.alloc(0x40)
    info = e.alloc(0x200)
    e.w8(info + 0x12, 1)
    e.w8(info + 0x27, 1)
    e.w8(info + 0x2C, 1)
    e.w32(info + 0x30, width)
    e.w32(info + 0x34, height)
    e.w32(info + 0x58, 0x800000)
    e.w8(info + 0x5C, 1)
    picture = new_image(e)
    result = e.call(CREATE_MAIN_IMAGE, job, info, 0, picture)
    return result, allocations[0] if allocations else 0, bool(decoded), e.r32(picture + 0x14), e.r32(picture + 0x18), e.reports


def word(image, address):
    return struct.unpack_from('<I', image, address - BASE)[0]


def branch_target(address, w):
    d = w & 0xFFFFFF
    if d & 0x800000:
        d -= 0x1000000
    return address + 8 + 4 * d


def main():
    image = _load_bytes(open(sys.argv[1], 'rb').read())
    official = common.image()
    new, old = bytes(image.rtos), bytes(official.rtos)
    assert len(old) == OFFICIAL_LENGTH

    # --- what FILE changes in the allocation
    site_old, site_new = word(old, ALLOC_SIZE_CALL), word(new, ALLOC_SIZE_CALL)
    assert branch_target(ALLOC_SIZE_CALL, site_old) == CALC_IMAGE_BUFFER_SIZE and site_old >> 24 == 0xEB
    assert site_new >> 24 == 0xEB, 'the size call is not a call any more'
    stub = branch_target(ALLOC_SIZE_CALL, site_new)
    if stub == CALC_IMAGE_BUFFER_SIZE:
        raise SystemExit('FILE is build revision 1: the decode buffer call is the official one')
    assert stub >= BASE + OFFICIAL_LENGTH, 'the size call does not go to the appended area'
    words = [word(new, stub + 4 * i) for i in range(12)]
    assert branch_target(stub + 36, words[9]) == CALC_IMAGE_BUFFER_SIZE and words[9] >> 24 == 0xEB
    assert words[:9] + words[10:] == [0xE92D4010, 0xE24DD008, 0xE5902000, 0xE5903004, 0xE2833007, 0xE3C33007, 0xE58D2000, 0xE58D3004, 0xE1A0000D,
                                      0xE28DD008, 0xE8BD8010], 'unexpected code behind the size call'
    for a in range(0x5369EC58, 0x5369ED18, 4):
        assert a == ALLOC_SIZE_CALL or word(new, a) == word(old, a), 'ImageMemory::Alloc changed at %#x' % a
    print('size call at %#x -> %#x (12 words: height rounded up to 8 for the byte count only)' % (ALLOC_SIZE_CALL, stub))

    # --- sizes: the factory ratios from the official firmware, the added ones from FILE
    rows, _ = read_crops(image.rtos)
    sizes = []
    for row in rows:
        mine = sorted({(s['width'], s['height']) for s in row['geometry']['photo_sizes'] if s['model'] == 'Kb636'}, reverse=True)
        sizes.append((row['name'], row['identity']['public_id'] >= 4, mine))

    ok = True
    for name, added, mine in sizes:
        for w, h in mine:
            before = create_main_image(old, w, h)
            after = create_main_image(new, w, h)
            need = after[3] * after[4] * 2
            if not added:
                good = before == after and after[0] == 0 and after[2]
                note = 'identical to the official firmware' if before == after else 'DIFFERS from the official firmware'
            else:
                good = after[0] == 0 and after[2] and after[1] >= need and not after[5] and (h % 8 == 0) == (before[0] == 0)
                note = 'official firmware: result %d%s' % (before[0], '' if before[0] == 0 else ' (' + before[5][0].split(': ', 1)[-1] + ')')
            ok &= good
            print('%-4s %-12s %4dx%-4d  result %d, buffer %d >= %d for %dx%d rows, decode request %s;  %s' % (
                'ok' if good else 'FAIL', name, w, h, after[0], after[1], need, after[3], after[4], 'sent' if after[2] else 'NOT sent', note))
    if not ok:
        raise SystemExit('playback decode check FAILED')
    print('playback decode check passed')


if __name__ == '__main__':
    main()
