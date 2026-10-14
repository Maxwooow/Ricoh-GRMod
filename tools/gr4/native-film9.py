"""GR IV 1.11 original ARM function regression. Not a physical camera emulator."""
import json,struct,hashlib,sys
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_ARM,UC_HOOK_CODE,UC_PROT_READ,UC_PROT_EXEC
from unicorn import arm_const as R
BASE=0x53000000;OBJ=0x62010000;MODEL=0x62020000;OUT=0x62030000;COMMON=0x62040000;CTX=0x62060000;STACK=0x610ff000;STOP=0x620ff000
RAW=Path('../inputs/gr4-rtos.bin').read_bytes();NEW=Path('research/gr4-film9/rtos.bin').read_bytes();M=json.loads(Path('research/gr4-film9/manifest.json').read_text())
DATA=0x620a0000;USER=0x620b0000;REF=0x620b1000;SHIM=0x620c0000
class Probe:
 def __init__(self,data):
  self.uc=Uc(UC_ARCH_ARM,UC_MODE_ARM);self.data=data;self.heap=0x62100000;self.mode=0;self.mono=0;self.errors=[];self.queue=[];self.trace=[]
  for a,n in [(BASE,(len(data)+4095)&~4095),(0x55000000,0x400000),(0x61000000,0x100000),(0x62000000,0x400000)]:self.uc.mem_map(a,n)
  self.uc.mem_write(BASE,data);self.uc.mem_protect(BASE,(len(data)+4095)&~4095,UC_PROT_READ|UC_PROT_EXEC)
  src,dst,n=struct.unpack_from('<3I',RAW,0x450);assert(src,dst,n)==(0x5437b640,0x55000000,0x57480)
  self.uc.mem_write(dst,RAW[src-BASE:src-BASE+n]);self.uc.reg_write(R.UC_ARM_REG_C1_C0_2,0xf00000);self.uc.reg_write(R.UC_ARM_REG_FPEXC,0x40000000)
  self.uc.mem_write(SHIM,struct.pack('<13I',*[0xe92d4070,0xe1a0400c,0xe59d5010,0xe1a06001,0xe1a01003,0xe3a02000,0xe12fff34,0xe3560002,0x1a000001,0xe3550000,0x15c50000,0xe3a00000,0xe8bd8070]))
  self.put(REF+4,USER);self.put(USER+0x518,MODEL)
  self.uc.hook_add(UC_HOOK_CODE,self.hook)
  self.put(0x553a0ca0,1);self.put(0x553a0c9c,0);self.put(0x553a0ca4,1);self.put(0x553a0ca8,1)
  self.uc.mem_write(0x553a0cac,struct.pack('<3I',0x62090000,0x62090400,0x62090800))
 def put(self,a,v):self.uc.mem_write(a,struct.pack('<I',v))
 def word(self,a):return struct.unpack('<I',self.uc.mem_read(a,4))[0]
 def hook(self,c,at,size,_):
  if at==getattr(self,'stop',STOP):c.emu_stop();return
  ret=None
  self.trace.append(at)
  if len(self.trace)>1000:self.trace.pop(0)
  if at==0x53758ca8:
   command=c.reg_read(R.UC_ARM_REG_R1);field=c.reg_read(R.UC_ARM_REG_R2)
   assert command in (1,2) and 0<=field<281,(command,field)
   assert c.reg_read(R.UC_ARM_REG_R0)==USER
   table=0x54394538 if command==1 else 0x54393c70
   target,adjustment=struct.unpack_from('<II',self.data,table-BASE+field*8)
   assert adjustment==0
   self.queue.append((command,field));c.reg_write(R.UC_ARM_REG_R12,target);c.reg_write(R.UC_ARM_REG_PC,SHIM);return
  if at==0x5323ea84:ret=OBJ
  elif at==0x5323f018:ret=DATA
  elif at==0x5372b620:ret=REF
  if at==0x533ef000:ret=self.mono # simulated physical model identity only
  elif at==0x533b665c:ret=self.mode # Image Control user's bank selector
  elif at==0x538e09b0:
   n=c.reg_read(R.UC_ARM_REG_R0);assert n<0x10000;ret=self.heap;self.heap+=(n+15)&~15
  elif at in (0x538e09ec,0x538dfe24,0x538dff78):ret=0 # free and uncontended OS mutexes
  elif at==0x538ed930:
   if not c.reg_read(R.UC_ARM_REG_R0):self.errors.append(c.reg_read(R.UC_ARM_REG_R3))
   c.reg_write(R.UC_ARM_REG_PC,c.reg_read(R.UC_ARM_REG_LR));return
  if ret is not None:c.reg_write(R.UC_ARM_REG_R0,ret);c.reg_write(R.UC_ARM_REG_PC,c.reg_read(R.UC_ARM_REG_LR))
 def call(self,a,*args,stack=b'',stop=STOP,seed=None,flags=0x13):
  c=self.uc;self.errors=[];self.stop=stop
  for n in range(13):c.reg_write(getattr(R,'UC_ARM_REG_R'+str(n)),0)
  c.reg_write(R.UC_ARM_REG_CPSR,flags);c.reg_write(R.UC_ARM_REG_SP,STACK);c.reg_write(R.UC_ARM_REG_LR,stop)
  c.mem_write(STACK-0x1000,bytes(0x2000));c.mem_write(STACK,stack)
  saved={getattr(R,'UC_ARM_REG_R'+str(n)):0x12340000+n for n in range(4,12)}
  for r,v in saved.items():c.reg_write(r,v)
  for i,v in enumerate(args):c.reg_write(getattr(R,'UC_ARM_REG_R'+str(i)),v)
  for r,v in (seed or {}).items():c.reg_write(getattr(R,'UC_ARM_REG_R'+str(r)),v)
  try:c.emu_start(a,stop,count=250000,timeout=2_000_000)
  except Exception as e:raise RuntimeError(f'{hex(a)} at {hex(c.reg_read(R.UC_ARM_REG_PC))}: {e}; trace '+','.join(hex(x) for x in [a for a in self.trace if a<0x53800000][-60:]))
  assert c.reg_read(R.UC_ARM_REG_PC)==stop,(hex(a),'timeout',hex(c.reg_read(R.UC_ARM_REG_PC)))
  assert not self.errors,(hex(a),'native assertion',self.errors)
  if stop==STOP:
   assert c.reg_read(R.UC_ARM_REG_SP)==STACK,hex(a)
   for r,v in saved.items():
    if seed and r-R.UC_ARM_REG_R0 in seed:continue
    assert c.reg_read(r)==v,(hex(a),'callee saved',r)
  return c.reg_read(R.UC_ARM_REG_R0)
 def menu(self,mode=0):
  self.uc.mem_write(OBJ,bytes(0x400));self.call(0x533cc890,OBJ)
  if mode:self.call(0x533cc928,OBJ,mode)
  n=self.call(0x533bebdc,OBJ)
  return [self.call(0x533bedb0,OBJ,i) for i in range(n)]
 def descriptor(self,tone):
  self.uc.mem_write(OBJ,bytes(0x400));self.uc.mem_write(CTX,bytes(0x9000));self.uc.mem_write(COMMON,bytes(0x2000))
  self.uc.mem_write(COMMON+0x79c,bytes([tone]));self.uc.mem_write(COMMON+0x79d,bytes([4])*6);self.uc.mem_write(COMMON+0x7a3,b'\1');self.uc.mem_write(COMMON+0x7a4,b'\4')
  self.uc.mem_write(OUT,b'\xa5'*0x200);self.put(CTX+0x82d0,COMMON)
  self.call(0x53912c40,OBJ,CTX,OUT)
  return bytes(self.uc.mem_read(OUT,0x134))
stock=Probe(RAW);new=Probe(NEW);report={}
for mode in range(3):
 a=stock.menu(mode);b=new.menu(mode);assert b==a+(list(range(64,73)) if mode==0 else []),(mode,a,b)
 for i,t in enumerate(b):assert new.call(0x533bf090,OBJ,t)==i
report['factory_menu_and_new_order']=True
assert new.call(0x533bebf0,OBJ)==29
for tone in range(11,31):
 for entry in [0x53397044,0x533971cc,0x5337f824,0x53380fac]:
  assert new.call(entry,OBJ,tone,0)==stock.call(entry,OBJ,tone,0)
for s in M['slots']:
 for entry,key in [(0x53397044,'textId'),(0x533971cc,'iconId'),(0x5337f824,'textId'),(0x53380fac,'iconId')]:assert new.call(entry,OBJ,s['id'],0)==s[key]
 assert new.call(0x533cc6e0,OBJ,s['id'],1)==0
report['factory_and_private_display_ids']=True
stock.uc.mem_write(OBJ+0x1f,b'\0');new.uc.mem_write(OBJ+0x1f,b'\0')
for mode in range(1):
 stock.mode=new.mode=mode
 for d in M['defaults']:
  for t in range(64,73):assert new.call(d['address'],OBJ,t)==d['value']
report['native_default_parameters']=True
for pr in [stock,new]:pr.uc.mem_write(MODEL,struct.pack('<3I',COMMON,COMMON+0x2000,0))
for t in range(64,73):
 assert new.call(0x53373bc0,OBJ,t)==stock.call(0x53373bc0,OBJ,11)
 assert new.call(0x5375f0b0,MODEL,t,0)==stock.call(0x5375f0b0,MODEL,11,0)
report['raw_development_and_restrictions']=True
# Native setter and two-buffer commit keep the new identity rather than its Standard alias.
for t in [64,72,18,19,11,65]:
 new.uc.mem_write(COMMON,bytes(0x4000));new.uc.mem_write(MODEL,struct.pack('<3I',COMMON,COMMON+0x2000,0));
 assert new.call(0x53764258,MODEL,t)==1
 assert new.call(0x5375c9c8,MODEL)==t
report['native_tone_commit_preserves_private_identity']=True
print('menu/defaults/state passed',flush=True)
for t in [11,12,18,19,24,13]:
 a=stock.descriptor(t);b=new.descriptor(t);assert a==b,(t,'factory descriptor changed')
for s in M['slots']:
 d=new.descriptor(s['id']);assert struct.unpack_from('<I',d,8)[0]==s['record'];assert struct.unpack_from('<I',d,20)[0]==s['gamma']
 # Factory multi-axis remains Standard; private matrices/curves do not borrow Cinema banks.
 assert struct.unpack_from('<I',d,12)[0]==struct.unpack_from('<I',stock.descriptor(11),12)[0]
report['native_descriptor_factory_equivalence_and_nine_private_records']=True
# Run the actual Image Control model setter and native queued CommonProperty handlers.
for bank in range(4):
 for tone in [11,18,19,64,65,66,67,68,69,70,71,72]:
  new.mode=bank;new.queue=[]
  new.uc.mem_write(OBJ,bytes(0x400));new.uc.mem_write(DATA,bytes(0x3000));new.uc.mem_write(COMMON,bytes(0x4000))
  new.uc.mem_write(DATA+0x152,bytes([bank]));new.uc.mem_write(DATA+0xc3e,bytes([bank]))
  new.uc.mem_write(MODEL,struct.pack('<3I',COMMON,COMMON+0x2000,0))
  new.call(0x533b70cc,OBJ,tone)
  assert new.uc.mem_read(DATA+0x153+bank,1)[0]==tone,(bank,tone,'settings identity')
  assert (1,0x89) in new.queue,(bank,tone,new.queue)
  for ptr in (new.word(MODEL),new.word(MODEL+4)):
   assert new.uc.mem_read(ptr+0x79c,1)[0]==tone,(bank,tone,'committed identity',new.uc.mem_read(ptr+0x79c,1).hex())
report['native_high_level_selection_and_ram_transaction_all_four_banks']=True
# Execute every native-consumer trampoline; verify register/flag preservation.
for a in M['adapters']:
 for tone in [0,11,18,19,33,63,64,68,72,73,255]:
  for flags in [0x13,0xf8000013]:
   regs={i:0x45670000+i for i in range(13)};regs[a['sourceRegister']]=COMMON
   new.uc.mem_write(COMMON+0x79c,bytes([tone]))
   new.call(a['address'],stop=a['address']+4,seed=regs,flags=flags)
   for i,v in regs.items():
    want=(11 if 64<=tone<=72 else tone) if i==a['destinationRegister'] else v
    assert new.uc.reg_read(getattr(R,'UC_ARM_REG_R'+str(i)))==want,(a,i,tone)
   assert new.uc.reg_read(R.UC_ARM_REG_SP)==STACK
   assert new.uc.reg_read(R.UC_ARM_REG_CPSR)&0xf8000000==flags&0xf8000000
   assert new.uc.mem_read(COMMON+0x79c,1)[0]==tone
report['all_103_consumers_preserve_source_registers_and_flags']=True
report['queue_delivery_substituted']=True
report['persistent_file_io_tested']=False
report.update(rtosSha256=hashlib.sha256(NEW).hexdigest(),sourceRtosSha256=hashlib.sha256(RAW).hexdigest(),hardware_tested=False,scope='ARM functions with synthetic memory; physical sensor/ISP, power cycling, JPEG/DNG serialization not executed')
Path('research/gr4-film9/native-check.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
