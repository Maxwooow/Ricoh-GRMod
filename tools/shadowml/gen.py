# SPDX-License-Identifier: GPL-2.0-only
"""Compile tools/shadowml/shadowml.c and write core/src/fw/aspect/shadowml-code.ts (module) and shadowml-data.ts (the model blob).

As tools/hdrgain/gen.py, the module is position independent (-fropi -frwpi, no global data), checked by linking it at two
addresses and comparing, by refusing any .data/.bss/.rodata/.got section and any undefined symbol (no libcalls), and by
requiring the entry `shadowml` at offset 0. The constants shared with the C code (shadowml_const.h) come from ref.py.

The model blob is tools/shadowml/model/model_final.bin (the trained model, committed) unless another blob file is given, or
--placeholder (ref.placeholder_blob(), the test fixture):  gen.py [model.bin | --placeholder]
"""
import base64
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import ref

HERE = Path(__file__).resolve().parent
ROOT = next(p for p in HERE.parents if (p / 'package.json').exists())   # the repository (this file is also in a port's tools)
SRC = HERE / 'shadowml.c'
HDR = HERE / 'shadowml_const.h'
OUT_CODE = ROOT / 'core/src/fw/aspect/shadowml-code.ts'
OUT_DATA = ROOT / 'core/src/fw/aspect/shadowml-data.ts'
USE_ZIG = bool(os.environ.get('GRMOD_ZIG')) or not (shutil.which('clang') and shutil.which('ld.lld') and shutil.which('llvm-objcopy'))
FLAGS = ['-mcpu=cortex_a7' if USE_ZIG else '-mcpu=cortex-a7', '-marm', '-mfloat-abi=soft', '-O2', '-fomit-frame-pointer',
         '-ffreestanding', '-fno-builtin', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-nostdlib',
         '-fropi', '-frwpi', '-fno-jump-tables', '-Wall', '-Wextra', '-Werror']


def tools():
    if not USE_ZIG:
        return ['clang', '-target', 'armv7-none-eabi'], ['ld.lld'], ['llvm-objcopy']
    z = [sys.executable, '-m', 'ziglang']
    return z + ['cc', '-target', 'arm-freestanding-eabi'], z + ['ld.lld'], z + ['objcopy']


def run(cmd):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'{" ".join(map(str, cmd))}\n{r.stdout}{r.stderr}')
    return r.stdout


def elf_info(elf):
    """Section names and (name, value, undefined) of every symbol: readelf, or pyelftools where there is no readelf."""
    if shutil.which('readelf'):
        names = [l.split(']', 1)[1].split()[0] for l in run(['readelf', '-S', '-W', elf]).splitlines() if l.strip().startswith('[') and ']' in l and l.split(']', 1)[1].split()]
        symbols = []
        for l in run(['readelf', '-s', '-W', elf]).splitlines()[3:]:
            f = l.split()
            if len(f) >= 7 and f[0].endswith(':'):
                symbols.append((f[7] if len(f) > 7 else '', int(f[1], 16), f[6] == 'UND'))
        return names, symbols
    from elftools.elf.elffile import ELFFile
    with open(elf, 'rb') as fh:
        e = ELFFile(fh)
        names = [x.name for x in e.iter_sections()]
        tab = e.get_section_by_name('.symtab')
        symbols = [(x.name, x['st_value'], x['st_shndx'] == 'SHN_UNDEF') for x in tab.iter_symbols()] if tab else []
    return names, symbols


def build(cc, ld, objcopy, tmp, origin, extra=()):
    obj = tmp / 'sm.o'
    run(cc + FLAGS + ['-I', HERE] + list(extra) + ['-c', SRC, '-o', obj])
    elf = tmp / f'sm_{origin:x}.elf'
    run(ld + [f'-Ttext=0x{origin:x}', '--entry=shadowml', '-o', elf, obj])   # no library: an undefined symbol is an error
    out = tmp / f'sm_{origin:x}.bin'
    run(objcopy + ['-O', 'binary', '-j', '.text', elf, out])
    names, symbols = elf_info(elf)
    for name in ('.data', '.bss', '.rodata', '.got'):
        if any(n == name or n.startswith(name + '.') for n in names):
            sys.exit(f'module has a {name} section')
    entry = [v for n, v, _ in symbols if n == 'shadowml']
    if not entry or entry[0] != origin:
        sys.exit('shadowml is not at the start of .text')
    if any(undefined and n for n, _, undefined in symbols):
        sys.exit('undefined symbols')
    return out.read_bytes()


def stack_usage(cc, tmp):
    run(cc + FLAGS + ['-I', HERE, '-fstack-usage', '-c', SRC, '-o', tmp / 'su.o'])
    rows = {}
    if not (tmp / 'su.su').exists():
        print('compiler emitted no static .su report; use the ARM runtime stack measurements (stack_fw.py)', file=sys.stderr)
        return rows
    for l in (tmp / 'su.su').read_text().splitlines():
        p = l.split('\t')
        rows[p[0].split(':')[-1]] = int(p[1])
    return rows


def main():
    HDR.write_text(ref.const_header())
    arg = sys.argv[1] if len(sys.argv) > 1 else str(HERE / 'model' / 'model_final.bin')
    blob = ref.placeholder_blob() if arg == '--placeholder' else Path(arg).read_bytes()
    if ref.parse_blob(blob) is None:
        sys.exit('the model blob is not valid')
    while len(blob) % 4:
        blob += b'\0'
    cc, ld, objcopy = tools()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        a = build(cc, ld, objcopy, tmp, 0x10000)
        b = build(cc, ld, objcopy, tmp, 0x543f0000)
        su = stack_usage(cc, tmp)
    if a != b:
        sys.exit('module is not position independent')
    while len(a) % 4:
        a += b'\0'
    version = run(cc + ['--version']).splitlines()[0]
    src_hash = hashlib.sha256(SRC.read_bytes() + HDR.read_bytes()).hexdigest()
    OUT_CODE.write_text(
        '// SPDX-License-Identifier: GPL-2.0-only\n'
        '// GENERATED by tools/shadowml/gen.py from tools/shadowml/shadowml.c (+ shadowml_const.h) -- do not edit.\n'
        f'// Compiler: {version}\n'
        f'// Source SHA-256 (shadowml.c followed by shadowml_const.h): {src_hash}\n'
        '// Position independent: entry `shadowml(ctx, P, mode, hl, idx)` at offset 0; ctx layout in shadowml.c (struct shadowml_ctx).\n\n'
        f"export const SHADOWML_CODE = '{base64.b64encode(a).decode()}';\n"
        f'export const SHADOWML_CODE_LENGTH = {len(a)};\n'
        f'export const SHADOWML_MAGIC = 0x{ref.MAGIC:08x};\n'
        f"export const SHADOWML_SOURCE_SHA256 = '{src_hash}';\n")
    blob_hash = hashlib.sha256(blob).hexdigest()
    OUT_DATA.write_text(
        '// SPDX-License-Identifier: GPL-2.0-only\n'
        '// GENERATED by tools/shadowml/gen.py (tools/shadowml/ref.py: build_blob; model/model_final.bin unless gen.py was given another blob) -- do not edit.\n'
        '// The model blob of shadowml-code.ts (format: docstring of tools/shadowml/ref.py).\n\n'
        f"export const SHADOWML_DATA = '{base64.b64encode(blob).decode()}';\n"
        f'export const SHADOWML_DATA_LENGTH = {len(blob)};\n'
        f"export const SHADOWML_DATA_SHA256 = '{blob_hash}';\n")
    print(f'{OUT_CODE}: {len(a)} bytes')
    print(f'{OUT_DATA}: {len(blob)} bytes, sha256 {blob_hash}')
    print('stack usage per function (bytes):', su)


if __name__ == '__main__':
    main()
