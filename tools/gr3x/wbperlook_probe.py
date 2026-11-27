"""White balance per look (round 10, films.c built with -DWB_PER_LOOK; core/src/fw/gr3x/wbperlook.ts),
executed through the camera's own code in the built image (GR III 2.10 / IIIx 1.60):

  - the three photo "look of set" setters and StillActiveImageControlSet's setter (0x5327b374) run
    natively, patched; the camera's 28 white balance setters (StillWhiteBalance 0x532721e4, the G-M
    ones from 0x53272378, the B-A ones from 0x5327292c, ColorTemp 0x53272ee0) run natively too, only
    their change notifications (0x5327215c, 0x53272344, 0x532728f8, 0x53272eac) and the record push
    (0x532750f8) are recorded instead of run;
  - first the round's own films check (films_probe.verify) on this build, record 14 allowed;
  - then a seeded random sequence of look changes in every photo and movie set, changes of the photo
    set in use, white balance changes (through the camera's setters, as its menus), mode recalls
    (sp_before_recall) and power cycles (the settings load and save through the scaffold, record 14
    in a substituted store), against a Python model in which every look keeps the white balance it
    was last used with; after every step the record's white balance must be the model's, and
    nothing but the white balance values (never their flag bytes) may change beside what the setters
    of the look write;
  - record 14's layout and checksum; a damaged record is not used; without memory nothing happens.
This does not establish flash persistence or the camera's menus.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import arm_const as reg
import films_probe as fp
from films_probe import FilmsProbe,fresh_records,RECS,UD,GAP,WRITE,READ,SIZE,HT,look_at,checksum

if not __debug__:raise RuntimeError('Validation requires Python assertions')

ACTIVE_SETTER=0x5327b374
WB_SETTERS=[0x532721e4]+[0x53272378+0x20*i for i in range(13)]+[0x5327292c+0x20*i for i in range(13)]+[0x53272ee0]
NOTIFY={0x5327215c:'mode',0x53272344:'gm',0x532728f8:'ba',0x53272eac:'temp'}
WB_N=28;WB_LOOKS=52;WB_ROWS=54;WB_BYTES=29;WB_DATA=WB_ROWS+WB_ROWS*WB_BYTES;WB_WORDS=3+(WB_DATA+3)//4+1
WB_V1_DATA=WB_LOOKS+WB_LOOKS*WB_BYTES;WB_V1_WORDS=3+(WB_V1_DATA+3)//4+1
WB_OFFSETS={0x178+2*k for k in range(WB_N)}|{0x1af}
PHOTO_LOOKS=list(range(11,23))
def wb_index(look):return look if look<32 else 32+look-64 if 64<=look<84 else None
def key(s,look):return ('custom',s) if s in (1,2) else look
def row_of(k):return WB_LOOKS+k[1]-1 if isinstance(k,tuple) else wb_index(k)

class WbProbe(FilmsProbe):
    """FilmsProbe with record 14 in the store and the white balance setters' notifications recorded."""
    def __init__(self,data,manifest):
        super().__init__(data,manifest);self.notes=[]
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at in NOTIFY:
            assert r(0)==UD,(hex(at),hex(r(0)));self.notes.append(NOTIFY[at]);self._ret(cpu,0)
        elif at in (WRITE,READ,SIZE) and r(1) in (14,15):
            assert r(0)==HT;key=r(1)
            if at==SIZE:self._ret(cpu,len(self.store.get(key,b'')))
            elif at==READ:
                d=self.store.get(key)
                if d is None:self._ret(cpu,0)
                else:n=min(r(2),len(d));cpu.mem_write(r(3),d[:n]);self._ret(cpu,1)
            else:
                if key in self.fail_keys:self.failed.append(key);self._ret(cpu,0);return
                d=bytes(cpu.mem_read(r(3),r(2)));self.writes.append((key,d));self.store[key]=d;self._ret(cpu,1)
        else:super()._hook(cpu,at,size,user)
    def select(self,c,look):
        """As FilmsProbe.select, but the white balance values may be written too (by the camera's WB setters)."""
        self.rec_writes=[];self.pushes=[]
        assert self.call(fp.STYLE_SETTERS[c],UD,look)==1
        assert len(self.pushes)==1
        recs=[RECS[0]] if c<3 else RECS
        allowed={(r+fp.FIELD[j][c],1) for r in recs for j in range(fp.NP) if fp.FIELD[j][c]}|{(r+look_at(c),1) for r in recs}
        allowed|={(RECS[0]+o,1) for o in WB_OFFSETS if o!=0x1af}|{(RECS[0]+0x1ae,2)}
        assert all(w in allowed for w in self.rec_writes),[(hex(a),s) for a,s in self.rec_writes if (a,s) not in allowed]
    def activate(self,s):
        self.rec_writes=[];self.pushes=[]
        assert self.call(ACTIVE_SETTER,UD,s)==1
        allowed={(RECS[0]+0x1c0,1)}|{(RECS[0]+o,1) for o in WB_OFFSETS if o!=0x1af}|{(RECS[0]+0x1ae,2)}
        assert all(w in allowed for w in self.rec_writes),[(hex(a),s) for a,s in self.rec_writes if (a,s) not in allowed]
        assert self.rec()[0x1c0]==s
    def set_wb(self,k,v):
        """A white balance field through the camera's own setter (as its menus do)."""
        self.rec_writes=[];self.notes=[]
        assert self.call(WB_SETTERS[k],UD,v)==1
        assert self.rec_writes==([(RECS[0]+0x1ae,2)] if k==27 else [(RECS[0]+0x178+2*k,1)]),self.rec_writes
        assert len(self.notes)==1
    def wb(self):
        r=self.rec();return tuple(r[0x178+2*k] for k in range(27))+(r[0x1ae]|r[0x1af]<<8,)

def random_wb(rng):return tuple(rng.randrange(0,30) for _ in range(27))+(rng.randrange(2500,10001),)

def verify(data,manifest,seed=1126,steps=3000,films_check=True):
    assert manifest.get('round10') and manifest.get('filmCount') and manifest.get('wbPerLook')
    sym=manifest['lookEntries']['films']['moduleSymbols']
    assert 'sp_active' in sym and 'sp_wb_done' in sym
    assert any(s['address']==ACTIVE_SETTER for s in manifest['sites'])
    rep={}
    # 1. The round's films check, unchanged, with record 14 allowed and the WB setters' writes allowed.
    # (films_probe's takeover cases need two films or more.)
    if films_check and manifest['filmCount']>=2:
        fp.FilmsProbe=WbProbe
        try:rep['films_check']=fp.verify(data,manifest)
        finally:fp.FilmsProbe=FilmsProbe
    n=WbProbe(data,manifest);rng=random.Random(seed);cpu=n.uc;films=n.n;calls=0
    looks=PHOTO_LOOKS+[64+k for k in range(films)]
    def start(recs):
        n.records(recs);cpu.mem_write(GAP,b'\xa5'*4);s=n.boot();assert s;return s
    # 2. First start without record 14: no look has a white balance; the one in use stays.
    recs=fresh_records(rng,films)
    for c in range(3):recs[0][look_at(c)]=rng.choice(looks)
    recs[0][0x1c0]=0
    w0=random_wb(rng)
    for k in range(27):recs[0][0x178+2*k]=w0[k]
    recs[0][0x1ae]=w0[27]&0xff;recs[0][0x1af]=w0[27]>>8
    flags_before=bytes(recs[0][0x179+2*k] for k in range(27))
    n.store={};start(recs);calls+=1
    assert n.wb()==w0
    model={}           # look -> its white balance (only looks used before)
    cur=w0
    counts=dict(look_changes=0,custom_look_changes=0,set_changes=0,wb_changes=0,recalls=0,power_cycles=0,restored=0,other_set=0,movie=0)
    def look_in_use():r=n.rec();return r[look_at(r[0x1c0])]
    for step in range(steps):
        op=rng.random();r=n.rec();active=r[0x1c0]
        if op<0.35:
            c=rng.randrange(3);look=rng.choice(looks);before=r[look_at(c)]
            n.notes=[];n.select(c,look);calls+=1
            if c==active==0 and before!=look:
                model[before]=cur
                if look in model:
                    if model[look]!=cur:counts['restored']+=1
                    cur=model[look]
                counts['look_changes']+=1
            else:
                # another set, or a Custom set in use (its white balance is its own, whatever its look)
                assert not n.notes,'a look change outside the standard set in use touched the white balance'
                counts['custom_look_changes' if c==active else 'other_set']+=1
        elif op<0.45:
            c=3+rng.randrange(3);n.notes=[];n.select(c,rng.choice(looks));calls+=1
            assert not n.notes;counts['movie']+=1
        elif op<0.60:
            s=rng.randrange(3);fk=key(active,r[look_at(active)]);tk=key(s,r[look_at(s)])
            n.activate(s);calls+=1
            if s!=active:
                model[fk]=cur
                if tk!=fk and tk in model:cur=model[tk]
                counts['set_changes']+=1
        elif op<0.88:
            k=rng.randrange(WB_N);v=rng.randrange(2500,10001) if k==27 else rng.randrange(0,30)
            n.set_wb(k,v);calls+=1;cur=cur[:k]+(v,)+cur[k+1:];counts['wb_changes']+=1
        elif op<0.94:
            # A mode recall: the record in use becomes a stored one (here: its white balance and looks
            # change as the copy would); before it, the look in use keeps the white balance.
            n.fn('sp_before_recall',UD);calls+=1
            model[key(n.rec()[0x1c0],look_in_use())]=cur
            new=random_wb(rng);rec=n.rec()
            for k in range(27):rec[0x178+2*k]=new[k]
            rec[0x1ae]=new[27]&0xff;rec[0x1af]=new[27]>>8
            for c in range(3):rec[look_at(c)]=rng.choice(looks)
            rec[0x1c0]=rng.randrange(3)
            cpu.mem_write(RECS[0],bytes(rec));cur=new;counts['recalls']+=1
        else:
            n.writes=[];n.power_off();calls+=1
            w=[d for k_,d in n.writes if k_==14]
            if w:
                words=struct.unpack('<%dI'%WB_WORDS,w[-1])
                assert words[:3]==(0x33575247,2,WB_DATA) and words[-1]==checksum(list(words[:-1]))
                body=w[-1][12:12+WB_DATA];have=body[:WB_ROWS]
                for k,v in model.items():
                    i=row_of(k);row=body[WB_ROWS+i*WB_BYTES:WB_ROWS+(i+1)*WB_BYTES]
                    assert have[i]==1 and tuple(row[:27])+(row[27]|row[28]<<8,)==v,(k,v)
                assert sum(have)==len(model)
            rec=n.rec();recs=[rec]+[n.rec(i) for i in range(1,8)]
            n.next_heap+=0;start(recs);calls+=1;counts['power_cycles']+=1
        assert n.wb()==cur,(step,op,n.wb(),cur)
    assert bytes(n.rec()[0x179+2*k] for k in range(27))==flags_before,'a flag byte of the white balance changed'
    assert all(v>0 for v in counts.values()),counts
    rep['random']=dict(seed=seed,steps=steps,looks_with_wb=len(model),**counts)
    # 3. Two looks by hand: Positive Film (17) with a shifted WB, Negative Film (22) with the default.
    recs=fresh_records(rng,films);recs[0][0x1c0]=0;recs[0][look_at(0)]=22
    n.store={};start(recs);calls+=1
    base=n.wb()
    n.select(0,17);assert n.wb()==base                    # 17 never used: keeps the WB in use
    n.set_wb(0,2);n.set_wb(3+13,26)                        # e.g. Daylight, B-A shift of Daylight
    shifted=n.wb()
    n.select(0,22);assert n.wb()==base                     # Negative Film: its own WB back
    n.select(0,17);assert n.wb()==shifted                  # Positive Film: the shifted WB back
    n.writes=[];n.power_off();assert [k for k,_ in n.writes].count(14)==1
    start([n.rec()]+[n.rec(i) for i in range(1,8)])
    n.select(0,22);assert n.wb()==base;n.select(0,17);assert n.wb()==shifted
    calls+=8;rep['positive_negative']=True
    # 3b. Custom 1 holding Negative Film has a white balance of its own (not Negative Film's of the standard set).
    rec=n.rec();rec[look_at(1)]=22;cpu.mem_write(RECS[0],bytes(rec))
    n.select(0,22);neg=n.wb()                               # standard set on Negative Film
    n.activate(1);assert n.wb()==neg                         # Custom 1 never used: keeps the WB in use
    n.set_wb(0,3);n.set_wb(1+13+3,24);c1=n.wb();assert c1!=neg
    n.activate(0);assert n.wb()==neg                         # standard Negative Film: its own WB
    n.activate(1);assert n.wb()==c1                          # Custom 1: its own
    n.notes=[];n.select(1,17);assert n.wb()==c1 and not n.notes   # another look in Custom 1: still Custom 1's WB
    n.activate(0);assert n.wb()==neg
    n.writes=[];n.power_off();start([n.rec()]+[n.rec(i) for i in range(1,8)])
    n.activate(1);assert n.wb()==c1;n.activate(0);assert n.wb()==neg
    calls+=12;rep['custom_sets_own_wb']=True
    # 3c. A version-1 record (looks' rows only, as the first build wrote it) is taken over.
    v1_rows={22:random_wb(rng),17:random_wb(rng),64:random_wb(rng)}
    body=bytearray(WB_V1_DATA)
    for look,v in v1_rows.items():
        i=wb_index(look);body[i]=1;b=bytes(v[:27])+struct.pack('<H',v[27]);body[WB_LOOKS+i*WB_BYTES:WB_LOOKS+(i+1)*WB_BYTES]=b
    body+=bytes((-len(body))%4);words=[0x33575247,1,WB_V1_DATA]+list(struct.unpack('<%dI'%(len(body)//4),body))
    v1=struct.pack('<%dI'%WB_V1_WORDS,*words,checksum(words))
    recs=fresh_records(rng,films);recs[0][0x1c0]=0;recs[0][look_at(0)]=11;recs[0][look_at(1)]=22
    n.store={14:v1};start(recs);w11=n.wb()
    for look,v in v1_rows.items():n.select(0,look);assert n.wb()==v,(look,n.wb(),v)
    n.select(0,11);assert n.wb()==w11
    n.activate(1);assert n.wb()==w11                         # Custom 1: no white balance yet (keeps the one in use)
    n.writes=[];n.power_off();w=[d for k_,d in n.writes if k_==14][-1];words=struct.unpack('<%dI'%WB_WORDS,w)
    assert words[:3]==(0x33575247,2,WB_DATA) and words[-1]==checksum(list(words[:-1]))
    calls+=10;rep['version1_taken_over']=True
    # 4. A damaged record 14 is not used (no look has a white balance); no memory: nothing happens.
    good=n.store[14]
    def resign(b):w=list(struct.unpack('<%dI'%WB_WORDS,b));w[-1]=checksum(w[:-1]);return struct.pack('<%dI'%WB_WORDS,*w)
    bad=[good[:-4]+bytes([good[-4]^1])+good[-3:],good[:-4],resign(good[:4]+b'\x07'+good[5:]),resign(good[:12]+b'\x02'+good[13:])]
    for b in bad:
        recs=fresh_records(rng,films);recs[0][0x1c0]=0;recs[0][look_at(0)]=22
        n.store={14:b};start(recs);w=n.wb()
        n.select(0,17);assert n.wb()==w;n.select(0,22);assert n.wb()==w;calls+=3
    n.alloc_ok=False;n.store={};cpu.mem_write(GAP,b'\xa5'*4);assert n.boot()==0
    w=n.wb();n.notes=[];n.select(0,17);n.activate(1);n.activate(0);assert n.wb()==w and not n.notes
    n.writes=[];n.power_off();assert not [k for k,_ in n.writes if k==14];n.alloc_ok=True;calls+=5
    rep['damaged_rejected']=len(bad)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,calls=calls,**rep,hardware_tested=False,
        scope='Native look, photo-set and white balance setters; their notifications and the record push recorded; load/save, store and allocator substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    a.add_argument('--seed',type=int,default=1126);a.add_argument('--steps',type=int,default=3000)
    a.add_argument('--no-films-check',action='store_true')
    x=a.parse_args();r=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()),x.seed,x.steps,not x.no_films_check)
    with x.report.open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in r.items() if k!='films_check'},indent=2))
