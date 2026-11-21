import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DropZone, Ico, Menu } from '../components';
import { isMobile } from '../host';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import { loadFirmwareFile, outputFirmware, setPage, useStore, filmCountChoosable, lookOrderAvailable } from '../store';
import { isFirmware } from './files';
import { PreviewPane } from './preview';
import { ExtraSlotCard, ExtrasHead, FilmCountHead, SlotCard } from './slot-cards';
import { LookOrderView, reducedMotion } from './look-order';

/** The slot cards on the left, the preview on the right (the additions have a page of their own). */
function IcBody() {
  const allSlots = useStore(s => s.info!.slots);
  const choosable = useStore((s) => filmCountChoosable(s));
  const filmCount = useStore((s) => s.filmCount);
  const slots = useMemo(() => (choosable ? allSlots.slice(0, filmCount) : allSlots), [allSlots, choosable, filmCount]);
  const gr3x = useStore((s) => s.info?.family === 'gr3x');
  const extras = useStore((s) => s.extras);
  return (
    <div className="ic" data-tour-page="ic">
      {gr3x
        ? <div className="cards">{choosable && <FilmCountHead />}{slots.map((slot) => <SlotCard key={slot.id} id={slot.id} />)}</div>
        : (
        <div className="cards">
        <SlotCard id="CY" /><SlotCard id="CG" />
        <ExtrasHead />
        {extras.map((x, i) => <ExtraSlotCard key={x.key} x={x} index={i} />)}
      </div>
        )}
      <PreviewPane />
    </div>
  );
}

type IcView = 'slots' | 'order';
const IC_VIEWS: IcView[] = ['slots', 'order'];
/** The view last shown, kept while the program runs (going to another page and back keeps it). */
let lastIcView: IcView = 'slots';

/**
 * The two views of the page as tabs next to its title. The highlight glides from one to the other
 * with the same easing as the views themselves. Arrow keys, Home and End move between the tabs.
 */
function ViewTabs({ value, onChange }: { value: IcView; onChange: (v: IcView) => void }) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const pill = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const label: Record<IcView, string> = { slots: t('icViewSlots'), order: t('icViewOrder') };
  const current = useRef(value); current.current = value;
  const place = (): void => {
    const b = tabs.current[IC_VIEWS.indexOf(current.current)]; const p = pill.current;
    if (!b || !p) return;
    p.style.width = `${b.offsetWidth}px`;
    p.style.transform = `translateX(${b.offsetLeft - 2}px)`;
  };
  useLayoutEffect(place, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // placed without gliding at first, and when the labels change width (fonts, language)
    const p = pill.current;
    const frame = requestAnimationFrame(() => p?.classList.remove('still'));
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; }
      p?.classList.add('still'); place(); requestAnimationFrame(() => p?.classList.remove('still'));
    });
    if (box.current) ro.observe(box.current);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (e: React.KeyboardEvent, i: number): void => {
    const n = IC_VIEWS.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(IC_VIEWS[to]);
    tabs.current[to]?.focus();
  };
  return (
    <div className="seg ic-tabs" role="tablist" aria-label={t('icViews')} data-tour="ic-views" ref={box}>
      <span className="ic-tabs-pill still" ref={pill} aria-hidden />
      {IC_VIEWS.map((v, i) => (
        <button
          key={v} type="button" role="tab" id={`ic-tab-${v}`} aria-controls={`ic-view-${v}`} aria-selected={v === value} tabIndex={v === value ? 0 : -1}
          ref={(el) => { tabs.current[i] = el; }} className={v === value ? 'on' : ''} onClick={() => onChange(v)} onKeyDown={(e) => key(e, i)}
        >{label[v]}</button>
      ))}
    </div>
  );
}

/**
 * The slots and the menu order side by side on one track, which slides to the chosen one like a
 * page being turned. Both stay mounted, so each keeps its own scroll position; the one out of
 * sight is inert (no focus, no pointer, hidden from assistive technology).
 */
function IcViews({ view }: { view: IcView }) {
  const track = useRef<HTMLDivElement>(null);
  const panels = useRef<Record<IcView, HTMLElement | null>>({ slots: null, order: null });
  const first = useRef(true);
  useLayoutEffect(() => {
    for (const v of IC_VIEWS) panels.current[v]?.toggleAttribute('inert', v !== view);
    if (first.current) { first.current = false; return; }
    // a layer of its own only while it moves (text keeps its sharpest rendering at rest)
    if (!reducedMotion()) track.current?.classList.add('moving');
  }, [view]);
  // the clipped frame must never be scrolled sideways (e.g. by focus); the track alone moves
  const unscroll = (e: React.UIEvent<HTMLDivElement>): void => { if (e.currentTarget.scrollLeft) e.currentTarget.scrollLeft = 0; };
  return (
    <div className="ic-views" onScroll={unscroll}>
      <div className={`ic-track ${view === 'order' ? 'at-order' : ''}`} ref={track} onTransitionEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('moving'); }}>
        <section className="ic-view" id="ic-view-slots" role="tabpanel" aria-labelledby="ic-tab-slots" ref={(el) => { panels.current.slots = el; }}><IcBody /></section>
        <section className="ic-view" id="ic-view-order" role="tabpanel" aria-labelledby="ic-tab-order" ref={(el) => { panels.current.order = el; }}><LookOrderView /></section>
      </div>
    </div>
  );
}

export function ImageControlPage() {
  const info = useStore((s) => s.info);
  const fwName = useStore((s) => s.fwName);
  const model = useStore((s) => s.model);
  const [view, setViewState] = useState<IcView>(lastIcView);
  const setView = (v: IcView): void => { lastIcView = v; setViewState(v); };
  // the page's guide points at the slots: show them while it runs
  const touring = useStore((s) => s.tour?.id === 'ic');
  useEffect(() => { if (touring) setView('slots'); }, [touring]);
  const views = !!info && info.capabilities.presets && model !== 'MONO';
  // The menu order is a view of its own where the firmware has it (GR IV; GR III / IIIx).
  const orderView = useStore((s) => lookOrderAvailable(s));
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.aperture}</span>
        <h1>{t('navIC')}</h1>
        {views && orderView && <ViewTabs value={view} onChange={setView} />}
        {info && (
          <div className="head-right" data-tour="ic-stock">
            <span className="chip ok">{Ico.check}<span className="ellipsis">{fwName || info.filename} · {info.version}</span></span>
            <Menu items={isMobile ? [
              ...(info.family === 'gr4' ? [{ label: t('pushStock'), run: () => { void outputFirmware({ kind: 'camera' }, true); } }] : []),
              { label: t('saveStock'), run: () => { void outputFirmware({ kind: 'phone' }, true); } },
            ] : [
              { label: t('writeStock'), run: () => { void outputFirmware({ kind: 'card' }, true); } },
              { label: t('exportStock'), run: () => { void outputFirmware({ kind: 'folder' }, true); } },
            ]}>{Ico.more}</Menu>
          </div>
        )}
      </header>
      {!info && <FirmwareHero />}
      {views && (orderView ? <IcViews view={view} /> : <IcBody />)}
      {info && model === 'MONO' && <div className="mono-ic"><p className="muted">{t('monoNoSlots')}</p><button type="button" className="btn" onClick={() => setPage('extras')}>{Ico.extras}<span>{t('monoToExtras')}</span></button></div>}
    </DropZone>
  );
}
