// SPDX-License-Identifier: GPL-2.0-only
/**
 * More ADJ lever slots (`src/fw/aspect/adjslots.ts`). Needs the official firmware in testdata/private
 * for the build tests (skipped without it). What the new code does when it runs is checked in an
 * emulator by `tools/adjslots/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { ADJSLOTS_CODE, ADJSLOTS_SOURCE_SHA256 } from '../src/fw/aspect/adjslots-code';
import { createHash } from 'node:crypto';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('ADJ lever slots: data', () => {
  it('lays N slots out in one row ending where the camera\'s last one is', () => {
    expect([0, 1, 2, 3, 4].map((k) => aspect.adjFrameX(5, k))).toEqual([425, 485, 545, 605, 665]);
    expect(aspect.adjPitch(5)).toBe(60);
    for (const n of [6, 7, 8]) {
      expect(aspect.adjPitch(n)).toBe(52);
      expect(aspect.adjFrameX(n, n - 1)).toBe(665);
      // frames of 50 px do not overlap, and the strip stays right of the value / name labels' start
      expect(aspect.adjFrameX(n, 0)).toBeGreaterThan(250);
    }
    expect(aspect.adjFrameX(8, 0)).toBe(301);
  });
  it('keeps slots 6..8 in padding of the settings apart from the other additions', () => {
    expect(aspect.ADJ_EXTRA_BYTE).toBe(0x55084dd8 + 4 + 0x489);
    const others = [aspect.SOFT_FOCUS_BYTE, aspect.DATESTAMP_BYTE, aspect.DIRECT_FLASH_BYTE, aspect.DIRECT_FLASH_GN_BYTE, aspect.DIRECT_FLASH_TV_BYTE];
    for (let k = 0; k < 3; k++) expect(others).not.toContain(aspect.ADJ_EXTRA_BYTE + k);
    expect(aspect.ADJ_OBJECT).toBeGreaterThanOrEqual(aspect.ADJ_STATE + 2 * aspect.adjLayoutStride(8));
    expect(aspect.ADJ_ICONS).toBeGreaterThanOrEqual(aspect.ADJ_FRAMES + 4 * 8);
    expect(aspect.ADJ_STATE).toBeGreaterThanOrEqual(aspect.ADJ_ICONS + 4 * 8);
  });
  it('names the new lines from the camera\'s own "Setting1"', () => {
    expect(aspect.settingName('Setting1', 6)).toBe('Setting6');
    expect(aspect.settingName('設定1', 8)).toBe('設定8');
    expect(aspect.settingName('設定１', 7)).toBe('設定７');
    expect(aspect.adjMenuName('ADJ Mode Setting', 6)).toBe('ADJ Mode Setting 6');
    expect(aspect.adjMenuName('ADJ Mode Setting', 8)).toBe('ADJ Mode Setting 6-8');
  });
  it('the compiled module is the one of the committed source', () => {
    expect(ADJSLOTS_CODE.length).toBeGreaterThan(100);
    const src = readFileSync(new URL('../../tools/adjslots/adjslots.c', import.meta.url));
    expect(createHash('sha256').update(src).digest('hex')).toBe(ADJSLOTS_SOURCE_SHA256);
  });
});

describe.skipIf(!have)('ADJ lever slots: builds', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;
  const rtosOf = (file: Uint8Array): Uint8Array => {
    const d = new fw.Firmware(file).decoded;
    const r = fw.sectionsOf(d).find((s) => s.name === 'RTOS')!;
    return d.subarray(r.offset, r.offset + r.size);
  };

  it('opens the official file and offers up to 8 slots', async () => {
    eng = await Engine.open(raw);
    expect(eng.info.features.maxAdjSlots).toBe(8);
  });

  for (const n of [6, 7, 8]) {
    it(`${n} slots: builds, passes the self-check, reads back`, async () => {
      const b = await eng.buildFirmware([], [], [], { adjSlots: n });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect(s.adjSlots).toBe(n);
      expect(fw.readExtensionFeatures(rtosOf(b.file))).toEqual({ guard: true, adjSlots: n });
    });
  }

  it('with soft focus, the date imprint, Direct Flash and the earlier test contents', async () => {
    const b = await eng.buildFirmware([], [], [], { adjSlots: 8, adjSoftFocus: true, dateStamp: true, directFlash: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect([s.adjSlots, s.adjSoftFocus, s.dateStamp, s.directFlash]).toEqual([8, true, true, true]);
  });

  it('5 is the camera\'s five: nothing to change on its own, and not recorded', async () => {
    await expect(eng.buildFirmware([], [], [], { adjSlots: 5, guard: false })).rejects.toThrow(/nothing to change/);
    const b = await eng.buildFirmware([], [], [], { adjSlots: 5, dateStamp: true });
    const a = await eng.buildFirmware([], [], [], { dateStamp: true });
    expect(b.sha256).toBe(a.sha256);
    expect((await eng.inspect(b.file)).adjSlots).toBeUndefined();
  });

  it('refuses other counts', async () => {
    for (const n of [4, 9, 6.5]) await expect(eng.buildFirmware([], [], [], { adjSlots: n })).rejects.toThrow(/5 to 8/);
  });
});

// GR IV 1.20 (the generated port, core/src/fw/gr4v120/aspect/adjslots.ts): needs GRMOD_GR4_120_FIRMWARE.
const file120 = process.env.GRMOD_GR4_120_FIRMWARE;
describe.skipIf(!file120 || !existsSync(file120))('ADJ lever slots: GR IV 1.20', () => {
  it('builds 6..8 slots with the other additions, passes the self-check, reads back', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file120!)), { newFirmware: true });
    expect(eng.info.version).toBe('1.20');
    expect(eng.info.features.maxAdjSlots).toBe(8);
    for (const n of [6, 8]) {
      const b = await eng.buildFirmware([], [], [], { adjSlots: n, adjSoftFocus: true, dateStamp: true, directFlash: true, monoUnlock: true });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.verified).toBe(true);
      expect([s.adjSlots, s.adjSoftFocus, s.dateStamp, s.directFlash]).toEqual([n, true, true, true]);
    }
  }, 240_000);
  it('the compiled 1.20 module is the one of its committed source', async () => {
    const m = await import('../src/fw/gr4v120/aspect/adjslots-code');
    const src = readFileSync(new URL('../../tools/gr4v120/adjslots/adjslots.c', import.meta.url));
    expect(createHash('sha256').update(src).digest('hex')).toBe(m.ADJSLOTS_SOURCE_SHA256);
  });
});
