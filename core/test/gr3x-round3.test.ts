// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_FILM_IDS } from '../src/fw/gr3x/look-resources';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';

const input = process.env.GRMOD_GR3_FIRMWARE ?? process.env.GRMOD_GR3X_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));
const identityCurve = Array.from({ length: 256 }, (_, i) => Math.round(i * 16383 / 255));

describe.skipIf(!input)('GR III round 3: ADJ soft focus, second matrix, halation', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('offers soft focus on the ADJ lever and records it for inspection', async () => {
    expect(engine.info.features.softFocus).toBe('adj');
    const built = await engine.buildFirmware([], ratios, [], { adjSoftFocus: true });
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ kind: 'modified', verified: true, adjSoftFocus: true });
    const plain = await buildGr3xTestFirmware(raw);
    expect(built.sha256).not.toBe(plain.report.outputSha256);
    await expect(engine.buildFirmware([], ratios, [{ level: -1, strength: 'weak' }], { adjSoftFocus: true }))
      .rejects.toMatchObject({ code: 'bad-clarity' });
  }, 120000);
  it('builds films with a second matrix and halation and recognises them again', async () => {
    const preset = { matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [identityCurve, identityCurve, identityCurve] as [number[], number[], number[]],
      postQ9: [560, -60, 12, -20, 548, -16, 8, -40, 544] };
    const built = await engine.buildFirmware([
      { slot: GR3X_FILM_IDS[0], preset, halation: 2 },
      { slot: GR3X_FILM_IDS[1], preset },
      { slot: GR3X_FILM_IDS[2], halation: 1 },
    ], ratios, [], { adjSoftFocus: true });
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ kind: 'modified', verified: true, adjSoftFocus: true });
    const again = await engine.buildFirmware([{ slot: GR3X_FILM_IDS[0], preset, halation: 1 }], ratios, [], { adjSoftFocus: true });
    expect(again.sha256).not.toBe(built.sha256);
    await expect(engine.buildFirmware([{ slot: GR3X_FILM_IDS[0], preset: { ...preset, postQ9: [512, 0, 0, 0, 512, 0, 0, 0, 511] } }], ratios))
      .rejects.toMatchObject({ code: 'bad-edit' });
  }, 240000);
});
