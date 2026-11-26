import { MAX_EXTRA_SLOTS } from '@grmod/core';
import { t } from '../i18n';
import { SlotKey, State, set, slotOf, state, toast } from './core';
import { setActiveSlot } from './photo';
import { addExtraSlot, allSlotKeys, loadPresetFile } from './slots';

// ------------------------------------------------------------------ batch preset import
/**
 * @decision DEC-QOL-BATCH-002
 * @title Several preset files: the first on the slot they were dropped on, the rest on added slots (made as needed), or none at all
 * @status accepted (replaces DEC-QOL-BATCH-001, which also filled the empty Cinema slots and asked before adding slots)
 * @rationale A pack of looks dropped on a slot. The first file goes to that slot (the active slot when the files were
 *   picked without one), replacing what it holds, exactly as one dropped file does: the user chose that slot. The others
 *   never go to a factory (Cinema) slot by themselves. On a GR IV they fill the added slots without a usable preset
 *   (none, or a failed conversion: a good look is never replaced), in their order, and new added slots are made for
 *   the files left over, without asking. When that would need more than MAX_EXTRA_SLOTS added slots, or the camera has
 *   no added slots (GR IV Monochrome), nothing at all is imported and a message says why. GR III / IIIx, where every
 *   slot is a film of its own: the other films without a usable preset, in order; too few, and nothing is imported.
 *   Fitting runs one file after another through the ordinary loadPresetFile path (options, storage and stale-run
 *   guards as for one file); the busy overlay shows "i of n" over the files dropped. A final toast counts applied and
 *   failed files and names the failed ones. One file behaves exactly as before.
 */
const hasUsablePreset = (k: SlotKey, s: State = state): boolean => { const p = slotOf(k, s)?.preset; return !!p && !p.error; };
/** Whether added slots can hold presets on the open camera (GR IV, not the Monochrome, which builds none). */
const takesExtras = (s: State = state): boolean => !!s.info && s.info.family !== 'gr3x' && s.model !== 'MONO';
/**
 * Where the files after the first go, in order (see DEC-QOL-BATCH-002): the added slots without a usable preset, or on
 * GR III / IIIx the other films without one; `from` (the first file's slot) is never one of them.
 */
export function batchTargets(from: SlotKey = state.activeSlot, s: State = state): SlotKey[] {
  const pool = takesExtras(s) ? s.extras.map((x) => x.key) : s.info?.family === 'gr3x' ? allSlotKeys(s) : [];
  return pool.filter((k) => k !== from && !hasUsablePreset(k, s));
}
export async function loadPresetFiles(files: File[], from?: SlotKey): Promise<void> {
  if (files.length === 0) return;
  const first = from ?? state.activeSlot;
  if (files.length === 1) { await loadPresetFile(first, files[0]); return; }
  if (state.busy) return;
  const rest = files.slice(1);
  const free = batchTargets(first);
  const toAdd = Math.max(0, rest.length - free.length);
  // Room check before anything changes: the whole drop goes in, or none of it.
  if (toAdd > 0) {
    if (!takesExtras()) { toast(t('batchNoSlots', { n: files.length }), 'error'); return; }
    if (state.extras.length + toAdd > MAX_EXTRA_SLOTS) { toast(t('batchNoRoom', { n: files.length, max: MAX_EXTRA_SLOTS }), 'error'); return; }
  }
  const before = new Set(state.extras.map((x) => x.key));
  for (let i = 0; i < toAdd; i++) addExtraSlot();
  const added = state.extras.map((x) => x.key).filter((k) => !before.has(k));
  const targets: SlotKey[] = [first, ...free, ...added].slice(0, files.length);
  const failed: string[] = []; let applied = 0;
  const caps = !!state.info?.capabilities.presets;
  try {
    for (let i = 0; i < files.length; i++) {
      set({ busy: t('batchProgress', { i: i + 1, n: files.length }) });
      try { await loadPresetFile(targets[i], files[i]); } catch { /* counted below */ }
      const p = slotOf(targets[i])?.preset;
      if (p && p.fileName === files[i].name && !p.error && (p.result || !caps)) applied++; else failed.push(files[i].name);
    }
  } finally { set({ busy: undefined }); }
  setActiveSlot(first);
  const parts = [t('batchDone', { n: applied })];
  if (failed.length) parts.push(t('batchFailed', { n: failed.length, names: failed.slice(0, 3).join(', ') + (failed.length > 3 ? ` +${failed.length - 3}` : '') }));
  toast(parts.join(' · '), failed.length ? 'error' : 'ok');
}
