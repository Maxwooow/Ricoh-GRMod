# SPDX-License-Identifier: GPL-2.0-only
"""awb2.c single-frame estimate against the float reference on the 462 held-out scenes."""
import ctypes, math, os, sys
import numpy as np
import model, golden, hostlib

lib = hostlib.build()
D = os.environ['GRIV_DATA']
pr = np.load(f'{D}/learnawb/cube_eval_preds.npz', allow_pickle=True)
names = [str(n) for n in pr['names']]; te = np.where(~pr['tr'])[0]
du, dv, rr = [], [], []
for i in te[:: int(os.environ.get('STEP', '1'))]:
    z_ = np.load(f'{D}/cubepp_gr/{names[i]}.npz', allow_pickle=True)
    rgb, w = model.from_s(z_['s']); ev = float(z_['Av']) + float(z_['Tv']) - float(z_['Sv'])
    e30 = int(round(ev * 256))
    o = golden.observe(rgb, w, e30 / 256)
    mem, s_off = hostlib.pack(rgb, w, e30)
    buf = ctypes.create_string_buffer(mem, len(mem))
    z = (ctypes.c_int * 2)(); r = (ctypes.c_uint * 2)()
    ok = lib.host_observe(buf, ctypes.byref(buf, s_off), 1, e30, z, r)
    assert bool(ok) == (o is not None), names[i]
    if o is None: continue
    du.append(z[0] / 65536 - o[0][0]); dv.append(z[1] / 65536 - o[0][1])
    rr.append([r[0] / 2 ** 32 / o[1][0], r[1] / 2 ** 32 / o[1][1]])
du, dv, rr = np.abs(du), np.abs(dv), np.array(rr)
L2 = math.log(2)
print(f'n {len(du)}: |du| median {np.median(du):.5f} p99 {np.percentile(du, 99):.5f} max {du.max():.5f};  |dv| median {np.median(dv):.5f} p99 {np.percentile(dv, 99):.5f} max {dv.max():.5f}  (log units; 0.0069 = 0.01 log2)')
print(f'variance ratio C / float: median {np.median(rr):.3f} p1 {np.percentile(rr, 1):.3f} p99 {np.percentile(rr, 99):.3f}')
