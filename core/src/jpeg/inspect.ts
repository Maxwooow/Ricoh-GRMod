// Marker-level JPEG parser: lists the segments without decoding image data.

import { JpegError } from './errors';

export interface JpegComponent {
  id: number;
  /** Horizontal / vertical sampling factors. */
  h: number;
  v: number;
  /** Quantisation table selector. */
  tq: number;
}

export interface JpegSegment {
  /** Full marker code, e.g. 0xFFD8 (SOI), 0xFFE0 (APP0), 0xFFDB (DQT), 0xFFDA (SOS), 0xFFD9 (EOI). */
  marker: number;
  /** File offset of the marker's 0xFF byte. */
  offset: number;
  /**
   * Value of the segment's length field (it counts itself but not the marker);
   * 0 for the stand-alone markers SOI and EOI. The segment body is
   * `data.subarray(offset + 4, offset + 2 + length)`.
   */
  length: number;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: JpegComponent[];
  /** All marker segments in file order (restart markers inside scan data are counted, not listed). */
  segments: JpegSegment[];
  /** True when the frame header is SOF0 (baseline sequential DCT, Huffman). */
  baseline: boolean;
  /** Number of SOS segments. */
  scans: number;
  /** Bytes after the EOI marker. */
  trailingBytes: number;
  /** Marker code of the frame header (0xFFC0 = baseline, 0xFFC2 = progressive, ...), 0 if there is none. */
  frameMarker: number;
  /** Sample precision in bits from the frame header. */
  precision: number;
  /** Number of RSTn markers found inside entropy-coded data. */
  restartMarkers: number;
}

export const MARKER = {
  SOI: 0xffd8,
  EOI: 0xffd9,
  SOS: 0xffda,
  DQT: 0xffdb,
  DRI: 0xffdd,
  DHT: 0xffc4,
  SOF0: 0xffc0,
  SOF2: 0xffc2,
  APP0: 0xffe0,
  APP14: 0xffee,
  COM: 0xfffe,
} as const;

function isFrameHeader(marker: number): boolean {
  return marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc;
}

/** Human-readable marker name for messages. */
export function markerName(marker: number): string {
  const m = marker & 0xff;
  if (marker === MARKER.SOI) return 'SOI';
  if (marker === MARKER.EOI) return 'EOI';
  if (marker === MARKER.SOS) return 'SOS';
  if (marker === MARKER.DQT) return 'DQT';
  if (marker === MARKER.DHT) return 'DHT';
  if (marker === MARKER.DRI) return 'DRI';
  if (marker === MARKER.COM) return 'COM';
  if (m >= 0xe0 && m <= 0xef) return `APP${m - 0xe0}`;
  if (isFrameHeader(marker)) return `SOF${m - 0xc0}`;
  return `0x${marker.toString(16).toUpperCase()}`;
}

/**
 * Parse the marker structure of a JPEG file. Throws `JpegError('not-jpeg')` if
 * the data does not start with SOI, a segment is truncated, or EOI is missing.
 */
export function inspectJpeg(data: Uint8Array): JpegInfo {
  const n = data.length;
  if (n < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new JpegError('not-jpeg', 'missing SOI marker');
  const info: JpegInfo = {
    width: 0,
    height: 0,
    components: [],
    segments: [{ marker: MARKER.SOI, offset: 0, length: 0 }],
    baseline: false,
    scans: 0,
    trailingBytes: 0,
    frameMarker: 0,
    precision: 0,
    restartMarkers: 0,
  };
  let pos = 2;
  for (;;) {
    if (pos + 1 >= n) throw new JpegError('not-jpeg', 'file ends without an EOI marker');
    if (data[pos] !== 0xff) throw new JpegError('not-jpeg', `expected a marker at offset ${pos}`);
    // optional 0xFF fill bytes before a marker
    while (pos + 1 < n && data[pos + 1] === 0xff) pos++;
    if (pos + 1 >= n) throw new JpegError('not-jpeg', 'file ends without an EOI marker');
    const code = data[pos + 1];
    const marker = 0xff00 | code;
    if (code === 0x00) throw new JpegError('not-jpeg', `invalid marker at offset ${pos}`);
    if (marker === MARKER.EOI) {
      info.segments.push({ marker, offset: pos, length: 0 });
      info.trailingBytes = n - (pos + 2);
      return info;
    }
    if (marker === MARKER.SOI || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      // stand-alone markers have no length field
      info.segments.push({ marker, offset: pos, length: 0 });
      pos += 2;
      continue;
    }
    if (pos + 3 >= n) throw new JpegError('not-jpeg', `truncated ${markerName(marker)} segment`);
    const length = (data[pos + 2] << 8) | data[pos + 3];
    if (length < 2 || pos + 2 + length > n) throw new JpegError('not-jpeg', `truncated ${markerName(marker)} segment`);
    info.segments.push({ marker, offset: pos, length });
    const body = pos + 4;
    if (isFrameHeader(marker) && info.frameMarker === 0) {
      if (length < 8) throw new JpegError('not-jpeg', 'frame header too short');
      const count = data[body + 5];
      if (length < 8 + 3 * count) throw new JpegError('not-jpeg', 'frame header too short');
      info.frameMarker = marker;
      info.baseline = marker === MARKER.SOF0;
      info.precision = data[body];
      info.height = (data[body + 1] << 8) | data[body + 2];
      info.width = (data[body + 3] << 8) | data[body + 4];
      for (let i = 0; i < count; i++) {
        const p = body + 6 + 3 * i;
        info.components.push({ id: data[p], h: data[p + 1] >> 4, v: data[p + 1] & 15, tq: data[p + 2] });
      }
    }
    pos += 2 + length;
    if (marker === MARKER.SOS) {
      info.scans++;
      // skip entropy-coded data: up to the next marker that is not a stuffed 0xFF00 or RSTn
      for (;;) {
        while (pos < n && data[pos] !== 0xff) pos++;
        if (pos + 1 >= n) throw new JpegError('not-jpeg', 'file ends without an EOI marker');
        const next = data[pos + 1];
        if (next === 0x00) pos += 2;
        else if (next >= 0xd0 && next <= 0xd7) {
          info.restartMarkers++;
          pos += 2;
        } else if (next === 0xff) pos++;
        else break;
      }
    }
  }
}
