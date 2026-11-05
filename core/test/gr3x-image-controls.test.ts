// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, buildGrown, sectionsOf, sum32 } from '../src/fw/container';
import { GR3X_160 } from '../src/fw/gr3x/profile';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { readGr3xLookRecipe } from '../src/fw/gr3x/look-recipe';
import { buildGr3xImageControls } from '../src/fw/gr3x/image-control';
import { convertGr3xCube } from '../src/color/gr3x-import';
import { GR3X_CAMERA, GR3X_REFERENCE_CURVE } from '../src/color/gr3x-camera';
import { BASE_CURVE } from '../src/color/data';

const cube = 'TITLE "Warm Demo"\nLUT_1D_SIZE 17\n' + Array.from({ length: 17 }, (_, i) =>
  [.02+.98*i/16, .01+.97*i/16, .02+.92*i/16].join(' ')).join('\n') + '\n';
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }] as const;
const ratios = GFX_RATIOS.filter(r => !['3:2', '1:1'].includes(r)).map(ratio => ({ name: ratio, ratio }));

describe('IIIx CUBE fitting', () => {
  it('uses an independently extracted native reference curve and reproduces a separable LUT', () => {
    expect(GR3X_REFERENCE_CURVE).toEqual(BASE_CURVE);
    const fit = convertGr3xCube(cube);
    expect(fit.kind).toBe('cube');
    expect(fit.meanDE).toBeLessThan(.1);
    expect(fit.p95DE).toBeLessThan(.3);
    const rgb = Float64Array.of(.2,.4,.6,.8,.7,.3);
    const actual = GR3X_CAMERA.slotApply(fit.params, rgb);
    for (let i = 0; i < rgb.length; i++) {
      const expected = [.02+.98*rgb[i], .01+.97*rgb[i], .02+.92*rgb[i]][i%3];
      expect(actual[i]).toBeCloseTo(expected, 2);
    }
    expect(fit.warnings.some(w => w.includes('not measured'))).toBe(true);
  });
});

const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('IIIx T5 additive film/replica firmware', () => {
  let raw: Uint8Array, engine: Engine, built: Awaited<ReturnType<typeof buildGr3xTestFirmware>>;
  beforeAll(async () => {
    raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw);
    const fit = engine.convertPreset('cube', cube);
    built = await buildGr3xTestFirmware(raw, soft, { monoReplicas: true,
      films: [{ name: 'Warm Demo', preset: fit }, { name: 'Film 2' }] });
  }, 60000);
  it('preserves the exact existing T4 RAW/geometry code and all original Image Control slots', async () => {
    const base = await buildGr3xTestFirmware(raw, soft);
    expect(built.manifest.append.bytes.startsWith(base.manifest.append.bytes)).toBe(true);
    for (const site of base.manifest.sites) {
      if (/extended IIIx (language directory|text bound|icon directory|icon bound)/.test(site.reason)) continue;
      expect(built.manifest.sites.find(s => s.address === site.address)).toEqual(site);
    }
    expect(built.manifest.ratios).toEqual(base.manifest.ratios);
    expect(built.manifest.iconAddition.bytes.startsWith(base.manifest.iconAddition.bytes)).toBe(true);
    expect(built.report).toMatchObject({ revision: 'T5-L1', rawFullFrame: true, rawDefaultCrop: [6000,4000], hardwareTested: false });
    expect(built.report.imageControls.map(s => s.id)).toEqual([64,65,66,67,68,69,70,71]);
    expect(built.report.imageControls.slice(2).every(s => s.name.endsWith('Replica'))).toBe(true);
    expect(Object.values(built.report.checks).every(Boolean)).toBe(true);
  }, 60000);
  it('reconstructs the complete file from its recipe before recognising a backup', async () => {
    const other = await Engine.open(raw);
    const inspected = await other.inspect(built.bytes);
    expect(inspected).toMatchObject({ kind: 'modified', verified: true, monoUnlock: true, softFocus: [...soft].reverse() });
    expect(inspected.slots[0].names.en).toBe('Warm Demo');
    const d = new Firmware(built.bytes).decoded;
    const rt = sectionsOf(d).find(s => s.name === 'RTOS')!;
    expect(readGr3xLookRecipe(d.subarray(rt.offset + GR3X_160.rtosLength, rt.offset + rt.size))?.films?.[0].name).toBe('Warm Demo');
  }, 60000);
  it('rejects a code edit even when its container and payload checksums are repaired', async () => {
    const original = new Firmware(raw), d = new Firmware(built.bytes).decoded.slice();
    const rt = sectionsOf(d).find(s => s.name === 'RTOS')!;
    d[rt.offset + GR3X_160.rtosLength + 200] ^= 1;
    const view = new DataView(d.buffer), checksum = rt.offset + rt.size - 4;
    view.setUint32(checksum, 0, true); view.setUint32(checksum, (-sum32(d)) >>> 0, true);
    const old = sectionsOf(original.decoded), next = sectionsOf(d);
    const insertions = ['RTOS', 'ICONBIN'].map(name => {
      const a = old.find(s => s.name === name)!, b = next.find(s => s.name === name)!;
      return { at: a.offset+a.size, length: b.size-a.size };
    });
    const changed = buildGrown(original, d, insertions).out;
    expect(await engine.inspect(changed)).toMatchObject({ kind: 'unknown', verified: false });
  }, 60000);
  it('retains byte-exact inspection of the original T5 recipe after the logo fix', async () => {
    const old = await buildGr3xTestFirmware(raw, soft, { displayRevision: 1, monoReplicas: true,
      films: [{ name: 'Warm Demo', preset: engine.convertPreset('cube', cube) }, { name: 'Film 2' }] });
    expect(old.report.revision).toBe('T5');
    expect(old.manifest.sites.some(s => s.address === 0x532935dc)).toBe(false);
    expect(built.manifest.sites.some(s => s.address === 0x532935dc)).toBe(true);
    expect(await engine.inspect(old.bytes)).toMatchObject({ kind: 'modified', verified: true, monoUnlock: true });
    for (let i = 0; i < 8; i++)
      expect((built.manifest as any).addedLooks[i].parameters).toEqual((old.manifest as any).addedLooks[i].parameters);
  }, 60000);
  it('rejects ambiguous names, malformed LUT bytes and unported features before export', async () => {
    // names per camera language are allowed; a character outside that language's font is not
    await expect(engine.buildFirmware([{ slot: 'CY', names: { en: 'One', ja: '曝光' + '\u{1F600}' } }], ratios)).rejects.toMatchObject({ code: 'bad-name' });
    await expect(engine.buildFirmware([], ratios, soft, { extraSlots: [{} as never] })).rejects.toMatchObject({ code: 'gr3x-unsupported' });
    await expect(buildGr3xImageControls(raw, { films: [{ name: 'Broken', preset: { matrixQ13: [1], curves: [[],[],[]] } }] }))
      .rejects.toMatchObject({ code: 'bad-edit' });
    expect(() => engine.convertPreset('xmp', '<x/>')).toThrow('no rdf:RDF element');
    expect(engine.validateName('CY', 'en', 'Film\nA').ok).toBe(false);
  });
});
