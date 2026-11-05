"""Round 8: the Image Control order and hidden looks (core/src/fw/gr3x/look-layout.ts), executed in
the built image.

ImageControlModel's value count (0x532c2a9c), entry (0x532c2c80) and reverse lookup (0x532c2f08)
are run for the still (Image Control, ADJ), movie and RAW development lists (the model's byte
+0x1b 0, 1, 2) and each active set (0..2; GetActiveImageControlSet is substituted): the count is
the list's length, entry i the list's i-th look and the reverse lookup the entry of every look 0..255
(the count when the list does not have it; without a layout the camera's own count, 12 or 10,
as its search gives it before the films' lookup). The lists are the layout's order without the hidden
looks, of the looks each list has (still: the camera's twelve and the films; movie: its ten; RAW
development: the twelve). Without a layout (round 7 and round 8 builds alike) the same is checked
for the camera's order and the films after the twelve. Another byte value (3) gives what the
camera's own code gives. The camera's list widgets and controllers are not executed.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import NativeProbe,STACK,STOP,DIAGNOSTIC

if not __debug__:raise RuntimeError('Validation requires Python assertions')

COUNT,ITEM,INDEX,ACTIVE_SET,MAXIMUM,RAW_COUNT=0x532c2a9c,0x532c2c80,0x532c2f08,0x532bd6d4,0x532c2b7c,0x53283c08
STILL=[11,12,13,14,15,16,22,17,18,19,20,21]
MOVIE=[11,12,13,15,16,22,17,18,19,21]
MODEL=0x62058000

class ListProbe:
    """Runs the three functions with the active set substituted; records assertions instead of raising."""
    def __init__(self,probe,original=False):
        self.p=probe;self.uc=probe.uc;self.set=0;self.asserts=0
        self.uc.hook_add(1<<2,self._hook,begin=ACTIVE_SET,end=ACTIVE_SET)   # UC_HOOK_CODE
        self.uc.hook_add(1<<2,self._diag,begin=DIAGNOSTIC,end=DIAGNOSTIC)
        # The original image: the user-data getter as AdjProbe substitutes it (0x5320b7fc).
        if original:self.uc.hook_add(1<<2,self._userdata,begin=0x5320b7fc,end=0x5320b7fc)
    def _userdata(self,cpu,at,size,user):
        cpu.reg_write(reg.UC_ARM_REG_R0,0x62049000);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def _hook(self,cpu,at,size,user):
        cpu.reg_write(reg.UC_ARM_REG_R0,self.set);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def _diag(self,cpu,at,size,user):
        if cpu.reg_read(reg.UC_ARM_REG_R0)==0:self.asserts+=1
        cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def run(self,at,*args):
        c=self.uc
        for n in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(n)),0x5550+n)
        for n,v in enumerate(args):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(n)),v)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP);c.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        saved=[c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n))) for n in range(4,12)]
        c.emu_start(at,STOP,count=200000)
        assert c.reg_read(reg.UC_ARM_REG_PC)==STOP and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        assert [c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n))) for n in range(4,12)]==saved
        return c.reg_read(reg.UC_ARM_REG_R0)
    def model(self,flag,set_):
        self.uc.mem_write(MODEL,bytes(0x40));self.uc.mem_write(MODEL+0x1b,bytes([flag,set_]));self.set=set_

def expected(manifest):
    films=manifest.get('filmCount') or 0
    order=STILL+[64+k for k in range(films)];hidden=[]
    layout=manifest.get('lookLayout')
    if layout:
        assert manifest.get('round8') and sorted(layout['order'])==sorted(order) and len(set(layout['order']))==len(order)
        assert 11 not in layout['hidden'] and set(layout['hidden'])<=set(order)
        order,hidden=list(layout['order']),list(layout['hidden'])
    shown=[x for x in order if x not in hidden]
    # Round 10 (GR IV): the films are in the movie list too.
    film=lambda x:manifest.get('round10') and x>=64
    return {0:shown,1:[x for x in shown if x in MOVIE or film(x)],2:[x for x in shown if x in STILL]},bool(layout)

def verify(data,manifest):
    lists,layout=expected(manifest);films=manifest.get('filmCount') or 0
    p=ListProbe(AdjProbe(data,manifest));calls=0;cases=0
    # Without a layout the camera's movie and RAW development lists are its own (films in the still list only).
    if not layout:assert lists[1]==MOVIE+([64+k for k in range(films)] if manifest.get('round10') else []) and lists[2]==STILL
    for flag in (0,1,2):
        L=lists[flag]
        for set_ in (0,1,2):
            p.model(flag,set_);p.asserts=0
            n=p.run(COUNT,MODEL);calls+=1
            assert n==len(L),(flag,set_,n,len(L))
            got=[p.run(ITEM,MODEL,i) for i in range(n)];calls+=n
            assert got==L,(flag,set_,got)
            for look in range(256):
                at=p.run(INDEX,MODEL,look);calls+=1;cases+=1
                # Not in the list: the count with a layout (the camera's own convention); without one the
                # camera's search runs first and gives its own count (12, movie 10), the films following it.
                missing=n if layout else (10 if flag==1 else 12)
                assert at==(L.index(look) if look in L else missing),(flag,set_,look,at)
            assert p.asserts==0,(flag,set_)
    # Byte value 3 (no list of the camera's): the camera's own answers and assertions.
    native=NativeProbe(data);native.uc.mem_map(0x5503b000,0x55800000-0x5503b000)   # the zero-filled data, as AdjProbe
    o=ListProbe(native,original=True)
    for set_ in (0,1,2):
        p.model(3,set_);o.model(3,set_);p.asserts=o.asserts=0
        assert p.run(COUNT,MODEL)==o.run(COUNT,MODEL) and p.asserts==o.asserts;calls+=1
        for i in (0,5,11):
            p.asserts=o.asserts=0
            assert p.run(ITEM,MODEL,i)==o.run(ITEM,MODEL,i) and p.asserts==o.asserts;calls+=1
        for look in (11,22,64):
            p.asserts=o.asserts=0
            assert p.run(INDEX,MODEL,look)==o.run(INDEX,MODEL,look) and p.asserts==o.asserts;calls+=1
    # The widget allocation keeps its largest count (the camera's 12, with films 12 + n).
    p.model(0,0);assert p.run(MAXIMUM,MODEL)==12+films;calls+=1
    # RAW development's dial (RawDevelopmentModel's own count, 0x53283c08): the RAW development list's
    # length, so that its entries are the list's only (without a layout the camera's twelve).
    for set_ in (0,1,2):
        p.model(2,set_);assert p.run(RAW_COUNT,MODEL)==len(lists[2])==(len(lists[2]) if layout else 12);calls+=1
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,reverse_lookups=cases,layout=layout,
        lists={['still','movie','raw_development'][f]:L for f,L in lists.items()},hardware_tested=False,
        scope='The three ImageControlModel functions natively, the active set substituted; list widgets and controllers not executed.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    a=a.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
