# SPDX-License-Identifier: GPL-2.0-only
"""Independent look at a firmware file GR Mod produced with added ratios.

  python3 verify_file.py FILE [--boot]

1. Opens FILE with the reference tool's own strict container reader (checksums, section order,
   component versions) and compares every section with the official file.
2. Runs the firmware's own functions in the emulator through the reference's read-back
   (`read_crops`): the menu count and order, each ratio's name, live-view rectangle, screen and
   thumbnail crops, every output size for both model branches, the main-image descriptor, the DNG
   window and the RAW development targets. A function that hits a firmware assertion fails this.
3. With --boot: additional checks of code that runs whether or not an added ratio is selected
   (see boot_checks.py).
"""
import hashlib
import json
import sys

import common
from gr4_editor.firmware import _load_bytes
from gr4_editor.crops import read_crops
from gr4_editor.crop_icons import FACTORY_ICONS
from gr4_editor.crop_native import CropNative


def main():
    path = sys.argv[1]
    data = open(path, 'rb').read()
    image = _load_bytes(data)
    official = common.image()
    print('container: ok, version', image.internal_version, 'frames', image.layout_proof['frames'])
    by_name = {row['name']: row for row in official.sections}
    for row in image.sections:
        old = by_name[row['name']]
        new_bytes = image.decoded[row['start']:row['end']]
        old_bytes = official.decoded[old['start']:old['end']]
        if row['name'] in ('RTOS', 'ICONBIN'):
            grown = len(new_bytes) - len(old_bytes)
            assert grown > 0 and grown % 0x6000 == 0, row['name']
            diff = sum(1 for i in range(16, len(old_bytes), 4) if new_bytes[i:i + 4] != old_bytes[i:i + 4])
            print(f"  {row['name']}: +{grown} bytes, {diff} words changed in the official part")
        else:
            assert new_bytes == old_bytes, 'section changed: ' + row['name']
    assert image.version == official.version

    rows, inspection = read_crops(image.rtos)
    if inspection.get('native_readback') != 'passed':
        raise SystemExit('native read-back failed: ' + inspection.get('reason', '?'))
    print('native read-back: passed; order', inspection['order'], 'RAW re-cut complete:', inspection['raw_recut_complete'])
    original_rows, _ = common.official_crops()
    for row, original in zip(rows[:4], original_rows):
        assert row['geometry'] == original['geometry'] and row['name'] == original['name'] and row['identity'] == original['identity'], \
            'a factory ratio changed: ' + row['name']
        assert [r['internal_ids'] for r in row['raw_development']][0][:len(original['raw_development'][0]['internal_ids'])] \
            == original['raw_development'][0]['internal_ids'], 'factory RAW targets changed'
    print('factory ratios 3:2, 4:3, 1:1, 16:9: geometry identical to the official firmware')
    native = CropNative(image.rtos)
    for public, identity in enumerate(FACTORY_ICONS):
        assert native.call(0x5338143C, 0, public, 0) == identity, 'factory icon mapping changed'
    for row in rows[4:]:
        g = row['geometry']
        sizes = sorted({(s['width'], s['height']) for s in g['photo_sizes'] if s['model'] == 'Kb636'}, reverse=True)
        print(f"  id {row['identity']['public_id']} \"{row['name']}\" actual {row['actual_ratio']}: screen "
              f"{g['screen']['width']}x{g['screen']['height']}+{g['screen']['left']}+{g['screen']['top']}, GR IV sizes {sizes}, "
              f"RAW targets {row['raw_development'][0]['internal_ids']}")
    summary = hashlib.sha256(json.dumps([[r['name'], r['identity'], r['geometry']] for r in rows], sort_keys=True, default=str).encode()).hexdigest()
    print('read-back digest', summary[:16])
    if '--boot' in sys.argv:
        import boot_checks
        boot_checks.run(official.rtos, image.rtos, image.icon_bytes, official.icon_bytes)


if __name__ == '__main__':
    main()
