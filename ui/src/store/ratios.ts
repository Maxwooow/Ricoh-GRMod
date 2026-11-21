import { GR3X_MAX_CUSTOM_RATIOS, MAX_CUSTOM_RATIOS, validateGr3xRatioName, validateRatioName } from '@grmod/core';
import type { RatioPreview, RatioSpec, SlotId } from '@grmod/core';
import { engine } from '../engine';
import { host } from '../host';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { RatioItem, ShadeTone, State, emptySlot, filmCountChoosable, isGr3, set, state, toast } from './core';
import { presetKey, scheduleSave } from './families';

// ------------------------------------------------------------------ added aspect ratios
const RATIO_PROBLEMS: Record<NonNullable<RatioPreview['problem']>, Key> = {
  'bad-ratio': 'ratioBad', 'ratio-factory': 'ratioIsFactory', 'ratio-portrait': 'ratioPortrait', 'ratio-too-extreme': 'ratioExtreme', 'ratio-quick-view': 'ratioQuick',
  'ratio-metering': 'ratioMetering', 'ratio-conflict': 'ratioConflict', 'ratio-duplicate': 'ratioDup',
};
const NAME_PROBLEMS: Record<string, Key> = { 'too-long': 'ratioNameLong', 'bad-char': 'ratioNameBad', empty: 'ratioNameBad' };
/** How many ratios the open firmware takes. */
export const maxRatios = (s: State = state): number => (s.info?.family === 'gr3x' || (!s.info && isGr3(s.model)) ? GR3X_MAX_CUSTOM_RATIOS : MAX_CUSTOM_RATIOS);
/** Why a row cannot be built (shown in the row), or null. A row without a ratio is simply not built. */
export function ratioProblem(r: RatioItem): string | null {
  if (!r.ratio.trim()) return null;
  if (r.preview?.problem) return t(RATIO_PROBLEMS[r.preview.problem]);
  const n = r.name.trim() ? (state.info?.family === 'gr3x' ? validateGr3xRatioName(r.name.trim()) : validateRatioName(r.name.trim())) : null;
  return n ? t(NAME_PROBLEMS[n]) : null;
}
/** The menu name a row gets: what was typed, else the ratio as written on its icon. */
export const ratioName = (r: RatioItem): string => r.name.trim() || r.preview?.label || r.ratio.trim();
/** The rows that will be built into the firmware, in menu order. */
export function ratioSpecs(s: State = state): RatioSpec[] {
  return s.ratios.filter((r) => r.ratio.trim() && r.preview && !ratioProblem(r)).map((r) => ({ name: ratioName(r), ratio: r.ratio.trim() }));
}
/** True while a filled row is wrong or still being looked at: nothing is written then. */
export function hasRatioErrors(s: State = state): boolean {
  return s.ratios.some((r) => r.ratio.trim() && (!r.preview || !!ratioProblem(r)));
}
let ratioGen = 0;
let ratioTimer: ReturnType<typeof setTimeout> | undefined;
/** Drops a ratio preview that is still waiting or under way (its answer is then ignored). */
export function cancelRatioRefresh(): void { ++ratioGen; clearTimeout(ratioTimer); }
/** Work out every row again: whether a row is acceptable depends on the rows before it. */
export async function refreshRatios(): Promise<void> {
  const gen = ++ratioGen;
  if (!state.info) return;
  const rows = state.ratios.map((r) => ({ id: r.id, ratio: r.ratio.trim() }));
  const good: string[] = []; const previews = new Map<string, RatioPreview | undefined>();
  for (const r of rows) {
    if (!r.ratio) { previews.set(r.id, undefined); continue; }
    let p: RatioPreview;
    try { p = await engine.ratio(r.ratio, good); } catch { p = { problem: 'bad-ratio' }; }
    if (gen !== ratioGen) return;
    previews.set(r.id, p);
    if (!p.problem) good.push(r.ratio);
  }
  set((s) => ({ ratios: s.ratios.map((r) => (previews.has(r.id) && r.ratio.trim() === rows.find((x) => x.id === r.id)?.ratio ? { ...r, preview: previews.get(r.id) } : r)) }));
}
export function ratiosChanged(now = false): void {
  scheduleSave();
  clearTimeout(ratioTimer);
  if (now) void refreshRatios(); else ratioTimer = setTimeout(() => { void refreshRatios(); }, 160);
}
export function addRatio(ratio = ''): void {
  if (state.ratios.length >= maxRatios()) { toast(t('ratioMax', { n: maxRatios() }), 'info'); return; }
  const empty = state.ratios.find((r) => !r.ratio.trim() && !r.name.trim());
  if (empty && !ratio) { set({ activeRatio: empty.id }); return; }
  const id = Math.random().toString(36).slice(2, 10);
  set((s) => ({ ratios: empty ? s.ratios.map((r) => (r.id === empty.id ? { ...r, ratio } : r)) : [...s.ratios, { id, ratio, name: '' }], activeRatio: empty ? empty.id : id }));
  ratiosChanged(true);
}
export function setRatio(id: string, patch: { ratio?: string; name?: string }): void {
  set((s) => ({ ratios: s.ratios.map((r) => (r.id === id ? { ...r, ...patch, preview: patch.ratio !== undefined && patch.ratio.trim() !== r.ratio.trim() ? undefined : r.preview } : r)), activeRatio: id }));
  if (patch.ratio !== undefined) ratiosChanged(); else scheduleSave();
}
export function removeRatio(id: string): void {
  set((s) => { const ratios = s.ratios.filter((r) => r.id !== id); return { ratios, activeRatio: s.activeRatio === id ? ratios[0]?.id : s.activeRatio }; });
  ratiosChanged(true);
}
/** GR III / IIIx: how many films (1..maxFilms); the active slot stays among them. */
export function setFilmCount(n: number): void {
  const max = state.info?.features.maxFilms ?? 9;
  const want = Math.max(0, Math.min(max, Math.round(n)));
  set((s) => {
    const ids = (s.info?.slots ?? []).slice(0, want).map((x) => x.id);
    return { filmCount: want, activeSlot: ids.includes(s.activeSlot as SlotId) ? s.activeSlot : (ids[Math.max(0, want - 1)] ?? 'CY') };
  });
  scheduleSave();
}
/**
 * GR III / IIIx: take one film away, as GR IV's added slots: the films after it move up one place
 * (preset, names, icon, halation, their place in the menu order and hidden list), and the count
 * drops by one. Not while a preset of a moving film is still being converted.
 */
export function removeFilm(id: SlotId): void {
  if (!filmCountChoosable()) return;
  const ids = (state.info?.slots ?? []).map((x) => x.id);
  const n = state.filmCount;
  const k = ids.indexOf(id);
  if (k < 0 || k >= n) return;
  if (ids.slice(k, n).some((x) => state.slots[x].preset?.busy)) { toast(t('converting'), 'info'); return; }
  const look = (key: string): string | null => {
    const f = key.startsWith('g') ? Number(key.slice(1)) - 64 : -1;
    if (!(f >= 0 && f < n)) return key;
    return f === k ? null : f > k ? `g${64 + f - 1}` : key;
  };
  set((s) => {
    const slots = { ...s.slots };
    for (let i = k; i < n - 1; i++) slots[ids[i]] = s.slots[ids[i + 1]];
    slots[ids[n - 1]] = emptySlot();
    const a = ids.indexOf(s.activeSlot as SlotId);
    const activeSlot = a < 0 || a < k ? s.activeSlot : a > k ? ids[a - 1] : (ids[Math.min(k, n - 2)] ?? 'CY');
    return {
      slots, filmCount: n - 1, activeSlot,
      lookOrder3: s.lookOrder3.map(look).filter((x): x is string => x !== null),
      lookHidden3: s.lookHidden3.map(look).filter((x): x is string => x !== null),
    };
  });
  scheduleSave();
  // The preset files kept for the films move with them.
  if (host.available) {
    void (async () => {
      for (let i = k; i < n - 1; i++) {
        const text = await host.storeGet(presetKey(ids[i + 1])).catch(() => null);
        if (text) await host.storeSet(presetKey(ids[i]), text).catch(() => undefined);
        else await host.storeDel(presetKey(ids[i])).catch(() => undefined);
      }
      await host.storeDel(presetKey(ids[n - 1])).catch(() => undefined);
    })();
  }
}
export function setActiveRatio(id: string): void { if (state.activeRatio !== id) set({ activeRatio: id }); }

// ------------------------------------------------------------------ live-view shade (GR IV)
export function setRatioShade(ratioShade: boolean): void {
  if (ratioShade && !state.info?.features.ratioShade) return;
  set({ ratioShade }); scheduleSave();
}
/** The live view's one choice: the photo area only ('100'), or the whole frame with the outside darkened ('50' / '25'). */
export type LiveView = '100' | '50' | '25';
export function liveViewOf(s: State = state): LiveView { return !s.ratioShade ? '100' : s.ratioShadeTone === 'light' ? '25' : '50'; }
export function setLiveView(v: LiveView): void {
  if (v === '100') { setRatioShade(false); return; }
  if (!state.info?.features.ratioShade) return;
  set({ ratioShade: true, ratioShadeTone: v === '25' ? 'light' : 'dark' }); scheduleSave();
}
/** How dark the outside of the photo is, for the summaries; GR IV 1.20 / 1.21: chosen in the camera. */
export function toneLabel(tone: ShadeTone, s: State = state): string { return s.info?.features.shadeMenu ? t('shadeInCamera') : tone === 'light' ? '25%' : '50%'; }
/**
 * The live-view shade goes into a build: chosen (GR IV 1.20 / 1.21: always, how dark is chosen in the camera),
 * offered by the open firmware, and there is an added ratio.
 */
export function ratioShadeOn(s: State = state, ratios = ratioSpecs(s)): boolean { return (!!s.ratioShade || !!s.info?.features.shadeMenu) && !!s.info?.features.ratioShade && ratios.length > 0; }
/** GR IV 1.20 / 1.21: the shade level the ratio page previews (the camera's own choice is made in its menu; 75 % by default). */
export type ShadePreview = '100' | '75' | '50' | '25' | '0';
export function setShadePreview(shadePreview: ShadePreview): void { set({ shadePreview }); }
