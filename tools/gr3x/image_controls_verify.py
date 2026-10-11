"""Execute the IIIx T5 look adapters and real native setting/ISP/RAW functions.

This is bounded native-code emulation. It cannot establish camera boot, real
JPEG encoding, physical color accuracy or power-cycle persistence.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path
from unicorn import arm_const as reg
from image_control_probe import (LookProbe, NATIVE, COMMON, CONTEXT, GAMMA_OBJECT,
                                 GAMMA_BUFFERS, DATA, MODEL, OBJECT, OUTPUT, u32, put)
from native_probe import BASE, STACK, RTOS_SHA
from color_curve_probe import COMPOSE, ISP, INPUTS, OUTPUTS, interpolate

MATRIX_OBJECT = 0x620c0000


def matrix_process(probe):
    """Run the actual descriptor-to-ISP matrix path, including Q13 products."""
    cpu = probe.uc
    desc = bytes(cpu.mem_read(OUTPUT, 0xa0))
    record = u32(cpu, OUTPUT + 8)
    record_bytes = bytes(cpu.mem_read(record, 84))
    matrix = u32(cpu, record + 4)
    matrix_bytes = bytes(cpu.mem_read(matrix, 18))
    right = struct.unpack('<9h', matrix_bytes)
    if desc[0x79]:
        left = struct.unpack_from('<3h', desc, 0x7c) * 3
    else:
        saturation = desc[0x57]
        index = cpu.mem_read(0x53dc1400 + saturation, 1)[0] if saturation <= 8 else 4
        left = struct.unpack('<9h', cpu.mem_read(u32(cpu, u32(cpu, record + 8) + 4 * index), 18))
    expected = [((sum(left[r*3+k] * right[k*3+c] for k in range(3)) + 4096) >> 13) & 65535
                for r in range(3) for c in range(3)]
    cpu.mem_write(MATRIX_OBJECT - 32, b'\xa5' * (0x60 + 64))
    cpu.mem_write(MATRIX_OBJECT, bytes(0x60))
    probe.call(0x536deecc, MATRIX_OBJECT, OUTPUT)
    assert struct.unpack('<9H', cpu.mem_read(MATRIX_OBJECT + 0x48, 18)) == tuple(expected)
    assert cpu.mem_read(MATRIX_OBJECT - 32, 32) == b'\xa5' * 32
    assert cpu.mem_read(MATRIX_OBJECT + 0x60, 32) == b'\xa5' * 32
    assert cpu.mem_read(OUTPUT, 0xa0) == desc
    assert cpu.mem_read(record, 84) == record_bytes
    assert cpu.mem_read(matrix, 18) == matrix_bytes
    return bytes(cpu.mem_read(MATRIX_OBJECT, 0x60))


def descriptor(probe, identity, parameters):
    probe.descriptor(identity)
    probe.uc.mem_write(COMMON + 0x77d, bytes(parameters))
    probe.uc.mem_write(OBJECT, bytes(0x300))
    probe.uc.mem_write(OUTPUT, b'\xa5' * 0x120)
    probe.call(0x536dc0f4, OBJECT, CONTEXT, OUTPUT)
    assert probe.uc.mem_read(OUTPUT + 0xa0, 0x80) == b'\xa5' * 0x80
    return (bytes(probe.uc.mem_read(OUTPUT, 0xa0)),
            bytes(probe.uc.mem_read(OBJECT, 0x210)),
            bytes(probe.uc.mem_read(GAMMA_OBJECT + 12, 4)),
            [bytes(probe.uc.mem_read(p, 512)) for p in GAMMA_BUFFERS])


def verify(data, base, manifest):
    stock, patched = LookProbe(data, base), LookProbe(data, manifest)
    slots = manifest['addedLooks']
    mapping = {s['id']: s['nativeBase'] for s in slots}
    calls, adapter_cases = 0, 0
    # Every byte value and all four condition bits. Only the intended destination
    # register changes; the caller's flags and stack are exactly preserved.
    for site in manifest['lookEntries']['adapters']:
        source, dest = site['sourceRegister'], site['destinationRegister']
        for identity in range(256):
            for flags in range(16):
                registers = [0x12340000 + i for i in range(15)]
                registers[source] = COMMON
                registers[13] = STACK
                for i, v in enumerate(registers):
                    patched.uc.reg_write(getattr(reg, 'UC_ARM_REG_R' + str(i)), v)
                cpsr = (flags << 28) | 0x13
                patched.uc.reg_write(reg.UC_ARM_REG_CPSR, cpsr)
                patched.uc.mem_write(COMMON + 0x77c, bytes([identity]))
                patched.uc.emu_start(site['address'], site['address'] + 4, count=100)
                assert patched.uc.reg_read(reg.UC_ARM_REG_PC) == site['address'] + 4
                registers[dest] = mapping.get(identity, identity)
                assert patched.uc.reg_read(reg.UC_ARM_REG_CPSR) == cpsr
                assert all(patched.uc.reg_read(getattr(reg, 'UC_ARM_REG_R' + str(i))) == v
                           for i, v in enumerate(registers))
                adapter_cases += 1

    # Isolate single-instruction adapters from full-function translation blocks.
    # Unicorn can otherwise run past an until-PC inside an already cached block.
    stock, patched = LookProbe(data, base), LookProbe(data, manifest)
    # Independently execute the firmware curve that the software CUBE model uses.
    source = (Path(__file__).parents[2] / 'core/src/color/gr3x-camera.ts').read_text()
    values = re.search(r'GR3X_REFERENCE_CURVE = new Uint16Array\(\[([\s\d,]+)\]\)', source)
    reference = tuple(int(v) for v in values[1].split(',') if v.strip())
    assert len(reference) == 256
    for probe in (stock, patched):
        descriptor(probe, 11, slots[0]['parameters'])
        put(probe.uc, OUTPUT + 0x64, 8192)
        probe.uc.mem_write(ISP, bytes(0x3400))
        probe.call(0x536e84c8, ISP, OUTPUT)
        assert struct.unpack('<256H', probe.uc.mem_read(ISP, 512)) == reference
        calls += 3

    # Preserve native menus, names, icons and defaults; append only to stills.
    for mode in range(3):
        for bank in range(3):
            stock.menu_state(mode, bank); patched.menu_state(mode, bank)
            old_count = stock.call(0x532c2a9c, OBJECT)
            expected = [stock.call(0x532c2c80, OBJECT, i) for i in range(old_count)]
            if mode == 0:
                expected += list(mapping)
            assert patched.call(0x532c2a9c, OBJECT) == len(expected)
            for i, identity in enumerate(expected):
                assert patched.call(0x532c2c80, OBJECT, i) == identity
                assert patched.call(0x532c2f08, OBJECT, identity) == i
                calls += 2
            calls += old_count + 2
    for identity in range(11, 25):
        for entry in (0x532a985c, 0x532a9988, 0x532922b4):
            assert patched.call(entry, OBJECT, identity) == stock.call(entry, OBJECT, identity)
            calls += 2
    for slot in slots:
        assert patched.call(0x532a985c, OBJECT, slot['id']) == slot['textId']
        assert patched.call(0x532a9988, OBJECT, slot['id']) == slot['iconId']
        calls += 2
    setters = [0x532bd784,0x532bdcd8,0x532be22c,0x532be8a0,0x532bef14,0x532bf588,
               0x532bfbfc,0x532c0270,0x532c056c,0x532c0700,0x532c0894,0x532c09a8,
               0x532c0b3c,0x532c0da8,0x532c141c,0x532c1780,0x532c19dc,
               0x532c1cf4,0x532c2038,0x532c237c]
    for bank in range(3):
        for identity in NATIVE + list(mapping):
            patched.menu_state(0, bank); stock.menu_state(0, bank)
            patched.call(0x532c26c0, OBJECT, identity)
            assert patched.uc.mem_read(DATA + 0x1c2 + bank * 2, 1) == bytes([identity])
            assert (1, 0x82) in patched.queue
            slot = next((s for s in slots if s['id'] == identity), None)
            if slot:
                for pointer in (u32(patched.uc, MODEL), u32(patched.uc, MODEL + 4)):
                    assert patched.uc.mem_read(pointer + 0x77c, 1) == bytes([identity])
                    assert patched.uc.mem_read(pointer + 0x77d, 26) == bytes(slot['parameters'])
                before = bytes(patched.uc.mem_read(u32(patched.uc, MODEL), 0x1040))
                for setter in setters:
                    patched.call(setter, OBJECT, 2)
                    assert patched.uc.mem_read(u32(patched.uc, MODEL), 0x1040) == before, hex(setter)
                    calls += 1
                for getter in manifest['lookEntries']['defaults']:
                    assert patched.call(getter['address'], OBJECT, identity) == slot['parameters'][getter['offset'] - 0x77d]
                    calls += 1
            else:
                stock.call(0x532c26c0, OBJECT, identity)
                for offset in (0, 4):
                    assert patched.uc.mem_read(u32(patched.uc, MODEL + offset), 0x1040) == stock.uc.mem_read(u32(stock.uc, MODEL + offset), 0x1040)
                calls += 1
            calls += 1

    # Original rendering descriptors/gamma remain byte-identical across neutral,
    # dark and bright parameter states, including after leaving imported looks.
    for identity in NATIVE:
        for value in (0, 4, 8):
            params = list(slots[0]['parameters'])
            for offset in (0,1,2,3,4,5,7,22,23):
                params[offset] = value
            assert descriptor(patched, identity, params) == descriptor(stock, identity, params)
            assert matrix_process(patched) == matrix_process(stock)
            calls += 6
    descriptors = []
    for slot in slots:
        wanted = descriptor(stock, slot['nativeBase'], slot['parameters'])
        actual = descriptor(patched, slot['id'], slot['parameters'])
        expected = bytearray(wanted[0])
        if slot['record']:
            struct.pack_into('<I', expected, 8, slot['record'])
        if slot['nativeBase'] == 20:
            expected[0x79] = 1
        assert actual[0] == expected, slot['name']
        assert actual[1] == wanted[1], slot['name']
        matrix_output = matrix_process(patched)
        if not slot['record']:
            assert matrix_output == matrix_process(stock), slot['name']
            calls += 1
        if slot['nativeBase'] == 20:
            assert matrix_output[0x48:0x4e] == matrix_output[0x4e:0x54] == matrix_output[0x54:0x5a]
        calls += 1
        if slot['curves']:
            assert actual[2][:2] == b'\1\1'
            assert u32(patched.uc, GAMMA_OBJECT + 20) == slot['curveId']
            for channel, curve in enumerate(actual[3]):
                assert curve == patched.uc.mem_read(slot['curves'] + channel * 512, 512)
            patched.uc.mem_write(ISP, bytes(0x3400))
            ramp = [min(16383, i * 64 + i % 64) for i in range(256)]
            for offset in INPUTS:
                patched.uc.mem_write(ISP + offset, struct.pack('<256H', *ramp))
            patched.call(COMPOSE, ISP, 0)
            curves = [struct.unpack('<256H', c) for c in actual[3]]
            composed = [[interpolate(c, v) for v in ramp] for c in curves]
            luminance = [(77*r+150*g+29*b) >> 8 for r,g,b in zip(*composed)]
            for offset, expected_curve in zip(OUTPUTS, composed + [luminance]):
                assert struct.unpack('<256H', patched.uc.mem_read(ISP + offset, 512)) == tuple(min(1023, v >> 4) for v in expected_curve)
            calls += 1
        else:
            assert actual[2:] == wanted[2:]
        assert patched.call(0x53288d5c, OBJECT, slot['id']) == stock.call(0x53288d5c, OBJECT, slot['nativeBase'])
        for mode in range(5):
            patched.menu_state(); stock.menu_state()
            for probe in (patched, stock):
                probe.uc.mem_write(u32(probe.uc, MODEL) + 0x6c0, bytes([mode]))
            assert patched.call(0x53553ad4, MODEL, slot['id']) == stock.call(0x53553ad4, MODEL, slot['nativeBase'])
            calls += 2
        calls += 6
        descriptors.append({'id': slot['id'], 'name': slot['name'], 'native_base': slot['nativeBase'],
                            'native_matrix_output_sha256': hashlib.sha256(matrix_output).hexdigest(),
                            'descriptor_sha256': hashlib.sha256(actual[0]).hexdigest()})
    # Exercise ordered changes without rebuilding the emulator. The gamma object
    # and its identity persist across calls, so first/last and same-slot returns
    # cannot leave the preceding film's curves or matrix selected.
    transition_cases = 0
    for previous in slots:
        for selected in slots:
            descriptor(patched, previous['id'], previous['parameters'])
            current = descriptor(patched, selected['id'], selected['parameters'])
            if selected['record']:
                assert u32(patched.uc, OUTPUT + 8) == selected['record']
            if selected['curves']:
                assert u32(patched.uc, GAMMA_OBJECT + 20) == selected['curveId']
                for channel, curve in enumerate(current[3]):
                    assert curve == patched.uc.mem_read(selected['curves'] + channel * 512, 512)
            transition_cases += 1
            calls += 4
        for identity in NATIVE:
            descriptor(patched, previous['id'], previous['parameters'])
            assert descriptor(patched, identity, slots[0]['parameters']) == descriptor(stock, identity, slots[0]['parameters'])
            assert matrix_process(patched) == matrix_process(stock)
            transition_cases += 1
            calls += 8
    return dict(schema=1, rtos_sha256=RTOS_SHA, native_calls=calls, adapter_cases=adapter_cases,
                sequential_look_transition_cases=transition_cases,
                native_looks_restored_after_each_imported_look=True,
                audited_property_consumers=len(manifest['lookEntries']['adapters']),
                original_menu_and_look_descriptors_preserved=True,
                real_native_property_transactions_all_three_banks=True,
                private_ids_retained=True, new_fixed_parameters_applied=True,
                native_raw_development_fallback=True, native_shooting_restrictions_preserved=True,
                selected_matrix_record_and_rgb_curve_bytes_verified=True,
                actual_native_matrix_processing_and_q13_products_verified=True,
                independent_native_256_entry_reference_curve_verified=True,
                new_defaults_and_fixed_setter_behavior_verified=True,
                register_flags_stack_and_buffer_canaries=True,
                descriptors=descriptors, hardware_tested=False, persistent_storage_verified=False,
                scope='Bounded ARM functions with queue delivery and UI/singleton substitutes. No complete camera boot/JPEG/DNG encoding.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('rtos', 'base', 'manifest', 'report'):
        parser.add_argument('--' + name, type=Path, required=True)
    a = parser.parse_args()
    report = verify(a.rtos.read_bytes(), json.loads(a.base.read_text()), json.loads(a.manifest.read_text()))
    with a.report.open('x') as stream:
        json.dump(report, stream, indent=2); stream.write('\n')
    print(json.dumps({k:v for k,v in report.items() if k != 'descriptors'}, indent=2))
