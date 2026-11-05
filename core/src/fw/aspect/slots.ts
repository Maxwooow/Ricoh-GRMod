// SPDX-License-Identifier: GPL-2.0-only
/**
 * Added Image Control slots (styles 34, 35, ...): up to twenty more looks in the camera's list, each
 * with its own matrix, tone curves, post-curve ("second") matrix and adjustment parameters. Tested
 * on a GR IV HDF as GR Mod test firmwares 023..034 (four slots).
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
 * counts, names (texts 846..851, then 864..877), icons (768..779, then 782..789), the ADJ list's own icon lookup, the shooting
 * overlay, RAW development and the look-visibility check (hidden on the GR IV Monochrome).
 * The adjustable parameters (saturation, contrast, grain, ...): the firmware keeps them per
 * factory style only, and whatever reads them for the selected look (live-view generator,
 * development, the camera model behind the parameter screen) takes the new styles as Cinema
 * Yellow (18). Each new style still has its own values: Cinema Yellow's fields hold the values of
 * the look selected in a set, the others wait in a table of a native module saved with the
 * settings (see `installOwnParameters`). They start at the neutral values, which the parameter
 * screen also shows as their defaults. Tested on a GR IV HDF as test firmwares 026..034.
 */
import { assembleWords, branchTarget, branchWord, movImmediate, movWord } from './arm';
import { BASE, ICON_CATALOG, LOOKUP_BOUNDS, OFFICIAL_RTOS_LENGTH, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z } from './build';
import { linkModule } from './native-link';
import { LOOK_STASH, STASH_ASM, installLookStash } from './lookstash';
import { SLOT_PARAMETERS, SLOT_PARAMS_MODULE } from './slotparams-native';
import { HALATION_COLOUR_NAMES, HALATION_LOOKS, HALATION_NAMES, halationColourIcon, halationColourScale, halationIcon, installHalationModule, readHalation } from './halation';
import { installHalationClamps, installHalationUi } from './halation-ui';
import type { HalationLook } from './halation';
import { HUE_LIMIT, HUE_VALUES, hueBlockBytes, hueFromBlock } from '../../color/hue';
import { FirmwareError } from '../types';
import { installFactoryHidden, validateLookLayout } from './looks';
import type { LookLayout } from './looks';

/** Up to 0.8.1: 6. */
export const MAX_EXTRA_SLOTS = 20;
/** Style number of the first added slot (the firmware has 34: 0..33). */
export const EXTRA_FIRST_STYLE = 34;
/**
 * Text number of the first added slot's name. Slots 0..5 have 846..851 (as up to 0.8.1); 852 is
 * "Halation" and 853..863 the power-off menu, so slots 6.. have 864...
 */
export const EXTRA_TEXT_ID = 846;
const EXTRA_TEXT_SPLIT = 6;
const EXTRA_TEXT_ID_2 = 864;
/** Icon number of the first added slot's icon: slots 0..11 768..779 (780, 781 are halation's), slots 12.. 782..789 (790, 791 halation's). */
export const EXTRA_ICON_ID = 768;
const EXTRA_ICON_SPLIT = 12;
const EXTRA_ICON_ID_2 = 782;
export const extraTextId = (k: number): number => (k < EXTRA_TEXT_SPLIT ? EXTRA_TEXT_ID + k : EXTRA_TEXT_ID_2 + k - EXTRA_TEXT_SPLIT);
export const extraIconId = (k: number): number => (k < EXTRA_ICON_SPLIT ? EXTRA_ICON_ID + k : EXTRA_ICON_ID_2 + k - EXTRA_ICON_SPLIT);
/** `dst` = the text (icon) number of added slot `k` (registers; `dst` is not `k`; flags change). */
const textAsm = (dst: string, k: string): string => `cmp ${k},#${EXTRA_TEXT_SPLIT};movw ${dst},#${EXTRA_TEXT_ID};movwhs ${dst},#${EXTRA_TEXT_ID_2 - EXTRA_TEXT_SPLIT};add ${dst},${dst},${k}`;
const iconAsm = (dst: string, k: string): string => `cmp ${k},#${EXTRA_ICON_SPLIT};movw ${dst},#${EXTRA_ICON_ID};movwhs ${dst},#${EXTRA_ICON_ID_2 - EXTRA_ICON_SPLIT};add ${dst},${dst},${k}`;
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
  /**
   * Hue sectors of its own (experimental): copy 0 of the multi-axis block, 12 x 9 values in
   * Q10, every row summing to 1024, |value| <= HUE_LIMIT. The slot then gets a block of its own
   * (copies c = 1..4 scaled by (16 - c) / 16 as the official blocks, `hueBlockBytes`) instead of
   * pointing at Standard's. Absent = Standard's block, as before.
   */
  hueQ10?: ArrayLike<number>;
  /** 40x40 RGBA. Fully transparent pixels stay transparent, others are made opaque. */
  icon: Uint8Array;
  /**
   * Halation (CineStill 800T, fixed look) for the slot's "Halation" levels Off / Weak / Strong (the
   * slider of Cinema's Toning); absent or false = none.
   */
  halation?: boolean;
}

/**
 * Text of the parameter name "Halation", icon of its list entry; in its submenu (0.8.2) the colour
 * row's name, the colour slider's scale and the red and white row icons. (Icon 781 was the Off /
 * Weak / Strong scale up to test 042.)
 */
export const HALATION_TEXT_ID = 852;
export const HALATION_COLOUR_TEXT_ID = 878;
export const HALATION_ICON_ID = 780;
export const HALATION_COLOUR_SCALE_ICON_ID = 781;
export const HALATION_RED_ICON_ID = 790;
export const HALATION_WHITE_ICON_ID = 791;
/** Text of Cinema's Toning (and of the black-and-white toning, which no added look has). */
const TONING_TEXT = 339;
/** Toning's list icon. */
const TONING_ICON = 0x16f;
/** The native two-position (Off / On) scale whose panel and track the colour scale reuses. */
const NATIVE_SCALE_ICON = 0x3a;
/** The word the development step leaves for the halation module: style | level << 8 | valid. */
const HALATION_STASH = LOOK_STASH;

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

function hueBytes(k: number, q: ArrayLike<number>): Uint8Array {
  if (!q || q.length !== HUE_VALUES) fail('bad-color', `added slot ${k + 1}: hue sectors must be 12 x 9 values`);
  for (let i = 0; i < HUE_VALUES; i++) {
    const v = q[i];
    if (!Number.isInteger(v) || v < -HUE_LIMIT || v > HUE_LIMIT) fail('bad-color', `added slot ${k + 1}: hue value ${String(v)} is outside -${HUE_LIMIT}..${HUE_LIMIT}`);
  }
  for (let g = 0; g < 12; g++) for (let r = 0; r < 3; r++) {
    const o = g * 9 + r * 3;
    if (q[o] + q[o + 1] + q[o + 2] !== 1024) fail('bad-color', `added slot ${k + 1}: hue sector ${g} row ${r} does not sum to 1024`);
  }
  return hueBlockBytes(q);
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
export function installExtraSlots(p: Patch, iconbin: Uint8Array, slots: readonly ExtraSlotSpec[], options: { stashLook?: boolean; layout?: LookLayout } = {}): Uint8Array {
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
  const prints: number[] = [];
  const parts: Uint8Array[] = [iconbin];
  let iconLength = iconbin.length;
  slots.forEach((s, k) => {
    const problem = validateExtraSlotName(s.name);
    if (problem) fail('bad-name', `added slot ${k + 1}: name is ${problem}`);
    const mBytes = matrixBytes(k, s.matrixQ13);
    if (!s.curves || s.curves.length !== 3) fail('bad-color', `added slot ${k + 1}: curves must be [R, G, B]`);
    const cBytes = s.curves.map((c) => curveBytes(k, c));
    if (s.postQ9 !== undefined) checkPost(k, s.postQ9);
    const hueData = s.hueQ10 !== undefined ? hueBytes(k, s.hueQ10) : undefined;
    if (s.halation !== undefined && typeof s.halation !== 'boolean') fail('bad-halation', `added slot ${k + 1}: halation is on or off`);
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
    const block = hueData ? p.append(hueData, 4) : stdBlock;
    const maArray = p.append(u32le(new Array(MA_POINTERS).fill(block)), 4);
    const m = maTemplate.slice();
    new DataView(m.buffer).setUint32(8, maArray, true);
    const maNew = p.append(m, 4);
    records.push([recNew, maNew, ycc, gammaNew]);
    prints.push(fingerprint([mBytes, ...cBytes, s.postQ9 !== undefined ? u32le(Array.from(s.postQ9, (v) => v >>> 0)) : new Uint8Array(0), ...(hueData ? [hueData] : [])]));

    const text = p.append(utf16z(s.name), 4);
    const textDesc = p.append(concat([Uint8Array.from([s.name.length + 1, 1, 0, 0]), u32le([text])]), 4);
    for (let l = 0; l < 21; l++) {
      const row = p.word(TEXT_CATALOG + l * 4);
      expectWord(p, row + extraTextId(k) * 4, 0);
      p.write(row + extraTextId(k) * 4, u32le([textDesc]));
    }
    const pad = (4 - (iconLength % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      iconLength += pad;
    }
    expectWord(p, ICON_CATALOG + extraIconId(k) * 4, 0);
    const iconDesc = p.append(concat([u16le([1, 40, 40, 0]), u32le([iconLength / 4])]), 16);
    p.setWord(ICON_CATALOG + extraIconId(k) * 4, iconDesc, 'added slot icon');
    parts.push(icon);
    iconLength += icon.length;
  });
  const lastText = extraTextId(count - 1);
  const lastIcon = extraIconId(count - 1);
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
  // dispatch register changes, the frame's style and the table index stay the new ones. With
  // halation or the date imprint by look, the frame's style and Toning (halation) level are also
  // left for the JPEG step (see lookstash.ts).
  const stash = options.stashLook ? STASH_ASM : '';
  hook(p, 0x539113f8, 0xe5d3279c, `${stash}ldrb r2,[r3,#0x79c];sub ip,r2,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};movls r2,#${CY};b #0x539113fc`, 'added slots: Cinema input fields');

  const layout = options.layout;
  // Menu order and counts. With a user layout the order may be any permutation of the factory
  // looks and the added slots; the list capacity grows by the same number as without one.
  if (layout) validateLookLayout(layout, count);
  const orderIds = layout ? [...layout.order] : [...p.read(ORDER_TABLE, ORDER_COUNT), ...slots.map((_, i) => EXTRA_FIRST_STYLE + i)];
  const total = orderIds.length;
  const order = p.append(Uint8Array.from(orderIds), 4);
  pointer(p, 0x5337561c, 0x53375620, 4, ORDER_TABLE, order, 'added slots: menu order');
  pointer(p, 0x533cc78c, 0x533cc794, 4, ORDER_TABLE, order, 'added slots: menu order');
  if (total !== ORDER_COUNT + count) fail('internal', 'look order length does not match the added slots');
  swap(p, 0x53375628, `add r7,r4,#${ORDER_COUNT}`, `add r7,r4,#${total}`, 'added slots: menu count');
  swap(p, 0x533cc7a4, `add r7,r4,#${ORDER_COUNT}`, `add r7,r4,#${total}`, 'added slots: menu count');
  swap(p, 0x533cc8c8, `mov r0,#${ORDER_COUNT}`, `mov r0,#${total}`, 'added slots: list capacity');
  swap(p, 0x533cc90c, `add r3,r5,#${ORDER_COUNT}`, `add r3,r5,#${total}`, 'added slots: list capacity');
  // The controller reserves this many entries plus the three custom sets.
  swap(p, 0x533bebf0, `mov r0,#${ORDER_COUNT}`, `mov r0,#${total}`, 'added slots: controller capacity');

  // Look visibility: the new styles are colour looks, hidden on the GR IV Monochrome. Composes
  // with the monochrome looks (`monounlock.ts`) when those are installed.
  const unlocked = p.word(0x533cc6e0) === 0xe3510018;
  expectWord(p, 0x533cc6e4, unlocked ? 0x8a000019 : 0x1a000019);
  const hiddenExtras = (layout?.hidden ?? []).filter((id) => id >= EXTRA_FIRST_STYLE && id < EXTRA_FIRST_STYLE + count);
  const hideChecks = hiddenExtras.map((id) => `cmp r1,#${id};beq hidden;`).join('');
  hook(p, 0x533cc6e0, unlocked ? 0xe3510018 : 0xe3520000,
    `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;${hideChecks}cmp r2,#0;moveq r0,#1;movne r0,#0;bx lr;hidden:mov r0,#0;bx lr;native:${unlocked ? 'cmp r1,#24;bhi' : 'cmp r2,#0;bne'} #0x533cc750;b #0x533cc6e8`, 'added slots: visibility');
  if (layout) installFactoryHidden(p, layout.hidden);
  // Names and icons.
  hook(p, 0x5337f824, 0xe351000a, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;${textAsm('r0', 'ip')};bx lr;native:cmp r1,#10;b #0x5337f828`, 'added slots: name');
  // The ADJ list has an icon lookup of its own (blank entries in test 022 without this).
  hook(p, 0x53380fac, 0xe351000a, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;cmp r2,#0;movne r0,#0;bxne lr;${iconAsm('r0', 'ip')};bx lr;native:cmp r1,#10;b #0x53380fb0`, 'added slots: ADJ icon');
  early(p, 0x53397044, textAsm('r0', 'ip'), count, 'added slots: name');
  early(p, 0x533971cc, iconAsm('r0', 'ip'), count, 'added slots: icon');
  // The shooting overlay's icon (through CommonProperty); r3 is the style minus 8 there.
  hook(p, 0x533a6880, 0xe3530016, `sub ip,r3,#${EXTRA_FIRST_STYLE - 8};cmp ip,#${count - 1};bhi native;${iconAsm('r0', 'ip')};b #0x533a6898;native:cmp r3,#22;b #0x533a6884`, 'added slots: shooting overlay icon');
  // RAW development has its own numbering (0 = as shot, factory looks up to 20): new ones 21, ...
  for (const at of [0x53373f84, 0x53374118]) {
    hook(p, at, 0xe1a0c00d, `sub ip,r1,#21;cmp ip,#${count - 1};bhi native;add r0,ip,#${EXTRA_FIRST_STYLE};bx lr;native:mov ip,sp;b #${at + 4}`, 'added slots: RAW development look');
  }
  hook(p, 0x53373bc0, 0xe241100b, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};bhi native;add r0,ip,#21;bx lr;native:sub r1,r1,#11;b #0x53373bc4`, 'added slots: RAW development look');

  const hiddenMask = hiddenExtras.reduce((m, id) => (m | (1 << (id - EXTRA_FIRST_STYLE))) >>> 0, 0);
  const module = installOwnParameters(p, count, prints, hiddenMask);
  installPreviewMapping(p, count);
  installChangeFunctors(p, count);
  installLookChecks(p, count);
  installRawDevelopment(p, count, module);
  installPictureInfo(p, count);
  return concat(parts);
}

// -------------------------------------------------------------- own parameters

const SETTERS = [0x533ad4e0, 0x533adce0, 0x533ae4e0, 0x533af100, 0x533afd20, 0x533b0940, 0x533b1560, 0x533b2180, 0x533b28e0, 0x533b2b5c, 0x533b2d18, 0x533b2ed4, 0x533b3044, 0x533b3200, 0x533b34dc, 0x533b387c, 0x533b3c1c, 0x533b3fbc, 0x533b4bdc, 0x533b51c0, 0x533b5704, 0x533b5c48, 0x533b618c];
const GETTERS = [0x533b7130, 0x533b7818, 0x533b7f00, 0x533b8928, 0x533b9350, 0x533b9d78, 0x533ba7a0, 0x533bb1c8, 0x533bb858, 0x533bbab8, 0x533bbc78, 0x533bbe30, 0x533bbfa8, 0x533bc148, 0x533bc438, 0x533bc758, 0x533bca78, 0x533bcdb8, 0x533bd7e0, 0x533bdcf0, 0x533be188, 0x533be620, 0x533beab8];
const DEFAULTS = [0x533bf710, 0x533c01bc, 0x533c0c68, 0x533c1c14, 0x533c2bc0, 0x533c3b6c, 0x533c4b18, 0x533c5ac4, 0x533c6494, 0x533c68d4, 0x533c6c34, 0x533c6f90, 0x533c71dc, 0x533c753c, 0x533c79ec, 0x533c8298, 0x533c8b44, 0x533c93f0, 0x533ca39c, 0x533cab78, 0x533cb244, 0x533cb910, 0x533cbfdc];
/** "Style of set" setters: photo standard, custom 1..3, then movie. */
const STYLE_SETTERS = [0x532b6f80, 0x532b7110, 0x532b72a0, 0x532b7430, 0x53300aa0, 0x53300c34, 0x53300dc8, 0x53300f5c];
/**
 * The values an added slot starts from and shows as its default on the parameter screen ("0"):
 * the middle of the -4..+4 scales, parameter 8 off (what Standard, which lacks it, gets), grain
 * off with Cinema Yellow's strength and size (those two have no neutral position). In the order of
 * `SLOT_PARAMETERS`; the same table is in slot_params.c.
 */
const NEUTRAL = [4, 4, 4, 4, 4, 4, 4, 0, 4, 4, 0, 1, 1];
/** Settings save / load (power off / start), made hookable by the scaffold of `build.ts`. */
const SETTINGS_SAVE = 0x533e1c04;
const SETTINGS_LOAD = 0x533e17cc;
/** Literal: end of the start-up zero fill. 44 unused bytes up to the heap (0x55837300) follow it. */
const ZERO_FILL_END = 0x53000460;
const SLOT_STATE = 0x558372e0;

/**
 * Own adjustment parameters for every added slot (tools/slotparams/slot_params.c): the firmware
 * keeps parameters per factory style in the user settings, and everything that reads them for the
 * selected look takes the added styles as Cinema Yellow (18). So per photo/movie set (8) Cinema
 * Yellow's fields belong to one owner, the added look selected in that set or else Cinema Yellow;
 * the other owners' values are kept by the module in a table saved as its own record (HTData 12).
 * Getters and setters of the 13 parameters Cinema Yellow has, and the 8 "style of set" setters,
 * go through the module; settings load and save also load and save the table. The other 10
 * parameters, and two direct readers, still take the added styles as 18. Developed as test
 * firmwares 026..034.
 */
/** FNV-1a of a slot's colour data: the module starts a slot again from neutral when it changes (never 0). */
function fingerprint(parts: readonly Uint8Array[]): number {
  let h = 0x811c9dc5;
  for (const b of parts) for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h || 1;
}

function installOwnParameters(p: Patch, count: number, prints: readonly number[], hiddenMask = 0): Record<string, number> {
  if (prints.length !== count) fail('internal', 'a fingerprint per added slot');
  const normalize = (at: number, reg: string, original: number, tail: string): void => {
    // The flags are set again by every native entry before use; no callee-saved register, LR or SP changes.
    hook(p, at, original, `sub ip,${reg},#${EXTRA_FIRST_STYLE};cmp ip,#${count - 1};movls ${reg},#${CY};${tail};b #${at + 4}`, 'added slots: parameters of Cinema Yellow');
  };
  const own = new Set(SLOT_PARAMETERS);
  for (let i = 0; i < 23; i++) {
    if (own.has(i)) continue;
    normalize(SETTERS[i], 'r3', 0xe1a0c00d, 'mov ip,sp');
    normalize(GETTERS[i], 'r3', 0xe1a0c00d, 'mov ip,sp');
    normalize(DEFAULTS[i], 'r1', 0xe1a0c00d, 'mov ip,sp');
  }
  // The parameter screen marks each slider's default with the default getter's value (r1 = look).
  SLOT_PARAMETERS.forEach((i, j) => {
    early(p, DEFAULTS[i], `mov r0,#${NEUTRAL[j]}`, count, 'added slots: neutral parameter default');
  });
  normalize(0x533cc5b4, 'r2', 0xe242200d, 'sub r2,r2,#13');
  // The controller's direct custom-set getter: its freshly returned style, locally.
  normalize(0x533b6d6c, 'r0', 0xe1a06000, 'mov r6,r0');

  if (p.word(ZERO_FILL_END) !== 0x55837300) expectWord(p, ZERO_FILL_END, 0x558372d4); // (or already extended, e.g. for the live-view repaint)
  const priorSave = branchTarget(SETTINGS_SAVE, p.word(SETTINGS_SAVE));
  const priorLoad = branchTarget(SETTINGS_LOAD, p.word(SETTINGS_LOAD));
  if (priorSave < BASE + OFFICIAL_RTOS_LENGTH || priorLoad < BASE + OFFICIAL_RTOS_LENGTH) fail('internal', 'the settings save/load scaffold is not installed');
  for (const at of [...SLOT_PARAMETERS.map((i) => GETTERS[i]), ...SLOT_PARAMETERS.map((i) => SETTERS[i]), ...STYLE_SETTERS]) expectWord(p, at, 0xe1a0c00d);
  // The fingerprints, then the hidden slots (bit k: slot k; see slot_params.c).
  const printTable = p.append(u32le([...prints, hiddenMask]), 4);
  const origin = p.next(16);
  const mod = linkModule(SLOT_PARAMS_MODULE, 'slot parameters', count, origin, {
    prior_native_save: priorSave, prior_native_load: priorLoad, storage_singleton: 0x53a81480, store_write: 0x53a7e518,
    store_read: 0x53a7e434, store_size: 0x53a7e208, heap_alloc: 0x538e09b0, sp_gap: SLOT_STATE, settings_object: 0x55084dd8, slot_prints: printTable,
  });
  if (p.append(mod.code, 16) !== origin) fail('internal', 'module address changed');
  SLOT_PARAMETERS.forEach((i, j) => {
    p.setWord(GETTERS[i], branchWord(GETTERS[i], mod.symbols[`sp_get_stub_${j}`]), 'added slots: own parameters (getter)');
    p.setWord(SETTERS[i], branchWord(SETTERS[i], mod.symbols[`sp_set_stub_${j}`]), 'added slots: own parameters (setter)');
  });
  STYLE_SETTERS.forEach((at, k) => p.setWord(at, branchWord(at, mod.symbols[`sp_style_stub_${k}`]), 'added slots: own parameters (look of a set changes)'));
  p.setWord(SETTINGS_SAVE, branchWord(SETTINGS_SAVE, mod.symbols.sp_save), 'settings save, then the added slots\' parameters');
  p.setWord(SETTINGS_LOAD, branchWord(SETTINGS_LOAD, mod.symbols.sp_load), 'settings load, then the added slots\' parameters');
  // The module keeps its state pointer in the 44 bytes between the end of the zero fill and the
  // heap; they are cleared at every start from now on.
  if (p.word(ZERO_FILL_END) !== 0x55837300) p.setWord(ZERO_FILL_END, 0x55837300, 'start-up zero fill also clears the 44 unused bytes before the heap');
  return mod.symbols;
}

/**
 * The change functors of Cinema Yellow's fields (one per parameter and set, 0x532776EC..): a setter
 * registers one; it copies the field to the record the getters read and, when Cinema Yellow is the
 * set's look, gives the value to the camera model the parameter screen and the shooting read.
 * They test the look by loading the style in one of five forms, each followed by the comparison
 * with 18; those loads take the added styles as 18. Without this the model keeps the old value for
 * an added look and its parameter screen snaps back (test 030).
 */
const FUNCTOR_FIELDS = [
  [0x15b, 0x207, 0x2b3, 0x35f, 0x51d, 0x599, 0x615, 0x691], [0x165, 0x211, 0x2bd, 0x369, 0x526, 0x5a2, 0x61e, 0x69a],
  [0x173, 0x21f, 0x2cb, 0x377, 0x532, 0x5ae, 0x62a, 0x6a6], [0x180, 0x22c, 0x2d8, 0x384, 0x53e, 0x5ba, 0x636, 0x6b2],
  [0x18d, 0x239, 0x2e5, 0x391, 0x54a, 0x5c6, 0x642, 0x6be], [0x19a, 0x246, 0x2f2, 0x39e, 0x556, 0x5d2, 0x64e, 0x6ca],
  [0x1a7, 0x253, 0x2ff, 0x3ab, 0x562, 0x5de, 0x65a, 0x6d6], [0x1b0, 0x25c, 0x308, 0x3b4, 0x56a, 0x5e6, 0x662, 0x6de],
  [0x1d8, 0x284, 0x330, 0x3dc, 0x58f, 0x60b, 0x687, 0x703], [0x1e4, 0x290, 0x33c, 0x3e8], [0x1fb, 0x2a7, 0x353, 0x3ff],
  [0x1fc, 0x2a8, 0x354, 0x400], [0x1fd, 0x2a9, 0x355, 0x401],
];
const FUNCTOR_AREA = [0x53270000, 0x532a0000] as const;
const FUNCTOR_LOADS: Readonly<Record<number, 'half' | 'byte' | 'word'>> = {
  0xe19030b3: 'half', // ldrh r3,[r0,r3] after movw r3,#0xc3e (photo standard set)
  0xe5d03c40: 'byte', 0xe5d03c41: 'byte', 0xe5d03c42: 'byte', // ldrb r3,[r0,#0xc40..2] (photo custom sets)
  0xe1d430b0: 'half', // ldrh r3,[r4] (movie)
  0xe5943000: 'word', // ldr r3,[r4] (movie custom sets 1, 2)
  0xe5d43004: 'byte', // ldrb r3,[r4,#4] (movie custom set 3)
};
const FUNCTOR_NEXT: Readonly<Record<string, readonly number[]>> = { half: [0xe3530c12], byte: [0xe3530012], word: [0xe3a02001, 0xe3a02002] };

function installChangeFunctors(p: Patch, count: number): void {
  const F = EXTRA_FIRST_STYLE;
  const map = {
    half: `sub r3,r3,#${F << 8};cmp r3,#${count << 8};andlo r3,r3,#0xff;orrlo r3,r3,#${CY << 8};addhs r3,r3,#${F << 8}`,
    byte: `sub r3,r3,#${F};cmp r3,#${count};movlo r3,#${CY};addhs r3,r3,#${F}`,
    word: 'push {r2};' + [8, 16, 24].map((sh) => `mov r2,r3,lsr #${sh};and r2,r2,#0xff;sub r2,r2,#${F};cmp r2,#${count};biclo r3,r3,#${0xff * 2 ** sh};orrlo r3,r3,#${CY * 2 ** sh};`).join('') + 'pop {r2}',
  };
  const sites: number[] = [];
  for (const row of FUNCTOR_FIELDS) for (const field of row) {
    const starts: number[] = [];
    for (let a = FUNCTOR_AREA[0]; a < FUNCTOR_AREA[1]; a += 4) if (p.word(a) === ((0xe5d03000 | field) >>> 0)) starts.push(a);
    if (starts.length !== 1) fail('unexpected-layout', `change functor of field 0x${field.toString(16)}: ${starts.length} candidates`);
    const found: number[] = [];
    for (let a = starts[0], k = 0; k < 30; k++, a += 4) {
      const w = p.word(a);
      if (FUNCTOR_LOADS[w] && !(w === 0xe19030b3 && p.word(a - 4) !== MOVW_C3E)) found.push(a);
      if (w >>> 24 === 0xea) break;
    }
    if (found.length !== 1) fail('unexpected-layout', `change functor of field 0x${field.toString(16)}: ${found.length} style loads`);
    if (!FUNCTOR_NEXT[FUNCTOR_LOADS[p.word(found[0])]].includes(p.word(found[0] + 4))) fail('unexpected-layout', `change functor of field 0x${field.toString(16)}: unexpected comparison`);
    sites.push(found[0]);
  }
  if (sites.length !== 88) fail('unexpected-layout', `${sites.length} change functors, expected 88`);
  for (const at of sites) {
    const w = p.word(at);
    const code = p.append((a) => [w, ...assembleWords(`${map[FUNCTOR_LOADS[w]]};b #${at + 4}`, a + 4)], 4);
    p.setWord(at, branchWord(at, code), 'added slots: change functor of Cinema Yellow');
  }
}

/**
 * Looks shown as their own, not as Standard or with Standard's parameter list:
 *  - the parameter screens pick their list of parameters from the look (0x531C6B1C shooting,
 *    0x531A57FC RAW development: 11..30 -> a list, anything else -> list 0 without grain); the
 *    added looks get Cinema Yellow's (test 032);
 *  - the main menu's Image Control row asks 0x5329CF30 (photo) / 0x5329D154 (movie) for the
 *    look, which answers 0..30 and Standard for anything else; the added looks are answered as
 *    themselves, the icon lookup knows them (test 033);
 *  - whether a picture goes through the digital-filter step (grain, Clarity, the setting before
 *    it) is decided from the look by 0x537150FC with a chain of compares that includes Cinema
 *    Yellow; the added looks are tested as 18, only in the local register (test 033). Composes
 *    with soft focus, which changes two later instructions of that function.
 */
function installLookChecks(p: Patch, count: number): void {
  const n = count - 1;
  hook(p, 0x531c6b1c, 0xe1a0c00d, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${n};movls r1,#${CY};mov ip,sp;b #0x531c6b20`, 'added slots: parameter list of Cinema Yellow');
  hook(p, 0x531a57fc, 0xe241100b, `sub ip,r1,#${EXTRA_FIRST_STYLE};cmp ip,#${n};movls r1,#${CY};sub r1,r1,#11;b #0x531a5800`, 'added slots: RAW development parameter list of Cinema Yellow');
  for (const [at, field, done, rest] of [[0x5329cf6c, 0x153, 0x5329cf64, 0x5329cf70], [0x5329d190, 0x515, 0x5329d188, 0x5329d194]] as const) {
    hook(p, at, (0xe5d03000 | field) >>> 0, `ldrb r3,[r0,#${field}];sub ip,r3,#${EXTRA_FIRST_STYLE};cmp ip,#${n};movls r0,r3;bls #${done};b #${rest}`, 'added slots: menu Image Control row');
  }
  hook(p, 0x537150fc, 0xe5d1379c, `ldrb r3,[r1,#0x79c];sub r2,r3,#${EXTRA_FIRST_STYLE};cmp r2,#${n};movls r3,#${CY};b #0x53715100`, 'added slots: digital-filter step (grain) as Cinema Yellow');
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

// -------------------------------------------------------------- RAW development

/** RAW development's number of Cinema Yellow (its numbering: 0 = as shot, 1..20 the factory looks). */
const RAW_CY = 9;
const RAW_FIRST_EXTRA = 21;
/** The functions of RawDevelopmentModel.cpp that read or write a look's parameters. */
const RAW_MODEL = [0x5336c000, 0x53373400] as const;
/** `ldrb r2,[r3,#0x9d]` (the look of the selected custom base), always followed by `cmp r2,#0`. */
const RAW_LOOK_LOAD = 0xe5d3209d;
const RAW_LOOK_SITES = 72;

/**
 * In-camera RAW development keeps its own copy of the parameters: per custom base (4, the photo
 * sets) and look (0..20) 18 bytes, two bytes of grain, and a table (0x53DBB8F0) of which
 * parameters each look has. Every function that reads or writes them first turns the look into a
 * row with a loop over 1..20, so an added look (21, ...) got row 0, whose parameters are all
 * "absent": the parameter screen showed -4 everywhere and developing stopped the camera (reported
 * on 0.7.0). The added looks now use Cinema Yellow's row, as the shooting side does with Cinema
 * Yellow's fields; the look itself (name, icon, the style given to development) stays the added
 * one. And as there, the row belongs to one owner per base, the others' values are kept by the
 * slot-parameter module (`sp_raw_*` in slot_params.c): when a RAW file is opened every added look
 * gets its own saved values; before the model applies a look (every change of look goes through
 * 0x53374360) the row is handed to it; the parameters a RAW file was shot with go to its look.
 */
function installRawDevelopment(p: Patch, count: number, module: Record<string, number>): void {
  const map = (r: string): string => `sub ${r},${r},#${RAW_FIRST_EXTRA};cmp ${r},#${count};movlo ${r},#${RAW_CY};addhs ${r},${r},#${RAW_FIRST_EXTRA}`;
  const sites: number[] = [];
  for (let at = RAW_MODEL[0]; at < RAW_MODEL[1]; at += 4) {
    if (p.word(at) !== RAW_LOOK_LOAD) continue;
    // Only the loads that pick a row: the loaded look is compared with r3 by the 1..20 loop.
    let row = false;
    for (let k = 1; k < 30 && !row; k++) {
      if (p.word(at + 4 * k) !== 0xe1520003) continue; // cmp r2,r3
      for (let j = 1; j < 6; j++) if (p.word(at + 4 * (k + j)) === 0xe3530015) row = true; // cmp r3,#21
    }
    if (!row) continue;
    if (p.word(at + 4) !== 0xe3520000) fail('unexpected-layout', `RAW development: load at 0x${at.toString(16)} is not followed by cmp r2,#0`);
    sites.push(at);
  }
  if (sites.length !== RAW_LOOK_SITES) fail('unexpected-layout', `RAW development: ${sites.length} look loads, expected ${RAW_LOOK_SITES}`);
  for (const at of sites) {
    const code = p.append((a) => [RAW_LOOK_LOAD, ...assembleWords(`${map('r2')};b #${at + 4}`, a + 4)], 4);
    p.setWord(at, branchWord(at, code), 'added slots: RAW development parameters of Cinema Yellow');
  }
  // Opening a RAW file: the model has filled every look from the settings (0x53373D04, r4 the model).
  hook(p, 0x53374e24, 0xe5d42064, `push {r0-r3,ip,lr};mov r0,r4;bl #${module.sp_raw_init};pop {r0-r3,ip,lr};ldrb r2,[r4,#0x64];b #0x53374e28`, 'added slots: own RAW development parameters');
  // Then it copies the parameters the file was shot with into the row of its look (base 0).
  hook(p, 0x53374e98, 0xe3500000, `push {r0-r3,ip,lr};mov r2,r0;mov r1,#0;mov r0,r4;bl #${module.sp_raw_own};pop {r0-r3,ip,lr};${map('r0')};cmp r0,#0;b #0x53374e9c`, 'added slots: RAW development parameters as shot');
  // Applying a look: the row goes to the looks now selected.
  hook(p, 0x53374360, 0xe1a0c00d, `push {r0-r4,lr};bl #${module.sp_raw_sync};pop {r0-r4,lr};mov ip,sp;b #0x53374364`, 'added slots: own RAW development parameters');
  // The RAW development screen makes its list as long as the longest of its lists (0x531A13C8):
  // Image Control at most 24 entries (the factory looks, the three custom sets, "as shot"). With
  // the added looks the list is longer; the list widget then refuses the count (assertion) and the
  // camera stops on entering Image Control (0.7.1 with 4 added slots).
  swap(p, 0x5336b89c, 'mov r0,#24', `mov r0,#${24 + count}`, 'added slots: RAW development list capacity');
}

// -------------------------------------------------------------- picture information

/**
 * The picture's look as written in the maker note (Pentax "ImageTone"): 0x100.. and 0x8100..
 * for the factory looks; the added ones get 0x8110, 0x8111, ... (before, anything unknown was
 * written as 0x100, Standard).
 */
export const EXTRA_TONE_CODE = 0x8110;
/** Playback's own numbering of the looks (0x53DBDA18: 1..20); the added ones are 21, ... */
const PLAY_FIRST_EXTRA = 21;
/** Static init of the "looks that have parameter X" lists the maker note writers consult. */
const PARAM_LISTS = [0x537e0e94, 0x537e117c] as const;
const LIST_ASSIGN = 0x537da700;
const PARAM_LISTS_CALLS = 18;
const PARAM_LISTS_WITH_CY = 7;

/**
 * Pictures shot with an added look:
 *  - the maker note names the look (0x537DE474 looked it up in a list of the factory looks and
 *    wrote Standard otherwise), and has the parameters of Cinema Yellow (each parameter's writer
 *    looks the style up in a list of the looks that have it; the added looks join every list
 *    Cinema Yellow is in);
 *  - reading it back: the record of a RAW file for development (0x537D5748) and playback's
 *    information (0x537D899C, then 0x533A3804 to a style) know the new codes, so the playback
 *    information shows the slot's icon (through the overlay hook) and Cinema Yellow's
 *    parameters (0x533A75AC picks them by style), and RAW development starts from the look the
 *    picture was shot with. A code of a slot that is no longer installed reads as Standard, as
 *    before.
 */
function installPictureInfo(p: Patch, count: number): void {
  const n = count - 1;
  // Writer: r1 the maker note, r2 the frame record; tail-calls 0x537E7148(note, 0, code).
  hook(p, 0x537de474, 0xe30f3198, `ldrb ip,[r2,#0x79c];sub ip,ip,#${EXTRA_FIRST_STYLE};cmp ip,#${n};bhi native;mov r0,r1;mov r1,#0;movw r2,#${EXTRA_TONE_CODE};add r2,r2,ip;b #0x537e7148;native:movw r3,#0xf198;b #0x537de478`, 'added slots: maker note look');
  // Parameter lists: the ones with Cinema Yellow get the added styles appended (new copies).
  const calls: number[] = [];
  for (let at = PARAM_LISTS[0]; at < PARAM_LISTS[1]; at += 4) if (p.word(at) === branchWord(at, LIST_ASSIGN, 14, true) || p.word(at) === branchWord(at, LIST_ASSIGN)) calls.push(at);
  if (calls.length !== PARAM_LISTS_CALLS) fail('unexpected-layout', `maker note parameter lists: ${calls.length} lists, expected ${PARAM_LISTS_CALLS}`);
  let extended = 0;
  for (const call of calls) {
    let lo = 0, hi = 0, add = 0;
    for (let k = 1; k < 14; k++) {
      const at = call - 4 * k;
      const w = p.word(at);
      if (!lo && ((w & 0xfff0f000) >>> 0) === 0xe3001000) lo = at; // movw r1,#
      if (!hi && ((w & 0xfff0f000) >>> 0) === 0xe3401000) hi = at; // movt r1,#
      if (!add && ((w & 0xfffff000) >>> 0) === 0xe2812000) add = at; // add r2,r1,#
    }
    if (!lo || !hi || !add) fail('unexpected-layout', `maker note parameter list at 0x${call.toString(16)}`);
    const list = (movImmediate(p.word(lo)) | (movImmediate(p.word(hi)) << 16)) >>> 0;
    const length = p.word(add) & 0xff;
    if ((p.word(add) & 0xf00) !== 0) fail('unexpected-layout', `maker note parameter list at 0x${call.toString(16)}: length`);
    const styles = p.readMapped(list, length);
    if (styles.some((s) => s >= EXTRA_FIRST_STYLE)) fail('unexpected-layout', 'maker note parameter list already has added styles');
    if (!styles.includes(CY)) continue;
    const grown = concat([styles, Uint8Array.from({ length: count }, (_, i) => EXTRA_FIRST_STYLE + i)]);
    const at = p.append(grown, 4);
    p.setWord(lo, movWord(1, at & 65535), 'added slots: maker note parameters of Cinema Yellow');
    p.setWord(hi, movWord(1, at >>> 16, true), 'added slots: maker note parameters of Cinema Yellow');
    p.setWord(add, assembleWords(`add r2,r1,#${grown.length}`, add)[0], 'added slots: maker note parameters of Cinema Yellow');
    extended++;
  }
  if (extended !== PARAM_LISTS_WITH_CY) fail('unexpected-layout', `maker note parameter lists: ${extended} with Cinema Yellow, expected ${PARAM_LISTS_WITH_CY}`);
  // Readers: RAW development's record, then playback's numbering and its style.
  hook(p, 0x537d575c, 0xe300310a, `sub r3,r0,#${EXTRA_TONE_CODE & 0xff00};sub r3,r3,#${EXTRA_TONE_CODE & 0xff};cmp r3,#${n};bhi native;add r3,r3,#${EXTRA_FIRST_STYLE};b #0x537d57ac;native:movw r3,#0x10a;b #0x537d5760`, 'added slots: look of a RAW file');
  hook(p, 0x537d89b0, 0xe3003109, `sub r3,r0,#${EXTRA_TONE_CODE & 0xff00};sub r3,r3,#${EXTRA_TONE_CODE & 0xff};cmp r3,#${n};bhi native;add r2,r3,#${PLAY_FIRST_EXTRA};b #0x537d8a00;native:movw r3,#0x109;b #0x537d89b4`, 'added slots: playback look');
  // 0x533A3804: r0 = number - 1, r4 = where the style goes (may be null).
  hook(p, 0x533a3824, 0xe3500013, `sub r3,r0,#${PLAY_FIRST_EXTRA - 1};cmp r3,#${n};bhi native;cmp r4,#0;beq #0x533a3854;add r3,r3,#${EXTRA_FIRST_STYLE};strb r3,[r4];b #0x533a3844;native:cmp r0,#0x13;b #0x533a3828`, 'added slots: playback look');
  // Playback information's parameters: r3 = style - 8, the added looks as Cinema Yellow (10).
  hook(p, 0x533a7628, 0xe3530016, `cmp r3,#${EXTRA_FIRST_STYLE - 8};blo native;cmp r3,#${EXTRA_FIRST_STYLE - 8 + count};movlo r3,#${CY - 8};native:cmp r3,#0x16;b #0x533a762c`, 'added slots: playback parameters of Cinema Yellow');
}

// -------------------------------------------------------------- halation

/** The RAW development model's look of the current base, through the model getter chain. */
const RAW_LOOK_CALLS = 'bl #0x5323ea84;bl #0x5323f078;bl #0x5336bde8';
/** Cinema Yellow and Green: style numbers and RAW development's. */
export const CINEMA_STYLES = { CY: 18, CG: 19 } as const;
const CINEMA_RAW: Readonly<Record<number, number>> = { 18: 9, 19: 10 };

/** RAW development's number of a look with halation (an added slot or a Cinema slot). */
function rawLook(style: number): number {
  if (style >= EXTRA_FIRST_STYLE) return RAW_FIRST_EXTRA + style - EXTRA_FIRST_STYLE;
  const raw = CINEMA_RAW[style];
  if (raw === undefined) fail('internal', 'halation: a look without a RAW development number');
  return raw;
}

/** `dst` = table[`reg`] (0 for `reg` >= 64), through `tmp`; `reg` keeps its value unless it is `dst`. */
function lookupAsm(dst: string, reg: string, tmp: string, table: number): string {
  return `cmp ${reg},#64;movw ${tmp},#${table & 65535};movt ${tmp},#${table >>> 16};ldrblo ${dst},[${tmp},${reg}];movhs ${dst},#0`;
}

/**
 * Halation for `looks` (added slots and Cinema slots with a preset): the parameter's name, list
 * icon and screens, and the module at the JPEG step. Returns the new ICONBIN data. The development
 * step must leave the look for the JPEG step (`lookstash.ts`; the added slots' hook does it when
 * asked, without added slots it is installed here).
 *
 * For such a look, Cinema's Toning on the parameter screens (shooting: ImageControlDetail-
 * Controller, the style at +0x19C; RAW development: RawDevelopmentImageControlDetailSetController,
 * the look asked from the model) shows as Halation: its name (the subtitle, from a table of texts
 * per parameter kind: Toning is text 339) and its icon in the list (0x16F). From 0.8.2 it is an
 * Off / On row like Grain Effect's, and Fn opens Grain Effect's submenu as Halation's (Strength,
 * Colour); the setting is kept in the Toning byte (`halation-ui.ts`). Which looks: two tables of 64
 * bytes (by style, by RAW development's number).
 */
export function installHalation(p: Patch, iconbin: Uint8Array, looks: readonly HalationLook[]): Uint8Array {
  if (looks.length === 0) return iconbin;
  const byStyle = new Uint8Array(HALATION_LOOKS);
  const byRaw = new Uint8Array(HALATION_LOOKS);
  for (const l of looks) {
    if (!(l.style >= 0 && l.style < HALATION_LOOKS)) fail('internal', 'halation: style');
    byStyle[l.style] = 1;
    byRaw[rawLook(l.style)] = 1;
  }
  const styles = p.append(byStyle, 4);
  const raws = p.append(byRaw, 4);

  // Name, list icon and slider scale of the parameter.
  const parts: Uint8Array[] = [iconbin];
  let iconLength = iconbin.length;
  for (let l = 0; l < 21; l++) {
    const row = p.word(TEXT_CATALOG + l * 4);
    for (const [id, name] of [[HALATION_TEXT_ID, HALATION_NAMES[l]], [HALATION_COLOUR_TEXT_ID, HALATION_COLOUR_NAMES[l]]] as const) {
      expectWord(p, row + id * 4, 0);
      const text = p.append(utf16z(name), 4);
      p.write(row + id * 4, u32le([p.append(concat([Uint8Array.from([name.length + 1, 1, 0, 0]), u32le([text])]), 4)]));
    }
  }
  for (const site of p.textBoundSites) p.setWord(site, movWord(3, Math.max(HALATION_COLOUR_TEXT_ID, movImmediate(p.word(site)))), 'text upper bound');
  const nativeScale = wordOf(p.readMapped(ICON_CATALOG + NATIVE_SCALE_ICON * 4, 4));
  const scaleAt = wordOf(p.readMapped(nativeScale + 8, 4)) * 4;
  const native = iconbin.slice(scaleAt, scaleAt + 400 * 60 * 4);
  for (const [id, w, h, pixels] of [[HALATION_ICON_ID, 40, 40, halationIcon()], [HALATION_COLOUR_SCALE_ICON_ID, 400, 60, halationColourScale(native)],
    [HALATION_RED_ICON_ID, 40, 40, halationColourIcon('red')], [HALATION_WHITE_ICON_ID, 40, 40, halationColourIcon('white')]] as const) {
    const pad = (4 - (iconLength % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); iconLength += pad; }
    expectWord(p, ICON_CATALOG + id * 4, 0);
    p.setWord(ICON_CATALOG + id * 4, p.append(concat([u16le([1, w, h, 0]), u32le([iconLength / 4])]), 16), 'halation icon');
    parts.push(pixels);
    iconLength += pixels.length;
  }
  for (const [site, r] of LOOKUP_BOUNDS) p.setWord(site, movWord(r, Math.max(HALATION_WHITE_ICON_ID, movImmediate(p.word(site)))), 'icon upper bound');

  // Shooting: subtitle (r6 the table entry, r5 the controller).
  hook(p, 0x531ca7cc, 0xe1d610b2, `ldrh r1,[r6,#2];movw ip,#${TONING_TEXT};cmp r1,ip;bne done;ldrb ip,[r5,#0x19c];push {r0};${lookupAsm('ip', 'ip', 'r0', styles)};pop {r0};cmp ip,#0;movwne r1,#${HALATION_TEXT_ID};done:b #0x531ca7d0`, 'halation: name of the parameter');
  // Shooting: list icon (controller r7, r6).
  for (const [at, ctl] of [[0x531c973c, 'r7'], [0x531c982c, 'r6']] as const) {
    hook(p, at, 0xe300116f, `ldrb r1,[${ctl},#0x19c];push {r0};${lookupAsm('r1', 'r1', 'r0', styles)};pop {r0};cmp r1,#0;movw r1,#${TONING_ICON};movwne r1,#${HALATION_ICON_ID};b #${at + 4}`, 'halation: list icon');
  }
  // RAW development: subtitle (r7 the table entry).
  hook(p, 0x531a833c, 0xe1d710b2, `ldrh r1,[r7,#2];movw ip,#${TONING_TEXT};cmp r1,ip;bne done;push {r0,r2,r3,lr};${RAW_LOOK_CALLS};${lookupAsm('r0', 'r0', 'r2', raws)};cmp r0,#0;movw r1,#${TONING_TEXT};movwne r1,#${HALATION_TEXT_ID};pop {r0,r2,r3,lr};done:b #0x531a8340`, 'halation: name of the parameter (RAW development)');
  // RAW development: list icon.
  for (const at of [0x531a88d0, 0x531a89e8]) {
    hook(p, at, 0xe300116f, `push {r0,r2,r3,lr};${RAW_LOOK_CALLS};${lookupAsm('r0', 'r0', 'r2', raws)};cmp r0,#0;movw r1,#${TONING_ICON};movwne r1,#${HALATION_ICON_ID};pop {r0,r2,r3,lr};b #${at + 4}`, 'halation: list icon (RAW development)');
  }

  // Off / On, Fn to the submenu (Strength, Colour); native Toning readers kept to 0..2.
  installHalationUi(p, {
    styles, raws, nameText: HALATION_TEXT_ID, icon: HALATION_ICON_ID, colourText: HALATION_COLOUR_TEXT_ID,
    colourScale: HALATION_COLOUR_SCALE_ICON_ID, redIcon: HALATION_RED_ICON_ID, whiteIcon: HALATION_WHITE_ICON_ID,
  });
  installHalationClamps(p);

  // The look of the picture for the JPEG step: without added slots their hook is not there.
  if (p.word(0x539113f8) === 0xe5d3279c) installLookStash(p);
  else if (!isLookStashed(p)) fail('internal', 'halation: the development step does not leave the look');
  installHalationModule(p, looks, HALATION_STASH);
  return concat(parts);
}

/** The development step's hook (added slots or `installLookStash`) leaves the look. */
function isLookStashed(p: Patch): boolean {
  const w = p.word(0x539113f8);
  if (w >>> 24 !== 0xea) return false;
  const [first] = assembleWords(STASH_ASM, 0);
  return p.word(branchTarget(0x539113f8, w)) === first;
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
    const maTable = table(0x53925fc8, 0x53925fd0);
    const maBlockOf = (style: number): [number, number] => {
      const arr = wordOf(p.readMapped(wordOf(p.readMapped(maTable + 4 * style, 4)) + 8, 4));
      return [arr, wordOf(p.readMapped(arr, 4))];
    };
    const stdMa = maBlockOf(STANDARD)[1];
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
      const textDesc = p.word(p.word(TEXT_CATALOG) + extraTextId(k) * 4);
      const units = p.read(textDesc, 1)[0];
      const tb = p.read(p.word(textDesc + 4), (units - 1) * 2);
      let name = '';
      for (let i = 0; i < units - 1; i++) name += String.fromCharCode(tb[2 * i] | (tb[2 * i + 1] << 8));
      const iconDesc = p.word(ICON_CATALOG + extraIconId(k) * 4);
      const iconOffset = p.word(iconDesc + 8) * 4;
      if (iconOffset + EXTRA_ICON_BYTES > iconbin.length) return null;
      const icon = iconbin.slice(iconOffset, iconOffset + EXTRA_ICON_BYTES);
      // hue sectors: a block of its own (every pointer to it, copies as hueBlockBytes writes them)
      const [maArr, block] = maBlockOf(TONES + k);
      let hueQ10: number[] | undefined;
      if (block !== stdMa) {
        for (let i = 1; i < MA_POINTERS; i++) if (wordOf(p.readMapped(maArr + 4 * i, 4)) !== block) return null;
        const q = hueFromBlock(p.readMapped(block, 2160));
        if (!q) return null;
        hueQ10 = q;
      }
      out.push({ name, matrixQ13, curves, ...(postQ9 ? { postQ9 } : {}), ...(hueQ10 ? { hueQ10 } : {}), icon });
    }
    const halation = readHalation(p, EXTRA_FIRST_STYLE, count);
    if (halation) out.forEach((x, k) => { if (halation.has(EXTRA_FIRST_STYLE + k)) x.halation = true; });
    return out;
  } catch {
    return null;
  }
}

function movRow(rows: number): number {
  return assembleWords(`mov r2,#${rows}`, 0x53925f98)[0];
}
