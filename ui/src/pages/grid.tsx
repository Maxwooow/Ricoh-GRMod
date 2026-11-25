import { useLayoutEffect, useRef, useState } from 'react';
import { isCameraGrid } from '@grmod/core';
import { Ico, Segmented, Switch } from '../components';
import { t } from '../i18n';
import type { Key } from '../i18n';
import type { Box } from '../motion';
import { boxOf, flipFrom, leave, offsetTo, reducedMotion, rise, scrollerOf } from '../motion';
import { framingOffered, getState, gridOffered, setCustomGrid, setExtrasView, setGridLine, useStore } from '../store';
import { FramingEditor, FramingThumb } from './framing';

// ---------------------------------------------------------------- custom grid lines
type GridStyle = 'g3' | 'g4';
/** One line of a grid style, in the order core's CustomGrid keeps them; `at` is x1, y1, x2, y2 in the frame (0..1). */
interface GridLineDef { group: 'h' | 'v' | 'd'; name: Key; at: readonly [number, number, number, number] }
const gridLineDefs = (k: number): GridLineDef[] => [
  { group: 'h', name: 'gridTop', at: [0, 1 / k, 1, 1 / k] },
  { group: 'h', name: 'gridMiddle', at: [0, 1 / 2, 1, 1 / 2] },
  { group: 'h', name: 'gridBottom', at: [0, 1 - 1 / k, 1, 1 - 1 / k] },
  { group: 'v', name: 'gridLeft', at: [1 / k, 0, 1 / k, 1] },
  { group: 'v', name: 'gridCentre', at: [1 / 2, 0, 1 / 2, 1] },
  { group: 'v', name: 'gridRight', at: [1 - 1 / k, 0, 1 - 1 / k, 1] },
  { group: 'd', name: 'gridDiagDown', at: [0, 0, 1, 1] },
  { group: 'd', name: 'gridDiagUp', at: [0, 1, 1, 0] },
];
/** 3x3: thirds (the centre lines and diagonals are extra); 4x4: quarters, its centre lines and diagonals. */
const GRID_LINES: Record<GridStyle, GridLineDef[]> = { g3: gridLineDefs(3), g4: gridLineDefs(4) };
const GRID_GROUPS: { id: GridLineDef['group']; name: Key }[] = [{ id: 'h', name: 'gridHorizontal' }, { id: 'v', name: 'gridVertical' }, { id: 'd', name: 'gridDiagonals' }];
/** The camera's grid colour: UI palette 16, black at 50 %. */
const GRID_COLOUR = 'rgba(0,0,0,.5)';
const W = 720; const H = 480;

// ---------------------------------------------------------------- the way into the editor and back
/**
 * The editor opens out of its capsule and closes back into it. What is handed from one view to the next: where
 * the capsule and its small picture were (opening), or where the editor's switch and its preview were (closing).
 * The view that appears moves its own parts from there (GridDetail, GridArrival).
 *
 *   opening   the other capsules go; the capsule's picture of the style grows into the preview, the capsule's
 *             head moves up to become the editor's switch, the rest of the editor rises in
 *   closing   the editor's controls go; the preview shrinks into the capsule's picture, the capsule moves back
 *             to its place in the list (at the scroll position it was left at), the other capsules come back
 */
interface Handoff { to: 'grid' | 'list'; card: Box; picture: Box | null; style: GridStyle }
let handoff: Handoff | null = null;
/** The editor's parts that come in after the preview (and go before it on the way back). */
const EDITOR_PARTS = '.grid-same, .grid-edit > .seg, .grid-edit-lines, .grid-edit > p, .fr-tools, .fr-side, .fr-templates';
let listScroll = 0;
let moving = false;
/** The style the editor shows (kept while the program runs, so that the way back ends in the right picture). */
let shownStyle: GridStyle = 'g3';
const take = (to: Handoff['to']): Handoff | null => { const h = handoff && handoff.to === to ? handoff : null; handoff = null; return h; };

/** Open the editor out of the grid capsule. */
export function openGrid(): void {
  if (moving) return;
  const card = document.querySelector<HTMLElement>('[data-morph="grid-card"]');
  if (card) listScroll = scrollerOf(card)?.scrollTop ?? 0;
  if (!card || reducedMotion() || !gridOffered(getState())) { setExtrasView('grid'); return; }
  const picture = card.querySelector(`[data-morph="grid-${shownStyle}"]`);
  handoff = { to: 'grid', card: boxOf(card), picture: picture ? boxOf(picture) : null, style: shownStyle };
  moving = true;
  void leave(Array.from(card.parentElement?.children ?? []).filter((c) => c !== card)).then(() => { moving = false; setExtrasView('grid'); });
}

/** Close the editor back into the grid capsule. */
export function closeGrid(): void {
  if (moving) return;
  const page = document.querySelector<HTMLElement>('.grid-page');
  const card = page?.querySelector<HTMLElement>('.grid-switch');
  const picture = page?.querySelector('.grid-edit-preview');
  if (!page || !card || reducedMotion()) { setExtrasView('list'); return; }
  handoff = { to: 'list', card: boxOf(card), picture: picture ? boxOf(picture) : null, style: shownStyle };
  moving = true;
  const rest = Array.from(page.querySelectorAll(EDITOR_PARTS));
  void leave(rest, 110, 1).then(() => { moving = false; setExtrasView('list'); });
}

/**
 * In the additions' list: puts the list back where it was scrolled to when the editor was opened and, coming
 * from the editor, lets the grid capsule and its picture arrive from where the editor's were.
 */
export function useGridArrival(list: React.RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const h = take('list');
    const card = list.current?.querySelector<HTMLElement>('[data-morph="grid-card"]');
    if (!card) return;
    const scroller = scrollerOf(card);
    if (scroller && listScroll) scroller.scrollTop = listScroll;
    listScroll = 0;
    if (!h) return;
    if (list.current) list.current.style.animation = 'none'; // not the page's own entrance as well
    const duration = 460;
    const carry = offsetTo(card, h.card);
    card.style.zIndex = '3'; card.style.position = 'relative';
    // the picture first: it is measured where it will be, before the capsule it rides on starts to move
    flipFrom(card.querySelector<SVGElement>(`[data-morph="grid-${h.style}"]`), h.picture, { duration, carry });
    const run = flipFrom(card, h.card, { scale: 'none', duration });
    void run?.finished.catch(() => undefined).then(() => { card.style.zIndex = ''; card.style.position = ''; });
    rise(Array.from(card.parentElement?.children ?? []).filter((c) => c !== card), { delay: 90, stagger: 14, y: 6, duration: 300 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The stand-in for the live view: plain mid grey, on which the lines (and the hidden ones) show alike. */
const GRID_BACKDROP = '#8a8a8a';
function GridScene() {
  return <rect x="0" y="0" width="720" height="480" fill={GRID_BACKDROP} />;
}

/** The capsule's small picture of the grids: 3x3 and 4x4 side by side, only the lines that are on. */
export function GridThumb() {
  const framing = useStore((s) => framingOffered(s));
  return framing ? <FramingThumb /> : <LinesThumb />;
}

function LinesThumb() {
  const lines = useStore((s) => s.gridLines);
  const on = useStore((s) => s.customGrid);
  const xy = (at: GridLineDef['at']) => ({ x1: at[0] * 720, y1: at[1] * 480, x2: at[2] * 720, y2: at[3] * 480 });
  return (
    <div className={`grid-thumbs ${on ? '' : 'off'}`} aria-hidden>
      {(['g3', 'g4'] as GridStyle[]).map((g) => (
        <svg key={g} viewBox="0 0 720 480" className="grid-thumb" data-morph={`grid-${g}`}>
          <GridScene />
          {GRID_LINES[g].map((d, i) => (lines[g][i] ? <line key={i} {...xy(d.at)} stroke={GRID_COLOUR} strokeWidth={14} /> : null))}
        </svg>
      ))}
    </div>
  );
}

/**
 * The custom grid's lines: a preview of the style (click a line to show or hide it) and a button per line.
 *
 * The eight lines are the same elements in both styles: going from 3x3 to 4x4 the thirds slide to the quarters.
 * A line that is switched on is drawn along its length over the dashed mark of its place; switched off it
 * shrinks back (styles.css `.gl`).
 */
function GridLinesEditor() {
  const lines = useStore((s) => s.gridLines);
  const [style, setStyleState] = useState<GridStyle>(shownStyle);
  const setStyle = (g: GridStyle): void => { shownStyle = g; setStyleState(g); };
  const [hot, setHot] = useState(-1);
  const menu = useStore((s) => !!s.info?.features.gridMenu);
  const defs = GRID_LINES[style];
  const toggle = (i: number): void => setGridLine(style, i, !lines[style][i]);
  return (
    <div className="grid-edit">
      <Segmented<GridStyle> value={style} onChange={setStyle} options={[{ value: 'g3', label: t('grid3') }, { value: 'g4', label: t('grid4') }]} />
      <div className="grid-edit-body">
        <svg viewBox={`0 0 ${W} ${H}`} className="grid-edit-preview">
          <GridScene />
          {defs.map((d, i) => {
            // straight lines are drawn through the middle and moved to their place, so that the place can slide
            const straight = d.group !== 'd';
            const move = d.group === 'h' ? `translate(0px, ${(d.at[1] - 0.5) * H}px)` : d.group === 'v' ? `translate(${(d.at[0] - 0.5) * W}px, 0px)` : undefined;
            const xy = d.group === 'h' ? { x1: 0, y1: H / 2, x2: W, y2: H / 2 } : d.group === 'v' ? { x1: W / 2, y1: 0, x2: W / 2, y2: H } : { x1: d.at[0] * W, y1: d.at[1] * H, x2: d.at[2] * W, y2: d.at[3] * H };
            const length = d.group === 'h' ? W : d.group === 'v' ? H : Math.hypot(W, H);
            return (
              <g key={i} className={`gl ${lines[style][i] ? 'on' : ''} ${hot === i ? 'hot' : ''}`} style={straight ? { transform: move } : undefined}>
                <line {...xy} className="gl-mark" strokeWidth={3} strokeDasharray="14 12" />
                <line {...xy} className="gl-line" stroke={GRID_COLOUR} strokeWidth={5} style={{ strokeDasharray: length, ['--gl-length' as string]: length }} />
                <line {...xy} stroke="transparent" strokeWidth={40} className="grid-edit-hit" onClick={() => toggle(i)} onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot((x) => (x === i ? -1 : x))} />
              </g>
            );
          })}
        </svg>
        <div className="grid-edit-lines">
          {GRID_GROUPS.map((g) => (
            <div key={g.id} className="grid-edit-group">
              <span className="muted small">{t(g.name)}</span>
              <div className="chips">
                {defs.map((d, i) => (d.group !== g.id ? null : (
                  <button key={i} type="button" className="btn small" aria-pressed={lines[style][i]} onClick={() => toggle(i)} onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot((x) => (x === i ? -1 : x))}>{t(d.name)}</button>
                )))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="muted small">{t(menu ? 'gridHintMenu' : 'gridHint')}</p>
    </div>
  );
}

/** The custom grid's own view on the additions page: its switch, then the editor (dimmed while the switch is off). */
export function GridDetail() {
  const on = useStore((s) => s.customGrid);
  const same = useStore((s) => isCameraGrid(s.gridLines));
  const menu = useStore((s) => !!s.info?.features.gridMenu);
  const framing = useStore((s) => framingOffered(s));
  const [preset, setPresetState] = useState<0 | 1>(shownStyle === 'g3' ? 0 : 1);
  const setPreset = (i: 0 | 1): void => { shownStyle = i === 0 ? 'g3' : 'g4'; setPresetState(i); };
  const root = useRef<HTMLDivElement>(null);
  // arriving from the capsule (openGrid): the switch from the capsule's place, the preview out of its small picture
  useLayoutEffect(() => {
    const page = root.current;
    if (!page) return;
    const scroller = scrollerOf(page);
    if (scroller && scroller !== page) scroller.scrollTop = 0;
    const h = take('grid');
    if (!h) return;
    flipFrom(page.querySelector<HTMLElement>('.grid-switch'), h.card, { scale: 'none', duration: 440 });
    flipFrom(page.querySelector<SVGElement>('.grid-edit-preview'), h.picture, { duration: 520 });
    rise(page.querySelectorAll(EDITOR_PARTS), { delay: 140, stagger: 55 });
  }, []);
  return (
    <div className={`grid-page ${on ? '' : 'off'}`} data-tour-page="extras" ref={root}>
      <div className={`capsule grid-switch ${on ? 'on' : ''}`} data-tour="grid-switch">
        <div className="capsule-top">
          <span className="page-icon soft-ico">{Ico.grid}</span>
          <b className="capsule-title">{t('navGrid')}</b>
          <Switch checked={on} onChange={setCustomGrid} label={t('navGrid')} />
        </div>
        <p className="capsule-sub muted small">{t(menu ? 'gridSubMenu' : 'gridSub')}</p>
      </div>
      {!framing && on && same && <p className="muted small grid-same">{t('gridSameAsCamera')}</p>}
      {framing ? <FramingEditor preset={preset} setPreset={setPreset} /> : <GridLinesEditor />}
    </div>
  );
}
