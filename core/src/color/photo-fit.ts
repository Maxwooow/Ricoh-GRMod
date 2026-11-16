// SPDX-License-Identifier: GPL-2.0-only
/**
 * Colours for the optional photo-weighted .cube fit (`ConvertOptions.photoFit`).
 *
 * The default .cube fit (`cubeFitSamplesExpanded`) is driven by the calibration colours, a
 * synthetic set and a 9^3 grid. Real photographs spend most of their pixels elsewhere: greys,
 * skin, sky, dull foliage and dark tones (issue #23 counted about 5x the purples and half the
 * neutrals and skin of real pictures). The photo fit adds, to the same default set, real picture
 * colours and the colours people judge a look by, each repeated for weight:
 *
 *   - pixels of real photographs (Kodak Lossless True Color Image Suite, odd-numbered pictures,
 *     photo-samples.ts),
 *   - blue sky (hue 192.5..237.5 deg, a set offset from the one used to choose),
 *   - a 256-step grey ramp and skin tones at four exposures (the refinement's guard sets),
 *   - optionally pale bright colours (clouds, white walls, lit skin highlights).
 *
 * A few weightings are fitted and the one closest to the LUT on held-out colours (the
 * even-numbered Kodak pictures and an independent sky set) is kept, only if it beats the default
 * fit there and greys, skin and sky do not get worse; otherwise the default fit stands.
 */
import { PHOTO_CHECK_B64, PHOTO_FIT_B64 } from './photo-samples';

/** One weighting: copies of sky, grey ramp, skin, photo pixels and bright pale colours. */
export interface PhotoWeighting { sky: number; grey: number; skin: number; photo: number; bright: number }

/**
 * The weightings tried. They are the ones picked most often, one LUT at a time, when fitting 15
 * looks against held-out raw photographs (MIT-Adobe FiveK, rendered like the camera's Standard).
 */
export const PHOTO_WEIGHTINGS: readonly PhotoWeighting[] = [
  { sky: 0, grey: 12, skin: 12, photo: 6, bright: 0 },
  { sky: 16, grey: 24, skin: 24, photo: 6, bright: 0 },
  { sky: 16, grey: 24, skin: 24, photo: 6, bright: 30 },
  { sky: 24, grey: 24, skin: 24, photo: 3, bright: 30 },
];

function decode(b64: string): Float64Array {
  const bin = atob(b64);
  const out = new Float64Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}

let fitCache: Float64Array | undefined, checkCache: Float64Array | undefined;
/** Real photo pixels for fitting (8-bit sRGB as Standard renders them, 0..1). */
export const photoFitSamples = (): Float64Array => (fitCache ??= decode(PHOTO_FIT_B64));
/** Real photo pixels from other pictures, for choosing between fits. */
export const photoCheckSamples = (): Float64Array => (checkCache ??= decode(PHOTO_CHECK_B64));

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as [number, number, number][])[((i % 6) + 6) % 6];
}

/** Blue sky for fitting: 10 hues x 5 saturations x 4 values. */
export function skyFitSamples(): Float64Array {
  const out: number[] = [];
  for (let h = 192.5; h <= 237.5; h += 5) for (const s of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const v of [0.5, 0.65, 0.8, 0.93]) out.push(...hsv(h / 360, s, v));
  return Float64Array.from(out);
}

/** Blue sky for choosing (offset from the fitting set): 9 hues x 5 saturations x 5 values. */
export function skyCheckSamples(): Float64Array {
  const out: number[] = [];
  for (let h = 195; h <= 235; h += 5) for (const s of [0.15, 0.3, 0.45, 0.6, 0.75]) for (const v of [0.45, 0.6, 0.75, 0.9, 0.98]) out.push(...hsv(h / 360, s, v));
  return Float64Array.from(out);
}

/** Pale bright colours: 12 hues x 3 low saturations x 4 high values. */
export function brightSamples(): Float64Array {
  const out: number[] = [];
  for (let h = 0; h < 360; h += 30) for (const s of [0.05, 0.1, 0.2]) for (const v of [0.8, 0.88, 0.95, 1]) out.push(...hsv(h / 360, s, v));
  return Float64Array.from(out);
}

/** The default fitting colours followed by the weighted extra sets. */
export function photoFitSet(base: Float64Array, w: PhotoWeighting, grey: Float64Array, skin: Float64Array): Float64Array {
  const parts: Float64Array[] = [base];
  const add = (a: Float64Array, n: number): void => { for (let i = 0; i < n; i++) parts.push(a); };
  add(skyFitSamples(), w.sky);
  add(grey, w.grey);
  add(skin, w.skin);
  add(photoFitSamples(), w.photo);
  add(brightSamples(), w.bright);
  const out = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
