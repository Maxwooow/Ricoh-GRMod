"""Execute IIIx's own key checker and mode-set keyword parser.
No filesystem writes or camera commands. Firmware input is hash guarded.
"""
import argparse,json,struct
from pathlib import Path
from native_probe import NativeProbe,OBJECT,OUTPUT
from unicorn import arm_const as reg

def model_probe(data):
    p=NativeProbe(data)
    p.call(0x53536608,OBJECT)  # Native BlkCtl15 object constructor.
    u32=lambda at:struct.unpack('<I',p.uc.mem_read(at,4))[0]
    assert u32(OBJECT+8)==0x56
    name=u32(OBJECT+0x14)
    assert bytes(p.uc.mem_read(name,16)).split(b'\0')[0]==b'E:\\BlkCtl15.bin'
    assert u32(u32(OBJECT)+0x34)==0x53533ebc  # 32-byte native read method.
    # Run the SystemConfig magic/product branches on this object's data.
    # No filesystem or I/O is emulated. Stop before model-specific side effects.
    p.uc.mem_map(0x5536d000,4096)
    p.uc.mem_write(OBJECT+0x1c,struct.pack('<I',OUTPUT))
    results=[]
    for magic,product,expected in [(0xa55a5aa5,0x1329c,'GR IIIx HDF'),
                                   (0xa55a5aa5,0x1329a,'GR IIIx'),
                                   (0,0x1329c,None)]:
        p.uc.mem_write(OUTPUT,struct.pack('<8I',magic,product,0,0,0,0,0,0))
        p.uc.reg_write(reg.UC_ARM_REG_R4,OBJECT)
        p.uc.reg_write(reg.UC_ARM_REG_R7,OUTPUT)
        p.uc.reg_write(reg.UC_ARM_REG_SP,0x610ff000)
        p.uc.reg_write(reg.UC_ARM_REG_FP,0x610feff0)
        p.uc.emu_start(0x536b4244,0x536b427c,timeout=2_000_000,count=1000)
        assert p.uc.reg_read(reg.UC_ARM_REG_PC)==0x536b427c
        record=u32(0x5536d054)
        model=bytes(p.uc.mem_read(u32(record+12),32)).split(b'\0')[0].decode('ascii')
        if expected:assert model==expected,(hex(product),model)
        else:assert record!=0x53d62124
        results.append({'magic':hex(magic),'product':hex(product),'selected_model':model})
    return results

def verify(data):
    p=NativeProbe(data);calls=0
    project=p.call(0x5381fe4c);product=p.call(0x5381fe9c);calls+=2
    assert (project,product)==(p.profile['project'],p.profile['product'])
    key=data[0xd628a0:0xd628aa]
    for valid in (True,False):
        content=bytearray(key+b'\x00')
        if not valid:content[0]^=1
        p.uc.mem_write(OBJECT,bytes(content))
        result=p.call(0x536bf750,OBJECT);calls+=1
        assert result==int(valid)
        assert p.uc.mem_read(OBJECT+10,1)[0]==int(valid)
    p.call(0x536be7c0,OBJECT);calls+=1
    for text,flag in [('OPEN_FACTORY_DEBUG_MENU',4),('SCRIPT_EN_MODE EN',1),('NOT_A_FACTORY_KEYWORD',None)]:
        p.uc.mem_write(OUTPUT,text.encode()+b'\x00')
        p.uc.mem_write(OUTPUT+0x100,b'\x00'*32)
        result=p.call(0x536bdd80,OBJECT,OUTPUT,OUTPUT+0x100);calls+=1
        flags=bytes(p.uc.mem_read(OUTPUT+0x100,32))
        assert result==int(flag is not None),(text,result)
        assert flags==bytes(1 if i==flag else 0 for i in range(32)),(text,flags)
    return dict(calls=calls,mode_set_name=f'{product:08d}.{project:03d}',
        valid_key_accepted=True,altered_key_rejected=True,factory_menu_keyword_accepted=True,
        script_enable_keyword_accepted=True,unknown_keyword_rejected=True,
        wallpaper_model_checks=model_probe(data),
        hardware_tested=False,scope='Native key/keyword functions, model block constructor and SystemConfig branches. SD filesystem, persistent writes and physical factory menu are not emulated.')

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('rtos',type=Path);a=ap.parse_args()
    print(json.dumps(verify(a.rtos.read_bytes()),indent=2))
