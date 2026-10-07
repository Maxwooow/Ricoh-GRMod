# SPDX-License-Identifier: GPL-2.0-only
"""Pre-compile the reference's three C modules (gr-custom-tool, gr4_editor/native/*.c) and write
core/src/fw/aspect/native.ts.

The reference compiles these with clang every time it builds a firmware, at an address and with
symbol values that depend on the configuration. GR Mod has no compiler at run time, so each module
is compiled here once per value of its one compile-time constant, linked at a fixed reference
address with `--emit-relocs`, and stored with its relocation list; `link()` in aspect/native-link.ts
then places it at the real address. The compiler flags and linker script are the reference's.

Self-test: every variant is compiled a second time at another address with other symbol values
and compared with the relocated first build, so the relocation handling is checked against lld.
"""
import base64
import json
import re
import struct
import subprocess
import tempfile
from pathlib import Path

import common

NATIVE = common.TOOL / 'gr4_editor' / 'native'
FLAGS = ['-target', 'armv7-none-eabi', '-mcpu=cortex-a9', '-marm', '-mfloat-abi=soft', '-Os', '-ffreestanding',
         '-fno-builtin', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-nostdlib']
MAX_CUSTOM = 8
R_ARM_ABS32, R_ARM_CALL, R_ARM_JUMP24, R_ARM_MOVW_ABS_NC, R_ARM_MOVT_ABS = 2, 28, 29, 43, 44

MODULES = {
    'state': {
        'file': 'crop_state.c', 'define': 'CROP_RECT_COUNT', 'counts': [3 * n for n in range(1, MAX_CUSTOM + 1)],
        'extra': {}, 'entry': 'crop_state_load',
        'bindings': ['crop_active_bitmap', 'crop_source_rectangles', 'prior_native_save', 'prior_native_load',
                     'factory_source_rectangle_body'],
        'exports': ['crop_state_save', 'crop_state_load', 'crop_normalize_userdata', 'crop_metadata_rectangle'],
    },
    'identity': {
        'file': 'crop_image_identity.c', 'define': 'CROP_REPLAY_RECT_COUNT', 'counts': list(range(0, 7 * MAX_CUSTOM + 1)),
        'extra': {}, 'entry': 'crop_image_extract_gate',
        'bindings': ['crop_image_archive', 'crop_image_rectangles', 'native_extract_table', 'native_extract_unknown',
                     'native_extract_return', 'native_set_table', 'native_set_unknown', 'native_set_join',
                     'native_playback_table', 'native_playback_unknown', 'native_playback_join', 'native_aspect_table',
                     'native_aspect_unknown', 'native_aspect_return', 'native_screen_rect_body',
                     'native_thumbnail_rect_body'],
        'exports': ['crop_image_extract_gate', 'crop_image_set_gate', 'crop_image_playback_gate',
                    'crop_image_aspect_gate', 'crop_image_source_aspect', 'crop_image_screen_rect',
                    'crop_image_thumbnail_rect'],
    },
    'map': {
        'file': 'crop_image_map.c', 'define': 'CUSTOM_COUNT', 'counts': list(range(1, MAX_CUSTOM + 1)),
        'extra': {'VIEW_BYTES': 400 + 12 * 48}, 'entry': 'crop_make_view',
        'bindings': ['ratios'],
        'exports': ['crop_identity', 'crop_make_view', 'crop_clone_tail'],
    },
}


def run(command):
    result = subprocess.run([str(item) for item in command], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(' '.join(map(str, command)) + '\n' + result.stderr)
    return result.stdout


def compile_module(spec, count, origin, bindings, relocs):
    """Exactly the reference's invocation (crop_state.py / crop_image_identity.py / crop_raw.py)."""
    with tempfile.TemporaryDirectory(prefix='grmod-native-') as folder:
        d = Path(folder)
        # The reference writes `#define NAME value` lines in this order: the count, then VIEW_BYTES.
        defines = {spec['define']: count, **spec['extra']}
        source = ''.join(f'#define {key} {value}\n' for key, value in defines.items())
        source += (NATIVE / spec['file']).read_text(encoding='utf-8')
        (d / 'm.c').write_text(source, encoding='utf-8')
        script = ' '.join(f'{name} = {value:#x};' for name, value in bindings.items())
        script += (f' SECTIONS {{ . = {origin:#x}; .text : {{ *(.text*) *(.rodata*) }} '
                   '/DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.comment*) } }')
        (d / 'm.ld').write_text(script, encoding='ascii')
        command = ['clang', '--ld-path=/usr/bin/ld.lld', *FLAGS, '-Wl,-T,' + str(d / 'm.ld'), '-Wl,--entry=' + spec['entry']]
        if relocs:
            command.append('-Wl,--emit-relocs')
        run(command + [d / 'm.c', '-o', d / 'm.elf'])
        run(['llvm-objcopy', '-O', 'binary', '--only-section=.text', d / 'm.elf', d / 'm.arm'])
        blob = (d / 'm.arm').read_bytes()
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


def make_template(name, spec, count):
    origin = 0x54400000
    bindings = {symbol: 0x53400000 + 0x1234 * (index + 1) * 4 for index, symbol in enumerate(spec['bindings'])}
    plain, _, _ = compile_module(spec, count, origin, bindings, False)
    blob, symbols, table = compile_module(spec, count, origin, bindings, True)
    if plain != blob or len(blob) % 4:
        raise SystemExit('--emit-relocs changed the code')
    words = list(struct.unpack('<%dI' % (len(blob) // 4), blob))
    relocs = []
    pending = {}
    for address, kind, symbol, value in table:
        offset = address - origin
        if not 0 <= offset < len(blob) or offset % 4:
            raise SystemExit('relocation outside the module')
        word = words[offset // 4]
        external = symbol in bindings
        if external:
            if value != bindings[symbol]:
                raise SystemExit('unexpected symbol value')
            target = ['x', spec['bindings'].index(symbol)]
        else:
            if not origin <= value < origin + len(blob):
                raise SystemExit(f'{name}: symbol {symbol} is neither bound nor inside the module')
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
            relocs.append([offset, 'b', *target, (destination - value) & 0xFFFFFFFF])
        else:
            raise SystemExit(f'{name}: unsupported relocation {kind}')
    if pending:
        raise SystemExit('unpaired MOVW relocation')
    relocs.sort()
    exports = {symbol: symbols[symbol] - origin for symbol in spec['exports']}
    return {'blob': blob, 'relocs': relocs, 'exports': exports}


def relocate(template, spec, origin, bindings):
    """The same arithmetic as aspect/native-link.ts, used here to test the templates against lld."""
    words = list(struct.unpack('<%dI' % (len(template['blob']) // 4), template['blob']))
    for offset, kind, where, index, addend in template['relocs']:
        symbol = bindings[spec['bindings'][index]] if where == 'x' else origin + index
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
    out = {}
    total = 0
    for name, spec in MODULES.items():
        out[name] = {'bindings': spec['bindings'], 'variants': {}}
        for count in spec['counts']:
            template = make_template(name, spec, count)
            # Check against a real second link: other origin, other symbol values (both halves differ).
            origin = 0x543FC1D0 + 0x10 * count
            bindings = {symbol: 0x5370A5DC + 0x00FEDCB8 * (index + 1) % 0x00F00000 // 4 * 4
                        for index, symbol in enumerate(spec['bindings'])}
            expected, symbols, _ = compile_module(spec, count, origin, bindings, False)
            if relocate(template, spec, origin, bindings) != expected:
                raise SystemExit(f'{name} {count}: relocated template differs from a real link')
            for symbol, offset in template['exports'].items():
                if symbols[symbol] - origin != offset:
                    raise SystemExit('export offset moved')
            out[name]['variants'][count] = {
                'code': base64.b64encode(template['blob']).decode('ascii'),
                'relocs': template['relocs'], 'exports': template['exports'],
            }
            total += len(template['blob'])
        print(name, len(spec['counts']), 'variants ok')
    version = run(['clang', '--version']).splitlines()[0]
    target = common.REPO / 'core/src/fw/aspect/native.ts'
    lines = [
        '// SPDX-License-Identifier: GPL-2.0-only',
        '// GENERATED by tools/aspect/gen_native.py -- do not edit.',
        '//',
        '// ARM code compiled from DoYitNow/gr-custom-tool (commit 0c15c8f), gr4_editor/native/crop_state.c,',
        '// crop_image_identity.c and crop_image_map.c, Copyright (C) 2026 DoYitNow, GPL-2.0-only. The sources are',
        '// in third_party/gr-custom-tool/. Compiler: ' + version + ', flags as in the reference',
        '// (' + ' '.join(FLAGS) + ').',
        '// One variant per value of the module\'s compile-time count. Relocations: [offset, kind, where, index, addend]',
        "// with kind 'w' = MOVW low half, 't' = MOVT high half, 'b' = B/BL; where 'x' = bound symbol number `index`,",
        "// 'i' = offset `index` inside the module.",
        '',
        "export type NativeReloc = readonly [number, 'w' | 't' | 'b', 'x' | 'i', number, number];",
        'export interface NativeVariant { readonly code: string; readonly relocs: readonly NativeReloc[]; readonly exports: Readonly<Record<string, number>> }',
        'export interface NativeModule { readonly bindings: readonly string[]; readonly variants: Readonly<Record<number, NativeVariant>> }',
        '',
        'export const NATIVE: Readonly<Record<\'state\' | \'identity\' | \'map\', NativeModule>> = '
        + json.dumps(out, separators=(',', ':')) + ' as unknown as Readonly<Record<\'state\' | \'identity\' | \'map\', NativeModule>>;',
        '',
    ]
    target.write_text('\n'.join(lines), encoding='utf-8')
    print('wrote', target, total, 'bytes of code')


if __name__ == '__main__':
    main()
