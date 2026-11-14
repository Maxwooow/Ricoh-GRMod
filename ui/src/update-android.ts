/**
 * GR Mod's own updates on Android (the APK is not from a store; iOS updates come from the App Store).
 *
 * Every GitHub release that carries the Android app also carries update-android.json and update-android.json.sig:
 * the manifest (version, notes, the APK's address, size and SHA-256) and its Ed25519 signature, made with the same
 * key as the desktop app's update.json (tools/updatesign; the public key is the one in shell/updates.go). The
 * manifest is used only when the signature verifies; the native side then downloads the APK, keeps it only with
 * the signed size and SHA-256 and hands it to the system's installer, which in turn accepts only an APK signed
 * with the installed app's key.
 */
import { verifyAsync } from '@noble/ed25519';

/** The project's update key (shell/updates.go: updatePublicKey). */
export const UPDATE_KEY = 'SmDyXQIIsZYfZ06bPIdeuzDMvpT4FbELxGu9BuCVx+I=';
const LATEST = 'https://github.com/Maxwooow/Ricoh-GRMod/releases/latest/download/';
export const MANIFEST_NAME = 'update-android.json';
const FILE_URL = /^https:\/\/github\.com\/Maxwooow\/Ricoh-GRMod\/releases\/download\/[^/?#]+\/[^/?#]+\.apk$/;

export interface AndroidManifest {
  app: 'GRMod-Android';
  version: string;
  versionCode?: number;
  date?: string;
  notes?: { zh?: string; en?: string };
  page?: string;
  file: { name: string; url: string; size: number; sha256: string };
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

/** The manifest when the signature over exactly these bytes verifies and its fields make sense, else null. */
export async function verifyManifest(text: string, sig: string, key = UPDATE_KEY): Promise<AndroidManifest | null> {
  let s: Uint8Array;
  try { s = fromB64(sig); } catch { return null; }
  if (s.length !== 64) return null;
  let ok = false;
  try { ok = await verifyAsync(s, new TextEncoder().encode(text), fromB64(key)); } catch { ok = false; }
  if (!ok) return null;
  let m: AndroidManifest;
  try { m = JSON.parse(text) as AndroidManifest; } catch { return null; }
  const f = m?.file;
  if (m?.app !== 'GRMod-Android' || typeof m.version !== 'string' || !/^\d+(\.\d+)*$/.test(m.version)) return null;
  if (!f || typeof f.url !== 'string' || !FILE_URL.test(f.url) || !(Number.isSafeInteger(f.size) && f.size > 0)
    || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) return null;
  return m;
}

/** -1, 0, 1 for numeric versions such as 0.3.10 and 0.3.9. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface Fetcher { (url: string): Promise<string> }

/**
 * The newer version's manifest, or null when this is the newest (or the latest release has no Android files, or
 * they do not verify). Network trouble throws.
 */
export async function findUpdate(current: string, fetchText: Fetcher): Promise<AndroidManifest | null> {
  let text: string;
  try { text = await fetchText(LATEST + MANIFEST_NAME); } catch (e) {
    if (/404/.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
  const sig = await fetchText(LATEST + MANIFEST_NAME + '.sig');
  const m = await verifyManifest(text, sig);
  if (!m) return null;
  return compareVersions(m.version, current) > 0 ? m : null;
}

// ------------------------------------------------------------------ when to look by itself

const LAST = 'grmod.updateChecked';
const SKIP = 'grmod.updateSkipped';
const EVERY = 12 * 3600 * 1000;

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* private storage */ } };

/** At most every 12 hours by itself. */
export function autoCheckDue(now = Date.now()): boolean {
  const last = Number(get(LAST) || 0);
  return !(last > 0 && now - last < EVERY && now >= last);
}
export function markChecked(now = Date.now()): void { set(LAST, String(now)); }
/** "Later" on an offer: that version is not offered again by itself (the settings can still find it). */
export function skipVersion(v: string): void { set(SKIP, v); }
export function isSkipped(v: string): boolean { return get(SKIP) === v; }
