// SPDX-License-Identifier: GPL-2.0-only
/** Readable 40px labels on the camera's native film frame. Imported film logos
 * remain user-controlled; M1..M6 distinguish the six explicitly named replicas.
 * These are original slot symbols, not commercial film or GR IV M branding. */
import { FirmwareError } from '../types';

const GLYPHS: Record<string, string[]> = {
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  0: ['01110','10001','10011','10101','11001','10001','01110'],
  1: ['00100','01100','00100','00100','00100','00100','01110'],
  2: ['01110','10001','00001','00010','00100','01000','11111'],
  3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'],
  5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'],
  7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'],
  9: ['01110','10001','10001','01111','00001','00001','01110'],
};
export function gr3xLookBadge(template: Uint8Array, kind: 'F' | 'M', number: number) {
  if (template.length !== 6400 || !Number.isInteger(number) || number < 1 || number > (kind === 'F' ? 20 : 6))
    throw new FirmwareError('bad-icon', 'invalid IIIx look badge');
  const out = template.slice();
  // F1..F9 as before (from x = 9); F10..F20 (round 6) three glyphs from x = 3, inside the frame's
  // picture area (x 2..37).
  const left = number > 9 ? 3 : 9;
  [...kind + number].forEach((ch, j) => GLYPHS[ch].forEach((row, y) =>
    [...row].forEach((on, x) => {
      if (on === '1') for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
        out.set([240, 240, 240, 255], ((13 + y * 2 + dy) * 40 + left + j * 12 + x * 2 + dx) * 4);
    })));
  return out;
}
