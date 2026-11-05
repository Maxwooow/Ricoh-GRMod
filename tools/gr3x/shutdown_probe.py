"""Power-off pictures on GR III 2.10 / IIIx 1.60 (core/src/fw/gr3x/shutdown.ts), every patch of the
manifest installed:

  - texts and icons: the line name and the original's name in all 21 rows, the pictures' names,
    one 40x40 thumbnail per picture;
  - Setup menu: the table's Setup entry (as initialised at start-up) points at a copy of the
    official descriptor with the new line right after End Screen and every other item, the page
    titles and everything else as officially; pages after Display start one item later;
  - list: SetCurrentMenu selects the pictures' record (after the date imprint's, when built) for
    the new id; the factory and the key map give Horizon Correction's list controller and keys
    for it and leave every other id; the record (count 1 + n, draw, set, is current), the draw of
    every value (OFF icon and the original's name, then thumbnail and name; values above n drawn
    as the last), set / is current on byte 0x9a3 (record pointer 0, stray values, exactly one
    current value) and the Setup line (current name, title);
  - picture request: RequestBackgroundJpeg (0x5319f180) is run for each camera variant (0..4) and
    setting; it asks the full-screen JPEG request (0x5322e4a8) for the native picture (2, 3, 11, 10,
    12) unless picture k (1..n) is chosen, then for 13 + k - 1; the request's table (from its patched
    movw/movt) holds the 13 official pointers and n entries {720, 480, "A:\\Resource\\Jpeg\\GRMODk.jpg"};
    the registers the request receives besides the index are those of the unpatched code.
UI widgets, singletons and the JPEG request are substitutes; the camera's menus, keys, files and
display are not executed.
"""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import arm_const as reg
from datestamp_probe import DateProbe,u32,movw,ret,STOP,STACK
from rear_dial_probe import RearDialProbe

if not __debug__:raise RuntimeError('Validation requires Python assertions')

PIC_ID,HORIZON,DATE_ID=0x020001a3,0x0200007d,0x020001a0
PTR,OFFSET=0x55063f34,0x9a3
REC=0x62058000
SETUP,SETUP_ENTRY_IMAGE,SETUP_ENTRY_RAM=0x53b36a54,0x5407d408,0x55001ec8
FACTORY,KEYREAD,SETCUR=0x5316f3b8,0x53221a4c,0x531b9640
LINE_TEXT,TITLE,LIST_ITEM=0x5339de6c,0x5339dc70,0x5339e8b0
REQUEST,PLAYBACK,VARIANT=0x5319f180,0x5322e4a8,0x53525d5c
TABLE,TABLE_SITE=0x55002b78,(0x5322e4b4,0x5322e4bc)
NATIVE_INDEX={0:2,1:3,2:11,3:10,4:12}
LINES=['終了画面の画像','End Screen Picture','Image de fin','Endbild','Imagen final','Imagem final','Immagine finale',
  'Eindafbeelding','Slutbillede','Slutbild','Päätöskuva','Obraz końcowy','Finální obrázek','Záró kép','Son resim',
  'Τελική εικόνα','Конечное изображение','종료 이미지','結束畫面圖片','结束画面图片','ภาพหน้าจอสุดท้าย']
ORIGINAL=['オリジナル']+['Original']*17+['原始','原始','Original']
VOBJ=0x6205c000

class PictureProbe(DateProbe):
    def __init__(s,data,manifest):
        super().__init__(data,manifest);s.requests=[];s.variant=0
    def _hook(s,cpu,at,size,user):
        R=lambda n:cpu.reg_read(getattr(reg,'UC_ARM_REG_R%d'%n))
        if at==LINE_TEXT:s.ui.append((at,R(0),R(1)));ret(cpu,0)
        elif at==PLAYBACK:s.requests.append([R(i) for i in range(4)]);ret(cpu,0)
        elif at==VARIANT:
            # *(*(*(*(obj+4)+0xc)+0x1c)+0x48) = variant
            for a,v in ((VOBJ+4,VOBJ+0x100),(VOBJ+0x10c,VOBJ+0x200),(VOBJ+0x21c,VOBJ+0x300),(VOBJ+0x348,s.variant)):cpu.mem_write(a,struct.pack('<I',v))
            ret(cpu,VOBJ)
        elif at in (0x5320b13c,0x5320b07c):ret(cpu,0x6205d000 if at==0x5320b13c else 0x6205e000)
        elif at in (0x53233fb0,0x536b53e0,0x536b53e8,0x536b5d1c):ret(cpu,R(0))
        else:DateProbe._hook(s,cpu,at,size,user)
    def setting(s,byte,pointer=True):
        s.uc.mem_write(REC,bytes(0xb28));s.uc.mem_write(REC+OFFSET,bytes([byte]))
        s.uc.mem_write(PTR,struct.pack('<I',REC if pointer else 0))
    def byte(s):return s.uc.mem_read(REC+OFFSET,1)[0]

def verify(data,manifest):
    e=manifest['entries'];ids=manifest['pictures'];assert ids
    n=ids['count'];p=PictureProbe(data,manifest);c=p.uc;calls=0;report={}
    orig=lambda a,k:data[a-0x53000000:a-0x53000000+k]
    date=bool(manifest.get('dateImprint'))
    # 1. Texts and icons.
    roots=manifest['catalogs']['textRoots']
    def text(row,tid):
        rec=u32(c,u32(c,roots+row*4)+tid*4);units,lines,_,at=struct.unpack('<BBHI',bytes(c.mem_read(rec,8)))
        assert lines==1;return bytes(c.mem_read(at,units*2)).decode('utf-16le')
    for row in range(21):
        assert text(row,ids['title'])==LINES[row]+'\0' and text(row,ids['original'])==ORIGINAL[row]+'\0'
    names=[text(1,t)[:-1] for t in ids['names']]
    for row in range(21):assert [text(row,t)[:-1] for t in ids['names']]==names
    assert len(names)==n and all(0<len(x)<=20 for x in names)
    origin=manifest['iconAddition']['originalLength'];icons=bytes.fromhex(manifest['iconAddition']['bytes'])
    for t in ids['icons']:
        w,h,o=struct.unpack('<HHI',bytes(c.mem_read(u32(c,manifest['catalogs']['iconRoot']+t*4),8)))
        assert (w,h)==(40,40) and o*4>=origin and o*4-origin+6400<=len(icons)
    # 2. Setup menu.
    official=orig(SETUP,0x384)
    assert u32(c,SETUP_ENTRY_IMAGE)==e['pictureSetupMenu'] and orig(SETUP_ENTRY_IMAGE,4)==struct.pack('<I',SETUP)
    d=bytes(c.mem_read(e['pictureSetupMenu'],0x384))
    items=lambda b,k:[(struct.unpack_from('<2I',b,0x8c+i*8),struct.unpack_from('<I',b,0x1bc+i*4)[0],struct.unpack_from('<2I',b,0x254+i*8)) for i in range(k)]
    want=items(official,38);want=want[:11]+[((e['pictureLine'],0),PIC_ID,(0,0))]+want[11:37]
    assert items(d,38)==want
    assert d[:0x80]==official[:0x80] and d[0x68]==11 and list(d[0x80:0x8b])==[0,7,12,14,16,18,21,24,26,28,30] and d[0x8b]==31
    assert want[10][1]==0x020000ad and want[37][1]==0x10000000
    report['setup']='official + picture line after End Screen'
    # 3. Controller plumbing.
    sub=bool(date) and manifest['dateImprint'].get('form')=='submenu'
    dmap={DATE_ID:0x020000ba,DATE_ID+1:HORIZON,DATE_ID+2:HORIZON} if sub else ({DATE_ID:HORIZON} if date else {})
    for cid in sorted({x[1] for x in items(official,30)}|{HORIZON,PIC_ID,DATE_ID,DATE_ID+1,DATE_ID+2,PIC_ID+1,0x08000000}):
        c.reg_write(reg.UC_ARM_REG_R0,0x62056000);c.reg_write(reg.UC_ARM_REG_R1,cid);c.reg_write(reg.UC_ARM_REG_SP,STACK)
        c.emu_start(FACTORY,FACTORY+4,count=80)
        mapped=HORIZON if cid==PIC_ID else dmap.get(cid,cid)
        assert c.reg_read(reg.UC_ARM_REG_R1)==mapped and c.reg_read(reg.UC_ARM_REG_R3)==0x13b,hex(cid)
        c.mem_write(0x62057000,struct.pack('<I',cid))
        assert p.call(e['dateKeys'],0x62057000)==mapped;calls+=1
    record=118+((2 if sub else 1) if date else 0)
    obj=0x62059000
    for cid,want_rec in ((PIC_ID,record),(HORIZON,44))+((((DATE_ID+1,118),(DATE_ID+2,119)) if sub else ((DATE_ID,118),)) if date else ()):
        c.mem_write(obj,bytes(0x200));p.call(SETCUR,obj,cid);calls+=1
        assert c.mem_read(obj+0x198,1)[0]==want_rec
    table=e['dateListTable']
    assert bytes(c.mem_read(table,118*0x40))==orig(0x53b3c6c0,118*0x40)
    f=struct.unpack('<16I',bytes(c.mem_read(table+record*0x40,0x40)))
    assert f[0]==0x10000 and f[1]==ids['title'] and f[2:10]==(e['pictureCount'],0,e['pictureDraw'],0,e['pictureSet'],0,e['pictureIsCurrent'],0) and not any(f[10:])
    assert p.call(e['pictureCount'],0)==n+1
    rows=[(344,ids['original'])]+list(zip(ids['icons'],ids['names']))
    for v in range(n+3):
        p.ui=[];p.call(e['pictureDraw'],0x62056000,0x6205a000,v);calls+=1
        assert p.ui==[(LIST_ITEM,0x6205a000,*rows[min(v,n)])],(v,p.ui)
    for stored in list(range(n+1))+[n+1,0x7f,0xff]:
        p.setting(stored);cur=[p.call(e['pictureIsCurrent'],0,v) for v in range(n+1)];calls+=n+1
        norm=stored if stored<=n else 0
        assert cur==[int(v==norm) for v in range(n+1)] and p.byte()==norm,(stored,cur)
        p.ui=[];p.setting(stored);p.call(e['pictureLine'],0x62056000,0x6205b000);calls+=1
        assert p.ui[0]==(LINE_TEXT,0x6205b000,rows[norm][1]) and p.ui[1][:4]==(TITLE,0x6205b000,ids['title'],ids['title']),(stored,p.ui)
    for v in range(n+1):p.setting(0x55);p.call(e['pictureSet'],0,v);assert p.byte()==v;calls+=1
    p.setting(1);p.call(e['pictureSet'],0,n+1);p.call(e['pictureSet'],0,0xffffffff);assert p.byte()==1;calls+=2
    p.setting(1,pointer=False);assert [p.call(e['pictureIsCurrent'],0,v) for v in range(n+1)]==[1]+[0]*n;calls+=n+1
    # 4. The picture request.
    lo_,hi_=u32(c,TABLE_SITE[0]),u32(c,TABLE_SITE[1])
    jt=((lo_&0xfff)|((lo_>>4)&0xf000))|(((hi_&0xfff)|((hi_>>4)&0xf000))<<16)
    assert lo_==movw(12,jt&0xffff) and hi_==movw(12,jt>>16,True) and jt==e['pictureTable']
    assert bytes(c.mem_read(jt,13*4))==orig(0x5407e0b8,13*4)
    for k in range(n):
        ent=u32(c,jt+(13+k)*4);w,h,path=struct.unpack('<HHI',bytes(c.mem_read(ent,8)))
        assert (w,h)==(720,480) and bytes(c.mem_read(path,40)).split(b'\0')[0]==f'A:\\Resource\\Jpeg\\GRMOD{k+1}.jpg'.encode()
    native=RearDialProbe(data)
    seen={}
    for variant in range(5):
        for stored,pointer in [(0,True),(n+1,True),(0xff,True),(1,False)]+[(k,True) for k in range(1,n+1)]:
            p.variant=variant;p.setting(stored,pointer);p.requests=[];p.call(REQUEST,0x62056000);calls+=1
            assert len(p.requests)==1
            idx=p.requests[0][1]
            want=13+stored-1 if pointer and 1<=stored<=n else NATIVE_INDEX[variant]
            assert idx==want,(variant,stored,pointer,idx)
            seen[(variant,stored,pointer)]=idx
            # The other arguments: r0 (playback model) as officially; r2, r3 point into the frame.
            assert p.requests[0][0]==0x6205e000
    report['request']={'variants':5,'settings_per_variant':len(seen)//5,'pictures':n}
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),calls=calls,pictures=n,names=names,**report,hardware_tested=False,
        scope='Patched Setup menu copy, factory, key map read, list SetCurrentMenu, list handlers, GoodBye picture request and JPEG table with substitutes for UI widgets, singletons and the JPEG request.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):a.add_argument('--'+s,type=Path,required=True)
    x=a.parse_args();result=verify(x.rtos.read_bytes(),json.loads(x.manifest.read_text()))
    with x.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
