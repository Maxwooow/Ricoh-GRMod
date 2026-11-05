// SPDX-License-Identifier: GPL-2.0-only
/**
 * The experimental ports to the cameras' current firmware (GR IV 1.20, GR III 2.20, GR IIIx 1.70) are
 * only opened when asked for (`OpenOptions.newFirmware`, which the released app never sets), each file
 * by the program made for it, and the 1.11 / 2.10 / 1.60 files exactly as before either way.
 *
 * Needs GRMOD_GR4_120_FIRMWARE (fwdc248b.bin 1.20), GRMOD_GR3_220_FIRMWARE, GRMOD_GR3X_170_FIRMWARE and the
 * official 1.11 file at testdata/private/official.bin; each case is skipped when its file is missing.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';

const files: Record<string, string | undefined> = {
  '1.20': process.env.GRMOD_GR4_120_FIRMWARE, '2.20': process.env.GRMOD_GR3_220_FIRMWARE, '1.70': process.env.GRMOD_GR3X_170_FIRMWARE,
};
const official = new URL('../testdata/private/official.bin', import.meta.url).pathname;

describe('new firmware line', () => {
  for (const [version, path] of Object.entries(files)) {
    it.skipIf(!path || !existsSync(path))(`${version}: refused unless asked for, opened as ${version} when asked`, async () => {
      const raw = new Uint8Array(readFileSync(path!));
      await expect(Engine.open(raw, { newFirmware: false })).rejects.toMatchObject({ code: 'unsupported-firmware' });
      const eng = await Engine.open(raw, { newFirmware: true });
      expect(eng.info.version).toBe(version);
      expect(eng.info.capabilities.bridge).toBe(false);
      if (version === '1.20') await expect(eng.bridgeFirmware()).rejects.toMatchObject({ code: 'unsupported-firmware' });
      const same = await eng.inspect(raw);
      expect(same.kind).toBe('official');
    }, 120_000);
  }
  it.skipIf(!existsSync(official))('1.11: the same with or without the new firmware', async () => {
    const raw = new Uint8Array(readFileSync(official));
    for (const newFirmware of [false, true]) {
      const eng = await Engine.open(raw, { newFirmware });
      expect(eng.info.version).toBe('1.11');
      expect(eng.info.capabilities.bridge).toBe(true);
    }
  }, 120_000);
});
