"""Estimate the isolated RGB-curve change on an old JPG, not a new camera capture."""
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('correction', type=Path)
p.add_argument('jpeg', type=Path)
p.add_argument('output', type=Path)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
r = json.loads(a.correction.read_text())
old = np.array(r['before']['curves'], float) / 16383
new = np.array(r['after']['curves'], float) / 16383
x = np.arange(256) * 64 / 16383
with Image.open(a.jpeg) as im:
    im = im.convert('RGB')
    im.thumbnail((1200, 800), Image.Resampling.LANCZOS)
    pixels = np.array(im, dtype=float) / 255
out = np.empty_like(pixels)
invalid = np.zeros(pixels.shape[:2], bool)
for ch in range(3):
    vals, indices = np.unique(old[ch], return_index=True)
    inv = np.interp(pixels[:, :, ch], vals, x[indices])
    out[:, :, ch] = np.interp(inv, x, new[ch])
    invalid |= (pixels[:, :, ch] <= vals[0] + 2/255) | (pixels[:, :, ch] >= vals[-1] - 2/255)
newim = Image.fromarray(np.round(np.clip(out, 0, 1) * 255).astype('uint8'))
w, h = im.size
sheet = Image.new('RGB', (w * 2 + 36, h + 116), '#181d24')
d = ImageDraw.Draw(sheet)
f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 25)
s = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 19)
d.text((12, 14), 'T6 actual camera JPG', font=f, fill='white')
d.text((w+24, 14), 'T6-C1 curve-change estimate (NOT a camera capture)', font=f, fill='white')
sheet.paste(im, (12, 55))
sheet.paste(newim, (w+24, 55))
d.text((12, h+66), 'Curve-only estimate. Clipped pixels cannot be recovered; small refit-matrix differences are not shown.', font=s, fill='#c7c7cc')
sheet.save(a.output / 'CineStill-T6-vs-C1-estimate.jpg', quality=95)

def luma(v):
    return np.where(v <= .04045, v / 12.92, ((v + .055) / 1.055) ** 2.4) @ np.array([.2126, .7152, .0722])

sy, ny = luma(pixels), luma(out)
mask = (~invalid) & (sy > .03) & (sy < .5)
report = {'preview': 'curve-change estimate only; not a camera capture',
          'old_jpeg': str(a.jpeg.resolve()),
          'sample_estimated_midtone_ev': float(np.median(np.log2(ny[mask] / sy[mask]))),
          'valid_fraction': float(mask.mean()),
          'max_matrix_q13_difference': int(np.max(np.abs(np.array(r['before']['matrixQ13']) - np.array(r['after']['matrixQ13'])))),
          'mean_fit_de_to_local_corrected_reference': r['after']['meanDE'],
          'p95_fit_de_to_local_corrected_reference': r['after']['p95DE'],
          'camera_tested': False}
(a.output / 'offline-preview.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
