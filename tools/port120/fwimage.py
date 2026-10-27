# SPDX-License-Identifier: GPL-2.0-only
"""Decode the two official firmware files and give their RTOS images (development tool).

    GRMOD_OFFICIAL      official 1.11 fwdc248b.bin (default core/testdata/private/official.bin)
    GRMOD_OFFICIAL_120  official 1.20 fwdc248b.bin, the GR IV 1.20 / GR IV Monochrome 1.10 file
                        (default core/testdata/private/official-120.bin)

The decoded RTOS images are cached in tools/port120/.cache/.
"""
import hashlib
import os
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CACHE = HERE / '.cache'
BASE = 0x53000000
RAM_VA = 0x55000000

FILES = {
    '111': Path(os.environ.get('GRMOD_OFFICIAL', REPO / 'core/testdata/private/official.bin')),
    '120': Path(os.environ.get('GRMOD_OFFICIAL_120', REPO / 'core/testdata/private/official-120.bin')),
}
SHA256 = {
    '111': 'a2f664dfca034059eb0fd6e18ab08684c326b4a034d85c164dad7e1ec9b5655f',
    '120': '7563d7e462f0c53b6ab2fbab7cdfbbb57151a41192ee82f4f3a2108f9d77650d',
}
# Start-up copy of initialised data (RTOS image + 0x450: source, destination, length) and the
# end of the zero fill, as read from each file (checked in rtos()).
RAM = {
    '111': dict(src=0x5437B640, dst=RAM_VA, length=0x57480, bss_end=0x558372D4),
    '120': dict(src=0x543B3100, dst=RAM_VA, length=0x58500, bss_end=0x55839014),
}


def parse_frames(src):
    """The container's LZ stream (as core/src/fw/container.ts)."""
    out = bytearray()
    pos = 0x80
    n = len(src)
    while pos + 2 <= n:
        prefix = (src[pos] << 8) | src[pos + 1]
        pos += 2
        if prefix == 0:
            break
        end = pos + (prefix & 0x7FFF)
        if prefix & 0x8000:
            out += src[pos:end]
        else:
            while pos < end:
                flags = int.from_bytes(src[pos:pos + 2], 'big')
                pos += 2
                for bit in range(15, -1, -1):
                    if pos >= end:
                        break
                    if not (flags & (1 << bit)):
                        out.append(src[pos])
                        pos += 1
                        continue
                    first, second = src[pos], src[pos + 1]
                    pos += 2
                    dist = ((first & 0xF8) << 5) + second
                    cnt = first & 7
                    if cnt == 7:
                        ext = src[pos]
                        pos += 1
                        cnt += ext
                        while ext == 255:
                            ext = src[pos]
                            pos += 1
                            cnt += ext
                    if not dist:
                        break
                    st = len(out) - dist
                    for k in range(cnt + 3):
                        out.append(out[st + k])
        pos = end
    return bytes(out)


def sections(d):
    out = {}
    o = 0
    while o + 16 <= len(d):
        name = d[o:o + 8].rstrip(b'\0')
        if not name or not all(32 <= c < 127 for c in name):
            break
        size = struct.unpack_from('<I', d, o + 12)[0]
        out[name.decode()] = (o + 16, size)
        if name == b'RES':
            break
        o += 16 + size
    return out


def decoded(tag):
    cached = CACHE / f'{tag}.decoded'
    if cached.exists():
        return cached.read_bytes()
    raw = FILES[tag].read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA256[tag]:
        raise SystemExit(f'{FILES[tag]} is not the official {tag} file')
    d = parse_frames(raw)
    CACHE.mkdir(exist_ok=True)
    cached.write_bytes(d)
    return d


def rtos(tag):
    d = decoded(tag)
    off, size = sections(d)['RTOS']
    r = d[off:off + size]
    src, dst, length = struct.unpack_from('<3I', r, 0x450)
    ram = RAM[tag]
    assert (src, dst, length) == (ram['src'], ram['dst'], ram['length']), 'start-up data copy is not where expected'
    assert struct.unpack_from('<I', r, 0x460)[0] == ram['bss_end'], 'end of the zero fill is not as expected'
    return r


def iconbin(tag):
    d = decoded(tag)
    off, size = sections(d)['ICONBIN']
    return d[off:off + size]
