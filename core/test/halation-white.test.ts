/**
 * White halation from 0.9 (GR IV): Weak / Medium scatter like a diffusion filter, Strong the white
 * glow from a lower start. What the module does on camera pictures is checked in an emulator
 * (tools/halation/check.py, against halateYcc); here: the tables, the reference's behaviour, the
 * built context and read-back, and that GR III / IIIx keep the 0.8.9 module.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine, fw } from '../src';
import * as aspect from '../src/fw/aspect';
import { HALATION, halateYcc, halationGains, halationLight, halationModule, scatterParams, scatterTables } from '../src/fw/aspect/halation';
import { HALATION_SOURCE_SHA256 } from '../src/fw/aspect/halation-code';
import { HALATION_SOURCE_SHA256 as HALATION_SOURCE_SHA256_120 } from '../src/fw/gr4v120/aspect/halation-code';
import { HALATION_CODE_089_LENGTH, HALATION_SOURCE_089_SHA256 } from '../src/fw/aspect/halation-code-089';
import { Patch } from '../src/fw/aspect/build';
import type { ExtraSlotSpec } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** A picture: a dark room with a grey wall, a face-bright patch and a lamp. */
function scene(w: number, h: number): { Y: Uint8Array; C: Uint8Array } {
  const Y = new Uint8Array(w * h), C = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - w * 0.7, y - h * 0.4);
    let v = 40 + ((x * 7 + y * 3) % 23);
    if (x > w * 0.15 && x < w * 0.35 && y > h * 0.3 && y < h * 0.7) v = 160;
    if (d < h * 0.05) v = 255;
    Y[y * w + x] = v;
    C[y * w + x] = 128 + ((x & 1) ? 6 : -4);
  }
  return { Y, C };
}

describe('white halation 0.9: tables and parameters', () => {
  it('levels go to linear light and back unchanged', () => {
    const { lin, expand, srgb } = scatterTables();
    for (let v = 0; v < 256; v++) expect(srgb[lin[v]]).toBe(v);
    expect(lin[255]).toBe(16384);
    expect(expand[0]).toBe(256);
    expect(expand[255]).toBe(256 * (1 + HALATION.scatter.open));
    for (let v = 1; v < 256; v++) expect(expand[v]).toBeGreaterThanOrEqual(expand[v - 1]);
  });
  it('Weak / Medium shares, widths and their mix in the module units', () => {
    const p = scatterParams();
    expect(p.k).toEqual([328, 614]);
    expect(p.rad).toEqual([16, 82, 246]);
    expect(p.weight.reduce((a, b) => a + b, 0)).toBe(256);
    expect(p.strongGain).toBe(25);
  });
  it("Strong's light starts at 150 (Standard), the red / 0.8.2 light at 220", () => {
    const l = halationLight();
    expect(l.strong![150]).toBe(0);
    expect(l.strong![153]).toBeGreaterThan(0);
    expect(l.table[200]).toBe(0);
    expect(l.strong![255]).toBe(16384);
  });
  it('the module sources are the ones compiled (1.11 and its 1.20 copy)', () => {
    const src = readFileSync(new URL('../../tools/halation/halation.c', import.meta.url));
    expect(HALATION_SOURCE_SHA256).toBe(sha(src));
    expect(HALATION_SOURCE_SHA256_120).toBe(sha(readFileSync(new URL('../../tools/gr4v120/halation/halation.c', import.meta.url))));
  });
  it('GR III / IIIx keep the 0.8.9 module', () => {
    expect(halationModule().length).toBe(HALATION_CODE_089_LENGTH);
    expect(HALATION_SOURCE_089_SHA256).toBe('b0c6f88f7079301e28a9c21c364240c433ab62c788587c09938c5ca606cb6ba2');
  });
});

describe('white halation 0.9: the reference (halateYcc)', () => {
  const w = 320, h = 200;
  const run = (level: 1 | 2 | 3, white: 'scatter' | 'classic', colour: 'red' | 'white' = 'white') => {
    const { Y, C } = scene(w, h);
    halateYcc(Y, C, w, h, level, halationLight(), colour, white);
    return { Y, C };
  };
  it('Weak / Medium: the face-bright patch and the shadows near the lamp lift a little; Medium more than Weak', () => {
    const base = scene(w, h).Y;
    const at = (a: Uint8Array, x: number, y: number) => a[y * w + x];
    const weak = run(1, 'scatter').Y, medium = run(2, 'scatter').Y;
    // next to the lamp, in the dark: haze, more at Medium
    const nx = Math.round(w * 0.7 + h * 0.09), ny = Math.round(h * 0.4);
    expect(at(weak, nx, ny)).toBeGreaterThan(at(base, nx, ny));
    expect(at(medium, nx, ny)).toBeGreaterThan(at(weak, nx, ny));
    // the patch at 160 changes only a little (no white patch)
    const px = Math.round(w * 0.25), py = Math.round(h * 0.5);
    expect(Math.abs(at(medium, px, py) - 160)).toBeLessThan(12);
  });
  it('Strong: a patch at 215 glows (lower start), much more than the 0.8.2 white at Strong', () => {
    const px = Math.round(w * 0.25), py = Math.round(h * 0.3) - 2;
    const at215 = (white: 'scatter' | 'classic') => {
      const { Y, C } = scene(w, h);
      for (let i = 0; i < Y.length; i++) if (Y[i] === 160) Y[i] = 215;
      const base = Y.slice();
      halateYcc(Y, C, w, h, 3, halationLight(), 'white', white);
      return { Y, base };
    };
    const s = at215('scatter'), c = at215('classic');
    const lift = (r: { Y: Uint8Array; base: Uint8Array }) => r.Y[py * w + px] - r.base[py * w + px];
    expect(lift(s)).toBeGreaterThan(lift(c) + 3);
  });
  it('classic white and red are as before 0.9 (gains of the levels, the look table)', () => {
    expect(halationGains()).toEqual([48, 72, 96]);
    const a = run(2, 'classic').Y, b = run(2, 'scatter', 'red').Y, c = run(2, 'classic', 'red').Y;
    expect(sha(b)).toBe(sha(c));
    expect(sha(a)).not.toBe(sha(run(2, 'scatter').Y));
  });
});

describe.skipIf(!have)('white halation 0.9: built files', () => {
  it('the context carries the scatter and Strong lights; read back; verifies', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const icon = fw.composeIcon(eng.info.tiles.film, new Float32Array(40 * 40).fill(0.7));
    const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, i * 64));
    const slot: ExtraSlotSpec = { name: 'GR Mod 1', matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [curve, curve, curve], postQ9: [512, 0, 0, 0, 512, 0, 0, 0, 512], icon, halation: true };
    const b = await eng.buildFirmware([], [], [], { extraSlots: [slot] });
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const patch = new Patch(d.slice(r.offset, r.offset + r.size));
    const light = aspect.readHalationLight(patch, 34);
    expect(light).toEqual(halationLight(slot.curves, slot.postQ9));
    expect(light!.strong).toBeInstanceOf(Uint16Array);
  });
});
