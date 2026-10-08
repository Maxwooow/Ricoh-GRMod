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
 * instead of "'26 10 08"); a value above 3 counts as off. The imprint is orange (light only on a
 * black-and-white photo). The camera menu entry that sets the byte is in `datestamp-menu.ts`.
 */
import { FirmwareError } from '../types';
import { assembleWords } from './arm';
import { Patch, expectWord, u32le } from './build';
import { DATESTAMP_CODE, DATESTAMP_CODE_LENGTH, DATESTAMP_DIAG_CODE } from './datestamp-code';

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
 * to U1-U3 with the rest of the structure.
 */
export const DATESTAMP_BYTE = 0x55084dd8 + 4 + 0x94b;

/** Bits of the setting byte. */
export const DATESTAMP_ON = 1;
export const DATESTAMP_LONG = 2;

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

/** Install the imprint; `setting` is the address of its setting byte. Returns the module address. */
export function installDateStamp(patch: Patch, setting: number, diag = false): number {
  expectWord(patch, JPEG_EXECUTE, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, JPEG_EXECUTE + 4, 0xe92ddff0); // push {r4-r12, lr, pc}
  expectWord(patch, JPEG_EXECUTE + 0x18, 0xe5914008); // ldr r4, [r1, #8]  (the configuration)
  expectWord(patch, CACHE, 0xe30009c4); // movw r0, #0x9c4 (the cache object)
  expectWord(patch, CACHE_CLEAN, 0xe1a00001);
  expectWord(patch, CACHE_FLUSH_FOR_READ, 0xe1a0c00d);
  expectWord(patch, GET_TIME, 0xe5d03014); // ldrb r3, [r0, #0x14]
  const ctx = patch.append(u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, PLATFORM, GET_TIME, setting]), 16);
  const code = patch.append(datestampModule(diag), 16);
  const stub = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     ldr r1, [r1, #8]
     movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}
     bl #${code}
     pop {r0, r1, r2, r3, ip, lr}
     mov ip, sp
     b #${JPEG_EXECUTE + 4}`, at), 16);
  const offset = (stub - (JPEG_EXECUTE + 8)) >> 2;
  patch.setWord(JPEG_EXECUTE, (0xea000000 | (offset & 0xffffff)) >>> 0, 'date imprint: JPEG encode step');
  return code;
}
