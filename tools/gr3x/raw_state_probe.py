"""Exercise RAW menus, native transactional property writes and metadata rectangles."""
import argparse,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from native_probe import OBJECT,OUTPUT,STACK
from adj_probe import AdjProbe,put,u32,VIEW
from rear_dial_probe import USER,MODEL,USERDATA,DATA,SELECTOR
from pipeline_probe import crop,rect
from ratio_menu import parse

def branch(at,target,link=False):return (0xeb000000 if link else 0xea000000)|(((target-at-8)//4)&0xffffff)
SHIM=0x54100000

class StateProbe(AdjProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest)
        self.uc.mem_map(SHIM,0x1000)
        # Queue substitution preserves the real IIIx command handlers and model transaction.
        words=[0xe3510001,branch(SHIM+4,SHIM+44),0xe59dc000,0xe92d4010,
               0xe1a0400c,0xe1a01003,branch(SHIM+24,0x535423a0,True),
               0xe5c40000,0xe8bd4010,0xe3a00000,0xe12fff1e,
               0xe1a01003,0xe3a02000,branch(SHIM+52,0x535423ac)]
        words[1]=(words[1]&0x0fffffff) # conditional EQ
        self.uc.mem_write(SHIM,struct.pack('<'+'I'*len(words),*words))
        try:self.uc.mem_map(0x55357000,0x1000)
        except Exception:pass  # already mapped with the zero-filled RAM (adj_probe)
    def _hook(self,cpu,at,size,user):
        if at==0x5354b564:
            assert cpu.reg_read(reg.UC_ARM_REG_R1) in (1,2)
            assert cpu.reg_read(reg.UC_ARM_REG_R2)==0xd4
            cpu.reg_write(reg.UC_ARM_REG_PC,SHIM)
        else:super()._hook(cpu,at,size,user)
    def model(self):
        self.uc.mem_write(USERDATA,bytes(0x1040));self.uc.mem_write(USERDATA+0x2000,bytes(0x1040))
        put(self.uc,MODEL,USERDATA);put(self.uc,MODEL+4,USERDATA+0x2000);put(self.uc,MODEL+8,0)

def verify(data,manifest):
    n=StateProbe(data,manifest);cpu=n.uc;calls=0
    entries=manifest['entries'];rows=manifest['ratios'];ids=[r['id'] for r in rows]
    fr={i:parse(r) for r,_,i in n.menu.rows}
    dims={i:crop(6000,4000,f.numerator,f.denominator) for i,f in fr.items()}
    codes={i:1 if i==0 else 2 if i==3 else i-1 for i in ids}
    for source in ids:
        n.state(source);n.model();put(cpu,OBJECT+0x24,OUTPUT);put(cpu,OBJECT+0x18,MODEL)
        cpu.mem_write(OUTPUT,bytes(0x1000));cpu.mem_write(OUTPUT+0x7b6,bytes([source]))
        expected=[i for i in ids if all(a<=b for a,b in zip(dims[i],dims[source]))]
        for unchanged in (0,1):
            cpu.mem_write(OBJECT+5,bytes([unchanged]))
            assert n.call(0x5328330c,OBJECT)==len(expected)+unchanged;calls+=1
            for index,target in enumerate(([None] if unchanged else [])+expected):
                code=0 if target is None else codes[target]
                assert n.call(0x532833e4,OBJECT,index)==code
                assert n.call(0x53289e8c,OBJECT,code)==(source if target is None else target)
                if target is not None:
                    row=next(r for r in rows if r['id']==target)
                    assert n.call(0x53289efc,OBJECT,code)==row['iconId']
                    assert n.call(0x53289f38,OBJECT,code)==row['textId'];calls+=2
                n.call(0x5328a01c,OBJECT,code)
                assert cpu.mem_read(u32(cpu,MODEL)+0x7b6,1)[0]==(source if target is None else target)
                assert n.call(0x535516ec,MODEL)==(source if target is None else target)
                calls+=4
            assert n.call(0x532833e4,OBJECT,255)==0;calls+=1
        # Native raw save/restore transient selection retains a custom code.
        cpu.mem_write(OBJECT+0x38b,bytes([codes[source]]));n.call(0x532845a0,OBJECT)
        cpu.mem_write(OBJECT+0x38b,b'\0');n.call(0x5328a024,OBJECT)
        assert cpu.mem_read(OBJECT+0x38b,1)[0]==codes[source];calls+=2
    for identity in ids:
        n.state(0);n.model()
        n.call(0x532525a4,SELECTOR,identity);calls+=1
        assert cpu.mem_read(DATA+0x4c2,1)[0]==identity
        assert n.call(0x5354a778,USER)==identity;calls+=1
        for pointer in (u32(cpu,MODEL),u32(cpu,MODEL+4)):
            assert cpu.mem_read(pointer+0x7b6,1)[0]==identity
        # The original retained-setting copy explicitly copies this byte without enum truncation.
        cpu.reg_write(reg.UC_ARM_REG_R4,OBJECT);cpu.reg_write(reg.UC_ARM_REG_R5,DATA)
        cpu.mem_write(OBJECT+0x4c3,b'\1');cpu.emu_start(0x532489dc,0x532489ec,count=100)
        assert cpu.mem_read(OBJECT+0x4c2,1)[0]==identity;calls+=1
    # Execute selection from every actual ADJ slot through the native handlers
    # and committed model, with all patches present (not a storage-only stub).
    for slot in range(5):
        for index,identity in enumerate(ids):
            n.state(0,slot);n.model()
            n.call(0x531a0dd8,VIEW,index);calls+=1
            assert cpu.mem_read(DATA+0x4c2,1)[0]==identity
            assert n.call(0x5354a778,USER)==identity;calls+=1
            for pointer in (u32(cpu,MODEL),u32(cpu,MODEL+4)):
                assert cpu.mem_read(pointer+0x7b6,1)[0]==identity
    for identity,nu,de in n.menu.custom:
        # Common-property gating must match native 3:2 even in the restricted mode.
        for mode in (0,1,2,3):
            for current in (0,1):
                for ptr in (u32(cpu,MODEL),u32(cpu,MODEL+4)):cpu.mem_write(ptr+0x6c0,bytes([mode]))
                got=n.call(0x5355445c,MODEL,identity,current)
                assert got==n.call(0x5355445c,MODEL,0,current);calls+=2
        for bits,at,base in ((0x3f800000,0x55357d40,(45<<16,30<<16,0,0)),
            (0x3fa00000,0x55357e24,(2359296,1572864,294912,196608)),
            (0x3fe49249,0x55357e78,(1651508,1101005,648806,432537))):
            cpu.mem_write(at,struct.pack('<4I',*base));put(cpu,OBJECT+8,OUTPUT)
            cpu.mem_write(OUTPUT+0x7b6,bytes([identity]));put(cpu,OUTPUT+0x7b8,bits)
            cpu.mem_write(OUTPUT+0x69c,b'\xa5'*24)
            n.call(0x535ee890,OBJECT);calls+=1
            sw,sh=rect(720,480,nu,de)[2:];w=base[0]*sw//720;h=base[1]*sh//480
            expected=(w,h,base[2]+(base[0]-w)//2,base[3]+(base[1]-h)//2)
            assert struct.unpack('<4I',cpu.mem_read(OUTPUT+0x6a0,16))==expected
            assert cpu.mem_read(OUTPUT+0x69c,4)==cpu.mem_read(OUTPUT+0x6b0,4)==b'\xa5'*4
    return dict(calls=calls,raw_menu_count_items_icons_text=True,raw_unchanged_and_restore=True,
        raw_conversion_and_native_apply=True,adj_native_property_handlers_and_transaction=True,
        current_and_shadow_settings_retain_identity=True,native_retained_setting_copy=True,
        all_five_adj_slots_through_native_property_transaction=True,
        shooting_mode_restriction_preserved=True,native_metadata_magnification_lookup=True,
        metadata_rectangle_canaries=True,hardware_tested=False,
        scope='Actual property handlers and RAM transactions; queue delivery substituted. Power-cycle storage and U-mode file I/O not emulated.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
