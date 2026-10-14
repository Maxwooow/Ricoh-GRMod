// SPDX-License-Identifier: GPL-2.0-only
// W2: the normal IIIx updater skips B: resources. Install one A: file and
// redirect the generic JPEG descriptor; no shutdown/capture code is hooked.
import { Firmware, FRAME_SIZE, buildGrown, equalRange, sectionsOf, sha256Hex, sum32, verifyContainer } from '../container';
import { listResources } from '../resources';
import { FirmwareError } from '../types';
import type { Range } from '../types';
import { checkShutdownJpeg, decodeBaselineJpeg, encodeExactJpeg, JpegError } from '../../jpeg';
import { GR3X_160 } from './profile';

export const GR3X_SHUTDOWN_BYTES = 2 * FRAME_SIZE - 36;
export const GR3X_SHUTDOWN_RESERVE = 192;
const PATH = 'A:\\GR20J2.JPG';
const MAGIC = new TextEncoder().encode('GR3X-SHUTDOWN-W2\0');
const pathBytes = new TextEncoder().encode(PATH + '\0');
const POINTER = 0xb5f544, ORIGINAL = 0x53b22abc;

function need(ok: boolean, message: string): asserts ok {
  if (!ok) throw new FirmwareError('unexpected-layout', 'IIIx shutdown: ' + message);
}
function validateImage(jpeg: Uint8Array): void {
  const check = checkShutdownJpeg(jpeg, {byteLength: GR3X_SHUTDOWN_BYTES, sampling: '420'});
  if (!check.ok) throw new JpegError('bad-input', check.problems.join('; '));
}

/** Same 48 KiB resource budget and encoder as the hardware-tested W2 image.
 * Never silently blur or add noise to meet a size: unsuitable images fail. */
export function encodeGr3xFirmwareShutdown(rgb: Uint8Array, onProgress?: (f: number) => void) {
  const encoded = encodeExactJpeg(rgb, {width:720, height:480, sampling:'420', byteLength:GR3X_SHUTDOWN_BYTES, onProgress});
  validateImage(encoded.data);
  return {data:encoded.data, quality:encoded.quality, grain:0, soften:0, preview:decodeBaselineJpeg(encoded.data).rgb};
}

/** Only extracts an input for inspection. Trust still requires a full rebuild/hash match. */
export function readGr3xShutdown(decoded: Uint8Array): Uint8Array | undefined {
  const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS');
  if (!rtos || rtos.size <= GR3X_160.rtosLength) return;
  const at = rtos.offset + rtos.size - GR3X_SHUTDOWN_RESERVE;
  if (!equalRange(decoded, at, MAGIC, 0, MAGIC.length)) return;
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  need(view.getUint32(rtos.offset + POINTER, true) === GR3X_160.rtosBase + rtos.size - GR3X_SHUTDOWN_RESERVE + 32, 'path pointer');
  need(equalRange(decoded, at + 32, pathBytes, 0, pathBytes.length), 'path record');
  const resources = listResources(decoded);
  need(resources[0]?.path === PATH && resources.filter(r => r.path.toLowerCase() === PATH.toLowerCase()).length === 1, 'resource identity');
  const image = decoded.slice(resources[0].offset, resources[0].offset + resources[0].length);
  validateImage(image);
  return image;
}

/** Called only after the parent was built and self-checked from the pinned official file.
 * The second, independent comparison removes our insertion and restores the four
 * declared edits, then requires complete byte identity with that verified parent. */
export async function addGr3xShutdown(parent: Uint8Array, jpeg: Uint8Array) {
  validateImage(jpeg);
  const fw = new Firmware(parent), sections = sectionsOf(fw.decoded);
  const rtos = sections.find(s => s.name === 'RTOS'), res = sections.find(s => s.name === 'RES');
  need(!!rtos && !!res && rtos.offset === GR3X_160.rtosOffset && res.size === 35, 'parent sections');
  const originals = listResources(fw.decoded);
  need(!originals.some(r => r.path.toLowerCase() === PATH.toLowerCase()), 'duplicate image');
  const at = rtos.offset + rtos.size - GR3X_SHUTDOWN_RESERVE;
  need(at >= rtos.offset + GR3X_160.rtosLength && fw.decoded.subarray(at, at + 128).every(b => b === 0), 'reserved padding is occupied');
  const record = new Uint8Array(36 + jpeg.length);
  record.set(pathBytes); new DataView(record.buffer).setUint32(32, jpeg.length, true); record.set(jpeg, 36);
  const decoded = new Uint8Array(fw.decoded.length + record.length);
  decoded.set(fw.decoded.subarray(0, res.offset)); decoded.set(record, res.offset);
  decoded.set(fw.decoded.subarray(res.offset), res.offset + record.length);
  const view = new DataView(decoded.buffer), pointer = rtos.offset + POINTER, checksum = rtos.offset + rtos.size - 4;
  need(view.getUint32(pointer, true) === ORIGINAL && view.getUint32(pointer - 4, true) === ((480 << 16) | 720), 'factory descriptor');
  decoded.set(MAGIC, at); decoded.set(pathBytes, at + 32);
  view.setUint32(pointer, GR3X_160.rtosBase + at - rtos.offset + 32, true);
  view.setUint32(res.offset - 4, res.size + 1, true);
  view.setUint32(checksum, 0, true); view.setUint32(checksum, (-sum32(decoded)) >>> 0, true);
  const ranges: Range[] = [
    {what:'Shutdown JPEG descriptor path', offset:pointer, length:4},
    {what:'W2 shutdown path record', offset:at, length:128},
    {what:'Payload checksum compensation', offset:checksum, length:4},
    {what:'RES file count', offset:res.offset - 4, length:4},
  ];
  const restored = new Uint8Array(fw.decoded.length);
  restored.set(decoded.subarray(0, res.offset)); restored.set(decoded.subarray(res.offset + record.length), res.offset);
  for (const r of ranges) restored.set(fw.decoded.subarray(r.offset, r.offset + r.length), r.offset);
  need(equalRange(restored, 0, fw.decoded, 0, restored.length), 'undeclared parent edit');
  const resources = listResources(decoded);
  need(resources.length === originals.length + 1 && originals.every((r,i) => {
    const n = resources[i + 1];
    return n.path === r.path && n.length === r.length && n.offset === r.offset + record.length &&
      equalRange(decoded, n.offset - 36, fw.decoded, r.offset - 36, r.length + 36);
  }), 'original resource preservation');
  const built = buildGrown(fw, decoded, [{at:res.offset, length:record.length}]);
  const verified = verifyContainer(built.out, decoded);
  need(Object.values(verified.checks).every(Boolean), 'container verification');
  const re = new Firmware(built.out);
  need(equalRange(re.header,0,fw.header,0,fw.header.length) && equalRange(re.models,0,fw.models,0,fw.models.length) && re.models.length === fw.models.length, 'header/model preservation');
  for (const i of [0, fw.frames.length - 1]) {
    const before = fw.frames[i], after = re.frames[i ? re.frames.length - 1 : 0];
    need(before.end - before.start === after.end - after.start && equalRange(parent,before.start,built.out,after.start,before.end-before.start), 'boundary frame preservation');
  }
  return {file:built.out, sha256:await sha256Hex(built.out), decodedSha256:await sha256Hex(decoded),
    changedBytes:record.length + [pointer, res.offset - 4].reduce((sum,offset) => sum +
      fw.decoded.subarray(offset,offset+4).reduce((n,b,i) => n + Number(b !== decoded[offset+i]),0),0),
    changedFrames:built.reencoded, growth:record.length, ranges:[...ranges,{what:'Embedded shutdown resource',offset:res.offset,length:record.length}],
    checks:{...verified.checks, shutdown_parent_preserved:true, shutdown_resources_preserved:true, shutdown_boundary_frames_preserved:true},
    image:{bytes:jpeg.length,sha256:await sha256Hex(jpeg)}};
}
