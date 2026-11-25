// SPDX-License-Identifier: GPL-2.0-only
/**
 * Dim-light AF (`gr3x/dimaf.ts`, GR IIIx 1.60 only). Needs GRMOD_GR3X_FIRMWARE (1.60); the "not offered" cases
 * GRMOD_GR3_FIRMWARE (GR III 2.10, the same program), GRMOD_GR3X_170_FIRMWARE and GRMOD_GR3X_171_FIRMWARE.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sectionsOf } from '../src/fw/container';
import { GR3X_DIM_LIGHT_AF_SITES, installGr3xDimLightAf } from '../src/fw/gr3x/dimaf';
import { GR3X_160 } from '../src/fw/gr3-profiles';

// GR III / IIIx builds take 1 to 7 added ratios.
const RATIOS = [{ ratio: '16:9', name: '16:9' }];

const BASE = GR3X_160.rtosBase;
// The contrast-AF units CafProcess, CafDetection and CafWobbling, compiled back to back, and their data.
const AF_CODE = [0x533f3d18, 0x53417990] as const, AF_DATA = [0x53c16bb0, 0x53c16d18] as const;
const inside = (a: number, [lo, hi]: readonly [number, number]) => a >= lo && a < hi;

describe('dim-light AF sites', () => {
  it('are nineteen distinct words, in the contrast-AF code or its data, each a change', () => {
    expect(GR3X_DIM_LIGHT_AF_SITES).toHaveLength(19);
    expect(new Set(GR3X_DIM_LIGHT_AF_SITES.map(s => s[0])).size).toBe(19);
    for (const [address, stock, patched] of GR3X_DIM_LIGHT_AF_SITES) {
      expect(address % 4).toBe(0);
      expect(inside(address, AF_CODE) || inside(address, AF_DATA), address.toString(16)).toBe(true);
      expect(patched).not.toBe(stock);
    }
  });
  it('are written through the program\'s checked patch, one call per word', () => {
    const calls: [number, number, number][] = [];
    installGr3xDimLightAf({ patch: (a, e, r) => { calls.push([a, e, r]); } });
    expect(calls).toEqual(GR3X_DIM_LIGHT_AF_SITES.map(([a, e, r]) => [a, e, r]));
  });
});

const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input || !existsSync(input))('dim-light AF on GR IIIx 1.60', () => {
  let raw: Uint8Array; let engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  const rtosWord = (decoded: Uint8Array, address: number) => {
    const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS')!;
    return new DataView(decoded.buffer, decoded.byteOffset).getUint32(rtos.offset + address - BASE, true);
  };

  it('is offered, and the official file has the stock word at every site', () => {
    expect(engine.info.features.dimLightAf).toBe(true);
    const official = new Firmware(raw).decoded;
    for (const [address, stock] of GR3X_DIM_LIGHT_AF_SITES) expect(rtosWord(official, address), address.toString(16)).toBe(stock);
  });

  for (const [name, options] of [
    ['alone', {}],
    ['with films, the date imprint and ADJ soft focus', { filmCount: 3, dateStamp: true, adjSoftFocus: true }],
  ] as const) it(`${name}: exactly the nineteen words differ in the official RTOS, the rest as without it; verified and read back`, async () => {
    const plain = await engine.buildFirmware([], RATIOS, [], { ...options });
    const built = await engine.buildFirmware([], RATIOS, [], { ...options, dimLightAf: true });
    const a = new Firmware(plain.file).decoded, b = new Firmware(built.file).decoded;
    const ra = sectionsOf(a).find(s => s.name === 'RTOS')!, rb = sectionsOf(b).find(s => s.name === 'RTOS')!;
    expect(rb.offset).toBe(ra.offset);
    const changed: number[] = [];
    for (let at = 0; at < GR3X_160.rtosLength; at += 4) {
      const o = ra.offset + at;
      if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) changed.push(BASE + at);
    }
    expect(changed).toEqual(GR3X_DIM_LIGHT_AF_SITES.map(s => s[0]).sort((x, y) => x - y));
    for (const [address, , patched] of GR3X_DIM_LIGHT_AF_SITES) expect(rtosWord(b, address), address.toString(16)).toBe(patched);
    // The appended code is the same; only the recorded recipe after it says more.
    const code = a.subarray(ra.offset + GR3X_160.rtosLength, ra.offset + ra.size);
    const magic = new TextEncoder().encode('GR3X-RATIO-RECIPE\0');
    const recipeAt = (d: Uint8Array) => { for (let i = 0; i + magic.length <= d.length; i++) if (magic.every((v, k) => d[i + k] === v)) return i; return -1; };
    const end = recipeAt(code);
    expect(end).toBeGreaterThan(0);
    expect(Buffer.compare(code.subarray(0, end), b.subarray(rb.offset + GR3X_160.rtosLength, rb.offset + GR3X_160.rtosLength + end))).toBe(0);
    // Every other section is the same.
    for (const s of sectionsOf(a).filter(x => x.name !== 'RTOS')) {
      const t = sectionsOf(b).find(x => x.name === s.name)!;
      expect(t.size, s.name).toBe(s.size);
      expect(Buffer.compare(a.subarray(s.offset, s.offset + s.size), b.subarray(t.offset, t.offset + t.size)), s.name).toBe(0);
    }
    expect(Object.values(built.checks).every(Boolean)).toBe(true);
    const seen = await engine.inspect(built.file);
    expect(seen).toMatchObject({ kind: 'modified', verified: true, dimLightAf: true });
    expect((await engine.inspect(plain.file)).dimLightAf).toBeUndefined();
  }, 600_000);

  it('refuses a value that is not a boolean', async () => {
    await expect(engine.buildFirmware([], RATIOS, [], { dimLightAf: 1 as unknown as boolean })).rejects.toThrow('dimLightAf must be boolean');
  });
});

for (const [camera, path] of [
  ['GR III 2.10', process.env.GRMOD_GR3_FIRMWARE],
  ['GR IIIx 1.70', process.env.GRMOD_GR3X_170_FIRMWARE],
  ['GR IIIx 1.71', process.env.GRMOD_GR3X_171_FIRMWARE],
] as const) describe.skipIf(!path || !existsSync(path))(`dim-light AF not offered on ${camera}`, () => {
  it('is not in the features, and a build that asks for it is refused', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(path!)));
    expect(engine.info.features.dimLightAf).toBeUndefined();
    await expect(engine.buildFirmware([], RATIOS, [], { dimLightAf: true })).rejects.toThrow('the dim-light AF needs GR IIIx firmware 1.60');
  }, 600_000);
});
