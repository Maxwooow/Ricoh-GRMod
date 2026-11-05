"""Regression probes for face-detection mode initialization and full-frame DNGs.

The T1 descriptor path reports an unknown aspect and retains an earlier mode.
The native diagnostic names this routine SetupFaceDetectionConfig. T2 called
it a display-resume descriptor; that attribution was too broad. Retain its
initialization fix but do not treat this probe as evidence of a DMA flicker fix.
"""
import json,struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import NativeProbe,OBJECT,OUTPUT,STACK,STOP

def descriptor(p,identity,previous,explicit):
    cpu=p.uc; source=OBJECT+0x800
    cpu.mem_write(OBJECT,b'\xa5'*0x1000)
    cpu.mem_write(OBJECT+0x2f6,bytes([previous]))
    for offset,value in ((0xc4,720),(0xc6,480),(0xcc,24),(0xce,36)):
        cpu.mem_write(source+offset,struct.pack('<H',value))
    cpu.mem_write(STACK-0x38,struct.pack('<H',264))
    for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
    for i,value in ((4,OBJECT),(5,OBJECT),(6,source),(7,explicit),(8,identity),(9,720),(11,STACK)):
        cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),value)
    cpu.reg_write(reg.UC_ARM_REG_SP,STACK-0x100)
    cpu.reg_write(reg.UC_ARM_REG_LR,STOP)
    cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
    p.diagnostics=[]
    cpu.emu_start(0x53450668,0x53450584,count=10000)
    assert cpu.reg_read(reg.UC_ARM_REG_PC)==0x53450584
    assert cpu.reg_read(reg.UC_ARM_REG_R8)==identity
    assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK-0x100
    return bytes(cpu.mem_read(OBJECT+0x2f6,12)),list(p.diagnostics)

def verify(data,manifest):
    p=AdjProbe(data,manifest);original=NativeProbe(data);calls=0;m=p.menu
    # The original branch's failure for an added ID is observable independently.
    stale=[]
    for previous in range(4):
        value,diagnostics=descriptor(original,6,previous,0)
        assert diagnostics and value[0]==previous
        stale.append(value[0]);calls+=1
    for identity in range(11):
        for previous in (0,1,2,3,255):
            for explicit in (0,1):
                actual,diagnostics=descriptor(p,identity,previous,explicit)
                if identity>m.max_id:
                    # Not in this menu: the native path and its diagnostic, as in the original.
                    expected,native=descriptor(original,identity,previous,explicit)
                    assert diagnostics and native and actual==expected,(identity,previous,explicit)
                    calls+=2;continue
                assert not diagnostics,(identity,previous,explicit,diagnostics)
                if identity<4:
                    expected,diagnostics=descriptor(original,identity,previous,explicit)
                    assert actual==expected and not diagnostics
                else:
                    family=1 if identity in m.wide else 3
                    expected,diagnostics=descriptor(original,family,previous,explicit)
                    assert actual==expected and not diagnostics,(identity,previous,explicit,actual,expected)
                calls+=2
    full=original.dng_window(0,1.0)['window']
    assert full==dict(width=6000,height=4000,left=68,top=40)
    rawcases=0
    for identity in m.order:
        for magnification in (1.0,1.25,1.785714269):
            p.uc.mem_write(OBJECT,b'\x00'*0x1000)
            p.uc.mem_write(OBJECT+0x88,struct.pack('<I',OUTPUT))
            p.uc.mem_write(OUTPUT,b'\xa5'*32)
            p.call(manifest['entries']['rawFullFrame'],OBJECT+0x400,OBJECT,identity,0,float_value=magnification)
            actual=struct.unpack('<4H',p.uc.mem_read(OUTPUT+8,8))
            assert actual==(6000,4000,68,40),(identity,magnification,actual)
            assert bytes(p.uc.mem_read(OUTPUT,8))==b'\xa5'*8
            assert bytes(p.uc.mem_read(OUTPUT+16,16))==b'\xa5'*16
            # The shared crop calculator remains selected-ratio aware.
            dims=p.dimensions(identity,0,magnification)
            if identity!=0:assert (dims['width'],dims['height'])!=(6000,4000)
            rawcases+=1;calls+=2
    return dict(calls=calls,stale_native_mode_reproduced=stale,
        face_detection_modes_independent_of_previous_state=True,native_ids_unchanged=True,
        raw_descriptor_cases=rawcases,raw_default_crop=[6000,4000],raw_origin=[68,40],
        jpeg_dimensions_still_cropped=True,hardware_tested=False,
        scope='Native face-detection descriptor branches and DNG descriptor writer. Display DMA and physical post-capture flicker are not tested here.')

if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser();ap.add_argument('rtos',type=Path);ap.add_argument('manifest',type=Path)
    args=ap.parse_args();print(json.dumps(verify(args.rtos.read_bytes(),json.loads(args.manifest.read_text())),indent=2))
