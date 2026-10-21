# SPDX-License-Identifier: GPL-2.0-only
"""Texts and icons of the camera in 1.11 and 1.20 (development tool).

    texts.py text ID [ID...]       the English text of these numbers in 1.11, and where it is in 1.20
    texts.py icon ID [ID...]       the icon of these numbers in 1.11, and the 1.20 number with the same pixels
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import amap  # noqa: E402
import fwimage  # noqa: E402

m = amap.Map()
ROOTS = 0x55002118
ENGLISH_ROW = 1  # as the program indexes languages (0 Japanese, 1 English, ...)
ICONS = {'A': 0x55013410, 'B': 0x55014280}
COUNTS = {'A': (837, 663), 'B': (881, 709)}


def text(tag, n):
    root = struct.unpack('<I', m.read(tag, ROOTS + 4 * ENGLISH_ROW, 4))[0]
    d = struct.unpack('<I', m.read(tag, root + 4 * n, 4))[0]
    units = m.read(tag, d, 1)[0]
    at = struct.unpack('<I', m.read(tag, d + 4, 4))[0]
    return m.read(tag, at, 2 * (units - 1)).decode('utf-16le')


def icon(tag, n, iconbin):
    d = struct.unpack('<I', m.read(tag, ICONS[tag] + 4 * n, 4))[0]
    kind, w, h, flags, off = struct.unpack('<4HI', m.read(tag, d, 12))
    return (w, h), iconbin[off * 4: off * 4 + w * h * 4]


def main():
    what, ids = sys.argv[1], [int(x, 0) for x in sys.argv[2:]]
    if what == 'text':
        allb = {}
        for n in range(COUNTS['B'][0]):
            try:
                allb.setdefault(text('B', n), []).append(n)
            except Exception:
                pass
        for n in ids:
            t = text('A', n)
            print('%4d %-40r -> 1.20 %s' % (n, t, allb.get(t, '-')))
    else:
        ia, ib = fwimage.iconbin('111'), fwimage.iconbin('120')
        byb = {}
        for n in range(COUNTS['B'][1]):
            try:
                size, px = icon('B', n, ib)
                byb.setdefault((size, px), []).append(n)
            except Exception:
                pass
        for n in ids:
            size, px = icon('A', n, ia)
            print('%4d %dx%d -> 1.20 %s' % (n, size[0], size[1], byb.get((size, px), '-')))


if __name__ == '__main__':
    main()
