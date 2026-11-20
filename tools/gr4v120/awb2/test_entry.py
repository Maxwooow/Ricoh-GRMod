# SPDX-License-Identifier: GPL-2.0-only
"""awb2.c whole entry against golden.py: live view sequences (period 4), captures, the three modes, a flash-like change, edge cases."""
import ctypes, math, os
import numpy as np
import model, golden, hostlib, tables

lib = hostlib.build()
san = hostlib.build(('-O1', '-g', '-fsanitize=undefined', '-fno-sanitize-recover=undefined'))
D = os.environ['GRIV_DATA']
pr = np.load(f'{D}/learnawb/cube_eval_preds.npz', allow_pickle=True)
names = [str(n) for n in pr['names']]; te = np.where(~pr['tr'])[0]
rng = np.random.default_rng(7)
KR, KB = tables.KR * model.STAT_F[0], tables.KB * model.STAT_F[2]


def call(L, rgb, w, e30, mode, still, s68=0x2000, s6e=0x2000, v24=0, **kw):
    mem, s_off = hostlib.pack(rgb, w, e30, v24=v24, mode=mode, s68=s68, s6e=s6e, **kw)
    buf = ctypes.create_string_buffer(mem, len(mem))
    obj = ctypes.create_string_buffer(0xb000)
    L.host_call(buf, obj, ctypes.byref(buf, s_off), int(still))
    g = np.frombuffer(obj, dtype='<u2', count=6)
    return int(g[2]), int(g[5])                  # obj+4, obj+0xA


def want(z, mode, s68=0x2000, s6e=0x2000):
    zr = golden.render(z, mode)
    return KR * 8192 * math.exp(zr[0]) * s68 / 0x2000, KB * 8192 * math.exp(zr[1]) * s6e / 0x2000


def scene(i):
    z_ = np.load(f'{D}/cubepp_gr/{names[i]}.npz', allow_pickle=True)
    rgb, w = model.from_s(z_['s'])
    return rgb, w, int(round((float(z_['Av']) + float(z_['Tv']) - float(z_['Sv'])) * 256))


LVFULL = 96        # pixels per block of a live view frame (the flash study's records of the AE frames: 96); any value must work
bad = []; nseq = ncall = 0; worst = 0.0; eq = 0; order = 0
for i in te[::6]:
    rgb, w, e30 = scene(i)
    for L in (lib, san):
        L.host_reset()
    mode = int(rng.integers(0, 3)); s68, s6e = (0x2000, 0x2000) if nseq % 2 else (12800, 24730)
    p = golden.Preview(); last = None; pend = None
    wl = np.round(w * LVFULL) / LVFULL                      # live view blocks hold LVFULL pixels, a still's 1584
    for f in range(13):
        n = np.clip(np.round(rgb * rng.normal(1.0, 0.015, rgb.shape)), 0, 4095)
        g = call(lib, n, wl, e30, mode, False, s68, s6e, full=LVFULL); g2 = call(san, n, wl, e30, mode, False, s68, s6e, full=LVFULL)
        if g != g2: bad.append(('sanitizer build differs', names[i], f))
        if f % 4 == 1: p.update(pend)                       # a computation takes two calls: frame f's statistics, applied on call f + 1
        if f % 4 == 0: pend = golden.observe(n, wl, e30 / 256)
        if p.mu is None: continue                           # nothing written yet: the camera's own result stays
        e = want(p.mu, mode, s68, s6e)
        err = max(abs(g[0] / e[0] - 1), abs(g[1] / e[1] - 1)); worst = max(worst, err); ncall += 1
        if err > 0.003: bad.append(('live gains', names[i], f, g, e))
        last = g
    # capture of the same scene: exactly the gains the screen had
    gs = call(lib, rgb, w, e30, mode, True, s68, s6e)
    if gs != last: bad.append(('capture != preview', names[i], gs, last))
    else: eq += 1
    # the three modes on the capture
    gm = {m: call(lib, rgb, w, e30, m, True, s68, s6e) for m in (golden.WHITE, golden.AUTO, golden.WARM)}
    if not (gm[2][0] <= gm[0][0] <= gm[1][0] and gm[2][1] >= gm[0][1] >= gm[1][1]): bad.append(('mode order', names[i], gm))
    else: order += 1
    # a flash-like change: the capture is lit very differently from the preview -> its own estimate
    j = te[(np.searchsorted(te, i) + len(te) // 2) % len(te)]
    rgb2, w2, e2 = scene(j)
    o2 = golden.observe(rgb2, w2, e2 / 256)
    if o2 is not None:
        zs, src = golden.still(o2, p)
        gf = call(lib, rgb2, w2, e2, mode, True, s68, s6e); e = want(zs, mode, s68, s6e)
        if max(abs(gf[0] / e[0] - 1), abs(gf[1] / e[1] - 1)) > 0.003: bad.append(('changed-scene capture', names[i], names[j], src, gf, e))
    nseq += 1
print(f'sequences {nseq}, live calls {ncall}: worst gain error vs the float reference {100 * worst:.3f} %; capture == preview gains (bit for bit) {eq}/{nseq}; mode order {order}/{nseq}')

# edge cases
rgb, w, e30 = scene(te[0])
lib.host_reset()
g0 = call(lib, rgb, w, e30, 4, False)                      # a preset mode: nothing written
g1 = call(lib, rgb, np.zeros_like(w), e30, 0, False)       # no valid block: nothing written, no state
g2 = call(lib, rgb, w, e30, 0, True)                       # a capture with no preview state: its own estimate
o = golden.observe(rgb, w, e30 / 256); e = want(o[0], 0)
print('preset mode untouched', g0 == (0, 0), '| empty frame untouched', g1 == (0, 0), '| capture without preview = own estimate', abs(g2[0] / e[0] - 1) < 0.003 and abs(g2[1] / e[1] - 1) < 0.003)
if g0 != (0, 0) or g1 != (0, 0): bad.append(('edge', g0, g1))
g3 = call(lib, rgb, w, 100000, 0, True); g4 = call(lib, rgb, w, e30, 0, True, v24=-0x880)       # absurd / missing exposure: the no-exposure prior
on = golden.observe(rgb, w, None); en = want(on[0], 0)
lib.host_reset(); g3 = call(lib, rgb, w, 100000, 0, True); lib.host_reset(); g4 = call(lib, rgb, w, e30, 0, True, v24=-0x880)
print('missing exposure handled', g3 == g4 and abs(g3[0] / en[0] - 1) < 0.003)
if g3 != g4: bad.append(('missing exposure', g3, g4))
# offsets and stride
lib.host_reset(); ga = call(lib, rgb, w, e30, 0, True); lib.host_reset(); gb = call(lib, rgb, w, e30, 0, True, x0=3, y0=2, stride=80)
print('window offset / stride invariant', ga == gb)
if ga != gb: bad.append(('stride', ga, gb))
# the diagnostic record
import struct
def diag(L):
    b = ctypes.create_string_buffer(64); n = L.host_diag(b)
    k = ('magic lv_calls lv_done lv_e30 lv_exp lv_mode cap_exp cap_path lv_mu0 lv_mu1 cap_e30 cap_v24 cap_z0 cap_z1 cap_r0 cap_r1 '
         'cap_n cap_valid cap_few cap_bright cap_gr cap_gb lv_valid cap_mode caps').split()
    return n, dict(zip(k, struct.unpack('<IHHiBBBBiiiiiiIIHHHHHHHBB', b.raw)))
lib.host_reset()
for f in range(12): call(lib, rgb, w, 100000, 0, False)                 # live view without a usable brightness
gl = call(lib, rgb, w, e30, 0, True); n, d = diag(lib)
okd = (n == 64 and d['magic'] == 0x31445741 and d['lv_calls'] == 12 and d['lv_done'] >= 1 and d['lv_e30'] == 100000 and d['lv_exp'] == 0
       and d['cap_exp'] == 1 and d['cap_e30'] == e30 and d['cap_path'] == 1 and (d['cap_gr'], d['cap_gb']) == gl and d['caps'] == 1
       and d['cap_n'] == w.size and d['cap_valid'] + d['cap_few'] + d['cap_bright'] <= d['cap_n'] and d['cap_valid'] == d['lv_valid'] and d['lv_mu0'] != 0)
rgb2, w2, e2 = scene(te[len(te) // 2]); bright = rgb2.copy(); bright[:20] = 4000; w3 = w2.copy(); w3[20:30] = 0.1
c3 = np.round(w3 * 1584); few = c3 * 5 <= 1584; nf = int(few.sum()); nb = int((~few & (np.round(bright).max(-1) > 0xF6D)).sum())
gf = call(lib, bright, w3, e2, 0, True, v24=-0x880); n, d2 = diag(lib)
okd = okd and d2['cap_exp'] == 0 and d2['cap_v24'] == -0x880 and d2['cap_few'] == nf and d2['cap_bright'] == nb and nb >= 1000 and d2['caps'] == 2 and d2['cap_path'] in (1, 2) and (d2['cap_gr'], d2['cap_gb']) == gf
call(lib, rgb, w, e30, 4, True); n, d3 = diag(lib)
okd = okd and d3['cap_path'] == 4 and d3['cap_mode'] == 4 and d3['caps'] == 3
# a capture between the two halves of a live view computation: each uses its own work arrays
lib.host_reset(); call(lib, rgb, w, e30, 0, False); ref = call(lib, rgb, w, e30, 0, False)
lib.host_reset(); call(lib, rgb, w, e30, 0, False); gc = call(lib, rgb2, w2, e2, 0, True); got = call(lib, rgb, w, e30, 0, False)
lib.host_reset(); gc0 = call(lib, rgb2, w2, e2, 0, True)
print('capture inside a live view computation: both intact', ref == got and gc == gc0 and ref != (0, 0))
if not (ref == got and gc == gc0 and ref != (0, 0)): bad.append(('interleave', ref, got, gc, gc0))
# the pixel count per block: live view frames of any block size give a state, the same one; a live view frame whose blocks all
# have clipped pixels is measured against the fullest block seen before; a still with small blocks (crop) is estimated too
res = {}
for full in (1584, 96, 25):
    lib.host_reset(); wq = np.round(w * 24) / 24
    for _ in range(6): g = call(lib, rgb, wq, e30, 0, False, full=full)
    res[full] = g
lib.host_reset()
for _ in range(6): call(lib, rgb, w, e30, 0, False, full=96)
for _ in range(8): ghalf = call(lib, rgb, w * 0.1, e30, 0, False, full=96)      # a tenth of every block counted: too few, the state stays
gcrop = call(lib, rgb, w, e30, 0, True, full=200); lib.host_reset(); gcrop0 = call(lib, rgb, w, e30, 0, True, full=200); lib.host_reset(); gst = call(lib, rgb, w, e30, 0, True)
okc = res[1584] != (0, 0) and res[96] == res[1584] and res[25] == res[1584] and ghalf == res[96] and gcrop0 != (0, 0) and max(abs(gcrop0[0] / gst[0] - 1), abs(gcrop0[1] / gst[1] - 1)) < 0.003
print('block pixel count: live view of any block size estimates, same result', okc)
if not okc: bad.append(('count scale', res, ghalf, gcrop0, gst))
# flash: the camera's own result stays for a picture the flash lit (a flash there, and the release sequence not left waiting
# for its charge); a flash that was not ready, or no flash (whatever the sequence's byte holds), changes nothing
lib.host_reset(); call(lib, rgb, w, e30, 0, False); call(lib, rgb, w, e30, 0, False); gno = call(lib, rgb, w, e30, 0, True)
lib.host_set_flash(0x10, 0); gfl = call(lib, rgb, w, e30, 0, True); n, d4 = diag(lib)
lib.host_set_flash(0x10, 1); gnr = call(lib, rgb, w, e30, 0, True)
lib.host_set_flash(0, 0); gt0 = call(lib, rgb, w, e30, 0, True)
lib.host_set_flash(2, 0); gp = call(lib, rgb, w, e30, 0, True)
lib.host_set_flash(0x10, 0); call(lib, rgb, w, e30, 0, False); glv = call(lib, rgb, w, e30, 0, False)       # live view is never affected
lib.host_set_flash(-1, 0)
okf = gno != (0, 0) and gfl == (0, 0) and d4['cap_path'] == 5 and gnr == gno and gt0 == gno and gp == (0, 0) and glv != (0, 0)
print('flash picture keeps the camera result', okf)
if not okf: bad.append(('flash', gno, gfl, d4, gnr, gt0, gp))
print('diagnostic record', okd)
if not okd: bad.append(('diag', d, d2, d3))
for b in bad[:8]: print('MISMATCH', b)
print('RESULT', 'FAIL' if bad else 'all passed')
