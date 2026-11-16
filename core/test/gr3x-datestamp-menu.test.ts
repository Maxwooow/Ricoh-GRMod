// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { buildGr3xAdjResearch } from '../src/fw/gr3x/adj';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { GR3X_DATE_MENU_ID, GR3X_DATE_STYLE_ID, GR3X_DATE_SWITCH_ID } from '../src/fw/gr3x/datestamp';

const input = process.env.GRMOD_GR3_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));

describe.skipIf(!input)('GR III round 6: date imprint menu as GR IV', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('builds the submenu form with its five texts and recognises both forms', async () => {
    const sub = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true, dateMenu: 'submenu' });
    expect(sub.dateImprint).toMatchObject({ name: 793, short: 794, long: 795, onOff: 796, style: 797, form: 'submenu' });
    expect(sub.entries).toHaveProperty('submenuTable');
    const reasons = sub.sites.map(s => s.reason);
    expect(reasons.filter(r => r.startsWith('added menus: submenu records')).length).toBe(10);
    const list = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true });
    expect(list.dateImprint).toMatchObject({ form: 'list' });
    expect(list.entries).not.toHaveProperty('submenuTable');
    expect([GR3X_DATE_MENU_ID, GR3X_DATE_SWITCH_ID, GR3X_DATE_STYLE_ID]).toEqual([0x020001a0, 0x020001a1, 0x020001a2]);
    // The app builds the submenu form; a round-4 file (list) is still recognised.
    const built = await engine.buildFirmware([], ratios, [], { dateStamp: true });
    expect(await (await Engine.open(raw)).inspect(built.file)).toMatchObject({ verified: true, dateStamp: true });
    const old = await buildGr3xTestFirmware(raw, [], undefined, undefined, { dateImprint: true });
    expect(await (await Engine.open(raw)).inspect(old.bytes)).toMatchObject({ verified: true, dateStamp: true });
    expect(old.report.outputSha256).not.toBe(built.sha256);
  }, 300000);
  it('builds 1..20 films with Halation in the camera and recognises them', async () => {
    expect(engine.info.features.maxFilms).toBe(20);
    expect(engine.info.slots.length).toBe(20);
    const preset = { matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: Array.from({ length: 3 }, () => Array.from({ length: 256 }, (_, i) => Math.round(i * 16383 / 255))) as [number[], number[], number[]] };
    for (const n of [1, 20]) {
      const built = await engine.buildFirmware([{ slot: n === 20 ? 'F20' : 'CY', preset, halation: 2 }], ratios, [], { filmCount: n, adjSoftFocus: true });
      const summary = await (await Engine.open(raw)).inspect(built.file);
      expect(summary).toMatchObject({ verified: true, adjSoftFocus: true });
      expect(summary.slots.length).toBe(n);
    }
    // No films: as a build without film changes.
    const none = await engine.buildFirmware([], ratios, [], { filmCount: 0, dateStamp: true });
    expect((await (await Engine.open(raw)).inspect(none.file)).slots.length).toBe(0);
    await expect(engine.buildFirmware([{ slot: 'F12', preset }], ratios, [], { filmCount: 11 })).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(engine.buildFirmware([], ratios, [], { filmCount: 21 })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 600000);
  it('builds the End Screen submenu with stable picture ids, up to eight pictures and twenty films', async () => {
    const rgb = new Uint8Array(720 * 480 * 3).map((_, i) => (i * 7) & 255);
    const jpeg = engine.encodeMenuPicture(rgb);
    const pictures = Array.from({ length: 8 }, (_, k) => ({ id: 0x9000000 + k * 977, name: `Pic ${k + 1}`, jpeg }));
    const built = await engine.buildFirmware([], ratios, [], { filmCount: 20, dateStamp: true, adjSoftFocus: true, shutdownPictures: pictures });
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ verified: true, dateStamp: true });
    expect(summary.shutdownPictures?.map(p => [p.id, p.name])).toEqual(pictures.map(p => [p.id, p.name]));
    await expect(engine.buildFirmware([], ratios, [], { shutdownPictures: [pictures[0], { ...pictures[1], id: pictures[0].id }] })).rejects.toThrow();
  }, 900000);
});
