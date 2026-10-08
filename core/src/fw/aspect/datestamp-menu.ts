// SPDX-License-Identifier: GPL-2.0-only
/**
 * The camera-menu entry of the date imprint (firmware 1.11): a line "Date Imprint" on the
 * Shooting Assist page of the still shooting menu, after Horizon Correction. It opens a small
 * submenu like D-Range Correction's with two lines, each a list of two values:
 *
 *   On/Off   Off / On
 *   Style    '26 10 08 / 2026.10.08 17:34
 *
 * Both are kept in the setting byte of `datestamp.ts` (byte 0x94B of the user settings): bit 0 on,
 * bit 1 the long style. The menu treats any other value (the byte is padding the official firmware
 * never sets) as 0 and writes 0 back the first time it reads it, so lists always have exactly one
 * current value.
 *
 * What is changed, all found by reading the official 1.11 code:
 *
 *  - Still shooting menu. The menu tabs are built once by TopMenuController (0x531B3ECC) from five
 *    static descriptors (0x38C bytes) listed at 0x55001E78. A descriptor holds the page titles and
 *    first items, the item count (byte 0x8B), and per item (at most 38) a draw function (+0x8C),
 *    the controller id opened by OK (+0x1BC) and a visibility function (+0x254). The still menu
 *    already has 38 items. Two of them are model-specific and never both visible: HDF (item 22,
 *    only on the GR IV HDF) and Red Filter (item 23, only on the GR IV Monochrome). So two copies
 *    of the descriptor are appended, one without Red Filter and one without HDF, each with the new
 *    item at the end of the last page; on entry, the builder stores the one for the camera's model
 *    (SpecModel, 0 GR IV, 1 HDF, 2 Monochrome) at 0x55001E78. Every model sees exactly the
 *    official menu plus the new line. The builder is the only reader of that table.
 *  - Controller ids. The new line opens controller 0x020001A0 (the submenu), whose lines open
 *    0x020001A1 and 0x020001A2 (the lists); the firmware does not use these ids. The controller
 *    factory (0x53185F7C, the only place a controller is looked up by id) hands out the submenu
 *    controller for the first and the list controller for the other two, as for D-Range
 *    Correction (0x020000D0) and Horizon Correction (0x02000094).
 *  - Submenu (SubMenuController). Its records (0x64 bytes, title, line count, line texts, line
 *    controller ids, value-draw functions) are in a table of 18 at 0x53DA6718 addressed from 5
 *    places; the table is copied to the appended area with one more record (number 19; 18 is the
 *    value the constructor starts with and stays what it was), and SetCurrentMenu (0x531E1BD0) maps
 *    the new id to it.
 *  - Lists (SelectMenuController). Records of 0x4C bytes (title, then member-function pointers:
 *    value count +0x0C, draw value i +0x14, set value i +0x24, is value i current +0x2C) in a table
 *    of 124 at 0x53DA2D20 addressed from 16 places; copied with two more records (125, 126; 124 is
 *    the constructor's start value), the model being Horizon Correction's record. SetCurrentMenu
 *    (0x531D5E8C) maps the new ids to them. The constructor also scans the table up to its end
 *    (pool word 0x531D6DAC) for the longest list; that end moves with the table (and still ends
 *    after the 124 official records).
 *  - Texts 841..845 in all 21 languages (relocated text catalog, see `build.ts`): the line name,
 *    "On/Off", "Style" and the two style names. Off and On are the camera's texts 2 and 1.
 *  - Icons: the camera's OFF / ON (310, 311) and two new 40x40 icons for the styles, numbers 721
 *    and 722 (the ratio icon numbers of identities 5 and 6, never given out; the lookup bound stays
 *    within what added ratios use).
 */
import { FirmwareError } from '../types';
import { assembleWords, movImmediate, movWord } from './arm';
import {
  ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, NATIVE_TEXT_ROOTS, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z,
} from './build';
import { DATESTAMP_BYTE } from './datestamp';

/** Controller ids of the submenu and of its two lists. */
export const DATESTAMP_MENU_ID = 0x020001a0;
export const DATESTAMP_SWITCH_ID = 0x020001a1;
export const DATESTAMP_STYLE_ID = 0x020001a2;

/** Texts: line / submenu name, the two line names, the two style names. */
export const DATESTAMP_TEXT_IDS = { name: 841, onOff: 842, style: 843, short: 844, long: 845 } as const;
/** Icons of the two styles. */
export const DATESTAMP_ICON_IDS = { short: 721, long: 722 } as const;
const ICON_OFF = 310;
const ICON_ON = 311;
const TEXT_OFF = 2;
const TEXT_ON = 1;

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const DATESTAMP_NAMES: readonly string[] = [
  'Vkopírování data', 'Datostempel', 'Date Imprint', 'Päiväysleima', 'Impression date', 'Datumseinbelichtung', 'Αποτύπωση ημ/νίας',
  'Dátumbélyegző', 'Stampa data', '日付写し込み', '날짜 각인', 'Datumafdruk', 'Nadruk daty', 'Impressão de data',
  'Впечатывание даты', '拍摄时间戳', 'Impresión de fecha', 'Datumstämpel', 'ประทับวันที่', '拍攝時間戳', 'Tarih baskısı',
];
export const DATESTAMP_ON_OFF_NAMES: readonly string[] = [
  'Zapnuto/Vypnuto', 'Til/Fra', 'On/Off', 'Päällä/Pois', 'Marche/Arrêt', 'An/Aus', 'On/Off',
  'Be/Ki', 'On/Off', 'オン/オフ', '켜짐/꺼짐', 'Aan/Uit', 'Wł./Wył.', 'Ligar/Desligar',
  'Вкл./Выкл.', '开关', 'On/Off', 'På/Av', 'เปิด/ปิด', '開關', 'Açık/Kapalı',
];
export const DATESTAMP_STYLE_NAMES: readonly string[] = [
  'Styl', 'Stil', 'Style', 'Tyyli', 'Style', 'Stil', 'Στυλ',
  'Stílus', 'Stile', 'スタイル', '스타일', 'Stijl', 'Styl', 'Estilo',
  'Стиль', '样式', 'Estilo', 'Stil', 'รูปแบบ', '樣式', 'Stil',
];
export const DATESTAMP_SHORT_TEXT = "'26 10 08";
export const DATESTAMP_LONG_TEXT = '2026.10.08 17:34';

// --- Official addresses (checked before use).
const BUILDER = 0x531b3ecc;
const MENU_TABLE = 0x55001e78;
const STILL_MENU = 0x53d9cdb0;
const DESCRIPTOR = 0x38c;
const MAX_ITEMS = 38;
const D_PAGES = 0x68;
const D_FIRST = 0x80;
const D_COUNT = 0x8b;
const D_DRAW = 0x8c;
const D_ID = 0x1bc;
const D_VISIBLE = 0x254;
const HDF_ITEM = 22;
const RED_FILTER_ITEM = 23;
const FACTORY = 0x53185f7c;
const SUB_SET_CURRENT = 0x531e1bd0;
const SELECT_SET_CURRENT = 0x531d5e8c;
const SUB_TABLE = 0x53da6718;
const SUB_RECORD = 0x64;
const SUB_RECORDS = 18;
const SUB_SITES: readonly (readonly [number, number, number])[] = [
  [0x531e2064, 0x531e206c, 3], [0x531e20cc, 0x531e20d4, 2], [0x531e2438, 0x531e2444, 8], [0x531e2668, 0x531e266c, 5], [0x531e2734, 0x531e2740, 3],
];
const SELECT_TABLE = 0x53da2d20;
const SELECT_RECORD = 0x4c;
const SELECT_RECORDS = 124;
const SELECT_SITES: readonly (readonly [number, number, number])[] = [
  [0x531d6868, 0x531d6878, 6], [0x531d6a08, 0x531d6a0c, 3], [0x531d6a54, 0x531d6a5c, 7], [0x531d6b10, 0x531d6b18, 3],
  [0x531d6b7c, 0x531d6b80, 3], [0x531d6d54, 0x531d6d64, 4], [0x531d6e80, 0x531d6e88, 3], [0x531d7040, 0x531d7048, 3],
  [0x531d712c, 0x531d7130, 4], [0x531d71e0, 0x531d71ec, 3], [0x531d7304, 0x531d730c, 3], [0x531d7428, 0x531d7430, 3],
  [0x531d75ac, 0x531d75b4, 3], [0x531da960, 0x531da964, 3], [0x531daa24, 0x531daa2c, 8], [0x531dadc8, 0x531dadcc, 3],
];
/**
 * The list constructor (0x531DB348 -> 0x531D6D4C) walks all records from the table start (one of the
 * 16 sites) to the table end, a pool word loaded at 0x531D6D58, for the largest value count.
 */
const SELECT_TABLE_END_LOAD = 0x531d6d58;
const SELECT_TABLE_END_LITERAL = 0x531d6dac;
/** D-Range Correction: its submenu record and controller id; Horizon Correction: its list record and id. */
const D_RANGE_RECORD = 6;
const D_RANGE_ID = 0x020000d0;
const HORIZON_RECORD = 45;
const HORIZON_ID = 0x02000094;
/** Record numbers of the additions. */
export const SUB_RECORD_NUMBER = SUB_RECORDS + 1;
export const SWITCH_RECORD_NUMBER = SELECT_RECORDS + 1;
export const STYLE_RECORD_NUMBER = SELECT_RECORDS + 2;

// Functions the handlers call.
const APP = 0x5323ea84; // application singleton
const SPEC_MODEL = 0x5323ff28; // (app) -> SpecModel
const MODEL_NUMBER = 0x533e0330; // (SpecModel) -> 0 GR IV, 1 HDF, 2 Monochrome
const TOP_SET_TWO_ICONS = 0x5357a510; // (menu line, icon, icon)
const TOP_SET_TITLE = 0x5357a1c0; // (menu line, text)
const SUB_SET_ICON = 0x53583188; // (submenu line, icon)
const LIST_SET_ITEM = 0x5357aef0; // (list item, icon, text)

const TABLE_STRIDE = 0xd14;
const FIRST_TABLE_RAM = 0x55000000 + (0x5437d7b0 - 0x5437b640);

export const STYLE_ICON_W = 40;
export const STYLE_ICON_H = 40;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
function lo(v: number): number {
  return v & 0xffff;
}
function hi(v: number): number {
  return v >>> 16;
}
function branchWord(at: number, target: number): number {
  const offset = (target - (at + 8)) >> 2;
  if (offset < -0x800000 || offset > 0x7fffff) fail('internal', 'branch out of range');
  return (0xea000000 | (offset & 0xffffff)) >>> 0;
}

// --------------------------------------------------------------------------------------------
// Icons

/** Seven segments (a..g = bits 0..6) of a digit. */
const SEGMENTS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

/**
 * A 40x40 style icon: the tile of the camera's menu icons (grey border, dark fill) with two rows of
 * orange seven-segment digits, pixel-aligned (6 x 11, bars 2 px): "'26" over "10 08" (short),
 * "2026" over "17:34" (long).
 */
export function drawStyleIcon(long: boolean): Uint8Array {
  const W = STYLE_ICON_W;
  const H = STYLE_ICON_H;
  const px = new Uint8Array(W * H * 4);
  const BORDER = [128, 128, 128];
  const BG = [53, 53, 54];
  const INK = [255, 128, 32];
  const rows = long ? ['2026', '17:34'] : ["'26", '10 08'];
  const dw = 6;
  const gap = 2;
  // Rectangles [x0, y0, x1, y1] (inclusive) of segments a..g.
  const SEG: readonly (readonly number[])[] = [[0, 0, 5, 1], [4, 0, 5, 5], [4, 4, 5, 10], [0, 9, 5, 10], [0, 4, 1, 10], [0, 0, 1, 5], [0, 4, 5, 5]];
  const shapes = (c: string): readonly (readonly number[])[] => {
    if (c === "'") return [[0, 0, 1, 3]];
    if (c === ':') return [[0, 2, 1, 3], [0, 7, 1, 8]];
    if (c === ' ') return [];
    if (!/^[0-9]$/.test(c)) fail('internal', 'icon glyph');
    const bits = SEGMENTS[Number(c)];
    return SEG.filter((_, k) => (bits & (1 << k)) !== 0);
  };
  const advance = (c: string): number => (c === ' ' ? 2 : c === ':' || c === "'" ? 2 : dw);
  const ink = new Uint8Array(W * H);
  rows.forEach((text, rowIndex) => {
    const chars = [...text];
    const width = chars.reduce((n, c) => n + advance(c), 0) + gap * (chars.length - 1);
    let x = Math.floor((W - width) / 2);
    const y = rowIndex === 0 ? 7 : 22;
    for (const c of chars) {
      for (const [x0, y0, x1, y1] of shapes(c)) {
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) ink[(y + yy) * W + x + xx] = 1;
      }
      x += advance(c) + gap;
    }
  });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (x < 1 || y < 1 || x > 38 || y > 38) {
        px.set([255, 255, 255, 0], i);
        continue;
      }
      if (x === 1 || y === 1 || x === 38 || y === 38) {
        px.set([...BORDER, 255], i);
        continue;
      }
      px.set([...(ink[y * W + x] ? INK : BG), 255], i);
    }
  }
  return px;
}

// --------------------------------------------------------------------------------------------
// Texts

function installTexts(patch: Patch, entries: readonly { id: number; names: readonly string[] }[]): void {
  const roots = new DataView(patch.readMapped(NATIVE_TEXT_ROOTS, LANGUAGES * 4).buffer);
  const order: number[] = [];
  const seen = new Set<number>();
  for (let l = 0; l < LANGUAGES; l++) {
    // Root l (as the program indexes languages) is table k (in `LANGS` order), 4 bytes before it.
    const k = (roots.getUint32(l * 4, true) + 4 - FIRST_TABLE_RAM) / TABLE_STRIDE;
    if (!(Number.isInteger(k) && k >= 0 && k < LANGUAGES) || seen.has(k)) fail('unexpected-layout', 'language tables are not where they were expected');
    seen.add(k);
    order.push(k);
  }
  let upper = 0;
  for (const { id, names } of entries) {
    if (names.length !== LANGUAGES) fail('internal', 'a text needs all 21 languages');
    const descriptors = names.map((text) => {
      const encoded = utf16z(text);
      const units = encoded.length / 2;
      if (!(units > 1 && units < 256) || text.includes('\n')) fail('internal', 'bad menu text');
      const address = patch.append(encoded, 4);
      // {u8 units including the terminator, u8 lines = 1, u16 0, u32 text address}
      return patch.append(concat([Uint8Array.from([units, 1, 0, 0]), u32le([address])]), 4);
    });
    for (let l = 0; l < LANGUAGES; l++) {
      const row = patch.word(TEXT_CATALOG + l * 4);
      if (patch.word(row + id * 4) !== 0) fail('unexpected-layout', 'text number already in use');
      patch.write(row + id * 4, u32le([descriptors[order[l]]]));
    }
    upper = Math.max(upper, id);
  }
  for (const site of patch.textBoundSites) patch.setWord(site, movWord(3, Math.max(upper, movImmediate(patch.word(site)))), 'text upper bound');
}

function installIcons(patch: Patch, iconbin: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  let upper = 0;
  for (const [id, long] of [[DATESTAMP_ICON_IDS.short, false], [DATESTAMP_ICON_IDS.long, true]] as const) {
    if (patch.word(ICON_CATALOG + id * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const offset = length;
    const icon = drawStyleIcon(long);
    parts.push(icon);
    length += icon.length;
    // {u16 kind = 1, u16 width, u16 height, u16 flags = 0, u32 offset in 4-byte units}
    const descriptor = patch.append(concat([u16le([1, STYLE_ICON_W, STYLE_ICON_H, 0]), u32le([offset / 4])]), 16);
    patch.write(ICON_CATALOG + id * 4, u32le([descriptor]));
    upper = Math.max(upper, id);
  }
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(upper, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat(parts);
}

// --------------------------------------------------------------------------------------------

/** Load the setting byte into r3 (r2 = its address); anything above 3 becomes (and is stored as) 0. */
const LOAD_SETTING = `movw r2, #${lo(DATESTAMP_BYTE)}; movt r2, #${hi(DATESTAMP_BYTE)}; ldrb r3, [r2]
  cmp r3, #3; movhi r3, #0; strbhi r3, [r2]`;

function relocateTable(patch: Patch, table: number, record: number, copyRecords: number, added: readonly Uint8Array[], sites: readonly (readonly [number, number, number])[], what: string): number {
  for (const [low, high, r] of sites) {
    expectWord(patch, low, movWord(r, lo(table)));
    expectWord(patch, high, movWord(r, hi(table), true));
  }
  const bytes = concat([patch.read(table, copyRecords * record), ...added]);
  const moved = patch.append(bytes, 16);
  for (const [low, high, r] of sites) {
    patch.setWord(low, movWord(r, lo(moved)), `${what}, low half`);
    patch.setWord(high, movWord(r, hi(moved), true), `${what}, high half`);
  }
  return moved;
}

/**
 * Install the menu entry. `patch` must already hold the scaffold of `build.ts` (relocated
 * catalogs) and the imprint itself. Returns the ICONBIN data with the two style icons appended.
 */
export function installDateStampMenu(patch: Patch, iconbin: Uint8Array): Uint8Array {
  // --- Checks of the official code and data this relies on.
  expectWord(patch, BUILDER, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, BUILDER + 4, movWord(3, lo(MENU_TABLE)));
  expectWord(patch, BUILDER + 0x10, movWord(3, hi(MENU_TABLE), true));
  if (new DataView(patch.readMapped(MENU_TABLE, 4).buffer).getUint32(0, true) !== STILL_MENU) fail('unexpected-layout', 'still menu descriptor is not where it was expected');
  expectWord(patch, FACTORY, movWord(3, 0x12e));
  expectWord(patch, FACTORY + 4, 0xe1a0c00d);
  expectWord(patch, SUB_SET_CURRENT, 0xe28134fe); // add r3, r1, #0xfe000000
  expectWord(patch, SELECT_SET_CURRENT, 0xe28134fe);
  expectWord(patch, 0x531e2a10, 0xe3a02012); // the submenu constructor starts at record 18
  expectWord(patch, 0x531db2c4, 0xe3a0e07c); // the list constructor starts at record 124
  for (const f of [APP, SPEC_MODEL, TOP_SET_TWO_ICONS, TOP_SET_TITLE, SUB_SET_ICON, LIST_SET_ITEM]) expectWord(patch, f, 0xe1a0c00d);
  expectWord(patch, MODEL_NUMBER, 0xe5903000); // ldr r3, [r0]
  expectWord(patch, MODEL_NUMBER + 4, 0xe5930004); // ldr r0, [r3, #4]

  const still = patch.read(STILL_MENU, DESCRIPTOR);
  const dv = new DataView(still.buffer);
  const firsts = [...still.subarray(D_FIRST, D_FIRST + 6)];
  if (still[D_PAGES] !== 6 || firsts.join() !== '0,10,18,24,30,35' || still[D_COUNT] !== MAX_ITEMS) fail('unexpected-layout', 'still menu pages are not the official ones');
  const id = (i: number): number => dv.getUint32(D_ID + i * 4, true);
  const visible = (i: number): number => dv.getUint32(D_VISIBLE + i * 8, true);
  if (id(HDF_ITEM) !== 0x02000133 || id(RED_FILTER_ITEM) !== 0x02000135 || visible(HDF_ITEM) !== 0x531afbe4 || visible(RED_FILTER_ITEM) !== 0x531afc0c) {
    fail('unexpected-layout', 'HDF and Red Filter items are not the official ones');
  }
  if (id(35) !== 0x02000092 || id(36) !== 0x02000093 || id(37) !== 0x02000094) fail('unexpected-layout', 'Shooting Assist items are not the official ones');
  for (let i = 0; i < MAX_ITEMS; i++) if (id(i) === DATESTAMP_MENU_ID || id(i) === DATESTAMP_SWITCH_ID || id(i) === DATESTAMP_STYLE_ID) fail('unexpected-layout', 'controller id already in use');

  const subTemplate = patch.read(SUB_TABLE + D_RANGE_RECORD * SUB_RECORD, SUB_RECORD);
  const sv = new DataView(subTemplate.buffer);
  if (sv.getUint16(2, true) !== 363 || subTemplate[6] !== 2 || sv.getUint32(0x14, true) !== 0x0200008e || sv.getUint32(0x18, true) !== 0x0200008f) fail('unexpected-layout', 'D-Range Correction submenu record is not as expected');
  const listTemplate = patch.read(SELECT_TABLE + HORIZON_RECORD * SELECT_RECORD, SELECT_RECORD);
  const lv = new DataView(listTemplate.buffer);
  if (lv.getUint32(0, true) !== 0x00010000 || lv.getUint16(4, true) !== 388 || lv.getUint32(0x0c, true) !== 0x531cf2f0 || lv.getUint32(0x24, true) !== 0x531d319c || lv.getUint32(0x2c, true) !== 0x531d4aec) {
    fail('unexpected-layout', 'Horizon Correction list record is not as expected');
  }

  // --- Texts and icons.
  const T = DATESTAMP_TEXT_IDS;
  installTexts(patch, [
    { id: T.name, names: DATESTAMP_NAMES },
    { id: T.onOff, names: DATESTAMP_ON_OFF_NAMES },
    { id: T.style, names: DATESTAMP_STYLE_NAMES },
    { id: T.short, names: Array(LANGUAGES).fill(DATESTAMP_SHORT_TEXT) },
    { id: T.long, names: Array(LANGUAGES).fill(DATESTAMP_LONG_TEXT) },
  ]);
  const icons = installIcons(patch, iconbin);
  const I = DATESTAMP_ICON_IDS;

  // --- Line of the still menu: title, and the icons of both values.
  const topDraw = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     ${LOAD_SETTING}
     tst r3, #1; movweq r1, #${ICON_OFF}; movwne r1, #${ICON_ON}
     tst r3, #2; movweq r2, #${I.short}; movwne r2, #${I.long}
     mov r0, r4; bl #${TOP_SET_TWO_ICONS}
     mov r0, r4; movw r1, #${T.name}
     pop {r4, lr}; b #${TOP_SET_TITLE}`, at), 16);

  // --- Submenu lines: the icon of the current value.
  const lineOnOff = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     mov r0, r1
     tst r3, #1; movweq r1, #${ICON_OFF}; movwne r1, #${ICON_ON}
     b #${SUB_SET_ICON}`, at), 16);
  const lineStyle = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     mov r0, r1
     tst r3, #2; movweq r1, #${I.short}; movwne r1, #${I.long}
     b #${SUB_SET_ICON}`, at), 16);

  // --- Lists (this = r0; draw: item = r1, value = r2; set / is current: value = r1).
  const count = patch.append((at) => assembleWords('mov r0, #2; bx lr', at), 16);
  const drawOnOff = patch.append((at) => assembleWords(
    `mov r0, r1; cmp r2, #0
     movweq r1, #${ICON_OFF}; movweq r2, #${TEXT_OFF}
     movwne r1, #${ICON_ON}; movwne r2, #${TEXT_ON}
     b #${LIST_SET_ITEM}`, at), 16);
  const setOnOff = patch.append((at) => assembleWords(
    `cmp r1, #1; bxhi lr
     ${LOAD_SETTING}
     bic r3, r3, #1; orr r3, r3, r1; strb r3, [r2]; bx lr`, at), 16);
  const isOnOff = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     and r3, r3, #1; cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  const drawStyle = patch.append((at) => assembleWords(
    `mov r0, r1; cmp r2, #0
     movweq r1, #${I.short}; movweq r2, #${T.short}
     movwne r1, #${I.long}; movwne r2, #${T.long}
     b #${LIST_SET_ITEM}`, at), 16);
  const setStyle = patch.append((at) => assembleWords(
    `cmp r1, #1; bxhi lr
     ${LOAD_SETTING}
     bic r3, r3, #2; orr r3, r3, r1, lsl #1; strb r3, [r2]; bx lr`, at), 16);
  const isStyle = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     mov r3, r3, lsr #1; and r3, r3, #1; cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);

  const listRecord = (title: number, draw: number, set: number, isCurrent: number): Uint8Array => {
    const r = listTemplate.slice();
    const v = new DataView(r.buffer);
    v.setUint16(4, title, true);
    v.setUint32(0x0c, count, true);
    v.setUint32(0x14, draw, true);
    v.setUint32(0x24, set, true);
    v.setUint32(0x2c, isCurrent, true);
    for (const off of [0x10, 0x18, 0x28, 0x30]) v.setUint32(off, 0, true);
    return r;
  };
  expectWord(patch, SELECT_TABLE_END_LITERAL, SELECT_TABLE + SELECT_RECORDS * SELECT_RECORD);
  expectWord(patch, SELECT_TABLE_END_LOAD, 0xe59f704c); // ldr r7, [pc, #0x4c]
  const lists = relocateTable(patch, SELECT_TABLE, SELECT_RECORD, SELECT_RECORDS + 1, [
    listRecord(T.onOff, drawOnOff, setOnOff, isOnOff),
    listRecord(T.style, drawStyle, setStyle, isStyle),
  ], SELECT_SITES, 'date imprint: list records');
  // The constructor's scan for the longest list stops at the end of the official records (the
  // two new lists have 2 values, fewer than many official ones).
  patch.setWord(SELECT_TABLE_END_LITERAL, lists + SELECT_RECORDS * SELECT_RECORD, 'date imprint: end of the official list records');

  const subRecord = subTemplate.slice();
  {
    const v = new DataView(subRecord.buffer);
    v.setUint16(2, T.name, true);
    v.setUint16(8, T.onOff, true);
    v.setUint16(10, T.style, true);
    v.setUint32(0x14, DATESTAMP_SWITCH_ID, true);
    v.setUint32(0x18, DATESTAMP_STYLE_ID, true);
    v.setUint32(0x3c, lineOnOff, true);
    v.setUint32(0x40, 0, true);
    v.setUint32(0x44, lineStyle, true);
    v.setUint32(0x48, 0, true);
  }
  relocateTable(patch, SUB_TABLE, SUB_RECORD, SUB_RECORDS + 1, [subRecord], SUB_SITES, 'date imprint: submenu records');

  // --- Two still-menu descriptors.
  const descriptor = (keep: number): Uint8Array => {
    const d = still.slice();
    const v = new DataView(d.buffer);
    const items: number[] = [];
    for (let i = 0; i < MAX_ITEMS; i++) if (i !== HDF_ITEM && i !== RED_FILTER_ITEM) items.push(i);
    items.splice(HDF_ITEM, 0, keep);
    for (let j = 0; j < MAX_ITEMS - 1; j++) {
      const i = items[j];
      d.set(still.subarray(D_DRAW + i * 8, D_DRAW + i * 8 + 8), D_DRAW + j * 8);
      d.set(still.subarray(D_ID + i * 4, D_ID + i * 4 + 4), D_ID + j * 4);
      d.set(still.subarray(D_VISIBLE + i * 8, D_VISIBLE + i * 8 + 8), D_VISIBLE + j * 8);
    }
    const last = MAX_ITEMS - 1;
    v.setUint32(D_DRAW + last * 8, topDraw, true);
    v.setUint32(D_DRAW + last * 8 + 4, 0, true);
    v.setUint32(D_ID + last * 4, DATESTAMP_MENU_ID, true);
    v.setUint32(D_VISIBLE + last * 8, 0, true);
    v.setUint32(D_VISIBLE + last * 8 + 4, 0, true);
    d.set([0, 10, 18, 23, 29, 34], D_FIRST);
    d[D_COUNT] = MAX_ITEMS;
    return d;
  };
  const withHdf = patch.append(descriptor(HDF_ITEM), 16);
  const withRedFilter = patch.append(descriptor(RED_FILTER_ITEM), 16);
  const builder = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     bl #${APP}; bl #${SPEC_MODEL}; bl #${MODEL_NUMBER}
     movw r1, #${lo(withHdf)}; movt r1, #${hi(withHdf)}
     cmp r0, #2
     movweq r1, #${lo(withRedFilter)}; movteq r1, #${hi(withRedFilter)}
     movw r2, #${lo(MENU_TABLE)}; movt r2, #${hi(MENU_TABLE)}
     str r1, [r2]
     pop {r0, r1, r2, r3, ip, lr}
     mov ip, sp
     b #${BUILDER + 4}`, at), 16);
  patch.setWord(BUILDER, branchWord(BUILDER, builder), 'date imprint: still menu for this model');

  // --- Controller ids.
  const factory = patch.append((at) => assembleWords(
    `movw ip, #${lo(DATESTAMP_MENU_ID)}; movt ip, #${hi(DATESTAMP_MENU_ID)}
     subs ip, r1, ip; beq sub
     cmp ip, #2; bhi out
     movw r1, #${lo(HORIZON_ID)}; movt r1, #${hi(HORIZON_ID)}; b out
     sub: movw r1, #${lo(D_RANGE_ID)}; movt r1, #${hi(D_RANGE_ID)}
     out: movw r3, #0x12e
     b #${FACTORY + 4}`, at), 16);
  patch.setWord(FACTORY, branchWord(FACTORY, factory), 'date imprint: controllers of the menu entry');
  const subCurrent = patch.append((at) => assembleWords(
    `movw ip, #${lo(DATESTAMP_MENU_ID)}; movt ip, #${hi(DATESTAMP_MENU_ID)}
     cmp r1, ip
     moveq r3, #${SUB_RECORD_NUMBER}; strbeq r3, [r0, #0x174]; bxeq lr
     add r3, r1, #0xfe000000
     b #${SUB_SET_CURRENT + 4}`, at), 16);
  patch.setWord(SUB_SET_CURRENT, branchWord(SUB_SET_CURRENT, subCurrent), 'date imprint: submenu record');
  const selectCurrent = patch.append((at) => assembleWords(
    `movw ip, #${lo(DATESTAMP_SWITCH_ID)}; movt ip, #${hi(DATESTAMP_SWITCH_ID)}
     subs ip, r1, ip
     moveq r3, #${SWITCH_RECORD_NUMBER}; strbeq r3, [r0, #0x1a4]; bxeq lr
     cmp ip, #1
     moveq r3, #${STYLE_RECORD_NUMBER}; strbeq r3, [r0, #0x1a4]; bxeq lr
     add r3, r1, #0xfe000000
     b #${SELECT_SET_CURRENT + 4}`, at), 16);
  patch.setWord(SELECT_SET_CURRENT, branchWord(SELECT_SET_CURRENT, selectCurrent), 'date imprint: list records');

  return icons;
}
