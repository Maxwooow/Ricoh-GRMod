"""Round 8 (GR IV test 052): the date imprint's Style values' labels as wide as the row allows
(core/src/fw/gr3x/datestamp.ts, ROW_VTABLE), executed in the built image.

Rows of SelectMenuController's own class are made by its constructor (0x5339e51c; only the
allocator, freeing and four singletons substituted), then the date imprint's list draw functions run
with the camera's own list-item code (0x5339e8b0, its icon and text widgets real):

  - the Style list's four values: the value's label (+0xfc) is 100..(row width - 20, at most 680)
    wide, at x 100, y 10, 40 high; drawn the same way through the camera's code alone (the
    reference) it is 100..500;
  - everything else of the row and of its widgets is byte for byte as in the reference;
  - the On/Off and Follow Orientation lists leave the rows byte for byte as the reference;
  - the draw functions keep every callee-saved register and the stack; a row or a label of another
    class (another vtable) is left as it is.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from unicorn import UC_HOOK_CODE
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')
ROW_CTOR,LIST_ITEM=0x5339e51c,0x5339e8b0
ROW_VTABLE,LABEL_VTABLE=0x53c0ada8,0x53c0a378
ALLOC,ALLOC2,FREE,FREE2=0x536af2a8,0x536af31c,0x536af2e4,0x536af358
HEAP,ROWS,SETTINGS=0x63000000,0x62070000,0x62072000

class RowProbe:
    def __init__(s,data,manifest):
        s.p=AdjProbe(data,manifest);c=s.uc=s.p.uc;s.heap=HEAP
        c.mem_map(HEAP,0x1000000)
        for a in (ALLOC,ALLOC2):c.hook_add(UC_HOOK_CODE,s._alloc,begin=a,end=a)
        for a in (FREE,FREE2):c.hook_add(UC_HOOK_CODE,s._free,begin=a,end=a)
        # The settings the widgets read (the record in use: zeros; language 0), through the substituted user-data singleton.
        c.mem_write(SETTINGS,bytes(0xb28));c.mem_write(0x62040004,struct.pack('<I',SETTINGS))
    def _alloc(s,cpu,at,size,user):
        n=cpu.reg_read(reg.UC_ARM_REG_R0);a=s.heap;s.heap+=(n+15)&~15;cpu.mem_write(a,bytes(n))
        cpu.reg_write(reg.UC_ARM_REG_R0,a);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def _free(s,cpu,at,size,user):cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def u32(s,a):return struct.unpack('<I',bytes(s.uc.mem_read(a,4)))[0]
    def call(s,at,*args,stack=b''):
        c=s.uc
        for i in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        for i,v in enumerate(args):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        saved=[0x1110+i for i in range(4,12)]
        for i,v in zip(range(4,12),saved):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        c.mem_write(STACK,stack);c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP)
        c.emu_start(at,STOP,count=5_000_000)
        assert c.reg_read(reg.UC_ARM_REG_PC)==STOP and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        assert [c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(4,12)]==saved
    def row(s,k,width):
        at=ROWS+k*0x400;s.uc.mem_write(at,bytes(0x400))
        s.call(ROW_CTOR,at,20,100,width,stack=struct.pack('<I',60))
        assert s.u32(at)==ROW_VTABLE and struct.unpack('<4i',bytes(s.uc.mem_read(at+0x20,16)))==(20,100,width,60)
        lab=s.u32(at+0xfc);assert s.u32(lab)==LABEL_VTABLE and s.rect(lab)==(100,10,400,40)
        return at
    def rect(s,w,o=0x20):return struct.unpack('<4i',bytes(s.uc.mem_read(w+o,16)))
    def dump(s,row,skip_label=False):
        """The row object and each of its widgets (+0xec..+0x108); the label's rectangles left out on request."""
        out=[bytes(s.uc.mem_read(row,0x300))]
        for o in range(0xec,0x10c,4):
            w=s.u32(row+o)
            if HEAP<=w<HEAP+0x1000000:
                b=bytearray(s.uc.mem_read(w,0x120))
                if skip_label and o==0xfc:
                    for i in list(range(0x20,0x40))+list(range(0x54,0x64)):b[i]=0
                out.append(bytes(b))
        return out

def verify(data,manifest):
    e=manifest['entries'];ids=manifest['dateImprint'];assert manifest.get('round8') and ids.get('orient')
    # Two probes making the same rows (the same allocations): ours draws through the date imprint's
    # functions, the reference through the camera's list-item code alone.
    r,q=RowProbe(data,manifest),RowProbe(data,manifest);calls=0;cases=[]
    styles=((ids['iconShort'],ids['short']),(ids['iconLong'],ids['long']),(ids['iconShortName'],ids['shortName']),(ids['iconLongName'],ids['longName']))
    k=0
    for width in (720,700,680,640,600,400):
        for v,(icon,text) in enumerate(styles):
            a,b=r.row(k,width),q.row(k,width);k+=1;calls+=2
            r.call(e['dateDrawStyle'],0x62056000,a,v);q.call(LIST_ITEM,b,icon,text);calls+=2
            la,lb=r.u32(a+0xfc),q.u32(b+0xfc)
            assert q.rect(lb)==(100,10,400,40),q.rect(lb)
            right=min(width-20,680)
            want=(100,10,right-100,40) if right>500 else (100,10,400,40)
            assert r.rect(la)==want,(width,v,r.rect(la))
            assert r.dump(a,True)==q.dump(b,True),(width,v)
            cases.append((width,v,r.rect(la)[2]))
    # The On/Off and Follow Orientation lists (one draw function): the rows as the camera's own drawing makes them.
    for v,(icon,text) in enumerate(((ids['iconOff'],2),(ids['iconOn'],1))):
        a,b=r.row(k,700),q.row(k,700);k+=1;calls+=2
        r.call(e['dateDrawOnOff'],0x62056000,a,v);q.call(LIST_ITEM,b,icon,text);calls+=2
        assert r.dump(a)==q.dump(b) and r.rect(r.u32(a+0xfc))==(100,10,400,40)
    # A row or a label of another class: left as it is.
    for what in ('row','label'):
        a=r.row(k,700);k+=1;calls+=1
        r.uc.mem_write(a if what=='row' else r.u32(a+0xfc),struct.pack('<I',0x53c0aaa0))
        before=r.dump(a)
        r.call(e['dateWidenLabel'],a);calls+=1
        assert r.dump(a)==before,what
    for bad in (0,0x3ffffffc,0xc0000000,ROWS+2):r.call(e['dateWidenLabel'],bad);calls+=1
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,label_widths=cases,hardware_tested=False,
        scope='The row constructor, the list-item drawing and the label SetRect of the camera natively (allocator, freeing and singletons substituted); the list controller, fonts and screen not executed.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    a=a.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
