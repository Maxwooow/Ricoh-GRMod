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

def verify(original,new,manifest,build,reference):
    sys.path.insert(0,str(reference.resolve()))
    from gr4_editor.codec.container import inspect_container,sum32
    from gr4_editor.codec.frames import decode_payload,section_rows
    assert hashlib.sha256(original).hexdigest()=='708e79f3b7b96a7e1581b4acf4c412233050a1832718ef7f06c8397db1b431c7'
    o=inspect_container(original);n=inspect_container(new)
    assert o['project']==n['project']==609 and n['additive_sum32']==0
    assert o['metadata_length']==n['metadata_length']==0
    old,_=decode_payload(original[128:o['payload_end']],o['decoded_size'])
    dec,frames=decode_payload(new[128:n['payload_end']],n['decoded_size'])
    assert hashlib.sha256(old).hexdigest()=='c4bfc09d1148deec2155b21bd3d63be8085cf835cbe5e5cde4832747f519e630'
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
    for a,b in zip(old_sections,new_sections):
        assert a['flags']==b['flags']
        if a['name'] not in ('RTOS','ICONBIN'):assert old[a['start']:a['end']]==dec[b['start']:b['end']]
        else:assert b['end']-b['start']-(a['end']-a['start'])==build['rtosGrowth' if a['name']=='RTOS' else 'iconGrowth']
    assert len(dec)==len(old)+build['rtosGrowth']+build['iconGrowth']
    assert sum(f.decoded_end-f.decoded_start for f in frames)==len(dec)
    part=next(s for s in old_sections if s['name']=='PARTPARA')
    import struct
    assert struct.unpack_from('<I',old,part['start']+16+4+16)[0]==0x4000000
    assert rt['end']-rt_start<0x4000000
    revision=build.get('revision','T4-SF1' if soft else 'T4')
    assert revision in ('research','T4','T4-SF1','T5','T5-L1','T6')
    if revision.startswith('T5') or revision=='T6':assert manifest['kind']=='gr3x-image-control-patchset'
    marker=(f'GR3X-HDF-160-ADJ9-{revision}-HARDWARE-UNTESTED\0'.encode()
            if build.get('cameraUpdateCandidate') else b'GR3X-ADJ9-RESEARCH-NOT-FOR-CAMERA\0')
    assert dec[rt['end']-4-len(marker):rt['end']-4]==marker
    padding=app+len(payload)
    if revision.startswith('T5') or revision=='T6':
        magic=b'GR3X-T5-RECIPE\0'
        assert dec[padding:padding+len(magic)]==magic
        length=struct.unpack_from('<I',dec,padding+len(magic))[0]
        assert length<=(512000 if revision=='T6' else 256000)
        start=padding+len(magic)+4
        recipe=json.loads(dec[start:start+length])
        if revision=='T6':
            assert recipe['schema']==3 and len(recipe['films'])<=9 and recipe['monoReplicas'] is False
            assert len(manifest['addedLooks'])==9
            assert [s['id'] for s in manifest['addedLooks']]==list(range(64,73))
            assert all(s['source']=='cube' and s['nativeBase']==11 for s in manifest['addedLooks'])
        else:
            assert recipe['schema']==(1 if revision=='T5' else 2) and len(recipe['films'])<=2
            assert len(manifest['addedLooks'])==2+6*recipe['monoReplicas']
        padding=start+length
    assert not any(dec[padding:rt['end']-4-len(marker)])
    return dict(schema=1,decoder='DoYitNow/gr-custom-tool codec at 0c15c8f9a97b464ac23ab1641740a8263e0068b0',
        output_sha256=n['sha256'],output_bytes=len(new),decoded_sha256=hashlib.sha256(dec).hexdigest(),
        decoded_bytes=len(dec),frames=len(frames),project=609,empty_model_area_preserved=True,
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
