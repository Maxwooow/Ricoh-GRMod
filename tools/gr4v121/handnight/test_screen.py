# SPDX-License-Identifier: GPL-2.0-only
"""The live view's two hooks of handnight.ts and the processing screen, in the emulator (outside the sandbox: unicorn).

A. LiveViewController's vtable 0x53DC0D48, slot +0x2C (the per-loop update, UI task): the camera's own update runs (its quiet path,
   controller +0x2DC = 0), in the official image and in the build side by side.  With no module state, a state without the magic, or
   the busy word unchanged, the build does what the official image does (registers, controller, root, return value); with the busy
   word changed it also invalidates the live view's root once (View::Invalidate 0x535AD5F4, recorded) and notes the value; a root that
   is not a GroupView is not invalidated (noted); with the switch on the module runs (which 5).
B. The layer render 0x535919D4, which draws an invalidated layer root (+0xA0) with `bl` GroupView Draw (hooked at 0x53591aa0).  Another
   layer root, and the live view's root while the module is idle: what the official image does (registers, view, return value; nothing
   drawn).  The live view's root while busy:
     full-screen panel (state +0x122C, the root the whole canvas): the camera's own rectangle fill (0x5323DDF8 / 0x5323DF70 /
       0x5323E7C8, run for real into a 720 x 480 surface) paints the canvas in UI palette colour 20, the spinner (icons 640..647 by the
       UI's clock) is one bitmap request at (330, 210), the text line (the camera's StringView, catalog, font manager and font engine,
       fonts from the firmware file's RES section) under the bar, the track and the bar (palette colour 2, white) as wide as the percent;
     small indicator (+0x122C = 0): a dark box 300 x 64 at (210, 292), the spinner at (218, 294), track and bar;
     a root that does not cover the canvas: no full-screen panel.
C. The text in every language setting the camera has: Simplified / Traditional Chinese, Japanese and Korean their own, German and
   Spanish theirs, every other setting English; every character of the processing text and of the menu line's name has a glyph in
   the font the camera uses for that language.
Replaced (blind spots): View::Invalidate (recorded), the bitmap submission 0x53240640 and its lookup 0x5323E01C (recorded), the font
files' reading (FontManager 0x5323F3D8: the file system) answered from the RES section, the memory pool the font manager allocates
from, operator new / delete (sim.py).
usage: test_screen.py OFFICIAL_RTOS BUILD_DIR      (BUILD_DIR from build.ts: patched-RTOS.bin, manifest.json, res.bin)"""
import hashlib, json, os, struct, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

OFFICIAL, BUILD = sys.argv[1:3]
TEST = os.path.join(BUILD, 'patched-RTOS.bin')
L = {k: int(v, 16) for k, v in json.load(open(os.path.join(BUILD, 'manifest.json')))['layout'].items()}
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok

LVC_VT, GROUP_VT, LIVE_UPDATE, GROUP_DRAW, RENDER, RENDER_DRAW = 0x53DC0D48, 0x53ECF928, 0x5318F580, 0x53593C54, 0x535919D4, 0x53591aa0
INVALIDATE, BITMAP, R2, GLYPHS, FM_LOAD, POOL_GET = 0x535AD5F4, 0x53240640, 0x5323E01C, 0x5323EE78, 0x5323F3D8, 0x53905DC4
CATALOG, LANG, LANG_INDEX = 0x5440F200, sim.CUR + 0x14EF, 0x535963F0
TEXT_ID, NAME_ID = 1024, 1022
MAGIC = 0x5453464D
BOX = (0, 316, 720, 40)
BG = np.array([0x19, 0x19, 0x19, 0xFF], np.uint8)          # UI palette colour 20 (0xFF191919), BGRA in the surface
WHITE = np.array([0xFF, 0xFF, 0xFF, 0xFF], np.uint8)
CLEAR = np.array([0x10, 0x20, 0x30, 0xFF], np.uint8)        # the surface before a draw
PTEXT = {'CN_S': '多帧降噪处理中', 'CN_T': '多幀降噪處理中', 'JP': 'マルチフレームNR処理中', 'KR': '멀티 프레임 NR 처리 중'}
LATIN = {'Multi-frame NR processing', 'Mehrbild-NR wird verarbeitet', 'Procesando NR de varias tomas'}
NAMES = {'CN_S': '手持夜景', 'CN_T': '手持夜景', 'JP': '手持ち夜景', 'KR': '핸드헬드 야경'}
LATIN_NAMES = {'Handheld Night', 'Nacht aus der Hand', 'Noche a pulso'}
D = 0x63000000; C = D + 0x1000; ROOT = D + 0x8000; OTHER = D + 0x8800; SURF = D + 0x9000; BACK = D + 0x9800; KIDS = D + 0xA000; ST = D + 0x20000
FB = D + 0x100000; POOLOBJ = D + 0x60000; PVT = POOLOBJ + 0x100; STR = D + 0x70000
PALLOC, PFREE = sim.FAKE + 0x800, sim.FAKE + 0x900
FONTPOOL = 0x70000000

# ---- the fonts (RES section of the firmware file) ------------------------------------------------------------------------------
res = open(os.path.join(BUILD, 'res.bin'), 'rb').read()
FONTS = {}; o = 0
for _ in range(json.load(open(os.path.join(BUILD, 'manifest.json')))['resFiles']):
    path = res[o:o + 32].split(b'\0')[0].decode(); n = struct.unpack_from('<I', res, o + 32)[0]
    if '\\Font\\' in path: FONTS[path.lower()] = res[o + 36:o + 36 + n]
    o += 36 + n
del res


def world(rtos):
    c = sim.Cam(rtos); c.factory_settings()
    c.mu.mem_map(FONTPOOL, 0x01000000)
    c.inv = []; c.inv_stack = []; c.fam = None; c.bmp = []; c.glyph = []; c.loads = []; c.pool_next = FONTPOOL; c.mod = 0
    def inv(uc, *_):
        v = uc.reg_read(UC_ARM_REG_R0)
        if sim.STACK_TOP - 0x100000 <= v < sim.STACK_TOP:            # the StringView on the stack: the real Invalidate runs
            c.inv_stack.append(c.r8(v + 0xA0)); return
        c.inv.append(v); c._ret(0)
    def bmp(uc, *_):
        q = struct.unpack('<11I', c.rb(uc.reg_read(UC_ARM_REG_R1), 44)); c.bmp.append(dict(id=q[9] & 0xFFFF, rect=list(q[1:5]), clip=list(q[5:9]))); c._ret(0)
    def glyph(uc, *_):                       # recorded, then the real code runs on
        q = uc.reg_read(UC_ARM_REG_R1); p = c.r32(q + 0x30); s = ''
        for j in range(64):
            u = c.r16(p + 2 * j) if p else 0
            if not u: break
            s += chr(u)
        c.glyph.append(dict(text=s, rect=list(struct.unpack('<4i', c.rb(q + 4, 16))), clip=list(struct.unpack('<4i', c.rb(q + 0x14, 16))), fg=c.r8(q + 0x25), outline=c.r8(q + 0x26)))
    def pool(uc, *_): c._ret(POOLOBJ)
    def palloc(uc, *_):
        n = uc.reg_read(UC_ARM_REG_R1); p = c.pool_next; c.pool_next = (p + n + 63) & ~63; c._ret(p)
    def fload(uc, *_):
        path = c.rb(uc.reg_read(UC_ARM_REG_R1), 64).split(b'\0')[0].decode(); data = FONTS[path.lower()]
        c.wb(uc.reg_read(UC_ARM_REG_R2), data); c.loads.append(path.split('\\')[-1])
        if '\\RT_' in path: c.fam = path.split('\\RT_')[1][:-4]
        c._ret(1)
    for a, f in ((INVALIDATE, inv), (BITMAP, bmp), (GLYPHS, glyph), (POOL_GET, pool), (PALLOC, palloc), (PFREE, lambda uc, *_: c._ret(0)), (FM_LOAD, fload)):
        c.mu.hook_add(UC_HOOK_CODE, f, begin=a, end=a)
    c.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: c._ret(BACK), begin=R2, end=R2)
    if 'code' in L and rtos == TEST:
        def mod(uc, *_): c.mod += 1
        c.mu.hook_add(UC_HOOK_CODE, mod, begin=L['code'], end=L['code'])
    c.w32(POOLOBJ, PVT); c.w32(PVT + 8, PALLOC); c.w32(PVT + 0xC, PFREE)
    return c


def setup(c, lang=2, state=True, busy=5, ui_busy=5, progress=31, full=1, magic=MAGIC, switch=0, root_vt=GROUP_VT):
    c.wb(D, bytes(0x40000)); c.wb(FB, CLEAR.tobytes() * (720 * 480))
    c.w8(LANG, lang); c.w8(c.switch, switch)
    c.w32(C, LVC_VT); c.w32(C + 0x15C, ROOT); c.w8(C + 0x2DC, 0); c.w8(C + 0x2D4, 2)
    for v in (ROOT, OTHER):
        c.w32(v, root_vt if v == ROOT else GROUP_VT); c.w8(v + 0x9E, 1); c.w8(v + 0xA0, 1); c.w32(v + 0xEC, SURF); c.w32(v + 0xC, KIDS); c.w32(v + 0x10, KIDS)
        for o in (0x20, 0x30, 0x54, 0x64): c.wb(v + o, struct.pack('<4i', 0, 0, 720, 480))
    c.w8(SURF + 2, 5); c.w32(SURF + 8, FB); c.wb(SURF + 0x18, struct.pack('<HH', 720, 480))
    c.w32(c.slot, ST if state else 0)
    c.w32(ST, magic); c.w32(ST + 4, busy); c.w32(ST + 8, ui_busy); c.w32(ST + 0xC, progress); c.w32(ST + 0x122C, full); c.w32(ST + 0x224, C)
    c.inv.clear(); c.inv_stack.clear(); c.bmp.clear(); c.glyph.clear(); del c.loads[:]; c.mod = 0


CALLEE = [UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11]
def run(c, fn, *args):
    for i, r in enumerate(CALLEE): c.mu.reg_write(r, 0x77220000 + i)
    r0 = c.call(fn, *args)
    assert c.reg(UC_ARM_REG_PC) == sim.SENTINEL, hex(c.reg(UC_ARM_REG_PC))
    return dict(r0=r0, callee=[c.reg(r) for r in CALLEE], sp=c.reg(UC_ARM_REG_SP), bmp=list(c.bmp), inv=list(c.inv), glyph=[g['text'] for g in c.glyph],
                ctrl=c.rb(C, 0x600), root=c.rb(ROOT, 0x110), other=c.rb(OTHER, 0x110), surf=c.rb(SURF, 0x20), fb=hashlib.sha256(c.rb(FB, 720 * 480 * 4)).hexdigest())


def fb(c): return np.frombuffer(c.rb(FB, 720 * 480 * 4), np.uint8).reshape(480, 720, 4)
def region(a, x, y, w, h, colour): return bool((a[y:y + h, x:x + w] == colour).all())
def frame_of(tick): return 7 - ((((tick * 5) & 0xFFFFFFFF) >> 24) & 7)


ct, cb = world(TEST), world(OFFICIAL)
slot_word = struct.unpack_from('<I', open(TEST, 'rb').read(), LVC_VT + 0x2C - sim.BASE)[0]
bl = lambda at, w: (at + 8 + ((((w & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF
draw_word = struct.unpack_from('<I', open(TEST, 'rb').read(), RENDER_DRAW - sim.BASE)[0]
check('the two hooks: LiveViewController +0x2C is the wrapper; the layer render\'s `bl` GroupView Draw (0x53591aa0) goes to the draw (both stock '
      'in the official image); GroupView\'s vtable untouched',
      slot_word == L['wrapper'] and draw_word >> 24 == 0xEB and bl(RENDER_DRAW, draw_word) == L['draw'] and cb.r32(LVC_VT + 0x2C) == LIVE_UPDATE
      and bl(RENDER_DRAW, cb.r32(RENDER_DRAW)) == GROUP_DRAW and ct.r32(GROUP_VT + 0x4C) == cb.r32(GROUP_VT + 0x4C) == GROUP_DRAW)

# ---- A: the per-loop update -----------------------------------------------------------------------------------------------------
def update(c): return run(c, c.r32(LVC_VT + 0x2C), C)
for name, kw in (('no module state', dict(state=False)), ('a state without the magic', dict(magic=0)), ('busy unchanged (0)', dict(busy=0, ui_busy=0))):
    setup(ct, **kw); t = update(ct); setup(cb, **kw); b = update(cb)
    check(f'A: {name}: as the official image (registers, controller, root, return value), nothing invalidated', t == b and not ct.inv, str([k for k in t if t[k] != b[k]]))
setup(ct, busy=3, ui_busy=0); t = update(ct); setup(cb, busy=3, ui_busy=0); b = update(cb)
check('A: busy changed (0 -> 3): the root invalidated once, the value noted (+8 = 3); the controller and the return value as the official image',
      ct.inv == [ROOT] and ct.r32(ST + 8) == 3 and t['ctrl'] == b['ctrl'] and t['r0'] == b['r0'] and t['callee'] == b['callee'], str((ct.inv, ct.r32(ST + 8))))
setup(ct, busy=3, ui_busy=0, root_vt=0x53DC0D48); update(ct)
check('A: a root that is not a GroupView: not invalidated, noted (+0x20 = 1)', not ct.inv and ct.r32(ST + 0x20) == 1)
setup(ct, busy=0, ui_busy=0, switch=1); update(ct)
setup(cb, busy=0, ui_busy=0, switch=1); update(cb)
check('A: switch on: the module runs once per loop (which 5); the official image has no module', ct.mod == 1)

# ---- B: GroupView's Draw ----------------------------------------------------------------------------------------------------------
for name, kw, view in (('another layer root, busy', dict(), OTHER), ('the live view\'s root, idle (busy 0)', dict(busy=0, ui_busy=0), ROOT),
                       ('the live view\'s root, no module state', dict(state=False), ROOT), ('the live view\'s root, the controller not noted', dict(), ROOT)):
    setup(ct, **kw); setup(cb, **kw)
    if 'not noted' in name: ct.w32(ST + 0x224, 0)
    t = run(ct, RENDER, view); b = run(cb, RENDER, view)
    check(f'B: {name}: the layer render as in the official image (registers, views, surface, nothing drawn)', t == b and not ct.bmp and not ct.glyph, str([k for k in t if t[k] != b[k]]))

texts = {}
for lang in range(21):
    for word, pct in ((1, 0), (61, 60), (101, 100)):
        setup(ct, lang=lang, progress=word); ct.clock = 0x80000000 - 0x01000000 * (lang % 8)
        t = run(ct, RENDER, ROOT); a = fb(ct)
        bw = pct * 240 // 100; icon = 640 + frame_of(ct.clock)
        ok = (region(a, 0, 0, 720, 210, BG) and region(a, 0, 270, 720, 26, BG) and region(a, 240, 298, 240, 2, WHITE)
              and (bw == 0 or region(a, 240, 296, bw, 6, WHITE)) and region(a, 240 + max(bw, 1), 296, 240 - max(bw, 1), 2, BG)
              and ct.bmp == [dict(id=icon, rect=[330, 210, 60, 60], clip=[330, 210, 60, 60])] and len(ct.glyph) == 1
              and ct.glyph[0]['clip'] == list(BOX) and ct.r8(ROOT + 0xA0) == 0 and ct.r32(ST + 0x10) == 1)
        if lang == 0 and word == 1: print(f'      requests: {ct.bmp}; text {ct.glyph}')
        texts[lang] = (ct.fam, ct.glyph[0]['text'] if ct.glyph else None)
        if not ok or word == 61:
            check(f'B: full-screen panel, setting {lang}, {pct} %: the canvas in colour 20, spinner icon {icon} at (330, 210), one text request in the box, '
                  f'the track (240, 298, 240 x 2) and the bar (240, 296, {bw} x 6) white', ok, str((ct.bmp, ct.glyph[:1])))
def official(**kw):
    """the official image's render of the same root (its own fill of the root first): the surface it leaves"""
    root64 = kw.pop('root64', None)
    setup(cb, **kw)
    if root64: cb.wb(ROOT + 0x64, struct.pack('<4i', *root64))
    run(cb, RENDER, ROOT); return fb(cb).copy()
o = official(full=0, progress=51)
setup(ct, full=0, progress=51); run(ct, RENDER, ROOT); a = fb(ct)
check('B: small indicator (+0x122C = 0): the dark box 300 x 64 at (210, 292), the spinner at (218, 294), track 210 wide, bar 105 wide; '
      'outside it what the official render leaves',
      region(a, 210, 292, 74, 29, BG) and region(a, 284, 323, 210, 2, WHITE) and region(a, 284, 321, 105, 2, WHITE) and (a[:292] == o[:292]).all()
      and (a[356:] == o[356:]).all() and len(ct.bmp) == 1 and ct.bmp[0]['rect'][:2] == [218, 294] and ct.bmp[0]['clip'] == [218, 294, 60, 60] and not ct.glyph,
      str(ct.bmp))
o = official(root64=(0, 0, 720, 400))
setup(ct); ct.wb(ROOT + 0x64, struct.pack('<4i', 0, 0, 720, 400)); run(ct, RENDER, ROOT); a = fb(ct)
check('B: a root that does not cover the canvas: no full-screen panel, no text (the small indicator)', not ct.glyph and (a[:292] == o[:292]).all())
o = official(root64=(0, 300, 720, 180))
setup(ct); ct.wb(ROOT + 0x64, struct.pack('<4i', 0, 300, 720, 180)); t = run(ct, RENDER, ROOT)
check('B: a root whose clip does not hold the indicator: nothing drawn (the official render\'s surface)', not ct.bmp and not ct.glyph and (fb(ct) == o).all())

# ---- L: the camera's own per-loop path -----------------------------------------------------------------------------------------
# The App's loop (0x5325EE64..0x5325EE90) calls the current controller's vt +0x2C (the update) and then vt +0x30 (its frame,
# 0x5318480C for LiveViewController): the frame walks the controller's layers (+4, 0x30 apart: view, id, enabled), and renders a
# dirty layer root with 0x535919D4, which draws a fully invalidated root by a direct `bl 0x53593C54` (not through vt +0x4C).  The live
# view's root (+0x15C) is the root of layer 0 (+4).  Here both calls run for real, loop after loop, with the module busy: the update
# (wrapper) invalidates the root, the frame redraws it, and the processing screen must be drawn.  Replaced: the App / display service
# getters 0x53240CAC / 0x53241060, its "suspended" test 0x5326A934 (0) and layer test 0x5326A890 (1), the frame's prepare / lock /
# unlock / finish 0x5318473C / 0x5326AA34 / 0x5326AA5C / 0x53184634 (recorded), the screen's back buffer getter.
SERVICE = D + 0x30000
def lsetup(c, busy, ui_busy, full=1):
    setup(c, busy=busy, ui_busy=ui_busy, full=full)
    c.w32(C + 4, ROOT); c.w8(C + 8, 0); c.w8(C + 9, 1); c.w8(C + 0x14E, 0); c.w8(ROOT + 0xA0, 0); c.w8(ROOT + 0xA2, 0)
    for k in range(1, 6): c.w32(C + 4 + 0x30 * k, 0)
def lworld(c):
    c.frame_ev = []
    def svc(uc, *_): c._ret(SERVICE)
    def svc2(uc, *_): c._ret(SERVICE + 0x100)
    def zero(uc, *_): c._ret(0)
    def one(uc, *_): c._ret(1)
    def ev(name):
        def f(uc, *_): c.frame_ev.append(name); c._ret(0)
        return f
    for a, f in ((0x53240CAC, svc), (0x53241060, svc2), (0x5326A934, zero), (0x5326A890, one), (0x5318473C, ev('prepare')), (0x5326AA34, ev('lock')),
                 (0x5326AA5C, ev('unlock')), (0x53184634, ev('finish'))):
        c.mu.hook_add(UC_HOOK_CODE, f, begin=a, end=a)
for c in (ct, cb): lworld(c)
def loops(c, n, busy_seq):
    out = []
    for i in range(n):
        c.w32(ST + 4, busy_seq[i]); c.bmp.clear(); c.glyph.clear(); c.inv.clear(); c.frame_ev.clear(); c.wb(FB, CLEAR.tobytes() * (720 * 480))
        c.clock = (c.clock - 0x00800000) & 0xFFFFFFFF
        run(c, c.r32(LVC_VT + 0x2C), C)
        inv = list(c.inv)
        if inv: c.w8(ROOT + 0xA0, 1)                               # (Invalidate is recorded: its +0xA0 as the real one sets it)
        run(c, c.r32(LVC_VT + 0x30), C)
        a = fb(c)
        out.append(dict(inv=inv, ev=list(c.frame_ev), bmp=[b['id'] for b in c.bmp], text=len(c.glyph), panel=region(a, 0, 0, 720, 200, BG)))
    return out
seq = [0, 3, 3, 4, 4, 5, 0]
lsetup(ct, 0, 0); tr = loops(ct, len(seq), seq)
drawn = [x for x in tr if x['panel']]
check('L: the camera\'s loop (update, then the LiveViewController frame) with the module busy: the root invalidated, the frame redraws it, '
      'and the processing screen (panel, spinner, text) is drawn in every redraw while busy',
      all(x['inv'] == [ROOT] and x['panel'] and x['text'] == 1 and len(x['bmp']) == 1 for x in tr[1:6]) and not tr[0]['panel'] and 'lock' in tr[1]['ev'], str(tr))
lsetup(cb, 0, 0); tb = loops(cb, len(seq), seq)
check('L: the official image, same loops: no processing screen', not any(x['panel'] for x in tb))

# ---- K: the root's children (the level, histogram, grid, focus frame, icons ...) while the panel is up ----------------------------
# A child of the live view's root redraws itself (its +0xA0 set, the root's +0xA2): the layer render then redraws the children alone
# (0x535AD7C4 / 0x535AD6FC), over whatever is on the canvas.  Here the child is a view with the stock View vtable but its Draw a recorder
# that paints its rectangle (300 x 20 at (210, 300), inside the panel).  Loop: the panel is up (busy), then only the child is dirty: the
# frame (vt +0x30) runs for real.  The panel must stay over the child while busy, and the child must be drawn again (its own state, the
# panel gone) once busy is 0.
CHILD, CHILD_VT, CHILD_DRAW, KIDS2 = D + 0x8400, D + 0x7000, sim.FAKE + 0xA00, D + 0xA800
RED = np.array([0x00, 0x00, 0xFF, 0xFF], np.uint8)
def kworld(c):
    c.child_draws = 0
    def cdraw(uc, *_):
        c.child_draws += 1; c.w8(CHILD + 0xA0, 0)
        a = np.frombuffer(c.rb(FB, 720 * 480 * 4), np.uint8).reshape(480, 720, 4).copy(); a[300:320, 210:510] = RED; c.wb(FB, a.tobytes()); c._ret(0)
    c.mu.hook_add(UC_HOOK_CODE, cdraw, begin=CHILD_DRAW, end=CHILD_DRAW)
for c in (ct, cb): kworld(c)
def ksetup(c, busy):
    lsetup(c, busy, busy)
    c.wb(CHILD_VT - 8, c.rb(0x53ECFB78 - 8, 0x110)); c.w32(CHILD_VT + 0x4C, CHILD_DRAW)
    c.wb(CHILD, bytes(0x110)); c.w32(CHILD, CHILD_VT); c.w32(CHILD + 4, ROOT); c.w8(CHILD + 0x9E, 1)
    for o in (0x20, 0x30, 0x54, 0x64): c.wb(CHILD + o, struct.pack('<4i', 210, 300, 300, 20))
    c.w32(KIDS2, CHILD); c.w32(ROOT + 0xC, KIDS2); c.w32(ROOT + 0x10, KIDS2 + 4)
def kloop(c, busy, child_only):
    c.w32(ST + 4, busy); c.bmp.clear(); c.glyph.clear(); c.inv.clear(); c.child_draws = 0
    c.clock = (c.clock - 0x00100000) & 0xFFFFFFFF
    run(c, c.r32(LVC_VT + 0x2C), C)
    if c.inv: c.w8(ROOT + 0xA0, 1)
    if child_only: c.w8(CHILD + 0xA0, 1); c.w8(ROOT + 0xA2, 1)
    run(c, c.r32(LVC_VT + 0x30), C)
    a = fb(c)
    return dict(child=c.child_draws, red_in_panel=bool((a[300:320, 210:510] == RED).all()), panel=region(a, 0, 0, 720, 200, BG), text=len(c.glyph))
ksetup(ct, 3); k0 = kloop(ct, 3, False); k1 = kloop(ct, 3, True); k2 = kloop(ct, 3, True)
check('K: while busy a child that redraws itself does not show over the processing screen (the root is rendered whole: the child, then the '
      'panel)', k0['panel'] and all(x['child'] == 1 and x['panel'] and not x['red_in_panel'] and x['text'] == 1 for x in (k1, k2)), str((k0, k1, k2)))
k3 = kloop(ct, 0, False)
check('K: after the merge (busy 0) the root is drawn by itself again: the child as it is, no panel', k3['child'] == 1 and k3['red_in_panel'] and not k3['panel'], str(k3))
ksetup(cb, 0); kb = kloop(cb, 0, True)
check('K: the official image: a dirty child is redrawn alone (partial render)', kb['child'] == 1 and kb['red_in_panel'], str(kb))

# ---- C: the texts -----------------------------------------------------------------------------------------------------------------
fams = {l: f for l, (f, _) in texts.items()}
latin = [texts[l][1] for l in range(21) if fams[l] not in PTEXT]
check('C: the camera picks its own text per language: ' + ', '.join(f'{l} {f} "{s}"' for l, (f, s) in texts.items() if f in PTEXT)
      + f'; the {len(latin)} other settings: English except one German and one Spanish',
      all(texts[l][1] == PTEXT[f] for l, f in fams.items() if f in PTEXT) and {'CN_S', 'CN_T', 'JP', 'KR'} <= set(fams.values())
      and latin.count('Mehrbild-NR wird verarbeitet') == 1 and latin.count('Procesando NR de varias tomas') == 1 and set(latin) <= LATIN, str(texts))

def alone(c, lang, s):
    """text 1024 of this language made `s` (its descriptor in the catalog), drawn on the processing screen; its ink in the text box"""
    setup(c, lang)
    row = c.r32(CATALOG + 4 * c.call(LANG_INDEX, lang))
    desc = c.r32(row + 4 * TEXT_ID); old = c.rb(desc, 8)
    c.wb(STR, (s + '\0').encode('utf-16-le')); c.w8(desc, len(s) + 1); c.w32(desc + 4, STR)
    setup(c, lang); run(c, RENDER, ROOT)
    c.wb(desc, old)
    return fb(c)[BOX[1]:BOX[1] + BOX[3]].copy()

def name_of(c, lang):
    row = c.r32(CATALOG + 4 * c.call(LANG_INDEX, lang)); desc = c.r32(row + 4 * NAME_ID); p = c.r32(desc + 4)
    return bytes(c.rb(p, 2 * (c.r8(desc) - 1))).decode('utf-16-le')

names = {l: name_of(ct, l) for l in range(21)}
check('C: the menu line\'s name (text 1022) per setting: Chinese / Japanese / Korean their own, one German, one Spanish, the rest English',
      all(names[l] == NAMES[f] for l, f in fams.items() if f in NAMES) and set(names[l] for l in range(21) if fams[l] not in NAMES) <= LATIN_NAMES
      and [names[l] for l in range(21)].count('Nacht aus der Hand') == 1 and [names[l] for l in range(21)].count('Noche a pulso') == 1, str(names))
done = set()
for lang in range(21):
    fam = fams[lang]
    strings = {texts[lang][1], names[lang]}
    key = (fam, tuple(sorted(strings)))
    if key in done: continue
    done.add(key)
    missing = alone(ct, lang, ''); bad = []
    for ch in sorted(set(''.join(strings)) - {' '}):
        a = alone(ct, lang, ch)
        if np.array_equal(a, missing) or (a == BG).all(): bad.append(ch)
    check(f'C: {fam} font (setting {lang}): every character of {sorted(strings)} has its own glyph (ink, not the missing-character drawing)', not bad, str(bad))

print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
