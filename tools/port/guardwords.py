# SPDX-License-Identifier: GPL-2.0-only
"""List instruction words written in the port's sources whose firmware word changed (development tool).

    python3 tools/port/guardwords.py OLD-rtos NEW-rtos MAP.json RAMSRC_OLD RAMSRC_NEW SOURCE...

For every mapped code address and its neighbourhood (-0x40..+0x80), where the old word differs from
the new word at the mapped place, and the old word is written as a literal in a source file, print
both words, decoded, and whether the change is only relocation (a branch to the mapped target, a
movw/movt half of a mapped address). Guards compare such literals with the firmware, so each listed
one either needs the new word (relocation only) or a look by hand.
"""
import json, re, struct, sys
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
md = Cs(CS_ARCH_ARM, CS_MODE_ARM); B = 0x53000000
old = open(sys.argv[1], 'rb').read(); new = open(sys.argv[2], 'rb').read()
amap = {int(k, 16): int(e['new'], 16) for k, e in json.load(open(sys.argv[3]))['addresses'].items() if e['new']}
srcs = {f: open(f, encoding='utf-8').read().lower() for f in sys.argv[6:]}
w = lambda b, a: struct.unpack_from('<I', b, a - B)[0]
def dis(x, a):
    try: i = next(md.disasm(struct.pack('<I', x), a)); return f'{i.mnemonic} {i.op_str}'
    except StopIteration: return '?'
def explain(v, u, a, b):
    if (v & 0x0e000000) == 0x0a000000 and (u & 0x0e000000) == 0x0a000000 and (v >> 24) == (u >> 24):
        def t(x, at): off = x & 0xffffff; off -= 0x1000000 if off & 0x800000 else 0; return at + 8 + off * 4
        ta, tb = t(v, a), t(u, b)
        return 'branch, relocated' if amap.get(ta) == tb else f'branch {ta:#x} -> {tb:#x} (old target {"maps to " + hex(amap[ta]) if ta in amap else "not in map"})'
    for kind, mask in (('movw', 0x03000000), ('movt', 0x03400000)):
        if (v & 0x0ff00000) == mask and (u & 0x0ff00000) == mask and (v & 0xf000f000) == (u & 0xf000f000) and (v >> 12 & 15) == (u >> 12 & 15):
            iv = ((v >> 4) & 0xf000) | (v & 0xfff); iu = ((u >> 4) & 0xf000) | (u & 0xfff)
            return f'{kind} {iv:#06x} -> {iu:#06x}'
    return 'DIFFERENT INSTRUCTION'
seen = set()
for a, b in sorted(amap.items()):
    if not (B <= a < B + len(old) - 0x80 and B <= b < B + len(new) - 0x80) or a >= 0x54000000: continue
    for d in range(-0x40, 0x84, 4):
        x, y = (a & ~3) + d, (b & ~3) + d
        if x in seen: continue
        seen.add(x)
        v, u = w(old, x), w(new, y)
        if v == u: continue
        lit = f'{v:#010x}'
        files = [f.split('/')[-1] for f, s in srcs.items() if re.search(r'\b' + lit + r'\b', s)]
        if files:
            print(f'{x:#x} -> {y:#x}  {v:#010x} {dis(v, x):32s} -> {u:#010x} {dis(u, y):32s} [{explain(v, u, x, y)}] {",".join(files)}')
