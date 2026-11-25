// SPDX-License-Identifier: GPL-2.0-only
/**
 * Distances in feet (GR IV 1.20 and 1.21): Snap Focus Distance and the manual focus scale in feet and inches instead
 * of metres and centimetres. Off unless asked for (`distanceFeet`); metres stay the camera's own.
 *
 * Where the camera shows a distance:
 *  - Snap Focus Distance, its eight values (texts 66..73: 0.3m, 0.4m, 1m, 1.5m, 2m, 2.5m, 3.5m, 5m; ∞ is text 13).
 *    The menu, its list, the shooting screen (0x533B5C00: the distance in cm to the text) and the ADJ lever all
 *    show these texts. Every language has the same eight. They become 1ft, 1.3ft, 3.3ft, 4.9ft, 6.6ft, 8.2ft,
 *    11ft and 16ft (rounded to two figures) in every language.
 *  - The manual focus scale. Its labels are icons set by 0x53592728: the unit (0x2c3 "m" or 0x2c1 "cm") and up to
 *    five figures at fixed places on the scale, chosen by the scale (a byte of the view, + 0x124) and the nearest
 *    focus distance (60 or 120 mm, 0x533B1198):
 *      m:              m, ∞, 5, 3, 1, 0.3
 *      cm (60 mm):     cm, 30, 15, 10, 6
 *      cm (120 mm):    cm, 30, 24, 20, 12
 *    Each `mov r1, #icon` gets an icon of its own (UNIT_ICON_IDS): the same distance in feet or inches, at the same
 *    place on the scale (16, 9.8, 3.3, 1 ft; 12, 5.9, 3.9, 2.4 in; 12, 9.4, 7.9, 4.7 in), and the unit ft / in. ∞
 *    stays. The icons are drawn in the style of the camera's own labels (`tools/units/labels.py`, units-icons.ts).
 * Not changed: the camera's other distances (the altitude of a picture's position in playback, "%dm"; the Direct
 * Flash menu's guide numbers, which are in metres by convention).
 *
 * The scale's function is the same code in 1.21, moved: its address is looked up (`adr`); the words replaced are
 * checked before they are.
 */
import { FirmwareError } from '../../types';
import { adr } from '../target';
import { movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, Patch, TEXT_CATALOG, concat, u16le, u32le, utf16z } from './build';
import { UNIT_LABELS } from './units-icons';

/** The Snap Focus Distance values (texts 66..73) in metres, as the camera has them, and in feet. */
export const SNAP_TEXT_IDS = [66, 67, 68, 69, 70, 71, 72, 73] as const;
export const SNAP_METRES = ['0.3m', '0.4m', '1m', '1.5m', '2m', '2.5m', '3.5m', '5m'] as const;
export const SNAP_FEET = ['1ft', '1.3ft', '3.3ft', '4.9ft', '6.6ft', '8.2ft', '11ft', '16ft'] as const;

/** The function that sets the manual focus scale's labels. */
const SCALE_LABELS = adr(0x53592728);
/**
 * Its `mov r1, #icon` / `movw r1, #icon` words (offset in the function, the camera's word, the label in its place).
 * The camera's icons: 0x2c3 m, 0x2c1 cm, 0x94 5, 0x92 3, 0x8e 1, 0x2c0 0.3, 0x93 30, 0x2b 24, 0x38 20, 0x90 12,
 * 0x91 15, 0x8f 10, 0x95 6.
 */
export const SCALE_SITES: readonly (readonly [number, number, string])[] = [
  [0x34, 0xe30012c3, 'ft'], [0x4c, 0xe3a01094, '16'], [0x58, 0xe3a01092, '9.8'], [0x64, 0xe3a0108e, '3.3'], [0x70, 0xe3a01d0b, '1'],
  [0xcc, 0xe30012c1, 'in'], [0xd8, 0xe3a01093, '12'],
  [0x100, 0xe3a0102b, '9.4'], [0x10c, 0xe3a01038, '7.9'], [0x118, 0xe3a01090, '4.7'],
  [0x1a0, 0xe3a01091, '5.9'], [0x1ac, 0xe3a0108f, '3.9'], [0x1b8, 0xe3a01095, '2.4'],
];
/** ∞ (0x2c2) between the unit and the first figure: kept. */
const INFINITY_SITE = [0x40, 0xe30012c2] as const;

/** The labels, in the order of their icon numbers (UNIT_ICON_FIRST, ...). */
export const UNIT_LABEL_NAMES = ['ft', 'in', '16', '9.8', '3.3', '1', '12', '9.4', '7.9', '4.7', '5.9', '3.9', '2.4'] as const;
export const UNIT_ICON_FIRST = 1130;
export const UNIT_ICON_IDS: Readonly<Record<string, number>> = Object.fromEntries(UNIT_LABEL_NAMES.map((name, k) => [name, UNIT_ICON_FIRST + k]));
export const UNIT_ICON_W = 30;
export const UNIT_ICON_H = 20;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** A label as RGBA: grey on an opaque outline, transparent around it. */
export function unitLabelPixels(name: string): Uint8Array {
  const packed = UNIT_LABELS[name];
  if (!packed) fail('internal', `no label ${name}`);
  const bin = atob(packed);
  if (bin.length !== UNIT_ICON_W * UNIT_ICON_H) fail('internal', 'label size');
  const px = new Uint8Array(bin.length * 4);
  for (let i = 0; i < bin.length; i++) {
    const v = bin.charCodeAt(i);
    if (v === 0) continue;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v - 1;
    px[i * 4 + 3] = 255;
  }
  return px;
}

function readText(patch: Patch, descriptor: number): string {
  const head = patch.readMapped(descriptor, 8);
  const units = head[0];
  const address = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
  const raw = patch.readMapped(address, units * 2);
  let s = '';
  for (let i = 0; i < units; i++) {
    const c = raw[i * 2] | (raw[i * 2 + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Snap Focus Distance in feet, in every language. */
function installSnapFeet(patch: Patch): void {
  const records = SNAP_FEET.map((name) => {
    const encoded = utf16z(name);
    const address = patch.append(encoded, 4);
    return patch.append(concat([Uint8Array.from([encoded.length / 2, 1, 0, 0]), u32le([address])]), 4);
  });
  for (let l = 0; l < LANGUAGES; l++) {
    const row = patch.word(TEXT_CATALOG + l * 4);
    SNAP_TEXT_IDS.forEach((id, k) => {
      const old = patch.word(row + id * 4);
      if (old === 0 || readText(patch, old) !== SNAP_METRES[k]) fail('unexpected-layout', 'the Snap Focus Distance texts are not the ones expected');
      patch.write(row + id * 4, u32le([records[k]]));
    });
  }
}

/** The labels of the manual focus scale in feet and inches: the icons, then the scale's words. */
function installScaleFeet(patch: Patch, iconbin: Uint8Array): Uint8Array {
  if (patch.word(SCALE_LABELS + INFINITY_SITE[0]) !== INFINITY_SITE[1]) fail('unexpected-layout', 'the manual focus scale is not where it was expected');
  for (const [offset, word] of SCALE_SITES) {
    if (patch.word(SCALE_LABELS + offset) !== word) fail('unexpected-layout', 'the manual focus scale is not where it was expected');
  }
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  for (const name of UNIT_LABEL_NAMES) {
    const id = UNIT_ICON_IDS[name];
    if (patch.word(ICON_CATALOG + id * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const px = unitLabelPixels(name);
    const offset = length;
    parts.push(px);
    length += px.length;
    // {u16 kind = 1, u16 width, u16 height, u16 flags = 0, u32 offset in 4-byte units}
    const descriptor = patch.append(concat([u16le([1, UNIT_ICON_W, UNIT_ICON_H, 0]), u32le([offset / 4])]), 16);
    patch.write(ICON_CATALOG + id * 4, u32le([descriptor]));
  }
  const upper = Math.max(...Object.values(UNIT_ICON_IDS));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(upper, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  for (const [offset, , label] of SCALE_SITES) patch.setWord(SCALE_LABELS + offset, movWord(1, UNIT_ICON_IDS[label]), `manual focus scale: ${label}`);
  return concat(parts);
}

/** Distances in feet: Snap Focus Distance and the manual focus scale. Returns ICONBIN with the labels appended. */
export function installDistanceFeet(patch: Patch, iconbin: Uint8Array): Uint8Array {
  installSnapFeet(patch);
  return installScaleFeet(patch, iconbin);
}
