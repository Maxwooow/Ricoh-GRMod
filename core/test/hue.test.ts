import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertCube, quantizeSlot, slotApply } from '../src/color';
import { guardedHue, HUE_SEARCH, hueContext, hueKept, mulberry32, scoreHue } from '../src/color/convert';
import type { HueScore } from '../src/color/convert';
import { parseCube } from '../src/color/cube';
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
    const k = 1 + 0.1 * Math.cos((hueSector(v[0], v[1], v[2]) / 12) * 2 * Math.PI);
    lines.push(v.map((c) => Math.min(1, Math.max(0, gray + (c - gray) * k)).toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

/** A 9^3 LUT from a per-colour function. */
function lutOf(f: (r: number, g: number, b: number) => number[], size = 9): string {
  const lines = ['TITLE "t"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++)
    lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '));
  return lines.join('\n') + '\n';
}
const LUTS: Record<string, string> = {
  identity: lutOf((r, g, b) => [r, g, b]),
  warm: lutOf((r, g, b) => [r * 1.06, g, b * 0.92]),
  'orange-teal': lutOf((r, g, b) => { const y = (r + g + b) / 3; return [r + 0.12 * (r - b) * (1 - y), g, b - 0.12 * (r - b) * y]; }),
  'hue-dependent': syntheticHueLut(),
};

describe('hue-sector fitting is opt-in', () => {
  // SHA-256 of JSON.stringify(convertCube(text)) as GR Mod 0.8.5 (8b4ca5e) produced it, for the LUTs below.
  const V085: Record<string, string> = {
    "identity": '8fb3fdab7a20ecf8504f1d92fd8d5932eda3ec6ef892abda3eb47a3e9795b9e0',
    "warm": '46b0497ac22a670193ff40b2795c7854ed142f43836927478b36adc864c80bf3',
    "orange-teal": '658d6b484ff5fe614c1743167502f9229bfbced2d09573288e2a375ec2cdec68',
    "hue-dependent": 'ff78caa40ba88a3c06c42c085cca4d0adb5b2428036b92051e61d57ebed6b0d0',
  };
  it('without the option convertCube is exactly the 0.8.5 result', () => {
    for (const [name, text] of Object.entries(LUTS)) {
      const r = convertCube(text);
      expect(r.hueQ10, name).toBeUndefined();
      expect(r.params.hue, name).toBeUndefined();
      expect(createHash('sha256').update(JSON.stringify(r)).digest('hex'), name).toBe(V085[name]);
      expect(JSON.stringify(convertCube(text, { hue: false })), name).toBe(JSON.stringify(r));
    }
  }, 120_000);
});

describe('hue-sector guard', () => {
  it('the camera model is unchanged by identity sectors', () => {
    const r = mulberry32(5);
    const rgb = new Float64Array(3 * 500);
    for (let i = 0; i < rgb.length; i++) rgb[i] = r();
    const M1 = [[1.1, -0.1, 0], [0.05, 0.9, 0.05], [0, -0.2, 1.2]];
    const ck = [0, 1, 2].map(() => Float64Array.from({ length: 17 }, (_, k) => (k / 16) ** 0.9));
    const ident = hueMatricesFromD(new Float64Array(36));
    expect(Array.from(slotApply({ M1, ck, hue: ident }, rgb))).toEqual(Array.from(slotApply({ M1, ck }, rgb)));
  });

  it('keeps hue only when the final quantised look is better on the same colours, else is the no-hue result bit for bit', () => {
    for (const [name, text] of Object.entries(LUTS)) {
      const withHue = convertCube(text, { hue: true });
      const without = convertCube(text);
      expect(without.hueQ10, name).toBeUndefined();
      if (!withHue.hueQ10) {
        // fallback: exactly the 0.8.5 result
        expect(JSON.stringify(withHue), name).toBe(JSON.stringify(without));
        continue;
      }
      const cube = parseCube(text);
      const ctx = hueContext(cube);
      const s0 = scoreHue(without.params, ctx), s1 = scoreHue(withHue.params, ctx);
      expect(hueKept(s0, s1), name).toBe(true);
      expect(s1.fitMean, name).toBeLessThan(s0.fitMean);
      expect(s1.allMean, name).toBeLessThan(s0.allMean);
      expect(withHue.meanDE2000, name).toBeLessThan(without.meanDE2000);
      // what is evaluated is what gets written: params.hue are the Q10 integers over 1024
      expect(withHue.params.hue!.map((m) => m.map((v) => Math.round(v * 1024))), name).toEqual(withHue.hueQ10);
      for (const m of withHue.hueQ10) {
        for (let r = 0; r < 3; r++) expect(m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]).toBe(1024);
        for (const v of m) expect(Math.abs(v)).toBeLessThanOrEqual(2047);
      }
      // the rest of the slot is still a valid slot
      expect(withHue.params.ck.length).toBe(3);
    }
  }, 600_000);

  it('hue is kept on a look that depends on the sector', () => {
    expect(convertCube(LUTS['hue-dependent'], { hue: true }).hueQ10?.length).toBe(12);
  }, 120_000);

  it('a search that tries nothing returns null, and the conversion is then the no-hue result', () => {
    const cube = parseCube(LUTS.warm);
    const start = convertCube(LUTS.warm, { hue: false }).params;
    expect(guardedHue(cube, start, undefined, undefined, { ...HUE_SEARCH, attempts: 0 })).toBeNull();
    expect(guardedHue(cube, start, undefined, undefined, { ...HUE_SEARCH, scales: [] })).toBeNull();
  }, 120_000);

  it('every candidate offered passes the rule; the rule rejects any subset getting worse', () => {
    const cube = parseCube(LUTS['orange-teal']);
    const start = convertCube(LUTS['orange-teal'], { hue: false }).params;
    const ctx = hueContext(cube);
    const s0 = scoreHue(start, ctx);
    const h = guardedHue(cube, start, undefined, undefined, HUE_SEARCH);
    if (h) expect(hueKept(s0, scoreHue(h.params, ctx))).toBe(true);
    // a clearly better look passes; making any one figure worse fails it
    const better: HueScore = { ...s0, fitMean: s0.fitMean * 0.9, allMean: s0.allMean * 0.9, cells: Float64Array.from(s0.cells) };
    expect(hueKept(s0, better)).toBe(true);
    expect(hueKept(s0, s0)).toBe(false); // no gain is not a gain
    for (const k of ['fitP95', 'satMean', 'satP95', 'skinMean', 'skinP95', 'refMean', 'valMean', 'valSatP95', 'valSkinP95', 'greyMean', 'greyMax', 'toneMean', 'toneMax'] as const)
      expect(hueKept(s0, { ...better, [k]: s0[k] + 1 }), k).toBe(false);
    const cells = Float64Array.from(s0.cells);
    const c = cells.findIndex((v) => Number.isFinite(v));
    cells[c] += 0.5;
    expect(hueKept(s0, { ...better, cells })).toBe(false);
  }, 120_000);

  it('the hue fit never reports a worse look than the plain fit on the colours convertCube reports on', () => {
    for (const text of Object.values(LUTS)) {
      const a = convertCube(text, { hue: false });
      const b = convertCube(text, { hue: true });
      expect(b.meanDE2000).toBeLessThanOrEqual(a.meanDE2000);
      expect(b.p95DE2000).toBeLessThanOrEqual(a.p95DE2000 + 0.05);
    }
  }, 600_000);
});

const OFFICIAL = process.env.GRMOD_OFFICIAL ?? new URL('../testdata/private/official.bin', import.meta.url).pathname;
describe.skipIf(!existsSync(OFFICIAL))('hue-sector added slots', () => {
  const identity = [8192, 0, 0, 0, 8192, 0, 0, 0, 8192];
  const icon = (): Uint8Array => {
    const i = new Uint8Array(40 * 40 * 4);
    for (let k = 0; k < 1600; k++) i[k * 4 + 3] = 255;
    return i;
  };

  it('builds a slot whose multi-axis block is its own hue table', async () => {
    const r = convertCube(syntheticHueLut(), { hue: true });
    expect(r.hueQ10?.length).toBe(12);
    const q = quantizeSlot(r.params, identity);
    const res = await buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], {
      extraSlots: [{ name: 'HUE', matrixQ13: q.matrixQ13, curves: q.curves as never, ...(q.postQ9 ? { postQ9: q.postQ9 } : {}), ...(r.hueQ10 ? { hueQ10: r.hueQ10.flat() } : {}), icon: icon() }],
    });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
  }, 240_000);

  it('a slot without hue sectors builds the same bytes as GR Mod 0.8.5', async () => {
    const r = convertCube(LUTS.warm);
    const q = quantizeSlot(r.params, identity);
    const res = await buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], {
      extraSlots: [{ name: 'WARM', matrixQ13: q.matrixQ13, curves: q.curves as never, ...(q.postQ9 ? { postQ9: q.postQ9 } : {}), icon: icon() }],
    });
    expect(createHash('sha256').update(res.file).digest('hex')).toBe(
      '89bb24c1137a25604cf2dbf30f510018efd4222e4ae8ab0346d06de24e5ba6f5');
  }, 240_000);

  it('20 slots, some with hue sectors and some without: the build verifies and reads back as built', async () => {
    const r = convertCube(syntheticHueLut(), { hue: true });
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
    const r = convertCube(syntheticHueLut(), { hue: true });
    const q = quantizeSlot(r.params, identity);
    const bad = r.hueQ10!.flat(); bad[0] += 1;
    await expect(buildFirmware(new Uint8Array(readFileSync(OFFICIAL)), [], [], [], {
      extraSlots: [{ name: 'BAD', matrixQ13: q.matrixQ13, curves: q.curves as never, hueQ10: bad, icon: icon() }],
    })).rejects.toMatchObject({ code: 'bad-hue' });
  }, 240_000);
});
