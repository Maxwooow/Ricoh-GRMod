// SPDX-License-Identifier: GPL-2.0-only
/**
 * The focus distance while autofocusing (GR IV 1.20 and 1.21, `src/fw/gr4v120/aspect/afdist.ts`), a build option
 * (`afDistance`). The camera's code round it is checked in the emulator by tools/afdist/check.py and check_views.py.
 * Needs the official files (GRMOD_GR4_120_FIRMWARE, GRMOD_GR4_121_FIRMWARE).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';

const files = [['1.20', process.env.GRMOD_GR4_120_FIRMWARE], ['1.21', process.env.GRMOD_GR4_121_FIRMWARE]].filter(([, f]) => !!f && existsSync(f)) as [string, string][];
const file111 = new URL('../testdata/private/official.bin', import.meta.url);

const rtosOf = (file: Uint8Array): Uint8Array => {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(r.offset, r.offset + r.size);
};
const word = (b: Uint8Array, i: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, true);
/** Addresses inside the official image (its own length) where two builds differ. */
function changedInImage(official: Uint8Array, a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= official.length - 16; i += 4) if (word(a, i) !== word(b, i)) out.push(0x53000000 + i);
  return out;
}

for (const [version, path] of files) {
  describe(`focus distance while autofocusing (${version})`, () => {
    const raw = new Uint8Array(readFileSync(path));
    // the scale's allocation, its constructor and destructor, the screen's builder call, the scale function's autofocus case and way out,
    // the way out of the focus frames' function
    const places = version === '1.21' ? [0x53189e30, 0x5318a0c8, 0x5318bb68, 0x5318d7f8, 0x53592fd8, 0x535936c8, 0x535ae0b0] : [0x53189e58, 0x5318a0f0, 0x5318bb90, 0x5318d820, 0x535926b0, 0x53592da0, 0x535ad788];
    it('is offered, built only when asked for: seven words of the camera\'s code, the rest appended; read back', async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.afDistance).toBe(true);
      const plain = await e.buildFirmware([], [], [], { batteryPercent: true });
      const again = await e.buildFirmware([], [], [], { batteryPercent: true, afDistance: false });
      expect(again.sha256).toBe(plain.sha256);
      const on = await e.buildFirmware([], [], [], { batteryPercent: true, afDistance: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      expect(changedInImage(rtosOf(raw), rtosOf(plain.file), rtosOf(on.file))).toEqual(places);
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.afDistance).toBe(true);
      expect((await e.inspect(plain.file)).afDistance).toBeUndefined();
      await expect(e.buildFirmware([], [], [], { afDistance: 1 } as unknown as BuildOptions)).rejects.toThrow(/afDistance must be boolean/);
    });
    it('goes with distances in feet and the other additions of the shooting screen', async () => {
      const e = await Engine.open(raw);
      const all = { batteryPercent: true, distanceFeet: true, sensorShift: true, constantLight: true, subjectAf: true, movieExposure: true, lockProtect: true } as BuildOptions;
      const plain = await e.buildFirmware([], [], [], all);
      const on = await e.buildFirmware([], [], [], { ...all, afDistance: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const changed = changedInImage(rtosOf(raw), rtosOf(plain.file), rtosOf(on.file));
      for (const a of places) expect(changed).toContain(a);
      expect(await e.inspect(on.file)).toMatchObject({ verified: true, afDistance: true, distanceFeet: true, subjectAf: true, lockProtect: true });
      // with Handheld Night (the next bit of the same record byte; it is installed last): both read back
      const night = await e.buildFirmware([], [], [], { afDistance: true, handheldNight: true });
      expect(await e.inspect(night.file)).toMatchObject({ verified: true, afDistance: true, handheldNight: true });
      const nightOnly = await e.inspect((await e.buildFirmware([], [], [], { handheldNight: true })).file);
      expect(nightOnly.handheldNight).toBe(true);
      expect(nightOnly.afDistance).toBeUndefined();
      for (const a of places) expect(changedInImage(rtosOf(raw), rtosOf(raw), rtosOf(night.file))).toContain(a);
      // alone it is a change too
      const alone = await e.buildFirmware([], [], [], { afDistance: true });
      expect((await e.inspect(alone.file)).afDistance).toBe(true);
    });
  });
}

describe.skipIf(!existsSync(file111))('focus distance while autofocusing (1.11)', () => {
  it('is not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.afDistance).toBeFalsy();
    await expect(e.buildFirmware([], [], [], { afDistance: true })).rejects.toThrow(/focus distance/);
  });
});
