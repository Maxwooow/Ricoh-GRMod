# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of added aspect ratios on builds for 1.11 and 1.20 (development tool).

Builds the same ratios with GR Mod's own builder for both official files (tools/port120/build.ts,
through vite-node) and runs tools/aspect/boot_checks.py on each: every hook transparent where no
added ratio is involved, the text and icon directories, menu count, order, names, icons, Fn
cycling, the settings wrappers, RAW development targets, the photo-info, playback and metering-map
wrappers and the decode buffer size. The 1.11 build is the control: the same checks pass on it.

    python3 check_ratios.py [111|120 ...]
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'aspect'))
import fwimage  # noqa: E402

RATIOS = [{'name': 'XPan', 'ratio': '65:24'}, {'name': '5:4', 'ratio': '5:4'}, {'name': '2.39:1', 'ratio': '2.39:1'}, {'name': '6:7', 'ratio': '6:7'}]
OUT = fwimage.CACHE / 'builds'


def build(tag, name, options=None, ratios=(), pictures=0):
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f'{name}_{tag}.bin'
    cmd = ['npx', 'vite-node', str(HERE / 'build.ts'), str(fwimage.FILES[tag]), str(out), json.dumps(options or {}), json.dumps(list(ratios)), str(pictures)]
    r = subprocess.run(cmd, cwd=fwimage.REPO, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stdout + r.stderr)
    summary = json.loads(r.stdout.strip().splitlines()[-1])
    assert summary['checks'] and summary['inspect']['verified'], summary
    return out, summary


def main():
    import boot_checks
    tags = sys.argv[1:] or ['111', '120']
    for tag in tags:
        out, summary = build(tag, 'ratios', ratios=RATIOS)
        print(f'== {tag}: {out.name}, {summary["bytes"]} bytes, verified by the engine')
        official = fwimage.rtos(tag)
        patched = (out.parent / (out.name + '.rtos')).read_bytes()
        icons = (out.parent / (out.name + '.iconbin')).read_bytes()
        result = boot_checks.run(official, patched, icons, fwimage.iconbin(tag))
        print(f'   {result["hooks"]} hooks, {result["transparent"]} checked for transparency')


if __name__ == '__main__':
    main()
