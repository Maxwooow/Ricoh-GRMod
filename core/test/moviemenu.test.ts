// SPDX-License-Identifier: GPL-2.0-only
/**
 * The two movie menu additions (GR IV 1.20 and 1.21): 4K movies (`src/fw/gr4v120/aspect/movie4k.ts`,
 * Frame Rate / Resolution) and the shake reduction for movies by sensor shift (`moviesr.ts`, Movie SR
 * with Off / Sensor Shift / Electronic). Needs the official files (GRMOD_GR4_120_FIRMWARE,
 * GRMOD_GR4_121_FIRMWARE). What the firmware does with them is checked in an emulator by
 * `tools/moviemenu/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { MOVIE_4K_BIT, MOVIE_BYTE_OFFSET, MOVIE_SENSOR_SR_BIT, RESOLUTION_NAMES } from '../src/fw/gr4v120/aspect/movie4k';
import { MOVIESR_ELECTRONIC_NAMES, MOVIESR_ICON_ID, MOVIESR_SENSOR_NAMES, drawElectronicIcon } from '../src/fw/gr4v120/aspect/moviesr';
import { SHIFT_ICON_ID } from '../src/fw/gr4v120/aspect/shift';
import { readExtensionFeatures } from '../src/fw/gr4v120/aspect/package';
import * as names120 from '../src/fw/gr4v120/names';
// @ts-ignore the 1.21 overlay: the same module on 1.21's addresses (core/overlays.mjs)
import * as names121 from '../src/fw/gr4v121/names';
import { testRatios } from './fw-helpers/test-firmware';

const files = [['1.20', process.env.GRMOD_GR4_120_FIRMWARE], ['1.21', process.env.GRMOD_GR4_121_FIRMWARE]].filter(([, f]) => !!f && existsSync(f)) as [string, string][];
const file111 = new URL('../testdata/private/official.bin', import.meta.url);

const rtosOf = (file: Uint8Array): Uint8Array => {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.subarray(r.offset, r.offset + r.size);
};

describe('The movie menu additions: constants', () => {
  it('keep their two bits in one byte and their own icon', () => {
    expect(MOVIE_BYTE_OFFSET).toBe(0x775);
    expect(MOVIE_SENSOR_SR_BIT).toBe(1);
    expect(MOVIE_4K_BIT).toBe(2);
    expect(MOVIESR_ICON_ID).not.toBe(SHIFT_ICON_ID);
  });
  it('the Electronic icon is the hand with something added, the hand itself untouched elsewhere', () => {
    const hand = new Uint8Array(40 * 40 * 4).fill(0x80);
    const e = drawElectronicIcon(hand);
    expect(e.length).toBe(hand.length);
    let changed = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const same = [0, 1, 2, 3].every((c) => e[(y * 40 + x) * 4 + c] === hand[(y * 40 + x) * 4 + c]);
      if (!same) { changed++; expect(x >= 24 && y >= 24, `${x},${y}`).toBe(true); }
    }
    expect(changed).toBeGreaterThan(20);
  });
});

describe.each(files)('The movie menu additions: GR IV %s', (release, path) => {
  const { LANGS, allowedChars } = (release === '1.21' ? names121 : names120) as typeof names120;
  const official = new Uint8Array(readFileSync(path));

  it.each([['movie4k'], ['movieSr']] as const)('%s builds alone, verifies and reads back', async (name) => {
    const eng = await Engine.open(official);
    expect(eng.info.features[name]).toBe(true);
    const b = await eng.buildFirmware([], [], [], { [name]: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s[name]).toBe(true);
    const other = name === 'movie4k' ? 'movieSr' : 'movie4k';
    expect(s[other]).toBeUndefined();
    expect(readExtensionFeatures(rtosOf(b.file))).toMatchObject({ [name]: true });
  });

  it('nothing of them without them', async () => {
    const eng = await Engine.open(official);
    const plain = await eng.buildFirmware([], [], [], { dateStamp: true });
    const s = await eng.inspect(plain.file);
    expect(s.movie4k).toBeUndefined();
    expect(s.movieSr).toBeUndefined();
  });

  it('build together, with Sensor Shift and with everything else', async () => {
    const eng = await Engine.open(official);
    const both = await eng.buildFirmware([], [], [], { movie4k: true, movieSr: true, sensorShift: true });
    expect((await eng.inspect(both.file)).verified).toBe(true);
    const all = { adjSoftFocus: true, softFocusMenu: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8,
      exposurePreview: true, ratioShade: true, batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, movieExposure: true, sensorShift: true } as const;
    const b = await eng.buildFirmware([], testRatios(eng), [], { ...all, movie4k: true, movieSr: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(readExtensionFeatures(rtosOf(b.file))).toMatchObject({ movie4k: true, movieSr: true, sensorShift: true, constantLight: true, movieExposure: true, videoAf: true });
  });

  it('every character of the texts is in the camera\'s own texts of that language', () => {
    const d = new fw.Firmware(official).decoded;
    LANGS.forEach((lang, k) => {
      const allowed = allowedChars(d, lang);
      for (const text of [RESOLUTION_NAMES[k], ' / ', 'FHD', '4K', '4K 30p', '4K 24p', MOVIESR_SENSOR_NAMES[k], MOVIESR_ELECTRONIC_NAMES[k]]) {
        const missing = [...text].filter((c) => !allowed.has(c.charCodeAt(0)));
        expect(missing, `${lang}: ${text}`).toEqual([]);
      }
    });
  });

  it.each([['movie4k'], ['movieSr']] as const)('%s is refused with a wrong type', async (name) => {
    const eng = await Engine.open(official);
    await expect(eng.buildFirmware([], [], [], { [name]: 1 as unknown as boolean })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});

describe.skipIf(!existsSync(file111))('The movie menu additions: not on GR IV 1.11', () => {
  it.each([['movie4k'], ['movieSr']] as const)('%s is refused', async (name) => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(eng.info.features[name]).toBeUndefined();
    await expect(eng.buildFirmware([], [], [], { [name]: true })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});
