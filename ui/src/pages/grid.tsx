import { useState } from 'react';
import { isCameraGrid } from '@grmod/core';
import { DropZone, Ico, Segmented } from '../components';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { loadFirmwareFile, setCustomGrid, setGridLine, useStore } from '../store';
import { FeatureRow } from './features';
import { isFirmware } from './files';

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

/** A plain stand-in for the live view: sky, a horizon, a path and a tree. */
function GridScene() {
  return (
    <>
      <defs>
        <linearGradient id="grid-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5f7f9c" /><stop offset="0.55" stopColor="#a9b8c2" /><stop offset="0.56" stopColor="#6f7a56" /><stop offset="1" stopColor="#3e4632" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="720" height="480" fill="url(#grid-sky)" />
      <path d="M300 480 L350 268 L372 268 L460 480 Z" fill="#8c8673" opacity="0.75" />
      <rect x="500" y="170" width="12" height="110" fill="#3b3326" />
      <circle cx="506" cy="160" r="52" fill="#2f3d27" />
      <path d="M0 262 Q120 236 240 258 T480 252 T720 262 L720 270 L0 270 Z" fill="#55613f" opacity="0.8" />
    </>
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

/** The custom grid page: the switch, then the editor (dimmed while the switch is off). */
export function GridPage() {
  const info = useStore((s) => s.info);
  const on = useStore((s) => s.customGrid);
  const same = useStore((s) => isCameraGrid(s.gridLines));
  const menu = useStore((s) => !!s.info?.features.gridMenu);
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.grid}</span>
        <h1>{t('navGridPage')}</h1>
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className={`grid-page ${on ? '' : 'off'}`} data-tour-page="grid">
          <div className="card extras">
            <FeatureRow icon={Ico.grid} title={t('navGrid')} sub={t(menu ? 'gridSubMenu' : 'gridSub')} on={on} onChange={setCustomGrid} tour="grid-switch" />
          </div>
          {on && same && <p className="muted small">{t('gridSameAsCamera')}</p>}
          <GridLinesEditor />
        </div>
      )}
    </DropZone>
  );
}
