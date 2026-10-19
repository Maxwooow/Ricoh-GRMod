# SPDX-License-Identifier: GPL-2.0-only
"""Execute the shared developed-frame identity hook, including Cinema remapping.
Usage: python frame_check.py BUILT-RTOS EXTRA_COUNT
"""
import struct
import sys
from pathlib import Path
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_SP


def main():
    data = Path(sys.argv[1]).read_bytes()
    count = int(sys.argv[2])
    base, site, stash = 0x53000000, 0x539113f8, 0x558372e4
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(base, (len(data) + 4095) & ~4095)
    mu.mem_write(base, data)
    mu.mem_map(0x55837000, 4096)
    mu.mem_map(0x70000000, 8192)
    mu.mem_map(0x71000000, 8192)
    mu.hook_add(UC_HOOK_CODE, lambda uc, at, size, _: uc.emu_stop(), begin=site+4, end=site+4)
    for style in (0, 11, 18, 19, 33, 34, 35, 39, 40, 255):
        for level in (0, 1, 2):
            mu.mem_write(0x7000079c, bytes([style]))
            mu.mem_write(0x700007a6, bytes([level]))
            mu.reg_write(UC_ARM_REG_SP, 0x71001000)
            mu.reg_write(UC_ARM_REG_R0, 0x12345678)
            mu.reg_write(UC_ARM_REG_R1, 0x23456789)
            mu.reg_write(UC_ARM_REG_R3, 0x70000000)
            mu.emu_start(site, site+4, count=1000)
            # emu_start's until must not terminate before the branch stub is executed.
            actual = struct.unpack('<I', mu.mem_read(stash, 4))[0]
            assert actual == 0x10000 | style | level << 8, (style, level, hex(actual))
            want = 18 if 34 <= style < 34+count else style
            assert mu.reg_read(UC_ARM_REG_R2) == want
            assert mu.reg_read(UC_ARM_REG_R0) == 0x12345678
            assert mu.reg_read(UC_ARM_REG_R1) == 0x23456789
    print(f'frame identity capture: 30 style/level cases passed, {count} extra slots')


if __name__ == '__main__':
    main()
