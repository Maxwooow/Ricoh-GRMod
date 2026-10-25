// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { buildGr3xAdjResearch } from '../src/fw/gr3x/adj';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { gr3xFilmPrint, gr3xHalationNames } from '../src/fw/gr3x/image-control';
import { gr3xMonoTable } from '../src/fw/gr3x/datestamp';
import { HALATION_COLOUR_NAMES } from '../src/fw/aspect/halation';

const input = process.env.GRMOD_GR3_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));
const identity = { matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: Array.from({ length: 3 }, () => Array.from({ length: 256 }, (_, i) => Math.round(i * 16383 / 255))) as [number[], number[], number[]] };
const grey = { matrixQ13: [2449, 4809, 934, 2449, 4809, 934, 2449, 4809, 934], curves: identity.curves };

describe('GR III round 7 helpers', () => {
  it('names the rows as GR IV, in Chinese as the GR III fonts allow', () => {
    const names = gr3xHalationNames(true);
    expect(names[1]).toBe('Halation');
    expect(names[18]).toBe('光漫射');
    expect(names[19]).toBe('光漫射');
    expect(gr3xHalationNames(false)[19]).toBe('红光漫射');
    expect(HALATION_COLOUR_NAMES[19]).toBe('颜色');
  });
  it('fingerprints films and marks black-and-white looks', () => {
    const a = gr3xFilmPrint([1, 2, 3], [[1, 2], [3, 4], [5, 6]]);
    expect(a).not.toBe(0);
    expect(gr3xFilmPrint([1, 2, 3], [[1, 2], [3, 4], [5, 6]])).toBe(a);
    expect(gr3xFilmPrint([1, 2, 4], [[1, 2], [3, 4], [5, 6]])).not.toBe(a);
    expect(gr3xFilmPrint([1, 2, 3], [[1, 2], [3, 4], [5, 6]], [512, 0, 0])).not.toBe(a);
    const t = gr3xMonoTable([false, true]);
    expect([...t].map((v, i) => (v ? i : -1)).filter(i => i >= 0)).toEqual([13, 14, 15, 16, 33]);
  });
});

describe.skipIf(!input)('GR III round 7: as GR IV 0.8.2', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('builds films with Halation strength and colour, the guard and the date by look, and recognises them', async () => {
    const built = await engine.buildFirmware([{ slot: 'CY', preset: identity }, { slot: 'CG', preset: grey }], ratios, [], { filmCount: 3, dateStamp: true, adjSoftFocus: true });
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ verified: true, dateStamp: true, adjSoftFocus: true });
    expect(summary.slots.length).toBe(3);
    // As round 6 (the guard off): another file, also recognised.
    const r6 = await engine.buildFirmware([{ slot: 'CY', preset: identity }, { slot: 'CG', preset: grey }], ratios, [], { filmCount: 3, dateStamp: true, adjSoftFocus: true, guard: false });
    expect(r6.sha256).not.toBe(built.sha256);
    expect(await (await Engine.open(raw)).inspect(r6.file)).toMatchObject({ verified: true });
  }, 600000);
  it('puts the guard and the look word in the adj layer without films', async () => {
    const m = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true, dateMenu: 'submenu', round7: true });
    expect(m.round7).toBe(true);
    expect(m.dateImprint).toMatchObject({ iconOff: 296, iconOn: 297, form: 'submenu' });
    expect(m.entries).toHaveProperty('guardFixAll');
    expect(m.entries).toHaveProperty('lookStash');
    const reasons = m.sites.map(s => s.reason);
    expect(reasons.filter(r => r.startsWith('settings guard')).length).toBe(3);
    const r6 = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true, dateMenu: 'submenu' });
    expect(r6.dateImprint).not.toHaveProperty('iconOff');
    expect(r6.entries).not.toHaveProperty('guardFixAll');
    // The engine: a build without films (date imprint only) has the guard and is recognised.
    const built = await engine.buildFirmware([], ratios, [], { filmCount: 0, dateStamp: true, gr3Round: 7 });
    expect(await (await Engine.open(raw)).inspect(built.file)).toMatchObject({ verified: true, dateStamp: true });
    const t = await buildGr3xTestFirmware(raw, [], undefined, undefined, { dateImprint: true, dateMenu: 'submenu', round7: true });
    expect(t.report.outputSha256).toBe(built.sha256);
  }, 600000);
  it('installs the two rows, slots3 and 0.8.2 halation for twenty films', async () => {
    const t = await buildGr3xTestFirmware(raw, [], { displayRevision: 3, ownParameters: true, filmCount: 20, films: [{ name: 'Film 1', preset: identity }] }, undefined,
      { adjSoftFocus: true, round7: true });
    const m = t.manifest as Record<string, any>;
    expect(m.round7).toBe(true);
    expect(m.lookEntries).toHaveProperty('halationRows');
    expect(m.lookEntries).not.toHaveProperty('halationScreen');
    expect(Object.keys(m.lookEntries.ownParameters.exports)).toContain('sp_col_put');
    expect(m.lookEntries.ownParameters).toHaveProperty('guardRecall');
    expect(m.lookEntries.jpeg).toHaveProperty('halationLooks');
    expect(m.monoFilms).toEqual(Array.from({ length: 20 }, () => false));
    await expect(buildGr3xTestFirmware(raw, [], { displayRevision: 3, ownParameters: true, films: [{ name: 'Film 1' }] }, undefined, { round7: true })).rejects.toThrow();
  }, 600000);
});
