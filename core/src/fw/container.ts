/**
 * GR IV firmware container (fwdc248b.bin, 1.11): unpack, patch-aware repack, verify.
 *
 * This is a line-by-line port of the Python tools `fwlib.py` / `fwpack.py`. The files those
 * tools produced were installed on a real camera, so the behaviour here must stay identical:
 * do not "improve" the algorithms.
 *
 * Container layout:
 *   0x00  header, 0x80 bytes (project number at 0x30, 0x78 = proj|proj<<16, 0x7C = A55A5AA5)
 *   0x80  LZ stream: frames [u16 BE prefix][body]; prefix 0 terminates.
 *         prefix & 0x8000 -> stored frame, else compressed. 8 KB window runs across frames.
 *         decoded frame sizes: first 0x8000, then 0x6000 each, last partial.
 *   pad to 4 bytes
 *   footer: model records of 0x80 bytes, then 0x18 bytes:
 *         proj|proj<<16, A55A5AA5, fw type, stream length, decoded length, file checksum
 *   File: sum of LE32 words == 0.  Decoded payload: LE32 sum == 0 as well.
 *
 * Browser compatible: no Node APIs.
 */
import { FirmwareError } from './types';

export { FirmwareError } from './types';

export const HDR = 0x80;
export const FOOTER_LEN = 0x18;
export const MODEL_RECORD_LEN = 0x80;
export const MAGIC = 0xa55a5aa5;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** Ignore absurd length hints (e.g. from a corrupt footer) instead of trying to allocate them. */
const MAX_LENGTH_HINT = 0x20000000;

/**
 * Unsigned 32-bit sum of little-endian words; trailing 1-3 bytes are added as one
 * little-endian integer (as `fwpack.sum32`).
 */
export function sum32(b: Uint8Array): number {
  const len = b.length;
  const n = len - (len % 4);
  let s = 0;
  if (LITTLE_ENDIAN && (b.byteOffset & 3) === 0) {
    const w = new Uint32Array(b.buffer, b.byteOffset, n >>> 2);
    for (let i = 0; i < w.length; i++) s = (s + w[i]) | 0;
  } else {
    for (let i = 0; i < n; i += 4) {
      s = (s + (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24))) | 0;
    }
  }
  if (n !== len) {
    let t = 0;
    for (let i = len - 1; i >= n; i--) t = (t << 8) | b[i];
    s = (s + t) | 0;
  }
  return s >>> 0;
}

/** Python-slice equality: `a[aOff:aOff+len] == b[bOff:bOff+len]` (slices clamp to the array). */
export function equalRange(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number, len: number): boolean {
  const la = Math.max(0, Math.min(a.length, aOff + len) - aOff);
  const lb = Math.max(0, Math.min(b.length, bOff + len) - bOff);
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    if (a[aOff + i] !== b[bOff + i]) return false;
  }
  return true;
}

export interface Frame {
  /** Offset of the 2-byte prefix in the container. */
  start: number;
  /** Offset just past the frame body in the container. */
  end: number;
  /** Stored (uncompressed) frame: prefix & 0x8000. */
  stored: boolean;
  /** Offset of this frame's output in the decoded payload. */
  outStart: number;
  /** Number of decoded bytes this frame produces. */
  outLen: number;
  /** Largest reach of a back-reference before the start of this frame's own output (0 = none). */
  crossref: number;
}

export interface ParseResult {
  frames: Frame[];
  decoded: Uint8Array;
  /** Position after the last thing read: just past the 00 00 terminator when there is one. */
  streamEnd: number;
}

function truncated(pos: number): never {
  throw new FirmwareError('bad-stream', `read past the end of the input at 0x${pos.toString(16)}`);
}

/**
 * Exact port of `fwlib.parse_frames`. `expectedLength` is only an allocation hint (the footer's
 * decoded length); the result is the same with or without it.
 */
export function parseFrames(src: Uint8Array, expectedLength?: number): ParseResult {
  const n = src.length;
  let cap =
    expectedLength !== undefined && expectedLength > 0 && expectedLength <= MAX_LENGTH_HINT
      ? expectedLength
      : Math.max(0x10000, n * 2);
  let out = new Uint8Array(cap);
  let op = 0;
  const grow = (need: number): void => {
    let c = cap;
    while (c < need) c = c * 2;
    const bigger = new Uint8Array(c);
    bigger.set(out.subarray(0, op));
    out = bigger;
    cap = c;
  };

  const frames: Frame[] = [];
  let pos = HDR;
  while (pos + 2 <= n) {
    const fs = pos;
    const os = op;
    const prefix = (src[pos] << 8) | src[pos + 1];
    pos += 2;
    if (prefix === 0) break;
    const length = prefix & 0x7fff;
    const end = pos + length;
    let maxback = 0;
    if (prefix & 0x8000) {
      // out += src[pos:end]  (a Python slice: silently shorter when the input is truncated)
      const e = Math.min(end, n);
      if (e > pos) {
        if (op + (e - pos) > cap) grow(op + (e - pos));
        out.set(src.subarray(pos, e), op);
        op += e - pos;
      }
    } else {
      while (pos < end) {
        // int.from_bytes(src[pos:pos+2], 'big'): the slice may be 1 or 0 bytes long at the very end
        let flags: number;
        if (pos + 1 < n) flags = (src[pos] << 8) | src[pos + 1];
        else if (pos < n) flags = src[pos];
        else flags = 0;
        pos += 2;
        for (let bit = 15; bit >= 0; bit--) {
          if (pos >= end) break;
          if (!(flags & (1 << bit))) {
            if (pos >= n) truncated(pos);
            if (op >= cap) grow(op + 1);
            out[op++] = src[pos++];
            continue;
          }
          if (pos + 1 >= n) truncated(pos);
          const first = src[pos];
          const second = src[pos + 1];
          pos += 2;
          const dist = ((first & 0xf8) << 5) + second;
          let cnt = first & 7;
          if (cnt === 7) {
            if (pos >= n) truncated(pos);
            let ext = src[pos++];
            cnt += ext;
            while (ext === 255) {
              if (pos >= n) truncated(pos);
              ext = src[pos++];
              cnt += ext;
            }
          }
          if (!dist) break;
          const back = dist - (op - os); // > 0 means reaching before this frame
          if (back > maxback) maxback = back;
          if (dist > op) {
            throw new FirmwareError('bad-stream', `back-reference before the start of the output at 0x${pos.toString(16)}`);
          }
          const run = cnt + 3;
          if (op + run > cap) grow(op + run);
          // Overlapping copies are the normal case (run-length style): byte by byte, forwards.
          let from = op - dist;
          for (let k = 0; k < run; k++) out[op++] = out[from++];
        }
      }
    }
    pos = end;
    frames.push({ start: fs, end, stored: (prefix & 0x8000) !== 0, outStart: os, outLen: op - os, crossref: maxback });
  }
  const decoded = op === out.length ? out : out.slice(0, op);
  return { frames, decoded, streamEnd: pos };
}

export interface Section {
  name: string;
  /** Decoded offset of the section data (just after its 16-byte header). */
  offset: number;
  /** The size field. NOTE: for the last section, `RES`, this is a file count, not a byte length. */
  size: number;
  v1: number;
  v2: number;
}

/** Port of `Firmware.sections()`, usable on any decoded payload. */
export function sectionsOf(d: Uint8Array): Section[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out: Section[] = [];
  let o = 0;
  while (o + 16 <= d.length) {
    let nameLen = 8;
    while (nameLen > 0 && d[o + nameLen - 1] === 0) nameLen--; // rstrip(b'\0')
    const v1 = dv.getUint16(o + 8, true);
    const v2 = dv.getUint16(o + 10, true);
    const size = dv.getUint32(o + 12, true);
    if (nameLen === 0) break;
    let name = '';
    let printable = true;
    for (let i = 0; i < nameLen; i++) {
      const c = d[o + i];
      if (!(c >= 32 && c < 127)) {
        printable = false;
        break;
      }
      name += String.fromCharCode(c);
    }
    if (!printable) break;
    out.push({ name, offset: o + 16, size, v1, v2 });
    if (name === 'RES') break;
    o += 16 + size;
  }
  return out;
}

/**
 * The data of one section as a view. For `RES` (whose size field is a file count) this runs
 * from its data start to the end of the payload.
 */
export function sectionData(d: Uint8Array, s: Section): Uint8Array {
  const end = s.name === 'RES' ? d.length : Math.min(d.length, s.offset + s.size);
  return d.subarray(Math.min(s.offset, d.length), Math.max(Math.min(s.offset, d.length), end));
}

/** `sum32` of every section's data, in section order. */
export function sectionSums(d: Uint8Array): { name: string; offset: number; size: number; sum: number }[] {
  return sectionsOf(d).map((s) => ({ name: s.name, offset: s.offset, size: s.size, sum: sum32(sectionData(d, s)) }));
}

function projTwice(project: number): number | null {
  // Python: project | project << 16 on unbounded ints; it only fits a u32 when project < 0x10000.
  if (project >= 0x10000) return null;
  return (project | (project << 16)) >>> 0;
}

/** Port of `fwpack.Firmware`: parses and checks a container. */
export class Firmware {
  readonly raw: Uint8Array;
  readonly header: Uint8Array;
  readonly frames: Frame[];
  readonly decoded: Uint8Array;
  readonly streamEnd: number;
  readonly fProj2: number;
  readonly fMagic: number;
  readonly fType: number;
  /** Stream length from the footer (includes the 00 00 terminator). */
  readonly fClen: number;
  /** Decoded length from the footer. */
  readonly fDlen: number;
  readonly fSum: number;
  readonly project: number;
  /** The model records between the padded stream and the 0x18-byte footer. */
  readonly models: Uint8Array;

  constructor(raw: Uint8Array) {
    if (raw.length < HDR + FOOTER_LEN) throw new FirmwareError('too-short', 'file is too short to be a firmware container');
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const t = raw.length - FOOTER_LEN;
    this.raw = raw;
    this.header = raw.subarray(0, HDR);
    const dlenHint = dv.getUint32(t + 16, true);
    const parsed = parseFrames(raw, dlenHint);
    this.frames = parsed.frames;
    this.decoded = parsed.decoded;
    this.streamEnd = parsed.streamEnd;
    this.fProj2 = dv.getUint32(t, true);
    this.fMagic = dv.getUint32(t + 4, true);
    this.fType = dv.getUint32(t + 8, true);
    this.fClen = dv.getUint32(t + 12, true);
    this.fDlen = dlenHint;
    this.fSum = dv.getUint32(t + 20, true);
    this.project = dv.getUint32(0x30, true);
    const pad = (4 - (this.streamEnd % 4)) % 4;
    const mStart = Math.min(this.streamEnd + pad, raw.length);
    this.models = raw.subarray(mStart, Math.max(mStart, t));
    if (!(this.fMagic === MAGIC && this.fProj2 === projTwice(this.project))) {
      throw new FirmwareError('bad-footer', 'footer magic / project number mismatch');
    }
    if (this.fClen !== this.streamEnd - HDR) {
      throw new FirmwareError('bad-stream-length', `footer says 0x${this.fClen.toString(16)}, stream ends at 0x${this.streamEnd.toString(16)}`);
    }
    if (this.fDlen !== this.decoded.length) {
      throw new FirmwareError('bad-decoded-length', `footer says 0x${this.fDlen.toString(16)}, decoded 0x${this.decoded.length.toString(16)}`);
    }
    if (this.models.length % MODEL_RECORD_LEN !== 0) throw new FirmwareError('bad-models', 'model record area is not a multiple of 0x80');
    if (!(sum32(raw) === 0 && sum32(this.decoded) === 0)) throw new FirmwareError('bad-checksum', 'file or payload word sum is not zero');
  }

  sections(): Section[] {
    return sectionsOf(this.decoded);
  }
}

/** Write pad, model records, footer and file checksum after `HDR + streamLen` bytes of `out`. */
function finishContainer(out: Uint8Array, fw: Firmware, streamLen: number, decodedLength: number): void {
  const proj2 = projTwice(fw.project);
  if (proj2 === null) throw new FirmwareError('bad-footer', 'project number does not fit');
  const bodyEnd = HDR + streamLen;
  const pad = (4 - (bodyEnd % 4)) % 4;
  out.fill(0, bodyEnd, bodyEnd + pad);
  let p = bodyEnd + pad;
  out.set(fw.models, p);
  p += fw.models.length;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(p, proj2, true);
  dv.setUint32(p + 4, MAGIC, true);
  dv.setUint32(p + 8, fw.fType, true);
  dv.setUint32(p + 12, streamLen, true);
  dv.setUint32(p + 16, decodedLength, true);
  p += 20;
  if (p + 4 !== out.length) throw new FirmwareError('internal', 'container size computation is off');
  dv.setUint32(p, (-sum32(out.subarray(0, p))) >>> 0, true);
}

function containerSize(fw: Firmware, streamLen: number): number {
  const bodyEnd = HDR + streamLen;
  return bodyEnd + ((4 - (bodyEnd % 4)) % 4) + fw.models.length + FOOTER_LEN;
}

/**
 * Wrap an already encoded LZ stream (which must end with the 00 00 terminator) into a container:
 * official header, pad, model records, footer, file checksum. This is the tail end of `build()`;
 * it is exported for tests that hand-build containers.
 */
export function wrapStream(fw: Firmware, stream: Uint8Array, decodedLength: number): Uint8Array {
  const out = new Uint8Array(containerSize(fw, stream.length));
  out.set(fw.header, 0);
  out.set(stream, HDR);
  finishContainer(out, fw, stream.length, decodedLength);
  return out;
}

export interface BuildOutput {
  out: Uint8Array;
  /** Indices of the frames that were replaced by stored frames. */
  reencoded: number[];
}

/**
 * Exact port of `fwpack.build(fw, new_decoded, mode='frames')`: keep each original frame when it
 * still decodes to the wanted bytes, otherwise emit a stored frame; re-decode and mark more
 * frames until the output matches. Layout otherwise unchanged.
 */
export function build(fw: Firmware, newDecoded: Uint8Array): BuildOutput {
  if (newDecoded.length !== fw.decoded.length) throw new FirmwareError('size-mismatch', 'size-changing edits are not supported');
  if (sum32(newDecoded) !== 0) throw new FirmwareError('payload-sum-nonzero', 'the payload word sum must be zero before building');
  const frames = fw.frames;
  const useOrig: boolean[] = frames.map((f) => equalRange(newDecoded, f.outStart, fw.decoded, f.outStart, f.outLen));
  let out: Uint8Array;
  let streamLen: number;
  for (;;) {
    streamLen = 2; // the 00 00 terminator
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (useOrig[i]) streamLen += f.end - f.start;
      else {
        if (f.outLen > 0x7fff) throw new FirmwareError('needs-compressor', `frame at 0x${f.outStart.toString(16)} needs a real compressor`);
        streamLen += 2 + f.outLen;
      }
    }
    out = new Uint8Array(containerSize(fw, streamLen));
    out.set(fw.header, 0);
    let p = HDR;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (useOrig[i]) {
        out.set(fw.raw.subarray(f.start, f.end), p);
        p += f.end - f.start;
      } else {
        const prefix = 0x8000 | f.outLen;
        out[p] = prefix >>> 8;
        out[p + 1] = prefix & 0xff;
        out.set(newDecoded.subarray(f.outStart, f.outStart + f.outLen), p + 2);
        p += 2 + f.outLen;
      }
    }
    out[p] = 0;
    out[p + 1] = 0;
    p += 2;
    if (p !== HDR + streamLen) throw new FirmwareError('internal', 'stream size computation is off');
    const re = parseFrames(out.subarray(0, HDR + streamLen), newDecoded.length);
    if (re.frames.length !== frames.length) throw new FirmwareError('frame-count-changed', 're-decoded stream has a different number of frames');
    const bad: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!equalRange(re.decoded, f.outStart, newDecoded, f.outStart, f.outLen)) bad.push(i);
    }
    if (bad.length === 0) break;
    for (const i of bad) {
      if (!useOrig[i]) throw new FirmwareError('stored-frame-mismatch', 'stored frame decoded wrong');
      useOrig[i] = false;
    }
  }
  finishContainer(out, fw, streamLen, newDecoded.length);
  const reencoded: number[] = [];
  for (let i = 0; i < useOrig.length; i++) if (!useOrig[i]) reencoded.push(i);
  return { out, reencoded };
}

export interface VerifyResult {
  /** Named checks; all must be true. `stream_len_matches` is absent for a raw (unframed) payload. */
  checks: Record<string, boolean>;
  decoded: Uint8Array;
  /** Frames of the stream (empty for a raw payload). Not part of the Python original; saves a re-parse. */
  frames: Frame[];
  /** Where the stream parse stopped (HDR + decoded length for a raw payload). */
  streamEnd: number;
}

/** Port of `fwpack.verify`: re-run the checks found in the updater's code on a container. */
export function verifyContainer(raw: Uint8Array, expectDecoded?: Uint8Array): VerifyResult {
  if (raw.length < HDR + FOOTER_LEN) throw new FirmwareError('too-short', 'file is too short to be a firmware container');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const res: Record<string, boolean> = {};
  const proj = dv.getUint32(0x30, true);
  const proj2 = projTwice(proj);
  res.hdr_proj2 = dv.getUint32(0x78, true) === proj2;
  res.hdr_magic = dv.getUint32(0x7c, true) === MAGIC;
  const t = raw.length - FOOTER_LEN;
  const p2 = dv.getUint32(t, true);
  const mg = dv.getUint32(t + 4, true);
  const clen = dv.getUint32(t + 12, true);
  const dlen = dv.getUint32(t + 16, true);
  res.ftr_proj2 = p2 === proj2;
  res.ftr_magic = mg === MAGIC;
  res.file_sum_zero = sum32(raw) === 0;
  let dec: Uint8Array;
  let frames: Frame[] = [];
  let streamEnd: number;
  if (clen === dlen) {
    dec = raw.subarray(HDR, Math.min(raw.length, HDR + dlen));
    streamEnd = HDR + dec.length;
  } else {
    const parsed = parseFrames(raw.subarray(0, Math.min(raw.length, HDR + clen)), dlen);
    dec = parsed.decoded;
    frames = parsed.frames;
    streamEnd = parsed.streamEnd;
    res.stream_len_matches = parsed.streamEnd - HDR === clen;
  }
  res.decoded_len_matches = dec.length === dlen;
  res.decoded_sum_zero = sum32(dec) === 0;
  if (expectDecoded !== undefined) {
    res.decoded_equals_expected = dec.length === expectDecoded.length && equalRange(dec, 0, expectDecoded, 0, dec.length);
  }
  return { checks: res, decoded: dec, frames, streamEnd };
}

/** Lower-case hex SHA-256 via WebCrypto (browsers and Node 22). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const digest = await subtle.digest('SHA-256', bytes as unknown as Parameters<typeof subtle.digest>[1]);
  const h = new Uint8Array(digest);
  let s = '';
  for (let i = 0; i < h.length; i++) s += h[i].toString(16).padStart(2, '0');
  return s;
}
