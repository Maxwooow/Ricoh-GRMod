// SPDX-License-Identifier: GPL-2.0-only
import { sectionsOf } from '../container';
import { FirmwareError } from '../types';
import { CONTENT_AREA, TILE_BG } from '../icons';
import { gr3xOffset } from './profile';

export const GR3X_FILM_NAMES = ['Film 1', 'Film 2', 'Film 3', 'Film 4', 'Film 5', 'Film 6', 'Film 7', 'Film 8', 'Film 9'] as const;
// CY/CG retain their old application identities for archived projects.
export const GR3X_FILM_IDS = ['CY', 'CG', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'] as const;
export const GR3X_LOOK_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('');
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
