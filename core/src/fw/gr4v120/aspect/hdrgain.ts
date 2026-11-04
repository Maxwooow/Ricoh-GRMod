// SPDX-License-Identifier: GPL-2.0-only
/**
 * HDR gain map in the camera's JPEGs (firmware 1.20: the port of the 1.11 code; test builds).
 *
 * The file the camera writes stays as it is: the camera's header (SOI, APP1 Exif with the
 * thumbnail, APP7 "RICOH" with the screennail and maker note) and its main stream come first,
 * byte for byte. Between them go an XMP segment (Google's container: primary and gain map, with
 * hdrgm:Version, as Android's Ultra HDR), the ISO 21496-1 version segment and an MPF index; after
 * the main stream follows the gain map, a greyscale JPEG of a quarter of the picture's size with
 * its own XMP (hdrgm parameters) and ISO 21496-1 metadata. libultrahdr writes the same two kinds of
 * metadata; phones (Android 14+, iOS 18+), browsers and Lightroom show the picture brighter in the
 * highlights on an HDR screen, everything else shows the camera's picture.
 *
 * The gain map is made from the finished picture alone (no RAW data): the average Y of 4 x 4
 * pixels, through `HDR_GAIN.code`, says by how much a place is lifted: nothing below the
 * highlights' start, up to `HDR_GAIN.stops` stops at white. Highlights that the picture has
 * clipped come out brighter, without detail.
 *
 * Where:
 *  - JpegEncodeMacroProcess::Execute (0x53727E10) is wrapped: after the encoder has run (the
 *    function waits for it), the module of `tools/gr4v120/hdrgain/hdrgain.c` finds the main stream among
 *    the configuration's output descriptors (+0x4C, +0x58, +0x50, +0x54: the one that starts with
 *    DQT and whose SOF has the size of one of the pictures at +0x3C..+0x48), takes a fingerprint of
 *    16 KB of it, makes and encodes the gain map from that picture's Y plane, and keeps it on the
 *    heap under the fingerprint (8 kept, the oldest one no writer uses is given up).
 *  - ExifJpegWriter (vtable 0x53FDDE18, one class) writes a JPEG as blocks {file offset, address,
 *    length} through GetWriteBlockCount (slot 10, 0x5383287C, always 2) and GetWriteBlockInfo
 *    (slot 9, 0x53832884, this + 0x54 + 12 i): the camera's header, then its main stream. Both
 *    slots point at stubs: when the writer's main stream has the fingerprint of a kept gain map,
 *    the file is four blocks (header, our segments, main stream, gain map; the MPF offsets are
 *    filled in for these lengths), else the camera's two. The same holds for a file the camera
 *    writes again (Rewrite builds the same two blocks).
 *
 * The state (kept gain maps, the writers last seen, diagnostics) is allocated on the heap when the
 * first picture is encoded; its address is kept in HDR_STATE_WORD, one of the zero-filled words
 * before the heap. Test builds (`diag`) add an APP15 "GRMODHDR" segment with the module's counters
 * to every JPEG whose blocks look as expected; and (diagnostics version 2) the stubs count their
 * calls in the two zero-filled words HDR_COUNTERS (Execute entries | returns << 16, block counts |
 * block infos << 16), the block count makes the state when the encode step did not, and a file
 * written as the camera's two blocks gets a third after the camera's EOI ("GRMODHDT" and the
 * counters; tools/gr4v120/hdrgain/readdiag.py reads both).
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget } from './arm';
import { Patch, expectWord, u16le, u32le } from './build';
import { HDRGAIN_CODE, HDRGAIN_CODE_LENGTH } from './hdrgain-code';
import { JPEG_EXECUTE } from './datestamp';

/** The look of the gain map. */
export const HDR_GAIN = {
  /** Most the highlights are lifted (stops; also the HDR headroom the file asks for). */
  stops: 2,
  /** Linear light (0..1, of the picture's sRGB value) where the lift starts; it rises smoothly to `stops` at white. */
  start: 0.35,
  /** JPEG quality of the gain map. */
  quality: 85,
};

/** ExifJpegWriter's vtable and the two slots. */
export const WRITER_VTABLE = 0x53fdde18;
const SLOT_INFO = WRITER_VTABLE + 9 * 4;
const SLOT_COUNT = WRITER_VTABLE + 10 * 4;
const GET_BLOCK_INFO = 0x53832884;
const GET_BLOCK_COUNT = 0x5383287c;
/** Clean and invalidate data cache lines (64 bytes) to the point of coherency: (address, length). */
const CACHE_CLEAN_INVALIDATE = 0x53000930;
const HEAP_ALLOC = 0x539084bc;
const HEAP_FREE = 0x539084f8;
/** The module's state pointer: the last of the zero-filled words before the heap (see lookstash.ts). */
export const HDR_STATE_WORD = 0x5583901c;
const ZERO_FILL_END = 0x53000460;
/** Test builds: two zero-filled words before the heap the stubs count their calls in (the zero fill's old end). */
export const HDR_COUNTERS = 0x55839014;

const OP_POST = 1;
const OP_COUNT = 2;
const OP_INFO = 3;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (v: number): number[] => [(v >>> 8) & 255, v & 255];
const be32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const segment = (marker: number, payload: number[]): number[] => [0xff, marker, ...be16(payload.length + 2), ...payload];

const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const ISO_NS = 'urn:iso:std:iso:ts:21496:-1\0';

/** Natural index of the k-th coefficient in zigzag order. */
export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
/** The JPEG standard's luminance quantisers (natural order). */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** Quantisers (natural order) for `quality`, as libjpeg scales them. */
export function quantTable(quality: number = HDR_GAIN.quality): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q;
  return STD_LUMA.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** Huffman codes of a table: index = symbol, value = code | length << 16. */
export function huffCodes(bits: readonly number[], vals: readonly number[], size: number): number[] {
  const out = new Array<number>(size).fill(0);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) out[vals[k++]] = code++ | (len << 16);
    code <<= 1;
  }
  return out;
}

const srgbLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Gain map value (0..255 = 0..stops) for an average Y of 0..255. */
export function gainCodes(start = HDR_GAIN.start): Uint8Array {
  const out = new Uint8Array(256);
  for (let y = 0; y < 256; y++) {
    const t = Math.min(1, Math.max(0, (srgbLinear(y / 255) - start) / (1 - start)));
    out[y] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return out;
}

/** Decimal text of a number for XMP (at most 6 decimals, no trailing zeros). */
function num(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}

/** The gain map's XMP: hdrgm parameters (Adobe's gain map namespace, as Ultra HDR reads it). */
function gainMapXmp(stops: number): string {
  return '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="GR Mod"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" '
    + `hdrgm:GainMapMin="0" hdrgm:GainMapMax="${num(stops)}" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" `
    + `hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="${num(stops)}" hdrgm:BaseRenditionIsHDR="False"/></rdf:RDF></x:xmpmeta>`;
}

/** The primary picture's XMP, split where the gain map's length goes. */
function primaryXmp(): [string, string] {
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="GR Mod"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" '
    + 'xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0">'
    + '<Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>'
    + '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="',
    '"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>',
  ];
}

/** ISO 21496-1 gain map metadata (version 0, one channel, fractions as libultrahdr writes them). */
export function isoMetadata(stops: number): number[] {
  const n = Math.round(stops * 1000);
  const s32 = (v: number): number[] => be32(v >>> 0);
  return [
    ...be16(0), ...be16(0), 0,
    ...be32(0), ...be32(1), ...be32(n), ...be32(1000), // base / alternate HDR headroom (log2)
    ...s32(0), ...be32(1), ...s32(n), ...be32(1000), // gain map min / max (log2)
    ...be32(1), ...be32(1), // gamma
    ...s32(1), ...be32(64), ...s32(1), ...be32(64), // base / alternate offset
  ];
}

export interface HdrTables {
  code: Uint8Array;
  recip: number[];
  half: number[];
  dc: number[];
  ac: number[];
  /** The gain map's JPEG from SOI to the end of SOS; `sof` = offset of SOF's height. */
  head: Uint8Array;
  sof: number;
  xmpPre: Uint8Array;
  xmpPost: Uint8Array;
  iso: Uint8Array;
}

/** Everything the module reads (also used by the emulator check's reference encoder). */
export function hdrTables(stops = HDR_GAIN.stops, start = HDR_GAIN.start, quality = HDR_GAIN.quality): HdrTables {
  if (!(stops > 0 && stops <= 4) || !(start >= 0 && start < 1)) fail('internal', 'HDR gain map: parameters');
  const q = quantTable(quality);
  const d = q.map((v) => v * 8);
  const head: number[] = [0xff, 0xd8];
  head.push(...segment(0xe1, [...ascii(XMP_NS), ...ascii(gainMapXmp(stops))]));
  head.push(...segment(0xe2, [...ascii(ISO_NS), ...isoMetadata(stops)]));
  head.push(...segment(0xdb, [0, ...ZIGZAG.map((i) => q[i])]));
  const sof = head.length + 5;
  head.push(...segment(0xc0, [8, 0, 0, 0, 0, 1, 1, 0x11, 0]));
  head.push(...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALS]));
  head.push(...segment(0xc4, [0x10, ...AC_BITS, ...AC_VALS]));
  head.push(...segment(0xda, [1, 1, 0x00, 0, 63, 0]));
  const [pre, post] = primaryXmp();
  return {
    code: gainCodes(start),
    recip: d.map((v) => Math.floor((2 ** 20 + Math.floor(v / 2)) / v)),
    half: d.map((v) => Math.floor(v / 2)),
    dc: huffCodes(DC_BITS, DC_VALS, 12),
    ac: huffCodes(AC_BITS, AC_VALS, 256),
    head: Uint8Array.from(head),
    sof,
    xmpPre: Uint8Array.from(ascii(XMP_NS + pre)),
    xmpPost: Uint8Array.from(ascii(post)),
    iso: Uint8Array.from(segment(0xe2, [...ascii(ISO_NS), 0, 0, 0, 0])),
  };
}

function hdrModule(): Uint8Array {
  const raw = Uint8Array.from(atob(HDRGAIN_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== HDRGAIN_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'HDR gain map module length');
  return raw;
}

/** Marks the context ('HDR1') so that a built file can be told apart. */
export const HDR_CTX_MAGIC = 0x31524448;

/**
 * Install the gain map. After the date imprint and halation (it wraps the JPEG step they hook at
 * its entry, so it runs after them and after the encoder). `diag`: test builds, the APP15
 * diagnostics segment. Returns the module's address.
 */
export function installHdrGainMap(patch: Patch, diag = false): number {
  expectWord(patch, SLOT_INFO, GET_BLOCK_INFO);
  expectWord(patch, SLOT_COUNT, GET_BLOCK_COUNT);
  expectWord(patch, GET_BLOCK_COUNT, 0xe3a00002); // mov r0, #2
  expectWord(patch, GET_BLOCK_INFO, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, CACHE_CLEAN_INVALIDATE, 0xe92d4070); // push {r4, r5, r6, lr}
  expectWord(patch, CACHE_CLEAN_INVALIDATE + 0x14, 0xee074f3e); // mcr p15, 0, r4, c7, c14, 1
  expectWord(patch, HEAP_ALLOC, 0xe1a0c00d);
  expectWord(patch, HEAP_FREE, 0xe1a0c00d);
  if (patch.word(ZERO_FILL_END) !== 0x55839040) {
    expectWord(patch, ZERO_FILL_END, 0x55839014);
    patch.setWord(ZERO_FILL_END, 0x55839040, 'start-up zero fill also clears the 44 unused bytes before the heap');
  }
  const first = patch.word(JPEG_EXECUTE);
  let tail: string;
  if (first === 0xe1a0c00d) tail = `mov ip,sp;b #${JPEG_EXECUTE + 4}`;
  else if (first >>> 24 === 0xea) tail = `b #${branchTarget(JPEG_EXECUTE, first)}`;
  else fail('unexpected-layout', 'HDR gain map: unexpected JPEG encode entry');

  const t = hdrTables();
  const at = (b: Uint8Array): number => patch.append(b, 4);
  const code = at(t.code);
  const zig = at(Uint8Array.from(ZIGZAG));
  const recip = at(u32le(t.recip));
  const half = at(u16le(t.half));
  const dc = at(u32le(t.dc));
  const ac = at(u32le(t.ac));
  const head = at(t.head);
  const pre = at(t.xmpPre);
  const post = at(t.xmpPost);
  const iso = at(t.iso);
  const ctx = patch.append(u32le([
    CACHE_CLEAN_INVALIDATE, HEAP_ALLOC, HEAP_FREE, HDR_STATE_WORD, code, zig, recip, half, dc, ac,
    head, t.head.length, t.sof, pre, t.xmpPre.length, post, t.xmpPost.length, iso, t.iso.length, diag ? 1 : 0,
    HDR_CTX_MAGIC, diag ? HDR_COUNTERS : 0,
  ]), 16);
  const mod = patch.append(hdrModule(), 16);
  const lo = (v: number): number => v & 0xffff;
  const hi = (v: number): number => v >>> 16;
  // After the encoder: Execute runs (with the stubs before it) and returns here.
  const tramp = patch.append((a) => assembleWords(tail, a), 16);
  // Test builds count in HDR_COUNTERS: Execute entries and returns, block counts and infos.
  const cnt = (reg: string, offset: number, add: number): string => diag
    ? `movw r4, #${lo(HDR_COUNTERS)}; movt r4, #${hi(HDR_COUNTERS)}
       ldr ${reg}, [r4, #${offset}]; add ${reg}, ${reg}, #${add}; str ${reg}, [r4, #${offset}]`
    : '';
  const wrap = patch.append((a) => assembleWords(
    `push {r0, r1, r4, lr}
     ${cnt('ip', 0, 1)}
     bl #${tramp}
     ${cnt('r2', 0, 0x10000)}
     str r0, [sp]
     ldr r2, [sp, #4]
     ldr r2, [r2, #8]
     movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}
     mov r1, #${OP_POST}
     bl #${mod}
     pop {r0, r1, r4, pc}`, a), 16);
  const countStub = patch.append((a) => assembleWords(
    `push {r4, lr}
     ${cnt('r1', 4, 1)}
     mov r2, r0
     movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}
     mov r1, #${OP_COUNT}
     bl #${mod}
     pop {r4, pc}`, a), 16);
  const infoStub = patch.append((a) => assembleWords(
    `push {r0, r1, r4, lr}
     ${cnt('ip', 4, 0x10000)}
     mov r3, r1
     mov r2, r0
     movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}
     mov r1, #${OP_INFO}
     bl #${mod}
     cmp r0, #0
     bne ours
     pop {r0, r1, r4, lr}
     b #${GET_BLOCK_INFO}
     ours: add sp, sp, #8
     pop {r4, pc}`, a), 16);
  patch.setWord(JPEG_EXECUTE, (0xea000000 | (((wrap - (JPEG_EXECUTE + 8)) >> 2) & 0xffffff)) >>> 0, 'HDR gain map after the JPEG encode step');
  patch.setWord(SLOT_COUNT, countStub, 'HDR gain map: JPEG writer block count');
  patch.setWord(SLOT_INFO, infoStub, 'HDR gain map: JPEG writer blocks');
  return mod;
}

/** Whether a build has the gain map (the writer's block count is a stub). */
export function hdrGainMapInstalled(patch: Patch): boolean {
  return patch.word(SLOT_COUNT) !== GET_BLOCK_COUNT;
}
