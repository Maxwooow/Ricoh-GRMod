"""Date imprint on GR III 2.10 / IIIx 1.60 (core/src/fw/gr3x/datestamp.ts), every patch of the
manifest installed:

  - texts and icons: the name in all 21 language rows, the two style names, two 40x40 icons in the
    added ICONBIN data;
  - still menu: TopMenuController's builder stores, for each model (0 ND filter, 1 HDF), a
    descriptor that is the official one without the other model's item, plus the new line at the
    end of the last page; registers and the rest of the builder as before;
  - 'submenu' form (round 6, as GR IV): the line draws both values' icons; the submenu record 18
    (a copy of D-Range Correction's record 6 with the two lines On/Off and Style) in a copy of the
    submenu table, all 5 sites moved; SubMenuController::SetCurrentMenu selects 18 for the new id;
    the factory and key map give D-Range's id for it and Horizon's for the two list ids, whose
    records are 118 and 119; each list keeps the other bit of the byte; values 0..3 are all valid;
  - 'list' form (round 4): controller plumbing: the factory gets Horizon Correction's id for the new id and every other
    id unchanged; the key map read gives Horizon's id for the new id and every other value
    unchanged; SelectMenuController::SetCurrentMenu selects record 118 for the new id and the
    official record for Horizon's;
  - the list table: records 0..117 as the official bytes, record 118 the new list (count 3, draw,
    set, is current), all 15 table sites moved; the list's handlers on the setting byte 0x9a2 of
    the settings record, including a record pointer of 0, stray values and exactly one current
    value; the menu line's icons and title;
  - the picture side: the patched Execute entry runs GR III's module and returns into Execute with
    every register as on entry; for each value of the setting byte (and a record pointer of 0) the
    pictures equal those GR IV's camera-tested module draws with the same setting and clock
    (0, 2 and 7 nothing; 1 and 3 the date), and planes below 0x5d000000 are never written.
UI widgets, singletons, cache maintenance and the clock are substitutes; the camera's menus, keys
and encoder are not executed.
"""
import argparse,base64,hashlib,json,re,struct
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_ARM,UC_HOOK_CODE
from unicorn import arm_const as reg
from adj_probe import AdjProbe
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')
ROOT=Path(__file__).resolve().parents[2]

NEW,HORIZON=0x020001a0,0x0200007d
SWITCH,STYLE,D_RANGE=0x020001a1,0x020001a2,0x020000ba
SUB_SETCUR,SUB_TABLE,SUB_REC,SUB_BYTE=0x531c5950,0x53b3fb10,0x64,0x174
SUB_SITES=[(0x531c5d18,0x531c5d20,3),(0x531c5d80,0x531c5d88,2),(0x531c60e8,0x531c60f4,8),(0x531c6318,0x531c631c,5),(0x531c63e4,0x531c63f0,3)]
TWO_ICONS,SUB_ICON=0x5339df08,0x533a6a70
PTR,OFFSET=0x55063f34,0x9a2
REC=0x62058000
BUILDER,MENU_TABLE,STILL=0x5319a778,0x55001eb8,0x53b36dec
APP,SPEC,MODEL=0x5320ad88,0x5320c09c,0x532dbee8
FACTORY,KEYREAD,GETTER=0x5316f3b8,0x53221a4c,0x53228c4c
SETCUR=0x531b9640
TABLE,REC_SIZE,RECORDS=0x53b3c6c0,0x40,117
SITES=[(0x531b9fdc,0x531b9fe8,4),(0x531ba154,0x531ba158,3),(0x531ba19c,0x531ba1a4,4),(0x531ba24c,0x531ba250,3),
  (0x531ba2b0,0x531ba2b4,3),(0x531ba4c0,0x531ba4c4,3),(0x531ba520,0x531ba524,4),(0x531ba648,0x531ba64c,3),
  (0x531ba800,0x531ba804,5),(0x531ba9a0,0x531ba9a8,3),(0x531baa60,0x531baa68,3),(0x531bab3c,0x531bab44,3),
  (0x531bdfc4,0x531bdfc8,3),(0x531be084,0x531be08c,8),(0x531be400,0x531be404,3)]
LINE_ICON,TITLE,LIST_ITEM=0x5339de20,0x5339dc70,0x5339e8b0
EXECUTE=0x535047d4
CACHE,INVALIDATE,CLEAN,PLATFORM,GET_TIME=0x536bbc30,0x536bbcc0,0x536bbcac,0x536bd838,0x536b6510
CLOCK=(2026,10,22,21,56,43)
NAMES=['Vkopírování data','Datostempel','Date Imprint','Päiväysleima','Impression date','Datumseinbelichtung','Αποτύπωση ημ/νίας',
  'Dátumbélyegző','Stampa data','日付写し込み','날짜 각인','Datumafdruk','Nadruk daty','Impressão de data',
  'Впечатывание даты','拍摄时间戳','Impresión de fecha','Datumstämpel','ประทับวันที่','拍攝時間戳','Tarih baskısı']
ROWS=[9,2,4,5,16,13,8,11,1,17,3,12,0,7,20,6,14,10,19,15,18]
SHORT,LONG="'26 10 08",'2026.10.08 17:34'
# GR IV's date imprint module of GR Mod 0.8.2 (the reference of rounds 4..7).
GR4_082_SHA256='b7be24583ad0aa8de3446b1477b6123a522b41ee627e34a8e3ab1414abed9b72'
def ts_names(name):
    src=(ROOT/'core/src/fw/aspect/datestamp-menu.ts').read_text()
    body=re.search(name+r": readonly string\[\] = \[(.*?)\];",src,re.S).group(1)
    return re.findall(r"'([^']*)'",body)
ON_OFF,STYLES=ts_names('DATESTAMP_ON_OFF_NAMES'),ts_names('DATESTAMP_STYLE_NAMES')
assert len(ON_OFF)==len(STYLES)==21
CFG,ARG,DESC,PLAT=0x558c0000,0x558c0100,0x558c0200,0x558c0f00
MAIN,PV,TH,LOW=0x63000000,0x63800000,0x63a00000,0x5c000000
SW,SH,MW,MH=2048,1400,1920,1280

def u32(c,a):return struct.unpack('<I',bytes(c.mem_read(a,4)))[0]
def movw(r,v,top=False):return (0xe3400000 if top else 0xe3000000)|(r<<12)|((v>>12)&15)<<16|(v&0xfff)
def ret(cpu,v=None):
    if v is not None:cpu.reg_write(reg.UC_ARM_REG_R0,v)
    cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))

class DateProbe(AdjProbe):
    def __init__(s,data,manifest):
        super().__init__(data,manifest);s.model=1;s.ui=[];s.time=0
        for base,size in ((0x55800000,0x100000),(0x63000000,0x1000000),(LOW,0x800000)):
            try:s.uc.mem_map(base,size)
            except Exception:pass
    def _hook(s,cpu,at,size,user):
        R=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R%d'%n))
        if at==MODEL:ret(cpu,s.model)
        elif at==SPEC:ret(cpu,0x62055000)
        elif at in (LINE_ICON,TITLE,LIST_ITEM,TWO_ICONS,SUB_ICON):s.ui.append((at,R(0),R(1),R(2)));ret(cpu,0)
        elif at in (INVALIDATE,CLEAN):ret(cpu)
        elif at==CACHE:ret(cpu,0x5536d1b4)
        elif at==PLATFORM:ret(cpu,PLAT)
        elif at==GET_TIME:cpu.mem_write(R(1),struct.pack('<HBBBBB',*CLOCK));s.time+=1;ret(cpu)
        else:AdjProbe._hook(s,cpu,at,size,user)
    def setting(s,byte,pointer=True):
        s.uc.mem_write(REC,bytes(0xb28));s.uc.mem_write(REC+OFFSET,bytes([byte]))
        s.uc.mem_write(PTR,struct.pack('<I',REC if pointer else 0))
    def byte(s):return s.uc.mem_read(REC+OFFSET,1)[0]

def gr4_reference(setting,pictures,look=None):
    """GR IV's camera-tested module of GR Mod 0.8.2 (aspect/datestamp-code.ts as released in 0.8.2,
    kept in fixtures/gr4-datestamp-0.8.2.b64) on the same pictures and clock; `look`: (the look word,
    the 64-byte table of black-and-white looks) for its look fields. (Round 8: datestamp8_probe.py
    compares with GR IV's 0.8.4 module.)"""
    code=base64.b64decode((Path(__file__).with_name('fixtures')/'gr4-datestamp-0.8.2.b64').read_text().strip())
    assert hashlib.sha256(code).hexdigest()==GR4_082_SHA256
    mu=Uc(UC_ARCH_ARM,UC_MODE_ARM);ORG=0x10000;STUB=0x70000000
    mu.mem_map(ORG,0x10000);mu.mem_write(ORG,code);mu.mem_map(0x60000000,0x100000);mu.mem_map(STUB,0x100000)
    for base,size in ((0x63000000,0x1000000),(LOW,0x800000)):mu.mem_map(base,size)
    for i in range(5):mu.mem_write(STUB+i*16,struct.pack('<I',0xe12fff1e))
    mu.mem_write(STUB+5*16,struct.pack('<2I',0xe3a00000,0xe12fff1e))   # the model check: 0 (not a Monochrome)
    def hook(uc,addr,size,ud):
        i=(addr-STUB)//16
        if i==0:uc.reg_write(reg.UC_ARM_REG_R0,0x70001000)
        if i==3:uc.reg_write(reg.UC_ARM_REG_R0,0x70001000)
        if i==4:uc.mem_write(uc.reg_read(reg.UC_ARM_REG_R1),struct.pack('<HBBBBB',*CLOCK))
    mu.hook_add(UC_HOOK_CODE,hook,begin=STUB,end=STUB+0x50)
    mu.mem_write(0x70001004,struct.pack('<I',0x70002000));mu.mem_write(0x70003000,bytes([setting]))
    mu.mem_write(0x70004000,struct.pack('<6I',*(STUB+i*16 for i in range(5)),0x70003000))
    if look is not None:
        mu.mem_write(0x70007000,struct.pack('<I',look[0]));mu.mem_write(0x70007100,look[1])
        mu.mem_write(0x70004018,struct.pack('<3I',0x70007000,0x70007100,STUB+5*16))
    for a,b in pictures['memory']:mu.mem_write(a,b)
    descs=pictures['descriptors']
    for i,d in enumerate(descs):mu.mem_write(0x70005000+i*0x20,d)
    mu.mem_write(0x70006000+0x3c,struct.pack('<4I',*(0x70005000+i*0x20 for i in range(4))))
    mu.reg_write(reg.UC_ARM_REG_SP,0x600f0000);mu.reg_write(reg.UC_ARM_REG_LR,0x70000ff0)
    mu.reg_write(reg.UC_ARM_REG_R0,0x70004000);mu.reg_write(reg.UC_ARM_REG_R1,0x70006000)
    mu.emu_start(ORG,0x70000ff0,count=400_000_000)
    return [bytes(mu.mem_read(a,len(b))) for a,b in pictures['memory']]

def pictures(main=MAIN):
    """Main picture (a window of a larger buffer), 720x480 screennail, 160x120 thumbnail, and the
    whole buffer again with the same planes (as the camera lists it)."""
    y=bytes(((x*7+r*3)%160+40) for r in range(SH) for x in range(SW));c=bytes((120+(x%2)*20) for r in range(SH) for x in range(SW))
    py=bytes([110])*(736*480);pc=bytes([128,128])*(736*480//2);ty=bytes([100])*(160*120);tc=bytes([128])*(160*120)
    mainc=main+0x300000
    d=lambda yp,cp,w,h,st,ch:struct.pack('<B3xIIIHHHHHH4x',1,yp,cp,0,w,h,st,ch,0,0)
    return {'memory':[(main,y),(mainc,c),(PV,py),(PV+0x100000,pc),(TH,ty),(TH+0x8000,tc)],
            'descriptors':[d(main,mainc,MW,MH,SW,SH),d(PV,PV+0x100000,720,480,736,480),d(TH,TH+0x8000,160,120,160,120),d(main,mainc,SW,SH,SW,SH)]}

def execute(p,pics):
    uc=p.uc
    for a,b in pics['memory']:uc.mem_write(a,b)
    for i,d in enumerate(pics['descriptors']):uc.mem_write(DESC+i*0x20,d)
    cfg=bytearray(0x60);struct.pack_into('<4I',cfg,0x3c,*(DESC+i*0x20 for i in range(4)));uc.mem_write(CFG,bytes(cfg))
    uc.mem_write(ARG,struct.pack('<3I',0,0,CFG));uc.mem_write(PLAT,struct.pack('<2I',0,PLAT+0x80))
    values=[0x62e00000+i*0x100 for i in range(13)];values[0]=0x62d00800;values[1]=ARG
    for i,v in enumerate(values):uc.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
    uc.reg_write(reg.UC_ARM_REG_SP,STACK);uc.reg_write(reg.UC_ARM_REG_LR,STOP);uc.reg_write(reg.UC_ARM_REG_CPSR,0x13)
    p.time=0
    uc.emu_start(EXECUTE,EXECUTE+4,timeout=900_000_000,count=400_000_000)
    assert uc.reg_read(reg.UC_ARM_REG_PC)==EXECUTE+4
    assert [uc.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(12)]==values[:12]
    assert uc.reg_read(reg.UC_ARM_REG_SP)==STACK and uc.reg_read(reg.UC_ARM_REG_R12)==STACK and uc.reg_read(reg.UC_ARM_REG_LR)==STOP
    return [bytes(uc.mem_read(a,len(b))) for a,b in pics['memory']]

def verify_list(p,data,manifest,official,report):
    c=p.uc;e=manifest['entries'];ids=manifest['dateImprint'];calls=0
    orig=lambda a,n:data[a-0x53000000:a-0x53000000+n]
    # 3. Factory, key map, SetCurrentMenu.
    ids_seen=sorted({x[1] for x in official}|{HORIZON,0x020000ba,0x0200013a,0x0200013b,NEW,NEW+1,0x08000000})
    for cid in ids_seen:
        c.reg_write(reg.UC_ARM_REG_R0,0x62056000);c.reg_write(reg.UC_ARM_REG_R1,cid);c.reg_write(reg.UC_ARM_REG_SP,STACK)
        c.emu_start(FACTORY,FACTORY+4,count=50)
        assert c.reg_read(reg.UC_ARM_REG_R1)==(HORIZON if cid==NEW else cid) and c.reg_read(reg.UC_ARM_REG_R3)==0x13b
        assert c.reg_read(reg.UC_ARM_REG_R0)==0x62056000
        c.mem_write(0x62057000,struct.pack('<I',cid))
        assert p.call(e['dateKeys'],0x62057000)==(HORIZON if cid==NEW else cid);calls+=1
    assert u32(c,KEYREAD)==(0xeb000000|(((e['dateKeys']-(KEYREAD+8))>>2)&0xffffff))
    obj=0x62059000
    for cid,want in ((NEW,118),(HORIZON,44)):
        c.mem_write(obj,bytes(0x200));p.call(SETCUR,obj,cid);calls+=1
        assert c.mem_read(obj+0x198,1)[0]==want,(hex(cid),c.mem_read(obj+0x198,1)[0])
    # 4. List table and handlers.
    table=None
    for lo,hi,r in SITES:
        a,b=u32(c,lo),u32(c,hi);va=(a&0xfff)|((a>>4)&0xf000)|(((b&0xfff)|((b>>4)&0xf000))<<16)
        assert a==movw(r,va&0xffff) and b==movw(r,va>>16,True);table=table or va;assert va==table
    assert table==e['dateListTable'] and table!=TABLE
    assert bytes(c.mem_read(table,118*REC_SIZE))==orig(TABLE,118*REC_SIZE)
    rec=bytes(c.mem_read(table+118*REC_SIZE,REC_SIZE));f=struct.unpack('<16I',rec)
    assert f[0]==0x10000 and f[1]==ids['name'] and f[2:10]==(e['dateCount'],0,e['dateDraw'],0,e['dateSet'],0,e['dateIsCurrent'],0) and not any(f[10:])
    assert p.call(e['dateCount'],0)==3
    for v,(icon,text) in enumerate(((344,2),(ids['iconShort'],ids['short']),(ids['iconLong'],ids['long']))):
        p.ui=[];p.call(e['dateDraw'],0x62056000,0x6205a000,v);calls+=1
        assert p.ui==[(LIST_ITEM,0x6205a000,icon,text)],(v,p.ui)
    states={}
    for stored in (0,1,2,3,4,7,0xff):
        p.setting(stored);cur=[p.call(e['dateIsCurrent'],0,v) for v in range(3)];calls+=3
        norm=stored if stored in (1,3) else 0
        assert cur==[int(norm==0),int(norm==1),int(norm==3)] and p.byte()==norm,(stored,cur,p.byte())
        p.ui=[];p.setting(stored);p.call(e['dateLine'],0x62056000,0x6205b000);calls+=1
        icon={0:344,1:ids['iconShort'],3:ids['iconLong']}[norm]
        assert p.ui==[(LINE_ICON,0x6205b000,icon,p.ui[0][3]),(TITLE,0x6205b000,ids['name'],ids['name'])],(stored,p.ui)
        states[stored]=norm
    for v,byte in ((0,0),(1,1),(2,3)):
        p.setting(0x55);p.call(e['dateSet'],0,v);assert p.byte()==byte;calls+=1
    p.setting(1);p.call(e['dateSet'],0,3);p.call(e['dateSet'],0,0xffffffff);assert p.byte()==1;calls+=2
    p.setting(1,pointer=False)
    assert [p.call(e['dateIsCurrent'],0,v) for v in range(3)]==[1,0,0];p.call(e['dateSet'],0,2);assert p.byte()==1;calls+=4
    report['list']={'values':3,'stored_normalised':{hex(k):v for k,v in states.items()}}
    return calls

def verify_submenu(p,data,manifest,official,report):
    c=p.uc;e=manifest['entries'];ids=manifest['dateImprint'];calls=0
    orig=lambda a,n:data[a-0x53000000:a-0x53000000+n]
    pics=manifest.get('pictures')
    endscreen=bool(pics) and pics.get('form')=='submenu'   # round 6: the pictures' submenu (endscreen_probe.py)
    if endscreen:pics=None
    # 3. Factory and key map: the submenu id gets D-Range's, the two list ids Horizon's (and the
    # pictures' list id, when built), every other id itself.
    mapped={NEW:D_RANGE,SWITCH:HORIZON,STYLE:HORIZON,**({NEW+3:HORIZON} if pics else {})}
    if endscreen:mapped.update({NEW+3:D_RANGE,NEW+4:0x020000ad})
    seen=sorted({x[1] for x in official}|{HORIZON,D_RANGE,0x0200013a,0x0200013b,NEW,SWITCH,STYLE,NEW+3,NEW+4,0x08000000})
    for cid in seen:
        want=mapped.get(cid,cid)
        c.reg_write(reg.UC_ARM_REG_R0,0x62056000);c.reg_write(reg.UC_ARM_REG_R1,cid);c.reg_write(reg.UC_ARM_REG_SP,STACK)
        c.emu_start(FACTORY,FACTORY+4,count=80)
        assert c.reg_read(reg.UC_ARM_REG_R1)==want and c.reg_read(reg.UC_ARM_REG_R3)==0x13b,hex(cid)
        assert c.reg_read(reg.UC_ARM_REG_R0)==0x62056000 and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        c.mem_write(0x62057000,struct.pack('<I',cid))
        assert p.call(e['dateKeys'],0x62057000)==want;calls+=1
    assert u32(c,KEYREAD)==(0xeb000000|(((e['dateKeys']-(KEYREAD+8))>>2)&0xffffff))
    # SetCurrentMenu of the lists and of the submenus (patched entries, official paths for the rest).
    obj=0x62059000
    lists={SWITCH:118,STYLE:119,HORIZON:44,**({NEW+3:120} if pics else {})}
    for cid,want in lists.items():
        c.mem_write(obj,bytes(0x200));p.call(SETCUR,obj,cid);calls+=1
        assert c.mem_read(obj+0x198,1)[0]==want,(hex(cid),c.mem_read(obj+0x198,1)[0])
    for cid,want in ((NEW,18),(D_RANGE,6)):
        c.mem_write(obj,bytes(0x200));p.call(SUB_SETCUR,obj,cid);calls+=1
        assert c.mem_read(obj+SUB_BYTE,1)[0]==want,(hex(cid),c.mem_read(obj+SUB_BYTE,1)[0])
    # 4. List table (records 0..117 official, 118 On/Off, 119 Style).
    table=None
    for lo,hi,r in SITES:
        a,b=u32(c,lo),u32(c,hi);va=(a&0xfff)|((a>>4)&0xf000)|(((b&0xfff)|((b>>4)&0xf000))<<16)
        assert a==movw(r,va&0xffff) and b==movw(r,va>>16,True);table=table or va;assert va==table
    assert table==e['dateListTable'] and table!=TABLE
    assert bytes(c.mem_read(table,118*REC_SIZE))==orig(TABLE,118*REC_SIZE)
    horizon=orig(TABLE+44*REC_SIZE,REC_SIZE)
    for k,(title,cnt,draw,st,cur) in enumerate(((ids['onOff'],e['dateCount'],e['dateDrawOnOff'],e['dateSetOnOff'],e['dateIsOnOff']),
                                               (ids['style'],e['dateCount'],e['dateDrawStyle'],e['dateSetStyle'],e['dateIsStyle']))):
        rec=bytes(c.mem_read(table+(118+k)*REC_SIZE,REC_SIZE));f=struct.unpack('<16I',rec)
        assert f[0]==0x10000 and f[1]==title and f[2:10]==(cnt,0,draw,0,st,0,cur,0) and not any(f[10:])
        h=struct.unpack('<16I',horizon);assert h[0]==f[0] and h[3]==f[3]
    assert p.call(e['dateCount'],0)==2;calls+=1
    # Round 7: the camera's boxed OFF / ON (296 / 297); up to round 6 Horizon's line icons (344 / 345).
    OFF,ON=ids.get('iconOff',344),ids.get('iconOn',345)
    for draw,values in ((e['dateDrawOnOff'],((OFF,2),(ON,1))),(e['dateDrawStyle'],((ids['iconShort'],ids['short']),(ids['iconLong'],ids['long'])))):
        for v,(icon,text) in enumerate(values):
            p.ui=[];p.call(draw,0x62056000,0x6205a000,v);calls+=1
            assert p.ui==[(LIST_ITEM,0x6205a000,icon,text)],(v,p.ui)
    # Submenu table: records 0..17 official, 18 the date imprint's.
    st=None
    for lo,hi,r in SUB_SITES:
        a,b=u32(c,lo),u32(c,hi);va=(a&0xfff)|((a>>4)&0xf000)|(((b&0xfff)|((b>>4)&0xf000))<<16)
        assert a==movw(r,va&0xffff) and b==movw(r,va>>16,True);st=st or va;assert va==st
    assert st==e['submenuTable'] and st!=SUB_TABLE
    assert bytes(c.mem_read(st,18*SUB_REC))==orig(SUB_TABLE,18*SUB_REC)
    drange=orig(SUB_TABLE+6*SUB_REC,SUB_REC);rec=bytes(c.mem_read(st+18*SUB_REC,SUB_REC))
    want=bytearray(drange);struct.pack_into('<H',want,2,ids['name']);struct.pack_into('<HH',want,8,ids['onOff'],ids['style'])
    struct.pack_into('<II',want,0x14,SWITCH,STYLE);struct.pack_into('<4I',want,0x3c,e['dateLineOnOff'],0,e['dateLineStyle'],0)
    assert rec==bytes(want) and rec[6]==2 and struct.unpack_from('<I',rec,0x1c)[0]==0x10000000
    assert u32(c,SUB_SETCUR)==(0xea000000|(((e['submenuSetCurrent']-(SUB_SETCUR+8))>>2)&0xffffff))
    # Every stored value: lists have exactly one current value, the lines show both values.
    states={}
    for stored in (0,1,2,3,4,7,0xff):
        norm=stored if stored<=3 else 0
        p.setting(stored);sw=[p.call(e['dateIsOnOff'],0,v) for v in range(2)];calls+=2
        assert sw==[int(norm&1==0),int(norm&1==1)] and p.byte()==norm,(stored,sw)
        p.setting(stored);sy=[p.call(e['dateIsStyle'],0,v) for v in range(2)];calls+=2
        assert sy==[int(norm&2==0),int(norm&2==2)] and p.byte()==norm,(stored,sy)
        on=ON if norm&1 else OFF;style=ids['iconLong'] if norm&2 else ids['iconShort']
        p.ui=[];p.setting(stored);p.call(e['dateLine'],0x62056000,0x6205b000);calls+=1
        assert p.ui==[(TWO_ICONS,0x6205b000,on,style),(TITLE,0x6205b000,ids['name'],ids['name'])],(stored,p.ui)
        p.ui=[];p.setting(stored);p.call(e['dateLineOnOff'],0x62056000,0x6205b000);calls+=1
        assert [u[:3] for u in p.ui]==[(SUB_ICON,0x6205b000,on)],(stored,p.ui)
        p.ui=[];p.setting(stored);p.call(e['dateLineStyle'],0x62056000,0x6205b000);calls+=1
        assert [u[:3] for u in p.ui]==[(SUB_ICON,0x6205b000,style)],(stored,p.ui)
        states[stored]=norm
    # Setting one list keeps the other's bit; values past the list and a missing record do nothing.
    for start in range(4):
        for v in range(2):
            p.setting(start);p.call(e['dateSetOnOff'],0,v);assert p.byte()==(start&2)|v;calls+=1
            p.setting(start);p.call(e['dateSetStyle'],0,v);assert p.byte()==(start&1)|(v<<1);calls+=1
        for bad in (2,3,0xffffffff):
            p.setting(start);p.call(e['dateSetOnOff'],0,bad);p.call(e['dateSetStyle'],0,bad);assert p.byte()==start;calls+=2
    p.setting(9);p.call(e['dateSetOnOff'],0,1);assert p.byte()==1;calls+=1   # a stray value is reset first
    p.setting(3,pointer=False)
    assert [p.call(e['dateIsOnOff'],0,v) for v in range(2)]==[1,0] and [p.call(e['dateIsStyle'],0,v) for v in range(2)]==[1,0];calls+=4
    p.call(e['dateSetOnOff'],0,1);p.call(e['dateSetStyle'],0,1);assert p.byte()==3;calls+=2
    p.ui=[];p.call(e['dateLine'],0x62056000,0x6205b000);assert p.ui[0]==(TWO_ICONS,0x6205b000,OFF,ids['iconShort']);calls+=1
    report['submenu']={'record':18,'lists':[118,119],'values':4,'stored_normalised':{hex(k):v for k,v in states.items()}}
    return calls

def verify(data,manifest):
    e=manifest['entries'];ids=manifest['dateImprint'];assert ids
    p=DateProbe(data,manifest);c=p.uc;calls=0;report={}
    sub=ids.get('form')=='submenu';assert ids.get('form','list') in ('list','submenu')
    # Round 8 (as GR Mod 0.8.4): datestamp8_probe.py checks what is new.
    r8=bool(manifest.get('round8'))
    if r8:
        import datestamp8_probe as d8
        assert sub and ids.get('iconOff')
    orig=lambda a,n:data[a-0x53000000:a-0x53000000+n]
    # 1. Texts and icons.
    roots=manifest['catalogs']['textRoots']
    for row,lang in enumerate(ROWS):
        extra=((ids['onOff'],ON_OFF[lang]),(ids['style'],STYLES[lang])) if sub else ()
        for tid,text in ((ids['name'],NAMES[lang]),(ids['short'],SHORT),(ids['long'],LONG))+extra:
            rec=u32(c,u32(c,roots+row*4)+tid*4);units,lines,_,at=struct.unpack('<BBHI',bytes(c.mem_read(rec,8)))
            assert (units,lines)==(len(text)+1,1) and bytes(c.mem_read(at,units*2)).decode('utf-16le')==text+'\0',(row,tid)
    if r8:calls+=d8.texts(p,manifest,ROWS,SHORT,LONG)
    icons=bytes.fromhex(manifest['iconAddition']['bytes']);origin=manifest['iconAddition']['originalLength']
    for k in ('iconShort','iconLong'):
        w,h,o=struct.unpack('<HHI',bytes(c.mem_read(u32(c,manifest['catalogs']['iconRoot']+ids[k]*4),8)))
        assert (w,h)==(40,40) and o*4>=origin and o*4-origin+6400<=len(icons)
    # 2. Still menu per model.
    still=orig(STILL,0x384)
    def items(d):return [(struct.unpack_from('<I',d,0x8c+i*8)[0],struct.unpack_from('<I',d,0x1bc+i*4)[0],struct.unpack_from('<I',d,0x254+i*8)[0]) for i in range(38)]
    official=items(still)
    for model,drop,firsts in ((0,25,[0,8,16,19,25,30,34]),(1,13,[0,8,15,18,25,30,34])):
        p.model=model;c.mem_write(MENU_TABLE,struct.pack('<I',STILL))
        regs=[0x7000+i for i in range(4)]
        for i,v in enumerate(regs):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,STOP);c.reg_write(reg.UC_ARM_REG_R12,0x4444)
        c.emu_start(BUILDER,BUILDER+4,count=1000);calls+=1
        assert [c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(4)]==regs and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        assert c.reg_read(reg.UC_ARM_REG_LR)==STOP and c.reg_read(reg.UC_ARM_REG_R12)==STACK  # mov ip,sp re-executed
        d=bytes(c.mem_read(u32(c,MENU_TABLE),0x384));got=items(d)
        want=[x for i,x in enumerate(official) if i!=drop]+[(e['dateLine'],NEW,0)]
        assert got==want,(model,)
        assert d[0x68]==7 and list(d[0x80:0x87])==firsts and d[0x8b]==38
        assert d[:0x80]==still[:0x80] and d[0x87:0x8b]==still[0x87:0x8b]   # page titles and the rest unchanged
        assert all(struct.unpack_from('<I',d,0x8c+i*8+4)[0]==0 for i in range(38))
    report['menus']={'nd':'official without HDF + date','hdf':'official without ND + date'}
    if r8:
        n,report['submenu']=d8.submenu(p,data,manifest,official);calls+=n
    elif sub:
        calls+=verify_submenu(p,data,manifest,official,report)
    else:
        calls+=verify_list(p,data,manifest,official,report)
    # 5. Pictures: the same as GR IV's module, for every setting value.
    pics=pictures();base=[b for _,b in pics['memory']];results={}
    if r8:
        n,report['pictures8']=d8.pictures8(p,manifest,pics,CLOCK,LOW,REC,PTR,OFFSET,CFG,ARG,DESC,PLAT);calls+=n
        n,report['exposure']=d8.exposure(p,manifest);calls+=n
        n,report['raw_development']=d8.raw_words(p,manifest,manifest.get('filmCount') or 0);calls+=n
        c.mem_write(0x55804378,bytes(16))
    for stored,pointer in (((1,False),) if r8 else ((0,True),(1,True),(2,True),(3,True),(7,True),(1,False))):
        p.setting(stored,pointer);got=execute(p,pics);calls+=1
        ref=gr4_reference(stored if pointer else 0,pics)
        assert got==ref,(stored,pointer)
        changed=sum(sum(a!=b for a,b in zip(x,y)) for x,y in zip(got,base))
        assert (changed>0)==(pointer and stored in (1,3)),(stored,pointer,changed)
        results[f'{stored}{"" if pointer else " (no record)"}']=changed
    if not r8:assert results['3']>results['1']
    low=pictures(LOW);p.setting(1);got=execute(p,low)
    assert got[:2]==[b for _,b in low['memory']][:2]   # main picture below 0x5d000000: untouched
    if ids.get('iconOff') and not r8:
        # Round 7 (as GR IV 0.8.2): the imprint is light only exactly for black-and-white looks, by the
        # look word the development step leaves (the stash); without a valid word, by the colours.
        ctx=e['dateContext'];words=struct.unpack('<10I',bytes(c.mem_read(ctx,40)))
        assert words[5:7]==(PTR,OFFSET) and words[7]==0x55804378
        table=bytes(c.mem_read(words[8],64));assert [i for i in range(64) if table[i]]==[13,14,15,16]+[32+k for k,m in enumerate(manifest.get('monoFilms') or []) if m]
        assert p.call(words[9])==0;calls+=1
        looks={}
        for word in [0,13|0x10000,16|0x10000,11|0x10000,22|0x10000,32|0x10000,51|0x10000,63|0x10000,13,255|0x10000]:
            c.mem_write(0x55804378,struct.pack('<I',word));p.setting(3);got=execute(p,pics);calls+=1
            assert got==gr4_reference(3,pics,(word,table)),hex(word)
            looks[hex(word)]=sum(sum(a!=b for a,b in zip(x,y)) for x,y in zip(got,base))
        c.mem_write(0x55804378,b'\0'*4)
        report['by_look']=dict(equal_to_gr4_module=True,changed_bytes=looks)
    if 'lookStash' in e and not r8:
        # Round 7 without films: the development step's look read also leaves look | 0x10000.
        rec=0x62059800;regs=[0x6000+i for i in range(13)];regs[3]=rec;cases=0
        for look in list(range(0,24))+[64,83,255]:
            for flags in (0,0xf):
                c.mem_write(rec+0x77c,bytes([look]));c.mem_write(0x55804378,b'\xa5'*4)
                for i,v in enumerate(regs):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
                c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_CPSR,0x13|flags<<28)
                c.emu_start(0x536db7f8,0x536db7fc,count=100)
                out=[c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)]
                assert out[2]==look and out[:2]==regs[:2] and out[3:]==regs[3:] and c.reg_read(reg.UC_ARM_REG_SP)==STACK
                assert c.reg_read(reg.UC_ARM_REG_CPSR)>>28==flags and u32(c,0x55804378)==look|0x10000;cases+=1;calls+=1
        report['look_stash_cases']=cases
    report['pictures']=dict(changed_bytes=results,equal_to_gr4_module=True,low_main_plane_untouched=True)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,**report,hardware_tested=False,
        scope='Patched builder, factory, key map read, list SetCurrentMenu, list handlers and JPEG entry with substitutes for UI widgets, model, cache and clock.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();result=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
