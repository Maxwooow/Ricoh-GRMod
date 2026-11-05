// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60, round 7: the settings guard of GR Mod 0.8.2 (GR IV: ../aspect/guard.ts).
 * Values the settings records can hold that this firmware does not know are put back to factory
 * ones when the settings are loaded (start), saved (power off) and when a mode (U1..U3) is
 * recalled: a value chosen under an earlier GR Mod firmware (a film, an added ratio) stays in the
 * settings when a firmware with fewer additions is written, and the firmware would look it up
 * past its tables.
 *
 * The settings object (UserDataModel, 0x55063f30) holds the record in use at +4 and the seven
 * stored ones (modes, U1..U3) at +8..+0x20, each 0xb28 bytes, all saved and loaded whole:
 *  - the look of photo set n at +0x1c2 + 2n and of movie set n at +0x57e + 2n (n = 0..2; the
 *    movie setters write all eight records): the camera's own looks are 11..22, a film is
 *    64 + k (k below the build's count). Anything else becomes Standard (11);
 *  - the aspect ratio at +0x4c2 (getter 0x53245260): 0..3 are the camera's own (3:2 = 0, 1:1 = 3),
 *    added ratios 4..3 + n. Anything above becomes 3:2 (0).
 *  - round 8 (as GR Mod 0.8.4), looks hidden from the Image Control lists (look-layout.ts): the look
 *    of the standard photo set (0x1c2) and of the standard movie set (0x57e), the ones picked from
 *    the lists, becomes Standard when it is hidden (the lists are built without hidden looks, so a
 *    hidden look could only be selected by settings an earlier firmware left). The custom sets'
 *    looks (Custom 1 / 2: +0x1c4, +0x1c6, +0x580, +0x582) are kept: they are entries of their own.
 * Soft focus, the date imprint and the End Screen picture live in padding bytes (0x9a1..0x9ab)
 * that only those additions read; each reader already treats an unknown value as off / factory.
 *
 * Hooks: the settings load's only call (0x5324b754, after GR Mod's own load of the films' table
 * when there is one), the power-off save's tail call (0x5322b0a8, before the save) and the mode
 * recall's copy of a stored record into the record in use (0x5327a004, `bl memcpy`, then the
 * record goes to the live values at 0x5327a018).
 */
import { branchWord } from '../aspect/arm';
import { FirmwareError } from '../types';
import { GR3X_LOAD_CALL, GR3X_LOAD_DATA, GR3X_SAVE_CALL, GR3X_SAVE_DATA } from './look-addresses';
import { gr3xSettingsHook, gr3xSettingsPrior } from './round10';
import type { Gr3xSite } from './round10';

export const GR3X_STANDARD_LOOK = 11;
const OWN_LOOKS = [11, 22] as const;
const FIRST_FILM = 64;
const LOOKS = [0x1c2, 0x1c4, 0x1c6, 0x57e, 0x580, 0x582];
const RATIO = 0x4c2;
const RECORDS = 8;
/** The mode recall: memcpy(record in use, stored record, 0xb26). */
export const GR3X_RECALL_COPY = 0x5327a004;
const MEMCPY = 0x5313fd80;

export interface Gr3xGuardProgram {
  code(source: string): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  u32(address: number): number;
}
export interface Gr3xGuardOptions {
  /** Films of the build (looks 64..63 + films). */
  films: number;
  /** The largest ratio identity of the build's menu (3 + added ratios). */
  maxRatio: number;
  /** Round 8: looks hidden from the lists (never Standard). */
  hidden?: readonly number[];
  /** Round 10 with soft focus on function 0x09 (adj-softfocus.ts): a record whose soft focus is on
   * (byte 0x9a1 1..3) and that has it on no ADJ slot gets 0x09 on the slots holding 0x13, where
   * rounds 6..9 had it; with 0x13 on no slot either, soft focus is turned off (byte 0): the level
   * decides alone (GR IV), and soft focus that no ADJ slot shows could not be seen or changed. */
  softFocusR10?: boolean;
}
const SOFT_FOCUS_BYTE = 0x9a1;
const ADJ_SLOT_BYTES = [0x918, 0x91a, 0x91c, 0x91e, 0x920];
/** The standard photo and movie sets' looks (the others are the custom sets'). */
const CURRENT_LOOKS = [0x1c2, 0x57e];

const fail = (m: string): never => { throw new FirmwareError('unexpected-instruction', `IIIx settings guard: ${m}`); };
const bl = (at: number, target: number) => (0xeb000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;

/** `fix(record)` and `fixAll(settings object)`: only r0..r3 and the flags change (leaf code). */
export function installGr3xGuardCode(p: Gr3xGuardProgram, o: Gr3xGuardOptions) {
  if (!Number.isInteger(o.films) || o.films < 0 || o.films > 20) fail('number of films');
  if (!Number.isInteger(o.maxRatio) || o.maxRatio < 3 || o.maxRatio > 10) fail('ratio identities');
  const lines = ['cmp r0,#0', 'bxeq lr'];
  LOOKS.forEach((off, i) => {
    lines.push(`ldrb r2,[r0,#${off}]`, `sub r3,r2,#${OWN_LOOKS[0]}`, `cmp r3,#${OWN_LOOKS[1] - OWN_LOOKS[0]}`, `bls look${i}`);
    if (o.films > 0) lines.push(`sub r3,r2,#${FIRST_FILM}`, `cmp r3,#${o.films}`, `blo look${i}`);
    lines.push(`mov r2,#${GR3X_STANDARD_LOOK}`, `strb r2,[r0,#${off}]`, `look${i}:`);
    if (CURRENT_LOOKS.includes(off) && o.hidden?.length) {
      lines.push(`ldrb r2,[r0,#${off}]`, `mov r3,#${GR3X_STANDARD_LOOK}`);
      for (const h of o.hidden) {
        if (h === GR3X_STANDARD_LOOK || !Number.isInteger(h) || h < 0 || h > 255) fail('a hidden look');
        lines.push(`cmp r2,#${h}`, `strbeq r3,[r0,#${off}]`);
      }
    }
  });
  lines.push(`ldrb r2,[r0,#${RATIO}]`, `cmp r2,#${o.maxRatio}`, 'movhi r2,#0', `strbhi r2,[r0,#${RATIO}]`);
  if (o.softFocusR10) {
    lines.push(`ldrb r2,[r0,#${SOFT_FOCUS_BYTE}]`, 'sub r2,r2,#1', 'cmp r2,#2', 'bxhi lr');
    for (const f of ADJ_SLOT_BYTES) lines.push(`ldrb r2,[r0,#${f}]`, 'cmp r2,#9', 'bxeq lr');
    lines.push('mov r3,#9', 'mov r1,#0');
    for (const f of ADJ_SLOT_BYTES) lines.push(`ldrb r2,[r0,#${f}]`, 'cmp r2,#0x13', `strbeq r3,[r0,#${f}]`, 'moveq r1,#1');
    // Still on no slot: soft focus off (rounds 6..9 applied it only from a slot; on no slot it could
    // not be seen or changed).
    lines.push('cmp r1,#0', `strbeq r1,[r0,#${SOFT_FOCUS_BYTE}]`);
  }
  lines.push('bx lr');
  const fix = p.code(lines.join(';'));
  // fixAll(object): the record in use and the stored ones (object + 4 .. object + 0x20).
  const fixAll = p.code(`cmp r0,#0;bxeq lr;push {r4,r5,r6,lr};mov r4,r0;mov r5,#0;
    loop:add r6,r4,r5,lsl #2;ldr r0,[r6,#4];bl #${fix};add r5,r5,#1;cmp r5,#${RECORDS};blo loop;pop {r4,r5,r6,pc};`);
  return { fix, fixAll };
}

/** The mode recall: the record just copied into use. */
export function installGr3xGuardRecall(p: Gr3xGuardProgram, fix: number, before?: number) {
  if (p.u32(GR3X_RECALL_COPY) !== bl(GR3X_RECALL_COPY, MEMCPY) || p.u32(GR3X_RECALL_COPY - 0x18) !== 0xe5950004 || p.u32(GR3X_RECALL_COPY - 0x50) !== 0xe1a05000 ||
      p.u32(GR3X_RECALL_COPY + 0x14) !== bl(GR3X_RECALL_COPY + 0x14, 0x532750f8)) fail('mode recall');
  // `before(settings object)` (the films' own parameters, slots3.c): r5 holds the object here.
  const pre = before ? `push {r0,r1,r2,r3,r4,lr};mov r0,r5;bl #${before};pop {r0,r1,r2,r3,r4,lr};` : '';
  const recall = p.code(`${pre}push {r4,lr};mov r4,r0;bl #${MEMCPY};mov r0,r4;bl #${fix};mov r0,r4;pop {r4,pc};`);
  p.patch(GR3X_RECALL_COPY, bl(GR3X_RECALL_COPY, MEMCPY), bl(GR3X_RECALL_COPY, recall), 'settings guard: a recalled mode');
  return recall;
}

/** The whole guard when nothing else hooks the settings load and save (builds without films). */
export function installGr3xGuard(p: Gr3xGuardProgram, o: Gr3xGuardOptions) {
  const { fix, fixAll } = installGr3xGuardCode(p, o);
  if (p.u32(GR3X_LOAD_CALL) !== bl(GR3X_LOAD_CALL, GR3X_LOAD_DATA) || p.u32(GR3X_SAVE_CALL) !== branchWord(GR3X_SAVE_CALL, GR3X_SAVE_DATA)) fail('settings load / save');
  const load = p.code(`push {r4,r5,r6,lr};mov r4,r0;bl #${GR3X_LOAD_DATA};mov r5,r0;mov r0,r4;bl #${fixAll};mov r0,r5;pop {r4,r5,r6,pc};`);
  p.patch(GR3X_LOAD_CALL, bl(GR3X_LOAD_CALL, GR3X_LOAD_DATA), bl(GR3X_LOAD_CALL, load), 'settings guard: after the settings load');
  const save = p.code(`push {r4,lr};mov r4,r0;bl #${fixAll};mov r0,r4;pop {r4,lr};b #${GR3X_SAVE_DATA};`);
  p.patch(GR3X_SAVE_CALL, branchWord(GR3X_SAVE_CALL, GR3X_SAVE_DATA), branchWord(GR3X_SAVE_CALL, save), 'settings guard: before the settings save');
  const recall = installGr3xGuardRecall(p, fix);
  return { guardFix: fix, guardFixAll: fixAll, guardLoad: load, guardSave: save, guardRecall: recall };
}

/**
 * Round 10 (GR IV's installSettingsGuard): through the settings scaffold (round10.ts), installed after
 * everything else that hooks the settings load and save: the load runs what was there, then the
 * guard; the save the guard, then what was there. The mode recall as before (`before`: the films'
 * table first).
 */
export function installGr3xGuardR10(p: Gr3xGuardProgram & { sites: Gr3xSite[] }, o: Gr3xGuardOptions, before?: number) {
  const { fix, fixAll } = installGr3xGuardCode(p, o);
  const priorLoad = gr3xSettingsPrior(p, 'load'), priorSave = gr3xSettingsPrior(p, 'save');
  const load = p.code(`push {r4,r5,r6,lr};mov r4,r0;bl #${priorLoad};mov r5,r0;mov r0,r4;bl #${fixAll};mov r0,r5;pop {r4,r5,r6,pc};`);
  gr3xSettingsHook(p, 'load', load, 'settings guard: after the settings load');
  const save = p.code(`push {r4,lr};mov r4,r0;bl #${fixAll};mov r0,r4;pop {r4,lr};b #${priorSave};`);
  gr3xSettingsHook(p, 'save', save, 'settings guard: before the settings save');
  const recall = installGr3xGuardRecall(p, fix, before);
  return { guardFix: fix, guardFixAll: fixAll, guardLoad: load, guardSave: save, guardRecall: recall };
}
