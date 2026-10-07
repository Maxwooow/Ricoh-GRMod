// Model of what Lightroom / Camera Raw does with a Look profile, acting on an "Adobe Standard"
// rendering (sRGB-encoded display values). Port of acrlook.py / acrsim.py:
//   display -> [inverse base tone curve] -> linear ProPhoto -> LookTable (HSV) -> base tone curve
//           -> point curve (hue preserving, on display-encoded ProPhoto) -> RGBTable (trilinear).
import { TONE_PARAMS } from './data';
import { ColorError, P2S, S2P, interp, linToSrgb, linspace01, pchipBuild, pchipEval, srgbToLin } from './math';
import type { Pchip } from './math';
import { isIdentityCurve } from './xmp';
import type { CurvePoints, LookTable, RgbTable, ToneCurves, XmpLook } from './xmp';

type Fn = (v: number) => number;

/**
 * Hue-preserving curve (DNG SDK RefBaselineRGBTone) on one triple, in place at offset `o`:
 * the curve maps the largest and the smallest channel, the middle one keeps its relative position.
 * For equal channels the earlier one counts as smaller (stable order, like the reference's argsort).
 */
function rgbtone(a: Float64Array, o: number, f: Fn): void {
  const x0 = a[o], x1 = a[o + 1], x2 = a[o + 2];
  let lo = 0, mid = 1, hi = 2;
  // stable three-element sort of the indices
  let v0 = x0, v1 = x1, v2 = x2;
  if (v1 < v0) { const t = v0; v0 = v1; v1 = t; lo = 1; mid = 0; }
  if (v2 < v1) {
    const t = v1; v1 = v2; v2 = t;
    const ti = mid; mid = hi; hi = ti;
    if (v1 < v0) { const u = v0; v0 = v1; v1 = u; const ui = lo; lo = mid; mid = ui; }
  }
  const mx = v2, mn = v0;
  const md = x0 + x1 + x2 - mx - mn;
  const fmx = f(mx), fmn = f(mn);
  const d = mx - mn;
  const t = mx > mn ? (md - mn) / (d > 1e-9 ? d : 1e-9) : 0.0;
  a[o + lo] = fmn;
  a[o + mid] = fmn + (fmx - fmn) * t;
  a[o + hi] = fmx;
}

/**
 * Base tone curve of the Adobe Standard rendering as a monotone function of the display value:
 * pre = f(enc), the linear pre-tone-curve value. Parameters are the logs of the 9 increments of f
 * over 10 uniform knots.
 */
export class Tone {
  static readonly KX: Float64Array = linspace01(10);
  readonly p: Float64Array;
  /** f at the knots; y[9] is the largest pre-tone value. */
  readonly y: Float64Array;
  private readonly f: Pchip;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly top: number;

  constructor(p?: ArrayLike<number>) {
    const KX = Tone.KX;
    if (p === undefined) {
      // default: the sRGB decoding function itself
      const d = new Float64Array(9);
      for (let i = 0; i < 9; i++) d[i] = Math.log(srgbToLin(KX[i + 1]) - srgbToLin(KX[i]) + 1e-6);
      p = d;
    }
    if (p.length !== 9) throw new ColorError('bad-input', 'Tone needs 9 parameters');
    this.p = Float64Array.from(p as ArrayLike<number>);
    const y = new Float64Array(10);
    let acc = 0;
    for (let i = 0; i < 9; i++) {
      acc += Math.exp(this.p[i]);
      y[i + 1] = acc;
    }
    this.y = y;
    this.top = y[9];
    this.f = pchipBuild(KX, y);
    // inverse: 4097-point table with a running maximum, looked up by linear interpolation
    const xs = linspace01(4097);
    const ys = new Float64Array(4097);
    let run = -Infinity;
    for (let i = 0; i < 4097; i++) {
      const v = pchipEval(this.f, xs[i]);
      if (v > run) run = v;
      ys[i] = run;
    }
    this.xs = xs;
    this.ys = ys;
  }

  /** display (sRGB-encoded, sRGB primaries) -> linear ProPhoto before the tone curve. */
  toPre(rgb: Float64Array): Float64Array {
    const out = new Float64Array(rgb.length);
    const f = this.f;
    const fwd: Fn = (v) => {
      const r = pchipEval(f, v < 0 ? 0 : v > 1 ? 1 : v);
      return r < 0 ? 0 : r;
    };
    for (let i = 0; i < rgb.length; i += 3) {
      const r = srgbToLin(rgb[i]), g = srgbToLin(rgb[i + 1]), b = srgbToLin(rgb[i + 2]);
      out[i] = linToSrgb(r * S2P[0] + g * S2P[1] + b * S2P[2]);
      out[i + 1] = linToSrgb(r * S2P[3] + g * S2P[4] + b * S2P[5]);
      out[i + 2] = linToSrgb(r * S2P[6] + g * S2P[7] + b * S2P[8]);
      rgbtone(out, i, fwd);
    }
    return out;
  }

  /** linear ProPhoto before the tone curve -> display (sRGB-encoded, sRGB primaries). */
  toDisplay(pre: Float64Array): Float64Array {
    const out = new Float64Array(pre.length);
    const top = this.top, xs = this.xs, ys = this.ys;
    const inv: Fn = (v) => {
      const r = interp(v < 0 ? 0 : v > top ? top : v, ys, xs);
      return r < 0 ? 0 : r > 1 ? 1 : r;
    };
    for (let i = 0; i < pre.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        const v = pre[i + c];
        out[i + c] = v < 0 ? 0 : v > top ? top : v;
      }
      rgbtone(out, i, inv);
      const r = srgbToLin(out[i]), g = srgbToLin(out[i + 1]), b = srgbToLin(out[i + 2]);
      out[i] = linToSrgb(r * P2S[0] + g * P2S[1] + b * P2S[2]);
      out[i + 1] = linToSrgb(r * P2S[3] + g * P2S[4] + b * P2S[5]);
      out[i + 2] = linToSrgb(r * P2S[6] + g * P2S[7] + b * P2S[8]);
    }
    return out;
  }
}

/** Python-style modulo 6 (result in [0, 6], sign of the divisor). */
function mod6(a: number): number {
  let m = a % 6;
  if (m !== 0 && m < 0) m += 6;
  return m;
}

/** Apply a hue/sat/val LookTable to linear ProPhoto triples (0..1), in place. */
export function applyLookTable(pp: Float64Array, lt: LookTable): Float64Array {
  const { hd, sd, vd, data, encoding } = lt;
  const acc = [0, 0, 0];
  for (let i = 0; i < pp.length; i += 3) {
    let r = pp[i], g = pp[i + 1], b = pp[i + 2];
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    g = g < 0 ? 0 : g > 1 ? 1 : g;
    b = b < 0 ? 0 : b > 1 ? 1 : b;
    // rgb -> hsv (h in 0..6)
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const c = mx - mn;
    let h = 0.0;
    if (c > 1e-12) h = mx === r ? mod6((g - b) / c) : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
    const s = mx > 1e-12 ? c / mx : 0.0;
    const v = mx;
    // table lookup: hue wraps, saturation and value clamp
    const ve = encoding === 1 ? linToSrgb(v) : v;
    const hi = (h / 6) * hd;
    const si = s * (sd - 1);
    const vi = ve * (vd - 1);
    const hf = Math.floor(hi);
    const h0 = ((hf % hd) + hd) % hd;
    const h1 = (h0 + 1) % hd;
    const fh = hi - hf;
    let s0 = Math.floor(si);
    s0 = s0 < 0 ? 0 : s0 > sd - 2 ? sd - 2 : s0;
    const fs = si - s0;
    let v0 = 0, v1 = 0, fv = 0;
    if (vd > 1) {
      v0 = Math.floor(vi);
      v0 = v0 < 0 ? 0 : v0 > vd - 2 ? vd - 2 : v0;
      v1 = v0 + 1;
      fv = vi - v0;
    }
    acc[0] = 0; acc[1] = 0; acc[2] = 0;
    for (let a = 0; a < 2; a++) {
      const va = a ? v1 : v0, wa = a ? fv : 1 - fv;
      for (let bb = 0; bb < 2; bb++) {
        const hb = bb ? h1 : h0, wb = bb ? fh : 1 - fh;
        const base = (va * hd + hb) * sd;
        const wab = wa * wb;
        let w = wab * (1 - fs);
        let o = (base + s0) * 3;
        acc[0] += w * data[o]; acc[1] += w * data[o + 1]; acc[2] += w * data[o + 2];
        w = wab * fs;
        o += 3;
        acc[0] += w * data[o]; acc[1] += w * data[o + 1]; acc[2] += w * data[o + 2];
      }
    }
    // hsv -> rgb with the shifted hue and scaled saturation / value
    const h2 = mod6(h + acc[0] / 60.0);
    let s2 = s * acc[1];
    s2 = s2 < 0 ? 0 : s2 > 1 ? 1 : s2;
    let v2 = v * acc[2];
    v2 = v2 < 0 ? 0 : v2 > 1 ? 1 : v2;
    const fl = Math.floor(h2);
    const sector = ((fl % 6) + 6) % 6;
    const f = h2 - fl;
    const p = v2 * (1 - s2);
    const q = v2 * (1 - s2 * f);
    const t = v2 * (1 - s2 * (1 - f));
    switch (sector) {
      case 0: pp[i] = v2; pp[i + 1] = t; pp[i + 2] = p; break;
      case 1: pp[i] = q; pp[i + 1] = v2; pp[i + 2] = p; break;
      case 2: pp[i] = p; pp[i + 1] = v2; pp[i + 2] = t; break;
      case 3: pp[i] = p; pp[i + 1] = q; pp[i + 2] = v2; break;
      case 4: pp[i] = t; pp[i + 1] = p; pp[i + 2] = v2; break;
      default: pp[i] = v2; pp[i + 1] = p; pp[i + 2] = q; break;
    }
  }
  return pp;
}

/** Trilinear lookup in an RGBTable (grid over 0..1), same vertex and weight order as scipy's RegularGridInterpolator. */
export function applyRgbTable(table: RgbTable, rgb: Float64Array, out: Float64Array = new Float64Array(rgb.length)): Float64Array {
  const { div, lut } = table;
  const grid = linspace01(div);
  const idx = [0, 0, 0];
  const frac = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const x = rgb[i + c];
      // np.searchsorted(grid, x) - 1 clipped to 0..div-2: last grid point strictly below x
      let lo = 0, hi = div;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (grid[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      let k = lo - 1;
      k = k < 0 ? 0 : k > div - 2 ? div - 2 : k;
      idx[c] = k;
      frac[c] = (x - grid[k]) / (grid[k + 1] - grid[k]);
    }
    let o0 = 0, o1 = 0, o2 = 0;
    for (let a = 0; a < 2; a++) {
      const wa = a ? frac[0] : 1 - frac[0];
      const ia = (idx[0] + a) * div;
      for (let b = 0; b < 2; b++) {
        const wab = wa * (b ? frac[1] : 1 - frac[1]);
        const ib = (ia + idx[1] + b) * div;
        for (let c = 0; c < 2; c++) {
          const w = wab * (c ? frac[2] : 1 - frac[2]);
          const o = (ib + idx[2] + c) * 3;
          o0 += lut[o] * w; o1 += lut[o + 1] * w; o2 += lut[o + 2] * w;
        }
      }
    }
    out[i] = o0 < 0 ? 0 : o0 > 1 ? 1 : o0;
    out[i + 1] = o1 < 0 ? 0 : o1 > 1 ? 1 : o1;
    out[i + 2] = o2 < 0 ? 0 : o2 > 1 ? 1 : o2;
  }
  return out;
}

/** Curve on 0..1 values from 0..255 points: PCHIP for more than two points, a straight line for two; clipped to 0..1. */
function curveFn(points: CurvePoints | null): Fn {
  const pts = points ?? [[0, 0], [255, 255]];
  const xs = pts.map((p) => p[0] / 255);
  const ys = pts.map((p) => p[1] / 255);
  if (pts.length > 2) {
    const pc = pchipBuild(xs, ys);
    return (v) => {
      const r = pchipEval(pc, v < 0 ? 0 : v > 1 ? 1 : v);
      return r < 0 ? 0 : r > 1 ? 1 : r;
    };
  }
  return (v) => {
    const r = interp(v < 0 ? 0 : v > 1 ? 1 : v, xs, ys);
    return r < 0 ? 0 : r > 1 ? 1 : r;
  };
}

interface CurveStage {
  master: Fn | null;
  channels: (Fn | null)[] | null;
}

function curveStage(c: ToneCurves, alwaysMaster: boolean): CurveStage {
  const rgb = [c.red, c.green, c.blue];
  return {
    master: alwaysMaster || !isIdentityCurve(c.master) ? curveFn(c.master) : null,
    channels: rgb.every(isIdentityCurve) ? null : rgb.map((p) => (isIdentityCurve(p) ? null : curveFn(p))),
  };
}

export class FullLook {
  readonly look: XmpLook;
  readonly tone: Tone;
  private readonly stages: CurveStage[];

  constructor(look: XmpLook, toneParams: ArrayLike<number> = TONE_PARAMS) {
    this.look = look;
    this.tone = new Tone(toneParams);
    this.stages = [];
    // Curves of a surrounding preset (if any) come first, then the look's own curves. The look's
    // master curve stage always runs, exactly like the reference.
    if (look.presetCurves) {
      const st = curveStage(look.presetCurves, false);
      if (st.master || st.channels) this.stages.push(st);
    }
    this.stages.push(curveStage(look.curves, true));
  }

  /** Apply the look to Adobe-Standard-rendered colours (sRGB-encoded 0..1 triples). Returns a new buffer. */
  apply(rgb: Float64Array): Float64Array {
    let d: Float64Array = new Float64Array(rgb.length);
    for (let i = 0; i < rgb.length; i++) {
      const v = rgb[i];
      d[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    const lt = this.look.lookTable;
    if (lt) d = this.tone.toDisplay(applyLookTable(this.tone.toPre(d), lt));
    // point curves on display-encoded ProPhoto
    const stages = this.stages;
    for (let i = 0; i < d.length; i += 3) {
      const r = srgbToLin(d[i]), g = srgbToLin(d[i + 1]), b = srgbToLin(d[i + 2]);
      d[i] = linToSrgb(r * S2P[0] + g * S2P[1] + b * S2P[2]);
      d[i + 1] = linToSrgb(r * S2P[3] + g * S2P[4] + b * S2P[5]);
      d[i + 2] = linToSrgb(r * S2P[6] + g * S2P[7] + b * S2P[8]);
      for (const st of stages) {
        if (st.master) rgbtone(d, i, st.master);
        if (st.channels) {
          for (let c = 0; c < 3; c++) {
            const f = st.channels[c];
            if (f) d[i + c] = f(d[i + c]);
          }
        }
      }
      const pr = srgbToLin(d[i]), pg = srgbToLin(d[i + 1]), pb = srgbToLin(d[i + 2]);
      d[i] = linToSrgb(pr * P2S[0] + pg * P2S[1] + pb * P2S[2]);
      d[i + 1] = linToSrgb(pr * P2S[3] + pg * P2S[4] + pb * P2S[5]);
      d[i + 2] = linToSrgb(pr * P2S[6] + pg * P2S[7] + pb * P2S[8]);
    }
    const table = this.look.rgbTable;
    if (table) return applyRgbTable(table, d, d);
    return d;
  }
}
