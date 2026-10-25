// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_T4_CUSTOM, GR3X_T4_MENU, planGr3xMenu, planGr3xRatio } from '../src/fw/gr3x/geometry';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { encodeGr3xRatioRecipe, readGr3xRatioRecipe } from '../src/fw/gr3x/ratio-recipe';

describe('GR III / IIIx ratio menu rules', () => {
  it('keeps the tested T4 menu for the T4 seven', () => {
    expect(planGr3xMenu(GR3X_T4_CUSTOM)).toEqual(GR3X_T4_MENU);
    expect(GR3X_T4_MENU.map(r => r.id)).toEqual([4, 0, 5, 6, 7, 8, 3, 9, 10]);
  });
  it('puts 3:2 and 1:1 first, then the added ratios in order with identities 4..', () => {
    const menu = planGr3xMenu([{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:5' }]);
    expect(menu.map(r => [r.ratio, r.name, r.id, r.n, r.d])).toEqual([
      ['3:2', '3:2', 0, 3, 2], ['1:1', '1:1', 3, 1, 1], ['2.39:1', 'Scope', 4, 239, 100], ['4:5', '4:5', 5, 4, 5]]);
    // The T4 seven in another order are a custom list.
    expect(planGr3xMenu([...GR3X_T4_CUSTOM].reverse())[0].ratio).toBe('3:2');
  });
  it('refuses what the tested envelope does not cover', () => {
    const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code: string }).code; } return 'ok'; };
    expect(code(() => planGr3xMenu([]))).toBe('too-many-ratios');
    expect(code(() => planGr3xMenu(Array.from({ length: 8 }, (_, i) => ({ ratio: `${10 + i}:9` }))))).toBe('too-many-ratios');
    expect(code(() => planGr3xRatio('3:2'))).toBe('ratio-factory');
    expect(code(() => planGr3xRatio('1:1'))).toBe('ratio-factory');
    expect(code(() => planGr3xRatio('3.001:2'))).toBe('ratio-factory'); // the same photo sizes as 3:2
    expect(code(() => planGr3xRatio('3.1:1'))).toBe('ratio-too-extreme');
    expect(code(() => planGr3xRatio('1:2.1'))).toBe('ratio-too-extreme');
    expect(code(() => planGr3xRatio('3:1'))).toBe('ok');
    expect(code(() => planGr3xRatio('1:2'))).toBe('ok');
    expect(code(() => planGr3xMenu([{ ratio: '16:9' }, { ratio: '16:9' }]))).toBe('ratio-conflict');
    expect(code(() => planGr3xMenu([{ ratio: '16:9' }, { ratio: '16.01:9' }]))).toBe('ratio-conflict');
    expect(code(() => planGr3xMenu([{ ratio: '16:9', name: 'Much too long a name' }]))).toBe('bad-name');
    expect(code(() => planGr3xMenu([{ ratio: '16:9', name: '宽银幕' }]))).toBe('bad-name');
  });
  it('round-trips the ratio recipe', () => {
    const menu = planGr3xMenu([{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:5' }]);
    const recipe = encodeGr3xRatioRecipe(menu);
    const padded = new Uint8Array(recipe.length + 40); padded.set(recipe, 17);
    expect(readGr3xRatioRecipe(padded)).toEqual([{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:5', name: '4:5' }]);
    expect(readGr3xRatioRecipe(new Uint8Array(64))).toBeNull();
  });
});

const input = process.env.GRMOD_GR3_FIRMWARE ?? process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('GR III / IIIx custom ratio builds', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('builds the T4 seven exactly as the tested T4 and recognises it', async () => {
    const t4 = await buildGr3xTestFirmware(raw);
    // Without the settings guard (round 7 on the experimental GR III build, as GR IV 0.8.2): T4 itself.
    const api = await engine.buildFirmware([], GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! })), [], { guard: false });
    expect(api.sha256).toBe(t4.report.outputSha256);
    if (engine.info.features.maxFilms === 20) {
      const guarded = await engine.buildFirmware([], GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! })));
      expect(guarded.sha256).not.toBe(t4.report.outputSha256);
      expect(await (await Engine.open(raw)).inspect(guarded.file)).toMatchObject({ kind: 'modified', verified: true });
    }
  }, 120000);
  it('builds, records and recognises another list', async () => {
    const ratios = [{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:5', name: 'Portrait' }, { ratio: '65:24', name: 'XPan' }];
    const built = await engine.buildFirmware([], ratios);
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ kind: 'modified', verified: true });
    expect(summary.ratios.map(r => [r.id, r.name, r.ratio])).toEqual([[4, 'Scope', '2.39:1'], [5, 'Portrait', '4:5'], [6, 'XPan', '65:24']]);
    // Same list, other names: another file. A tampered list is not "verified".
    const renamed = await engine.buildFirmware([], ratios.map(r => ({ ...r, name: r.name + '2' })));
    expect(renamed.sha256).not.toBe(built.sha256);
    const altered = built.file.slice(); altered[altered.length - 100] ^= 1;
    expect((await (await Engine.open(raw)).inspect(altered)).verified).toBe(false);
    await expect(engine.buildFirmware([], [])).rejects.toMatchObject({ code: 'too-many-ratios' });
  }, 240000);
});
