import { card, LANGS } from '@grmod/core';
import type { LangCode, SlotId, SlotRequest } from '@grmod/core';
import { engine, EngineError } from '../engine';
import { host, HostError, sha256Hex } from '../host';
import { upload } from '../host-android';
import type { Volume } from '../host';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { State, ask, askOfficial, availableSlots, fail, filmCountChoosable, newFirmwareWarning, set, state, toast } from './core';
import { scheduleSave } from './families';
import { nameProblem } from './slots';
import { extraSpecs, hasExtraErrors, lookLayoutSpec } from './looks';
import { menuPictures, menuReady } from './wall';
import { GR3X_SOFT_FOCUS, adjSlotsOf, batteryOn, brightAutoOf, customGridOf, directFlashOn, exposurePreviewOn, filmGrainOn, flashTtlOn, hdrOn, videoAfOn, awbLearnOn, constantLightOn, movieExposureOn, sensorShiftOn, movie4kOn, movieSrOn, distanceFeetOn, monoUnlockOn, shadowLearnOn, softOn } from './features';
import { hasRatioErrors, ratioShadeOn, ratioSpecs, toneLabel } from './ratios';
import { canEject } from './photo';
import { recordBuild, refreshCopies } from './copies';
import { framingOf } from './framing';

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
type Dest = { kind: 'card' } | { kind: 'folder' } | { kind: 'camera' } | { kind: 'phone' };
async function destination(dest: Dest): Promise<{ root: string; volume?: Volume } | null> {
  // The phone app: to the camera over Wi-Fi, or into the phone's own files.
  if (dest.kind === 'camera' || dest.kind === 'phone') return { root: '' };
  if (dest.kind === 'card') {
    const v = state.volumes.find((x) => x.id === state.volumeId);
    if (!v) { toast(t('noCard'), 'error'); return null; }
    return { root: v.root, volume: v };
  }
  const path = await host.pickDirectory(t('pickFolder'));
  return path ? { root: path } : null;
}
export function doneToast(root: string, volume: Volume | undefined, moved: number, file: string): void {
  const text = (volume ? t('written', { p: host.join(root, file) }) : t('exported', { p: root })) + (moved ? ` · ${t('parked', { n: moved })}` : '');
  if (volume && canEject()) {
    toast(text, 'ok', { label: t('eject'), run: () => { host.eject(volume.id).then(() => { toast(t('ejected'), 'ok'); void refreshVolumes(); }).catch(fail); } });
  } else toast(text, 'ok', { label: t('reveal'), run: () => { void host.reveal(host.join(root, file)); } });
}

/** Turn a card into a firmware card holding `file` (what is in the way, such as a start-up script of GR Mod 0.7's power-off images, is moved aside). */
export async function firmwareToCard(volume: Volume, file: Uint8Array): Promise<number> {
  return runPlan(volume.root, card.planFirmwareCard(await listing(volume.root), file, await freshStamp(volume.root), firmwareFilename()));
}

/** The update file name the open firmware's camera looks for (GR IV fwdc248b, GR IIIx fwdc243b, GR III fwdc239b). */
export const firmwareFilename = (): card.FirmwareFilename => {
  const name = state.info?.filename;
  return (card.FIRMWARE_FILES as readonly string[]).includes(name ?? '') ? name as card.FirmwareFilename : card.FIRMWARE_FILE;
};

export async function outputFirmware(dest: Dest, stock = false): Promise<void> {
  if (!state.info?.models.includes(state.model)) return;
  if (!stock && !state.info.capabilities.build) { toast(t('fwCannotBuild'), 'info'); return; }
  if (state.busy || state.fwBusy || !state.info || !state.raw) return;
  const sourceInfo = state.info, sourceRaw = state.raw, sourceModel = state.model;
  const changes = stock ? [] : pendingChanges();
  const ratios = stock ? [] : ratioSpecs();
  if (!stock && state.info.family === 'gr3x' && ratios.length === 0) { toast(t('gr3xNeedRatio'), 'info'); return; }
  const soft = !stock && softOn();
  const dateStamp = !stock && !!state.dateStamp && !!state.info.features.dateStamp;
  const monoUnlock = !stock && monoUnlockOn();
  const directFlash = !stock && directFlashOn();
  const hdr = !stock && hdrOn();
  const exposurePreview = !stock && exposurePreviewOn();
  const ratioShade = !stock && ratioShadeOn(state, ratios);
  const battery = !stock && batteryOn();
  const customGrid = stock ? undefined : customGridOf();
  const framing = stock ? undefined : framingOf();
  const shadowLearn = !stock && shadowLearnOn();
  const filmGrain = !stock && filmGrainOn();
  const flashTtl = !stock && flashTtlOn();
  const videoAf = !stock && videoAfOn();
  const awbLearn = !stock && awbLearnOn();
  const movieExposure = !stock && movieExposureOn();
  const constantLight = !stock && constantLightOn();
  const sensorShift = !stock && sensorShiftOn();
  const movie4k = !stock && movie4kOn();
  const movieSr = !stock && movieSrOn();
  const distanceFeet = !stock && distanceFeetOn();
  const brightAuto = stock ? false : brightAutoOf();
  const adjSlots = stock ? 5 : adjSlotsOf();
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
  if (!stock && changes.length === 0 && ratios.length === 0 && !soft && !dateStamp && !monoUnlock && !directFlash && !hdr && !exposurePreview && !filmGrain && !shadowLearn && !battery && !customGrid && !framing && !flashTtl && !videoAf && !awbLearn && !movieExposure && !sensorShift && !movie4k && !movieSr && !distanceFeet && !constantLight && !brightAuto && adjSlots === 5 && extras.length === 0 && pictures.length === 0 && films === 0 && !lookLayout) { toast(t('nothingToDo'), 'info'); return; }
  const fresh = newFirmwareWarning(sourceInfo);
  // The cannot-go-back warning is a paragraph (the dialog's lines are cut to one line each).
  // GR III / IIIx cannot take a firmware over Wi-Fi (only the GR IV's camera has that interface).
  if (dest.kind === 'camera' && sourceInfo.family !== 'gr4') { toast(t('pushOnlyGr4'), 'info'); return; }
  // everything that leaves for a camera (also a file saved on the phone for it) is confirmed first
  const toCamera = dest.kind === 'card' || dest.kind === 'camera' || dest.kind === 'phone';
  if (stock && !(await askOfficial([t('copyOfficial')], fresh && toCamera ? fresh : undefined))) return;
  if (toCamera && !stock) {
    // The check before writing: only what changes, by name; with a count where one item holds several.
    const named = (name: string, n: number, unit: Key = 'chkCount'): string => (n > 1 ? `${name}  ·  ${t(unit, { n })}` : name);
    const lines = changes.map((c) => named(state.info?.family === 'gr3x' ? (state.slots[c.id].names[state.lang] || state.info.slots.find(s => s.id === c.id)?.defaultName || c.id) : t(('slot' + c.id) as Key), c.labels.length, 'chkChanges'));
    if (ratios.length) lines.push(named(t('chkRatios'), ratios.length));
    if (ratioShade) lines.push(`${t('ratioLive')}  ·  ${toneLabel(state.ratioShadeTone)}`);
    if (soft) lines.push(t('navSoft'));
    if (films) lines.push(named(t('extraTitle'), films));
    if (dateStamp) lines.push(t('navDate'));
    if (monoUnlock) lines.push(t(state.info?.family === 'gr3x' ? 'gr3xReplicaTitle' : 'navMono'));
    if (brightAuto) lines.push(t('navBrightAuto'));
    if (directFlash) lines.push(t('navFlash'));
    if (hdr) lines.push(t('navHdr'));
    if (exposurePreview) lines.push(t('navPreview'));
    if (battery) lines.push(t('navBattery'));
    if (customGrid || framing) lines.push(t('navGrid'));
    if (shadowLearn) lines.push(t('navShadow'));
    if (filmGrain) lines.push(t('navGrain'));
    if (flashTtl) lines.push(t('navFlashTtl'));
    if (videoAf) lines.push(t('navVideoAf'));
    if (awbLearn) lines.push(t('navAwb'));
    if (movieExposure) lines.push(t('navMovieExp'));
    if (constantLight) lines.push(t('navLamp'));
    if (sensorShift) lines.push(t('navShift'));
    if (movie4k) lines.push(t('navMovie4k'));
    if (movieSr) lines.push(t('navMovieSr'));
    if (distanceFeet) lines.push(t('unitsLine'));
    if (adjSlots > 5) lines.push(`${t('navAdjSlots')}  ·  ${t('chkCount', { n: adjSlots })}`);
    if (extras.length) lines.push(named(t('extraTitle'), extras.length));
    if (lookLayout) lines.push(lookLayout.hidden.length ? `${t('icViewOrder')}  ·  ${t('chkHidden', { n: lookLayout.hidden.length })}` : t('icViewOrder'));
    if (pictures.length) lines.push(named(t('navWall'), pictures.length, 'chkPictures'));
    const [title, ok] = dest.kind === 'camera' ? [t('pushTitle'), t('pushStart')] : dest.kind === 'phone' ? [t('saveTitle'), t('saveStart')] : [t('confirmTitle'), t('confirmOk')];
    if (!(await ask(title, lines, ok, fresh ?? undefined))) return;
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
        { ...(brightAuto ? { brightAuto } : {}), adjSoftFocus: soft && sourceInfo.features.softFocus === 'adj', dateStamp, monoUnlock, ...(directFlash ? { directFlash } : {}), ...(ratioShade ? { ratioShade, ratioShadeTone: state.ratioShadeTone } : {}), ...(hdr ? { hdrGainMap: true } : {}), ...(exposurePreview ? { exposurePreview: true } : {}), ...(shadowLearn ? { shadowLearn: true } : {}), ...(battery ? { batteryPercent: true } : {}), ...(customGrid ? { customGrid } : {}), ...(framing ? { framing } : {}), ...(filmGrain ? { filmGrain: true } : {}), ...(flashTtl ? { flashTtl: true } : {}), ...(videoAf ? { videoAf: true } : {}), ...(awbLearn ? { awbLearn: true } : {}), ...(movieExposure ? { movieExposure: true } : {}), ...(sensorShift ? { sensorShift: true } : {}), ...(movie4k ? { movie4k: true } : {}), ...(movieSr ? { movieSr: true } : {}), ...(distanceFeet ? { distanceFeet: true } : {}), ...(constantLight ? { constantLight: true } : {}), ...(adjSlots > 5 ? { adjSlots } : {}), ...(extras.length ? { extraSlots: extras } : {}), ...(pictures.length ? { shutdownPictures: pictures } : {}),
          ...(films ? { filmCount: films } : {}), ...(lookLayout ? { lookLayout } : {}) });
      if (!Object.values(built.checks).every((v) => v === true)) throw new EngineError('selfcheck-failed', 'self-check');
      file = built.file;
      void recordBuild(file, changes);
    }
    if (dest.kind === 'camera') { set({ busy: undefined, push: { file, label: firmwareFilename(), stock } }); return; }
    if (dest.kind === 'phone') {
      set({ busy: t('writing') });
      // Android: Download/GR Mod/…; iOS: wherever the user puts it in the Files app (or nowhere: cancelled)
      const r = await upload(file, { to: 'download', name: firmwareFilename() }) as { path?: string; cancelled?: boolean };
      set({ busy: undefined });
      if (!r.cancelled) toast(t('savedTo', { p: r.path ?? '' }), 'ok');
      return;
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


export function wallReady(s: State = state): boolean { return menuReady(s); }
export function closePush(): void { set({ push: undefined }); }
