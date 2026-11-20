// SPDX-License-Identifier: GPL-2.0-only
/**
 * Battery percentage (GR IV, firmware 1.11): the battery icon of the shooting and playback screens
 * shows the charge in steps of 10 % (a number inside the battery) instead of the camera's 3 bars.
 *
 * Where the number comes from. The camera's sub-CPU sends a 16-byte power report (byte 0, low
 * nibble: power source, 1 = battery; byte 1: voltage x10; byte 2: the 0..4 step behind the bars;
 * byte 3: charge 0..100, worked out from the voltage). CpuInformationService keeps the last two
 * reports in a double buffer and the main CPU only uses the step; byte 3 goes unshown, though every
 * photo records the whole report in its maker note (tag 0x0216). Across 881 GR IV photos byte 3
 * follows the voltage (3.7 V about 10, 4.0 V about 50, 4.4 V 100) and falls through a day; the
 * bars stay full from 100 down to about 55. It jumps by up to 4 between shots (load).
 *
 * Reading it, without calling or changing anything of the camera's: the service's holder is a
 * function-local static (getter 0x5377D0F8: guard word 0x5537D2FC, bit 0 set once built; object
 * 0x5537D1D8). service = [holder + 4]; buffer index [service + 0xAC] (bit 15: the writer is busy,
 * the readable one is then index - 1); buffer [service + 0x5C + index * 4]; report at buffer + 4.
 * That is what the report copy 0x53780918 does (it also marks the buffer it reads in +0xB0; this
 * hook only reads two bytes and marks nothing, so a write at the same moment can at worst give one
 * stale reading).
 *
 * The icon. GetBatteryIcon (0x5339A1E8; r1: on battery, r2: step, r3: external power) picks the
 * bars icon 0xF4..0xF7 for the shooting screen (UpdateViewBattery, which runs every tick and redraws
 * only on a change) and for playback (0x5339A2CC). The hook in front of it, on battery only:
 *  - takes byte 3 when the report is there, says "battery" and is 0..100, and agrees with the step
 *    to within one (charge 50+ is step 4, 20+ step 3, 5+ step 2, else step 0..1);
 *  - shows it in steps of 10 with a margin: the shown step moves only when the charge is 9 or more
 *    away from it (the hysteresis byte BATTERY_SHOWN, zeroed at start-up; 0 = nothing shown yet);
 *  - 10..100: its own icon (BATTERY_ICON_ID + step - 1). Below 5 % (whatever was shown), a
 *    missing report or a disagreement: the camera's own icon. A diagnostic build shows "?" (no usable report) and "!" (disagrees with
 *    the step) instead, so a camera test tells which it was.
 * On external power the camera's icons are unchanged.
 */
import { FirmwareError } from '../types';
import { adr } from '../target';
import { movImmediate, movWord } from './arm';
import { ICON_CATALOG, LOOKUP_BOUNDS, Patch, Program, concat, expectWord, u16le, u32le } from './build';

const GET_BATTERY_ICON = adr(0x5339a1e8);
const HOLDER_GUARD = adr(0x5537d2fc);
const HOLDER = adr(0x5537d1d8);
/**
 * The shown step + 1 (0: none yet), one byte. Not in the 44 zero-filled bytes before 0x55837300,
 * whose words the other additions take (the learned shadow correction, Flash TTL), but after
 * them: the 64 bytes from 0x55837300 are the start-up arena of the C library's sbrk (0x53065698 and
 * 0x5315DE98 start it there and stop at 0x55837340 or at the stack), which nothing in the firmware
 * calls; no instruction or data word refers to the 64 bytes otherwise. The camera's heap (operator
 * new) starts at 0x55837340 (its first block is set up at 0x53AAB340). `extendBatteryZeroFill`
 * makes the start-up zero fill reach 0x55837340, so the byte starts at 0.
 */
export const BATTERY_SHOWN = adr(0x55837300);
/** Literal: end of the start-up zero fill (0x558372D4, or 0x55837300 once an addition extends it). */
const ZERO_FILL_END = adr(0x53000460);
/** The end of the sbrk arena, where the camera's heap starts. */
const ARENA_END = adr(0x55837340);

/** Icons: 10 %, 20 %, ..., 100 %, then the two diagnostic ones. Above the power-off thumbnails (992..1003). */
export const BATTERY_ICON_ID = 1009;
export const BATTERY_ICON_UNKNOWN = BATTERY_ICON_ID + 10;
export const BATTERY_ICON_DISAGREES = BATTERY_ICON_ID + 11;
export const BATTERY_ICON_W = 60;
export const BATTERY_ICON_H = 40;

/** The margin past a step's edge before the shown step moves (the readings jump by up to 4). */
export const BATTERY_MARGIN = 4;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

// --------------------------------------------------------------------------------------------
// Icons: a battery in the camera's style (tip on the left, a 1-pixel black edge with softened
// corners, a 2-pixel outline, a dark inside), drawn bigger than the camera's own so that the
// number can be 24 pixels high. The camera's battery: body x 8..56, y 8..31, inside 43x18. These:
// body x 6..59, y 3..36, inside 48x28 at x 9..56, y 6..33.

type Rgb = readonly [number, number, number];
type Box = readonly [number, number, number, number];
const WHITE: Rgb = [254, 254, 254];
const YELLOW: Rgb = [255, 255, 0];
const RED: Rgb = [255, 51, 51];
const MAGENTA: Rgb = [255, 0, 255];
const INSIDE: Rgb = [51, 51, 51];

/** A battery: its body and its tip (x0, y0, x1, y1, inclusive), the tip on the left. */
export interface BatteryShape { body: Box; tip: Box }
/** The camera's own battery (its icons 0xF4..0xF7). */
export const CAMERA_BATTERY: BatteryShape = { body: [8, 8, 56, 31], tip: [4, 13, 10, 26] };
/** The battery of these icons: the same style, filling the 60x40 icon. */
export const ICON_BATTERY: BatteryShape = { body: [6, 3, 59, 36], tip: [2, 12, 8, 27] };
/** The dark inside of a battery's body. */
export const batteryInside = (shape: BatteryShape): Box => [shape.body[0] + 3, shape.body[1] + 3, shape.body[2] - 3, shape.body[3] - 3];

/** Digits 24 pixels high with 3-pixel strokes, drawn for this file. */
const DIGITS: Record<string, string[]> = {
  '0': ['.############.', '##############', '##############', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '##############', '##############', '.############.'],
  '1': ['....###', '...####', '..#####', '.######', '#######', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###', '....###'],
  '2': ['.############.', '##############', '##############', '###........###', '###........###', '...........###', '...........###', '...........###', '...........###', '..........####', '.........####.', '........####..', '.......####...', '......####....', '.....####.....', '.....####.....', '....####......', '...####.......', '..####........', '.####.........', '####..........', '##############', '##############', '##############'],
  '3': ['.############.', '##############', '##############', '###........###', '###........###', '...........###', '...........###', '...........###', '...........###', '...........###', '....##########', '....##########', '....##########', '...........###', '...........###', '...........###', '...........###', '...........###', '...........###', '###........###', '###........###', '##############', '##############', '.############.'],
  '4': ['.........###..', '........####..', '........####..', '.......#####..', '......######..', '.....###.###..', '....###..###..', '....###..###..', '...###...###..', '..###....###..', '..###....###..', '.###.....###..', '###......###..', '##############', '##############', '##############', '.........###..', '.........###..', '.........###..', '.........###..', '.........###..', '.........###..', '.........###..', '.........###..'],
  '5': ['##############', '##############', '##############', '###...........', '###...........', '###...........', '###...........', '###...........', '###...........', '###...........', '#############.', '##############', '##############', '...........###', '...........###', '...........###', '...........###', '...........###', '...........###', '###........###', '###........###', '##############', '##############', '.############.'],
  '6': ['.############.', '##############', '##############', '###........###', '###........###', '###...........', '###...........', '###...........', '###...........', '###...........', '#############.', '##############', '##############', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '##############', '##############', '.############.'],
  '7': ['##############', '##############', '##############', '...........###', '...........###', '...........###', '...........###', '..........###.', '.........###..', '.........###..', '........###...', '.......###....', '......###.....', '......###.....', '.....###......', '.....###......', '.....###......', '.....###......', '.....###......', '.....###......', '.....###......', '.....###......', '.....###......', '.....###......'],
  '8': ['.############.', '##############', '##############', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '##############', '.############.', '##############', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '##############', '##############', '.############.'],
  '9': ['.############.', '##############', '##############', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '###........###', '##############', '##############', '.#############', '...........###', '...........###', '...........###', '...........###', '...........###', '...........###', '###........###', '###........###', '##############', '##############', '.############.'],
  '?': ['.############.', '##############', '##############', '###........###', '###........###', '...........###', '...........###', '...........###', '...........###', '..........####', '.........####.', '........####..', '.......####...', '......####....', '.....####.....', '.....####.....', '.....####.....', '.....####.....', '..............', '..............', '..............', '.....####.....', '.....####.....', '.....####.....'],
  '!': ['###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '###', '...', '...', '...', '...', '###', '###', '###'],
};
const DIGIT_H = 24;
const DIGIT_GAP = 3;

/** A 60x40 RGBA battery icon with `text` in it (`shape`: the battery, ICON_BATTERY unless given). */
export function drawBatteryIcon(text: string, textColour: Rgb, outline: Rgb = WHITE, shape: BatteryShape = ICON_BATTERY): Uint8Array {
  // Transparent pixels are white at 0 opacity, as in the camera's icons.
  const px = new Uint8Array(BATTERY_ICON_W * BATTERY_ICON_H * 4).map((_, i) => (i % 4 === 3 ? 0 : 255));
  const put = (x: number, y: number, c: Rgb, a = 255): void => {
    const o = (y * BATTERY_ICON_W + x) * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a;
  };
  const fill = (x0: number, y0: number, x1: number, y1: number, c: Rgb, a = 255): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, c, a);
  };
  const BLACK: Rgb = [0, 0, 0];
  const [bx0, by0, bx1, by1] = shape.body;
  const [tx0, ty0, tx1, ty1] = shape.tip;
  // A black edge with softened corners around body and tip, the outline inside it with black
  // inner corners, then the inside.
  for (const [x0, y0, x1, y1] of [shape.body, shape.tip]) {
    fill(x0 + 1, y0, x1 - 1, y1, BLACK, 254);
    fill(x0, y0 + 1, x1, y1 - 1, BLACK, 254);
    for (const [x, y] of [[x0 + 1, y0], [x1 - 1, y0], [x0, y0 + 1], [x1, y0 + 1], [x0 + 1, y1], [x1 - 1, y1], [x0, y1 - 1], [x1, y1 - 1]]) put(x, y, BLACK, 243);
  }
  fill(bx0 + 1, by0 + 1, bx1 - 1, by1 - 1, outline);
  fill(tx0 + 1, ty0 + 1, tx1, ty1 - 1, outline);
  for (const [x, y] of [[bx0 + 1, by0 + 1], [bx1 - 1, by0 + 1], [bx0 + 1, by1 - 1], [bx1 - 1, by1 - 1], [tx0 + 1, ty0 + 1], [tx0 + 1, ty1 - 1], [bx0, ty0], [bx0, ty1]]) put(x, y, BLACK);
  fill(tx0 + 3, ty0 + 3, bx0, ty1 - 3, INSIDE);
  const [ix0, iy0, ix1, iy1] = batteryInside(shape);
  fill(ix0, iy0, ix1, iy1, INSIDE);
  const glyphs = [...text].map((ch) => DIGITS[ch] ?? fail('internal', `no battery glyph for "${ch}"`));
  const width = glyphs.reduce((w, g) => w + g[0].length, 0) + DIGIT_GAP * Math.max(0, glyphs.length - 1);
  if (width > ix1 - ix0 + 1 || (glyphs.length > 0 && DIGIT_H > iy1 - iy0 + 1)) fail('internal', `battery text "${text}" does not fit`);
  let x = ix0 + Math.floor((ix1 - ix0 + 1 - width) / 2);
  const top = iy0 + Math.floor((iy1 - iy0 + 1 - DIGIT_H) / 2);
  for (const g of glyphs) {
    g.forEach((row, dy) => [...row].forEach((c, dx) => { if (c === '#') put(x + dx, top + dy, textColour); }));
    x += g[0].length + DIGIT_GAP;
  }
  return px;
}

/** The icons in catalog order: 10..100 %, then "?" and "!". 20 % is yellow, 10 % red (as the camera's own low icons). */
export function batteryIcons(): { id: number; px: Uint8Array }[] {
  const out: { id: number; px: Uint8Array }[] = [];
  for (let step = 1; step <= 10; step++) {
    const colour = step === 1 ? RED : step === 2 ? YELLOW : WHITE;
    out.push({ id: BATTERY_ICON_ID + step - 1, px: drawBatteryIcon(String(step * 10), colour, step === 1 ? RED : WHITE) });
  }
  out.push({ id: BATTERY_ICON_UNKNOWN, px: drawBatteryIcon('?', MAGENTA) });
  out.push({ id: BATTERY_ICON_DISAGREES, px: drawBatteryIcon('!', MAGENTA) });
  return out;
}

function installIcons(patch: Patch, iconbin: Uint8Array, icons: readonly { id: number; px: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  for (const { id, px } of icons) {
    if (patch.word(ICON_CATALOG + id * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const offset = length;
    parts.push(px);
    length += px.length;
    // {u16 kind = 1, u16 width, u16 height, u16 flags = 0, u32 offset in 4-byte units}
    const descriptor = patch.append(concat([u16le([1, BATTERY_ICON_W, BATTERY_ICON_H, 0]), u32le([offset / 4])]), 16);
    patch.write(ICON_CATALOG + id * 4, u32le([descriptor]));
  }
  const upper = Math.max(...icons.map((x) => x.id));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(upper, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat(parts);
}

// --------------------------------------------------------------------------------------------
// The hook

const addr = (r: string, value: number): string => `movw ${r},#${value & 65535};movt ${r},#${value >>> 16};`;

/**
 * Install the battery percentage into an image that has the catalog scaffold; returns the new
 * ICONBIN data. `diag`: "?" and "!" instead of the camera's icon when the report is missing or
 * disagrees with the step.
 */
export function installBatteryPercent(patch: Patch, iconbin: Uint8Array, diag = false): Uint8Array {
  const p = new Program(patch);
  p.expect(GET_BATTERY_ICON, 'cmp r1,#1', 'GetBatteryIcon has moved');
  p.expect(GET_BATTERY_ICON + 4, 'mov ip,sp', 'GetBatteryIcon has moved');
  // The diagnostic variant differs in two branches only: to its icon instead of the camera's.
  const fallback = diag ? 'icon' : 'camera';
  // In: r1 on battery, r2 step, r3 external power. Out: r0 the icon. For the camera's own icon
  // r0-r7 are as they came, and its code starts again with the displaced CMP (whose flags it uses).
  p.hook(GET_BATTERY_ICON,
    'cmp r1,#1;bne native;push {r0-r7,lr};mov r4,r2;' +
    // The report: holder built, service, readable buffer, the report says battery, charge 0..100.
    addr('r5', HOLDER_GUARD) + 'ldr r0,[r5];tst r0,#1;beq unknown;' +
    addr('r5', HOLDER) + 'ldr r5,[r5,#4];cmp r5,#0;beq unknown;' +
    'ldr r6,[r5,#0xac];tst r6,#0x8000;subne r6,r6,#1;and r6,r6,#1;add r6,r5,r6,lsl #2;ldr r6,[r6,#0x5c];cmp r6,#0;beq unknown;' +
    'ldrb r0,[r6,#4];and r0,r0,#15;cmp r0,#1;bne unknown;' +
    'ldrb r0,[r6,#7];cmp r0,#100;bhi unknown;' +
    // The step it implies (1..4) against the camera's (0 counts as 1): at most one apart.
    'mov r1,#1;cmp r0,#5;movhs r1,#2;cmp r0,#20;movhs r1,#3;cmp r0,#50;movhs r1,#4;' +
    'cmp r4,#4;bhi disagrees;cmp r4,#1;movlo r4,#1;subs r2,r1,r4;rsbmi r2,r2,#0;cmp r2,#1;bhi disagrees;' +
    // Below 5 % always the camera's own (empty) icon. Hysteresis: keep the shown step s (centre
    // 10 s) while the charge is within 8 of it.
    addr('r7', BATTERY_SHOWN) + 'cmp r0,#5;blo fresh;ldrb r1,[r7];subs r1,r1,#1;bmi fresh;' +
    'add r2,r1,r1,lsl #2;mov r2,r2,lsl #1;' +
    `add r3,r2,#${5 + BATTERY_MARGIN};cmp r0,r3;bge fresh;add r3,r0,#${5 + BATTERY_MARGIN};cmp r3,r2;bgt keep;` +
    // (charge + 5) / 10, exact for 0..105.
    'fresh:add r3,r0,#5;mov r2,#205;mul r1,r3,r2;mov r1,r1,lsr #11;' +
    'keep:add r2,r1,#1;strb r2,[r7];cmp r1,#0;beq camera;' +
    `movw r0,#${BATTERY_ICON_ID - 1};add r0,r0,r1;` +
    'icon:str r0,[sp];pop {r0-r7,pc};' +
    'camera:pop {r0-r7,lr};' +
    `native:cmp r1,#1;b #${GET_BATTERY_ICON + 4};` +
    `unknown:movw r0,#${BATTERY_ICON_UNKNOWN};b ${fallback};` +
    `disagrees:movw r0,#${BATTERY_ICON_DISAGREES};b ${fallback};`);
  return installIcons(patch, iconbin, batteryIcons());
}

/**
 * The start-up zero fill up to the heap, over the sbrk arena that keeps BATTERY_SHOWN. Last of all
 * (`installExtensions`): the other additions extend the fill to 0x55837300 and expect it there or
 * at its official end.
 */
export function extendBatteryZeroFill(patch: Patch): void {
  const w = patch.word(ZERO_FILL_END);
  if (w === ARENA_END) return;
  if (w !== adr(0x55837300)) expectWord(patch, ZERO_FILL_END, adr(0x558372d4));
  patch.setWord(ZERO_FILL_END, ARENA_END, 'start-up zero fill also clears the unused sbrk arena before the heap (battery percentage)');
}
