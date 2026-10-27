// Conversion of a film-look preset into the parameters of one GR IV Image Control slot.
import { slotApply } from './camera';
import type { CameraToneModel, SlotParams } from './camera';
import { applyCube, parseCube } from './cube';
import { CAL_ADOBE, CAL_CAM } from './data';
import { fitSlot } from './fit';
import { refineSlot } from './refine';
import { fitHue } from './hue-fit';
import { hueToQ10 } from './hue';
import { FullLook } from './look';
import { deltaE, deltaE2000Lab, lab, linToSrgb, mean, percentile, srgbToLin } from './math';
import { parseXmp } from './xmp';

export type { SlotParams } from './camera';

export interface Conversion {
  kind: 'xmp' | 'cube';
  title: string;
  params: SlotParams;
  /**
   * Mean / 95th percentile CIE76 error of the slot against the look on the reporting colours: the
   * calibration colours for .xmp, the calibration plus synthetic colours (`cubeFitSamples`) for
   * .cube. These sets are fixed, so the numbers stay comparable across fitting changes (the .cube
   * fit itself uses more colours, see `cubeFitSamplesExpanded`).
   */
  meanDE: number;
  p95DE: number;
  /** The same as CIEDE2000, on the same colours. */
  meanDE2000: number;
  p95DE2000: number;
  /** .cube with `refine`: whether the CIEDE2000 refinement was kept (false: the guard rejected it). */
  refined?: boolean;
  /** .cube with `hueStd`: the slot's own hue sectors (copy 0, Q10, 12 x 9) when they were kept. */
  hueQ10?: number[];
  warnings: string[];
  unsupported: string[];
}

export interface ConvertOptions {
  onProgress?: (fraction: number) => void;
  /** Fit the post-curve ("second") matrix as well (default true). */
  post?: boolean;
  /**
   * .cube only: follow the fit with the CIEDE2000 refinement of refine.ts (default false). Off by
   * default because on the benchmark looks it traded neutral / skin accuracy for saturated colours
   * (see refine.ts); when on, the result is kept only if greys and skin do not get worse.
   */
  refine?: boolean;
  /**
   * For an added slot: Standard's hue-sector block (12 matrices, from the firmware).
   * With it the slot also gets hue sectors of its own (hue.ts, hue-fit.ts), kept only if they help
   * clearly closer while greys and skin get at most a little worse (`huePasses`). Off unless given.
   */
  hueStd?: number[][];
}

/** Mean / p95 of CIE76 and CIEDE2000 between two buffers. */
function report(a: Float64Array, b: Float64Array): { meanDE: number; p95DE: number; meanDE2000: number; p95DE2000: number } {
  const d76 = deltaE(a, b);
  const d00 = deltaE2000Lab(lab(a), lab(b));
  return { meanDE: mean(d76), p95DE: percentile(d76, 95), meanDE2000: mean(d00), p95DE2000: percentile(d00, 95) };
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
  const hueStd = opts?.hueStd;
  const fit = fitSlot(Float64Array.from(CAL_CAM), target, { onProgress: subProgress(opts, 0.1, hueStd ? 0.5 : 1), post: opts?.post !== false });
  let params: SlotParams = fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck };
  let hueQ10: number[] | undefined;
  if (hueStd) {
    const h = guardedHueXmp(target, params, hueStd, subProgress(opts, 0.5, 0.98));
    if (h) { params = h.params; hueQ10 = h.hueQ10; }
  }
  return {
    kind: 'xmp',
    title: look.title,
    params,
    ...report(slotApply(params, Float64Array.from(CAL_CAM)), target),
    ...(hueQ10 ? { hueQ10 } : {}),
    warnings: look.warnings.slice(),
    unsupported: look.unsupported.slice(),
  };
}

/**
 * Whether hue sectors are worth using, and how good a candidate is. The whole look must get at
 * least 2% closer. A protected group (greys, near-neutrals, skin) may then get a little worse, by
 * an amount that grows with the overall gain (half of it) but stays within `cap`: a clearly closer
 * look may trade a hardly visible change in skin, never a visible one. Among the candidates that
 * pass, the one with the lowest `huePenalty` is used.
 */
export interface HueCheck { m0: number; m1: number; groups: { a0: number; a1: number; b0: number; b1: number; base: number; cap: number }[] }
const huePasses = (c: HueCheck): boolean => {
  if (!(c.m1 < c.m0 * 0.98)) return false;
  const gain = c.m0 - c.m1;
  return c.groups.every((g) => {
    const tol = Math.min(g.cap, Math.max(g.base, 0.5 * gain));
    return g.a1 <= g.a0 + tol && g.b1 <= g.b0 + 2 * tol;
  });
};
const huePenalty = (c: HueCheck): number => c.m1 + c.groups.reduce((s, g) => s + Math.max(0, g.a1 - g.a0), 0);
/** Tolerances: [base, cap] of the mean; the worst values may move twice as much. */
const HUE_TOL = { grey: [0.02, 0.06], near: [0.03, 0.12], skin: [0.05, 0.15] } as const;

/** Calibration colours (as Standard renders them) the .xmp hue fit leaves out to check itself: every third. */
export const XMP_HUE_HELD_OUT = (i: number): boolean => i % 3 === 2;

/**
 * Hue sectors for an .xmp look. Its target is known only on the calibration colours (the look acts
 * on Adobe Standard, which GR Mod knows for those colours alone), so the sectors are fitted on two
 * thirds of them and checked on the other third (see `huePasses`; the protected groups are its
 * pale colours, chroma below 10, and the skin-like ones).
 */
export function guardedHueXmp(target: Float64Array, start: SlotParams, std: number[][], onProgress?: (f: number) => void): { params: SlotParams; hueQ10: number[] } | null {
  const cam = Float64Array.from(CAL_CAM);
  const n = cam.length / 3;
  const pick = (held: boolean, src: Float64Array): Float64Array => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (XMP_HUE_HELD_OUT(i) === held) out.push(src[3 * i], src[3 * i + 1], src[3 * i + 2]);
    return Float64Array.from(out);
  };
  const fitP = pick(false, cam), fitT = pick(false, target), heldP = pick(true, cam), heldT = pick(true, target);
  const L = lab(fitP);
  const weights = Float64Array.from({ length: fitP.length / 3 }, (_, i) => (Math.hypot(L[3 * i + 1], L[3 * i + 2]) < 10 ? 3 : 1));
  const skinFit = Array.from({ length: fitP.length / 3 }, (_, i) => {
    const c = Math.hypot(L[3 * i + 1], L[3 * i + 2]), h = (Math.atan2(L[3 * i + 2], L[3 * i + 1]) * 180) / Math.PI, l = L[3 * i];
    return l > 30 && l < 88 && c >= 10 && c < 40 && h > 20 && h < 75;
  });
  const groupOf = (P: Float64Array, keep: (l: number, c: number, h: number) => boolean): Float64Array => {
    const l = lab(P), out: number[] = [];
    for (let i = 0; i < P.length / 3; i++) {
      const c = Math.hypot(l[3 * i + 1], l[3 * i + 2]), h = (Math.atan2(l[3 * i + 2], l[3 * i + 1]) * 180) / Math.PI;
      if (keep(l[3 * i], c, h)) out.push(i);
    }
    return Float64Array.from(out);
  };
  const pale = groupOf(heldP, (_l, c) => c < 10), skin = groupOf(heldP, (l, c, h) => l > 30 && l < 88 && c >= 10 && c < 40 && h > 20 && h < 75);
  const base: SlotParams = { ...start, hue: std, hueStd: std };
  const tl = lab(heldT);
  const errs = (p: SlotParams): Float64Array => deltaE2000Lab(lab(slotApply(p, heldP)), tl);
  const stats = (e: Float64Array, idx: Float64Array): [number, number] => {
    const v = idx.length ? Array.from(idx, (i) => e[i]) : [0];
    return [mean(v), percentile(v, 95)];
  };
  const e0 = errs(base);
  const [p0, P0] = stats(e0, pale), [s0, S0] = stats(e0, skin);
  let best: { params: SlotParams; hueQ10: number[]; penalty: number } | null = null;
  // A second try weighs the pale colours and the skin tones more.
  for (const boost of [1, 4]) {
    const w = boost === 1 ? weights : weights.map((v, i) => v * (v > 1 || skinFit[i] ? boost : 1));
    const fitted = fitHue(start, std, fitP, fitT, w, { onProgress: (f) => onProgress?.(boost === 1 ? f * 0.5 : 0.5 + f * 0.5) });
    const q = hueToQ10(fitted.hue!);
    if (!q) continue;
    const out: SlotParams = { ...fitted, hue: Array.from({ length: 12 }, (_, g) => q.slice(g * 9, g * 9 + 9).map((v) => v / 1024)) };
    const e1 = errs(out);
    const [p1, P1] = stats(e1, pale), [s1, S1] = stats(e1, skin);
    const check: HueCheck = { m0: mean(e0), m1: mean(e1), groups: [
      { a0: p0, a1: p1, b0: P0, b1: P1, base: HUE_TOL.near[0], cap: HUE_TOL.near[1] },
      { a0: s0, a1: s1, b0: S0, b1: S1, base: HUE_TOL.skin[0], cap: HUE_TOL.skin[1] },
    ] };
    if (!huePasses(check)) continue;
    const penalty = huePenalty(check);
    if (!best || penalty < best.penalty) best = { params: out, hueQ10: q, penalty };
  }
  return best && { params: best.params, hueQ10: best.hueQ10 };
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

const SKIN_TONES: readonly (readonly [number, number, number])[] = [
  [237, 199, 176], [217, 171, 143], [194, 145, 114], [148, 102, 77],
];

function encodeLinear(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Extra fitting colours: a dense neutral ramp (repeated for weight), the LUT grid corners and skin. */
export function extraFitSamples(): Float64Array {
  const out: number[] = [];
  // 64 neutral steps, six copies: greys must stay grey and the black/white ends must be right.
  for (let c = 0; c < 6; c++) for (let i = 0; i < 64; i++) {
    const v = i / 63;
    out.push(v, v, v);
  }
  // 9^3 grid, including the eight corners the synthetic set rarely reaches.
  for (let b = 0; b < 9; b++) for (let g = 0; g < 9; g++) for (let r = 0; r < 9; r++) out.push(r / 8, g / 8, b / 8);
  // Skin tones at five exposures, in linear light, back to sRGB.
  for (const tone of SKIN_TONES) for (const ev of [-2, -1, 0, 1, 2]) {
    const k = Math.pow(2, ev);
    out.push(...tone.map((v) => encodeLinear(srgbToLin(v / 255) * k)));
  }
  return Float64Array.from(out);
}

/** Fitting colours for the initial RGB fit: the old set plus neutral ramp, corners and skin. */
export function cubeFitSamplesExpanded(): Float64Array {
  const base = cubeFitSamples();
  const extra = extraFitSamples();
  const out = new Float64Array(base.length + extra.length);
  out.set(base, 0);
  out.set(extra, base.length);
  return out;
}

export interface WeightedSamples { P: Float64Array; weights: Float64Array }

/** Weight of each neutral sample in `cubeRefineSamples` (PR #7 used 10, about 10% of the total weight, too little to hold the grey axis). */
const REFINE_GREY_WEIGHT = 60;

/** Independent, weighted samples for the CIEDE2000 refinement (fresh values, not the fit set). */
export function cubeRefineSamples(): WeightedSamples {
  const p: number[] = [], w: number[] = [];
  const add = (r: number, g: number, b: number, weight: number): void => { p.push(r, g, b); w.push(weight); };
  // 48 neutral steps: the most visible errors (about 40% of the total weight).
  for (let i = 0; i < 48; i++) { const v = i / 47; add(v, v, v, REFINE_GREY_WEIGHT); }
  // Hue wheel at three saturations and five values.
  for (let h = 0; h < 24; h++) for (const s of [0.3, 0.6, 0.9]) for (const v of [0.2, 0.35, 0.5, 0.7, 1]) {
    add(...hsvToRgbValue(h / 24, s, v), 8);
  }
  // Skin at five exposures.
  for (const tone of SKIN_TONES) for (const ev of [-2, -1, 0, 1, 2]) {
    const k = Math.pow(2, ev);
    add(encodeLinear(srgbToLin(tone[0] / 255) * k), encodeLinear(srgbToLin(tone[1] / 255) * k), encodeLinear(srgbToLin(tone[2] / 255) * k), 10);
  }
  // Random display colours (a different seed from the fit set).
  const rand = mulberry32(2);
  for (let i = 0; i < 300; i++) add(rand(), rand(), rand(), 2);
  // A 7^3 grid including corners.
  for (let b = 0; b < 7; b++) for (let g = 0; g < 7; g++) for (let r = 0; r < 7; r++) add(r / 6, g / 6, b / 6, 2);
  return { P: Float64Array.from(p), weights: Float64Array.from(w) };
}

function hsvToRgbValue(h: number, s: number, v: number): [number, number, number] {
  const out = new Float64Array(3);
  hsvToRgb(h, s, v, out, 0);
  return [out[0], out[1], out[2]];
}

/** Grey ramp and skin colours the refinement guard checks (mean and worst CIEDE2000). */
function guardSets(): { grey: Float64Array; skin: Float64Array } {
  const grey = new Float64Array(256 * 3);
  for (let i = 0; i < 256; i++) grey.fill(i / 255, i * 3, i * 3 + 3);
  const skin: number[] = [];
  for (const tone of SKIN_TONES) for (const ev of [-2, -1, 0, 1]) skin.push(...tone.map((v) => encodeLinear(Math.min(1, srgbToLin(v / 255) * 2 ** ev))));
  return { grey, skin: Float64Array.from(skin) };
}

function meanMax00(params: SlotParams, P: Float64Array, labT: Float64Array, camera?: CameraToneModel): [number, number] {
  const d = deltaE2000Lab(lab(camera ? camera.slotApply(params, P) : slotApply(params, P)), labT);
  let s = 0, m = 0;
  for (const v of d) { s += v; if (v > m) m = v; }
  return [s / d.length, m];
}

/**
 * CIEDE2000 refinement of a cube fit, kept only if the grey axis and skin do not get worse than
 * the plain fit (mean +0.02 / worst +0.05 dE00 on a 256-step grey ramp, mean +0.05 / worst +0.1 on
 * skin tones). Returns null when the refinement is rejected.
 */
export function guardedRefine(cube: ReturnType<typeof parseCube>, start: SlotParams, onProgress?: (f: number) => void, camera?: CameraToneModel): SlotParams | null {
  const ref = cubeRefineSamples();
  const r = refineSlot(start, ref.P, applyCube(cube, ref.P), { weights: ref.weights, iterations: 8, onProgress, ...(camera ? { camera } : {}) });
  const out: SlotParams = r.P2 ? { M1: r.M1, ck: r.ck, P2: r.P2 } : { M1: r.M1, ck: r.ck };
  const { grey, skin } = guardSets();
  const tg = lab(applyCube(cube, grey)), ts = lab(applyCube(cube, skin));
  const [g0, G0] = meanMax00(start, grey, tg, camera), [g1, G1] = meanMax00(out, grey, tg, camera);
  const [s0, S0] = meanMax00(start, skin, ts, camera), [s1, S1] = meanMax00(out, skin, ts, camera);
  return g1 <= g0 + 0.02 && G1 <= G0 + 0.05 && s1 <= s0 + 0.05 && S1 <= S0 + 0.1 ? out : null;
}

/**
 * Hue sectors of the slot's own after the plain fit, compared in the camera's order with the slot
 * as it renders with Standard's block: kept when the mean CIEDE2000 on the refinement colours
 * drops by at least 0.5%, the grey ramp and the skin tones get no worse (the limits of
 * `guardedRefine`) and every value fits the firmware's range. Returns null when rejected.
 */
/** Mean and 95th percentile CIEDE2000. */
function meanP95(params: SlotParams, P: Float64Array, labT: Float64Array): [number, number] {
  const d = deltaE2000Lab(lab(slotApply(params, P)), labT);
  return [mean(d), percentile(d, 95)];
}

/**
 * Low-saturation colours around the hue circle for the hue-sector fit and its guard: hue sectors
 * act on every colour but pure grey, so near-neutral ones (walls, skies, shadows; most of a
 * typical picture) must not pay for saturated ones. Test 064 on a GR IV showed it: without them
 * a warm look got its pale warm colours worse (camera vs LUT, dE00 0.85 -> 1.35 on them) for
 * better saturated ones. A sector's matrix moves its pale colours in proportion to its saturated
 * ones, which a look that mostly turns saturated colours does not do, so some of that trade is
 * left even with them (the mean and the 95th percentile of these colours may not get worse).
 */
function nearNeutralSamples(offset: number, sats: readonly number[], vals: readonly number[], weight: number): WeightedSamples {
  const p: number[] = [], w: number[] = [];
  for (let h = 0; h < 24; h++) for (const sat of sats) for (const v of vals) { p.push(...hsvToRgbValue((h + offset) / 24, sat, v)); w.push(weight); }
  return { P: Float64Array.from(p), weights: Float64Array.from(w) };
}
const HUE_NEAR_NEUTRAL_WEIGHT = 12;

export function guardedHue(cube: ReturnType<typeof parseCube>, start: SlotParams, std: number[][], onProgress?: (f: number) => void): { params: SlotParams; hueQ10: number[] } | null {
  const refBase = cubeRefineSamples();
  const near = nearNeutralSamples(0, [0.04, 0.08, 0.13, 0.2], [0.3, 0.5, 0.7, 0.85, 0.97], HUE_NEAR_NEUTRAL_WEIGHT);
  const ref: WeightedSamples = { P: Float64Array.from([...refBase.P, ...near.P]), weights: Float64Array.from([...refBase.weights, ...near.weights]) };
  const refTarget = applyCube(cube, ref.P);
  const base: SlotParams = { ...start, hue: std, hueStd: std };
  const tr = lab(refTarget);
  const [m0] = meanMax00(base, ref.P, tr);
  const { grey, skin } = guardSets();
  const nearGuard = nearNeutralSamples(0.5, [0.05, 0.1, 0.16], [0.35, 0.6, 0.8, 0.95], 1).P;
  const tg = lab(applyCube(cube, grey)), ts = lab(applyCube(cube, skin)), tn = lab(applyCube(cube, nearGuard));
  const [g0, G0] = meanMax00(base, grey, tg), [s0, S0] = meanMax00(base, skin, ts), [n0, N0] = meanP95(base, nearGuard, tn);
  let best: { params: SlotParams; hueQ10: number[]; penalty: number } | null = null;
  // A second try weighs the greys, the skin tones and the near-neutrals four times as much; it is
  // skipped when the first one already leaves every protected group as good as it was.
  for (const boost of [1, 4]) {
    const weights = boost === 1 ? ref.weights : ref.weights.map((w) => (w === 60 || w === 10 || w === HUE_NEAR_NEUTRAL_WEIGHT ? w * boost : w));
    const fitted = fitHue(start, std, ref.P, refTarget, weights, { onProgress: (f) => onProgress?.(boost === 1 ? f * 0.6 : 0.6 + f * 0.4) });
    const q = hueToQ10(fitted.hue!);
    if (!q) continue;
    // what the firmware gets: the block rounded to Q10
    const out: SlotParams = { ...fitted, hue: Array.from({ length: 12 }, (_, g) => q.slice(g * 9, g * 9 + 9).map((v) => v / 1024)) };
    const [m1] = meanMax00(out, ref.P, tr);
    const [g1, G1] = meanMax00(out, grey, tg), [s1, S1] = meanMax00(out, skin, ts), [n1, N1] = meanP95(out, nearGuard, tn);
    const check: HueCheck = { m0, m1, groups: [
      { a0: g0, a1: g1, b0: G0, b1: G1, base: HUE_TOL.grey[0], cap: HUE_TOL.grey[1] },
      { a0: n0, a1: n1, b0: N0, b1: N1, base: HUE_TOL.near[0], cap: HUE_TOL.near[1] },
      { a0: s0, a1: s1, b0: S0, b1: S1, base: HUE_TOL.skin[0], cap: HUE_TOL.skin[1] },
    ] };
    if (!huePasses(check)) continue;
    const penalty = huePenalty(check);
    if (!best || penalty < best.penalty) best = { params: out, hueQ10: q, penalty };
    if (check.groups.every((g) => g.a1 <= g.a0)) break;
  }
  return best && { params: best.params, hueQ10: best.hueQ10 };
}

/**
 * Convert a .cube LUT. The LUT is taken to act on an sRGB display image, so the target is simply
 * cube(P) where P are colours as output by the camera's Standard preset. The fit uses
 * `cubeFitSamplesExpanded` (the calibration and synthetic colours plus a dense grey ramp, a 9^3
 * grid with its corners and skin tones); errors are reported on `cubeFitSamples`. With
 * `refine: true` a guarded CIEDE2000 refinement follows (off by default, see refine.ts).
 */
export function convertCube(text: string, opts?: ConvertOptions): Conversion {
  const cube = parseCube(text);
  opts?.onProgress?.(0.05);
  const P = cubeFitSamplesExpanded();
  const target = applyCube(cube, P);
  opts?.onProgress?.(0.1);
  const refine = opts?.refine === true;
  const hueStd = opts?.hueStd;
  const fit = fitSlot(P, target, { onProgress: subProgress(opts, 0.1, refine || hueStd ? 0.55 : 1), post: opts?.post !== false });
  let params: SlotParams = fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck };
  let refined: boolean | undefined;
  if (refine) {
    const r = guardedRefine(cube, params, subProgress(opts, 0.55, hueStd ? 0.7 : 0.98));
    refined = r !== null;
    if (r) params = r;
  }
  let hueQ10: number[] | undefined;
  if (hueStd) {
    const h = guardedHue(cube, params, hueStd, subProgress(opts, refine ? 0.7 : 0.55, 0.98));
    if (h) { params = h.params; hueQ10 = h.hueQ10; }
  }
  // report on the original fitting colours (the first part of P), comparable with earlier versions
  const n = cubeFitSamples().length;
  const rep = report(slotApply(params, P.subarray(0, n)), target.subarray(0, n));
  opts?.onProgress?.(1);
  return {
    kind: 'cube',
    title: cube.title,
    params,
    ...rep,
    ...(refined !== undefined ? { refined } : {}),
    ...(hueQ10 ? { hueQ10 } : {}),
    warnings: [],
    unsupported: [],
  };
}

/** What the camera would output with these slot parameters for colours it renders as `rgb` in Standard. */
export function previewSlot(params: SlotParams, rgb: Float64Array): Float64Array {
  return slotApply(params, rgb);
}
