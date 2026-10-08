// SPDX-License-Identifier: GPL-2.0-only
/**
 * Soft focus as a function of the ADJ lever (firmware 1.11).
 *
 * The camera's ADJ lever offers one of the functions 0..0x14 per slot ("ADJ mode setting"). This
 * adds function 0x15, "soft focus", with four values: off, weak, medium, strong. Picking a value
 * stores it in the user settings; while it is not "off", the camera's clarity step (a Laplacian
 * pyramid on the developed picture, see `../clarity.ts`) uses fixed soft-focus gains instead of the
 * row of the current Clarity setting. Clarity itself, and its table, are left as they are.
 *
 * What is changed, all found by reading the official 1.11 code:
 *
 *  - The ADJ controller (`AdjModeController`) looks every function up in a table of 21 records of
 *    0x5C bytes (0x53D9F714), each a set of member-function pointers: draw value i, is value i the
 *    current one, set value i, number of values, ... The table is copied to the appended area with
 *    a 22nd record for soft focus, and the 22 MOVW/MOVT pairs that address it are pointed there.
 *    The new record is the one of "Crop" with four handlers of its own.
 *  - The list of functions the ADJ mode setting menu offers (19 bytes at 0x53DBA8C0) is copied with
 *    0x15 inserted after Image Control; the loop bound goes from 19 to 20.
 *  - The function's name: function number to text number (0x5337FE98) learns 0x15 -> text 840,
 *    a new entry in all 21 language rows of the relocated text catalog (see `build.ts`).
 *  - The function's icon: function number to icon number (0x533817F0) learns 0x15 -> icon 768, a
 *    new 40x40 icon appended to ICONBIN and entered in the relocated icon catalog.
 *  - The value labels are the camera's own texts: Off (2), Low (9), Medium (10), High (11).
 *  - Where the value is kept: byte 0x90F of the user-settings structure (0xAE9 bytes). The
 *    factory-defaults initialiser (UserDataInitValue, 0x535278D8) writes every field of all 30
 *    default records and never this byte: it is alignment padding between a byte field (0x90E) and
 *    a halfword field (0x910). The structure is saved and loaded, and copied to and from U1-U3, as a
 *    whole (memcpy of 0xAE9 bytes), so the byte is kept across power-off, follows the user modes,
 *    and is 0 (off) after a settings reset. The live structure is the one at 0x55084DD8 + 4.
 *  - Image processing: DigitalFilterProcess::SetEffectParameter stores the clarity setting as a
 *    halfword at param+2 (0x53701DE8). That store now goes through a helper that, when the byte is
 *    1..3, stores 5..7 instead. The clarity function (0x538A1FA8) checks `clarity + 4 <= 8`
 *    (0x538A2000), now `<= 11`, and takes row `clarity + 4` of its stack copy of the table
 *    (0x538A2634); rows 9..11 are now taken from a table of the three soft-focus rows.
 *
 * Nothing here is reached unless the user puts soft focus on an ADJ slot, or sets the byte. A value
 * outside 0..3 in the byte (it is padding the official firmware never sets) counts as off.
 */
import { SOFT_FOCUS_GAINS, SOFT_FOCUS_STRENGTHS } from '../clarity';
import { FirmwareError } from '../types';
import { assembleWords, movImmediate, movWord } from './arm';
import {
  ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, NATIVE_TEXT_ROOTS, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z,
} from './build';

/** ADJ function number of soft focus. */
export const ADJ_SOFT_FOCUS = 0x15;
/** Text number of its name. */
export const SOFT_FOCUS_TEXT_ID = 840;
/** Icon number of its icon (768..787 are left free by the ratio icons). */
export const SOFT_FOCUS_ICON_ID = 768;
/** Where its value (0 off, 1 weak, 2 medium, 3 strong) is kept: byte 0x90F of the live user settings. */
export const SOFT_FOCUS_BYTE = 0x55084dd8 + 4 + 0x90f;
/** Clarity values passed on for weak / medium / strong (rows 9, 10, 11). */
const FIRST_SOFT_CLARITY = 5;

const ADJ_TABLE = 0x53d9f714;
const ADJ_RECORD = 0x5c;
const ADJ_FUNCTIONS = 21;
/** [MOVW address, MOVT address, register] of every place that addresses the ADJ table. */
const ADJ_TABLE_SITES: readonly (readonly [number, number, number])[] = [
  [0x531bbf8c, 0x531bbf9c, 4], [0x531bd954, 0x531bd95c, 2], [0x531bdaf0, 0x531bdaf8, 3], [0x531bdb8c, 0x531bdb94, 2],
  [0x531be088, 0x531be090, 2], [0x531bea9c, 0x531beaa4, 2], [0x531beaf8, 0x531beb00, 2], [0x531bebf0, 0x531bebf8, 2],
  [0x531bec7c, 0x531bec84, 2], [0x531bed08, 0x531bed10, 2], [0x531bedb0, 0x531bedb8, 7], [0x531beefc, 0x531bef04, 2],
  [0x531bf09c, 0x531bf0a4, 2], [0x531bf198, 0x531bf1b0, 4], [0x531bf4a4, 0x531bf4ac, 6], [0x531bf5b0, 0x531bf5b8, 2],
  [0x531bf65c, 0x531bf664, 2], [0x531bf6c4, 0x531bf6d4, 7], [0x531bf780, 0x531bf790, 7], [0x531bf964, 0x531bf96c, 2],
  [0x531bfb28, 0x531bfb2c, 3], [0x531bfce8, 0x531bfcf0, 2],
];
/** The record of Crop (function 0x13), the model for the new one. */
const CROP = 0x13;
/** Offsets of the handlers the new record replaces: draw value i, is i current, set i, count. */
const H_DRAW = 0x18;
const H_IS_CURRENT = 0x20;
const H_SET = 0x28;
const H_COUNT = 0x30;

const MENU_LIST = 0x53dba8c0;
const MENU_LIST_OFFICIAL = [0, 1, 2, 3, 4, 5, 19, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 20, 17];
const MENU_LIST_NEW = [0, 1, 2, 3, 4, 5, 19, 6, 7, 8, 9, 11, 12, 13, 14, 15, ADJ_SOFT_FOCUS, 16, 20, 17];

// Functions of the ADJ controller's list view the handlers call (the same as Crop's).
const LIST_ITEM = 0x53570a9c; // (list, index) -> item
const ITEM_SET_TEXT = 0x5357de6c; // (item, text number)

/** Texts of the four values: Off, Low, Medium, High. */
const VALUE_TEXTS = [2, 9, 10, 11];

/** The name of the function in each language, in the order of `LANGS` in `../names.ts`. */
export const SOFT_FOCUS_NAMES: readonly string[] = [
  'Měkká kresba', 'Blødt fokus', 'Soft Focus', 'Pehmeä tarkennus', 'Flou artistique', 'Weichzeichner', 'Μαλακή εστίαση',
  'Lágy fókusz', 'Effetto flou', 'ソフトフォーカス', '소프트 포커스', 'Soft focus', 'Miękka ostrość', 'Foco suave',
  'Мягкий фокус', '柔焦', 'Enfoque suave', 'Mjukt fokus', 'ซอฟต์โฟกัส', '柔焦', 'Yumuşak odak',
];
/** First language table (in `LANGS` order) as the program sees it in RAM; tables are 0xD14 apart. */
const FIRST_TABLE_RAM = 0x55000000 + (0x5437d7b0 - 0x5437b640);
const TABLE_STRIDE = 0xd14;

export const SOFT_FOCUS_ICON_W = 40;
export const SOFT_FOCUS_ICON_H = 40;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/**
 * The 40x40 icon: the tile of the camera's ADJ icons (grey border, dark fill) with a white dot
 * whose edge fades out, a picture of a soft-focused point of light.
 */
export function drawSoftFocusIcon(): Uint8Array {
  const W = SOFT_FOCUS_ICON_W;
  const H = SOFT_FOCUS_ICON_H;
  const px = new Uint8Array(W * H * 4);
  const BORDER = [128, 128, 128];
  const BG = [53, 53, 54];
  const cx = 19.5;
  const cy = 19.5;
  const core = 5.5;
  const halo = 14;
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
      // 4x4 supersampling of the intensity.
      let sum = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const r = Math.hypot(x + (sx + 0.5) / 4 - 0.5 - cx, y + (sy + 0.5) / 4 - 0.5 - cy);
          let v: number;
          if (r <= core) v = 1;
          else if (r >= halo) v = 0;
          else {
            const t = 1 - (r - core) / (halo - core);
            v = 0.85 * t * t * (3 - 2 * t);
          }
          sum += v;
        }
      }
      const v = sum / 16;
      px.set([Math.round(BG[0] + (255 - BG[0]) * v), Math.round(BG[1] + (255 - BG[1]) * v), Math.round(BG[2] + (255 - BG[2]) * v), 255], i);
    }
  }
  return px;
}

/** The three soft-focus rows (weak, medium, strong), 11 int16 gains each, finest band first. */
export function softFocusRows(): Uint8Array {
  const out = new Uint8Array(3 * 11 * 2);
  const v = new DataView(out.buffer);
  SOFT_FOCUS_STRENGTHS.forEach((s, r) => {
    const g = SOFT_FOCUS_GAINS[s];
    if (g.length !== 11) fail('internal', 'a soft focus row has 11 gains');
    g.forEach((x, c) => v.setInt16((r * 11 + c) * 2, x, true));
  });
  return out;
}

function lo(v: number): number {
  return v & 0xffff;
}
function hi(v: number): number {
  return v >>> 16;
}

/**
 * Install soft focus on the ADJ lever. `patch` must already hold the scaffold of `build.ts`
 * (relocated catalogs). Returns the ICONBIN data with the icon appended.
 */
export function installAdjSoftFocus(patch: Patch, iconbin: Uint8Array): Uint8Array {
  // --- Checks of the official code this relies on.
  for (const [movwAt, movtAt, r] of ADJ_TABLE_SITES) {
    expectWord(patch, movwAt, movWord(r, lo(ADJ_TABLE)));
    expectWord(patch, movtAt, movWord(r, hi(ADJ_TABLE), true));
  }
  const menu = patch.read(MENU_LIST, MENU_LIST_OFFICIAL.length);
  if (!MENU_LIST_OFFICIAL.every((v, i) => menu[i] === v)) fail('unexpected-layout', 'ADJ function list is not the official one');
  expectWord(patch, 0x531dae30, movWord(4, lo(MENU_LIST)));
  expectWord(patch, 0x531dae40, movWord(4, hi(MENU_LIST), true));
  expectWord(patch, 0x531dae5c, 0xe2846013); // add r6, r4, #19
  expectWord(patch, 0x5337ff40, 0xe3510014); // cmp r1, #0x14
  expectWord(patch, 0x5337ff44, 0xe3000229); // movw r0, #553 (Touch AF)
  expectWord(patch, 0x5337ff48, 0x13a00000); // movne r0, #0
  expectWord(patch, 0x5338189c, 0xe3510014); // cmp r1, #0x14
  expectWord(patch, 0x533818a0, 0x13822001); // orrne r2, r2, #1
  expectWord(patch, 0x53701de8, 0xe1c530b2); // strh r3, [r5, #2]
  expectWord(patch, 0x538a2000, 0xe3580008); // cmp r8, #8
  expectWord(patch, 0x538a2634, 0xe0281893); // mla r8, r3, r8, r1
  expectWord(patch, 0x538a1fe0 + 8 + 0x1a0, 0x53b4c860); // the clarity table the function copies
  const crop = patch.read(ADJ_TABLE + CROP * ADJ_RECORD, ADJ_RECORD);
  const cropWords = new DataView(crop.buffer);
  for (const off of [H_DRAW, H_IS_CURRENT, H_SET, H_COUNT]) {
    if (cropWords.getUint32(off, true) === 0 || cropWords.getUint32(off + 4, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');
  }
  if (patch.word(ICON_CATALOG + SOFT_FOCUS_ICON_ID * 4) !== 0) fail('unexpected-layout', 'icon number already in use');

  // --- The four handlers (this = r0, value index = r1).
  const B = SOFT_FOCUS_BYTE;
  const draw = patch.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r5, r0; mov r4, r1; mov r6, #0
     cmp r4, #3; bhi item
     cmp r4, #0; moveq r6, #${VALUE_TEXTS[0]}; addne r6, r4, #${VALUE_TEXTS[1] - 1}
     item: ldr r0, [r5, #0x1f8]; uxtb r1, r4; bl #${LIST_ITEM}
     mov r1, r6; pop {r4, r5, r6, lr}; b #${ITEM_SET_TEXT}`, at), 16);
  // The byte is alignment padding the official firmware never sets, so it may hold anything when
  // soft focus is first put on an ADJ slot. Anything but 0..3 is taken as (and reset to) 0 (off):
  // the list must always have exactly one current value. With none, the list view keeps the cursor
  // of the previous function's list, which can be beyond the four items here (on the camera: the
  // display breaks up and the camera switches off when ADJ is pressed).
  const isCurrent = patch.append((at) => assembleWords(
    `movw r3, #${lo(B)}; movt r3, #${hi(B)}; ldrb r2, [r3]
     cmp r2, #3; movhi r2, #0; strbhi r2, [r3]
     cmp r2, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  const set = patch.append((at) => assembleWords(
    `cmp r1, #3; bxhi lr
     movw r2, #${lo(B)}; movt r2, #${hi(B)}; strb r1, [r2]; bx lr`, at), 16);
  const count = patch.append((at) => assembleWords('mov r0, #4; bx lr', at), 16);

  // --- The ADJ table with a 22nd record.
  const record = crop.slice();
  const rv = new DataView(record.buffer);
  rv.setUint32(H_DRAW, draw, true);
  rv.setUint32(H_IS_CURRENT, isCurrent, true);
  rv.setUint32(H_SET, set, true);
  rv.setUint32(H_COUNT, count, true);
  const table = patch.append(concat([patch.read(ADJ_TABLE, ADJ_FUNCTIONS * ADJ_RECORD), record]), 16);
  for (const [movwAt, movtAt, r] of ADJ_TABLE_SITES) {
    patch.setWord(movwAt, movWord(r, lo(table)), 'ADJ soft focus: ADJ table with soft focus, low half');
    patch.setWord(movtAt, movWord(r, hi(table), true), 'ADJ soft focus: ADJ table with soft focus, high half');
  }

  // --- ADJ mode setting menu: the list of functions.
  const list = patch.append(Uint8Array.from(MENU_LIST_NEW), 16);
  patch.setWord(0x531dae30, movWord(4, lo(list)), 'ADJ soft focus: function list, low half');
  patch.setWord(0x531dae40, movWord(4, hi(list), true), 'ADJ soft focus: function list, high half');
  patch.setWord(0x531dae5c, 0xe2846000 | MENU_LIST_NEW.length, 'ADJ soft focus: function list length');

  // --- Name: function 0x15 -> text 840 (r1 = function, flags from CMP r1, #0x14).
  const name = patch.append((at) => assembleWords(
    `cmp r1, #${ADJ_SOFT_FOCUS}; movw r0, #${SOFT_FOCUS_TEXT_ID}; movne r0, #0; bx lr`, at), 16);
  patch.setWord(0x5337ff48, branchTo(0x5337ff48, name, 1), 'ADJ soft focus: function name');
  const descriptors: number[] = [];
  SOFT_FOCUS_NAMES.forEach((text) => {
    const encoded = utf16z(text);
    const units = encoded.length / 2;
    if (!(units > 1 && units < 256) || text.includes('\n')) fail('internal', 'bad soft focus name');
    const address = patch.append(encoded, 4);
    descriptors.push(patch.append(concat([Uint8Array.from([units, 1, 0, 0]), u32le([address])]), 4));
  });
  const roots = new DataView(patch.readMapped(NATIVE_TEXT_ROOTS, LANGUAGES * 4).buffer);
  const seen = new Set<number>();
  for (let l = 0; l < LANGUAGES; l++) {
    // Root l (as the program indexes languages) is table k (in `LANGS` order), 4 bytes before it.
    const k = (roots.getUint32(l * 4, true) + 4 - FIRST_TABLE_RAM) / TABLE_STRIDE;
    if (!(Number.isInteger(k) && k >= 0 && k < LANGUAGES) || seen.has(k)) fail('unexpected-layout', 'language tables are not where they were expected');
    seen.add(k);
    const row = patch.word(TEXT_CATALOG + l * 4);
    if (patch.word(row + SOFT_FOCUS_TEXT_ID * 4) !== 0) fail('unexpected-layout', 'text number already in use');
    patch.write(row + SOFT_FOCUS_TEXT_ID * 4, u32le([descriptors[k]]));
  }
  for (const site of patch.textBoundSites) patch.setWord(site, movWord(3, Math.max(SOFT_FOCUS_TEXT_ID, movImmediate(patch.word(site)))), 'text upper bound');

  // --- Icon: function 0x15 -> icon 768 (r1 = function, r2 = variant; taken when r1 != 0x14).
  const pad = (4 - (iconbin.length % 4)) % 4;
  const iconOffset = iconbin.length + pad;
  const icon = drawSoftFocusIcon();
  const descriptor = patch.append(concat([u16le([1, SOFT_FOCUS_ICON_W, SOFT_FOCUS_ICON_H, 0]), u32le([iconOffset / 4])]), 16);
  patch.write(ICON_CATALOG + SOFT_FOCUS_ICON_ID * 4, u32le([descriptor]));
  for (const [site, register] of LOOKUP_BOUNDS) {
    patch.setWord(site, movWord(register, Math.max(SOFT_FOCUS_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  const iconAt = patch.append((at) => assembleWords(
    `cmp r1, #${ADJ_SOFT_FOCUS}; movne r0, #0; bxne lr
     cmp r2, #0; movne r0, #0; bxne lr
     movw r0, #${SOFT_FOCUS_ICON_ID}; bx lr`, at), 16);
  patch.setWord(0x533818a0, branchTo(0x533818a0, iconAt, 1), 'ADJ soft focus: function icon');

  // --- Image processing.
  const rows = patch.append(softFocusRows(), 16);
  const param = patch.append((at) => assembleWords(
    `strh r3, [r5, #2]
     movw r2, #${lo(B)}; movt r2, #${hi(B)}; ldrb r2, [r2]
     cmp r2, #0; bxeq lr
     cmp r2, #3; bxhi lr
     add r2, r2, #${FIRST_SOFT_CLARITY - 1}; strh r2, [r5, #2]; bx lr`, at), 16);
  patch.setWord(0x53701de8, branchTo(0x53701de8, param, 14, true), 'ADJ soft focus: clarity parameter');
  patch.setWord(0x538a2000, 0xe358000b, 'ADJ soft focus: clarity rows up to 11'); // cmp r8, #11
  const rowAt = patch.append((at) => assembleWords(
    `cmp r8, #8; bhi soft
     mul r8, r3, r8; add r8, r8, r1; bx lr
     soft: sub r8, r8, #9; mul r8, r3, r8
     movw ip, #${lo(rows)}; movt ip, #${hi(rows)}; add r8, r8, ip; bx lr`, at), 16);
  patch.setWord(0x538a2634, branchTo(0x538a2634, rowAt, 14, true), 'ADJ soft focus: clarity row');

  return concat([iconbin, new Uint8Array(pad), icon]);
}

/** B / BL `cond` from `at` to `target`. */
function branchTo(at: number, target: number, cond: number, link = false): number {
  const offset = (target - (at + 8)) >> 2;
  if (offset < -0x800000 || offset > 0x7fffff) fail('internal', 'branch out of range');
  return ((cond << 28) | (link ? 0x0b000000 : 0x0a000000) | (offset & 0xffffff)) >>> 0;
}
