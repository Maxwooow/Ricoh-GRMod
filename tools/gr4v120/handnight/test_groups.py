# SPDX-License-Identifier: GPL-2.0-only
"""Groups and the UI task's per-loop module call of a Handheld Night build, in the emulator (outside the sandbox: unicorn): B (the back end, 4 presses in the camera's module order: merged, merged, not
merged, merged) and U (the UI task's per-loop module call through every case of the merge, its end and the window after it: nothing
else, a key, a non-key event, a release, the power key, another screen, a shot during the merge).  Compared byte for byte: every frame's
Bayer data, ShootingInfo copy, params and recipe words incl. the store configuration ("no file" byte apart, compared separately), the
App posts (but the module's wake-ups), the front-end posts, the frees, the blocks left; after every UI loop CaptureImageModel, the
LiveViewController, the LCD device, the processing-screen word, the settings and the playback posts.
Alone: the outcomes the camera showed (merged groups store only the merged frame: "no file" 1 1 1 0; the group that is not merged stores
all four; no file of the module's own on the card; after a merged group the merged frame's review is ended by one
CMD_PLAYBACK_DIRECT_AND_QUICK_VIEW_STOP 0x4441100C, not after a key, a release, the power key or another screen).
F. Frame 1 in the order the upstream build's camera tests recorded (its store set up after frame 2's module 9, before the result):
   KEEP_FIRST's decision in each ending (merged, not merged, a burst of 3 / 2 / 1 frames, the power key before frame 1's store or during
   the merge): which frames are stored, at least one picture of the press in every case.
With --against OTHER_RTOS [UP_HI]: every value above compared with another build of the module byte for byte (an earlier build of the
module, a rebuild); UP_HI, the user offset of that build's ISO-limit high half (0x46E here) when it differs, is compared as a value.
usage: test_groups.py TEST_RTOS [--against OTHER_RTOS [UP_HI]]"""
import hashlib, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim, read_mf
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

ARGS = sys.argv[1:] if __name__ == '__main__' else []
BUILDS = [('test', ARGS[0], 0x46E)] if ARGS else []
if '--against' in ARGS:
    i = ARGS.index('--against'); BUILDS.append(('other', ARGS[i + 1], int(ARGS[i + 2], 0) if len(ARGS) > i + 2 else 0x46E))
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok

W, H = 256, 128
SEQ, SIF, LVC = sim.OBJ + 0x3800000, sim.OBJ + 0x3810000, sim.OBJ + 0x3820000
CFG = 0xCF4
h = lambda b: hashlib.sha256(b).hexdigest()[:16]
U4 = 4                                                     # CUR + 4: the saved user settings

def cur_view(c, up_hi):
    """CUR's 0x1500 bytes with the module's ISO-limit high half (and its place in the other build) cleared, in the saved block and its
    live copy at +0xB44, and its value"""
    b = bytearray(c.rb(sim.CUR, 0x1500)); vals = []
    for base in (U4, U4 + 0xB44):
        vals.append(bytes(b[base + up_hi:base + up_hi + 2]))
        for o in {0x46E, up_hi}: b[base + o:base + o + 2] = b'\0\0'
    return h(bytes(b)), tuple(vals)

def cam(rtos):
    c = sim.Cam(rtos, slice_=200000); c.w8(c.switch, 1); c.wb(LVC, bytes(0x100))
    return c

def fe(c, n, sv):
    c.wb(SEQ, bytes(0x400)); c.wb(SIF, bytes(0x1000)); c.w32(SEQ + 0x104, n); c.w8(SIF + 0x7BC, 1); c.w32(SIF + 0xBA0, sim.f32(sv))
    c.w32(SIF + 0xB9C, sim.f32(6.0)); c.w32(SIF + 0xB98, sim.f32(3.0))
    return c.module_call(1, SEQ, 0, SIF)

def press(c, seed, sv4=11.0, slots=(0, 1, 2, 3)):
    rg = np.random.default_rng(seed)
    img = rg.integers(0, 2000, size=(H, W), dtype=np.int32) + 600
    c.clock = (c.clock - 3 * 27000000) & 0xFFFFFFFF
    rs = []; n_fe = 0; fes = []
    for i in range(4):
        c.clock = (c.clock - 240 * 27000) & 0xFFFFFFFF
        while n_fe < min(4, i + 2): n_fe += 1; fes.append(fe(c, n_fe, sv4 if n_fe == 4 else 11.0))
        r = sim.Recipe(c, slots[i], W, H, sim.si_fields(sv=sv4 if i == 3 else 11.0, index=i)); c.w32(r.prop + 0x60, r.bayer)
        r.put_bayer(np.clip(img + rg.integers(-30, 31, size=(H, W)), 0, 16383).astype(np.uint16))
        c.w8(r.params + 0xD, 1); c.w8(r.params + 0xC, 1); c.w8(r.params + 0x1F, 1); c.w32(r.prop + 0x18, 0)
        for k, g in enumerate((2100 + 50 * i, 1024, 1024, 1600)): c.w16(r.shoot + 0x2EBE8 + 2 * k, g)
        rs.append(r)
        for m in ((9, 10, 2, 4, 6, 7) if i < 3 else (9,)): r.module(m)
    c.clock = (c.clock - 300 * 27000) & 0xFFFFFFFF
    for r in rs[:3]: r.module(8)
    for m in (10, 2, 4, 7, 8): rs[3].module(m)
    out = []
    for r in rs:
        prop = bytearray(c.rb(r.prop, 0x5000)); nofile = prop[CFG + 0x72]; prop[CFG + 0x72] = 0
        out.append(dict(bayer=h(c.rb(r.bayer, 2 * W * H)), si=h(c.rb(r.shoot, 0x74800)), params=h(c.rb(r.params, 0x100)), prop=h(bytes(prop)), nofile=nofile))
    return out, fes

def press_cam(c, seed, sv4=11.0, frames=4, shut_at=None, slots=(0, 1, 2, 3)):
    """one press in the order the upstream build's camera tests recorded (group logs: module marks): frame 1's whole chain, its store
    (module 8) included, runs after frame 2's module 9 and before frame 4's; frames 2 and 3 store after the merge.  frames: how many
    frames the burst gave (2 or 3: it stops; the group ends at the next module after the gap).  shut_at: 'before1' (the power key
    before frame 1's store) or 'merge' (during frame 4's module 9).  Returns each frame's "no file" byte and the group's results."""
    rg = np.random.default_rng(seed)
    img = rg.integers(0, 2000, size=(H, W), dtype=np.int32) + 600
    c.clock = (c.clock - 3 * 27000000) & 0xFFFFFFFF
    st = None; rs = []
    def frame(i):
        c.clock = (c.clock - 240 * 27000) & 0xFFFFFFFF
        fe(c, i + 1, sv4 if i == 3 else 11.0)
        r = sim.Recipe(c, slots[i], W, H, sim.si_fields(sv=sv4 if i == 3 else 11.0, index=i)); c.w32(r.prop + 0x60, r.bayer)
        r.put_bayer(np.clip(img + rg.integers(-30, 31, size=(H, W)), 0, 16383).astype(np.uint16))
        c.w8(r.params + 0xD, 1); c.w8(r.params + 0xC, 1); c.w8(r.params + 0x1F, 1); c.w32(r.prop + 0x18, 0)
        for k, g in enumerate((2100 + 50 * i, 1024, 1024, 1600)): c.w16(r.shoot + 0x2EBE8 + 2 * k, g)
        rs.append(r); return r
    def shut():
        stp = c.r32(c.slot); c.w32(stp + 0x30, LVC); c.w8(LVC + 0xE3, 1)
    frame(0).module(9)
    if frames >= 2: frame(1).module(9)
    if shut_at == 'before1': shut()
    for m in (10, 2, 4, 6, 7, 8): rs[0].module(m)                     # frame 1's chain and store setup, before frame 4's module 9
    if frames >= 3: frame(2).module(9)
    if frames >= 2:
        for m in (10, 2, 4, 6, 7): rs[1].module(m)
    if frames == 4:
        if shut_at == 'merge': shut()
        frame(3).module(9)
    else:
        c.clock = (c.clock - 3 * 27000000) & 0xFFFFFFFF               # the burst stopped: the group ends at the next module after the gap
    for m in ((8,) if frames >= 2 else ()): rs[1].module(m)
    if frames >= 3:
        for m in (10, 2, 4, 6, 7, 8): rs[2].module(m)
    if frames == 4:
        for m in (10, 2, 4, 7, 8): rs[3].module(m)
    return [c.r8(r.prop + CFG + 0x72) for r in rs]

def stock_view(c, up_hi):
    return dict(app=[p['args'][1] for p in c.app_posts if p['args'][1] != 0x17D], fe=[p['msg'] for p in c.fe_posts], frees=len(c.free_calls),
                live=sorted(c.pool_live), cur=cur_view(c, up_hi))

CIM_G, CIM, LCD_SLOT, CRM_G, CRM, BE_G, BE = 0x55083240, 0x55083138, 0x553A281C, 0x550830A0, 0x5508A010, 0x5537B218, 0x5537A540
LCD, CT = sim.OBJ + 0x3860000, sim.OBJ + 0x3C00000
LVC_VT, HIDE, EV_CTRL, OSD_FULL, DV_REQ, DV_T0 = 0x53DBF740, 0x4E5, 0x224, 0x122C, 0x1968, 0x196C
DISPATCH, EVT = 0x5325E4DC, sim.OBJ + 0x3D00000
NB_FLAGS = sim.CUR + 4 + 0x49

def ucam(rtos):
    c = cam(rtos); c.pb = []
    def pb(uc, *_): c.pb.append(c.reg(UC_ARM_REG_R1)); c._ret(0)
    c.mu.hook_add(UC_HOOK_CODE, pb, begin=0x53262D1C, end=0x53262D1C)
    c.module_call(5, 0, 0)
    st = c.r32(c.slot)
    c.w32(CIM_G, 1); c.wb(CIM, bytes(0x40)); c.w32(sim.APP_Q, 0x08000000); c.w8(sim.CUR + 0xB76, 1)
    c.w8(LVC + 0xE3, 0); c.w32(st + 0x30, LVC)
    c.wb(LCD, bytes(0x100)); c.w32(LCD_SLOT, LCD)
    c.wb(CT, bytes(0x600)); c.w32(CT, LVC_VT); c.w8(CT + HIDE, 1); c.w32(st + EV_CTRL, CT)
    c.w32(CRM_G, 1); c.wb(CRM, bytes(0x20)); c.w32(BE_G, 1); c.wb(BE + 0xCB0, bytes(0x20)); c.w8(BE + 0xCBD, 1)
    c.w8(NB_FLAGS, (c.r8(NB_FLAGS) & 3) | 4 | 2 << 3); c.w32(sim.CUR + 0x914, 0); c.w32(sim.CUR + 0x1458, 0)
    return c, st

def key(c, ev=0x001):
    c.wb(EVT, bytes(16)); c.w16(EVT, ev)
    for r, v in zip(sim.REGS, [0, EVT] + [0] * 11): c.mu.reg_write(r, v)
    c.mu.reg_write(UC_ARM_REG_SP, sim.STACK_TOP - 0x3000)
    c.mu.emu_start(DISPATCH, DISPATCH + 4, count=100000)

def useq(rtos, up, ev=None):
    c, st = ucam(rtos)
    trace = []
    def look(): return (c.rb(CIM, 0x40), c.rb(CT, 0x600), c.rb(LCD, 0x100), c.r32(st + OSD_FULL), cur_view(c, up), tuple(c.pb), c.r32(st + 4), c.r32(st + 0xC))
    c.w32(st + 4, 3)
    for t in range(0, 2000, 100):
        if ev == 'shot' and t == 1000: c.w8(CIM + 0x27, 1)
        c.module_call(5, 0, 0); c.clock = (c.clock - 2700000) & 0xFFFFFFFF; trace.append(look())
    c.w32(st + 4, 0); c.w32(st + DV_REQ, 0x101); c.w32(st + DV_T0, c.clock)
    for t in range(0, 6000, 100):
        if t == 500: c.w8(LCD + 0xAA, 1)
        if ev == 'key' and t == 700: key(c)
        if ev == 'nokey' and t == 700: key(c, 0x02E)
        if ev == 'release' and t == 700: c.w8(CIM + 0x27, 1)
        if ev == 'power' and t == 700: c.w8(LVC + 0xE3, 1)
        if ev == 'screen' and t == 700: c.w32(sim.APP_Q, 0x0800000D)
        n0 = len(c.pb)
        c.module_call(5, 0, 0); c.clock = (c.clock - 2700000) & 0xFFFFFFFF
        if len(c.pb) > n0: c.w8(LCD + 0xAA, 0)
        trace.append(look())
    return trace, list(c.pb)

if __name__ == '__main__':
    runs = {}
    for name, rt, up in BUILDS:
        c = cam(rt)
        seq = [press(c, 1), press(c, 2, slots=(4, 5, 0, 1)), press(c, 3, sv4=11.333), press(c, 4, slots=(2, 3, 4, 5))]
        logs = [read_mf.parse(b) for n, b in c.files if n.startswith('C:\\MF')]
        runs[name] = dict(seq=[s for s, _ in seq], fes=[f for _, f in seq], view=stock_view(c, up), results=[g['result'] for g in logs], card=list(c.card_opens),
                          sunk=list(c.sunk), merged=[g.get('merged') for g in logs])
    P = runs['test']; M = runs.get('other', P)
    BOTH = ': the same in both builds' if len(BUILDS) > 1 else ''
    check('B: 4 presses: merged, merged, not merged, merged' + (' (the same in both builds)' if len(BUILDS) > 1 else ''), P['results'] == M['results'] == [1, 1, 3, 1], str((P['results'], M['results'])))
    check('B: the front end\'s answers (4 frames per press)' + BOTH, P['fes'] == M['fes'], str((P['fes'], M['fes'])))
    check('B: every frame\'s Bayer data (the merged picture written back), ShootingInfo copy, params, recipe words' + BOTH, P['seq'] == M['seq'],
          str([(g, k) for g in range(4) for k in range(4) if P['seq'][g][k] != M['seq'][g][k]][:6]))
    check('B: the "no file" byte 1 1 1 0 in the merged presses, 0 0 0 0 in the other' + BOTH, [[f['nofile'] for f in p] for p in P['seq']] == [[f['nofile'] for f in p] for p in M['seq']] == [[1, 1, 1, 0], [1, 1, 1, 0], [0, 0, 0, 0], [1, 1, 1, 0]])
    check('B: App posts (but the wake-ups), front-end posts, frees, blocks left, settings' + BOTH, P['view'] == M['view'],
          str({k: (P['view'][k], M['view'][k]) for k in P['view'] if P['view'][k] != M['view'][k]}))
    check('B: no file opened on the card by either; the 4 group records only in the emulator\'s sink', not P['card'] and not M['card'] and len(P['sunk']) == len(M['sunk']) == 4)
    
    for ev, want in ((None, [0x4441100C]), ('key', []), ('nokey', [0x4441100C]), ('release', []), ('power', []), ('screen', []), ('shot', [])):
        tr = {name: useq(rt, up, ev) for name, rt, up in BUILDS}
        tr.setdefault('other', tr['test'])
        same = tr['test'][0] == tr['other'][0]
        first = next((i for i, (a, b) in enumerate(zip(tr['test'][0], tr['other'][0])) if a != b), None)
        check(f'U: merge, end, window ({ev or "nothing else"}): CIM, controller, LCD, processing screen word, settings, busy / percent and playback posts after every one of 80 loops: '
              f'{"the same in both builds; " if len(BUILDS) > 1 else ""}posts {[hex(x) for x in want]}', same and tr['test'][1] == want, str((same, first, [hex(x) for x in tr['test'][1]], [hex(x) for x in tr['other'][1]])))
    # ---- F: frame 1 stored before the result (KEEP_FIRST) ------------------------------------------------------------------------
    # each case in a fresh emulator; "kept" = frames whose "no file" byte is 0 (stored), with the merged frame (frame 4 of a merged group)
    def fcase(name, **kw):
        c = cam(BUILDS[0][1]); nf = press_cam(c, 7, **kw)
        c.clock = (c.clock - 3 * 27000000) & 0xFFFFFFFF; fe(c, 1, 9.0)              # (a later shot: the group's log is complete)
        logs = [read_mf.parse(b) for n, b in c.files if n.startswith('C:\\MF')]
        g = logs[-1] if logs else {}
        return nf, (g.get('result'), (g.get('v22') or {}).get('keep', [None])[0] & 0xFF if g.get('v22') else None)
    cases = [('merged', dict(), [1, 1, 1, 0], (1, 10)),
             ('not merged (frame 4 at another exposure)', dict(sv4=11.333), [1, 0, 0, 0], (3, 10)),
             ('the burst gave 3 frames', dict(frames=3), [1, 0, 0], (2, 10)),
             ('the burst gave 2 frames', dict(frames=2), [1, 0], (2, 10)),
             ('the burst gave 1 frame (frame 1 alone at its store: no group, no log)', dict(frames=1), [0], None),
             ('power key before frame 1\'s store', dict(shut_at='before1'), [0, 0, 0, 0], None),
             ('power key during the merge', dict(shut_at='merge'), [1, 0, 0, 0], None)]
    for name, kw, want, res in cases:
        nf, got = fcase(name, **kw)
        kept = [i + 1 for i, b in enumerate(nf) if b == 0]
        check(f'F: {name}: "no file" bytes {nf} (want {want}); stored frames {kept}{"; group result / frame 1 reason " + str(got) if res else ""}; '
              f'at least one picture of the press stays', nf == want and len(kept) >= 1 and (res is None or got == res), str((nf, got)))
    print('ALL PASS' if not fails else f'{fails} FAILED')
    sys.exit(1 if fails else 0)
