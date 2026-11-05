# SPDX-License-Identifier: GPL-2.0-only
"""Pre-compile tools/gr3x/native/films.c (round 10: the films' own parameters, GR IV's
slot_params.c way) and write core/src/fw/gr3x/films-native.ts.

As tools/slotparams/gen_slotparams.py for GR IV: compiled once per film count (1..20), linked at a
reference address with `--emit-relocs` and stored with its relocation list; `linkModule()` in
aspect/native-link.ts places it at the real address. Every variant is linked a second time at
another address with other symbol values and compared with the relocated first build. The entry
stubs of the camera's functions are written by image-control.ts.
"""
import base64
import json
import re
import struct
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SOURCE = HERE / 'native' / 'films.c'
TARGET = REPO / 'core/src/fw/gr3x/films-native.ts'
FLAGS = ['-target', 'armv7-none-eabi', '-mcpu=cortex-a9', '-marm', '-mfloat-abi=soft', '-Os', '-ffreestanding',
         '-fno-builtin', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-nostdlib', '-Wall', '-Werror']
COUNTS = range(1, 21)
BINDINGS = ['prior_native_save', 'prior_native_load', 'storage_singleton', 'store_write', 'store_read', 'store_size',
            'heap_alloc', 'sp_gap', 'settings_object', 'slot_prints']
EXPORTS = ['sp_load', 'sp_save', 'sp_style_set', 'sp_before_recall', 'sp_hal', 'sp_hal_put', 'sp_col', 'sp_col_put',
           'sp_hal_text', 'sp_raw_init', 'sp_raw_own', 'sp_raw_sync']


def stubs():
    return ''


def run(command):
    result = subprocess.run([str(item) for item in command], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(' '.join(map(str, command)) + '\n' + result.stderr)
    return result.stdout


def compile_module(count, origin, bindings, relocs):
    with tempfile.TemporaryDirectory(prefix='grmod-films-') as folder:
        d = Path(folder)
        (d / 'm.c').write_text(f'#define SLOT_COUNT {count}\n' + SOURCE.read_text(encoding='utf-8') + stubs(), encoding='utf-8')
        script = ' '.join(f'{name} = {value:#x};' for name, value in bindings.items())
        script += (f' SECTIONS {{ . = {origin:#x}; .text : {{ *(.text*) *(.rodata*) }} '
                   '/DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.comment*) } }')
        (d / 'm.ld').write_text(script, encoding='ascii')
        command = ['clang', '--ld-path=/usr/bin/ld.lld', *FLAGS, '-Wl,-T,' + str(d / 'm.ld'), '-Wl,--entry=sp_load']
        if relocs:
            command.append('-Wl,--emit-relocs')
        run(command + [d / 'm.c', '-o', d / 'm.elf'])
        sections = run(['llvm-readelf', '-S', '-W', d / 'm.elf'])
        for name in ('.data', '.bss'):
            if re.search(r'\s' + re.escape(name) + r'\s', sections):
                raise SystemExit(f'the module must not have {name}')
        run(['llvm-objcopy', '-O', 'binary', '--only-section=.text', d / 'm.elf', d / 'm.arm'])
        blob = (d / 'm.arm').read_bytes()
        if re.search(r'__aeabi|memset|memcpy', run(['llvm-objdump', '-d', d / 'm.elf'])):
            raise SystemExit('library call in the module')
        listing = run(['llvm-nm', '-n', d / 'm.elf'])
        if re.search(r'^\s+U\s', listing, re.M):
            raise SystemExit('undefined symbol')
        symbols = {name: int(at, 16) for at, kind, name in re.findall(r'^([0-9a-fA-F]+)\s+(\w)\s+(\S+)$', listing, re.M)}
        table = []
        if relocs:
            text = run(['llvm-readelf', '-r', '-W', d / 'm.elf'])
            for offset, info, kind, value, name in re.findall(
                    r'^([0-9a-f]{8})\s+([0-9a-f]{8})\s+(R_ARM_\w+)\s+([0-9a-f]{8})\s+(\S+)\s*$', text, re.M):
                table.append((int(offset, 16), kind, name, int(value, 16)))
        return blob, symbols, table


def half(word):
    return ((word >> 4) & 0xF000) | (word & 0xFFF)


def make_template(count):
    origin = 0x54400000
    bindings = {symbol: 0x53400000 + 0x1234 * (index + 1) * 4 for index, symbol in enumerate(BINDINGS)}
    plain, _, _ = compile_module(count, origin, bindings, False)
    blob, symbols, table = compile_module(count, origin, bindings, True)
    if plain != blob or len(blob) % 4:
        raise SystemExit('--emit-relocs changed the code')
    words = list(struct.unpack('<%dI' % (len(blob) // 4), blob))
    relocs, pending = [], {}
    for address, kind, symbol, value in table:
        offset = address - origin
        if not 0 <= offset < len(blob) or offset % 4:
            raise SystemExit('relocation outside the module')
        word = words[offset // 4]
        if symbol in bindings:
            if value != bindings[symbol]:
                raise SystemExit('unexpected symbol value')
            target = ['x', BINDINGS.index(symbol)]
        else:
            if not origin <= value < origin + len(blob):
                raise SystemExit(f'symbol {symbol} is neither bound nor inside the module')
            target = ['i', value - origin]
        if kind == 'R_ARM_MOVW_ABS_NC':
            pending[(symbol, (word >> 12) & 15)] = (offset, half(word), target, value)
        elif kind == 'R_ARM_MOVT_ABS':
            low_offset, low, low_target, low_value = pending.pop((symbol, (word >> 12) & 15))
            addend = ((half(word) << 16 | low) - value) & 0xFFFFFFFF
            relocs.append([low_offset, 'w', *target, addend])
            relocs.append([offset, 't', *target, addend])
        elif kind in ('R_ARM_CALL', 'R_ARM_JUMP24'):
            displacement = word & 0xFFFFFF
            if displacement & 0x800000:
                displacement -= 1 << 24
            destination = address + 8 + displacement * 4
            if target[0] == 'x' and destination != value:
                raise SystemExit(f'a branch to {symbol} does not land on it (destination {destination:#x})')
            relocs.append([offset, 'b', *target, (destination - value) & 0xFFFFFFFF])
        else:
            raise SystemExit(f'unsupported relocation {kind}')
    if pending:
        raise SystemExit('unpaired MOVW relocation')
    relocs.sort()
    return {'blob': blob, 'relocs': relocs, 'exports': {s: symbols[s] - origin for s in EXPORTS}}


def relocate(template, origin, bindings):
    """The arithmetic of aspect/native-link.ts, tested here against lld."""
    words = list(struct.unpack('<%dI' % (len(template['blob']) // 4), template['blob']))
    for offset, kind, where, index, addend in template['relocs']:
        symbol = bindings[BINDINGS[index]] if where == 'x' else origin + index
        value = (symbol + addend) & 0xFFFFFFFF
        word = words[offset // 4]
        if kind in ('w', 't'):
            imm = value & 0xFFFF if kind == 'w' else value >> 16
            word = (word & 0xFFF0F000) | ((imm & 0xF000) << 4) | (imm & 0xFFF)
        else:
            delta = value - (origin + offset + 8)
            if delta % 4 or not -(1 << 25) <= delta < (1 << 25):
                raise SystemExit('branch out of range')
            word = (word & 0xFF000000) | ((delta >> 2) & 0xFFFFFF)
        words[offset // 4] = word
    return struct.pack('<%dI' % len(words), *words)


def main():
    out = {'bindings': BINDINGS, 'variants': {}}
    for count in COUNTS:
        template = make_template(count)
        origin = 0x543FC1D0 + 0x10 * count
        bindings = {symbol: 0x5370A5DC + 0x00FEDCB8 * (index + 1) % 0x00F00000 // 4 * 4 for index, symbol in enumerate(BINDINGS)}
        expected, symbols, _ = compile_module(count, origin, bindings, False)
        if relocate(template, origin, bindings) != expected:
            raise SystemExit(f'{count}: relocated template differs from a real link')
        for symbol, offset in template['exports'].items():
            if symbols[symbol] - origin != offset:
                raise SystemExit('export offset moved')
        out['variants'][count] = {'code': base64.b64encode(template['blob']).decode('ascii'),
                                  'relocs': template['relocs'], 'exports': template['exports']}
        print(count, len(template['blob']), 'bytes ok')
    version = run(['clang', '--version']).splitlines()[0]
    lines = [
        '// SPDX-License-Identifier: GPL-2.0-only',
        '// GENERATED by tools/gr3x/gen_films.py -- do not edit.',
        '//',
        '// ARM code compiled from tools/gr3x/native/films.c (round 10: the films\' own parameters).',
        '// Compiler: ' + version + ', flags ' + ' '.join(FLAGS) + '.',
        '// One variant per film count. Relocations as in ../aspect/native.ts.',
        '',
        "import type { NativeModule } from '../aspect/native';",
        '',
        'export const GR3X_FILMS_SOURCE_SHA256 = ' + json.dumps(__import__('hashlib').sha256(SOURCE.read_bytes()).hexdigest()) + ';',
        'export const GR3X_FILMS_MODULE: NativeModule = ' + json.dumps(out, separators=(',', ':')) + ' as unknown as NativeModule;',
        '',
    ]
    TARGET.write_text('\n'.join(lines), encoding='utf-8')
    print('wrote', TARGET)


if __name__ == '__main__':
    main()
