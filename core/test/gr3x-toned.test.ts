// SPDX-License-Identifier: GPL-2.0-only
// Black-and-white and toned black-and-white presets on GR III / IIIx: fitted with equal matrix rows,
// a curve per channel and no second matrix, so their colour depends on brightness alone.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertGr3xCube, isTonedMonochrome } from '../src/color/gr3x-import';
import { applyCube, parseCube } from '../src/color/cube';
import { syntheticSamples } from '../src/color/convert';
import { GR3X_CAMERA } from '../src/color/gr3x-camera';
import { quantizeSlot } from '../src/color/camera';

/** A 17-point cube whose output is a toning of the input's brightness (a sepia), brightness as the camera forms it. */
function tonedCube(): string {
  const n = 17, lines = ['TITLE "Test Sepia"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    // brightness as the camera forms it (linear weights, then its tone curve), then a toning
    const S = GR3X_CAMERA.S, Si = GR3X_CAMERA.Sinv;
    const t = Math.pow(S(0.25 * Si(r / (n - 1)) + 0.7 * Si(g / (n - 1)) + 0.05 * Si(b / (n - 1))), 0.9);
    lines.push([Math.min(1, t * 1.06 + 0.02), t, Math.max(0, t * 0.86)].map(v => v.toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

describe('toned black-and-white presets (GR III / IIIx)', () => {
  it('tells a toned black-and-white look from a colour one', () => {
    const P = syntheticSamples(2200, 160, 4);
    expect(isTonedMonochrome(applyCube(parseCube(tonedCube()), P))).toBe(true);
    const warm = readFileSync(new URL('../../examples/gr3x/Demo-Warm.cube', import.meta.url), 'utf8');
    expect(isTonedMonochrome(applyCube(parseCube(warm), P))).toBe(false);
  });

  it('fits equal rows and no second matrix: inputs of the same brightness give the same colour', () => {
    const c = convertGr3xCube(tonedCube(), { post: true });
    expect(c.params.P2).toBeUndefined();
    for (const row of c.params.M1) row.forEach((v, k) => expect(v).toBeCloseTo(c.params.M1[0][k], 12));
    expect(c.meanDE).toBeLessThan(2);
    // Quantized for the camera (with the Standard matrix), the rows stay equal within rounding.
    const q = quantizeSlot(c.params, [8192, 0, 0, 0, 8192, 0, 0, 0, 8192]);
    for (let k = 0; k < 3; k++) for (let r = 1; r < 3; r++) expect(Math.abs(q.matrixQ13[r * 3 + k] - q.matrixQ13[k])).toBeLessThanOrEqual(1);
    // Saturated colours: the output is the toning of their brightness, not a colour of their own.
    const sat = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0.8, 0.3, 0.2]);
    const out = GR3X_CAMERA.slotApply(c.params, sat), want = applyCube(parseCube(tonedCube()), sat);
    for (let i = 0; i < out.length; i++) expect(Math.abs(out[i] - want[i])).toBeLessThan(0.04);
  }, 60_000);

  it('leaves colour presets to the general fit', () => {
    const warm = readFileSync(new URL('../../examples/gr3x/Demo-Warm.cube', import.meta.url), 'utf8');
    const c = convertGr3xCube(warm, { post: true });
    expect(c.params.M1[0]).not.toEqual(c.params.M1[1]);
  }, 60_000);
});
