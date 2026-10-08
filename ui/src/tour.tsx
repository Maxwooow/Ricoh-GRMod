// Guided tours over the real interface: one part is lit, the rest dimmed a little, and a card
// next to it says what the part is for. The first start shows the overview, and each page shows
// its own tour the first time it is opened with something on it; those cannot be skipped. The
// help button in the sidebar shows the current page's tour again, with a skip button.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import type { Key } from './i18n';
import { endTour, getState, startTour, tourStep, useStore } from './store';
import type { TourId } from './store';

type Side = 'right' | 'left' | 'top' | 'bottom';
/**
 * `target` is a `data-tour` name in the interface, or several lit as one box (none: a card in the
 * middle of the window); `side` is where the card goes if there is room.
 */
interface Step { target?: string | string[]; title: Key; body: Key; side?: Side }
const step = (target: string | string[] | undefined, name: string, side?: Side): Step => ({ target, title: `t${name}T` as Key, body: `t${name}B` as Key, side });
const names = (target: Step['target']): string[] => (target === undefined ? [] : Array.isArray(target) ? target : [target]);

/** A step whose target is not on screen is left out (no rows yet, a button the page does not have, ...). */
export const TOURS: Record<TourId, Step[]> = {
  overview: [
    step(undefined, 'OvWelcome'),
    step('card', 'OvCard', 'top'),
    step(['firmware', 'model'], 'OvFirmware'),
    step('language', 'OvLang'),
    step('nav-script', 'OvScript'),
    step('nav-ic', 'OvIc'),
    step('nav-ratio', 'OvRatio'),
    step('nav-wall', 'OvWall'),
    step('nav-copies', 'OvCopies'),
    step('export', 'OvExport', 'top'),
    step('write', 'OvWrite', 'top'),
    step('help', 'OvHelp'),
  ],
  script: [
    step('script-hint', 'ScriptHint', 'bottom'),
    step('write', 'ScriptWrite', 'top'),
  ],
  ic: [
    step('ic-stock', 'IcStock', 'bottom'),
    step('ic-slot', 'IcSlot'),
    step('ic-name', 'IcName', 'bottom'),
    step('ic-preset', 'IcPreset', 'bottom'),
    step('ic-icon', 'IcIcon', 'bottom'),
    step('ic-tabs', 'IcTabs', 'bottom'),
    step('ic-mode', 'IcMode', 'bottom'),
    step('ic-preview', 'IcPreview', 'left'),
    step('write', 'IcWrite', 'top'),
  ],
  ratio: [
    step('ratio-factory', 'RatioFactory', 'bottom'),
    step('ratio-row', 'RatioRow', 'bottom'),
    step('ratio-add', 'RatioAdd', 'bottom'),
    step('ratio-common', 'RatioCommon', 'bottom'),
    step('ratio-backdrop', 'RatioBackdrop', 'bottom'),
    step('ratio-frame', 'RatioFrame', 'left'),
    step('write', 'IcWrite', 'top'),
  ],
  wall: [
    step('wall-add', 'WallAdd'),
    step('wall-card', 'WallCard'),
    step('write', 'WallWrite', 'top'),
  ],
  copies: [
    step('copies-tabs', 'CopiesTabs', 'bottom'),
    step('copies-all', 'CopiesAll', 'bottom'),
    step('copies-list', 'CopiesList', 'bottom'),
    step('copies-actions', 'CopiesActions', 'top'),
  ],
};

function find(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`.app [data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/**
 * Start a tour if there is something to show: a page's tour needs the page's content on screen
 * (`data-tour-page`), which is not there while no firmware is open.
 */
export function beginTour(id: TourId, replay: boolean): boolean {
  if (getState().tour) return false;
  if (id !== 'overview' && !document.querySelector(`.app [data-tour-page="${id}"]`)) return false;
  const steps: number[] = [];
  TOURS[id].forEach((st, i) => { if (names(st.target).every((n) => find(n))) steps.push(i); });
  if (steps.length === 0) return false;
  if (id === 'copies') document.querySelector('.app .copies-list')?.scrollTo(0, 0);
  startTour(id, steps, replay);
  return true;
}
/** The help button: the current page's tour again, or the overview while the page has nothing on it. */
export function replayTour(): void {
  if (!beginTour(getState().page, true)) beginTour('overview', true);
}

/** What to light for a target: its box, or with `data-tour-fit` the box around its children (a pane that is larger than what it shows). */
function boxOf(el: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const own = el.getBoundingClientRect();
  if (!el.hasAttribute('data-tour-fit')) return own;
  let box: { left: number; top: number; right: number; bottom: number } | null = null;
  for (const child of el.children) {
    const c = child.getBoundingClientRect();
    if (c.width === 0 || c.height === 0) continue;
    box = box ? { left: Math.min(box.left, c.left), top: Math.min(box.top, c.top), right: Math.max(box.right, c.right), bottom: Math.max(box.bottom, c.bottom) } : { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
  }
  return box || own;
}

interface Rect { x: number; y: number; w: number; h: number }
const CARD_W = 320; const MARGIN = 12; const GAP = 14; const PAD = 6;

/** Where the card goes: beside the lit part where there is room, never off the window. */
export function placeCard(r: Rect | null, cw: number, ch: number, vw: number, vh: number, prefer?: Side): { x: number; y: number } {
  if (!r) return { x: Math.round((vw - cw) / 2), y: Math.round((vh - ch) / 2) };
  const room: Record<Side, number> = { right: vw - (r.x + r.w) - GAP - MARGIN, left: r.x - GAP - MARGIN, bottom: vh - (r.y + r.h) - GAP - MARGIN, top: r.y - GAP - MARGIN };
  const fits = (s: Side): boolean => (s === 'right' || s === 'left' ? room[s] >= cw : room[s] >= ch);
  const order: Side[] = [...(prefer ? [prefer] : []), 'right', 'bottom', 'top', 'left'];
  const side = order.find(fits);
  let x: number; let y: number;
  if (!side) { x = r.x + r.w - cw - 16; y = r.y + r.h - ch - 16; } // no room beside it: inside, at its lower right
  else if (side === 'right' || side === 'left') {
    x = side === 'right' ? r.x + r.w + GAP : r.x - GAP - cw;
    y = r.h > ch ? r.y : r.y + r.h / 2 - ch / 2;
  } else {
    y = side === 'bottom' ? r.y + r.h + GAP : r.y - GAP - ch;
    x = r.w > cw ? r.x : r.x + r.w / 2 - cw / 2;
  }
  return { x: Math.round(Math.max(MARGIN, Math.min(vw - cw - MARGIN, x))), y: Math.round(Math.max(MARGIN, Math.min(vh - ch - MARGIN, y))) };
}

/** Starts the tours that are due, and shows the one that runs. */
export function Tour() {
  const tour = useStore((s) => s.tour);
  const wait = useStore((s) => !s.ready || !!s.busy || s.fwBusy || !!s.confirm || !!s.cropId || s.onlineOpen);
  const page = useStore((s) => s.page);
  const seen = useStore((s) => s.toursSeen);
  const hasFirmware = useStore((s) => !!s.info);
  const model = useStore((s) => s.model);
  useEffect(() => {
    if (tour || wait) return;
    const id: TourId | null = !seen.includes('overview') ? 'overview' : !seen.includes(page) ? page : null;
    if (!id) return;
    // a moment for the page to lay itself out
    const timer = setTimeout(() => { beginTour(id, false); }, 450);
    return () => clearTimeout(timer);
  }, [tour, wait, page, seen, hasFirmware, model]);
  const root = document.getElementById('root');
  return tour && root ? createPortal(<TourLayer key={tour.id} />, root) : null;
}

function TourLayer() {
  const tour = useStore((s) => s.tour);
  const [hole, setHole] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const id = tour?.id; const index = tour?.index ?? 0;
  const current = tour ? TOURS[tour.id][tour.steps[tour.index]] : undefined;

  // nothing behind the tour takes input or focus while it runs
  useEffect(() => {
    const app = document.querySelector('.app');
    app?.setAttribute('inert', '');
    const frame = requestAnimationFrame(() => setLive(true));
    return () => { cancelAnimationFrame(frame); app?.removeAttribute('inert'); };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') tourStep(1);
      else if (e.key === 'ArrowLeft') tourStep(-1);
      else if (e.key === 'Escape') { if (getState().tour?.replay) endTour(); }
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  // Follow the lit part: it is measured again while the step is shown, because the layout
  // moves with the window (and with pictures that finish loading).
  useLayoutEffect(() => {
    if (!current) return;
    const els = names(current.target).map(find).filter((e): e is HTMLElement => !!e);
    for (const e of els) e.setAttribute('data-tour-on', '');
    let last = '';
    const measure = (): void => {
      const vw = window.innerWidth; const vh = window.innerHeight;
      let r: Rect | null = null;
      if (els.length && els.every((e) => e.isConnected)) {
        const b = els.map(boxOf).reduce((a, c) => ({ left: Math.min(a.left, c.left), top: Math.min(a.top, c.top), right: Math.max(a.right, c.right), bottom: Math.max(a.bottom, c.bottom) }));
        const x = Math.max(4, b.left - PAD); const y = Math.max(4, b.top - PAD);
        r = { x, y, w: Math.min(vw - 4, b.right + PAD) - x, h: Math.min(vh - 4, b.bottom + PAD) - y };
        r = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      }
      const p = placeCard(r, card.current?.offsetWidth || CARD_W, card.current?.offsetHeight || 150, vw, vh, current.side);
      const sig = JSON.stringify([r, p]);
      if (sig !== last) { last = sig; setHole(r); setPos(p); }
    };
    measure();
    const timer = setInterval(measure, 120);
    window.addEventListener('resize', measure);
    return () => { clearInterval(timer); window.removeEventListener('resize', measure); for (const e of els) e.removeAttribute('data-tour-on'); };
  }, [id, index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter goes on: the button for that has the focus (it can only take it once the card is placed and visible)
  const placed = pos !== null;
  useEffect(() => { if (placed) next.current?.focus({ preventScroll: true }); }, [id, index, placed]);

  if (!tour || !current) return null;
  const last = tour.index === tour.steps.length - 1;
  const centre = { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
  return (
    <div className={`tour ${live ? 'live' : ''}`}>
      <div className={`tour-hole ${hole ? '' : 'none'}`} style={hole ? { left: hole.x, top: hole.y, width: hole.w, height: hole.h } : centre} />
      <div
        className="tour-card" ref={card} role="dialog" aria-modal="true" aria-label={t(current.title)}
        style={{ transform: `translate3d(${pos ? pos.x : 0}px, ${pos ? pos.y : 0}px, 0)`, visibility: pos ? 'visible' : 'hidden' }}
      >
        <div className="tour-text" key={tour.index}>
          <b>{t(current.title)}</b>
          <p>{t(current.body)}</p>
        </div>
        <div className="tour-foot">
          <span className="tour-count">{tour.index + 1} / {tour.steps.length}</span>
          <span className="grow" />
          {tour.replay && !last && <button type="button" className="btn ghost small" onClick={() => endTour()}>{t('tourSkip')}</button>}
          {tour.index > 0 && <button type="button" className="btn small" onClick={() => tourStep(-1)}>{t('tourBack')}</button>}
          <button type="button" className="btn primary small" ref={next} onClick={() => tourStep(1)}>{last ? t('tourDone') : t('tourNext')}</button>
        </div>
      </div>
    </div>
  );
}
