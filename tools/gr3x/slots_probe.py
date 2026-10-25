"""Own film parameters (T6d): execute the installed module through the camera's own code.

The three native "look of photo set n" setters run patched; their record push (0x532750f8) is
recorded, not executed. The settings load/save, the record store and the allocator are
substitutes; the extended start-up zero fill runs natively. A seeded random sequence of look
changes, parameter edits and power cycles is checked against a Python model in which every look
has its own values. This does not establish flash persistence or the camera's menus.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import UC_HOOK_MEM_WRITE
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

STYLE_SETTERS=(0x5327b394,0x5327b3b4,0x5327b3d4)
PUSH,LOAD_DATA,LOAD_CALL,SAVE_DATA,SAVE_CALL=0x532750f8,0x5324b284,0x5324b754,0x5323f274,0x5322b0a8
SINGLETON,WRITE,READ,SIZE,ALLOC=0x53828014,0x53829a08,0x53829fcc,0x53829e50,0x536af2a8
FILL_LOAD,FILL_END,GAP,HEAP=0x530003ac,0x530003c8,0x55804374,0x55804380
REGION=0x63000000;UD=REGION;REC=REGION+0x1000;FACTORY=REGION+0x3000;HT=REGION+0x3100;HEAPAREA=REGION+0x10000
FIELDS=(0x1c8,0x1d4,0x1e0,0x1f2,0x204,0x216,0x228,0x278,0x28a);STRIDE=0xe2
LOOKS=list(range(11,23))+list(range(64,73))
REC_WORDS=3+68+1

def field(j,s):return FIELDS[j]+s*STRIDE
def owner_of(look):return 0 if look==11 else look-63 if 64<=look<=72 else None
def checksum(words):
    total=0x6a09e667
    for i,w in enumerate(words):total=(((total^w)*0x01000193)+i)&0xffffffff
    return total

class SlotsProbe(AdjProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest)
        own=manifest['lookEntries']['ownParameters']
        self.own=own
        self.uc.mem_map(0x55800000,0x100000)
        self.uc.mem_map(REGION,0x100000)
        self.store={};self.writes=[];self.pushes=[];self.allocs=[];self.alloc_ok=True;self.singleton_ok=True
        self.loads=self.saves=0;self.next_heap=HEAPAREA;self.allowed=set()
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self._record_write,begin=REC,end=REC+0xb28)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self._gap_write,begin=GAP,end=HEAP+3)
        self.rec_writes=[];self.stored=[]
    def _record_write(self,cpu,access,at,size,value,user):self.rec_writes.append((at-REC,size))
    def _gap_write(self,cpu,access,at,size,value,user):
        assert at==GAP and size==4 or self.filling,(hex(at),size)
    filling=False
    def _ret(self,cpu,value):
        cpu.reg_write(reg.UC_ARM_REG_R0,value);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at==PUSH:
            rec=struct.unpack('<I',cpu.mem_read(r(0)+4,4))[0]
            self.pushes.append(bytes(cpu.mem_read(rec,0xb28)));self._ret(cpu,0)
        elif at==SINGLETON:self._ret(cpu,FACTORY if self.singleton_ok else 0)
        elif at in (WRITE,READ,SIZE):
            assert r(0)==HT and r(1)==12,(hex(at),hex(r(0)),r(1))
            if at==SIZE:self._ret(cpu,len(self.store.get(12,b'')))
            elif at==READ:
                data=self.store.get(12)
                if data is None:self._ret(cpu,0)
                else:
                    n=min(r(2),len(data));cpu.mem_write(r(3),data[:n]);self._ret(cpu,1)
            else:
                data=bytes(cpu.mem_read(r(3),r(2)));self.writes.append(data);self.store[12]=data;self._ret(cpu,1)
        elif at==ALLOC:
            n=r(0);self.allocs.append(n)
            if not self.alloc_ok:self._ret(cpu,0)
            else:
                at_=self.next_heap;self.next_heap+=(n+15)&~15;cpu.mem_write(at_,b'\xa5'*n);self._ret(cpu,at_)
        elif at==LOAD_DATA:
            self.loads+=1;cpu.mem_write(r(0)+4,struct.pack('<I',REC));self._ret(cpu,0)
        elif at==SAVE_DATA:self.saves+=1;self._ret(cpu,0x5a)
        else:super()._hook(cpu,at,size,user)
    def boot(self):
        """Start-up zero fill (natively, from just below the gap), then the settings load."""
        cpu=self.uc;cpu.mem_write(GAP-0x40,b'\xa5'*0x50)
        cpu.reg_write(reg.UC_ARM_REG_R1,GAP-0x40);self.filling=True
        cpu.emu_start(FILL_LOAD,FILL_END,count=1000);self.filling=False
        assert bytes(cpu.mem_read(GAP-0x40,0x4c))==bytes(0x4c) and bytes(cpu.mem_read(HEAP,4))==b'\xa5'*4
        cpu.mem_write(UD,bytes(0x40));put=lambda a,v:cpu.mem_write(a,struct.pack('<I',v))
        for i,at in enumerate(self.stored):put(UD+8+4*i,at)   # round 7: stored records (modes, U1..U3)
        put(FACTORY+0x14,HT)
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        cpu.reg_write(reg.UC_ARM_REG_R0,UD);cpu.reg_write(reg.UC_ARM_REG_R4,UD)
        cpu.reg_write(reg.UC_ARM_REG_SP,STACK);cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(LOAD_CALL,LOAD_CALL+4,count=100000)
        assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK and cpu.reg_read(reg.UC_ARM_REG_R4)==UD
        return struct.unpack('<I',cpu.mem_read(GAP,4))[0]
    def power_off(self):
        cpu=self.uc
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),0)
        cpu.reg_write(reg.UC_ARM_REG_R0,UD);cpu.reg_write(reg.UC_ARM_REG_SP,STACK)
        cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(SAVE_CALL,STOP,count=100000)
        assert cpu.reg_read(reg.UC_ARM_REG_PC)==STOP and cpu.reg_read(reg.UC_ARM_REG_R0)==0x5a
        assert cpu.reg_read(reg.UC_ARM_REG_SP)==STACK
    def select(self,s,look):
        self.rec_writes=[];self.pushes=[]
        assert self.call(STYLE_SETTERS[s],UD,look)==1
        assert len(self.pushes)==1
        allowed={field(j,s) for j in range(9)}|{0x1c2+2*s}
        assert all(off in allowed and size==1 for off,size in self.rec_writes),self.rec_writes
        return self.pushes[0]
    def rec(self):return bytearray(self.uc.mem_read(REC,0xb28))
    def fields(self,s):return [self.rec()[field(j,s)] for j in range(9)]

def record(values):
    """values[owner][set][j] -> the bytes a correct table write holds."""
    t=bytes(values[o][s][j] for o in range(10) for s in range(3) for j in range(9))+bytes(2)
    words=[0x33505247,1,270]+list(struct.unpack('<68I',t))
    return struct.pack('<%dI'%REC_WORDS,*words,checksum(words))

def fresh_record(rng):
    rec=bytearray(rng.randrange(256) for _ in range(0xb28))
    for s in range(3):
        rec[0x1c2+2*s]=11
        for j in range(9):rec[field(j,s)]=4;rec[field(j,s)+1]=0
    return rec

def verify(data,manifest,seed=1105,steps=4000):
    if manifest.get('round7'):return verify_v3(data,manifest)
    if manifest.get('filmCount'):return verify_v2(data,manifest)
    n=SlotsProbe(data,manifest);rng=random.Random(seed);cpu=n.uc;calls=0
    for s,at in enumerate(STYLE_SETTERS):assert any(x['address']==at for x in manifest['sites'])
    # 1. First start without a table: every look starts with the values the fields hold.
    rec=fresh_record(rng)
    for s in range(3):
        for j in range(9):rec[field(j,s)]=rng.randrange(9)
    rec[0x1c2+2]=66  # set 1 has a film selected (its values are in the fields, as T6c shared them)
    cpu.mem_write(REC,bytes(rec));state=n.boot();calls+=1
    assert state and n.loads==1 and n.allocs and not n.writes
    model=[[[rec[field(j,s)] for j in range(9)] for s in range(3)] for _ in range(10)]
    selected=[rec[0x1c2+2*s] for s in range(3)]
    flags=bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))
    owners=lambda:[owner_of(l) if owner_of(l) is not None else 0 for l in selected]
    counts=dict(selects=0,swaps=0,edits=0,power_cycles=0,writes=0)
    for step in range(steps):
        op=rng.random()
        if op<0.45:
            s=rng.randrange(3);look=rng.choice(LOOKS);before=owners()[s]
            n.select(s,look);calls+=1;selected[s]=look;counts['selects']+=1
            if owners()[s]!=before:counts['swaps']+=1
        elif op<0.9:
            # A firmware parameter setter writes the value byte of the selected look's owner.
            s=rng.randrange(3);j=rng.randrange(9);v=rng.randrange(9)
            cpu.mem_write(REC+field(j,s),bytes([v]));model[owners()[s]][s][j]=v;counts['edits']+=1
        else:
            before=len(n.writes);n.power_off();calls+=1
            if len(n.writes)>before:
                counts['writes']+=1
                # The table holds every look's values; the selected owners' live in the fields.
                expected=[[list(model[o][s]) for s in range(3)] for o in range(10)]
                table=n.writes[-1];words=struct.unpack('<%dI'%REC_WORDS,table)
                assert words[:3]==(0x33505247,1,270) and words[-1]==checksum(list(words[:-1]))
                stored=table[12:12+270]
                for s in range(3):
                    for o in range(10):
                        if o!=owners()[s]:assert list(stored[(o*3+s)*9:(o*3+s)*9+9])==expected[o][s],(o,s)
            # Power cycle: RAM is lost, the record keeps what the firmware saved.
            kept=bytes(n.rec());cpu.mem_write(GAP,b'\xa5'*4)
            assert n.boot();calls+=1;assert bytes(n.rec())==kept;counts['power_cycles']+=1
        for s in range(3):assert n.fields(s)==model[owners()[s]][s],(step,s,n.fields(s),model[owners()[s]][s])
        assert bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))==flags
        assert [n.rec()[0x1c2+2*s] for s in range(3)]==selected
    # Every look, read back by selecting it, has its own values.
    for s in range(3):
        for look in [11]+list(range(64,73)):
            n.select(s,look);selected[s]=look;calls+=1
            assert n.fields(s)==model[owner_of(look)][s]
    # 2. A stored table is used; the fields stay the record's.
    good=record(model);n.store={12:good}
    rec=fresh_record(rng);cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);n.writes=[]
    assert n.boot();calls+=1
    n.select(0,64);calls+=1;assert n.fields(0)==model[1][0]
    # 3. Damaged, short, foreign or out-of-range tables are not used (the fields are).
    damaged=[good[:-4]+bytes([good[-4]^1])+good[-3:],good[:-4],b'\0'*len(good),
             good[:12]+bytes([0x21])+good[13:]]
    fixed=bytearray(damaged[3]);w=list(struct.unpack('<%dI'%REC_WORDS,bytes(fixed)));w[-1]=checksum(w[:-1])
    damaged.append(struct.pack('<%dI'%REC_WORDS,*w))
    for bad in damaged:
        n.store={12:bad};rec=fresh_record(rng);rec[0x1c2]=11
        for j in range(9):rec[field(j,0)]=j%9
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4)
        assert n.boot();calls+=1
        n.select(0,70);calls+=1;assert n.fields(0)==[j%9 for j in range(9)]
    # 4. No memory or no store: the module stays out of the way, the firmware works as T6c.
    n.alloc_ok=False;n.store={};cpu.mem_write(REC,bytes(fresh_record(rng)));cpu.mem_write(GAP,b'\xa5'*4)
    assert n.boot()==0;calls+=1
    before=n.fields(0);n.select(0,65);assert n.fields(0)==before;n.writes=[];n.power_off();assert not n.writes;calls+=2
    n.alloc_ok=True;n.singleton_ok=False;cpu.mem_write(GAP,b'\xa5'*4)
    assert n.boot();n.select(0,67);n.select(0,11);n.writes=[];n.power_off();assert not n.writes;calls+=4
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,seed=seed,steps=steps,**counts,
        native_style_setters_executed=True,native_zero_fill_executed=True,record_push_after_swap=True,
        only_standard_value_bytes_and_look_written=True,flag_bytes_untouched=True,
        damaged_tables_rejected=len(damaged),no_memory_and_no_store_fall_back=True,
        module_bytes=len(bytes.fromhex(manifest['append']['bytes'])),hardware_tested=False,
        scope='Patched native look setters, native start-up fill; load/save, record store and allocator substituted. Movie sets and user modes not covered.')

# ------------------------------------------------------------------ round 6 (native/slots2.c)
SETTINGS=0x55063f34
V2_WORDS=3+157+1

def record_v2(values,levels):
    """values[owner][set][j] (21 owners), levels[film][set] (20 films) -> a correct version-2 record."""
    t=bytes(values[o][s][j] for o in range(21) for s in range(3) for j in range(9))+bytes(levels[f][s] for f in range(20) for s in range(3))+bytes(1)
    words=[0x33505247,2,627]+list(struct.unpack('<157I',t))
    return struct.pack('<%dI'%V2_WORDS,*words,checksum(words))

def record_v1(values):
    t=bytes(values[o][s][j] for o in range(10) for s in range(3) for j in range(9))+bytes(2)
    words=[0x33505247,1,270]+list(struct.unpack('<68I',t))
    return struct.pack('<72I',*words,checksum(words))

def verify_v2(data,manifest,seed=1106,steps=5000):
    """Round 6: up to twenty films, their Halation levels per photo set, version-1 take-over and the
    start-up check of looks a build does not have."""
    films=manifest['filmCount'];n=SlotsProbe(data,manifest);rng=random.Random(seed+films);cpu=n.uc;calls=0
    own=manifest['lookEntries']['ownParameters'];fn=lambda name:own['module']+own['exports'][name]
    assert set(own['exports'])=={'sp_style','sp_after_load','sp_after_save','sp_hal','sp_hal_put','sp_hal_text','sp_hal_level','sp_hal_backup','sp_hal_restore'}
    looks=list(range(11,23))+list(range(64,64+films))
    def owner(look):return 0 if look==11 else look-63 if 64<=look<64+films else None
    cpu.mem_write(SETTINGS,struct.pack('<I',REC))
    # 1. First start without a table.
    rec=fresh_record(rng)
    for s in range(3):
        for j in range(9):rec[field(j,s)]=rng.randrange(9)
    rec[0x1c2+2]=64+films-1;rec[0x44]=0;rec[0x1c0]=0
    cpu.mem_write(REC,bytes(rec));assert n.boot();calls+=1
    model=[[[rec[field(j,s)] for j in range(9)] for s in range(3)] for _ in range(21)]
    levels=[[0]*3 for _ in range(20)]
    selected=[rec[0x1c2+2*s] for s in range(3)]
    flags=bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))
    owners=lambda:[owner(l) if owner(l) is not None else 0 for l in selected]
    counts=dict(selects=0,edits=0,levels_set=0,level_reads=0,power_cycles=0,writes=0)
    for step in range(steps):
        op=rng.random()
        if op<0.35:
            s=rng.randrange(3);look=rng.choice(looks);n.select(s,look);calls+=1;selected[s]=look;counts['selects']+=1
        elif op<0.6:
            s=rng.randrange(3);j=rng.randrange(9);v=rng.randrange(9)
            cpu.mem_write(REC+field(j,s),bytes([v]));model[owners()[s]][s][j]=v;counts['edits']+=1
        elif op<0.78:
            # The parameter screen moves a film's Halation slider (or asks with a stray value / look / set).
            look=rng.choice(looks+[63,64+films,83,84,255]);s=rng.choice([0,1,2,2,3,255]);v=rng.choice([0,1,2,2,3,255])
            n.call(fn('sp_hal_put'),look,s,v);calls+=1
            if 64<=look<64+films and s<3 and v<3:levels[look-64][s]=v;counts['levels_set']+=1
        elif op<0.82:
            # The parameter screen opens (backup), the slider moves, then OK (keep) or Cancel (restore).
            n.call(fn('sp_hal_backup'));kept=[list(x) for x in levels];calls+=1
            for _ in range(rng.randrange(4)):
                look=rng.choice(looks);s=rng.randrange(3);v=rng.randrange(3);n.call(fn('sp_hal_put'),look,s,v);calls+=1
                if 64<=look<64+films:levels[look-64][s]=v
            if rng.random()<0.5:n.call(fn('sp_hal_restore'));levels=kept;calls+=1
        elif op<0.95:
            look=rng.choice(looks+[64+films,83,0]);s=rng.randrange(4)
            want=levels[look-64][s] if 64<=look<64+films and s<3 else 0
            assert n.call(fn('sp_hal'),look,s)==want,(look,s)
            buf=REGION+0x8000;cpu.mem_write(buf,b'\xa5'*4);n.call(fn('sp_hal_text'),look,s,buf)
            assert bytes(cpu.mem_read(buf,4))==[b'--\0',b'W\0\0',b'S\0\0'][want]+b'\xa5'
            # The development step: the active photo set, nothing in movie mode.
            act=rng.randrange(3);movie=rng.random()<0.2
            cpu.mem_write(REC+0x1c0,bytes([act]));cpu.mem_write(REC+0x44,bytes([movie]))
            lw=levels[look-64][act] if 64<=look<64+films and not movie else 0
            assert n.call(fn('sp_hal_level'),look)==lw;calls+=3;counts['level_reads']+=1
            cpu.mem_write(REC+0x44,b'\0')
        else:
            before=len(n.writes);n.power_off();calls+=1
            if len(n.writes)>before:
                counts['writes']+=1;table=n.writes[-1];words=struct.unpack('<%dI'%V2_WORDS,table)
                assert words[:3]==(0x33505247,2,627) and words[-1]==checksum(list(words[:-1]))
                stored=table[12:12+627]
                for s in range(3):
                    for o in range(21):
                        if o!=owners()[s]:assert list(stored[(o*3+s)*9:(o*3+s)*9+9])==model[o][s],(o,s)
                assert [list(stored[567+f*3:570+f*3]) for f in range(20)]==levels
            kept=bytes(n.rec());cpu.mem_write(GAP,b'\xa5'*4)
            assert n.boot();calls+=1;assert bytes(n.rec())==kept;counts['power_cycles']+=1
        for s in range(3):assert n.fields(s)==model[owners()[s]][s],(step,s)
        assert bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))==flags
        assert [n.rec()[0x1c2+2*s] for s in range(3)]==selected
    # 2. A version-1 record (nine films) is taken over: owners 0..9 its values, the others the
    # fields' values, Halation off.
    v1=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(10)]
    n.store={12:record_v1(v1)};rec=fresh_record(rng)
    for s in range(3):
        for j in range(9):rec[field(j,s)]=v1[0][s][j]
    cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);n.writes=[];assert n.boot();calls+=1
    for look in [64,72]+([64+films-1] if films>9 else []):
        if look>=64+films:continue
        n.select(0,look);calls+=1
        want=v1[look-63][0] if look<=72 else v1[0][0]
        assert n.fields(0)==want,(look,n.fields(0),want)
        assert n.call(fn('sp_hal'),look,0)==0
    n.select(0,11);n.power_off();assert n.writes and len(n.writes[-1])==V2_WORDS*4;calls+=2
    # 3. A set left on a film this build does not have gets Standard and Standard's values back.
    stale=[]
    if films<20:
        vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
        lv=[[rng.randrange(3) for s in range(3)] for f in range(20)]
        n.store={12:record_v2(vals,lv)};rec=fresh_record(rng);missing=64+films+rng.randrange(20-films)
        rec[0x1c2+2]=missing
        for j in range(9):rec[field(j,1)]=(j*2)%9
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
        assert n.rec()[0x1c2+2]==11 and n.fields(1)==vals[0][1]
        assert n.rec()[0x1c2]==11 and n.rec()[0x1c2+4]==11
        assert n.call(fn('sp_hal'),64,2)==lv[0][2]
        n.writes=[];n.power_off();t=n.writes[-1][12:12+627];o=missing-63
        assert list(t[(o*3+1)*9:(o*3+1)*9+9])==[(j*2)%9 for j in range(9)]   # the missing film keeps the values it had
        stale.append(missing);calls+=2
    # 4. Damaged tables (checksum, length, version, a level of 3, a value above 0x20) are not used.
    vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
    good=record_v2(vals,[[1]*3 for _ in range(20)])
    def resign(b):w=list(struct.unpack('<%dI'%V2_WORDS,b));w[-1]=checksum(w[:-1]);return struct.pack('<%dI'%V2_WORDS,*w)
    bad=[good[:-4]+bytes([good[-4]^1])+good[-3:],good[:-4],resign(good[:4]+b'\3'+good[5:]),
         resign(good[:12+567]+b'\3'+good[12+568:]),resign(good[:12]+b'\x21'+good[13:])]
    for b in bad:
        n.store={12:b};rec=fresh_record(rng)
        for j in range(9):rec[field(j,0)]=j%9
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
        n.select(0,64);calls+=1;assert n.fields(0)==[j%9 for j in range(9)] and n.call(fn('sp_hal'),64,0)==0
    # 5. No memory: everything stays out of the way (levels 0, nothing stored).
    n.alloc_ok=False;n.store={};cpu.mem_write(GAP,b'\xa5'*4);assert n.boot()==0
    n.call(fn('sp_hal_put'),64,0,2);assert n.call(fn('sp_hal'),64,0)==0 and n.call(fn('sp_hal_level'),64)==0
    n.alloc_ok=True;calls+=4
    return dict(schema=2,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,calls=calls,seed=seed,steps=steps,**counts,
        version1_taken_over=True,missing_film_sets_reset=stale,damaged_tables_rejected=len(bad),no_memory_falls_back=True,
        hardware_tested=False,scope='Patched native look setters, native start-up fill; module entry points called directly; load/save, store and allocator substituted.')

# ------------------------------------------------------------------ round 7 (native/slots3.c)
V3_WORDS=3+20+157+1
STORED0=REGION+0x5000;STORED1=REGION+0x7000

def record_v3(values,settings,prints):
    """values[owner][set][j] (21 owners), settings[film][set] (20 films), prints[20] -> a version-3 record."""
    t=bytes(values[o][s][j] for o in range(21) for s in range(3) for j in range(9))+bytes(settings[f][s] for f in range(20) for s in range(3))+bytes(1)
    words=[0x33505247,3,627]+list(prints)+list(struct.unpack('<157I',t))
    return struct.pack('<%dI'%V3_WORDS,*words,checksum(words))

def valid_record(rng):
    """fresh_record with the movie looks and the ratio the settings guard leaves alone."""
    rec=fresh_record(rng)
    for off in (0x57e,0x580,0x582):rec[off]=11
    rec[0x4c2]=0;return rec

def verify_v3(data,manifest,seed=1107,steps=6000):
    """Round 7: Halation strength and colour per film and photo set, preset fingerprints (a film whose
    preset changed starts again from neutral, also in the stored records), version-2 / version-1
    take-over, films this build does not have in the record in use and the stored ones; the settings
    guard runs after the load and before the save (guard_probe.py checks it on its own)."""
    films=manifest['filmCount'];n=SlotsProbe(data,manifest);rng=random.Random(seed+films);cpu=n.uc;calls=0
    own=manifest['lookEntries']['ownParameters'];fn=lambda name:own['module']+own['exports'][name]
    assert set(own['exports'])=={'sp_style','sp_after_load','sp_after_save','sp_hal','sp_hal_put','sp_hal_text','sp_hal_level','sp_hal_backup','sp_hal_restore','sp_col','sp_col_put','sp_before_recall'}
    prints=list(struct.unpack('<%dI'%films,cpu.mem_read(own['prints'],4*films)))
    assert all(prints) and len(set(prints))>=1
    looks=list(range(11,23))+list(range(64,64+films))
    def owner(look):return 0 if look==11 else look-63 if 64<=look<64+films else None
    # Round 8 (slots3.c -DHIDDEN_FILMS): the hidden films' word after the prints. The lists offer the
    # standard photo set (0) no hidden look, and the stored records hold none there (step 8).
    hidden=list((manifest.get('lookLayout') or {}).get('hidden',[]))
    hidden_films=[h for h in hidden if 64<=h<64+films]
    if manifest.get('round8'):
        mask=struct.unpack('<I',cpu.mem_read(own['prints']+4*films,4))[0]
        assert mask==sum(1<<(h-64) for h in hidden_films),hex(mask)
    else:assert not hidden
    looks0=[l for l in looks if l not in hidden]
    cpu.mem_write(SETTINGS,struct.pack('<I',REC))
    def put_ud(stored):
        n.stored=list(stored);cpu.mem_write(UD,struct.pack('<10I',0,REC,*(list(stored)+[0]*(8-len(stored)))))
    put_ud([])
    # 1. First start without a table.
    rec=valid_record(rng)
    for s in range(3):
        for j in range(9):rec[field(j,s)]=rng.randrange(9)
    rec[0x1c2+2]=64+films-1;rec[0x44]=0;rec[0x1c0]=0
    cpu.mem_write(REC,bytes(rec));assert n.boot();calls+=1
    model=[[[rec[field(j,s)] for j in range(9)] for s in range(3)] for _ in range(21)]
    hal=[[0]*3 for _ in range(20)]
    selected=[rec[0x1c2+2*s] for s in range(3)]
    flags=bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))
    owners=lambda:[owner(l) if owner(l) is not None else 0 for l in selected]
    counts=dict(selects=0,edits=0,strength_set=0,colour_set=0,reads=0,power_cycles=0,writes=0)
    TEXT=[b'--\0',b'1\0\0',b'2\0\0',b'3\0\0']
    for step in range(steps):
        op=rng.random()
        if op<0.3:
            s=rng.randrange(3);look=rng.choice(looks0 if s==0 else looks);n.select(s,look);calls+=1;selected[s]=look;counts['selects']+=1
        elif op<0.5:
            s=rng.randrange(3);j=rng.randrange(9);v=rng.randrange(9)
            cpu.mem_write(REC+field(j,s),bytes([v]));model[owners()[s]][s][j]=v;counts['edits']+=1
        elif op<0.64:
            # The Halation row's slider (or a stray value / look / set).
            look=rng.choice(looks+[63,64+films,83,84,255]);s=rng.choice([0,1,2,2,3,255]);v=rng.choice([0,1,2,3,3,4,255])
            n.call(fn('sp_hal_put'),look,s,v);calls+=1
            if 64<=look<64+films and s<3 and v<=3:hal[look-64][s]=(hal[look-64][s]&4)|v;counts['strength_set']+=1
        elif op<0.74:
            # The Colour row's slider.
            look=rng.choice(looks+[63,64+films,84]);s=rng.choice([0,1,2,3]);v=rng.choice([0,1,1,2,255])
            n.call(fn('sp_col_put'),look,s,v);calls+=1
            if 64<=look<64+films and s<3 and v<=1:hal[look-64][s]=(hal[look-64][s]&3)|(4*v);counts['colour_set']+=1
        elif op<0.78:
            # The parameter screen opens (backup), the sliders move, then OK (keep) or Cancel (restore).
            n.call(fn('sp_hal_backup'));kept=[list(x) for x in hal];calls+=1
            for _ in range(rng.randrange(5)):
                look=rng.choice(looks);s=rng.randrange(3)
                if rng.random()<0.5:
                    v=rng.randrange(4);n.call(fn('sp_hal_put'),look,s,v)
                    if 64<=look<64+films:hal[look-64][s]=(hal[look-64][s]&4)|v
                else:
                    v=rng.randrange(2);n.call(fn('sp_col_put'),look,s,v)
                    if 64<=look<64+films:hal[look-64][s]=(hal[look-64][s]&3)|(4*v)
                calls+=1
            if rng.random()<0.5:n.call(fn('sp_hal_restore'));hal=kept;calls+=1
        elif op<0.8:
            # A mode recall: the owners' values go to the table, then a stored record (other looks,
            # other values) is copied over the record in use, as 0x5327a004 does.
            n.call(fn('sp_before_recall'),UD);calls+=1;counts['recalls']=counts.get('recalls',0)+1
            new=bytearray(n.rec())
            for s in range(3):
                look=rng.choice(looks0 if s==0 else looks);new[0x1c2+2*s]=look;selected[s]=look
                vals=[rng.randrange(9) for j in range(9)]
                for j in range(9):new[field(j,s)]=vals[j]
                model[owners()[s]][s]=vals
            cpu.mem_write(REC,bytes(new))
        elif op<0.94:
            look=rng.choice(looks+[64+films,83,0]);s=rng.randrange(4)
            want=hal[look-64][s] if 64<=look<64+films and s<3 else 0
            assert n.call(fn('sp_hal'),look,s)==want&3 and n.call(fn('sp_col'),look,s)==want>>2,(look,s,want)
            buf=REGION+0x8000;cpu.mem_write(buf,b'\xa5'*4);n.call(fn('sp_hal_text'),look,s,buf)
            assert bytes(cpu.mem_read(buf,4))==TEXT[want&3]+b'\xa5'
            # The development step: the active photo set, nothing in movie mode.
            act=rng.randrange(3);movie=rng.random()<0.2
            cpu.mem_write(REC+0x1c0,bytes([act]));cpu.mem_write(REC+0x44,bytes([movie]))
            w=hal[look-64][act] if 64<=look<64+films and not movie else 0
            assert n.call(fn('sp_hal_level'),look)==(w&3)|(0x200 if w&4 else 0);calls+=4;counts['reads']+=1
            cpu.mem_write(REC+0x44,b'\0')
        else:
            before=len(n.writes);n.power_off();calls+=1
            if len(n.writes)>before:
                counts['writes']+=1;table=n.writes[-1];words=struct.unpack('<%dI'%V3_WORDS,table)
                assert words[:3]==(0x33505247,3,627) and words[-1]==checksum(list(words[:-1]))
                assert list(words[3:3+films])==prints
                stored=table[12+80:12+80+627]
                for s in range(3):
                    for o in range(21):
                        if o!=owners()[s]:assert list(stored[(o*3+s)*9:(o*3+s)*9+9])==model[o][s],(o,s)
                assert [list(stored[567+f*3:570+f*3]) for f in range(20)]==hal
            kept=bytes(n.rec());cpu.mem_write(GAP,b'\xa5'*4)
            assert n.boot();calls+=1;assert bytes(n.rec())==kept;counts['power_cycles']+=1
        for s in range(3):assert n.fields(s)==model[owners()[s]][s],(step,s)
        assert bytes(n.rec()[field(j,s)+1] for s in range(3) for j in range(9))==flags
        assert [n.rec()[0x1c2+2*s] for s in range(3)]==selected
    # 2. Fingerprints: film a's preset changed (its saved print differs), film b's did not. Film a
    # starts again from neutral: table, Halation, the fields of its sets in the record in use and
    # in the stored records; film b keeps everything.
    fingerprints={}
    shown=[f for f in range(films) if 64+f not in hidden]
    if len(shown)>=2:
        a,b=rng.sample(shown,2)
        vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
        st=[[rng.randrange(8) for s in range(3)] for f in range(20)]
        fp=list(prints)+[rng.randrange(1,1<<32) for _ in range(20-films)];fp[a]^=0x5a5a
        n.store={12:record_v3(vals,st,fp)};rec=valid_record(rng)
        rec[0x1c2]=64+a;rec[0x1c2+2]=64+b;rec[0x1c2+4]=11
        cur=[[rng.randrange(9) for j in range(9)] for s in range(3)]
        for s in range(3):
            for j in range(9):rec[field(j,s)]=cur[s][j]
        s0=valid_record(rng);s0[0x1c2]=64+a;s0[0x1c2+2]=64+b;s1=valid_record(rng);s1[0x1c2+4]=64+a
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(STORED0,bytes(s0));cpu.mem_write(STORED1,bytes(s1));put_ud([STORED0,STORED1])
        cpu.mem_write(GAP,b'\xa5'*4);n.writes=[];assert n.boot();calls+=1
        assert n.fields(0)==[4]*9 and n.fields(1)==cur[1] and n.fields(2)==cur[2]
        g0=bytes(cpu.mem_read(STORED0,0xb28));g1=bytes(cpu.mem_read(STORED1,0xb28))
        assert [g0[field(j,0)] for j in range(9)]==[4]*9 and [g0[field(j,1)] for j in range(9)]==[s0[field(j,1)] for j in range(9)]
        assert [g1[field(j,2)] for j in range(9)]==[4]*9 and [g1[field(j,0)] for j in range(9)]==[s1[field(j,0)] for j in range(9)]
        for s in range(3):
            assert n.call(fn('sp_hal'),64+a,s)==0 and n.call(fn('sp_col'),64+a,s)==0
            assert n.call(fn('sp_hal'),64+b,s)==st[b][s]&3 and n.call(fn('sp_col'),64+b,s)==st[b][s]>>2;calls+=4
        n.select(2,64+a);calls+=1;assert n.fields(2)==[4]*9    # its table rows are neutral too
        n.select(2,64+b);calls+=1;assert n.fields(2)==vals[b+1][2]
        n.power_off();calls+=1;words=struct.unpack('<%dI'%V3_WORDS,n.writes[-1])
        assert list(words[3:3+films])==prints and list(words[3+films:23])==fp[films:]   # films beyond the build keep theirs
        put_ud([]);fingerprints=dict(changed=a,kept=b)
    # 3. A version-2 record (round 6) is taken over: its values, Weak / Strong as strength 1 / 3 red.
    vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
    lv=[[rng.randrange(3) for s in range(3)] for f in range(20)]
    n.store={12:record_v2(vals,lv)};rec=valid_record(rng)
    for j in range(9):rec[field(j,0)]=vals[0][0][j]
    cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);n.writes=[];assert n.boot();calls+=1
    for f in range(films):
        for s in range(3):assert n.call(fn('sp_hal'),64+f,s)=={0:0,1:1,2:3}[lv[f][s]] and n.call(fn('sp_col'),64+f,s)==0;calls+=2
    n.select(0,64);calls+=1;assert n.fields(0)==vals[1][0]
    n.select(0,11);n.power_off();calls+=2;w=struct.unpack('<%dI'%V3_WORDS,n.writes[-1]);assert list(w[3:3+films])==prints
    # 4. A version-1 record (nine films) is taken over.
    v1=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(10)]
    n.store={12:record_v1(v1)};rec=valid_record(rng)
    for s in range(3):
        for j in range(9):rec[field(j,s)]=v1[0][s][j]
    cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);n.writes=[];assert n.boot();calls+=1
    for look in [64,72]+([64+films-1] if films>9 else []):
        if look>=64+films:continue
        n.select(0,look);calls+=1
        assert n.fields(0)==(v1[look-63][0] if look<=72 else v1[0][0])
    n.select(0,11);calls+=1
    # 5. Films this build does not have: in the record in use (Standard and its values from the
    # table) and in a stored record (Standard and Standard's values).
    stale=[]
    if films<20:
        vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
        st=[[rng.randrange(8) for s in range(3)] for f in range(20)]
        fp=list(prints)+[rng.randrange(1,1<<32) for _ in range(20-films)]
        n.store={12:record_v3(vals,st,fp)};rec=valid_record(rng);missing=64+films+rng.randrange(20-films)
        rec[0x1c2+2]=missing;rec[0x1c2]=11
        for j in range(9):rec[field(j,1)]=(j*2)%9;rec[field(j,0)]=(j*5)%9
        s0=valid_record(rng);s0[0x1c2]=missing
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(STORED0,bytes(s0));put_ud([STORED0])
        cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
        assert n.rec()[0x1c2+2]==11 and n.fields(1)==vals[0][1]
        g0=bytes(cpu.mem_read(STORED0,0xb28))
        assert g0[0x1c2]==11 and [g0[field(j,0)] for j in range(9)]==[(j*5)%9 for j in range(9)]   # set 0 of the record in use is Standard's
        put_ud([]);stale.append(missing)
    # 5b. Round 8: a hidden film in the standard photo set (0) at start: Standard there, the film's
    # values in its table row (selected again, it gets them back), Standard's values from the table;
    # a stored record's set 0 likewise (Standard's values); a hidden film in a custom set (1, 2) is
    # kept, as the look of any set this build shows.
    hidden_reset=[]
    for h in hidden_films[:3]:
        vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
        st=[[rng.randrange(8) for s in range(3)] for f in range(20)]
        fp=list(prints)+[rng.randrange(1,1<<32) for _ in range(20-films)]
        n.store={12:record_v3(vals,st,fp)};rec=valid_record(rng)
        rec[0x1c2]=h;rec[0x1c2+2]=h;rec[0x1c2+4]=11
        film=[rng.randrange(9) for j in range(9)];c1=[rng.randrange(9) for j in range(9)]
        for j in range(9):rec[field(j,0)]=film[j];rec[field(j,1)]=c1[j]
        s0=valid_record(rng);s0[0x1c2]=h;s0[0x1c2+2]=h
        s0c1=[s0[field(j,1)] for j in range(9)]
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(STORED0,bytes(s0));put_ud([STORED0])
        cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
        r=n.rec();assert r[0x1c2]==11 and r[0x1c2+2]==h and n.fields(0)==vals[0][0] and n.fields(1)==c1
        g0=bytes(cpu.mem_read(STORED0,0xb28))
        assert g0[0x1c2]==11 and [g0[field(j,0)] for j in range(9)]==vals[0][0] and g0[0x1c2+2]==h and [g0[field(j,1)] for j in range(9)]==s0c1
        n.select(0,h);calls+=1;assert n.fields(0)==film   # shown again: its own values
        n.select(0,11);calls+=1;assert n.fields(0)==vals[0][0]
        put_ud([]);hidden_reset.append(h)
    # 6. Damaged tables (checksum, length, version, a setting of 8, a value above 0x20) are not used.
    vals=[[[rng.randrange(9) for j in range(9)] for s in range(3)] for o in range(21)]
    good=record_v3(vals,[[5]*3 for _ in range(20)],list(prints)+[1]*(20-films))
    def resign(b):w=list(struct.unpack('<%dI'%V3_WORDS,b));w[-1]=checksum(w[:-1]);return struct.pack('<%dI'%V3_WORDS,*w)
    bad=[good[:-4]+bytes([good[-4]^1])+good[-3:],good[:-4],resign(good[:4]+b'\4'+good[5:]),
         resign(good[:12+80+567]+b'\x08'+good[12+80+568:]),resign(good[:12+80]+b'\x21'+good[12+81:])]
    for b in bad:
        n.store={12:b};rec=valid_record(rng)
        for j in range(9):rec[field(j,0)]=j%9
        cpu.mem_write(REC,bytes(rec));cpu.mem_write(GAP,b'\xa5'*4);assert n.boot();calls+=1
        n.select(0,64);calls+=1;assert n.fields(0)==[j%9 for j in range(9)] and n.call(fn('sp_hal'),64,0)==0 and n.call(fn('sp_col'),64,0)==0
        n.select(0,11);calls+=1
    # 7. No memory: everything stays out of the way.
    n.alloc_ok=False;n.store={};cpu.mem_write(GAP,b'\xa5'*4);assert n.boot()==0
    n.call(fn('sp_hal_put'),64,0,2);n.call(fn('sp_col_put'),64,0,1)
    assert n.call(fn('sp_hal'),64,0)==0 and n.call(fn('sp_col'),64,0)==0 and n.call(fn('sp_hal_level'),64)==0
    n.alloc_ok=True;calls+=6
    return dict(schema=3,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,calls=calls,seed=seed,steps=steps,**counts,
        fingerprints=fingerprints,version2_taken_over=True,version1_taken_over=True,missing_film_sets_reset=stale,hidden_film_sets_reset=hidden_reset,damaged_tables_rejected=len(bad),
        no_memory_falls_back=True,hardware_tested=False,
        scope='Patched native look setters, native start-up fill, load and save stubs (with the settings guard); module entry points called directly; load/save, store and allocator substituted.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
