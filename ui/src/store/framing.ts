/**
 * Framing guides (GR IV 1.20 / 1.21; core `FramingGuides`): two presets of elements in place of the camera's 3x3 and
 * 4x4 grids, in colours of a palette of eight. Shown and edited on the custom grid's page (pages/grid.tsx); built
 * with the custom grid's switch on. GR IV 1.11 keeps the eight lines of `gridLines`.
 */
import { CAMERA_GRID, FRAMING_MAX_ELEMENTS, FRAMING_MAX_FRAMES, clonePreset, CAMERA_PRESETS, defaultFramingGuides, framingProblem, framingValues } from '@grmod/core';
import type { CustomGrid, FramingColour, FramingElement, FramingGuides, FramingPreset } from '@grmod/core';
import { State, set, state } from './core';
import { scheduleSave } from './families';

export type FramingKind = FramingElement['kind'];
export const FRAMING_KINDS: readonly FramingKind[] = ['frame', 'grid', 'golden', 'line', 'safe', 'centre', 'diagonals'];

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
  if (framingProblem(v) === null) return JSON.parse(JSON.stringify(v)) as FramingGuides;
  const g = defaultFramingGuides();
  g.presets = [linesAsPreset(lines.g3, 'g3'), linesAsPreset(lines.g4, 'g4')];
  return g;
}

function update(f: (g: FramingGuides) => void): void {
  const g = JSON.parse(JSON.stringify(state.framing)) as FramingGuides;
  f(g);
  set({ framing: g }); scheduleSave();
}

/** The frame lines of a preset in order (A, B, C). */
const framesOf = (p: FramingPreset): number => p.elements.filter((e) => e.kind === 'frame').length;

/** A new element of `kind` with the usual settings (a frame line 2.39:1 in white, a grid 3 x 3 in the camera's colour...). */
export function newElement(kind: FramingKind): FramingElement {
  switch (kind) {
    case 'frame': return { kind, num: 239, den: 100, scale: 100, x: 0, y: 0, style: 'box', corner: 15, mask: null, colour: 1, width: 2 };
    case 'grid': return { kind, cols: 3, rows: 3, box: 0, dash: 'solid', colour: 0, width: 2 };
    case 'golden': return { kind, box: 0, dash: 'solid', colour: 0, width: 2 };
    case 'line': return { kind, axis: 'h', at: 5000, box: 0, dash: 'solid', colour: 1, width: 2 };
    case 'safe': return { kind, percent: 90, box: 0, style: 'corners', colour: 2, width: 2 };
    case 'centre': return { kind, mark: 'cross', size: 24, box: 0, colour: 1, width: 2 };
    case 'diagonals': return { kind, down: true, up: true, colour: 0, width: 2 };
  }
}

/** Whether an element of `kind` can be added to preset `p` (at most three frame lines, one diagonals, 24 elements). */
export function canAdd(p: FramingPreset, kind: FramingKind): boolean {
  if (p.elements.length >= FRAMING_MAX_ELEMENTS) return false;
  if (kind === 'frame') return framesOf(p) < FRAMING_MAX_FRAMES;
  if (kind === 'diagonals') return !p.elements.some((e) => e.kind === 'diagonals');
  return true;
}

export function addFramingElement(preset: 0 | 1, kind: FramingKind): void {
  if (!canAdd(state.framing.presets[preset], kind)) return;
  update((g) => { g.presets[preset].elements.push(newElement(kind)); });
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
      else if (x.box > box) x.box = (x.box - 1) as 0 | 1 | 2;
    }
  });
}

export function resetFramingPreset(preset: 0 | 1): void {
  update((g) => { g.presets[preset] = clonePreset(CAMERA_PRESETS[preset]); });
}

export function setFramingColour(index: number, colour: FramingColour): void {
  if (!state.framing.palette[index]) return;
  update((g) => { g.palette[index] = { ...colour }; });
}

/** The letter of frame line `box` (1..3). */
export const frameLetter = (box: number): string => 'ABC'[box - 1] ?? '';
