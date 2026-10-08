// The platform behind the page. On Windows this is the GRMod shell's local HTTP API; another
// platform (Android) would provide the same interface with its own implementation.
export interface HostInfo { kind: string; token: string; version: string; os: string }
export interface Volume { id: string; root: string; label: string; fs: string; total: number; free: number; removable: boolean; bus: string }
export interface DirEntry { name: string; dir: boolean; size: number; mtime: number }
/** A file below `GRMOD\parked-*` on a card, or below the backups folder on the computer; `path` is relative to that. */
export interface ParkedEntry { path: string; size: number; mtime: number }
export interface ParkedFailure { path: string; error: string }
/** The firmware update Ricoh's site currently offers for a model. `page` is the model's download page there. */
export interface FirmwareRelease { model: string; name: string; applies: string; version: string; date: string; page: string; file: string; size: number }

export class HostError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const info = (globalThis as unknown as { __GRMOD_HOST__?: HostInfo }).__GRMOD_HOST__;

async function call(method: string, path: string, body?: BodyInit | null, json = true, signal?: AbortSignal): Promise<Response> {
  if (!info) throw new HostError('no-host', 'host not available');
  const headers: Record<string, string> = { 'X-GRMod-Token': info.token };
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  else if (body) headers['Content-Type'] = 'application/octet-stream';
  let res: Response;
  try { res = await fetch(path, { method, headers, body, cache: 'no-store', signal }); }
  catch (e) { throw new HostError(signal?.aborted ? 'cancelled' : 'offline', String(e)); }
  if (!res.ok) {
    let code = 'io'; let message = res.statusText;
    try { const j = await res.json(); if (j && j.error) { code = j.error.code || code; message = j.error.message || message; } } catch { /* not json */ }
    throw new HostError(code, message);
  }
  void json;
  return res;
}
const q = (s: string): string => encodeURIComponent(s);
const post = async <T>(path: string, body: unknown): Promise<T> => (await call('POST', path, JSON.stringify(body))).json() as Promise<T>;

export const host = {
  available: !!info,
  info,
  sep: info && info.os === 'windows' ? '\\' : '/',
  join(root: string, ...parts: string[]): string {
    let p = root;
    for (const part of parts) p = p.endsWith(this.sep) ? p + part : p + this.sep + part;
    return p;
  },
  async volumes(all = false): Promise<Volume[]> { return ((await (await call('GET', '/api/volumes' + (all ? '?all=1' : ''))).json()) as { volumes: Volume[] }).volumes || []; },
  async list(path: string): Promise<DirEntry[]> {
    try { return ((await (await call('GET', '/api/list?path=' + q(path))).json()) as { entries: DirEntry[] }).entries || []; }
    catch (e) { if (e instanceof HostError && e.code === 'not-found') return []; throw e; }
  },
  async read(path: string): Promise<Uint8Array> { return new Uint8Array(await (await call('GET', '/api/read?path=' + q(path))).arrayBuffer()); },
  async write(path: string, data: Uint8Array): Promise<{ size: number; sha256: string }> { return (await call('PUT', '/api/write?path=' + q(path), data as unknown as BodyInit)).json(); },
  async move(from: string, to: string): Promise<void> { await post('/api/move', { from, to }); },
  async pickDirectory(title: string): Promise<string> { return (await post<{ path: string }>('/api/pick-directory', { title })).path || ''; },
  async reveal(path: string): Promise<void> { try { await post('/api/reveal', { path }); } catch { /* cosmetic */ } },
  async eject(id: string): Promise<void> { await post('/api/eject', { id }); },
  async storeGet(key: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await (await call('GET', '/api/store/' + key)).arrayBuffer()); }
    catch (e) { if (e instanceof HostError && e.code === 'not-found') return null; throw e; }
  },
  async storeSet(key: string, data: Uint8Array | string): Promise<void> { await call('PUT', '/api/store/' + key, (typeof data === 'string' ? new TextEncoder().encode(data) : data) as unknown as BodyInit); },
  async storeDel(key: string): Promise<void> { await call('DELETE', '/api/store/' + key); },
  // ---- files that were moved aside on a card, and their backups on the computer
  async parked(volumeId: string): Promise<ParkedEntry[]> { return ((await (await call('GET', '/api/parked?volume=' + q(volumeId))).json()) as { entries: ParkedEntry[] }).entries || []; },
  async parkedRead(volumeId: string, path: string): Promise<Uint8Array> { return new Uint8Array(await (await call('GET', `/api/parked/read?volume=${q(volumeId)}&path=${q(path)}`)).arrayBuffer()); },
  async parkedDelete(volumeId: string, paths: string[]): Promise<{ deleted: string[]; failed: ParkedFailure[] }> { return post('/api/parked/delete', { volume: volumeId, paths }); },
  async parkedBackup(volumeId: string, paths: string[]): Promise<{ saved: { path: string; dest: string; existed: boolean }[]; failed: ParkedFailure[] }> { return post('/api/parked/backup', { volume: volumeId, paths }); },
  async backups(): Promise<{ dir: string; entries: ParkedEntry[] }> { return (await call('GET', '/api/backups')).json(); },
  async backupRead(path: string): Promise<Uint8Array> { return new Uint8Array(await (await call('GET', '/api/backups/read?path=' + q(path))).arrayBuffer()); },
  async backupsDelete(paths: string[]): Promise<{ deleted: string[]; failed: ParkedFailure[] }> { return post('/api/backups/delete', { paths }); },
  async backupsReveal(path?: string): Promise<void> { try { await post('/api/backups/reveal', path ? { path } : {}); } catch { /* cosmetic */ } },
  /** Colours for the native window frame, so that it continues the interface. Ignored where there is no such frame. */
  async windowChrome(c: { caption: string; text: string; dark: boolean }): Promise<void> {
    try { await post('/api/window/chrome', c); } catch { /* cosmetic */ }
  },
  // ---- the official firmware, fetched from Ricoh's site by the shell (the page only names the model)
  /** What the site offers for a model right now; null when it lists nothing for it. */
  async firmwareLatest(model: string): Promise<FirmwareRelease | null> {
    try { return (await call('GET', '/api/firmware/latest?model=' + q(model))).json(); }
    catch (e) { if (e instanceof HostError && e.code === 'not-found') return null; throw e; }
  },
  async firmwareDownload(model: string, signal?: AbortSignal): Promise<{ name: string; version: string; data: Uint8Array }> {
    const res = await call('POST', '/api/firmware/download', JSON.stringify({ model }), true, signal);
    let data: Uint8Array;
    try { data = new Uint8Array(await res.arrayBuffer()); }
    catch (e) { throw new HostError(signal?.aborted ? 'cancelled' : 'offline', String(e)); }
    return { name: res.headers.get('X-GRMod-Firmware-Name') || 'fwdc248b.bin', version: res.headers.get('X-GRMod-Firmware-Version') || '', data };
  },
  async firmwareProgress(): Promise<{ active: boolean; received: number; total: number }> { return (await call('GET', '/api/firmware/progress')).json(); },
  /** Show the model's download page (with Ricoh's licence terms) in the browser. */
  async firmwarePage(model: string): Promise<void> { try { await post('/api/firmware/page', { model }); } catch { /* no browser */ } },
  /** A file the user may keep next to the program (e.g. `preview.jpg`); null when there is none. */
  async sidecar(name: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await (await call('GET', '/api/sidecar/' + name)).arrayBuffer()); }
    catch { return null; }
  },
};

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}
