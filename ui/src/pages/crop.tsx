import { useEffect, useRef, useState } from 'react';
import { SHUTDOWN_H, SHUTDOWN_W } from '@grmod/core';
import { t } from '../i18n';
import type { Crop } from '../pixels';
import { onUiScale, uiScale } from '../fit';
import { openCrop, setCrop, useStore, wallBitmap } from '../store';

// ---------------------------------------------------------------- crop editor
const AR = SHUTDOWN_W / SHUTDOWN_H;
type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

export function CropEditor() {
  const cropId = useStore((s) => s.cropId);
  const item = useStore((s) => s.wall.find((w) => w.id === s.cropId));
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [crop, setLocal] = useState<Crop | null>(null);
  const [overlay, setOverlay] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: DragMode; sx: number; sy: number; start: Crop } | null>(null);
  const [stage, setStage] = useState({ w: 780, h: 520 });

  useEffect(() => {
    setBmp(null); setLocal(null);
    if (!item) return;
    let alive = true;
    void wallBitmap(item).then((b) => { if (alive && b) { setBmp(b); setLocal(item.crop); } });
    return () => { alive = false; };
  }, [cropId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const fit = (): void => { const z = uiScale(); setStage({ w: Math.min(900, window.innerWidth / z - 120), h: Math.min(620, window.innerHeight / z - 220) }); };
    fit(); window.addEventListener('resize', fit);
    const off = onUiScale(fit);
    return () => { window.removeEventListener('resize', fit); off(); };
  }, []);

  const scale = bmp ? Math.min(stage.w / bmp.width, stage.h / bmp.height) : 1;
  const dw = bmp ? Math.round(bmp.width * scale) : 0; const dh = bmp ? Math.round(bmp.height * scale) : 0;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !bmp) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(dw * dpr); c.height = Math.round(dh * dpr);
    const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, c.width, c.height);
  }, [bmp, dw, dh]);

  useEffect(() => {
    if (!cropId) return;
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') openCrop(undefined); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [cropId]);

  if (!cropId || !item) return null;
  const clamp = (c: Crop): Crop => {
    if (!bmp) return c;
    let w = Math.max(Math.min(c.w, bmp.width, bmp.height * AR), Math.min(64, bmp.width)); let h = w / AR;
    if (h > bmp.height) { h = bmp.height; w = h * AR; }
    return { x: Math.max(0, Math.min(bmp.width - w, c.x)), y: Math.max(0, Math.min(bmp.height - h, c.y)), w, h };
  };
  const onDown = (mode: DragMode) => (e: React.PointerEvent): void => {
    if (!crop) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: crop };
  };
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d || !bmp) return;
    const z = uiScale();
    const dx = (e.clientX - d.sx) / z / scale; const dy = (e.clientY - d.sy) / z / scale; const s = d.start;
    if (d.mode === 'move') { setLocal(clamp({ ...s, x: s.x + dx, y: s.y + dy })); return; }
    const left = d.mode === 'nw' || d.mode === 'sw'; const top = d.mode === 'nw' || d.mode === 'ne';
    // anchor = the opposite corner; new width from the larger of the two pointer deltas
    const ax = left ? s.x + s.w : s.x; const ay = top ? s.y + s.h : s.y;
    const wFromX = left ? s.w - dx : s.w + dx; const wFromY = (top ? s.h - dy : s.h + dy) * AR;
    const maxW = Math.min(left ? ax : bmp.width - ax, (top ? ay : bmp.height - ay) * AR);
    const w = Math.max(Math.min(64, maxW), Math.min(maxW, Math.max(wFromX, wFromY))); const h = w / AR;
    setLocal({ x: left ? ax - w : ax, y: top ? ay - h : ay, w, h });
  };
  const onUp = (): void => { drag.current = null; };
  const onWheel = (e: React.WheelEvent): void => {
    if (!crop || !bmp) return;
    const f = e.deltaY > 0 ? 1.06 : 1 / 1.06; const w = crop.w * f; const h = w / AR;
    setLocal(clamp({ x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - h) / 2, w, h }));
  };
  const r = crop ? { left: crop.x * scale, top: crop.y * scale, width: crop.w * scale, height: crop.h * scale } : null;
  const k = r ? r.width / SHUTDOWN_W : 1;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) openCrop(undefined); }}>
      <div className="dialog crop" role="dialog" aria-modal="true">
        <div className="crop-stage" style={{ width: dw || stage.w, height: dh || stage.h }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
          {!bmp && <span className="spinner" />}
          <canvas ref={canvasRef} style={{ width: dw, height: dh }} />
          {r && (
            <>
              <div className="crop-shade" style={{ left: 0, top: 0, width: dw, height: r.top }} />
              <div className="crop-shade" style={{ left: 0, top: r.top + r.height, width: dw, height: Math.max(0, dh - r.top - r.height) }} />
              <div className="crop-shade" style={{ left: 0, top: r.top, width: r.left, height: r.height }} />
              <div className="crop-shade" style={{ left: r.left + r.width, top: r.top, width: Math.max(0, dw - r.left - r.width), height: r.height }} />
              <div className="crop-rect" style={r} onPointerDown={onDown('move')}>
                {overlay && (
                  <>
                    <span className="cam-band" style={{ left: 24 * k, top: 336 * k, width: 672 * k, height: 48 * k }} />
                    <span className="cam-fw" style={{ left: 536 * k, top: 436 * k, width: 164 * k, height: 30 * k }} />
                  </>
                )}
                {(['nw', 'ne', 'sw', 'se'] as const).map((m) => <span key={m} className={`handle ${m}`} onPointerDown={onDown(m)} />)}
              </div>
            </>
          )}
        </div>
        <div className="dialog-actions spread">
          <label className="check"><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />{t('overlay')}</label>
          <span className="grow" />
          <button className="btn" onClick={() => openCrop(undefined)}>{t('cancel')}</button>
          <button className="btn primary" disabled={!crop} onClick={() => { if (crop) setCrop(item.id, crop); }}>{t('apply')}</button>
        </div>
      </div>
    </div>
  );
}
