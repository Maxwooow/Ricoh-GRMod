// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_CAMERA } from '../src/color/gr3x-camera';
import { lab, srgbToLin } from '../src/color/math';

const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('CineStill T6-C1 camera-output correction', () => {
  it('imports into the unchanged engine with neutral midtones, smooth shadows and highlight headroom', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(input!)));
    const original = engine.convertPreset('cube', readFileSync(new URL('../../examples/gr3x/T6/CineStill-800T.cube', import.meta.url), 'utf8'));
    const corrected = engine.convertPreset('cube', readFileSync(new URL('../../examples/gr3x/T6-C1/CineStill-800T-T6-C1.cube', import.meta.url), 'utf8'));
    expect(corrected.meanDE).toBeLessThan(0.2);
    expect(corrected.p95DE).toBeLessThan(0.5);
    for (const curve of corrected.curves) {
      expect(curve).toHaveLength(256);
      expect(curve[0]).toBeLessThanOrEqual(4);
      expect(curve[16]).toBeGreaterThan(100); // avoid the old long, clipped shadow toe
      expect(curve[240]).toBeLessThan(16000); // do not fix brightness by clipping highlights
      expect(curve.every((v, i) => v >= 0 && v <= 16383 && (i === 0 || v >= curve[i-1]))).toBe(true);
    }
    const grey = Float64Array.from(Array.from({ length: 71 }, (_, i) => [.2+i/100, .2+i/100, .2+i/100]).flat());
    const oldRgb = GR3X_CAMERA.slotApply(original.params, grey);
    const newRgb = GR3X_CAMERA.slotApply(corrected.params, grey), newLab = lab(newRgb);
    for (let i = 0; i < grey.length; i += 3) {
      expect(Math.hypot(newLab[i+1], newLab[i+2])).toBeLessThan(2.0);
      expect(newRgb[i]).toBeLessThan(1);
      expect(newRgb[i+1]).toBeLessThan(1);
      expect(newRgb[i+2]).toBeLessThan(1);
    }
    const luma = (a: Float64Array, i: number) => .2126*srgbToLin(a[i])+.7152*srgbToLin(a[i+1])+.0722*srgbToLin(a[i+2]);
    const mid = 30*3; // neutral input 0.50
    const lift = Math.log2(luma(newRgb, mid)/luma(oldRgb, mid));
    expect(lift).toBeGreaterThan(.6);
    expect(lift).toBeLessThan(1.0);
    for (let row = 0; row < 3; row++) expect(Array.from(corrected.matrixQ13.slice(row*3,row*3+3)).reduce((a,b)=>a+b,0)).toBe(8192);
    // The correction retains the film's distinct colour mixer; no global
    // camera model or other preset is replaced by an identity transform.
    for (let i = 0; i < 9; i++) expect(Math.abs(corrected.matrixQ13[i]-original.matrixQ13[i])).toBeLessThanOrEqual(4);
  });
});
