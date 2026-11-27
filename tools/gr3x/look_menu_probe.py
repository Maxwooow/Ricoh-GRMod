"""The order's screen in the still menu (core/src/fw/gr3x/look-menu.ts, native/films.c lm_*), executed in the built
image (GR III 2.10 / IIIx 1.60, round 10 with films, liveLayout and lookMenu).

After the native settings load through the scaffold (the films' module, record 15 in a substituted store), natively:
the factory (0x5316f3b8: the line's id gives the End Screen list and sets the looks mode, the End Screen id clears
it), the key map's read (0x53221a4c), the still menu builder's entry (the descriptor of the model: ND or HDF left
out, the line last), the line's draw; the End Screen list's refresh, up / down / OK through its event handler
(0x53204928: 0xd0 / 0xd1 / 0xd8) and left / right (0xd2 / 0xd3, repeats 0xd6 / 0xd7) in the looks mode, and its
refresh in the camera's mode (two rows, its title and footer picture, then its own code). The list widget, its
items, the title and footer views, the line's widgets and the model number are substituted and recorded; the look
names come from the camera's own lookup (with GR Mod's films). A seeded random sequence of key presses is checked
against a Python model of the entries: the screen's rows (names, ticks), the cursor, the Image Control lists
(ImageControlModel's count and entries, natively) right after each change, the record written at power off and
read at the next start. Standard and the Custom entries cannot be hidden, nor a look selected in a set.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import arm_const as reg
from films_probe import fresh_records,RECS,UD,GAP,look_at
from live_layout_probe import LiveProbe,record,lists,C1,C2,HID,COUNT,ITEM,MODEL,WORD

if not __debug__:raise RuntimeError('Validation requires Python assertions')

FACTORY,KEY_READ,BUILDER=0x5316f3b8,0x53221a4c,0x5319a778
REFRESH,ON_EVENT=0x532049fc,0x53204928
MODE=0x55804390;MENU_ID=0x020001a8;END_ID=0x020000ad
LIST_SELECTED,LIST_ITEM,LIST_FOCUS,LIST_MOVE=0x53394820,0x53394758,0x53395430,0x53395260
ITEM_CHECK,ITEM_TEXT,GRAPHIC_VISIBLE,LIST_SHOWN,TITLE_SET=0x5339e738,0x5339e7a0,0x533ad3c0,0x53394e8c,0x533a2ba0
LINE_VALUE_ICON,TOP_SET_TITLE,MODEL_NUMBER,SPEC_MODEL=0x5339de20,0x5339dc70,0x532dbee8,0x5320c09c
MENU_TABLE,STILL_MENU=0x55001eb8,0x53b36dec
CTRL,LISTW,TITLEV,GRAPH,EVENT,LINEW=0x62060000,0x62061000,0x62062000,0x62063000,0x62064000,0x62065000
LISTVT,SETRECT=0x62069000,0x6206a000
OK_CALLBACK,BACK,CB,CELL=0x532048fc,0x5316ca28,0x6206b000,0x6206b100
SEP=0xff
NAME=0x532a985c

class MenuProbe(LiveProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest);self.sel=0;self.rows=0;self.log=[];self.model_number=0
        for a,v in ((CTRL+0x168,LISTW),(CTRL+0x15c,TITLEV),(CTRL+0x164,GRAPH),(LISTW,LISTVT),(LISTVT+0x18,SETRECT)):self.uc.mem_write(a,struct.pack('<I',v))
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        ret=None
        if at==LIST_SELECTED:assert r(0)==LISTW;ret=self.sel
        elif at==LIST_ITEM:assert r(0)==LISTW;ret=0x7000+r(1)
        elif at==LIST_FOCUS:assert r(0)==LISTW;self.sel=r(1);self.log.append(('focus',r(1)));ret=0
        elif at==LIST_MOVE:
            assert r(0)==LISTW and r(2)==1;d=r(1)-(1<<32) if r(1)>>31 else r(1)
            self.sel=(self.sel+d)%self.rows;self.log.append(('move',d));ret=0
        elif at==ITEM_CHECK:self.log.append(('check',r(0)-0x7000,r(1)));ret=0
        elif at==ITEM_TEXT:self.log.append(('text',r(0)-0x7000,r(1)));ret=0
        elif at==GRAPHIC_VISIBLE:assert r(0)==GRAPH;self.log.append(('graphic',r(1)));ret=0
        elif at==LIST_SHOWN:assert r(0)==LISTW;self.log.append(('shown',r(1)));ret=0
        elif at==TITLE_SET:assert r(0)==TITLEV;self.log.append(('title',r(1)));ret=0
        elif at==LINE_VALUE_ICON:assert r(0)==LINEW;self.log.append(('value',r(1)));ret=0
        elif at==TOP_SET_TITLE:assert r(0)==LINEW;self.log.append(('line',r(1),r(2)));ret=0
        elif at==SETRECT:assert r(0)==LISTW;self.log.append(('rect',struct.unpack('<4i',self.uc.mem_read(r(1),16))));ret=0
        elif at==BACK:self.log.append(('back',));ret=1
        elif at==MODEL_NUMBER:ret=self.model_number
        elif at==SPEC_MODEL:ret=0x62066000
        if ret is not None:self._ret(cpu,ret)
        else:super()._hook(cpu,at,size,user)
    def mode(self):return struct.unpack('<I',self.uc.mem_read(MODE,4))[0]
    def ok(self):
        # OK: the keys of 0x04000023 post the event 0xd8 alone (no 0xa2, back to the parent menu).
        self.event(0xd8);assert ('back',) not in self.log,self.log
    def event(self,code):
        self.uc.mem_write(EVENT,struct.pack('<H',code));self.log=[]
        assert self.call(ON_EVENT,CTRL,EVENT)==0
    def run_to(self,at,stop,regs):
        c=self.uc
        for i in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs.get(i,0x4440+i))
        c.reg_write(reg.UC_ARM_REG_SP,0x610ff000);c.reg_write(reg.UC_ARM_REG_LR,0x620ff000);c.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        c.emu_start(at,stop,count=200000);assert c.reg_read(reg.UC_ARM_REG_PC)==stop,hex(c.reg_read(reg.UC_ARM_REG_PC))

def name(n,x):
    x&=0x7f;return n.call(NAME,0x62049000,0x17 if x==C1 else 0x18 if x==C2 else x)

def verify(data,manifest,seed=1128,steps=1500):
    assert manifest.get('lookMenu') and manifest.get('liveLayout')
    f=manifest['lookEntries']['films'];default=list(f['liveEntries']);films=manifest['filmCount'];text=f['lookMenuLine']
    n=MenuProbe(data,manifest);n.manifest=manifest;rng=random.Random(seed);cpu=n.uc;calls=0;rep={}
    N=len(default);n.rows=N
    assert f['lookMenuRows']==N+1
    # --- Factory, key map, builder, the line.
    for idv,mode_after,to in ((MENU_ID,1,END_ID),(END_ID,0,END_ID),(0x02000050,None,0x02000050)):
        before=0x77;cpu.mem_write(MODE,struct.pack('<I',before))
        n.run_to(FACTORY,FACTORY+4,{1:idv})
        assert cpu.reg_read(reg.UC_ARM_REG_R1)==to and cpu.reg_read(reg.UC_ARM_REG_R3)==0x13b,(hex(idv),hex(cpu.reg_read(reg.UC_ARM_REG_R1)))
        assert n.mode()==(before if mode_after is None else mode_after),(hex(idv),n.mode())
        calls+=1
    # The keys: OK (14, 50) those of 0x04000023 (confirm alone), every other key the End Screen list's (r5: the key).
    for idv,key,to in ((MENU_ID,14,0x04000023),(MENU_ID,50,0x04000023),(MENU_ID,11,END_ID),(MENU_ID,1,END_ID),(MENU_ID,10,END_ID),
                       (END_ID,14,END_ID),(0x02000077,14,0x02000077)):
        cpu.mem_write(0x62067000,struct.pack('<I',idv))
        n.run_to(f['lookMenuKeys'],0x620ff000,{0:0x62067000,5:key,14:0x620ff000})
        assert cpu.reg_read(reg.UC_ARM_REG_R0)==to,(hex(idv),key,hex(cpu.reg_read(reg.UC_ARM_REG_R0)));calls+=1
    # ActionModel::OnEvent's switch: 0x04000023 (the line's OK) reaches 0x53214138, the End Screen list's id 0x532157f8.
    from unicorn import UC_HOOK_CODE
    seen={}
    def first_handler(u,a,sz,ud):
        w=struct.unpack('<I',u.mem_read(a,4))[0]
        if (w>>24)==0xeb and 0x53221a50<=a<0x53223200:
            imm=w&0xffffff;imm=imm-(1<<24) if imm&0x800000 else imm;t=(a+8+imm*4)&0xffffffff
            if 0x5320c000<=t<0x53221a00 and 't' not in seen:seen['t']=t;u.emu_stop()
    h=cpu.hook_add(UC_HOOK_CODE,first_handler,begin=0x53221a50,end=0x53223200)
    for idv,want in ((0x04000023,0x53214138),(END_ID,0x532157f8)):
        seen.clear();n.run_to_any=None
        c=cpu
        for i in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        c.reg_write(reg.UC_ARM_REG_R0,idv);c.reg_write(reg.UC_ARM_REG_SP,0x610ff000)
        c.emu_start(0x53221a50,0x53223200,count=600);assert seen.get('t')==want,(hex(idv),seen)
        calls+=1
    cpu.hook_del(h)
    still=bytes(cpu.mem_read(STILL_MENU,0x384))
    for model,drop in ((0,25),(1,13)):
        n.model_number=model;n.run_to(BUILDER,BUILDER+4,{})
        d=struct.unpack('<I',cpu.mem_read(MENU_TABLE,4))[0];assert d==(f['lookMenuWithoutHdf'] if model==0 else f['lookMenuWithoutNd'])
        desc=bytes(cpu.mem_read(d,0x384))
        ids=[struct.unpack_from('<I',desc,0x1bc+4*i)[0] for i in range(38)]
        want=[struct.unpack_from('<I',still,0x1bc+4*i)[0] for i in range(38) if i!=drop]+[MENU_ID]
        assert ids==want,(model,[hex(x) for x in ids])
        assert struct.unpack_from('<I',desc,0x8c+8*37)[0]==text and desc[0x8b]==38;calls+=1
    n.log=[];n.call(text,0x62068000,LINEW);assert n.log==[('value',0),('line',f['lookMenuText'],f['lookMenuText'])],n.log;calls+=1
    # --- Start (no record 15: the build's entries), the screen opens.
    def boot(store):
        n.store=dict(store);recs=fresh_records(rng,films)
        for r in recs:
            r[0x1c0]=0
            for c in range(6):r[look_at(c)]=11
        n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);assert n.boot()
    boot({})
    cpu.mem_write(MODE,struct.pack('<I',1))
    title,sept,moving=f['lookMenuTexts']
    st={'entries':default[:],'grab':None}
    R=N+1
    def rows():
        e=st['entries'];return [x for x in e if not x&HID]+[SEP]+[x for x in e if x&HID]
    def store_rows(rs):
        out=[];hid=False
        for x in rs:
            if x==SEP:hid=True;continue
            out.append((x&0x7f)|(HID if hid else 0))
        return out
    def rows_ok(log,idx):
        rs=rows();texts={i:t for k,i,t in [x for x in log if x[0]=='text']};checks={i:v for k,i,v in [x for x in log if x[0]=='check']}
        for i in idx:
            want=sept if rs[i]==SEP else name(n,rs[i])
            assert texts[i]==want and checks[i]==(1 if st['grab']==i else 0),(i,rs[i],texts.get(i),want,checks.get(i),st['grab'])
    def lists_ok():
        L,_=lists(st['entries'],films);n.model(0);n.set=0
        assert n.call(COUNT,MODEL)==len(L[0]);assert [n.call(ITEM,MODEL,i) for i in range(len(L[0]))]==L[0]
    def open_screen():
        n.log=[];n.call(REFRESH,CTRL)
        assert n.log[0]==('rect',(0,60,720,360)) and ('shown',R) in n.log and ('title',title) in n.log and ('graphic',0) in n.log and n.log[-1]==('focus',0),n.log[:6]
        rows_ok(n.log,range(R));n.sel=0
    n.rows=R;open_screen();lists_ok();calls+=1
    rec=n.rec();rec[look_at(1)]=64;rec[look_at(4)]=17;cpu.mem_write(RECS[0],bytes(rec))
    in_use=set();[in_use.add(n.rec(i)[look_at(c)]) for i in range(8) for c in range(6)]
    protected=lambda x:(x&0x7f) in (11,C1,C2) or (x&0x7f) in in_use
    counts=dict(cursor=0,take=0,put=0,carried=0,hidden=0,shown=0,refused=0,separator=0,power_cycles=0)
    for step in range(steps):
        op=rng.choice(['up','down','up','down','ok','repeat_up','repeat_down','power'] if step%60 else ['power'])
        i=n.sel;grab=st['grab']
        if op=='ok':
            n.ok()
            if grab is not None:
                st['grab']=None;rows_ok(n.log,[grab]);assert ('title',title) in n.log;counts['put']+=1
            elif rows()[i]==SEP:assert not n.log;counts['separator']+=1
            else:st['grab']=i;rows_ok(n.log,[i]);assert ('title',moving) in n.log;counts['take']+=1
        elif op in ('up','down','repeat_up','repeat_down'):
            d=-1 if 'up' in op else 1
            n.event({'up':0xd0,'down':0xd1,'repeat_up':0xd4,'repeat_down':0xd5}[op])
            if grab is None:
                stop='repeat' in op
                if stop and ((d<0 and i==0) or (d>0 and i==R-1)):assert n.sel==i
                else:assert n.sel==(i+d)%R
                counts['cursor']+=1
            else:
                j=grab+d;rs=rows()
                if not 0<=j<R:assert not [x for x in n.log if x[0] in ('text','check')]
                elif rs[j]==SEP and d>0 and protected(rs[grab]):assert not [x for x in n.log if x[0] in ('text','check')];counts['refused']+=1
                else:
                    if rs[j]==SEP:counts['hidden' if d>0 else 'shown']+=1
                    rs[grab],rs[j]=rs[j],rs[grab];st['entries']=store_rows(rs);st['grab']=j
                    assert n.sel==j;rows_ok(n.log,[grab,j]);counts['carried']+=1
        else:
            n.writes=[];n.power_off();w=[d for k,d in n.writes if k==15]
            if w:assert w[-1]==record(st['entries']),'record 15'
            store=dict(n.store);recs=[n.rec(k) for k in range(8)]
            n.store=store;n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);assert n.boot()
            cpu.mem_write(MODE,struct.pack('<I',1));st['grab']=None;open_screen()
            counts['power_cycles']+=1
        lists_ok();calls+=2
    # Standard taken down to the separator: it does not cross it (nor does a look in use, nor a Custom entry).
    for keep in (11,C1,next(iter(x for x in in_use if x!=11 and x in [e&0x7f for e in st['entries']]))):
        if st['grab'] is not None:n.ok();st['grab']=None
        rs=rows();x=next(v for v in rs if v!=SEP and (v&0x7f)==keep)
        if x&HID:continue
        n.sel=rs.index(x);n.ok();st['grab']=n.sel
        while rows()[st['grab']+1]!=SEP:
            g=st['grab'];n.event(0xd1);rs2=rows();rs2[g],rs2[g+1]=rs2[g+1],rs2[g];st['entries']=store_rows(rs2);st['grab']=g+1
        n.event(0xd1);assert not [z for z in n.log if z[0] in ('text','check')] and rows()[st['grab']]==x,(keep,n.log)
        counts['refused']+=1;n.ok();st['grab']=None;lists_ok()
    assert all(v>0 for v in counts.values()),counts
    rep['random']=dict(seed=seed,steps=steps,**counts)
    # --- The camera's own mode: two rows, its title (665) and footer picture, then its own refresh.
    cpu.mem_write(MODE,bytes(4));n.log=[]
    n.run_to(REFRESH,REFRESH+4,{0:CTRL})
    assert n.log==[('rect',(0,300,720,120)),('shown',2),('title',665),('graphic',1)],n.log
    calls+=1
    rep['camera_mode']=True
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,entries=N,calls=calls,**rep,hardware_tested=False,
        scope='Native factory, key map read, still menu builder, the line, the End Screen list handlers (refresh, event handler) and the lists; widgets, model number, store and allocator substituted. Not the screen drawn.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();r=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as fh:json.dump(r,fh,indent=2);fh.write('\n')
    print(json.dumps(r,indent=2))
