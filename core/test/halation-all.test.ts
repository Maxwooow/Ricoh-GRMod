// SPDX-License-Identifier: GPL-2.0-only
/**
 * Halation for every look (`gr4v120/aspect/halation-all.ts`, the slot-parameters module with SP_EXT, GR IV 1.20 and
 * 1.21). Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * What the hooks and the module do in the camera's settings and the development step is checked in an emulator by
 * tools/gr4v121/slotparams/test_halation_all.py; the JPEG step's halation of a factory look by
 * tools/gr4v120/halation/check.py --style N.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions, ExtraSlotSpec } from '../src';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';
const file111 = P + 'official.bin';

// Per release: the parameter screens' row tables (shooting, RAW development).
const releases = [
  { version: '1.20', path: file120, SHOOT: 0x53dc4b3c, RAW: 0x53dc487c },
  { version: '1.21', path: file121, SHOOT: 0x53dc61a4, RAW: 0x53dc5ee4 },
];

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const bytes = (b: Uint8Array, at: number, n: number) => Array.from(b.subarray(at - 0x53000000, at - 0x53000000 + n));

function slotSpec(eng: Engine, k: number): ExtraSlotSpec {
  const icon = fw.composeIcon(eng.info.tiles.film, new Float32Array(40 * 40).fill(k % 2 ? 0.3 : 0.7));
  const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(i * 64 * (1 + 0.01 * k))));
  return { name: `Look ${k + 1}`, matrixQ13: [8192 + 100 * k, -50 * k, -50 * k, 0, 8192, 0, 0, -20 * k, 8192 + 20 * k], curves: [curve, curve, curve], icon };
}

for (const { version, path, SHOOT, RAW } of releases) describe.skipIf(!existsSync(path))(`halation for every look ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();

  it('every look group of every photo set gets one Halation row (stills only); verified and read back', async () => {
    const e = await Engine.open(raw);
    expect(e.info.features.halationAll).toBe(true);
    const extraSlots = [slotSpec(e, 0), slotSpec(e, 1)];
    const on = await e.buildFirmware([], [], [], { extraSlots, halationAll: true });
    expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
    const b = rtos(on.file), official = rtos(raw);
    for (let k = 0; k < 88; k++) {
      const n = word(b, SHOOT + 8 * k + 4) & 0xffff, pairs = bytes(b, word(b, SHOOT + 8 * k), 2 * n);
      const kinds = pairs.filter((_, i) => i % 2 === 1);
      expect(kinds.filter((x) => x === 8).length).toBe(1);
      expect(pairs[2 * kinds.indexOf(8)]).toBe(0);
      expect(n).toBe((word(official, SHOOT + 8 * k + 4) & 0xffff) + (bytes(official, word(official, SHOOT + 8 * k), 2 * n).filter((_, i) => i % 2 === 1).includes(8) ? 0 : 1));
      const rn = word(b, RAW + 8 * k + 4) & 0xff;
      expect(bytes(b, word(b, RAW + 8 * k), rn).filter((x) => x === 8).length).toBe(1);
    }
    const summary = await e.inspect(on.file);
    expect(summary.verified).toBe(true);
    expect(summary.halationAll).toBe(true);
  }, 180000);

  it('with white balance per look and the other additions: verified and read back', async () => {
    const e = await Engine.open(raw);
    const on = await e.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }], [], { extraSlots: [slotSpec(e, 0)], halationAll: true, wbPerLook: true, dateStamp: true, filmGrain: true, distanceFeet: true } as BuildOptions);
    expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
    const summary = await e.inspect(on.file);
    expect(summary.verified).toBe(true);
    expect(summary).toMatchObject({ halationAll: true, wbPerLook: true, dateStamp: true, filmGrain: true, distanceFeet: true });
  }, 180000);

  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const extraSlots = [slotSpec(e, 0)];
    const a = await e.buildFirmware([], [], [], { extraSlots });
    const b = await e.buildFirmware([], [], [], { extraSlots, halationAll: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).halationAll).toBeUndefined();
  }, 60000);

  it('refuses a non-boolean switch, and a build without added slots', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { extraSlots: [slotSpec(e, 0)], halationAll: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(e.buildFirmware([], [], [], { dateStamp: true, halationAll: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('halation for every look: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.halationAll).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { extraSlots: [slotSpec(e, 0)], halationAll: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
