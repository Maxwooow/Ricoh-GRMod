# SPDX-License-Identifier: GPL-2.0-only
"""Check that the committed ports are what the generator makes from the committed sources.

    python3 tools/port/check.py                 # every port
    python3 tools/port/check.py gr4-121 gr3-p3  # only these

A port (fw/gr4v120, fw/gr4v121, fw/gr3x170, fw/gr3x171 and their tools) is a generated copy: the
program it was made from, with the addresses moved through the map and the hand edits of the
`.patch` applied. A fix made in the original has to be generated into the copies, and an edit made
in a copy has to be recorded in its patch (`generate.py X.json --save-patch`). When either is
forgotten the copies drift from their sources without anyone noticing: this check fails then.

It generates each port into a temporary directory (nothing in the repository is written), applies
the patch and compares every text file with the committed one. The outputs of the post steps (the
compiled native modules, `generated` in the config) are not compared: they need the compilers.
"""
import json, re, subprocess, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate as gen

REPO = gen.REPO
# In the order they are made: a port can be the source of the next one.
PORTS = ['gr3-p2', 'gr3-p3', 'gr4-120', 'gr4-121']


def check(name):
    cfg = json.loads((REPO / 'tools/port' / f'{name}.json').read_text())
    patch = REPO / cfg['patch']
    skip = lambda rel: (any(part in cfg.get('exclude', []) for part in Path(rel).parts) or
                        any(rel.startswith(p + '/') for p in cfg.get('preserve', [])) or
                        any(re.search(g, rel) for g in cfg.get('generated', [])))
    problems = []
    with tempfile.TemporaryDirectory() as t:
        raw = Path(t)
        gen.generate(cfg, raw)
        if patch.exists() and patch.read_text().strip():
            r = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(patch)], cwd=raw, capture_output=True, text=True)
            if r.returncode:
                return [f'{cfg["patch"]} does not apply to the generated copy:\n{r.stderr.strip()}']

        def files_of(root, dst):
            p = root / dst
            if p.is_file(): return {dst}
            return {str(f.relative_to(root)) for f in p.rglob('*') if f.is_file()} if p.is_dir() else set()

        seen = set()
        for _, dst in cfg['copies'] + cfg.get('files', []):
            for rel in sorted(files_of(raw, dst) | files_of(REPO, dst)):
                if rel in seen or skip(rel) or Path(rel).suffix not in gen.TEXT: continue
                seen.add(rel)
                a, b = raw / rel, REPO / rel
                if not b.exists(): problems.append(f'{rel}: generated, but not in the repository')
                elif not a.exists(): problems.append(f'{rel}: in the repository, but not generated')
                elif a.read_text(encoding='utf-8') != b.read_text(encoding='utf-8'): problems.append(f'{rel}: differs from the generated copy')
    return problems


def main():
    names = sys.argv[1:] or PORTS
    failed = False
    for name in names:
        problems = check(name)
        if problems:
            failed = True
            print(f'{name}: {len(problems)} file(s) are not what the generator makes')
            for p in problems[:40]: print('  ' + p)
            if len(problems) > 40: print(f'  ... and {len(problems) - 40} more')
        else:
            print(f'{name}: ok')
    if failed:
        sys.exit('\nRegenerate the port (python3 tools/port/generate.py tools/port/NAME.json), or, when a copy was '
                 'edited on purpose, record the edit (--save-patch).')


if __name__ == '__main__':
    main()
