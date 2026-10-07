// A plain baseline JPEG decoder: Huffman decoding, dequantisation, floating
// point inverse DCT, linear (triangle) chroma upsampling and YCbCr -> RGB.
// Used to preview exactly what the camera will be given, and by the checker to
// verify that the entropy-coded data is complete and carries no extra bytes.

import { JpegError } from './errors';
import { DCT_MATRIX } from './encoder';
import { MARKER, inspectJpeg } from './inspect';
import type { JpegInfo } from './inspect';
import { ZIGZAG } from './tables';

interface DecodeTable {
  /** maxcode[len] = largest code of that length, -1 if none (index 1..16). */
  maxcode: Int32Array;
  /** valptr[len] - mincode[len] (index 1..16). */
  delta: Int32Array;
  values: Uint8Array;
}

interface FrameComponent {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Blocks per line / column, padded to whole MCUs. */
  blocksW: number;
  blocksH: number;
  /** Quantised coefficients, natural order, blocksW * blocksH * 64. */
  coefs: Int16Array;
}

export interface ScanReport {
  /** Offset of the first entropy-coded byte. */
  start: number;
  /** Offset just past the last entropy-coded byte that the decoder consumed. */
  end: number;
  /** Offset of the marker that follows the scan in the file. */
  nextMarker: number;
  /** True when the unused bits of the last byte are all 1 (as the standard requires). */
  paddingOk: boolean;
}

export interface DecodeReport {
  info: JpegInfo;
  width: number;
  height: number;
  /** Present unless decoding was run with `entropyOnly`. */
  rgb?: Uint8Array;
  scans: ScanReport[];
}

/** Larger frames are refused instead of attempting to allocate their buffers. */
const MAX_PIXELS = 100_000_000;

function buildDecodeTable(bits: Uint8Array, values: Uint8Array): DecodeTable {
  const maxcode = new Int32Array(17).fill(-1);
  const delta = new Int32Array(17);
  let code = 0;
  let p = 0;
  for (let len = 1; len <= 16; len++) {
    const n = bits[len - 1];
    if (n > 0) {
      delta[len] = p - code;
      code += n;
      maxcode[len] = code - 1;
      p += n;
    }
    if (code > 1 << len) throw new JpegError('corrupt', 'invalid Huffman table');
    code <<= 1;
  }
  return { maxcode, delta, values };
}

/**
 * Decode a baseline JPEG. With `entropyOnly` the coefficients are decoded but
 * no pixels are reconstructed (used for structural verification).
 */
export function decodeJpegDetailed(data: Uint8Array, entropyOnly = false): DecodeReport {
  const info = inspectJpeg(data);
  if (info.frameMarker === 0) throw new JpegError('not-jpeg', 'no frame header');
  if (info.frameMarker !== MARKER.SOF0 && info.frameMarker !== 0xffc1) {
    throw new JpegError('unsupported', 'only baseline (SOF0) JPEG can be decoded');
  }
  if (info.precision !== 8) throw new JpegError('unsupported', `${info.precision}-bit samples`);
  const { width, height } = info;
  if (width === 0 || height === 0) throw new JpegError('unsupported', 'frame without dimensions');
  if (width * height > MAX_PIXELS) throw new JpegError('unsupported', `image of ${width}x${height} pixels is too large to decode`);
  if (info.components.length !== 1 && info.components.length !== 3) {
    throw new JpegError('unsupported', `${info.components.length} colour components`);
  }
  let hMax = 1;
  let vMax = 1;
  for (const c of info.components) {
    if (c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4 || c.tq > 3) throw new JpegError('corrupt', 'invalid frame header');
    hMax = Math.max(hMax, c.h);
    vMax = Math.max(vMax, c.v);
  }
  const mcusX = Math.ceil(width / (8 * hMax));
  const mcusY = Math.ceil(height / (8 * vMax));
  const comps: FrameComponent[] = info.components.map((c) => {
    const blocksW = mcusX * c.h;
    const blocksH = mcusY * c.v;
    return { ...c, blocksW, blocksH, coefs: new Int16Array(blocksW * blocksH * 64) };
  });

  const qtables: (Uint16Array | undefined)[] = [undefined, undefined, undefined, undefined];
  const dcTables: (DecodeTable | undefined)[] = [undefined, undefined, undefined, undefined];
  const acTables: (DecodeTable | undefined)[] = [undefined, undefined, undefined, undefined];
  let restartInterval = 0;
  let adobeTransform = -1;
  const scans: ScanReport[] = [];
  let frameSeen = false;

  for (let si = 0; si < info.segments.length; si++) {
    const seg = info.segments[si];
    const body = seg.offset + 4;
    const end = seg.offset + 2 + seg.length;
    if (seg.marker === MARKER.DQT) {
      let p = body;
      while (p < end) {
        const pq = data[p] >> 4;
        const tq = data[p] & 15;
        p++;
        if (pq > 1 || tq > 3 || p + 64 * (pq + 1) > end) throw new JpegError('corrupt', 'invalid DQT segment');
        const t = new Uint16Array(64); // natural order
        for (let k = 0; k < 64; k++) {
          t[ZIGZAG[k]] = pq ? (data[p] << 8) | data[p + 1] : data[p];
          p += pq + 1;
        }
        qtables[tq] = t;
      }
    } else if (seg.marker === MARKER.DHT) {
      let p = body;
      while (p < end) {
        const tc = data[p] >> 4;
        const th = data[p] & 15;
        p++;
        if (tc > 1 || th > 3 || p + 16 > end) throw new JpegError('corrupt', 'invalid DHT segment');
        const bits = data.subarray(p, p + 16);
        let count = 0;
        for (let i = 0; i < 16; i++) count += bits[i];
        p += 16;
        if (count > 256 || p + count > end) throw new JpegError('corrupt', 'invalid DHT segment');
        const table = buildDecodeTable(bits, data.subarray(p, p + count));
        p += count;
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (seg.marker === MARKER.DRI) {
      if (seg.length < 4) throw new JpegError('corrupt', 'invalid DRI segment');
      restartInterval = (data[body] << 8) | data[body + 1];
    } else if (seg.marker === MARKER.APP14) {
      if (seg.length >= 14 && data[body] === 0x41 && data[body + 1] === 0x64 && data[body + 2] === 0x6f && data[body + 3] === 0x62 && data[body + 4] === 0x65) {
        adobeTransform = data[body + 11];
      }
    } else if (seg.marker === info.frameMarker) {
      frameSeen = true;
    } else if (seg.marker === MARKER.SOS) {
      if (!frameSeen) throw new JpegError('corrupt', 'scan before frame header');
      const ns = data[body];
      if (ns < 1 || ns > comps.length || seg.length !== 6 + 2 * ns) throw new JpegError('corrupt', 'invalid SOS segment');
      const scanComps: { comp: FrameComponent; dc: DecodeTable; ac: DecodeTable }[] = [];
      for (let i = 0; i < ns; i++) {
        const cid = data[body + 1 + 2 * i];
        const sel = data[body + 2 + 2 * i];
        const comp = comps.find((c) => c.id === cid);
        const dc = dcTables[sel >> 4];
        const ac = acTables[sel & 15];
        if (!comp || (sel >> 4) > 3 || (sel & 15) > 3 || !dc || !ac) throw new JpegError('corrupt', 'scan refers to a missing component or Huffman table');
        scanComps.push({ comp, dc, ac });
      }
      const next = si + 1 < info.segments.length ? info.segments[si + 1].offset : data.length;
      scans.push(decodeScan(data, end, next, scanComps, restartInterval, mcusX, mcusY, width, height, hMax, vMax));
    }
  }
  if (scans.length === 0) throw new JpegError('corrupt', 'no scan');

  const report: DecodeReport = { info, width, height, scans };
  if (!entropyOnly) report.rgb = reconstruct(comps, qtables, width, height, hMax, vMax, adobeTransform);
  return report;
}

function decodeScan(
  data: Uint8Array,
  start: number,
  limit: number,
  scanComps: { comp: FrameComponent; dc: DecodeTable; ac: DecodeTable }[],
  restartInterval: number,
  mcusX: number,
  mcusY: number,
  width: number,
  height: number,
  hMax: number,
  vMax: number,
): ScanReport {
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;

  const readBit = (): number => {
    if (bitCnt === 0) {
      if (pos >= limit) throw new JpegError('corrupt', 'entropy-coded data ends too early');
      const byte = data[pos];
      if (byte === 0xff) {
        if (pos + 1 < data.length && data[pos + 1] === 0x00) pos += 2;
        else throw new JpegError('corrupt', 'entropy-coded data ends too early');
      } else {
        pos++;
      }
      bitBuf = byte;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const receive = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const decodeSymbol = (t: DecodeTable): number => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      if (code <= t.maxcode[len]) return t.values[code + t.delta[len]];
    }
    throw new JpegError('corrupt', 'invalid Huffman code');
  };
  const extend = (v: number, n: number): number => (v < 1 << (n - 1) ? v - (1 << n) + 1 : v);

  const preds = new Int32Array(scanComps.length);
  const decodeBlock = (ci: number, bx: number, by: number): void => {
    const { comp, dc, ac } = scanComps[ci];
    const off = (by * comp.blocksW + bx) * 64;
    const coefs = comp.coefs;
    const t = decodeSymbol(dc);
    if (t > 11) throw new JpegError('corrupt', 'invalid DC category');
    if (t > 0) preds[ci] += extend(receive(t), t);
    coefs[off] = preds[ci];
    let k = 1;
    while (k < 64) {
      const rs = decodeSymbol(ac);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r === 15) {
          k += 16;
          continue;
        }
        if (r !== 0) throw new JpegError('corrupt', 'invalid AC symbol');
        break;
      }
      k += r;
      if (k > 63) throw new JpegError('corrupt', 'AC run exceeds the block');
      coefs[off + ZIGZAG[k]] = extend(receive(s), s);
      k++;
    }
  };

  // A scan with one component is not interleaved: it covers only the blocks that contain image samples.
  const single = scanComps.length === 1;
  const c0 = scanComps[0].comp;
  const unitsX = single ? Math.ceil(Math.ceil((width * c0.h) / hMax) / 8) : mcusX;
  const unitsY = single ? Math.ceil(Math.ceil((height * c0.v) / vMax) / 8) : mcusY;
  const total = unitsX * unitsY;
  let expectedRst = 0;
  for (let u = 0; u < total; u++) {
    if (restartInterval > 0 && u > 0 && u % restartInterval === 0) {
      bitCnt = 0;
      if (pos + 1 >= data.length || data[pos] !== 0xff || data[pos + 1] !== 0xd0 + expectedRst) {
        throw new JpegError('corrupt', 'missing restart marker');
      }
      pos += 2;
      expectedRst = (expectedRst + 1) & 7;
      preds.fill(0);
    }
    const ux = u % unitsX;
    const uy = (u / unitsX) | 0;
    if (single) {
      decodeBlock(0, ux, uy);
    } else {
      for (let ci = 0; ci < scanComps.length; ci++) {
        const { h, v } = scanComps[ci].comp;
        for (let j = 0; j < v; j++) for (let i = 0; i < h; i++) decodeBlock(ci, ux * h + i, uy * v + j);
      }
    }
  }
  const paddingOk = bitCnt === 0 || (bitBuf & ((1 << bitCnt) - 1)) === (1 << bitCnt) - 1;
  return { start, end: pos, nextMarker: limit, paddingOk };
}

function reconstruct(
  comps: FrameComponent[],
  qtables: (Uint16Array | undefined)[],
  width: number,
  height: number,
  hMax: number,
  vMax: number,
  adobeTransform: number,
): Uint8Array {
  const M = DCT_MATRIX;
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const planes: Float32Array[] = [];

  for (const comp of comps) {
    const qt = qtables[comp.tq];
    if (!qt) throw new JpegError('corrupt', 'missing quantisation table');
    const pw = comp.blocksW * 8;
    const ph = comp.blocksH * 8;
    const samples = new Uint8ClampedArray(pw * ph);
    const coefs = comp.coefs;
    for (let by = 0; by < comp.blocksH; by++) {
      for (let bx = 0; bx < comp.blocksW; bx++) {
        const off = (by * comp.blocksW + bx) * 64;
        let acZero = true;
        for (let i = 1; i < 64; i++) {
          if (coefs[off + i] !== 0) {
            acZero = false;
            break;
          }
        }
        const o = by * 8 * pw + bx * 8;
        if (acZero) {
          const v = (coefs[off] * qt[0]) / 8 + 128;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) samples[o + y * pw + x] = v;
          continue;
        }
        for (let i = 0; i < 64; i++) block[i] = coefs[off + i] * qt[i];
        // rows: tmp[v][x] = sum_u M[u][x] * F[v][u]
        for (let v = 0; v < 8; v++) {
          const r = v * 8;
          for (let x = 0; x < 8; x++) {
            tmp[r + x] =
              M[x] * block[r] + M[8 + x] * block[r + 1] + M[16 + x] * block[r + 2] + M[24 + x] * block[r + 3] +
              M[32 + x] * block[r + 4] + M[40 + x] * block[r + 5] + M[48 + x] * block[r + 6] + M[56 + x] * block[r + 7];
          }
        }
        // columns: f[y][x] = sum_v M[v][y] * tmp[v][x]
        for (let x = 0; x < 8; x++) {
          for (let y = 0; y < 8; y++) {
            samples[o + y * pw + x] =
              M[y] * tmp[x] + M[8 + y] * tmp[8 + x] + M[16 + y] * tmp[16 + x] + M[24 + y] * tmp[24 + x] +
              M[32 + y] * tmp[32 + x] + M[40 + y] * tmp[40 + x] + M[48 + y] * tmp[48 + x] + M[56 + y] * tmp[56 + x] + 128;
          }
        }
      }
    }
    planes.push(upsample(samples, pw, comp, width, height, hMax, vMax));
  }

  const rgb = new Uint8Array(width * height * 3);
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);
  const n = width * height;
  if (comps.length === 1) {
    const y = planes[0];
    for (let i = 0, o = 0; i < n; i++, o += 3) rgb[o] = rgb[o + 1] = rgb[o + 2] = clamp(y[i]);
    return rgb;
  }
  const [p0, p1, p2] = planes;
  const isRgb = adobeTransform === 0 || (adobeTransform < 0 && comps[0].id === 0x52 && comps[1].id === 0x47 && comps[2].id === 0x42);
  if (isRgb) {
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      rgb[o] = clamp(p0[i]);
      rgb[o + 1] = clamp(p1[i]);
      rgb[o + 2] = clamp(p2[i]);
    }
    return rgb;
  }
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const y = p0[i];
    const cb = p1[i] - 128;
    const cr = p2[i] - 128;
    rgb[o] = clamp(y + 1.402 * cr);
    rgb[o + 1] = clamp(y - 0.344136 * cb - 0.714136 * cr);
    rgb[o + 2] = clamp(y + 1.772 * cb);
  }
  return rgb;
}

/**
 * Bring a component plane to full image resolution. A factor of 2 uses the
 * usual centred linear ("triangle") filter, 3/4 of the nearer sample plus 1/4
 * of the next one; other integer factors replicate samples.
 */
function upsample(samples: Uint8ClampedArray, stride: number, comp: FrameComponent, width: number, height: number, hMax: number, vMax: number): Float32Array {
  if (hMax % comp.h !== 0 || vMax % comp.v !== 0) throw new JpegError('unsupported', 'fractional chroma sampling ratio');
  const fx = hMax / comp.h;
  const fy = vMax / comp.v;
  // number of real samples of this component (the rest of the plane is MCU padding)
  const cw = Math.ceil((width * comp.h) / hMax);
  const ch = Math.ceil((height * comp.v) / vMax);

  // horizontal pass: ch rows of `width` samples
  const rows = new Float32Array(width * ch);
  for (let y = 0; y < ch; y++) {
    const src = y * stride;
    const dst = y * width;
    if (fx === 1) {
      for (let x = 0; x < width; x++) rows[dst + x] = samples[src + x];
    } else if (fx === 2) {
      for (let x = 0; x < width; x++) {
        const i = x >> 1;
        let j = x & 1 ? i + 1 : i - 1;
        if (j < 0) j = 0;
        else if (j >= cw) j = cw - 1;
        rows[dst + x] = 0.75 * samples[src + i] + 0.25 * samples[src + j];
      }
    } else {
      for (let x = 0; x < width; x++) rows[dst + x] = samples[src + ((x / fx) | 0)];
    }
  }
  if (fy === 1) return rows;

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const dst = y * width;
    if (fy === 2) {
      const i = y >> 1;
      let j = y & 1 ? i + 1 : i - 1;
      if (j < 0) j = 0;
      else if (j >= ch) j = ch - 1;
      const a = i * width;
      const b = j * width;
      for (let x = 0; x < width; x++) out[dst + x] = 0.75 * rows[a + x] + 0.25 * rows[b + x];
    } else {
      const a = ((y / fy) | 0) * width;
      for (let x = 0; x < width; x++) out[dst + x] = rows[a + x];
    }
  }
  return out;
}

/**
 * Decode a baseline (SOF0) JPEG to RGB (width * height * 3 bytes, row-major).
 * Throws `JpegError`: 'not-jpeg', 'unsupported' (progressive, 12-bit, CMYK, ...)
 * or 'corrupt' (the entropy-coded data does not decode).
 */
export function decodeBaselineJpeg(data: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const r = decodeJpegDetailed(data);
  return { width: r.width, height: r.height, rgb: r.rgb as Uint8Array };
}
