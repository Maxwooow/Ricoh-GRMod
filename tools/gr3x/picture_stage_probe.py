"""Films' picture-stage additions (round 3): halation stash, second matrix, JPEG stage chain.

With every patch of the manifest installed:
  - the still descriptor builder (0x536dc0f4) leaves look | level << 8 | valid in the stash for
    every native look and film, with each film's build-time level;
  - the matrix module's wrapper (0x536df3d4) programs each film's post-curve matrix, the identity
    for every other look, and leaves the pre-curve registers as the firmware computes them;
  - the JPEG encode entry (0x535047d4) runs the chain of modules and returns into Execute with
    every register and the stack as on entry; the halation module changes a synthetic 4:2:2
    picture exactly as GR Mod's reference (halateYcc, written by the build script) for films with
    halation and leaves it alone otherwise; the diagnostic date module prints on the picture.
    The configuration and the picture descriptors lie below 0x5d000000, as on the camera (part of a
    process object; the first diagnostic build refused them there and printed nothing).
  - diagnostic builds: the halation module's status word for every look (film with halation:
    done, one picture; others: why it stopped; format byte and refusal of the first picture), the
    stash and status printed in row 0 of a 720-wide picture, and nothing written into planes below
    0x5d000000.
Synthetic objects only; JPEG encoding, the ISP and the camera's real pictures are not executed.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn import arm_const as reg
from image_control_probe import LookProbe, CONTEXT, COMMON, NATIVE
from native_probe import NativeProbe, OBJECT, OUTPUT, STACK, STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

STASH=0x55804378;EXECUTE=0x535047d4;WRAP=0x536df3d4;PROCESS=0x536deecc;RESET,INIT=0x536dece8,0x536ded70
CACHE,INVALIDATE,CLEAN,ALLOC,FREE=0x536bbc30,0x536bbcc0,0x536bbcac,0x536af2a8,0x536af2e4
PLATFORM,GET_TIME=0x536bd838,0x536b6510
MOBJ,REGS=0x62c00000,0x62c10000
# Configuration, request and descriptors in RTOS-heap-like memory (below 0x5d000000), as on the camera.
CFG,ARG,PIC=0x558c0000,0x558c0100,0x558c0200
IMG,HEAP,LOWIMG=0x63000000,0x64000000,0x5c000000
STATUS=0x5580437c
IDENTITY=[512,0,0,0,512,0,0,0,512]

def u32(uc,a):return struct.unpack('<I',uc.mem_read(a,4))[0]

class StageProbe(LookProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest)
        for base,size in ((0x55800000,0x100000),(0x62c00000,0x200000),(IMG,0x200000),(HEAP,0x800000),(LOWIMG,0x200000)):
            try:self.uc.mem_map(base,size)
            except Exception:pass
        self.log={'invalidate':0,'clean':0,'alloc':[],'free':0,'time':0};self.heap=HEAP
        self.uc.hook_add(UC_HOOK_CODE,self._stage,begin=0x536af000,end=0x536be000)
    def _stage(self,cpu,at,size,user):
        ret=lambda v=None:(v is not None and cpu.reg_write(reg.UC_ARM_REG_R0,v),cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR)))
        if at==INVALIDATE:self.log['invalidate']+=1;ret()
        elif at==CLEAN:self.log['clean']+=1;ret()
        elif at==ALLOC:
            n=cpu.reg_read(reg.UC_ARM_REG_R0);a=self.heap;self.heap=(a+n+63)&~63;self.log['alloc'].append(n)
            assert self.heap<HEAP+0x800000;ret(a)
        elif at==FREE:self.log['free']+=1;ret()
        elif at==PLATFORM:ret(0x62d00f00)
        elif at==GET_TIME:
            # 2026-10-22 17:05:09, as the camera's read-time function lays it out.
            cpu.mem_write(cpu.reg_read(reg.UC_ARM_REG_R1),struct.pack('<H6BH',2026,10,22,17,5,9,0,0));self.log['time']+=1;ret()
    def regs_post(self):return [(v&0xfff)-(0x1000 if v&0x800 else 0) for v in struct.unpack('<9H',self.uc.mem_read(REGS+0x1120,18))]
    def regs_pre(self):return bytes(self.uc.mem_read(REGS+0x20,18))

def picture(Y,C,w,h):return struct.pack('<B3xIII4H2H4x',1,Y,C,w*h,w,h,w,h,0,0)

def run_execute(n,film,w,h,y,c,img=IMG):
    """Enter the patched Execute and stop where the chain hands over to the original body."""
    uc=n.uc;uc.mem_write(img,y);uc.mem_write(img+0x100000,c)
    uc.mem_write(PIC,picture(img,img+0x100000,w,h));uc.mem_write(PIC+0x40,picture(img,img+0x100000,w,h))
    cfg=bytearray(0x60);struct.pack_into('<4I',cfg,0x3c,PIC,PIC+0x40,0,0);uc.mem_write(CFG,bytes(cfg))
    uc.mem_write(ARG,struct.pack('<3I',0,0,CFG));uc.mem_write(0x62d00f00,struct.pack('<2I',0,0x62d00f80))
    uc.mem_write(STASH,struct.pack('<2I',film,0xa5a5a5a5))
    n.log={'invalidate':0,'clean':0,'alloc':[],'free':0,'time':0};n.heap=HEAP
    values=[0x62e00000+i*0x100 for i in range(13)];values[0]=0x62d00800;values[1]=ARG
    for i,v in enumerate(values):uc.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
    uc.reg_write(reg.UC_ARM_REG_SP,STACK);uc.reg_write(reg.UC_ARM_REG_LR,STOP);uc.reg_write(reg.UC_ARM_REG_CPSR,0x13)
    uc.emu_start(EXECUTE,EXECUTE+4,timeout=900_000_000,count=600_000_000)
    assert uc.reg_read(reg.UC_ARM_REG_PC)==EXECUTE+4
    got=[uc.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(12)]
    # `mov ip,sp` has just been re-executed: ip = sp, as the original first instruction leaves it.
    assert got==values[:12] and uc.reg_read(reg.UC_ARM_REG_SP)==STACK and uc.reg_read(reg.UC_ARM_REG_R12)==STACK
    assert uc.reg_read(reg.UC_ARM_REG_LR)==STOP
    return bytes(uc.mem_read(img,w*h)),bytes(uc.mem_read(img+0x100000,w*h))

def verify(data,manifest,reference=None):
    films=manifest['addedLooks'];entries=manifest['lookEntries'];calls=0;report={}
    n=StageProbe(data,manifest)
    round6=manifest.get('filmCount');round7=manifest.get('round7')
    # 1. Stash: every look the builder sees leaves its id, its level and the valid bit.
    if manifest.get('round10'):
        # Round 10 (GR IV's way): the development step reads the level from the film's Toning byte
        # (+0x786 of the picture's parameters, GR IV's states 0..11: 1 / 3 / 2 weak / medium / strong
        # red, 4..6 white, 0 and 7..11 off); a film 64 + k is left as 32 + k.
        cases=0
        def level(state):
            if state>=7:return 0,0
            if state>=4:return state-3,1
            return {3:2,2:3}.get(state,state),0
        for tone in NATIVE+list(range(64,84))+[0,63,84,255]:
            for state in list(range(13))+[0x7f,0xff]:
                n.uc.mem_write(STASH,b'\xa5'*4);n.descriptor(tone,state);calls+=1;cases+=1
                v,w=level(state) if 64<=tone<64+round6 else (0,0)
                look=tone-32 if tone>=64 else tone
                assert u32(n.uc,STASH)==look|v<<8|(0x20000 if w else 0)|0x10000,(tone,state,hex(u32(n.uc,STASH)))
        report['stash_states']=cases
    elif round7:
        # Round 7: slots3.c's settings (strength | white << 2) per film and photo set (State 'TLS3',
        # settings at +587); a film 64 + k is left as 32 + k, the strength at bits 8..15, white at bit 17.
        state=0x55880000;n.uc.mem_write(state,bytes(0x400))
        n.uc.mem_write(state,struct.pack('<5I',0x33534c54,1,0,0,round6))
        st=lambda k,s:(k+3*s)%8
        n.uc.mem_write(state+587,bytes(st(k,s) for k in range(20) for s in range(3)))
        rec=0x55890000;n.uc.mem_write(rec,bytes(0xb28));n.uc.mem_write(0x55063f34,struct.pack('<I',rec))
        cases=0
        for table in (True,False):
            n.uc.mem_write(0x55804374,struct.pack('<I',state if table else 0))
            for movie in (0,1):
                for s in range(3):
                    n.uc.mem_write(rec+0x44,bytes([movie]));n.uc.mem_write(rec+0x1c0,bytes([s]))
                    for tone in NATIVE+list(range(64,84))+[0,63,255]:
                        n.uc.mem_write(STASH,b'\xa5'*4);n.descriptor(tone);calls+=1;cases+=1
                        v=st(tone-64,s) if table and not movie and 64<=tone<64+round6 else 0
                        look=tone-32 if tone>=64 else tone
                        assert u32(n.uc,STASH)==look|(v&3)<<8|(0x20000 if v&4 else 0)|0x10000,(tone,s,movie,hex(u32(n.uc,STASH)))
        n.uc.mem_write(0x55804374,b'\0'*4)
        report['stash_states']=cases
    elif round6:
        # Round 6: the level is the film's Halation in the active photo set (slots2.c's table,
        # planted here: State 'TLS2', loaded, films, levels at +587); none in movie mode, none for
        # looks this build does not have, none without the table.
        state=0x55880000;n.uc.mem_write(state,bytes(0x400))
        n.uc.mem_write(state,struct.pack('<5I',0x32534c54,1,0,0,round6))
        lv=lambda k,s:(k+2*s)%3
        n.uc.mem_write(state+587,bytes(lv(k,s) for k in range(20) for s in range(3)))
        rec=0x55890000;n.uc.mem_write(rec,bytes(0xb28));n.uc.mem_write(0x55063f34,struct.pack('<I',rec))
        cases=0
        for table in (True,False):
            n.uc.mem_write(0x55804374,struct.pack('<I',state if table else 0))
            for movie in (0,1):
                for s in range(3):
                    n.uc.mem_write(rec+0x44,bytes([movie]));n.uc.mem_write(rec+0x1c0,bytes([s]))
                    for tone in NATIVE+list(range(64,84))+[0,255]:
                        n.uc.mem_write(STASH,b'\xa5'*4);n.descriptor(tone);calls+=1;cases+=1
                        level=lv(tone-64,s) if table and not movie and 64<=tone<64+round6 else 0
                        assert u32(n.uc,STASH)==tone|level<<8|0x10000,(tone,s,movie,hex(u32(n.uc,STASH)))
        n.uc.mem_write(0x55804374,b'\0'*4)
        report['stash_states']=cases
    elif 'jpeg' in entries and 'halation' in entries['jpeg']:
        for tone in NATIVE+[f['id'] for f in films]:
            n.uc.mem_write(STASH,b'\xa5'*4);n.descriptor(tone);calls+=1
            level=next((f['halation'] for f in films if f['id']==tone),0)
            assert u32(n.uc,STASH)==tone|level<<8|0x10000,(tone,hex(u32(n.uc,STASH)))
        report['stash_states']=len(NATIVE)+len(films)
    # 2. Second matrix.
    if 'postMatrix' in entries:
        n.uc.mem_write(MOBJ,b'\xa5'*0x60);n.call(RESET,MOBJ);n.call(INIT,MOBJ)
        order=[f['id'] for f in films]+NATIVE+[f['id'] for f in films][::-1]
        for tone in order:
            n.descriptor(tone);desc=bytes(n.uc.mem_read(OUTPUT,0xa0))
            n.uc.mem_write(REGS,bytes(0x2000));n.call(WRAP,MOBJ,OUTPUT,REGS);calls+=1
            film=next((f for f in films if f['id']==tone),None)
            expected=film['postQ9'] if film and film.get('postQ9') else IDENTITY
            assert n.regs_post()==expected,(tone,n.regs_post(),expected)
            # The pre-curve stage is the firmware's own result: the unhooked process, then the
            # register writer, on the same descriptor and module object.
            pre=n.regs_pre();saved=bytes(n.uc.mem_read(MOBJ,0x60));n.uc.mem_write(OUTPUT,desc)
            n.uc.mem_write(REGS,bytes(0x2000));n.call(PROCESS,MOBJ,OUTPUT);n.call(0x536df13c,MOBJ,REGS);calls+=2
            assert n.regs_pre()==pre,tone
            assert bytes(n.uc.mem_read(MOBJ,0x30))==saved[:0x30],tone
        report['post_matrix_states']=len(order)
        report['films_with_post_matrix']=sum(1 for f in films if f.get('postQ9'))
    # 3. The JPEG stage chain.
    if 'jpeg' in entries:
        w,h=320,240
        y=bytes((16+((x*3+yy*5)%220) if not (140<x<180 and 100<yy<140) else 252) for yy in range(h) for x in range(w))
        c=bytes((128+((x//2+yy)%40)-20) for yy in range(h) for x in range(w))
        expected={}
        if reference:
            raw=Path(reference).read_bytes();k=0
            while k<len(raw):
                look,=struct.unpack_from('<I',raw,k);k+=4
                # Round 6: the header also says at which level the reference was made; round 7: the
                # header is the stash word (film 32 + k, strength, white).
                if round7:expected[look]=(raw[k:k+w*h],raw[k+w*h:k+2*w*h]);k+=2*w*h;continue
                expected[look&0xff]=(raw[k:k+w*h],raw[k+w*h:k+2*w*h],look>>8);k+=2*w*h
        results={}
        runs=[(11,0)]+[(f['id'],f['halation']) for f in films]
        if round6:runs=[(11,0),(11,2)]+[(f['id'],l) for f in films for l in ((0,expected[f['id']][2]) if f['id'] in expected else (0,1,2))]+[(64+round6,2)]
        if round7:
            # Round 7: the stash words of the reference (film 32 + k, strength, white) as they are,
            # every film Off, another strength and colour, a native look and looks without halation.
            results={}
            words=[(11,False),(11|3<<8|0x20000,False),((32+round6)|2<<8,False),(63|1<<8,False),(31|3<<8,False)]
            words+=[(32+k|v<<8|w,v>0) for k in range(round6) for v,w in ((0,0),(1+k%3,0),(3-k%3,0x20000))]
            words+=[(wd,True) for wd in expected]
            for word,changes in words:
                Y,C=run_execute(n,word|0x10000,w,h,y,c);calls+=1
                if word in expected:assert (Y,C)==expected[word][:2],hex(word)
                if changes:assert Y!=y and len(n.log['alloc'])>0,hex(word)
                else:assert (Y,C)==(y,c),hex(word)
                assert len(n.log['alloc'])==n.log['free']
                results[hex(word)]=dict(changed_luma=sum(a!=b for a,b in zip(Y,y)),allocs=len(n.log['alloc']),frees=n.log['free'],invalidate=n.log['invalidate'],clean=n.log['clean'])
            report['jpeg_stage']=results;report['halation_matches_reference']=bool(expected);runs=[]
        for tone,level in runs:
            film=next((f for f in films if f['id']==tone),None)
            if not film:level_in=level;level=0
            else:level_in=level
            Y,C=run_execute(n,tone|level_in<<8|0x10000,w,h,y,c);calls+=1
            diag='dateDiagnostics' in entries['jpeg']
            if level and 'halation' in entries['jpeg']:
                if tone in expected and not diag and expected[tone][2] in (0,level):assert (Y,C)==expected[tone][:2],tone
                assert Y!=y and len(n.log['alloc'])>0
            elif not diag:assert (Y,C)==(y,c),tone
            results[f'{tone}@{level_in}']=dict(level=level,changed_luma=sum(a!=b for a,b in zip(Y,y)),allocs=len(n.log['alloc']),frees=n.log['free'],
                               invalidate=n.log['invalidate'],clean=n.log['clean'],clock_reads=n.log['time'])
            assert len(n.log['alloc'])==n.log['free']
            if diag and 'halation' in entries['jpeg']:
                # Status: format 1 accepted; film with halation: done (8), one picture (the second
                # descriptor shares its planes); film without: 4; native look: 3.
                st=u32(n.uc,STATUS);want=0x10000|(0x108 if level else (4 if film else 3))
                assert st==want,(tone,hex(st),hex(want));results[f'{tone}@{level_in}']['status']=hex(st)
            if diag:
                # Row 0 of the diagnostics on this 320-wide picture: no stash/status (wide pictures only).
                assert any(Y[r*w+x]!=y[r*w+x] for r in range(4,20) for x in range(4,60)),tone
        if not round7:report['jpeg_stage']=results
        if 'dateDiagnostics' in entries['jpeg']:
            # 720 x 480: row 0 carries the stash and the status; the dump rows follow.
            w2,h2=720,480
            y2=bytes(((x+r)%200+20) for r in range(h2) for x in range(w2));c2=bytes([128])*(w2*h2)
            Y2,C2=run_execute(n,11|0x10000,w2,h2,y2,c2);calls+=1
            short=max(x for r in range(4,20) for x in range(w2) if Y2[r*w2+x]!=y2[r*w2+x])
            assert short>300,short   # 'A ' + 4 refusals + slot is ~110 px; with the two words ~360 px
            assert any(Y2[r*w2+x]!=y2[r*w2+x] for r in range(30,330) for x in range(4,200))
            # Planes below 0x5d000000 are never written by the diagnostics (native look: no halation).
            Y3,C3=run_execute(n,11|0x10000,w2,h2,y2,c2,img=LOWIMG);calls+=1
            assert (Y3,C3)==(y2,c2)
            report['diagnostics']=dict(row0_right_edge=short,low_planes_untouched=True)
        if not round7:report['halation_matches_reference']=bool(expected) and 'dateDiagnostics' not in entries['jpeg']
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,**report,hardware_tested=False,
        scope='Patched descriptor builder, matrix module wrapper and JPEG entry with synthetic objects; no ISP, encoder or camera picture.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    p.add_argument('--reference',type=Path)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()),a.reference)
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
