# SPDX-License-Identifier: GPL-2.0-only
"""The built firmware in an emulator (unicorn): the stub that replaces the final-stage call of the Auto estimate is called as the
camera calls it (r0 = r4 = the Auto object, r1 = the accumulators, r5 = S, r7 = 0 or the record); the camera's own final stage and
the appended module run from the patched image. Checked against the host build of awb2.c bit for bit over live view / capture
sequences in the three modes; also: operator new is called once, the pointer word is used, r4-r11 and sp are preserved, the stack
depth and the instruction count.

usage: test_fw.py PATCHED_RTOS.bin   (the decoded RTOS section of a build with awbLearn). Needs GRIV_DATA."""
import ctypes, os, struct, sys
import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import *
import model, hostlib

RTOS = open(sys.argv[1], 'rb').read()
BASE, RAM, HEAP, WORK, STACK, RET = 0x53000000, 0x55000000, 0x57000000, 0x58000000, 0x5A000000, 0x5B000000
FINAL_CALL, FINAL_STAGE, ALLOC, SLOT = 0x53960E90, 0x539609D4, 0x539084BC, 0x55839078
FLASH_MGR, SEQ_WAIT = 0x5537E7C0, 0x550B896C          # the flash data manager's pointer word, the shooting sequence's "waiting for the charge" byte
wd = lambda a: struct.unpack_from('<I', RTOS, a - BASE)[0]
w = wd(FINAL_CALL); assert w >> 24 == 0xEB
off = (w & 0xFFFFFF) - (1 << 24 if w & 0x800000 else 0)
STUB = FINAL_CALL + 8 + 4 * off
assert STUB != FINAL_STAGE, 'this image does not have the module'
assert wd(0x53000460) == 0x55839080, 'the start-up zero fill does not reach the state pointer'


class Emu:
    def __init__(self, measure=False):
        mu = self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(RTOS) + 0xFFFFF) & ~0xFFFFF
        mu.mem_map(BASE, size); mu.mem_write(BASE, RTOS)
        mu.mem_map(RAM, 0x1000000); mu.mem_map(HEAP, 0x100000); mu.mem_map(WORK, 0x200000); mu.mem_map(STACK, 0x100000); mu.mem_map(RET, 0x1000)
        self.allocs = 0; self.heap = HEAP; self.sp_min = None; self.insn = 0; self.image_writes = 0
        mu.hook_add(UC_HOOK_CODE, self.on_alloc, begin=ALLOC, end=ALLOC)
        if measure: mu.hook_add(UC_HOOK_CODE, self.on_code)      # per-instruction hook (slow): stack depth and instruction count
        self.measure = measure
        mu.hook_add(UC_HOOK_MEM_WRITE, self.on_write, begin=BASE, end=BASE + size - 1)

    def on_alloc(self, mu, a, s, u):
        n = mu.reg_read(UC_ARM_REG_R0)
        self.allocs += 1
        mu.mem_write(self.heap, b'\xAA' * n)                 # operator new does not clear
        mu.reg_write(UC_ARM_REG_R0, self.heap); self.heap += (n + 15) & ~15
        mu.reg_write(UC_ARM_REG_PC, mu.reg_read(UC_ARM_REG_LR))

    def on_code(self, mu, a, s, u):
        self.insn += 1
        sp = mu.reg_read(UC_ARM_REG_SP)
        if self.sp_min is None or sp < self.sp_min: self.sp_min = sp

    def on_write(self, mu, access, a, size, value, u):
        self.image_writes += 1

    def call(self, mem, s_off, still):
        mu = self.mu
        arr = WORK + 0x10000
        mu.mem_write(arr, mem)
        for k in range(5):                                   # the stats pointers: offsets -> addresses
            p = struct.unpack_from('<I', mem, s_off + 4 * k)[0]
            mu.mem_write(arr + s_off + 4 * k, struct.pack('<I', arr + p))
        obj = WORK; mu.mem_write(obj, bytes(0xB000)); mu.mem_write(obj + 0xB000, bytes(16))
        regs = {UC_ARM_REG_R4: obj, UC_ARM_REG_R5: arr + s_off, UC_ARM_REG_R6: 0x66666666, UC_ARM_REG_R7: 0x60700000 if still else 0, UC_ARM_REG_R8: 0x88888888,
                UC_ARM_REG_R9: 0x99999999, UC_ARM_REG_R10: 0xAAAAAAAA, UC_ARM_REG_R11: 0xBBBBBBBB}
        for r, v in regs.items(): mu.reg_write(r, v)
        sp0 = STACK + 0xF0000
        mu.reg_write(UC_ARM_REG_SP, sp0); mu.reg_write(UC_ARM_REG_LR, RET); mu.reg_write(UC_ARM_REG_R0, obj); mu.reg_write(UC_ARM_REG_R1, obj + 0xB000)
        self.sp_min = None; self.insn = 0
        mu.emu_start(STUB, RET, count=60_000_000)
        assert mu.reg_read(UC_ARM_REG_PC) == RET, 'did not return'
        ok = all(mu.reg_read(r) == v for r, v in regs.items()) and mu.reg_read(UC_ARM_REG_SP) == sp0
        g = struct.unpack_from('<6H', bytes(mu.mem_read(obj, 12)))
        return (g[2], g[5]), ok, (sp0 - self.sp_min if self.measure else 0), self.insn


def main():
    lib = hostlib.build()
    D = os.environ['GRIV_DATA']
    pr = np.load(f'{D}/learnawb/cube_eval_preds.npz', allow_pickle=True)
    names = [str(n) for n in pr['names']]; te = np.where(~pr['tr'])[0]
    rng = np.random.default_rng(3)
    step = int(os.environ.get('AWB2_STEP', '12'))
    bad = []; n = 0; depth = 0; ins_c = []; ins_r = []; ins_s = []
    for qi, i in enumerate(te[::step]):
        z_ = np.load(f'{D}/cubepp_gr/{names[i]}.npz', allow_pickle=True)
        rgb, wt = model.from_s(z_['s']); e30 = int(round((float(z_['Av']) + float(z_['Tv']) - float(z_['Sv'])) * 256))
        e = Emu(measure=qi < 2); lib.host_reset()
        assert struct.unpack('<I', bytes(e.mu.mem_read(SLOT, 4)))[0] == 0
        seq = [(False, m) for m in ([int(rng.integers(0, 3))] * 6)] + [(True, int(rng.integers(0, 3))), (False, 4), (False, 0), (True, 1), (True, 2)]
        for step_i, (still, mode) in enumerate(seq):
            fr = np.clip(np.round(rgb * rng.normal(1.0, 0.02, rgb.shape)), 0, 4095)
            words = (0x2000, 0x2000) if qi % 2 else (12800, 24730)
            kw = dict(x0=2, y0=1, stride=70) if qi % 3 == 0 else {}
            mem, s_off = hostlib.pack(fr, wt, e30 if qi % 5 else 99999, mode=mode, s68=words[0], s6e=words[1], **kw)
            g, ok, d, ins = e.call(mem, s_off, still)
            buf = ctypes.create_string_buffer(mem, len(mem)); obj = ctypes.create_string_buffer(0xB010)
            lib.host_call(buf, obj, ctypes.byref(buf, s_off), int(still))
            hg = struct.unpack_from('<6H', obj.raw); hg = (hg[2], hg[5])
            n += 1; depth = max(depth, d)
            if not e.measure: pass
            elif still: ins_s.append(ins)
            elif mode <= 2: (ins_c if step_i in (0, 1, 4, 5, 8) else ins_r).append(ins)      # the two halves of a computation; step 8 restarts after the preset mode
            if mode <= 2 and hg == (0, 0) and step_i not in (0, 8): bad.append(('host wrote nothing', names[i], step_i))
            # in a preset mode the module writes nothing: the camera's final stage result (here from an all-zero object) stays
            if mode > 2:
                continue
            if g != hg: bad.append(('gains differ from the host build', names[i], step_i, still, mode, g, hg))
            if not ok: bad.append(('registers / sp not preserved', names[i], step_i))
        if e.allocs != 1: bad.append(('operator new calls', names[i], e.allocs))
        if struct.unpack('<I', bytes(e.mu.mem_read(SLOT, 4)))[0] != HEAP: bad.append(('pointer word', names[i]))
        if e.image_writes: bad.append(('writes into the image', names[i], e.image_writes))
    # The flash, through the context's two addresses: a flash attached (type 0x10 at manager +0x14) and the sequence not waiting
    # -> the capture keeps the camera's result; waiting for the charge, or no flash -> the module's result. Same as the host build.
    z_ = np.load(f'{D}/cubepp_gr/{names[te[0]]}.npz', allow_pickle=True)
    rgb, wt = model.from_s(z_['s']); e30 = int(round((float(z_['Av']) + float(z_['Tv']) - float(z_['Sv'])) * 256))
    for ftype, waiting in ((0x10, 0), (0x10, 1), (0, 0), (2, 0)):
        e = Emu(); lib.host_reset(); lib.host_set_flash(ftype, waiting)
        fm = RAM + 0xF00000
        e.mu.mem_write(fm, bytes(0x90)); e.mu.mem_write(fm + 0x14, bytes([ftype]))
        e.mu.mem_write(FLASH_MGR, struct.pack('<I', fm)); e.mu.mem_write(SEQ_WAIT, bytes([waiting]))
        for still in [False] * 6 + [True]:
            mem, s_off = hostlib.pack(rgb, wt, e30, mode=0)
            g, ok, _, _ = e.call(mem, s_off, still)
            buf = ctypes.create_string_buffer(mem, len(mem)); obj = ctypes.create_string_buffer(0xB010)
            lib.host_call(buf, obj, ctypes.byref(buf, s_off), int(still))
            hg = struct.unpack_from('<6H', obj.raw); hg = (hg[2], hg[5]); n += 1
            if g != hg: bad.append(('gains differ from the host build (flash)', ftype, waiting, still, g, hg))
            if not ok: bad.append(('registers / sp not preserved (flash)', ftype, waiting))
        keeps = ftype != 0 and waiting == 0
        if keeps != (g == (0, 0)): bad.append(('flash rule', ftype, waiting, g))      # the camera's final stage leaves 0 for an all-zero object
    lib.host_set_flash(-1, 0)
    print(f'flash: a picture with the flash firing keeps the camera result, otherwise the module writes: {"yes" if not [b for b in bad if "flash" in b[0]] else "NO"}')
    print(f'emulated calls {n} in {len(te[::step])} sequences (live view, captures, three modes, a preset mode, missing exposure, offsets, capture words): mismatches vs the host build {len([b for b in bad if b[0].startswith("gains")])}')
    print(f'operator new once per session, pointer word 0x{SLOT:x} used, no write into the image, r4-r11 and sp preserved: {"yes" if not [b for b in bad if not b[0].startswith("gains")] else "NO"}')
    print(f'stack below the stub entry: {depth} bytes; instructions per call: live computing {int(np.mean(ins_c)):,} (max {max(ins_c):,}), live repeating {int(np.mean(ins_r)):,}, capture {int(np.mean(ins_s)):,} (max {max(ins_s):,})')
    for b in bad[:8]: print('MISMATCH', b)
    print('RESULT', 'FAIL' if bad else 'all passed')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
