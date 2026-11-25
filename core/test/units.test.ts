// SPDX-License-Identifier: GPL-2.0-only
/**
 * Distances in feet (GR IV 1.20 and 1.21, `src/fw/gr4v120/aspect/units.ts`): Snap Focus Distance and the manual focus
 * scale's labels. Needs the official files (GRMOD_GR4_120_FIRMWARE, GRMOD_GR4_121_FIRMWARE).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { readExtensionFeatures } from '../src/fw/gr4v120/aspect/package';
import { SCALE_SITES, SNAP_FEET, SNAP_METRES, UNIT_ICON_H, UNIT_ICON_IDS, UNIT_ICON_W, UNIT_LABEL_NAMES, unitLabelPixels } from '../src/fw/gr4v120/aspect/units';
import { UNIT_LABELS } from '../src/fw/gr4v120/aspect/units-icons';
import * as names120 from '../src/fw/gr4v120/names';
// @ts-ignore the 1.21 overlay: the same module on 1.21's addresses (core/overlays.mjs)
import * as names121 from '../src/fw/gr4v121/names';
import { testRatios } from './fw-helpers/test-firmware';

const files = [['1.20', process.env.GRMOD_GR4_120_FIRMWARE], ['1.21', process.env.GRMOD_GR4_121_FIRMWARE]].filter(([, f]) => !!f && existsSync(f)) as [string, string][];
const file111 = new URL('../testdata/private/official.bin', import.meta.url);
/** The function that sets the manual focus scale's labels, in each release (1.21: the same code, moved). */
const SCALE: Record<string, number> = { '1.20': 0x53592728, '1.21': 0x53593050 };

const rtosOf = (file: Uint8Array): Uint8Array => {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.subarray(r.offset, r.offset + r.size);
};
const word = (rtos: Uint8Array, address: number): number => new DataView(rtos.buffer, rtos.byteOffset).getUint32(address - 0x53000000, true);
const utf16 = (s: string): Uint8Array => Uint8Array.from([...s, '\0'].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]));
const has = (hay: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= hay.length; i += 2) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};
const movwR1 = (v: number): number => (0xe3001000 | ((v & 0xf000) << 4) | (v & 0xfff)) >>> 0;

describe('distance labels', () => {
  it('have one icon per label, 30 x 20, an outline around every figure', () => {
    const names = [...UNIT_LABEL_NAMES];
    expect([...names].sort()).toEqual([...new Set(SCALE_SITES.map(([, , l]) => l))].sort());
    expect([...names].sort()).toEqual(Object.keys(UNIT_LABELS).sort());
    expect(new Set(Object.values(UNIT_ICON_IDS)).size).toBe(names.length);
    for (const name of names) {
      const px = unitLabelPixels(name);
      expect(px.length).toBe(UNIT_ICON_W * UNIT_ICON_H * 4);
      // nothing on the edge of the tile but the outline (black), and some white inside
      let white = 0;
      for (let y = 0; y < UNIT_ICON_H; y++) {
        for (let x = 0; x < UNIT_ICON_W; x++) {
          const i = (y * UNIT_ICON_W + x) * 4;
          if (px[i] > 200) white++;
          if ((x === 0 || y === 0 || x === UNIT_ICON_W - 1 || y === UNIT_ICON_H - 1) && px[i + 3]) expect(px[i], name).toBe(0);
        }
      }
      expect(white, name).toBeGreaterThan(20);
    }
    expect(SNAP_FEET.length).toBe(SNAP_METRES.length);
  });
});

describe.each(files)('distances in feet: GR IV %s', (release, path) => {
  const { LANGS, allowedChars } = (release === '1.21' ? names121 : names120) as typeof names120;
  const official = new Uint8Array(readFileSync(path));

  it('builds alone, verifies and reads back', async () => {
    const eng = await Engine.open(official);
    expect(eng.info.features.distanceFeet).toBe(true);
    const b = await eng.buildFirmware([], [], [], { distanceFeet: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.distanceFeet).toBe(true);
    const rtos = rtosOf(b.file);
    expect(readExtensionFeatures(rtos)).toMatchObject({ distanceFeet: true });
    for (const t of SNAP_FEET) expect(has(rtos, utf16(t)), t).toBe(true);
    // the scale: every label's word names its icon; ∞ is the camera's
    for (const [offset, , label] of SCALE_SITES) expect(word(rtos, SCALE[release] + offset)).toBe(movwR1(UNIT_ICON_IDS[label]));
    expect(word(rtos, SCALE[release] + 0x40)).toBe(0xe30012c2);
    // without it: the camera's labels
    const plain = await eng.buildFirmware([], [], [], { dateStamp: true });
    const p = rtosOf(plain.file);
    expect((await eng.inspect(plain.file)).distanceFeet).toBeUndefined();
    for (const [offset, camera] of SCALE_SITES) expect(word(p, SCALE[release] + offset)).toBe(camera);
    expect(has(p, utf16('1.3ft'))).toBe(false);
  });

  it('builds with everything else', async () => {
    const eng = await Engine.open(official);
    const all = { adjSoftFocus: true, softFocusMenu: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8,
      exposurePreview: true, ratioShade: true, batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, movieExposure: true,
      sensorShift: true, movie4k: true, movieSr: true, flashTtl: true, filmGrain: true, shadowLearn: true } as const;
    const b = await eng.buildFirmware([], testRatios(eng), [], { ...all, distanceFeet: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(readExtensionFeatures(rtosOf(b.file))).toMatchObject({ distanceFeet: true, movieSr: true, sensorShift: true, constantLight: true, adjSlots: 8 });
  });

  it('every character of the values is in the camera\'s own texts of that language', () => {
    const d = new fw.Firmware(official).decoded;
    LANGS.forEach((lang) => {
      const allowed = allowedChars(d, lang);
      const missing = [...new Set(SNAP_FEET.join(''))].filter((c) => !allowed.has(c.charCodeAt(0)));
      expect(missing, lang).toEqual([]);
    });
  });

  it('is refused with a wrong type', async () => {
    const eng = await Engine.open(official);
    await expect(eng.buildFirmware([], [], [], { distanceFeet: 1 as unknown as boolean })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});

describe.skipIf(!existsSync(file111))('distances in feet: not on GR IV 1.11', () => {
  it('is refused', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(eng.info.features.distanceFeet).toBeUndefined();
    await expect(eng.buildFirmware([], [], [], { distanceFeet: true })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});
