// Baseline JPEG encoder core: colour conversion, chroma downsampling, forward
// DCT (done once) and a fast "quantise + Huffman-encode" stage that can be
// re-run many times with different quantisation tables.

import { JpegError } from './errors';
import { NATURAL_TO_ZIGZAG, STD_HUFFMAN, naturalToZigzag } from './tables';

export type Sampling = '422' | '420';

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly sampling: Sampling;
  /** MCU size in pixels: 16x8 for 4:2:2, 16x16 for 4:2:0. */
  readonly mcuW: number;
  readonly mcuH: number;
  readonly mcusX: number;
  readonly mcusY: number;
  /** Blocks per MCU: Y Y Cb Cr (4) or Y Y Y Y Cb Cr (6). */
  readonly blocksPerMcu: number;
  readonly lumaPerMcu: number;
  readonly blockCount: number;
}

export function makeLayout(width: number, height: number, sampling: Sampling): Layout {
  if (sampling !== '422' && sampling !== '420') throw new JpegError('bad-input', `unknown sampling "${String(sampling)}"`);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new JpegError('bad-input', `invalid image size ${width}x${height}`);
  }
  const mcuW = 16;
  const mcuH = sampling === '420' ? 16 : 8;
  const mcusX = Math.ceil(width / mcuW);
  const mcusY = Math.ceil(height / mcuH);
  const lumaPerMcu = sampling === '420' ? 4 : 2;
  const blocksPerMcu = lumaPerMcu + 2;
  return { width, height, sampling, mcuW, mcuH, mcusX, mcusY, blocksPerMcu, lumaPerMcu, blockCount: mcusX * mcusY * blocksPerMcu };
}

// ---------------------------------------------------------------------------
// File header
// ---------------------------------------------------------------------------

function buildHeaderTemplate(): { bytes: Uint8Array; dqtOffsets: [number, number]; sofOffset: number } {
  const b: number[] = [];
  b.push(0xff, 0xd8); // SOI
  b.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  const dqtOffsets: [number, number] = [0, 0];
  for (let t = 0; t < 2; t++) {
    b.push(0xff, 0xdb, 0x00, 0x43, t);
    dqtOffsets[t] = b.length;
    for (let i = 0; i < 64; i++) b.push(1);
  }
  const sofOffset = b.length;
  // precision 8, height, width, 3 components (sampling of component 1 is patched in)
  b.push(0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x21, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  for (const spec of STD_HUFFMAN) {
    b.push(0xff, 0xc4, 0x00, 2 + 1 + 16 + spec.values.length, spec.tcTh, ...spec.bits, ...spec.values);
  }
  b.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00); // SOS
  return { bytes: new Uint8Array(b), dqtOffsets, sofOffset };
}

const HEADER = buildHeaderTemplate();

/** Bytes before the entropy-coded data (SOI .. end of SOS header). */
export const HEADER_BYTES: number = HEADER.bytes.length;
/** Everything that is not entropy-coded data: the header plus the 2-byte EOI. */
export const OVERHEAD_BYTES: number = HEADER_BYTES + 2;

/** The complete header for the given frame; tables are in zigzag order. */
export function buildHeader(width: number, height: number, sampling: Sampling, qLumaZigzag: ArrayLike<number>, qChromaZigzag: ArrayLike<number>): Uint8Array {
  const h = HEADER.bytes.slice();
  for (let i = 0; i < 64; i++) {
    h[HEADER.dqtOffsets[0] + i] = qLumaZigzag[i];
    h[HEADER.dqtOffsets[1] + i] = qChromaZigzag[i];
  }
  const s = HEADER.sofOffset;
  h[s + 5] = height >> 8;
  h[s + 6] = height & 0xff;
  h[s + 7] = width >> 8;
  h[s + 8] = width & 0xff;
  h[s + 11] = sampling === '420' ? 0x22 : 0x21;
  return h;
}

/**
 * The smallest file this encoder's fixed structure allows for a frame size:
 * every block codes "DC difference 0" + "end of block" (6 bits per luma block,
 * 4 bits per chroma block with the Annex K Huffman tables). No image content
 * can produce a smaller file. For 720x480: 7,375 bytes (4:2:2), 6,025 bytes (4:2:0).
 */
export function minimumJpegSize(width: number, height: number, sampling: Sampling): number {
  const l = makeLayout(width, height, sampling);
  const lumaBits = HUFF[0].dcSize[0] + HUFF[0].acSize[0];
  const chromaBits = HUFF[1].dcSize[0] + HUFF[1].acSize[0];
  const bits = l.mcusX * l.mcusY * (l.lumaPerMcu * lumaBits + 2 * chromaBits);
  return OVERHEAD_BYTES + Math.ceil(bits / 8);
}

// ---------------------------------------------------------------------------
// Huffman code tables for encoding
// ---------------------------------------------------------------------------

interface EncodeTables {
  dcCode: Uint16Array;
  dcSize: Uint8Array;
  acCode: Uint16Array;
  acSize: Uint8Array;
}

function deriveCodes(bits: readonly number[], values: readonly number[]): { code: Uint16Array; size: Uint8Array } {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let i = 0;
  for (let len = 1; len <= 16; len++) {
    for (let n = 0; n < bits[len - 1]; n++) {
      code[values[i]] = c;
      size[values[i]] = len;
      c++;
      i++;
    }
    c <<= 1;
  }
  return { code, size };
}

const HUFF: readonly [EncodeTables, EncodeTables] = (() => {
  const make = (dc: number, ac: number): EncodeTables => {
    const d = deriveCodes(STD_HUFFMAN[dc].bits, STD_HUFFMAN[dc].values);
    const a = deriveCodes(STD_HUFFMAN[ac].bits, STD_HUFFMAN[ac].values);
    return { dcCode: d.code, dcSize: d.size, acCode: a.code, acSize: a.size };
  };
  return [make(0, 1), make(2, 3)];
})();

/** Number of bits needed for a magnitude 0..2047 (the JPEG "category"). */
const NBITS: Uint8Array = (() => {
  const t = new Uint8Array(2048);
  for (let i = 1; i < 2048; i++) t[i] = 32 - Math.clz32(i);
  return t;
})();

// ---------------------------------------------------------------------------
// Colour conversion + forward DCT
// ---------------------------------------------------------------------------

/** `DCT[u * 8 + x]` = alpha(u) * cos((2x + 1) u pi / 16): the orthonormal 1-D DCT-II matrix. */
export const DCT_MATRIX: Float64Array = (() => {
  const m = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const a = u === 0 ? Math.sqrt(1 / 8) : 0.5;
    for (let x = 0; x < 8; x++) m[u * 8 + x] = a * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return m;
})();

/**
 * RGB -> YCbCr (JFIF full range), chroma averaged down, level shift and forward
 * DCT. Returns the unquantised coefficients of every block in scan order
 * (MCU-interleaved), each block in zigzag order.
 * Sizes that are not a multiple of the MCU are padded by edge replication.
 */
export function forwardTransform(rgb: ArrayLike<number>, layout: Layout): Float32Array {
  const { width: w, height: h, mcusX, mcusY, mcuH } = layout;
  if (rgb.length !== w * h * 3) {
    throw new JpegError('bad-input', `expected ${w * h * 3} RGB bytes for ${w}x${h}, got ${rgb.length}`);
  }
  const pw = mcusX * 16;
  const ph = mcusY * mcuH;
  const vs = mcuH >> 3; // vertical chroma factor: 1 or 2
  const vShift = vs - 1;
  const cw = pw >> 1;
  const ch = ph >> vShift;
  const yPlane = new Float32Array(pw * ph);
  const cbPlane = new Float32Array(cw * ch);
  const crPlane = new Float32Array(cw * ch);
  const cScale = 1 / (2 * vs);
  for (let py = 0; py < ph; py++) {
    const srcRow = (py < h ? py : h - 1) * w;
    const cRow = (py >> vShift) * cw;
    const yRow = py * pw;
    for (let px = 0; px < pw; px++) {
      const i = (srcRow + (px < w ? px : w - 1)) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      yPlane[yRow + px] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      const ci = cRow + (px >> 1);
      cbPlane[ci] += (-0.168736 * r - 0.331264 * g + 0.5 * b) * cScale;
      crPlane[ci] += (0.5 * r - 0.418688 * g - 0.081312 * b) * cScale;
    }
  }

  const coef = new Float32Array(layout.blockCount * 64);
  const tmp = new Float64Array(64);
  const M = DCT_MATRIX;
  const N2Z = NATURAL_TO_ZIGZAG;
  const fdct = (plane: Float32Array, stride: number, x0: number, y0: number, out: number): void => {
    for (let y = 0; y < 8; y++) {
      const p = (y0 + y) * stride + x0;
      const s0 = plane[p], s1 = plane[p + 1], s2 = plane[p + 2], s3 = plane[p + 3];
      const s4 = plane[p + 4], s5 = plane[p + 5], s6 = plane[p + 6], s7 = plane[p + 7];
      for (let u = 0; u < 8; u++) {
        const m = u * 8;
        tmp[y * 8 + u] =
          M[m] * s0 + M[m + 1] * s1 + M[m + 2] * s2 + M[m + 3] * s3 + M[m + 4] * s4 + M[m + 5] * s5 + M[m + 6] * s6 + M[m + 7] * s7;
      }
    }
    for (let u = 0; u < 8; u++) {
      const t0 = tmp[u], t1 = tmp[8 + u], t2 = tmp[16 + u], t3 = tmp[24 + u];
      const t4 = tmp[32 + u], t5 = tmp[40 + u], t6 = tmp[48 + u], t7 = tmp[56 + u];
      for (let v = 0; v < 8; v++) {
        const m = v * 8;
        coef[out + N2Z[v * 8 + u]] =
          M[m] * t0 + M[m + 1] * t1 + M[m + 2] * t2 + M[m + 3] * t3 + M[m + 4] * t4 + M[m + 5] * t5 + M[m + 6] * t6 + M[m + 7] * t7;
      }
    }
  };

  let o = 0;
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let j = 0; j < layout.lumaPerMcu; j++) {
        fdct(yPlane, pw, mx * 16 + (j & 1) * 8, my * mcuH + (j >> 1) * 8, o);
        o += 64;
      }
      fdct(cbPlane, cw, mx * 8, my * 8, o);
      o += 64;
      fdct(crPlane, cw, mx * 8, my * 8, o);
      o += 64;
    }
  }
  return coef;
}

// ---------------------------------------------------------------------------
// Quantise + entropy-code
// ---------------------------------------------------------------------------

/** Worst case bytes one block can add: 20 DC bits + 63 * 26 AC bits, every byte stuffed. */
const MAX_BLOCK_BYTES = 420;
/** 32-bit words reserved per block in the bit-string cache (20 + 63 * 26 = 1658 bits at most). */
const CACHE_WORDS = 52;
/** The bit-string cache is only used while it stays below this many bytes. */
const CACHE_BYTE_LIMIT = 48 << 20;

/**
 * Holds the unquantised coefficients plus their current quantised values and
 * produces the entropy-coded scan. Changing one table entry only requantises
 * that one coefficient column, so a trial costs far less than a full encode.
 *
 * Two independent routes give the size of the scan:
 *  - `emit()` writes the actual bytes (used for every file that is returned);
 *  - `countBytes()` keeps the Huffman bit string of every block cached, re-codes
 *    only blocks whose coefficients changed and then just counts bytes and 0xFF
 *    stuffing. It is several times faster and is what the size search uses.
 */
export class ScanCoder {
  /** Current tables [luma, chroma] in zigzag order. Change them only through the methods. */
  readonly tables: readonly [Uint8Array, Uint8Array] = [new Uint8Array(64), new Uint8Array(64)];
  /** Entropy-coded bytes of the last `emit` call (valid up to its return value). */
  out: Uint8Array;

  private readonly coef: Float32Array;
  private readonly blockCount: number;
  /** Component (0 = Y, 1 = Cb, 2 = Cr) of every block in scan order. */
  private readonly comp: Uint8Array;
  /** Previous / next block of the same component in scan order (-1 = none): the DC prediction chain. */
  private readonly prevSame: Int32Array;
  private readonly nextSame: Int32Array;
  /** Block indices that use table 0 (luma) and table 1 (chroma). */
  private readonly classBlocks: readonly [Int32Array, Int32Array];
  private readonly quant: Int16Array;
  /** Zigzag index of the last non-zero AC coefficient of each block (0 = none). */
  private readonly last: Uint8Array;
  private initialised = false;

  // bit-string cache (allocated on first use of countBytes)
  private cacheBits: Int32Array | null = null;
  private cacheLen: Uint16Array | null = null;
  private dirty: Uint8Array | null = null;
  private dirtyList: Int32Array | null = null;
  private dirtyCount = 0;
  private allDirty = true;

  constructor(coef: Float32Array, layout: Layout) {
    const n = layout.blockCount;
    if (coef.length !== n * 64) throw new JpegError('bad-input', 'coefficient array does not match the layout');
    this.coef = coef;
    this.blockCount = n;
    this.comp = new Uint8Array(n);
    this.prevSame = new Int32Array(n).fill(-1);
    this.nextSame = new Int32Array(n).fill(-1);
    const luma: number[] = [];
    const chroma: number[] = [];
    const lastOf = [-1, -1, -1];
    for (let b = 0; b < n; b++) {
      const p = b % layout.blocksPerMcu;
      const c = p < layout.lumaPerMcu ? 0 : p - layout.lumaPerMcu + 1;
      this.comp[b] = c;
      (c === 0 ? luma : chroma).push(b);
      this.prevSame[b] = lastOf[c];
      if (lastOf[c] >= 0) this.nextSame[lastOf[c]] = b;
      lastOf[c] = b;
    }
    this.classBlocks = [Int32Array.from(luma), Int32Array.from(chroma)];
    this.quant = new Int16Array(n * 64);
    this.last = new Uint8Array(n);
    this.out = new Uint8Array(1 << 16);
  }

  /** Set both tables (zigzag order, entries 1..255). Only the entries that differ are requantised. */
  setTables(luma: ArrayLike<number>, chroma: ArrayLike<number>): void {
    const next = [luma, chroma];
    if (!this.initialised) {
      for (let t = 0; t < 2; t++) for (let k = 0; k < 64; k++) this.tables[t][k] = next[t][k];
      this.quantiseAll();
      this.initialised = true;
      return;
    }
    let differing = 0;
    for (let t = 0; t < 2; t++) for (let k = 0; k < 64; k++) if (this.tables[t][k] !== next[t][k]) differing++;
    if (differing > 48) {
      for (let t = 0; t < 2; t++) for (let k = 0; k < 64; k++) this.tables[t][k] = next[t][k];
      this.quantiseAll();
      return;
    }
    for (let t = 0; t < 2; t++) {
      for (let k = 0; k < 64; k++) {
        if (this.tables[t][k] !== next[t][k]) this.setEntry(t, k, next[t][k]);
      }
    }
  }

  // Quantisation is round-half-away-from-zero of x = coefficient * (1 / q),
  // written as: x >= 0.5 -> trunc(x + 0.5), x <= -0.5 -> trunc(x - 0.5), else 0.
  // quantiseAll and setEntry must use exactly this arithmetic.
  private quantiseAll(): void {
    const { coef, quant, last, comp, blockCount } = this;
    const recip = [new Float64Array(64), new Float64Array(64)];
    for (let t = 0; t < 2; t++) for (let k = 0; k < 64; k++) recip[t][k] = 1 / this.tables[t][k];
    quant.fill(0);
    for (let b = 0, base = 0; b < blockCount; b++, base += 64) {
      const r = recip[comp[b] === 0 ? 0 : 1];
      let lastNz = 0;
      for (let k = 0; k < 64; k++) {
        const x = coef[base + k] * r[k];
        // most coefficients quantise to zero: |x| < 0.5
        if (x >= 0.5) {
          quant[base + k] = (x + 0.5) | 0;
          lastNz = k;
        } else if (x <= -0.5) {
          quant[base + k] = (x - 0.5) | 0;
          lastNz = k;
        }
      }
      // k = 0 is the DC term; a non-zero DC with no AC leaves lastNz at 0 as intended.
      last[b] = lastNz;
    }
    this.allDirty = true;
    this.dirtyCount = 0;
    if (this.dirty) this.dirty.fill(0);
  }

  /**
   * Change one table entry (`cls` 0 = luma, 1 = chroma; `k` = zigzag index) and
   * requantise that coefficient in every block that uses the table.
   * Returns the number of quantised coefficients that changed.
   */
  setEntry(cls: number, k: number, value: number): number {
    const table = this.tables[cls];
    table[k] = value;
    const { coef, quant, last } = this;
    const blocks = this.classBlocks[cls];
    const recip = 1 / value;
    const track = this.dirty !== null && !this.allDirty;
    let changed = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const idx = b * 64 + k;
      const x = coef[idx] * recip;
      const r = x >= 0.5 ? (x + 0.5) | 0 : x <= -0.5 ? (x - 0.5) | 0 : 0;
      if (r !== quant[idx]) {
        quant[idx] = r;
        changed++;
        if (k > 0) {
          if (r !== 0) {
            if (k > last[b]) last[b] = k;
          } else if (k === last[b]) {
            let j = k - 1;
            const base = b * 64;
            while (j > 0 && quant[base + j] === 0) j--;
            last[b] = j;
          }
        }
        if (track) {
          this.markDirty(b);
          // a changed DC value also changes the DC difference coded in the next block of the component
          if (k === 0 && this.nextSame[b] >= 0) this.markDirty(this.nextSame[b]);
        }
      }
    }
    return changed;
  }

  private markDirty(b: number): void {
    const dirty = this.dirty as Uint8Array;
    if (dirty[b] === 0) {
      dirty[b] = 1;
      (this.dirtyList as Int32Array)[this.dirtyCount++] = b;
    }
  }

  /**
   * The nearest value for entry (cls, k) in direction `dir` (-1 = finer, +1 =
   * coarser) that changes at least one quantised coefficient, or 0 if no value
   * within 1..255 does. Does not modify any state. (The result is a very good
   * guess; callers confirm it with `setEntry`.)
   */
  nearestEffective(cls: number, k: number, dir: number): number {
    const { coef, quant } = this;
    const q = this.tables[cls][k];
    const blocks = this.classBlocks[cls];
    if (dir < 0) {
      // |c| / q' >= n + 0.5  <=>  q' <= |c| / (n + 0.5)
      let best = 0;
      for (let i = 0; i < blocks.length; i++) {
        const idx = blocks[i] * 64 + k;
        const n = Math.abs(quant[idx]);
        const cand = Math.floor(Math.abs(coef[idx]) / (n + 0.5));
        if (cand > best) best = cand;
      }
      if (best >= q) best = q - 1;
      return best >= 1 ? best : 0;
    }
    // |c| / q' < n - 0.5  <=>  q' > |c| / (n - 0.5), only for n >= 1
    let best = 256;
    for (let i = 0; i < blocks.length; i++) {
      const idx = blocks[i] * 64 + k;
      const n = Math.abs(quant[idx]);
      if (n === 0) continue;
      const cand = Math.floor(Math.abs(coef[idx]) / (n - 0.5)) + 1;
      if (cand < best) best = cand;
    }
    if (best <= q) best = q + 1;
    return best <= 255 ? best : 0;
  }

  /**
   * Huffman-encode the current quantised coefficients into `out` and return the
   * number of entropy-coded bytes (stuffing and final 1-bit padding included).
   * If the output grows beyond `limit` bytes the encode stops early and returns
   * a value greater than `limit`.
   */
  emit(limit: number = Infinity): number {
    const { quant, last, comp, blockCount } = this;
    let out = this.out;
    let pos = 0;
    let acc = 0; // bit accumulator, the low `nb` bits are pending
    let nb = 0;
    let pred0 = 0, pred1 = 0, pred2 = 0;
    for (let b = 0, base = 0; b < blockCount; b++, base += 64) {
      if (pos > limit) return pos;
      if (pos + MAX_BLOCK_BYTES > out.length) {
        const grown = new Uint8Array(Math.max(out.length * 2, pos + MAX_BLOCK_BYTES));
        grown.set(out.subarray(0, pos));
        this.out = out = grown;
      }
      const c = comp[b];
      const huff = HUFF[c === 0 ? 0 : 1];
      const dc = quant[base];
      let diff: number;
      if (c === 0) {
        diff = dc - pred0;
        pred0 = dc;
      } else if (c === 1) {
        diff = dc - pred1;
        pred1 = dc;
      } else {
        diff = dc - pred2;
        pred2 = dc;
      }
      // DC: Huffman code of the category followed by the category's extra bits (<= 9 + 11 bits).
      let cat = NBITS[diff < 0 ? -diff : diff];
      let size = huff.dcSize[cat] + cat;
      acc = (((acc << huff.dcSize[cat]) | huff.dcCode[cat]) << cat) | (diff < 0 ? diff + (1 << cat) - 1 : diff);
      nb += size;
      while (nb >= 8) {
        nb -= 8;
        const byte = (acc >>> nb) & 0xff;
        out[pos++] = byte;
        if (byte === 0xff) out[pos++] = 0;
      }
      // AC
      const acCode = huff.acCode;
      const acSize = huff.acSize;
      const end = last[b];
      let run = 0;
      for (let k = 1; k <= end; k++) {
        const v = quant[base + k];
        if (v === 0) {
          run++;
          continue;
        }
        while (run > 15) {
          acc = (acc << acSize[0xf0]) | acCode[0xf0];
          nb += acSize[0xf0];
          while (nb >= 8) {
            nb -= 8;
            const byte = (acc >>> nb) & 0xff;
            out[pos++] = byte;
            if (byte === 0xff) out[pos++] = 0;
          }
          run -= 16;
        }
        cat = NBITS[v < 0 ? -v : v];
        const sym = (run << 4) | cat;
        size = acSize[sym];
        acc = (acc << size) | acCode[sym];
        nb += size;
        while (nb >= 8) {
          nb -= 8;
          const byte = (acc >>> nb) & 0xff;
          out[pos++] = byte;
          if (byte === 0xff) out[pos++] = 0;
        }
        acc = (acc << cat) | (v < 0 ? v + (1 << cat) - 1 : v);
        nb += cat;
        while (nb >= 8) {
          nb -= 8;
          const byte = (acc >>> nb) & 0xff;
          out[pos++] = byte;
          if (byte === 0xff) out[pos++] = 0;
        }
        run = 0;
      }
      if (end < 63) {
        acc = (acc << acSize[0]) | acCode[0]; // EOB
        nb += acSize[0];
        while (nb >= 8) {
          nb -= 8;
          const byte = (acc >>> nb) & 0xff;
          out[pos++] = byte;
          if (byte === 0xff) out[pos++] = 0;
        }
      }
    }
    if (nb > 0) {
      // pad the final byte with 1-bits
      const byte = ((acc << (8 - nb)) | ((1 << (8 - nb)) - 1)) & 0xff;
      out[pos++] = byte;
      if (byte === 0xff) out[pos++] = 0;
    }
    return pos;
  }

  /**
   * Same result as `emit()` (the number of entropy-coded bytes) without writing
   * them: cached per-block bit strings are concatenated and the bytes and 0xFF
   * stuffing bytes counted. Only blocks touched since the last call are re-coded.
   */
  countBytes(): number {
    const n = this.blockCount;
    if (this.cacheBits === null) {
      if (n * CACHE_WORDS * 4 > CACHE_BYTE_LIMIT) return this.emit();
      this.cacheBits = new Int32Array(n * CACHE_WORDS);
      this.cacheLen = new Uint16Array(n);
      this.dirty = new Uint8Array(n);
      this.dirtyList = new Int32Array(n);
      this.allDirty = true;
    }
    const bits = this.cacheBits;
    const lens = this.cacheLen as Uint16Array;
    if (this.allDirty) {
      for (let b = 0; b < n; b++) this.cacheBlock(b);
      this.allDirty = false;
    } else if (this.dirtyCount > 0) {
      const dirty = this.dirty as Uint8Array;
      const list = this.dirtyList as Int32Array;
      for (let i = 0; i < this.dirtyCount; i++) {
        this.cacheBlock(list[i]);
        dirty[list[i]] = 0;
      }
    }
    this.dirtyCount = 0;

    // Concatenate into byte-aligned 32-bit words and count the 0xFF bytes.
    let word = 0; // the low `fill` bits are pending (always clean above them)
    let fill = 0;
    let total = 0; // total bits
    let stuffed = 0;
    for (let b = 0, w = 0; b < n; b++, w += CACHE_WORDS) {
      let len = lens[b];
      total += len;
      for (let i = w; len > 0; i++) {
        const s = len >= 32 ? 32 : len; // bits in this cache word, right-aligned
        const src = bits[i];
        len -= s;
        if (fill + s >= 32) {
          const rest = fill + s - 32; // bits of src that do not fit
          const full = (word << (s - rest)) | (src >>> rest);
          // a byte is 0xFF iff all its bits are set
          let y = full & (full >>> 1);
          y &= y >>> 2;
          y &= y >>> 4;
          y &= 0x01010101;
          if (y !== 0) stuffed += Math.imul(y, 0x01010101) >>> 24;
          fill = rest;
          word = rest === 0 ? 0 : src & ((1 << rest) - 1);
        } else {
          word = (word << s) | src;
          fill += s;
        }
      }
    }
    // remaining bits, padded with 1-bits to a whole byte
    const pad = (8 - (fill & 7)) & 7;
    let tail = fill + pad;
    let rest = (word << pad) | ((1 << pad) - 1);
    while (tail > 0) {
      tail -= 8;
      if (((rest >>> tail) & 0xff) === 0xff) stuffed++;
    }
    return ((total + 7) >>> 3) + stuffed;
  }

  /** Huffman-code block `b` into its cache slot (bits packed MSB first, last word right-aligned). */
  private cacheBlock(b: number): void {
    const quant = this.quant;
    const words = this.cacheBits as Int32Array;
    const base = b * 64;
    let w = b * CACHE_WORDS;
    const c = this.comp[b];
    const huff = HUFF[c === 0 ? 0 : 1];
    const prev = this.prevSame[b];
    const diff = quant[base] - (prev < 0 ? 0 : quant[prev * 64]);
    let cat = NBITS[diff < 0 ? -diff : diff];
    // DC code + extra bits: at most 20 bits, the slot is empty
    let acc = (huff.dcCode[cat] << cat) | (diff < 0 ? diff + (1 << cat) - 1 : diff);
    let nb = huff.dcSize[cat] + cat;
    let total = nb;
    const acCode = huff.acCode;
    const acSize = huff.acSize;
    const end = this.last[b];
    let run = 0;
    for (let k = 1; k <= end; k++) {
      const v = quant[base + k];
      if (v === 0) {
        run++;
        continue;
      }
      while (run > 15) {
        const size = acSize[0xf0];
        const code = acCode[0xf0];
        total += size;
        nb += size;
        if (nb >= 32) {
          nb -= 32;
          words[w++] = (acc << (size - nb)) | (code >>> nb);
          acc = code & ((1 << nb) - 1);
        } else {
          acc = (acc << size) | code;
        }
        run -= 16;
      }
      cat = NBITS[v < 0 ? -v : v];
      const sym = (run << 4) | cat;
      // Huffman code (<= 16 bits) and extra bits (<= 10 bits) as one string of <= 26 bits
      const size = acSize[sym] + cat;
      const code = (acCode[sym] << cat) | (v < 0 ? v + (1 << cat) - 1 : v);
      total += size;
      nb += size;
      if (nb >= 32) {
        nb -= 32;
        words[w++] = (acc << (size - nb)) | (code >>> nb);
        acc = code & ((1 << nb) - 1);
      } else {
        acc = (acc << size) | code;
      }
      run = 0;
    }
    if (end < 63) {
      const size = acSize[0];
      const code = acCode[0];
      total += size;
      nb += size;
      if (nb >= 32) {
        nb -= 32;
        words[w++] = (acc << (size - nb)) | (code >>> nb);
        acc = code & ((1 << nb) - 1);
      } else {
        acc = (acc << size) | code;
      }
    }
    if (nb > 0) words[w] = acc;
    (this.cacheLen as Uint16Array)[b] = total;
  }
}

/** Wrap entropy-coded bytes into a complete file: header + scan + EOI. */
export function assembleFile(layout: Layout, qLumaZigzag: ArrayLike<number>, qChromaZigzag: ArrayLike<number>, scan: Uint8Array, scanBytes: number): Uint8Array {
  const header = buildHeader(layout.width, layout.height, layout.sampling, qLumaZigzag, qChromaZigzag);
  const file = new Uint8Array(header.length + scanBytes + 2);
  file.set(header, 0);
  file.set(scan.subarray(0, scanBytes), header.length);
  file[file.length - 2] = 0xff;
  file[file.length - 1] = 0xd9;
  return file;
}

/** Full, straightforward encode of precomputed coefficients with the given zigzag tables. */
export function encodeCoefficients(coef: Float32Array, layout: Layout, qLumaZigzag: ArrayLike<number>, qChromaZigzag: ArrayLike<number>): Uint8Array {
  const coder = new ScanCoder(coef, layout);
  coder.setTables(qLumaZigzag, qChromaZigzag);
  const n = coder.emit();
  return assembleFile(layout, qLumaZigzag, qChromaZigzag, coder.out, n);
}

export function validateTable(table: ArrayLike<number>, name: string): void {
  if (!table || table.length !== 64) throw new JpegError('bad-input', `${name} must have 64 entries`);
  for (let i = 0; i < 64; i++) {
    const v = table[i];
    if (!Number.isInteger(v) || v < 1 || v > 255) throw new JpegError('bad-input', `${name}[${i}] = ${v} is outside 1..255`);
  }
}

/**
 * Plain baseline encode with the given quantisation tables (natural, row-major
 * order in; they are written to the file in zigzag order). The file has the
 * fixed structure SOI, APP0, DQT, DQT, SOF0, 4 x DHT (Annex K), SOS, data, EOI.
 */
export function encodeJpeg(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  sampling: Sampling,
  qLuma: Uint8Array,
  qChroma: Uint8Array,
): Uint8Array {
  const layout = makeLayout(width, height, sampling);
  validateTable(qLuma, 'qLuma');
  validateTable(qChroma, 'qChroma');
  const coef = forwardTransform(rgb, layout);
  return encodeCoefficients(coef, layout, naturalToZigzag(qLuma), naturalToZigzag(qChroma));
}
