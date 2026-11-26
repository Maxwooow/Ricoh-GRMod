// SPDX-License-Identifier: GPL-2.0-only
/**
 * Custom grid lines for GR III 2.10 / IIIx 1.60 (as GR IV's, ../aspect/grid.ts): which lines the
 * camera's "3x3 Grid" and "4x4 Grid" styles draw, each line on or off, chosen when the firmware is
 * built. The 3x3 style can also have the two centre lines and the two diagonals.
 *
 * GridView is the same class in both cameras: GR III's Draw (0x5339C3B0) and layout (0x5339C1E0)
 * are GR IV 1.20's 0x5359BB14 and 0x5359B944 instruction for instruction, apart from the call
 * targets and the stack guard's address (tools/gr3extras/grid_check.py compares them and the hooks).
 * So the hooks are GR IV's, with GR III's addresses:
 *
 *  - Draw takes the style from +0xF4 of the view (0: 3x3; else 4x4), builds one line rectangle at
 *    fp-0x40 (0x5339C480), draws the horizontal lines across the view's frame in the loop
 *    0x5339C48C..0x5339C4B4 with the line drawer 0x5339C0B0 in the colour byte +0xF5, then the
 *    vertical ones; 0x5339C514 frees the rectangle and draws the base view. The hook at 0x5339C484
 *    draws the lines that are on itself, each at the native place (k * (length / divisions) - 1
 *    from the frame's edge, 2 pixels wide), and continues at 0x5339C514.
 *  - The 4x4 style's diagonals are two line views of the grid view (+0xEC, +0xF0), set corner to
 *    corner by its layout: from 0x5339C260 it reads the style and for 4x4 sets their points
 *    (0x53392384 at 0x5339C2D8 and 0x5339C318), their colour (0x533924DC) and shows them
 *    (0x533AD3C0); for 3x3 it hides them. 0x5339C288 is its end. The hook at 0x5339C260 does this
 *    for the diagonals that are on, for either style.
 */
import { branchWord } from '../aspect/arm';
import { CAMERA_GRID, validCustomGrid } from '../aspect/grid';
import type { CustomGrid } from '../aspect/grid';
import { FirmwareError } from '../types';
import { adr } from './target';

const GRID_HORIZONTAL = adr(0x5339c484);
const GRID_RECTANGLE_CALL = adr(0x5339c480);
const GRID_RECTANGLE = adr(0x536b55a4);
const GRID_STYLE = 0xf4;
const GRID_COLOUR = 0xf5;
const FRAME_WIDTH = adr(0x536b57dc);
const FRAME_HEIGHT = adr(0x536b57ec);
const DRAW_LINE = adr(0x5339c0b0);
const GRID_LINES_DONE = adr(0x5339c514);
const UDIV = adr(0x5313d850);
const LAYOUT_DIAGONALS = adr(0x5339c260);
const LAYOUT_DONE = adr(0x5339c288);
const DIAGONAL_VIEWS = [0xec, 0xf0] as const;
const DIAGONAL_CALLS = [adr(0x5339c2d8), adr(0x5339c318)] as const;
const DIAGONAL_COLOUR_CALL = adr(0x5339c2e4);
const LINE_SET_POINTS = adr(0x53392384);
const LINE_SET_COLOUR = adr(0x533924dc);
const SET_VISIBLE = adr(0x533ad3c0);

/** Where each straight line is: [vertical?, k, divisions] = k * (length / divisions) - 1 from the frame's edge. */
const STRAIGHT: Readonly<Record<'g3' | 'g4', readonly (readonly [boolean, number, number])[]>> = {
  g3: [[false, 1, 3], [false, 1, 2], [false, 2, 3], [true, 1, 3], [true, 1, 2], [true, 2, 3]],
  g4: [[false, 1, 4], [false, 2, 4], [false, 3, 4], [true, 1, 4], [true, 2, 4], [true, 3, 4]],
};

export interface Gr3xGridProgram {
  code(source: string): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}

export { CAMERA_GRID as GR3X_CAMERA_GRID };

/** Install the custom lines (the camera's own lines for both styles: nothing to install, the caller leaves it out). */
export function installGr3xCustomGrid(p: Gr3xGridProgram, grid: CustomGrid): Record<string, number> {
  if (!validCustomGrid(grid)) throw new FirmwareError('internal', 'bad custom grid');
  const bad = (what: string): never => { throw new FirmwareError('unexpected-layout', `IIIx grid view: ${what}`); };
  if (p.word(GRID_RECTANGLE_CALL) !== branchWord(GRID_RECTANGLE_CALL, GRID_RECTANGLE, 14, true)) bad('the line rectangle has moved');
  if (p.word(GRID_LINES_DONE) !== 0xe24b0040) bad('the end of the lines has moved'); // sub r0,fp,#0x40
  if (p.word(LAYOUT_DONE) !== 0xe24b0038) bad('the layout\'s end has moved'); // sub r0,fp,#0x38
  if (p.word(DIAGONAL_COLOUR_CALL) !== branchWord(DIAGONAL_COLOUR_CALL, LINE_SET_COLOUR, 14, true)) bad('the diagonal colour has moved');
  for (const call of DIAGONAL_CALLS) if (p.word(call) !== branchWord(call, LINE_SET_POINTS, 14, true)) bad('the diagonals have moved');

  // Straight lines. r4 = view, r5 = context; r9 = width, sl = height. r6-r10 are free from here:
  // 0x5339C514 uses r4, r5 and the frame only.
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
  const lines = p.code(
    `ldr r0,[fp,#-0x48];bl #${FRAME_WIDTH};mov r9,r0;ldr r0,[fp,#-0x48];bl #${FRAME_HEIGHT};mov sl,r0;` +
    `ldrb r0,[r4,#${GRID_STYLE}];cmp r0,#0;bne g4;` + straight('g3') + 'b done;' +
    'g4:' + straight('g4') +
    `done:b #${GRID_LINES_DONE};`);
  p.patch(GRID_HORIZONTAL, 0xe087300a /* add r3,r7,sl */, branchWord(GRID_HORIZONTAL, lines), 'custom grid lines: the straight lines of the 3x3 and 4x4 styles');

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
      s += `ldr r0,[r4,#${view}];mov r1,sp;add r2,sp,#8;mov r3,#2;bl #${LINE_SET_POINTS};add sp,sp,#16;`;
      s += `ldr r0,[r4,#${view}];ldrb r1,[r4,#${GRID_COLOUR}];bl #${LINE_SET_COLOUR};`;
      s += `ldr r0,[r4,#${view}];mov r1,#1;bl #${SET_VISIBLE};`;
    });
    return s;
  };
  const layout = p.code(
    `ldrb r0,[r4,#${GRID_STYLE}];cmp r0,#0;bne g4;` + diagonals('g3') + `b #${LAYOUT_DONE};` +
    'g4:' + diagonals('g4') + `b #${LAYOUT_DONE};`);
  p.patch(LAYOUT_DIAGONALS, 0xe5d450f4 /* ldrb r5,[r4,#0xf4] */, branchWord(LAYOUT_DIAGONALS, layout), 'custom grid lines: the diagonals of the 3x3 and 4x4 styles');
  return { gridLines: lines, gridLayout: layout };
}
