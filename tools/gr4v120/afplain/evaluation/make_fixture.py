#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Write the live-view frames the emulator checks feed the module (native_plain_probe.py --fixture-dir, and AF_FIXTURES of
test_plain_units.py): one synthetic scene as NV12 at each live-view size (aspect 0 720x480, 1 720x404, 2 640x480,
3 480x480, 7 720x264, 8 720x300) and fixture.json with their SHA-256.

  make_fixture.py OUT_DIR

The scene is drawn here, deterministically (no photo): a soft vertical gradient with a little noise, and off the centre a
bright textured ellipse on a darker disc, so that the network has something to pick. The checks are about the camera's
own code around the hooks and the module's path through it, not about how well the network picks."""
import hashlib, json, sys
from pathlib import Path
import numpy as np

SIZES = [(0, 720, 480), (1, 720, 404), (2, 640, 480), (3, 480, 480), (7, 720, 264), (8, 720, 300)]


def scene(w, h):
    rng = np.random.default_rng(20261124)
    noise = rng.integers(-6, 7, size=(480, 720))
    y, x = np.mgrid[0:480, 0:720].astype(np.float64)
    base = 70 + 50 * y / 480 + noise
    r, g, b = base * 0.9, base, base * 1.1
    cx, cy = 470, 210
    disc = (x - cx) ** 2 + (y - cy) ** 2 < 120 ** 2
    ell = ((x - cx) / 80) ** 2 + ((y - cy) / 60) ** 2 < 1
    stripes = 40 * np.sin(x / 6.0) * np.cos(y / 9.0)
    for c, k in ((r, 0.35), (g, 0.3), (b, 0.25)):
        c[disc] = 255 * k
    r[ell], g[ell], b[ell] = 220 + stripes[ell], 150 + stripes[ell], 60 + stripes[ell] / 2
    rgb = np.clip(np.stack([r, g, b], -1), 0, 255)
    # nearest-neighbour resize to the live-view size
    ys = (np.arange(h) * 480 // h).clip(0, 479); xs = (np.arange(w) * 720 // w).clip(0, 719)
    return rgb[ys][:, xs]


def nv12(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    yy = np.clip(np.rint(.299 * r + .587 * g + .114 * b), 0, 255).astype(np.uint8)
    u = np.clip(np.rint(-.168736 * r - .331264 * g + .5 * b + 128), 0, 255).astype(np.uint8)[::2, ::2]
    v = np.clip(np.rint(.5 * r - .418688 * g - .081312 * b + 128), 0, 255).astype(np.uint8)[::2, ::2]
    uv = np.empty((rgb.shape[0] // 2, rgb.shape[1]), np.uint8); uv[:, ::2] = u; uv[:, 1::2] = v
    return yy.tobytes(), uv.tobytes()


def main():
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    rows = []
    for aspect, w, h in SIZES:
        y, uv = nv12(scene(w, h))
        (out / f'aspect{aspect}-y.bin').write_bytes(y); (out / f'aspect{aspect}-uv.bin').write_bytes(uv)
        rows.append(dict(aspect=aspect, width=w, height=h, ySha256=hashlib.sha256(y).hexdigest(), uvSha256=hashlib.sha256(uv).hexdigest(),
                         yFile=f'aspect{aspect}-y.bin', uvFile=f'aspect{aspect}-uv.bin'))
    (out / 'fixture.json').write_text(json.dumps(dict(schema='subjectaf-synthetic-fixture-v1', source='make_fixture.py', rows=rows), indent=1) + '\n')
    print(json.dumps(dict(out=str(out), rows=len(rows))))


if __name__ == '__main__':
    main()
