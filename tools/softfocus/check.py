# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of soft focus on the ADJ lever (core/src/fw/aspect/softfocus.ts).

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn:
function name and icon lookups, the ADJ controller's table lookup and the four new handlers,
the ADJ mode setting list, DigitalFilterProcess::SetEffectParameter for every clarity setting
with soft focus off / weak / medium / strong, and the clarity row selection.

    python3 check.py RTOS.bin      # the RTOS section of a built file (decoded)

Needs the Python packages unicorn and capstone.
"""
import sys, struct

# ---- helpers (disassembly, image access)
import re as _re
from capstone import *
BASE=0x53000000
R=open(sys.argv[1],'rb').read()[:0x13d2ac0]
RAMVA=0x55000000; RAMIMG=0x5437b640; RAMLEN=0x57480
RAM=R[RAMIMG-BASE:RAMIMG-BASE+RAMLEN]
md=Cs(CS_ARCH_ARM, CS_MODE_ARM); md.detail=False
mt=Cs(CS_ARCH_ARM, CS_MODE_THUMB)
def rd(va,n):
    if BASE<=va<BASE+len(R): return R[va-BASE:va-BASE+n]
    if RAMVA<=va<RAMVA+RAMLEN: return RAM[va-RAMVA:va-RAMVA+n]
    return None
def u32(va): b=rd(va,4); return struct.unpack('<I',b)[0] if b else None
def u16(va): return struct.unpack('<H',rd(va,2))[0]
def dis(va,n=40,thumb=False):
    m=mt if thumb else md
    out=[]
    for i in m.disasm(rd(va,n*4),va):
        s=f'{i.address:08x}: {i.mnemonic:8s} {i.op_str}'
        # resolve pc-relative ldr
        mm=_re.search(r'\[pc, #(-?0x[0-9a-f]+|-?\d+)\]',i.op_str)
        if mm and i.mnemonic.startswith('ldr'):
            a=i.address+8+int(mm.group(1),0); v=u32(a)
            if v is not None: s+=f'   ; =0x{v:08x}'+strat(v)
        out.append(s)
        if len(out)>=n: break
    return '\n'.join(out)
def cstr(va,maxn=80):
    b=rd(va,maxn)
    if not b: return None
    e=b.find(b'\0')
    if e<=0: return None
    s=b[:e]
    if all(32<=c<127 for c in s): return s.decode()
    return None
def strat(v):
    s=cstr(v)
    return f'  "{s}"' if s and len(s)>=3 else ''
def find_words(val, lo=0, hi=None):
    pat=struct.pack('<I',val); res=[]; i=R.find(pat,lo)
    while i!=-1:
        if i%4==0: res.append(BASE+i)
        i=R.find(pat,i+1)
    return res
def find_bytes(b):
    res=[];i=R.find(b)
    while i!=-1: res.append(BASE+i); i=R.find(b,i+1)
    return res
_bl=None
def bl_index():
    global _bl
    if _bl is None:
        import array
        _bl={}
        n=len(R)//4
        a=array.array('I'); a.frombytes(R[:n*4])
        for k,w in enumerate(a):
            if (w>>24)&0xf in (0xb,) and (w>>28)!=0xf:
                off=w&0xffffff
                if off&0x800000: off-=1<<24
                t=BASE+k*4+8+off*4
                _bl.setdefault(t,[]).append(BASE+k*4)
    return _bl
def callers(t): return bl_index().get(t,[])
def funcstart(va,lim=0x4000):
    # search back for push {...lr}
    a=va
    while a>va-lim:
        w=u32(a)
        if (w&0xffff4000)==0xe92d4000:
            return a-4 if u32(a-4)==0xe1a0c00d else a
        a-=4
    return None
def dis2(va,n=40,thumb=False):
    m=mt if thumb else md
    regs={}
    out=[]
    for i in m.disasm(rd(va,n*4+8),va):
        s=f'{i.address:08x}: {i.mnemonic:8s} {i.op_str}'
        mm=_re.search(r'\[pc, #(-?0x[0-9a-f]+|-?\d+)\]',i.op_str)
        if mm and i.mnemonic.startswith('ldr'):
            a=i.address+8+int(mm.group(1),0); v=u32(a)
            if v is not None: s+=f'   ; =0x{v:08x}'+strat(v)
        if i.mnemonic=='movw':
            r,imm=i.op_str.split(', #'); regs[r]=int(imm,0)
        elif i.mnemonic=='movt':
            r,imm=i.op_str.split(', #')
            if r in regs:
                v=(int(imm,0)<<16)|regs[r]; s+=f'   ; {r}=0x{v:08x}'+strat(v)
        out.append(s)
        if len(out)>=n: break
    return '\n'.join(out)
LANGT=BASE+0x137D7B0
def lang_str(t,i):
    p=u32(LANGT+t*0xD14+i*4)
    if p is None or rd(p,8) is None: return None
    ln=u32(p); sp=u32(p+4)
    n=(ln&0xff)-1
    if n<0 or n>400 or rd(sp,2*n) is None: return None
    return rd(sp,2*n).decode('utf-16le','replace')

# ---- emulator
from unicorn import *
from unicorn.arm_const import *
def make(rtos=None):
    mu=Uc(UC_ARCH_ARM, UC_MODE_ARM)
    img=rtos if rtos is not None else R
    mu.mem_map(0x53000000, 0x1500000)
    mu.mem_write(0x53000000, img)
    mu.mem_map(0x55000000, 0x1000000)
    mu.mem_write(0x55000000, img[RAMIMG-BASE:RAMIMG-BASE+RAMLEN])
    mu.mem_map(0x60000000, 0x100000)   # stack
    mu.mem_map(0x70000000, 0x1000000)  # heap
    mu.mem_map(0x0, 0x1000)            # return sentinel page
    # enable VFP
    mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20))
    mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
    return mu
def call(mu, fn, args=(), limit=20_000_000, sp=0x600f0000):
    regs=[UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]
    for r,v in zip(regs,args): mu.reg_write(r,v)
    mu.reg_write(UC_ARM_REG_SP, sp)
    mu.reg_write(UC_ARM_REG_LR, 0x100)
    mu.emu_start(fn, 0x100, count=limit)
    return mu.reg_read(UC_ARM_REG_R0)

# ---- checks
RT=open(sys.argv[1] if len(sys.argv)>1 else 'sf_rtos.bin','rb').read()
OFF=RT[:0x13d2ac0]
OFFICIAL=open(sys.argv[2] if len(sys.argv)>2 else 'rtos.bin','rb').read()
def mk():
    mu=make(RT)
    # guards of the singletons: app (0x5508207c) and UserDataModel (0x55082234) constructed
    for g in (0x5508207c,0x55082234): mu.mem_write(g, struct.pack('<I',1))
    return mu
stubs={}
def stub(mu, addr, fn):
    stubs[addr]=fn
def install_stubs(mu):
    def hk(uc, addr, size, ud):
        if addr in stubs:
            r=stubs[addr](uc)
            uc.reg_write(UC_ARM_REG_R0, r if r is not None else 0)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    mu.hook_add(UC_HOOK_CODE, hk, begin=0x53000000, end=0x54500000)
R0,R1,R2=UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2
ok=True
def check(name, got, want):
    global ok
    good = got==want
    ok &= good
    print(('PASS ' if good else 'FAIL ')+name, got, '' if good else f'(want {want})')
# 1. name and icon mappers
_mo=make(OFFICIAL)
OFFNAME={f:call(_mo,0x5337fe98,(0,f)) for f in range(0x16)}
mu=mk()
for f,v,w in [(0x0a,0,840),(0x0b,0,None),(0x12,0,282),(0x13,0,270),(0x14,0,553),(0x15,0,0),(0x16,0,0),(0,0,2)]:
    got=call(mu,0x5337fe98,(0,f))
    if w is None: check(f'name of function {f:#x} as official', got, call(mk(),0x5337fe98,(0,f)) if False else OFFNAME[f]); continue
    check(f'name of function {f:#x}', got, w)
for f,v,w in [(0x0a,0,720),(0x0a,1,0),(0x0b,0,0x38),(0x0b,1,0),(0x12,0,0x191),(0x14,0,0x34),(0x15,0,0),(0x16,0,0),(0x13,0,None),(0,0,0x102)]:
    got=call(mu,0x533817f0,(0,f,v))
    if w is None: print('     icon of crop', got); continue
    check(f'icon of function {f:#x} variant {v}', got, w)
# every other function keeps its official name and icons
_mn=mk()
check('names of the other functions as official', [f for f in range(0x18) if f!=0x0a and call(_mn,0x5337fe98,(0,f))!=call(_mo,0x5337fe98,(0,f))], [])
check('icons of the other functions as official', [(f,v) for f in range(0x18) for v in (0,1) if f!=0x0a and call(_mn,0x533817f0,(0,f,v))!=call(_mo,0x533817f0,(0,f,v))], [])
# icon catalog entry

def rdw(img,va): o=va-BASE; return struct.unpack('<I',img[o:o+4])[0]
d=rdw(RT,0x543d3ac0+720*4); k,wid,hei,fl,off=struct.unpack('<HHHHI',RT[d-BASE:d-BASE+12])
check('icon 720 descriptor 40x40', (k,wid,hei,fl), (1,40,40,0)); print('     icon pixel offset (words)', off, 'bytes', off*4, 'official ICONBIN', 0xdcf460)
# 2. text 840 in every language row, and bound helpers
L=['cs','da','en','fi','fr','de','el','hu','it','ja','ko','nl','pl','pt','ru','zh-CN','es','sv','th','zh-TW','tr']
roots=[rdw(RT,0x543d4ac0+4*l) for l in range(21)]
names=[]
for l,row in enumerate(roots):
    dsc=rdw(RT,row+840*4); cnt=rdw(RT,dsc); sp=rdw(RT,dsc+4); n=(cnt&0xff)-1
    s=RT[sp-BASE:sp-BASE+2*n].decode('utf-16le')
    # compare to an existing string id 270 (Crop) to map language
    c=rdw(RT,row+270*4); cc=rdw(RT,c); cs=rdw(RT,c+4); crop=RT[cs-BASE:cs-BASE+2*((cc&0xff)-1)].decode('utf-16le')
    names.append((crop,s))
print('     row  Crop-text -> text 840:', names)
# 3. ADJ handlers through the controller's own lookup: count (0x531be070) for slot holding 0x0a
MODEL=0x55084dd8; SF=MODEL+4+0x90f
mu=mk(); install_stubs(mu)
stub(mu,0x5329bf70,lambda uc:0)  # not in the fixed movie layout
this=0x70000000
mu.mem_write(this+0x1fc,b'\x00')       # slot 0
mu.mem_write(MODEL+0x920,b'\x0a')      # slot 0 -> soft focus (GetAdjCustom slot 0 reads +0x920)
check('GetAdjCustom(slot 0)', call(mu,0x531bd580,(this,0)), 0x0a)
check('number of values via ADJ table', call(mu,0x531be070,(this,)), 4)
mu.mem_write(MODEL+0x920,b'\x13')
check('number of values of Crop (unchanged)', call(mu,0x531be070,(this,)), 3)
mu.mem_write(MODEL+0x920,b'\x0a')
# set value 2 via 0x531beed4-like path: call handler through table: find our record
tbl=0x53d9f714
SITES=[0x531bbf8c,0x531bbf9c,0x531bd0f0,0x531bd124,0x531bd954,0x531bd95c,0x531bdaf0,0x531bdaf8,0x531bdb8c,0x531bdb94,0x531be088,0x531be090,0x531bea9c,0x531beaa4,0x531beaf8,0x531beb00,0x531bebf0,0x531bebf8,0x531bec7c,0x531bec84,0x531bed08,0x531bed10,0x531bedb0,0x531bedb8,0x531beefc,0x531bef04,0x531bf09c,0x531bf0a4,0x531bf198,0x531bf1b0,0x531bf4a4,0x531bf4ac,0x531bf5b0,0x531bf5b8,0x531bf65c,0x531bf664,0x531bf6c4,0x531bf6d4,0x531bf780,0x531bf790,0x531bf964,0x531bf96c,0x531bfb28,0x531bfb2c,0x531bfce8,0x531bfcf0]
check('all 23 MOVW/MOVT pairs still address the official table', [rdw(RT,a)==rdw(OFFICIAL,a) for a in SITES].count(False), 0)
rec=tbl+0x0a*0x5c
h=lambda o: rdw(RT,rec+o)
check('record copies Crop except handlers', [rdw(RT,rec+o)==rdw(RT,0x53d9f714+0x13*0x5c+o) for o in range(0,0x5c,4) if o not in (0x18,0x20,0x28,0x30)].count(False), 0)
check('the other 20 records unchanged', RT[tbl-BASE:rec-BASE]+RT[rec+0x5c-BASE:tbl+21*0x5c-BASE]==OFFICIAL[tbl-BASE:rec-BASE]+OFFICIAL[rec+0x5c-BASE:tbl+21*0x5c-BASE], True)
for v in range(4):
    call(mu,h(0x28),(this,v)); check(f'set {v} -> byte', mu.mem_read(SF,1)[0], v)
    check(f'  is-current({v})', [call(mu,h(0x20),(this,i)) for i in range(4)], [1 if i==v else 0 for i in range(4)])
call(mu,h(0x28),(this,7)); check('set 7 ignored', mu.mem_read(SF,1)[0], 3)
mu.mem_write(SF,b'\x7a')
check('byte 0x7a (left-over) reads as off', [call(mu,h(0x20),(this,i)) for i in range(4)], [1,0,0,0])
check('  and is reset to 0', mu.mem_read(SF,1)[0], 0)
mu.mem_write(SF,b'\x04')
check('byte 4 reads as off', [call(mu,h(0x20),(this,i)) for i in range(4)], [1,0,0,0])
# draw: capture text numbers
got=[]
stub(mu,0x53570a9c,lambda uc:0x70001000+uc.reg_read(R1))
stub(mu,0x5357de6c,lambda uc:got.append((uc.reg_read(R0)-0x70001000,uc.reg_read(R1))))
mu.mem_write(this+0x1f8,struct.pack('<I',0x70002000))
for i in range(5): call(mu,h(0x18),(this,i))
check('draw labels (item, text)', got, [(0,2),(1,9),(2,10),(3,11),(4,0)])
# 3b. the check over the five slots (0x531bd0ac, official table): soft focus behaves as Crop
def slots_check(slots, avail):
    mu=mk(); install_stubs(mu)
    stub(mu,0x5323ea84,lambda uc:0); stub(mu,0x5323f018,lambda uc:MODEL); stub(mu,0x531bcd00,lambda uc:0)
    stub(mu,0x531bc9b4,lambda uc:avail)  # availability of Image Control, Crop, ... (a camera-mode test)
    mu.mem_write(MODEL+0x920,bytes(slots))
    return call(mu,0x531bd0ac,(0x70000000,))
for avail in (0,1):
    for sl in ([0x0a,0,0,0,0],[0,0,0,0,0x0a],[15,0x0a,0,0,0]):
        crop=[0x13 if x==0x0a else x for x in sl]
        got,want=slots_check(sl,avail),slots_check(crop,avail)
        check(f'five-slot check {sl} avail {avail} as with Crop', got, want)
# 4. ADJ mode setting list (0x531dae24): vector at +0x1a8
mu=mk(); install_stubs(mu)
heap=[0x70100000]
def new(uc):
    n=uc.reg_read(R0); p=heap[0]; heap[0]+= (n+15)&~15; return p
stub(mu,0x538e09b0,new); stub(mu,0x538e09ec,lambda uc:0); stub(mu,0x538ed930,lambda uc:0)
stub(mu,0x533ef000,lambda uc:0)
obj=0x70200000
call(mu,0x531dae1c,(obj,))
b,e=struct.unpack('<II',mu.mem_read(obj+0x1a8,8))
check('ADJ mode setting list', list(mu.mem_read(b,e-b)), [0,1,2,3,4,5,19,6,7,8,9,11,12,13,14,15,0x0a,16,20,17])
# 5. clarity parameter (SetEffectParameter 0x53701c44)
def effect(sfv, clar):
    mu=mk(); install_stubs(mu); stub(mu,0x538ed930,lambda uc:0)
    obj=0x70000000; prm=0x70000100; shot=0x70010000
    mu.mem_write(obj+0x10,struct.pack('<I',prm))
    mu.mem_write(shot+0x79c,b'\x00'); mu.mem_write(shot+0x7b3,b'\x04'); mu.mem_write(shot+0x7da,b'\x00')
    mu.mem_write(shot+0x7b4,bytes([clar])); mu.mem_write(shot+0x7b8,b'\x00'); mu.mem_write(shot+0x7b5,b'\x00')
    mu.mem_write(SF,bytes([sfv]))
    call(mu,0x53701c40,(obj,shot,1))
    return struct.unpack('<h',mu.mem_read(prm+2,2))[0]
for sfv in range(4):
    check(f'clarity param, soft focus {sfv}', [effect(sfv,c) for c in range(9)], [c-4 for c in range(9)] if sfv==0 else [sfv+4]*9)
check('clarity param, byte 9 (invalid) ignored', effect(9,6), 2)
# 5b. the digital-filter step gate (0x537150fc -> flags+0x25)
def gate(img, kind, c7b3, clar, sfv, c7b5=0):
    mu=make(img); fl=0x70000000; shot=0x70010000
    mu.mem_write(shot+0x79c,bytes([kind])); mu.mem_write(shot+0x7b3,bytes([c7b3])); mu.mem_write(shot+0x7b4,bytes([clar]))
    mu.mem_write(shot+0x7b5,bytes([c7b5])); mu.mem_write(shot+0x7b8,b'\x00')
    mu.mem_write(SF,bytes([sfv]))
    call(mu,0x537150fc,(fl,shot))
    return mu.mem_read(fl+0x25,1)[0]
diffs=[]
for kind in range(0x0a,0x20):
    for c3 in (4,5):
        for clar in (4,6):
            for sfv in (0,1,2,3,4,0x7a):
                got=gate(RT,kind,c3,clar,sfv); off=gate(OFFICIAL,kind,c3,clar,sfv)
                want = 1 if (sfv in (1,2,3) and off==0 and gate(OFFICIAL,kind,c3,6,0)==1) else off
                if got!=want: diffs.append((kind,c3,clar,sfv,got,want))
check('digital-filter step: on with soft focus where Clarity could turn it on, else as official', diffs, [])
check('  e.g. image control 0x0b, Clarity 0, soft focus medium', gate(RT,0x0b,4,4,2), 1)
check('  e.g. image control 0x0b, Clarity 0, soft focus off', gate(RT,0x0b,4,4,0), 0)
# 5c. slot getters: above 0x14 reads as off
mu=mk()
for i,g in enumerate([0x5329c240,0x5329c248,0x5329c250,0x5329c258,0x5329c260]):
    res=[]
    for v in (0,0x0a,0x14,0x15,0x16,0xff):
        mu.mem_write(MODEL+0x920+i,bytes([v])); res.append(call(mu,g,(MODEL,)))
    check(f'slot {i+1} getter (0,0a,14,15,16,ff)', res, [0,0x0a,0x14,0,0,0])
# 6. clarity row selection stub
mu=mk()
rowstub=None
w=rdw(RT,0x538a2634); off=w&0xffffff; off = off-(1<<24) if off&0x800000 else off; rowstub=0x538a2634+8+off*4
rows=None
for r8 in range(12):
    mu.reg_write(UC_ARM_REG_R8,r8); mu.reg_write(UC_ARM_REG_R3,0x16); mu.reg_write(UC_ARM_REG_R1,0x60001000)
    call(mu,rowstub,())
    p=mu.reg_read(UC_ARM_REG_R8)
    if r8<=8: check(f'row {r8} on stack copy', p, 0x60001000+0x16*r8)
    else:
        g=struct.unpack('<11h',mu.mem_read(p,22)); print(f'     row {r8} ->', hex(p), g)
check('range check now <= 11', rdw(RT,0x538a2000), 0xe358000b)
print('ALL PASS' if ok else 'SOME FAILED')
