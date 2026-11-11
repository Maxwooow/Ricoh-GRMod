"""GR III 2.20 / GR IIIx 1.70: Minimum Shutter Speed (ISO Setting) down to 30 s.

The camera's own list (SvAutoLowerTvSetController) has 31 values, 1/1000 .. 1 s, from a table of
(numerator, denominator) at 0x53b41b38. That table is the camera's third-stop shutter table at
0x53d62cb8 (30 s .. 1/25600, Tv = i/3 - 5) read backwards from 1/1000 (index 45) to 1 s (index 15).
Here the list reads that same table backwards from index 45 down to index 0: 46 values,
1/1000 .. 1 s as before, then 1.3 s .. 30 s. Nothing is added to the image; 16 words change.
"""
import struct, json, sys
from keystone import Ks, KS_ARCH_ARM, KS_MODE_ARM
ks = Ks(KS_ARCH_ARM, KS_MODE_ARM)
STEPS = 0x53d62cb8          # third-stop (num, den) table, 60 entries
FIRST = STEPS + 45 * 4      # 1/1000
COUNT = 46
OLD_TABLE, OLD_COUNT = 0x53b41b38, 31
def asm(src, at):
    enc, _ = ks.asm(src, at)
    b = bytes(enc); assert len(b) % 4 == 0
    return [struct.unpack_from('<I', b, i)[0] for i in range(0, len(b), 4)]
def one(src, at):
    w = asm(src, at); assert len(w) == 1, src; return w[0]
CREATE = 0x531cfa20
def sites():
    s = []
    def put(at, old_src, new_src, why):
        s.append(dict(address=at, expected=one(old_src, at), replacement=one(new_src, at), reason=why))
    lo, hi = FIRST & 0xffff, FIRST >> 16
    # populate rows (0x531cfab0)
    put(0x531cfac0, 'movw r4, #0x1b38', f'movw r4, #{lo:#x}', 'rows: first value, third-stop table at 1/1000')
    put(0x531cfacc, 'movt r4, #0x53b4', f'movt r4, #{hi:#x}', 'rows: first value (high half)')
    put(0x531cfb18, 'cmp r5, #0x1f', f'cmp r5, #{COUNT}', 'rows: 46 values')
    put(0x531cfb1c, 'add r4, r4, #4', 'sub r4, r4, #4', 'rows: the table backwards (slower)')
    # set the value (0x531cf880)
    put(0x531cf898, 'movw r3, #0x1b38', f'movw r3, #{lo:#x}', 'set: table')
    put(0x531cf89c, 'movt r3, #0x53b4', f'movt r3, #{hi:#x}', 'set: table (high half)')
    put(0x531cf8a4, 'add r2, r3, r0', 'sub r2, r3, r0', 'set: index counts backwards')
    put(0x531cf8a8, 'ldrh r5, [r3, r0]', 'ldrh r5, [r3, -r0]', 'set: index counts backwards')
    # mark the current value (0x531cfb40)
    put(0x531cfb68, 'movw r5, #0x1b38', f'movw r5, #{lo:#x}', 'current: table')
    put(0x531cfb88, 'movt r5, #0x53b4', f'movt r5, #{hi:#x}', 'current: table (high half)')
    put(0x531cfbc0, 'add r5, r5, #4', 'sub r5, r5, #4', 'current: backwards')
    put(0x531cfbc8, 'cmp r4, #0x1f', f'cmp r4, #{COUNT}', 'current: 46 values')
    put(0x531cfc04, 'add r5, r5, #4', 'sub r5, r5, #4', 'current: backwards')
    put(0x531cfc1c, 'cmp r4, #0x1f', f'cmp r4, #{COUNT}', 'current: 46 values')
    # Down held at the last value stops there (0x531cf7e8)
    put(0x531cf824, 'cmp r0, #0x1e', f'cmp r0, #{COUNT - 1}', 'keys: last value')
    # create the list (0x531cfa20): 46 row types (0x15) in a larger stack buffer; same entry, same callee
    body = f'''
        mov ip, sp
        push {{r4, fp, ip, lr, pc}}
        sub fp, ip, #4
        sub sp, sp, #0x34
        mov r4, r0
        mov r1, sp
        mov r2, #0x15
        mov r3, #{COUNT}
    fill:
        strb r2, [r1], #1
        subs r3, r3, #1
        bne fill
        ldr r0, [r4, #0x160]
        mov r1, sp
        mov r2, #{COUNT}
        mov r3, #0x3a
        bl 0x53394700
        sub sp, fp, #0x10
        ldm sp, {{r4, fp, sp, pc}}
    '''
    new = asm(body, CREATE)
    return s, new
if __name__ == '__main__':
    s, new = sites()
    print(json.dumps(dict(sites=[{k: (hex(v) if isinstance(v, int) else v) for k, v in x.items()} for x in s], create=[hex(w) for w in new]), indent=1))
