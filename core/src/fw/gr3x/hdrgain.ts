// SPDX-License-Identifier: GPL-2.0-only
/**
 * HDR gain map in every JPEG for GR III 2.10 / IIIx 1.60 (as GR IV's, ../gr4v120/aspect/hdrgain.ts):
 * the camera's file stays as it is, byte for byte; between its header and its main stream go an XMP
 * segment (Google's container, hdrgm), the ISO 21496-1 version segment and an MPF index, and after
 * the main stream a greyscale JPEG of a quarter of the picture's size, the gain map, with its own
 * XMP and ISO 21496-1 metadata. Phones (Android 14+, iOS 18+), browsers and Lightroom show the
 * highlights brighter on an HDR screen; everything else shows the camera's picture.
 *
 * The module is GR IV's (tools/gr4v120/hdrgain/hdrgain.c, compiled by its gen.py into
 * ../gr4v120/aspect/hdrgain-code.ts): position independent, no global data, every firmware address
 * in its context. It is used unchanged with a GR III context. What it relies on is the same code in
 * both cameras (tools/gr3extras/hdr_check.py runs it with GR III's own code):
 *
 *  - JpegEncodeMacroProcess::Execute, GR III 0x535047D4 (GR IV 1.20 0x53727E10): the same body
 *    instruction for instruction up to call targets, apart from four offsets of the process
 *    object itself (+0x34 / +0x9FC.. on GR III, +0x38 / +0xA00.. on GR IV); the configuration
 *    [r1+8] is read at the same offsets (pictures +0x3C..+0x48, output descriptors +0x4C..+0x58),
 *    the encoder is waited for and the outputs are made coherent before it returns. Its only
 *    reference is slot 10 of its vtable, 0x53C629E8 + 0x28 = 0x53C62A10 (no direct calls; GR IV
 *    likewise has one, 0x53F066B0).
 *  - ExifJpegWriter, vtable 0x53D31258 (GR IV 0x53FDDE18): all 11 methods equal to GR IV's
 *    instruction for instruction. Slot 10 GetWriteBlockCount 0x53603514 `mov r0,#2; bx lr`, slot
 *    9 GetWriteBlockInfo 0x5360351C (this + 0x54 + 12 i); each slot word is the only reference to
 *    its function. The generic write that calls them, 0x535FC588 (GR IV 0x5382B814), and the
 *    write in pieces, 0x535FC724 (GR IV 0x5382B9B0), are equal too, and so is the function that
 *    lays out the header and stream blocks (0x535FB598, GR IV 0x5382A824: only the line numbers
 *    of its assertions differ).
 *  - Cache clean and invalidate by address 0x53000930 (the same address and code in both),
 *    operator new 0x536AF2A8 / delete 0x536AF2E4 (GR IV 0x539084BC / 0x539084F8, equal).
 *  - Its state pointer: round 10's free RAM word 0x55804390 (zero-filled at every start).
 *
 * The hooks:
 *  - GR III runs its own picture modules (halation, date imprint) in a chain at Execute's entry,
 *    before the encoder (jpeg-stage.ts, datestamp.ts); the image-control layer re-points that
 *    entry after the date imprint is installed. The gain map needs the encoded stream, so it is
 *    not one more link of that chain: Execute's vtable slot points at a wrapper that calls
 *    Execute's entry (whatever chain is there), keeps its return value, and then gives the
 *    configuration to the module (OP_POST). Where GR IV patches Execute's first word, GR III
 *    patches the only pointer to it; the chain at the entry is untouched.
 *  - The writer's slots 10 and 9 point at GR IV's two stubs (OP_COUNT, OP_INFO).
 *  - The header the writer gets must be SOI and APPn segments that end where the stream starts,
 *    or 2 bytes after it with the stream starting with SOI (GR IV test 073: the camera's APP7 ends
 *    with the stream's SOI). The module checks this for every file (header_ok in hdrgain.c) and
 *    otherwise lets the camera write its own two blocks: a GR III header that differs costs the
 *    gain map, not the photo. GR III's header layout has not been seen on a GR III JPEG.
 *
 * On / Off: `offBit` (later, the menu's settings byte) is the one place: the wrapper reads that
 * byte after Execute and skips the module when the bit is set (0 = On, as GR IV's 0x10A bit 0, so
 * that settings that never had the byte mean On). Off, no gain map is kept and the writer writes
 * the camera's two blocks. Without `offBit` the gain map is always on.
 */
import { wordsToBytes } from '../aspect/arm';
import { HDR_CTX_MAGIC, ZIGZAG, hdrTables } from '../gr4v120/aspect/hdrgain';
import { HDRGAIN_CODE, HDRGAIN_CODE_LENGTH } from '../gr4v120/aspect/hdrgain-code';
import { FirmwareError } from '../types';
import { GR3X_JPEG_EXECUTE } from './jpeg-stage';
import { adr } from './target';

/** JpegEncodeMacroProcess's vtable slot 10: the only pointer to Execute. */
export const GR3X_EXECUTE_SLOT = adr(0x53c629e8) + 0x28;
/** ExifJpegWriter's vtable and its slots 9 and 10. */
export const GR3X_WRITER_VTABLE = adr(0x53d31258);
const SLOT_INFO = GR3X_WRITER_VTABLE + 9 * 4;
const SLOT_COUNT = GR3X_WRITER_VTABLE + 10 * 4;
const GET_BLOCK_INFO = adr(0x5360351c);
const GET_BLOCK_COUNT = adr(0x53603514);
const CACHE_CLEAN_INVALIDATE = adr(0x53000930);
const HEAP_ALLOC = adr(0x536af2a8);
const HEAP_FREE = adr(0x536af2e4);
/** The module's state pointer (round 10's free words, round10.ts). */
export const GR3X_HDR_STATE_WORD = adr(0x55804390);

const OP_POST = 1;
const OP_COUNT = 2;
const OP_INFO = 3;

export interface Gr3xHdrProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}
export interface Gr3xHdrOptions {
  /** The menu's switch: a settings byte and the bit that means Off. Absent: always on. */
  offBit?: { byte: number; bit: number };
}

const fail = (what: string): never => { throw new FirmwareError('unexpected-instruction', `IIIx HDR gain map: ${what}`); };
const u32le = (v: readonly number[]) => wordsToBytes(v.map(x => x >>> 0));
const u16le = (v: readonly number[]) => { const b = new Uint8Array(v.length * 2), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint16(i * 2, x, true)); return b; };
const addr = (r: string, a: number) => `movw ${r},#${a & 0xffff};movt ${r},#${a >>> 16};`;

/** Install the gain map. Any time after round 10's scaffold (the order with the picture modules
 * does not matter: they stay at Execute's entry). Returns the entries. */
export function installGr3xHdrGainMap(p: Gr3xHdrProgram, o: Gr3xHdrOptions = {}): Record<string, number> {
  const guards: readonly (readonly [number, number, string])[] = [
    [GR3X_EXECUTE_SLOT, GR3X_JPEG_EXECUTE, 'Execute\'s vtable slot'],
    [GR3X_JPEG_EXECUTE + 4, 0xe92ddff0, 'Execute\'s frame'], // push {r4-r12, lr, pc}
    [GR3X_JPEG_EXECUTE + 0x18, 0xe5914008, 'Execute\'s configuration'], // ldr r4, [r1, #8]
    [SLOT_INFO, GET_BLOCK_INFO, 'writer slot 9'], [SLOT_COUNT, GET_BLOCK_COUNT, 'writer slot 10'],
    [GET_BLOCK_COUNT, 0xe3a00002, 'block count'], [GET_BLOCK_COUNT + 4, 0xe12fff1e, 'block count'], // mov r0,#2; bx lr
    [GET_BLOCK_INFO, 0xe1a0c00d, 'block info'], // mov ip, sp
    [CACHE_CLEAN_INVALIDATE, 0xe92d4070, 'cache'], [CACHE_CLEAN_INVALIDATE + 0x14, 0xee074f3e, 'cache'], // push {r4-r6,lr}; mcr p15,0,r4,c7,c14,1
    [HEAP_ALLOC, 0xe1a0c00d, 'operator new'], [HEAP_FREE, 0xe1a0c00d, 'operator delete'],
  ];
  for (const [at, w, what] of guards) if (p.word(at) !== w >>> 0) fail(`${what} at ${at.toString(16)}`);
  // Execute's entry: the camera's first word or a branch (the picture modules' chain).
  const entry = p.word(GR3X_JPEG_EXECUTE);
  if (entry !== 0xe1a0c00d && entry >>> 24 !== 0xea) fail('Execute\'s entry');
  if (o.offBit && !(o.offBit.bit >= 0 && o.offBit.bit < 8)) throw new FirmwareError('internal', 'IIIx HDR gain map: switch bit');

  const raw = Uint8Array.from(atob(HDRGAIN_CODE), c => c.charCodeAt(0));
  if (raw.length !== HDRGAIN_CODE_LENGTH || raw.length % 4) throw new FirmwareError('internal', 'IIIx HDR gain map: module length');
  const t = hdrTables();
  const code = p.append(t.code), zig = p.append(Uint8Array.from(ZIGZAG)), recip = p.append(u32le(t.recip)), half = p.append(u16le(t.half));
  const dc = p.append(u32le(t.dc)), ac = p.append(u32le(t.ac)), head = p.append(t.head), pre = p.append(t.xmpPre), post = p.append(t.xmpPost), iso = p.append(t.iso);
  // The context, word for word as GR IV's (struct ctx in hdrgain.c); no diagnostics, no counters.
  const ctx = p.append(u32le([
    CACHE_CLEAN_INVALIDATE, HEAP_ALLOC, HEAP_FREE, GR3X_HDR_STATE_WORD, code, zig, recip, half, dc, ac,
    head, t.head.length, t.sof, pre, t.xmpPre.length, post, t.xmpPost.length, iso, t.iso.length, 0,
    HDR_CTX_MAGIC, 0,
  ]));
  const module = p.append(raw);
  // The switch, when there is one: the only place that reads it.
  const off = o.offBit ? `${addr('r2', o.offBit.byte)}ldrb r2,[r2];tst r2,#${1 << o.offBit.bit};bne off;` : '';
  // Execute (r0 = process, r1 = message, configuration [r1+8]), then the module. r0 (Execute's
  // result) is given back; r1 too (as GR IV's wrapper), r2, r3, ip are scratch.
  const wrap = p.code(`push {r0,r1,r4,lr};bl #${GR3X_JPEG_EXECUTE};str r0,[sp];${off}
    ldr r2,[sp,#4];ldr r2,[r2,#8];${addr('r0', ctx)}mov r1,#${OP_POST};bl #${module};
    off:pop {r0,r1,r4,pc};`);
  const count = p.code(`push {r4,lr};mov r2,r0;${addr('r0', ctx)}mov r1,#${OP_COUNT};bl #${module};pop {r4,pc};`);
  const info = p.code(`push {r0,r1,r4,lr};mov r3,r1;mov r2,r0;${addr('r0', ctx)}mov r1,#${OP_INFO};bl #${module};
    cmp r0,#0;bne ours;pop {r0,r1,r4,lr};b #${GET_BLOCK_INFO};
    ours:add sp,sp,#8;pop {r4,pc};`);
  p.patch(GR3X_EXECUTE_SLOT, GR3X_JPEG_EXECUTE, wrap, 'HDR gain map: after the JPEG encode step');
  p.patch(SLOT_COUNT, GET_BLOCK_COUNT, count, 'HDR gain map: JPEG writer block count');
  p.patch(SLOT_INFO, GET_BLOCK_INFO, info, 'HDR gain map: JPEG writer blocks');
  return { hdrWrap: wrap, hdrCount: count, hdrInfo: info, hdrModule: module, hdrContext: ctx };
}
