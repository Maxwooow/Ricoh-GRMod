import type { CameraModel, LangCode } from '@grmod/core';
import { engine, EngineError } from '../engine';
import { host } from '../host';
import { isUiLang, setUiLangPref, t, uiLangPref } from '../i18n';
import type { UiLang } from '../i18n';
import { ExtrasView, Page, State, TOUR_IDS, TourId, cameraLang, fail, isGr3, set, slotOf, state, supportedList, toast } from './core';
import { LEGACY_FW_GROUP_NAME, cancelSave, enterFamily, familyOf, fwGroupOf, fwKey, keptFirmware, leaveFamily, saveProject, scheduleSave } from './families';
import { allSlotKeys, renderIcon, runPreset } from './slots';
import { encodeWall } from './wall';
import { cancelRatioRefresh, ratiosChanged, refreshRatios } from './ratios';
import { refreshCopies } from './copies';

// ------------------------------------------------------------------ guided tours
export function startTour(id: TourId, steps: number[], replay: boolean): void {
  if (state.tour || steps.length === 0) return;
  set({ tour: { id, steps, index: 0, replay } });
}
/** One step on or back; going on from the last step ends the tour. */
export function tourStep(delta: 1 | -1): void {
  const tr = state.tour;
  if (!tr) return;
  const index = tr.index + delta;
  if (index < 0) return;
  if (index >= tr.steps.length) { endTour(); return; }
  set({ tour: { ...tr, index } });
}
/** Forget which tours were seen (and stop the one running): they start by themselves again. */
export function resetTours(): void { set({ tour: undefined, toursSeen: [] }); scheduleSave(); }
/** "Skip guides" on a guide that started by itself: it ends, and no guide starts by itself again (until resetTours). */
export function skipTours(): void {
  set({ tour: undefined, toursSeen: [...TOUR_IDS] });
  scheduleSave();
}
/** Finished or skipped: either way it is not started by itself again. */
export function endTour(): void {
  const tr = state.tour;
  if (!tr) return;
  set((s) => ({ tour: undefined, toursSeen: s.toursSeen.includes(tr.id) ? s.toursSeen : [...s.toursSeen, tr.id] }));
  scheduleSave();
}

// ------------------------------------------------------------------ settings
/** Every page is offered (the power-off pictures' is checked by `setPage`). */
export function pageOffered(_page: Page, _s: State = state): boolean {
  return true;
}
/** The custom grid (its card on the additions page): with a firmware that has it. */
export const gridOffered = (s: State = state): boolean => !!s.info?.features.customGrid;
/** The additions page: the list, or the custom grid's editor. */
export function setExtrasView(v: ExtrasView): void {
  set({ extrasView: v === 'grid' && !gridOffered() ? 'list' : v });
}

export function setPage(page: Page): void {
  if (page === 'wall' && isGr3(state.model) && state.info && !state.info.capabilities.menuPictures) return; // power-off pictures: GR III / IIIx with the End Screen menu
  if (!pageOffered(page)) return;
  set({ page, extrasView: 'list' }); scheduleSave(); if (page === 'copies') void refreshCopies();
}
export async function setAppLanguage(v: '' | UiLang): Promise<void> {
  if (v === uiLangPref()) return;
  setUiLangPref(v, false);
  try { sessionStorage.setItem('grmod.uiLangAdopted', v); } catch { /* none */ }
  cancelSave();
  if (host.available && state.ready) await saveProject();
  window.setTimeout(() => window.location.reload(), 60);
}
export function langOf(doc: { uiLang?: string }): { lang: LangCode; langAuto: boolean } {
  // The app language is kept by the page (localStorage) and in the saved work: the desktop page's storage goes with
  // its port, so a saved choice the page has lost is taken back (once: the page reloads in it).
  const saved = isUiLang(doc.uiLang) || doc.uiLang === '' ? doc.uiLang : undefined;
  if (saved !== undefined && saved !== uiLangPref()) {
    let reloadOnce = false;
    try { reloadOnce = sessionStorage.getItem('grmod.uiLangAdopted') !== saved; sessionStorage.setItem('grmod.uiLangAdopted', saved); } catch { /* no storage: no reload */ }
    if (reloadOnce) setUiLangPref(saved);
  }
  return { lang: cameraLang(), langAuto: uiLangPref() === '' };
}
export function setModel(model: CameraModel): void {
  if (state.busy || state.fwBusy || model === state.model) return;
  const differentFamily = familyOf(state.model) !== familyOf(model);
  cancelRatioRefresh();
  if (differentFamily) leaveFamily();
  const otherFile = !!state.info && !state.info.models.includes(model);
  if (otherFile) {
    void engine.reset();
    set({ info: undefined, raw: undefined, fwName: undefined,
      copyInfo: {}, copySel: [], ratios: state.ratios.map(({ preview, ...r }) => r) });
  }
  set({ model });
  if (!pageOffered(state.page)) set({ page: 'ic' });
  // The other camera's work comes back (its pictures are encoded again once read).
  if (differentFamily) enterFamily(familyOf(model));
  else for (const w of state.wall) void encodeWall(w.id);
  scheduleSave();
  // That camera's official file, when it was downloaded or opened before, opens again.
  if (otherFile || !state.info) void reopenKept(model);
}
/** The kept file being opened again in the background: a file the user opens meanwhile waits for it. */
let keptOpening: Promise<void> | null = null;
function reopenKept(model: CameraModel): Promise<void> {
  const p = (async () => {
    if (!host.available) return;
    const raw = await keptFirmware(fwGroupOf(model));
    if (!raw || state.model !== model || state.info) return;
    await openFirmware(raw, LEGACY_FW_GROUP_NAME[fwGroupOf(model)], false);
  })().catch(() => undefined);
  keptOpening = p;
  void p.finally(() => { if (keptOpening === p) keptOpening = null; });
  return p;
}

// ------------------------------------------------------------------ firmware
/** Opens a firmware file; false (with a message shown) when it is not the supported official file. */
export async function openFirmware(raw: Uint8Array, name: string, persist: boolean): Promise<boolean> {
  if (persist) while (keptOpening) await keptOpening;
  if (state.busy || state.fwBusy) return false;
  cancelRatioRefresh();
  set({ fwBusy: true });
  try {
    const info = await engine.open(raw);
    const model = info.models.includes(state.model) ? state.model : info.models[0];
    const sameFamily = familyOf(state.model) === familyOf(model);
    if (!sameFamily) leaveFamily();
    set({ info, raw, model, fwName: info.filename, fwBusy: false, copyInfo: {}, copySel: [], });
    if (!pageOffered(state.page)) set({ page: 'ic' });
    // Opening the other camera's firmware brings back that camera's work.
    if (!sameFamily) enterFamily(familyOf(model));
    if (info.family === 'gr3x') set((s) => ({ dateStamp: s.dateStamp && info.features.dateStamp, monoUnlock: s.monoUnlock && info.features.monoUnlock }));
    if (info.family === 'gr3x') ratiosChanged(true);
    if (persist) { await host.storeSet(fwKey(fwGroupOf(model)), raw); scheduleSave(); }
    for (const id of info.capabilities.presets ? allSlotKeys() : []) {
      void renderIcon(id);
      const p = slotOf(id)?.preset;
      if (p && !p.result && !p.busy) void runPreset(id, p.fileName, p.kind, p.text);
    }
    // Encoded again for every firmware: GR IV and GR III store the pictures differently (4:2:2 / 4:2:0).
    if (info.capabilities.wallpaper || info.capabilities.menuPictures) for (const w of state.wall) void encodeWall(w.id);
    void refreshRatios();
    return true;
  } catch (e) {
    set({ fwBusy: false, info: undefined, raw: undefined, fwName: undefined });
    scheduleSave();
    if (e instanceof EngineError && (e.code === 'unsupported-firmware' || e.code.startsWith('bad-') || e.code === 'too-short')) toast(t('badFirmware', { list: supportedList() }), 'error');
    else fail(e);
    return false;
  }
}
export async function loadFirmwareFile(file: File): Promise<void> {
  if (file.size < 1_000_000 || file.size > 200_000_000) { toast(t('badFirmware', { list: supportedList() }), 'error'); return; }
  await openFirmware(new Uint8Array(await file.arrayBuffer()), file.name, true);
}
/** The dialog that fetches the official firmware from Ricoh's site. */
export function setOnlineOpen(onlineOpen: boolean): void { set({ onlineOpen }); }
/** Take over a firmware file the shell downloaded; true when it is now the open firmware. */
export async function adoptFirmware(name: string, version: string, data: Uint8Array): Promise<boolean> {
  const ok = await openFirmware(data, name, true);
  if (ok) toast(t('fwDownloaded', { v: version || state.info?.version || '' }), 'ok');
  return ok;
}
