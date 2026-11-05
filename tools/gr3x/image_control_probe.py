"""Native IIIx extra-look menu and pipeline-boundary checks. No firmware output.

The real property handlers and RAM transaction execute. Thread queue delivery is
replaced with direct calls through the original handler tables. This cannot test
power-cycle persistence, file I/O, camera UI rendering or the physical ISP.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe, put, u32
from native_probe import BASE, OBJECT, OUTPUT, RTOS_SHA
from rear_dial_probe import DATA, MODEL, SELECTOR, USER, USERDATA

if not __debug__:
    raise RuntimeError('Run without Python -O')

SHIM = 0x54100000
VALIDATE_TABLE, COMMIT_TABLE = 0x540927e8, 0x54093030
GAMMA_GUARD, GAMMA_OBJECT = 0x5536dbf8, 0x5536dbfc
GAMMA_BUFFERS = (0x62090000, 0x62090400, 0x62090800)
CONTEXT, COMMON = 0x62060000, 0x62080000
NATIVE = [11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21]


class LookProbe(AdjProbe):
    def __init__(self, data, manifest):
        assert manifest['kind'] in ('gr3x-adj-patchset', 'gr3x-image-control-menu-research', 'gr3x-image-control-patchset')
        if manifest['kind'] == 'gr3x-image-control-menu-research':
            assert manifest['flashable'] is False and manifest['cameraUpdateCandidate'] is False
            assert not manifest['renderingImplemented'] and not manifest['persistenceImplemented']
        # Reuse the base patch-byte/hash validation without widening its public format.
        super().__init__(data, {**manifest, 'kind': 'gr3x-adj-patchset'})
        self.queue = []
        self.uc.mem_map(SHIM, 0x1000)
        # (Round 7 without films: the ADJ layer's look word for the date imprint is there too.)
        if manifest.get('ownParameters') or 'jpeg' in manifest.get('lookEntries', {}) or 'lookStash' in manifest.get('entries', {}):
            # The table pointer of own film parameters (0x55804374) is zeroed at every start.
            # Left 0 here, the module stays out of the way and these checks see the T6c
            # behaviour underneath; slots_probe.py exercises the module itself.
            self.uc.mem_map(0x55800000, 0x100000)
        # R12 receives the original member-function address, R0 is the native User
        # object. Real validation/commit receives R1=argument pointer, R2=0.
        # Only command 2 stores its Boolean result through the queue output pointer.
        words = [0xe92d4070, 0xe1a0400c, 0xe59d5010, 0xe1a06001,
                 0xe1a01003, 0xe3a02000, 0xe12fff34, 0xe3560002,
                 0x1a000001, 0xe3550000, 0x15c50000, 0xe3a00000, 0xe8bd8070]
        self.uc.mem_write(SHIM, struct.pack('<13I', *words))
        for table, expected in ((VALIDATE_TABLE, 0x535423a0), (COMMIT_TABLE, 0x535423ac)):
            assert struct.unpack_from('<II', data, table - BASE + 0xd4 * 8) == (expected, 0)
        try: self.uc.mem_map(0x5536d000, 0x1000)
        except Exception: pass  # already mapped with the zero-filled RAM (adj_probe)
        put(self.uc, GAMMA_GUARD, 1)
        self.uc.mem_write(GAMMA_OBJECT, struct.pack('<3I', *GAMMA_BUFFERS))

    def _hook(self, cpu, at, size, user):
        if at == 0x5354b564:
            command = cpu.reg_read(reg.UC_ARM_REG_R1)
            field = cpu.reg_read(reg.UC_ARM_REG_R2)
            assert command in (1, 2) and 0 <= field < 265
            assert cpu.reg_read(reg.UC_ARM_REG_R0) == USER
            table = COMMIT_TABLE if command == 1 else VALIDATE_TABLE
            target, adjustment = struct.unpack_from('<II', self.data, table - BASE + field * 8)
            assert adjustment == 0 and BASE <= target < BASE + len(self.data) and target % 4 == 0
            self.queue.append((command, field))
            cpu.reg_write(reg.UC_ARM_REG_R12, target)
            cpu.reg_write(reg.UC_ARM_REG_PC, SHIM)
        else:
            super()._hook(cpu, at, size, user)

    def menu_state(self, mode=0, active=0):
        self.reset({DATA + 0x1c0: active, DATA + 0x57c: active,
                    DATA + 0x1c2: 11, DATA + 0x1c4: 11, DATA + 0x1c6: 11})
        self.uc.mem_write(OBJECT, bytes(0x400))
        self.uc.mem_write(OBJECT + 0x1b, bytes([mode, active]))
        self.uc.mem_write(USERDATA, bytes(0x1040))
        self.uc.mem_write(USERDATA + 0x2000, bytes(0x1040))
        self.uc.mem_write(MODEL, struct.pack('<3I', USERDATA, USERDATA + 0x2000, 0))
        for pointer in (USERDATA, USERDATA + 0x2000):
            self.uc.mem_write(pointer + 0x77c, b'\x0b')
        self.queue = []

    def descriptor(self, tone, toning=None):
        self.uc.mem_write(OBJECT, bytes(0x300))
        self.uc.mem_write(CONTEXT, bytes(0x9000))
        self.uc.mem_write(COMMON, bytes(0x2000))
        self.uc.mem_write(COMMON + 0x77c, bytes([tone]))
        self.uc.mem_write(COMMON + 0x77d, bytes([4]) * 6)
        if toning is not None: self.uc.mem_write(COMMON + 0x786, bytes([toning]))
        put(self.uc, CONTEXT + 0x82d0, COMMON)
        self.uc.mem_write(OUTPUT, b'\xa5' * 0x120)
        for pointer in GAMMA_BUFFERS:
            self.uc.mem_write(pointer - 16, b'\xa5' * (512 + 32))
        self.call(0x536dc0f4, OBJECT, CONTEXT, OUTPUT)
        for pointer in GAMMA_BUFFERS:
            assert self.uc.mem_read(pointer - 16, 16) == b'\xa5' * 16
            assert self.uc.mem_read(pointer + 512, 16) == b'\xa5' * 16
        assert self.uc.mem_read(OUTPUT + 0xa0, 0x80) == b'\xa5' * 0x80
        return {
            'tone': tone,
            'record': u32(self.uc, OUTPUT + 8),
            'multi_axis_record': u32(self.uc, OUTPUT + 12),
            'gamma_enabled': self.uc.mem_read(GAMMA_OBJECT + 12, 1)[0],
            'gamma_sha256': [hashlib.sha256(self.uc.mem_read(p, 512)).hexdigest() for p in GAMMA_BUFFERS],
        }


def verify(data, base, extra):
    stock, patched = LookProbe(data, base), LookProbe(data, extra)
    calls = 0
    slots = extra['addedLooks']
    ids = [row['id'] for row in slots]
    assert ids == list(range(64, 64 + len(slots)))
    # Real count, item enumeration and reverse lookup; movie/RAW menus stay native.
    for mode in range(3):
        for active in range(3):
            stock.menu_state(mode, active)
            patched.menu_state(mode, active)
            count = stock.call(0x532c2a9c, OBJECT)
            native = [stock.call(0x532c2c80, OBJECT, i) for i in range(count)]
            if mode != 1:
                assert native == NATIVE
            expected = native + ids if mode == 0 else native
            assert patched.call(0x532c2a9c, OBJECT) == len(expected)
            for index, identity in enumerate(expected):
                assert patched.call(0x532c2c80, OBJECT, index) == identity
                assert patched.call(0x532c2f08, OBJECT, identity) == index
                calls += 2
            calls += count + 2
    assert patched.call(0x532c2b7c, OBJECT) == 12 + len(slots)
    calls += 1
    for identity in range(11, 25):
        for entry in (0x532a985c, 0x532a9988, 0x532922b4):
            assert patched.call(entry, OBJECT, identity) == stock.call(entry, OBJECT, identity)
            calls += 2
    for slot in slots:
        for entry, key in ((0x532a985c, 'textId'), (0x532922b4, 'textId'), (0x532a9988, 'iconId')):
            assert patched.call(entry, OBJECT, slot['id']) == slot[key]
            calls += 1
        for entry in (0x53209fb8, 0x53209fec):
            assert patched.call(entry, OBJECT, slot['iconId']) == 40
            calls += 1
    for language in range(21):
        old = u32(stock.uc, base['catalogs']['textRoots'] + 4 * language)
        new = u32(patched.uc, extra['catalogs']['textRoots'] + 4 * language)
        size = base['catalogs']['textColumns'] * 4
        assert stock.uc.mem_read(old, size) == patched.uc.mem_read(new, size)
        for slot in slots:
            record = u32(patched.uc, new + slot['textId'] * 4)
            units, lines, reserved, pointer = struct.unpack('<BBHI', patched.uc.mem_read(record, 8))
            assert (units, lines, reserved) == (len(slot['name']) + 1, 1, 0)
            assert patched.uc.mem_read(pointer, units * 2).decode('utf-16le') == slot['name'] + '\0'
    original_icons = base['catalogs']['iconCount'] * 4
    assert stock.uc.mem_read(base['catalogs']['iconRoot'], original_icons) == patched.uc.mem_read(extra['catalogs']['iconRoot'], original_icons)
    assert bytes.fromhex(extra['iconAddition']['bytes']).startswith(bytes.fromhex(base['iconAddition']['bytes']))

    # The native model setter, aggregate generation, original property handlers and
    # swap/copy transaction execute together, not just a simulated field write.
    for active in range(3):
        for identity in NATIVE + ids:
            patched.menu_state(0, active)
            patched.call(0x532c26c0, OBJECT, identity)
            assert patched.uc.mem_read(DATA + 0x1c2 + 2 * active, 1)[0] == identity
            assert (1, 0x82) in patched.queue
            for pointer in (u32(patched.uc, MODEL), u32(patched.uc, MODEL + 4)):
                assert patched.uc.mem_read(pointer + 0x77c, 1)[0] == identity
            calls += 1

    # Show why successful selection is NOT permission to export this as firmware.
    native_descriptors = [stock.descriptor(tone) for tone in NATIVE]
    records = set(struct.unpack('<26I', stock.uc.mem_read(0x55018d94, 26 * 4)))
    for desc in native_descriptors:
        assert desc['record'] in records and desc['multi_axis_record'] == 0x53dc2ba0
    bad_descriptors, raw_rejections, restriction_gaps = [], [], []
    for identity in ids:
        desc = patched.descriptor(identity)
        desc['native_record_valid'] = desc['record'] in records
        desc['native_multi_axis_valid'] = desc['multi_axis_record'] == 0x53dc2ba0
        assert not (desc['native_record_valid'] and desc['native_multi_axis_valid'])
        bad_descriptors.append(desc)
        try:
            patched.call(0x53288d5c, OBJECT, identity)
        except ValueError as exc:
            assert 'assertion failed' in str(exc)
            raw_rejections.append(identity)
        else:
            raise AssertionError('Unimplemented RAW enum unexpectedly accepted')
        patched.menu_state()
        # This function is a shooting-mode restriction, NOT an enum-range check.
        # Its permissive unknown-ID fallthrough must not bypass the Standard gate.
        for pointer in (u32(patched.uc, MODEL), u32(patched.uc, MODEL + 4)):
            patched.uc.mem_write(pointer + 0x6c0, b'\x02')
        assert patched.call(0x53553ad4, MODEL, 11) == 0
        assert patched.call(0x53553ad4, MODEL, identity) == 1
        restriction_gaps.append(identity)
        calls += 4
    calls += len(NATIVE)
    return {
        'schema': 1, 'rtos_sha256': hashlib.sha256(data).hexdigest(), 'native_calls': calls,
        'extra_menu_items': len(ids), 'original_looks_and_custom_1_2_labels_preserved': True,
        'movie_and_raw_development_menus_unchanged': True,
        'all_21_languages_preserve_original_and_ratio_entries': True,
        'original_icons_and_ratio_pixels_preserved': True,
        'all_three_still_banks_through_native_model_and_ram_transaction': True,
        'queue_delivery_substituted': True, 'persistent_file_io_tested': False,
        'native_gamma_three_256x_u16_channels_executed': True,
        'native_gamma_and_descriptor_buffer_canaries': True,
        'native_descriptors': native_descriptors,
        'new_ids_produce_invalid_isp_descriptors': bad_descriptors,
        'raw_development_enum_rejects_new_ids': raw_rejections,
        'new_ids_bypass_native_standard_shooting_restriction': restriction_gaps,
        'camera_update_candidate': False, 'firmware_generated': False,
        'hardware_tested': False,
        'scope': 'Native menu, descriptor, gamma reset, selection, and RAM transaction only. No sensor, boot, actual image or persistent storage test.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('rtos', 'base', 'extra', 'report'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.rtos.read_bytes(), json.loads(args.base.read_text()), json.loads(args.extra.read_text()))
    with args.report.open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(json.dumps({key: value for key, value in report.items()
                      if key not in ('native_descriptors', 'new_ids_produce_invalid_isp_descriptors')}, indent=2))
