"""Execute IIIx ADJ/menu research functions with explicit UI/backend substitutes.

The native selection, membership, count dispatch, text/icon identities and RGBA copy
kernel execute on ARM. UI widget services, singletons, queue delivery and the UserData
backend are stubbed. This does not establish real menus, persistence or camera boot.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from unicorn import UC_PROT_READ, UC_PROT_EXEC, UC_HOOK_MEM_WRITE
from unicorn import arm_const as reg
from native_probe import BASE, RTOS_SHA, STOP, OBJECT, MUTEX
from identity import RTOS_SHAS, by_id
from rear_dial_probe import RearDialProbe, SELECTOR, DATA, USER
from experiment_probe import verify as verify_geometry, SITES
from ratio_menu import menu as menu_of

if not __debug__: raise RuntimeError('Run validation without Python -O')

VIEW, CHILD, CONTEXT, SURFACE, SOURCE, DEST = (0x62060000, 0x62061000,
    0x62062000, 0x62063000, 0x62064000, 0x62070000)
ORDER_SITES = [0x531a0df0,0x531a1234,0x531a3438,0x531b4e08,
               0x531b6bd0,0x531b82f8,0x53227144]
PATCH_ADDRESSES = (set(SITES) | {a+off for a in ORDER_SITES for off in (0,4)} |
    {0x5319fea0,0x531b3aac,0x533966e8,0x533966f0,0x533970fc,0x53397100,
     0x533966d4,0x533970ec,0x53209fcc,0x53209fd0,0x5320a000,0x5320a004,
     0x5320a804,0x5320a808,0x53209fb8,0x53209fec,0x5320a7cc,
     0x53292544,0x53293800,0x5322714c,0x53604a60,0x535ed458})

def u32(cpu, at): return struct.unpack('<I',cpu.mem_read(at,4))[0]
def put(cpu, at, v): cpu.mem_write(at,struct.pack('<I',v))

class AdjProbe(RearDialProbe):
    def __init__(self,data,manifest):
        super().__init__(data)
        self.ui=[]; self.backend=[]
        assert manifest['kind'] in ('gr3x-adj-patchset','gr3x-adj-research','gr3x-image-control-patchset') and manifest['schema']==1
        # Archived IIIx fixtures (T2/T3) are also replayed on GR III 2.10: the two RTOS images are the
        # same program (identity bytes aside), and every site's expected word is checked on install.
        assert manifest['originalRtosSha256'] in RTOS_SHAS and manifest['base']==BASE
        if 'profile' in manifest: assert by_id(manifest['profile'])['rtos_sha256']==manifest['originalRtosSha256']
        assert manifest['originalLength']==len(data) and not manifest.get('flashable',False)
        assert not manifest['firmwareGenerated'] and not manifest['rearDialPatched']
        self.menu=menu_of(manifest)
        assert menu_of(manifest['geometry']).rows==self.menu.rows
        assert {s['address'] for s in manifest['sites']}>=PATCH_ADDRESSES
        assert len(manifest['sites'])==len({s['address'] for s in manifest['sites']})
        at=manifest['append']['address']; payload=bytes.fromhex(manifest['append']['bytes'])
        assert at==BASE+len(data) and len(payload)%4==0 and at+len(payload)<0x55000000
        for s in manifest['sites']:
            old=bytes.fromhex(s['expected']);new=bytes.fromhex(s['replacement'])
            assert len(old)==len(new)==4 and data[s['address']-BASE:s['address']-BASE+4]==old
        geometry=manifest['geometry'];original_payload=bytes.fromhex(geometry['append']['bytes'])
        assert payload[:len(original_payload)]==original_payload
        for at,old in SITES.items():
            assert next(s for s in manifest['sites'] if s['address']==at)['expected']==old.hex()
        page_end=(BASE+len(data)+4095)&~4095
        required_end=(manifest['append']['address']+len(payload)+4095)&~4095
        if required_end>page_end:
            self.uc.mem_map(page_end,required_end-page_end,UC_PROT_READ|UC_PROT_EXEC)
        # Zero-filled data after the initialised RAM image, up to the heap (the settings object's
        # pointer 0x55063f34 lives there; 0 before the settings are loaded).
        self.uc.mem_map(0x5503b000,0x55800000-0x5503b000)
        self.uc.mem_write(manifest['append']['address'],payload)
        for s in manifest['sites']:self.uc.mem_write(s['address'],bytes.fromhex(s['replacement']))

    def _hook(self,cpu,at,size,user):
        if at==0x5320b67c or at==0x5320b7fc:
            cpu.reg_write(reg.UC_ARM_REG_R0,0x62049000)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at in (0x53394758,0x533a1734,0x5339e7a0):
            self.ui.append((at,cpu.reg_read(reg.UC_ARM_REG_R0),cpu.reg_read(reg.UC_ARM_REG_R1)))
            cpu.reg_write(reg.UC_ARM_REG_R0,CHILD if at==0x53394758 else 0)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==0x5354b564:
            # Run the native per-field wrappers, substitute only their storage backend.
            command=cpu.reg_read(reg.UC_ARM_REG_R1);field=cpu.reg_read(reg.UC_ARM_REG_R2)
            argument=cpu.reg_read(reg.UC_ARM_REG_R3);value=bytes(cpu.mem_read(argument,1))[0]
            assert field==0xd4 and cpu.reg_read(reg.UC_ARM_REG_R0)==USER
            self.backend.append((command,field,value))
            if command==2:
                result=u32(cpu,cpu.reg_read(reg.UC_ARM_REG_SP));cpu.mem_write(result,bytes([int(value in (0,3))]))
            else:assert command==1
            cpu.reg_write(reg.UC_ARM_REG_R0,0)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)

    def state(self,aspect,slot=0):
        self.reset({DATA+0x4c2:aspect}) # Normal selector branch, with storage explicitly stubbed.
        self.ui=[];self.backend=[]
        for off in (0x918,0x91a,0x91c,0x91e,0x920):self.uc.mem_write(DATA+off,b'\x04')
        self.uc.mem_write(VIEW,bytes(0x300));self.uc.mem_write(VIEW+0x1f4,bytes([slot]))
        put(self.uc,VIEW+0x1f0,CHILD)

class CombinedGeometryProbe(AdjProbe):
    def __init__(self,data,manifest):
        self.preview_lock_depth=0;self.locked_window_writes=0
        super().__init__(data,manifest)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self._window_write,begin=OBJECT+36,end=OBJECT+67)
    def _hook(self,cpu,at,size,user):
        if at==MUTEX[0]:self.preview_lock_depth+=1
        if at==MUTEX[1]:self.preview_lock_depth-=1
        super()._hook(cpu,at,size,user)
    def _window_write(self,cpu,access,at,size,value,user):
        assert self.preview_lock_depth==1
        self.locked_window_writes+=1

def verify(data,manifest):
    n=AdjProbe(data,manifest);cpu=n.uc;catalog=manifest['catalogs'];calls=0
    rows=manifest['ratios'];m=n.menu;order=m.order;count=len(order);customs=len(m.custom)
    assert bytes(cpu.mem_read(catalog['order'],count))==bytes(order)
    added=len(manifest.get('addedLooks',[]))
    soft=1 if manifest.get('adjSoftFocus') else 0  # one text and one icon of soft focus on the ADJ lever
    date=1 if manifest.get('dateImprint') else 0  # date imprint: three texts (five as a submenu), two icons
    hal=1 if manifest.get('halationInCamera') else 0  # round 6: Halation's name, its list icon and slider scale
    r7=1 if hal and manifest.get('round7') else 0  # round 7: also the Colour row's name; the colour scale and red / white icons
    htexts,hicons,hpixels=(2,4,3*6400+400*60*4) if r7 else (hal,2*hal,hal*(6400+400*60*4))
    # Round 8: also Follow Orientation and the two styles with the look's name; two more icons.
    d8=1 if date and manifest.get('round8') else 0
    dtexts=(8 if d8 else 5) if date and manifest['dateImprint'].get('form')=='submenu' else 3*date
    dicons=(4 if d8 else 2)*date
    pics=manifest['pictures']['count'] if manifest.get('pictures') else 0  # power-off pictures: 2 + n texts, n icons
    # Round 6 (End Screen submenu): 3 + n texts, 5 + n thumbnails of 520 x 200.
    esub=1 if manifest.get('pictures') and manifest['pictures'].get('form')=='submenu' else 0
    ptexts=(3 if esub else 2)+pics if pics else 0;picons=pics+5*esub;ppixels=(5+pics)*520*200*4 if esub else pics*6400
    assert (catalog['textColumns'],catalog['iconCount'])==(786+customs+soft+dtexts+ptexts+added+htexts,671+customs+soft+dicons+picons+added+hicons)
    for lang in range(21):
        old_root=u32(cpu,0x55002bac+lang*4);new_root=u32(cpu,catalog['textRoots']+lang*4)
        assert bytes(cpu.mem_read(old_root,786*4))==bytes(cpu.mem_read(new_root,786*4))
        for row in rows:
            record=u32(cpu,new_root+row['textId']*4);desc=bytes(cpu.mem_read(record,8))
            units,lines,unused,text=struct.unpack('<BBHI',desc)
            name=m.names[row['id']]
            assert (units,lines,unused)==(len(name)+1,1,0)
            assert bytes(cpu.mem_read(text,units*2)).decode('utf-16le')==name+'\0'
    assert bytes(cpu.mem_read(0x550020fc,671*4))==bytes(cpu.mem_read(catalog['iconRoot'],671*4))
    pixels=bytes.fromhex(manifest['iconAddition']['bytes']);assert len(pixels)==customs*9600+soft*6400+dicons*6400+ppixels+added*6400+hpixels
    for index,row in enumerate(r for r in rows if r['id']>=4):
        desc=u32(cpu,catalog['iconRoot']+row['iconId']*4)
        w,h,offset=struct.unpack('<HHI',cpu.mem_read(desc,8))
        assert (w,h,offset*4)==(60,40,manifest['iconAddition']['originalLength']+index*9600)
        # Native IIIx RGBA copier reads the custom 8-byte descriptor and the tile pixels.
        put(cpu,SURFACE+8,DEST+32);cpu.mem_write(SURFACE+0x18,struct.pack('<H',60))
        cpu.mem_write(CONTEXT,bytes(0x20));tile=pixels[index*9600:(index+1)*9600]
        cpu.mem_write(SOURCE,tile);cpu.mem_write(DEST,b'\xa5'*(9600+64))
        n.call(0x5320a020,CONTEXT,SURFACE,0,0,stack=struct.pack('<6I',0,0,60,40,desc,SOURCE));calls+=1
        expected=bytearray(b'\xa5'*9600)
        for i in range(0,9600,4):
            if tile[i+3]!=0:expected[i:i+4]=tile[i:i+4]
        assert bytes(cpu.mem_read(DEST,32))==b'\xa5'*32
        assert bytes(cpu.mem_read(DEST+32,9600))==bytes(expected)
        assert bytes(cpu.mem_read(DEST+32+9600,32))==b'\xa5'*32
    for at in (0x5319fea0,0x531b3aac):assert n.call(at,VIEW)==count;calls+=1
    for slot in range(5):
        n.state(0,slot);assert n.call(0x531a31ac,VIEW)==count;calls+=1
        for index,row in enumerate(rows):
            n.state(0,slot);n.call(0x531a3408,VIEW,index);calls+=1
            assert n.ui==[(0x53394758,CHILD,index),(0x533a1734,CHILD,row['iconId'])]
    for index,row in enumerate(rows):
        n.state(0);n.call(0x531b4dec,0,CHILD,index);calls+=1
        assert n.ui==[(0x5339e7a0,CHILD,row['textId'])]
        for at in (0x531a0dd8,0x531b6bb8):
            n.state(0);n.call(at,VIEW,index);calls+=1
            assert bytes(cpu.mem_read(DATA+0x4c2,1))==bytes([row['id']])
            assert n.backend==[(2,0xd4,0),(2,0xd4,3),(1,0xd4,row['id'])]
            assert n.notifications==([] if row['id']==0 else [[0x62053000,0x183,0,0]])
        for current in order:
            n.state(current)
            for at in (0x531a1218,0x531b82f0):
                assert n.call(at,VIEW,index)==int(current==row['id']);calls+=1
    for identity in list(range(256))+[256,0xffffffff]:
        match=next((r for r in rows if r['id']==identity),None)
        assert n.call(0x53292544,VIEW,identity)==(match['textId'] if match else 0);calls+=1
        assert n.call(0x53293800,VIEW,identity)==(match['iconId'] if match else 0);calls+=1
    for row in rows:
        for at,expected in ((0x53209fb8,60),(0x53209fec,40)):
            assert n.call(at,VIEW,row['iconId'])==expected
            calls+=1
    for start in order+sorted({1,2,m.max_id+1,11,255}):
        n.state(start)
        n.call(0x53227114,VIEW);calls+=1
        expected=order[(order.index(start)+1)%count] if start in order else order[0]
        assert bytes(cpu.mem_read(DATA+0x4c2,1))==bytes([expected])
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),manifest_sha256=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),
        calls=calls,native_adj_count_all_five_slots=True,native_adj_and_menu_select=True,
        native_selected_check=True,native_fn_cycle=True,native_ratio_id_lookups=True,
        native_icon_dimensions=True,native_rgba_icon_copy=True,icon_buffer_canaries=True,
        original_catalog_entries_preserved=True,ratio_names_all_21_languages=True,
        native_userdata_wrappers_executed=True,userdata_backend_stubbed=True,
        persistent_storage_verified=False,real_ui_verified=False,hardware_tested=False,
        rear_dial_patched=False,flashable=False,
        scope='ARM menu functions only; singleton, widget, queue and UserData backend substitutes. No real UI, storage, camera boot or complete image encoding.')

def verify_image_identity(data,manifest):
    n=AdjProbe(data,manifest);cases=0;top=n.menu.max_id
    # Execute both original byte-field backends, for inline and indirect storage.
    # The whole byte domain is checked: new valid IDs round-trip; other IDs still
    # invoke the native diagnostic and fall back exactly as before.
    for indirect in (False,True):
        for identity in range(256):
            n.uc.mem_write(CHILD,b'\xa5'*64)
            n.uc.mem_write(DEST,b'\xa5'*64)
            put(n.uc,CHILD+0x10,DEST+16 if indirect else 0)
            field=DEST+16 if indirect else CHILD+12
            put(n.uc,VIEW+0x20,SURFACE)
            n.uc.mem_write(SURFACE+0xf2,bytes([identity]))
            failed=False
            try:n.call(0x53604a44,VIEW,CHILD)
            except ValueError as exc:
                assert 'Original assertion failed' in str(exc);failed=True
            assert failed==(identity>top)
            encoded=bytes(n.uc.mem_read(field,1))[0]
            assert encoded==({0:1,1:0,2:2,3:3}.get(identity,identity) if identity<=top else 0)
            assert bytes(n.uc.mem_read(field+1,3))==b'\xa5'*3
            # Feed every possible file value, including malformed/unknown values.
            n.uc.mem_write(field,bytes([identity]))
            n.uc.mem_write(SOURCE,b'\xa5'*0x800)
            put(n.uc,CONTEXT+12,SOURCE)
            failed=False
            try:n.call(0x535ed438,CONTEXT,CHILD)
            except ValueError as exc:
                assert 'Original assertion failed' in str(exc);failed=True
            assert failed==(identity>top)
            decoded=bytes(n.uc.mem_read(SOURCE+0x7b6,1))[0]
            assert decoded==({0:1,1:0,2:2,3:3}.get(identity,identity) if identity<=top else 1)
            assert bytes(n.uc.mem_read(SOURCE,0x7b6))==b'\xa5'*0x7b6
            assert bytes(n.uc.mem_read(SOURCE+0x7b7,0x49))==b'\xa5'*0x49
            cases+=2
    return dict(calls=cases,all_byte_values_tested=True,native_field_reader_and_writer_executed=True,
        field_backends_stubbed=False,inline_and_indirect_storage=True,native_0_to_3_mapping_preserved=True,
        custom_ids_preserved=True,unknown_ids_keep_native_diagnostic=True,memory_canaries=True,
        scope='Native aspect field conversion and byte storage, not complete JPEG/DNG serialization.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--rtos',required=True,type=Path);p.add_argument('--manifest',required=True,type=Path)
    p.add_argument('--report',required=True,type=Path);args=p.parse_args()
    if args.report.resolve() in (args.rtos.resolve(),args.manifest.resolve()):raise ValueError('Output overlaps input')
    data=args.rtos.read_bytes();manifest=json.loads(args.manifest.read_text())
    result=verify(data,manifest)
    result['geometry']=verify_geometry(data,manifest['geometry'],CombinedGeometryProbe(data,manifest))
    result['geometry']['all_adj_pipeline_patches_installed']=True
    result['image_identity']=verify_image_identity(data,manifest)
    with args.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k!='geometry'},indent=2))
