// Conversion of a film-look preset into the parameters of one GR IV Image Control slot.
import { slotApply } from './camera';
import type { CameraToneModel, SlotParams } from './camera';
import { applyCube, parseCube } from './cube';
import { CAL_ADOBE, CAL_CAM } from './data';
import { fitSlot } from './fit';
import { refineHue, refineSlot } from './refine';
import { HUE_MAX_Q10, hueMatricesFromD, hueQuantize } from './hue';
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
  /** 12 x 9 Q10 hue matrices for the added slot's multi-axis block, when they helped. */
  hueQ10?: number[][];
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
   * .cube only: also fit the added slot's own hue sectors (default false, like `refine`; needs
   * `post`). It can take several seconds, and the result is kept only if the quantised look beats
   * the fit without sectors overall and on the saturated, skin, grey and per-region checks,
   * else the result is that fit bit for bit (see `guardedHue`).
   */
  hue?: boolean;
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
  const fit = fitSlot(Float64Array.from(CAL_CAM), target, { onProgress: subProgress(opts, 0.1, 1), post: opts?.post !== false });
  return {
    kind: 'xmp',
    title: look.title,
    params: fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck },
    ...report(slotApply(fit, Float64Array.from(CAL_CAM)), target),
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

const SKIN_TONES: readonly (readonly [number, number, number])[] = [
  [237, 199, 176], [217, 171, 143], [194, 145, 114], [148, 102, 77],
];

function encodeLinear(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Extra fitting colours: a dense neutral ramp (repeated for weight), the LUT grid corners and skin. */
/** Layout of `extraFitSamples`: the neutral ramp comes first and the skin tones are last. */
const EXTRA_GREY_COUNT = 6 * 64;
const EXTRA_SKIN_COUNT = SKIN_TONES.length * 5;
export function extraFitSamples(): Float64Array {
  const out: number[] = [];
  // 64 neutral steps, six copies: greys must stay grey and the black/white ends must be right.
  for (let c = 0; c < EXTRA_GREY_COUNT / 64; c++) for (let i = 0; i < 64; i++) {
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

/** Error figures of one look on the cube fit's own colours: whole set, saturated and skin subsets, plus guard sets. */
export interface HueScore {
  /** Mean / p95 CIEDE2000 on the colours `convertCube` reports on (calibration + synthetic set). */
  fitMean: number; fitP95: number;
  /** Mean on the whole fitting set (reported colours + neutral ramp, grid corners, skin). */
  allMean: number;
  /** Subsets of the fitting set by the TARGET colour: saturated (C > 25) and skin (hue 30-75, C 10-45). */
  satMean: number; satP95: number; skinMean: number; skinP95: number;
  /** Independent refinement colours (hue wheel, greys, skin, random, grid), weighted mean. */
  refMean: number;
  /** Fresh validation colours (never fitted): mean, and p95 of their saturated and skin subsets. */
  valMean: number; valSatP95: number; valSkinP95: number;
  /** 256-step grey ramp and the skin-tone set of the refinement guard. */
  greyMean: number; greyMax: number; toneMean: number; toneMax: number;
  /** Mean error in each region of colour space (hue band x chroma band of the target) over the fitting set and a fresh validation set; NaN where a region has too few colours. */
  cells: Float64Array;
}

/** Everything `scoreHue` needs, built once per conversion. */
export interface HueContext {
  P: Float64Array; labT: Float64Array; n: number; sat: Uint32Array; skin: Uint32Array;
  ref: WeightedSamples; labRef: Float64Array; grey: Float64Array; labGrey: Float64Array; tones: Float64Array; labTones: Float64Array;
  /** Fresh validation colours (never fitted): random display colours and synthetic ones from other seeds. */
  V: Float64Array; labV: Float64Array; satV: Uint32Array; skinV: Uint32Array;
  /** Region of each fitting colour (`P`) and validation colour (`V`) in the pool, and how many colours each region holds. */
  cellP: Int16Array; cellV: Int16Array; cellCount: Int32Array;
}

/** Regions of colour space for the "no region gets worse" check: 12 hue bands x 4 chroma bands of the target colour. */
export const HUE_CELLS = 12 * 4;
const CELL_MIN = 25;
function cellOf(L: number, a: number, b: number): number {
  const c = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  const cb = c < 10 ? 0 : c < 25 ? 1 : c < 45 ? 2 : 3;
  return Math.min(11, Math.floor(h / 30)) * 4 + cb;
}
function cellsOfLab(labs: Float64Array): Int16Array {
  const out = new Int16Array(labs.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = cellOf(labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]);
  return out;
}

/** Fresh colours the hue fit never sees: uniform display colours plus a synthetic set with another seed. */
function validationSamples(): Float64Array {
  const syn = syntheticSamples(4000, 7, 0);
  const rand = mulberry32(11);
  const out = new Float64Array(syn.length + 3000 * 3);
  out.set(syn, 0);
  for (let i = syn.length; i < out.length; i++) out[i] = rand();
  return out;
}

/** Indices of the saturated (C > 25) and skin (hue 30-75, C 10-45) colours among `labs`. */
function satSkinOf(labs: Float64Array): { sat: Uint32Array; skin: Uint32Array } {
  const sat: number[] = [], skin: number[] = [];
  for (let i = 0; i < labs.length / 3; i++) {
    const a = labs[i * 3 + 1], b = labs[i * 3 + 2];
    const c = Math.hypot(a, b);
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    if (c > 25) sat.push(i);
    if (h >= 30 && h <= 75 && c >= 10 && c <= 45) skin.push(i);
  }
  return { sat: Uint32Array.from(sat), skin: Uint32Array.from(skin) };
}

export function hueContext(cube: ReturnType<typeof parseCube>): HueContext {
  const P = cubeFitSamplesExpanded();
  const target = applyCube(cube, P);
  const labT = lab(target);
  const { sat, skin } = satSkinOf(labT);
  const ref = cubeRefineSamples();
  const { grey, skin: tones } = guardSets();
  const V = validationSamples();
  const labV = lab(applyCube(cube, V));
  const satV = satSkinOf(labV);
  const cellP = cellsOfLab(labT), cellV = cellsOfLab(labV);
  const cellCount = new Int32Array(HUE_CELLS);
  for (const c of cellP) cellCount[c]++;
  for (const c of cellV) cellCount[c]++;
  return {
    V, labV, cellP, cellV, cellCount, satV: satV.sat, skinV: satV.skin,
    P, labT, n: cubeFitSamples().length / 3, sat, skin,
    ref, labRef: lab(applyCube(cube, ref.P)), grey, labGrey: lab(applyCube(cube, grey)), tones, labTones: lab(applyCube(cube, tones)),
  };
}

const meanOf = (d: Float64Array, idx?: Uint32Array): number => {
  if (!idx) return d.length ? mean(d) : 0;
  let s = 0;
  for (const i of idx) s += d[i];
  return idx.length ? s / idx.length : 0;
};
const p95Of = (d: Float64Array, idx?: Uint32Array): number => {
  const v = idx ? Float64Array.from(idx, (i) => d[i]) : d;
  return v.length ? percentile(v, 95) : 0;
};

/** Score a look (hue sectors as they are in `params`, i.e. already quantised if that is what is written). */
export function scoreHue(params: SlotParams, ctx: HueContext, camera?: CameraToneModel): HueScore {
  const run = (P: Float64Array, labT: Float64Array): Float64Array => deltaE2000Lab(lab(camera ? camera.slotApply(params, P) : slotApply(params, P)), labT);
  const d = run(ctx.P, ctx.labT);
  const head = d.subarray(0, ctx.n);
  const dr = run(ctx.ref.P, ctx.labRef);
  let ws = 0, wm = 0;
  for (let i = 0; i < dr.length; i++) { ws += ctx.ref.weights[i]; wm += ctx.ref.weights[i] * dr[i]; }
  const dg = run(ctx.grey, ctx.labGrey), dt = run(ctx.tones, ctx.labTones);
  const dv = run(ctx.V, ctx.labV);
  const cells = new Float64Array(HUE_CELLS);
  for (let i = 0; i < d.length; i++) cells[ctx.cellP[i]] += d[i];
  for (let i = 0; i < dv.length; i++) cells[ctx.cellV[i]] += dv[i];
  for (let c = 0; c < HUE_CELLS; c++) cells[c] = ctx.cellCount[c] >= CELL_MIN ? cells[c] / ctx.cellCount[c] : NaN;
  return {
    cells,
    fitMean: meanOf(head), fitP95: p95Of(head), allMean: meanOf(d),
    satMean: meanOf(d, ctx.sat), satP95: p95Of(d, ctx.sat), skinMean: meanOf(d, ctx.skin), skinP95: p95Of(d, ctx.skin),
    refMean: wm / ws,
    valMean: meanOf(dv), valSatP95: p95Of(dv, ctx.satV), valSkinP95: p95Of(dv, ctx.skinV),
    greyMean: meanOf(dg), greyMax: Math.max(...dg), toneMean: meanOf(dt), toneMax: Math.max(...dt),
  };
}

/** Smallest relative drop of the mean CIEDE2000 (reported colours and whole fitting set) that justifies hue sectors. */
const HUE_MIN_GAIN = 0.02;
const HUE_TOL_MEAN = 0.01, HUE_TOL_P95 = 0.05, HUE_TOL_MAX = 0.05;
/** The skin-tone set is 16 colours at four exposures; its worst colour is a clipped highlight, hence the wider worst-case tolerance. */
const HUE_TOL_TONE_MEAN = 0.03, HUE_TOL_TONE_MAX = 0.2;
/** No region of colour space (hue band x chroma band) may get worse by more than this on average. */
const HUE_TOL_CELL = 0.03;
/** p95 of the saturated / skin subsets of the fresh validation colours (a large set, so a tighter tolerance than on the fit set). */
const HUE_TOL_VAL_P95 = 0.02;
function cellsWorse(o: HueScore, w: HueScore): number[] {
  const out: number[] = [];
  for (let c = 0; c < HUE_CELLS; c++) if (w.cells[c] > o.cells[c] + HUE_TOL_CELL) out.push(c);
  return out;
}

/**
 * Decision rule for hue sectors. `withHue` is the final quantised look, `without` the final look
 * without them, both scored on the SAME colours (`HueContext`) and with the same CIEDE2000.
 * Hue is kept only when the mean error drops by at least 2% on the reported colours and on the
 * whole fitting set, and nothing else gets worse: p95 of the reported colours, mean and p95 of the
 * saturated and the skin subsets (+0.01 / +0.05 tolerance), the independent refinement colours,
 * a fresh validation set (mean +0.01, p95 of its saturated and skin subsets +0.02),
 * the grey ramp (mean +0.01, worst +0.05), the skin-tone set (mean +0.03, worst +0.2), and the mean
 * error of every region of colour space (hue band x chroma band, fitting plus validation colours,
 * +0.03). Anything else, and the caller keeps the look without hue sectors.
 */
export function hueKept(without: HueScore, withHue: HueScore): boolean {
  const w = withHue, o = without;
  return w.fitMean < o.fitMean * (1 - HUE_MIN_GAIN) && w.allMean < o.allMean * (1 - HUE_MIN_GAIN)
    && w.fitP95 <= o.fitP95 + HUE_TOL_P95
    && w.satMean <= o.satMean + HUE_TOL_MEAN && w.satP95 <= o.satP95 + HUE_TOL_P95
    && w.skinMean <= o.skinMean + HUE_TOL_MEAN && w.skinP95 <= o.skinP95 + HUE_TOL_P95
    && w.refMean <= o.refMean + HUE_TOL_MEAN
    && w.valMean <= o.valMean + HUE_TOL_MEAN && w.valSatP95 <= o.valSatP95 + HUE_TOL_VAL_P95 && w.valSkinP95 <= o.valSkinP95 + HUE_TOL_VAL_P95
    && w.greyMean <= o.greyMean + HUE_TOL_MEAN && w.greyMax <= o.greyMax + HUE_TOL_MAX
    && w.toneMean <= o.toneMean + HUE_TOL_TONE_MEAN && w.toneMax <= o.toneMax + HUE_TOL_TONE_MAX
    && cellsWorse(o, w).length === 0;
}

/** Settings of the hue-sector search (the defaults are what ships; the fields exist for tests and tuning). */
export interface HueSearch {
  /** Seam penalties tried, in order (the shipped default is the single value 1; GR4-LUTSmith tries 0.3 .. 100, weakest first). */
  kinks: readonly number[];
  /** Fit / refit rounds per attempt. */
  rounds: number;
  /** Fractions of the fitted sector parameters tried, largest first (1 = as fitted). */
  scales: readonly number[];
  /** Weight of the squared error next to the mean in the objective. */
  tail: number;
  /** Charge for a colour ending above what it has without hue sectors (see `RefineOptions.ceiling`). */
  ceilingWeight: number;
  ceilingMargin: number;
  /** Also refit the look matrix / post matrix / curves with the sectors held. */
  joint: boolean;
  /** Attempts per seam penalty: after a rejected attempt the groups that failed get more weight. */
  attempts: number;
  /** Factor by which a failed group's weight grows. */
  reweight: number;
  /** Called with a line per candidate (tuning and tests). */
  log?: (line: string, score: HueScore, look: SlotParams) => void;
}
export const HUE_SEARCH: HueSearch = { kinks: [1], rounds: 2, scales: [1, 0.6], tail: 0.1, ceilingWeight: 2, ceilingMargin: 0.3, joint: true, attempts: 4, reweight: 2.5 };

/** The quantised look: hue matrices rounded to the Q10 integers that get written, evaluated as written. */
function quantisedHue(p: SlotParams, hue: number[][]): { params: SlotParams; hueQ10: number[][] } | null {
  const hueQ10 = hueQuantize(hue);
  if (hueQ10.some((m) => m.some((v) => Math.abs(v) > HUE_MAX_Q10))) return null; // beyond what the firmware writer accepts
  return { params: { M1: p.M1, ck: p.ck, ...(p.P2 ? { P2: p.P2 } : {}), hue: hueQ10.map((m) => m.map((v) => v / 1024)) }, hueQ10 };
}

/** Which groups of fitting colours `hueKept` rejected a look for (they get more weight in the next attempt). */
function failedGroups(o: HueScore, w: HueScore): Set<string> {
  const f = new Set<string>();
  for (const c of cellsWorse(o, w)) f.add(`cell${c}`);
  if (w.satMean > o.satMean + HUE_TOL_MEAN || w.satP95 > o.satP95 + HUE_TOL_P95 || w.valSatP95 > o.valSatP95 + HUE_TOL_VAL_P95) f.add('sat');
  if (w.skinMean > o.skinMean + HUE_TOL_MEAN || w.skinP95 > o.skinP95 + HUE_TOL_P95 || w.valSkinP95 > o.valSkinP95 + HUE_TOL_VAL_P95) f.add('skin');
  if (w.toneMean > o.toneMean + HUE_TOL_TONE_MEAN || w.toneMax > o.toneMax + HUE_TOL_TONE_MAX) f.add('tone');
  if (w.greyMean > o.greyMean + HUE_TOL_MEAN || w.greyMax > o.greyMax + HUE_TOL_MAX) f.add('grey');
  if (w.fitP95 > o.fitP95 + HUE_TOL_P95 || w.refMean > o.refMean + HUE_TOL_MEAN) f.add('tail');
  return f;
}

/**
 * Hue-sector fit (the added slot's own multi-axis block) after the plain fit. It is fitted on the
 * cube's own fitting colours (the set `convertCube` reports on, plus its neutral ramp, grid and skin),
 * jointly with the rest of the slot: sectors, then look matrix / post matrix / curves with the
 * sectors held, then the sectors again, with a charge on any colour that ends up much worse than it
 * is without hue sectors. Every candidate is scored as the quantised look that would be written.
 * When one fails `hueKept` for a group of colours (saturated, skin, greys, tail), that group gets more
 * weight and the fit is repeated; a fraction of the fitted sectors is also tried. The best candidate
 * that passes wins; otherwise null, and the caller keeps `start` unchanged.
 */
export function guardedHue(cube: ReturnType<typeof parseCube>, start: SlotParams, onProgress?: (f: number) => void, camera?: CameraToneModel, search: HueSearch = HUE_SEARCH): { params: SlotParams; hueQ10: number[][] } | null {
  const ctx = hueContext(cube);
  const target = applyCube(cube, ctx.P);
  const nAll = ctx.P.length / 3;
  const base: SlotParams = { M1: start.M1, ck: start.ck, ...(start.P2 ? { P2: start.P2 } : {}) };
  const s0 = scoreHue(base, ctx, camera);
  const ceiling = deltaE2000Lab(lab(camera ? camera.slotApply(base, ctx.P) : slotApply(base, ctx.P)), ctx.labT);
  // groups of fitting colours by index: the neutral ramp and skin tones sit at known places in the expanded set
  const nGrey = EXTRA_GREY_COUNT, nSkinTones = EXTRA_SKIN_COUNT;
  const groups: Record<string, number[]> = {
    sat: Array.from(ctx.sat), skin: Array.from(ctx.skin),
    grey: Array.from({ length: nGrey }, (_, i) => ctx.n + i),
    tone: Array.from({ length: nSkinTones }, (_, i) => nAll - nSkinTones + i),
    tail: [],
  };
  for (let i = 0; i < nAll; i++) (groups[`cell${ctx.cellP[i]}`] ??= []).push(i);
  let best: { params: SlotParams; hueQ10: number[][]; score: HueScore } | null = null;
  const total = search.kinks.length * search.attempts;
  let step = 0;
  for (const kink of search.kinks) {
    const weights = new Float64Array(nAll).fill(1);
    let tail = search.tail;
    const cur0 = base;
    let d0: Float64Array | undefined;
    for (let attempt = 0; attempt < search.attempts; attempt++) {
      const o = { meanObjective: true, tail, weights, ceiling, ceilingWeight: search.ceilingWeight, ceilingMargin: search.ceilingMargin, ...(camera ? { camera } : {}) };
      let cur = cur0;
      let d = d0;
      for (let round = 0; round < search.rounds; round++) {
        const h = refineHue(cur, ctx.P, target, { iterations: 5, kink, ...o, ...(d ? { init: d } : {}) });
        d = h.d;
        cur = { M1: h.M1, ck: h.ck, ...(h.P2 ? { P2: h.P2 } : {}), hue: h.hue };
        if (search.joint) {
          // the rest of the slot follows the sectors (the sectors are carried through unchanged)
          const r = refineSlot(cur, ctx.P, target, { iterations: 4, ...o });
          cur = { M1: r.M1, ck: r.ck, ...(r.P2 ? { P2: r.P2 } : {}), hue: h.hue };
        }
      }
      // Sectors once more for the refitted slot, then back off towards "no sectors" until the look passes.
      const fin = refineHue(cur, ctx.P, target, { iterations: 5, kink, ...o, init: d! });
      let failed = new Set<string>();
      let passed = false;
      for (const scale of search.scales) {
        const hue = scale === 1 ? fin.hue : hueMatricesFromD(Float64Array.from(fin.d, (v) => v * scale));
        const q = quantisedHue({ M1: fin.M1, ck: fin.ck, ...(fin.P2 ? { P2: fin.P2 } : {}) }, hue);
        if (!q) continue;
        const score = scoreHue(q.params, ctx, camera);
        search.log?.(`kink ${kink} attempt ${attempt} scale ${scale}`, score, q.params);
        if (hueKept(s0, score)) {
          if (!best || score.allMean < best.score.allMean) best = { ...q, score };
          passed = true;
          break;
        }
        if (scale === 1) failed = failedGroups(s0, score);
      }
      onProgress?.(++step / total);
      if (passed || failed.size === 0) break;
      for (const g of failed) {
        if (g === 'tail') tail *= search.reweight;
        else for (const i of groups[g]) weights[i] *= search.reweight;
      }
      d0 = d; // the next attempt starts from the plain fit again, with these sectors as its first guess
    }
  }
  return best ? { params: best.params, hueQ10: best.hueQ10 } : null;
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
  const hueOn = opts?.hue === true && opts?.post !== false;
  const fit = fitSlot(P, target, { onProgress: subProgress(opts, 0.1, refine || hueOn ? 0.55 : 1), post: opts?.post !== false });
  let params: SlotParams = fit.P2 ? { M1: fit.M1, ck: fit.ck, P2: fit.P2 } : { M1: fit.M1, ck: fit.ck };
  let refined: boolean | undefined;
  if (refine) {
    const r = guardedRefine(cube, params, subProgress(opts, 0.55, hueOn ? 0.9 : 0.98));
    refined = r !== null;
    if (r) params = r;
  }
  let hueQ10: number[][] | undefined;
  if (hueOn) {
    const h = guardedHue(cube, params, subProgress(opts, refine ? 0.9 : 0.55, 0.98));
    if (h) {
      params = h.params;
      hueQ10 = h.hueQ10;
    }
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
    warnings: [],
    unsupported: [],
    ...(hueQ10 ? { hueQ10 } : {}),
  };
}

/** What the camera would output with these slot parameters for colours it renders as `rgb` in Standard. */
export function previewSlot(params: SlotParams, rgb: Float64Array): Float64Array {
  return slotApply(params, rgb);
}
