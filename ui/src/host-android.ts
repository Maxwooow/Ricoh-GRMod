// The Android app (mobile/): the same interface as the desktop shell's API (host.ts), provided by the app's
// native GrCamera plugin through Capacitor. There is no memory card here: firmware goes to the camera over
// Wi-Fi (camera.ts) or into the phone's Downloads folder.
import { useEffect, useRef } from 'react';
import type { DirEntry, FirmwareRelease, HostInfo, ParkedEntry, ParkedFailure, ReleaseNote, UpdateInfo, UpdateState, Volume } from './host';

interface PluginListener { remove: () => Promise<void> }
export interface GrCameraPlugin {
  [method: string]: ((args?: Record<string, unknown>) => Promise<any>) | any; // eslint-disable-line @typescript-eslint/no-explicit-any
  addListener(event: string, f: (data: any) => void): Promise<PluginListener> | PluginListener; // eslint-disable-line @typescript-eslint/no-explicit-any
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: (name: string) => unknown;
  Plugins?: Record<string, unknown>;
  convertFileSrc?: (path: string) => string;
}

const cap = (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
export const isAndroid = !!cap && !!cap.isNativePlatform?.() && cap.getPlatform?.() === 'android';
export const Gr: GrCameraPlugin = (isAndroid ? (cap!.registerPlugin ? cap!.registerPlugin('GrCamera') : cap!.Plugins?.GrCamera) : undefined) as GrCameraPlugin;

declare const __GRMOD_VERSION__: string;
const version = typeof __GRMOD_VERSION__ === 'string' ? __GRMOD_VERSION__ : '';
const REPO = 'Maxwooow/Ricoh-GRMod';

class AndroidHostError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
// host.ts's HostError (imported lazily there to avoid a cycle): same shape, same `instanceof` checks are not
// needed by the callers, which read `code`.
let HostErrorCtor: new (code: string, message: string) => Error & { code: string } = AndroidHostError;
export function useHostError(c: typeof HostErrorCtor): void { HostErrorCtor = c; }
const err = (code: string, message: string): Error => new HostErrorCtor(code, message);
const fromPlugin = (e: unknown, fallback = 'io'): Error => {
  const x = e as { code?: string; message?: string };
  return err(x && typeof x.code === 'string' && x.code ? x.code : fallback, String(x?.message ?? e));
};

/**
 * Listens to an event of the app; returns the function that stops listening. The app's addListener gives a
 * promise of the handle in some Capacitor builds and the handle itself in others (calling .then on the handle
 * broke the page when the push dialog closed), so both are taken.
 */
export function listen(event: string, f: (data: any) => void): () => void { // eslint-disable-line @typescript-eslint/no-explicit-any
  let handle: unknown;
  try { handle = Gr.addListener(event, f); } catch { return () => { /* none */ }; }
  return () => { Promise.resolve(handle).then((h) => (h as PluginListener | undefined)?.remove?.()).catch(() => { /* gone */ }); };
}

/** Reads a file of the app's own storage through the WebView's file server (no base64 on the way). */
export async function readAppFile(path: string): Promise<Uint8Array> {
  const url = cap!.convertFileSrc!(path);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw err('io', `cannot read ${path}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** Hands bytes to the app in 1 MB pieces; `to` says where they end up (see GrCameraPlugin.uploadEnd). */
export async function upload(data: Uint8Array, to: Record<string, unknown>): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { id } = await Gr.uploadBegin();
  const CH = 1 << 20;
  for (let o = 0; o < data.length; o += CH) await Gr.uploadAppend({ id, data: base64(data.subarray(o, Math.min(data.length, o + CH))) });
  return Gr.uploadEnd({ id, ...to });
}

const unsupported = (): never => { throw err('unsupported', 'not available on Android'); };

let fwProgress = { active: false, received: 0, total: 0 };
if (isAndroid) void Gr.addListener('firmwareProgress', (p: { received: number; total: number }) => { fwProgress = { active: true, received: p.received, total: p.total }; });

const info: HostInfo = { kind: 'android', token: '', version, os: 'android' };

export const androidHost = {
  available: isAndroid,
  info: isAndroid ? info : undefined,
  sep: '/',
  join(root: string, ...parts: string[]): string { return [root, ...parts].join('/').replace(/\/+/g, '/'); },
  async volumes(_all = false): Promise<Volume[]> { return []; },
  async list(_path: string): Promise<DirEntry[]> { return []; },
  async read(_path: string): Promise<Uint8Array> { return unsupported(); },
  async write(_path: string, _data: Uint8Array): Promise<{ size: number; sha256: string }> { return unsupported(); },
  async move(_from: string, _to: string): Promise<void> { unsupported(); },
  async pickDirectory(_title: string): Promise<string> { return ''; },
  async reveal(_path: string): Promise<void> { /* nothing to show */ },
  async eject(_id: string): Promise<void> { unsupported(); },
  async storeGet(key: string): Promise<Uint8Array | null> {
    let r: { exists: boolean; path?: string };
    try { r = await Gr.storeRead({ key }); } catch (e) { throw fromPlugin(e); }
    return r.exists && r.path ? readAppFile(r.path) : null;
  },
  async storeSet(key: string, data: Uint8Array | string): Promise<void> {
    try { await upload(typeof data === 'string' ? new TextEncoder().encode(data) : data, { to: 'store', key }); } catch (e) { throw fromPlugin(e); }
  },
  async storeDel(key: string): Promise<void> { try { await Gr.storeDelete({ key }); } catch (e) { throw fromPlugin(e); } },
  async parked(_volumeId: string): Promise<ParkedEntry[]> { return []; },
  async parkedRead(_volumeId: string, _path: string): Promise<Uint8Array> { return unsupported(); },
  async parkedDelete(_volumeId: string, _paths: string[]): Promise<{ deleted: string[]; failed: ParkedFailure[] }> { return { deleted: [], failed: [] }; },
  async parkedBackup(_volumeId: string, _paths: string[]): Promise<{ saved: { path: string; dest: string; existed: boolean }[]; failed: ParkedFailure[] }> { return { saved: [], failed: [] }; },
  async backups(): Promise<{ dir: string; entries: ParkedEntry[] }> { return { dir: '', entries: [] }; },
  async backupRead(_path: string): Promise<Uint8Array> { return unsupported(); },
  async backupsDelete(_paths: string[]): Promise<{ deleted: string[]; failed: ParkedFailure[] }> { return { deleted: [], failed: [] }; },
  async backupsReveal(_path?: string): Promise<void> { /* none */ },
  async windowChrome(_c: { caption: string; text: string; dark: boolean }): Promise<void> { /* the system bars follow the theme */ },
  async firmwareLatest(model: string): Promise<FirmwareRelease | null> {
    try { return await Gr.firmwareLatest({ model }); }
    catch (e) { const x = fromPlugin(e, 'network') as Error & { code: string }; if (x.code === 'not-found') return null; throw x; }
  },
  async firmwareDownload(model: string, version?: string, signal?: AbortSignal): Promise<{ name: string; version: string; data: Uint8Array }> {
    fwProgress = { active: true, received: 0, total: 0 };
    const stop = (): void => { void Gr.firmwareCancel(); };
    signal?.addEventListener('abort', stop);
    try {
      const r = await Gr.firmwareDownload(version ? { model, version } : { model });
      if (signal?.aborted) throw err('cancelled', 'cancelled');
      return { name: r.name || 'fwdc248b.bin', version: r.version || '', data: await readAppFile(r.path) };
    } catch (e) {
      throw signal?.aborted ? err('cancelled', 'cancelled') : fromPlugin(e, 'network');
    } finally {
      signal?.removeEventListener('abort', stop);
      fwProgress = { active: false, received: 0, total: 0 };
    }
  },
  async firmwareProgress(): Promise<{ active: boolean; received: number; total: number }> { return fwProgress; },
  async firmwarePage(model: string, version?: string): Promise<void> { try { await Gr.firmwarePage(version ? { model, version } : { model }); } catch { /* no browser */ } },
  // ---- updates: the app is installed from the project's releases; it only shows what is new there
  async updateCheck(): Promise<UpdateInfo> { return { current: version, available: false, size: 0, canInstall: false, reason: 'manual', ready: false }; },
  async updateDownload(_signal?: AbortSignal): Promise<void> { unsupported(); },
  async updateProgress(): Promise<{ active: boolean; received: number; total: number }> { return { active: false, received: 0, total: 0 }; },
  async updateInstall(): Promise<void> { unsupported(); },
  async updatePage(): Promise<void> { await openUrl(`https://github.com/${REPO}/releases`); },
  async updateState(): Promise<UpdateState> { return { current: version }; },
  async updateNotes(): Promise<UpdateState & { releases: ReleaseNote[] }> {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw err('network', `releases: ${res.status}`);
    const list = (await res.json()) as { tag_name: string; name?: string; body?: string; published_at?: string; html_url?: string; draft?: boolean; prerelease?: boolean }[];
    const releases = list.filter((r) => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name))
      .map((r) => ({ version: r.tag_name.replace(/^v/, ''), name: r.name, date: r.published_at?.slice(0, 10), body: r.body || '', page: r.html_url }));
    return { current: version, releases };
  },
  async credits(): Promise<unknown> {
    for (const url of [`https://raw.githubusercontent.com/${REPO}/main/credits.json`, `https://cdn.jsdelivr.net/gh/${REPO}@main/credits.json`]) {
      try { const res = await fetch(url, { cache: 'no-store' }); if (res.ok) return await res.json(); } catch { /* next */ }
    }
    return null;
  },
  async releasePage(v: string): Promise<void> { await openUrl(`https://github.com/${REPO}/releases/tag/v${v}`); },
  async sidecar(_name: string): Promise<Uint8Array | null> { return null; },
};

/** A light tap of the phone's vibration motor (as the system's own controls give). */
export function haptic(kind: 'tick' | 'confirm' = 'tick'): void { if (isAndroid) Promise.resolve().then(() => Gr.haptic({ kind })).catch(() => { /* none */ }); }

export async function openUrl(url: string): Promise<void> { try { await Gr.openUrl({ url }); } catch { /* no browser */ } }

// ---- the system back button / gesture (MainActivity hands it over as the "back" event)
// Whatever is open on top (a sheet, a dialog) takes it first, through useBack; dialogs that close on Escape get an
// Escape; then the other pages go back to the first; on the first page the app goes to the background
// (as Home: nothing is lost). The WebView itself never goes "back" (that left an empty page).
const backs: { run: () => void }[] = [];
let fallback: () => boolean = () => false;
/** While `active`, the back button runs `fn` (the latest one opened wins). */
export function useBack(active: boolean, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const entry = { run: () => ref.current() };
    backs.push(entry);
    return () => { const i = backs.indexOf(entry); if (i >= 0) backs.splice(i, 1); };
  }, [active]);
}
/** What back does when nothing is open: returns false to leave the app. */
export function setBackFallback(f: () => boolean): void { fallback = f; }
function onBack(): void {
  const top = backs[backs.length - 1];
  if (top) { top.run(); return; }
  if (document.querySelector('.overlay')) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return;
  }
  if (fallback()) return;
  Promise.resolve().then(() => Gr.leave()).catch(() => { /* none */ });
}
if (isAndroid) void Gr.addListener('back', onBack);
