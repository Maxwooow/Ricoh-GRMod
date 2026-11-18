// SPDX-License-Identifier: GPL-2.0-only
/**
 * Every official release GR Mod builds on is opened by the program made for it (the engine chooses by
 * the file's SHA-256): the version it reports is the file's, and the file inspects as official.
 *
 * Needs GRMOD_GR4_120_FIRMWARE (fwdc248b.bin 1.20), GRMOD_GR3_220_FIRMWARE, GRMOD_GR3X_170_FIRMWARE, their
 * 1.21 / 2.21 / 1.71 counterparts (GRMOD_GR4_121_FIRMWARE, GRMOD_GR3_221_FIRMWARE, GRMOD_GR3X_171_FIRMWARE) and the
 * official 1.11 file at testdata/private/official.bin; each case is skipped when its file is missing.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/app/engine';

const files: Record<string, string | undefined> = {
  '1.20': process.env.GRMOD_GR4_120_FIRMWARE, '2.20': process.env.GRMOD_GR3_220_FIRMWARE, '1.70': process.env.GRMOD_GR3X_170_FIRMWARE,
  '1.21': process.env.GRMOD_GR4_121_FIRMWARE, '2.21': process.env.GRMOD_GR3_221_FIRMWARE, '1.71': process.env.GRMOD_GR3X_171_FIRMWARE,
  '1.11': fileURLToPath(new URL('../testdata/private/official.bin', import.meta.url)),
};

describe('every supported release opens as itself', () => {
  for (const [version, path] of Object.entries(files)) {
    it.skipIf(!path || !existsSync(path))(`${version}`, async () => {
      const raw = new Uint8Array(readFileSync(path!));
      const eng = await Engine.open(raw);
      expect(eng.info.version).toBe(version);
      const same = await eng.inspect(raw);
      expect(same.kind).toBe('official');
    }, 120_000);
  }
  it('anything else is refused', async () => {
    await expect(Engine.open(new Uint8Array(4096))).rejects.toMatchObject({ code: 'unsupported-firmware' });
  });
});
