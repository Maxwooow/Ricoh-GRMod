# SPDX-License-Identifier: GPL-2.0-only
"""The firmware an RTOS image is of, for the emulator checks (development tool).

The checks are written with the addresses of 1.11, like the patcher; `V(address)` gives the
address in the firmware of the image being checked: the identity for 1.11, for 1.20 the entry of
core/src/fw/target120.ts, or (for an address only a check uses) the block map of addrmap.py when
the word there is the same in both files or the same up to relocation. Anything else is an error.

    import fwtarget
    T = fwtarget.select(official_rtos)     # the official RTOS image of the file being checked
    V = fwtarget.V
"""
import re
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BASE = 0x53000000


class Target:
    def __init__(self, tag, rtos_len, ram_src, ram_len, bss_end, heap, icons, texts, icon_form, live_view_shift,
                 texts_own, camera_texts, camera_icons, list_records, submenu_records, jpeg_count, user_data,
                 text_table, text_stride, user_data_size):
        self.tag = tag
        self.rtos_len = rtos_len
        self.ram_src = ram_src
        self.ram_len = ram_len
        self.bss_end = bss_end
        self.heap = heap
        self.icons = icons
        self.texts = texts
        self.icon_form = icon_form
        self.live_view_shift = live_view_shift
        self.texts_own = texts_own
        self.camera_texts = camera_texts
        self.camera_icons = camera_icons
        self.list_records = list_records
        self.submenu_records = submenu_records
        self.jpeg_count = jpeg_count
        self.user_data = user_data
        self.text_table = text_table
        self.text_stride = text_stride
        self.user_data_size = user_data_size
        # this program's relocated icon catalog and language rows (build.ts `catalogs`)
        self.icon_catalog = BASE + rtos_len + 0x1000
        self.text_catalog = BASE + rtos_len + 0x2000


# The facts of core/src/fw/target.ts.
T111 = Target('111', 0x13D2AC0, 0x5437B640, 0x57480, 0x558372D4, 0x55837300, 663, 837, 'movw', 0,
              {'softFocus': 840, 'dateStamp': (841, 842, 843, 844, 845), 'shutdown': 853},
              {'on': 1, 'off': 2, 'low': 9, 'medium': 10, 'high': 11, 'flashComp': 135, 'endScreen': 701, 'dRange': 363, 'horizon': 388, 'reset': 703, 'type1': 6, 'type2': 7},
              {'off': 310, 'on': 311}, 124, 18, 12, 0x55084DD8, 0x5437D7B0, 0xD14, 0xAE9)
T120 = Target('120', 0x140B600, 0x543B3100, 0x58500, 0x55839014, 0x55839040, 709, 881, 'cmp', 0x14,
              {'softFocus': 912, 'dateStamp': (913, 914, 915, 916, 917), 'shutdown': 918},
              {'on': 1, 'off': 2, 'low': 10, 'medium': 11, 'high': 12, 'flashComp': 140, 'endScreen': 743, 'dRange': 395, 'horizon': 420, 'reset': 745, 'type1': 7, 'type2': 8},
              {'off': 329, 'on': 330}, 126, 18, 13, 0x550832A8, 0x543B5270, 0xDC4, 0xB44)
# TargetFacts.looks / monoLooks: the camera's own looks are 0 .. looks - 1; its black-and-white ones.
T111.looks, T111.mono_looks = 31, (13, 14, 15, 16, 25, 26, 27, 28, 29, 30)
T120.looks, T120.mono_looks = 33, (13, 14, 15, 16, 25, 26, 27, 28, 29, 30, 31, 32)

_active = T111
_table = None
_map = None

# Addresses only the checks use, found with look.py (1.11: (1.20, why)).
CHECK_ONLY = {
    0x533E033C: (0x533F1DC8, 'SpecModel: is function n valid (cmp r1, #10 in 1.11, #12 in 1.20), through six of its seven callers'),
}


def detect(rtos):
    """The target of an RTOS image (official or built from it): by its start-up data copy."""
    src = struct.unpack_from('<I', rtos, 0x450)[0]
    for t in (T111, T120):
        if src == t.ram_src:
            return t
    raise SystemExit('not an RTOS image of 1.11 or 1.20')


def select(rtos):
    global _active
    _active = detect(rtos)
    return _active


def active():
    return _active


def table():
    global _table
    if _table is None:
        text = (REPO / 'core/src/fw/target120.ts').read_text()
        _table = {int(a, 16): int(b, 16) for a, b in re.findall(r'\[0x([0-9a-f]{8}), 0x([0-9a-f]{8})\]', text)}
    return _table


def V(address):
    """A 1.11 address in the active firmware."""
    if _active is T111:
        return address
    t = table()
    if address in t:
        return t[address]
    if address in CHECK_ONLY:
        return CHECK_ONLY[address][0]
    global _map
    if _map is None:
        sys.path.insert(0, str(HERE))
        import amap
        _map = amap.Map()
    q = _map.map(address)
    if q is None and 0x55000000 <= address < 0x56000000:
        q = _bss_by_references(address)
    if q is None:
        raise KeyError('0x%08x has no place in 1.20' % address)
    wa, wb = _map.read('A', address, 4), _map.read('B', q, 4)
    if wa is not None and wb is not None and wa != wb:
        # the same up to relocation: a branch to the mapped target, or a mapped pointer
        a, b = struct.unpack('<I', wa)[0], struct.unpack('<I', wb)[0]
        ok = False
        if (a >> 25) & 7 == 5 and (b >> 25) & 7 == 5 and a >> 24 == b >> 24:
            def target(at, w):
                d = w & 0xFFFFFF
                return at + 8 + (d - (1 << 24) if d & 0x800000 else d) * 4
            ok = _map.map(target(address, a)) == target(q, b)
        elif 0x53000000 <= a < 0x56000000:
            ok = _map.map(a) == b
        elif (a & 0x0FF00000) in (0x03000000, 0x03400000):
            # half of an address loaded with MOVW/MOVT: the same instruction and register (the
            # block map placed it among words that agree)
            ok = (a & 0xFFF0F000) == (b & 0xFFF0F000)
        if not ok:
            raise KeyError('0x%08x maps to 0x%08x, but the words differ' % (address, q))
    return q


_pairs = None


def _movw_pairs(buf):
    """{value: [address of the MOVW]} of the MOVW/MOVT pairs (same register, MOVT within 8 words) of an image."""
    import numpy as np
    w = np.frombuffer(buf[:len(buf) // 4 * 4], dtype='<u4').astype(np.int64)
    n = len(w)
    movw = (w & 0x0FF00000) == 0x03000000
    movt = (w & 0x0FF00000) == 0x03400000
    rd = (w >> 12) & 15
    val = ((w >> 4) & 0xF000) | (w & 0xFFF)
    out = {}
    for d in range(8, 0, -1):
        hit = np.nonzero(movw[:-d] & movt[d:] & (rd[:-d] == rd[d:]))[0]
        for i in hit.tolist():
            out[i] = int(val[i]) | (int(val[i + d]) << 16)
    by_value = {}
    for i, v in out.items():
        by_value.setdefault(v, []).append(BASE + 4 * i)
    return by_value


def _bss_by_references(address):
    """A RAM address of 1.11 in 1.20 through the code that loads it: every MOVW/MOVT pair of 1.11
    with that value whose place maps to 1.20 must load one and the same value there."""
    global _pairs
    if _pairs is None:
        _pairs = (_movw_pairs(_map.A), _movw_pairs(_map.B))
    a_pairs, b_pairs = _pairs
    b_at = {}
    for value, sites in b_pairs.items():
        for site in sites:
            b_at[site] = value
    votes = set()
    for site in a_pairs.get(address, []):
        q = _map.map(site)
        if q is not None and q in b_at:
            votes.add(b_at[q])
    return votes.pop() if len(votes) == 1 else None


def V_all(addresses):
    return [V(a) for a in addresses]
