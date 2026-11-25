#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Read the 96-byte plain subject-AF record (tag 0xc7a3, schema 4/6/7/9) from JPEG/DNG files.

Schema 7/9 = subject network (96x64 thumbnail, 12x8 score grid); 4 and 6 = the earlier tree model."""
import argparse,json,struct
from pathlib import Path
MAGIC=b'GRAFDIAG';SIZE=96
GATES={0:'ok',1:'not the AF start',2:'camera objects not ready',3:'movie',4:'not auto-area AF / temporary focus mode',5:'manual point set',6:'previous half-press still running',7:'no live-view thumbnail yet',8:'thumbnail too old',9:'box could not be mapped'}
MODEL={0:'box produced',1:'off',4:'blank frame',5:'budget',6:'bad argument',7:'bad frame',8:'bad model'}
MODEL7={0:'box produced',1:'bad argument -> centre box',2:'bad model -> centre box',3:'workspace too small -> centre box',4:'blank frame -> centre box',9:'thumbnail too old -> centre box'}
LV={10:'direct canvas: picture size or origin inconsistent',1:'recipe/visible window',2:'error flag',3:'buffer object',4:'profile',5:'format not NV12',6:'geometry',7:'plane pointer',8:'UV plane',9:'cache range',14:'visible window missing',15:'sampler rejected'}
POINT={0:'not run',1:'stock frame preparation failed',2:'frame already there',3:'stock did not take the new frame',4:'frame moved',5:'frame moved (UI mirror differs)',6:'previous half-press still running',16:'no live-view thumbnail yet',17:'thumbnail too old',18:'network gave no answer',19:'stock objects not ready',20:'not the full 3:2 frame'}
FOCUS={0:'AutoArea',1:'Select',2:'SelectContinuous',4:'Pinpoint',5:'Follow (tracking)',6:'Continuous',9:'Mf',10:'Snap',11:'Infinity'}
LATE={0:'not needed (thumbnail at most 10 calls old)',1:'no frame arrived after the half-press before the photo',2:'box recomputed from a frame taken after the half-press',7:'box replaced after the first one had already been offered (stock AF ignores that)',3:'no frame arrived within 90 calls',4:'network gave no answer on the new frame',5:'new box could not be mapped',6:'new frame could not be read'}
SOUND={0:'swapped',1:'cue switched off',2:'this focus did not use the AI box',3:'short sound asset missing'}
HOOKS=['half-press','live-view frame','face getter','in-focus sound','JPEG','DNG','AF pass end','record setter']
def fnv(d):
 h=2166136261
 for b in d:h=((h^b)*16777619)&0xffffffff
 return h
def decode(b):
 u=lambda p:struct.unpack_from('<H',b,p)[0];s=lambda p:struct.unpack_from('<h',b,p)[0];u32=lambda p:struct.unpack_from('<I',b,p)[0]
 if len(b)!=SIZE or b[:8]!=MAGIC or u(8)not in(4,6,7,9,10,11,12,13)or u(10)!=SIZE or u32(92)!=fnv(b[:92]):raise ValueError('not a schema-4/6/7/9..13 record')
 f=u32(12);box=[u(60+2*i)for i in range(4)];roi=[u(68+2*i)for i in range(4)]
 used=bool(f&8)
 v=u(8)
 sat=lambda raw,shift:None if raw==65535 else raw<<shift   # 65535 = field full: the counter was read on another core, not a time
 timing=None if v<6 else dict(note='CPU cycles; 0 = counter unavailable; null = unusable sample (task changed core)',modelCycles=sat(u(52),13 if v>=7 else 10),
  **(dict(benchCycles=u(54)<<8,benchMacs=262136,cyclesPerMac=round((u(54)<<8)/262136,2))if v<9 else{}),**(dict(lvTickCycles=sat(u(56),12))if v<12 else{}),**(dict(sampleCycles=sat(u(90),8))if v<10 else{}))
 if v>=9 and timing['modelCycles']:timing['modelMsAt450MHz']=round(timing['modelCycles']/450e3,1)   # 450 MHz: v41, live-view tick = 7.5M cycles at 60 fps
 rejected=None if v<9 or v==12 else dict(note='last live-view recipe the sampler refused',kindFlags={n:bool(b[54]>>i&1)for i,n in enumerate(('bbd','bbe','bbf','bc0','bc1','bc2','bc3','bbc'))},
  recipeWord8=b[55]&15,descriptorFormat=(b[55]>>4)&3,displayRecipesProcessedAtHalfPress=bool(b[55]&64),process81AtHalfPress=bool(b[55]&128))
 lv6=dict(thumbnails=u(28),rejected=u(30),lastRejectStepRaw=b[32],lastRejectStep=LV.get(b[32],'none'if not b[32]else'?'),**(dict(lastRejected=rejected)if rejected else{}))
 return dict(version=v,timing=timing,flags=f,photoSequence=u(16),
  aiUsedForThisFocus=used,latestHalfPressProducedBox=bool(f&16),stateReady=bool(f&4),allocationFailed=bool(f&64),cueEnabled=bool(f&2),dng=bool(f&32),
  halfPress=dict(runs=u(18),skipped=u(20),lastGateRaw=b[22],lastGate=GATES.get(b[22],'?'),lastModelRaw=b[23],lastModel=(MODEL7 if v>=7 else MODEL).get(b[23],'?'),boxesProduced=u(24),modelFailures=u(26),thumbnailAgeTicks=b[33]),
  liveView=lv6 if v>=6 else dict(thumbnails=u(28),rejected=u(30),lastRejectStepRaw=b[32],lastRejectStep=LV.get(b[32],'none'if not b[32]else'?'),profile=b[52],format=b[53]&15,softBits=b[53]>>4,activeWidth=b[54]*8,activeHeight=b[55]*8,canvasWidth=b[56]*8,yAddressHigh=hex(b[57])),
  faceGetter=dict(categoryCalls=u(34),boxGivenAsCategory=u(36),boxGivenAsRegion=u(38),boxGivenAsRectangle=u(40),stockFaceWon=u(42),noFreshBox=u(44)),
  sound=dict(focusSoundCalls=u(46),swapped=u(48),lastRaw=b[50],last=SOUND.get(b[50],'?')),
  hooksSeen=[n for i,n in enumerate(HOOKS)if b[51]&(1<<i)],
  settings=dict(focusLimiterDesired=b[58]&3,focusLimiterEffective=(b[58]>>2)&3,afRangeDesired=(b[58]>>4)&3,afRangeEffective=b[58]>>6,focusModeRaw=b[59],focusMode=FOCUS.get(b[59],'?')),
  aiFrame=None if not(v>=7 and f&128)else dict(builtIn=True,faceFollowBuiltIn=bool(f&512),placedForThisHalfPress=bool(f&256),startedOn={254:'stock face',253:'stock eye'}.get(b[80],'network cell')if b[59]in(5,6)else None,**(dict(uiX720=roi[0],uiY480=roi[1],lastRaw=roi[2],last=POINT.get(roi[2],'?'),runs=roi[3],cellLeftPct=round(box[0]/655.36,1),cellTopPct=round(box[1]/655.36,1),bestCell=b[80])if b[59]in(5,6)else{})),
  box=None if not f&16 else dict(leftPct=round(box[0]/655.36,1),topPct=round(box[1]/655.36,1),rightPct=round(box[2]/655.36,1),bottomPct=round(box[3]/655.36,1),
   regionWHXY720x480=roi,ticksSinceBox=u(82),offerExpiredBeforeCapture=u(82)>90,**(dict(bestScore=round(s(76)/256,2),secondScore=round(s(78)/256,2),centreFallback=b[80]==255,bestCell=b[80],bestCellColRow=None if b[80]==255 else[b[80]%12,b[80]//12],grid='12x8',lumaVariance=b[81])if v>=7 else
    dict(scoreQ12=s(76),presenceQ12=s(78),oldGatesWouldReject=bool(b[80]),texturedWindows=b[81]))),
  boxId=u(84),usedBoxId=u(86),previousAttachResult=u(88),**(dict(lateBox=dict(stateRaw=b[90],state=LATE.get(b[90],'?'),**(dict(frameTicksAfterHalfPress=b[91]if b[90]in(2,7)else None)if v in(10,13)else dict(computedBeforeAnyBoxWasOffered=b[90]==2,waitedMs=(4 if v>=12 else 2)*(b[91]&63),**(dict(waitingTask=b[54],otherReaderKeptWaiting=b[55],otherReadsKeptWaiting=b[57],liveViewTask=b[56])if v>=12 else{}),frameTicksAfterHalfPress=(b[91]>>6)if b[90]in(2,7)else None))))if v>=10 else{}),**(dict(thumbnailSource=dict(note='direct canvas = the frame stock live view shows between half-presses',halfPressUsedDirectCanvas=bool(b[56]&1),newestIsDirectCanvas=bool(b[56]&2),directCanvasThumbnails=b[57]))if v>=13 else{}))
def miniature(b):
 if len(b)!=SIZE or b[:8]!=MAGIC or struct.unpack_from('<HH',b,8)not in((5,SIZE),(8,SIZE)):raise ValueError('not a miniature')
 v=struct.unpack_from('<H',b,8)[0]
 return dict(version=v,kind='thumbnail miniature 10x8 luminance',source='96x64'if v==8 else'90x70',boxId=struct.unpack_from('<H',b,12)[0],photoSequence=struct.unpack_from('<H',b,14)[0],rows=[list(b[16+10*y:26+10*y])for y in range(8)])
def scan(data):
 out=[];i=0
 while True:
  i=data.find(MAGIC,i)
  if i<0:break
  for f in(decode,miniature):
   try:out.append(dict(f(data[i:i+SIZE]),offset=i));break
   except ValueError:pass
  i+=1
 return out
if __name__=='__main__':
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('paths',nargs='+',type=Path);ap.add_argument('--output',type=Path);a=ap.parse_args()
 files=[]
 for p in a.paths:files+=sorted(q for q in p.iterdir()if q.suffix.lower()in('.jpg','.dng'))if p.is_dir()else[p]
 res=[dict(file=str(p),records=scan(p.read_bytes()))for p in files]
 text=json.dumps(dict(files=res),indent=1,ensure_ascii=False)
 a.output.write_text(text+'\n')if a.output else print(text)
