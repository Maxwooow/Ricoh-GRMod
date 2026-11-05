// SPDX-License-Identifier: GPL-2.0-only
/** Lossless CUBE intake plus a separate IIIx matrix/RGB-curve fit. */
import { applyCube, parseCube } from './cube';
import { ColorError } from './math';
import { sha256Hex } from '../fw/container';
import { extraFitSamples, guardedRefine, syntheticSamples } from './convert';
import type { Conversion, ConvertOptions } from './convert';
import { fitSlot } from './fit';
import { deltaE2000Lab, deltaELab, lab, mean, percentile } from './math';
import { GR3X_CAMERA } from './gr3x-camera';
import { parseXmp } from './xmp';
import { FullLook } from './look';
import { KN, KNOTS } from './camera';
import type { SlotParams } from './camera';

export interface Gr3xCubeImport {
  schema: 1;
  kind: 'gr3x-cube-source';
  title: string;
  sourceText: string;
  sourceSha256: string;
  size1D: number;
  size3D: number;
  inputEncoding: 'srgb-display';
  firmwareEncoding: 'matrix-rgb-curve-fit';
  cameraRenderingVerified: false;
}

/** CUBE has no dependable color-space tag. Log/scene-linear input must be converted
 * to an sRGB-display LUT by its author before choosing this explicit encoding. */
export async function importGr3xCube(text: string, inputEncoding: 'srgb-display'): Promise<Gr3xCubeImport> {
  if (inputEncoding !== 'srgb-display') throw new ColorError('bad-input', 'an sRGB-display CUBE is required');
  if (typeof text !== 'string' || text.length > 32 * 1024 * 1024)
    throw new ColorError('bad-input', 'CUBE source is missing or exceeds 32 MiB of text');
  const cube = parseCube(text);
  return {
    schema: 1, kind: 'gr3x-cube-source', title: cube.title, sourceText: text,
    sourceSha256: await sha256Hex(new TextEncoder().encode(text)),
    size1D: cube.size1D, size3D: cube.size3D, inputEncoding,
    firmwareEncoding: 'matrix-rgb-curve-fit', cameraRenderingVerified: false,
  };
}

/** Exact software LUT evaluation, distinct from the fitted camera preview. */
export async function previewGr3xCube(source: Gr3xCubeImport, rgb: Float64Array): Promise<Float64Array> {
  if (!source || source.schema !== 1 || source.kind !== 'gr3x-cube-source' || source.inputEncoding !== 'srgb-display' ||
      source.firmwareEncoding !== 'matrix-rgb-curve-fit' || source.cameraRenderingVerified !== false)
    throw new ColorError('bad-input', 'not an offline IIIx CUBE source');
  if (!(rgb instanceof Float64Array) || rgb.length % 3 || Array.from(rgb).some(v => !Number.isFinite(v)))
    throw new ColorError('bad-input', 'preview input must contain finite RGB triples');
  const checked = await importGr3xCube(source.sourceText, source.inputEncoding);
  if (checked.sourceSha256 !== source.sourceSha256 || checked.size1D !== source.size1D || checked.size3D !== source.size3D)
    throw new ColorError('bad-input', 'CUBE source or its metadata was changed');
  return applyCube(parseCube(source.sourceText), rgb);
}

/**
 * Black-and-white and toned black-and-white looks (a Leica Selenium, Sepia or Blue, a Lightroom B&W
 * profile): the colour of the output depends only on one brightness of the input. GR III's format
 * holds such a look exactly as one row of weights for all three channels (the same brightness for
 * R, G and B) and a curve per channel (the toning), without a second matrix. The general fit does
 * not keep the rows equal, and colours then come out tinted (magenta or brown on a Selenium look).
 *
 * A look counts as such when, grouped by output brightness, every channel varies by less than
 * TONED_RMS (rms) around its group's mean: then the weights are fitted on the neutral target and the
 * three curves by least squares on the brightness the camera computes with them.
 */
const TONED_RMS = 0.012;

/** True when every output channel is (nearly) a function of the output brightness. */
export function isTonedMonochrome(target: Float64Array): boolean {
  const n = target.length / 3, BINS = 96;
  const sum = new Float64Array(BINS * 3), sq = new Float64Array(BINS * 3), cnt = new Float64Array(BINS);
  for (let i = 0; i < n; i++) {
    const y = (target[i * 3] + target[i * 3 + 1] + target[i * 3 + 2]) / 3;
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(y * BINS)));
    cnt[b]++;
    for (let c = 0; c < 3; c++) { const v = target[i * 3 + c]; sum[b * 3 + c] += v; sq[b * 3 + c] += v * v; }
  }
  let ss = 0;
  for (let b = 0; b < BINS; b++) if (cnt[b]) for (let c = 0; c < 3; c++) { const m = sum[b * 3 + c] / cnt[b]; ss += sq[b * 3 + c] - cnt[b] * m * m; }
  return Math.sqrt(Math.max(0, ss) / (n * 3)) < TONED_RMS;
}

/** The fit of a toned black-and-white look: equal matrix rows, a curve per channel, no second matrix. */
export function fitTonedMonochrome(P: Float64Array, target: Float64Array, onProgress?: (f: number) => void): SlotParams {
  const n = P.length / 3;
  // The weights: the general fit of the look's brightness alone, its rows averaged (each sums to 1).
  const neutral = new Float64Array(target.length);
  for (let i = 0; i < n; i++) { const y = (target[i * 3] + target[i * 3 + 1] + target[i * 3 + 2]) / 3; neutral[i * 3] = neutral[i * 3 + 1] = neutral[i * 3 + 2] = y; }
  const grey = fitSlot(P, neutral, { camera: GR3X_CAMERA, maxIterations: 250, post: false, onProgress: f => onProgress?.(f * 0.9) });
  const w = [0, 1, 2].map(k => (grey.M1[0][k] + grey.M1[1][k] + grey.M1[2][k]) / 3);
  const ws = w[0] + w[1] + w[2]; w[0] += 1 - ws;
  // The brightness the camera computes with these weights (as slotApply: S^-1, the row, clipped, S).
  const xmax = 255 / 256;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let l = 0;
    for (let k = 0; k < 3; k++) l += w[k] * GR3X_CAMERA.Sinv(P[i * 3 + k]);
    t[i] = GR3X_CAMERA.S(l < 0 ? 0 : l > xmax ? xmax : l);
  }
  // Each channel's curve: least squares on the 17 knots (piecewise linear in t) with a light
  // second-difference smoothing where samples are few; kept in 0..1 and non-decreasing.
  const ck = [0, 1, 2].map(c => {
    const A = Array.from({ length: KNOTS }, () => new Float64Array(KNOTS)), rhs = new Float64Array(KNOTS);
    for (let i = 0; i < n; i++) {
      const b = Math.min(1, Math.max(0, t[i])), y = target[i * 3 + c];
      const k = Math.min(KNOTS - 2, Math.floor(b * (KNOTS - 1))), f = (b - KN[k]) / (KN[k + 1] - KN[k]);
      const idx = [k, k + 1], wt = [1 - f, f];
      for (let a = 0; a < 2; a++) { rhs[idx[a]] += wt[a] * y; for (let d = 0; d < 2; d++) A[idx[a]][idx[d]] += wt[a] * wt[d]; }
    }
    const lambda = 1e-3 * n / KNOTS;
    for (let k = 1; k < KNOTS - 1; k++) {
      const idx = [k - 1, k, k + 1], cf = [1, -2, 1];
      for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) A[idx[a]][idx[d]] += lambda * cf[a] * cf[d];
    }
    const x = solve(A, rhs);
    const out = new Float64Array(KNOTS);
    let run = 0;
    for (let k = 0; k < KNOTS; k++) { const v = Math.min(1, Math.max(0, x[k])); run = Math.max(run, v); out[k] = run; }
    return out;
  });
  onProgress?.(1);
  return { M1: [w.slice(), w.slice(), w.slice()], ck };
}

/** Gaussian elimination with partial pivoting (small dense systems). */
function solve(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length, M = A.map(r => Float64Array.from(r)), v = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]]; [v[i], v[p]] = [v[p], v[i]];
    const d = M[i][i] || 1e-12;
    for (let r = i + 1; r < n; r++) { const f = M[r][i] / d; if (!f) continue; for (let c = i; c < n; c++) M[r][c] -= f * M[i][c]; v[r] -= f * v[i]; }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = v[i]; for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c]; x[i] = s / (M[i][i] || 1e-12); }
  return x;
}

/** Fit display-referred sRGB CUBE data to IIIx's actual matrix/curve format.
 * The reference curve comes from IIIx native code; no GR IV calibration is used.
 * Independent validation samples estimate approximation error, not camera accuracy.
 */
export function convertGr3xCube(text: string, options: ConvertOptions & { legacyFit?: boolean } = {}): Conversion {
  if (text.length > 32 * 1024 * 1024) throw new ColorError('bad-input', 'IIIx CUBE exceeds 32 MiB');
  const cube = parseCube(text);
  // As GR IV since 0.8.4 (PR #7): the synthetic colours plus a dense grey ramp, the LUT grid's
  // corners and skin tones; with `refine`, the guarded CIEDE2000 refinement on the IIIx model.
  // `legacyFit`: the colours up to GR Mod 0.8.2 only (to rebuild the camera-tested round 7 files).
  const base = syntheticSamples(2200, 160, 4), extra = options.legacyFit ? new Float64Array(0) : extraFitSamples();
  const P = new Float64Array(base.length + extra.length);
  P.set(base, 0); P.set(extra, base.length);
  options.onProgress?.(0.05);
  const target = applyCube(cube, P);
  // Black-and-white and toned black-and-white looks: equal rows, a curve per channel (see above).
  const toned = !options.legacyFit && isTonedMonochrome(target);
  const refine = options.refine === true && !options.legacyFit && !toned;
  let params: SlotParams;
  if (toned) params = fitTonedMonochrome(P, target, f => options.onProgress?.(0.05 + f * 0.9));
  else {
    const fit = fitSlot(P, target, {
      camera: GR3X_CAMERA, maxIterations: 250, post: options.post === true,
      onProgress: f => options.onProgress?.(0.05 + f * (refine ? 0.5 : 0.9)),
    });
    params = fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck };
  }
  let refined: boolean | undefined;
  if (refine) {
    const r = guardedRefine(cube, params, f => options.onProgress?.(0.55 + f * 0.4), GR3X_CAMERA);
    refined = r !== null;
    if (r) params = r;
  }
  const validation = syntheticSamples(1100, 161, 1);
  const got = lab(GR3X_CAMERA.slotApply(params, validation)), want = lab(applyCube(cube, validation));
  const errors = deltaELab(got, want), errors00 = deltaE2000Lab(got, want);
  const meanDE = mean(errors), p95DE = percentile(errors, 95);
  const warnings = [
    'IIIx: sRGB display LUT only. Matrix/RGB-curve approximation; preview is a software reference, not measured camera color.',
    'Keep a full-frame RAW. In-camera RAW development falls back to the original base Image Control.',
  ];
  if (p95DE > 6) warnings.push('Large color differences in parts of this LUT; compare the preview before exporting.');
  options.onProgress?.(1);
  return { kind: 'cube', title: cube.title, params, meanDE, p95DE, meanDE2000: mean(errors00), p95DE2000: percentile(errors00, 95),
    ...(refined !== undefined ? { refined } : {}), warnings, unsupported: [] };
}

/** Lightroom .xmp look (Look profile / preset with its RGB table and curves) for GR III / IIIx.
 * The look is applied to display-sRGB colours, as Lightroom applies it to Adobe Standard; the
 * camera's own Standard rendering stands in for Adobe Standard (no GR III calibration pair exists,
 * unlike GR IV). The result is fitted to the camera's matrix/RGB-curve format like a CUBE. */
export function convertGr3xXmp(text: string, options: ConvertOptions = {}): Conversion {
  if (text.length > 32 * 1024 * 1024) throw new ColorError('bad-input', 'XMP exceeds 32 MiB');
  const look = parseXmp(text);
  const full = new FullLook(look);
  const P = syntheticSamples(2200, 160, 4);
  options.onProgress?.(0.05);
  const target = full.apply(P);
  const fit: SlotParams = isTonedMonochrome(target) ? fitTonedMonochrome(P, target, f => options.onProgress?.(0.05 + f * 0.9))
    : fitSlot(P, target, {
      camera: GR3X_CAMERA, maxIterations: 250, post: options.post === true,
      onProgress: f => options.onProgress?.(0.05 + f * 0.9),
    });
  const validation = syntheticSamples(1100, 161, 1);
  const got = lab(GR3X_CAMERA.slotApply(fit, validation)), want = lab(full.apply(validation));
  const errors = deltaELab(got, want), errors00 = deltaE2000Lab(got, want);
  const meanDE = mean(errors), p95DE = percentile(errors, 95);
  const warnings = [
    ...look.warnings,
    'GR III / IIIx: the look is applied to the camera\'s Standard rendering in place of Adobe Standard, then fitted to its matrix/RGB curves.',
    'Keep a full-frame RAW. In-camera RAW development falls back to the original base Image Control.',
  ];
  if (p95DE > 6) warnings.push('Large color differences in parts of this look; compare the preview before exporting.');
  options.onProgress?.(1);
  return { kind: 'xmp', title: look.title, params: { M1: fit.M1, ck: fit.ck, ...(fit.P2 ? { P2: fit.P2 } : {}) },
    meanDE, p95DE, meanDE2000: mean(errors00), p95DE2000: percentile(errors00, 95), warnings, unsupported: look.unsupported.slice() };
}
