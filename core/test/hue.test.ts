// SPDX-License-Identifier: GPL-2.0-only
/**
 * Hue sectors of added slots (color/hue.ts, hue-fit.ts, fw/aspect/slots.ts): the block's layout
 * and copies, the camera-order model, the guarded fit, and (with the official firmware in
 * testdata/private) the firmware block written, read back and verified.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, color, fw } from '../src';
import { composeWithStandard, hueBlockBytes, hueCopy0, hueFromBlock, hueMatricesFromD, hueToQ10, HUE_BLOCK_BYTES } from '../src/color/hue';
import { applyBeforeHue, beforeStandardHue } from '../src/color/hue-fit';
import { convertCube } from '../src/color/convert';
import { syntheticSamples } from '../src/color/convert';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const identity = (): number[][] => Array.from({ length: 12 }, () => I.slice());
/** A made-up Standard-like block: small shifts at every boundary. */
const fakeStd = (): number[][] => hueMatricesFromD(Array.from({ length: 36 }, (_, i) => 0.08 * Math.sin(i * 1.7)));

/** A LUT that turns yellows and greens (a hue-sector look), as a .cube text. */
function hueCube(): string {
  const N = 17, lines = ['TITLE "hue test"', `LUT_3D_SIZE ${N}`];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    let R = r / (N - 1), G = g / (N - 1), B = b / (N - 1);
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const yellow = Math.max(0, Math.min(R, G) - B) * (1 - Math.abs(R - G));
    R -= 0.12 * yellow; B += 0.04 * yellow;
    if (G === mx && mx - mn > 0.05) { B += 0.06 * (mx - mn); R -= 0.03 * (mx - mn); }
    lines.push([R, G, B].map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '));
  }
  return lines.join('\n');
}

describe('hue sectors: block and model', () => {
  it('writes five copies scaled by (16 - c) / 16 with exact row sums, and reads copy 0 back', () => {
    const q = hueToQ10(fakeStd())!;
    const b = hueBlockBytes(q);
    expect(b.length).toBe(HUE_BLOCK_BYTES);
    const v = new DataView(b.buffer);
    for (let g = 0; g < 12; g++) for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) {
      const o = ((g * 5 + c) * 9 + r * 3) * 4;
      expect(v.getInt32(o, true) + v.getInt32(o + 4, true) + v.getInt32(o + 8, true)).toBe((1024 * (16 - c)) / 16);
      for (let k = 0; k < 3; k++) expect(Math.abs(v.getInt32(o + 4 * k, true) - (q[g * 9 + r * 3 + k] * (16 - c)) / 16)).toBeLessThanOrEqual(1.5);
    }
    expect(hueFromBlock(b)).toEqual(q);
    expect(hueCopy0(b)).toEqual(q);
    const broken = b.slice(); broken[40] ^= 1;
    expect(hueFromBlock(broken)).toBeNull();
  });

  it('with no correction a slot renders as one with Standard\'s block; with identity blocks as without hue', () => {
    const P = syntheticSamples(400, 5, 1);
    const ck = [0, 1, 2].map((c) => Float64Array.from(color.KN, (x) => Math.min(1, Math.pow(x, 0.92 + 0.05 * c))));
    const base: color.SlotParams = { M1: [[1.05, -0.03, -0.02], [0.01, 0.97, 0.02], [-0.02, 0.05, 0.97]], ck };
    // identity Standard block: the camera-order path is the plain one
    const plain = color.slotApply(base, P);
    const ident = color.slotApply({ ...base, hue: identity(), hueStd: identity() }, P);
    for (let i = 0; i < P.length; i++) expect(ident[i]).toBeCloseTo(plain[i], 12);
    // the fast evaluator of the fit is the same arithmetic as slotApply
    const std = fakeStd();
    const hue = composeWithStandard(std, hueMatricesFromD(Array.from({ length: 36 }, (_, i) => 0.03 * Math.cos(i))));
    const a = color.slotApply({ ...base, hue, hueStd: std }, P);
    const b = applyBeforeHue({ ...base, hue, hueStd: std }, beforeStandardHue(std, P));
    for (let i = 0; i < P.length; i++) expect(b[i]).toBeCloseTo(a[i], 12);
    // with M1 = identity and Standard's own block, a Standard colour comes back as it was (below clipping)
    const unit: color.SlotParams = { M1: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ck: [0, 1, 2].map(() => Float64Array.from(color.KN)) };
    const back = color.slotApply({ ...unit, hue: std, hueStd: std }, Float64Array.from([0.4, 0.5, 0.3, 0.6, 0.35, 0.45]));
    expect(Array.from(back).map((x) => +x.toFixed(4))).toEqual([0.4, 0.5, 0.3, 0.6, 0.35, 0.45]);
  });

  it('the guarded fit lowers the camera-order error of a hue look, keeps greys, and is off unless asked', () => {
    const std = fakeStd();
    const text = hueCube();
    const off = convertCube(text, {});
    expect(off.hueQ10).toBeUndefined();
    expect(off.params.hue).toBeUndefined();
    const on = convertCube(text, { hueStd: std });
    expect(on.hueQ10).toBeDefined();
    expect(on.hueQ10!.length).toBe(108);
    const cube = color.parseCube(text);
    const grid = Float64Array.from({ length: 9 * 9 * 9 * 3 }, (_, i) => { const n = (i / 3) | 0, c = i % 3; return ([n % 9, ((n / 9) | 0) % 9, (n / 81) | 0][c]) / 8; });
    const want = color.lab(color.applyCube(cube, grid));
    const err = (p: color.SlotParams): number => { const d = color.deltaE2000Lab(color.lab(color.slotApply(p, grid)), want); return d.reduce((a, v) => a + v, 0) / d.length; };
    const before = err({ ...off.params, hue: std, hueStd: std });
    const after = err(on.params);
    expect(after).toBeLessThan(before * 0.9);
    const grey = Float64Array.from(Array.from({ length: 33 }, (_, i) => [i / 32, i / 32, i / 32]).flat());
    const wantG = color.lab(color.applyCube(cube, grey));
    const errG = (p: color.SlotParams): number => { const d = color.deltaE2000Lab(color.lab(color.slotApply(p, grey)), wantG); return d.reduce((a, v) => a + v, 0) / d.length; };
    expect(errG(on.params)).toBeLessThanOrEqual(errG({ ...off.params, hue: std, hueStd: std }) + 0.02);
  }, 120_000);
});

describe.skipIf(!have)('hue sectors: firmware', () => {
  it('Standard\'s block follows the copy rule within one step; a slot with its own block is written, read back and verified', async () => {
    const raw = new Uint8Array(readFileSync(P + 'official.bin'));
    const eng = await Engine.open(raw);
    // Standard's block: copies 1..4 are copy 0 x (16 - c) / 16 within one step, rows exactly 1024 x (16 - c) / 16
    const dec = new fw.Firmware(raw).decoded;
    const o = fw.foff(fw.EXPECTED_STANDARD_MA_BLOCK);
    const std = dec.subarray(o, o + HUE_BLOCK_BYTES);
    const ours = hueBlockBytes(hueCopy0(std));
    const sv = new DataView(std.buffer, std.byteOffset, HUE_BLOCK_BYTES), ov = new DataView(ours.buffer);
    for (let i = 0; i < HUE_BLOCK_BYTES; i += 4) expect(Math.abs(sv.getInt32(i, true) - ov.getInt32(i, true))).toBeLessThanOrEqual(1);
    for (let i = 0; i < HUE_BLOCK_BYTES; i += 12) expect(sv.getInt32(i, true) + sv.getInt32(i + 4, true) + sv.getInt32(i + 8, true)).toBe(ov.getInt32(i, true) + ov.getInt32(i + 4, true) + ov.getInt32(i + 8, true));
    // the engine fits against this firmware's own Standard block
    const r = eng.convertPreset('cube', hueCube(), undefined, { hue: true });
    expect(r.hueQ10).toBeDefined();
    expect(eng.convertPreset('cube', hueCube()).hueQ10).toBeUndefined();
    const icon = fw.composeIcon(eng.info.tiles.film, new Float32Array(40 * 40).fill(0.5));
    const slot = { name: 'Hue', matrixQ13: Array.from(r.matrixQ13), curves: r.curves.map((c) => Array.from(c)) as [number[], number[], number[]], ...(r.postQ9 ? { postQ9: Array.from(r.postQ9) } : {}), hueQ10: r.hueQ10!, icon };
    const plain = { ...slot, name: 'Plain', hueQ10: undefined };
    const b = await eng.buildFirmware([], [], [], { extraSlots: [slot, plain] });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const secs = fw.sectionsOf(d);
    const rtos = secs.find((x) => x.name === 'RTOS')!, icons = secs.find((x) => x.name === 'ICONBIN')!;
    const back = fw.aspect.readExtraSlots(d.slice(rtos.offset, rtos.offset + rtos.size), d.subarray(icons.offset, icons.offset + icons.size), 2)!;
    expect(back[0].hueQ10).toEqual(r.hueQ10);
    expect(back[1].hueQ10).toBeUndefined();
    // without hue data the file is what it was before (same as a build of the plain slot alone)
    const without = await eng.buildFirmware([], [], [], { extraSlots: [{ ...slot, hueQ10: undefined }, plain] });
    expect(without.sha256).not.toBe(b.sha256);
    // a row that does not sum to 1024 is refused
    const bad = r.hueQ10!.slice(); bad[0] += 1;
    await expect(eng.buildFirmware([], [], [], { extraSlots: [{ ...slot, hueQ10: bad }] })).rejects.toThrow(/1024/);
  }, 240_000);
});
