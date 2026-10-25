"""Compare native and patched IIIx display functions across their resolution modes."""
import argparse,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from native_probe import NativeProbe,OBJECT,STACK
from adj_probe import AdjProbe,put
from rear_dial_probe import USERDATA
from pipeline_probe import rect

class LiveProbe(AdjProbe):
    def _hook(self,cpu,at,size,user):
        if at in (0x53654150,0x53654220):
            cpu.reg_write(reg.UC_ARM_REG_R0,0x62090000 if at==0x53654150 else 0)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)

def verify(data,manifest):
    n=LiveProbe(data,manifest);old=NativeProbe(data);calls=0
    for mode in (0,2):
        for resolution in range(1,32):
            for r2,r3 in ((0,0),(0,1),(1,0),(1,1)):
                for entry,axis,comparison in ((0x53668774,0,3),(0x53668be4,1,1)):
                    native=[]
                    for machine in (old,n):
                        machine.uc.mem_write(OBJECT,bytes([0]*5+[mode, resolution,0]))
                    for identity in range(4):
                        stack=struct.pack('<II',mode,identity)
                        value=old.call(entry,OBJECT,resolution,r2,r3,stack=stack)
                        assert n.call(entry,OBJECT,resolution,r2,r3,stack=stack)==value
                        native.append(value);calls+=2
                    for identity,num,den in n.menu.custom:
                        screen=rect(720,480,num,den)
                        expected=native[0]
                        if native[comparison]!=native[0]:
                            expected=(native[0]*screen[2+axis]//(720 if axis==0 else 480)+1)&~1
                        if axis==1 and screen[3]<480:expected&=~3
                        got=n.call(entry,OBJECT,resolution,r2,r3,stack=struct.pack('<II',mode,identity))
                        assert got==expected,(mode,resolution,r2,r3,identity,axis,native,got,expected)
                        calls+=1
    for identity in range(n.menu.max_id+1):
        n.state(identity);n.uc.mem_write(USERDATA+0x7b6,bytes([identity]))
        n.uc.mem_write(OBJECT+4,b'\xff')
        assert n.call(0x53669424,OBJECT,1)==([0,2,1,3][identity] if identity<4 else identity)
        assert n.uc.mem_read(OBJECT+4,1)[0]==([0,2,1,3][identity] if identity<4 else identity)
        calls+=1
    # Interior ROI hooks: verify changed dimensions, preserved registers and original flags.
    cpu=n.uc
    for identity,num,den in n.menu.custom:
        sw,sh=rect(720,480,num,den)[2:]
        for site,flags in ((0x53459458,0x13),(0x53459bd4,0x20000013),(0x53459bd4,0x80000013)):
            vals=[0x620a0000+i*64 for i in range(13)]
            vals[2]=256;vals[5]=960;vals[6]=1440;vals[10]=identity;vals[11]=STACK+256
            for i,v in enumerate(vals):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
            cpu.reg_write(reg.UC_ARM_REG_LR,0x620ff000);cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
            cpu.reg_write(reg.UC_ARM_REG_CPSR,flags);cpu.mem_write(vals[11]-100,b'\xa5'*4)
            cpu.emu_start(site,site+4,count=10000)
            got=[cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)]
            expected=list(vals);expected[5]=(960*sh//480+1)&~1;expected[6]=(1440*sw//720+1)&~1
            if sh<480:expected[5]&=~3
            assert got==expected,(hex(site),got,expected)
            assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
            if site==0x53459bd4:
                assert cpu.reg_read(reg.UC_ARM_REG_CPSR)&0xf0000000==flags&0xf0000000
                stored=struct.unpack('<I',cpu.mem_read(vals[11]-100,4))[0]
                assert stored==(expected[5] if not flags&0x20000000 else 0xa5a5a5a5)
            calls+=1
    return dict(calls=calls,resolutions=31,native_modes_unchanged=True,custom_dimension_modes=True,
        public_hardware_identity_and_cache=True,roi_registers_and_flags_preserved=True,
        hardware_tested=False,scope='Native display dimension functions and ROI joins, not live sensor/display hardware.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
