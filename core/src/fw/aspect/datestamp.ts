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
 * `setting` is the address of one byte: bit 0 on, bits 1..2 select short date, date/time,
 * short date + look name, or short date / look name. Values above 7 count as off.
 * The imprint is orange (light only on a black-and-white photo); the camera menu uses
 * the same On/Off switch for every style.
 */
import { FirmwareError } from '../types';
import { assembleWords, branchTarget, movImmediate } from './arm';
import { Patch, expectWord, BASE } from './build';
import { NAME_TABLE_RTOS_OFFSETS } from '../names';
import { FRAME_STYLE_STASH, installFrameStyleCapture } from './frame-style';
import { DATESTAMP_FONT_BASE64 } from './datestamp-font';
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

/** Watermark labels use the embedded printable-ASCII font; keys are stable firmware style IDs. */
export function validateWatermarkNames(names: Readonly<Record<number, string>>, extraCount: number): void {
  if (!names || typeof names !== 'object' || Array.isArray(names)) fail('bad-watermark-name', 'watermark names must be a style/name map');
  for (const [key, name] of Object.entries(names)) {
    const style = Number(key);
    if (!Number.isInteger(style) || String(style) !== key || !((style >= 11 && style <= 30) || (style >= 34 && style < 34 + extraCount))) fail('bad-watermark-name', `unknown look style ${key}`);
    if (typeof name !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(name) || name.trim() !== name) fail('bad-watermark-name', `style ${key}: use 1 to 32 printable ASCII characters without surrounding spaces`);
  }
}

/** Follow the optional halation wrapper and read the exact labels embedded in the watermark. */
export function readWatermarkNames(rtos: Uint8Array, extraCount: number): Record<number, string> | null {
  try {
    const p = new Patch(rtos);
    let stub = branchTarget(JPEG_EXECUTE, p.word(JPEG_EXECUTE));
    for (let depth = 0; depth < 3; depth++) {
      const ctx = (movImmediate(p.word(stub + 8)) | movImmediate(p.word(stub + 12)) << 16) >>> 0;
      if (p.word(ctx) === CACHE && p.word(ctx + 12) === PLATFORM && p.word(ctx + 16) === GET_TIME) {
        if (p.word(ctx + 24) !== FRAME_STYLE_STASH) return null;
        const table = p.word(ctx + 28);
        const out: Record<number, string> = {};
        for (const style of [...Array.from({ length: 20 }, (_, i) => 11 + i), ...Array.from({ length: extraCount }, (_, i) => 34 + i)]) {
          const address = p.word(table + style * 4);
          let text = '';
          for (let i = 0; i <= 32; i++) {
            const ch = p.read(address + i, 1)[0];
            if (!ch) break;
            if (i === 32 || ch < 32 || ch > 126) return null;
            text += String.fromCharCode(ch);
          }
          out[style] = text;
        }
        validateWatermarkNames(out, extraCount);
        return out;
      }
      const tail = stub + 24;
      if (p.word(tail) >>> 24 !== 0xea) return null;
      stub = branchTarget(tail, p.word(tail));
    }
    return null;
  } catch {
    return null;
  }
}

/** Install the imprint; `setting` is the address of its setting byte. Returns the module address. */
export function installDateStamp(patch: Patch, setting: number, diag = false, extraNames: readonly string[] = [], watermarkNames: Readonly<Record<number, string>> = {}): number {
  validateWatermarkNames(watermarkNames, extraNames.length);
  expectWord(patch, JPEG_EXECUTE, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, JPEG_EXECUTE + 4, 0xe92ddff0); // push {r4-r12, lr, pc}
  expectWord(patch, JPEG_EXECUTE + 0x18, 0xe5914008); // ldr r4, [r1, #8]  (the configuration)
  expectWord(patch, CACHE, 0xe30009c4); // movw r0, #0x9c4 (the cache object)
  expectWord(patch, CACHE_CLEAN, 0xe1a00001);
  expectWord(patch, CACHE_FLUSH_FOR_READ, 0xe1a0c00d);
  expectWord(patch, GET_TIME, 0xe5d03014); // ldrb r3, [r0, #0x14]
  installFrameStyleCapture(patch, extraNames.length);
  const names = new Array<number>(256).fill(0);
  const factory = ['Standard', 'Vivid', 'Monotone', 'Soft Monotone', 'Hard Monotone', 'Hi-Contrast B&W', 'Positive Film', 'Cinema (Yellow)', 'Cinema (Green)', 'Bleach Bypass', 'Retro', 'HDR Tone', 'Cross Processing', 'Negative Film', 'Standard (mono)', 'Soft (mono)', 'High Contrast (mono)', 'Grainy (mono)', 'Solid (mono)', 'HDR Tone (mono)'];
  const put = (style: number, name: string, override = true): void => {
    const text = (override ? watermarkNames[style] ?? name : name).slice(0, 32).replace(/[^\x20-\x7e]/g, '?').trim();
    if (text) names[style] = patch.append(Uint8Array.from([...text].map((c) => c.charCodeAt(0)).concat(0)), 4);
  };
  factory.forEach((name, i) => put(11 + i, name, i !== 7 && i !== 8));
  // Cinema replacement names are already applied to the RTOS input. Use English for the
  // printable-ASCII imprint, independently of the language used by the camera menu.
  const englishRoot = BASE + NAME_TABLE_RTOS_OFFSETS[2];
  for (const [style, id] of [[18, 301], [19, 302]]) {
    const descriptor = new DataView(patch.readMapped(englishRoot + id * 4, 4).buffer).getUint32(0, true);
    const desc = new DataView(patch.readMapped(descriptor, 8).buffer);
    const length = Math.min(32, (desc.getUint32(0, true) & 255) - 1);
    const raw = new DataView(patch.readMapped(desc.getUint32(4, true), length * 2).buffer);
    put(style, Array.from({ length }, (_, i) => String.fromCharCode(raw.getUint16(i * 2, true))).join(''));
  }
  extraNames.forEach((name, i) => put(34 + i, name));
  const nameTable = patch.append(names, 16);
  const font = patch.append(Uint8Array.from(atob(DATESTAMP_FONT_BASE64), (c) => c.charCodeAt(0)), 16);
  const ctx = patch.append([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, PLATFORM, GET_TIME, setting, FRAME_STYLE_STASH, nameTable, font], 16);
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
