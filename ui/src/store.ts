import { useSyncExternalStore } from 'react';
import { FACTORY_LOOK_IDS, card, GR3X_FILM_IDS, GR3X_MAX_CUSTOM_RATIOS, GR3X_T4_CUSTOM, LANGS, MAX_CUSTOM_RATIOS, MAX_EXTRA_SLOTS, SHUTDOWN_MAX_PICTURES, SHUTDOWN_NAME_MAX, validateExtraSlotName, validateGr3xRatioName, validateRatioName, validateShutdownName } from '@grmod/core';
import type { CameraModel, ClarityChange, ExtraSlotSpec, FirmwareInfo, FirmwareSummary, LangCode, LookLayout, PresetResult, RatioPreview, RatioSpec, ShutdownPictureSpec, SlotId, SlotRequest, SoftFocusRequest, SoftFocusStrength } from '@grmod/core';
import { engine, EngineError } from './engine';
import { host, HostError, sha256Hex } from './host';
import type { ParkedEntry, Volume } from './host';
import { t } from './i18n';
import type { Key } from './i18n';
import { cropToRgb, defaultCrop, ensureIconFont, imageIcon, loadBitmap, textIcon, workingCopy } from './pixels';
import type { Crop } from './pixels';
import { decodePreview } from './preview';
import defaultPhotoUrl from './assets/preview.jpg';

export type Page = 'ic' | 'ratio' | 'wall' | 'copies';
/** One added aspect ratio as typed; `preview` is what the camera would make of it (absent while that is worked out). */
export interface RatioItem { id: string; ratio: string; name: string; preview?: RatioPreview }
export interface PresetState { fileName: string; kind: 'xmp' | 'cube'; text: string; busy: boolean; result?: PresetResult; error?: string }
export interface IconState { mode: 'keep' | 'text' | 'image'; text: string; style: 'film' | 'plain'; image?: string; pixels?: Uint8Array }
/** `halation`: Cinema Yellow / Green with a preset (0.8.2); their Toning becomes the Halation slider. */
export interface SlotState { preset?: PresetState; names: Partial<Record<LangCode, string>>; icon: IconState; halation?: HalationState }
/**
 * An added Image Control slot (style 34, 35, ... in the camera): `key` is `x-` and a random id;
 * `name` as typed (empty: the default name of its place), one name for every language.
 */
/** A slot's halation (the fixed CineStill 800T look): on (always for an added slot), and which level the preview shows (0 = off, 1 Weak, 2 Medium, 3 Strong). */
export interface HalationState { on: boolean; preview: 0 | 1 | 2 | 3; /** Colour the preview shows (chosen in the camera). */ colour?: 'red' | 'white' }
export interface ExtraSlot { key: string; name: string; preset?: PresetState; icon: IconState; halation?: HalationState }
/** A factory Cinema slot (`CY`, `CG`) or the key of an added slot. */
export type SlotKey = SlotId | string;
/**
 * A power-off image. They are built into the firmware and chosen in the camera's End Screen menu
 * (Setup > Display > End Screen > Picture): `menuName` is the name in the camera's list, `menuId`
 * its stable identity, `menuJpeg` the picture file. (GR Mod 0.7 and earlier could also put them on
 * the card with a start-up script; 0.8 only builds them into the firmware.)
 */
export interface WallItem {
  id: string; name: string; blob?: Blob; width: number; height: number; crop: Crop;
  busy: boolean; error?: string; preview?: Uint8Array;
  menuName?: string; menuId?: number; menuJpeg?: Uint8Array;
}
export interface Toast { id: number; text: string; kind: 'ok' | 'error' | 'info'; action?: { label: string; run: () => void } }
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
export const TOUR_IDS: readonly TourId[] = ['overview', 'ic', 'ratio', 'wall', 'copies'];
/** The tour being shown: `steps` are the indices of its steps that have something to point at; a replay can be skipped. */
export interface TourState { id: TourId; steps: number[]; index: number; replay: boolean }
/** `reset`: the firmware written is the official one; the dialog asks in red whether the camera's settings were reset first. */
export interface Confirm { title: string; warn?: string; reset?: boolean; lines: string[]; ok: string; resolve: (v: boolean) => void }
export interface State {
  ready: boolean; page: Page;
  fwName?: string; fwBusy: boolean; info?: FirmwareInfo; raw?: Uint8Array;
  model: CameraModel; lang: LangCode;
  slots: Record<SlotId, SlotState>;
  wall: WallItem[];
  ratios: RatioItem[]; activeRatio?: string; ratioBackdrop: RatioBackdrop;
  soft: boolean; dateStamp: boolean; monoUnlock: boolean;
  /** GR IV: Direct Flash, a fifth Flash Mode (GR III / IIIx have the GF-2 mode of their own). */
  directFlash: boolean;
  /** GR IV, experimental: .cube presets of added slots get hue sectors of their own (core color/hue.ts). */
  /** GR III / IIIx: how many films the build has (1..info.features.maxFilms). */
  filmCount: number;
  previewMode: PreviewMode; photoRev: number; activeSlot: SlotKey;
  /** Added Image Control slots, in the camera's order (none by default). */
  extras: ExtraSlot[];
  /** Image Control menu order (`f11`..`f30`, or an added slot's key) and hidden keys. Empty = factory order, nothing hidden. */
  lookOrder: string[];
  lookHidden: string[];
  /** GR III / IIIx (round 8): its order (`g11`..`g22`, films `g64`..) and hidden keys, kept apart from GR IV's. */
  lookOrder3: string[];
  lookHidden3: string[];
  volumes: Volume[]; showAll: boolean; volumeId?: string; role?: card.CardRole;
  copySource: CopySource; parked: ParkedEntry[]; backups: ParkedEntry[]; copySel: string[]; copyInfo: Record<string, CopyInfo>; builds: BuildRecord[];
  busy?: string; toasts: Toast[]; confirm?: Confirm; cropId?: string; onlineOpen: boolean;
  /** Why the download dialog is open, when it says so: the bridge firmware is open, or one is to be made and no firmware is open. */
  onlineReason?: 'bridge-loaded' | 'bridge-base';
  /** The bridge firmware dialog; `bridgeAfter` is where the bridge goes once a downloaded official file is open. */
  bridgeOpen: boolean; bridgeAfter?: Dest;
  tour?: TourState; toursSeen: TourId[];
}

const SLOT_IDS: readonly SlotId[] = GR3X_FILM_IDS;
/** GR IIIx 1.60 and GR III 2.10: one program, one code path in GR Mod. */
export const isGr3 = (m?: CameraModel): boolean => m === 'GR3X_HDF' || m === 'GR3_HDF' || m === 'GR3X' || m === 'GR3';
/** The film count can be chosen (GR III / IIIx: 1..20, each film with Halation in the camera). */
export const filmCountChoosable = (s: State = state): boolean => s.info?.family === 'gr3x' && (s.info.features.maxFilms ?? 9) > 9;
/** The slots of the open firmware the page shows: on GR III / IIIx the first `filmCount`. */
export const shownSlots = (s: State = state): FirmwareInfo['slots'] => (s.info ? (filmCountChoosable(s) ? s.info.slots.slice(0, s.filmCount) : s.info.slots) : []);
const availableSlots = (s: State = state): SlotId[] => s.info ? shownSlots(s).map(slot => slot.id) : (isGr3(s.model) ? [...GR3X_FILM_IDS] : ['CY', 'CG']);
const emptySlot = (): SlotState => ({ names: {}, icon: { mode: 'keep', text: '', style: 'film' } });
const emptySlots = (): Record<SlotId, SlotState> => Object.fromEntries(SLOT_IDS.map(id => [id, emptySlot()])) as Record<SlotId, SlotState>;
let state: State = {
  ready: false, page: 'ic', fwBusy: false, model: 'HDF', lang: 'zh-CN',
  slots: emptySlots(), extras: [], lookOrder: [], lookHidden: [], lookOrder3: [], lookHidden3: [], wall: [], ratios: [], ratioBackdrop: 'photo', soft: false, dateStamp: false, monoUnlock: false, directFlash: false, filmCount: 0, previewMode: 'photo', photoRev: 0, activeSlot: 'CY', volumes: [], bridgeOpen: false,
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
const isExtra = (k: SlotKey): boolean => k.startsWith('x-');
/** The preset and icon of a factory or an added slot. */
export function slotOf(k: SlotKey, s: State = state): { preset?: PresetState; icon: IconState } | undefined {
  return isExtra(k) ? s.extras.find((x) => x.key === k) : s.slots[k as SlotId];
}
function patchSlot(k: SlotKey, patch: { preset?: PresetState; icon?: IconState } | ((s: { preset?: PresetState; icon: IconState }) => { preset?: PresetState; icon?: IconState })): void {
  if (!isExtra(k)) { setSlot(k as SlotId, patch as Partial<SlotState>); return; }
  set((s) => ({ extras: s.extras.map((x) => (x.key === k ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)) }));
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
function ask(title: string, lines: string[], ok: string, warn?: string, reset = false): Promise<boolean> {
  return new Promise((resolve) => set({ confirm: { title, warn, lines, ok, resolve, ...(reset ? { reset } : {}) } }));
}
/**
 * Before the official firmware goes back on the camera: settings made with GR Mod's firmware (an
 * added slot or ratio selected, soft focus on the ADJ lever, the date imprint, added slots'
 * parameters) are values the official firmware does not know and may freeze on. The dialog says so
 * in red and its button confirms that the camera was reset to factory defaults.
 */
function askOfficial(lines: string[]): Promise<boolean> {
  return ask(t('resetConfirmTitle'), lines, t('resetConfirmOk'), undefined, true);
}
export function answerConfirm(v: boolean): void { const c = state.confirm; set({ confirm: undefined }); c?.resolve(v); }
function fail(e: unknown): void {
  const code = e instanceof HostError || e instanceof EngineError ? e.code : '';
  const msg = e instanceof Error ? e.message : String(e);
  console.error(e);
  toast(`${t('error')}${code ? ` · ${code}` : ''}${msg && msg !== code ? ` · ${msg}` : ''}`.slice(0, 220), 'error');
}

// ------------------------------------------------------------------ camera families
/**
 * GR IV and GR III / IIIx keep their own work: Image Control slots or films with their presets,
 * added slots, the menu order, pictures, ratios and switches. GR IV's is `project.json` as it
 * always was (older versions of GR Mod read it unchanged; the settings of the program itself are
 * there too); GR III / IIIx's is `project-gr3.json`, its presets `gr3-preset-…` (its films reuse
 * the ids CY and CG). Switching to the other camera keeps this one's work and brings back that one's.
 */
type Family = 'gr4' | 'gr3';
const familyOf = (m: CameraModel): Family => (isGr3(m) ? 'gr3' : 'gr4');
const GR3_PROJECT = 'project-gr3.json';
/** The official file each camera takes (GR IV, GR III, GR IIIx: one file for all of each one's models),
 * kept once downloaded or opened: switching to another camera opens its file again without a download. */
type FwGroup = 'gr4' | 'gr3' | 'gr3x';
const fwGroupOf = (m: CameraModel): FwGroup => (m === 'GR3' || m === 'GR3_HDF' ? 'gr3' : m === 'GR3X' || m === 'GR3X_HDF' ? 'gr3x' : 'gr4');
const fwKey = (g: FwGroup): string => `firmware-${g}.bin`;
/** Up to 0.8.x one file was kept for whichever camera was open. */
const LEGACY_FW_KEY = 'firmware.bin';
const LEGACY_FW_GROUP: Record<string, FwGroup> = { 'fwdc248b.bin': 'gr4', 'fwdc239b.bin': 'gr3', 'fwdc243b.bin': 'gr3x' };
const LEGACY_FW_GROUP_NAME: Record<FwGroup, string> = { gr4: 'fwdc248b.bin', gr3: 'fwdc239b.bin', gr3x: 'fwdc243b.bin' };
/** The kept file of a camera, or null. A file kept by 0.8.x moves to its camera's place first. */
async function keptFirmware(g: FwGroup, legacyName?: string): Promise<Uint8Array | null> {
  const own = await host.storeGet(fwKey(g)).catch(() => null);
  if (own) return own;
  const legacy = await host.storeGet(LEGACY_FW_KEY).catch(() => null);
  if (!legacy) return null;
  // Its camera: by the name it was opened with, else by its size (the two GR III files differ in size, GR IV's is larger).
  const lg = (legacyName ? LEGACY_FW_GROUP[legacyName.toLowerCase()] : undefined) ?? (legacy.length === 30391780 ? 'gr3' : legacy.length === 30391788 ? 'gr3x' : 'gr4');
  // The old file is removed only once it is kept in its new place (else it is moved next time).
  if (await host.storeSet(fwKey(lg), legacy).then(() => true, () => false)) await host.storeDel(LEGACY_FW_KEY).catch(() => undefined);
  return lg === g ? legacy : null;
}
const presetKey = (id: SlotKey, fam: Family = familyOf(state.model)): string => (fam === 'gr3' ? 'gr3-preset-' : 'preset-') + id.toLowerCase();
type FamilyDoc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Each family's saved work as last loaded or saved; the open family's is taken from the state when saved. */
const familyDocs: Record<Family, FamilyDoc | null> = { gr4: null, gr3: null };
/** GR III work found in `project.json` itself (a data folder of the GR III test builds): its presets are `preset-…`. */
let gr3Legacy = false;
/** Changes whenever the open family changes: work still being loaded for the previous one is dropped. */
let familyGen = 0;
/** True while the open family's files are being read: a save meanwhile writes its work as loaded. */
let familyLoading = false;

function familyData(s: State): FamilyDoc {
  return {
    slots: Object.fromEntries(SLOT_IDS.map((id) => [id, {
      preset: s.slots[id].preset ? { fileName: s.slots[id].preset!.fileName, kind: s.slots[id].preset!.kind } : null,
      names: s.slots[id].names,
      icon: { mode: s.slots[id].icon.mode, text: s.slots[id].icon.text, style: s.slots[id].icon.style, image: s.slots[id].icon.image },
      ...(s.slots[id].halation ? { halation: s.slots[id].halation } : {}),
    }])),
    extras: s.extras.map((x) => ({ key: x.key, name: x.name, preset: x.preset ? { fileName: x.preset.fileName, kind: x.preset.kind } : null, icon: { mode: x.icon.mode, text: x.icon.text, style: x.icon.style, image: x.icon.image }, ...(x.halation ? { halation: x.halation } : {}) })),
    lookOrder: s.lookOrder, lookHidden: s.lookHidden, lookOrder3: s.lookOrder3, lookHidden3: s.lookHidden3,
    wall: s.wall.map((w) => ({ id: w.id, name: w.name, kind: 'image', width: w.width, height: w.height, crop: w.crop, ...(w.menuName !== undefined ? { menuName: w.menuName } : {}), ...(w.menuId ? { menuId: w.menuId } : {}) })),
    ratios: s.ratios.map((r) => ({ id: r.id, ratio: r.ratio, name: r.name })),
    soft: s.soft, dateStamp: s.dateStamp, monoUnlock: s.monoUnlock, directFlash: s.directFlash, filmCount: s.filmCount,
  };
}

/** The part of a family's saved work that needs no file: everything but presets and pictures. */
function parseFamily(doc: FamilyDoc | null): Partial<State> {
  const slots = emptySlots();
  for (const id of SLOT_IDS) {
    const d = doc?.slots?.[id];
    if (!d) continue;
    slots[id].names = d.names || {};
    if (d.icon) slots[id].icon = { mode: d.icon.mode || 'keep', text: d.icon.text || '', style: d.icon.style || 'film', image: d.icon.image };
    // GR III projects up to 0.8.0-gr3exp.9 kept the film's level as a number (1 Weak, 2 Strong).
    const h = validHalation(d.halation === 1 || d.halation === 2 ? { on: true, preview: d.halation === 2 ? 3 : 1 } : d.halation);
    if (h) slots[id].halation = h;
  }
  const extras: ExtraSlot[] = (Array.isArray(doc?.extras) ? doc!.extras : []).slice(0, MAX_EXTRA_SLOTS)
    .filter((x: ExtraSlot) => x && typeof x.key === 'string' && /^x-[a-z0-9]{1,12}$/.test(x.key))
    .map((x: ExtraSlot) => ({ key: x.key, name: String(x.name || '').slice(0, 40), icon: { mode: x.icon?.mode === 'image' ? 'image' : 'text', text: String(x.icon?.text ?? ''), style: x.icon?.style === 'plain' ? 'plain' : 'film', image: x.icon?.image }, ...(validHalation(x.halation) ? { halation: validHalation(x.halation)! } : {}) }));
  const ratios: RatioItem[] = (Array.isArray(doc?.ratios) ? doc!.ratios : []).slice(0, MAX_CUSTOM_RATIOS)
    .filter((r: RatioItem) => r && typeof r.id === 'string' && typeof r.ratio === 'string')
    .map((r: RatioItem) => ({ id: r.id, ratio: r.ratio.slice(0, 24), name: String(r.name || '').slice(0, 80) }));
  return {
    slots, extras, activeSlot: 'CY', wall: [], ratios, activeRatio: ratios[0]?.id,
    lookOrder: normalizeLookOrder(Array.isArray(doc?.lookOrder) ? doc!.lookOrder : [], extras),
    lookHidden: normalizeLookHidden(Array.isArray(doc?.lookHidden) ? doc!.lookHidden : [], extras),
    lookOrder3: gr3SavedKeys(doc?.lookOrder3), lookHidden3: gr3SavedKeys(doc?.lookHidden3).filter((k) => k !== 'g11'),
    soft: doc?.soft === true || (!!doc?.softFocus && typeof doc.softFocus === 'object' && Object.keys(doc.softFocus).length > 0),
    dateStamp: doc?.dateStamp === true, monoUnlock: doc?.monoUnlock === true, directFlash: doc?.directFlash === true,
    filmCount: Number.isInteger(doc?.filmCount) && doc!.filmCount >= 0 && doc!.filmCount <= GR3X_FILM_IDS.length ? doc!.filmCount : doc && doc.filmCount === undefined && doc.slots ? 9 : 0,
  };
}

/** The presets and pictures of a family's saved work (read from their files), unless the family changes meanwhile. */
async function loadFamilyFiles(doc: FamilyDoc | null, fam: Family, gen: number): Promise<void> {
  if (!doc || !host.available) return;
  const read = async (key: string): Promise<Uint8Array | null> => {
    const bytes = await host.storeGet(key).catch(() => null);
    // A GR III project kept in project.json: its presets are still under GR IV's names; moved once.
    if (!bytes && fam === 'gr3' && gr3Legacy && key.startsWith('gr3-preset-')) {
      const old = await host.storeGet(key.slice(4)).catch(() => null);
      if (old) await host.storeSet(key, old).catch(() => undefined);
      return old;
    }
    return bytes;
  };
  for (const id of SLOT_IDS) {
    const p = doc.slots?.[id]?.preset;
    if (!p) continue;
    const text = await read(presetKey(id, fam));
    if (gen !== familyGen) return;
    if (text) void runPreset(id, p.fileName, p.kind, new TextDecoder().decode(text));
  }
  for (const x of state.extras) {
    const p = (Array.isArray(doc.extras) ? doc.extras as { key: string; preset?: { fileName: string; kind: 'xmp' | 'cube' } | null }[] : []).find((d) => d.key === x.key)?.preset;
    if (!p) continue;
    const text = await read(presetKey(x.key, fam));
    if (gen !== familyGen) return;
    if (text) void runPreset(x.key, p.fileName, p.kind === 'xmp' ? 'xmp' : 'cube', new TextDecoder().decode(text));
  }
  const wall: WallItem[] = [];
  for (const w of doc.wall || []) {
    // the factory image of the start-up script's rotation (GR Mod 0.7) is in the camera's menu anyway
    if (w.kind === 'factory' || wall.length >= SHUTDOWN_MAX_PICTURES) continue;
    const bytes = await host.storeGet('wall-' + w.id).catch(() => null);
    if (gen !== familyGen) return;
    const menu = { menuName: typeof w.menuName === 'string' ? String(w.menuName).slice(0, 40) : menuNameOf(String(w.name || '')), menuId: validMenuId(w.menuId) ? w.menuId : newMenuId(wall) };
    if (bytes) wall.push({ id: w.id, name: w.name, blob: new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }), width: w.width, height: w.height, crop: w.crop, busy: true, ...menu });
  }
  set({ wall });
  for (const w of wall) void encodeWall(w.id);
}

/** The open family's work to save: the state, but presets and pictures still being read as they were saved. */
function currentFamilyDoc(): FamilyDoc {
  const data = familyData(state), doc = familyDocs[familyOf(state.model)];
  if (!familyLoading || !doc) return data;
  for (const id of SLOT_IDS) if (!data.slots[id].preset && doc.slots?.[id]?.preset) data.slots[id].preset = doc.slots[id].preset;
  for (const x of data.extras) if (!x.preset) x.preset = (Array.isArray(doc.extras) ? doc.extras : []).find((d: { key: string }) => d.key === x.key)?.preset ?? null;
  data.wall = Array.isArray(doc.wall) ? doc.wall : [];
  return data;
}
/** Before the open camera changes family: its work is kept (and saved with the next save). */
function leaveFamily(): void {
  familyDocs[familyOf(state.model)] = currentFamilyDoc();
  familyLoading = false;
  ++familyGen;
}
/** The work of the family now open: what needs no file at once, presets and pictures as they are read. */
function enterFamily(fam: Family): void {
  const gen = familyGen, doc = familyDocs[fam];
  set(parseFamily(doc));
  for (const id of allSlotKeys()) void renderIcon(id);
  if (!doc || !host.available) return;
  familyLoading = true;
  void loadFamilyFiles(doc, fam, gen).finally(() => {
    if (gen !== familyGen) return;
    familyLoading = false;
    scheduleSave();
  });
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
  familyDocs[familyOf(s.model)] = currentFamilyDoc();
  const doc = {
    ...(familyDocs.gr4 ?? {}),
    v: 1, page: s.page, model: s.model, lang: s.lang, fwName: s.fwName, showAll: s.showAll, previewMode: s.previewMode, ratioBackdrop: s.ratioBackdrop,
    tours: s.toursSeen, toursV: 2,
  };
  try {
    await host.storeSet('project.json', JSON.stringify(doc));
    if (familyDocs.gr3) await host.storeSet(GR3_PROJECT, JSON.stringify({ v: 1, ...familyDocs.gr3 }));
  } catch (e) { console.warn('save failed', e); }
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
      const model: CameraModel = ['GR3', 'GR3_HDF', 'GR3X', 'GR3X_HDF', 'HDF', 'STANDARD', 'MONO'].includes(doc.model) ? doc.model : 'HDF';
      const gr3Raw = await host.storeGet(GR3_PROJECT).catch(() => null);
      const gr3Doc = gr3Raw ? JSON.parse(new TextDecoder().decode(gr3Raw)) : null;
      if (gr3Doc && gr3Doc.v === 1) { familyDocs.gr4 = doc; familyDocs.gr3 = gr3Doc; }
      else if (familyOf(model) === 'gr3') { familyDocs.gr3 = doc; gr3Legacy = true; } // a GR III project of the test builds
      else familyDocs.gr4 = doc;
      const fam = familyOf(model), work = familyDocs[fam];
      set({ ...parseFamily(work), model,
        page: doc.page === 'wall' || doc.page === 'copies' || doc.page === 'ratio' || doc.page === 'ic' ? doc.page : doc.page === 'script' ? 'wall' : 'ic',
        lang: (LANGS as readonly string[]).includes(doc.lang) ? doc.lang : 'zh-CN', fwName: doc.fwName, showAll: !!doc.showAll,
        previewMode: doc.previewMode === 'swatch' ? 'swatch' : 'photo', ratioBackdrop: doc.ratioBackdrop === 'gray' ? 'gray' : 'photo',
        // GR Mod 0.8 changed the power-off page: its tour (which now says where the pictures are chosen) shows once more
        toursSeen: TOUR_IDS.filter((id) => Array.isArray(doc.tours) && doc.tours.includes(id) && (id !== 'wall' || doc.toursV >= 2)) });
      // The kept file of the camera that was open (a 0.8.x data folder: its one file moves to its camera's place).
      const fwRaw = await keptFirmware(fwGroupOf(model), doc.fwName);
      if (fwRaw) await openFirmware(fwRaw, LEGACY_FW_GROUP_NAME[fwGroupOf(model)], false);
      await loadFamilyFiles(work, fam, familyGen);
    } else {
      const fwRaw = await keptFirmware(fwGroupOf(state.model));
      if (fwRaw) await openFirmware(fwRaw, LEGACY_FW_GROUP_NAME[fwGroupOf(state.model)], false);
    }
  } catch (e) { console.warn('restore failed', e); }
  set({ ready: true });
  // A GR III project found in project.json goes to its own file at once.
  if (gr3Legacy) scheduleSave();
  void refreshVolumes();
  setInterval(() => { if (!document.hidden && !state.busy) void refreshVolumes(); }, 2500);
  for (const id of allSlotKeys()) void renderIcon(id);
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
/** Forget which tours were seen (and stop the one running): they start by themselves again. */
export function resetTours(): void { set({ tour: undefined, toursSeen: [] }); scheduleSave(); }
/** Finished or skipped: either way it is not started by itself again. */
export function endTour(): void {
  const tr = state.tour;
  if (!tr) return;
  set((s) => ({ tour: undefined, toursSeen: s.toursSeen.includes(tr.id) ? s.toursSeen : [...s.toursSeen, tr.id] }));
  scheduleSave();
}

// ------------------------------------------------------------------ settings
export function setPage(page: Page): void {
  if (page === 'wall' && isGr3(state.model) && state.info && !state.info.capabilities.menuPictures) return; // power-off pictures: GR III / IIIx with the End Screen menu
  set({ page }); scheduleSave(); if (page === 'copies') void refreshCopies();
}
export function setLang(lang: LangCode): void { set({ lang }); scheduleSave(); }
export function setModel(model: CameraModel): void {
  if (state.busy || state.fwBusy || model === state.model) return;
  const differentFamily = familyOf(state.model) !== familyOf(model);
  ++ratioGen;
  clearTimeout(ratioTimer);
  if (differentFamily) leaveFamily();
  const otherFile = !!state.info && !state.info.models.includes(model);
  if (otherFile) {
    void engine.reset();
    set({ info: undefined, raw: undefined, fwName: undefined, bridgeOpen: false, bridgeAfter: undefined,
      copyInfo: {}, copySel: [], ratios: state.ratios.map(({ preview, ...r }) => r) });
  }
  set({ model, ...(isGr3(model) ? { bridgeOpen: false, bridgeAfter: undefined } : {}) });
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
async function openFirmware(raw: Uint8Array, name: string, persist: boolean): Promise<boolean> {
  if (persist) while (keptOpening) await keptOpening;
  if (state.busy || state.fwBusy) return false;
  ++ratioGen;
  clearTimeout(ratioTimer);
  set({ fwBusy: true });
  try {
    const info = await engine.open(raw);
    const model = info.models.includes(state.model) ? state.model : info.models[0];
    const sameFamily = familyOf(state.model) === familyOf(model);
    if (!sameFamily) leaveFamily();
    set({ info, raw, model, fwName: info.filename, fwBusy: false, copyInfo: {}, copySel: [],
      ...(info.family === 'gr3x' ? { bridgeOpen: false, bridgeAfter: undefined } : {}) });
    // Opening the other camera's firmware brings back that camera's work.
    if (!sameFamily) enterFamily(familyOf(model));
    if (info.family === 'gr3x') set((s) => ({ dateStamp: s.dateStamp && info.features.dateStamp, monoUnlock: s.monoUnlock && info.features.monoUnlock }));
    if (info.family === 'gr3x') ratiosChanged(true);
    if (info.bridge && persist) toast(t('bridgeOpened'), 'info');
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
export function setOnlineOpen(onlineOpen: boolean, reason?: State['onlineReason']): void {
  set({ onlineOpen, onlineReason: onlineOpen ? reason : undefined, ...(onlineOpen ? {} : { bridgeAfter: undefined }) });
}
/** Take over a firmware file the shell downloaded; true when it is now the open firmware. */
export async function adoptFirmware(name: string, version: string, data: Uint8Array): Promise<boolean> {
  const after = state.bridgeAfter;
  const ok = await openFirmware(data, name, true);
  if (ok) toast(t('fwDownloaded', { v: version || state.info?.version || '' }), 'ok');
  if (ok && after) { set({ bridgeAfter: undefined }); setTimeout(() => { void outputBridge(after); }, 0); }
  return ok;
}
/** True while the open firmware is the 1.12 bridge firmware: nothing is written until the official one is open. */
export const bridgeLoaded = (s: State = state): boolean => !!s.info?.bridge;
/** What a write or export does while the bridge firmware is open: offer the official download instead. */
export function askForOfficial(): void { setOnlineOpen(true, 'bridge-loaded'); }
export function setBridgeOpen(bridgeOpen: boolean): void {
  if (bridgeOpen && (isGr3(state.model) || (state.info && !state.info.capabilities.bridge))) return;
  set({ bridgeOpen });
}

// ------------------------------------------------------------------ presets
const PRESET_ERRORS: Record<string, Key> = {
  'not-xmp': 'errNotXmp', 'no-table': 'errNoTable', 'look-profile-missing': 'errLookMissing', 'unsupported-table': 'errUnsupportedTable', 'bad-table': 'errUnsupportedTable',
  'not-cube': 'errNotXmp', 'bad-cube': 'errBadCube', 'gr3x-cube-only': 'gr3xCubeOnly',
};
/** The newest conversion of each slot: an older one that finishes later is dropped. */
const presetRuns = new Map<SlotKey, number>();
let presetRun = 0;
async function runPreset(id: SlotKey, fileName: string, kind: 'xmp' | 'cube', text: string): Promise<void> {
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

// ------------------------------------------------------------------ Image Control menu order / hidden looks
const FACTORY_LOOK_NAMES: Record<number, { zh: string; en: string }> = {
  11: { zh: '标准', en: 'Standard' }, 12: { zh: '鲜艳', en: 'Vivid' }, 13: { zh: '单色', en: 'Monotone' },
  14: { zh: '软单色', en: 'Soft Monotone' }, 15: { zh: '硬单色', en: 'Hard Monotone' }, 16: { zh: '高对比度黑白', en: 'Hi-Contrast B&W' },
  17: { zh: '正片', en: 'Positive Film' }, 18: { zh: '电影（黄色）', en: 'Cinema (Yellow)' }, 19: { zh: '电影（绿色）', en: 'Cinema (Green)' },
  20: { zh: '留银冲洗', en: 'Bleach Bypass' }, 21: { zh: '怀旧', en: 'Retro' }, 22: { zh: 'HDR色调', en: 'HDR Tone' },
  23: { zh: '正负逆冲', en: 'Cross Processing' }, 24: { zh: '负片', en: 'Negative Film' }, 25: { zh: '标准（单色）', en: 'Standard (mono)' },
  26: { zh: '柔和（单色）', en: 'Soft (mono)' }, 27: { zh: '高对比度（单色）', en: 'High Contrast (mono)' }, 28: { zh: '颗粒感（单色）', en: 'Grainy (mono)' },
  29: { zh: '无颗粒感（单色）', en: 'Solid (mono)' }, 30: { zh: 'HDR色调（单色）', en: 'HDR Tone (mono)' },
};
/** GR III / IIIx (round 8): its twelve looks in the camera's menu order, their numbers and names (the camera's texts). */
const GR3_LOOK_IDS: readonly number[] = [11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21];
const GR3_LOOK_NAMES: Record<number, { zh: string; en: string }> = {
  11: { zh: '标准', en: 'Standard' }, 12: { zh: '鲜艳', en: 'Vivid' }, 13: { zh: '单色', en: 'Monotone' },
  14: { zh: '软单色', en: 'Soft Monotone' }, 15: { zh: '硬单色', en: 'Hard Monotone' }, 16: { zh: '高对比度黑白', en: 'Hi-Contrast B&W' },
  17: { zh: '正片', en: 'Positive Film' }, 18: { zh: '留银冲洗', en: 'Bleach Bypass' }, 19: { zh: '怀旧', en: 'Retro' },
  20: { zh: 'HDR色调', en: 'HDR Tone' }, 21: { zh: '正负逆冲', en: 'Cross Processing' }, 22: { zh: '负片', en: 'Negative Film' },
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
  return [...FACTORY_LOOK_IDS.map(factoryLookKey), ...lookExtras(s).map((x) => x.key)];
}
/** The style number the firmware uses for a key (GR IV 11..30, or 34.. for added slots; GR III 11..22, films 64..). */
export function lookStyleOf(key: string, s: State = state): number | null {
  if (key.startsWith('g')) { const n = Number(key.slice(1)); return gr3Order(s) && lookKeys(s).includes(key) ? n : null; }
  if (key.startsWith('f')) { const n = Number(key.slice(1)); return FACTORY_LOOK_IDS.includes(n) ? n : null; }
  const i = lookExtras(s).findIndex((x) => x.key === key);
  return i < 0 ? null : 34 + i;
}
/** Only on the GR IV Monochrome (its six black-and-white looks). */
export function lookMonoOnly(key: string, s: State = state): boolean {
  const n = lookStyleOf(key, s);
  return !gr3Order(s) && n !== null && n >= 25 && n <= 30;
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
    const x = GR3_LOOK_NAMES[n]; if (x) return s.lang.startsWith('zh') ? x.zh : x.en;
    return key;
  }
  if (key.startsWith('f')) {
    const n = Number(key.slice(1));
    // Cinema Yellow / Green carry the name given to their slot (e.g. a preset's), when there is one.
    const own = n === 18 ? s.slots.CY.names[s.lang] : n === 19 ? s.slots.CG.names[s.lang] : undefined;
    if (own) return own;
    const x = FACTORY_LOOK_NAMES[n]; if (x) return s.lang.startsWith('zh') ? x.zh : x.en;
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
  return normalizeOrder(order, [...FACTORY_LOOK_IDS.map(factoryLookKey), ...extras.map((x) => x.key)]);
}
export function normalizeLookHidden(hidden: readonly string[], extras: readonly ExtraSlot[]): string[] {
  return normalizeHidden(hidden, [...FACTORY_LOOK_IDS.map(factoryLookKey), ...extras.map((x) => x.key)]);
}
/** GR III's saved order and hidden keys (kept apart from GR IV's), checked like GR IV's when a project opens. */
function gr3SavedKeys(list: unknown): string[] {
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
  return { order: order.map((k) => lookStyleOf(k, s)!), hidden: hidden.map((k) => lookStyleOf(k, s)!) };
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

// ------------------------------------------------------------------ halation of an added slot
/** A halation read from a saved project (older ones also kept the settings, now fixed), or null. */
function validHalation(v: unknown): HalationState | null {
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
async function renderIcon(id: SlotKey): Promise<void> {
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

// ------------------------------------------------------------------ power-off images
const wallBitmaps = new Map<string, ImageBitmap>();
export async function wallBitmap(w: WallItem): Promise<ImageBitmap | null> {
  if (!w.blob) return null;
  let b = wallBitmaps.get(w.id);
  if (!b) { b = await loadBitmap(w.blob); wallBitmaps.set(w.id, b); }
  return b;
}
const encodeGen = new Map<string, number>();
/** A picture of the firmware: the crop as it is, its own fixed size (see core aspect/shutdown.ts). */
async function encodeWall(id: string): Promise<void> {
  const w = state.wall.find((x) => x.id === id);
  if (!w || !state.info) return;
  const gen = (encodeGen.get(id) || 0) + 1; encodeGen.set(id, gen);
  setWall(id, { busy: true, error: undefined });
  try {
    const bmp = await wallBitmap(w);
    if (!bmp) throw new Error('no image');
    const rgb = cropToRgb(bmp, w.crop);
    const jpeg = await engine.menuPicture(rgb);
    if (encodeGen.get(id) !== gen) return;
    setWall(id, { busy: false, menuJpeg: jpeg, preview: rgb, error: undefined });
  } catch {
    if (encodeGen.get(id) !== gen) return;
    setWall(id, { busy: false, menuJpeg: undefined, preview: undefined, error: t('encodeFailed') });
  }
}
/** At most this many images (the camera's menu lists them). */
export const wallMax = (): number => SHUTDOWN_MAX_PICTURES;
export async function addWallFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (state.wall.length >= wallMax()) { toast(t('wallMax', { n: wallMax() }), 'info'); break; }
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|bmp|gif|avif)$/i.test(f.name)) continue;
    try {
      const bmp = await loadBitmap(f);
      const wc = await workingCopy(bmp);
      bmp.close();
      const id = Math.random().toString(36).slice(2, 10);
      const item: WallItem = { id, name: f.name, blob: wc.blob, width: wc.width, height: wc.height, crop: defaultCrop(wc.width, wc.height), busy: true, menuName: menuNameOf(f.name), menuId: newMenuId(state.wall) };
      set((s) => ({ wall: [...s.wall, item] }));
      if (host.available) void host.storeSet('wall-' + id, new Uint8Array(await wc.blob.arrayBuffer())).catch(() => undefined);
      void encodeWall(id);
    } catch (e) { fail(e); }
  }
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

// ------------------------------------------------------------------ power-off images chosen in the camera's menu
const validMenuId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
function newMenuId(wall: readonly WallItem[]): number {
  for (;;) {
    const id = 1 + Math.floor(Math.random() * 0xfffffffe);
    // Never one of GR III round 5's picture numbers (k << 24, k <= 8), which share the stored bytes.
    if ((id & 0xffffff) === 0 && id >>> 24 <= 8) continue;
    if (!wall.some((w) => w.menuId === id)) return id;
  }
}
/** A camera-list name from a file name: printable ASCII only, at most SHUTDOWN_NAME_MAX characters. */
export function menuNameOf(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  return (stem || 'Picture').slice(0, SHUTDOWN_NAME_MAX).trim();
}
export function setWallName(id: string, menuName: string): void { setWall(id, { menuName }); scheduleSave(); }
const SHUTDOWN_NAME_PROBLEMS: Record<string, Key> = { empty: 'wallNameEmpty', 'too-long': 'wallNameLong', 'bad-char': 'wallNameBad' };
/** Why an image cannot go into the camera's menu (null when it can). */
export function wallMenuProblem(w: WallItem): string | null {
  const p = validateShutdownName(w.menuName ?? '');
  if (p) return t(SHUTDOWN_NAME_PROBLEMS[p], { n: SHUTDOWN_NAME_MAX });
  if (w.busy) return t('converting');
  if (w.error || !w.menuJpeg) return w.error || t('encodeFailed');
  return null;
}
/** The pictures the firmware gets. */
export function menuPictures(s: State = state): ShutdownPictureSpec[] {
  return s.wall.filter((w) => !wallMenuProblem(w)).map((w) => ({ id: w.menuId!, name: w.menuName!.trim() === w.menuName ? w.menuName! : w.menuName!.trim(), jpeg: w.menuJpeg! }));
}
/** Every image is ready (names valid, encoded), and there is at least one. */
export function menuReady(s: State = state): boolean {
  return s.wall.length > 0 && s.wall.length <= SHUTDOWN_MAX_PICTURES && s.wall.every((w) => !wallMenuProblem(w));
}
export function setCrop(id: string, crop: Crop): void { setWall(id, { crop }); set({ cropId: undefined }); void encodeWall(id); scheduleSave(); }

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
/** Any addition that is not a slot or a ratio. */
export function extrasOn(s: State = state): boolean { return softOn(s) || !!s.dateStamp || monoUnlockOn(s) || hasLookLayout(s) || directFlashOn(s); }
const MINUS = '\u2212';
const strengthLabel = (st: SoftFocusStrength | 'custom'): string => t(st === 'weak' ? 'softWeak' : st === 'medium' ? 'softMedium' : st === 'strong' ? 'softStrong' : 'softCustom');
/** "−2 weak / −3 medium" (−1 first), for confirmations and the copies page. */
export function softText(list: readonly (SoftFocusRequest | ClarityChange)[]): string {
  return [...list].sort((a, b) => b.level - a.level).map((f) => `${f.level < 0 ? MINUS : '+'}${Math.abs(f.level)} ${strengthLabel(f.strength)}`).join(' / ');
}

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
export function setActiveSlot(id: SlotKey): void { if (state.activeSlot !== id) set({ activeSlot: id }); }

/** The desktop builds (Windows, macOS, Linux) can eject a card; the development build cannot. */
const canEject = (): boolean => host.info?.kind === 'windows' || host.info?.kind === 'mac' || host.info?.kind === 'linux';
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
    let role: card.CardRole | undefined;
    const v = volumes.find((x) => x.id === volumeId);
    if (v) { try { role = card.cardRole(await listing(v.root)); } catch { role = undefined; } }
    const same = JSON.stringify(volumes) === JSON.stringify(state.volumes) && volumeId === state.volumeId && role === state.role;
    if (!same) set({ volumes, volumeId, role });
    if (state.page === 'copies') void refreshCopies();
  } catch { /* shell gone or busy */ } finally { refreshing = false; }
}
export function selectVolume(id: string): void { set({ volumeId: id, role: undefined, parked: [], copySel: state.copySource === 'card' ? [] : state.copySel }); void refreshVolumes(); }
export function setShowAll(v: boolean): void { set({ showAll: v }); scheduleSave(); void refreshVolumes(); }

// ------------------------------------------------------------------ output
export interface SlotChange { id: SlotId; parts: string[]; labels: string[]; request: SlotRequest }
export function pendingChanges(s: State = state): SlotChange[] {
  if (!s.info?.capabilities.presets) return [];
  const out: SlotChange[] = [];
  if (!s.info || s.model === 'MONO') return out;
  for (const id of availableSlots(s)) {
    const sl = s.slots[id]; const off = s.info.slots.find((x) => x.id === id)!;
    const req: SlotRequest = { slot: id }; const parts: string[] = []; const labels: string[] = [];
    if (sl.preset?.result) { const r = sl.preset.result; req.preset = { matrixQ13: r.matrixQ13, curves: r.curves, ...(r.postQ9 ? { postQ9: r.postQ9 } : {}) }; parts.push(`${t('preset')} ${sl.preset.result.title || sl.preset.fileName}`); labels.push(t('preset')); }
    if (sl.icon.mode !== 'keep' && sl.icon.pixels) { req.icon = sl.icon.pixels; parts.push(t('icon')); labels.push(t('icon')); }
    const names: Partial<Record<LangCode, string>> = {};
    for (const lang of LANGS) {
      const v = sl.names[lang];
      if (v && v !== off.names[lang].text && !nameProblem(s.info, id, lang, v)) names[lang] = v;
    }
    if (Object.keys(names).length) { req.names = names; parts.push(`${t('name')} ${Object.values(names).join(' / ')}`); labels.push(`${t('name')} “${Object.values(names)[0]}”`); }
    // GR III / IIIx: every film has Halation. Builds with a film count set it in the camera (the level
    // here is the preview's); legacy builds without a film count fix it in the build (Weak, or Strong
    // for the preview's Medium / Strong).
    if (s.info.family === 'gr3x') {
      const h = sl.halation;
      if (h && h.preview > 0 && !filmCountChoosable(s)) { req.halation = h.preview === 1 ? 1 : 2; parts.push(`${t('halation')} ${t(h.preview === 1 ? 'haloWeak' : 'haloStrong')}`); labels.push(t('halation')); }
    } else if (req.preset && sl.halation?.on) { req.halation = true; parts.push(t('halation')); labels.push(t('halation')); }
    if (parts.length) out.push({ id, parts, labels, request: req });
  }
  return out;
}
export function hasNameErrors(s: State = state): boolean {
  if (!s.info?.capabilities.presets) return false;
  if (!s.info) return false;
  return availableSlots(s).some((id) => LANGS.some((lang) => !!nameProblem(s.info!, id, lang, s.slots[id].names[lang] || '')));
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
function doneToast(root: string, volume: Volume | undefined, moved: number, file: string): void {
  const text = (volume ? t('written', { p: host.join(root, file) }) : t('exported', { p: root })) + (moved ? ` · ${t('parked', { n: moved })}` : '');
  if (volume && canEject()) {
    toast(text, 'ok', { label: t('eject'), run: () => { host.eject(volume.id).then(() => { toast(t('ejected'), 'ok'); void refreshVolumes(); }).catch(fail); } });
  } else toast(text, 'ok', { label: t('reveal'), run: () => { void host.reveal(host.join(root, file)); } });
}

/** Turn a card into a firmware card holding `file` (what is in the way, such as a start-up script of GR Mod 0.7's power-off images, is moved aside). */
async function firmwareToCard(volume: Volume, file: Uint8Array): Promise<number> {
  return runPlan(volume.root, card.planFirmwareCard(await listing(volume.root), file, await freshStamp(volume.root), firmwareFilename()));
}

/** The update file name the open firmware's camera looks for (GR IV fwdc248b, GR IIIx fwdc243b, GR III fwdc239b). */
const firmwareFilename = (): card.FirmwareFilename => {
  const name = state.info?.filename;
  return (card.FIRMWARE_FILES as readonly string[]).includes(name ?? '') ? name as card.FirmwareFilename : card.FIRMWARE_FILE;
};

export async function outputFirmware(dest: Dest, stock = false): Promise<void> {
  if (!state.info?.models.includes(state.model)) return;
  if (!stock && !state.info.capabilities.build) { toast(t('fwCannotBuild'), 'info'); return; }
  if (state.busy || state.fwBusy || !state.info || !state.raw) return;
  if (bridgeLoaded()) { askForOfficial(); return; }
  const sourceInfo = state.info, sourceRaw = state.raw, sourceModel = state.model;
  const changes = stock ? [] : pendingChanges();
  const ratios = stock ? [] : ratioSpecs();
  if (!stock && state.info.family === 'gr3x' && ratios.length === 0) { toast(t('gr3xNeedRatio'), 'info'); return; }
  const soft = !stock && softOn();
  const dateStamp = !stock && !!state.dateStamp && !!state.info.features.dateStamp;
  const monoUnlock = !stock && monoUnlockOn();
  const directFlash = !stock && directFlashOn();
  if (!stock && (hasNameErrors() || hasRatioErrors())) return;
  if (!stock && hasExtraErrors()) { toast(t('extraIncomplete'), 'error'); return; }
  const extras = stock ? [] : extraSpecs();
  // GR III / IIIx: power-off pictures only on GR III / IIIx (End Screen › Picture, as
  // GR IV); elsewhere pictures left from a GR IV project are not sent.
  const noPictures = stock || (state.info?.family === 'gr3x' && !state.info.capabilities.menuPictures);
  if (!noPictures && state.wall.length > 0 && !menuReady()) { toast(t('wallMenuIncomplete'), 'error'); return; }
  const pictures = noPictures ? [] : menuPictures();
  const films = filmCountChoosable() ? state.filmCount : 0;
  const lookLayout = stock ? undefined : lookLayoutSpec();
  if (!stock && changes.length === 0 && ratios.length === 0 && !soft && !dateStamp && !monoUnlock && !directFlash && extras.length === 0 && pictures.length === 0 && films === 0 && !lookLayout) { toast(t('nothingToDo'), 'info'); return; }
  if (stock && !(await askOfficial([t('copyOfficial')]))) return;
  if (dest.kind === 'card' && !stock) {
    const lines = changes.map((c) => `${state.info?.family === 'gr3x' ? (state.slots[c.id].names[state.lang] || state.info.slots.find(s => s.id === c.id)?.defaultName || c.id) : t(('slot' + c.id) as Key)}  ·  ${c.labels.join(' / ')}`);
    if (ratios.length) lines.push(t('ratioLine', { n: ratios.length, l: ratios.map((r) => r.name).join(' / ') }));
    if (soft) lines.push(sourceInfo.features.softFocus === 'clarity' ? t('softLine', { l: softText(GR3X_SOFT_FOCUS) }) : t('softAdjLine'));
    // As GR IV's added slots: every film has Halation.
    if (films) lines.push(t('extraLine', { n: films, l: (state.info?.slots ?? []).slice(0, films).map((sl) => `${state.slots[sl.id]?.names[state.lang] || sl.defaultName} (${t('halation')})`).join(' / ') }));
    if (dateStamp) lines.push(t('dateLine'));
    if (monoUnlock) lines.push(t(state.info?.family === 'gr3x' ? 'gr3xReplicaLine' : 'monoLine'));
    if (directFlash) lines.push(t('flashLine'));
    if (extras.length) lines.push(t('extraLine', { n: extras.length, l: extras.map((x) => (x.halation ? `${x.name} (${t('halation')})` : x.name)).join(' / ') }));
    if (lookLayout) lines.push(t('lookOrderLine', { n: lookLayout.hidden.length }));
    if (pictures.length) lines.push(t('wallMenuLine', { n: pictures.length, l: pictures.map((p) => p.name).join(' / ') }));
    if (!(await ask(t('confirmTitle'), lines, t('confirmOk')))) return;
  }
  const target = await destination(dest);
  if (!target || state.info !== sourceInfo || state.raw !== sourceRaw || state.model !== sourceModel || state.fwBusy) return;
  try {
    let file: Uint8Array;
    if (stock) file = sourceRaw;
    else {
      set({ busy: t('building') });
      const clarity = soft && sourceInfo.features.softFocus === 'clarity' ? [...GR3X_SOFT_FOCUS] : [];
      const built = await engine.build(changes.map((c) => c.request), ratios, clarity,
        { adjSoftFocus: soft && sourceInfo.features.softFocus === 'adj', dateStamp, monoUnlock, ...(directFlash ? { directFlash } : {}), ...(extras.length ? { extraSlots: extras } : {}), ...(pictures.length ? { shutdownPictures: pictures } : {}),
          ...(films ? { filmCount: films } : {}), ...(lookLayout ? { lookLayout } : {}) });
      if (!Object.values(built.checks).every((v) => v === true)) throw new EngineError('selfcheck-failed', 'self-check');
      file = built.file;
      void recordBuild(file, changes);
    }
    set({ busy: t('writing') });
    let moved = 0;
    if (target.volume) moved = await firmwareToCard(target.volume, file);
    else await runPlan(target.root, [{ op: 'write', path: [firmwareFilename()], data: file }]);
    set({ busy: undefined });
    doneToast(target.root, target.volume, moved, firmwareFilename());
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}

/**
 * Write the 1.12 bridge firmware (made from the official file, see core `fw/bridge.ts`). With no
 * firmware open, the official one is downloaded first and the write continues after it.
 */
export async function outputBridge(dest: Dest): Promise<void> {
  if (isGr3(state.model) || (state.info && !state.info.capabilities.bridge)) return;
  if (state.busy || state.fwBusy) return;
  if (!state.info) { set({ bridgeAfter: dest }); setOnlineOpen(true, 'bridge-base'); return; }
  const sourceInfo = state.info, sourceModel = state.model;
  const target = await destination(dest);
  if (!target || state.info !== sourceInfo || state.model !== sourceModel || state.fwBusy) return;
  try {
    set({ busy: t('building') });
    const file = await engine.bridge();
    set({ busy: t('writing') });
    let moved = 0;
    if (target.volume) moved = await firmwareToCard(target.volume, file);
    else await runPlan(target.root, [{ op: 'write', path: [firmwareFilename()], data: file }]);
    set({ busy: undefined });
    doneToast(target.root, target.volume, moved, firmwareFilename());
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}

export function wallReady(s: State = state): boolean { return menuReady(s); }

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
  if (summary.kind === 'bridge') return [t('copyBridge')];
  const build = s.builds.find((b) => b.sha256 === summary.sha256);
  const lines = summary.slots.map((sl) => {
    const preset = build?.slots.find((x) => x.id === sl.id)?.preset;
    const parts = [sl.colorChanged ? preset || t('copyColor') : '', sl.iconChanged ? t('copyIcon') : '', sl.nameChanged ? t('copyName') : ''].filter(Boolean);
    return `${sl.names[s.lang]}  ·  ${parts.join(' / ') || t('original')}`;
  });
  if (summary.ratios.length) lines.push(t('ratioLine', { n: summary.ratios.length, l: summary.ratios.map((r) => r.name).join(' / ') }));
  if (summary.adjSoftFocus) lines.push(t('softAdjLine'));
  if (summary.dateStamp) lines.push(t('dateLine'));
  if (summary.monoUnlock) lines.push(t(state.info?.family === 'gr3x' ? 'gr3xReplicaLine' : 'monoLine'));
  if (summary.directFlash) lines.push(t('flashLine'));
  if (summary.extraSlots?.length) lines.push(t('extraLine', { n: summary.extraSlots.length, l: summary.extraSlots.map((x) => x.name).join(' / ') }));
  if (summary.lookLayout) lines.push(t('lookOrderLine', { n: summary.lookLayout.hidden.length }));
  if (summary.shutdownPictures?.length) lines.push(t('wallMenuLine', { n: summary.shutdownPictures.length, l: summary.shutdownPictures.map((p) => p.name).join(' / ') }));
  if (summary.softFocus?.length) lines.push(t('softLine', { l: softText(summary.softFocus) }));
  return lines;
}
/** Put the selected firmware copy (from the card's parked files or from a backup) on the card as the firmware to install. */
export async function writeCopy(): Promise<void> {
  if (!state.info?.models.includes(state.model)) return;
  const sourceInfo = state.info, sourceModel = state.model;
  const pick = writableCopy(); const source = state.copySource;
  const v = state.volumes.find((x) => x.id === state.volumeId);
  if (state.busy || state.fwBusy || !state.info) return;
  if (bridgeLoaded()) { askForOfficial(); return; }
  if (!pick) return;
  if (!v) { toast(t('noCard'), 'error'); return; }
  const official = pick.summary.kind === 'official';
  if (!(await (official ? askOfficial(describeCopy(pick.summary)) : ask(t('confirmTitle'), describeCopy(pick.summary), t('confirmOk'))))) return;
  if (state.info !== sourceInfo || state.model !== sourceModel || state.fwBusy) return;
  try {
    set({ busy: t('opening') });
    const file = source === 'card' ? await host.parkedRead(v.id, pick.entry.path) : await host.backupRead(pick.entry.path);
    // look at the bytes that will actually be written, not at what was seen earlier
    const now = await engine.inspect(file.slice());
    if (!now.verified || now.sha256 !== pick.summary.sha256) throw new EngineError('selfcheck-failed', t('copyUnverified'));
    set({ busy: t('writing') });
    const moved = await firmwareToCard(v, file);
    set({ busy: undefined });
    doneToast(v.root, v, moved, firmwareFilename());
  } catch (e) { set({ busy: undefined }); fail(e); }
  await refreshCopies();
  void refreshVolumes();
}
