import { LANGS } from '@grmod/core';
import type { CameraModel, LangCode } from '@grmod/core';
import { useLayoutEffect, useRef, useState } from 'react';
import { GlassDefs, GlassFilter, useGlass, useSize } from './glass';
import { Busy, ConfirmDialog, Hint, Ico, Select, Toasts, useDismiss } from './components';
import { host, isAndroid } from './host';
import { PushDialog } from './camera';
import { haptic } from './host-android';
import { LANG_LABEL, t } from './i18n';
import type { Key } from './i18n';
import { CopiesPage } from './copies';
import { BridgeBanner, FirmwareOnline, FirmwareRow, MODELS, modelLabel } from './firmware';
import { CropEditor, ImageControlPage, RatioPage, WallpaperPage } from './pages';
import { Tour, replayTour, restartTours } from './tour';
import { UpdatePill, UpdateWatcher, checkForUpdate, openWhatsNew } from './updates';
import {
  askForOfficial, bridgeLoaded, isGr3, backupCopies, extrasOn, copyList, deleteCopies, hasNameErrors, hasRatioErrors, ratioSpecs, revealBackups, writableCopy, writeCopy, menuPictures, outputFirmware, pendingChanges, refreshVolumes, selectVolume, setLang, setModel, setPage, setShowAll, useStore, wallReady,
} from './store';
import type { State } from './store';

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

/** Whether the page's output buttons can make a firmware file now. */
function canOutput(s: State): boolean {
  const isIC = s.page === 'ic' || s.page === 'ratio'; const isWall = s.page === 'wall';
  return !!s.info && s.info.models.includes(s.model) && (isIC ? s.info.capabilities.build : isWall ? (s.info.capabilities.wallpaper || s.info.capabilities.menuPictures) : s.info.capabilities.factoryEntry) && !s.busy && (isIC ? (pendingChanges(s).length + ratioSpecs(s).length > 0 || extrasOn(s) || (s.model !== 'MONO' && s.info.family !== 'gr3x' && s.extras.length > 0) || menuPictures(s).length > 0) && !hasNameErrors(s) && !hasRatioErrors(s) : isWall ? wallReady(s) && !hasNameErrors(s) && !hasRatioErrors(s) : true);
}

function OutputBar() {
  const s = useStore((x) => x);
  const vol = s.volumes.find((v) => v.id === s.volumeId);
  // Image Control (with its switches), the added ratios and the power-off images go into one firmware file: every page writes the same thing.
  const can = canOutput(s);
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
  if (isAndroid) return <MobileApp />;
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
      <UpdateWatcher />
      <ConfirmDialog />
      <Tour />
      <Busy />
      <Toasts />
    </div>
  );
}

// ------------------------------------------------------------------ Android: the same pages in a phone layout

const PAGE_TITLE: Record<string, Key> = { ic: 'navIC', ratio: 'navRatio', wall: 'navWall', copies: 'navIC' };

function MobileTop({ onSettings }: { onSettings: () => void }) {
  const page = useStore((s) => s.page);
  const info = useStore((s) => s.info);
  return (
    <header className="m-top">
      <h1 className="m-title">{t(PAGE_TITLE[page] ?? 'navIC')}</h1>
      <span className="grow" />
      <button type="button" className="m-fw" onClick={onSettings} aria-label={t('mSettings')}>
        <span className={info ? '' : 'muted'}>{info ? (info.bridge ? t('fwBridgeValue') : `${info.filename} · ${info.version}`) : t('noFirmware')}</span>
        <i className={`dot ${info ? (info.bridge ? 'warn' : 'ok') : ''}`} />
      </button>
      <button type="button" className="btn ghost icon-only m-icon" onClick={onSettings} aria-label={t('mSettings')}>{Ico.sliders}</button>
    </header>
  );
}

function MobileSettings({ onClose }: { onClose: () => void }) {
  const model = useStore((s) => s.model);
  const lang = useStore((s) => s.lang);
  // closing slides the sheet away first; it can also be pulled down by its top
  const [closing, setClosing] = useState(false);
  const [pull, setPull] = useState(0);
  const drag = useRef<{ id: number; y0: number; t0: number } | null>(null);
  const close = (): void => { if (closing) return; setClosing(true); window.setTimeout(onClose, 220); };
  const down = (e: React.PointerEvent<HTMLDivElement>): void => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, y0: e.clientY, t0: e.timeStamp }; };
  const move = (e: React.PointerEvent<HTMLDivElement>): void => { const d = drag.current; if (d && d.id === e.pointerId) setPull(Math.max(0, e.clientY - d.y0)); };
  const up = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - d.y0);
    const fast = dy / Math.max(1, e.timeStamp - d.t0) > 0.5;
    if (dy > 90 || (fast && dy > 24)) close(); else setPull(0);
  };
  return (
    <div className={`overlay m-sheet-wrap ${closing ? 'closing' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`m-sheet ${drag.current ? 'pulling' : ''}`} role="dialog" aria-modal="true" aria-label={t('mSettings')} style={pull && !closing ? { transform: `translateY(${pull}px)` } : undefined}>
        <div className="m-sheet-grip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}><i /></div>
        <div className="side-props m-props">
          <FirmwareRow />
          <Select<CameraModel>
            variant="row" label={t('model')} lead={<span className="side-label">{t('model')}</span>} value={model} onChange={setModel}
            options={MODELS.map((m) => ({ value: m, label: modelLabel(m) }))}
          />
          <Select<LangCode>
            variant="row" label={t('language')} lead={<span className="side-label">{t('language')}</span>} value={lang} onChange={setLang}
            options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l] || l }))}
          />
        </div>
        <div className="m-sheet-foot">
          <button type="button" className="about-link" onClick={() => { onClose(); openWhatsNew(); }}>GR Mod v{host.info?.version || ''} · {t('mWhatsNew')}</button>
          <span className="grow" />
          <button type="button" className="btn" onClick={close}>{t('pushClose')}</button>
        </div>
      </div>
    </div>
  );
}

function MobileActions() {
  const s = useStore((x) => x);
  const can = canOutput(s);
  const bridge = bridgeLoaded(s) && !s.busy;
  const gr4 = s.info?.family === 'gr4';
  const glass = useGlass('lg-save', { rim: 14, strength: 9, radius: 24 });
  const run = (kind: 'camera' | 'phone'): void => { if (bridge) { askForOfficial(); return; } void outputFirmware({ kind }); };
  return (
    <div className="m-actions">
      <GlassDefs>{glass.filter}</GlassDefs>
      <button ref={glass.ref} className="btn glass" disabled={!can && !bridge} onClick={() => run('phone')}>{Ico.save}<span>{t('saveToPhone')}</span></button>
      <button className="btn primary" disabled={(!can && !bridge) || (!!s.info && !gr4)} title={s.info && !gr4 ? t('pushOnlyGr4') : undefined} onClick={() => run('camera')}>{Ico.send}<span>{t('pushCamera')}</span></button>
    </div>
  );
}

type TabPage = 'ic' | 'ratio' | 'wall';

/**
 * The page tabs: a floating bar of glass with a lens over the current tab. Pressing the bar swells the lens;
 * it can be dragged along the bar and lands on the nearest tab, or a tap sends it to the tab tapped
 * (as Kyant0/AndroidLiquidGlass's bottom tabs).
 */
function MobileTabs() {
  const page = useStore((s) => s.page);
  const model = useStore((s) => s.model);
  const menuPics = useStore((s) => !!s.info?.capabilities.menuPictures);
  const info = useStore((s) => !!s.info);
  const tabs: { p: TabPage; icon: React.ReactNode; key: Key }[] = [
    { p: 'ic', icon: Ico.aperture, key: 'navIC' },
    { p: 'ratio', icon: Ico.ratio, key: 'navRatio' },
    ...((!isGr3(model) || menuPics || !info) ? [{ p: 'wall' as TabPage, icon: Ico.image, key: 'navWall' as Key }] : []),
  ];
  const current = Math.max(0, tabs.findIndex((x) => x.p === page || (x.p === 'ic' && page === 'copies')));
  const bar = useRef<HTMLElement>(null);
  const { w, h } = useSize(bar);
  const pad = 4;
  const cell = tabs.length ? (w - pad * 2) / tabs.length : 0;
  const lensW = cell;
  const lensH = Math.max(0, h - pad * 2);
  // where the lens is while a finger holds it (its centre, px from the bar's left), and whether it is held
  const [held, setHeld] = useState<{ x: number; moved: boolean } | null>(null);
  const press = useRef<{ id: number; x0: number; c0: number; moved: boolean; over: number } | null>(null);
  const centreOf = (i: number): number => pad + cell * (i + 0.5);
  const clampC = (c: number): number => Math.max(pad + lensW / 2, Math.min(w - pad - lensW / 2, c));
  const nearest = (c: number): number => Math.max(0, Math.min(tabs.length - 1, Math.floor((c - pad) / (cell || 1))));
  const centre = held ? held.x : centreOf(current);
  const hot = held ? nearest(centre) : current;

  const down = (e: React.PointerEvent<HTMLElement>): void => {
    if (press.current || !cell) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // pressed on another tab: the lens, swollen, glides there at once; on its own tab it swells where it is
    const at = nearest(e.clientX - bar.current!.getBoundingClientRect().left);
    const c0 = centreOf(at);
    if (at !== current) haptic();
    press.current = { id: e.pointerId, x0: e.clientX, c0, moved: false, over: at };
    setHeld({ x: c0, moved: false });
  };
  const move = (e: React.PointerEvent<HTMLElement>): void => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x0;
    if (!p.moved && Math.abs(dx) < 6) return;
    p.moved = true;
    const c = clampC(p.c0 + dx);
    const over = nearest(c);
    if (over !== p.over) { p.over = over; haptic(); }
    setHeld({ x: c, moved: true });
  };
  const up = (e: React.PointerEvent<HTMLElement>): void => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    const target = e.type === 'pointercancel' ? current : p.over;
    setHeld(null);
    if (target !== current) setPage(tabs[target].p);
  };

  return (
    <div className="m-dock">
      <GlassDefs>
        <GlassFilter id="lg-bar" w={w} h={h} r={h / 2} rim={18} strength={10} />
        <GlassFilter id="lg-lens" w={lensW} h={lensH} r={lensH / 2} rim={16} strength={14} zoom={0.18} />
      </GlassDefs>
      <nav className="m-tabs glass" ref={bar} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()}>
        {tabs.map((x, i) => (
          <button key={x.p} type="button" className={`m-tab ${i === hot ? 'on' : ''}`} aria-current={i === current ? 'page' : undefined} onClick={(e) => { if (e.detail === 0) setPage(x.p); }}>{x.icon}<span>{t(x.key)}</span></button>
        ))}
      </nav>
      {cell > 0 && (
        <span
          className={`m-lens ${held ? 'held' : ''} ${held?.moved ? 'dragging' : ''}`} aria-hidden
          style={{ width: lensW, height: lensH, translate: `${centre - lensW / 2}px ${pad}px` }}
        />
      )}
    </div>
  );
}

function MobileApp() {
  const page = useStore((s) => s.page);
  const gr3 = useStore((s) => isGr3(s.model));
  const menuPicsReady = useStore((s) => !!s.info?.capabilities.menuPictures);
  const fwOpen = useStore((s) => !!s.info);
  const ready = useStore((s) => s.ready);
  const [settings, setSettings] = useState(false);
  // Switching pages: each page keeps where it was scrolled to, and the new one slides in from the side of its tab.
  const stage = useRef<HTMLDivElement>(null);
  const scrolls = useRef<Record<string, number>>({});
  const shown = useRef(page);
  useLayoutEffect(() => {
    const el = stage.current;
    const from = shown.current;
    if (!el || from === page) return;
    shown.current = page;
    el.scrollTop = scrolls.current[page] ?? 0;
    const ORDER = ['ic', 'ratio', 'wall'];
    const dir = Math.sign(ORDER.indexOf(page) - ORDER.indexOf(from)) || 1;
    const view = el.firstElementChild as HTMLElement | null;
    if (view && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      view.animate([{ opacity: 0, transform: `translate3d(${dir * 28}px, 0, 0)` }, { opacity: 1, transform: 'none' }], { duration: 340, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' });
    }
  }, [page]);
  return (
    <div className="app mobile">
      <MobileTop onSettings={() => setSettings(true)} />
      <main className="main">
        <BridgeBanner />
        <div className="stage" ref={stage} onScroll={(e) => { scrolls.current[shown.current] = e.currentTarget.scrollTop; }}>{ready ? (page === 'ratio' ? <RatioPage /> : page === 'wall' && (!gr3 || menuPicsReady || !fwOpen) ? <WallpaperPage /> : <ImageControlPage />) : <div className="page"><span className="spinner" /></div>}</div>
      </main>
      {/* both float over the page, which scrolls on under them */}
      <MobileActions />
      <MobileTabs />
      {settings && <MobileSettings onClose={() => setSettings(false)} />}
      <CropEditor />
      <FirmwareOnline />
      <UpdateWatcher />
      <PushDialog />
      <ConfirmDialog />
      <Busy />
      <Toasts />
    </div>
  );
}
