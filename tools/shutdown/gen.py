# SPDX-License-Identifier: GPL-2.0-only
"""Compile tools/shutdown/shutdown.c and write core/src/fw/aspect/shutdown-code.ts.

As tools/halation/gen.py: the module is position independent (-fropi -frwpi, no global data, every
address it needs is a constant or comes in through its context argument), so the bytes do not
depend on where they are placed; this is checked by linking at two addresses and comparing. The
offsets of the exported functions are written next to the code. Compiler: clang if present, else
`python3 -m ziglang cc` (GRMOD_ZIG=1 to prefer it).

GRMOD_FW=120 builds the module for firmware 1.20 (GR IV 1.20, GR IV Monochrome 1.10) into
shutdown-code-120.ts: the firmware addresses of shutdown.c (its #else block) are replaced by their
1.20 addresses from core/src/fw/target120.ts (shutdown-fw120.h, written next to the object). The
1.11 module (shutdown-code.ts) is the one built with Ubuntu clang 18.1.3 before the 1.20 branch
was added; for 1.11 that branch changes nothing, and another compiler gives other bytes, so it is
not rebuilt with the 1.20 one.
"""
import base64
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SRC = HERE / 'shutdown.c'
FW = os.environ.get('GRMOD_FW', '111')
OUT = ROOT / 'core' / 'src' / 'fw' / 'aspect' / ('shutdown-code-120.ts' if FW == '120' else 'shutdown-code.ts')
TABLE = ROOT / 'core' / 'src' / 'fw' / 'target120.ts'
EXPORTS = ['sd_get', 'sd_background', 'sd_save', 'sd_refresh', 'sd_confirm', 'sd_left', 'sd_right', 'sd_footer', 'sd_line']
USE_ZIG = bool(os.environ.get('GRMOD_ZIG')) or not (shutil.which('clang') and shutil.which('ld.lld') and shutil.which('llvm-objcopy'))
FLAGS = ['-mcpu=cortex_a9' if USE_ZIG else '-mcpu=cortex-a9', '-marm', '-mfloat-abi=soft', '-Os',
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


def fw120_header(tmp):
    """shutdown-fw120.h: the #define lines of shutdown.c's 1.11 block with 1.20 addresses."""
    table = {int(a, 16): int(b, 16) for a, b in re.findall(r'\[0x([0-9a-f]{8}), 0x([0-9a-f]{8})\]', TABLE.read_text())}
    text = SRC.read_text()
    block = text[text.index('#else', text.index('#ifdef GRMOD_FW_120')):text.index('#endif', text.index('#ifdef GRMOD_FW_120'))]
    out = []
    for m in re.finditer(r'^#define (\w+)(\s+.*?)0x([0-9a-f]{8})u(\)+)$', block, re.M):
        a = int(m.group(3), 16)
        if a not in table:
            sys.exit(f'{m.group(1)}: 0x{a:08x} has no 1.20 address in {TABLE.name}')
        out.append(f'#define {m.group(1)}{m.group(2)}0x{table[a]:08x}u{m.group(4)}')
    if not out:
        sys.exit('no firmware addresses found in shutdown.c')
    (tmp / 'shutdown-fw120.h').write_text('\n'.join(out) + '\n')
    return len(out)


def build(cc, ld, objcopy, tmp, origin):
    obj = tmp / 'sd.o'
    extra = ['-DGRMOD_FW_120', '-I', str(tmp)] if FW == '120' else []
    run(cc + FLAGS + extra + ['-c', SRC, '-o', obj])
    elf = tmp / f'sd_{origin:x}.elf'
    run(ld + [f'-Ttext=0x{origin:x}', '--entry=sd_get', '-o', elf, obj])
    out = tmp / f'sd_{origin:x}.bin'
    run(objcopy + ['-O', 'binary', '-j', '.text', elf, out])
    sections = run(['readelf', '-S', '-W', elf])
    for name in ('.data', '.bss', '.rodata', '.got'):
        if f' {name} ' in sections or f' {name}.' in sections:
            sys.exit(f'module has a {name} section')
    symbols = {}
    for line in run(['readelf', '-s', '-W', elf]).splitlines():
        m = re.match(r'\s*\d+:\s+([0-9a-f]+)\s+\d+\s+FUNC\s+GLOBAL\s+\S+\s+\S+\s+(\w+)$', line)
        if m:
            symbols[m.group(2)] = int(m.group(1), 16) - origin
    if sorted(symbols) != sorted(EXPORTS):
        sys.exit(f'unexpected exports: {sorted(symbols)}')
    return out.read_bytes(), symbols


def main():
    cc, ld, objcopy = tools()
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        if FW == '120':
            fw120_header(tmp)
        a, sa = build(cc, ld, objcopy, tmp, 0x10000)
        b, sb = build(cc, ld, objcopy, tmp, 0x543f0000)
    if a != b or sa != sb:
        sys.exit('module is not position independent')
    if any(v % 4 for v in sa.values()):
        sys.exit('unaligned export')
    while len(a) % 4:
        a += b'\0'
    version = run(cc + ['--version']).splitlines()[0]
    src_hash = hashlib.sha256(SRC.read_bytes()).hexdigest()
    exports = ', '.join(f'{k}: {sa[k]}' for k in EXPORTS)
    suffix = '_120' if FW == '120' else ''
    OUT.write_text(
        '// SPDX-License-Identifier: GPL-2.0-only\n'
        '// GENERATED by tools/shutdown/gen.py from tools/shutdown/shutdown.c -- do not edit.\n'
        + ('// For firmware 1.20 (GRMOD_FW=120): -DGRMOD_FW_120, addresses from core/src/fw/target120.ts.\n' if FW == '120' else '')
        + f'// Compiler: {version}\n'
        f'// Source SHA-256: {src_hash}\n'
        '// Position independent; every export takes the context (struct sd_ctx) as its last argument.\n\n'
        f"export const SHUTDOWN_CODE{suffix} = '{base64.b64encode(a).decode()}';\n"
        f'export const SHUTDOWN_CODE{suffix}_LENGTH = {len(a)};\n'
        f'export const SHUTDOWN_EXPORTS{suffix} = {{ {exports} }} as const;\n'
        f"export const SHUTDOWN{suffix}_SOURCE_SHA256 = '{src_hash}';\n")
    print(f'{OUT}: {len(a)} bytes, exports {sa}')


if __name__ == '__main__':
    main()
