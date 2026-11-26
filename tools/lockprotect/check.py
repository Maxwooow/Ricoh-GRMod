# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the lock button's Protect (core/src/fw/gr4v120/aspect/lockprotect.ts).

    python3 tools/lockprotect/check.py 1.20|1.21 OFFICIAL.rtos BUILT.rtos BUILT-WITHOUT.rtos

Development tool, not part of the program. Runs the camera's switch translator (its own code) for
the lock button and for other switches / event data, with the functions the stub calls replaced by
recorders, and checks what is called with which arguments, the return value, the stack and the
callee-saved registers. Also checks that the build differs from the one without the option only by
the hook word and appended code.
"""
import struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import *

ADDR = {
    '1.20': dict(translator=0x53257a14, hook=0x53257e38, trigger=0x5325784c, app=0x532406a4, queue=0x53240818,
                 playback=0x53240998, media=0x532409f8, getid=0x53261f1c, allowed=0x532684fc, protect=0x5326676c,
                 onevent=0x53196528, hook2=0x5319661c, restart=0x531939d4, screen=0x53185054, display=0x53193950),
    '1.21': dict(translator=0x53258260, hook=0x53258684, trigger=0x53258098, app=0x53240cac, queue=0x53240e20,
                 playback=0x53240fa0, media=0x53241000, getid=0x5326276c, allowed=0x53268d4c, protect=0x53266fbc,
                 onevent=0x53196528, hook2=0x5319661c, restart=0x531939d4, screen=0x53185054, display=0x53193950),
}
ver, official, built, without = sys.argv[1:5]
A = ADDR[ver]
BASE = 0x53000000
off = open(official, 'rb').read(); img = open(built, 'rb').read(); base = open(without, 'rb').read()

# 1. the build's own words
diff = [i for i in range(0, min(len(img), len(base)), 4) if img[i:i+4] != base[i:i+4]]
hook_off = A['hook'] - BASE
inside = [i for i in diff if i < len(off)]
imm = struct.unpack_from('<I', img, hook_off)[0] & 0xffffff
stub = A['hook'] + 8 + 4 * (imm - (1 << 24) if imm & 0x800000 else imm)
assert struct.unpack_from('<I', img, hook_off)[0] >> 24 == 0xea, 'hook is not a branch'
print('words changed inside the official image:', [hex(BASE + i) for i in inside], 'stub at', hex(stub))
assert hook_off in inside
# everything else that differs is the stub (appended) and the build's own records after it
assert inside == sorted([hook_off, A['hook2'] - BASE]) and stub >= BASE + len(off)

APP, QUEUE, PB, MEDIA, THIS, EVT, STACK, RET = 0x10001000, 0x10002000, 0x10003000, 0x10004000, 0x10005000, 0x10006000, 0x20000000, 0x30000000

def run(switch, data, queue_id, pb_id=0x04000001, allowed=1, protect_ret=1):
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, (len(img) + 0xfff) & ~0xfff); mu.mem_write(BASE, img)
    mu.mem_map(0x10000000, 0x10000); mu.mem_map(STACK - 0x10000, 0x10000); mu.mem_map(RET, 0x1000)
    mu.mem_write(QUEUE, struct.pack('<I', queue_id))
    mu.mem_write(EVT, struct.pack('<II', 0, EVT + 0x10) + bytes(8) + data)
    calls = []
    def ret(v):
        mu.reg_write(UC_ARM_REG_R0, v); mu.reg_write(UC_ARM_REG_R1, 0xdead0001); mu.reg_write(UC_ARM_REG_R2, 0xdead0002)
        mu.reg_write(UC_ARM_REG_R3, 0xdead0003); mu.reg_write(UC_ARM_REG_IP, 0xdead000c); mu.reg_write(UC_ARM_REG_PC, mu.reg_read(UC_ARM_REG_LR))
    def code(mu_, pc, size, _):
        r0, r1 = mu.reg_read(UC_ARM_REG_R0), mu.reg_read(UC_ARM_REG_R1)
        if pc == A['app']: ret(APP)
        elif pc == A['queue']: assert r0 == APP; ret(QUEUE)
        elif pc == A['playback']: assert r0 == APP; ret(PB)
        elif pc == A['media']: assert r0 == APP; ret(MEDIA)
        elif pc == A['getid']: assert r0 == PB; calls.append(('getid',)); ret(pb_id)
        elif pc == A['allowed']: assert r0 == MEDIA and r1 == 4; calls.append(('allowed',)); ret(allowed)
        elif pc == A['protect']: assert r0 == MEDIA; calls.append(('protect',)); ret(protect_ret)
        elif pc == A['trigger']: calls.append(('trigger', r0, r1, mu.reg_read(UC_ARM_REG_SP), mu.reg_read(UC_ARM_REG_LR))); ret(0x77)
        elif pc == RET: mu.emu_stop()
        elif not (A['translator'] <= pc < A['translator'] + 0x700 or stub <= pc < stub + 0x80):
            raise AssertionError('left the translator: %#x' % pc)
    mu.hook_add(UC_HOOK_CODE, code)
    saved = {UC_ARM_REG_R4: 0x44444444, UC_ARM_REG_R5: 0x55555555, UC_ARM_REG_R6: 0x66, UC_ARM_REG_R7: 0x77, UC_ARM_REG_R8: 0x88,
             UC_ARM_REG_R9: 0x99, UC_ARM_REG_R10: 0xaa, UC_ARM_REG_R11: 0xbb, UC_ARM_REG_SP: STACK - 0x100}
    for k, v in saved.items(): mu.reg_write(k, v)
    mu.reg_write(UC_ARM_REG_R0, THIS); mu.reg_write(UC_ARM_REG_R1, EVT); mu.reg_write(UC_ARM_REG_R2, 0); mu.reg_write(UC_ARM_REG_R3, switch)
    mu.reg_write(UC_ARM_REG_LR, RET)
    mu.emu_start(A['translator'], 0, count=5000)
    assert mu.reg_read(UC_ARM_REG_PC) == RET, 'did not return'
    for k, v in saved.items(): assert mu.reg_read(k) == v, 'register / stack not restored'
    return calls, mu.reg_read(UC_ARM_REG_R0)

PUSHED, RELEASED = struct.pack('<II', 2, 0), struct.pack('<II', 1, 7)
SP0 = STACK - 0x100
trig = lambda n: [('trigger', THIS, n, SP0, RET)]
# single picture in front: the request, nothing else
assert run(0x26, PUSHED, 0x04000001) == ([('allowed',), ('protect',)], 0)
assert run(0x26, PUSHED, 0x04000000, 0x04000001) == ([('getid',), ('allowed',), ('protect',)], 0)
assert run(0x26, PUSHED, 0x04000001, protect_ret=0) == ([('allowed',), ('protect',)], 0)
assert run(0x26, PUSHED, 0x04000001, allowed=0) == ([('allowed',)], 0)
# everything else in front: trigger 4 as in the official firmware
for pb in (0x04000004, 0x04000002, 0x04000003, 0x04000005, 0):
    assert run(0x26, PUSHED, 0x04000000, pb) == ([('getid',)] + trig(4), 0x77), hex(pb)
for q in (0, 0x01000000, 0x01000002, 0x02000000, 0x02000084, 0x020000d7, 0x0200012e, 0x04000004, 0x04000002, 0x0400000d, 0x05000001):
    assert run(0x26, PUSHED, q) == (trig(4), 0x77), hex(q)
# other event data of the button: nothing, as in the official firmware
for d in (RELEASED, struct.pack('<II', 0, 0), struct.pack('<II', 2, 1), struct.pack('<II', 3, 0)):
    assert run(0x26, d, 0x04000001) == ([], 0)
for d in (PUSHED, RELEASED):
    c, _ = run(0x27, d, 0x04000001)
    assert not any(x[0] in ('protect', 'allowed') for x in c), c

# the single picture's event handler: 0x132 takes the case of 0x135; every other event as in the build without
def first_call(image, event):
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, (len(image) + 0xfff) & ~0xfff); mu.mem_write(BASE, image)
    mu.mem_map(0x10000000, 0x10000); mu.mem_map(STACK - 0x10000, 0x10000); mu.mem_map(RET, 0x1000)
    mu.mem_write(EVT, struct.pack('<H', event)); mu.mem_write(THIS, b'\x01' * 0x400)
    out = []
    def code(mu_, pc, size, _):
        if pc == RET: out.append(('return', mu.reg_read(UC_ARM_REG_R0))); mu.emu_stop()
        elif not (A['onevent'] <= pc < A['onevent'] + 0x308 or pc >= BASE + len(off)): out.append(('call', pc)); mu.emu_stop()
    mu.hook_add(UC_HOOK_CODE, code)
    mu.reg_write(UC_ARM_REG_SP, SP0); mu.reg_write(UC_ARM_REG_R0, THIS); mu.reg_write(UC_ARM_REG_R1, EVT); mu.reg_write(UC_ARM_REG_LR, RET)
    mu.emu_start(A['onevent'], 0, count=300)
    return out
assert first_call(img, 0x135) == [('call', A['restart'])] == first_call(base, 0x135)
assert first_call(base, 0x132) == [('return', 0)]
def done(screen):
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(BASE, (len(img) + 0xfff) & ~0xfff); mu.mem_write(BASE, img)
    mu.mem_map(0x10000000, 0x10000); mu.mem_map(STACK - 0x10000, 0x10000); mu.mem_map(RET, 0x1000)
    mu.mem_write(EVT, struct.pack('<H', 0x132))
    out = []
    def leave(v):
        mu.reg_write(UC_ARM_REG_R0, v)
        for r in (UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_IP): mu.reg_write(r, 0xdead0000)
        mu.reg_write(UC_ARM_REG_PC, mu.reg_read(UC_ARM_REG_LR))
    def code(mu_, pc, size, _):
        if pc == RET: mu.emu_stop()
        elif pc == A['screen']: assert mu.reg_read(UC_ARM_REG_R0) == THIS; out.append('screen'); leave(screen)
        elif pc == A['display']: out.append(('display', mu.reg_read(UC_ARM_REG_R0), mu.reg_read(UC_ARM_REG_R1), mu.reg_read(UC_ARM_REG_R2))); leave(1)
        elif not (A['onevent'] <= pc < A['onevent'] + 0x308 or pc >= BASE + len(off)): raise AssertionError(hex(pc))
    mu.hook_add(UC_HOOK_CODE, code)
    saved = {UC_ARM_REG_R4: 0x44444444, UC_ARM_REG_R5: 0x55, UC_ARM_REG_R11: 0xbb, UC_ARM_REG_SP: SP0}
    for k, v in saved.items(): mu.reg_write(k, v)
    mu.reg_write(UC_ARM_REG_R0, THIS); mu.reg_write(UC_ARM_REG_R1, EVT); mu.reg_write(UC_ARM_REG_LR, RET)
    mu.emu_start(A['onevent'], 0, count=300)
    assert mu.reg_read(UC_ARM_REG_PC) == RET and mu.reg_read(UC_ARM_REG_R0) == 0
    for k, v in saved.items(): assert mu.reg_read(k) == v
    return out
assert done(0x04000001) == ['screen', ('display', THIS, 2, 0)]
for scr in (0x04000000, 0x04000004, 0x0400002c, 0x04000011, 0x02000063, 0):
    assert done(scr) == ['screen'], hex(scr)
for e in range(0, 0x200):
    if e != 0x132: assert first_call(img, e) == first_call(base, e), hex(e)
print(ver, 'ok')
