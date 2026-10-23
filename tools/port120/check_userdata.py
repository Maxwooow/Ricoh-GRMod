# SPDX-License-Identifier: GPL-2.0-only
"""Which bytes of the user-settings structure does the firmware never set? (development tool)

GR Mod keeps two settings in bytes of the user-settings structure that have no field: soft focus
(0x90F, softfocus.ts) and the date imprint (0x94B, datestamp.ts). They are alignment padding,
which the factory-defaults initialiser (UserDataInitValue, 0x535278D8 in 1.11) never writes; the
structure is saved, loaded and copied to and from U1-U3 as a whole, so such a byte keeps its value
and is 0 after a settings reset.

The initialiser fills 30 default records of the structure, one after the other (stride: the size
rounded up to a word). This runs it in Unicorn on the official RTOS image of 1.11 and of 1.20,
whose structure is longer (0xB44 bytes instead of 0xAE9, the new settings at its end), and compares
the offsets that no record has written: they must be the same in both, the two bytes among them.

    python3 check_userdata.py
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwimage  # noqa: E402
import fwtarget  # noqa: E402

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_MEM_WRITE, UC_HOOK_INTR  # noqa: E402
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC  # noqa: E402

INIT = 0x535278D8   # UserDataInitValue (1.11)
RECORDS = 30
STACK = 0x600F0000
USED = {0x90F: 'soft focus (softfocus.ts)', 0x94B: 'date imprint (datestamp.ts)'}


def written(tag):
    """The target and every RAM byte the initialiser writes."""
    rtos = fwimage.rtos(tag)
    t = fwtarget.select(rtos)
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(fwimage.BASE, (len(rtos) + 0xFFFFF) & ~0xFFFFF)
    mu.mem_write(fwimage.BASE, rtos)
    mu.mem_map(fwimage.RAM_VA, 0x1000000)
    mu.mem_write(fwimage.RAM_VA, rtos[t.ram_src - fwimage.BASE:t.ram_src - fwimage.BASE + t.ram_len])
    mu.mem_map(0x60000000, 0x100000)
    mu.mem_map(0, 0x1000)
    mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xF << 20))
    mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
    out = set()

    def write(uc, access, address, size, value, _):
        if fwimage.RAM_VA <= address < fwimage.RAM_VA + 0x1000000:
            out.update(range(address, address + size))
    mu.hook_add(UC_HOOK_MEM_WRITE, write)
    mu.hook_add(UC_HOOK_INTR, lambda uc, no, _: uc.emu_stop())
    mu.reg_write(UC_ARM_REG_SP, STACK)
    mu.reg_write(UC_ARM_REG_LR, 0x100)
    fn = fwtarget.V(INIT)
    mu.emu_start(fn, 0x100, count=20_000_000)
    if mu.reg_read(UC_ARM_REG_PC) != 0x100:
        raise SystemExit(f'{tag}: the initialiser at {fn:#x} did not return')
    return t, fn, out


def main():
    results = {}
    failures = []
    for tag in ('111', '120'):
        t, fn, out = written(tag)
        size, stride = t.user_data_size, (t.user_data_size + 3) & ~3
        base = min(out)
        if max(out) >= base + RECORDS * stride:
            failures.append(f'{tag}: writes beyond {RECORDS} records of {stride:#x} bytes from {base:#x} (last {max(out):#x})')
        per_record = [{o for o in range(stride) if base + k * stride + o in out} for k in range(RECORDS)]
        if any(not r for r in per_record):
            failures.append(f'{tag}: a record without writes')
        if any(o >= size for r in per_record for o in r):
            failures.append(f'{tag}: a write past the structure ({size:#x} bytes) in its alignment')
        never = [o for o in range(size) if not any(o in r for r in per_record)]
        results[tag] = never
        print(f'{tag}: UserDataInitValue at {fn:#x}, {RECORDS} records of {size:#x} bytes from {base:#x}; '
              f'{len(never)} offsets never written: {" ".join("%x" % o for o in never)}')
        for o, what in USED.items():
            if o not in never:
                failures.append(f'{tag}: {o:#x} ({what}) is written by the initialiser')
    if results['111'] != results['120']:
        only = sorted(set(results['111']) ^ set(results['120']))
        failures.append('the offsets never written differ: ' + ' '.join('%x' % o for o in only))
    else:
        print(f'the same {len(results["111"])} offsets in both, ' + ', '.join(f'{o:#x} ({w})' for o, w in USED.items()) + ' among them')
    print('FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
