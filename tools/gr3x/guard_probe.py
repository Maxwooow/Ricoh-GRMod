"""Round 7: the settings guard (core/src/fw/gr3x/guard.ts), executed in the built image.

`fix(record)` and `fixAll(settings object)` are called on records of random bytes: every photo and
movie look that is not one of the camera's own (11..22) or a film of the build becomes Standard
(round 8: also a look hidden from the lists, in the standard photo and movie sets),
a ratio above the build's largest identity becomes 3:2, and no other byte changes. The mode
recall runs natively from the copy of the stored record to just before the record goes to the live
values; the settings load and save hooks run natively with the firmware's load and save
substituted (the save must see guarded records). This does not establish the camera's menus.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

LOOKS=(0x1c2,0x1c4,0x1c6,0x57e,0x580,0x582);RATIO=0x4c2;SIZE=0xb28
LOAD_DATA,LOAD_CALL,SAVE_DATA,SAVE_CALL,MEMCPY=0x5324b284,0x5324b754,0x5323f274,0x5322b0a8,0x5313fd80
RECALL_FROM,RECALL_TO=0x53279fec,0x5327a008
REGION=0x63000000;UD=REGION;RECS=REGION+0x1000

SOFT=0x9a1;ADJ_SLOTS=(0x918,0x91a,0x91c,0x91e,0x920)

def guarded(rec,films,max_ratio,hidden=(),soft_r10=False):
    out=bytearray(rec)
    for off in LOOKS:
        v=out[off]
        if not (11<=v<=22 or 64<=v<64+films):out[off]=11
        # Round 8: a hidden look of the standard photo / movie set becomes Standard (the custom sets keep theirs).
        if off in (0x1c2,0x57e) and out[off] in hidden:out[off]=11
    if out[RATIO]>max_ratio:out[RATIO]=0
    # Round 10: soft focus on (1..3) and on no slot as 0x09: the slots that hold 0x13 (rounds 6..9) get 0x09.
    if soft_r10 and 1<=out[SOFT]<=3 and not any(out[f]==9 for f in ADJ_SLOTS):
        moved=False
        for f in ADJ_SLOTS:
            if out[f]==0x13:out[f]=9;moved=True
        # On no slot at all: soft focus off (it could not be seen or changed).
        if not moved:out[SOFT]=0
    return bytes(out)

class GuardProbe(AdjProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest);self.uc.mem_map(REGION,0x40000);self.loads=0;self.saves=[]
        # Round 10: the load and save are hooked at their entries (the settings scaffold): the
        # firmware's own body is the scaffold's continuation.
        e=manifest.get('entries',{})
        self.load_native=e.get('settingsLoadNative',LOAD_DATA);self.save_native=e.get('settingsSaveNative',SAVE_DATA)
        # The films' table pointer (0x55804374, 0 here: slots3.c stays out of the way at a recall).
        try:self.uc.mem_map(0x55800000,0x100000)
        except Exception:pass
    def _hook(self,cpu,at,size,user):
        r=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(n)))
        if at==self.load_native:
            assert r(0)==UD;self.loads+=1;cpu.reg_write(reg.UC_ARM_REG_R0,0x77);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==self.save_native:
            assert r(0)==UD;self.saves.append([bytes(cpu.mem_read(RECS+i*0x1000,SIZE)) for i in range(8)])
            cpu.reg_write(reg.UC_ARM_REG_R0,0x5a);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)
    def records(self,rng,pointers=True):
        recs=[bytes(rng.randrange(256) for _ in range(SIZE)) for _ in range(8)]
        for i,rec in enumerate(recs):self.uc.mem_write(RECS+i*0x1000,rec)
        ud=bytearray(0x40)
        for i in range(8):
            if pointers or i%3:struct.pack_into('<I',ud,4+4*i,RECS+i*0x1000)
        self.uc.mem_write(UD,bytes(ud));return recs,ud
    def run(self,start,stop,regs):
        cpu=self.uc
        for i in range(13):cpu.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs.get(i,0x1230+i))
        cpu.reg_write(reg.UC_ARM_REG_SP,STACK);cpu.reg_write(reg.UC_ARM_REG_LR,STOP);cpu.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        cpu.emu_start(start,stop,count=200000)
        assert cpu.reg_read(reg.UC_ARM_REG_PC)==stop and cpu.reg_read(reg.UC_ARM_REG_SP)==STACK

def entries_of(manifest):
    """The guard's entries: in the adj layer (no films) or with the films' own parameters."""
    e=manifest['entries']
    if 'guardFixAll' in e:return dict(fix=e['guardFix'],fixAll=e['guardFixAll'],recall=e['guardRecall'],films=0,own=False)
    # Round 10: with the films' module (films-r10.ts).
    own=manifest['lookEntries'].get('films') or manifest['lookEntries']['ownParameters']
    return dict(fix=own['guardFix'],fixAll=own['guardFixAll'],recall=own['guardRecall'],films=manifest['filmCount'],own=True)

def verify(data,manifest,seed=1107,rounds=400):
    g=entries_of(manifest);films=g['films'];max_ratio=max(r['id'] for r in manifest['menu'])
    hidden=tuple((manifest.get('lookLayout') or {}).get('hidden',()))
    assert not hidden or manifest.get('round8')
    r10=bool(manifest.get('round10'));soft_r10=r10 and bool(manifest.get('adjSoftFocus'))
    want=lambda rec,f,m:guarded(rec,f,m,hidden,soft_r10)
    assert max_ratio==3+sum(1 for r in manifest['menu'] if r['id']>=4)
    p=GuardProbe(data,manifest);cpu=p.uc;rng=random.Random(seed+films*31+max_ratio);calls=0;fixed=0
    # The hook sites point at the guard.
    sites={s['address']:s for s in manifest['sites']}
    # (Round 10: through the settings scaffold at the load's and save's entries, the guard outermost.)
    for at in ((LOAD_DATA,SAVE_DATA) if r10 else (LOAD_CALL,SAVE_CALL))+(0x5327a004,):assert at in sites and 'guard' in sites[at]['reason'],hex(at)
    if r10:assert LOAD_CALL not in sites and SAVE_CALL not in sites
    # 1. fix(record): every value of every look and of the ratio (with a layout every hidden look
    # among them), then random records.
    for v in range(256):
        rec=bytearray(rng.randrange(256) for _ in range(SIZE))
        for off in LOOKS:rec[off]=v
        rec[RATIO]=v
        if soft_r10 and v%4==1:
            # Round 10's soft focus: on / off, 0x13 / 0x09 / other on the slots.
            rec[SOFT]=rng.choice((0,1,2,3,4,0xff))
            for f in ADJ_SLOTS:rec[f]=rng.choice((0x13,9,0,4,0x14))
        cpu.mem_write(RECS,bytes(rec))
        assert p.call(g['fix'],RECS) is not None;calls+=1
        got=bytes(cpu.mem_read(RECS,SIZE));assert got==want(rec,films,max_ratio),v
        fixed+=got!=bytes(rec)
    if soft_r10:
        # Round 9 -> 10: soft focus on (each level) with 0x13 on some, all or none of the slots, or 0x09 already.
        for level in (1,2,3):
            for slots in ((0x13,0,0,0,0),(0,0,0,0,0x13),(0x13,)*5,(0,4,0x14,0,0),(9,0x13,0,0,0),(0,0,0,0,0)):
                rec=bytearray(rng.randrange(256) for _ in range(SIZE))
                for off in LOOKS:rec[off]=11
                rec[RATIO]=0;rec[SOFT]=level
                for f,v in zip(ADJ_SLOTS,slots):rec[f]=v
                cpu.mem_write(RECS,bytes(rec));p.call(g['fix'],RECS);calls+=1
                got=bytes(cpu.mem_read(RECS,SIZE));assert got==want(rec,films,max_ratio),(level,slots)
                if 9 in slots:assert got[SOFT]==level and [got[f] for f in ADJ_SLOTS]==list(slots)
                elif 0x13 in slots:assert got[SOFT]==level and [got[f] for f in ADJ_SLOTS]==[9 if v==0x13 else v for v in slots]
                else:assert got[SOFT]==0 and [got[f] for f in ADJ_SLOTS]==list(slots)
    assert p.call(g['fix'],0)==0;calls+=1
    for _ in range(rounds):
        recs,ud=p.records(rng,pointers=rng.random()<0.7)
        p.call(g['fixAll'],UD);calls+=1
        for i,rec in enumerate(recs):
            ptr=struct.unpack_from('<I',ud,4+4*i)[0]
            assert bytes(cpu.mem_read(RECS+i*0x1000,SIZE))==(want(rec,films,max_ratio) if ptr else rec),i
        assert bytes(cpu.mem_read(UD,0x40))==bytes(ud)
    p.call(g['fixAll'],0);calls+=1
    # 2. The mode recall: the stored record copied into use, then guarded (the stored one unchanged).
    for _ in range(64):
        recs,ud=p.records(rng);mode=rng.randrange(7)
        p.run(RECALL_FROM,RECALL_TO,{5:UD,6:mode});calls+=1
        src=recs[1+mode]
        assert bytes(cpu.mem_read(RECS,0xb26))==want(src,films,max_ratio)[:0xb26]
        assert bytes(cpu.mem_read(RECS+(1+mode)*0x1000,SIZE))==src
    # 3. Load and save (without films; with films slots_probe runs them with the films' table).
    load_save=False
    if not g['own']:
        recs,ud=p.records(rng)
        if r10:p.run(LOAD_DATA,STOP,{0:UD})
        else:p.run(LOAD_CALL,LOAD_CALL+4,{0:UD,4:UD})
        calls+=1
        assert p.loads==1 and (r10 or cpu.reg_read(reg.UC_ARM_REG_R4)==UD) and (not r10 or cpu.reg_read(reg.UC_ARM_REG_R0)==0x77)
        for i,rec in enumerate(recs):assert bytes(cpu.mem_read(RECS+i*0x1000,SIZE))==want(rec,films,max_ratio)
        recs,ud=p.records(rng);p.run(SAVE_DATA if r10 else SAVE_CALL,STOP,{0:UD});calls+=1
        assert cpu.reg_read(reg.UC_ARM_REG_R0)==0x5a and len(p.saves)==1
        assert p.saves[0]==[want(rec,films,max_ratio) for rec in recs]
        load_save=True
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,max_ratio=max_ratio,hidden=list(hidden),calls=calls,
        values_changed=fixed,load_and_save_run=load_save,seed=seed,hardware_tested=False,
        scope='Guard functions called directly; the mode recall, load and save hooks run natively with the firmware load/save substituted.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    a=a.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
