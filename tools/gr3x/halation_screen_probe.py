"""Round 6: a film's Halation line on the Image Control parameter screen (core/src/fw/gr3x/
halation-screen.ts), executed through the patched official code:

  - the parameter-line table: the 36 official entries unchanged in the copy, all four table
    sites moved to it, entries 36..38 Standard's lines of each set plus (stills only, kind 10);
  - GetBaseKindDetailControl (0x531aca98) for every look 0..255, photo sets 0..3 and both movie
    flags: official columns for looks 11..22, 36 - 11 * set for a film of this build in a photo
    set, 0 (the official default) for everything else, unbuilt reserved looks included;
  - the official line functions on the new entries: IsValidListLine (0x531afa10) and the line
    count (0x531afab8) agree with Standard's for Standard's lines, the added line is valid in stills
    only; the current kind (0x531b01d0) of the added line is 10;
  - the seven hooks, each run from its patched word to the next official instruction: name,
    slider scale, list icon (other registers and flags as before), slider start and position, list
    text and the slider's setter (films: the level of the film in the controller's set, from
    slots2.c; any other look: the official call with the same arguments), callee-saved registers and
    the stack as on entry.
UI widgets are not drawn; the controller is a synthetic object with the fields the code reads.
"""
import argparse,hashlib,json,random,struct
from pathlib import Path
from unicorn import arm_const as reg
from slots_probe import SlotsProbe,REC,REGION,fresh_record
from native_probe import STACK,STOP

if not __debug__:raise RuntimeError('Validation requires Python assertions')

TABLE=0x53b3488c
SITES=((0x531afa20,0x531afa24,12),(0x531afabc,0x531afacc,3),(0x531affa0,0x531affa8,12),(0x531b01f4,0x531b01f8,3))
BASE_COLUMN,IS_VALID,LINE_COUNT,CURRENT_KIND,FOCUS=0x531aca98,0x531afa10,0x531afab8,0x531b01d0,0x53394820
SUBTITLE,SCALE,START,POSITION,LIST_TEXT,LIST_ICON,SETTER=0x531b0254,0x531adcbc,0x531adca0,0x531b0514,0x531af494,0x531af4a8,0x531b0d8c
NATIVE_CALLS={0x532c70e4:'stored',0x532c297c:'live',0x532aca68:'text',0x532c0894:'hdr'}
SUBTITLE_TABLE=0x53b34bd8
OFFICIAL_COLUMN=[0,1,2,3,4,5,7,8,9,10,11,6]   # looks 11..22 (the jump table of 0x531acb20)
SETTINGS=0x55063f34
CTL=REGION+0x20000

def movw_value(lo,hi):
    a,b=lo,hi;return (a&0xfff)|((a>>4)&0xf000)|(((b&0xfff)|((b>>4)&0xf000))<<16)

class ScreenProbe(SlotsProbe):
    def __init__(self,data,manifest):
        super().__init__(data,manifest);self.native=[];self.focus=0
    def _hook(self,cpu,at,size,user):
        if at in NATIVE_CALLS:
            self.native.append((NATIVE_CALLS[at],cpu.reg_read(reg.UC_ARM_REG_R0),cpu.reg_read(reg.UC_ARM_REG_R1)))
            cpu.reg_write(reg.UC_ARM_REG_R0,0x7777);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==FOCUS:
            cpu.reg_write(reg.UC_ARM_REG_R0,self.focus);cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else:super()._hook(cpu,at,size,user)
    def logged(self,*args):
        """A call whose official asserts only log (as on the camera): the result and the logged lines."""
        try:return self.call(*args),[]
        except ValueError as error:
            if not str(error).startswith('Original assertion failed'):raise
            return self.uc.reg_read(reg.UC_ARM_REG_R0),[d['source_line'] for d in self.diagnostics]
    def controller(self,look,set_,movie=0):
        self.uc.mem_write(CTL,bytes(0x200));self.uc.mem_write(CTL+0x198,bytes([look,set_,0,0,0,movie]))
        self.uc.mem_write(CTL+0x194,struct.pack('<I',CTL+0x100))
    def site(self,at,regs,flags=0):
        """Run from a patched word to the next official instruction; returns the registers."""
        c=self.uc;values=[0x12340000+i for i in range(13)]
        for k,v in regs.items():values[k]=v
        for i,v in enumerate(values):c.reg_write(getattr(reg,'UC_ARM_REG_R'+str(i)),v)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,0x5a5a5a5a);c.reg_write(reg.UC_ARM_REG_CPSR,0x13|(flags<<28))
        self.native=[];c.emu_start(at,at+4,count=20000)
        assert c.reg_read(reg.UC_ARM_REG_PC)==at+4 and c.reg_read(reg.UC_ARM_REG_SP)==STACK
        out=[c.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(13)]
        assert out[4:12]==values[4:12],hex(at)   # callee-saved
        return out,values,c.reg_read(reg.UC_ARM_REG_CPSR)>>28

def verify(data,manifest):
    films=manifest['filmCount'];e=manifest['lookEntries']['halationScreen'];report={};calls=0
    n=ScreenProbe(data,manifest);c=n.uc;orig=lambda a,k:data[a-0x53000000:a-0x53000000+k]
    film=lambda look:64<=look<64+films
    hal_text=manifest['catalogs']['textColumns']-1;hal_icon,hal_scale=manifest['catalogs']['iconCount']-2,manifest['catalogs']['iconCount']-1
    # 1. The table.
    table=None
    for lo,hi,r in SITES:
        v=movw_value(struct.unpack('<I',c.mem_read(lo,4))[0],struct.unpack('<I',c.mem_read(hi,4))[0])
        table=table or v;assert v==table and v==e['table']
    assert bytes(c.mem_read(table,36*8))==orig(TABLE,36*8)
    entries=[struct.unpack('<2I',bytes(c.mem_read(table+8*k,8))) for k in range(39)]
    def items(k):p,cnt=entries[k];return [tuple(c.mem_read(p+2*i,2)) for i in range(cnt)]
    std=[items(0),items(12),items(24)]
    for s in range(3):assert items(36+s)==std[s]+[(0,10)],s
    assert items(37)==items(38) and items(12)[0]==(2,17) and all(k!=10 for _,k in items(0))
    report['table']=dict(entries=39,film_lines=[len(items(36+s)) for s in range(3)])
    # 2. Base column, every look, every set, both movie flags (the asserts only log).
    columns=0
    for movie in (0,1):
        for s in range(4):
            for look in range(256):
                n.controller(look,s,movie);col,logged=n.logged(BASE_COLUMN,CTL,look);calls+=1
                want=OFFICIAL_COLUMN[look-11] if 11<=look<=22 else (36-11*s if film(look) and s<3 else 0)
                assert col==want,(look,s,movie,col,want);columns+=1
                # Official logs: movie mode with HDR Tone / Hard Monotone (0x363 / 0x364), and the
                # default case (0x375) for any look but the official ones and this build's films.
                want_log=([0x363] if movie and look==14 else [])+([0x364] if movie and look==20 else [])+([] if 11<=look<=22 or (film(look) and s<3) else [0x375])
                assert logged==want_log,(look,s,movie,logged)
    report['base_columns']=columns
    # 3. Official line functions on the new entries (against Standard's).
    for movie in (0,1):
        for s in range(3):
            fc,sc=36-11*s,0
            n.controller(64,s,movie)
            for line in range(len(std[s])):
                assert n.call(IS_VALID,CTL,s,fc,line)==n.call(IS_VALID,CTL,s,sc,line);calls+=2
            last=n.call(IS_VALID,CTL,s,fc,len(std[s]));calls+=1
            assert last==(1 if movie==0 else 0),(s,movie,last)
            assert n.call(LINE_COUNT,CTL,s,fc)-n.call(LINE_COUNT,CTL,s,sc)==last;calls+=2
            c.mem_write(CTL+0x19a,bytes([fc]));n.focus=len(std[s]);assert n.call(CURRENT_KIND,CTL)==10;calls+=1
    # 4. Hooks. A table of levels to read back: set through slots2.c itself.
    rec=fresh_record(random.Random(5));c.mem_write(REC,bytes(rec));c.mem_write(SETTINGS,struct.pack('<I',REC))
    assert n.boot();calls+=1
    own=manifest['lookEntries']['ownParameters'];fn=lambda name:own['module']+own['exports'][name]
    level=lambda look,s:(look*7+s*5)%3
    for look in range(64,64+films):
        for s in range(3):n.call(fn('sp_hal_put'),look,s,level(look,s));calls+=1
    looks=list(range(0,24))+list(range(60,90))+[255]
    hooks=0
    for look in looks:
        for s in range(4):
            isfilm=film(look) and True
            lv=level(look,s) if film(look) and s<3 else 0
            n.controller(look,s)
            # Name: Halation's text for kind 10 of a film, the official text otherwise.
            for kind in (7,8,9,10,14,17):
                for flags in (0,15):
                    out,vals,f=n.site(SUBTITLE,{0:kind,3:SUBTITLE_TABLE+kind*4,4:CTL},flags);calls+=1
                    official=struct.unpack('<H',orig(SUBTITLE_TABLE+kind*4+2,2))[0]
                    assert out[1]==(hal_text if kind==10 and isfilm else official),(look,kind)
                    assert out[0]==kind and out[2:4]==vals[2:4];hooks+=1
            out,vals,_=n.site(SCALE,{6:CTL});assert out[3]==(hal_scale if isfilm else 0xd3) and out[:3]==vals[:3];hooks+=1
            out,vals,_=n.site(LIST_ICON,{0:0x111,2:0x222,6:CTL});assert out[1]==(hal_icon if isfilm else 0x1e9) and (out[0],out[2])==(0x111,0x222);hooks+=1
            for at,ctl,kind in ((START,6,'stored'),(POSITION,5,'live')):
                out,vals,_=n.site(at,{0:0x6205c000,1:look,ctl:CTL});calls+=1
                if isfilm:assert out[0]==lv and not n.native,(look,s)
                else:assert out[0]==0x7777 and n.native==[(kind,0x6205c000,look)]
                hooks+=1
            buf=REGION+0x9000;c.mem_write(buf,b'\xa5'*4)
            out,vals,_=n.site(LIST_TEXT,{0:0x62049000,1:buf,6:CTL})
            if isfilm:assert bytes(c.mem_read(buf,4))==[b'--\0',b'W\0\0',b'S\0\0'][lv]+b'\xa5' and not n.native
            else:assert n.native==[('text',0x62049000,buf)]
            hooks+=1
            for v in (0,1,2):
                out,vals,_=n.site(SETTER,{0:0x6205c000,1:v,4:CTL});calls+=1
                if isfilm:
                    assert not n.native and n.call(fn('sp_hal'),look,s)==(v if s<3 else 0)
                    n.call(fn('sp_hal_put'),look,s,lv)
                else:assert n.native==[('hdr',0x6205c000,v)]
                hooks+=1
    report['hook_cases']=hooks
    # Cancel: the thunks of the parameter backup and restore keep and put back the levels.
    for at,body in ((0x532c337c,0x532c325c),(0x532c34a8,0x532c33c8)):
        if at==0x532c34a8:n.call(fn('sp_hal_put'),64,0,(level(64,0)+1)%3);assert n.call(fn('sp_hal'),64,0)!=level(64,0)
        c.reg_write(reg.UC_ARM_REG_SP,STACK);c.reg_write(reg.UC_ARM_REG_LR,0x5a5a5a5a);c.reg_write(reg.UC_ARM_REG_R0,0x6205c000)
        c.emu_start(at,body,count=5000)
        assert c.reg_read(reg.UC_ARM_REG_PC)==body and c.reg_read(reg.UC_ARM_REG_SP)==STACK and c.reg_read(reg.UC_ARM_REG_LR)==0x5a5a5a5a and c.reg_read(reg.UC_ARM_REG_R0)==0x6205c000
        calls+=1
    assert n.call(fn('sp_hal'),64,0)==level(64,0)   # Cancel put the level back
    report['cancel_restores']=True
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),films=films,calls=calls,**report,hardware_tested=False,
        scope='Patched ImageControlDetailController functions and hook stubs with a synthetic controller; widgets not drawn.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('rtos','manifest','report'):p.add_argument('--'+s,type=Path,required=True)
    a=p.parse_args();result=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()))
    with a.report.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))
