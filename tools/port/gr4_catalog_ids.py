# SPDX-License-Identifier: GPL-2.0-only
"""Native text and icon numbers of GR IV 1.11 and their numbers in 1.20 (development tool).

    python3 tools/port/gr4_catalog_ids.py RTOS-1.11 ICONBIN-1.11 RTOS-1.20 ICONBIN-1.20 [text N ...] [icon N ...] [--json OUT]

1.20 renumbered both catalogs (881 texts, 709 icons; 1.11: 837, 663). A 1.11 text is matched to the
1.20 text with the same string in all 21 languages, an icon to the one with the same kind, size and
pixels; duplicates are told apart by the shift of their neighbours. Prints each asked number with
its English (language 2) string, or its size, in both firmwares; with no numbers, a summary.
"""
import collections, hashlib, json, struct, sys

B = 0x53000000
V = {'1.11': dict(src=0x5437b640, ln=0x57480, texts=837, icons=0x55013410, nicons=663),
     '1.20': dict(src=0x543b3100, ln=0x58500, texts=881, icons=0x55014280, nicons=709)}
args = sys.argv[1:]
for v, (r, ib) in zip(V, ((args[0], args[1]), (args[2], args[3]))): V[v]['d'] = open(r, 'rb').read(); V[v]['ib'] = open(ib, 'rb').read()
rest = args[4:]

def rd(v, a, n):
    p = V[v]
    if 0x55000000 <= a < 0x55000000 + p['ln']: a = p['src'] + a - 0x55000000
    return p['d'][a - B:a - B + n]
def u32(v, a): return struct.unpack('<I', rd(v, a, 4))[0]
def s16(v, a):
    out = []
    while len(out) < 400:
        b = rd(v, a, 2)
        if len(b) < 2: return None
        c = struct.unpack('<H', b)[0]
        if c == 0: break
        out.append(chr(c)); a += 2
    return ''.join(out)
def text(v, l, i):
    root = u32(v, 0x55002118 + 4 * l); rec = u32(v, root + 4 * i)
    return s16(v, u32(v, rec + 4)) if rec else None
def icon(v, i):
    d = u32(v, V[v]['icons'] + 4 * i)
    if not d: return None
    kind, w, h, fl = struct.unpack('<4H', rd(v, d, 8)); off = u32(v, d + 8) * 4
    return (kind, w, h, fl, hashlib.sha1(V[v]['ib'][off:off + w * h * 4]).hexdigest())

def match(sig_old, sig_new):
    idx = collections.defaultdict(list)
    for i, s in enumerate(sig_new): idx[s].append(i)
    mp, amb = {}, []
    for i, s in enumerate(sig_old):
        c = idx.get(s, [])
        if len(c) == 1: mp[i] = c[0]
        elif c: amb.append((i, c))
    for i, c in amb:
        lo = max((k for k in mp if k < i), default=None); hi = min((k for k in mp if k > i), default=None)
        ds = {mp[k] - k for k in (lo, hi) if k is not None}
        pick = [x for x in c if x - i in ds and x not in mp.values()]
        if len(pick) == 1: mp[i] = pick[0]
    return mp

tsig = {v: [tuple(text(v, l, i) for l in range(21)) for i in range(V[v]['texts'])] for v in V}
isig = {v: [icon(v, i) for i in range(V[v]['nicons'])] for v in V}
TM, IM = match(tsig['1.11'], tsig['1.20']), match(isig['1.11'], isig['1.20'])
EN = 1  # the English table is language root 1 (names.ts LANGS order differs from the roots)
out = {'text': {str(k): v for k, v in TM.items()}, 'icon': {str(k): v for k, v in IM.items()}}
if '--json' in rest:
    json.dump(out, open(rest[rest.index('--json') + 1], 'w'), indent=0); rest = rest[:rest.index('--json')]
kind = None
for a in rest:
    if a in ('text', 'icon'): kind = a; continue
    n = int(a, 0)
    if kind == 'text':
        m = TM.get(n)
        print(f'text {n} {tsig["1.11"][n][EN]!r} -> ' + (f'{m} {tsig["1.20"][m][EN]!r}' if m is not None else 'NOT FOUND'))
    else:
        m = IM.get(n)
        print(f'icon {n} {isig["1.11"][n][1:3] if isig["1.11"][n] else None} -> ' + (f'{m}' if m is not None else 'NOT FOUND'))
if not rest:
    print(f'texts: {len(TM)} of {len(tsig["1.11"])} matched; icons: {len(IM)} of {len(isig["1.11"])} matched')
