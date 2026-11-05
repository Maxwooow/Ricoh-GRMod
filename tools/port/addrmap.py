# SPDX-License-Identifier: GPL-2.0-only
"""Map the firmware addresses written in GR Mod's sources from one official RTOS image to another.

    python3 tools/port/addrmap.py OLD-rtos.bin NEW-rtos.bin --ram OLD_SRC:NEW_SRC:BASE:OLD_LEN:NEW_LEN \
        --out map.json FILE...

Development tool, not part of the program. Evidence for each address, all of which must agree:

  aligned   the old code around it (16 words, branch / literal / movw-movt immediates masked) is found
            at one place of the new image, at the same shift for the whole window;
  refs      the old image's references to it (BL / B targets, literal-pool words, movw+movt pairs),
            taken at their aligned places in the new image, name one new address.

An address is `ok` only when it is aligned and every reference agrees, or (not aligned: data, RAM)
when at least two references agree and none disagree. Everything else is `manual` and must be
resolved by hand (`--overrides`, a JSON object old -> new with a reason). The map covers only the
addresses written in FILE...; nothing is guessed from a constant shift.
"""
import argparse, collections, json, re, struct, sys
import numpy as np

BASE = 0x53000000
ap = argparse.ArgumentParser()
ap.add_argument('old'); ap.add_argument('new')
ap.add_argument('--ram', required=True, help='OLD_SRC:NEW_SRC:RAM_BASE:OLD_LEN:NEW_LEN (initialised RAM image)')
ap.add_argument('--overrides', help='JSON {"0xold": {"new": "0x..", "reason": ".."}}')
ap.add_argument('--out', required=True)
ap.add_argument('--loose', action='store_true', help='second alignment with data-processing / load-store immediates masked: candidates for code whose constants changed (status manual, how "loose")')
ap.add_argument('--runs', help='also write the whole word alignment (runs) and the unanimous references, for compare_builds.mts')
ap.add_argument('files', nargs='+')
a = ap.parse_args()
old = open(a.old, 'rb').read(); new = open(a.new, 'rb').read()
osrc, nsrc, rbase, olen, nlen = (int(x, 0) for x in a.ram.split(':'))

ow = np.frombuffer(old[:len(old) // 4 * 4], '<u4').astype(np.int64)
nw = np.frombuffer(new[:len(new) // 4 * 4], '<u4').astype(np.int64)

def norm(w):
    w = w.copy()
    br = (w & 0x0e000000) == 0x0a000000
    w[br] &= 0xff000000
    lit = (w >= 0x53000000) & (w < 0x56000000)
    w[lit] = 0x53000000
    mov = ((w & 0x0ff00000) == 0x03000000) | ((w & 0x0ff00000) == 0x03400000)
    w[mov] &= 0xfff0f000
    return w

on, nn = norm(ow), norm(nw)
N = 8
def hashes(w):
    h = np.zeros(len(w) - N + 1, dtype=np.uint64)
    with np.errstate(over='ignore'):
        for k in range(N):
            h = h * np.uint64(0x100000001B3) + (w[k:len(w) - N + 1 + k].astype(np.uint64) + np.uint64(1)) * np.uint64((0x9E3779B97F4A7C15 * (2 * k + 1)) & 0xFFFFFFFFFFFFFFFF)
    return h
def uniq(h):
    s, idx, cnt = np.unique(h, return_index=True, return_counts=True)
    return s[cnt == 1], idx[cnt == 1]
ous, oui = uniq(hashes(on)); nus, nui = uniq(hashes(nn))
_, oi_, ni_ = np.intersect1d(ous, nus, return_indices=True)
pairs = sorted(zip(oui[oi_].tolist(), nui[ni_].tolist()))
onl, nnl = on.tolist(), nn.tolist()
m = [-1] * len(onl)
for i, j in pairs:
    if len(set(onl[i:i + N])) <= 2: continue
    for k in range(N):
        if m[i + k] < 0: m[i + k] = j + k
    k = 1
    while i - k >= 0 and j - k >= 0 and m[i - k] < 0 and onl[i - k] == nnl[j - k]:
        m[i - k] = j - k; k += 1
    k = N
    while i + k < len(onl) and j + k < len(nnl) and m[i + k] < 0 and onl[i + k] == nnl[j + k]:
        m[i + k] = j + k; k += 1
coverage = sum(1 for x in m if x >= 0) / len(m)

# References: BL/B targets, literal words, movw/movt pairs (same register within 6 instructions).
refs = collections.defaultdict(collections.Counter)
def branch_target(w, at): off = w & 0xffffff; off -= 0x1000000 if off & 0x800000 else 0; return BASE + at * 4 + 8 + off * 4
def movpair(words, i):
    w = int(words[i])
    if (w & 0x0ff00000) != 0x03000000 or (w >> 28) == 0xf: return None
    rd = (w >> 12) & 15; lo = ((w >> 4) & 0xf000) | (w & 0xfff)
    for k in range(1, 7):
        if i + k >= len(words): break
        v = int(words[i + k])
        if (v & 0x0ff00000) == 0x03400000 and ((v >> 12) & 15) == rd:
            return (((v >> 4) & 0xf000) | (v & 0xfff)) << 16 | lo, i + k
    return None
for i in range(len(ow)):
    j = m[i]
    if j < 0: continue
    w, v = int(ow[i]), int(nw[j])
    if (w & 0x0e000000) == 0x0a000000 and (w >> 28) != 0xf:
        if (v & 0x0e000000) == 0x0a000000: refs[branch_target(w, i)][branch_target(v, j)] += 1
        continue
    if 0x53000000 <= w < 0x56000000 and 0x53000000 <= v < 0x56000000:
        refs[w][v] += 1; continue
    p = movpair(ow, i)
    if p:
        q = movpair(nw, j)
        if q and m[p[1]] >= 0 and (m[p[1]] - j) == (p[1] - i) and 0x53000000 <= p[0] < 0x56000000:
            refs[p[0]][q[0]] += 1

def window_ok(i, j):
    # A window of (normalised) pointers or zeros says nothing about where it is: at least 4 distinct words.
    return (all(0 <= i + k < len(m) and m[i + k] == j + k and onl[i + k] == nnl[j + k] for k in range(-4, 12))
            and len(set(onl[max(i - 4, 0):i + 12])) >= 4)

# Loose alignment (only to suggest): immediates of data-processing and load/store instructions masked too.
ml = None
if a.loose:
    def loose(w):
        w = norm(w)
        dp = ((w & 0x0e000000) == 0x02000000) & ((w >> 28) != 0xf)          # data processing, immediate
        w[dp] &= 0xfffff000
        ls = ((w & 0x0e000000) == 0x04000000) & ((w >> 28) != 0xf)          # load/store, immediate offset
        w[ls] &= 0xfffff000
        return w
    lo_, ln_ = loose(ow), loose(nw)
    lus, lui = uniq(hashes(lo_)); nus2, nui2 = uniq(hashes(ln_))
    _, a_, b_ = np.intersect1d(lus, nus2, return_indices=True)
    lol, lnl = lo_.tolist(), ln_.tolist(); ml = list(m)
    for i, j in sorted(zip(lui[a_].tolist(), nui2[b_].tolist())):
        if len(set(lol[i:i + N])) <= 2: continue
        for k in range(N):
            if ml[i + k] < 0: ml[i + k] = j + k
        k = 1
        while i - k >= 0 and j - k >= 0 and ml[i - k] < 0 and lol[i - k] == lnl[j - k]: ml[i - k] = j - k; k += 1
        k = N
        while i + k < len(lol) and j + k < len(lnl) and ml[i + k] < 0 and lol[i + k] == lnl[j + k]: ml[i + k] = j + k; k += 1
overrides = json.load(open(a.overrides)) if a.overrides else {}
def map_one(addr):
    key = f'{addr:#x}'
    if key in overrides:
        o = overrides[key]; return dict(new=o['new'], how='override', ok=True, why=o['reason'])
    r = refs.get(addr, collections.Counter())
    rtxt = ', '.join(f'{t:#x}x{c}' for t, c in r.most_common(4))
    if BASE <= addr < BASE + len(old):
        i, rem = divmod(addr - BASE, 4)
        if m[i] >= 0:
            t = BASE + m[i] * 4 + rem
            agree = all(x == t for x in r)
            return dict(new=f'{t:#x}', how='aligned' + (f' + refs {rtxt}' if r else ''), ok=bool(window_ok(i, m[i]) and agree))
        if len(r) == 1 and sum(r.values()) >= 2:
            (t, c), = r.items(); return dict(new=f'{t:#x}', how=f'refs {rtxt}', ok=True)
        if ml is not None and ml[i] >= 0:
            t = BASE + ml[i] * 4 + rem
            return dict(new=f'{t:#x}', how=f'loose (immediates differ: check by hand); refs {rtxt}', ok=False, loose=True)
        return dict(new=None, how=f'not aligned; refs {rtxt}', ok=False)
    if rbase <= addr < 0x56000000:
        if len(r) == 1 and sum(r.values()) >= 2:
            (t, c), = r.items(); return dict(new=f'{t:#x}', how=f'refs {rtxt}', ok=True)
        if rbase <= addr < rbase + olen:
            i, rem = divmod(osrc - BASE + addr - rbase, 4)
            if m[i] >= 0:
                t = rbase + (BASE + m[i] * 4 - nsrc) + rem
                # Data words align poorly (pointer tables normalise to runs of one value): an
                # aligned RAM address needs at least one reference agreeing with it as well.
                ok = window_ok(i, m[i]) and bool(r) and all(x == t for x in r)
                return dict(new=f'{t:#x}', how='RAM image aligned' + (f' + refs {rtxt}' if r else ''), ok=bool(ok))
        return dict(new=None, how=f'RAM; refs {rtxt}' if r else 'RAM, unreferenced', ok=False)
    return dict(new=None, how='outside the image', ok=False)

found = collections.defaultdict(set)
for f in a.files:
    for x in re.findall(r'\b0x5[345][0-9a-fA-F]{6}(?![0-9a-fA-F])', open(f, encoding='utf-8', errors='replace').read()):
        found[int(x, 16)].add(f)
result = {}
for addr in sorted(found):
    e = map_one(addr); e['files'] = sorted(found[addr]); result[f'{addr:#x}'] = e
json.dump(dict(coverage=coverage, old=a.old, new=a.new, addresses=result), open(a.out, 'w'), indent=1)
if a.runs:
    runs = []; i = 0
    while i < len(m):
        if m[i] < 0: i += 1; continue
        j = i
        while j + 1 < len(m) and m[j + 1] == m[j] + 1: j += 1
        runs.append([BASE + 4 * i, BASE + 4 * m[i], 4 * (j - i + 1)]); i = j + 1
    unanimous = {f'{t:#x}': f'{next(iter(c)):#x}' for t, c in refs.items() if len(c) == 1 and sum(c.values()) >= 2}
    json.dump(dict(runs=runs, refs=unanimous, overrides={k: v['new'] for k, v in overrides.items()},
                   ram=dict(oldSource=osrc, newSource=nsrc, base=rbase, oldLength=olen, newLength=nlen),
                   oldLength=len(old), newLength=len(new)), open(a.runs, 'w'))
bad = [k for k, e in result.items() if not e['ok']]
print(f'aligned {coverage * 100:.2f}% of the old image; {len(result)} addresses, {len(result) - len(bad)} ok, {len(bad)} manual')
