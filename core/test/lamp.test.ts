// SPDX-License-Identifier: GPL-2.0-only
/**
 * Constant Light (GR IV 1.20 and 1.21): the front lamp kept lit, switched by a line of
 * the still menu, an ADJ lever function and an Fn function (`src/fw/gr4v120/aspect/lamp.ts`). Needs
 * the official files (GRMOD_GR4_120_FIRMWARE, GRMOD_GR4_121_FIRMWARE). What the firmware does with
 * it is checked in an emulator by `tools/gr4v120/lamp/check.py` (1.21: `tools/gr4v121/lamp`).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { FN_LAMP, LAMP_LIST_ID, LAMP_NAMES, lampAdjFunction } from '../src/fw/gr4v120/aspect/lamp';
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

describe.each(files)('Constant Light: GR IV %s', (release, path) => {
  const { LANGS, allowedChars } = (release === '1.21' ? names121 : names120) as typeof names120;
  const official = new Uint8Array(readFileSync(path));

  it('builds alone, verifies and reads back', async () => {
    const eng = await Engine.open(official);
    expect(eng.info.features.constantLight).toBe(true);
    const b = await eng.buildFirmware([], [], [], { constantLight: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.constantLight).toBe(true);
    const rtos = rtosOf(b.file);
    expect(readExtensionFeatures(rtos)).toMatchObject({ constantLight: true });
    // one still descriptor per model holds the line
    expect(count(rtos, LAMP_LIST_ID)).toBeGreaterThanOrEqual(3);
    expect(lampAdjFunction(false)).toBe(0x15);
    expect(FN_LAMP).toBe(0x29);
    // without it: nothing of it
    const plain = await eng.buildFirmware([], [], [], { dateStamp: true });
    expect((await eng.inspect(plain.file)).constantLight).toBeUndefined();
    expect(count(rtosOf(plain.file), LAMP_LIST_ID)).toBe(0);
  });

  it('builds with everything else: 42 still-menu lines, the ADJ function after exposure preview', async () => {
    const eng = await Engine.open(official);
    const all = { adjSoftFocus: true, softFocusMenu: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8,
      exposurePreview: true, ratioShade: true, batteryPercent: true, videoAf: true, awbLearn: true } as const;
    const b = await eng.buildFirmware([], testRatios(eng), [], { ...all, constantLight: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(readExtensionFeatures(rtosOf(b.file))).toMatchObject({ constantLight: true, exposurePreview: true, adjSlots: 8, ratioShade: true });
    expect(lampAdjFunction(true)).toBe(0x16);
  });

  it('every character of the name is in the camera\'s own texts of that language', () => {
    const d = new fw.Firmware(official).decoded;
    LANGS.forEach((lang, k) => {
      const allowed = allowedChars(d, lang);
      const missing = [...LAMP_NAMES[k]].filter((c) => !allowed.has(c.charCodeAt(0)));
      expect(missing, `${lang}: ${LAMP_NAMES[k]}`).toEqual([]);
    });
  });

  it('is refused with a wrong type', async () => {
    const eng = await Engine.open(official);
    await expect(eng.buildFirmware([], [], [], { constantLight: 1 as unknown as boolean })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});

describe.skipIf(!existsSync(file111))('Constant Light: not on GR IV 1.11', () => {
  it('is refused', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(eng.info.features.constantLight).toBeUndefined();
    await expect(eng.buildFirmware([], [], [], { constantLight: true })).rejects.toMatchObject({ code: 'bad-edit' });
  });
});
