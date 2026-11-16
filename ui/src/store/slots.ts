import { MAX_EXTRA_SLOTS } from '@grmod/core';
import type { FirmwareInfo, LangCode, SlotId } from '@grmod/core';
import { engine, EngineError } from '../engine';
import { host } from '../host';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { ensureIconFont, imageIcon, loadBitmap, textIcon } from '../pixels';
import { HalationState, IconState, SlotKey, State, availableSlots, fail, isExtra, isGr3, patchSlot, set, setSlot, slotOf, state, toast } from './core';
import { presetKey, scheduleSave } from './families';
import { normalizeLookOrder } from './looks';
import { setActiveSlot } from './photo';

// ------------------------------------------------------------------ presets
const PRESET_ERRORS: Record<string, Key> = {
  'not-xmp': 'errNotXmp', 'no-table': 'errNoTable', 'look-profile-missing': 'errLookMissing', 'unsupported-table': 'errUnsupportedTable', 'bad-table': 'errUnsupportedTable',
  'not-cube': 'errNotXmp', 'bad-cube': 'errBadCube', 'gr3x-cube-only': 'gr3xCubeOnly',
};
/** The newest conversion of each slot: an older one that finishes later is dropped. */
const presetRuns = new Map<SlotKey, number>();
let presetRun = 0;
export async function runPreset(id: SlotKey, fileName: string, kind: 'xmp' | 'cube', text: string): Promise<void> {
  patchSlot(id, { preset: { fileName, kind, text, busy: !!state.info?.capabilities.presets } });
  if (!state.info?.capabilities.presets) return;
  const run = ++presetRun;
  presetRuns.set(id, run);
  // GR IV added slots also try hue sectors; the conversion keeps them only when they come out closer.
  const hue = isExtra(id) && state.info.family !== 'gr3x';
  try {
    const result = await engine.convert(kind, text, hue ? { hue: true } : {});
    if (presetRuns.get(id) !== run || slotOf(id)?.preset?.text !== text) return; // replaced, removed or converted again meanwhile
    patchSlot(id, { preset: { fileName, kind, text, busy: false, result } });
  } catch (e) {
    if (presetRuns.get(id) !== run || slotOf(id)?.preset?.text !== text) return;
    const code = e instanceof EngineError ? e.code : '';
    patchSlot(id, { preset: { fileName, kind, text, busy: false, error: PRESET_ERRORS[code] ? t(PRESET_ERRORS[code]) : t('errNotXmp') } });
  }
}
/** Text of a preset file whatever its encoding: UTF-8, UTF-16 (with or without BOM) or GB18030. */
export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const n = Math.min(buf.length, 4096);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) zeros++;
  if (n > 8 && zeros > n / 4) return new TextDecoder(buf[1] === 0 ? 'utf-16le' : 'utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('gb18030').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
export async function loadPresetFile(id: SlotKey, file: File): Promise<void> {
  if (file.size > 120_000_000) { toast(t('errTooBig'), 'error'); return; }
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  const lower = file.name.toLowerCase();
  const kind: 'xmp' | 'cube' = lower.endsWith('.cube') ? 'cube' : lower.endsWith('.xmp') ? 'xmp' : /LUT_(3D|1D)_SIZE/i.test(text) ? 'cube' : 'xmp';
  setActiveSlot(id);
  if (host.available) await host.storeSet(presetKey(id), text).catch(() => undefined);
  await runPreset(id, file.name, kind, text);
  scheduleSave();
}
export function removePreset(id: SlotKey): void {
  patchSlot(id, { preset: undefined });
  if (host.available) void host.storeDel(presetKey(id)).catch(() => undefined);
  scheduleSave();
}

// ------------------------------------------------------------------ added slots
/** Every slot key: the two Cinema slots, then the added ones. */
/** The slots of the open firmware (GR IV: Cinema Yellow / Green and the added slots; GR IIIx: its nine films). */
export function allSlotKeys(s: State = state): SlotKey[] {
  const gr3x = s.info ? s.info.family === 'gr3x' : isGr3(s.model);
  return [...availableSlots(s), ...(gr3x ? [] : s.extras.map((x) => x.key))];
}

// ------------------------------------------------------------------ halation of an added slot
/** A halation read from a saved project (older ones also kept the settings, now fixed), or null. */
export function validHalation(v: unknown): HalationState | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as Partial<HalationState>;
  return { on: h.on === true, preview: h.preview === 1 || h.preview === 2 || h.preview === 3 ? h.preview : 0, ...(h.colour === 'white' ? { colour: 'white' as const } : {}) };
}
/** A slot's halation: every added slot has it (the camera switches it); a Cinema slot when it is switched on (with a preset). */
export function halationOf(k: SlotKey, s: State = state): HalationState {
  // GR III / IIIx: every film has it, as GR IV's added slots.
  if (s.info?.family === 'gr3x' && !isExtra(k)) return { ...(s.slots[k as SlotId]?.halation ?? { preview: 0 }), on: true };
  if (isExtra(k)) return { ...(s.extras.find((x) => x.key === k)?.halation ?? { preview: 0 }), on: true };
  return s.slots[k as SlotId]?.halation ?? { on: false, preview: 0 };
}
/** Change a slot's halation (on / off for a Cinema slot, strength, the level the preview shows). */
export function setHalation(key: SlotKey, patch: Partial<HalationState>): void {
  const next = { ...halationOf(key), ...patch };
  if (isExtra(key)) set((s) => ({ extras: s.extras.map((x) => (x.key === key ? { ...x, halation: next } : x)) }));
  else setSlot(key as SlotId, { halation: next });
  scheduleSave();
}
export function addExtraSlot(): void {
  if (state.extras.length >= MAX_EXTRA_SLOTS) { toast(t('extraMax', { n: MAX_EXTRA_SLOTS }), 'info'); return; }
  const key = 'x-' + Math.random().toString(36).slice(2, 10);
  const n = state.extras.length + 1;
  set((s) => ({ extras: [...s.extras, { key, name: '', icon: { mode: 'text', text: `GR${n}`, style: 'film' } }], lookOrder: [...normalizeLookOrder(s.lookOrder, s.extras), key] }));
  void renderIcon(key);
  scheduleSave();
}
export function removeExtraSlot(key: string): void {
  set((s) => ({ extras: s.extras.filter((x) => x.key !== key), activeSlot: s.activeSlot === key ? 'CY' : s.activeSlot, lookOrder: normalizeLookOrder(s.lookOrder, s.extras.filter((x) => x.key !== key)), lookHidden: s.lookHidden.filter((k) => k !== key) }));
  if (host.available) void host.storeDel(presetKey(key)).catch(() => undefined);
  scheduleSave();
}
/** Set how many slots are added: the last ones are taken away, new empty ones appended. */
export function setExtraCount(n: number): void {
  const want = Math.max(0, Math.min(MAX_EXTRA_SLOTS, Math.round(n)));
  while (state.extras.length < want) addExtraSlot();
  while (state.extras.length > want) removeExtraSlot(state.extras[state.extras.length - 1].key);
}
export function setExtraName(key: string, name: string): void {
  set((s) => ({ extras: s.extras.map((x) => (x.key === key ? { ...x, name } : x)) }));
  scheduleSave();
}

// ------------------------------------------------------------------ names
export function nameProblem(info: FirmwareInfo, id: SlotId, lang: LangCode, text: string): string | null {
  if (!text) return null;
  const slot = info.slots.find((s) => s.id === id);
  if (!slot) return null;
  const cap = slot.names[lang].capacity;
  if (text.length > cap) return t('nameTooLong', { n: cap });
  const allowed = info.allowed[lang];
  const bad: string[] = [];
  for (const ch of text) if (ch.length !== 1 || !allowed.includes(ch)) { if (!bad.includes(ch)) bad.push(ch); }
  if (/^\s|\s$/.test(text) && !bad.includes('␣')) bad.push('␣');
  return bad.length ? t('nameBadChar', { c: bad.join(' ') }) : null;
}
export function setName(id: SlotId, lang: LangCode, text: string): void {
  setSlot(id, (s) => ({ names: { ...s.names, [lang]: text } }));
  scheduleSave();
}

// ------------------------------------------------------------------ icons
const iconBitmaps = new Map<string, ImageBitmap>();
async function bitmapOf(dataUrl: string): Promise<ImageBitmap> {
  let b = iconBitmaps.get(dataUrl);
  if (!b) { b = await createImageBitmap(await (await fetch(dataUrl)).blob()); iconBitmaps.set(dataUrl, b); }
  return b;
}
export async function renderIcon(id: SlotKey): Promise<void> {
  const info = state.info; const ic = slotOf(id)?.icon;
  if (!ic) return;
  if (!info?.capabilities.presets || ic.mode === 'keep') { if (ic.pixels) patchSlot(id, (s) => ({ icon: { ...s.icon, pixels: undefined } })); return; }
  const tile = info.tiles[ic.style]; const area = info.contentArea[ic.style];
  let pixels: Uint8Array | undefined;
  if (ic.mode === 'text') { await ensureIconFont(); pixels = ic.text.trim() ? textIcon(tile, ic.text, area) : undefined; }
  else if (ic.image) { const b = await bitmapOf(ic.image); pixels = imageIcon(tile, b, b.width, b.height, area); }
  const cur = slotOf(id)?.icon;
  if (cur && cur.mode === ic.mode && cur.text === ic.text && cur.style === ic.style && cur.image === ic.image) patchSlot(id, { icon: { ...cur, pixels } });
}
export function setIcon(id: SlotKey, patch: Partial<IconState>): void {
  patchSlot(id, (s) => ({ icon: { ...s.icon, ...patch } }));
  void renderIcon(id);
  scheduleSave();
}
export async function loadIconImage(id: SlotKey, file: File): Promise<void> {
  try {
    const bmp = await loadBitmap(file);
    const scale = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
    setIcon(id, { mode: 'image', image: c.toDataURL('image/png') });
  } catch (e) { fail(e); }
}
