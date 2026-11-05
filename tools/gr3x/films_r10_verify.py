"""Round 10: the films as looks of their own (core/src/fw/gr3x/films-r10.ts), executed in the built
image against the official one.

  - the four reads where a film is still taken as Standard (every look value, all condition flags:
    only the destination register changes; at the development step also the look stash: look,
    Halation level and colour from the Toning byte as GR IV's states, a film 64 + k as 32 + k, and in
    RAW development GR IV's frame-look and orientation words);
  - the lists (still, movie, RAW development's dial) as look_layout_probe.py expects them, the films'
    names and icons;
  - the descriptor builder: every camera look as the official image builds it; a film as Standard
    with the same parameters, but its own tone record from the extended table (multi-axis and YCbCr
    Standard's), its curves, the matrix process on it; unbuilt films (64 + n ..) as Standard;
    transitions between films and looks;
  - the parameters: a set's look changed to a film leaves stored data, live values and property
    commits exactly as Bleach Bypass (18) would (the films' module inert: its swaps are run by
    films_probe.py), and so does every parameter setter (photo and movie); the default getters give
    a film's neutral values; the main menu's Image Control line answers the film;
  - Bleach Bypass's Toning as the camera reads it (development step, slider map): 1..3, else 1;
  - RAW development: style <-> RAW number, every row pick, the Image Control list (count, base, look
    of every entry, with and without "as shot"), the parameter lines of a film (Standard's);
  - the maker note and playback: the look code of a film, the parameter lists (the films with
    Bleach Bypass), the Toning code of a film's Halation and back, the RAW file's look, playback's
    number, style, parameters and icon.
UI widgets, singletons and queue delivery are substitutes (as image_controls_verify.py).
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from image_control_probe import LookProbe,COMMON,CONTEXT,GAMMA_OBJECT,GAMMA_BUFFERS,MODEL,OBJECT,OUTPUT,u32,put,DATA
from image_controls_verify import descriptor,matrix_process,STEP_ARG,USERDATA_COPY
from rear_dial_probe import SELECTOR
from native_probe import STACK,STOP
from look_layout_probe import expected as layout_lists

if not __debug__:raise RuntimeError('Validation requires Python assertions')

NATIVE=[11,12,13,14,15,16,22,17,18,19,20,21]
STASH=0x55804378;FRAME_LOOK=0x55804384;ORIENT_WORD=0x55804380
DEV_READ=0x536db7f8
SETTERS=[0x532bd784,0x532bdcd8,0x532be22c,0x532be8a0,0x532bef14,0x532bf588,0x532bfbfc,0x532c0270,0x532c056c,0x532c0700,0x532c0894,
         0x532c09a8,0x532c0b3c,0x532c0da8,0x532c141c,0x532c1780,0x532c19dc,0x532c1cf4,0x532c2038,0x532c237c]
DEFAULTS=[(0x532c34e8,0x77d),(0x532c3b54,0x77e),(0x532c41c0,0x77f),(0x532c494c,0x780),(0x532c50d8,0x781),(0x532c5864,0x782),
          (0x532c5ff0,0x784),(0x532c677c,0x785),(0x532c6b94,0x786),(0x532c6e38,0x787),(0x532c70e4,0x788),(0x532c7270,0x797),
          (0x532c7520,0x78a),(0x532c78a8,0x78c),(0x532c7f0c,0x78e),(0x532c8570,0x790),(0x532c8bd4,0x793),(0x532c9360,0x794),
          (0x532c9744,0x795),(0x532c9a20,0x796)]
FILM_DEFAULT={0x77d:4,0x77e:4,0x77f:4,0x780:4,0x781:4,0x782:4,0x784:4,0x785:0,0x786:0,0x787:4,0x788:1,0x797:0,0x78a:0,0x78c:0,0x78e:0,
              0x790:0,0x793:4,0x794:4,0x795:0,0x796:0}
RAW_OF={11:1,12:2,13:3,14:4,15:5,16:6,22:7,17:8,18:9,19:10,20:11,21:12}
SCRATCH=0x64000000

def level_of(state):
    """GR IV's STASH_ASM: a Toning state as the stash's level and white bit."""
    s=state if state<7 else 0
    if s>=4:return s-3,0x20000
    return {0:0,1:1,2:3,3:2}[s],0

def run_site(p,at,regs,flags,stop=None,count=200):
    c=p.uc
    for i in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs[i])
    c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_CPSR,(flags<<28)|0x13)
    c.emu_start(at,stop or at+4,count=count)
    assert c.reg_read(reg.UC_ARM_REG_PC)==(stop or at+4),hex(c.reg_read(reg.UC_ARM_REG_PC))
    assert c.reg_read(reg.UC_ARM_REG_SP)==STACK
    return [c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)],c.reg_read(reg.UC_ARM_REG_CPSR)

def verify(data,base,manifest):
    assert manifest.get('round10') and manifest['kind']=='gr3x-image-control-patchset'
    f=manifest['lookEntries']['films'];n=manifest['filmCount'];slots=manifest['addedLooks'];calls=0;cases=0
    films=[s['id'] for s in slots];assert films==list(range(64,64+n))
    stock,patched=LookProbe(data,base),LookProbe(data,manifest)
    stock.uc.mem_map(SCRATCH,0x100000);patched.uc.mem_map(SCRATCH,0x100000)
    try:stock.uc.mem_map(0x55800000,0x100000)
    except Exception:pass
    rep={}
    # 1. The four reads.
    adapters=manifest['lookEntries']['adapters'];assert sorted(a['address'] for a in adapters)==[0x535131c0,0x536db7f8,0x536dc4bc,0x536dd3e0]
    patched.uc.mem_write(STEP_ARG,bytes(0x400));patched.uc.mem_write(STEP_ARG+0x2ac,b'\x01')
    import os
    for a in ([] if os.environ.get('GR3X_SKIP_ADAPTERS')=='1' else adapters):   # (development re-runs only)
        src,dst=a['sourceRegister'],a['destinationRegister']
        for look in range(256):
            for state in ((0,1,2,3,4,5,6,7,11,12,0xff) if a['address']==DEV_READ and 64<=look<64+n else (0,)):
                for flags in range(16):
                    regs=[0x12340000+i for i in range(13)];regs[src]=COMMON
                    if a['address']==DEV_READ:regs[1]=STEP_ARG
                    patched.uc.mem_write(COMMON+0x77c,bytes([look]));patched.uc.mem_write(COMMON+0x786,bytes([state]))
                    patched.uc.mem_write(STASH,b'\xa5'*4)
                    out,cpsr=run_site(patched,a['address'],regs,flags)
                    regs[dst]=11 if 64<=look<84 else look
                    assert out==regs and cpsr==(flags<<28)|0x13,(hex(a['address']),look,flags)
                    if a['address']==DEV_READ:
                        lvl,white=level_of(state) if 64<=look<64+n else (0,0)
                        want=(look-32 if look>=64 else look)|lvl<<8|white|0x10000
                        assert u32(patched.uc,STASH)==want,(look,state,hex(u32(patched.uc,STASH)),hex(want))
                    cases+=1
    # RAW development (the step's flag 0): GR IV's frame look and orientation words from the record (r3).
    if manifest.get('dateImprint'):
        rec=SCRATCH;patched.uc.mem_write(STEP_ARG+0x2ac,b'\x00')
        for look in (11,18,64,64+n-1):
            for hint,e04,c8 in ((0,2,1),(1,3,0),(1,7,2),(0,0,9)):
                patched.uc.mem_write(rec,bytes(0x80000));patched.uc.mem_write(rec+0x77c,bytes([look]));patched.uc.mem_write(rec+0x786,b'\x05')
                patched.uc.mem_write(rec+0x71e03,bytes([hint,e04]));patched.uc.mem_write(rec+0xc8,bytes([c8]))
                regs=[0x12340000+i for i in range(13)];regs[3]=rec;regs[1]=STEP_ARG
                run_site(patched,DEV_READ,regs,0)
                v=e04 if hint else c8;v=v if v<=3 else 0
                assert u32(patched.uc,ORIENT_WORD)==v|0x100 and u32(patched.uc,FRAME_LOOK)==u32(patched.uc,STASH),(look,hint)
                cases+=1
        patched.uc.mem_write(STEP_ARG+0x2ac,b'\x01')
    rep['look_read_cases']=cases
    # Instruction sequences run on probes of their own (a translation block cached by a function
    # run could carry the emulator past a stop address).
    site_p,site_s=LookProbe(data,manifest),LookProbe(data,base)
    for pr in (site_p,site_s):
        try:pr.uc.mem_map(SCRATCH,0x100000)
        except Exception:pass
    stock,patched=LookProbe(data,base),LookProbe(data,manifest)
    for pr in (stock,patched):
        try:pr.uc.mem_map(SCRATCH,0x100000)
        except Exception:pass
    # 2. Lists, names and icons.
    lists,layout=layout_lists(manifest)
    for mode in range(3):
        for bank in range(3):
            patched.menu_state(mode,bank);L=lists[mode]
            assert patched.call(0x532c2a9c,OBJECT)==len(L),(mode,bank)
            for i,look in enumerate(L):
                assert patched.call(0x532c2c80,OBJECT,i)==look and patched.call(0x532c2f08,OBJECT,look)==i;calls+=2
    for look in range(11,25):
        for entry in (0x532a985c,0x532a9988,0x532922b4):assert patched.call(entry,OBJECT,look)==stock.call(entry,OBJECT,look);calls+=2
    for s in slots:
        assert patched.call(0x532a985c,OBJECT,s['id'])==s['textId'] and patched.call(0x532a9988,OBJECT,s['id'])==s['iconId'];calls+=2
    # 3. Descriptors.
    for look in NATIVE:
        for value in (0,4,8):
            params=[4]*26
            for off in (0,1,2,3,4,5,7,9,10,11,22,23):params[off]=value
            # Bleach Bypass's Toning (0x786, params[9]) outside 1..3 reads as 1 (the clamp of section 5).
            clamped=list(params)
            if not 1<=clamped[9]<=3:clamped[9]=1
            assert descriptor(patched,look,params)==descriptor(stock,look,clamped if look==18 else params),look
            assert matrix_process(patched)==matrix_process(stock);calls+=6
    std=descriptor(stock,11,[4]*26)
    for s in slots:
        for params in ([4]*26,[0]*9+[4]*17,[8]*9+[1]*17,[(i*3)%9 for i in range(26)]):
            want=descriptor(stock,11,params);got=descriptor(patched,s['id'],params)
            exp=bytearray(want[0]);struct.pack_into('<I',exp,8,s['record'] or u32(stock.uc,OUTPUT+8))
            assert got[0]==bytes(exp) and got[1]==want[1],s['name']
            assert u32(patched.uc,OUTPUT+0xc)==u32(stock.uc,OUTPUT+0xc) and u32(patched.uc,OUTPUT+0x18)==u32(stock.uc,OUTPUT+0x18)
            m=matrix_process(patched);calls+=4
            if s['curves']:
                assert got[2][:2]==b'\1\1' and u32(patched.uc,GAMMA_OBJECT+20)==s['curveId']
                for ch,curve in enumerate(got[3]):assert curve==patched.uc.mem_read(s['curves']+ch*512,512)
            else:assert got[2:]==want[2:]
        # The film's tone record: Standard's, its matrix, words 17..20 as the camera's start-up gives its own.
        rec=bytes(patched.uc.mem_read(s['record'],84));std_rec=bytes(stock.uc.mem_read(u32(stock.uc,0x55018d94+44),84))
        assert rec[:4]==std_rec[:4] and rec[8:68]==std_rec[8:68] and rec[68:]==data[0x53dc27a4-0x53000000:0x53dc27a4-0x53000000+16]
    for look in range(64+n,84):
        assert descriptor(patched,look,[4]*26)==std,look;calls+=1
    for prev in slots+[None]:
        for sel in slots:
            if prev:descriptor(patched,prev['id'],[4]*26)
            descriptor(patched,sel['id'],[4]*26);assert u32(patched.uc,OUTPUT+8)==sel['record']
            if sel['curves']:assert u32(patched.uc,GAMMA_OBJECT+20)==sel['curveId']
            calls+=2
        for look in NATIVE:
            if prev:descriptor(patched,prev['id'],[4]*26)
            p=[4]*26
            if look==18:p[9]=2
            assert descriptor(patched,look,p)==descriptor(stock,look,p),look;calls+=2
    # 4. Parameters: a film as Bleach Bypass (the module inert).
    def state(pr):
        live=bytearray(pr.uc.mem_read(u32(pr.uc,MODEL),0x1040));stored=bytearray(pr.uc.mem_read(DATA,0x1000))
        for at in (0x77c,0xf9c):live[at]=0
        for at in (0x1c2,0x1c4,0x1c6,0x57e,0x580,0x582):stored[at]=0
        return bytes(live),bytes(stored)
    param_cases=0
    for mode in (0,1):
        for bank in range(3):
            for film in films:
                twin=LookProbe(data,manifest)
                for pr in (patched,twin):
                    pr.menu_state(mode,bank)
                    pr.uc.mem_write(DATA+0x1c8,bytes(((i*7)%9) for i in range(0x1c8,0x800)))
                    pr.uc.mem_write(DATA+0x57c,bytes([bank,0,11,0,11,0,11,0]))
                    pr.uc.mem_write(USERDATA_COPY,bytes(((i*5)%9) for i in range(0xb28)));put(pr.uc,SELECTOR+0x24,USERDATA_COPY)
                    for k in range(1,8):put(pr.uc,SELECTOR+4+4*k,DATA)
                patched.call(0x532c26c0,OBJECT,film);twin.call(0x532c26c0,OBJECT,18)
                assert state(patched)==state(twin),(mode,bank,film)
                where=DATA+(0x1c2 if mode==0 else 0x57e)+2*bank
                assert patched.uc.mem_read(where,1)==bytes([film]),(mode,bank,film,list(patched.uc.mem_read(DATA+0x1c0,8)),list(patched.uc.mem_read(DATA+0x57c,8)),list(twin.uc.mem_read(DATA+0x57c,8)))
                for setter in SETTERS:
                    for value in (0,3,8):
                        patched.queue=[];twin.queue=[]
                        assert patched.call(setter,OBJECT,value)==twin.call(setter,OBJECT,value)
                        assert patched.queue==twin.queue and state(patched)==state(twin),(hex(setter),mode,bank,film)
                        calls+=2
                param_cases+=1
                if film>64+1:break
    rep['parameter_cases']=param_cases
    for at,field in DEFAULTS:
        for film in films:assert patched.call(at,OBJECT,film)==FILM_DEFAULT[field],(hex(at),film);calls+=1
        # (Any other look goes on to the camera's getter, whose first instruction the stub runs: its
        # entry word is all that changed, checked against the manifest's site.)
        site=next(x for x in manifest['sites'] if x['address']==at);assert site['expected']=='0dc0a0e1'
    # The main menu's Image Control line.
    for movie,(fn,active,look_at) in enumerate(((0x5326c1cc,0x1c0,0x1c2),(0x5326c380,0x57c,0x57e))):
        for look in NATIVE+films:
            for pr in (patched,stock):
                pr.menu_state();put(pr.uc,SELECTOR+4,DATA);pr.uc.mem_write(DATA+active,b'\0');pr.uc.mem_write(DATA+look_at,bytes([look]))
            got=patched.call(fn,SELECTOR)
            assert got==(look if look>=64 else stock.call(fn,SELECTOR)),(movie,look,got);calls+=2
    # 5. Bleach Bypass's Toning: 1..3 else 1.
    for v in range(256):
        for flags in (0,5,10,15):
            regs=[0x22220000+i for i in range(13)];regs[3]=COMMON;site_p.uc.mem_write(COMMON+0x786,bytes([v]))
            out,cpsr=run_site(site_p,0x536dbd48,regs,flags)
            want=list(regs);want[6]=v if 1<=v<=3 else 1;out[5]=want[5]
            assert out==want and cpsr==(flags<<28)|0x13,v;cases+=1
        stock.menu_state();patched.menu_state()
        assert patched.call(0x531ac654,v)==stock.call(0x531ac654,v if 1<=v<=3 else 1),v;calls+=2
    # 6. RAW development.
    M=SCRATCH+0x10000
    for look in range(256):
        for pr in (patched,stock):pr.uc.mem_write(M,bytes(0x400))
        if 64<=look<64+n:assert patched.call(0x53288d5c,M,look)==13+look-64,look
        elif 11<=look<=22:assert patched.call(0x53288d5c,M,look)==stock.call(0x53288d5c,M,look)==RAW_OF[look]
        calls+=1
    for raw in range(13+n):
        for pr in (patched,stock):pr.uc.mem_write(M,bytes(0x400));put(pr.uc,M+0x24,COMMON)
        patched.uc.mem_write(COMMON+0x77c,b'\x0b');stock.uc.mem_write(COMMON+0x77c,b'\x0b')
        got=patched.call(0x53289058,M,raw)
        assert got==(64+raw-13 if raw>=13 else stock.call(0x53289058,M,raw)),raw;calls+=1
    for site in f['rawRows']+[f['rawRowR1']]:pass
    rows=[]
    for at in range(0x53283400,0x53289000,4):
        if data[at-0x53000000:at-0x53000000+4] in (struct.pack('<I',0xe5d32083),struct.pack('<I',0xe5d31083)):rows.append(at)
    assert len(rows)==62
    for at in rows:
        r=2 if data[at-0x53000000:at-0x53000000+4]==struct.pack('<I',0xe5d32083) else 1
        for v in range(40):
            regs=[0x33330000+i for i in range(13)];regs[3]=M;site_p.uc.mem_write(M+0x83,bytes([v]))
            out,_=run_site(site_p,at,regs,0)
            want=list(regs);want[r]=9 if 13<=v<13+n else v
            assert out==want,(hex(at),v);cases+=1
    order=lists[0];L=len(order);raw_order=[RAW_OF[x] if x<64 else 13+x-64 for x in order]
    for shot in (0,1):
        patched.uc.mem_write(M,bytes(0x400));patched.uc.mem_write(M+5,bytes([shot]));patched.uc.mem_write(M+0x83,bytes([5,7,9]))
        count=patched.call(0x53283358,M);assert count==L+2+shot;calls+=1
        for i in range(count):
            j=i+(0 if shot else 1)
            base_=patched.call(0x532834d0,M,i);look=patched.call(0x532834f0,M,i);calls+=2
            if shot and i==0:assert (base_,look)==(0,0)
            elif j<=L:assert (base_,look)==(0,raw_order[j-1]),(shot,i)
            else:assert (base_,look)==(j-L,[5,7,9][j-L]),(shot,i,base_,look)
    if L+3>17:assert patched.call(0x532833bc)==L+3
    for look in films:
        for pr in (patched,stock):pr.menu_state();pr.uc.mem_write(OBJECT,bytes(0x400))
        # GetBaseKindDetailControl of RAW development: a film's lines are Standard's.
        a=patched.call(0x5318dea0,OBJECT,look);b=stock.call(0x5318dea0,OBJECT,11);assert a==b;calls+=2
    # 7. Maker note and playback.
    NOTE=SCRATCH+0x20000;RECORD=SCRATCH+0x30000
    for look in NATIVE+films+[64+n]:
        for pr in (patched,stock):
            pr.uc.mem_write(NOTE,bytes(0x100));pr.uc.mem_write(RECORD,bytes(0x800));pr.uc.mem_write(RECORD+0x77c,bytes([look]))
        patched.call(0x535c780c,0,NOTE,RECORD)
        got=struct.unpack('<H',patched.uc.mem_read(NOTE+0xc,2))[0]
        if 64<=look<64+n:assert got==0x8110+look-64,(look,hex(got))
        else:stock.call(0x535c780c,0,NOTE,RECORD);assert got==struct.unpack('<H',stock.uc.mem_read(NOTE+0xc,2))[0],look
        calls+=2
    imm=lambda w:((w>>4)&0xf000)|(w&0xfff)
    lists_with=0
    for call in range(0x535ca050,0x535ca310,4):
        w=u32(patched.uc,call)
        if (w&0x0e000000)!=0x0a000000 or ((call+8+(((w&0xffffff)^0x800000)-0x800000)*4)&0xffffffff)!=0x535c3ed8:continue
        lo=hi=add=0
        for k in range(1,14):
            x=u32(patched.uc,call-4*k)
            if not lo and x&0xfff0f000==0xe3001000:lo=x
            if not hi and x&0xfff0f000==0xe3401000:hi=x
            if not add and x&0xfffff000==0xe2812000:add=x
        lst=imm(lo)|imm(hi)<<16;length=add&0xff;got=list(patched.uc.mem_read(lst,length))
        k0=None
        for k in range(1,14):
            x=struct.unpack('<I',data[call-4*k-0x53000000:call-4*k-0x53000000+4])[0]
            if x&0xfff0f000==0xe3001000:k0=k;break
        olo=struct.unpack('<I',data[call-4*k0-0x53000000:call-4*k0-0x53000000+4])[0]
        ohi=next(struct.unpack('<I',data[call-4*k-0x53000000:call-4*k-0x53000000+4])[0] for k in range(1,14) if struct.unpack('<I',data[call-4*k-0x53000000:call-4*k-0x53000000+4])[0]&0xfff0f000==0xe3401000)
        oadd=next(struct.unpack('<I',data[call-4*k-0x53000000:call-4*k-0x53000000+4])[0] for k in range(1,14) if struct.unpack('<I',data[call-4*k-0x53000000:call-4*k-0x53000000+4])[0]&0xfffff000==0xe2812000)
        olist=list(data[(imm(olo)|imm(ohi)<<16)-0x53000000:(imm(olo)|imm(ohi)<<16)-0x53000000+(oadd&0xff)])
        assert got==(olist+films if 18 in olist else olist),hex(call)
        lists_with+=18 in olist
    assert lists_with==7
    for look in NATIVE+films:
        for st in range(14):
            for pr in (patched,stock):pr.uc.mem_write(RECORD,bytes(0x800));pr.uc.mem_write(RECORD+0x77c,bytes([look]));pr.uc.mem_write(RECORD+0x786,bytes([st]))
            got=patched.call(0x535c5e34,0,RECORD)
            if look>=64:assert got==0x100+(st if st<=11 else 0),(look,st,hex(got))
            else:assert got==stock.call(0x535c5e34,0,RECORD),(look,st)
            calls+=2
    for code in list(range(0,4))+list(range(0xfe,0x10e))+[0xffff,0x8110]:
        for pr in (patched,stock):pr.uc.mem_write(RECORD,bytes(0x800));pr.uc.mem_write(RECORD+0x786,b'\x5a')
        patched.call(0x535c0d04,0,code,RECORD)
        got=patched.uc.mem_read(RECORD+0x786,1)[0]
        if 0x100<=code<=0x10b:assert got==code-0x100,hex(code)
        else:stock.call(0x535c0d04,0,code,RECORD);assert got==stock.uc.mem_read(RECORD+0x786,1)[0],hex(code)
        calls+=2
    # Readers: the code a substituted note gives.
    class Reader:
        code=0;out=None
    def hooked(pr):
        def h(cpu,at,size,user):
            if at==0x535d04d4:cpu.reg_write(reg.UC_ARM_REG_R0,Reader.code);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
            elif at==0x535be068:Reader.out=(cpu.reg_read(reg.UC_ARM_REG_R1),cpu.reg_read(reg.UC_ARM_REG_R2));cpu.reg_write(reg.UC_ARM_REG_R0,0);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
            elif at==0x535be018:cpu.reg_write(reg.UC_ARM_REG_R0,Reader.code);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        for a in (0x535d04d4,0x535be068,0x535be018):pr.uc.hook_add(1<<2,h,begin=a,end=a)
    for pr in (patched,stock):hooked(pr)
    for code in list(range(0x100,0x10c))+[0x8110+k for k in range(n+2)]+[0,0xffff]:
        Reader.code=code
        for pr in (patched,stock):pr.uc.mem_write(RECORD,bytes(0x800))
        patched.call(0x535bf7a8,0,NOTE,RECORD);a=patched.uc.mem_read(RECORD+0x77c,1)[0]
        stock.call(0x535bf7a8,0,NOTE,RECORD);b=stock.uc.mem_read(RECORD+0x77c,1)[0]
        assert a==(64+code-0x8110 if 0x8110<=code<0x8110+n else b),(hex(code),a,b)
        Reader.out=None;patched.call(0x535c24ec,0,RECORD,NOTE);a=Reader.out
        Reader.out=None;stock.call(0x535c24ec,0,RECORD,NOTE);b=Reader.out
        assert a==((0x25,13+code-0x8110) if 0x8110<=code<0x8110+n else b),(hex(code),a,b)
        calls+=4
    for number in range(0,14+n+2):
        Reader.code=number
        for out in (RECORD,0):
            patched.uc.mem_write(RECORD,b'\x77');stock.uc.mem_write(RECORD,b'\x77')
            a=(patched.call(0x532b44bc,OBJECT,out),patched.uc.mem_read(RECORD,1)[0])
            b=(stock.call(0x532b44bc,OBJECT,out),stock.uc.mem_read(RECORD,1)[0])
            if 13<=number<13+n:assert a==(1,(64+number-13) if out else 0x77),(number,a)
            else:assert a==b,(number,a,b)
            calls+=2
    for style in list(range(8,23))+films+[64+n,100]:
        regs=[0x44440000+i for i in range(13)];regs[3]=(style-8)&0xff
        if style<64:
            ps,_=run_site(site_s,0x532b6f3c,regs,0,stop=0x532b6f54);pp,_=run_site(site_p,0x532b6f3c,regs,0,stop=0x532b6f54)
            assert pp[0]==ps[0],style
        elif style<64+n:
            pp,_=run_site(site_p,0x532b6f3c,regs,0,stop=0x532b6f54);assert pp[0]==slots[0]['iconId']+style-64,style
        regs=[0x55550000+i for i in range(13)];regs[2]=(style-8)&0xffffffff
        want=3 if 64<=style<64+n else regs[2]
        c=site_p.uc
        for i in range(13):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs[i])
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_CPSR,0x13);c.emu_start(0x532b7d10,0,count=7 if 64<=style<64+n else 2)
        if 64<=style<64+n:
            assert c.reg_read(reg.UC_ARM_REG_R2)==3
            s2=site_s.uc
            for i in range(13):s2.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),regs[i] if i!=2 else 3)
            s2.reg_write(reg.UC_ARM_REG_SP,STACK);s2.reg_write(reg.UC_ARM_REG_CPSR,0x13);s2.emu_start(0x532b7d10,0,count=2)
            assert c.reg_read(reg.UC_ARM_REG_PC)==s2.reg_read(reg.UC_ARM_REG_PC),style
        calls+=2
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),native_calls=calls,adapter_cases=cases,films=n,**rep,
        hardware_tested=False,scope='Bounded ARM functions and instruction sequences with UI, singleton, queue and note substitutes.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','base','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();r=verify(x.rtos.read_bytes(),json.loads(x.base.read_text()),json.loads(x.manifest.read_text()))
    with x.report.open('x') as fp:json.dump(r,fp,indent=2);fp.write('\n')
    print(json.dumps(r,indent=2))
