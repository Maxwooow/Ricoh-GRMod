// SPDX-License-Identifier: GPL-2.0-only
/**
 * The 1.12 bridge firmware: official 1.11 with its version raised to 1.12.10.7 and the updater's
 * "older version" rejection opened (20 bytes of the decoded payload, 7 re-encoded frames). Some new
 * cameras carry a hidden sub-version above the one Ricoh publishes and refuse the official file;
 * they take this file first, after which the official update (and this program's builds) install
 * normally.
 *
 * The program carries no Ricoh firmware: only a byte patch between the official file and the
 * bridge file, in both directions. The bridge is made from the official file the user opened or
 * downloaded, and a bridge file the user opens is turned back into the official one, each checked
 * against its SHA-256.
 *
 * Patch format (`tools/bridge/mkpatch.py`), zlib-deflated: "GRMP1", u32 output length, then ops
 * 0x01 u32 offset u32 length (copy from the input), 0x02 u32 length bytes (literal), 0x00 (end).
 */
import { unzlibSync } from 'fflate';
import { sha256Hex } from './container';
import { OFFICIAL_SHA256, OFFICIAL_SIZE } from './profile';
import { FirmwareError } from './types';
import { BRIDGE_FORWARD, BRIDGE_REVERSE } from './bridge-data';

export const BRIDGE_VERSION = '1.12';
export const BRIDGE_FULL_VERSION = '1.12.10.7';
export const BRIDGE_SHA256 = 'ecdfc3034441d9f1cc4684955de546a6d3d4bb495470a48fb8e1d84971659adb';
export const BRIDGE_SIZE = 38752180;

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Apply a GRMP1 patch to `input`. */
export function applyPatch(input: Uint8Array, patch: Uint8Array): Uint8Array {
  const d = unzlibSync(patch);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const magic = String.fromCharCode(...d.subarray(0, 5));
  if (magic !== 'GRMP1') throw new FirmwareError('bad-patch', 'not a GRMP1 patch');
  const n = dv.getUint32(5, true);
  const out = new Uint8Array(n);
  let o = 0;
  let j = 9;
  for (;;) {
    const op = d[j];
    if (op === 0) break;
    if (op === 1) {
      const off = dv.getUint32(j + 1, true);
      const len = dv.getUint32(j + 5, true);
      if (off + len > input.length || o + len > n) throw new FirmwareError('bad-patch', 'copy out of range');
      out.set(input.subarray(off, off + len), o);
      o += len;
      j += 9;
    } else if (op === 2) {
      const len = dv.getUint32(j + 1, true);
      if (j + 5 + len > d.length || o + len > n) throw new FirmwareError('bad-patch', 'literal out of range');
      out.set(d.subarray(j + 5, j + 5 + len), o);
      o += len;
      j += 5 + len;
    } else throw new FirmwareError('bad-patch', `unknown op ${op}`);
  }
  if (o !== n) throw new FirmwareError('bad-patch', 'output length');
  return out;
}

/** True when `raw` is the 1.12 bridge firmware. */
export async function isBridgeFirmware(raw: Uint8Array): Promise<boolean> {
  return raw.length === BRIDGE_SIZE && (await sha256Hex(raw)) === BRIDGE_SHA256;
}

/** The bridge firmware, made from the official 1.11 file. */
export async function makeBridgeFirmware(official: Uint8Array): Promise<Uint8Array> {
  if (official.length !== OFFICIAL_SIZE || (await sha256Hex(official)) !== OFFICIAL_SHA256) {
    throw new FirmwareError('unsupported-firmware', 'the bridge firmware is made from the official 1.11 file');
  }
  const out = applyPatch(official, fromBase64(BRIDGE_FORWARD));
  if ((await sha256Hex(out)) !== BRIDGE_SHA256) throw new FirmwareError('assert-failed', 'bridge firmware checksum');
  return out;
}

/** The official 1.11 file, recovered from the bridge firmware. */
export async function officialFromBridge(bridge: Uint8Array): Promise<Uint8Array> {
  if (!(await isBridgeFirmware(bridge))) throw new FirmwareError('unsupported-firmware', 'not the bridge firmware');
  const out = applyPatch(bridge, fromBase64(BRIDGE_REVERSE));
  if ((await sha256Hex(out)) !== OFFICIAL_SHA256) throw new FirmwareError('assert-failed', 'official firmware checksum');
  return out;
}
