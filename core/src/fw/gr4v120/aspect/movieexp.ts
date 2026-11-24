// SPDX-License-Identifier: GPL-2.0-only
/**
 * Exposure modes for movies (build option `movieExposure`, off unless asked for; GR IV 1.20 and
 * 1.21): movies are recorded in the exposure mode of the mode dial (P, Av, Tv, M, the user modes),
 * with the ISO setting of the still mode, instead of always in P with ISO auto; the movie screen
 * shows shutter speed, aperture and ISO, and the dials and the ISO button work as for stills.
 * There is no camera menu: it is in the firmware or not. Camera tests 089 to 089d (GR IV 1.21);
 * the emulator checks are tools/movieexp/check.py.
 *
 * What the camera does. The exposure mode handed to the auto exposure is worked out in one place,
 * the update of the shooting mode at 0x532599DC (1.20 addresses), from the mode dial:
 *
 *   base mode      0x53258D1C  dial position -> 0 P, 1 Tv, 2 Av, 5 M, 7 Sn, the user mode's own
 *   virtual mode   0x53258DF0  still: the base mode (M with ISO auto -> 4; Sn by its settings)
 *                              movie (settings +0xB76 == 1): always 0, P        <-- (1)
 *   auto flags     0x53258E7C  Tv / Av / ISO chosen by the camera, from the virtual mode; for
 *                              P, Tv, Av and Sn the ISO is auto only when the ISO setting is
 *                              AUTO (+0xC3F), a check that is skipped for movies            <-- (2)
 *   exposure mode  0x53258F58  from the flags: 0 P, 1 Tv, 2 Av, 3..7 the same with a fixed ISO
 *                              and the two M; M with the shutter speed at B / T: 9 bulb, 10 time
 *                              (0 when +0xB74 is 1 or 2)                                      <-- (3)
 *
 * The auto exposure itself (the library behind AeLiveViewExposure) is not limited to P for movies:
 * it has program lines of its own for a movie in Tv, Av, M with ISO auto and M (0x5368FBB8: the
 * lines 0x11, 6, 0x0A and 0x0B when the record's movie flag is set), and several places that treat
 * "movie and M" apart. Only the three places above keep a movie in P.
 *
 * The changes:
 *  (1) the movie branch of the virtual mode is not taken: a movie gets the virtual mode a still
 *      would get;
 *  (2) the ISO setting is looked at for movies too;
 *  (3) for a movie, the bulb / time modes are never chosen (M with the shutter speed at B or T
 *      records in P): the value read from +0xB74 for that decision reads 1 for a movie. It is used
 *      for nothing else.
 * With the mode dial at P and the ISO at AUTO the exposure is as in the official firmware.
 *
 * The screen and the ISO button (test 089b; in 089 the mode icon followed the dial, but no value
 * was shown and the ISO button did nothing):
 *  (4) The shooting screen's items are a table: 47 items, each with an "exists" byte per still /
 *      movie (0x53DC08E0, two rows of 0x30) and a position per layout (0x53DBF9BC, four layouts of
 *      0x30 x/y pairs: still, movie, and the two for the 1280x720 output). Shutter speed (item
 *      30), aperture (31) and ISO (32) do not exist for movies and have no position in the movie
 *      layouts. They now exist there, at the still layouts' positions (the bottom line is the
 *      same in both: mode icon, then these three, exposure compensation, battery). Their update
 *      functions (0x5318C218, 0x5318C410, 0x5318C654) do not look at still / movie themselves.
 *  (5) The ISO function of the buttons (0x53396344: sends command 0x47, the ISO setting) returns
 *      without doing anything for a movie; that branch is not taken any more.
 *
 * The dials and the values (test 089c; in 089b the three items stayed empty, the dials did nothing
 * and the ISO setting opened by the ISO button showed no value; the exposure did follow the mode
 * and the values set for stills):
 *  (6) What a dial does comes from 0x533F7844: the function set for the effective shooting mode,
 *      and for a movie (as the auto exposure sees it, 0x5377CAB8) everything but exposure
 *      compensation is made "nothing". That is not done any more: the three dial handlers
 *      (CaptureReadySwitchFunctionModel, 0x53392BC8 and its two siblings) then send the same
 *      commands as for a still (0x39..0x40: Tv, Av, ISO, exposure compensation up / down), which
 *      the shooting-mode controller carries out without a look at still / movie.
 *  (7) CaptureReadyModel's texts for the shutter speed (0x533A8270), the aperture (0x533A8688),
 *      the ISO icon (0x533A88FC) and the ISO value (0x533A89E0) take a "movie" argument and give
 *      an empty text (no icon) when it is set. The shooting screen's three items and the
 *      exposure-setting view (0x531BF1F8, the ISO setting among it) now pass 0: seven places, the
 *      argument loaded right before each call.
 *
 * Bulb from the dial (test 089d; 089c works: values shown, dials and ISO setting as for stills, and
 * the camera itself keeps the shutter speed within the movie's range, 1/60 at 60p, in Tv):
 *  (8) In M with a fixed ISO, one step slower than the slowest shutter speed is B (then T, B+T):
 *      the shutter-speed step (0x5325A958) sets the bulb state when the dial goes slower at the
 *      limit, unless the ISO is auto (0x53258B68). For a movie that limit is the movie's, so one
 *      step past 1/60 went to B, which (3) records in P. For a movie the step now answers the
 *      "ISO auto" question with yes: the shutter speed stops at the limit as in Tv. A B / T set
 *      for stills before changing to movie is still recorded in P, and the dial leads out of it.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord } from './arm';
import { ICON_CATALOG, Patch, expectWord } from './build';
import { adr } from '../target';

/** `ldrb r0, [r0, #0xb76]; bx lr`: 0 still, 1 movie. */
const STILL_MOVIE_GETTER = adr(0x5329b310);
/** `ldrb r0, [r0, #0xb74]; bx lr`: 1 or 2 keeps M out of bulb / time. */
const BULB_GATE_GETTER = adr(0x5329b300);
/** (1) `bne <movie: P>` after `bl STILL_MOVIE_GETTER; cmp r0, #0` in the virtual mode. */
const VIRTUAL_MODE_MOVIE = adr(0x53258e14);
/** (2) `ldmne sp, {r4-r9, fp, sp, pc}` (movie: return) after `bl STILL_MOVIE_GETTER; cmp r0, #0` in the auto flags. */
const ISO_SETTING_MOVIE = adr(0x53258f3c);
/** (3) `bl BULB_GATE_GETTER` in the update of the shooting mode (r0 = the settings). */
const BULB_GATE_SITE = adr(0x53259aec);

/** (4) "exists" bytes of the shooting screen's items: row 0 still, row 1 movie, 0x30 bytes each. */
const SCREEN_ITEMS = adr(0x53dc08e0);
/** (4) positions: four layouts (still, movie, still 1280x720, movie 1280x720) of 0x30 (x, y) pairs of words. */
const SCREEN_POSITIONS = adr(0x53dbf9bc);
const ITEM_ROW = 0x30;
const LAYOUT = 0x180;
/** Shutter speed, aperture, ISO: x in the two still layouts; y is 440 (720x480) and 680 (1280x720). */
const EXPOSURE_ITEMS = [{ item: 30, x: 40 }, { item: 31, x: 200 }, { item: 32, x: 330 }] as const;
const LAYOUT_Y = [440, 440, 680, 680] as const;
/** (5) `beq <return>` after `bl STILL_MOVIE_GETTER; cmp r0, #1` in the buttons' ISO function. */
const ISO_BUTTON_MOVIE = adr(0x53396400);

/** The auto exposure's "movie" (`bl` target of the places below). */
const AE_IS_MOVIE = adr(0x5377cab8);
/** (6) `bne <keep>` after `bl AE_IS_MOVIE; cmp r0, #1`; then `cmp r4, #3; movne r4, #0`. */
const DIAL_FUNCTION_MOVIE = adr(0x533f7888);
/** (7) The texts' functions, and the places that load their "movie" argument (r2): [place, the word there, the call's distance, the function]. */
const TEXT_TV = adr(0x533a8270);
const TEXT_AV = adr(0x533a8688);
const ICON_ISO = adr(0x533a88fc);
const TEXT_ISO = adr(0x533a89e0);
const MOV_R2_R5 = 0xe1a02005;
const MOV_R2_R0 = 0xe1a02000;
const LDRB_R2_R3_980 = 0xe5d32980;
const LDRB_R2_IP_980 = 0xe5dc2980;
const MOVIE_ARGUMENTS: readonly { at: number; word: number; call: number; link: boolean; to: number; what: string }[] = [
  { at: adr(0x533a841c), word: MOV_R2_R5, call: 0x0c, link: false, to: TEXT_TV, what: 'shutter speed text' },
  { at: adr(0x5318c344), word: LDRB_R2_R3_980, call: 0x0c, link: true, to: TEXT_AV, what: 'aperture text, shooting screen' },
  { at: adr(0x531bd80c), word: MOV_R2_R0, call: 0x10, link: true, to: TEXT_AV, what: 'aperture text, exposure setting' },
  { at: adr(0x5318c514), word: LDRB_R2_R3_980, call: 0x04, link: true, to: ICON_ISO, what: 'ISO icon, shooting screen' },
  { at: adr(0x533a89c8), word: MOV_R2_R0, call: 0x14, link: false, to: ICON_ISO, what: 'ISO icon, exposure setting' },
  { at: adr(0x5318c57c), word: LDRB_R2_IP_980, call: 0x18, link: true, to: TEXT_ISO, what: 'ISO text, shooting screen' },
  { at: adr(0x533a8b10), word: MOV_R2_R5, call: 0x08, link: true, to: TEXT_ISO, what: 'ISO text, exposure setting' },
];
const MOV_R2_0 = 0xe3a02000;
/** (8) `bl ISO_AUTO_NOW` in the shutter-speed step (r5 = the settings, r0 = the controller); then `cmp r0, #0; bne <plain step>`. */
const BULB_STEP_SITE = adr(0x5325aa78);
const ISO_AUTO_NOW = adr(0x53258b68);
const BULB_STATE_SETTER = adr(0x532b63f0);

const NOP = 0xe1a00000;
const BX_LR = 0xe12fff1e;
const CMP_R0_0 = 0xe3500000;

function fail(message: string): never {
  throw new FirmwareError('internal', `movie exposure: ${message}`);
}

export function installMovieExposure(patch: Patch): void {
  expectWord(patch, STILL_MOVIE_GETTER, 0xe5d00b76);
  expectWord(patch, STILL_MOVIE_GETTER + 4, BX_LR);
  expectWord(patch, BULB_GATE_GETTER, 0xe5d00b74);
  expectWord(patch, BULB_GATE_GETTER + 4, BX_LR);
  // (1) mov r5, r0; bl getter; cmp r0, #0; bne movie
  expectWord(patch, VIRTUAL_MODE_MOVIE - 8, branchWord(VIRTUAL_MODE_MOVIE - 8, STILL_MOVIE_GETTER, 14, true));
  expectWord(patch, VIRTUAL_MODE_MOVIE - 4, CMP_R0_0);
  expectWord(patch, VIRTUAL_MODE_MOVIE, 0x1a00000a);
  expectWord(patch, VIRTUAL_MODE_MOVIE + 4, 0xe3540007); // cmp r4, #7: the still's path
  // (2) mov r0, r8; bl getter; cmp r0, #0; ldmne (return)
  expectWord(patch, ISO_SETTING_MOVIE - 8, branchWord(ISO_SETTING_MOVIE - 8, STILL_MOVIE_GETTER, 14, true));
  expectWord(patch, ISO_SETTING_MOVIE - 4, CMP_R0_0);
  expectWord(patch, ISO_SETTING_MOVIE, 0x189dabf0);
  expectWord(patch, ISO_SETTING_MOVIE + 4, 0xe1a00008); // mov r0, r8: the still's path
  // (3) mov r0, r5; bl getter; mov sb, r0
  expectWord(patch, BULB_GATE_SITE - 4, 0xe1a00005);
  expectWord(patch, BULB_GATE_SITE, branchWord(BULB_GATE_SITE, BULB_GATE_GETTER, 14, true));
  expectWord(patch, BULB_GATE_SITE + 4, 0xe1a09000);

  // As the getter (r0 = the settings; returns in r0), r1 also changes: the caller sets r1 anew
  // before it is read (mov r1, r6 at +0x20), as after any call.
  const gate = patch.append((at) => assembleWords(
    `ldrb r1, [r0, #0xb76]
     ldrb r0, [r0, #0xb74]
     cmp r1, #1
     moveq r0, #1
     bx lr`, at), 4);
  if (gate % 4 !== 0) fail('unaligned code');
  patch.setWord(VIRTUAL_MODE_MOVIE, NOP, 'movie exposure: virtual shooting mode as for a still');
  patch.setWord(ISO_SETTING_MOVIE, NOP, 'movie exposure: the ISO setting also for movies');
  patch.setWord(BULB_GATE_SITE, branchWord(BULB_GATE_SITE, gate, 14, true), 'movie exposure: no bulb / time for a movie');

  // (4) The items: rows as in the official tables (still: all three exist; movie: none of them,
  // exposure compensation (33) and the battery (34) do), positions only in the still layouts.
  const movieRow = SCREEN_ITEMS + ITEM_ROW;
  expectWord(patch, SCREEN_ITEMS + 28, 0x01010101);
  expectWord(patch, SCREEN_ITEMS + 32, 0x01010101);
  expectWord(patch, movieRow + 28, 0x00000000);
  expectWord(patch, movieRow + 32, 0x00010100);
  for (const { item, x } of EXPOSURE_ITEMS) {
    for (const layout of [0, 1, 2, 3]) {
      const at = SCREEN_POSITIONS + layout * LAYOUT + item * 8;
      const still = layout % 2 === 0;
      expectWord(patch, at, still ? x : 0);
      expectWord(patch, at + 4, still ? LAYOUT_Y[layout] : 0);
    }
  }
  patch.setWord(movieRow + 28, 0x01010000, 'movie exposure: shutter speed and aperture on the movie screen');
  patch.setWord(movieRow + 32, 0x00010101, 'movie exposure: ISO on the movie screen');
  for (const { item, x } of EXPOSURE_ITEMS) {
    for (const layout of [1, 3]) {
      const at = SCREEN_POSITIONS + layout * LAYOUT + item * 8;
      patch.setWord(at, x, 'movie exposure: position on the movie screen');
      patch.setWord(at + 4, LAYOUT_Y[layout], 'movie exposure: position on the movie screen');
    }
  }

  // (5) bl getter; cmp r0, #1; beq return; ...; mov r1, #0x47
  expectWord(patch, ISO_BUTTON_MOVIE - 8, branchWord(ISO_BUTTON_MOVIE - 8, STILL_MOVIE_GETTER, 14, true));
  expectWord(patch, ISO_BUTTON_MOVIE - 4, 0xe3500001);
  expectWord(patch, ISO_BUTTON_MOVIE, 0x0affffdf);
  expectWord(patch, ISO_BUTTON_MOVIE + 0x14, 0xe3a01047);
  patch.setWord(ISO_BUTTON_MOVIE, NOP, 'movie exposure: the ISO button also for movies');

  // (6) bl AE_IS_MOVIE; cmp r0, #1; bne keep; cmp r4, #3; movne r4, #0; keep: mov r0, r4
  expectWord(patch, DIAL_FUNCTION_MOVIE - 8, branchWord(DIAL_FUNCTION_MOVIE - 8, AE_IS_MOVIE, 14, true));
  expectWord(patch, DIAL_FUNCTION_MOVIE - 4, 0xe3500001);
  expectWord(patch, DIAL_FUNCTION_MOVIE, 0x1a000001);
  expectWord(patch, DIAL_FUNCTION_MOVIE + 4, 0xe3540003);
  expectWord(patch, DIAL_FUNCTION_MOVIE + 8, 0x13a04000);
  expectWord(patch, DIAL_FUNCTION_MOVIE + 12, 0xe1a00004);
  patch.setWord(DIAL_FUNCTION_MOVIE, branchWord(DIAL_FUNCTION_MOVIE, DIAL_FUNCTION_MOVIE + 12), 'movie exposure: the dials as for a still');

  // (7) The functions begin with the test of the argument (r2; the shutter speed's has it in r5 by then).
  expectWord(patch, TEXT_TV + 0x40, 0xe3550000); // cmp r5, #0 (mov r5, r2 at +0x20)
  expectWord(patch, TEXT_TV + 0x20, 0xe1a05002);
  expectWord(patch, TEXT_AV, 0xe3520000); // cmp r2, #0
  expectWord(patch, ICON_ISO + 8, 0xe1a04002); // mov r4, r2
  expectWord(patch, ICON_ISO + 0x1c, 0xe3540000); // cmp r4, #0
  expectWord(patch, TEXT_ISO + 4, 0xe3520000); // cmp r2, #0
  for (const { at, word, call, link, to } of MOVIE_ARGUMENTS) {
    expectWord(patch, at, word);
    // The call itself, or an earlier addition's code in its place that goes on to the function (Sensor Shift's, at the
    // shooting screen's ISO icon: `shift.ts`): a branch of the same kind into the appended area.
    const w = patch.word(at + call);
    if (!(w >>> 24 === (link ? 0xeb : 0xea) && branchTarget(at + call, w) >= ICON_CATALOG - 0x40)) expectWord(patch, at + call, branchWord(at + call, to, 14, link));
  }
  for (const { at, what } of MOVIE_ARGUMENTS) patch.setWord(at, MOV_R2_0, `movie exposure: ${what}`);

  // (8) mov r0, r7; bl ISO_AUTO_NOW; cmp r0, #0; bne plain; mov r0, r5; mov r1, #1; bl BULB_STATE_SETTER
  expectWord(patch, BULB_STEP_SITE - 4, 0xe1a00007);
  expectWord(patch, BULB_STEP_SITE, branchWord(BULB_STEP_SITE, ISO_AUTO_NOW, 14, true));
  expectWord(patch, BULB_STEP_SITE + 4, 0xe3500000);
  expectWord(patch, BULB_STEP_SITE + 8, 0x1affffc7);
  expectWord(patch, BULB_STEP_SITE + 12, 0xe1a00005);
  expectWord(patch, BULB_STEP_SITE + 16, 0xe3a01001);
  expectWord(patch, BULB_STEP_SITE + 20, branchWord(BULB_STEP_SITE + 20, BULB_STATE_SETTER, 14, true));
  // r5 is the step's own copy of the settings (mov r5, r0 after the getter, kept to its end); r1 is set anew after the call.
  const noBulb = patch.append((at) => [
    ...assembleWords(
      `ldrb r1, [r5, #0xb76]
       cmp r1, #1
       moveq r0, #1
       bxeq lr`, at),
    branchWord(at + 16, ISO_AUTO_NOW),
  ], 4);
  if (noBulb % 4 !== 0) fail('unaligned code');
  patch.setWord(BULB_STEP_SITE, branchWord(BULB_STEP_SITE, noBulb, 14, true), 'movie exposure: the shutter speed stops at the movie limit in M');
}
