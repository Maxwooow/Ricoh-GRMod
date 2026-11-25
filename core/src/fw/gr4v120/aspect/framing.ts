// SPDX-License-Identifier: GPL-2.0-only
/**
 * Framing guides (GR IV, firmware 1.20 / 1.21): what the camera's grid view draws, as a list of elements per preset,
 * in colours of a palette of the user's own. Two presets, each a value of its own in the camera's Grid Style list
 * ("Custom Grid 1" in the place of the camera's 3x3, "Custom Grid 2" in the place of its 4x4: `viewmenu.ts`); a
 * preset that draws exactly what the camera's own style draws has no value of its own.
 *
 * Elements (in the spirit of the frame lines of cinema cameras: ARRI's Frame Line Tool, RED's guides):
 *   frame      up to seven frames A..G (frame lines, safe areas), each in the picture or in an earlier frame: a
 *              ratio fitted into it, or it inset by the same width on all four sides (percent of its shorter side);
 *              scaled, moved; drawn as a box, as corners or dashed; optionally the picture outside it darkened
 *   grid       n x m equal parts of the picture or of a frame
 *   golden     the golden section (0.382 / 0.618) of the picture or of a frame
 *   line       one horizontal or vertical line anywhere in the picture or in a frame
 *   centre     a cross or a dot at the centre of the picture or of a frame
 *   diagonals  the picture's two diagonals (the camera's 4x4 has them), each on or off
 *
 * How the camera draws it. GridView::Draw (0x5359bb14) fills rectangles with the line drawer (0x5359b814: the view,
 * the drawing context, a rectangle {x, y, w, h}; it clips to the view and fills in the UI palette colour of byte
 * +0xF5 of the view, through the 32-bit fill whose palette lookup GR Mod reads from a copy with room for more
 * colours, `viewmenu.ts`). The hook at 0x5359BBE8 (where `grid.ts` hooks the camera's lines) interprets a list
 * written here for the preset:
 *
 *   u8 boxes, u8 records, u16 0
 *   boxes   x 12 bytes: u16 num, u16 den, u16 scale (x / 32768), u16 x offset + 32768, u16 y offset + 32768,
 *                       u16 parent (the box it is fitted into: 0 or an earlier box)
 *   records x 20 bytes: four edges (left, top, right, bottom), each {u8 box, u8 pixels + 128, u16 fraction (x / 32768)};
 *                       u8 colour (UI palette number), 3 bytes 0
 *
 * Box 0 is the grid view's frame (the picture: the camera fits it to the live picture, and the live-view shade of
 * the added ratios to the photo's window). Box k (1..7) is frame k, in its parent (box 0 or an earlier box): the
 * ratio num : den fitted into the parent (its full height if the parent is wider, else its full width), scaled,
 * centred and moved by the offsets (fractions of the parent's width and height); with num 0, the parent inset by
 * m = (shorter side x (32768 - scale) + 32768) >> 16 on every side, moved the same way.
 * An edge is box.pos + (box.size * fraction + 16384) >> 15 + pixels, along x for the left and right edges, along
 * y for the top and bottom ones; a record whose right edge is not right of its left
 * edge, or whose bottom is not below its top, is not drawn. So lines keep their width in pixels on any picture,
 * and everything follows the picture's shape: a frame is fitted to the picture the camera shows (3:2, its
 * own 1:1, 4:3, 16:9, an added ratio's window).
 *
 * The diagonals are the grid view's two line views (+0xEC, +0xF0), laid out by its layout (0x5359b944) from
 * corner to corner, as `grid.ts` does; here each has its own colour and thickness.
 *
 * `framingRects` computes the same rectangles in the same integer arithmetic (the app's preview, the checks).
 */
import { FirmwareError } from '../../types';
import { adr } from '../target';
import { branchTarget, movImmediate, movWord } from './arm';
import type { Patch } from './build';
import { BASE, OFFICIAL_RTOS_LENGTH, Program, concat, u16le } from './build';
import type { GridSelect } from './grid';

// ---------------------------------------------------------------------------------------------------- the model

/** A colour of the palette, 0..255 each; `a` 255 opaque, 0 invisible. */
export interface FramingColour { r: number; g: number; b: number; a: number }
/** 0: the picture; 1..7: frame A..G (the first, second... frame element of the preset). */
export type FramingBox = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type FramingDash = 'solid' | 'dashed';
export type FramingOutline = 'box' | 'corners' | 'dashed';
/** `colour`: an index into the palette; `width`: pixels of the camera's screen (720 x 480 for the 3:2 picture), 1..8. */
interface Stroke { colour: number; width: number }
export interface FramingLine extends Stroke { kind: 'line'; axis: 'h' | 'v'; /** 0..10000 of the box's height (h) or width (v) */ at: number; box: FramingBox; dash: FramingDash }
export interface FramingGrid extends Stroke { kind: 'grid'; /** parts across, 2..10 */ cols: number; /** parts down, 2..10 */ rows: number; box: FramingBox; dash: FramingDash }
export interface FramingGolden extends Stroke { kind: 'golden'; box: FramingBox; dash: FramingDash }
export interface FramingDiagonals extends Stroke { kind: 'diagonals'; /** top left to bottom right */ down: boolean; /** bottom left to top right */ up: boolean }
export interface FramingCentre extends Stroke { kind: 'centre'; mark: 'cross' | 'dot'; /** pixels, 4..100 */ size: number; box: FramingBox }
/**
 * A frame (frame lines, safe areas): a box in the picture or in an earlier frame (`box`), drawn as an outline;
 * other elements can be laid out in it (its letter, A..G).
 */
export interface FramingFrame extends Stroke {
  kind: 'frame';
  /** The ratio num : den, 1..9999 each (2.39 : 1 is 239 : 100), fitted into its box; absent: its box inset by the same width on all four sides. */
  num?: number; den?: number;
  /** Percent of the largest size that fits in its box (with a ratio), or of its box less the same width on all sides, 1..100. */
  scale: number;
  /** Offset of the centre, percent of its box's width / height, -50..50 (positive: right / down). */
  x: number; y: number;
  /** The picture (0) or an earlier frame. */
  box: FramingBox;
  style: FramingOutline;
  /** Corners: the length of each arm, percent of the frame's shorter side, 5..50. */
  corner: number;
  /** The part of the picture outside the frame darkened in this palette colour; null: not. */
  mask: number | null;
}
export type FramingElement = FramingLine | FramingGrid | FramingGolden | FramingDiagonals | FramingCentre | FramingFrame;
/** A safe area of the records of version 1 and 2 (now a frame without a ratio, or with one). */
interface LegacySafe extends Stroke { kind: 'safe'; percent: number; box: number; style: FramingOutline; num?: number; den?: number }
export interface FramingPreset { elements: FramingElement[] }
export interface FramingGuides { palette: FramingColour[]; presets: [FramingPreset, FramingPreset] }

export const FRAMING_PALETTE_SIZE = 8;
/** Frames of a preset (A..G): each is a box the camera works out whenever it draws the grid. */
export const FRAMING_MAX_FRAMES = 7;
/** Rectangles per preset: each is a fill the camera does whenever it draws the grid. */
export const FRAMING_MAX_RECORDS = 160;
export const FRAMING_MAX_ELEMENTS = 24;
/** The palette's colours are UI palette numbers 0xE0.. (the copy of the palette has 256: `viewmenu.ts`). */
export const FRAMING_PALETTE_FIRST = 0xe0;
/** The camera's grid colour (UI palette 16) as a palette colour. */
export const CAMERA_GRID_COLOUR: FramingColour = { r: 0, g: 0, b: 0, a: 128 };

export const DEFAULT_FRAMING_PALETTE: readonly FramingColour[] = [
  CAMERA_GRID_COLOUR,
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 255, g: 255, b: 255, a: 128 },
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 59, b: 48, a: 255 },
  { r: 255, g: 204, b: 0, a: 255 },
  { r: 52, g: 199, b: 89, a: 255 },
  { r: 90, g: 200, b: 250, a: 255 },
];

/** The camera's own styles as presets: 3x3 (the thirds), 4x4 (the quarters and both diagonals), 2 px, colour 0. */
export const CAMERA_PRESETS: readonly [FramingPreset, FramingPreset] = [
  { elements: [{ kind: 'grid', cols: 3, rows: 3, box: 0, dash: 'solid', colour: 0, width: 2 }] },
  { elements: [{ kind: 'grid', cols: 4, rows: 4, box: 0, dash: 'solid', colour: 0, width: 2 }, { kind: 'diagonals', down: true, up: true, colour: 0, width: 2 }] },
];

export function defaultFramingGuides(): FramingGuides {
  return { palette: DEFAULT_FRAMING_PALETTE.map((c) => ({ ...c })), presets: [clonePreset(CAMERA_PRESETS[0]), clonePreset(CAMERA_PRESETS[1])] };
}

export function clonePreset(p: FramingPreset): FramingPreset {
  return { elements: p.elements.map((e) => ({ ...e })) };
}

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

const int = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const oneOf = <T>(v: unknown, values: readonly T[]): boolean => values.includes(v as T);

/** Why the guides cannot be built, or null when they can. */
export function framingProblem(g: unknown): string | null {
  if (typeof g !== 'object' || g === null) return 'not an object';
  const { palette, presets } = g as FramingGuides;
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > FRAMING_PALETTE_SIZE) return 'palette: 1 to 8 colours';
  for (const c of palette) if (!(typeof c === 'object' && c !== null && int(c.r, 0, 255) && int(c.g, 0, 255) && int(c.b, 0, 255) && int(c.a, 0, 255))) return 'palette: r, g, b, a 0..255';
  if (!Array.isArray(presets) || presets.length !== 2) return 'two presets';
  for (const [i, p] of presets.entries()) {
    if (typeof p !== 'object' || p === null || !Array.isArray(p.elements)) return `preset ${i + 1}: no elements`;
    if (p.elements.length > FRAMING_MAX_ELEMENTS) return `preset ${i + 1}: more than ${FRAMING_MAX_ELEMENTS} elements`;
    const frames = p.elements.filter((e) => e && e.kind === 'frame').length;
    if (frames > FRAMING_MAX_FRAMES) return `preset ${i + 1}: more than ${FRAMING_MAX_FRAMES} frames`;
    if (p.elements.filter((e) => e && e.kind === 'diagonals').length > 1) return `preset ${i + 1}: diagonals twice`;
    let k = 0;
    for (const e of p.elements) {
      const what = `preset ${i + 1}, ${(e as { kind?: string })?.kind ?? 'element'}`;
      if (typeof e !== 'object' || e === null) return `${what}: not an object`;
      if (!int(e.colour, 0, palette.length - 1)) return `${what}: colour`;
      if (!int(e.width, 1, 8)) return `${what}: width 1..8`;
      const box = (b: unknown): boolean => int(b, 0, frames);
      switch (e.kind) {
        case 'line': if (!(oneOf(e.axis, ['h', 'v']) && int(e.at, 0, 10000) && box(e.box) && oneOf(e.dash, ['solid', 'dashed']))) return what; break;
        case 'grid': if (!(int(e.cols, 1, 10) && int(e.rows, 1, 10) && (e.cols > 1 || e.rows > 1) && box(e.box) && oneOf(e.dash, ['solid', 'dashed']))) return what; break;
        case 'golden': if (!(box(e.box) && oneOf(e.dash, ['solid', 'dashed']))) return what; break;
        case 'diagonals': if (!(typeof e.down === 'boolean' && typeof e.up === 'boolean')) return what; break;
        case 'centre': if (!(oneOf(e.mark, ['cross', 'dot']) && int(e.size, 4, 100) && box(e.box))) return what; break;
        case 'frame':
          k += 1;
          if ((e.num !== undefined || e.den !== undefined) && !(int(e.num, 1, 9999) && int(e.den, 1, 9999))) return `${what}: ratio`;
          if (!int(e.box, 0, k - 1)) return `${what}: in the picture or an earlier frame`;
          if (!(int(e.scale, 1, 100) && int(e.x, -50, 50) && int(e.y, -50, 50) && oneOf(e.style, ['box', 'corners', 'dashed']) && int(e.corner, 5, 50))) return what;
          if (!(e.mask === null || int(e.mask, 0, palette.length - 1))) return `${what}: mask colour`;
          break;
        default: return `${what}: unknown kind`;
      }
    }
    const n = compilePreset(p).records.length;
    if (n > FRAMING_MAX_RECORDS) return `preset ${i + 1}: ${n} rectangles, at most ${FRAMING_MAX_RECORDS}`;
  }
  return null;
}

export function validFramingGuides(g: unknown): g is FramingGuides {
  return framingProblem(g) === null;
}

// ---------------------------------------------------------------------------------------------------- compiling

/** The fraction unit of the lists: 32768 = the whole box. */
const ONE = 32768;
/** An edge: box.pos + (box.size * frac + 16384) >> 15 + px. */
export interface Edge { box: number; frac: number; px: number }
/** A rectangle from its four edges, filled in UI palette colour `colour` (an index into the user's palette here). */
export interface FramingRecord { edges: [Edge, Edge, Edge, Edge]; colour: number }
/**
 * A box fitted (num : den, scaled, moved) into box `parent` (0: the picture; a frame line's box). With num 0, the
 * parent inset by the same width on every side: (shorter side x (1 - scale)) / 2.
 */
export interface FramingBoxDef { num: number; den: number; scale: number; ox: number; oy: number; parent: number }
export interface CompiledPreset {
  boxes: FramingBoxDef[];
  records: FramingRecord[];
  /** [top left to bottom right, bottom left to top right]: null when off. */
  diagonals: [{ colour: number; width: number } | null, { colour: number; width: number } | null];
}

const frac = (x: number): number => Math.max(0, Math.min(ONE, Math.round(x * ONE)));
const edge = (box: number, f: number, px = 0): Edge => ({ box, frac: frac(f), px });

/** The 3:2 picture the dashes and corners are laid out for (the camera's screen). */
const NOMINAL = { x: 0, y: 0, w: 720, h: 480 } as const;

/** Box k of a 720 x 480 picture (for the length of corner arms and the count of dashes). */
function nominalBox(boxes: readonly FramingBoxDef[], k: number): { w: number; h: number } {
  if (k === 0) return { w: NOMINAL.w, h: NOMINAL.h };
  const b = evaluateBoxes(boxes, NOMINAL)[k];
  return { w: b.w, h: b.h };
}

/**
 * The records of a preset in drawing order: the frame lines' masks first, then each element in its order.
 * Lines are centred on their place; outlines are drawn inside their rectangle.
 */
export function compilePreset(preset: FramingPreset): CompiledPreset {
  const boxes: FramingBoxDef[] = [];
  // the frames' boxes 1..n, in order (as the elements name them): with a ratio fitted into their box, without it
  // their box inset by the same width on all four sides
  for (const e of preset.elements) {
    if (e.kind !== 'frame') continue;
    const own = e.num !== undefined && e.den !== undefined;
    boxes.push({
      num: own ? e.num! : 0, den: own ? e.den! : 0, scale: Math.round((e.scale / 100) * ONE),
      ox: Math.round((e.x / 100) * ONE), oy: Math.round((e.y / 100) * ONE), parent: e.box,
    });
  }
  const records: FramingRecord[] = [];
  const diagonals: CompiledPreset['diagonals'] = [null, null];
  const rect = (l: Edge, t: Edge, r: Edge, b: Edge, colour: number): void => { records.push({ edges: [l, t, r, b], colour }); };

  // a straight line across a box: horizontal at fraction f of its height (or vertical, of its width), from
  // fraction a to b of the other way, `w` pixels wide centred on its place; dashed: in pieces
  const line = (box: number, vertical: boolean, f: number, a: number, b: number, width: number, colour: number, dashed: boolean): void => {
    const lo = -Math.floor(width / 2);
    const hi = width + lo;
    const size = nominalBox(boxes, box);
    const span = (vertical ? size.h : size.w) * (b - a);
    const pieces = dashed ? Math.max(2, Math.round(span / 32)) : 1;
    for (let k = 0; k < pieces; k++) {
      const p0 = dashed ? a + ((b - a) * (k + 0.2)) / pieces : a;
      const p1 = dashed ? a + ((b - a) * (k + 0.8)) / pieces : b;
      if (vertical) rect(edge(box, f, lo), edge(box, p0), edge(box, f, hi), edge(box, p1), colour);
      else rect(edge(box, p0), edge(box, f, lo), edge(box, p1), edge(box, f, hi), colour);
    }
  };

  // the outline of a rectangle (fractions x0..x1, y0..y1 of a box), `w` pixels inside it
  const outline = (box: number, x0: number, y0: number, x1: number, y1: number, style: FramingOutline, w: number, colour: number, corner = 15): void => {
    if (style === 'corners') {
      const size = nominalBox(boxes, box);
      const arm = (corner / 100) * Math.min(size.w * (x1 - x0), size.h * (y1 - y0));
      const ax = arm / size.w;
      const ay = arm / size.h;
      for (const [cx, sx] of [[x0, 1], [x1, -1]] as const) {
        for (const [cy, sy] of [[y0, 1], [y1, -1]] as const) {
          // the horizontal arm, then the vertical one (without the square they share)
          const hx = sx > 0 ? [edge(box, cx), edge(box, cx + ax)] : [edge(box, cx - ax), edge(box, cx)];
          const hy = sy > 0 ? [edge(box, cy), edge(box, cy, w)] : [edge(box, cy, -w), edge(box, cy)];
          rect(hx[0], hy[0], hx[1], hy[1], colour);
          const vx = sx > 0 ? [edge(box, cx), edge(box, cx, w)] : [edge(box, cx, -w), edge(box, cx)];
          const vy = sy > 0 ? [edge(box, cy, w), edge(box, cy + ay)] : [edge(box, cy - ay), edge(box, cy, -w)];
          rect(vx[0], vy[0], vx[1], vy[1], colour);
        }
      }
      return;
    }
    if (style === 'dashed') {
      const size = nominalBox(boxes, box);
      const sides: [boolean, number, number, number, number][] = [
        [false, y0, x0, x1, 0], [false, y1, x0, x1, -w], [true, x0, y0, y1, 0], [true, x1, y0, y1, -w],
      ];
      for (const [vertical, f, a, b, off] of sides) {
        const span = (vertical ? size.h : size.w) * (b - a);
        const n = Math.max(2, Math.round(span / 32));
        for (let k = 0; k < n; k++) {
          const p0 = a + ((b - a) * (k + 0.2)) / n;
          const p1 = a + ((b - a) * (k + 0.8)) / n;
          if (vertical) rect(edge(box, f, off), edge(box, p0), edge(box, f, off + w), edge(box, p1), colour);
          else rect(edge(box, p0), edge(box, f, off), edge(box, p1), edge(box, f, off + w), colour);
        }
      }
      return;
    }
    rect(edge(box, x0), edge(box, y0), edge(box, x1), edge(box, y0, w), colour);
    rect(edge(box, x0), edge(box, y1, -w), edge(box, x1), edge(box, y1), colour);
    rect(edge(box, x0), edge(box, y0, w), edge(box, x0, w), edge(box, y1, -w), colour);
    rect(edge(box, x1, -w), edge(box, y0, w), edge(box, x1), edge(box, y1, -w), colour);
  };

  // masks: the picture outside each frame line that has one, in four bands
  let k = 0;
  for (const e of preset.elements) {
    if (e.kind !== 'frame') continue;
    k += 1;
    if (e.mask === null) continue;
    rect(edge(0, 0), edge(0, 0), edge(0, 1), edge(k, 0), e.mask);
    rect(edge(0, 0), edge(k, 1), edge(0, 1), edge(0, 1), e.mask);
    rect(edge(0, 0), edge(k, 0), edge(k, 0), edge(k, 1), e.mask);
    rect(edge(k, 1), edge(k, 0), edge(0, 1), edge(k, 1), e.mask);
  }

  k = 0;
  for (const e of preset.elements) {
    switch (e.kind) {
      case 'line':
        line(e.box, e.axis === 'v', e.at / 10000, 0, 1, e.width, e.colour, e.dash === 'dashed');
        break;
      case 'grid':
        for (let i = 1; i < e.rows; i++) line(e.box, false, i / e.rows, 0, 1, e.width, e.colour, e.dash === 'dashed');
        for (let i = 1; i < e.cols; i++) line(e.box, true, i / e.cols, 0, 1, e.width, e.colour, e.dash === 'dashed');
        break;
      case 'golden': {
        const g = (Math.sqrt(5) - 1) / 2; // 0.618
        for (const f of [1 - g, g]) line(e.box, false, f, 0, 1, e.width, e.colour, e.dash === 'dashed');
        for (const f of [1 - g, g]) line(e.box, true, f, 0, 1, e.width, e.colour, e.dash === 'dashed');
        break;
      }
      case 'diagonals':
        if (e.down) diagonals[0] = { colour: e.colour, width: e.width };
        if (e.up) diagonals[1] = { colour: e.colour, width: e.width };
        break;
      case 'centre': {
        const half = Math.floor(e.size / 2);
        const lo = -Math.floor(e.width / 2);
        if (e.mark === 'dot') rect(edge(e.box, 0.5, -half), edge(e.box, 0.5, -half), edge(e.box, 0.5, e.size - half), edge(e.box, 0.5, e.size - half), e.colour);
        else {
          rect(edge(e.box, 0.5, -half), edge(e.box, 0.5, lo), edge(e.box, 0.5, e.size - half), edge(e.box, 0.5, lo + e.width), e.colour);
          rect(edge(e.box, 0.5, lo), edge(e.box, 0.5, -half), edge(e.box, 0.5, lo + e.width), edge(e.box, 0.5, lo), e.colour);
          rect(edge(e.box, 0.5, lo), edge(e.box, 0.5, lo + e.width), edge(e.box, 0.5, lo + e.width), edge(e.box, 0.5, e.size - half), e.colour);
        }
        break;
      }
      case 'frame':
        k += 1;
        outline(k, 0, 0, 1, 1, e.style, e.width, e.colour, e.corner);
        break;
    }
  }
  return { boxes, records, diagonals };
}

// ---------------------------------------------------------------------------------------------------- evaluating

export interface FramingFrameBox { x: number; y: number; w: number; h: number }

/** Boxes 0..n for a picture, in the camera's integer arithmetic (the hook's). */
export function evaluateBoxes(boxes: readonly FramingBoxDef[], frame: FramingFrameBox): FramingFrameBox[] {
  const out: FramingFrameBox[] = [{ ...frame }];
  for (const b of boxes) {
    const into = out[b.parent];
    const W = into.w | 0;
    const H = into.h | 0;
    if (b.num === 0) {
      const m = (Math.min(W, H) * (ONE - b.scale) + ONE) >> 16;
      out.push({ x: into.x + m + ((W * b.ox) >> 15), y: into.y + m + ((H * b.oy) >> 15), w: W - 2 * m, h: H - 2 * m });
      continue;
    }
    let bw: number;
    let bh: number;
    if (W * b.den >= H * b.num) {
      bh = ((H * b.scale + 16384) >>> 15);
      bw = Math.floor((bh * b.num + (b.den >>> 1)) / b.den);
    } else {
      bw = ((W * b.scale + 16384) >>> 15);
      bh = Math.floor((bw * b.den + (b.num >>> 1)) / b.num);
    }
    const x = into.x + ((W * b.ox) >> 15) + ((W - bw) >> 1);
    const y = into.y + ((H * b.oy) >> 15) + ((H - bh) >> 1);
    out.push({ x, y, w: bw, h: bh });
  }
  return out;
}

export interface FramingRect { x: number; y: number; w: number; h: number; colour: number }

/** The rectangles the camera fills for a compiled preset in a picture (frame = the grid view's frame), in order. */
export function framingRects(c: CompiledPreset, frame: FramingFrameBox): FramingRect[] {
  const bx = evaluateBoxes(c.boxes, frame);
  const at = (e: Edge, vertical: boolean): number => {
    const b = bx[e.box];
    return (vertical ? b.y : b.x) + (((vertical ? b.h : b.w) * e.frac + 16384) >>> 15) + e.px;
  };
  // clipped to the picture: a moved or scaled frame line may reach past it (the camera's picture is box 0)
  const pic = bx[0];
  const out: FramingRect[] = [];
  for (const r of c.records) {
    const x0 = Math.max(pic.x, at(r.edges[0], false));
    const y0 = Math.max(pic.y, at(r.edges[1], true));
    const w = Math.min(pic.x + pic.w, at(r.edges[2], false)) - x0;
    const h = Math.min(pic.y + pic.h, at(r.edges[3], true)) - y0;
    if (w > 0 && h > 0) out.push({ x: x0, y: y0, w, h, colour: r.colour });
  }
  return out;
}

/** ARGB word of a palette colour, as the UI palette keeps them. */
export const argbOf = (c: FramingColour): number => ((c.a << 24) | (c.r << 16) | (c.g << 8) | c.b) >>> 0;

/** True when a preset draws exactly what the camera's own style (0: 3x3, 1: 4x4) draws. */
export function isCameraPreset(g: FramingGuides, i: 0 | 1): boolean {
  const camera = compilePreset(CAMERA_PRESETS[i]);
  const mine = compilePreset(g.presets[i]);
  const colourOf = (k: number): number => (k === -1 ? argbOf(CAMERA_GRID_COLOUR) : argbOf(g.palette[k]));
  const plain = (c: CompiledPreset, mapColour: (k: number) => number): string => JSON.stringify({
    b: c.boxes, r: c.records.map((r) => ({ e: r.edges, c: mapColour(r.colour) })),
    d: c.diagonals.map((d) => (d ? { w: d.width, c: mapColour(d.colour) } : null)),
  });
  return plain(mine, colourOf) === plain(camera, () => colourOf(-1));
}

/** The presets that are values of their own in the camera's Grid Style list. */
export function framingValues(g: FramingGuides): ('custom3' | 'custom4')[] {
  return [...(isCameraPreset(g, 0) ? [] : ['custom3' as const]), ...(isCameraPreset(g, 1) ? [] : ['custom4' as const])];
}

// ---------------------------------------------------------------------------------------------------- the camera

const GRID_HORIZONTAL = adr(0x5359bbe8);
const GRID_STYLE = 0xf4;
const GRID_COLOUR = 0xf5;
const FRAME_WIDTH = adr(0x539117ec);
const FRAME_HEIGHT = adr(0x539117fc);
const DRAW_LINE = adr(0x5359b814);
const GRID_LINES_DONE = adr(0x5359bc78);
const UDIV = adr(0x53154a70);
const LAYOUT = adr(0x5359b944);
const LAYOUT_DIAGONALS = adr(0x5359b9c4);
const LAYOUT_DONE = adr(0x5359b9ec);
const GRID_LAID_OUT = 0xf7;
const DIAGONAL_VIEWS = [0xec, 0xf0] as const;
const DIAGONAL_CALLS = [adr(0x5359ba3c), adr(0x5359ba7c)] as const;
const LINE_SET_POINTS = adr(0x5359191c);
const LINE_SET_COLOUR = adr(0x53591a74);
const SET_VISIBLE = adr(0x535acd84);
const PALETTE = adr(0x540781ec);
const PALETTE_LOOKUP = adr(0x539262fc);
const PALETTE_WORDS = 48;
/** The boxes on the stack while drawing: 16 bytes each, the picture and seven more. */
const BOX_AREA = 16 * (FRAMING_MAX_FRAMES + 1);

/** The list of a preset (see the top of this file). Colours become UI palette numbers. */
export function presetList(c: CompiledPreset): Uint8Array {
  if (c.boxes.length > FRAMING_MAX_FRAMES || c.boxes.some((b, i) => b.parent > i) || c.records.length > 255) fail('internal', 'framing guides: too much for one preset');
  const head = Uint8Array.from([c.boxes.length, c.records.length, 0, 0]);
  const boxes = c.boxes.map((b) => u16le([b.num, b.den, b.scale, b.ox + ONE, b.oy + ONE, b.parent]));
  const records = c.records.map((r) => {
    const bytes = new Uint8Array(20);
    r.edges.forEach((e, i) => {
      if (!(e.box >= 0 && e.box <= c.boxes.length && e.px >= -128 && e.px <= 127 && e.frac >= 0 && e.frac <= ONE)) fail('internal', 'framing guides: an edge out of range');
      bytes[i * 4] = e.box;
      bytes[i * 4 + 1] = e.px + 128;
      bytes[i * 4 + 2] = e.frac & 0xff;
      bytes[i * 4 + 3] = e.frac >>> 8;
    });
    bytes[16] = FRAMING_PALETTE_FIRST + r.colour;
    return bytes;
  });
  return concat([head, ...boxes, ...records]);
}

/**
 * The UI palette copy with the guides' colours at 0xE0..: the copy the live-view shade made (`viewmenu.ts`
 * installShadePalette), or one made here when there is none yet.
 */
function installFramingPalette(patch: Patch, palette: readonly FramingColour[]): void {
  const w0 = patch.word(PALETTE_LOOKUP);
  const w1 = patch.word(PALETTE_LOOKUP + 4);
  if ((w0 & 0xfff0f000) >>> 0 !== 0xe3003000 || (w1 & 0xfff0f000) >>> 0 !== 0xe3403000) fail('unexpected-layout', 'UI palette lookup is not a MOVW/MOVT pair');
  if (patch.word(PALETTE_LOOKUP + 8) !== 0xe7930100) fail('unexpected-layout', 'UI palette lookup has changed');
  let copy = (movImmediate(w0) | (movImmediate(w1) << 16)) >>> 0;
  if (copy === PALETTE) {
    if (patch.word(PALETTE + 4) !== 0xff000000 || patch.word(PALETTE + 16 * 4) !== 0x80000000) fail('unexpected-layout', 'UI palette is not where it was expected');
    copy = patch.append(patch.read(PALETTE, 256 * 4), 16);
    patch.setWord(PALETTE_LOOKUP, movWord(3, copy & 0xffff), 'framing guides: UI palette with more colours, low half');
    patch.setWord(PALETTE_LOOKUP + 4, movWord(3, copy >>> 16, true), 'framing guides: UI palette with more colours, high half');
  } else if (copy < BASE + OFFICIAL_RTOS_LENGTH) fail('unexpected-layout', 'UI palette lookup reads an unknown table');
  if (FRAMING_PALETTE_FIRST < PALETTE_WORDS) fail('internal', 'framing colours inside the palette');
  const words = new Uint8Array(palette.length * 4);
  const v = new DataView(words.buffer);
  palette.forEach((c, i) => v.setUint32(i * 4, argbOf(c), true));
  patch.write(copy + FRAMING_PALETTE_FIRST * 4, words);
}

/**
 * Install the framing guides. Same places, checks and choice of what is drawn as `installCustomGrid` (`grid.ts`):
 * with `select`, a preset is drawn only with the bit set and its style chosen; one that is the camera's own style
 * has no value of its own and the camera's lines are drawn. Call after the added ratios (the diagonals take the
 * point setter the layout calls then).
 */
export function installFramingGuides(patch: Patch, guides: FramingGuides, select: GridSelect): void {
  const problem = framingProblem(guides);
  if (problem) fail('internal', `framing guides: ${problem}`);
  if (!(select.bit > 0 && select.bit < 256 && (select.bit & (select.bit - 1)) === 0)) fail('internal', 'bad framing selection');
  const p = new Program(patch);
  p.expect(GRID_HORIZONTAL, 'add r3,r7,sl', 'grid view Draw: the horizontal lines have moved');
  p.expect(GRID_HORIZONTAL - 4, `bl #${adr(0x539115b4)}`, 'grid view Draw: the line rectangle has moved');
  p.expect(GRID_LINES_DONE, 'sub r0,fp,#0x40', 'grid view Draw: the end of the lines has moved');
  p.expect(LAYOUT_DIAGONALS, `ldrb r5,[r4,#${GRID_STYLE}]`, 'grid view layout: the diagonals have moved');
  p.expect(LAYOUT_DONE, 'sub r0,fp,#0x38', 'grid view layout: its end has moved');
  p.expect(LAYOUT, 'mov ip,sp', 'grid view layout has moved');
  p.expect(adr(0x5359ba48), `bl #${LINE_SET_COLOUR}`, 'grid view layout: the diagonal colour has moved');
  const words = DIAGONAL_CALLS.map((call) => patch.word(call));
  if (words.some((w) => (w & 0xff000000) >>> 0 !== 0xeb000000)) fail('unexpected-layout', 'grid view layout: the diagonals have moved');
  const [setPoints, other] = DIAGONAL_CALLS.map((call, i) => branchTarget(call, words[i]));
  if (setPoints !== other || (setPoints !== LINE_SET_POINTS && setPoints < BASE + OFFICIAL_RTOS_LENGTH)) fail('unexpected-layout', 'grid view layout: the diagonals have moved');

  installFramingPalette(patch, guides.palette);
  const compiled = guides.presets.map(compilePreset);
  const own = [!isCameraPreset(guides, 0), !isCameraPreset(guides, 1)];
  if (!own[0] && !own[1]) fail('internal', 'framing guides: both presets are the camera’s');
  const lists = compiled.map((c) => p.blob(presetList(c)));

  // r0 = 1 when the view (r0) draws its preset: the bit set and the style's preset is not the camera's. Uses r0, r1.
  const active = p.emit(
    `ldrb r1,[r0,#${GRID_STYLE}];movw r0,#${select.byte & 0xffff};movt r0,#${select.byte >>> 16};ldrb r0,[r0];ands r0,r0,#${select.bit};bxeq lr;` +
    `cmp r1,#0;mov r0,#${own[0] ? 1 : 0};movne r0,#${own[1] ? 1 : 0};bx lr;`);
  // As grid.ts: the flag changes without the camera laying the view out again; when the layout's mark is not
  // what is chosen now, the view is laid out first. r0-r3 and ip are free at the hook.
  const choose = `mov r0,r4;bl #${active};ldrb r3,[r4,#${GRID_LAID_OUT}];orr r1,r0,#0x80;cmp r3,r1;beq go;mov r0,r4;bl #${LAYOUT};mov r0,r4;bl #${active};` +
    `go:cmp r0,#0;bne custom;add r3,r7,sl;b #${GRID_HORIZONTAL + 4};custom:`;

  // The interpreter. r4 = view, r5 = context; r6 = list, r7 = count, r8 = records left, r9 = box out; the
  // rectangle at fp-0x40 (x, y, w, h); [sp..] the boxes {x, y, w, h}: box 0 the frame; sl = the parent of a box.
  // An edge (record + `off`, along x: pos +0, size +8; along y: +4, +12) into r1.
  const edge = (off: number, y: boolean): string =>
    `ldrb r0,[r6,#${off}];mov r1,sp;add r0,r1,r0,lsl #4;ldr r1,[r0,#${y ? 4 : 0}];ldr r2,[r0,#${y ? 12 : 8}];` +
    `ldrh r3,[r6,#${off + 2}];mul r3,r2,r3;add r3,r3,#16384;add r1,r1,r3,lsr #15;ldrb r3,[r6,#${off + 1}];sub r3,r3,#128;add r1,r1,r3;`;
  let d = choose;
  d += `ldr r0,[fp,#-0x48];bl #${FRAME_WIDTH};mov r9,r0;ldr r0,[fp,#-0x48];bl #${FRAME_HEIGHT};mov sl,r0;`;
  d += `sub sp,sp,#${BOX_AREA};ldr r0,[fp,#-0x50];str r0,[sp];ldr r0,[fp,#-0x54];str r0,[sp,#4];str r9,[sp,#8];str sl,[sp,#12];`;
  d += `ldrb r0,[r4,#${GRID_STYLE}];cmp r0,#0;movw r6,#${lists[0] & 0xffff};movt r6,#${lists[0] >>> 16};movwne r6,#${lists[1] & 0xffff};movtne r6,#${lists[1] >>> 16};`;
  d += 'ldrb r7,[r6];ldrb r8,[r6,#1];add r6,r6,#4;add r9,sp,#16;';
  // boxes: fit num : den into the parent box (sl; UDIV keeps it), scale, centre, move
  d += 'boxes:cmp r7,#0;beq boxed;ldrh r3,[r6,#10];add sl,sp,r3,lsl #4;ldrh r0,[r6];ldrh r1,[r6,#2];ldrh r2,[r6,#4];cmp r0,#0;beq inset;';
  d += 'ldr r3,[sl,#8];mul ip,r3,r1;ldr r3,[sl,#12];mul lr,r3,r0;cmp ip,lr;blt narrow;';
  d += `mul r3,r3,r2;add r3,r3,#16384;mov r3,r3,lsr #15;str r3,[r9,#12];mul r0,r3,r0;add r0,r0,r1,lsr #1;bl #${UDIV};str r0,[r9,#8];b placed;`;
  d += `narrow:ldr r3,[sl,#8];mul r3,r3,r2;add r3,r3,#16384;mov r3,r3,lsr #15;str r3,[r9,#8];mul ip,r3,r1;add ip,ip,r0,lsr #1;mov r1,r0;mov r0,ip;bl #${UDIV};str r0,[r9,#12];`;
  d += 'placed:ldrh r0,[r6,#6];sub r0,r0,#32768;ldr r2,[sl,#8];mul r0,r2,r0;mov r0,r0,asr #15;ldr r1,[r9,#8];sub r1,r2,r1;add r0,r0,r1,asr #1;ldr r1,[sl];add r0,r0,r1;str r0,[r9];';
  d += 'ldrh r0,[r6,#8];sub r0,r0,#32768;ldr r2,[sl,#12];mul r0,r2,r0;mov r0,r0,asr #15;ldr r1,[r9,#12];sub r1,r2,r1;add r0,r0,r1,asr #1;ldr r1,[sl,#4];add r0,r0,r1;str r0,[r9,#4];';
  d += 'b nextbox;';
  // num 0: the parent inset by m = (shorter side x (32768 - scale) + 32768) >> 16 on every side
  d += 'inset:ldr r0,[sl,#8];ldr r1,[sl,#12];cmp r0,r1;movgt r0,r1;rsb r2,r2,#32768;mul r0,r0,r2;add r0,r0,#32768;mov r0,r0,asr #16;';
  d += 'ldr r1,[sl,#8];sub r1,r1,r0,lsl #1;str r1,[r9,#8];ldr r1,[sl,#12];sub r1,r1,r0,lsl #1;str r1,[r9,#12];';
  // moved as a fitted box is: x = left + m + (W x offset) >> 15, y the same way
  d += 'ldrh r1,[r6,#6];sub r1,r1,#32768;ldr r2,[sl,#8];mul r1,r2,r1;add r1,r0,r1,asr #15;ldr r2,[sl];add r1,r1,r2;str r1,[r9];';
  d += 'ldrh r1,[r6,#8];sub r1,r1,#32768;ldr r2,[sl,#12];mul r1,r2,r1;add r1,r0,r1,asr #15;ldr r2,[sl,#4];add r1,r1,r2;str r1,[r9,#4];';
  d += 'nextbox:add r6,r6,#12;add r9,r9,#16;sub r7,r7,#1;b boxes;boxed:';
  // records: four edges, then the fill in the record's colour
  d += `ldrb r7,[r4,#${GRID_COLOUR}];`;
  d += 'recs:cmp r8,#0;beq done;';
  // each edge clipped to the picture (box 0 at [sp]), as framingRects
  d += `${edge(0, false)}ldr r0,[sp];cmp r1,r0;movlt r1,r0;str r1,[fp,#-0x40];`;
  d += `${edge(4, true)}ldr r0,[sp,#4];cmp r1,r0;movlt r1,r0;str r1,[fp,#-0x3c];`;
  d += `${edge(8, false)}ldr r0,[sp];ldr r2,[sp,#8];add r0,r0,r2;cmp r1,r0;movgt r1,r0;ldr r0,[fp,#-0x40];subs r1,r1,r0;ble skip;str r1,[fp,#-0x38];`;
  d += `${edge(12, true)}ldr r0,[sp,#4];ldr r2,[sp,#12];add r0,r0,r2;cmp r1,r0;movgt r1,r0;ldr r0,[fp,#-0x3c];subs r1,r1,r0;ble skip;str r1,[fp,#-0x34];`;
  d += `ldrb r0,[r6,#16];strb r0,[r4,#${GRID_COLOUR}];mov r0,r4;mov r1,r5;sub r2,fp,#0x40;bl #${DRAW_LINE};`;
  d += 'skip:add r6,r6,#20;sub r8,r8,#1;b recs;';
  d += `done:strb r7,[r4,#${GRID_COLOUR}];add sp,sp,#${BOX_AREA};b #${GRID_LINES_DONE};`;
  p.hook(GRID_HORIZONTAL, d);

  // Diagonals: r4 = view, r7 = width, r8 = height of the bounds; r6 holds the stack guard's address and stays.
  const diagonals = (i: 0 | 1): string => {
    let s = '';
    DIAGONAL_VIEWS.forEach((view, k) => {
      const on = compiled[i].diagonals[k];
      if (!on) {
        s += `ldr r0,[r4,#${view}];mov r1,#0;bl #${SET_VISIBLE};`;
        return;
      }
      s += 'sub sp,sp,#16;mov r0,#0;str r0,[sp];' + (k === 0 ? 'str r0,[sp,#4];str r7,[sp,#8];str r8,[sp,#12];' : 'str r8,[sp,#4];str r7,[sp,#8];str r0,[sp,#12];');
      s += `ldr r0,[r4,#${view}];mov r1,sp;add r2,sp,#8;mov r3,#${on.width};bl #${setPoints};add sp,sp,#16;`;
      s += `ldr r0,[r4,#${view}];mov r1,#${FRAMING_PALETTE_FIRST + on.colour};bl #${LINE_SET_COLOUR};`;
      s += `ldr r0,[r4,#${view}];mov r1,#1;bl #${SET_VISIBLE};`;
    });
    return s;
  };
  const layoutChoose = `mov r0,r4;bl #${active};orr r1,r0,#0x80;strb r1,[r4,#${GRID_LAID_OUT}];cmp r0,#0;bne custom;ldrb r5,[r4,#${GRID_STYLE}];b #${LAYOUT_DIAGONALS + 4};custom:`;
  p.hook(LAYOUT_DIAGONALS, layoutChoose +
    `ldrb r0,[r4,#${GRID_STYLE}];cmp r0,#0;bne g4;` + diagonals(0) + `b #${LAYOUT_DONE};` +
    'g4:' + diagonals(1) + `b #${LAYOUT_DONE};`);
}

// ---------------------------------------------------------------------------------------------------- the icon

/**
 * A preset's icon for the Grid Style list, 60x40 as the camera's 3x3 / 4x4 (`viewmenu.ts` drawGridIcon): the
 * camera's tile and white frame, and inside it what the preset draws on a 3:2 picture, in white (masks grey).
 */
export function drawFramingIcon(g: FramingGuides, i: 0 | 1): Uint8Array {
  const W = 60;
  const H = 40;
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (x < 3 || y < 1 || x >= W - 3 || y >= H - 1) px.set([255, 255, 255, 0], o);
      else if (x === 3 || y === 1 || x === W - 4 || y === H - 2) px.set([128, 128, 128, 255], o);
      else px.set([53, 53, 54, 255], o);
    }
  }
  const put = (x: number, y: number, a: number, grey: number): void => {
    if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(px[o + c] + (grey - px[o + c]) * Math.min(1, a));
  };
  // the frame: x 5..54, y 3..36, 2 px; inside it the picture 7..52 x 5..34 (46 x 30)
  for (let y = 3; y < 37; y++) for (let x = 5; x < 55; x++) if (x < 7 || x >= 53 || y < 5 || y >= 35) put(x, y, 1, 255);
  const X0 = 7, Y0 = 5, PW = 46, PH = 30;
  const c = compilePreset(g.presets[i]);
  const sx = PW / NOMINAL.w;
  const sy = PH / NOMINAL.h;
  const masks = new Set(g.presets[i].elements.flatMap((e) => (e.kind === 'frame' && e.mask !== null ? [e.mask] : [])));
  // coverage of each rectangle, at least one pixel wide in the icon, 4x4 samples per pixel
  for (const r of framingRects(c, NOMINAL)) {
    let x0 = X0 + r.x * sx, x1 = X0 + (r.x + r.w) * sx, y0 = Y0 + r.y * sy, y1 = Y0 + (r.y + r.h) * sy;
    if (x1 - x0 < 1) { const m = (x0 + x1) / 2; x0 = m - 0.5; x1 = m + 0.5; }
    if (y1 - y0 < 1) { const m = (y0 + y1) / 2; y0 = m - 0.5; y1 = m + 0.5; }
    x0 = Math.max(X0, x0); y0 = Math.max(Y0, y0); x1 = Math.min(X0 + PW, x1); y1 = Math.min(Y0 + PH, y1);
    const grey = masks.has(r.colour) && r.w * r.h > 400 ? 20 : 255;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const cx = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0));
        const cy = Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
        put(x, y, cx * cy * (grey === 255 ? 1.4 : 0.8), grey);
      }
    }
  }
  c.diagonals.forEach((d, k) => {
    if (!d) return;
    const [ax, ay, bx, by] = k === 0 ? [X0, Y0, X0 + PW, Y0 + PH] : [X0, Y0 + PH, X0 + PW, Y0];
    const len = Math.hypot(bx - ax, by - ay);
    for (let y = Y0; y < Y0 + PH; y++) {
      for (let x = X0; x < X0 + PW; x++) {
        let sum = 0;
        for (let s = 0; s < 16; s++) {
          const qx = x + ((s % 4) + 0.5) / 4;
          const qy = y + (Math.floor(s / 4) + 0.5) / 4;
          if (Math.abs((bx - ax) * (ay - qy) - (ax - qx) * (by - ay)) / len <= 1.1) sum++;
        }
        put(x, y, sum / 16, 255);
      }
    }
  });
  return px;
}

// ---------------------------------------------------------------------------------------------------- the record

/** The kinds by their number in the record (6, a safe area, only in versions 1 and 2). */
const KINDS = ['line', 'grid', 'golden', 'diagonals', 'centre', 'safe', 'frame'] as const;
const OUTLINES: readonly FramingOutline[] = ['box', 'corners', 'dashed'];

/**
 * The guides as bytes, for the build record (`package.ts`): version 3, the palette, each preset's elements.
 * (Version 1, test firmware 113: frames only in the picture and safe areas of their own; version 2, test firmware
 * 114 and 115: safe areas with a ratio.)
 */
export function encodeFramingGuides(g: FramingGuides): Uint8Array {
  const b: number[] = [3, g.palette.length];
  for (const c of g.palette) b.push(c.r, c.g, c.b, c.a);
  for (const p of g.presets) {
    b.push(p.elements.length);
    for (const e of p.elements) {
      b.push(KINDS.indexOf(e.kind) + 1, e.colour, e.width);
      switch (e.kind) {
        case 'line': b.push(e.axis === 'v' ? 1 : 0, e.at & 0xff, e.at >>> 8, e.box, e.dash === 'dashed' ? 1 : 0); break;
        case 'grid': b.push(e.cols, e.rows, e.box, e.dash === 'dashed' ? 1 : 0); break;
        case 'golden': b.push(e.box, e.dash === 'dashed' ? 1 : 0); break;
        case 'diagonals': b.push(e.down ? 1 : 0, e.up ? 1 : 0); break;
        case 'centre': b.push(e.mark === 'dot' ? 1 : 0, e.size, e.box); break;
        case 'frame': {
          const n = e.num ?? 0;
          const d = e.den ?? 0;
          b.push(n & 0xff, n >>> 8, d & 0xff, d >>> 8, e.scale, e.x & 0xff, e.y & 0xff, OUTLINES.indexOf(e.style), e.corner, e.mask === null ? 255 : e.mask, e.box);
          break;
        }
      }
    }
  }
  return Uint8Array.from(b);
}

/**
 * Guides of the time frame lines and safe areas were apart (records of version 1 and 2, projects saved by test
 * builds 095-099) as frames: a safe area becomes a frame (inset, or with its ratio) in its box, the frames are
 * numbered again in their order, and what was laid out in a frame line is laid out in the same frame. Anything
 * else is given back as it is.
 */
export function upgradeFramingGuides(v: unknown): unknown {
  if (typeof v !== 'object' || v === null || !Array.isArray((v as { presets?: unknown }).presets)) return v;
  const g = v as { palette: unknown; presets: { elements?: unknown }[] };
  const presets = g.presets.map((p) => {
    if (typeof p !== 'object' || p === null || !Array.isArray(p.elements)) return p;
    const els = p.elements as Record<string, unknown>[];
    if (!els.some((e) => e && (e.kind === 'safe' || (e.kind === 'frame' && e.box === undefined)))) return p;
    // old frame line k (1..) -> its number among the frames
    const lineTo: number[] = [0];
    let n = 0;
    for (const e of els) {
      if (e?.kind === 'frame') { n += 1; lineTo.push(n); } else if (e?.kind === 'safe') n += 1;
    }
    n = 0;
    const elements = els.map((e) => {
      if (!e || typeof e !== 'object') return e;
      if (e.kind === 'frame') { n += 1; return { ...e, box: 0 }; }
      if (e.kind === 'safe') {
        n += 1;
        const s = e as unknown as LegacySafe;
        const parent = lineTo[s.box] ?? 0;
        const f: FramingFrame = { kind: 'frame', scale: s.percent, x: 0, y: 0, box: (parent < n ? parent : 0) as FramingBox, style: s.style, corner: 15, mask: null, colour: s.colour, width: s.width };
        if (s.num !== undefined && s.den !== undefined) { f.num = s.num; f.den = s.den; }
        return f;
      }
      return 'box' in e ? { ...e, box: lineTo[e.box as number] ?? 0 } : e;
    });
    return { ...p, elements };
  });
  return { ...g, presets };
}

/** The guides from their bytes, or null when they are not valid guides of version 1, 2 or 3. */
export function decodeFramingGuides(bytes: Uint8Array): FramingGuides | null {
  let p = 0;
  const next = (): number => { if (p >= bytes.length) throw new RangeError('short'); return bytes[p++]; };
  const s8 = (v: number): number => (v > 127 ? v - 256 : v);
  try {
    const version = next();
    if (version < 1 || version > 3) return null;
    const n = next();
    const palette: FramingColour[] = [];
    for (let i = 0; i < n; i++) palette.push({ r: next(), g: next(), b: next(), a: next() });
    const presets: { elements: unknown[] }[] = [];
    for (let i = 0; i < 2; i++) {
      const count = next();
      const elements: unknown[] = [];
      for (let k = 0; k < count; k++) {
        const kind = KINDS[next() - 1];
        const colour = next();
        const width = next();
        const dash = (v: number): FramingDash => (v ? 'dashed' : 'solid');
        switch (kind) {
          case 'line': { const axis = next() ? 'v' : 'h'; const at = next() | (next() << 8); elements.push({ kind, axis, at, box: next(), dash: dash(next()), colour, width }); break; }
          case 'grid': elements.push({ kind, cols: next(), rows: next(), box: next(), dash: dash(next()), colour, width }); break;
          case 'golden': elements.push({ kind, box: next(), dash: dash(next()), colour, width }); break;
          case 'diagonals': elements.push({ kind, down: !!next(), up: !!next(), colour, width }); break;
          case 'centre': elements.push({ kind, mark: next() ? 'dot' : 'cross', size: next(), box: next(), colour, width }); break;
          case 'safe': {
            if (version >= 3) return null;
            const e: LegacySafe = { kind, percent: next(), box: next(), style: OUTLINES[next()], colour, width };
            if (version === 2) { const sn = next() | (next() << 8); const sd = next() | (next() << 8); if (sn || sd) { e.num = sn; e.den = sd; } }
            elements.push(e);
            break;
          }
          case 'frame': {
            const num = next() | (next() << 8);
            const den = next() | (next() << 8);
            const scale = next();
            const x = s8(next());
            const y = s8(next());
            const style = OUTLINES[next()];
            const corner = next();
            const m = next();
            const f: Record<string, unknown> = { kind, scale, x, y, style, corner, mask: m === 255 ? null : m, colour, width };
            if (version >= 3) f.box = next();
            if (num || den) { f.num = num; f.den = den; }
            elements.push(f);
            break;
          }
          default: return null;
        }
      }
      presets.push({ elements });
    }
    if (p !== bytes.length) return null;
    const g = upgradeFramingGuides({ palette, presets });
    return validFramingGuides(g) ? g : null;
  } catch {
    return null;
  }
}
