// SPDX-License-Identifier: GPL-2.0-only
/**
 * Date imprint and its camera-menu entry (`src/fw/aspect/datestamp.ts`, `datestamp-menu.ts`).
 * Needs the official firmware in testdata/private for the build tests (skipped without it). What
 * the new code does when it runs is checked in an emulator by `tools/datestamp/menu_check.py`
 * (menu) and `tools/datestamp/render_check.py` (imprint).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('date imprint menu: data', () => {
  it('four distinct 40x40 style icons on the menu tile', () => {
    for (const style of [0, 1, 2, 3]) {
      const icon = aspect.drawStyleIcon(style);
      expect(icon.length).toBe(40 * 40 * 4);
      const at = (x: number, y: number): number[] => Array.from(icon.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
      expect(at(0, 0)).toEqual([255, 255, 255, 0]);
      expect(at(1, 5)).toEqual([128, 128, 128, 255]);
      expect(at(3, 3)).toEqual([53, 53, 54, 255]);
      let orange = 0;
      for (let i = 0; i < 1600; i++) if (icon[i * 4] === 255 && icon[i * 4 + 1] === 128) orange++;
      expect(orange).toBeGreaterThan(100);
    }
    expect(aspect.drawStyleIcon(false)).toEqual(aspect.drawStyleIcon(0));
    expect(aspect.drawStyleIcon(true)).toEqual(aspect.drawStyleIcon(1));
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) expect(aspect.drawStyleIcon(a)).not.toEqual(aspect.drawStyleIcon(b));
  });
  it('keeps LUT style texts outside the shutdown picture name range', () => {
    const usedByShutdown = Array.from({ length: 3 + aspect.SHUTDOWN_MAX_PICTURES }, (_, i) => aspect.SHUTDOWN_TEXT_ID + i);
    expect(usedByShutdown).not.toContain(aspect.DATESTAMP_TEXT_IDS.shortLut);
    expect(usedByShutdown).not.toContain(aspect.DATESTAMP_TEXT_IDS.slashLut);
    expect(aspect.DATESTAMP_TEXT_IDS.slashLut).toBeLessThan(896);
  });
  it('validates independent watermark names for factory and added looks', () => {
    expect(() => aspect.validateWatermarkNames({ 11: 'My Standard', 30: 'Mono HDR', 34: 'Gold 200' }, 1)).not.toThrow();
    for (const names of [{ 11: '' }, { 11: '中文' }, { 11: ' x' }, { 11: 'A'.repeat(33) }, { 31: 'Unknown' }, { 35: 'Absent slot' }]) {
      expect(() => aspect.validateWatermarkNames(names, 1)).toThrow();
    }
  });
  it('setting bits', () => {
    expect(aspect.DATESTAMP_ON).toBe(1);
    expect(aspect.DATESTAMP_LONG).toBe(2);
  });
});

describe.skipIf(!have)('date imprint: firmware files', () => {
  it('builds a file with the imprint and its menu entry; the engine recognises and verifies it', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { dateStamp: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, dateStamp: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    expect(fw.readExtensionFeatures(data)).toEqual({ dateStamp: true });
    const word = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint32(va - 0x53000000, true);
    // The hooks: still-menu builder, controller factory, the two SetCurrentMenu.
    for (const at of [0x531b3ecc, 0x53185f7c, 0x531e1bd0, 0x531d5e8c, 0x537034b4]) expect(word(at) >>> 24).toBe(0xea);
  });
  it('embeds configured LUT names by frame style and preserves renamed Cinema labels on inspection', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const curve = Array.from({ length: 256 }, (_, i) => i * 64);
    const b = await eng.buildFirmware([{ slot: 'CY', names: { en: 'Gold200' } }], [], [], {
      dateStamp: true,
      watermarkNames: { 11: 'My Standard', 18: 'Kodak Gold 200', 30: 'Custom Mono', 34: 'Portra 400' },
      extraSlots: [{ name: 'Kodak Gold', matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [curve, curve, curve], icon: new Uint8Array(6400), halation: true }],
    });
    const d = new fw.Firmware(b.file).decoded;
    const section = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(section.offset, section.offset + section.size);
    const names = aspect.readWatermarkNames(data, 1);
    expect(names?.[11]).toBe('My Standard');
    expect(names?.[18]).toBe('Kodak Gold 200');
    expect(names?.[30]).toBe('Custom Mono');
    expect(names?.[34]).toBe('Portra 400');
    const summary = await eng.inspect(b.file);
    expect(summary.verified).toBe(true);
    expect(summary.slots.find((slot) => slot.id === 'CY')?.names.en).toBe('Gold200');
    expect(summary.extraSlots[0].name).toBe('Kodak Gold');
  }, 120_000);
  it('a test build with a fixed setting has no menu entry', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { adjSoftFocus: true, dateStamp: true, dateStampFixed: 3 });
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    const word = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint32(va - 0x53000000, true);
    expect(word(0x531b3ecc)).toBe(0xe1a0c00d);
    expect(word(0x537034b4) >>> 24).toBe(0xea);
  });
});
