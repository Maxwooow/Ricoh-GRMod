// SPDX-License-Identifier: GPL-2.0-only
// QoL D2: a fitted slot as a .cube (core/src/color/export-cube.ts, DEC-QOL-EXPORTCUBE-001).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GR3X_CAMERA, KN, applyCube, convertCube, exportSlotCube, parseCube, slotApply } from '../src/color/index';
import type { SlotParams } from '../src/color/index';

const identity = (): SlotParams => ({ M1: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ck: [0, 1, 2].map(() => Float64Array.from(KN)) });
/** A warm, contrasty 17^3 look written as a .cube (what a user would import), fitted by the real conversion. */
function warmCube(): string {
  const n = 17; const lines = ['TITLE "warm test"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const f = (v: number): number => v * v * (3 - 2 * v) * 0.5 + v * 0.5;
    lines.push(`${Math.min(1, f(r / 16) * 1.06).toFixed(5)} ${f(g / 16).toFixed(5)} ${Math.max(0, f(b / 16) * 0.92).toFixed(5)}`);
  }
  return lines.join('\n');
}
/** Pseudo-random colours, fixed seed. */
function samples(count: number): Float64Array {
  const a = new Float64Array(count * 3); let s = 12345;
  for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296; }
  return a;
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const meanDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => { let m = 0; for (let i = 0; i < a.length; i++) m += Math.abs(a[i] - b[i]); return m / a.length; };

let fitted: SlotParams;
beforeAll(() => { fitted = convertCube(warmCube()).params; });

describe('exportSlotCube', () => {
  it('writes the standard header, size^3 data lines with red varying fastest, and parses back', () => {
    const text = exportSlotCube(identity(), { title: 'My "look"\nx' });
    const head = text.split('\n').slice(0, 4);
    expect(head).toEqual(['TITLE "My look x"', 'LUT_3D_SIZE 33', 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']);
    expect(text.split('\n').filter((l) => /^[-\d.]/.test(l))).toHaveLength(33 ** 3);
    const cube = parseCube(text);
    expect(cube.size3D).toBe(33);
    expect(cube.title).toBe('My look x');
    expect(cube.domainMin).toEqual([0, 0, 0]); expect(cube.domainMax).toEqual([1, 1, 1]);
    // ordering: entry (r, g, b) is at r + n*(g + n*b); the red-only step must come first
    const d = cube.data3D!; const at = (r: number, g: number, b: number): number[] => { const i = (r + 33 * (g + 33 * b)) * 3; return [d[i], d[i + 1], d[i + 2]]; };
    const ref = (r: number, g: number, b: number): number[] => Array.from(slotApply(identity(), Float64Array.from([r / 32, g / 32, b / 32])));
    for (const [r, g, b] of [[32, 0, 0], [0, 32, 0], [0, 0, 32], [5, 17, 29], [31, 2, 8]]) at(r, g, b).forEach((v, i) => expect(v).toBeCloseTo(ref(r, g, b)[i], 5));
    expect(at(32, 0, 0)[0]).toBeGreaterThan(0.99); expect(at(0, 32, 0)[1]).toBeGreaterThan(0.99);
  });
  it('identity (Standard) parameters give a near-identity LUT: exact below the curve top, a few 1/1000 at white', () => {
    const cube = parseCube(exportSlotCube(identity()));
    const n = 33; let worst = 0, worstBelow = 0;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const i = (r + n * (g + n * b)) * 3;
      [r, g, b].forEach((v, c) => { const e = Math.abs(cube.data3D![i + c] - v / (n - 1)); worst = Math.max(worst, e); if (v < 31) worstBelow = Math.max(worstBelow, e); });
    }
    expect(worstBelow).toBeLessThan(1 / 255 / 4);
    expect(worst).toBeLessThan(0.01);
    expect(cube.data3D![0]).toBe(0); // black stays black
  });
  it('a fitted look is not the identity and matches slotApply (the model the preview uses) on sample colours', () => {
    const cube = parseCube(exportSlotCube(fitted, { title: 'warm' }));
    const x = samples(2000);
    const viaCube = applyCube(cube, x);
    const direct = slotApply(fitted, x);
    expect(maxDiff(slotApply(fitted, x), x)).toBeGreaterThan(0.03); // the look does something
    // trilinear interpolation of a 33 lattice: mean error well under 1/255, worst case a few 1/255
    expect(meanDiff(viaCube, direct)).toBeLessThan(1 / 255);
    expect(maxDiff(viaCube, direct)).toBeLessThan(6 / 255);
  });
  it('GR III / IIIx exports through its own camera model (GR3X_CAMERA.slotApply)', () => {
    const x = samples(500);
    const c3 = parseCube(exportSlotCube(fitted, { camera: 'gr3x', size: 17 }));
    expect(c3.size3D).toBe(17);
    expect(meanDiff(applyCube(c3, x), GR3X_CAMERA.slotApply(fitted, x))).toBeLessThan(2 / 255);
  });
  it('rejects a bad size', () => {
    expect(() => exportSlotCube(identity(), { size: 1 })).toThrow();
    expect(() => exportSlotCube(identity(), { size: 33.5 })).toThrow();
  });
});

// The preview's own renderer (ui/src/preview.ts applySlot, 8-bit tables), for a slot without hue sectors.
describe('against the photo preview renderer', () => {
  it('the exported cube agrees with applySlot to within a few 8-bit levels', async () => {
    vi.stubGlobal('ImageData', class { data: Uint8ClampedArray; constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); } });
    const { applySlot } = await import('../../ui/src/preview');
    const cube = parseCube(exportSlotCube(fitted));
    const n = 1500; const x = samples(n);
    const src = new ImageData(n, 1);
    for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) src.data[i * 4 + c] = Math.round(x[i * 3 + c] * 255); src.data[i * 4 + 3] = 255; }
    const rendered = applySlot(fitted, src);
    const inp = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) inp[i * 3 + c] = src.data[i * 4 + c] / 255;
    const viaCube = applyCube(cube, inp);
    let worst = 0, sum = 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const e = Math.abs(viaCube[i * 3 + c] * 255 - rendered.data[i * 4 + c]); worst = Math.max(worst, e); sum += e; }
    expect(sum / (n * 3)).toBeLessThan(1.5);
    expect(worst).toBeLessThan(8);
    vi.unstubAllGlobals();
  });
});
