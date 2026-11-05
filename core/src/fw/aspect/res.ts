// SPDX-License-Identifier: GPL-2.0-only
/**
 * The RES section of a decoded payload: the last section; its header's size field is the number of
 * files, and the files follow one after another: `char path[32] (NUL-terminated ASCII), u32 size,
 * size bytes`. The firmware update writes them to the camera's A: drive.
 */
import { sectionsOf } from '../container';
import { FirmwareError } from '../types';

export interface ResFile {
  path: string;
  /** Payload offset of the file's 36-byte header. */
  offset: number;
  /** Payload offset of its data. */
  data: number;
  size: number;
}

export interface ResDirectory {
  /** Payload offset of the file count (the section header's size field). */
  countOffset: number;
  files: ResFile[];
  /** Payload offset just after the last file. */
  end: number;
}

export const RES_HEADER = 36;

export function readRes(payload: Uint8Array): ResDirectory {
  const res = sectionsOf(payload).find((s) => s.name === 'RES');
  if (!res) throw new FirmwareError('unexpected-layout', 'no RES section');
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const files: ResFile[] = [];
  let at = res.offset;
  for (let i = 0; i < res.size; i++) {
    if (at + RES_HEADER > payload.length) throw new FirmwareError('unexpected-layout', 'RES file list is cut short');
    let path = '';
    let k = 0;
    for (; k < 32 && payload[at + k] !== 0; k++) {
      const c = payload[at + k];
      if (!(c >= 0x20 && c < 0x7f)) throw new FirmwareError('unexpected-layout', 'RES file name is not ASCII');
      path += String.fromCharCode(c);
    }
    if (k === 32 || path === '') throw new FirmwareError('unexpected-layout', 'RES file name');
    const size = dv.getUint32(at + 32, true);
    if (at + RES_HEADER + size > payload.length) throw new FirmwareError('unexpected-layout', 'RES file runs past the payload');
    files.push({ path, offset: at, data: at + RES_HEADER, size });
    at += RES_HEADER + size;
  }
  return { countOffset: res.offset - 4, files, end: at };
}

/** One file's bytes (a copy), or null. */
export function resFile(payload: Uint8Array, path: string, dir: ResDirectory = readRes(payload)): Uint8Array | null {
  const f = dir.files.find((x) => x.path === path);
  return f ? payload.slice(f.data, f.data + f.size) : null;
}

/** RES records (header and data) of `files`, back to back. */
export function resRecords(files: readonly { path: string; data: Uint8Array }[]): Uint8Array {
  const total = files.reduce((n, f) => n + RES_HEADER + f.data.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let at = 0;
  for (const f of files) {
    if (!(f.path.length >= 1 && f.path.length < 32) || /[^\x20-\x7e]/.test(f.path)) throw new FirmwareError('internal', 'bad RES file name');
    for (let i = 0; i < f.path.length; i++) out[at + i] = f.path.charCodeAt(i);
    dv.setUint32(at + 32, f.data.length, true);
    out.set(f.data, at + RES_HEADER);
    at += RES_HEADER + f.data.length;
  }
  return out;
}

/**
 * Where (official payload offset) and how many bytes of RES files were inserted: the new list is
 * the official one with one run of files with new names inserted, of whole frames. Null otherwise.
 */
export function findResInsertion(official: Uint8Array, grown: Uint8Array, frame: number): { at: number; length: number } | null {
  try {
    const a = readRes(official).files;
    const b = readRes(grown).files;
    const m = b.length - a.length;
    if (m <= 0) return null;
    let i = 0;
    while (i < a.length && a[i].path === b[i].path && a[i].size === b[i].size) i++;
    for (let j = i; j < a.length; j++) if (a[j].path !== b[j + m].path || a[j].size !== b[j + m].size) return null;
    const names = new Set(a.map((f) => f.path));
    let length = 0;
    for (let j = i; j < i + m; j++) {
      if (names.has(b[j].path)) return null;
      length += RES_HEADER + b[j].size;
    }
    if (length % frame !== 0) return null;
    return { at: i < a.length ? a[i].offset : readRes(official).end, length };
  } catch {
    return null;
  }
}
