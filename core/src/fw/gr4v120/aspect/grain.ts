// SPDX-License-Identifier: GPL-2.0-only
/**
 * Film grain in place of the camera's Grain Effect (GR IV 1.20 and 1.21).
 *
 * The camera's own grain: Granulation (0x538C59A4) fills two picture-sized planes with random bytes
 * and has the image hardware blur them by 3 x 3 and add them within limits by brightness. The grain
 * is one or two pixels, about as strong in sky and highlights as in the midtones (its brightness
 * table only lowers the midtones, to 72 %). It reads as sensor noise, and is mostly gone when the
 * photo is seen whole on a phone.
 *
 * Here: the camera's grain is turned off (its wrapper 0x538C9854, called for Grain Effect only, not
 * for the Grainy look's own grain, returns "done") and `tools/gr4v120/grain/grain.c` puts a grain of
 * its own on the finished pictures at the start of JpegEncodeMacroProcess::Execute (0x53727E10),
 * when Grain Effect is on. Only on / off counts: the camera's Strength and Size are not used, and the
 * Strength / Size submenu is no longer offered for the Grain Effect row (`hideGrainSubmenu`). The
 * strength is found per picture: full for a clean one, down to half for one that already has fine
 * texture of its own (high ISO noise, busy detail). Luminance only; soft grain of several sizes
 * (2, 4 and 8 pixels on the main picture); strongest in the midtones and fading out towards skin,
 * sky and deep shadows; a new grain for every picture. Tables: `tools/gr4v120/grain/model.py`
 * (which also gives the module's exact bytes); checks: `tools/gr4v120/grain/check.py` (the compiled
 * module in unicorn against the model) and `fw_check.py` (the hooks inside a built image).
 *
 * The settings reach the JPEG step in free bits of the look words (lookstash.ts): a hook of the
 * development step right after the look stash (0x5393914C, the look's compare; the frame's record in
 * r3) sets bits 20..25 of LOOK_STASH (and, in RAW development, of FRAME_LOOK): bit 25 written, 20
 * Grain Effect on (not for the Grainy look, which keeps the camera's own grain), 21..22 Strength,
 * 23..24 Size. The start of each exposure copies LOOK_STASH to FRAME_LOOK (datestamp.ts); the module
 * reads FRAME_LOOK. The other readers of the words use bits 0..17 only.
 *
 * The module runs at the second instruction of JpegEncodeMacroProcess::Execute (0x53727E14), where
 * every wrapper of the step (halation, date imprint, HDR gain map) ends: after the halation and the
 * date imprint, before the encoder. Everything is appended after all the other additions, so a
 * build without the grain is the same byte for byte up to there.
 *
 * GR IV 1.20 and 1.21 (not 1.11: the engine does not offer it there). 1.21 runs this through its
 * address table: the code the grain hooks is the same there, moved; the one instruction word that
 * differs (a movw of a relocated data address in the JPEG step) is a `byRelease`. Every address is
 * looked up (`adr`) when the grain is installed, not when this file loads, so that a release whose
 * address table does not have them still loads the program.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord, u32le } from './build';
import { GRAIN_CODE, GRAIN_CODE_LENGTH } from './grain-code';
import { GRAIN_AMP, GRAIN_FULL_WIDTH, GRAIN_GAIN, GRAIN_OCTAVES } from './grain-tables';
import { installExposureOrientation } from './datestamp';
import { FRAME_LOOK, LOOK_SITE, LOOK_STASH, extendZeroFill } from './lookstash';
import { HAL_FLAG } from './halation-ui';
import { adr, byRelease } from '../target';

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

const CTX_MAGIC = 0x324e5247; // 'GRN2'
const GRAINY_LOOK = 28;
/** The bits of the look words (LOOK_STASH, FRAME_LOOK) that carry Grain Effect's settings. */
export const GRAIN_BITS = 0x3f00000;

/** The places the grain relies on (addresses of this program's release). */
function places() {
  return {
    jpegExecute: adr(0x53727e10),
    cache: adr(0x53918010),
    cacheFlushForRead: adr(0x539180a0),
    cacheClean: adr(0x5391808c),
    heapAlloc: adr(0x539084bc),
    heapFree: adr(0x539084f8),
    /** The camera's Grain Effect: the wrapper the effect dispatcher (0x538CE520) calls, then Granulation. */
    nativeGrain: adr(0x538c9854),
    nativeGrainTail: adr(0x538c98a8), // b Granulation
    granulation: adr(0x538c59a4),
    /** The development step's compare of the look (`cmp r2, #0xb`), right after the look stash's hook. */
    devSite: adr(0x5393914c),
    devSkip: adr(0x53939298), // beq target of the compare
    // The Grain Effect row's submenu (see hideGrainSubmenu).
    /** Shooting, Fn guide: Grain Effect (kind 16) reads the switch (`bl 0x532406a4`) -> `b 0x531CBFD4` (r5 = 0: no guide). */
    shootGuide: adr(0x531cc004),
    shootNoGuide: adr(0x531cbfd4), // mov r5, #0
    /** Shooting, Fn: Grain Effect's (and, with the flag, the Halation row's) way into the submenu (`mov r0, r4`). */
    shootFn: adr(0x531cc988),
    shootFnCall: adr(0x53185054),
    shootNoSubmenu: adr(0x531cc964), // mov r0, r4: Fn on a row without a submenu
    /** RAW development, Fn guide: Grain Effect reads the switch (`bl 0x5337AEB8`) -> `b 0x531AA560` (r4 = 0). */
    rawGuide: adr(0x531aa590),
    rawNoGuide: adr(0x531aa560), // mov r4, #0
    /** RAW development, Fn: Grain Effect's way into the submenu (`bl 0x532406A4`; the Halation row enters at 0x531AB76C) -> `b 0x531AB71C`. */
    rawFn: adr(0x531ab760),
    rawNoSubmenu: adr(0x531ab71c), // mov r0, r4: Fn on a row without a submenu
    switchRead: adr(0x532406a4),
    rawSwitchRead: adr(0x5337aeb8),
  };
}

/**
 * Grain Effect's Strength and Size (its submenu, opened with Fn from the Grain Effect row) do nothing
 * with the film grain, so the submenu is no longer offered for that row: no Fn guide, and Fn does
 * what it does on a row without a submenu. Shooting (ImageControlDetailController) and RAW
 * development (RawDevelopmentImageControlDetailSetController). The Halation row (halation-ui.ts)
 * opens the same submenu with HAL_FLAG set and keeps it; the Grainy look's rows (kind 13) are not
 * touched.
 */
function hideGrainSubmenu(p: Patch, a: ReturnType<typeof places>): void {
  expectWord(p, a.shootGuide, branchWord(a.shootGuide, a.switchRead, 14, true));
  expectWord(p, a.shootNoGuide, 0xe3a05000); // mov r5, #0
  expectWord(p, a.shootFn, 0xe1a00004); // mov r0, r4
  expectWord(p, a.shootFn + 4, branchWord(a.shootFn + 4, a.shootFnCall, 14, true));
  expectWord(p, a.shootNoSubmenu, 0xe1a00004); // mov r0, r4
  expectWord(p, a.rawGuide, branchWord(a.rawGuide, a.rawSwitchRead, 14, true));
  expectWord(p, a.rawNoGuide, 0xe3a04000); // mov r4, #0
  expectWord(p, a.rawFn, branchWord(a.rawFn, a.switchRead, 14, true));
  expectWord(p, a.rawNoSubmenu, 0xe1a00004); // mov r0, r4
  p.setWord(a.shootGuide, branchWord(a.shootGuide, a.shootNoGuide), 'film grain: no Fn guide on Grain Effect');
  const fn = p.append((at) => assembleWords(
    `movw ip,#${HAL_FLAG & 65535};movt ip,#${HAL_FLAG >>> 16};ldr ip,[ip];cmp ip,#0
     beq #${a.shootNoSubmenu}
     mov r0,r4;b #${a.shootFn + 4}`, at), 16);
  p.setWord(a.shootFn, branchWord(a.shootFn, fn), 'film grain: Fn on Grain Effect opens no submenu (Halation still does)');
  p.setWord(a.rawGuide, branchWord(a.rawGuide, a.rawNoGuide), 'film grain: no Fn guide on Grain Effect (RAW development)');
  p.setWord(a.rawFn, branchWord(a.rawFn, a.rawNoSubmenu), 'film grain: Fn on Grain Effect opens no submenu (RAW development)');
}

export function grainModule(): Uint8Array {
  const raw = Uint8Array.from(atob(GRAIN_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== GRAIN_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'film grain module length');
  return raw;
}

/** Whether a build has the film grain (the camera's own grain turned off). */
export function filmGrainInstalled(p: Patch): boolean {
  return p.word(places().nativeGrain) === 0xe3a00001;
}

/** The words the grain hooks (for tests): the camera's grain, the development step, the JPEG step. */
export function filmGrainSites(): { nativeGrain: number; devSite: number; jpegHook: number } {
  const a = places();
  return { nativeGrain: a.nativeGrain, devSite: a.devSite, jpegHook: a.jpegExecute + 4 };
}

export function installFilmGrain(p: Patch): void {
  const a = places();
  if (GRAIN_AMP.length !== 768 || GRAIN_AMP.some((v) => !(Number.isInteger(v) && v >= 0 && v < 256))) fail('internal', 'film grain: amplitude table');
  if (GRAIN_OCTAVES.length !== 24 || GRAIN_OCTAVES.some((v) => !(Number.isInteger(v) && v >= 0 && v < 256))) fail('internal', 'film grain: octave table');
  for (let s = 0; s < 3; s++) for (let o = 1; o < 4; o++) {
    const at = (s * 4 + o) * 2;
    if (GRAIN_OCTAVES[at + 1] && GRAIN_OCTAVES[at] < GRAIN_OCTAVES[at - 2]) fail('internal', 'film grain: octaves must go from fine to coarse');
  }
  // The camera's grain: `push {r4, r5, r6, lr}; ldr ip, [sp, #0x10]` -> `mov r0, #1; bx lr` (1: done, as
  // when the effect is not asked for).
  expectWord(p, a.nativeGrain, 0xe92d4070);
  expectWord(p, a.nativeGrain + 4, 0xe59dc010);
  expectWord(p, a.nativeGrainTail, branchWord(a.nativeGrainTail, a.granulation)); // b Granulation
  p.setWord(a.nativeGrain, 0xe3a00001, 'film grain: the camera\'s own grain off');
  p.setWord(a.nativeGrain + 4, 0xe12fff1e, 'film grain: the camera\'s own grain off');

  // The frame's settings into the look words (r1 = the step's argument + 0x8000, r2 the look, r3 the
  // frame's record; the flags are set by the compare that ends the hook).
  expectWord(p, a.devSite, 0xe352000b); // cmp r2, #0xb
  expectWord(p, a.devSite + 4, branchWord(a.devSite + 4, a.devSkip, 0)); // beq
  if (p.word(LOOK_SITE) >>> 24 !== 0xea && p.word(LOOK_SITE) !== 0xe5d3279c) fail('unexpected-layout', 'film grain: development step');
  const dev = p.append((at) => assembleWords(
    `push {r0,r1,r2}
     mov r0,#0x2000000
     ldrb r2,[r3,#0x79c];cmp r2,#${GRAINY_LOOK};beq gstore
     ldrb r2,[r3,#0x7b5];cmp r2,#0;beq gstore
     orr r0,r0,#0x100000
     ldrb r2,[r3,#0x7b7];cmp r2,#2;movhi r2,#0;orr r0,r0,r2,lsl #21
     ldrb r2,[r3,#0x7b6];cmp r2,#2;movhi r2,#0;orr r0,r0,r2,lsl #23
     gstore:movw r2,#${LOOK_STASH & 65535};movt r2,#${LOOK_STASH >>> 16}
     ldr r1,[r2];bic r1,r1,#0x${GRAIN_BITS.toString(16)};orr r1,r1,r0;str r1,[r2]
     ldr r1,[sp,#4];ldrb r1,[r1,#0x2ac];cmp r1,#0;bne gdone
     movw r2,#${FRAME_LOOK & 65535};movt r2,#${FRAME_LOOK >>> 16}
     ldr r1,[r2];bic r1,r1,#0x${GRAIN_BITS.toString(16)};orr r1,r1,r0;str r1,[r2]
     gdone:pop {r0,r1,r2}
     cmp r2,#0xb
     b #${a.devSite + 4}`, at), 16);
  p.setWord(a.devSite, branchWord(a.devSite, dev), 'film grain: the frame\'s Grain Effect settings');
  extendZeroFill(p);
  installExposureOrientation(p);

  // The module, at the step's second instruction (ip = sp of the caller there).
  expectWord(p, a.jpegExecute + 4, 0xe92ddff0); // push {r4-r12, lr, pc}
  expectWord(p, a.jpegExecute + 8, byRelease({ '1.20': 0xe30c6484, '1.21': 0xe30d6c74 })); // movw r6, #0xc484 (1.21 #0xdc74: the same data, moved)
  if (GRAIN_GAIN.length !== 64 || GRAIN_GAIN.some((v) => !(Number.isInteger(v) && v >= 0 && v < 256))) fail('internal', 'film grain: gain table');
  const tables = p.append(Uint8Array.from([...GRAIN_AMP, ...GRAIN_OCTAVES, ...GRAIN_GAIN]), 16);
  const ctx = p.append(u32le([a.cache, a.cacheFlushForRead, a.cacheClean, a.heapAlloc, a.heapFree, FRAME_LOOK, tables, tables + 768, tables + 792, GRAIN_FULL_WIDTH, CTX_MAGIC]), 16);
  const code = p.append(grainModule(), 16);
  const stub = p.append((at) => assembleWords(
    `push {r0-r3,ip,lr}
     movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}
     ldr r1,[r1,#8]
     bl #${code}
     pop {r0-r3,ip,lr}
     push {r4-r12,lr,pc}
     b #${a.jpegExecute + 8}`, at), 16);
  hideGrainSubmenu(p, a);
  p.setWord(a.jpegExecute + 4, branchWord(a.jpegExecute + 4, stub), 'film grain at the JPEG encode step');
}
