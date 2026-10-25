import { LANGS } from '@grmod/core';
import type { CameraModel, LangCode } from '@grmod/core';
import { useRef, useState } from 'react';
import { Busy, ConfirmDialog, Hint, Ico, Select, Toasts, useDismiss } from './components';
import { host } from './host';
import { LANG_LABEL, t } from './i18n';
import type { Key } from './i18n';
import { CopiesPage } from './copies';
import { BridgeBanner, BridgeDialog, FirmwareOnline, FirmwareRow, MODELS, modelLabel } from './firmware';
import { CropEditor, ImageControlPage, RatioPage, WallpaperPage } from './pages';
import { Tour, replayTour, restartTours } from './tour';
import { UpdatePill, UpdateWatcher, checkForUpdate, openWhatsNew } from './updates';
import {
  askForOfficial, bridgeLoaded, isGr3, backupCopies, colourWork, extrasOn, copyList, deleteCopies, hasNameErrors, hasRatioErrors, ratioSpecs, revealBackups, writableCopy, writeCopy, menuPictures, outputFirmware, pendingChanges, refreshVolumes, selectVolume, setLang, setModel, setPage, setShowAll, useStore, wallReady,
} from './store';

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function Sidebar() {
  const page = useStore((s) => s.page);
  const model = useStore((s) => s.model);
  const lang = useStore((s) => s.lang);
  const menuPics = useStore((s) => !!s.info?.capabilities.menuPictures);
  const info = useStore((s) => !!s.info);
  return (
    <aside className="sidebar">
      <nav>
        <button className={`nav ${page === 'ic' ? 'on' : ''}`} data-tour="nav-ic" onClick={() => setPage('ic')}>{Ico.aperture}<span>{t('navIC')}</span></button>
        <button className={`nav ${page === 'ratio' ? 'on' : ''}`} data-tour="nav-ratio" onClick={() => setPage('ratio')}>{Ico.ratio}<span>{t('navRatio')}</span></button>
        {(!isGr3(model) || menuPics || !info) && <button className={`nav ${page === 'wall' ? 'on' : ''}`} data-tour="nav-wall" onClick={() => setPage('wall')}>{Ico.image}<span>{t('navWall')}</span></button>}
      </nav>
      <div className="grow" />
      <button className={`nav low ${page === 'copies' ? 'on' : ''}`} data-tour="nav-copies" onClick={() => setPage('copies')}>{Ico.archive}<span>{t('navCopies')}</span></button>
      <div className="side-props">
        <FirmwareRow />
        <Select<CameraModel>
          variant="row" tour="model" label={t('model')} lead={<span className="side-label">{t('model')}</span>} value={model} onChange={setModel}
          options={MODELS.map((m) => ({ value: m, label: modelLabel(m) }))}
        />
        <Select<LangCode>
          variant="row" tour="language" label={t('language')} lead={<span className="side-label">{t('language')}</span>} value={lang} onChange={setLang}
          options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l] || l }))}
        />
      </div>
      <div className="side-foot">
        <button className="about-link" data-tour="version" title={t('wnTitle')} onClick={() => openWhatsNew()}>v{host.info?.version || ''}</button>
        <UpdatePill />
        <span className="grow" />
        <HelpMenu />
      </div>
    </aside>
  );
}

/** What the bottom bar offers on the copies page. */
function CopyActions() {
  const source = useStore((s) => s.copySource);
  const count = useStore((s) => copyList(s).length);
  const n = useStore((s) => s.copySel.length);
  const busy = useStore((s) => !!s.busy);
  const writable = useStore((s) => !!writableCopy(s) && s.volumes.some((v) => v.id === s.volumeId));
  const bridge = useStore((s) => bridgeLoaded(s));
  return (
    <div className="out-actions" data-tour="copies-actions">
      {source === 'pc' && <button className="btn" title={t('copiesOpenFolder')} onClick={() => revealBackups()}>{Ico.folder}<span className="out-label">{t('copiesOpenFolder')}</span></button>}
      <button className="btn" disabled={busy || count === 0} onClick={() => { void deleteCopies(true); }}>{t('copiesDeleteAll')}</button>
      <button className="btn danger" disabled={busy || n === 0} onClick={() => { void deleteCopies(false); }}>{Ico.trash}<span>{t('copiesDelete')}{n ? ` ${n}` : ''}</span></button>
      {source === 'card' && <button className="btn" disabled={busy || n === 0} onClick={() => { void backupCopies(); }}>{t('copiesBackup')}{n ? ` ${n}` : ''}</button>}
      <button className="btn primary" disabled={busy || (!writable && !bridge)} title={writable || bridge ? undefined : t('copiesPickOne')} onClick={() => { if (bridge) askForOfficial(); else void writeCopy(); }}>{t('writeCard')}</button>
    </div>
  );
}

function OutputBar() {
  const s = useStore((x) => x);
  const vol = s.volumes.find((v) => v.id === s.volumeId);
  // Image Control (with its switches), the added ratios and the power-off images go into one firmware file: every page writes the same thing.
  const isIC = s.page === 'ic' || s.page === 'ratio'; const isWall = s.page === 'wall';
  const can = !!s.info && s.info.models.includes(s.model) && (isIC ? s.info.capabilities.build : isWall ? (s.info.capabilities.wallpaper || s.info.capabilities.menuPictures) : s.info.capabilities.factoryEntry) && !s.busy && (isIC ? (pendingChanges(s).length + ratioSpecs(s).length > 0 || extrasOn(s) || (colourWork(s) && s.info.family !== 'gr3x' && s.extras.length > 0) || menuPictures(s).length > 0) && !hasNameErrors(s) && !hasRatioErrors(s) : isWall ? wallReady(s) && !hasNameErrors(s) && !hasRatioErrors(s) : true);
  const role: Key | '' = s.role === 'firmware' ? 'roleFirmware' : s.role === 'wallpaper' ? 'roleWallpaper' : s.role === 'mixed' ? 'roleMixed' : s.role === 'empty' ? 'roleEmpty' : '';
  // With the bridge firmware open the buttons stay live but offer the official download instead.
  const bridge = bridgeLoaded(s) && !s.busy;
  const run = (kind: 'card' | 'folder'): void => { if (bridge) { askForOfficial(); return; } void outputFirmware({ kind }); };
  return (
    <footer className="outbar">
      <div className="out-card" data-tour="card">
      <span className="out-ico">{Ico.card}</span>
      <Hint label={t('cardReqTitle')}>
        <b>{t('cardReqTitle')}</b>
        <span>{t('cardReq1')}</span>
      </Hint>
      <Select<string>
        variant="box" label={t('card')} value={vol?.id} placeholder={t('noCard')} onChange={selectVolume}
        options={s.volumes.map((v) => ({ value: v.id, label: `${v.id}${v.label && v.label !== v.id ? '  ' + v.label : ''}  ·  ${gb(v.total)}${v.fs && v.fs !== 'DEV' ? '  ·  ' + v.fs : ''}` }))}
        actions={[{ label: s.showAll ? t('showCardsOnly') : t('showAll'), run: () => setShowAll(!s.showAll) }]}
      />
      <button className="btn ghost icon-only" title={t('refresh')} aria-label={t('refresh')} onClick={() => { void refreshVolumes(); }}>{Ico.refresh}</button>
      </div>
      <div className="out-chips">
        {vol && role && <span className="chip">{t(role)}</span>}
      </div>
      <span className="grow" />
      {s.page === 'copies' && <CopyActions />}
      {s.page !== 'copies' && <button className="btn" data-tour="export" disabled={!can && !bridge} title={t('exportFolder')} onClick={() => run('folder')}>{Ico.folder}<span className="out-label">{t('exportFolder')}</span></button>}
      {s.page !== 'copies' && <button className="btn primary" data-tour="write" disabled={!bridge && (!can || !vol)} onClick={() => run('card')}>{t('writeCard')}</button>}
    </footer>
  );
}

/** The ? button: this page's guide again (skippable), or every guide from the start as on first use. */
function HelpMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="help-btn" data-tour="help" title={t('tourHelp')} aria-label={t('tourHelp')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{Ico.help}</button>
      {open && (
        <div className="menu up" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); replayTour(); }}>{t('tourReplay')}</button>
          <button role="menuitem" onClick={() => { setOpen(false); restartTours(); }}>{t('tourRestart')}</button>
          {host.available && <button role="menuitem" onClick={() => { setOpen(false); void checkForUpdate(false); }}>{t('updCheck')}</button>}
        </div>
      )}
    </div>
  );
}

export function App() {
  const page = useStore((s) => s.page);
  const gr3 = useStore((s) => isGr3(s.model));
  const menuPicsReady = useStore((s) => !!s.info?.capabilities.menuPictures);
  const fwOpen = useStore((s) => !!s.info);
  const ready = useStore((s) => s.ready);
  if (!host.available) return <div className="nohost">{t('hostMissing')}</div>;
  return (
    <div className="app" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={(e) => e.preventDefault()}>
      <Sidebar />
      <main className="main">
        <BridgeBanner />
        <div className="stage">{ready ? (page === 'ratio' ? <RatioPage /> : page === 'wall' && (!gr3 || menuPicsReady || !fwOpen) ? <WallpaperPage /> : page === 'copies' ? <CopiesPage /> : <ImageControlPage />) : <div className="page"><span className="spinner" /></div>}</div>
        <OutputBar />
      </main>
      <CropEditor />
      <FirmwareOnline />
      <BridgeDialog />
      <UpdateWatcher />
      <ConfirmDialog />
      <Tour />
      <Busy />
      <Toasts />
    </div>
  );
}
