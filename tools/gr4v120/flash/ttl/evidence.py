# SPDX-License-Identifier: GPL-2.0-only
"""Re-check the firmware facts flash TTL relies on (README.md, flttl.c, flttl.ts) against the official GR IV 1.20
RTOS section.

Usage: GRIV_RTOS=/path/to/decoded/RTOS python3 evidence.py
(the RTOS section of the official 1.20 fwdc248b.bin, SHA256 7563d7e4...650d; load base 0x53000000). Needs capstone + numpy.
Every check prints PASS/FAIL; nothing is written.
"""
import os, struct, sys
import numpy as np
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM

B = 0x53000000
b = open(os.environ['GRIV_RTOS'], 'rb').read()
D = np.frombuffer(b[:len(b) // 4 * 4], dtype='<u4').astype(np.int64)
md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
md.skipdata = True
ok = True


def check(name, cond, detail=''):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))


def ins(a, n=1):
    return [(i.mnemonic, i.op_str) for i in md.disasm(b[a - B:a - B + 4 * n], a)]


def cstr(a):
    e = b.index(b'\0', a - B)
    return b[a - B:e].decode('latin1')


def w(a):
    return struct.unpack_from('<I', b, a - B)[0]


def f32(a):
    return struct.unpack_from('<f', b, a - B)[0]


def callers(t):
    isb = ((D >> 25) & 7) == 5
    off = D & 0xffffff
    off = np.where(off & 0x800000, off - (1 << 24), off)
    tgt = B + np.arange(len(D)) * 4 + 8 + 4 * off
    return [B + 4 * int(i) for i in np.nonzero(isb & (tgt == t) & ((D >> 28) != 0xf))[0]]


def movwt_values():
    """Every 32-bit constant built by movw/movt pairs (same register, within 8 instructions)."""
    isw = ((D >> 20) & 0xff) == 0x30
    ist = ((D >> 20) & 0xff) == 0x34
    imm = ((D >> 4) & 0xf000) | (D & 0xfff)
    rd = (D >> 12) & 0xf
    T = set(np.nonzero(ist)[0].tolist())
    out = {}
    for i in np.nonzero(isw)[0]:
        for j in range(i + 1, min(i + 8, len(D))):
            if j in T and rd[j] == rd[i]:
                out.setdefault(int((imm[j] << 16) | imm[i]), []).append(B + 4 * int(i))
                break
    return out


# 1. hot shoe = serial bus (GPIO SCLK/SCS/SDAI/SDAO or SIO), not a lone trigger line
for a, s in [(0x5438b63c, 'm_GpioHotSclk'), (0x5438b64c, 'm_GpioHotScs'), (0x5438b65c, 'm_GpioHotSdai'),
             (0x5438b66c, 'm_GpioHotSdao')]:
    check(f'hot-shoe GPIO name {s} at {a:#x}', cstr(a) == s)
check('debug shell command prints CmdNo/Dir/DataNum (0x5438b6e0)', cstr(0x5438b6e0).startswith('CmdNo : %d'))

# 2. GF-2 command table at 0x5438bb1c: (cmd, byte count)
tab = list(b[0x5438bb1c - B:0x5438bb1c - B + 26])
pairs = [(tab[i], tab[i + 1]) for i in range(0, 26, 2)]
check('command table C0..C5 / A0..A6', pairs == [(0xc0, 1), (0xc1, 2), (0xc2, 2), (0xc3, 2), (0xc4, 2), (0xc5, 1),
                                                  (0xa0, 1), (0xa1, 1), (0xa2, 1), (0xa3, 1), (0xa4, 1), (0xa5, 1),
                                                  (0xa6, 2)], str([f'{c:#x}/{n}' for c, n in pairs]))
check('identify expects 0xA5 reply (0x53a9b578 cmp r3,#0xa5)', ins(0x53a9b578) == [('cmp', 'r3, #0xa5')])
check('kind 0x11/0x12 from C1 -> FlashDataManager kind 0x10 (0x53a9b668 mov r1,#0x10)',
      ins(0x53a9b654) == [('sub', 'r6, r6, #0x11')] and ins(0x53a9b668) == [('mov', 'r1, #0x10')])
check('FlashOutput 0x53a9b868 is called only from ExtFlashOutput 0x53798160', callers(0x53a9b868) == [0x537981f4])

# 3. body computes the output level byte A0 (1/8 EV steps) for GF-2 (kind 0x10)
check('GF-2 branch: cmp r4,#0x10 at 0x536a54e0', ins(0x536a54e0) == [('cmp', 'r4, #0x10')])
check('step 10 forces A0 = 0x40 (0x536a5624 moveq r1,#0x40)', ins(0x536a5624) == [('moveq', 'r1, #0x40')])
check('A1 = (Sv-5)*8 + 32: constant 32.0 at 0x536a5828', f32(0x536a5828) == 32.0)
check('A2 = Av*8 + 68: constant 68.0 at 0x536a582c', f32(0x536a582c) == 68.0)
check('A0 auto = 8*X + 52: constant 52.0 at 0x536a51d4', f32(0x536a51d4) == 52.0)
check('A0 clamped to flash-reported range (C3 bytes): cmp r4,r7 / cmp r4,r6 at 0x536a5148/0x536a515c',
      ins(0x536a5148) == [('cmp', 'r4, r7')] and ins(0x536a515c) == [('cmp', 'r4, r6')])
check('X = Dv + Av - (Sv-5) + rec+0xe4 [+2 ND] [+3]: vadd/vsub chain at 0x5369cf20..0x5369cf40',
      [m for m, _ in ins(0x5369cf20, 9) if m.startswith(('vadd', 'vsub'))]
      == ['vadd.f32', 'vsub.f32', 'vadd.f32', 'vadd.f32', 'vadd.f32'])
check('Dv from subject distance rec+0x584 in mm, capped at 8000 (0x536a1b00 cmp r0,#0x1f40)',
      ins(0x536a7b60) == [('ldr', 'r0, [r0, #0x584]')] and ins(0x536a1b00) == [('cmp', 'r0, #0x1f40')])

# 4. a complete pre-flash TTL path exists ...
check('m_FlashedY / m_NonFlashY buffers (AeLiveViewExposure +0x153c/+0x1540)',
      cstr(0x53eeb6b4) == 'm_FlashedY' and cstr(0x53eeb6c0) == 'm_NonFlashY')
check('pre-flash calc 0x536923d8 called from the LV-exposure task on flag 4 (0x5368b458)',
      callers(0x536923d8) == [0x5368b458])
check('calc writes rec+0xbc / rec+0xc0', ins(0x536a7dfc) == [('vstr', 's0, [r0, #0xbc]')]
      and ins(0x536a7e0c) == [('vstr', 's0, [r0, #0xc0]')])
check('flash program uses rec+0xc0 instead of distance when rec+0xba is set (0x536a1ab8 -> 0x536a771c)',
      ins(0x536a771c) == [('ldrb', 'r0, [r0, #0xba]')] and 0x536a1ab8 in callers(0x536a771c))
check('AE flash task sends 0x20000003 (pre-flash) at 0x5368a8d0 and sets rec+0xba=1 at 0x5368a964',
      ins(0x5368a8d0) == [('mov', 'r3, #0x20000003')] and 0x5368a964 in callers(0x536a7724))
check('AE interface: command 0x61c40807 -> 0x20000003 (0x536aa148 / 0x536aa9cc)',
      ins(0x536aa9cc) == [('mov', 'r2, #0x20000003')])

# 5. ... but nothing in 1.20 sends the pre-flash command
mv = movwt_values()
s807 = [a for a in mv.get(0x61c40807, [])]
lit807 = [B + 4 * int(i) for i in np.nonzero(D == 0x61c40807)[0]]
check('0x61c40807 is only compared in the dispatcher, never built elsewhere',
      s807 == [0x536aa13c] and lit807 == [], f'movw/movt at {[hex(x) for x in s807]}, literals {lit807}')
check('neighbours ARE sent (0x61c40806 at 0x53674dc0, 0x61c40804 at 0x53674a70)',
      0x53674dc0 in mv.get(0x61c40806, []) and 0x53674a70 in mv.get(0x61c40804, []))

# 6. output scale: full power = 0x4d (77); what the body sent is kept for the picture's MakerNote
check('main flash level capped at 0x4d = full power (0x53798124)', ins(0x53798124, 2) == [('cmp', 'r1, #0x4d'), ('movhs', 'r1, #0x4d')])
check('GF-2 record for the picture: A0 -> rec+0xaf8 (0x5369f72c)', ins(0x5369f72c, 2) == [('bl', '#0x536a3a0c'), ('strb', 'r0, [r4, #0xaf8]')])

# 7. software-triggered emission: the red-eye step
check('RELEASE_STEP_FLASH_RED_EYE handler 0x5367f15c posts accessory request 0xa', ins(0x5367f1c4) == [('mov', 'ip, #0xa')])
check('request 0xa: ExtFlashOutput state 0xd, then 0x537964f8 (0x53797030 / 0x53797070)',
      ins(0x53797030) == [('mov', 'r1, #0xd')] and 0x53797070 in callers(0x537964f8))
check('state 13 is the red-eye emission: debug flag 0xaa (FORCE_FLASH_REDEYE) AND mode==13 swaps A0 (0x537981d4)',
      ins(0x537981d4) == [('mov', 'r1, #0xaa')] and ins(0x537981dc) == [('tst', 'r0, r7')])
check('red-eye level = 0x40 minus 0..4 by flash status (0x53798088 moveq r5,#4)', ins(0x53798088) == [('moveq', 'r5, #4')])
check('0x537964f8 sets a GPIO active: [arb+0x5c]->vtable[0x58] (0x53796534..40)',
      ins(0x53796534, 4) == [('ldr', 'r0, [r4, #0x5c]'), ('ldr', 'r3, [r0]'), ('ldr', 'r3, [r3, #0x58]'), ('blx', 'r3')])
check('that GPIO is id 0xa3 (0x5379637c)', ins(0x5379637c) == [('mov', 'r1, #0xa3')])
check('TopGpio vtable[0x58] = set(1) (0x53a5cf90)', ins(0x53a5cf94) == [('mov', 'r1, #1')] and w(0x54383ed0 + 0x58) == 0x53a5cf90)
check('GPIO released from the alarm-timer event: 0x53796584 called only at 0x537974cc', callers(0x53796584) == [0x537974cc])

# --- flash TTL (ttl/flttl.c): what it reads and where it hooks
check('GF-2 output level, auto branch: X = 0x5369ceb8(), level = 8 X + 52 (0x536a5198..0x536a51a4)',
      ins(0x536a5194, 3) == [('ldr', 'r0, [r5, #0x1c]'), ('bl', '#0x5369ceb8'), ('vmov.f32', 's14, #8.000000e+00')] and f32(0x536a51d4) == 52.0)
check('X\'s distance term is record + 0x84 (0x5369ced4 -> 0x536a7d44), written only at 0x536a66f0, from the lens distance',
      ins(0x5369ced4) == [('bl', '#0x536a7d44')] and ins(0x536a7d44) == [('vldr', 's0, [r0, #0x84]')] and [c for c in callers(0x536a7d4c) if w(c) >> 24 == 0xeb] == [0x536a66f0])   # bl only: a data word can decode as a branch
check('the pre-flash switch record + 0xba: read by the flash program\'s distance term 0x536a1a9c, not inside X (0x5369ceb8)',
      ins(0x536a1ab8) == [('bl', '#0x536a771c')] and 0x5369ceb8 <= 0x5369cf50 and not any(0x5369ceb8 <= c < 0x5369cf50 for c in callers(0x536a771c)))
check('flash data fill for the GF-2: level from 0x536a50b8, 0x40 for state 0xA, stored by 0x536a3a04 (0x536a5618..0x536a562c)',
      ins(0x536a5618, 6) == [('bl', '#0x536a50b8'), ('cmp', 'r7, #0xa'), ('movne', 'r1, r0'), ('moveq', 'r1, #0x40'), ('ldr', 'r0, [r5, #0x24]'), ('bl', '#0x536a3a04')])
check('live view exposure as set: time in microseconds at [object + 0x1474] + 0xA0 (Tv = log2(1e6 / t), 0x5369197c..0x536919a4)',
      ins(0x53691970) == [('ldr', 'r3, [r5, #0x474]')] and ins(0x5369197c) == [('vldr', 's0, [r3, #0xa0]')] and struct.unpack_from('<d', b, 0x53691d70 - B)[0] == 1e6)
check('scene brightness of the per-frame live view AE: record + 0x140 = Bv + 5 (0x5368f858..0x5368f86c; 0x536916d0..f4 with 1/32 steps)',
      ins(0x5368f858) == [('vmov.f32', 's15, #5.000000e+00')] and ins(0x5368f860) == [('vadd.f32', 's0, s0, s15')] and ins(0x536a7f14) == [('vstr', 's0, [r0, #0x140]')]
      and struct.unpack_from('<d', b, 0x536918b0 - B)[0] == 1 / 32 and ins(0x536915b4) == [('add', 'r3, r3, #0x140')])
check('raw block sums: a row is `columns` words, then four words per block (row stride 5 x columns, 0x5368c270..0x5368c2c4)',
      ins(0x5368c270) == [('lsl', 'r8, ip, #2')] and ins(0x5368c2c0, 2) == [('add', 'r5, ip, r5'), ('add', 'r5, r5, r8')])
check('per block: word 0 = pixel count (multiplies the black level), words 1..3 = R, G, B sums (0x5391fca8..0x5391fd34)',
      ins(0x5391fca8) == [('ldr', 'r2, [sl, r4, lsl #2]')] and ins(0x5391fcb0) == [('ldr', 'r6, [r5, #8]')] and ins(0x5391fcb4) == [('mul', 'r0, r0, r2')]
      and ins(0x5391f270) == [('ldrh', 'r3, [r5, #0x10]')] and ins(0x5391f274) == [('ldrh', 'r1, [r5, #0x12]')])

print('ALL PASS' if ok else 'SOME CHECKS FAILED')
sys.exit(0 if ok else 1)
