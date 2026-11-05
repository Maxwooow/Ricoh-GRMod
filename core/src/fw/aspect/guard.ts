// SPDX-License-Identifier: GPL-2.0-only
/**
 * Settings guard: values the user settings can hold that this firmware does not know are put back
 * to factory ones when the settings are loaded (start), saved (power off) and when a user mode
 * (U1..U3) is recalled. Installed in every build.
 *
 * Why: a value chosen under an earlier GR Mod firmware (an added slot, an added ratio, soft focus
 * on an ADJ slot) stays in the settings when a firmware with fewer additions is written. The
 * firmware then looks the number up past its tables: on the camera the focus frame was drawn off
 * the screen and pressing ADJ froze (test firmware 003, a ratio of an earlier build).
 *
 * The user settings (CURRENT(), 0x55084DD8, and its snapshots, which have the same layout four
 * bytes on, see crop_state.c) hold:
 *  - the look of each photo set (standard, custom 1..3) at 0x153..0x156 and of each movie set at
 *    0x515..0x518. Looks 0..30 are the camera's own (31..33 the firmware itself treats as invalid);
 *    an added slot is 34 + k. Anything from 31 that is not an installed added slot becomes
 *    Standard (11).
 *  - the aspect ratio at 0x49F: 0..3 are the factory ones. With added ratios the ratio module
 *    (crop_state.c) already resets one that is no longer in the menu; without, anything above 3
 *    becomes 3:2 (0).
 *  - the function of each ADJ slot at 0x920..0x924 (0..0x14). Without soft focus on the ADJ lever,
 *    0x0A (soft focus in a GR Mod build) and anything above 0x14 become 0, which is what the slot
 *    getters of a build with soft focus already make of a value above 0x14.
 *  - 0.8.4, looks hidden from the lists (`looks.ts`): the look of the standard photo set (0x153)
 *    and of the standard movie set (0x515), the ones picked from the Image Control / ADJ lists,
 *    becomes Standard (11; the GR IV Monochrome's Standard, 25, for one of its looks 25..30) when
 *    it is hidden. Both lists are built without hidden looks (0x533CC784 and 0x533755BC, through
 *    the visibility check 0x533CC6E0), so a hidden look could only be selected by settings an
 *    earlier firmware left; this way the lists always hold the selected look. The custom sets'
 *    looks (0x154..0x156, 0x516..0x518) are kept: those sets are entries of their own in the
 *    lists (C1..C3), whatever their look, and the look stays installed. RAW development's look
 *    is the file's own ("as shot") and not in the settings.
 */
import { assembleWords, branchTarget, branchWord } from './arm';
import { FirmwareError } from '../types';
import { Patch, expectWord } from './build';

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** CURRENT(): the live user settings. */
const CURRENT = 0x5323f018;
const SETTINGS_SAVE = 0x533e1c04;
const SETTINGS_LOAD = 0x533e17cc;
/** User-mode recall: `bl 0x5323EA84` with the settings in r4 (see build.ts, installState). */
const RECALL = 0x532a90cc;
const RECALL_NATIVE = 0x5323ea84;

const LOOKS = [0x153, 0x154, 0x155, 0x156, 0x515, 0x516, 0x517, 0x518];
const RATIO = 0x49f;
const ADJ_SLOTS = [0x920, 0x921, 0x922, 0x923, 0x924];
export const STANDARD = 11;
export const FIRST_ADDED_LOOK = 34;

export interface GuardOptions {
  /** Number of added slots (looks 34..34 + n - 1). */
  slots: number;
  /** Added ratios are installed (their module resets the ratio). */
  ratios: boolean;
  /** Soft focus on the ADJ lever (function 0x0A) is installed. */
  adjSoftFocus: boolean;
  /** Looks hidden from the lists (0.8.4); never 11 or 25. */
  hiddenLooks?: readonly number[];
}

/** The standard photo and movie sets' looks (the others are custom sets' looks). */
const CURRENT_LOOKS = [0x153, 0x515];
export const MONO_STANDARD = 25;

/** The guard's own `fix(settings, adjust)`, in assembly: settings pointer minus `adjust` is the layout of CURRENT(). */
function fixSource(o: GuardOptions): string {
  const lines: string[] = ['cmp r0,#0', 'bxeq lr', 'sub r0,r0,r1'];
  LOOKS.forEach((off, i) => {
    lines.push(`ldrb r2,[r0,#${off}]`, 'cmp r2,#31', `blo look${i}`);
    if (o.slots > 0) lines.push(`sub r3,r2,#${FIRST_ADDED_LOOK}`, `cmp r3,#${o.slots}`, `blo look${i}`);
    lines.push(`mov r2,#${STANDARD}`, `strb r2,[r0,#${off}]`, `look${i}:`);
    if (CURRENT_LOOKS.includes(off) && o.hiddenLooks && o.hiddenLooks.length > 0) {
      lines.push(`ldrb r2,[r0,#${off}]`);
      for (const h of o.hiddenLooks) {
        if (h === STANDARD || h === MONO_STANDARD || !(Number.isInteger(h) && h > 0 && h < 256)) fail('internal', 'guard: a Standard look cannot be hidden');
        lines.push(`cmp r2,#${h}`, `moveq r3,#${h >= 25 && h <= 30 ? MONO_STANDARD : STANDARD}`, `strbeq r3,[r0,#${off}]`);
      }
    }
  });
  if (!o.ratios) lines.push(`ldrb r2,[r0,#${RATIO}]`, 'cmp r2,#3', 'movhi r2,#0', `strbhi r2,[r0,#${RATIO}]`);
  if (!o.adjSoftFocus) {
    ADJ_SLOTS.forEach((off, i) => {
      lines.push(`ldrb r2,[r0,#${off}]`, 'cmp r2,#10', `beq adjbad${i}`, 'cmp r2,#20', `bls adj${i}`, `adjbad${i}:`, 'mov r2,#0', `strb r2,[r0,#${off}]`, `adj${i}:`);
    });
  }
  lines.push('bx lr');
  return lines.join(';');
}

/**
 * Install the guard. Call last, after everything else that hooks the settings save/load and the
 * user-mode recall (it wraps them).
 */
export function installSettingsGuard(p: Patch, o: GuardOptions): { fix: number; fixMode: number } {
  if (!(Number.isInteger(o.slots) && o.slots >= 0 && o.slots <= 200)) fail('internal', 'guard: number of slots');
  const priorSave = branchTarget(SETTINGS_SAVE, p.word(SETTINGS_SAVE));
  const priorLoad = branchTarget(SETTINGS_LOAD, p.word(SETTINGS_LOAD));
  if (p.word(SETTINGS_SAVE) >>> 24 !== 0xea || p.word(SETTINGS_LOAD) >>> 24 !== 0xea) fail('internal', 'the settings save/load scaffold is not installed');
  const recallWord = p.word(RECALL);
  if (recallWord >>> 24 !== 0xeb) fail('unexpected-layout', 'user-mode recall is not a call');
  const priorRecall = branchTarget(RECALL, recallWord);
  if (priorRecall === RECALL_NATIVE) expectWord(p, RECALL, 0xebfe566c);

  const fix = p.append((a) => assembleWords(fixSource(o), a), 16);
  // fix_mode(mode): the ten snapshots at mode + 4.
  const fixMode = p.append((a) => assembleWords(
    `cmp r0,#0;bxeq lr;push {r4,r5,r6,lr};mov r4,r0;mov r5,#0;
     loop:add r6,r4,r5,lsl #2;ldr r0,[r6,#4];mov r1,#4;bl #${fix};add r5,r5,#1;cmp r5,#10;blo loop;pop {r4,r5,r6,pc}`, a), 16);
  const load = p.append((a) => assembleWords(
    `push {r4,r5,r6,lr};mov r4,r0;mov r5,r1;bl #${priorLoad};mov r6,r0;
     mov r0,r5;mov r1,#4;bl #${fix};mov r0,r4;bl #${fixMode};bl #${CURRENT};mov r1,#0;bl #${fix};
     mov r0,r6;pop {r4,r5,r6,pc}`, a), 16);
  const save = p.append((a) => assembleWords(
    `push {r4,lr};mov r4,r0;bl #${CURRENT};mov r1,#0;bl #${fix};mov r0,r4;bl #${fixMode};mov r0,r4;pop {r4,lr};b #${priorSave}`, a), 16);
  const recall = p.append((a) => assembleWords(
    `push {r0,r1,r2,r3,ip,lr};mov r0,r4;mov r1,#0;bl #${fix};pop {r0,r1,r2,r3,ip,lr};b #${priorRecall}`, a), 16);
  p.setWord(SETTINGS_LOAD, branchWord(SETTINGS_LOAD, load), 'settings load: put back values this firmware does not know');
  p.setWord(SETTINGS_SAVE, branchWord(SETTINGS_SAVE, save), 'settings save: put back values this firmware does not know');
  p.setWord(RECALL, branchWord(RECALL, recall, 14, true), 'user-mode recall: put back values this firmware does not know');
  return { fix, fixMode };
}
