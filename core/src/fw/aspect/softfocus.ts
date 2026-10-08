// SPDX-License-Identifier: GPL-2.0-only
/**
 * Soft focus as a function of the ADJ lever (firmware 1.11).
 *
 * The camera's ADJ lever offers one of the functions 0..0x14 per slot ("ADJ mode setting"). Function
 * 0x0A (a flash setting; the GR IV has no flash and never offers it: it is in no function list and in
 * no fixed slot layout) becomes "soft focus", with four values: off, weak, medium, strong. (0x12,
 * the other function the menu does not offer, is used: it is slot 4 of the fixed layout the
 * controller uses in one camera mode.) Picking a value
 * stores it in the user settings; while it is not "off", the camera's clarity step (a Laplacian
 * pyramid on the developed picture, see `../clarity.ts`) uses fixed soft-focus gains instead of the
 * row of the current Clarity setting. Clarity itself, and its table, are left as they are.
 *
 * What is changed, all found by reading the official 1.11 code:
 *
 *  - The ADJ controller (`AdjModeController`) looks every function up in a table of 21 records of
 *    0x5C bytes (0x53D9F714), each a set of member-function pointers: draw value i, is value i the
 *    current one, set value i, number of values, ... Record 0x0A is overwritten in place with the
 *    record of "Crop" carrying four handlers of its own. The table stays where it is: GR Mod
 *    0.5.0/0.5.1 copied it to the appended area with a 22nd record (function 0x15), and on the
 *    camera pressing ADJ then froze, even with soft focus on no slot.
 *  - The list of functions the ADJ mode setting menu offers (19 bytes at 0x53DBA8C0) is copied with
 *    0x0A inserted after Image Control; the loop bound goes from 19 to 20.
 *  - The function's name: function number to text number (0x5337FE98) gives text 840 for 0x0A,
 *    a new entry in all 21 language rows of the relocated text catalog (see `build.ts`).
 *  - The function's icon: function number to icon number (0x533817F0) gives icon 720 for 0x0A
 *    (0x0A and 0x0B shared a case; 0x0B keeps its icon), a new 40x40 icon appended to ICONBIN and entered in the relocated icon catalog.
 *  - The value labels are the camera's own texts: Off (2), Low (9), Medium (10), High (11).
 *  - Where the value is kept: byte 0x90F of the user-settings structure (0xAE9 bytes). The
 *    factory-defaults initialiser (UserDataInitValue, 0x535278D8) writes every field of all 30
 *    default records and never this byte: it is alignment padding between a byte field (0x90E) and
 *    a halfword field (0x910). The structure is saved and loaded, and copied to and from U1-U3, as a
 *    whole (memcpy of 0xAE9 bytes), so the byte is kept across power-off, follows the user modes,
 *    and is 0 (off) after a settings reset. The live structure is the one at 0x55084DD8 + 4.
 *  - Image processing, step 1: whether a picture goes through the digital-filter step at all is
 *    decided per picture (0x537150FC): for most image controls only when Clarity or the setting
 *    before it (0x7B3) is not neutral. The two places that read Clarity there (0x5371518C,
 *    0x537151B4) now read it as "not neutral" while soft focus is on, so the step also runs at
 *    Clarity 0 (without this, soft focus did nothing unless Clarity was set).
 *  - Image processing, step 2: DigitalFilterProcess::SetEffectParameter stores the clarity setting as a
 *    halfword at param+2 (0x53701DE8). That store now goes through a helper that, when the byte is
 *    1..3, stores 5..7 instead. The clarity function (0x538A1FA8) checks `clarity + 4 <= 8`
 *    (0x538A2000), now `<= 11`, and takes row `clarity + 4` of its stack copy of the table
 *    (0x538A2634); rows 9..11 are now taken from a table of the three soft-focus rows.
 *
 *  - The five slot getters (0x5329C240..60) read a stored function above 0x14 as 0 (off). GR Mod
 *    0.5.0/0.5.1 stored soft focus as 0x15; with that value in a slot, pressing ADJ makes the
 *    controller read past its table (in 0.5.x through the one of its 23 table references that was
 *    not moved) and the camera freezes. The official firmware does the same with such a value.
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

/** ADJ function number of soft focus (a function the GR IV never offers, see above). */
export const ADJ_SOFT_FOCUS = 0x0a;
/** Text number of its name. */
export const SOFT_FOCUS_TEXT_ID = 840;
/**
 * Icon number of its icon: 720, the number the ratio icons keep for identity 4, which is never
 * given out (added ratios start at identity 7, icon 723). So the icon lookup bound never goes
 * beyond what a build with added ratios already has (723 and up); without ratios it is 720.
 * (GR Mod 0.5.0/0.5.1 used 768 and raised the bound to 768: on the camera, pressing ADJ then
 * froze or switched the camera off, even with soft focus on no slot.)
 */
export const SOFT_FOCUS_ICON_ID = 720;
/** Where its value (0 off, 1 weak, 2 medium, 3 strong) is kept: byte 0x90F of the live user settings. */
export const SOFT_FOCUS_BYTE = 0x55084dd8 + 4 + 0x90f;
/** Clarity values passed on for weak / medium / strong (rows 9, 10, 11). */
const FIRST_SOFT_CLARITY = 5;

const ADJ_TABLE = 0x53d9f714;
const ADJ_RECORD = 0x5c;
const ADJ_FUNCTIONS = 21;
/** The record of Crop (function 0x13), the model for the new one. */
const CROP = 0x13;
/** Offsets of the handlers the new record replaces: draw value i, is i current, set i, count. */
const H_DRAW = 0x18;
const H_IS_CURRENT = 0x20;
const H_SET = 0x28;
const H_COUNT = 0x30;

const MENU_LIST = 0x53dba8c0;
/** The two reads of Clarity that decide whether the digital-filter step runs (0x537150FC). */
const CLARITY_GATE = [0x5371518c, 0x537151b4];
/** Getters of ADJ slots 1..5 (bytes 0x920..0x924 of the user settings). */
const SLOT_GETTERS = [0x5329c240, 0x5329c248, 0x5329c250, 0x5329c258, 0x5329c260];
const MENU_LIST_OFFICIAL = [0, 1, 2, 3, 4, 5, 19, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 20, 17];
const MENU_LIST_NEW = [0, 1, 2, 3, 4, 5, 19, 6, 7, 8, 9, 11, 12, 13, 14, 15, ADJ_SOFT_FOCUS, 16, 20, 17];
/** Official record of function 0x0A (enter, draw, is current, set, count, flag), checked before it is replaced. */
const OFFICIAL_RECORD: readonly (readonly [number, number])[] = [[0x10, 0x531ba124], [0x18, 0x531be434], [0x20, 0x531bb454], [0x28, 0x531bb014], [0x30, 0x531ba180], [0x38, 1], [0x3c, 0]];

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
  for (const [off, value] of OFFICIAL_RECORD) expectWord(patch, ADJ_TABLE + ADJ_SOFT_FOCUS * ADJ_RECORD + off, value);
  if (ADJ_SOFT_FOCUS >= ADJ_FUNCTIONS) fail('internal', 'soft focus must reuse a record of the table');
  const menu = patch.read(MENU_LIST, MENU_LIST_OFFICIAL.length);
  if (!MENU_LIST_OFFICIAL.every((v, i) => menu[i] === v)) fail('unexpected-layout', 'ADJ function list is not the official one');
  expectWord(patch, 0x531dae30, movWord(4, lo(MENU_LIST)));
  expectWord(patch, 0x531dae40, movWord(4, hi(MENU_LIST), true));
  expectWord(patch, 0x531dae5c, 0xe2846013); // add r6, r4, #19
  expectWord(patch, 0x5337fef0, 0xe351000a); // cmp r1, #0x0a
  expectWord(patch, 0x5337fef4, 0x0a000027); // beq 0x5337ff98 (no other case goes there)
  expectWord(patch, 0x5337ff98, 0xe3a00087); // mov r0, #135
  expectWord(patch, 0x5337ff9c, 0xe12fff1e); // bx lr
  expectWord(patch, 0x53381850, 0xe241300a); // sub r3, r1, #0x0a
  expectWord(patch, 0x53381854, 0xe3530001); // cmp r3, #1
  expectWord(patch, 0x53381858, 0x9a000035); // bls 0x53381934 (0x0A and 0x0B)
  expectWord(patch, 0x53381934, 0xe3520000); // cmp r2, #0
  expectWord(patch, 0x53701de8, 0xe1c530b2); // strh r3, [r5, #2]
  for (const site of CLARITY_GATE) {
    expectWord(patch, site, 0xe5d137b4); // ldrb r3, [r1, #0x7b4]
    expectWord(patch, site + 4, 0xe5d127b3); // ldrb r2, [r1, #0x7b3]  (r2 is free at the site)
  }
  SLOT_GETTERS.forEach((at, i) => {
    expectWord(patch, at, 0xe5d00920 + i); // ldrb r0, [r0, #0x920 + i]
    expectWord(patch, at + 4, 0xe12fff1e); // bx lr
  });
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

  // --- Record 0x0A of the ADJ table, in place.
  const record = crop.slice();
  const rv = new DataView(record.buffer);
  rv.setUint32(H_DRAW, draw, true);
  rv.setUint32(H_IS_CURRENT, isCurrent, true);
  rv.setUint32(H_SET, set, true);
  rv.setUint32(H_COUNT, count, true);
  const at12 = ADJ_TABLE + ADJ_SOFT_FOCUS * ADJ_RECORD;
  for (let off = 0; off < ADJ_RECORD; off += 4) {
    const v = rv.getUint32(off, true);
    if (patch.word(at12 + off) !== v) patch.setWord(at12 + off, v, 'ADJ soft focus: ADJ table record');
  }

  // --- ADJ mode setting menu: the list of functions.
  const list = patch.append(Uint8Array.from(MENU_LIST_NEW), 16);
  patch.setWord(0x531dae30, movWord(4, lo(list)), 'ADJ soft focus: function list, low half');
  patch.setWord(0x531dae40, movWord(4, hi(list), true), 'ADJ soft focus: function list, high half');
  patch.setWord(0x531dae5c, 0xe2846000 | MENU_LIST_NEW.length, 'ADJ soft focus: function list length');

  // --- Name: function 0x0A -> text 840.
  patch.setWord(0x5337ff98, movWord(0, SOFT_FOCUS_TEXT_ID), 'ADJ soft focus: function name');
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

  // --- Icon: function 0x0A -> icon 720 (variant 0; other variants: none). r3 = function - 0x0A.
  const pad = (4 - (iconbin.length % 4)) % 4;
  const iconOffset = iconbin.length + pad;
  const icon = drawSoftFocusIcon();
  const descriptor = patch.append(concat([u16le([1, SOFT_FOCUS_ICON_W, SOFT_FOCUS_ICON_H, 0]), u32le([iconOffset / 4])]), 16);
  patch.write(ICON_CATALOG + SOFT_FOCUS_ICON_ID * 4, u32le([descriptor]));
  for (const [site, register] of LOOKUP_BOUNDS) {
    patch.setWord(site, movWord(register, Math.max(SOFT_FOCUS_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  const iconAt = patch.append((at) => assembleWords(
    `cmp r3, #0; bne #0x53381934
     cmp r2, #0; movne r0, #0; bxne lr
     movw r0, #${SOFT_FOCUS_ICON_ID}; bx lr`, at), 16);
  patch.setWord(0x53381858, branchTo(0x53381858, iconAt, 9), 'ADJ soft focus: function icon');

  // --- Image processing: run the digital-filter step while soft focus is on.
  for (const site of CLARITY_GATE) {
    const gate = patch.append((at) => assembleWords(
      `ldrb r3, [r1, #0x7b4]
       movw r2, #${lo(B)}; movt r2, #${hi(B)}; ldrb r2, [r2]
       sub r2, r2, #1; cmp r2, #2; movls r3, #${4 + FIRST_SOFT_CLARITY}
       b #${site + 4}`, at), 16);
    patch.setWord(site, branchTo(site, gate, 14), 'ADJ soft focus: digital filter step');
  }

  // --- Slot getters: a stored function above 0x14 reads as off.
  SLOT_GETTERS.forEach((at, i) => {
    const getter = patch.append((a) => assembleWords(
      `ldrb r0, [r0, #${0x920 + i}]; cmp r0, #${ADJ_FUNCTIONS - 1}; movhi r0, #0; bx lr`, a), 16);
    patch.setWord(at, branchTo(at, getter, 14), 'ADJ soft focus: slot getter');
  });

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
