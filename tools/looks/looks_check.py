# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the Image Control menu order and hidden looks (core/src/fw/aspect/looks.ts,
the visibility hook of slots.ts and the settings guard of guard.ts).

NOT part of the program. Runs the camera's own code of a built RTOS image, and of the official one,
in Unicorn (with tools/datestamp/menu_check.py's emulator):

 1. The Image Control list (constructor 0x533CC890 -> builder 0x533CC784) and the ADJ / RAW
    development list (builder 0x533755BC, which adds the three custom sets after the looks), for
    the GR IV / HDF and the GR IV Monochrome (SpecModel stubbed), with and without the "conditional"
    looks' flag: the list is the layout's order without hidden looks, each look otherwise visible
    exactly when it is in the reference image's list.
 2. The settings guard's fix (load, power-off save, user-mode recall) on the standard and custom
    sets' looks: a hidden look selected in the standard photo / movie set becomes Standard (11, or
    25 for the monochrome looks 25..30); the custom sets' looks, and visible looks, are kept.

    python3 looks_check.py BUILT.rtos REFERENCE.rtos 'ORDER' 'HIDDEN'

REFERENCE: the same build without the layout (or the official image when the build has nothing
else that changes the lists); ORDER / HIDDEN: comma-separated style numbers, as given to the build.
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as mc  # noqa: E402

failures = []


def check(cond, what):
    if not cond:
        failures.append(what)


def emu(img, mono, cond_flag):
    e = mc.Emu(img, 2 if mono else 1)
    e.stubs[0x533ef000] = lambda: 1 if mono else 0                 # is GR IV Monochrome
    e.stubs[0x533e033c] = lambda: 1 if mono else 0                 # SpecModel: has (monochrome) function
    return e


def ic_list(img, mono, cond_flag):
    e = emu(img, mono, cond_flag)
    obj = 0x70100000
    e.mu.mem_write(obj, bytes(0x40))
    # The constructor stores 0x0B/0x0B first; the "conditional" looks read obj+0x1F.
    e.call(0x533cc890, (obj,))
    if cond_flag is not None:
        e.mu.mem_write(obj + 0x1f, bytes([cond_flag]))
        e.call(0x533cc928, (obj, cond_flag))   # sets +0x1F and rebuilds
    a, b = struct.unpack('<2I', e.mu.mem_read(obj + 0x24, 8))
    return list(e.mu.mem_read(a, b - a)), [c for c in e.calls if c[0] in ('ASSERT', 'NULL-JUMP')]


def adj_list(img, mono):
    e = emu(img, mono, None)
    obj = 0x70200000
    e.mu.mem_write(obj, bytes(0x100))
    buf1, buf2 = 0x70210000, 0x70220000
    e.mu.mem_write(obj + 0x4c, struct.pack('<3I', buf1, buf1, buf1 + 0x100))
    e.mu.mem_write(obj + 0x58, struct.pack('<3I', buf2, buf2, buf2 + 0x100))
    styles = []
    # Each visible look goes through 0x53373BC0 (style -> the list's own number) on its way in.
    e.mu.hook_add(mc.UC_HOOK_CODE, lambda uc, addr, size, ud: styles.append(uc.reg_read(mc.UC_ARM_REG_R1)), begin=0x53373bc0, end=0x53373bc0)
    e.call(0x533755bc, (obj,), strict=False)
    a, b = struct.unpack('<2I', e.mu.mem_read(obj + 0x4c, 8))
    check(b - a == len(styles), 'ADJ / RAW list: entries and looks differ')
    c, d = struct.unpack('<2I', e.mu.mem_read(obj + 0x58, 8))
    return styles, (d - c), [x for x in e.calls if x[0] in ('ASSERT', 'NULL-JUMP')]


def guard_fix(img):
    save = 0x533e1c04
    w = img.u32(save)
    stub = save + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4
    bls = []
    for k in range(12):
        x = img.u32(stub + 4 * k)
        if (x >> 24) == 0xeb:
            bls.append(stub + 4 * k + 8 + (((x & 0xffffff) ^ 0x800000) - 0x800000) * 4)
    return bls[1]


def main():
    new, off = mc.Image(sys.argv[1]), mc.Image(sys.argv[2])
    order = [int(x) for x in sys.argv[3].split(',')]
    hidden = [int(x) for x in sys.argv[4].split(',')] if len(sys.argv) > 4 and sys.argv[4] else []
    slots = [s for s in order if s >= 34]
    print('1. lists')
    for mono in (False, True):
        for cond in (None, 0, 1):
            got, bad = ic_list(new, mono, cond)
            ref, _ = ic_list(off, mono, cond)
            want = [s for s in order if s not in hidden and s in ref]
            check(got == want and not bad, f'Image Control list, {"Monochrome" if mono else "colour"} model, flag {cond}: {got} want {want} {bad}')
            print(f'  IC  {"mono  " if mono else "colour"} flag {cond}: {len(got)} looks', got if cond is None else '')
        got, customs, bad = adj_list(new, mono)
        ref, rc, _ = adj_list(off, mono)
        want = [s for s in order if s not in hidden and s in ref]
        check(got == want and customs == len(got) + 3 and rc == len(ref) + 3 and not bad, f'ADJ / RAW list, {"Monochrome" if mono else "colour"} model: {got} want {want}, customs {customs} vs {rc} {bad}')
        print(f'  ADJ {"mono  " if mono else "colour"}: {len(got)} looks', got, f'(second list: the looks and the 3 custom sets)')
    print('2. settings guard')
    fix = guard_fix(new)
    for off_, kind in ((0x153, 'photo standard set'), (0x515, 'movie standard set'), (0x154, 'photo custom 1'), (0x518, 'movie custom 3')):
        for look in sorted(set(order + [11, 25, 31, 60])):
            e = mc.Emu(new)
            settings = 0x70400000
            e.mu.mem_write(settings + off_, bytes([look]))
            e.call(fix, (settings, 0))
            got = e.byte(settings + off_)
            invalid = look >= 31 and look not in slots
            if invalid:
                want = 11
            elif look in hidden and off_ in (0x153, 0x515):
                want = 25 if 25 <= look <= 30 else 11
            else:
                want = look
            check(got == want, f'guard, {kind}, look {look}: {got} want {want}')
        print(f'  {kind}: hidden {hidden} ->', [(h, None) for h in hidden][:0] or 'checked')
    print('FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
