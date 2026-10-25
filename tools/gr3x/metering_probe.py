"""Execute native IIIx map allocation/clone and custom AE/AWB view construction."""
import argparse
import json
import struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe, u32, put
from pipeline_probe import rect
from native_probe import STACK

MAP, COPY = 0x62080000,0x62081000
HEAP=0x63000000
VIEW_BYTES=304+12*36

class MeteringProbe(AdjProbe):
    def __init__(self,data,manifest):
        self.allocs=[];self.frees=[];self.cursor=HEAP
        super().__init__(data,manifest)
        self.uc.mem_map(HEAP,0x400000)
    def _hook(self,cpu,at,size,user):
        if at==0x536af2a8:
            size=cpu.reg_read(reg.UC_ARM_REG_R0)
            assert 0<size<0x10000
            base=(self.cursor+31)&~15;end=base+size
            cpu.mem_write(base-16,b'\xa5'*(size+32))
            self.allocs.append((base,size));self.cursor=end+32
            cpu.reg_write(reg.UC_ARM_REG_R0,base)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==0x536af2e4:
            self.frees.append(cpu.reg_read(reg.UC_ARM_REG_R0))
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)

def verify(data,manifest):
    n=MeteringProbe(data,manifest);cpu=n.uc;calls=0;m=n.menu
    # map.c keeps seven rows; rows after the last added ratio hold the full 3:2 view.
    views=[(i,num,den,rect(720,480,num,den)) for i,num,den in m.custom]+[(i,1,1,[0,0,720,480]) for i in range(m.max_id+1,11)]
    assert [v[0] for v in views]==list(range(4,11))
    for owner in (MAP,COPY):
        cpu.mem_write(owner,b'\xa5'*336)
        n.call(0x5365d754,owner);n.call(0x5365d900,owner);calls+=2
        primary=[u32(cpu,owner+4+4*i) for i in range(24)]
        sizes=dict(n.allocs)
        assert sizes[primary[0]]==36+7*VIEW_BYTES
        assert all(sizes[p]==34 for p in primary[1:])
        assert bytes(cpu.mem_read(owner+304,32))==b'\xa5'*32
    first=u32(cpu,MAP+4);sro=u32(cpu,MAP+0x90)
    for strip_count in (1,2,3):
        originals={}; strips={}
        for process in range(4):
            for mag in range(3):
                index=process*6+mag
                bw,bh,ox,oy=80+process*8,60+mag*8,20,24
                countx,county=64,62
                starts=[i*(bw*countx//strip_count) for i in range(3)]
                native_counts=[];local=[];prior=0
                for i in range(3):
                    if i>=strip_count:native_counts.append(0);local.append(0);continue
                    stop=countx if i+1==strip_count else min(countx,max(0,(starts[i+1]-ox+bw-1)//bw))
                    native_counts.append(stop-prior);local.append(ox+prior*bw-starts[i]);prior=stop
                record=[1,ox,oy,bw,bh,countx,county,bw,bh,bw,bh,*local,*native_counts]
                raw=struct.pack('<17H',*record)
                primary=u32(cpu,MAP+4+4*index);cpu.mem_write(primary,raw)
                strip=u32(cpu,sro+4*index)
                fields=[0,0,*starts,*([bw*countx//strip_count]*3),0,0,0,0,0,0]
                cpu.mem_write(strip,struct.pack('<14H',*fields))
                originals[index]=(primary,record,raw);strips[index]=fields
        for identity,num,den,screen in views:
            out=n.call(manifest['entries']['mapView'],MAP,identity);calls+=1
            assert out==first+36+(identity-4)*VIEW_BYTES
            for index,(primary,old,raw) in originals.items():
                at=u32(cpu,out+4+4*index)
                process,mag=divmod(index,6)
                assert at==out+304+(process*3+mag)*36
                got=list(struct.unpack('<17H',cpu.mem_read(at,34)))
                w=(old[3]*screen[2]//720)&~1;h=(old[4]*screen[3]//480)&~1
                x=(old[1]+(old[3]-w)*old[5]//2)&~1;y=(old[2]+(old[4]-h)*old[6]//2)&~1
                assert got[:11]==[1,x,y,w,h,64,62,w,h,w,h]
                assert sum(got[14:17])==64 and all(0<=v<=64 for v in got[14:17])
                prior=0
                for i in range(3):
                    count=got[14+i]
                    if count:
                        assert got[11+i]+strips[index][2+i]==x+prior*w
                        if i+1<strip_count:assert x+(prior+count-1)*w<strips[index][3+i]
                        if i>0:assert x+prior*w>=strips[index][2+i]
                    else:assert got[11+i]==0
                    prior+=count
                assert bytes(cpu.mem_read(primary,34))==raw
            # SRO, CIS, PPU and native non-selected record pointers remain the owner's.
            assert bytes(cpu.mem_read(out+0x64,304-0x64))==bytes(cpu.mem_read(MAP+0x64,304-0x64))
        # The original deep clone executes before rebinding every appended view.
        n.call(0x5365e2dc,COPY,MAP);calls+=1
        copied_first=u32(cpu,COPY+4)
        for identity,_,_,_ in views:
            src=first+36+(identity-4)*VIEW_BYTES;dst=copied_first+36+(identity-4)*VIEW_BYTES
            assert bytes(cpu.mem_read(dst+304,12*36))==bytes(cpu.mem_read(src+304,12*36))
            assert u32(cpu,dst+0x90)==u32(cpu,COPY+0x90)!=u32(cpu,MAP+0x90)
            for process in range(4):
                for mag in range(3):assert u32(cpu,dst+4+4*(process*6+mag))==dst+304+(process*3+mag)*36
    for identity in (0,1,2,3,11,255):
        assert n.call(manifest['entries']['mapView'],MAP,identity)==MAP;calls+=1
    # Every interior wrapper must preserve live registers and flags, except its
    # explicitly displaced instruction and documented custom index normalization.
    for identity in (0,1,*[i for i,_,_ in m.custom]):
        view=first+36+(identity-4)*VIEW_BYTES if identity>=4 else MAP
        index=13+3*identity
        for site in (0x535001b0,0x535002e4,0x53501b90,0x535071dc,0x5350a24c,
                     0x5350a454,0x5350ca4c,0x5350cb88,0x53525798):
            values=[0x620a0000+i*0x1000 for i in range(13)];values[11]=STACK+256
            if site==0x535001b0:
                put(cpu,values[3]+0xba8,MAP);values[4]=identity;dest,norm,idx=12,4,None
            elif site in (0x535002e4,0x53501b90):
                put(cpu,values[4]+0xba8,MAP);values[8]=identity;dest,norm,idx=(1 if site==0x535002e4 else 3),8,None
            elif site==0x535071dc:
                put(cpu,values[3]+0xa10,MAP);put(cpu,values[5]+0x34,0x620c0000)
                cpu.mem_write(0x620c07b6,bytes([identity]));values[4]=index;dest,norm,idx=1,None,4
            elif site==0x5350a24c:
                put(cpu,values[10]+0xa10,MAP);put(cpu,values[11]-0x34,identity)
                put(cpu,values[3]+0x2c,identity);dest,norm,idx=4,None,None
            elif site==0x5350a454:
                put(cpu,values[8]+0xa10,MAP);values[7]=identity;dest,norm,idx=3,7,None
            elif site in (0x5350ca4c,0x5350cb88):
                owner=5 if site==0x5350ca4c else 4;dest=owner+1
                put(cpu,values[owner]+0x34,0x620c0000);cpu.mem_write(0x620c07b6,bytes([identity]))
                values[dest]=MAP;values[0]=index;norm,idx=None,0
            else:
                values[7]=MAP;values[8]=identity;values[2]=index;dest,norm,idx=7,None,2
            for i,v in enumerate(values):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
            cpu.reg_write(reg.UC_ARM_REG_SP,STACK);cpu.reg_write(reg.UC_ARM_REG_LR,0x620ff000)
            cpu.reg_write(reg.UC_ARM_REG_CPSR,0xa0000013)
            cpu.emu_start(site,site+4,count=100000)
            expected=list(values);expected[dest]=view
            if identity>=4:
                if norm is not None:expected[norm]=0
                if idx is not None:expected[idx]-=3*identity
            if site in (0x5350ca4c,0x5350cb88):expected[dest]+=4*expected[0]
            if site==0x53525798:expected[2]=view+4*expected[2]
            got=[cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)]
            assert got==expected,(hex(site),identity,got,expected)
            assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
            assert cpu.reg_read(reg.UC_ARM_REG_CPSR)&0xf0000000==0xa0000000
            if site==0x5350a24c:
                expected_id=0 if identity>=4 else identity
                assert u32(cpu,values[11]-0x34)==u32(cpu,values[3]+0x2c)==expected_id
            calls+=1
    for at,size in n.allocs:
        assert bytes(cpu.mem_read(at-16,16))==bytes(cpu.mem_read(at+size,16))==b'\xa5'*16,(hex(at),size)
    return dict(calls=calls,native_map_constructor_and_allocator_executed=True,native_deep_clone_executed=True,
        custom_view_records=7*12*3,one_two_three_strip_partitions=True,all_grid_counts_preserved=True,
        original_records_unchanged=True,clone_owns_all_view_pointers=True,allocation_canaries=True,
        all_nine_consumer_register_and_flag_contracts=True,
        allocator_stubbed=True,hardware_tested=False,scope='Synthetic native-layout AE/AWB grids; hardware ISP not executed.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
