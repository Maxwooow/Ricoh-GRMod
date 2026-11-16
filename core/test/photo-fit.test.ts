// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { convertCube, photoWeightedFit, cubeFitSamplesExpanded } from '../src/color/convert';
import { PHOTO_WEIGHTINGS, photoCheckSamples, photoFitSamples, photoFitSet, skyCheckSamples, skyFitSamples } from '../src/color/photo-fit';
import { applyCube, parseCube } from '../src/color/cube';
import { slotApply } from '../src/color/camera';
import { deltaE2000Lab, lab } from '../src/color/math';

/** A 17^3 .cube of a film-like look: warm highlights, teal shadows, a soft S curve, less saturation. */
function filmCube(): string {
  const n = 17, lines = ['TITLE "photo-fit test"', `LUT_3D_SIZE ${n}`];
  const s = (x: number) => x * x * (3 - 2 * x) * 0.6 + x * 0.4;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const [R, G, B] = [r, g, b].map((v) => v / (n - 1));
    const y = 0.3 * R + 0.59 * G + 0.11 * B;
    const sat = 0.8;
    let o = [y + (R - y) * sat, y + (G - y) * sat, y + (B - y) * sat];
    o = [o[0] + 0.06 * (y - 0.4), o[1] + 0.01 * (y - 0.4), o[2] - 0.06 * (y - 0.4)];
    lines.push(o.map((v) => s(Math.min(1, Math.max(0, v))).toFixed(6)).join(' '));
  }
  return lines.join('\n');
}

const mean = (a: ArrayLike<number>) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t / a.length; };
const err = (p: Parameters<typeof slotApply>[0], P: Float64Array, cube: ReturnType<typeof parseCube>) => mean(deltaE2000Lab(lab(slotApply(p, P)), lab(applyCube(cube, P))));

describe('photo-weighted .cube fit', () => {
  it('ships 4096 fitting and 4096 choosing photo colours, 0..1', () => {
    for (const a of [photoFitSamples(), photoCheckSamples()]) {
      expect(a.length).toBe(4096 * 3);
      expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...a)).toBeLessThanOrEqual(1);
    }
    expect(skyFitSamples().length).toBe(200 * 3);
    expect(skyCheckSamples().length).toBe(225 * 3);
  });

  it('builds the weighted set as the default colours followed by the copies', () => {
    const base = cubeFitSamplesExpanded();
    const grey = new Float64Array(9), skin = new Float64Array(6);
    const w = PHOTO_WEIGHTINGS[1];
    const P = photoFitSet(base, w, grey, skin);
    expect(P.length).toBe(base.length + w.sky * 600 + w.grey * 9 + w.skin * 6 + w.photo * 4096 * 3 + w.bright * 144 * 3);
    expect(Array.from(P.subarray(0, base.length))).toEqual(Array.from(base));
  });

  it('leaves the default import unchanged when off', () => {
    const text = filmCube();
    const a = convertCube(text), b = convertCube(text, { photoFit: false });
    expect(b.params).toEqual(a.params);
    expect(a.photoFitted).toBeUndefined();
  });

  it('keeps a photo fit only when it is closer on held-out photo colours and greys, skin and sky hold', () => {
    const text = filmCube();
    const cube = parseCube(text);
    const def = convertCube(text);
    const pho = convertCube(text, { photoFit: true });
    expect(typeof pho.photoFitted).toBe('boolean');
    const check = photoCheckSamples(), sky = skyCheckSamples();
    if (pho.photoFitted) {
      const s = (p: typeof def.params) => err(p, check, cube) + 0.25 * err(p, sky, cube);
      expect(s(pho.params)).toBeLessThanOrEqual(s(def.params) - 0.02 + 1e-9);
      expect(err(pho.params, sky, cube)).toBeLessThanOrEqual(err(def.params, sky, cube) + 0.05 + 1e-9);
    } else {
      expect(pho.params).toEqual(def.params);
    }
    // the exported helper agrees with the conversion
    const direct = photoWeightedFit(cube, cubeFitSamplesExpanded(), def.params, true);
    expect(direct === null).toBe(!pho.photoFitted);
  });
});
