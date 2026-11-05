// SPDX-License-Identifier: GPL-2.0-only
/**
 * The look of the picture being made, for the steps after development (halation, date imprint).
 *
 * The development step reads the frame's record at 0x539113F8 (`ldrb r2,[r3,#0x79C]`: the look,
 * then a dispatch on it for every look); its Toning setting is at +0x7A6. A hook there leaves
 * `look | toning << 8 | 0x10000` in one word, LOOK_STASH, before the JPEG step runs. The word is in
 * the 44 bytes between the end of the start-up zero fill and the heap; the zero fill is extended
 * over them (see slots.ts). (Test firmware 046 showed that while shooting, the step runs several
 * hundred times a second for live view, so the word holds the current settings' look rather than
 * the captured frame's own: the same look unless it is changed while a picture is processed.)
 *
 * Orientation (0.8.3, for the date imprint), ORIENT_WORD. The EXIF writer
 * (ExifJpegTiffEntryDataSetter, 0x537FEBC4) takes it from the frame's shooting record: byte 0x71E84
 * when byte 0x71E83 is set, else byte 0xD8; 1, 2, 3 become Orientation 8, 3, 6 (table 0x53FA6478),
 * anything else 1. Byte 0xD8 of a shooting record is the camera's direction (0 up, 1 left, 2 down,
 * 3 right, 4 / 5 lens up / down, as the display rotation reads it from the live record:
 * 0x5323A6F0 -> 0x53755CA0). When shooting, the development step's record is not that one (046:
 * byte 0xD8 there is 0), so the direction is taken at the start of the exposure (datestamp.ts);
 * in RAW development (the step's flag r1 + 0x2AC is 0 and r1 + 0x2D0 is the record of the RAW
 * file) this hook takes it from that record by the EXIF writer's rule.
 *
 * Black-and-white looks: Monotone, Soft Monotone, Hard Monotone, Hi-Contrast B&W (13..16; their
 * names through 0x5337F824) and the GR IV Monochrome's six (25..30), plus any slot whose preset
 * gives grey for every colour (equal matrix rows, equal curves, equal rows of the post-curve
 * matrix).
 */
import { assembleWords } from './arm';
import { Patch, expectWord } from './build';
import { T_GAM, T_REC } from '../profile';

export const LOOK_STASH = 0x558372e4;
/**
 * The orientation of the picture being made (0.8.3, for the date imprint): `value | ORIENT_VALID`,
 * value 0 as stored, 1 / 2 / 3 = EXIF Orientation 8 / 3 / 6. Written at the start of each still
 * exposure from the camera's direction (see datestamp.ts) and, in RAW development, by the
 * development step from the record being developed. In the 44 zero-filled bytes before the heap.
 */
export const ORIENT_WORD = 0x558372f4;
export const ORIENT_VALID = 0x100;
/**
 * The look of the picture being made (0.8.4, for the date imprint's look name), LOOK_STASH's word
 * as it was at the start of the exposure (the look live view was being developed with; see
 * datestamp.ts) or, in RAW development, the one the development step takes from the record being
 * developed. Unlike LOOK_STASH it does not follow a look chosen while the picture is being
 * processed. In the 44 zero-filled bytes before the heap.
 */
export const FRAME_LOOK = 0x558372f8;
/** The development step's read of the look (the hook site). */
export const LOOK_SITE = 0x539113f8;
const LOOK_SITE_WORD = 0xe5d3279c; // ldrb r2, [r3, #0x79c]
/** Literal: end of the start-up zero fill; 44 unused bytes up to the heap (0x55837300) follow it. */
const ZERO_FILL_END = 0x53000460;
/** GR IV Monochrome check (1 on that model). */
export const MONO_MODEL = 0x533ef000;

/** The camera's own black-and-white looks. */
export const MONO_LOOKS = [13, 14, 15, 16, 25, 26, 27, 28, 29, 30];

/**
 * Store the look: keeps every register but r2 (which the site's own instruction loads next) and the
 * flags. r1 is the step's argument + 0x8000, r3 the frame's record. Its Toning byte is
 * a halation look's encoded setting (halation-ui.ts, 0..11): it is left as the level (0 off,
 * 1 Weak, 2 Medium, 3 Strong) and STASH_WHITE for the white glow. 0, 1, 2 (Off, Weak and Strong red,
 * as up to test 042) stay Off, Weak, Strong.
 */
export const STASH_ASM = `ldr r2,[r1,#0x2d0];push {r0,r1};
  ldrb r0,[r1,#0x2ac];cmp r0,#0;bne stashlook;
  add r0,r2,#0x71000;ldrb r1,[r0,#0xe83];cmp r1,#0;ldrbne r2,[r0,#0xe84];ldrbeq r2,[r2,#0xd8];cmp r2,#3;movhi r2,#0;
  orr r2,r2,#0x${ORIENT_VALID.toString(16)};movw r1,#${ORIENT_WORD & 65535};movt r1,#${ORIENT_WORD >>> 16};str r2,[r1];
  stashlook:ldrb r0,[r3,#0x79c];ldrb r1,[r3,#0x7a6];
  cmp r1,#7;movhs r1,#0;
  cmp r1,#4;subhs r1,r1,#3;orrhs r0,r0,#0x20000;bhs stashlevel;
  cmp r1,#3;moveq r1,#2;beq stashlevel;
  cmp r1,#2;moveq r1,#3;
  stashlevel:orr r0,r0,r1,lsl #8;orr r0,r0,#0x10000;movw r1,#${LOOK_STASH & 65535};movt r1,#${LOOK_STASH >>> 16};str r0,[r1];
  ldr r1,[sp,#4];ldrb r1,[r1,#0x2ac];cmp r1,#0;bne stashdone;
  movw r1,#${FRAME_LOOK & 65535};movt r1,#${FRAME_LOOK >>> 16};str r0,[r1];
  stashdone:pop {r0,r1};`;
/** The white glow's bit in the stash word. */
export const STASH_WHITE = 0x20000;


export function extendZeroFill(p: Patch): void {
  const w = p.word(ZERO_FILL_END);
  if (w === 0x55837300) return;
  expectWord(p, ZERO_FILL_END, 0x558372d4);
  p.setWord(ZERO_FILL_END, 0x55837300, 'start-up zero fill also clears the 44 unused bytes before the heap');
}

/** The hook on its own (no added slots: `slots.ts` puts the same code in its hook of the site). */
export function installLookStash(p: Patch): void {
  if (p.word(LOOK_SITE) >>> 24 === 0xea) return; // already hooked here (an earlier call)
  expectWord(p, LOOK_SITE, LOOK_SITE_WORD);
  const at = p.append((a) => assembleWords(`${STASH_ASM}ldrb r2,[r3,#0x79c];b #${LOOK_SITE + 4}`, a), 16);
  const offset = (at - (LOOK_SITE + 8)) >> 2;
  p.setWord(LOOK_SITE, (0xea000000 | (offset & 0xffffff)) >>> 0, 'the look of the picture, for the steps after development');
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

/** The 64-byte table of black-and-white looks: the camera's own, edited Cinema slots, added slots from `firstAdded`. */
export function monoTable(p: Patch, addedMono: readonly boolean[], firstAdded: number): Uint8Array {
  const t = new Uint8Array(64);
  for (const l of MONO_LOOKS) t[l] = 1;
  for (const tone of [0x12, 0x13]) if (monoStyle(p, tone)) t[tone] = 1;
  addedMono.forEach((m, k) => {
    if (m && firstAdded + k < 64) t[firstAdded + k] = 1;
  });
  return t;
}
