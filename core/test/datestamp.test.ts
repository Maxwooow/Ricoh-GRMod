// SPDX-License-Identifier: GPL-2.0-only
/**
 * Date imprint and its camera-menu entry (`src/fw/aspect/datestamp.ts`, `datestamp-menu.ts`).
 * Needs the official firmware in testdata/private for the build tests (skipped without it). What
 * the new code does when it runs is checked in an emulator by `tools/datestamp/menu_check.py`
 * (menu), `tools/datestamp/render_check.py` (imprint) and `tools/datestamp/orient_check.py` (imprint
 * on photos taken with the camera held upright or upside down; unchanged for level shots).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { LANGS, allowedChars, readName } from '../src/fw/names';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('date imprint menu: data', () => {
  it('two 40x40 style icons on the menu tile', () => {
    for (const long of [false, true]) {
      const icon = aspect.drawStyleIcon(long);
      expect(icon.length).toBe(40 * 40 * 4);
      const at = (x: number, y: number): number[] => Array.from(icon.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
      expect(at(0, 0)).toEqual([255, 255, 255, 0]);
      expect(at(1, 5)).toEqual([128, 128, 128, 255]);
      expect(at(3, 3)).toEqual([53, 53, 54, 255]);
      let orange = 0;
      for (let i = 0; i < 1600; i++) if (icon[i * 4] === 255 && icon[i * 4 + 1] === 128) orange++;
      expect(orange).toBeGreaterThan(100);
    }
    expect(aspect.drawStyleIcon(false)).not.toEqual(aspect.drawStyleIcon(true));
  });
  it('setting bits', () => {
    expect(aspect.DATESTAMP_ON).toBe(1);
    expect(aspect.DATESTAMP_LONG).toBe(2);
    // 0.8.3: "Follow Orientation" off; earlier bytes (0..3) read as On.
    expect(aspect.DATESTAMP_AS_STORED).toBe(4);
    expect(aspect.DATESTAMP_ORIENT_NAMES.length).toBe(21);
    expect(aspect.DATESTAMP_TEXT_IDS.orient).toBe(879);
    expect(aspect.DATESTAMP_ORIENT_ID).toBe(0x020001a5);
  });
});

describe('date imprint with the look\'s name (0.8.4): data', () => {
  it('setting bit, texts and icons', () => {
    expect(aspect.DATESTAMP_NAME).toBe(8);
    expect([aspect.DATESTAMP_TEXT_IDS.shortName, aspect.DATESTAMP_TEXT_IDS.longName]).toEqual([880, 881]);
    expect([aspect.DATESTAMP_ICON_IDS.shortName, aspect.DATESTAMP_ICON_IDS.longName]).toEqual([731, 732]);
    expect(aspect.DATESTAMP_NAME_WORDS.length).toBe(21);
    // As long as the camera's own longer list values ("Snap Distance Priority AE", 25).
    for (const t of aspect.datestampNameTexts('2026.10.08 17:34')) expect(t.length).toBeLessThanOrEqual(25);
    const icons = [aspect.drawStyleIcon(false), aspect.drawStyleIcon(true), aspect.drawStyleIcon(false, true), aspect.drawStyleIcon(true, true)];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(icons[i]).not.toEqual(icons[j]);
  });
  it('every Style value fits its (widened) label in the Chinese font, with 10% to spare', () => {
    // Measured on the camera (test 051, Chinese): the menu font is fixed-pitch, digits, Latin
    // letters, space and marks take one cell, CJK characters two; the native label (400 px) holds
    // 20.7 cells, so a cell is 19.3 px. From test 052 the Style list's labels end 20 px before the
    // row's right edge, at most at x 680 (datestamp-menu.ts): at least 560 px for rows 680 px wide.
    // (The fonts of the other languages are not in the firmware; checked here by the same cell
    // model, provisionally, until the camera shows them.)
    const CELL = 400 / 20.7;
    const budget = Math.floor((560 / CELL) * 0.9);
    const cells = (t: string): number => [...t].reduce((n, c) => n + (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(c) ? 2 : /[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/.test(c) ? 0 : 1), 0);
    for (const date of ["'26 10 08", '2026.10.08 17:34']) {
      aspect.datestampNameTexts(date).forEach((t, k) => expect(cells(t), `${t} (${k})`).toBeLessThanOrEqual(budget));
    }
    // the case that was cut in test 051 needed 23 cells in a 20.7-cell label
    expect(cells('2026.10.08 17:34 + 名称')).toBe(23);
    expect(budget).toBeGreaterThanOrEqual(26);
  });
  it('names become fourteen-segment capitals; digits stay seven-segment', () => {
    const L = (c: string): number => 0x4000 | aspect.LETTER_SEGMENTS[c];
    expect(aspect.lookNameGlyphs('FilmV+')).toEqual([L('F'), L('I'), L('L'), L('M'), L('V'), L('+')]);
    expect(aspect.lookNameGlyphs('GR Mod 12')).toEqual([L('G'), L('R'), 17, L('M'), L('O'), L('D'), 17, 1, 2]);
    expect(aspect.lookNameGlyphs('  Hi-Contrast B&W ')).toEqual([...[...'HI-CONTRAST'].map(L), 17, L('B'), L('&'), L('W')]);
    expect(aspect.lookNameGlyphs('A\u00e9\u4e2dB')).toEqual([L('A'), 17, L('B')]); // no shape: one space
    expect(aspect.lookNameGlyphs('x'.repeat(40)).length).toBe(aspect.LOOK_NAME_MAX);
    for (const name of Object.values(aspect.FACTORY_LOOK_NAMES)) expect(aspect.lookNameGlyphs(name).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!have)('date imprint: firmware files', () => {
  it('0.8.4: the look names in the module\'s table, the look at the start of the exposure', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const extra = (name: string) => ({ name, matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [0, 1, 2].map(() => Array.from({ length: 256 }, (_, i) => i * 16)) as [number[], number[], number[]], icon: new Uint8Array(40 * 40 * 4) });
    const b = await eng.buildFirmware([{ slot: 'CY', names: { 'zh-CN': 'FilmV+' } }], [], [], { dateStamp: true, extraSlots: [extra('GR Mod 1'), extra('Kodak 200')] });
    expect((await eng.inspect(b.file)).verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    const word = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint32(va - 0x53000000, true);
    const half = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint16(va - 0x53000000, true);
    // The JPEG step's stub loads the context with movw / movt; its words 10 and 11: FRAME_LOOK, the table.
    const stub = 0x537034b4 + 8 + (((word(0x537034b4) & 0xffffff) << 8) >> 6);
    const imm = (w: number): number => ((w >> 4) & 0xf000) | (w & 0xfff);
    const ctx = (imm(word(stub + 8)) | (imm(word(stub + 12)) << 16)) >>> 0;
    expect(word(ctx + 40)).toBe(0x558372f8);
    const table = word(ctx + 44);
    const name = (style: number): number[] => { const r = word(table + style * 4); return r ? Array.from({ length: half(r) }, (_, i) => half(r + 2 + 2 * i)) : []; };
    expect(name(17)).toEqual(aspect.lookNameGlyphs('Positive Film'));
    expect(name(18)).toEqual(aspect.lookNameGlyphs('FilmV+'));
    expect(name(19)).toEqual(aspect.lookNameGlyphs('Cinema (Green)'));
    expect(name(34)).toEqual(aspect.lookNameGlyphs('GR Mod 1'));
    expect(name(35)).toEqual(aspect.lookNameGlyphs('Kodak 200'));
    expect(name(36)).toEqual([]);
    // The exposure hook copies LOOK_STASH (0x558372e4) to FRAME_LOOK first.
    const target = (at: number): number => at + 8 + (((word(at) & 0xffffff) << 8) >> 6);
    const exposure = Array.from({ length: 8 }, (_, i) => word(target(0x53628cd8) + 4 * i));
    expect([1, 2, 4, 5].map((i) => imm(exposure[i]))).toEqual([0x72e4, 0x5583, 0x72f8, 0x5583]);
  });

  it('builds a file with the imprint and its menu entry; the engine recognises and verifies it', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { dateStamp: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, dateStamp: true, guard: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    expect(fw.readExtensionFeatures(data)).toEqual({ dateStamp: true, guard: true });
    const word = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint32(va - 0x53000000, true);
    // The hooks: still-menu builder, controller factory, the two SetCurrentMenu.
    for (const at of [0x531b3ecc, 0x53185f7c, 0x531e1bd0, 0x531d5e8c, 0x537034b4]) expect(word(at) >>> 24).toBe(0xea);
    // 0.8.3: the camera's direction at the start of each exposure (SetShootingInfoResultBeforeExpose)
    // and, in RAW development, the developed record's orientation go to ORIENT_WORD.
    const target = (at: number): number => at + 8 + (((word(at) & 0xffffff) << 8) >> 6);
    expect(word(0x53628cd8) >>> 24).toBe(0xea);
    const exposure = Array.from({ length: 40 }, (_, i) => word(target(0x53628cd8) + 4 * i));
    expect(exposure).toContain(0xe5900518); // ldr r0, [r0, #0x518]
    expect(exposure).toContain(0xe5d000d8); // ldrb r0, [r0, #0xd8]
    expect(exposure).toContain(0xe1a0c00d); // mov ip, sp (after the registers are back)
    expect(word(0x539113f8) >>> 24).toBe(0xea);
    const dev = Array.from({ length: 40 }, (_, i) => word(target(0x539113f8) + 4 * i));
    expect(dev.slice(0, 5)).toEqual([0xe59122d0, 0xe92d0003, 0xe5d102ac, 0xe3500000, 0x1a00000a]); // only when r1 + 0x2ac is 0
    expect(dev).not.toContain(0xe1800c02); // the look word has no orientation bits any more
    expect([aspect.ORIENT_WORD, aspect.ORIENT_VALID]).toEqual([0x558372f4, 0x100]);
  });
  it('"Follow Orientation" names fit beside the camera\'s own submenu lines; glyphs not among its texts are only the listed CJK ones', () => {
    const d = new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))).decoded;
    // Line texts of the camera's own submenus (ISO, Bracketing, ..., Reset).
    const lines = [121, 123, 125, 226, 220, 191, 210, 196, 199, 205, 208, 201, 137, 365, 367, 371, 373, 376, 238, 242, 462, 463, 464, 465, 466, 518, 520, 392, 657, 661, 649, 655, 663, 669, 672, 675, 678, 262, 29, 30, 705, 707];
    LANGS.forEach((lang, k) => {
      const name = aspect.DATESTAMP_ORIENT_NAMES[k];
      const longest = Math.max(...lines.map((id) => readName(d, lang, id).text.length));
      expect(name.length, lang).toBeLessThanOrEqual(longest);
      const allowed = allowedChars(d, lang);
      const missing = [...name].filter((c) => !allowed.has(c.charCodeAt(0))).join('');
      expect(missing, lang).toBe({ ja: '向', 'zh-CN': '跟随向', 'zh-TW': '跟隨向' }[lang as string] ?? '');
    });
  });
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
