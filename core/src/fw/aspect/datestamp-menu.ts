// SPDX-License-Identifier: GPL-2.0-only
/**
 * The camera-menu entry of the date imprint (firmware 1.11): a line "Date Imprint" on the
 * Shooting Assist page of the still shooting menu, after Horizon Correction. It opens a small
 * submenu like D-Range Correction's with three lines (0.8.2: the first two):
 *
 *   On/Off               Off / On
 *   Style                '26 10 08 / 2026.10.08 17:34 / '26 10 08 + Name / 2026.10.08 17:34 + Name
 *                        (0.8.4: the last two, with the look's name; up to 0.8.3 the first two)
 *   Follow Orientation   Off / On   (0.8.3; On: bottom right of the picture as it is viewed)
 *
 * All are kept in the setting byte of `datestamp.ts` (byte 0x94B of the user settings): bit 0 on,
 * bit 1 the long style, bit 2 "Follow Orientation" off (so that the values 0..3 an earlier GR Mod
 * firmware left read as On), bit 3 (0.8.4) with the look's name. The menu treats any other value
 * (above 15; the byte is padding the official firmware never sets, and the factory-defaults
 * initialiser leaves it as it is) as 0 and writes 0 back the first time it reads it, so lists
 * always have exactly one current value. (A firmware up to 0.8.2 treats 4..15, and 0.8.3 8..15,
 * that way too: the imprint is then off there.)
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
 *    0x020001A1, 0x020001A2 and 0x020001A5 (the lists; 0x020001A3 / A4 are the power-off picture's,
 *    see shutdown.ts); the firmware does not use these ids. The controller
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
 *    of 124 at 0x53DA2D20 addressed from 16 places; copied with three more records (125..127; 124 is
 *    the constructor's start value), the model being Horizon Correction's record. SetCurrentMenu
 *    (0x531D5E8C) maps the new ids to them. The constructor also scans the table up to its end
 *    (pool word 0x531D6DAC) for the longest list; that end moves with the table (and still ends
 *    after the 124 official records).
 *  - Texts 841..845, 879, 880 and 881 in all 21 languages (relocated text catalog, see `build.ts`):
 *    the line name, "On/Off", "Style", the four style names and "Follow Orientation". Off and On
 *    are the camera's texts 2 and 1.
 *  - Icons: the camera's OFF / ON (310, 311) and four new 40x40 icons for the styles, numbers 721
 *    and 722 (the ratio icon numbers of identities 5 and 6, never given out) and 731 and 732 (0.8.4:
 *    those of identities 15 and 16; added ratios use identities 7..14).
 */
import { FirmwareError } from '../types';
import { assembleWords, branchTarget, movImmediate, movWord } from './arm';
import {
  ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, NATIVE_TEXT_ROOTS, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z,
} from './build';
import { DATESTAMP_AS_STORED, DATESTAMP_BYTE, DATESTAMP_LONG, DATESTAMP_NAME } from './datestamp';

/** Controller ids of the submenu and of its two lists. */
export const DATESTAMP_MENU_ID = 0x020001a0;
export const DATESTAMP_SWITCH_ID = 0x020001a1;
export const DATESTAMP_STYLE_ID = 0x020001a2;
/** 0.8.3: the "Follow Orientation" list. */
export const DATESTAMP_ORIENT_ID = 0x020001a5;

/** Texts: line / submenu name, the two line names, the two style names. */
export const DATESTAMP_TEXT_IDS = { name: 841, onOff: 842, style: 843, short: 844, long: 845, orient: 879, shortName: 880, longName: 881 } as const;
/** Icons of the four styles. */
export const DATESTAMP_ICON_IDS = { short: 721, long: 722, shortName: 731, longName: 732 } as const;
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
/**
 * "Follow Orientation", in `LANGS` order. Each fits the width of the camera's own submenu lines (no
 * longer than its longest line text of that language, see the test). The Chinese and Japanese
 * names use characters that are not among the camera's own texts (跟 随/隨 向), but are in its
 * fonts (RT_CN_S / RT_CN_T / RT_JP, full character sets), as 戳 and 样 of the line name are.
 */
export const DATESTAMP_ORIENT_NAMES: readonly string[] = [
  'Podle orientace', 'Følg retning', 'Follow Orientation', 'Seuraa asentoa', "Suivre l'orientation", 'Ausrichtung folgen', 'Βάσει προσανατολισμού',
  'Tájolás követése', 'Segui orientamento', 'カメラの向きに合わせる', '카메라 방향 따르기', 'Oriëntatie volgen', 'Zgodnie z orientacją', 'Seguir orientação',
  'По ориентации камеры', '跟随相机方向', 'Seguir orientación', 'Följ orientering', 'ตามทิศทางกล้อง', '跟隨相機方向', 'Yönü takip et',
];
export const DATESTAMP_SHORT_TEXT = "'26 10 08";
export const DATESTAMP_LONG_TEXT = '2026.10.08 17:34';
/** 0.8.4: "Name" (of the look), after "+" in the two styles with the look's name, in `LANGS` order. */
export const DATESTAMP_NAME_WORDS: readonly string[] = [
  'Název', 'Navn', 'Name', 'Nimi', 'Nom', 'Name', 'Όνομα',
  'Név', 'Nome', '名称', '이름', 'Naam', 'Nazwa', 'Nome',
  'Имя', '名称', 'Nombre', 'Namn', 'ชื่อ', '名稱', 'Ad',
];
export const datestampNameTexts = (date: string): string[] => DATESTAMP_NAME_WORDS.map((w) => `${date} + ${w}`);

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
export const ORIENT_RECORD_NUMBER = SELECT_RECORDS + 3;

// Functions the handlers call.
const APP = 0x5323ea84; // application singleton
const SPEC_MODEL = 0x5323ff28; // (app) -> SpecModel
const MODEL_NUMBER = 0x533e0330; // (SpecModel) -> 0 GR IV, 1 HDF, 2 Monochrome
const TOP_SET_TWO_ICONS = 0x5357a510; // (menu line, icon, icon)
const TOP_SET_TITLE = 0x5357a1c0; // (menu line, text)
const SUB_SET_ICON = 0x53583188; // (submenu line, icon)
const LIST_SET_ITEM = 0x5357aef0; // (list item, icon, text)
/**
 * 0.8.4 (test 052): the list rows of SelectMenuController are widgets of class 0x5357AB24 (vtable
 * 0x53E98F18; constructor (x, y, width, height)): selection mark at x 10, icon 40..100, the value's
 * text label (+0xFC, a label widget, vtable 0x53E984E0) at x 100, 400 wide, y 10, 40 high, whatever
 * the row's width. The longest Style values ("2026.10.08 17:34 + ...") did not fit in 400 (test 051:
 * the last character cut in half). For the Style list only, after a value is drawn, its label is
 * made as wide as the row allows: to 20 px before the row's right edge, and never beyond x 680, the
 * right edge of the row's widest own widget (+0x100, 40..680), through the label's own SetRect (vtable +0x18, as the row's
 * icon layout 0x5357AE64 does). Nothing else changes; other lists are not touched.
 */
const ROW_VTABLE = 0x53e98f18;
const ROW_VTABLE_LITERAL = 0x5357ad3c; // in the row constructor 0x5357AB24
const LABEL_VTABLE = 0x53e984e0;
const LABEL_VTABLE_LITERAL = 0x53572e34; // in the label constructor 0x53572D50
const LABEL_SET_RECT = 0x53587c3c; // label vtable +0x18
const ROW_RIGHT_MARGIN = 20;
/** The right edge of the row's widest own widget (+0x100: x 40, 640 wide): the label never goes beyond it. */
const ROW_CONTENT_RIGHT = 680;

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
 * "2026" over "17:34" (long); with the look's name (0.8.4) "'26" / "2026" over "+AbC".
 */
export function drawStyleIcon(long: boolean, name = false): Uint8Array {
  const W = STYLE_ICON_W;
  const H = STYLE_ICON_H;
  const px = new Uint8Array(W * H * 4);
  const BORDER = [128, 128, 128];
  const BG = [53, 53, 54];
  const INK = [255, 128, 32];
  const rows = name ? [long ? '2026' : "'26", '+AbC'] : long ? ['2026', '17:34'] : ["'26", '10 08'];
  const dw = 6;
  const gap = 2;
  // Rectangles [x0, y0, x1, y1] (inclusive) of segments a..g.
  const SEG: readonly (readonly number[])[] = [[0, 0, 5, 1], [4, 0, 5, 5], [4, 4, 5, 10], [0, 9, 5, 10], [0, 4, 1, 10], [0, 0, 1, 5], [0, 4, 5, 5]];
  const shapes = (c: string): readonly (readonly number[])[] => {
    if (c === "'") return [[0, 0, 1, 3]];
    if (c === ':') return [[0, 2, 1, 3], [0, 7, 1, 8]];
    if (c === ' ') return [];
    if (c === '+') return [[2, 2, 3, 8], [0, 4, 5, 5]];
    if (c === 'A') return SEG.filter((_, k) => (0x77 & (1 << k)) !== 0);
    if (c === 'b') return SEG.filter((_, k) => (0x7c & (1 << k)) !== 0);
    if (c === 'C') return SEG.filter((_, k) => (0x39 & (1 << k)) !== 0);
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
  const I = DATESTAMP_ICON_IDS;
  for (const [id, long, name] of [[I.short, false, false], [I.long, true, false], [I.shortName, false, true], [I.longName, true, true]] as const) {
    if (patch.word(ICON_CATALOG + id * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const offset = length;
    const icon = drawStyleIcon(long, name);
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
// Shared with other camera-menu additions (`shutdown.ts`)

export { FACTORY as CONTROLLER_FACTORY, D_RANGE_ID as SUBMENU_CONTROLLER_ID, HORIZON_ID as LIST_CONTROLLER_ID };
export { SUB_SET_ICON, LIST_SET_ITEM, SUB_RECORD };

/** Where the submenu table (SubMenuController records, 0x64 bytes) is now: the official one or its latest copy. */
export function submenuTable(patch: Patch): number {
  const at = SUB_SITES.map(([low, high, r]) => {
    const a = patch.word(low), b = patch.word(high);
    if (a !== movWord(r, movImmediate(a)) || b !== movWord(r, movImmediate(b), true)) fail('unexpected-layout', 'submenu table site is not a MOVW/MOVT pair');
    return (movImmediate(a) | (movImmediate(b) << 16)) >>> 0;
  });
  if (at.some((t) => t !== at[0]) || (at[0] === SUB_TABLE) !== (patch.submenuRecords === 0)) fail('unexpected-layout', 'submenu table is not where it was expected');
  return at[0];
}

/** A list record (SelectMenuController, 0x4C bytes) to start from: Horizon Correction's. */
export function listTemplate(patch: Patch): Uint8Array {
  const r = patch.read(SELECT_TABLE + HORIZON_RECORD * SELECT_RECORD, SELECT_RECORD);
  const v = new DataView(r.buffer);
  if (v.getUint32(0, true) !== 0x00010000 || v.getUint16(4, true) !== 388 || v.getUint32(0x0c, true) !== 0x531cf2f0 || v.getUint32(0x24, true) !== 0x531d319c || v.getUint32(0x2c, true) !== 0x531d4aec) {
    fail('unexpected-layout', 'Horizon Correction list record is not as expected');
  }
  return r;
}

/**
 * Add list records (SelectMenuController, 0x4C bytes each), record i shown for controller id
 * `entries[i].id`: the list table is copied (once more) with the records at its end, the
 * constructor's scan still ends after the 124 official records, and SetCurrentMenu maps each id
 * to its record (before what was there: the official code, or an earlier addition's mapping). The
 * controller factory must hand out the list controller for the ids (`hookControllerFactory`).
 * Returns the record numbers.
 */
export function addListRecords(patch: Patch, entries: readonly { id: number; record: Uint8Array }[], what: string): number[] {
  if (entries.some((x) => x.record.length !== SELECT_RECORD)) fail('internal', 'list record size');
  const at = SELECT_SITES.map(([low, high, r]) => {
    const a = patch.word(low), b = patch.word(high);
    if (a !== movWord(r, movImmediate(a)) || b !== movWord(r, movImmediate(b), true)) fail('unexpected-layout', 'list table site is not a MOVW/MOVT pair');
    return (movImmediate(a) | (movImmediate(b) << 16)) >>> 0;
  });
  const table = at[0];
  if (at.some((t) => t !== table) || (table === SELECT_TABLE) !== (patch.listRecords === 0)) fail('unexpected-layout', 'list table is not where it was expected');
  expectWord(patch, SELECT_TABLE_END_LOAD, 0xe59f704c); // ldr r7, [pc, #0x4c]
  expectWord(patch, SELECT_TABLE_END_LITERAL, table + SELECT_RECORDS * SELECT_RECORD);
  const copy = patch.listRecords || SELECT_RECORDS + 1;
  if (copy + entries.length > 0xff) fail('internal', 'too many list records');
  const moved = relocateTable(patch, table, SELECT_RECORD, copy, entries.map((x) => x.record), SELECT_SITES, `${what}: list records`);
  patch.setWord(SELECT_TABLE_END_LITERAL, moved + SELECT_RECORDS * SELECT_RECORD, `${what}: end of the official list records`);
  const first = patch.word(SELECT_SET_CURRENT);
  const prior = first === 0xe28134fe
    ? patch.append((a) => assembleWords(`add r3, r1, #0xfe000000; b #${SELECT_SET_CURRENT + 4}`, a), 16)
    : first >>> 24 === 0xea ? branchTarget(SELECT_SET_CURRENT, first) : fail('unexpected-layout', 'list SetCurrentMenu is not as expected');
  const cases = entries.map((x, k) => `movw ip, #${lo(x.id)}; movt ip, #${hi(x.id)}; cmp r1, ip
     moveq r3, #${copy + k}; strbeq r3, [r0, #0x1a4]; bxeq lr`).join('\n');
  const current = patch.append((a) => assembleWords(`${cases}\n b #${prior}`, a), 16);
  patch.setWord(SELECT_SET_CURRENT, branchWord(SELECT_SET_CURRENT, current), `${what}: list records`);
  patch.listRecords = copy + entries.length;
  return entries.map((_, k) => copy + k);
}

/** A submenu record (0x64 bytes) to start from: Reset (Setup), two lines without values. */
export function submenuTemplate(patch: Patch): Uint8Array {
  const r = patch.read(SUB_TABLE + 17 * SUB_RECORD, SUB_RECORD);
  const v = new DataView(r.buffer);
  if (v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 703 || r[6] !== 2 || v.getUint32(0x14, true) !== 0x02000112 || v.getUint32(0x18, true) !== 0x02000116) {
    fail('unexpected-layout', 'Reset submenu record is not as expected');
  }
  return r;
}

/**
 * Add a submenu record (SubMenuController, 0x64 bytes) shown for controller id `id`: the table is
 * copied once more with the record at its end, and SetCurrentMenu maps `id` to it (before what was
 * there: the official code, or the date imprint's mapping). The controller itself is the one of
 * every submenu (the factory must hand it out for `id`, as for SUBMENU_CONTROLLER_ID). Returns the
 * record number.
 */
export function addSubmenuRecord(patch: Patch, id: number, record: Uint8Array, what: string): number {
  if (record.length !== SUB_RECORD) fail('internal', 'submenu record size');
  const at = SUB_SITES.map(([low, high, r]) => {
    const a = patch.word(low), b = patch.word(high);
    if (a !== movWord(r, movImmediate(a)) || b !== movWord(r, movImmediate(b), true)) fail('unexpected-layout', 'submenu table site is not a MOVW/MOVT pair');
    return (movImmediate(a) | (movImmediate(b) << 16)) >>> 0;
  });
  const table = at[0];
  if (at.some((t) => t !== table) || (table === SUB_TABLE) !== (patch.submenuRecords === 0)) fail('unexpected-layout', 'submenu table is not where it was expected');
  const copy = patch.submenuRecords || SUB_RECORDS + 1;
  if (copy > 0xff) fail('internal', 'too many submenu records');
  relocateTable(patch, table, SUB_RECORD, copy, [record], SUB_SITES, `${what}: submenu records`);
  const first = patch.word(SUB_SET_CURRENT);
  const prior = first === 0xe28134fe
    ? patch.append((a) => assembleWords(`add r3, r1, #0xfe000000; b #${SUB_SET_CURRENT + 4}`, a), 16)
    : first >>> 24 === 0xea ? branchTarget(SUB_SET_CURRENT, first) : fail('unexpected-layout', 'submenu SetCurrentMenu is not as expected');
  const current = patch.append((a) => assembleWords(
    `movw ip, #${lo(id)}; movt ip, #${hi(id)}
     cmp r1, ip
     moveq r3, #${copy}; strbeq r3, [r0, #0x174]; bxeq lr
     b #${prior}`, a), 16);
  patch.setWord(SUB_SET_CURRENT, branchWord(SUB_SET_CURRENT, current), `${what}: submenu record`);
  patch.submenuRecords = copy + 1;
  return copy;
}

/**
 * Hook the controller factory: `body` (assembly) sees the id in r1 and ends with `b prior` (the
 * label is defined here) to go on as before, with r1 possibly replaced; or returns a controller
 * in r0 itself.
 */
export function hookControllerFactory(patch: Patch, body: string, what: string): void {
  const first = patch.word(FACTORY);
  const prior = first === movWord(3, 0x12e)
    ? patch.append((a) => assembleWords(`movw r3, #0x12e; b #${FACTORY + 4}`, a), 16)
    : first >>> 24 === 0xea ? branchTarget(FACTORY, first) : fail('unexpected-layout', 'controller factory is not as expected');
  const hook = patch.append((a) => assembleWords(`${body}\n prior: b #${prior}`, a), 16);
  patch.setWord(FACTORY, branchWord(FACTORY, hook), what);
}

// --------------------------------------------------------------------------------------------

/** Load the setting byte into r3 (r2 = its address); anything above 15 becomes (and is stored as) 0. */
const LOAD_SETTING = `movw r2, #${lo(DATESTAMP_BYTE)}; movt r2, #${hi(DATESTAMP_BYTE)}; ldrb r3, [r2]
  cmp r3, #15; movhi r3, #0; strbhi r3, [r2]`;

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
 * catalogs) and the imprint itself. Returns the ICONBIN data with the four style icons appended.
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
  for (const f of [APP, SPEC_MODEL, TOP_SET_TWO_ICONS, TOP_SET_TITLE, SUB_SET_ICON, LIST_SET_ITEM, LABEL_SET_RECT]) expectWord(patch, f, 0xe1a0c00d);
  expectWord(patch, ROW_VTABLE_LITERAL, ROW_VTABLE);
  expectWord(patch, LABEL_VTABLE_LITERAL, LABEL_VTABLE);
  if (new DataView(patch.readMapped(LABEL_VTABLE + 0x18, 4).buffer).getUint32(0, true) !== LABEL_SET_RECT) fail('unexpected-layout', 'label SetRect is not where it was expected');
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
  for (let i = 0; i < MAX_ITEMS; i++) if ([DATESTAMP_MENU_ID, DATESTAMP_SWITCH_ID, DATESTAMP_STYLE_ID, DATESTAMP_ORIENT_ID].includes(id(i))) fail('unexpected-layout', 'controller id already in use');

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
    { id: T.orient, names: DATESTAMP_ORIENT_NAMES },
    { id: T.shortName, names: datestampNameTexts(DATESTAMP_SHORT_TEXT) },
    { id: T.longName, names: datestampNameTexts(DATESTAMP_LONG_TEXT) },
  ]);
  const icons = installIcons(patch, iconbin);
  const I = DATESTAMP_ICON_IDS;
  /** rX = the icon of the style in the setting r3 (bits 1 and 3; ip changes). */
  const styleIcon = (rX: string): string => `and ip, r3, #${DATESTAMP_LONG | DATESTAMP_NAME}
     cmp ip, #0; movweq ${rX}, #${I.short}
     cmp ip, #${DATESTAMP_LONG}; movweq ${rX}, #${I.long}
     cmp ip, #${DATESTAMP_NAME}; movweq ${rX}, #${I.shortName}
     cmp ip, #${DATESTAMP_LONG | DATESTAMP_NAME}; movweq ${rX}, #${I.longName}`;

  // --- Line of the still menu: title, and the icons of both values.
  const topDraw = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     ${LOAD_SETTING}
     tst r3, #1; movweq r1, #${ICON_OFF}; movwne r1, #${ICON_ON}
     ${styleIcon('r2')}
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
     ${styleIcon('r1')}
     b #${SUB_SET_ICON}`, at), 16);
  // "Follow Orientation": On while bit 2 is clear.
  const lineOrient = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     mov r0, r1
     tst r3, #${DATESTAMP_AS_STORED}; movweq r1, #${ICON_ON}; movwne r1, #${ICON_OFF}
     b #${SUB_SET_ICON}`, at), 16);

  // --- Lists (this = r0; draw: item = r1, value = r2; set / is current: value = r1).
  const count = patch.append((at) => assembleWords('mov r0, #2; bx lr', at), 16);
  const styleCount = patch.append((at) => assembleWords('mov r0, #4; bx lr', at), 16);
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
  // Style values: 0 short, 1 long, 2 short + name, 3 long + name (bit 0: bit 1 of the byte, bit 1: bit 3).
  // The value's label made as wide as the row allows (see ROW_VTABLE): r0 = the row; every register
  // but r0..r3, ip is kept. Only for a row and a label of the expected classes, and only wider.
  const widenLabel = patch.append((at) => assembleWords(
    `push {r4, r5, lr}
     sub sp, sp, #20
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldr r3, [r0]; movw ip, #${lo(ROW_VTABLE)}; movt ip, #${hi(ROW_VTABLE)}; cmp r3, ip; bne done
     ldr r5, [r0, #0x28]
     cmp r5, #200; blt done; cmp r5, #720; bgt done
     sub r5, r5, #${ROW_RIGHT_MARGIN}
     cmp r5, #${ROW_CONTENT_RIGHT}; movgt r5, #${ROW_CONTENT_RIGHT}
     ldr r4, [r0, #0xfc]
     cmp r4, #0x40000000; blo done; cmp r4, #0xc0000000; bhs done
     ldr r3, [r4]; movw ip, #${lo(LABEL_VTABLE)}; movt ip, #${hi(LABEL_VTABLE)}; cmp r3, ip; bne done
     ldr r0, [r4, #0x20]; ldr r1, [r4, #0x24]; ldr r2, [r4, #0x28]; ldr r3, [r4, #0x2c]
     cmp r0, #0; blt done
     add ip, r0, r2; cmp ip, r5; bge done
     sub r2, r5, r0
     str r0, [sp]; str r1, [sp, #4]; str r2, [sp, #8]; str r3, [sp, #12]
     ldr r3, [r4]; ldr r3, [r3, #0x18]
     mov r0, r4; mov r1, sp; mov lr, pc; bx r3
     done: add sp, sp, #20
     pop {r4, r5, pc}`, at), 16);
  const drawStyle = patch.append((at) => assembleWords(
    `cmp r2, #3; bxhi lr
     push {r4, lr}
     mov r4, r1
     mov r0, r1; mov ip, r2
     cmp ip, #0; movweq r1, #${I.short}; movweq r2, #${T.short}
     cmp ip, #1; movweq r1, #${I.long}; movweq r2, #${T.long}
     cmp ip, #2; movweq r1, #${I.shortName}; movweq r2, #${T.shortName}
     cmp ip, #3; movweq r1, #${I.longName}; movweq r2, #${T.longName}
     bl #${LIST_SET_ITEM}
     mov r0, r4
     bl #${widenLabel}
     pop {r4, pc}`, at), 16);
  const setStyle = patch.append((at) => assembleWords(
    `cmp r1, #3; bxhi lr
     ${LOAD_SETTING}
     bic r3, r3, #${DATESTAMP_LONG | DATESTAMP_NAME}
     tst r1, #1; orrne r3, r3, #${DATESTAMP_LONG}
     tst r1, #2; orrne r3, r3, #${DATESTAMP_NAME}
     strb r3, [r2]; bx lr`, at), 16);
  const isStyle = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     and ip, r3, #${DATESTAMP_LONG}; mov ip, ip, lsr #1
     tst r3, #${DATESTAMP_NAME}; orrne ip, ip, #2
     cmp ip, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  // Values 0 Off, 1 On (as the On/Off list draws them); stored inverted in bit 2.
  const setOrient = patch.append((at) => assembleWords(
    `cmp r1, #1; bxhi lr
     ${LOAD_SETTING}
     bic r3, r3, #${DATESTAMP_AS_STORED}; cmp r1, #0; orreq r3, r3, #${DATESTAMP_AS_STORED}; strb r3, [r2]; bx lr`, at), 16);
  const isOrient = patch.append((at) => assembleWords(
    `${LOAD_SETTING}
     tst r3, #${DATESTAMP_AS_STORED}; moveq r3, #1; movne r3, #0
     cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);

  const listRecord = (title: number, draw: number, set: number, isCurrent: number, values = count): Uint8Array => {
    const r = listTemplate.slice();
    const v = new DataView(r.buffer);
    v.setUint16(4, title, true);
    v.setUint32(0x0c, values, true);
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
    listRecord(T.style, drawStyle, setStyle, isStyle, styleCount),
    listRecord(T.orient, drawOnOff, setOrient, isOrient),
  ], SELECT_SITES, 'date imprint: list records');
  // The constructor's scan for the longest list stops at the end of the official records (the
  // new lists have 2 and 4 values, fewer than many official ones).
  patch.setWord(SELECT_TABLE_END_LITERAL, lists + SELECT_RECORDS * SELECT_RECORD, 'date imprint: end of the official list records');
  patch.listRecords = ORIENT_RECORD_NUMBER + 1;

  const subRecord = subTemplate.slice();
  {
    const v = new DataView(subRecord.buffer);
    v.setUint16(2, T.name, true);
    // Three lines, laid out as Instant Review's (record 11): texts from +8 (0 after the last),
    // controller ids from +0x14 (0x10000000 after the last), per line from +0x28 the x of its value
    // icon (540; SubMenuController's line drawing 0x531E2424 hands it to 0x5358304C, the line
    // widget's +0x108; test 048 left it 0 for the third line: its icon was drawn at the left, over
    // the name), value-draw functions from +0x3C.
    subRecord[6] = 3;
    if (v.getUint32(0x28, true) !== 0x21c || v.getUint32(0x2c, true) !== 0x21c || v.getUint32(0x30, true) !== 0) fail('unexpected-layout', 'D-Range Correction submenu record: value icon places');
    v.setUint32(0x30, v.getUint32(0x28, true), true);
    v.setUint16(8, T.onOff, true);
    v.setUint16(10, T.style, true);
    v.setUint16(12, T.orient, true);
    v.setUint16(14, 0, true);
    v.setUint32(0x14, DATESTAMP_SWITCH_ID, true);
    v.setUint32(0x18, DATESTAMP_STYLE_ID, true);
    v.setUint32(0x1c, DATESTAMP_ORIENT_ID, true);
    v.setUint32(0x20, 0x10000000, true);
    v.setUint32(0x3c, lineOnOff, true);
    v.setUint32(0x40, 0, true);
    v.setUint32(0x44, lineStyle, true);
    v.setUint32(0x48, 0, true);
    v.setUint32(0x4c, lineOrient, true);
    v.setUint32(0x50, 0, true);
  }
  relocateTable(patch, SUB_TABLE, SUB_RECORD, SUB_RECORDS + 1, [subRecord], SUB_SITES, 'date imprint: submenu records');
  patch.submenuRecords = SUB_RECORD_NUMBER + 1;

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
     cmp ip, #${DATESTAMP_ORIENT_ID - DATESTAMP_MENU_ID}; beq list
     cmp ip, #2; bhi out
     list: movw r1, #${lo(HORIZON_ID)}; movt r1, #${hi(HORIZON_ID)}; b out
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
     cmp ip, #${DATESTAMP_ORIENT_ID - DATESTAMP_SWITCH_ID}
     moveq r3, #${ORIENT_RECORD_NUMBER}; strbeq r3, [r0, #0x1a4]; bxeq lr
     add r3, r1, #0xfe000000
     b #${SELECT_SET_CURRENT + 4}`, at), 16);
  patch.setWord(SELECT_SET_CURRENT, branchWord(SELECT_SET_CURRENT, selectCurrent), 'date imprint: list records');

  return icons;
}
