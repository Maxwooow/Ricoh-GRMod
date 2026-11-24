// SPDX-License-Identifier: GPL-2.0-only
/**
 * What the camera should draw for framing guides (core/src/fw/gr4v120/aspect/framing.ts), for check.py. NOT part of
 * the program.
 *
 *   npx vite-node tools/gr4v120/framing/expect.ts GUIDES.json > EXPECT.json
 *
 * GUIDES.json: FramingGuides, or build options with `framing`. Prints, per preset, whether it is a value of its own,
 * the rectangles `framingRects` gives for the frames check.py uses (the same list as the app's preview), the
 * diagonals; and the palette as ARGB words.
 */
import { readFileSync } from 'node:fs';
import { argbOf, compilePreset, framingRects, framingValues } from '../../../core/src/fw/gr4v120/aspect/framing';
import type { FramingGuides } from '../../../core/src/fw/gr4v120/aspect/framing';
import { GRID_SELECT } from '../../../core/src/fw/gr4v120/aspect/viewmenu';

const FRAMES: [number, number, number, number][] = [
  [0, 0, 720, 480], [0, 120, 720, 240], [60, 0, 600, 480], [8, 6, 704, 468], [0, 108, 720, 264],
  [120, 0, 480, 480], [40, 0, 640, 480], [0, 38, 720, 404],
];
const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const g: FramingGuides = raw.framing ?? raw;
const values = framingValues(g);
console.log(JSON.stringify({
  select: [GRID_SELECT.byte, GRID_SELECT.bit],
  palette: g.palette.map(argbOf),
  presets: g.presets.map((p, i) => {
    const c = compilePreset(p);
    return {
      own: values.includes(i === 0 ? 'custom3' : 'custom4'),
      frames: FRAMES.map(([x, y, w, h]) => ({ frame: [x, y, w, h], rects: framingRects(c, { x, y, w, h }).map((r) => [r.x, r.y, r.w, r.h, 0xe0 + r.colour]) })),
      diagonals: c.diagonals.map((d) => (d ? { colour: 0xe0 + d.colour, width: d.width } : null)),
    };
  }),
}));
