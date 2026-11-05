// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60, round 6: power-off pictures chosen as on GR IV (../aspect/shutdown.ts).
 * Setup > Display > End Screen opens a submenu (title "End Screen") of two lines:
 *
 *   Type      Type1        the camera's own End Screen list (Type1 / Type2), unchanged;
 *   Picture   <current>    "Original" and the added pictures (1..8, by name), a 520 x 200
 *                          thumbnail of the focused row above the list.
 *
 * The camera side is tools/gr3x/native/endscreen.c (see there for the list, the choice and where it
 * is kept). Read from the official 2.10 code:
 *  - The End Screen list is GoodByeDisplaySetController (vtable 0x53b4d248, constructor 0x532047d4,
 *    one object cached by the controller factory at +0x180, 0x5316ff88): list widget +0x168, footer
 *    graphic +0x164, title view +0x15c. Its rows are built once (0x532044c0: `mov r2,#2` rows, their
 *    types two bytes 0x15 on the stack, 0x532044f4); refresh (0x532049fc), confirm (0x532048c4, then
 *    the caller closes the list), up / down (0x53204834 / 0x53204878) and footer (0x53204ab0) are
 *    its handlers. As on GR IV, one object serves both lists: PICTURE_MODE (the third word of the
 *    12 bytes between the zero-filled data and the heap, cleared at every start by the extended
 *    start-up fill) is set when the factory is asked for the picture list and cleared when asked
 *    for the End Screen list; the list is built with 1 + n rows, refresh shows 2 or 1 + n of them
 *    and the title of the mode, and in picture mode the handlers go to the module.
 *  - The submenu: a SubMenuController record (datestamp.ts adds it after the date imprint's, as
 *    D-Range Correction's record 6) titled End Screen (text 665), lines Type (0x020000ad, its value
 *    drawn as Setup's native End Screen line 0x531987c8 does) and Picture (GR3X_PICTURE_LIST_ID).
 *  - Setup's descriptor (0x53b36a54) is copied with item 10 opening the submenu (GR3X_PICTURE_MENU_ID)
 *    and drawn as Setup's other submenu lines (no value, the title); the menu table's Setup entry
 *    points at the copy.
 *  - The factory and the key map (datestamp.ts) give the submenu D-Range's submenu controller and
 *    keys, the picture list the End Screen list's (setting PICTURE_MODE).
 *  - The picture: at 0x5319f208 (after the camera chose r7, its own picture's number) es_pick, and
 *    the full-screen JPEG table copied with the pictures (shutdown.ts, as round 5).
 */
import { decodeBaselineJpeg } from '../../jpeg/decoder';
import { assembleWords, branchWord, movWord, wordsToBytes } from '../aspect/arm';
import { FirmwareError } from '../types';
import { GR3X_ENDSCREEN_NATIVE } from './endscreen-native';
import { GR3X_ENDSCREEN2_NATIVE } from './endscreen2-native';
import { gr3xSettingsHook, gr3xSettingsPrior } from './round10';
import type { Gr3xSite } from './round10';
/** Round 10: the HTData record of the choice (GR IV: its APData record; the films' table is 12). */
export const GR3X_END_SCREEN_RECORD = 13;

export const GR3X_PICTURE_LIST_ID = 0x020001a4;
/** The third word of the gap before the heap (zeroed at start by the extended fill). */
export const GR3X_PICTURE_MODE = 0x5580437c;
export const GR3X_END_SCREEN_ID = 0x020000ad;
export const GR3X_PREVIEW_W = 520, GR3X_PREVIEW_H = 200;
/** The camera's own power-off pictures by variant (0x5319f180: 0 GoodBye, 1 Collabo, 2..4). */
export const GR3X_FACTORY_PICTURES = [
  'B:\\Resource\\Jpeg\\GoodBye.jpg', 'B:\\Resource\\Jpeg\\Collabo.jpg', 'B:\\Resource\\Jpeg\\GB_Urban.jpg',
  'B:\\Resource\\Jpeg\\GB_ING.jpg', 'B:\\Resource\\Jpeg\\GB_Diary.jpg',
] as const;
/** GR IV's line names (shutdown.ts), every glyph in GR III's own texts of that language. */
export const GR3X_TYPE_NAMES: readonly string[] = [
  'タイプ', 'Type', 'Type', 'Typ', 'Tipo', 'Tipo', 'Tipo', 'Type', 'Type', 'Typ', 'Tyyppi',
  'Typ', 'Typ', 'Típus', 'Tip', 'Τύπος', 'Тип', '유형', '類型', '类型', 'แบบ',
];
export const GR3X_PICTURE_NAMES: readonly string[] = [
  '画像', 'Picture', 'Image', 'Bild', 'Imagen', 'Imagem', 'Immagine', 'Afbeelding', 'Billede', 'Bild', 'Kuva',
  'Obraz', 'Obrázek', 'Kép', 'Resim', 'Εικόνα', 'Изображение', '이미지', '圖片', '图片', 'ภาพ',
];

const CTX_MAGIC = 0x33455347; // 'GSE3'
const CTX_MAGIC_R10 = 0x34455347; // 'GSE4'
const MAX = 8, FACTORY = 5;
const CTX_BYTES = 12 + FACTORY * 2 + MAX * 2 + 2 + MAX * 4 * 2;
const REFRESH = 0x532049fc, CONFIRM = 0x532048c4, UP = 0x53204834, DOWN = 0x53204878, FOOTER = 0x53204ab0;
const ROWS_AT = 0x532044c4, TYPES_AT = 0x532044f4, ROW_TYPE = 0x15, TITLE = 665;
const LIST_SHOWN = 0x53394e8c, TITLE_SET = 0x533a2ba0, GRAPHIC_VISIBLE = 0x533ad3c0, SUB_LINE_TEXT = 0x533a6ad0;
const APP = 0x5320ad88, UI_MODEL = 0x5320b67c, USERDATA = 0x5320b31c, END_SCREEN_GET = 0x53246b88, END_SCREEN_TEXT = 0x53293164;
const JOIN = 0x5319f208, JOIN_WORD = 0xe8950003;

export interface Gr3xEndScreenProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}
export interface Gr3xEndScreenOptions {
  /** Text of "Original"; the pictures' names follow it. The line names Type / Picture. */
  factoryText: number; typeText: number; pictureText: number;
  /** Thumbnails: the five factory pictures (by variant), then the added pictures. */
  factoryIcons: readonly number[]; icons: readonly number[];
  /** Stable identities and their numbers in the extended JPEG table. */
  choices: readonly number[]; resources: readonly number[];
  /** Round 8: the mode is the word's low byte (its upper bytes hold the date imprint's orientation
   * and frame look, look-addresses.ts): read and written as a byte. */
  modeByte?: boolean;
  /** Round 10 (GR IV's shutdown.c): the choice is HTData record 13, written on confirm and after
   * every settings save (through the settings scaffold, round10.ts). */
  r10?: { sites: Gr3xSite[]; u32(address: number): number };
}

const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const fail = (m: string): never => { throw new FirmwareError('unexpected-layout', `IIIx End Screen: ${m}`); };
const bl = (at: number, target: number) => (0xeb000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;

/** A 720 x 480 picture as the menu shows it: scaled to 300 x 200 (area average) in the middle of a
 * black, opaque 520 x 200 RGBA icon (as GR IV's, and GR III's own footer icons 19 / 20). */
export function gr3xPreview(jpeg: Uint8Array): Uint8Array {
  const { width, height, rgb } = decodeBaselineJpeg(jpeg);
  if (width !== 720 || height !== 480) throw new FirmwareError('bad-picture', 'a power-off picture is 720 x 480');
  const W = GR3X_PREVIEW_W, H = GR3X_PREVIEW_H, tw = 300, th = 200, x0 = (W - tw) / 2;
  const out = new Uint8Array(W * H * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const sx = width / tw, sy = height / th;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
      const s = (yy * width + xx) * 3; r += rgb[s]; g += rgb[s + 1]; b += rgb[s + 2]; n++;
    }
    out.set([Math.round(r / n), Math.round(g / n), Math.round(b / n), 255], (y * W + x0 + x) * 4);
  }
  return out;
}

export function gr3xEndScreenModule(r10 = false): Uint8Array {
  const raw = Uint8Array.from((r10 ? GR3X_ENDSCREEN2_NATIVE : GR3X_ENDSCREEN_NATIVE).code.match(/../g)!.map(x => parseInt(x, 16)));
  if (raw.length % 4) fail('module length');
  return raw;
}

/** The End Screen list's two modes, the picture choice at power off; returns the entries and the
 * submenu's line draws (Type, Picture) for its record. */
export function installGr3xEndScreen(p: Gr3xEndScreenProgram, o: Gr3xEndScreenOptions) {
  const n = o.choices.length;
  if (n < 1 || n > MAX || o.icons.length !== n || o.resources.length !== n || o.factoryIcons.length !== FACTORY ||
    new Set(o.choices).size !== n || o.choices.some(c => !(Number.isInteger(c) && c >= 1 && c <= 0xffffffff))) fail('pictures');
  const guards: readonly (readonly [number, number])[] = [
    [REFRESH, 0xe1a0c00d], [CONFIRM, 0xe5900168], [UP, 0xe1a0c00d], [DOWN, 0xe1a0c00d], [FOOTER, 0xe1a0c00d],
    [ROWS_AT, 0xe3a02002], [TYPES_AT, 0xe54b3034], [TYPES_AT - 4, 0xe3a03015], [TYPES_AT + 8, 0xe54b3033], [TYPES_AT + 0x10, bl(TYPES_AT + 0x10, 0x53394610)],
    [0x532047bc, movWord(1, TITLE)], [0x5316ff88, 0xe5940180], [0x5316ffa0, bl(0x5316ffa0, 0x532047d4)],
    [LIST_SHOWN, 0xe1a0c00d], [TITLE_SET, 0xe1a0c00d], [GRAPHIC_VISIBLE, 0xe5d0209e], [SUB_LINE_TEXT, 0xe1a0c00d],
    [APP, 0xe1a0c00d], [UI_MODEL, 0xe1a0c00d], [USERDATA, 0xe1a0c00d], [END_SCREEN_GET, 0xe5903004], [END_SCREEN_TEXT, 0xe3510000],
    // The native line (0x531987c8) as the Type line draws it.
    [0x531987ec, bl(0x531987ec, END_SCREEN_GET)], [0x531987f8, bl(0x531987f8, END_SCREEN_TEXT)],
    [JOIN, JOIN_WORD], [JOIN - 4, 0xe3a07002], [JOIN + 0x24, 0xe1a01007],
  ];
  for (const [at, w] of guards) if (p.word(at) !== w >>> 0) fail(`guard at ${at.toString(16)}`);
  const r10 = o.r10;
  const module = p.append(gr3xEndScreenModule(!!r10));
  const exportsOf = (r10 ? GR3X_ENDSCREEN2_NATIVE.exports : GR3X_ENDSCREEN_NATIVE.exports) as Record<string, number>;
  const fn = (name: keyof typeof GR3X_ENDSCREEN2_NATIVE.exports) => module + exportsOf[name];
  const ctxBytes = new Uint8Array(CTX_BYTES + (r10 ? 8 : 0)), v = new DataView(ctxBytes.buffer);
  [r10 ? CTX_MAGIC_R10 : CTX_MAGIC, n, o.factoryText].forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  let at = 12;
  for (let i = 0; i < FACTORY; i++, at += 2) v.setUint16(at, o.factoryIcons[i], true);
  for (let k = 0; k < MAX; k++, at += 2) v.setUint16(at, k < n ? o.icons[k] : 0, true);
  at += 2;
  for (let k = 0; k < MAX; k++, at += 4) v.setUint32(at, k < n ? o.choices[k] >>> 0 : 0, true);
  for (let k = 0; k < MAX; k++, at += 4) v.setUint32(at, k < n ? o.resources[k] : 0, true);
  if (r10) { v.setUint32(at, GR3X_END_SCREEN_RECORD, true); v.setUint32(at + 4, gr3xSettingsPrior(r10, 'save'), true); }
  const ctx = p.append(ctxBytes);
  const ctxIn = (r: number) => `movw r${r},#${lo(ctx)};movt r${r},#${hi(ctx)};`;
  const MODE = `movw ip,#${lo(GR3X_PICTURE_MODE)};movt ip,#${hi(GR3X_PICTURE_MODE)};${o.modeByte ? 'ldrb' : 'ldr'} ip,[ip];cmp ip,#0;`;
  const handler = (at: number, original: string, reg: number, name: keyof typeof GR3X_ENDSCREEN2_NATIVE.exports, what: string) => {
    const target = p.code(`${MODE}beq native;${ctxIn(reg)}b #${fn(name)};native:${original};b #${at + 4};`);
    p.patch(at, p.word(at), branchWord(at, target), what);
    return target;
  };
  const confirm = handler(CONFIRM, 'ldr r0,[r0,#0x168]', 1, 'es_confirm', 'End Screen picture list: confirm');
  const up = handler(UP, 'mov ip,sp', 2, 'es_up', 'End Screen picture list: up');
  const down = handler(DOWN, 'mov ip,sp', 2, 'es_down', 'End Screen picture list: down');
  const footer = handler(FOOTER, 'mov ip,sp', 1, 'es_footer', 'End Screen picture list: thumbnail');
  // Refresh (the list opens): rows shown and title of the mode (the footer graphic visible in the
  // camera's own mode), then the module's rows and ticks or the official ones.
  const refresh = p.code(`push {r4,lr};mov r4,r0;${MODE}
    ldr r0,[r4,#0x168];moveq r1,#2;movne r1,#${1 + n};bl #${LIST_SHOWN};
    ${MODE}ldr r0,[r4,#0x15c];movweq r1,#${TITLE};movwne r1,#${o.pictureText};bl #${TITLE_SET};
    ${MODE}bne mode;ldr r0,[r4,#0x164];mov r1,#1;bl #${GRAPHIC_VISIBLE};
    mode:${MODE}mov r0,r4;pop {r4,lr};beq native;${ctxIn(1)}b #${fn('es_refresh')};
    native:mov ip,sp;b #${REFRESH + 4};`);
  p.patch(REFRESH, 0xe1a0c00d, branchWord(REFRESH, refresh), 'End Screen list: rows and title of the mode, then rows and ticks');
  // 1 + n rows, their types from an appended array.
  const types = p.append(new Uint8Array(Math.max(2, 1 + n)).fill(ROW_TYPE));
  p.patch(ROWS_AT, 0xe3a02002, (0xe3a02000 | Math.max(2, 1 + n)) >>> 0, 'End Screen list: rows for the picture list');
  const typesAt = p.code(`strb r3,[fp,#-0x34];movw r1,#${lo(types)};movt r1,#${hi(types)};b #${TYPES_AT + 4};`);
  p.patch(TYPES_AT, 0xe54b3034, branchWord(TYPES_AT, typesAt), 'End Screen list: row types');
  // The power-off picture (r7 the camera's own number; r0, r1 loaded again after, as the original).
  const pick = p.code(`push {r0-r3,ip,lr};mov r0,r7;${ctxIn(1)}bl #${fn('es_pick')};mov r7,r0;pop {r0-r3,ip,lr};
    ldr r0,[r5];ldr r1,[r5,#4];b #${JOIN + 4};`);
  p.patch(JOIN, JOIN_WORD, branchWord(JOIN, pick), 'power-off pictures: the one chosen in the End Screen menu');
  // The submenu's lines (this r0, line r1): Type as Setup's native line shows the value, Picture.
  const lineType = p.code(`push {r4,r5,r6,lr};mov r4,r1;bl #${APP};bl #${UI_MODEL};mov r5,r0;bl #${APP};bl #${USERDATA};bl #${END_SCREEN_GET};
    mov r1,r0;mov r0,r5;bl #${END_SCREEN_TEXT};mov r1,r0;mov r0,r4;pop {r4,r5,r6,lr};b #${SUB_LINE_TEXT};`);
  const linePicture = p.code(`${ctxIn(2)}b #${fn('es_line')};`);
  void assembleWords; void wordsToBytes;
  // Round 10: after the settings save, the choice again (es_save calls the save it continues).
  const save = r10 ? p.code(`${ctxIn(1)}b #${fn('es_save')};`) : undefined;
  if (r10) gr3xSettingsHook(r10, 'save', save!, 'End Screen picture: the settings save, then its record');
  return { ...(save ? { endScreenSave: save } : {}), endScreenModule: module, endScreenContext: ctx, endScreenConfirm: confirm, endScreenUp: up, endScreenDown: down,
    endScreenFooter: footer, endScreenRefresh: refresh, endScreenTypes: types, endScreenTypesAt: typesAt, picturePick: pick,
    endScreenLineType: lineType, endScreenLinePicture: linePicture };
}
