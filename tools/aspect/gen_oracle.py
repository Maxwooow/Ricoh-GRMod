# SPDX-License-Identifier: GPL-2.0-only
"""Run the reference crop compiler over many configurations and record what it produced.

  python3 gen_oracle.py single [start [stop]]   every possible screen geometry, one ratio each (299)
  python3 gen_oracle.py multi N [seed]          N random lists of 1..8 ratios with assorted names
  python3 gen_oracle.py valid N [seed]          N random lists of 2..8 ratios that are each buildable
  python3 gen_oracle.py fixture                 merge the logs into core/test/fw-helpers/aspect-oracle.json

Results are appended to tools/aspect/out/*.jsonl as they finish, so a run can be interrupted and
resumed. For each configuration the log holds either the reference's error message or the SHA-256
of what it changed: the patched words inside the official image and everything it appended up to
the end of its last code blob (its own JSON footer after that is not part of the comparison).
The appended bytes themselves are kept (zlib) under out/blobs/ for debugging; they contain copies
of pointer tables from the firmware and are not committed.
"""
import hashlib
import json
import random
import struct
import sys
import zlib
from pathlib import Path

import common

OUT = Path(__file__).resolve().parent / 'out'
OFFICIAL_RTOS = 0x13D2AC0


def screens():
    return [(720, h) for h in range(4, 481, 4)] + [(w, 480) for w in range(4, 720, 4)]


def describe(rtos, icons, report):
    end = common.code_end(report)
    official = common.image().rtos
    assert len(official) == OFFICIAL_RTOS and end > OFFICIAL_RTOS and end % 4 == 0
    words = []
    for offset in range(0, OFFICIAL_RTOS, 4):
        if rtos[offset:offset + 4] != official[offset:offset + 4]:
            words.append((offset, struct.unpack_from('<I', rtos, offset)[0]))
    patch_blob = b''.join(struct.pack('<II', offset, value) for offset, value in words)
    appended = bytes(rtos[OFFICIAL_RTOS:end])
    custom = report['crops']['icons']['custom']
    return {
        'ok': True,
        'end': end,
        'patched_words': len(words),
        'patched_sha256': hashlib.sha256(patch_blob).hexdigest(),
        'appended_sha256': hashlib.sha256(appended).hexdigest(),
        'icon_growth': len(icons) - len(common.image().icon_bytes),
        'icon_ids': [row['icon_id'] for row in custom],
        'icon_offsets': [row['offset'] for row in custom],
        'actual': [row['actual_ratio'] for row in report['crops']['crops'][4:]],
        'sizes': [[size['width'], size['height']] for size in report['crops']['crops'][-1]['geometry']['photo_sizes']
                  if size['model'] == 'Kb636' and size['magnification'] == 1.0],
    }, patch_blob, appended


def run(key, ratios, log):
    try:
        rtos, icons, report = common.reference_build(ratios)
        row, patch_blob, appended = describe(rtos, icons, report)
        blobs = OUT / 'blobs'
        blobs.mkdir(parents=True, exist_ok=True)
        (blobs / (key + '.bin')).write_bytes(zlib.compress(struct.pack('<I', len(patch_blob)) + patch_blob + appended, 6))
    except ValueError as exc:
        row = {'ok': False, 'error': str(exc)}
    row = {'key': key, 'ratios': [list(item) for item in ratios], **row}
    with open(log, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    print(key, 'ok' if row['ok'] else 'REJECTED ' + row['error'], flush=True)


def done(log):
    if not log.exists():
        return set()
    return {json.loads(line)['key'] for line in log.read_text(encoding='utf-8').splitlines() if line.strip()}


NAME_POOL = ['XPan', '65:24', 'Scope', '2.39:1', 'A', 'Wide screen 70', 'IMAX', '6x7', 'Poly 3.1', 'x', 'Cinema-Scope-235',
             'four-thirds?', '5:4', '7:6', '6:17', 'Pano', 'Square+', 'Tall', 'a b c', '0123456789', 'R']
RATIO_POOL = ['65:24', '2.39:1', '2.35:1', '16:10', '5:4', '7:6', '6:7', '4:5', '2:1', '1.85:1', '3:1', '6:17', '17:6', '1.9',
              '2.76:1', '1.375:1', '2.2:1', '8:7', '9:16', '2:3', '3:4', '1.43:1', '21:9', '18:9', '1.66:1', '5:3', '2.55:1',
              '1.19:1', '11:8.5', '1.5:1', '1:1', '16:9', '4:3', '3:2', '720:264', '700:480']


def multi_cases(count, seed):
    rng = random.Random(seed)
    cases = []
    while len(cases) < count:
        size = rng.choice([1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8])
        ratios = []
        for _ in range(size):
            if rng.random() < 0.25:
                width, height = rng.choice(screens())
                ratio = f'{width}:{height}'
            else:
                ratio = rng.choice(RATIO_POOL)
            name = ratio if rng.random() < 0.5 else rng.choice(NAME_POOL)
            ratios.append((name, ratio))
        cases.append(ratios)
    return cases


def valid_cases(count, seed):
    """Lists made only of ratios the single run accepted, so that most lists build (long ones too)."""
    rng = random.Random(1000 + seed)
    good = []
    for line in (OUT / 'single.jsonl').read_text(encoding='utf-8').splitlines():
        row = json.loads(line)
        if row['ok'] and row['ratios'][0][1] not in ('720:480', '640:480', '480:480'):
            good.append(row['ratios'][0][1])
    extra = ['65:24', '2.39:1', '2.35:1', '16:10', '5:4', '7:6', '6:7', '4:5', '2:1', '6:17', '17:6', '21:9', '5:3', '2:3', '3:4', '9:16']
    cases = []
    while len(cases) < count:
        size = rng.choice([2, 3, 4, 5, 6, 7, 8, 8])
        ratios = []
        for _ in range(size):
            ratio = rng.choice(extra) if rng.random() < 0.4 else rng.choice(good)
            name = ratio if rng.random() < 0.5 else rng.choice(NAME_POOL)
            ratios.append((name, ratio))
        cases.append(ratios)
    return cases


def fixture():
    rows = []
    for name in ('single', 'multi', 'valid'):
        log = OUT / (name + '.jsonl')
        if log.exists():
            rows += [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines() if line.strip()]
    target = common.REPO / 'core/test/fw-helpers/aspect-oracle.json'
    target.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(len(rows), 'cases ->', target)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    mode = sys.argv[1]
    if mode == 'single':
        log = OUT / 'single.jsonl'
        seen = done(log)
        todo = screens()[int(sys.argv[2]) if len(sys.argv) > 2 else 0:int(sys.argv[3]) if len(sys.argv) > 3 else None]
        for width, height in todo:
            key = f's{width}x{height}'
            if key not in seen:
                text = f'{width}:{height}'
                run(key, [(text, text)], log)
    elif mode == 'multi':
        log = OUT / 'multi.jsonl'
        seen = done(log)
        seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        for index, ratios in enumerate(multi_cases(int(sys.argv[2]), seed)):
            key = f'm{seed}-{index}'
            if key not in seen:
                run(key, ratios, log)
    elif mode == 'valid':
        log = OUT / 'valid.jsonl'
        seen = done(log)
        seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        for index, ratios in enumerate(valid_cases(int(sys.argv[2]), seed)):
            key = f'v{seed}-{index}'
            if key not in seen:
                run(key, ratios, log)
    elif mode == 'fixture':
        fixture()
    else:
        raise SystemExit(__doc__)
