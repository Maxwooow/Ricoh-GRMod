# SPDX-License-Identifier: GPL-2.0-only
"""Independent read-back of the added ratios of a GR Mod build for firmware 1.20 (development tool).

    GR_CUSTOM_TOOL_120=<gr-custom-tool at 258d745> python3 verify120.py PATCHED-RTOS OFFICIAL-RTOS ID:RATIO [ID:RATIO ...]

The reference's own 1.20 code (gr4_editor product120_crops) runs the patched firmware's functions in
Unicorn and its 1.20 planner (preview_geometry120 on the official firmware) says what they should
give for each ratio: live-view rectangle, every photo size of both models (4 quality selectors x 3
crop steps), and that no call ends in the firmware's assertion. The factory ratios must read back
exactly as on the official firmware. Exits 1 on any difference.
"""
import os, sys
from pathlib import Path
sys.path.insert(0, os.environ.get('GR_CUSTOM_TOOL_120', '/home/claude/ref/gct-258d745'))
os.environ.setdefault('GR4_EDITOR_DATA_DIR', str(Path(__file__).resolve().parent / '.refdata'))
from gr4_editor.product120_crops import CropNative120, preview_geometry120  # noqa: E402

patched, official = open(sys.argv[1], 'rb').read(), open(sys.argv[2], 'rb').read()
pn, on = CropNative120(patched), CropNative120(official)
bad = 0
def check(what, ok):
    global bad
    if not ok: bad += 1; print('DIFFERENT:', what)
for public in range(4):
    for model in ('Kb588', 'Kb636'):
        for sel in range(4):
            for mag in on.magnifications(model):
                a, b = on.dimensions(model, public, mag, sel), pn.dimensions(model, public, mag, sel)
                check(f'factory {public} {model} {sel} {mag:.4f}', (a['width'], a['height'], a['diagnostics']) == (b['width'], b['height'], b['diagnostics']))
    for kind in ('screen', 'thumbnail'):
        check(f'factory {public} {kind}', on.small('Kb636', public, kind) == pn.small('Kb636', public, kind))
cases = 0
for item in sys.argv[3:]:
    public, ratio = item.split(':', 1); public = int(public)
    want = preview_geometry120(official, ratio)['geometry']
    check(f'{ratio} live-view rectangle {pn.preview(public)} vs {want["preview"]}', pn.preview(public) == want['preview'])
    for w in want['photo_sizes']:
        got = pn.dimensions(w['model'], public, w['magnification'], w['selector'])
        check(f'{ratio} {w["model"]} selector {w["selector"]} x{w["magnification"]:.4f}: {got["width"]}x{got["height"]} vs {w["width"]}x{w["height"]}', (got['width'], got['height']) == (w['width'], w['height']) and not got['diagnostics'])
        cases += 1
print(f'{len(sys.argv) - 3} added ratios, {cases} photo sizes, factory ratios unchanged: ' + ('all as the reference plans' if not bad else f'{bad} differences'))
sys.exit(1 if bad else 0)
