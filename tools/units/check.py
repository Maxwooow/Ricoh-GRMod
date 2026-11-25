# SPDX-License-Identifier: GPL-2.0-only
"""Run the GR IV's manual focus scale labels (the function the feet build changes) in an emulator (development tool).

    python3 tools/units/check.py RELEASE OFFICIAL.rtos BUILT.rtos

RELEASE is 1.20 or 1.21; the .rtos files are RTOS sections (the official one and a build with `distanceFeet`).
For both scales (m, cm) and both nearest focus distances (60, 120 mm) the function is run with a view object of
its own; the calls that set a label's icon and place are recorded. The official file must give the camera's
labels, the build the feet / inch labels in the same order and places, with ∞ and the blank label kept.
"""
import sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_SP

# release -> (the function, its callees: two getters, the nearest focus distance, set icon, set place, log)
RELEASES = {
    '1.20': (0x53592728, {0x532406a4: 'get', 0x5324123c: 'get', 0x533b1198: 'near', 0x5359a104: 'icon', 0x535abfa8: 'place', 0x539154f8: 'log'}),
    '1.21': (0x53593050, {0x53240cac: 'get', 0x53241844: 'get', 0x533b1a48: 'near', 0x5359aa2c: 'icon', 0x535ac8d0: 'place', 0x53916230: 'log'}),
}
# The camera's icons and the build's (tools/units/labels.py; units.ts: UNIT_LABEL_NAMES from 1130).
CAMERA = {0x2c3: 'm', 0x2c1: 'cm', 0x2c2: '∞', 0x94: '5', 0x92: '3', 0x8e: '1', 0x2c0: '0.3', 0x93: '30', 0x2b: '24', 0x38: '20', 0x90: '12',
          0x91: '15', 0x8f: '10', 0x95: '6', 0: ''}
FEET = dict(zip(range(1130, 1143), ['ft', 'in', '16', '9.8', '3.3', '1', '12', '9.4', '7.9', '4.7', '5.9', '3.9', '2.4']))
FEET.update({0x2c2: '∞', 0: ''})
WANT = {  # (scale, nearest mm) -> official labels, feet labels
    (1, 60): ('m ∞ 5 3 1 0.3', 'ft ∞ 16 9.8 3.3 1'), (1, 120): ('m ∞ 5 3 1 0.3', 'ft ∞ 16 9.8 3.3 1'),
    (0, 60): ('cm 30  15 10 6', 'in 12  5.9 3.9 2.4'), (0, 120): ('cm 30  24 20 12', 'in 12  9.4 7.9 4.7'),
}


def run(path, release, scale, near):
    func, stubs = RELEASES[release]
    d = open(path, 'rb').read()
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(0x53000000, (len(d) + 0xfff) & ~0xfff)
    mu.mem_write(0x53000000, d)
    mu.mem_map(0x70000000, 0x100000)
    obj = 0x70001000
    mu.mem_write(obj + 0x124, bytes([scale]))
    for off in range(0xec, 0x114, 4): mu.mem_write(obj + off, (0x70002000 + off).to_bytes(4, 'little'))
    calls = []

    def hook(uc, addr, size, _):
        n = stubs.get(addr)
        if not n: return
        r0, r1 = uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)
        if n in ('icon', 'place'): calls.append((n, r0 - 0x70002000, r1))
        if n == 'log': calls.append(('log', 0, 0))
        uc.reg_write(UC_ARM_REG_R0, near if n == 'near' else 0)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    mu.hook_add(UC_HOOK_CODE, hook)
    mu.reg_write(UC_ARM_REG_SP, 0x70080000)
    mu.reg_write(UC_ARM_REG_R0, obj)
    mu.reg_write(UC_ARM_REG_LR, 0x70000000)
    mu.emu_start(func, 0x70000000, count=5000)
    return calls


def main():
    release, official, built = sys.argv[1:4]
    bad = 0
    for (scale, near), (want_o, want_f) in WANT.items():
        o = run(official, release, scale, near * 1)
        f = run(built, release, scale, near)
        labels_o = ' '.join(CAMERA.get(v, f'?{v}') for k, _, v in o if k == 'icon')
        labels_f = ' '.join(FEET.get(v, f'?{v}') for k, _, v in f if k == 'icon')
        places_same = [c for c in o if c[0] != 'icon'] == [c for c in f if c[0] != 'icon']
        views_same = [c[1] for c in o] == [c[1] for c in f]
        ok = labels_o == want_o and labels_f == want_f and places_same and views_same and not any(c[0] == 'log' for c in o + f)
        bad += not ok
        print(f"{'ok ' if ok else 'BAD'} scale {'m' if scale else 'cm'}, nearest {near} mm: [{labels_o}] -> [{labels_f}]")
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
