// SPDX-License-Identifier: GPL-2.0-only
/**
 * Image Control menu order and hidden looks (route B: change the 22-byte order table and redirect
 * the per-look visibility jump-table entries to the firmware's existing "return 0" stubs).
 *
 * Firmware 1.20: the order table is VA 0x53DE8CD0, one byte per Image Control style: 11..30 as in
 * 1.11 and, before 30, the two looks 1.20 added for the GR IV Monochrome, 31 (Pictorialist, offered
 * on no model in 1.20) and 32 (Solarized, the Monochrome only). Two consumers read it: 0x533840FC
 * (ADJ / RAW development lists) and 0x533DE1F0 (the Image Control menu). The menu builder walks the
 * table in order, calls the visibility function 0x533DE144 for each style and skips the hidden
 * ones, so the 22-entry capacity and every count constant stay unchanged.
 *
 * Style 11..24 use the jump table at 0x533DE15C (4 bytes per entry); redirecting an entry to
 * 0x533DE1AC (mov r0, #0 ; bx lr) hides it. Style 25..32 (the monochrome looks) use 0x533DE080 and
 * the stub 0x533DE0B0. Both mechanisms are the ones GR4-MonoUnlock / GR Mod already use for the
 * monochrome looks; the order table was verified on a camera (1.11).
 */
import { Patch, expectWord, u32le } from './build';
import { FirmwareError } from '../../types';
import type { Range } from '../../types';
import { foff } from '../profile';

export const FACTORY_LOOK_IDS: readonly number[] = [
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
];
/** First style number of an added Image Control slot (38..57; 1.11: 34..53). */
export const EXTRA_LOOK_FIRST = 38;
export const ORDER_TABLE = 0x53DE8CD0;
export const ORDER_COUNT = 22;
export const COLOR_VIS_TABLE = 0x533DE15C;
export const COLOR_VISIBLE = 0x533DE194;
export const COLOR_CONDITIONAL = 0x533DE19C;
export const COLOR_HIDDEN = 0x533DE1AC;
export const MONO_VIS_TABLE = 0x533DE080;
export const MONO_HIDDEN = 0x533DE0B0;

export interface LookLayout {
  /** Style IDs in menu order: a permutation of 11..32 and, when added slots are installed, 38..38+n-1. */
  order: readonly number[];
  /** Style IDs hidden from the lists. Factory looks and added slots are both allowed. */
  hidden: readonly number[];
}

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

function expectedIds(extraCount: number): number[] {
  const out = [...FACTORY_LOOK_IDS];
  for (let i = 0; i < extraCount; i++) out.push(EXTRA_LOOK_FIRST + i);
  return out;
}

export function validateLookLayout(layout: LookLayout, extraCount: number): void {
  if (!layout || !Array.isArray(layout.order) || !Array.isArray(layout.hidden)) fail('bad-look-layout', 'look order and hidden list are required');
  const expected = expectedIds(extraCount);
  if (layout.order.length !== expected.length) fail('bad-look-layout', `look order must contain ${expected.length} entries`);
  const seen = new Set<number>();
  for (const id of layout.order) {
    if (!expected.includes(id)) fail('bad-look-layout', `look order contains style ${id}, which this build cannot show`);
    if (seen.has(id)) fail('bad-look-layout', `look order contains style ${id} twice`);
    seen.add(id);
  }
  for (const id of expected) if (!seen.has(id)) fail('bad-look-layout', `look order is missing style ${id}`);
  for (const id of layout.hidden) {
    if (!expected.includes(id)) fail('bad-look-layout', `hidden list contains style ${id}, which this build cannot show`);
  }
  if (new Set(layout.hidden).size !== layout.hidden.length) fail('bad-look-layout', 'hidden list contains a style twice');
  if (layout.hidden.length >= expected.length) fail('bad-look-layout', 'at least one look must stay visible');
  if (layout.hidden.includes(11)) fail('bad-look-layout', 'Standard (style 11) must stay visible');
  // The settings guard turns a hidden look selected in the settings into Standard: 11, or 25 (the
  // GR IV Monochrome's Standard) for its looks 25..32 (`guard.ts`).
  if (layout.hidden.includes(25)) fail('bad-look-layout', 'Standard of the monochrome looks (style 25) must stay visible');
}

/** Write the order table through `setWord`, so a grown build records the changed words. */
export function installLookOrder(patch: Patch, order: readonly number[]): void {
  for (let i = 0; i < order.length; i += 4) {
    const word = (order[i] | ((order[i + 1] ?? 0) << 8) | ((order[i + 2] ?? 0) << 16) | ((order[i + 3] ?? 0) << 24)) >>> 0;
    patch.setWord(ORDER_TABLE + i, word, 'look order');
  }
}

/** Hide factory looks by redirecting their visibility jump-table entry to the "return 0" stub. */
export function installFactoryHidden(patch: Patch, hidden: readonly number[]): void {
  for (const style of hidden) {
    if (style >= EXTRA_LOOK_FIRST) continue; // added slots are hidden in the visibility hook of slots.ts
    if (style >= 11 && style <= 24) {
      const at = COLOR_VIS_TABLE + (style - 11) * 4;
      const word = patch.word(at);
      if (word !== COLOR_VISIBLE && word !== COLOR_CONDITIONAL) fail('unexpected-layout', `look ${style} visibility entry is not the official one`);
      patch.setWord(at, COLOR_HIDDEN, `hide look ${style}`);
    } else if (style >= 25 && style <= 32) {
      const at = MONO_VIS_TABLE + (style - 25) * 4;
      const word = patch.word(at);
      if (word === MONO_HIDDEN) continue;
      patch.setWord(at, MONO_HIDDEN, `hide look ${style}`);
    } else {
      fail('bad-look-layout', `style ${style} is not a factory look`);
    }
  }
}

/**
 * In-place build (official layout): the order bytes and the visibility words as payload offsets.
 * Used by `buildFirmware` when nothing grows, so a build with only order/hide changes stays the
 * official 1.20 layout.
 */
export function lookLayoutWords(official: Uint8Array, layout: LookLayout): { offset: number; bytes: Uint8Array; what: string }[] {
  validateLookLayout(layout, 0);
  const out: { offset: number; bytes: Uint8Array; what: string }[] = [];
  const orderOff = foff(ORDER_TABLE);
  const old = official.slice(orderOff, orderOff + ORDER_COUNT);
  const next = Uint8Array.from(layout.order);
  if (old.some((v, i) => v !== next[i])) out.push({ offset: orderOff, bytes: next, what: 'look order' });
  for (const style of layout.hidden) {
    if (style >= 11 && style <= 24) {
      const at = COLOR_VIS_TABLE + (style - 11) * 4;
      const off = foff(at);
      const word = official[off] | (official[off + 1] << 8) | (official[off + 2] << 16) | (official[off + 3] << 24);
      if (word !== COLOR_VISIBLE && word !== COLOR_CONDITIONAL) fail('unexpected-layout', `look ${style} visibility entry is not the official one`);
      out.push({ offset: off, bytes: u32le([COLOR_HIDDEN]), what: `hide look ${style}` });
    } else if (style >= 25 && style <= 32) {
      const off = foff(MONO_VIS_TABLE + (style - 25) * 4);
      const word = official[off] | (official[off + 1] << 8) | (official[off + 2] << 16) | (official[off + 3] << 24);
      if ((word >>> 0) === MONO_HIDDEN) continue; // already hidden natively (31, Pictorialist, has no visible entry)
      out.push({ offset: off, bytes: u32le([MONO_HIDDEN]), what: `hide look ${style}` });
    } else {
      fail('bad-look-layout', `style ${style} is not a factory look`);
    }
  }
  out.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    if (a.offset + a.bytes.length > out[i].offset) fail('assert-failed', 'look layout changes overlap');
  }
  return out;
}

/**
 * A layout written for 1.11's numbering (the factory looks 11..30, added slots 34..), as the
 * app keeps it, in this firmware's: added slot 34 + k becomes 38 + k, and 31 / 32, which 1.20 added
 * (hidden on the colour models), are put before 30 as in the official order when they are missing.
 * A layout already in 1.20's numbering is returned as it is.
 */
export function layoutFrom111(layout: LookLayout): LookLayout {
  const has120 = layout.order.includes(31) || layout.order.includes(32) || layout.order.some((id) => id >= EXTRA_LOOK_FIRST);
  if (has120) return layout;
  const map = (id: number): number => (id >= 34 ? id - 34 + EXTRA_LOOK_FIRST : id);
  const order = layout.order.map(map);
  const at = order.indexOf(30);
  order.splice(at < 0 ? order.length : at, 0, 31, 32);
  return { order, hidden: layout.hidden.map(map) };
}
