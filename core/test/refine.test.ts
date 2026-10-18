import { describe, expect, it } from 'vitest';
import { deltaE2000Lab } from '../src/color';
import { cubeFitSamplesExpanded, cubeRefineSamples, convertCube } from '../src/color/convert';

describe('CIEDE2000', () => {
  it('matches the Sharma reference pair', () => {
    // Sharma, Wu & Dalal (2005), pair 1: (50, 2.6772, -79.7751) vs (50, 0, -82.7485) = 2.0425
    const d = deltaE2000Lab(Float64Array.from([50, 2.6772, -79.7751]), Float64Array.from([50, 0, -82.7485]));
    expect(d[0]).toBeCloseTo(2.0425, 3);
  });
});

describe('cube refinement samples', () => {
  it('has neutral, corner and skin samples with weights', () => {
    expect(cubeFitSamplesExpanded().length).toBeGreaterThan(4602 * 3);
    const { P, weights } = cubeRefineSamples();
    expect(P.length).toBe(weights.length * 3);
    expect(Math.max(...weights)).toBeGreaterThan(5);
    // (0,0,0) and (1,1,1) are both present
    let black = false, white = false;
    for (let i = 0; i < P.length; i += 3) {
      if (P[i] === 0 && P[i + 1] === 0 && P[i + 2] === 0) black = true;
      if (P[i] === 1 && P[i + 1] === 1 && P[i + 2] === 1) white = true;
    }
    expect(black && white).toBe(true);
  });
});

describe('convertCube with perceptual refinement', () => {
  it('returns valid, finite parameters and a non-empty fit report', () => {
    const size = 9;
    const lines = ['TITLE "test"', `LUT_3D_SIZE ${size}`];
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
      const v = (r + g + b) / (3 * (size - 1));
      lines.push(`${v.toFixed(5)} ${Math.min(1, v * 1.02).toFixed(5)} ${Math.max(0, v * 0.98).toFixed(5)}`);
    }
    const res = convertCube(lines.join('\n') + '\n');
    expect(Number.isFinite(res.meanDE)).toBe(true);
    expect(Number.isFinite(res.p95DE)).toBe(true);
    expect(res.params.ck.length).toBe(3);
    expect(res.params.ck.every((c) => c.length === 17)).toBe(true);
  });
});
