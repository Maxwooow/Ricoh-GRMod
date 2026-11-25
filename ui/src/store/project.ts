// SPDX-License-Identifier: GPL-2.0-only
/**
 * The project as one file, and the safety net around it: export and import, automatic snapshots
 * (restored through the import path) and "New project".
 *
 * @decision DEC-PROJECT-IO-001
 * @title A project file is one JSON document holding both family docs and every file they point at
 * @status accepted
 * @rationale The project is spread over the host store: project.json (GR IV's work plus the app's
 *   settings), project-gr3.json, one preset file per slot (`preset-*`, `gr3-preset-*`), the power-off
 *   pictures (`wall-*`) and the preview photo. Exporting only the two docs would restore names and
 *   order but lose every preset and picture, so the export lists the store and takes those prefixes.
 *   All files are base64 (presets are text, pictures binary; one encoding keeps the reader simple).
 *   The official firmware (`firmware-*.bin`), the build history and the update settings are left
 *   out: the first is Ricoh's and large, the rest belong to this computer.
 *   The two documents come from families.ts projectDocuments(), the same builder saveProject() writes
 *   with, so an option added to the saved work (the movie switches of 0.9, whatever comes next) is
 *   exported without anyone touching this file. Import writes new files first, the docs next and
 *   removes stale project files last, so a failure part-way never leaves the docs pointing at files
 *   that are gone. The app language and the guides already seen are settings of the app, not of the
 *   work: an import keeps the current language and adds the file's guides to the ones seen.
 *
 * @decision DEC-PROJECT-SNAP-001
 * @title Keep the last 10 project snapshots, restored through the import path
 * @status accepted
 * @rationale A snapshot is a project export kept in the host store (`snapshot-<id>.json`, with a small
 *   index `snapshots.json`). One is taken before an import, a restore and New project, and after a
 *   build written to a card or folder. The newest 10 are kept. A snapshot equal to the newest (same
 *   content signature) is skipped, so repeated builds of an unchanged project do not push older work
 *   out. A restore is an import of the snapshot, after a snapshot of the current state, so it can be
 *   taken back. Every step is serialised on one promise chain, and a failure never blocks the action
 *   that asked for the snapshot: it warns once until a snapshot succeeds again.
 *
 * @decision DEC-PROJECT-NEW-001
 * @title New project resets the open camera family's work only, after a snapshot
 * @status accepted
 * @rationale Slots, added slots, look order, ratios, power-off pictures and the switches live in one
 *   FamilyDoc per family (GR IV; GR III / IIIx). The reset is enterFamily() on an empty doc (the same
 *   path as switching camera), so emptySlots() and parseFamily() define "fresh". Kept: the open
 *   official firmware, the other family's doc and the app settings (language,
 *   camera language, model, guides seen, preview choices). The new doc is saved before this family's
 *   files are deleted, so a crash never leaves a doc pointing at missing files.
 */
import type { CameraModel } from '@grmod/core';
import { host } from '../host';
import { t, uiLangPref } from '../i18n';
import type { Key } from '../i18n';
import { ask, fail, set, state, toast } from './core';
import type { TourId } from './core';
import { GR3_PROJECT, cancelSave, currentFamilyDoc, endFamilyLoad, enterFamily, familyDocs, familyOf, projectDocuments, restoreProject, saveProject, setImportingProject } from './families';
import type { FamilyDoc } from './families';

// ------------------------------------------------------------------ project export / import
export const PROJECT_FORMAT = 'grmod-project';
export const PROJECT_FORMAT_VERSION = 1;
/** The store keys that are part of a project: the presets, the power-off pictures and the preview photo. */
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
/** Everything needed to restore the work, read from the host store and the live state. */
export async function buildProjectExport(): Promise<ProjectExport> {
  const { doc, gr3 } = projectDocuments();
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
  setImportingProject(true); cancelSave();
  // The interface language is a setting of the app, not project content: the import keeps the current one (start-up, init(), still restores the saved one).
  // The guides already seen are an app setting too: the union with the file's, so that an older snapshot or a project from a fresh install does not start every guide again.
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
  try { await takeSnapshot('import'); await applyProjectExport(p); toast(t('projectImported'), 'ok'); }
  catch (e) { fail(e); }
  finally { set({ busy: undefined }); }
}

// ------------------------------------------------------------------ snapshots
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
export async function newProject(): Promise<void> {
  if (!host.available || state.busy) return;
  if (!(await ask(t('newProjectTitle'), [t('newProjectLine')], t('newProjectOk'), t('newProjectWarn')))) return;
  set({ busy: t('projectWorking') });
  try {
    await takeSnapshot('new');
    const fam = familyOf(state.model);
    const doc = currentFamilyDoc();
    const wallIds = (Array.isArray(doc.wall) ? doc.wall : []).map((w: { id: string }) => String(w.id));
    familyDocs[fam] = null; endFamilyLoad();
    enterFamily(fam);
    cancelSave();
    await saveProject();
    const prefix = fam === 'gr3' ? 'gr3-preset-' : 'preset-';
    const stale = (await host.storeList()).map((k) => k.key).filter((k) => (k.startsWith(prefix) && PROJECT_FILE_RE.test(k)) || (k.startsWith('wall-') && wallIds.includes(k.slice(5))));
    for (const k of stale) await host.storeDel(k).catch(() => undefined);
    toast(t('newProjectDone'), 'ok');
  } catch (e) { fail(e); }
  finally { set({ busy: undefined }); }
}
