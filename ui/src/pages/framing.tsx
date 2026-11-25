/**
 * The framing guides' editor (GR IV 1.20 / 1.21): two grids of elements (frames, grids, golden section, single
 * lines, centre marks, diagonals), each in a colour of its own (eight in all), on the custom grid's page;
 * templates to start from.
 *
 * The preview draws exactly the rectangles the camera fills (core `framingRects`, the same integer arithmetic as
 * the firmware), on the camera's grey picture for a chosen aspect (its own 3:2, 1:1, 4:3, 16:9 or an added ratio).
 * The editing controls do not move: values change at once. Only the element cards open and close with a movement.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FRAMING_MAX_RECORDS, compilePreset, framingProblem, framingRects, isCameraPreset } from '@grmod/core';
import type { FramingBox, FramingColour, FramingElement, FramingFrameBox, FramingGuides, FramingPreset } from '@grmod/core';
import { Ico, Segmented } from '../components';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { EASE, EASE_EXIT, reducedMotion } from '../motion';
import {
  FRAMING_KINDS, FRAMING_SWATCHES, FRAMING_TEMPLATES, addFramingElement, applyFramingTemplate, canAdd, frameLetter, framingColourOf, ratioName,
  removeFramingElement, resetFramingPreset, setFramingElement, setFramingElementColour, templateGuides, useStore,
} from '../store';
import type { FramingKind, FramingTemplate } from '../store';

const W = 720;
const H = 480;
/** The grid view's frame for the camera's own aspects (tools/gr4v120/framing/check.py uses the same). */
const ASPECTS: Record<string, FramingFrameBox> = { '3:2': { x: 0, y: 0, w: 720, h: 480 }, '1:1': { x: 120, y: 0, w: 480, h: 480 }, '4:3': { x: 40, y: 0, w: 640, h: 480 }, '16:9': { x: 0, y: 38, w: 720, h: 404 } };
const TEMPLATE_NAMES: Record<string, Key> = {
  thirds: 'frTplThirds', quarters: 'frTplQuarters', flat: 'frTplFlat', centre: 'frTplCentre', cinema: 'frTplCinema',
};

const KIND_NAMES: Record<FramingKind, Key> = {
  frame: 'frKindFrame', grid: 'frKindGrid', golden: 'frKindGolden', line: 'frKindLine', centre: 'frKindCentre', diagonals: 'frKindDiagonals',
};
const RATIOS: readonly [string, number, number][] = [
  ['2.39:1', 239, 100], ['2.35:1', 235, 100], ['2:1', 2, 1], ['1.85:1', 185, 100], ['16:9', 16, 9], ['3:2', 3, 2], ['4:3', 4, 3], ['5:4', 5, 4], ['1:1', 1, 1], ['4:5', 4, 5], ['9:16', 9, 16], ['65:24', 65, 24],
];

const css = (c: FramingColour): string => `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})`;
const hex = (c: FramingColour): string => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A ratio as typed: "2.39:1", "65:24", "1.85" (to x:1); null when it is not one the camera can draw. */
function parseRatio(text: string): [number, number] | null {
  const m = /^\s*(\d+(?:\.\d{1,2})?)\s*(?::\s*(\d+(?:\.\d{1,2})?))?\s*$/.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? 1 : Number(m[2]);
  const scale = Number.isInteger(a) && Number.isInteger(b) ? 1 : 100;
  const num = Math.round(a * scale);
  const den = Math.round(b * scale);
  if (!(num >= 1 && den >= 1 && num <= 9999 && den <= 9999) || num / den > 20 || den / num > 20) return null;
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const d = g(num, den);
  return [num / d, den / d];
}
const ratioText = (num: number, den: number): string => {
  const named = RATIOS.find(([, n, d]) => n * den === d * num);
  if (named) return named[0];
  return den === 100 ? `${(num / 100).toFixed(2).replace(/0$/, '')}:1` : `${num}:${den}`;
};

// ---------------------------------------------------------------- the picture

/** What the camera draws for preset `i` on a picture: the rectangles it fills, the diagonals it lays out. */
export function FramingDrawing({ g, preset, frame, least = 0 }: { g: FramingGuides; preset: FramingPreset; frame: FramingFrameBox; least?: number }) {
  const c = useMemo(() => compilePreset(preset), [preset]);
  const rects = useMemo(() => framingRects(c, frame), [c, frame]);
  return (
    <>
      {/* `least`: the thinnest a rectangle is drawn (small pictures: a line of the camera's screen is less than a pixel there) */}
      {rects.map((r, k) => <rect key={k} x={r.x} y={r.y} width={Math.max(r.w, least)} height={Math.max(r.h, least)} fill={css(g.palette[r.colour])} shapeRendering="crispEdges" />)}
      {c.diagonals.map((d, k) => (d
        ? <line key={`d${k}`} x1={frame.x} y1={k === 0 ? frame.y : frame.y + frame.h} x2={frame.x + frame.w} y2={k === 0 ? frame.y + frame.h : frame.y} stroke={css(g.palette[d.colour])} strokeWidth={Math.max(d.width, least)} />
        : null))}
    </>
  );
}

/** The picture behind the guides: the camera's grey, black outside the aspect. */
function Backdrop({ frame }: { frame: FramingFrameBox }) {
  return (
    <>
      <rect x={0} y={0} width={W} height={H} fill="#000" />
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="#8a8a8a" />
    </>
  );
}

/** The capsule's small pictures of the two grids. */
export function FramingThumb() {
  const g = useStore((s) => s.framing);
  const on = useStore((s) => s.customGrid);
  return (
    <div className={`grid-thumbs ${on ? '' : 'off'}`} aria-hidden>
      {([0, 1] as const).map((i) => (
        <svg key={i} viewBox={`0 0 ${W} ${H}`} className="grid-thumb" data-morph={`grid-${i === 0 ? 'g3' : 'g4'}`}>
          <rect x={0} y={0} width={W} height={H} fill="#8a8a8a" />
          <FramingDrawing g={g} preset={g.presets[i]} frame={ASPECTS['3:2']} least={9} />
        </svg>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- controls

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="fr-field"><span className="fr-label">{label}</span><div className="fr-control">{children}</div></div>;
}

/** A value on a scale, with its number (typed or slid). */
function Range({ value, min, max, step = 1, unit = '', scale = 1, onChange }: { value: number; min: number; max: number; step?: number; unit?: string; scale?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = (value / scale).toFixed(step / scale < 1 ? 1 : 0);
  const commit = (s: string): void => {
    const v = Math.round(Number(s) * scale);
    if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, Math.round(v / step) * step)));
    setText(null);
  };
  return (
    <div className="fr-range">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="fr-num">
        <input type="text" inputMode="decimal" value={text ?? shown} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setText(null); }} />
        {unit && <i>{unit}</i>}
      </span>
    </div>
  );
}

const sameColour = (a: FramingColour | null, b: FramingColour | null): boolean => !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
const swatchStyle = (c: FramingColour, cell = 8): React.CSSProperties => ({
  backgroundImage: `linear-gradient(${css(c)}, ${css(c)}), repeating-conic-gradient(#c8c8c8 0 25%, #fff 0 50%)`, backgroundSize: `100% 100%, ${cell}px ${cell}px`,
});
const colourName = (c: FramingColour): string => `${hex(c).toUpperCase()} · ${Math.round((c.a / 255) * 100)}%`;

/**
 * An element's colour: the usual ones, or any colour and opacity with "custom" (or none, for a mask). `onChange`
 * says whether it was taken: the two grids together have room for eight colours.
 */
function ColourPick({ value, onChange, none }: { value: FramingColour | null; onChange: (c: FramingColour | null) => boolean; none?: boolean }) {
  const [custom, setCustom] = useState(false);
  const [full, setFull] = useState(false);
  const usual = FRAMING_SWATCHES.some((s) => sameColour(s, value));
  const editing = value !== null && (custom || !usual);
  const pick = (c: FramingColour | null): void => setFull(!onChange(c));
  return (
    <div className="fr-colours">
      <div className="fr-swatches">
        {none && <button type="button" className={`fr-swatch none ${value === null ? 'on' : ''}`} title={t('frNone')} aria-label={t('frNone')} aria-pressed={value === null} onClick={() => { setCustom(false); pick(null); }} />}
        {FRAMING_SWATCHES.map((c, i) => {
          const on = !editing && sameColour(c, value);
          return (
            <button key={i} type="button" className={`fr-swatch ${on ? 'on' : ''}`} aria-pressed={on} title={colourName(c)} aria-label={colourName(c)} onClick={() => { setCustom(false); pick(c); }}>
              <i style={swatchStyle(c)} />
            </button>
          );
        })}
        <button type="button" className={`fr-swatch custom ${editing ? 'on' : ''}`} aria-pressed={editing} title={t('frCustomColour')} aria-label={t('frCustomColour')}
          onClick={() => { if (value === null) pick(FRAMING_SWATCHES[2]); setCustom(true); }}>
          <i style={editing && value ? swatchStyle(value) : undefined} />
        </button>
      </div>
      {editing && value && (
        <div className="fr-colour-edit">
          <label className="fr-colour-input">
            <input type="color" value={hex(value)} onChange={(e) => {
              const v = e.target.value;
              pick({ r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: value.a });
            }} />
            <span>{hex(value).toUpperCase()}</span>
          </label>
          <span className="fr-label fr-opacity">{t('frOpacity')}</span>
          <Range value={Math.round((value.a / 255) * 100)} min={0} max={100} unit="%" onChange={(v) => pick({ ...value, a: Math.round((v / 100) * 255) })} />
        </div>
      )}
      {full && <p className="small fr-note bad">{t('frColoursFull')}</p>}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <Segmented<T> still value={value} onChange={onChange} options={options.map(([v, label]) => ({ value: v, label }))} />;
}

/** The picture or a frame of the preset (box 1..n); for a frame, only the frames before it (`before`). */
function WithinPick({ preset, value, before, onChange }: { preset: FramingPreset; value: number; before?: number; onChange: (v: FramingBox) => void }) {
  const frames = before ?? preset.elements.filter((e) => e.kind === 'frame').length;
  const options: [string, string][] = [['0', t('frPicture')], ...Array.from({ length: frames }, (_, k) => [String(k + 1), t('frFrame', { l: frameLetter(k + 1) })] as [string, string])];
  return <Seg value={String(value)} options={options} onChange={(v) => onChange(Number(v) as FramingBox)} />;
}

/** A ratio: the usual ones, or typed. With `onFollow` (a safe area), first "the shape of its area" (num undefined). */
function RatioPick({ num, den, onChange, onFollow }: { num?: number; den?: number; onChange: (num: number, den: number) => void; onFollow?: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseRatio(text) === null;
  const own = num !== undefined && den !== undefined;
  return (
    <div className="fr-ratios">
      {onFollow && <button type="button" className="btn small" aria-pressed={!own} onClick={() => { setText(null); onFollow(); }}>{t('frRatioFollow')}</button>}
      {RATIOS.map(([label, n, d]) => (
        <button key={label} type="button" className="btn small" aria-pressed={own && n * den === d * num} onClick={() => { setText(null); onChange(n, d); }}>{label}</button>
      ))}
      <input type="text" className={`fr-ratio-input ${bad ? 'bad' : ''}`} placeholder={t('frCustom')} value={text ?? (own ? ratioText(num, den) : '')} aria-label={t('frCustom')}
        onChange={(e) => { setText(e.target.value); const r = parseRatio(e.target.value); if (r) onChange(r[0], r[1]); }}
        onBlur={() => setText(null)} />
    </div>
  );
}

// ---------------------------------------------------------------- one element

function summary(e: FramingElement): string {
  const within = 'box' in e && e.box > 0 ? ` · ${t('frFrame', { l: frameLetter(e.box) })}` : '';
  switch (e.kind) {
    case 'frame': return `${e.num !== undefined && e.den !== undefined ? ratioText(e.num, e.den) : t('frRatioFollow')} · ${e.scale}% · ${t(e.style === 'box' ? 'frBox' : e.style === 'corners' ? 'frCorners' : 'frDashed')}${within}`;
    case 'grid': return `${e.cols} × ${e.rows}${within}`;
    case 'golden': return within.replace(/^ · /, '');
    case 'line': return `${t(e.axis === 'h' ? 'frHorizontal' : 'frVertical')} ${(e.at / 100).toFixed(1).replace(/\.0$/, '')}%${within}`;
    case 'centre': return `${t(e.mark === 'cross' ? 'frCross' : 'frDot')} ${e.size} px${within}`;
    case 'diagonals': return [e.down ? '↘' : '', e.up ? '↗' : ''].filter(Boolean).join(' ') || '—';
  }
}

function ElementFields({ g, preset, i, e }: { g: FramingGuides; preset: 0 | 1; i: number; e: FramingElement }) {
  const set = (change: Partial<FramingElement>): void => setFramingElement(preset, i, change);
  const p = g.presets[preset];
  const stroke = (
    <>
      <Field label={t('frColour')}><ColourPick value={framingColourOf(g, e)} onChange={(c) => setFramingElementColour(preset, i, 'colour', c)} /></Field>
      <Field label={t('frWidth')}><Range value={e.width} min={1} max={8} unit="px" onChange={(v) => set({ width: v })} /></Field>
    </>
  );
  const dash = 'dash' in e
    ? <Field label={t('frLineKind')}><Seg value={e.dash} options={[['solid', t('frSolid')], ['dashed', t('frDashed')]]} onChange={(v) => set({ dash: v })} /></Field>
    : null;
  const within = 'box' in e ? <Field label={t('frWithin')}><WithinPick preset={p} value={e.box} onChange={(v) => set({ box: v })} /></Field> : null;
  const outline = (style: 'box' | 'corners' | 'dashed'): ReactNode => (
    <Field label={t('frStyle')}><Seg value={style} options={[['box', t('frBox')], ['corners', t('frCorners')], ['dashed', t('frDashed')]]} onChange={(v) => set({ style: v })} /></Field>
  );
  switch (e.kind) {
    case 'frame':
      return (
        <>
          <Field label={t('frRatio')}><RatioPick num={e.num} den={e.den} onChange={(num, den) => set({ num, den })} onFollow={() => set({ num: undefined, den: undefined })} /></Field>
          <Field label={t('frSize')}><Range value={e.scale} min={1} max={100} unit="%" onChange={(v) => set({ scale: v })} /></Field>
          <Field label={t('frWithin')}><WithinPick preset={p} value={e.box} before={p.elements.slice(0, i).filter((x) => x.kind === 'frame').length} onChange={(v) => set({ box: v })} /></Field>
          <Field label={t('frMoveX')}><Range value={e.x} min={-50} max={50} unit="%" onChange={(v) => set({ x: v })} /></Field>
          <Field label={t('frMoveY')}><Range value={e.y} min={-50} max={50} unit="%" onChange={(v) => set({ y: v })} /></Field>
          {outline(e.style)}
          {e.style === 'corners' && <Field label={t('frCorner')}><Range value={e.corner} min={5} max={50} unit="%" onChange={(v) => set({ corner: v })} /></Field>}
          {stroke}
          <Field label={t('frMask')}><ColourPick none value={framingColourOf(g, e, 'mask')} onChange={(c) => setFramingElementColour(preset, i, 'mask', c)} /></Field>
        </>
      );
    case 'grid':
      return (
        <>
          <Field label={t('frCols')}><Range value={e.cols} min={1} max={10} onChange={(v) => set({ cols: v, ...(v === 1 && e.rows === 1 ? { rows: 2 } : {}) })} /></Field>
          <Field label={t('frRows')}><Range value={e.rows} min={1} max={10} onChange={(v) => set({ rows: v, ...(v === 1 && e.cols === 1 ? { cols: 2 } : {}) })} /></Field>
          {within}{dash}{stroke}
        </>
      );
    case 'golden':
      return <>{within}{dash}{stroke}</>;
    case 'line':
      return (
        <>
          <Field label={t('frAxis')}><Seg value={e.axis} options={[['h', t('frHorizontal')], ['v', t('frVertical')]]} onChange={(v) => set({ axis: v })} /></Field>
          <Field label={t('frPosition')}><Range value={e.at} min={0} max={10000} step={10} scale={100} unit="%" onChange={(v) => set({ at: v })} /></Field>
          {within}{dash}{stroke}
        </>
      );
    case 'centre':
      return (
        <>
          <Field label={t('frShape')}><Seg value={e.mark} options={[['cross', t('frCross')], ['dot', t('frDot')]]} onChange={(v) => set({ mark: v })} /></Field>
          <Field label={t('frSize')}><Range value={e.size} min={4} max={100} unit="px" onChange={(v) => set({ size: v })} /></Field>
          {within}{stroke}
        </>
      );
    case 'diagonals':
      return (
        <>
          <Field label={t('frKindDiagonals')}>
            <div className="chips">
              <button type="button" className="btn small" aria-pressed={e.down} onClick={() => set({ down: !e.down })}>{t('gridDiagDown')}</button>
              <button type="button" className="btn small" aria-pressed={e.up} onClick={() => set({ up: !e.up })}>{t('gridDiagUp')}</button>
            </div>
          </Field>
          {stroke}
        </>
      );
  }
}

/**
 * What opens and closes: its height (and its contents' opacity) moves from where it is to where it goes, so a card
 * that opens while another closes, or one clicked again half way, never jumps. With "reduce motion": at once.
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [render, setRender] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const run = useRef<Animation | null>(null);
  useEffect(() => { if (open) setRender(true); }, [open]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion() || typeof el.animate !== 'function') { if (!open) setRender(false); return; }
    // measured before anything changes it: the box is at its full height until the closing movement takes it down
    const from = run.current ? getComputedStyle(el).height : `${open ? 0 : el.offsetHeight}px`;
    const fromOpacity = run.current ? getComputedStyle(el).opacity : open ? '0' : '1';
    run.current?.cancel();
    const to = open ? `${el.scrollHeight}px` : '0px';
    el.style.overflow = 'hidden';
    // closing holds its end (fill) until the box is removed
    const a = el.animate([{ height: from, opacity: fromOpacity }, { height: to, opacity: open ? 1 : 0 }], { duration: open ? 300 : 240, easing: open ? EASE : EASE_EXIT, fill: open ? 'none' : 'forwards' });
    run.current = a;
    a.onfinish = () => {
      if (run.current !== a) return;
      run.current = null;
      el.style.overflow = '';
      if (!open) setRender(false);
    };
  }, [open, render]);
  return render ? <div ref={ref} className="fr-collapse">{children}</div> : null;
}

function ElementCard({ g, preset, i, open, onToggle }: { g: FramingGuides; preset: 0 | 1; i: number; open: boolean; onToggle: () => void }) {
  const e = g.presets[preset].elements[i];
  const colour = framingColourOf(g, e)!;
  const letter = e.kind === 'frame' ? frameLetter(g.presets[preset].elements.slice(0, i + 1).filter((x) => x.kind === 'frame').length) : '';
  return (
    <div className={`fr-el ${open ? 'open' : ''}`}>
      <div className="fr-el-head">
        <button type="button" className="fr-el-toggle" aria-expanded={open} onClick={onToggle}>
          <i className="fr-el-swatch" style={swatchStyle(colour, 6)} />
          <b>{t(KIND_NAMES[e.kind])}{letter && ` ${letter}`}</b>
          <span className="muted small ellipsis">{summary(e)}</span>
          <span className="fr-el-chev" aria-hidden>{Ico.down}</span>
        </button>
        <button type="button" className="btn ghost icon-only mini" title={t('frRemove')} aria-label={t('frRemove')} onClick={() => removeFramingElement(preset, i)}>{Ico.trash}</button>
      </div>
      <Collapse open={open}><div className="fr-el-body"><ElementFields g={g} preset={preset} i={i} e={e} /></div></Collapse>
    </div>
  );
}

// ---------------------------------------------------------------- templates

function TemplatePick({ preset, onApplied }: { preset: 0 | 1; onApplied: () => void }) {
  const [full, setFull] = useState(false);
  useEffect(() => { setFull(false); }, [preset]);
  return (
    <div className="fr-templates">
      <div className="fr-templates-head"><span className="fr-label">{t('frTemplates')}</span></div>
      <div className="fr-template-list">
        {FRAMING_TEMPLATES.map((tpl: FramingTemplate) => (
          <button key={tpl.id} type="button" className="fr-template" onClick={() => { const ok = applyFramingTemplate(preset, tpl.id); setFull(!ok); if (ok) onApplied(); }}>
            <svg viewBox={`0 0 ${W} ${H}`} aria-hidden>
              <rect x={0} y={0} width={W} height={H} fill="#8a8a8a" />
              <FramingDrawing g={templateGuides(tpl)} preset={{ elements: tpl.elements }} frame={ASPECTS['3:2']} least={9} />
            </svg>
            <span>{t(TEMPLATE_NAMES[tpl.id])}</span>
          </button>
        ))}
      </div>
      {full && <p className="small fr-note bad">{t('frColoursFull')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- the editor

/** The grid shown in the editor (kept while the program runs; pages/grid.tsx moves its picture into the capsule). */
export function FramingEditor({ preset, setPreset }: { preset: 0 | 1; setPreset: (p: 0 | 1) => void }) {
  const g = useStore((s) => s.framing);
  const ratios = useStore((s) => s.ratios);
  const [aspect, setAspect] = useState<string>('3:2');
  const [open, setOpen] = useState<number>(-1);
  const p = g.presets[preset];
  // the camera's own aspects, then the added ratios as the camera shows them (their window on the screen)
  const aspects = useMemo(() => {
    const list: { value: string; label: string; frame: FramingFrameBox }[] = Object.entries(ASPECTS).map(([k, f]) => ({ value: k, label: k, frame: f }));
    for (const r of ratios) {
      const sc = r.preview?.screen;
      if (sc && sc.width > 0 && sc.height > 0) list.push({ value: `r:${r.id}`, label: ratioName(r), frame: { x: sc.left, y: sc.top, w: sc.width, h: sc.height } });
    }
    return list;
  }, [ratios]);
  const shown = aspects.find((a) => a.value === aspect) ?? aspects[0];
  const frame = shown.frame;
  useEffect(() => { setOpen(-1); }, [preset]);
  const problem = framingProblem(g);
  const pieces = compilePreset(p).records.length;
  const same = isCameraPreset(g, preset);
  return (
    <div className="grid-edit fr">
      <div className="fr-tools">
        <Segmented<'0' | '1'> still value={String(preset) as '0' | '1'} onChange={(v) => setPreset(Number(v) as 0 | 1)} options={[{ value: '0', label: t('frPreset', { n: 1 }) }, { value: '1', label: t('frPreset', { n: 2 }) }]} />
        <span className="grow" />
        <span className="muted small">{t('frPreviewAs')}</span>
        <Segmented<string> still value={shown.value} onChange={setAspect} options={aspects.map((a) => ({ value: a.value, label: a.label }))} />
      </div>
      <div className="fr-body">
        <div className="fr-view">
          <svg viewBox={`0 0 ${W} ${H}`} className="grid-edit-preview fr-preview">
            <Backdrop frame={frame} />
            {/* at least 1.5 units: the picture is shown smaller than the camera's 720 x 480, where a 1 px line would vanish */}
            <FramingDrawing g={g} preset={p} frame={frame} least={1.5} />
          </svg>
          <TemplatePick preset={preset} onApplied={() => setOpen(-1)} />
        </div>
        <div className="fr-side">
          {same && <p className="muted small fr-note">{t('frSame', { g: t(preset === 0 ? 'grid3' : 'grid4') })}</p>}
          {pieces > FRAMING_MAX_RECORDS && <p className="small fr-note bad">{t('frTooMany', { n: pieces, m: FRAMING_MAX_RECORDS })}</p>}
          {problem && pieces <= FRAMING_MAX_RECORDS && <p className="small fr-note bad">{problem}</p>}
          {p.elements.length === 0 && <p className="muted small fr-note">{t('frEmpty')}</p>}
          <div className="fr-list">
            {p.elements.map((_, i) => <ElementCard key={i} g={g} preset={preset} i={i} open={open === i} onToggle={() => setOpen(open === i ? -1 : i)} />)}
          </div>
          <div className="fr-add">
            <span className="fr-label">{t('frAdd')}</span>
            <div className="chips">
              {FRAMING_KINDS.map((k) => (
                <button key={k} type="button" className="btn small" disabled={!canAdd(p, k)} onClick={() => { addFramingElement(preset, k); setOpen(p.elements.length); }}>{Ico.plus}{t(KIND_NAMES[k])}</button>
              ))}
            </div>
          </div>
          {!same && <button type="button" className="btn small fr-reset" onClick={() => { resetFramingPreset(preset); setOpen(-1); }}>{t('frReset')}</button>}
        </div>
      </div>
      <p className="muted small">{t('frHint')}</p>
    </div>
  );
}
