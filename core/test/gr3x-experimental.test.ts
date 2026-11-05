// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGr3xExperiment } from '../src/fw/gr3x/experimental';
import { GR3X_160 } from '../src/fw/gr3x/profile';
import { branchTarget } from '../src/fw/aspect/arm';
import { sha256Hex } from '../src/fw/container';
import { Engine } from '../src';

const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('GR IIIx isolated ARM experiments', () => {
  let raw: Uint8Array;
  let manifest: Awaited<ReturnType<typeof buildGr3xExperiment>>;
  beforeAll(async () => {
    raw = new Uint8Array(readFileSync(input!));
    manifest = await buildGr3xExperiment(raw);
  });
  it('keeps experiments isolated from the fixed-nine production recipe', async () => {
    expect(await sha256Hex(raw)).toBe(GR3X_160.sha256);
    expect(manifest.firmwareGenerated).toBe(false);
    expect(manifest.hardwareTested).toBe(false);
    expect(manifest.rearDialPatched).toBe(false);
    const engine = await Engine.open(raw);
    // Power-off images and the factory entry needed a start-up script on the card; GR Mod 0.8 dropped that route.
    expect(engine.info.capabilities).toEqual({ build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false, menuPictures: true, lookLayout: true });
    await expect(engine.buildFirmware([], [{ name: '65:24', ratio: '65:24' }], [], { extraSlots: [{} as never] }))
      .rejects.toMatchObject({ code: 'gr3x-unsupported' });
    await expect(engine.buildFirmware([], [{ name: '65:24', ratio: '65:24' }], [], { shutdownPictures: [{} as never] })).rejects.toThrow();
  });
  it('branches within the original probe page and leaves the PC-relative VFP load in place', () => {
    const start = GR3X_160.rtosBase + GR3X_160.rtosLength;
    const end = start + manifest.append.bytes.length / 2;
    expect(manifest.sites.map(s => s.address)).toEqual([0x536a2a34, 0x5366634c, 0x53666500]);
    expect(manifest.append.address).toBe(start);
    expect(end).toBeLessThanOrEqual(GR3X_160.rtosBase + Math.ceil(GR3X_160.rtosLength / 4096) * 4096);
    for (const site of manifest.sites) {
      const word = Buffer.from(site.replacement, 'hex').readUInt32LE();
      const target = branchTarget(site.address, word);
      expect(target).toBeGreaterThanOrEqual(start); expect(target).toBeLessThan(end);
    }
    expect(manifest.entries.directedCycle).toBeGreaterThanOrEqual(start);
    expect(manifest.entries.directedCycle).toBeLessThan(end);
  });
  it('requires the exact original firmware before generating any ARM experiment', async () => {
    const altered = raw.slice(); altered[10000] ^= 1;
    await expect(buildGr3xExperiment(altered)).rejects.toMatchObject({ code: 'unsupported-firmware' });
    await expect(buildGr3xExperiment(new Uint8Array())).rejects.toMatchObject({ code: 'unsupported-firmware' });
  });
});
