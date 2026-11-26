// SPDX-License-Identifier: GPL-2.0-only
/**
 * Dim-light AF (`gr3x/dimaf.ts`, GR IIIx 1.60 / 1.70 / 1.71 and GR III 2.10 / 2.20 / 2.21, whose RTOS is GR IIIx's but
 * for identity words). Needs GRMOD_GR3X_FIRMWARE (1.60), GRMOD_GR3X_170_FIRMWARE, GRMOD_GR3X_171_FIRMWARE,
 * GRMOD_GR3_FIRMWARE, GRMOD_GR3_220_FIRMWARE, GRMOD_GR3_221_FIRMWARE; the "not offered" case GR IV (GRMOD_GR4_121_FIRMWARE).
 *
 * Where each site is in 1.70 / 1.71 is written here on its own (not taken from the program's address tables), as found
 * in the official images: the margin-scale code moved by +0xf0 / +0x2a40, the drive-level choice by +0xf0 / +0x2a38, the
 * contrast-AF data by -0x6c0 / +0x7e58. Two stock words name a moved address (the floor's movw, the bl to sqrt).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sectionsOf } from '../src/fw/container';
import { GR3X_DIM_LIGHT_AF_SITES, installGr3xDimLightAf } from '../src/fw/gr3x/dimaf';
import { GR3X_160, GR3X_170, GR3X_171, GR3_210, GR3_220, GR3_221 } from '../src/fw/gr3-profiles';

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

/** A 1.60 site's address in a release, and its stock word there. */
const RELEASES = [
  { release: '1.60', input: process.env.GRMOD_GR3X_FIRMWARE, profile: GR3X_160, code: 0, drive: 0, data: 0, words: {} as Record<number, number> },
  { release: '1.70', input: process.env.GRMOD_GR3X_170_FIRMWARE, profile: GR3X_170, code: 0xf0, drive: 0xf0, data: -0x6c0, words: { 0x5340c5f4: 0xe3063514, 0x5340c610: 0xebf51d58 } },
  { release: '1.71', input: process.env.GRMOD_GR3X_171_FIRMWARE, profile: GR3X_171, code: 0x2a40, drive: 0x2a38, data: 0x7e58, words: { 0x5340c5f4: 0xe30e3a2c, 0x5340c610: 0xebf516e4 } },
  // GR III: the same addresses and words as the GR IIIx release of the same program.
  { release: '2.10', input: process.env.GRMOD_GR3_FIRMWARE, profile: GR3_210, code: 0, drive: 0, data: 0, words: {} as Record<number, number> },
  { release: '2.20', input: process.env.GRMOD_GR3_220_FIRMWARE, profile: GR3_220, code: 0xf0, drive: 0xf0, data: -0x6c0, words: { 0x5340c5f4: 0xe3063514, 0x5340c610: 0xebf51d58 } },
  { release: '2.21', input: process.env.GRMOD_GR3_221_FIRMWARE, profile: GR3_221, code: 0x2a40, drive: 0x2a38, data: 0x7e58, words: { 0x5340c5f4: 0xe30e3a2c, 0x5340c610: 0xebf516e4 } },
] as const;
// The 1.60 sites (this module's own target is 1.60's).
const SITES160 = GR3X_DIM_LIGHT_AF_SITES.map(([a, stock, patched]) => ({ a, stock, patched }));
const where = (r: typeof RELEASES[number], a: number) => a + (a === 0x533f4b10 ? r.drive : a < 0x53c00000 ? r.code : r.data);

for (const r of RELEASES) describe.skipIf(!r.input || !existsSync(r.input))(`dim-light AF on ${r.profile.camera} ${r.release}`, () => {
  const input = r.input, BASE = r.profile.rtosBase;
  const sites = SITES160.map(({ a, stock, patched }) => ({ address: where(r, a), stock: (r.words as Record<number, number>)[a] ?? stock, patched }));
  let raw: Uint8Array; let engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  const rtosWord = (decoded: Uint8Array, address: number) => {
    const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS')!;
    return new DataView(decoded.buffer, decoded.byteOffset).getUint32(rtos.offset + address - BASE, true);
  };

  it('is offered, and the official file has the stock word at every site', () => {
    expect(engine.info.features.dimLightAf).toBe(true);
    const official = new Firmware(raw).decoded;
    for (const { address, stock } of sites) expect(rtosWord(official, address), address.toString(16)).toBe(stock);
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
    for (let at = 0; at < r.profile.rtosLength; at += 4) {
      const o = ra.offset + at;
      if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) changed.push(BASE + at);
    }
    expect(changed).toEqual(sites.map(s => s.address).sort((x, y) => x - y));
    for (const { address, patched } of sites) expect(rtosWord(b, address), address.toString(16)).toBe(patched);
    // The appended code is the same; only the recorded recipe after it says more.
    const code = a.subarray(ra.offset + r.profile.rtosLength, ra.offset + ra.size);
    const magic = new TextEncoder().encode('GR3X-RATIO-RECIPE\0');
    const recipeAt = (d: Uint8Array) => { for (let i = 0; i + magic.length <= d.length; i++) if (magic.every((v, k) => d[i + k] === v)) return i; return -1; };
    const end = recipeAt(code);
    expect(end).toBeGreaterThan(0);
    expect(Buffer.compare(code.subarray(0, end), b.subarray(rb.offset + r.profile.rtosLength, rb.offset + r.profile.rtosLength + end))).toBe(0);
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
  ['GR IV 1.21', process.env.GRMOD_GR4_121_FIRMWARE],
] as const) describe.skipIf(!path || !existsSync(path))(`dim-light AF not offered on ${camera}`, () => {
  it('is not in the features, and a build that asks for it is refused', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(path!)));
    expect(engine.info.features.dimLightAf).toBeUndefined();
    await expect(engine.buildFirmware([], [], [], { dimLightAf: true })).rejects.toThrow('the dim-light AF needs GR III / IIIx firmware');
  }, 600_000);
});
