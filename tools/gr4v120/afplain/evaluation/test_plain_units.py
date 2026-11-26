#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Unit checks of the plain runtime inside the built RTOS image (Unicorn).

Drives af_s1_dispatch directly with synthetic recipe/process/photo objects:
thumbnail rotation with alternating unusable recipes, half-press gates and box,
getter rules (stock answer first, category latch, window expiry, AF-pass end),
sound swap, and the 96-byte photo record round trip through read_plain.py."""
import argparse,hashlib,importlib.util,json,os,struct,sys
from pathlib import Path
ap=argparse.ArgumentParser(description=__doc__)
for n in['artifact','repo','output']:ap.add_argument('--'+n,type=Path,required=True)
a=ap.parse_args();here=Path(__file__).resolve().parent
m=json.loads((a.artifact/'manifest.json').read_text());inst=m['installed'];mb=m['moduleBuild']
os.environ['GRIV_RTOS']=str(a.artifact/'patched-RTOS.bin');sys.path.insert(0,str(here))
import fwemu;fwemu.RTOS=str(a.artifact/'patched-RTOS.bin')
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *
spec=importlib.util.spec_from_file_location('rd',here.parent/'metadata/read_plain.py');rd=importlib.util.module_from_spec(spec);spec.loader.exec_module(rd)
e=fwemu.Emu();mu=e.mu;mu.mem_map(0x59600000,0x01000000);e.heap=0x59600000
mp=next(x for x in mb['maps']if x['origin']==0x54450000);DISPATCH=inst['module']+mp['symbols']['af_s1_dispatch']-mp['origin'];CTX=inst['context'];TRAMP=inst['nativeGetterTrampoline']
U,F,SOUND,CAF,ST=0x550832a8,0x550873e4,0x55087450,0x550a569c,0x55839080
LP,C,B,M,POOL,I,REGS,OWNER,IFD,ENTRY,DATA,VEC,WAVE1,WAVE2,OUT,BADC,BADB,ENTRY2,DATA2=[0x60400000+i*0x10000 for i in range(19)];Y=0x62000000
native60=[bytes(60)];native_calls=[0]
def ret(cpu,v=0):cpu.reg_write(UC_ARM_REG_R0,v);cpu.reg_write(UC_ARM_REG_PC,cpu.reg_read(UC_ARM_REG_LR))
def tramp(cpu,*_):native_calls[0]+=1;cpu.mem_write(cpu.reg_read(UC_ARM_REG_R1),native60[0]);ret(cpu)
mu.hook_add(UC_HOOK_CODE,tramp,begin=TRAMP,end=TRAMP)
for fn in[0x53918010,0x5391808c]:mu.hook_add(UC_HOOK_CODE,lambda cpu,*_:ret(cpu),begin=fn,end=fn)
mu.hook_add(UC_HOOK_CODE,lambda cpu,*_:ret(cpu,1000),begin=0x5380e728,end=0x5380e728)
def w(at,fmt,*v):mu.mem_write(at,struct.pack('<'+fmt,*v))
def static():
 names='state_word seen frames_ok frames_bad last_bad_step s1_runs s1_skips s1_last_gate model_ok model_fail model_last frame_age cat_calls supplied_cat supplied_region supplied_rect native_wins no_box sound_calls sound_swaps sound_last photo_seq attach_last lv_profile lv_format lv_w lv_h lv_cw lv_yhigh'.split()
 d=dict(zip(names,struct.unpack('<%dI'%len(names),e.rb(ST,4*len(names)))));r=struct.unpack('<8I2i6I',e.rb(ST+4*len(names),64));d['late_state'],d['late_ticks'],d['late_wait'],d['late_offered'],d['late_task'],d['late_other_task'],d['late_others'],d['lv_task']=struct.unpack('<8I',e.rb(ST+4*len(names)+64+40,32));d['direct_ok'],d['lv_direct'],d['hp_direct']=struct.unpack('<3I',e.rb(ST+4*len(names)+64+40+32+12,12))
 d.update(box=list(r[:4]),roi=list(r[4:8]),score=r[8],presence=r[9],gated=r[10],texture=r[11],box_id=r[12],box_tick=r[13],used_id=r[14],now_tick=r[15]);return d
def dispatch(op,regs=None,a0=None):
 if regs is not None:
  full=[0]*14
  for k,v in regs.items():full[k]=v
  w(REGS,'14I',*full);a0=REGS
 v=e.call(DISPATCH,op,a0,0,CTX,count=900_000_000);assert mu.reg_read(UC_ARM_REG_PC)==fwemu.SENTINEL
 return v,list(struct.unpack('<14I',e.rb(REGS,56)))
# camera objects
w(0x55083244,'I',1);w(0x550873d8,'I',1)
for at in[U+0x7c,U+0xbc0,F+0x15]:w(at,'B',13)
VIS=(2949120,1966080,0,0);AW,AH,W_,H_=1920,1088,1152,480
w(LP+0x3a0,'I',I);w(LP+0x3a8,'I',M);w(LP+0x3b0,'I',POOL);w(LP+0x94,'I',8192);w(POOL+8,'II',C,BADC);w(I+0x64,'4I',*VIS)
w(C+0x330,'I',M);w(C+0x334,'I',B);w(B+0xa,'B',3);w(C+0xbbd,'B',1);w(C+4,'B',2);w(C+0xbf0,'I',8192);w(C+0xa08,'B',2);w(C+0xa0c,'II',Y,Y+AW*AH);w(C+0xa18,'6H',W_,H_,AW,AH,0,0)
w(BADC+0x330,'I',M);w(BADC+0x334,'I',BADB);w(BADB+0xa,'B',3);w(BADC+0xa08,'B',1)           # the format-1, zero-size recipe seen on the camera
def picture(shift):
 rows=bytearray(AW*AH)
 for yy in range(H_):rows[yy*AW:yy*AW+W_]=bytes(((xx//8)*3+(yy//6)*5+shift)&255 for xx in range(W_))
 mu.mem_write(Y,bytes(rows));mu.mem_write(Y+AW*AH,b'\x80'*(AW*AH//2))
TW,TH=96,64
def expect(shift):
 f=lambda i,j:((((2*i+1)*W_//(4*TW))//8)*3+(((2*j+1)*H_//(4*TH))//6)*5+shift)&255
 return bytes(v for yy in range(TH)for xx in range(TW)for v in[(f(2*xx,2*yy)+f(2*xx+1,2*yy)+f(2*xx,2*yy+1)+f(2*xx+1,2*yy+1)+2)>>2]*3)
def collect(c=C):dispatch(2,{0:c,2:1,4:LP})
def state():return e.r32(ST)
def published():
 s=state();p=e.r32(s+4);return p>>2,p&3
FRAME=4+4+72+18900;FRAME+=(-FRAME)%4   # struct pl_frame
def thumb(i):return e.rb(state()+32+i*FRAME+8+72,3*TW*TH)   # frames follow magic, published, tick and the five want/hold words
TID=[217]
mu.hook_add(UC_HOOK_CODE,lambda cpu,*_:ret(cpu,TID[0]),begin=0x53067e2c,end=0x53067e2c)   # stock: id of the running task
_collect=collect
def collect(c=C):
 TID[0]=8;_collect(c);TID[0]=217
rows=[]
# 1. thumbnails: alternate with the unusable recipe; a usable frame is sampled once the last thumbnail is 8 calls old
picture(0);collect(BADC);assert state()>=0x59600000 and static()['frames_bad']==1 and static()['last_bad_step']==5 and published()==(0,0)
collect();t1,i1=published();assert static()['frames_ok']==1 and thumb(i1)==expect(0)
picture(7);collect(BADC);collect();collect(BADC);collect();assert published()==(t1,i1),'no new thumbnail inside the sampling gap'
for _ in range(3):collect(BADC);collect()
t2,i2=published();assert i2==(i1+1)%3 and t2>t1 and thumb(i2)==expect(7)and thumb(i1)==expect(0)
st=static();assert(st['lv_profile'],st['lv_format']&15,st['lv_w'],st['lv_h'],st['lv_cw'],st['lv_yhigh'])==(3,2,1152,480,1920,0x62)
rows.append(dict(case='thumbnails: unusable recipes skipped without losing anything; three-buffer rotation; bytes equal the expected sampling',ok=True,framesOk=st['frames_ok'],framesBad=st['frames_bad']))
# 2. half-press gates
def press(r1=0x42410808):dispatch(1,{1:r1,6:F});return static()
s0=static();assert press(0x42410809)['s1_runs']==s0['s1_runs'],'other messages are ignored'
w(U+0xb76,'B',1);assert press()['s1_last_gate']==3;w(U+0xb76,'B',0)
w(U+0xc1d,'B',1);assert press()['s1_last_gate']==4;w(U+0xc1d,'B',0)
w(F+0x10,'B',1);assert press()['s1_last_gate']==5;w(F+0x10,'B',0)
assert static()['model_ok']==0 and static()['box_tick']==0
rows.append(dict(case='half-press gates: other message ids, movie, non auto-area, manual point -> no box',ok=True))
# 3. half-press with a real picture: use the frozen fixture frame so the model has content
fx=json.loads((Path(os.environ.get('AF_FIXTURES',''))/'fixture.json').read_text())if os.environ.get('AF_FIXTURES')else None
if fx:
 import numpy as np
 r=next(x for x in fx['rows']if x['aspect']==0);fd=Path(os.environ['AF_FIXTURES']);yy=np.frombuffer((fd/r['yFile']).read_bytes(),np.uint8).reshape(480,720);uv=np.frombuffer((fd/r['uvFile']).read_bytes(),np.uint8).reshape(240,720)
 w(C+0xa18,'6H',720,480,AW,AH,0,0);py=np.full((AH,AW),0xa5,np.uint8);pu=np.full((AH//2,AW),0x80,np.uint8);py[:480,:720]=yy;pu[:240,:720]=uv;mu.mem_write(Y,py.tobytes()+pu.tobytes())
 for _ in range(10):collect()
blocks=[0,0]
def count(cpu,address,size,_):blocks[0]+=1;blocks[1]+=size//4
hk=mu.hook_add(fwemu.UC_HOOK_BLOCK if hasattr(fwemu,'UC_HOOK_BLOCK')else __import__('unicorn').UC_HOOK_BLOCK,count,begin=inst['module'],end=inst['module']+inst['moduleBytes'])
st=press();mu.hook_del(hk);assert st['s1_last_gate']==0 and st['model_last']==0 and st['model_ok']==1 and st['box_tick']and st['box_id']>=1,st
assert 0<=st['box'][0]<st['box'][2]<=65536 and 0<=st['box'][1]<st['box'][3]<=65536 and st['roi'][0]and st['roi'][1],st
rows.append(dict(case='half-press runs the model on the newest thumbnail and publishes a mapped box',ok=True,halfPressModuleInstructions=blocks[1],bestCell=st['gated'],boxQ16=st['box'],regionQ12WHXY=st['roi'],frameAgeTicks=st['frame_age']))
BOX=struct.pack('<4I',*st['roi'])+bytes(44)
# 4. getter
def get(lr,r0=0x1234):
 mu.mem_write(OUT,b'\xee'*60);v,_=dispatch(8,{0:r0,1:OUT,2:0,13:lr});return v,e.rb(OUT,60)
n0=native_calls[0];v,out=get(0x53000000);assert v==0 and out==b'\xee'*60 and native_calls[0]==n0,'foreign caller: stock runs untouched'
v,out=get(0x5361adf4);assert v==1 and out==bytes(60),'region before any category decision keeps the stock answer'
v,out=get(0x5360ecd0);assert v==1 and out==BOX and static()['supplied_cat']==1
v,out=get(0x5361adf4);assert out==BOX and static()['supplied_region']==1 and static()['used_id']==static()['box_id']
v,out=get(0x536120b0);assert out==BOX and static()['supplied_rect']==1
native60[0]=struct.pack('<4I',9<<12,9<<12,1<<12,1<<12)+bytes(44)
v,out=get(0x5360ecd0);assert out==native60[0]and static()['native_wins']>=1,'a stock face always wins'
v,out=get(0x5361adf4);assert out==native60[0];native60[0]=bytes(60)
v,out=get(0x5361adf4);assert out==bytes(60),'a stock face drops the latch'
v,out=get(0x5360ecd0);assert out==BOX;dispatch(12,{5:CAF});v,out=get(0x5361adf4);assert out==bytes(60),'AF pass end drops the latch'
w(U+0xc1d,'B',1);v,out=get(0x5360ecd0);assert out==bytes(60);w(U+0xc1d,'B',0)
rows.append(dict(case='getter: foreign callers untouched; stock answer first; category latches the box for region/rectangle; stock face, AF-pass end and mode change drop it',ok=True))
# 5. sound
w(SOUND+4,'I',WAVE1);w(SOUND+0xc,'I',WAVE2);w(SOUND+0x14,'I',8420);w(SOUND+0x1c,'I',25604);mu.mem_write(WAVE1,b'RIFF\0\0\0\0WAVE');mu.mem_write(WAVE2,b'RIFF\0\0\0\0WAVE')
def play(lr=0x533a1dfc):
 v,r=dispatch(26,{0:SOUND,1:WAVE2,2:25604,13:lr});return v,r[1],r[2]
get(0x5360ecd0);get(0x5361adf4)
assert play(0x53000000)==(0,WAVE2,25604),'other sounds untouched'
assert play()==(1,WAVE1,8420)and static()['sound_swaps']==1
assert play()==(0,WAVE2,25604)and static()['sound_last']==2,'one swap per focus'
rows.append(dict(case='sound: in-focus sound swapped once for a focus that used the box; other callers untouched',ok=True))
# 6. window expiry and a new half-press
for _ in range(100):collect(BADC)
v,out=get(0x5360ecd0);assert out==bytes(60)and static()['no_box']>=1,'the box is offered for a limited time only'
old=static()['box_id'];collect();collect();collect();st=press();assert st['box_id']==old+1 and st['box_tick']
get(0x5360ecd0);get(0x5361adf4)
rows.append(dict(case='box expires after the window; a new half-press replaces it',ok=True))
# 7. photo record through the stock-vector update path
w(OWNER+0x124+4,'I',OWNER+0x134);mu.mem_write(OWNER+0x134,bytes(0x38));w(OWNER+0x134+12,'3I',VEC,VEC+8,VEC+16);w(VEC,'II',ENTRY,ENTRY2)
w(ENTRY2+4,'HH',0xc7a2,7);w(ENTRY2+8,'I',96);w(ENTRY2+16,'I',DATA2);mu.mem_write(DATA2,b'GRAFDIAG'+bytes(88))
w(ENTRY+4,'HH',0xc7a3,7);w(ENTRY+8,'I',96);w(ENTRY+16,'I',DATA);mu.mem_write(DATA,b'GRAFDIAG'+bytes(88))
e.call(DISPATCH,5,OWNER,0,CTX,count=900_000_000);rec=rd.decode(e.rb(DATA,96));st=static()
assert st['attach_last']==2 and rec['aiUsedForThisFocus']and rec['latestHalfPressProducedBox']and rec['stateReady']and rec['cueEnabled']
assert rec['halfPress']['boxesProduced']==st['model_ok']and rec['faceGetter']['boxGivenAsRegion']==st['supplied_region']and rec['sound']['swapped']==1
assert rec['version']==13 and rec['box']['bestCell']==st['gated']<96 and set(rec['timing'])>={'modelCycles'} and 'benchCycles' not in rec['timing'] and 'lateBox' in rec and rec['box']['regionWHXY720x480']==[v>>12 for v in st['roi']]
mini=rd.miniature(e.rb(DATA2,96));assert mini['version']==8 and mini['boxId']==st['box_id']&65535 and len(mini['rows'])==8 and max(map(max,mini['rows']))>min(map(min,mini['rows']))
assert set(rec['hooksSeen'])=={'half-press','live-view frame','face getter','in-focus sound','JPEG','AF pass end'}
rows.append(dict(case='photo record: 96 bytes written through the stock entry and decoded by read_plain.py; second entry carries the 10x8 thumbnail miniature',ok=True,record=rec,miniature=mini))
# 8. MakerNote data setter: our tag must not reach the stock setter (it zeroes the payload; seen on the camera)
stock=[0];mu.hook_add(UC_HOOK_CODE,lambda cpu,*_:(stock.__setitem__(0,stock[0]+1),ret(cpu,0)),begin=0x53835ac0,end=0x53835ac0)
SETTER=e.r32(0x53fddf34);assert SETTER!=0x53835ac0
w(ENTRY+4,'H',0xc7a3);v=e.call(SETTER,0x1234,ENTRY,0,count=2_000_000);assert v==1 and stock[0]==0 and e.rb(DATA,8)==b'GRAFDIAG'
w(ENTRY+4,'H',0x0005);e.call(SETTER,0x1234,ENTRY,0,count=2_000_000);assert stock[0]==1,'every other tag still goes to the stock setter'
w(ENTRY+4,'H',0xc7a3)
rows.append(dict(case='record setter: tag 0xc7a3 skips the stock data setter; other tags reach it unchanged',ok=True))
# 9. the network has no answer (blank frame): the box is the middle of the frame, never empty
mu.mem_write(Y,b'\x80'*(AW*AH+AW*AH//2));w(ENTRY+4,'H',0xc7a3)
for _ in range(20):collect()
ok0=static()['model_ok'];st=press();assert st['s1_last_gate']==0 and st['model_last']==4 and st['box_tick']and st['gated']==255 and st['model_ok']==ok0,st
assert st['box']==[5*5461,3*8192,7*5461,5*8192]and st['roi'][0]and st['roi'][1],st
v,out=get(0x5360ecd0);assert out==struct.pack('<4I',*st['roi'])+bytes(44),'the centre box is offered like any other'
e.call(DISPATCH,5,OWNER,0,CTX,count=900_000_000);rec=rd.decode(e.rb(DATA,96));assert rec['box']['centreFallback']and rec['halfPress']['lastModel']=='blank frame -> centre box',rec
rows.append(dict(case='no answer from the network (blank frame): centre box is published instead of leaving the choice to stock AF',ok=True,boxQ16=st['box']))
# 10. a half-press the mode gate refuses leaves no box and no "used" mark of the previous one in the record
w(U+0xc1d,'B',1);st=press();w(U+0xc1d,'B',0);assert st['s1_last_gate']==4 and st['box_tick']==0 and st['late_state']==0,st
e.call(DISPATCH,5,OWNER,0,CTX,count=900_000_000);rec=rd.decode(e.rb(DATA,96));assert rec['box']is None and not rec['aiUsedForThisFocus']and not rec['latestHalfPressProducedBox']and rec['halfPress']['lastGateRaw']==4,rec
rows.append(dict(case='refused half-press clears the previous box from the record',ok=True))
# 11. v43/v44/v46: a half-press without a thumbnail of the last 10 calls offers the centre box at once (nothing
#     waits any more); a frame taken after the half-press replaces the box once, recorded as too late.
CENTRE=[5*5461,3*8192,7*5461,5*8192];CAT=0x5360ecd0;sleeps=[]
def _sleep(cpu,*_):sleeps.append(cpu.reg_read(UC_ARM_REG_R0));ret(cpu,0)
mu.hook_add(UC_HOOK_CODE,_sleep,begin=0x53909c88,end=0x53909c88)
# (the picture is still the blank one of case 9)
for _ in range(100):collect(BADC)
ok0=static()['model_ok'];st=press();centre=struct.pack('<4I',*st['roi'])+bytes(44)
assert st['s1_last_gate']==0 and st['frame_age']>10 and st['model_last']==9 and st['gated']==255 and st['box']==CENTRE and st['box_tick']and st['late_state']==1 and st['model_ok']==ok0,st
v,out=get(CAT);st=static();assert sleeps==[] and out==centre and st['late_state']==1,('the centre box is offered at once',st)
collect();v,out=get(CAT);st=static();assert st['late_state']==4 and out==centre and st['gated']==255,('blank new frame: no answer, the centre box stays',st)
e.call(DISPATCH,5,OWNER,0,CTX,count=900_000_000);rec=rd.decode(e.rb(DATA,96));assert rec['box']['centreFallback']and rec['lateBox']['stateRaw']==4 and not rec['thumbnailSource']['halfPressUsedDirectCanvas'],rec
if fx:
 mu.mem_write(Y,py.tobytes()+pu.tobytes())
 for _ in range(100):collect(BADC)
 ok0=static()['model_ok'];st=press();assert st['gated']==255 and st['late_state']==1,st
 v,out=get(CAT);assert out==struct.pack('<4I',*st['roi'])+bytes(44)
 collect(BADC);collect();v,out=get(CAT);st=static()
 assert st['late_state']==7 and st['late_ticks']==2 and st['gated']<96 and st['box']!=CENTRE and st['model_last']==0 and st['model_ok']==ok0+1,st
 assert out==struct.pack('<4I',*st['roi'])+bytes(44)
 e.call(DISPATCH,5,OWNER,0,CTX,count=900_000_000);rec=rd.decode(e.rb(DATA,96))
 assert rec['lateBox']['stateRaw']==7 and rec['lateBox']['frameTicksAfterHalfPress']==2 and not rec['box']['centreFallback']and rec['box']['bestCell']==st['gated'],rec
 v,out2=get(CAT);assert out2==out and static()['model_ok']==ok0+1,'recomputed once per half-press'
 # thumbnail at most 10 calls old: the network's box at the half-press itself
 st=press();assert st['frame_age']<=10 and st['model_last']==0 and st['gated']<96 and st['late_state']==0,st
 v,out=get(CAT);assert out==struct.pack('<4I',*st['roi'])+bytes(44)
 # nothing newer within 90 calls -> expired
 for _ in range(100):collect(BADC)
 press();get(CAT)
 for _ in range(95):collect(BADC)
 get(CAT);assert static()['late_state']==3 and sleeps==[]
 rows.append(dict(case='half-press without a fresh thumbnail: centre box at once, no waiting; a frame after the half-press replaces the box once (marked too late); blank frame; expiry',ok=True,lateCell=rec['box']['bestCell'],record=rec['lateBox']))
# 12. v46: between half-presses the camera hands over "direct" recipes (c+bbd=1, no descriptor, c+a08=1). The thumbnail
#     comes from the canvas the stock display hand-over shows: c+2e8 + c+bdc, manager canvas size, active size and
#     origin from c+bd6.. (first with origin x=4 in a 1160-wide nominal picture, stock byte offset 4).
DC,DB=0x60400000+19*0x10000,0x60400000+20*0x10000
def direct(base=Y-8,x=4,off=4,nw=W_+8,bbd=1):
 w(DC+0x330,'I',M);w(DC+0x334,'I',DB);w(DB+0xa,'B',3);w(DC+0xbbd,'B',bbd);w(DC+0xa08,'B',1);w(DC+0x2e8,'I',base);w(DC+0xbdc,'I',off)
 w(DC+0xbd6,'H',W_);w(DC+0xbd8,'H',H_);w(DC+0xbe0,'H',x);w(DC+0xbe2,'H',0);w(DC+0xbea,'H',nw);w(DC+0xbec,'H',H_);w(DC+0xbf0,'I',8192)
w(M+0x214,'HH',AW,AH);w(POOL+8,'III',C,BADC,DC)
uvbak=e.rb(Y+AW*AH-4,4);picture(31);mu.mem_write(Y+AW*AH-4,b'\x80'*4);direct()
for _ in range(100):collect(BADC)
d0=static();collect(DC);st=static();t,i=published()
assert st['frames_ok']==d0['frames_ok']+1 and st['direct_ok']==d0['direct_ok']+1 and st['lv_direct']==1 and thumb(i)==expect(31),(st['last_bad_step'],st['frames_ok'],d0['frames_ok'])
# what the camera showed in v47: nominal picture 1152x480 (= active, origin 0) inside the 1920x1088 canvas; and the same with a left-over byte offset
for kw in[dict(base=Y,x=0,off=0,nw=W_),dict(base=Y-4,x=0,off=4,nw=W_)]:
 direct(**kw);picture(40+kw['off']);mu.mem_write(Y+AW*AH-4,b'\x80'*4)
 for _ in range(100):collect(BADC)
 d1=static();collect(DC);st=static();t,i=published()
 assert st['direct_ok']==d1['direct_ok']+1 and thumb(i)==expect(40+kw['off']),(kw,st['last_bad_step'])
for bad,step in[(dict(bbd=0),5),(dict(base=0),5),(dict(off=8),5),(dict(x=0),10),(dict(nw=AW+2),10),(dict(nw=W_-2,x=0),10),(dict(nw=0),10),(dict(base=0x54000000),7)]:
 direct(**bad);b0=static()['frames_bad']
 for _ in range(9):collect(DC)
 st=static();assert st['frames_bad']==b0+9 and st['last_bad_step']==step and published()==(t,i),(bad,st['last_bad_step'])
direct()
for _ in range(9):collect(DC)
st=press();assert st['frame_age']<=10 and st['late_state']==0 and st['hp_direct']==1 and st['s1_last_gate']==0,st
e.call(DISPATCH,5,OWNER,0,CTX,count=900_000_000);rec=rd.decode(e.rb(DATA,96));assert rec['thumbnailSource']['halfPressUsedDirectCanvas']and rec['thumbnailSource']['directCanvasThumbnails']>=2 and rec['lateBox']['stateRaw']==0,rec
if fx:
 mu.mem_write(Y,py.tobytes()+pu.tobytes());direct(base=Y,x=0,off=0,nw=W_)
 for _ in range(100):collect(DC)
 ok0=static()['model_ok'];st=press();v,out=get(CAT)
 assert st['frame_age']<=10 and st['late_state']==0 and st['gated']<96 and st['model_ok']==ok0+1 and st['hp_direct']==1 and out==struct.pack('<4I',*st['roi'])+bytes(44)and sleeps==[],st
rows.append(dict(case='direct canvas between half-presses: thumbnail equals the expected sampling at the stock byte offset; eight malformed recipes rejected; the camera geometry (1152x480 picture in a 1920x1088 canvas) accepted; the half-press then has a fresh thumbnail and offers the network box at once',ok=True,directThumbnails=static()['direct_ok']))
a.output.parent.mkdir(parents=True,exist_ok=True)
a.output.write_text(json.dumps(dict(ok=True,cases=len(rows),containerSha256=m['outputSha256'],moduleSha256=mb['code_sha256'],rows=rows,limits='Synthetic objects; stock getter, cache and MakerNote size functions are stubs. Box mapping runs the stock rectangle functions.'),indent=1,ensure_ascii=False)+'\n')
print(json.dumps(dict(ok=True,cases=len(rows))))
