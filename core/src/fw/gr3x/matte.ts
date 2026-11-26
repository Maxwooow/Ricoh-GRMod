// SPDX-License-Identifier: GPL-2.0-only
/**
 * Matte live view for GR III 2.10 / IIIx 1.60 (as GR IV's ratio shade, ../gr4v120/aspect/shade.ts):
 * with an added ratio selected the live view shows the whole 3:2 frame and the part outside the
 * ratio is darkened; the photo is cropped as before. The tone is chosen when the firmware is built
 * ('dark': UI palette colour 16, black at 50 %; 'light': colour 19, grey at 25 %).
 *
 * 1. The live view keeps its 3:2 picture. GR III turns the capture aspect into the live-view mode in
 *    two places, both a call of the capture aspect getter (0x5354A778, the capture settings' +0x7B6):
 *    the live-view mode function 0x53669424 (call 0x53669440; it returns the mode and stores it at
 *    +4 of the converter object, which the main live-view controller keeps at +0xA8C and copies to
 *    +0x751) and the secondary preview controller 0x53437170 (call 0x534371C4; it hands the mode to
 *    the preview setup 0x5366632C and the aperture 0x53666770). These are GR IV's two calls (its
 *    0x538B40E0 and 0x53664424). Here, as on GR IV, both calls go through a function that answers
 *    0 (3:2) for an added ratio. The ratio program's own hooks right after them (liveview.ts,
 *    0x53669444, 0x534371C8, 0x53437210) then take their native branches. Every other live-view
 *    geometry hook of the ratio program takes its identity from that mode (the controller's
 *    +0x751, the converter's +4, or the secondary controller's mode), never from the capture aspect:
 *    the face-detection descriptor (0x53450668: r8 = +0x751 at all five callers), the five aperture
 *    sites (r1 = +0x751), the preview rectangles (experimental.ts, 0x5366632C: r2 = +0x751 or the
 *    secondary mode), the dimension entries 0x53668774 / 0x53668BE4 (identity from the converter
 *    functions 0x53669490 / 0x536695F8 / 0x53669790 / 0x53669978 and 0x53668B04 / 0x53668FB0, whose
 *    callers pass +0x751, the converter's +4 (LiveViewProcessRecipe's CreateRecipeSequence) or 0),
 *    the vertical helper 0x536699C4 and the resize ROI 0x53459458 / 0x53459BD4 (sl = +0x751 from
 *    0x5343CE98). So all of them run as for 3:2. The photo keeps the added identity: its sizes,
 *    development crop, screen / thumbnail crops, RAW, metadata and AE / AWB map records read the
 *    capture settings' +0x7B6. The AF area limits (image-pipeline.ts, 0x532AFC0C / 0x532AFE44 /
 *    0x532AFE74) read the Aspect Ratio setting: they keep the AF area inside the photo's window, in
 *    the 720x480 screen coordinates of the 3:2 frame, which is where the window of the matte is
 *    (see REPORT of this addition for the whole table).
 * 2. The darkening is drawn on the shooting screen's grid view (GridView, vtable 0x53C0AA68, Draw in slot 19 at 0x53C0AAB4; its
 *    Draw 0x5339C3B0, base view Draw 0x533AB9BC, layout and constructor are GR IV 1.20's instruction
 *    for instruction) with the UI's rectangle fill (factory 0x5320804C, getter 0x532081EC, fill
 *    0x53208A2C: the sequence 32 of the 46 fill calls use in both cameras) in a half-transparent
 *    colour of the UI palette (0x53DBB1EC, GR IV's 48 words).
 *     - GridView constructor: the store at 0x5339C01C clears +0xF4..+0xF7 (natively +0xF4 only).
 *     - UpdateViewGrid ends in SetVisible(grid view r6, grid on r5) at 0x53177538..44 (GR IV's
 *       0x53190318, the same code): it marks the view, +0xF6 = 1 | (grid on ? 2 : 0), and keeps it
 *       visible with an added ratio selected.
 *     - Draw (vtable slot 19): for a marked view with an added ratio selected (the Aspect Ratio
 *       setting, byte 0x4C2 of the user settings, through the user-settings object 0x5320B31C as the
 *       camera's getter 0x53245260 reads it), fill the bands outside the ratio, centred on the canvas
 *       (+0x18 / +0x1A of the drawing surface), then the grid lines if they are on, in the window:
 *       the frame (+0x30) is narrowed to the ratio and centred for the native Draw only, then put
 *       back with the base Draw's copy at +0x44. GR III addition: the frame is narrowed only when it
 *       has the shape of 3:2 (|2w - 3h| <= h / 16); a frame already of another shape is left as it is.
 *     - The 4x4 style's diagonals (line views +0xEC / +0xF0, set by the layout's calls 0x5339C2D8 /
 *       0x5339C318 of 0x53392384) go to the corners of the window, with the same 3:2 test on the
 *       layout's frame. With custom grid lines (grid.ts) its layout calls the same wrapper.
 * 3. Movies: "selected" is false in movie mode (the capture settings' movie test 0x53549958, the
 *    getter of +0x74E: 18 of its 37 call sites are GR IV's 0x5377CAB8 sites instruction for
 *    instruction; its root is 0x53525D5C, capture settings at +0). Then the grid view is the camera's.
 */
import { assembleWords } from '../aspect/arm';
import { FirmwareError } from '../types';
import { adr } from './target';

/** GridView's vtable slot 19 (Draw): the vtable's functions start at 0x53C0AA68 (0x53C0AA64 holds its typeinfo pointer). */
const GRID_DRAW_SLOT = adr(0x53c0aab4);
const GRID_DRAW = adr(0x5339c3b0);
const VIEW_BASE_DRAW = adr(0x533ab9bc);
const GRID_CTOR_CLEAR = adr(0x5339c01c);
const SET_VISIBLE = adr(0x533ad3c0);
const UPDATE_GRID_VISIBLE = adr(0x53177538);
const USER_SETTINGS = adr(0x5320b31c);
const ASPECT_GETTER = adr(0x53245260);
const ASPECT_BYTE = 0x4c2;
const FILL_FACTORY = adr(0x5320804c);
const FILL_GET = adr(0x532081ec);
const FILL_RECT = adr(0x53208a2c);
const CAPTURE_ASPECT = adr(0x5354a778);
const SETTING_ROOT = adr(0x53525d5c);
const IS_MOVIE = adr(0x53549958);
const LIVE_MODE_CALLS = [adr(0x53669440), adr(0x534371c4)] as const;
const DIAGONAL_CALLS = [adr(0x5339c2d8), adr(0x5339c318)] as const;
const LINE_SET_POINTS = adr(0x53392384);
const MARK = 0xf6;
const FRAME = 0x30;
const DRAWN = 0x44;
const VISIBLE = 0x9e;
const LINE_VIEWS = [0xec, 0xf0] as const;

export type Gr3xMatteTone = 'dark' | 'light';
export const GR3X_MATTE_TONES: readonly Gr3xMatteTone[] = ['dark', 'light'];
const TONE_COLOUR: Readonly<Record<Gr3xMatteTone, number>> = { dark: 16, light: 19 };

export interface Gr3xMatteProgram {
  code(source: string): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}

const enc = (source: string, at: number): number => assembleWords(source, at)[0];

/** One rectangle: fill (x, y, w, h) in r0..r3 unless w or h is not positive. Keeps r4-r11. */
function band(n: number, colour: number): string {
  return `cmp r2,#0;ble skip${n};cmp r3,#0;ble skip${n};` +
    `str r5,[sp];str r0,[sp,#4];str r1,[sp,#8];str r2,[sp,#12];str r3,[sp,#16];mov ip,#${colour};str ip,[sp,#20];mov ip,#0;str ip,[sp,#24];str ip,[sp,#28];` +
    `bl #${FILL_FACTORY};bl #${FILL_GET};mov r1,sp;bl #${FILL_RECT};skip${n}:`;
}

/** Z set when (w, h) in `w`, `h` has the shape of 3:2: |2w - 3h| <= h / 16. Uses r0, r1. */
const threeTwo = (w: string, h: string): string =>
  `add r0,${w},${w};add r1,${h},${h};add r1,r1,${h};subs r0,r0,r1;rsbmi r0,r0,#0;cmp r0,${h},lsr #4;movls r0,#0;movhi r0,#1;cmp r0,#0;`;

/**
 * `get` maps an identity to its live-view row {window width, 720, window height, 480} or 0 for any
 * other identity (liveview.ts, uses r0 and ip only); `scale` is r0 * r1 / r2 (liveview.ts).
 * Returns the entries; `matteSetPoints` is what a layout calls instead of the line views' point setter.
 */
export function installGr3xMatte(p: Gr3xMatteProgram, get: number, scale: number, tone: Gr3xMatteTone = 'dark'): Record<string, number> {
  const colour = TONE_COLOUR[tone];
  if (colour === undefined) throw new FirmwareError('bad-edit', 'unknown matte tone');
  const bad = (what: string): never => { throw new FirmwareError('unexpected-layout', `IIIx matte: ${what}`); };
  const bl = (at: number, target: number) => enc(`bl #${target}`, at);
  const slot = GRID_DRAW_SLOT;
  if (p.word(slot) !== GRID_DRAW) bad('grid view Draw is not where it was expected');
  if (p.word(GRID_DRAW + 0x3c) !== enc(`add r2,r0,#${FRAME}`, 0)) bad('grid view Draw: the frame has moved');
  if (p.word(VIEW_BASE_DRAW) !== enc(`ldrb r2,[r0,#${VISIBLE}]`, 0)) bad('view Draw: the visible flag has moved');
  if (p.word(VIEW_BASE_DRAW + 0x34) !== enc(`add r3,r0,#${FRAME}`, 0)) bad('view Draw: the frame has moved');
  if (p.word(VIEW_BASE_DRAW + 0x3c) !== enc(`add ip,r0,#${DRAWN}`, 0)) bad('view Draw: the drawn frame has moved');
  if (p.word(UPDATE_GRID_VISIBLE + 12) !== enc(`b #${SET_VISIBLE}`, UPDATE_GRID_VISIBLE + 12)) bad('live-view grid update tail has changed');
  // The camera's Aspect Ratio getter: ldr r3,[r0,#4]; ldrb r0,[r3,#0x4c2]; bx lr (read inline below).
  if (p.word(ASPECT_GETTER) !== 0xe5903004 || p.word(ASPECT_GETTER + 4) !== 0xe5d304c2 || p.word(ASPECT_GETTER + 8) !== 0xe12fff1e) bad('the Aspect Ratio getter has changed');

  // The live-view mode and the secondary controller's mode: the capture aspect, an added ratio as 3:2 (0).
  // `get` uses r0 and ip only; r4 is kept for the caller.
  const live = p.code(`push {r4,lr};bl #${CAPTURE_ASPECT};mov r4,r0;bl #${get};cmp r0,#0;movne r0,#0;moveq r0,r4;pop {r4,pc};`);
  for (const call of LIVE_MODE_CALLS) p.patch(call, bl(call, CAPTURE_ASPECT), bl(call, live), 'matte live view: an added ratio\'s live view as 3:2');

  // r0 = the live-view row of the selected still ratio, or 0 (also in movie mode). Keeps r4-r11.
  const selected = p.code(`push {r4,lr};bl #${SETTING_ROOT};ldr r0,[r0];bl #${IS_MOVIE};cmp r0,#0;bne none;` +
    `bl #${USER_SETTINGS};ldr r3,[r0,#4];cmp r3,#0;beq none;ldrb r0,[r3,#${ASPECT_BYTE}];bl #${get};pop {r4,pc};none:mov r0,#0;pop {r4,pc};`);

  // Constructor: clear +0xF4..+0xF7 (r5 = 0 there).
  p.patch(GRID_CTOR_CLEAR, enc('strb r5,[r4,#0xf4]', GRID_CTOR_CLEAR), enc('str r5,[r4,#0xf4]', GRID_CTOR_CLEAR), 'matte: grid view constructor clears the mark');

  // UpdateViewGrid tail: r6 = the grid view, r5 = grid on.
  const tail = p.code(`push {r0,r2,r3,r4,ip,lr};cmp r5,#0;movne r0,#3;moveq r0,#1;strb r0,[r6,#${MARK}];bl #${selected};cmp r0,#0;mov r1,r5;movne r1,#1;pop {r0,r2,r3,r4,ip,lr};b #${UPDATE_GRID_VISIBLE + 4};`);
  p.patch(UPDATE_GRID_VISIBLE, enc('mov r1,r5', UPDATE_GRID_VISIBLE), enc(`b #${tail}`, UPDATE_GRID_VISIBLE), 'matte: the grid view is marked and kept visible for an added ratio');

  // Draw(view = r0, context = r1). Stack: [sp..+31] the fill's arguments, [sp+32..+47] the saved
  // frame, [sp+48] the live-view row.
  let d = 'push {r3-r11,lr};sub sp,sp,#56;mov r4,r0;mov r5,r1;';
  d += `ldrb r0,[r4,#${MARK}];tst r0,#1;beq native;bl #${selected};movs r7,r0;beq native;str r7,[sp,#48];`;
  // Canvas: width +0x18, height +0x1A of the drawing surface; a missing height is width * 2 / 3.
  d += 'ldrh r8,[r5,#0x18];ldrh r9,[r5,#0x1a];cmp r8,#0;beq lines;';
  d += `cmp r9,#0;bne sized;mov r0,r8;mov r1,#2;mov r2,#3;bl #${scale};mov r9,r0;sized:`;
  d += `mov r0,r9;ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};mov r10,r0;`;
  d += `mov r0,r8;ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};mov r11,r0;`;
  d += 'sub r6,r9,r10;mov r6,r6,lsr #1;';
  d += 'mov r0,#0;mov r1,#0;mov r2,r8;mov r3,r6;' + band(1, colour);
  d += 'mov r0,#0;add r1,r6,r10;mov r2,r8;sub r3,r9,r1;' + band(2, colour);
  d += 'sub r7,r8,r11;mov r7,r7,lsr #1;';
  d += 'mov r0,#0;mov r1,r6;mov r2,r7;mov r3,r10;' + band(3, colour);
  d += 'add r0,r7,r11;mov r1,r6;sub r2,r8,r0;mov r3,r10;' + band(4, colour);
  // Grid off: the base Draw only, the line views (the diagonals) hidden meanwhile and put back.
  d += `lines:ldrb r0,[r4,#${MARK}];tst r0,#2;bne fit;mov r0,#0;`;
  d += `ldr r6,[r4,#${LINE_VIEWS[0]}];cmp r6,#0;ldrbne r8,[r6,#${VISIBLE}];strbne r0,[r6,#${VISIBLE}];`;
  d += `ldr r7,[r4,#${LINE_VIEWS[1]}];cmp r7,#0;ldrbne r9,[r7,#${VISIBLE}];strbne r0,[r7,#${VISIBLE}];`;
  d += `mov r0,r4;mov r1,r5;bl #${VIEW_BASE_DRAW};`;
  d += `cmp r6,#0;strbne r8,[r6,#${VISIBLE}];cmp r7,#0;strbne r9,[r7,#${VISIBLE}];b done;`;
  // Grid on: the native Draw with the frame narrowed to the window (a 3:2 frame only), then the
  // frame put back, and its copy at +0x44 if the base Draw made one.
  d += 'fit:';
  for (let k = 0; k < 16; k += 4) d += `ldr r0,[r4,#${FRAME + k}];str r0,[sp,#${32 + k}];`;
  d += 'ldr r8,[sp,#40];ldr r9,[sp,#44];' + threeTwo('r8', 'r9') + 'bne native;';
  d += 'ldr r7,[sp,#48];';
  d += `mov r0,r8;ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};mov r8,r0;`;
  d += `mov r0,r9;ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};mov r9,r0;`;
  d += `ldr r0,[sp,#40];sub r0,r0,r8;ldr r1,[sp,#32];add r0,r1,r0,lsr #1;str r0,[r4,#${FRAME}];`;
  d += `ldr r0,[sp,#44];sub r0,r0,r9;ldr r1,[sp,#36];add r0,r1,r0,lsr #1;str r0,[r4,#${FRAME + 4}];`;
  d += `str r8,[r4,#${FRAME + 8}];str r9,[r4,#${FRAME + 12}];`;
  d += `mov r0,r4;mov r1,r5;bl #${GRID_DRAW};`;
  d += `ldrb r6,[r4,#${VISIBLE}];cmp r6,#0;`;
  for (let k = 0; k < 16; k += 4) d += `ldr r0,[sp,#${32 + k}];str r0,[r4,#${FRAME + k}];strne r0,[r4,#${DRAWN + k}];`;
  d += 'b done;';
  d += `native:mov r0,r4;mov r1,r5;bl #${GRID_DRAW};done:add sp,sp,#56;pop {r3-r11,pc};`;
  const draw = p.code(d);
  p.patch(slot, GRID_DRAW, draw, 'matte: grid view Draw darkens the live view outside an added ratio');

  // Diagonals: (line view r0, p1 r1, p2 r2, thickness r3), points {x, y} at corners of (0,0)-(w,h).
  // With an added ratio and a 3:2 frame, each coordinate 0 becomes the window's near edge, any other its far one.
  // Stack: [sp..+15] x0, x1, y0, y1, then the caller's r0-r8, lr.
  let q = 'push {r0-r8,lr};sub sp,sp,#16;';
  q += `bl #${selected};movs r7,r0;beq call;ldr r4,[sp,#20];ldr r5,[sp,#24];`;
  q += 'ldr r6,[r4];ldr r0,[r5];cmp r6,r0;movlo r6,r0;ldr r8,[r4,#4];ldr r0,[r5,#4];cmp r8,r0;movlo r8,r0;';
  q += threeTwo('r6', 'r8') + 'bne call;';
  q += `mov r0,r6;ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};`;
  q += 'sub r1,r6,r0;mov r1,r1,lsr #1;str r1,[sp];add r1,r1,r0;str r1,[sp,#4];';
  q += `mov r0,r8;ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};`;
  q += 'sub r1,r8,r0;mov r1,r1,lsr #1;str r1,[sp,#8];add r1,r1,r0;str r1,[sp,#12];';
  for (const pt of ['r4', 'r5']) {
    q += `ldr r0,[${pt}];cmp r0,#0;ldreq r0,[sp];ldrne r0,[sp,#4];str r0,[${pt}];`;
    q += `ldr r0,[${pt},#4];cmp r0,#0;ldreq r0,[sp,#8];ldrne r0,[sp,#12];str r0,[${pt},#4];`;
  }
  q += `call:add sp,sp,#16;pop {r0-r8,lr};b #${LINE_SET_POINTS};`;
  const points = p.code(q);
  for (const call of DIAGONAL_CALLS) p.patch(call, bl(call, LINE_SET_POINTS), bl(call, points), 'matte: grid view diagonals in the window');
  return { matteLive: live, matteSelected: selected, matteTail: tail, matteDraw: draw, matteSetPoints: points };
}
