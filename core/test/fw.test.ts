/**
 * Firmware toolchain tests. They need the private test data (official firmware and the
 * Python-built reference files); the whole suite is skipped when it is not there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_AREA,
  DECODED_SHA256,
  Firmware,
  FirmwareError,
  ICONBIN_LENGTH,
  ICONBIN_OFFSET,
  ICON_BYTES,
  ICON_H,
  ICON_W,
  LANGS,
  NAME_TABLE_ENTRIES,
  OFFICIAL_SHA256,
  OFFICIAL_SIZE,
  RTOS_LENGTH,
  RTOS_OFFSET,
  SLOTS,
  allowedChars,
  applyName,
  build,
  buildFirmware,
  composeIcon,
  foff,
  normalizeIcon,
  openOfficial,
  parseFrames,
  readIcon,
  readName,
  resolveLayout,
  sectionSums,
  selfCheck,
  sha256Hex,
  sum32,
  tileTemplate,
  validateName,
  verifyContainer,
  wrapStream,
} from '../src/fw';
import type { BuildResult, SlotEdit } from '../src/fw';
import { parseNpyU8 } from './fw-helpers/npy';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'private');
const HAVE = ['official.bin', 'color_ref.json', 'icon_400.npy', 'icon_C200.npy'].every((f) => existsSync(join(DATA, f)));

const SHA = {
  A: '461bc988794d752f50671ec46a5d00a6ede7e5b6a41418b048d094bc8bb72157',
  B: '9c931297aec8e18580b66b7e05cabd336bef7a7e21b0e9a77ea317134c91fe3f',
  C: '04104a33c04f86e90f32e5bd9933d079db8b4e7c00ab363a372251af77bcf047',
  Adecoded: '592d8085cee1f998f5ea27584d648dfb391d80e7d52f237e3bb5240d746e06c8',
  Bdecoded: '614d2454deb43fb9269ec256c1a70961ce20ddd75feac2c1e993d6822280ea54',
  Cdecoded: '17d75e8064cc1c05b8c4cd202e39708d1d78693301fd568a129aae603263b5ec',
};

function load(name: string): Uint8Array {
  const b = readFileSync(join(DATA, name));
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function allTrue(checks: Record<string, boolean>): string[] {
  return Object.keys(checks).filter((k) => checks[k] !== true);
}

interface ColorRef {
  matrix: number[];
  R: number[];
  G: number[];
  B: number[];
}

/**
 * Synthetic LZ streams with the result of the Python original (`fwlib.parse_frames`) for each:
 * frames as [start, end, stored, out_start, out_len, crossref], or ok=false where Python raised
 * IndexError. Needs no private data.
 */
interface FuzzCase {
  src: string;
  ok: boolean;
  frames?: [number, number, boolean, number, number, number][];
  decoded?: string;
  streamEnd?: number;
}

describe('fw: parseFrames against the Python original (synthetic streams)', () => {
  const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fw-helpers', 'parse-fuzz.json'), 'utf8')) as FuzzCase[];
  const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

  it(`matches on ${cases.length} cases, with and without a length hint`, () => {
    expect(cases.length).toBeGreaterThan(100);
    for (const [i, c] of cases.entries()) {
      const src = unhex(c.src);
      for (const hint of [undefined, 1, c.decoded ? c.decoded.length / 2 : 16, 100000]) {
        let got: FuzzCase;
        try {
          const r = parseFrames(src, hint);
          got = {
            src: c.src,
            ok: true,
            frames: r.frames.map((f) => [f.start, f.end, f.stored, f.outStart, f.outLen, f.crossref]),
            decoded: Buffer.from(r.decoded).toString('hex'),
            streamEnd: r.streamEnd,
          };
        } catch (e) {
          expect((e as FirmwareError).code, `case ${i}`).toBe('bad-stream');
          got = { src: c.src, ok: false };
        }
        expect(got, `case ${i} hint ${String(hint)}`).toEqual(c);
      }
    }
  });

  it('FirmwareError carries a code and, for a failed self-check, the checks', () => {
    const e = new FirmwareError('selfcheck-failed', 'header_identical', { header_identical: false });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('selfcheck-failed');
    expect(e.checks).toEqual({ header_identical: false });
    expect(e.message).toBe('selfcheck-failed: header_identical');
  });
});

describe.skipIf(!HAVE)('fw: GR IV firmware 1.11 toolchain', () => {
  let official: Uint8Array;
  let fw: Firmware;
  let DEC: Uint8Array;
  let q400: ColorRef;
  let c200: ColorRef;
  let icon400: Uint8Array;
  let iconC200: Uint8Array;
  let editsB: SlotEdit[];
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    official = load('official.bin');
    const ref = JSON.parse(readFileSync(join(DATA, 'color_ref.json'), 'utf8')) as Record<string, ColorRef>;
    q400 = ref.fw_q400;
    c200 = ref.fw_c200;
    const a = parseNpyU8(load('icon_400.npy'));
    const b = parseNpyU8(load('icon_C200.npy'));
    expect(a.shape).toEqual([40, 40, 4]);
    expect(b.shape).toEqual([40, 40, 4]);
    icon400 = a.data;
    iconC200 = b.data;
    editsB = [
      { slot: 'CY', color: { matrixQ13: q400.matrix, curves: [q400.R, q400.G, q400.B] } },
      { slot: 'CG', color: { matrixQ13: c200.matrix, curves: [c200.R, c200.G, c200.B] } },
    ];
    const t0 = performance.now();
    fw = new Firmware(official);
    timings['decode (new Firmware: parseFrames + checks)'] = performance.now() - t0;
    DEC = fw.decoded;
  });

  afterAll(() => {
    const lines = Object.keys(timings).map((k) => `  ${k}: ${timings[k].toFixed(0)} ms`);
    console.log(`fw timings\n${lines.join('\n')}`);
  });

  // ---------------------------------------------------------------- 1
  describe('1. container round trip', () => {
    it('sum32 handles odd lengths and unaligned views', () => {
      expect(sum32(new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]))).toBe(3);
      expect(sum32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0]))).toBe(1);
      expect(sum32(new Uint8Array([1, 0, 0, 0, 0x34, 0x12]))).toBe(1 + 0x1234);
      expect(sum32(new Uint8Array([1, 0, 0, 0, 0x34, 0x12, 0x80]))).toBe(1 + 0x801234);
      const big = new Uint8Array(13).map((_, i) => i * 17 + 3);
      expect(sum32(big.subarray(1, 9))).toBe(sum32(big.slice(1, 9)));
      expect(sum32(new Uint8Array(0))).toBe(0);
    });

    it('decodes the official file to the known payload', async () => {
      expect(official.length).toBe(OFFICIAL_SIZE);
      expect(await sha256Hex(official)).toBe(OFFICIAL_SHA256);
      expect(DEC.length).toBe(67948280);
      expect(await sha256Hex(DEC)).toBe(DECODED_SHA256);
      if (existsSync(join(DATA, 'official.decoded'))) expect(same(DEC, load('official.decoded'))).toBe(true);
      expect(fw.frames.length).toBe(2765);
      expect(fw.frames[0].outLen).toBe(0x8000);
      expect(fw.frames[1].outLen).toBe(0x6000);
      expect(fw.frames.filter((f) => f.stored).length).toBe(308);
      expect(fw.models.length).toBe(3 * 0x80);
      expect(fw.project).toBe(0x27c);
    });

    it('parseFrames gives the same result with and without the length hint', () => {
      const t0 = performance.now();
      const a = parseFrames(official, fw.fDlen);
      timings['parseFrames(official), preallocated'] = performance.now() - t0;
      const t1 = performance.now();
      const b = parseFrames(official);
      timings['parseFrames(official), growing buffer'] = performance.now() - t1;
      expect(a.streamEnd).toBe(b.streamEnd);
      expect(a.streamEnd).toBe(fw.streamEnd);
      expect(a.frames).toEqual(b.frames);
      expect(same(a.decoded, b.decoded)).toBe(true);
      expect(same(a.decoded, DEC)).toBe(true);
    });

    it('lists the sections; RES is last', () => {
      const s = fw.sections();
      expect(s.map((x) => x.name)).toEqual(['BOOTPARA', 'DRAMPARA', 'PARTPARA', 'M0', 'BOOT', 'RTOS', 'LINUX', 'INITFS', 'SRIC', 'CPU', 'SHELLCMD', 'ICONBIN', 'RES']);
      const rtos = s.find((x) => x.name === 'RTOS')!;
      expect([rtos.offset, rtos.size]).toEqual([RTOS_OFFSET, RTOS_LENGTH]);
      const ib = s.find((x) => x.name === 'ICONBIN')!;
      expect([ib.offset, ib.size]).toEqual([ICONBIN_OFFSET, ICONBIN_LENGTH]);
    });

    it('build(fw, decoded) reproduces the official file byte for byte', () => {
      const t0 = performance.now();
      const { out, reencoded } = build(fw, DEC);
      timings['build(fw, unchanged payload)'] = performance.now() - t0;
      expect(reencoded).toEqual([]);
      expect(firstDiff(out, official)).toBe(-1);
      const v = verifyContainer(out, DEC);
      expect(allTrue(v.checks)).toEqual([]);
      expect(Object.keys(v.checks).sort()).toEqual(
        ['decoded_equals_expected', 'decoded_len_matches', 'decoded_sum_zero', 'file_sum_zero', 'ftr_magic', 'ftr_proj2', 'hdr_magic', 'hdr_proj2', 'stream_len_matches'].sort(),
      );
    });

    it('rejects anything that is not the official file', async () => {
      const t = official.slice();
      t[0x40] ^= 1;
      await expect(openOfficial(t)).rejects.toMatchObject({ code: 'unsupported-firmware' });
      await expect(openOfficial(official.subarray(0, 1000))).rejects.toMatchObject({ code: 'unsupported-firmware' });
      expect(() => new Firmware(t)).toThrowError(FirmwareError);
      try {
        new Firmware(t);
      } catch (e) {
        expect((e as FirmwareError).code).toBe('bad-checksum');
      }
      await expect(buildFirmware(t, [])).rejects.toMatchObject({ code: 'unsupported-firmware' });
    });

    it('no edits: the output is the official file', async () => {
      const r = await buildFirmware(official, []);
      expect(r.sha256).toBe(OFFICIAL_SHA256);
      expect(firstDiff(r.file, official)).toBe(-1);
      expect(r.ranges).toEqual([]);
      expect(r.changedFrames).toEqual([]);
      expect(r.changedBytes).toBe(0);
      expect(allTrue(r.checks)).toEqual([]);
      const r2 = await buildFirmware(official, [{ slot: 'CG' }, { slot: 'CY', names: {} }]);
      expect(r2.sha256).toBe(OFFICIAL_SHA256);
    });

    it('resolves the slot addresses the brief lists', () => {
      const l = resolveLayout(DEC);
      expect(foff(l.CY.matrix)).toBe(0x10619f0);
      expect(l.CY.desc).toBe(0x5407b1e0);
      expect(l.CG.maBlock).toBe(0x5404a6d4);
      expect(l.standard.maBlock).toBe(0x5404af70);
      expect(foff(0x55000000)).toBe(0x17d10 + 0x137b640);
      expect(() => foff(0x55057480)).toThrowError(FirmwareError);
    });
  });

  // ---------------------------------------------------------------- 2-4
  describe('2-4. byte-identical to the Python-built files', () => {
    it('variant A: one matrix', async () => {
      const r = await buildFirmware(official, [{ slot: 'CY', color: { matrixQ13: q400.matrix } }]);
      expect(r.decodedSha256).toBe(SHA.Adecoded);
      expect(r.sha256).toBe(SHA.A);
      if (existsSync(join(DATA, 'A.bin'))) expect(firstDiff(r.file, load('A.bin'))).toBe(-1);
      expect(r.changedFrames).toEqual([698]);
      expect(r.changedBytes).toBe(22);
      expect(r.ranges).toEqual([
        { what: 'CY matrix', offset: 0x10619f0, length: 18 },
        { what: 'checksum compensation word', offset: 0x10610a4, length: 4 },
      ]);
      expect(allTrue(r.checks)).toEqual([]);
    });

    it('variant B: two presets (matrix + curves)', async () => {
      const r = await buildFirmware(official, editsB);
      expect(r.decodedSha256).toBe(SHA.Bdecoded);
      if (existsSync(join(DATA, 'B.decoded'))) expect(firstDiff(r.decoded, load('B.decoded'))).toBe(-1);
      expect(r.sha256).toBe(SHA.B);
      if (existsSync(join(DATA, 'B.bin'))) expect(firstDiff(r.file, load('B.bin'))).toBe(-1);
      expect(r.changedFrames).toEqual([698, 699, 706, 707]);
      expect(r.changedBytes).toBe(5233);
      expect(r.ranges.length).toBe(13);
      expect(allTrue(r.checks)).toEqual([]);
    });

    it('variant B is independent of the order of the edits', async () => {
      const r = await buildFirmware(official, [editsB[1], editsB[0]]);
      expect(r.sha256).toBe(SHA.B);
    });

    it('variant C: two presets + two icons', async () => {
      const edits: SlotEdit[] = [
        { ...editsB[0], icon: icon400 },
        { ...editsB[1], icon: iconC200 },
      ];
      const t0 = performance.now();
      const r = await buildFirmware(official, edits);
      timings['buildFirmware (variant C, full call incl. self-check and hashes)'] = performance.now() - t0;
      expect(r.decodedSha256).toBe(SHA.Cdecoded);
      if (existsSync(join(DATA, 'C.decoded'))) expect(firstDiff(r.decoded, load('C.decoded'))).toBe(-1);
      expect(r.sha256).toBe(SHA.C);
      if (existsSync(join(DATA, 'C.bin'))) expect(firstDiff(r.file, load('C.bin'))).toBe(-1);
      expect(r.changedFrames).toEqual([698, 699, 706, 707, 2053, 2054, 2055]);
      expect(r.changedBytes).toBe(10154);
      expect(r.ranges.slice(-2)).toEqual([
        { what: 'CY icon', offset: 0x30221f0, length: 6400 },
        { what: 'CG icon', offset: 0x3023af0, length: 6400 },
      ]);
      expect(allTrue(r.checks)).toEqual([]);
    });

    it('rejects invalid colour data and duplicate slots', async () => {
      const m = q400.matrix.slice();
      m[0] += 1; // row no longer sums to 8192
      await expect(buildFirmware(official, [{ slot: 'CY', color: { matrixQ13: m } }])).rejects.toMatchObject({ code: 'bad-color' });
      const R = q400.R.slice();
      R[10] = R[9] - 1; // decreasing
      await expect(buildFirmware(official, [{ slot: 'CY', color: { matrixQ13: q400.matrix, curves: [R, q400.G, q400.B] } }])).rejects.toMatchObject({ code: 'bad-color' });
      const G = q400.G.slice();
      G[255] = 16384; // out of range
      await expect(buildFirmware(official, [{ slot: 'CY', color: { matrixQ13: q400.matrix, curves: [q400.R, G, q400.B] } }])).rejects.toMatchObject({ code: 'bad-color' });
      await expect(buildFirmware(official, [editsB[0], editsB[0]])).rejects.toMatchObject({ code: 'bad-edit' });
    });
  });

  // ---------------------------------------------------------------- 5
  describe('5. names', () => {
    it('the tables hold what the brief says', () => {
      expect(LANGS.length).toBe(21);
      expect(readName(DEC, 'en', 301)).toMatchObject({ text: 'Cinema (Yellow)', capacity: 15 });
      expect(readName(DEC, 'en', 302)).toMatchObject({ text: 'Cinema (Green)', capacity: 14 });
      expect(readName(DEC, 'zh-CN', 301)).toMatchObject({ text: '电影（黄色）', capacity: 6 });
      expect(readName(DEC, 'zh-CN', 302)).toMatchObject({ text: '电影（绿色）', capacity: 6 });
      expect(readName(DEC, 'ja', 301).text).toBe('シネマ調(イエロー)');
      for (const s of SLOTS) expect(readName(DEC, 'en', s.nameIndex).text).toBe(s.defaultName);
      // every one of the 21 x 836 entries is a readable descriptor
      let n = 0;
      for (const lang of LANGS) for (let i = 0; i < NAME_TABLE_ENTRIES; i++) n += readName(DEC, lang, i).text.length >= 0 ? 1 : 0;
      expect(n).toBe(21 * 836);
      // a multi-line help text is read with its real length (count 0x356 = 3 lines, 85 units)
      const help = readName(DEC, 'en', 78);
      expect(help.capacity).toBe(85);
      expect(help.text.split('\n').length).toBe(3);
    });

    it('allowedChars is the language character set plus ASCII', () => {
      const en = allowedChars(DEC, 'en');
      const zh = allowedChars(DEC, 'zh-CN');
      for (let c = 0x20; c <= 0x7e; c++) expect(en.has(c)).toBe(true);
      expect(en.has('全'.charCodeAt(0))).toBe(false);
      expect(zh.has('全'.charCodeAt(0))).toBe(true);
      expect(zh.has('能'.charCodeAt(0))).toBe(true);
      expect(en.size).toBe(101);
      expect(zh.size).toBe(553);
    });

    it('validateName', () => {
      expect(validateName(DEC, 'zh-CN', 301, '全能400')).toEqual({ ok: true, capacity: 6 });
      expect(validateName(DEC, 'zh-CN', 301, '电影（黄色）')).toEqual({ ok: true, capacity: 6 });
      expect(validateName(DEC, 'zh-CN', 301, '全能400胶片')).toMatchObject({ ok: false, reason: 'too-long', capacity: 6 });
      expect(validateName(DEC, 'zh-CN', 301, '')).toMatchObject({ ok: false, reason: 'empty' });
      expect(validateName(DEC, 'en', 301, '全能400')).toEqual({ ok: false, reason: 'bad-char', badChars: ['全', '能'], capacity: 15 });
      expect(validateName(DEC, 'en', 301, ' C200')).toMatchObject({ ok: false, reason: 'bad-char', badChars: [' '] });
      expect(validateName(DEC, 'en', 301, 'C200 ')).toMatchObject({ ok: false, reason: 'bad-char' });
      expect(validateName(DEC, 'en', 301, 'C\n200')).toMatchObject({ ok: false, reason: 'bad-char', badChars: ['\n'] });
      expect(validateName(DEC, 'en', 301, 'C\u{1F600}')).toMatchObject({ ok: false, reason: 'bad-char', badChars: ['\u{1F600}'] });
      expect(validateName(DEC, 'en', 302, 'Kodak Gold 200')).toEqual({ ok: true, capacity: 14 });
      expect(validateName(DEC, 'en', 302, 'Kodak Gold 200!')).toMatchObject({ ok: false, reason: 'too-long', capacity: 14 });
    });

    it('applyName writes text, zero fill and count; refuses invalid text', () => {
      const info = readName(DEC, 'zh-CN', 301);
      const lo = info.strOffset - 64;
      const hi = info.strOffset + 64;
      const img = DEC.slice();
      const ranges = applyName(img, 'zh-CN', 301, '全能400', DEC);
      expect(ranges).toEqual([
        { what: 'name zh-CN #301 text', offset: info.strOffset, length: 12 },
        { what: 'name zh-CN #301 length', offset: info.descOffset, length: 4 },
      ]);
      const expectStr = [0x68, 0x51, 0xfd, 0x80, 0x34, 0x00, 0x30, 0x00, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00];
      expect(Array.from(img.subarray(info.strOffset, info.strOffset + 14))).toEqual(expectStr);
      expect(Array.from(img.subarray(info.descOffset, info.descOffset + 4))).toEqual([0x06, 0x01, 0, 0]);
      // nothing else near the string or anywhere else changed
      let diff = 0;
      for (let i = 0; i < img.length; i++) if (img[i] !== DEC[i]) diff++;
      let diffNear = 0;
      for (let i = lo; i < hi; i++) if (img[i] !== DEC[i]) diffNear++;
      let diffDesc = 0;
      for (let i = info.descOffset; i < info.descOffset + 4; i++) if (img[i] !== DEC[i]) diffDesc++;
      expect(diff).toBe(diffNear + diffDesc);
      expect(diffDesc).toBe(1);
      expect(() => applyName(DEC.slice(), 'zh-CN', 301, '全能400胶片', DEC)).toThrowError(/bad-name/);
      expect(() => applyName(DEC.slice(), 'en', 301, '全能', DEC)).toThrowError(/bad-name/);
    });

    it('builds B + names; other languages untouched', async () => {
      const edits: SlotEdit[] = [
        { ...editsB[0], names: { 'zh-CN': '全能400' } },
        { ...editsB[1], names: { 'zh-CN': 'C200', en: 'C200' } },
      ];
      const r = await buildFirmware(official, edits);
      expect(allTrue(r.checks)).toEqual([]);
      // readName on a patched payload: `capacity` is the stored length, i.e. the new text length.
      expect(readName(r.decoded, 'zh-CN', 301)).toMatchObject({ text: '全能400', capacity: 5 });
      expect(readName(r.decoded, 'zh-CN', 302)).toMatchObject({ text: 'C200', capacity: 4 });
      expect(readName(r.decoded, 'en', 302)).toMatchObject({ text: 'C200', capacity: 4 });
      expect(readName(r.decoded, 'en', 301).text).toBe('Cinema (Yellow)');
      const edited = new Set(['zh-CN#301', 'zh-CN#302', 'en#302']);
      for (const lang of LANGS) {
        for (let i = 0; i < NAME_TABLE_ENTRIES; i++) {
          if (edited.has(`${lang}#${i}`)) continue;
          const a = readName(DEC, lang, i);
          const b = readName(r.decoded, lang, i);
          if (a.text !== b.text || a.descOffset !== b.descOffset || a.strOffset !== b.strOffset) throw new Error(`${lang} #${i} changed`);
        }
      }
      const what = r.ranges.map((x) => x.what);
      expect(what).toContain('CY name zh-CN text');
      expect(what).toContain('CY name zh-CN length');
      expect(what).toContain('CG name en text');
      expect(what).toContain('CG name zh-CN length');
      expect(what.indexOf('checksum compensation word')).toBe(what.length - 1);
      // the colour data is exactly variant B's: only names and the compensation word differ from B
      if (existsSync(join(DATA, 'B.decoded'))) {
        const B = load('B.decoded');
        const nameRanges = r.ranges.filter((x) => x.what.includes('name') || x.what.includes('compensation'));
        const ok = new Uint8Array(B.length);
        for (const x of nameRanges) ok.fill(1, x.offset, x.offset + x.length);
        for (let i = 0; i < B.length; i++) if (B[i] !== r.decoded[i] && !ok[i]) throw new Error(`unexpected difference from B at 0x${i.toString(16)}`);
      }
      // RTOS and whole-payload sums as official
      expect(sectionSums(r.decoded)).toEqual(sectionSums(DEC));
      expect(sum32(r.decoded)).toBe(0);
    });

    it('buildFirmware throws on a too-long name and on a character outside the language', async () => {
      await expect(buildFirmware(official, [{ slot: 'CY', names: { 'zh-CN': '全能400胶片' } }])).rejects.toMatchObject({ code: 'bad-name' });
      await expect(buildFirmware(official, [{ slot: 'CG', names: { en: '全能' } }])).rejects.toMatchObject({ code: 'bad-name' });
      await expect(buildFirmware(official, [{ slot: 'CG', names: { en: '' } }])).rejects.toMatchObject({ code: 'bad-name' });
      await expect(buildFirmware(official, [{ slot: 'CG', names: { xx: 'C200' } as never }])).rejects.toMatchObject({ code: 'bad-language' });
    });

    it('a names-only build passes the self-check', async () => {
      const r = await buildFirmware(official, [{ slot: 'CY', names: { en: 'Q400' } }]);
      expect(allTrue(r.checks)).toEqual([]);
      expect(readName(r.decoded, 'en', 301).text).toBe('Q400');
      expect(r.ranges.map((x) => x.what)).toEqual(['CY name en text', 'CY name en length', 'checksum compensation word']);
    });
  });

  // ---------------------------------------------------------------- 6
  describe('6. single icon', () => {
    const POOL = 232;
    const CY = SLOTS[0];
    const CG = SLOTS[1];

    /** dB of the single-icon pool, computed independently of the builder. */
    function singlePoolDB(candidate: Uint8Array): number {
      const off = readIcon(DEC, CY.iconOffset);
      const D = (sum32(normalizeIcon(off, candidate)) - sum32(off)) >>> 0;
      return Math.floor(D / 65536);
    }

    /** A plain tile whose content area is filled with one grey level. */
    function filled(v: number): Uint8Array {
      const t = tileTemplate(DEC, 'plain');
      const c = CONTENT_AREA.plain;
      for (let y = c.y0; y <= c.y1; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
          const i = (y * ICON_W + x) * 4;
          t[i] = v;
          t[i + 1] = v;
          t[i + 2] = v;
        }
      }
      return t;
    }

    function opaqueEqual(a: Uint8Array, b: Uint8Array, layout: Uint8Array): boolean {
      for (let i = 0; i < ICON_BYTES; i += 4) {
        if (layout[i + 3] === 0) continue;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) return false;
      }
      return true;
    }

    it('icon facts: 232 transparent pixels, stored as 00 00 00 00 in the official Cinema icons', () => {
      for (const s of SLOTS) {
        const ic = readIcon(DEC, s.iconOffset);
        let transparent = 0;
        let zero = 0;
        for (let p = 0; p < 1600; p++) {
          const y = Math.floor(p / 40);
          const x = p % 40;
          const opaque = y >= 2 && y <= 37 && x >= 1 && x <= 38;
          expect(ic[p * 4 + 3]).toBe(opaque ? 255 : 0);
          if (!opaque) {
            transparent++;
            if (ic[p * 4] === 0 && ic[p * 4 + 1] === 0 && ic[p * 4 + 2] === 0) zero++;
          }
        }
        expect(transparent).toBe(POOL);
        expect(zero).toBe(POOL);
      }
    });

    it('small pool not sufficient: borrows the other icon\'s transparent pixels', async () => {
      let cand: Uint8Array | null = null;
      for (let v = 53; v < 256 && !cand; v++) if (singlePoolDB(filled(v)) > 255 * POOL) cand = filled(v);
      expect(cand).not.toBeNull();
      const r = await buildFirmware(official, [{ slot: 'CY', icon: cand! }]);
      expect(allTrue(r.checks)).toEqual([]);
      expect(r.ranges).toEqual([
        { what: 'CY icon', offset: CY.iconOffset, length: 6400 },
        { what: 'CG icon (transparent pixels only, checksum compensation)', offset: CG.iconOffset, length: 6400 },
      ]);
      const offCY = readIcon(DEC, CY.iconOffset);
      const offCG = readIcon(DEC, CG.iconOffset);
      const newCY = readIcon(r.decoded, CY.iconOffset);
      const newCG = readIcon(r.decoded, CG.iconOffset);
      expect(opaqueEqual(newCG, offCG, offCG)).toBe(true); // CG's opaque pixels unchanged
      expect(same(newCG, offCG)).toBe(false); // ...but its transparent pixels were used
      expect(opaqueEqual(newCY, cand!, offCY)).toBe(true);
      for (let i = 0; i < ICON_BYTES; i += 4) {
        expect(newCY[i + 3]).toBe(offCY[i + 3]);
        expect(newCG[i + 3]).toBe(offCG[i + 3]);
      }
      const sums = sectionSums(r.decoded);
      expect(sums).toEqual(sectionSums(DEC)); // includes ICONBIN
      expect(sum32(r.decoded.subarray(ICONBIN_OFFSET, ICONBIN_OFFSET + ICONBIN_LENGTH))).toBe(sum32(DEC.subarray(ICONBIN_OFFSET, ICONBIN_OFFSET + ICONBIN_LENGTH)));
      // only the two icons differ from the official payload
      const d = firstDiff(r.decoded, DEC);
      expect(d >= CY.iconOffset && d < CY.iconOffset + 6400).toBe(true);
      expect(same(r.decoded.subarray(0, CY.iconOffset), DEC.subarray(0, CY.iconOffset))).toBe(true);
      expect(same(r.decoded.subarray(CG.iconOffset + 6400), DEC.subarray(CG.iconOffset + 6400))).toBe(true);
      expect(same(r.decoded.subarray(CY.iconOffset + 6400, CG.iconOffset), DEC.subarray(CY.iconOffset + 6400, CG.iconOffset))).toBe(true);
    });

    it('small pool sufficient: the other icon is untouched', async () => {
      let cand: Uint8Array | null = null;
      for (let v = 53; v < 256 && !cand; v++) if (singlePoolDB(filled(v)) <= 255 * POOL) cand = filled(v);
      expect(cand).not.toBeNull();
      const r = await buildFirmware(official, [{ slot: 'CY', icon: cand! }]);
      expect(allTrue(r.checks)).toEqual([]);
      expect(r.ranges).toEqual([{ what: 'CY icon', offset: CY.iconOffset, length: 6400 }]);
      expect(same(readIcon(r.decoded, CG.iconOffset), readIcon(DEC, CG.iconOffset))).toBe(true);
      expect(opaqueEqual(readIcon(r.decoded, CY.iconOffset), cand!, readIcon(DEC, CY.iconOffset))).toBe(true);
      expect(sectionSums(r.decoded)).toEqual(sectionSums(DEC));
      expect(same(r.decoded.subarray(0, CY.iconOffset), DEC.subarray(0, CY.iconOffset))).toBe(true);
      expect(same(r.decoded.subarray(CY.iconOffset + 6400), DEC.subarray(CY.iconOffset + 6400))).toBe(true);
    });

    it('a CG-only icon works too, and a wrong-size icon is rejected', async () => {
      const r = await buildFirmware(official, [{ slot: 'CG', icon: iconC200 }]);
      expect(allTrue(r.checks)).toEqual([]);
      expect(opaqueEqual(readIcon(r.decoded, CG.iconOffset), iconC200, readIcon(DEC, CG.iconOffset))).toBe(true);
      expect(opaqueEqual(readIcon(r.decoded, CY.iconOffset), readIcon(DEC, CY.iconOffset), readIcon(DEC, CY.iconOffset))).toBe(true);
      await expect(buildFirmware(official, [{ slot: 'CG', icon: new Uint8Array(100) }])).rejects.toMatchObject({ code: 'bad-icon' });
    });
  });

  // ---------------------------------------------------------------- 7
  describe('7. self-check catches tampering', () => {
    let A: BuildResult;
    beforeAll(async () => {
      A = await buildFirmware(official, [{ slot: 'CY', color: { matrixQ13: q400.matrix } }]);
    });

    it('accepts the builder\'s own output and the official file itself', () => {
      expect(allTrue(selfCheck(official, A.file, A.ranges, A.decoded))).toEqual([]);
      expect(allTrue(selfCheck(official, A.file, A.ranges))).toEqual([]);
      expect(allTrue(selfCheck(official, official, []))).toEqual([]);
    });

    it('a decoded byte changed outside the planned ranges', () => {
      // +1 / -1 on the same byte lane of two words keeps every word sum, so only the
      // "inside planned ranges" check can notice.
      const t = A.decoded.slice();
      const o = RTOS_OFFSET + 0x800000;
      expect(t[o]).toBeLessThan(255);
      expect(t[o + 4]).toBeGreaterThan(0);
      t[o] += 1;
      t[o + 4] -= 1;
      expect(sum32(t)).toBe(0);
      const { out } = build(fw, t);
      const c = selfCheck(official, out, A.ranges);
      expect(allTrue(c)).toEqual(['changes_inside_planned_ranges']);
      // with the intended payload given, that mismatch is reported as well
      expect(allTrue(selfCheck(official, out, A.ranges, A.decoded)).sort()).toEqual(['changes_inside_planned_ranges', 'decoded_equals_intended']);
      // and the same file passes once the two bytes are declared
      expect(allTrue(selfCheck(official, out, [...A.ranges, { what: 'tamper', offset: o, length: 5 }]))).toEqual([]);
    });

    it('a changed frame stored with a partial length', () => {
      // Re-store frames i and i+1 (2 x 0x6000 decoded bytes) as stored frames of 0x5000 + 0x7000:
      // same frame count, same decoded payload, valid for the updater, but not the proven form.
      const p = parseFrames(A.file, A.decoded.length);
      const i = A.changedFrames[0];
      const f0 = p.frames[i];
      const f1 = p.frames[i + 1];
      expect(f0.stored && f0.outLen === 0x6000 && f1.outLen === 0x6000).toBe(true);
      const head = A.file.subarray(0x80, f0.start);
      const tail = A.file.subarray(f1.end, p.streamEnd); // includes the 00 00 terminator
      const stream = new Uint8Array(head.length + 2 + 0x5000 + 2 + 0x7000 + tail.length);
      let q = 0;
      stream.set(head, q);
      q += head.length;
      stream.set([0xd0, 0x00], q);
      stream.set(A.decoded.subarray(f0.outStart, f0.outStart + 0x5000), q + 2);
      q += 2 + 0x5000;
      stream.set([0xf0, 0x00], q);
      stream.set(A.decoded.subarray(f0.outStart + 0x5000, f0.outStart + 0xc000), q + 2);
      q += 2 + 0x7000;
      stream.set(tail, q);
      const file = wrapStream(fw, stream, A.decoded.length);
      const v = verifyContainer(file, A.decoded);
      expect(allTrue(v.checks)).toEqual([]); // the updater's checks alone would accept it
      const c = selfCheck(official, file, A.ranges, A.decoded);
      expect(c.frames_identical_or_stored_full).toBe(false);
      expect(c.frame_layout_unchanged).toBe(false);
      expect(allTrue(c).sort()).toEqual(['frame_layout_unchanged', 'frames_identical_or_stored_full']);
    });

    it('a modified header byte', () => {
      const t = A.file.slice();
      t[0x10] ^= 0x01;
      const dv = new DataView(t.buffer);
      dv.setUint32(t.length - 4, (-sum32(t.subarray(0, t.length - 4))) >>> 0, true);
      expect(allTrue(verifyContainer(t).checks)).toEqual([]);
      expect(allTrue(selfCheck(official, t, A.ranges, A.decoded))).toEqual(['header_identical']);
    });

    it('a modified model record, a broken checksum, and garbage', () => {
      const t = A.file.slice();
      t[t.length - 0x18 - 0x80 + 0x20] ^= 0x01; // inside the last model record
      const dv = new DataView(t.buffer);
      dv.setUint32(t.length - 4, (-sum32(t.subarray(0, t.length - 4))) >>> 0, true);
      expect(allTrue(selfCheck(official, t, A.ranges, A.decoded))).toEqual(['model_records_identical']);

      const u = A.file.slice();
      u[u.length - 1] ^= 0x80;
      expect(allTrue(selfCheck(official, u, A.ranges, A.decoded))).toEqual(['updater_file_sum_zero']);

      const g = selfCheck(official, new Uint8Array(64), A.ranges);
      expect(g.completed).toBe(false);
      expect(Object.values(g).every((x) => x === false)).toBe(true);
    });
  });

  // ---------------------------------------------------------------- 8
  describe('8. icon helpers', () => {
    const at = (icon: Uint8Array, x: number, y: number): number[] => Array.from(icon.subarray((y * ICON_W + x) * 4, (y * ICON_W + x) * 4 + 4));

    it('tileTemplate plain: official alpha layout, one-pixel 128 ring, 53/53/54 inside', () => {
      const t = tileTemplate(DEC, 'plain');
      const off = readIcon(DEC, SLOTS[0].iconOffset);
      expect(t.length).toBe(ICON_BYTES);
      for (let y = 0; y < ICON_H; y++) {
        for (let x = 0; x < ICON_W; x++) {
          const px = at(t, x, y);
          const opaque = y >= 2 && y <= 37 && x >= 1 && x <= 38;
          const ring = opaque && (y === 2 || y === 37 || x === 1 || x === 38);
          expect(px).toEqual(!opaque ? [255, 255, 255, 0] : ring ? [128, 128, 128, 255] : [53, 53, 54, 255]);
          expect(px[3]).toBe(off[(y * ICON_W + x) * 4 + 3]);
          // the official icon has exactly this ring and nothing but background next to it
          if (ring) expect(at(off, x, y)).toEqual([128, 128, 128, 255]);
        }
      }
      for (let x = 2; x <= 37; x++) for (const y of [3, 36]) expect(at(off, x, y)).toEqual([53, 53, 54, 255]);
      for (let y = 3; y <= 36; y++) for (const x of [2, 37]) expect(at(off, x, y)).toEqual([53, 53, 54, 255]);
    });

    it('tileTemplate film: Nega frame with the lettering cleared, sprocket rows kept', () => {
      const t = tileTemplate(DEC, 'film');
      const plain = tileTemplate(DEC, 'plain');
      const c = CONTENT_AREA.film;
      let white = 0;
      for (let y = 0; y < ICON_H; y++) {
        for (let x = 0; x < ICON_W; x++) {
          const px = at(t, x, y);
          expect(px[3]).toBe(at(plain, x, y)[3]);
          if (y >= c.y0 && y <= c.y1 && x >= c.x0 && x <= c.x1) expect(px).toEqual([53, 53, 54, 255]);
          else if (px[3] === 255 && px[0] === 255) white++;
          if (px[3] === 0) expect(px).toEqual([255, 255, 255, 0]);
        }
      }
      expect(white).toBe(2 * 5 * 9); // two rows of five 3x3 sprocket holes
      // outside the sprocket rows it is the plain tile
      for (let y = 0; y < ICON_H; y++) {
        if ((y >= 5 && y <= 7) || (y >= 32 && y <= 34)) continue;
        for (let x = 0; x < ICON_W; x++) expect(at(t, x, y)).toEqual(at(plain, x, y));
      }
    });

    it('composeIcon', () => {
      for (const style of ['plain', 'film'] as const) {
        const tile = tileTemplate(DEC, style);
        expect(same(composeIcon(tile, new Float32Array(1600)), tile)).toBe(true);
        const cov = new Float32Array(1600);
        const c = CONTENT_AREA[style];
        for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) cov[y * ICON_W + x] = 1;
        const full = composeIcon(tile, cov);
        for (let y = 0; y < ICON_H; y++) {
          for (let x = 0; x < ICON_W; x++) {
            const inside = y >= c.y0 && y <= c.y1 && x >= c.x0 && x <= c.x1;
            expect(at(full, x, y)).toEqual(inside ? [255, 255, 255, 255] : at(tile, x, y));
          }
        }
      }
      // round half to even: 53 + 0.5 * 202 = 154 exactly; 54 + 0.5 * 201 = 154.5 -> 154; 0.25 -> 103.5 -> 104, 104.25 -> 104
      const tile = tileTemplate(DEC, 'plain');
      const cov = new Float32Array(1600);
      cov[10 * ICON_W + 10] = 0.5;
      cov[10 * ICON_W + 11] = 0.25;
      cov.fill(1, 0, 40); // transparent row stays transparent
      const out = composeIcon(tile, cov);
      expect(at(out, 10, 10)).toEqual([154, 154, 154, 255]);
      expect(at(out, 11, 10)).toEqual([104, 104, 104, 255]);
      expect(at(out, 5, 0)).toEqual([255, 255, 255, 0]);
    });

    it('normalizeIcon keeps the official alpha layout', () => {
      const off = readIcon(DEC, SLOTS[0].iconOffset);
      const cand = new Uint8Array(ICON_BYTES);
      for (let p = 0; p < 1600; p++) cand.set([200, 100, 50, p % 2 === 0 ? 255 : 0], p * 4);
      cand.set([255, 255, 255, 128], (20 * ICON_W + 21) * 4); // half-transparent white
      const n = normalizeIcon(off, cand);
      for (let p = 0; p < 1600; p++) {
        const px = Array.from(n.subarray(p * 4, p * 4 + 4));
        if (off[p * 4 + 3] === 0) expect(px).toEqual([255, 255, 255, 0]);
        else if (p === 20 * ICON_W + 21) expect(px).toEqual([154, 154, 155, 255]);
        else expect(px).toEqual(p % 2 === 0 ? [200, 100, 50, 255] : [53, 53, 54, 255]);
      }
      // the icons used for variant C are already normal
      expect(same(normalizeIcon(off, icon400), icon400)).toBe(true);
      expect(same(normalizeIcon(off, iconC200), iconC200)).toBe(true);
      expect(() => normalizeIcon(off, new Uint8Array(10))).toThrowError(FirmwareError);
    });

    it('the film tile reproduces the background of the variant C icons', () => {
      // icon_400 was drawn on this tile: outside the content area it must be the tile itself.
      const tile = tileTemplate(DEC, 'film');
      const c = CONTENT_AREA.film;
      for (let y = 0; y < ICON_H; y++) {
        for (let x = 0; x < ICON_W; x++) {
          if (y >= c.y0 && y <= c.y1 && x >= c.x0 && x <= c.x1) continue;
          expect(at(icon400, x, y)).toEqual(at(tile, x, y));
          expect(at(iconC200, x, y)).toEqual(at(tile, x, y));
        }
      }
    });
  });
});
