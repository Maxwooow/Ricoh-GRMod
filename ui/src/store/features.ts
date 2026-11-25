import { CAMERA_GRID, GRID_LINE_COUNT, isCameraGrid } from '@grmod/core';
import type { ClarityChange, CustomGrid, SoftFocusRequest, SoftFocusStrength } from '@grmod/core';
import { t } from '../i18n';
import { State, set, state } from './core';
import { scheduleSave } from './families';
import { hasLookLayout } from './looks';
import { framingProblem, framingValues } from '@grmod/core';

/** The framing guides have a preset of their own (store/framing.ts framingOf, without importing it here). */
const framingValuesOn = (s: State): boolean => framingProblem(s.framing) === null && framingValues(s.framing).length > 0;

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
export function setBattery(battery: boolean): void {
  if (battery && !state.info?.features.batteryPercent) return;
  set({ battery }); scheduleSave();
}
export function batteryOn(s: State = state): boolean { return !!s.battery && !!s.info?.features.batteryPercent; }
export function setCustomGrid(customGrid: boolean): void {
  if (customGrid && !state.info?.features.customGrid) return;
  set({ customGrid }); scheduleSave();
}
/** Line `index` of the 3x3 ('g3') or 4x4 ('g4') grid on or off. */
export function setGridLine(style: 'g3' | 'g4', index: number, on: boolean): void {
  if (!(Number.isInteger(index) && index >= 0 && index < GRID_LINE_COUNT)) return;
  const lines = [...state.gridLines[style]];
  lines[index] = on;
  set({ gridLines: { ...state.gridLines, [style]: lines } }); scheduleSave();
}
/** The grid lines a build gets: none when the switch is off, the firmware cannot have them, or they are the camera's own. */
export function customGridOf(s: State = state): CustomGrid | undefined {
  return s.customGrid && s.info?.features.customGrid && !s.info.features.framing && !isCameraGrid(s.gridLines) ? s.gridLines : undefined;
}
/** How many lines a style of a custom grid draws, for the summaries. */
export function gridText(g: CustomGrid, style: 'g3' | 'g4'): string {
  if (g[style].every((v, i) => v === CAMERA_GRID[style][i])) return t('gridCameraLines');
  const n = g[style].filter(Boolean).length;
  return n === 0 ? t('gridNoLines') : t('gridLinesN', { n });
}
export function setShadowLearn(shadowLearn: boolean): void {
  if (shadowLearn && !state.info?.features.shadowLearn) return;
  set({ shadowLearn }); scheduleSave();
}
export function shadowLearnOn(s: State = state): boolean { return !!s.shadowLearn && !!s.info?.features.shadowLearn; }
export function setFilmGrain(filmGrain: boolean): void {
  if (filmGrain && !state.info?.features.filmGrain) return;
  set({ filmGrain }); scheduleSave();
}
export function filmGrainOn(s: State = state): boolean { return !!s.filmGrain && !!s.info?.features.filmGrain; }
export function setFlashTtl(flashTtl: boolean): void {
  if (flashTtl && !state.info?.features.flashTtl) return;
  set({ flashTtl }); scheduleSave();
}
export function flashTtlOn(s: State = state): boolean { return !!s.flashTtl && !!s.info?.features.flashTtl; }
/**
 * "Flash enhancements": Direct Flash and, where the firmware has it (GR IV 1.20 / 1.21), flash TTL, one switch
 * in the interface. On when either is (a project saved with only one of them).
 */
export function setFlashPlus(on: boolean): void {
  const f = state.info?.features;
  if (on && !f?.directFlash && !f?.flashTtl) return;
  set({ directFlash: on && !!f?.directFlash, flashTtl: on && !!f?.flashTtl }); scheduleSave();
}
export function flashPlusOn(s: State = state): boolean { return directFlashOn(s) || flashTtlOn(s); }
export function setVideoAf(videoAf: boolean): void {
  if (videoAf && !state.info?.features.videoAf) return;
  set({ videoAf }); scheduleSave();
}
export function videoAfOn(s: State = state): boolean { return !!s.videoAf && !!s.info?.features.videoAf; }
export function setAwbLearn(awbLearn: boolean): void {
  if (awbLearn && !state.info?.features.awbLearn) return;
  set({ awbLearn }); scheduleSave();
}
export function awbLearnOn(s: State = state): boolean { return !!s.awbLearn && !!s.info?.features.awbLearn; }
export function setMovieExposure(movieExposure: boolean): void {
  if (movieExposure && !state.info?.features.movieExposure) return;
  set({ movieExposure }); scheduleSave();
}
export function movieExposureOn(s: State = state): boolean { return !!s.movieExposure && !!s.info?.features.movieExposure; }
export function setConstantLight(constantLight: boolean): void {
  if (constantLight && !state.info?.features.constantLight) return;
  set({ constantLight }); scheduleSave();
}
export function constantLightOn(s: State = state): boolean { return !!s.constantLight && !!s.info?.features.constantLight; }
export function setSensorShift(sensorShift: boolean): void {
  if (sensorShift && !state.info?.features.sensorShift) return;
  set({ sensorShift }); scheduleSave();
}
export function sensorShiftOn(s: State = state): boolean { return !!s.sensorShift && !!s.info?.features.sensorShift; }
export function setMovie4k(movie4k: boolean): void {
  if (movie4k && !state.info?.features.movie4k) return;
  set({ movie4k }); scheduleSave();
}
export function movie4kOn(s: State = state): boolean { return !!s.movie4k && !!s.info?.features.movie4k; }
export function setMovieSr(movieSr: boolean): void {
  if (movieSr && !state.info?.features.movieSr) return;
  set({ movieSr }); scheduleSave();
}
export function movieSrOn(s: State = state): boolean { return !!s.movieSr && !!s.info?.features.movieSr; }
/** Distances in feet (Snap Focus Distance, the manual focus scale) instead of metres. */
export function setDistanceFeet(distanceFeet: boolean): void {
  if (distanceFeet && !state.info?.features.distanceFeet) return;
  set({ distanceFeet }); scheduleSave();
}
export function distanceFeetOn(s: State = state): boolean { return !!s.distanceFeet && !!s.info?.features.distanceFeet; }
/** ADJ lever slots (5..8): the camera's five unless the firmware can have more. */
export function setAdjSlots(adjSlots: number): void {
  if (!(Number.isInteger(adjSlots) && adjSlots >= 5 && adjSlots <= (state.info?.features.maxAdjSlots ?? 5))) return;
  set({ adjSlots }); scheduleSave();
}
/** The ADJ lever slots the build gets (5: none added). */
export function adjSlotsOf(s: State = state): number { const max = s.info?.features.maxAdjSlots ?? 5; return s.adjSlots > 5 && s.adjSlots <= max ? s.adjSlots : 5; }
/** Any addition that is not a slot or a ratio. */
export function extrasOn(s: State = state): boolean { return !!brightAutoOf(s) || exposurePreviewOn(s) || filmGrainOn(s) || flashTtlOn(s) || videoAfOn(s) || awbLearnOn(s) || movieExposureOn(s) || sensorShiftOn(s) || movie4kOn(s) || movieSrOn(s) || distanceFeetOn(s) || constantLightOn(s) || softOn(s) || !!s.dateStamp || monoUnlockOn(s) || hasLookLayout(s) || directFlashOn(s) || adjSlotsOf(s) > 5 || hdrOn(s) || batteryOn(s) || (!!customGridOf(s) || (!!s.customGrid && !!s.info?.features.framing && framingValuesOn(s))) || shadowLearnOn(s); }
const MINUS = '\u2212';
const strengthLabel = (st: SoftFocusStrength | 'custom'): string => t(st === 'weak' ? 'softWeak' : st === 'medium' ? 'softMedium' : st === 'strong' ? 'softStrong' : 'softCustom');
/** "−2 weak / −3 medium" (−1 first), for confirmations and the copies page. */
export function softText(list: readonly (SoftFocusRequest | ClarityChange)[]): string {
  return [...list].sort((a, b) => b.level - a.level).map((f) => `${f.level < 0 ? MINUS : '+'}${Math.abs(f.level)} ${strengthLabel(f.strength)}`).join(' / ');
}
