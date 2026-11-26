// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: additions brought over from GR IV after round 10 ("extras"). Each is
 * asked for on its own and recorded in the build recipe (ratio-recipe.ts) only when it is there, so
 * a build without any is byte for byte what it was. They need round 10 (its RAM words and settings
 * scaffold).
 */
import { isCameraGrid, validCustomGrid } from '../aspect/grid';
import type { CustomGrid } from '../aspect/grid';
import { FirmwareError } from '../types';

export interface Gr3xExtras {
  /** Which lines the camera's 3x3 and 4x4 grid styles draw (grid.ts); never the camera's own grids. */
  customGrid?: CustomGrid;
  /** Snap Focus Distance and the manual focus scale in feet and inches (units.ts). */
  distanceFeet?: true;
  /** Soft focus (ADJ, needs `adjSoftFocus`) also a line of the still menu (menu-lines.ts). */
  softFocusMenu?: true;
}

/** The extras as they are built and recorded: validated, defaults left out; undefined for none. */
export function normalizeGr3xExtras(x: unknown): Gr3xExtras | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'object') throw new FirmwareError('bad-edit', 'IIIx extras');
  const e = x as Record<string, unknown>, out: Gr3xExtras = {};
  for (const k of Object.keys(e)) if (k !== 'customGrid' && k !== 'distanceFeet' && k !== 'softFocusMenu') throw new FirmwareError('bad-edit', `IIIx extras: unknown addition ${k}`);
  if (e.customGrid !== undefined) {
    if (!validCustomGrid(e.customGrid)) throw new FirmwareError('bad-edit', 'custom grid: eight lines on or off for each style');
    if (!isCameraGrid(e.customGrid)) out.customGrid = { g3: [...e.customGrid.g3], g4: [...e.customGrid.g4] };
  }
  if (e.distanceFeet !== undefined && typeof e.distanceFeet !== 'boolean') throw new FirmwareError('bad-edit', 'distanceFeet must be boolean');
  if (e.distanceFeet === true) out.distanceFeet = true;
  if (e.softFocusMenu !== undefined && typeof e.softFocusMenu !== 'boolean') throw new FirmwareError('bad-edit', 'softFocusMenu must be boolean');
  if (e.softFocusMenu === true) out.softFocusMenu = true;
  return Object.keys(out).length ? out : undefined;
}
