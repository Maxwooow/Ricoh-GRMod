"""Execute native version checks, partition accounting and BOOT read arguments.

Disk I/O is replaced by a recording stub. BOOT execution stops BEFORE block I/O.
This does not emulate an update, camera startup, recovery, or flash hardware.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from native_probe import NativeProbe,OBJECT,OUTPUT,STACK,BASE
from adj_probe import put,u32
from identity import by_container

HEADER=0x62018000
USER=0x62040000
MODEL=0x62041000
PROPS=0x62042000
COMBINED=0x62043000
DISK=0x62044000
VTABLE=0x62045000
TABLE=0x62080000
BOOT_BASE=0x50b00000
BOOT_SHA='b86df5098937ca09e31afe4a06d4d9eaa261ab287c4626c24f32ee7fd9e95f48'

class LoaderProbe(NativeProbe):
    def __init__(self,data):
        self.disk_requests=[]
        super().__init__(data)
    def _hook(self,cpu,at,size,user):
        if at==0x536b82d4:
            cpu.reg_write(reg.UC_ARM_REG_R0,0)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==0x5362c6c8:
            self.disk_requests.append([cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(4)])
            cpu.reg_write(reg.UC_ARM_REG_R0,1)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)

def verify(data,boot,official,candidate,build):
    assert hashlib.sha256(boot).hexdigest()==BOOT_SHA
    assert hashlib.sha256(official).hexdigest()==build['inputSha256']
    assert hashlib.sha256(candidate).hexdigest()==build['outputSha256']
    assert candidate[0x38:0x3c]==official[0x38:0x3c]
    assert candidate[0x50:0x54]==official[0x50:0x54]
    dsp,cpu_ver=(struct.unpack_from('>I',candidate,o)[0] for o in (0x38,0x50))
    assert dsp==cpu_ver==by_container(official)['version_word']
    n=LoaderProbe(data);cpu=n.uc;calls=0
    cpu.mem_write(HEADER,candidate[:128])
    for at,v in ((OBJECT+8,USER),(OBJECT+0x38,HEADER),(OBJECT+0x24,COMBINED),
                 (USER+0x518,MODEL),(MODEL,PROPS),(COMBINED+12,OUTPUT)):
        put(cpu,at,v)
    comparisons=[]
    # Type 6 is a separate CPU-only file format; this is a combined container.
    for kind in (0,1,2,3,4):
        put(cpu,OBJECT+0x2c,kind)
        for current_dsp in (dsp-1,dsp,dsp+1):
            for current_cpu in (cpu_ver-1,cpu_ver,cpu_ver+1):
                put(cpu,PROPS+8,current_dsp);put(cpu,PROPS+12,current_cpu)
                expect=(dsp>=current_dsp if kind<2 else dsp>=current_dsp and cpu_ver>=current_cpu)
                got=n.call(0x536284e0,OBJECT);calls+=1
                assert got==int(expect),(kind,current_dsp,current_cpu,got)
                comparisons.append(dict(kind=kind,dsp=current_dsp,cpu=current_cpu,accepted=bool(got)))
    put(cpu,OBJECT+0x38,0)
    assert n.call(0x536284e0,OBJECT)==0;calls+=1

    # Original PARTPARA allocates 0x4000000 bytes for RTOS. The updater stores
    # actual bytes and sectors; the BOOT loader reads those fields in either bank.
    new_length=len(data)+build['rtosGrowth'];capacity=0x4000000;start_sector=0x980
    cpu.mem_write(OBJECT,bytes(0x100));put(cpu,OBJECT+8,DISK);put(cpu,OBJECT+0x14,TABLE)
    put(cpu,DISK,VTABLE);put(cpu,VTABLE+0x48,0x537fb10c)
    cpu.mem_map(BOOT_BASE,(len(boot)+4095)&~4095);cpu.mem_write(BOOT_BASE,boot)
    records=[]
    for bank in (0,1):
        cpu.mem_write(OBJECT+0x10,bytes([bank]))
        record=TABLE+0x870+bank*0x434
        put(cpu,record+8,BASE);put(cpu,record+0x10,start_sector)
        put(cpu,record+0x870+0x10,start_sector+capacity//512)
        for length in (len(data),new_length,capacity,capacity+1):
            n.disk_requests=[];put(cpu,record+0x14,0);put(cpu,record+0x18,0)
            got=n.call(0x5362c82c,OBJECT,1,length,OUTPUT);calls+=1
            if length>capacity:
                assert got==0 and not n.disk_requests
                assert u32(cpu,record+0x14)==u32(cpu,record+0x18)==0
                continue
            count=(length+511)//512
            assert got==1 and n.disk_requests==[[OBJECT,start_sector,length,OUTPUT]]
            assert u32(cpu,record+0x14)==length and u32(cpu,record+0x18)==count
            for explicit_count in (count,0):
                put(cpu,record+0x18,explicit_count)
                cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
                cpu.reg_write(reg.UC_ARM_REG_R3,bank)
                cpu.reg_write(reg.UC_ARM_REG_R5,TABLE)
                cpu.emu_start(0x50b00cbc,0x50b00cf0,count=100)
                assert cpu.reg_read(reg.UC_ARM_REG_PC)==0x50b00cf0
                actual=[cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(3)]
                assert actual==[start_sector,count,BASE]
                assert u32(cpu,STACK+0x2c)==bank
                records.append(dict(bank=bank,bytes=length,sector_count=count,
                                    explicit_count=explicit_count,read_bytes=count*512))
                calls+=1
    assert BASE+new_length<0x55000000
    return dict(calls=calls,firmware_sha256=build['outputSha256'],native_version_checks=True,
        same_version_accepted=True,lower_version_rejected=True,version_raised=False,
        native_partition_capacity_enforced=True,native_partition_size_fields=True,
        native_boot_read_arguments=True,both_partition_banks=True,
        appended_rtos_covered_by_load=True,rtos_bytes=new_length,rtos_capacity=capacity,
        boot_sha256=BOOT_SHA,comparisons=comparisons,boot_reads=records,
        flash_io_stubbed=True,hardware_tested=False,
        scope='Version predicates, partition accounting and BOOT block-read arguments only. No physical update, startup, recovery or flash I/O.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','boot','official','container','build-report','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),a.boot.read_bytes(),a.official.read_bytes(),a.container.read_bytes(),json.loads(a.build_report.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('comparisons','boot_reads')},indent=2))
