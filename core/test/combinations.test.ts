// SPDX-License-Identifier: GPL-2.0-only
/**
 * Every combination of the additions builds, passes the self-check, and reads back with the right
 * features (`Engine.inspect`). Needs the official firmware in testdata/private (skipped without it).
 *
 *  - the monochrome looks on their own are written in place (official layout, 13 words and the
 *    checksum compensation word);
 *  - anything that appends code grows RTOS; ICONBIN grows only when icons are added (a test build
 *    of the date imprint with a fixed setting adds code only);
 *  - soft focus alone gives the same file as before these changes; all additions together with the
 *    contents of the earlier test firmware give test firmware 017 byte for byte (the file that was
 *    confirmed on the camera).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';
import { testPresetRequests, testRatios } from './fw-helpers/test-firmware';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');

/** SHA-256 of soft focus only, as built before ICONBIN was allowed to stay unchanged. */
const SOFT_ONLY_SHA256 = '0422b076ec4afae2a94a7ec5c1bcfd165a381721c09a822152f50fef54d35017';
/** SHA-256 of test firmware 017 (all additions, two presets, four ratios), confirmed on the camera. */
const TEST_017_SHA256 = 'f2881d4f0c3ab0f2958c6467683f5f48ec0757eae0e3ec964900d46e7602adb7';

function sections(file: Uint8Array): { decoded: Uint8Array; rtos: fw.Section; icon: fw.Section } {
  const decoded = new fw.Firmware(file).decoded;
  const list = fw.sectionsOf(decoded);
  return { decoded, rtos: list.find((s) => s.name === 'RTOS')!, icon: list.find((s) => s.name === 'ICONBIN')! };
}

describe.skipIf(!have)('combinations of the additions', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;
  const official = (): Uint8Array => new fw.Firmware(raw).decoded;

  const cases: { name: string; options: BuildOptions; features: Record<string, boolean>; iconGrows: boolean }[] = [
    { name: 'date imprint only', options: { dateStamp: true }, features: { adjSoftFocus: false, dateStamp: true, monoUnlock: false }, iconGrows: true },
    { name: 'date imprint + monochrome looks', options: { dateStamp: true, monoUnlock: true }, features: { adjSoftFocus: false, dateStamp: true, monoUnlock: true }, iconGrows: true },
    { name: 'soft focus only', options: { adjSoftFocus: true }, features: { adjSoftFocus: true, dateStamp: false, monoUnlock: false }, iconGrows: true },
    { name: 'soft focus + monochrome looks', options: { adjSoftFocus: true, monoUnlock: true }, features: { adjSoftFocus: true, dateStamp: false, monoUnlock: true }, iconGrows: true },
  ];

  it('opens the official file', async () => {
    eng = await Engine.open(raw);
  });

  for (const c of cases) {
    it(`${c.name}: builds, passes the self-check, reads back`, async () => {
      const b = await eng.buildFirmware([], [], [], c.options);
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect({ adjSoftFocus: s.adjSoftFocus, dateStamp: s.dateStamp, monoUnlock: s.monoUnlock }).toEqual(c.features);
      const { decoded, rtos, icon } = sections(b.file);
      expect(rtos.size).toBeGreaterThan(fw.RTOS_LENGTH);
      expect(icon.size > fw.ICONBIN_LENGTH).toBe(c.iconGrows);
      const want: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(c.features)) if (v) want[k] = true;
      expect(fw.readExtensionFeatures(decoded.subarray(rtos.offset, rtos.offset + rtos.size))).toEqual(want);
      if (c.name === 'soft focus only') expect(b.sha256).toBe(SOFT_ONLY_SHA256);
    });
  }

  it('monochrome looks only: written in place, 13 words and the compensation word', async () => {
    const b = await eng.buildFirmware([], [], [], { monoUnlock: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, monoUnlock: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect({ adjSoftFocus: s.adjSoftFocus, dateStamp: s.dateStamp, monoUnlock: s.monoUnlock }).toEqual({ adjSoftFocus: false, dateStamp: false, monoUnlock: true });
    const d = new fw.Firmware(b.file).decoded;
    const o = official();
    expect(d.length).toBe(o.length);
    const changed: number[] = [];
    for (let i = 0; i < o.length; i += 4) if (!fw.equalRange(d, i, o, i, 4)) changed.push(i - fw.RTOS_OFFSET + 0x53000000);
    expect(changed.map((a) => a.toString(16))).toEqual([
      '533cc6e0', '533cc6e4', '53dbf380', '53dbf384', '53dbf388', '53dbf38c', '53dbf390', '53dbf394', '53dbf398', '53dbf39c', '53dbf3a0', '53dbf3a4', '53dbf3a8',
      fw.COMP_VA.toString(16),
    ]);
    // Rows 3..8 of the availability table: every model but the Monochrome (column 1, already set).
    for (let row = 3; row <= 8; row++) {
      const at = fw.RTOS_OFFSET + 0x53dbf36c - 0x53000000 + row * 7;
      expect(Array.from(d.subarray(at, at + 7))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    }
  });

  it('monochrome looks only: a file with one of the words missing is not recognised as such', async () => {
    const b = await eng.buildFirmware([], [], [], { monoUnlock: true });
    const parsed = new fw.Firmware(b.file);
    const d = parsed.decoded.slice();
    const o = official();
    const at = fw.RTOS_OFFSET + 0x533cc6e4 - 0x53000000;
    d.set(o.subarray(at, at + 4), at);
    // Keep the word sum at zero through the compensation word, as a careful forger would.
    const delta = fw.sum32(d);
    const comp = new DataView(d.buffer, d.byteOffset).getUint32(fw.COMP_OFFSET, true);
    new DataView(d.buffer, d.byteOffset).setUint32(fw.COMP_OFFSET, (comp - delta) >>> 0, true);
    const forged = fw.build(new fw.Firmware(raw), d).out;
    const s = await eng.inspect(forged);
    expect(s.monoUnlock).toBe(false);
    expect(s.verified).toBe(false);
  });

  it('a build that appends code but no icons: RTOS grows, ICONBIN stays as it is', async () => {
    // The date imprint with a fixed setting (test builds) has no menu entry, so no icons.
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, dateStampFixed: 1 });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const { decoded, rtos, icon } = sections(b.file);
    expect(rtos.size).toBeGreaterThan(fw.RTOS_LENGTH);
    expect(icon.size).toBe(fw.ICONBIN_LENGTH);
    const o = official();
    expect(fw.equalRange(decoded, icon.offset, o, fw.ICONBIN_OFFSET, fw.ICONBIN_LENGTH)).toBe(true);
    expect(fw.readExtensionFeatures(decoded.subarray(rtos.offset, rtos.offset + rtos.size))).toEqual({ dateStamp: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.dateStamp).toBe(true);
  });

  it('all additions with the earlier test contents: test firmware 017 byte for byte', async () => {
    const b = await eng.buildFirmware(testPresetRequests(eng), testRatios(eng), [], { adjSoftFocus: true, dateStamp: true, monoUnlock: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.sha256).toBe(TEST_017_SHA256);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect({ adjSoftFocus: s.adjSoftFocus, dateStamp: s.dateStamp, monoUnlock: s.monoUnlock }).toEqual({ adjSoftFocus: true, dateStamp: true, monoUnlock: true });
    expect(s.ratios.map((r) => r.name)).toEqual(['XPan', '2.39:1', '5:4', '4:5']);
  });
});
