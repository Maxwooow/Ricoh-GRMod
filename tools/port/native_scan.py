# SPDX-License-Identifier: GPL-2.0-only
"""Look for firmware addresses inside the pre-compiled modules of a port (development tool).

    python3 tools/port/native_scan.py MAP.json FILE.ts ...

The address check of generate.py reads source text; a compiled module (base64 in *-code.ts,
native.ts, *-native.ts) can still carry an address of the old firmware in a movw/movt pair or a
literal word when it was compiled from the wrong source. Every such value is listed; one that is an
old address the map moves (and not also a valid new one) fails the scan.
"""
import base64, json, re, struct, sys

table = json.load(open(sys.argv[1]))['addresses']
valid = {int(e['new'], 16) for e in table.values() if e.get('ok') and e.get('new')}
moved = {int(k, 16) for k, e in table.items() if e.get('new') and int(e['new'], 16) != int(k, 16)} - valid
bad = 0
for f in sys.argv[2:]:
    for blob in re.findall(r'"code":"([A-Za-z0-9+/=]+)"|= \'([A-Za-z0-9+/=]{64,})\'', open(f).read()):
        code = base64.b64decode(blob[0] or blob[1]); w = struct.unpack('<%dI' % (len(code) // 4), code[:len(code) // 4 * 4])
        imm = lambda x: ((x >> 4) & 0xf000) | (x & 0xfff)
        values = set()
        for i, x in enumerate(w):
            if 0x53000000 <= x < 0x56000000: values.add(x)
            if (x & 0x0ff00000) == 0x03000000 and x >> 28 != 0xf:
                for k in range(1, 7):
                    if i + k < len(w) and (w[i + k] & 0x0ff00000) == 0x03400000 and ((w[i + k] >> 12) & 15) == ((x >> 12) & 15):
                        v = imm(w[i + k]) << 16 | imm(x)
                        if 0x53000000 <= v < 0x56000000: values.add(v)
                        break
        for v in sorted(values & moved):
            bad += 1; print(f'{f}: old address {v:#x} in a compiled module')
print('compiled modules scanned:', 'no old address' if not bad else f'{bad} old addresses')
sys.exit(1 if bad else 0)
