#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""The focus distance's number with the camera's own view code (GR IV 1.20 only: the emulator of
tools/gr4v120/datestamp/menu_check.py): the camera's view factory makes a root view and a distance scale (its
constructor with the cleared words), the module makes the number's view (the camera's AsciiView, a child of the
root), sets its text, width and place and shows and hides it through the camera's own functions, moves it under
a focus frame the camera's factory made (a type 5 view in a type 9 view, placed and shown by the camera's own
functions), and the scale's destructor frees the scale's ten children and then the number. The camera's text
measuring needs its graphics engine: a stub answers 46 px. Prints what it finds; exits 1 on a difference.

    python3 tools/afdist/check_views.py BUILT-1.20-RTOS [feet]
"""
import struct
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gr4v120' / 'datestamp'))
import menu_check as dm
from unicorn.arm_const import *
img=dm.Image(sys.argv[1])
e=dm.Emu(img)
mu=e.mu
freed=[]
e.stubs[0x539084f8]=lambda: freed.append(mu.reg_read(UC_ARM_REG_R0)) or 0   # operator delete
e.stubs[0x5390856c]=lambda: 0   # free of text buffers
for a in (0x5359a104,0x53593404,0x532406a4,0x5324123c,0x5324111c): e.stubs[a]=lambda: 0
e.stubs[0x53590be0]=lambda: 46   # the width of an AsciiView's text
mu.mem_map(0x5f000000,0x1000000); e.heap[0]=0x5f400000
ALLOC,VT,A_ALLOC,A_FREE=0x5f300000,0x5f300100,0x5f300200,0x5f300300
mu.mem_write(ALLOC, struct.pack('<I',VT)); mu.mem_write(VT, struct.pack('<4I',A_FREE,A_FREE,A_ALLOC,A_FREE))
def alloc():
    n=mu.reg_read(UC_ARM_REG_R1); p=e.heap[0]; e.heap[0]+=(n*4+15)&~15; return p
def malloc():
    n=mu.reg_read(UC_ARM_REG_R0); p=e.heap[0]; e.heap[0]+=(n+15)&~15; return p
e.stubs[0x53908530]=malloc
e.stubs[A_ALLOC]=alloc; e.stubs[A_FREE]=lambda: 0; e.stubs[0x53913120]=lambda: ALLOC
def desc(t,x,y,w,h):
    a=0x5f200000+len(e.calls)*0  # scratch
    p=0x5f200000
    mu.mem_write(p, struct.pack('<B3x4i',t,x,y,w,h)); return p
def target(a):
    w=img.u32(a); off=w&0xffffff
    if off&0x800000: off-=0x1000000
    return a+8+off*4
FACTORY=0x535ad1b4
root=e.call(FACTORY,(desc(1,0,0,720,480),))
scale=e.call(FACTORY,(desc(4,0,0,60,200),))
assert [e.u32(scale+o) for o in (0x128,0x12c,0x130,0x134)]==[0,0,0,0], 'a new scale: the four words cleared'
views=0x5f210000
mu.mem_write(views, struct.pack('<I',root)); mu.mem_write(views+26*4, struct.pack('<I',scale))
create=target(0x5318bb90)
# ctx: movw/movt r0 in the create stub
ctx=None
for a in range(create,create+0x30,4):
    w=img.u32(a)
    if (w&0xfff0f000)==0xe3000000: lo=((w>>4)&0xf000)|(w&0xfff)
    if (w&0xfff0f000)==0xe3400000: ctx=lo|((((w>>4)&0xf000)|(w&0xfff))<<16)
code=None
for a in range(create,create+0x30,4):
    w=img.u32(a)
    if (w>>24)==0xeb: code=target(a)
e.call(code,(ctx,0,views,0)); text=e.u32(scale+0x128)
lv=0x5f220000; info=0x5f230000
holder=e.call(FACTORY,(desc(9,0,0,720,480),)); e.call(0x535ab428,(root,holder))
frame=e.call(FACTORY,(desc(5,0,0,0,0),)); e.call(0x535ab428,(holder,frame))
mu.mem_write(lv+0x15c, struct.pack('<I',root)); mu.mem_write(lv+0x15c+26*4, struct.pack('<I',scale))
mu.mem_write(lv+0x15c+44*4, struct.pack('<I',holder)); mu.mem_write(lv+0x15c+62*4, struct.pack('<I',frame))
mu.mem_write(lv+0x4ec, struct.pack('<I',info)); mu.mem_write(info+0x998,b'\0'); mu.mem_write(info+0x6e8, struct.pack('<I',1800))
# the module's ram(): needs 0x54..0x5f addresses for lv; views made by Emu's heap are at 0x704..: outside -> expect the module to refuse
r=e.call(code,(ctx,2,lv,scale))

FEET = len(sys.argv) > 2 and sys.argv[2] == 'feet'
utf16 = lambda: bytes(mu.mem_read(e.u32(text + 0xf0), 16)).decode('utf-16-le').split('\0')[0]
bad = lambda: [c for c in e.calls if c[0] in ('ASSERT', 'NULL-JUMP')]
ok = True
def expect(cond, what):
    global ok
    print(('  ' if cond else '  FAIL ') + what)
    ok = ok and cond
expect(text and e.u32(text) == 0x53ece200 and e.u32(text + 4) == root, f'the number\'s view is an AsciiView, child of the root: {text:#x}')
expect((e.byte(text + 0xec), e.byte(text + 0x108), e.byte(text + 0x109), e.byte(text + 0xf4)) == (1, 20, 20, 1), 'set up as the screen\'s small text')
rect = lambda v: struct.unpack('<4i', bytes(mu.mem_read(v + 0x20, 16)))
expect(e.u32(holder) != e.u32(frame) and e.u32(frame + 4) == holder and e.byte(frame + 0x9e) == 1 and e.byte(holder + 0x9e) == 1, 'a focus frame from the camera\'s factory, child of the frames\' view, both shown as made')
e.call(0x535acd84, (frame, 0))
expect(utf16() == ('5.9FT' if FEET else '1.8M') and rect(text) == (2, 362, 50, 20) and e.byte(text + 0x9e) == 1 and not bad(), f'1800 mm, no frame: "{utf16()}" 50 px wide at (2, 362), shown: {rect(text)}')
mu.mem_write(info + 0x6e8, struct.pack('<I', 345)); e.call(code, (ctx, 2, lv, scale))
expect(utf16() == ('1.1FT' if FEET else '0.35M') and e.byte(text + 0x9e) == 1, f'345 mm: "{utf16()}"')
# a frame 80 x 80 at (320, 200), placed and shown the way the camera's own code does it; the scale shown
mu.mem_write(0x5f240000, struct.pack('<4i', 320, 200, 80, 80))
e.call(e.u32(e.u32(frame) + 0x18), (frame, 0x5f240000)); e.call(0x53597ae4, (frame, 3)); e.call(0x535acd84, (frame, 1)); e.call(0x535acd84, (scale, 1))
expect(rect(frame) == (320, 200, 80, 80) and e.byte(frame + 0xee) == 3 and e.byte(scale + 0x9e) == 1, f'the frame placed by the camera\'s functions: {rect(frame)}')
e.call(code, (ctx, 3, lv, 0))
expect(rect(text) == (335, 284, 50, 20) and e.byte(text + 0x9e) == 1 and not bad(), f'the frames placed: the number centred under the frame: {rect(text)}')
e.call(0x535acd84, (holder, 0)); e.call(code, (ctx, 3, lv, 0))
expect(rect(text) == (2, 362, 50, 20) and e.byte(text + 0x9e) == 1, f'the frames\' view hidden: back under the scale: {rect(text)}')
e.call(0x535acd84, (scale, 0)); e.call(code, (ctx, 3, lv, 0))
expect(e.byte(text + 0x9e) == 0, 'the scale hidden: the number hidden with it')
e.call(0x535acd84, (scale, 1)); e.call(code, (ctx, 2, lv, scale))
e.call(code, (ctx, 1, lv, scale))
expect(e.byte(text + 0x9e) == 0, 'hidden with the scale')
e.call(0x535925a8, (scale,))
expect(len(freed) == 11 and freed[-1] == text and len(set(freed)) == 11 and e.u32(scale + 0x128) == 0 and not bad(), f'the scale\'s destructor frees its ten children, then the number: {len(freed)} views')
print('ok' if ok else 'FAILED')
sys.exit(0 if ok else 1)
