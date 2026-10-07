import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JpegError,
  checkShutdownJpeg,
  decodeBaselineJpeg,
  encodeExactJpeg,
  encodeJpeg,
  inspectJpeg,
  minimumJpegSize,
  naturalToZigzag,
  qualityTables,
  zigzagToNatural,
} from '../src/jpeg';
import type { ExactJpegResult, JpegInfo, Sampling } from '../src/jpeg';
import { H, W, concat, flat, gradient, makeImage, meanAbsDiff, noise, photoLike, psnr, sameBytes, toGrey, twoTone } from './jpeg-helpers/images';
import { cleanup, photoCrops, pillowDecode, pillowEncode, pillowVersion } from './jpeg-helpers/python';

const PRIVATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'private');
const REF_PATH = join(PRIVATE, 'ref_GBR1.JPG');
const PHOTO_PATH = join(PRIVATE, 'sample_photo.jpg');
const hasRef = existsSync(REF_PATH);
const hasPillow = pillowVersion !== null;
const hasPhoto = hasPillow && existsSync(PHOTO_PATH);

/** 720x480 test images cut from the sample photo (empty when it or Pillow is unavailable). */
const crops: Record<string, Uint8Array> = hasPhoto ? photoCrops(PHOTO_PATH) : {};
const photoNames = ['full', 'centre', 'pixels_a', 'pixels_b'];

const SIZE_A = 56842; // 4:2:2 model
const SIZE_B = 56571; // 4:2:2 model
const SIZE_C = 7264; // 4:2:0 model

// --- measurement log, printed once at the end -------------------------------
const log: string[] = [];
function exact(label: string, rgb: Uint8Array, sampling: Sampling, byteLength: number, seed?: number): ExactJpegResult & { ms: number } {
  const t0 = performance.now();
  try {
    const r = encodeExactJpeg(rgb, { width: W, height: H, sampling, byteLength, seed });
    const ms = performance.now() - t0;
    log.push(`${label.padEnd(26)} ${sampling} ${String(byteLength).padStart(6)}  ok    q=${String(r.quality).padStart(3)}  trials=${String(r.iterations).padStart(4)}  ${ms.toFixed(0).padStart(5)} ms`);
    return { ...r, ms };
  } catch (e) {
    const ms = performance.now() - t0;
    log.push(`${label.padEnd(26)} ${sampling} ${String(byteLength).padStart(6)}  ${e instanceof JpegError ? e.code : 'error'}  ${ms.toFixed(0).padStart(5)} ms`);
    throw e;
  }
}
function expectUnreachable(fn: () => unknown): JpegError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(JpegError);
  expect((caught as JpegError).code).toBe('unreachable-size');
  return caught as JpegError;
}
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(JpegError);
  expect((caught as JpegError).code).toBe(code);
}

afterAll(() => {
  cleanup();
  console.log(['', 'exact-size encodes in this run:', ...log].join('\n'));
});

// --- structure helpers --------------------------------------------------------
const EXPECTED_MARKERS = [0xffd8, 0xffe0, 0xffdb, 0xffdb, 0xffc0, 0xffc4, 0xffc4, 0xffc4, 0xffc4, 0xffda, 0xffd9];
const EXPECTED_LENGTHS = [0, 16, 67, 67, 17, 31, 181, 31, 181, 12, 0];
const APP0_BYTES = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
const sof0Bytes = (ySampling: number): number[] => [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0xd0, 0x03, 0x01, ySampling, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
const SOS_BYTES = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];

function segment(data: Uint8Array, info: JpegInfo, index: number): Uint8Array {
  const s = info.segments[index];
  return data.subarray(s.offset, s.offset + 2 + s.length);
}

function expectStructure(r: ExactJpegResult, byteLength: number, sampling: Sampling): JpegInfo {
  const data = r.data;
  expect(data.length).toBe(byteLength);
  expect(checkShutdownJpeg(data, { byteLength, sampling })).toEqual({ ok: true, problems: [] });
  expect([data[0], data[1]]).toEqual([0xff, 0xd8]);
  expect([data[data.length - 2], data[data.length - 1]]).toEqual([0xff, 0xd9]);

  const info = inspectJpeg(data);
  expect(info.segments.map((s) => s.marker)).toEqual(EXPECTED_MARKERS);
  expect(info.segments.map((s) => s.length)).toEqual(EXPECTED_LENGTHS);
  // contiguous: every segment starts where the previous one ends
  for (let i = 1; i < 10; i++) expect(info.segments[i].offset).toBe(info.segments[i - 1].offset + (i === 1 ? 2 : 2 + info.segments[i - 1].length));
  expect(info.segments[10].offset).toBe(byteLength - 2);
  expect(info.segments.some((s) => s.marker === 0xfffe)).toBe(false); // no COM
  expect(info.segments.filter((s) => s.marker >= 0xffe0 && s.marker <= 0xffef).map((s) => s.marker)).toEqual([0xffe0]);
  expect(info.segments.some((s) => s.marker === 0xffdd)).toBe(false); // no DRI
  expect(info.restartMarkers).toBe(0);
  expect(info.trailingBytes).toBe(0);
  expect(info.baseline).toBe(true);
  expect(info.scans).toBe(1);
  expect(info.precision).toBe(8);
  expect([info.width, info.height]).toEqual([720, 480]);
  expect(info.components).toEqual([
    { id: 1, h: 2, v: sampling === '420' ? 2 : 1, tq: 0 },
    { id: 2, h: 1, v: 1, tq: 1 },
    { id: 3, h: 1, v: 1, tq: 1 },
  ]);

  expect(Array.from(segment(data, info, 1))).toEqual(APP0_BYTES);
  expect(Array.from(segment(data, info, 4))).toEqual(sof0Bytes(sampling === '420' ? 0x22 : 0x21));
  expect(Array.from(segment(data, info, 9))).toEqual(SOS_BYTES);
  expect([5, 6, 7, 8].map((i) => data[info.segments[i].offset + 4])).toEqual([0x00, 0x10, 0x01, 0x11]);

  // DQT: 8-bit tables 0 and 1, values as reported, all within 1..255
  for (let t = 0; t < 2; t++) {
    const dqt = segment(data, info, 2 + t);
    expect(dqt[4]).toBe(t);
    expect(Array.from(dqt.subarray(5))).toEqual(Array.from(r.qtables[t]));
    expect(Math.min(...r.qtables[t])).toBeGreaterThanOrEqual(1);
    expect(Math.max(...r.qtables[t])).toBeLessThanOrEqual(255);
  }
  expect(r.quality).toBeGreaterThanOrEqual(1);
  expect(r.quality).toBeLessThanOrEqual(100);
  expect(r.iterations).toBeGreaterThanOrEqual(1);
  return info;
}

// A valid 4:2:2 file used by several tests.
const basePhoto = photoLike();
const base = exact('photo-like synthetic', basePhoto, '422', SIZE_A);

// =============================================================================
describe('exact-size encoder: file structure', () => {
  it('4:2:2 at 56,842 bytes has exactly the required structure', () => {
    expectStructure(base, SIZE_A, '422');
  });

  it('4:2:2 at 56,571 bytes has exactly the required structure', () => {
    expectStructure(exact('photo-like synthetic', basePhoto, '422', SIZE_B), SIZE_B, '422');
  });

  it('4:2:0 output differs only in the luma sampling factor', () => {
    const r = exact('photo-like synthetic', basePhoto, '420', 30000);
    const info = expectStructure(r, 30000, '420');
    const info422 = inspectJpeg(base.data);
    for (const i of [0, 1, 5, 6, 7, 8, 9]) expect(sameBytes(segment(r.data, info, i), segment(base.data, info422, i))).toBe(true);
  });

  it.skipIf(!hasRef)('the camera-accepted reference file passes the checker', () => {
    const ref = new Uint8Array(readFileSync(REF_PATH));
    expect(ref.length).toBe(SIZE_A);
    expect(checkShutdownJpeg(ref, { byteLength: SIZE_A, sampling: '422' })).toEqual({ ok: true, problems: [] });
    const info = inspectJpeg(ref);
    expect(info.segments.map((s) => s.marker)).toEqual(EXPECTED_MARKERS);
    expect(info.segments.map((s) => s.length)).toEqual(EXPECTED_LENGTHS);
    expect(Array.from(segment(ref, info, 1))).toEqual(APP0_BYTES);
    expect(Array.from(segment(ref, info, 4))).toEqual(sof0Bytes(0x21));
    expect(Array.from(segment(ref, info, 9))).toEqual(SOS_BYTES);
  });

  it.skipIf(!hasRef)('SOF0, the four DHT and SOS segments are byte-identical to the reference file', () => {
    const ref = new Uint8Array(readFileSync(REF_PATH));
    const refInfo = inspectJpeg(ref);
    for (const r of [base, exact('photo-like synthetic', basePhoto, '422', SIZE_B, 5)]) {
      const info = inspectJpeg(r.data);
      expect(info.segments.length).toBe(refInfo.segments.length);
      // everything except the two DQT segments (index 2, 3) and the scan is fixed
      for (const i of [0, 1, 4, 5, 6, 7, 8, 9]) {
        expect(info.segments[i].offset).toBe(refInfo.segments[i].offset);
        expect(Array.from(segment(r.data, info, i))).toEqual(Array.from(segment(ref, refInfo, i)));
      }
      for (const i of [2, 3]) expect(Array.from(segment(r.data, info, i).subarray(0, 5))).toEqual(Array.from(segment(ref, refInfo, i).subarray(0, 5)));
    }
  });

  it.skipIf(!hasPillow)('a plain libjpeg baseline file has the same fixed segments (independent check of the layout)', () => {
    for (const [sub, sampling] of [['4:2:2', '422'], ['4:2:0', '420']] as const) {
      const lib = pillowEncode(basePhoto, W, H, { quality: 80, subsampling: sub });
      expect(checkShutdownJpeg(lib, { byteLength: lib.length, sampling })).toEqual({ ok: true, problems: [] });
      const mine = encodeJpeg(basePhoto, W, H, sampling, zigzagToNatural(qualityTables(80)[0]), zigzagToNatural(qualityTables(80)[1]));
      const a = inspectJpeg(lib);
      const b = inspectJpeg(mine);
      // same quality setting -> libjpeg writes the same tables, so the whole header matches
      for (let i = 0; i < 10; i++) expect(Array.from(segment(mine, b, i))).toEqual(Array.from(segment(lib, a, i)));
    }
  });
});

// =============================================================================
describe.skipIf(!hasPhoto)('exact-size encoder: sample photo', () => {
  it('reaches 56,842 and 56,571 bytes for several crops, each well under 5 s', () => {
    for (const name of photoNames) {
      for (const size of [SIZE_A, SIZE_B]) {
        const r = exact(`photo ${name}`, crops[name], '422', size);
        expectStructure(r, size, '422');
        expect(r.ms).toBeLessThan(5000);
        expect(r.iterations).toBeLessThan(2000);
      }
    }
  });

  it('decodes correctly with Pillow and with decodeBaselineJpeg (PSNR > 30 dB, decoders agree)', () => {
    const src = crops.full;
    const r = exact('photo full (decode test)', src, '422', SIZE_A, 3);
    const pil = pillowDecode(r.data);
    expect([pil.width, pil.height]).toEqual([720, 480]);
    expect(pil.progressive).toBe(false);
    expect(pil.layers).toEqual([
      [1, 2, 1, 0],
      [2, 1, 1, 1],
      [3, 1, 1, 1],
    ]);
    const own = decodeBaselineJpeg(r.data);
    expect([own.width, own.height]).toEqual([720, 480]);
    const pPil = psnr(src, pil.rgb);
    const pOwn = psnr(src, own.rgb);
    const diff = meanAbsDiff(own.rgb, pil.rgb);
    log.push(`photo full @56842: PSNR Pillow ${pPil.toFixed(2)} dB, own decoder ${pOwn.toFixed(2)} dB, decoders differ by ${diff.toFixed(3)} levels on average`);
    expect(pPil).toBeGreaterThan(30);
    expect(pOwn).toBeGreaterThan(30);
    expect(diff).toBeLessThan(1.5);
  });

  it('all crops decode with PSNR > 30 dB at 56,842 bytes and the decoders agree', () => {
    for (const name of photoNames) {
      const r = exact(`photo ${name} (seed 2)`, crops[name], '422', SIZE_A, 2);
      const pil = pillowDecode(r.data);
      const own = decodeBaselineJpeg(r.data);
      expect(psnr(crops[name], pil.rgb)).toBeGreaterThan(30);
      expect(meanAbsDiff(own.rgb, pil.rgb)).toBeLessThan(1.5);
    }
  });

  it('a black-and-white photo stored as RGB', () => {
    const src = crops.bw;
    const r = exact('photo black-and-white', src, '422', SIZE_A);
    expectStructure(r, SIZE_A, '422');
    const pil = pillowDecode(r.data);
    expect(psnr(src, pil.rgb)).toBeGreaterThan(30);
    // still neutral after the round trip
    let cast = 0;
    for (let i = 0; i < pil.rgb.length; i += 3) cast += Math.abs(pil.rgb[i] - pil.rgb[i + 1]) + Math.abs(pil.rgb[i + 2] - pil.rgb[i + 1]);
    expect(cast / (pil.rgb.length / 3)).toBeLessThan(1);
    expect(meanAbsDiff(decodeBaselineJpeg(r.data).rgb, pil.rgb)).toBeLessThan(1.5);
  });

  it('4:2:0 at 7,264 bytes: a photo either fits (as a very coarse image) or is rejected quickly', () => {
    for (const name of photoNames) {
      const t0 = performance.now();
      try {
        const r = exact(`photo ${name}`, crops[name], '420', SIZE_C);
        expectStructure(r, SIZE_C, '420');
        const p = psnr(crops[name], decodeBaselineJpeg(r.data).rgb);
        log.push(`photo ${name} @7264 4:2:0 fits with quality ${r.quality}, PSNR ${p.toFixed(1)} dB`);
      } catch (e) {
        expect(e).toBeInstanceOf(JpegError);
        expect((e as JpegError).code).toBe('unreachable-size');
      }
      expect(performance.now() - t0).toBeLessThan(5000);
    }
  });

  it('a photo is rejected at once when the target is below what its coarsest encoding needs', () => {
    // 6,100 bytes is above the structural minimum (6,025) but below this photo's all-255-tables size
    const t0 = performance.now();
    const err = expectUnreachable(() => exact('photo full', crops.full, '420', 6100));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(err.details.minBytes).toBeGreaterThan(6100);
    expect(err.message).toMatch(/too detailed/);
  });
});

// =============================================================================
describe('exact-size encoder: other contents', () => {
  it('a flat grey image cannot reach 56,842 bytes and is rejected quickly', () => {
    const t0 = performance.now();
    const err = expectUnreachable(() => exact('flat grey', flat(128, 128, 128), '422', SIZE_A));
    expect(performance.now() - t0).toBeLessThan(2000);
    // even all-ones tables give only the structural minimum
    expect(err.details.maxBytes).toBe(7375);
    expect(err.message).toMatch(/too plain/);
  });

  it('flat colours and simple graphics are too plain for 56,842 bytes', () => {
    for (const [name, rgb] of [['flat red', flat(200, 30, 30)], ['two-tone graphic', twoTone()], ['gradient', gradient()]] as const) {
      const t0 = performance.now();
      const err = expectUnreachable(() => exact(name, rgb, '422', SIZE_A));
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(err.details.maxBytes).toBeLessThan(SIZE_A);
    }
  });

  it('a noisy image', () => {
    const r = exact('uniform noise', noise(), '422', SIZE_A);
    expectStructure(r, SIZE_A, '422');
    expect(r.quality).toBeLessThan(40); // noise needs very coarse tables
    const mild = makeImage((x, y, rnd) => {
      const n = (rnd() - 0.5) * 40;
      return [120 + x / 8 + n, 100 + y / 6 + n, 90 + n];
    });
    expectStructure(exact('gradient + noise', mild, '422', SIZE_B), SIZE_B, '422');
  });

  it('a photo-like image decodes with PSNR > 30 dB (own decoder, no Python needed)', () => {
    const own = decodeBaselineJpeg(base.data);
    expect([own.width, own.height]).toEqual([720, 480]);
    expect(psnr(basePhoto, own.rgb)).toBeGreaterThan(30);
  });

  it('a grey image stored as RGB', () => {
    const src = toGrey(photoLike(11));
    const r = exact('photo-like grey', src, '422', SIZE_A);
    expectStructure(r, SIZE_A, '422');
    const own = decodeBaselineJpeg(r.data);
    expect(psnr(src, own.rgb)).toBeGreaterThan(30);
  });

  it('different seeds and nearby target sizes all converge', () => {
    for (let seed = 10; seed < 16; seed++) {
      const size = SIZE_A - (seed - 10) * 37;
      expectStructure(exact(`photo-like seed ${seed}`, basePhoto, '422', size, seed), size, '422');
    }
  });
});

// =============================================================================
describe('exact-size encoder: 4:2:0 at 7,264 bytes and the size limits', () => {
  it('theoretical minimum file sizes for 720x480', () => {
    // every block = DC difference 0 + end-of-block: 6 bits per luma block, 4 bits per chroma block
    expect(minimumJpegSize(720, 480, '422')).toBe(7375); // 625 + 2700 MCUs * 20 bits / 8
    expect(minimumJpegSize(720, 480, '420')).toBe(6025); // 625 + 1350 MCUs * 32 bits / 8
    // a mid-grey image really encodes to exactly that, whatever the tables
    const grey = flat(128, 128, 128);
    const ones = new Uint8Array(64).fill(1);
    const coarse = new Uint8Array(64).fill(255);
    expect(encodeJpeg(grey, W, H, '422', ones, ones).length).toBe(7375);
    expect(encodeJpeg(grey, W, H, '422', coarse, coarse).length).toBe(7375);
    expect(encodeJpeg(grey, W, H, '420', ones, ones).length).toBe(6025);
    const r = exact('flat grey', grey, '420', 6025);
    expectStructure(r, 6025, '420');
  });

  it('a target below the minimum is rejected immediately (7,264 bytes is impossible in 4:2:2)', () => {
    const t0 = performance.now();
    const err = expectUnreachable(() => exact('flat grey', flat(128, 128, 128), '422', SIZE_C));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(err.details.minBytes).toBe(7375);
    expectUnreachable(() => exact('photo-like synthetic', basePhoto, '420', 6024));
  });

  it('a two-tone graphic either fits exactly or is reported unreachable', () => {
    for (const [name, rgb] of [['two-tone graphic', twoTone()], ['gradient', gradient()]] as const) {
      const t0 = performance.now();
      try {
        const r = exact(name, rgb, '420', SIZE_C);
        expectStructure(r, SIZE_C, '420');
        expect([decodeBaselineJpeg(r.data).width, decodeBaselineJpeg(r.data).height]).toEqual([720, 480]);
      } catch (e) {
        expect(e).toBeInstanceOf(JpegError);
        expect((e as JpegError).code).toBe('unreachable-size');
      }
      expect(performance.now() - t0).toBeLessThan(20000);
    }
  });

  it('detailed content is rejected quickly instead of searching', () => {
    const detailed = [
      ['uniform noise', noise()],
      ['photo-like + heavy grain', makeImage((x, y, rnd) => {
        const t = Math.sin(x / 23) * Math.cos(y / 17) * 60;
        const n = (rnd() - 0.5) * 250;
        return [128 + t + n, 110 + t + n * 0.8, 100 - t + n * 0.6];
      })],
    ] as const;
    for (const [name, rgb] of detailed) {
      const t0 = performance.now();
      const err = expectUnreachable(() => exact(name, rgb, '420', SIZE_C));
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(err.details.minBytes).toBeGreaterThan(SIZE_C);
      expect(err.message).toMatch(/too detailed/);
    }
  });

  it('gives up after maxIterations on a degenerate image instead of hanging', () => {
    // identical rows: file sizes move in coarse jumps, an exact hit may not exist
    const stripes = makeImage((_x, y) => {
      const v = 40 + (y / (H - 1)) * 170;
      return [v, v, v];
    });
    const t0 = performance.now();
    let result: ExactJpegResult | undefined;
    try {
      result = encodeExactJpeg(stripes, { width: W, height: H, sampling: '420', byteLength: SIZE_C, maxIterations: 300 });
    } catch (e) {
      expect(e).toBeInstanceOf(JpegError);
      expect((e as JpegError).code).toBe('unreachable-size');
      expect((e as JpegError).details.iterations).toBe(300);
    }
    if (result) {
      expect(result.iterations).toBeLessThanOrEqual(300);
      expectStructure(result, SIZE_C, '420');
    }
    expect(performance.now() - t0).toBeLessThan(10000);
  });
});

// =============================================================================
describe('exact-size encoder: determinism and options', () => {
  it('same input and seed give identical bytes', () => {
    const a = encodeExactJpeg(basePhoto, { width: W, height: H, sampling: '422', byteLength: SIZE_A, seed: 42 });
    const b = encodeExactJpeg(basePhoto.slice(), { width: W, height: H, sampling: '422', byteLength: SIZE_A, seed: 42 });
    expect(sameBytes(a.data, b.data)).toBe(true);
    expect(a.iterations).toBe(b.iterations);
    expect(a.quality).toBe(b.quality);
    expect(Array.from(a.qtables[0])).toEqual(Array.from(b.qtables[0]));
    expect(Array.from(a.qtables[1])).toEqual(Array.from(b.qtables[1]));
    // the default seed is fixed too
    const c = encodeExactJpeg(basePhoto, { width: W, height: H, sampling: '422', byteLength: SIZE_A });
    expect(sameBytes(c.data, base.data)).toBe(true);
  });

  it('another seed is equally valid', () => {
    const other = encodeExactJpeg(basePhoto, { width: W, height: H, sampling: '422', byteLength: SIZE_A, seed: 43 });
    expectStructure(other, SIZE_A, '422');
  });

  it('the result is exactly what encodeJpeg produces with the reported tables', () => {
    const again = encodeJpeg(basePhoto, W, H, '422', zigzagToNatural(base.qtables[0]), zigzagToNatural(base.qtables[1]));
    expect(sameBytes(again, base.data)).toBe(true);
    expect(Array.from(naturalToZigzag(zigzagToNatural(base.qtables[0])))).toEqual(Array.from(base.qtables[0]));
  });

  it('reports progress as increasing fractions ending at 1', () => {
    const seen: number[] = [];
    encodeExactJpeg(basePhoto, { width: W, height: H, sampling: '422', byteLength: SIZE_A, seed: 9, onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('rejects inconsistent input with bad-input', () => {
    const ok = { width: W, height: H, sampling: '422' as Sampling, byteLength: SIZE_A };
    expectCode(() => encodeExactJpeg(basePhoto.subarray(3), ok), 'bad-input');
    expectCode(() => encodeExactJpeg(basePhoto, { ...ok, width: 0 }), 'bad-input');
    expectCode(() => encodeExactJpeg(basePhoto, { ...ok, byteLength: 56842.5 }), 'bad-input');
    expectCode(() => encodeExactJpeg(basePhoto, { ...ok, sampling: '444' as Sampling }), 'bad-input');
    expectCode(() => encodeExactJpeg(basePhoto, { ...ok, maxIterations: 0 }), 'bad-input');
    const t = new Uint8Array(64).fill(8);
    expectCode(() => encodeJpeg(basePhoto, W, H, '422', t.subarray(1), t), 'bad-input');
    const zero = t.slice();
    zero[5] = 0;
    expectCode(() => encodeJpeg(basePhoto, W, H, '422', t, zero), 'bad-input');
    expectCode(() => encodeJpeg(basePhoto, W + 1, H, '422', t, t), 'bad-input');
  });
});

// =============================================================================
describe('encodeJpeg and decodeBaselineJpeg', () => {
  const fine = new Uint8Array(64).fill(2);

  it('sizes that are not a multiple of the MCU are padded by edge replication', () => {
    for (const [w, h] of [[37, 21], [100, 75], [16, 16], [1, 1], [17, 33]]) {
      const src = photoLike(3, w, h);
      for (const sampling of ['422', '420'] as const) {
        const jpg = encodeJpeg(src, w, h, sampling, fine, fine);
        const info = inspectJpeg(jpg);
        expect([info.width, info.height]).toEqual([w, h]);
        const own = decodeBaselineJpeg(jpg);
        expect([own.width, own.height]).toEqual([w, h]);
        expect(own.rgb.length).toBe(w * h * 3);
        if (w > 1) expect(psnr(src, own.rgb)).toBeGreaterThan(30);
        if (hasPillow) {
          const pil = pillowDecode(jpg);
          expect([pil.width, pil.height]).toEqual([w, h]);
          expect(meanAbsDiff(own.rgb, pil.rgb)).toBeLessThan(1.5);
        }
      }
    }
  });

  it('tables are taken in natural order and written in zigzag order', () => {
    const luma = Uint8Array.from({ length: 64 }, (_v, i) => i + 1);
    const chroma = Uint8Array.from({ length: 64 }, (_v, i) => 200 - i);
    const jpg = encodeJpeg(basePhoto, W, H, '422', luma, chroma);
    const info = inspectJpeg(jpg);
    expect(Array.from(segment(jpg, info, 2).subarray(5))).toEqual(Array.from(naturalToZigzag(luma)));
    expect(Array.from(segment(jpg, info, 3).subarray(5))).toEqual(Array.from(naturalToZigzag(chroma)));
    // first entries of the zigzag sequence: natural indices 0, 1, 8, 16, 9, 2
    expect(Array.from(segment(jpg, info, 2).subarray(5, 11))).toEqual([1, 2, 9, 17, 10, 3]);
    expect(checkShutdownJpeg(jpg, { byteLength: jpg.length, sampling: '422' }).ok).toBe(true);
  });

  it('extreme tables still give a valid stream', () => {
    const ones = new Uint8Array(64).fill(1);
    const coarse = new Uint8Array(64).fill(255);
    const noisy = noise();
    for (const rgb of [noisy, basePhoto, flat(0, 0, 0), flat(255, 255, 255), flat(255, 0, 255)]) {
      for (const sampling of ['422', '420'] as const) {
        for (const t of [ones, coarse]) {
          const jpg = encodeJpeg(rgb, W, H, sampling, t, t);
          // the checker decodes the whole scan, so this also proves the stream is well-formed
          expect(checkShutdownJpeg(jpg, { byteLength: jpg.length, sampling })).toEqual({ ok: true, problems: [] });
          const own = decodeBaselineJpeg(jpg);
          // with all-ones tables only chroma subsampling loses anything (noise has no smooth chroma to keep)
          if (t === ones && rgb !== noisy) expect(psnr(rgb, own.rgb)).toBeGreaterThan(40);
          if (hasPillow && t === ones) expect(meanAbsDiff(own.rgb, pillowDecode(jpg).rgb)).toBeLessThan(1.5);
        }
      }
    }
  });

  it.skipIf(!hasPillow)('decodes libjpeg files like Pillow does (4:4:4, 4:2:2, 4:2:0, odd sizes)', () => {
    const src = photoLike(5, 333, 211);
    for (const sub of ['4:4:4', '4:2:2', '4:2:0'] as const) {
      for (const optimize of [false, true]) {
        const jpg = pillowEncode(src, 333, 211, { quality: 85, subsampling: sub, optimize });
        const own = decodeBaselineJpeg(jpg);
        const pil = pillowDecode(jpg);
        expect([own.width, own.height]).toEqual([333, 211]);
        expect(meanAbsDiff(own.rgb, pil.rgb)).toBeLessThan(1.5);
      }
    }
  });

  it('rejects data it cannot decode', () => {
    expectCode(() => decodeBaselineJpeg(new Uint8Array([1, 2, 3, 4, 5, 6])), 'not-jpeg');
    expectCode(() => decodeBaselineJpeg(new Uint8Array(0)), 'not-jpeg');
    // frame header changed to SOF2 (progressive)
    const prog = base.data.slice();
    prog[inspectJpeg(base.data).segments[4].offset + 1] = 0xc2;
    expectCode(() => decodeBaselineJpeg(prog), 'unsupported');
    // scan data cut short
    const cut = concat(base.data.subarray(0, 30000), [0xff, 0xd9]);
    expectCode(() => decodeBaselineJpeg(cut), 'corrupt');
    // absurd dimensions are refused rather than allocated
    const huge = base.data.slice();
    huge.set([0xff, 0xff, 0xff, 0xff], inspectJpeg(base.data).segments[4].offset + 5);
    expectCode(() => decodeBaselineJpeg(huge), 'unsupported');
    expect(checkShutdownJpeg(huge, { byteLength: huge.length, sampling: '422' }).problems.join(' ')).toMatch(/image is 65535x65535/);
  });
});

// =============================================================================
describe('inspectJpeg', () => {
  it('describes a file produced by the encoder', () => {
    const info = inspectJpeg(base.data);
    expect(info.width).toBe(720);
    expect(info.height).toBe(480);
    expect(info.baseline).toBe(true);
    expect(info.scans).toBe(1);
    expect(info.trailingBytes).toBe(0);
    expect(info.segments[0]).toEqual({ marker: 0xffd8, offset: 0, length: 0 });
    expect(info.segments[1]).toEqual({ marker: 0xffe0, offset: 2, length: 16 });
    expect(info.segments[info.segments.length - 1]).toEqual({ marker: 0xffd9, offset: SIZE_A - 2, length: 0 });
  });

  it('counts trailing bytes and throws not-jpeg for anything else', () => {
    expect(inspectJpeg(concat(base.data, [0, 0, 0])).trailingBytes).toBe(3);
    expectCode(() => inspectJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'not-jpeg');
    expectCode(() => inspectJpeg(new Uint8Array(0)), 'not-jpeg');
    expectCode(() => inspectJpeg(base.data.subarray(0, 300)), 'not-jpeg'); // truncated in a segment
    expectCode(() => inspectJpeg(base.data.subarray(0, 40000)), 'not-jpeg'); // no EOI
  });

  it.skipIf(!hasPillow)('recognises a progressive file', () => {
    const prog = pillowEncode(basePhoto, W, H, { quality: 80, subsampling: '4:2:2', progressive: true });
    const info = inspectJpeg(prog);
    expect(info.baseline).toBe(false);
    expect(info.frameMarker).toBe(0xffc2);
    expect(info.scans).toBeGreaterThan(1);
    expect([info.width, info.height]).toEqual([720, 480]);
  });
});

// =============================================================================
describe('checkShutdownJpeg: files the camera would not show', () => {
  const expected = { byteLength: SIZE_A, sampling: '422' as Sampling };
  const header = inspectJpeg(base.data);
  const afterApp0 = header.segments[2].offset;
  const insert = (data: Uint8Array, at: number, bytes: number[]): Uint8Array => concat(data.subarray(0, at), bytes, data.subarray(at));

  it('accepts the valid file', () => {
    expect(checkShutdownJpeg(base.data, expected)).toEqual({ ok: true, problems: [] });
  });

  it('an inserted COM segment, even when the total length is right', () => {
    const com = [0xff, 0xfe, 0x00, 0x06, 0x67, 0x72, 0x6d, 0x64];
    // (a) the real-world failure: a shorter encode padded to the exact length with a COM segment
    const shorter = exact('photo-like (for COM test)', basePhoto, '422', SIZE_A - com.length);
    const padded = insert(shorter.data, afterApp0, com);
    expect(padded.length).toBe(SIZE_A);
    const a = checkShutdownJpeg(padded, expected);
    expect(a.ok).toBe(false);
    expect(a.problems.some((p) => /COM segment/.test(p))).toBe(true);
    expect(a.problems.some((p) => /bytes, must be exactly/.test(p))).toBe(false);
    // the file is still a perfectly decodable JPEG
    expect(decodeBaselineJpeg(padded).width).toBe(720);
    // (b) COM just before EOI is caught as well
    const tail = insert(shorter.data, shorter.data.length - 2, com);
    expect(checkShutdownJpeg(tail, expected).ok).toBe(false);
    // (c) COM added to a full-size file: both problems are listed
    const b = checkShutdownJpeg(insert(base.data, afterApp0, com), expected);
    expect(b.problems.some((p) => /COM segment/.test(p))).toBe(true);
    expect(b.problems.some((p) => /bytes, must be exactly/.test(p))).toBe(true);
  });

  it('bytes after EOI', () => {
    const shorter = exact('photo-like (for padding test)', basePhoto, '422', SIZE_A - 5);
    const padded = concat(shorter.data, [0, 0, 0, 0, 0]);
    expect(padded.length).toBe(SIZE_A);
    const r = checkShutdownJpeg(padded, expected);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['5 byte(s) after the EOI marker']);
    expect(checkShutdownJpeg(concat(base.data, [0xff]), expected).ok).toBe(false);
  });

  it('padding hidden elsewhere', () => {
    const shorter = exact('photo-like (for fill test)', basePhoto, '422', SIZE_A - 2);
    // 0xFF fill bytes before a marker are legal JPEG but still padding
    const fillBeforeEoi = insert(shorter.data, shorter.data.length - 2, [0xff, 0xff]);
    expect(fillBeforeEoi.length).toBe(SIZE_A);
    const r1 = checkShutdownJpeg(fillBeforeEoi, expected);
    expect(r1.ok).toBe(false);
    expect(r1.problems.join(' ')).toMatch(/surplus byte/);
    const fillBeforeDqt = insert(shorter.data, afterApp0, [0xff, 0xff]);
    const r2 = checkShutdownJpeg(fillBeforeDqt, expected);
    expect(r2.ok).toBe(false);
    expect(r2.problems.join(' ')).toMatch(/stray byte/);
    // extra zero bytes at the end of the scan data
    const zeros = insert(shorter.data, shorter.data.length - 2, [0x00, 0x00]);
    expect(checkShutdownJpeg(zeros, expected).ok).toBe(false);
    // an extra APPn segment
    const app1 = insert(exact('photo-like (for APP1 test)', basePhoto, '422', SIZE_A - 6).data, afterApp0, [0xff, 0xe1, 0x00, 0x04, 0x00, 0x00]);
    const r3 = checkShutdownJpeg(app1, expected);
    expect(r3.ok).toBe(false);
    expect(r3.problems.join(' ')).toMatch(/APP1 segment/);
  });

  it('a progressive JPEG', () => {
    const patched = base.data.slice();
    patched[header.segments[4].offset + 1] = 0xc2;
    const r = checkShutdownJpeg(patched, expected);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/not baseline/);
  });

  it.skipIf(!hasPillow)('a progressive JPEG made by Pillow', () => {
    const prog = pillowEncode(basePhoto, W, H, { quality: 80, subsampling: '4:2:2', progressive: true });
    const r = checkShutdownJpeg(prog, { byteLength: prog.length, sampling: '422' });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/not baseline/);
    expect(r.problems.join(' ')).toMatch(/scans, must be exactly 1/);
  });

  it.skipIf(!hasPillow)('optimised (non-standard) Huffman tables', () => {
    const opt = pillowEncode(basePhoto, W, H, { quality: 80, subsampling: '4:2:2', optimize: true });
    const r = checkShutdownJpeg(opt, { byteLength: opt.length, sampling: '422' });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/DHT .* differs/);
  });

  it('wrong length', () => {
    const r = checkShutdownJpeg(base.data, { byteLength: SIZE_B, sampling: '422' });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([`file is ${SIZE_A} bytes, must be exactly ${SIZE_B}`]);
    const longer = exact('photo-like synthetic', basePhoto, '422', SIZE_A + 1);
    expect(checkShutdownJpeg(longer.data, expected).ok).toBe(false);
    expect(checkShutdownJpeg(longer.data, { byteLength: SIZE_A + 1, sampling: '422' }).ok).toBe(true);
  });

  it('wrong chroma subsampling', () => {
    const r = checkShutdownJpeg(base.data, { byteLength: SIZE_A, sampling: '420' });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/wrong chroma subsampling, expected 4:2:0/);
    const as420 = exact('photo-like synthetic', basePhoto, '420', SIZE_A);
    expect(checkShutdownJpeg(as420.data, { byteLength: SIZE_A, sampling: '420' }).ok).toBe(true);
    const r2 = checkShutdownJpeg(as420.data, expected);
    expect(r2.ok).toBe(false);
    expect(r2.problems.join(' ')).toMatch(/wrong chroma subsampling, expected 4:2:2/);
  });

  it('wrong frame size, restart markers, altered fixed segments, zero table entries, damaged data', () => {
    const t = new Uint8Array(64).fill(30);
    const small = encodeJpeg(photoLike(1, 704, 480), 704, 480, '422', t, t);
    expect(checkShutdownJpeg(small, { byteLength: small.length, sampling: '422' }).problems.join(' ')).toMatch(/image is 704x480, must be 720x480/);
    expect(checkShutdownJpeg(small, { byteLength: small.length, sampling: '422', width: 704, height: 480 }).ok).toBe(true);

    const dri = insert(base.data, header.segments[9].offset, [0xff, 0xdd, 0x00, 0x04, 0x00, 0x00]);
    expect(checkShutdownJpeg(dri, { byteLength: dri.length, sampling: '422' }).problems.join(' ')).toMatch(/DRI segment/);

    const density = base.data.slice();
    density[header.segments[1].offset + 13] = 72; // JFIF Xdensity
    expect(checkShutdownJpeg(density, expected).problems).toEqual(['APP0 (JFIF) segment differs from the required content']);

    const huff = base.data.slice();
    huff[header.segments[6].offset + 30] ^= 1; // one symbol of the AC luma table
    expect(checkShutdownJpeg(huff, expected).ok).toBe(false);

    const zeroQ = base.data.slice();
    zeroQ[header.segments[3].offset + 5 + 63] = 0;
    expect(checkShutdownJpeg(zeroQ, expected).problems.join(' ')).toMatch(/DQT table 1 contains a zero entry/);

    const cut = concat(base.data.subarray(0, SIZE_A - 1000), new Uint8Array(998).fill(0xff), [0xff, 0xd9]);
    expect(cut.length).toBe(SIZE_A);
    expect(checkShutdownJpeg(cut, expected).ok).toBe(false);

    expect(checkShutdownJpeg(new Uint8Array(SIZE_A), expected).ok).toBe(false);
    expect(checkShutdownJpeg(new Uint8Array(SIZE_A), expected).problems.join(' ')).toMatch(/not a parseable JPEG/);
  });
});
