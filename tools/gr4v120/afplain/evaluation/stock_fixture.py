# SPDX-License-Identifier: GPL-2.0-only
"""Controlled stock1.20 objects and separate-stack cooperative Common delivery."""
import hashlib,os,struct,sys
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *
# The decoded RTOS section of the official GR IV 1.20 file (never committed).
OFFICIAL_RTOS_SHA256='cf51224e6eb6bed79eeafa2e7923acf5434df39629510e75907c1dfbffab61a9'
def configure(rtos,repo):
 global Emu,SENTINEL
 assert hashlib.sha256(Path(rtos).read_bytes()).hexdigest()==OFFICIAL_RTOS_SHA256,'needs the official RTOS of this release'
 os.environ['GRIV_RTOS']=str(rtos);sys.path.insert(0,str(Path(__file__).resolve().parent))   # fwemu.py
 import fwemu
 fwemu.RTOS=str(rtos);Emu=fwemu.Emu;SENTINEL=fwemu.SENTINEL
O,BRIDGE,OPS,WR,SA,SB,G,U,F,POINT,OUT,SENSOR,EV=[0x60000000+0x20000*i for i in range(13)]
FRAME=(6000<<12,4000<<12,0,0)
class Fixture:
 def __init__(self):
  self.e=e=Emu();self.events=[];self.pending=[];self.app=[];self.acks=[];self.stop_region=False;self.region_hit=False
  self.face=struct.pack('<15I',120<<12,100<<12,1000<<12,800<<12,40<<12,30<<12,1020<<12,820<<12,40<<12,30<<12,1060<<12,820<<12,101,102,103)
  def ret(cpu,value=0):cpu.reg_write(UC_ARM_REG_R0,value);cpu.reg_write(UC_ARM_REG_PC,cpu.reg_read(UC_ARM_REG_LR))
  def loc(cpu,address,size,unused):ret(cpu,U if address==0x53240c38 else G)
  for fn in[0x532406a4,0x53240818,0x53240c38,0x5324111c,0x53750008]:e.mu.hook_add(UC_HOOK_CODE,loc,begin=fn,end=fn)
  def noop(cpu,address,size,unused):ret(cpu,1)
  for fn in[0x53907930,0x53907a84,0x53902fe8,0x53916064]:e.mu.hook_add(UC_HOOK_CODE,noop,begin=fn,end=fn)
  def app(cpu,address,size,unused):self.app.append([cpu.reg_read(UC_ARM_REG_R1),cpu.reg_read(UC_ARM_REG_R2)]);ret(cpu,1)
  e.mu.hook_add(UC_HOOK_CODE,app,begin=0x5325e2d8,end=0x5325e2d8)
  def queue(cpu,address,size,unused):
   event=cpu.reg_read(UC_ARM_REG_R2);payload=cpu.reg_read(UC_ARM_REG_R3);n={0x59:600,0x97:18,0x98:60,0x99:1,0x9a:1,0x9b:1}.get(event,4)
   self.events.append(dict(event=event,payload=e.rb(payload,n).hex()));self.pending.append((event,payload));cpu.emu_stop()
  e.mu.hook_add(UC_HOOK_CODE,queue,begin=0x53904f3c,end=0x53904f3c)
  def ack(cpu,address,size,unused):self.acks.append([cpu.reg_read(UC_ARM_REG_R0),cpu.reg_read(UC_ARM_REG_R1)]);ret(cpu,1)
  e.mu.hook_add(UC_HOOK_CODE,ack,begin=0x53902f30,end=0x53902f30)
  def wait(cpu,address,size,unused):ret(cpu,0)
  e.mu.hook_add(UC_HOOK_CODE,wait,begin=0x530684c8,end=0x530684c8)
  def region(cpu,address,size,unused):
   if self.stop_region:self.region_hit=True;cpu.emu_stop()
  e.mu.hook_add(UC_HOOK_CODE,region,begin=0x5361aaa4,end=0x5361aaa4)
 def reset(self,mode=1,phase=0,eligible=1,face=True):
  e=self.e
  for ptr,n in[(O,0x12000),(BRIDGE,0x400),(OPS,0x1000),(WR,0x10),(SA,0x1090),(SB,0x1090),(G,0x3000),(U,0x2000),(F,0x200),(SENSOR,0x3000)]:e.wb(ptr,bytes(n))
  self.events=[];self.pending=[];self.app=[];self.acks=[];self.stop_region=False;self.region_hit=False
  e.w32(O+0x50,BRIDGE);e.w32(BRIDGE+0x18,OPS);e.w32(BRIDGE+0x20,SENSOR);e.w32(OPS+0x518,WR);e.w32(WR,SA);e.w32(WR+4,SB);e.w32(G+4,OPS)
  e.wb(SENSOR+0x14,struct.pack('<4I',*FRAME));e.wb(O+0x11275,bytes([phase]))
  e.wb(U+0x7c,b'\x0d');e.wb(U+0xbc0,b'\x0d');e.wb(F+0x15,b'\x0d')
  for off in[0xdc,0xc1d,0xc20]:e.wb(U+off,bytes([mode]))
  e.wb(U+0xe0,struct.pack('<2i',360,240));e.wb(U+0xc24,struct.pack('<2i',360,240))
  e.wb(U+0x94,self.face if face else bytes(60));e.wb(U+0xbd8,self.face if face else bytes(60))
  basic=self.call(0x532a16d8,mode)
  dims=(5,5)if mode in[0,7]else(3,3)if mode in[14,15]else(1,1)
  area=struct.pack('<4I2B',600<<12,400<<12,200<<12,100<<12,*dims)
  e.wb(U+0x80,area);e.wb(U+0xbc4,area)
  for state in[SA,SB]:
   e.wb(state+0x6c0,struct.pack('<4I',*FRAME));e.wb(state+0x714,bytes([basic]));e.wb(state+0x718,area);e.wb(state+0x72c,self.face if face else bytes(60));e.wb(state+0x769,bytes([eligible]));e.wb(state+0x25c,self.face if face else bytes(60))
 def call(self,fn,*args):
  e=self.e;e.call(fn,*args,count=200000)
  while self.pending:
   event,ptr=self.pending.pop(0);context=e.mu.context_save()
   # A genuinely separate receiver stack is essential: byte-valued APIs pass
   # producer stack locals. Reusing Emu.call's SP would overwrite the payload.
   for reg,value in zip([UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3],[OPS,event,ptr,0]):e.mu.reg_write(reg,value)
   e.mu.reg_write(UC_ARM_REG_SP,0x7e080000);e.mu.reg_write(UC_ARM_REG_LR,SENTINEL);e.mu.emu_start(0x53780190,SENTINEL,count=100000)
   assert e.mu.reg_read(UC_ARM_REG_PC)==SENTINEL,hex(e.mu.reg_read(UC_ARM_REG_PC))
   e.mu.context_restore(context);e.mu.reg_write(UC_ARM_REG_R0,1);e.mu.reg_write(UC_ARM_REG_PC,e.mu.reg_read(UC_ARM_REG_LR));e.mu.emu_start(e.mu.reg_read(UC_ARM_REG_PC),SENTINEL,count=200000)
  assert e.mu.reg_read(UC_ARM_REG_PC)==SENTINEL,(hex(fn),hex(e.mu.reg_read(UC_ARM_REG_PC)))
  return e.mu.reg_read(UC_ARM_REG_R0)
 def snapshot(self):
  e=self.e;state=e.r32(WR)
  return dict(commonArea=e.rb(state+0x718,18).hex(),commonFace=e.rb(state+0x72c,60).hex(),eligible=e.rb(state+0x769,1)[0],userdataFaceDesired=e.rb(U+0x94,60).hex(),userdataFaceMirror=e.rb(U+0xbd8,60).hex(),uiPoint=list(struct.unpack('<2i',e.rb(U+0xc24,8))),manualPointFlag=e.rb(F+0x10,1)[0],focusMode=e.rb(U+0xc1d,1)[0],faceSettingRaw=e.rb(U+0xc2c,1)[0])
 def prepare_point(self,mode,point):
  e=self.e;e.wb(POINT,struct.pack('<2i',*point));self.call(0x533ae234,F,POINT,mode);xy=struct.unpack('<2i',e.rb(POINT,8));self.call(0x533ae04c,OUT,F,mode);w,h=struct.unpack('<2I',e.rb(OUT,8));left,top=xy[0]-w//2,xy[1]-h//2
  self.call(0x539115b4,OUT+32,left,top,left+w,top+h);self.call(0x533af9e0,G,OUT+32,OUT+64);e.wb(OUT+80,b'\1\1');return e.rb(OUT+64,18)
 def publish_selected(self,payload):
  self.e.wb(OUT+0x100,payload);self.call(0x5377e7e8,OPS,OUT+0x100)
 def publish_raw(self,valid):
  self.e.w32(G+0x253c,OPS);self.e.wb(OUT+0x100,self.face+bytes(540)if valid else bytes(600));self.call(0x538aed78,G,OUT+0x100)
 def deliver_point_notification(self):
  self.e.wb(EV,struct.pack('<HHI',0x162,0,19));self.call(0x533af280,F,EV)
 def region(self):
  e=self.e;self.call(0x536142f4,O);self.stop_region=True;self.region_hit=False
  e.call(0x5361a920,O,1,count=200000)
  self.stop_region=False
  assert self.region_hit,(hex(e.mu.reg_read(UC_ARM_REG_PC)),e.r32(O+0x650c))
  fp=e.mu.reg_read(UC_ARM_REG_FP)
  return dict(category=e.r32(O+0x650c),faceGate=e.rb(O+0x8638,1)[0],eyeBits=e.rb(O+0x8655,1)[0],roi=[e.r32(fp-0x74),e.r32(fp-0x78),e.mu.reg_read(UC_ARM_REG_SL),e.r32(fp-0x70)],regionCount=e.r16(O+0x15e0),phase=e.rb(O+0x11275,1)[0])
