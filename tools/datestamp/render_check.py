# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the date imprint module (core/src/fw/aspect/datestamp-code.ts).

NOT part of the program. Runs the compiled module in Unicorn on synthetic pictures laid out like the
camera's (main picture as a window of the 6208-wide sensor buffer, 720x480 screennail and 160x120
thumbnail with black bars) for every value of the setting byte, and checks:

  - settings 0/2/4/6 and anything above 7 draw nothing;
  - settings 1/3/5/7 draw short date, long date, short date + LUT name, or short date / LUT name;
  - names use the captured style stash, never a subsequently changed live setting;
  - missing/invalid names or stash fall back to short date, without a dangling slash;
  - imprints stay inside every photo, preserve orange/neutral chroma, and synchronize caches;
  - an invalid clock draws nothing and RAW+JPEG buffer address checks remain enforced.

    python3 render_check.py [OUTDIR]     # OUTDIR: also writes a PNG per scenario

Needs the Python packages unicorn and Pillow.
"""
import base64
import re
import struct
import sys
from pathlib import Path

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_SP, UC_ARM_REG_LR

ROOT = Path(__file__).resolve().parents[2]
TS = (ROOT / 'core/src/fw/aspect/datestamp-code.ts').read_text()
CODE = base64.b64decode(re.search(r"DATESTAMP_CODE = '([^']+)'", TS).group(1))
ORG = 0x10000
STRIDE, BUF_H = 6208, 4128


def test_font():
    """Deterministic ABI fixture: fixed 16x24 cells, including partial coverage.

    This deliberately does not depend on the host's installed fonts. Equal-length
    names still differ visibly, and space has no ink, just as in the native font.
    """
    return bytes(0 if ch == 32 or not (2 <= x < 14 and 2 <= y < 22)
                 else 128 if x in (2, 13) or y in (2, 21)
                 else 255 if y in (3, 20) or (ch >> ((x - 3) // 2) & 1) else 0
                 for ch in range(32, 127) for y in range(24) for x in range(16))


FONT_SOURCE = (ROOT / 'core/src/fw/aspect/datestamp-font.ts').read_text()
FONT = base64.b64decode(re.search(r"DATESTAMP_FONT_BASE64 = '([^']+)'", FONT_SOURCE).group(1))
assert len(FONT) == 95 * 24 * 16


def run(setting, main_w, main_h, src_w, src_h, mono=False, clock=(2026, 10, 8, 17, 34, 53),
        base=0x80000000, *, style=5, valid=True, name='Positive Film',
        live_style=99, compact=False, stash_present=True, names_present=True, font_present=True):
    stride, buf_h = (736, 480) if compact else (STRIDE, BUF_H)
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(ORG, 0x10000)
    mu.mem_write(ORG, CODE)
    mu.mem_map(0x60000000, 0x100000)
    mu.mem_map(0x70000000, 0x100000)
    YA = base
    CA = YA + stride * buf_h
    mu.mem_map(YA, (stride * buf_h * 2 + 0xfff) & ~0xfff)
    mu.mem_write(YA, bytes([70]) * (stride * buf_h))
    chroma = bytes([128, 128]) * (stride * buf_h // 2) if mono else bytes([120, 140]) * (stride * buf_h // 2)
    mu.mem_write(CA, chroma)
    PV = 0x90000000
    mu.mem_map(PV, 0x200000)
    TH = 0x92000000
    mu.mem_map(TH, 0x20000)

    def fit(W, H):
        if W * src_h > H * src_w:
            rw, rh = H * src_w // src_h, H
        else:
            rw, rh = W, W * src_h // src_w
        return (W - rw) // 2, (H - rh) // 2, rw, rh

    pv = bytearray(736 * 480)
    pc = bytearray(bytes([128]) * (736 * 480))
    x, y, rw, rh = fit(720, 480)
    for yy in range(y, y + rh):
        pv[yy * 736 + x:yy * 736 + x + rw] = bytes([120]) * rw
        if not mono:
            pc[yy * 736 + x:yy * 736 + x + rw] = bytes([120, 140]) * (rw // 2)
    mu.mem_write(PV, bytes(pv))
    mu.mem_write(PV + 0x100000, bytes(pc))
    tv = bytearray(160 * 120)
    tc = bytearray(bytes([128]) * (160 * 120))
    x2, y2, rw2, rh2 = fit(160, 120)
    for yy in range(y2, y2 + rh2):
        tv[yy * 160 + x2:yy * 160 + x2 + rw2] = bytes([120]) * rw2
        if not mono:
            tc[yy * 160 + x2:yy * 160 + x2 + rw2] = bytes([120, 140]) * (rw2 // 2)
    mu.mem_write(TH, bytes(tv))
    mu.mem_write(TH + 0x8000, bytes(tc))

    STUB = 0x70000000
    for i in range(5):
        mu.mem_write(STUB + i * 16, struct.pack('<I', 0xe12fff1e))  # bx lr

    cache_calls = []

    def hook(uc, addr, size, ud):
        i = (addr - STUB) // 16
        if i in (1, 2):
            cache_calls.append((i, uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)))
        if i == 0:
            uc.reg_write(UC_ARM_REG_R0, 0x553a09c4)
        if i == 3:
            uc.reg_write(UC_ARM_REG_R0, 0x70001000)
        if i == 4:
            uc.mem_write(uc.reg_read(UC_ARM_REG_R1), struct.pack('<HBBBBB', *clock))
    mu.hook_add(UC_HOOK_CODE, hook, begin=STUB, end=STUB + 0x50)
    mu.mem_write(0x70001004, struct.pack('<I', 0x70002000))
    SET = 0x70003000
    mu.mem_write(SET, bytes([setting]))
    CTX = 0x70004000
    STASH, NAMES, NAME, FONT_ADDR = 0x70007000, 0x70008000, 0x70009000, 0x70010000
    mu.mem_write(STASH, struct.pack('<I', (style & 255) | (int(valid) << 16)))
    # Keep a deliberately stale live style beside the actual setting byte. Only the
    # capture stash is authoritative; a LUT lookup must not use this live value.
    mu.mem_write(SET + 1, bytes([live_style & 255]))
    if name is not None:
        raw_name = name.encode('ascii') if isinstance(name, str) else name
        mu.mem_write(NAME, raw_name + b'\0')
        mu.mem_write(NAMES + (style & 255) * 4, struct.pack('<I', NAME))
    mu.mem_write(FONT_ADDR, FONT)
    mu.mem_write(CTX, struct.pack('<9I', *(STUB + i * 16 for i in range(5)), SET,
                                 STASH if stash_present else 0, NAMES if names_present else 0,
                                 FONT_ADDR if font_present else 0))

    ox = 0 if compact else ((6192 - src_w) // 2) & ~1
    oy = 0 if compact else (4128 - src_h) // 2
    WY = YA + oy * stride + ox
    WC = CA + oy * stride + ox

    def desc(a, yp, cp, w, h, stride, ch):
        mu.mem_write(a, struct.pack('<B3xIII HHHH HH 4x', 1, yp, cp, 0, w, h, stride, ch, 0, 0))
    D = 0x70005000
    desc(D, WY, WC, main_w, main_h, stride, buf_h)
    desc(D + 0x20, PV, PV + 0x100000, 720, 480, 736, 480)
    desc(D + 0x40, TH, TH + 0x8000, 160, 120, 160, 120)
    desc(D + 0x60, WY, WC, src_w, src_h, stride, buf_h)
    CFG = 0x70006000
    mu.mem_write(CFG + 0x3c, struct.pack('<4I', D, D + 0x20, D + 0x40, D + 0x60))
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
    mu.reg_write(UC_ARM_REG_LR, 0x70000ff0)
    mu.reg_write(UC_ARM_REG_R0, CTX)
    mu.reg_write(UC_ARM_REG_R1, CFG)
    mu.emu_start(ORG, 0x70000ff0, count=800_000_000)
    main = [bytes(mu.mem_read(WY + r * stride, main_w)) for r in range(main_h)]
    mainc = [bytes(mu.mem_read(WC + r * stride, main_w)) for r in range(main_h)]
    preview = bytes(mu.mem_read(PV, 736 * 480))
    previewc = bytes(mu.mem_read(PV + 0x100000, 736 * 480))
    thumb = bytes(mu.mem_read(TH, 160 * 120))
    thumbc = bytes(mu.mem_read(TH + 0x8000, 160 * 120))
    # Count changes in the complete sensor plane as well as the encoded window:
    # drawing the duplicate full-size descriptor would otherwise go unnoticed.
    plane = bytes(mu.mem_read(YA, stride * buf_h))
    guards_ok = len(plane) - plane.count(70) == sum(len(row) - row.count(70) for row in main)
    return {'main': main, 'mainc': mainc, 'preview': preview, 'previewc': previewc, 'thumb': thumb,
            'thumbc': thumbc, 'cache': cache_calls, 'guards_ok': guards_ok,
            'planes': ((WY, WC, stride, main_w, main_h), (PV, PV + 0x100000, 736, 720, 480),
                       (TH, TH + 0x8000, 160, 160, 120)),
            'fits': (fit(720, 480), fit(160, 120))}


def bbox_rows(rows, w, base):
    xs, ys = [], []
    for yy, row in enumerate(rows):
        for xx in range(w):
            if row[xx] != base:
                xs.append(xx)
                ys.append(yy)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def bbox_flat(buf, stride, w, h, base, area):
    x0, y0, rw, rh = area
    xs, ys = [], []
    for yy in range(h):
        row = buf[yy * stride:yy * stride + w]
        for xx in range(w):
            inside = x0 <= xx < x0 + rw and y0 <= yy < y0 + rh
            want = base if inside else 0
            if row[xx] != want:
                xs.append(xx)
                ys.append(yy)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def check_render(r, label, failures, *, draw=True):
    mw, mh = r['planes'][0][3:]
    boxes = (bbox_rows(r['main'], mw, 70),
             bbox_flat(r['preview'], 736, 720, 480, 120, r['fits'][0]),
             bbox_flat(r['thumb'], 160, 160, 120, 120, r['fits'][1]))
    areas = ((0, 0, mw, mh), *r['fits'])
    if not r['guards_ok']:
        failures.append(f'{label}: changed pixels outside main photo / duplicate descriptor')
    invalidated = set()
    for kind, addr, size in r['cache']:
        if addr % 64 or size <= 0 or size % 64:
            failures.append(f'{label}: unaligned cache operation {(kind, addr, size)}')
        if kind == 1:
            invalidated.add((addr, size))
        elif (addr, size) not in invalidated:
            failures.append(f'{label}: clean without matching prior invalidate {(addr, size)}')
    for box, area, plane in zip(boxes, areas, r['planes']):
        if not draw:
            if box:
                failures.append(f'{label}: disabled imprint drew {box}')
            continue
        if not box:
            failures.append(f'{label}: missing imprint')
            continue
        x, y, w, h = area
        # A 58-pixel-high XPan thumbnail keeps the legacy 7-pixel minimum glyph and
        # 10-pixel margin; its top can sit just above the last quarter of the image.
        if not (x <= box[0] <= box[2] < x + w and y + h // 2 <= box[1] <= box[3] < y + h):
            failures.append(f'{label}: imprint outside photo/bottom edge {box} in {area}')
        # Long names may extend left of the photo midpoint as height adapts.
        for addr in plane[:2]:
            first = addr + box[1] * plane[2]
            last = addr + box[3] * plane[2] + plane[3]
            if not any(kind == 2 and start <= first and start + size >= last
                       for kind, start, size in r['cache']):
                failures.append(f'{label}: drawn rows lack cache clean for plane {addr:#x}')
    if not draw and any(kind == 2 for kind, _, _ in r['cache']):
        failures.append(f'{label}: disabled imprint cleaned a picture')
    return boxes


def pixels(r):
    return tuple(r[key] for key in ('main', 'mainc', 'preview', 'previewc', 'thumb', 'thumbc'))


def compact_checks(failures):
    def render(setting, **kwargs):
        return run(setting, 720, 480, 720, 480, compact=True, **kwargs)

    short = render(1)
    # Baselines captured before unifying the two LUT styles' typography.
    import hashlib
    legacy_hashes = {1: '63eb83ea9c5de3baf4e669ecbf5dc9af18a4b006c2338f2c21332ca6afaba608',
                     3: '30af4ebd4aad3301eb7bb2551e8078c0ee7023caca97ed1561c6ccd7dbe716ff'}
    for legacy, expected in legacy_hashes.items():
        result = short if legacy == 1 else render(legacy)
        raw = b''.join(b''.join(plane) if isinstance(plane, list) else plane for plane in pixels(result))
        if hashlib.sha256(raw).hexdigest() != expected:
            failures.append(f'legacy style {legacy}: pixels changed from pre-typewriter baseline')
    check_render(short, 'compact short', failures)
    off = render(0)
    check_render(off, 'compact off baseline', failures, draw=False)
    for setting in (*range(0, 8, 2), *range(8, 256)):
        r = render(setting)
        if pixels(r) != pixels(off) or not r['guards_ok']:
            failures.append(f'compact off {setting}: changed luma or chroma')
        if any(kind == 2 for kind, _, _ in r['cache']):
            failures.append(f'compact off {setting}: cleaned a picture')
    for setting in (5, 7):
        date_only = render(setting, name=None)
        check_render(date_only, f'compact {setting} typewriter date', failures)
        if pixels(date_only) == pixels(short):
            failures.append(f'compact {setting}: date still uses legacy seven-segment glyphs')
        for mono in (False, True):
            r = render(setting, mono=mono)
            boxes = check_render(r, f'compact {setting} mono={mono}', failures)
            # Fully covered pixels in both font and date must share the same chroma.
            # Compare all such pairs, rather than one point on the middle row.
            chroma = set()
            for row, crow in zip(r['main'], r['mainc']):
                for x in range(0, 720, 2):
                    if row[x] == 150 and row[x + 1] == 150:
                        chroma.add(tuple(crow[x:x + 2]))
            want = (128, 128) if mono else (56, 204)
            if chroma != {want}:
                failures.append(f'compact {setting} mono={mono}: covered chroma {chroma}, expected {want}')
            if mono and any(row != bytes([128]) * 720 for row in r['mainc']):
                failures.append(f'compact {setting}: mono acquired chroma')
        a = render(setting, name='AAAA')
        b = render(setting, name='BBBB')
        if pixels(a) == pixels(b):
            failures.append(f'compact {setting}: changing LUT name did not change pixels')
        if pixels(a) != pixels(render(setting, name='AAAA', live_style=1)):
            failures.append(f'compact {setting}: stale live style changed imprint')
        for kwargs in ({'valid': False}, {'stash_present': False}, {'names_present': False},
                       {'name': None}, {'name': ''}, {'name': b'Bad\x1fname'},
                       {'name': b'Bad\x7fname'}):
            r = render(setting, **kwargs)
            if pixels(r) != pixels(date_only):
                failures.append(f'compact {setting}: fallback differs from short date: {kwargs}')
        # Unknown styles have null LUT entries; all 256 entries must be addressable.
        for style in (0, 127, 255):
            r = render(setting, style=style, name=None)
            if pixels(r) != pixels(date_only):
                failures.append(f'compact {setting}: unknown style {style} did not fall back')
        for name in ('W' * 32, 'A' * 32 + 'ignored suffix'):
            r = render(setting, name=name)
            check_render(r, f'compact {setting} max name', failures)
        if pixels(render(setting, name='A' * 32)) != pixels(render(setting, name='A' * 32 + 'suffix')):
            failures.append(f'compact {setting}: name exceeded the 32-character limit')
        if pixels(render(setting, style=255, name='AAAA')) != pixels(a):
            failures.append(f'compact {setting}: style 255 LUT entry not used')
        for w, h in ((480, 480), (720, 264)):
            r = run(setting, w, h, w, h, compact=True, name='W' * 32)
            check_render(r, f'compact {w}x{h} setting {setting} max name', failures)
    print('compact watermark styles, stash, LUT, fallback, chroma, off bytes and cache checks complete')


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    failures = []
    compact_checks(failures)
    # (name, main w, h, buffer window w, h): 3:2 L, 3:2 M (scaled into the top left), 1:1 M, XPan M
    scenarios = [('L32', 6192, 4128, 6192, 4128), ('M32', 4944, 3296, 6192, 4128),
                 ('M11', 3296, 3296, 4128, 4128), ('Mxpan', 4944, 1812, 6192, 2272)]
    for name, mw, mh, sw, sh in scenarios[1:]:
        for setting in (0, 2, 4, 0x80, 0xff):
            r = run(setting, mw, mh, sw, sh)
            if bbox_rows(r['main'], mw, 70) or bbox_flat(r['thumb'], 160, 160, 120, 120, r['fits'][1]):
                failures.append(f'{name}: setting {setting} drew something')
        widths = {}
        for setting in (1, 3):
            for mono in (False, True):
                r = run(setting, mw, mh, sw, sh, mono=mono)
                check_render(r, f'{name}: setting {setting} mono={mono}', failures)
                b = bbox_rows(r['main'], mw, 70)
                bp = bbox_flat(r['preview'], 736, 720, 480, 120, r['fits'][0])
                bt = bbox_flat(r['thumb'], 160, 160, 120, 120, r['fits'][1])
                if not b or not bp or not bt:
                    failures.append(f'{name}: setting {setting} mono {mono}: missing imprint {b} {bp} {bt}')
                    continue
                if not (b[2] < mw and b[3] < mh and b[0] > mw // 2 and b[1] > mh * 3 // 4):
                    failures.append(f'{name}: setting {setting}: main imprint not bottom right {b}')
                (px, py, pw_, ph_) = r['fits'][0]
                if not (px <= bp[0] and bp[2] < px + pw_ and py <= bp[1] and bp[3] < py + ph_):
                    failures.append(f'{name}: setting {setting}: preview imprint outside the photo {bp}')
                (tx, ty, tw, th) = r['fits'][1]
                if not (tx <= bt[0] and bt[2] < tx + tw and ty <= bt[1] and bt[3] < ty + th):
                    failures.append(f'{name}: setting {setting}: thumbnail imprint outside the photo {bt}')
                # colour of the most covered pixels
                cy = (b[1] + b[3]) // 2
                row, crow = r['main'][cy], r['mainc'][cy]
                lit = [xx for xx in range(b[0], b[2] + 1) if row[xx] >= 140]
                if not lit:
                    failures.append(f'{name}: setting {setting}: no fully lit pixel on the middle row')
                else:
                    xx = lit[len(lit) // 2] & ~1
                    cb, cr = crow[xx], crow[xx + 1]
                    if mono and (cb, cr) != (128, 128):
                        failures.append(f'{name}: mono photo got colour {cb},{cr}')
                    if not mono and not (cb < 80 and cr > 180):
                        failures.append(f'{name}: not orange: {cb},{cr}')
                if not mono:
                    widths[setting] = b[2] - b[0]
                if out:
                    from PIL import Image
                    x0, y0 = max(0, b[0] - 60), max(0, b[1] - 40)
                    crop = Image.frombytes('L', (mw, mh), b''.join(r['main'])).crop((x0, y0, min(mw, b[2] + 60), min(mh, b[3] + 40)))
                    pv = Image.frombytes('L', (736, 480), r['preview']).crop((0, 0, 720, 480))
                    th = Image.frombytes('L', (160, 120), r['thumb'])
                    canvas = Image.new('L', (720 + 20 + crop.width + 20 + 160, max(480, crop.height)), 30)
                    canvas.paste(pv, (0, 0))
                    canvas.paste(crop, (740, 0))
                    canvas.paste(th, (760 + crop.width, 0))
                    canvas.save(out / f'{name}_s{setting}{"_mono" if mono else ""}.png')
        if widths.get(3, 0) <= widths.get(1, 0) * 1.4:
            failures.append(f'{name}: long style not wider: {widths}')
        r = run(1, mw, mh, sw, sh, clock=(2026, 13, 8, 17, 34, 0))
        if bbox_rows(r['main'], mw, 70):
            failures.append(f'{name}: invalid clock drew something')
        print(name, 'widths', widths)
    # RAW+JPEG: the camera keeps the scaled main picture of the smaller sizes above 0xA0000000
    # (seen at 0xB1069CC0). Pictures up to 0xBFFFFFFF are drawn, from 0xC0000000 on they are not.
    r = run(1, 4944, 3296, 6192, 4128, base=0xb1000000)
    check_high = bbox_rows(r['main'], 4944, 70)
    if not check_high:
        failures.append('main picture at 0xB1xxxxxx (RAW+JPEG) got no imprint')
    r = run(1, 4944, 3296, 6192, 4128, base=0xc0000000)
    if bbox_rows(r['main'], 4944, 70):
        failures.append('main picture at 0xC0000000 got an imprint')
    print('RAW+JPEG main picture at 0xB1xxxxxx:', 'imprinted' if check_high else 'MISSING')
    print('module', len(CODE), 'bytes;', 'FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
