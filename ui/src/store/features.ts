import type { ClarityChange, SoftFocusRequest, SoftFocusStrength } from '@grmod/core';
import { t } from '../i18n';
import { State, set, state } from './core';
import { scheduleSave } from './families';
import { hasLookLayout } from './looks';

// ------------------------------------------------------------------ soft focus
/**
 * The soft focus switch: on, the firmware gets soft focus as a function of the ADJ lever (off /
 * weak / medium / strong, fixed strengths). The clarity table stays official. (GR Mod 0.4.x put
 * fixed strengths on clarity -2 / -3 / -4 instead; such files are still recognised, see `softText`.)
 */
export function setSoft(soft: boolean): void { set({ soft }); scheduleSave(); }
export function softOn(s: State = state): boolean { return !!s.soft; }

// ------------------------------------------------------------------ date imprint, monochrome looks
/** Date imprint: the firmware gets the imprint and its menu (Shooting Assist > Date Imprint); it starts off. */
export function setDateStamp(dateStamp: boolean): void {
  if (dateStamp && !state.info?.features.dateStamp) return;
  set({ dateStamp }); scheduleSave();
}
/** The six looks of the GR IV Monochrome on a colour GR IV. Nothing to unlock on the Monochrome. */
export function setMonoUnlock(monoUnlock: boolean): void {
  if (monoUnlock && !state.info?.features.monoUnlock) return;
  set({ monoUnlock }); scheduleSave();
}
export function monoUnlockOn(s: State = state): boolean { return !!s.monoUnlock && s.model !== 'MONO' && !!s.info?.features.monoUnlock; }
export const GR3X_SOFT_FOCUS: readonly SoftFocusRequest[] = [
  { level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' },
];
export function setDirectFlash(directFlash: boolean): void {
  if (directFlash && !state.info?.features.directFlash) return;
  set({ directFlash }); scheduleSave();
}
export function directFlashOn(s: State = state): boolean { return !!s.directFlash && !!s.info?.features.directFlash; }
export function setBrightAuto(brightAuto: State['brightAuto']): void {
  if (brightAuto && !state.info?.features.brightAuto) return;
  set({ brightAuto }); scheduleSave();
}
export function brightAutoOf(s: State = state): State['brightAuto'] { return s.info?.features.brightAuto ? s.brightAuto : false; }
export function setHdr(hdr: boolean): void {
  if (hdr && !state.info?.features.hdrGainMap) return;
  set({ hdr }); scheduleSave();
}
export function hdrOn(s: State = state): boolean { return !!s.hdr && !!s.info?.features.hdrGainMap; }
export function setExposurePreview(exposurePreview: boolean): void {
  if (exposurePreview && !state.info?.features.exposurePreview) return;
  set({ exposurePreview }); scheduleSave();
}
export function exposurePreviewOn(s: State = state): boolean { return !!s.exposurePreview && !!s.info?.features.exposurePreview; }
export function setShadowLearn(shadowLearn: boolean): void {
  if (shadowLearn && !state.info?.features.shadowLearn) return;
  set({ shadowLearn }); scheduleSave();
}
export function shadowLearnOn(s: State = state): boolean { return !!s.shadowLearn && !!s.info?.features.shadowLearn; }
/** ADJ lever slots (5..8): the camera's five unless the firmware can have more. */
export function setAdjSlots(adjSlots: number): void {
  if (!(Number.isInteger(adjSlots) && adjSlots >= 5 && adjSlots <= (state.info?.features.maxAdjSlots ?? 5))) return;
  set({ adjSlots }); scheduleSave();
}
/** The ADJ lever slots the build gets (5: none added). */
export function adjSlotsOf(s: State = state): number { const max = s.info?.features.maxAdjSlots ?? 5; return s.adjSlots > 5 && s.adjSlots <= max ? s.adjSlots : 5; }
/** Any addition that is not a slot or a ratio. */
export function extrasOn(s: State = state): boolean { return !!brightAutoOf(s) || exposurePreviewOn(s) || shadowLearnOn(s) || softOn(s) || !!s.dateStamp || monoUnlockOn(s) || hasLookLayout(s) || directFlashOn(s) || adjSlotsOf(s) > 5 || hdrOn(s); }
const MINUS = '\u2212';
const strengthLabel = (st: SoftFocusStrength | 'custom'): string => t(st === 'weak' ? 'softWeak' : st === 'medium' ? 'softMedium' : st === 'strong' ? 'softStrong' : 'softCustom');
/** "−2 weak / −3 medium" (−1 first), for confirmations and the copies page. */
export function softText(list: readonly (SoftFocusRequest | ClarityChange)[]): string {
  return [...list].sort((a, b) => b.level - a.level).map((f) => `${f.level < 0 ? MINUS : '+'}${Math.abs(f.level)} ${strengthLabel(f.strength)}`).join(' / ');
}
