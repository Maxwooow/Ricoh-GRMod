// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: power-off pictures (GR IV: ../aspect/shutdown.ts).
 *
 * GR IV replaces its End Screen line by a submenu and drives the camera's End Screen list in a
 * "picture mode" from a C module. GR III's End Screen list (vtable 0x53b4d248) is left exactly as
 * it is; the pictures get a line of their own, right after it in Setup > Display:
 *
 *   End Screen           Type1 / Type2      (official, unchanged)
 *   End Screen Picture   Original / <name>  (new: a list like the date imprint's, datestamp.ts)
 *
 *  - Setting: byte 0x9a3 of the user-settings record (*0x55063f34), the last padding byte between
 *    SetupMovieTransmit's flag (0x9a0) and SetupAutoPowerOff (0x9a4), next to the ADJ soft focus
 *    (0x9a1) and the date imprint (0x9a2), both camera-tested: saved, loaded and copied to U1-U3
 *    with the record, cleared by the defaults. 0 = the camera's own picture, k = added picture k
 *    (1..n); anything above n counts as, and is reset to, 0.
 *  - Setup menu: the descriptor (0x53b36a54, 30 items in 11 pages) is copied with the new line
 *    after End Screen (item 10) on the Display page (items 7..10 become 7..11; the later pages
 *    start one item later), and the menu table's Setup entry (0x55001ec8, initialised from
 *    0x5407d408; read only by the builder 0x5319a778) points at the copy.
 *  - The list: SelectMenuController record (datestamp.ts installs the list table, SetCurrentMenu,
 *    factory and key map for every added list), 1 + n values, each drawn with a 40x40 icon (the
 *    camera's OFF icon for the original, a thumbnail for the pictures) and its name.
 *  - The picture: GoodByeController::RequestBackgroundJpeg (0x5319f180) picks the full-screen JPEG
 *    by the camera variant (r7 = table index, 2 GoodBye / 3 Collabo / 10..12) and then requests it
 *    (0x5322e4a8). At 0x5319f208 (`ldm r5,{r0,r1}`, after every case) a stub replaces r7 by
 *    13 + k - 1 when picture k is chosen (r2, r3 are dead there; the original `ldm r5,{r0,r1}` becomes
 *    two loads). The table of full-screen JPEGs (13 pointers at
 *    0x55002b78, addressed only from 0x5322e4b4/0x5322e4bc) is copied with n more entries
 *    {720, 480, "A:\Resource\Jpeg\GRMODk.jpg"}.
 *  - The files: RES records of exactly two container frames each (as on GR IV), 720 x 480 baseline
 *    JPEG 4:2:0 like the factory pictures, added to the RES section after its A: files (before the
 *    first B: file). The camera's updater (DspFwUpdate, the firmware already installed) formats A:
 *    and writes every A: file of RES on a user update, B: files are skipped (the factory
 *    pictures there are never rewritten); flashing the official firmware again removes the pictures.
 */
import { decodeBaselineJpeg } from '../../jpeg/decoder';
import { encodeCoefficients, forwardTransform, makeLayout } from '../../jpeg/encoder';
import { qualityTables } from '../../jpeg/tables';
import { branchWord, movWord } from '../aspect/arm';
import { FirmwareError } from '../types';

export const GR3X_PICTURE_MENU_ID = 0x020001a3;
export const GR3X_PICTURE_OFFSET = 0x9a3;
export const GR3X_MAX_PICTURES = 8;
export const GR3X_PICTURE_NAME_MAX = 20;
export const GR3X_PICTURE_WIDTH = 720;
export const GR3X_PICTURE_HEIGHT = 480;
/** Every picture file with its 36-byte RES header: two container frames. */
export const GR3X_PICTURE_JPEG_BYTES = 2 * 0x6000 - 36;
/** The pictures go into RES before this file (the first of the B: drive). */
export const GR3X_RES_BEFORE = 'B:\\Resource\\Jpeg\\AlpKey.jpg';
/** Most files RES may list: the camera's updater (0x5362a4c0) steps past RES by the file count in
 * BYTES and reads a section header there (inside the first file, DF_EX.bin); counts up to 68 land
 * on harmless bytes of the official file (simulated), 35 + 8 pictures is 43. */
export const GR3X_RES_MAX_FILES = 43;

const SETTINGS_POINTER = 0x55063f34;
const SETUP_MENU = 0x53b36a54, SETUP_ENTRY_IMAGE = 0x5407d408, SETUP_ENTRY_RAM = 0x55001ec8;
const DESCRIPTOR = 0x384, MAX_ITEMS = 38;
const D_PAGES = 0x68, D_FIRST = 0x80, D_COUNT = 0x8b, D_DRAW = 0x8c, D_ID = 0x1bc, D_VISIBLE = 0x254;
const SETUP_ITEMS = 30, END_SCREEN_ITEM = 10, END_SCREEN_ID = 0x020000ad, END_SCREEN_DRAW = 0x531987c8, END_SCREEN_TITLE = 665;
const SETUP_FIRSTS = [0, 7, 11, 13, 15, 17, 20, 23, 25, 27, 29];
/** The id of an unused item slot. */
const NO_ITEM = 0x10000000;
const SETUP_FIRSTS_NEW = [0, 7, 12, 14, 16, 18, 21, 24, 26, 28, 30];
const LINE_VALUE_TEXT = 0x5339de6c, TOP_SET_TITLE = 0x5339dc70, LIST_SET_ITEM = 0x5339e8b0;
const ICON_OFF = 344;
const REQUEST = 0x5319f180, JOIN = 0x5319f208, JOIN_WORD = 0xe8950003;
const JPEG_TABLE = 0x55002b78, JPEG_TABLE_IMAGE = 0x5407e0b8, JPEG_TABLE_COUNT = 13;
const JPEG_TABLE_SITE: readonly [number, number, number] = [0x5322e4b4, 0x5322e4bc, 12];
const PLAYBACK_JPEG = 0x5322e4a8;

/** The line name per text row (ja en fr de es pt it nl da sv fi pl cs hu tr el ru ko zh-TW zh-CN th). */
export const GR3X_PICTURE_LINE_NAMES: readonly string[] = [
  '終了画面の画像', 'End Screen Picture', 'Image de fin', 'Endbild', 'Imagen final', 'Imagem final', 'Immagine finale',
  'Eindafbeelding', 'Slutbillede', 'Slutbild', 'Päätöskuva', 'Obraz końcowy', 'Finální obrázek', 'Záró kép', 'Son resim',
  'Τελική εικόνα', 'Конечное изображение', '종료 이미지', '結束畫面圖片', '结束画面图片', 'ภาพหน้าจอสุดท้าย',
];
/** The camera's own picture, per text row (every glyph is in the camera's own texts of that language). */
export const GR3X_PICTURE_ORIGINAL: readonly string[] = GR3X_PICTURE_LINE_NAMES.map((_, row) =>
  row === 0 ? 'オリジナル' : row === 18 || row === 19 ? '原始' : 'Original');

export const GR3X_JPEG_TABLE_COUNT = 13;
export interface Gr3xPictureSpec {
  /** Round 6 (End Screen submenu): stable identity 1..0xffffffff, what the camera remembers. */
  id?: number;
  /** Name in the camera's list: 1..GR3X_PICTURE_NAME_MAX printable ASCII characters. */
  name: string;
  /** 720 x 480 baseline JPEG (4:2:0) of exactly GR3X_PICTURE_JPEG_BYTES bytes (encodeGr3xPicture). */
  jpeg: Uint8Array;
}
export interface Gr3xPictureIds {
  title: number;
  original: number;
  names: readonly number[];
  icons: readonly number[];
}
export interface Gr3xPictureProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
  read(address: number, size: number): Uint8Array;
}

const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const fail = (code: string, message: string): never => { throw new FirmwareError(code, message); };
const u32 = (v: readonly number[]) => { const b = new Uint8Array(v.length * 4), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true)); return b; };

/** On A:, as on GR IV: a user update writes RES files to A: (formatted first) and skips every B:
 * file (DspFwUpdate, 0x5362a350; the factory pictures on B: stay as they are). */
export function gr3xPicturePath(k: number): string { return `A:\\Resource\\Jpeg\\GRMOD${k + 1}.jpg`; }

export function validateGr3xPictureName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (typeof name !== 'string' || name.trim() === '' || name !== name.trim()) return 'empty';
  if (name.length > GR3X_PICTURE_NAME_MAX) return 'too-long';
  return /^[\x20-\x7e]+$/.test(name) ? null : 'bad-char';
}

export function checkGr3xPictures(pictures: readonly Gr3xPictureSpec[]): void {
  if (!(pictures.length >= 1 && pictures.length <= GR3X_MAX_PICTURES)) fail('too-many-pictures', `1 to ${GR3X_MAX_PICTURES} power-off pictures`);
  pictures.forEach((s, k) => {
    const problem = validateGr3xPictureName(s.name);
    if (problem) fail('bad-name', `power-off picture ${k + 1}: name is ${problem}`);
    if (!(s.jpeg instanceof Uint8Array) || s.jpeg.length !== GR3X_PICTURE_JPEG_BYTES) fail('bad-picture', `power-off picture ${k + 1}: JPEG of ${GR3X_PICTURE_JPEG_BYTES} bytes expected`);
    const sof = gr3xJpegFrame(s.jpeg);
    if (!sof || sof.width !== GR3X_PICTURE_WIDTH || sof.height !== GR3X_PICTURE_HEIGHT || sof.sampling !== '420')
      fail('bad-picture', `power-off picture ${k + 1}: a 720 x 480 baseline 4:2:0 JPEG is expected`);
  });
}

/** Size and sampling of a baseline JPEG (SOF0, three components), or null. */
export function gr3xJpegFrame(jpeg: Uint8Array): { width: number; height: number; sampling: '420' | '422' | 'other' } | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1], length = (jpeg[at + 2] << 8) | jpeg[at + 3];
    if (marker === 0xc0) {
      if (jpeg[at + 9] !== 3) return null;
      const h = jpeg[at + 5] << 8 | jpeg[at + 6], w = jpeg[at + 7] << 8 | jpeg[at + 8];
      const y = jpeg[at + 11], cb = jpeg[at + 14], cr = jpeg[at + 17];
      return { width: w, height: h, sampling: cb === 0x11 && cr === 0x11 ? (y === 0x22 ? '420' : y === 0x21 ? '422' : 'other') : 'other' };
    }
    if (marker === 0xc2 || marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * A 720 x 480 RGB picture as a power-off picture: baseline JPEG 4:2:0 (as the camera's own
 * end-screen pictures) at the highest quality that fits, padded with comment segments to exactly
 * GR3X_PICTURE_JPEG_BYTES. Deterministic.
 */
export function encodeGr3xPicture(rgb: Uint8Array | Uint8ClampedArray, onProgress?: (f: number) => void): Uint8Array {
  if (rgb.length !== GR3X_PICTURE_WIDTH * GR3X_PICTURE_HEIGHT * 3) fail('bad-picture', 'a power-off picture is 720 x 480 RGB');
  const layout = makeLayout(GR3X_PICTURE_WIDTH, GR3X_PICTURE_HEIGHT, '420');
  const coef = forwardTransform(rgb, layout);
  const at = (q: number) => { const [l, c] = qualityTables(q); return encodeCoefficients(coef, layout, l, c); };
  const room = GR3X_PICTURE_JPEG_BYTES - 4;
  let best = at(1);
  if (best.length > room) fail('bad-picture', 'the picture is too detailed for a power-off picture');
  let low = 2, high = 100, steps = 0;
  while (low <= high) {
    const q = (low + high) >> 1, data = at(q);
    onProgress?.(Math.min(0.95, ++steps / 8));
    if (data.length <= room) { best = data; low = q + 1; } else high = q - 1;
  }
  onProgress?.(1);
  return padJpeg(best, GR3X_PICTURE_JPEG_BYTES);
}

function padJpeg(jpeg: Uint8Array, length: number): Uint8Array {
  let pad = length - jpeg.length;
  if (pad < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('internal', 'cannot pad the picture');
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)];
  while (pad > 0) {
    let size = Math.min(pad, 65537);
    if (pad - size > 0 && pad - size < 4) size -= 4;
    const seg = new Uint8Array(size);
    seg[0] = 0xff; seg[1] = 0xfe; seg[2] = (size - 2) >> 8; seg[3] = (size - 2) & 0xff;
    parts.push(seg); pad -= size;
  }
  parts.push(jpeg.subarray(2));
  const out = new Uint8Array(length);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The list icon of a picture: 40 x 40 RGBA, the picture scaled to 36 x 24 (area average) on the
 * dark tile of the camera's menu icons, a grey frame, fully opaque inside. */
export function gr3xPictureIcon(jpeg: Uint8Array): Uint8Array {
  const { width, height, rgb } = decodeBaselineJpeg(jpeg);
  if (width !== GR3X_PICTURE_WIDTH || height !== GR3X_PICTURE_HEIGHT) fail('bad-picture', 'a power-off picture is 720 x 480');
  const W = 40, H = 40, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
    out.set(edge ? [255, 255, 255, 0] : [53, 53, 54, 255], o);
  }
  const tw = 36, th = 24, x0 = 2, y0 = 8;
  const sx = width / tw, sy = height / th;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
      const s = (yy * width + xx) * 3; r += rgb[s]; g += rgb[s + 1]; b += rgb[s + 2]; n++;
    }
    out.set([Math.round(r / n), Math.round(g / n), Math.round(b / n), 255], ((y0 + y) * W + x0 + x) * 4);
  }
  for (let x = x0 - 1; x <= x0 + tw; x++) for (const y of [y0 - 1, y0 + th]) out.set([128, 128, 128, 255], (y * W + x) * 4);
  for (let y = y0 - 1; y <= y0 + th; y++) for (const x of [x0 - 1, x0 + tw]) out.set([128, 128, 128, 255], (y * W + x) * 4);
  return out;
}

/** r2 = settings record (or 0), r3 = picture number 0..n (anything above n is stored back as 0). */
const load = (n: number, label: string) => `movw r2,#${lo(SETTINGS_POINTER)};movt r2,#${hi(SETTINGS_POINTER)};ldr r2,[r2];mov r3,#0;
  cmp r2,#0;beq pl${label};ldrb r3,[r2,#${GR3X_PICTURE_OFFSET}];cmp r3,#${n};movhi r3,#0;strbhi r3,[r2,#${GR3X_PICTURE_OFFSET}];pl${label}:`;

/** The list's handlers and the Setup line's draw function; the record fields for datestamp.ts. */
export function installGr3xPictureList(p: Gr3xPictureProgram, ids: Gr3xPictureIds) {
  const n = ids.names.length;
  if (n < 1 || n > GR3X_MAX_PICTURES || ids.icons.length !== n) fail('internal', 'IIIx power-off picture ids');
  for (const [at, w] of [[LINE_VALUE_TEXT, 0xe1a0c00d], [TOP_SET_TITLE, 0xe1a0c00d], [LIST_SET_ITEM, 0xe1a0c00d]] as const)
    if (p.word(at) !== w) fail('unexpected-layout', `IIIx power-off picture guard at ${at.toString(16)}`);
  // Per value: {u16 icon, u16 text}.
  const values = new Uint8Array((n + 1) * 4), v = new DataView(values.buffer);
  v.setUint16(0, ICON_OFF, true); v.setUint16(2, ids.original, true);
  for (let k = 0; k < n; k++) { v.setUint16((k + 1) * 4, ids.icons[k], true); v.setUint16((k + 1) * 4 + 2, ids.names[k], true); }
  const table = p.append(values);
  const line = p.code(`push {r4,lr};mov r4,r1;${load(n, 'a')}movw r1,#${lo(table)};movt r1,#${hi(table)};add r1,r1,r3,lsl #2;ldrh r1,[r1,#2];
    mov r0,r4;bl #${LINE_VALUE_TEXT};mov r0,r4;movw r1,#${ids.title};mov r2,r1;pop {r4,lr};b #${TOP_SET_TITLE};`);
  const count = p.code(`mov r0,#${n + 1};bx lr;`);
  const draw = p.code(`mov r0,r1;cmp r2,#${n};movhi r2,#${n};movw r3,#${lo(table)};movt r3,#${hi(table)};add r3,r3,r2,lsl #2;
    ldrh r1,[r3];ldrh r2,[r3,#2];b #${LIST_SET_ITEM};`);
  const set = p.code(`cmp r1,#${n};bxhi lr;movw r2,#${lo(SETTINGS_POINTER)};movt r2,#${hi(SETTINGS_POINTER)};ldr r2,[r2];
    cmp r2,#0;bxeq lr;strb r1,[r2,#${GR3X_PICTURE_OFFSET}];bx lr;`);
  const isCurrent = p.code(`${load(n, 'c')}cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
  return { pictureLine: line, pictureValues: table, pictureCount: count, pictureDraw: draw, pictureSet: set, pictureIsCurrent: isCurrent };
}

/** The Setup menu with the new line after End Screen. */
export function installGr3xPictureSetupLine(p: Gr3xPictureProgram, line: number) {
  if (p.word(SETUP_ENTRY_IMAGE) !== SETUP_MENU) fail('unexpected-layout', 'IIIx Setup menu entry');
  if (new DataView(p.read(SETUP_ENTRY_RAM, 4).buffer).getUint32(0, true) !== SETUP_MENU) fail('unexpected-layout', 'IIIx Setup menu entry (RAM)');
  const setup = p.read(SETUP_MENU, DESCRIPTOR), sv = new DataView(setup.buffer);
  if (setup[D_PAGES] !== 11 || [...setup.subarray(D_FIRST, D_FIRST + 11)].join() !== SETUP_FIRSTS.join() || setup[D_COUNT] !== SETUP_ITEMS ||
    sv.getUint32(D_ID + END_SCREEN_ITEM * 4, true) !== END_SCREEN_ID || sv.getUint32(D_DRAW + END_SCREEN_ITEM * 8, true) !== END_SCREEN_DRAW)
    fail('unexpected-layout', 'IIIx Setup menu is not the official one');
  for (let i = SETUP_ITEMS; i < MAX_ITEMS; i++)
    if (sv.getUint32(D_DRAW + i * 8, true) || sv.getUint32(D_DRAW + i * 8 + 4, true) || sv.getUint32(D_ID + i * 4, true) !== NO_ITEM || sv.getUint32(D_VISIBLE + i * 8, true) || sv.getUint32(D_VISIBLE + i * 8 + 4, true)) fail('unexpected-layout', 'IIIx Setup menu spare items');
  for (let i = 0; i < SETUP_ITEMS; i++) if (sv.getUint32(D_ID + i * 4, true) === GR3X_PICTURE_MENU_ID) fail('unexpected-layout', 'IIIx picture id in use');
  const d = setup.slice(), dv = new DataView(d.buffer), at = END_SCREEN_ITEM + 1;
  for (let i = SETUP_ITEMS; i > at; i--) {
    d.set(setup.subarray(D_DRAW + (i - 1) * 8, D_DRAW + i * 8), D_DRAW + i * 8);
    d.set(setup.subarray(D_ID + (i - 1) * 4, D_ID + i * 4), D_ID + i * 4);
    d.set(setup.subarray(D_VISIBLE + (i - 1) * 8, D_VISIBLE + i * 8), D_VISIBLE + i * 8);
  }
  dv.setUint32(D_DRAW + at * 8, line, true); dv.setUint32(D_DRAW + at * 8 + 4, 0, true);
  dv.setUint32(D_ID + at * 4, GR3X_PICTURE_MENU_ID, true);
  dv.setUint32(D_VISIBLE + at * 8, 0, true); dv.setUint32(D_VISIBLE + at * 8 + 4, 0, true);
  d.set(SETUP_FIRSTS_NEW, D_FIRST);
  d[D_COUNT] = SETUP_ITEMS + 1;
  const copy = p.append(d);
  p.patch(SETUP_ENTRY_IMAGE, SETUP_MENU, copy, 'power-off pictures: Setup menu with the picture line');
  return { pictureSetupMenu: copy };
}

/** Round 6: the Setup menu with End Screen (item 10) opening the End Screen submenu (endscreen.ts). */
export function installGr3xEndScreenSetup(p: Gr3xPictureProgram, line: number) {
  if (p.word(SETUP_ENTRY_IMAGE) !== SETUP_MENU) fail('unexpected-layout', 'IIIx Setup menu entry');
  if (new DataView(p.read(SETUP_ENTRY_RAM, 4).buffer).getUint32(0, true) !== SETUP_MENU) fail('unexpected-layout', 'IIIx Setup menu entry (RAM)');
  const setup = p.read(SETUP_MENU, DESCRIPTOR), sv = new DataView(setup.buffer);
  if (setup[D_PAGES] !== 11 || [...setup.subarray(D_FIRST, D_FIRST + 11)].join() !== SETUP_FIRSTS.join() || setup[D_COUNT] !== SETUP_ITEMS ||
    sv.getUint32(D_ID + END_SCREEN_ITEM * 4, true) !== END_SCREEN_ID || sv.getUint32(D_DRAW + END_SCREEN_ITEM * 8, true) !== END_SCREEN_DRAW ||
    sv.getUint32(D_DRAW + END_SCREEN_ITEM * 8 + 4, true) !== 0 || sv.getUint32(D_VISIBLE + END_SCREEN_ITEM * 8, true) !== 0)
    fail('unexpected-layout', 'IIIx Setup menu is not the official one');
  for (let i = 0; i < SETUP_ITEMS; i++) if (sv.getUint32(D_ID + i * 4, true) === GR3X_PICTURE_MENU_ID) fail('unexpected-layout', 'IIIx picture id in use');
  const d = setup.slice(), dv = new DataView(d.buffer);
  dv.setUint32(D_DRAW + END_SCREEN_ITEM * 8, line, true);
  dv.setUint32(D_ID + END_SCREEN_ITEM * 4, GR3X_PICTURE_MENU_ID, true);
  const copy = p.append(d);
  p.patch(SETUP_ENTRY_IMAGE, SETUP_MENU, copy, 'power-off pictures: Setup > End Screen opens the End Screen submenu');
  return { endScreenSetupMenu: copy };
}

/** The picture request and the extended table of full-screen JPEGs. `pick: false` (round 6's End
 * Screen submenu, endscreen.ts): the table only, the request is endscreen.ts's. */
export function installGr3xPictureStage(p: Gr3xPictureProgram, n: number, o: { pick?: boolean } = {}) {
  const withPick = o.pick !== false;
  if (n < 1 || n > GR3X_MAX_PICTURES) fail('internal', 'IIIx power-off picture count');
  const guards: readonly (readonly [number, number])[] = [
    [REQUEST, 0xe1a0c00d], ...(withPick ? [[JOIN, JOIN_WORD]] as const : []), [JOIN - 4, 0xe3a07002], // mov r7,#2 (GoodBye), then the join
    [JOIN + 0x24, 0xe1a01007], [JOIN + 0x2c, 0xeb000000 | (((PLAYBACK_JPEG - (JOIN + 0x2c + 8)) >> 2) & 0xffffff)], // mov r1,r7; bl request
    [PLAYBACK_JPEG, 0xe1a0c00d],
    [JPEG_TABLE_SITE[0], movWord(12, lo(JPEG_TABLE))], [JPEG_TABLE_SITE[1], movWord(12, hi(JPEG_TABLE), true)],
    [JPEG_TABLE_SITE[1] + 0xc, 0xe79c1101], // ldr r1,[ip,r1,lsl #2]: no bound
  ];
  for (const [at, w] of guards) if (p.word(at) !== w >>> 0) fail('unexpected-layout', `IIIx power-off picture guard at ${at.toString(16)}`);
  const original = p.read(JPEG_TABLE, JPEG_TABLE_COUNT * 4);
  if (p.read(JPEG_TABLE_IMAGE, JPEG_TABLE_COUNT * 4).some((b, i) => b !== original[i])) fail('unexpected-layout', 'IIIx JPEG table image');
  const entries = Array.from({ length: n }, (_, k) => {
    const path = p.append(Uint8Array.from([...gr3xPicturePath(k)].map(c => c.charCodeAt(0)).concat([0])));
    const e = new Uint8Array(8), v = new DataView(e.buffer);
    v.setUint16(0, GR3X_PICTURE_WIDTH, true); v.setUint16(2, GR3X_PICTURE_HEIGHT, true); v.setUint32(4, path, true);
    return p.append(e);
  });
  const table = p.append(new Uint8Array([...original, ...u32(entries)]));
  p.patch(JPEG_TABLE_SITE[0], movWord(12, lo(JPEG_TABLE)), movWord(12, lo(table)), 'power-off pictures: JPEG table, low half');
  p.patch(JPEG_TABLE_SITE[1], movWord(12, hi(JPEG_TABLE), true), movWord(12, hi(table), true), 'power-off pictures: JPEG table, high half');
  if (!withPick) return { pictureTable: table, pictureEntries: entries[0] };
  // r7 = the table index the camera chose; r2, r3 are free here (set again before use).
  const pick = p.code(`movw r2,#${lo(SETTINGS_POINTER)};movt r2,#${hi(SETTINGS_POINTER)};ldr r2,[r2];cmp r2,#0;beq keep;
    ldrb r3,[r2,#${GR3X_PICTURE_OFFSET}];sub r3,r3,#1;cmp r3,#${n - 1};addls r7,r3,#${JPEG_TABLE_COUNT};
    keep:ldr r0,[r5];ldr r1,[r5,#4];b #${JOIN + 4};`);
  p.patch(JOIN, JOIN_WORD, branchWord(JOIN, pick), 'power-off pictures: the chosen picture');
  return { pictureTable: table, pictureEntries: entries[0], picturePick: pick };
}

export { END_SCREEN_TITLE as GR3X_END_SCREEN_TITLE };
