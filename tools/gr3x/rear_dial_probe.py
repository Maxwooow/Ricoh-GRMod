"""Execute the original capture-ready RDIAL router with synthetic state objects.

Singleton access, message delivery and one nested focus predicate are stubbed. Native
guards and message construction run unchanged. Physical control identity is unverified.
"""
import hashlib
import argparse
import json
import struct
from pathlib import Path
from unicorn import arm_const as reg
from native_probe import NativeProbe, RTOS_SHA, BASE

if not __debug__: raise RuntimeError('Validation requires Python assertions; run without -O')

ROUTER, PLUS, MINUS = 0x53295da0,0x53295fc8,0x532960d4
SELECTOR, DATA, READY, ADJ, AUX, LOCK = (0x62040000,0x62041000,0x62043000,0x62044000,0x62045000,0x62046000)
USERREF, USER, MODEL, USERDATA, WRAPPER, TARGET = (0x62047000,0x62048000,0x62049000,0x6204a000,0x62050000,0x62051000)
SINGLETONS={0x5320ad88:0x62052000,0x5320b31c:SELECTOR,0x5320b19c:READY,
            0x5320b73c:AUX,0x5320b61c:ADJ,0x5320ae3c:LOCK,0x53525d5c:USERREF,
            0x5320aefc:0x62053000}
DISPATCH, CHANGE_NOTIFICATION, FOCUS_PREDICATE = 0x53200594,0x532288b0,0x532350b4

class RearDialProbe(NativeProbe):
    def __init__(self,data):
        self.events=[]; self.notifications=[]; self.focus_predicate=0; self.intercepts=[]
        super().__init__(data)
    def _hook(self,cpu,at,size,user):
        if at in SINGLETONS or at==FOCUS_PREDICATE:
            self.intercepts.append(hex(at))
            cpu.reg_write(reg.UC_ARM_REG_R0,SINGLETONS.get(at,self.focus_predicate))
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==DISPATCH:
            pointer=cpu.reg_read(reg.UC_ARM_REG_R1)
            raw=bytes(cpu.mem_read(pointer,12))
            self.events.append(dict(id=struct.unpack_from('<H',raw)[0],
                arg0=struct.unpack_from('<I',raw,4)[0],arg1=struct.unpack_from('<I',raw,8)[0]))
            cpu.reg_write(reg.UC_ARM_REG_R0,0)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        elif at==CHANGE_NOTIFICATION:
            self.notifications.append([cpu.reg_read(getattr(reg,'UC_ARM_REG_R'+str(i))) for i in range(4)])
            cpu.reg_write(reg.UC_ARM_REG_R0,0)
            cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))
        else: super()._hook(cpu,at,size,user)
    def reset(self,values=None):
        self.uc.mem_write(SELECTOR,bytes(TARGET-SELECTOR+0x100))
        for at,value in ((SELECTOR+4,DATA),(USERREF,USER),(USER+0x518,MODEL),(MODEL,USERDATA),(WRAPPER,TARGET)):
            self.uc.mem_write(at,struct.pack('<I',value))
        for at,value in (values or {}).items(): self.uc.mem_write(at,bytes([value]))
        self.events=[]; self.notifications=[]; self.intercepts=[]; self.focus_predicate=0
    def route(self,direction,gate=0,wrapper=False):
        self.call((PLUS if direction else MINUS) if wrapper else ROUTER,
                  0x62052000,WRAPPER,gate,*(() if wrapper else (direction,)))
        return list(self.events)

def verify(data):
    n=RearDialProbe(data); cases=[]
    # Use field names/addresses, not guessed labels like MF/menu/half-press.
    routes=[('selector.2a',{DATA+0x2a:1},(0x3c,0x3d)),
            ('aux.a=1 aux.c=0',{AUX+0xa:1},(0x49,0x4a)),
            ('selector.a40=1 selector.a3c=0',{DATA+0xa40:1},(0x51,0x52)),
            ('userdata.74f=4',{USERDATA+0x74f:4},(0x3e,0x3f)),
            ('userdata.74f=8',{USERDATA+0x74f:8},(0x43,0x44))]
    for name,values,pair in routes:
        for direction in (0,1):
            for wrapper in (False,True):
                n.reset(values); events=n.route(direction,wrapper=wrapper)
                assert events==[dict(id=pair[0 if direction else 1],arg0=0,arg1=0)],(name,direction,events)
                cases.append(dict(case=name,direction=direction,through_wrapper=wrapper,events=events))
    for mode in (0,1,2,5,7):
        for direction in (0,1):
            n.reset({USERDATA+0x74f:mode}); assert not n.route(direction)
            cases.append(dict(case=f'userdata.74f={mode}',direction=direction,events=[]))
    # Every early gate must retain the original no-event path despite other fields requesting a route.
    for at in (READY+0x2d,READY+0x32,READY+0x33,READY+0x34,ADJ+8,DATA+0x44,LOCK+4):
        for direction in (0,1):
            n.reset({DATA+0x2a:1,at:1}); assert not n.route(direction)
            cases.append(dict(case=f'gate@{at:#x}',direction=direction,events=[]))
    for direction in (0,1):
        n.reset({DATA+0x2a:1}); assert not n.route(direction,gate=1)
        cases.append(dict(case='input gate !=0',direction=direction,events=[]))
        n.reset({DATA+0x2a:1,READY+8:2});n.focus_predicate=1;assert not n.route(direction)
        cases.append(dict(case='nested focus predicate (stub)',direction=direction,events=[]))
        n.reset({DATA+0x2a:1,READY+0x2c:1,USERDATA+0x7a2:5});assert not n.route(direction)
        cases.append(dict(case='ready.2c=1 userdata.7a2=5',direction=direction,events=[]))
    for mode in (3,6,9,255):
        n.reset({USERDATA+0x74f:mode})
        try: n.route(1)
        except ValueError as exc: assert 'assertion failed' in str(exc)
        else: raise AssertionError('Invalid rear-dial mode accepted')
        cases.append(dict(case=f'userdata.74f={mode}',assertion=True))
    # Byte guards establish the static wrapper -> router direction relationship and vtable slots.
    guards={PLUS:'0dc0a0e1f0d82de9',MINUS:'0dc0a0e1f0d82de9',
            0x5329600c:'0130a0e362ffffeb',0x53296118:'0030a0e31fffffeb',
            0x53b5c020:'c85f2953d4602953'}
    for at,expected in guards.items():
        assert data[at-BASE:at-BASE+len(expected)//2]==bytes.fromhex(expected)
    return dict(schema=1,rtos_sha256=hashlib.sha256(data).hexdigest(),router=hex(ROUTER),
        wrappers={'direction_1':hex(PLUS),'direction_0':hex(MINUS)},
        calls=len(cases),cases=cases,original_router_unmodified=True,
        native_state_guards=True,physical_outer_ring_mapping_verified=False,
        clockwise_mapping_verified=False,rear_dial_patched=False,hardware_tested=False,
        firmware_generated=False,stubbed_services=[hex(a) for a in SINGLETONS]+[hex(DISPATCH),hex(FOCUS_PREDICATE)],
        scope='Capture-ready RDIAL router only. No physical input, menu/playback dispatch, task queue or persisted settings validation.')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--rtos',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True);args=p.parse_args()
    if args.rtos.resolve()==args.report.resolve(): raise ValueError('Output overlaps input')
    result=verify(args.rtos.read_bytes())
    with args.report.open('x') as f: json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k!='cases'},indent=2))
