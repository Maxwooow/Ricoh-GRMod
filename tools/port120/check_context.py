# SPDX-License-Identifier: GPL-2.0-only
"""Is the code around every place GR Mod changes the same in 1.11 and 1.20? (development tool)

For each word a 1.20 build changes in the official part of RTOS (taken from a build's RTOS and the
official one), the function around it in 1.11 and in 1.20 is compared instruction by instruction,
every address an instruction holds translated (as addrmap.py compares). A hook written for 1.11
uses the registers, stack slots and object fields of the code around it; where that code is the
same, so are they. Functions that differ are listed with the differing instructions, to be looked
at by hand (look.py diff).

    python3 check_context.py BUILD_1.20.rtos
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import addrmap  # noqa: E402
import amap  # noqa: E402
import fwimage  # noqa: E402

BASE = fwimage.BASE


def function_bounds(buf, va, limit=0x2000):
    start = va
    for k in range(0, limit, 4):
        if struct.unpack_from('<I', buf, va - k - BASE)[0] == 0xE1A0C00D:
            start = va - k
            break
    end = va + 4
    for k in range(4, limit, 4):
        if struct.unpack_from('<I', buf, va + k - BASE)[0] == 0xE1A0C00D:
            end = va + k
            break
    return start, end


def main():
    build = Path(sys.argv[1]).read_bytes()
    m = amap.Map()
    official = m.B
    changed = [BASE + o for o in range(0, len(official), 4) if build[o:o + 4] != official[o:o + 4]]
    # 1.20 -> 1.11 for each changed word
    A = np.frombuffer(m.A[:len(m.A) // 4 * 4], dtype='<u4')
    B = np.frombuffer(m.B[:len(m.B) // 4 * 4], dtype='<u4')
    mp = json.loads((fwimage.CACHE / 'map.json').read_text())
    ha, la, wa = addrmap.canon(A, addrmap.Translator(mp['blocks'], len(m.A), mp['bss']))
    hb, lb, _ = addrmap.canon(B)
    seen = set()
    report = []
    for vb in changed:
        va = m.back(vb)
        if va is None:
            report.append((vb, None, 'the changed word itself has no 1.11 counterpart in the map (hand-ported site)'))
            continue
        sa, ea = function_bounds(m.A, va)
        if (sa, ea) in seen:
            continue
        seen.add((sa, ea))
        sb = m.map(sa)
        if sb is None:
            report.append((vb, va, 'function start not mapped'))
            continue
        diffs = []
        for k in range(0, ea - sa, 4):
            i, j = (sa + k - BASE) // 4, (sb + k - BASE) // 4
            same = A[i] == B[j] or (ha[i] == hb[j] and (wa[i] or la[i] == lb[j]))
            if not same:
                diffs.append(sa + k)
        status = 'same' if not diffs else '%d of %d words differ: %s' % (len(diffs), (ea - sa) // 4, ' '.join('%08x' % d for d in diffs[:8]))
        report.append((vb, va, 'function %08x..%08x: %s' % (sa, ea, status)))
    bad = [r for r in report if 'differ' in r[2] or 'not mapped' in r[2] or 'no 1.11' in r[2]]
    for vb, va, what in report:
        print('%08x (1.11 %s) %s' % (vb, ('%08x' % va) if va else '   -    ', what))
    print('%d changed words, %d functions; %d to look at by hand' % (len(changed), len(seen), len(bad)), file=sys.stderr)


if __name__ == '__main__':
    main()
