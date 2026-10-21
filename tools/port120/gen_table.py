# SPDX-License-Identifier: GPL-2.0-only
"""Write core/src/fw/target120.ts: the 1.20 address of every 1.11 address the patcher uses.

Every address written in the sources listed in SOURCES (comments left out) gets an entry:

  - automatically, when the block map of `addrmap.py` places it and the word there is the same in
    both files, or the same up to relocation (every address it holds maps to the address the 1.20
    word holds);
  - by hand (MANUAL below) when it does not: each such entry was found with `look.py` and is
    explained there. A hand entry for an address the map also places must agree with it.

An address that gets neither stops the generator. (The patcher's own checks run on 1.20 too:
every instruction a hook is written around is compared before it is changed.)

    python3 gen_table.py           (numpy; needs both official files, see fwimage.py)
"""
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import addrmap  # noqa: E402
import amap  # noqa: E402
import fwimage  # noqa: E402

REPO = fwimage.REPO
OUT = REPO / 'core/src/fw/target120.ts'
SOURCES = [
    'core/src/fw/aspect/build.ts',
    'core/src/fw/aspect/softfocus.ts',
    'core/src/fw/aspect/datestamp.ts',
    'core/src/fw/aspect/datestamp-menu.ts',
    'core/src/fw/aspect/shutdown.ts',
    'core/src/fw/factory.ts',
    'core/src/fw/aspect/native-link.ts',
    'tools/shutdown/shutdown.c',
]
# This program's own appended area (catalogs, see build.ts `catalogs`): not a firmware address.
OWN = (0x543D2AC0, 0x55000000)

# 1.11 address: (1.20 address, why). Found with look.py (dis / diff / refs).
MANUAL = {
    # --- catalogs and bounds (build.ts)
    0x5323DBB4: (0x5323F7EC, 'icon number bound 1: 1.20 compares with an immediate, cmp r4, #708'),
    0x5323E40C: (0x53240064, 'icon number bound 2: 1.20 compares with an immediate, cmp r7, #708 (1.11: movw r2, #662 at the entry)'),
    0x535734F4: (0x535967C0, 'text number bound (drawing): cmp r7, #880'),
    0x53572AE0: (0x53595DA8, 'text number bound (measuring): cmpls r7, #880'),
    0x55013410: (0x55014280, 'icon catalog, as returned by the icon getter (0x533EF604 -> 0x534013F8)'),
    # --- added ratios (build.ts)
    0x5337FBAC: (0x5338F198, 'ratio identity -> name: same function (texts 280..284), found through its two callers'),
    0x5338143C: (0x53390A88, 'ratio identity -> icon: same function (other icon numbers), found through its two callers'),
    0x53381440: (0x53390A8C, 'ratio identity -> icon, the instruction after the first'),
    0x5374ACFC: (0x5376FB10, 'accept only identities that are in the menu: same function, found through its caller'),
    0x532A90CC: (0x532ADEDC, 'user-mode recall: the bl to the application singleton after the UserData copy (now 0xB44 bytes)'),
    0x5364DC68: (0x53672668, 'tracking windows: same function, object fields from 0x320 on 0x14 further'),
    0x5364DCB0: (0x536726B0, 'tracking windows: bic ip, ip, #4'),
    0x5364DCB4: (0x536726B4, 'tracking windows: cmp ip, #1'),
    0x5364DCD8: (0x536726D8, 'tracking windows: bic ip, ip, #4'),
    0x5364DCDC: (0x536726DC, 'tracking windows: cmp ip, #1'),
    # --- soft focus on the ADJ lever (softfocus.ts)
    0x5337FF98: (0x5338F584, 'ADJ function name, case 0x0A: mov r0, #140'),
    0x5337FF9C: (0x5338F588, 'ADJ function name, case 0x0A: bx lr'),
    0x53381934: (0x53390F84, 'ADJ function icon, the case of 0x0A and 0x0B: cmp r2, #0'),
    0x55084DD8: (0x550832A8, 'the live UserData object, as three references to it say'),
    # --- date imprint menu (datestamp-menu.ts)
    0x53DA6718: (0x53DD0F00, 'submenu records (18, as in 1.11), from its five MOVW/MOVT references'),
    0x53DA2D20: (0x53DCD470, 'list records (126 in 1.20), from its sixteen MOVW/MOVT references'),
    0x531DB2C4: (0x531DCCC8, 'list constructor: first record number, mov lr, #126'),
    # --- power-off pictures (shutdown.ts, tools/shutdown/shutdown.c)
    0x53187784: (0x5318876C, 'controller factory, End Screen case (the cases are in another order): ldr r0, [r4, #0x180]'),
    0x53187790: (0x53188778, 'controller factory, End Screen case: mov r0, #0x16c'),
    0x53187794: (0x5318877C, 'controller factory, End Screen case: bl to the allocator'),
    0x5318779C: (0x53188784, 'controller factory, End Screen case: bl to the End Screen list constructor'),
    0x531B948C: (0x531BAA54, 'power-off picture request, its second instruction (1.20 calls 0x53264390 from it)'),
    0x53262558: (0x53264274, 'show a picture of the full-screen JPEG table, found through its three callers'),
    0x5326255C: (0x53264278, 'the same, movw r3 of the table'),
    0x5326256C: (0x53264288, 'the same, movt r3 of the table'),
    0x53380874: (0x5338FE60, 'End Screen type -> text, found through its two callers'),
    0x55013E70: (0x55014D98, 'table of full-screen JPEGs (13 entries: 1.20 adds GB_30th.jpg), as its reader loads it'),
}


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'//[^\n]*', '', text)


def addresses():
    rx = re.compile(r'0x5[345][0-9a-fA-F]{6}(?![0-9a-fA-F])')
    found = {}
    for rel in SOURCES:
        path = REPO / rel
        if not path.exists():
            continue
        text = '\n'.join(line for line in path.read_text(encoding='utf-8').split('\n') if 'port120: skip' not in line)
        for va in (int(x, 16) for x in rx.findall(strip_comments(text))):
            if OWN[0] <= va < OWN[1]:
                continue
            found.setdefault(va, set()).add(rel.split('/')[-1])
    return found


def main():
    m = amap.Map()
    A = np.frombuffer(m.A[:len(m.A) // 4 * 4], dtype='<u4')
    B = np.frombuffer(m.B[:len(m.B) // 4 * 4], dtype='<u4')
    import json
    mp = json.loads((fwimage.CACHE / 'map.json').read_text())
    ha, la, wa = addrmap.canon(A, addrmap.Translator(mp['blocks'], len(m.A), mp['bss']))
    hb, lb, _ = addrmap.canon(B)

    def status(va, q):
        ia, ib = m._img('A', va), m._img('B', q)
        if not (fwimage.BASE <= ia < fwimage.BASE + len(m.A) and fwimage.BASE <= ib < fwimage.BASE + len(m.B)):
            return 'bss'
        i, j = (ia - fwimage.BASE) // 4, (ib - fwimage.BASE) // 4
        if A[i] == B[j]:
            return 'same'
        if ha[i] == hb[j] and (wa[i] or la[i] == lb[j]):
            return 'reloc'
        return 'different'

    entries, problems = [], []
    for va, files in sorted(addresses().items()):
        q = m.map(va)
        if va in MANUAL:
            v, why = MANUAL[va]
            if q is not None and q != v:
                problems.append('0x%08x: hand entry 0x%08x but the map says 0x%08x' % (va, v, q))
            entries.append((va, v, why))
            continue
        if q is None:
            problems.append('0x%08x (%s): not mapped and no hand entry' % (va, ', '.join(sorted(files))))
            continue
        st = status(va, q)
        if st not in ('same', 'reloc', 'bss'):
            problems.append('0x%08x (%s): mapped to 0x%08x but the words differ' % (va, ', '.join(sorted(files)), q))
            continue
        entries.append((va, q, None))
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        sys.exit(1)
    lines = [
        '// SPDX-License-Identifier: GPL-2.0-only',
        '// GENERATED by tools/port120/gen_table.py from the official 1.11 and 1.20 files -- do not edit.',
        '//',
        '// The 1.20 address of every 1.11 address the patcher uses (see target.ts). Entries without a',
        '// note were placed by matching the two files and have the same word there (or the same up to',
        '// relocation); the others were found by hand, as noted.',
        '',
        'export const VA_120: ReadonlyMap<number, number> = new Map([',
    ]
    for va, v, why in entries:
        note = f' // {why}' if why else ''
        lines.append(f'  [0x{va:08x}, 0x{v:08x}],{note}')
    lines.append(']);')
    OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{OUT.relative_to(REPO)}: {len(entries)} addresses ({sum(1 for e in entries if e[2])} by hand)')


if __name__ == '__main__':
    main()
