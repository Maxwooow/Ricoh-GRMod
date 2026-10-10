// Where the firmware comes from: a file the user picks, or the current official update fetched
// from Ricoh's site. The program itself carries no firmware.
import { useEffect, useRef, useState } from 'react';
import { FIRMWARE_VERSION } from '@grmod/core';
import type { CameraModel } from '@grmod/core';
import { FileButton, Ico, Segmented, useDismiss } from './components';
import { host, HostError } from './host';
import type { FirmwareRelease } from './host';
import { t } from './i18n';
import type { Key } from './i18n';
import { adoptFirmware, askForOfficial, fmtSize, loadFirmwareFile, outputBridge, setBridgeOpen, setModel, setOnlineOpen, toast, useStore } from './store';

export const MODELS: readonly CameraModel[] = ['HDF', 'STANDARD', 'MONO'];
export const modelLabel = (m: CameraModel): string => t(('model' + m) as Key);

/** The sidebar's firmware row: a menu with the two ways to get a firmware file. */
export function FirmwareRow() {
  const info = useStore((s) => s.info);
  const mono = useStore((s) => s.model === 'MONO');
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const close = (): void => setOpen(false);
  useDismiss(open, wrap, close);
  return (
    <div className={`sel row ${open ? 'open' : ''}`} ref={wrap} data-tour="firmware">
      <button type="button" className="sel-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="side-label">{t('firmware')}</span>
        <span className={`sel-value ${info ? '' : 'muted'}`}>{info ? (info.bridge ? t('fwBridgeValue') : info.version) : t('noFirmware')}<i className={`dot ${info ? (info.bridge ? 'warn' : 'ok') : ''}`} /></span>
      </button>
      {open && (
        <div className="pop up" role="menu">
          <button type="button" role="menuitem" className="pop-item" disabled={mono} title={mono ? t('bridgeMono') : undefined} onClick={() => { close(); setBridgeOpen(true); }}><span className="pop-ico">{Ico.bridge}</span><span>{t('fwBridge')}</span></button>
          <div className="pop-sep" />
          <button type="button" role="menuitem" className="pop-item" onClick={() => { close(); file.current?.click(); }}><span className="pop-ico">{Ico.folder}</span><span>{t('fwPick')}</span></button>
          <button type="button" role="menuitem" className="pop-item" onClick={() => { close(); setOnlineOpen(true); }}><span className="pop-ico">{Ico.download}</span><span>{t('fwOnline')}</span></button>
        </div>
      )}
      <input ref={file} type="file" accept=".bin" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void loadFirmwareFile(f); }} />
    </div>
  );
}

/** What a page shows while no firmware is open. */
export function FirmwareHero() {
  const busy = useStore((s) => s.fwBusy);
  return (
    <>
      <FileButton className="hero-drop" accept=".bin" onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
        {busy ? <><span className="spinner" /><b>{t('opening')}</b></> : <><span className="hero-ico">{Ico.chip}</span><b>{t('dropFirmware')}</b><small>{t('dropFirmwareSub')}</small></>}
      </FileButton>
      <div className="hero-alt"><button type="button" className="btn ghost" onClick={() => setOnlineOpen(true)}>{Ico.download}<span>{t('fwOnlineLink')}</span></button></div>
    </>
  );
}

type Look = { state: 'loading' | 'none' | 'error' } | { state: 'ready'; rel: FirmwareRelease };

/** The current official firmware of the chosen model on Ricoh's site; a press downloads and opens it. */
export function FirmwareOnline() {
  const open = useStore((s) => s.onlineOpen);
  return open ? <OnlineDialog /> : null;
}

function OnlineDialog() {
  const model = useStore((s) => s.model);
  const reason = useStore((s) => s.onlineReason);
  const [look, setLook] = useState<Look>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const close = (): void => { abort.current?.abort(); setOnlineOpen(false); };

  useEffect(() => {
    let live = true;
    setLook({ state: 'loading' });
    host.firmwareLatest(model)
      .then((rel) => { if (live) setLook(rel ? { state: 'ready', rel } : { state: 'none' }); })
      .catch(() => { if (live) setLook({ state: 'error' }); });
    return () => { live = false; };
  }, [model, attempt]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); abort.current?.abort(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rel = look.state === 'ready' ? look.rel : null;
  const supported = !!rel && rel.version === FIRMWARE_VERSION;
  const start = async (): Promise<void> => {
    if (!rel || !supported || progress) return;
    const ac = new AbortController();
    abort.current = ac;
    setProgress({ received: 0, total: rel.size });
    const timer = setInterval(() => {
      host.firmwareProgress().then((p) => { if (p.active && !ac.signal.aborted) setProgress({ received: p.received, total: p.total || rel.size }); }).catch(() => undefined);
    }, 250);
    try {
      const f = await host.firmwareDownload(model, ac.signal);
      clearInterval(timer);
      if (ac.signal.aborted) return;
      setProgress({ received: rel.size || 1, total: rel.size || 1 });
      if (await adoptFirmware(f.name, f.version, f.data)) setOnlineOpen(false);
    } catch (e) {
      if (!(e instanceof HostError && e.code === 'cancelled') && !ac.signal.aborted) toast(`${t('fwNetError')}${e instanceof HostError && e.code !== 'network' && e.code !== 'offline' ? ` · ${e.code}` : ''}`, 'error');
    } finally {
      clearInterval(timer);
      if (abort.current === ac) { abort.current = null; setProgress(null); }
    }
  };
  const percent = progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !progress) close(); }}>
      <div className="dialog online" role="dialog" aria-modal="true" aria-label={t('fwOnlineTitle')}>
        <h3>{t('fwOnlineTitle')}</h3>
        {reason && <p className="dialog-warn">{t(reason === 'bridge-loaded' ? 'bridgeNeedOfficial' : 'bridgeNeedBase')}</p>}
        <div className={`online-models ${progress ? 'off' : ''}`}>
          <Segmented<CameraModel> value={model} onChange={(m) => { if (!progress) setModel(m); }} options={MODELS.map((m) => ({ value: m, label: modelLabel(m) }))} />
        </div>
        {look.state === 'loading' && <div className="fw-rel idle"><span className="spinner small" /><span className="muted">{t('fwLooking')}</span></div>}
        {look.state === 'none' && <div className="fw-rel idle"><span className="muted">{t('fwNone')}</span></div>}
        {look.state === 'error' && <div className="fw-rel idle"><span className="muted">{t('fwNetError')}</span><span className="grow" /><button type="button" className="btn small" onClick={() => setAttempt((n) => n + 1)}>{t('retry')}</button></div>}
        {rel && (
          <button type="button" className={`fw-rel ${progress ? 'busy' : ''}`} disabled={!supported || !!progress} onClick={() => { void start(); }} title={supported ? t('download') : undefined}>
            <span className="fw-ico">{Ico.chip}</span>
            <span className="fw-text">
              <b>{modelLabel(model)}<span className="fw-ver">{rel.version}</span></b>
              <small>{progress
                ? `${t('fwDownloading')}${progress.received > 0 ? `  ${fmtSize(progress.received)}${progress.total > 0 ? ` / ${fmtSize(progress.total)}` : ''}` : ''}`
                : [rel.date, rel.size > 0 ? fmtSize(rel.size) : ''].filter(Boolean).join('  ·  ')}</small>
            </span>
            {!supported ? <span className="chip warn">{t('fwUnsupported')}</span> : progress ? <span className="spinner small" /> : <span className="fw-go">{Ico.download}</span>}
            {progress && <i className="fw-bar" style={{ width: `${percent}%` }} />}
          </button>
        )}
        <div className="dialog-actions spread">
          {rel && <button type="button" className="fw-license" onClick={() => { void host.firmwarePage(model); }}>{t('fwLicense')}{Ico.external}</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={close}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

const BRIDGE_WAIT = 30;

/** The 1.12 bridge firmware: a warning that has to stay open for 30 seconds, then card or folder. */
export function BridgeDialog() {
  const open = useStore((s) => s.bridgeOpen);
  return open ? <BridgeWarning /> : null;
}

function BridgeWarning() {
  const card = useStore((s) => s.volumes.some((v) => v.id === s.volumeId));
  const busy = useStore((s) => !!s.busy);
  const [left, setLeft] = useState(BRIDGE_WAIT);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => {
      const n = Math.max(0, BRIDGE_WAIT - Math.floor((Date.now() - start) / 1000));
      setLeft(n);
      if (n === 0) clearInterval(timer);
    }, 250);
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setBridgeOpen(false); };
    window.addEventListener('keydown', key);
    return () => { clearInterval(timer); window.removeEventListener('keydown', key); };
  }, []);
  const ready = left === 0 && !busy;
  const go = (kind: 'card' | 'folder'): void => { setBridgeOpen(false); void outputBridge({ kind }); };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setBridgeOpen(false); }}>
      <div className="dialog bridge" role="alertdialog" aria-modal="true" aria-label={t('bridgeTitle')}>
        <h3>{t('bridgeTitle')}</h3>
        <p className="dialog-warn"><b>{t('bridgeAttention')}</b></p>
        <p className="bridge-body">{t('bridgeBody')}</p>
        <div className="dialog-actions spread">
          {left > 0 ? <span className="bridge-wait"><i className="bridge-ring" style={{ ['--p' as string]: `${(left / BRIDGE_WAIT) * 100}%` }} />{t('bridgeWait', { n: left })}</span> : <span />}
          <span className="grow" />
          <button type="button" className="btn" onClick={() => setBridgeOpen(false)}>{t('cancel')}</button>
          <button type="button" className="btn" disabled={!ready} onClick={() => go('folder')}>{Ico.folder}<span>{t('exportFolder')}</span></button>
          <button type="button" className="btn primary" disabled={!ready || !card} title={card ? undefined : t('noCard')} onClick={() => go('card')}>{t('writeCard')}</button>
        </div>
      </div>
    </div>
  );
}

/** Shown on the pages while the bridge firmware is open. */
export function BridgeBanner() {
  const on = useStore((s) => !!s.info?.bridge);
  if (!on) return null;
  return (
    <div className="bridge-banner" role="status">
      <span className="bridge-banner-ico">{Ico.bridge}</span>
      <span className="bridge-banner-text">{t('bridgeLoaded')}</span>
      <button type="button" className="btn small primary" onClick={askForOfficial}>{Ico.download}<span>{t('bridgeLoadedAction')}</span></button>
    </div>
  );
}
