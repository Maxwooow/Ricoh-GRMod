// SPDX-License-Identifier: GPL-2.0-only
import { sectionsOf } from '../container';
import { FirmwareError } from '../types';
import { CONTENT_AREA, TILE_BG } from '../icons';
import { gr3xOffset } from './profile';

/** Twenty film slots (round 6); the camera-tested T6 builds have the first nine. */
export const GR3X_FILM_NAMES = Array.from({ length: 20 }, (_, i) => `Film ${i + 1}`) as readonly string[];
// CY/CG retain their old application identities for archived projects.
export const GR3X_FILM_IDS = ['CY', 'CG', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20'] as const;
export const GR3X_LOOK_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('');
/** The camera's text rows (21) in LangCode terms: row n of the text directory is GR3X_TEXT_ROWS[n]. */
export const GR3X_TEXT_ROWS = ['ja', 'en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'da', 'sv', 'fi', 'pl', 'cs', 'hu', 'tr', 'el', 'ru', 'ko', 'zh-TW', 'zh-CN', 'th'] as const;
export type Gr3xTextLang = typeof GR3X_TEXT_ROWS[number];
/** Characters of one language: printable ASCII plus every character its own menu texts use
 * (a proxy for the camera font of that language having the glyph, as on GR IV). */
export function gr3xAllowedChars(decoded: Uint8Array, lang: Gr3xTextLang): string {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const RTOS = 0x10870, BASE = 0x53000000, RAM = 0x55000000, RAM_IMAGE = 0x5407b540, RAM_LEN = 0x3a080, LEN = 17520064;
  const off = (va: number) => {
    if (va >= RAM && va < RAM + RAM_LEN) va = RAM_IMAGE + va - RAM;
    if (va < BASE || va >= BASE + LEN) throw new FirmwareError('bad-address', 'IIIx text outside RTOS');
    return RTOS + va - BASE;
  };
  const u32 = (va: number) => view.getUint32(off(va), true);
  const set = new Set<number>();
  for (let c = 0x20; c <= 0x7e; c++) set.add(c);
  const row = u32(0x55002bac + GR3X_TEXT_ROWS.indexOf(lang) * 4);
  for (let i = 0; i < 786; i++) {
    let desc: number, n: number, p: number;
    try { desc = u32(row + i * 4); n = decoded[off(desc)]; p = u32(desc + 4); off(p + 2 * Math.max(0, n - 1)); } catch { continue; } // empty entries
    for (let k = 0; k + 1 < n; k++) { const u = view.getUint16(off(p) + 2 * k, true); if (u >= 0x20 && !(u >= 0x7f && u <= 0x9f) && !(u >= 0xd800 && u <= 0xdfff)) set.add(u); }
  }
  return String.fromCharCode(...[...set].sort((a, b) => a - b));
}
/**
 * Characters GR III's own texts do not use but its fonts have: GR III 2.10's RT_CN_S and RT_CN_T are
 * GR IV 1.11's, byte for byte (SHA-256 equal), and GR IV shows 光晕 / 光暈 (GR Mod's Halation row)
 * with them. Round 8 names the Halation row as GR IV does.
 */
export const GR3X_FONT_VERIFIED_CHARS = '晕暈';
/** Per-language name check against that language's characters (24 UTF-16 units, one line). */
export function validateGr3xLookNameFor(name: string, allowed: string) {
  if (!name.trim() || name !== name.trim()) throw new FirmwareError('bad-name', 'IIIx look name is empty or padded');
  if (name.length > 24 || [...name].some(c => c.length !== 1 || !allowed.includes(c)))
    throw new FirmwareError('bad-name', 'IIIx look name has a character this language\'s camera font lacks, or exceeds 24 units');
}
export function validateGr3xLookName(name: string) {
  if (!name.trim()) throw new FirmwareError('bad-name', 'IIIx look name is empty');
  if (name.length > 24 || /[^\x20-\x7e]/.test(name))
    throw new FirmwareError('bad-name', 'IIIx look names use 1..24 printable ASCII characters');
}
export function gr3xLookResources(decoded: Uint8Array) {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const u32 = (a: number) => view.getUint32(gr3xOffset(a), true);
  const icons = sectionsOf(decoded).find(s => s.name === 'ICONBIN');
  if (!icons) throw new FirmwareError('unexpected-layout', 'IIIx icon section missing');
  const icon = (id: number) => {
    const offset = gr3xOffset(u32(0x550020fc + id * 4));
    if (view.getUint16(offset, true) !== 40 || view.getUint16(offset + 2, true) !== 40)
      throw new FirmwareError('unexpected-layout', 'IIIx look icon size');
    const pos = view.getUint32(offset + 4, true) * 4;
    if (pos + 6400 > icons.size) throw new FirmwareError('unexpected-layout', 'IIIx icon pointer');
    return decoded.slice(icons.offset + pos, icons.offset + pos + 6400);
  };
  const film = icon(23), tiles = { film: film.slice(), plain: film.slice() };
  for (const style of ['film', 'plain'] as const) {
    const c = CONTENT_AREA[style];
    for (let y = c.y0; y <= c.y1; y++)
      for (let x = c.x0; x <= c.x1; x++) tiles[style].set(TILE_BG, (y * 40 + x) * 4);
  }
  const m = gr3xOffset(u32(u32(0x55018d94 + 11 * 4) + 4));
  const matrix = Int16Array.from({ length: 9 }, (_, i) => view.getInt16(m + i * 2, true));
  return { film, tiles, matrix, icon };
}
