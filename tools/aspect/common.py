# SPDX-License-Identifier: GPL-2.0-only
"""Shared set-up for the development-time aspect-ratio tools.

These scripts are NOT part of the program. They run the reference implementation
(DoYitNow/gr-custom-tool, GPL-2.0-only) on the developer's own copy of the official firmware and
turn what it produces into (a) constants and pre-compiled code for `core/src/fw/aspect/` and
(b) expected results for the tests. They need:

  GR_CUSTOM_TOOL   path of a gr-custom-tool checkout (commit 0c15c8f)
  GRMOD_OFFICIAL   path of the official fwdc248b.bin (1.11)
  clang / ld.lld / llvm-objcopy / llvm-nm with ARM support, Python packages unicorn and Pillow
"""
import os
import sys
from copy import deepcopy
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = Path(os.environ.get('GR_CUSTOM_TOOL', '/home/claude/work/gr-custom-tool'))
OFFICIAL = Path(os.environ.get('GRMOD_OFFICIAL', REPO / 'core/testdata/private/official.bin'))
os.environ.setdefault('GR4_EDITOR_DATA_DIR', str(REPO / 'tools/aspect/.refdata'))
sys.path.insert(0, str(TOOL))

from gr4_editor.firmware import load_image  # noqa: E402
from gr4_editor.crops import read_crops  # noqa: E402
from gr4_editor.crop_compiler import prepare_crops  # noqa: E402
from gr4_editor import demo_build  # noqa: E402

_cache = {}


def image():
    if 'image' not in _cache:
        _cache['image'] = load_image(OFFICIAL)
        _cache['crops'] = read_crops(_cache['image'].rtos)
    return _cache['image']


def official_crops():
    image()
    return _cache['crops']


def reference_build(ratios, with_plan=False):
    """Build with the reference from the official file. `ratios` is a list of (name, ratio text).

    Returns (rtos, iconbin, report[, plan]). The RTOS still carries the input version and ends with
    the reference's own JSON footer; `code_end(report)` gives where its code/data stop.
    """
    img = image()
    crops, _ = official_crops()
    desired = deepcopy(crops)
    for index, (name, ratio) in enumerate(ratios):
        desired.append({'id': f'new-{index}', 'kind': 'custom', 'identity': None, 'name': name,
                        'requested_ratio': ratio, 'editable': True})
    plan, inspection = prepare_crops(img.rtos, demo_build._metadata(img.rtos) or {}, desired, deepcopy(crops), None)
    rtos, icons, report = demo_build.build_features(img.rtos, img.icon_bytes, crop_plan=plan,
                                                    source_crop_inspection=inspection)
    return (rtos, icons, report, plan) if with_plan else (rtos, icons, report)


def code_end(report):
    """Offset in the RTOS image just past the last thing the reference's crop compiler appended."""
    identity = report['crops']['image_identity']
    context = None
    for change in identity['changes']:
        if change['address'] == '0x536cd414':
            word = int(change['after'], 16)
            displacement = word & 0xFFFFFF
            if displacement & 0x800000:
                displacement -= 1 << 24
            context = 0x536CD414 + 8 + displacement * 4
    assert context is not None
    return context + 8 - demo_build.BASE
