// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_FILM_IDS } from '../src/fw/gr3x/look-resources';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { buildGr3xAdjResearch } from '../src/fw/gr3x/adj';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { GR3X_JPEG_EXECUTE } from '../src/fw/gr3x/jpeg-stage';

const input = process.env.GRMOD_GR3_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));

describe.skipIf(!input)('GR III round 4: date imprint', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('is offered on the experimental GR III build and recorded for inspection', async () => {
    expect(engine.info.features.dateStamp).toBe(true);
    const built = await engine.buildFirmware([], ratios, [], { dateStamp: true });
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ kind: 'modified', verified: true, dateStamp: true, adjSoftFocus: false });
    const plain = await buildGr3xTestFirmware(raw);
    expect(built.sha256).not.toBe(plain.report.outputSha256);
    // Rejected with the diagnostic date module (both would sit at the JPEG entry).
    await expect(buildGr3xTestFirmware(raw, [], { displayRevision: 3, monoReplicas: false, films: [{ name: 'A', halation: 2 }], jpegDiagnostics: true },
      undefined, { dateImprint: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 240000);
  it('chains halation in front of the date at the JPEG entry', async () => {
    const preset = { matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: Array.from({ length: 3 }, () => Array.from({ length: 256 }, (_, i) => Math.round(i * 16383 / 255))) as [number[], number[], number[]] };
    const built = await engine.buildFirmware([{ slot: GR3X_FILM_IDS[8], preset, halation: 2 }], ratios, [], { adjSoftFocus: true, dateStamp: true });
    expect(await (await Engine.open(raw)).inspect(built.file)).toMatchObject({ verified: true, dateStamp: true, adjSoftFocus: true });
    const adj = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true });
    const site = adj.sites.find(s => s.address === GR3X_JPEG_EXECUTE)!;
    expect(site.reason).toMatch(/^date imprint/);
    expect(adj.dateImprint).toMatchObject({ name: 786 + 7, short: 787 + 7, long: 788 + 7 });
  }, 240000);
});
