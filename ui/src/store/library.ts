import type { PresetResult } from '@grmod/core';
import { host } from '../host';
import { t } from '../i18n';
import { ask, patchSlot, set, slotOf, state, toast } from './core';
import type { SlotKey, State } from './core';
import { familyOf, presetKey, scheduleSave } from './families';
import type { Family } from './families';
import { setActiveSlot } from './photo';
import { fitOptions, nextPresetRun, presetRuns, runPreset } from './slots';

/**
 * The user's own preset library: looks kept outside the project, so a look imported once can go on
 * any compatible slot later. The library ships no presets of its own.
 *
 * @decision DEC-LIBRARY-001
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
 *   fitting, only when `fit` equals the key the target would fit with now (family, kind and the
 *   options of fitOptions, so an added slot's hue sectors count). Otherwise the source is refitted
 *   with the current options through the normal runPreset path. A result that cannot be read back
 *   also falls back to a refit. The key starts with the app version, so a newer app (maybe with a
 *   better fit) refits once and keeps its own result in place of the old one. Saving under a name already in the library for that family replaces
 *   that entry.
 */
export interface LibraryEntry { id: string; name: string; kind: 'xmp' | 'cube'; family: Family; fileName: string; date: number; fit?: string }
export type LibrarySort = 'new' | 'name';
export type RenameResult = 'ok' | 'empty' | 'exists' | 'missing' | 'failed';
/** The search box shows only above this many entries, where scanning the list by eye stops being easy. */
export const LIBRARY_SEARCH_MIN = 5;

const LIBRARY_INDEX = 'library.json';
const libSrcKey = (id: string): string => 'library-' + id;
const libFitKey = (id: string): string => 'library-' + id + '-fit';
/**
 * The options a fit was made with, as a comparable string (undefined when nothing can be fitted: no preset support).
 * It starts with the app's version: a stored fit is only reused by the version that made it, so a later version
 * with a better fit refits the stored source once instead of reusing an older result.
 */
function fitKeyOf(id: SlotKey, kind: 'xmp' | 'cube'): string | undefined {
  if (!state.info?.capabilities.presets) return undefined;
  return [host.info?.version ?? '', familyOf(state.model), kind, JSON.stringify(fitOptions(id))].join('|');
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
/**
 * The entries a slot may use: those of the open camera family, newest first. It builds a new array, so
 * never call it inside a useStore selector (the snapshot would never settle: React error #185). Select
 * `library` and `model`, then derive with useMemo.
 */
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
  } else {
    await runPreset(id, e.fileName, e.kind, text);
    // keep the new fit for the next time, when the slot's options are the ones the entry was saved for or it had none (an older app's)
    const fresh = slotOf(id)?.preset;
    if (key && fresh?.result && fresh.text === text && (!e.fit || e.fit.split('|').slice(1).join('|') === key.split('|').slice(1).join('|'))) {
      try {
        await host.storeSet(libFitKey(e.id), packFit(fresh.result));
        const entries = state.library.map((x) => (x.id === e.id ? { ...x, fit: key } : x));
        if (await writeLibraryIndex(entries)) set({ library: entries });
      } catch { /* the stored source is enough: the next apply refits again */ }
    }
  }
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

/**
 * @decision DEC-LIBRARY-002
 * @title Renaming only edits the index; search and sort are pure views over the entries
 * @status accepted
 * @rationale An entry's files are keyed by its id (DEC-LIBRARY-001), so renaming rewrites only
 *   library.json (one write: nothing can be left half done) and keeps the id, date and files. Names
 *   stay unique per family, as saving enforces (same trimmed, 60-character, exact comparison): a
 *   clash is refused with 'exists' and nothing is written. Search matches the name or the file name,
 *   case-insensitive, on the trimmed query; sort is newest first (the default, so a fresh save is at
 *   the top) or by name (locale-aware, case-insensitive). Both are functions of the list so the
 *   dialog holds only the query and the sort choice, and they are tested without the dialog.
 */
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
