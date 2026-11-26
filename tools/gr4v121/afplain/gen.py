# SPDX-License-Identifier: GPL-2.0-only
"""Compile the subject recognition runtime (runtime/*.c) and write core/src/fw/gr4v121/aspect/subjectaf-code.ts.

  python3 tools/gr4v121/afplain/gen.py [--keep DIR]

ARMv7-A (Cortex-A7), ARM mode, soft float, -O2, freestanding, -fropi -frwpi, no jump tables, through `python -m ziglang`
(the compiler of the camera builds). Checks: the same bytes when linked at 0x10000 and at 0x54450000 (position
independent), no .data / .bss / .rodata / .got section, no undefined symbol, no VFP instruction in the code, the sources
unchanged during the build. --keep DIR keeps the objects, the ELF of each link and build.json (symbols, stack usage).
Needs pyelftools and capstone. The model is written by gen_model.py."""
import argparse, base64, hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path
from elftools.elf.elffile import ELFFile
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SRC = HERE / 'runtime'
OUT = ROOT / 'core' / 'src' / 'fw' / 'gr4v121' / 'aspect' / 'subjectaf-code.ts'
NAMES = ['runtime', 's1_model', 'subject_net', 'compiler_support', 'diag_attach']
FLAGS = ['-target', 'arm-freestanding-eabi', '-mcpu=cortex_a7', '-marm', '-mfloat-abi=soft', '-O2', '-ffreestanding', '-fno-builtin',
         '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-nostdlib', '-fropi', '-frwpi', '-fno-jump-tables', '-fno-stack-protector',
         '-fstack-usage', '-Wall', '-Wextra', '-Werror']
ORIGINS = (0x10000, 0x54450000)
Z = [sys.executable, '-m', 'ziglang']


def sources():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted([*SRC.glob('*.c'), *SRC.glob('*.h')])}


def build(work: Path):
    env = dict(os.environ, ZIG_GLOBAL_CACHE_DIR=str(work / 'zig-cache'), ZIG_LOCAL_CACHE_DIR=str(work / 'zig-local'))

    def run(args):
        r = subprocess.run([str(a) for a in args], text=True, capture_output=True, env=env, cwd=work)
        if r.returncode:
            sys.exit(' '.join(map(str, args)) + '\n' + r.stdout + r.stderr)
        return r.stdout

    before = sources()
    objects = []
    for name in NAMES:
        obj = work / f'{name}.o'
        run(Z + ['cc'] + FLAGS + ['-c', SRC / f'{name}.c', '-o', obj])
        objects.append(obj)
    stack = {p.name: p.read_text() for p in sorted(work.rglob('*.su'))}
    probe = work / 'layout-probe.c'
    probe.write_text('#include <stddef.h>\n#include "' + str(SRC / 'runtime.c') + '"\n'
                     'unsigned char state_size[sizeof(struct pl_state)];\nunsigned char static_size[sizeof(struct pl_static)];\n')
    run(Z + ['cc'] + FLAGS + ['-c', probe, '-o', work / 'layout-probe.o'])
    with (work / 'layout-probe.o').open('rb') as f:
        sizes = {s.name: s['st_size'] for s in ELFFile(f).get_section_by_name('.symtab').iter_symbols()}
    layout = {'state_bytes': sizes['state_size'], 'static_bytes': sizes['static_size']}
    blobs, maps = [], []
    for origin in ORIGINS:
        script = work / f'runtime-{origin:x}.ld'
        script.write_text(f'SECTIONS {{ . = 0x{origin:x}; .text : ALIGN(4) {{ *(.text .text.*) *(.rodata .rodata.*) }} '
                          '/DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) } }\n')
        elf = work / f'runtime-{origin:x}.elf'
        run(Z + ['ld.lld', '-T', script, '--entry=af_s1_dispatch', '-o', elf, *objects])
        with elf.open('rb') as f:
            e = ELFFile(f)
            blob = e.get_section_by_name('.text').data()
            bad = [s.name for s in e.iter_sections() if s.name in ('.data', '.bss', '.rodata', '.got')]
            if bad:
                sys.exit(f'module has sections {bad}')
            symbols = list(e.get_section_by_name('.symtab').iter_symbols())
            if [s.name for s in symbols if s.name and s['st_shndx'] == 'SHN_UNDEF']:
                sys.exit('module has undefined symbols')
            syms = {s.name: s['st_value'] for s in symbols if s.name and s['st_shndx'] != 'SHN_UNDEF'}
            mapping = sorted((s['st_value'], s.name[1]) for s in symbols if s.name.startswith(('$a', '$d', '$t')))
            decoder, count, vfp = Cs(CS_ARCH_ARM, CS_MODE_ARM), 0, []
            for s in symbols:
                if s['st_info']['type'] != 'STT_FUNC' or not s['st_size']:
                    continue
                lo0, hi0 = s['st_value'], s['st_value'] + s['st_size']
                edges = [lo0] + [p for p, _ in mapping if lo0 < p < hi0] + [hi0]
                for lo, hi in zip(edges, edges[1:]):
                    if next((k for p, k in reversed(mapping) if p <= lo), 'a') != 'a':
                        continue
                    for insn in decoder.disasm(blob[lo - origin:hi - origin], lo):
                        count += 1
                        if insn.mnemonic.startswith('v'):
                            vfp.append(hex(insn.address))
            if vfp:
                sys.exit(f'VFP instructions in the module: {vfp[:8]}')
        blobs.append(blob)
        maps.append({'origin': origin, 'symbols': syms, 'decodedCodeInstructions': count})
    if blobs[0] != blobs[1]:
        sys.exit('module is not position independent')
    if sources() != before:
        sys.exit('runtime sources changed during the build')
    entry = maps[1]['symbols']['af_s1_dispatch'] - ORIGINS[1]
    if layout['static_bytes'] > 0x200 or layout['state_bytes'] > 0x28000:
        sys.exit('runtime state does not fit')
    info = {'code_bytes': len(blobs[1]), 'code_sha256': hashlib.sha256(blobs[1]).hexdigest(), 'entry': entry, 'layout': layout,
            'maps': maps, 'sources': before, 'compiler': run(Z + ['cc', '--version']).splitlines()[0], 'stack_usage': stack}
    return blobs[1], info


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--keep', type=Path)
    a = ap.parse_args()
    if a.keep:
        a.keep.mkdir(parents=True, exist_ok=True)
        code, info = build(a.keep.resolve())
        (a.keep / 'build.json').write_text(json.dumps(info, indent=1) + '\n')
    else:
        with tempfile.TemporaryDirectory() as t:
            code, info = build(Path(t))
    src = hashlib.sha256(''.join(f'{k}:{v}\n' for k, v in info['sources'].items()).encode()).hexdigest()
    OUT.write_text(
        '// SPDX-License-Identifier: GPL-2.0-only\n'
        '// GENERATED by tools/gr4v121/afplain/gen.py from tools/gr4v121/afplain/runtime -- do not edit.\n'
        f'// Compiler: {info["compiler"]}\n'
        f'// Sources SHA-256 (name:sha256 lines): {src}\n'
        f'// Module SHA-256: {info["code_sha256"]}\n'
        '// Position independent; entry `af_s1_dispatch(op, a, b, ctx)` at SUBJECTAF_ENTRY; ctx: struct s1_module_ctx (runtime.h).\n\n'
        f"export const SUBJECTAF_CODE = '{base64.b64encode(code).decode()}';\n"
        f'export const SUBJECTAF_CODE_LENGTH = {len(code)};\n'
        f'export const SUBJECTAF_ENTRY = 0x{info["entry"]:x};\n'
        f'/** struct pl_state (one allocation of the camera\'s heap 2) and struct pl_static (at the state address). */\n'
        f'export const SUBJECTAF_STATE_BYTES = {info["layout"]["state_bytes"]};\n'
        f'export const SUBJECTAF_STATIC_BYTES = {info["layout"]["static_bytes"]};\n')
    print(json.dumps({'out': str(OUT.relative_to(ROOT)), 'bytes': len(code), 'sha256': info['code_sha256'], 'entry': hex(info['entry']), 'layout': info['layout']}))


if __name__ == '__main__':
    main()
