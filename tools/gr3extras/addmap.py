# SPDX-License-Identifier: GPL-2.0-only
"""Add the adr(...) addresses of GR III / IIIx source files to the port maps (development tool).

    GRMOD_RTOS_DIR=DIR python3 tools/gr3extras/addmap.py core/src/fw/gr3x/FILE.ts ...
    python3 tools/port/addresses.py

DIR holds the decoded RTOS sections gr3_v210.rtos, gr3_v220.rtos and gr3_v221.rtos (GR IIIx's are the
same programs). Every address written as adr(0x........) in the files is mapped 2.10 -> 2.20 with
tools/port/addrmap.py and its overrides, the results 2.20 -> 2.21, and both steps are merged into
tools/port/gr3-p2-map.json and gr3-p3-map.json (existing entries must agree). An address that is not
`ok` is reported and left out: resolve it by hand into the overrides (tools/port/README.md), then
run this again. With --dry nothing is written.
"""
import json, os, re, subprocess, sys, tempfile
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
D = Path(os.environ.get('GRMOD_RTOS_DIR', '.'))
dry = '--dry' in sys.argv[1:]
files = [a for a in sys.argv[1:] if not a.startswith('--')]
want = set()
for f in files:
    for m in re.finditer(r'adr\(\s*(0x[0-9a-fA-F]{8})', (REPO / f).read_text()): want.add(int(m.group(1), 16))
tmp = Path(tempfile.mkdtemp(prefix='addmap-'))
def run(old, new, ram, overrides, out, sources):
    r = subprocess.run([sys.executable, str(REPO / 'tools/port/addrmap.py'), str(D / old), str(D / new), '--ram', ram, '--overrides', str(REPO / overrides), '--out', str(out)] + sources,
                       capture_output=True, text=True, cwd=REPO)
    if r.returncode: sys.exit(r.stdout + r.stderr)
    return json.loads(out.read_text())['addresses']
p2 = run('gr3_v210.rtos', 'gr3_v220.rtos', '0x5407b540:0x5407b640:0x55000000:0x3a080:0x3a0c0', 'tools/port/gr3-p2-overrides.json', tmp / 'p2.json', files)
p2 = {k: v for k, v in p2.items() if int(k, 16) in want}
bad2 = sorted(k for k, v in p2.items() if not v.get('ok')); missing = sorted('0x%08x' % a for a in want if '0x%08x' % a not in p2)
src = tmp / 'p3-src.ts'; src.write_text('\n'.join('adr(%s)' % v['new'] for v in p2.values() if v.get('ok')))
p3 = run('gr3_v220.rtos', 'gr3_v221.rtos', '0x5407b640:0x54084640:0x55000000:0x3a0c0:0x3a300', 'tools/port/gr3-p3-overrides.json', tmp / 'p3.json', [str(src)])
wanted3 = {v['new'] for v in p2.values() if v.get('ok')}
p3 = {k: v for k, v in p3.items() if k in wanted3}
bad3 = sorted(k for k, v in p3.items() if not v.get('ok'))
print('2.10 -> 2.20: %d addresses; not ok: %s; not found: %s' % (len(p2), bad2, missing))
print('2.20 -> 2.21: %d addresses; not ok (2.20 addresses): %s' % (len(p3), bad3))
def merge(path, new, names):
    raw = (REPO / path).read_text(); m = json.loads(raw); added = 0
    for k, v in new.items():
        if not v.get('ok'): continue
        v = dict(v); v['files'] = sorted(names)
        e = m['addresses'].get(k)
        if e is None: m['addresses'][k] = v; added += 1
        elif e.get('new') != v['new']: sys.exit('conflict in %s: %s is %s there, %s now' % (path, k, e.get('new'), v['new']))
        elif 'files' in e: e['files'] = sorted(set(e['files']) | set(names))
    m['addresses'] = dict(sorted(m['addresses'].items(), key=lambda kv: int(kv[0], 16)))
    if not dry: (REPO / path).write_text(json.dumps(m, indent=1 if raw.startswith('{\n ') else 0) + ('\n' if raw.endswith('\n') else ''))
    print(path, 'added', added, '(dry run)' if dry else '')
merge('tools/port/gr3-p2-map.json', p2, files)
merge('tools/port/gr3-p3-map.json', p3, [f.replace('fw/gr3x/', 'fw/gr3x170/') for f in files])
if bad2 or bad3 or missing: sys.exit(1)
