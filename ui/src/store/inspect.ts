// SPDX-License-Identifier: GPL-2.0-only
/**
 * Inspect any firmware file, and compare two of them: the state behind the "Inspect a firmware file"
 * dialog (inspect.tsx). The summaries come from the engine's inspect() as it is; this part only
 * reads the files, keeps the answers and drops one that arrives after the dialog moved on.
 *
 * @decision DEC-INSPECT-UI-001
 * @title Inspect reports against the open official firmware, so it needs one open
 * @status accepted
 * @rationale engine.inspect (core app/engine.ts) diffs a file against the official firmware the
 *   engine has open and reports kind / verified / features; the summary carries no model or version
 *   of its own. The dialog therefore names the open firmware (family and version) as the reference
 *   and asks for one when none is open, instead of guessing a model from the bytes.
 *
 * @decision DEC-INSPECT-COMPARE-001
 * @title The second file is inspected the same way, against the same open official firmware
 * @status accepted
 * @rationale Both summaries are relative to the one open firmware, so they are comparable row by
 *   row without a second reference. The comparison itself (compare.ts) is a pure function of the two
 *   summaries; the dialog only lays it out. Single-file inspect is unchanged: `other` is simply
 *   absent until a second file is chosen, and choosing a new first file clears it.
 */
import type { FirmwareSummary } from '@grmod/core';
import { engine } from '../engine';
import { set, state } from './core';

/** A firmware file being inspected: `error` is `needs-open` (no official firmware to compare with), `unreadable` (not a file the engine can read) or `size`. */
export interface InspectView {
  name: string; size: number; busy: boolean; summary?: FirmwareSummary; error?: 'needs-open' | 'unreadable' | 'size';
  /** A second file compared with the first (absent in plain single-file inspect). */
  other?: { name: string; size: number; busy: boolean; summary?: FirmwareSummary; error?: 'unreadable' | 'size' };
}

/** Counts the files asked for, so that an answer for a file the dialog has left is dropped. */
let inspectGen = 0;
/** Official firmware files are tens of MB; anything outside this range is not one. */
const sizeOk = (n: number): boolean => n >= 1_000_000 && n <= 200_000_000;

export function closeInspect(): void { inspectGen++; set({ inspectView: undefined }); }
/** Open the dialog on `file`: read by the engine against the open official firmware. */
export async function inspectFile(file: File): Promise<void> {
  const gen = ++inspectGen;
  const view = { name: file.name, size: file.size };
  if (!state.info) { set({ inspectView: { ...view, busy: false, error: 'needs-open' } }); return; }
  if (!sizeOk(file.size)) { set({ inspectView: { ...view, busy: false, error: 'size' } }); return; }
  set({ inspectView: { ...view, busy: true } });
  try {
    const summary = await engine.inspect(new Uint8Array(await file.arrayBuffer()));
    if (gen === inspectGen) set({ inspectView: { ...view, busy: false, summary } });
  } catch (e) {
    console.warn('inspect', e);
    if (gen === inspectGen) set({ inspectView: { ...view, busy: false, error: 'unreadable' } });
  }
}
/** Inspect a second file for the dialog to lay beside the first (the first stays when the second cannot be read). */
export async function inspectCompare(file: File): Promise<void> {
  const v = state.inspectView; if (!v?.summary) return;
  const gen = inspectGen;
  const side = { name: file.name, size: file.size };
  if (!sizeOk(file.size)) { set({ inspectView: { ...v, other: { ...side, busy: false, error: 'size' } } }); return; }
  set({ inspectView: { ...v, other: { ...side, busy: true } } });
  const put = (other: NonNullable<InspectView['other']>): void => { if (gen === inspectGen && state.inspectView) set({ inspectView: { ...state.inspectView, other } }); };
  try { put({ ...side, busy: false, summary: await engine.inspect(new Uint8Array(await file.arrayBuffer())) }); }
  catch (e) { console.warn('inspect compare', e); put({ ...side, busy: false, error: 'unreadable' }); }
}
/** Back to the single-file view. */
export function closeCompare(): void { const v = state.inspectView; if (v?.other) set({ inspectView: { ...v, other: undefined } }); }
