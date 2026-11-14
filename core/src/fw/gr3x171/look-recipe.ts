// SPDX-License-Identifier: GPL-2.0-only
// Self-describing build input, never executable. Inspection rebuilds from the
// exact official image and requires byte identity before trusting a T5 file.
import { FirmwareError } from '../types';
import type { Gr3xLookOptions } from './image-control';
export const GR3X_RECIPE_MAGIC = new TextEncoder().encode('GR3X-T5-RECIPE\0');
/** Round 6: twenty films with their icons and curves take about 0.55 MB of JSON. */
const RECIPE_MAX = 1500000;
export function encodeGr3xLookRecipe(options: Gr3xLookOptions): Uint8Array {
  const recipe = {
    schema: options.displayRevision ?? 2, monoReplicas: options.monoReplicas === true,
    // Written only when set, so T6c recipes (shared parameters) stay byte-identical.
    ...(options.ownParameters === true ? { ownParameters: true } : {}),
    ...(options.jpegDiagnostics === true ? { jpegDiagnostics: true } : {}),
    // Round 6: the number of films (1..20) and the in-camera Halation; absent in T6 (nine).
    ...(options.filmCount !== undefined ? { filmCount: options.filmCount } : {}),
    films: (options.films ?? []).map(f => ({
      name: f.name,
      ...(f.names && Object.keys(f.names).length ? { names: f.names } : {}),
      ...(f.icon ? { icon: Array.from(f.icon) } : {}),
      ...(f.params ? { params: { M1: f.params.M1, ck: f.params.ck.map(c => Array.from(c)) } } : {}),
      ...(f.preset ? { preset: { matrixQ13: Array.from(f.preset.matrixQ13), curves: f.preset.curves.map(c => Array.from(c)),
        ...(f.preset.postQ9 ? { postQ9: Array.from(f.preset.postQ9) } : {}) } } : {}),
      ...(f.halation ? { halation: f.halation } : {}),
    })),
  };
  const data = new TextEncoder().encode(JSON.stringify(recipe));
  if (data.length > (recipe.filmCount !== undefined ? RECIPE_MAX : recipe.schema === 3 ? 512000 : 256000)) throw new FirmwareError('bad-edit', 'IIIx build recipe is too large');
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
    if (size > RECIPE_MAX || start + size > appendedRtos.length) throw new FirmwareError('bad-edit', 'invalid IIIx recipe extent');
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(appendedRtos.subarray(start, start + size)));
    if (![1, 2, 3].includes(r.schema) || typeof r.monoReplicas !== 'boolean' || !Array.isArray(r.films) ||
        (r.filmCount !== undefined && (r.schema !== 3 || r.ownParameters !== true || !Number.isInteger(r.filmCount) || r.filmCount < 1 || r.filmCount > 20)) ||
        (r.filmCount === undefined && size > 512000) ||
        r.films.length > (r.filmCount ?? (r.schema === 3 ? 9 : 2)) || (r.schema === 3 && r.monoReplicas) || (r.schema !== 3 && size > 256000) ||
        (r.ownParameters !== undefined && (r.ownParameters !== true || r.schema !== 3)) ||
        (r.jpegDiagnostics !== undefined && r.jpegDiagnostics !== true))
      throw new FirmwareError('bad-edit', 'invalid IIIx recipe');
    return { displayRevision: r.schema, monoReplicas: r.monoReplicas, ...(r.ownParameters ? { ownParameters: true } : {}),
      ...(r.jpegDiagnostics ? { jpegDiagnostics: true } : {}), ...(r.filmCount !== undefined ? { filmCount: r.filmCount } : {}), films: r.films.map((f: Record<string, any>) => {
      if (typeof f.name !== 'string' || (f.icon && (!Array.isArray(f.icon) || f.icon.length !== 6400 ||
          f.icon.some((v: number) => !Number.isInteger(v) || v < 0 || v > 255))))
        throw new FirmwareError('bad-edit', 'invalid IIIx recipe slot');
      if (f.names !== undefined && (typeof f.names !== 'object' || Object.values(f.names).some(v => typeof v !== 'string')))
        throw new FirmwareError('bad-edit', 'invalid IIIx recipe names');
      if (f.halation !== undefined && (![1, 2].includes(f.halation) || r.filmCount !== undefined)) throw new FirmwareError('bad-edit', 'invalid IIIx recipe halation');
      return { name: f.name, ...(f.names ? { names: f.names } : {}), ...(f.icon ? { icon: Uint8Array.from(f.icon) } : {}),
        ...(f.params ? { params: f.params } : {}), ...(f.preset ? { preset: f.preset } : {}), ...(f.halation ? { halation: f.halation } : {}) };
    }) };
  }
  return null;
}
