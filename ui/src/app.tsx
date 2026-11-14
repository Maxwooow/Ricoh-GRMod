import type { CameraModel } from '@grmod/core';
import { Component, useLayoutEffect, useRef, useState } from 'react';
import type { ErrorInfo } from 'react';
import { GlassDefs, GlassFilter, useGlass, useSize } from './glass';
import { Busy, ConfirmDialog, Hint, Ico, MobileSheet, Select, Toasts, useDismiss } from './components';
import { host, isMobile } from './host';
import { PushDialog } from './camera';
import { AndroidUpdate, checkUpdates, isAndroid } from './update-dialog';
import { haptic, setBackFallback } from './host-android';
import { t, uiLangPref } from './i18n';
import type { Key } from './i18n';
import { CopiesPage } from './copies';
import { BridgeBanner, FirmwareOnline, FirmwareRow, MODELS, modelLabel } from './firmware';
import { CropEditor, ImageControlPage, RatioPage, WallpaperPage } from './pages';
import { Tour, replayTour, restartTours } from './tour';
import { UpdatePill, UpdateWatcher, checkForUpdate, openWhatsNew } from './updates';
import {
  askForOfficial, bridgeLoaded, getState, isGr3, backupCopies, extrasOn, copyList, deleteCopies, hasNameErrors, hasRatioErrors, ratioSpecs, revealBackups, writableCopy, writeCopy, menuPictures, outputFirmware, pendingChanges, refreshVolumes, selectVolume, setAppLanguage, setModel, setPage, setShowAll, useStore, wallReady,
} from './store';
import type { State } from './store';

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function Sidebar() {
  const page = useStore((s) => s.page);
  const model = useStore((s) => s.model);
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
        <AppLanguage />
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

/** The app language; the camera language (the names Image Control changes) follows it (store.ts cameraLang). */
function AppLanguage() {
  const ui = uiLangPref();
  return (
    <Select<string>
      variant="row" tour="language" label={t('uiLanguage')} lead={<span className="side-label">{t('uiLanguage')}</span>} value={ui || 'auto'}
      onChange={(v) => { void setAppLanguage(v === 'zh' || v === 'en' ? v : ''); }}
      options={[{ value: 'auto', label: t('followSystem') }, { value: 'zh', label: '简体中文' }, { value: 'en', label: 'English' }]}
    />
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
  if (isMobile) return <Crashed><MobileApp /></Crashed>;
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

function MobileTop({ onSettings, wide }: { onSettings: () => void; wide: boolean }) {
  const page = useStore((s) => s.page);
  const info = useStore((s) => s.info);
  return (
    <header className="m-top">
      <h1 className="m-title">{t(PAGE_TITLE[page] ?? 'navIC')}</h1>
      <span className="grow" />
      {!wide && <>
      <button type="button" className="m-fw" data-tour="m-fw" onClick={onSettings} aria-label={t('mSettings')}>
        <span className={info ? '' : 'muted'}>{info ? (info.bridge ? t('fwBridgeValue') : <><span className="m-fw-file">{info.filename} · </span>{info.version}</>) : t('noFirmware')}</span>
        <i className={`dot ${info ? (info.bridge ? 'warn' : 'ok') : ''}`} />
      </button>
      <button type="button" className="btn ghost icon-only m-icon" data-tour="m-settings" onClick={onSettings} aria-label={t('mSettings')}>{Ico.sliders}</button>
      </>}
    </header>
  );
}

/**
 * The settings: the firmware, the model, the app language, the guides and the version (no release notes on the phone). In the settings sheet on a phone,
 * in the sidebar on a wide screen (`close` is then absent).
 */
function SettingsBody({ close }: { close?: () => void }) {
  const model = useStore((s) => s.model);
  // from the sheet: it slides away first, then the guide starts
  const then = (f: () => void, wait: number): void => { if (close) { close(); window.setTimeout(f, wait); } else f(); };
  return (
    <>
      <div className="side-props m-props">
        <FirmwareRow />
        <Select<CameraModel>
          variant="row" tour="model" label={t('model')} lead={<span className="side-label">{t('model')}</span>} value={model} onChange={setModel}
          options={MODELS.map((m) => ({ value: m, label: modelLabel(m) }))}
        />
        <AppLanguage />
      </div>
      <div className="side-props m-props m-help" data-tour="m-help">
        <button type="button" className="m-row" onClick={() => then(replayTour, 480)}>{Ico.help}<span>{t('tourReplay')}</span></button>
        <button type="button" className="m-row" onClick={() => then(restartTours, 480)}>{Ico.refresh}<span>{t('tourRestart')}</span></button>
        {isAndroid && <button type="button" className="m-row" onClick={() => then(() => { void checkUpdates(true); }, 300)}>{Ico.download}<span>{t('updCheck')}</span></button>}
      </div>
      <div className="m-sheet-foot">
        <span className="about-link m-version">GR Mod v{host.info?.version || ''}</span>
        <span className="grow" />
        {close && <button type="button" className="btn" onClick={close}>{t('pushClose')}</button>}
      </div>
    </>
  );
}

function MobileSettings({ onClose }: { onClose: () => void }) {
  return (
    <MobileSheet label={t('mSettings')} onClose={onClose} side="right">
      {(close) => <SettingsBody close={close} />}
    </MobileSheet>
  );
}

/** Wide screens (an iPad, a tablet): the pages and the settings in a sidebar, as on the desktop. */
const WIDE = '(min-width: 740px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useLayoutEffect(() => {
    const q = window.matchMedia(WIDE);
    const f = (): void => setWide(q.matches);
    f();
    q.addEventListener('change', f);
    return () => q.removeEventListener('change', f);
  }, []);
  return wide;
}

/** The page tabs that this model and firmware have. */
function usePageTabs(): { p: TabPage; icon: React.ReactNode; key: Key }[] {
  const model = useStore((s) => s.model);
  const menuPics = useStore((s) => !!s.info?.capabilities.menuPictures);
  const info = useStore((s) => !!s.info);
  return [
    { p: 'ic', icon: Ico.aperture, key: 'navIC' },
    { p: 'ratio', icon: Ico.ratio, key: 'navRatio' },
    ...((!isGr3(model) || menuPics || !info) ? [{ p: 'wall' as TabPage, icon: Ico.image, key: 'navWall' as Key }] : []),
  ];
}

function MobileSide() {
  const page = useStore((s) => s.page);
  const tabs = usePageTabs();
  return (
    <aside className="m-side">
      <div className="m-side-title">GR Mod</div>
      <nav className="m-side-nav">
        {tabs.map((x) => (
          <button
            key={x.p} type="button" className={`m-nav ${x.p === page || (x.p === 'ic' && page === 'copies') ? 'on' : ''}`} data-tour={`nav-${x.p}`}
            aria-current={x.p === page ? 'page' : undefined} onClick={() => { if (x.p !== page) { haptic(); setPage(x.p); } }}
          >{x.icon}<span>{t(x.key)}</span></button>
        ))}
      </nav>
      <span className="grow" />
      <div className="m-side-settings" data-tour="m-settings"><SettingsBody /></div>
    </aside>
  );
}

/**
 * Press feedback that is seen even on a quick tap: the button swells and lights up while held, for at least a
 * moment, and springs back (the action itself is not delayed).
 */
function usePressed(): { pressed: boolean; bind: React.HTMLAttributes<HTMLButtonElement> } {
  const [pressed, setPressed] = useState(false);
  const since = useRef(0);
  const timer = useRef(0);
  const release = (): void => {
    const left = 180 - (performance.now() - since.current);
    window.clearTimeout(timer.current);
    if (left > 0) timer.current = window.setTimeout(() => setPressed(false), left); else setPressed(false);
  };
  return {
    pressed,
    bind: {
      onPointerDown: () => { window.clearTimeout(timer.current); since.current = performance.now(); setPressed(true); },
      onPointerUp: release, onPointerCancel: release, onPointerLeave: release,
    },
  };
}

function MobileActions() {
  const s = useStore((x) => x);
  const can = canOutput(s);
  const bridge = bridgeLoaded(s) && !s.busy;
  const gr4 = s.info?.family === 'gr4';
  const glass = useGlass('lg-save', { rim: 14, strength: 9, radius: 24 });
  const glass2 = useGlass('lg-send', { rim: 14, strength: 9, radius: 24 });
  const p1 = usePressed();
  const p2 = usePressed();
  const run = (kind: 'camera' | 'phone'): void => { haptic(); if (bridge) { askForOfficial(); return; } void outputFirmware({ kind }); };
  return (
    <div className="m-actions">
      <GlassDefs>{glass.filter}{glass2.filter}</GlassDefs>
      <button ref={glass.ref} data-tour="export" className={`btn glass ${p1.pressed ? 'pressed' : ''}`} disabled={!can && !bridge} {...p1.bind} onClick={() => run('phone')}>{Ico.save}<span>{t('saveToPhone')}</span></button>
      <button ref={glass2.ref} data-tour="write" className={`btn glass tint ${p2.pressed ? 'pressed' : ''}`} disabled={(!can && !bridge) || (!!s.info && !gr4)} title={s.info && !gr4 ? t('pushOnlyGr4') : undefined} {...p2.bind} onClick={() => run('camera')}>{Ico.send}<span>{t('pushCamera')}</span></button>
    </div>
  );
}

type TabPage = 'ic' | 'ratio' | 'wall';

/**
 * The page tabs: a floating bar of glass with a lens over the current tab (after Kyant0/AndroidLiquidGlass).
 * - The bar and the lens bend what is behind them at their rims (glass.tsx).
 * - Under the lens a second copy of the tabs, all in the selected colour, is shown inside the lens's outline,
 *   and the lens magnifies and bends that: where it passes over a tab, the tab turns blue and swells.
 * - Pressing swells the lens and strengthens its rim, light and inner shade; it can be dragged along the bar and
 *   lands on the nearest tab; a tap sends it to the tab tapped. It moves on a spring and stretches with its speed.
 */
function MobileTabs() {
  const page = useStore((s) => s.page);
  const tabs = usePageTabs();
  const current = Math.max(0, tabs.findIndex((x) => x.p === page || (x.p === 'ic' && page === 'copies')));
  const bar = useRef<HTMLElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  const hotLayer = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(bar);
  const pad = 4;
  const cell = tabs.length ? (w - pad * 2) / tabs.length : 0;
  const lensW = cell;
  const lensH = Math.max(0, h - pad * 2);
  const centreOf = (i: number): number => pad + cell * (i + 0.5);
  const clampC = (c: number): number => Math.max(pad + lensW / 2, Math.min(w - pad - lensW / 2, c));
  const nearest = (c: number): number => Math.max(0, Math.min(tabs.length - 1, Math.floor((c - pad) / (cell || 1))));
  const [held, setHeld] = useState(false);
  const press = useRef<{ id: number; x0: number; c0: number; moved: boolean; over: number } | null>(null);

  // the lens's motion: springs for its place and for how far it is pressed; drawn straight into the elements
  const m = useRef({ x: -1, v: 0, to: 0, p: 0, pv: 0, pTo: 0, stiff: 380, raf: 0, t: 0 });
  const draw = (): void => {
    const s = m.current;
    const el = lens.current;
    const hot = hotLayer.current;
    if (!el || !hot || !lensW) return;
    const stretch = Math.min(0.32, Math.abs(s.v) / 2600);
    const sx = (1 + 0.24 * s.p) * (1 + stretch);
    const sy = (1 + 0.32 * s.p) * (1 - stretch * 0.4);
    el.style.translate = `${s.x - lensW / 2}px ${pad}px`;
    el.style.scale = `${sx} ${sy}`;
    const half = (lensW * sx) / 2;
    const vy = Math.max(0, pad - (lensH * (sy - 1)) / 2);
    hot.style.clipPath = `inset(${vy}px ${Math.max(0, w - (s.x + half))}px ${vy}px ${Math.max(0, s.x - half)}px round ${(lensH * sy) / 2}px)`;
  };
  const tick = (now: number): void => {
    const s = m.current;
    const dt = Math.min(0.032, Math.max(0.001, (now - (s.t || now)) / 1000 || 0.016));
    s.t = now;
    // underdamped springs: a little overshoot, then still
    const k = s.stiff;
    const c = 2 * Math.sqrt(k) * 0.62;
    s.v += (k * (s.to - s.x) - c * s.v) * dt;
    s.x += s.v * dt;
    const kp = 520;
    s.pv += (kp * (s.pTo - s.p) - 2 * Math.sqrt(kp) * 0.55 * s.pv) * dt;
    s.p += s.pv * dt;
    draw();
    const still = Math.abs(s.to - s.x) < 0.3 && Math.abs(s.v) < 4 && Math.abs(s.pTo - s.p) < 0.004 && Math.abs(s.pv) < 0.02;
    if (still) { s.x = s.to; s.v = 0; s.p = s.pTo; s.pv = 0; s.raf = 0; s.t = 0; draw(); return; }
    s.raf = requestAnimationFrame(tick);
  };
  const go = (to: number, opts: { press?: number; stiff?: number } = {}): void => {
    const s = m.current;
    s.to = to;
    if (opts.press !== undefined) s.pTo = opts.press;
    s.stiff = opts.stiff ?? 380;
    if (!s.raf) { s.t = 0; s.raf = requestAnimationFrame(tick); }
  };
  // follow the page (and the bar's size); the first time, no animation
  useLayoutEffect(() => {
    if (!cell) return;
    const s = m.current;
    if (s.x < 0) { s.x = s.to = centreOf(current); draw(); return; }
    if (!press.current) go(centreOf(current));
  }, [current, cell, w]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => cancelAnimationFrame(m.current.raf), []);

  const down = (e: React.PointerEvent<HTMLElement>): void => {
    if (press.current || !cell) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // pressed on another tab: the lens, swelling, glides there at once; on its own tab it swells where it is
    const at = nearest(e.clientX - bar.current!.getBoundingClientRect().left);
    const c0 = centreOf(at);
    if (at !== current) haptic();
    press.current = { id: e.pointerId, x0: e.clientX, c0, moved: false, over: at };
    setHeld(true);
    go(c0, { press: 1 });
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
    go(c, { press: 1, stiff: 900 });
  };
  const up = (e: React.PointerEvent<HTMLElement>): void => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    const target = e.type === 'pointercancel' ? current : p.over;
    setHeld(false);
    go(centreOf(target), { press: 0 });
    if (target !== current) setPage(tabs[target].p);
  };

  const row = (hot: boolean): React.ReactNode => tabs.map((x, i) => (
    <button
      key={x.p} type="button" tabIndex={hot ? -1 : 0} aria-hidden={hot || undefined} className={`m-tab ${hot ? 'on' : ''}`} data-tour={hot ? undefined : `nav-${x.p}`}
      aria-current={!hot && i === current ? 'page' : undefined} onClick={hot ? undefined : (e) => { if (e.detail === 0) setPage(x.p); }}
    >{x.icon}<span>{t(x.key)}</span></button>
  ));
  return (
    <div className="m-dock">
      <GlassDefs>
        <GlassFilter id="lg-bar" w={w} h={h} r={h / 2} rim={18} strength={10} />
        <GlassFilter id="lg-lens" w={lensW} h={lensH} r={lensH / 2} rim={16} strength={12} zoom={0.16} />
        <GlassFilter id="lg-lens-held" w={lensW} h={lensH} r={lensH / 2} rim={20} strength={22} zoom={0.24} />
      </GlassDefs>
      <nav className="m-tabs glass" ref={bar} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()}>
        {row(false)}
        <div className="m-tabs-hot" ref={hotLayer} aria-hidden>{row(true)}</div>
      </nav>
      {cell > 0 && <span className={`m-lens ${held ? 'held' : ''}`} ref={lens} aria-hidden style={{ width: lensW, height: lensH }} />}
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
  const wide = useWide();
  useLayoutEffect(() => { if (wide) setSettings(false); }, [wide]);
  // while the keyboard is up (a field being typed in) the floating buttons and tabs step aside
  const [typing, setTyping] = useState(false);
  useLayoutEffect(() => {
    const field = (el: EventTarget | null): boolean => el instanceof HTMLElement && el.matches('input:not([readonly]):not([type=file]):not([type=checkbox]), textarea');
    const on = (e: FocusEvent): void => { if (field(e.target)) setTyping(true); };
    const off = (): void => { window.setTimeout(() => setTyping(field(document.activeElement)), 50); };
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => { document.removeEventListener('focusin', on); document.removeEventListener('focusout', off); };
  }, []);
  // back on another page goes to the first; on the first, the app goes to the background
  useLayoutEffect(() => { setBackFallback(() => { if (getState().page === 'ic') return false; setPage('ic'); return true; }); }, []);
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
  const body = (
    <>
      <MobileTop wide={wide} onSettings={() => setSettings(true)} />
      <main className="main">
        <BridgeBanner />
        <div className="stage" ref={stage} onScroll={(e) => { scrolls.current[shown.current] = e.currentTarget.scrollTop; }}>{ready ? (page === 'ratio' ? <RatioPage /> : page === 'wall' && (!gr3 || menuPicsReady || !fwOpen) ? <WallpaperPage /> : <ImageControlPage />) : <div className="page"><span className="spinner" /></div>}</div>
      </main>
      {/* both float over the page, which scrolls on under them */}
      <MobileActions />
      {!wide && <MobileTabs />}
    </>
  );
  return (
    <div className={`app mobile ${wide ? 'wide' : ''} ${typing ? 'typing' : ''}`}>
      {wide ? <><MobileSide /><div className="m-body">{body}</div></> : body}
      {settings && !wide && <MobileSettings onClose={() => setSettings(false)} />}
      <CropEditor />
      <FirmwareOnline />
      <PushDialog />
      <AndroidUpdate />
      <ConfirmDialog />
      <Tour />
      <Busy />
      <Toasts />
    </div>
  );
}

/** Android: if the interface fails, say so (with what failed) and offer to start it again, instead of an empty page. */
class Crashed extends Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('GR Mod UI failed', error, info.componentStack); }
  render(): React.ReactNode {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="m-crash">
        <b>{t('mCrashed')}</b>
        <pre>{`${e.name}: ${e.message}\n${(e.stack || '').split('\n').slice(0, 8).join('\n')}`}</pre>
        <button type="button" className="btn primary" onClick={() => location.reload()}>{t('mReload')}</button>
      </div>
    );
  }
}
