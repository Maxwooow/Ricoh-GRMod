"""Execute the IIIx recipe producer and its native ISP descriptor consumer.

T2 borrowed a wider native video aperture while SetupDevelopmentDestinationCh0
still centred it on the 3:2 aperture. A negative origin was stored as uint16.
This probe uses the archived, hash-pinned T2 patchset to reproduce that failure;
the bounds checks do not duplicate the replacement width function's formula.
Hardware I/O is not executed. Source descriptors and state flags are synthetic.
"""
import hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from liveview_probe import LiveProbe
from native_probe import OBJECT
from ratio_menu import menu as menu_of, is_t4

T2_MANIFEST_SHA='5a538ac51f6ac1c5823a3d5cf046f20f5009a800318646680e813212c938e6f0'
WIDE=(5,6,7)

class DevelopmentProbe(LiveProbe):
    def _hook(self,cpu,at,size,user):
        if at==0x536659ac:
            # Only the singleton accessor is substituted. Its returned preview
            # object's dirty flag is zero; geometry/descriptor routines execute.
            cpu.reg_write(reg.UC_ARM_REG_R0,0x62090000)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)

    def recipe(self,identity,resolution,mode=0,flags=(0,0),zoom=8192,allocation_kind='aperture'):
        c=self.uc
        c.mem_write(OBJECT,b'\xa5'*0x10000)
        c.mem_write(OBJECT,bytes(0x600))
        for offset,size in ((0x1000,0x100),(0x2000,0x300),(0x3000,0x200),(0x4000,0x100)):
            c.mem_write(OBJECT+offset,bytes(size))
        c.mem_write(0x62090000,bytes(0x4000))
        def word(offset,value):c.mem_write(OBJECT+offset,struct.pack('<I',value))
        def half(offset,value):c.mem_write(OBJECT+offset,struct.pack('<H',value))
        def byte(offset,value):c.mem_write(OBJECT+offset,bytes([value]))
        word(0xa0,OBJECT+0x1000)
        byte(0x1004,identity);byte(0x1005,mode);byte(0x1006,resolution)
        byte(0x538,1);byte(0x546,flags[0]);byte(0x536,flags[1])
        word(0x9c,OBJECT+0x2000);word(0x56c,OBJECT+0x3000);word(0x168,OBJECT+0x4000)
        c.mem_write(0x62090008,struct.pack('<I',0x62091000))
        # Native common aperture dimensions. These are not the allocator's
        # initial VRAM capacity; keep the two independent in the second fixture.
        cw=self.call(0x53669ab4,OBJECT+0x1000,resolution)
        ch=self.call(0x53669bd0,OBJECT+0x1000,resolution)
        for offset,value in ((0xa6,cw),(0xa8,ch),(0xaa,cw),(0xac,ch),(0xb8,cw)):
            half(0x3000+offset,value)
        byte(0x30b2,2)
        if allocation_kind=='native-vram':
            self.call(0x534344b0,OBJECT+0x2000)
            vw,vh=struct.unpack('<2H',c.mem_read(OBJECT+0x21c8,4))
            assert (vw,vh)==(1920,1088)
        else:
            assert allocation_kind=='aperture'
            vw,vh=cw,ch
            half(0x21c8,vw);half(0x21ca,vh)
        word(0x21bc,vw*vh);word(0x21c4,vw*vh)
        word(0x60,0x68000000);word(0x2140,0x69000000)
        # Original recipe producer -> original complete development destination
        # builder, the same pair used by the camera's display reconstruction.
        self.call(0x5345a3c8,OBJECT,identity,0,0,stack=struct.pack('<I',zoom))
        before=bytes(c.mem_read(OBJECT+0x600,0x3a00))
        self.call(0x53457e00,OBJECT)
        assert bytes(c.mem_read(OBJECT+0x600,0x3a00))==before
        assert bytes(c.mem_read(OBJECT+0x4100,0xbf00))==b'\xa5'*0xbf00
        dimensions=struct.unpack('<2H',c.mem_read(OBJECT+0x54a,4))
        source=struct.unpack('<6H',c.mem_read(OBJECT+0x180,12))
        base=struct.unpack('<2H',c.mem_read(OBJECT+0x558,4))
        # Source X/Y and width/height are in the resized aperture's coordinates.
        # At 1x this is the 3:2 base aperture. Zoom scales that canvas before crop.
        canvas=tuple((v*zoom+4096)>>13 for v in base) if not flags[1] else base
        valid=(source[4]+source[0]<=canvas[0] and source[5]+source[1]<=canvas[1])
        write_addresses=[struct.unpack('<I',c.mem_read(OBJECT+off,4))[0] for off in (0x174,0x384)]
        aperture_origin=struct.unpack('<2H',c.mem_read(OBJECT+0x554,4))
        return dict(identity=identity,resolution=resolution,mode=mode,flags=flags,zoom=zoom,
                    allocation=[cw,ch],vram_capacity=[vw,vh],dimensions=dimensions,canvas=canvas,source=source,in_bounds=valid,
                    aperture_origin=aperture_origin,write_addresses=write_addresses,
                    descriptor=bytes(c.mem_read(OBJECT,0x600)).hex(),
                    scaler=bytes(c.mem_read(OBJECT+0x4000,0x100)).hex())

def verify(data,manifest):
    archived=Path(__file__).with_name('fixtures')/'t2-patch-manifest.json'
    raw=archived.read_bytes();assert hashlib.sha256(raw).hexdigest()==T2_MANIFEST_SHA
    old=DevelopmentProbe(data,json.loads(raw));current=DevelopmentProbe(data,manifest)
    m=menu_of(manifest)
    if not is_t4(m): return verify_custom(old,current,m)
    examples=[];states=0;old_failures=0;unaffected=0;calls=0
    for mode in (0,2):
        for resolution in range(1,32):
            for flags in ((0,0),(0,1),(1,0),(1,1)):
                for zoom in (8192,10240,14629):
                    for identity in range(11):
                        previous=old.recipe(identity,resolution,mode,flags,zoom)
                        result=current.recipe(identity,resolution,mode,flags,zoom)
                        states+=1;calls+=8
                        if identity not in WIDE:
                            assert result==previous,(identity,resolution,mode,flags,zoom)
                            unaffected+=1
                        else:
                            assert result['in_bounds'],result
                            # T4 retains T3's width correction and additionally
                            # drops at most two rows to centre YUV420 on even Y.
                            assert previous['dimensions'][1]-result['dimensions'][1] in (0,2)
                            assert result['dimensions'][1]%4==0
                            assert result['allocation']==previous['allocation']
                            if not previous['in_bounds']:
                                old_failures+=1
                                if mode==0 and flags==(0,0) and zoom==8192 and resolution in (9,11,16,20):
                                    examples.append({
                                        'identity':identity,'resolution':resolution,
                                        'canvas':result['canvas'],
                                        'T2':{k:previous[k] for k in ('dimensions','source','in_bounds')},
                                        'T4':{k:result[k] for k in ('dimensions','source','in_bounds')},
                                    })
    assert old_failures>0 and {x['identity'] for x in examples}==set(WIDE)
    return dict(calls=calls,recipe_states=states,T2_manifest_sha256=T2_MANIFEST_SHA,
                T2_out_of_bounds_cases=old_failures,T4_wide_out_of_bounds_cases=0,
                native_and_nonwide_states_identical=unaffected,
                wide_height_adjustment_at_most_two_rows=True,physical_allocation_unchanged=True,
                source_objects_and_canaries_unchanged=True,
                executed_functions=['0x53669ab4','0x53669bd0','0x5345a3c8','0x53457e00'],examples=examples,
                hardware_tested=False,
                scope='Synthetic mode/flag/zoom combinations; native recipe producer and complete development destination builder. No sensor DMA, full capture event sequence or physical LCD execution.')

def verify_custom(old,current,m):
    """Another ratio list: no archived build has its geometry, so the T2 comparison covers the
    native identities only. Every added identity must stay inside the canvas the native consumer
    reads, keep the physical allocation, and give a four-row aligned height where it crops rows."""
    states=calls=unaffected=0;checked=dict(wide=0,narrow=0)
    for mode in (0,2):
        for resolution in range(1,32):
            for flags in ((0,0),(0,1),(1,0),(1,1)):
                for zoom in (8192,10240,14629):
                    native=None
                    for identity in range(4):
                        previous=old.recipe(identity,resolution,mode,flags,zoom)
                        result=current.recipe(identity,resolution,mode,flags,zoom)
                        assert result==previous,(identity,resolution,mode,flags,zoom)
                        if identity==0:native=result
                        unaffected+=1;states+=1;calls+=8
                    for identity,num,den in m.custom:
                        result=current.recipe(identity,resolution,mode,flags,zoom);states+=1;calls+=4
                        assert result['in_bounds'],result
                        assert result['allocation']==native['allocation']
                        assert all(v>0 for v in result['dimensions'])
                        if identity in m.wide:
                            assert result['dimensions'][1]%4==0 and result['dimensions'][1]<=native['dimensions'][1]
                            checked['wide']+=1
                        else:
                            assert result['dimensions'][0]<=native['dimensions'][0]
                            checked['narrow']+=1
    return dict(calls=calls,recipe_states=states,custom_menu=True,native_states_identical_to_T2=unaffected,
                custom_states_in_bounds=checked,T2_comparison='native identities only (no archived build has this ratio list)',
                physical_allocation_unchanged=True,hardware_tested=False,
                executed_functions=['0x53669ab4','0x53669bd0','0x5345a3c8','0x53457e00'],
                scope='Synthetic mode/flag/zoom combinations; native recipe producer and complete development destination builder.')

if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('rtos',type=Path);ap.add_argument('manifest',type=Path);ap.add_argument('report',type=Path)
    a=ap.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k!='examples'},indent=2))
