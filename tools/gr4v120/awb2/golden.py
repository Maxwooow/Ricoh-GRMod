# SPDX-License-Identifier: GPL-2.0-only
"""Golden (float) behaviour of the rewritten GR IV auto white balance. The camera module must match this within its stated tolerance.

Units: an illuminant is (u, v) = (ln G/R, ln G/B) in statistics space; warmth x = log2(R/B) = (v - u) / ln 2.
One estimator, one state:
  observe()   single-frame illuminant estimate (model.py) and its uncertainty
  render()    the mode's deliberate retention of a warm light's colour (explicit, zero at and beyond daylight)
  Preview     live view: a per-axis Kalman filter over the observations; restarts on a confirmed scene change
  still()     the capture takes the preview's state (so the picture is what the screen showed) unless its own estimate is far
              from it (flash, the scene changed during the press) or there is no usable preview state.
"""
import math
import numpy as np
import model

LN2 = math.log(2.0)
AUTO, WARM, WHITE = 0, 1, 2
RETAIN = {WHITE: 0.0, AUTO: 0.10, WARM: 0.35}     # warmth (log2 R/B of a neutral) left at and below X_FULL
X_ZERO, X_FULL = -0.70, 0.90                      # statistics-space warmth: no retention at / cooler than X_ZERO (~5000 K), full at X_FULL (~2850 K)
Q = 0.004 ** 2                                    # process noise per computed frame (log units^2)
R_MIN, R_MAX = 0.01 ** 2, 0.25 ** 2               # clamps of the observation variance
GATE = 9.0                                        # scene change: innovation^2 > GATE (sigma^2 + r) on an axis, two computed frames in a row
STILL_FAR = 0.40                                  # log2 units: only a gross difference (flash, another scene) makes a still use its own estimate
MIN_VALID = 0.05                                  # at least 5 % of the frame valid, else the camera's own result stays


def observe(rgb, w, ev):
    u, v, vu, vv, wsum = model.estimate(rgb, w, ev)
    if wsum < MIN_VALID * w.size:
        return None
    return np.array([u, v]), np.clip(np.array([vu, vv]), R_MIN, R_MAX)


def warmth(z):
    return (z[1] - z[0]) / LN2


def tint(z):
    return -(z[0] + z[1]) / (2 * LN2)             # log2 sqrt(R B) / G


def render(z, mode):
    """The illuminant to correct for: the estimate moved towards neutral-daylight along pure warmth by the mode's retention."""
    s = min(max((warmth(z) - X_ZERO) / (X_FULL - X_ZERO), 0.0), 1.0)
    k = RETAIN[mode] * s * LN2 / 2
    return np.array([z[0] + k, z[1] - k])


class Preview:
    """Live view state (model units, before render): the filtered estimate the screen shows."""

    def __init__(self):
        self.mu = None; self.sg = None; self.cand = None

    def update(self, obs):
        if obs is None:
            return self.mu
        z, r = obs
        if self.mu is None:
            self.mu, self.sg, self.cand = z.copy(), r.copy(), None
            return self.mu
        sg = self.sg + Q
        far = (z - self.mu) ** 2 > GATE * (sg + r)
        if far.any():
            if self.cand is not None and np.all(np.abs(z - self.cand) < 3 * np.sqrt(r + R_MIN) + 0.03):
                self.mu, self.sg, self.cand = (z + self.cand) / 2, r.copy(), None       # confirmed: restart at the new scene
            else:
                self.cand, self.sg = z.copy(), sg                                        # hold the state one more frame
            return self.mu
        self.cand = None
        k = sg / (sg + r)
        self.mu = self.mu + k * (z - self.mu); self.sg = (1 - k) * sg
        return self.mu


def still(obs, preview):
    """-> (illuminant in model units, 'preview' | 'own')."""
    if preview is None or preview.mu is None:
        return (None if obs is None else obs[0]), 'own'
    if obs is None:
        return preview.mu, 'preview'
    z = obs[0]
    if abs(warmth(z) - warmth(preview.mu)) > STILL_FAR or abs(tint(z) - tint(preview.mu)) > STILL_FAR:
        return z, 'own'
    return preview.mu, 'preview'


if __name__ == '__main__':
    import os
    D = os.environ['GRIV_DATA']
    pr = np.load(f'{D}/learnawb/cube_eval_preds.npz', allow_pickle=True)
    names = [str(n) for n in pr['names']]; te = np.where(~pr['tr'])[0]; gt = pr['gt']
    rng = np.random.default_rng(1)
    rows = []
    for i in te:
        z_ = np.load(f'{D}/cubepp_gr/{names[i]}.npz', allow_pickle=True)
        rgb, w = model.from_s(z_['s']); ev = float(z_['Av']) + float(z_['Tv']) - float(z_['Sv'])
        o = observe(rgb, w, ev)
        tz = np.array([-math.log(gt[i][0]), -math.log(gt[i][2])])
        # preview: 12 noisy live-view frames of the same scene (1.5 % sensor / sampling noise, +-0.3 EV metering jitter), then the capture
        p = Preview()
        for _ in range(12):
            n = rgb * rng.normal(1.0, 0.015, rgb.shape)
            p.update(observe(n, w, ev + rng.normal(0, 0.3)))
        zs, src = still(o, p)
        row = dict(x=warmth(tz), src=src, pv_minus_still=warmth(p.mu) - warmth(zs), own_minus_pv=warmth(o[0]) - warmth(p.mu))
        for m in (WHITE, AUTO, WARM):
            row[m] = warmth(tz) - warmth(render(zs, m))
        rows.append(row)
    x = np.array([r['x'] for r in rows]); ok = np.abs(np.array([r[WHITE] for r in rows])) < 0.8
    print(f'n {len(rows)} (extreme orange lights excluded: {int((~ok).sum())})')
    print('still source: preview %d, own %d' % (sum(r['src'] == 'preview' for r in rows), sum(r['src'] == 'own' for r in rows)))
    d = np.array([r['pv_minus_still'] for r in rows]); print('preview minus capture warmth: max |d| %.4f' % np.abs(d).max())
    d = np.array([r['own_minus_pv'] for r in rows]); print('single-frame still estimate minus preview state: median |d| %.3f p95 %.3f' % (np.median(np.abs(d)), np.percentile(np.abs(d), 95)))
    print('residual warmth, median (White / Auto / Warmth), and share of scenes with |Auto| <= 0.15:')
    for name, lo, hi in (('shade / cloudy', -9, -1.28), ('daylight', -1.28, -0.88), ('warm daylight', -0.88, -0.48), ('3500-4500 K', -0.48, 0.42), ('tungsten', 0.42, 9)):
        m = ok & (x >= lo) & (x < hi)
        a = np.array([r[AUTO] for r in rows])[m]
        print(f'  {name:15s} n={int(m.sum()):3d}  ' + '  '.join(f'{np.median(np.array([r[k] for r in rows])[m]):+.3f}' for k in (WHITE, AUTO, WARM)) + f'   {100 * np.mean(np.abs(a) <= 0.15):.0f}%')
