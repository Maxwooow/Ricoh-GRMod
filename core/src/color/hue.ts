// SPDX-License-Identifier: GPL-2.0-only
/**
 * The camera's hue-sector stage ("multi-axis"): twelve pieces of the hue circle, each with a 3x3
 * matrix (rows summing to 1), applied to the linear signal after the slot's colour matrix and
 * before the base tone curve. Every style has a 2160-byte block of them: 12 sectors x 5 copies x
 * 9 int32 in Q10, sector by sector. In the official 1.11 the copies are not equal: copy c is copy 0
 * x (16 - c) / 16 (rows summing to 1024, 960, 896, 832, 768); which copy the image hardware uses
 * when is not known, so a block GR Mod writes follows the same rule.
 *
 * Sector boundaries, the hue measure and the parametrisation by 36 boundary shifts follow the
 * published method of GR4-LUTSmith (as ported in PR #15 by orbitsail, after #8 by sjclijie). The
 * stage order (after the slot matrix) is that method's assumption, not yet checked on a camera.
 *
 * GR Mod fits a preset to the picture as Standard renders it, and Standard's own sector stage is
 * in that picture. An added slot with a block of its own does not run Standard's stage, so the
 * block is fitted as Standard's matrices times a correction (`composeWithStandard`), in the
 * camera's own order (`slotApply` with `hue`, see camera.ts): with no correction the slot renders
 * as one that uses Standard's block.
 */

/** Sector boundaries in degrees. */
export const HUE_BOUNDS: readonly number[] = [359.8, 27.4, 62.2, 92.6, 112.0, 142.8, 179.2, 211.4, 238.6, 267.2, 306.0, 326.5];
const Y1 = [-0.16796875, -0.33203125, 0.5];
const Y2 = [0.5, -0.41796875, -0.08203125];
const RAD = Math.PI / 180;
/** Values per block: 12 sectors x 9. */
export const HUE_VALUES = 108;
/** Largest magnitude written (Q10), as in GR4-LUTSmith, whose blocks run on cameras with this bound. */
export const HUE_LIMIT = 2047;
export const HUE_COPIES = 5;
export const HUE_BLOCK_BYTES = 12 * HUE_COPIES * 9 * 4;

/** Sector of a linear RGB triple. */
export function hueSector(r: number, g: number, b: number): number {
  const cb = Y1[0] * r + Y1[1] * g + Y1[2] * b;
  const cr = Y2[0] * r + Y2[1] * g + Y2[2] * b;
  let a = Math.atan2(cr, cb) / RAD;
  if (a < 0) a += 360;
  let best = 0, bestD = 1e9;
  for (let i = 0; i < 12; i++) {
    let d = (a - HUE_BOUNDS[i]) % 360;
    if (d < 0) d += 360;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 12 matrices (row-major 3x3, rows summing to 1) from 36 boundary shifts `d[c * 12 + g]` (R, G, B shift at boundary g). */
export function hueMatricesFromD(d: ArrayLike<number>, at = 0): number[][] {
  const out: number[][] = [];
  for (let g = 0; g < 12; g++) {
    const t0 = HUE_BOUNDS[g] * RAD, t1 = HUE_BOUNDS[(g + 1) % 12] * RAD;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    const det = c0 * s1 - s0 * c1;
    const u00 = s1 / det, u01 = -c1 / det, u10 = -s0 / det, u11 = c0 / det;
    const m: number[] = [];
    for (let c = 0; c < 3; c++) {
      const d0 = d[at + c * 12 + g], d1 = d[at + c * 12 + ((g + 1) % 12)];
      const a = d0 * u00 + d1 * u10, b = d0 * u01 + d1 * u11;
      for (let k = 0; k < 3; k++) m.push((c === k ? 1 : 0) + a * Y1[k] + b * Y2[k]);
    }
    out.push(m);
  }
  return out;
}

function mul3(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}

/** A slot's block: Standard's matrix of each sector times the correction of that sector. */
export function composeWithStandard(standard: readonly (readonly number[])[], correction: readonly (readonly number[])[]): number[][] {
  return standard.map((m, g) => mul3(m, correction[g]));
}

/** Standard's (or any) block as floats from the firmware's Q10 copy 0 (12 x 9 values). */
export function hueFromQ10(q: ArrayLike<number>): number[][] {
  if (q.length !== HUE_VALUES) throw new Error('hueFromQ10: expected 12 x 9 values');
  return Array.from({ length: 12 }, (_, g) => Array.from({ length: 9 }, (_, k) => q[g * 9 + k] / 1024));
}

/** Round to the firmware's Q10, every row repaired to sum to 1024 (copy 0); null when a value is beyond HUE_LIMIT. */
export function hueToQ10(m: readonly (readonly number[])[]): number[] | null {
  const out: number[] = [];
  for (const matrix of m) {
    const q = matrix.map((v) => Math.round(v * 1024) + 0);
    for (let r = 0; r < 3; r++) q[r * 3 + 2] += 1024 - (q[r * 3] + q[r * 3 + 1] + q[r * 3 + 2]);
    if (q.some((v) => !Number.isFinite(v) || Math.abs(v) > HUE_LIMIT)) return null;
    out.push(...q);
  }
  return out;
}

/**
 * The 2160-byte block for copy-0 values `q` (12 x 9, Q10): copy c is q x (16 - c) / 16, each
 * value rounded and the last of each row taking the remainder, so that rows sum to exactly
 * 1024 x (16 - c) / 16 as in the official blocks (Standard's: every value within 1 of this rule).
 */
export function hueBlockBytes(q: ArrayLike<number>): Uint8Array {
  if (q.length !== HUE_VALUES) throw new Error('hueBlockBytes: expected 12 x 9 values');
  const out = new Uint8Array(HUE_BLOCK_BYTES);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let g = 0; g < 12; g++) {
    for (let c = 0; c < HUE_COPIES; c++) {
      for (let r = 0; r < 3; r++) {
        const row = [0, 1, 2].map((k) => q[g * 9 + r * 3 + k]);
        const want = Math.round((row[0] + row[1] + row[2]) * (16 - c) / 16);
        const v = row.map((x) => Math.round((x * (16 - c)) / 16));
        v[2] = want - v[0] - v[1];
        for (const x of v) { view.setInt32(o, x, true); o += 4; }
      }
    }
  }
  return out;
}

/** Copy 0 of a block (12 x 9) if every copy follows the rule hueBlockBytes writes; null otherwise. */
export function hueFromBlock(bytes: Uint8Array): number[] | null {
  if (bytes.length < HUE_BLOCK_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, HUE_BLOCK_BYTES);
  const q: number[] = [];
  for (let g = 0; g < 12; g++) for (let k = 0; k < 9; k++) q.push(view.getInt32((g * HUE_COPIES * 9 + k) * 4, true));
  const again = hueBlockBytes(q);
  for (let i = 0; i < HUE_BLOCK_BYTES; i++) if (again[i] !== bytes[i]) return null;
  return q;
}

/** Copy 0 of a block read from the firmware, whatever its other copies (e.g. Standard's). */
export function hueCopy0(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, HUE_BLOCK_BYTES);
  const q: number[] = [];
  for (let g = 0; g < 12; g++) for (let k = 0; k < 9; k++) q.push(view.getInt32((g * HUE_COPIES * 9 + k) * 4, true));
  return q;
}
