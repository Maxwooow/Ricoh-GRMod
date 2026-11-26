// SPDX-License-Identifier: GPL-2.0-only
/**
 * Halation for every look (option halationAll, GR IV 1.20 / 1.21): every Image Control look, the
 * camera's own and the added ones, gets the Halation row on its parameter screens (shooting and RAW
 * development) and the halation of the JPEG step (`halation.ts`); without the option no look has it.
 *
 * The parameter screens build their list from a table per photo set (0..3) and look group (the
 * style's "detail kind", 0x531C80B0: style 11..32 -> 0..21): {pairs of (flag, row kind), count}
 * (shooting, 0x53DC4B3C) and {row kinds, count} (RAW development, 0x53DC487C). Row kind 8 is Cinema's
 * Toning, which `halation-ui.ts` turns into Halation for the looks of its table; the looks without it
 * get a kind 8 row here, before Shading / Clarity / Grain (kinds 14..17). A row's flag says where it
 * is shown (0x531CB5D4: 0 stills only, 1 movies only, 2 both): halation is a still-picture effect, so
 * every kind 8 row, Cinema's own included, is a stills row.
 *
 * Where the setting lives: Cinema Yellow and Green have Toning fields of their own in the settings,
 * the added looks Cinema Yellow's (slots.ts); the other factory looks keep it in the slot-parameters
 * module (slot_params.c with SP_EXT, `sp_hal_now` / `sp_hal_ui`), per photo set. RAW development keeps
 * 19 parameter bytes for every look; its setter writes parameter 8 only for the looks a table
 * (0x53DE61C0, 19 bytes per look) allows, which here is every look.
 *
 * Black-and-white looks (`lookstash.ts` MONO_LOOKS, and added slots whose preset is grey) take the
 * white glow whatever colour is set: red light on a monochrome picture would be a coloured cast.
 */
import { FirmwareError } from '../../types';
import { Patch } from './build';
import { adr } from '../target';

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** Shooting: per photo set (4) and look group (22), {pointer to (flag, kind) pairs, u16 count}. */
const SHOOT_ROWS = adr(0x53dc4b3c);
/** RAW development: per base (4) and look group (22), {pointer to kinds, u8 count}. */
const RAW_ROWS = adr(0x53dc487c);
/** RAW development: which of the 19 parameters each look (0..22, 0 "as shot") has. */
const RAW_HAS = adr(0x53de61c0);
const SETS = 4;
const GROUPS = 22;
const RAW_LOOKS = 23;
const KIND_HALATION = 8;
/** Halation goes in front of the first of these (Shading, Clarity, Grain, the HDR look's own row). */
const LATER = new Set([14, 15, 16, 17]);

function insertAt(kinds: readonly number[]): number {
  const i = kinds.findIndex((k) => LATER.has(k));
  return i < 0 ? kinds.length : i;
}

/** Give every look the Halation row on the parameter screens (shooting and RAW development). */
export function installHalationRows(p: Patch): void {
  // Shooting.
  const shoot = new Map<number, number>();
  for (let e = 0; e < SETS * GROUPS; e++) {
    const at = SHOOT_ROWS + e * 8;
    const ptr = p.word(at), count = p.word(at + 4) & 0xffff;
    if (!(count > 0 && count < 32)) fail('unexpected-layout', 'halation for every look: shooting row table');
    const pairs = Array.from(p.readMapped(ptr, count * 2));
    const kinds = pairs.filter((_, i) => i % 2 === 1);
    if (pairs.some((v, i) => i % 2 === 0 && v > 2) || kinds.some((k) => k > 19)) fail('unexpected-layout', 'halation for every look: shooting rows');
    const own = kinds.indexOf(KIND_HALATION);
    let moved = shoot.get(ptr);
    if (moved === undefined) {
      if (own >= 0) pairs[own * 2] = 0;
      else pairs.splice(insertAt(kinds) * 2, 0, 0, KIND_HALATION);
      moved = p.append(Uint8Array.from(pairs), 4);
      shoot.set(ptr, moved);
    }
    p.setWord(at, moved, 'halation for every look: the parameter rows (shooting)');
    p.setWord(at + 4, (p.word(at + 4) & 0xffff0000) | (own >= 0 ? count : count + 1), 'halation for every look: number of rows (shooting)');
  }
  // RAW development.
  const raw = new Map<number, number>();
  for (let e = 0; e < SETS * GROUPS; e++) {
    const at = RAW_ROWS + e * 8;
    const ptr = p.word(at), word1 = p.word(at + 4), count = word1 & 0xff;
    if (!(count > 0 && count < 32)) fail('unexpected-layout', 'halation for every look: RAW development row table');
    const kinds = Array.from(p.readMapped(ptr, count));
    if (kinds.some((k) => k > 19)) fail('unexpected-layout', 'halation for every look: RAW development rows');
    const has = kinds.includes(KIND_HALATION);
    let moved = raw.get(ptr);
    if (moved === undefined) {
      if (!has) kinds.splice(insertAt(kinds), 0, KIND_HALATION);
      moved = p.append(Uint8Array.from(kinds), 4);
      raw.set(ptr, moved);
    }
    p.setWord(at, moved, 'halation for every look: the parameter rows (RAW development)');
    p.setWord(at + 4, (word1 & 0xffffff00) | (has ? count : count + 1), 'halation for every look: number of rows (RAW development)');
  }
  // RAW development: every look may set parameter 8.
  for (let look = 1; look < RAW_LOOKS; look++) {
    const at = RAW_HAS + look * 19 + KIND_HALATION;
    const v = p.readMapped(at, 1)[0];
    if (v > 1) fail('unexpected-layout', 'halation for every look: RAW development parameter table');
    if (v === 0) {
      const w = at & ~3, shift = (at & 3) * 8;
      p.setWord(w, (p.word(w) | (1 << shift)) >>> 0, 'halation for every look: RAW development may set parameter 8');
    }
  }
}
