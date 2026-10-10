// Conversion of a film-look preset into the parameters of one GR IV Image Control slot.
import { slotApply } from './camera';
import type { SlotParams } from './camera';
import { applyCube, parseCube } from './cube';
import { CAL_ADOBE, CAL_CAM } from './data';
import { fitSlot } from './fit';
import { FullLook } from './look';
import { linToSrgb, srgbToLin } from './math';
import { parseXmp } from './xmp';

export type { SlotParams } from './camera';

export interface Conversion {
  kind: 'xmp' | 'cube';
  title: string;
  params: SlotParams;
  /** Mean / 95th percentile CIE76 error of the slot against the look on the fitting colours. */
  meanDE: number;
  p95DE: number;
  warnings: string[];
  unsupported: string[];
}

export interface ConvertOptions {
  onProgress?: (fraction: number) => void;
  /** Fit the post-curve ("second") matrix as well (default true). */
  post?: boolean;
}

const subProgress = (opts: ConvertOptions | undefined, from: number, to: number) =>
  opts?.onProgress ? (f: number): void => opts.onProgress!(from + (to - from) * f) : undefined;

/**
 * Convert an .xmp Look profile / preset. The look is applied to the Adobe Standard rendering of
 * the calibration colours and the slot is fitted so that the camera reproduces it starting from
 * its own Standard rendering of the same colours. Errors are reported on those 1026 colours.
 */
export function convertXmp(text: string, opts?: ConvertOptions): Conversion {
  const look = parseXmp(text);
  opts?.onProgress?.(0.05);
  const target = new FullLook(look).apply(Float64Array.from(CAL_ADOBE));
  opts?.onProgress?.(0.1);
  const fit = fitSlot(Float64Array.from(CAL_CAM), target, { onProgress: subProgress(opts, 0.1, 1), post: opts?.post !== false });
  return {
    kind: 'xmp',
    title: look.title,
    params: fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck },
    meanDE: fit.meanDE,
    p95DE: fit.p95DE,
    warnings: look.warnings.slice(),
    unsupported: look.unsupported.slice(),
  };
}

// ---------------------------------------------------------------- fitting colours for cube LUTs

/** Small seeded PRNG (mulberry32), uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u <= 1e-300) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, 1) for shape >= 1 (Marsaglia-Tsang). */
function gamma(shape: number, rand: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = gaussian(rand);
    const v = 1 + c * x;
    if (v <= 0) continue;
    const v3 = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v3;
    if (Math.log(u > 0 ? u : 1e-300) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) return d * v3;
  }
}

function beta(a: number, b: number, rand: () => number): number {
  const x = gamma(a, rand);
  const y = gamma(b, rand);
  return x / (x + y);
}

function hsvToRgb(h: number, s: number, v: number, out: Float64Array, o: number): void {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (((i % 6) + 6) % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

/** The 24 ColorChecker patches, 8-bit sRGB. */
const CC24: readonly number[] = [
  115, 82, 68, 194, 150, 130, 98, 122, 157, 87, 108, 67, 133, 128, 177, 103, 189, 170, 214, 126, 44, 80, 91, 166,
  193, 90, 99, 94, 60, 108, 157, 188, 64, 224, 163, 46, 56, 61, 150, 70, 148, 73, 175, 54, 60, 231, 199, 31,
  187, 86, 149, 8, 133, 161, 243, 243, 242, 200, 200, 200, 160, 160, 160, 122, 122, 121, 85, 85, 85, 52, 52, 52,
];
const CC_GAINS = [0.35, 0.6, 1.0, 1.5];

export const SYNTHETIC_COUNT = 3000;
const CC_REPEAT = 6;
const SYNTHETIC_SEED = 1;

/**
 * Deterministic synthetic colours (sRGB-encoded): random hue, saturation ~ Beta(1.6, 3.0),
 * value ~ Beta(2.0, 1.6), followed by the ColorChecker patches at four exposure gains, repeated
 * for weight (the idea of `samples()` in xmp2gr4.py).
 */
export function syntheticSamples(count: number = SYNTHETIC_COUNT, seed: number = SYNTHETIC_SEED, ccRepeat: number = CC_REPEAT): Float64Array {
  const rand = mulberry32(seed);
  const nCc = (CC24.length / 3) * CC_GAINS.length * ccRepeat;
  const out = new Float64Array((count + nCc) * 3);
  for (let i = 0; i < count; i++) {
    const h = rand();
    const s = beta(1.6, 3.0, rand);
    const v = beta(2.0, 1.6, rand);
    hsvToRgb(h, s, v, out, i * 3);
  }
  let o = count * 3;
  for (const gain of CC_GAINS)
    for (let k = 0; k < CC24.length; k += 3)
      for (let rep = 0; rep < ccRepeat; rep++)
        for (let c = 0; c < 3; c++) out[o++] = linToSrgb(srgbToLin(CC24[k + c] / 255) * gain);
  return out;
}

/** Fitting colours for cube LUTs: the camera calibration colours followed by the synthetic set. */
export function cubeFitSamples(): Float64Array {
  const syn = syntheticSamples();
  const out = new Float64Array(CAL_CAM.length + syn.length);
  out.set(CAL_CAM, 0);
  out.set(syn, CAL_CAM.length);
  return out;
}

/**
 * Convert a .cube LUT. The LUT is taken to act on an sRGB display image, so the target is simply
 * cube(P) where P are colours as output by the camera's Standard preset. Errors are reported on
 * the fitting set (calibration colours plus synthetic colours).
 */
export function convertCube(text: string, opts?: ConvertOptions): Conversion {
  const cube = parseCube(text);
  opts?.onProgress?.(0.05);
  const P = cubeFitSamples();
  const target = applyCube(cube, P);
  opts?.onProgress?.(0.1);
  const fit = fitSlot(P, target, { onProgress: subProgress(opts, 0.1, 1), post: opts?.post !== false });
  return {
    kind: 'cube',
    title: cube.title,
    params: fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck },
    meanDE: fit.meanDE,
    p95DE: fit.p95DE,
    warnings: [],
    unsupported: [],
  };
}

/** What the camera would output with these slot parameters for colours it renders as `rgb` in Standard. */
export function previewSlot(params: SlotParams, rgb: Float64Array): Float64Array {
  return slotApply(params, rgb);
}
