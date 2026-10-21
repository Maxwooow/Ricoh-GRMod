import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertCube, quantizeSlot } from '../src/color';
import { HUE_BOUNDS, hueBlockBytes, hueMatricesFromD, hueQuantize, hueSector } from '../src/color/hue';
import { buildFirmware } from '../src/fw';

describe('hue sectors', () => {
  it('starts as identity and keeps every row summing to 1024 after quantisation', () => {
    const m = hueMatricesFromD(new Float64Array(36));
    expect(m.length).toBe(12);
    for (const matrix of m) for (let r = 0; r < 3; r++) expect(matrix[r * 3] + matrix[r * 3 + 1] + matrix[r * 3 + 2]).toBeCloseTo(1, 9);
    const q = hueQuantize(m);
    for (const matrix of q) for (let r = 0; r < 3; r++) expect(matrix[r * 3] + matrix[r * 3 + 1] + matrix[r * 3 + 2]).toBe(1024);
    expect(hueBlockBytes(q).length).toBe(2160);
    expect(HUE_BOUNDS.length).toBe(12);
  });

  it('selects a sector by hue', () => {
    expect(hueSector(1, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(hueSector(1, 0, 0)).toBeLessThan(12);
    expect(hueSector(1, 1, 1)).toBe(0); // neutral: sector is irrelevant but stable
  });
});

/** A 9^3 LUT whose saturation boost follows the hue sector: the hue stage has something to fit. */
function syntheticHueLut(size = 9): string {
  const lines = ['TITLE "hue sectors"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const v = [r / (size - 1), g / (size - 1), b / (size - 1)];
    const gray = (v[0] + v[1] + v[2]) / 3;
    const k = 1 + 0.2 * Math.cos((hueSector(v[0], v[1], v[2]) / 12) * 2 * Math.PI);
    lines.push(v.map((c) => Math.min(1, Math.max(0, gray + (c - gray) * k)).toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

const OFFICIAL = process.env.GRMOD_OFFICIAL ?? '/tmp/fwdc248b.bin';
describe.skipIf(!existsSync(OFFICIAL))('hue-sector added slot build', () => {
  it('builds a slot whose multi-axis block is its own hue table', async () => {
    const r = convertCube(syntheticHueLut());
    expect(r.hueQ10?.length).toBe(12);
    const q = quantizeSlot(r.params, [8192, 0, 0, 0, 8192, 0, 0, 0, 8192]);
    const icon = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < 1600; i++) icon[i * 4 + 3] = 255;
    const res = await buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], {
      extraSlots: [{ name: 'HUE', matrixQ13: q.matrixQ13, curves: q.curves as never, ...(q.postQ9 ? { postQ9: q.postQ9 } : {}), ...(r.hueQ10 ? { hueQ10: r.hueQ10.flat() } : {}), icon }],
    });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
  });
});
