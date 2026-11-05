# SPDX-License-Identifier: GPL-2.0-only
"""Read the HDR gain map's diagnostics from JPEGs written by a test build (hdrDiag).

    python3 readdiag.py PHOTO.JPG [PHOTO.JPG ...]      (or a folder: every .JPG in it)

Needs Python 3 only. For each file: whether it has a gain map, the APP15 "GRMODHDR" segment (files
whose blocks looked as expected) and the block after the camera's EOI, "GRMODHDT" (files written
as the camera's two blocks; diagnostics version 2), with every counter named. The same names as
`enum` in hdrgain.c.
"""
import os
import struct
import sys

NAMES = [
    'post_calls', 'post_ok', 'post_reason', 'post_dims', 'post_stream', 'post_slen', 'post_gmlen', 'post_fp',
] + [f'cfg_{0x38 + 4 * i:#04x}' for i in range(10)] + [
    f'cand{i}_{k}' for i in range(4) for k in ('desc', 'addr', 'len')
] + [
    'w_calls', 'w_match', 'w_reason', 'w_fp', 'w_dims', 'w_m', 'seq', 'kept',
    'exec', 'cnt', 'state_raw', 'state_by', 'state_at', 'lock_fail', 'tails', 'w_self', 'w_vt',
] + [f'w_{0x40 + 4 * i:#04x}' for i in range(21)]

POST_REASON = {0: 'gain map made', 1: 'started', 2: 'configuration not in RAM', 3: 'no main stream among the descriptors',
               4: 'no picture of the stream\'s size', 6: 'out of memory (encoder buffer)', 7: 'encoder failed',
               8: 'out of memory (gain map)', 9: 'lock not got', 10: 'no slot'}
W_REASON = {0: 'gain map written', 1: 'blocks not as expected', 2: 'header not SOI + APPn', 3: 'main stream not as expected',
            5: 'no gain map for this stream', 6: 'lock not got'}
STATE_BY = {0: '-', 1: 'encode step', 2: 'block count (the encode step never made it)'}


def words(payload, n):
    return list(struct.unpack_from(f'<{n}I', payload, 0))


def named(vals):
    d = {}
    for i, v in enumerate(vals):
        d[NAMES[i] if i < len(NAMES) else f'd{i}'] = v
    return d


def segments(b):
    out, i = [], 2
    while i + 4 <= len(b) and b[i] == 0xFF and b[i + 1] not in (0xDA, 0xD9):
        n = struct.unpack('>H', b[i + 2:i + 4])[0]
        out.append((b[i + 1], i, b[i + 4:i + 2 + n]))
        i += 2 + n
    return out


def read(path):
    b = open(path, 'rb').read()
    r = {'file': os.path.basename(path), 'bytes': len(b)}
    segs = segments(b)
    r['xmp_hdrgm'] = any(m == 0xE1 and b'hdrgm' in p for m, _, p in segs)
    r['mpf'] = any(m == 0xE2 and p.startswith(b'MPF\0') for m, _, p in segs)
    for m, _, p in segs:
        if m == 0xEF and p.startswith(b'GRMODHDR'):
            ver = p[9]
            n = (len(p) - 10) // 4
            r['app15'] = {'version': ver, **named(words(p[10:], n))}
    t = b.rfind(b'GRMODHDT')
    if t >= 0 and len(b) >= t + 16:
        ver, n = struct.unpack_from('<II', b, t + 8)
        if len(b) >= t + 16 + 4 * n:
            r['tail'] = {'version': ver, **named(words(b[t + 16:], n))}
    return r


def show(r):
    print(f"== {r['file']} ({r['bytes']} bytes)")
    print(f"   gain map metadata: XMP {'yes' if r['xmp_hdrgm'] else 'no'}, MPF {'yes' if r['mpf'] else 'no'}")
    for key, title in (('app15', 'APP15 GRMODHDR'), ('tail', 'after EOI GRMODHDT')):
        d = r.get(key)
        if not d:
            print(f'   {title}: none')
            continue
        print(f"   {title} (version {d['version']}):")
        ex = d.get('exec')
        cn = d.get('cnt')
        if ex is not None:
            print(f"     Execute entries {ex & 0xFFFF}, returns {ex >> 16}; block counts {cn & 0xFFFF}, block infos {cn >> 16}")
            # 0.8.9: with the camera-menu switch Off the encode step is not looked at (no module call)
            if (ex >> 16) > d['post_calls']:
                print(f"     pictures with HDR Off in the menu (encode step returned, module not called): {(ex >> 16) - d['post_calls']}")
        if 'state_by' in d:
            print(f"     state made by: {STATE_BY.get(d['state_by'], d['state_by'])}; word before: {d['state_raw']:#010x}; at {d['state_at']:#010x}; lock failures {d['lock_fail']}; tails {d['tails']}")
        print(f"     encode step: calls {d['post_calls']}, gain maps {d['post_ok']}, last: {POST_REASON.get(d['post_reason'], d['post_reason'])}")
        print(f"     writer: calls {d['w_calls']}, written with gain map {d['w_match']}, last: {W_REASON.get(d['w_reason'], d['w_reason'])}; kept {d['kept']}")
        for k, v in d.items():
            if k == 'version':
                continue
            print(f'       {k:14s} {v:#010x}  {v}')


def main():
    paths = []
    for a in sys.argv[1:] or ['.']:
        if os.path.isdir(a):
            paths += sorted(os.path.join(a, f) for f in os.listdir(a) if f.lower().endswith('.jpg'))
        else:
            paths.append(a)
    for p in paths:
        show(read(p))


if __name__ == '__main__':
    main()
