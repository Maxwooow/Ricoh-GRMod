import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ICON_H, ICON_W, RATIO_ICON_H, RATIO_ICON_W } from '@grmod/core';
import { uiScale } from './fit';
import { rgbToCanvas, rgbaToCanvas } from './pixels';
import { answerConfirm, dismissToast, useStore } from './store';
import { t } from './i18n';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
export const Ico = {
  aperture: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M10 2.8l3.4 6M17.2 10h-6.9M13.6 16.2l-3.4-6M6.4 16.2l3.4-6M2.8 10h6.9M6.4 3.8l3.4 6" /></svg>,
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
  updown: <svg viewBox="0 0 20 20" {...P}><path d="M6.5 8l3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5" /></svg>,
  bridge: <svg viewBox="0 0 20 20" {...P}><path d="M2.5 7.5h15M2.5 13.5h15M4.5 7.5v6M15.5 7.5v6M4.5 7.5c1.6 2.6 3.4 3.9 5.5 3.9s3.9-1.3 5.5-3.9" /></svg>,
  download: <svg viewBox="0 0 20 20" {...P}><path d="M10 3.2v9.6M6 9.2l4 3.8 4-3.8M4 16.2h12" /></svg>,
  info: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M10 9.2v4.4" /><circle cx="10" cy="6.4" r="0.6" fill="currentColor" /></svg>,
  soft: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="3.3" /><circle cx="10" cy="10" r="7.2" strokeDasharray="1.4 2.35" /></svg>,
  date: <svg viewBox="0 0 20 20" {...P}><rect x="2.8" y="4.4" width="14.4" height="12" rx="2" /><path d="M2.8 8.2h14.4M6.6 2.8v3M13.4 2.8v3M6.4 11.4h1.6M9.2 11.4h1.6M12 11.4h1.6M6.4 13.8h1.6M9.2 13.8h1.6" /></svg>,
  mono: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M10 2.8a7.2 7.2 0 0 1 0 14.4z" fill="currentColor" stroke="none" /></svg>,
  help: <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.2" /><path d="M7.9 8a2.2 2.2 0 1 1 3.3 1.9c-.8.5-1.2 1-1.2 1.8" /><circle cx="10" cy="13.9" r="0.6" fill="currentColor" /></svg>,
  external: <svg viewBox="0 0 20 20" {...P}><path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7" /></svg>,
};

/** An on / off switch. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button>;
}

export function Segmented<T extends string>({ value, options, onChange, tour }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; tour?: string }) {
  return (
    <div className="seg" role="tablist" data-tour={tour}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
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
  useDismiss(open, wrap, close);
  const show = (): void => {
    setPlace(popPlace(wrap.current!, Math.min(320, count * 28 + (extra.length ? 9 : 0) + 8)));
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const run = (i: number): void => {
    close();
    if (i < options.length) { if (options[i].value !== value) onChange(options[i].value); } else extra[i - options.length]?.run();
  };
  const move = (to: number): void => {
    if (count === 0) return;
    const i = Math.max(0, Math.min(count - 1, to));
    setActive(i);
    list.current?.children[i + (i >= options.length && extra.length ? 1 : 0)]?.scrollIntoView({ block: 'nearest' });
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
        <div className="dialog-actions">
          <button className="btn" onClick={() => answerConfirm(false)}>{t('cancel')}</button>
          <button className="btn primary" autoFocus onClick={() => answerConfirm(true)}>{c.ok}</button>
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
