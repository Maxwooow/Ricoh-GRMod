"""Verify a guarded function experiment against the original IIIx 1.60 ARM code.

Executes injected ARM instructions; it does not boot a camera or encode JPEG/RAW files.
"""
import argparse
import hashlib
import json
import struct
from fractions import Fraction
from pathlib import Path
from unicorn import UC_HOOK_MEM_WRITE
from native_probe import NativeProbe, BASE, OBJECT, OUTPUT, PREVIEW, RTOS_SHA, MUTEX
from identity import PROFILES
def by_rtos_sha(sha):
    for p in PROFILES:
        if p['rtos_sha256']==sha: return p
    raise ValueError('Experiment identity does not match a known RTOS')
from rear_dial_probe import RearDialProbe, SELECTOR, DATA
from ratio_menu import T4, menu as menu_of, parse

if not __debug__: raise RuntimeError('Validation requires Python assertions; run without -O')

RATIOS = T4  # the T4 menu; a manifest may declare another menu (see ratio_menu)
SITES = {0x536a2a34: bytes.fromhex('0dc0a0e1'), 0x5366634c: bytes.fromhex('36feffeb'),
         0x53666500: bytes.fromhex('920d84e2')}

def crop(w,h,ratio):
    r = parse(ratio); n,d = r.numerator,r.denominator
    def nearest4(value): return 4*((value+2)//4)
    if w*d <= h*n: return w,nearest4(Fraction(w*d,n))
    return nearest4(Fraction(h*n,d)),h

class ExperimentProbe(NativeProbe):
    def __init__(self,data,manifest):
        self.preview_lock_depth=0; self.locked_window_writes=0
        super().__init__(data)
        self.install(data,manifest)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self._window_write,begin=OBJECT+36,end=OBJECT+67)

    def _hook(self,cpu,at,size,user):
        if at==MUTEX[0]: self.preview_lock_depth+=1
        if at==MUTEX[1]: self.preview_lock_depth-=1
        super()._hook(cpu,at,size,user)

    def _window_write(self,cpu,access,at,size,value,user):
        if self.preview_lock_depth!=1: raise AssertionError('Preview rectangle write outside native mutex')
        self.locked_window_writes+=1

    def install(self,data,manifest):
        if (manifest['schema'],manifest['kind'],manifest['profile'],manifest['originalRtosSha256'],
            manifest['originalLength'],manifest['base']) != (1,'gr3x-function-experiment',by_rtos_sha(manifest['originalRtosSha256'])['id'],manifest['originalRtosSha256'],len(data),BASE):
            raise ValueError('Experiment identity does not match the original RTOS')
        if manifest['firmwareGenerated'] or manifest['hardwareTested'] or manifest['rearDialPatched']:
            raise ValueError('Unexpected experiment scope')
        try: m=menu_of(manifest)
        except AssertionError as exc: raise ValueError('Unexpected ratio menu') from exc
        if [(r['ratio'],r['id']) for r in manifest['ratios']] != [(r,i) for r,_,i in m.rows]:
            raise ValueError('Unexpected ratio IDs')
        if len(manifest['sites']) != len(SITES): raise ValueError('Unexpected patch count')
        append=manifest['append']; payload=bytes.fromhex(append['bytes'])
        end=BASE+len(data); limit=BASE+((len(data)+4095)&~4095)
        if append['address'] != end or not payload or len(payload)%4 or end+len(payload)>limit:
            raise ValueError('Experiment append is outside the verified probe page')
        cycle=manifest['entries']['directedCycle']
        if not end<=cycle<end+len(payload) or cycle%4 or payload[cycle-end:cycle-end+4]!=bytes.fromhex('010051e3'):
            raise ValueError('Invalid directed-cycle entry')
        seen=set()
        for site in manifest['sites']:
            at=site['address']; old=bytes.fromhex(site['expected']); new=bytes.fromhex(site['replacement'])
            if at not in SITES or at in seen or old!=SITES[at] or len(new)!=4 or data[at-BASE:at-BASE+4]!=old:
                raise ValueError('Experiment instruction guard failed')
            seen.add(at)
            word=struct.unpack('<I',new)[0]; displacement=word&0xffffff
            if displacement&0x800000: displacement-=0x1000000
            target=at+8+4*displacement
            if word>>24 != 0xea or not end <= target < end+len(payload):
                raise ValueError('Experiment branch target is not its payload')
        # Validate all sites before applying any change; no modified RTOS is written to disk.
        self.uc.mem_write(end,payload)
        for site in manifest['sites']: self.uc.mem_write(site['address'],bytes.fromhex(site['replacement']))

class DirectedCycleProbe(RearDialProbe):
    def __init__(self,data,manifest):
        super().__init__(data)
        ExperimentProbe.install(self,data,manifest)

def verify_cycle(data,manifest):
    m=menu_of(manifest)
    n=DirectedCycleProbe(data,manifest);order=m.order;entry=manifest['entries']['directedCycle'];calls=0
    for initial in order:
        for direction in (0,1):
            n.reset({DATA+0x44:1,DATA+0x4c2:initial})
            index=order.index(initial)
            for _ in order:
                n.notifications=[]
                assert n.call(entry,SELECTOR,direction)==1
                index=(index+(1 if direction else -1))%len(order)
                assert bytes(n.uc.mem_read(DATA+0x4c2,1))==bytes([order[index]])
                assert n.notifications==[[0x62053000,0x183,0,0]]
                calls+=1
            assert bytes(n.uc.mem_read(DATA+0x4c2,1))==bytes([initial])
    for initial in sorted({1,2,m.max_id+1,11,255}):
        for direction in (0,1,2,0xffffffff):
            n.reset({DATA+0x44:1,DATA+0x4c2:initial})
            assert n.call(entry,SELECTOR,direction)==0
            assert bytes(n.uc.mem_read(DATA+0x4c2,1))==bytes([initial]) and not n.notifications
            calls+=1
    for direction in (2,0xffffffff):
        n.reset({DATA+0x44:1,DATA+0x4c2:0})
        assert n.call(entry,SELECTOR,direction)==0
        assert bytes(n.uc.mem_read(DATA+0x4c2,1))==b'\0' and not n.notifications
        calls+=1
    return dict(calls=calls,menu_entries=len(order),nine_ratio_forward_reverse_wrap=len(order)==9,all_entries_forward_reverse_wrap=True,
                original_getter_setter_executed=True,original_notification_arguments=True,
                invalid_id_direction_ignored=True,selector_ram_only=True,persistence_tested=False,
                installed_in_rear_dial_router=False,queue_delivery_stubbed=True)

def preview(probe,aspect,scale,divisor=1,source=(45<<16,30<<16)):
    state=bytearray(0x2600)
    for offset,value in ((4,source[0]),(8,source[1]),(20,source[0]),(24,source[1]),(0x1ca8,divisor)):
        struct.pack_into('<I',state,offset,value)
    probe.uc.mem_write(OBJECT,bytes(state))
    probe.call(PREVIEW,OBJECT,0,aspect,scale)
    if isinstance(probe,ExperimentProbe): assert probe.preview_lock_depth==0
    after=bytes(probe.uc.mem_read(OBJECT,len(state)))
    rects=[struct.unpack_from('<4I',after,offset) for offset in (36,52)]
    return after,rects

def verify(data,manifest,patched=None):
    menu=menu_of(manifest)
    original=NativeProbe(data)
    if patched is None:patched=ExperimentProbe(data,manifest)
    counts=dict(factory_dimensions=0,factory_previews=0,factory_dng=0,
                custom_dimensions=0,custom_previews=0,custom_dng=0)
    rows=[]
    for aspect in range(4):
        for s in range(4):
            for m in (1.0,1.25,1.78):
                assert patched.dimensions(aspect,s,m)==original.dimensions(aspect,s,m)
                counts['factory_dimensions']+=1
        for scale in (4096,8192,16384):
            assert preview(patched,aspect,scale)==preview(original,aspect,scale)
            counts['factory_previews']+=1
        for m in (1.0,1.25,1.78):
            assert patched.dng_window(aspect,m)==original.dng_window(aspect,m)
            counts['factory_dng']+=1
    for ratio,_,aspect in menu.rows:
        if aspect < 4: continue
        for s in range(4):
            for m in (1.0,1.25,1.78):
                base=original.dimensions(0,s,m); expected=crop(base['width'],base['height'],ratio)
                patched.uc.mem_write(OUTPUT+4,b'\xa5'*12)
                row=patched.dimensions(aspect,s,m)
                assert (row['width'],row['height'])==expected,(ratio,row,expected)
                assert bytes(patched.uc.mem_read(OUTPUT+4,12))==b'\xff'*4+b'\xa5'*8
                assert all(v>0 and v%4==0 for v in expected)
                rows.append(dict(ratio=ratio,**row)); counts['custom_dimensions']+=1
        sw,sh=crop(720,480,ratio)
        for scale in (4096,8192,16384):
            for divisor in (1,2,3):
                # Check both native output rectangles, including unequal source extents.
                before,rects=preview(original,0,scale,divisor,(6000<<8,4000<<8))
                after,actual=preview(patched,aspect,scale,divisor,(6000<<8,4000<<8))
                expected=[]
                for w,h,x,y in rects:
                    if sw<720:
                        v=w*sw//720; expected.append((v,h,(x+(w-v+1)//2)&0xffffffff,y))
                    else:
                        v=h*sh//480; expected.append((w,v,x,(y+(h-v+1)//2)&0xffffffff))
                assert actual==expected,(ratio,scale,divisor,actual,expected)
                assert after[:36]==before[:36] and after[68:]==before[68:]
                counts['custom_previews']+=1
        for m in (1.0,1.25,1.78):
            base=original.dng_window(0,m)['window']; w,h=crop(base['width'],base['height'],ratio)
            expected=dict(width=w,height=h,left=68+(6000-w)//2,top=40+(4000-h)//2)
            patched.uc.mem_write(OUTPUT+8,b'\xa5'*8)
            actual=patched.dng_window(aspect,m)['window']
            assert actual==expected,(ratio,m,actual,expected)
            assert bytes(patched.uc.mem_read(OUTPUT+8,8))==b'\xa5'*8
            counts['custom_dng']+=1
    # Unknown IDs still reach original diagnostics rather than silently becoming 3:2.
    for aspect in sorted({menu.max_id+1,11,255}):
        try: patched.dimensions(aspect)
        except ValueError as exc:
            assert 'assertion failed' in str(exc)
        else: raise AssertionError('Invalid aspect accepted')
    corrupt=bytearray(data); corrupt[0]^=1
    try: ExperimentProbe(bytes(corrupt),manifest)
    except ValueError: pass
    else: raise AssertionError('Unknown RTOS accepted')
    bad=json.loads(json.dumps(manifest)); bad['sites'][0]['address']+=4
    try: ExperimentProbe(data,bad)
    except ValueError: pass
    else: raise AssertionError('Incorrect hook site accepted')
    cycle=verify_cycle(data,manifest)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),
                manifest_sha256=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),
                calls=counts,total_calls=sum(counts.values())+cycle['calls'],photo_rows=rows,directed_cycle=cycle,
                callee_saved_cpu_vfp_and_stack=True,output_canaries=True,
                both_preview_rectangles=True,original_ids_unchanged=True,invalid_ids_rejected=True,
                preview_writes_inside_original_mutex=True,locked_window_writes=patched.locked_window_writes,
                hardware_tested=False,firmware_generated=False,rear_dial_patched=False,
                scope='Injected ARM dimension/preview code and original DNG window; no camera boot, ISP, JPEG/RAW serialization or playback.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--rtos',type=Path,required=True); p.add_argument('--manifest',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True); args=p.parse_args()
    if args.report.resolve() in (args.rtos.resolve(),args.manifest.resolve()): raise ValueError('Output overlaps input')
    report=verify(args.rtos.read_bytes(),json.loads(args.manifest.read_text()))
    with args.report.open('x') as f: json.dump(report,f,indent=2); f.write('\n')
    print(json.dumps({k:v for k,v in report.items() if k!='photo_rows'},indent=2))
