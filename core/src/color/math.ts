// Numerical primitives shared by the colour pipeline. All colour buffers are Float64Array of
// packed RGB triples (r0,g0,b0,r1,g1,b1,...). The formulas follow the Python reference
// (xmp2gr4.py / acrsim.py) operation for operation, so results agree to rounding error.

export type ColorErrorCode =
  | 'not-xmp'
  | 'no-table'
  | 'look-profile-missing'
  | 'unsupported-table'
  | 'bad-table'
  | 'not-cube'
  | 'bad-cube'
  | 'bad-input';

export class ColorError extends Error {
  readonly code: ColorErrorCode;
  constructor(code: ColorErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ColorError';
    this.code = code;
  }
}

/** Row-major 3x3 matrix. */
export type Mat3 = readonly number[];

export const SRGB2XYZ: Mat3 = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.072175,
  0.0193339, 0.119192, 0.9503041,
];
/** Row sums of SRGB2XYZ, summed left to right like numpy does. */
export const WHITE: readonly number[] = [
  SRGB2XYZ[0] + SRGB2XYZ[1] + SRGB2XYZ[2],
  SRGB2XYZ[3] + SRGB2XYZ[4] + SRGB2XYZ[5],
  SRGB2XYZ[6] + SRGB2XYZ[7] + SRGB2XYZ[8],
];

// linear sRGB -> linear ProPhoto: XYZ(D50)->ProPhoto . Bradford D65->D50 . sRGB->XYZ, and its inverse.
// The literals are the float64 values the reference computes (acrsim.S2P / np.linalg.inv(S2P)).
export const S2P: Mat3 = [
  0.5293458246046687, 0.3300727901912129, 0.14058125375079608,
  0.09837436211886709, 0.8734610448191785, 0.028164686612267942,
  0.016883187456226075, 0.11767247216909364, 0.8654443038912419,
];
export const P2S: Mat3 = [
  2.0340763610012553, -0.7273343315490479, -0.30674170521474897,
  -0.228813409595274, 1.231730168456554, -0.0029169042747250254,
  -0.008569763411926157, -0.15328659684761936, 1.1618564158615476,
];

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** sRGB-encoded -> linear (input clipped to 0..1). */
export function srgbToLin(v: number): number {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** linear -> sRGB-encoded (input clipped to 0..1). */
export function linToSrgb(v: number): number {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** NumPy-style round half to even. */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** np.linspace(0, 1, n). */
export function linspace01(n: number): Float64Array {
  const out = new Float64Array(n);
  const step = 1 / (n - 1);
  for (let i = 0; i < n; i++) out[i] = i * step;
  out[n - 1] = 1;
  return out;
}

/**
 * np.interp(x, xp, fp) for one value: xp non-decreasing, constant outside the range, and for
 * repeated xp the last sample not greater than x wins (same as NumPy's binary search).
 */
export function interp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (x !== x) return NaN;
  if (x > xp[n - 1]) return fp[n - 1];
  if (x < xp[0]) return fp[0];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xp[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  const j = lo - 1;
  if (j === n - 1 || xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  return slope * (x - xp[j]) + fp[j];
}

/** out = rgb . M^T for packed triples (may run in place). */
export function mulMat3(m: Mat3, rgb: Float64Array, out: Float64Array = new Float64Array(rgb.length)): Float64Array {
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    out[i] = r * m0 + g * m1 + b * m2;
    out[i + 1] = r * m3 + g * m4 + b * m5;
    out[i + 2] = r * m6 + g * m7 + b * m8;
  }
  return out;
}

export function matMul3(a: Mat3, b: Mat3): number[] {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

/** CIE L*a*b* of sRGB-encoded colours, white = sRGB white (as `lab` in xmp2gr4.py). */
export function lab(rgb: Float64Array, out: Float64Array = new Float64Array(rgb.length)): Float64Array {
  const M = SRGB2XYZ;
  const w0 = WHITE[0], w1 = WHITE[1], w2 = WHITE[2];
  for (let i = 0; i < rgb.length; i += 3) {
    const r = srgbToLin(rgb[i]), g = srgbToLin(rgb[i + 1]), b = srgbToLin(rgb[i + 2]);
    const x = (r * M[0] + g * M[1] + b * M[2]) / w0;
    const y = (r * M[3] + g * M[4] + b * M[5]) / w1;
    const z = (r * M[6] + g * M[7] + b * M[8]) / w2;
    const fx = x > LAB_EPS ? Math.cbrt(x) : (LAB_KAPPA * x + 16) / 116;
    const fy = y > LAB_EPS ? Math.cbrt(y) : (LAB_KAPPA * y + 16) / 116;
    const fz = z > LAB_EPS ? Math.cbrt(z) : (LAB_KAPPA * z + 16) / 116;
    out[i] = 116 * fy - 16;
    out[i + 1] = 500 * (fx - fy);
    out[i + 2] = 200 * (fy - fz);
  }
  return out;
}

/**
 * Lab of one sRGB colour plus the 3x3 Jacobian d(L,a,b)/d(r,g,b) (row-major into `jac`).
 * The derivative is the one of the unclipped formula; callers handle clipping themselves.
 */
export function labWithJacobian(r: number, g: number, b: number, labOut: Float64Array, jac: Float64Array): void {
  const M = SRGB2XYZ;
  const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
  const dr = r <= 0.04045 ? 1 / 12.92 : (2.4 / 1.055) * Math.pow((r + 0.055) / 1.055, 1.4);
  const dg = g <= 0.04045 ? 1 / 12.92 : (2.4 / 1.055) * Math.pow((g + 0.055) / 1.055, 1.4);
  const db = b <= 0.04045 ? 1 / 12.92 : (2.4 / 1.055) * Math.pow((b + 0.055) / 1.055, 1.4);
  const x = (lr * M[0] + lg * M[1] + lb * M[2]) / WHITE[0];
  const y = (lr * M[3] + lg * M[4] + lb * M[5]) / WHITE[1];
  const z = (lr * M[6] + lg * M[7] + lb * M[8]) / WHITE[2];
  let fx: number, fy: number, fz: number, gx: number, gy: number, gz: number;
  if (x > LAB_EPS) { fx = Math.cbrt(x); gx = 1 / (3 * fx * fx); } else { fx = (LAB_KAPPA * x + 16) / 116; gx = LAB_KAPPA / 116; }
  if (y > LAB_EPS) { fy = Math.cbrt(y); gy = 1 / (3 * fy * fy); } else { fy = (LAB_KAPPA * y + 16) / 116; gy = LAB_KAPPA / 116; }
  if (z > LAB_EPS) { fz = Math.cbrt(z); gz = 1 / (3 * fz * fz); } else { fz = (LAB_KAPPA * z + 16) / 116; gz = LAB_KAPPA / 116; }
  labOut[0] = 116 * fy - 16;
  labOut[1] = 500 * (fx - fy);
  labOut[2] = 200 * (fy - fz);
  // d f_k / d rgb_c
  const xr = (gx * M[0] / WHITE[0]) * dr, xg = (gx * M[1] / WHITE[0]) * dg, xb = (gx * M[2] / WHITE[0]) * db;
  const yr = (gy * M[3] / WHITE[1]) * dr, yg = (gy * M[4] / WHITE[1]) * dg, yb = (gy * M[5] / WHITE[1]) * db;
  const zr = (gz * M[6] / WHITE[2]) * dr, zg = (gz * M[7] / WHITE[2]) * dg, zb = (gz * M[8] / WHITE[2]) * db;
  jac[0] = 116 * yr; jac[1] = 116 * yg; jac[2] = 116 * yb;
  jac[3] = 500 * (xr - yr); jac[4] = 500 * (xg - yg); jac[5] = 500 * (xb - yb);
  jac[6] = 200 * (yr - zr); jac[7] = 200 * (yg - zg); jac[8] = 200 * (yb - zb);
}

/** CIE76 colour difference between Lab buffers, one value per colour. */
export function deltaELab(labA: Float64Array, labB: Float64Array): Float64Array {
  const n = labA.length / 3;
  const out = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const dl = labA[j] - labB[j], da = labA[j + 1] - labB[j + 1], db = labA[j + 2] - labB[j + 2];
    out[i] = Math.sqrt(dl * dl + da * da + db * db);
  }
  return out;
}

/** CIE76 colour difference between two sRGB-encoded buffers, one value per colour. */
export function deltaE(rgbA: Float64Array, rgbB: Float64Array): Float64Array {
  if (rgbA.length !== rgbB.length) throw new ColorError('bad-input', 'deltaE: buffers differ in length');
  return deltaELab(lab(rgbA), lab(rgbB));
}

export function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : NaN;
}

/** np.percentile(a, q) with the default linear interpolation. */
export function percentile(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a as ArrayLike<number>).sort();
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * (q / 100);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Piecewise cubic through (x, y) with scipy's PchipInterpolator derivatives (Fritsch-Carlson). */
export interface Pchip {
  x: Float64Array;
  /** c[k*n + i]: coefficient of (v - x[i])^(3-k) on interval i (scipy PPoly layout). */
  c: Float64Array;
  n: number; // number of intervals
  yFirst: number;
  yLast: number;
}

const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

function pchipEdge(h0: number, h1: number, m0: number, m1: number): number {
  let d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (sign(d) !== sign(m0)) d = 0;
  else if (sign(m0) !== sign(m1) && Math.abs(d) > 3 * Math.abs(m0)) d = 3 * m0;
  return d;
}

export function pchipBuild(xs: ArrayLike<number>, ys: ArrayLike<number>): Pchip {
  const np = xs.length;
  if (np < 2 || ys.length !== np) throw new ColorError('bad-input', 'pchip needs at least two points');
  const x = Float64Array.from(xs as ArrayLike<number>);
  const y = Float64Array.from(ys as ArrayLike<number>);
  const n = np - 1;
  const h = new Float64Array(n);
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    h[i] = x[i + 1] - x[i];
    if (!(h[i] > 0)) throw new ColorError('bad-input', 'pchip abscissae must be strictly increasing');
    m[i] = (y[i + 1] - y[i]) / h[i];
  }
  const d = new Float64Array(np);
  if (np === 2) {
    d[0] = m[0];
    d[1] = m[0];
  } else {
    for (let k = 1; k < n; k++) {
      const m0 = m[k - 1], m1 = m[k];
      if (sign(m0) !== sign(m1) || m0 === 0 || m1 === 0) {
        d[k] = 0;
      } else {
        const w1 = 2 * h[k] + h[k - 1];
        const w2 = h[k] + 2 * h[k - 1];
        d[k] = 1.0 / ((w1 / m0 + w2 / m1) / (w1 + w2));
      }
    }
    d[0] = pchipEdge(h[0], h[1], m[0], m[1]);
    d[n] = pchipEdge(h[n - 1], h[n - 2], m[n - 1], m[n - 2]);
  }
  const c = new Float64Array(4 * n);
  for (let i = 0; i < n; i++) {
    const t = (d[i] + d[i + 1] - 2 * m[i]) / h[i];
    c[i] = t / h[i];
    c[n + i] = (m[i] - d[i]) / h[i] - t;
    c[2 * n + i] = d[i];
    c[3 * n + i] = y[i];
  }
  return { x, c, n, yFirst: y[0], yLast: y[np - 1] };
}

/**
 * Evaluate like scipy's PPoly (same term order). Outside the knot range the end value is held
 * (the reference never evaluates there: its knots span the whole 0..1 input range).
 */
export function pchipEval(p: Pchip, v: number): number {
  const x = p.x;
  const n = p.n;
  if (!(v > x[0])) return p.yFirst;
  if (v > x[n]) return p.yLast;
  let lo = 0;
  let hi = n; // interval i has x[i] <= v < x[i+1]; the last one is closed on the right
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x[mid + 1] <= v) lo = mid + 1;
    else hi = mid;
  }
  const i = lo > n - 1 ? n - 1 : lo;
  const s = v - x[i];
  const c = p.c;
  let res = c[3 * n + i];
  let z = s;
  res += c[2 * n + i] * z;
  z *= s;
  res += c[n + i] * z;
  z *= s;
  res += c[i] * z;
  return res;
}
