"""The two Custom entries before the films (core/src/fw/gr3x/custom-position.ts), executed in the built
image (GR III 2.10 / IIIx 1.60, round 10 with films).

The camera's list functions run natively, patched: the Image Control menu row's text (0x531a0538),
icon (0x531a0690), "is the current one" (0x531a1500) and select (0x531a0ba0), entered with a shown
entry; the icon strip's filling (0x531ab7e4), name line (0x531ab750), selection (0x531ab998) and
"is entry e the current one" (0x531abe0c). ImageControlModel's count and entry run natively too (the
look layout's), on a model whose byte +0x1b is 0 (still) or 1 (movie: nothing moves). Substituted:
the singletons (0x5320ad88, 0x5320ba9c), the active set and current look getters, the set and look
setters, the text and icon lookups, the strip's item and entry getters and the widgets' setters,
which are recorded. For every shown entry: a look before the first film is that look, entry P is
Custom 1, P + 1 Custom 2, then the films and the other looks (the layout's order without the hidden
looks), and the same in the strip; selecting an entry selects that look in the standard set, or the
Custom set; the current entry is the look in use in the standard set, or the Custom set in use.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP,DIAGNOSTIC
from look_layout_probe import expected

if not __debug__:raise RuntimeError('Validation requires Python assertions')

SINGLETON,MODEL_GET=0x5320ad88,0x5320ba9c
ACTIVE_SET,CURRENT_LOOK,SET_SET,SET_LOOK=0x532bd6d4,0x532bd6b4,0x532bd61c,0x532c26c0
LOOK_TEXT,TEXT_OF,ICON_OF,LOOK_ICON,MENU_LOOK_ICON=0x532922b4,0x532a985c,0x532a9988,0x532935dc,None
SET_TEXT,SET_ICON,STRIP_ITEM,STRIP_ENTRY,MENU_ITEM_GET=0x53396f80,0x533a1734,0x53394758,0x53394820,0x53394758
MENU_TEXT,MENU_ICON,MENU_CURRENT,MENU_SELECT=0x531a0538,0x531a0690,0x531a1500,0x531a0ba0
STRIP_FILL,STRIP_NAME,STRIP_SELECT,STRIP_CURRENT=0x531ab7e4,0x531ab750,0x531ab998,0x531abe0c
MODEL,THIS,WIDGET=0x62058000,0x6205a000,0x6205c000
CUSTOM={0x17:1,0x18:2}

class CustomProbe:
    def __init__(self,data,manifest):
        self.p=AdjProbe(data,manifest);self.uc=self.p.uc;self.log=[];self.set=0;self.look=11;self.entry=0
        # The RAM after the heap's start (the live layout's word 0x5580438c, 0 before the settings load: the build's position).
        try:self.uc.mem_map(0x55800000,0x100000)
        except Exception:pass
        self.stubs={SINGLETON:lambda r:0x62057000,MODEL_GET:lambda r:MODEL,ACTIVE_SET:lambda r:self.set,CURRENT_LOOK:lambda r:self.look,
            SET_SET:lambda r:self.rec('set',r(1)),SET_LOOK:lambda r:self.rec('look',r(1)),
            LOOK_TEXT:lambda r:0x1000+r(1),TEXT_OF:lambda r:0x2000+r(1),ICON_OF:lambda r:0x3000+r(1),LOOK_ICON:lambda r:0x4000+r(1),
            SET_TEXT:lambda r:self.rec('text',r(1)),SET_ICON:lambda r:self.rec('icon',(self.item,r(1))),
            STRIP_ITEM:self._item,STRIP_ENTRY:lambda r:self.entry}
        self.item=None
        self.uc.hook_add(1<<2,self._hook)
        self.uc.mem_write(THIS,bytes(0x400))
        for off in (0x160,0x164,0x174,0x1f0):self.uc.mem_write(THIS+off,struct.pack('<I',WIDGET))
    def _item(self,r):
        # (AdjProbe's own hook of the icon setter clears r0 before ours runs: the item is remembered here.)
        self.item=r(1);return 0x7000+r(1)
    def rec(self,kind,v):self.log.append((kind,v));return 1
    def _hook(self,cpu,at,size,user):
        f=self.stubs.get(at)
        if f is None:return
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        v=f(r);cpu.reg_write(reg.UC_ARM_REG_R0,v&0xffffffff);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def model(self,flag):self.uc.mem_write(MODEL,bytes(0x40));self.uc.mem_write(MODEL+0x1b,bytes([flag,0]))
    def run(self,at,*args):
        c=self.uc;self.log=[]
        for n in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(n)),0x5550+n)
        for n,v in enumerate(args):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(n)),v)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP);c.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        saved=[c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n))) for n in range(4,12)]
        c.emu_start(at,STOP,count=400000)
        assert c.reg_read(reg.UC_ARM_REG_PC)==STOP and c.reg_read(reg.UC_ARM_REG_SP)==STACK,hex(at)
        assert [c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n))) for n in range(4,12)]==saved,hex(at)
        return c.reg_read(reg.UC_ARM_REG_R0)

def verify(data,manifest):
    assert manifest.get('round10') and manifest.get('filmCount') and manifest.get('customsBeforeFilms')
    lists,_=expected(manifest);still=lists[0];n=len(still)
    P=next((i for i,x in enumerate(still) if x>=64),n)
    assert manifest['lookEntries']['films']['customPosition']==P
    # What shown entry v is: ('look', x) or ('custom', k).
    shown=[('look',x) for x in still[:P]]+[('custom',1),('custom',2)]+[('look',x) for x in still[P:]]
    native=[('look',x) for x in still]+[('custom',1),('custom',2)]
    pr=CustomProbe(data,manifest);calls=0
    text=lambda e:0x1000+e[1] if e[0]=='look' else 0x2000+(0x17 if e[1]==1 else 0x18)
    icon=lambda e:0x4000+e[1] if e[0]=='look' else 0x3000+(0x17 if e[1]==1 else 0x18)
    for flag,want in ((0,shown),(1,None)):
        pr.model(flag)
        if flag==1:
            # The movie list: the camera's own order (the Customs after its looks).
            m=lists[1];want=[('look',x) for x in m]+[('custom',1),('custom',2)]
        N=len(want)
        for v,e in enumerate(want):
            pr.run(MENU_TEXT,THIS,v);calls+=1
            assert pr.log[-1]==('text',text(e)),(flag,v,e,pr.log)
            pr.entry=v;pr.run(STRIP_NAME,THIS);calls+=1
            assert pr.log[-1]==('text',text(e)),('strip',flag,v,e,pr.log)
            # select (menu and strip): a look in the standard set, or the Custom set.
            for at,args in ((MENU_SELECT,(THIS,v)),(STRIP_SELECT,(THIS,))):
                pr.entry=v;pr.look=0xfe;pr.run(at,*args);calls+=1
                sets=[x for k,x in pr.log if k=='set'];looks=[x for k,x in pr.log if k=='look']
                if e[0]=='custom':assert sets==[e[1]] and not looks,(hex(at),flag,v,e,pr.log)
                else:assert sets==[0] and looks==[e[1]],(hex(at),flag,v,e,pr.log)
            # the current entry: for each set and look in use.
            for set_ in (0,1,2):
                for look in (still[0],still[-1],e[1] if e[0]=='look' else still[P] if P<n else still[0]):
                    pr.set,pr.look=set_,look
                    cur=(e==('custom',set_)) if set_ else (e==('look',look))
                    got=pr.run(MENU_CURRENT,THIS,v);calls+=1
                    assert bool(got)==cur,('menu current',flag,v,e,set_,look,got)
                    got=pr.run(STRIP_CURRENT,THIS,look,v,set_);calls+=1
                    assert bool(got)==cur,('strip current',flag,v,e,set_,look,got)
        # the strip's filling: shown entry v drawn with entry v's icon (the widget holds N + 2 items).
        pr.uc.mem_write(THIS+0x1a9,bytes([N+2]))
        pr.run(STRIP_FILL,THIS);calls+=1
        drawn={w:ic for k,(w,ic) in pr.log if k=='icon'}
        assert all(drawn[v]==icon(e) for v,e in enumerate(want)),(flag,{v:hex(drawn.get(v,0)) for v in range(N)})
        assert all(drawn[v]==0 for v in range(N,N+2)),drawn
    # The menu icon function: a look's icon or a Custom's for every shown entry (still list).
    pr.model(0)
    for v,e in enumerate(shown):
        pr.run(MENU_ICON,THIS,v);calls+=1
        ids=[x for k,x in pr.log if k=='icon']
        # The ADJ lever's list: shown entry v's icon drawn at item v.
        assert ids==[(v,icon(e))],(v,e,pr.log)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=manifest['filmCount'],position=P,entries=len(shown),calls=calls,
        shown=[f'{k}:{x}' for k,x in shown],hardware_tested=False,
        scope='Native list functions of the Image Control menu row and strip; model count/entry native; getters, setters, lookups and widgets substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();r=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in r.items() if k!='shown'},indent=2));print(' '.join(r['shown']))
