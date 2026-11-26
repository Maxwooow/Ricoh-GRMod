// SPDX-License-Identifier: GPL-2.0-only
/**
 * Distances in feet for GR III 2.10 / IIIx 1.60 (as GR IV's, ../gr4v120/aspect/units.ts): Snap Focus
 * Distance and the manual focus scale in feet and inches instead of metres and centimetres. Off
 * unless asked for; metres stay the camera's own.
 *
 *  - Snap Focus Distance, its eight values: texts 62..69 (0.3m, 0.4m, 1m, 1.5m, 2m, 2.5m, 3.5m, 5m,
 *    the same in every language; GR IV's are 66..73). They become 1ft, 1.3ft, 3.3ft, 4.9ft, 6.6ft,
 *    8.2ft, 11ft and 16ft in every language.
 *  - The manual focus scale. Its labels are 30 x 20 icons set by 0x53393190, the same function as
 *    GR IV 1.20's 0x53592728 with every `mov r1, #icon` at the same offset: the unit (0x295 "m" or
 *    0x293 "cm") and the figures at fixed places on the scale, chosen by the scale and the nearest
 *    focus distance (GR III's lens 60 mm, GR IIIx's 120 mm; one program for both):
 *      m:              m, ∞, 5, 3, 1, 0.3
 *      cm (120 mm):    cm, 30, 24, 20, 12
 *      cm (60 mm):     cm, 30, 12, 10, 6        (GR IV: 30, 15, 10, 6)
 *    Each site gets an icon of its own: the same distance in feet or inches at the same place
 *    (16, 9.8, 3.3, 1 ft; 12, 9.4, 7.9, 4.7 in; 12, 4.7, 3.9, 2.4 in), and the unit ft / in. ∞ stays.
 *    The labels are GR IV's (../gr4v120/aspect/units-icons.ts), drawn in the style of the camera's.
 */
import { movWord } from '../aspect/arm';
import { UNIT_LABELS } from '../gr4v120/aspect/units-icons';
import { FirmwareError } from '../types';
import { adr } from './target';

export const GR3X_SNAP_TEXT_IDS = [62, 63, 64, 65, 66, 67, 68, 69] as const;
export const GR3X_SNAP_METRES = ['0.3m', '0.4m', '1m', '1.5m', '2m', '2.5m', '3.5m', '5m'] as const;
export const GR3X_SNAP_FEET = ['1ft', '1.3ft', '3.3ft', '4.9ft', '6.6ft', '8.2ft', '11ft', '16ft'] as const;

const SCALE_LABELS = adr(0x53393190);
/** Offset in the function, the camera's word (its icon), the label in its place. */
export const GR3X_SCALE_SITES: readonly (readonly [number, number, string])[] = [
  [0x34, 0xe3001295, 'ft'], [0x4c, 0xe3a01088, '16'], [0x58, 0xe3a01086, '9.8'], [0x64, 0xe3a01083, '3.3'], [0x70, 0xe3001292, '1'],
  [0xcc, 0xe3001293, 'in'], [0xd8, 0xe3a01087, '12'],
  [0x100, 0xe3a0101f, '9.4'], [0x10c, 0xe3a0102f, '7.9'], [0x118, 0xe3a01085, '4.7'],
  [0x1a0, 0xe3a01085, '4.7'], [0x1ac, 0xe3a01084, '3.9'], [0x1b8, 0xe3a01089, '2.4'],
];
/** ∞ (0x294) between the unit and the first figure: kept. */
const INFINITY_SITE = [0x40, 0xe3a01fa5] as const;

/** The labels, in the order of their icons (the first is the caller's). */
export const GR3X_UNIT_LABELS = ['ft', 'in', '16', '9.8', '3.3', '1', '12', '9.4', '7.9', '4.7', '3.9', '2.4'] as const;
export const GR3X_UNIT_ICON_W = 30;
export const GR3X_UNIT_ICON_H = 20;

const fail = (m: string): never => { throw new FirmwareError('unexpected-layout', `IIIx distances in feet: ${m}`); };

/** A label as RGBA: grey on an opaque outline, transparent around it. */
export function gr3xUnitLabelPixels(name: string): Uint8Array {
  const packed = UNIT_LABELS[name];
  if (!packed) fail(`no label ${name}`);
  const bin = atob(packed);
  if (bin.length !== GR3X_UNIT_ICON_W * GR3X_UNIT_ICON_H) fail('label size');
  const px = new Uint8Array(bin.length * 4);
  for (let i = 0; i < bin.length; i++) {
    const v = bin.charCodeAt(i);
    if (v === 0) continue;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v - 1;
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** The scale's words: each label site loads the icon `first + index of its label`. */
export function installGr3xScaleFeet(p: { patch(address: number, expected: number, replacement: number, reason: string): void; word(address: number): number }, first: number) {
  if (p.word(SCALE_LABELS + INFINITY_SITE[0]) !== INFINITY_SITE[1]) fail('the manual focus scale is not where it was expected');
  for (const [offset, word, label] of GR3X_SCALE_SITES) {
    const k = GR3X_UNIT_LABELS.indexOf(label as typeof GR3X_UNIT_LABELS[number]);
    if (k < 0) fail(`label ${label}`);
    p.patch(SCALE_LABELS + offset, word, movWord(1, first + k), `manual focus scale: ${label}`);
  }
}
