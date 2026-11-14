/** The Android app's update dialog (update-android.ts): offer, download, hand to the installer. */
import { useEffect, useState } from 'react';
import { Gr, isIOS, isMobile, listen } from './host-android';
import { host } from './host';
import { t, UI_LANG } from './i18n';
import { toast } from './store';
import { autoCheckDue, findUpdate, isSkipped, markChecked, skipVersion, type AndroidManifest } from './update-android';

export const isAndroid = isMobile && !isIOS;

type State =
  | { kind: 'offer'; m: AndroidManifest }
  | { kind: 'down'; m: AndroidManifest; got: number; total: number }
  | { kind: 'perm'; m: AndroidManifest }
  | { kind: 'install'; m: AndroidManifest }
  | { kind: 'error'; m?: AndroidManifest; text: string };

let show: ((s: State | null) => void) | null = null;
let checking = false;

const fetchText = async (url: string): Promise<string> => (await Gr.updateFetch({ url })).text as string;

/** Looks for a newer version: by itself (quietly, at most every 12 hours) or from the settings (manual). */
export async function checkUpdates(manual: boolean): Promise<void> {
  if (!isAndroid || checking) return;
  if (!manual && !autoCheckDue()) return;
  checking = true;
  try {
    const m = await findUpdate(host.info?.version || '0', fetchText);
    markChecked();
    if (!m) { if (manual) toast(t('aUpdLatest', { v: host.info?.version || '' }), 'info'); return; }
    if (!manual && isSkipped(m.version)) return;
    show?.({ kind: 'offer', m });
  } catch (e) {
    if (manual) toast(t('aUpdFailed', { e: String((e as Error)?.message ?? e) }), 'error');
  } finally { checking = false; }
}

const mb = (n: number): string => (n / 1048576).toFixed(1);

export function AndroidUpdate() {
  const [s, setS] = useState<State | null>(null);
  useEffect(() => {
    if (!isAndroid) return undefined;
    show = setS;
    // by itself a few seconds after the start, and not while a guide is on the screen
    let timer = 0;
    const attempt = (): void => {
      if (document.querySelector('.tour')) { timer = window.setTimeout(attempt, 5000); return; }
      void checkUpdates(false);
    };
    timer = window.setTimeout(attempt, 4000);
    const stops = [
      listen('updateProgress', (p: { received: number; total: number }) => setS((x) => (x && x.kind === 'down' ? { ...x, got: p.received, total: p.total } : x))),
      listen('updateStatus', (r: { status: number; message: string }) => setS((x) => {
        if (!x || !('m' in x) || !x.m) return x;
        if (r.status === -1 || r.status === 0) return x; // waiting for the user's tap in the system's screen / done
        if (r.status === 3) return { kind: 'offer', m: x.m }; // cancelled in the system's screen
        return { kind: 'error', m: x.m, text: t('aUpdInstallFailed', { e: r.message || String(r.status) }) };
      })),
    ];
    return () => { window.clearTimeout(timer); show = null; for (const stop of stops) stop(); };
  }, []);
  if (!s) return null;

  const close = (): void => {
    if (s.kind === 'down') void Gr.updateCancel().catch(() => { /* none */ });
    setS(null);
  };
  const later = (): void => { if ('m' in s && s.m) skipVersion(s.m.version); close(); };
  const install = async (m: AndroidManifest): Promise<void> => {
    const { ok } = await Gr.updateCanInstall({ open: false });
    if (!ok) { setS({ kind: 'perm', m }); return; }
    setS({ kind: 'install', m });
    try { await Gr.updateInstall(); } catch (e) { setS({ kind: 'error', m, text: t('aUpdInstallFailed', { e: String((e as Error)?.message ?? e) }) }); }
  };
  const start = async (m: AndroidManifest): Promise<void> => {
    setS({ kind: 'down', m, got: 0, total: m.file.size });
    try { await Gr.updateDownload({ url: m.file.url, size: m.file.size, sha256: m.file.sha256 }); }
    catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg === 'cancelled') return;
      setS({ kind: 'error', m, text: msg === 'checksum' ? t('aUpdChecksum') : t('aUpdFailed', { e: msg }) });
      return;
    }
    await install(m);
  };

  const m = 'm' in s ? s.m : undefined;
  const notes = m?.notes ? (UI_LANG === 'zh' ? m.notes.zh || m.notes.en : m.notes.en || m.notes.zh) : '';
  const pct = s.kind === 'down' && s.total > 0 ? (s.got / s.total) * 100 : 0;
  return (
    <div className="overlay">
      <div className="dialog upd" role="dialog" aria-modal="true" aria-label={t('aUpdTitle', { v: m?.version || '' })}>
        <h3>{m ? t('aUpdTitle', { v: m.version }) : t('aUpdErrorTitle')}<span className="push-file">{t('aUpdCurrent', { v: host.info?.version || '' })}</span></h3>
        {s.kind === 'offer' && <>
          {notes && <p className="upd-notes">{notes}</p>}
          <p className="muted upd-hint">{t('aUpdHint')}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={later}>{t('aUpdLater')}</button>
            <span className="grow" />
            <button type="button" className="btn primary" onClick={() => { void start(s.m); }}>{t('aUpdNow')}</button>
          </div>
        </>}
        {s.kind === 'down' && <>
          <p className="push-stage"><span className="spinner small" /><span>{t('aUpdDownloading', { a: mb(s.got), b: mb(s.total) })}</span></p>
          <div className="push-bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="dialog-actions"><span className="grow" /><button type="button" className="btn" onClick={close}>{t('cancel')}</button></div>
        </>}
        {s.kind === 'perm' && <>
          <p>{t('aUpdPermission')}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>{t('cancel')}</button>
            <span className="grow" />
            <button type="button" className="btn" onClick={() => { void Gr.updateCanInstall({ open: true }); }}>{t('aUpdOpenSettings')}</button>
            <button type="button" className="btn primary" onClick={() => { void install(s.m); }}>{t('aUpdContinue')}</button>
          </div>
        </>}
        {s.kind === 'install' && <>
          <p className="push-stage"><span className="spinner small" /><span>{t('aUpdInstalling')}</span></p>
          <div className="dialog-actions"><span className="grow" /><button type="button" className="btn" onClick={close}>{t('pushClose')}</button></div>
        </>}
        {s.kind === 'error' && <>
          <p className="push-stage bad"><span>{s.text}</span></p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>{t('pushClose')}</button>
            <span className="grow" />
            {s.m && <button type="button" className="btn primary" onClick={() => { void start(s.m!); }}>{t('pushRetry')}</button>}
          </div>
        </>}
      </div>
    </div>
  );
}
