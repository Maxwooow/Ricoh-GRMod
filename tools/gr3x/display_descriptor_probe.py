"""Exploratory native display descriptor execution; no camera/DMA emulation.

Extends the prior synthetic recipe fixture with explicit dimensions/metadata.
No firmware is emitted or changed. Singleton/config services are substituted as
documented by this file and the inherited DevelopmentProbe/LiveProbe. The
physical camera's allocation, capture event sequence and pixel transfers are
not executed. Bounds results describe this fixture, not all hardware modes.
In particular, inherited allocation=[cw,ch] is a common-aperture test fixture,
not the native allocator's initial VRAM capacity. Native 0x534343d0 initializes
+0x1c8/+0x1ca to 1920x1088. Do not infer actual display allocation or transfer
safety from this fixture's rectangle bounds alone.
The optional native-vram fixture executes the original allocator constructor
for that initial capacity; it still does not perform real memory allocation or
pixel transfers. 0x53459228 is SetupResizeProcessConfig, not SetupDisplayConfig.
"""
import json, struct, hashlib, argparse
from pathlib import Path
from collections import deque

from unicorn import arm_const as reg, UC_HOOK_MEM_INVALID
from development_bounds_probe import DevelopmentProbe
from native_probe import OBJECT

class DisplayProbe(DevelopmentProbe):
    def __init__(self, data, manifest, original=False):
        self.trace = deque(maxlen=32)
        super().__init__(data, manifest)
        if original:
            for site in manifest['sites']:
                self.uc.mem_write(site['address'], bytes.fromhex(site['expected']))
        self.uc.hook_add(UC_HOOK_MEM_INVALID, self.invalid)

    def invalid(self, cpu, access, address, size, value, user):
        self.invalid_access = dict(access=access, address=hex(address), size=size,
                                   pc=hex(cpu.reg_read(reg.UC_ARM_REG_PC)),
                                   trace=[hex(v) for v in self.trace])
        return False

    def _hook(self, cpu, at, size, user):
        self.trace.append(at)
        singletons = {0x5366145c:0x62098000, 0x536c3f9c:0x62097000,
                      0x536c97b0:0x62097200}
        if at in singletons:
            cpu.reg_write(reg.UC_ARM_REG_R0, singletons[at])
            cpu.reg_write(reg.UC_ARM_REG_PC, cpu.reg_read(reg.UC_ARM_REG_LR))
        else:
            super()._hook(cpu, at, size, user)

    def display(self, identity, resolution=11, flags=(0, 0), zoom=8192, display_zoom=256,
                mode=0, allocation_kind='aperture'):
        prior = self.recipe(identity, resolution, mode, flags, zoom, allocation_kind)
        cpu = self.uc
        def word(at, value): cpu.mem_write(at, struct.pack('<I', value))
        def half(at, value): cpu.mem_write(at, struct.pack('<H', value))
        cw, ch = prior['allocation']
        # Native caller invokes SetupResizeProcessConfig only for +0x538 == 0.
        cpu.mem_write(OBJECT+0x538, b'\0')
        cpu.mem_write(OBJECT+0x4100, bytes(0x300))
        cpu.mem_write(OBJECT+0x5000, bytes(0x300))
        cpu.mem_write(OBJECT+0x6000, bytes(0x300))
        word(OBJECT+0x98, OBJECT+0x5000)
        word(OBJECT+0x200, OBJECT+0x4100)
        for off, val in ((0xae,cw), (0xb0,ch), (0xb4,cw), (0xb6,ch), (0xb8,cw), (0xba,ch)):
            half(OBJECT+0x3000+off, val)
        word(OBJECT+0x5c, 0x6a000000)
        word(OBJECT+0x58, 0x6b000000)
        vw,vh = prior['vram_capacity']
        word(OBJECT+0x21c0, vw*vh)
        word(OBJECT+0x478, 4096)
        half(OBJECT+0x544, display_zoom)
        # Synthetic sensor coordinate metadata with centered 6000 x 4000 canvas.
        info = OBJECT+0x6000
        for off, val in ((0x20,6000), (0x24,4000), (0x28,0), (0x2c,0),
                         (0x50,6000), (0x54,4000), (0x58,0), (0x5c,0)):
            word(info+off, val)
        word(OBJECT+0x53c, 3000); word(OBJECT+0x540, 2000)
        word(0x620934e4, 0x62094000)
        word(0x62094000, 3000); word(0x62094004, 2000)
        half(0x62094008, display_zoom)
        cpu.mem_write(0x62098000, bytes(0x100))
        word(0x62098008, OBJECT+0x3000)
        cpu.mem_write(0x62097000, bytes(0x300))
        word(0x62097004, 0x62097100)
        # Native mode-1 geometry normally has sensor dimensions and subsampling
        # factors, not this common-aperture fixture. Test IDs 0/3/4..10 only.
        # Rebuild Ch0 AFTER selecting the software-display path. The inherited
        # recipe probe used +0x538=1 for its separate hardware crop test.
        source_before = bytes(cpu.mem_read(OBJECT+0x1000, 0x2200))
        self.call(0x53457e00, OBJECT)
        self.call(0x534586c8, OBJECT)
        cpu.reg_write(reg.UC_ARM_REG_S1, 0x3f800000)
        self.call(0x53459228, OBJECT, 0, 0, identity, stack=struct.pack('<II', info, 0))
        assert bytes(cpu.mem_read(OBJECT+0x1000, 0x2200)) == source_before
        assert bytes(cpu.mem_read(OBJECT+0x600, 0xa00)) == b'\xa5'*0xa00
        assert bytes(cpu.mem_read(OBJECT+0x6300, 0x9d00)) == b'\xa5'*0x9d00
        def descriptor(offset):
            data = bytes(cpu.mem_read(OBJECT+offset, 32))
            dims = struct.unpack_from('<6H', data, 16)
            return dict(format=data[0], address_slots=[hex(x) for x in struct.unpack_from('<3I',data,4)],
                        rect=dims, flags=data[28],
                        in_canvas=dims[4]+dims[0]<=dims[2] and dims[5]+dims[1]<=dims[3])
        return dict(id=identity, resolution=resolution, flags=flags, zoom=zoom,
                    mode=mode, display_zoom=display_zoom, allocation=[cw,ch], vram_capacity=[vw,vh],
                    recipe=prior['dimensions'], ch0=descriptor(0x170),
                    ch1=descriptor(0x208), display_source=descriptor(0x3a8),
                    display_destination=descriptor(0x3c8))

def verify(data, manifest):
    patched = DisplayProbe(data, manifest)
    original = DisplayProbe(data, manifest, original=True)
    rows, baseline, bounds_flags = [], [], []
    for resolution in range(1, 32):
        for flags in ((0,0), (0,1), (1,0), (1,1)):
            for identity in (0,3,4,5,6,7,8,9,10):
                row = patched.display(identity, resolution, flags)
                rows.append(row)
                if identity in (0,3):
                    native = original.display(identity, resolution, flags)
                    assert row == native, (identity, resolution, flags)
                    baseline.append(dict(id=identity, resolution=resolution, flags=flags, unchanged=True))
                failed = [name for name in ('ch0','ch1','display_source','display_destination')
                          if not row[name]['in_canvas']]
                if failed:
                    bounds_flags.append(dict(id=identity, resolution=resolution, flags=flags, fields=failed))
                    # The common allocation fixture does not describe every
                    # native interlaced mode. These cases also flag without T3.
                    assert identity == 3 and resolution in (5,7) and flags[1] == 0
    assert len(rows) == 1116 and len(baseline) == 248 and len(bounds_flags) == 4
    return dict(
        schema=1,
        summary=dict(completed_states=len(rows), native_baselines=len(baseline),
                     native_unchanged=True, custom_wide_states=372,
                     custom_wide_bounds_flags=0, native_fixture_bounds_flags=len(bounds_flags),
                     input_metadata_and_geometry_unchanged=True, object_canaries_unchanged=True,
                     firmware_generated=False, hardware_tested=False,
                     scope='Synthetic no-zoom allocation and controller metadata. Runs native recipe, '
                     'Ch0, Ch1 and SetupResizeProcessConfig, with singleton/config services substituted. '
                     'Does not execute pixel transfers, ISP/DMA/cache hardware, real allocation, or '
                     'capture/resume/half-press event sequences. No flicker fix is established.'),
        bounds_flags=bounds_flags, rows=rows, baseline=baseline)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rtos', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('report', type=Path)
    args=parser.parse_args()
    data=args.rtos.read_bytes(); manifest_bytes=args.manifest.read_bytes()
    result=verify(data, json.loads(manifest_bytes))
    result['rtos_sha256']=hashlib.sha256(data).hexdigest()
    result['manifest_sha256']=hashlib.sha256(manifest_bytes).hexdigest()
    with args.report.open('x') as output:
        json.dump(result,output,indent=2);output.write('\n')
    print(json.dumps(result['summary'],indent=2))
