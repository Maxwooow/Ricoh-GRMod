// Hue sectors: 12 pieces of the hue circle, each with a 3x3 matrix applied before the tone curves.
//
// This is the camera's own "hue sector" stage, the one LUTSmith's hue fitting uses. The matrices
// are stored per style in the 2160-byte multi-axis block (5 copies x 12 sectors x 3x3 int32, Q10,
// every row summing to 1024). On the GR IV an added Image Control slot can carry its own block
// instead of the neutral one copied from Standard.
//
// Reference for the sector layout and the matrix parametrisation: `hue_coords`, `hue_matrices` and
// `hue_apply_q` in GR4-LUTSmith's gr4_lutsmith.py (GPL-3.0; this file is GR Mod's own port of the
// published method, not copied code).

/** Sector boundaries in degrees, as used by the camera's hue-sector stage. */
export const HUE_BOUNDS: readonly number[] = [359.8, 27.4, 62.2, 92.6, 112.0, 142.8, 179.2, 211.4, 238.6, 267.2, 306.0, 326.5];

/** YCbCr matrix used to measure hue. */
const YCC: readonly (readonly number[])[] = [
  [0.30078125, 0.5859375, 0.11328125],
  [-0.16796875, -0.33203125, 0.5],
  [0.5, -0.41796875, -0.08203125],
];

const RAD = Math.PI / 180;

/** Sector index for a linear RGB triple. */
export function hueSector(r: number, g: number, b: number): number {
  const cb = YCC[1][0] * r + YCC[1][1] * g + YCC[1][2] * b;
  const cr = YCC[2][0] * r + YCC[2][1] * g + YCC[2][2] * b;
  let ang = Math.atan2(cr, cb) / RAD;
  if (ang < 0) ang += 360;
  let best = 0, bestD = 1e9;
  for (let i = 0; i < 12; i++) {
    let d = (ang - HUE_BOUNDS[i]) % 360;
    if (d < 0) d += 360;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Apply the 12 matrices (row-major 12 x 9, rows summing to 1) to a linear RGB triple in place. */
export function hueApply(rgb: Float64Array | number[], m: readonly (readonly number[])[]): void {
  const g = hueSector(rgb[0], rgb[1], rgb[2]);
  const q = m[g];
  const r = q[0] * rgb[0] + q[1] * rgb[1] + q[2] * rgb[2];
  const gg = q[3] * rgb[0] + q[4] * rgb[1] + q[5] * rgb[2];
  const b = q[6] * rgb[0] + q[7] * rgb[1] + q[8] * rgb[2];
  rgb[0] = r; rgb[1] = gg; rgb[2] = b;
}

/** Build the 12 sector matrices from 12 x 3 parameters (rows 0..2 = R/G/B shifts), rows sum to 1. */
export function hueMatricesFromD(d: ArrayLike<number>): number[][] {
  const out: number[][] = [];
  for (let g = 0; g < 12; g++) {
    const th0 = HUE_BOUNDS[g] * RAD, th1 = HUE_BOUNDS[(g + 1) % 12] * RAD;
    const c0 = Math.cos(th0), s0 = Math.sin(th0), c1 = Math.cos(th1), s1 = Math.sin(th1);
    const det = c0 * s1 - s0 * c1;
    // U^-1 = 1/det * [[s1, -c1], [-s0, c0]]
    const u00 = s1 / det, u01 = -c1 / det, u10 = -s0 / det, u11 = c0 / det;
    // D_g (3) and D_{g+1} (3) as two columns; multiply by U^-1 then by YCC rows 1..2.
    const m: number[] = [];
    for (let c = 0; c < 3; c++) {
      const d0 = d[c * 12 + g], d1 = d[c * 12 + (g + 1) % 12];
      for (let k = 0; k < 3; k++) {
        const a = d0 * u00 + d1 * u10;
        const b = d0 * u01 + d1 * u11;
        m[c * 3 + k] = (c === k ? 1 : 0) + a * YCC[1][k] + b * YCC[2][k];
      }
    }
    // Rows sum to 1 by construction; normalise away floating error.
    for (let c = 0; c < 3; c++) {
      const sum = m[c * 3] + m[c * 3 + 1] + m[c * 3 + 2];
      m[c * 3 + 2] += 1 - sum;
    }
    out.push(m);
  }
  return out;
}

/** Round float matrices to the firmware's Q10 integers; every row is repaired to sum to 1024. */
export function hueQuantize(m: readonly (readonly number[])[]): number[][] {
  const out: number[][] = [];
  for (const matrix of m) {
    const q = matrix.map((v) => Math.round(v * 1024));
    for (let r = 0; r < 3; r++) q[r * 3 + 2] += 1024 - (q[r * 3] + q[r * 3 + 1] + q[r * 3 + 2]);
    out.push(q);
  }
  return out;
}

/** The 2160-byte multi-axis block: 5 copies of the 12 Q10 matrices, little-endian int32. */
export function hueBlockBytes(m: readonly (readonly number[])[]): Uint8Array {
  if (m.length !== 12 || m.some((q) => q.length !== 9)) throw new Error('hueBlockBytes: expected 12 x 9 matrices');
  const out = new Uint8Array(5 * 12 * 9 * 4);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let sector = 0; sector < 12; sector++) {
    for (let copy = 0; copy < 5; copy++) {
      for (let k = 0; k < 9; k++) { view.setInt32(o, m[sector][k], true); o += 4; }
    }
  }
  return out;
}
