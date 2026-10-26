import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertCube, quantizeSlot } from '../src/color';
import { HUE_BOUNDS, hueBlockBytes, hueMatricesFromD, hueQuantize, hueSector } from '../src/color/hue';
import { fw } from '../src';
import { buildFirmware } from '../src/fw';

const { aspect } = fw;

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

const OFFICIAL = process.env.GRMOD_OFFICIAL ?? new URL('../testdata/private/official.bin', import.meta.url).pathname;
describe.skipIf(!existsSync(OFFICIAL))('hue-sector added slots', () => {
  const identity = [8192, 0, 0, 0, 8192, 0, 0, 0, 8192];
  const icon = (): Uint8Array => {
    const i = new Uint8Array(40 * 40 * 4);
    for (let k = 0; k < 1600; k++) i[k * 4 + 3] = 255;
    return i;
  };

  it('builds a slot whose multi-axis block is its own hue table', async () => {
    const r = convertCube(syntheticHueLut());
    expect(r.hueQ10?.length).toBe(12);
    const q = quantizeSlot(r.params, identity);
    const res = await buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], {
      extraSlots: [{ name: 'HUE', matrixQ13: q.matrixQ13, curves: q.curves as never, ...(q.postQ9 ? { postQ9: q.postQ9 } : {}), ...(r.hueQ10 ? { hueQ10: r.hueQ10.flat() } : {}), icon: icon() }],
    });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
  }, 240_000);

  it('20 slots, some with hue sectors and some without: the build verifies and reads back as built', async () => {
    const r = convertCube(syntheticHueLut());
    const q = quantizeSlot(r.params, identity);
    const slots = Array.from({ length: 20 }, (_, k) => {
      // a different table per hue slot: shift every sector's diagonal a little (rows keep summing to 1024)
      const hue = r.hueQ10!.map((m) => { const c = m.slice(); c[0] += k; c[1] -= k; return c; }).flat();
      return { name: `Hue ${k + 1}`, matrixQ13: q.matrixQ13, curves: q.curves as never, ...(q.postQ9 ? { postQ9: q.postQ9 } : {}), ...(k % 2 === 0 ? { hueQ10: hue } : {}), icon: icon() };
    });
    const res = await buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], { extraSlots: slots });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
    const dec = new fw.Firmware(res.file).decoded;
    const rtos = fw.sectionsOf(dec).find((x) => x.name === 'RTOS')!;
    const icons = fw.sectionsOf(dec).find((x) => x.name === 'ICONBIN')!;
    const back = aspect.readExtraSlots(dec.slice(rtos.offset, rtos.offset + rtos.size), dec.subarray(icons.offset, icons.offset + icons.size), 20)!;
    expect(back).not.toBeNull();
    back.forEach((b, k) => {
      if (k % 2 === 0) expect(Array.from(b.hueQ10!)).toEqual(Array.from(slots[k].hueQ10!));
      else expect(b.hueQ10).toBeUndefined();
    });
  }, 240_000);

  it('refuses hue matrices whose rows do not sum to 1024', async () => {
    const r = convertCube(syntheticHueLut());
    const q = quantizeSlot(r.params, identity);
    const bad = r.hueQ10!.flat(); bad[0] += 1;
    await expect(buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], {
      extraSlots: [{ name: 'BAD', matrixQ13: q.matrixQ13, curves: q.curves as never, hueQ10: bad, icon: icon() }],
    })).rejects.toMatchObject({ code: 'bad-hue' });
  }, 240_000);
});
