// SPDX-License-Identifier: GPL-2.0-only
/**
 * Battery percentage for GR III 2.10 / IIIx 1.60 (as GR IV's, ../gr4v120/aspect/battery.ts): the
 * battery icon of the shooting and playback screens shows the charge in steps of 10 % (a number
 * inside the battery) instead of the camera's 3 bars. The diagnostic variant (a test build) shows
 * "?" (no usable report) and "!" (the report disagrees with the bars) where the other shows the
 * camera's own icon.
 *
 * Where the number comes from. The sub-CPU (a Renesas RX113, the firmware's CPU section) sends a
 * 16-byte power report; the main CPU keeps the last two in CpuInformationService's double buffer
 * and shows only the step. GR III's sub-CPU program builds the report exactly as GR IV's (both
 * read with tools/gr3extras/rxdis.py; GR III 2.10 / 2.21 / IIIx 1.71 have the same code here):
 *  - report builder (GR III 0xFFFE7AC2, GR IV 0xFFFE6CF1): bytes 0..3 from the power state
 *    (GR III RAM 0x39E, GR IV 0x396), bytes 4..7 two big-endian words, 10..15 other state;
 *  - byte 0, low nibble (0xFFFE7C13 / 0xFFFE6E59): 4 external power, 5 or 1 battery (by the
 *    charger flags), 0 none; byte 1: voltage / 10 (43 on source 4); byte 2, low nibble: the step;
 *  - byte 3 (0xFFFE77A2 / 0xFFFE6A01): (Remain + 5) / 10, Remain being the charge in 0.1 % that
 *    the battery information command prints ("Remain"). The step comes from Remain with the same
 *    thresholds and hysteresis in both (600 / 551, 501, 300 / 251, 201, 150 / 101, 51, 0);
 *  - Remain from the voltage (in 0.01 V), GR IV 0xFFFE6CB4: 4.41 V and up 100 %, 3.77 V 11 %,
 *    3.64 V and down 0, linear between. GR III 0xFFFE7A32: full 4.22 V, 10 % at 3.50 V, 0 at
 *    3.28 V, linear between, the three points lowered at low battery temperature (RAM 0x394
 *    below 300, by a cubic in it). DB-110 is a 4.2 V cell, DB-120 a 4.4 V one.
 * On the main CPU (GR III = GR IV up to addresses): the report's field table (0x53D1D308, 16
 * fields: byte 0 low / high nibble, byte 1, byte 2 low / high nibble, byte 3, two big-endian words,
 * bytes 8..15) is the same; byte 3 (field 5) is only copied into the picture's record (+0x73065)
 * and written back into the maker note's tag 0x0216 (0x536066C0, case 0x216 of 0x53606738).
 *
 * Reading it, without calling or changing anything of the camera's: the holder is a function-local
 * static (getter 0x5356E588: guard word 0x55349090, bit 0 set once built; object 0x55348F6C).
 * service = [holder + 4]; buffer index [service + 0xAC] (bit 15: the writer is busy, the readable
 * one is then index - 1); buffer [service + 0x5C + index * 4]; report at buffer + 4. That is what
 * the report copy 0x53571D90 does, instruction for instruction as GR IV's 0x537A6C20.
 *
 * The icon. GetBatteryIcon (0x532ABCE0 = GR IV's 0x533A98A0 up to the icon numbers; r1: on battery,
 * r2: step, r3: external power) picks the bars 0x105..0x108 for the shooting screen (0x531720B0, in
 * UpdateViewBattery) and for playback (tail call 0x532ABE14). The hook in front of it is GR IV's,
 * word for word apart from the addresses: on battery only, it takes byte 3 when the report is there,
 * says "battery" (1) and is 0..100, and agrees with the step to within one (charge 50+ is step 4,
 * 20+ step 3, 5+ step 2, else 1; step 0 counts as 1); it keeps the shown step until the charge is 9
 * or more away from it (one byte, GR3X_BATTERY_SHOWN, in round 10's zero-filled words). 10..100:
 * its own icon; below 5 %, a missing report or a disagreement: the camera's own icon (diagnostic:
 * "?" / "!"). On external power the camera's icons are unchanged.
 */
import { branchWord } from '../aspect/arm';
import { BATTERY_MARGIN, batteryIcons } from '../gr4v120/aspect/battery';
import { FirmwareError } from '../types';
import { adr } from './target';

const GET_BATTERY_ICON = adr(0x532abce0);
const HOLDER_GUARD = adr(0x55349090);
const HOLDER = adr(0x55348f6c);
/** The shown step + 1 (0: none yet), one byte: round 10's word 0x558043A4 (cleared at every start). */
export const GR3X_BATTERY_SHOWN = adr(0x558043a4);

/** 10 %, 20 %, ..., 100 %, then "?" and "!": 60 x 40 RGBA, GR IV's drawing. */
export const GR3X_BATTERY_ICON_COUNT = 12;
export const GR3X_BATTERY_ICON_W = 60;
export const GR3X_BATTERY_ICON_H = 40;
export const gr3xBatteryIconPixels = (): Uint8Array[] => batteryIcons().map((x) => x.px);

export interface Gr3xBatteryProgram {
  code(source: string): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}

const addr = (r: string, value: number): string => `movw ${r},#${value & 65535};movt ${r},#${value >>> 16};`;

/** Install the hook; `first`: the icon number of "10 %" (then 20 % .. 100 %, "?", "!"). */
export function installGr3xBatteryPercent(p: Gr3xBatteryProgram, first: number, diag: boolean): Record<string, number> {
  const bad = (what: string): never => { throw new FirmwareError('unexpected-layout', `IIIx battery percentage: ${what}`); };
  if (p.word(GET_BATTERY_ICON + 4) !== 0xe1a0c00d) bad('GetBatteryIcon has moved'); // mov ip,sp
  if (p.word(GET_BATTERY_ICON + 20) !== 0x0a000009) bad('GetBatteryIcon has moved'); // beq (on battery)
  const unknown = first + 10, disagrees = first + 11;
  const fallback = diag ? 'icon' : 'camera';
  // In: r1 on battery, r2 step, r3 external power. Out: r0 the icon. For the camera's own icon
  // r0-r7 are as they came, and its code starts again with the displaced CMP (whose flags it uses).
  const hook = p.code(
    'cmp r1,#1;bne native;push {r0-r7,lr};mov r4,r2;' +
    addr('r5', HOLDER_GUARD) + 'ldr r0,[r5];tst r0,#1;beq unknown;' +
    addr('r5', HOLDER) + 'ldr r5,[r5,#4];cmp r5,#0;beq unknown;' +
    'ldr r6,[r5,#0xac];tst r6,#0x8000;subne r6,r6,#1;and r6,r6,#1;add r6,r5,r6,lsl #2;ldr r6,[r6,#0x5c];cmp r6,#0;beq unknown;' +
    'ldrb r0,[r6,#4];and r0,r0,#15;cmp r0,#1;bne unknown;' +
    'ldrb r0,[r6,#7];cmp r0,#100;bhi unknown;' +
    'mov r1,#1;cmp r0,#5;movhs r1,#2;cmp r0,#20;movhs r1,#3;cmp r0,#50;movhs r1,#4;' +
    'cmp r4,#4;bhi disagrees;cmp r4,#1;movlo r4,#1;subs r2,r1,r4;rsbmi r2,r2,#0;cmp r2,#1;bhi disagrees;' +
    addr('r7', GR3X_BATTERY_SHOWN) + 'cmp r0,#5;blo fresh;ldrb r1,[r7];subs r1,r1,#1;bmi fresh;' +
    'add r2,r1,r1,lsl #2;mov r2,r2,lsl #1;' +
    `add r3,r2,#${5 + BATTERY_MARGIN};cmp r0,r3;bge fresh;add r3,r0,#${5 + BATTERY_MARGIN};cmp r3,r2;bgt keep;` +
    'fresh:add r3,r0,#5;mov r2,#205;mul r1,r3,r2;mov r1,r1,lsr #11;' +
    'keep:add r2,r1,#1;strb r2,[r7];cmp r1,#0;beq camera;' +
    `movw r0,#${first - 1};add r0,r0,r1;` +
    'icon:str r0,[sp];pop {r0-r7,pc};' +
    'camera:pop {r0-r7,lr};' +
    `native:cmp r1,#1;b #${GET_BATTERY_ICON + 4};` +
    `unknown:movw r0,#${unknown};b ${fallback};` +
    `disagrees:movw r0,#${disagrees};b ${fallback};`);
  p.patch(GET_BATTERY_ICON, 0xe3510001 /* cmp r1,#1 */, branchWord(GET_BATTERY_ICON, hook),
    `battery percentage${diag ? ' (diagnostic)' : ''}: GetBatteryIcon reads the sub-CPU's charge`);
  return { batteryPercent: hook };
}
