// Perceptual (CIEDE2000) refinement of a fitted camera slot. Optional, OFF by default (see
// `ConvertOptions.refine` in convert.ts).
//
// The RGB fit in `fit.ts` minimises CIELAB (CIE76) differences. This stage starts from that result
// and refines the same camera model parameters (look matrix 6, post matrix 6 when the start has
// one, and a correction of each 17-knot curve) against weighted CIEDE2000 differences.
//
// Why it is off by default: on a benchmark of eleven synthetic film looks (whole 33^3 LUT grid,
// a 256-step grey ramp, skin tones at several exposures, saturated colours, all measured after the
// firmware quantisation) it lowered the whole-grid p95 and the saturated-colour error, but it made
// the neutral axis and skin tones worse on several looks (worst grey up to 2.1 -> 4.7 dE00, skin on
// a strong teal/orange look 1.4 -> 4.6 dE00), because the hue-wheel samples carried most of the
// weight. With greys weighted up and the guard in convert.ts the grey regressions go away, but the
// skin trade-off remains on strong looks, so the plain fit stays the default.
//
// It is the same idea as the `lab_fit` stage in DARKSLIDE GR's `gr3_lut_fit.py` (itself a port of
// gr3-film-mods' lab_fit.py, MIT); this implementation is GR Mod's own, works on the GR IV model and
// uses the model's 17-knot curves directly.
import { KNOTS, slotApply } from './camera';
import type { CameraToneModel, SlotParams } from './camera';
import { ColorError, lab, deltaE2000Lab } from './math';
import { mat6 } from './fit';
import { HUE_SOFT_LIMIT_Q10, hueKinkMatrix, hueMatricesFromD } from './hue';

export interface RefineOptions {
  /** Per-sample weights; defaults to 1. */
  weights?: ArrayLike<number>;
  /** Solver iterations (default 8). */
  iterations?: number;
  /** Called with 0..1 after each iteration. */
  onProgress?: (fraction: number) => void;
  /** The camera model (default the GR IV's; GR III / IIIx pass theirs). */
  camera?: CameraToneModel;
  /**
   * Minimise (a smooth form of) the weighted MEAN CIEDE2000 instead of the mean of its squares.
   * Default false (the refinement as released).
   */
  meanObjective?: boolean;
  /** With `meanObjective`: weight of the squared error added to the mean, so large errors still count (default 0). */
  tail?: number;
  /**
   * With `meanObjective`: CIEDE2000 each colour must not exceed (e.g. what the look it replaces
   * reaches). A colour that ends up more than `ceilingMargin` above it is charged `ceilingWeight`
   * times the square of the excess, so the fit improves colours without trading others away.
   */
  ceiling?: ArrayLike<number>;
  ceilingWeight?: number;
  ceilingMargin?: number;
}

/** Residual of one colour for the least-squares solver: de itself (squares) or its square root (mean of de). */
const SMOOTH = 0.1;
function residual(w: number, de: number, mean: boolean, tail = 0, over = 0): number {
  return mean ? Math.sqrt(w * (Math.sqrt(de * de + SMOOTH * SMOOTH) + tail * de * de + over * over)) : Math.sqrt(w) * de;
}

/** Excess over the ceiling, scaled so that its square is the charge (0 without a ceiling). */
function overshoot(opts: RefineOptions, i: number, de: number): number {
  if (!opts.ceiling) return 0;
  const e = de - opts.ceiling[i] - (opts.ceilingMargin ?? 0.05);
  return e > 0 ? Math.sqrt(opts.ceilingWeight ?? 20) * e : 0;
}

export interface RefineResult extends SlotParams {
  meanDE2000: number;
  p95DE2000: number;
  iterations: number;
}

const NK = KNOTS;
const CURVE_PARAMS = 3 * NK;

function offdiag(m: readonly (readonly number[])[]): number[] {
  return [m[0][1], m[0][2], m[1][0], m[1][2], m[2][0], m[2][1]];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Base knots plus a correction, clamped and kept non-decreasing (the camera needs a monotone curve). */
function correctedCurves(base: readonly Float64Array[], corr: Float64Array): Float64Array[] {
  const out: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    const row = new Float64Array(NK);
    let top = 0;
    for (let k = 0; k < NK; k++) {
      const v = clamp01(base[c][k] + corr[c * NK + k]);
      top = Math.max(top, v);
      row[k] = top;
    }
    out.push(row);
  }
  return out;
}

function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  // Gaussian elimination with partial pivoting on a copy.
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r * n + i]) > Math.abs(M[piv * n + i])) piv = r;
    if (Math.abs(M[piv * n + i]) < 1e-18) return null;
    if (piv !== i) {
      for (let c = i; c < n; c++) { const t = M[i * n + c]; M[i * n + c] = M[piv * n + c]; M[piv * n + c] = t; }
      const t = x[i]; x[i] = x[piv]; x[piv] = t;
    }
    const d = M[i * n + i];
    for (let r = i + 1; r < n; r++) {
      const f = M[r * n + i] / d;
      if (f === 0) continue;
      for (let c = i; c < n; c++) M[r * n + c] -= f * M[i * n + c];
      x[r] -= f * x[i];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let c = i + 1; c < n; c++) s -= M[i * n + c] * x[c];
    x[i] = s / M[i * n + i];
  }
  return x;
}

/**
 * Refine `params` against `target` on the sRGB-encoded samples `P`. The post matrix is refined
 * only when `params` has one (none is added). Returns a new parameter set; `params` is not modified.
 */
export function refineSlot(params: SlotParams, P: Float64Array, target: Float64Array, opts: RefineOptions = {}): RefineResult {
  if (P.length === 0 || P.length % 3 !== 0 || target.length !== P.length)
    throw new ColorError('bad-input', 'refineSlot needs two equally long buffers of RGB triples');
  const nSamples = P.length / 3;
  const weights = opts.weights ?? new Float64Array(nSamples).fill(1);
  if (weights.length !== nSamples) throw new ColorError('bad-input', 'refineSlot: wrong weight count');
  const iterations = opts.iterations ?? 8;
  const labT = lab(target);
  const hasPost = !!params.P2;
  const apply = opts.camera ? opts.camera.slotApply.bind(opts.camera) : slotApply;

  const M0 = offdiag(params.M1);
  const P0 = hasPost ? offdiag(params.P2!) : [];
  const baseCurves = params.ck;
  // parameters: 6 look matrix, then (with a post matrix) 6 post matrix, then 3 x 17 curve corrections
  const curveAt = hasPost ? 12 : 6;
  const nParam = curveAt + CURVE_PARAMS;
  const steps = new Float64Array(nParam);
  for (let i = 0; i < curveAt; i++) steps[i] = 1e-4;
  for (let i = curveAt; i < nParam; i++) steps[i] = 0.01;

  const x = new Float64Array(nParam);
  const unpack = (v: Float64Array): SlotParams => {
    const M1 = mat6(M0.map((b, i) => b + v[i]));
    const ck = correctedCurves(baseCurves, v.subarray(curveAt));
    const out: SlotParams = hasPost ? { M1, ck, P2: mat6(P0.map((b, i) => b + v[6 + i])) } : { M1, ck };
    if (params.hue) out.hue = params.hue; // hue sectors are carried unchanged
    return out;
  };

  const residuals = (v: Float64Array, out?: Float64Array): Float64Array => {
    const de = deltaE2000Lab(lab(apply(unpack(v), P)), labT);
    const r = out ?? new Float64Array(nSamples);
    for (let i = 0; i < nSamples; i++) r[i] = residual(weights[i], de[i], opts.meanObjective === true, opts.tail, opts.meanObjective === true ? overshoot(opts, i, de[i]) : 0);
    return r;
  };

  const r = residuals(x);
  let cost = 0;
  for (let i = 0; i < nSamples; i++) cost += r[i] * r[i];
  let lambda = 1e-3;
  const J = new Float64Array(nParam * nSamples);
  const JTJ = new Float64Array(nParam * nParam);
  const JTr = new Float64Array(nParam);
  const trial = new Float64Array(nParam);
  const rTrial = new Float64Array(nSamples);
  let done = 0;

  for (let it = 0; it < iterations; it++) {
    done = it + 1;
    // Numerical Jacobian, forward differences.
    for (let k = 0; k < nParam; k++) {
      trial.set(x);
      trial[k] += steps[k];
      const rk = residuals(trial, rTrial);
      const col = k * nSamples;
      for (let i = 0; i < nSamples; i++) J[col + i] = (rk[i] - r[i]) / steps[k];
    }
    for (let a = 0; a < nParam; a++) {
      JTr[a] = 0;
      for (let i = 0; i < nSamples; i++) JTr[a] += J[a * nSamples + i] * r[i];
      for (let b = 0; b <= a; b++) {
        let s = 0;
        for (let i = 0; i < nSamples; i++) s += J[a * nSamples + i] * J[b * nSamples + i];
        JTJ[a * nParam + b] = s;
        JTJ[b * nParam + a] = s;
      }
    }
    let accepted = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const A = Float64Array.from(JTJ);
      for (let a = 0; a < nParam; a++) {
        const d = JTJ[a * nParam + a];
        A[a * nParam + a] += lambda * (d > 1e-30 ? d : 1);
      }
      const dx = solve(A, Float64Array.from(JTr, (v) => -v), nParam);
      if (!dx) { lambda *= 10; continue; }
      for (let a = 0; a < nParam; a++) trial[a] = x[a] + dx[a];
      const rt = residuals(trial, rTrial);
      let c = 0;
      for (let i = 0; i < nSamples; i++) c += rt[i] * rt[i];
      if (c < cost) {
        x.set(trial);
        r.set(rt);
        cost = c;
        lambda = Math.max(lambda / 3, 1e-8);
        accepted = true;
        break;
      }
      lambda *= 6;
    }
    opts.onProgress?.((it + 1) / iterations);
    if (!accepted) break;
  }

  const out = unpack(x);
  const de = deltaE2000Lab(lab(apply(out, P)), labT);
  const sorted = Array.from(de).sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    ...out,
    meanDE2000: mean,
    p95DE2000: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)],
    iterations: done,
  };
}

// ------------------------------------------------------------------ hue sectors
export interface HueRefineOptions extends RefineOptions {
  /** Start parameters (36, layout of `hueMatricesFromD`); default all zero = identity. */
  init?: ArrayLike<number>;
  /** Weight of the size penalty on the parameters (GR4-LUTSmith: 0.02), relative to the mean CIEDE2000. */
  ridge?: number;
  /** Weight of the seam penalty at the sector edges (GR4-LUTSmith tries 0.3 .. 100), same scale. */
  kink?: number;
}

export interface HueRefineResult extends SlotParams {
  /** 12 x 9 float matrices (Q10 scale), ready for `hueQuantize`. */
  hue: number[][];
  /** The 36 parameters the matrices were built from (a warm start for another round). */
  d: Float64Array;
}

/**
 * Fit the 12 x 3 hue-sector parameters (the same parametrisation the camera's multi-axis block
 * uses) with the look matrix, curves and post matrix held at `params`. The identity start leaves
 * the base fit unchanged; colours whose hue the base model cannot follow get a sector matrix.
 *
 * The objective is the weighted mean CIEDE2000 (as `convertCube` reports it) plus, as in
 * GR4-LUTSmith, a small size penalty, a penalty on the jump between neighbouring sectors at their
 * edges, and a steep penalty on matrix entries beyond what the firmware block can hold.
 */
export function refineHue(params: SlotParams, P: Float64Array, target: Float64Array, opts: HueRefineOptions = {}): HueRefineResult {
  const nSamples = P.length / 3;
  if (target.length !== P.length) throw new Error('refineHue: P and target differ in length');
  const weights = opts.weights ?? new Float64Array(nSamples).fill(1);
  const iterations = opts.iterations ?? 6;
  const apply = opts.camera ? opts.camera.slotApply.bind(opts.camera) : slotApply;
  const labT = lab(target);
  const base: SlotParams = { M1: params.M1, ck: params.ck, ...(params.P2 ? { P2: params.P2 } : {}) };
  const NP = 36;
  const x = new Float64Array(NP);
  if (opts.init) for (let k = 0; k < NP; k++) x[k] = opts.init[k];
  const steps = new Float64Array(NP).fill(0.01);
  let wsum = 0;
  for (let i = 0; i < nSamples; i++) wsum += weights[i];
  const ridgeW = Math.sqrt((wsum * (opts.ridge ?? 0.02)) / 12);
  const kinkW = Math.sqrt((wsum * (opts.kink ?? 1)) / 12);
  const rangeW = Math.sqrt(wsum * 1e3);
  const K = hueKinkMatrix();
  const limit = HUE_SOFT_LIMIT_Q10 / 1024;
  const nRes = nSamples + NP + NP + 108;

  const build = (v: ArrayLike<number>): SlotParams => ({ ...base, hue: hueMatricesFromD(v) });
  const residuals = (v: Float64Array, out?: Float64Array): Float64Array => {
    const q = build(v);
    const de = deltaE2000Lab(lab(apply(q, P)), labT);
    const r = out ?? new Float64Array(nRes);
    for (let i = 0; i < nSamples; i++) r[i] = residual(weights[i], de[i], true, opts.tail, overshoot(opts, i, de[i]));
    let o = nSamples;
    for (let k = 0; k < NP; k++) r[o++] = ridgeW * v[k];
    for (let j = 0; j < NP; j++) {
      let s = 0;
      for (let k = 0; k < NP; k++) s += K[j * NP + k] * v[k];
      r[o++] = kinkW * s;
    }
    for (const m of q.hue!) for (let e = 0; e < 9; e++) { const a = Math.abs(m[e]) - limit; r[o++] = a > 0 ? rangeW * a : 0; }
    return r;
  };

  const r = residuals(x);
  let cost = 0;
  for (let i = 0; i < nRes; i++) cost += r[i] * r[i];
  let lambda = 1e-3;
  const J = new Float64Array(NP * nRes);
  const JTJ = new Float64Array(NP * NP);
  const JTr = new Float64Array(NP);
  const trial = new Float64Array(NP);
  const rTrial = new Float64Array(nRes);

  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < NP; k++) {
      trial.set(x);
      trial[k] += steps[k];
      const rk = residuals(trial, rTrial);
      for (let i = 0; i < nRes; i++) J[k * nRes + i] = (rk[i] - r[i]) / steps[k];
    }
    for (let a = 0; a < NP; a++) {
      JTr[a] = 0;
      for (let i = 0; i < nRes; i++) JTr[a] += J[a * nRes + i] * r[i];
      for (let b = 0; b <= a; b++) {
        let s = 0;
        for (let i = 0; i < nRes; i++) s += J[a * nRes + i] * J[b * nRes + i];
        JTJ[a * NP + b] = s;
        JTJ[b * NP + a] = s;
      }
    }
    let accepted = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const A = Float64Array.from(JTJ);
      for (let a = 0; a < NP; a++) {
        const d = JTJ[a * NP + a];
        A[a * NP + a] += lambda * (d > 1e-30 ? d : 1);
      }
      const dx = solve(A, Float64Array.from(JTr, (v) => -v), NP);
      if (!dx) { lambda *= 10; continue; }
      for (let a = 0; a < NP; a++) trial[a] = x[a] + dx[a];
      const rt = residuals(trial, rTrial);
      let c = 0;
      for (let i = 0; i < nRes; i++) c += rt[i] * rt[i];
      if (c < cost) {
        x.set(trial); r.set(rt); cost = c;
        lambda = Math.max(lambda / 3, 1e-8);
        accepted = true;
        break;
      }
      lambda *= 6;
    }
    opts.onProgress?.((it + 1) / iterations);
    if (!accepted) break;
  }

  const q = build(x);
  return { ...q, hue: q.hue!, d: x };
}
