import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ico } from '../components';
import { t } from '../i18n';
import { uiScale } from '../fit';
import { useStore, hasLookLayout, isGr3, KEEP_VISIBLE, lookHiddenNow, lookMonoOnly, lookName, lookOrderNow, moveLook, moveLookTo, resetLookLayout, setLookHidden } from '../store';

/** The easing of everything that moves on this page: fast at first, then a long soft landing (no overshoot). */
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A row being dragged. Positions are in the list's layout pixels (the interface may be zoomed: see fit.ts). */
interface LookDrag {
  key: string; li: HTMLElement; rows: HTMLElement[];
  from: number; to: number;
  /** each row's place in the list (offsetTop / offsetHeight) when the drag began */
  tops: number[]; heights: number[];
  /** how far the others move to make room: the dragged row's height and the gap under it */
  step: number;
  /** the pointer (window pixels) where the row was taken, and where it is now */
  startY: number; y: number; pointerId: number;
  startScroll: number;
  shifts: number[];
  frame: number;
}
/** A press on a row that may become a drag: the mouse has to move a little first, a finger has to stay a moment. */
interface LookPress { key: string; li: HTMLElement; pointerId: number; type: string; x: number; y: number; timer: number }
/** Where the rows were on screen before the order changed, so that they can glide to their new places. */
interface LookFlip { tops: Map<string, number>; focus: HTMLElement | null; lifted?: string; reveal?: string }

/** Scrolls `list` so that `row` is inside it (a row moved with the keyboard stays in sight). */
function keepInView(list: HTMLElement, row: HTMLElement): void {
  const pad = 6;
  if (row.offsetTop - pad < list.scrollTop) list.scrollTop = row.offsetTop - pad;
  else if (row.offsetTop + row.offsetHeight + pad > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight + pad - list.clientHeight;
}

/**
 * The Image Control menu order and hidden looks, a view of its own. A row is taken by its grip (at
 * once), by the rest of the row with the mouse (after a few pixels) or with a finger (held for a
 * moment); it lifts, follows the pointer, and the other rows slide out of its way. On release it
 * settles into its place. The arrows move a row by one, the eye hides a look from every camera
 * list (Standard and the monochrome Standard cannot be hidden); those moves glide too (FLIP).
 */
export function LookOrderView() {
  const changed = useStore((s) => hasLookLayout(s));
  // names follow the language and the slots' own names (a primitive, so the store hook stays stable);
  // the order and the hidden keys of the open camera family (GR III keeps its own), as primitives too
  const nameList = useStore((s) => lookOrderNow(s).map((k) => `${k}\u0001${lookName(k, s)}`).join('\u0000'));
  const names = useMemo(() => new Map(nameList.split('\u0000').map((x) => x.split('\u0001') as [string, string])), [nameList]);
  const orderList = useStore((s) => lookOrderNow(s).join(','));
  const hiddenList = useStore((s) => lookHiddenNow(s).join(','));
  const monoList = useStore((s) => lookOrderNow(s).filter((k) => lookMonoOnly(k, s)).join(','));
  const gr3 = useStore((s) => (s.info ? s.info.family === 'gr3x' : isGr3(s.model)));
  const order = useMemo(() => (orderList ? orderList.split(',') : []), [orderList]);
  const hidden = useMemo(() => new Set(hiddenList ? hiddenList.split(',') : []), [hiddenList]);
  const monoOnly = useMemo(() => new Set(monoList ? monoList.split(',') : []), [monoList]);
  const nameOf = (k: string): string => names.get(k) ?? lookName(k);

  const listRef = useRef<HTMLOListElement>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const drag = useRef<LookDrag | null>(null);
  const press = useRef<LookPress | null>(null);
  const flip = useRef<LookFlip | null>(null);

  const rowsOf = (): HTMLElement[] => Array.from(listRef.current?.children ?? []) as HTMLElement[];
  /** Remember where every row is now (as seen, with any movement under way); call before the order changes. */
  const snapshot = (extra?: { lifted?: string; reveal?: string }): void => {
    const tops = new Map<string, number>();
    for (const r of rowsOf()) tops.set(r.dataset.key!, r.getBoundingClientRect().top);
    const a = document.activeElement as HTMLElement | null;
    flip.current = { tops, focus: a && listRef.current?.contains(a) ? a : null, ...extra };
  };

  // After a change of order: drop what the drag left on the rows and let every row glide from where
  // it was seen to its new place. Runs before the browser paints, so nothing jumps.
  useLayoutEffect(() => {
    const f = flip.current; const list = listRef.current;
    if (!f || !list) return;
    flip.current = null;
    const rows = rowsOf();
    for (const r of rows) { r.getAnimations().forEach((a) => a.cancel()); r.style.transform = ''; r.style.zIndex = ''; }
    // A row moved with its arrow keeps the keyboard focus (the browser drops it when the row is moved in the page).
    if (f.focus && f.focus !== document.activeElement && f.focus.isConnected) {
      const b = f.focus as HTMLButtonElement;
      const to = b.disabled ? b.closest('.look-btns')?.querySelector<HTMLButtonElement>('button:not(:disabled)') : b;
      to?.focus({ preventScroll: true });
    }
    if (f.reveal) { const r = rows.find((x) => x.dataset.key === f.reveal); if (r) keepInView(list, r); }
    if (reducedMotion()) return;
    const k = uiScale() || 1;
    for (const r of rows) {
      const was = f.tops.get(r.dataset.key!);
      if (was === undefined) continue;
      const dy = (was - r.getBoundingClientRect().top) / k;
      if (Math.abs(dy) < 0.5) continue;
      const own = r.dataset.key === f.lifted;
      if (own) r.style.zIndex = '3'; // the dropped row stays above the others until it has landed
      const a = r.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], { duration: own ? 300 : 360, easing: EASE_OUT });
      if (own) a.onfinish = a.oncancel = () => { r.style.zIndex = ''; };
    }
  });

  // One frame of a drag: scroll near the edges, put the row under the pointer, move the others aside.
  const tick = (): void => {
    const d = drag.current; const list = listRef.current;
    if (!d || !list) return;
    const k = uiScale() || 1;
    const box = list.getBoundingClientRect();
    const edge = Math.min(56 * k, box.height / 4);
    let v = 0;
    if (d.y < box.top + edge) v = -(1 - Math.max(0, d.y - box.top) / edge);
    else if (d.y > box.bottom - edge) v = 1 - Math.max(0, box.bottom - d.y) / edge;
    if (v) list.scrollTop += Math.sign(v) * Math.max(1, Math.round(Math.min(1, Math.abs(v)) ** 2 * 18));
    const last = d.rows.length - 1;
    const lo = d.tops[0] - d.tops[d.from];
    const hi = d.tops[last] + d.heights[last] - d.heights[d.from] - d.tops[d.from];
    const dy = Math.max(lo, Math.min(hi, (d.y - d.startY) / k + (list.scrollTop - d.startScroll)));
    d.li.style.transform = `translate3d(0, ${dy}px, 0)`;
    const centre = d.tops[d.from] + dy + d.heights[d.from] / 2;
    let to = d.from;
    for (let i = 0; i <= last; i++) {
      if (i === d.from) continue;
      const mid = d.tops[i] + d.heights[i] / 2;
      let s = 0;
      // (at a bound the centres meet exactly: the first and last places must still be reachable)
      if (i < d.from && centre <= mid) { s = d.step; to--; }
      else if (i > d.from && centre >= mid) { s = -d.step; to++; }
      if (s !== d.shifts[i]) { d.shifts[i] = s; d.rows[i].style.transform = s ? `translate3d(0, ${s}px, 0)` : ''; }
    }
    d.to = to;
    d.frame = requestAnimationFrame(tick);
  };

  const begin = (p: LookPress, y: number): void => {
    const list = listRef.current;
    clearTimeout(p.timer);
    press.current = null;
    if (!list || drag.current) return;
    const rows = rowsOf();
    const from = rows.indexOf(p.li);
    if (from < 0) return;
    rows.forEach((r) => r.getAnimations().forEach((a) => a.finish()));
    const tops = rows.map((r) => r.offsetTop); const heights = rows.map((r) => r.offsetHeight);
    const gap = rows.length > 1 ? tops[1] - tops[0] - heights[0] : 0;
    drag.current = {
      key: p.key, li: p.li, rows, from, to: from, tops, heights, step: heights[from] + gap,
      startY: p.y, y, pointerId: p.pointerId, startScroll: list.scrollTop, shifts: rows.map(() => 0), frame: 0,
    };
    p.li.classList.add('lifted'); // at once (React renders it too): the row must not glide after the pointer
    list.classList.add('sorting');
    document.documentElement.classList.add('look-grabbing');
    setLifted(p.key);
    drag.current.frame = requestAnimationFrame(tick);
  };

  const drop = (cancel: boolean): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    // where the rows are seen now (some may still be sliding aside), before their transitions are switched off
    snapshot({ lifted: d.key });
    listRef.current?.classList.remove('sorting');
    d.li.classList.remove('lifted');
    document.documentElement.classList.remove('look-grabbing');
    const to = cancel ? d.from : d.to;
    setLifted(null);
    if (to !== d.from) { moveLookTo(d.key, to); setSaid(t('lookOrderMoved', { name: nameOf(d.key), n: to + 1 })); }
  };
  const dropRef = useRef(drop); dropRef.current = drop;
  const beginRef = useRef(begin); beginRef.current = begin;

  useEffect(() => {
    const unpress = (): void => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } };
    const move = (e: PointerEvent): void => {
      const p = press.current;
      if (p && e.pointerId === p.pointerId) {
        const far = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (p.type === 'touch') { if (far > 8) unpress(); } // the finger scrolls the list instead
        else if (far > 4) beginRef.current(p, e.clientY);
        return;
      }
      const d = drag.current;
      if (d && e.pointerId === d.pointerId) { d.y = e.clientY; e.preventDefault(); }
    };
    const up = (e: PointerEvent): void => {
      if (press.current?.pointerId === e.pointerId) unpress();
      if (drag.current?.pointerId === e.pointerId) dropRef.current(e.type === 'pointercancel');
    };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && drag.current) { e.preventDefault(); e.stopPropagation(); dropRef.current(true); } };
    const blur = (): void => { unpress(); dropRef.current(true); };
    // while a finger drags, the page must not scroll (or the browser takes the gesture over)
    const touch = (e: TouchEvent): void => { if (drag.current) e.preventDefault(); };
    const menu = (e: Event): void => { if (drag.current || press.current?.type === 'touch') e.preventDefault(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    window.addEventListener('touchmove', touch, { passive: false });
    window.addEventListener('contextmenu', menu);
    return () => {
      unpress();
      const d = drag.current;
      if (d) { cancelAnimationFrame(d.frame); drag.current = null; document.documentElement.classList.remove('look-grabbing'); }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('touchmove', touch);
      window.removeEventListener('contextmenu', menu);
    };
  }, []);

  const onDown = (e: React.PointerEvent<HTMLLIElement>, key: string): void => {
    if (drag.current || press.current || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const p: LookPress = { key, li: e.currentTarget, pointerId: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, timer: 0 };
    if ((e.target as HTMLElement).closest('.look-grip')) { e.preventDefault(); begin(p, e.clientY); return; }
    press.current = p;
    if (p.type === 'touch') p.timer = window.setTimeout(() => { if (press.current === p) beginRef.current(p, p.y); }, 320);
  };
  const step = (k: string, i: number, delta: -1 | 1): void => {
    snapshot({ reveal: k });
    moveLook(k, delta);
    setSaid(t('lookOrderMoved', { name: nameOf(k), n: i + delta + 1 }));
  };

  return (
    <div className="looks">
      <div className="card look-card" data-tour="ic-order">
        <ol className="look-list" ref={listRef} aria-label={t('lookOrderTitle')}>
          {order.map((k, i) => {
            const isHidden = hidden.has(k);
            const mono = monoOnly.has(k);
            const keep = KEEP_VISIBLE.includes(k);
            return (
              <li key={k} data-key={k} className={`look-slot ${lifted === k ? 'lifted' : ''}`} onPointerDown={(e) => onDown(e, k)}>
                <div className={`look-row ${isHidden ? 'hidden' : ''} ${lifted === k ? 'lifted' : ''}`}>
                  <span className="look-grip" title={t('lookOrderDrag')} aria-hidden>{Ico.grip}</span>
                  <span className="look-name">{nameOf(k)}{mono ? <em className="look-mono">{t('lookOrderMono')}</em> : null}</span>
                  {isHidden && <span className="look-tag">{t('lookOrderHiddenTag')}</span>}
                  <span className="look-btns">
                    <button className="btn ghost icon-only" title={t('lookOrderUp')} aria-label={`${t('lookOrderUp')} · ${nameOf(k)}`} disabled={i === 0} onClick={() => step(k, i, -1)}>{Ico.up}</button>
                    <button className="btn ghost icon-only" title={t('lookOrderDown')} aria-label={`${t('lookOrderDown')} · ${nameOf(k)}`} disabled={i === order.length - 1} onClick={() => step(k, i, 1)}>{Ico.down}</button>
                    <button
                      className={`btn ghost icon-only look-eye ${isHidden ? 'on' : ''}`} title={keep ? t(gr3 ? 'lookOrderKeepStandardGr3' : 'lookOrderKeepStandard') : isHidden ? t('lookOrderShow') : t('lookOrderHide')}
                      aria-label={`${isHidden ? t('lookOrderShow') : t('lookOrderHide')} · ${nameOf(k)}`} aria-pressed={isHidden} disabled={keep} onClick={() => setLookHidden(k, !isHidden)}
                    >{isHidden ? Ico.eyeOff : Ico.eye}</button>
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <aside className="card look-info">
        <div className="look-info-head">
          <span className="page-icon soft-ico">{Ico.updown}</span>
          <div className="soft-text">
            <b>{t('lookOrderTitle')}</b>
          </div>
        </div>
        <div className="chips look-stats">
          <span className="chip">{t('lookOrderShown', { n: order.length - hidden.size })}</span>
          <span className={`chip ${hidden.size ? 'warn' : 'muted'}`}>{t('lookOrderCount', { n: hidden.size })}</span>
        </div>
        {gr3 && <p className="muted small look-order-hint">{t('lookOrderGr3Note')}</p>}
        <button className="btn small look-order-reset" disabled={!changed} onClick={() => { snapshot(); resetLookLayout(); }}>{Ico.refresh}<span>{t('lookOrderReset')}</span></button>
      </aside>
      <span className="sr-only" aria-live="polite">{said}</span>
    </div>
  );
}
