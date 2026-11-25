import { set, slotOf, state } from './core';
import type { SlotKey, State } from './core';
import { scheduleSave } from './families';
import { allSlotKeys } from './slots';

/**
 * Compare two slots: the left side of the photo preview can show another slot's look instead of the
 * original photo.
 *
 * @decision DEC-COMPARE-001
 * @title The left side of the photo preview can be another slot's look; the choice is saved view state
 * @status accepted
 * @rationale The preview split showed the photo before and after one slot, so judging two looks meant
 *   switching tabs and remembering. `compareWith` is `orig` (the default and the fallback) or a slot
 *   key. It is saved with previewMode because that is saved too. It is a key, not a copy of the look,
 *   so it follows later edits of that slot; a slot that was removed or lost its preset, or the active
 *   slot itself, counts as `orig` (compareSlot), never an error. The left image is rendered with the
 *   same applySlot pipeline as the right one, deferred a tick so choosing does not stall the UI.
 */
/** Slots that have a fitted look, in menu order: what the compare choice can offer. */
export function slotsWithLook(s: State = state): SlotKey[] { return allSlotKeys(s).filter((k) => slotOf(k, s)?.preset?.result); }
/** The slot whose look is on the left of the preview, or undefined for the original photo. */
export function compareSlot(s: State = state): SlotKey | undefined {
  const k = s.compareWith;
  return k !== 'orig' && k !== s.activeSlot && slotsWithLook(s).includes(k) ? k : undefined;
}
export function setCompareWith(compareWith: string): void { set({ compareWith }); scheduleSave(); }
