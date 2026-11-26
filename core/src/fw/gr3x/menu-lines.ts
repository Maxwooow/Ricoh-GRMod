// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: lines added to the still shooting menu (GR IV: ../gr4v120/aspect/menuwide.ts and
 * the still lines of datestamp-menu.ts, exposure.ts, viewmenu.ts, lamp.ts, hdrgain.ts), and the API by which
 * an addition asks for one.
 *
 * An addition asks for a line with `gr3xOnOffLine` or `gr3xListLine` (registered in `gr3xExtraMenuLines`):
 * a line of the still menu after a named official line, which opens a list of values; the value is a bit
 * field of a settings byte (survey below). adj.ts appends the texts and icons, datestamp.ts's
 * `installGr3xMenuAdditions` makes the list records, maps the ids to Horizon Correction's list controller
 * (as the date imprint's list) and calls `installGr3xStillMenu` for the still menu.
 *
 * The still menu. TopMenuController's builder (0x5319a778) builds the five tabs once, when the menu is
 * first opened, from the five descriptors listed at 0x55001eb8 (0x384 bytes: header up to +0x8c with the
 * page count +0x68, the pages' first items +0x80 and the item count +0x8b; then per item a draw member
 * pointer at +0x8c, a controller id at +0x1bc and a visibility member pointer at +0x254; room for 38).
 * The still descriptor (0x53b36dec) has 38 items, two of them model-specific and never both shown (ND
 * Filter, item 13; HDF, item 25): every model sees 37. The date imprint (datestamp.ts) appends one
 * descriptor per model without the item that model does not show, with its line at the end: 38.
 *
 * Up to 38 lines a model, the official layout does: one descriptor per model with the added lines after
 * their official lines (and the date imprint's at the end), the builder's first instruction storing the
 * model's descriptor (the date imprint's way). More than 38: the wide layout (GR IV's menuwide.ts), for
 * all five tabs, read in the official 2.10 code side by side with GR IV 1.20's (same instructions, the
 * controller's arrays 8 bytes lower: GR III's descriptors are 0x384, not 0x38c bytes):
 *  - the controller (0x13bc bytes, `movw r0,#0x13bc` at 0x5316fcec; GR IV 0x13ec at 0x53188530) keeps a
 *    copy of each tab's descriptor at this + 0x228 + tab * 0x384 with only the items shown. Everything
 *    in the official code that touches that copy's item arrays (immediates 0x228..0x13bc of the
 *    TopMenuController code 0x53196000..0x5319c000 and every `mov #0x384`, read one by one): the
 *    builder's stores (0x5319a97c..0x5319a9d4), OK on a line (0x53198b38: id at
 *    this + 0x3e4 + (tab * 0xe1 + line) * 4) and the line drawing (0x53199ba4: draw member pointer of
 *    line i at this + tab * 0x384 + 0x2b4 + 8 i, read as [r4,#0x2b8] / [r4+8,#0x2ac]). The visibility
 *    array is never read back. The other readers of the copy read its header (titles 0x228 / 0x22c /
 *    0x230, page count 0x290, page titles 0x292, page firsts 0x2a8, item count 0x2b3), which does not
 *    depend on 38;
 *  - descriptors: the same header, then room for GR3X_WIDE_ITEMS items (draw +0x8c, id +W_ID,
 *    visibility +W_VISIBLE). The still menu's (one per model) and the other four tabs' (copies of the
 *    official ones, or of the Setup copy the End Screen submenu made) are appended; the builder hook
 *    stores all five in the table (the builder is its only reader);
 *  - the builder reads the descriptor's ids and visibility at the new offsets (0x5319a950 `add sl,r4,
 *    #0x6f`, 0x5319a970 `add r3,r3,#0x254`) and stores what it keeps in arrays after the controller's
 *    own 0x13bc bytes (ids C_ID, draw C_DRAW, visibility C_VISIBLE; GR3X_WIDE_ITEMS per tab); the
 *    controller is allocated that much larger; OK (0x53198b54 `mov r3,#0xe1`, 0x53198b60 `ldr r4,
 *    [r4,#0x3e4]`) and the drawing (0x53199bc8, after the count is read from the header) read those
 *    arrays; the list view is created with GR3X_WIDE_ITEMS rows (0x53198d6c `bl 0x53394610`, row kind
 *    0x13 as the official 38 at 0x538efb60).
 * The official arrays in the controller are left as they are (never written, never read).
 *
 * Settings bytes. The user-settings record (*0x55063f34, 0xb28 bytes, 0xb26 of them saved, loaded and
 * copied) is 1043 entries {value; u8 flag} in the order and with the sizes of the field-name list the
 * settings store also keeps (0x53b4ec18, sizes 0x53b593ac); the default merge (0x53246df8) copies a
 * value from the defaults where its flag says so. Run in the emulator (tools/gr3extras/settings_survey.py)
 * it gives every value and flag byte of the record, identical in 2.10, 2.20 and 2.21; the 243 bytes it
 * neither copies nor reads are the padding after the flags. Padding at 0x800 and above has no byte or
 * halfword access at its offset anywhere in the UI and settings code (0x53160000..0x532c0000). Padding is
 * 0 in the defaults (the default builder clears its buffer), saved and loaded with the record, copied by
 * the mode recall (U1-U3) and by Save to U (when that mode is the current one); NOT reset by Reset
 * Settings (field by field); set to 0 in a U slot by Save Settings to U (0x5327a104 starts the slot from
 * the defaults and copies fields), and in the current record too when the current mode is that U.
 * GR Mod uses 0x9a1 (soft focus), 0x9a2 (date imprint), 0x9a3 and 0x9a9..0x9ab (End Screen picture,
 * rounds 5..9; round 10 reads them only when its own record is missing, see native/endscreen.c).
 */
import { assembleWords, branchWord, movWord } from '../aspect/arm';
import { SOFT_FOCUS_NAMES } from '../aspect/softfocus';
import { drawSoftLevelIcon } from '../gr4v120/aspect/exposure';
import { FirmwareError } from '../types';
import type { Gr3xExtras } from './extras';
import { adr } from './target';

const fail = (message: string): never => { throw new FirmwareError('unexpected-layout', `IIIx menu lines: ${message}`); };
const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const bl = (at: number, target: number) => branchWord(at, target, 14, true);

/** GR III's 21 text rows (ja en fr de es pt it nl da sv fi pl cs hu tr el ru ko zh-TW zh-CN th) as indices of GR IV's
 * language order (the order of GR IV's name tables, e.g. SOFT_FOCUS_NAMES); adj.ts's GR3X_SOFT_FOCUS_ROWS. */
export const GR3X_TEXT_ROWS = [9, 2, 4, 5, 16, 13, 8, 11, 1, 17, 3, 12, 0, 7, 20, 6, 14, 10, 19, 15, 18] as const;
/** A text in GR IV's 21 languages, in GR IV's order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export type Gr3xNames = readonly string[];

// ---------------------------------------------------------------------------------------------------
// Settings bytes (see the header and tools/gr3extras/settings_survey.py).

export const GR3X_SETTINGS_RECORD_POINTER = adr(0x55063f34);
/** Padding of the settings record no official code reads or writes, not used by GR Mod: free for additions.
 * 0x905..7 after CustomQuickViewTimeMsec's flag, 0x932..3 after CustomSwitchMModeOnePushAE's, 0x9b1..3
 * after SetupSleep's, 0x9c2..3 after SetupExternalDisplayResolution's, and six single bytes after the flags
 * of fields near the end. Bits are handed out in `GR3X_SETTING_BITS`; take them from there. */
export const GR3X_FREE_SETTING_BYTES = [0x905, 0x906, 0x907, 0x932, 0x933, 0x9b1, 0x9b2, 0x9b3, 0x9c2, 0x9c3, 0xabb, 0xac5, 0xacf, 0xad9, 0xae3, 0xaed] as const;
/** Padding GR Mod already uses: soft focus (0x9a1), date imprint (0x9a2); 0x9a3, 0x9a9..0x9ab the End
 * Screen picture of rounds 5..9 (stale values may still be there on cameras that ran those: not free). */
export const GR3X_GRMOD_SETTING_BYTES = { softFocus: 0x9a1, dateImprint: 0x9a2 } as const;
/**
 * Settings bits taken by additions: { byte, shift, bits }. One entry per addition, so that two additions
 * never share a bit; an addition adds its own here (and nowhere else), in GR3X_FREE_SETTING_BYTES. Free so
 * far: everything in GR3X_FREE_SETTING_BYTES (16 bytes, 128 bits).
 */
export const GR3X_SETTING_BITS: Readonly<Record<string, { byte: number; shift: number; bits: number }>> = {
  softFocus: { byte: 0x9a1, shift: 0, bits: 8 },
};

// ---------------------------------------------------------------------------------------------------
// The API.

/** A value of a line's list: what is stored in the bit field, its text and its 40 x 40 icon (shown on the
 * menu line and in the list). A text or an icon is a number of the camera's catalog or one to append. */
export interface Gr3xLineValue { value: number; text: number | Gr3xNames; icon: number | Uint8Array }
/**
 * A line of the still menu that opens a list.
 *  - `id`: its controller id (unused by the camera, 0x020001b0..0x020001ff; GR IV's id of the same line
 *    where there is one);
 *  - `after`: the controller id of the official still-menu line it follows (`GR3X_STILL_LINES`), or null
 *    for the end of the menu (before the date imprint's line);
 *  - `title`: the line's name (also the list's title);
 *  - the setting: bits shift .. shift + bits - 1 of byte `byte` of the settings record;
 *  - `values`: in list order; the first is the one a field holding none of them counts as (and is set to
 *    when the list is opened). The addition's own readers must do the same.
 */
export interface Gr3xMenuLine {
  id: number; after: number | null; title: number | Gr3xNames;
  byte: number; shift: number; bits: number;
  values: readonly Gr3xLineValue[];
}
/** The camera's texts and icons the lines use: Off / On (texts 2 / 1) and the boxed OFF / ON icons (296 / 297). */
export const GR3X_TEXT_OFF = 2, GR3X_TEXT_ON = 1, GR3X_ICON_OFF = 296, GR3X_ICON_ON = 297;
/** Controller ids of official still-menu lines an added line can follow. */
export const GR3X_STILL_LINES = { imageControl: 0x02000012, peripheralIllumination: 0x02000120, horizon: 0x0200007d } as const;

/** An On / Off line of one settings bit (Off = 0, On = 1; `invert`: On = 0). */
export function gr3xOnOffLine(o: { id: number; after: number | null; title: number | Gr3xNames; byte: number; bit: number; invert?: boolean }): Gr3xMenuLine {
  const off = o.invert ? 1 : 0;
  return { id: o.id, after: o.after, title: o.title, byte: o.byte, shift: o.bit, bits: 1,
    values: [{ value: off, text: GR3X_TEXT_OFF, icon: GR3X_ICON_OFF }, { value: 1 - off, text: GR3X_TEXT_ON, icon: GR3X_ICON_ON }] };
}
/** A line with a list of values (see Gr3xMenuLine). */
export function gr3xListLine(o: Gr3xMenuLine): Gr3xMenuLine { return o; }

/** Soft focus (GR IV's softFocusMenu, exposure.ts): after Image Control, Off / Low / Medium / High of the
 * ADJ soft focus byte (adj-softfocus.ts), the ADJ function's name and the camera's texts 2, 9, 10, 11. */
export const GR3X_SOFT_FOCUS_LIST_ID = 0x020001d1;
export function gr3xSoftFocusLine(softFocusText: number): Gr3xMenuLine {
  const b = GR3X_SETTING_BITS.softFocus;
  return gr3xListLine({ id: GR3X_SOFT_FOCUS_LIST_ID, after: GR3X_STILL_LINES.imageControl, title: softFocusText, ...b,
    values: [{ value: 0, text: GR3X_TEXT_OFF, icon: GR3X_ICON_OFF }, ...[1, 2, 3].map(k => ({ value: k, text: 8 + k, icon: drawSoftLevelIcon(k) }))] });
}

/** The lines the extras ask for, in the order they are built (the one place an addition registers its line). */
export function gr3xExtraMenuLines(extras: Gr3xExtras | undefined, ctx: { softFocusText?: number }): Gr3xMenuLine[] {
  const lines: Gr3xMenuLine[] = [];
  if (extras?.softFocusMenu) {
    if (ctx.softFocusText === undefined) fail('the soft focus line needs soft focus on the ADJ lever');
    lines.push(gr3xSoftFocusLine(ctx.softFocusText!));
  }
  return lines;
}

/** The texts and icons the lines add (in this order, after the build's others). */
export function gr3xMenuLineAssets(lines: readonly Gr3xMenuLine[]): { texts: Gr3xNames[]; icons: Uint8Array[] } {
  const texts: Gr3xNames[] = [], icons: Uint8Array[] = [];
  for (const l of lines) {
    if (typeof l.title !== 'number') texts.push(l.title);
    for (const v of l.values) {
      if (typeof v.text !== 'number') texts.push(v.text);
      if (typeof v.icon !== 'number') icons.push(v.icon);
    }
  }
  for (const t of texts) if (t.length !== 21 || t.some(s => typeof s !== 'string' || !s.length)) fail('a text needs all 21 languages');
  for (const i of icons) if (i.length !== 40 * 40 * 4) fail('an icon is 40 x 40');
  return { texts, icons };
}

/** A line with every text and icon a number. */
export interface Gr3xResolvedLine extends Gr3xMenuLine { title: number; values: readonly { value: number; text: number; icon: number }[] }
/** The lines with the appended texts and icons numbered from `firstText` / `firstIcon` (gr3xMenuLineAssets' order). */
export function resolveGr3xMenuLines(lines: readonly Gr3xMenuLine[], firstText: number, firstIcon: number): Gr3xResolvedLine[] {
  let t = firstText, i = firstIcon;
  const out = lines.map(l => ({ ...l, title: typeof l.title === 'number' ? l.title : t++,
    values: l.values.map(v => ({ value: v.value, text: typeof v.text === 'number' ? v.text : t++, icon: typeof v.icon === 'number' ? v.icon : i++ })) }));
  checkGr3xMenuLines(out);
  return out;
}

function checkGr3xMenuLines(lines: readonly Gr3xResolvedLine[]) {
  const taken = new Map<number, number>();
  const ids = new Set<number>();
  for (const l of lines) {
    if (!(l.id >= 0x020001b0 && l.id <= 0x020001ff) || ids.has(l.id)) fail(`line id ${l.id.toString(16)}`);
    ids.add(l.id);
    if (!([...GR3X_FREE_SETTING_BYTES, GR3X_GRMOD_SETTING_BYTES.softFocus] as number[]).includes(l.byte)) fail(`settings byte ${l.byte.toString(16)} is not a free one`);
    if (!(Number.isInteger(l.shift) && Number.isInteger(l.bits) && l.bits >= 1 && l.shift >= 0 && l.shift + l.bits <= 8)) fail('bit field');
    const mask = ((1 << l.bits) - 1) << l.shift;
    if ((taken.get(l.byte) ?? 0) & mask) fail(`two lines share bits of byte ${l.byte.toString(16)}`);
    taken.set(l.byte, (taken.get(l.byte) ?? 0) | mask);
    if (l.values.length < 2 || l.values.length > 16) fail('2..16 values');
    if (new Set(l.values.map(v => v.value)).size !== l.values.length || l.values.some(v => !(Number.isInteger(v.value) && v.value >= 0 && v.value < 1 << l.bits))) fail('values');
    for (const x of [l.title, ...l.values.flatMap(v => [v.text, v.icon])]) if (!(Number.isInteger(x) && x > 0 && x <= 0xffff)) fail('text or icon number');
  }
}

// ---------------------------------------------------------------------------------------------------
// The handlers of a line (the camera's functions are the date imprint's, datestamp.ts).

const LINE_VALUE_ICON = adr(0x5339de20), TOP_SET_TITLE = adr(0x5339dc70), LIST_SET_ITEM = adr(0x5339e8b0);

export interface Gr3xLineProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
  read(address: number, size: number): Uint8Array;
}

/**
 * The still-menu line's draw function (this = r0, line = r1: the value's icon and the title) and the list's
 * count, draw (item r1, value index r2), set (value index r1) and is-current (value index r1). Each reads
 * the record pointer and does nothing (or shows the first value) while it is 0; set writes only the line's
 * bits; is-current puts a field holding none of the values back to the first value (exactly one is current).
 */
export function installGr3xLineHandlers(p: Gr3xLineProgram, l: Gr3xResolvedLine) {
  for (const at of [LINE_VALUE_ICON, TOP_SET_TITLE, LIST_SET_ITEM]) if (p.word(at) !== 0xe1a0c00d) fail(`guard at ${at.toString(16)}`);
  const P = GR3X_SETTINGS_RECORD_POINTER, n = l.values.length, mask = (1 << l.bits) - 1;
  const field = `ldrb ip,[r2,#${l.byte}];${l.shift ? `mov ip,ip,lsr #${l.shift};` : ''}and ip,ip,#${mask};`;
  /** r3 = index of the field's value (r2 = record or 0), -1 when none; ip changes. */
  const index = (lbl: string) => `movw r2,#${lo(P)};movt r2,#${hi(P)};ldr r2,[r2];mvn r3,#0;cmp r2,#0;beq ${lbl};${field}` +
    l.values.map((v, k) => `cmp ip,#${v.value};moveq r3,#${k};`).join('') + `${lbl}:`;
  const store = (value: string) => `ldrb ip,[r2,#${l.byte}];bic ip,ip,#${mask << l.shift};orr ip,ip,${value};strb ip,[r2,#${l.byte}];`;
  const draw = p.code(`push {r4,lr};mov r4,r1;${index('i')}cmp r3,#0;movlt r3,#0;` +
    l.values.map((v, k) => `cmp r3,#${k};movweq r1,#${v.icon};`).join('') +
    `mov r0,r4;bl #${LINE_VALUE_ICON};mov r0,r4;movw r1,#${l.title};mov r2,r1;pop {r4,lr};b #${TOP_SET_TITLE};`);
  const count = p.code(`mov r0,#${n};bx lr;`);
  const listDraw = p.code(`cmp r2,#${n - 1};bxhi lr;mov r0,r1;mov ip,r2;` +
    l.values.map((v, k) => `cmp ip,#${k};movweq r1,#${v.icon};movweq r2,#${v.text};`).join('') + `b #${LIST_SET_ITEM};`);
  const set = p.code(`cmp r1,#${n - 1};bxhi lr;movw r2,#${lo(P)};movt r2,#${hi(P)};ldr r2,[r2];cmp r2,#0;bxeq lr;mov r3,#0;` +
    l.values.map((v, k) => `cmp r1,#${k};moveq r3,#${v.value << l.shift};`).join('') + `${store('r3')}bx lr;`);
  const isCurrent = p.code(`${index('c')}cmp r2,#0;moveq r3,#0;beq c2;cmn r3,#1;bne c2;mov r3,#0;${store(`#${l.values[0].value << l.shift}`)}
    c2:cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
  return { draw, count, listDraw, set, isCurrent };
}

// ---------------------------------------------------------------------------------------------------
// The still menu.

const BUILDER = adr(0x5319a778), MENU_TABLE = adr(0x55001eb8), STILL_MENU = adr(0x53b36dec);
/** The other four tabs as the table lists them (movie, playback, customize, setup). */
const OTHER_TABS = [adr(0x53b37514), adr(0x53b37188), adr(0x53b3649c), adr(0x53b36a54)] as const;
const SETUP_TAB = 3;
const DESCRIPTOR = 0x384, MAX_ITEMS = 38, TABS = 5;
const D_PAGES = 0x68, D_FIRST = 0x80, D_COUNT = 0x8b, D_DRAW = 0x8c, D_ID = 0x1bc, D_VISIBLE = 0x254;
const ND_ITEM = 13, HDF_ITEM = 25;
const ND_ID = 0x02000069, ND_VISIBLE = adr(0x531966e4), HDF_VISIBLE = adr(0x53196708);
const APP = adr(0x5320ad88), SPEC_MODEL = adr(0x5320c09c), MODEL_NUMBER = adr(0x532dbee8);
/** The longest page the camera's list code shows (GR IV's longest official page; GR III's is 8). */
const MAX_PAGE = 10;

export const GR3X_WIDE_ITEMS = 46;
const W = GR3X_WIDE_ITEMS;
export const GR3X_W_DRAW = 0x8c, GR3X_W_ID = GR3X_W_DRAW + W * 8, GR3X_W_VISIBLE = GR3X_W_ID + W * 4, GR3X_WIDE_DESCRIPTOR = GR3X_W_VISIBLE + W * 8;
const OBJECT = 0x13bc;
export const GR3X_C_ID = OBJECT, GR3X_C_DRAW = GR3X_C_ID + TABS * W * 4, GR3X_C_VISIBLE = GR3X_C_DRAW + TABS * W * 8, GR3X_WIDE_OBJECT = GR3X_C_VISIBLE + TABS * W * 8;

const ALLOC = adr(0x5316fcec), OPERATOR_NEW = adr(0x536af2a8), CONSTRUCTOR = adr(0x5319aa68);
const B_ID_INDEX = adr(0x5319a950), B_VISIBLE = adr(0x5319a970), B_STORE = adr(0x5319a97c), B_STORE_END = adr(0x5319a9d8);
const OK_SITES = [adr(0x53198b54), adr(0x53198b58), adr(0x53198b5c), adr(0x53198b60)] as const;
const DRAW = adr(0x53199ba4), DRAW_COUNT = adr(0x53199bc8);
const ROWS_COUNT = adr(0x53198d50), ROWS_CALL = adr(0x53198d6c), LIST_ROWS = adr(0x53394610), ROW_KINDS = adr(0x538efb60), ROW_KIND = 0x13;

/** A line of the still menu: its draw function, the controller id OK opens, the official line it follows. */
export interface Gr3xStillLine { draw: number; id: number; after: number | null }

/** Widen an official-layout descriptor. */
export function gr3xWiden(official: Uint8Array): Uint8Array {
  if (official.length !== DESCRIPTOR || official[D_COUNT] > MAX_ITEMS) fail('descriptor');
  const d = new Uint8Array(GR3X_WIDE_DESCRIPTOR);
  d.set(official.subarray(0, D_DRAW));
  for (let i = 0; i < MAX_ITEMS; i++) {
    d.set(official.subarray(D_DRAW + i * 8, D_DRAW + i * 8 + 8), GR3X_W_DRAW + i * 8);
    d.set(official.subarray(D_ID + i * 4, D_ID + i * 4 + 4), GR3X_W_ID + i * 4);
    d.set(official.subarray(D_VISIBLE + i * 8, D_VISIBLE + i * 8 + 8), GR3X_W_VISIBLE + i * 8);
  }
  return d;
}

/**
 * The still menu with the added `lines` after their official lines and (when `date`) the date imprint's line
 * at the end, one descriptor per model (0 ND, 1 HDF), in the official layout up to 38 lines and in the wide
 * layout beyond. `setup` is the Setup tab's descriptor in use (the End Screen submenu's copy, or the official
 * one). Replaces datestamp.ts's two descriptors and builder hook when there are added lines.
 */
export function installGr3xStillMenu(p: Gr3xLineProgram, lines: readonly Gr3xStillLine[], date: { draw: number; id: number } | null,
  setup: { address: number; bytes: Uint8Array } | null, what: string): Record<string, number> {
  // --- The official code and data this relies on.
  const guards: readonly (readonly [number, number])[] = [
    [BUILDER, 0xe1a0c00d], [BUILDER + 4, movWord(3, lo(MENU_TABLE))], [BUILDER + 0x10, movWord(3, hi(MENU_TABLE), true)],
    [APP, 0xe1a0c00d], [SPEC_MODEL, 0xe1a0c00d],
  ];
  for (const [at, w] of guards) if (p.word(at) !== w >>> 0) fail(`guard at ${at.toString(16)}`);
  const table = new DataView(p.read(MENU_TABLE, TABS * 4).buffer);
  if (table.getUint32(0, true) !== STILL_MENU || OTHER_TABS.some((d, k) => table.getUint32((k + 1) * 4, true) !== d)) fail('the menu table');
  const still = p.read(STILL_MENU, DESCRIPTOR), dv = new DataView(still.buffer);
  const id = (i: number) => dv.getUint32(D_ID + i * 4, true), visible = (i: number) => dv.getUint32(D_VISIBLE + i * 8, true);
  if (still[D_COUNT] !== MAX_ITEMS || still[D_PAGES] !== 7 || id(ND_ITEM) !== ND_ID || visible(ND_ITEM) !== ND_VISIBLE || visible(HDF_ITEM) !== HDF_VISIBLE)
    fail('the still menu is not the official one');
  for (const v of [ND_VISIBLE, HDF_VISIBLE])
    if (p.word(v + 0xc) !== bl(v + 0xc, APP) || p.word(v + 0x10) !== bl(v + 0x10, SPEC_MODEL) || p.word(v + 0x14) !== bl(v + 0x14, MODEL_NUMBER)) fail('model visibility');
  for (const l of lines) {
    for (let i = 0; i < MAX_ITEMS; i++) if (id(i) === l.id) fail('a line id is the camera\'s');
    if (l.after !== null && Array.from({ length: MAX_ITEMS }, (_, i) => i).filter(i => id(i) === l.after).length !== 1) fail('the line an added line follows is not in the still menu');
    if (l.after === id(ND_ITEM) || l.after === id(HDF_ITEM)) fail('an added line cannot follow a model-specific line');
  }
  if (new Set([...lines.map(l => l.id), ...(date ? [date.id] : [])]).size !== lines.length + (date ? 1 : 0)) fail('two lines with one id');

  const firsts = [...still.subarray(D_FIRST, D_FIRST + still[D_PAGES])];
  type Item = { i: number } | { draw: number; id: number };
  const orderFor = (drop: number): Item[] => {
    const order: Item[] = [];
    for (let i = 0; i < MAX_ITEMS; i++) {
      if (i === drop) continue;
      order.push({ i });
      for (const l of lines) if (l.after === id(i)) order.push({ draw: l.draw, id: l.id });
    }
    for (const l of lines) if (l.after === null) order.push({ draw: l.draw, id: l.id });
    if (date) order.push(date);
    return order;
  };
  const drops = [HDF_ITEM, ND_ITEM] as const; // model 0 (ND) shows no HDF line, model 1 (HDF) no ND line
  const wide = drops.some(d => orderFor(d).length > MAX_ITEMS);
  const [n, drawAt, idAt, visibleAt, size] = wide ? [W, GR3X_W_DRAW, GR3X_W_ID, GR3X_W_VISIBLE, GR3X_WIDE_DESCRIPTOR] : [MAX_ITEMS, D_DRAW, D_ID, D_VISIBLE, DESCRIPTOR];
  const descriptor = (drop: number): Uint8Array => {
    const d = new Uint8Array(size), v = new DataView(d.buffer), order = orderFor(drop);
    if (order.length > n) fail(`more than ${n} lines`);
    d.set(still.subarray(0, D_DRAW));
    if (!wide) d.set(still);
    for (let j = 0; j < n; j++) {
      const o = order[j];
      if (o && 'i' in o) {
        d.set(still.subarray(D_DRAW + o.i * 8, D_DRAW + o.i * 8 + 8), drawAt + j * 8);
        d.set(still.subarray(D_ID + o.i * 4, D_ID + o.i * 4 + 4), idAt + j * 4);
        d.set(still.subarray(D_VISIBLE + o.i * 8, D_VISIBLE + o.i * 8 + 8), visibleAt + j * 8);
      } else {
        // An empty place: as the official descriptors' (no draw, no visibility, id 0x10000000).
        v.setUint32(drawAt + j * 8, o ? o.draw : 0, true); v.setUint32(drawAt + j * 8 + 4, 0, true);
        v.setUint32(idAt + j * 4, o ? o.id : 0x10000000, true);
        v.setUint32(visibleAt + j * 8, 0, true); v.setUint32(visibleAt + j * 8 + 4, 0, true);
      }
    }
    // Pages start at the same official lines (no page starts at a dropped line).
    const at = firsts.map(f => order.findIndex(o => 'i' in o && o.i === f));
    if (at.some(x => x < 0)) fail('a page starts at a dropped line');
    [...at, order.length].forEach((x, k, all) => { if (k && x - all[k - 1] > MAX_PAGE) fail(`a page of more than ${MAX_PAGE} lines`); });
    d.set(at, D_FIRST);
    d[D_COUNT] = order.length;
    return d;
  };
  const withoutHdf = p.append(descriptor(HDF_ITEM)), withoutNd = p.append(descriptor(ND_ITEM));
  const entries: Record<string, number> = { stillMenuModel0: withoutHdf, stillMenuModel1: withoutNd };
  const pick = `push {r0-r3,ip,lr};bl #${APP};bl #${SPEC_MODEL};bl #${MODEL_NUMBER};
    movw r1,#${lo(withoutHdf)};movt r1,#${hi(withoutHdf)};cmp r0,#1;movweq r1,#${lo(withoutNd)};movteq r1,#${hi(withoutNd)};
    movw r2,#${lo(MENU_TABLE)};movt r2,#${hi(MENU_TABLE)};str r1,[r2];`;
  if (!wide) {
    // As the date imprint's builder hook (datestamp.ts): only the still menu's entry.
    const builder = p.code(`${pick}pop {r0-r3,ip,lr};mov ip,sp;b #${BUILDER + 4};`);
    p.patch(BUILDER, 0xe1a0c00d, branchWord(BUILDER, builder), `${what}: still menu for this model`);
    return { ...entries, stillMenuBuilder: builder };
  }
  return { ...entries, ...installGr3xWideMenus(p, pick, setup, what) };
}

/** The wide layout for all five tabs (see the header); `pick` stores the model's still descriptor (r2 = the table). */
function installGr3xWideMenus(p: Gr3xLineProgram, pick: string, setup: { address: number; bytes: Uint8Array } | null, what: string): Record<string, number> {
  const expect = (at: number, w: number) => { if (p.word(at) !== w >>> 0) fail(`wide menus: guard at ${at.toString(16)}`); };
  expect(ALLOC, movWord(0, OBJECT)); expect(ALLOC + 4, bl(ALLOC + 4, OPERATOR_NEW)); expect(ALLOC + 12, bl(ALLOC + 12, CONSTRUCTOR));
  // The builder's loop over a page's items (0x5319a94c..0x5319a9e4).
  expect(B_ID_INDEX, 0xe284a06f); // add sl, r4, #0x6f
  expect(B_ID_INDEX + 8, 0xe0836184); // add r6, r3, r4, lsl #3
  expect(B_ID_INDEX + 0xc, 0xe083a10a); // add sl, r3, sl, lsl #2
  expect(B_VISIBLE - 8, 0xe0833184); // add r3, r3, r4, lsl #3
  expect(B_VISIBLE, 0xe2833f95); // add r3, r3, #0x254
  expect(B_VISIBLE + 4, 0xe8930006); // ldm r3, {r1, r2}
  expect(B_STORE, 0xe2853011); // add r3, r5, #0x11
  expect(B_STORE + 4, 0xe3500000); // cmp r0, #0
  expect(B_STORE + 8, 0xe51b0034); // ldr r0, [fp, #-0x34] (the tab)
  expect(B_STORE + 0x14, 0xe286108c); // add r1, r6, #0x8c (the draw member pointer it copies)
  expect(B_STORE + 0x20, 0xe286ef95); // add lr, r6, #0x254 (the visibility it copies)
  expect(B_STORE + 0x2c, 0x0a00000a); // beq B_STORE_END
  expect(B_STORE + 0x44, 0xe59a3000); // ldr r3, [sl] (the id it copies)
  expect(B_STORE + 0x4c, 0xe58c33e4); // str r3, [ip, #0x3e4]
  expect(B_STORE_END, 0xe1540009); // cmp r4, sb
  expect(B_STORE_END + 4, 0xe2866008); // add r6, r6, #8
  expect(B_STORE_END + 8, 0xe28aa004); // add sl, sl, #4
  // OK on a line.
  expect(OK_SITES[0], 0xe3a030e1); expect(OK_SITES[1], 0xe0200593); expect(OK_SITES[2], 0xe0844100); expect(OK_SITES[3], 0xe59443e4);
  // Drawing the lines (0x53199ba4).
  expect(DRAW, 0xe1a0c00d); expect(DRAW + 8, 0xe3a04fe1); // mov r4, #0x384
  expect(DRAW + 0xc, 0xe5d031b0); // ldrb r3, [r0, #0x1b0]
  expect(DRAW + 0x10, 0xe1a07000); // mov r7, r0
  expect(DRAW + 0x1c, 0xe0240394); // mla r4, r4, r3, r0
  expect(DRAW + 0x20, 0xe1a00008); // mov r0, r8
  expect(DRAW_COUNT, 0xe5d492b3); // ldrb sb, [r4, #0x2b3]
  expect(DRAW + 0x5c, 0xe59432b8); // ldr r3, [r4, #0x2b8]
  expect(DRAW + 0x70, 0xe2844008); // add r4, r4, #8
  expect(DRAW + 0x7c, 0x159432ac); // ldrne r3, [r4, #0x2ac]
  expect(DRAW + 0x80, 0x0594a2ac); // ldreq sl, [r4, #0x2ac]
  expect(DRAW + 0x98, 0xe1550009); // cmp r5, sb
  // The list view's rows.
  expect(ROWS_COUNT, 0xe3a02026); expect(ROWS_CALL, bl(ROWS_CALL, LIST_ROWS)); expect(LIST_ROWS, 0xe1a0c00d);
  const kinds = p.read(ROW_KINDS, MAX_ITEMS + 2);
  if (!kinds.subarray(0, MAX_ITEMS).every(k => k === ROW_KIND) || kinds[MAX_ITEMS] !== 0) fail('menu rows');
  if (GR3X_WIDE_OBJECT > 0xffff || GR3X_W_ID / 4 > 0xff) fail('sizes');

  // --- The other four tabs, wide (Setup: the descriptor in use).
  const others = OTHER_TABS.map((d, k) => {
    const official = k === SETUP_TAB && setup ? setup.bytes : p.read(d, DESCRIPTOR);
    return p.append(gr3xWiden(official));
  });
  const builder = p.code(`${pick}${others.map((d, k) => `movw r1,#${lo(d)};movt r1,#${hi(d)};str r1,[r2,#${(k + 1) * 4}];`).join('')}
    pop {r0-r3,ip,lr};mov ip,sp;b #${BUILDER + 4};`);
  p.patch(BUILDER, 0xe1a0c00d, branchWord(BUILDER, builder), `${what}: menus for this model, wide layout`);
  // --- The controller, larger.
  p.patch(ALLOC, movWord(0, OBJECT), movWord(0, GR3X_WIDE_OBJECT), `${what}: menu controller with room for ${W} lines a tab`);
  // --- The builder: the descriptor's ids and visibility at the wide offsets, the kept items in the controller's new arrays.
  p.patch(B_ID_INDEX, 0xe284a06f, (0xe284a000 | (GR3X_W_ID / 4)) >>> 0, `${what}: menu builder, ids of the wide descriptor`);
  p.patch(B_VISIBLE, 0xe2833f95, assembleWords(`add r3,r3,#${GR3X_W_VISIBLE}`, B_VISIBLE)[0], `${what}: menu builder, visibility of the wide descriptor`);
  // At B_STORE: r0 = whether the item is shown, r5 = lines kept so far, r6 = descriptor + item * 8, sl = the
  // item's id in the descriptor, r7 = the controller, [fp, #-0x34] = the tab. r0..r3, ip and lr are scratch
  // there (the official code sets them before it reads them, and after B_STORE_END reloads them).
  const store = p.code(`cmp r0,#0;beq done;ldr r0,[fp,#-0x34];movw ip,#${W};mul r1,r0,ip;add r1,r1,r5;
    add r2,r7,#${GR3X_C_ID & 0xff000};add r2,r2,r1,lsl #2;ldr r3,[sl];str r3,[r2,#${GR3X_C_ID & 0xfff}];
    movw ip,#${GR3X_C_DRAW};add r2,r7,ip;add r2,r2,r1,lsl #3;ldr r3,[r6,#${GR3X_W_DRAW}];str r3,[r2];ldr r3,[r6,#${GR3X_W_DRAW + 4}];str r3,[r2,#4];
    movw ip,#${GR3X_C_VISIBLE};add r2,r7,ip;add r2,r2,r1,lsl #3;ldr r3,[r6,#${GR3X_W_VISIBLE}];str r3,[r2];ldr r3,[r6,#${GR3X_W_VISIBLE + 4}];str r3,[r2,#4];
    add r5,r5,#1;done:b #${B_STORE_END};`);
  p.patch(B_STORE, 0xe2853011, branchWord(B_STORE, store), `${what}: menu builder, the lines kept`);
  // --- OK: the line's controller id (r4 = this, r0 = tab * W + line after the patched mla).
  const okId = p.code(`add r4,r4,#${GR3X_C_ID & 0xff000};ldr r4,[r4,#${GR3X_C_ID & 0xfff}];bx lr;`);
  p.patch(OK_SITES[0], 0xe3a030e1, (0xe3a03000 | W) >>> 0, `${what}: menu OK, the line's id`);
  p.patch(OK_SITES[3], 0xe59443e4, bl(OK_SITES[3], okId), `${what}: menu OK, the line's id`);
  // --- Drawing the lines: after the count is read (r4 = this + tab * 0x384, r3 = the tab, r7 = this),
  // r4 = the tab's draw functions - 0x2b4, so that the loop's [r4,#0x2b8] / [r4+8,#0x2ac] read them.
  const drawBase = p.code(`ldrb sb,[r4,#0x2b3];movw ip,#${W * 8};mul r4,r3,ip;add r4,r4,r7;movw ip,#${GR3X_C_DRAW - 0x2b4};add r4,r4,ip;bx lr;`);
  p.patch(DRAW_COUNT, 0xe5d492b3, bl(DRAW_COUNT, drawBase), `${what}: menu lines, the draw functions`);
  // --- The list view's rows.
  const kindsAt = p.append(new Uint8Array(W + 2).fill(ROW_KIND).fill(0, W));
  const rows = p.code(`movw r1,#${lo(kindsAt)};movt r1,#${hi(kindsAt)};mov r2,#${W};b #${LIST_ROWS};`);
  p.patch(ROWS_CALL, bl(ROWS_CALL, LIST_ROWS), bl(ROWS_CALL, rows), `${what}: menu list view with ${W} rows`);
  const tabs: Record<string, number> = {};
  others.forEach((d, k) => { tabs[`wideMenuTab${k + 1}`] = d; });
  return { ...tabs, wideBuilder: builder, wideStore: store, wideOk: okId, wideDraw: drawBase, wideRows: rows, wideRowKinds: kindsAt };
}
