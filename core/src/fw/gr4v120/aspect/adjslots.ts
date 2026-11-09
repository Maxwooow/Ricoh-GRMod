// SPDX-License-Identifier: GPL-2.0-only
/**
 * More ADJ lever slots (GR IV firmware 1.20, ported from the 1.11 program): N = 6, 7 or 8 slots
 * instead of the camera's five.
 *
 * Everything below was found by reading the official code (1.11, then checked on 1.20: the same code, moved; AdjModeController, its view table,
 * the ADJ Mode Setting submenu and its lists, the settings structure).
 *
 * What the camera has:
 *  - five slot bytes 0x920..0x924 of the user settings object (CURRENT(), 0x550832A8), each an ADJ
 *    function 0..0x14 (0 = none), read by five getters 0x532A0584..60; the slot last used is kept
 *    at 0x91E (0x91F in the fixed layout: setting byte 0x32 = 1, where the five slots are fixed
 *    functions);
 *  - AdjModeController (one object of 0x294 bytes, made once by the controller factory, 0x53187C88):
 *    39 views bound from the table at 0x53DCA5E0 (6 words each: kind, x, y, width, height, parent)
 *    to +0x15C..+0x1F4: five slot frames (+0x16C.., x 425 + 60 k), the selection frame (+0x180),
 *    five slot icons (+0x184..); the current slot at +0x1FC; per slot a 12-byte state, two layouts
 *    (free, fixed) of five at +0x200 (stride 0x3C);
 *  - code that knows there are five: SlotFunction (0x531BEAB8, a jump table of five, an assertion
 *    past it), "can ADJ be used" (vtable 9, 0x531BE5E4, the five getters unrolled), the strip
 *    (0x531C0F74, unrolled and a loop of five over +0x16C / +0x184), which icons can be touched
 *    (0x531BEBF4), the taps on the icons (0x531BD078, five handlers 0x531C0F10..0x531C0F60), next and
 *    previous slot (0x531C0BF4 / 0x531C0CB0: five tries, wrap at 4), the first slot on entry
 *    (0x531C029C, from 0x91E: five tries, wrap at 4), the selection frame's x (0x531C0900,
 *    425 + 60 k), and the state functions (0x531BD4BC, 0x531BE260, 0x531C0574, 0x531C095C,
 *    0x531C09C0, 0x531C0A70);
 *  - the settings: Customize Settings (menu descriptor 0x53DC6B38) item 7 "ADJ Mode Setting" opens
 *    submenu record 10 (five lines "Setting1".."Setting5", texts 498..502, at most five lines in a
 *    record); each opens a list (records 68..72: value count and row drawing from the list
 *    controller's own vector of the ADJ functions, set and "is current" through the slot's setter
 *    and getter).
 *
 * What is changed (none of it for N = 5; `adjslots` 6..8):
 *  - slots 6..N are kept in three bytes of the user settings structure the firmware never touches
 *    (padding after the byte at 0x488 of the structure, CURRENT() + 4 + 0x489..0x48B; the factory
 *    defaults initialiser 0x53546C24, run in the emulator on all 30 records, never writes them, no
 *    getter or setter reads them; saved, loaded and copied to U1..U3 with the structure): bits 0..4
 *    the function; bits 5..7 of the first the slot last used when it is 6..8 (then 0x91E holds 4;
 *    0x91E only ever gets 0..4, what the official firmware knows);
 *  - the controller object is 0x3A0 bytes: frames and icons of N slots at +0x294 / +0x2B4, the
 *    per-slot state (2 x N x 12) at +0x2D8; the official functions using the state are patched to
 *    the new place and stride (immediates only); the views are bound from a new table (frames,
 *    selection and icons of N slots, in the official order of kinds, a pitch of 52 instead of 60
 *    and the function name narrower when the strip reaches it) by the module, which puts each view
 *    in its official member as well;
 *  - SlotFunction's out-of-range branch, vtable 9, the strip, the touchable icons and the taps go to
 *    the module (`tools/gr4v120/adjslots/adjslots.c`); next / previous / first slot try N slots and wrap at
 *    N - 1; the slot last used goes through the module;
 *  - the settings: ADJ Mode Setting itself has N lines "Setting1".."SettingN" (texts of lines 6..N
 *    made from the camera's own in each language), lines 6..N each a list that is ADJ Mode Setting
 *    1's (record 68) with its own set and "is current". A submenu record holds five lines, so lines
 *    6..N are kept in a record of their own (appended, never opened) and SubMenuController reads
 *    them there for ADJ Mode Setting (record 10): the line's text, value icon x and value draw in
 *    its list builder (0x531E3E70), the line's controller id on OK (0x531E3AF4). Its list (made once
 *    for every submenu) has N rows instead of five; rows from a record's line count on are hidden,
 *    as the official code hides rows 3 and 4 of a three-line submenu. Six rows fit the list's area
 *    (the builder's own limit); with seven or eight lines the list scrolls with the cursor, as long
 *    lists do. Customize Settings is as the camera's.
 * In the fixed layout (movies) the extra slots are empty and their frames hidden: the five fixed
 * functions are as before.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord, movWord } from './arm';
import { LANGUAGES, Patch, TEXT_CATALOG, concat, expectWord, u32le, utf16z, widenTextRows } from './build';
import { LIST_CONTROLLER_ID, SUBMENU_CONTROLLER_ID, SUB_RECORD, SUB_SET_ICON, addListRecords, addSubmenuRecord, hookControllerFactory, submenuTable } from './datestamp-menu';
import { ADJSLOTS_CODE, ADJSLOTS_ENTRY } from './adjslots-code';

export const ADJ_SLOTS_MIN = 5;
export const ADJ_SLOTS_MAX = 8;
/** Settings bytes of slots 6..8 (CURRENT() + 4 + 0x489..0x48B); in the user settings object 0x48D..0x48F. */
export const ADJ_EXTRA_BYTE = 0x550832a8 + 4 + 0x489;
export const ADJ_EXTRA_OBJECT_OFFSET = 0x48d;
/** Controller ids (not used by the firmware): the record of lines 6..8 (never opened), then the lists of slots 6..8. */
export const ADJ_MENU_ID = 0x020001c0;
export const ADJ_LIST_ID = 0x020001c1;
/** Texts: the lines of slots 6..8 are ADJ_TEXT_ID + 1.. (ADJ_TEXT_ID itself is not used). */
export const ADJ_TEXT_ID = 1014; // 1.11: 970 (+ TEXT_SHIFT)
/** The controller's new members and size. */
export const ADJ_FRAMES = 0x294;
export const ADJ_ICONS = 0x2b4;
export const ADJ_STATE = 0x2d8;
export const ADJ_OBJECT = 0x3a0;
/** Strip geometry for N > 5: slots 52 apart, the last one where the camera's last one is (x 665). */
export const ADJ_PITCH = 52;
const LAST_FRAME_X = 665;
const NAME_MARGIN = 5;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

function decodeBase64(text: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    const v = table.indexOf(ch);
    if (v < 0) fail('internal', 'bad base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Distance of the slots: the camera's 60 for five, 52 for more. */
export const adjPitch = (n: number): number => (n <= 5 ? 60 : ADJ_PITCH);
/** x of slot k's frame. */
export function adjFrameX(n: number, k: number): number {
  return LAST_FRAME_X - adjPitch(n) * (n - 1 - k);
}
/** Per-slot state: one layout's stride. */
export const adjLayoutStride = (n: number): number => 12 * n;

// --- Official addresses.
const NEW_CONTROLLER = 0x53187c88; // mov r0, #0x294 (operator new)
const CONSTRUCTOR_STATE = 0x531c1a14; // add r0, r4, #0x200 ; mov r2, #0x78 (memset)
const CONSTRUCTOR_BIND = 0x531c1a60; // bl BindViews
const VIEW_TABLE = 0x53dca5e0;
const VIEW_ENTRY = 24;
const OFFICIAL_VIEWS = 39;
const VTABLE_CAN_OPEN = 0x53dc9dac;
const CAN_OPEN = 0x531be5e4;
const SLOT_FUNCTION_OUT = 0x531beae4; // b assertion
const SLOT_FUNCTION_ASSERT = 0x531beba8;
/** SlotFunction's return: sub sp, fp, #0x18; ldm sp, {r4, r5, r6, fp, sp, pc}. */
const SLOT_FUNCTION_RETURN = 0x531beba0;
const DRAW = 0x531c0f74;
const TOUCHABLE = 0x531bebf4;
const TAPS = 0x531bd078;
const TAP_SELECT = 0x531c0e84;
const GET_STILL_POSITION = 0x532a0574;
const SET_STILL_POSITION = 0x5333f0e8;
const ENTER_GET = 0x531c03bc;
const ENTER_SET = 0x531c0404;
const COMMIT_SET = 0x531c0498;
const MOV_IP_SP = 0xe1a0c00d;

/** Official words of every place changed, checked first. */
const OFFICIAL: readonly (readonly [number, number])[] = [
  [0x53187c88, 0xe3a00fa5], [0x531c1a14, 0xe2840c02], [0x531c1a18, 0xe3a02078], [0x531c1a60, 0xebff0a70],
  [0x531bd58c, 0xe2862c02], [0x531bd590, 0xe2863f8f], [0x531bd5b8, 0xe2860f9e], [0x531be2a4, 0xe3a0203c], [0x531be2bc, 0xe5c4220a],
  [0x531c0590, 0xe3a0303c], [0x531c05a8, 0xe283cf82], [0x531c05ac, 0xe5d3220a], [0x531c0654, 0xe3a0303c], [0x531c0670, 0xe2822f82],
  [0x531c0678, 0xe2811f81], [0x531c0690, 0xe5c6220a], [0x531c06a0, 0xe5931204],
  [0x531c0974, 0xe3a0403c], [0x531c0980, 0xe5d4320a], [0x531c0994, 0xe3550005], [0x531c09ac, 0xe5d43200], [0x531c09b4, 0x15c40200],
  [0x531c09b8, 0x15c4720a], [0x531c09d0, 0xe3a0403c], [0x531c09e8, 0xe2804f82], [0x531c0a50, 0xe3550005],
  [0x531c0a88, 0xe3a0c03c], [0x531c0aa0, 0xe2832f82], [0x531c0aa8, 0xe2811f81], [0x531beae4, 0xea00002f], [0x53dc9dac, 0x531be5e4],
  [0x531c0f74, 0xe1a0c00d], [0x531c0f78, 0xe30c3484], [0x531bebf4, 0xe1a0c00d], [0x531bebf8, 0xe92ddff0], [0x531bd078, 0xe1a0c00d],
  [0x531bd07c, 0xe3a02000], [0x531c0c10, 0xe3a05005], [0x531c0c14, 0xe3540004], [0x531c0ccc, 0xe3a05005], [0x531c0cdc, 0x03a04004],
  [0x531c0338, 0xe3a06005], [0x531c0340, 0xe3540004], [0x531c03bc, 0xeb03806c], [0x531c0404, 0xeb05fb37], [0x531c0498, 0xea05fb12],
  [0x531c0920, 0xe30031a9], [0x531c0928, 0xe3a0103c],
  // the functions the module and the stubs call or go back into
  [0x531beba8, 0xe30a3a24], [0x531beba0, 0xe24bd018], [0x531beba4, 0xe89da870], [0x531c0e84, MOV_IP_SP], [0x532a0574, 0xe5d0091e], [0x5333f0e8, MOV_IP_SP], [0x53184428, MOV_IP_SP],
  [0x531be238, MOV_IP_SP], [0x531beab8, MOV_IP_SP], [0x535ab874, MOV_IP_SP], [0x539084bc, MOV_IP_SP],
];

/** Per-slot state: [address, the instruction (with the official 0x200 / 0x3C / 5)] patched to the new place, stride, count. */
function stateSites(n: number): [number, string][] {
  const S = ADJ_STATE;
  const L = adjLayoutStride(n);
  return [
    [0x531c1a14, `add r0, r4, #${S}`], [0x531c1a18, `mov r2, #${2 * L}`],
    [0x531bd58c, `add r2, r6, #${S}`], [0x531bd590, `add r3, r6, #${S + L}`], [0x531bd5b8, `add r0, r6, #${S + 2 * L}`],
    [0x531be2a4, `mov r2, #${L}`], [0x531be2bc, `strb r2, [r4, #${S + 10}]`],
    [0x531c0590, `mov r3, #${L}`], [0x531c05a8, `add ip, r3, #${S + 8}`], [0x531c05ac, `ldrb r2, [r3, #${S + 10}]`],
    [0x531c0654, `mov r3, #${L}`], [0x531c0670, `add r2, r2, #${S + 8}`], [0x531c0678, `add r1, r1, #${S + 4}`],
    [0x531c0690, `strb r2, [r6, #${S + 10}]`], [0x531c06a0, `ldr r1, [r3, #${S + 4}]`],
    [0x531c0974, `mov r4, #${L}`], [0x531c0980, `ldrb r3, [r4, #${S + 10}]`], [0x531c0994, `cmp r5, #${n}`],
    [0x531c09ac, `ldrb r3, [r4, #${S}]`], [0x531c09b4, `strbne r0, [r4, #${S}]`], [0x531c09b8, `strbne r7, [r4, #${S + 10}]`],
    [0x531c09d0, `mov r4, #${L}`], [0x531c09e8, `add r4, r0, #${S + 8}`], [0x531c0a50, `cmp r5, #${n}`],
    [0x531c0a88, `mov ip, #${L}`], [0x531c0aa0, `add r2, r3, #${S + 8}`], [0x531c0aa8, `add r1, r1, #${S + 4}`],
    // next / previous slot and the first slot on entry: N tries, wrap at N - 1
    [0x531c0c10, `mov r5, #${n}`], [0x531c0c14, `cmp r4, #${n - 1}`], [0x531c0ccc, `mov r5, #${n}`], [0x531c0cdc, `moveq r4, #${n - 1}`],
    [0x531c0338, `mov r6, #${n}`], [0x531c0340, `cmp r4, #${n - 1}`],
    // the selection frame: x = x0 + pitch * slot
    [0x531c0920, `movw r3, #${adjFrameX(n, 0)}`], [0x531c0928, `mov r1, #${adjPitch(n)}`],
  ];
}

/**
 * The view table for N slots: the official entries in their order, the frames of N slots (where
 * the five were), the selection, the icons of N slots, then the rest (parents renumbered). The
 * frames at x0 + 52 k, the icons 5 px in; the name label narrower when the strip reaches it.
 */
export function adjViewTable(official: Uint8Array, n: number): Uint8Array {
  if (official.length !== OFFICIAL_VIEWS * VIEW_ENTRY) fail('internal', 'view table');
  const entry = (i: number): Uint32Array => new Uint32Array(official.slice(i * VIEW_ENTRY, (i + 1) * VIEW_ENTRY).buffer);
  const more = 2 * (n - 5);
  const out: Uint32Array[] = [];
  for (let i = 0; i < 4; i++) out.push(entry(i));
  const frame = entry(4);
  const icon = entry(10);
  for (let k = 0; k < n; k++) {
    const f = frame.slice();
    f[1] = adjFrameX(n, k);
    out.push(f);
  }
  const sel = entry(9);
  sel[1] = adjFrameX(n, 0);
  out.push(sel);
  for (let k = 0; k < n; k++) {
    const c = icon.slice();
    c[1] = adjFrameX(n, k) + 5;
    out.push(c);
  }
  for (let i = 15; i < OFFICIAL_VIEWS; i++) {
    const e = entry(i);
    // parent: a halfword at +0x14 (0 = the root, else an entry from 25 on, all after the icons)
    const parent = e[5] & 0xffff;
    if (parent !== 0) {
      if (parent < 15) fail('unexpected-layout', 'ADJ view table: a parent among the slots');
      e[5] = (e[5] & 0xffff0000) | (parent + more);
    }
    out.push(e);
  }
  const name = out[1];
  const x0 = adjFrameX(n, 0);
  if (x0 - NAME_MARGIN < name[0 + 3]) name[3] = x0 - NAME_MARGIN;
  return concat(out.map((e) => new Uint8Array(e.buffer)));
}

/** The official texts of row l (as the program indexes languages): the string of text `id`. */
function officialText(patch: Patch, row: number, id: number): string {
  const r = patch.word(TEXT_CATALOG + row * 4);
  const d = patch.word(r + id * 4);
  if (d === 0) fail('unexpected-layout', `text ${id} is missing`);
  const desc = patch.readMapped(d, 8);
  const units = desc[0];
  const address = (desc[4] | (desc[5] << 8) | (desc[6] << 16) | (desc[7] << 24)) >>> 0;
  const bytes = patch.readMapped(address, units * 2);
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const u = bytes[i] | (bytes[i + 1] << 8);
    if (u === 0) break;
    s += String.fromCharCode(u);
  }
  return s;
}

/** "Setting1" in a language with its last 1 (ASCII or full width) made `digit`. */
export function settingName(text: string, digit: number): string {
  const ascii = text.lastIndexOf('1');
  const wide = text.lastIndexOf('１');
  if (ascii < 0 && wide < 0) fail('unexpected-layout', `no slot number in "${text}"`);
  if (wide > ascii) return text.slice(0, wide) + String.fromCharCode(0xff10 + digit) + text.slice(wide + 1);
  return text.slice(0, ascii) + String(digit) + text.slice(ascii + 1);
}

const TEXT_ADJ_MODE = 496; // 1.11: 460 (1.20 renumbered the texts)
const TEXT_SETTING1 = 498; // 1.11: 462

/** Texts of row l (every row of the catalog, as the program indexes languages). */
function installTexts(patch: Patch, entries: readonly { id: number; make: (row: number) => string }[]): void {
  widenTextRows(patch, Math.max(...entries.map((x) => x.id)));
  for (let l = 0; l < LANGUAGES; l++) {
    const row = patch.word(TEXT_CATALOG + l * 4);
    for (const { id, make } of entries) {
      const text = make(l);
      const encoded = utf16z(text);
      const units = encoded.length / 2;
      if (!(units > 1 && units < 256) || text.includes('\n')) fail('internal', 'bad menu text');
      const address = patch.append(encoded, 4);
      const descriptor = patch.append(concat([Uint8Array.from([units, 1, 0, 0]), u32le([address])]), 4);
      if (patch.word(row + id * 4) !== 0) fail('unexpected-layout', 'text number already in use');
      patch.write(row + id * 4, u32le([descriptor]));
    }
  }
}

// --- Settings: ADJ Mode Setting's submenu record and lists, SubMenuController's list.
const ADJ_SUBMENU = 10;
const ADJ_LIST_RECORD = 68; // 1.11: 67 (1.20 inserts a list record before it)
const SELECT_TABLE = 0x53dcd470;
const SELECT_RECORD = 0x4c;
const ADJ1_COUNT = 0x531d0b7c;
const ADJ1_DRAW = 0x531d2e8c;
const ADJ1_SET = 0x531d4f28;
const ADJ1_CURRENT = 0x531d6928;
const APP = 0x532406a4;
const RESOURCES = 0x53240f98;
const ICON_OF = 0x53390e40;
const VALUE_X = 0x21c;
const NOP = 0xe1a00000; // mov r0, r0
/** SubMenuController (the controller of every submenu): its list's five rows, made once. */
const SUB_ROWS = 0x531e3e0c; // mov r2, #5
const SUB_KIND_MOV = 0x531e3e28; // mov ip, #0x22
const SUB_KIND = 0x531e3e34; // strb ip, [fp, #-0x20] .. (five bytes, with str lr, [fp, #-0x18] among them)
/** Its list builder: rows from the line count to row 4 hidden; a line's text, value icon x, value draw. */
const SUB_HIDE_A = 0x531e3ee0; // cmp r7, #4
const SUB_HIDE_B = 0x531e3f04; // cmp r4, #4
const SUB_LINE_TEXT = 0x531e3fd0;
const SUB_LINE_X = 0x531e3fe8;
const SUB_LINE_DRAW = 0x531e4004;
/** OK on a line: the line's controller id. */
const SUB_OK_ID = 0x531e3b34; // ldr r5, [r2, #0x14]
const SUBMENU_OFFICIAL: readonly (readonly [number, number])[] = [
  [0x531e3e0c, 0xe3a02005], [0x531e3e28, 0xe3a0c022], [0x531e3e34, 0xe54bc020], [0x531e3e38, 0xe24b1020], [0x531e3e3c, 0xe54bc01f],
  [0x531e3e40, 0xe50be018], [0x531e3e44, 0xe54bc01e], [0x531e3e48, 0xe54bc01d], [0x531e3e4c, 0xe54bc01c], [0x531e3ee0, 0xe3570004],
  [0x531e3f04, 0xe3540004], [0x531e3fd0, 0xe5d53174], [0x531e3fd4, 0xe1a00009], [0x531e3fd8, 0xe023439a], [0x531e3fdc, 0xe0883083],
  [0x531e3fe0, 0xe1d310b8], [0x531e3fe8, 0xe5d53174], [0x531e3fec, 0xe3a02019], [0x531e3ff0, 0xe1a00009], [0x531e3ff4, 0xe0234392],
  [0x531e3ff8, 0xe283300a], [0x531e3ffc, 0xe7981103], [0x531e4004, 0xe5d51174], [0x531e4008, 0xe3a02064], [0x531e400c, 0xe2843007],
  [0x531e4010, 0xe0020192], [0x531e4014, 0xe0823183], [0x531e4018, 0xe0883003], [0x531e401c, 0xe5932004], [0x531e4020, 0xe5930008],
  [0x531e3b34, 0xe5925014],
];

/** The last ADJ function: 0x14, or 0x15 with exposure preview on the ADJ lever (set by `installAdjSlots`). */
let MAX_FUNCTION = 0x14;

/** r1 = the function of slot k (5..7) as kept (above the last: none); r2 its byte's address. */
const loadExtra = (k: number): string => `movw r2, #${lo(ADJ_EXTRA_BYTE + k - 5)}; movt r2, #${hi(ADJ_EXTRA_BYTE + k - 5)}
  ldrb r1, [r2]; and r1, r1, #0x1f; cmp r1, #${MAX_FUNCTION}; movhi r1, #0`;

/**
 * Test 080: the module (compiled for the official table, 21 functions at 0x53DC9DFC) with the
 * table copied with a 22nd function: its two loads of the table's "disabled" members (MOVW / MOVT
 * of table + 0x3C) and its bound of a slot's function (cmp r4, #0x14), checked word for word.
 */
function moduleWithTable(code: Uint8Array, table: number): void {
  const v = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const sites: readonly (readonly [number, number])[] = [[68, 0xe3540014], [172, 0xe3091e38], [176, 0xe34513dc], [416, 0xe3091e38], [420, 0xe34513dc]];
  for (const [at, word] of sites) if (v.getUint32(at, true) !== word) fail('internal', 'ADJ slots: the module is not the one expected');
  const member = table + 0x3c;
  v.setUint32(68, 0xe3540015, true);
  for (const at of [172, 416]) {
    v.setUint32(at, movWord(1, lo(member)), true);
    v.setUint32(at + 4, movWord(1, hi(member), true), true);
  }
}

function installMenu(patch: Patch, n: number): void {
  // --- Checks.
  for (const f of [APP, RESOURCES, ADJ1_DRAW, ADJ1_SET, ADJ1_CURRENT]) expectWord(patch, f, MOV_IP_SP);
  for (const [at, word] of SUBMENU_OFFICIAL) expectWord(patch, at, word);
  expectWord(patch, ADJ1_COUNT, 0xe59031ac);
  const listRecord = patch.read(SELECT_TABLE + ADJ_LIST_RECORD * SELECT_RECORD, SELECT_RECORD);
  const lv = new DataView(listRecord.buffer);
  if (lv.getUint16(4, true) !== TEXT_SETTING1 || lv.getUint32(0x0c, true) !== ADJ1_COUNT || lv.getUint32(0x14, true) !== ADJ1_DRAW
    || lv.getUint32(0x24, true) !== ADJ1_SET || lv.getUint32(0x2c, true) !== ADJ1_CURRENT) fail('unexpected-layout', 'ADJ Mode Setting 1 list record is not as expected');
  const sub = patch.read(submenuTable(patch) + ADJ_SUBMENU * SUB_RECORD, SUB_RECORD);
  const sv = new DataView(sub.buffer);
  if (sv.getUint16(2, true) !== TEXT_ADJ_MODE || sub[6] !== 5 || [0, 1, 2, 3, 4].some((k) => sv.getUint16(8 + 2 * k, true) !== TEXT_SETTING1 + k
    || sv.getUint32(0x14 + 4 * k, true) !== 0x020000a8 + k || sv.getUint32(0x28 + 4 * k, true) !== VALUE_X)) fail('unexpected-layout', 'ADJ Mode Setting submenu record is not as expected');

  // --- Texts: the lines of slots 6..8 ("Setting6".., made from the camera's own in each language).
  const lines = n - 5;
  installTexts(patch, Array.from({ length: lines }, (_, j) => ({ id: ADJ_TEXT_ID + 1 + j, make: (l: number) => settingName(officialText(patch, l, TEXT_SETTING1), 6 + j) })));

  // --- Lists: ADJ Mode Setting 1's, with set and "is current" of slot 6 + j (this = r0, value i = r1).
  const records: { id: number; record: Uint8Array }[] = [];
  const lineDraws: number[] = [];
  for (let j = 0; j < lines; j++) {
    const k = 5 + j;
    const set = patch.append((at) => assembleWords(
      `ldr r3, [r0, #0x1a8]; ldr ip, [r0, #0x1ac]; sub ip, ip, r3; cmp r1, ip; bxhs lr
       ldrb r1, [r3, r1]; cmp r1, #${MAX_FUNCTION}; bxhi lr
       movw r2, #${lo(ADJ_EXTRA_BYTE + j)}; movt r2, #${hi(ADJ_EXTRA_BYTE + j)}
       ldrb r3, [r2]; bic r3, r3, #0x1f; orr r3, r3, r1; strb r3, [r2]; bx lr`, at), 16);
    const current = patch.append((at) => assembleWords(
      `ldr r3, [r0, #0x1a8]; ldr ip, [r0, #0x1ac]; sub ip, ip, r3; cmp r1, ip; movhs r0, #0; bxhs lr
       ldrb ip, [r3, r1]
       ${loadExtra(k)}
       cmp r1, ip; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
    lineDraws.push(patch.append((at) => assembleWords(
      `push {r4, r5, r6, lr}
       mov r4, r1
       bl #${APP}; bl #${RESOURCES}; mov r5, r0
       ${loadExtra(k)}
       mov r2, #0; add r0, r5, #4; bl #${ICON_OF}
       mov r1, r0; mov r0, r4
       pop {r4, r5, r6, lr}
       b #${SUB_SET_ICON}`, at), 16));
    const r = listRecord.slice();
    const v = new DataView(r.buffer);
    v.setUint16(4, ADJ_TEXT_ID + 1 + j, true);
    v.setUint32(0x24, set, true);
    v.setUint32(0x2c, current, true);
    records.push({ id: ADJ_LIST_ID + j, record: r });
  }
  addListRecords(patch, records, 'ADJ slots');

  // --- Lines 6..N: a record of the submenu table that is never opened (no menu item, no controller
  // id), laid out as ADJ Mode Setting's, whose lines 0..N-6 are ADJ Mode Setting's lines 6..N.
  const rec = sub.slice();
  const rv = new DataView(rec.buffer);
  rec[6] = lines;
  for (let k = 0; k < 5; k++) {
    rv.setUint16(8 + 2 * k, k < lines ? ADJ_TEXT_ID + 1 + k : 0, true);
    rv.setUint32(0x14 + 4 * k, k < lines ? ADJ_LIST_ID + k : 0x10000000, true);
    rv.setUint32(0x28 + 4 * k, k < lines ? VALUE_X : 0, true);
    rv.setUint32(0x3c + 8 * k, k < lines ? lineDraws[k] : 0, true);
    rv.setUint32(0x40 + 8 * k, 0, true);
  }
  const extra = addSubmenuRecord(patch, ADJ_MENU_ID, rec, 'ADJ slots');
  if (extra > 0xff) fail('internal', 'ADJ slots: submenu record number');
  hookControllerFactory(patch, `movw ip, #${lo(ADJ_LIST_ID)}; movt ip, #${hi(ADJ_LIST_ID)}
     sub ip, r1, ip; cmp ip, #${lines - 1}; bhi prior
     movw r1, #${lo(LIST_CONTROLLER_ID)}; movt r1, #${hi(LIST_CONTROLLER_ID)}`, 'ADJ slots: list controllers');

  // --- ADJ Mode Setting shows N lines: its record's line count, N rows in the submenu's list.
  const table = submenuTable(patch);
  const countWord = table + ADJ_SUBMENU * SUB_RECORD + 4;
  patch.setWord(countWord, (patch.word(countWord) & ~0xff0000) | (n << 16), 'ADJ slots: ADJ Mode Setting has N lines');
  // The submenu's list is made once with five rows (kind 0x22, from a byte array on the stack, the
  // stack protector's word right after it): N rows from eight bytes that end where the word starts.
  patch.setWord(SUB_ROWS, assembleWords(`mov r2, #${n}`, SUB_ROWS)[0], 'ADJ slots: N rows in the submenu list');
  patch.setWord(SUB_KIND_MOV, assembleWords('movw ip, #0x2222', SUB_KIND_MOV)[0], 'ADJ slots: N rows in the submenu list');
  patch.setWord(SUB_KIND + 0, assembleWords('movt ip, #0x2222', SUB_KIND)[0], 'ADJ slots: N rows in the submenu list');
  patch.setWord(SUB_KIND + 8, assembleWords('str ip, [fp, #-0x20]', SUB_KIND + 8)[0], 'ADJ slots: N rows in the submenu list');
  patch.setWord(SUB_KIND + 16, assembleWords('str ip, [fp, #-0x1c]', SUB_KIND + 16)[0], 'ADJ slots: N rows in the submenu list');
  patch.setWord(SUB_KIND + 20, NOP, 'ADJ slots: N rows in the submenu list');
  patch.setWord(SUB_KIND + 24, NOP, 'ADJ slots: N rows in the submenu list');
  // Rows from a record's line count on are hidden: up to row N - 1.
  patch.setWord(SUB_HIDE_A, assembleWords(`cmp r7, #${n - 1}`, SUB_HIDE_A)[0], 'ADJ slots: rows hidden up to N');
  patch.setWord(SUB_HIDE_B, assembleWords(`cmp r4, #${n - 1}`, SUB_HIDE_B)[0], 'ADJ slots: rows hidden up to N');
  // Line i of a record: ADJ Mode Setting's lines 6..N are the extra record's lines 0..N-6.
  // In: r0 table, r1 record, r2 line. Out: r0 the record to read, r2 its line. Uses ip.
  const select = patch.append((at) => assembleWords(
    `mov ip, #0
     cmp r1, #${ADJ_SUBMENU}; moveq ip, #1
     cmp r2, #5; movlo ip, #0
     cmp ip, #0; subne r2, r2, #5; movne r1, #${extra}
     mov ip, #${SUB_RECORD}; mul r1, ip, r1; add r0, r0, r1; bx lr`, at), 16);
  // In the list builder (this r5, table r8, line r4): a line's text, value icon x and value draw.
  const lineOf = (tail: string): number => patch.append((at) => assembleWords(
    `push {lr}
     mov r2, r0; ldrb r1, [r5, #0x174]; mov r0, r8; bl #${select}
     ${tail}
     pop {pc}`, at), 16);
  const textOf = lineOf('add r0, r0, r2, lsl #1; ldrh r0, [r0, #8]');
  const xOf = lineOf('add r0, r0, r2, lsl #2; ldr r0, [r0, #0x28]');
  const drawOf = lineOf('add r0, r0, r2, lsl #3; add r0, r0, #0x3c');
  const put = (at: number, body: string, words: number): void => {
    const w = assembleWords(body, at);
    if (w.length > words) fail('internal', 'ADJ slots: submenu line patch');
    while (w.length < words) w.push(NOP);
    w.forEach((x, i) => patch.setWord(at + 4 * i, x, 'ADJ slots: ADJ Mode Setting lines 6..N'));
  };
  put(SUB_LINE_TEXT, `mov r0, r4; bl #${textOf}; mov r1, r0; mov r0, sb`, 5);
  put(SUB_LINE_X, `mov r0, r4; bl #${xOf}; mov r1, r0; mov r0, sb`, 6);
  put(SUB_LINE_DRAW, `mov r0, r4; bl #${drawOf}; ldr r2, [r0]; ldr r0, [r0, #4]`, 8);
  // OK on a line (this r4, line r0, r2 = table + 4 (0x19 record + line), r1 = 0x19 record + line):
  // r5 = the line's controller id; everything else kept.
  const idOf = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     sub r0, r2, r1, lsl #2
     ldr r2, [sp]; ldrb r1, [r4, #0x174]; bl #${select}
     add r0, r0, r2, lsl #2; ldr r5, [r0, #0x14]
     pop {r0, r1, r2, r3, ip, pc}`, at), 16);
  patch.setWord(SUB_OK_ID, branchWord(SUB_OK_ID, idOf, 14, true), 'ADJ slots: ADJ Mode Setting lines 6..N');
}

/**
 * Install N ADJ slots (6..8; 5 only for the emulator checks, the official layout through the new
 * code). Returns nothing; the ICONBIN data does not change.
 */
export function installAdjSlots(patch: Patch, n: number, options: { menu?: boolean; functionTable?: number } = {}): void {
  // Test 080: the function table copied with function 0x15 (exposure preview, `exposure.ts`).
  const functionTable = options.functionTable ?? 0;
  MAX_FUNCTION = functionTable ? 0x15 : 0x14;
  if (!(Number.isInteger(n) && n >= ADJ_SLOTS_MIN && n <= ADJ_SLOTS_MAX)) fail('internal', 'ADJ slots: 5 to 8');
  for (const [at, word] of OFFICIAL) expectWord(patch, at, word);
  const officialTable = patch.readMapped(VIEW_TABLE, OFFICIAL_VIEWS * VIEW_ENTRY);
  {
    const v = new DataView(officialTable.buffer);
    const e = (i: number, w: number): number => v.getUint32(i * VIEW_ENTRY + 4 * w, true);
    for (let k = 0; k < 5; k++) {
      if (e(4 + k, 0) !== 11 || e(4 + k, 1) !== 425 + 60 * k || e(4 + k, 2) !== 5 || e(4 + k, 3) !== 50 || e(4 + k, 4) !== 50 || e(4 + k, 5) !== 0) fail('unexpected-layout', 'ADJ slot frames are not the official ones');
      if (e(10 + k, 0) !== 10 || e(10 + k, 1) !== 430 + 60 * k || e(10 + k, 2) !== 10 || e(10 + k, 3) !== 40 || e(10 + k, 4) !== 40 || e(10 + k, 5) !== 0) fail('unexpected-layout', 'ADJ slot icons are not the official ones');
    }
    if (e(9, 0) !== 10 || e(9, 1) !== 425 || e(1, 3) !== 400 || e(0, 0) !== 1) fail('unexpected-layout', 'ADJ views are not the official ones');
  }

  // --- The module and the view table.
  const code = decodeBase64(ADJSLOTS_CODE);
  if (functionTable) moduleWithTable(code, functionTable);
  const module = patch.append(code, 16);
  const E = ADJSLOTS_ENTRY;
  const table = patch.append(adjViewTable(officialTable, n), 16);
  const stub = (body: string): number => patch.append((at) => assembleWords(body, at), 16);

  // Object size, the state's place / stride / count, next / previous / entry, the selection's x.
  patch.setWord(NEW_CONTROLLER, assembleWords(`mov r0, #${ADJ_OBJECT}`, NEW_CONTROLLER)[0], 'ADJ slots: a larger controller');
  for (const [at, text] of stateSites(n)) patch.setWord(at, assembleWords(text, at)[0], 'ADJ slots: N slots');

  // Views: bound from the new table by the module.
  const bind = stub(`movw r1, #${lo(table)}; movt r1, #${hi(table)}; mov r2, #${n}; b #${module + E.bind}`);
  patch.setWord(CONSTRUCTOR_BIND, branchWord(CONSTRUCTOR_BIND, bind, 14, true), 'ADJ slots: views of N slots');

  // SlotFunction past slot 5 (its own frame: this r5, slot r4).
  const slotFunction = stub(`mov r0, r5; mov r1, r4; mov r2, #${n}; bl #${module + E.slot_function}; b #${SLOT_FUNCTION_RETURN}`);
  patch.setWord(SLOT_FUNCTION_OUT, branchWord(SLOT_FUNCTION_OUT, slotFunction), 'ADJ slots: slots 6..N');
  if (branchTarget(SLOT_FUNCTION_OUT, 0xea00002f) !== SLOT_FUNCTION_ASSERT) fail('internal', 'ADJ slots: SlotFunction');

  // Can ADJ be used (vtable 9, read only through the vtable).
  const canOpen = stub(`mov r1, #${n}; b #${module + E.can_open}`);
  expectWord(patch, VTABLE_CAN_OPEN, CAN_OPEN);
  patch.setWord(VTABLE_CAN_OPEN, canOpen, 'ADJ slots: can the ADJ lever be used (N slots)');

  // After the official function (entered through its first instruction, then on), the module.
  const after = (fn: number, call: string, what: string): void => {
    const tramp = stub(`mov ip, sp; b #${fn + 4}`);
    const wrap = stub(`push {r4, lr}; mov r4, r0; bl #${tramp}; mov r0, r4; ${call}; pop {r4, pc}`);
    patch.setWord(fn, branchWord(fn, wrap), what);
  };
  after(DRAW, `mov r1, #${n}; bl #${module + E.draw_more}`, 'ADJ slots: the strip, slots 6..N');
  after(TOUCHABLE, `mov r1, #${n}; bl #${module + E.touchable_more}`, 'ADJ slots: icons that can be touched, slots 6..N');
  const taps = Array.from({ length: n - 5 }, (_, j) => stub(`ldrb r3, [r0, #0x1fc]; cmp r3, #${5 + j}; bxeq lr; mov r1, #${5 + j}; b #${TAP_SELECT}`));
  const tapTable = patch.append(u32le(taps.length ? taps : [0]), 4);
  after(TAPS, `mov r1, #${n}; movw r2, #${lo(tapTable)}; movt r2, #${hi(tapTable)}; bl #${module + E.taps_more}`, 'ADJ slots: taps on slots 6..N');

  // The slot last used.
  const getPosition = stub(`mov r1, #${n}; b #${module + E.get_position}`);
  const setPosition = stub(`mov r2, #${n}; b #${module + E.set_position}`);
  expectWord(patch, ENTER_GET, branchWord(ENTER_GET, GET_STILL_POSITION, 14, true));
  expectWord(patch, ENTER_SET, branchWord(ENTER_SET, SET_STILL_POSITION, 14, true));
  expectWord(patch, COMMIT_SET, branchWord(COMMIT_SET, SET_STILL_POSITION));
  patch.setWord(ENTER_GET, branchWord(ENTER_GET, getPosition, 14, true), 'ADJ slots: the slot last used');
  patch.setWord(ENTER_SET, branchWord(ENTER_SET, setPosition, 14, true), 'ADJ slots: the slot last used');
  patch.setWord(COMMIT_SET, branchWord(COMMIT_SET, setPosition), 'ADJ slots: the slot last used');

  if (options.menu !== false && n > 5) installMenu(patch, n);
}
