"""The Image Control lists' order kept in the camera (tools/gr3x/native/films.c -DLIVE_LAYOUT; look-layout.ts,
custom-position.ts and films-r10.ts's RAW development list, built with `liveLayout`), executed in the built image
(GR III 2.10 / IIIx 1.60, round 10 with films).

The settings load runs through the scaffold (the films' module reads HTData record 15, in a substituted store,
and sets the RAM word 0x5580438c); then, natively: ImageControlModel's count, entry and reverse lookup for the
still, movie and RAW development lists (the model's byte +0x1b 0, 1, 2), the Custom entries' map of the still
lists (custom-position.ts), and RAW development's list length, base and look (films-r10.ts). They must follow
the entries the module holds: the build's (no record, or a record that is not exactly the build's entries: other
looks, a look twice, Standard or a Custom entry hidden, another version, a bad checksum), or a valid record's
(another order, other hidden looks, the Custom entries elsewhere). Before the settings are loaded (the word is
0) the build's tables answer.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import arm_const as reg
from films_probe import FilmsProbe,fresh_records,RECS,UD,GAP,WRITE,READ,SIZE,HT,checksum,STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

COUNT,ITEM,INDEX,ACTIVE_SET=0x532c2a9c,0x532c2c80,0x532c2f08,0x532bd6d4
RAW_DIAL=0x53283c08
RAW_COUNT,RAW_BASE,RAW_LOOK=0x53283358,0x532834d0,0x532834f0
SINGLETON,MODEL_GET=0x5320ad88,0x5320ba9c
WORD=0x5580438c
MODEL=0x62058000;RAWOBJ=0x6205e000
MOVIE=[11,12,13,15,16,22,17,18,19,21];STILL12=list(range(11,23))
RAW_OF_STYLE={11:1,12:2,13:3,14:4,15:5,16:6,22:7,17:8,18:9,19:10,20:11,21:12}
C1,C2,HID=0x7e,0x7f,0x80
LL_WORDS=3+40//4+1

class LiveProbe(FilmsProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest);self.set=0
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at in (WRITE,READ,SIZE) and r(1) in (14,15):
            key=r(1)
            if at==SIZE:self._ret(cpu,len(self.store.get(key,b'')))
            elif at==READ:
                d=self.store.get(key)
                if d is None:self._ret(cpu,0)
                else:n=min(r(2),len(d));cpu.mem_write(r(3),d[:n]);self._ret(cpu,1)
            else:d=bytes(cpu.mem_read(r(3),r(2)));self.writes.append((key,d));self.store[key]=d;self._ret(cpu,1)
        elif at==ACTIVE_SET:self._ret(cpu,self.set)
        elif at==SINGLETON:self._ret(cpu,0x62057000)
        elif at==MODEL_GET:self._ret(cpu,MODEL)
        else:super()._hook(cpu,at,size,user)
    def model(self,kind):self.uc.mem_write(MODEL,bytes(0x40));self.uc.mem_write(MODEL+0x1b,bytes([kind]))
    def word(self):return struct.unpack('<I',self.uc.mem_read(WORD,4))[0]

def record(entries,version=1,n=None):
    n=len(entries) if n is None else n
    body=bytes(entries)+bytes(40-len(entries))
    words=[0x4c335247,version,n]+list(struct.unpack('<10I',body))
    return struct.pack('<%dI'%LL_WORDS,*words,checksum(words))

def lists(entries,films):
    shown=[x for x in entries if not x&HID]
    still=[x for x in shown if x not in (C1,C2)]
    return {0:still,1:[x for x in still if x in MOVIE or x>=64],2:[x for x in still if x in STILL12]},shown

def check(n,entries,films,label):
    L,shown=lists(entries,films);calls=0
    for kind in (0,1,2):
        n.model(kind);want=L[kind]
        for set_ in (0,1,2):
            n.set=set_
            got=n.call(COUNT,MODEL);calls+=1
            assert got==len(want),(label,kind,set_,got,len(want))
        got=[n.call(ITEM,MODEL,i) for i in range(len(want))];calls+=len(want)
        assert got==want,(label,kind,got,want)
        for look in range(0,90):
            idx=n.call(INDEX,MODEL,look);calls+=1
            exp=want.index(look) if look in want else len(want)
            if kind==0 or look in want: assert idx==exp,(label,kind,look,idx,exp)
    n.model(2);assert n.call(RAW_DIAL)==len(L[2]);calls+=1
    # The Custom entries' map (custom-position.ts) on the still list.
    n.model(0);ns=len(L[0]);m=n.manifest['lookEntries']['films']['customMap']
    for v,x in enumerate(shown):
        phys=ns if x==C1 else ns+1 if x==C2 else L[0].index(x)
        assert n.call(m,v,0)==phys,(label,'map',v,x,phys)
        assert n.call(m,phys,1)==v,(label,'inverse',v,x,phys)
        calls+=2
    assert n.call(m,len(shown)+3,0)==len(shown)+3;calls+=1
    # RAW development's list (films-r10.ts): as shot (byte +5 set) or not, the looks, then Custom 1 / 2.
    # In the shown order, the Custom entries where the still lists have them.
    rawlist=[('custom',1) if x==C1 else ('custom',2) if x==C2 else ('look',RAW_OF_STYLE[x] if x<64 else 13+x-64) for x in shown]
    for shot in (0,1):
        n.uc.mem_write(RAWOBJ,bytes(0x100));n.uc.mem_write(RAWOBJ+5,bytes([shot]));n.uc.mem_write(RAWOBJ+0x83,bytes([0x31,0x32,0x33]))
        cnt=n.call(RAW_COUNT,RAWOBJ);calls+=1
        assert cnt==len(rawlist)+shot,(label,'raw count',shot,cnt,len(rawlist))
        for i in range(cnt):
            look=n.call(RAW_LOOK,RAWOBJ,i);base=n.call(RAW_BASE,RAWOBJ,i);calls+=2
            if shot and i==0:assert look==0 and base==0,(label,'as shot',look,base);continue
            k,v=rawlist[i-shot]
            if k=='look':assert look==v and base==0,(label,'raw',i,look,v,base)
            else:assert base==v and look==0x31+v,(label,'raw custom',i,look,base,v)
    return calls

def verify(data,manifest,seed=1127):
    assert manifest.get('round10') and manifest.get('filmCount') and manifest.get('liveLayout')
    f=manifest['lookEntries']['films'];default=list(f['liveEntries']);films=manifest['filmCount']
    n=LiveProbe(data,manifest);n.manifest=manifest;rng=random.Random(seed);cpu=n.uc;calls=0;rep={}
    assert len(default)==12+films+2 and default.count(C1)==1 and default.count(C2)==1
    def boot(store):
        n.store=dict(store);recs=fresh_records(rng,films)
        for r in recs:r[0x1c0]=0
        n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);cpu.mem_write(WORD,b'\xa5'*4)
        s=n.boot();assert s
    # 0. Before the settings load the word is 0 (the zero fill): the build's tables.
    cpu.mem_write(WORD,bytes(4));calls+=check(n,default,films,'tables')
    # 1. No record: the build's entries; nothing written at power off.
    boot({});assert n.word()!=0 and n.word()!=0xa5a5a5a5;calls+=check(n,default,films,'no record')
    n.writes=[];n.power_off();assert not [k for k,_ in n.writes if k==15];calls+=1
    # 2. Valid records: shuffled orders, other hidden looks, the Custom entries anywhere.
    ids=[x&0x7f for x in default]
    for t in range(12):
        order=ids[:];rng.shuffle(order)
        e=[x|(HID if x not in (11,C1,C2) and rng.random()<0.3 else 0) for x in order]
        boot({15:record(e)});calls+=check(n,e,films,f'record {t}')
    rep['valid_records']=12
    # 3. Records that are not the build's entries: the build's.
    bad=[]
    e=ids[:];bad.append(record(e[:-1]+[0x50]))                       # a look the build does not have
    e=ids[:];e[1]=e[0];bad.append(record(e))                          # a look twice
    e=[x|(HID if x==11 else 0) for x in ids];bad.append(record(e))     # Standard hidden
    e=[x|(HID if x==C1 else 0) for x in ids];bad.append(record(e))     # a Custom entry hidden
    bad.append(record(ids,version=2))                                 # another version
    bad.append(record(ids[:-1],n=len(ids)-1))                          # another count
    good=record(ids);bad.append(good[:-4]+bytes([good[-4]^1])+good[-3:])  # checksum
    bad.append(good[:-4])                                             # size
    for i,b in enumerate(bad):
        boot({15:b});calls+=check(n,default,films,f'bad {i}')
    rep['bad_records_rejected']=len(bad)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,entries=len(default),calls=calls,**rep,hardware_tested=False,
        scope='Native list count/entry/reverse lookup, Custom map and RAW development list after the native settings load through the scaffold; store, allocator and getters substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();r=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    print(json.dumps(r,indent=2))
