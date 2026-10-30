"""Propose corresponding A32 sites for manual review, without writing firmware.

Normalized instruction windows are evidence for finding a function, not permission
to patch it. Different register assignments, joins, and struct offsets still need
inspection and execution tests on the target firmware.
"""
import argparse
from array import array
import json
import re
import struct
from pathlib import Path

BASE = 0x53000000

def normalize(w, loose=False):
    if loose == 2:
        if (w & 0x0e000000) == 0x0a000000:
            return w & 0xff000000
        if (w & 0x0fb00000) == 0x03000000:
            return w & 0xfff00000
        if (w & 0x0e000000) in (0x04000000, 0x06000000):
            return w & 0xfff00000
        if (w & 0x0e000000) == 0x02000000:
            return w & 0xfff00000
        if (w & 0x0e000000) == 0 and (w & 0x90) != 0x90:
            return w & 0xfff00ff0
        if (w & 0x0e000000) == 0x08000000:
            return w & 0xfff00000
        if (w & 0x0e000090) == 0x90:  # Multiply and extra load/store.
            return w & 0xfff00ff0
    if (w & 0x0e000000) == 0x0a000000:  # B/BL targets relocate.
        return w & 0xff000000
    if (w & 0x0fb00000) == 0x03000000:  # MOVW/MOVT literals relocate.
        return w & 0xfff0f000
    if loose:
        if (w & 0x0e000000) == 0x04000000:  # LDR/STR field offsets.
            return w & 0xfffff000
        if (w & 0x0e000000) == 0x02000000:  # DP immediate.
            return w & 0xfffff000
        if (w & 0x0f000e00) == 0x0d000a00:  # VFP literal/field offsets.
            return w & 0xffffff00
    return w

def match(reference, target, sites):
    results = {a: {} for a in sites}
    for loose in (False, True, 2):
        r = array('I', (normalize(w, loose) for w in array('I', reference)))
        t = array('I', (normalize(w, loose) for w in array('I', target)))
        text = t.tobytes()
        for a in sites:
            off = (a-BASE)//4
            candidates = set()
            for delta in (-8, -4, 0, 4, 8):
                signature = r[off+delta:off+delta+4].tobytes()
                at, count = 0, 0
                while count < 500:
                    at = text.find(signature, at)
                    if at < 0: break
                    if at % 4 == 0: candidates.add(at//4-delta)
                    at += 1
                    count += 1
            for candidate in candidates:
                if candidate < 12 or candidate+20 > len(t): continue
                score = sum(r[off+i] == t[candidate+i] for i in range(-12, 20))
                address = BASE+candidate*4
                previous = results[a].get(address, (0, False))
                if score > previous[0]: results[a][address] = (score, loose)
    return {hex(a): [dict(address=hex(b), matches=score, window=32, loose=loose)
        for b,(score,loose) in sorted(c.items(), key=lambda v: -v[1][0])[:4]]
        for a,c in results.items()}

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--reference', type=Path, required=True)
    p.add_argument('--target', type=Path, required=True)
    p.add_argument('--source', type=Path)
    p.add_argument('--sites', nargs='*', type=lambda s:int(s,0), default=[])
    p.add_argument('--output', type=Path, required=True)
    a=p.parse_args()
    sites=set(a.sites)
    if a.source:
        sites.update(int(v,16) for v in re.findall(r'0x53[0-9a-fA-F]{6}',a.source.read_text()))
    result=match(a.reference.read_bytes(),a.target.read_bytes(),sorted(sites))
    a.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'sites':len(sites),'strong_candidates':sum(v[0]['matches']>=28 for v in result.values() if v)}))
