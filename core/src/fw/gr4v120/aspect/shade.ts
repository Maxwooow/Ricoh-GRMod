// SPDX-License-Identifier: GPL-2.0-only
/**
 * Live view of an added ratio as a framing guide: the whole 3:2 frame stays visible and the part
 * outside the ratio is darkened, instead of the cropped live view with black bars. The photo is
 * cropped exactly as before.
 *
 * 1. The live view keeps its 3:2 picture. Every geometry hook of the added ratios stays as without
 *    the shade; instead the two places that turn the capture aspect into the live-view mode see 3:2
 *    for an added ratio: the capture aspect getter call (0x5377D960) in the live-view mode function
 *    (0x538B40E0) and in its mode check (0x53664424), the same two calls GRKit's Framing replaces on
 *    the GR IV for its own crops (runtime/framing.S, framing_live_mode / framing_live_check). The
 *    live-view mode is stored at +0x8D of the live-view controller, and every live-view and AF
 *    geometry hook of the added ratios takes its identity from that mode (screen rectangle, window
 *    selectors, source ROI, tracking, hardware mode, scalers), so all of them take the native 3:2
 *    branches. The photo keeps the added identity: its sizes, development crop (CommonProperty
 *    +0x7DA), screen and thumbnail crops, RAW and metadata read the capture aspect, not the
 *    live-view mode. (The first version, 06d653a on the ratio-shade branch, left out three crop
 *    hooks instead; on the camera the rest still cropped the window, and the AF route squeezed
 *    the 3:2 picture into it.)
 * 2. The darkening is drawn on the shooting screen's grid view (GridView, vtable 0x53ECEE00), with
 *    the UI's own rectangle fill (0x5323E1C0) in a half-transparent colour of the UI palette
 *    (0x540781EC) on the 32-bit OSD layer above the live view: colour 16 (0x80000000, black at
 *    half opacity, the value GRKit's mask writes) or 19 (0x40555555, grey at 25 %).
 *     - GridView constructor: the word store at 0x5359B780 clears +0xF4..+0xF7 (the native code
 *       clears +0xF4 / +0xF5 only), so +0xF6 starts at 0 in every grid view.
 *     - The live-view controller's UpdateViewGrid (0x531902F4) ends in SetVisible(grid, on) at
 *       0x53190318..CC. There it marks its grid view: +0xF6 = 1 | (grid lines on ? 2 : 0), and
 *       with an added ratio selected it keeps the view visible even with the grid off.
 *     - GridView::Draw (vtable slot 19): for a marked view with an added ratio selected (user
 *       setting byte 0x49F, as in crop_state.c), fill the bands outside the ratio, centred on the
 *       canvas (width +0x18, height +0x1A of the drawing surface), then draw the grid
 *       lines only if they are on; otherwise the native Draw. With the grid off the view's line
 *       views (the diagonals, its children) keep the visibility of the last layout, because the
 *       camera hides the grid without laying it out; they are hidden while the base Draw draws
 *       the children, and put back.
 *     - The grid lines go in the photo's window too. The camera fits the grid view's frame
 *       (x, y, w, h at +0x30) to the live picture (UpdateViewGrid 0x53190264 -> 0x533AFBA4), so
 *       with the live view at 3:2 the frame is the whole picture and the lines would divide it,
 *       bands included. For the native Draw only, the frame is narrowed to the ratio and centred
 *       in it (the same fractions and rounding as the bands), then put back, together with the
 *       copy of it the base view Draw keeps at +0x44 (0x535AB3B4: +0x30 -> +0x44 when visible,
 *       +0x9E). The lines are the camera's own, drawn as for a picture of that shape.
 *     - The 4x4 style's diagonals are two line views inside the grid view (+0xEC, +0xF0), laid out
 *       by its layout (0x5359b944) corner to corner of the frame, (0,0)-(w,h) and (0,h)-(w,0), with
 *       0x5359191C (line view, p1, p2, thickness), not drawn by GridView::Draw: with the frame
 *       narrowed only for Draw they would be the whole picture's diagonals, cut at the window's
 *       edges. Both calls go through a wrapper that, with an added ratio selected, moves each point
 *       to the corner of the window (the same fractions and rounding as the bands, centred in the
 *       frame) before the line view's own setter. The layout runs whenever UpdateViewGrid sets the
 *       frame (slot 6 -> 7), so a change of ratio lays them out again.
 * 3. Movies: the aspect setting stays the photos' in movie mode, and a movie is recorded at its own
 *    size, so in movie mode nothing of the added ratio is drawn (no bands, the grid lines and the
 *    diagonals on the whole picture, the view's visibility as the grid's). "Selected" is asked of
 *    the camera's own movie test, the one the Image Control screen asks for its photo / movie list
 *    (the setting root 0x53750008, its capture settings at +4, 0x5377CAB8 != 0).
 */
import { FirmwareError } from '../../types';
import { adr } from '../target';
import { assembleWords } from './arm';
import { Program } from './build';

const GRID_VTABLE = adr(0x53ecee00);
const GRID_DRAW_SLOT = GRID_VTABLE + 19 * 4;
const GRID_DRAW = adr(0x5359bb14);
const VIEW_BASE_DRAW = adr(0x535ab380);
const GRID_CTOR_CLEAR = adr(0x5359b780);
const SET_VISIBLE = adr(0x535acd84);
const UPDATE_GRID_VISIBLE = adr(0x53190318);
const CURRENT_USERDATA = adr(0x53240c38);
const ASPECT_BYTE = 0x49f;
const FILL_FACTORY = adr(0x5323d7f0);
const FILL_GET = adr(0x5323d968);
const FILL_RECT = adr(0x5323e1c0);
const CAPTURE_ASPECT = adr(0x5377d960);
/** The setting root and its capture settings' movie test (non-zero in movie mode). */
const SETTING_ROOT = adr(0x53750008);
const IS_MOVIE = adr(0x5377cab8);
/** The capture aspect getter calls of the live-view mode function and of its mode check. */
const LIVE_MODE_CALLS = [adr(0x538b40e0), adr(0x53664424)] as const;
const MARK = 0xf6;
/** The view's frame (x, y, w, h), the base Draw's copy of it, and the visible flag. */
const FRAME = 0x30;
const DRAWN = 0x44;
const VISIBLE = 0x9e;
/** The grid view's two line views (the 4x4 style's diagonals), its children. */
const LINE_VIEWS = [0xec, 0xf0] as const;
/** The grid view's layout calls of the line views' point setter (the two diagonals). */
export const DIAGONAL_CALLS = [adr(0x5359ba3c), adr(0x5359ba7c)] as const;
const LINE_SET_POINTS = adr(0x5359191c);

/** How dark the part outside the photo is: UI palette colours 16 (black at 50 %) and 19 (grey at 25 %). */
export type ShadeTone = 'dark' | 'light';
export const SHADE_TONES: readonly ShadeTone[] = ['dark', 'light'];
const TONE_COLOUR: Readonly<Record<ShadeTone, number>> = { dark: 16, light: 19 };
/**
 * A shade chosen in the camera menu (GR IV 1.20 / 1.21, `viewmenu.ts`): a field of a setting byte
 * (bits `shift`.. of `byte`, `mask` wide) picks the colour, `colours[code]` a UI palette number,
 * 0 for no shade (the bands are not drawn; the grid lines still go in the photo's window).
 */
export interface ShadeSetting { byte: number; shift: number; mask: number; colours: readonly number[] }

function fail(message: string): never {
  throw new FirmwareError('unexpected-layout', message);
}

/** One rectangle: fill (x, y, w, h) held in r0..r3 unless w or h is not positive. Keeps r4-r11. Stack stays 8-byte aligned. */
function band(n: number, colour: number | null): string {
  // null: the colour chosen in the camera, at [sp+52].
  const load = colour === null ? 'ldr ip,[sp,#52]' : `mov ip,#${colour}`;
  return `cmp r2,#0;ble skip${n};cmp r3,#0;ble skip${n};` +
    `str r5,[sp];str r0,[sp,#4];str r1,[sp,#8];str r2,[sp,#12];str r3,[sp,#16];${load};str ip,[sp,#20];mov ip,#0;str ip,[sp,#24];str ip,[sp,#28];` +
    `bl #${FILL_FACTORY};bl #${FILL_GET};mov r1,sp;bl #${FILL_RECT};skip${n}:`;
}

/**
 * `get` maps an identity to its geometry row ({fx num, fx den, fy num, fy den, ...}) or 0; `scale` is r0 * r1 / r2
 * (both code of the ratios' Program). The checks read the image as it is now, after the other hooks.
 */
export function installRatioShade(geometry: Program, get: number, scale: number, tone: ShadeTone | ShadeSetting = 'dark'): void {
  const p = new Program(geometry.patch);
  const word = (at: number): number => p.sourceWord(at);
  const setting = typeof tone === 'object' ? tone : null;
  const colour = setting ? null : TONE_COLOUR[tone as ShadeTone];
  if (colour === undefined) fail('unknown shade tone');
  if (setting && (setting.colours.length !== setting.mask + 1 || setting.colours.some((c) => !(Number.isInteger(c) && c >= 0 && c < 256)))) fail('bad shade setting');
  if (word(GRID_DRAW_SLOT) !== GRID_DRAW) fail('grid view Draw is not where it was expected');
  p.expect(GRID_CTOR_CLEAR, 'strb r5,[r4,#0xf4]', 'grid view constructor has changed');
  p.expect(UPDATE_GRID_VISIBLE, 'mov r1,r5', 'live-view grid update has changed');
  p.expect(UPDATE_GRID_VISIBLE + 12, `b #${SET_VISIBLE}`, 'live-view grid update tail has changed');
  for (const call of LIVE_MODE_CALLS) p.expect(call, `bl #${CAPTURE_ASPECT}`, 'live-view mode: capture aspect call has changed');
  p.expect(GRID_DRAW + 0x3c, `add r2,r0,#${FRAME}`, 'grid view Draw: the frame has moved');
  p.expect(VIEW_BASE_DRAW + 0x34, `add r3,r0,#${FRAME}`, 'view Draw: the frame has moved');
  p.expect(VIEW_BASE_DRAW + 0x3c, `add ip,r0,#${DRAWN}`, 'view Draw: the drawn frame has moved');
  p.expect(VIEW_BASE_DRAW, `ldrb r2,[r0,#${VISIBLE}]`, 'view Draw: the visible flag has moved');
  for (const call of DIAGONAL_CALLS) p.expect(call, `bl #${LINE_SET_POINTS}`, 'grid view layout: the diagonals have moved');

  // The live-view mode and its check: the capture aspect, with an added ratio read as 3:2 (0).
  // `get` uses r0 and ip only; r4 is kept for the caller.
  const live = p.emit(`push {r4,lr};bl #${CAPTURE_ASPECT};mov r4,r0;bl #${get};cmp r0,#0;movne r0,#0;moveq r0,r4;pop {r4,pc};`);
  for (const call of LIVE_MODE_CALLS) p.patch.setWord(call, assembleWords(`bl #${live}`, call)[0], 'live-view mode: added ratios as 3:2');

  // r0 = the geometry row of the selected still ratio, or 0 (also in movie mode). Keeps r4-r11.
  const selected = p.emit(`push {r4,lr};bl #${SETTING_ROOT};ldr r0,[r0,#4];bl #${IS_MOVIE};cmp r0,#0;movne r0,#0;bne none;bl #${CURRENT_USERDATA};cmp r0,#0;beq none;ldrb r0,[r0,#${ASPECT_BYTE}];bl #${get};pop {r4,pc};none:pop {r4,pc};`);

  // Constructor: clear +0xF4..+0xF7 (r5 = 0 there).
  p.patch.setWord(GRID_CTOR_CLEAR, assembleWords('str r5,[r4,#0xf4]', GRID_CTOR_CLEAR)[0], 'grid view constructor: clear the shade mark');

  // UpdateViewGrid tail: r6 = the grid view, r5 = grid on.
  p.hook(UPDATE_GRID_VISIBLE,
    `push {r0,r2,r3,r4,ip,lr};cmp r5,#0;movne r0,#3;moveq r0,#1;strb r0,[r6,#${MARK}];bl #${selected};cmp r0,#0;mov r1,r5;movne r1,#1;pop {r0,r2,r3,r4,ip,lr};b #${UPDATE_GRID_VISIBLE + 4};`);

  // Draw(view = r0, context = r1).
  // Stack: [sp..+31] the fill's arguments, [sp+32..+47] the saved frame, [sp+48] the geometry row,
  // [sp+52] the colour chosen in the camera.
  const colours = setting ? p.blob(Uint8Array.from(setting.colours)) : 0;
  let d = 'push {r3-r11,lr};sub sp,sp,#56;mov r4,r0;mov r5,r1;';
  d += `ldrb r0,[r4,#${MARK}];tst r0,#1;beq native;bl #${selected};movs r7,r0;beq native;str r7,[sp,#48];`;
  if (setting) {
    d += `movw r0,#${setting.byte & 0xffff};movt r0,#${setting.byte >>> 16};ldrb r0,[r0];${setting.shift ? `mov r0,r0,lsr #${setting.shift};` : ''}and r0,r0,#${setting.mask};`;
    d += `movw r1,#${colours & 0xffff};movt r1,#${colours >>> 16};ldrb r0,[r1,r0];str r0,[sp,#52];cmp r0,#0;beq lines;`;
  }
  // Canvas size: width +0x18, height +0x1A of the drawing surface (the context itself, as in the
  // native fill); a missing height is width * 2 / 3.
  d += 'ldrh r8,[r5,#0x18];ldrh r9,[r5,#0x1a];cmp r8,#0;beq lines;';
  d += `cmp r9,#0;bne sized;mov r0,r8;mov r1,#2;mov r2,#3;bl #${scale};mov r9,r0;sized:`;
  // r10 = height of the ratio, r11 = its width, r6 = top band, ip-free: left band computed below.
  d += `mov r0,r9;ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};mov r10,r0;`;
  d += `mov r0,r8;ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};mov r11,r0;`;
  d += 'sub r6,r9,r10;mov r6,r6,lsr #1;';
  // top, bottom (full width)
  d += 'mov r0,#0;mov r1,#0;mov r2,r8;mov r3,r6;' + band(1, colour);
  d += 'mov r0,#0;add r1,r6,r10;mov r2,r8;sub r3,r9,r1;' + band(2, colour);
  // left, right (between the bands)
  d += 'sub r7,r8,r11;mov r7,r7,lsr #1;';
  d += 'mov r0,#0;mov r1,r6;mov r2,r7;mov r3,r10;' + band(3, colour);
  d += 'add r0,r7,r11;mov r1,r6;sub r2,r8,r0;mov r3,r10;' + band(4, colour);
  // Grid lines only when the grid is on; the view is kept visible for the shade alone otherwise.
  // Then its line views (the diagonals, its children) keep the visibility of the last layout:
  // the camera does not lay the grid out when it hides it. So they are hidden while the base Draw
  // draws the children, and their flags are put back.
  d += `lines:ldrb r0,[r4,#${MARK}];tst r0,#2;bne fit;mov r0,#0;`;
  d += `ldr r6,[r4,#${LINE_VIEWS[0]}];cmp r6,#0;ldrbne r8,[r6,#${VISIBLE}];strbne r0,[r6,#${VISIBLE}];`;
  d += `ldr r7,[r4,#${LINE_VIEWS[1]}];cmp r7,#0;ldrbne r9,[r7,#${VISIBLE}];strbne r0,[r7,#${VISIBLE}];`;
  d += `mov r0,r4;mov r1,r5;bl #${VIEW_BASE_DRAW};`;
  d += `cmp r6,#0;strbne r8,[r6,#${VISIBLE}];cmp r7,#0;strbne r9,[r7,#${VISIBLE}];b done;`;
  // The lines in the window: save the frame, narrow it as the bands (r8 = width, r9 = height,
  // centred), run the native Draw, then put the frame back, and its copy at +0x44 if the base
  // Draw made one.
  d += 'fit:';
  for (let k = 0; k < 16; k += 4) d += `ldr r0,[r4,#${FRAME + k}];str r0,[sp,#${32 + k}];`;
  d += 'ldr r7,[sp,#48];';
  d += `ldr r0,[sp,#40];ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};mov r8,r0;`;
  d += `ldr r0,[sp,#44];ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};mov r9,r0;`;
  d += `ldr r0,[sp,#40];sub r0,r0,r8;ldr r1,[sp,#32];add r0,r1,r0,lsr #1;str r0,[r4,#${FRAME}];`;
  d += `ldr r0,[sp,#44];sub r0,r0,r9;ldr r1,[sp,#36];add r0,r1,r0,lsr #1;str r0,[r4,#${FRAME + 4}];`;
  d += `str r8,[r4,#${FRAME + 8}];str r9,[r4,#${FRAME + 12}];`;
  d += `mov r0,r4;mov r1,r5;bl #${GRID_DRAW};`;
  d += `ldrb r6,[r4,#${VISIBLE}];cmp r6,#0;`;
  for (let k = 0; k < 16; k += 4) d += `ldr r0,[sp,#${32 + k}];str r0,[r4,#${FRAME + k}];strne r0,[r4,#${DRAWN + k}];`;
  d += 'b done;';
  d += `native:mov r0,r4;mov r1,r5;bl #${GRID_DRAW};done:add sp,sp,#56;pop {r3-r11,pc};`;
  const draw = p.emit(d);
  p.patch.setWord(GRID_DRAW_SLOT, draw, 'grid view Draw: live-view shade of an added ratio');

  // Diagonals: (line view r0, p1 r1, p2 r2, thickness r3), points {x, y} at a corner of (0,0)-(w,h).
  // With an added ratio, each coordinate 0 becomes the window's near edge, any other its far one.
  // Stack: [sp..+15] x0, x1, y0, y1, then the caller's r0-r8, lr.
  let q = 'push {r0-r8,lr};sub sp,sp,#16;';
  q += `bl #${selected};movs r7,r0;beq call;ldr r4,[sp,#20];ldr r5,[sp,#24];`;
  q += `ldr r6,[r4];ldr r0,[r5];cmp r6,r0;movlo r6,r0;mov r0,r6;ldr r1,[r7];ldr r2,[r7,#4];bl #${scale};`;
  q += 'sub r1,r6,r0;mov r1,r1,lsr #1;str r1,[sp];add r1,r1,r0;str r1,[sp,#4];';
  q += `ldr r6,[r4,#4];ldr r0,[r5,#4];cmp r6,r0;movlo r6,r0;mov r0,r6;ldr r1,[r7,#8];ldr r2,[r7,#12];bl #${scale};`;
  q += 'sub r1,r6,r0;mov r1,r1,lsr #1;str r1,[sp,#8];add r1,r1,r0;str r1,[sp,#12];';
  for (const pt of ['r4', 'r5']) {
    q += `ldr r0,[${pt}];cmp r0,#0;ldreq r0,[sp];ldrne r0,[sp,#4];str r0,[${pt}];`;
    q += `ldr r0,[${pt},#4];cmp r0,#0;ldreq r0,[sp,#8];ldrne r0,[sp,#12];str r0,[${pt},#4];`;
  }
  q += `call:add sp,sp,#16;pop {r0-r8,lr};b #${LINE_SET_POINTS};`;
  const points = p.emit(q);
  for (const call of DIAGONAL_CALLS) p.patch.setWord(call, assembleWords(`bl #${points}`, call)[0], 'grid view layout: diagonals in the window');
}
