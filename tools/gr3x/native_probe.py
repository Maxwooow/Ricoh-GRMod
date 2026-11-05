"""Execute selected original IIIx functions with synthetic arguments.

This is a function-level ARM probe, not a camera emulator. No update is generated.
Only the two identified mutex services and diagnostic reporting are stubbed.
"""
import hashlib
import json
import struct
from pathlib import Path
import argparse
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_PROT_READ, UC_PROT_EXEC
from unicorn import arm_const as reg

BASE = 0x53000000
from identity import by_rtos
# The IIIx value; reports use the hash of the RTOS actually probed (identity.by_rtos).
RTOS_SHA = '0f11b0d28bc67932d044c5d01bc0314844a756057c89984278c73a23449a24c6'
OBJECT, OUTPUT = 0x62010000, 0x62030000
STACK, STOP = 0x610ff000, 0x620ff000
RESOLUTION = 0x536a2a30
PREVIEW = 0x5366632c
DNG_WINDOW = 0x53661054
DIAGNOSTIC = 0x536b93d0
MUTEX = (0x536ae71c, 0x536ae870)

class NativeProbe:
    def __init__(self, data):
        self.profile = by_rtos(data)  # raises for anything but the exact IIIx 1.60 / GR III 2.10 RTOS
        self.data = data
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        rom_bytes = (len(data)+4095) & ~4095
        self.uc.mem_map(BASE, rom_bytes)
        self.uc.mem_write(BASE, data)
        self.uc.mem_protect(BASE, rom_bytes, UC_PROT_READ | UC_PROT_EXEC)
        src, dst, size = struct.unpack_from('<3I', data, 0x450)
        if (src, dst, size) != (0x5407b540, 0x55000000, 0x3a080):
            raise ValueError('Unexpected startup initialized-data map')
        self.uc.mem_map(dst, (size+4095) & ~4095)
        self.uc.mem_write(dst, data[src-BASE:src-BASE+size])
        self.uc.mem_map(0x61000000, 0x100000)
        self.uc.mem_map(0x62000000, 0x100000)
        self.uc.reg_write(reg.UC_ARM_REG_C1_C0_2, 0xf00000)
        self.uc.reg_write(reg.UC_ARM_REG_FPEXC, 0x40000000)
        self.uc.hook_add(UC_HOOK_CODE, self._hook)
        self.diagnostics, self.stubs = [], []

    def _hook(self, cpu, at, size, user):
        if at in MUTEX:
            self.stubs.append(hex(at))
            cpu.reg_write(reg.UC_ARM_REG_R0, 0)
            cpu.reg_write(reg.UC_ARM_REG_PC, cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at == DIAGNOSTIC:
            if cpu.reg_read(reg.UC_ARM_REG_R0) == 0:
                self.diagnostics.append({'at':hex(at),'source_line':cpu.reg_read(reg.UC_ARM_REG_R3)})
            cpu.reg_write(reg.UC_ARM_REG_PC, cpu.reg_read(reg.UC_ARM_REG_LR))

    def call(self, address, *args, float_value=1.0, stack=b''):
        self.diagnostics, self.stubs = [], []
        for n in range(13): self.uc.reg_write(getattr(reg,'UC_ARM_REG_R'+str(n)),0)
        self.uc.reg_write(reg.UC_ARM_REG_CPSR, 0x13)
        self.uc.reg_write(reg.UC_ARM_REG_SP, STACK)
        self.uc.reg_write(reg.UC_ARM_REG_LR, STOP)
        self.uc.reg_write(reg.UC_ARM_REG_S0, struct.unpack('<I',struct.pack('<f',float_value))[0])
        self.uc.mem_write(STACK-0x1000, bytes(0x2000))
        self.uc.mem_write(STACK, stack)
        for n, val in enumerate(args): self.uc.reg_write(getattr(reg,'UC_ARM_REG_R'+str(n)),val)
        # Exercise the AAPCS callee-saved contract instead of relying on zero registers.
        saved = {getattr(reg, 'UC_ARM_REG_R'+str(n)): 0x12340000+n for n in range(4,12)}
        saved.update({getattr(reg, 'UC_ARM_REG_S'+str(n)): 0x3f800000+n for n in range(16,32)})
        for register, value in saved.items(): self.uc.reg_write(register, value)
        self.uc.emu_start(address, STOP, timeout=2_000_000, count=100000)
        if self.uc.reg_read(reg.UC_ARM_REG_PC) != STOP:
            raise ValueError('Function did not return within the instruction/time bound')
        if self.uc.reg_read(reg.UC_ARM_REG_SP) != STACK:
            raise ValueError('Stack pointer was not restored')
        if any(self.uc.reg_read(register) != value for register,value in saved.items()):
            raise ValueError('Callee-saved CPU or VFP register was changed')
        if self.diagnostics:
            raise ValueError('Original assertion failed: '+repr(self.diagnostics))
        return self.uc.reg_read(reg.UC_ARM_REG_R0)

    def dimensions(self, aspect, selector=0, magnification=1.0):
        self.uc.mem_write(OUTPUT, b'\xff'*8)
        self.call(RESOLUTION, OBJECT, selector, aspect, OUTPUT,
            float_value=magnification, stack=struct.pack('<I',OUTPUT+2))
        width,height=struct.unpack('<2H',self.uc.mem_read(OUTPUT,4))
        return dict(aspect=aspect,selector=selector,magnification=magnification,width=width,height=height)

    def preview(self, aspect, scale=8192):
        state=bytearray(0x2600)
        for offset,value in ((4,45<<16),(8,30<<16),(20,45<<16),(24,30<<16),(0x1ca8,1)):
            struct.pack_into('<I',state,offset,value)
        self.uc.mem_write(OBJECT,bytes(state))
        self.call(PREVIEW,OBJECT,0,aspect,scale)
        result=dict(zip(('width','height','left','top'),struct.unpack('<4I',self.uc.mem_read(OBJECT+36,16))))
        return dict(aspect=aspect,scale=scale,window=result,stubbed_services=list(self.stubs))

    def dng_window(self, aspect, magnification=1.0):
        self.uc.mem_write(OUTPUT,b'\xff'*8)
        self.call(DNG_WINDOW,OBJECT,OUTPUT,OUTPUT+2,OUTPUT+4,
            float_value=magnification,stack=struct.pack('<3I',OUTPUT+6,aspect,0))
        result=dict(zip(('width','height','left','top'),struct.unpack('<4H',self.uc.mem_read(OUTPUT,8))))
        return dict(aspect=aspect,magnification=magnification,window=result,
            scope='native crop window only; DNG serialization and RAW pixels not executed')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rtos', required=True, type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    data = args.rtos.read_bytes()
    profile = json.loads((Path(__file__).with_name('fixtures') / 'profile-160.json').read_text())
    for name, symbol in profile['symbols'].items():
        offset = int(symbol['rtos_offset'], 0)
        expected = bytes.fromhex(symbol['original_first_16_bytes'])
        if data[offset:offset + len(expected)] != expected:
            raise ValueError('Symbol guard failed: ' + name)
    n = NativeProbe(data)
    rows = [n.dimensions(a, s, m) for a in (0, 1, 2, 3) for s in range(4) for m in (1.0, 1.25, 1.78)]
    previews = [n.preview(a) for a in (0, 1, 2, 3)]
    dng = [n.dng_window(a, m) for a in (0, 3) for m in (1.0, 1.25, 1.78)]
    baseline = json.loads((Path(__file__).with_name('fixtures') / 'native-baseline.json').read_text())
    for key, actual in [('resolution_rows', rows), ('previews', previews), ('dng_windows', dng)]:
        if actual != baseline[key]:
            raise ValueError('Baseline mismatch: ' + key)
    rejected = False
    try:
        n.dimensions(255)
    except ValueError as exc:
        if 'assertion failed' not in str(exc): raise
        rejected = True
    if not rejected: raise ValueError('Invalid aspect ID did not hit the original assertion')
    report = dict(rtos_sha256=n.profile['rtos_sha256'], dimensions=len(rows), previews=len(previews), dng_windows=len(dng),
                  symbol_guards=len(profile['symbols']), invalid_id_rejected=rejected,
                  baseline_match=True, hardware_tested=False, firmware_generated=False,
                  scope='Original native functions only. ISP, JPEG encode, DNG serialization and boot are not emulated.')
    text = json.dumps(report, indent=2) + '\n'
    if args.report:
        if args.report.resolve() == args.rtos.resolve(): raise ValueError('Report cannot overwrite the input')
        args.report.write_text(text)
    print(text)
