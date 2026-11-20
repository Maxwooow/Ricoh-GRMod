# SPDX-License-Identifier: GPL-2.0-only
"""Own float reference of the trained illuminant model (parameters model/illum_v2.npz: F[2][64][64] filters, B[4][64][64] bias maps: known brightness x [1, e, tanh 2e], and one for unknown brightness).

Written from the model definition only (log-chroma histograms on a 64 x 64 torus, FFT convolution, brightness-dependent bias,
softmax, circular mean). This file is the golden reference for the rewritten camera module.
"""
import math
import os
import numpy as np

N, H, U0, V0 = 64, 1.0 / 32, 0.0, -0.2
STAT_F = np.array([0.920, 1.0, 0.974])           # GR IV statistics space vs raw
PARAMS = os.environ.get('AWB2_PARAMS', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model', 'illum_v2.npz'))
_P = None


def params():
    global _P
    if _P is None:
        z = np.load(PARAMS)
        _P = dict(F=np.asarray(z['F'], float), B=np.asarray(z['B'], float))
        _P['Ff'] = np.fft.fft2(_P['F'])
    return _P


def histograms(rgb, w):
    """rgb (h, w, 3) block means, w (h, w) valid weight (count / 1584). -> two normalised (64, 64) histograms."""
    ok = (w > 0.2) & (rgb.min(-1) >= 4) & (rgb.max(-1) <= 0xF6D)
    w = np.where(ok, w, 0.0)

    def hist(c, wt):
        u = np.log((c[..., 1] + 1.0) / (c[..., 0] + 1.0)); v = np.log((c[..., 1] + 1.0) / (c[..., 2] + 1.0))
        iu = np.floor((u - U0) / H).astype(np.int64) % N; iv = np.floor((v - V0) / H).astype(np.int64) % N
        h = np.zeros((N, N)); np.add.at(h, (iu.ravel(), iv.ravel()), wt.ravel())
        t = h.sum()
        return h / t if t > 0 else h
    h1 = hist(rgb, w)
    pad = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode='edge'); wp = np.pad(w, 1)
    acc = np.zeros_like(rgb); cnt = np.zeros_like(w)
    hh, ww_ = w.shape
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0: continue
            sl = (slice(1 + dy, 1 + dy + hh), slice(1 + dx, 1 + dx + ww_))
            m = wp[sl] > 0
            acc += pad[sl] * m[..., None]; cnt += m
    edge = np.abs(rgb - acc / np.maximum(cnt, 1)[..., None])
    we = np.where((w > 0) & (cnt > 0), edge.sum(-1), 0.0)
    return np.stack([h1, hist(edge, we)]), float(w.sum())


def posterior(hists, ev):
    """Softmax over the torus given the histograms and the scene brightness ev = Av + Tv - Sv (None: unknown -> the fourth bias map alone, the
    prior over all brightnesses)."""
    p = params()
    if ev is None: feats = np.array([0.0, 0.0, 0.0, 1.0])
    else:
        e = (ev - 4.0) / 4.0
        feats = np.array([1.0, e, math.tanh(2.0 * e), 0.0])
    s = np.real(np.fft.ifft2(np.fft.fft2(hists) * p['Ff'])).sum(0) + np.einsum('k,kij->ij', feats, p['B'])
    s = s - s.max()
    P = np.exp(s)
    return P / P.sum()


def circ(pm):
    ang = 2 * np.pi * np.arange(N) / N
    c, s = (pm * np.cos(ang)).sum(), (pm * np.sin(ang)).sum()
    m = math.atan2(s, c) % (2 * np.pi) / (2 * np.pi) * N
    r = math.hypot(c, s)                                  # resultant length: 1 = one sharp peak
    var = max(-2.0 * math.log(max(r, 1e-12)), 0.0) * (N / (2 * np.pi)) ** 2 * H * H     # circular variance in log units^2
    return m, var


def estimate(rgb, w, ev):
    """-> (u, v, var_u, var_v, valid weight) with u = ln(G/R), v = ln(G/B) of the illuminant in statistics space."""
    hs, wsum = histograms(rgb, w)
    P = posterior(hs, ev)
    mu, vu = circ(P.sum(1)); mv, vv = circ(P.sum(0))
    return U0 + (mu + 0.5) * H, V0 + (mv + 0.5) * H, vu, vv, wsum


def from_s(s):
    """(4, 64, 64) [R, G, B, D] scene pack (rows 1..62 used) -> rgb, w."""
    s = np.asarray(s)
    return np.stack([s[0, 1:63], s[1, 1:63], s[2, 1:63]], -1).astype(float), s[3, 1:63].astype(float) / 1584.0


if __name__ == '__main__':
    import sys, os, glob
    D = os.environ['GRIV_DATA']
    pr = np.load(f'{D}/learnawb/cube_eval_preds.npz', allow_pickle=True)
    names = [str(n) for n in pr['names']]; te = ~pr['tr']; gt = pr['gt']; old = pr['learned_+_exposure']
    def ang(a, b):
        a = a / np.linalg.norm(a, axis=-1, keepdims=True); b = b / np.linalg.norm(b, axis=-1, keepdims=True)
        return np.degrees(np.arccos(np.clip((a * b).sum(-1), -1, 1)))
    mine = np.zeros_like(gt)
    idx = np.where(te)[0]
    for i in idx:
        z = np.load(f'{D}/cubepp_gr/{names[i]}.npz', allow_pickle=True)
        u, v, *_ = estimate(*from_s(z['s']), float(z['Av']) + float(z['Tv']) - float(z['Sv']))
        mine[i] = [math.exp(-u), 1.0, math.exp(-v)]
    print('own float model vs measured illuminant: mean %.3f median %.3f deg (n=%d)' % (ang(mine[te], gt[te]).mean(), np.median(ang(mine[te], gt[te])), te.sum()))
