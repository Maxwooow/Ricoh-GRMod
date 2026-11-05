"""Round 8 of the date imprint on GR III 2.10 / IIIx 1.60 (as GR Mod 0.8.4; core/src/fw/gr3x/datestamp.ts),
run from datestamp_probe.py on a round 8 build:

  - texts and icons: Follow Orientation and the two styles with the look's name in all 21 rows, four
    40x40 style icons;
  - submenu: record 18 has three lines (On/Off, Style, Follow Orientation) and equals Instant Review's
    three-line record (10) but for the title, the texts, the ids and the value-draw functions; the
    factory and key map give Horizon's id for the third list's id (0x020001a5), whose record is 120;
    the Style list has four values ('26 10 08, 2026.10.08 17:34 and both + the name);
  - the handlers on the setting byte (bit 0 on, 1 long, 2 Follow Orientation off, 3 the name), for
    every stored value 0..255 (anything above 15 counts as 0 and is stored back as 0): each list has
    exactly one current value; setting a list's value changes its own bits only; the lines show the
    values' icons;
  - the exposure hook (SetShootingInfoResultBeforeExpose, 0x534322d8): the camera's direction of the
    live shooting record (singleton 0x553458b0 -> +0x518 -> record + 0xc8) as value | 0x80 in the
    orientation byte (1..3 kept, else 0; nothing written when a pointer is missing, outside RAM or
    not word aligned), the stash's look | 0x8000 (0 without a valid stash) in the frame-look halfword;
    the End Screen mode byte untouched, every register kept, then the function's own first
    instruction;
  - the development step's look read (0x536db7f8): in RAW development (the step's flag, argument +
    0x82ac, is 0) also the orientation by the EXIF writer's rule (byte 0x71e04 when byte 0x71e03 of
    the record is set, else byte 0xc8; 1..3 kept, else 0) and the stash's look as the frame look;
    while shooting neither; the stash and every register but r2 (the site's own load) and the flags
    as before;
  - the picture side: for settings, orientations, frame looks and stash looks, the pictures equal
    those GR IV's 0.8.4 module (aspect/datestamp-code.ts, the same source) draws with the same
    setting, clock, look word, orientation word, frame-look word and name table (the GR III bytes
    translated to GR IV's words), on the main picture, the screennail and the thumbnail.
"""
import base64,re,struct
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_ARM,UC_HOOK_CODE
from unicorn import arm_const as reg
from native_probe import STACK,STOP

ROOT=Path(__file__).resolve().parents[2]
NEW,HORIZON,D_RANGE=0x020001a0,0x0200007d,0x020000ba
SWITCH,STYLE,ORIENT=0x020001a1,0x020001a2,0x020001a5
FACTORY,KEYREAD=0x5316f3b8,0x53221a4c
SETCUR,SUB_SETCUR,SUB_BYTE=0x531b9640,0x531c5950,0x174
TABLE,REC_SIZE=0x53b3c6c0,0x40
SUB_TABLE,SUB_REC=0x53b3fb10,0x64
TWO_ICONS,SUB_ICON,TITLE,LIST_ITEM=0x5339df08,0x533a6a70,0x5339dc70,0x5339e8b0
BEFORE=0x534322d8
SINGLETON=0x553458b0
STASH,MODE,ORIENT_BYTE,FRAME=0x55804378,0x5580437c,0x5580437d,0x5580437e
DEVELOP=0x536db7f8
# Round 10 (core/src/fw/gr3x/round10.ts, GR IV's words): ORIENT_WORD (direction | 0x100) and FRAME_LOOK
# (the stash's word as it is), one word each; the End Screen mode word untouched.
ORIENT_WORD,FRAME_WORD=0x55804380,0x55804384
EXECUTE=0x535047d4
CACHE,INVALIDATE,CLEAN,PLATFORM,GET_TIME=0x536bbc30,0x536bbcc0,0x536bbcac,0x536bd838,0x536b6510

def js_strings(name):
    """The strings of a `readonly string[]` constant of datestamp-menu.ts (single or double quoted)."""
    src=(ROOT/'core/src/fw/aspect/datestamp-menu.ts').read_text()
    body=re.search(name+r": readonly string\[\] = \[(.*?)\];",src,re.S).group(1)
    return [a if a or not b else b for a,b in re.findall(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"",body)]
ORIENT_NAMES,NAME_WORDS=js_strings('DATESTAMP_ORIENT_NAMES'),js_strings('DATESTAMP_NAME_WORDS')
assert len(ORIENT_NAMES)==len(NAME_WORDS)==21 and "Suivre l'orientation" in ORIENT_NAMES

def u32(c,a):return struct.unpack('<I',bytes(c.mem_read(a,4)))[0]
def movw(r,v,top=False):return (0xe3400000 if top else 0xe3000000)|(r<<12)|((v>>12)&15)<<16|(v&0xfff)

def texts(p,manifest,rows,short,long_):
    c=p.uc;ids=manifest['dateImprint'];roots=manifest['catalogs']['textRoots']
    for row,lang in enumerate(rows):
        for tid,text in ((ids['orient'],ORIENT_NAMES[lang]),(ids['shortName'],f'{short} + {NAME_WORDS[lang]}'),(ids['longName'],f'{long_} + {NAME_WORDS[lang]}')):
            rec=u32(c,u32(c,roots+row*4)+tid*4);units,lines,_,at=struct.unpack('<BBHI',bytes(c.mem_read(rec,8)))
            assert (units,lines)==(len(text)+1,1) and bytes(c.mem_read(at,units*2)).decode('utf-16le')==text+'\0',(row,tid,text)
    icons=bytes.fromhex(manifest['iconAddition']['bytes']);origin=manifest['iconAddition']['originalLength']
    offs=[]
    for k in ('iconShort','iconLong','iconShortName','iconLongName'):
        w,h,o=struct.unpack('<HHI',bytes(c.mem_read(u32(c,manifest['catalogs']['iconRoot']+ids[k]*4),8)))
        assert (w,h)==(40,40) and o*4>=origin and o*4-origin+6400<=len(icons);offs.append(o)
    assert len(set(offs))==4 and len({icons[o*4-origin:o*4-origin+6400] for o in offs})==4
    return 3*21

def submenu(p,data,manifest,official):
    c=p.uc;e=manifest['entries'];ids=manifest['dateImprint'];calls=0
    orig=lambda a,n:data[a-0x53000000:a-0x53000000+n]
    pics=manifest.get('pictures');endscreen=bool(pics) and pics.get('form')=='submenu'
    if endscreen:pics=None
    OFF,ON=ids['iconOff'],ids['iconOn']
    assert (OFF,ON)==(296,297)
    # Factory and key map.
    mapped={NEW:D_RANGE,SWITCH:HORIZON,STYLE:HORIZON,ORIENT:HORIZON,**({NEW+3:HORIZON} if pics else {})}
    if endscreen:mapped.update({NEW+3:D_RANGE,NEW+4:0x020000ad})
    seen=sorted({x[1] for x in official}|{HORIZON,D_RANGE,0x0200013a,0x0200013b,NEW,SWITCH,STYLE,NEW+3,NEW+4,ORIENT,ORIENT+1,0x08000000})
    for cid in seen:
        want=mapped.get(cid,cid)
        c.reg_write(reg.UC_ARM_REG_R0,0x62056000);c.reg_write(reg.UC_ARM_REG_R1,cid);c.reg_write(reg.UC_ARM_REG_SP,STACK)
        c.emu_start(FACTORY,FACTORY+4,count=120)
        assert c.reg_read(reg.UC_ARM_REG_R1)==want and c.reg_read(reg.UC_ARM_REG_R3)==0x13b,hex(cid)
        assert c.reg_read(reg.UC_ARM_REG_R0)==0x62056000 and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        c.mem_write(0x62057000,struct.pack('<I',cid))
        assert p.call(e['dateKeys'],0x62057000)==want;calls+=1
    obj=0x62059000
    lists={SWITCH:118,STYLE:119,ORIENT:120,HORIZON:44,**({NEW+3:121} if pics else {})}
    for cid,want in lists.items():
        c.mem_write(obj,bytes(0x200));p.call(SETCUR,obj,cid);calls+=1
        assert c.mem_read(obj+0x198,1)[0]==want,(hex(cid),c.mem_read(obj+0x198,1)[0])
    for cid,want in ((NEW,18),(D_RANGE,6)):
        c.mem_write(obj,bytes(0x200));p.call(SUB_SETCUR,obj,cid);calls+=1
        assert c.mem_read(obj+SUB_BYTE,1)[0]==want
    # List records 118..120.
    table=e['dateListTable'];assert bytes(c.mem_read(table,118*REC_SIZE))==orig(TABLE,118*REC_SIZE)
    horizon=struct.unpack('<16I',orig(TABLE+44*REC_SIZE,REC_SIZE))
    for k,(title,cnt,draw,st,cur) in enumerate(((ids['onOff'],e['dateCount'],e['dateDrawOnOff'],e['dateSetOnOff'],e['dateIsOnOff']),
            (ids['style'],e['dateStyleCount'],e['dateDrawStyle'],e['dateSetStyle'],e['dateIsStyle']),
            (ids['orient'],e['dateCount'],e['dateDrawOnOff'],e['dateSetOrient'],e['dateIsOrient']))):
        f=struct.unpack('<16I',bytes(c.mem_read(table+(118+k)*REC_SIZE,REC_SIZE)))
        assert f[0]==horizon[0]==0x10000 and f[1]==title and f[2:10]==(cnt,0,draw,0,st,0,cur,0) and not any(f[10:])
    assert p.call(e['dateCount'],0)==2 and p.call(e['dateStyleCount'],0)==4;calls+=2
    styles=((ids['iconShort'],ids['short']),(ids['iconLong'],ids['long']),(ids['iconShortName'],ids['shortName']),(ids['iconLongName'],ids['longName']))
    for draw,values in ((e['dateDrawOnOff'],((OFF,2),(ON,1))),(e['dateDrawStyle'],styles)):
        for v,(icon,text) in enumerate(values):
            p.ui=[];p.call(draw,0x62056000,0x6205a000,v);calls+=1
            assert p.ui==[(LIST_ITEM,0x6205a000,icon,text)],(v,p.ui)
    for bad in (4,5,0xffffffff):p.ui=[];p.call(e['dateDrawStyle'],0x62056000,0x6205a000,bad);assert p.ui==[];calls+=1
    # Submenu record 18: three lines, as Instant Review's (record 10).
    st=e['submenuTable'];assert bytes(c.mem_read(st,18*SUB_REC))==orig(SUB_TABLE,18*SUB_REC)
    rec=bytes(c.mem_read(st+18*SUB_REC,SUB_REC));ref=orig(SUB_TABLE+10*SUB_REC,SUB_REC);drange=orig(SUB_TABLE+6*SUB_REC,SUB_REC)
    want=bytearray(drange);want[6]=3
    struct.pack_into('<H',want,2,ids['name']);struct.pack_into('<4H',want,8,ids['onOff'],ids['style'],ids['orient'],0)
    struct.pack_into('<4I',want,0x14,SWITCH,STYLE,ORIENT,0x10000000);struct.pack_into('<I',want,0x30,540)
    struct.pack_into('<6I',want,0x3c,e['dateLineOnOff'],0,e['dateLineStyle'],0,e['dateLineOrient'],0)
    assert rec==bytes(want)
    own={2,3,*range(8,14),*range(0x14,0x20),*range(0x3c,0x48),*range(0x4c,0x50)}
    assert ref[6]==3 and all(rec[i]==ref[i] for i in range(SUB_REC) if i not in own),[hex(i) for i in range(SUB_REC) if i not in own and rec[i]!=ref[i]]
    assert struct.unpack_from('<3I',rec,0x28)==(540,540,540)
    # Every stored value.
    def style_icon(v):return {0:ids['iconShort'],2:ids['iconLong'],8:ids['iconShortName'],10:ids['iconLongName']}[v&10]
    norms={}
    for stored in range(256):
        norm=stored if stored<=15 else 0
        p.setting(stored);sw=[p.call(e['dateIsOnOff'],0,v) for v in range(3)];calls+=3
        assert sw==[int(norm&1==0),int(norm&1==1),0] and p.byte()==norm,(stored,sw)
        p.setting(stored);sy=[p.call(e['dateIsStyle'],0,v) for v in range(5)];calls+=5
        assert sy==[int(((norm>>1)&1)|((norm>>2)&2)==v) for v in range(4)]+[0] and p.byte()==norm,(stored,sy)
        p.setting(stored);so=[p.call(e['dateIsOrient'],0,v) for v in range(3)];calls+=3
        assert so==[int(norm&4!=0),int(norm&4==0),0] and p.byte()==norm,(stored,so)
        on=ON if norm&1 else OFF
        p.ui=[];p.setting(stored);p.call(e['dateLine'],0x62056000,0x6205b000);calls+=1
        assert p.ui==[(TWO_ICONS,0x6205b000,on,style_icon(norm)),(TITLE,0x6205b000,ids['name'],ids['name'])],(stored,p.ui)
        for line,icon in ((e['dateLineOnOff'],on),(e['dateLineStyle'],style_icon(norm)),(e['dateLineOrient'],OFF if norm&4 else ON)):
            p.ui=[];p.setting(stored);p.call(line,0x62056000,0x6205b000);calls+=1
            assert [u[:3] for u in p.ui]==[(SUB_ICON,0x6205b000,icon)],(stored,p.ui)
        norms[stored]=norm
    # Setting a list's value changes its own bits only; past the list nothing; a stray value is reset first.
    for start in range(16):
        for v in range(2):
            p.setting(start);p.call(e['dateSetOnOff'],0,v);assert p.byte()==(start&~1)|v;calls+=1
            p.setting(start);p.call(e['dateSetOrient'],0,v);assert p.byte()==(start&~4)|(0 if v else 4);calls+=1
        for v in range(4):
            p.setting(start);p.call(e['dateSetStyle'],0,v);assert p.byte()==(start&5)|((v&1)<<1)|((v&2)<<2);calls+=1
        for bad in (4,0xffffffff):
            p.setting(start);p.call(e['dateSetStyle'],0,bad);assert p.byte()==start;calls+=1
        for bad in (2,0xffffffff):
            p.setting(start);p.call(e['dateSetOnOff'],0,bad);p.call(e['dateSetOrient'],0,bad);assert p.byte()==start;calls+=2
    for stray in (16,0x55,0xff):
        p.setting(stray);p.call(e['dateSetStyle'],0,3);assert p.byte()==10;calls+=1
        p.setting(stray);p.call(e['dateSetOrient'],0,0);assert p.byte()==4;calls+=1
    p.setting(13,pointer=False)
    assert [p.call(e['dateIsOnOff'],0,v) for v in range(2)]==[1,0] and [p.call(e['dateIsStyle'],0,v) for v in range(4)]==[1,0,0,0] and [p.call(e['dateIsOrient'],0,v) for v in range(2)]==[0,1];calls+=8
    p.call(e['dateSetOnOff'],0,1);p.call(e['dateSetStyle'],0,3);p.call(e['dateSetOrient'],0,0);assert p.byte()==13;calls+=3
    return calls,{'record':18,'lists':[118,119,120],'style_values':4,'stored_values':256,'kept':sum(1 for k,v in norms.items() if k==v)}

def exposure(p,manifest):
    """The hook at the start of the exposure, in the patched image (every pointer case)."""
    c=p.uc;e=manifest['entries'];calls=0;cases={}
    assert u32(c,BEFORE)==(0xea000000|(((e['exposureOrientation']-(BEFORE+8))>>2)&0xffffff))
    OBJ,HOLD,REC=0x62060000,0x62061000,0x62062000
    r10=bool(manifest.get('round10'))
    def run(stash,chain,direction,mode=0x5a):
        c.mem_write(STASH,struct.pack('<I',stash));c.mem_write(MODE,struct.pack('<I',0xa5a5a500|mode))
        c.mem_write(ORIENT_WORD,b'\xa5'*8)
        c.mem_write(OBJ,bytes(0x600));c.mem_write(HOLD,bytes(8));c.mem_write(REC,bytes(0x100));c.mem_write(REC+0xc8,bytes([direction]))
        s,o,h=chain
        c.mem_write(SINGLETON,struct.pack('<I',s));c.mem_write(OBJ+0x518,struct.pack('<I',o));c.mem_write(HOLD,struct.pack('<I',h))
        regs=[0x7100+i for i in range(13)]
        for i,v in enumerate(regs):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP)
        c.emu_start(BEFORE,BEFORE+4,count=200)
        assert c.reg_read(reg.UC_ARM_REG_PC)==BEFORE+4
        out=[c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(12)]
        assert out==regs[:12] and c.reg_read(reg.UC_ARM_REG_SP)==STACK and c.reg_read(reg.UC_ARM_REG_R12)==STACK and c.reg_read(reg.UC_ARM_REG_LR)==STOP
        w=bytes(c.mem_read(MODE,4))
        assert w[0]==mode and u32(c,STASH)==stash
        if r10:
            assert w==bytes([mode])+b'\xa5'*3
            return u32(c,ORIENT_WORD),u32(c,FRAME_WORD)
        assert u32(c,ORIENT_WORD)==u32(c,FRAME_WORD)==0xa5a5a5a5
        return w[1],struct.unpack_from('<H',w,2)[0]
    good=(OBJ,HOLD,REC)
    if r10:
        for direction in list(range(8))+[0x80,0xff]:
            for stash in (0,11,0x10000|11,0x10000|32|(3<<8)|0x20000,0x10000|51,0x10000|255,0xffff,0xa5a5a5a5):
                ow,fw=run(stash,good,direction);calls+=1
                assert ow==(direction if direction<=3 else 0)|0x100 and fw==stash,(direction,hex(stash),hex(ow),hex(fw))
        bad=[(0,HOLD,REC),(0x3ffffffc,HOLD,REC),(0xc0000000,HOLD,REC),(OBJ+2,HOLD,REC),(OBJ,0,REC),(OBJ,HOLD+1,REC),(OBJ,0xfffffff0,REC),(OBJ,HOLD,0),(OBJ,HOLD,REC+3),(OBJ,HOLD,0x20000000)]
        for chain in bad:
            ow,fw=run(0x10000|12,chain,1);calls+=1
            assert (ow,fw)==(0xa5a5a5a5,0x10000|12),(chain,hex(ow),hex(fw))
        return calls,{'directions':10,'bad_chains':len(bad),'words':'GR IV (orientation | 0x100, frame look = stash word)'}
    for direction in list(range(8))+[0x80,0xff]:
        for stash in (0,11,0x10000|11,0x10000|32|(3<<8)|0x20000,0x10000|51,0x10000|255,0xffff):
            ob,fh=run(stash,good,direction);calls+=1
            assert ob==(direction if direction<=3 else 0)|0x80,(direction,ob)
            assert fh==(((stash&0xff)|0x8000) if stash&0x10000 else 0),(stash,fh)
    bad=[(0,HOLD,REC),(0x3ffffffc,HOLD,REC),(0xc0000000,HOLD,REC),(OBJ+2,HOLD,REC),(OBJ,0,REC),(OBJ,HOLD+1,REC),(OBJ,0xfffffff0,REC),(OBJ,HOLD,0),(OBJ,HOLD,REC+3),(OBJ,HOLD,0x20000000)]
    for chain in bad:
        ob,fh=run(0x10000|12,chain,1);calls+=1
        assert (ob,fh)==(0xa5,0x8000|12),(chain,ob,fh)   # the orientation byte is left as it was, the frame look written
    cases['directions']=10;cases['bad_chains']=len(bad)
    return calls,cases

def raw_words(p,manifest,films):
    """The development step's look read with the RAW development words (both hook forms)."""
    c=p.uc;calls=0
    ARG,REC=0x62064000,0x62070000
    c.mem_write(ARG,bytes(0x9000))
    r10=bool(manifest.get('round10'))
    def run(flag,look,e83,e84,dirb,frame0=0x1234,orient0=0x56,toning=0):
        c.mem_write(ARG+0x82ac,bytes([flag]));c.mem_write(REC+0x77c,bytes([look]));c.mem_write(REC+0x786,bytes([toning]))
        c.mem_write(REC+0x71e03,bytes([e83,e84]));c.mem_write(REC+0xc8,bytes([dirb]))
        c.mem_write(STASH,b'\xa5'*4);c.mem_write(MODE,bytes([0x3c,orient0])+struct.pack('<H',frame0))
        regs=[0x6000+i for i in range(13)];regs[1]=ARG+0x8000;regs[3]=REC
        for i,v in enumerate(regs):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        for flags in (0,0xf):
            for i,v in enumerate(regs):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
            c.mem_write(MODE,bytes([0x3c,orient0])+struct.pack('<H',frame0));c.mem_write(ORIENT_WORD,struct.pack('<2I',0x5600|orient0,0x12340000|frame0))
            c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP);c.reg_write(reg.UC_ARM_REG_CPSR,0x13|flags<<28)
            c.emu_start(DEVELOP,DEVELOP+4,count=400)
            out=[c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)]
            assert c.reg_read(reg.UC_ARM_REG_PC)==DEVELOP+4 and c.reg_read(reg.UC_ARM_REG_SP)==STACK and c.reg_read(reg.UC_ARM_REG_LR)==STOP
            assert out[:2]==regs[:2] and out[3:]==regs[3:] and c.reg_read(reg.UC_ARM_REG_CPSR)>>28==flags
        w=bytes(c.mem_read(MODE,4))
        if r10:
            assert w==bytes([0x3c,orient0])+struct.pack('<H',frame0)
            return out[2],u32(c,STASH),w[0],u32(c,ORIENT_WORD),u32(c,FRAME_WORD)
        assert (u32(c,ORIENT_WORD),u32(c,FRAME_WORD))==(0x5600|orient0,0x12340000|frame0)
        return out[2],u32(c,STASH),w[0],w[1],struct.unpack_from('<H',w,2)[0]
    if r10:
        for flag in (0,1,2):
            for look in [11,12,22,21,64,64+max(films-1,0),83,0,255]:
                for toning in (0,2,5):
                    for e83,e84,dirb in ((0,0,1),(0,9,3),(1,2,0),(1,3,1),(1,7,2),(0,0,5),(1,0,2)):
                        r2,stash,mode,ow,fw=run(flag,look,e83,e84,dirb,toning=toning);calls+=2
                        film=films and 64<=look<64+films
                        want_look=look-32 if films and look>=64 else look
                        level={0:0,2:3<<8,5:2<<8|0x20000}[toning] if film else 0
                        assert r2==(11 if films and 64<=look<84 else look) and stash==want_look|level|0x10000 and mode==0x3c,(flag,look,r2,hex(stash))
                        if flag==0:
                            v=e84 if e83 else dirb
                            assert ow==(v if v<=3 else 0)|0x100 and fw==stash,(flag,look,e83,e84,dirb,hex(ow),hex(fw))
                        else:assert (ow,fw)==(0x5656,0x12341234)
        return calls,{'cases':3*9*3*7,'words':'GR IV'}
    for flag in (0,1,2):
        for look in [11,12,22,21,64,64+max(films-1,0),83,0,255]:
            for e83,e84,dirb in ((0,0,1),(0,9,3),(1,2,0),(1,3,1),(1,7,2),(0,0,5),(1,0,2)):
                r2,stash,mode,ob,fh=run(flag,look,e83,e84,dirb);calls+=2
                film=films and 64<=look<84
                want_look=look-32 if films and look>=64 else look
                assert r2==(11 if film else look) and stash&0x1ffff==want_look|0x10000 and mode==0x3c,(flag,look,r2,hex(stash))
                if flag==0:
                    v=e84 if e83 else dirb
                    assert ob==(v if v<=3 else 0)|0x80 and fh==want_look|0x8000,(flag,look,e83,e84,dirb,ob,fh)
                else:assert (ob,fh)==(0x56,0x1234)
    return calls,{'cases':3*9*7}

class FastDate:
    """The date module behind its stage stub at native speed: only the cache, platform and clock functions substituted."""
    def __init__(s,p,clock):
        s.uc=Uc(UC_ARCH_ARM,UC_MODE_ARM);s.clock=clock
        for start,end,perms in p.uc.mem_regions():
            s.uc.mem_map(start,end-start+1);s.uc.mem_write(start,bytes(p.uc.mem_read(start,end-start+1)))
        s.uc.reg_write(reg.UC_ARM_REG_C1_C0_2,0xf00000);s.uc.reg_write(reg.UC_ARM_REG_FPEXC,0x40000000)
        for at in (CACHE,INVALIDATE,CLEAN,PLATFORM,GET_TIME):s.uc.hook_add(UC_HOOK_CODE,s._hook,begin=at,end=at)
    def _hook(s,cpu,at,size,user):
        if at==CACHE:cpu.reg_write(reg.UC_ARM_REG_R0,0x5536d1b4)
        elif at==PLATFORM:cpu.reg_write(reg.UC_ARM_REG_R0,s.plat)
        elif at==GET_TIME:cpu.mem_write(cpu.reg_read(reg.UC_ARM_REG_R1),struct.pack('<HBBBBB',*s.clock))
        cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))

def gr4_reference8(clock,low,setting,pics,look,orient,frame,names):
    """GR IV's 0.8.4 module (aspect/datestamp-code.ts) with its ctx words: look (word, table), orientation word, frame-look word, name table {look: glyphs}."""
    code=base64.b64decode(re.search(r"DATESTAMP_CODE = '([^']+)'",(ROOT/'core/src/fw/aspect/datestamp-code.ts').read_text()).group(1))
    mu=Uc(UC_ARCH_ARM,UC_MODE_ARM);ORG=0x10000;STUB=0x70000000
    mu.mem_map(ORG,0x10000);mu.mem_write(ORG,code);mu.mem_map(0x60000000,0x100000);mu.mem_map(STUB,0x100000)
    for base,size in ((0x63000000,0x1000000),(low,0x800000)):mu.mem_map(base,size)
    for i in range(5):mu.mem_write(STUB+i*16,struct.pack('<I',0xe12fff1e))
    mu.mem_write(STUB+5*16,struct.pack('<2I',0xe3a00000,0xe12fff1e))
    def hook(uc,addr,size,ud):
        i=(addr-STUB)//16
        if i in (0,3):uc.reg_write(reg.UC_ARM_REG_R0,0x70001000)
        if i==4:uc.mem_write(uc.reg_read(reg.UC_ARM_REG_R1),struct.pack('<HBBBBB',*clock))
    mu.hook_add(UC_HOOK_CODE,hook,begin=STUB,end=STUB+0x50)
    mu.mem_write(0x70001004,struct.pack('<I',0x70002000));mu.mem_write(0x70003000,bytes([setting]))
    # names: a table of 64 pointers at 0x70008000, the glyph runs after it
    table=[0]*64;at=0x70009000
    for k,g in names.items():
        mu.mem_write(at,struct.pack('<%dH'%(len(g)+1),len(g),*g));table[k]=at;at+=(2+2*len(g)+3)&~3
    mu.mem_write(0x70008000,struct.pack('<64I',*table))
    mu.mem_write(0x70007000,struct.pack('<I',look[0]));mu.mem_write(0x70007100,look[1])
    mu.mem_write(0x70007200,struct.pack('<2I',orient,frame))
    mu.mem_write(0x70004000,struct.pack('<12I',*(STUB+i*16 for i in range(5)),0x70003000,0x70007000,0x70007100,STUB+5*16,0x70007200,0x70007204,0x70008000))
    for a,b in pics['memory']:mu.mem_write(a,b)
    for i,d in enumerate(pics['descriptors']):mu.mem_write(0x70005000+i*0x20,d)
    mu.mem_write(0x70006000+0x3c,struct.pack('<4I',*(0x70005000+i*0x20 for i in range(4))))
    mu.reg_write(reg.UC_ARM_REG_SP,0x600f0000);mu.reg_write(reg.UC_ARM_REG_LR,0x70000ff0)
    mu.reg_write(reg.UC_ARM_REG_R0,0x70004000);mu.reg_write(reg.UC_ARM_REG_R1,0x70006000)
    mu.emu_start(ORG,0x70000ff0,count=2_000_000_000)
    return [bytes(mu.mem_read(a,len(b))) for a,b in pics['memory']]

def pictures8(p,manifest,pics,clock,low,REC,PTR,OFFSET,CFG,ARG,DESC,PLAT):
    """The module through its stage stub, against GR IV's 0.8.4 module."""
    e=manifest['entries'];c=p.uc;calls=0
    ctx=e['dateContext'];words=struct.unpack('<13I',bytes(c.mem_read(ctx,52)))
    r10=bool(manifest.get('round10'))
    assert words[5:8]==(PTR,OFFSET,STASH) and words[10:12]==((ORIENT_WORD,FRAME_WORD) if r10 else (ORIENT_BYTE,FRAME))
    mono=bytes(c.mem_read(words[8],64));assert p.call(words[9])==0;calls+=1
    # The name table: per look a run of glyphs, as GR IV's lookNameGlyphs makes them from the names.
    names={}
    for k in range(64):
        at=u32(c,words[12]+4*k)
        if at:n=struct.unpack('<H',bytes(c.mem_read(at,2)))[0];assert 1<=n<=24;names[k]=list(struct.unpack('<%dH'%n,bytes(c.mem_read(at+2,2*n))))
    want=manifest['dateImprint']['names'];assert sorted(names)==sorted(int(k) for k in want)
    f=FastDate(p,clock);f.plat=PLAT;u=f.uc
    base=[b for _,b in pics['memory']];results={}
    cases=[(1,0,0,0),(3,0,0,0),(9,0,0x10000|11,0),(11,0,0x10000|21,0),(9,0x81,0x10000|21,0x8000|32),(11,0x83,0x10000|12,0x8000|21),
           (11,0x82,0x10000|13,0x8000|13),(15,0x81,0x10000|21,0x8000|21),(13,0x83,0x10000|22,0x8000|51),(3,0x81,0x10000|11,0),(3,0x82,0,0),(3,0x83,0,0),
           (1,0x03,0,0x0020),(7,0x83,0,0),(5,0x81,0,0),(9,0x81,0,0x8000|63),(11,0x80,0x10000|255,0),(9,0,0x10000|11,0x8000|200),(0,0x81,0x10000|11,0x8000|11),(16,0x81,0,0),(0xff,0,0,0)]
    for setting,ob,stash,fh in cases:
        for a,b in pics['memory']:u.mem_write(a,b)
        for i,d in enumerate(pics['descriptors']):u.mem_write(DESC+i*0x20,d)
        cfg=bytearray(0x60);struct.pack_into('<4I',cfg,0x3c,*(DESC+i*0x20 for i in range(4)));u.mem_write(CFG,bytes(cfg))
        u.mem_write(ARG,struct.pack('<3I',0,0,CFG));u.mem_write(PLAT,struct.pack('<2I',0,PLAT+0x80))
        u.mem_write(REC,bytes(0xb28));u.mem_write(REC+OFFSET,bytes([setting]));u.mem_write(PTR,struct.pack('<I',REC))
        orient=((ob&3)|0x100) if ob&0x80 else ob
        frame=((fh&0xff)|0x10000) if fh&0x8000 else fh
        u.mem_write(STASH,struct.pack('<I',stash))
        if r10:u.mem_write(MODE,b'\x01\xa5\xa5\xa5');u.mem_write(ORIENT_WORD,struct.pack('<2I',orient,frame))
        else:u.mem_write(MODE,bytes([1,ob])+struct.pack('<H',fh))
        regs=[0x62e00000+i*0x100 for i in range(13)];regs[1]=ARG
        for i,v in enumerate(regs):u.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        u.reg_write(reg.UC_ARM_REG_SP,STACK);u.reg_write(reg.UC_ARM_REG_LR,STOP);u.reg_write(reg.UC_ARM_REG_CPSR,0x13)
        u.emu_start(e['dateStage'],EXECUTE+4,count=2_000_000_000);calls+=1
        assert u.reg_read(reg.UC_ARM_REG_PC)==EXECUTE+4 and [u.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(12)]==regs[:12]
        assert u.reg_read(reg.UC_ARM_REG_SP)==STACK and u.reg_read(reg.UC_ARM_REG_R12)==STACK
        got=[bytes(u.mem_read(a,len(b))) for a,b in pics['memory']]
        ref=gr4_reference8(clock,low,setting,pics,(stash,mono),orient,frame,names)
        assert got==ref,(setting,hex(ob),hex(stash),hex(fh))
        changed=[sum(a!=b for a,b in zip(x,y)) for x,y in zip(got,base)]
        assert (sum(changed)>0)==(setting<=15 and setting&1==1),(setting,changed)
        results[f'{setting}/{ob:#x}/{stash:#x}/{fh:#x}']=changed
    # With the look's name the main picture and the screennail get more ink than the date alone; the thumbnail the same.
    a,b=results['9/0x0/0x1000b/0x0'],results['1/0x0/0x0/0x0']
    assert a[0]>b[0] and a[2]>b[2] and a[4]==b[4],(a,b)
    return calls,{'cases':len(cases),'equal_to_gr4_0_8_4_module':True,'changed_bytes':results,'names':{str(k):len(v) for k,v in names.items()}}
