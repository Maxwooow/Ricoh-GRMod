import { GR3X_FILM_IDS, MAX_CUSTOM_RATIOS, MAX_EXTRA_SLOTS, SHUTDOWN_MAX_PICTURES } from '@grmod/core';
import type { CameraModel } from '@grmod/core';
import { engine } from '../engine';
import { host, isMobile } from '../host';
import { uiLangPref } from '../i18n';
import { ensureIconFont } from '../pixels';
import { ExtraSlot, RatioItem, SLOT_IDS, SlotKey, State, TOUR_IDS, WallItem, emptySlots, isGr3, savedGridLines, set, state } from './core';
import { langOf, openFirmware } from './settings';
import { allSlotKeys, renderIcon, runPreset, validHalation } from './slots';
import { gr3SavedKeys, normalizeLookHidden, normalizeLookOrder } from './looks';
import { encodeWall, menuNameOf, newMenuId, validMenuId } from './wall';
import { loadPreviewPhoto } from './photo';
import { refreshVolumes } from './output';
import { loadBuilds } from './copies';
import { savedFraming } from './framing';

// ------------------------------------------------------------------ camera families
/**
 * GR IV and GR III / IIIx keep their own work: Image Control slots or films with their presets,
 * added slots, the menu order, pictures, ratios and switches. GR IV's is `project.json` as it
 * always was (older versions of GR Mod read it unchanged; the settings of the program itself are
 * there too); GR III / IIIx's is `project-gr3.json`, its presets `gr3-preset-…` (its films reuse
 * the ids CY and CG). Switching to the other camera keeps this one's work and brings back that one's.
 */
type Family = 'gr4' | 'gr3';
export const familyOf = (m: CameraModel): Family => (isGr3(m) ? 'gr3' : 'gr4');
const GR3_PROJECT = 'project-gr3.json';
/** The official file each camera takes (GR IV, GR III, GR IIIx: one file for all of each one's models),
 * kept once downloaded or opened: switching to another camera opens its file again without a download. */
type FwGroup = 'gr4' | 'gr3' | 'gr3x';
export const fwGroupOf = (m: CameraModel): FwGroup => (m === 'GR3' || m === 'GR3_HDF' ? 'gr3' : m === 'GR3X' || m === 'GR3X_HDF' ? 'gr3x' : 'gr4');
export const fwKey = (g: FwGroup): string => `firmware-${g}.bin`;
/** Up to 0.8.x one file was kept for whichever camera was open. */
const LEGACY_FW_KEY = 'firmware.bin';
const LEGACY_FW_GROUP: Record<string, FwGroup> = { 'fwdc248b.bin': 'gr4', 'fwdc239b.bin': 'gr3', 'fwdc243b.bin': 'gr3x' };
export const LEGACY_FW_GROUP_NAME: Record<FwGroup, string> = { gr4: 'fwdc248b.bin', gr3: 'fwdc239b.bin', gr3x: 'fwdc243b.bin' };
/** The kept file of a camera, or null. A file kept by 0.8.x moves to its camera's place first. */
export async function keptFirmware(g: FwGroup, legacyName?: string): Promise<Uint8Array | null> {
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
export const presetKey = (id: SlotKey, fam: Family = familyOf(state.model)): string => (fam === 'gr3' ? 'gr3-preset-' : 'preset-') + id.toLowerCase();
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
    brightAuto: s.brightAuto, soft: s.soft, dateStamp: s.dateStamp, monoUnlock: s.monoUnlock, directFlash: s.directFlash, hdr: s.hdr, exposurePreview: s.exposurePreview, flashTtl: s.flashTtl, videoAf: s.videoAf, awbLearn: s.awbLearn, movieExposure: s.movieExposure, sensorShift: s.sensorShift, movie4k: s.movie4k, movieSr: s.movieSr, distanceFeet: s.distanceFeet, constantLight: s.constantLight, filmGrain: s.filmGrain, shadowLearn: s.shadowLearn, ratioShade: s.ratioShade, ratioShadeTone: s.ratioShadeTone, battery: s.battery, customGrid: s.customGrid, gridLines: s.gridLines, framing: s.framing, adjSlots: s.adjSlots, filmCount: s.filmCount,
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
    brightAuto: doc?.brightAuto === 'balanced' ? 'balanced' : doc?.brightAuto === true || doc?.brightAuto === 'bright' ? 'bright' : false,
    soft: doc?.soft === true || (!!doc?.softFocus && typeof doc.softFocus === 'object' && Object.keys(doc.softFocus).length > 0),
    dateStamp: doc?.dateStamp === true, monoUnlock: doc?.monoUnlock === true, directFlash: doc?.directFlash === true, hdr: doc?.hdr === true, exposurePreview: doc?.exposurePreview === true, filmGrain: doc?.filmGrain === true, shadowLearn: doc?.shadowLearn === true, ratioShade: doc?.ratioShade === true, ratioShadeTone: doc?.ratioShadeTone === 'light' ? 'light' : 'dark', battery: doc?.battery === true, customGrid: doc?.customGrid === true, gridLines: savedGridLines(doc?.gridLines), framing: savedFraming(doc?.framing, savedGridLines(doc?.gridLines)), flashTtl: doc?.flashTtl === true, videoAf: doc?.videoAf === true, awbLearn: doc?.awbLearn === true, movieExposure: doc?.movieExposure === true, sensorShift: doc?.sensorShift === true, movie4k: doc?.movie4k === true, movieSr: doc?.movieSr === true, distanceFeet: doc?.distanceFeet === true, constantLight: doc?.constantLight === true, adjSlots: typeof doc?.adjSlots === 'number' && Number.isInteger(doc.adjSlots) && doc.adjSlots >= 5 && doc.adjSlots <= 8 ? doc.adjSlots : 5,
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
export function leaveFamily(): void {
  familyDocs[familyOf(state.model)] = currentFamilyDoc();
  familyLoading = false;
  ++familyGen;
}
/** The work of the family now open: what needs no file at once, presets and pictures as they are read. */
export function enterFamily(fam: Family): void {
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
/** Drops a save that is still waiting (the work on screen is about to be replaced). */
export function cancelSave(): void { clearTimeout(saveTimer); }
export function scheduleSave(): void {
  if (!host.available || !state.ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void saveProject(); }, 400);
}
export async function saveProject(): Promise<void> {
  const s = state;
  familyDocs[familyOf(s.model)] = currentFamilyDoc();
  const doc = {
    ...(familyDocs.gr4 ?? {}),
    v: 1, page: s.page, model: s.model, lang: s.lang, langAuto: s.langAuto, uiLang: uiLangPref(), fwName: s.fwName, showAll: s.showAll, previewMode: s.previewMode, ratioBackdrop: s.ratioBackdrop,
    tours: s.toursSeen, toursV: 2,
  };
  try {
    await host.storeSet('project.json', JSON.stringify(doc));
    if (familyDocs.gr3) await host.storeSet(GR3_PROJECT, JSON.stringify({ v: 1, ...familyDocs.gr3 }));
  } catch (e) { console.warn('save failed', e); }
}
export async function init(): Promise<void> {
  if (!host.available) { set({ ready: true }); return; }
  if (!isMobile) void engine.heartbeat(host.info!.token);
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
        page: doc.page === 'wall' || doc.page === 'copies' || doc.page === 'ratio' || doc.page === 'extras' || doc.page === 'ic' ? doc.page : doc.page === 'script' ? 'wall' : doc.page === 'grid' ? 'extras' : 'ic',
        ...langOf(doc), fwName: doc.fwName, showAll: !!doc.showAll,
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
  if (!isMobile) {
    void refreshVolumes();
    setInterval(() => { if (!document.hidden && !state.busy) void refreshVolumes(); }, 2500);
  }
  for (const id of allSlotKeys()) void renderIcon(id);
}
