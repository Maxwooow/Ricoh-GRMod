# SPDX-License-Identifier: GPL-2.0-only
"""Check a data address of the map word by word (development tool).

    python3 tools/port/datacheck.py OLD-rtos NEW-rtos RUNS.json OLD:NEW [OLD:NEW ...] [--words N]

For a pair (old address, proposed new address) the N words from there in both images are compared
up to relocation: equal, or both addresses with the old one mapped (through the alignment runs and
unanimous references of RUNS.json, addrmap.py --runs) to the new one. Prints, per pair, how many
words agree, how many of them are relocated pointers, and the first word that does not agree. A
data table whose length changed (more styles, more icons) agrees up to its old end only; that is
for the reader to judge.
"""
import bisect, json, struct, sys

BASE = 0x53000000
args = [a for a in sys.argv[1:] if not a.startswith('--')]
n = int(sys.argv[sys.argv.index('--words') + 1]) if '--words' in sys.argv else 16
if '--words' in sys.argv: args.remove(str(n))
old, new = open(args[0], 'rb').read(), open(args[1], 'rb').read()
R = json.load(open(args[2]))
runs = R['runs']; starts = [r[0] for r in runs]
refs = {int(k, 16): int(v, 16) for k, v in R['refs'].items()}
over = {int(k, 16): int(v, 16) for k, v in R.get('overrides', {}).items()}
ram = R['ram']

def T(a):
    if a in over: return over[a]
    i = bisect.bisect_right(starts, a) - 1
    if i >= 0 and a < runs[i][0] + runs[i][2]: return runs[i][1] + a - runs[i][0]
    if a in refs: return refs[a]
    if ram['base'] <= a < ram['base'] + ram['oldLength']:
        t = T(ram['oldSource'] + a - ram['base'])
        if t is not None: return ram['base'] + t - ram['newSource']
    return None

def word(img, a, src, length):
    if ram['base'] <= a < ram['base'] + length: a = src + a - ram['base']
    o = a - BASE
    return struct.unpack_from('<I', img, o)[0] if 0 <= o <= len(img) - 4 else None

for pair in args[3:]:
    a, b = (int(x, 16) for x in pair.split(':'))
    agree = ptrs = 0; first = None
    for k in range(n):
        w = word(old, a + 4 * k, ram['oldSource'], ram['oldLength']); v = word(new, b + 4 * k, ram['newSource'], ram['newLength'])
        if w is None or v is None: first = first or (k, 'outside'); continue
        isp = lambda x: 0x53000000 <= x < 0x56000000
        if w == v and not isp(w): agree += 1
        elif isp(w) and isp(v) and T(w) == v: agree += 1; ptrs += 1
        elif w == v: agree += 1     # same address (unmoved or unknown): counts, not as a relocated pointer
        elif first is None: first = (k, f'{w:#010x} vs {v:#010x} (old maps to {T(w):#x})' if isp(w) and T(w) else f'{w:#010x} vs {v:#010x}')
    print(f'{a:#x} -> {b:#x}: {agree}/{n} words agree, {ptrs} relocated pointers' + (f'; first difference at word {first[0]}: {first[1]}' if first else ''))
