import { useSyncExternalStore } from 'react';
import { card, LANGS, MAX_CUSTOM_RATIOS, validateRatioName } from '@grmod/core';
import type { CameraModel, ClarityChange, FirmwareInfo, FirmwareSummary, LangCode, PresetResult, RatioPreview, RatioSpec, SlotId, SlotRequest, SoftFocusRequest, SoftFocusStrength } from '@grmod/core';
import { engine, EngineError } from './engine';
import { host, HostError, sha256Hex } from './host';
import type { ParkedEntry, Volume } from './host';
import { t } from './i18n';
import type { Key } from './i18n';
import { cropToRgb, defaultCrop, ensureIconFont, imageIcon, loadBitmap, textIcon, workingCopy } from './pixels';
import type { Crop } from './pixels';
import { decodePreview } from './preview';
import defaultPhotoUrl from './assets/preview.jpg';

export type Page = 'ic' | 'ratio' | 'wall' | 'script' | 'copies';
/** One added aspect ratio as typed; `preview` is what the camera would make of it (absent while that is worked out). */
export interface RatioItem { id: string; ratio: string; name: string; preview?: RatioPreview }
export interface PresetState { fileName: string; kind: 'xmp' | 'cube'; text: string; busy: boolean; result?: PresetResult; error?: string }
export interface IconState { mode: 'keep' | 'text' | 'image'; text: string; style: 'film' | 'plain'; image?: string; pixels?: Uint8Array }
export interface SlotState { preset?: PresetState; names: Partial<Record<LangCode, string>>; icon: IconState }
export interface WallItem {
  id: string; name: string; kind: 'image' | 'factory'; blob?: Blob; width: number; height: number; crop: Crop;
  busy: boolean; error?: string; data?: Uint8Array; quality?: number; grain?: number; soften?: number; preview?: Uint8Array;
}
export interface Toast { id: number; text: string; kind: 'ok' | 'error' | 'info'; action?: { label: string; run: () => void } }
/** The power-off image setup last seen on (or written to) a card; the files themselves are in the host store. */
export interface CardWall { names: string[]; hasIndex: boolean; savedAt: number; label: string }
export type PreviewMode = 'photo' | 'swatch';
/** What the frame of an added ratio is drawn on. */
export type RatioBackdrop = 'photo' | 'gray';
/** Where the copies page looks: files moved aside on the selected card, or their backups on this computer. */
export type CopySource = 'card' | 'pc';
export interface CopyInfo { busy?: boolean; summary?: FirmwareSummary; failed?: boolean }
/** What went into a firmware this program built, so that a copy of it can be named later. */
export interface BuildRecord { sha256: string; time: number; slots: { id: SlotId; preset?: string }[] }
/** `warn` is an optional caution shown under the lines (used where something is deleted for good). */
/** A guided tour: `overview` is the one of the first start, the others belong to a page. */
export type TourId = 'overview' | Page;
export const TOUR_IDS: readonly TourId[] = ['overview', 'script', 'ic', 'ratio', 'wall', 'copies'];
/** The tour being shown: `steps` are the indices of its steps that have something to point at; a replay can be skipped. */
export interface TourState { id: TourId; steps: number[]; index: number; replay: boolean }
export interface Confirm { title: string; warn?: string; lines: string[]; ok: string; resolve: (v: boolean) => void }
export interface State {
  ready: boolean; page: Page;
  fwName?: string; fwBusy: boolean; info?: FirmwareInfo; raw?: Uint8Array;
  model: CameraModel; lang: LangCode;
  slots: Record<SlotId, SlotState>;
  wall: WallItem[];
  ratios: RatioItem[]; activeRatio?: string; ratioBackdrop: RatioBackdrop;
  soft: boolean;
  previewMode: PreviewMode; photoRev: number; cardWall?: CardWall; activeSlot: SlotId;
  volumes: Volume[]; showAll: boolean; volumeId?: string; role?: card.CardRole; entryOnCard: boolean;
  copySource: CopySource; parked: ParkedEntry[]; backups: ParkedEntry[]; copySel: string[]; copyInfo: Record<string, CopyInfo>; builds: BuildRecord[];
  busy?: string; toasts: Toast[]; confirm?: Confirm; cropId?: string; onlineOpen: boolean;
  tour?: TourState; toursSeen: TourId[];
}

const SLOT_IDS: SlotId[] = ['CY', 'CG'];
const emptySlot = (): SlotState => ({ names: {}, icon: { mode: 'keep', text: '', style: 'film' } });
let state: State = {
  ready: false, page: 'script', fwBusy: false, model: 'HDF', lang: 'zh-CN',
  slots: { CY: emptySlot(), CG: emptySlot() }, wall: [], ratios: [], ratioBackdrop: 'photo', soft: false, previewMode: 'photo', photoRev: 0, activeSlot: 'CY', volumes: [], entryOnCard: false,
  copySource: 'card', parked: [], backups: [], copySel: [], copyInfo: {}, builds: [], showAll: false, toasts: [], onlineOpen: false, toursSeen: [],
};
const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export const getState = (): State => state;
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state));
}
function setSlot(id: SlotId, patch: Partial<SlotState> | ((s: SlotState) => Partial<SlotState>)): void {
  set((s) => ({ slots: { ...s.slots, [id]: { ...s.slots[id], ...(typeof patch === 'function' ? patch(s.slots[id]) : patch) } } }));
}
function setWall(id: string, patch: Partial<WallItem>): void {
  set((s) => ({ wall: s.wall.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
}

// ------------------------------------------------------------------ toasts / confirm
let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, kind, action }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : action ? 12000 : 4500);
}
export function dismissToast(id: number): void { set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })); }
function ask(title: string, lines: string[], ok: string, warn?: string): Promise<boolean> {
  return new Promise((resolve) => set({ confirm: { title, warn, lines, ok, resolve } }));
}
export function answerConfirm(v: boolean): void { const c = state.confirm; set({ confirm: undefined }); c?.resolve(v); }
function fail(e: unknown): void {
  const code = e instanceof HostError || e instanceof EngineError ? e.code : '';
  const msg = e instanceof Error ? e.message : String(e);
  console.error(e);
  toast(`${t('error')}${code ? ` · ${code}` : ''}${msg && msg !== code ? ` · ${msg}` : ''}`.slice(0, 220), 'error');
}

// ------------------------------------------------------------------ persistence
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  if (!host.available || !state.ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void saveProject(); }, 400);
}
async function saveProject(): Promise<void> {
  const s = state;
  const doc = {
    v: 1, page: s.page, model: s.model, lang: s.lang, fwName: s.fwName, showAll: s.showAll, previewMode: s.previewMode, ratioBackdrop: s.ratioBackdrop, cardWall: s.cardWall || null,
    slots: Object.fromEntries(SLOT_IDS.map((id) => [id, {
      preset: s.slots[id].preset ? { fileName: s.slots[id].preset!.fileName, kind: s.slots[id].preset!.kind } : null,
      names: s.slots[id].names,
      icon: { mode: s.slots[id].icon.mode, text: s.slots[id].icon.text, style: s.slots[id].icon.style, image: s.slots[id].icon.image },
    }])),
    wall: s.wall.map((w) => ({ id: w.id, name: w.name, kind: w.kind, width: w.width, height: w.height, crop: w.crop })),
    ratios: s.ratios.map((r) => ({ id: r.id, ratio: r.ratio, name: r.name })),
    soft: s.soft,
    tours: s.toursSeen,
  };
  try { await host.storeSet('project.json', JSON.stringify(doc)); } catch (e) { console.warn('save failed', e); }
}

export async function init(): Promise<void> {
  if (!host.available) { set({ ready: true }); return; }
  void engine.heartbeat(host.info!.token);
  void ensureIconFont();
  void loadPreviewPhoto();
  void loadBuilds();
  try {
    const raw = await host.storeGet('project.json');
    const doc = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
    if (doc && doc.v === 1) {
      const slots = { CY: emptySlot(), CG: emptySlot() };
      for (const id of SLOT_IDS) {
        const d = doc.slots?.[id];
        if (!d) continue;
        slots[id].names = d.names || {};
        if (d.icon) slots[id].icon = { mode: d.icon.mode || 'keep', text: d.icon.text || '', style: d.icon.style || 'film', image: d.icon.image };
      }
      const ratios: RatioItem[] = (Array.isArray(doc.ratios) ? doc.ratios : []).slice(0, MAX_CUSTOM_RATIOS)
        .filter((r: RatioItem) => r && typeof r.id === 'string' && typeof r.ratio === 'string')
        .map((r: RatioItem) => ({ id: r.id, ratio: r.ratio.slice(0, 24), name: String(r.name || '').slice(0, 80) }));
      set({ ratios, activeRatio: ratios[0]?.id, page: doc.page === 'wall' || doc.page === 'script' || doc.page === 'copies' || doc.page === 'ratio' || doc.page === 'ic' ? doc.page : doc.page === 'soft' ? 'ic' : 'script', model: doc.model || 'HDF', lang: (LANGS as readonly string[]).includes(doc.lang) ? doc.lang : 'zh-CN', fwName: doc.fwName, showAll: !!doc.showAll, slots, previewMode: doc.previewMode === 'swatch' ? 'swatch' : 'photo', ratioBackdrop: doc.ratioBackdrop === 'gray' ? 'gray' : 'photo', cardWall: validCardWall(doc.cardWall),
        soft: doc.soft === true || (!!doc.softFocus && typeof doc.softFocus === 'object' && Object.keys(doc.softFocus).length > 0),
        toursSeen: TOUR_IDS.filter((id) => Array.isArray(doc.tours) && doc.tours.includes(id)) });
      const fwRaw = await host.storeGet('firmware.bin');
      if (fwRaw) await openFirmware(fwRaw, doc.fwName || 'fwdc248b.bin', false);
      for (const id of SLOT_IDS) {
        const p = doc.slots?.[id]?.preset;
        if (!p) continue;
        const text = await host.storeGet('preset-' + id.toLowerCase());
        if (text) void runPreset(id, p.fileName, p.kind, new TextDecoder().decode(text));
      }
      const wall: WallItem[] = [];
      for (const w of doc.wall || []) {
        if (w.kind === 'factory') { wall.push({ id: w.id, name: w.name, kind: 'factory', width: 720, height: 480, crop: w.crop, busy: false }); continue; }
        const bytes = await host.storeGet('wall-' + w.id);
        if (bytes) wall.push({ id: w.id, name: w.name, kind: 'image', blob: new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }), width: w.width, height: w.height, crop: w.crop, busy: true });
      }
      set({ wall });
      for (const w of wall) void encodeWall(w.id);
    }
  } catch (e) { console.warn('restore failed', e); }
  set({ ready: true });
  void refreshVolumes();
  setInterval(() => { if (!document.hidden && !state.busy) void refreshVolumes(); }, 2500);
  for (const id of SLOT_IDS) void renderIcon(id);
}

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
/** Finished or skipped: either way it is not started by itself again. */
export function endTour(): void {
  const tr = state.tour;
  if (!tr) return;
  set((s) => ({ tour: undefined, toursSeen: s.toursSeen.includes(tr.id) ? s.toursSeen : [...s.toursSeen, tr.id] }));
  scheduleSave();
}

// ------------------------------------------------------------------ settings
export function setPage(page: Page): void { set({ page }); scheduleSave(); if (page === 'copies') void refreshCopies(); }
export function setLang(lang: LangCode): void { set({ lang }); scheduleSave(); }
export function setModel(model: CameraModel): void {
  if (model === state.model) return;
  set({ model });
  scheduleSave();
  for (const w of state.wall) void encodeWall(w.id);
}

// ------------------------------------------------------------------ firmware
/** Opens a firmware file; false (with a message shown) when it is not the supported official file. */
async function openFirmware(raw: Uint8Array, name: string, persist: boolean): Promise<boolean> {
  set({ fwBusy: true });
  try {
    const info = await engine.open(raw);
    set({ info, raw, fwName: name, fwBusy: false });
    if (persist) { await host.storeSet('firmware.bin', raw); scheduleSave(); }
    for (const id of SLOT_IDS) {
      void renderIcon(id);
      const p = state.slots[id].preset;
      if (p && !p.result && !p.busy) void runPreset(id, p.fileName, p.kind, p.text);
    }
    for (const w of state.wall) void encodeWall(w.id);
    void refreshRatios();
    return true;
  } catch (e) {
    set({ fwBusy: false });
    if (e instanceof EngineError && (e.code === 'unsupported-firmware' || e.code.startsWith('bad-') || e.code === 'too-short')) toast(t('badFirmware'), 'error');
    else fail(e);
    return false;
  }
}
export async function loadFirmwareFile(file: File): Promise<void> {
  if (file.size < 1_000_000 || file.size > 200_000_000) { toast(t('badFirmware'), 'error'); return; }
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

// ------------------------------------------------------------------ presets
const PRESET_ERRORS: Record<string, Key> = {
  'not-xmp': 'errNotXmp', 'no-table': 'errNoTable', 'look-profile-missing': 'errLookMissing', 'unsupported-table': 'errUnsupportedTable', 'bad-table': 'errUnsupportedTable',
  'not-cube': 'errNotXmp', 'bad-cube': 'errBadCube',
};
async function runPreset(id: SlotId, fileName: string, kind: 'xmp' | 'cube', text: string): Promise<void> {
  setSlot(id, { preset: { fileName, kind, text, busy: !!state.info } });
  if (!state.info) return;
  try {
    const result = await engine.convert(kind, text);
    if (state.slots[id].preset?.text !== text) return; // replaced meanwhile
    setSlot(id, { preset: { fileName, kind, text, busy: false, result } });
  } catch (e) {
    const code = e instanceof EngineError ? e.code : '';
    setSlot(id, { preset: { fileName, kind, text, busy: false, error: PRESET_ERRORS[code] ? t(PRESET_ERRORS[code]) : t('errNotXmp') } });
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
export async function loadPresetFile(id: SlotId, file: File): Promise<void> {
  if (file.size > 120_000_000) { toast(t('errTooBig'), 'error'); return; }
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  const lower = file.name.toLowerCase();
  const kind: 'xmp' | 'cube' = lower.endsWith('.cube') ? 'cube' : lower.endsWith('.xmp') ? 'xmp' : /LUT_(3D|1D)_SIZE/i.test(text) ? 'cube' : 'xmp';
  setActiveSlot(id);
  if (host.available) await host.storeSet('preset-' + id.toLowerCase(), text).catch(() => undefined);
  await runPreset(id, file.name, kind, text);
  scheduleSave();
}
export function removePreset(id: SlotId): void {
  setSlot(id, { preset: undefined });
  if (host.available) void host.storeDel('preset-' + id.toLowerCase()).catch(() => undefined);
  scheduleSave();
}

// ------------------------------------------------------------------ names
export function nameProblem(info: FirmwareInfo, id: SlotId, lang: LangCode, text: string): string | null {
  if (!text) return null;
  const slot = info.slots.find((s) => s.id === id)!;
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
async function renderIcon(id: SlotId): Promise<void> {
  const info = state.info; const ic = state.slots[id].icon;
  if (!info || ic.mode === 'keep') { if (ic.pixels) setSlot(id, (s) => ({ icon: { ...s.icon, pixels: undefined } })); return; }
  const tile = info.tiles[ic.style]; const area = info.contentArea[ic.style];
  let pixels: Uint8Array | undefined;
  if (ic.mode === 'text') { await ensureIconFont(); pixels = ic.text.trim() ? textIcon(tile, ic.text, area) : undefined; }
  else if (ic.image) { const b = await bitmapOf(ic.image); pixels = imageIcon(tile, b, b.width, b.height, area); }
  const cur = state.slots[id].icon;
  if (cur.mode === ic.mode && cur.text === ic.text && cur.style === ic.style && cur.image === ic.image) setSlot(id, { icon: { ...cur, pixels } });
}
export function setIcon(id: SlotId, patch: Partial<IconState>): void {
  setSlot(id, (s) => ({ icon: { ...s.icon, ...patch } }));
  void renderIcon(id);
  scheduleSave();
}
export async function loadIconImage(id: SlotId, file: File): Promise<void> {
  try {
    const bmp = await loadBitmap(file);
    const scale = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
    setIcon(id, { mode: 'image', image: c.toDataURL('image/png') });
  } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ power-off images
const wallBitmaps = new Map<string, ImageBitmap>();
export async function wallBitmap(w: WallItem): Promise<ImageBitmap | null> {
  if (!w.blob) return null;
  let b = wallBitmaps.get(w.id);
  if (!b) { b = await loadBitmap(w.blob); wallBitmaps.set(w.id, b); }
  return b;
}
const encodeGen = new Map<string, number>();
async function encodeWall(id: string): Promise<void> {
  const w = state.wall.find((x) => x.id === id); const info = state.info;
  if (!w || !info) return;
  const res = info.shutdown[state.model];
  if (!res) { setWall(id, { busy: false, error: t('encodeFailed') }); return; }
  if (w.kind === 'factory') { setWall(id, { busy: false, data: res.data, error: undefined, quality: 100, grain: 0, soften: 0 }); return; }
  const gen = (encodeGen.get(id) || 0) + 1; encodeGen.set(id, gen);
  setWall(id, { busy: true, error: undefined });
  try {
    const bmp = await wallBitmap(w);
    if (!bmp) throw new Error('no image');
    const model = state.model;
    const r = await engine.encode(cropToRgb(bmp, w.crop), model);
    if (encodeGen.get(id) !== gen || state.model !== model) return;
    setWall(id, { busy: false, data: r.data, quality: r.quality, grain: r.grain, soften: r.soften, preview: r.preview });
  } catch (e) {
    if (encodeGen.get(id) !== gen) return;
    const tooSmall = e instanceof EngineError && e.code === 'unreachable-size';
    setWall(id, { busy: false, data: undefined, preview: undefined, error: tooSmall ? t('tooDetailed') : t('encodeFailed') });
  }
}
export async function addWallFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (state.wall.length >= 9) { toast(t('wallMax'), 'info'); break; }
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|bmp|gif|avif)$/i.test(f.name)) continue;
    try {
      const bmp = await loadBitmap(f);
      const wc = await workingCopy(bmp);
      bmp.close();
      const id = Math.random().toString(36).slice(2, 10);
      const item: WallItem = { id, name: f.name, kind: 'image', blob: wc.blob, width: wc.width, height: wc.height, crop: defaultCrop(wc.width, wc.height), busy: true };
      set((s) => ({ wall: [...s.wall, item] }));
      if (host.available) void host.storeSet('wall-' + id, new Uint8Array(await wc.blob.arrayBuffer())).catch(() => undefined);
      void encodeWall(id);
    } catch (e) { fail(e); }
  }
  scheduleSave();
}
export function addFactoryWall(): void {
  if (state.wall.length >= 9) { toast(t('wallMax'), 'info'); return; }
  const id = Math.random().toString(36).slice(2, 10);
  set((s) => ({ wall: [...s.wall, { id, name: t('wallFactory'), kind: 'factory', width: 720, height: 480, crop: { x: 0, y: 0, w: 720, h: 480 }, busy: false }] }));
  void encodeWall(id);
  scheduleSave();
}
export function removeWall(id: string): void {
  set((s) => ({ wall: s.wall.filter((w) => w.id !== id) }));
  wallBitmaps.get(id)?.close(); wallBitmaps.delete(id);
  if (host.available) void host.storeDel('wall-' + id).catch(() => undefined);
  scheduleSave();
}
export function moveWall(id: string, toIndex: number): void {
  set((s) => {
    const from = s.wall.findIndex((w) => w.id === id);
    if (from < 0) return {};
    const wall = s.wall.slice(); const [it] = wall.splice(from, 1); wall.splice(Math.max(0, Math.min(wall.length, toIndex)), 0, it);
    return { wall };
  });
  scheduleSave();
}
export function openCrop(id: string | undefined): void { set({ cropId: id }); }
export function setCrop(id: string, crop: Crop): void { setWall(id, { crop }); set({ cropId: undefined }); void encodeWall(id); scheduleSave(); }

// ------------------------------------------------------------------ soft focus (rows of the clarity table)
/** What the soft focus switch writes: fixed strengths on three clarity steps, -1 stays as it is. */
export const SOFT_FIXED: readonly SoftFocusRequest[] = [{ level: -2, strength: 'weak' }, { level: -3, strength: 'medium' }, { level: -4, strength: 'strong' }];
export function setSoft(soft: boolean): void { set({ soft }); scheduleSave(); }
export function softSpecs(s: State = state): SoftFocusRequest[] { return s.soft ? [...SOFT_FIXED] : []; }
const MINUS = '\u2212';
const strengthLabel = (st: SoftFocusStrength | 'custom'): string => t(st === 'weak' ? 'softWeak' : st === 'medium' ? 'softMedium' : st === 'strong' ? 'softStrong' : 'softCustom');
/** "−2 weak / −3 medium" (−1 first), for confirmations and the copies page. */
export function softText(list: readonly (SoftFocusRequest | ClarityChange)[]): string {
  return [...list].sort((a, b) => b.level - a.level).map((f) => `${f.level < 0 ? MINUS : '+'}${Math.abs(f.level)} ${strengthLabel(f.strength)}`).join(' / ');
}

// ------------------------------------------------------------------ added aspect ratios
const RATIO_PROBLEMS: Record<NonNullable<RatioPreview['problem']>, Key> = {
  'bad-ratio': 'ratioBad', 'ratio-factory': 'ratioIsFactory', 'ratio-too-extreme': 'ratioExtreme', 'ratio-quick-view': 'ratioQuick',
  'ratio-metering': 'ratioMetering', 'ratio-conflict': 'ratioConflict', 'ratio-duplicate': 'ratioDup',
};
const NAME_PROBLEMS: Record<string, Key> = { 'too-long': 'ratioNameLong', 'bad-char': 'ratioNameBad', empty: 'ratioNameBad' };
/** Why a row cannot be built (shown in the row), or null. A row without a ratio is simply not built. */
export function ratioProblem(r: RatioItem): string | null {
  if (!r.ratio.trim()) return null;
  if (r.preview?.problem) return t(RATIO_PROBLEMS[r.preview.problem]);
  const n = r.name.trim() ? validateRatioName(r.name.trim()) : null;
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
let ratioGen = 0; let ratioTimer: ReturnType<typeof setTimeout> | undefined;
/** Work out every row again: whether a row is acceptable depends on the rows before it. */
async function refreshRatios(): Promise<void> {
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
function ratiosChanged(now = false): void {
  scheduleSave();
  clearTimeout(ratioTimer);
  if (now) void refreshRatios(); else ratioTimer = setTimeout(() => { void refreshRatios(); }, 160);
}
export function addRatio(ratio = ''): void {
  if (state.ratios.length >= MAX_CUSTOM_RATIOS) { toast(t('ratioMax', { n: MAX_CUSTOM_RATIOS }), 'info'); return; }
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
export function setActiveRatio(id: string): void { if (state.activeRatio !== id) set({ activeRatio: id }); }

// ------------------------------------------------------------------ preview photo
const PREVIEW_KEY = 'preview.jpg';
let photo: ImageData | null = null;
/** The picture the slot previews are drawn on; changes whenever `photoRev` does. */
export const previewPhoto = (): ImageData | null => photo;
async function loadPreviewPhoto(): Promise<void> {
  try {
    // the user's own choice first, then a `preview.jpg` kept next to the program, then the sample built in
    let bytes = await host.storeGet(PREVIEW_KEY).catch(() => null);
    if (!bytes) bytes = await host.sidecar(PREVIEW_KEY).catch(() => null);
    if (!bytes) bytes = new Uint8Array(await (await fetch(defaultPhotoUrl)).arrayBuffer());
    photo = await decodePreview(bytes);
    set((s) => ({ photoRev: s.photoRev + 1 }));
  } catch (e) { console.warn('preview photo', e); }
}
export async function loadPreviewFile(file: File): Promise<void> {
  try {
    const bmp = await loadBitmap(file);
    const wc = await workingCopy(bmp, 1600);
    bmp.close();
    photo = await decodePreview(wc.blob);
    set((s) => ({ photoRev: s.photoRev + 1, previewMode: 'photo', ratioBackdrop: 'photo' }));
    if (host.available) await host.storeSet(PREVIEW_KEY, new Uint8Array(await wc.blob.arrayBuffer())).catch(() => undefined);
    scheduleSave();
  } catch (e) { fail(e); }
}
export function setPreviewMode(previewMode: PreviewMode): void { set({ previewMode }); scheduleSave(); }
export function setRatioBackdrop(ratioBackdrop: RatioBackdrop): void { set({ ratioBackdrop }); scheduleSave(); }
/** The slot the preview on the right shows. */
export function setActiveSlot(id: SlotId): void { if (state.activeSlot !== id) set({ activeSlot: id }); }

// ------------------------------------------------------------------ remembered power-off images of the card
const CW_SCRIPT = 'cw-script'; const CW_INDEX = 'cw-index';
const cwKey = (name: string): string => 'cw-' + name.toLowerCase();
function validCardWall(d: unknown): CardWall | undefined {
  const c = d as CardWall | null;
  if (!c || !Array.isArray(c.names) || c.names.length < 1 || c.names.length > 9 || !c.names.every((n) => /^GBR[1-9]\.JPG$/i.test(n))) return undefined;
  return { names: c.names, hasIndex: !!c.hasIndex, savedAt: Number(c.savedAt) || 0, label: String(c.label || '') };
}
async function rememberCardWall(snap: card.WallpaperSnapshot, label: string): Promise<void> {
  const old = state.cardWall;
  await host.storeSet(CW_SCRIPT, snap.script);
  for (const im of snap.images) await host.storeSet(cwKey(im.name), im.data);
  if (snap.index) await host.storeSet(CW_INDEX, snap.index); else await host.storeDel(CW_INDEX).catch(() => undefined);
  const names = snap.images.map((im) => im.name.toUpperCase());
  for (const n of old?.names || []) if (!names.includes(n.toUpperCase())) await host.storeDel(cwKey(n)).catch(() => undefined);
  set({ cardWall: { names, hasIndex: !!snap.index, savedAt: Date.now(), label } });
  await saveProject();
}
/** Read the power-off image setup that is active on a card (script + images), if there is one. */
async function readCardWall(root: string, l: card.CardListing): Promise<card.WallpaperSnapshot | null> {
  if (!card.hasWallpaperScript(l)) return null;
  const names = card.wallpaperImageNames(l);
  const scriptDir = l.root.find((e) => e.dir && e.name.toLowerCase() === card.SCRIPT_DIR);
  const scriptFile = l.script.find((e) => !e.dir && e.name.toLowerCase() === card.SCRIPT_FILE);
  if (!names.length || !scriptDir || !scriptFile || scriptFile.size === 0 || scriptFile.size > 262_144) return null;
  if (names.some((n) => { const e = l.root.find((x) => x.name === n)!; return e.size === 0 || e.size > 2_000_000; })) return null;
  const script = await host.read(host.join(root, scriptDir.name, scriptFile.name));
  const images: card.WallpaperSnapshot['images'] = [];
  for (const n of names) images.push({ name: n, data: await host.read(host.join(root, n)) });
  const idx = l.root.find((e) => !e.dir && e.name.toLowerCase() === card.INDEX_FILE.toLowerCase());
  const index = idx && idx.size > 0 && idx.size <= 16 ? await host.read(host.join(root, idx.name)) : undefined;
  return { script, images, index };
}
const volumeLabel = (v: Volume): string => `${v.id}${v.label && v.label !== v.id ? ' ' + v.label : ''}`;
export function canRestoreWall(s: State = state): boolean {
  return !!s.cardWall && !!s.info && !s.busy && s.volumes.some((v) => v.id === s.volumeId) && s.role !== undefined && s.role !== 'wallpaper';
}
/** Put the remembered power-off images and their script back on the selected card. */
export async function restoreCardWall(): Promise<void> {
  const cw = state.cardWall; const v = state.volumes.find((x) => x.id === state.volumeId);
  if (state.busy || !cw) return;
  if (!v) { toast(t('noCard'), 'error'); return; }
  try {
    set({ busy: t('writing') });
    const script = await host.storeGet(CW_SCRIPT);
    const images: card.WallpaperSnapshot['images'] = [];
    for (const n of cw.names) { const data = await host.storeGet(cwKey(n)); if (data) images.push({ name: n, data }); }
    if (!script || images.length !== cw.names.length) { set({ busy: undefined, cardWall: undefined }); scheduleSave(); toast(t('restoreMissing'), 'error'); return; }
    const index = cw.hasIndex ? (await host.storeGet(CW_INDEX)) || undefined : undefined;
    const plan = card.planRestoreWallpaper(await listing(v.root), { script, images, index }, await freshStamp(v.root));
    const moved = await runPlan(v.root, plan);
    set({ busy: undefined });
    const text = t('wallRestored', { n: images.length }) + (moved ? ` · ${t('parked', { n: moved })}` : '');
    if (host.info?.kind === 'windows') toast(text, 'ok', { label: t('eject'), run: () => { host.eject(v.id).then(() => { toast(t('ejected'), 'ok'); void refreshVolumes(); }).catch(fail); } });
    else toast(text, 'ok');
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}

// ------------------------------------------------------------------ volumes
async function listing(root: string): Promise<card.CardListing> {
  const rootEntries = await host.list(root);
  const scriptDir = rootEntries.find((e) => e.dir && e.name.toLowerCase() === card.SCRIPT_DIR);
  return { root: rootEntries, script: scriptDir ? await host.list(host.join(root, scriptDir.name)) : [] };
}
let refreshing = false;
export async function refreshVolumes(): Promise<void> {
  if (!host.available || refreshing) return;
  refreshing = true;
  try {
    const volumes = await host.volumes(state.showAll);
    let volumeId = state.volumeId;
    if (!volumeId || !volumes.some((v) => v.id === volumeId)) volumeId = (volumes.find((v) => v.removable) || volumes[0])?.id;
    let role: card.CardRole | undefined; let entryOnCard = false;
    const v = volumes.find((x) => x.id === volumeId);
    if (v) { try { const l = await listing(v.root); role = card.cardRole(l); entryOnCard = card.hasEntryFiles(l, entryNames()); } catch { role = undefined; } }
    const same = JSON.stringify(volumes) === JSON.stringify(state.volumes) && volumeId === state.volumeId && role === state.role && entryOnCard === state.entryOnCard;
    if (!same) set({ volumes, volumeId, role, entryOnCard });
    if (state.page === 'copies') void refreshCopies();
  } catch { /* shell gone or busy */ } finally { refreshing = false; }
}
export function selectVolume(id: string): void { set({ volumeId: id, role: undefined, entryOnCard: false, parked: [], copySel: state.copySource === 'card' ? [] : state.copySel }); void refreshVolumes(); }
export function setShowAll(v: boolean): void { set({ showAll: v }); scheduleSave(); void refreshVolumes(); }

// ------------------------------------------------------------------ output
export interface SlotChange { id: SlotId; parts: string[]; labels: string[]; request: SlotRequest }
export function pendingChanges(s: State = state): SlotChange[] {
  const out: SlotChange[] = [];
  if (!s.info || s.model === 'MONO') return out;
  for (const id of SLOT_IDS) {
    const sl = s.slots[id]; const off = s.info.slots.find((x) => x.id === id)!;
    const req: SlotRequest = { slot: id }; const parts: string[] = []; const labels: string[] = [];
    if (sl.preset?.result) { req.preset = { matrixQ13: sl.preset.result.matrixQ13, curves: sl.preset.result.curves }; parts.push(`${t('preset')} ${sl.preset.result.title || sl.preset.fileName}`); labels.push(t('preset')); }
    if (sl.icon.mode !== 'keep' && sl.icon.pixels) { req.icon = sl.icon.pixels; parts.push(t('icon')); labels.push(t('icon')); }
    const names: Partial<Record<LangCode, string>> = {};
    for (const lang of LANGS) {
      const v = sl.names[lang];
      if (v && v !== off.names[lang].text && !nameProblem(s.info, id, lang, v)) names[lang] = v;
    }
    if (Object.keys(names).length) { req.names = names; parts.push(`${t('name')} ${Object.values(names).join(' / ')}`); labels.push(`${t('name')} “${Object.values(names)[0]}”`); }
    if (parts.length) out.push({ id, parts, labels, request: req });
  }
  return out;
}
export function hasNameErrors(s: State = state): boolean {
  if (!s.info) return false;
  return SLOT_IDS.some((id) => LANGS.some((lang) => !!nameProblem(s.info!, id, lang, s.slots[id].names[lang] || '')));
}
const stamp = (): string => { const d = new Date(); const p = (n: number): string => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

/** A stamp whose `GRMOD\parked-<stamp>` folder does not exist on the card yet (two writes can fall into the same second). */
async function freshStamp(root: string): Promise<string> {
  const base = stamp();
  let taken: string[] = [];
  try { taken = (await host.list(host.join(root, card.PARK_ROOT))).map((e) => e.name.toLowerCase()); } catch { /* no such folder yet */ }
  for (let n = 1; n < 100; n++) {
    const s = n === 1 ? base : `${base}-${n}`;
    if (!taken.includes(`parked-${s}`.toLowerCase())) return s;
  }
  return base;
}

async function runPlan(root: string, steps: card.PlanStep[]): Promise<number> {
  let moved = 0;
  for (const st of steps) {
    if (st.op === 'move') { await host.move(host.join(root, ...st.from), host.join(root, ...st.to)); moved++; }
    else {
      const res = await host.write(host.join(root, ...st.path), st.data);
      if (res.size !== st.data.length || res.sha256 !== (await sha256Hex(st.data))) throw new HostError('verify', t('verifyFailed'));
    }
  }
  return moved;
}
type Dest = { kind: 'card' } | { kind: 'folder' };
async function destination(dest: Dest): Promise<{ root: string; volume?: Volume } | null> {
  if (dest.kind === 'card') {
    const v = state.volumes.find((x) => x.id === state.volumeId);
    if (!v) { toast(t('noCard'), 'error'); return null; }
    return { root: v.root, volume: v };
  }
  const path = await host.pickDirectory(t('pickFolder'));
  return path ? { root: path } : null;
}
function doneToast(root: string, volume: Volume | undefined, moved: number, file: string, kept = false): void {
  const text = (volume ? t('written', { p: host.join(root, file) }) : t('exported', { p: root })) + (kept ? ` · ${t('wallKept')}` : moved ? ` · ${t('parked', { n: moved })}` : '');
  if (volume && host.info?.kind === 'windows') {
    toast(text, 'ok', { label: t('eject'), run: () => { host.eject(volume.id).then(() => { toast(t('ejected'), 'ok'); void refreshVolumes(); }).catch(fail); } });
  } else toast(text, 'ok', { label: t('reveal'), run: () => { void host.reveal(host.join(root, file)); } });
}

/** Turn a card into a firmware card holding `file`; remembers the card's power-off images first. */
async function firmwareToCard(volume: Volume, file: Uint8Array): Promise<{ moved: number; kept: boolean }> {
  const l = await listing(volume.root);
  let kept = false;
  // a card that shows the user's own power-off images: remember them before the script is moved aside
  try {
    const snap = await readCardWall(volume.root, l);
    if (snap) { await rememberCardWall(snap, volumeLabel(volume)); kept = true; }
  } catch (e) { console.warn('remember power-off images', e); }
  const moved = await runPlan(volume.root, card.planFirmwareCard(l, file, await freshStamp(volume.root)));
  return { moved, kept };
}

export async function outputFirmware(dest: Dest, stock = false): Promise<void> {
  if (state.busy || !state.info || !state.raw) return;
  const changes = stock ? [] : pendingChanges();
  const ratios = stock ? [] : ratioSpecs();
  const soft = stock ? [] : softSpecs();
  if (!stock && (hasNameErrors() || hasRatioErrors())) return;
  if (!stock && changes.length === 0 && ratios.length === 0 && soft.length === 0) { toast(t('nothingToDo'), 'info'); return; }
  if (dest.kind === 'card') {
    const lines = stock ? [t('copyOfficial')] : changes.map((c) => `${t(('slot' + c.id) as Key)}  ·  ${c.labels.join(' / ')}`);
    if (ratios.length) lines.push(t('ratioLine', { n: ratios.length, l: ratios.map((r) => r.name).join(' / ') }));
    if (soft.length) lines.push(t('softLine', { l: softText(soft) }));
    if (!(await ask(t('confirmTitle'), lines, t('confirmOk')))) return;
  }
  const target = await destination(dest);
  if (!target) return;
  try {
    let file: Uint8Array;
    if (stock) file = state.raw;
    else {
      set({ busy: t('building') });
      const built = await engine.build(changes.map((c) => c.request), ratios, soft);
      if (!Object.values(built.checks).every((v) => v === true)) throw new EngineError('selfcheck-failed', 'self-check');
      file = built.file;
      void recordBuild(file, changes);
    }
    set({ busy: t('writing') });
    let moved = 0; let kept = false;
    if (target.volume) ({ moved, kept } = await firmwareToCard(target.volume, file));
    else await runPlan(target.root, [{ op: 'write', path: [card.FIRMWARE_FILE], data: file }]);
    set({ busy: undefined });
    doneToast(target.root, target.volume, moved, card.FIRMWARE_FILE, kept);
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}

// ------------------------------------------------------------------ factory-menu entry (to switch Script on)
// Nothing takes these files off the card on request: the next firmware or power-off image write moves them aside.
const entryNames = (): readonly string[] => state.info?.factoryEntry.files.map((f) => f.name) || card.FACTORY_ENTRY_FILES;
/** Put the files that open the camera's factory menu on the card (or into a folder). */
export async function outputEntry(dest: Dest): Promise<void> {
  const info = state.info;
  if (state.busy || !info) return;
  const target = await destination(dest);
  if (!target) return;
  try {
    set({ busy: t('writing') });
    const files = info.factoryEntry.files;
    let moved = 0;
    if (target.volume) moved = await runPlan(target.root, card.planEntryCard(await listing(target.root), files, await freshStamp(target.root)));
    else await runPlan(target.root, files.map((f) => ({ op: 'write' as const, path: [f.name], data: f.data })));
    set({ busy: undefined });
    doneToast(target.root, target.volume, moved, info.factoryEntry.modeSetName);
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}
export function wallReady(s: State = state): boolean {
  return s.wall.length > 0 && s.wall.every((w) => !w.busy && !w.error && !!w.data);
}
export async function outputWallpaper(dest: Dest): Promise<void> {
  if (state.busy || !state.info) return;
  if (!wallReady()) { toast(t('nothingToDo'), 'info'); return; }
  const target = await destination(dest);
  if (!target) return;
  try {
    set({ busy: t('writing') });
    const images = state.wall.map((w) => w.data!);
    const script = await engine.script(state.model, images.length);
    const plan = card.planWallpaperCard(target.volume ? await listing(target.root) : { root: [], script: [] }, images, script, target.volume ? await freshStamp(target.root) : stamp());
    const moved = await runPlan(target.root, plan);
    if (target.volume) {
      const files = card.planFiles(plan);
      const scriptBytes = files.find((f) => f.path.length === 2)!.data;
      await rememberCardWall({ script: scriptBytes, images: images.map((data, i) => ({ name: `GBR${i + 1}.JPG`, data })), index: new Uint8Array([0x31]) }, volumeLabel(target.volume)).catch((e) => console.warn('remember power-off images', e));
    }
    set({ busy: undefined });
    doneToast(target.root, target.volume, moved, host.join(card.SCRIPT_DIR, card.SCRIPT_FILE));
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}

// ------------------------------------------------------------------ copies moved aside on the card, and their backups
const BUILDS_KEY = 'builds.json';
async function loadBuilds(): Promise<void> {
  try {
    const raw = await host.storeGet(BUILDS_KEY);
    const list = raw ? JSON.parse(new TextDecoder().decode(raw)) : [];
    if (Array.isArray(list)) set({ builds: list.filter((b) => b && typeof b.sha256 === 'string' && Array.isArray(b.slots)).slice(-400) });
  } catch { /* start empty */ }
}
async function recordBuild(file: Uint8Array, changes: SlotChange[]): Promise<void> {
  try {
    const sha256 = await sha256Hex(file);
    const slots = changes.map((c) => { const p = state.slots[c.id].preset; return { id: c.id, preset: c.request.preset && p ? p.result?.title || p.fileName : undefined }; });
    const builds = [...state.builds.filter((b) => b.sha256 !== sha256), { sha256, time: Date.now(), slots }].slice(-400);
    set({ builds });
    await host.storeSet(BUILDS_KEY, JSON.stringify(builds));
  } catch (e) { console.warn('record build', e); }
}

export const copyKey = (source: CopySource, e: ParkedEntry): string => `${source}|${e.path}|${e.size}|${e.mtime}`;
export const copyList = (s: State = state): ParkedEntry[] => (s.copySource === 'card' ? s.parked : s.backups);
const isFirmwareCopy = (e: ParkedEntry): boolean => /(^|\/)[^/]+\.bin$/i.test(e.path) && e.size >= 1_000_000 && e.size <= 120_000_000;

let copiesBusy = false; let copiesAgain = false;
/** Re-read both lists; selections of files that are gone are dropped. */
export async function refreshCopies(): Promise<void> {
  if (!host.available) return;
  if (copiesBusy) { copiesAgain = true; return; }
  copiesBusy = true;
  try {
    const v = state.volumes.find((x) => x.id === state.volumeId);
    const [parked, b] = await Promise.all([
      v ? host.parked(v.id).catch(() => [] as ParkedEntry[]) : Promise.resolve([] as ParkedEntry[]),
      host.backups().catch(() => ({ dir: '', entries: [] as ParkedEntry[] })),
    ]);
    if (v?.id !== state.volumes.find((x) => x.id === state.volumeId)?.id) return; // another card was chosen meanwhile
    const backups = b.entries || [];
    if (JSON.stringify(parked) !== JSON.stringify(state.parked) || JSON.stringify(backups) !== JSON.stringify(state.backups)) {
      const present = new Set((state.copySource === 'card' ? parked : backups).map((e) => e.path));
      set({ parked, backups, copySel: state.copySel.filter((p) => present.has(p)) });
    }
  } finally {
    copiesBusy = false;
    if (copiesAgain) { copiesAgain = false; void refreshCopies(); }
  }
  void inspectCopies();
}

let inspecting = false;
/** Look into the firmware files of the list being shown, one at a time. */
async function inspectCopies(): Promise<void> {
  if (inspecting || !state.info) return;
  inspecting = true;
  try {
    for (;;) {
      const source = state.copySource; const volumeId = state.volumeId;
      const next = copyList().find((e) => isFirmwareCopy(e) && !state.copyInfo[copyKey(source, e)]);
      if (!next || state.page !== 'copies' || !state.info) break;
      const key = copyKey(source, next);
      set((s) => ({ copyInfo: { ...s.copyInfo, [key]: { busy: true } } }));
      try {
        const raw = source === 'card' ? await host.parkedRead(volumeId || '', next.path) : await host.backupRead(next.path);
        const summary = await engine.inspect(raw);
        set((s) => ({ copyInfo: { ...s.copyInfo, [key]: { summary } } }));
      } catch {
        set((s) => ({ copyInfo: { ...s.copyInfo, [key]: { failed: true } } }));
      }
    }
  } finally { inspecting = false; }
}

export function setCopySource(copySource: CopySource): void {
  if (copySource === state.copySource) return;
  set({ copySource, copySel: [] });
  void refreshCopies();
}
export function toggleCopies(paths: string[], on?: boolean): void {
  set((s) => {
    const sel = new Set(s.copySel);
    const turnOn = on ?? !paths.every((p) => sel.has(p));
    for (const p of paths) { if (turnOn) sel.add(p); else sel.delete(p); }
    return { copySel: [...sel] };
  });
}
export const fmtSize = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`);

/** Delete the selected copies (or all of the list being shown) for good. */
export async function deleteCopies(all: boolean): Promise<void> {
  const source = state.copySource; const list = copyList();
  const targets = all ? list : list.filter((e) => state.copySel.includes(e.path));
  const v = state.volumes.find((x) => x.id === state.volumeId);
  if (state.busy || targets.length === 0 || (source === 'card' && !v)) return;
  const where = source === 'card' ? host.join(v!.root, card.PARK_ROOT) : t('copiesPc');
  const total = targets.reduce((a, e) => a + e.size, 0);
  if (!(await ask(t('copiesDeleteTitle'), [t('copiesCount', { n: targets.length, s: fmtSize(total) }), where], t('copiesDelete'), t('copiesDeleteBody')))) return;
  try {
    set({ busy: t('copiesDeleting') });
    const paths = targets.map((e) => e.path);
    const res = source === 'card' ? await host.parkedDelete(v!.id, paths) : await host.backupsDelete(paths);
    set({ busy: undefined });
    if (res.failed.length) toast(t('copiesDeleteFailed', { n: res.failed.length }), 'error');
    else toast(t('copiesDeleted', { n: res.deleted.length, s: fmtSize(total) }), 'ok');
  } catch (e) { set({ busy: undefined }); fail(e); }
  await refreshCopies();
  void refreshVolumes();
}

/** Copy the selected card files to this computer, then show what is there. */
export async function backupCopies(): Promise<void> {
  const v = state.volumes.find((x) => x.id === state.volumeId);
  const targets = state.parked.filter((e) => state.copySel.includes(e.path));
  if (state.busy || state.copySource !== 'card' || !v || targets.length === 0) return;
  try {
    set({ busy: t('copiesBackingUp') });
    const res = await host.parkedBackup(v.id, targets.map((e) => e.path));
    set({ busy: undefined });
    if (res.failed.length) toast(t('copiesBackupFailed', { n: res.failed.length }), 'error');
    if (res.saved.length) {
      toast(t('copiesBackedUp', { n: res.saved.length }), 'ok', { label: t('reveal'), run: () => { void host.backupsReveal(res.saved[0].dest); } });
      set({ copySource: 'pc', copySel: [] });
      await refreshCopies();
      // show exactly what was saved
      const saved = new Set(res.saved.map((x) => x.dest));
      set({ copySel: state.backups.filter((e) => saved.has(e.path)).map((e) => e.path) });
    }
  } catch (e) { set({ busy: undefined }); fail(e); }
}
export function revealBackups(): void { void host.backupsReveal(); }

/** The one selected copy, when it is a firmware that may be written back to a card. */
export function writableCopy(s: State = state): { entry: ParkedEntry; summary: FirmwareSummary } | null {
  if (s.copySel.length !== 1) return null;
  const entry = copyList(s).find((e) => e.path === s.copySel[0]);
  const summary = entry && s.copyInfo[copyKey(s.copySource, entry)]?.summary;
  return entry && summary && summary.verified && summary.kind !== 'unknown' ? { entry, summary } : null;
}
/** A one-line description of a firmware copy, for the confirmation. */
export function describeCopy(summary: FirmwareSummary, s: State = state): string[] {
  if (summary.kind === 'official') return [t('copyOfficial')];
  const build = s.builds.find((b) => b.sha256 === summary.sha256);
  const lines = summary.slots.map((sl) => {
    const preset = build?.slots.find((x) => x.id === sl.id)?.preset;
    const parts = [sl.colorChanged ? preset || t('copyColor') : '', sl.iconChanged ? t('copyIcon') : '', sl.nameChanged ? t('copyName') : ''].filter(Boolean);
    return `${sl.names[s.lang]}  ·  ${parts.join(' / ') || t('original')}`;
  });
  if (summary.ratios.length) lines.push(t('ratioLine', { n: summary.ratios.length, l: summary.ratios.map((r) => r.name).join(' / ') }));
  if (summary.softFocus?.length) lines.push(t('softLine', { l: softText(summary.softFocus) }));
  return lines;
}
/** Put the selected firmware copy (from the card's parked files or from a backup) on the card as the firmware to install. */
export async function writeCopy(): Promise<void> {
  const pick = writableCopy(); const source = state.copySource;
  const v = state.volumes.find((x) => x.id === state.volumeId);
  if (state.busy || !pick || !state.info) return;
  if (!v) { toast(t('noCard'), 'error'); return; }
  if (!(await ask(t('confirmTitle'), describeCopy(pick.summary), t('confirmOk')))) return;
  try {
    set({ busy: t('opening') });
    const file = source === 'card' ? await host.parkedRead(v.id, pick.entry.path) : await host.backupRead(pick.entry.path);
    // look at the bytes that will actually be written, not at what was seen earlier
    const now = await engine.inspect(file.slice());
    if (!now.verified || now.sha256 !== pick.summary.sha256) throw new EngineError('selfcheck-failed', t('copyUnverified'));
    set({ busy: t('writing') });
    const { moved, kept } = await firmwareToCard(v, file);
    set({ busy: undefined });
    doneToast(v.root, v, moved, card.FIRMWARE_FILE, kept);
  } catch (e) { set({ busy: undefined }); fail(e); }
  await refreshCopies();
  void refreshVolumes();
}
