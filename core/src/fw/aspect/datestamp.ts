// SPDX-License-Identifier: GPL-2.0-only
/**
 * Date imprint (firmware 1.11): the shooting date drawn into the JPEG, bottom right, as a
 * seven-segment "'YY MM DD" like the date back of a film compact.
 *
 * Where: JpegEncodeMacroProcess::Execute (0x537034B4), the step of the still pipeline that hands
 * the finished pictures to the JPEG encoder. Its configuration (Execute's second argument + 8)
 * points at the pictures to encode from offset 0x3C on (0x5370F7D4: main picture, then the smaller
 * ones made from it). Each is a 0x20-byte picture: format byte (1 = YCbCr 4:2:2), Y plane, CbCr
 * plane (interleaved), size, width, height, line pitch (both planes), CbCr height.
 *
 * The first instruction of Execute (`mov ip, sp`) becomes a branch to a stub that calls the C
 * module of `tools/datestamp/datestamp.c` (position independent, compiled by
 * `tools/datestamp/gen.py`) and then carries on. The module reads the camera's clock through the
 * platform's time service (0x538F21A0 -> +4 -> 0x538EA9B0, the call behind the clock the menus
 * show), flushes the rows it is about to change from the CPU cache (0x538F04D8, as the pipeline
 * does before the CPU reads a picture), draws, and cleans them back to memory (0x538F04C4) for
 * the encoder. Pictures of another format or of odd sizes are left alone.
 *
 * `setting` is the address of one byte: bit 0 on, bit 1 the long style ("2026.10.08 17:34"
 * instead of "'26 10 08"), bit 2 (0.8.3) "Follow Orientation" off; a value above 7 counts as off. The imprint is orange (light only on a
 * black-and-white photo). The camera menu entry that sets the byte is in `datestamp-menu.ts`.
 *
 * Orientation (0.8.3): a photo taken with the camera held upright or upside down is stored as the
 * sensor sees it, with an EXIF Orientation that the camera's playback and other viewers apply. The
 * camera's direction is left in ORIENT_WORD at the start of each exposure (`installExposureOrientation`
 * below; in RAW development by the development step, see `lookstash.ts`), and the module draws the
 * imprint bottom right of the picture as it is shown, turned to read normally there, on the main
 * picture, the screennail and the thumbnail alike. Without the word (builds before 0.8.2) it draws
 * as stored.
 */
import { FirmwareError } from '../types';
import { TARGET_111 } from '../target';
import type { FirmwareTarget } from '../target';
import { assembleWords, movWord } from './arm';
import { Patch, expectWord, u32le } from './build';
import { DATESTAMP_CODE, DATESTAMP_CODE_LENGTH, DATESTAMP_DIAG_CODE } from './datestamp-code';
import { MONO_MODEL, ORIENT_VALID, orientWord } from './lookstash';

/** JpegEncodeMacroProcess::Execute. */
export const JPEG_EXECUTE = 0x537034b4;

const CACHE = 0x538f0448;
const CACHE_FLUSH_FOR_READ = 0x538f04d8;
const CACHE_CLEAN = 0x538f04c4;
const PLATFORM = 0x538f21a0;
const GET_TIME = 0x538ea9b0;

/**
 * Where the setting is kept: byte 0x94B of the live user settings, alignment padding that the
 * factory-defaults initialiser never writes (like 0x90F for soft focus); saved, loaded and copied
 * to U1-U3 with the rest of the structure. In 1.20 the structure is longer (0xB44 bytes, new
 * settings at its end) and the 30 default records leave exactly the same 53 bytes unwritten as
 * in 1.11, this one among them (tools/port120/check_userdata.py).
 */
export function dateStampByte(t: FirmwareTarget): number {
  return t.facts.userData + 4 + 0x94b;
}
/** The setting byte in 1.11. */
export const DATESTAMP_BYTE = dateStampByte(TARGET_111);

/** Bits of the setting byte. */
export const DATESTAMP_ON = 1;
export const DATESTAMP_LONG = 2;
/**
 * 0.8.3: "Follow Orientation" Off: the imprint always goes where it went up to 0.8.2 (bottom right
 * of the picture as stored), whatever the camera's direction. Set means Off, so that a byte from
 * an earlier firmware (0..3) reads as On.
 */
export const DATESTAMP_AS_STORED = 4;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

function lo(v: number): number {
  return v & 0xffff;
}
function hi(v: number): number {
  return v >>> 16;
}

export function datestampModule(diag = false): Uint8Array {
  const raw = Uint8Array.from(atob(diag ? DATESTAMP_DIAG_CODE : DATESTAMP_CODE), (c) => c.charCodeAt(0));
  if ((!diag && raw.length !== DATESTAMP_CODE_LENGTH) || raw.length % 4 !== 0) fail('internal', 'date imprint module length');
  return raw;
}

/**
 * Install the imprint; `setting` is the address of its setting byte. `look` (0.8.2 on): the word
 * the development step leaves the look in and the 64-byte table of black-and-white looks; the
 * imprint is then light only exactly for those looks (and on the GR IV Monochrome) instead of
 * for pictures whose colours look neutral. Returns the module address.
 */
export function installDateStamp(patch: Patch, setting: number, diag = false, look?: { stash: number; monoLooks: Uint8Array }): number {
  const v = (a: number): number => patch.va(a);
  const execute = v(JPEG_EXECUTE);
  expectWord(patch, execute, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, execute + 4, 0xe92ddff0); // push {r4-r12, lr, pc}
  expectWord(patch, execute + 0x18, 0xe5914008); // ldr r4, [r1, #8]  (the configuration)
  // the cache object's getter: movw r0 / movt r0 (the object, 0x553A09C4 in 1.11) / bx lr
  if ((patch.word(v(CACHE)) & 0xfff0f000) >>> 0 !== 0xe3000000 || (patch.word(v(CACHE) + 4) & 0xfff0f000) >>> 0 !== 0xe3400000) expectWord(patch, v(CACHE), 0xe30009c4);
  expectWord(patch, v(CACHE) + 8, 0xe12fff1e);
  expectWord(patch, v(CACHE_CLEAN), 0xe1a00001);
  expectWord(patch, v(CACHE_FLUSH_FOR_READ), 0xe1a0c00d);
  expectWord(patch, v(GET_TIME), 0xe5d03014); // ldrb r3, [r0, #0x14]
  if (look && look.monoLooks.length !== 64) fail('internal', 'date imprint: table of black-and-white looks');
  const table = look ? patch.append(look.monoLooks, 4) : 0;
  const ctx = patch.append(u32le([v(CACHE), v(CACHE_FLUSH_FOR_READ), v(CACHE_CLEAN), v(PLATFORM), v(GET_TIME), setting, look ? look.stash : 0, table, look ? v(MONO_MODEL) : 0, look ? orientWord(patch.target) : 0]), 16);
  if (look) installExposureOrientation(patch);
  const code = patch.append(datestampModule(diag), 16);
  const stub = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     ldr r1, [r1, #8]
     movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}
     bl #${code}
     pop {r0, r1, r2, r3, ip, lr}
     mov ip, sp
     b #${execute + 4}`, at), 16);
  const offset = (stub - (execute + 8)) >> 2;
  patch.setWord(execute, (0xea000000 | (offset & 0xffffff)) >>> 0, 'date imprint: JPEG encode step');
  return code;
}

/**
 * SetShootingInfoResultBeforeExpose (0x53628CD8): called at the start of each still exposure with
 * the frame's shooting record, into which it writes the date and time the EXIF writer records
 * (+0x96C..+0x973). Its hook leaves the camera's direction at that moment in ORIENT_WORD:
 * byte 0xD8 of the live shooting record that the display rotation reads (singleton 0x5537960C,
 * its +4 -> +0x518 -> record; 0x5323A6F0 -> 0x53755CA0 -> 0x5375C31C), 1..3 kept, anything else
 * (up, lens up / down) 0, as the EXIF writer maps it. Every pointer is checked; nothing but the
 * word is written; the hook keeps every register (and runs `mov ip, sp` itself, after them).
 *
 * Firmware 1.20: the same code at other addresses (0x5364D640; the display rotation reads the
 * same +4 -> +0x518 -> record -> +0xD8 of the same singleton, 0x5537B29C, which 0x53750008 returns).
 */
export const BEFORE_EXPOSE = 0x53628cd8;
const DIRECTION_SINGLETON = 0x5537960c;
/** The singleton's getter (0x5372B620) returns it with this MOVW and the MOVT after it. */
const SINGLETON_MOVW = 0x5372b640;

export function installExposureOrientation(patch: Patch): void {
  const v = (a: number): number => patch.va(a);
  const at0 = v(BEFORE_EXPOSE);
  const singleton = v(DIRECTION_SINGLETON);
  const orient = orientWord(patch.target);
  if (patch.word(at0) >>> 24 === 0xea) return;
  expectWord(patch, at0, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, at0 + 4, 0xe92dd830); // push {r4, r5, fp, ip, lr, pc}
  expectWord(patch, v(0x5375c31c), 0xe5903000); // ldr r3, [r0]
  expectWord(patch, v(0x5375c320), 0xe5d300d8); // ldrb r0, [r3, #0xd8]
  expectWord(patch, v(0x53755cc8), 0xe5950518); // ldr r0, [r5, #0x518]
  // the singleton the direction is read through (movw r0, #0x960c / movt r0, #0x5537 in 1.11)
  expectWord(patch, v(SINGLETON_MOVW), movWord(0, lo(singleton)));
  expectWord(patch, v(SINGLETON_MOVW) + 4, movWord(0, hi(singleton), true));
  const stub = patch.append((at) => assembleWords(
    `push {r0, r1}
     movw r0, #${lo(singleton)}; movt r0, #${hi(singleton)}
     ldr r0, [r0, #4]
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldr r0, [r0, #0x518]
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldr r0, [r0]
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldrb r0, [r0, #0xd8]
     cmp r0, #3; movhi r0, #0
     orr r0, r0, #0x${ORIENT_VALID.toString(16)}
     movw r1, #${lo(orient)}; movt r1, #${hi(orient)}
     str r0, [r1]
     done: pop {r0, r1}
     mov ip, sp
     b #${at0 + 4}`, at), 16);
  patch.setWord(at0, (0xea000000 | (((stub - (at0 + 8)) >> 2) & 0xffffff)) >>> 0, 'date imprint: camera direction at the start of the exposure');
}
