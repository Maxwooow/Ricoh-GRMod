# SPDX-License-Identifier: GPL-2.0-only
"""Survey of the free bytes of GR III / IIIx's user-settings record (core/src/fw/gr3x/menu-lines.ts, GR3X_FREE_SETTING_BYTES).

    python3 tools/gr3extras/settings_survey.py DIR

DIR holds the decoded RTOS images gr3_v210.rtos, gr3_v220.rtos, gr3_v221.rtos (GR IIIx 1.60 / 1.70 / 1.71 are the same
programs). Development tool, not part of the program. For each release:

 1. The record's layout, from the camera's own code: the default merge (UserDataModel, called by the settings load
    for every record; found by its instructions) is run in Unicorn on a record whose every byte is 1 ("take the
    default") with defaults of 0xaa: the bytes it copies are the values, the bytes it reads are the flags. The
    entries {value; u8 flag} are named by the field-name list the settings save also stores (its size table gives
    each value's size; the save function addresses both). Padding = the bytes after a flag up to the next entry.
 2. For every padding byte at 0x800 and above: the byte and halfword loads and stores at that offset (any base
    register) in the whole image, and those inside the UI and settings code (0x53160000..0x532c0000), where every
    accessor of the record is.
 3. What happens to padding: the default builder clears its buffer (memset 0 of 0xb28); the whole-record copies
    (every movw #0xb26 / #0xb28 with its function); Save Settings to U (found by its instructions) run in Unicorn:
    which bytes of the slot come from the current record and which from the defaults.
Prints a table; exits 1 if a release's layout differs from 2.10's or an expectation fails.
"""
import os, re, struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_READ
from unicorn.arm_const import *

BASE = 0x53000000
RAMSPEC = {'2.10': (0x5407b540, 0x3a080, 0x53940000), '2.20': (0x5407b640, 0x3a0c0, 0x53950000), '2.21': (0x54084640, 0x3a300, 0x53950000)}
FILES = {'2.10': 'gr3_v210.rtos', '2.20': 'gr3_v220.rtos', '2.21': 'gr3_v221.rtos'}
# 2.10 functions; the other releases' are found by their instructions (branch offsets and movw / movt immediates masked).
MERGE, SAVE, USAVE, NOTIFY, BUILDER_DEFAULT, ASSERT = 0x53246df8, 0x5323f274, 0x5327a104, 0x532750f8, 0x5323f424, 0x536b93d0
SIZE = 0xb28
GRMOD = {0x9a1: 'GR Mod: ADJ soft focus', 0x9a2: 'GR Mod: date imprint', 0x9a3: 'GR Mod rounds 5..9: End Screen picture (top byte)',
         0x9a9: 'GR Mod rounds 5..9: End Screen picture', 0x9aa: 'GR Mod rounds 5..9: End Screen picture', 0x9ab: 'GR Mod rounds 5..9: End Screen picture'}
fails = []
def check(c, what):
    if not c: fails.append(what); print('FAIL', what)

def w32(img, a): return struct.unpack_from('<I', img, a - BASE)[0]
def masked(img, a, n):
    out = []
    for i in range(n):
        x = w32(img, a + 4 * i)
        if (x & 0x0e000000) == 0x0a000000: x &= 0xff000000
        elif (x & 0x0ff00000) in (0x03000000, 0x03400000): x &= 0xfff0f000
        out.append(x)
    return out
def find(ref, a, img, n=16, span=0x100000):
    pat = masked(ref, a, n)
    hits = [c for c in range(a - span, a + span, 4) if BASE <= c and c - BASE + 4 * n <= len(img) and w32(img, c) == pat[0] and masked(img, c, n) == pat]
    if len(hits) != 1: raise RuntimeError('%x: %d matches' % (a, len(hits)))
    return hits[0]
def movw_pair(img, lo_at, hi_at): return (((w32(img, lo_at) >> 4) & 0xf000) | (w32(img, lo_at) & 0xfff)) | ((((w32(img, hi_at) >> 4) & 0xf000) | (w32(img, hi_at) & 0xfff)) << 16)

class Emu:
    def __init__(s, img, rel):
        mu = s.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(img) + 0xfff) & ~0xfff); mu.mem_write(BASE, img)
        src, n, _ = RAMSPEC[rel]; mu.mem_map(0x55000000, 0x900000); mu.mem_write(0x55000000, img[src - BASE:src - BASE + n])
        mu.mem_map(0x10000000, 0x100000); mu.mem_map(0x1ffc0000, 0x40000); mu.mem_map(0x30000000, 0x1000)
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf << 20)); mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        s.stubs = {}
        mu.hook_add(UC_HOOK_CODE, lambda mu, a, sz, _: s._stub(a))
    def _stub(s, a):
        f = s.stubs.get(a)
        if f is None: return
        s.mu.reg_write(UC_ARM_REG_R0, f(s) & 0xffffffff); s.mu.reg_write(UC_ARM_REG_PC, s.mu.reg_read(UC_ARM_REG_LR))
    def call(s, f, *args):
        for i, v in enumerate(args): s.mu.reg_write([UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3][i], v)
        s.mu.reg_write(UC_ARM_REG_SP, 0x20000000 - 0x1000); s.mu.reg_write(UC_ARM_REG_LR, 0x30000000)
        s.mu.emu_start(f, 0x30000000, count=3000000)
    def rd(s, a, n): return bytes(s.mu.mem_read(a, n))
    def wr(s, a, b): s.mu.mem_write(a, bytes(b))

OBJ, REC, DEF = 0x10030000, 0x10010000, 0x10020000
def layout(img, rel, merge):
    e = Emu(img, rel)
    e.wr(OBJ, bytes(0x40)); e.wr(OBJ + 0x24, struct.pack('<I', DEF)); e.wr(OBJ + 4, struct.pack('<I', REC))
    e.wr(DEF, bytes([0xaa]) * SIZE); e.wr(REC, bytes([1]) * SIZE)
    reads = set()
    e.mu.hook_add(UC_HOOK_MEM_READ, lambda mu, acc, a, size, v, _: reads.update(range(a - REC, a - REC + size)) if REC <= a < REC + SIZE else None)
    e.call(merge, OBJ, REC, 0)
    r = e.rd(REC, SIZE)
    kind = ['v' if r[i] == 0xaa else 'f' if i in reads else '.' for i in range(SIZE)]
    entries, pads, i = [], [], 0
    while i < SIZE:
        if kind[i] == 'v':
            j = i
            while j < SIZE and kind[j] == 'v': j += 1
            entries.append((i, j - i, j if j < SIZE and kind[j] == 'f' else None)); i = j
        elif kind[i] == '.':
            j = i
            while j < SIZE and kind[j] == '.': j += 1
            if i and kind[i - 1] == 'f' and j - i <= 3 and j % 2 == 0 and (j == SIZE or kind[j] == 'v'): pads += range(i, j)
            i = j
        else: i += 1
    return kind, entries, pads

def access_hits(img, end):
    """(offset, size) -> code addresses of byte / halfword loads and stores with that immediate offset."""
    hits = {}
    for o in range(0, end - BASE, 4):
        x = struct.unpack_from('<I', img, o)[0]
        if x >> 28 == 0xf or not (x >> 24) & 1 or not (x >> 23) & 1: continue
        if (x & 0x0e400000) == 0x04400000: hits.setdefault((x & 0xfff, 1), []).append(BASE + o)          # ldrb / strb #imm
        elif (x & 0x0e4000f0) == 0x004000b0: hits.setdefault((((x >> 4) & 0xf0) | (x & 0xf), 2), []).append(BASE + o)  # ldrh / strh #imm
        elif (x & 0x0e5000d0) == 0x005000d0: hits.setdefault((((x >> 4) & 0xf0) | (x & 0xf), 1 if (x >> 5) & 3 == 2 else 2), []).append(BASE + o)  # ldrsb / ldrsh
    return hits

def usave(img, rel, f, notify, aflag, slot, mode):
    e = Emu(img, rel)
    CUR, MODE = 0x10040000, 0x10060000
    e.wr(OBJ, bytes(0x40)); e.wr(OBJ, struct.pack('<I', MODE)); e.wr(MODE, [mode])
    e.wr(OBJ + 4, struct.pack('<I', CUR)); e.wr(OBJ + 0x24, struct.pack('<I', DEF))
    for n in range(7): e.wr(OBJ + 8 + 4 * n, struct.pack('<I', 0x10070000 + n * 0x1000)); e.wr(0x10070000 + n * 0x1000, bytes([0x55]) * SIZE)
    e.wr(CUR, bytes([0x77]) * SIZE); e.wr(DEF, bytes(SIZE))
    e.stubs[aflag] = lambda e: 0; e.stubs[notify] = lambda e: 0
    e.call(f, OBJ, slot)
    return e.rd(0x10070000 + slot * 0x1000, SIZE), e.rd(CUR, SIZE)

d = sys.argv[1]
imgs = {r: open(os.path.join(d, f), 'rb').read() for r, f in FILES.items()}
ref = imgs['2.10']
results = {}
for rel, img in imgs.items():
    f = (lambda a: a) if rel == '2.10' else (lambda a, img=img: find(ref, a, img))
    merge, save, us, notify, builder, aflag = f(MERGE), f(SAVE), f(USAVE), f(NOTIFY), f(BUILDER_DEFAULT), f(ASSERT)
    names_at, sizes_at = movw_pair(img, save + 0x6c, save + 0x74), movw_pair(img, save + 0x84, save + 0x90)
    names = img[names_at - BASE:img.index(b'\0', names_at - BASE)].decode().split(',')[:-1]
    sizes = struct.unpack_from('<%dI' % len(names), img, sizes_at - BASE)
    kind, entries, pads = layout(img, rel, merge)
    check(len(entries) == len(names) and all(l == s or (l == s - 1 and s in (3, 6, 33)) for (o, l, fl), s in zip(entries, sizes)), f'{rel}: the merge\'s entries are the named fields')
    # the default builder clears its 0xb28-byte buffer first; the save writes 0xb26 bytes of each of the 8 records
    check(w32(img, builder + 0x30) == 0xe3002b28 and w32(img, builder + 0x40) == 0xe3a01000, f'{rel}: the default builder clears 0xb28 bytes first')
    hits = access_hits(img, RAMSPEC[rel][2])
    results[rel] = (kind, entries, names, pads, hits, (merge, save, us, notify, aflag))
    print(f'{rel}: merge {merge:#x}, save {save:#x}, Save to U {us:#x}; {len(names)} fields, record end {entries[-1][2] + 1:#x}; padding {len(pads)} bytes')
k0 = results['2.10'][0]
for rel in ('2.20', '2.21'): check(results[rel][0] == k0 and results[rel][2] == results['2.10'][2], f'{rel}: layout and names as 2.10\'s')

# --- the padding at 0x800 and above
print('\npadding at 0x800 .. 0xb27 (after the flag of):')
kind, entries, names, pads, hits, _ = results['2.10']
owner = {}
for (o, l, fl), n in zip(entries, names):
    if fl is not None: owner[fl] = n
def after(b):
    k = b
    while k > 0 and k not in owner: k -= 1
    return owner.get(k, '?')
free = []
for b in [p for p in pads if p >= 0x800]:
    row = []
    for rel in FILES:
        h = results[rel][4]
        allh = h.get((b, 1), []) + h.get((b, 2), []) + h.get((b - 1, 2), [])
        ui = [a for a in allh if 0x53160000 <= a < 0x532c0000]
        row.append((len(allh), len(ui)))
    note = GRMOD.get(b, 'not saved (the saves and copies stop at 0xb26)' if b >= 0xb26 else 'free')
    if note == 'free':
        check(all(u == 0 for _, u in row), f'{b:#x}: accessed in the settings code')
        free.append(b)
    print(f'  {b:#05x}  {after(b):<38} hits (all, UI/settings) ' + ' '.join(f'{r}:{a},{u}' for r, (a, u) in zip(FILES, row)) + f'  {note}')
print('free:', ' '.join(hex(b) for b in free), f'({len(free)} bytes, {8 * len(free)} bits)')

# --- what happens to padding
print('\nwhole-record operations (movw #0xb26 / #0xb28) in 2.10, by function:')
img = ref
sites = {}
for o in range(0, RAMSPEC['2.10'][2] - BASE, 4):
    x = struct.unpack_from('<I', img, o)[0]
    if (x & 0x0ff00fff) in (0x03000b26, 0x03000b28) and (x >> 16) & 0xf == 0: sites.setdefault(x & 0xfff, []).append(BASE + o)
for v, s in sites.items(): print(f'  {v:#x}:', ' '.join(hex(a) for a in s))
for rel in FILES:
    us, notify, aflag = results[rel][5][2], results[rel][5][3], results[rel][5][4]
    kind = results[rel][0]; pads = results[rel][3]
    slot, cur = usave(imgs[rel], rel, us, notify, aflag, 1, 0)
    vals = [i for i in range(0xb26) if kind[i] == 'v']
    from_cur = sum(1 for i in vals if slot[i] == 0x77)
    pad_vals = {slot[i] for i in pads if i < 0xb26}
    slot2, cur2 = usave(imgs[rel], rel, us, notify, aflag, 1, 1)
    check(pad_vals == {0} and {cur2[i] for i in pads if i < 0xb26} == {0}, f'{rel}: Save to U')
    print(f'{rel}: Save Settings to U1 copies {from_cur} of {len(vals)} value bytes from the current record; the slot\'s padding is {sorted(pad_vals)} (the defaults\');'
          f' while in U1 the current record becomes the slot (padding {sorted({cur2[i] for i in pads if i < 0xb26})})')
print('FAILED: %d' % len(fails) if fails else 'survey: all expectations hold')
sys.exit(1 if fails else 0)
