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

  it('the Fn function acts on a press only for the camera code that posts a button\'s events, not for what only asks', async () => {
    // The function switch is the end of a getter ("what would this button do"). The shooting screen's key guide and
    // the idle timers call it without a press; acting for them left an Fn button's lamp dim and flickering (0.9.4).
    const at = release === '1.21'
      ? { bound: 0x533999bc, end: 0x53399b2c, handler: 0x53245cdc, fast: 0x533a1c00, replay: 0x533a221c, guide: 0x5318de08, timers: 0x53260f14 }
      : { bound: 0x5339910c, end: 0x5339927c, handler: 0x532456d0, fast: 0x533a1350, replay: 0x533a196c, guide: 0x5318de30, timers: 0x532606c4 };
    const eng = await Engine.open(official);
    const rtos = rtosOf((await eng.buildFirmware([], [], [], { constantLight: true })).file);
    const dv = new DataView(rtos.buffer, rtos.byteOffset, rtos.byteLength);
    const word = (a: number): number => dv.getUint32(a - 0x53000000, true);
    const target = (a: number): number => a + 8 + (((word(a) & 0xffffff) ^ 0x800000) - 0x800000) * 4;
    const imm16 = (w: number): number => ((w >>> 4) & 0xf000) | (w & 0xfff);
    expect(word(at.bound) >>> 24).toBe(0xea);
    const stub = target(at.bound);
    expect(word(stub)).toBe(0xe3520029); // cmp r2, #0x29
    expect(word(stub + 8)).toBe(0xe3560000); // cmp r6, #0: a press
    expect(word(stub + 12) >>> 24).toBe(0x1a);
    expect(target(stub + 12)).toBe(at.end);
    // the frames: the button's handler, GetEventSwitch, its wrapper; the wrapper's return address
    expect([16, 20, 24, 28].map((o) => word(stub + o))).toEqual([0xe51b000c, 0xe510000c, 0xe510000c, 0xe5100004]);
    const ranges: [number, number][] = [];
    let a = stub + 32;
    for (; (word(a) & 0xfff0f000) >>> 0 === 0xe3001000; a += 24) {
      expect((word(a + 4) & 0xfff0f000) >>> 0).toBe(0xe3401000); // movt r1
      expect(word(a + 8)).toBe(0xe0401001); // sub r1, r0, r1
      expect((word(a + 12) & 0xfff0f000) >>> 0).toBe(0xe3003000); // movw r3, #length
      expect(word(a + 16)).toBe(0xe1510003); // cmp r1, r3
      expect(word(a + 20) >>> 24).toBe(0x3a); // blo: act
      const start = (imm16(word(a)) | (imm16(word(a + 4)) << 16)) >>> 0;
      ranges.push([start, start + imm16(word(a + 12))]);
    }
    expect(ranges).toHaveLength(3);
    expect(word(a) >>> 24).toBe(0xea); // none of them: the end, nothing done
    expect(target(a)).toBe(at.end);
    expect(word(a + 4) >>> 24).toBe(0xeb); // act: the lamp switched over
    expect(target(a + 8)).toBe(at.end);
    const posts = (ret: number): boolean => ranges.some(([lo, hi]) => ret >= lo && ret < hi);
    expect([at.handler, at.fast, at.replay].map(posts)).toEqual([true, true, true]);
    expect([at.guide, at.timers].map(posts)).toEqual([false, false]);
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
