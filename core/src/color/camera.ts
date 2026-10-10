// Model of one GR IV "Image Control" slot acting on the camera's own Standard rendering:
//   display = curve_c( S( clip( M1 . S^-1(d_standard) ) ) )
// S is the camera's base tone curve (linear -> display), M1 a 3x3 matrix whose rows sum to 1 and
// curve_c three per-channel curves given by 17 knots on a uniform 0..1 grid.
import { BASE_CURVE } from './data';
import { ColorError, interp, linspace01, matMul3, roundHalfEven } from './math';

export interface SlotParams {
  /** 3x3, applied to linear camera-Standard RGB; rows sum to 1. */
  M1: number[][];
  /** Three curves (R, G, B) of 17 knots each at KN = i/16, display domain. */
  ck: Float64Array[];
  /**
   * Optional post-curve ("second") matrix: 3x3, rows sum to 1, applied to the clipped curve
   * outputs (display RGB), the result clipped to 0..1 again. The camera applies it after the tone
   * curves together with the saturation setting.
   */
  P2?: number[][];
}

export interface QuantizedSlot {
  /** Row-major 3x3 in Q13 (8192 = 1.0); every row sums to exactly 8192. */
  matrixQ13: Int16Array;
  /** R, G, B curves: 256 entries each, output 0..16383 for input i*64/16383. */
  curves: [Uint16Array, Uint16Array, Uint16Array];
  /** With `P2`: the post-curve matrix in Q9 (512 = 1.0), row-major; every row sums to exactly 512. */
  postQ9?: Int16Array;
}

export const KNOTS = 17;
/** Curve knot positions, np.linspace(0, 1, 17). */
export const KN: Float64Array = linspace01(KNOTS);

/** Base tone curve samples: S_TAB[i] = display value for linear input S_X[i] = i/256. */
export const S_TAB: Float64Array = Float64Array.from(BASE_CURVE, (v) => v / 16383);
export const S_X: Float64Array = Float64Array.from({ length: 256 }, (_, i) => i / 256);
const S_XMAX = S_X[255];

/** Camera base tone curve: linear -> display. */
export function S(lin: number): number {
  return interp(lin < 0 ? 0 : lin > S_XMAX ? S_XMAX : lin, S_X, S_TAB);
}

/** Inverse of the base tone curve: display -> linear. */
export function Sinv(d: number): number {
  return interp(d < 0 ? 0 : d > 1 ? 1 : d, S_TAB, S_X);
}

function checkParams(p: SlotParams): void {
  if (!p || !Array.isArray(p.M1) || p.M1.length !== 3 || p.M1.some((r) => !r || r.length !== 3))
    throw new ColorError('bad-input', 'slot matrix must be 3x3');
  if (!p.ck || p.ck.length !== 3 || p.ck.some((c) => !c || c.length !== KNOTS))
    throw new ColorError('bad-input', 'slot curves must be 3 x 17 knots');
  if (p.P2 !== undefined && (!Array.isArray(p.P2) || p.P2.length !== 3 || p.P2.some((r) => !r || r.length !== 3 || r.some((v) => !Number.isFinite(v)))))
    throw new ColorError('bad-input', 'post matrix must be 3x3');
}

// Tables for the fast path of slotApply. Every value is computed with the same floating-point
// expression np.interp uses, so the fast path returns bit-identical results to S / Sinv / interp.
const S_SLOPE = Float64Array.from({ length: 255 }, (_, j) => (S_TAB[j + 1] - S_TAB[j]) / (S_X[j + 1] - S_X[j]));
const SINV_SLOPE = Float64Array.from({ length: 255 }, (_, j) => (S_X[j + 1] - S_X[j]) / (S_TAB[j + 1] - S_TAB[j]));
const GUESS_N = 1024;
/** SINV_GUESS[k]: last index j with S_TAB[j] <= k / GUESS_N (a lower bound for the search at any d >= k / GUESS_N). */
const SINV_GUESS = (() => {
  const g = new Uint8Array(GUESS_N + 1);
  let j = 0;
  for (let k = 0; k <= GUESS_N; k++) {
    while (j < 255 && S_TAB[j + 1] <= k / GUESS_N) j++;
    g[k] = j;
  }
  return g;
})();

/** Apply a slot to colours as output by the camera's Standard preset (sRGB-encoded 0..1). */
export function slotApply(params: SlotParams, rgb: Float64Array): Float64Array {
  checkParams(params);
  const M = params.M1;
  // per-channel matrix rows, knots and knot slopes
  const rows = [Float64Array.from(M[0]), Float64Array.from(M[1]), Float64Array.from(M[2])];
  const knots = params.ck;
  const slopes = knots.map((c) => Float64Array.from({ length: KNOTS - 1 }, (_, k) => (c[k + 1] - c[k]) / (KN[k + 1] - KN[k])));
  const post = params.P2 ? params.P2.map((r) => Float64Array.from(r)) : null;
  const out = new Float64Array(rgb.length);
  const lin = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      // S^-1: display -> linear
      let d = rgb[i + c];
      d = d < 0 ? 0 : d > 1 ? 1 : d;
      let j = SINV_GUESS[Math.floor(d * GUESS_N)];
      while (j < 255 && S_TAB[j + 1] <= d) j++;
      lin[c] = j === 255 || S_TAB[j] === d ? S_X[j] : SINV_SLOPE[j] * (d - S_TAB[j]) + S_X[j];
    }
    const a0 = lin[0], a1 = lin[1], a2 = lin[2];
    for (let c = 0; c < 3; c++) {
      const row = rows[c];
      let l = a0 * row[0] + a1 * row[1] + a2 * row[2];
      l = l < 0 ? 0 : l > S_XMAX ? S_XMAX : l; // clip to 0..1, then S clips to its last sample
      // S: linear -> display
      const j = Math.floor(l * 256);
      const b = j >= 255 ? S_TAB[255] : S_SLOPE[j] * (l - S_X[j]) + S_TAB[j];
      // slot curve
      let o: number;
      if (b >= 1) o = knots[c][KNOTS - 1];
      else {
        const k = Math.floor(b * 16);
        o = slopes[c][k] * (b - KN[k]) + knots[c][k];
      }
      out[i + c] = o < 0 ? 0 : o > 1 ? 1 : o;
    }
    if (post) {
      const v0 = out[i], v1 = out[i + 1], v2 = out[i + 2];
      for (let r = 0; r < 3; r++) {
        const q = post[r];
        const t = q[0] * v0 + q[1] * v1 + q[2] * v2;
        out[i + r] = t < 0 ? 0 : t > 1 ? 1 : t;
      }
    }
  }
  return out;
}

/**
 * Quantise a slot to the integers the firmware stores (build.py `slot_bytes`).
 * `mStdQ13` is the camera's Standard matrix in Q13 as read from the user's firmware (9 values,
 * row-major); the slot matrix is M1 . M_STD.
 */
export function quantizeSlot(params: SlotParams, mStdQ13: ArrayLike<number>): QuantizedSlot {
  checkParams(params);
  if (!mStdQ13 || mStdQ13.length !== 9) throw new ColorError('bad-input', 'Standard matrix must have 9 entries');
  const mStd: number[] = [];
  for (let i = 0; i < 9; i++) {
    const v = Number(mStdQ13[i]);
    if (!Number.isFinite(v)) throw new ColorError('bad-input', 'Standard matrix has a non-finite entry');
    mStd.push(v / 8192);
  }
  const prod = matMul3(params.M1.flat(), mStd);
  const q = prod.map((v) => roundHalfEven(v * 8192));
  for (let i = 0; i < 3; i++) {
    const rowSum = q[i * 3] + q[i * 3 + 1] + q[i * 3 + 2];
    q[i * 3 + i] = 8192 - (rowSum - q[i * 3 + i]);
  }
  for (const v of q)
    if (!Number.isFinite(v) || Math.abs(v) >= 32768) throw new ColorError('bad-input', 'slot matrix does not fit in Q13 int16');
  const curves = [0, 1, 2].map((c) => {
    const ck = params.ck[c];
    const cq = new Uint16Array(256);
    let run = 0;
    for (let i = 0; i < 256; i++) {
      const y = interp((i * 64) / 16383.0, KN, ck);
      if (!Number.isFinite(y)) throw new ColorError('bad-input', 'slot curve has a non-finite knot');
      let v = roundHalfEven(y * 16383);
      v = v < 0 ? 0 : v > 16383 ? 16383 : v;
      if (v > run) run = v;
      cq[i] = run;
    }
    return cq;
  }) as [Uint16Array, Uint16Array, Uint16Array];
  if (!params.P2) return { matrixQ13: Int16Array.from(q), curves };
  // Q9, the diagonal takes the remainder so that every row sums to exactly 512 (grey stays grey).
  const pq = params.P2.flat().map((v) => roundHalfEven(v * 512));
  for (let i = 0; i < 3; i++) pq[i * 4] = 512 - (pq[i * 3] + pq[i * 3 + 1] + pq[i * 3 + 2] - pq[i * 4]);
  for (const v of pq) if (!Number.isFinite(v) || v < -2047 || v > 2047) throw new ColorError('bad-input', 'post matrix does not fit the 12-bit range');
  return { matrixQ13: Int16Array.from(q), curves, postQ9: Int16Array.from(pq) };
}
