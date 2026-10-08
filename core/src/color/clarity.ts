/**
 * A model of the camera's clarity step (RetouchService, 0x538a1fa8), for previews.
 *
 * The camera builds a Laplacian pyramid of the developed picture: each level is the previous one
 * scaled by 0.5 (size ((n + 3) >> 1) & ~1, while both sides stay above 4, at most 11 levels), the detail of a level is the level minus the next one
 * scaled back up, and the detail is multiplied by the gain of its band (clarity table, Q10). The
 * picture is put back together from the top. The gain goes into the first entry of a CSC matrix
 * whose other diagonal entries are 1.0, so this model changes luma only and leaves Cb and Cr alone.
 *
 * Approximations: bilinear scaling (the IIP unit's interpolation is not known), floating point
 * instead of the camera's 12/14-bit integers, and a picture smaller than the camera's: band i of
 * the camera holds detail of about 2^i pixels of the full-size JPEG, so on a picture
 * `frameWidth / width` times smaller the gains are taken log2 of that many bands further along
 * (interpolated), and the finest bands, which are below one preview pixel, have no counterpart.
 */

/** Sizes of the pyramid levels the camera uses for a picture (full resolution first). */
export function clarityLevels(width: number, height: number, maxLevels = 11): [number, number][] {
  const out: [number, number][] = [[width, height]];
  let w = width;
  let h = height;
  // 0x538a20e4: a level is kept only while both sides stay above 4
  while (out.length < maxLevels) {
    w = ((w + 3) >> 1) & ~1;
    h = ((h + 3) >> 1) & ~1;
    if (w <= 4 || h <= 4) break;
    out.push([w, h]);
  }
  return out;
}

interface Axis { i0: Int32Array; i1: Int32Array; f: Float32Array }

/** Bilinear sampling positions for scaling `from` samples to `to` samples (pixel centres aligned). */
function axis(from: number, to: number): Axis {
  const i0 = new Int32Array(to);
  const i1 = new Int32Array(to);
  const f = new Float32Array(to);
  const s = from / to;
  for (let x = 0; x < to; x++) {
    let p = (x + 0.5) * s - 0.5;
    if (p < 0) p = 0;
    if (p > from - 1) p = from - 1;
    const a = Math.floor(p);
    i0[x] = a;
    i1[x] = Math.min(from - 1, a + 1);
    f[x] = p - a;
  }
  return { i0, i1, f };
}

function scale(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const ax = axis(sw, dw);
  const ay = axis(sh, dh);
  const tmp = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    const o = y * dw;
    for (let x = 0; x < dw; x++) {
      const a = src[row + ax.i0[x]];
      tmp[o + x] = a + (src[row + ax.i1[x]] - a) * ax.f[x];
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const r0 = ay.i0[y] * dw;
    const r1 = ay.i1[y] * dw;
    const fy = ay.f[y];
    const o = y * dw;
    for (let x = 0; x < dw; x++) {
      const a = tmp[r0 + x];
      out[o + x] = a + (tmp[r1 + x] - a) * fy;
    }
  }
  return out;
}

/** Gain (1.0 = unchanged) of preview level `j`, `shift` bands finer than the camera's level `j`. */
function gainAt(gains: ArrayLike<number>, j: number, shift: number): number {
  const last = gains.length - 1;
  const c = j + shift;
  if (c >= last) return gains[last] / 1024;
  const c0 = Math.floor(c);
  const f = c - c0;
  return (gains[c0] * (1 - f) + gains[c0 + 1] * f) / 1024;
}

/**
 * The clarity step applied to an 8-bit RGBA picture. `gains` are one row of the clarity table
 * (Q10, finest band first); `frameWidth` is the width of the full-size JPEG the picture stands for.
 */
export function simulateClarity(src: ArrayLike<number>, width: number, height: number, gains: ArrayLike<number>, frameWidth = width): Uint8ClampedArray {
  const n = width * height;
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const r = src[q], g = src[q + 1], b = src[q + 2];
    Y[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[p] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const shift = Math.max(0, Math.log2(frameWidth / width));
  const sizes = clarityLevels(width, height, 64);
  const levels: Float32Array[] = [Y];
  for (let i = 1; i < sizes.length && i + shift <= gains.length; i++) levels.push(scale(levels[i - 1], sizes[i - 1][0], sizes[i - 1][1], sizes[i][0], sizes[i][1]));
  // from the top down: picture = scaled-up coarser picture + gain * detail
  let rec = levels[levels.length - 1];
  for (let i = levels.length - 2; i >= 0; i--) {
    const [w, h] = sizes[i];
    const [cw, ch] = sizes[i + 1];
    const upLevel = scale(levels[i + 1], cw, ch, w, h);
    const upRec = rec === levels[i + 1] ? upLevel : scale(rec, cw, ch, w, h);
    const g = gainAt(gains, i, shift);
    const L = levels[i];
    const out = new Float32Array(w * h);
    for (let p = 0; p < out.length; p++) out[p] = upRec[p] + g * (L[p] - upLevel[p]);
    rec = out;
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const y = rec[p], cb = Cb[p], cr = Cr[p];
    out[q] = y + 1.402 * cr;
    out[q + 1] = y - 0.344136 * cb - 0.714136 * cr;
    out[q + 2] = y + 1.772 * cb;
    out[q + 3] = src[q + 3];
  }
  return out;
}
