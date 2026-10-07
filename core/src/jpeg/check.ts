// Verifies that a file obeys every structural rule the camera needs for its
// power-off screen JPEG.

import { JpegError } from './errors';
import { decodeJpegDetailed } from './decoder';
import { HEADER_BYTES, buildHeader } from './encoder';
import type { Sampling } from './encoder';
import { MARKER, inspectJpeg, markerName } from './inspect';
import type { JpegInfo } from './inspect';

export interface ShutdownJpegExpectation {
  /** Exact length of the file being replaced. */
  byteLength: number;
  sampling: Sampling;
  /** Frame size, default 720 x 480. */
  width?: number;
  height?: number;
}

const EXPECTED_ORDER: readonly number[] = [
  MARKER.SOI,
  MARKER.APP0,
  MARKER.DQT,
  MARKER.DQT,
  MARKER.SOF0,
  MARKER.DHT,
  MARKER.DHT,
  MARKER.DHT,
  MARKER.DHT,
  MARKER.SOS,
  MARKER.EOI,
];
const SEGMENT_LABELS: readonly string[] = [
  'SOI',
  'APP0 (JFIF)',
  'DQT table 0',
  'DQT table 1',
  'SOF0',
  'DHT DC luma (0x00)',
  'DHT AC luma (0x10)',
  'DHT DC chroma (0x01)',
  'DHT AC chroma (0x11)',
  'SOS',
];

/**
 * Check a candidate power-off image: exact length, 720x480 baseline, three
 * components with the expected sampling, a single scan, the fixed segment
 * sequence SOI / APP0 / DQT / DQT / SOF0 / 4 x DHT (Annex K) / SOS / data / EOI
 * with byte-exact segment contents, no COM / extra APPn / DRI / RST, entropy
 * data that decodes completely and ends exactly at EOI, nothing after EOI.
 * `problems` is empty when `ok` is true.
 */
export function checkShutdownJpeg(data: Uint8Array, expected: ShutdownJpegExpectation): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const width = expected.width ?? 720;
  const height = expected.height ?? 480;
  const ySampling = expected.sampling === '420' ? 0x22 : 0x21;

  if (data.length !== expected.byteLength) {
    problems.push(`file is ${data.length} bytes, must be exactly ${expected.byteLength}`);
  }

  let info: JpegInfo;
  try {
    info = inspectJpeg(data);
  } catch (e) {
    problems.push(`not a parseable JPEG (${e instanceof Error ? e.message : String(e)})`);
    return { ok: false, problems };
  }

  if (info.trailingBytes > 0) problems.push(`${info.trailingBytes} byte(s) after the EOI marker`);
  if (info.frameMarker === 0) problems.push('no frame header (SOF0)');
  else if (!info.baseline) problems.push(`not baseline: frame header is ${markerName(info.frameMarker)}, must be SOF0`);
  if (info.scans !== 1) problems.push(`${info.scans} scans, must be exactly 1`);
  if (info.restartMarkers > 0) problems.push(`${info.restartMarkers} restart marker(s) in the scan data`);
  for (const seg of info.segments) {
    const code = seg.marker & 0xff;
    if (seg.marker === MARKER.COM) problems.push(`COM segment at offset ${seg.offset}`);
    else if (code >= 0xe1 && code <= 0xef) problems.push(`${markerName(seg.marker)} segment at offset ${seg.offset}`);
    else if (seg.marker === MARKER.DRI) problems.push(`DRI segment at offset ${seg.offset}`);
  }
  if (info.frameMarker !== 0) {
    if (info.width !== width || info.height !== height) problems.push(`image is ${info.width}x${info.height}, must be ${width}x${height}`);
    if (info.precision !== 8) problems.push(`sample precision is ${info.precision} bits, must be 8`);
    if (info.components.length !== 3) {
      problems.push(`${info.components.length} component(s), must be 3`);
    } else {
      const want = [
        { id: 1, s: ySampling, tq: 0 },
        { id: 2, s: 0x11, tq: 1 },
        { id: 3, s: 0x11, tq: 1 },
      ];
      info.components.forEach((c, i) => {
        const s = (c.h << 4) | c.v;
        if (c.id !== want[i].id || s !== want[i].s || c.tq !== want[i].tq) {
          const hex = (n: number): string => n.toString(16).padStart(2, '0');
          problems.push(
            `component ${i + 1} is id ${c.id} sampling 0x${hex(s)} table ${c.tq}, must be id ${want[i].id} sampling 0x${hex(want[i].s)} table ${want[i].tq}` +
              (i === 0 && s !== want[0].s ? ` (wrong chroma subsampling, expected 4:${expected.sampling[1]}:${expected.sampling[2]})` : ''),
          );
        }
      });
    }
  }

  const order = info.segments.map((s) => s.marker);
  const orderOk = order.length === EXPECTED_ORDER.length && order.every((m, i) => m === EXPECTED_ORDER[i]);
  if (!orderOk) {
    problems.push(`segment sequence is ${order.map(markerName).join(' ')}, must be ${EXPECTED_ORDER.map(markerName).join(' ')}`);
  } else {
    // Byte-exact comparison of everything before the scan data, except the 2 x 64 table values.
    const reference = buildHeader(width, height, expected.sampling, new Uint8Array(64), new Uint8Array(64));
    const refOffsets: number[] = [0];
    for (let p = 2; p < HEADER_BYTES; p += 2 + ((reference[p + 2] << 8) | reference[p + 3])) refOffsets.push(p);
    refOffsets.push(HEADER_BYTES);
    let expectedOffset = 0;
    for (let i = 0; i < SEGMENT_LABELS.length; i++) {
      const seg = info.segments[i];
      const size = i === 0 ? 2 : 2 + seg.length;
      const refStart = refOffsets[i];
      const isDqt = i === 2 || i === 3;
      if (seg.offset !== expectedOffset) {
        problems.push(`${seg.offset - expectedOffset} stray byte(s) before the ${SEGMENT_LABELS[i]} segment`);
      }
      expectedOffset = seg.offset + size;
      let same = size === refOffsets[i + 1] - refStart;
      for (let j = 0; same && j < size; j++) {
        if (isDqt && j >= 5) {
          if (data[seg.offset + j] === 0) {
            problems.push(`${SEGMENT_LABELS[i]} contains a zero entry`);
            break;
          }
        } else if (data[seg.offset + j] !== reference[refStart + j]) {
          same = false;
        }
      }
      if (!same) problems.push(`${SEGMENT_LABELS[i]} segment differs from the required content`);
    }
  }

  // The scan must decode to exactly the whole image and stop right at EOI.
  // (Only attempted for a frame of the expected size, which also bounds the work.)
  if (info.baseline && info.scans === 1 && info.restartMarkers === 0 && info.width === width && info.height === height && info.components.length === 3) {
    try {
      const scan = decodeJpegDetailed(data, true).scans[0];
      if (scan.end !== scan.nextMarker) {
        problems.push(`${scan.nextMarker - scan.end} surplus byte(s) at the end of the entropy-coded data`);
      } else if (!scan.paddingOk) {
        problems.push('the last entropy-coded byte is not padded with 1-bits');
      }
    } catch (e) {
      if (e instanceof JpegError) problems.push(`entropy-coded data cannot be decoded (${e.message})`);
      else throw e;
    }
  }

  return { ok: problems.length === 0, problems };
}
