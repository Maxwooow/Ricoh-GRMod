// SPDX-License-Identifier: GPL-2.0-only
/**
 * The look of the picture being made, for the steps after development (halation, date imprint).
 *
 * The development step reads the frame's record at 0x539113F8 (`ldrb r2,[r3,#0x79C]`: the look,
 * then a dispatch on it for every look); its Toning setting is at +0x7A6. A hook there leaves
 * `look | toning << 8 | 0x10000` in one word, LOOK_STASH, before the JPEG step of the same picture
 * runs. The word is in the 44 bytes between the end of the start-up zero fill and the heap; the
 * zero fill is extended over them (see slots.ts).
 *
 * Black-and-white looks: Monotone, Soft Monotone, Hard Monotone, Hi-Contrast B&W (13..16; their
 * names through 0x5337F824) and the GR IV Monochrome's six (25..30; 1.20 adds 31 and 32, see
 * `TargetFacts.monoLooks`), plus any slot whose preset gives grey for every colour (equal matrix
 * rows, equal curves, equal rows of the post-curve matrix).
 *
 * Firmware 1.20: the same read of the look at the same offset (0x53939148); the word is 16 bytes
 * into its 44 unused bytes. Halation, which uses the Toning bits, is 1.11 only.
 */
import { assembleWords } from './arm';
import { Patch, expectWord } from './build';
import { T_GAM, T_REC } from '../profile';
import { TARGET_111 } from '../target';
import type { FirmwareTarget } from '../target';

/** The word the look is left in: 16 bytes into the 44 unused bytes before the heap. */
export function lookStash(t: FirmwareTarget): number {
  return t.facts.bssEnd + 0x10;
}
/** The word in 1.11 (0x558372E4). */
export const LOOK_STASH = lookStash(TARGET_111);
/** The development step's read of the look (the hook site). */
export const LOOK_SITE = 0x539113f8;
const LOOK_SITE_WORD = 0xe5d3279c; // ldrb r2, [r3, #0x79c]
/** Literal: end of the start-up zero fill; the 44 unused bytes up to the heap follow it. */
const ZERO_FILL_END = 0x53000460;
/** GR IV Monochrome check (1 on that model). */
export const MONO_MODEL = 0x533ef000;

/** The camera's own black-and-white looks (1.11). */
export const MONO_LOOKS = TARGET_111.facts.monoLooks;

/**
 * Store the look: keeps every register but the flags. r3 is the frame's record. Its Toning byte is
 * a halation look's encoded setting (halation-ui.ts, 0..11): it is left as the level (0 off,
 * 1 Weak, 2 Medium, 3 Strong) and STASH_WHITE for the white glow. 0, 1, 2 (Off, Weak and Strong red,
 * as up to test 042) stay Off, Weak, Strong.
 */
export function stashAsm(stash: number): string {
  return `push {r0,r1};ldrb r0,[r3,#0x79c];ldrb r1,[r3,#0x7a6];
  cmp r1,#7;movhs r1,#0;
  cmp r1,#4;subhs r1,r1,#3;orrhs r0,r0,#0x20000;bhs stashlevel;
  cmp r1,#3;moveq r1,#2;beq stashlevel;
  cmp r1,#2;moveq r1,#3;
  stashlevel:orr r0,r0,r1,lsl #8;orr r0,r0,#0x10000;movw r1,#${stash & 65535};movt r1,#${stash >>> 16};str r0,[r1];pop {r0,r1};`;
}
/** The store of 1.11 (the added slots' hook of the site, 1.11 only). */
export const STASH_ASM = stashAsm(LOOK_STASH);
/** The white glow's bit in the stash word. */
export const STASH_WHITE = 0x20000;

export function extendZeroFill(p: Patch): void {
  const { bssEnd, heap } = p.target.facts;
  const at = p.va(ZERO_FILL_END);
  if (p.word(at) === heap) return;
  expectWord(p, at, bssEnd);
  p.setWord(at, heap, 'start-up zero fill also clears the 44 unused bytes before the heap');
}

/** The hook on its own (no added slots: `slots.ts` puts the same code in its hook of the site). */
export function installLookStash(p: Patch): void {
  const site = p.va(LOOK_SITE);
  if (p.word(site) >>> 24 === 0xea) return; // already hooked here (an earlier call)
  expectWord(p, site, LOOK_SITE_WORD);
  const at = p.append((a) => assembleWords(`${stashAsm(lookStash(p.target))}ldrb r2,[r3,#0x79c];b #${site + 4}`, a), 16);
  const offset = (at - (site + 8)) >> 2;
  p.setWord(site, (0xea000000 | (offset & 0xffffff)) >>> 0, 'the look of the picture, for the steps after development');
  extendZeroFill(p);
}

/** True when a look made of this matrix (Q13), curves and post-curve matrix (Q9) gives grey for every colour. */
export function monoLook(matrix: ArrayLike<number>, curves: readonly ArrayLike<number>[], post?: ArrayLike<number>): boolean {
  for (let c = 0; c < 3; c++) if (matrix[c] !== matrix[3 + c] || matrix[c] !== matrix[6 + c]) return false;
  for (let i = 0; i < curves[0].length; i++) if (curves[0][i] !== curves[1][i] || curves[0][i] !== curves[2][i]) return false;
  // Grey in, grey out of the post-curve matrix when its rows sum alike (they all do: Q9 rows of 512).
  if (post) {
    const sum = (r: number): number => post[r * 3] + post[r * 3 + 1] + post[r * 3 + 2];
    if (sum(0) !== sum(1) || sum(0) !== sum(2)) return false;
  }
  return true;
}

const s16 = (b: Uint8Array, o: number): number => ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const w32 = (b: Uint8Array, o = 0): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * A factory style's colour as it is in `p` (e.g. Cinema Yellow with a preset): matrix (Q13), tone
 * curves, post-curve matrix of the neutral saturation (Q9), and whether its curves apply as they
 * are (gamma descriptor byte 5 is 0: a preset's curves; Cinema's own go through its Toning).
 */
export function styleColour(p: Patch, tone: number): { matrix: number[]; curves: [number[], number[], number[]]; postQ9: number[]; ownCurves: boolean } {
  const rec = w32(p.readMapped(T_REC + 4 * tone, 4));
  const desc = w32(p.readMapped(T_GAM + 4 * tone, 4));
  const m = p.readMapped(w32(p.readMapped(rec + 4, 4)), 18);
  const matrix = Array.from({ length: 9 }, (_, i) => s16(m, i * 2));
  const curves = [8, 12, 16].map((o) => {
    const c = p.readMapped(w32(p.readMapped(desc + o, 4)), 512);
    return Array.from({ length: 256 }, (_, i) => u16(c, i * 2));
  }) as [number[], number[], number[]];
  const postArr = w32(p.readMapped(rec + 8, 4));
  const p0 = p.readMapped(w32(p.readMapped(postArr + 4 * 4, 4)), 18);
  const postQ9 = Array.from({ length: 9 }, (_, i) => s16(p0, i * 2) / 16);
  return { matrix, curves, postQ9, ownCurves: p.readMapped(desc + 5, 1)[0] === 0 };
}

/** Whether a factory style (as it is in `p`, e.g. Cinema Yellow with a preset) is black and white. */
export function monoStyle(p: Patch, tone: number): boolean {
  const c = styleColour(p, tone);
  return monoLook(c.matrix, c.curves, c.postQ9);
}

/**
 * The 64-byte table of black-and-white looks: the camera's own, edited Cinema slots, added slots
 * from `firstAdded` (the last two are colour work, 1.11 only: with 1.20 the Cinema slots are the
 * camera's own colour looks).
 */
export function monoTable(p: Patch, addedMono: readonly boolean[], firstAdded: number): Uint8Array {
  const t = new Uint8Array(64);
  for (const l of p.target.facts.monoLooks) t[l] = 1;
  if (p.target.colour) for (const tone of [0x12, 0x13]) if (monoStyle(p, tone)) t[tone] = 1;
  addedMono.forEach((m, k) => {
    if (m && firstAdded + k < 64) t[firstAdded + k] = 1;
  });
  return t;
}
