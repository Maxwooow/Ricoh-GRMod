// SPDX-License-Identifier: GPL-2.0-only
/**
 * Halation on the camera's parameter screens (GR Mod 0.8.2): for a look with halation, Cinema's
 * Toning row becomes "Halation" with an Off / On slider like Grain Effect's, and Fn opens Grain
 * Effect's submenu with the halation's own rows: Strength (Weak / Medium / Strong) and Colour
 * (red / white). The same on the RAW development screens.
 *
 * Where the setting lives: the look's Toning byte (parameter 8), which already travels everywhere a
 * look's settings go (photo sets, U1..U3, the added slots' own table, the shooting record and the
 * picture's record, RAW development, the maker note). It holds a state of `HALATION_STATES`: 0, 1, 2
 * keep their meaning of tests 036..042 and 0.8.1 (off, weak red, strong red); 3..11 are the other
 * settings, with Off remembering strength and colour. Test 042 (the camera) showed the byte
 * travels unchanged; native code that would use it as Toning is given 0..2 (development, the
 * Toning slider and text, the maker note's code), see `installHalationClamps`.
 *
 * Shooting (ImageControlDetailController, controller r4/r5/r7, look at +0x19C, +0x1AC 1 = movie):
 *  - row kinds by the dispatchers 0x531CC160 (row), 0x531CC70C (value), 0x531CC93C (slider),
 *    0x531CCFFC (setter); kind 8 is Cinema's Toning, kind 16 Grain Effect (1.20 added kind 18,
 *    Solarized's parameter; 1.11's 18 is 19);
 *  - Fn guide 0x531CC5B4 (kinds 13 and 16), Fn 0x531CCF4C (kind 16 opens screen 0x0200001B,
 *    ImageControlDetailParticleController); slider shown 0x531CC414 (kind 16: availability);
 *  - the submenu: rows from table 0x53DC6D28 {kind, icon, text}: row 0 Size (param 20, scale
 *    0x265), row 1 Strength (param 21, scale 0x261); slider builders 0x531CDEB8 / 0x531CE004, current
 *    value 0x531CE1E0, setter 0x531CE524, row items 0x531CE2E0 / 0x531CE36C, subtitle 0x531CE2A0,
 *    title 0x531CDB74, backup 0x531CE504 (0x533D0C38), cancel 0x531CD8B8 (0x533D0DA0).
 * RAW development (RawDevelopmentImageControlDetailSetController, the look asked from the model):
 *  - dispatchers 0x531AAB20 (row), 0x531AB068 (value), 0x531A9714 (slider), 0x531AB428 (setter);
 *    Fn guide 0x531AA8EC, Fn 0x531ABAE0 (opens 0x04000029, RawDevelopmentImageControlDetail-
 *    ParticleSetController, after backing up grain with 0x5337BD3C);
 *  - its submenu: table 0x53DC6D1C, sliders 0x531AC6FC / 0x531AC844, value 0x531ACA1C, setter
 *    0x531ACD4C, rows 0x531ACB20 / 0x531ACBC0, subtitle 0x531ACAE0, title 0x531AC37C, cancel 0x531AC19C.
 * The submenu screens are Grain Effect's; a word (HAL_FLAG) set when Fn opens them from the
 * Halation row (and cleared from Grain Effect's) switches each of their grain-specific steps.
 */
import { assembleWords, branchWord } from './arm';
import { FirmwareError } from '../../types';
import { Patch, expectWord } from './build';

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** A halation setting: on, strength (0 Weak, 1 Medium, 2 Strong), white (else red). */
export interface HalationSetting { on: boolean; strength: 0 | 1 | 2; white: boolean }

/** The Toning byte's states 0..11 (0, 1, 2 as up to test 042: off, weak red, strong red). */
export const HALATION_STATES: readonly HalationSetting[] = [
  { on: false, strength: 0, white: false },
  { on: true, strength: 0, white: false },
  { on: true, strength: 2, white: false },
  { on: true, strength: 1, white: false },
  { on: true, strength: 0, white: true },
  { on: true, strength: 1, white: true },
  { on: true, strength: 2, white: true },
  { on: false, strength: 1, white: false },
  { on: false, strength: 2, white: false },
  { on: false, strength: 0, white: true },
  { on: false, strength: 1, white: true },
  { on: false, strength: 2, white: true },
];

const bitsOf = (s: HalationSetting): number => (s.on ? 1 : 0) | (s.strength << 1) | (s.white ? 8 : 0);

/** The setting of a Toning byte (anything outside 0..11 is Off). */
export function decodeHalation(v: number): HalationSetting {
  return HALATION_STATES[Number.isInteger(v) && v >= 0 && v < HALATION_STATES.length ? v : 0];
}

/** The Toning byte of a setting. */
export function encodeHalation(s: HalationSetting): number {
  const v = HALATION_STATES.findIndex((x) => bitsOf(x) === bitsOf(s));
  if (v < 0) fail('internal', 'halation: no such setting');
  return v;
}

/** What the JPEG step does for a Toning byte: level 0 (off) .. 3, and the colour (lookstash.ts decodes the same). */
export function halationLevelOf(v: number): { level: 0 | 1 | 2 | 3; white: boolean } {
  const s = decodeHalation(v);
  return { level: s.on ? ((s.strength + 1) as 1 | 2 | 3) : 0, white: s.white };
}

/** Bits per state (on | strength << 1 | white << 3) and back. */
export function halationTables(): { dec: Uint8Array; enc: Uint8Array } {
  const dec = new Uint8Array(16);
  const enc = new Uint8Array(16);
  HALATION_STATES.forEach((s, v) => { dec[v] = bitsOf(s); enc[bitsOf(s)] = v; });
  return { dec, enc };
}

/** RAM words in the 44 bytes before the heap (cleared at every start, see slots.ts / lookstash.ts). */
export const HAL_FLAG = 0x55839028;
export const HAL_SAVE = 0x5583902c;

/** Text of Grain Effect's Strength ("Intensity"), its Size, and the icon of Grain Effect's Strength row. */
const TEXT_STRENGTH = 365;
const TEXT_SIZE = 363;
const TEXT_GRAIN = 0x169;
/** The native scales: Off / On, Grain size, Grain strength (bars). */
const SCALE_SIZE = 0x265;
const SCALE_STRENGTH = 0x261;

/** Current Toning of the selected look (shooting): 0x533CCAF0 (no arguments). */
const SHOOT_CUR = 0x533ccaf0;
/** Toning setter of the selected look and set (shooting): 0x533C7834(settings, value). */
const SHOOT_SET = 0x533c7834;
/** RAW development: the model (0x53240CAC then 0x532412A0), its Toning getter and setter. */
const RAW_MODEL = 'bl #0x53240cac;bl #0x532412a0';
const RAW_GET = 0x5337b280;
const RAW_SET = 0x53381454;
const RAW_LOOK_CALLS = 'bl #0x53240cac;bl #0x532412a0;bl #0x5337aa64';
/** Grain Effect's Off / On text of a value (r0 object, r1 buffer, r2 value). */
const ON_OFF_TEXT = 0x533ab4f0;
/** A number 1..3 for a value 0..2 (r0 object, r1 buffer, r2 value). */
const NUMBER_TEXT = 0x533ab6c4;

export interface HalationUiOptions {
  /** 64-byte tables: looks with halation, by style and by RAW development's number. */
  styles: number;
  raws: number;
  /** Texts and icons GR Mod adds: the parameter's name, its list icon, the colour row's name, the colour scale, red and white row icons. */
  nameText: number;
  icon: number;
  colourText: number;
  colourScale: number;
  redIcon: number;
  whiteIcon: number;
}

function hook(p: Patch, at: number, expected: number, body: string, reason: string): void {
  expectWord(p, at, expected);
  const target = p.append((a) => assembleWords(body, a), 16);
  p.setWord(at, branchWord(at, target), reason);
}

const addr = (r: string, v: number): string => `movw ${r},#${v & 65535};movt ${r},#${v >>> 16}`;
/** `dst` = table[`reg`] (0 for `reg` >= 64), through `tmp`. */
const lookup = (dst: string, reg: string, tmp: string, table: number): string =>
  `cmp ${reg},#64;${addr(tmp, table)};ldrblo ${dst},[${tmp},${reg}];movhs ${dst},#0`;
/** Flags: ne when the submenu was opened from the Halation row. Uses ip. */
const flagTest = `${addr('ip', HAL_FLAG)};ldr ip,[ip];cmp ip,#0`;

/**
 * Install the screens' hooks. `styles` / `raws` must be 64-byte tables in `p`.
 */
export function installHalationUi(p: Patch, o: HalationUiOptions): void {
  const { dec, enc } = halationTables();
  const decAt = p.append(dec, 4);
  const encAt = p.append(enc, 4);
  // field(r0 value, r1 0 on / 1 strength / 2 white) -> r0; uses r2.
  const field = p.append((a) => assembleWords(
    `cmp r0,#12;movhs r0,#0;${addr('r2', decAt)};ldrb r0,[r2,r0]
     cmp r1,#1;beq f1;bhi f2
     and r0,r0,#1;bx lr
     f1:mov r0,r0,lsr #1;and r0,r0,#3;bx lr
     f2:mov r0,r0,lsr #3;and r0,r0,#1;bx lr`, a), 16);
  // put(r0 value, r1 field, r2 new) -> r0 value; uses r3.
  const put = p.append((a) => assembleWords(
    `cmp r0,#12;movhs r0,#0;${addr('r3', decAt)};ldrb r0,[r3,r0]
     cmp r1,#1;beq s1;bhi s2
     bic r0,r0,#1;and r2,r2,#1;orr r0,r0,r2;b enc
     s1:bic r0,r0,#6;cmp r2,#2;movhi r2,#2;orr r0,r0,r2,lsl #1;b enc
     s2:bic r0,r0,#8;and r2,r2,#1;orr r0,r0,r2,lsl #3
     enc:${addr('r3', encAt)};ldrb r0,[r3,r0];bx lr`, a), 16);
  // RAW development's current Toning -> r0.
  const rawCur = p.append((a) => assembleWords(`push {r4,lr};${RAW_MODEL};pop {r4,lr};b #${RAW_GET}`, a), 16);
  /** ip = 1 when the RAW model's look has halation; keeps r0..r3 (lr is lost). */
  const rawHal = `push {r0,r1,r2,r3};${RAW_LOOK_CALLS};${lookup('ip', 'r0', 'r1', o.raws)};pop {r0,r1,r2,r3}`;

  // ---------------------------------------------------------------- shooting: the main row
  // Slider: Grain Effect's Off / On slider (0x531CA638; its default, Grain off, is Off).
  hook(p, 0x531c9654, 0xe1a0c00d, `ldrb r1,[r0,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;bne #0x531ca638;mov ip,sp;b #0x531c9658`, 'halation: Off / On slider');
  // Current slider position (r5 the controller): Off / On.
  hook(p, 0x531cc87c, 0xeb08009b,
    `bl #${SHOOT_CUR};push {r0,r1};ldrb r1,[r5,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;pop {r0,r1};beq tone
     mov r1,#0;bl #${field};mov r4,r0;b #0x531cc7a4
     tone:bl #0x531c825c;mov r4,r0;b #0x531cc7a4`, 'halation: slider position Off / On');
  // The row's value text (r7 the controller, r0 object, r1 buffer): Off / On as Grain Effect's.
  hook(p, 0x531cb43c, 0xeb077ea0,
    `push {r0,r1};ldrb r1,[r7,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;pop {r0,r1};beq tone
     push {r0,r1};bl #${SHOOT_CUR};mov r1,#0;bl #${field};mov r2,r0;pop {r0,r1};bl #${ON_OFF_TEXT};b #0x531cb440
     tone:bl #0x533aaec4;b #0x531cb440`, 'halation: row text Off / On');
  // Setter (r4 controller, r6 slider position, r0 settings): switch on / off, keep the rest.
  hook(p, 0x531cd22c, 0xe3063bc4,
    `push {r0,r1};ldrb r1,[r4,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;pop {r0,r1};beq tone
     push {r0,r1};bl #${SHOOT_CUR};mov r1,#0;mov r2,r6;bl #${put};mov r1,r0;pop {r0,r2};bl #${SHOOT_SET};b #0x531cd23c
     tone:${addr('r3', 0x53de6bc4)};ldrb r1,[r3,r6];bl #${SHOOT_SET};b #0x531cd23c`, 'halation: switch on / off');
  // Fn guide (entry; r4, r6 the guide's views as natively): shown while on, not for movies.
  hook(p, 0x531cc5b4, 0xe1a0c00d,
    `mov ip,sp;push {r3,r4,r5,r6,fp,ip,lr,pc};sub fp,ip,#4
     ldr r4,[r0,#0x188];ldr r6,[r0,#0x18c];mov r5,r0
     bl #0x531cc3d4;cmp r0,#8;bne native
     ldrb r1,[r5,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;beq native8
     ldrb r1,[r5,#0x1ac];cmp r1,#1;moveq r5,#0;beq #0x531cc5e0
     bl #${SHOOT_CUR};mov r1,#0;bl #${field};mov r5,r0;b #0x531cc5e0
     native8:mov r0,#8
     native:b #0x531cc5cc`, 'halation: Fn guide');
  // Fn (r4 controller, r0 the row's kind): Halation opens Grain Effect's submenu with the flag set.
  hook(p, 0x531ccf88, 0xe3500010,
    `cmp r0,#0x10;beq grain
     cmp r0,#8;bne #0x531ccf6c
     ldrb r1,[r4,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;beq #0x531ccf6c
     ldrb r1,[r4,#0x1ac];cmp r1,#1;beq #0x531ccf6c
     mov r1,#1;b set
     grain:mov r1,#0
     set:${addr('r2', HAL_FLAG)};str r1,[r2];b #0x531ccf90`, 'halation: Fn opens the submenu');
  // Movies: the Halation row has no slider (the JPEG step makes the glow; photos only).
  hook(p, 0x531cc43c, 0xe3500010,
    `cmp r0,#8;bne native
     ldrb r1,[r4,#0x19c];${lookup('r1', 'r1', 'r2', o.styles)};cmp r1,#0;beq native8
     ldrb r1,[r4,#0x1ac];cmp r1,#1;bne native8
     mov r0,#0;b #0x531cc434
     native8:mov r0,#8
     native:cmp r0,#0x10;b #0x531cc440`, 'halation: no slider for movies');

  // ---------------------------------------------------------------- shooting: the submenu
  submenu(p, o, field, put, {
    title: 0x531cdb80, subtitle: 0x531ce2d0,
    icon0: 0x531ce31c, text0: [0x531ce334, 0xeb077502], icon1: 0x531ce3a8, text1: [0x531ce3c0, 0xeb07750d],
    default0: [0x531cdef8, 0xeb083c36], scale0: 0x531cdf14, default1: [0x531ce044, 0xeb083dca], scale1: 0x531ce060, positions1: 0x531ce084,
    current0: [0x531ce284, 0xeb0804b5, 0x531ce288], current1: [0x531ce268, 0xeb080606, 0x531ce26c],
    setter0: [0x531ce5dc, 0xeb07e548, 0x531ce5e0], setter1: [0x531ce5bc, 0xeb07e564, 0x531ce5c0],
    cur: `bl #${SHOOT_CUR}`, set: SHOOT_SET, setterRegs: 'r0',
  });
  // Backup on entry (after Grain Effect's own) and the restore on cancel.
  hook(p, 0x531ce504, 0xeb0809cb,
    `bl #0x533d0c38;${flagTest};beq done;bl #${SHOOT_CUR};${addr('r1', HAL_SAVE)};str r0,[r1];done:b #0x531ce508`, 'halation: keep the setting for cancel');
  hook(p, 0x531cd8d0, 0xeb080d32,
    `bl #0x533d0da0;${flagTest};beq done;bl #0x53240cac;bl #0x53241b54;${addr('r1', HAL_SAVE)};ldr r1,[r1];bl #${SHOOT_SET};done:b #0x531cd8d4`, 'halation: cancel puts the setting back');

  // ---------------------------------------------------------------- RAW development: the main row
  // Slider (entry, r0 controller): Grain Effect's Off / On slider 0x531A91A4.
  hook(p, 0x531a819c, 0xe1a0c00d, `push {r0-r3,ip,lr};${RAW_LOOK_CALLS};${lookup('ip', 'r0', 'r1', o.raws)};cmp ip,#0;pop {r0-r3,ip,lr};bne #0x531a91a4;mov ip,sp;b #0x531a81a0`, 'halation: Off / On slider (RAW development)');
  // Current slider position (r0 the model; r5 is set from r0 after).
  hook(p, 0x531ab1fc, 0xeb07401f,
    `${rawHal};mov r5,ip;bl #${RAW_GET};cmp r5,#0;beq tone;mov r1,#0;bl #${field};b #0x531ab204
     tone:bl #0x531a69c4;b #0x531ab204`, 'halation: slider position Off / On (RAW development)');
  // Row text (r0 object, r1 buffer, r2 value).
  hook(p, 0x531aa140, 0xeb080334,
    `${rawHal};cmp ip,#0;beq tone
     push {r0,r1};mov r0,r2;mov r1,#0;bl #${field};mov r2,r0;pop {r0,r1};bl #${ON_OFF_TEXT};b #0x531aa144
     tone:bl #0x533aae18;b #0x531aa144`, 'halation: row text Off / On (RAW development)');
  // Setter (r6 model, r5 slider position).
  hook(p, 0x531ab6b8, 0xe3063bc4,
    `${rawHal};cmp ip,#0;beq tone
     mov r0,r6;bl #${RAW_GET};mov r1,#0;mov r2,r5;bl #${put};mov r1,r0;mov r0,r6;bl #${RAW_SET};b #0x531ab6cc
     tone:${addr('r3', 0x53de6bc4)};mov r0,r6;ldrb r1,[r3,r5];bl #${RAW_SET};b #0x531ab6cc`, 'halation: switch on / off (RAW development)');
  // Fn guide (r4 the row's kind, r0 the model): while on.
  hook(p, 0x531aa934, 0xe354000d,
    `cmp r4,#8;bne native;${rawHal};cmp ip,#0;beq native
     bl #${RAW_GET};mov r1,#0;bl #${field};mov r4,r0;b #0x531aa948
     native:cmp r4,#0xd;b #0x531aa938`, 'halation: Fn guide (RAW development)');
  // Fn (r4 controller, r3 the row's kind): Halation keeps its setting and opens the submenu with the flag set.
  hook(p, 0x531abb3c, 0xe3530010,
    `cmp r3,#0x10;beq grain
     cmp r3,#8;bne #0x531abb00
     ${rawHal};cmp ip,#0;beq #0x531abb00
     bl #${rawCur};${addr('r1', HAL_SAVE)};str r0,[r1]
     ${addr('r2', HAL_FLAG)};mov r1,#1;str r1,[r2];b #0x531abb50
     grain:${addr('r2', HAL_FLAG)};mov r1,#0;str r1,[r2];b #0x531abb44`, 'halation: Fn opens the submenu (RAW development)');

  // ---------------------------------------------------------------- RAW development: the submenu
  submenu(p, o, field, put, {
    title: 0x531ac388, subtitle: 0x531acb10,
    icon0: 0x531acb5c, text0: null, icon1: 0x531acbfc, text1: [0x531acc28, 0xeb07fad3],
    default0: [0x531ac738, 0xeb073eb8], scale0: 0x531ac754, default1: [0x531ac880, 0xeb073e70], scale1: 0x531ac89c, positions1: 0x531ac8c0,
    current0: [0x531acac4, 0xeb073b3d, 0x531acac8], current1: [0x531acaa0, 0xeb073b62, 0x531acaa4],
    setter0: [0x531ace0c, 0xeb0754db, 0x531ace10], setter1: [0x531acdec, 0xeb075534, 0x531acdf0],
    cur: `bl #${RAW_GET}`, set: RAW_SET, setterRegs: 'r0',
    rowValue0: [0x531acb70, 0xeb073b12, 0x531acb74], rowValue1: [0x531acc10, 0xeb073b06, 0x531acc14],
  });
  // Cancel: Grain Effect's restore, then the halation setting kept at Fn.
  hook(p, 0x531ac1b4, 0xeb075866,
    `bl #0x53382354;${flagTest};beq done;${RAW_MODEL};${addr('r1', HAL_SAVE)};ldr r1,[r1];bl #${RAW_SET};done:b #0x531ac1b8`, 'halation: cancel puts the setting back (RAW development)');
}

interface SubmenuSites {
  title: number; subtitle: number;
  icon0: number; text0: [number, number] | null; icon1: number; text1: [number, number];
  default0: [number, number]; scale0: number; default1: [number, number]; scale1: number; positions1: number;
  current0: [number, number, number]; current1: [number, number, number];
  setter0: [number, number, number]; setter1: [number, number, number];
  /** Current Toning -> r0 (r0 must be the model where that needs it). */
  cur: string; set: number; setterRegs: 'r0';
  /** RAW development's rows read the value themselves (r0 the model): [site, word, next]. */
  rowValue0?: [number, number, number]; rowValue1?: [number, number, number];
}

/**
 * Grain Effect's submenu as Halation's while the flag is set: title Halation; row 0 Strength (Grain's
 * Strength name and scale, the halation icon, 1..3), row 1 Colour (red / white: two positions, its
 * own scale, a red or white icon, no number). Values are read from and written to the Toning byte.
 */
function submenu(p: Patch, o: HalationUiOptions, field: number, put: number, s: SubmenuSites): void {
  // In the prologue: ip still holds the caller's sp (`sub fp,ip,#4` follows), so only r1 is used
  // (test 043 used ip here: fp went wrong and the camera froze on entering the submenu).
  hook(p, s.title, 0xe3001169, `${addr('r1', HAL_FLAG)};ldr r1,[r1];cmp r1,#0;movw r1,#${TEXT_GRAIN};movwne r1,#${o.nameText};b #${s.title + 4}`, 'halation submenu: title');
  hook(p, s.subtitle, 0xe1d310b4,
    `ldrh r1,[r3,#4];${flagTest};beq done;movw ip,#${TEXT_SIZE};cmp r1,ip;movweq r1,#${TEXT_STRENGTH};movwne r1,#${o.colourText};done:b #${s.subtitle + 4}`, 'halation submenu: row name');
  hook(p, s.icon0, 0xe1d370b2, `ldrh r7,[r3,#2];${flagTest};movwne r7,#${o.icon};b #${s.icon0 + 4}`, 'halation submenu: strength icon');
  // Colour row icon: red or white by the current setting (r0..r3 are set again after).
  hook(p, s.icon1, 0xe1d370b2,
    `ldrh r7,[r3,#2];${flagTest};beq done;${RAW_OR_SHOOT_MODEL(s)};${s.cur};mov r1,#2;bl #${field};cmp r0,#0;movw r7,#${o.redIcon};movwne r7,#${o.whiteIcon};done:b #${s.icon1 + 4}`, 'halation submenu: colour icon');
  if (s.text0) {
    // Shooting: the strength row's number (r0 object, r1 buffer).
    hook(p, s.text0[0], s.text0[1],
      `${flagTest};beq native;push {r0,r1};${s.cur};mov r1,#1;bl #${field};mov r2,r0;pop {r0,r1};bl #${NUMBER_TEXT};b #${s.text0[0] + 4}
       native:bl #${branchTargetOf(s.text0)};b #${s.text0[0] + 4}`, 'halation submenu: strength number');
  }
  // The colour row shows no number (r1 the buffer).
  hook(p, s.text1[0], s.text1[1],
    `${flagTest};beq native;mov r2,#0;strb r2,[r1];b #${s.text1[0] + 4}
     native:bl #${branchTargetOf(s.text1)};b #${s.text1[0] + 4}`, 'halation submenu: no colour number');
  if (s.rowValue0 && s.rowValue1) {
    // RAW development's rows read their value from the model (r0): strength 0..2, colour.
    for (const [site, k] of [[s.rowValue0, 1], [s.rowValue1, 2]] as const) {
      hook(p, site[0], site[1], `${flagTest};beq native;${s.cur};mov r1,#${k};bl #${field};b #${site[2]}
        native:bl #${branchTargetOf(site)};b #${site[2]}`, 'halation submenu: row value (RAW development)');
    }
  }
  // Sliders: defaults Weak and red; strength on Grain's strength scale; colour two positions on its scale.
  hook(p, s.default0[0], s.default0[1], `${flagTest};beq native;mov r0,#0;b #${s.default0[0] + 4};native:bl #${branchTargetOf(s.default0)};b #${s.default0[0] + 4}`, 'halation submenu: strength default');
  hook(p, s.default1[0], s.default1[1], `${flagTest};beq native;mov r0,#0;b #${s.default1[0] + 4};native:bl #${branchTargetOf(s.default1)};b #${s.default1[0] + 4}`, 'halation submenu: colour default');
  hook(p, s.scale0, 0xe3003265, `${flagTest};movw r3,#${SCALE_SIZE};movwne r3,#${SCALE_STRENGTH};b #${s.scale0 + 4}`, 'halation submenu: strength scale');
  hook(p, s.scale1, 0xe3003261, `${flagTest};movw r3,#${SCALE_STRENGTH};movwne r3,#${o.colourScale};b #${s.scale1 + 4}`, 'halation submenu: colour scale');
  expectWord(p, s.positions1 + 4, 0xe3a030b4);
  hook(p, s.positions1, 0xe3a02002, `${flagTest};mov r2,#2;mov r3,#0xb4;movne r2,#1;movne r3,#0x168;b #${s.positions1 + 8}`, 'halation submenu: colour has two positions');
  // Current positions: strength 0..2, colour 0..1 (the value-to-position tables after are 0, 1, 2).
  for (const [site, k] of [[s.current0, 1], [s.current1, 2]] as const) {
    hook(p, site[0], site[1], `${flagTest};beq native;${s.cur};mov r1,#${k};bl #${field};b #${site[2]};native:bl #${branchTargetOf(site)};b #${site[2]}`, 'halation submenu: current position');
  }
  // Setters (r0 the settings / model, r1 the new value 0..2): into the Toning byte.
  for (const [site, k] of [[s.setter0, 1], [s.setter1, 2]] as const) {
    hook(p, site[0], site[1],
      `${flagTest};beq native;push {r0,r1};${s.cur};ldr r2,[sp,#4];mov r1,#${k};bl #${put};mov r1,r0;pop {r0,r2};bl #${s.set};b #${site[2]}
       native:bl #${branchTargetOf(site)};b #${site[2]}`, 'halation submenu: setter');
  }
}

/** The shooting getter needs nothing; RAW development's needs the model in r0. */
function RAW_OR_SHOOT_MODEL(s: SubmenuSites): string {
  return s.cur === `bl #${RAW_GET}` ? RAW_MODEL : 'mov r0,r0';
}

/** Target of the `bl` that a [site, word] pair names. */
function branchTargetOf(site: readonly number[]): number {
  const [at, word] = site;
  let off = word & 0xffffff;
  if (off & 0x800000) off -= 0x1000000;
  return (at + 8 + off * 4) >>> 0;
}

/**
 * Native code that reads Toning is given 0..2 (a halation look's 3..11 mean nothing to it; the
 * firmware has no range check, test 042): development (0x5393A4C0: the picture's record to the
 * image engine, live view and shots), the Toning slider position and text, and the maker note's
 * Toning code (3..11 written as 4..12 and read back, so in-camera RAW development keeps them).
 */
export function installHalationClamps(p: Patch): void {
  hook(p, 0x5393ad70, 0xe5d367a6, 'ldrb r6,[r3,#0x7a6];cmp r6,#2;movhi r6,#0;b #0x5393ad74', 'halation: development sees Toning 0..2');
  hook(p, 0x531c825c, 0xe1a0c00d, 'cmp r0,#2;movhi r0,#0;mov ip,sp;b #0x531c8260', 'halation: Toning slider position 0..2');
  hook(p, 0x531a69c4, 0xe1a0c00d, 'cmp r0,#2;movhi r0,#0;mov ip,sp;b #0x531a69c8', 'halation: Toning slider position 0..2 (RAW development)');
  hook(p, 0x533aae18, 0xe3520001, 'cmp r2,#2;movhi r2,#0;cmp r2,#1;b #0x533aae1c', 'halation: Toning text 0..2');
  hook(p, 0x53804d44, 0xe3003e18, 'ldrb r0,[r1,#0x7a6];cmp r0,#3;blo native;cmp r0,#11;addls r0,r0,#1;popls {r4,pc};native:movw r3,#0xe10;b #0x53804d48', 'halation: maker note Toning 3..11 as codes 4..12');
  hook(p, 0x537fe804, 0xe3a03000, 'sub r3,r1,#1;cmp r3,#3;blo zero;cmp r3,#11;bls keep;zero:mov r3,#0;keep:b #0x537fe808', 'halation: maker note codes 4..12 as Toning 3..11');
}
