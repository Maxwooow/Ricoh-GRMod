// SPDX-License-Identifier: GPL-2.0-only
/**
 * The HLG photo mode on every GR IV program, built on the official files and read back:
 * GR IV 1.21 (ported from 1.20 by address, DEC-HLG-121-002), 1.20 and 1.11. Also HLG together with an
 * added slot that has halation: both point the same playback / RAW development scale instruction at a
 * graphic of their own (DEC-HLG-HALATION-001), and before the fix each refused the other's word there.
 *
 * Needs GRMOD_GR4_121_FIRMWARE, GRMOD_GR4_120_FIRMWARE and testdata/private/official.bin (1.11);
 * each case is skipped when its file is missing.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';

const files: [string, string | undefined][] = [
  ['1.21', process.env.GRMOD_GR4_121_FIRMWARE],
  ['1.20', process.env.GRMOD_GR4_120_FIRMWARE],
  ['1.11', new URL('../testdata/private/official.bin', import.meta.url).pathname],
];
const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, 0.8))));
const slot = (halation: boolean) => ({
  name: 'HLG mate', matrixQ13: [9100, -600, -308, -300, 8800, -308, -100, -700, 8992], curves: [curve, curve, curve] as [number[], number[], number[]],
  icon: new Uint8Array(1600 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) & 255)), halation,
});

for (const [version, path] of files) {
  describe.skipIf(!path || !existsSync(path))(`HLG photo on GR IV ${version}`, () => {
    const open = async () => Engine.open(new Uint8Array(readFileSync(path!)));

    it('is offered, builds with every check passing and reads back', async () => {
      const e = await open();
      expect(e.info.version).toBe(version);
      expect(e.info.features.hlgPhoto).toBe(true);
      const b = await e.buildFirmware([], [], [], { hlgPhoto: true });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const back = await e.inspect(b.file);
      expect(back.verified).toBe(true);
      expect(back.hlgPhoto).toBe(true);
    }, 300_000);

    it('builds together with an added slot that has halation, and both read back', async () => {
      const e = await open();
      const b = await e.buildFirmware([], [], [], { hlgPhoto: true, extraSlots: [slot(true)] });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const back = await e.inspect(b.file);
      expect(back.verified).toBe(true);
      expect(back.hlgPhoto).toBe(true);
      expect(back.extraSlots.map((x) => x.name)).toEqual(['HLG mate']);
    }, 300_000);

    it('is still refused together with the HDR gain map', async () => {
      const e = await open();
      await expect(e.buildFirmware([], [], [], { hlgPhoto: true, hdrGainMap: true })).rejects.toMatchObject({ code: 'bad-hlg' });
    }, 300_000);
  });
}
