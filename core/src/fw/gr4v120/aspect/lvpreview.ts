// SPDX-License-Identifier: GPL-2.0-only
/**
 * Exposure preview off (issue #17; firmware 1.20; test builds only so far): the live view keeps a
 * normal brightness whatever the exposure set, the picture is still taken with the exposure set.
 * For flash pictures with a dark background (M at a fast shutter speed and a low ISO) and for
 * exposure compensation, where the camera's live view darkens with the exposure.
 *
 * The live view's own auto exposure (AeLiveViewExposure, the event 1 path of AeLiveViewCalcService,
 * see 04_研究与样片/曝光预览关闭可行性) decides how to drive the sensor for the live view from two
 * things of the shared exposure record:
 *  - the exposure program (byte 0x39: 0 P, 1 Tv, 2 Av, 3 M with ISO auto, 4 M, 5/6 bulb/time): in
 *    M (and bulb/time) it takes a manual branch that shows the exposure set; the four places of the
 *    per-frame path that read it (0x5368DC80, 0x5368FB04, 0x53690DF8, 0x536910A4) now read P for M
 *    (bulb / time unchanged);
 *  - the "preview bias" (float +0xDC, the exposure compensation and how far the program is short
 *    of a correct exposure; clamped to -5..+2 EV and handed to the live view parameters at +0x130):
 *    read once per frame at 0x5368FAF4, now 0.
 * Only the reads of the live view's per-frame path change: the record itself, the half-press path,
 * the picture's exposure, the meter and the flash read the true values. Movies (record byte 8 set)
 * keep the preview: the live view is the movie.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord } from './build';

const PROGRAM_GETTER = 0x536a7534; // ldrb r0, [r0, #0x39]; bx lr
const BIAS_GETTER = 0x536a7e54; // vldr s0, [r0, #0xdc]; bx lr
const PROGRAM_SITES = [0x5368dc80, 0x5368fb04, 0x53690df8, 0x536910a4] as const;
const BIAS_SITE = 0x5368faf4;
const PROGRAM_M = 4;
const VMOV_S0_IP = 0xee00ca10; // vmov s0, ip

function fail(message: string): never {
  throw new FirmwareError('internal', `exposure preview: ${message}`);
}

/**
 * When the live view's exposure is taken over. 'always' (test 078): every still frame. Otherwise
 * by the setting (test 080, `exposure.ts`): 0 never (the official preview), 1 while Direct Flash is
 * the Flash Mode (`directFlash`: its byte and its Flash Mode 0; without Direct Flash in the build,
 * never), 2 always; anything else as 0.
 */
export type PreviewCondition = 'always' | { byte: number; directFlash: { byte: number; flashMode: number } | null };

export function installExposurePreviewOff(patch: Patch, when: PreviewCondition = 'always'): void {
  expectWord(patch, PROGRAM_GETTER, 0xe5d00039);
  expectWord(patch, PROGRAM_GETTER + 4, 0xe12fff1e);
  expectWord(patch, BIAS_GETTER, 0xed900a37);
  expectWord(patch, BIAS_GETTER + 4, 0xe12fff1e);
  for (const at of PROGRAM_SITES) expectWord(patch, at, branchWord(at, PROGRAM_GETTER, 14, true));
  expectWord(patch, BIAS_SITE, branchWord(BIAS_SITE, BIAS_GETTER, 14, true));
  // As the getters: r0 = the exposure record; only r0 / s0, ip and the flags change (the callers
  // may count on the getters' own use of registers: everything else is kept).
  // ip = 1 when the preview is off for this frame (a still: record byte 8 clear), else 0.
  const lo = (v: number): number => v & 0xffff;
  const hi = (v: number): number => v >>> 16;
  const condition = when === 'always' ? 0 : patch.append((at) => assembleWords(
    `ldrb ip, [r0, #8]
     cmp ip, #0
     movne ip, #0
     bxne lr
     push {r1}
     movw r1, #${lo(when.byte)}; movt r1, #${hi(when.byte)}; ldrb r1, [r1]
     cmp r1, #2
     beq off
     ${when.directFlash ? `cmp r1, #1
     bne on
     movw r1, #${lo(when.directFlash.byte)}; movt r1, #${hi(when.directFlash.byte)}; ldrb r1, [r1]
     tst r1, #1
     beq on
     movw r1, #${lo(when.directFlash.flashMode)}; movt r1, #${hi(when.directFlash.flashMode)}; ldrb r1, [r1]
     cmp r1, #0
     beq off` : ''}
     on: mov ip, #0
     pop {r1}
     bx lr
     off: mov ip, #1
     pop {r1}
     bx lr`, at), 4);
  const program = when === 'always'
    ? patch.append((at) => assembleWords(
      `ldrb ip, [r0, #8]
       ldrb r0, [r0, #0x39]
       cmp ip, #0
       bxne lr
       cmp r0, #${PROGRAM_M}
       moveq r0, #0
       bx lr`, at), 4)
    : patch.append((at) => assembleWords(
      `push {lr}
       bl #${condition}
       pop {lr}
       ldrb r0, [r0, #0x39]
       cmp ip, #0
       bxeq lr
       cmp r0, #${PROGRAM_M}
       moveq r0, #0
       bx lr`, at), 4);
  const bias = patch.append((at) => {
    const head = when === 'always'
      ? assembleWords(
        `ldrb ip, [r0, #8]
         vldr s0, [r0, #0xdc]
         cmp ip, #0
         bxne lr
         mov ip, #0`, at)
      : assembleWords(
        `push {lr}
         bl #${condition}
         pop {lr}
         vldr s0, [r0, #0xdc]
         cmp ip, #0
         bxeq lr
         mov ip, #0`, at);
    const tail = assembleWords('bx lr', at + (head.length + 1) * 4);
    return [...head, VMOV_S0_IP, ...tail];
  }, 4);
  if (program % 4 !== 0 || bias % 4 !== 0 || condition % 4 !== 0) fail('unaligned code');
  for (const at of PROGRAM_SITES) patch.setWord(at, branchWord(at, program, 14, true), 'exposure preview off: live view program');
  patch.setWord(BIAS_SITE, branchWord(BIAS_SITE, bias, 14, true), 'exposure preview off: live view bias');
}
