"""T3/T4 differential probe of native live-view YUV420 descriptors.

Executes the original producer AND consuming Ch0/Ch1/resize builders. Checks
their emitted coordinates and addresses, independently of the patch's height
formula. Common-aperture geometry is synthetic; a second still-mode fixture
executes the native VRAM constructor (1920x1088 capacity). No pixels, physical
ISP/DMA, capture/half-press events or camera timing are emulated.
"""
import hashlib,json
from pathlib import Path
from display_descriptor_probe import DisplayProbe
from ratio_menu import menu as menu_of, is_t4

T3_MANIFEST_SHA='fb48c12cf8f8ad211b26a2bc47ddc4babb31770cde82a43d91fc9610f9a9b4a6'
WIDE=(5,6,7)
USER_IDS=(0,3,4,5,6,7,8,9,10)
FLAGS=((0,0),(0,1),(1,0),(1,1))

class CountedProbe(DisplayProbe):
    def __init__(self,*args):
        self.calls=0
        super().__init__(*args)
    def call(self,*args,**kwargs):
        self.calls+=1
        return super().call(*args,**kwargs)

def verify(data,manifest):
    archived=Path(__file__).with_name('fixtures')/'t3-patch-manifest.json'
    raw=archived.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==T3_MANIFEST_SHA
    old=CountedProbe(data,json.loads(raw));current=CountedProbe(data,manifest)
    m=menu_of(manifest)
    if not is_t4(m): return verify_custom(old,current,m)
    direct_states=unchanged_direct=old_odd=0
    examples=[]
    for mode in (0,2):
        for resolution in range(1,32):
            for flags in FLAGS:
                for identity in range(11):
                    before=old.recipe(identity,resolution,mode,flags)
                    after=current.recipe(identity,resolution,mode,flags)
                    direct_states+=1
                    if identity not in WIDE:
                        assert before==after,(identity,resolution,mode,flags)
                        unchanged_direct+=1
                        continue
                    assert after['in_bounds'],after
                    assert before['allocation']==after['allocation']
                    assert before['dimensions'][0]==after['dimensions'][0]
                    assert before['dimensions'][1]-after['dimensions'][1] in (0,2)
                    assert after['aperture_origin'][1]%2==0,after
                    assert all(address%2==0 for address in after['write_addresses']),after
                    if any(address%2 for address in before['write_addresses']):
                        old_odd+=1
                        examples.append(dict(id=identity,resolution=resolution,mode=mode,flags=flags,
                            T3={k:before[k] for k in ('dimensions','aperture_origin','write_addresses')},
                            T4={k:after[k] for k in ('dimensions','aperture_origin','write_addresses')}))
    assert direct_states==2728 and old_odd==27
    # Resolutions 2/3 are selected by the original still-mode selector.
    # Exercise both its aperture fixture and the initial native VRAM capacity.
    # Full software-resizer checks deliberately use mode=0 and unit zoom:
    # video/interlaced and zoom modes need different source/scaler metadata.
    resize_states=unchanged_resize=old_resize_odd=0
    native_fixture_flags=[];resize_examples=[]
    for allocation_kind,resolutions in (('aperture',range(1,32)),('native-vram',(2,3))):
        for resolution in resolutions:
            for flags in FLAGS:
                for identity in USER_IDS:
                    before=old.display(identity,resolution,flags,allocation_kind=allocation_kind)
                    after=current.display(identity,resolution,flags,allocation_kind=allocation_kind)
                    resize_states+=1
                    if identity not in WIDE:
                        assert before==after,(identity,resolution,flags,allocation_kind)
                        unchanged_resize+=1
                    failed=[name for name in ('ch0','ch1','display_source','display_destination')
                            if not after[name]['in_canvas']]
                    if failed:
                        assert allocation_kind=='aperture' and identity==3 and resolution in (5,7) and flags[1]==0
                        native_fixture_flags.append(dict(id=identity,resolution=resolution,flags=flags,fields=failed))
                    if identity in WIDE:
                        assert not failed,after
                        for name in ('display_source','display_destination'):
                            assert after[name]['format']==2,after
                            assert after[name]['rect'][1]%2==0,after
                            assert after[name]['rect'][5]%2==0,after
                        if any(before[name]['rect'][5]%2 for name in ('display_source','display_destination')):
                            old_resize_odd+=1
                        if resolution==2 and flags==(0,0):
                            resize_examples.append(dict(id=identity,allocation_kind=allocation_kind,
                                T3={k:before[k] for k in ('display_source','display_destination')},
                                T4={k:after[k] for k in ('display_source','display_destination')}))
    assert resize_states==1188 and len(native_fixture_flags)==4 and old_resize_odd>0
    # The direct consumer also accepts the three existing digital crop scales.
    # This does not substitute for emulating full software-resizer zoom state.
    zoom_states=0
    for resolution in (2,3):
        for flags in FLAGS:
            for zoom in (10240,14629):
                for identity in WIDE:
                    after=current.recipe(identity,resolution,0,flags,zoom,allocation_kind='native-vram')
                    assert after['in_bounds'],after
                    assert all(address%2==0 for address in after['write_addresses']),after
                    zoom_states+=1
    return dict(schema=1,calls=old.calls+current.calls,T3_manifest_sha256=T3_MANIFEST_SHA,
        direct_states=direct_states,T3_odd_write_address_states=old_odd,T4_odd_write_address_states=0,
        resize_states=resize_states,T3_odd_resize_origin_states=old_resize_odd,T4_odd_resize_origin_states=0,
        native_and_nonwide_direct_states_identical=unchanged_direct,
        native_and_nonwide_resize_states_identical=unchanged_resize,
        direct_zoom_states=zoom_states,native_vram_capacity=[1920,1088],
        physical_allocation_unchanged=True,wide_height_delta_at_most_two=True,
        native_fixture_bounds_flags=native_fixture_flags,examples=examples,resize_examples=resize_examples,
        hardware_tested=False,
        scope='Synthetic native function execution. Full resize checks: mode 0, unit zoom, 31 aperture modes and native initial VRAM capacity for still resolutions 2/3. Direct Ch0 checks: modes 0/2; digital crop scales additionally checked in still modes. Four original square/interlaced fixture bounds flags also exist in T3. No pixel transfers, ISP/DMA, physical capture/resume timing or flicker suppression is established.')

def verify_custom(old,current,m):
    """Another ratio list: native identities are compared with the archived T3 build; every added
    identity must keep the T4 invariants (in bounds, even chroma origins and write addresses,
    unchanged allocation, YUV420 display formats for wide crops)."""
    direct=unchanged=native_odd=0
    odd=lambda r:r['aperture_origin'][1]%2 or any(address%2 for address in r['write_addresses'])
    for mode in (0,2):
        for resolution in range(1,32):
            for flags in FLAGS:
                base=None
                for identity in range(4):
                    before=old.recipe(identity,resolution,mode,flags);after=current.recipe(identity,resolution,mode,flags)
                    assert before==after,(identity,resolution,mode,flags);unchanged+=1;direct+=1
                    if identity==0:base=after
                for identity,_,_ in m.custom:
                    after=current.recipe(identity,resolution,mode,flags);direct+=1
                    assert after['in_bounds'],after
                    assert after['allocation']==base['allocation']
                    # Wide crops are realigned (T4). A narrow crop keeps the native rows, and with
                    # them the one odd native fixture state that 3:2 itself has.
                    if identity in m.wide or not odd(base):assert not odd(after),after
                    elif odd(after):native_odd+=1
    resize=0;native_fixture_flags=[]
    for allocation_kind,resolutions in (('aperture',range(1,32)),('native-vram',(2,3))):
        for resolution in resolutions:
            for flags in FLAGS:
                for identity in m.user_ids:
                    after=current.display(identity,resolution,flags,allocation_kind=allocation_kind);resize+=1
                    if identity<4:
                        assert old.display(identity,resolution,flags,allocation_kind=allocation_kind)==after;unchanged+=1
                    failed=[name for name in ('ch0','ch1','display_source','display_destination') if not after[name]['in_canvas']]
                    if failed:
                        assert allocation_kind=='aperture' and identity==3 and resolution in (5,7) and flags[1]==0
                        native_fixture_flags.append(dict(id=identity,resolution=resolution,flags=flags,fields=failed))
                    if identity in m.wide:
                        for name in ('display_source','display_destination'):
                            assert after[name]['format']==2,after
                            assert after[name]['rect'][1]%2==0 and after[name]['rect'][5]%2==0,after
    assert len(native_fixture_flags)==4
    zoom=0
    for resolution in (2,3):
        for flags in FLAGS:
            for z in (10240,14629):
                base=current.recipe(0,resolution,0,flags,z,allocation_kind='native-vram')
                for identity,_,_ in m.custom:
                    after=current.recipe(identity,resolution,0,flags,z,allocation_kind='native-vram')
                    assert after['in_bounds'],after
                    if identity in m.wide or not odd(base):assert not odd(after),after
                    zoom+=1
    return dict(schema=1,calls=old.calls+current.calls,custom_menu=True,T3_manifest_sha256=T3_MANIFEST_SHA,
        direct_states=direct,resize_states=resize,direct_zoom_states=zoom,native_states_identical_to_T3=unchanged,
        custom_wide_odd_write_address_states=0,narrow_odd_states_matching_native_3x2=native_odd,custom_odd_resize_origin_states=0,native_fixture_bounds_flags=native_fixture_flags,
        hardware_tested=False,scope='As for T4; native identities compared with T3, added identities checked against the T4 invariants.')

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('rtos','manifest','report'):parser.add_argument(key,type=Path)
    a=parser.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('examples','resize_examples')},indent=2))
