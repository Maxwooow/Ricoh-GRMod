// SPDX-License-Identifier: GPL-2.0-only
/**
 * The store's tools: undo for deletes, the inspect and compare dialogs, keyboard shortcuts, the preset
 * library, project export / import, snapshots, the card space check, slot duplicates and batch presets.
 *
 * @decision DEC-STORE-TOOLS-001: one part beside the others rather than spread over them. It imports
 * from them like any other part; the few internals it needs from families.ts (the pending save,
 * restoreProject, the import flag) are exported there as small functions. The error hints that `fail`
 * shows live in core.ts, because core is the part every other one imports and imports none itself.
 */
import { engine } from '../engine';
import { host } from '../host';
import type { Volume } from '../host';
import { t, uiLangPref } from '../i18n';
import type { Key } from '../i18n';
import { fmtSize } from './copies';
import { ask, dismissToast, fail, isExtra, patchSlot, set, shownSlots, slotOf, state, toast } from './core';
import type { ExtraSlot, InspectView, SlotKey, State, TourId } from './core';
import { GR3_PROJECT, cancelPendingSave, currentFamilyDoc, enterFamily, familyDocs, endFamilyLoad, familyOf, presetKey, restoreProject, clearSaveFailing, saveProject, saveTimer, scheduleSave, setImportingProject } from './families';
import type { Family, FamilyDoc } from './families';
import { extraName, normalizeLookOrder } from './looks';
import { outputFirmware, refreshVolumes } from './output';
import { setActiveSlot } from './photo';
import { setActiveRatio } from './ratios';
import { addExtraSlot, allSlotKeys, loadPresetFile, presetRuns, nextPresetRun, renderIcon, runPreset, fitOptions } from './slots';
import { CameraModel, EXTRA_NAME_MAX, MAX_EXTRA_SLOTS, PresetResult, SlotId, color } from '@grmod/core';

// ------------------------------------------------------------------ QoL wave B: undo for deletes
/**
 * @decision DEC-QOLB-UNDO-001
 * @title One last-deleted record; host files are deleted only when the undo window closes
 * @status accepted
 * @rationale Removing an added slot, a ratio or a picture used to be final at once. The delete now
 *   leaves one record (a new delete replaces it) and a toast with an Undo button. Everything the
 *   item needs to come back is already in memory (preset text, icon, blob, preview), so the only
 *   thing deferred is the removal of its host store files (`preset-<key>`, `wall-<id>`): `commit`
 *   runs when the toast's window ends, or when another delete replaces the record. Deleting the files at once and re-writing them on undo would work too, but a
 *   crash in between would then lose the preset for good; an orphaned file after a crash only costs a few kB.
 */
interface Deleted { family: Family; restore: () => boolean; commit: () => void; timer: ReturnType<typeof setTimeout>; toastId: number }
let lastDeleted: Deleted | undefined;
const UNDO_MS = 12000;
/** Whether a delete can still be taken back. */
export const undoPending = (): boolean => !!lastDeleted;
/** Close the undo window: the deferred file delete runs and the record's own toast goes. */
function flushDeleted(): void { const d = lastDeleted; lastDeleted = undefined; if (d) { clearTimeout(d.timer); dismissToast(d.toastId); d.commit(); } }
/**
 * `restore` puts the item back and returns false (changing nothing) when it cannot: the list is full again
 * (delete one, add one, undo would exceed the cap). The toast's button is bound to this record, not to
 * "whatever is pending now": a superseded toast is dismissed with its record, and a press that still gets through says so.
 */
export function recordDeleted(text: string, restore: () => boolean, commit: () => void): void {
  flushDeleted();
  const d: Deleted = { family: familyOf(state.model), restore, commit, timer: setTimeout(() => { if (lastDeleted === d) flushDeleted(); }, UNDO_MS), toastId: 0 };
  lastDeleted = d;
  d.toastId = toast(text, 'info', { label: t('undo'), run: () => { if (lastDeleted === d) undoDelete(); else toast(t('undoGone'), 'info'); } });
}
/** Take the last delete back (the toast's button and Cmd/Ctrl+Z). */
export function undoDelete(): void {
  const d = lastDeleted; if (!d) return;
  lastDeleted = undefined; clearTimeout(d.timer); dismissToast(d.toastId);
  // Compared by camera family, not model: HDF to Standard keeps the same slots, ratios and pictures. Another family has other lists.
  if (d.family !== familyOf(state.model)) { d.commit(); return; }
  if (!d.restore()) { d.commit(); toast(t('undoFull'), 'info'); return; }
  scheduleSave();
}

// ------------------------------------------------------------------ QoL wave B: inspect any firmware file
/**
 * @decision DEC-QOLB-INSPECT-001
 * @title Inspect compares with the open official firmware, so it needs one open
 * @status accepted
 * @rationale engine.inspect (core app/engine.ts) diffs a file against the official firmware the
 *   engine has open and reports kind / verified / features; the summary carries no model or version
 *   of its own. The dialog therefore names the open firmware (family and version) as the reference
 *   and asks for one when none is open, instead of guessing a model from the bytes.
 */
let inspectGen = 0;
export function closeInspect(): void { inspectGen++; set({ inspectView: undefined }); }
export async function inspectFile(file: File): Promise<void> {
  const gen = ++inspectGen;
  const view = { name: file.name, size: file.size };
  if (!state.info) { set({ inspectView: { ...view, busy: false, error: 'needs-open' } }); return; }
  if (file.size < 1_000_000 || file.size > 200_000_000) { set({ inspectView: { ...view, busy: false, error: 'size' } }); return; }
  set({ inspectView: { ...view, busy: true } });
  try {
    const summary = await engine.inspect(new Uint8Array(await file.arrayBuffer()));
    if (gen === inspectGen) set({ inspectView: { ...view, busy: false, summary } });
  } catch (e) {
    console.warn('inspect', e);
    if (gen === inspectGen) set({ inspectView: { ...view, busy: false, error: 'unreadable' } });
  }
}

// ------------------------------------------------------------------ QoL wave B: keyboard shortcuts
/**
 * @decision DEC-QOLB-KEYS-001
 * @title One global handler in the store; it yields to anything that already owns the key
 * @status accepted
 * @rationale Cmd/Ctrl+E (export to a folder, through the build summary), Cmd/Ctrl+Z (undo the last
 *   delete, only while one is pending) and the arrow keys (Left/Right through the Image Control
 *   slots, whose tabs are horizontal; Up/Down through the ratios, a vertical list). The handler is a
 *   plain function of the key event so it can be tested without a DOM, and app.tsx only installs it
 *   on window. It does nothing while the focus is in a field (the browser's own text undo and
 *   caret keys win), while a dialog, the crop editor, the guided tour or a busy overlay is up,
 *   with Alt held, or when a widget already handled the key (`defaultPrevented`: the tab lists,
 *   the compare slider, select menus). Escape is never touched: the dialogs keep their own handlers.
 */
export interface ShortcutKey {
  key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean;
  target?: unknown; preventDefault?: () => void;
}
const typing = (target: unknown): boolean => {
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName ?? '') || !!el.isContentEditable || !!el.closest?.('[contenteditable="true"],[role="listbox"],[role="menu"],[role="slider"]');
};
/** The slot keys the Image Control page shows as tabs, in order. */
export function slotTabKeys(s: State = state): SlotKey[] {
  return s.info?.family === 'gr3x' ? shownSlots(s).map((x) => x.id) : ['CY', 'CG', ...s.extras.map((x) => x.key)];
}
/** Whether something modal is up (a dialog of the store, the crop editor, the tour, the busy overlay, or any open dialog or menu element: focus stays on a menu's toggle, outside the menu). */
const modalUp = (s: State): boolean =>
  !!(s.confirm || s.inspectView || s.snapshotsView || s.cropId || s.onlineOpen || s.tour || s.busy)
  || (typeof document !== 'undefined' && typeof document.querySelector === 'function' && !!document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]'));
/** Handle a key press; returns whether it was taken. */
export function handleShortcut(e: ShortcutKey): boolean {
  if (e.defaultPrevented || e.altKey || typing(e.target) || modalUp(state)) return false;
  const take = (): true => { e.preventDefault?.(); return true; };
  const mod = !!(e.metaKey || e.ctrlKey), key = e.key.toLowerCase();
  if (mod && !e.shiftKey && key === 'z') { if (!undoPending()) return false; undoDelete(); return take(); }
  if (mod && !e.shiftKey && key === 'e') {
    if (state.page === 'copies' || !state.info) return false;
    void outputFirmware({ kind: 'folder' });
    return take();
  }
  if (mod || e.shiftKey) return false;
  if (state.page === 'ic' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const keys = slotTabKeys(); const at = Math.max(0, keys.indexOf(state.activeSlot));
    const next = keys[Math.max(0, Math.min(keys.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)))];
    if (next === undefined) return false;
    setActiveSlot(next); return take();
  }
  if (state.page === 'ratio' && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.ratios.length) {
    const ids = state.ratios.map((r) => r.id); const at = Math.max(0, ids.indexOf(state.activeRatio ?? ''));
    setActiveRatio(ids[Math.max(0, Math.min(ids.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]); return take();
  }
  return false;
}
/** The modifier key's name for hints: Cmd on a Mac, Ctrl elsewhere. */
export const modKeyName = (): string => (typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '') ? 'Cmd' : 'Ctrl');


// ------------------------------------------------------------------ QoL wave C: preset library
/**
 * @decision DEC-QOL-LIBRARY-001
 * @title The preset library lives in its own host store files, apart from both projects
 * @status accepted
 * @rationale A project holds the presets of one camera's slots, so a look imported once had to be
 *   imported again for the other camera, a new project or a reset. The library keeps looks across
 *   projects and camera switches. Files (store keys are lower case, at most 64 characters):
 *   `library.json` is the index `{ v: 1, entries: [{ id, name, kind, family, fileName, date, fit? }] }`
 *   (written last, so an interrupted save leaves only orphan files, never an entry without data),
 *   `library-<id>` is the source file (XMP / CUBE text, UTF-8), `library-<id>-fit` the fitted result
 *   (PresetResult as JSON, typed arrays tagged so they come back exactly). `family` is the camera
 *   family ('gr4' | 'gr3', GR III and IIIx share one) and `fit` the key of the options that produced
 *   the stored result.
 *   Compatibility. (1) An entry is offered to, and applied on, only a slot of its own family: GR IV
 *   and GR III / IIIx fit to different camera models, so a result from one is wrong on the other (the
 *   source file alone could be refitted, but the user saved a look for a camera, not a file; the
 *   library never crosses families). (2) Within the family the stored result is reused, with no
 *   fitting, only when `fit` equals the key the target would fit with now (family, kind, hue sectors
 *   for an added slot: fitKeyOf). Otherwise the source is refitted with the
 *   current options through the normal runPreset path. A result that cannot be read back also falls
 *   back to a refit. Saving under a name already in the library for that family replaces that entry.
 */
export interface LibraryEntry { id: string; name: string; kind: 'xmp' | 'cube'; family: Family; fileName: string; date: number; fit?: string }
const LIBRARY_INDEX = 'library.json';
const libSrcKey = (id: string): string => 'library-' + id;
const libFitKey = (id: string): string => 'library-' + id + '-fit';
/** The options a fit was made with, as a comparable string (null when nothing can be fitted: no preset support). */
function fitKeyOf(id: SlotKey, kind: 'xmp' | 'cube'): string | undefined {
  if (!state.info?.capabilities.presets) return undefined;
  return [familyOf(state.model), kind, JSON.stringify(fitOptions(id))].join('|');
}
const TYPED: Record<string, new (a: number[]) => ArrayLike<number>> = { Int16Array, Uint16Array, Float64Array, Float32Array, Uint8Array } as never;
/** A fit result as JSON; typed arrays are tagged `{ __ta, data }` so that reading it back gives the same arrays. */
function packFit(r: PresetResult): string {
  return JSON.stringify(r, (_k, v) => (ArrayBuffer.isView(v) ? { __ta: v.constructor.name, data: Array.from(v as unknown as ArrayLike<number>) } : v));
}
function unpackFit(text: string): PresetResult | undefined {
  try {
    const r = JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.__ta === 'string' && TYPED[v.__ta] && Array.isArray(v.data) ? Reflect.construct(TYPED[v.__ta] as never, [v.data]) : v));
    return r && Array.isArray(r.curves) && r.matrixQ13 && r.params ? r as PresetResult : undefined;
  } catch { return undefined; }
}
let libraryLoad: Promise<void> | undefined;
/** Read the library index once (later calls share the first); a missing or damaged index is an empty library. */
export function loadLibrary(): Promise<void> {
  if (!host.available) return Promise.resolve();
  libraryLoad ??= (async () => {
    const raw = await host.storeGet(LIBRARY_INDEX).catch(() => null);
    let entries: LibraryEntry[] = [];
    try {
      const doc = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
      if (doc && doc.v === 1 && Array.isArray(doc.entries)) {
        entries = doc.entries.filter((e: Partial<LibraryEntry>) => e && typeof e.id === 'string' && /^[a-z0-9]{1,40}$/.test(e.id) && typeof e.name === 'string' && (e.kind === 'xmp' || e.kind === 'cube') && (e.family === 'gr4' || e.family === 'gr3')).map((e: LibraryEntry) => ({ id: e.id, name: e.name, kind: e.kind, family: e.family, fileName: String(e.fileName ?? e.name), date: Number(e.date) || 0, ...(typeof e.fit === 'string' ? { fit: e.fit } : {}) }));
      }
    } catch { /* damaged index: start empty rather than refuse to open */ }
    set({ library: entries });
  })();
  return libraryLoad;
}
/** The entries a slot may use: those of the open camera family, newest first. */
export function libraryFor(s: Pick<State, 'library' | 'model'> = state): LibraryEntry[] {
  const fam = familyOf(s.model);
  return s.library.filter((e) => e.family === fam).sort((a, b) => b.date - a.date);
}
async function writeLibraryIndex(entries: LibraryEntry[]): Promise<boolean> {
  try { await host.storeSet(LIBRARY_INDEX, JSON.stringify({ v: 1, entries })); return true; } catch { return false; }
}
/** The name a slot's preset is saved under unless the user types one: the preset's title, else its file name without extension. */
export function defaultLibraryName(id: SlotKey): string {
  const p = slotOf(id)?.preset;
  return (p?.result?.title || p?.fileName.replace(/\.(xmp|cube)$/i, '') || '').trim();
}
export function openLibrary(slot: SlotKey, mode: 'save' | 'apply'): void { set({ libraryPicker: { slot, mode } }); void loadLibrary(); }
export function closeLibrary(): void { set({ libraryPicker: undefined }); }
/** Keep the fitted preset of a slot (with its source file) in the library. False when there is nothing fitted to keep or it could not be written. */
export async function saveToLibrary(id: SlotKey, name: string = defaultLibraryName(id)): Promise<boolean> {
  const p = slotOf(id)?.preset;
  const key = p?.result ? fitKeyOf(id, p.kind) : undefined;
  const clean = name.trim().slice(0, 60);
  if (!host.available || !p?.result || !clean) return false;
  await loadLibrary();
  const fam = familyOf(state.model);
  const old = state.library.find((e) => e.family === fam && e.name === clean);
  const entryId = old?.id ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const entry: LibraryEntry = { id: entryId, name: clean, kind: p.kind, family: fam, fileName: p.fileName, date: Date.now(), ...(key ? { fit: key } : {}) };
  try {
    await host.storeSet(libSrcKey(entryId), p.text);
    await host.storeSet(libFitKey(entryId), packFit(p.result));
  } catch { toast(t('libSaveFailed'), 'error'); return false; }
  const entries = [...state.library.filter((e) => e.id !== entryId), entry];
  if (!(await writeLibraryIndex(entries))) { toast(t('libSaveFailed'), 'error'); return false; }
  set({ library: entries });
  toast(t('libSaved', { name: clean }), 'ok');
  return true;
}
/** Put a library entry on a slot: its stored fit when the options match (no fitting), else a refit of the stored source. */
export async function applyFromLibrary(id: SlotKey, entryId: string): Promise<boolean> {
  const e = state.library.find((x) => x.id === entryId);
  if (!e || !host.available) return false;
  if (e.family !== familyOf(state.model)) { toast(t('libWrongFamily'), 'error'); return false; }
  const src = await host.storeGet(libSrcKey(e.id)).catch(() => null);
  if (!src) { toast(t('libMissing'), 'error'); return false; }
  const text = new TextDecoder().decode(src);
  setActiveSlot(id);
  await host.storeSet(presetKey(id), text).catch(() => undefined);
  const key = fitKeyOf(id, e.kind);
  const stored = key && e.fit === key ? await host.storeGet(libFitKey(e.id)).catch(() => null) : null;
  const result = stored ? unpackFit(new TextDecoder().decode(stored)) : undefined;
  if (result) {
    presetRuns.set(id, nextPresetRun()); // a conversion still running for this slot is now stale
    patchSlot(id, { preset: { fileName: e.fileName, kind: e.kind, text, busy: false, result } });
  } else await runPreset(id, e.fileName, e.kind, text);
  scheduleSave();
  closeLibrary();
  toast(t('libApplied', { name: e.name }), 'ok');
  return true;
}
/** Delete an entry (after asking): the index first, so a failure halfway leaves orphan files and no broken entry. */
export async function deleteLibraryEntry(entryId: string): Promise<void> {
  const e = state.library.find((x) => x.id === entryId);
  if (!e || !(await ask(t('libDeleteTitle'), [e.name], t('remove')))) return;
  const entries = state.library.filter((x) => x.id !== entryId);
  if (!(await writeLibraryIndex(entries))) { toast(t('libSaveFailed'), 'error'); return; }
  set({ library: entries });
  await host.storeDel(libSrcKey(entryId)).catch(() => undefined);
  await host.storeDel(libFitKey(entryId)).catch(() => undefined);
}

// ------------------------------------------------------------------ QoL wave C: compare two slots
/**
 * @decision DEC-QOL-COMPARE-001
 * @title The left side of the photo preview can be another slot's look; the choice is saved view state
 * @status accepted
 * @rationale The preview split showed the photo before and after one slot, so judging two looks meant
 *   switching tabs and remembering. `compareWith` is `orig` (the default and the fallback) or a slot
 *   key. It is saved with previewMode because that is saved too. It is a key, not a copy of the look,
 *   so it follows later edits of that slot; a slot that was removed or lost its preset, or the active
 *   slot itself, counts as `orig` (compareSlot), never an error. The left image is rendered with the
 *   same applySlot pipeline as the right one, deferred a tick so choosing does not stall the UI.
 */
/** Slots that have a fitted look, in menu order: what the compare choice can offer. */
export function slotsWithLook(s: State = state): SlotKey[] { return allSlotKeys(s).filter((k) => slotOf(k, s)?.preset?.result); }
/** The slot whose look is on the left of the preview, or undefined for the original photo. */
export function compareSlot(s: State = state): SlotKey | undefined {
  const k = s.compareWith;
  return k !== 'orig' && k !== s.activeSlot && slotsWithLook(s).includes(k) ? k : undefined;
}
export function setCompareWith(compareWith: string): void { set({ compareWith }); scheduleSave(); }



// ================================================================== QoL wave A
// Plain-language error hints, project export / import, and the app's own UI language. Kept in one
// section (and one block of i18n keys) so that it merges cleanly beside other work on this file.

// ------------------------------------------------------------------ project export / import
/**
 * @decision DEC-QOL-PROJECT-001
 * @title A project file is one JSON document holding both family docs and every file they point at
 * @status accepted
 * @rationale The project is spread over the host store: project.json (GR IV doc plus app settings),
 *   project-gr3.json, one preset file per slot (`preset-*`, `gr3-preset-*`), the power-off pictures
 *   (`wall-*`) and the preview photo. Exporting only the two docs would restore names and order but
 *   lose every preset and picture, so the export lists the store and takes those prefixes. All files
 *   are base64 (presets are text, pictures binary; one encoding keeps the reader simple). The official
 *   firmware (`firmware-*.bin`) and build history are left out: the first is Ricoh's and large, the
 *   second belongs to this computer. Import writes new files first, the docs next and removes stale
 *   project files last, so a failure part-way never leaves the docs pointing at files that are gone.
 */
export const PROJECT_FORMAT = 'grmod-project';
export const PROJECT_FORMAT_VERSION = 1;
const PROJECT_FILE_RE = /^(preset-|gr3-preset-|wall-)[a-z0-9._-]{1,56}$|^preview\.jpg$/;
const PROJECT_MAX_FILES = 600;
export interface ProjectExport {
  format: typeof PROJECT_FORMAT; formatVersion: number; appVersion: string; exported: string;
  project: FamilyDoc; projectGr3: FamilyDoc | null; files: Record<string, string>;
}
/** Thrown for a file that is not a (supported) project export; `code` is `bad-project` or `project-too-new`. */
export class ProjectFileError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const bad = (m: string): ProjectFileError => new ProjectFileError('bad-project', m);
function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** The project documents as they would be saved now (the open family's from the live state). */
function projectDocs(): { doc: FamilyDoc; gr3: FamilyDoc | null } {
  const s = state;
  familyDocs[familyOf(s.model)] = currentFamilyDoc();
  const doc = { ...(familyDocs.gr4 ?? {}), v: 1, page: s.page, model: s.model, lang: s.lang, fwName: s.fwName, showAll: s.showAll, previewMode: s.previewMode, ratioBackdrop: s.ratioBackdrop, tours: s.toursSeen, toursV: 2, langAuto: s.langAuto, uiLang: uiLangPref(), compareWith: s.compareWith };
  return { doc, gr3: familyDocs.gr3 ? { v: 1, ...familyDocs.gr3 } : null };
}
/** Everything needed to restore the work, read from the host store and the live state. */
export async function buildProjectExport(): Promise<ProjectExport> {
  const { doc, gr3 } = projectDocs();
  const files: Record<string, string> = {};
  for (const { key } of await host.storeList()) {
    if (!PROJECT_FILE_RE.test(key)) continue;
    const bytes = await host.storeGet(key);
    if (bytes) files[key] = toBase64(bytes);
  }
  return { format: PROJECT_FORMAT, formatVersion: PROJECT_FORMAT_VERSION, appVersion: host.info?.version ?? '', exported: new Date().toISOString(), project: doc, projectGr3: gr3, files };
}
/** Checks the format, version and shape of an export; throws ProjectFileError, returns the export otherwise. */
export function parseProjectExport(text: string): ProjectExport {
  let p: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { p = JSON.parse(text); } catch { throw bad('not JSON'); }
  if (!p || typeof p !== 'object' || p.format !== PROJECT_FORMAT) throw bad('not a GR Mod project');
  if (!Number.isInteger(p.formatVersion) || p.formatVersion < 1) throw bad('no format version');
  if (p.formatVersion > PROJECT_FORMAT_VERSION) throw new ProjectFileError('project-too-new', `format ${p.formatVersion}`);
  if (!p.project || typeof p.project !== 'object' || p.project.v !== 1) throw bad('no project document');
  if (p.projectGr3 != null && (typeof p.projectGr3 !== 'object' || p.projectGr3.v !== 1)) throw bad('bad GR III document');
  if (!p.files || typeof p.files !== 'object' || Array.isArray(p.files)) throw bad('no files');
  const keys = Object.keys(p.files);
  if (keys.length > PROJECT_MAX_FILES) throw bad('too many files');
  for (const k of keys) {
    if (!PROJECT_FILE_RE.test(k)) throw bad(`unexpected file ${k.slice(0, 40)}`);
    if (typeof p.files[k] !== 'string') throw bad(`bad data for ${k}`);
    try { fromBase64(p.files[k]); } catch { throw bad(`bad data for ${k}`); }
  }
  return { format: PROJECT_FORMAT, formatVersion: p.formatVersion, appVersion: String(p.appVersion ?? ''), exported: String(p.exported ?? ''), project: p.project, projectGr3: p.projectGr3 ?? null, files: p.files };
}
/** Replace the project in the host store with an export's, then load it the way init() does. */
export async function applyProjectExport(p: ProjectExport): Promise<void> {
  // A pending undo record belongs to the project being replaced: its deferred file delete runs now (before the import writes) and Undo no longer applies.
  flushDeleted();
  setImportingProject(true); cancelPendingSave();
  // The interface language is a setting of the app, not project content: the import keeps the current one (startup, init(), still restores the saved one).
  // @decision DEC-TOURS-KEEP-001: the guides already seen are an app setting too. An import or a snapshot
  // restore keeps them (the union with the file's), so an older snapshot or a project from a fresh install
  // does not start every guide again (the first-run guides could not be skipped).
  const tours = [...new Set([...state.toursSeen, ...(Array.isArray(p.project.tours) ? (p.project.tours as TourId[]) : [])])];
  const project = { ...p.project, uiLang: uiLangPref(), tours, toursV: 2 };
  try {
    const have = (await host.storeList()).map((k) => k.key).filter((k) => PROJECT_FILE_RE.test(k));
    for (const [key, b64] of Object.entries(p.files)) await host.storeSet(key, fromBase64(b64));
    await host.storeSet('project.json', JSON.stringify(project));
    if (p.projectGr3) await host.storeSet(GR3_PROJECT, JSON.stringify(p.projectGr3));
    else await host.storeDel(GR3_PROJECT).catch(() => undefined);
    for (const key of have) if (!(key in p.files)) await host.storeDel(key).catch(() => undefined);
    // The old work is dropped before the new is read; the kept firmware of the new camera is reopened by restoreProject.
    endFamilyLoad();
    set({ info: undefined, raw: undefined, fwName: undefined, copyInfo: {}, copySel: [] });
    await restoreProject(project, p.projectGr3);
    clearSaveFailing();
  } finally { setImportingProject(false); }
}
/** The header-menu action: save the project as one downloaded file. */
export async function exportProject(): Promise<void> {
  if (!host.available || state.busy) return;
  set({ busy: t('projectWorking') });
  try {
    const p = await buildProjectExport();
    const d = new Date(), pad = (n: number): string => String(n).padStart(2, '0');
    const name = `grmod-project-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.grmod.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(p)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const n = Object.keys(p.files).length;
    toast(t(n === 0 ? 'projectExported0' : n === 1 ? 'projectExported1' : 'projectExported', { n }), 'ok');
  } catch (e) { fail(e); } finally { set({ busy: undefined }); }
}
/** The header-menu action: validate a chosen file, confirm the replacement, then import it. Bad input toasts and changes nothing. */
export async function importProject(file: File): Promise<void> {
  if (!host.available || state.busy) return;
  let p: ProjectExport;
  try {
    if (file.size > 400_000_000) throw bad('too large');
    p = parseProjectExport(await file.text());
  } catch (e) {
    console.warn('project file rejected', e);
    toast(e instanceof ProjectFileError && e.code === 'project-too-new' ? t('projectTooNew') : t('projectBad'), 'error');
    return;
  }
  if (!(await ask(t('projectImportTitle'), [t('projectImportLine', { v: p.appVersion || '?', n: Object.keys(p.files).length })], t('projectImportOk'), t('projectImportWarn')))) return;
  set({ busy: t('projectWorking') });
  // A pending delete is committed before the snapshot, so neither the snapshot nor the import races its deferred storeDel.
  flushDeleted();
  try { await takeSnapshot('import'); await applyProjectExport(p); toast(t('projectImported'), 'ok'); }
  catch (e) { fail(e); }
  finally { set({ busy: undefined }); }
}

// ================================================================== QoL batch D1
// Card preflight, project snapshots, "New project" and comparing two firmware files. One section
// (and one block of i18n keys at the end of each dictionary) so that it merges cleanly beside other work.

// ------------------------------------------------------------------ card preflight
/**
 * @decision DEC-QOLD1-PREFLIGHT-001
 * @title Check space and presence of a card with a fresh volume list before any write to it
 * @status accepted
 * @rationale A full card used to fail mid-write (after the old firmware was moved aside). The
 *   check runs in firmwareToCard (every card write: a build, a stock copy, writeCopy) with the exact
 *   size, and once earlier with the source size so that a hopeless card is refused before the
 *   build and, in writeCopy, before the copy is read. The cached `state.volumes` can be minutes old, so the host is asked
 *   again. A card needs the file plus 1 MiB of margin (the file system's own bookkeeping); moves
 *   into `GRMOD\parked-*` are renames on the same volume and need nothing. Folder exports never
 *   reach this. Volume carries no read-only flag on any platform (shell/internal/platform), so a
 *   write-protected card cannot be seen beforehand: the host's write error (EROFS / "write
 *   protected" / permission denied, code `io`; `forbidden` for the rest) is mapped to a
 *   write-protect hint after the fact by errorHint(). A volume that reports no size at all is not checked.
 */
export const CARD_MARGIN = 1 << 20;
/** True when `v` is still mounted and has room for `need` bytes; otherwise toasts why (needed vs free) and returns false. */
export async function preflightCard(v: Volume, need: number): Promise<boolean> {
  let volumes: Volume[];
  try { volumes = await host.volumes(state.showAll); }
  catch (e) { fail(e); return false; }
  const fresh = volumes.find((x) => x.id === v.id);
  if (JSON.stringify(volumes) !== JSON.stringify(state.volumes)) set({ volumes });
  if (!fresh) { toast(t('preflightGone', { c: v.id }), 'error'); void refreshVolumes(); return false; }
  if (fresh.total === 0 && fresh.free === 0) return true;
  if (fresh.free < need + CARD_MARGIN) { toast(t('preflightSpace', { c: fresh.id, need: fmtSize(need + CARD_MARGIN), free: fmtSize(fresh.free) }), 'error'); return false; }
  return true;
}

// ------------------------------------------------------------------ project snapshots
/**
 * @decision DEC-QOLD1-SNAP-001
 * @title Snapshots are project exports kept in the host store, newest 10, listed by a small index
 * @status accepted
 * @rationale A snapshot is exactly what buildProjectExport() makes, so restoring one is
 *   applyProjectExport() (the import path, with its write-new-first ordering). Files: `snapshot-<ms>.json`
 *   (key rules: lower case, at most 64 characters) and `snapshots.json` (the index: time, reason,
 *   a content signature and counts for the dialog, so the list needs no big reads). Neither matches
 *   PROJECT_FILE_RE, so they are never part of an export or touched by an import. A snapshot is
 *   taken before an import, before New project, before a restore (so a restore can be undone) and
 *   after a successful build; one identical to the newest (same signature) is skipped. The index is
 *   written before the oldest files are deleted, so a crash leaves an orphan file, never an index
 *   entry without data. All work is serialised, and a failure never blocks the action: it warns once
 *   until a snapshot succeeds again.
 */
export type SnapshotReason = 'import' | 'new' | 'build' | 'restore';
export interface SnapshotEntry { id: string; time: number; reason: SnapshotReason; sig: string; model: string; slots: number; extras: number; ratios: number; pictures: number }
export const SNAPSHOT_KEEP = 10;
const SNAP_INDEX = 'snapshots.json';
const snapKey = (id: string): string => `snapshot-${id}.json`;
/** FNV-1a over the content, to skip a snapshot that equals the newest. */
function contentSig(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}-${h.toString(36)}`;
}
async function readSnapIndex(): Promise<SnapshotEntry[]> {
  try {
    const raw = await host.storeGet(SNAP_INDEX);
    const j = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
    const list: unknown = j && j.v === 1 ? j.entries : [];
    return Array.isArray(list) ? (list as SnapshotEntry[]).filter((e) => e && typeof e.id === 'string' && /^[0-9]{1,16}$/.test(e.id) && typeof e.time === 'number') : [];
  } catch { return []; }
}
/** What a project export holds, in numbers (the open camera's family: its edited slots, added slots, ratios and pictures). */
function snapshotCounts(p: ProjectExport): Pick<SnapshotEntry, 'model' | 'slots' | 'extras' | 'ratios' | 'pictures'> {
  const model: CameraModel = ['GR3', 'GR3_HDF', 'GR3X', 'GR3X_HDF', 'HDF', 'STANDARD', 'MONO'].includes(p.project.model) ? p.project.model : 'HDF';
  const d: FamilyDoc = familyOf(model) === 'gr3' ? (p.projectGr3 ?? p.project) : p.project;
  const edited = Object.values((d.slots ?? {}) as Record<string, { preset?: unknown; names?: Record<string, string>; icon?: { mode?: string } }>)
    .filter((x) => x && (x.preset || Object.values(x.names ?? {}).some((n) => !!n) || (x.icon?.mode && x.icon.mode !== 'keep'))).length;
  const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return { model, slots: edited, extras: n(d.extras), ratios: n(d.ratios), pictures: n(d.wall) };
}
let snapChain: Promise<unknown> = Promise.resolve();
let snapWarned = false;
/** Take a snapshot of the project now. Never throws; resolves to false (and warns once) when it could not be kept. */
export function takeSnapshot(reason: SnapshotReason): Promise<boolean> {
  const run = snapChain.then(async () => {
    if (!host.available) return false;
    try {
      const p = await buildProjectExport();
      const body = JSON.stringify(p);
      const sig = contentSig(JSON.stringify({ project: p.project, projectGr3: p.projectGr3, files: p.files }));
      const index = await readSnapIndex();
      if (index.length && index[index.length - 1].sig === sig) return true;
      let time = Date.now();
      if (index.length && time <= index[index.length - 1].time) time = index[index.length - 1].time + 1;
      const entry: SnapshotEntry = { id: String(time), time, reason, sig, ...snapshotCounts(p) };
      await host.storeSet(snapKey(entry.id), body);
      const all = [...index, entry].sort((a, b) => a.time - b.time);
      const dropped = all.slice(0, Math.max(0, all.length - SNAPSHOT_KEEP)), kept = all.slice(dropped.length);
      await host.storeSet(SNAP_INDEX, JSON.stringify({ v: 1, entries: kept }));
      for (const d of dropped) await host.storeDel(snapKey(d.id)).catch(() => undefined);
      snapWarned = false;
      return true;
    } catch (e) {
      console.warn('snapshot', e);
      if (!snapWarned) { snapWarned = true; toast(t('snapshotFailed'), 'info'); }
      return false;
    }
  });
  snapChain = run.catch(() => undefined);
  return run;
}
/** The snapshots whose data is still in the store, newest first. */
async function listSnapshots(): Promise<SnapshotEntry[]> {
  const have = new Set((await host.storeList().catch(() => [])).map((k) => k.key));
  return (await readSnapIndex()).filter((e) => have.has(snapKey(e.id))).sort((a, b) => b.time - a.time);
}
export function closeSnapshots(): void { set({ snapshotsView: undefined }); }
/** The "Restore an earlier version…" dialog: reads the list. */
export async function openSnapshots(): Promise<void> {
  if (!host.available || state.busy) return;
  set({ snapshotsView: { entries: [], busy: true } });
  const entries = await listSnapshots();
  if (state.snapshotsView) set({ snapshotsView: { entries, busy: false } });
}
/** Restore snapshot `id` through the import path, after a confirm; the current state is snapshotted first so that this can be undone. */
export async function restoreSnapshot(id: string): Promise<void> {
  if (!host.available || state.busy) return;
  const entry = (state.snapshotsView?.entries ?? []).find((e) => e.id === id);
  let p: ProjectExport;
  try {
    const raw = await host.storeGet(snapKey(id));
    if (!raw) throw bad('snapshot missing');
    p = parseProjectExport(new TextDecoder().decode(raw));
  } catch (e) { console.warn('snapshot unreadable', e); toast(t('snapshotMissing'), 'error'); void openSnapshots(); return; }
  const when = new Date(entry?.time ?? Number(id)).toLocaleString();
  closeSnapshots();
  if (!(await ask(t('snapshotRestoreTitle'), [`${when} · ${t(('snapshotReason_' + (entry?.reason ?? 'build')) as Key)}`, snapshotSummary(entry ?? { ...snapshotCounts(p) })], t('snapshotRestoreOk'), t('snapshotRestoreWarn')))) return;
  set({ busy: t('projectWorking') });
  try {
    // The version being restored is already in memory (`p`): the snapshot below may prune it from the store when the list is full.
    await takeSnapshot('restore');
    flushDeleted();
    await applyProjectExport(p);
    toast(t('snapshotRestored'), 'ok');
  } catch (e) { fail(e); }
  finally { set({ busy: undefined }); }
}
/** "GR IV HDF · 3 slots · 2 added slots · 1 ratio" for the dialog's rows. */
export function snapshotSummary(e: Pick<SnapshotEntry, 'model' | 'slots' | 'extras' | 'ratios' | 'pictures'>): string {
  return [e.model, t('snapshotSlots', { n: e.slots }), t('snapshotExtras', { n: e.extras }), t('snapshotRatios', { n: e.ratios }), ...(e.pictures ? [t('snapshotPictures', { n: e.pictures })] : [])].join(' · ');
}

// ------------------------------------------------------------------ New project
/**
 * @decision DEC-QOLD1-NEW-001
 * @title New project resets the open camera family's work only, after a snapshot
 * @status accepted
 * @rationale Slots, added slots, look order, ratios, power-off pictures and the switches live in
 *   one FamilyDoc per family (GR IV; GR III / IIIx). The reset is enterFamily() on an empty doc
 *   (the same path as switching camera), so emptySlots() and parseFamily() define "fresh". Kept:
 *   the open official firmware, the preset library (`lib-*`), the other family's doc, and the
 *   app settings (uiLang, camera language, model, tours seen, preview choices). The new doc is saved
 *   before this family's files (`preset-*` or `gr3-preset-*`, and the `wall-*` pictures its doc
 *   named) are deleted, so a crash never leaves a doc pointing at missing files. The preview
 *   photo is a setting, not work, and stays.
 */
export async function newProject(): Promise<void> {
  if (!host.available || state.busy) return;
  if (!(await ask(t('newProjectTitle'), [t('newProjectLine')], t('newProjectOk'), t('newProjectWarn')))) return;
  set({ busy: t('projectWorking') });
  try {
    await takeSnapshot('new');
    flushDeleted();
    const fam = familyOf(state.model);
    const doc = currentFamilyDoc();
    const wallIds = (Array.isArray(doc.wall) ? doc.wall : []).map((w: { id: string }) => String(w.id));
    familyDocs[fam] = null; endFamilyLoad();
    enterFamily(fam);
    set({ compareWith: 'orig' });
    clearTimeout(saveTimer);
    await saveProject();
    const prefix = fam === 'gr3' ? 'gr3-preset-' : 'preset-';
    const stale = (await host.storeList()).map((k) => k.key).filter((k) => (k.startsWith(prefix) && PROJECT_FILE_RE.test(k)) || (k.startsWith('wall-') && wallIds.includes(k.slice(5))));
    for (const k of stale) await host.storeDel(k).catch(() => undefined);
    toast(t('newProjectDone'), 'ok');
  } catch (e) { fail(e); }
  finally { set({ busy: undefined }); }
}

// ------------------------------------------------------------------ compare two firmware files
/**
 * @decision DEC-QOLD1-COMPARE-001
 * @title The second file is inspected the same way, against the same open official firmware
 * @status accepted
 * @rationale engine.inspect reports each file relative to the open official firmware, so two
 *   summaries are comparable row by row without a second reference. The comparison itself (compare.ts)
 *   is a pure function of the two summaries; the dialog only lays it out. Single-file inspect is
 *   unchanged: `other` is simply absent until a second file is chosen, and choosing a new first file clears it.
 */
export async function inspectCompare(file: File): Promise<void> {
  const v = state.inspectView; if (!v?.summary) return;
  const gen = inspectGen;
  const side = { name: file.name, size: file.size };
  if (file.size < 1_000_000 || file.size > 200_000_000) { set({ inspectView: { ...v, other: { ...side, busy: false, error: 'size' } } }); return; }
  set({ inspectView: { ...v, other: { ...side, busy: true } } });
  const put = (other: NonNullable<InspectView['other']>): void => { if (gen === inspectGen && state.inspectView) set({ inspectView: { ...state.inspectView, other } }); };
  try { put({ ...side, busy: false, summary: await engine.inspect(new Uint8Array(await file.arrayBuffer())) }); }
  catch (e) { console.warn('inspect compare', e); put({ ...side, busy: false, error: 'unreadable' }); }
}
export function closeCompare(): void { const v = state.inspectView; if (v?.other) set({ inspectView: { ...v, other: undefined } }); }
// ================================================================== QoL batch D2
// ------------------------------------------------------------------ export a slot's look as a .cube
/**
 * @decision DEC-QOL-EXPORTCUBE-UI-001
 * @title "Export look as .cube" renders core's exportSlotCube from the slot's fitted params
 * @status accepted
 * @rationale The file is made by core (color/export-cube.ts, DEC-QOL-EXPORTCUBE-001 defines what it
 *   represents: the slot model applied to a Standard sRGB picture, colour and tone only, no halation
 *   or grain). The UI side only picks the camera model by family (GR III / IIIx: GR3X_CAMERA, else
 *   GR IV's), names the file after the slot (what the camera menu shows, made file-name safe) and
 *   downloads it the way the project export does. It needs a fitted result; a slot without one has
 *   no button.
 */
/** The name a slot has in the camera's menu, for file names: an added slot's name, else the language's name of a built-in one. */
export function slotLabel(k: SlotKey, s: State = state): string {
  if (isExtra(k)) { const x = s.extras.find((e) => e.key === k); return x ? extraName(x, s) : k; }
  const id = k as SlotId, off = s.info?.slots.find((x) => x.id === id);
  return s.slots[id]?.names[s.lang] || (s.info?.family === 'gr3x' ? off?.defaultName : id === 'CG' ? t('slotCG') : t('slotCY')) || id;
}
const fileSafe = (n: string): string => n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'look';
function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/** The .cube text of a slot's fitted look and the name it downloads as; undefined without a fitted result. */
export function slotCube(k: SlotKey, s: State = state): { name: string; text: string } | undefined {
  const params = slotOf(k, s)?.preset?.result?.params;
  if (!params) return undefined;
  const name = slotLabel(k, s);
  return { name: fileSafe(name) + '.cube', text: color.exportSlotCube(params, { title: name, camera: s.info?.family === 'gr3x' ? 'gr3x' : 'gr4' }) };
}
export function exportSlotCubeFile(k: SlotKey): void {
  try {
    const c = slotCube(k);
    if (!c) { toast(t('exportCubeNone'), 'error'); return; }
    downloadText(c.name, c.text, 'text/plain');
    toast(t('exportCubeDone', { name: c.name }), 'ok');
  } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ duplicate an added slot
/**
 * @decision DEC-QOL-DUPLICATE-001
 * @title Duplicating an added slot copies its fitted look and file, never re-fits, and sits right after the source
 * @status accepted
 * @rationale A user who wants a variant of an added slot (same look, another name or icon) should not
 *   have to import and fit the file again. The copy takes the source's icon (pixels copied, not shared),
 *   halation, hidden state and preset (the fitted result is immutable, so it is shared by reference; the
 *   source file is stored again under the new key, as an imported file is). It is inserted right after
 *   the source in both `extras` and the menu order. The name is the source's name with a numeric suffix
 *   (" 2", " 3", ... the first one no added slot has; a number already at the end of the name is kept unless the name without it is another slot's), the base cut so the whole stays within
 *   EXTRA_NAME_MAX and so passes validateExtraSlotName whenever the source's name did. A source whose
 *   fit is still running is refitted for the copy instead of copied half done. The limit
 *   MAX_EXTRA_SLOTS is the same as for adding (the button is disabled with the reason).
 */
/** Why an added slot cannot be duplicated now (the limit), or null. */
export function duplicateExtraProblem(s: State = state): string | null {
  return s.extras.length >= MAX_EXTRA_SLOTS ? t('extraDuplicateFull', { n: MAX_EXTRA_SLOTS }) : null;
}
/** The name for a copy of `name`: a number suffix not used by another added slot, within EXTRA_NAME_MAX. */
export function duplicateName(name: string, taken: readonly string[]): string {
  // a trailing number is only a copy's suffix when the name without it is another slot's ("Warm 2" next to "Warm"); "Warm 400" keeps its 400
  const m = /^(.*\S)\s+\d+$/.exec(name);
  const base = m && taken.includes(m[1]) ? m[1] : name;
  for (let n = 2; n < 1000; n++) {
    const suffix = ' ' + n;
    const cand = base.slice(0, Math.max(1, EXTRA_NAME_MAX - suffix.length)).trimEnd() + suffix;
    if (!taken.includes(cand)) return cand;
  }
  return base;
}
/** Make a copy of an added slot right after it. Returns the new key, or undefined at the limit / for an unknown key. */
export function duplicateExtraSlot(key: string): string | undefined {
  const src = state.extras.find((x) => x.key === key);
  if (!src) return undefined;
  const full = duplicateExtraProblem();
  if (full) { toast(full, 'info'); return undefined; }
  const newKey = 'x-' + Math.random().toString(36).slice(2, 10);
  const name = duplicateName(extraName(src), state.extras.map((x) => extraName(x)));
  const p = src.preset;
  const copy: ExtraSlot = {
    key: newKey, name,
    icon: { ...src.icon, ...(src.icon.pixels ? { pixels: new Uint8Array(src.icon.pixels) } : {}) },
    ...(src.halation ? { halation: { ...src.halation } } : {}),
    ...(p ? { preset: { ...p } } : {}),
  };
  const hidden = state.lookHidden.includes(key);
  set((s) => {
    const at = s.extras.findIndex((x) => x.key === key);
    const extras = s.extras.slice(); extras.splice(at + 1, 0, copy);
    const order = normalizeLookOrder(s.lookOrder, s.extras); order.splice(order.indexOf(key) + 1, 0, newKey);
    return { extras, lookOrder: order, lookHidden: hidden ? [...s.lookHidden, newKey] : s.lookHidden, activeSlot: newKey };
  });
  if (p && host.available) void host.storeSet(presetKey(newKey), p.text).catch(() => undefined);
  if (p?.busy) void runPreset(newKey, p.fileName, p.kind, p.text); // the source's conversion is not finished: the copy runs its own
  if (!copy.icon.pixels) void renderIcon(newKey);
  scheduleSave();
  toast(t('extraDuplicated', { name }), 'ok');
  return newKey;
}

// ------------------------------------------------------------------ batch preset import
/**
 * @decision DEC-QOL-BATCH-001
 * @title Several preset files at once fill empty slots in order, never overwrite, and ask before adding slots
 * @status accepted
 * @rationale Importing a pack of looks meant one drop per slot. With several .xmp / .cube files the
 *   targets are, in order: the slot the files were dropped on or picked for (the active slot when none
 *   is given) if it has no usable preset, then every other slot without one in menu order (built-in
 *   slots, then added slots). A slot "has a preset" when it holds one that did not fail: a failed
 *   conversion is replaced, a good look never is. Files beyond the free slots are skipped, unless
 *   the camera is a GR IV (the only family with added slots) and there is room under
 *   MAX_EXTRA_SLOTS: then, once the free slots are filled, one ask() offers to add that many slots for them (declining skips them).
 *   Fitting runs one file after another through the ordinary loadPresetFile / runPreset path, so
 *   options, storage and stale-run guards are identical to a single import; the busy overlay shows
 *   "i of n". A final toast counts applied, skipped and failed files and names the failed ones. One
 *   file behaves exactly as before (loadPresetFile on the given slot, replacing what is there).
 */
const hasUsablePreset = (k: SlotKey, s: State = state): boolean => { const p = slotOf(k, s)?.preset; return !!p && !p.error; };
/** The slots a batch of files goes to, in order (see DEC-QOL-BATCH-001): `from` first when it is free, then the other free slots. */
export function batchTargets(from: SlotKey = state.activeSlot, s: State = state): SlotKey[] {
  const keys = allSlotKeys(s), free = keys.filter((k) => !hasUsablePreset(k, s));
  return keys.includes(from) && free.includes(from) ? [from, ...free.filter((k) => k !== from)] : free;
}
/** How many more slots could be added for a batch (GR IV only; not on the Monochrome, which builds none). */
const batchRoom = (s: State = state): number => (s.info && s.info.family !== 'gr3x' && s.model !== 'MONO' ? Math.max(0, MAX_EXTRA_SLOTS - s.extras.length) : 0);
export async function loadPresetFiles(files: File[], from?: SlotKey): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) { await loadPresetFile(from ?? state.activeSlot, files[0]); return; }
  if (state.busy) return;
  const slots = batchTargets(from);
  const rest = files.slice(slots.length);
  const failed: string[] = []; let applied = 0, skipped = rest.length, firstSlot: SlotKey | undefined;
  const caps = !!state.info?.capabilities.presets;
  /** Fit `list` into `into` one after another; `done` of `total` files are behind when it starts (for the progress text). */
  const run = async (into: SlotKey[], list: File[], done: number, total: number): Promise<void> => {
    firstSlot ??= into[0];
    set({ busy: t('batchProgress', { i: done + 1, n: total }) });
    try {
      for (let i = 0; i < list.length; i++) {
        set({ busy: t('batchProgress', { i: done + i + 1, n: total }) });
        try { await loadPresetFile(into[i], list[i]); } catch { /* counted below */ }
        const p = slotOf(into[i])?.preset;
        if (p && p.fileName === list[i].name && !p.error && (p.result || !caps)) applied++; else failed.push(list[i].name);
      }
    } finally { set({ busy: undefined }); }
  };
  const room = Math.min(rest.length, batchRoom());
  if (slots.length) await run(slots, files.slice(0, slots.length), 0, slots.length + room);
  // the free slots are used up: offer added slots for the files that are left (GR IV, room under the limit)
  if (room > 0 && await ask(t('batchAddTitle'), [t('batchAddLine', { n: rest.length }), t('batchAddFiles', { n: room, names: rest.slice(0, room).map((f) => f.name).join(', ') })], t('batchAddOk'))) {
    const before = new Set(state.extras.map((x) => x.key));
    for (let i = 0; i < room; i++) addExtraSlot();
    const added = state.extras.map((x) => x.key).filter((k) => !before.has(k));
    await run(added, rest.slice(0, added.length), slots.length, slots.length + added.length);
    skipped = rest.length - added.length;
  }
  if (firstSlot) setActiveSlot(firstSlot);
  const parts = [t('batchDone', { n: applied })];
  if (skipped) parts.push(t('batchSkipped', { n: skipped }));
  if (failed.length) parts.push(t('batchFailed', { n: failed.length, names: failed.slice(0, 3).join(', ') + (failed.length > 3 ? ` +${failed.length - 3}` : '') }));
  toast(parts.join(' · '), failed.length ? 'error' : 'ok');
}

// ------------------------------------------------------------------ library rename, search and sort
/**
 * @decision DEC-QOL-LIBRARY-002
 * @title Renaming only edits the index; search and sort are pure views over the entries
 * @status accepted
 * @rationale An entry's files are keyed by its id (DEC-QOL-LIBRARY-001), so renaming rewrites only
 *   library.json (one write: nothing can be left half done) and keeps the id, date and files. Names
 *   stay unique per family, as saving enforces (same trimmed, 60-character, exact comparison): a
 *   clash is refused with 'exists' and nothing is written. Search matches the name or the file name,
 *   case-insensitive, on the trimmed query; sort is newest first (the default, so a fresh save is at
 *   the top) or by name (locale-aware, case-insensitive). Both are functions of the list so the
 *   dialog holds only the query and the sort choice, and they are tested without the dialog. The box
 *   shows only above LIBRARY_SEARCH_MIN entries, where scanning by eye stops being easy.
 */
export const LIBRARY_SEARCH_MIN = 5;
export type LibrarySort = 'new' | 'name';
export type RenameResult = 'ok' | 'empty' | 'exists' | 'missing' | 'failed';
/** Rename an entry. 'empty' for a blank name, 'exists' when another entry of its family has it, 'missing' for an unknown id, 'failed' when the index could not be written. */
export async function renameLibraryEntry(entryId: string, name: string): Promise<RenameResult> {
  const clean = name.trim().slice(0, 60);
  const e = state.library.find((x) => x.id === entryId);
  if (!e) return 'missing';
  if (!clean) return 'empty';
  if (clean === e.name) return 'ok';
  if (state.library.some((x) => x.id !== entryId && x.family === e.family && x.name === clean)) return 'exists';
  const entries = state.library.map((x) => (x.id === entryId ? { ...x, name: clean } : x));
  if (!(await writeLibraryIndex(entries))) { toast(t('libSaveFailed'), 'error'); return 'failed'; }
  set({ library: entries });
  return 'ok';
}
/** The entries whose name or file name contains the query (case-insensitive); all of them for a blank query. */
export function searchLibrary(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.fileName.toLowerCase().includes(q)) : entries.slice();
}
/** Newest first (ties keep their order), or by name. */
export function sortLibrary(entries: readonly LibraryEntry[], by: LibrarySort): LibraryEntry[] {
  const out = entries.slice();
  return by === 'name' ? out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || b.date - a.date) : out.sort((a, b) => b.date - a.date);
}