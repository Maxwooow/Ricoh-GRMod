/**
 * Resource files embedded in the firmware's RES section (fonts, JPEGs, sounds).
 * Only used to learn the size and sampling of the factory power-off images and to offer them back
 * for "restore factory image"; the RES section itself is never edited.
 */
import { sectionsOf } from './container';
import { FirmwareError } from './types';

export interface ResourceFile {
  /** Path as stored, e.g. `A:\Resource\Jpeg\GB_HDF.jpg`. */
  path: string;
  /** Decoded offset of the file data. */
  offset: number;
  length: number;
}

/** List the files of the RES section: records of 32-byte path, u32 length, data. */
export function listResources(decoded: Uint8Array): ResourceFile[] {
  const res = sectionsOf(decoded).find((s) => s.name === 'RES');
  if (!res) throw new FirmwareError('unexpected-layout', 'RES section not found');
  const count = res.size; // the RES header stores the number of files in its size field
  const out: ResourceFile[] = [];
  let o = res.offset;
  for (let i = 0; i < count; i++) {
    if (o + 36 > decoded.length) throw new FirmwareError('unexpected-layout', 'RES record runs past the payload');
    let path = '';
    for (let k = 0; k < 32 && decoded[o + k] !== 0; k++) path += String.fromCharCode(decoded[o + k]);
    const length = (decoded[o + 32] | (decoded[o + 33] << 8) | (decoded[o + 34] << 16) | (decoded[o + 35] << 24)) >>> 0;
    if (!path || o + 36 + length > decoded.length) throw new FirmwareError('unexpected-layout', 'bad RES record');
    out.push({ path, offset: o + 36, length });
    o += 36 + length;
  }
  return out;
}

export function findResource(decoded: Uint8Array, path: string): ResourceFile | undefined {
  const want = path.toLowerCase();
  return listResources(decoded).find((r) => r.path.toLowerCase() === want);
}
