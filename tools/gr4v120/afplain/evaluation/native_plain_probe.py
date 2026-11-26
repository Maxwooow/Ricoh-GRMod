#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Plain subject-AF candidate: native S1/LV/Caf replay (fixture machinery from native_tier_probe.py).

Kernel calls, cooperative task scheduling, display/DMA and post-ROI device work
are explicit fixtures. Subject/priority/transport guards execute candidate C.
Requires explicit container SHA pins; never falls back to S16/older artifacts.
"""
import argparse,gc,hashlib,importlib.util,json,os,re,struct,sys
from pathlib import Path
import numpy as np

def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,o):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(o,indent=2)+'\n')
def load_module(name,p):
 spec=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
U,F,G,COMM,CAF,MD=0x550832a8,0x550873e4,0x55084958,0x5537b29c,0x550a569c,0x550a2a5c
OPS,WR,SA,SB,SM,TA,OUT,SW,EV,BRIDGE,SENSOR,OTHER,ZAF,RAW=[0x60000000+i*0x10000 for i in range(14)]
LC,LP,LM,LB,LF,LI,LPOOL=[0x60300000+i*0x10000 for i in range(7)]
REGISTRY,NODE,REGREC,SENDCTX,BROKER,PORT1,MSG1,MSG2,POOL,VT=[0x60400000+i*0x10000 for i in range(10)]
PREFIX,PHOTOCTX,RECORD,HELPER=0x61000000,0x61010000,0x61020000,0x61030000
Y=0xa0004000;ALLOC=0x7e000200;FREE=0x7e000204
ROUTE_BASE=0x62e00000;ROUTER=ROUTE_BASE+0x50000;ROUTE_MAP=ROUTE_BASE+0x83000
ROUTE_IDS={1:0x111,2:0x202,4:0x444,8:0x888,16:0x1010}
ROUTE_CHANNELS={k:ROUTE_BASE+i*0x1000 for i,k in enumerate(ROUTE_IDS)}
ROUTE_PORTS={k:ROUTE_BASE+0x10000+i*0x1000 for i,k in enumerate(ROUTE_IDS)}
SPS={'Router':0x7e1d0000,'Setup':0x7e100000,'Source':0x7e100000,'Common':0x7e080000,'LV':0x7e1f0000,'Broker':0x7e050000,'Manager':0x7e060000,'Caf':0x7e180000,'Helper':0x7e170000,'Metadata':0x7e140000,'Publish':0x7e070000}
TASKS={'Router':701,'Source':100,'Broker':200,'Manager':300,'Common':400,'LV':8,'Caf':217,'Helper':217,'Metadata':500,'Setup':100,'Publish':8}
UI_TO_LV={0:0,1:2,2:1,3:3,7:7,8:8};LV_TO_UI={v:k for k,v in UI_TO_LV.items()};CROP_BITS={8192:0x3f800000,10240:0x3fa00000,14629:0x3fe49249}
VARIANTS=['subject','native','native_small','native_metric99','raw_pending','holding','manual_select','manual_pinpoint','manual_f8','tracking','focuslimit','af_range','no_frame','repeat','ai_follow','ai_continuous','face_follow']

class Harness:
 def __init__(self,a,version,variant,aspect,crop):
  self.a=a;self.version=version;self.variant=variant;self.aspect=aspect;self.crop=crop;self.stage='Setup';self.task=100;self.pending=[];self.queue={k:[]for k in [0x111,0x222,0x202,0x444,0x888,0x1010]};self.central_routes=[];self.route_lookup=[];self.freed=[];self.events=[];self.kernel=[];self.displays=[];self.transports=[];self.rois=[];self.helpers=[];self.ends=0;self.stop_after_roi=False;self.late_done=False;self.minimum={};self.cache_lines=0;self.forbidden=[];self.flags={};self.started=False
  art=a.artifacts/version;self.m=json.loads((art/'manifest.json').read_text());self.inst=self.m['installed'];self.mb=self.m['moduleBuild'];self.path=art/'patched-RTOS.bin'
  assert self.m['switches'].get('afPlain')is True and digest(art/'fwdc248b.bin')==self.m['outputSha256']==a.expected[version]and digest(self.path)==self.m['rtosSha256']
  assert {h['op']for h in self.inst['hooks']}=={1,2,5,6,7,8,12,26},'plain build installs exactly eight adapters'
  assert 0<self.mb['layout']['state_bytes']<=0x28000 and self.mb['layout']['photo_store_offset']<=0x200
  mapping=next(x for x in self.mb['maps']if x['origin']==0x54450000);origin=mapping['origin'];self.sym={k:self.inst['module']+v-origin for k,v in mapping['symbols'].items()if v>=origin}
  self.running_cycle=False;self.source_invocations=0;self.begin_invocations=0;self.extra_receive_ready=False;self.injection=None;self.injection_done=False;self.injected_guard=None;self.faults=[];self.latch_checks=[];self.late_cleared=False;self.parents=[];self.deliver_old_before_run=False
  os.environ['GRIV_RTOS']=str(self.path);import fwemu;self.fw=fwemu;fwemu.RTOS=str(self.path);self.e=e=fwemu.Emu();self.mu=mu=e.mu
  assert hashlib.sha256(e.rt[self.inst['module']-0x53000000:self.inst['module']-0x53000000+self.inst['moduleBytes']]).hexdigest()==self.m['assets']['moduleSha256']==self.mb['code_sha256']
  assert hashlib.sha256(e.rt[self.inst['model']-0x53000000:self.inst['model']-0x53000000+self.inst['modelBytes']]).hexdigest()==self.m['assets']['modelSha256']
  mu.mem_map(0x59600000,0x01000000);e.heap=0x59600000;mu.mem_map(0xa0000000,0x00600000)
  self.install_hooks();self.setup()
 def ret(self,mu,v=0):mu.reg_write(UC_ARM_REG_R0,v&0xffffffff);mu.reg_write(UC_ARM_REG_PC,mu.reg_read(UC_ARM_REG_LR))
 def hook(self,at,fn):self.mu.hook_add(UC_HOOK_CODE,fn,begin=at,end=at)
 def install_hooks(self):
  e,mu=self.e,self.mu
  locs={0x532406a4:COMM,0x53240818:COMM,0x53240c38:U,0x5324105c:F,0x5324111c:G,0x53750008:COMM,0x53240ab8:SM,0x53240b78:TA,0x53240758:0x60220000,0x539010cc:NODE}
  for fn in locs:self.hook(fn,lambda cpu,pc,n,x:self.ret(cpu,locs[pc]))
  for fn in [0x53907930,0x53907a84,0x530680d8,0x53916064,0x530651ec,0x53065208,0x5390a2d0,0x53610fb4,0x53611020]:self.hook(fn,lambda cpu,*_:self.ret(cpu))
  self.sleeps=0;self.hook(0x53909c88,lambda cpu,*_:(setattr(self,'sleeps',self.sleeps+1),self.ret(cpu,0)))   # stock task delay: the runtime's wait for a frame after the half-press
  self.hook(0x53aa5fbc,self.route_channel_lookup)
  for fn in [0x53aa5214,0x53aa530c]:self.hook(fn,lambda cpu,*_:self.ret(cpu,1))
  for fn in [0x53902fe8,0x53902f30]:self.hook(fn,lambda cpu,*_:self.ret(cpu,1)if self.stage=='Router'else None)
  self.hook(0x53aa5aa8,lambda cpu,*_:cpu.reg_write(UC_ARM_REG_PC,self.fw.SENTINEL))
  self.hook(0x53067e2c,self.current_task);self.hook(0x53908120,lambda cpu,*_:self.ret(cpu,1))
  for fn in [0x53922b88,0x53922b1c,0x538b3fb8]:self.hook(fn,self.display)
  self.hook(0x530008ec,lambda *args:setattr(self,'cache_lines',self.cache_lines+1))
  self.hook(0x53904f3c,self.common_enqueue)
  for fn in [0x5306752c,0x53068240,0x5306749c,0x530684c8]:self.hook(fn,self.event_kernel)
  self.hook(0x5325e2d8,lambda cpu,*_:self.ret(cpu,1))
  self.hook(ALLOC,self.message_alloc);self.hook(FREE,self.message_free);self.hook(0x53908e70,self.timestamp)
  self.hook(0x53068384,self.enqueue);self.hook(0x53067f04,self.receive)
  self.hook(0x53904548,lambda cpu,*_:self.ret(cpu,int(bool(self.queue[0x222]))))
  self.hook(0x5306764c,self.task_create);self.hook(0x53067358,self.task_query)
  for fn in [0x536116f4,0x53613a1c,0x53615f48,0x536087f0,0x5360de60,0x53619adc,0x53610ef8,0x53609484]:self.hook(fn,lambda cpu,*_:self.ret(cpu))
  self.hook(0x5361aff4,lambda cpu,*_:None if self.running_cycle else self.ret(cpu))
  self.hook(0x53616a58,lambda cpu,*_:self.ret(cpu,1));self.hook(0x539030a0,self.caf_wait);self.hook(0x536246c4,self.device_work)
  self.hook(0x53626410,self.end_enter);self.hook(0x53626414,self.end_return);self.hook(0x5361aaa8,self.roi_after_adapter);self.hook(0x536264c0,self.after_region);self.hook(0x5361adf0,self.later_face)
  self.hook(0x5361adf4,self.clear_late_face);self.hook(0x536142f4,self.parent_trace)
  for item in self.inst['hooks']:
   if item['op']in[0,14,17]:
    self.hook(item['site'],self.fault_begin);self.hook(item['site']+4,self.fault_end)
   if item['op']==1:self.hook(item['site'],self.old_start_before_run)
  mu.hook_add(UC_HOOK_BLOCK,self.block);mu.hook_add(UC_HOOK_MEM_WRITE,self.write_watch)
 def parent_trace(self,cpu,*_):
  if self.stage=='Caf':self.parents.append(dict(owner=cpu.reg_read(UC_ARM_REG_R0),task=self.task,lr=cpu.reg_read(UC_ARM_REG_LR),outer=self.e.r32(cpu.reg_read(UC_ARM_REG_FP)-4)))
 def current_task(self,cpu,*_):
  if self.injection and self.injection.endswith('task0'):self.faults[-1]['kernelCurrentTaskReturned']=0;self.ret(cpu,0)
  else:self.ret(cpu,self.task)
 def old_start_before_run(self,cpu,*_):
  if self.deliver_old_before_run:self.deliver_old_before_run=False;self.pending.append(('old_start_accept',None));cpu.emu_stop()
 def fault_begin(self,cpu,pc,*_):
  op=next(x['op']for x in self.inst['hooks']if x['site']==pc)
  if op==0:self.begin_invocations+=1;return
  if op==17:self.source_invocations+=1
  prefix='source_'if op==17 else'receive_'
  ready=(op==17 and self.source_invocations==2)or(op==14 and self.extra_receive_ready and self.stage=='Broker')
  if self.variant.startswith(prefix)and ready and not self.injection_done:
   self.injection=self.variant;self.injection_done=True;self.faults.append(dict(kind=self.variant,pc=hex(pc),task=self.task,sourceInvocation=self.source_invocations,physicalBeginInvocations=self.begin_invocations))
 def guard_fault(self,cpu,*_):
  if self.injection and self.injection.endswith('busy')and self.injected_guard is None:
   p=cpu.reg_read(UC_ARM_REG_R0);assert self.e.r32(p)==0;self.e.w32(p,1);self.injected_guard=p;self.faults[-1].update(guardAddress=p,actualLockEntry=cpu.reg_read(UC_ARM_REG_PC))
   lr=cpu.reg_read(UC_ARM_REG_LR);handle=[None]
   def returned(c,*_):
    assert c.reg_read(UC_ARM_REG_R0)==0,'actual C lock must reject busy guard';self.faults[-1]['actualLockReturned']=0;self.mu.hook_del(handle[0])
   handle[0]=self.mu.hook_add(UC_HOOK_CODE,returned,begin=lr,end=lr)
 def fault_end(self,cpu,*_):
  if self.injection:
   if self.injected_guard is not None:assert self.e.r32(self.injected_guard)==1;self.e.w32(self.injected_guard,0);self.injected_guard=None
   self.injection=None
 def display(self,cpu,pc,*_):self.displays.append(hex(pc));self.ret(cpu,1)
 def block(self,cpu,pc,*_):self.minimum[self.stage]=min(self.minimum.get(self.stage,0xffffffff),cpu.reg_read(UC_ARM_REG_SP))
 def write_watch(self,cpu,access,at,n,value,user):
  pc=cpu.reg_read(UC_ARM_REG_PC)
  if not self.inst['module']<=pc<self.inst['module']+self.inst['moduleBytes']:return
  protected=[(U+0xe0,8),(U+0xc24,8),(U+0x94,60),(U+0xbd8,60),(SA+0x25c,600),(SB+0x25c,600),(SA+0x718,80),(SB+0x718,80)]
  if any(at<b+s and b<at+n for b,s in protected):self.forbidden.append(dict(pc=hex(pc),address=hex(at),bytes=n))
 def common_enqueue(self,cpu,pc,*_):
  event=cpu.reg_read(UC_ARM_REG_R2);ptr=cpu.reg_read(UC_ARM_REG_R3);sizes={0x59:600,0x73:404,0x84:16,0x97:18,0x98:60,0x99:1,0x9a:1}
  self.events.append(dict(task=self.task,event=event,payload=self.e.rb(ptr,sizes.get(event,4)).hex()));self.pending.append(('common',(event,ptr)));cpu.emu_stop()
 def event_kernel(self,cpu,pc,*_):
  e=self.e;rr=[cpu.reg_read(r)for r in [UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]]
  if pc==0x5306752c:self.flags[123]=0;self.kernel.append(dict(op='create',task=self.task));self.ret(cpu,123);return
  if pc==0x53068240:self.flags[rr[0]]=self.flags.get(rr[0],0)|rr[1];self.kernel.append(dict(op='set',id=rr[0],bits=rr[1]));self.ret(cpu);return
  if pc==0x5306749c:self.flags[rr[0]]=self.flags.get(rr[0],0)&~rr[1];self.ret(cpu);return
  timeout=e.r32(cpu.reg_read(UC_ARM_REG_SP));self.kernel.append(dict(op='wait',task=self.task,id=rr[0],bits=rr[1],timeout=timeout))
  if rr[0]==123:self.pending.append(('frame',rr));cpu.emu_stop();return
  e.w32(rr[3],rr[1]);self.ret(cpu)
 def message_alloc(self,cpu,*_):
  n=cpu.reg_read(UC_ARM_REG_R1);assert n==36,('unexpected pool4 fixture allocation',n);ptr=self.e.heap;self.e.heap+=(n+15)&~15;self.e.wb(ptr,bytes(n));self.ret(cpu,ptr)
 def message_free(self,cpu,*_):self.freed.append(cpu.reg_read(UC_ARM_REG_R1));self.ret(cpu)
 def timestamp(self,cpu,*_):self.e.wb(cpu.reg_read(UC_ARM_REG_R0),struct.pack('<2I',123456,0));self.ret(cpu)
 def enqueue(self,cpu,*_):
  ptr=cpu.reg_read(UC_ARM_REG_R1);port=cpu.reg_read(UC_ARM_REG_R0);assert port in self.queue
  self.queue[port].append(ptr);self.transports.append(dict(kind='enqueue',task=self.task,port=port,owned=ptr,packet=self.e.rb(ptr+8,28).hex()));self.ret(cpu)
 def receive(self,cpu,*_):
  port=cpu.reg_read(UC_ARM_REG_R0);assert port in self.queue and self.queue[port];ptr=self.queue[port].pop(0);self.e.w32(cpu.reg_read(UC_ARM_REG_R1),ptr);self.ret(cpu)
 def task_create(self,cpu,*_):
  at=cpu.reg_read(UC_ARM_REG_R0);self.task_creation=dict(exinf=self.e.r32(at),entry=self.e.r32(at+8),stackBytes=self.e.r32(at+20));self.ret(cpu,217)
 def task_query(self,cpu,*_):self.e.wb(cpu.reg_read(UC_ARM_REG_R1),bytes(0x44));self.ret(cpu)
 def caf_wait(self,cpu,*_):
  if self.stage in['Caf','Router']:self.ret(cpu,1)
 def route_channel_lookup(self,cpu,*_):
  key=self.e.r32(cpu.reg_read(UC_ARM_REG_R1));assert key in ROUTE_CHANNELS,key;self.route_lookup.append(key);self.ret(cpu,ROUTE_MAP+key*4)
 def device_work(self,cpu,*_):self.e.wb(cpu.reg_read(UC_ARM_REG_R1),b'\1');self.e.w32(CAF+0x1698,1);self.ret(cpu)
 def end_enter(self,cpu,*_):
  if self.stage=='Caf':self.ends+=1
 def end_return(self,cpu,*_):
  if self.stage=='Caf'and self.ends>=2:cpu.emu_stop()
 def roi_after_adapter(self,cpu,*_):
  if self.stage!='Caf':return
  fp=cpu.reg_read(UC_ARM_REG_FP);self.rois.append(dict(category=self.e.r32(CAF+0x650c),phase=self.e.rb(CAF+0x11275,1)[0],roi=[self.e.r32(fp-0x74),self.e.r32(fp-0x78),cpu.reg_read(UC_ARM_REG_SL),self.e.r32(fp-0x70)],regionCount=self.e.r16(CAF+0x15e0)))
  cpu.reg_write(UC_ARM_REG_PC,0x5361acb0)
 def after_region(self,cpu,*_):
  if self.stage=='Caf'and self.rois and self.stop_after_roi:cpu.emu_stop()
 def later_face(self,cpu,*_):
  if self.stage=='Caf'and self.variant in['later_face','late_face_clear']and not self.late_done:self.late_done=True;self.pending.append(('later_face',None));cpu.emu_stop()
 def clear_late_face(self,cpu,*_):
  if self.stage=='Caf'and self.variant=='late_face_clear'and self.late_done and not self.late_cleared:self.late_cleared=True;self.pending.append(('late_clear',None));cpu.emu_stop()
 def raw_call(self,fn,args=(),stage=None,stop=None,count=900000000):
  if stage:self.stage=stage;self.task=TASKS[stage]
  cpu=self.mu;sp=SPS[self.stage]-((4*max(0,len(args)-4)+7)&~7);assert sp%8==0
  for reg,v in zip([UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3],args[:4]):cpu.reg_write(reg,v&0xffffffff)
  for i,v in enumerate(args[4:]):self.e.w32(sp+4*i,v)
  cpu.reg_write(UC_ARM_REG_SP,sp);cpu.reg_write(UC_ARM_REG_LR,self.fw.SENTINEL);cpu.emu_start(fn,stop or self.fw.SENTINEL,count=count);self.pump()
  return cpu.reg_read(UC_ARM_REG_R0)
 def call(self,fn,*args,stage=None,count=900000000):
  value=self.raw_call(fn,args,stage,count=count);assert self.mu.reg_read(UC_ARM_REG_PC)==self.fw.SENTINEL,(hex(fn),hex(self.mu.reg_read(UC_ARM_REG_PC)),self.stage);return value
 def pump(self):
  while self.pending:
   kind,arg=self.pending.pop(0);ctx=self.mu.context_save();stack=self.e.rb(0x7e000000,0x200000);stage,task=self.stage,self.task;retval=None
   if kind=='common':self.call(0x53780190,OPS,arg[0],arg[1],0,stage='Common');retval=1
   elif kind=='frame':
    # These are actual native event59 publications after cold state creation.
    self.publish_raw(bytes(600));self.publish_raw(bytes(600))
    if self.variant=='raw_pending':self.publish_raw(self.face+bytes(540))
    retval=-0x320000
    if self.variant!='timeout':
     self.stage='LV';self.task=TASKS['LV'];self.mu.reg_write(UC_ARM_REG_R0,LC);self.mu.reg_write(UC_ARM_REG_R1,1);self.mu.reg_write(UC_ARM_REG_R2,1);self.mu.reg_write(UC_ARM_REG_R4,LP);self.mu.reg_write(UC_ARM_REG_SP,SPS['LV']);self.mu.reg_write(UC_ARM_REG_LR,self.fw.SENTINEL);self.e.wb(SPS['LV'],struct.pack('<3I',LF,0,0));self.mu.emu_start(0x5365cba8,0x5365cbac,count=900000000);assert self.mu.reg_read(UC_ARM_REG_PC)==0x5365cbac
     if self.flags.get(123,0)&1:retval=0
   elif kind=='later_face':self.publish_selected(self.face)
   elif kind=='late_clear':
    self.publish_selected(bytes(60));self.publish_raw(bytes(600));values=self.helper_rects();assert values[0]==list(struct.unpack('<4I',self.face[:16]));self.latch_checks.append(dict(stage='native_cleared_inside_region',helpers=values,native=self.native_sources()))
   elif kind=='old_start_accept':self.accept();self.latch_checks.append(dict(stage='old_start_accepted_before_current_run',sourceInvocation=self.source_invocations))
   else:raise AssertionError(kind)
   self.e.wb(0x7e000000,stack);self.mu.context_restore(ctx);self.stage,self.task=stage,task
   if kind=='frame'and retval==0:self.e.w32(arg[3],1)
   if retval is not None:self.ret(self.mu,retval)
   self.mu.emu_start(self.mu.reg_read(UC_ARM_REG_PC),self.fw.SENTINEL,count=900000000)
 def lv_frame(self):
  ctx=self.mu.context_save();stage,task=self.stage,self.task
  self.stage='LV';self.task=TASKS['LV'];self.mu.reg_write(UC_ARM_REG_R0,LC);self.mu.reg_write(UC_ARM_REG_R1,1);self.mu.reg_write(UC_ARM_REG_R2,1);self.mu.reg_write(UC_ARM_REG_R4,LP);self.mu.reg_write(UC_ARM_REG_SP,SPS['LV']);self.mu.reg_write(UC_ARM_REG_LR,self.fw.SENTINEL);self.e.wb(SPS['LV'],struct.pack('<3I',LF,0,0));self.mu.emu_start(0x5365cba8,0x5365cbac,count=900000000);assert self.mu.reg_read(UC_ARM_REG_PC)==0x5365cbac
  self.mu.context_restore(ctx);self.stage,self.task=stage,task
 def static(self):
  names='state_word seen frames_ok frames_bad last_bad_step s1_runs s1_skips s1_last_gate model_ok model_fail model_last frame_age cat_calls supplied_cat supplied_region supplied_rect native_wins no_box sound_calls sound_swaps sound_last photo_seq attach_last lv_profile lv_format lv_w lv_h lv_cw lv_yhigh'.split()
  v=struct.unpack('<%dI'%len(names),self.e.rb(0x55839080,4*len(names)));d=dict(zip(names,v));rest=struct.unpack('<8I2i6I',self.e.rb(0x55839080+4*len(names),64))
  d.update(box=list(rest[:4]),roi=list(rest[4:8]),score=rest[8],presence=rest[9],gated=rest[10],texture=rest[11],box_id=rest[12],box_tick=rest[13],used_id=rest[14],now_tick=rest[15])
  d.update(zip('point_runs point_last point_mode point_x point_y'.split(),struct.unpack('<5I',self.e.rb(0x55839080+4*len(names)+64+20,20))));return d
 def publish_raw(self,data):self.e.wb(RAW,data);self.call(0x538aed78,LI,RAW,stage='Publish')
 def publish_selected(self,data):self.e.wb(RAW+0x1000,data);self.call(0x5377e7e8,OPS,RAW+0x1000,stage='Publish')
 def setup(self):
  e=self.e
  for ptr,n in [(U,0x2000),(F,0x200),(G,0x100),(COMM,0x100),(CAF,0x12000),(MD,0x200),(OPS,0x1000),(WR,0x20),(SA,0x1090),(SB,0x1090),(SM,0x1000),(BRIDGE,0x400),(SENSOR,0x3000),(LC,0x2000),(LP,0x1000),(LM,0x300),(LB,0x100),(LF,0x200),(LI,0x3000),(LPOOL,0x40)]:e.wb(ptr,bytes(n))
  for guard in [0x55083244,0x550873d8,0x550831d4,0x5537b298,0x550b6980,0x550a2c38,0x550a2c44]:e.w32(guard,1)
  e.w32(0x55839080,0);e.w32(COMM+4,OPS);e.w32(G+4,OPS);e.w32(OPS+0x518,WR);e.w32(WR,SA);e.w32(WR+4,SB);e.w32(OPS+0x58,124);e.w32(OPS+0x5c,0x540179b8)
  for off in [0x7c,0xbc0]:e.wb(U+off,b'\x0d')
  e.wb(F+0x15,b'\x0d');e.wb(SM+0x8d0,b'\3');e.wb(U+0xc24,struct.pack('<2i',360,240));e.wb(U+0xe0,struct.pack('<2i',360,240))
  e.w32(0x553a1bec,REGISTRY);e.w32(REGISTRY+4,7);e.w32(NODE,REGREC);e.w32(0x553a1bf0,POOL);e.w32(0x553a1bf4,1);e.w32(POOL,VT);e.w32(VT+8,ALLOC);e.w32(VT+12,FREE)
  e.w32(OPS,SENDCTX);e.w32(SENDCTX,0x4444);e.w32(BROKER,PORT1);e.w32(PORT1+4,0x111)
  for k in ROUTE_IDS:e.wb(ROUTE_CHANNELS[k],bytes(24));e.w32(ROUTE_CHANNELS[k],ROUTE_PORTS[k]);e.w32(ROUTE_PORTS[k]+4,ROUTE_IDS[k]);e.w32(ROUTE_MAP+k*4,ROUTE_CHANNELS[k])
  e.w32(0x553a6348,1);e.w32(0x553a6344,ROUTER);e.w32(ROUTER+4,TASKS['Router']);e.w32(ROUTER+0x34,ROUTE_BASE+0x40000);e.wb(ROUTE_BASE+0x40000,bytes(0x6d64))
  e.w32(MD,0x53edc7f0);e.w32(MD+4,300);e.w32(MD+0x34,0x222);e.w32(MD+0x54,BRIDGE);e.w32(MD+0x58,CAF);e.w32(MD+0x5c,OTHER);e.w32(MD+0x60,ZAF);e.w32(OTHER,0x53edf018);e.w32(ZAF,0x53edf018)
  e.w32(CAF,0x53edf018);e.w32(CAF+4,0x53edf0b4);e.w32(CAF+0x48,MD);e.w32(CAF+0x50,BRIDGE);e.w32(BRIDGE+0x18,OPS);e.w32(BRIDGE+0x20,SENSOR);e.w32(0x550a2c5c,BRIDGE);e.wb(SENSOR+0x14,struct.pack('<4I',720<<12,480<<12,0,0))
  e.w32(0x553a1d30,0);self.call(0x53909abc);self.call(0x53611a9c,CAF);assert self.task_creation['stackBytes']==4096 and e.r32(CAF+8)==217
  mode=1 if self.variant=='manual_select'else 4 if self.variant=='manual_pinpoint'else 5 if self.variant in('tracking','ai_follow','face_follow')else 6 if self.variant=='ai_continuous'else 0
  for off in [0xdc,0xc1d,0xc20]:e.wb(U+off,bytes([mode]))
  if self.variant=='manual_f8':e.wb(F+8,b'\1')
  if self.variant=='focuslimit':e.wb(U+0xf4,b'\1');e.wb(U+0xc38,b'\1')
  if self.variant=='af_range':e.wb(U+0xf6,b'\1');e.wb(U+0xc3a,b'\1')
  ui=LV_TO_UI[self.aspect];mag=CROP_BITS[self.crop];e.wb(U+0x49f,bytes([ui]));e.wb(U+0xfe3,bytes([ui]));e.w32(U+0x4a0,mag);e.w32(U+0xfe4,mag)
  e.w32(LC+0x330,LM);e.w32(LC+0x334,LB);e.wb(LB+0xa,b'\7');e.wb(LB+0xb,b'\1');e.w32(LB+4,LF);e.wb(LC+4,b'\2');e.wb(LC+0xbbd,b'\1');e.w32(LP+0x3a0,LI);e.w32(LP+0x3a8,LM);e.w32(LP+0x3b0,LPOOL);e.w32(LPOOL+8,LC);e.wb(LP+0x8d,bytes([self.aspect]));e.w32(LP+0x94,self.crop)
  for off,v in [(4,720<<12),(8,480<<12),(0x14,720<<12),(0x18,480<<12),(0x1cd4,4096),(0x253c,OPS)]:e.w32(LI+off,v)
  self.call(0x5366be20,LC,self.aspect,0,0,self.crop);self.call(0x538aefc8,LI,0,self.aspect,self.crop);self.call(0x538af658,LI,0 if self.aspect==0 and self.crop==8192 else 1);self.visible=struct.unpack('<4I',e.rb(LI+0x64,16));w,h,x,y=[e.r16(LC+off)for off in [0xbd6,0xbd8,0xbe0,0xbe2]];align=e.r32(LC+0xbdc);self.active=[w,h,x,y]
  aw,ah=1920,1088;plane=aw*ah;e.w16(LM+0x214,aw);e.w16(LM+0x216,ah);e.w32(LM+0xf4,Y);e.w32(LM+0x104,Y);e.w32(LC+0x2e8,Y);e.w32(LC+0xa08,2);e.w32(LC+0xa0c,Y+align);e.w32(LC+0xa10,Y+align+plane)
  for off,val in [(0xa18,w),(0xa1a,h),(0xa1c,aw),(0xa1e,ah),(0xa20,x),(0xa22,y)]:e.w16(LC+off,val)
  fixture=next(r for r in self.a.fixture['rows']if r['aspect']==self.aspect);yy=(self.a.fixture_dir/fixture['yFile']).read_bytes();uv=(self.a.fixture_dir/fixture['uvFile']).read_bytes();assert hashlib.sha256(yy).hexdigest()==fixture['ySha256']and hashlib.sha256(uv).hexdigest()==fixture['uvSha256']
  py=np.full((ah,aw),0xa5,np.uint8);pu=np.full((ah,aw),0xb9,np.uint8);py[y:y+h,x+align:x+align+w]=np.frombuffer(yy,np.uint8).reshape(h,w);pu[y//2:y//2+h//2,x+align:x+align+w]=np.frombuffer(uv,np.uint8).reshape(h//2,w);e.wb(Y,py.tobytes()+pu.tobytes());self.pixel_bytes=2*plane;self.pixel_hash=hashlib.sha256(e.rb(Y,self.pixel_bytes)).hexdigest()
  fw,fh=(8,8)if self.variant=='native_small'else(240,180);metric=99 if self.variant=='native_metric99'else 500
  self.face=struct.pack('<15I',fw<<12,fh<<12,240<<12,150<<12,40<<12,32<<12,265<<12,170<<12,40<<12,32<<12,360<<12,170<<12,17,18,metric)
  basic=self.call(0x532a16d8,mode);dims=(5,5)if mode==0 else(1,1);area=struct.pack('<4I2B',*self.visible,*dims);self.area=area
  for st in [SA,SB]:
   e.wb(st+0x6c0,struct.pack('<4I',*self.visible));e.wb(st+0x714,bytes([basic]));e.wb(st+0x718,area);e.wb(st+0x769,b'\1');e.wb(st+0x768,e.rb(U+0xc38,1));e.wb(st+0x7da,bytes([ui]));e.w32(st+0x7dc,mag)
   if self.variant in['native','native_small','native_metric99','face_follow']:e.wb(st+0x25c,self.face);e.wb(st+0x72c,self.face)
  for off in [0x80,0xbc4]:e.wb(U+off,area)
  if self.variant in['native','native_small','native_metric99']:e.wb(U+0x94,self.face);e.wb(U+0xbd8,self.face)
  for stage,sp in SPS.items():e.wb(sp-(4096 if stage in ['Caf','Helper']else 8192)-64,b'\xc5'*64)
  self.minimum.clear();self.forbidden.clear();self.events.clear()
  self.mu.mem_protect(0xa0000000,0x600000,UC_PROT_READ)
  self.mu.mem_protect(0x53000000,(len(e.rt)+0xfffff)&~0xfffff,UC_PROT_READ|UC_PROT_EXEC)
 def native_sources(self):
  st=self.e.r32(WR);return dict(ui=self.e.rb(U+0xc24,8).hex(),desiredUi=self.e.rb(U+0xe0,8).hex(),area=self.e.rb(st+0x718,18).hex(),selected=self.e.rb(st+0x72c,60).hex(),raw=self.e.rb(st+0x25c,600).hex(),desiredFace=self.e.rb(U+0x94,60).hex(),mirrorFace=self.e.rb(U+0xbd8,60).hex())
 def send_source(self,reuse_event=False):
  if not reuse_event:
   self.call(0x5339c4b4,OUT,SW,2,0,stage='Source');vec=self.e.r32(OUT);events=[self.e.rb(x,12)for x in range(self.e.r32(vec),self.e.r32(vec+4),12)];self.press_event=next(x for x in events if struct.unpack_from('<H',x)[0]==0x58)
  self.e.wb(EV,self.press_event);self.call(0x5325d2a4,0,EV,stage='Source')
  ids=[self.e.r32(ptr+8)for ptr in self.queue[0x111]];assert ids and ids[-1]==0x42410808 and all(v==0x42410809 for v in ids[:-1]),('source did not enqueue original optional AF_STOP then AF_START',self.variant,self.transports)
  assert self.e.r32(0x55839080)>=0x59600000,'cold state not initialized'
  if self.variant in['native','native_small','native_metric99']:
   for _ in range(3):self.publish_raw(self.face+bytes(540))
  if self.variant=='holding':self.publish_selected(self.face)
 def two_hops(self,accept=True):
  # Historical method name retained for callers; this now transfers THREE
  # separately owned36 packets through original central channel8 forwarding.
  while self.queue[0x111]:
   first=self.queue[0x111][0];packet=self.e.rb(first+8,28);message_id=struct.unpack_from('<I',packet)[0];assert message_id in[0x42410808,0x42410809]
   self.call(0x53aa5a48,ROUTER,stage='Router');assert len(self.queue[0x888])==1
   middle=self.queue[0x888][0];assert middle!=first and first in self.freed
   self.source_owned=middle
   self.call(0x53903e68,ROUTE_PORTS[8],MSG1,MSG1+4,MSG1+8,MSG1+12,MSG1+16,MSG1+20,0,stage='Broker');assert self.e.r32(MSG1)==message_id and middle in self.freed
   # Subscription delivery between this receive and its registered target is
   # still explicit, as in the frozen original harness. Exact owned/out chain
   # continues through original forwarding and MD post-handler acceptance.
   self.call(0x536431c8,MD,MSG1,stage='Broker');assert len(self.queue[0x222])==1;self.destination_owned=self.queue[0x222][0];self.packet=self.e.rb(self.destination_owned+8,28);assert struct.unpack_from('<I',self.packet)[0]==message_id
   self.central_routes.append(dict(command=message_id,sourceOwned=first,channel8Owned=middle,managerOwned=self.destination_owned,sourcePacket=packet.hex(),managerPacket=self.packet.hex(),sourceTask=TASKS['Source'],centralTask=TASKS['Router'],brokerTask=TASKS['Broker'],managerTask=TASKS['Manager']))
   assert len({first,middle,self.destination_owned})==3
   if accept or message_id!=0x42410808:self.accept()
   else:assert not self.queue[0x111]
 def release_source(self):
  self.call(0x5339c4b4,OUT,SW,2,4,stage='Source');vec=self.e.r32(OUT);events=[self.e.rb(x,12)for x in range(self.e.r32(vec),self.e.r32(vec+4),12)];release=next(x for x in events if struct.unpack_from('<H',x)[0]==0x59);self.e.wb(EV,release);self.call(0x5325d2a4,0,EV,stage='Source')
  assert self.e.rb(F+0xb,1)==b'\0';assert all(self.e.r32(p+8)==0x42410809 for p in self.queue[0x111]);self.two_hops()
 def accept(self):
  # Stop at+4 so the real post-handler candidate acceptance adapter has run.
  stop=self.mu.hook_add(UC_HOOK_CODE,lambda cpu,*_:cpu.emu_stop(),begin=0x5360a9b8,end=0x5360a9b8)
  self.raw_call(0x53643078,(MD,1,MSG2),stage='Manager');self.mu.hook_del(stop)
  assert self.mu.reg_read(UC_ARM_REG_PC)==0x5360a9b8 and self.destination_owned in self.freed
  assert self.e.rb(MSG2,28)==self.packet
  if struct.unpack_from('<I',self.packet)[0]==0x42410808:assert[self.e.rb(MD+off,1)[0]for off in [0x64,0x6c]]==[1,1]
 def helper_rects(self):
  saved=self.mu.context_save();stage,task=self.stage,self.task;values=[]
  for kind in [0,1,2]:self.call(0x53612034,CAF,HELPER,0,kind,stage='Helper');values.append(list(struct.unpack('<4I',self.e.rb(HELPER,16))))
  self.mu.context_restore(saved);self.stage,self.task=stage,task;return values
 def caf_cycle(self,wrong_task=False,wrong_caller=False):
  start=len(self.rois);self.ends=0;self.stop_after_roi=True;self.stage='Caf';self.task=218 if wrong_task else 217
  fn=0x5361a920 if wrong_caller else 0x536263a0;args=(CAF,1)if wrong_caller else(CAF,)
  for reg,val in zip([UC_ARM_REG_R0,UC_ARM_REG_R1],args):self.mu.reg_write(reg,val)
  self.mu.reg_write(UC_ARM_REG_SP,SPS['Caf']);self.mu.reg_write(UC_ARM_REG_LR,self.fw.SENTINEL);self.mu.emu_start(fn,self.fw.SENTINEL,count=900000000);self.pump()
  if wrong_caller:assert self.mu.reg_read(UC_ARM_REG_PC)==self.fw.SENTINEL
  else:
   assert self.mu.reg_read(UC_ARM_REG_PC)==0x536264c0;in_scope=self.helper_rects();self.stop_after_roi=False;self.mu.emu_start(0x536264c0,self.fw.SENTINEL,count=900000000);self.pump();assert self.mu.reg_read(UC_ARM_REG_PC)==0x53626414 and self.ends==2
   self.helpers.append(dict(inScope=in_scope,afterEnd=self.helper_rects()))
  assert len(self.rois)==start+1
  if not wrong_caller:
   words=list(struct.unpack('<15I',bytes.fromhex(self.native_sources()['selected'])));expected=[words[:4],words[8:12],words[4:8]]
   assert self.helpers[-1]['afterEnd']==expected,('post-END helper changed native result',self.helpers[-1],expected)
  return self.rois[-1]
 def running_region(self):
  self.running_cycle=True;self.stage='Caf';self.task=217;self.e.wb(HELPER+0x100,bytes(64));self.e.wb(CAF+0x85c8,b'\0');self.e.wb(CAF+0x85d0,b'\0');start=len(self.rois)
  stop=self.mu.hook_add(UC_HOOK_CODE,lambda cpu,*_:cpu.emu_stop(),begin=0x5361b14c,end=0x5361b14c)
  self.raw_call(0x5361aff4,(CAF,HELPER+0x100,HELPER+0x104,HELPER+0x108,HELPER+0x10c,0),stage='Caf');self.mu.hook_del(stop);self.running_cycle=False
  assert self.mu.reg_read(UC_ARM_REG_PC)==0x5361b14c and len(self.rois)==start+1
  assert self.parents[-1]['outer']==0x5361b14c and self.parents[-1]['lr']==0x5361aa98
  self.helpers.append(dict(running=True,inScope=self.helper_rects()));return self.rois[-1]
 def run(self):
  before=self.native_sources()
  frames=0 if self.variant=='no_frame'else 3
  for _ in range(frames):self.lv_frame()
  if self.variant in['native','native_small','native_metric99']:
   for _ in range(3):self.publish_raw(self.face+bytes(540))
  if self.variant=='holding':self.publish_selected(self.face)
  if self.variant=='raw_pending':self.publish_raw(self.face+bytes(540))
  self.send_source();self.two_hops()
  s1=self.static()
  roi=self.caf_cycle();st=self.static();after=self.native_sources()
  assert not self.forbidden,self.forbidden;assert hashlib.sha256(self.e.rb(Y,self.pixel_bytes)).hexdigest()==self.pixel_hash
  assert before==after or self.variant in['holding','raw_pending','ai_follow','ai_continuous','face_follow'],(self.variant,'native source mutation')
  ai=['subject','focuslimit','af_range','repeat']
  if self.variant in ai:
   assert s1['s1_last_gate']==0 and s1['model_last']==0 and s1['model_ok']==1 and s1['box_tick'],(self.variant,s1)
   assert roi['category']==9 and roi['regionCount']==25 and roi['roi']==st['roi'],(self.variant,roi,st)
   assert st['supplied_cat']>=1 and st['supplied_region']>=1 and st['used_id']==st['box_id'],(self.variant,st)
   assert self.helpers[-1]['inScope'][0]==st['roi']and self.helpers[-1]['inScope'][1:]==[[0]*4,[0]*4],(self.helpers[-1],st)
  elif self.variant in['native','native_small','native_metric99','holding']:
   assert roi['category']==9 and roi['roi']==list(struct.unpack('<4I',self.face[:16]))and st['supplied_region']==0 and st['native_wins']>=1,(self.variant,roi,st)
  elif self.variant=='raw_pending':
   # a stock face arrived before the half-press: the stock selection wins
   assert roi['category']==9 and roi['roi']==list(struct.unpack('<4I',self.face[:16]))and st['supplied_region']==0 and st['native_wins']>=1,(self.variant,roi,st)
  elif self.variant in['manual_select','manual_pinpoint','tracking','manual_f8']:
   assert s1['s1_last_gate']in(4,5)and s1['model_ok']==0 and roi['category']!=9 and st['supplied_cat']==0,(self.variant,s1,roi,st)
  elif self.variant in['ai_follow','ai_continuous']:
   # built with aiFrame: the network places the stock AF frame through the stock point-move code, nothing is offered to the face getter
   assert self.m['switches'].get('aiFrame')is True,'this case needs a build with aiFrame'
   want=5 if self.variant=='ai_follow'else 6;col,row=s1['gated']%12,s1['gated']//12
   assert s1['point_runs']==1 and s1['point_mode']==want and s1['point_last']in(2,4,5)and s1['model_last']==0 and s1['s1_runs']==0,(self.variant,s1)
   point=struct.unpack('<2i',self.e.rb(U+0xc24,8));assert point==(s1['point_x'],s1['point_y']),(point,s1)
   assert abs(point[0]-(2*col+1)*30)<=60 and abs(point[1]-(2*row+1)*30)<=60,('frame is on the chosen cell (stock clamp allowed)',point,col,row)
   assert st['supplied_cat']==0 and st['box_tick']==0,(self.variant,st)
   area=struct.unpack('<4I2B',self.e.rb(U+0x80,18));assert self.e.rb(U+0xbc4,18)==self.e.rb(U+0x80,18)==self.e.rb(SA+0x718,18)and area[4:]==(1,1)and area[:4]!=tuple(self.visible),('stock mirrors and Common hold the moved frame',area)
   self.placed=dict(cell=[col,row],uiPoint=list(point),pointStatus=s1['point_last'],commonAreaWHXY=[v>>12 for v in area[:4]],afterAf=roi)
  elif self.variant=='face_follow':
   # built with faceFollow, Follow mode, a stock face with two eyes in the list: the tracking frame starts on the first eye
   # (equal sizes), the network is not run, and stock AF keeps its tracking category although a selected face is present
   assert self.m['switches'].get('faceFollow')is True,'this case needs a build with faceFollow'
   assert s1['point_runs']==1 and s1['point_mode']==5 and s1['point_last']==4 and s1['gated']==253 and s1['s1_runs']==0 and s1['model_ok']==0,(self.variant,s1)
   point=struct.unpack('<2i',self.e.rb(U+0xc24,8));assert point==(s1['point_x'],s1['point_y'])==(285,186),(point,s1)
   area=struct.unpack('<4I2B',self.e.rb(U+0x80,18));assert self.e.rb(U+0xbc4,18)==self.e.rb(U+0x80,18)==self.e.rb(SA+0x718,18)and[v>>12 for v in area[:4]]==[64,52,253,160],area
   assert roi['category']!=9 and roi['regionCount']==1 and roi['roi']==list(area[:4])and st['supplied_cat']==0 and st['native_wins']==0,(roi,st)
   self.placed=dict(target='eye',uiPoint=list(point),pointStatus=s1['point_last'],commonAreaWHXY=[v>>12 for v in area[:4]],afterAf=roi)
  elif self.variant=='no_frame':
   assert s1['s1_last_gate']==7 and roi['category']!=9 and st['supplied_cat']==0 and self.sleeps==0,(self.variant,s1,roi,st,self.sleeps)   # nothing waits (v46); stock AF goes on alone
  repeat=[]
  if self.variant=='repeat':
   first=st['box_id'];self.release_source();self.lv_frame();self.lv_frame();self.send_source();self.two_hops();again=self.caf_cycle();st2=self.static()
   assert st2['box_id']==first+1 and st2['model_ok']==2 and again['category']==9 and st2['used_id']==st2['box_id'],(st2,again);repeat.append(dict(roi=again,static=st2))
  stack={k:SPS[k]-v for k,v in self.minimum.items()};assert all(v<(4096 if k in ['Caf','Helper']else 8192)for k,v in stack.items()),stack
  for stage,sp in SPS.items():assert self.e.rb(sp-(4096 if stage in ['Caf','Helper']else 8192)-64,64)==b'\xc5'*64,stage
  return dict(placed=getattr(self,'placed',None),version=self.version,variant=self.variant,aspect=self.aspect,cropQ13=self.crop,containerSha256=self.m['outputSha256'],moduleSha256=self.mb['code_sha256'],active=self.active,visible=list(self.visible),roi=roi,static=st,repeat=repeat,helpers=self.helpers,stackBytes=stack)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for n in ['artifacts','work','repo','output']:p.add_argument('--'+n,type=Path,required=True)
 p.add_argument('--expected',action='append',required=True);p.add_argument('--version',choices=['v120-01','v120-02'],action='append');p.add_argument('--case',choices=VARIANTS,action='append');p.add_argument('--fixture-dir',type=Path);p.add_argument('--geometry-matrix',action='store_true');p.add_argument('--reader',type=Path);a=p.parse_args()
 pairs=[x.split('=',1)for x in a.expected];assert all(len(x)==2 and x[0]in['v120-01','v120-02']and re.fullmatch('[0-9a-f]{64}',x[1])for x in pairs),'expected VERSION=lowercase SHA256';assert len({x[0]for x in pairs})==len(pairs),'duplicate expected version';a.expected=dict(pairs);assert all(v in a.expected for v in (a.version or ['v120-01','v120-02']))
 a.source_sha=digest(__file__);a.fixture_dir=a.fixture_dir or a.work/'regression/fixtures';a.fixture=json.loads((a.fixture_dir/'fixture.json').read_text());a.reader_path=Path(__file__)
 sys.path.insert(0,str(Path(__file__).resolve().parent))   # fwemu.py
 global UC_HOOK_CODE,UC_HOOK_BLOCK,UC_HOOK_MEM_WRITE,UC_PROT_READ,UC_PROT_EXEC
 from unicorn import UC_HOOK_CODE,UC_HOOK_BLOCK,UC_HOOK_MEM_WRITE,UC_PROT_READ,UC_PROT_EXEC
 from unicorn import arm_const
 globals().update({n:getattr(arm_const,n)for n in dir(arm_const)if n.startswith('UC_ARM_REG_')})
 rows=[];cases=a.case or VARIANTS
 for version in a.version or ['v120-01','v120-02']:
  jobs=[(variant,0,8192)for variant in cases]
  if a.geometry_matrix and 'subject'in cases:jobs.extend(('subject',aspect,crop)for aspect in [0,1,2,3,7,8]for crop in [8192,10240,14629]if(aspect,crop)!=(0,8192))
  for variant,aspect,crop in jobs:
   print('BEGIN',version,variant,aspect,crop,flush=True);h=Harness(a,version,variant,aspect,crop)
   try:row=h.run()
   except BaseException as error:
    pc=h.mu.reg_read(UC_ARM_REG_PC);nearest=max(((v,k)for k,v in h.sym.items()if v<=pc),default=(0,'outside_module'))if h.inst['module']<=pc<h.inst['module']+h.inst['moduleBytes']else(0,'outside_module')
    write(a.output.with_name(a.output.stem+'-failure.json'),dict(version=version,variant=variant,aspect=aspect,crop=crop,error=type(error).__name__+': '+str(error),pc=hex(pc),nearestCandidateSymbol=nearest[1],symbolOffset=pc-nearest[0]if nearest[0]else None,registers={name:hex(h.mu.reg_read(globals()['UC_ARM_REG_'+name.upper()]))for name in['r0','r1','r2','r3','r4','r5','r6','r7','r8','r9','r10','fp','sp','lr']},stage=h.stage,parents=h.parents,faults=h.faults,rois=h.rois,events=h.events,kernel=h.kernel,transport=h.transports));raise
   rows.append(row);write(a.output,dict(ok=False,complete=False,cases=len(rows),details=rows));print('PASS',version,variant,'roi',row['roi'],'stack',row['stackBytes'],flush=True);del h;gc.collect()
 assert digest(__file__)==a.source_sha,'harness source changed during run'
 report=dict(ok=True,complete=not a.case and not a.version,cases=len(rows),geometryMatrix=a.geometry_matrix,expected=a.expected,sourceSha256=a.source_sha,fixtureSha256=digest(a.fixture_dir/'fixture.json'),details=rows,limits=['No real device, DMA or scheduler. Kernel ports/events/task IDs are explicit cooperative fixtures.','Native source transfers three separately allocated owned36 packets through original channel1 router,channel8 forwarding,broker out28 and MD port; channel8 subscriber delivery to536431c8 remains an explicit fixture.',
'All candidate adapters/runtime/model execute; Python never substitutes subject, priority, category, getter or transport guard decisions.','Original Caf loop/category/getter/ROI and END execute; statistics/device work after ROI is explicitly skipped to original epilogue; STOP lens-position synchronization helper53609484 is a device fixture return.','Original Common prefix getter and real context binder feed public C record encoder; TIFF/IFD serialization is tested separately.','Physical release fixture dispatches the factory-produced AppEvent59 only; other UI events produced by that factory call are not dispatched.','Private synthetic functional fixture is frozen FIT data after canonical C NV12 conversion; no AF benefit or wall-clock camera claim.'])
 write(a.output,report);print(json.dumps(dict(ok=True,complete=report['complete'],cases=len(rows))))
if __name__=='__main__':main()
