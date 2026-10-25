"""Run the original Xoy shading loops and compare complete output tables.

Added aspects deliberately reuse native 3:2 correction constants. This verifies
CPU-side table construction, not optical calibration or ISP hardware.
"""
import argparse,json,struct
from pathlib import Path
from native_probe import NativeProbe,OBJECT,OUTPUT
from adj_probe import AdjProbe

def tables(n,aspect,amount,mode,mag,width,height):
    n.uc.mem_write(OBJECT,bytes(0x100))
    n.uc.mem_write(OBJECT+0x8a,bytes([mode]))
    n.uc.mem_write(OBJECT+0xf2,bytes([aspect]))
    n.uc.mem_write(OBJECT+0xf4,struct.pack('<f',mag))
    n.uc.mem_write(OUTPUT,b'\xa5'*0x1000)
    n.call(0x536efbb4,OUTPUT+8,OUTPUT+0x808,width,height,
           stack=struct.pack('<3I',amount,0,OBJECT))
    for at,count in ((OUTPUT+8,width),(OUTPUT+0x808,height)):
        assert n.uc.mem_read(at-8,8)==n.uc.mem_read(at+count*2,8)==b'\xa5'*8
    assert n.uc.mem_read(OBJECT+0xf2,1)==bytes([aspect])
    return bytes(n.uc.mem_read(OUTPUT,0x1000))

def verify(data,manifest):
    old=NativeProbe(data);new=AdjProbe(data,manifest);calls=0
    for amount in list(range(10))+[255]:
        for mode in (0,1):
            for mag in (1.,1.25,struct.unpack('<f',struct.pack('<I',0x3fe49249))[0]):
                for width,height in ((17,13),(32,24),(65,49)):
                    baseline=tables(old,0,amount,mode,mag,width,height);calls+=1
                    for aspect in range(new.menu.max_id+1):
                        got=tables(new,aspect,amount,mode,mag,width,height);calls+=1
                        if aspect in (1,2,3):
                            expected=tables(old,aspect,amount,mode,mag,width,height);calls+=1
                        else:expected=baseline
                        assert got==expected,(aspect,amount,mode,mag,width,height)
    return dict(calls=calls,native_shading_loops=True,all_native_profiles_unchanged=True,
        added_aspects_use_native_3_2_profile=True,setting_not_modified=True,
        odd_and_even_table_sizes=True,memory_canaries=True,hardware_tested=False,
        scope='CPU-side shading tables; added crops reuse native 3:2 constants. No optical or ISP validation.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
