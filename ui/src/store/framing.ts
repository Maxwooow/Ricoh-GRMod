/**
 * Framing guides (GR IV 1.20 / 1.21; core `FramingGuides`): two presets of elements in place of the camera's 3x3 and
 * 4x4 grids. Shown and edited on the custom grid's page (pages/grid.tsx); built with the custom grid's switch on.
 * GR IV 1.11 keeps the eight lines of `gridLines`.
 *
 * Each element has a colour of its own in the editor; the camera has room for eight colours in all, so the palette
 * of the guides is kept here as exactly the colours in use (both presets), in the order they are first used.
 */
import { CAMERA_GRID, CAMERA_GRID_COLOUR, upgradeFramingGuides, FRAMING_MAX_ELEMENTS, FRAMING_MAX_FRAMES, FRAMING_PALETTE_SIZE, clonePreset, CAMERA_PRESETS, defaultFramingGuides, framingProblem, framingValues } from '@grmod/core';
import type { CustomGrid, FramingBox, FramingColour, FramingElement, FramingGuides, FramingPreset } from '@grmod/core';
import { State, set, state } from './core';
import { scheduleSave } from './families';

export type FramingKind = FramingElement['kind'];
export const FRAMING_KINDS: readonly FramingKind[] = ['frame', 'grid', 'golden', 'line', 'centre', 'diagonals'];

/** The firmware draws framing guides (GR IV 1.20 / 1.21). */
export const framingOffered = (s: State = state): boolean => !!s.info?.features.framing;

/** The guides a build gets: none when the switch is off, the firmware cannot have them, or both presets are the camera's. */
export function framingOf(s: State = state): FramingGuides | undefined {
  return s.customGrid && framingOffered(s) && framingProblem(s.framing) === null && framingValues(s.framing).length > 0 ? s.framing : undefined;
}

/** The eight lines of 0.8.x as the elements of a preset (the camera's own lines as its grid). */
function linesAsPreset(lines: readonly boolean[], style: 'g3' | 'g4'): FramingPreset {
  if (lines.every((v, i) => v === CAMERA_GRID[style][i])) return clonePreset(CAMERA_PRESETS[style === 'g3' ? 0 : 1]);
  const k = style === 'g3' ? 3 : 4;
  const at = [10000 / k, 5000, 10000 - 10000 / k].map(Math.round);
  const elements: FramingElement[] = [];
  lines.slice(0, 3).forEach((on, i) => { if (on) elements.push({ kind: 'line', axis: 'h', at: at[i], box: 0, dash: 'solid', colour: 0, width: 2 }); });
  lines.slice(3, 6).forEach((on, i) => { if (on) elements.push({ kind: 'line', axis: 'v', at: at[i], box: 0, dash: 'solid', colour: 0, width: 2 }); });
  if (lines[6] || lines[7]) elements.push({ kind: 'diagonals', down: lines[6], up: lines[7], colour: 0, width: 2 });
  return { elements };
}

/** The guides as saved in the project; without them, the grid lines of 0.8.x carried over. */
export function savedFraming(v: unknown, lines: CustomGrid): FramingGuides {
  // projects of test builds 095-099 kept safe areas apart from frame lines
  const u = upgradeFramingGuides(v);
  if (framingProblem(u) === null) return JSON.parse(JSON.stringify(u)) as FramingGuides;
  const g = defaultFramingGuides();
  g.presets = [linesAsPreset(lines.g3, 'g3'), linesAsPreset(lines.g4, 'g4')];
  return g;
}

const sameColour = (a: FramingColour, b: FramingColour): boolean => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

/** The colours offered for an element (any other is picked with the colour picker): the camera's grid colour first. */
export const FRAMING_SWATCHES: readonly FramingColour[] = [
  CAMERA_GRID_COLOUR,
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 255, g: 255, b: 255, a: 128 },
  { r: 255, g: 59, b: 48, a: 255 },
  { r: 255, g: 149, b: 0, a: 255 },
  { r: 255, g: 204, b: 0, a: 255 },
  { r: 52, g: 199, b: 89, a: 255 },
  { r: 90, g: 200, b: 250, a: 255 },
];
const WHITE = FRAMING_SWATCHES[2];
const HALF_WHITE = FRAMING_SWATCHES[3];

/** The colours an element uses: its own, and a frame line's mask. */
const coloursOf = (e: FramingElement): number[] => (e.kind === 'frame' && e.mask !== null ? [e.colour, e.mask] : [e.colour]);

/** Keep in the palette exactly the colours in use, once each, in the order they are first used (at least one). */
function compact(g: FramingGuides): void {
  const palette: FramingColour[] = [];
  const indexOf = (c: FramingColour): number => {
    const k = palette.findIndex((x) => sameColour(x, c));
    if (k >= 0) return k;
    palette.push({ ...c });
    return palette.length - 1;
  };
  const old = g.palette;
  for (const p of g.presets) {
    for (const e of p.elements) {
      e.colour = indexOf(old[e.colour] ?? CAMERA_GRID_COLOUR);
      if (e.kind === 'frame' && e.mask !== null) e.mask = indexOf(old[e.mask] ?? CAMERA_GRID_COLOUR);
    }
  }
  if (!palette.length) palette.push({ ...CAMERA_GRID_COLOUR });
  g.palette = palette;
}

/** The palette number of `c`, added when there is room; null when the palette is full. */
function colourIndex(g: FramingGuides, c: FramingColour): number | null {
  const k = g.palette.findIndex((x) => sameColour(x, c));
  if (k >= 0) return k;
  if (g.palette.length >= FRAMING_PALETTE_SIZE) return null;
  g.palette.push({ ...c });
  return g.palette.length - 1;
}

/** A copy of the guides with `f` applied, the palette kept to the colours in use; null when `f` gives up. */
function changed(f: (g: FramingGuides) => boolean | void): FramingGuides | null {
  const g = JSON.parse(JSON.stringify(state.framing)) as FramingGuides;
  compact(g);
  if (f(g) === false) return null;
  compact(g);
  return g;
}

function update(f: (g: FramingGuides) => boolean | void): boolean {
  const g = changed(f);
  if (!g) return false;
  set({ framing: g }); scheduleSave();
  return true;
}

/** The colour of an element as shown (`which`: its lines or a frame line's mask; null: no mask). */
export function framingColourOf(g: FramingGuides, e: FramingElement, which: 'colour' | 'mask' = 'colour'): FramingColour | null {
  const k = which === 'mask' ? (e.kind === 'frame' ? e.mask : null) : e.colour;
  return k === null ? null : g.palette[k] ?? CAMERA_GRID_COLOUR;
}

/**
 * Give an element a colour (`which`: its lines, or a frame line's mask, null for none). False when that would make
 * more than eight colours in both grids together: the camera has no room for more.
 */
export function setFramingElementColour(preset: 0 | 1, index: number, which: 'colour' | 'mask', c: FramingColour | null): boolean {
  const e = state.framing.presets[preset].elements[index];
  if (!e || (which === 'mask' && e.kind !== 'frame') || (which === 'colour' && c === null)) return false;
  // the element's old colour may be freed by the change: count what is used after it
  const g = changed((x) => {
    const el = x.presets[preset].elements[index];
    if (c === null) { if (el.kind === 'frame') el.mask = null; return; }
    // put the new colour where the palette has a place for it even when full, then let compact() drop what is unused
    let k = x.palette.findIndex((y) => sameColour(y, c));
    if (k < 0) { x.palette.push({ ...c }); k = x.palette.length - 1; }
    if (which === 'mask' && el.kind === 'frame') el.mask = k; else el.colour = k;
  });
  if (!g || g.palette.length > FRAMING_PALETTE_SIZE) return false;
  set({ framing: g }); scheduleSave();
  return true;
}

/** The frame lines of a preset in order (A, B, C). */
const framesOf = (p: FramingPreset): number => p.elements.filter((e) => e.kind === 'frame').length;

/** A new element of `kind` with the usual settings (a frame line 2.39:1 in white, a grid 3 x 3 in the camera's colour...). */
export function newElement(kind: FramingKind): { element: FramingElement; colour: FramingColour } {
  const grey = CAMERA_GRID_COLOUR;
  switch (kind) {
    case 'frame': return { element: { kind, num: 239, den: 100, scale: 100, x: 0, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 0, width: 2 }, colour: WHITE };
    case 'grid': return { element: { kind, cols: 3, rows: 3, box: 0, dash: 'solid', colour: 0, width: 2 }, colour: grey };
    case 'golden': return { element: { kind, box: 0, dash: 'solid', colour: 0, width: 2 }, colour: grey };
    case 'line': return { element: { kind, axis: 'h', at: 5000, box: 0, dash: 'solid', colour: 0, width: 2 }, colour: WHITE };
    case 'centre': return { element: { kind, mark: 'cross', size: 24, box: 0, colour: 0, width: 2 }, colour: WHITE };
    case 'diagonals': return { element: { kind, down: true, up: true, colour: 0, width: 2 }, colour: grey };
  }
}

/** Whether an element of `kind` can be added to preset `p` (at most seven frames, one diagonals, 24 elements). */
export function canAdd(p: FramingPreset, kind: FramingKind): boolean {
  if (p.elements.length >= FRAMING_MAX_ELEMENTS) return false;
  if (kind === 'frame') return framesOf(p) < FRAMING_MAX_FRAMES;
  if (kind === 'diagonals') return !p.elements.some((e) => e.kind === 'diagonals');
  return true;
}

export function addFramingElement(preset: 0 | 1, kind: FramingKind): void {
  if (!canAdd(state.framing.presets[preset], kind)) return;
  update((g) => {
    const { element, colour } = newElement(kind);
    // its usual colour, or (all eight colours taken) the first one in use
    element.colour = colourIndex(g, colour) ?? 0;
    g.presets[preset].elements.push(element);
  });
}

export function setFramingElement(preset: 0 | 1, index: number, change: Partial<FramingElement>): void {
  if (!state.framing.presets[preset].elements[index]) return;
  update((g) => { Object.assign(g.presets[preset].elements[index], change); });
}

/**
 * Remove an element. A frame line's letter is its place among the frame lines, so what is inside a later one moves
 * with it (B becomes A), and what was inside the removed one goes to the picture.
 */
export function removeFramingElement(preset: 0 | 1, index: number): void {
  const p = state.framing.presets[preset];
  const e = p.elements[index];
  if (!e) return;
  const box = e.kind === 'frame' ? p.elements.slice(0, index + 1).filter((x) => x.kind === 'frame').length : 0;
  update((g) => {
    const els = g.presets[preset].elements;
    els.splice(index, 1);
    if (!box) return;
    for (const x of els) {
      if (!('box' in x)) continue;
      if (x.box === box) x.box = 0;
      else if (x.box > box) x.box = (x.box - 1) as FramingBox;
    }
  });
}

export function resetFramingPreset(preset: 0 | 1): void {
  update((g) => { g.presets[preset] = clonePreset(CAMERA_PRESETS[preset]); });
}

// ---------------------------------------------------------------- templates

/** A ready grid to start from: its elements, whose colours are numbers into its own `palette`. */
export interface FramingTemplate { id: string; palette: FramingColour[]; elements: FramingElement[] }

const [GREY, , , , RED] = FRAMING_SWATCHES;
const frame = (num: number, den: number, style: 'box' | 'corners' | 'dashed', mask: number | null, colour = 0, extra: Partial<FramingElement> = {}): FramingElement =>
  ({ kind: 'frame', num, den, scale: 100, x: 0, y: 0, box: 0, style, corner: 12, mask, colour, width: 2, ...extra } as FramingElement);
const thirdsIn = (box: 0 | 1 | 2 | 3, colour: number): FramingElement => ({ kind: 'grid', cols: 3, rows: 3, box, dash: 'solid', colour, width: 2 });

/** The templates offered on the page: composition aids, frame lines for other formats, combinations of both. */
export const FRAMING_TEMPLATES: readonly FramingTemplate[] = [
  { id: 'thirds', palette: [GREY], elements: [thirdsIn(0, 0)] },
  { id: 'quarters', palette: [GREY], elements: [{ kind: 'grid', cols: 4, rows: 4, box: 0, dash: 'solid', colour: 0, width: 2 }, { kind: 'diagonals', down: true, up: true, colour: 0, width: 2 }] },
  { id: 'flat', palette: [WHITE, GREY], elements: [frame(185, 100, 'box', 1)] },
  { id: 'centre', palette: [HALF_WHITE, WHITE], elements: [
    { kind: 'line', axis: 'h', at: 5000, box: 0, dash: 'dashed', colour: 0, width: 1 }, { kind: 'line', axis: 'v', at: 5000, box: 0, dash: 'dashed', colour: 0, width: 1 },
    { kind: 'frame', scale: 90, x: 0, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 1, width: 2 }, { kind: 'centre', mark: 'cross', size: 24, box: 0, colour: 1, width: 2 }] },
  { id: 'cinema', palette: [WHITE, GREY, HALF_WHITE, RED], elements: [frame(239, 100, 'corners', 1), thirdsIn(1, 2), { kind: 'centre', mark: 'cross', size: 20, box: 1, colour: 3, width: 2 }] },
];

/** A template as guides (its palette, the template in both presets), for its picture. */
export const templateGuides = (tpl: FramingTemplate): FramingGuides => ({ palette: tpl.palette, presets: [{ elements: tpl.elements }, { elements: tpl.elements }] });

/** Replace preset `preset` with a template. False when its colours and the other grid's would be more than eight. */
export function applyFramingTemplate(preset: 0 | 1, id: string): boolean {
  const tpl = FRAMING_TEMPLATES.find((x) => x.id === id);
  if (!tpl) return false;
  const g = changed((x) => {
    x.presets[preset] = { elements: [] };
    compact(x);
    // the template's colours after the other grid's: the palette may hold more than eight until checked below
    const map = tpl.palette.map((c) => {
      let k = x.palette.findIndex((y) => sameColour(y, c));
      if (k < 0) { x.palette.push({ ...c }); k = x.palette.length - 1; }
      return k;
    });
    x.presets[preset] = { elements: tpl.elements.map((e) => ({ ...e, colour: map[e.colour], ...(e.kind === 'frame' ? { mask: e.mask === null ? null : map[e.mask] } : {}) }) as FramingElement) };
  });
  if (!g || g.palette.length > FRAMING_PALETTE_SIZE) return false;
  set({ framing: g }); scheduleSave();
  return true;
}

/** The letter of frame line `box` (1..3). */
export const frameLetter = (box: number): string => 'ABCDEFG'[box - 1] ?? '';
