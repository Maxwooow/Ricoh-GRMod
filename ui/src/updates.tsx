// Updates of GR Mod itself: an optional check at start, "Check for updates" in the ? menu, and a
// dialog that downloads the new version, has the shell verify it against the signed manifest and
// then replace and restart the program (see shell/internal/update).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Ico, Switch } from './components';
import { host, HostError } from './host';
import type { ReleaseNote, UpdateInfo } from './host';
import { Markdown } from './markdown';
import { t } from './i18n';
import type { Key } from './i18n';
import { toast } from './store';

const SETTINGS_KEY = 'update-settings.json';
const lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';

type Phase = 'idle' | 'checking' | 'error' | 'latest' | 'available' | 'downloading' | 'installing';
interface UpdState { open: boolean; phase: Phase; info?: UpdateInfo; received: number; total: number; auto: boolean; message?: string }

let st: UpdState = { open: false, phase: 'idle', received: 0, total: 0, auto: true };
const subs = new Set<() => void>();
function put(patch: Partial<UpdState>): void { st = { ...st, ...patch }; subs.forEach((f) => f()); }
function useUpd(): UpdState { return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => st); }

async function loadSettings(): Promise<boolean> {
  try {
    const raw = await host.storeGet(SETTINGS_KEY);
    if (raw) return JSON.parse(new TextDecoder().decode(raw)).auto !== false;
  } catch { /* defaults */ }
  return true;
}
function setAuto(auto: boolean): void {
  put({ auto });
  void host.storeSet(SETTINGS_KEY, JSON.stringify({ auto })).catch(() => undefined);
}

/** Asks the shell; quiet: no dialog, only the pill and a toast when there is something new. */
export async function checkForUpdate(quiet: boolean): Promise<void> {
  if (!host.available || st.phase === 'checking' || st.phase === 'downloading' || st.phase === 'installing') return;
  if (!quiet) put({ open: true, phase: 'checking', message: undefined });
  try {
    const info = await host.updateCheck();
    // After an update the what's-new dialog says it (see UpdateWatcher); a toast only when it was already shown.
    if (info.updatedFrom && quiet && !wn.open && seenVersion === info.current && !shownThisRun) toast(t('updDone', { v: info.current }), 'ok');
    if (info.available) {
      put({ info, phase: 'available' });
      if (quiet) toast(t('updToast', { v: info.latest || '' }), 'info', { label: t('updView'), run: () => put({ open: true }) });
    } else {
      put({ info, phase: quiet ? 'idle' : 'latest' });
    }
  } catch {
    if (!quiet) put({ phase: 'error' });
  }
}

/** Runs once at start: remembers the setting and checks when it is on. */
export function UpdateWatcher() {
  useEffect(() => {
    if (!host.available) return;
    let live = true;
    void loadSettings().then((auto) => {
      if (!live) return;
      put({ auto });
      if (auto) setTimeout(() => { void checkForUpdate(true); }, 1500);
    });
    // The first run after an update: what's new in this version, once.
    void (async () => {
      try {
        const [state, seen] = await Promise.all([host.updateState(), loadSeen()]);
        seenVersion = seen;
        if (!live || !state.updatedFrom || seen === state.current) return;
        shownThisRun = true;
        openWhatsNew(state.updatedFrom);
        saveSeen(state.current);
      } catch { /* an older shell: no state */ }
    })();
    return () => { live = false; };
  }, []);
  return <><UpdateDialog /><WhatsNewDialog /></>;
}

/** The small "Update" pill next to the version number. */
export function UpdatePill() {
  const s = useUpd();
  if (!s.info?.available || s.open) return null;
  return <button className="upd-pill" onClick={() => put({ open: true })}>{Ico.download}<span>{t('updPill')}</span></button>;
}

const REASONS: Record<string, Key> = {
  translocated: 'updReasonTranslocated', 'read-only': 'updReasonReadOnly', 'no-package': 'updReasonNoPackage', unsupported: 'updReasonUnsupported', manual: 'updReasonManual',
};
const fmtMB = (n: number): string => `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;

async function install(): Promise<void> {
  if (st.phase !== 'available' || !st.info) return;
  put({ phase: 'downloading', received: 0, total: st.info.size, message: undefined });
  const timer = setInterval(() => {
    host.updateProgress().then((p) => { if (p.active) put({ received: p.received, total: p.total || st.total }); }).catch(() => undefined);
  }, 250);
  try {
    if (!st.info.ready) await host.updateDownload();
    clearInterval(timer);
    put({ phase: 'installing', received: st.total });
    await host.updateInstall();
    // The shell closes this window and starts the new version.
  } catch (e) {
    clearInterval(timer);
    const mismatch = e instanceof HostError && e.code === 'mismatch';
    put({ phase: 'available', message: mismatch ? t('updMismatch') : `${t('updFailed')}${e instanceof HostError && e.message ? ` · ${e.message}` : ''}`.slice(0, 200) });
  }
}

function UpdateDialog() {
  const s = useUpd();
  const wnRel = useWn().releases;
  useEffect(() => {
    // The release text of a new version, when the release site has it (the signed notes otherwise).
    if (s.open && s.info?.available && !wn.releases.length && !wn.loading) void loadNotes();
  }, [s.open, s.info?.available]);
  const [, force] = useState(0);
  useEffect(() => {
    if (!s.open) return;
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && s.phase !== 'downloading' && s.phase !== 'installing') put({ open: false }); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [s.open, s.phase]);
  if (!s.open) return null;
  const info = s.info;
  const busy = s.phase === 'downloading' || s.phase === 'installing';
  const close = (): void => { if (!busy) put({ open: false, phase: info?.available ? 'available' : 'idle' }); force((n) => n + 1); };
  const percent = s.total > 0 ? Math.min(100, (s.received / s.total) * 100) : 0;
  const notes = info?.notes ? info.notes[lang] || info.notes.zh || info.notes.en || '' : '';
  const full = info?.available ? wnRel.find((r) => r.version === info.latest) : undefined;
  const reason = info && !info.canInstall && info.reason ? REASONS[info.reason] : undefined;

  let body;
  if (s.phase === 'checking') body = <div className="fw-rel idle"><span className="spinner small" /><span className="muted">{t('updChecking')}</span></div>;
  else if (s.phase === 'error') body = <div className="fw-rel idle"><span className="muted">{t('updNetError')}</span><span className="grow" /><button type="button" className="btn small" onClick={() => { void checkForUpdate(false); }}>{t('retry')}</button></div>;
  else if (s.phase === 'latest') body = <><p className="upd-latest">{t('updLatestBody', { v: info?.current || host.info?.version || '' })}</p>{info?.other && <p className="muted small upd-note">{t('updOtherLine', { v: info.other.version })}</p>}</>;
  else if (info) {
    body = (
      <>
        <div className="upd-head">
          <span className="upd-ver"><small>v{info.current}</small>{Ico.right}<b>v{info.latest}</b></span>
          <span className="muted small">{[info.date, info.size > 0 ? fmtMB(info.size) : ''].filter(Boolean).join('  ·  ')}</span>
        </div>
        {full ? <div className="wn-body upd-full"><Markdown text={full.body} skip={SKIP_SECTIONS} onLink={() => { void host.releasePage(full.version); }} /></div> : notes && <div className="upd-notes">{notes}</div>}
        {reason ? <p className="dialog-warn">{t(reason)}</p> : <p className="muted small upd-note">{t('updNote')}</p>}
        {s.message && <p className="dialog-warn">{s.message}</p>}
        {info.other && <p className="muted small upd-note">{t('updOtherLine', { v: info.other.version })}</p>}
        {busy && (
          <div className="upd-progress">
            <div className="upd-bar"><i style={{ width: `${s.phase === 'installing' ? 100 : percent}%` }} /></div>
            <span className="muted small">{s.phase === 'installing' ? t('updRestarting') : `${t('updDownloading')}  ${fmtMB(s.received)} / ${fmtMB(s.total)}`}</span>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog update" role="dialog" aria-modal="true" aria-label={t('updTitle')}>
        <h3>{s.phase === 'latest' ? t('updLatestTitle') : s.phase === 'checking' || s.phase === 'error' ? t('updCheck') : t('updTitle')}</h3>
        {body}
        <div className="dialog-actions spread">
          <label className="upd-auto"><Switch checked={s.auto} onChange={setAuto} label={t('updAuto')} /><span>{t('updAuto')}</span></label>
          <span className="grow" />
          {info?.available && !busy && <button type="button" className="btn" onClick={close}>{t('updLater')}</button>}
          {!info?.available && <button type="button" className="btn" onClick={close}>{t('done')}</button>}
          {info?.available && reason && <button type="button" className="btn primary" onClick={() => { void host.updatePage(); }}>{t('updPage')}{Ico.external}</button>}
          {info?.available && !reason && <button type="button" className="btn primary" disabled={busy} onClick={() => { void install(); }}>{s.phase === 'installing' ? t('updRestarting') : s.phase === 'downloading' ? t('updDownloading') : t('updInstall')}</button>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ what's new

const SEEN_KEY = 'whats-new.json';
let seenVersion: string | undefined;
let shownThisRun = false;
async function loadSeen(): Promise<string | undefined> {
  try {
    const raw = await host.storeGet(SEEN_KEY);
    if (raw) return String(JSON.parse(new TextDecoder().decode(raw)).seen || '') || undefined;
  } catch { /* none */ }
  return undefined;
}
function saveSeen(version: string): void {
  seenVersion = version;
  void host.storeSet(SEEN_KEY, JSON.stringify({ seen: version })).catch(() => undefined);
}

interface WnState { open: boolean; from?: string; loading: boolean; error: boolean; releases: ReleaseNote[]; pick?: string }
let wn: WnState = { open: false, loading: false, error: false, releases: [] };
const wnSubs = new Set<() => void>();
function wnPut(patch: Partial<WnState>): void { wn = { ...wn, ...patch }; wnSubs.forEach((f) => f()); }
function useWn(): WnState { return useSyncExternalStore((f) => { wnSubs.add(f); return () => wnSubs.delete(f); }, () => wn); }

async function loadNotes(): Promise<void> {
  wnPut({ loading: true, error: false });
  try {
    const r = await host.updateNotes();
    wnPut({ loading: false, releases: r.releases || [] });
  } catch {
    wnPut({ loading: false, error: true });
  }
}

/** Show what changed: this version's release text, earlier ones a click away. `from`: just updated from it. */
export function openWhatsNew(from?: string): void {
  const current = host.info?.version || '';
  wnPut({ open: true, from, pick: current });
  if (!wn.releases.length && !wn.loading) void loadNotes();
}

const SKIP_SECTIONS = /^(SHA-?256|校验)/i;

function WhatsNewDialog() {
  const s = useWn();
  useEffect(() => {
    if (!s.open) return;
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') wnPut({ open: false }); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [s.open]);
  if (!s.open) return null;
  const current = host.info?.version || '';
  const close = (): void => wnPut({ open: false });
  // The releases up to this version (a newer one is shown by the update dialog).
  const list = s.releases.filter((r) => r.version === current || !Newer(r.version, current));
  const shown = list.find((r) => r.version === s.pick) || list[0];
  // Before the release list arrives (or when it cannot), the signed notes of the last check.
  const fallback = st.info?.latest === current && st.info.notes ? st.info.notes[lang] || st.info.notes.zh || st.info.notes.en || '' : '';
  let body;
  if (s.loading && !list.length) body = <div className="fw-rel idle"><span className="spinner small" /><span className="muted">{t('wnLoading')}</span></div>;
  else if (shown) body = <Markdown text={shown.body || t('wnNone')} skip={SKIP_SECTIONS} onLink={() => { void host.releasePage(shown.version); }} />;
  else if (fallback) body = <div className="upd-notes">{fallback}</div>;
  else body = <div className="fw-rel idle"><span className="muted">{t(s.error ? 'wnError' : 'wnNone')}</span><span className="grow" />{s.error && <button type="button" className="btn small" onClick={() => { void loadNotes(); }}>{t('retry')}</button>}</div>;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog whatsnew" role="dialog" aria-modal="true" aria-label={t('wnTitle')}>
        <h3>{s.from ? t('wnUpdated', { v: current }) : t('wnTitle')}{s.from && <small className="muted"> {t('wnFrom', { v: s.from })}</small>}</h3>
        {list.length > 1 && (
          <div className="wn-versions" role="tablist">
            {list.map((r) => (
              <button key={r.version} type="button" role="tab" aria-selected={r.version === shown?.version} className={r.version === shown?.version ? 'on' : ''} onClick={() => wnPut({ pick: r.version })}>
                v{r.version}{r.version === current && <span className="wn-cur">{t('wnCurrent')}</span>}
              </button>
            ))}
          </div>
        )}
        {shown?.date && <div className="muted small wn-date">{shown.date}</div>}
        <div className="wn-body">{body}</div>
        <p className="muted small wn-about">{t('aboutBody')}</p>
        <p className="muted small wn-about">{t('aboutContrib')}</p>
        <p className="muted small wn-about">{t('aboutCredits')}</p>
        <div className="dialog-actions spread">
          {shown && <button type="button" className="btn ghost" onClick={() => { void host.releasePage(shown.version); }}>{t('wnGitHub')}{Ico.external}</button>}
          <span className="grow" />
          <button type="button" className="btn primary" onClick={close}>{t('done')}</button>
        </div>
      </div>
    </div>
  );
}

/** Whether version a is newer than b (numbers separated by dots). */
function Newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
}
