// SPDX-License-Identifier: GPL-2.0-only
/**
 * Add aspect ratios to the RTOS image of firmware 1.11: new ratio identities next to the four
 * factory ones, with every place that looks a ratio up taught about them. The factory ratios keep
 * their numbers, their code paths and their data.
 *
 * This file is a port to TypeScript of the crop compiler of DoYitNow/gr-custom-tool (commit
 * 0c15c8f; gr4_editor/official_catalogs.py, official_scaffold.py, crop_icons.py, crop_registry.py,
 * crop_geometry.py, crop_raw.py, crop_state.py, crop_image_identity.py), Copyright (C) 2026
 * DoYitNow, licensed GPL-2.0-only. The hook sites, the assembly text of every hook and the order
 * in which things are appended are the reference's; do not "tidy" them: the tests require the
 * output to be byte-identical to what the reference tool builds from the same firmware.
 *
 * Differences from the reference, all outside the code it generates:
 *  - no emulator and no compiler at run time: firmware measurements come from `facts.ts`, the C
 *    modules from `native.ts`, the assembler is `arm.ts`;
 *  - identities are always assigned afresh (7, 8, ...) in list order;
 *  - the icons are drawn by `icon.ts`;
 *  - the reference's JSON footer is not written and the version number is not changed;
 *  - one addition of this program after everything the reference installs: `installPlaybackDecode`
 *    (build revision 2). Revision 1 is the reference's output, byte for byte.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord, movImmediate, movWord, wordsToBytes } from './arm';
import { FACTORY, MAG_BITS } from './facts';
import { playbackRectangles, planRatio, sourceRectangles } from './geometry';
import type { RatioGeometry } from './geometry';
import { RATIO_ICON_BYTES, RATIO_ICON_H, RATIO_ICON_W, drawRatioIcon } from './icon';
import { linkNative } from './native-link';
import { installAdjSoftFocus } from './softfocus';
import { installDirectFlash } from './directflash';
import { installDirectFlashMenu } from './directflash-menu';
import { DATESTAMP_BYTE, installDateStamp, lookNames } from './datestamp';
import { installDateStampMenu } from './datestamp-menu';
import { installMonoUnlock } from './monounlock';
import { CINEMA_STYLES, installExtraSlots, installHalation } from './slots';
import { halationLight } from './halation';
import type { HalationLook } from './halation';
import { installFactoryHidden, installLookOrder, validateLookLayout } from './looks';
import type { LookLayout } from './looks';
import type { ExtraSlotSpec } from './slots';
import { installShutdownMenu } from './shutdown';
import { FIRST_ADDED_LOOK, installSettingsGuard } from './guard';
import { LOOK_STASH, installLookStash, monoLook, monoTable, styleColour } from './lookstash';
import type { ShutdownPictureSpec } from './shutdown';

export const BASE = 0x53000000;
export const OFFICIAL_RTOS_LENGTH = 0x140b600;
export const OFFICIAL_ICONBIN_LENGTH = 0xf0f0e0;
/** The appended area must stay below the address where the firmware's RAM starts. */
export const APPEND_LIMIT = 0x55000000;

/** Start-up copy of initialised data: `length` bytes from `source` (in the image) to `destination`. */
const RAM = { source: 0x543b3100, destination: 0x55000000, length: 0x58500 };

export const ICON_CATALOG = 0x5440c600;
/** 1.20: 0x1400 after the icon catalog (1.11: 0x1000), for 1280 icons: Direct Flash's settings icons come after 1003 (see directflash-menu.ts). */
export const TEXT_CATALOG = 0x5440da00;
/** 1.20: 709 icons and 881 texts (1.11: 663 / 837), both renumbered. GR Mod's own texts are 1.11's + 44. */
const ICON_COUNT = 709;
const TEXT_COUNT = 881;
export const TEXT_SHIFT = 44;
const TEXT_CAPACITY = 896 + TEXT_SHIFT;
export const LANGUAGES = 21;
const ROW_STRIDE = TEXT_CAPACITY * 4;
const NATIVE_ICON_CATALOG = 0x55014280;
export const NATIVE_TEXT_ROOTS = 0x55002118;

export const ORDER_SITES = [0x531bc4c0, 0x531bc7a4, 0x531bf854, 0x531d254c, 0x531d4894, 0x531d620c, 0x5325ca8c] as const;
export const COUNT_SITES = [0x531bb684, 0x531d0a74] as const;
const FACTORY_ORDER = [0, 1, 3, 2] as const;
/** First identity given to an added ratio (4-6 belong to earlier versions of the reference tool). */
export const FIRST_CUSTOM_ID = 7;
export const MAX_CUSTOM_RATIOS = 8;
export const MAX_NAME_LENGTH = 80;
const VIEW_BYTES = 400 + 12 * 48;

/** Icon numbers for identities 4, 5, ...: 720..767, then 788..991 (768..787 are left free). */
function iconId(publicId: number): number {
  const index = publicId - 4;
  const id = index < 48 ? 720 + index : 788 + (index - 48);
  if (!(index >= 0 && id < 992)) throw new FirmwareError('internal', 'no icon number for this identity');
  return id;
}

/** Text numbers: the factory names (1.20 numbers of 1.11's 267, 268, 266, 269), then 945, 946, ... for identities 7, 8, ... */
export function textId(publicId: number): number {
  const fixed: Record<number, number> = { 0: 281, 1: 282, 2: 280, 3: 284, 4: 838 + TEXT_SHIFT, 5: 839 + TEXT_SHIFT };
  return fixed[publicId] ?? 900 + TEXT_SHIFT + publicId - 6;
}

export interface RatioSpec {
  /** Name shown in the camera's menu: 1..80 UTF-16 units. */
  name: string;
  /** The ratio as text: `65:24`, `2.39:1`, `2.39`. */
  ratio: string;
}

export interface RatioEntry extends RatioSpec {
  /** Identity stored in settings and in each photo's maker note. */
  id: number;
  geometry: RatioGeometry;
  /** 60x40 RGBA. */
  icon: Uint8Array;
}

export interface PatchedWord { address: number; before: number; after: number; reason: string }

/**
 * What a build holds besides the port of the reference: 1 = nothing (GR Mod 0.2.x), 2 = also the
 * playback decode buffer fix, 3 = the record at the end also lists this program's other additions
 * (see `ExtensionFeatures`), and there may be no added ratio at all. Recorded at the end of the
 * RTOS section (see `package.ts`). A build with added ratios only is still written as revision 2.
 */
export type BuildRevision = 1 | 2 | 3;
export const BUILD_REVISION: BuildRevision = 2;

/** Additions of this program that are not aspect ratios. */
export interface ExtensionFeatures {
  /** Soft focus as a function of the ADJ lever (see `softfocus.ts`). */
  adjSoftFocus?: boolean;
  /** Date imprint on the JPEG (see `datestamp.ts`). */
  dateStamp?: boolean;
  /** The six looks of the GR IV Monochrome (see `monounlock.ts`). */
  monoUnlock?: boolean;
  /** Added Image Control slots, 1 to 20 (see `slots.ts`; up to 0.8.1 at most 6). */
  extraSlots?: readonly ExtraSlotSpec[];
  /** Image Control menu order and hidden looks (see `looks.ts`). */
  lookLayout?: LookLayout;
  /**
   * Halation for Cinema Yellow / Green (0.8.2): only for a slot whose curves were replaced by a
   * preset (its Toning then does nothing and becomes the Halation slider, see `halation.ts`).
   */
  cinemaHalation?: Partial<Record<'CY' | 'CG', true>>;
  /**
   * Power-off pictures chosen in the camera's End Screen menu (see `shutdown.ts`): the pictures,
   * and the four factory pictures of the payload's RES section (for their thumbnails).
   */
  shutdown?: { pictures: readonly ShutdownPictureSpec[]; factory: readonly Uint8Array[] };
  /** Put back setting values this firmware does not know (see `guard.ts`). Every build from 0.8.2 on. */
  guard?: boolean;
  /** Direct Flash, a fifth Flash Mode (0.8.4, see `directflash.ts`); the guide number is chosen in the camera. */
  directFlash?: boolean;
}

/** For test builds only: a fixed setting byte (1 short, 3 long style) instead of the camera menu. */
export interface TestOptions {
  dateStampFixed?: number;
  /** Also print the encoder configuration on the 720x480 picture. */
  dateStampDiag?: boolean;
  /** Direct Flash diagnostics: the planner records what it saw, the date imprint prints it on the 720x480 picture. */
  directFlashDiag?: boolean;
}

export interface AspectResult {
  revision: BuildRevision;
  /** The new RTOS image: official length + appended area. Ends on a 4-byte boundary. */
  rtos: Uint8Array;
  /** The new ICONBIN data: the official bytes followed by one 60x40 RGBA icon per added ratio. */
  iconbin: Uint8Array;
  ratios: RatioEntry[];
  /** Every word changed inside the official part of the image, in the order they were written. */
  words: PatchedWord[];
  /** The other additions that were installed. */
  features: ExtensionFeatures;
}

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** A growable RTOS image with the reference's `_Patch` interface. */
export class Patch {
  private buf: Uint8Array;
  private len: number;
  readonly words: PatchedWord[] = [];
  textBoundSites: number[] = [];
  /** Records of the relocated submenu table (0 while it is the official one; see `datestamp-menu.ts`). */
  submenuRecords = 0;
  /** List records (SelectMenuController) in the list table so far, once it is copied (see `datestamp-menu.ts`); 0 = the official table. */
  listRecords = 0;

  constructor(official: Uint8Array) {
    this.buf = new Uint8Array(official.length + 0x80000);
    this.buf.set(official);
    this.len = official.length;
  }

  get length(): number {
    return this.len;
  }

  /** Address the next thing appended with `alignment` would get. */
  next(alignment: number): number {
    return BASE + this.len + ((alignment - (this.len % alignment)) % alignment);
  }

  private reserve(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    bigger.set(this.buf.subarray(0, this.len));
    this.buf = bigger;
  }

  /** Zero-pad up to image offset `end`. */
  extendTo(end: number): void {
    if (end < this.len) fail('internal', 'cannot shrink the image');
    this.reserve(end - this.len);
    this.len = end;
  }

  append(blob: Uint8Array | readonly number[] | ((address: number) => readonly number[]), alignment = 4): number {
    const pad = (alignment - (this.len % alignment)) % alignment;
    this.reserve(pad);
    this.len += pad; // the buffer is zero-filled beyond `len`
    const address = BASE + this.len;
    let bytes: Uint8Array;
    if (typeof blob === 'function') bytes = wordsToBytes(blob(address));
    else if (blob instanceof Uint8Array) bytes = blob;
    else bytes = wordsToBytes(blob);
    this.reserve(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    return address;
  }

  private offsetOf(address: number, size: number): number {
    const o = address - BASE;
    if (!(o >= 0 && o + size <= this.len)) fail('internal', `0x${address.toString(16)} is outside the image`);
    return o;
  }

  word(address: number): number {
    const o = this.offsetOf(address, 4);
    return (this.buf[o] | (this.buf[o + 1] << 8) | (this.buf[o + 2] << 16) | (this.buf[o + 3] << 24)) >>> 0;
  }

  read(address: number, size: number): Uint8Array {
    const o = this.offsetOf(address, size);
    return this.buf.slice(o, o + size);
  }

  /** Read through the start-up data copy: addresses in RAM come from their image in the ROM. */
  readMapped(address: number, size: number): Uint8Array {
    if (address >= RAM.destination) {
      if (!(address + size <= RAM.destination + RAM.length)) fail('unexpected-layout', 'resource is not in the initialised data');
      address = RAM.source + (address - RAM.destination);
    }
    return this.read(address, size);
  }

  write(address: number, bytes: Uint8Array): void {
    this.buf.set(bytes, this.offsetOf(address, bytes.length));
  }

  setWord(address: number, value: number, reason: string): void {
    const before = this.word(address);
    const o = address - BASE;
    const v = value >>> 0;
    this.buf[o] = v & 0xff;
    this.buf[o + 1] = (v >>> 8) & 0xff;
    this.buf[o + 2] = (v >>> 16) & 0xff;
    this.buf[o + 3] = v >>> 24;
    if (o < OFFICIAL_RTOS_LENGTH) this.words.push({ address, before, after: v, reason });
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export function u32le(values: readonly number[]): Uint8Array {
  return wordsToBytes(values);
}

export function u16le(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  values.forEach((v, i) => {
    if (!(Number.isInteger(v) && v >= 0 && v <= 0xffff)) fail('internal', 'value does not fit 16 bits');
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = v >>> 8;
  });
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function expectWord(patch: Patch, address: number, value: number): void {
  if (patch.word(address) !== value >>> 0) fail('unexpected-layout', `unexpected instruction at 0x${address.toString(16)}`);
}

/** `movw r,#low; movt r,#high;` */
function addr(r: string, value: number): string {
  return `movw ${r},#${value & 65535};movt ${r},#${value >>> 16};`;
}

// --------------------------------------------------------------------------------------------
// official_catalogs.py + official_scaffold.py

function initializeCatalogs(patch: Patch): void {
  const icons = patch.readMapped(NATIVE_ICON_CATALOG, ICON_COUNT * 4);
  const rootBytes = patch.readMapped(NATIVE_TEXT_ROOTS, LANGUAGES * 4);
  const roots = new DataView(rootBytes.buffer);
  const textRows: Uint8Array[] = [];
  for (let l = 0; l < LANGUAGES; l++) textRows.push(patch.readMapped(roots.getUint32(l * 4, true), TEXT_COUNT * 4));
  const rowsStart = TEXT_CATALOG + 0x100;
  const end = rowsStart + LANGUAGES * ROW_STRIDE;
  if (BASE + patch.length > ICON_CATALOG - 0x40) fail('unexpected-layout', 'the image already reaches the catalog area');
  patch.extendTo(end - BASE);
  patch.write(ICON_CATALOG, icons);
  const relocated: number[] = [];
  for (let l = 0; l < LANGUAGES; l++) relocated.push(rowsStart + l * ROW_STRIDE);
  patch.write(TEXT_CATALOG, u32le(relocated));
  relocated.forEach((address, l) => patch.write(address, textRows[l]));

  // Both icon consumers go through one getter; text drawing and text measuring each load the
  // language directory themselves.
  patch.setWord(0x534013f8, movWord(0, ICON_CATALOG & 65535), 'use the extended icon catalog');
  patch.setWord(0x534013fc, movWord(0, ICON_CATALOG >>> 16, true), 'use the extended icon catalog');
  // 1.20 compares the icon number with an immediate (cmp r4,#708 / cmp r7,#708; 1.11 loaded the
  // bound with a movw): each goes through a helper that keeps r3, at a fixed place just below the
  // catalogs so that LOOKUP_BOUNDS can name its movw.
  for (const [site, helper, compare] of ICON_BOUND_HELPERS) {
    expectWord(patch, site, compare);
    const cmp = 0xe1500003 | (((compare >>> 16) & 15) << 16);
    const words = [0xe52d3004, movWord(3, ICON_COUNT - 1), cmp, 0xe49d3004, branchWord(helper + 16, site + 4)];
    patch.write(helper, u32le(words));
    patch.setWord(site, branchWord(site, helper), 'icon bound through a helper that keeps r3');
  }
  for (const [low, high] of [[0x535967cc, 0x535967d0], [0x53595db4, 0x53595dbc]] as const) {
    patch.setWord(low, movWord(3, TEXT_CATALOG & 65535), 'extended language catalog, low half');
    patch.setWord(high, movWord(3, TEXT_CATALOG >>> 16, true), 'extended language catalog, high half');
  }
  const boundSites: number[] = [];
  for (const [site, conditional] of [[0x535967c0, false], [0x53595da8, true]] as const) {
    // Keeps r3. The measuring CMP runs under LS so that the flags of the preceding language check
    // survive when the language is out of range.
    const compare = conditional ? 0x91570003 : 0xe1570003;
    const helper = patch.append((address) => [0xe52d3004, movWord(3, TEXT_COUNT - 1), compare, 0xe49d3004, branchWord(address + 16, site + 4)], 16);
    patch.setWord(site, branchWord(site, helper), 'text bound through a helper that keeps r3');
    boundSites.push(helper + 4);
  }
  patch.textBoundSites = boundSites;
}

function initializeScaffold(patch: Patch): void {
  initializeCatalogs(patch);
  for (const site of [0x533f3674, 0x533f3254]) {
    const instruction = patch.word(site);
    if (instruction !== 0xe1a0c00d) fail('unexpected-layout', 'settings save/load entry is not what was expected');
    const address = patch.append((at) => [instruction, branchWord(at + 4, site + 4)], 16);
    patch.setWord(site, branchWord(site, address), 'continuation of the native settings save/load');
  }
}

// --------------------------------------------------------------------------------------------
// crop_icons.py

/** [site, helper, the official `cmp rN,#708`]: the two icon lookups (1.11: movw r3 / movw r2 at 0x5323dbb4 / 0x5323e40c). */
const ICON_BOUND_HELPERS = [[0x5323f7ec, ICON_CATALOG - 0x40, 0xe3540fb1], [0x53240064, ICON_CATALOG - 0x20, 0xe3570fb1]] as const;
/** The movw of each icon-bound helper (register r3). */
export const LOOKUP_BOUNDS = [[ICON_CATALOG - 0x40 + 4, 3], [ICON_CATALOG - 0x20 + 4, 3]] as const;

function installIcons(patch: Patch, iconbin: Uint8Array, ratios: readonly RatioEntry[]): { iconbin: Uint8Array; ids: Map<number, number> } {
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  const ids = new Map<number, number>();
  for (const r of ratios) {
    const identity = iconId(r.id);
    if (patch.word(ICON_CATALOG + identity * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    if (r.icon.length !== RATIO_ICON_BYTES) fail('bad-icon', 'a ratio icon is 60x40 RGBA');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const offset = length;
    parts.push(r.icon);
    length += r.icon.length;
    // {u16 kind = 1, u16 width, u16 height, u16 flags = 0, u32 offset in 4-byte units}
    const descriptor = patch.append(concat([u16le([1, RATIO_ICON_W, RATIO_ICON_H, 0]), u32le([offset / 4])]), 16);
    patch.setWord(ICON_CATALOG + identity * 4, descriptor, 'ratio icon');
    ids.set(r.id, identity);
  }
  let upper = 0;
  for (const v of ids.values()) upper = Math.max(upper, v);
  for (const [site] of LOOKUP_BOUNDS) upper = Math.max(upper, movImmediate(patch.word(site)));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, upper), 'icon upper bound');
  }
  return { iconbin: concat(parts), ids };
}

// --------------------------------------------------------------------------------------------
// crop_registry.py install_menu

/**
 * Make every language row of the relocated text catalog hold text numbers up to `upper` (copies
 * the rows, every entry kept, when they are narrower) and raise the text lookup bound to it.
 */
export function widenTextRows(patch: Patch, upper: number): void {
  let prior = TEXT_CAPACITY;
  for (const site of patch.textBoundSites) prior = Math.max(prior, movImmediate(patch.word(site)) + 1);
  if (upper + 1 > prior) {
    for (let l = 0; l < LANGUAGES; l++) {
      const row = new Uint8Array((upper + 1) * 4);
      row.set(patch.read(patch.word(TEXT_CATALOG + l * 4), prior * 4));
      patch.setWord(TEXT_CATALOG + l * 4, patch.append(row, 16), 'language row, wider');
    }
  }
  for (const site of patch.textBoundSites) patch.setWord(site, movWord(3, Math.max(upper, movImmediate(patch.word(site)))), 'text upper bound');
}

export function utf16z(text: string): Uint8Array {
  const out = new Uint8Array((text.length + 1) * 2);
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    out[i * 2] = u & 0xff;
    out[i * 2 + 1] = u >>> 8;
  }
  return out;
}

function installMenu(patch: Patch, ratios: readonly RatioEntry[], iconIds: ReadonlyMap<number, number>): { activeBitmap: number } {
  const order = [...FACTORY_ORDER, ...ratios.map((r) => r.id)];
  const allIds = [0, 1, 2, 3, ...ratios.map((r) => r.id)];
  const count = order.length;
  const orderAt = patch.append(Uint8Array.from(order), 16);
  for (const site of ORDER_SITES) {
    const high = site + (site === 0x531bf854 || site === 0x531d254c ? 8 : 4);
    patch.setWord(site, movWord(3, orderAt & 65535), 'ratio menu order, low half');
    patch.setWord(high, movWord(3, orderAt >>> 16, true), 'ratio menu order, high half');
  }
  for (const site of COUNT_SITES) patch.setWord(site, movWord(0, count), 'ratio menu count');

  // Fn-button cycling. r0 = current identity, r3 = order table, r4 = the selector object; rejoins
  // the native setter at 0x5325CACC. An identity that is not in the table falls back to the first.
  const cycleAt = patch.append((at) => {
    const words = [
      0xe3a02000, 0xe7d31002, 0xe1510000, 0x0a000000, 0xe2822001, movWord(12, count), 0xe152000c, 0x3a000000,
      0xe3a02000, 0xea000000, 0xe2822001, 0xe152000c, 0x03a02000, 0xe7d31002, branchWord(at + 56, 0x5325cacc),
    ];
    words[3] = branchWord(at + 12, at + 40, 0);
    words[7] = branchWord(at + 28, at + 4, 3);
    words[9] = branchWord(at + 36, at + 52);
    return words;
  }, 16);
  patch.setWord(0x5325ca94, branchWord(0x5325ca94, cycleAt), 'ratio cycling over the new order');

  // Complete language rows again, now wide enough for the new names; every original entry is kept.
  let priorColumns = TEXT_CAPACITY;
  for (const site of patch.textBoundSites) priorColumns = Math.max(priorColumns, movImmediate(patch.word(site)) + 1);
  let upper = 839 + TEXT_SHIFT;
  for (const id of allIds) upper = Math.max(upper, textId(id));
  const columns = Math.max(priorColumns, upper + 1);
  const catalogs: Uint8Array[] = [];
  for (let l = 0; l < LANGUAGES; l++) {
    const row = new Uint8Array(columns * 4);
    row.set(patch.read(patch.word(TEXT_CATALOG + l * 4), priorColumns * 4));
    catalogs.push(row);
  }
  for (const r of ratios) {
    const encoded = utf16z(r.name);
    const units = encoded.length / 2;
    if (r.name.trim() === '' || !(units > 1 && units <= MAX_NAME_LENGTH + 1)) fail('bad-name', 'a ratio name has 1 to 80 characters');
    const address = patch.append(encoded, 4);
    // {u8 units including the terminator, u8 lines = 1, u16 0, u32 text address}
    const record = patch.append(concat([Uint8Array.from([units, 1, 0, 0]), u32le([address])]), 4);
    for (const row of catalogs) new DataView(row.buffer).setUint32(textId(r.id) * 4, record, true);
  }
  catalogs.forEach((row, l) => patch.setWord(TEXT_CATALOG + l * 4, patch.append(row, 16), 'language row with ratio names'));
  for (const site of patch.textBoundSites) patch.setWord(site, movWord(3, Math.max(upper, movImmediate(patch.word(site)))), 'text upper bound');

  const table256 = (get: (n: number) => number): number[] => Array.from({ length: 256 }, (_, n) => get(n));
  const textTable = patch.append(u32le(table256((n) => (allIds.includes(n) ? textId(n) : 0))), 16);
  const textAt = patch.append([movWord(3, textTable & 65535), movWord(3, textTable >>> 16, true), 0xe35100ff, 0x83a00000, 0x812fff1e, 0xe7930101, 0xe12fff1e], 16);
  patch.setWord(0x5338f198, branchWord(0x5338f198, textAt), 'ratio identity to name');

  if (iconIds.size !== ratios.length || ratios.some((r) => !(iconIds.get(r.id)! > 0 && iconIds.get(r.id)! <= 65535))) fail('internal', 'icon list does not match the ratios');
  const iconTable = patch.append(u32le(table256((n) => iconIds.get(n) ?? 0)), 16);
  // Factory identities rejoin the untouched native body (with its first CMP replayed).
  const iconAt = patch.append((at) => [
    0xe3510004, branchWord(at + 4, at + 48, 3), 0xe35100ff, 0x83a00000, 0x812fff1e, 0xe3520000, 0x13a00000, 0x112fff1e,
    movWord(3, iconTable & 65535), movWord(3, iconTable >>> 16, true), 0xe7930101, 0xe12fff1e, 0xe3510000, branchWord(at + 52, 0x53390a8c),
  ], 16);
  patch.setWord(0x53390a88, branchWord(0x53390a88, iconAt), 'ratio identity to icon');

  const bitmap = patch.append(Uint8Array.from(table256((n) => (order.includes(n) ? 1 : 0))), 16);
  const validAt = patch.append([movWord(3, bitmap & 65535), movWord(3, bitmap >>> 16, true), 0xe35100ff, 0x83a00000, 0x812fff1e, 0xe7d30001, 0xe12fff1e], 16);
  patch.setWord(0x5376fb10, branchWord(0x5376fb10, validAt), 'accept only identities that are in the menu');
  return { activeBitmap: bitmap };
}

// --------------------------------------------------------------------------------------------
// crop_geometry.py

class Program {
  /** The image as it was when the program was created (displaced instructions are read from it). */
  private readonly source: Uint8Array;
  cursor: number;

  constructor(readonly patch: Patch) {
    this.source = patch.bytes();
    this.cursor = (BASE + patch.length + 3) & ~3;
  }

  sourceWord(at: number): number {
    const o = at - BASE;
    return (this.source[o] | (this.source[o + 1] << 8) | (this.source[o + 2] << 16) | (this.source[o + 3] << 24)) >>> 0;
  }

  blob(value: Uint8Array): number {
    const at = this.patch.append(value, 4);
    this.cursor = (at + value.length + 3) & ~3;
    return at;
  }

  emit(code: string): number {
    return this.blob(wordsToBytes(assembleWords(code, this.cursor)));
  }

  hook(entry: number, code: string): number {
    const at = this.emit(code);
    this.patch.setWord(entry, branchWord(entry, at), 'ratio geometry consumer');
    return at;
  }

  /**
   * A trampoline that replays the instruction a hook is about to overwrite and continues after it.
   * A branch is re-targeted; a PC-relative VFP load gets its literal copied next to the trampoline.
   */
  target(at: number): number {
    let w = this.sourceWord(at);
    const origin = (BASE + this.patch.length + 3) & ~3;
    const vfp = (w & 0x0f3f0f00) >>> 0;
    if (vfp === 0x0d1f0a00 || vfp === 0x0d1f0b00) {
      const literal = at + 8 + (w & 0x00800000 ? 1 : -1) * (w & 255) * 4;
      const size = w & 0x100 ? 8 : 4;
      const o = literal - BASE;
      const data = this.source.slice(o, o + size);
      const replay = ((w & ~0x008000ff) | 0x00800000) >>> 0;
      return this.blob(concat([u32le([replay, branchWord(origin + 4, at + 4)]), data]));
    }
    if ((w & 0x0e000000) === 0x0a000000) w = branchWord(origin, branchTarget(at, w), w >>> 28, (w & 0x01000000) !== 0);
    return this.blob(u32le([w, branchWord(origin + 4, at + 4)]));
  }

  /** Check that the instruction at `entry` is the one a hook is written around. */
  expect(entry: number, displaced: string, what: string): void {
    if (assembleWords(displaced, entry)[0] !== this.sourceWord(entry)) fail('unexpected-layout', what);
  }
}

interface Row { id: number; g: RatioGeometry; address: number; dimAddress: number }

function dimsBlob(g: RatioGeometry): Uint8Array {
  return concat(g.dims.map((d) => u16le(d)));
}

function buildGeometry(patch: Patch, ratios: readonly RatioEntry[]): { p: Program; get: number; scale: number } {
  const p = new Program(patch);
  const rows: Row[] = [];
  for (const r of ratios) {
    const g = r.geometry;
    // fx/fy fractions, small-image origins, AF rectangle and sizes, tracking axes, hardware alias.
    const values = [...g.fx, ...g.fy, g.screen.left, g.screen.top, g.thumb.left, g.thumb.top, ...g.af, ...g.afSize, ...g.afSmall, ...g.tracking, g.modeAlias];
    const address = p.blob(u32le(values));
    const dimAddress = p.blob(dimsBlob(g));
    rows.push({ id: r.id, g, address, dimAddress });
  }
  let lookup = '';
  for (const row of rows) lookup += `cmp r0,#${row.id};` + addr('ip', row.address) + 'moveq r0,ip;bxeq lr;';
  lookup += 'mov r0,#0;bx lr;';
  const get = p.emit(lookup);
  const scale = p.emit('mov ip,r1;mov r3,#0;umull r0,r1,r0,ip;b #0x5315512C;');
  const previewScale = p.emit('mov ip,r1;mov r3,#0;umull r0,r1,r0,ip;mov ip,r2,lsr#1;adds r0,r0,ip;adc r1,r1,#0;b #0x5315512C;');

  let out = `push {r0-r3,ip,lr};bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};movne r4,r0;bne #0x538B4104;b #${p.target(0x538b40ec)};`;
  p.hook(0x538b40ec, out);
  out = `push {r0-r3,ip,lr};mov r0,r3;bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};movne r0,r3;bne #0x538B41CC;b #${p.target(0x538b41b4)};`;
  p.hook(0x538b41b4, out);
  out = `push {r0-r3,ip,lr};bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};beq old;ldrb r1,[r4,#0x8D];cmp r0,r1;moveq r0,#0;movne r0,#1;b #0x53664450;old:b #${p.target(0x53664430)};`;
  p.hook(0x53664430, out);
  // Both callers select the cropped window only for their original 2..5 range; a computed window
  // is invisible if selector 0 copies the untouched full canvas instead.
  out = `push {r0-r3,ip,lr};mov r0,r4;bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};movne r0,#1;bne #0x53652DA8;sub r4,r4,#2;b #0x53652D9C;`;
  p.hook(0x53652d98, out);
  out = `push {r0-r3,ip,lr};mov r0,r1;bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};beq old;orr r1,r3,#1;ldr r0,[r0,#0x3A0];b #0x538AF658;old:sub r1,r1,#2;b #0x53658C5C;`;
  p.hook(0x53658c58, out);

  // Output size: let the native function work out the 3:2 size, then look the result up.
  for (const entry of [0x538f6db0, 0x538f7520]) {
    const old = p.target(entry);
    out = 'cmp r2,#5;bls old;push {r4-r10,lr};mov r4,r2;mov r5,r3;ldr r6,[sp,#32];';
    for (const row of rows) out += `cmp r4,#${row.id};` + addr('r7', row.dimAddress) + `beq foundrow${row.id};`;
    out += 'pop {r4-r10,lr};b old;';
    for (const row of rows) out += `foundrow${row.id}: mov r9,#${row.g.dims.length};b calculate;`;
    out += `calculate: mov r2,#0;sub sp,sp,#8;str r6,[sp];bl #${old};add sp,sp,#8;mov r8,r0;ldrh r0,[r5];ldrh r1,[r6];`;
    out += 'lookupdim: ldrh r2,[r7];cmp r0,r2;ldrh r2,[r7,#2];cmpeq r1,r2;beq dimensions;add r7,r7,#8;subs r9,r9,#1;bne lookupdim;b done;';
    out += 'dimensions: ldrh r2,[r7,#4];strh r2,[r5];ldrh r2,[r7,#6];strh r2,[r6];done:mov r0,r8;pop {r4-r10,pc};';
    out += `old:b #${old};`;
    p.hook(entry, out);
  }
  // Crop origin of the 720x480 screen image and of the 160x120 thumbnail, for both model branches.
  for (const [entry, kind] of [[0x538f726c, 'screen'], [0x538f79dc, 'screen'], [0x538f7324, 'thumb'], [0x538f7a94, 'thumb']] as const) {
    out = '';
    for (const row of rows) out += `cmp r1,#${row.id};beq ratio${row.id};`;
    out += `b #${p.target(entry)};`;
    for (const row of rows) {
      const region = row.g[kind];
      out += `ratio${row.id}:movw r0,#${region.left};movw r1,#${region.top};strh r0,[r2];strh r1,[r3];bx lr;`;
    }
    p.hook(entry, out);
  }
  // Live-view rectangle on the 45x30 plane: native 3:2 result, scaled by fx / fy and re-centred.
  out = 'cmp r2,#5;bls old;cmp r1,#0;bne old;push {r4-r10,lr};mov r5,r0;mov r0,r2;';
  out += `bl #${get};cmp r0,#0;beq missing;mov r4,r0;mov r0,r5;mov r2,#0;mov ip,sp;bl #0x538AEFCC;mov r10,r0;`;
  for (const rect of [36, 52]) {
    for (const [dimension, origin, fn, fd] of [[rect, rect + 8, 0, 4], [rect + 4, rect + 12, 8, 12]]) {
      out += `ldr r6,[r5,#${dimension}];mov r0,r6;ldr r1,[r4,#${fn}];ldr r2,[r4,#${fd}];bl #${previewScale};str r0,[r5,#${dimension}];sub r6,r6,r0;add r6,r6,#1;ldr r7,[r5,#${origin}];add r7,r7,r6,lsr#1;str r7,[r5,#${origin}];`;
    }
  }
  out += 'mov r0,r10;pop {r4-r10,pc};missing:mov r0,r5;pop {r4-r10,lr};old:mov ip,sp;b #0x538AEFCC;';
  p.hook(0x538aefc8, out);
  // AF area rectangle, its size and the small frame.
  for (const [entry, kind] of [[0x533adf10, 'rectangle'], [0x533ae148, 'size'], [0x533ae170, 'small']] as const) {
    out = '';
    for (const row of rows) out += `cmp r0,#${row.id};beq ratio${row.id};`;
    out += `b #${p.target(entry)};`;
    for (const row of rows) {
      if (kind === 'rectangle') {
        const [l, t, r, b] = row.g.af;
        out += `ratio${row.id}:movw r0,#${b};movw r1,#${l};movw r2,#${t};movw r3,#${r};b #0x533ADEF4;`;
      } else {
        const [w, h] = kind === 'size' ? row.g.afSize : row.g.afSmall;
        out += `ratio${row.id}:movw r1,#${w};movw r2,#${h};mov r0,r5;bl #0x53911D30;b #0x533AE0DC;`;
      }
    }
    p.hook(entry, out);
  }
  // Tracking windows.
  out = '';
  for (const row of rows) out += `cmp r2,#${row.id};beq ratio${row.id};`;
  out += 'cmp r2,#5;beq #0x5364DF8C;b #0x536728E8;';
  for (const row of rows) out += `ratio${row.id}:movw r4,#${row.g.tracking[0]};movw r7,#${row.g.tracking[1]};b #0x53672994;`;
  p.hook(0x536728e4, out);
  out = '';
  for (const row of rows) out += `cmp r2,#${row.id};beq ratio${row.id};`;
  out += 'cmp r2,#5;beq #0x53672ED0;b #0x53672E84;';
  for (const row of rows) {
    const [tx, ty] = row.g.tracking;
    const [lockx, locky] = row.g.modeAlias === 5 ? [778, 1000] : [1000, 750];
    out += `ratio${row.id}:cmp r7,#0;movw r5,#${lockx};movw r4,#${locky};bne #0x5364E440;movw r5,#${tx};movw r4,#${ty};b #0x53672DE0;`;
  }
  p.hook(0x53672e80, out);
  // Hardware mode alias: wider than 3:2 borrows the native wide branch, otherwise the square one.
  out = '';
  for (const row of rows) out += `cmp r1,#${row.id};beq ratio${row.id};`;
  out += 'b #0x536731C8;';
  for (const row of rows) out += `ratio${row.id}:cmp r2,#0;moveq r0,#0;movne r0,#${row.g.modeAlias};b #0x536731C0;`;
  p.hook(0x53673144, out);
  for (const [entry, resume] of [[0x536726b0, 0x536726b4], [0x536726d8, 0x536726dc]]) {
    out = '';
    for (const row of rows) out += `cmp ip,#${row.id};beq custom;`;
    out += `bic ip,ip,#4;b #${resume};custom:`;
    if (entry === 0x536726b0) out += 'add ip,r0,#0x354;'; // 1.11: 0x340 / 0x320 (upstream crop120)
    else out += 'ldr lr,[sp,#0xC];cmp lr,#0x2000;addeq ip,r0,#0x334;addne ip,r0,#0x354;';
    out += 'ldr lr,[ip];str lr,[r1];ldr lr,[ip,#4];str lr,[r1,#4];b #0x53672668;';
    p.hook(entry, out);
  }
  // Low-level live-view width / height. The ratio is the SECOND stack argument. Probe the native
  // square / panoramic cases to keep each resolution's mode overrides, then replace only the
  // dimension that really depends on the crop.
  for (const [entry, displaced, resume, axis, comparison] of [
    [0x538b2264, 'mov ip,sp', 0x538b2268, 0, 3],
    [0x538b282c, 'ldrb r0,[r0,#9]', 0x538b2830, 8, 5],
  ] as const) {
    p.expect(entry, displaced, 'live-view dimension entry has changed');
    const original = p.emit(`${displaced};b #${resume};`);
    out = 'push {r4-r10,lr};mov r4,r0;mov r5,r1;mov r6,r2;mov r7,r3;ldr r0,[sp,#36];';
    out += `bl #${get};cmp r0,#0;beq old;mov r8,r0;sub sp,sp,#16;ldr r0,[sp,#48];str r0,[sp];ldr r0,[sp,#56];str r0,[sp,#8];mov r0,#0;str r0,[sp,#4];`;
    const callOriginal = `mov r0,r4;mov r1,r5;mov r2,r6;mov r3,r7;bl #${original};`;
    out += callOriginal + `mov r9,r0;mov r0,#${comparison};str r0,[sp,#4];` + callOriginal;
    out += 'cmp r0,r9;beq base;';
    if (axis === 0) {
      // Panoramic families can have a wider physical output than 3:2; use that native family
      // only for a vertically cropped aperture.
      out += 'ldr r1,[r8];ldr r2,[r8,#4];cmp r1,r2;blo scale;ldr r1,[r8,#8];ldr r2,[r8,#12];cmp r1,r2;bhs base;mov r0,#5;str r0,[sp,#4];';
      out += callOriginal + 'b done;';
    } else out += 'ldr r1,[r8,#8];ldr r2,[r8,#12];';
    out += `scale:mov r0,r9;bl #${scale};add r0,r0,#1;bic r0,r0,#1;b done;base:mov r0,r9;done:add sp,sp,#16;pop {r4-r10,pc};`;
    out += `old:mov r0,r4;mov r1,r5;mov r2,r6;mov r3,r7;pop {r4-r10,lr};b #${original};`;
    p.hook(entry, out);
  }
  // Vertical scale helper: only a vertically cropped aperture takes its panoramic route.
  out = `push {r0-r3,ip,lr};mov r0,r7;bl #${get};cmp r0,#0;beq old;ldr r1,[r0,#8];ldr r2,[r0,#12];cmp r1,r2;pop {r0-r3,ip,lr};blo #0x538B3724;b #0x538B3678;old:pop {r0-r3,ip,lr};cmp r7,#5;beq #0x538B3724;b #0x538B3678;`;
  p.hook(0x538b3720, out);
  out = 'push {r0-r5,r8-r10,lr};ldrb r0,[r4,#0x8D];';
  out += `bl #${get};cmp r0,#0;beq old;mov r8,r0;`;
  for (const [value, origin, fn, fd] of [['r6', 300, 0, 4], ['r7', 308, 8, 12]] as const) {
    out += `mov r9,${value};mov r0,${value};ldr r1,[r8,#${fn}];ldr r2,[r8,#${fd}];bl #${scale};add r0,r0,#1;bic r0,r0,#1;mov ${value},r0;sub r9,r9,r0;ldr r10,[fp,#-${origin}];add r10,r10,r9,lsr#1;str r10,[fp,#-${origin}];`;
  }
  out += 'old:pop {r0-r5,r8-r10,lr};ldr r3,[fp,#-0x12C];b #0x53659828;';
  p.hook(0x53659824, out);
  {
    const entry = 0x5366ac98;
    const displaced = 'cmp r2,#0x100';
    p.expect(entry, displaced, 'live-view ROI entry has changed');
    out = 'push {r0-r4,r7-r10,lr};mov r0,sl;';
    out += `bl #${get};cmp r0,#0;beq old;mov r8,r0;mov r0,r6;ldr r1,[r8];ldr r2,[r8,#4];bl #${scale};add r0,r0,#1;bic r6,r0,#1;mov r0,r5;ldr r1,[r8,#8];ldr r2,[r8,#12];bl #${scale};add r0,r0,#1;bic r5,r0,#1;`;
    out += `old:pop {r0-r4,r7-r10,lr};${displaced};b #${entry + 4};`;
    p.hook(entry, out);
  }
  // The clipped ROI bypasses the common route. The flags of the native CMP are kept for the
  // conditional stores that follow.
  out = 'push {r0-r4,r7-r10,lr};mov r0,sl;mrs r10,cpsr;';
  out += `bl #${get};cmp r0,#0;beq old;mov r8,r0;mov r0,r6;ldr r1,[r8];ldr r2,[r8,#4];bl #${scale};add r0,r0,#1;bic r6,r0,#1;mov r0,r5;ldr r1,[r8,#8];ldr r2,[r8,#12];bl #${scale};add r0,r0,#1;bic r5,r0,#1;`;
  out += 'old:msr cpsr_f,r10;pop {r0-r4,r7-r10,lr};strls r5,[fp,#-0x68];b #0x5366B5A8;';
  p.hook(0x5366b5a4, out);
  // The live-view route above has already applied fx/fy to its source ROI, so its preliminary
  // scales and both converter passes must work on the physical canvas (ratio 0), or the same axis
  // would be cropped twice. An interior BL is replaced, so LR is set to return to the call site.
  for (const [callsite, target, aspectRegister] of [
    [0x5366ac70, 0x538b3dc8, 'r3'], [0x5366ac88, 0x538b35c4, 'r3'], [0x5366ace4, 0x538b3280, 'r2'],
    [0x5366ad0c, 0x538b33d8, 'r2'], [0x5366b5d0, 0x538b3280, 'r2'], [0x5366b5f4, 0x538b33d8, 'r2'],
  ] as const) {
    p.expect(callsite, `bl #${target}`, 'live-view converter call has changed');
    out = `push {r0-r3,ip,lr};mov r0,${aspectRegister};bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};movne ${aspectRegister},#0;`;
    out += addr('lr', callsite + 4) + `b #${target};`;
    p.hook(callsite, out);
  }
  return { p, get, scale };
}

/** ImageDevelop: lens-correction coefficient and the crop region of the final descriptor. */
function installDevelop(p: Program, scale: number, ratios: readonly RatioEntry[]): void {
  const entries: { id: number; address: number }[] = [];
  for (const r of ratios) {
    const g = r.geometry;
    // Diagonal of the live-view rectangle relative to the 3:2 one, as a float32.
    const factor = Math.fround(Math.sqrt(g.preview.width * g.preview.width + g.preview.height * g.preview.height) / Math.sqrt(2949120 * 2949120 + 1966080 * 1966080));
    const dimensions = p.blob(dimsBlob(g));
    const f = new DataView(new ArrayBuffer(4));
    f.setFloat32(0, factor, true);
    const words = [f.getUint32(0, true), g.screen.width, g.screen.height, dimensions, g.dims.length, g.thumb.width, g.thumb.height];
    entries.push({ id: r.id, address: p.blob(u32le(words)) });
  }
  let lookup = '';
  for (const e of entries) lookup += `cmp r0,#${e.id};` + addr('ip', e.address) + 'moveq r0,ip;bxeq lr;';
  const get = p.emit(lookup + 'mov r0,#0;bx lr;');
  // The native code at 0x53726698 divides s15 by the crop magnification; the other branch writes
  // it directly. Both contracts are kept.
  let code = `push {r0-r3,ip,lr};bl #${get};cmp r0,#0;vldrne s15,[r0];pop {r0-r3,ip,lr};beq old;cmp r8,#0;bne #0x537266A4;b #0x53726698;old:cmp r0,#1;b #0x537266EC;`;
  p.hook(0x537266e8, code);
  // r8 / sb are the source dimensions: exact known sizes first, then fit the ratio for anything else.
  code = `push {r0,r4-r7,r10,ip,lr};mov r0,r3;bl #${get};cmp r0,#0;beq old;mov r4,r0;mov r5,r8;mov r6,sb;`;
  code += 'cmp r8,#720;cmpeq sb,#480;ldreq r5,[r4,#4];ldreq r6,[r4,#8];beq crop;cmp r8,#160;cmpeq sb,#120;ldreq r5,[r4,#20];ldreq r6,[r4,#24];beq crop;';
  code += 'ldr r0,[r4,#4];ldr r1,[r4,#8];cmp r8,r0;cmpeq sb,r1;beq crop;ldr r0,[r4,#20];ldr r1,[r4,#24];cmp r8,r0;cmpeq sb,r1;beq crop;';
  code += 'ldr r7,[r4,#12];ldr r10,[r4,#16];dimension:ldrh r0,[r7];ldrh r1,[r7,#2];cmp r8,r0;cmpeq sb,r1;ldrheq r5,[r7,#4];ldrheq r6,[r7,#6];beq crop;ldrh r0,[r7,#4];ldrh r1,[r7,#6];cmp r8,r0;cmpeq sb,r1;beq crop;add r7,r7,#8;subs r10,r10,#1;bne dimension;';
  code += 'ldr r1,[r4,#4];ldr r2,[r4,#8];mul r0,r8,r2;mul r3,sb,r1;cmp r0,r3;blo width;mov r0,r8;mov r7,r1;mov r1,r2;mov r2,r7;';
  code += `bl #${scale};add r0,r0,#2;bic r6,r0,#3;b crop;width:mov r0,sb;bl #${scale};add r0,r0,#2;bic r5,r0,#3;`;
  code += 'crop:sub r1,r8,r5;sub r2,sb,r6;mov r1,r1,lsr#1;mov r2,r2,lsr#1;mov r3,r5;mov lr,r6;pop {r0,r4-r7,r10,ip};add sp,sp,#4;b #0x53726dc0;old:pop {r0,r4-r7,r10,ip,lr};cmp r3,#2;b #0x53726ec0;';
  p.hook(0x53726ebc, code);
}

// --------------------------------------------------------------------------------------------
// crop_raw.py

/** In-camera RAW development codes of the factory ratios (identity -> code). */
const FACTORY_CODES: Readonly<Record<number, number>> = { 0: 2, 1: 3, 2: 1, 3: 4 };

class Program16 {
  constructor(readonly patch: Patch) {}

  emit(source: string): number {
    const at = this.patch.next(16);
    if (this.patch.append(wordsToBytes(assembleWords(source, at)), 16) !== at) fail('internal', 'address changed while assembling');
    return at;
  }

  hook(site: number, source: string): number {
    const at = this.emit(source);
    this.patch.setWord(site, branchWord(site, at), 'RAW development / metering map consumer');
    return at;
  }
}

function installImageMap(patch: Patch, ratios: readonly RatioEntry[]): void {
  // {identity, x numerator, x denominator, y numerator, y denominator}
  const values = ratios.map((r) => [r.id, Number(r.geometry.planeX.n), Number(r.geometry.planeX.d), Number(r.geometry.planeY.n), Number(r.geometry.planeY.d)]);
  const table = patch.append(concat(values.map((v) => u32le(v))), 16);
  const origin = patch.next(16);
  const mod = linkNative('map', values.length, origin, { ratios: table });
  if (patch.append(mod.code, 16) !== origin) fail('internal', 'module address changed');
  const p = new Program16(patch);
  // The first native record has its own allocation and release; extend that allocation, not the
  // map object (one caller embeds the map in a larger structure).
  const firstBytes = 48 + values.length * VIEW_BYTES;
  p.hook(0x5389ec44, 'sub r0,r4,sl;cmp r0,#4;movne r0,#46;' + addr('ip', firstBytes) + 'moveq r0,ip;b #0x5389ec48;');
  const factory = p.emit('uxtb r0,r0;b #0x538F81C0;');
  p.hook(0x538f81bc, `uxtb r0,r0;push {r0-r3,ip,lr};bl #${mod.symbols.crop_identity};cmp r0,#0;bne custom;pop {r0-r3,ip,lr};b #${factory};custom:add sp,sp,#4;pop {r1-r3,ip,lr};bx lr;`);
  interface Options { normalize?: number | 'stack'; index?: number; factor?: number; post?: string; bias?: boolean }
  const wrapper = (site: number, mapExpr: string, idExpr: string, dest: number, o: Options = {}): void => {
    // Keeps r0-r12, lr and the caller's flags. The 16-byte frame holds the saved APSR, the
    // original map and the identity; only the displaced instruction's destination / index change.
    let body = `push {r0-r12,lr};mrs ip,apsr;sub sp,sp,#16;str ip,[sp];${mapExpr}str r0,[sp,#4];${idExpr}str r1,[sp,#8];bl #${mod.symbols.crop_make_view};ldr ip,[sp,#4];cmp r0,ip;`;
    if (o.bias) body += 'ldrne ip,[sp,#8];subne r0,r0,ip,lsl #2;subne r0,r0,ip,lsl #3;';
    body += `str r0,[sp,#${16 + dest * 4}];`;
    if (o.normalize !== undefined) body += 'movne ip,#0;' + (o.normalize === 'stack' ? 'strne ip,[fp,#-0x48];' : `strne ip,[sp,#${16 + o.normalize * 4}];`);
    if (o.index !== undefined) {
      body += `ldrne ip,[sp,#8];ldrne r0,[sp,#${16 + o.index * 4}];`;
      body += (o.factor ?? 3) === 3 ? 'subne r0,r0,ip;subne r0,r0,ip,lsl #1;' : 'subne r0,r0,ip,lsl #2;subne r0,r0,ip,lsl #3;';
      body += `strne r0,[sp,#${16 + o.index * 4}];`;
    }
    body += `ldr ip,[sp];msr apsr_nzcvq,ip;add sp,sp,#16;pop {r0-r12,lr};${o.post ?? ''}b #${site + 4};`;
    p.hook(site, body);
  };
  wrapper(0x537215e0, 'ldr r0,[r3,#0xa50];', 'mov r1,r4;', 12, { normalize: 4 });
  wrapper(0x537238b4, 'ldr r0,[r4,#0xa50];', 'mov r1,r8;', 12, { normalize: 8 });
  wrapper(0x53723e58, 'ldr r0,[r3,#0xa50];', 'mov r1,sl;', 3, { index: 0 });
  wrapper(0x5372adfc, 'ldr r0,[r4,#0xa1c];', 'ldr r1,[r2,#0x34];ldrb r1,[r1,#0x7da];', 3, { bias: true });
  wrapper(0x5372aeb8, 'ldr r0,[r4,#0xa1c];', 'mov r1,r7;', 2, { normalize: 7 });
  wrapper(0x5372ec44, 'ldr r0,[r4,#0xa1c];', 'ldr r1,[r4,#0xa10];ldr r1,[r1,#0x34];ldrb r1,[r1,#0x7da];', 5, { normalize: 'stack' });
  wrapper(0x5372ef3c, 'ldr r0,[sb,#0xa1c];', 'ldr r1,[sb,#0xa10];ldr r1,[r1,#0x34];ldrb r1,[r1,#0x7da];', 12, { normalize: 4 });
  wrapper(0x53731f8c, 'mov r0,r7;', 'ldr r1,[r5,#0x34];ldrb r1,[r1,#0x7da];', 7, { index: 0, post: 'add r7,r7,r0,lsl #2;' });
  wrapper(0x537320c8, 'mov r0,r5;', 'ldr r1,[r4,#0x34];ldrb r1,[r1,#0x7da];', 5, { index: 0, post: 'add r5,r5,r0,lsl #2;' });
  wrapper(0x5374f734, 'mov r0,r7;', 'mov r1,r8;', 7, { index: 3, post: 'add r3,r7,r3,lsl #2;' });
  // Run the native deep clone, then rebuild the appended views for the destination.
  const clone = p.emit('mov ip,sp;b #0x5389F5B0;');
  p.hook(0x5389f5ac, `push {r0-r3,ip,lr};bl #${clone};pop {r0-r3,ip,lr};push {r0-r3,ip,lr};bl #${mod.symbols.crop_clone_tail};pop {r0-r3,ip,lr};bx lr;`);
}

function installRaw(patch: Patch, ratios: readonly RatioEntry[]): void {
  const active = [...FACTORY_ORDER, ...ratios.map((r) => r.id)];
  // Codes are transient bytes of the RAW development screen: 0 = unchanged, factory 1..4, added 5...
  const forward = new Uint8Array(256);
  const reverse = new Uint8Array(256);
  for (const k of Object.keys(FACTORY_CODES)) {
    const id = Number(k);
    forward[id] = FACTORY_CODES[id];
    reverse[FACTORY_CODES[id]] = id;
  }
  ratios.forEach((r, i) => {
    forward[r.id] = 5 + i;
    reverse[5 + i] = r.id;
  });
  const dimensions = new Map<number, readonly number[]>();
  for (const f of FACTORY) dimensions.set(f.id, f.full);
  for (const r of ratios) {
    const row = r.geometry.dims.find((d) => d[0] === FACTORY[0].full[0] && d[1] === FACTORY[0].full[1]);
    if (!row) fail('internal', 'no full-size entry');
    dimensions.set(r.id, [row[2], row[3]]);
  }
  // A RAW can be re-cut to every ratio that fits inside the one it was shot with.
  const rows = new Map<number, number[]>();
  for (const [src, [w, h]] of dimensions) rows.set(src, active.filter((t) => dimensions.get(t)![0] <= w && dimensions.get(t)![1] <= h).map((t) => forward[t]));
  const expected: Record<number, number[]> = { 0: [2, 3, 4, 1], 1: [3, 4], 2: [1], 3: [4] };
  for (const k of Object.keys(expected)) {
    const got = rows.get(Number(k))!.filter((n) => n < 5);
    if (got.join() !== expected[Number(k)].join()) fail('internal', 'factory RAW targets changed');
  }
  const packets: number[] = [];
  const offsets: number[] = [];
  for (let src = 0; src < 256; src++) {
    offsets.push(packets.length);
    const v = rows.get(src) ?? [];
    packets.push(v.length, ...v);
  }
  const data = patch.append(Uint8Array.from(packets), 16);
  const table = patch.append(u32le(offsets.map((o) => data + o)), 16);
  const maps = patch.append(concat([forward, reverse]), 16);
  const p = new Program16(patch);
  p.hook(0x53379b38, 'ldr r3,[r0,#0x24];ldrb r3,[r3,#0x7da];' + addr('r2', table) + 'ldr r2,[r2,r3,lsl #2];ldrb r1,[r0,#5];ldrb r0,[r2];cmp r1,#0;addne r0,r0,#1;uxtb r0,r0;bx lr;');
  p.hook(0x53379c94, 'ldrb r3,[r0,#5];cmp r3,#0;beq source;cmp r1,#0;moveq r0,#0;bxeq lr;sub r1,r1,#1;uxtb r1,r1;source:ldr r3,[r0,#0x24];ldrb r3,[r3,#0x7da];' + addr('r2', table) + 'ldr r2,[r2,r3,lsl #2];ldrb r3,[r2];cmp r1,r3;movhs r0,#0;bxhs lr;add r2,r2,#1;ldrb r0,[r2,r1];bx lr;');
  p.hook(0x5337bc70, 'ldr r3,[r0,#0x24];ldrb r3,[r3,#0x7da];' + addr('r2', table) + 'ldr r2,[r2,r3,lsl #2];ldrb r3,[r2],#1;loop:cmp r3,#0;moveq r0,#0;bxeq lr;ldrb r0,[r2],#1;cmp r0,r1;moveq r0,#1;bxeq lr;sub r3,r3,#1;b loop;');
  p.hook(0x53374d20, 'uxtb r1,r1;' + addr('r2', maps) + 'ldrb r0,[r2,r1];bx lr;');
  p.hook(0x53383b68, 'cmp r1,#0;ldreq r3,[r0,#0x24];ldrbeq r0,[r3,#0x7da];bxeq lr;uxtb r1,r1;' + addr('r2', maps + 256) + 'ldrb r0,[r2,r1];bx lr;');
  installImageMap(patch, ratios);
}

// --------------------------------------------------------------------------------------------
// crop_state.py

function installState(patch: Patch, ratios: readonly RatioEntry[], activeBitmap: number): void {
  const priorSave = branchTarget(0x533f3674, patch.word(0x533f3674));
  const priorLoad = branchTarget(0x533f3254, patch.word(0x533f3254));
  expectWord(patch, 0x532adedc, 0xebfe49f0); // bl 0x532406a4
  expectWord(patch, 0x5381d6bc, 0xe1a0c00d);
  // {identity, magnification (float bits), rectangle[4]} for the photo-info display.
  const rects: Uint8Array[] = [];
  for (const r of ratios) {
    sourceRectangles(r.geometry).forEach((rect, m) => rects.push(u32le([r.id, MAG_BITS[m], ...rect])));
  }
  const table = patch.append(concat(rects), 16);
  const origin = patch.next(16);
  const mod = linkNative('state', rects.length, origin, {
    crop_active_bitmap: activeBitmap, crop_source_rectangles: table, prior_native_save: priorSave, prior_native_load: priorLoad,
    factory_source_rectangle_body: 0x5381d6c0,
  });
  if (patch.append(mod.code, 16) !== origin) fail('internal', 'module address changed');
  patch.setWord(0x533f3674, branchWord(0x533f3674, mod.symbols.crop_state_save), 'settings save: reset a ratio that is no longer in the menu');
  patch.setWord(0x533f3254, branchWord(0x533f3254, mod.symbols.crop_state_load), 'settings load: reset a ratio that is no longer in the menu');
  const site = 0x532adedc;
  const stub = patch.append((at) => [0xe92d500f, 0xe1a00004, branchWord(at + 8, mod.symbols.crop_normalize_userdata, 14, true), 0xe8bd500f, branchWord(at + 16, 0x532406a4)], 16);
  patch.setWord(site, branchWord(site, stub, 14, true), 'user-mode recall: reset a ratio that is no longer in the menu');
  patch.setWord(0x5381d6bc, branchWord(0x5381d6bc, mod.symbols.crop_metadata_rectangle), 'photo-info rectangle of an added ratio');
}

// --------------------------------------------------------------------------------------------
// crop_image_identity.py

const GATES = [
  [0x5381c380, 0xe3500003, 'crop_image_extract_gate'],
  [0x53833dfc, 0xe3530003, 'crop_image_set_gate'],
  [0x536db01c, 0xe35a0003, 'crop_image_playback_gate'],
  [0x536ec1b0, 0xe3500003, 'crop_image_aspect_gate'],
] as const;
const NATIVE_JOINS: Readonly<Record<string, number>> = {
  native_extract_table: 0x5381c384, native_extract_unknown: 0x5381c388, native_extract_return: 0x5381c3a8,
  native_set_table: 0x53833e00, native_set_unknown: 0x53833e04, native_set_join: 0x53833e1c,
  native_playback_table: 0x536db020, native_playback_unknown: 0x536db024, native_playback_join: 0x536db03c,
  native_aspect_table: 0x536ec1b4, native_aspect_unknown: 0x536ec1b8, native_aspect_return: 0x536ec1d0,
  native_screen_rect_body: 0x536f2090, native_thumbnail_rect_body: 0x536f2284,
};

function installImageIdentity(patch: Patch, ratios: readonly RatioEntry[]): void {
  for (const [site, native] of GATES) expectWord(patch, site, native);
  expectWord(patch, 0x536f1c14, branchWord(0x536f1c14, 0x536ec19c, 14, true));
  expectWord(patch, 0x536f208c, 0xe1a0c00d);
  expectWord(patch, 0x536f2280, 0xe1a0c00d);
  const known = new Set(ratios.map((r) => r.id));
  const archive = patch.append(Uint8Array.from({ length: 256 }, (_, n) => (known.has(n) ? 1 : 0)), 16);
  const rectangles = playbackRectangles(ratios.map((r) => r.geometry));
  const table = patch.append(concat(rectangles.map((r) => u32le([...r.size, ...r.rects]))), 16);
  const origin = patch.next(16);
  const mod = linkNative('identity', rectangles.length, origin, { crop_image_archive: archive, crop_image_rectangles: table, ...NATIVE_JOINS });
  if (patch.append(mod.code, 16) !== origin) fail('internal', 'module address changed');
  for (const [site, , symbol] of GATES) patch.setWord(site, branchWord(site, mod.symbols[symbol]), 'keep the ratio identity of a photo through read / write / playback');
  // The caller has the photo's metadata in r7; its size classification must not replace a known
  // added identity by the nearest factory ratio.
  const context = patch.append((at) => [0xe1a01007, branchWord(at + 4, mod.symbols.crop_image_source_aspect)], 16);
  patch.setWord(0x536f1c14, branchWord(0x536f1c14, context, 14, true), 'playback: keep the identity stored in the photo');
  for (const [site, helper] of [[0x536f208c, 'crop_image_screen_rect'], [0x536f2280, 'crop_image_thumbnail_rect']] as const) {
    patch.setWord(site, branchWord(site, mod.symbols[helper]), 'playback rectangle by exact photo size');
  }
}

// --------------------------------------------------------------------------------------------
// Not in the reference: magnifying a photo whose height is not a multiple of 8.
//
// To magnify a photo in playback the camera decodes the whole JPEG. ImageMemory::Alloc
// (0x536c33d0) sizes that buffer for align16(width) x height rows, while the decoder
// (PlaybackStillProcess DecodeJpeg, 0x536e35a0, after the stride rule at 0x536e2a9c) needs
// align16(width) x align8(height) for a 4:2:2 picture; when the buffer is smaller it gives up
// with result 3 before decoding ("allocBufferSize(%d) < calcBufferSize(%d)"), and the playback
// screen (0x53195cf8 acts on results 0 and 1 only) is left in its "magnifying" state with
// nothing magnified. Every factory size has a height that is a multiple of 8, so the official
// firmware never meets this; the sizes of added ratios are multiples of 4 (65:24 M: 4944 x 1812).
//
// The one call that works out the byte count of an ImageMemory allocation is redirected: the
// count is taken for the height rounded up to 8. Width, height and stride of the picture are not
// touched, and for a height that is already a multiple of 8 the count is the same as before.

const ALLOC_SIZE_CALL = 0x536c3460;
const CALC_IMAGE_BUFFER_SIZE = 0x536bb214;

function installPlaybackDecode(patch: Patch): void {
  // mov r1, sb (format) / mov r0, r8 (&stride size {width16, height}) / bl CalcImageBufferSize / mov r1, r0
  expectWord(patch, ALLOC_SIZE_CALL - 8, 0xe1a01009);
  expectWord(patch, ALLOC_SIZE_CALL - 4, 0xe1a00008);
  expectWord(patch, ALLOC_SIZE_CALL, branchWord(ALLOC_SIZE_CALL, CALC_IMAGE_BUFFER_SIZE, 14, true));
  expectWord(patch, ALLOC_SIZE_CALL + 4, 0xe1a01000);
  const stub = patch.append((at) => assembleWords(
    `push {r4, lr}; sub sp, sp, #8
     ldr r2, [r0]; ldr r3, [r0, #4]
     add r3, r3, #7; bic r3, r3, #7
     str r2, [sp]; str r3, [sp, #4]
     mov r0, sp; bl #${CALC_IMAGE_BUFFER_SIZE}
     add sp, sp, #8; pop {r4, pc}`, at), 16);
  patch.setWord(ALLOC_SIZE_CALL, branchWord(ALLOC_SIZE_CALL, stub, 14, true), 'playback: decode buffer rows rounded up to 8');
}

// --------------------------------------------------------------------------------------------

export function validateRatioName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (name.length > MAX_NAME_LENGTH) return 'too-long';
  // Printable ASCII only: every language's font in the camera has these glyphs.
  if (!/^[\x20-\x7e]+$/.test(name) || name !== name.trim()) return 'bad-char';
  return null;
}

/** Validate a list of ratios and work out their identities, geometry and icons. Throws on any problem. */
export function planRatios(specs: readonly RatioSpec[], options: { portrait?: boolean } = {}): RatioEntry[] {
  if (!Array.isArray(specs)) fail('bad-ratio', 'the ratio list must be an array');
  if (specs.length > MAX_CUSTOM_RATIOS) fail('too-many-ratios', `at most ${MAX_CUSTOM_RATIOS} ratios can be added`);
  const out: RatioEntry[] = [];
  specs.forEach((s, i) => {
    const problem = validateRatioName(s.name);
    if (problem) fail('bad-name', `ratio ${i + 1}: name is ${problem}`);
    const geometry = planRatio(s.ratio, options);
    out.push({ name: s.name, ratio: s.ratio, id: FIRST_CUSTOM_ID + i, geometry, icon: drawRatioIcon(s.ratio) });
  });
  playbackRectangles(out.map((r) => r.geometry)); // throws on conflicting photo sizes
  return out;
}

/**
 * Install `ratios` (from `planRatios`) into an RTOS image of official length and append their icons
 * to the ICONBIN data. Neither input is modified. `revision` 1 gives exactly what the reference
 * builds (and what GR Mod 0.2.x wrote).
 */
export function installRatios(rtos: Uint8Array, iconbin: Uint8Array, ratios: readonly RatioEntry[], revision: BuildRevision = BUILD_REVISION): AspectResult {
  if (!(ratios.length >= 1 && ratios.length <= MAX_CUSTOM_RATIOS)) fail('too-many-ratios', `1 to ${MAX_CUSTOM_RATIOS} ratios can be added`);
  if (revision === 3) fail('internal', 'revision 3 is built with installExtensions');
  return installExtensions(rtos, iconbin, ratios, {}, revision);
}

/**
 * Everything this program appends to the RTOS image: the scaffold (relocated icon and text
 * catalogs), then the added ratios (if any), then the other additions in `features`. With no
 * features this is `installRatios`, byte for byte. With features the revision is 3.
 */
export function installExtensions(rtos: Uint8Array, iconbin: Uint8Array, ratios: readonly RatioEntry[], features: ExtensionFeatures, revision: BuildRevision = BUILD_REVISION, test: TestOptions = {}): AspectResult {
  const slots = features.extraSlots ?? [];
  const shutdown = features.shutdown && features.shutdown.pictures.length > 0 ? features.shutdown : undefined;
  const cinema = (['CY', 'CG'] as const).filter((id) => features.cinemaHalation?.[id] === true);
  const extra = !!features.adjSoftFocus || !!features.dateStamp || !!features.monoUnlock || slots.length > 0 || !!shutdown || !!features.guard || cinema.length > 0 || !!features.directFlash;
  if (extra) revision = 3;
  if (revision !== 1 && revision !== 2 && revision !== 3) fail('internal', 'unknown build revision');
  if (rtos.length !== OFFICIAL_RTOS_LENGTH || iconbin.length !== OFFICIAL_ICONBIN_LENGTH) fail('unexpected-layout', 'RTOS or ICONBIN does not have the official length');
  if (ratios.length > MAX_CUSTOM_RATIOS) fail('too-many-ratios', `at most ${MAX_CUSTOM_RATIOS} ratios can be added`);
  if (ratios.length === 0 && !extra) fail('internal', 'nothing to install');
  ratios.forEach((r, i) => {
    if (r.id !== FIRST_CUSTOM_ID + i) fail('internal', 'ratio identities must be consecutive');
  });
  const patch = new Patch(rtos);
  const ramCopy = new DataView(patch.read(BASE + 0x450, 12).buffer);
  if (ramCopy.getUint32(0, true) !== RAM.source || ramCopy.getUint32(4, true) !== RAM.destination || ramCopy.getUint32(8, true) !== RAM.length) {
    fail('unexpected-layout', 'start-up data copy is not where it was expected');
  }
  initializeScaffold(patch);
  let icons = iconbin;
  if (ratios.length > 0) {
    const installed = installIcons(patch, iconbin, ratios);
    icons = installed.iconbin;
    const menu = installMenu(patch, ratios, installed.ids);
    const { p, scale } = buildGeometry(patch, ratios);
    installDevelop(p, scale, ratios);
    installRaw(patch, ratios);
    installState(patch, ratios, menu.activeBitmap);
    installImageIdentity(patch, ratios);
    if (revision >= 2) installPlaybackDecode(patch);
  }
  if (features.adjSoftFocus) icons = installAdjSoftFocus(patch, icons);
  // Before the date imprint's menu, which copies the list table with Flash Mode's records.
  if (features.directFlash) icons = installDirectFlash(patch, icons, !!test.directFlashDiag);
  if (features.monoUnlock) installMonoUnlock(patch);
  if (features.dateStamp) {
    const fixed = test.dateStampFixed;
    // From 0.8.2 (builds with the guard) the imprint goes by the picture's look.
    const look = features.guard ? { stash: LOOK_STASH, monoLooks: monoTable(patch, slots.map((x) => monoLook(x.matrixQ13, x.curves, x.postQ9)), FIRST_ADDED_LOOK), names: lookNames(patch, slots.map((x) => x.name)) } : undefined;
    installDateStamp(patch, fixed ? patch.append([fixed, 0, 0, 0], 4) : DATESTAMP_BYTE, test.directFlashDiag && features.directFlash ? 'df' : !!test.dateStampDiag, look);
    if (!fixed) icons = installDateStampMenu(patch, icons);
    if (look && slots.length === 0) installLookStash(patch);
  }
  // Halation: added slots that have it, Cinema slots with a preset that are asked to.
  const halation: HalationLook[] = [];
  slots.forEach((x, k) => {
    if (x.halation === true) halation.push({ style: FIRST_ADDED_LOOK + k, light: halationLight(x.curves, x.postQ9) });
  });
  for (const id of cinema) {
    const style = CINEMA_STYLES[id];
    // The engine asks for it only with a preset (curves of its own: Toning does nothing then). The
    // check of a built file installs this on the official image too, to find the hook places.
    const colour = styleColour(patch, style);
    halation.push({ style, light: colour.ownCurves ? halationLight(colour.curves, colour.postQ9) : halationLight() });
  }
  // Last: the added slots compose with the monochrome looks' visibility check.
  if (slots.length > 0) icons = installExtraSlots(patch, icons, slots, { stashLook: (!!features.dateStamp && !!features.guard) || halation.length > 0, layout: features.lookLayout });
  else if (features.lookLayout) {
    validateLookLayout(features.lookLayout, 0);
    installLookOrder(patch, features.lookLayout.order);
    installFactoryHidden(patch, features.lookLayout.hidden);
  }
  if (halation.length > 0) icons = installHalation(patch, icons, halation);
  if (shutdown) icons = installShutdownMenu(patch, icons, shutdown.pictures, shutdown.factory);
  // After every other addition that copies the submenu or list table.
  if (features.directFlash) icons = installDirectFlashMenu(patch, icons);
  // Last: wraps every other settings save/load and user-mode recall hook.
  if (features.guard) installSettingsGuard(patch, { slots: slots.length, ratios: ratios.length > 0, adjSoftFocus: !!features.adjSoftFocus, ...(features.lookLayout ? { hiddenLooks: features.lookLayout.hidden } : {}) });
  if (patch.length % 4 !== 0) fail('internal', 'image length is not a multiple of 4');
  if (BASE + patch.length >= APPEND_LIMIT) fail('too-many-ratios', 'the appended area would reach the RAM area');
  return { revision, rtos: patch.bytes(), iconbin: icons, ratios: [...ratios], words: patch.words, features: { adjSoftFocus: !!features.adjSoftFocus, ...(features.dateStamp ? { dateStamp: true } : {}), ...(features.monoUnlock ? { monoUnlock: true } : {}), ...(slots.length > 0 ? { extraSlots: [...slots] } : {}), ...(shutdown ? { shutdown } : {}), ...(features.guard ? { guard: true } : {}), ...(cinema.length > 0 ? { cinemaHalation: Object.fromEntries(cinema.map((id) => [id, true])) } : {}), ...(features.lookLayout ? { lookLayout: features.lookLayout } : {}), ...(features.directFlash ? { directFlash: true } : {}) } };
}
