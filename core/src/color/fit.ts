// Fit of one camera slot (matrix + three curves) to a target rendering: robust non-linear least
// squares on CIELAB differences, port of `fit_slot` in basecal2.py.
//
// Model parameters: 6 matrix off-diagonals in `mat6` order (M01, M02, M10, M12, M20, M21; the
// diagonal makes each row sum to 1) and 3 x 17 curve knots. Start: identity matrix and curves.
// Residuals: lab(slot(P)) - lab(target). Loss: scipy's soft_l1 with f_scale = 3, i.e.
// cost = 0.5 f^2 sum rho((r/f)^2), rho(z) = 2 (sqrt(1 + z) - 1).
//
// Solver: Levenberg-Marquardt on the iteratively reweighted problem (row weights rho'(z)) with an
// analytic Jacobian (the model is piecewise smooth), Marquardt diagonal scaling and simple bounds
// handled by projection with an active set; it runs to convergence (bounded by maxIterations).
//
// One deliberate difference from the reference: scipy fits the knots without constraints and then
// applies clip(0..1) + running maximum, which can move the curve away from what was fitted (flat
// toes / clipped highlights). Here the knots are constrained to be monotone within 0..1 during the
// fit (see the increment parametrisation below), so the fitted model is the delivered one. Where
// the reference's raw solution already satisfies the constraints both agree; elsewhere this result
// has the lower cost after post-processing.
import { KN, KNOTS, S_TAB, Sinv, slotApply } from './camera';
import type { SlotParams } from './camera';
import { ColorError, deltaELab, lab, labWithJacobian, mean, percentile } from './math';

export interface FitOptions {
  onProgress?: (fraction: number) => void;
  /** Upper bound on solver iterations (default 300). */
  maxIterations?: number;
}

export interface FitResult extends SlotParams {
  /** Mean / 95th percentile CIE76 difference between the fitted slot and the target on the fitting set. */
  meanDE: number;
  p95DE: number;
  /** Robust cost of the returned (monotone, clipped) model. */
  cost: number;
  iterations: number;
}

export const F_SCALE = 3.0;
const NP = 6 + 3 * KNOTS; // 57
const S_XMAX = 255 / 256;

/** Matrix from its six off-diagonal elements (`mat6` in xmp2gr4.py). */
export function mat6(p: ArrayLike<number>): number[][] {
  const M = [
    [0, p[0], p[1]],
    [p[2], 0, p[3]],
    [p[4], p[5], 0],
  ];
  for (let i = 0; i < 3; i++) M[i][i] = 1 - (M[i][0] + M[i][1] + M[i][2]);
  return M;
}

/** Robust cost of a slot against a target, both evaluated on P (soft_l1, f_scale 3). */
export function robustCost(params: SlotParams, P: Float64Array, target: Float64Array): number {
  const a = lab(slotApply(params, P));
  const b = lab(target);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const r = (a[i] - b[i]) / F_SCALE;
    s += 2 * (Math.sqrt(1 + r * r) - 1);
  }
  return 0.5 * F_SCALE * F_SCALE * s;
}

class Problem {
  readonly n: number;
  /** S^-1 of the camera colours (linear camera Standard RGB). */
  readonly lin: Float64Array;
  readonly labT: Float64Array;
  readonly g = new Float64Array(NP);
  readonly H = new Float64Array(NP * NP);
  private readonly labBuf = new Float64Array(3);
  private readonly jac = new Float64Array(9);
  private readonly idx = new Int32Array(12);
  private readonly dout = new Float64Array(12);
  private readonly row = new Float64Array(12);

  constructor(P: Float64Array, target: Float64Array) {
    this.n = P.length / 3;
    this.lin = Float64Array.from(P, Sinv);
    this.labT = lab(target);
  }

  /** Robust cost at p; with `derivs` also the gradient g and the Gauss-Newton matrix H of the reweighted problem. */
  evaluate(p: Float64Array, derivs: boolean): number {
    const { n, lin, labT, g, H, labBuf, jac, idx, dout, row } = this;
    if (derivs) {
      g.fill(0);
      H.fill(0);
    }
    const M = mat6(p);
    const out = [0, 0, 0];
    let cost = 0;
    for (let px = 0, o = 0; px < n; px++, o += 3) {
      const a0 = lin[o], a1 = lin[o + 1], a2 = lin[o + 2];
      for (let c = 0; c < 3; c++) {
        const Mc = M[c];
        const l = a0 * Mc[0] + a1 * Mc[1] + a2 * Mc[2];
        const lc = l < 0 ? 0 : l > 1 ? 1 : l;
        // base tone curve S (256 linear segments on i/256)
        const xs = lc > S_XMAX ? S_XMAX : lc;
        const j = Math.floor(xs * 256);
        const b = j >= 255 ? S_TAB[255] : (S_TAB[j + 1] - S_TAB[j]) * 256 * (xs - j / 256) + S_TAB[j];
        // slot curve (16 linear segments on k/16, constant beyond 1)
        const kBase = 6 + c * KNOTS;
        let k: number, wHi: number, v: number;
        if (b >= 1) {
          k = KNOTS - 2;
          wHi = 1;
          v = p[kBase + KNOTS - 1];
        } else {
          k = Math.floor(b * 16);
          const y0 = p[kBase + k], y1 = p[kBase + k + 1];
          const d = b - KN[k];
          v = ((y1 - y0) / (KN[k + 1] - KN[k])) * d + y0;
          wHi = d * 16;
        }
        const inside = v >= -1e-12 && v <= 1 + 1e-12;
        out[c] = v < 0 ? 0 : v > 1 ? 1 : v;
        if (derivs) {
          const q = c * 4;
          const ja = c === 0 ? 1 : 0, jb = c === 2 ? 1 : 2; // columns of the two off-diagonals of row c
          idx[q] = c * 2;
          idx[q + 1] = c * 2 + 1;
          idx[q + 2] = kBase + k;
          idx[q + 3] = kBase + k + 1;
          if (inside) {
            const sSlope = l >= 0 && l <= 1 && j < 255 ? (S_TAB[j + 1] - S_TAB[j]) * 256 : 0;
            const cSlope = b >= 1 ? 0 : (p[kBase + k + 1] - p[kBase + k]) * 16;
            const dl = cSlope * sSlope;
            const ac = c === 0 ? a0 : c === 1 ? a1 : a2;
            dout[q] = dl * ((ja === 0 ? a0 : a1) - ac);
            dout[q + 1] = dl * ((jb === 1 ? a1 : a2) - ac);
            dout[q + 2] = 1 - wHi;
            dout[q + 3] = wHi;
          } else {
            dout[q] = 0; dout[q + 1] = 0; dout[q + 2] = 0; dout[q + 3] = 0;
          }
        }
      }
      if (!derivs) {
        // value only
        labWithJacobian(out[0], out[1], out[2], labBuf, jac);
        for (let k = 0; k < 3; k++) {
          const r = (labBuf[k] - labT[o + k]) / F_SCALE;
          cost += 2 * (Math.sqrt(1 + r * r) - 1);
        }
        continue;
      }
      labWithJacobian(out[0], out[1], out[2], labBuf, jac);
      for (let k = 0; k < 3; k++) {
        const r = labBuf[k] - labT[o + k];
        const z = (r / F_SCALE) * (r / F_SCALE);
        const sq = Math.sqrt(1 + z);
        cost += 2 * (sq - 1);
        const w = 1 / sq; // rho'(z)
        for (let c = 0; c < 3; c++) {
          const d = jac[k * 3 + c];
          const q = c * 4;
          row[q] = d * dout[q]; row[q + 1] = d * dout[q + 1]; row[q + 2] = d * dout[q + 2]; row[q + 3] = d * dout[q + 3];
        }
        const wr = w * r;
        for (let a = 0; a < 12; a++) {
          const ra = row[a];
          if (ra === 0) continue;
          const ia = idx[a];
          g[ia] += wr * ra;
          const wra = w * ra;
          const base = ia * NP;
          for (let bb = 0; bb < 12; bb++) H[base + idx[bb]] += wra * row[bb];
        }
      }
    }
    return 0.5 * F_SCALE * F_SCALE * cost;
  }
}

/**
 * Solve (H + lambda * diag(D)) x = -g by Cholesky, with the variables flagged in `fixed` held at
 * zero. Returns false if the matrix is not positive definite.
 */
function solveDamped(H: Float64Array, D: Float64Array, g: Float64Array, fixed: Uint8Array, lambda: number, L: Float64Array, x: Float64Array): boolean {
  const n = NP;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s: number;
      if (fixed[i] || fixed[j]) s = i === j ? 1 : 0;
      else s = i === j ? H[i * n + j] + lambda * D[i] : H[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return false;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  for (let i = 0; i < n; i++) {
    let s = fixed[i] ? 0 : -g[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k];
    x[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return true;
}

// The solver does not work on the knots directly but on increments, so that "the curve is monotone
// and stays within 0..1" becomes simple bounds: for each channel
//   knot[k] = q[0] + ... + q[k]            for k = 0..8   (built up from 0)
//   knot[k] = 1 - (q[k] + ... + q[16])     for k = 9..16  (built down from 1)
// with every q >= 0. The one remaining condition, knot[8] <= knot[9], is not enforced during the
// fit; like the reference, the result is finally passed through clip + running maximum, which is a
// no-op whenever that condition holds.
const HALF = 8;

function knotsFromIncrements(q: Float64Array, p: Float64Array): void {
  for (let i = 0; i < 6; i++) p[i] = q[i];
  for (let c = 0; c < 3; c++) {
    const o = 6 + c * KNOTS;
    let acc = 0;
    for (let k = 0; k <= HALF; k++) {
      acc += q[o + k];
      p[o + k] = acc;
    }
    acc = 0;
    for (let k = KNOTS - 1; k > HALF; k--) {
      acc += q[o + k];
      p[o + k] = 1 - acc;
    }
  }
}

/** v := v . A in place, A = d(knots)/d(increments); `stride` lets it run over a row or a column of a matrix. */
function chainRule(v: Float64Array, start: number, stride: number): void {
  for (let c = 0; c < 3; c++) {
    const o = start + (6 + c * KNOTS) * stride;
    let acc = 0;
    for (let k = HALF; k >= 0; k--) {
      acc += v[o + k * stride];
      v[o + k * stride] = acc;
    }
    acc = 0;
    for (let k = HALF + 1; k < KNOTS; k++) {
      acc -= v[o + k * stride];
      v[o + k * stride] = acc;
    }
  }
}

/**
 * Fit a slot so that slot(P) matches `target` (both sRGB-encoded 0..1 triples, same length).
 * P is what the camera's Standard preset outputs for the fitting colours.
 */
export function fitSlot(P: Float64Array, target: Float64Array, opts: FitOptions = {}): FitResult {
  if (P.length !== target.length || P.length === 0 || P.length % 3 !== 0)
    throw new ColorError('bad-input', 'fitSlot needs two equally long buffers of RGB triples');
  for (let i = 0; i < P.length; i++)
    if (!Number.isFinite(P[i]) || !Number.isFinite(target[i])) throw new ColorError('bad-input', 'fitSlot input contains a non-finite value');
  const maxIter = opts.maxIterations ?? 300;
  const progress = opts.onProgress;
  const prob = new Problem(P, target);

  // start: identity matrix, identity curves
  let q = new Float64Array(NP);
  for (let c = 0; c < 3; c++)
    for (let k = 0; k < KNOTS; k++) q[6 + c * KNOTS + k] = k === 0 || k === KNOTS - 1 ? 0 : KN[1];
  let trial = new Float64Array(NP);
  const p = new Float64Array(NP);
  const step = new Float64Array(NP);
  const D = new Float64Array(NP);
  const L = new Float64Array(NP * NP);
  const fixed = new Uint8Array(NP);
  const { g, H } = prob;
  /** Cost at increments `x`; with derivs, g and H are left in increment space. */
  const evaluate = (x: Float64Array, derivs: boolean): number => {
    knotsFromIncrements(x, p);
    const cost = prob.evaluate(p, derivs);
    if (derivs) {
      chainRule(g, 0, 1);
      for (let r = 0; r < NP; r++) chainRule(H, r * NP, 1);
      for (let col = 0; col < NP; col++) chainRule(H, col, NP);
    }
    return cost;
  };

  let cost = evaluate(q, true);
  let lambda = 1e-3;
  let nu = 2;
  let small = 0;
  let iterations = 0;
  const FTOL = 1e-10;
  while (iterations < maxIter) {
    iterations++;
    if (progress) progress(Math.min(0.95, iterations / 60));
    let dmax = 0;
    for (let i = 0; i < NP; i++) dmax = Math.max(dmax, H[i * NP + i]);
    if (!(dmax > 0)) break; // no parameter has any influence
    for (let i = 0; i < NP; i++) {
      D[i] = Math.max(H[i * NP + i], 1e-10 * dmax);
      // increments sitting on a bound that the gradient pushes against stay there for this step
      fixed[i] = i >= 6 && ((q[i] <= 0 && g[i] > 0) || (q[i] >= 1 && g[i] < 0)) ? 1 : 0;
    }
    if (!solveDamped(H, D, g, fixed, lambda, L, step)) {
      lambda *= 10;
      if (lambda > 1e15) break;
      continue;
    }
    let stepMax = 0;
    for (let i = 0; i < NP; i++) {
      let t = q[i] + step[i];
      if (i >= 6) t = t < 0 ? 0 : t > 1 ? 1 : t; // projection onto the bounds
      trial[i] = t;
      step[i] = t - q[i];
      stepMax = Math.max(stepMax, Math.abs(step[i]));
    }
    if (stepMax < 1e-13) break;
    // reduction predicted by the quadratic model for the projected step
    let pred = 0;
    for (let i = 0; i < NP; i++) {
      if (step[i] === 0) continue;
      let hs = 0;
      for (let j = 0; j < NP; j++) hs += H[i * NP + j] * step[j];
      pred -= step[i] * (g[i] + 0.5 * hs);
    }
    const trialCost = evaluate(trial, false);
    const actual = cost - trialCost;
    if (actual > 0 && Number.isFinite(trialCost)) {
      const rho = pred > 0 ? actual / pred : 1;
      const t = 2 * rho - 1;
      lambda *= Math.max(1 / 3, 1 - t * t * t);
      if (lambda < 1e-12) lambda = 1e-12;
      nu = 2;
      const tmp = q;
      q = trial;
      trial = tmp;
      small = actual <= FTOL * cost ? small + 1 : 0;
      cost = evaluate(q, true);
      if (small >= 3) break;
    } else {
      lambda *= nu;
      nu *= 2;
      if (lambda > 1e15) break;
    }
  }

  knotsFromIncrements(q, p);
  const M1 = mat6(p);
  const ck: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    const k = new Float64Array(KNOTS);
    let run = 0;
    for (let i = 0; i < KNOTS; i++) {
      const v = p[6 + c * KNOTS + i];
      const cl = v < 0 ? 0 : v > 1 ? 1 : v;
      if (cl > run) run = cl;
      k[i] = run;
    }
    ck.push(k);
  }
  const fitted = slotApply({ M1, ck }, P);
  const de = deltaELab(lab(fitted), prob.labT);
  if (progress) progress(1);
  return { M1, ck, meanDE: mean(de), p95DE: percentile(de, 95), cost: robustCost({ M1, ck }, P, target), iterations };
}

// Exposed for tests: finite-difference check of the analytic derivatives.
export function _gradientCheck(P: Float64Array, target: Float64Array, p: Float64Array): { analytic: Float64Array; numeric: Float64Array } {
  const prob = new Problem(P, target);
  prob.evaluate(p, true);
  const analytic = Float64Array.from(prob.g);
  const numeric = new Float64Array(NP);
  const q = Float64Array.from(p);
  for (let i = 0; i < NP; i++) {
    const h = 1e-6;
    q[i] = p[i] + h;
    const up = prob.evaluate(q, false);
    q[i] = p[i] - h;
    const dn = prob.evaluate(q, false);
    q[i] = p[i];
    numeric[i] = (up - dn) / (2 * h);
  }
  return { analytic, numeric };
}
