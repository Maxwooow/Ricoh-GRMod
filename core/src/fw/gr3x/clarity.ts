// SPDX-License-Identifier: GPL-2.0-only
/** IIIx 1.60's native Clarity control. Only its negative gain rows are editable.
 * This port does not reuse the IV ADJ flash slot, which is in use on IIIx.
 * The table copy and row selection are exercised by clarity_probe.py. */
import { clarityBytes, hasOfficialClarity, SOFT_FOCUS_GAINS, SOFT_FOCUS_LEVELS, SOFT_FOCUS_STRENGTHS } from '../clarity';
import type { ClarityEdit, SoftFocusLevel, SoftFocusStrength } from '../clarity';
import { FirmwareError } from '../types';
import { gr3xOffset } from './profile';

export const GR3X_CLARITY_VA = 0x538f1fd4;
export const GR3X_CLARITY_OFFSET = gr3xOffset(GR3X_CLARITY_VA);
export interface Gr3xSoftFocusRequest { level: SoftFocusLevel; strength: SoftFocusStrength }

export function gr3xClarityBytes(decoded: Uint8Array, requests: readonly Gr3xSoftFocusRequest[]): Uint8Array {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const word = (va: number) => view.getUint32(gr3xOffset(va), true);
  if (!hasOfficialClarity(decoded, GR3X_CLARITY_OFFSET) ||
      word(0x5367c338) !== GR3X_CLARITY_VA || // literal used by the native table copy
      word(0x5367c18c) !== 0xe3a020c6 ||    // memcpy: 198 bytes
      word(0x5367c1ac) !== 0xe2888004 ||    // level -4..4 -> row 0..8
      word(0x5367c7dc) !== 0xe3a03016 ||    // 22 bytes per row
      word(0x5367c7e4) !== 0xe0281893) {
    throw new FirmwareError('unexpected-layout', 'IIIx clarity table or its native consumer changed');
  }
  const edits: ClarityEdit[] = requests.map(r => {
    if (!r || !SOFT_FOCUS_LEVELS.includes(r.level) || !SOFT_FOCUS_STRENGTHS.includes(r.strength)) {
      throw new FirmwareError('bad-clarity', 'IIIx soft focus requires a negative clarity level and a known strength');
    }
    return { level: r.level, gains: SOFT_FOCUS_GAINS[r.strength] };
  });
  return clarityBytes(edits);
}
