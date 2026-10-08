import { LANGS } from '@grmod/core';
import type { CameraModel, LangCode } from '@grmod/core';
import { useRef, useState } from 'react';
import { Busy, ConfirmDialog, Hint, Ico, Select, Toasts, useDismiss } from './components';
import { host } from './host';
import { LANG_LABEL, t } from './i18n';
import type { Key } from './i18n';
import { CopiesPage } from './copies';
import { FirmwareOnline, FirmwareRow, MODELS, modelLabel } from './firmware';
import { CropEditor, ImageControlPage, RatioPage, ScriptPage, WallpaperPage } from './pages';
import { Tour, replayTour, restartTours } from './tour';
import {
  backupCopies, extrasOn, canRestoreWall, copyList, deleteCopies, hasNameErrors, hasRatioErrors, ratioSpecs, revealBackups, writableCopy, writeCopy, outputEntry, outputFirmware, outputWallpaper, pendingChanges, refreshVolumes, restoreCardWall, selectVolume, setLang, setModel, setPage, setShowAll, useStore, wallReady,
} from './store';

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function Sidebar() {
  const page = useStore((s) => s.page);
  const model = useStore((s) => s.model);
  const lang = useStore((s) => s.lang);
  const [about, setAbout] = useState(false);
  return (
    <aside className="sidebar">
      <nav>
        <button className={`nav ${page === 'script' ? 'on' : ''}`} data-tour="nav-script" onClick={() => setPage('script')}>{Ico.tool}<span>{t('navScript')}</span></button>
        <button className={`nav ${page === 'ic' ? 'on' : ''}`} data-tour="nav-ic" onClick={() => setPage('ic')}>{Ico.aperture}<span>{t('navIC')}</span></button>
        <button className={`nav ${page === 'ratio' ? 'on' : ''}`} data-tour="nav-ratio" onClick={() => setPage('ratio')}>{Ico.ratio}<span>{t('navRatio')}</span></button>
        <button className={`nav ${page === 'wall' ? 'on' : ''}`} data-tour="nav-wall" onClick={() => setPage('wall')}>{Ico.image}<span>{t('navWall')}</span></button>
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
        <button className="about-link" onClick={() => setAbout(true)}>v{host.info?.version || ''}</button>
        <span className="grow" />
        <HelpMenu />
      </div>
      {about && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setAbout(false); }}>
          <div className="dialog about" role="dialog" aria-modal="true">
            <h3>GR Mod <small>v{host.info?.version}</small></h3>
            <p>{t('aboutBody')}</p>
            <p className="muted small">{t('aboutCredits')}</p>
            <div className="dialog-actions"><button className="btn" onClick={() => setAbout(false)}>{t('done')}</button></div>
          </div>
        </div>
      )}
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
  return (
    <div className="out-actions" data-tour="copies-actions">
      {source === 'pc' && <button className="btn" title={t('copiesOpenFolder')} onClick={() => revealBackups()}>{Ico.folder}<span className="out-label">{t('copiesOpenFolder')}</span></button>}
      <button className="btn" disabled={busy || count === 0} onClick={() => { void deleteCopies(true); }}>{t('copiesDeleteAll')}</button>
      <button className="btn danger" disabled={busy || n === 0} onClick={() => { void deleteCopies(false); }}>{Ico.trash}<span>{t('copiesDelete')}{n ? ` ${n}` : ''}</span></button>
      {source === 'card' && <button className="btn" disabled={busy || n === 0} onClick={() => { void backupCopies(); }}>{t('copiesBackup')}{n ? ` ${n}` : ''}</button>}
      <button className="btn primary" disabled={busy || !writable} title={writable ? undefined : t('copiesPickOne')} onClick={() => { void writeCopy(); }}>{t('writeCard')}</button>
    </div>
  );
}

function OutputBar() {
  const s = useStore((x) => x);
  const vol = s.volumes.find((v) => v.id === s.volumeId);
  // Image Control (with its switches) and the added ratios go into one firmware file: both pages write the same thing.
  const isIC = s.page === 'ic' || s.page === 'ratio'; const isWall = s.page === 'wall';
  const can = !!s.info && !s.busy && (isIC ? (pendingChanges(s).length + ratioSpecs(s).length > 0 || extrasOn(s)) && !hasNameErrors(s) && !hasRatioErrors(s) : isWall ? wallReady(s) : true);
  const role: Key | '' = s.role === 'firmware' ? 'roleFirmware' : s.role === 'wallpaper' ? 'roleWallpaper' : s.role === 'mixed' ? 'roleMixed' : s.role === 'empty' ? 'roleEmpty' : '';
  const run = (kind: 'card' | 'folder'): void => { void (isIC ? outputFirmware({ kind }) : isWall ? outputWallpaper({ kind }) : outputEntry({ kind })); };
  return (
    <footer className="outbar">
      <div className="out-card" data-tour="card">
      <span className="out-ico">{Ico.card}</span>
      <Hint label={t('cardReqTitle')}>
        <b>{t('cardReqTitle')}</b>
        <span>{t('cardReq1')}</span><span>{t('cardReq2')}</span><span>{t('cardReq3')}</span><span>{t('cardReq4')}</span>
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
        {vol && s.entryOnCard && <span className="chip">{t('entryChip')}</span>}
        {isWall && vol && vol.fs !== 'DEV' && ((!!vol.fs && vol.fs !== 'FAT32') || vol.total > 34e9) && <span className="chip warn">{t('notFat32')}</span>}
      </div>
      <span className="grow" />
      {s.page === 'copies' && <CopyActions />}
      {s.page !== 'copies' && canRestoreWall(s) && s.cardWall && (
        <button className="btn" title={`${t('restoreWall')} · ${t('restoreWallTip', { n: s.cardWall.names.length, d: new Date(s.cardWall.savedAt).toLocaleDateString(), c: s.cardWall.label })}`} onClick={() => { void restoreCardWall(); }}>{Ico.image}<span className="out-label">{t('restoreWall')}</span></button>
      )}
      {s.page !== 'copies' && <button className="btn" data-tour="export" disabled={!can} title={t('exportFolder')} onClick={() => run('folder')}>{Ico.folder}<span className="out-label">{t('exportFolder')}</span></button>}
      {s.page !== 'copies' && <button className="btn primary" data-tour="write" disabled={!can || !vol} onClick={() => run('card')}>{t('writeCard')}</button>}
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
        </div>
      )}
    </div>
  );
}

export function App() {
  const page = useStore((s) => s.page);
  const ready = useStore((s) => s.ready);
  if (!host.available) return <div className="nohost">{t('hostMissing')}</div>;
  return (
    <div className="app" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={(e) => e.preventDefault()}>
      <Sidebar />
      <main className="main">
        <div className="stage">{ready ? (page === 'ic' ? <ImageControlPage /> : page === 'ratio' ? <RatioPage /> : page === 'wall' ? <WallpaperPage /> : page === 'copies' ? <CopiesPage /> : <ScriptPage />) : <div className="page"><span className="spinner" /></div>}</div>
        <OutputBar />
      </main>
      <CropEditor />
      <FirmwareOnline />
      <ConfirmDialog />
      <Tour />
      <Busy />
      <Toasts />
    </div>
  );
}
