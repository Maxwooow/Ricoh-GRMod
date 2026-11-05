# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the Direct Flash diagnostic test build (NOT part of the program).

    python3 diag_check.py BUILT-DIAG-RTOS [OUT.png]

 1. Runs the exposure hook (the wrapper of the flash program at 0x5367AAA8) of a build made with the
    test option `directFlashDiag` twice, on a bright and on a dim scene: the planner allocates its
    buffer on the first call (operator new stubbed), keeps it in RAM word 0x558372FC, and leaves
    two records; each record holds the inputs and results the check put in / expects.
 2. Runs the date imprint's DFDIAG module (DATESTAMP_DFDIAG_CODE) on a 720x480 picture with that
    buffer and writes the picture to OUT.png (default /tmp/df_diag.png) for a look.
"""
import base64
import re
import struct
import sys
from pathlib import Path

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_C1_C0_2, UC_ARM_REG_FPEXC

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SLOT = 0x558372fc
ALLOC = 0x538e09b0
HEAP = 0x60080000
failures = []


def ok(cond, what):
    if not cond:
        failures.append(what)


def run_planner(img):
    e = check.Emu(img)
    heap = [HEAP]

    def alloc():
        a = heap[0]
        heap[0] += 0x400
        return a
    e.stubs[ALLOC] = ('alloc', None)
    e.stubs[check.FLASH_PROGRAM] = ('flash program', None)
    mu = e.mu
    orig_hook = e._hook

    def hook(uc, addr, size, ud):
        if addr == ALLOC:
            a = alloc()
            e.calls.append(('alloc', uc.reg_read(UC_ARM_REG_R0)))
            uc.reg_write(UC_ARM_REG_R0, a)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            return
        if addr == check.FLASH_PROGRAM:
            # The camera's own result before the override.
            uc.mem_write(info + 0xd0, struct.pack('<3f', 5.0, 4.0, 6.0))
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
            return
    e.stubs = {}
    mu.hook_add(UC_HOOK_CODE, hook)
    wrapper = img.branch(check.CALL_SITE)
    ae, diag, apex, info = 0x70000000, 0x70001000, 0x70002000, 0x70003000
    e.w32(ae + 4, diag); e.w32(ae + 0x28, info); e.w32(diag + 4, apex); e.w32(apex + 4, info)
    ok(e.mu.mem_read(SLOT, 4) == b'\0\0\0\0', 'slot not zero at start')
    scenes = [dict(ev=14.0, mm=1000), dict(ev=6.0, mm=2000)]
    expect = []
    for sc in scenes:
        e.mu.mem_write(info, bytes(0x600))
        e.w8(check.BYTE, 1); e.w8(check.LIVE_FM, 0); e.w8(check.OUTPUT, 1)
        for o, v in ((0x10, 15.0), (0x14, 5.0), (0x64, sc['ev']), (0x70, 12.0), (0x74, -5.0), (0xa0, 5.0), (0xa4, 10.0), (0xec, 2.9708536), (0xf0, 8.0)):
            e.wf(info + o, v)
        e.w8(info + 0x9c, 1); e.w16(info + 0x3e, 0x10); e.w8(info + 0x55d, 2); e.w32(info + 0x584, sc['mm'])
        e.call(wrapper, ae)
        got = (e.rf(info + 0xd0), e.rf(info + 0xd4), e.rf(info + 0xd8))
        expect.append(got)
    buf = struct.unpack('<I', e.mu.mem_read(SLOT, 4))[0]
    ok(buf == HEAP, f'buffer at {buf:#x}')
    ok([c for c in e.calls if c[0] == 'alloc'] == [('alloc', 4 + 2 * 32 * 4)], f'allocations {e.calls}')
    raw = bytes(e.mu.mem_read(buf, 4 + 2 * 32 * 4))
    calls = struct.unpack_from('<I', raw)[0]
    ok(calls == 2, f'calls {calls}')
    for n, (sc, got) in enumerate(zip(scenes, expect), 1):
        r = struct.unpack_from('<32i', raw, 4 + (n & 1) * 128)
        ok(r[0] == n and r[1] == 0, f'record {n}: call/reason {r[:2]}')
        ok(r[9] == round(sc['ev'] * 100) and r[8] == sc['mm'] and r[4] == 0x10, f'record {n}: inputs {r[4:10]}')
        ok(r[15:18] == (500, 400, 600), f'record {n}: camera result {r[15:18]}')
        ok(all(abs(r[18 + i] - got[i] * 100) <= 1 for i in range(3)), f'record {n}: result {r[18:21]} vs {got}')
        print(f'  record {n}: Ev {r[9] / 100}  Tv {r[18] / 100} Av {r[19] / 100} Sv {r[20] / 100}  sync {r[12] / 100}  tv-hi {r[13] / 100}  tv-lo {r[14] / 100}')
    return raw


def render(raw, out):
    ts = (ROOT / 'core/src/fw/aspect/datestamp-code.ts').read_text()
    code = base64.b64decode(re.search(r"DATESTAMP_DFDIAG_CODE = '([^']+)'", ts).group(1))
    ORG = 0x10000
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(ORG, 0x10000); mu.mem_write(ORG, code)
    mu.mem_map(0x60000000, 0x100000)
    mu.mem_map(0x70000000, 0x100000)
    PV = 0x90000000
    mu.mem_map(PV, 0x200000)
    mu.mem_write(PV, bytes([90]) * (736 * 480)); mu.mem_write(PV + 0x100000, bytes([128]) * (736 * 480))
    STUB = 0x70000000
    for i in range(6):
        mu.mem_write(STUB + i * 16, struct.pack('<I', 0xe12fff1e))
    mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, d: uc.reg_write(UC_ARM_REG_R0, 0x553a09c4) if a == STUB else None, begin=STUB, end=STUB + 0x60)
    SET, CTX, SLOTW, BUF = 0x70003000, 0x70004000, 0x70008000, 0x7000a000
    mu.mem_write(SET, bytes([0]))  # the imprint itself off: the diagnostics are printed anyway
    mu.mem_write(BUF, raw)
    mu.mem_write(SLOTW, struct.pack('<I', BUF))
    mu.mem_write(CTX, struct.pack('<13I', *(STUB + i * 16 for i in range(5)), SET, 0, 0, 0, 0, 0, 0, SLOTW))
    D, CFG = 0x70005000, 0x70006000
    mu.mem_write(D, struct.pack('<B3xIII HHHH HH 4x', 1, PV, PV + 0x100000, 0, 720, 480, 736, 480, 0, 0))
    mu.mem_write(CFG + 0x3c, struct.pack('<4I', D, 0, 0, 0))
    mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
    mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000); mu.reg_write(UC_ARM_REG_LR, 0x70000ff0)
    mu.reg_write(UC_ARM_REG_R0, CTX); mu.reg_write(UC_ARM_REG_R1, CFG)
    mu.emu_start(ORG, 0x70000ff0, count=400_000_000)
    y = bytes(mu.mem_read(PV, 736 * 480))
    changed = sum(1 for v in y if v != 90)
    ok(changed > 2000, f'diagnostics not drawn ({changed} pixels)')
    from PIL import Image
    Image.frombytes('L', (736, 480), y).crop((0, 0, 720, 480)).save(out)
    print(f'  {changed} pixels drawn, picture {out}')


def main():
    img = check.Image(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/df_diag.png'
    print('1. planner records')
    raw = run_planner(img)
    print('2. printed on the 720x480 picture')
    render(raw, out)
    if failures:
        print(f'{len(failures)} FAILURES')
        for f in failures:
            print('  ' + f)
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
