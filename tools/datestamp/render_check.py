# SPDX-License-Identifier: GPL-2.0-only
"""Emulator check of the date imprint module (core/src/fw/aspect/datestamp-code.ts).

NOT part of the program. Runs the compiled module in Unicorn on synthetic pictures laid out like the
camera's (main picture as a window of the 6208-wide sensor buffer, 720x480 screennail and 160x120
thumbnail with black bars) for every value of the setting byte, and checks:

  - byte 0, 2 and anything above 3: nothing is drawn;
  - byte 1 ('YY MM DD) and 3 (YYYY.MM.DD hh:mm): the imprint lands bottom right, inside the photo
    area of every picture, in orange (light only on a black-and-white photo), and the long style is
    wider than the short one;
  - an invalid clock (month 13) draws nothing.

    python3 render_check.py [OUTDIR]     # OUTDIR: also writes a PNG per scenario

Needs the Python packages unicorn and Pillow.
"""
import base64
import re
import struct
import sys
from pathlib import Path

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_SP, UC_ARM_REG_LR

ROOT = Path(__file__).resolve().parents[2]
TS = (ROOT / 'core/src/fw/aspect/datestamp-code.ts').read_text()
CODE = base64.b64decode(re.search(r"DATESTAMP_CODE = '([^']+)'", TS).group(1))
ORG = 0x10000
STRIDE, BUF_H = 6208, 4128


def run(setting, main_w, main_h, src_w, src_h, mono=False, clock=(2026, 10, 8, 17, 34, 53)):
    mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    mu.mem_map(ORG, 0x10000)
    mu.mem_write(ORG, CODE)
    mu.mem_map(0x60000000, 0x100000)
    mu.mem_map(0x70000000, 0x100000)
    YA = 0x80000000
    CA = YA + STRIDE * BUF_H
    mu.mem_map(YA, (STRIDE * BUF_H * 2 + 0xfff) & ~0xfff)
    mu.mem_write(YA, bytes([70]) * (STRIDE * BUF_H))
    chroma = bytes([128, 128]) * (STRIDE * BUF_H // 2) if mono else bytes([120, 140]) * (STRIDE * BUF_H // 2)
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

    def hook(uc, addr, size, ud):
        i = (addr - STUB) // 16
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
    mu.mem_write(CTX, struct.pack('<6I', *(STUB + i * 16 for i in range(5)), SET))

    ox = ((6192 - src_w) // 2) & ~1
    oy = (4128 - src_h) // 2
    WY = YA + oy * STRIDE + ox
    WC = CA + oy * STRIDE + ox

    def desc(a, yp, cp, w, h, stride, ch):
        mu.mem_write(a, struct.pack('<B3xIII HHHH HH 4x', 1, yp, cp, 0, w, h, stride, ch, 0, 0))
    D = 0x70005000
    desc(D, WY, WC, main_w, main_h, STRIDE, BUF_H)
    desc(D + 0x20, PV, PV + 0x100000, 720, 480, 736, 480)
    desc(D + 0x40, TH, TH + 0x8000, 160, 120, 160, 120)
    desc(D + 0x60, WY, WC, src_w, src_h, STRIDE, BUF_H)
    CFG = 0x70006000
    mu.mem_write(CFG + 0x3c, struct.pack('<4I', D, D + 0x20, D + 0x40, D + 0x60))
    mu.reg_write(UC_ARM_REG_SP, 0x600f0000)
    mu.reg_write(UC_ARM_REG_LR, 0x70000ff0)
    mu.reg_write(UC_ARM_REG_R0, CTX)
    mu.reg_write(UC_ARM_REG_R1, CFG)
    mu.emu_start(ORG, 0x70000ff0, count=800_000_000)
    main = [bytes(mu.mem_read(WY + r * STRIDE, main_w)) for r in range(main_h)]
    mainc = [bytes(mu.mem_read(WC + r * STRIDE, main_w)) for r in range(main_h)]
    preview = bytes(mu.mem_read(PV, 736 * 480))
    previewc = bytes(mu.mem_read(PV + 0x100000, 736 * 480))
    thumb = bytes(mu.mem_read(TH, 160 * 120))
    return {'main': main, 'mainc': mainc, 'preview': preview, 'previewc': previewc, 'thumb': thumb,
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


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    failures = []
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
    print('module', len(CODE), 'bytes;', 'FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
