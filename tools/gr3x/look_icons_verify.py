"""Native list/ADJ/status icon regression for the T5-L1 missing-logo fix.

Menu enumeration, icon selection and the RGBA copier run natively. UI widgets
and the menu-model singleton are substituted; physical display is not emulated.
"""
import hashlib
import struct
from unicorn import arm_const as reg
from image_control_probe import LookProbe, NATIVE, OBJECT, u32, put
from adj_probe import VIEW, CHILD, CONTEXT, SURFACE, SOURCE, DEST


class IconProbe(LookProbe):
    def _hook(self, cpu, at, size, user):
        if at == 0x5320ba9c:
            cpu.reg_write(reg.UC_ARM_REG_R0, OBJECT)
            cpu.reg_write(reg.UC_ARM_REG_PC, cpu.reg_read(reg.UC_ARM_REG_LR))
        else:
            super()._hook(cpu, at, size, user)

    def state(self, mode, bank):
        self.menu_state(mode, bank)
        self.ui = []
        self.uc.mem_write(VIEW, bytes(0x300))
        put(self.uc, VIEW + 0x1f0, CHILD)
        put(self.uc, VIEW + 0x174, CHILD)
        # The widget count the list's constructor stores (0x531abc4c): the maximum look count + 2
        # (24 with nine films; 12 + n + 2 in round 6).
        self.uc.mem_write(VIEW + 0x1a9, bytes([self.call(0x532c2b7c, OBJECT) + 2]))


def verify(data, base, manifest):
    stock, fixed = IconProbe(data, base), IconProbe(data, manifest)
    ids = {s['id']: s['iconId'] for s in manifest['addedLooks']}
    calls = 0
    # These real list/status consumers returned zero for every added T5 ID.
    for identity in range(256):
        old = stock.call(0x532935dc, OBJECT, identity)
        expected = ids.get(identity, old)
        assert fixed.call(0x532935dc, OBJECT, identity) == expected
        assert fixed.call(0x532a9b28, OBJECT, identity) == expected
        assert fixed.call(0x532a9b2c, OBJECT, 0, identity) == expected
        if identity in ids:
            assert old == 0 and expected != 0
        for bank in (1, 2):
            assert fixed.call(0x532a9b2c, OBJECT, bank, identity) == stock.call(0x532a9b2c, OBJECT, bank, identity)
        calls += 8
    # Execute the entire native ADJ tile callback and the full image-control
    # list population, including original Custom 1/2 and unused widget clearing.
    for mode in range(3):
        for bank in range(3):
            stock.state(mode, bank); fixed.state(mode, bank)
            count = fixed.call(0x532c2a9c, OBJECT)
            expected_icons = []
            for i in range(count):
                identity = fixed.call(0x532c2c80, OBJECT, i)
                expected_icons.append(ids[identity] if identity in ids else stock.call(0x532935dc, OBJECT, identity))
            expected_icons += [stock.call(0x532a9988, OBJECT, n) for n in (23, 24)]
            widgets = fixed.uc.mem_read(VIEW + 0x1a9, 1)[0]
            assert widgets == 14 + len(ids) and len(expected_icons) <= widgets, 'look list exceeds native widget capacity'
            for i, icon in enumerate(expected_icons):
                fixed.ui = []
                fixed.call(0x531a0690, VIEW, i)
                assert fixed.ui == [(0x53394758, CHILD, i), (0x533a1734, CHILD, icon)]
                calls += 1
            fixed.ui = []
            fixed.call(0x531ab7e4, VIEW)
            expected_icons += [0] * (widgets - len(expected_icons))
            expected = [event for i, icon in enumerate(expected_icons)
                        for event in ((0x53394758, CHILD, i), (0x533a1734, CHILD, icon))]
            assert fixed.ui == expected
            calls += count + 4
    # Validate every new descriptor and execute the real transparent-pixel copy.
    pixels = bytes.fromhex(manifest['iconAddition']['bytes'])
    hashes = []
    for slot in manifest['addedLooks']:
        desc = u32(fixed.uc, manifest['catalogs']['iconRoot'] + slot['iconId'] * 4)
        w, h, offset = struct.unpack('<HHI', fixed.uc.mem_read(desc, 8))
        assert (w, h) == (40, 40)
        start = offset * 4 - manifest['iconAddition']['originalLength']
        tile = pixels[start:start + 6400]
        assert len(tile) == 6400 and sum(tile[3::4]) > 0
        for entry in (0x53209fb8, 0x53209fec):
            assert fixed.call(entry, OBJECT, slot['iconId']) == 40
        put(fixed.uc, SURFACE + 8, DEST + 32)
        fixed.uc.mem_write(SURFACE + 0x18, struct.pack('<H', 40))
        fixed.uc.mem_write(CONTEXT, bytes(0x20))
        fixed.uc.mem_write(SOURCE, tile)
        fixed.uc.mem_write(DEST, b'\xa5' * (6400 + 64))
        fixed.call(0x5320a020, CONTEXT, SURFACE, 0, 0,
                   stack=struct.pack('<6I', 0, 0, 40, 40, desc, SOURCE))
        expected = bytearray(b'\xa5' * 6400)
        for i in range(0, 6400, 4):
            if tile[i + 3]:
                expected[i:i + 4] = tile[i:i + 4]
        assert fixed.uc.mem_read(DEST, 32) == b'\xa5' * 32
        assert fixed.uc.mem_read(DEST + 32, 6400) == bytes(expected)
        assert fixed.uc.mem_read(DEST + 6432, 32) == b'\xa5' * 32
        coloured = sum(tile[i+3] != 0 and max(tile[i:i+3]) - min(tile[i:i+3]) >= 24 for i in range(0, 6400, 4))
        hashes.append(dict(id=slot['id'], name=slot['name'], sha256=hashlib.sha256(tile).hexdigest(), coloured_pixels=coloured))
        calls += 3
    # The nine named T6 films (Provia 100F ..., each with its own coloured icon): nine different
    # coloured tiles. Builds with the app's default names keep the camera's film icon or the
    # user's own, which need not be coloured.
    if len(hashes) == 9 and not any(h['name'] == f'Film {k + 1}' for k, h in enumerate(hashes)):
        assert len({h['sha256'] for h in hashes}) == 9
        assert all(h['coloured_pixels'] >= 200 for h in hashes)
    return dict(schema=1, native_calls=calls, original_byte_domain_preserved=True,
                missing_icon_zero_result_reproduced=True,
                complete_native_adj_icon_callback=True, complete_native_list_population=True,
                native_status_icon_wrappers=True, all_three_modes_and_banks=True,
                rgba_copy_and_canaries=True, icons=hashes,
                hardware_tested=False, ui_widget_services_substituted=True)
