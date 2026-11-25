import { framingValues } from '@grmod/core';
import { card } from '@grmod/core';
import type { FirmwareSummary } from '@grmod/core';
import { engine, EngineError } from '../engine';
import { host, sha256Hex } from '../host';
import type { ParkedEntry } from '../host';
import { t } from '../i18n';
import { CopySource, State, ask, askOfficial, fail, newFirmwareWarning, set, state, toast } from './core';
import { gridText, softText } from './features';
import { toneLabel } from './ratios';
import { SlotChange, doneToast, firmwareFilename, firmwareToCard, refreshVolumes } from './output';

// ------------------------------------------------------------------ copies moved aside on the card, and their backups
const BUILDS_KEY = 'builds.json';
export async function loadBuilds(): Promise<void> {
  try {
    const raw = await host.storeGet(BUILDS_KEY);
    const list = raw ? JSON.parse(new TextDecoder().decode(raw)) : [];
    if (Array.isArray(list)) set({ builds: list.filter((b) => b && typeof b.sha256 === 'string' && Array.isArray(b.slots)).slice(-400) });
  } catch { /* start empty */ }
}
export async function recordBuild(file: Uint8Array, changes: SlotChange[]): Promise<void> {
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
  if (summary.ratioShade) lines.push(t('ratioShadeLine', { p: toneLabel(summary.ratioShadeTone ?? 'dark') }));
  if (summary.adjSoftFocus) lines.push(t('softAdjLine'));
  if (summary.brightAuto) lines.push(t(summary.brightAuto === 'balanced' ? 'brightAutoBalanced' : 'brightAutoBright'));
  if (summary.dateStamp) lines.push(t('dateLine'));
  if (summary.monoUnlock) lines.push(t(state.info?.family === 'gr3x' ? 'gr3xReplicaLine' : 'monoLine'));
  if (summary.directFlash) lines.push(t('flashLine'));
  if (summary.hdrGainMap) lines.push(t('hdrLine'));
  if (summary.exposurePreview) lines.push(t(summary.directFlash ? 'previewLine' : 'previewLineNoFlash'));
  if (summary.shadowLearn) lines.push(t('shadowLine'));
  if (summary.filmGrain) lines.push(t('grainLine'));
  if (summary.flashTtl) lines.push(t('flashTtlLine'));
  if (summary.videoAf) lines.push(t('videoAfLine'));
  if (summary.awbLearn) lines.push(t('awbLine'));
  if (summary.movieExposure) lines.push(t('movieExpLine'));
  if (summary.constantLight) lines.push(t('lampLine'));
  if (summary.sensorShift) lines.push(t('shiftLine'));
  if (summary.movie4k) lines.push(t('movie4kLine'));
  if (summary.movieSr) lines.push(t('movieSrLine'));
  if (summary.distanceFeet) lines.push(t('unitsLine'));
  if (summary.adjSlots) lines.push(t('adjSlotsLine', { n: summary.adjSlots }));
  if (summary.batteryPercent) lines.push(t('batteryLine'));
  if (summary.customGrid) lines.push(t('gridLine', { a: gridText(summary.customGrid, 'g3'), b: gridText(summary.customGrid, 'g4') }));
  if (summary.framing) lines.push(t('framingLine', { n: framingValues(summary.framing).length }));
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
  if (!pick) return;
  if (!v) { toast(t('noCard'), 'error'); return; }
  const official = pick.summary.kind === 'official';
  const fresh = newFirmwareWarning(sourceInfo) ?? undefined;
  if (!(await (official ? askOfficial(describeCopy(pick.summary), fresh) : ask(t('confirmTitle'), describeCopy(pick.summary), t('confirmOk'), fresh)))) return;
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
