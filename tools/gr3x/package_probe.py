"""Independently decode the research container using the pinned Python reference codec.

Integrity verification only; does not establish IIIx updating, loading or camera boot.
Pass the checkout of DoYitNow/gr-custom-tool at 0c15c8f explicitly via --reference.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

if not __debug__: raise RuntimeError('Run without Python -O')

def res_records(buf,start,count):
    import struct
    at=start+16;out=[]
    for _ in range(count):
        path=buf[at:at+32].split(b'\0')[0].decode('ascii');size=struct.unpack_from('<I',buf,at+32)[0]
        out.append((path,at,size));at+=36+size
    return out,at

def check_res(old,a,dec,b,build):
    """Power-off pictures: the official 22 A: records, then one record of exactly two frames per
    picture (A:\\Resource\\Jpeg\\GRMODk.jpg, 720x480 baseline 4:2:0 JPEG), then the 13 official B: records."""
    import struct
    n=len(build['pictures']);assert 1<=n<=8
    oc=a['resource_count'];nc=b['resource_count'];assert oc==35 and nc==35+n<=43
    orec,oend=res_records(old,a['start'],oc);nrec,nend=res_records(dec,b['start'],nc)
    assert oend==a['end'] and nend==b['end']
    for (p,at,size),(q,bt,bsize) in zip(orec[:22]+orec[22:],nrec[:22]+nrec[22+n:]):
        assert p==q and size==bsize and old[at:at+36+size]==dec[bt:bt+36+size]
    assert all(p.startswith('A:\\') for p,_,_ in orec[:22]) and all(p.startswith('B:\\') for p,_,_ in orec[22:])
    for k,(path,at,size) in enumerate(nrec[22:22+n]):
        assert path==f'A:\\Resource\\Jpeg\\GRMOD{k+1}.jpg' and size==2*0x6000-36,(path,size)
        j=dec[at+36:at+36+size];assert j[:2]==b'\xff\xd8' and j.rstrip(b'\0')[-2:]==b'\xff\xd9'
        sof=j.find(b'\xff\xc0');assert sof>0 and j.find(b'\xff\xc2')<0
        assert struct.unpack('>HH',j[sof+5:sof+9])==(480,720) and j[sof+9]==3 and (j[sof+11],j[sof+14],j[sof+17])==(0x22,0x11,0x11)
    assert nrec[22][1]-(b['start']+16)==orec[22][1]-(a['start']+16)

def updater_walk_past_res(dec):
    """The camera's updater (DspFwUpdate, 0x5362a4c0) steps past RES by its file COUNT in bytes and
    reads section headers from there on until the payload is used up. Never on a header that it
    would act on (v1 1..8)."""
    import struct,sys
    sys.path.insert(0,'.')
    from gr4_editor.codec.frames import section_rows
    res=next(s for s in section_rows(dec) if s['name']=='RES')
    p=res['start']+16+res['resource_count'];rem=len(dec)-(res['start']+16)-res['resource_count']
    while True:
        if p+16>len(dec):return 'beyond'
        v1,v2,size=struct.unpack_from('<HHI',dec,p+8);rem-=16
        if 1<=v1<=8:return 'danger'
        if rem<size:return 'exit-ok'
        p+=16+size;rem-=size
        if rem==0:return 'exit-ok'

def verify(original,new,manifest,build,reference):
    sys.path.insert(0,str(reference.resolve()))
    from identity import by_container
    from gr4_editor.codec.container import inspect_container,sum32
    from gr4_editor.codec.frames import decode_payload,section_rows
    profile=by_container(original)
    o=inspect_container(original);n=inspect_container(new)
    assert o['project']==n['project']==profile['project'] and n['additive_sum32']==0
    assert o['metadata_length']==n['metadata_length']==0
    old,_=decode_payload(original[128:o['payload_end']],o['decoded_size'])
    dec,frames=decode_payload(new[128:n['payload_end']],n['decoded_size'])
    assert hashlib.sha256(old).hexdigest()==profile['decoded_sha256']
    assert hashlib.sha256(new).hexdigest()==build['outputSha256'] and sum32(dec)==0
    old_sections=section_rows(old);new_sections=section_rows(dec)
    assert [s['name'] for s in old_sections]==[s['name'] for s in new_sections]
    rt=next(s for s in new_sections if s['name']=='RTOS');rt_start=rt['start']+16
    app=rt_start+manifest['originalLength'];payload=bytes.fromhex(manifest['append']['bytes'])
    assert dec[app:app+len(payload)]==payload
    expected=bytearray(old[rt_start:rt_start+manifest['originalLength']])
    assert len(manifest['sites'])>=92
    assert len(manifest['sites'])==len({s['address'] for s in manifest['sites']})
    for site in manifest['sites']:
        offset=site['address']-manifest['base'];old_word=bytes.fromhex(site['expected']);new_word=bytes.fromhex(site['replacement'])
        assert len(old_word)==len(new_word)==4 and expected[offset:offset+4]==old_word
        expected[offset:offset+4]=new_word
    soft=build.get('softFocus',[])
    gains={'weak':[820,740,700,700,740,840,940,1024,1024,1024,1024],
           'medium':[680,560,500,500,540,680,860,960,1024,1024,1024],
           'strong':[540,400,330,330,380,540,760,920,1024,1024,1024]}
    import struct
    assert len(soft)<=4 and len({r['level'] for r in soft})==len(soft)
    for row in soft:
        assert row['level'] in (-4,-3,-2,-1) and row['strength'] in gains
        struct.pack_into('<11h',expected,0x8f1fd4+(row['level']+4)*22,*gains[row['strength']])
    assert dec[rt_start:rt_start+len(expected)]==expected
    icon_old=next(s for s in old_sections if s['name']=='ICONBIN');icon_new=next(s for s in new_sections if s['name']=='ICONBIN')
    old_pixels=old[icon_old['start']+16:icon_old['end']]
    assert dec[icon_new['start']+16:icon_new['start']+16+len(old_pixels)]==old_pixels
    icon_append=icon_new['start']+16+len(old_pixels);px=bytes.fromhex(manifest['iconAddition']['bytes'])
    assert dec[icon_append:icon_append+len(px)]==px
    res_growth=build.get('resGrowth',0)
    for a,b in zip(old_sections,new_sections):
        assert a['flags']==b['flags']
        if a['name']=='RES' and res_growth:check_res(old,a,dec,b,build)
        elif a['name'] not in ('RTOS','ICONBIN'):assert old[a['start']:a['end']]==dec[b['start']:b['end']]
        else:assert b['end']-b['start']-(a['end']-a['start'])==build['rtosGrowth' if a['name']=='RTOS' else 'iconGrowth']
    assert len(dec)==len(old)+build['rtosGrowth']+build['iconGrowth']+res_growth
    assert updater_walk_past_res(dec)=='exit-ok'
    assert sum(f.decoded_end-f.decoded_start for f in frames)==len(dec)
    part=next(s for s in old_sections if s['name']=='PARTPARA')
    import struct
    assert struct.unpack_from('<I',old,part['start']+16+4+16)[0]==0x4000000
    assert rt['end']-rt_start<0x4000000
    # ICONBIN (partition 4, also its RAM area at 0x51600000): the camera refuses an oversized one only
    # after writing RTOS, so it must fit with room to spare (256 KB kept free).
    assert struct.unpack_from('<I',old,part['start']+16+4+4*16)[0]==0x1800000
    assert icon_new['end']-(icon_new['start']+16)<=0x1800000-0x40000
    revision=build.get('revision','T4-SF1' if soft else 'T4')
    assert revision in ('research','T4','T4-SF1','T5','T5-L1','T6','T7','T8','T9','T10')
    # Round 7 (T7) and round 8 (T8, as GR Mod 0.8.4): with films (an image-control build, T6's film
    # recipe) or without (ADJ layer only).
    # Round 10 (T10): GR IV's ways on GR III (core/src/fw/gr3x/round10.ts), on round 9.
    r10=revision=='T10';assert r10==bool(manifest.get('round10'))
    r9=revision in ('T9','T10');assert r9==bool(manifest.get('round9'))
    r8=revision in ('T8','T9','T10');assert r8==bool(manifest.get('round8'))
    r7=revision in ('T7','T8','T9','T10');assert r7==bool(manifest.get('round7'))
    looks=revision.startswith('T5') or revision=='T6' or (r7 and manifest['kind']=='gr3x-image-control-patchset')
    if looks:assert manifest['kind']=='gr3x-image-control-patchset'
    if r7 and looks:assert manifest.get('filmCount')
    from ratio_menu import menu as menu_of, is_t4
    m=menu_of(manifest);entries=len(m.order)
    marker=(f"{profile['tag']}-ADJ{entries}-{revision}-HARDWARE-UNTESTED\0".encode()
            if build.get('cameraUpdateCandidate') else f'GR3X-ADJ{entries}-RESEARCH-NOT-FOR-CAMERA\0'.encode())
    assert dec[rt['end']-4-len(marker):rt['end']-4]==marker
    padding=app+len(payload)
    if looks:
        magic=b'GR3X-T5-RECIPE\0'
        assert dec[padding:padding+len(magic)]==magic
        length=struct.unpack_from('<I',dec,padding+len(magic))[0]
        films=manifest.get('filmCount')   # round 6: 1..20 films (recipe up to 1.5 MB)
        assert length<=((1500000 if films else 512000) if revision in ('T6','T7','T8','T9','T10') else 256000)
        start=padding+len(magic)+4
        recipe=json.loads(dec[start:start+length])
        if revision in ('T6','T7','T8','T9','T10'):
            assert recipe['schema']==3 and len(recipe['films'])<=(films or 9) and recipe['monoReplicas'] is False
            assert recipe.get('filmCount')==films and (films is None or 1<=films<=20 and recipe.get('ownParameters') is True)
            assert len(manifest['addedLooks'])==(films or 9)
            assert [s['id'] for s in manifest['addedLooks']]==list(range(64,64+(films or 9)))
            if films:assert all('halation' not in f for f in recipe['films'])
            assert all(s['source']=='cube' and s['nativeBase']==11 for s in manifest['addedLooks'])
        else:
            assert recipe['schema']==(1 if revision=='T5' else 2) and len(recipe['films'])<=2
            assert len(manifest['addedLooks'])==2+6*recipe['monoReplicas']
        padding=start+length
    if not is_t4(m) or manifest.get('adjSoftFocus') or manifest.get('dateImprint') or manifest.get('pictures') or r7:
        # The ratio list follows the film recipe; it must name exactly the manifest's added ratios.
        magic=b'GR3X-RATIO-RECIPE\0'
        assert dec[padding:padding+len(magic)]==magic
        length=struct.unpack_from('<I',dec,padding+len(magic))[0];assert length<=4096
        start=padding+len(magic)+4
        recipe=json.loads(dec[start:start+length])
        expected={'schema':1,'ratios':[{'ratio':m.ratios[i],'name':m.names[i]} for i,_,_ in m.custom]}
        if manifest.get('adjSoftFocus'):expected['adjSoftFocus']=True
        if manifest.get('dateImprint'):expected['dateImprint']=True
        if manifest.get('dateImprint') and manifest['dateImprint'].get('form')=='submenu':expected['dateMenu']='submenu'
        if manifest.get('pictures'):expected['pictures']=build['pictures']
        if manifest.get('pictures') and manifest['pictures'].get('form')=='submenu':expected.update(pictureMenu='submenu',pictureIds=manifest['pictures']['choices'])
        if r7:expected['round']=10 if r10 else 9 if r9 else 8 if r8 else 7
        if r8 and manifest.get('lookLayout'):expected['lookLayout']=manifest['lookLayout']
        assert recipe==expected,recipe
        padding=start+length
    assert not any(dec[padding:rt['end']-4-len(marker)])
    return dict(schema=1,decoder='DoYitNow/gr-custom-tool codec at 0c15c8f9a97b464ac23ab1641740a8263e0068b0',
        output_sha256=n['sha256'],output_bytes=len(new),decoded_sha256=hashlib.sha256(dec).hexdigest(),
        decoded_bytes=len(dec),frames=len(frames),project=profile['project'],profile=profile['id'],empty_model_area_preserved=True,
        original_non_grown_sections_identical=True,original_icon_pixels_preserved=True,
        patch_sites=len(manifest['sites']),all_patch_sites_match=True,
        original_rtos_outside_declared_edits_preserved=True,negative_clarity_rows=soft,
        appended_code_catalogs_and_icons_match=True,
        container_and_payload_sums_zero=True,hardware_tested=False)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('official','container','manifest','build-report','reference','report'):
        p.add_argument('--'+name,required=True,type=Path)
    a=p.parse_args()
    if a.report.resolve() in [f.resolve() for f in (a.official,a.container,a.manifest,a.build_report)]:raise ValueError('Output overlaps input')
    result=verify(a.official.read_bytes(),a.container.read_bytes(),json.loads(a.manifest.read_text()),json.loads(a.build_report.read_text()),a.reference)
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
