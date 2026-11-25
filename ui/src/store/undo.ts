import { t } from '../i18n';
import { dismissToast, state, toast } from './core';
import { familyOf, scheduleSave } from './families';

// ------------------------------------------------------------------ undo for deletes
/**
 * @decision DEC-QOLB-UNDO-001
 * @title One last-deleted record; host files are deleted only when the undo window closes
 * @status accepted
 * @rationale Removing an added slot, a ratio or a power-off picture used to be final at once. The delete now
 *   leaves one record (a new delete replaces it) and a toast with an Undo button. Everything the
 *   item needs to come back is already in memory (preset text, icon, blob, preview), so the only
 *   thing deferred is the removal of its host store files (`preset-<key>`, `wall-<id>`): `commit`
 *   runs when the toast's window ends, or when another delete replaces the record. Deleting the files at
 *   once and re-writing them on undo would work too, but a crash in between would then lose the preset
 *   for good; an orphaned file after a crash only costs a few kB.
 */
interface Deleted { family: ReturnType<typeof familyOf>; restore: () => boolean; commit: () => void; timer: ReturnType<typeof setTimeout>; toastId: number }
let lastDeleted: Deleted | undefined;
/** How long a delete can be taken back: the toast's own life (core's toast keeps one with a button for 12 s). */
const UNDO_MS = 12000;
/** Whether a delete can still be taken back. */
export const undoPending = (): boolean => !!lastDeleted;
/** Close the undo window: the deferred file delete runs and the record's own toast goes. Also called before anything replaces the whole project. */
export function flushDeleted(): void { const d = lastDeleted; lastDeleted = undefined; if (d) { clearTimeout(d.timer); dismissToast(d.toastId); d.commit(); } }
/**
 * Keep a delete undoable. `restore` puts the item back and returns false (changing nothing) when it cannot:
 * the list is full again (delete one, add one, undo would exceed the cap). `commit` is the deferred part,
 * the removal of the host store files. The toast's button is bound to this record, not to "whatever is
 * pending now": a superseded toast is dismissed with its record, and a press that still gets through says so.
 */
export function recordDeleted(text: string, restore: () => boolean, commit: () => void): void {
  flushDeleted();
  const d: Deleted = { family: familyOf(state.model), restore, commit, timer: setTimeout(() => { if (lastDeleted === d) flushDeleted(); }, UNDO_MS), toastId: 0 };
  lastDeleted = d;
  d.toastId = toast(text, 'info', { label: t('undo'), run: () => { if (lastDeleted === d) undoDelete(); else toast(t('undoGone'), 'info'); } });
}
/** Take the last delete back (the toast's button). */
export function undoDelete(): void {
  const d = lastDeleted; if (!d) return;
  lastDeleted = undefined; clearTimeout(d.timer); dismissToast(d.toastId);
  // Compared by camera family, not model: HDF to Standard keeps the same slots, ratios and pictures. Another family has other lists.
  if (d.family !== familyOf(state.model)) { d.commit(); return; }
  if (!d.restore()) { d.commit(); toast(t('undoFull'), 'info'); return; }
  scheduleSave();
}
