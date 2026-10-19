// SPDX-License-Identifier: GPL-2.0-only
/**
 * Power-off pictures chosen in the camera. The "End Screen" line of Setup > Display opens a submenu
 * (title "End Screen") of two lines:
 *
 *   Type      Type1           the camera's own End Screen list (type 1 / type 2), unchanged;
 *   Picture   <current>       a list of the factory picture ("Original") and the added pictures
 *                             (1..SHUTDOWN_MAX_PICTURES, by name), with a 520x200 thumbnail of the
 *                             focused row above it.
 *
 * The power-off screen shows the chosen picture. The camera side is the module of
 * `tools/shutdown/shutdown.c` (see there for the list and the record of the choice).
 *
 * What a build adds:
 *  - the pictures as files of the RES section, `A:\Resource\Jpeg\GRMOD<k>.jpg` (720x480 baseline
 *    JPEG of exactly SHUTDOWN_JPEG_BYTES bytes, so that each file with its 36-byte header is two
 *    container frames and the RES section grows by whole frames; see `package.ts`). The firmware
 *    update writes them to the camera's A: drive with the factory files. Named by position, so a
 *    later build overwrites the same files instead of leaving old ones behind;
 *  - a copy of the table of full-screen JPEGs (0x55013E70, 12 entries {u16 w, u16 h, path}) with one
 *    entry per picture (numbers 12, 13, ...), used by both of its readers (0x5326232C, 0x53262558);
 *  - 520x200 thumbnails (as the native ones of the menu, icons 17 and 18) of the four factory
 *    pictures and of the added ones, icons SHUTDOWN_ICON_ID..;
 *  - texts from SHUTDOWN_TEXT_ID: the two line names in all 21 languages (every glyph is in the
 *    camera's own texts of that language), the factory row ("Original" / オリジナル / 原廠 / 原厂),
 *    then the names;
 *  - the menu: Setup's item 10 (descriptor 0x53D9CA10) opens controller SHUTDOWN_MENU_ID instead of
 *    the End Screen list (0x020000C4) and draws as Setup's other submenu lines (title only); that id
 *    is the submenu controller with an added submenu record (see `datestamp-menu.ts`), whose lines
 *    open 0x020000C4 and SHUTDOWN_PICTURE_ID;
 *  - SHUTDOWN_PICTURE_ID: the camera's End Screen list itself (the controller factory hands out
 *    its one object, as for 0x020000C4) in picture mode: PICTURE_MODE is set when the factory is
 *    asked for SHUTDOWN_PICTURE_ID and cleared when asked for 0x020000C4. The list is built with
 *    1 + n rows (0x53223BA4) of an appended array of row types (0x53223BD4); when it opens
 *    (0x532240E4) it shows 2 of them and the title "End Screen" in the camera's mode, all of them
 *    and the title "Picture" in picture mode. In picture mode the handlers (0x532240E4 refresh,
 *    0x53223FA4 confirm, 0x53223F14 / 0x53223F58 up / down, 0x5322419C footer) go to the module,
 *    otherwise the official code runs. The key mapper (KEY_MAP_ID_READS) is given 0x020000C4 for
 *    SHUTDOWN_PICTURE_ID, so that the list gets the End Screen list's keys;
 *  - the module, its context and stubs: also the picture request (0x531B9488) and the settings save;
 *  - the settings store APData (0x53A80ADC) is created for SHUTDOWN_RECORD + 1 records instead of
 *    16 (the choice is record SHUTDOWN_RECORD);
 *  - the start-up zero fill also clears the 44 bytes before the heap (as with added slots), so
 *    PICTURE_MODE starts at 0.
 *
 * The approach (pictures in RES, the extended JPEG table, the record) is that of gr-custom-tool's
 * End Screen list (Copyright (C) 2026 DoYitNow, GPL-2.0-only); the code is GR Mod's own.
 */
import { decodeBaselineJpeg } from '../../jpeg/decoder';
import { encodeCoefficients, forwardTransform, makeLayout } from '../../jpeg/encoder';
import { qualityTables } from '../../jpeg/tables';
import { FirmwareError } from '../types';
import { assembleWords, branchTarget, branchWord, movImmediate, movWord } from './arm';
import { BASE, ICON_CATALOG, LOOKUP_BOUNDS, OFFICIAL_RTOS_LENGTH, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z } from './build';
import { SHUTDOWN_CODE, SHUTDOWN_CODE_LENGTH, SHUTDOWN_EXPORTS } from './shutdown-code';
import { readRes, resFile } from './res';
import { SUBMENU_CONTROLLER_ID, addSubmenuRecord, hookControllerFactory, submenuTemplate } from './datestamp-menu';

export const SHUTDOWN_MAX_PICTURES = 8;
/** Longest picture name (printable ASCII: the same in every camera language and font). */
export const SHUTDOWN_NAME_MAX = 20;
/** First text: the submenu's line names "Type" and "Picture", the factory row, the pictures' names. */
export const SHUTDOWN_TEXT_ID = 853;
export const SHUTDOWN_TYPE_TEXT = SHUTDOWN_TEXT_ID;
export const SHUTDOWN_PICTURE_TEXT = SHUTDOWN_TEXT_ID + 1;
export const SHUTDOWN_FACTORY_TEXT = SHUTDOWN_TEXT_ID + 2;
/** Controller ids: the End Screen submenu, the picture list (not used by the firmware). */
export const SHUTDOWN_MENU_ID = 0x020001a3;
export const SHUTDOWN_PICTURE_ID = 0x020001a4;
/** Thumbnails: the factory pictures 1, 2, 3, 11, then the added pictures. */
export const SHUTDOWN_ICON_ID = 992;
/** APData record of the choice. */
export const SHUTDOWN_RECORD = 74;
export const SHUTDOWN_WIDTH = 720;
export const SHUTDOWN_HEIGHT = 480;
/** Every picture file: two container frames (0x6000) with its 36-byte RES header. */
export const SHUTDOWN_JPEG_BYTES = 2 * 0x6000 - 36;
export const PREVIEW_WIDTH = 520;
export const PREVIEW_HEIGHT = 200;
/** Factory pictures (numbers of the JPEG table) in the order of the context's factory_icon. */
export const FACTORY_PICTURES = [
  { resource: 1, path: 'A:\\Resource\\Jpeg\\GoodBye.jpg' },
  { resource: 2, path: 'A:\\Resource\\Jpeg\\GB_HDF.jpg' },
  { resource: 3, path: 'A:\\Resource\\Jpeg\\GB_Mono.jpg' },
  { resource: 11, path: 'A:\\Resource\\Jpeg\\GB_20th.jpg' },
] as const;
/** The added pictures go into RES after this file. */
export const RES_ANCHOR = 'A:\\Resource\\Jpeg\\SymKey.jpg';

/** An added power-off picture. */
export interface ShutdownPictureSpec {
  /** Stable identity (1..0xFFFFFFFF), remembered by the camera as the choice. */
  id: number;
  /** Name in the camera's list: 1..SHUTDOWN_NAME_MAX printable ASCII characters. */
  name: string;
  /** 720x480 baseline JPEG of exactly SHUTDOWN_JPEG_BYTES bytes. */
  jpeg: Uint8Array;
}

const JPEG_TABLE = 0x55013e70;
const JPEG_TABLE_COUNT = 12;
const TABLE_SITES = [[0x5326255c, 0x5326256c, 3], [0x53262324, 0x5326232c, 12]] as const;
const BACKGROUND = 0x531b9488;
const BACKGROUND_BODY = 0x531b948c;
const SETTINGS_SAVE = 0x533e1c04;
const MENU = { refresh: 0x532240e4, confirm: 0x53223fa4, left: 0x53223f14, right: 0x53223f58, footer: 0x5322419c } as const;
const MENU_ROWS_AT = 0x53223ba4;
const MENU_TYPES_AT = 0x53223bd4;
const ROW_TYPE = 0x15;
const END_SCREEN_ID = 0x020000c4;
const END_SCREEN_TITLE = 701;
/** List widget: rows shown (0x535711E4, at most those built); title view: text (0x5357F2B0). */
const LIST_SHOWN = 0x535711e4;
const TITLE_SET = 0x5357f2b0;
/** Setup menu descriptor (menu table entry 4) and its End Screen item (10). */
const SETUP_MENU = 0x53d9ca10;
const SETUP_MENU_ENTRY = 0x55001e88;
const SETUP_ITEM = 10;
const SETUP_ITEM_DRAW = 0x531b1cd8;
/** Line of a Setup submenu: no value (0x5357A428 with 0), then its title (0x5357A1C0). */
const LINE_VALUE_ICON = 0x5357a428;
const LINE_TITLE = 0x5357a1c0;
/** The native End Screen line's value text: 0x53380874(0x5323F378(app) + 4, 0x5329C2D8(user data)). */
const APP = 0x5323ea84;
const SUBMENU_LINE_TEXT = 0x535831e8;
/** The start-up zero fill's end (literal) and the 44 bytes before the heap. */
const ZERO_FILL_END = 0x53000460;
/**
 * The key mapper (hardware keys to a screen's commands) reads the current controller id at these
 * two calls of the getter (0x5325CA14): 0x53255A0C tells whether the screen has a key map of its
 * own, 0x532544A4 picks it. Unknown ids get a generic map that, for the End Screen list, loses
 * every key (on the camera: no key worked in the picture list, touch did).
 */
const KEY_MAP_ID_READS = [0x53255a20, 0x532544c0] as const;
const CURRENT_ID = 0x5325ca14;
/** Nonzero while the End Screen list is the picture list (set by the controller factory). */
const PICTURE_MODE = 0x558372f0;
const APDATA_BOUND_AT = 0x53a80adc;
const APDATA_BOUND_NEXT = 0x53a80ae0;
const CTX_MAGIC = 0x31445347; // 'GSD1'
const CTX_BYTES = 6 * 4 + 4 * 2 + SHUTDOWN_MAX_PICTURES * 2 + SHUTDOWN_MAX_PICTURES * 4 * 2;
/** The factory row's text per row of the text catalog (0 Japanese, 18 / 19 Traditional / Simplified Chinese, others English; every glyph is in the camera's own texts of that language). */
const FACTORY_LABELS: Readonly<Record<number, string>> = { 0: 'オリジナル', 18: '原廠', 19: '原厂' };
/**
 * The submenu's line names per row of the text catalog (ja en fr de es pt it nl da sv fi pl cs hu tr
 * el ru ko zh-TW zh-CN th, as the program indexes languages); every glyph is in the camera's own
 * texts of that language. "Type" as the camera's "Type1" (text 6) without the number.
 */
export const SHUTDOWN_TYPE_NAMES: readonly string[] = [
  'タイプ', 'Type', 'Type', 'Typ', 'Tipo', 'Tipo', 'Tipo', 'Type', 'Type', 'Typ', 'Tyyppi',
  'Typ', 'Typ', 'Típus', 'Tip', 'Τύπος', 'Тип', '유형', '類型', '类型', 'แบบ',
];
export const SHUTDOWN_PICTURE_NAMES: readonly string[] = [
  '画像', 'Picture', 'Image', 'Bild', 'Imagen', 'Imagem', 'Immagine', 'Afbeelding', 'Billede', 'Bild', 'Kuva',
  'Obraz', 'Obrázek', 'Kép', 'Resim', 'Εικόνα', 'Изображение', '이미지', '圖片', '图片', 'ภาพ',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

export function shutdownPath(index: number): string {
  return `A:\\Resource\\Jpeg\\GRMOD${index + 1}.jpg`;
}

export function validateShutdownName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (name.length > SHUTDOWN_NAME_MAX) return 'too-long';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!(c >= 0x20 && c <= 0x7e)) return 'bad-char';
  }
  return null;
}

/**
 * The menu thumbnail of a 720x480 picture: scaled to 300x200 (area average) in the middle of a
 * black 520x200 RGBA icon, fully opaque.
 */
export function shutdownThumbnail(jpeg: Uint8Array): Uint8Array {
  const { width, height, rgb } = decodeBaselineJpeg(jpeg);
  if (width !== SHUTDOWN_WIDTH || height !== SHUTDOWN_HEIGHT) fail('bad-picture', 'a power-off picture is 720 x 480');
  const tw = Math.round((PREVIEW_HEIGHT * width) / height);
  const th = PREVIEW_HEIGHT;
  const x0 = Math.floor((PREVIEW_WIDTH - tw) / 2);
  const out = new Uint8Array(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const sx = width / tw, sy = height / th;
  for (let y = 0; y < th; y++) {
    const ya = y * sy, yb = ya + sy;
    for (let x = 0; x < tw; x++) {
      const xa = x * sx, xb = xa + sx;
      let r = 0, g = 0, b = 0, w = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
          const ww = wy * (Math.min(xb, xx + 1) - Math.max(xa, xx));
          const s = (yy * width + xx) * 3;
          r += rgb[s] * ww; g += rgb[s + 1] * ww; b += rgb[s + 2] * ww; w += ww;
        }
      }
      const o = (y * PREVIEW_WIDTH + x0 + x) * 4;
      out[o] = Math.round(r / w); out[o + 1] = Math.round(g / w); out[o + 2] = Math.round(b / w);
    }
  }
  return out;
}

/** Problems of a list of pictures (empty when it can be built). */
export function checkShutdownPictures(pictures: readonly ShutdownPictureSpec[]): void {
  if (!(pictures.length >= 1 && pictures.length <= SHUTDOWN_MAX_PICTURES)) fail('too-many-pictures', `1 to ${SHUTDOWN_MAX_PICTURES} power-off pictures`);
  const ids = new Set<number>();
  pictures.forEach((s, k) => {
    if (!(Number.isInteger(s.id) && s.id >= 1 && s.id <= 0xffffffff) || ids.has(s.id)) fail('bad-picture', `power-off picture ${k + 1}: identity`);
    ids.add(s.id);
    const problem = validateShutdownName(s.name);
    if (problem) fail('bad-name', `power-off picture ${k + 1}: name is ${problem}`);
    if (!(s.jpeg instanceof Uint8Array) || s.jpeg.length !== SHUTDOWN_JPEG_BYTES) fail('bad-picture', `power-off picture ${k + 1}: JPEG of ${SHUTDOWN_JPEG_BYTES} bytes expected`);
  });
}

/** The RES files of the pictures, in list order. */
export function shutdownFiles(pictures: readonly ShutdownPictureSpec[]): { path: string; data: Uint8Array }[] {
  return pictures.map((s, k) => ({ path: shutdownPath(k), data: s.jpeg }));
}

/**
 * Install the pictures' menu into an RTOS image that has the catalog scaffold of `build.ts`.
 * `factoryJpegs` are the four factory pictures (FACTORY_PICTURES order) from the payload's RES
 * section, for their thumbnails. Returns the new ICONBIN data. The RES files themselves are added
 * by `growPayload` (`shutdownFiles`).
 */
export function installShutdownMenu(p: Patch, iconbin: Uint8Array, pictures: readonly ShutdownPictureSpec[], factoryJpegs: readonly Uint8Array[]): Uint8Array {
  checkShutdownPictures(pictures);
  if (factoryJpegs.length !== FACTORY_PICTURES.length) fail('internal', 'four factory pictures expected');
  if (p.textBoundSites.length === 0) fail('internal', 'the catalog scaffold is not installed');
  const n = pictures.length;

  // --- Thumbnails (icons): factory 992..995, pictures 996...
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  const thumbs = [...factoryJpegs.map((j) => shutdownThumbnail(j)), ...pictures.map((s) => shutdownThumbnail(s.jpeg))];
  const iconIds: number[] = [];
  thumbs.forEach((px, i) => {
    const id = SHUTDOWN_ICON_ID + i;
    const pad = (4 - (length % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    expectWord(p, ICON_CATALOG + id * 4, 0);
    const desc = p.append(concat([u16le([1, PREVIEW_WIDTH, PREVIEW_HEIGHT, 0]), u32le([length / 4])]), 16);
    p.setWord(ICON_CATALOG + id * 4, desc, 'power-off picture thumbnail');
    parts.push(px);
    length += px.length;
    iconIds.push(id);
  });
  const lastIcon = iconIds[iconIds.length - 1];
  for (const [site, r] of LOOKUP_BOUNDS) p.setWord(site, movWord(r, Math.max(lastIcon, movImmediate(p.word(site)))), 'icon upper bound');

  // --- Texts: the line names and the factory row per language, then the names (the same in every language).
  const desc = (text: string): number => {
    const encoded = utf16z(text);
    const at = p.append(encoded, 4);
    return p.append(concat([Uint8Array.from([encoded.length / 2, 1, 0, 0]), u32le([at])]), 4);
  };
  const english = desc('Original');
  const own: Record<number, number> = {};
  for (const [row, text] of Object.entries(FACTORY_LABELS)) own[Number(row)] = desc(text);
  const names = pictures.map((s) => desc(s.name));
  for (let l = 0; l < 21; l++) {
    const row = p.word(TEXT_CATALOG + l * 4);
    for (let k = 0; k < 3 + n; k++) expectWord(p, row + (SHUTDOWN_TEXT_ID + k) * 4, 0);
    p.write(row + SHUTDOWN_TEXT_ID * 4, u32le([desc(SHUTDOWN_TYPE_NAMES[l]), desc(SHUTDOWN_PICTURE_NAMES[l]), own[l] ?? english, ...names]));
  }
  const lastText = SHUTDOWN_FACTORY_TEXT + n;
  for (const site of p.textBoundSites) p.setWord(site, movWord(3, Math.max(lastText, movImmediate(p.word(site)))), 'text upper bound');

  // --- The table of full-screen JPEGs, extended.
  const original = p.readMapped(JPEG_TABLE, JPEG_TABLE_COUNT * 4);
  const entries = pictures.map((_, k) => {
    const path = p.append(concat([Uint8Array.from(shutdownPath(k), (c) => c.charCodeAt(0)), new Uint8Array(1)]), 4);
    return p.append(concat([u16le([SHUTDOWN_WIDTH, SHUTDOWN_HEIGHT]), u32le([path])]), 4);
  });
  const table = p.append(concat([original, u32le(entries)]), 16);
  for (const [low, high, r] of TABLE_SITES) {
    expectWord(p, low, movWord(r, JPEG_TABLE & 0xffff));
    expectWord(p, high, movWord(r, JPEG_TABLE >>> 16, true));
    p.setWord(low, movWord(r, table & 0xffff), 'full-screen JPEG table with the power-off pictures');
    p.setWord(high, movWord(r, table >>> 16, true), 'full-screen JPEG table with the power-off pictures');
  }

  // --- Module, context, stubs.
  expectWord(p, BACKGROUND, 0xe1a0c00d);
  expectWord(p, MENU.refresh, 0xe1a0c00d);
  expectWord(p, MENU.confirm, 0xe5900168);
  expectWord(p, MENU.left, 0xe1a0c00d);
  expectWord(p, MENU.right, 0xe1a0c00d);
  expectWord(p, MENU.footer, 0xe1a0c00d);
  expectWord(p, MENU_ROWS_AT, 0xe3a02002); // mov r2, #2
  expectWord(p, MENU_TYPES_AT, 0xe54b3034); // strb r3, [fp, #-0x34]
  expectWord(p, APDATA_BOUND_AT, 0xe58d9000);
  // The factory's End Screen case: one object, cached at +0x180.
  for (const [at, w] of [[0x53187784, 0xe5940180], [0x53187790, 0xe3a00f5b], [0x53187794, 0xeb1d6485], [0x5318779c, 0xeb0271c4]] as const) expectWord(p, at, w);
  expectWord(p, 0x53223e9c, movWord(1, END_SCREEN_TITLE)); // its constructor's title
  for (const f of [LIST_SHOWN, TITLE_SET, APP, 0x5323f378, 0x5323f018, SUBMENU_LINE_TEXT, LINE_VALUE_ICON, LINE_TITLE]) expectWord(p, f, 0xe1a0c00d);
  expectWord(p, 0x5329c2d8, 0xe5d00988); // ldrb r0, [r0, #0x988]
  expectWord(p, 0x53380874, 0xe3510000); // cmp r1, #0
  expectWord(p, ZERO_FILL_END, p.word(ZERO_FILL_END) === 0x55837300 ? 0x55837300 : 0x558372d4);
  const priorSave = branchTarget(SETTINGS_SAVE, p.word(SETTINGS_SAVE));
  if (priorSave < BASE + OFFICIAL_RTOS_LENGTH) fail('internal', 'the settings save/load scaffold is not installed');
  // Setup > Display > End Screen, as officially.
  const setup = p.read(SETUP_MENU, 0x38c);
  const sv = new DataView(setup.buffer);
  if (new DataView(p.readMapped(SETUP_MENU_ENTRY, 4).buffer).getUint32(0, true) !== SETUP_MENU || setup[0x8b] !== 31
    || sv.getUint32(0x1bc + SETUP_ITEM * 4, true) !== END_SCREEN_ID || sv.getUint32(0x8c + SETUP_ITEM * 8, true) !== SETUP_ITEM_DRAW) {
    fail('unexpected-layout', 'Setup menu is not the official one');
  }
  for (let i = 0; i < 38; i++) {
    const id = sv.getUint32(0x1bc + i * 4, true);
    if (id === SHUTDOWN_MENU_ID || id === SHUTDOWN_PICTURE_ID) fail('unexpected-layout', 'controller id already in use');
  }

  const raw = Uint8Array.from(atob(SHUTDOWN_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== SHUTDOWN_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'power-off module length');
  const code = p.append(raw, 16);
  const body = p.append((at) => [0xe1a0c00d, branchWord(at + 4, BACKGROUND_BODY)], 16);
  const ctxBytes = new Uint8Array(CTX_BYTES);
  const v = new DataView(ctxBytes.buffer);
  [CTX_MAGIC, SHUTDOWN_RECORD, n, SHUTDOWN_FACTORY_TEXT, body, priorSave].forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  let o = 24;
  for (let i = 0; i < 4; i++, o += 2) v.setUint16(o, iconIds[i], true);
  for (let k = 0; k < SHUTDOWN_MAX_PICTURES; k++, o += 2) v.setUint16(o, k < n ? iconIds[4 + k] : 0, true);
  for (let k = 0; k < SHUTDOWN_MAX_PICTURES; k++, o += 4) v.setUint32(o, k < n ? pictures[k].id >>> 0 : 0, true);
  for (let k = 0; k < SHUTDOWN_MAX_PICTURES; k++, o += 4) v.setUint32(o, k < n ? JPEG_TABLE_COUNT + k : 0, true);
  const ctx = p.append(ctxBytes, 16);
  const stub = (reg: number, fn: keyof typeof SHUTDOWN_EXPORTS): number =>
    p.append((at) => [movWord(reg, ctx & 0xffff), movWord(reg, ctx >>> 16, true), branchWord(at + 8, code + SHUTDOWN_EXPORTS[fn])], 16);
  p.setWord(BACKGROUND, branchWord(BACKGROUND, stub(1, 'sd_background')), 'power-off picture: the one chosen in the menu');
  p.setWord(SETTINGS_SAVE, branchWord(SETTINGS_SAVE, stub(1, 'sd_save')), 'settings save, then the power-off picture choice');

  // One End Screen list, two modes: opened as SHUTDOWN_PICTURE_ID it is the picture list (PICTURE_MODE
  // set), as 0x020000C4 the camera's own list. The camera has one controller object per kind of
  // list and routes keys and touches to it; the date imprint's lists share the camera's in the same way.
  const MODE = `movw ip, #${PICTURE_MODE & 0xffff}; movt ip, #${PICTURE_MODE >>> 16}; ldr ip, [ip]; cmp ip, #0`;
  const handler = (at: number, original: string, reg: number, fn: keyof typeof SHUTDOWN_EXPORTS, what: string): void => {
    const target = p.append((a) => assembleWords(
      `${MODE}; beq native
       movw r${reg}, #${ctx & 0xffff}; movt r${reg}, #${ctx >>> 16}; b #${code + SHUTDOWN_EXPORTS[fn]}
       native: ${original}; b #${at + 4}`, a), 16);
    p.setWord(at, branchWord(at, target), what);
  };
  handler(MENU.confirm, 'ldr r0, [r0, #0x168]', 1, 'sd_confirm', 'End Screen picture list: confirm');
  handler(MENU.left, 'mov ip, sp', 2, 'sd_left', 'End Screen picture list: up');
  handler(MENU.right, 'mov ip, sp', 2, 'sd_right', 'End Screen picture list: down');
  handler(MENU.footer, 'mov ip, sp', 1, 'sd_footer', 'End Screen picture list: thumbnail');
  // Refresh (run when the list opens): the rows shown (2, or 1 + n) and the title of the mode, then
  // the module's rows and ticks or the official ones.
  const activate = p.append((a) => assembleWords(
    `push {r4, lr}
     mov r4, r0
     ${MODE}
     ldr r0, [r4, #0x168]; moveq r1, #2; movne r1, #${1 + n}
     bl #${LIST_SHOWN}
     ${MODE}
     ldr r0, [r4, #0x15c]; movweq r1, #${END_SCREEN_TITLE}; movwne r1, #${SHUTDOWN_PICTURE_TEXT}
     bl #${TITLE_SET}
     ${MODE}
     mov r0, r4
     pop {r4, lr}
     beq native
     movw r1, #${ctx & 0xffff}; movt r1, #${ctx >>> 16}; b #${code + SHUTDOWN_EXPORTS.sd_refresh}
     native: mov ip, sp; b #${MENU.refresh + 4}`, a), 16);
  p.setWord(MENU.refresh, branchWord(MENU.refresh, activate), 'End Screen list: rows and title of the mode, then rows and ticks');
  // The constructor makes 1 + n rows (at least the official 2), their types from an appended array
  // (the official one is 2 bytes on the stack).
  const types = p.append(new Uint8Array(1 + n).fill(ROW_TYPE), 4);
  p.setWord(MENU_ROWS_AT, (0xe3a02000 | (1 + n)) >>> 0, 'End Screen list: rows for the picture list');
  const typesAt = p.append((a) => [0xe54b3034, movWord(1, types & 0xffff), movWord(1, types >>> 16, true), branchWord(a + 12, MENU_TYPES_AT + 4)], 16);
  p.setWord(MENU_TYPES_AT, branchWord(MENU_TYPES_AT, typesAt), 'End Screen list: row types');

  // The key mapper sees the picture list as the End Screen list.
  for (const at of KEY_MAP_ID_READS) expectWord(p, at, branchWord(at, CURRENT_ID, 14, true));
  const keyMapId = p.append((a) => assembleWords(
    `push {r4, lr}
     bl #${CURRENT_ID}
     movw r4, #${SHUTDOWN_PICTURE_ID & 0xffff}; movt r4, #${SHUTDOWN_PICTURE_ID >>> 16}
     cmp r0, r4
     movweq r0, #${END_SCREEN_ID & 0xffff}; movteq r0, #${END_SCREEN_ID >>> 16}
     pop {r4, pc}`, a), 16);
  for (const at of KEY_MAP_ID_READS) p.setWord(at, branchWord(at, keyMapId, 14, true), 'key map: the picture list has the End Screen list\'s keys');
  expectWord(p, CURRENT_ID, 0xe5900000); // ldr r0, [r0]

  // The controllers: the submenu (as every submenu's); the picture list is the End Screen list in
  // picture mode, the End Screen list itself in its own mode.
  hookControllerFactory(p, `movw ip, #${SHUTDOWN_MENU_ID & 0xffff}; movt ip, #${SHUTDOWN_MENU_ID >>> 16}
     cmp r1, ip; bne picture
     movw r1, #${SUBMENU_CONTROLLER_ID & 0xffff}; movt r1, #${SUBMENU_CONTROLLER_ID >>> 16}; b prior
     picture: add ip, ip, #${SHUTDOWN_PICTURE_ID - SHUTDOWN_MENU_ID}; cmp r1, ip; bne own
     movw r1, #${END_SCREEN_ID & 0xffff}; movt r1, #${END_SCREEN_ID >>> 16}
     mov ip, #1; b mode
     own: movw ip, #${END_SCREEN_ID & 0xffff}; movt ip, #${END_SCREEN_ID >>> 16}; cmp r1, ip; bne prior
     mov ip, #0
     mode: movw r3, #${PICTURE_MODE & 0xffff}; movt r3, #${PICTURE_MODE >>> 16}; str ip, [r3]
     b prior`, 'End Screen submenu; the End Screen list as picture list');

  // The submenu: "Type" (the camera's list, its value as the native line shows it), "Picture".
  const lineType = p.append((a) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r4, r1
     bl #${APP}; bl #0x5323f378; mov r5, r0
     bl #${APP}; bl #0x5323f018; bl #0x5329c2d8
     mov r1, r0; add r0, r5, #4; bl #0x53380874
     mov r1, r0; mov r0, r4
     pop {r4, r5, r6, lr}
     b #${SUBMENU_LINE_TEXT}`, a), 16);
  const record = submenuTemplate(p);
  {
    const r = new DataView(record.buffer);
    r.setUint16(2, END_SCREEN_TITLE, true);
    r.setUint16(8, SHUTDOWN_TYPE_TEXT, true);
    r.setUint16(10, SHUTDOWN_PICTURE_TEXT, true);
    r.setUint32(0x14, END_SCREEN_ID, true);
    r.setUint32(0x18, SHUTDOWN_PICTURE_ID, true);
    r.setUint32(0x3c, lineType, true);
    r.setUint32(0x40, 0, true);
    r.setUint32(0x44, stub(2, 'sd_line'), true);
    r.setUint32(0x48, 0, true);
  }
  addSubmenuRecord(p, SHUTDOWN_MENU_ID, record, 'End Screen submenu');
  // Setup's line: opens the submenu, drawn as Setup's other submenu lines.
  const setupLine = p.append((a) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     mov r0, r4; mov r1, #0; bl #${LINE_VALUE_ICON}
     mov r0, r4; movw r1, #${END_SCREEN_TITLE}
     pop {r4, lr}
     b #${LINE_TITLE}`, a), 16);
  p.setWord(SETUP_MENU + 0x8c + SETUP_ITEM * 8, setupLine, 'Setup > End Screen: line of a submenu');
  p.setWord(SETUP_MENU + 0x1bc + SETUP_ITEM * 4, SHUTDOWN_MENU_ID, 'Setup > End Screen: opens the submenu');

  // The settings store APData with room for the choice's record.
  // movw r3,#records; str r3,[sp] (the count argument); continue after the original `str sb,[sp]`.
  const bound = p.append((at) => [movWord(3, SHUTDOWN_RECORD + 1), 0xe58d3000, branchWord(at + 8, APDATA_BOUND_NEXT)], 16);
  p.setWord(APDATA_BOUND_AT, branchWord(APDATA_BOUND_AT, bound), 'settings store APData: room for the power-off picture record');
  if (p.word(ZERO_FILL_END) !== 0x55837300) p.setWord(ZERO_FILL_END, 0x55837300, 'start-up zero fill also clears the 44 unused bytes before the heap');
  return concat(parts);
}

/** What a built image holds: the pictures' identities and names (their JPEGs are RES files), or null. */
export function readShutdownMenu(p: Patch): { id: number; name: string }[] | null {
  try {
    const first = p.word(BACKGROUND);
    if (first >>> 24 !== 0xea) return null;
    const stub = branchTarget(BACKGROUND, first);
    const ctx = (movImmediate(p.word(stub)) | (movImmediate(p.word(stub + 4)) << 16)) >>> 0;
    const v = new DataView(p.read(ctx, CTX_BYTES).buffer);
    if (v.getUint32(0, true) !== CTX_MAGIC || v.getUint32(4, true) !== SHUTDOWN_RECORD) return null;
    const n = v.getUint32(8, true);
    const textId = v.getUint32(12, true);
    if (!(n >= 1 && n <= SHUTDOWN_MAX_PICTURES) || textId !== SHUTDOWN_FACTORY_TEXT) return null;
    const row = p.word(TEXT_CATALOG + 1 * 4);
    const out: { id: number; name: string }[] = [];
    for (let k = 0; k < n; k++) {
      const id = v.getUint32(24 + 8 + 2 * SHUTDOWN_MAX_PICTURES + 4 * k, true);
      const d = p.word(row + (textId + 1 + k) * 4);
      const units = p.read(d, 1)[0];
      const at = p.word(d + 4);
      const bytes = p.read(at, units * 2);
      let name = '';
      for (let i = 0; i < units - 1; i++) name += String.fromCharCode(bytes[2 * i] | (bytes[2 * i + 1] << 8));
      out.push({ id, name });
    }
    return out;
  } catch {
    return null;
  }
}

/** The four factory pictures (FACTORY_PICTURES order) from a payload's RES section. */
export function factoryShutdownJpegs(payload: Uint8Array): Uint8Array[] {
  const dir = readRes(payload);
  return FACTORY_PICTURES.map((f) => {
    const data = resFile(payload, f.path, dir);
    if (!data) fail('unexpected-layout', `RES has no ${f.path}`);
    return data;
  });
}

/** The power-off pictures' JPEGs in a grown payload's RES section (list order), or null. */
export function readShutdownJpegs(payload: Uint8Array, count: number): Uint8Array[] | null {
  try {
    const dir = readRes(payload);
    const out: Uint8Array[] = [];
    for (let k = 0; k < count; k++) {
      const data = resFile(payload, shutdownPath(k), dir);
      if (!data || data.length !== SHUTDOWN_JPEG_BYTES) return null;
      out.push(data);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A 720x480 RGB picture (3 bytes per pixel) as a power-off picture file: baseline JPEG, 4:2:2 like
 * the factory HDF picture, at the highest standard quality (IJG scale, 1..100) that fits, padded
 * to exactly SHUTDOWN_JPEG_BYTES bytes with comment segments (FF FE) after SOI, which decoders
 * skip. Deterministic. Throws 'bad-picture' when even quality 1 does not fit.
 */
export function encodeShutdownPicture(rgb: Uint8Array | Uint8ClampedArray, onProgress?: (f: number) => void): Uint8Array {
  if (rgb.length !== SHUTDOWN_WIDTH * SHUTDOWN_HEIGHT * 3) fail('bad-picture', 'a power-off picture is 720 x 480 RGB');
  const layout = makeLayout(SHUTDOWN_WIDTH, SHUTDOWN_HEIGHT, '422');
  const coef = forwardTransform(rgb, layout);
  const at = (q: number): Uint8Array => {
    const [l, c] = qualityTables(q);
    return encodeCoefficients(coef, layout, l, c);
  };
  // Room for at least one comment segment (4 bytes).
  const room = SHUTDOWN_JPEG_BYTES - 4;
  let best = at(1);
  if (best.length > room) fail('bad-picture', 'the picture is too detailed for a power-off picture');
  let lo = 2, hi = 100, steps = 0;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const data = at(q);
    onProgress?.(Math.min(0.95, ++steps / 8));
    if (data.length <= room) { best = data; lo = q + 1; } else hi = q - 1;
  }
  const out = padJpeg(best, SHUTDOWN_JPEG_BYTES);
  onProgress?.(1);
  return out;
}

/** `jpeg` (starting with SOI) made exactly `length` bytes by comment segments after SOI (each 4..65537 bytes). */
function padJpeg(jpeg: Uint8Array, length: number): Uint8Array {
  let pad = length - jpeg.length;
  if (pad < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('internal', 'cannot pad the picture');
  const segments: Uint8Array[] = [];
  while (pad > 0) {
    // a segment is 2 marker bytes + its length field value (2..65535); never leave 1..3 bytes over
    let size = Math.min(pad, 65537);
    if (pad - size > 0 && pad - size < 4) size -= 4;
    const seg = new Uint8Array(size);
    seg[0] = 0xff; seg[1] = 0xfe; seg[2] = (size - 2) >> 8; seg[3] = (size - 2) & 0xff;
    segments.push(seg);
    pad -= size;
  }
  return concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}
