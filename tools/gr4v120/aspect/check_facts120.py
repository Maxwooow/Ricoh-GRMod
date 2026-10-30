# SPDX-License-Identifier: GPL-2.0-only
"""Check that the measurements in core/src/fw/gr4v120/aspect/facts.ts (taken on firmware 1.11 by
tools/aspect/gen_facts.py) are also those of firmware 1.20 (development tool, not part of the program).

    GR_CUSTOM_TOOL_120=<gr-custom-tool checkout at 258d745> python3 check_facts120.py OFFICIAL-1.20-RTOS.bin

Runs 1.20's own functions in Unicorn through the reference's 1.20 readers (gr4_editor
product120_crops.CropNative120, crop120_raw._MapProducer, crop120_identity._source_bases120): output
sizes of 3:2 for both models, the Kb636 crop magnifications, the factory ratios' screen / thumbnail
rectangles and sizes, the photo-info rectangles, the AE/WB grid templates and the quick-view fit
(firmware 1.20's fit function 0x536BAB9C, 1.11's 0x5369642C). Prints one line per fact.
The Kb588 crop magnifications are 1.25 / 1.7857 in 1.20 (1.11: those of Kb636); GR Mod does not
use them (MAG_BITS are Kb636's and the photo-info table's, both unchanged).
"""
import json, os, re, struct, sys
from fractions import Fraction
from pathlib import Path
sys.path.insert(0, os.environ.get('GR_CUSTOM_TOOL_120', '/home/claude/ref/gct-258d745'))
os.environ.setdefault('GR4_EDITOR_DATA_DIR', str(Path(__file__).resolve().parent / '.refdata'))
from gr4_editor.product120_crops import CropNative120  # noqa: E402
from gr4_editor.crop120_raw import _MapProducer  # noqa: E402
from gr4_editor.crop120_identity import _source_bases120  # noqa: E402
from gr4_editor.crops import _aligned_crop  # noqa: E402
from gr4_editor.crop_native import OUTPUT, INPUT, CONFIG  # noqa: E402

FIT = 0x536BAB9C
rtos = open(sys.argv[1], 'rb').read()
facts = (Path(__file__).resolve().parents[3] / 'core/src/fw/gr4v120/aspect/facts.ts').read_text()
grab = lambda pattern: json.loads(re.search(pattern, facts).group(1))
base = grab(r'BASE_DIMS[^=]*= (\[.*?\]) as const;'); mag = grab(r'MAG_BITS[^=]*= (\[.*?\]);')
fac = grab(r'export const FACTORY[^=]*= (\[.*?\]);\n'); rect = grab(r'RECT_BASES[^=]*= (\[.*?\]);')
templ = grab(r'MAP_TEMPLATES[^=]*= (\[.*?\]);'); quick = re.search(r'QUICK_VIEW_FULL = "([01]*)"', facts).group(1)
n = CropNative120(rtos)
bits = lambda x: struct.unpack('<I', struct.pack('<f', x))[0]
bad = []
def report(name, ok): print(f'{name}: {"same as 1.11" if ok else "DIFFERENT"}'); ok or bad.append(name)

report('MAG_BITS (Kb636)', [bits(x) for x in n.magnifications('Kb636')] == mag)
ok = True
for model in ('Kb588', 'Kb636'):
    for sel in range(4):
        for k, x in enumerate(n.magnifications(model)):
            d = n.dimensions(model, 0, x, sel); w = next(r for r in base if r[0] == model and r[1] == sel and r[2] == k)
            ok &= (d['width'], d['height']) == (w[3], w[4]) and not d['diagnostics']
report('BASE_DIMS', ok)
ok = True
for f in fac:
    for kind, key in (('screen', 'screen'), ('thumbnail', 'thumb')):
        s = n.small('Kb636', f['id'], kind); ok &= [s['left'], s['top'], s['width'], s['height']] == f[key]
    sizes = {(d['width'], d['height']) for model in ('Kb588', 'Kb636') for sel in range(4) for x in n.magnifications(model) for d in [n.dimensions(model, f['id'], x, sel)]}
    ok &= sorted(sizes) == sorted(tuple(s) for s in f['sizes'])
    full = n.dimensions('Kb636', f['id'], 1.0, 0); ok &= [full['width'], full['height']] == f['full']
report('FACTORY rectangles and sizes', ok)
b = _source_bases120(rtos)
report('RECT_BASES and their magnifications', [list(r) for _, r in b] == rect and [bits(m) for m, _ in b] == mag)
producer = _MapProducer(rtos); t = []
for pointer in producer.produce():
    sro = struct.unpack('<I', producer.uc.mem_read(pointer + 0xF0, 4))[0]
    for process in range(4):
        for m in range(3):
            original = struct.unpack('<I', producer.uc.mem_read(pointer + 4 + (process * 12 + m) * 4, 4))[0]
            src = struct.unpack('<23H', producer.uc.mem_read(original, 46))
            strips = {bytes(producer.uc.mem_read(struct.unpack('<I', producer.uc.mem_read(sro + (process * 12 + a * 3 + m) * 4, 4))[0], 44)) for a in range(4)}
            assert len(strips) == 1, 'SRO records differ between factory ratios'
            t.append([src[3], src[4], src[5], src[6]])
report('MAP_TEMPLATES', t == templ)
def fit(source, target):
    n.uc.mem_write(OUTPUT, bytes(16)); n.uc.mem_write(INPUT, struct.pack('<2I', *source)); n.uc.mem_write(CONFIG, struct.pack('<2I', *target))
    n.call(FIT, OUTPUT, INPUT, CONFIG)
    return list(struct.unpack('<4I', n.uc.mem_read(OUTPUT, 16)))
dims = sorted({(w, h) for _, _, _, w, h in base}); q = []
for width, height in [(720, h) for h in range(4, 481, 4)] + [(w, 480) for w in range(4, 720, 4)]:
    ok = True
    for bw, bh in dims:
        try: region = _aligned_crop(bw, bh, Fraction(width, height))
        except ValueError: ok = False; break
        if fit((region['width'], region['height']), (width, height)) != [0, 0, width, height]: ok = False; break
    q.append('1' if ok else '0')
report('QUICK_VIEW_FULL', ''.join(q) == quick)
sys.exit(1 if bad else 0)
