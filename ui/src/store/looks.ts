import { FACTORY_LOOK_IDS, GR3X_FILM_IDS, validateExtraSlotName } from '@grmod/core';
import type { ExtraSlotSpec, LookLayout } from '@grmod/core';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { ExtraSlot, State, filmCountChoosable, isGr3, set, state, toast } from './core';
import { scheduleSave } from './families';

// ------------------------------------------------------------------ Image Control menu order / hidden looks
/** A look's name in Chinese and English and in the camera's texts of the other interface languages. */
type LookNames = { zh: string; en: string } & Partial<Record<'zh-TW' | 'ja' | 'ko' | 'es' | 'de', string>>;
/** The name in the camera language `lang` (zh-CN: the Chinese one), else English. */
const lookNameIn = (x: LookNames, lang: string): string => (lang === 'zh-CN' ? x.zh : (x as Record<string, string>)[lang] || x.en);
/** The factory looks' names: the camera's own texts in each interface language (Chinese and English as before). */
const FACTORY_LOOK_NAMES: Record<number, LookNames> = {
  11: { zh: '标准', en: 'Standard', 'zh-TW': '標準', ja: 'スタンダード', ko: '표준', es: 'Estándar', de: 'Standard' },
  12: { zh: '鲜艳', en: 'Vivid', 'zh-TW': '鮮艷', ja: 'ビビッド', ko: '비비드', es: 'Intenso', de: 'Klar' },
  13: { zh: '单色', en: 'Monotone', 'zh-TW': '單色', ja: 'モノトーン', ko: '모노톤', es: 'Monótono', de: 'Monoton' },
  14: { zh: '软单色', en: 'Soft Monotone', 'zh-TW': '軟單色', ja: 'ソフトモノトーン', ko: '소프트 모노톤', es: 'Monótono suave', de: 'Weich monoton' },
  15: { zh: '硬单色', en: 'Hard Monotone', 'zh-TW': '硬單色', ja: 'ハードモノトーン', ko: '하드 모노톤', es: 'Monótono fuerte', de: 'Hart monoton' },
  16: { zh: '高对比度黑白', en: 'Hi-Contrast B&W', 'zh-TW': '高對比度黑白', ja: 'ハイコントラスト白黒', ko: '하이 콘트라스트 흑백', es: 'B&N alto contraste', de: 'Hochkontr. S/W' },
  17: { zh: '正片', en: 'Positive Film', 'zh-TW': '正片', ja: 'ポジフィルム調', ko: '포지티브 필름', es: 'Película positiva', de: 'Positivfilm' },
  18: { zh: '电影（黄色）', en: 'Cinema (Yellow)', 'zh-TW': '電影(黃色)', ja: 'シネマ調(イエロー)', ko: '시네마톤 (옐로)', es: 'Cine (amarillo)', de: 'Kino (gelb)' },
  19: { zh: '电影（绿色）', en: 'Cinema (Green)', 'zh-TW': '電影(綠色)', ja: 'シネマ調(グリーン)', ko: '시네마톤 (그린)', es: 'Cine (verde)', de: 'Kino (grün)' },
  20: { zh: '留银冲洗', en: 'Bleach Bypass', 'zh-TW': '跳漂白', ja: 'ブリーチバイパス', ko: '블리치 바이패스', es: 'Desaturación color', de: 'Bleach Bypass' },
  21: { zh: '怀旧', en: 'Retro', 'zh-TW': '懷舊', ja: 'レトロ', ko: '복고풍', es: 'Retro', de: 'Retro' },
  22: { zh: 'HDR 色调', en: 'HDR Tone', 'zh-TW': 'HDR色調', ja: 'HDR調', ko: 'HDR톤', es: 'Tono HDR', de: 'HDR-Farbton' },
  23: { zh: '正负逆冲', en: 'Cross Processing', 'zh-TW': '正負逆沖', ja: 'クロスプロセス', ko: '크로스 프로세스', es: 'Proceso cruzado', de: 'Crossentwicklung' },
  24: { zh: '负片', en: 'Negative Film', 'zh-TW': '底片', ja: 'ネガフィルム調', ko: '네거티브 필름', es: 'Película negativa', de: 'Negativfilm' },
  25: { zh: '标准（单色）', en: 'Standard (mono)', 'zh-TW': '標準（單色）', ja: 'スタンダード(モノクロ)', ko: '표준 (흑백)', es: 'Estándar (mono)', de: 'Standard (mono)' },
  26: { zh: '柔和（单色）', en: 'Soft (mono)', 'zh-TW': '柔和（單色）', ja: 'ソフト(モノクロ)', ko: '소프트 (흑백)', es: 'Contraste suave (mono)', de: 'Weichzeichnung (mono)' },
  27: { zh: '高对比度（单色）', en: 'High Contrast (mono)', 'zh-TW': '高對比度（單色）', ja: 'ハイコントラスト(モノクロ)', ko: '하이 콘트라스트 (흑백)', es: 'Alto contraste (mono)', de: 'Hoher Kontrast (mono)' },
  28: { zh: '颗粒感（单色）', en: 'Grainy (mono)', 'zh-TW': '顆粒感（單色）', ja: 'グレイニー(モノクロ)', ko: '그레이니 (흑백)', es: 'Granuloso (mono)', de: 'Körnig (mono)' },
  29: { zh: '无颗粒感（单色）', en: 'Solid (mono)', 'zh-TW': '無顆粒感（單色）', ja: 'ソリッド(モノクロ)', ko: '솔리드 (흑백)', es: 'Liso (mono)', de: 'Einfarbig (mono)' },
  30: { zh: 'HDR 色调（单色）', en: 'HDR Tone (mono)', 'zh-TW': 'HDR色調（單色）', ja: 'HDR調(モノクロ)', ko: 'HDR톤 (흑백)', es: 'Tono HDR (mono)', de: 'HDR-Farbton (mono)' },
  31: { zh: '画意摄影效果', en: 'Pictorialist Effect', 'zh-TW': '畫意攝影效果', ja: 'ピクトリアリズム調', ko: '픽토리얼리즘톤', es: 'Efecto ilustración', de: 'Malereffekt' },
  32: { zh: '中途曝光效果', en: 'Solarized Effect', 'zh-TW': '中途曝光效果', ja: 'ソラリゼーション調', ko: '솔라리제이션톤', es: 'Efecto solarizado', de: 'Solarisationseffekt' },
  // Firmware 1.20 (the camera's texts): Pictorialist is offered on no model (not listed, see
  // UNRELEASED_LOOKS), Solarized on the Monochrome (and with the B&W looks unlocked).
};
/** GR III / IIIx (round 8): its twelve looks in the camera's menu order, their numbers and names (the camera's texts). */
const GR3_LOOK_IDS: readonly number[] = [11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21];
const GR3_LOOK_NAMES: Record<number, LookNames> = {
  11: { zh: '标准', en: 'Standard', 'zh-TW': '標準', ja: 'スタンダード', ko: '표준', es: 'Estándar', de: 'Standard' },
  12: { zh: '鲜艳', en: 'Vivid', 'zh-TW': '鮮艷', ja: 'ビビッド', ko: '비비드', es: 'Intenso', de: 'Klar' },
  13: { zh: '单色', en: 'Monotone', 'zh-TW': '單色', ja: 'モノトーン', ko: '모노톤', es: 'Monótono', de: 'Monoton' },
  14: { zh: '软单色', en: 'Soft Monotone', 'zh-TW': '軟單色', ja: 'ソフトモノトーン', ko: '소프트 모노톤', es: 'Monótono suave', de: 'Weich monoton' },
  15: { zh: '硬单色', en: 'Hard Monotone', 'zh-TW': '硬單色', ja: 'ハードモノトーン', ko: '하드 모노톤', es: 'Monótono fuerte', de: 'Hart monoton' },
  16: { zh: '高对比度黑白', en: 'Hi-Contrast B&W', 'zh-TW': '高對比度黑白', ja: 'ハイコントラスト白黒', ko: '하이 콘트라스트 흑백', es: 'B&N alto contraste', de: 'Hochkontr. S/W' },
  17: { zh: '正片', en: 'Positive Film', 'zh-TW': '正片', ja: 'ポジフィルム調', ko: '포지티브 필름', es: 'Película positiva', de: 'Positivfilm' },
  18: { zh: '留银冲洗', en: 'Bleach Bypass', 'zh-TW': '跳漂白', ja: 'ブリーチバイパス', ko: '블리치 바이패스', es: 'Desaturación color', de: 'Bleach Bypass' },
  19: { zh: '怀旧', en: 'Retro', 'zh-TW': '懷舊', ja: 'レトロ', ko: '복고풍', es: 'Retro', de: 'Retro' },
  20: { zh: 'HDR 色调', en: 'HDR Tone', 'zh-TW': 'HDR色調', ja: 'HDR調', ko: 'HDR톤', es: 'Tono HDR', de: 'HDR-Farbton' },
  21: { zh: '正负逆冲', en: 'Cross Processing', 'zh-TW': '正負逆沖', ja: 'クロスプロセス', ko: '크로스 프로세스', es: 'Proceso cruzado', de: 'Crossentwicklung' },
  22: { zh: '负片', en: 'Negative Film', 'zh-TW': '底片', ja: 'ネガフィルム調', ko: '네거티브 필름', es: 'Película negativa', de: 'Negativfilm' },
};
const factoryLookKey = (id: number): string => `f${id}`;
/** GR III's keys: g<look> for its own looks and its films (64..). */
const gr3LookKey = (id: number): string => `g${id}`;
/** Standard and the monochrome looks' Standard: what the camera falls back to for a hidden look that is selected (see guard.ts). */
export const KEEP_VISIBLE = ['f11', 'f25', 'g11'];
/** Added slots are not built on the Monochrome camera (it has no colour looks), so they are not in the order either. */
function lookExtras(s: State): ExtraSlot[] { return s.model === 'MONO' ? [] : s.extras; }
/** The order and hidden looks of the open camera family: GR III / IIIx keeps its own. */
const gr3Order = (s: State): boolean => (s.info ? s.info.family === 'gr3x' : isGr3(s.model));
/** GR III: the films of the build (looks 64..), when they are built. */
function gr3Films(s: State): number { return filmCountChoosable(s) ? s.filmCount : 0; }
/** The menu order can be set: GR IV, and GR III / IIIx (round 8). */
export function lookOrderAvailable(s: State = state): boolean {
  return !gr3Order(s) || (s.info?.family === 'gr3x' && s.info.capabilities.lookLayout === true);
}
/** Every key the order can contain, in the camera's order: GR IV's 20 looks and the added slots; GR III's twelve and its films. */
export function lookKeys(s: State = state): string[] {
  if (gr3Order(s)) return [...GR3_LOOK_IDS.map(gr3LookKey), ...Array.from({ length: gr3Films(s) }, (_, k) => gr3LookKey(64 + k))];
  return [...listedFactoryLooks(s).map(factoryLookKey), ...lookExtras(s).map((x) => x.key)];
}
/**
 * Looks in the firmware's order table that no camera shows: 1.20's 31 (Pictorialist) is not
 * offered on any model, not even the Monochrome, and the B&W unlock leaves it so. It is not listed
 * (it could only be moved or hidden without anything changing on the camera); builds keep it in
 * the order table just before 32, where the official firmware has it.
 */
const UNRELEASED_LOOKS: readonly number[] = [31];
function listedFactoryLooks(s: State = state): number[] { return factoryLooks(s).filter((n) => !UNRELEASED_LOOKS.includes(n)); }
/** The style order to build from the listed keys: the unlisted looks go back where the firmware has them. */
function withUnlisted(styles: number[], s: State): number[] {
  const out = [...styles];
  const official = factoryLooks(s);
  for (const n of UNRELEASED_LOOKS) {
    const i = official.indexOf(n);
    if (i < 0 || out.includes(n)) continue;
    const next = official.slice(i + 1).find((m) => out.includes(m));
    out.splice(next === undefined ? out.length : out.indexOf(next), 0, n);
  }
  return out;
}
/** GR IV's looks: the open firmware's (1.20 adds 31 and 32), 1.11's while none is open. */
function factoryLooks(s: State = state): readonly number[] { return s.info?.looks?.factory ?? FACTORY_LOOK_IDS; }
/** The style number the firmware uses for a key (GR IV 11..30, or 34.. for added slots; GR III 11..22, films 64..). */
export function lookStyleOf(key: string, s: State = state): number | null {
  if (key.startsWith('g')) { const n = Number(key.slice(1)); return gr3Order(s) && lookKeys(s).includes(key) ? n : null; }
  if (key.startsWith('f')) { const n = Number(key.slice(1)); return factoryLooks(s).includes(n) ? n : null; }
  const i = lookExtras(s).findIndex((x) => x.key === key);
  return i < 0 ? null : (s.info?.looks?.extraFirst ?? 34) + i;
}
/** Only on the GR IV Monochrome (its six black-and-white looks). */
export function lookMonoOnly(key: string, s: State = state): boolean {
  const n = lookStyleOf(key, s);
  return !gr3Order(s) && n !== null && (s.info?.looks?.monoOnly ?? [25, 26, 27, 28, 29, 30]).includes(n);
}
/** A display name for the UI: the camera's Chinese/English name, or an added slot's / a film's name. */
export function lookName(key: string, s: State = state): string {
  if (key.startsWith('g')) {
    const n = Number(key.slice(1));
    if (n >= 64) {
      const id = GR3X_FILM_IDS[n - 64];
      const slot = s.info?.slots.find((x) => x.id === id);
      return (id && s.slots[id]?.names[s.lang]) || slot?.defaultName || `GR Mod ${n - 63}`;
    }
    const x = GR3_LOOK_NAMES[n]; if (x) return lookNameIn(x, s.lang);
    return key;
  }
  if (key.startsWith('f')) {
    const n = Number(key.slice(1));
    // Cinema Yellow / Green carry the name given to their slot (e.g. a preset's), when there is one.
    const own = n === 18 ? s.slots.CY.names[s.lang] : n === 19 ? s.slots.CG.names[s.lang] : undefined;
    if (own) return own;
    const x = FACTORY_LOOK_NAMES[n]; if (x) return lookNameIn(x, s.lang);
  }
  const x = lookExtras(s).find((e) => e.key === key);
  return x ? extraName(x, s) : key;
}
/** Keep a saved order valid for the keys there are: drop unknown keys, append the missing ones in the camera's order. */
function normalizeOrder(order: readonly string[], keys: readonly string[]): string[] {
  const valid = new Set(keys);
  const out: string[] = [];
  for (const k of order) if (typeof k === 'string' && valid.has(k) && !out.includes(k)) out.push(k);
  for (const k of keys) if (!out.includes(k)) out.push(k);
  return out;
}
function normalizeHidden(hidden: readonly string[], keys: readonly string[]): string[] {
  const valid = new Set(keys);
  return [...new Set(hidden.filter((k) => typeof k === 'string' && valid.has(k) && !KEEP_VISIBLE.includes(k)))];
}
/** GR IV's order for the current extras (projects keep it as saved; see `lookOrderNow`). */
export function normalizeLookOrder(order: readonly string[], extras: readonly ExtraSlot[]): string[] {
  return normalizeOrder(order, [...listedFactoryLooks().map(factoryLookKey), ...extras.map((x) => x.key)]);
}
export function normalizeLookHidden(hidden: readonly string[], extras: readonly ExtraSlot[]): string[] {
  return normalizeHidden(hidden, [...listedFactoryLooks().map(factoryLookKey), ...extras.map((x) => x.key)]);
}
/** GR III's saved order and hidden keys (kept apart from GR IV's), checked like GR IV's when a project opens. */
export function gr3SavedKeys(list: unknown): string[] {
  return (Array.isArray(list) ? list : []).filter((k): k is string => typeof k === 'string' && /^g(1[1-9]|2[0-2]|6[4-9]|7\d|8[0-3])$/.test(k));
}
export function lookOrderNow(s: State = state): string[] { return normalizeOrder(gr3Order(s) ? s.lookOrder3 : s.lookOrder, lookKeys(s)); }
export function lookHiddenNow(s: State = state): string[] { return normalizeHidden(gr3Order(s) ? s.lookHidden3 : s.lookHidden, lookKeys(s)); }
/** The layout to build, or undefined when it is the camera's order with nothing hidden. */
export function lookLayoutSpec(s: State = state): LookLayout | undefined {
  if (!lookOrderAvailable(s)) return undefined;
  const order = lookOrderNow(s);
  const hidden = lookHiddenNow(s);
  const factory = lookKeys(s);
  if (hidden.length === 0 && order.every((k, i) => k === factory[i])) return undefined;
  const styles = order.map((k) => lookStyleOf(k, s)!);
  return { order: gr3Order(s) ? styles : withUnlisted(styles, s), hidden: hidden.map((k) => lookStyleOf(k, s)!) };
}
export function hasLookLayout(s: State = state): boolean { return !!lookLayoutSpec(s); }
/** Put the family's order / hidden keys. */
function orderPatch(s: State, patch: { order?: string[]; hidden?: string[] }): Partial<State> {
  if (gr3Order(s)) return { ...(patch.order ? { lookOrder3: patch.order } : {}), ...(patch.hidden ? { lookHidden3: patch.hidden } : {}) };
  return { ...(patch.order ? { lookOrder: patch.order } : {}), ...(patch.hidden ? { lookHidden: patch.hidden } : {}) };
}
export function moveLookTo(key: string, toIndex: number): void {
  set((s) => {
    const order = lookOrderNow(s);
    const from = order.indexOf(key);
    if (from < 0) return orderPatch(s, { order });
    const to = Math.max(0, Math.min(order.length - 1, toIndex));
    if (from === to) return orderPatch(s, { order });
    order.splice(from, 1);
    order.splice(to, 0, key);
    return orderPatch(s, { order });
  });
  scheduleSave();
}
export function moveLook(key: string, delta: number): void {
  set((s) => {
    const order = lookOrderNow(s);
    const from = order.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return orderPatch(s, { order });
    order.splice(from, 1);
    order.splice(to, 0, key);
    return orderPatch(s, { order });
  });
  scheduleSave();
}
export function setLookHidden(key: string, hidden: boolean): void {
  if (KEEP_VISIBLE.includes(key)) { toast(t(gr3Order(state) ? 'lookOrderKeepStandardGr3' : 'lookOrderKeepStandard'), 'info'); return; }
  set((s) => {
    const list = lookHiddenNow(s).filter((k) => k !== key);
    if (hidden) list.push(key);
    return orderPatch(s, { hidden: list });
  });
  scheduleSave();
}
export function resetLookLayout(): void {
  set((s) => orderPatch(s, { order: lookKeys(s), hidden: [] }));
  scheduleSave();
}
/** The name an added slot gets in the camera: what was typed, else `GR Mod <place>`. */
export function extraName(x: ExtraSlot, s: State = state): string {
  const i = s.extras.findIndex((e) => e.key === x.key);
  return x.name.trim() || `GR Mod ${i + 1}`;
}
const EXTRA_NAME_PROBLEMS: Record<string, Key> = { 'too-long': 'extraNameLong', 'bad-char': 'extraNameBad', empty: 'extraNameBad' };
export function extraNameProblem(x: ExtraSlot, s: State = state): string | null {
  const p = validateExtraSlotName(extraName(x, s));
  return p ? t(EXTRA_NAME_PROBLEMS[p]) : null;
}
/** Why an added slot cannot be built yet (null when it can). */
export function extraProblem(x: ExtraSlot, s: State = state): string | null {
  const n = extraNameProblem(x, s);
  if (n) return n;
  if (!x.preset) return t('extraNeedsPreset');
  if (x.preset.busy) return t('converting');
  if (x.preset.error || !x.preset.result) return x.preset.error || t('extraNeedsPreset');
  if (!x.icon.pixels) return t('extraNeedsIcon');
  return null;
}
export function hasExtraErrors(s: State = state): boolean { return s.model !== 'MONO' && s.extras.some((x) => !!extraProblem(x, s)); }
/** What the added slots give the build (none on the Monochrome, which has no colour looks). */
export function extraSpecs(s: State = state): ExtraSlotSpec[] {
  if (s.model === 'MONO') return [];
  return s.extras.map((x) => {
    const r = x.preset!.result!;
    return { name: extraName(x, s), matrixQ13: r.matrixQ13, curves: r.curves, ...(r.postQ9 ? { postQ9: r.postQ9 } : {}), ...(r.hueQ10 ? { hueQ10: r.hueQ10 } : {}), icon: x.icon.pixels!, halation: true };
  });
}
