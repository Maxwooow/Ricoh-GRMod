// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: ISO Setting › Minimum Shutter Speed continues past 1" to 30" (issue #25).
 *
 * The camera's list (SvAutoLowerTvSetController) has 31 values, 1/1000 .. 1", read from a table of
 * (numerator, denominator) halfwords at LIST: the camera's third-stop shutter table at STEPS
 * (60 entries, 30" .. 1/25600, Tv = i/3 - 5) read backwards from 1/1000 (index 45) to 1" (index 15).
 * Here the list reads STEPS itself backwards from index 45 down to index 0: 46 values, the 31 of
 * before in the same order, then 1.3" .. 30". Only LIST's three readers refer to it (checked: no
 * other code loads its address). The setting is stored as the Tv the set function computes from
 * the pair (0x536c0870 -> 0x53242768), not as an index, so nothing indexes a table with it.
 *
 * Words changed (all in place; nothing is appended):
 *  - set (SET): the table, and the index counts backwards (`sub`, `ldrh [r3,-r0]`);
 *  - rows (ROWS) and marking the current value (CURRENT): the table, backwards, 46 rows;
 *  - Down held at the last row stops there (KEYS): last index 45;
 *  - create (CREATE): the official function fills 31 row types (0x15) into a 31-byte stack buffer;
 *    it becomes one with a 0x34-byte buffer that fills 46 (and has no stack guard: its loop
 *    writes exactly 46 bytes). The rest of the old body becomes NOPs.
 * GR III 2.20 test 1 (the official 2.20 with exactly these words, issue #25) was camera-tested by
 * the requester: the list, 8" and 30" as the Auto ISO limit in Av, kept over power off, and an
 * overnight interval run of 35 s intervals reaching 30" at ISO 100.
 */
import { branchWord, movWord } from '../aspect/arm';
import { FirmwareError } from '../types';

/** The list's functions: Down (key handler), set the value, create, populate the rows, mark the current value. */
const KEYS = 0x531cf710, SET = 0x531cf7a8, CREATE = 0x531cf948, ROWS = 0x531cf9d8, CURRENT = 0x531cfa68;
/** The 31 (num, den) pairs of the official list, and the camera's 60-entry third-stop table. */
const LIST = 0x53b42210, STEPS = 0x53d62b80;
/** The list widget's create (r0 list, r1 row types, r2 count, r3 style) and the stack guard. */
const LIST_CREATE = 0x53394610, CANARY = 0x5405577c, STACK_FAIL = 0x53820074;

export const GR3X_MIN_SHUTTER_OFFICIAL = 31;
export const GR3X_MIN_SHUTTER_VALUES = 46;
const FIRST = STEPS + 45 * 4;   // 1/1000

export interface Gr3xMinShutterProgram {
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}

const NOP = 0xe320f000;
/** The official create, from its third word (the first two, `mov ip,sp; push {r4,fp,ip,lr,pc}`, stay). */
function officialCreate(): number[] {
  return [movWord(4, CANARY & 0xffff), movWord(4, CANARY >>> 16, true), 0xe24cb004, 0xe24dd02c, 0xe5942000, 0xe24b3038,
    0xe24b1019, 0xe3a0c000, 0xe50b2018, 0xe3a02015, 0xe50bc038, 0xe50bc034, 0xe50bc030, 0xe50bc02c, 0xe50bc028, 0xe50bc024,
    0xe50bc020, 0xe14bc1bc, 0xe54bc01a, 0xe4c32001, 0xe1530001, 0x1afffffc, 0xe5900160, 0xe3a0201f, 0xe3a0303a, 0xe24b1038,
    branchWord(CREATE + 4 * 28, LIST_CREATE, 14, true), 0xe51b2018, 0xe5943000, 0xe1520003, 0x1a000001, 0xe24bd010, 0xe89da810];
}
/** The new create from its third word: sub fp,ip,#4; sub sp,sp,#0x34; mov r4,r0; mov r1,sp; mov r2,#0x15;
 * mov r3,#46; fill: strb r2,[r1],#1; subs r3,r3,#1; bne fill; ldr r0,[r4,#0x160]; mov r1,sp; mov r2,#46;
 * mov r3,#0x3a; bl LIST_CREATE; sub sp,fp,#0x10; ldm sp,{r4,fp,sp,pc}; then NOPs. */
function newCreate(): number[] {
  const n = GR3X_MIN_SHUTTER_VALUES;
  const body = [0xe24cb004, 0xe24dd034, 0xe1a04000, 0xe1a0100d, 0xe3a02015, 0xe3a03000 | n, 0xe4c12001, 0xe2533001, 0x1afffffc,
    0xe5940160, 0xe1a0100d, 0xe3a02000 | n, 0xe3a0303a, branchWord(CREATE + 4 * 15, LIST_CREATE, 14, true), 0xe24bd010, 0xe89da810];
  return [...body, ...new Array(33 - body.length).fill(NOP)];
}

/** Install the longer list; every word is checked against the official one first (`patch`). */
export function installGr3xMinShutter(p: Gr3xMinShutterProgram): Record<string, number> {
  // The create function's frame and its stack-guard tail, and the table the list reads now.
  if (p.word(CREATE) !== 0xe1a0c00d || p.word(CREATE + 4) !== 0xe92dd810 || p.word(CREATE + 4 * 35) !== branchWord(CREATE + 4 * 35, STACK_FAIL, 14, true))
    throw new FirmwareError('unexpected-layout', 'IIIx Minimum Shutter Speed list: create function');
  // STEPS[15] is 1" and STEPS[45] 1/1000, as the official list's ends; STEPS[0] is 30".
  const pair = (at: number) => [p.word(at) & 0xffff, p.word(at) >>> 16];
  const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
  if (!same(pair(STEPS), [30, 1]) || !same(pair(STEPS + 15 * 4), [1, 1]) || !same(pair(FIRST), [1, 1000]) ||
      !same(pair(LIST), pair(FIRST)) || !same(pair(LIST + 30 * 4), pair(STEPS + 15 * 4)))
    throw new FirmwareError('unexpected-layout', 'IIIx Minimum Shutter Speed tables');
  for (let k = 0; k < GR3X_MIN_SHUTTER_OFFICIAL; k++)
    if (p.word(LIST + 4 * k) !== p.word(FIRST - 4 * k)) throw new FirmwareError('unexpected-layout', 'IIIx Minimum Shutter Speed list is not the third-stop table');
  const n = GR3X_MIN_SHUTTER_VALUES, why = 'Minimum Shutter Speed to 30"';
  const table = (low: number, high: number, r: number, what: string) => {
    p.patch(low, movWord(r, LIST & 0xffff), movWord(r, FIRST & 0xffff), `${why}: ${what} reads the third-stop table`);
    p.patch(high, movWord(r, LIST >>> 16, true), movWord(r, FIRST >>> 16, true), `${why}: ${what} reads the third-stop table`);
  };
  // Down held at the last row.
  p.patch(KEYS + 0x3c, 0xe350001e, 0xe3500000 | (n - 1), `${why}: the last row`);
  // Set the value: entry i is FIRST - 4i.
  table(SET + 0x18, SET + 0x1c, 3, 'set');
  p.patch(SET + 0x24, 0xe0832000, 0xe0432000, `${why}: set counts backwards`);
  p.patch(SET + 0x28, 0xe19350b0, 0xe11350b0, `${why}: set counts backwards`);
  // Create: 46 row types.
  const was = officialCreate(), now = newCreate();
  for (let i = 0; i < was.length; i++) if (was[i] !== now[i]) p.patch(CREATE + 8 + 4 * i, was[i], now[i], `${why}: create the list with 46 rows`);
  // Rows.
  table(ROWS + 0x10, ROWS + 0x1c, 4, 'rows');
  p.patch(ROWS + 0x68, 0xe355001f, 0xe3550000 | n, `${why}: 46 rows`);
  p.patch(ROWS + 0x6c, 0xe2844004, 0xe2444004, `${why}: rows backwards`);
  // Mark the current value.
  table(CURRENT + 0x28, CURRENT + 0x48, 5, 'marking');
  p.patch(CURRENT + 0x80, 0xe2855004, 0xe2455004, `${why}: marking backwards`);
  p.patch(CURRENT + 0x88, 0xe354001f, 0xe3540000 | n, `${why}: marking, 46 rows`);
  p.patch(CURRENT + 0xc4, 0xe2855004, 0xe2455004, `${why}: marking backwards`);
  p.patch(CURRENT + 0xdc, 0xe354001f, 0xe3540000 | n, `${why}: marking, 46 rows`);
  return { minShutterCreate: CREATE, minShutterTable: FIRST };
}
