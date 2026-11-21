// SPDX-License-Identifier: GPL-2.0-only
/**
 * Custom grid lines (GR IV, firmware 1.20 / 1.21; ported from 1.11): which lines the camera's "3x3 Grid" and "4x4 Grid"
 * styles draw, each line on or off. The 3x3 style can also have the two centre lines and the two
 * diagonals, which the camera only draws in the 4x4 style.
 *
 * GridView::Draw (0x5359bb14) takes the style from +0xF4 of the view (0: 3x3, 3 divisions and 2
 * lines; else 4x4, 4 and 3). It builds one line rectangle at fp-0x40 (0x5359bbe4), draws the
 * horizontal lines across the view's frame (+0x30) in the loop 0x5359bbf0..0x5359BC18 (each at
 * top + k * height / divisions - 1, drawn with 0x5359b814 in the colour byte +0xF5, a UI palette
 * number, 16 from UpdateViewGrid), then the vertical ones from 0x5359bc1c; 0x5359BC78 frees the
 * rectangle and draws the base view. The 4x4 style's diagonals are two line views of the grid view
 * (+0xEC, +0xF0), laid out by its layout (0x5359b944) corner to corner of its bounds (+0x20): from
 * 0x5359B9C4 it reads the style, and for 4x4 sets their points (0x5359191C: line view, p1, p2,
 * thickness, at 0x5359ba3c and 0x5359BA7C), their colour (0x53591A74) and shows them; for 3x3 it
 * hides them. 0x5359b9ec is its end.
 */
import { FirmwareError } from '../../types';
import { adr } from '../target';
import { branchTarget } from './arm';
import type { Patch } from './build';
import { BASE, OFFICIAL_RTOS_LENGTH, Program } from './build';

const GRID_HORIZONTAL = adr(0x5359bbe8);
const GRID_STYLE = 0xf4;
/** Frame getters: width / height (size + 8), and the line drawer. */
const FRAME_WIDTH = adr(0x539117ec);
const FRAME_HEIGHT = adr(0x539117fc);
const DRAW_LINE = adr(0x5359b814);
/** GridView::Draw after the lines: frees the line rectangle, then the base view Draw. */
const GRID_LINES_DONE = adr(0x5359bc78);
/** Unsigned r0 / r1, as GridView::Draw divides the frame. */
const UDIV = adr(0x53154a70);
/** The line colour byte (a UI palette number). */
const GRID_COLOUR = 0xf5;
/** GridView layout (0x5359b944): where it reads the style for the diagonals, and its exit. */
const LAYOUT = adr(0x5359b944);
const LAYOUT_DIAGONALS = adr(0x5359b9c4);
const LAYOUT_DONE = adr(0x5359b9ec);
/**
 * A byte of the grid view (inside its 0xF8 bytes, which the camera never uses; the live-view
 * shade's constructor patch clears it) where the layout notes whether it laid out the custom lines
 * (0x81) or the camera's (0x80), when they are chosen in the camera (`GridSelect`).
 */
const GRID_LAID_OUT = 0xf7;
/** The two diagonal line views of the grid view. */
const DIAGONAL_VIEWS = [0xec, 0xf0] as const;
/** The layout's calls of the line views' point setter, one per diagonal. */
const DIAGONAL_CALLS = [adr(0x5359ba3c), adr(0x5359ba7c)] as const;
/** LineView: set the two points (child, p1, p2, thickness) and the colour (child, palette number). */
const LINE_SET_POINTS = adr(0x5359191c);
const LINE_SET_COLOUR = adr(0x53591a74);
const SET_VISIBLE = adr(0x535acd84);

/**
 * The lines of one grid style, on or off, in this order: horizontal top, centre, bottom; vertical
 * left, centre, right; the diagonal from the top left, the one from the bottom left. For the 3x3
 * style top / bottom / left / right are the thirds and the centre lines are added ones; for the
 * 4x4 style they are the quarters and the centre lines its middle ones.
 */
export type GridLines = readonly boolean[];
/** What the camera's 3x3 and 4x4 grid styles draw (`BuildOptions.customGrid`). */
export interface CustomGrid { g3: GridLines; g4: GridLines }
export const GRID_LINE_COUNT = 8;
/** The camera's own grids: 3x3 = the thirds, 4x4 = the quarters, its centre lines and both diagonals. */
export const CAMERA_GRID: CustomGrid = {
  g3: [true, false, true, true, false, true, false, false],
  g4: [true, true, true, true, true, true, true, true],
};
/** Where each straight line is: [vertical?, k, divisions] = k * (length / divisions) - 1 from the frame's edge. */
const STRAIGHT: Readonly<Record<'g3' | 'g4', readonly (readonly [boolean, number, number])[]>> = {
  g3: [[false, 1, 3], [false, 1, 2], [false, 2, 3], [true, 1, 3], [true, 1, 2], [true, 2, 3]],
  g4: [[false, 1, 4], [false, 2, 4], [false, 3, 4], [true, 1, 4], [true, 2, 4], [true, 3, 4]],
};

/**
 * GR IV 1.20 / 1.21 (`viewmenu.ts`): the custom styles are values of their own in the camera's Grid
 * Style list, next to the camera's 3x3 and 4x4. Bit `bit` of `byte` set: the style the camera has
 * (3x3 or 4x4) draws the custom lines; clear: the camera's own. A style whose custom lines are the
 * camera's (no value of its own) always draws the camera's.
 */
export interface GridSelect { byte: number; bit: number }

export function validCustomGrid(g: unknown): g is CustomGrid {
  const ok = (x: unknown): boolean => Array.isArray(x) && x.length === GRID_LINE_COUNT && x.every((v) => typeof v === 'boolean');
  return typeof g === 'object' && g !== null && ok((g as CustomGrid).g3) && ok((g as CustomGrid).g4);
}

export function isCameraGrid(g: CustomGrid): boolean {
  return (['g3', 'g4'] as const).every((s) => g[s].every((v, i) => v === CAMERA_GRID[s][i]));
}

/** One style's lines as a byte, line i in bit i (the build record). */
export const gridByte = (lines: GridLines): number => lines.reduce((b, on, i) => (on ? b | (1 << i) : b), 0);
export const gridLinesOf = (byte: number): boolean[] => Array.from({ length: GRID_LINE_COUNT }, (_, i) => ((byte >> i) & 1) === 1);

/**
 * Install custom grid lines.
 *
 *  - Straight lines: the hook at 0x5359BBE8 (after GridView::Draw has built its line rectangle at
 *    fp-0x40 and read the frame's left fp-0x50 and top fp-0x54) draws the style's lines that are on
 *    itself, with the camera's line drawer and colour, each at the native place (k * (length /
 *    divisions) - 1 from the frame's edge, 2 pixels wide, across the frame). Then 0x5359BC78 as
 *    native.
 *  - Diagonals: the hook at 0x5359B9C4 in the layout (after both line views got the whole bounds,
 *    r7 = width, r8 = height) sets each diagonal that is on with the point setter the layout itself
 *    calls (the line view's own, or a replacement installed before, such as the live-view shade's,
 *    which keeps the diagonals in an added ratio's photo area), gives it the grid's colour and shows
 *    it; the others are hidden. Then 0x5359b9ec as native.
 */
export function installCustomGrid(patch: Patch, grid: CustomGrid, select?: GridSelect): void {
  if (!validCustomGrid(grid)) throw new FirmwareError('internal', 'bad custom grid');
  if (select && !(select.bit > 0 && select.bit < 256 && (select.bit & (select.bit - 1)) === 0)) throw new FirmwareError('internal', 'bad custom grid selection');
  const p = new Program(patch);
  p.expect(GRID_HORIZONTAL, 'add r3,r7,sl', 'grid view Draw: the horizontal lines have moved');
  p.expect(GRID_HORIZONTAL - 4, `bl #${adr(0x539115b4)}`, 'grid view Draw: the line rectangle has moved');
  p.expect(GRID_LINES_DONE, 'sub r0,fp,#0x40', 'grid view Draw: the end of the lines has moved');
  p.expect(LAYOUT_DIAGONALS, `ldrb r5,[r4,#${GRID_STYLE}]`, 'grid view layout: the diagonals have moved');
  p.expect(LAYOUT_DONE, 'sub r0,fp,#0x38', 'grid view layout: its end has moved');
  if (select) p.expect(LAYOUT, 'mov ip,sp', 'grid view layout has moved');
  p.expect(adr(0x5359ba48), `bl #${LINE_SET_COLOUR}`, 'grid view layout: the diagonal colour has moved');
  // The point setter as the layout calls it now: the line view's own, or what an addition installed
  // before put there (code appended to the image). Both calls must be unconditional BLs to it.
  const words = DIAGONAL_CALLS.map((call) => patch.word(call));
  if (words.some((w) => (w & 0xff000000) >>> 0 !== 0xeb000000)) throw new FirmwareError('unexpected-layout', 'grid view layout: the diagonals have moved');
  const [setPoints, other] = DIAGONAL_CALLS.map((call, i) => branchTarget(call, words[i]));
  if (setPoints !== other || (setPoints !== LINE_SET_POINTS && setPoints < BASE + OFFICIAL_RTOS_LENGTH)) throw new FirmwareError('unexpected-layout', 'grid view layout: the diagonals have moved');

  // Straight lines. r4 = view, r5 = context; r9 = width, sl = height. r6-r10 are free from here:
  // 0x5359BC78 uses r4, r5 and the frame only.
  const times = (k: number): string => (k === 1 ? '' : `mov r1,#${k};mul r0,r1,r0;`);
  const straight = (style: 'g3' | 'g4'): string => {
    let s = '';
    STRAIGHT[style].forEach(([vertical, k, n], i) => {
      if (!grid[style][i]) return;
      if (!vertical) {
        s += `mov r0,sl;mov r1,#${n};bl #${UDIV};${times(k)}ldr r1,[fp,#-0x54];add r0,r1,r0;sub r0,r0,#1;str r0,[fp,#-0x3c];`;
        s += 'ldr r0,[fp,#-0x50];str r0,[fp,#-0x40];str r9,[fp,#-0x38];mov r0,#2;str r0,[fp,#-0x34];';
      } else {
        s += `mov r0,r9;mov r1,#${n};bl #${UDIV};${times(k)}ldr r1,[fp,#-0x50];add r0,r1,r0;sub r0,r0,#1;str r0,[fp,#-0x40];`;
        s += 'ldr r0,[fp,#-0x54];str r0,[fp,#-0x3c];mov r0,#2;str r0,[fp,#-0x38];str sl,[fp,#-0x34];';
      }
      s += `mov r0,r4;mov r1,r5;sub r2,fp,#0x40;bl #${DRAW_LINE};`;
    });
    return s;
  };
  // With the custom styles chosen in the camera: r0 = 1 when the view (r0) draws custom lines. Uses r0, r1.
  const differs = (style: 'g3' | 'g4'): boolean => grid[style].some((v, i) => v !== CAMERA_GRID[style][i]);
  const active = select ? p.emit(
    `ldrb r1,[r0,#${GRID_STYLE}];movw r0,#${select.byte & 0xffff};movt r0,#${select.byte >>> 16};ldrb r0,[r0];ands r0,r0,#${select.bit};bxeq lr;` +
    `cmp r1,#0;mov r0,#${differs('g3') ? 1 : 0};movne r0,#${differs('g4') ? 1 : 0};bx lr;`) : 0;
  // The flag changes without the camera laying the view out again (the style may stay the same):
  // when the lines the layout set are not the ones chosen, the view is laid out first. r0-r3 and
  // ip are free at the hook (the displaced instruction sets r3).
  const choose = select
    ? `mov r0,r4;bl #${active};ldrb r3,[r4,#${GRID_LAID_OUT}];orr r1,r0,#0x80;cmp r3,r1;beq go;mov r0,r4;bl #${LAYOUT};mov r0,r4;bl #${active};` +
      `go:cmp r0,#0;bne custom;add r3,r7,sl;b #${GRID_HORIZONTAL + 4};custom:`
    : '';
  p.hook(GRID_HORIZONTAL, choose +
    `ldr r0,[fp,#-0x48];bl #${FRAME_WIDTH};mov r9,r0;ldr r0,[fp,#-0x48];bl #${FRAME_HEIGHT};mov sl,r0;` +
    `ldrb r0,[r4,#${GRID_STYLE}];cmp r0,#0;bne g4;` + straight('g3') + 'b done;' +
    'g4:' + straight('g4') +
    `done:b #${GRID_LINES_DONE};`);

  // Diagonals. r4 = view, r7 = width, r8 = height; r6 holds the stack guard's address and stays.
  const diagonals = (style: 'g3' | 'g4'): string => {
    let s = '';
    DIAGONAL_VIEWS.forEach((view, d) => {
      if (!grid[style][6 + d]) {
        s += `ldr r0,[r4,#${view}];mov r1,#0;bl #${SET_VISIBLE};`;
        return;
      }
      // Points (x, y) on the stack: from the top left (0,0)-(w,h), from the bottom left (0,h)-(w,0).
      s += 'sub sp,sp,#16;mov r0,#0;str r0,[sp];' + (d === 0 ? 'str r0,[sp,#4];str r7,[sp,#8];str r8,[sp,#12];' : 'str r8,[sp,#4];str r7,[sp,#8];str r0,[sp,#12];');
      s += `ldr r0,[r4,#${view}];mov r1,sp;add r2,sp,#8;mov r3,#2;bl #${setPoints};add sp,sp,#16;`;
      s += `ldr r0,[r4,#${view}];ldrb r1,[r4,#${GRID_COLOUR}];bl #${LINE_SET_COLOUR};`;
      s += `ldr r0,[r4,#${view}];mov r1,#1;bl #${SET_VISIBLE};`;
    });
    return s;
  };
  const layoutChoose = select
    ? `mov r0,r4;bl #${active};orr r1,r0,#0x80;strb r1,[r4,#${GRID_LAID_OUT}];cmp r0,#0;bne custom;ldrb r5,[r4,#${GRID_STYLE}];b #${LAYOUT_DIAGONALS + 4};custom:`
    : '';
  p.hook(LAYOUT_DIAGONALS, layoutChoose +
    `ldrb r0,[r4,#${GRID_STYLE}];cmp r0,#0;bne g4;` + diagonals('g3') + `b #${LAYOUT_DONE};` +
    'g4:' + diagonals('g4') + `b #${LAYOUT_DONE};`);
}
