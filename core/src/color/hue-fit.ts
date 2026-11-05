// SPDX-License-Identifier: GPL-2.0-only
/**
 * Fit an added slot's own hue sectors (hue.ts) after the plain fit. The block is Standard's
 * matrices times a correction built from 36 boundary shifts (`hueMatricesFromD`); the correction,
 * M1, the curves and the post matrix are refined together by Levenberg-Marquardt on weighted Lab
 * differences, with the slot applied in the camera's order (camera.ts, `slotApply` with `hue`).
 * The start (no correction) is the slot as it renders with Standard's block.
 */
import { KNOTS, S, Sinv, undoHue } from './camera';
import type { SlotParams } from './camera';
import { composeWithStandard, hueMatricesFromD, hueSector } from './hue';
import { lab } from './math';

const XMAX = 255 / 256;

/** The linear signal before Standard's stage for colours as Standard outputs them. */
export function beforeStandardHue(std: number[][], P: Float64Array): Float64Array {
  const out = new Float64Array(P.length);
  const x = [0, 0, 0];
  for (let i = 0; i < P.length; i += 3) {
    undoHue(std, Sinv(P[i]), Sinv(P[i + 1]), Sinv(P[i + 2]), x);
    out[i] = x[0]; out[i + 1] = x[1]; out[i + 2] = x[2];
  }
  return out;
}

/** `slotApply` with `hue` for signals already taken before Standard's stage (same arithmetic). */
export function applyBeforeHue(p: SlotParams, pre: Float64Array): Float64Array {
  const out = new Float64Array(pre.length);
  const M = p.M1, H = p.hue!, ck = p.ck, P2 = p.P2;
  for (let i = 0; i < pre.length; i += 3) {
    const x0 = pre[i], x1 = pre[i + 1], x2 = pre[i + 2];
    const v0 = x0 * M[0][0] + x1 * M[0][1] + x2 * M[0][2];
    const v1 = x0 * M[1][0] + x1 * M[1][1] + x2 * M[1][2];
    const v2 = x0 * M[2][0] + x1 * M[2][1] + x2 * M[2][2];
    const h = H[hueSector(v0, v1, v2)];
    const l = [h[0] * v0 + h[1] * v1 + h[2] * v2, h[3] * v0 + h[4] * v1 + h[5] * v2, h[6] * v0 + h[7] * v1 + h[8] * v2];
    for (let c = 0; c < 3; c++) {
      const v = l[c] < 0 ? 0 : l[c] > XMAX ? XMAX : l[c];
      const b = S(v);
      let o: number;
      if (b >= 1) o = ck[c][KNOTS - 1];
      else { const k = Math.floor(b * 16); o = ck[c][k] + (ck[c][k + 1] - ck[c][k]) * (b - k / 16) * 16; }
      out[i + c] = o < 0 ? 0 : o > 1 ? 1 : o;
    }
    if (P2) {
      const a = out[i], b = out[i + 1], c = out[i + 2];
      for (let r = 0; r < 3; r++) { const t = P2[r][0] * a + P2[r][1] * b + P2[r][2] * c; out[i + r] = t < 0 ? 0 : t > 1 ? 1 : t; }
    }
  }
  return out;
}

function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = A.slice(), x = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k * n + i]) > Math.abs(M[p * n + i])) p = k;
    if (Math.abs(M[p * n + i]) < 1e-14) return null;
    if (p !== i) {
      for (let k = 0; k < n; k++) { const t = M[i * n + k]; M[i * n + k] = M[p * n + k]; M[p * n + k] = t; }
      const t = x[i]; x[i] = x[p]; x[p] = t;
    }
    for (let k = i + 1; k < n; k++) {
      const f = M[k * n + i] / M[i * n + i];
      if (!f) continue;
      for (let j = i; j < n; j++) M[k * n + j] -= f * M[i * n + j];
      x[k] -= f * x[i];
    }
  }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j]; x[i] = s / M[i * n + i]; }
  return x;
}

const offdiag = (m: number[][]): number[] => [m[0][1], m[0][2], m[1][0], m[1][2], m[2][0], m[2][1]];
const fromOff = (x: ArrayLike<number>, at: number): number[][] => {
  const [a, b, c, d, e, f] = [x[at], x[at + 1], x[at + 2], x[at + 3], x[at + 4], x[at + 5]];
  return [[1 - a - b, a, b], [c, 1 - c - d, d], [e, f, 1 - e - f]];
};

export interface HueFitOptions { iterations?: number; regularise?: number; onProgress?: (f: number) => void }

/**
 * Refine `start` (a plain fit: M1, curves, P2) with hue sectors of its own. `P` are colours as
 * Standard outputs them, `target` what the preset makes of them, `weights` per colour.
 */
export function fitHue(start: SlotParams, std: number[][], P: Float64Array, target: Float64Array, weights: Float64Array, opts: HueFitOptions = {}): SlotParams {
  const pre = beforeStandardHue(std, P);
  const tLab = lab(target);
  const w = Float64Array.from(weights, (v) => Math.sqrt(v));
  const hasP2 = !!start.P2;
  const at = 6 + 3 * KNOTS + (hasP2 ? 6 : 0);
  const x0 = [...offdiag(start.M1), ...start.ck.flatMap((c) => Array.from(c)), ...(hasP2 ? offdiag(start.P2!) : []), ...new Array(36).fill(0)];
  const params = (x: ArrayLike<number>): SlotParams => ({
    M1: fromOff(x, 0),
    ck: [0, 1, 2].map((c) => Float64Array.from({ length: KNOTS }, (_, k) => x[6 + c * KNOTS + k])),
    ...(hasP2 ? { P2: fromOff(x, 6 + 3 * KNOTS) } : {}),
    hue: composeWithStandard(std, hueMatricesFromD(x, at)),
    hueStd: std,
  });
  const n = x0.length, mc = tLab.length;
  // a small pull of the 36 shifts towards none (`regularise`): pale colours of a sector move with its saturated ones
  const reg = Math.sqrt(opts.regularise ?? 0);
  const m = mc + (reg > 0 ? 36 : 0);
  const residual = (x: ArrayLike<number>): Float64Array => {
    const L = lab(applyBeforeHue(params(x), pre));
    const r = new Float64Array(m);
    for (let i = 0; i < mc; i++) r[i] = (L[i] - tLab[i]) * w[(i / 3) | 0];
    if (reg > 0) for (let k = 0; k < 36; k++) r[mc + k] = reg * x[at + k];
    return r;
  };
  const cost = (r: Float64Array): number => { let s = 0; for (const v of r) s += v * v; return s; };
  let x = Float64Array.from(x0);
  let r = residual(x), c = cost(r), lambda = 1e-3;
  const iterations = opts.iterations ?? 12;
  const J = Array.from({ length: n }, () => new Float64Array(m));
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < n; k++) {
      const xx = x.slice(); const h = 1e-4; xx[k] += h;
      const rk = residual(xx), col = J[k];
      for (let i = 0; i < m; i++) col[i] = (rk[i] - r[i]) / h;
    }
    const A = new Float64Array(n * n), g = new Float64Array(n);
    for (let a = 0; a < n; a++) {
      const ja = J[a];
      for (let b = a; b < n; b++) { const jb = J[b]; let s = 0; for (let i = 0; i < m; i++) s += ja[i] * jb[i]; A[a * n + b] = s; A[b * n + a] = s; }
      let s = 0; for (let i = 0; i < m; i++) s += ja[i] * r[i]; g[a] = -s;
    }
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const B = A.slice();
      for (let a = 0; a < n; a++) B[a * n + a] += lambda * (A[a * n + a] + 1e-9);
      const dx = solve(B, g, n);
      if (!dx) { lambda *= 10; continue; }
      const xn = x.map((v, k) => v + dx[k]);
      const rn = residual(xn), cn = cost(rn);
      if (cn < c) { x = xn; r = rn; c = cn; lambda = Math.max(lambda / 3, 1e-7); improved = true; } else lambda *= 10;
    }
    opts.onProgress?.((it + 1) / iterations);
    if (!improved) break;
  }
  return params(x);
}
