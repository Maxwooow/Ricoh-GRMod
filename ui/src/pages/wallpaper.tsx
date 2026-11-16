import { useEffect, useRef, useState } from 'react';
import { SHUTDOWN_H, SHUTDOWN_NAME_MAX, SHUTDOWN_W } from '@grmod/core';
import { DropZone, FileButton, Ico, RgbCanvas } from '../components';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import { addWallFiles, loadFirmwareFile, moveWall, openCrop, removeWall, useStore, setWallName, wallMax, wallMenuProblem } from '../store';
import type { WallItem } from '../store';
import { isFirmware, isImage } from './files';

// ---------------------------------------------------------------- power-off images
function WallCard({ w, index }: { w: WallItem; index: number }) {
  const tour = index === 0 ? 'wall-card' : undefined;
  const [over, setOver] = useState(false);
  const problem = !w.busy ? wallMenuProblem(w) : null;
  return (
    <div
      className={`wall-card ${over ? 'drag-over' : ''}`} data-tour={tour}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/x-grmod-wall', w.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-grmod-wall')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const id = e.dataTransfer.getData('application/x-grmod-wall'); if (id && id !== w.id) { e.preventDefault(); e.stopPropagation(); moveWall(id, index); } }}
    >
      <div className="wall-thumb">
        {w.preview && <RgbCanvas rgb={w.preview} w={SHUTDOWN_W} h={SHUTDOWN_H} />}
        {w.busy && <span className="thumb-state"><span className="spinner" /></span>}
        {w.error && <span className="thumb-state bad">{w.error}</span>}
        <span className="wall-index">{index + 1}</span>
        <span className="wall-actions">
          <button className="btn mini" title={t('wallCrop')} onClick={() => openCrop(w.id)}>{Ico.crop}</button>
          <button className="btn mini" title={t('remove')} onClick={() => removeWall(w.id)}>{Ico.x}</button>
        </span>
      </div>
      <div className="wall-meta wall-name">
        <input
          className={`input small ${problem && w.menuJpeg ? 'bad' : ''}`} value={w.menuName ?? ''} maxLength={SHUTDOWN_NAME_MAX + 8}
          placeholder={t('wallName')} aria-label={t('wallName')} title={problem && w.menuJpeg ? problem : w.name} spellCheck={false}
          onChange={(e) => setWallName(w.id, e.target.value)}
        />
      </div>
    </div>
  );
}

/** Size of an element's content box, kept current. */
function useBox<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setBox((b) => (Math.abs(b.w - r.width) < 0.5 && Math.abs(b.h - r.height) < 0.5 ? b : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

const WALL_GAP = 14; const WALL_META = 28; const WALL_MAX = 400;
/** Columns and tile width that show `n` 3:2 tiles (each with a caption line) as large as the box allows. */
export function fitTiles(n: number, w: number, h: number): { cols: number; tile: number } {
  let best = { cols: 1, tile: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const byW = (w - WALL_GAP * (cols - 1)) / cols;
    const byH = ((h - WALL_GAP * (rows - 1)) / rows - WALL_META) * 1.5;
    const tile = Math.floor(Math.min(byW, byH, WALL_MAX));
    if (tile > best.tile) best = { cols, tile };
  }
  return best;
}

export function WallpaperPage() {
  const wall = useStore((s) => s.wall);
  const info = useStore((s) => s.info);
  const max = wallMax();
  const [ref, box] = useBox<HTMLDivElement>();
  const tiles = wall.length + (wall.length < max ? 1 : 0);
  const fit = fitTiles(tiles, box.w, box.h);
  return (
    <DropZone className="page" accept={(f) => isImage(f) || isFirmware(f)} onFiles={(f) => { const fwFile = f.find(isFirmware); if (fwFile) void loadFirmwareFile(fwFile); const imgs = f.filter(isImage); if (imgs.length) void addWallFiles(imgs); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.image}</span>
        <h1>{t('navWall')}</h1>
        {info && (
          <div className="head-right">
            {wall.length > 0 && <span className={`chip ${wall.length > max ? 'warn' : ''}`}>{wall.length}/{max}</span>}
          </div>
        )}
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="wall-fit" ref={ref} data-tour-page="wall">
          {fit.tile > 0 && (
            <div className="wall-grid" style={{ gridTemplateColumns: `repeat(${fit.cols}, ${fit.tile}px)` }}>
              {wall.map((w, i) => <WallCard key={w.id} w={w} index={i} />)}
              {wall.length < max && (
                <div className="wall-add" data-tour="wall-add">
                  <FileButton className="wall-add-btn" accept="image/*" multiple onFiles={(f) => { void addWallFiles(f); }}>{Ico.plus}<span>{wall.length ? t('wallAdd') : t('wallEmpty')}</span></FileButton>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </DropZone>
  );
}
