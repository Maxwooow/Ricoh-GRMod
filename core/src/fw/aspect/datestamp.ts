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
 * instead of "'26 10 08"), bit 2 (0.8.3) "Follow Orientation" off, bit 3 (0.8.4) with the look's
 * name; a value above 15 counts as off (as one above 7 did up to 0.8.3: a 0.8.3 firmware that
 * finds 8..15 draws nothing, and its menu shows and stores Off). The imprint is orange (light only
 * on a black-and-white photo). The camera menu entry that sets the byte is in `datestamp-menu.ts`.
 *
 * Look name (0.8.4; the idea of PR #9 by jaylee / sjclijie): after the date, the name of the
 * picture's look as the camera's English menu calls it (an added slot's own name; Cinema Yellow /
 * Green under the name GR Mod gave them), in fourteen-segment capitals drawn like the digits.
 * Digits stay seven-segment; letters a..z become capitals; characters with no segment shape become
 * spaces. The names are made into glyphs here, a table per look (`lookNameTable`). The look is the
 * one at the start of the exposure (FRAME_LOOK, lookstash.ts). The line with the name is drawn
 * only where it fits (the module makes it smaller, down to 3/4, then cuts the name short; else the
 * date alone); the thumbnail gets the date alone.
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
import { assembleWords } from './arm';
import { BASE, Patch, expectWord, u16le, u32le } from './build';
import { DATESTAMP_CODE, DATESTAMP_CODE_LENGTH, DATESTAMP_DFDIAG_CODE, DATESTAMP_DIAG_CODE } from './datestamp-code';
import { DIRECT_FLASH_DIAG_SLOT } from './directflash';
import { FRAME_LOOK, LOOK_STASH, MONO_MODEL, ORIENT_VALID, ORIENT_WORD } from './lookstash';
import { NAME_TABLE_RTOS_OFFSETS } from '../names';

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
/**
 * 0.8.3: "Follow Orientation" Off: the imprint always goes where it went up to 0.8.2 (bottom right
 * of the picture as stored), whatever the camera's direction. Set means Off, so that a byte from
 * an earlier firmware (0..3) reads as On.
 */
export const DATESTAMP_AS_STORED = 4;
/** 0.8.4: the look's name after the date. */
export const DATESTAMP_NAME = 8;

/** The camera's English names of its looks (style -> text, as 0x5337F824 picks the text). */
export const FACTORY_LOOK_NAMES: Readonly<Record<number, string>> = {
  11: 'Standard', 12: 'Vivid', 13: 'Monotone', 14: 'Soft Monotone', 15: 'Hard Monotone', 16: 'Hi-Contrast B&W',
  17: 'Positive Film', 18: 'Cinema (Yellow)', 19: 'Cinema (Green)', 20: 'Bleach Bypass', 21: 'Retro', 22: 'HDR Tone',
  23: 'Cross Processing', 24: 'Negative Film', 25: 'Standard', 26: 'Soft', 27: 'High Contrast', 28: 'Grainy', 29: 'Solid', 30: 'HDR Tone',
};

/** Fourteen segments of a capital (bits: a b c d e f, g1 g2, upper-left slant, upper bar, upper-right slant, lower-left slant, lower bar, lower-right slant). */
const A = 1, B = 2, C = 4, D = 8, E = 16, F = 32, G1 = 64, G2 = 128, UL = 256, UM = 512, UR = 1024, LL = 2048, LM = 4096, LR = 8192;
export const LETTER_SEGMENTS: Readonly<Record<string, number>> = {
  A: A | B | C | E | F | G1 | G2, B: A | B | C | D | G2 | UM | LM, C: A | D | E | F, D: A | B | C | D | UM | LM,
  E: A | D | E | F | G1 | G2, F: A | E | F | G1 | G2, G: A | C | D | E | F | G2, H: B | C | E | F | G1 | G2,
  I: A | D | UM | LM, J: B | C | D | E, K: E | F | G1 | UR | LR, L: D | E | F, M: B | C | E | F | UL | UR,
  N: B | C | E | F | UL | LR, O: A | B | C | D | E | F, P: A | B | E | F | G1 | G2, Q: A | B | C | D | E | F | LR,
  R: A | B | E | F | G1 | G2 | LR, S: A | C | D | F | G1 | G2, T: A | UM | LM, U: B | C | D | E | F, V: E | F | LL | UR,
  W: B | C | E | F | LL | LR, X: UL | UR | LL | LR, Y: UL | UR | LM, Z: A | D | UR | LL,
  '+': G1 | G2 | UM | LM, '-': G1 | G2, '/': UR | LL, '\\': UL | LR, '(': UR | LR, ')': UL | LL, '<': UR | LR, '>': UL | LL,
  '&': A | D | E | UL | G1 | LR | UM, '?': A | B | G2 | LM, '_': D, '*': G1 | G2 | UL | UR | LL | LR | UM | LM,
  '=': G1 | G2 | D, '"': F | UM, '$': A | C | D | F | G1 | G2 | UM | LM, '%': F | C | G1 | G2 | UR | LL, '#': B | C | D | G1 | G2 | UM | LM,
  '@': A | B | D | E | F | G2 | UM, '[': A | D | E | F, ']': A | B | C | D, '|': UM | LM, '^': LL | LR, '!': B | C,
  ',': LL, ';': A | LL, ':': UM | LM, '`': UL, '~': G1 | G2, '{': A | D | E | F | G1, '}': A | B | C | D | G2,
};
/** Glyph codes of the module (datestamp.c): digits 0..9, ' 16, space 17, . 18, letters 0x4000 | segments. */
const G_APOSTROPHE = 16, G_SPACE = 17, G_DOT = 18, G_LETTER = 0x4000;
/** The longest name drawn (glyphs). */
export const LOOK_NAME_MAX = 24;

/** A look's name as the module's glyphs (spaces at either end and repeated ones dropped). */
export function lookNameGlyphs(name: string): number[] {
  const out: number[] = [];
  for (const ch of name.toUpperCase()) {
    let g: number;
    if (ch >= '0' && ch <= '9') g = ch.charCodeAt(0) - 48;
    else if (ch === '.') g = G_DOT;
    else if (ch === "'") g = G_APOSTROPHE;
    else if (LETTER_SEGMENTS[ch] !== undefined) g = G_LETTER | LETTER_SEGMENTS[ch];
    else g = G_SPACE;
    if (g === G_SPACE && (out.length === 0 || out[out.length - 1] === G_SPACE)) continue;
    out.push(g);
  }
  while (out.length && out[out.length - 1] === G_SPACE) out.pop();
  return out.slice(0, LOOK_NAME_MAX);
}

/** Text `index` of language row `lang` (LANGS order) of the camera's own text tables, as it is in `patch`. */
function cameraText(patch: Patch, lang: number, index: number): string {
  const root = BASE + NAME_TABLE_RTOS_OFFSETS[lang];
  const w = (a: number): number => new DataView(patch.readMapped(a, 4).buffer).getUint32(0, true);
  const desc = w(root + index * 4);
  const units = patch.readMapped(desc, 1)[0];
  const t = patch.readMapped(w(desc + 4), Math.max(0, units - 1) * 2);
  let s = '';
  for (let i = 0; i + 1 < units; i++) s += String.fromCharCode(t[2 * i] | (t[2 * i + 1] << 8));
  return s;
}

/**
 * The names for the imprint, per look: the factory looks' English names; Cinema Yellow / Green as
 * renamed for English, else as renamed in a language whose own name is not in Latin letters
 * (Chinese, Japanese, Korean, Russian, Greek, Thai) when that name is all printable ASCII, else
 * their English name; added slots by their names (`extraNames`, styles from 34).
 */
export function lookNames(patch: Patch, extraNames: readonly string[]): Record<number, string> {
  const out: Record<number, string> = { ...FACTORY_LOOK_NAMES };
  const EN = 2;
  const OTHER = [15, 19, 9, 10, 14, 6, 18]; // zh-CN zh-TW ja ko ru el th
  for (const [style, index] of [[18, 301], [19, 302]] as const) {
    const en = cameraText(patch, EN, index);
    let name = en;
    if (en === FACTORY_LOOK_NAMES[style]) {
      for (const l of OTHER) {
        const t = cameraText(patch, l, index);
        if (/^[\x20-\x7e]+$/.test(t)) { name = t; break; }
      }
    }
    out[style] = name;
  }
  extraNames.forEach((n, k) => { out[34 + k] = n; });
  return out;
}

/** The module's table: 64 pointers (by look) to {u16 count, u16 glyphs...}, 0 for none. */
function lookNameTable(patch: Patch, names: Readonly<Record<number, string>>): number {
  const table = new Array<number>(64).fill(0);
  for (const [key, name] of Object.entries(names)) {
    const style = Number(key);
    if (!(style >= 0 && style < 64)) fail('internal', 'date imprint: look name style');
    const g = lookNameGlyphs(name);
    if (!g.length) continue;
    table[style] = patch.append(u16le([g.length, ...g]), 4);
  }
  return patch.append(u32le(table), 4);
}

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

function lo(v: number): number {
  return v & 0xffff;
}
function hi(v: number): number {
  return v >>> 16;
}

/** `diag`: test builds only; true prints the encoder configuration, 'df' the Direct Flash planner's diagnostics. */
export function datestampModule(diag: boolean | 'df' = false): Uint8Array {
  const raw = Uint8Array.from(atob(diag === 'df' ? DATESTAMP_DFDIAG_CODE : diag ? DATESTAMP_DIAG_CODE : DATESTAMP_CODE), (c) => c.charCodeAt(0));
  if ((!diag && raw.length !== DATESTAMP_CODE_LENGTH) || raw.length % 4 !== 0) fail('internal', 'date imprint module length');
  return raw;
}

/**
 * Install the imprint; `setting` is the address of its setting byte. `look` (0.8.2 on): the word
 * the development step leaves the look in and the 64-byte table of black-and-white looks; the
 * imprint is then light only exactly for those looks (and on the GR IV Monochrome) instead of
 * for pictures whose colours look neutral. Returns the module address.
 */
export function installDateStamp(patch: Patch, setting: number, diag: boolean | 'df' = false, look?: { stash: number; monoLooks: Uint8Array; names?: Readonly<Record<number, string>> }): number {
  expectWord(patch, JPEG_EXECUTE, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, JPEG_EXECUTE + 4, 0xe92ddff0); // push {r4-r12, lr, pc}
  expectWord(patch, JPEG_EXECUTE + 0x18, 0xe5914008); // ldr r4, [r1, #8]  (the configuration)
  expectWord(patch, CACHE, 0xe30009c4); // movw r0, #0x9c4 (the cache object)
  expectWord(patch, CACHE_CLEAN, 0xe1a00001);
  expectWord(patch, CACHE_FLUSH_FOR_READ, 0xe1a0c00d);
  expectWord(patch, GET_TIME, 0xe5d03014); // ldrb r3, [r0, #0x14]
  if (look && look.monoLooks.length !== 64) fail('internal', 'date imprint: table of black-and-white looks');
  const table = look ? patch.append(look.monoLooks, 4) : 0;
  const names = look && look.names ? lookNameTable(patch, look.names) : 0;
  const ctx = patch.append(u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, PLATFORM, GET_TIME, setting, look ? look.stash : 0, table, look ? MONO_MODEL : 0, look ? ORIENT_WORD : 0,
    look ? FRAME_LOOK : 0, names, ...(diag === 'df' ? [DIRECT_FLASH_DIAG_SLOT] : [])]), 16);
  if (look) installExposureOrientation(patch);
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

/**
 * SetShootingInfoResultBeforeExpose (0x53628CD8): called at the start of each still exposure with
 * the frame's shooting record, into which it writes the date and time the EXIF writer records
 * (+0x96C..+0x973). Its hook leaves the camera's direction at that moment in ORIENT_WORD:
 * byte 0xD8 of the live shooting record that the display rotation reads (singleton 0x5537960C,
 * its +4 -> +0x518 -> record; 0x5323A6F0 -> 0x53755CA0 -> 0x5375C31C), 1..3 kept, anything else
 * (up, lens up / down) 0, as the EXIF writer maps it. Every pointer is checked. (0.8.4) It also
 * copies LOOK_STASH (the look live view is being developed with) into FRAME_LOOK, for the
 * imprint's look name. Nothing but the two words is written; the hook keeps every register (and
 * runs `mov ip, sp` itself, after them).
 */
export const BEFORE_EXPOSE = 0x53628cd8;
const DIRECTION_SINGLETON = 0x5537960c;

export function installExposureOrientation(patch: Patch): void {
  if (patch.word(BEFORE_EXPOSE) >>> 24 === 0xea) return;
  expectWord(patch, BEFORE_EXPOSE, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, BEFORE_EXPOSE + 4, 0xe92dd830); // push {r4, r5, fp, ip, lr, pc}
  expectWord(patch, 0x5375c31c, 0xe5903000); // ldr r3, [r0]
  expectWord(patch, 0x5375c320, 0xe5d300d8); // ldrb r0, [r3, #0xd8]
  expectWord(patch, 0x53755cc8, 0xe5950518); // ldr r0, [r5, #0x518]
  expectWord(patch, 0x5372b640, 0xe309060c); // movw r0, #0x960c (the singleton the direction is read through)
  const stub = patch.append((at) => assembleWords(
    `push {r0, r1}
     movw r0, #${lo(LOOK_STASH)}; movt r0, #${hi(LOOK_STASH)}; ldr r0, [r0]
     movw r1, #${lo(FRAME_LOOK)}; movt r1, #${hi(FRAME_LOOK)}; str r0, [r1]
     movw r0, #${lo(DIRECTION_SINGLETON)}; movt r0, #${hi(DIRECTION_SINGLETON)}
     ldr r0, [r0, #4]
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldr r0, [r0, #0x518]
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldr r0, [r0]
     cmp r0, #0x40000000; blo done; cmp r0, #0xc0000000; bhs done
     ldrb r0, [r0, #0xd8]
     cmp r0, #3; movhi r0, #0
     orr r0, r0, #0x${ORIENT_VALID.toString(16)}
     movw r1, #${lo(ORIENT_WORD)}; movt r1, #${hi(ORIENT_WORD)}
     str r0, [r1]
     done: pop {r0, r1}
     mov ip, sp
     b #${BEFORE_EXPOSE + 4}`, at), 16);
  patch.setWord(BEFORE_EXPOSE, (0xea000000 | (((stub - (BEFORE_EXPOSE + 8)) >> 2) & 0xffffff)) >>> 0, 'date imprint: camera direction at the start of the exposure');
}
