import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isAndroid, useBack } from './host-android';
import { ICON_H, ICON_W, RATIO_ICON_H, RATIO_ICON_W } from '@grmod/core';
import { uiScale } from './fit';
import { rgbToCanvas, rgbaToCanvas } from './pixels';
import { answerConfirm, dismissToast, useStore } from './store';
import { t } from './i18n';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
export const Ico = {
  camera: <svg viewBox="0 0 20 20" {...P}><rect x="2.6" y="5.6" width="14.8" height="10" rx="2" /><circle cx="10" cy="10.6" r="2.8" /><path d="M5.2 5.6l1-2h3l1 2" /></svg>,
  send: <svg viewBox="0 0 20 20" {...P}><path d="M10 15.5V5M5.8 9.2L10 5l4.2 4.2" /><path d="M4 16.5h12" /></svg>,
  sliders: <svg viewBox="0 0 20 20" {...P}><path d="M3.5 6h8M15 6h1.5M3.5 14h1.5M8.5 14h8" /><circle cx="13" cy="6" r="1.8" /><circle cx="6.8" cy="14" r="1.8" /></svg>,
  save: <svg viewBox="0 0 20 20" {...P}><path d="M10 3.5V13M6 9.2l4 4 4-4" /><path d="M4 16.5h12" /></svg>,
  aperture: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M7.66 8.65L14.73 4.57M10.00 7.30L17.07 11.38M12.34 8.65L12.34 16.81M12.34 11.35L5.27 15.43M10.00 12.70L2.93 8.62M7.66 11.35L7.66 3.19" /></svg>,
  bright: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="3.4" /><path d="M10 6.6a3.4 3.4 0 0 1 0 6.8z" fill="currentColor" /><path d="M10 2.6v1.6M10 15.8v1.6M2.6 10h1.6M15.8 10h1.6M4.8 4.8l1.1 1.1M14.1 14.1l1.1 1.1M4.8 15.2l1.1-1.1M14.1 5.9l1.1-1.1" /></svg>,
  pen: <svg viewBox="0 0 20 20" {...P}><path d="M12.6 4.4l3 3L7.4 15.6 3.6 16.4l.8-3.8z" /><path d="M11.1 5.9l3 3" /></svg>,
  swatch: <svg viewBox="0 0 20 20" {...P}><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="11" y="3" width="6" height="6" rx="1.4" /><rect x="3" y="11" width="6" height="6" rx="1.4" /><rect x="11" y="11" width="6" height="6" rx="1.4" /></svg>,
  image: <svg viewBox="0 0 20 20" {...P}><rect x="2.8" y="4" width="14.4" height="12" rx="2" /><circle cx="7.3" cy="8.2" r="1.3" /><path d="M3.2 14l4-3.6 3 2.6 2.6-2.2 4 3.4" /></svg>,
  card: <svg viewBox="0 0 20 20" {...P}><path d="M5.5 2.8h6.2l3.3 3.3v9.6a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 15.7V4.3a1.5 1.5 0 0 1 1.5-1.5z" /><path d="M7.4 5.6v2.2M9.8 5.6v2.2M12.2 6.6v1.2" /></svg>,
  folder: <svg viewBox="0 0 20 20" {...P}><path d="M2.8 6a1.5 1.5 0 0 1 1.5-1.5h3.3l1.6 1.8h6.5a1.5 1.5 0 0 1 1.5 1.5v6.4a1.5 1.5 0 0 1-1.5 1.5H4.3a1.5 1.5 0 0 1-1.5-1.5z" /></svg>,
  more: <svg viewBox="0 0 20 20" fill="currentColor"><circle cx="4.5" cy="10" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="15.5" cy="10" r="1.4" /></svg>,
  x: <svg viewBox="0 0 20 20" {...P}><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" /></svg>,
  check: <svg viewBox="0 0 20 20" {...P} strokeWidth={2}><path d="M4.5 10.5l3.6 3.6 7.4-8" /></svg>,
  plus: <svg viewBox="0 0 20 20" {...P}><path d="M10 4.5v11M4.5 10h11" /></svg>,
  crop: <svg viewBox="0 0 20 20" {...P}><path d="M5.5 2.5v10.5a1.5 1.5 0 0 0 1.5 1.5h10.5M2.5 5.5h10.5a1.5 1.5 0 0 1 1.5 1.5v10.5" /></svg>,
  refresh: <svg viewBox="0 0 20 20" {...P}><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3h-3" /></svg>,
  chip: <svg viewBox="0 0 20 20" {...P}><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /><path d="M8 2.8v2.7M12 2.8v2.7M8 14.5v2.7M12 14.5v2.7M2.8 8h2.7M2.8 12h2.7M14.5 8h2.7M14.5 12h2.7" /></svg>,
  tool: <svg viewBox="0 0 20 20" {...P}><path d="M12.4 3.1a4.1 4.1 0 0 0-4.8 5.4l-4.5 4.5a1.65 1.65 0 0 0 2.3 2.3l4.5-4.5a4.1 4.1 0 0 0 5.4-4.8l-2.5 2.5-2.2-.6-.6-2.2z" /></svg>,
  archive: <svg viewBox="0 0 20 20" {...P}><rect x="2.8" y="3.6" width="14.4" height="4" rx="1.2" /><path d="M4 7.6v7.3a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V7.6M8 10.8h4" /></svg>,
  trash: <svg viewBox="0 0 20 20" {...P}><path d="M3.8 5.6h12.4M8 5.6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.6M5.4 5.6l.7 9.6a1.5 1.5 0 0 0 1.5 1.4h4.8a1.5 1.5 0 0 0 1.5-1.4l.7-9.6M8.4 8.6v5M11.6 8.6v5" /></svg>,
  ratio: <svg viewBox="0 0 20 20" {...P}><rect x="2.8" y="3.6" width="14.4" height="12.8" rx="2" /><path d="M2.8 7.4h14.4M2.8 12.6h14.4" /></svg>,
  file: <svg viewBox="0 0 20 20" {...P}><path d="M6 2.8h5.2L15 6.6v9.1a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V4.3A1.5 1.5 0 0 1 6 2.8z" /><path d="M11 3v3.8h3.8" /></svg>,
  left: <svg viewBox="0 0 20 20" {...P}><path d="M12 5l-5 5 5 5" /></svg>,
  right: <svg viewBox="0 0 20 20" {...P}><path d="M8 5l5 5-5 5" /></svg>,
  updown: <svg viewBox="0 0 20 20" {...P}><path d="M6.5 8l3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5" /></svg>,
  up: <svg viewBox="0 0 20 20" {...P}><path d="M5.5 12.2L10 7.7l4.5 4.5" /></svg>,
  down: <svg viewBox="0 0 20 20" {...P}><path d="M5.5 7.8L10 12.3l4.5-4.5" /></svg>,
  grip: <svg viewBox="0 0 20 20" fill="currentColor"><circle cx="7.4" cy="5.2" r="1.25" /><circle cx="12.6" cy="5.2" r="1.25" /><circle cx="7.4" cy="10" r="1.25" /><circle cx="12.6" cy="10" r="1.25" /><circle cx="7.4" cy="14.8" r="1.25" /><circle cx="12.6" cy="14.8" r="1.25" /></svg>,
  eye: <svg viewBox="0 0 20 20" {...P}><path d="M2.6 10S5.3 5 10 5s7.4 5 7.4 5-2.7 5-7.4 5-7.4-5-7.4-5z" /><circle cx="10" cy="10" r="2.2" /></svg>,
  eyeOff: <svg viewBox="0 0 20 20" {...P}><path d="M8.3 5.2A7.4 7.4 0 0 1 10 5c4.7 0 7.4 5 7.4 5a12.4 12.4 0 0 1-2 2.6M12.3 14.6A6.8 6.8 0 0 1 10 15c-4.7 0-7.4-5-7.4-5a12.6 12.6 0 0 1 3.1-3.6M8.5 8.5a2.2 2.2 0 0 0 3 3M3.6 3.6l12.8 12.8" /></svg>,
  bridge: <svg viewBox="0 0 20 20" {...P}><path d="M2.5 7.5h15M2.5 13.5h15M4.5 7.5v6M15.5 7.5v6M4.5 7.5c1.6 2.6 3.4 3.9 5.5 3.9s3.9-1.3 5.5-3.9" /></svg>,
  download: <svg viewBox="0 0 20 20" {...P}><path d="M10 3.2v9.6M6 9.2l4 3.8 4-3.8M4 16.2h12" /></svg>,
  info: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M10 9.2v4.4" /><circle cx="10" cy="6.4" r="0.6" fill="currentColor" /></svg>,
  soft: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="3.3" /><circle cx="10" cy="10" r="7.2" strokeDasharray="1.4 2.35" /></svg>,
  date: <svg viewBox="0 0 20 20" {...P}><rect x="2.8" y="4.4" width="14.4" height="12" rx="2" /><path d="M2.8 8.2h14.4M6.6 2.8v3M13.4 2.8v3M6.4 11.4h1.6M9.2 11.4h1.6M12 11.4h1.6M6.4 13.8h1.6M9.2 13.8h1.6" /></svg>,
  adj: <svg viewBox="0 0 20 20" {...P}><rect x="1.8" y="6.6" width="3.4" height="3.4" rx="0.8" /><rect x="6.4" y="6.6" width="3.4" height="3.4" rx="0.8" /><rect x="11" y="6.6" width="3.4" height="3.4" rx="0.8" /><rect x="15.6" y="6.6" width="2.6" height="3.4" rx="0.8" /><path d="M3.5 13.4h13" /></svg>,
  flash: <svg viewBox="0 0 20 20" {...P}><path d="M11.8 2.6L5.4 11h4.2l-1.8 6.4 6.8-8.8h-4.4l1.6-6z" /></svg>,
  hdr: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="3.2" /><path d="M10 2.2v2.2M10 15.6v2.2M2.2 10h2.2M15.6 10h2.2M4.5 4.5l1.6 1.6M13.9 13.9l1.6 1.6M4.5 15.5l1.6-1.6M13.9 6.1l1.6-1.6" /></svg>,
  preview: <svg viewBox="0 0 20 20" {...P}><path d="M1.8 10c2.2-3.6 5-5.4 8.2-5.4s6 1.8 8.2 5.4c-2.2 3.6-5 5.4-8.2 5.4S4 13.6 1.8 10z" /><circle cx="10" cy="10" r="2.6" /></svg>,
  mono: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M10 2.8a7.2 7.2 0 0 1 0 14.4z" fill="currentColor" stroke="none" /></svg>,
  help: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M7.9 8a2.2 2.2 0 1 1 3.3 1.9c-.8.5-1.2 1-1.2 1.8" /><circle cx="10" cy="13.9" r="0.6" fill="currentColor" /></svg>,
  external: <svg viewBox="0 0 20 20" {...P}><path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7" /></svg>,
};

/** An on / off switch. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button>;
}

export function Segmented<T extends string>({ value, options, onChange, tour, className }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; tour?: string; className?: string }) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="tablist" data-tour={tour}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} title={o.title} aria-label={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Prop({ label, children, tour }: { label: string; children: ReactNode; tour?: string }) {
  return (
    <div className="prop" data-tour={tour}>
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

export function FileButton({ accept, multiple, onFiles, children, className, title }: { accept?: string; multiple?: boolean; onFiles: (f: File[]) => void; children: ReactNode; className?: string; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className || 'btn'} title={title} onClick={() => ref.current?.click()}>{children}</button>
      <input ref={ref} type="file" accept={accept} multiple={multiple} hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) onFiles(f); }} />
    </>
  );
}

/** Wraps children in a drop target; `over` styling while dragging files across it. */
export function DropZone({ onFiles, className, children, accept, tour }: { onFiles: (f: File[]) => void; className?: string; children: ReactNode; accept?: (f: File) => boolean; tour?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <div
      className={`${className || ''} ${over ? 'drop-over' : ''}`} data-tour={tour}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { depth.current++; setOver(true); } }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setOver(false); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(e) => {
        depth.current = 0; setOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault(); e.stopPropagation();
        const files = Array.from(e.dataTransfer.files).filter((f) => !accept || accept(f));
        if (files.length) onFiles(files);
      }}
    >
      {children}
    </div>
  );
}

export function IconCanvas({ pixels, scale = 2 }: { pixels: Uint8Array; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) rgbaToCanvas(ref.current, pixels, ICON_W, ICON_H); }, [pixels]);
  return <span className="icon-frame" style={{ width: ICON_W * scale + 8, height: ICON_H * scale + 8 }}><canvas ref={ref} className="pixel" style={{ width: ICON_W * scale, height: ICON_H * scale }} /></span>;
}

/** A ratio's menu icon (60x40 RGBA), or an empty tile of the same size. */
export function RatioIcon({ pixels, width = RATIO_ICON_W }: { pixels?: Uint8Array; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current && pixels) rgbaToCanvas(ref.current, pixels, RATIO_ICON_W, RATIO_ICON_H); }, [pixels]);
  const height = Math.round((width * RATIO_ICON_H) / RATIO_ICON_W);
  return <span className="icon-frame ratio-icon" style={{ width, height }}>{pixels && <canvas ref={ref} style={{ width, height }} />}</span>;
}

export function RgbCanvas({ rgb, w, h, className }: { rgb: Uint8Array; w: number; h: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) rgbToCanvas(ref.current, rgb, w, h); }, [rgb, w, h]);
  return <canvas ref={ref} className={className} />;
}

export function Menu({ items, children }: { items: { label: string; run: () => void; disabled?: boolean }[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (isAndroid) {
    return (
      <div className="menu-wrap" ref={ref}>
        <button className="btn ghost icon-only" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>{children}</button>
        {open && <ChoiceSheet label="" onClose={() => setOpen(false)} items={items} />}
      </div>
    );
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn ghost icon-only" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>{children}</button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Closes a pop-up on a press outside of `ref` and on Escape. */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', close); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Where a pop-up of about `want` pixels fits next to `el`: above or below, and how tall it may be (in layout pixels). */
export function popPlace(el: HTMLElement, want: number): { up: boolean; max: number } {
  const r = el.getBoundingClientRect();
  const k = uiScale() || 1;
  const below = (window.innerHeight - r.bottom) / k - 12;
  const above = r.top / k - 12;
  const up = below < want && above > below;
  return { up, max: Math.max(96, Math.min(want, up ? above : below)) };
}

/** Scrolls `box` (only) so that `el`, one of its rows, is in view. */
function scrollWithin(box: HTMLElement | null, el: Element | null | undefined): void {
  if (!box || !(el instanceof HTMLElement)) return;
  if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
  else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
}

/**
 * Android: a sheet over everything (outside the page, so nothing in the page clips or moves it), from the bottom
 * or, with side "right", a panel from the right. The page behind is blurred. It slides away on close, can be pulled
 * away (down, or to the right), and closes with the back button. `children` gets the closing function, so a choice
 * can slide the sheet away before it acts.
 */
export function MobileSheet({ label, onClose, children, className, side = 'bottom' }: { label: string; onClose: () => void; children: (close: () => void) => ReactNode; className?: string; side?: 'bottom' | 'right' }) {
  const [closing, setClosing] = useState(false);
  const [pull, setPull] = useState(0);
  const [pulling, setPulling] = useState(false);
  const drag = useRef<{ id: number; x0: number; y0: number; t0: number; on: boolean | null } | null>(null);
  const done = useRef(false);
  const right = side === 'right';
  const close = (): void => { if (done.current) return; done.current = true; setClosing(true); window.setTimeout(onClose, right ? 260 : 220); };
  useBack(true, close);
  const down = (e: React.PointerEvent<HTMLElement>): void => {
    if (drag.current) return;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, on: right ? null : true };
    if (!right) { e.currentTarget.setPointerCapture(e.pointerId); setPulling(true); }
  };
  const move = (e: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.on === null) {
      // the panel: a sideways pull to the right takes it; anything else is left to scrolling
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      d.on = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2;
      if (!d.on) { drag.current = null; return; }
      e.currentTarget.setPointerCapture(e.pointerId);
      setPulling(true);
    }
    setPull(Math.max(0, right ? dx : dy));
  };
  const up = (e: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.on) return;
    setPulling(false);
    const dist = Math.max(0, right ? e.clientX - d.x0 : e.clientY - d.y0);
    if (dist > 90 || (dist / Math.max(1, e.timeStamp - d.t0) > 0.5 && dist > 24)) close(); else setPull(0);
  };
  const pullStyle = pull && !closing ? { transform: right ? `translateX(${pull}px)` : `translateY(${pull}px)` } : undefined;
  return createPortal(
    <div className={`overlay m-sheet-wrap ${right ? 'm-drawer-wrap' : ''} ${closing ? 'closing' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {right ? (
        <div className={`m-drawer ${className || ''} ${pulling ? 'pulling' : ''}`} role="dialog" aria-modal="true" aria-label={label} style={pullStyle}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <div className="m-drawer-head"><b>{label}</b><button type="button" className="btn ghost icon-only" aria-label={t('pushClose')} onClick={close}>{Ico.x}</button></div>
          {children(close)}
        </div>
      ) : (
        <div className={`m-sheet ${className || ''} ${pulling ? 'pulling' : ''}`} role="dialog" aria-modal="true" aria-label={label} style={pullStyle}>
          <div className="m-sheet-grip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}><i /></div>
          {children(close)}
        </div>
      )}
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}

/** Android: a few commands in a sheet (in place of a drop-down menu). */
export function ChoiceSheet({ label, onClose, items }: { label: string; onClose: () => void; items: { label: string; run: () => void; disabled?: boolean; icon?: ReactNode }[] }) {
  return (
    <MobileSheet label={label} onClose={onClose} className="m-choices">
      {(shut) => (
        <>
          {label && <div className="m-sheet-title">{label}</div>}
          <div className="m-choice-list" role="menu">
            {items.map((it) => (
              <button key={it.label} type="button" role="menuitem" className="m-choice" disabled={it.disabled} onClick={() => { shut(); window.setTimeout(it.run, 120); }}>
                {it.icon && <span className="m-choice-ico">{it.icon}</span>}<span className="ellipsis">{it.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </MobileSheet>
  );
}

export interface SelectOption<T extends string> { value: T; label: string }
/**
 * A chooser in the style of the rest of the interface (the system's own list does not follow it).
 * `variant` "row" is a property row of the sidebar with `lead` as its label; "box" is a bordered field.
 * `actions` are extra commands under the options.
 */
export function Select<T extends string>({ value, options, onChange, label, variant, lead, placeholder, actions, tour }: {
  value: T | undefined; options: SelectOption<T>[]; onChange: (v: T) => void; label: string; variant: 'row' | 'box';
  lead?: ReactNode; placeholder?: string; actions?: { label: string; run: () => void }[]; tour?: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ up: false, max: 320 });
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const extra = actions || [];
  const count = options.length + extra.length;
  const current = options.find((o) => o.value === value);
  const close = (): void => { if (list.current?.contains(document.activeElement)) button.current?.focus(); setOpen(false); };
  useDismiss(open && !isAndroid, wrap, close);
  const show = (): void => {
    setPlace(popPlace(wrap.current!, Math.min(320, count * 28 + (extra.length ? 9 : 0) + 8)));
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    scrollWithin(list.current, list.current?.querySelector('[aria-selected="true"]'));
  }, [open]);
  const run = (i: number): void => {
    close();
    if (i < options.length) { if (options[i].value !== value) onChange(options[i].value); } else extra[i - options.length]?.run();
  };
  const move = (to: number): void => {
    if (count === 0) return;
    const i = Math.max(0, Math.min(count - 1, to));
    setActive(i);
    scrollWithin(list.current, list.current?.children[i + (i >= options.length && extra.length ? 1 : 0)]);
  };
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active < 0 ? count - 1 : active - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(count - 1);
    else if (e.key === 'Enter' || e.key === ' ') { if (active >= 0) run(active); }
    else if (e.key === 'Tab') close();
    else return;
    e.preventDefault();
  };
  if (isAndroid) {
    // a phone: the choices in a sheet from the bottom
    return (
      <div className={`sel ${variant} ${open ? 'open' : ''}`} ref={wrap} data-tour={tour}>
        <button type="button" className="sel-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(true)}>
          {lead}
          <span className={`sel-value ${current ? '' : 'muted'}`}><span className="ellipsis">{current ? current.label : placeholder || ''}</span>{Ico.updown}</span>
        </button>
        {open && (
          <MobileSheet label={label} onClose={() => setOpen(false)} className="m-choices">
            {(shut) => (
              <>
                <div className="m-sheet-title">{label}</div>
                <div className="m-choice-list" role="listbox" aria-label={label}>
                  {options.map((o) => (
                    <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={`m-choice ${o.value === value ? 'on' : ''}`}
                      onClick={() => { shut(); if (o.value !== value) window.setTimeout(() => onChange(o.value), 120); }}>
                      <span className="ellipsis">{o.label}</span>{o.value === value && Ico.check}
                    </button>
                  ))}
                  {extra.length > 0 && <div className="pop-sep" role="separator" />}
                  {extra.map((a) => (
                    <button key={a.label} type="button" className="m-choice action" onClick={() => { shut(); window.setTimeout(a.run, 120); }}><span className="ellipsis">{a.label}</span></button>
                  ))}
                </div>
              </>
            )}
          </MobileSheet>
        )}
      </div>
    );
  }
  return (
    <div className={`sel ${variant} ${open ? 'open' : ''}`} ref={wrap} data-tour={tour}>
      <button
        type="button" className="sel-btn" ref={button} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onClick={() => (open ? close() : show())} onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); } }}
      >
        {lead}
        <span className={`sel-value ${current ? '' : 'muted'}`}><span className="ellipsis">{current ? current.label : placeholder || ''}</span>{Ico.updown}</span>
      </button>
      {open && (
        <div className={`pop ${place.up ? 'up' : 'down'}`} role="listbox" aria-label={label} tabIndex={-1} ref={list} style={{ maxHeight: place.max }} onKeyDown={onKey}>
          {options.map((o, i) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} tabIndex={-1} className={`pop-item ${i === active ? 'active' : ''}`} onMouseMove={() => { if (active !== i) setActive(i); }} onClick={() => run(i)}>
              <span className="ellipsis">{o.label}</span>{o.value === value && Ico.check}
            </button>
          ))}
          {extra.length > 0 && <div className="pop-sep" role="separator" />}
          {extra.map((a, i) => (
            <button key={a.label} type="button" tabIndex={-1} className={`pop-item ${options.length + i === active ? 'active' : ''}`} onMouseMove={() => { if (active !== options.length + i) setActive(options.length + i); }} onClick={() => run(options.length + i)}>
              <span className="ellipsis">{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small "i" that shows a note while the pointer is on it (or it has the keyboard focus). */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="hint" tabIndex={0} role="note" aria-label={label}>
      {Ico.info}
      <span className="hint-pop" role="tooltip">{children}</span>
    </span>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} role="status">
          <span className="toast-text">{x.text}</span>
          {x.action && <button className="toast-action" onClick={() => { x.action!.run(); dismissToast(x.id); }}>{x.action.label}</button>}
          <button className="toast-x" aria-label="close" onClick={() => dismissToast(x.id)}>{Ico.x}</button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const c = useStore((s) => s.confirm);
  useEffect(() => {
    if (!c) return;
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') answerConfirm(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [c]);
  if (!c) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) answerConfirm(false); }}>
      <div className="dialog" role="alertdialog" aria-modal="true">
        <h3>{c.title}</h3>
        {c.lines.length > 0 && <ul className={`dialog-lines ${c.warn ? '' : 'last'}`}>{c.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
        {c.warn && <p className="dialog-warn">{c.warn}</p>}
        {c.reset && (
          <div className="dialog-reset" role="note">
            <b>{t('resetNoteTitle')}</b>
            <span>{t('resetNoteBody')}</span>
            <span className="dialog-reset-path">{t('resetNotePath')}</span>
          </div>
        )}
        <div className="dialog-actions">
          {/* writing the official firmware: Cancel has the focus, the red button must be clicked */}
          <button className="btn" autoFocus={!!c.reset} onClick={() => answerConfirm(false)}>{t('cancel')}</button>
          <button className={c.reset ? 'btn danger-solid' : 'btn primary'} autoFocus={!c.reset} onClick={() => answerConfirm(true)}>{c.ok}</button>
        </div>
      </div>
    </div>
  );
}

export function Busy() {
  const busy = useStore((s) => s.busy);
  if (!busy) return null;
  return <div className="overlay busy"><div className="busy-pill"><span className="spinner" />{busy}</div></div>;
}
