# SPDX-License-Identifier: GPL-2.0-only
"""Generate a port of GR Mod's code for another official firmware (development tool).

    python3 tools/port/generate.py tools/port/gr3-p2.json            # write the port
    python3 tools/port/generate.py tools/port/gr3-p2.json --raw DIR  # only the substituted copy, into DIR
    python3 tools/port/generate.py tools/port/gr3-p2.json --save-patch   # record the hand edits

The port is a copy of the source directories with every firmware address (0x53000000..0x55ffffff
literals) replaced through the committed address map (addrmap.py output with its overrides), the
directory names replaced, and then the hand-written changes (`patch`, a unified diff) applied:
what the map cannot do (code Ricoh changed, the profile, sizes). An address that is not in the map,
or not `ok` there, stops the generation: nothing is ever carried over unmapped. The original
directories are never written.
"""
import difflib, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ADDR = re.compile(r'\b0x5[345][0-9a-fA-F]{6}(?![0-9a-fA-F])')
TEXT = {'.ts', '.mts', '.mjs', '.js', '.py', '.c', '.h', '.txt', '.md', '.json', '.ld', '.sh'}

LENIENT = False   # config "lenient": a non-ok address is left as it is, for the hand edits to replace

def substitute(text, table, where):
    def one(m):
        old = m.group(0); key = '0x' + old[2:].lower()
        e = table.get(key)
        if e is None or not e.get('ok') or e.get('new') is None:
            if LENIENT and e is not None: return old
            sys.exit(f'{where}: {old} is not mapped (add it to the map or its overrides)')
        new = int(e['new'], 16)
        return ('0x%08X' if old[2:].isupper() and any(c.isalpha() for c in old[2:]) else '0x%08x') % new
    return ADDR.sub(one, text)

def rename(text, pairs):
    for a, b in pairs: text = text.replace(a, b)
    return text

IMPORT = re.compile(r'''((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.{1,2}/[^'"]*)\2''')

def copied_files(cfg):
    """Every copied source file (repo-relative) -> its place in the port."""
    out = {}
    for src, dst in cfg.get('files', []): out[src] = dst
    for src, dst in cfg['copies']:
        for f in (REPO / src).rglob('*'):
            rel = f.relative_to(REPO / src)
            if f.is_file() and not any(part in cfg.get('exclude', []) for part in rel.parts): out[f'{src}/{rel}'] = f'{dst}/{rel}'
    return out

def relink(text, src, dst, moved):
    """Relative TS imports of a copied file: to the copy of the module when it is copied, else to the
    original module (shared code: types, container, ...), from the copy's new place."""
    if Path(src).suffix not in {'.ts', '.mts'}: return text
    def one(m):
        spec = m.group(3)
        base = os.path.normpath(os.path.join(os.path.dirname(src), spec))
        target = next((c for c in (base + '.ts', base + '.mts', base, base + '/index.ts') if c in moved or (REPO / c).is_file()), None)
        if target is None: sys.exit(f'{src}: import {spec} not found')
        new_target = moved.get(target, target)
        if new_target.endswith('/index.ts') and not spec.endswith('index'): new_target = new_target[:-len('/index.ts')]
        elif target.endswith(('.ts', '.mts')) and not spec.endswith(('.ts', '.mts', '.js')): new_target = new_target.rsplit('.', 1)[0]
        rel = os.path.relpath(new_target, os.path.dirname(dst))
        if not rel.startswith('.'): rel = './' + rel
        return m.group(1) + m.group(2) + rel + m.group(2)
    return IMPORT.sub(one, text)

def generate(cfg, target_root):
    global LENIENT; LENIENT = bool(cfg.get('lenient'))
    table = json.loads((REPO / cfg['map']).read_text())['addresses']
    moved = copied_files(cfg) if cfg.get('relink') else {}
    convert = lambda t, src, dst: rename(substitute(relink(t, src, dst, moved) if moved else t, table, src), cfg['rename'])
    for src, dst in cfg.get('files', []):
        out = target_root / dst; out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(convert((REPO / src).read_text(encoding='utf-8'), src, dst), encoding='utf-8')
    keep = {}
    for rel in cfg.get('preserve', []):   # made once by other tools (translated fixtures): kept as they are
        p = target_root / rel
        if p.is_dir(): keep[rel] = {f.relative_to(p): f.read_bytes() for f in p.rglob('*') if f.is_file()}
    for src, dst in cfg['copies']:
        s, d = REPO / src, target_root / dst
        if d.exists(): shutil.rmtree(d)
        for f in sorted(s.rglob('*')):
            rel = f.relative_to(s)
            if any(part in cfg.get('exclude', []) for part in rel.parts) or f.is_dir(): continue
            out = d / rel; out.parent.mkdir(parents=True, exist_ok=True)
            if f.suffix in TEXT:
                t = f.read_text(encoding='utf-8')
                out.write_text(convert(t, f'{src}/{rel}', f'{dst}/{rel}'), encoding='utf-8')
            else:
                shutil.copy2(f, out)
    for rel, files in keep.items():
        for name, data in files.items():
            out = target_root / rel / name; out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(data)

def main():
    cfg_path = Path(sys.argv[1]); cfg = json.loads(cfg_path.read_text()); args = sys.argv[2:]
    patch = REPO / cfg['patch']
    if args[:1] == ['--raw']:
        generate(cfg, Path(args[1])); return
    if args[:1] == ['--save-patch']:
        with tempfile.TemporaryDirectory() as t:
            raw = Path(t) / 'raw'; generate(cfg, raw)
            diffs = []
            skip = lambda rel: (any(part in cfg.get('exclude', []) for part in Path(rel).parts) or
                                any(rel.startswith(p + '/') for p in cfg.get('preserve', [])) or
                                any(re.search(g, rel) for g in cfg.get('generated', [])))   # post-step outputs are made again
            def files_of(root, dst):
                p = root / dst
                if p.is_file(): return {dst}
                return {str(f.relative_to(root)) for f in p.rglob('*') if f.is_file()} if p.is_dir() else set()
            for _, dst in cfg['copies'] + cfg.get('files', []):
                for rel in sorted(files_of(raw, dst) | files_of(REPO, dst)):
                    if skip(rel) or Path(rel).suffix not in TEXT: continue
                    a, b = raw / rel, REPO / rel
                    ta = a.read_text(encoding='utf-8') if a.exists() else None
                    tb = b.read_text(encoding='utf-8') if b.exists() else None
                    if ta == tb: continue
                    head = f'diff --git a/{rel} b/{rel}\n' + ('new file mode 100644\n' if ta is None else 'deleted file mode 100644\n' if tb is None else '')
                    body = difflib.unified_diff((ta or '').splitlines(True), (tb or '').splitlines(True),
                                                '/dev/null' if ta is None else f'a/{rel}', '/dev/null' if tb is None else f'b/{rel}')
                    text = ''.join(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n' for line in body)
                    diffs.append(head + text)
            patch.write_text(''.join(diffs))
            print(f'wrote {patch.relative_to(REPO)} ({sum(d.count(chr(10)) for d in diffs)} lines)')
        return
    generate(cfg, REPO)
    if patch.exists() and patch.read_text().strip():
        r = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(patch)], cwd=REPO, capture_output=True, text=True)
        if r.returncode: sys.exit('the hand edits do not apply:\n' + r.stderr)
    # Belt and braces: no old address may survive anywhere in the generated tree, in any syntax
    # (0x53828014u in C, inside longer tokens, in comments), unless the map keeps it where it is.
    table = json.loads((REPO / cfg['map']).read_text())['addresses']
    # moved addresses, and (lenient ports) the ones the map could not resolve: none may be left
    moved = {k for k, e in table.items() if (e.get('new') and int(e['new'], 16) != int(k, 16)) or not e.get('ok')}
    valid = {e['new'] for e in table.values() if e.get('new') and e.get('ok')}
    leftovers = []
    for _, dst in cfg['copies'] + cfg.get('files', []):
        for f in sorted((REPO / dst).rglob('*')) if (REPO / dst).is_dir() else [REPO / dst]:
            if f.is_file() and f.suffix in TEXT:
                for x in re.findall(r'0x5[345][0-9a-fA-F]{6}', f.read_text(encoding='utf-8')):
                    if '0x' + x[2:].lower() in moved and '0x' + x[2:].lower() not in valid:
                        leftovers.append(f'{f.relative_to(REPO)}: {x}')
    if leftovers: sys.exit('old addresses left in the port:\n' + '\n'.join(leftovers[:40]))
    for step in cfg.get('post', []):
        r = subprocess.run(step, cwd=REPO, capture_output=True, text=True)
        if r.returncode: sys.exit(f'post step {step} failed:\n{r.stdout}{r.stderr}')
    print('generated', ', '.join(d for _, d in cfg['copies']))

if __name__ == '__main__':
    main()
