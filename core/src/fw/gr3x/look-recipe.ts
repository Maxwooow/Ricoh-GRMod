// SPDX-License-Identifier: GPL-2.0-only
// Self-describing build input, never executable. Inspection rebuilds from the
// exact official image and requires byte identity before trusting a T5 file.
import { FirmwareError } from '../types';
import type { Gr3xLookOptions } from './image-control';
import { validateFilmPhotoIdentity } from './jpeg-metadata';
export const GR3X_RECIPE_MAGIC = new TextEncoder().encode('GR3X-T5-RECIPE\0');
export function encodeGr3xLookRecipe(options: Gr3xLookOptions): Uint8Array {
  const recipe = {
    schema: options.displayRevision ?? 2, monoReplicas: options.monoReplicas === true,
    ...(options.jpegMetadata ? {jpegMetadata:true} : {}),
    films: (options.films ?? []).map(f => ({
      name: f.name,
      ...(f.photo ? {photo:f.photo} : {}),
      ...(f.icon ? { icon: Array.from(f.icon) } : {}),
      ...(f.params ? { params: { M1: f.params.M1, ck: f.params.ck.map(c => Array.from(c)) } } : {}),
      ...(f.preset ? { preset: { matrixQ13: Array.from(f.preset.matrixQ13), curves: f.preset.curves.map(c => Array.from(c)) } } : {}),
    })),
  };
  const data = new TextEncoder().encode(JSON.stringify(recipe));
  if (data.length > (recipe.schema === 3 ? 512000 : 256000)) throw new FirmwareError('bad-edit', 'IIIx build recipe is too large');
  const out = new Uint8Array(GR3X_RECIPE_MAGIC.length + 4 + data.length);
  out.set(GR3X_RECIPE_MAGIC);
  new DataView(out.buffer).setUint32(GR3X_RECIPE_MAGIC.length, data.length, true);
  out.set(data, GR3X_RECIPE_MAGIC.length + 4);
  return out;
}
export function readGr3xLookRecipe(appendedRtos: Uint8Array): Gr3xLookOptions | null {
  const magic = GR3X_RECIPE_MAGIC;
  for (let at = 0; at + magic.length + 4 <= appendedRtos.length; at++) {
    if (!magic.every((v, i) => appendedRtos[at + i] === v)) continue;
    const start = at + magic.length + 4;
    const size = new DataView(appendedRtos.buffer, appendedRtos.byteOffset).getUint32(at + magic.length, true);
    if (size > 512000 || start + size > appendedRtos.length) throw new FirmwareError('bad-edit', 'invalid IIIx recipe extent');
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(appendedRtos.subarray(start, start + size)));
    if (![1, 2, 3].includes(r.schema) || typeof r.monoReplicas !== 'boolean' || !Array.isArray(r.films) ||
        r.films.length > (r.schema === 3 ? 9 : 2) || (r.schema === 3 && r.monoReplicas) || (r.schema !== 3 && size > 256000))
      throw new FirmwareError('bad-edit', 'invalid IIIx recipe');
    if (r.jpegMetadata !== undefined && (r.jpegMetadata !== true || r.schema !== 3))
      throw new FirmwareError('bad-edit','invalid JPEG metadata recipe');
    return { displayRevision: r.schema, monoReplicas: r.monoReplicas,
      ...(r.jpegMetadata ? {jpegMetadata:true} : {}), films: r.films.map((f: Record<string, any>) => {
      if (typeof f.name !== 'string' || (f.icon && (!Array.isArray(f.icon) || f.icon.length !== 6400 ||
          f.icon.some((v: number) => !Number.isInteger(v) || v < 0 || v > 255))))
        throw new FirmwareError('bad-edit', 'invalid IIIx recipe slot');
      if (f.photo) validateFilmPhotoIdentity(f.photo);
      return { name: f.name, ...(f.photo ? {photo:f.photo} : {}), ...(f.icon ? { icon: Uint8Array.from(f.icon) } : {}),
        ...(f.params ? { params: f.params } : {}), ...(f.preset ? { preset: f.preset } : {}) };
    }) };
  }
  return null;
}
