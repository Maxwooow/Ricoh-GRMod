import { EXTRA_NAME_MAX, MAX_EXTRA_SLOTS } from '@grmod/core';
import { host } from '../host';
import { t } from '../i18n';
import { ExtraSlot, State, set, state, toast } from './core';
import { presetKey, scheduleSave } from './families';
import { extraName, normalizeLookOrder } from './looks';
import { renderIcon, runPreset } from './slots';

// ------------------------------------------------------------------ duplicate an added slot
/**
 * @decision DEC-QOL-DUPLICATE-001
 * @title Duplicating an added slot copies its fitted look and file, never re-fits, and sits right after the source
 * @status accepted
 * @rationale A user who wants a variant of an added slot (same look, another name or icon) should not
 *   have to import and fit the file again. The copy takes the source's icon (pixels copied, not shared),
 *   halation, hidden state and preset (the fitted result is immutable, so it is shared by reference; the
 *   source file is stored again under the new key, as an imported file is). It is inserted right after
 *   the source in both `extras` and the menu order. The name is the source's name with a numeric suffix
 *   (" 2", " 3", ... the first one no added slot has; a number already at the end of the name is kept
 *   unless the name without it is another slot's), the base cut so the whole stays within
 *   EXTRA_NAME_MAX and so passes validateExtraSlotName whenever the source's name did. A source whose
 *   fit is still running is refitted for the copy instead of copied half done. The limit
 *   MAX_EXTRA_SLOTS is the same as for adding (the button is disabled with the reason).
 */
/** Why an added slot cannot be duplicated now (the limit), or null. */
export function duplicateExtraProblem(s: State = state): string | null {
  return s.extras.length >= MAX_EXTRA_SLOTS ? t('extraDuplicateFull', { n: MAX_EXTRA_SLOTS }) : null;
}
/** The name for a copy of `name`: a number suffix not used by another added slot, within EXTRA_NAME_MAX. */
export function duplicateName(name: string, taken: readonly string[]): string {
  // a trailing number is only a copy's suffix when the name without it is another slot's ("Warm 2" next to "Warm"); "Warm 400" keeps its 400
  const m = /^(.*\S)\s+\d+$/.exec(name);
  const base = m && taken.includes(m[1]) ? m[1] : name;
  for (let n = 2; n < 1000; n++) {
    const suffix = ' ' + n;
    const cand = base.slice(0, Math.max(1, EXTRA_NAME_MAX - suffix.length)).trimEnd() + suffix;
    if (!taken.includes(cand)) return cand;
  }
  return base;
}
/** Make a copy of an added slot right after it. Returns the new key, or undefined at the limit / for an unknown key. */
export function duplicateExtraSlot(key: string): string | undefined {
  const src = state.extras.find((x) => x.key === key);
  if (!src) return undefined;
  const full = duplicateExtraProblem();
  if (full) { toast(full, 'info'); return undefined; }
  const newKey = 'x-' + Math.random().toString(36).slice(2, 10);
  const name = duplicateName(extraName(src), state.extras.map((x) => extraName(x)));
  const p = src.preset;
  const copy: ExtraSlot = {
    key: newKey, name,
    icon: { ...src.icon, ...(src.icon.pixels ? { pixels: new Uint8Array(src.icon.pixels) } : {}) },
    ...(src.halation ? { halation: { ...src.halation } } : {}),
    ...(p ? { preset: { ...p } } : {}),
  };
  const hidden = state.lookHidden.includes(key);
  set((s) => {
    const at = s.extras.findIndex((x) => x.key === key);
    const extras = s.extras.slice(); extras.splice(at + 1, 0, copy);
    const order = normalizeLookOrder(s.lookOrder, s.extras); order.splice(order.indexOf(key) + 1, 0, newKey);
    return { extras, lookOrder: order, lookHidden: hidden ? [...s.lookHidden, newKey] : s.lookHidden, activeSlot: newKey };
  });
  if (p && host.available) void host.storeSet(presetKey(newKey), p.text).catch(() => undefined);
  if (p?.busy) void runPreset(newKey, p.fileName, p.kind, p.text); // the source's conversion is not finished: the copy runs its own
  if (!copy.icon.pixels) void renderIcon(newKey);
  scheduleSave();
  toast(t('extraDuplicated', { name }), 'ok');
  return newKey;
}
