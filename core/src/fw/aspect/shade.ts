// SPDX-License-Identifier: GPL-2.0-only
/**
 * Live view of an added ratio as a framing guide: the whole 3:2 frame stays visible and the part
 * outside the ratio is darkened by half, instead of the cropped live view with black bars. The
 * photo is cropped exactly as before.
 *
 * 1. The live view keeps its 3:2 picture: `buildGeometry` leaves out the three hooks that crop it
 *    (the screen rectangle at 0x538876B8 and the source ROI at 0x53646310 / 0x53646C1C). An added
 *    identity then takes the native default branches, which are the 3:2 ones. Everything that
 *    decides the photo (sizes, crop origins, development, RAW, metadata) is unchanged.
 * 2. The darkening is drawn on the shooting screen's grid view (GridView, vtable 0x53E98BD8), with
 *    the UI's own rectangle fill (0x5323C588) in colour 16 of the UI palette, 0x80000000: black at
 *    half opacity on the 32-bit OSD layer above the live view.
 *     - GridView constructor: the word store at 0x535784B4 clears +0xF4..+0xF7 (the native code
 *       clears +0xF4 / +0xF5 only), so +0xF6 starts at 0 in every grid view.
 *     - The live-view controller's UpdateViewGrid (0x5318F09C) ends in SetVisible(grid, on) at
 *       0x5318F0C0..CC. There it marks its grid view: +0xF6 = 1 | (grid lines on ? 2 : 0), and
 *       with an added ratio selected it keeps the view visible even with the grid off.
 *     - GridView::Draw (vtable slot 19): for a marked view with an added ratio selected (user
 *       setting byte 0x49F, as in crop_state.c), fill the bands outside the ratio, centred on the
 *       canvas (width +0x18, height +0x1A of the drawing surface), then draw the grid lines only if they
 *       are on; otherwise the native Draw.
 */
import { FirmwareError } from '../types';
import { assembleWords } from './arm';
import type { Program } from './build';

const GRID_VTABLE = 0x53e98bd8;
const GRID_DRAW_SLOT = GRID_VTABLE + 19 * 4;
const GRID_DRAW = 0x53578848;
const VIEW_BASE_DRAW = 0x535880b0;
const GRID_CTOR_CLEAR = 0x535784b4;
const SET_VISIBLE = 0x53589ab4;
const UPDATE_GRID_VISIBLE = 0x5318f0c0;
const CURRENT_USERDATA = 0x5323f018;
const ASPECT_BYTE = 0x49f;
const FILL_FACTORY = 0x5323bbb8;
const FILL_GET = 0x5323bd30;
const FILL_RECT = 0x5323c588;
const SHADE_COLOUR = 16;
const MARK = 0xf6;

function fail(message: string): never {
  throw new FirmwareError('unexpected-layout', message);
}

/** One band: fill (x, y, w, h) held in r0..r3 unless w or h is not positive. Keeps r4-r11. Stack stays 8-byte aligned. */
function band(n: number): string {
  return `cmp r2,#0;ble skip${n};cmp r3,#0;ble skip${n};` +
    `str r5,[sp];str r0,[sp,#4];str r1,[sp,#8];str r2,[sp,#12];str r3,[sp,#16];mov ip,#${SHADE_COLOUR};str ip,[sp,#20];mov ip,#0;str ip,[sp,#24];str ip,[sp,#28];` +
    `bl #${FILL_FACTORY};bl #${FILL_GET};mov r1,sp;bl #${FILL_RECT};skip${n}:`;
}

/** `get` maps an identity to its geometry row ({fx num, fx den, fy num, fy den, ...}) or 0; `scale` is r0 * r1 / r2. */
export function installRatioShade(p: Program, get: number, scale: number): void {
  const word = (at: number): number => p.sourceWord(at);
  if (word(GRID_DRAW_SLOT) !== GRID_DRAW) fail('grid view Draw is not where it was expected');
  p.expect(GRID_CTOR_CLEAR, 'strb r5,[r4,#0xf4]', 'grid view constructor has changed');
  p.expect(UPDATE_GRID_VISIBLE, 'mov r1,r5', 'live-view grid update has changed');
  p.expect(UPDATE_GRID_VISIBLE + 12, `b #${SET_VISIBLE}`, 'live-view grid update tail has changed');

  // r0 = the geometry row of the selected still ratio, or 0. Keeps r4-r11.
  const selected = p.emit(`push {r4,lr};bl #${CURRENT_USERDATA};cmp r0,#0;beq none;ldrb r0,[r0,#${ASPECT_BYTE}];bl #${get};pop {r4,pc};none:pop {r4,pc};`);

  // Constructor: clear +0xF4..+0xF7 (r5 = 0 there).
  p.patch.setWord(GRID_CTOR_CLEAR, assembleWords('str r5,[r4,#0xf4]', GRID_CTOR_CLEAR)[0], 'grid view constructor: clear the shade mark');

  // UpdateViewGrid tail: r6 = the grid view, r5 = grid on.
  p.hook(UPDATE_GRID_VISIBLE,
    `push {r0,r2,r3,r4,ip,lr};cmp r5,#0;movne r0,#3;moveq r0,#1;strb r0,[r6,#${MARK}];bl #${selected};cmp r0,#0;mov r1,r5;movne r1,#1;pop {r0,r2,r3,r4,ip,lr};b #${UPDATE_GRID_VISIBLE + 4};`);

  // Draw(view = r0, context = r1).
  let d = 'push {r3-r11,lr};sub sp,sp,#32;mov r4,r0;mov r5,r1;';
  d += `ldrb r0,[r4,#${MARK}];tst r0,#1;beq native;bl #${selected};movs r7,r0;beq native;`;
  // Canvas size: width +0x18, height +0x1A of the drawing surface (the context itself, as in the
  // native fill); a missing height is width * 2 / 3.
  d += 'ldrh r8,[r5,#0x18];ldrh r9,[r5,#0x1a];cmp r8,#0;beq lines;';
  d += `cmp r9,#0;bne sized;mov r0,r8;mov r1,#2;mov r2,#3;bl #${scale};mov r9,r0;sized:`;
  // r10 = height of the ratio, r11 = its width, r6 = top band, ip-free: left band computed below.
  d += `mov r0,r9;ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};mov r10,r0;`;
  d += `mov r0,r8;ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};mov r11,r0;`;
  d += 'sub r6,r9,r10;mov r6,r6,lsr #1;';
  // top, bottom (full width)
  d += 'mov r0,#0;mov r1,#0;mov r2,r8;mov r3,r6;' + band(1);
  d += 'mov r0,#0;add r1,r6,r10;mov r2,r8;sub r3,r9,r1;' + band(2);
  // left, right (between the bands)
  d += 'sub r7,r8,r11;mov r7,r7,lsr #1;';
  d += 'mov r0,#0;mov r1,r6;mov r2,r7;mov r3,r10;' + band(3);
  d += 'add r0,r7,r11;mov r1,r6;sub r2,r8,r0;mov r3,r10;' + band(4);
  // Grid lines only when the grid is on; the view is kept visible for the shade alone otherwise.
  d += `lines:ldrb r0,[r4,#${MARK}];tst r0,#2;bne native;mov r0,r4;mov r1,r5;bl #${VIEW_BASE_DRAW};b done;`;
  d += `native:mov r0,r4;mov r1,r5;bl #${GRID_DRAW};done:add sp,sp,#32;pop {r3-r11,pc};`;
  const draw = p.emit(d);
  p.patch.setWord(GRID_DRAW_SLOT, draw, 'grid view Draw: live-view shade of an added ratio');
}
