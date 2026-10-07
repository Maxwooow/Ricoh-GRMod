// Reader and evaluator for .cube LUT files (Adobe / Resolve flavours): 3D LUTs, 1D LUTs, and the
// Resolve combination of a 1D shaper followed by a 3D LUT. The LUT input is taken to be an
// sRGB / Rec.709 display image; no colour-space conversion is applied.
import { ColorError } from './math';

export interface Cube {
  title: string;
  /** Edge length of the 3D table, 0 if the file has none. */
  size3D: number;
  /** size3D^3 x 3 values, red index changing fastest: entry (r, g, b) starts at (r + size*(g + size*b))*3. */
  data3D: Float64Array | null;
  /** Number of 1D entries, 0 if the file has none. */
  size1D: number;
  /** size1D x 3 values (one row per input level). */
  data1D: Float64Array | null;
  /** Input range per channel for the 3D table. */
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Input range per channel for the 1D table. */
  domainMin1D: [number, number, number];
  domainMax1D: [number, number, number];
}

const MAX_3D = 256;
const MAX_1D = 65536;

function bad(msg: string): never {
  throw new ColorError('bad-cube', msg);
}

function nums(tokens: string[], from: number, count: number, what: string): number[] {
  if (tokens.length - from < count) bad(`${what} needs ${count} value(s)`);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = Number(tokens[from + i]);
    if (!Number.isFinite(v)) bad(`${what} has an invalid value`);
    out.push(v);
  }
  return out;
}

/** Parse the text of a .cube file. Throws ColorError 'not-cube' / 'bad-cube'. */
export function parseCube(text: string): Cube {
  if (typeof text !== 'string') throw new ColorError('not-cube', 'no text');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let title = '';
  let size3D = 0;
  let size1D = 0;
  let domainMin: number[] | null = null;
  let domainMax: number[] | null = null;
  let range1D: number[] | null = null;
  let range3D: number[] | null = null;
  const values: number[] = [];
  let sawKeyword = false;

  const lines = text.split(/\r\n|\n|\r/);
  for (const rawLine of lines) {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (line === '') continue;
    const first = line.charCodeAt(0);
    const isData = (first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46;
    if (isData) {
      const t = line.split(/[\s,]+/);
      if (t.length < 3) {
        if (size3D || size1D) bad('a data line has fewer than three values');
        continue;
      }
      const a = Number(t[0]), b = Number(t[1]), c = Number(t[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
        if (size3D || size1D) bad('a data line has an invalid value');
        continue;
      }
      values.push(a, b, c);
      continue;
    }
    const tokens = line.split(/\s+/);
    const key = tokens[0].toUpperCase();
    if (key === 'TITLE') {
      const rest = line.slice(tokens[0].length).trim();
      const m = /^"(.*)"$/.exec(rest);
      title = m ? m[1] : rest;
    } else if (key === 'LUT_3D_SIZE') {
      const n = nums(tokens, 1, 1, key)[0];
      if (!Number.isInteger(n) || n < 2 || n > MAX_3D) bad('LUT_3D_SIZE is out of range');
      size3D = n;
      sawKeyword = true;
    } else if (key === 'LUT_1D_SIZE') {
      const n = nums(tokens, 1, 1, key)[0];
      if (!Number.isInteger(n) || n < 2 || n > MAX_1D) bad('LUT_1D_SIZE is out of range');
      size1D = n;
      sawKeyword = true;
    } else if (key === 'DOMAIN_MIN') {
      domainMin = nums(tokens, 1, 3, key);
    } else if (key === 'DOMAIN_MAX') {
      domainMax = nums(tokens, 1, 3, key);
    } else if (key === 'LUT_1D_INPUT_RANGE') {
      range1D = nums(tokens, 1, 2, key);
    } else if (key === 'LUT_3D_INPUT_RANGE') {
      range3D = nums(tokens, 1, 2, key);
    }
    // any other keyword is ignored
  }

  if (!sawKeyword) throw new ColorError('not-cube', 'no LUT_3D_SIZE or LUT_1D_SIZE line');
  const n1 = size1D * 3;
  const n3 = size3D * size3D * size3D * 3;
  if (values.length !== n1 + n3)
    bad(`expected ${(n1 + n3) / 3} data lines, found ${values.length / 3}`);

  const dMin = (domainMin ?? [0, 0, 0]) as [number, number, number];
  const dMax = (domainMax ?? [1, 1, 1]) as [number, number, number];
  const min3: [number, number, number] = range3D ? [range3D[0], range3D[0], range3D[0]] : [dMin[0], dMin[1], dMin[2]];
  const max3: [number, number, number] = range3D ? [range3D[1], range3D[1], range3D[1]] : [dMax[0], dMax[1], dMax[2]];
  const min1: [number, number, number] = range1D ? [range1D[0], range1D[0], range1D[0]] : [dMin[0], dMin[1], dMin[2]];
  const max1: [number, number, number] = range1D ? [range1D[1], range1D[1], range1D[1]] : [dMax[0], dMax[1], dMax[2]];
  for (let c = 0; c < 3; c++) {
    if (size3D && !(max3[c] > min3[c])) bad('the input range of the 3D table is empty');
    if (size1D && !(max1[c] > min1[c])) bad('the input range of the 1D table is empty');
  }
  // a 1D shaper precedes the 3D data when both are present
  const all = Float64Array.from(values);
  return {
    title,
    size3D,
    data3D: size3D ? all.slice(n1) : null,
    size1D,
    data1D: size1D ? all.slice(0, n1) : null,
    domainMin: min3,
    domainMax: max3,
    domainMin1D: min1,
    domainMax1D: max1,
  };
}

/** Apply a cube to sRGB-encoded 0..1 triples: 1D table (linear, per channel), then 3D table (trilinear). Output clipped to 0..1. */
export function applyCube(cube: Cube, rgb: Float64Array): Float64Array {
  const out = new Float64Array(rgb.length);
  const { size1D, data1D, size3D, data3D } = cube;
  const v = [0, 0, 0];
  const idx = [0, 0, 0];
  const frac = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    v[0] = rgb[i]; v[1] = rgb[i + 1]; v[2] = rgb[i + 2];
    if (data1D) {
      for (let c = 0; c < 3; c++) {
        const lo = cube.domainMin1D[c], hi = cube.domainMax1D[c];
        let t = (v[c] - lo) / (hi - lo);
        t = t > 1 ? 1 : t > 0 ? t : 0; // also maps NaN to 0
        const pos = t * (size1D - 1);
        let k = Math.floor(pos);
        if (k > size1D - 2) k = size1D - 2;
        const f = pos - k;
        const a = data1D[k * 3 + c], b = data1D[(k + 1) * 3 + c];
        v[c] = a + (b - a) * f;
      }
    }
    if (data3D) {
      for (let c = 0; c < 3; c++) {
        const lo = cube.domainMin[c], hi = cube.domainMax[c];
        let t = (v[c] - lo) / (hi - lo);
        t = t > 1 ? 1 : t > 0 ? t : 0; // also maps NaN to 0
        const pos = t * (size3D - 1);
        let k = Math.floor(pos);
        if (k > size3D - 2) k = size3D - 2;
        idx[c] = k;
        frac[c] = pos - k;
      }
      const N = size3D;
      const fr = frac[0], fg = frac[1], fb = frac[2];
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let db = 0; db < 2; db++) {
          const wb = db ? fb : 1 - fb;
          for (let dg = 0; dg < 2; dg++) {
            const wg = dg ? fg : 1 - fg;
            const row = (idx[0] + N * (idx[1] + dg + N * (idx[2] + db))) * 3 + c;
            acc += wb * wg * ((1 - fr) * data3D[row] + fr * data3D[row + 3]);
          }
        }
        v[c] = acc;
      }
    }
    out[i] = v[0] < 0 ? 0 : v[0] > 1 ? 1 : v[0];
    out[i + 1] = v[1] < 0 ? 0 : v[1] > 1 ? 1 : v[1];
    out[i + 2] = v[2] < 0 ? 0 : v[2] > 1 ? 1 : v[2];
  }
  return out;
}
