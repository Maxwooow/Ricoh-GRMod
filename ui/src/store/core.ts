import { useSyncExternalStore } from 'react';
import { CAMERA_GRID, card, defaultFramingGuides, GR3X_FILM_IDS, GRID_LINE_COUNT, LANGS } from '@grmod/core';
import type { CameraModel, CustomGrid, FirmwareInfo, FramingGuides, FirmwareSummary, LangCode, PresetResult, RatioPreview, ShadeTone, SlotId } from '@grmod/core';

/** How dark the live-view shade is: black at 50 % or grey at 25 % (core's ShadeTone). */
export type { ShadeTone };
import { EngineError } from '../engine';
import { HostError } from '../host';
import type { ParkedEntry, Volume } from '../host';
import { t, uiLangPref } from '../i18n';
import type { Crop } from '../pixels';
import { SUPPORTED_LINES } from '../releases.gen';

/** `extras`: the additions (switches, the custom grid); 0.8.16 and earlier had a page of its own for the grid (`grid`). */
export type Page = 'ic' | 'ratio' | 'extras' | 'wall' | 'copies';
/** What the additions page shows: the list of additions, or the custom grid's editor (opened from its card). */
export type ExtrasView = 'list' | 'grid';
/** The camera's own grids, as custom grid lines (a fresh copy to edit). */
export const cameraGrid = (): CustomGrid => ({ g3: [...CAMERA_GRID.g3], g4: [...CAMERA_GRID.g4] });
/** Grid lines as saved in the project: eight booleans per style, else the camera's own. */
export function savedGridLines(v: unknown): CustomGrid {
  const ok = (x: unknown): x is boolean[] => Array.isArray(x) && x.length === GRID_LINE_COUNT && x.every((b) => typeof b === 'boolean');
  const g = v as Partial<CustomGrid> | undefined;
  const base = cameraGrid();
  return { g3: ok(g?.g3) ? [...g!.g3] : base.g3, g4: ok(g?.g4) ? [...g!.g4] : base.g4 };
}
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
export const TOUR_IDS: readonly TourId[] = ['overview', 'ic', 'ratio', 'extras', 'wall', 'copies'];
/** The tour being shown: `steps` are the indices of its steps that have something to point at; a replay can be skipped. */
export interface TourState { id: TourId; steps: number[]; index: number; replay: boolean }
/** `reset`: the firmware written is the official one; the dialog asks in red whether the camera's settings were reset first. */
export interface Confirm { title: string; warn?: string; reset?: boolean; lines: string[]; ok: string; resolve: (v: boolean) => void }
export interface State {
  ready: boolean; page: Page; extrasView: ExtrasView;
  fwName?: string; fwBusy: boolean; info?: FirmwareInfo; raw?: Uint8Array;
  model: CameraModel; lang: LangCode;
  /** The camera language follows the system's (lang is then systemCameraLang()): the app language is "follow system". */
  langAuto: boolean;
  slots: Record<SlotId, SlotState>;
  wall: WallItem[];
  ratios: RatioItem[]; activeRatio?: string; ratioBackdrop: RatioBackdrop;
  /** GR IV rear-LCD Auto curve, off by default. */
  brightAuto: false | 'bright' | 'balanced';
  soft: boolean; dateStamp: boolean; monoUnlock: boolean;
  /** GR IV: Direct Flash, a fifth Flash Mode (GR III / IIIx have the GF-2 mode of their own). */
  directFlash: boolean;
  /** An HDR gain map in the JPEGs (switched in the camera: Shooting menu › HDR). */
  hdr: boolean;
  /** GR IV 1.20: exposure preview as a camera setting (Shooting › Exposure Settings, ADJ lever). */
  exposurePreview: boolean;
  /** GR IV: live view of the added ratios shows the whole frame with the part outside darkened, instead of the photo area only. */
  ratioShade: boolean;
  /** How dark the live-view shade is (UI palette black 50 % / grey 25 %). */
  ratioShadeTone: ShadeTone;
  /** GR IV 1.20 / 1.21: the shade level the ratio page previews (not saved). */
  shadePreview: '100' | '75' | '50' | '25' | '0';
  /** GR IV: the battery icon shows the charge in steps of 10 % instead of the bars. */
  battery: boolean;
  /** GR IV: custom grid lines (`gridLines`) instead of the camera's own grids. */
  customGrid: boolean;
  /** Which lines the camera's 3x3 and 4x4 grids draw with `customGrid` on (core: CustomGrid); GR IV 1.11. */
  gridLines: CustomGrid;
  /** GR IV 1.20 / 1.21: the framing guides drawn with `customGrid` on, in place of `gridLines` (core: FramingGuides). */
  framing: FramingGuides;
  /** The learned Auto for Shadow Correction (GR IV 1.11 / 1.20 / 1.21; off by default). */
  shadowLearn: boolean;
  /** GR IV 1.20 / 1.21: GR Mod's film grain in place of the camera's Grain Effect (off by default). */
  filmGrain: boolean;
  /** GR IV 1.20 / 1.21: pre-flash (TTL) metering for a GF-2 class flash in the two red-eye flash modes (off by default). */
  flashTtl: boolean;
  /** GR IV 1.20 / 1.21: movie AF driven by the phase data (off by default). */
  videoAf: boolean;
  /** GR IV 1.20 / 1.21: the learned auto white balance for the three Auto modes (off by default). */
  awbLearn: boolean;
  /** GR IV 1.20 / 1.21: movies in the exposure mode of the mode dial, shutter speed, aperture and ISO adjustable (off by default). */
  movieExposure: boolean;
  /** Constant Light (GR IV 1.20 / 1.21): the front lamp kept lit, switched in the camera. */
  constantLight: boolean;
  /** Sensor Shift (GR IV 1.20 / 1.21): the picture moved and turned by hand with the shake reduction unit, from ADJ mode or a button. */
  sensorShift: boolean;
  /** 4K movies (GR IV 1.20 / 1.21): the movie menu's Frame Rate becomes Frame Rate / Resolution. */
  movie4k: boolean;
  /** Shake reduction for movies by sensor shift (GR IV 1.20 / 1.21): Movie SR offers Off / Sensor Shift / Electronic. */
  movieSr: boolean;
  /** Distances in feet (GR IV 1.20 / 1.21): Snap Focus Distance and the manual focus scale; metres by default. */
  distanceFeet: boolean;
  /** ADJ lever slots in the build: 5 (the camera's) to 8 (GR IV). */
  adjSlots: number;
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
  tour?: TourState; toursSeen: TourId[];
  /** Android: a firmware file on its way to the camera over Wi-Fi (camera.tsx shows the dialog while it is set). */
  push?: { file: Uint8Array; label: string; stock: boolean };
}

export const SLOT_IDS: readonly SlotId[] = GR3X_FILM_IDS;
/** GR IIIx 1.60 and GR III 2.10: one program, one code path in GR Mod. */
export const isGr3 = (m?: CameraModel): boolean => m === 'GR3X_HDF' || m === 'GR3_HDF' || m === 'GR3X' || m === 'GR3';
/** The film count can be chosen (GR III / IIIx: 1..20, each film with Halation in the camera). */
export const filmCountChoosable = (s: State = state): boolean => s.info?.family === 'gr3x' && (s.info.features.maxFilms ?? 9) > 9;
/** The slots of the open firmware the page shows: on GR III / IIIx the first `filmCount`. */
export const shownSlots = (s: State = state): FirmwareInfo['slots'] => (s.info ? (filmCountChoosable(s) ? s.info.slots.slice(0, s.filmCount) : s.info.slots) : []);
export const availableSlots = (s: State = state): SlotId[] => s.info ? shownSlots(s).map(slot => slot.id) : (isGr3(s.model) ? [...GR3X_FILM_IDS] : ['CY', 'CG']);
export const emptySlot = (): SlotState => ({ names: {}, icon: { mode: 'keep', text: '', style: 'film' } });
export const emptySlots = (): Record<SlotId, SlotState> => Object.fromEntries(SLOT_IDS.map(id => [id, emptySlot()])) as Record<SlotId, SlotState>;
export let state: State = {
  ready: false, page: 'ic', extrasView: 'list', fwBusy: false, model: 'HDF', lang: cameraLang(), langAuto: uiLangPref() === '',
  slots: emptySlots(), extras: [], lookOrder: [], lookHidden: [], lookOrder3: [], lookHidden3: [], wall: [], ratios: [], ratioBackdrop: 'photo', brightAuto: false, soft: false, dateStamp: false, monoUnlock: false, directFlash: false, hdr: false, exposurePreview: false, filmGrain: false, shadowLearn: false, ratioShade: false, ratioShadeTone: 'dark', shadePreview: '75', battery: false, customGrid: false, gridLines: cameraGrid(), framing: defaultFramingGuides(), flashTtl: false, videoAf: false, awbLearn: false, movieExposure: false, sensorShift: false, movie4k: false, movieSr: false, distanceFeet: false, constantLight: false, adjSlots: 5, filmCount: 0, previewMode: 'photo', photoRev: 0, activeSlot: 'CY', volumes: [],
  copySource: 'card', parked: [], backups: [], copySel: [], copyInfo: {}, builds: [], showAll: false, toasts: [], onlineOpen: false, toursSeen: [],
};
const listeners = new Set<() => void>();
export function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export const getState = (): State => state;
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state));
}
export function setSlot(id: SlotId, patch: Partial<SlotState> | ((s: SlotState) => Partial<SlotState>)): void {
  set((s) => ({ slots: { ...s.slots, [id]: { ...s.slots[id], ...(typeof patch === 'function' ? patch(s.slots[id]) : patch) } } }));
}
export const isExtra = (k: SlotKey): boolean => k.startsWith('x-');
/** The preset and icon of a factory or an added slot. */
export function slotOf(k: SlotKey, s: State = state): { preset?: PresetState; icon: IconState } | undefined {
  return isExtra(k) ? s.extras.find((x) => x.key === k) : s.slots[k as SlotId];
}
export function patchSlot(k: SlotKey, patch: { preset?: PresetState; icon?: IconState } | ((s: { preset?: PresetState; icon: IconState }) => { preset?: PresetState; icon?: IconState })): void {
  if (!isExtra(k)) { setSlot(k as SlotId, patch as Partial<SlotState>); return; }
  set((s) => ({ extras: s.extras.map((x) => (x.key === k ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)) }));
}
export function setWall(id: string, patch: Partial<WallItem>): void {
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
export function ask(title: string, lines: string[], ok: string, warn?: string, reset = false): Promise<boolean> {
  return new Promise((resolve) => set({ confirm: { title, warn, lines, ok, resolve, ...(reset ? { reset } : {}) } }));
}
/**
 * The warning for a firmware made from (or being) one of the cameras' newer releases (GR IV 1.20 / 1.21,
 * GR III 2.20 / 2.21, GR IIIx 1.70 / 1.71): a camera that installs it cannot go back to an earlier release.
 */
export function newFirmwareWarning(info: FirmwareInfo | undefined): string | null {
  if (!info) return null;
  const newer = info.family === 'gr4' ? ['1.20', '1.21'] : ['2.20', '1.70', '2.21', '1.71'];
  return newer.includes(info.version) ? t('newFwWriteLine') : null;
}
/**
 * Before the official firmware goes back on the camera: settings made with GR Mod's firmware (an
 * added slot or ratio selected, soft focus on the ADJ lever, the date imprint, added slots'
 * parameters) are values the official firmware does not know and may freeze on. The dialog says so
 * in red and its button confirms that the camera was reset to factory defaults.
 */
export function askOfficial(lines: string[], warn?: string): Promise<boolean> {
  return ask(t('resetConfirmTitle'), lines, t('resetConfirmOk'), warn, true);
}
export function answerConfirm(v: boolean): void { const c = state.confirm; set({ confirm: undefined }); c?.resolve(v); }
/** The official releases a firmware file can be, for the message an unusable file gets. */
export function supportedList(): string { return SUPPORTED_LINES.map((l) => `${l.name} ${l.versions.join(' / ')}`).join(t('listSep')); }
export function fail(e: unknown): void {
  const code = e instanceof HostError || e instanceof EngineError ? e.code : '';
  const msg = e instanceof Error ? e.message : String(e);
  console.error(e);
  toast(`${t('error')}${code ? ` · ${code}` : ''}${msg && msg !== code ? ` · ${msg}` : ''}`.slice(0, 220), 'error');
}

/**
 * The camera language (whose names Image Control changes) follows the app language: 简体中文 → zh-CN, the others → the
 * camera's same language, following the system → the system's language where the camera has it (else English).
 */
export function cameraLang(): LangCode {
  const ui = uiLangPref();
  return ui === 'zh' ? 'zh-CN' as LangCode : ui ? ui as LangCode : systemCameraLang();
}
/** The camera language closest to the phone's own: its first language GR IV has, else English. */
export function systemCameraLang(): LangCode {
  const have = LANGS as readonly string[];
  for (const raw of navigator.languages?.length ? navigator.languages : [navigator.language || 'en']) {
    const l = raw.toLowerCase();
    if (l.startsWith('zh')) return (/-(tw|hk|mo)|hant/.test(l) ? 'zh-TW' : 'zh-CN') as LangCode;
    const base = l.split('-')[0];
    if (have.includes(base)) return base as LangCode;
  }
  return 'en' as LangCode;
}
/** The app language (and with it the camera language): kept, the work saved with it, then the page reloads in it. */
