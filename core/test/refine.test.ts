import { describe, expect, it } from 'vitest';
import { applyCube, deltaE, deltaE2000Lab, fitSlot, lab, parseCube, slotApply } from '../src/color';
import { convertCube, cubeFitSamples, cubeFitSamplesExpanded, cubeRefineSamples } from '../src/color/convert';
import { refineSlot } from '../src/color/refine';
import { ColorError } from '../src/color/math';

/** A 3D .cube of size n from a function on display RGB. */
function cubeOf(n: number, f: (r: number, g: number, b: number) => number[]): string {
  const lines = ['TITLE "test"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++)
    lines.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '));
  return lines.join('\n') + '\n';
}
const warm = (r: number, g: number, b: number): number[] => { const v = (r + g + b) / 3; return [v, v * 1.02, v * 0.98]; };
/** Toned monochrome (sepia) with an S-curve: the old fitting colours fit it badly. */
const sepia = (r: number, g: number, b: number): number[] => {
  const y0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = (v: number): number => 1 / (1 + Math.exp(-3 * (v - 0.5)));
  const y = (s(y0) - s(0)) / (s(1) - s(0));
  const k = 4 * y * (1 - y), cb = -0.07 * k, cr = 0.06 * k;
  const R = y + cr, B = y + cb;
  return [R, (y - 0.2126 * R - 0.0722 * B) / 0.7152, B];
};
const grid = (n: number): Float64Array => {
  const o: number[] = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) o.push(r / (n - 1), g / (n - 1), b / (n - 1));
  return Float64Array.from(o);
};
const mean = (a: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };

describe('CIEDE2000', () => {
  // Sharma, Wu & Dalal (2005), Table 1: pairs 1-3, 7, 9-13 (the hue wrap-around cases), 17-20, 25.
  const PAIRS: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412], [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792], [[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195], [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045], [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977], [[50, 2.5, 0], [56, -27, -3], 31.903], [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ];
  it('matches the Sharma reference pairs, both ways round', () => {
    const a = Float64Array.from(PAIRS.flatMap((p) => p[0])), b = Float64Array.from(PAIRS.flatMap((p) => p[1]));
    const ab = deltaE2000Lab(a, b), ba = deltaE2000Lab(b, a);
    PAIRS.forEach((p, i) => {
      expect(Math.abs(ab[i] - p[2])).toBeLessThan(1e-4);
      expect(Math.abs(ba[i] - p[2])).toBeLessThan(1e-4);
    });
  });
  it('rejects buffers of different length', () => {
    expect(() => deltaE2000Lab(new Float64Array(3), new Float64Array(6))).toThrow(ColorError);
  });
});

describe('cube fitting colours', () => {
  it('extend the old set with a grey ramp, the grid corners and skin', () => {
    const base = cubeFitSamples(), ext = cubeFitSamplesExpanded();
    expect(Array.from(ext.subarray(0, base.length))).toEqual(Array.from(base));
    const extra = ext.subarray(base.length);
    const greys = new Set<number>(), corners = new Set<string>();
    for (let i = 0; i < extra.length; i += 3) {
      const [r, g, b] = [extra[i], extra[i + 1], extra[i + 2]];
      if (r === g && g === b) greys.add(r);
      if ([r, g, b].every((v) => v === 0 || v === 1)) corners.add(`${r}${g}${b}`);
    }
    expect(greys.size).toBeGreaterThanOrEqual(64);
    expect(greys.has(0) && greys.has(1)).toBe(true);
    expect(corners.size).toBe(8);
  });
  it('refinement samples: greys carry a large share of the weight', () => {
    const { P, weights } = cubeRefineSamples();
    expect(P.length).toBe(weights.length * 3);
    let grey = 0, all = 0;
    for (let i = 0; i < weights.length; i++) {
      all += weights[i];
      if (P[i * 3] === P[i * 3 + 1] && P[i * 3 + 1] === P[i * 3 + 2]) grey += weights[i];
    }
    expect(grey / all).toBeGreaterThan(0.35);
  });
});

describe('convertCube', () => {
  const text = cubeOf(9, warm);
  it('does not refine by default: the result is the plain fit on the extended colours', () => {
    const res = convertCube(text);
    expect(res.refined).toBeUndefined();
    const P = cubeFitSamplesExpanded();
    const fit = fitSlot(P, applyCube(parseCube(text), P), { post: true });
    expect(res.params.M1).toEqual(fit.M1);
    expect(res.params.P2).toEqual(fit.P2);
    res.params.ck.forEach((c, i) => expect(Array.from(c)).toEqual(Array.from(fit.ck[i])));
  });
  it('reports CIE76 / CIEDE2000 on the original fitting colours', () => {
    const res = convertCube(text);
    const P = cubeFitSamples();
    const d = deltaE(slotApply(res.params, P), applyCube(parseCube(text), P));
    expect(res.meanDE).toBeCloseTo(mean(d), 12);
    expect(Number.isFinite(res.meanDE2000) && Number.isFinite(res.p95DE2000)).toBe(true);
  });
  it('refinement is its own option and does not add a post matrix', () => {
    const plain = convertCube(text, { post: false });
    expect(plain.params.P2).toBeUndefined();
    expect(plain.refined).toBeUndefined();
    const ref = convertCube(text, { post: false, refine: true });
    expect(ref.params.P2).toBeUndefined();
    expect(typeof ref.refined).toBe('boolean');
    for (const c of ref.params.ck) for (let i = 1; i < 17; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
  });
  it('a kept refinement does not make the grey ramp worse', () => {
    const plain = convertCube(text), ref = convertCube(text, { refine: true });
    const ramp = new Float64Array(256 * 3);
    for (let i = 0; i < 256; i++) ramp.fill(i / 255, i * 3, i * 3 + 3);
    const t = lab(applyCube(parseCube(text), ramp));
    const worst = (p: typeof plain.params): number => Math.max(...deltaE2000Lab(lab(slotApply(p, ramp)), t));
    expect(worst(ref.params)).toBeLessThanOrEqual(worst(plain.params) + 0.05 + 1e-9);
  });
  it('fits a toned monochrome look (the old fitting colours gave a grid mean of about 4 dE00)', () => {
    const t = cubeOf(17, sepia);
    const res = convertCube(t);
    const G = grid(17);
    const d = deltaE2000Lab(lab(slotApply(res.params, G)), lab(applyCube(parseCube(t), G)));
    expect(mean(d)).toBeLessThan(2);
  });
});

describe('refineSlot', () => {
  it('checks its input', () => {
    const p = { M1: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ck: [0, 1, 2].map(() => Float64Array.from({ length: 17 }, (_, i) => i / 16)) };
    expect(() => refineSlot(p, new Float64Array(6), new Float64Array(3))).toThrow(ColorError);
    expect(() => refineSlot(p, new Float64Array(6), new Float64Array(6), { weights: [1] })).toThrow(ColorError);
  });
});
