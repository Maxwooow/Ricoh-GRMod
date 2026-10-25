// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { gr3xFactoryLookOrder, gr3xLookLists, isGr3xFactoryLayout, validateGr3xLookLayout } from '../src/fw/gr3x/look-layout';
import { encodeGr3xRatioRecipe, readGr3xBuildRecipe } from '../src/fw/gr3x/ratio-recipe';
import { GR3X_FACTORY_LOOK_NAMES } from '../src/fw/gr3x/datestamp';
import { openGr3xOfficial } from '../src/fw/gr3x/profile';
import { Firmware, sectionsOf } from '../src/fw/container';
import { GR3X_CAMERA } from '../src/color/gr3x-camera';
import { monoLook } from '../src/fw/aspect/lookstash';
import { GR3X_SLOTS_NATIVE } from '../src/fw/gr3x/slots-native';
import { GR3X_SLOTS2_NATIVE } from '../src/fw/gr3x/slots2-native';
import { GR3X_SLOTS3_NATIVE } from '../src/fw/gr3x/slots3-native';
import { GR3X_SLOTS4_NATIVE } from '../src/fw/gr3x/slots4-native';
import { GR3X_ENDSCREEN_NATIVE } from '../src/fw/gr3x/endscreen-native';
import { GR3X_MAP_NATIVE } from '../src/fw/gr3x/map-native';

const input = process.env.GRMOD_GR3_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));

describe('GR III round 8 helpers', () => {
  it('lists the looks of the still, movie and RAW development lists', () => {
    expect(gr3xFactoryLookOrder(2)).toEqual([11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21, 64, 65]);
    const order = [64, 11, 12, 17, 22, 13, 14, 15, 16, 19, 65, 18, 20, 21];
    const L = gr3xLookLists({ order, hidden: [18, 20, 65] }, 2);
    expect(L.still).toEqual([64, 11, 12, 17, 22, 13, 14, 15, 16, 19, 21]);
    expect(L.movie).toEqual([11, 12, 17, 22, 13, 15, 16, 19, 21]);
    expect(L.raw).toEqual([11, 12, 17, 22, 13, 14, 15, 16, 19, 21]);
    expect(isGr3xFactoryLayout({ order: gr3xFactoryLookOrder(3), hidden: [] }, 3)).toBe(true);
    expect(isGr3xFactoryLayout({ order: gr3xFactoryLookOrder(3), hidden: [64] }, 3)).toBe(false);
  });
  it('refuses layouts the build cannot show', () => {
    const f = gr3xFactoryLookOrder(1);
    expect(() => validateGr3xLookLayout({ order: f, hidden: [11] }, 1)).toThrow(/Standard/);
    expect(() => validateGr3xLookLayout({ order: f.slice(1), hidden: [] }, 1)).toThrow();
    expect(() => validateGr3xLookLayout({ order: [...f, 65], hidden: [] }, 1)).toThrow();
    expect(() => validateGr3xLookLayout({ order: f, hidden: [65] }, 1)).toThrow();
    expect(() => validateGr3xLookLayout({ order: [...f.slice(0, -1), 11], hidden: [] }, 1)).toThrow();
    expect(() => validateGr3xLookLayout({ order: f, hidden: [12, 12] }, 1)).toThrow();
  });
  it('records round 8 and the layout in the recipe', () => {
    const layout = { order: gr3xFactoryLookOrder(0).reverse(), hidden: [12] };
    const rec = encodeGr3xRatioRecipe([], { round7: true, round8: true, lookLayout: layout });
    const back = readGr3xBuildRecipe(rec)!;
    expect(back.round7).toBe(true);
    expect(back.round8).toBe(true);
    expect(back.lookLayout).toEqual(layout);
    expect(back.round9).toBe(false);
    const r9 = readGr3xBuildRecipe(encodeGr3xRatioRecipe([], { round7: true, round8: true, round9: true, lookLayout: layout }))!;
    expect(r9).toMatchObject({ round7: true, round8: true, round9: true, lookLayout: layout });
    const r7 = readGr3xBuildRecipe(encodeGr3xRatioRecipe([], { round7: true }))!;
    expect(r7.round8).toBe(false);
    expect(r7.lookLayout).toBeUndefined();
  });
  it('names the camera\'s looks in English', () => {
    expect(Object.keys(GR3X_FACTORY_LOOK_NAMES).map(Number)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(GR3X_FACTORY_LOOK_NAMES[22]).toBe('Negative Film');
  });
});

/** The camera's code addresses a module loads with movw / movt (its calls into the firmware: the modules have no relocations). */
function firmwareAddresses(hex: string): number[] {
  const b = Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16))), v = new DataView(b.buffer), low: Record<number, number> = {}, out = new Set<number>();
  for (let i = 0; i < b.length; i += 4) {
    const w = v.getUint32(i, true), rd = (w >>> 12) & 15, imm = ((w >>> 4) & 0xf000) | (w & 0xfff);
    if ((w & 0x0ff00000) === 0x03000000) low[rd] = imm;
    else if ((w & 0x0ff00000) === 0x03400000) { const a = ((imm << 16) | (low[rd] ?? 0)) >>> 0; if (a >= 0x53000000 && a < 0x53b00000) out.add(a); }
  }
  return [...out].sort((x, y) => x - y);
}

describe.skipIf(!input)('GR III native modules (as GR Mod 0.8.4\'s strict check): every call lands on its function', () => {
  it('calls exactly the camera functions reviewed, each at its first instruction', async () => {
    const { decoded } = await openGr3xOfficial(new Uint8Array(readFileSync(input!)));
    const s = sectionsOf(decoded).find(x => x.name === 'RTOS')!, rtos = decoded.subarray(s.offset, s.offset + s.size), rv = new DataView(rtos.buffer, rtos.byteOffset);
    const word = (a: number) => rv.getUint32(a - 0x53000000, true);
    // alloc, settings load / save helpers (the slot modules); list and widget functions (End Screen).
    const slots = { 0x536af2a8: 0xe1a0c00d, 0x53828014: 0xe1a0c00d, 0x53829a08: 0xe1a0c00d };
    const expected: [string, string, Record<number, number>][] = [
      ['map', GR3X_MAP_NATIVE.code, {}],
      ['slots', GR3X_SLOTS_NATIVE.code, { ...slots, 0x53829e50: 0xe1a0c00d }],
      ['slots2', GR3X_SLOTS2_NATIVE.code, { ...slots, 0x53829fcc: 0xe1a0c00d }],
      ['slots3', GR3X_SLOTS3_NATIVE.code, { ...slots, 0x53829fcc: 0xe1a0c00d }],
      ['slots4', GR3X_SLOTS4_NATIVE.code, { ...slots, 0x53829fcc: 0xe1a0c00d }],
      ['endscreen', GR3X_ENDSCREEN_NATIVE.code, { 0x53394758: 0xe59030f4, 0x53394820: 0xe2800e11, 0x53395430: 0xe1a0c00d, 0x5339a9a0: 0xe1d02eba,
        0x5339e738: 0xe59000ec, 0x533a6ad0: 0xe1a0c00d, 0x533ad3c0: 0xe5d0209e, 0x53525d5c: 0xe1a0c00d }],
    ];
    for (const [name, code, want] of expected) {
      const got = firmwareAddresses(code);
      expect(got, name).toEqual(Object.keys(want).map(Number));
      for (const a of got) {
        expect(word(a) >>> 0, `${name} ${a.toString(16)}`).toBe(want[a]);
        // The word before is the end of another function (a return, a branch, a call that does not return) or a literal.
        const before = word(a - 4) >>> 0, cond = before >>> 28;
        const ends = before === 0xe12fff1e || [0xe89d8000, 0xe8bd8000].includes((before & 0xffff8000) >>> 0) || (before & 0x0e000000) === 0x0a000000 || (before & 0x0f000000) === 0x0b000000 || cond === 0xf || before >>> 24 === 0x53;
        expect(ends, `${name} ${a.toString(16)} follows ${before.toString(16)}`).toBe(true);
      }
    }
  });
});

describe.skipIf(!input)('GR III round 8: as GR IV 0.8.4', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('builds round 9 by default, rounds 8 and 7 on request, and recognises each', async () => {
    const r9 = await engine.buildFirmware([], ratios, [], { filmCount: 2, dateStamp: true, adjSoftFocus: true });
    const r8 = await engine.buildFirmware([], ratios, [], { filmCount: 2, dateStamp: true, adjSoftFocus: true, gr3Round: 8 });
    const r7 = await engine.buildFirmware([], ratios, [], { filmCount: 2, dateStamp: true, adjSoftFocus: true, gr3Round: 7 });
    expect(new Set([r9.sha256, r8.sha256, r7.sha256]).size).toBe(3);
    // Round 9: the live view's look comparison reads the look itself (the camera's own instruction
    // at 0x536dc998); round 8 maps it to the film's native base there.
    const word = (file: Uint8Array) => { const d = new Firmware(file).decoded, s = sectionsOf(d).find(x => x.name === 'RTOS')!; return new DataView(d.buffer, d.byteOffset + s.offset).getUint32(0x536dc998 - 0x53000000, true); };
    expect(word(r9.file)).toBe(0xe5d5c77c);
    expect(word(r8.file)).not.toBe(0xe5d5c77c);
    for (const b of [r9, r8, r7]) expect(await (await Engine.open(raw)).inspect(b.file)).toMatchObject({ verified: true, dateStamp: true });
    const t8 = await buildGr3xTestFirmware(raw, [], { displayRevision: 3, ownParameters: true, filmCount: 2, films: [{ name: 'Film 1' }, { name: 'Film 2' }] }, undefined,
      { adjSoftFocus: true, dateImprint: true, dateMenu: 'submenu', round7: true, round8: true });
    expect(t8.manifest).toMatchObject({ round8: true });
    expect((t8.manifest as Record<string, any>).dateImprint).toMatchObject({ orient: expect.any(Number), shortName: expect.any(Number), iconLongName: expect.any(Number) });
  }, 900000);
  it('gives a black-and-white preset equal matrix rows, recognised as black and white (round 9)', async () => {
    const n = 9, lines = ['LUT_3D_SIZE 9'];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const S = GR3X_CAMERA.S, Si = GR3X_CAMERA.Sinv, t = S(0.3 * Si(r / 8) + 0.6 * Si(g / 8) + 0.1 * Si(b / 8)).toFixed(6);
      lines.push(`${t} ${t} ${t}`);
    }
    const p = engine.convertPreset('cube', lines.join('\n'));
    expect(p.postQ9).toBeUndefined();
    for (let r = 1; r < 3; r++) expect(Array.from(p.matrixQ13.slice(r * 3, r * 3 + 3))).toEqual(Array.from(p.matrixQ13.slice(0, 3)));
    expect(p.matrixQ13[0] + p.matrixQ13[1] + p.matrixQ13[2]).toBe(8192);
    expect(monoLook(Array.from(p.matrixQ13), p.curves.map(c => Array.from(c)))).toBe(true);
  });
  it('builds and reads back the Image Control order, with and without films', async () => {
    const order = [65, 64, 11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21];
    const built = await engine.buildFirmware([], ratios, [], { filmCount: 2, dateStamp: true, lookLayout: { order, hidden: [18, 64] } });
    const sum = await (await Engine.open(raw)).inspect(built.file);
    expect(sum).toMatchObject({ verified: true, lookLayout: { order, hidden: [18, 64] } });
    // Without films: the camera's twelve.
    const plain = await engine.buildFirmware([], ratios, [], { dateStamp: true, lookLayout: { order: [11, 22, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], hidden: [20] } });
    expect(await (await Engine.open(raw)).inspect(plain.file)).toMatchObject({ verified: true, lookLayout: { hidden: [20] } });
    // The camera's order with nothing hidden is the same file as none.
    const same = await engine.buildFirmware([], ratios, [], { filmCount: 2, dateStamp: true, lookLayout: { order: gr3xFactoryLookOrder(2), hidden: [] } });
    const none = await engine.buildFirmware([], ratios, [], { filmCount: 2, dateStamp: true });
    expect(same.sha256).toBe(none.sha256);
    await expect(engine.buildFirmware([], ratios, [], { filmCount: 2, lookLayout: { order, hidden: [11] } })).rejects.toThrow();
    await expect(engine.buildFirmware([], ratios, [], { filmCount: 2, gr3Round: 7, lookLayout: { order, hidden: [] } })).rejects.toThrow();
  }, 900000);
});
