// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_FILM_IDS } from '../src/fw/gr3x/look-resources';
import { gr3xFilmIcon, T6_FILM_NAMES } from '../src/fw/gr3x/film-icons';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { buildGr3xImageControls } from '../src/fw/gr3x/image-control';
import { encodeGr3xLookRecipe, readGr3xLookRecipe } from '../src/fw/gr3x/look-recipe';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';

const input = process.env.GRMOD_GR3X_FIRMWARE;
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }] as const;
describe.skipIf(!input)('T6 nine independent colour films', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('fits the native list, keeps T4 capture patches exact and reconstructs all nine film identities', async () => {
    const films = T6_FILM_NAMES.map((name, i) => ({ name, icon: gr3xFilmIcon(engine.info.tiles.film, i) }));
    const t6 = await buildGr3xTestFirmware(raw, soft, { displayRevision: 3, monoReplicas: false, films });
    const t4 = await buildGr3xTestFirmware(raw, soft);
    expect(t6.report).toMatchObject({ revision: 'T6', rawDefaultCrop: [6000, 4000], rawFullFrame: true });
    expect(t6.report.imageControls.map(s => s.id)).toEqual([64,65,66,67,68,69,70,71,72]);
    expect(t6.report.imageControls.map(s => s.name)).toEqual([...T6_FILM_NAMES]);
    expect(t6.report.imageControls.every(s => s.source === 'cube' && s.nativeBase === 11)).toBe(true);
    expect(t6.manifest.append.bytes.startsWith(t4.manifest.append.bytes)).toBe(true);
    for (const site of t4.manifest.sites) {
      if (/extended IIIx (language directory|text bound|icon directory|icon bound)/.test(site.reason)) continue;
      expect(t6.manifest.sites.find(s => s.address === site.address)).toEqual(site);
    }
    const inspected = await (await Engine.open(raw)).inspect(t6.bytes);
    expect(inspected).toMatchObject({ kind: 'modified', verified: true, monoUnlock: false });
    expect(inspected.slots.map(s => s.names.en)).toEqual([...T6_FILM_NAMES]);
    expect(inspected.slots.map(s => s.id)).toEqual(GR3X_FILM_IDS.slice(0, 9));
    // The app builds T6d: the same films, each keeping its own parameters.
    const t6d = await buildGr3xTestFirmware(raw, soft, { displayRevision: 3, monoReplicas: false, films, ownParameters: true });
    expect(t6d.manifest).toMatchObject({ ownParameters: true, sharedParameters: true });
    expect(t6d.manifest.sites.filter(s => /own film parameters|zero fill/.test(s.reason))).toHaveLength(6);
    const api = await engine.buildFirmware(films.map((f, i) => ({ slot: GR3X_FILM_IDS[i], names: { en: f.name }, icon: f.icon })),
      GFX_RATIOS.filter(r => !['3:2','1:1'].includes(r)).map(ratio => ({ name: ratio, ratio })), soft);
    expect(api.sha256).toBe(t6d.report.outputSha256);
    expect(await (await Engine.open(raw)).inspect(t6d.bytes)).toMatchObject({ kind: 'modified', verified: true });
  }, 60000);
  it('round-trips worst-case nine-colour recipes and rejects mixing nine slots with replicas', async () => {
    const icon = new Uint8Array(6400).fill(255);
    const films = T6_FILM_NAMES.map(name => ({ name, icon }));
    const encoded = encodeGr3xLookRecipe({ displayRevision: 3, films });
    expect(readGr3xLookRecipe(encoded)?.films).toHaveLength(9);
    await expect(buildGr3xImageControls(raw, { displayRevision: 3, films, monoReplicas: true })).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(buildGr3xImageControls(raw, { displayRevision: 2, films })).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(buildGr3xImageControls(raw, { displayRevision: 3, films: [...films, { name: 'Tenth' }] })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});
