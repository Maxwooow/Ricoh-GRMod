"""Execute IIIx image/AF patches, including native helpers and interior joins.

This is a function-level test with synthetic objects, not a JPEG encoder or camera.
"""
import argparse
import json
import math
import struct
from pathlib import Path
from unicorn import arm_const as reg
from native_probe import NativeProbe, BASE, OBJECT, OUTPUT, STACK, STOP
from adj_probe import AdjProbe, VIEW, SOURCE, DEST, CHILD, put
from rear_dial_probe import SELECTOR

from ratio_menu import menu as menu_of
# T4 identities; a probe takes its own list from the manifest's menu (custom(manifest)).
CUSTOM = [(4,4,3),(5,16,9),(6,65,24),(7,17,6),(8,3,4),(9,7,6),(10,5,4)]
def custom(manifest): return menu_of(manifest).custom
BASE_SIZES = [(6000,4000),(4800,3200),(3360,2240),(1920,1280)]

def crop(w,h,n,d):
    if n*h >= d*w: return w,4*((w*d+2*n)//(4*n))
    return 4*((h*n+2*d)//(4*d)),h

def rect(w,h,n,d):
    a,b=crop(w,h,n,d)
    return [(w-a)//2,(h-b)//2,a,b]

def u16(cpu,at):return struct.unpack('<H',cpu.mem_read(at,2))[0]
def regs(cpu):return [cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)]

def verify(data,manifest):
    n=AdjProbe(data,manifest);cpu=n.uc;old=NativeProbe(data);calls=0
    top=n.menu.max_id
    # Execute the real call-site wrapper: metadata must survive size-based
    # classification, while non-custom metadata retains the native classifier.
    for identity in range(256):
        cpu.mem_write(SOURCE+0x7b6,bytes([identity]))
        for size in ((6000,4000),(6000,2216),(3000,4000),(4000,4000)):
            for machine in (n,old):machine.uc.mem_write(OUTPUT,struct.pack('<2I',*size))
            expected=identity if 4<=identity<=top else old.call(0x534d2954,OUTPUT)
            cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13);cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
            cpu.reg_write(reg.UC_ARM_REG_R0,OUTPUT);cpu.reg_write(reg.UC_ARM_REG_R7,SOURCE)
            cpu.emu_start(0x534d59a8,0x534d59ac,count=10000)
            assert cpu.reg_read(reg.UC_ARM_REG_R0)==expected
            assert cpu.reg_read(reg.UC_ARM_REG_R7)==SOURCE
            assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
            calls+=1
        for classified in range(top+1):
            saved=[0x12340000+i for i in range(13)]
            saved[8]=SOURCE;saved[10]=classified
            for i,v in enumerate(saved):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
            cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13);cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
            cpu.emu_start(0x534c2030,0x534c2050,count=1000)
            expected=list(saved)
            if 4<=identity<=top:expected[10]=identity
            expected[12]=[0,2,1,3][expected[10]] if expected[10]<4 else expected[10]
            assert regs(cpu)==expected,(identity,classified,regs(cpu),expected)
            assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
            calls+=1
    for identity,num,den in n.menu.custom:
        screen=rect(720,480,num,den);thumb=rect(160,120,num,den)
        for size in BASE_SIZES:
            output=crop(*size,num,den)
            # The real allocation helper uses RGB24, YUV422 or YUV420. Execute
            # it with the wrapped dimensions, and keep the image's size intact.
            cpu.mem_write(OUTPUT,b'\xa5'*24)
            cpu.mem_write(OUTPUT+8,struct.pack('<2I',*output))
            before=bytes(cpu.mem_read(OUTPUT,24))
            for fmt,factor in ((1,3),(3,2),(4,1.5)):
                got=n.call(manifest['entries']['allocation'],OUTPUT+8,fmt)
                assert got==output[0]*((output[1]+7)&~7)*factor
                assert bytes(cpu.mem_read(OUTPUT,24))==before
                calls+=1
            put(cpu,SOURCE,output[0]);put(cpu,SOURCE+4,output[1])
            for entry,expected in ((0x534d5e14,screen),(0x534d5fe4,thumb)):
                cpu.mem_write(DEST,b'\xa5'*32)
                assert n.call(entry,DEST+8,OBJECT,SOURCE)==DEST+8
                assert list(struct.unpack('<4I',cpu.mem_read(DEST+8,16)))==expected
                assert bytes(cpu.mem_read(DEST,8))==bytes(cpu.mem_read(DEST+24,8))==b'\xa5'*8
                calls+=1
        for entry,expected in ((0x536a2f50,screen[:2]),(0x536a3008,thumb[:2])):
            cpu.mem_write(OUTPUT,b'\xa5'*8)
            n.call(entry,OBJECT,identity,OUTPUT+2,OUTPUT+4)
            assert [u16(cpu,OUTPUT+2),u16(cpu,OUTPUT+4)]==expected
            assert bytes(cpu.mem_read(OUTPUT,2))==bytes(cpu.mem_read(OUTPUT+6,2))==b'\xa5'*2
            calls+=1
        for size in BASE_SIZES+[(720,480),(160,120),(4096,3000),(1024,680)]:
            expected=crop(*size,num,den)
            assert n.call(manifest['entries']['cropSize'],*size,identity)==expected[0]
            assert cpu.reg_read(reg.UC_ARM_REG_R1)==expected[1]
            calls+=1
            # Already-sized descriptors must not be cropped twice.
            assert n.call(manifest['entries']['cropSize'],*expected,identity)==expected[0]
            assert cpu.reg_read(reg.UC_ARM_REG_R1)==expected[1]
            calls+=1
        for magnification in (1.,1.25,1.78):
            for bypass in (0,1):
                cpu.mem_write(SOURCE,bytes(0x800));cpu.mem_write(SOURCE+0x7b6,bytes([identity]))
                cpu.mem_write(SOURCE+0x7b8,struct.pack('<f',magnification))
                put(cpu,OBJECT+0x10,OUTPUT)
                n.call(0x5350304c,OBJECT,SOURCE,bypass)
                coefficient=struct.unpack('<f',cpu.mem_read(OUTPUT+8,4))[0]
                expected=math.hypot(screen[2],screen[3])/math.hypot(720,480)/(magnification if bypass==0 else 1)
                assert math.isclose(coefficient,expected,rel_tol=2e-7)
                calls+=1
        # Execute the descriptor hook through its original join. Every output
        # register is checked, with a bounded stop before native descriptor writes.
        for w,h in BASE_SIZES+[(720,480),(160,120)]:
            cpu.mem_write(DEST,bytes(256));cpu.mem_write(DEST+0x78,struct.pack('<HH',w,h))
            cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
            cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
            cpu.reg_write(reg.UC_ARM_REG_LR,DEST)
            cpu.reg_write(reg.UC_ARM_REG_R1,identity)
            saved={i:0x12340000+i for i in range(4,10)}
            for i,v in saved.items():cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
            cpu.emu_start(0x535037c4,0x535038f4,count=10000)
            cw,ch=crop(w,h,num,den)
            result=regs(cpu)
            assert result[:4]==[ch,(w-cw)//2,(h-ch)//2,cw]
            assert result[10]==h and result[12]==w
            assert cpu.reg_read(reg.UC_ARM_REG_LR)==DEST and cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
            assert all(result[i]==v for i,v in saved.items())
            calls+=1
        # Full original AF rectangle/size functions; only singleton retrieval is substituted.
        n.state(identity)
        n.call(0x532afbb4,SELECTOR,DEST)
        expected=[max(80,screen[0]),max(60,screen[1]),min(640,screen[0]+screen[2]),min(420,screen[1]+screen[3])]
        actual=list(struct.unpack('<4I',cpu.mem_read(DEST,16)))
        assert actual==expected[:2]+[expected[2]-expected[0],expected[3]-expected[1]],(identity,actual,expected)
        calls+=1
        for selector,scale in ((0,1),(15,.6)):
            n.call(0x532afd48,DEST,0,selector)
            expected_size=[int((expected[2]-expected[0])*scale),int((expected[3]-expected[1])*scale)]
            assert list(struct.unpack('<2I',cpu.mem_read(DEST,8)))==expected_size
            calls+=1
    # All four native identities retain their original image-correction outputs.
    for identity in range(4):
        for machine in (old,n):
            machine.uc.mem_write(SOURCE,bytes(0x800));machine.uc.mem_write(SOURCE+0x7b6,bytes([identity]))
            machine.uc.mem_write(SOURCE+0x7b8,struct.pack('<f',1.25))
            put(machine.uc,OBJECT+0x10,OUTPUT)
            machine.call(0x5350304c,OBJECT,SOURCE,0)
        assert bytes(cpu.mem_read(OUTPUT,12))==bytes(old.uc.mem_read(OUTPUT,12))
        calls+=2
    return dict(calls=calls,exact_size_playback_rectangles=True,screen_and_thumbnail_origins=True,
        full_native_lens_coefficient_function=True,develop_join_registers_checked=True,
        crop_descriptor_idempotent=True,full_native_af_functions=True,memory_canaries=True,
        native_playback_allocation_helper=True,image_size_not_padded=True,
        replay_identity_gate_all_byte_values=True,native_size_classifier_fallback=True,
        hardware_tested=False,scope='Native image geometry and AF functions; no hardware ISP or complete JPEG/DNG encoding.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
