# SPDX-License-Identifier: GPL-2.0-only
"""ctypes wrapper of the host build of awb2.c."""
import ctypes, os, struct, subprocess, tempfile
import numpy as np
import tables

HERE = os.path.dirname(os.path.abspath(__file__))
T, C = tables.build()
open(os.path.join(HERE, 'awb2_const.h'), 'w').write(tables.header(C))


def build(flags=('-O2',)):
    out = os.path.join(tempfile.mkdtemp(prefix='awb2'), 'awb2.dylib')
    subprocess.run(['cc', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC', *flags, os.path.join(HERE, 'host.c'), '-o', out], check=True)
    lib = ctypes.CDLL(out)
    P = lambda k: T[k].ctypes.data_as(ctypes.c_void_p)
    lib.host_init(P('lnm'), P('ff'), P('bias'), P('tw'), P('tanh'), P('exp2n'), P('atan'), P('cs20'), P('rc'))
    return lib


def pack(rgb, w, e30, v24=0, mode=0, s68=0x2000, s6e=0x2000, x0=0, y0=0, stride=None, full=1584):
    """rgb (h, w, 3), w (h, w) valid weight -> (memory, S offset): the arrays and a settings block as the camera passes them."""
    hh, ww = w.shape
    stride = stride or ww
    n = (y0 + hh) * stride
    arrs = []
    cnt = np.round(w * full).astype(np.uint32)                  # full: pixels per block (1584 in a still, fewer in live view)
    for a in (rgb[..., 0], rgb[..., 1], rgb[..., 1], rgb[..., 2], cnt):
        full = np.zeros((y0 + hh, stride), np.uint32); full[y0:, x0:x0 + ww] = np.round(a).astype(np.uint32)
        arrs.append(full.ravel())
    mem = bytearray(0x100)
    offs = []
    for a in arrs:
        offs.append(len(mem)); mem += a.tobytes()
    S = bytearray(0x80)
    struct.pack_into('<5I', S, 0, *offs)
    struct.pack_into('<H', S, 0x14, stride); struct.pack_into('<4H', S, 0x1c, x0, y0, ww, hh)
    struct.pack_into('<i', S, 0x24, v24); struct.pack_into('<i', S, 0x30, e30); struct.pack_into('<I', S, 0x34, mode)
    struct.pack_into('<H', S, 0x68, s68); struct.pack_into('<H', S, 0x6e, s6e)
    s_off = len(mem); mem += S
    return bytes(mem), s_off
