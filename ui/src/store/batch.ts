import { MAX_EXTRA_SLOTS } from '@grmod/core';
import { t } from '../i18n';
import { SlotKey, State, ask, set, slotOf, state, toast } from './core';
import { setActiveSlot } from './photo';
import { addExtraSlot, allSlotKeys, loadPresetFile } from './slots';

// ------------------------------------------------------------------ batch preset import
/**
 * @decision DEC-QOL-BATCH-001
 * @title Several preset files at once fill empty slots in order, never overwrite, and ask before adding slots
 * @status accepted
 * @rationale Importing a pack of looks meant one drop per slot. With several .xmp / .cube files the
 *   targets are, in order: the slot the files were dropped on or picked for (the active slot when none
 *   is given) if it has no usable preset, then every other slot without one in menu order (built-in
 *   slots, then added slots). A slot "has a preset" when it holds one that did not fail: a failed
 *   conversion is replaced, a good look never is. Files beyond the free slots are skipped, unless
 *   the camera is a GR IV (the only family with added slots) and there is room under
 *   MAX_EXTRA_SLOTS: then, once the free slots are filled, one ask() offers to add that many slots for them (declining skips them).
 *   Fitting runs one file after another through the ordinary loadPresetFile / runPreset path, so
 *   options, storage and stale-run guards are identical to a single import; the busy overlay shows
 *   "i of n". A final toast counts applied, skipped and failed files and names the failed ones. One
 *   file behaves exactly as before (loadPresetFile on the given slot, replacing what is there).
 */
const hasUsablePreset = (k: SlotKey, s: State = state): boolean => { const p = slotOf(k, s)?.preset; return !!p && !p.error; };
/** The slots a batch of files goes to, in order (see DEC-QOL-BATCH-001): `from` first when it is free, then the other free slots. */
export function batchTargets(from: SlotKey = state.activeSlot, s: State = state): SlotKey[] {
  const keys = allSlotKeys(s), free = keys.filter((k) => !hasUsablePreset(k, s));
  return keys.includes(from) && free.includes(from) ? [from, ...free.filter((k) => k !== from)] : free;
}
/** How many more slots could be added for a batch (GR IV only; not on the Monochrome, which builds none). */
const batchRoom = (s: State = state): number => (s.info && s.info.family !== 'gr3x' && s.model !== 'MONO' ? Math.max(0, MAX_EXTRA_SLOTS - s.extras.length) : 0);
export async function loadPresetFiles(files: File[], from?: SlotKey): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) { await loadPresetFile(from ?? state.activeSlot, files[0]); return; }
  if (state.busy) return;
  const slots = batchTargets(from);
  const rest = files.slice(slots.length);
  const failed: string[] = []; let applied = 0, skipped = rest.length, firstSlot: SlotKey | undefined;
  const caps = !!state.info?.capabilities.presets;
  /** Fit `list` into `into` one after another; `done` of `total` files are behind when it starts (for the progress text). */
  const run = async (into: SlotKey[], list: File[], done: number, total: number): Promise<void> => {
    firstSlot ??= into[0];
    set({ busy: t('batchProgress', { i: done + 1, n: total }) });
    try {
      for (let i = 0; i < list.length; i++) {
        set({ busy: t('batchProgress', { i: done + i + 1, n: total }) });
        try { await loadPresetFile(into[i], list[i]); } catch { /* counted below */ }
        const p = slotOf(into[i])?.preset;
        if (p && p.fileName === list[i].name && !p.error && (p.result || !caps)) applied++; else failed.push(list[i].name);
      }
    } finally { set({ busy: undefined }); }
  };
  const room = Math.min(rest.length, batchRoom());
  if (slots.length) await run(slots, files.slice(0, slots.length), 0, slots.length + room);
  // the free slots are used up: offer added slots for the files that are left (GR IV, room under the limit)
  if (room > 0 && await ask(t('batchAddTitle'), [t('batchAddLine', { n: rest.length }), t('batchAddFiles', { n: room, names: rest.slice(0, room).map((f) => f.name).join(', ') })], t('batchAddOk'))) {
    const before = new Set(state.extras.map((x) => x.key));
    for (let i = 0; i < room; i++) addExtraSlot();
    const added = state.extras.map((x) => x.key).filter((k) => !before.has(k));
    await run(added, rest.slice(0, added.length), slots.length, slots.length + added.length);
    skipped = rest.length - added.length;
  }
  if (firstSlot) setActiveSlot(firstSlot);
  const parts = [t('batchDone', { n: applied })];
  if (skipped) parts.push(t('batchSkipped', { n: skipped }));
  if (failed.length) parts.push(t('batchFailed', { n: failed.length, names: failed.slice(0, 3).join(', ') + (failed.length > 3 ? ` +${failed.length - 3}` : '') }));
  toast(parts.join(' · '), failed.length ? 'error' : 'ok');
}
