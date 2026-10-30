// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III round 6 (T6..T6j): the halation of GR Mod 0.8.0 (context 'HAL2': a threshold per film,
 * Weak 25 / Strong 60), kept so that the files of those rounds are still rebuilt byte for byte
 * (inspection). Round 7 uses GR IV 0.8.2's halation (../aspect/halation.ts). The module bytes are
 * GR IV 0.8.0's tools/halation/halation.c build (core/src/fw/aspect/halation-code.ts of v0.8.0).
 */
import { FirmwareError } from '../types';
import { halationLut } from '../aspect/halation';

const HALATION_R6_CODE = '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';
const HALATION_R6_CODE_LENGTH = 3336;
const PARAM_BYTES = 16;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** GR Mod 0.8.0's halation constants. */
export const HALATION_R6 = {
  threshold: 235,
  minRange: 4,
  narrow: 0.0035,
  wide: 0.012,
  mix: 0.6,
  gain: [25, 60] as const,
};

/** 0.8.0's table: red, green, blue lifts (the same as 0.8.2's red table). */
export function halationLutR6(): Uint8Array {
  return halationLut('red');
}

/** The module (0.8.0 build). */
export function halationModuleR6(): Uint8Array {
  const raw = Uint8Array.from(atob(HALATION_R6_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== HALATION_R6_CODE_LENGTH) fail('internal', 'halation r6: module length');
  return raw;
}

/** struct params of 0.8.0 (with the weak and strong gains). */
export function paramBytesR6(): Uint8Array {
  const out = new Uint8Array(PARAM_BYTES);
  const v = new DataView(out.buffer);
  const H = HALATION_R6;
  v.setUint16(0, Math.round(H.narrow * 4096), true);
  v.setUint16(2, Math.round(H.wide * 4096), true);
  v.setUint16(4, Math.round(H.mix * 256), true);
  v.setUint16(6, Math.round(H.gain[0] * 4), true);
  v.setUint16(8, Math.round(H.gain[1] * 4), true);
  return out;
}

/** Where a film's light starts (0..254 of 255) and its scale (16384 / range to the film's white). */
export interface HalationLightR6 { threshold: number; escale: number }

/** Without a look (Standard). */
export const PLAIN_LIGHT_R6: HalationLightR6 = { threshold: HALATION_R6.threshold, escale: Math.round(16384 / (255 - HALATION_R6.threshold)) };

/** 0.8.0's light of a film (see v0.8.0's halation.ts). */
export function halationLightR6(curves: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>], postQ9?: ArrayLike<number>): HalationLightR6 {
  const level = (v: number): number => {
    const x = (v / 255) * (16383 / 64);
    const i = Math.min(254, Math.floor(x)), f = x - i;
    let o = curves.map((c) => Math.min(16383, c[i] + (c[i + 1] - c[i]) * f) / 16383);
    if (postQ9) o = [0, 1, 2].map((r) => (postQ9[r * 3] * o[0] + postQ9[r * 3 + 1] * o[1] + postQ9[r * 3 + 2] * o[2]) / 512);
    const [R, G, B] = o.map((c) => Math.round((c < 0 ? 0 : c > 1 ? 1 : c) * 255));
    return Math.max(R, (19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
  };
  const white = level(255);
  const threshold = Math.max(0, Math.min(254, level(HALATION_R6.threshold), white - HALATION_R6.minRange));
  return { threshold, escale: Math.min(16384, Math.round(16384 / Math.max(1, white - threshold))) };
}

type Paint = (x: number, y: number) => [number, number, number, number] | null;
function render(w: number, h: number, paint: Paint, base?: Uint8Array): Uint8Array {
  const out = base ? base.slice() : new Uint8Array(w * h * 4).fill(255).map((v, i) => (i % 4 === 3 ? 0 : v));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y);
    if (!c || c[3] < 128) continue;
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) out[i + k] = Math.round((c[k] * c[3]) / 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Coverage of a disc / ring, 4x4 supersampled. */
function cover(x: number, y: number, cx: number, cy: number, r0: number, r1: number): number {
  let n = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const dx = x + (sx + 0.5) / 4 - cx, dy = y + (sy + 0.5) / 4 - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= r0 && d <= r1) n++;
  }
  return n / 16;
}

const RED: [number, number, number] = [255, 84, 40];


/**
 * Round 6's slider scale (400 x 60): the panel and the track of `native` (GR III's three-position
 * scale 211), its marks replaced by Off (an empty circle), Weak and Strong (a light with a thin
 * and a thick red ring) at x = 20, 200, 380.
 */
export function halationScaleR6(native: Uint8Array): Uint8Array {
  if (native.length !== 400 * 60 * 4) fail('unexpected-layout', 'halation: the native scale has another size');
  const base = native.slice();
  for (let y = 2; y < 34; y++) for (let x = 0; x < 400; x++) {
    const i = (y * 400 + x) * 4;
    base[i] = 0; base[i + 1] = 0; base[i + 2] = 0; base[i + 3] = 191;
  }
  const marks: Paint = (x, y) => {
    const off = cover(x, y, 20, 17, 6, 8);
    if (off) return [255, 255, 255, Math.round(255 * off)];
    for (const [cx, ring] of [[200, 2.2], [380, 4.5]] as const) {
      const core = cover(x, y, cx, 17, 0, 4);
      const red = cover(x, y, cx, 17, 6, 6 + ring);
      if (core) return [255, 255, 255, Math.round(255 * core)];
      if (red) return [...RED, Math.round(255 * red)];
    }
    return null;
  };
  return render(400, 60, marks, base);
}
