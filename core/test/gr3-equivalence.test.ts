// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 support rests on one claim: GR III 2.10 and GR IIIx 1.60 are the same
 * build of one program, so the IIIx patches mean exactly the same on GR III. These tests check it on
 * the two official files and on every recipe the app can produce:
 *
 *  - the two official images differ only at a short, fixed list of identity bytes, none of which any
 *    IIIx patch, guard or copied resource touches;
 *  - every GR III build equals the IIIx build of the same recipe with only those identity bytes (and the
 *    build's own marker and checksum word) swapped: the same code, data, tables and icons, byte for byte;
 *  - the GR III container keeps GR III's own header (project 588, product 78350, version 2.10) and file
 *    name, so the camera's updater (equal version accepted) sees its own firmware;
 *  - a file is only ever recognised by the engine of its own camera.
 *
 * Needs both official files: GRMOD_GR3X_FIRMWARE (fwdc243b.bin 1.60) and GRMOD_GR3_FIRMWARE (fwdc239b.bin 2.10).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sectionsOf, sum32 } from '../src/fw/container';
import { GR3_210, GR3X_160, gr3ProfileOf, openGr3xOfficial } from '../src/fw/gr3x/profile';
import { readGr3xFactoryEntry } from '../src/fw/gr3x/factory';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { encodeGr3xPicture } from '../src/fw/gr3x/shutdown';
import { gr3xFilmIcon, T6_FILM_NAMES } from '../src/fw/gr3x/film-icons';
import { GR3X_FILM_IDS } from '../src/fw/gr3x/look-resources';
import { GFX_RATIOS, planGr3xMenu } from '../src/fw/gr3x/geometry';
import type { Gr3xMenuRatio } from '../src/fw/gr3x/geometry';
import type { Gr3xLookOptions } from '../src/fw/gr3x/image-control';
import type { Gr3xSoftFocusRequest as SoftFocusRequest } from '../src/fw/gr3x/clarity';

const xPath = process.env.GRMOD_GR3X_FIRMWARE, iiiPath = process.env.GRMOD_GR3_FIRMWARE;
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }] as const;

/** Offsets (in the decoded image) where the two official images differ. */
function differences(a: Uint8Array, b: Uint8Array): number[] {
  expect(a.length).toBe(b.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe.skipIf(!xPath || !iiiPath)('GR III 2.10 is the IIIx 1.60 program', () => {
  let rawX: Uint8Array, raw3: Uint8Array, decX: Uint8Array, dec3: Uint8Array, diff: number[];
  beforeAll(async () => {
    rawX = new Uint8Array(readFileSync(xPath!)); raw3 = new Uint8Array(readFileSync(iiiPath!));
    decX = (await openGr3xOfficial(rawX)).decoded; dec3 = (await openGr3xOfficial(raw3)).decoded;
    diff = differences(decX, dec3);
  });

  it('recognises each official file by its exact hash and nothing else', async () => {
    expect(await gr3ProfileOf(rawX)).toBe(GR3X_160);
    expect(await gr3ProfileOf(raw3)).toBe(GR3_210);
    const bent = raw3.slice(); bent[1000] ^= 1;
    expect(await gr3ProfileOf(bent)).toBeNull();
    await expect(openGr3xOfficial(bent)).rejects.toThrow();
    // Layout the shared addresses rely on
    for (const k of ['rtosOffset', 'rtosLength', 'rtosBase', 'ramSource', 'ramBase', 'ramLength', 'decodedSize'] as const) expect(GR3_210[k]).toBe(GR3X_160[k]);
    const sx = sectionsOf(decX), s3 = sectionsOf(dec3);
    expect(s3.map(s => [s.name, s.offset, s.size])).toEqual(sx.map(s => [s.name, s.offset, s.size]));
  });

  it('the two images differ only in identity bytes: RTOS header/getters/epoch, CPU, SRIC and the RES checksum', () => {
    const sec = sectionsOf(decX);
    const where = (o: number) => sec.find(s => o >= s.offset && o < s.offset + s.size)?.name ?? 'header';
    const bySection: Record<string, number> = {};
    for (const o of diff) bySection[where(o)] = (bySection[where(o)] ?? 0) + 1;
    expect(Object.keys(bySection).sort()).toEqual(['CPU', 'RTOS', 'SRIC', 'header']);
    // 'header' here: the 4 checksum bytes of the RES payload, which runs past RES's directory record
    const res = sec.find(s => s.name === 'RES')!;
    expect(diff.filter(o => where(o) === 'header').every(o => o > res.offset)).toBe(true);
    expect(bySection.header).toBeLessThanOrEqual(4);
    const rtos = sec.find(s => s.name === 'RTOS')!;
    const rtosVa = diff.filter(o => where(o) === 'RTOS').map(o => GR3X_160.rtosBase + o - rtos.offset);
    // RTOS header (name, project, product, version, build time), the epoch-year function, the
    // identity getters and the copyright year of one decoder string. Nothing else.
    const allowed = (va: number) => (va >= 0x53002000 && va < 0x53002090) || (va >= 0x536b62ec && va < 0x536b6578) ||
      (va >= 0x5381fe4c && va < 0x5381fea0) || (va >= 0x53d62314 && va < 0x53d62320);
    expect(rtosVa.filter(va => !allowed(va)).map(v => v.toString(16))).toEqual([]);
    expect(rtosVa.length).toBeLessThan(40);
  });

  // Every recipe the app can make: T4, T4 + soft focus, two CUBE slots + replicas, nine CUBE slots.
  const recipes = (engine: Engine) => {
    const films9 = T6_FILM_NAMES.map((name, i) => ({ name, icon: gr3xFilmIcon(engine.info.tiles.film, i) }));
    const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, 0.9))));
    const preset = { matrixQ13: Int16Array.from([9000, -500, -308, -400, 8900, -308, -200, -600, 8992]), curves: [Uint16Array.from(curve), Uint16Array.from(curve), Uint16Array.from(curve)] as [Uint16Array, Uint16Array, Uint16Array] };
    return [
      { name: 'T4', soft: [], looks: undefined },
      { name: 'T4-SF1', soft: [...soft], looks: undefined },
      { name: 'T5-L1 replicas', soft: [...soft], looks: { displayRevision: 2 as const, monoReplicas: true, films: films9.slice(0, 2) } },
      { name: 'T6 nine films', soft: [...soft], looks: { displayRevision: 3 as const, monoReplicas: false, films: films9.map((f, i) => (i % 3 === 0 ? { ...f, preset } : f)) } },
      { name: 'T6d own parameters, custom ratios', soft: [...soft], looks: { displayRevision: 3 as const, monoReplicas: false, ownParameters: true, films: films9 },
        menu: planGr3xMenu([{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:5' }, { ratio: '3:1' }]) },
    ] as { name: string; soft: SoftFocusRequest[]; looks?: Gr3xLookOptions; menu?: Gr3xMenuRatio[] }[];
  };

  it('every GR III build is the IIIx build of the same recipe with only the identity bytes swapped', async () => {
    const eX = await Engine.open(rawX);
    for (const r of recipes(eX)) {
      const bX = await buildGr3xTestFirmware(rawX, r.soft, r.looks, r.menu);
      const b3 = await buildGr3xTestFirmware(raw3, r.soft, r.looks, r.menu);
      expect(b3.report.filename).toBe('fwdc239b.bin');
      expect(b3.report.profile).toBe('gr3-hdf-2.10');
      expect(b3.manifest.sites).toEqual(bX.manifest.sites);
      expect(b3.manifest.append).toEqual(bX.manifest.append);
      expect(b3.manifest.iconAddition).toEqual(bX.manifest.iconAddition);
      const oX = new Firmware(bX.bytes).decoded, o3 = new Firmware(b3.bytes).decoded;
      expect(o3.length).toBe(oX.length);
      // Expected GR III output: the IIIx output with GR III's identity bytes (shifted by the RTOS
      // growth after the RTOS end), GR III's marker and a recomputed checksum word.
      const rtos = sectionsOf(decX).find(s => s.name === 'RTOS')!;
      const rtosEnd = rtos.offset + rtos.size, growth = o3.length - decX.length;
      const rtosGrowth = sectionsOf(oX).find(s => s.name === 'RTOS')!.size - rtos.size;
      const icon = sectionsOf(decX).find(s => s.name === 'ICONBIN')!, iconEnd = icon.offset + icon.size;
      const expected = oX.slice();
      for (const o of diff) {
        // sections after the RTOS move by its growth; those after ICONBIN (RES) by both growths
        const at = o < rtosEnd ? o : o < iconEnd ? o + rtosGrowth : o + growth;
        expect(oX[at]).toBe(decX[o]); // no patch touched an identity byte
        expected[at] = dec3[o];
      }
      expect(growth).toBeGreaterThanOrEqual(rtosGrowth);
      const entries = r.menu?.length ?? 9;
      const markerX = new TextEncoder().encode(`GR3X-HDF-160-ADJ${entries}-${bX.report.revision}-HARDWARE-UNTESTED\0`);
      const marker3 = new TextEncoder().encode(`GR3-HDF-210-ADJ${entries}-${b3.report.revision}-HARDWARE-UNTESTED\0`);
      const end = rtosEnd + rtosGrowth;
      expect(Array.from(oX.subarray(end - 4 - markerX.length, end - 4))).toEqual(Array.from(markerX));
      expected.fill(0, end - 4 - markerX.length, end - 4);
      expected.set(marker3, end - 4 - marker3.length);
      new DataView(expected.buffer).setUint32(end - 4, 0, true);
      new DataView(expected.buffer).setUint32(end - 4, (-sum32(expected)) >>> 0, true);
      const mismatch = differences(expected, o3);
      expect(mismatch.slice(0, 8), r.name).toEqual([]);
      expect(sum32(o3)).toBe(0);
    }
  }, 600_000);

  /**
   * Every feature of GR Mod's GR III builds (rounds 6..8: twenty films with presets and names, the
   * date imprint, End Screen pictures, the settings guard, the Image Control order) built through
   * the app's engine for both cameras: per section, the GR III file is the IIIx file but for the
   * identity bytes of the two official images (RTOS header, epoch-year function, identity getters,
   * one copyright year; CPU, SRIC), the build marker and the RTOS checksum word. RES (with the
   * pictures inserted) and ICONBIN are byte for byte the same.
   */
  it('every full-feature build (rounds 6..8) is the same on both cameras but for the identity bytes', async () => {
    const eX = await Engine.open(rawX), e3 = await Engine.open(raw3);
    expect(eX.info.features).toMatchObject({ dateStamp: true, maxFilms: 20 });
    expect(eX.info.capabilities).toMatchObject({ menuPictures: true, lookLayout: true });
    const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, 0.8))));
    const preset = { matrixQ13: Int16Array.from([9100, -600, -308, -300, 8800, -308, -100, -700, 8992]), curves: [Uint16Array.from(curve), Uint16Array.from(curve), Uint16Array.from(curve)] as [Uint16Array, Uint16Array, Uint16Array] };
    const rgb = new Uint8Array(720 * 480 * 3).map((_, i) => (i * 7 + (i >> 11)) & 255);
    const pictures = [{ id: 0x1007, name: 'Equal Test', jpeg: encodeGr3xPicture(rgb) }];
    const ratios = [{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:3', name: '4:3' }];
    const requests = GR3X_FILM_IDS.slice(0, 20).map((slot, i) => ({ slot, names: { en: `Film ${i + 1}` }, ...(i % 4 === 0 ? { preset } : {}) }));
    const order = [64, 11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21, ...Array.from({ length: 19 }, (_, k) => 65 + k)];
    const cases: [string, Parameters<Engine['buildFirmware']>][] = [
      ['round 8: 20 films, date, pictures, order', [requests, ratios, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, shutdownPictures: pictures, lookLayout: { order, hidden: [18, 83] } }]],
      ['round 7: 20 films, date', [requests, ratios, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, gr3Round: 7 }]],
      ['round 6: 9 films, no guard', [requests.slice(0, 9), ratios, [], { filmCount: 9, dateStamp: true, guard: false }]],
      ['date imprint and pictures without films', [[], ratios, [], { dateStamp: true, shutdownPictures: pictures }]],
    ];
    const rtosRanges = (va: number) => (va >= 0x53002000 && va < 0x53002090) || (va >= 0x536b62ec && va < 0x536b6578) ||
      (va >= 0x5381fe4c && va < 0x5381fea0) || (va >= 0x53d62314 && va < 0x53d62320);
    const secX = sectionsOf(decX), sec3o = sectionsOf(dec3);
    for (const [name, args] of cases) {
      const bX = await eX.buildFirmware(...args), b3 = await e3.buildFirmware(...args);
      expect(Object.values(bX.checks).every(v => v), name).toBe(true);
      expect(Object.values(b3.checks).every(v => v), name).toBe(true);
      const oX = new Firmware(bX.file).decoded, o3 = new Firmware(b3.file).decoded;
      expect(o3.length, name).toBe(oX.length);
      const sX = sectionsOf(oX), s3 = sectionsOf(o3);
      expect(s3.map(x => [x.name, x.offset, x.size]), name).toEqual(sX.map(x => [x.name, x.offset, x.size]));
      // Bytes outside the sections (container header of the payload, padding): the official images' differences only.
      for (const sec of sX) {
        const a = oX.subarray(sec.offset, sec.offset + sec.size), b = o3.subarray(sec.offset, sec.offset + sec.size);
        const d: number[] = [];
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
        if (sec.name === 'RTOS') {
          // the identity bytes, then the marker and checksum word at the end of the grown RTOS
          const tail = sec.size - 4 - 64;
          expect(d.filter(i => !rtosRanges(GR3X_160.rtosBase + i) && i < tail).map(i => (GR3X_160.rtosBase + i).toString(16)), `${name} RTOS`).toEqual([]);
          expect(d.filter(i => rtosRanges(GR3X_160.rtosBase + i)).length, name).toBeLessThan(40);
        } else if (sec.name === 'CPU' || sec.name === 'SRIC') {
          const o = sec3o.find(x => x.name === sec.name)!, ox = secX.find(x => x.name === sec.name)!;
          expect(o.size).toBe(ox.size); expect(sec.size, name).toBe(ox.size);
          const official = new Set(diff.filter(i => i >= ox.offset && i < ox.offset + ox.size).map(i => i - ox.offset));
          expect(d.filter(i => !official.has(i)), `${name} ${sec.name}`).toEqual([]);
        } else {
          expect(d.length, `${name} ${sec.name}`).toBe(0);
        }
      }
      // And each file is recognised (verified) only by its own camera's engine.
      expect(await (await Engine.open(rawX)).inspect(bX.file), name).toMatchObject({ verified: true });
      expect(await (await Engine.open(raw3)).inspect(b3.file), name).toMatchObject({ verified: true });
    }
  }, 1_800_000);

  it('the GR III container keeps GR III\'s own header, version and model records', async () => {
    const b3 = await buildGr3xTestFirmware(raw3, [...soft]);
    const head = (b: Uint8Array) => Array.from(b.subarray(0, 0x80));
    const h3 = head(b3.bytes), o3 = head(raw3);
    // Only the payload length / sums in the header may change; identity and version stay GR III 2.10.
    expect(h3.slice(0, 0x38)).toEqual(o3.slice(0, 0x38));
    expect(new DataView(b3.bytes.buffer).getUint32(0x38, false)).toBe(0x020a151b);
    expect(new DataView(b3.bytes.buffer).getUint32(0x50, false)).toBe(0x020a151b);
    expect(new Firmware(b3.bytes).project).toBe(588);
    const d = new Firmware(b3.bytes).decoded, r = sectionsOf(d).find(s => s.name === 'RTOS')!;
    expect(new DataView(d.buffer).getUint32(r.offset + 0x2030, true)).toBe(588);
    expect(new DataView(d.buffer).getUint32(r.offset + 0x2034, true)).toBe(78350);
  }, 120_000);

  it('opens GR III as its own camera and recognises only its own builds', async () => {
    const e3 = await Engine.open(raw3), eX = await Engine.open(rawX);
    expect(e3.info).toMatchObject({ family: 'gr3x', filename: 'fwdc239b.bin', models: ['GR3_HDF', 'GR3'], version: '2.10',
      capabilities: { build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false, menuPictures: true, lookLayout: true },
      features: { dateStamp: true, maxFilms: 20 } });
    expect(e3.info).not.toHaveProperty('experimental');
    expect(eX.info).toMatchObject({ filename: 'fwdc243b.bin', models: ['GR3X_HDF', 'GR3X'], version: '1.60',
      capabilities: { menuPictures: true, lookLayout: true }, features: { dateStamp: true, maxFilms: 20 } });
    expect(e3.info.factoryEntry.modeSetName).toBe('00078350.588');
    expect(readGr3xFactoryEntry(dec3, GR3_210).modeSetName).toBe('00078350.588');
    expect(() => readGr3xFactoryEntry(dec3, GR3X_160)).toThrow();
    const ratios = GFX_RATIOS.filter(r => !['3:2', '1:1'].includes(r)).map(ratio => ({ name: ratio, ratio }));
    const films = T6_FILM_NAMES.map((name, i) => ({ slot: GR3X_FILM_IDS[i], names: { en: name }, icon: gr3xFilmIcon(e3.info.tiles.film, i) }));
    const b3 = await e3.buildFirmware(films, ratios, [...soft]);
    const bX = await eX.buildFirmware(films, ratios, [...soft]);
    expect(await e3.inspect(raw3)).toMatchObject({ kind: 'official', verified: true });
    expect(await e3.inspect(b3.file)).toMatchObject({ kind: 'modified', verified: true });
    expect((await e3.inspect(b3.file)).slots.map(s => s.names.en)).toEqual([...T6_FILM_NAMES]);
    // never across cameras
    expect(await e3.inspect(bX.file)).toMatchObject({ verified: false });
    expect(await eX.inspect(b3.file)).toMatchObject({ verified: false });
    expect(await e3.inspect(rawX)).toMatchObject({ verified: false });
    expect(await eX.inspect(raw3)).toMatchObject({ verified: false });
  }, 600_000);
});
