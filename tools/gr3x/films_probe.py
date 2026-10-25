"""Round 10: the films' own parameters (tools/gr3x/native/films.c, core/src/fw/gr3x/films-r10.ts),
executed through the camera's own code in the built image:

  - the start-up zero fill (natively: it now ends at 0x558043c0), then the settings load through the
    settings scaffold (the guard, the films' module, the camera's load substituted), the settings
    save likewise (the camera's save substituted, the store and allocator substituted);
  - the six "look of set" setters natively (photo 0x5327b394.., movie 0x5327b54c..; their record push
    0x532750f8 recorded, not run): before they run the module swaps the owners' values in Bleach
    Bypass's fields (photo: the record in use; movie: all eight records), and nothing else is written;
  - a seeded random sequence of look changes, parameter edits (photo: the record in use; movie: all
    eight records, as the camera's setters), Halation changes (sp_hal_put / sp_col_put, GR IV's
    Toning states; for a film that owns the set the camera's Toning setter, substituted here, else
    the table), mode recalls (natively, 0x53279fec..0x5327a008) and power cycles, against a Python
    model in which every look (Bleach Bypass and each film) has its own values in every set;
  - the record written at power off (layout, checksum, every owner's values);
  - taking over rounds 6..9's tables (versions 3, 2, 1): the films' values, their Halation as Toning
    states, Standard's own values back in Standard's fields, the film's in Bleach Bypass's; a
    film whose preset changed starts neutral; a film this build does not have, or a hidden one in a
    standard set, gives its set back to Bleach Bypass's values (the guard then gives it Standard);
    damaged records are not used; no memory: the module stays out of the way;
  - RAW development (sp_raw_init / sp_raw_own / sp_raw_sync) on a substituted model: Bleach Bypass's
    row of each base belongs to one owner, the others' values wait.
This does not establish flash persistence or the camera's menus.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import UC_HOOK_MEM_WRITE
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

STYLE_SETTERS=(0x5327b394,0x5327b3b4,0x5327b3d4,0x5327b54c,0x5327b584,0x5327b5bc)
PUSH,LOAD_DATA,SAVE_DATA=0x532750f8,0x5324b284,0x5323f274
SINGLETON,WRITE,READ,SIZE,ALLOC=0x53828014,0x53829a08,0x53829fcc,0x53829e50,0x536af2a8
TONING_SETTERS={0x5325d3cc:0,0x5325f90c:1,0x53261eac:2}
FILL_LOAD,FILL_END,GAP,FILL_TO=0x530003ac,0x530003c8,0x55804374,0x558043c0
RECALL_FROM,RECALL_TO=0x53279fec,0x5327a008
UD=0x55063f30
REGION=0x63000000;RECS=[REGION+0x1000*(1+i) for i in range(8)];FACTORY=REGION+0xa000;HT=REGION+0xa100;HEAPAREA=REGION+0x40000;MODEL=REGION+0x60000
BLEACH,FIRST=18,64
FIELD=[[0x1ce,0x2b0,0x392,0x58a,0x63c,0x6ee],[0x1da,0x2bc,0x39e,0x594,0x646,0x6f8],[0x1ee,0x2d0,0x3b2,0x5a4,0x656,0x708],
       [0x200,0x2e2,0x3c4,0x5b4,0x666,0x718],[0x212,0x2f4,0x3d6,0x5c4,0x676,0x728],[0x224,0x306,0x3e8,0x5d4,0x686,0x738],
       [0x236,0x318,0x3fa,0x5e4,0x696,0x748],[0x242,0x324,0x406,0x5ee,0x6a0,0x752],[0x286,0x368,0x44a,0x62e,0x6e0,0x792],
       [0x296,0x378,0x45a,0,0,0]]
STD_FIELD=[[0x1c8,0x2aa,0x38c],[0x1d4,0x2b6,0x398],[0x1e0,0x2c2,0x3a4],[0x1f2,0x2d4,0x3b6],[0x204,0x2e6,0x3c8],[0x216,0x2f8,0x3da],
           [0x228,0x30a,0x3ec],[0x278,0x35a,0x43c],[0x28a,0x36c,0x44e]]
OLD_TO_NEW=[0,1,2,3,4,5,6,8,9]
NEUTRAL=[4,4,4,4,4,4,4,0,4,4]
OWNERS,COMBOS,NP=21,6,10
TBYTES=OWNERS*COMBOS*NP
REC_WORDS=3+OWNERS+(TBYTES+3)//4+1
RAW_POS=[0,1,2,3,4,5,6,8,13,14]
# GR IV's Toning states (aspect/halation-ui.ts HALATION_STATES): (on, strength 0..2, white).
STATES=[(0,0,0),(1,0,0),(1,2,0),(1,1,0),(1,0,1),(1,1,1),(1,2,1),(0,1,0),(0,2,0),(0,0,1),(0,1,1),(0,2,1)]

def look_at(c):return 0x1c2+2*c if c<3 else 0x57e+2*(c-3)
def checksum(words):
    total=0x6a09e667
    for i,w in enumerate(words):total=(((total^w)*0x01000193)+i)&0xffffffff
    return total
def decode(state):
    on,s,w=STATES[state] if state<=11 else (0,0,0)
    return (s+1 if on else 0),w
def encode(strength,white,was):
    was=was if was<=11 else 0
    remembered=STATES[was][1]
    if strength==0:return STATES.index((0,remembered,white))
    return STATES.index((1,strength-1,white))

class FilmsProbe(AdjProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest)
        f=manifest['lookEntries']['films'];self.sym=f['moduleSymbols'];self.n=manifest['filmCount']
        e=manifest['entries'];self.load_native=e['settingsLoadNative'];self.save_native=e['settingsSaveNative']
        try:self.uc.mem_map(0x55800000,0x100000)
        except Exception:pass
        self.uc.mem_map(REGION,0x100000)
        self.store={};self.writes=[];self.pushes=[];self.allocs=[];self.alloc_ok=True;self.singleton_ok=True
        self.loads=self.saves=0;self.next_heap=HEAPAREA;self.toning=[];self.filling=False
        self.rec_writes=[];self.fail_keys=set();self.failed=[]
        for r in RECS:self.uc.hook_add(UC_HOOK_MEM_WRITE,self._record_write,begin=r,end=r+0xb28)
    def _record_write(self,cpu,access,at,size,value,user):
        if not self.filling:self.rec_writes.append((at,size))
    def _ret(self,cpu,value):
        cpu.reg_write(reg.UC_ARM_REG_R0,value);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at==PUSH:
            self.pushes.append(bytes(cpu.mem_read(RECS[0],0xb28)));self._ret(cpu,0)
        elif at==SINGLETON:self._ret(cpu,FACTORY if self.singleton_ok else 0)
        elif at in (WRITE,READ,SIZE):
            assert r(0)==HT and r(1) in (12,13),(hex(at),hex(r(0)),r(1))
            key=r(1)
            if at==SIZE:self._ret(cpu,len(self.store.get(key,b'')))
            elif at==READ:
                data=self.store.get(key)
                if data is None:self._ret(cpu,0)
                else:n=min(r(2),len(data));cpu.mem_write(r(3),data[:n]);self._ret(cpu,1)
            else:
                if key in self.fail_keys:self.failed.append(key);self._ret(cpu,0);return
                data=bytes(cpu.mem_read(r(3),r(2)));self.writes.append((key,data));self.store[key]=data;self._ret(cpu,1)
        elif at==ALLOC:
            n=r(0);self.allocs.append(n)
            if not self.alloc_ok:self._ret(cpu,0)
            else:a=self.next_heap;self.next_heap+=(n+15)&~15;cpu.mem_write(a,b'\xa5'*n);self._ret(cpu,a)
        elif at==self.load_native:
            assert r(0)==UD;self.loads+=1;self._ret(cpu,0x77)
        elif at==self.save_native:
            assert r(0)==UD;self.saves+=1;self._ret(cpu,0x5a)
        elif at in TONING_SETTERS:
            # The camera's Toning setter of Bleach Bypass (photo set): the field of the record in use.
            assert r(0)==UD
            s=TONING_SETTERS[at];self.toning.append((s,r(1)));cpu.mem_write(RECS[0]+FIELD[7][s],bytes([r(1)&0xff]));self._ret(cpu,1)
        else:super()._hook(cpu,at,size,user)
    def put(self,a,v):self.uc.mem_write(a,struct.pack('<I',v))
    def u32(self,a):return struct.unpack('<I',self.uc.mem_read(a,4))[0]
    def records(self,recs):
        for r,b in zip(RECS,recs):self.uc.mem_write(r,bytes(b))
        for i,r in enumerate(RECS):self.put(UD+4+4*i,r)
    def boot(self):
        """The start-up zero fill (natively), then the settings load through the scaffold."""
        cpu=self.uc;cpu.mem_write(GAP-0x40,b'\xa5'*0xa0);self.next_heap=HEAPAREA
        cpu.reg_write(reg.UC_ARM_REG_R1,GAP-0x40);self.filling=True
        cpu.emu_start(FILL_LOAD,FILL_END,count=2000);self.filling=False
        assert bytes(cpu.mem_read(GAP-0x40,0x40+FILL_TO-GAP))==bytes(0x40+FILL_TO-GAP) and bytes(cpu.mem_read(FILL_TO,4))==b'\xa5'*4
        self.put(FACTORY+0x14,HT)
        self.run(LOAD_DATA,{0:UD})
        assert cpu.reg_read(reg.UC_ARM_REG_R0)==0x77
        return self.u32(GAP)
    def power_off(self):
        self.run(SAVE_DATA,{0:UD});assert self.uc.reg_read(reg.UC_ARM_REG_R0)==0x5a
    def run(self,at,regs,stop=STOP):
        cpu=self.uc
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs.get(i,0x1230+i))
        cpu.reg_write(reg.UC_ARM_REG_SP,STACK);cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(at,stop,count=400000)
        assert cpu.reg_read(reg.UC_ARM_REG_PC)==stop and cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
    def select(self,c,look):
        self.rec_writes=[];self.pushes=[]
        assert self.call(STYLE_SETTERS[c],UD,look)==1
        assert len(self.pushes)==1
        recs=[RECS[0]] if c<3 else RECS
        allowed={(r+FIELD[j][c],1) for r in recs for j in range(NP) if FIELD[j][c]}|{(r+look_at(c),1) for r in recs}
        assert all(w in allowed for w in self.rec_writes),[(hex(a),s) for a,s in self.rec_writes if (a,s) not in allowed]
    def rec(self,i=0):return bytearray(self.uc.mem_read(RECS[i],0xb28))
    def fields(self,c,i=0):r=self.rec(i);return [r[FIELD[j][c]] for j in range(NP) if FIELD[j][c]]
    def fn(self,name,*args):return self.call(self.sym[name],*args)

def fresh_records(rng,films):
    out=[]
    for i in range(8):
        rec=bytearray(rng.randrange(256) for _ in range(0xb28))
        for c in range(6):
            rec[look_at(c)]=rng.choice([11,12,18,22]+([64] if films else []))
            for j in range(NP):
                if FIELD[j][c]:rec[FIELD[j][c]]=rng.randrange(9) if j!=7 else rng.choice([1,2,3])
        for c in range(3):
            for j in range(9):rec[STD_FIELD[j][c]]=rng.randrange(9)
        rec[0x44]=0;rec[0x1c0]=0;rec[0x57c]=0
        out.append(rec)
    # The movie sets' looks and fields are the same in all eight records (the camera's movie setters).
    for rec in out[1:]:
        for c in range(3,6):
            rec[look_at(c)]=out[0][look_at(c)]
            for j in range(NP):
                if FIELD[j][c]:rec[FIELD[j][c]]=out[0][FIELD[j][c]]
    return out

def table_of(record):
    words=struct.unpack('<%dI'%REC_WORDS,record)
    assert words[:3]==(0x41335247,10,TBYTES) and words[-1]==checksum(list(words[:-1]))
    t=record[(3+OWNERS)*4:(3+OWNERS)*4+TBYTES]
    return [[list(t[(o*COMBOS+c)*NP:(o*COMBOS+c)*NP+NP]) for c in range(COMBOS)] for o in range(OWNERS)],list(words[3:3+OWNERS])

def make_record(values,prints):
    t=bytes(values[o][c][j] for o in range(OWNERS) for c in range(COMBOS) for j in range(NP))
    t+=bytes((-len(t))%4)
    words=[0x41335247,10,TBYTES]+list(prints)+list(struct.unpack('<%dI'%(len(t)//4),t))
    return struct.pack('<%dI'%REC_WORDS,*words,checksum(words))

def old_record(version,values,halation,prints=None):
    """Rounds 6..9 (slots*.c): values[owner][set][j] (Standard 0), halation[film][set]."""
    if version==1:
        t=bytes(values[o][s][j] for o in range(10) for s in range(3) for j in range(9));t+=bytes((-len(t))%4)
        words=[0x33505247,1,270]+list(struct.unpack('<%dI'%(len(t)//4),t))
        return struct.pack('<%dI'%(len(words)+1),*words,checksum(words))
    t=bytes(values[o][s][j] for o in range(21) for s in range(3) for j in range(9))+bytes(halation[k][s] for k in range(20) for s in range(3))
    t+=bytes((-len(t))%4)
    words=[0x33505247,version,627]+(list(prints) if version==3 else [])+list(struct.unpack('<%dI'%(len(t)//4),t))
    return struct.pack('<%dI'%(len(words)+1),*words,checksum(words))

def verify(data,manifest,seed=1110,steps=3000):
    assert manifest.get('round10') and manifest.get('filmCount')
    n=FilmsProbe(data,manifest);rng=random.Random(seed+n.n);cpu=n.uc;calls=0;films=n.n
    f=manifest['lookEntries']['films']
    prints=list(struct.unpack('<%dI'%films,cpu.mem_read(f['prints'],4*films)))
    mask=struct.unpack('<I',cpu.mem_read(f['prints']+4*films,4))[0]
    hidden=set((manifest.get('lookLayout') or {}).get('hidden',[]))
    assert all(prints) and mask==sum(1<<(l-FIRST) for l in hidden if FIRST<=l<FIRST+films)
    film_looks=list(range(FIRST,FIRST+films))
    looks=[l for l in [11,12,13,15,16,17,18,19,21,22]+film_looks if l not in hidden]
    owner_of=lambda look:0 if look==BLEACH else look-FIRST+1 if FIRST<=look<FIRST+films else None
    sites={s['address'] for s in manifest['sites']}
    assert set(STYLE_SETTERS)<=sites and LOAD_DATA in sites and SAVE_DATA in sites
    # 1. First start without a record: Bleach Bypass keeps its values, the films start neutral (also
    # where one is selected). Every set's look is one of the camera's or a visible film here.
    recs=fresh_records(rng,films)
    for c in range(6):
        if recs[0][look_at(c)] in hidden:recs[0][look_at(c)]=12
    recs[0][look_at(1)]=FIRST+films-1 if FIRST+films-1 not in hidden else 11
    for r in recs[1:]:
        for c in range(3,6):r[look_at(c)]=recs[0][look_at(c)]
    n.records(recs);state=n.boot();calls+=1
    assert state and n.loads==1 and n.allocs and not n.writes
    model=[[[recs[0][FIELD[j][c]] if FIELD[j][c] else 0 for j in range(NP)] for c in range(6)] if o==0 else
           [[NEUTRAL[j] if FIELD[j][c] else 0 for j in range(NP)] for c in range(6)] for o in range(OWNERS)]
    selected=[n.rec()[look_at(c)] for c in range(6)]
    owners=lambda:[(owner_of(l) if owner_of(l) is not None else 0) for l in selected]
    vals=lambda o,c:[model[o][c][j] for j in range(NP) if FIELD[j][c]]
    for c in range(6):assert n.fields(c)==vals(owners()[c],c),(c,n.fields(c))
    counts=dict(selects=0,swaps=0,edits=0,halation=0,recalls=0,power_cycles=0,writes=0)
    stored=[n.rec(i) for i in range(8)]
    for step in range(steps):
        op=rng.random()
        if op<0.35:
            c=rng.randrange(6);look=rng.choice(looks);before=owners()[c]
            n.select(c,look);calls+=1;selected[c]=look;counts['selects']+=1
            counts['swaps']+=owners()[c]!=before
        elif op<0.65:
            # A setter writes a value byte of the set's owner (movie sets: in every record).
            c=rng.randrange(6);j=rng.choice([j for j in range(NP) if FIELD[j][c]]);v=rng.randrange(9) if j!=7 else rng.randrange(12)
            for i in (range(8) if c>=3 else [0]):cpu.mem_write(RECS[i]+FIELD[j][c],bytes([v]))
            model[owners()[c]][c][j]=v;counts['edits']+=1
        elif op<0.8:
            # The Halation and Colour lines (a stray look / set / value too).
            look=rng.choice(film_looks+[18,11,FIRST+films,255]);s=rng.choice([0,1,2,3]);what=rng.random()<0.5;v=rng.choice([0,1,2,3,4])
            n.toning=[]
            n.fn('sp_hal_put' if what else 'sp_col_put',look,s,v);calls+=1
            o=owner_of(look)
            if o and o>0 and s<3 and v<=(3 if what else 1):
                was=model[o][s][7];st,w=decode(was)
                want=encode(v,w,was) if what else encode(st,v,was)
                if want!=(was if was<=11 else -1):
                    model[o][s][7]=want;counts['halation']+=1
                    assert n.toning==([(s,want)] if owners()[s]==o else []),(n.toning,owners()[s],o)
                else:assert not n.toning
            else:assert not n.toning
            # Read back: the strength, the colour and the line's text.
            for look in film_looks[:3]+[18,FIRST+films]:
                for s in range(4):
                    o=owner_of(look);st,w=decode(model[o][s][7]) if o and o>0 and s<3 else (0,0)
                    assert n.fn('sp_hal',look,s)==st and n.fn('sp_col',look,s)==w,(look,s)
                    buf=REGION+0x9000;cpu.mem_write(buf,b'\xa5'*4);n.fn('sp_hal_text',look,s,buf)
                    assert bytes(cpu.mem_read(buf,4))==[b'--\0',b'1\0\0',b'2\0\0',b'3\0\0'][st]+b'\xa5';calls+=3
        elif op<0.9:
            # A mode recall: the owners' values to the table, the stored record into use (the guard after).
            mode=rng.randrange(7);src=bytes(n.rec(1+mode))
            n.run(RECALL_FROM,{5:UD,6:mode},stop=RECALL_TO);calls+=1;counts['recalls']+=1
            new=n.rec()
            for c in range(6):
                selected[c]=new[look_at(c)]
                o=owners()[c]
                for j in range(NP):
                    if FIELD[j][c]:model[o][c][j]=new[FIELD[j][c]]
        else:
            before=len(n.writes);n.power_off();calls+=1
            if any(k==12 for k,_ in n.writes[before:]):
                counts['writes']+=1;rec=[d for k,d in n.writes if k==12][-1]
                table,fps=table_of(rec)
                assert fps[1:1+films]==prints
                for c in range(6):
                    for o in range(films+1):
                        if o!=owners()[c]:assert [table[o][c][j] for j in range(NP) if FIELD[j][c]]==vals(o,c),(o,c)
            kept=[bytes(n.rec(i)) for i in range(8)]
            assert n.boot();calls+=1;assert [bytes(n.rec(i)) for i in range(8)]==kept;counts['power_cycles']+=1
        for c in range(6):
            assert n.fields(c)==vals(owners()[c],c),(step,c,n.fields(c),vals(owners()[c],c))
            if c>=3:
                for i in range(1,8):assert n.fields(c,i)==n.fields(c),(step,c,i)
        assert [n.rec()[look_at(c)] for c in range(6)]==selected
    # Every owner, read back by selecting it, has its own values.
    for c in range(6):
        for look in [18]+film_looks:
            n.select(c,look);selected[c]=look;calls+=1
            assert n.fields(c)==vals(owner_of(look),c),(c,look)
    rep=dict(counts)
    # 2. RAW development: Bleach Bypass's row (RAW look 9) of each base belongs to one owner.
    m=MODEL;cpu.mem_write(m,bytes(0x400))
    row=lambda b:m+0x86+b*0xdd+9*0x11
    for b in range(3):cpu.mem_write(row(b),bytes(n.fields(b)[:7]+[0x55]+[n.fields(b)[7]]+[0x66]*4+n.fields(b)[8:10]+[0x77,0x77]))
    n.fn('sp_raw_init',m);calls+=1
    rowvals=lambda b:list(cpu.mem_read(row(b),0x11))
    for b in range(3):
        for look in [9]+[13+k for k in range(films)]+[9]:
            cpu.mem_write(m+0x83+b,bytes([look]));n.fn('sp_raw_sync',m);calls+=1
            o=0 if look==9 else look-13+1
            assert [rowvals(b)[p] for p in RAW_POS]==[model[o][b][j] for j in range(NP)],(b,look)
        cpu.mem_write(m+0x83+b,b'\x09');n.fn('sp_raw_sync',m)
        n.fn('sp_raw_own',m,b,13);calls+=1
        assert [rowvals(b)[p] for p in RAW_POS]==[model[1][b][j] for j in range(NP)]
        n.fn('sp_raw_own',m,b,9)
    rep['raw_development']=True
    # 3. A stored record is used (the fields stay the record's); a preset changed: neutral.
    good=n.store[12];table,fps=table_of(good)
    recs=fresh_records(rng,films)
    for c in range(6):recs[0][look_at(c)]=11
    recs[0][look_at(0)]=FIRST
    for r in recs[1:]:
        for c in range(3,6):r[look_at(c)]=11
    n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);n.writes=[];assert n.boot();calls+=1
    assert n.fields(0)==[recs[0][FIELD[j][0]] for j in range(NP)]
    n.select(1,FIRST);assert n.fields(1)==[table[1][1][j] for j in range(NP)];calls+=1
    changed=list(fps);changed[1]^=1;n.store={12:make_record(table,changed)}
    recs=fresh_records(rng,films)
    for c in range(6):recs[0][look_at(c)]=11
    recs[0][look_at(0)]=FIRST;recs[3][look_at(2)]=FIRST
    for r in recs[1:]:
        for c in range(3,6):r[look_at(c)]=11
    n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
    assert n.fields(0)==NEUTRAL and n.fields(2,3)==NEUTRAL and n.fields(1)==[recs[0][FIELD[j][1]] for j in range(NP)]
    n.select(4,FIRST);assert n.fields(4)==[NEUTRAL[j] for j in range(NP) if FIELD[j][4]];calls+=1
    rep['fingerprint_neutral']=True
    # 4. A set on a film this build does not have, or a hidden film in a standard set: its fields
    # go back to Bleach Bypass's (the guard gives the set Standard after).
    away=[l for l in range(FIRST+films,FIRST+20)]+[l for l in hidden if FIRST<=l<FIRST+films]
    if away:
        vals0=[[[rng.randrange(9) for j in range(NP)] for c in range(6)] for o in range(OWNERS)]
        n.store={12:make_record(vals0,[0]+prints+[0]*(20-films))}
        recs=fresh_records(rng,films);look=rng.choice(away)
        for c in range(6):recs[0][look_at(c)]=11
        recs[0][look_at(0)]=look;recs[0][look_at(3)]=look
        for r in recs[1:]:
            for c in range(3,6):r[look_at(c)]=recs[0][look_at(c)]
        film_vals=[recs[0][FIELD[j][0]] for j in range(NP)]
        n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);n.writes=[];assert n.boot();calls+=1
        assert n.rec()[look_at(0)]==11 and n.fields(0)==vals0[0][0] and n.fields(3)==[vals0[0][3][j] for j in range(NP) if FIELD[j][3]],look
        n.power_off();table,_=table_of([d for k,d in n.writes if k==12][-1]);o=look-FIRST+1
        assert table[o][0]==film_vals,(look,table[o][0],film_vals)
        rep['away_film']=look
    # 5. Rounds 6..9's tables are taken over. Version 3: a film whose preset changed starts neutral.
    # A takeover whose new table was not written (the camera saved the converted records, the old
    # table stayed: here both writes of the table fail) is taken over again at the next start without
    # converting the converted sets a second time.
    def halation(h,ver):
        if ver==1:return 0
        if ver==2:h=3 if h==2 else h
        return encode(h&3,(h>>2)&1,0)
    for version in (3,2,1):
        for case in (('plain','changed','twice') if version==3 else ('plain','twice')):
            owners_old=10 if version==1 else 21
            ov=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(owners_old)]
            oh=[[rng.randrange(8) for s in range(3)] for k in range(20)]
            if version==2:oh=[[rng.randrange(3) for s in range(3)] for k in range(20)]
            k=rng.randrange(min(films,9));k2=(k+1)%min(films,9)
            old_prints=prints+[0]*(20-films)
            if case=='changed':old_prints=list(old_prints);old_prints[k2]^=0x5a5a
            n.store={12:old_record(version,ov,oh,old_prints)}
            recs=fresh_records(rng,films)
            for c in range(6):recs[0][look_at(c)]=11
            recs[0][look_at(1)]=FIRST+k;recs[4][look_at(2)]=FIRST+k
            for r in recs[1:]:
                for c in range(3,6):r[look_at(c)]=11
            fieldvals=[recs[0][STD_FIELD[j][1]] for j in range(9)];bleach=[recs[0][FIELD[j][1]] for j in range(NP)]
            stored4=[recs[4][STD_FIELD[j][2]] for j in range(9)]
            n.records(recs);n.writes=[];assert n.boot();calls+=1
            if case=='twice':
                n.fail_keys={12};n.failed=[];n.power_off();calls+=1
                assert n.failed==[12,12] and n.store[12]==old_record(version,ov,oh,old_prints)
                n.fail_keys=set();kept=[bytes(n.rec(i)) for i in range(8)]
                assert n.boot();calls+=1
                assert [bytes(n.rec(i)) for i in range(8)]==kept,'converted records converted again'
            want=[fieldvals[j] for j in range(7)]+[halation(oh[k][1],version)]+fieldvals[7:9]
            # The set's film: its values (from Standard's fields) in Bleach Bypass's; Standard's own back.
            assert n.fields(1)==want,(version,case,n.fields(1),want)
            assert [n.rec()[STD_FIELD[j][1]] for j in range(9)]==ov[0][1]
            assert [n.rec(4)[STD_FIELD[j][2]] for j in range(9)]==ov[0][2]
            assert n.fields(2,4)==[stored4[j] for j in range(7)]+[halation(oh[k][2],version)]+stored4[7:9]
            # The other films: the old table's values, Halation as Toning (neutral when the preset changed).
            n.select(0,FIRST+k2);calls+=1
            other=[ov[k2+1][0][j] for j in range(7)]+[halation(oh[k2][0],version)]+[ov[k2+1][0][7],ov[k2+1][0][8]]
            assert n.fields(0)==(NEUTRAL if case=='changed' else other),(version,case)
            # Bleach Bypass its own (after a second takeover its values in the converted set are not known: neutral).
            n.select(1,BLEACH);calls+=1;assert n.fields(1)==(NEUTRAL if case=='twice' else bleach),(version,case)
            n.select(4,FIRST+k2);assert n.fields(4)==[NEUTRAL[j] for j in range(NP) if FIELD[j][4]];calls+=1
            # The table is written at power off; the next start uses it.
            n.writes=[];n.power_off();calls+=1;assert table_of([d for kk,d in n.writes if kk==12][-1])
            rep['taken_over_v%d_%s'%(version,case)]=True
    # 6. Damaged records are not used; no memory, no store: the module stays out of the way.
    vals0=[[[rng.randrange(9) for j in range(NP)] for c in range(6)] for o in range(OWNERS)]
    good=make_record(vals0,[0]+prints+[0]*(20-films))
    def resign(b):w=list(struct.unpack('<%dI'%REC_WORDS,b));w[-1]=checksum(w[:-1]);return struct.pack('<%dI'%REC_WORDS,*w)
    bad=[good[:-4]+bytes([good[-4]^1])+good[-3:],good[:-4],resign(good[:4]+b'\x09'+good[5:]),resign(good[:(3+OWNERS)*4]+b'\x21'+good[(3+OWNERS)*4+1:])]
    for b in bad:
        n.store={12:b};recs=fresh_records(rng,films)
        for c in range(6):recs[0][look_at(c)]=11
        for r in recs[1:]:
            for c in range(3,6):r[look_at(c)]=11
        n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
        n.select(0,FIRST);calls+=1;assert n.fields(0)==NEUTRAL
    n.alloc_ok=False;n.store={};cpu.mem_write(GAP,b'\xa5'*4);assert n.boot()==0
    before=n.fields(0);n.select(0,FIRST+1);assert n.fields(0)==before;n.writes=[];n.power_off();assert not [w for w in n.writes if w[0]==12]
    assert n.fn('sp_hal',FIRST,0)==0;n.toning=[];n.fn('sp_hal_put',FIRST,0,2);assert not n.toning
    n.alloc_ok=True;calls+=5
    rep['damaged_rejected']=len(bad)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,calls=calls,seed=seed,steps=steps,**rep,
        hardware_tested=False,scope='Native look setters, start-up fill and mode recall; module entry points; load/save, store, allocator and the Toning setter substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();r=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as fp:json.dump(r,fp,indent=2);fp.write('\n')
    print(json.dumps(r,indent=2))
