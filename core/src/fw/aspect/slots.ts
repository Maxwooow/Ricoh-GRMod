// SPDX-License-Identifier: GPL-2.0-only
/**
 * Added Image Control slots (styles 34, 35, ...): up to six more looks in the camera's list, each
 * with its own matrix, tone curves and post-curve ("second") matrix. Tested on a GR IV HDF as
 * GR Mod test firmware 023 (four slots).
 *
 * What a style is made of in 1.11, per variant of the camera (three variants, 34 styles each):
 *  - a tone record (21 words, table 0x55053780): word 1 the colour matrix, word 2 the array of
 *    nine post-curve matrices (one per saturation setting);
 *  - a multi-axis record (6 words, table 0x55053504): word 2 an array of 8 block pointers;
 *  - a YCbCr record (table 0x55052CF4) and a gamma descriptor (20 bytes, table 0x55053138) that
 *    points to the three tone curves.
 * The four tables are copied with the new styles appended to every variant's row, and their
 * accessors read the copies with the longer row. A new style's records are copies of Cinema
 * Yellow's (the look the new styles behave like), with its own matrix, curves and post-curve
 * matrices, and the multi-axis blocks of Standard (neutral), as for the two Cinema slots.
 *
 * Copies must be complete: test 022 copied 3 of the 6 multi-axis words and 16 of the 21 tone
 * words, and the camera stopped on the first ADJ highlight of a new slot (MultiAxial read a
 * "pointer" from the slot name that followed).
 *
 * Everything else that knows the style numbers is extended for the new ones: menu order and
 * counts, names (text 846, ...), icons (768, ...), the ADJ list's own icon lookup, the shooting
 * overlay, RAW development and the look-visibility check (hidden on the GR IV Monochrome).
 * The adjustable parameters (saturation, contrast, ...) of the new styles are Cinema Yellow's:
 * the firmware keeps parameters per factory style only, so all getters, setters and defaults,
 * and the live-view parameter generator, read the new styles as Cinema Yellow (18). Changing a
 * parameter on one of them changes it on Cinema Yellow and the other new styles.
 */
import { assembleWords, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LOOKUP_BOUNDS, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z } from './build';
import { FirmwareError } from '../types';

export const MAX_EXTRA_SLOTS = 6;
/** Style number of the first added slot (the firmware has 34: 0..33). */
export const EXTRA_FIRST_STYLE = 34;
/** Text number of the first added slot's name. */
export const EXTRA_TEXT_ID = 846;
/** Icon number of the first added slot's icon (768..787 are free in the extended catalog). */
export const EXTRA_ICON_ID = 768;
/** Longest name of an added slot (printable ASCII: every language's font has those glyphs). */
export const EXTRA_NAME_MAX = 12;
export const EXTRA_ICON_BYTES = 40 * 40 * 4;

export interface ExtraSlotSpec {
  /** Menu name, the same in every language: 1..EXTRA_NAME_MAX printable ASCII characters. */
  name: string;
  /** Colour matrix, Q13, row-major, every row summing to 8192 (as for the Cinema slots). */
  matrixQ13: ArrayLike<number>;
  /** R, G, B tone curves: 256 values 0..16383 each, non-decreasing. */
  curves: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** Post-curve matrix, Q9, rows summing to 512; absent = none (the shared identity). */
  postQ9?: ArrayLike<number>;
  /** 40x40 RGBA. Fully transparent pixels stay transparent, others are made opaque. */
  icon: Uint8Array;
}

const TONES = 34;
const VARIANTS = 3;
const CY = 18;
const STANDARD = 11;
const TONE_TABLE = 0x55053780;
const MA_TABLE = 0x55053504;
const YCC_TABLE = 0x55052cf4;
const GAMMA_TABLE = 0x55053138;
/** [table, `mov r2,#34` of its accessor, movw, movt] */
const TABLES = [
  [TONE_TABLE, 0x53925f98, 0x53925f9c, 0x53925fa4],
  [MA_TABLE, 0x53925fc4, 0x53925fc8, 0x53925fd0],
  [YCC_TABLE, 0x53925ff0, 0x53925ff4, 0x53925ffc],
  [GAMMA_TABLE, 0x5392601c, 0x53926020, 0x53926028],
] as const;
const TONE_RECORD = 0x54;
const MA_RECORD = 0x18;
const GAMMA_DESC = 20;
const POST_WORD = 8;
const POST_ENTRIES = 9;
const POST_NEUTRAL = 4;
const POST_STRIDE = 20;
const MA_POINTERS = 8;
const ORDER_TABLE = 0x53dbe388;
const ORDER_COUNT = 20;
const TILE_BG = [53, 53, 54];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

const wordOf = (b: Uint8Array, o = 0): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);

/** Null when `name` can be an added slot's name. */
export function validateExtraSlotName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (name.length > EXTRA_NAME_MAX) return 'too-long';
  if (!/^[\x20-\x7e]+$/.test(name) || name !== name.trim()) return 'bad-char';
  return null;
}

function matrixBytes(k: number, m: ArrayLike<number>): Uint8Array {
  if (!m || m.length !== 9) fail('bad-color', `added slot ${k + 1}: the matrix must have 9 values`);
  const out = new Uint8Array(18);
  const v = new DataView(out.buffer);
  for (let r = 0; r < 3; r++) {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const x = m[r * 3 + c];
      if (!Number.isInteger(x) || x < -32768 || x > 32767) fail('bad-color', `added slot ${k + 1}: matrix value ${String(x)} is not an int16`);
      sum += x;
      v.setInt16((r * 3 + c) * 2, x, true);
    }
    if (sum !== 8192) fail('bad-color', `added slot ${k + 1}: matrix row ${r} sums to ${sum}, must be 8192`);
  }
  return out;
}

function curveBytes(k: number, c: ArrayLike<number>): Uint8Array {
  if (!c || c.length !== 256) fail('bad-color', `added slot ${k + 1}: a curve must have 256 values`);
  const out = new Uint8Array(512);
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const x = c[i];
    if (!Number.isInteger(x) || x < 0 || x > 16383 || x < prev) fail('bad-color', `added slot ${k + 1}: curve value ${String(x)} at ${i} is not valid`);
    prev = x;
    out[2 * i] = x & 0xff;
    out[2 * i + 1] = x >>> 8;
  }
  return out;
}

function checkPost(k: number, P: ArrayLike<number>): void {
  if (!P || P.length !== 9) fail('bad-color', `added slot ${k + 1}: the post matrix must have 9 values`);
  for (let r = 0; r < 3; r++) {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const x = P[r * 3 + c];
      if (!Number.isInteger(x) || x < -2047 || x > 2047) fail('bad-color', `added slot ${k + 1}: post matrix value ${String(x)} is outside the 12-bit range`);
      sum += x;
    }
    if (sum !== 512) fail('bad-color', `added slot ${k + 1}: post matrix row ${r} sums to ${sum}, must be 512`);
  }
}

/** Transparent pixels as FF FF FF 00, every other pixel made opaque over the tile background. */
function iconBytes(k: number, icon: Uint8Array): Uint8Array {
  if (!(icon instanceof Uint8Array) || icon.length !== EXTRA_ICON_BYTES) fail('bad-icon', `added slot ${k + 1}: the icon must be 40x40 RGBA`);
  const out = new Uint8Array(EXTRA_ICON_BYTES);
  for (let i = 0; i < EXTRA_ICON_BYTES; i += 4) {
    const a = icon[i + 3];
    if (a === 0) {
      out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) out[i + c] = a === 255 ? icon[i + c] : Math.floor((icon[i + c] * a + TILE_BG[c] * (255 - a) + 127) / 255);
    out[i + 3] = 255;
  }
  return out;
}

/**
 * The slot's nine post-curve matrices: Sat_k . P for each official saturation matrix Sat_k
 * (Q13), rounded to Q9 with each row summing to 512 (what the hardware gets) and stored as Q13
 * (x16). Nine pointers, then nine entries of 20 bytes. Same as the Cinema slots (`fw/patch.ts`).
 */
function postArray(p: Patch, k: number, shared: number, P: ArrayLike<number>, at: number): Uint8Array {
  const out = new Uint8Array(POST_ENTRIES * 4 + POST_ENTRIES * POST_STRIDE);
  const view = new DataView(out.buffer);
  const entries = at + POST_ENTRIES * 4;
  const pointers = p.readMapped(shared, POST_ENTRIES * 4);
  for (let e = 0; e < POST_ENTRIES; e++) {
    const src = new DataView(p.readMapped(wordOf(pointers, e * 4), 18).buffer);
    const S: number[] = [];
    for (let i = 0; i < 9; i++) S.push(src.getInt16(2 * i, true));
    for (let r = 0; r < 3; r++) if (Math.abs(S[r * 3] + S[r * 3 + 1] + S[r * 3 + 2] - 8192) > 2) fail('unexpected-layout', `saturation matrix ${e} row ${r} does not sum to 8192`);
    const q: number[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let j = 0; j < 3; j++) acc += S[r * 3 + j] * P[j * 3 + c];
      q.push(Math.round(acc / 8192));
    }
    for (let r = 0; r < 3; r++) q[r * 4] = 512 - (q[r * 3] + q[r * 3 + 1] + q[r * 3 + 2] - q[r * 4]);
    for (const v of q) if (v < -2047 || v > 2047) fail('bad-color', `added slot ${k + 1}: post matrix times saturation ${e - POST_NEUTRAL} leaves the 12-bit range`);
    view.setUint32(4 * e, entries + POST_STRIDE * e, true);
    for (let i = 0; i < 9; i++) view.setInt16(POST_ENTRIES * 4 + POST_STRIDE * e + 2 * i, q[i] * 16, true);
  }
  return out;
}

// Each overwritten instruction is checked against 1.11; a hook branches to appended code that
// handles the new styles and otherwise runs the overwritten instruction and branches back.
function hook(p: Patch, at: number, expected: number, body: string, reason: string): void {
  expectWord(p, at, expected);
  const target = p.append((a) => assembleWords(body, a), 16);
  p.setWord(at, branchWord(at, target), reason);
}
/** At a function entry (`mov ip,sp`): new styles in r1 return what `body` leaves in r0. */
function early(p: Patch, at: number, body: string, count: number, reason: string): void {
  hook(p, at, 0xe1a0c00d, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;${body};bx lr;native:mov ip,sp;b #${at + 4}`, reason);
}
function pointer(p: Patch, lo: number, hi: number, r: number, old: number, next: number, reason: string): void {
  expectWord(p, lo, movWord(r, old & 65535));
  expectWord(p, hi, movWord(r, old >>> 16, true));
  p.setWord(lo, movWord(r, next & 65535), reason);
  p.setWord(hi, movWord(r, next >>> 16, true), reason);
}
function swap(p: Patch, at: number, before: string, after: string, reason: string): void {
  const [a] = assembleWords(before, at);
  const [b] = assembleWords(after, at);
  expectWord(p, at, a);
  p.setWord(at, b, reason);
}

/**
 * Install `slots` (1..MAX_EXTRA_SLOTS) into an RTOS image that already has the scaffold of
 * `build.ts` (extended catalogs), appending their icons to `iconbin`. Returns the new ICONBIN data.
 */
export function installExtraSlots(p: Patch, iconbin: Uint8Array, slots: readonly ExtraSlotSpec[]): Uint8Array {
  const count = slots.length;
  if (!(count >= 1 && count <= MAX_EXTRA_SLOTS)) fail('too-many-slots', `1 to ${MAX_EXTRA_SLOTS} slots can be added`);
  if (p.textBoundSites.length === 0) fail('internal', 'the catalog scaffold is not installed');
  const tableWord = (table: number, variant: number, tone: number): number => wordOf(p.readMapped(table + 4 * (variant * TONES + tone), 4));
  for (const [table] of TABLES) {
    const cy = tableWord(table, 0, CY);
    for (let v = 1; v < VARIANTS; v++) if (tableWord(table, v, CY) !== cy) fail('unexpected-layout', 'Cinema Yellow differs between camera variants');
  }
  const rec = tableWord(TONE_TABLE, 0, CY);
  const ma = tableWord(MA_TABLE, 0, CY);
  const ycc = tableWord(YCC_TABLE, 0, CY);
  const gamma = tableWord(GAMMA_TABLE, 0, CY);
  const recTemplate = p.readMapped(rec, TONE_RECORD);
  const maTemplate = p.readMapped(ma, MA_RECORD);
  const descTemplate = p.readMapped(gamma, GAMMA_DESC);
  if (!(descTemplate[4] === 1)) fail('unexpected-layout', 'Cinema Yellow gamma descriptor is not what was expected');
  // Standard: its multi-axis block (neutral) and the post-curve array every factory style shares.
  const stdRec = tableWord(TONE_TABLE, 0, STANDARD);
  const shared = wordOf(p.readMapped(stdRec + POST_WORD, 4));
  const stdArray = wordOf(p.readMapped(tableWord(MA_TABLE, 0, STANDARD) + 8, 4));
  const stdBlock = wordOf(p.readMapped(stdArray, 4));
  for (let i = 1; i < MA_POINTERS; i++) if (wordOf(p.readMapped(stdArray + 4 * i, 4)) !== stdBlock) fail('unexpected-layout', 'Standard multi-axis pointers differ');

  const records: number[][] = [];
  const parts: Uint8Array[] = [iconbin];
  let iconLength = iconbin.length;
  slots.forEach((s, k) => {
    const problem = validateExtraSlotName(s.name);
    if (problem) fail('bad-name', `added slot ${k + 1}: name is ${problem}`);
    const mBytes = matrixBytes(k, s.matrixQ13);
    if (!s.curves || s.curves.length !== 3) fail('bad-color', `added slot ${k + 1}: curves must be [R, G, B]`);
    const cBytes = s.curves.map((c) => curveBytes(k, c));
    if (s.postQ9 !== undefined) checkPost(k, s.postQ9);
    const icon = iconBytes(k, s.icon);

    const matrix = p.append(mBytes, 4);
    const curves = cBytes.map((c) => p.append(c, 4));
    const desc = descTemplate.slice();
    desc[5] = 0; // the curves apply as they are, not through Cinema's tone parameter
    curves.forEach((a, i) => new DataView(desc.buffer).setUint32(8 + i * 4, a, true));
    const gammaNew = p.append(desc, 4);
    let post = shared;
    if (s.postQ9 !== undefined) {
      const at = p.next(4);
      post = p.append(postArray(p, k, shared, s.postQ9, at), 4);
      if (post !== at) fail('internal', 'post-curve array moved');
    }
    const r = recTemplate.slice();
    new DataView(r.buffer).setUint32(4, matrix, true);
    new DataView(r.buffer).setUint32(POST_WORD, post, true);
    const recNew = p.append(r, 4);
    const maArray = p.append(u32le(new Array(MA_POINTERS).fill(stdBlock)), 4);
    const m = maTemplate.slice();
    new DataView(m.buffer).setUint32(8, maArray, true);
    const maNew = p.append(m, 4);
    records.push([recNew, maNew, ycc, gammaNew]);

    const text = p.append(utf16z(s.name), 4);
    const textDesc = p.append(concat([Uint8Array.from([s.name.length + 1, 1, 0, 0]), u32le([text])]), 4);
    for (let l = 0; l < 21; l++) {
      const row = p.word(TEXT_CATALOG + l * 4);
      expectWord(p, row + (EXTRA_TEXT_ID + k) * 4, 0);
      p.write(row + (EXTRA_TEXT_ID + k) * 4, u32le([textDesc]));
    }
    const pad = (4 - (iconLength % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      iconLength += pad;
    }
    expectWord(p, ICON_CATALOG + (EXTRA_ICON_ID + k) * 4, 0);
    const iconDesc = p.append(concat([u16le([1, 40, 40, 0]), u32le([iconLength / 4])]), 16);
    p.setWord(ICON_CATALOG + (EXTRA_ICON_ID + k) * 4, iconDesc, 'added slot icon');
    parts.push(icon);
    iconLength += icon.length;
  });
  const lastText = EXTRA_TEXT_ID + count - 1;
  const lastIcon = EXTRA_ICON_ID + count - 1;
  for (const site of p.textBoundSites) p.setWord(site, movWord(3, Math.max(lastText, movImmediate(p.word(site)))), 'text upper bound');
  for (const [site, r] of LOOKUP_BOUNDS) p.setWord(site, movWord(r, Math.max(lastIcon, movImmediate(p.word(site)))), 'icon upper bound');

  // Every variant's row keeps its 34 factory entries; the new styles are appended to each row.
  TABLES.forEach(([old, stride, low, high], t) => {
    const out: number[] = [];
    for (let v = 0; v < VARIANTS; v++) {
      const row = p.readMapped(old + v * TONES * 4, TONES * 4);
      for (let j = 0; j < TONES; j++) out.push(wordOf(row, j * 4));
      for (const r of records) out.push(r[t]);
    }
    const table = p.append(u32le(out), 16);
    swap(p, stride, `mov r2,#${TONES}`, `mov r2,#${TONES + count}`, 'added slots: table row length');
    pointer(p, low, high, 3, old, table, 'added slots: style table');
  });

  // The style -> LUT index check: only the new styles are let through, the native fallback for
  // invalid values (31..33 among them) stays as it is.
  hook(p, 0x53912cf4, 0xe352001e, `sub r1,r2,#${EXTRA_FIRST_STYLE};cmp r1,#${count - 1};bhi native;mov r3,r2;b #0x53912d08;native:cmp r2,#30;b #0x53912cf8`, 'added slots: style to table index');
  // The common input fields (grain among them) are read as for Cinema Yellow; only the local
  // dispatch register changes, the frame's style and the table index stay the new ones.
  hook(p, 0x539113f8, 0xe5d3279c, `ldrb r2,[r3,#0x79c];sub ip,r2,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};movls r2,#${CY};b #0x539113fc`, 'added slots: Cinema input fields');

  // Menu order and counts.
  const order = p.append(concat([p.read(ORDER_TABLE, ORDER_COUNT), Uint8Array.from(slots.map((_, i) => EXTRA_FIRST_STYLE + i))]), 4);
  pointer(p, 0x5337561c, 0x53375620, 4, ORDER_TABLE, order, 'added slots: menu order');
  pointer(p, 0x533cc78c, 0x533cc794, 4, ORDER_TABLE, order, 'added slots: menu order');
  swap(p, 0x53375628, `add r7,r4,#${ORDER_COUNT}`, `add r7,r4,#${ORDER_COUNT + count}`, 'added slots: menu count');
  swap(p, 0x533cc7a4, `add r7,r4,#${ORDER_COUNT}`, `add r7,r4,#${ORDER_COUNT + count}`, 'added slots: menu count');
  swap(p, 0x533cc8c8, `mov r0,#${ORDER_COUNT}`, `mov r0,#${ORDER_COUNT + count}`, 'added slots: list capacity');
  swap(p, 0x533cc90c, `add r3,r5,#${ORDER_COUNT}`, `add r3,r5,#${ORDER_COUNT + count}`, 'added slots: list capacity');
  // The controller reserves this many entries plus the three custom sets.
  swap(p, 0x533bebf0, `mov r0,#${ORDER_COUNT}`, `mov r0,#${ORDER_COUNT + count}`, 'added slots: controller capacity');

  // Look visibility: the new styles are colour looks, hidden on the GR IV Monochrome. Composes
  // with the monochrome looks (`monounlock.ts`) when those are installed.
  const unlocked = p.word(0x533cc6e0) === 0xe3510018;
  expectWord(p, 0x533cc6e4, unlocked ? 0x8a000019 : 0x1a000019);
  hook(p, 0x533cc6e0, unlocked ? 0xe3510018 : 0xe3520000,
    `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;cmp r2,#0;moveq r0,#1;movne r0,#0;bx lr;native:${unlocked ? 'cmp r1,#24;bhi' : 'cmp r2,#0;bne'} #0x533cc750;b #0x533cc6e8`, 'added slots: visibility');
  // Names and icons.
  hook(p, 0x5337f824, 0xe351000a, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;add r0,ip,#${EXTRA_TEXT_ID & 0xf00};add r0,r0,#${EXTRA_TEXT_ID & 0xff};bx lr;native:cmp r1,#10;b #0x5337f828`, 'added slots: name');
  // The ADJ list has an icon lookup of its own (blank entries in test 022 without this).
  hook(p, 0x53380fac, 0xe351000a, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;cmp r2,#0;movne r0,#0;addeq r0,ip,#${EXTRA_ICON_ID};bx lr;native:cmp r1,#10;b #0x53380fb0`, 'added slots: ADJ icon');
  early(p, 0x53397044, `add r0,ip,#${EXTRA_TEXT_ID & 0xf00};add r0,r0,#${EXTRA_TEXT_ID & 0xff}`, count, 'added slots: name');
  early(p, 0x533971cc, `add r0,ip,#${EXTRA_ICON_ID}`, count, 'added slots: icon');
  // The shooting overlay's icon (through CommonProperty); r3 is the style minus 8 there.
  hook(p, 0x533a6880, 0xe3530016, `sub ip,r3,#${EXTRA_FIRST_STYLE - 8};cmp ip,#${count - 1};bhi native;add r0,ip,#${EXTRA_ICON_ID};b #0x533a6898;native:cmp r3,#22;b #0x533a6884`, 'added slots: shooting overlay icon');
  // RAW development has its own numbering (0 = as shot, factory looks up to 20): new ones 21, ...
  for (const at of [0x53373f84, 0x53374118]) {
    hook(p, at, 0xe1a0c00d, `sub ip,r1,#21;cmp ip,#${count - 1};bhi native;add r0,ip,#${EXTRA_FIRST_STYLE};bx lr;native:mov ip,sp;b #${at + 4}`, 'added slots: RAW development look');
  }
  hook(p, 0x53373bc0, 0xe241100b, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;add r0,ip,#21;bx lr;native:sub r1,r1,#11;b #0x53373bc4`, 'added slots: RAW development look');

  installSharedParameters(p, count);
  installPreviewMapping(p, count);
  return concat(parts);
}

// -------------------------------------------------------------- parameters shared with Cinema Yellow

const SETTERS = [0x533ad4e0, 0x533adce0, 0x533ae4e0, 0x533af100, 0x533afd20, 0x533b0940, 0x533b1560, 0x533b2180, 0x533b28e0, 0x533b2b5c, 0x533b2d18, 0x533b2ed4, 0x533b3044, 0x533b3200, 0x533b34dc, 0x533b387c, 0x533b3c1c, 0x533b3fbc, 0x533b4bdc, 0x533b51c0, 0x533b5704, 0x533b5c48, 0x533b618c];
const GETTERS = [0x533b7130, 0x533b7818, 0x533b7f00, 0x533b8928, 0x533b9350, 0x533b9d78, 0x533ba7a0, 0x533bb1c8, 0x533bb858, 0x533bbab8, 0x533bbc78, 0x533bbe30, 0x533bbfa8, 0x533bc148, 0x533bc438, 0x533bc758, 0x533bca78, 0x533bcdb8, 0x533bd7e0, 0x533bdcf0, 0x533be188, 0x533be620, 0x533beab8];
const DEFAULTS = [0x533bf710, 0x533c01bc, 0x533c0c68, 0x533c1c14, 0x533c2bc0, 0x533c3b6c, 0x533c4b18, 0x533c5ac4, 0x533c6494, 0x533c68d4, 0x533c6c34, 0x533c6f90, 0x533c71dc, 0x533c753c, 0x533c79ec, 0x533c8298, 0x533c8b44, 0x533c93f0, 0x533ca39c, 0x533cab78, 0x533cb244, 0x533cb910, 0x533cbfdc];

/** The per-parameter getters, setters and defaults (and two direct readers) take new styles as 18. */
function installSharedParameters(p: Patch, count: number): void {
  const normalize = (at: number, reg: string, original: number, tail: string): void => {
    // The flags are set again by every native entry before use; no callee-saved register, LR or SP changes.
    hook(p, at, original, `sub ip,${reg},#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};movls ${reg},#${CY};${tail};b #${at + 4}`, 'added slots: parameters of Cinema Yellow');
  };
  for (const at of [...SETTERS, ...GETTERS]) normalize(at, 'r3', 0xe1a0c00d, 'mov ip,sp');
  for (const at of DEFAULTS) normalize(at, 'r1', 0xe1a0c00d, 'mov ip,sp');
  normalize(0x533cc5b4, 'r2', 0xe242200d, 'sub r2,r2,#13');
  // The controller's direct custom-set getter: its freshly returned style, locally.
  normalize(0x533b6d6c, 'r0', 0xe1a06000, 'mov r6,r0');
}

/**
 * The live-view / ADJ parameter generator 0x5329E130 (one function of 38 KB) picks each
 * adjustment by comparing the selected style with 18, 19, ...; new styles matched nothing and got
 * the unknown-style defaults. The style is read in six forms, each load followed (at most one
 * unrelated instruction later) by `cmp r3,#imm`, r3 then only compared until it is loaded again:
 *   photo: halfword (style << 8 | custom set) at +0xC3E; custom sets 1..3: bytes +0xC40..+0xC42
 *   movie (r5 = settings + 0x1000): halfword at +0x1000; byte at +0x1004; word at +0x1000
 * Each load is diverted so that the new styles read as 18; only r3 (and r2, saved, for the
 * word) and the flags change. The record's own style byte is written elsewhere: the look itself
 * stays the new one.
 */
const GENERATOR = [0x5329e130, 0x532a7820] as const;
const GENERATOR_LOADS: readonly { word: number; kind: 'half' | 'byte'; sites: number }[] = [
  { word: 0xe19430b3, kind: 'half', sites: 178 }, // ldrh r3,[r4,r3] after movw r3,#0xc3e
  { word: 0xe5d43c40, kind: 'byte', sites: 102 }, // ldrb r3,[r4,#0xc40]
  { word: 0xe5d43c41, kind: 'byte', sites: 103 }, // ldrb r3,[r4,#0xc41]
  { word: 0xe5d43c42, kind: 'byte', sites: 102 }, // ldrb r3,[r4,#0xc42]
  { word: 0xe1d530b0, kind: 'half', sites: 70 }, // ldrh r3,[r5]
  { word: 0xe5d53004, kind: 'byte', sites: 119 }, // ldrb r3,[r5,#4]
];
const GENERATOR_WORD = { word: 0xe5953000, sites: 153 }; // ldr r3,[r5]
/** The instructions found between a load and its cmp; neither touches r3 or the flags. */
const GENERATOR_BETWEEN = [0xe54b2033 /* strb r2,[fp,#-0x33] */, 0xe5d524a1 /* ldrb r2,[r5,#0x4a1] */];
const CMP_R3 = 0xe3530000;
const MOVW_C3E = 0xe3003c3e;

function installPreviewMapping(p: Patch, count: number): void {
  const sitesOf = (word: number): number[] => {
    const out: number[] = [];
    for (let at = GENERATOR[0]; at < GENERATOR[1]; at += 4) if (p.word(at) === word) out.push(at);
    return out;
  };
  const cmpFollows = (at: number): boolean => {
    let next = at + 4;
    if (GENERATOR_BETWEEN.includes(p.word(next))) next += 4;
    return ((p.word(next) & 0xfffff000) >>> 0) === CMP_R3;
  };
  for (const load of GENERATOR_LOADS) {
    const sites = sitesOf(load.word);
    if (sites.length !== load.sites) fail('unexpected-layout', `live-view parameters: ${sites.length} loads of ${load.word.toString(16)}, expected ${load.sites}`);
    for (const at of sites) {
      if (!cmpFollows(at)) fail('unexpected-layout', `live-view parameters: load at 0x${at.toString(16)} is not followed by a compare`);
      if (load.word === 0xe19430b3) {
        let back = at - 4;
        if (((p.word(back) & 0xfffff000) >>> 0) === 0xe54b2000) back -= 4; // strb r2,[fp,#-x]
        if (p.word(back) !== MOVW_C3E) fail('unexpected-layout', `live-view parameters: unexpected load at 0x${at.toString(16)}`);
      }
    }
    const map = load.kind === 'half'
      ? `sub r3,r3,#${EXTRA_FIRST_STYLE << 8};cmp r3,#${count << 8};andlo r3,r3,#0xff;orrlo r3,r3,#${CY << 8};addhs r3,r3,#${EXTRA_FIRST_STYLE << 8}`
      : `sub r3,r3,#${EXTRA_FIRST_STYLE};cmp r3,#${count};movlo r3,#${CY};addhs r3,r3,#${EXTRA_FIRST_STYLE}`;
    for (const at of sites) {
      const code = p.append((a) => [load.word, ...assembleWords(`${map};b #${at + 4}`, a + 4)], 4);
      p.setWord(at, branchWord(at, code), 'added slots: live-view parameters of Cinema Yellow');
    }
  }
  const words = sitesOf(GENERATOR_WORD.word);
  if (words.length !== GENERATOR_WORD.sites) fail('unexpected-layout', `live-view parameters: ${words.length} word loads, expected ${GENERATOR_WORD.sites}`);
  const byte = (shift: number): string =>
    `mov r2,r3,lsr #${shift};and r2,r2,#0xff;sub r2,r2,#${EXTRA_FIRST_STYLE};cmp r2,#${count};` +
    `biclo r3,r3,#${0xff * 2 ** shift};orrlo r3,r3,#${CY * 2 ** shift};`;
  for (const at of words) {
    const code = p.append((a) => [GENERATOR_WORD.word, ...assembleWords(`push {r2};${byte(8)}${byte(16)}${byte(24)}pop {r2};b #${at + 4}`, a + 4)], 4);
    p.setWord(at, branchWord(at, code), 'added slots: live-view parameters of Cinema Yellow');
  }
}

// -------------------------------------------------------------- reading them back

/**
 * The added slots of a grown RTOS image (and its ICONBIN data) as they were built, so that a
 * file can be re-created and compared. Null when the image does not hold `count` added slots.
 */
export function readExtraSlots(rtos: Uint8Array, iconbin: Uint8Array, count: number): ExtraSlotSpec[] | null {
  try {
    if (!(count >= 1 && count <= MAX_EXTRA_SLOTS)) return null;
    const p = new Patch(rtos);
    const rows = TONES + count;
    if (p.word(0x53925f98) !== movRow(rows)) return null;
    const table = (lo: number, hi: number): number => (movImmediate(p.word(lo)) | (movImmediate(p.word(hi)) << 16)) >>> 0;
    const tone = table(0x53925f9c, 0x53925fa4);
    const gamma = table(0x53926020, 0x53926028);
    const stdShared = wordOf(p.readMapped(wordOf(p.readMapped(tone + 4 * STANDARD, 4)) + POST_WORD, 4));
    const out: ExtraSlotSpec[] = [];
    for (let k = 0; k < count; k++) {
      const rec = wordOf(p.readMapped(tone + 4 * (TONES + k), 4));
      const mv = new DataView(p.readMapped(wordOf(p.readMapped(rec + 4, 4)), 18).buffer);
      const matrixQ13 = Array.from({ length: 9 }, (_, i) => mv.getInt16(2 * i, true));
      const desc = wordOf(p.readMapped(gamma + 4 * (TONES + k), 4));
      const curves = [0, 1, 2].map((c) => {
        const b = p.readMapped(wordOf(p.readMapped(desc + 8 + 4 * c, 4)), 512);
        const v = new DataView(b.buffer);
        return Array.from({ length: 256 }, (_, i) => v.getUint16(2 * i, true));
      }) as [number[], number[], number[]];
      const post = wordOf(p.readMapped(rec + POST_WORD, 4));
      let postQ9: number[] | undefined;
      if (post !== stdShared) {
        const e = new DataView(p.readMapped(wordOf(p.readMapped(post + 4 * POST_NEUTRAL, 4)), 18).buffer);
        postQ9 = Array.from({ length: 9 }, (_, i) => e.getInt16(2 * i, true) / 16);
      }
      const textDesc = p.word(p.word(TEXT_CATALOG) + (EXTRA_TEXT_ID + k) * 4);
      const units = p.read(textDesc, 1)[0];
      const tb = p.read(p.word(textDesc + 4), (units - 1) * 2);
      let name = '';
      for (let i = 0; i < units - 1; i++) name += String.fromCharCode(tb[2 * i] | (tb[2 * i + 1] << 8));
      const iconDesc = p.word(ICON_CATALOG + (EXTRA_ICON_ID + k) * 4);
      const iconOffset = p.word(iconDesc + 8) * 4;
      if (iconOffset + EXTRA_ICON_BYTES > iconbin.length) return null;
      const icon = iconbin.slice(iconOffset, iconOffset + EXTRA_ICON_BYTES);
      out.push({ name, matrixQ13, curves, ...(postQ9 ? { postQ9 } : {}), icon });
    }
    return out;
  } catch {
    return null;
  }
}

function movRow(rows: number): number {
  return assembleWords(`mov r2,#${rows}`, 0x53925f98)[0];
}
