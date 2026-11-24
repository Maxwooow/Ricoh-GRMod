// SPDX-License-Identifier: GPL-2.0-only
/**
 * Sensor Shift (GR IV 1.20 and 1.21): the picture moved and turned by hand with the shake reduction
 * unit (`src/fw/gr4v120/aspect/shift.ts`). Needs the official files (GRMOD_GR4_120_FIRMWARE,
 * GRMOD_GR4_121_FIRMWARE). What the firmware does with it is checked in an emulator by
 * `tools/shift/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { FN_SHIFT, SHIFT_ADJUST_NAMES, SHIFT_CENTER_NAMES, SHIFT_MAGIC, SHIFT_NAMES, drawShiftIcon, shiftAdjFunction } from '../src/fw/gr4v120/aspect/shift';
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
const count = (rtos: Uint8Array, w: number): number => {
  const dv = new DataView(rtos.buffer, rtos.byteOffset);
  let n = 0;
  for (let i = 0x01000000; i + 4 <= rtos.length; i += 4) if (dv.getUint32(i, true) === w) n++;
  return n;
};

describe('Sensor Shift: the icon', () => {
  it('is the one the camera tests ran with (test 111)', () => {
    expect(createHash('sha256').update(drawShiftIcon()).digest('hex')).toBe('213a1c5d40b892883f3037c22a220527cdaff94af13af701e7cdbd67659861f9');
  });
});

describe.each(files)('Sensor Shift: GR IV %s', (release, path) => {
  const { LANGS, allowedChars } = (release === '1.21' ? names121 : names120) as typeof names120;
  const official = new Uint8Array(readFileSync(path));

  it('builds alone, verifies and reads back', async () => {
    const eng = await Engine.open(official);
    expect(eng.info.features.sensorShift).toBe(true);
    const b = await eng.buildFirmware([], [], [], { sensorShift: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.sensorShift).toBe(true);
    const rtos = rtosOf(b.file);
    expect(readExtensionFeatures(rtos)).toMatchObject({ sensorShift: true });
    expect(count(rtos, SHIFT_MAGIC)).toBe(1);
    expect(shiftAdjFunction(false, false)).toBe(0x15);
    expect(FN_SHIFT).toBe(0x2e);
    // without it: nothing of it
    const plain = await eng.buildFirmware([], [], [], { dateStamp: true });
    expect((await eng.inspect(plain.file)).sensorShift).toBeUndefined();
    expect(count(rtosOf(plain.file), SHIFT_MAGIC)).toBe(0);
  });

  it('builds with everything else: the ADJ function after exposure preview and Constant Light', async () => {
    const eng = await Engine.open(official);
    const all = { adjSoftFocus: true, softFocusMenu: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8,
      exposurePreview: true, ratioShade: true, batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, movieExposure: true } as const;
    const b = await eng.buildFirmware([], testRatios(eng), [], { ...all, sensorShift: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(readExtensionFeatures(rtosOf(b.file))).toMatchObject({ sensorShift: true, constantLight: true, movieExposure: true, exposurePreview: true, adjSlots: 8 });
    expect(shiftAdjFunction(true, true)).toBe(0x17);
  });

  it('every character of the texts is in the camera\'s own texts of that language', () => {
    const d = new fw.Firmware(official).decoded;
    LANGS.forEach((lang, k) => {
      const allowed = allowedChars(d, lang);
      for (const text of [SHIFT_NAMES[k], SHIFT_ADJUST_NAMES[k], SHIFT_CENTER_NAMES[k]]) {
        const missing = [...text].filter((c) => !allowed.has(c.charCodeAt(0)));
        expect(missing, `${lang}: ${text}`).toEqual([]);
      }
    });
  });

  it('is refused with a wrong type', async () => {
    const eng = await Engine.open(official);
    await expect(eng.buildFirmware([], [], [], { sensorShift: 1 as unknown as boolean })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});

describe.skipIf(!existsSync(file111))('Sensor Shift: not on GR IV 1.11', () => {
  it('is refused', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(eng.info.features.sensorShift).toBeUndefined();
    await expect(eng.buildFirmware([], [], [], { sensorShift: true })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});
