# SPDX-License-Identifier: GPL-2.0-only
"""Look up the block map of `addrmap.py`: 1.11 address -> 1.20 address (development tool)."""
import bisect
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwimage  # noqa: E402

BASE = fwimage.BASE


class Map:
    def __init__(self):
        path = fwimage.CACHE / 'map.json'
        if not path.exists():
            import addrmap
            addrmap.build()
        mp = json.loads(path.read_text())
        self.A = fwimage.rtos('111')
        self.B = fwimage.rtos('120')
        self.ra, self.rb = fwimage.RAM['111'], fwimage.RAM['120']
        self.blocks = sorted(tuple(x) for x in mp['blocks'])
        self.starts = [x[0] for x in self.blocks]
        self.rev = sorted((b, a, n) for a, b, n in self.blocks)
        self.rev_starts = [x[0] for x in self.rev]
        self.bss = sorted(tuple(x) for x in mp['bss'])
        self.bss_keys = [p[0] for p in self.bss]

    # ---- reading
    def _img(self, tag, va):
        r = self.ra if tag == 'A' else self.rb
        if r['dst'] <= va < r['dst'] + r['length']:
            return r['src'] + va - r['dst']
        return va

    def read(self, tag, va, n):
        buf = self.A if tag == 'A' else self.B
        o = self._img(tag, va) - BASE
        if not (0 <= o and o + n <= len(buf)):
            return None
        return buf[o:o + n]

    def wa(self, va):
        return struct.unpack('<I', self.read('A', va, 4))[0]

    def wb(self, va):
        return struct.unpack('<I', self.read('B', va, 4))[0]

    # ---- mapping
    def block_of(self, img_a):
        i = (img_a - BASE) // 4
        k = bisect.bisect_right(self.starts, i) - 1
        if k >= 0:
            s_a, s_b, n = self.blocks[k]
            if s_a <= i < s_a + n:
                return self.blocks[k]
        return None

    def _map_img(self, va):
        blk = self.block_of(va & ~3)
        if blk is None:
            return None
        s_a, s_b, n = blk
        return BASE + s_b * 4 + (va - BASE - s_a * 4)

    def map(self, va):
        """A 1.11 address in 1.20, or None."""
        ra, rb = self.ra, self.rb
        if ra['dst'] <= va < ra['dst'] + ra['length']:
            q = self._map_img(ra['src'] + va - ra['dst'])
            if q is None or not (rb['src'] <= q < rb['src'] + rb['length']):
                return None
            return rb['dst'] + q - rb['src']
        if ra['dst'] + ra['length'] <= va < 0x56000000:
            k = bisect.bisect_right(self.bss_keys, va) - 1
            if k < 0:
                return None
            a, d = self.bss[k]
            if a == va or (k + 1 < len(self.bss) and self.bss[k + 1][1] == d):
                return va + d
            return None
        if BASE <= va < BASE + len(self.A):
            return self._map_img(va)
        return None

    def back(self, vb):
        """A 1.20 address in 1.11, or None."""
        ra, rb = self.ra, self.rb
        if rb['dst'] <= vb < rb['dst'] + rb['length']:
            q = self.back(rb['src'] + vb - rb['dst'])
            if q is None or not (ra['src'] <= q < ra['src'] + ra['length']):
                return None
            return ra['dst'] + q - ra['src']
        if not (BASE <= vb < BASE + len(self.B)):
            for a, d in self.bss:
                if a + d == vb:
                    return a
            return None
        i = (vb - BASE) // 4
        k = bisect.bisect_right(self.rev_starts, i) - 1
        if k < 0:
            return None
        s_b, s_a, n = self.rev[k]
        if s_b <= i < s_b + n:
            return BASE + (s_a + (i - s_b)) * 4 + (vb & 3)
        return None
