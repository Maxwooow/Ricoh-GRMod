// SPDX-License-Identifier: GPL-2.0-only
/**
 * The mode dial's lock button protects the picture in single-picture playback (GR IV 1.20 and 1.21,
 * `src/fw/gr4v120/aspect/lockprotect.ts`), as a build option (`lockProtect`). The camera's code round the button is
 * checked in the emulator by tools/lockprotect/check.py. Needs the official files (GRMOD_GR4_120_FIRMWARE,
 * GRMOD_GR4_121_FIRMWARE).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions, ExtraSlotSpec } from '../src';

const files = [['1.20', process.env.GRMOD_GR4_120_FIRMWARE], ['1.21', process.env.GRMOD_GR4_121_FIRMWARE]].filter(([, f]) => !!f && existsSync(f)) as [string, string][];
const file111 = new URL('../testdata/private/official.bin', import.meta.url);

const rtosOf = (file: Uint8Array): Uint8Array => {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(r.offset, r.offset + r.size);
};
const word = (b: Uint8Array, i: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, true);
function slotSpec(eng: Engine, k: number): ExtraSlotSpec {
  const icon = fw.composeIcon(eng.info.tiles.film, new Float32Array(40 * 40).fill(k % 2 ? 0.3 : 0.7));
  const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(i * 64 * (1 + 0.01 * k))));
  return { name: `Look ${k + 1}`, matrixQ13: [8192 + 100 * k, -50 * k, -50 * k, 0, 8192, 0, 0, -20 * k, 8192 + 20 * k], curves: [curve, curve, curve], icon };
}
/** Word offsets inside the official image (its own length) where two builds differ. */
function changedInImage(official: Uint8Array, a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= official.length - 16; i += 4) if (word(a, i) !== word(b, i)) out.push(0x53000000 + i);
  return out;
}

for (const [version, path] of files) {
  describe(`lock button protects (${version})`, () => {
    const raw = new Uint8Array(readFileSync(path));
    it('is offered, built only when asked for, a few words of the camera\'s code and an appended stub; read back', async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.lockProtect).toBe(true);
      const plain = await e.buildFirmware([], [], [], { batteryPercent: true });
      const on = await e.buildFirmware([], [], [], { batteryPercent: true, lockProtect: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const official = rtosOf(raw);
      const changed = changedInImage(official, rtosOf(plain.file), rtosOf(on.file));
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.length).toBeLessThanOrEqual(4);
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.lockProtect).toBe(true);
      expect((await e.inspect(plain.file)).lockProtect).toBeUndefined();
    });
    it('goes with the 0.9.4 additions (halation and white balance per look, subject recognition, added slots)', async () => {
      const e = await Engine.open(raw);
      const all = { extraSlots: [slotSpec(e, 0), slotSpec(e, 1)], batteryPercent: true, dateStamp: true, directFlash: true, flashTtl: true, videoAf: true, awbLearn: true,
        movieExposure: true, distanceFeet: true, subjectAf: true, wbPerLook: true, halationAll: true } as BuildOptions;
      const plain = await e.buildFirmware([], [], [], all);
      const on = await e.buildFirmware([], [], [], { ...all, lockProtect: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const official = rtosOf(raw);
      // its own words, and the eight hook branches of subject recognition, whose stubs are appended after its stub
      const changed = changedInImage(official, rtosOf(plain.file), rtosOf(on.file));
      const alone = changedInImage(official, rtosOf(await e.buildFirmware([], [], [], { batteryPercent: true }).then((x) => x.file)), rtosOf(await e.buildFirmware([], [], [], { batteryPercent: true, lockProtect: true }).then((x) => x.file)));
      for (const a of alone) expect(changed).toContain(a);
      expect(changed.length).toBeLessThanOrEqual(alone.length + 8);
      const summary = await e.inspect(on.file);
      expect(summary).toMatchObject({ verified: true, lockProtect: true, subjectAf: true, wbPerLook: true, halationAll: true, distanceFeet: true });
    });
  });
}

describe.skipIf(!existsSync(file111))('lock button protects (1.11)', () => {
  it('is not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.lockProtect).toBeFalsy();
    await expect(e.buildFirmware([], [], [], { lockProtect: true })).rejects.toThrow(/lock button/);
  });
});
