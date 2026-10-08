/**
 * The camera's clarity table, and soft focus made from it.
 *
 * Clarity (Image Control, -4..+4) is a Laplacian pyramid on the developed picture (RetouchService,
 * function 0x538a1fa8): every band of detail is multiplied by a gain from this table before the
 * pyramid is put back together. The table is 9 rows (clarity -4..+4) of 11 int16 gains in Q10
 * (1024 = 1.0); column 0 is the finest band (full resolution), column i holds detail of about 2^i
 * pixels. The function copies the whole table to the stack (0x538a1fe0), returns at once for
 * clarity 0, takes row `clarity + 4` (0x538a2634) and reads one gain per band with `ldrsh`
 * (0x538a2da4) into the first diagonal entry of a CSC matrix whose other entries are 1.0.
 *
 * Lowering the gains of the fine and middle bands while keeping the coarse ones gives roughly
 * g * picture + (1 - g) * a strongly blurred picture: the classic digital soft focus. Rewriting
 * the rows of the negative clarity settings this way is a same-length data edit (198 bytes).
 */
import { RTOS_OFFSET, RTOS_VA } from './profile';
import { FirmwareError } from './types';

/** Address of the table in the camera. */
export const CLARITY_VA = 0x53b4c860;
/** Offset of the table in the decoded payload. */
export const CLARITY_OFFSET = RTOS_OFFSET + (CLARITY_VA - RTOS_VA);
export const CLARITY_ROWS = 9;
export const CLARITY_BANDS = 11;
export const CLARITY_BYTES = CLARITY_ROWS * CLARITY_BANDS * 2;
/** Largest gain accepted (the camera's own table goes from 776 to 1351; the CSC field is 15-bit signed). */
export const CLARITY_GAIN_MAX = 2048;

/** The table in official firmware 1.11, row = clarity + 4. */
export const OFFICIAL_CLARITY: readonly (readonly number[])[] = [
  [1024, 820, 776, 776, 776, 776, 820, 843, 1024, 1024, 1024],
  [1024, 867, 832, 832, 832, 832, 867, 885, 1024, 1024, 1024],
  [1024, 917, 891, 891, 891, 891, 917, 929, 1024, 1024, 1024],
  [1024, 969, 955, 955, 955, 955, 969, 976, 1024, 1024, 1024],
  [1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024],
  [1024, 1082, 1097, 1097, 1097, 1097, 1082, 1075, 1024, 1024, 1024],
  [1024, 1144, 1176, 1176, 1176, 1176, 1144, 1128, 1024, 1024, 1024],
  [1024, 1209, 1261, 1261, 1261, 1261, 1209, 1184, 1024, 1024, 1024],
  [1024, 1278, 1351, 1351, 1351, 1351, 1278, 1243, 1024, 1024, 1024],
];

export type SoftFocusStrength = 'weak' | 'medium' | 'strong';
export const SOFT_FOCUS_STRENGTHS: readonly SoftFocusStrength[] = ['weak', 'medium', 'strong'];
/** Gains per band (finest first) for the three strengths. */
export const SOFT_FOCUS_GAINS: Readonly<Record<SoftFocusStrength, readonly number[]>> = {
  weak: [820, 740, 700, 700, 740, 840, 940, 1024, 1024, 1024, 1024],
  medium: [680, 560, 500, 500, 540, 680, 860, 960, 1024, 1024, 1024],
  strong: [540, 400, 330, 330, 380, 540, 760, 920, 1024, 1024, 1024],
};

/** The clarity settings whose row soft focus may replace. */
export type SoftFocusLevel = -1 | -2 | -3 | -4;
export const SOFT_FOCUS_LEVELS: readonly SoftFocusLevel[] = [-1, -2, -3, -4];

/** One row of the table to replace: `level` is the clarity setting (-4..+4, not 0). */
export interface ClarityEdit {
  level: number;
  gains: ArrayLike<number>;
}

function bad(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** The table as found in a decoded payload of the official layout. */
export function readClarity(decoded: Uint8Array, offset = CLARITY_OFFSET): number[][] {
  const v = new DataView(decoded.buffer, decoded.byteOffset + offset, CLARITY_BYTES);
  const rows: number[][] = [];
  for (let r = 0; r < CLARITY_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < CLARITY_BANDS; c++) row.push(v.getInt16((r * CLARITY_BANDS + c) * 2, true));
    rows.push(row);
  }
  return rows;
}

/** True when the payload holds the official table. */
export function hasOfficialClarity(decoded: Uint8Array, offset = CLARITY_OFFSET): boolean {
  const rows = readClarity(decoded, offset);
  return rows.every((row, r) => row.every((g, c) => g === OFFICIAL_CLARITY[r][c]));
}

/** The 198 bytes of the official table with `edits` applied. Throws on an invalid edit. */
export function clarityBytes(edits: readonly ClarityEdit[]): Uint8Array {
  const out = new Uint8Array(CLARITY_BYTES);
  const v = new DataView(out.buffer);
  const rows = OFFICIAL_CLARITY.map((r) => [...r]);
  const seen = new Set<number>();
  for (const e of edits) {
    if (!e || !Number.isInteger(e.level) || e.level < -4 || e.level > 4 || e.level === 0) bad('bad-clarity', `clarity level ${String(e && e.level)} cannot be changed`);
    if (seen.has(e.level)) bad('bad-clarity', `clarity ${e.level} is edited twice`);
    seen.add(e.level);
    if (!e.gains || e.gains.length !== CLARITY_BANDS) bad('bad-clarity', `clarity ${e.level}: ${CLARITY_BANDS} gains are needed`);
    for (let c = 0; c < CLARITY_BANDS; c++) {
      const g = e.gains[c];
      if (!Number.isInteger(g) || g < 0 || g > CLARITY_GAIN_MAX) bad('bad-clarity', `clarity ${e.level}: gain ${String(g)} is not an integer in 0..${CLARITY_GAIN_MAX}`);
      rows[e.level + 4][c] = g;
    }
  }
  for (let r = 0; r < CLARITY_ROWS; r++) for (let c = 0; c < CLARITY_BANDS; c++) v.setInt16((r * CLARITY_BANDS + c) * 2, rows[r][c], true);
  return out;
}

/** What a payload's table does with the clarity settings that differ from the official one. */
export interface ClarityChange {
  level: number;
  /** The soft focus strength whose gains the row holds, or `custom`. */
  strength: SoftFocusStrength | 'custom';
}

/** The rows of a payload's table that differ from the official one, -4 first. */
export function clarityChanges(decoded: Uint8Array, offset = CLARITY_OFFSET): ClarityChange[] {
  const rows = readClarity(decoded, offset);
  const out: ClarityChange[] = [];
  for (let r = 0; r < CLARITY_ROWS; r++) {
    if (rows[r].every((g, c) => g === OFFICIAL_CLARITY[r][c])) continue;
    const strength = SOFT_FOCUS_STRENGTHS.find((s) => SOFT_FOCUS_GAINS[s].every((g, c) => g === rows[r][c])) || 'custom';
    out.push({ level: r - 4, strength });
  }
  return out;
}
