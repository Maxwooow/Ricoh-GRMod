// SPDX-License-Identifier: GPL-2.0-only
/**
 * Direct Flash, a fifth Flash Mode (`src/fw/aspect/directflash.ts`). Needs the official firmware in
 * testdata/private for the build tests (skipped without it). What the new code does when it runs is
 * checked in an emulator by `tools/directflash/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { DIRECTFLASH_SOURCE_SHA256 } from '../src/fw/aspect/directflash-code';
import { createHash } from 'node:crypto';
import { LANGS, allowedChars, readName } from '../src/fw/names';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('Direct Flash: data', () => {
  it('has a name in all 21 languages and a 40x40 icon like the camera\'s Flash Mode icons', () => {
    expect(aspect.DIRECT_FLASH_NAMES.length).toBe(21);
    expect(aspect.DIRECT_FLASH_NAMES[15]).toBe('直闪模式');
    expect(aspect.DIRECT_FLASH_NAMES[2]).toBe('Direct Flash');
    const icon = aspect.drawDirectFlashIcon();
    expect(icon.length).toBe(40 * 40 * 4);
    const at = (x: number, y: number): number[] => Array.from(icon.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
    expect(at(0, 0)).toEqual([255, 255, 255, 0]);
    expect(at(10, 2)).toEqual([255, 255, 255, 255]);
    expect(at(9, 2)).toEqual([0, 0, 0, 255]);
  });
  it('keeps its settings in padding next to each other, apart from soft focus and the date imprint', () => {
    expect(aspect.DIRECT_FLASH_BYTE).toBe(0x55084dd8 + 4 + 0x99b);
    expect(aspect.DIRECT_FLASH_GN_BYTE).toBe(0x55084dd8 + 4 + 0x99a);
    expect([aspect.SOFT_FOCUS_BYTE, aspect.DATESTAMP_BYTE]).not.toContain(aspect.DIRECT_FLASH_BYTE);
    expect(aspect.DIRECT_FLASH_GN_DEFAULT).toBe(3);
    expect(new Float32Array(new Uint32Array([aspect.guideNumberWord(3)]).buffer)[0]).toBeCloseTo(2 * Math.log2(3), 6);

  });
  it('the compiled module is the one of the committed source', () => {
    const src = readFileSync(new URL('../../tools/directflash/directflash.c', import.meta.url));
    expect(createHash('sha256').update(src).digest('hex')).toBe(DIRECTFLASH_SOURCE_SHA256);
  });
});

describe('Direct Flash: camera-menu settings', () => {
  it('lists at most 21 values (the list controller makes rows for the camera\'s longest list), defaults stored as 0', () => {
    const lists = aspect.directFlashLists();
    expect(lists.map((l) => l.codes.length)).toEqual([21, 15, 8, 2, 5]);
    for (const l of lists) {
      expect(l.codes.length).toBeLessThanOrEqual(21);
      expect(new Set(l.codes).size).toBe(l.codes.length);
      expect(l.codes.filter((c) => c === 0).length).toBe(1);
      expect(l.codes.every((c) => c <= l.mask)).toBe(true);
      expect(l.icons.every((i) => i.length === 40 * 40 * 4)).toBe(true);
    }
    expect(lists[0].names[lists[0].fallback][2]).toBe('GN 3');
    expect(lists[1].names[lists[1].fallback][2]).toBe('-1.0 EV');
    expect(lists[2].names[lists[2].fallback][2]).toBe('1/30');
    expect(lists[3].names[lists[3].fallback][2]).toBe('Standard');
    expect(lists[3].codes).toEqual([0, 2]);
    // Test 062: the fastest shutter speed, byte 0x109 bits 0..2: sync limit (0, the default), 1/2000 .. 1/250 (1..4).
    expect(lists[4].names[lists[4].fallback][2]).toBe('Sync Limit');
    expect(lists[4].codes).toEqual([0, 1, 2, 3, 4]);
    expect([lists[4].byte, lists[4].shift, lists[4].mask]).toEqual([aspect.DIRECT_FLASH_TV_BYTE, 0, 7]);
    expect(aspect.DIRECT_FLASH_TV_BYTE).toBe(0x55084dd8 + 4 + 0x109);
    expect(lists.every((l) => l.names.every((n) => n.length === 21))).toBe(true);
    // Byte 0x99A: bits 0..5 GN (every listed one fits), bits 6..7 the priority; byte 0x99B: bit 0 Direct
    // Flash, 1..4 background, 5..7 slowest shutter speed.
    expect([lists[0].byte, lists[0].shift, lists[0].mask, lists[3].byte, lists[3].shift, lists[3].mask]).toEqual([aspect.DIRECT_FLASH_GN_BYTE, 0, 63, aspect.DIRECT_FLASH_GN_BYTE, 6, 3]);
    expect(Math.max(...aspect.DF_GUIDE_NUMBERS)).toBeLessThan(64);
    expect([lists[1].byte, lists[1].shift, lists[1].mask, lists[2].byte, lists[2].shift, lists[2].mask]).toEqual([aspect.DIRECT_FLASH_BYTE, 1, 15, aspect.DIRECT_FLASH_BYTE, 5, 7]);
    expect(aspect.DF_SLOWEST.map((x) => x.tv)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    // The shutter line is the camera's own "Minimum Shutter Speed" (text 125).
    expect(lists.map((l) => l.title)).toEqual([911, 912, 125, 913, 965]);
    // Texts after the ratio names (901..908), icons below the ratio icons (720..).
    expect(lists[3].firstText + lists[3].codes.length - 1).toBe(959);
    expect(lists[4].firstText + lists[4].codes.length - 1).toBe(964);
    expect(aspect.DF_FASTEST_TEXT_ID).toBe(965);
    expect(lists[4].firstIcon + lists[4].codes.length - 1).toBeLessThan(720);
  });
  it.skipIf(!have)('line names fit beside the camera\'s own submenu lines, with glyphs of its own texts', () => {
    const d = new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))).decoded;
    const lines = [121, 123, 125, 226, 220, 191, 210, 196, 199, 205, 208, 201, 137, 365, 367, 371, 373, 376, 238, 242, 462, 463, 464, 465, 466, 518, 520, 392, 657, 661, 649, 655, 663, 669, 672, 675, 678, 262, 29, 30, 705, 707];
    LANGS.forEach((lang, k) => {
      const longest = Math.max(...lines.map((id) => readName(d, lang, id).text.length));
      const allowed = allowedChars(d, lang);
      for (const names of [aspect.DF_MENU_NAMES, aspect.DF_GN_NAMES, aspect.DF_BACKGROUND_NAMES, aspect.DF_PRIORITY_NAMES, aspect.DF_FASTEST_NAMES]) {
        expect(names.length).toBe(21);
        expect(names[k].length, `${lang} ${names[k]}`).toBeLessThanOrEqual(longest);
        // 背 / 景 are not among the camera's own Chinese / Japanese texts, but in its fonts (RT_CN_S,
        // RT_CN_T, RT_JP: full character sets, as for the date imprint's 戳, 样 and 向).
        const cjk = lang === 'ja' || lang === 'zh-CN' || lang === 'zh-TW';
        const missing = [...names[k]].filter((c) => !allowed.has(c.charCodeAt(0)) && !(cjk && '背景'.includes(c))).join('');
        expect(missing, `${lang} ${names[k]}`).toBe('');
      }
      for (const l of aspect.directFlashLists()) {
        const missing = [...l.names.map((n) => n[k]).join('')].filter((c) => !allowed.has(c.charCodeAt(0))).join('');
        expect(missing, `${lang} values`).toBe('');
      }
    });
  });
});

describe.skipIf(!have)('Direct Flash: firmware files', () => {
  let eng: Engine;
  it('builds a file with Direct Flash only; the engine recognises and verifies it', async () => {
    eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { directFlash: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, guard: true, directFlash: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.directFlash).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    expect(fw.readExtensionFeatures(d.subarray(rtos.offset, rtos.offset + rtos.size))).toEqual({ guard: true, directFlash: true });
  });
  it('combines with soft focus, the date imprint and ratios (the date imprint copies the list table after it)', async () => {
    const b = await eng.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }], [], { directFlash: true, adjSoftFocus: true, dateStamp: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.directFlash && s.adjSoftFocus && s.dateStamp).toBe(true);
    // The relocated list table's Flash Mode records (11, 12) carry the Direct Flash count handlers.
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const img = d.subarray(rtos.offset, rtos.offset + rtos.size);
    const word = (va: number): number => new DataView(img.buffer, img.byteOffset).getUint32(va - 0x53000000, true);
    const movwt = (lo: number, hi: number): number => {
      const a = word(lo); const b = word(hi);
      return ((((b >> 4) & 0xf000) | (b & 0xfff)) << 16 | (((a >> 4) & 0xf000) | (a & 0xfff))) >>> 0;
    };
    const table = movwt(0x531d6868, 0x531d6878); // the list table's address (one of its 16 users)
    expect(table).toBeGreaterThan(0x53000000 + aspect.OFFICIAL_RTOS_LENGTH);
    for (const [rec, n] of [[11, 4], [12, 2]] as const) {
      const count = word(table + rec * 0x4c + 0x0c);
      expect(count).toBeGreaterThan(0x53000000 + aspect.OFFICIAL_RTOS_LENGTH);
      expect(word(count)).toBe((0xe3a00000 | n) >>> 0); // mov r0, #n
      expect(word(count + 4)).toBe(0xe2800001); // add r0, r0, #1
    }
  });
});
