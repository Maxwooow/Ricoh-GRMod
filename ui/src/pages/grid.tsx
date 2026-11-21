import { useState } from 'react';
import { isCameraGrid } from '@grmod/core';
import { Ico, Segmented, Switch } from '../components';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { setCustomGrid, setGridLine, useStore } from '../store';

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

/** The stand-in for the live view: plain mid grey, on which the lines (and the hidden ones) show alike. */
const GRID_BACKDROP = '#8a8a8a';
function GridScene() {
  return <rect x="0" y="0" width="720" height="480" fill={GRID_BACKDROP} />;
}

/** The capsule's small picture of the grids: 3x3 and 4x4 side by side, only the lines that are on. */
export function GridThumb() {
  const lines = useStore((s) => s.gridLines);
  const on = useStore((s) => s.customGrid);
  const xy = (at: GridLineDef['at']) => ({ x1: at[0] * 720, y1: at[1] * 480, x2: at[2] * 720, y2: at[3] * 480 });
  return (
    <div className={`grid-thumbs ${on ? '' : 'off'}`} aria-hidden>
      {(['g3', 'g4'] as GridStyle[]).map((g) => (
        <svg key={g} viewBox="0 0 720 480" className="grid-thumb">
          <GridScene />
          {GRID_LINES[g].map((d, i) => (lines[g][i] ? <line key={i} {...xy(d.at)} stroke={GRID_COLOUR} strokeWidth={14} /> : null))}
        </svg>
      ))}
    </div>
  );
}

/** The custom grid's lines: a preview of the style (click a line to show or hide it) and a button per line. */
function GridLinesEditor() {
  const lines = useStore((s) => s.gridLines);
  const [style, setStyle] = useState<GridStyle>('g3');
  const menu = useStore((s) => !!s.info?.features.gridMenu);
  const defs = GRID_LINES[style];
  const xy = (at: GridLineDef['at']) => ({ x1: at[0] * 720, y1: at[1] * 480, x2: at[2] * 720, y2: at[3] * 480 });
  const toggle = (i: number): void => setGridLine(style, i, !lines[style][i]);
  return (
    <div className="grid-edit">
      <Segmented<GridStyle> value={style} onChange={setStyle} options={[{ value: 'g3', label: t('grid3') }, { value: 'g4', label: t('grid4') }]} />
      <div className="grid-edit-body">
        <svg viewBox="0 0 720 480" className="grid-edit-preview">
          <GridScene />
          {defs.map((d, i) => (lines[style][i]
            ? <line key={i} {...xy(d.at)} stroke={GRID_COLOUR} strokeWidth={5} />
            : <line key={i} {...xy(d.at)} stroke="rgba(255,255,255,.5)" strokeWidth={3} strokeDasharray="14 12" />))}
          {defs.map((d, i) => <line key={`hit${i}`} {...xy(d.at)} stroke="transparent" strokeWidth={40} className="grid-edit-hit" onClick={() => toggle(i)} />)}
        </svg>
        <div className="grid-edit-lines">
          {GRID_GROUPS.map((g) => (
            <div key={g.id} className="grid-edit-group">
              <span className="muted small">{t(g.name)}</span>
              <div className="chips">
                {defs.map((d, i) => (d.group !== g.id ? null : (
                  <button key={i} type="button" className="btn small" aria-pressed={lines[style][i]} onClick={() => toggle(i)}>{t(d.name)}</button>
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
  return (
    <div className={`grid-page ${on ? '' : 'off'}`} data-tour-page="extras">
      <div className={`capsule grid-switch ${on ? 'on' : ''}`} data-tour="grid-switch">
        <div className="capsule-top">
          <span className="page-icon soft-ico">{Ico.grid}</span>
          <b className="capsule-title">{t('navGrid')}</b>
          <Switch checked={on} onChange={setCustomGrid} label={t('navGrid')} />
        </div>
        <p className="capsule-sub muted small">{t(menu ? 'gridSubMenu' : 'gridSub')}</p>
      </div>
      {on && same && <p className="muted small">{t('gridSameAsCamera')}</p>}
      <GridLinesEditor />
    </div>
  );
}
