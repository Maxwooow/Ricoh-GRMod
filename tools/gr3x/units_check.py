# SPDX-License-Identifier: GPL-2.0-only
"""Check of GR III / IIIx distances in feet (core/src/fw/gr3x/units.ts) in a built firmware.

    python3 tools/gr3x/units_check.py RELEASE OFFICIAL.rtos BUILT.rtos BUILT.iconbin [SHEET.png]

RELEASE is 2.10, 2.20 or 2.21. Development tool, not part of the program. From the built image alone
(the text and icon directories the code now loads) it checks that
  - in each of the 21 languages texts 62..69 are 1ft .. 16ft and every other official text is the
    official record;
  - each label site of the manual focus scale loads an icon that exists, is 30 x 20, lies inside
    ICONBIN and is the label units.ts names for that site; ∞ is the camera's;
  - the scale's function differs from the official one in those 13 words only.
With SHEET.png it draws the camera's labels above the new ones, site by site, to look at.
"""
import re, struct, sys, base64
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
rel, official, built, iconbin = sys.argv[1:5]
BASE = 0x53000000
TABLE = {'2.10': None, '2.20': 'core/src/fw/gr3x170/addresses.ts', '2.21': 'core/src/fw/gr3x171/addresses.ts'}[rel]
table = dict((int(a, 16), int(b, 16)) for a, b in re.findall(r'\[(0x[0-9a-f]{8}), (0x[0-9a-f]{8})\]', (REPO / TABLE).read_text())) if TABLE else None
adr = (lambda a: table[a]) if table else (lambda a: a)
RAM = {'2.10': (0x5407b540, 0x3a080), '2.20': (0x5407b640, 0x3a0c0), '2.21': (0x54084640, 0x3a300)}[rel]
TEXTS = {'2.10': 786, '2.20': 786, '2.21': 793}[rel]
off = open(official, 'rb').read(); img = open(built, 'rb').read(); icons = open(iconbin, 'rb').read()
def o(image, va):
    if 0x55000000 <= va < 0x55000000 + RAM[1]: va = va - 0x55000000 + RAM[0]
    assert BASE <= va < BASE + len(image), hex(va)
    return va - BASE
w = lambda image, va: struct.unpack_from('<I', image, o(image, va))[0]
def movpair(image, low, high=None):
    a, b = w(image, low), w(image, high or low + 4)
    assert (a & 0x0ff00000) == 0x03000000 and (b & 0x0ff00000) == 0x03400000, hex(low)
    return ((((b >> 4) & 0xf000) | (b & 0xfff)) << 16) | ((a >> 4) & 0xf000) | (a & 0xfff)
def text(image, record):
    n = image[o(image, record)]; t = image[o(image, w(image, record + 4)):][:max(0, n - 1) * 2]
    return t.decode('utf-16-le')
src = (REPO / 'core/src/fw/gr3x/adj.ts').read_text()
tlow, thigh = (adr(int(x, 16)) for x in re.search(r'textRootSites: \[\[adr\((0x[0-9a-f]{8})\), adr\((0x[0-9a-f]{8})\)\]', src).groups())
ilow = adr(int(re.search(r'iconRootSites: \[\[adr\((0x[0-9a-f]{8})\)', src).group(1), 16))
text_root_o, text_root_b = movpair(off, tlow, thigh), movpair(img, tlow, thigh)
icon_root_o, icon_root_b = movpair(off, ilow), movpair(img, ilow)
assert text_root_b != text_root_o and icon_root_b != icon_root_o
METRES = ['0.3m', '0.4m', '1m', '1.5m', '2m', '2.5m', '3.5m', '5m']; FEET = ['1ft', '1.3ft', '3.3ft', '4.9ft', '6.6ft', '8.2ft', '11ft', '16ft']
for lang in range(21):
    ro, rb = w(off, text_root_o + 4 * lang), w(img, text_root_b + 4 * lang)
    for i in range(TEXTS):
        a, b = w(off, ro + 4 * i), w(img, rb + 4 * i)
        if 62 <= i <= 69:
            assert text(off, a) == METRES[i - 62] and text(img, b) == FEET[i - 62], (lang, i, text(img, b))
        else: assert a == b, (lang, i)
print('texts: 21 languages, 62..69 are', ' '.join(FEET), '- all other official texts unchanged')

usrc = (REPO / 'core/src/fw/gr3x/units.ts').read_text()
fn = adr(int(re.search(r'SCALE_LABELS = adr\((0x[0-9a-f]{8})\)', usrc).group(1), 16))
sites = [(int(a, 16), int(b, 16), c) for a, b, c in re.findall(r"\[(0x[0-9a-f]+), (0xe3[0-9a-f]{6}), '([^']+)'\]", usrc)]
assert len(sites) == 13
labels = dict(re.findall(r"'?\"?([0-9a-z.]+)\"?'?: '([A-Za-z0-9+/=]+)'", (REPO / 'core/src/fw/gr4v120/aspect/units-icons.ts').read_text()))
def imm(word):
    if (word & 0x0ff00000) == 0x03000000: return ((word >> 4) & 0xf000) | (word & 0xfff)
    rot = (word >> 8) & 0xf; i8 = word & 0xff; return ((i8 >> (2 * rot)) | (i8 << (32 - 2 * rot))) & 0xffffffff
def icon(image, root, i):
    wd, ht, at = struct.unpack_from('<HHI', image, o(image, w(image, root + 4 * i)))
    assert at * 4 + wd * ht * 4 <= len(icons), 'icon outside ICONBIN'
    return wd, ht, icons[at * 4: at * 4 + wd * ht * 4]
pairs = []
for offset, word, label in sites:
    assert w(off, fn + offset) == word, hex(offset)
    new = w(img, fn + offset)
    assert (new & 0xfff0f000) == 0xe3001000, 'not movw r1'
    wd, ht, px = icon(img, icon_root_b, imm(new))
    assert (wd, ht) == (30, 20)
    want = bytearray(2400)
    for k, v in enumerate(base64.b64decode(labels[label])):
        if v: want[4 * k: 4 * k + 4] = bytes((v - 1, v - 1, v - 1, 255))
    assert px == bytes(want), label
    pairs.append((icon(off, icon_root_o, imm(word))[2], px, label))
changed = [x for x in range(0, 0x1c8, 4) if w(off, fn + x) != w(img, fn + x)]
assert changed == sorted(s[0] for s in sites), [hex(x) for x in changed]
assert w(img, fn + 0x40) == w(off, fn + 0x40)
print('manual focus scale: 13 label sites, each loads its 30 x 20 label; nothing else in the function changed')
if len(sys.argv) > 5:
    from PIL import Image
    sheet = Image.new('RGB', (13 * 132 + 12, 2 * 92 + 12), (70, 100, 70))
    for k, (a, b, _) in enumerate(pairs):
        for row, px in enumerate((a, b)):
            im = Image.frombytes('RGBA', (30, 20), px).resize((120, 80), Image.NEAREST)
            sheet.paste(im, (12 + k * 132, 12 + row * 92), im)
    sheet.save(sys.argv[5])
print(rel, 'ok')
