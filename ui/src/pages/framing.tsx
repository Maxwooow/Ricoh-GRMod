/**
 * The framing guides' editor (GR IV 1.20 / 1.21): two grids of elements (frame lines, grids, golden section, single
 * lines, safe areas, centre marks, diagonals) in colours of a palette of eight, on the custom grid's page.
 *
 * The preview draws exactly the rectangles the camera fills (core `framingRects`, the same integer arithmetic as
 * the firmware), on the picture the camera shows for a chosen aspect (its own 3:2, 1:1, 4:3, 16:9). Nothing in the
 * editing controls moves: values change at once.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FRAMING_MAX_RECORDS, compilePreset, framingProblem, framingRects, isCameraPreset } from '@grmod/core';
import type { FramingColour, FramingElement, FramingFrameBox, FramingGuides, FramingPreset } from '@grmod/core';
import { Ico, Segmented } from '../components';
import { t } from '../i18n';
import type { Key } from '../i18n';
import {
  FRAMING_KINDS, addFramingElement, canAdd, frameLetter, previewPhoto, removeFramingElement, resetFramingPreset, setFramingColour, setFramingElement,
  setRatioBackdrop, useStore,
} from '../store';
import type { FramingKind } from '../store';

const W = 720;
const H = 480;
/** The grid view's frame for the camera's own aspects (tools/gr4v120/framing/check.py uses the same). */
const ASPECTS = { '3:2': { x: 0, y: 0, w: 720, h: 480 }, '1:1': { x: 120, y: 0, w: 480, h: 480 }, '4:3': { x: 40, y: 0, w: 640, h: 480 }, '16:9': { x: 0, y: 38, w: 720, h: 404 } } as const;
type Aspect = keyof typeof ASPECTS;

const KIND_NAMES: Record<FramingKind, Key> = {
  frame: 'frKindFrame', grid: 'frKindGrid', golden: 'frKindGolden', line: 'frKindLine', safe: 'frKindSafe', centre: 'frKindCentre', diagonals: 'frKindDiagonals',
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

/** The photo as a data URL for the SVG (once per photo). */
function usePhotoUrl(): string | null {
  const rev = useStore((s) => s.photoRev);
  return useMemo(() => {
    const p = previewPhoto();
    if (!p) return null;
    const c = document.createElement('canvas');
    c.width = p.width; c.height = p.height;
    c.getContext('2d')!.putImageData(p, 0, 0);
    return c.toDataURL('image/jpeg', 0.85);
  }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** What the camera draws for preset `i` on a picture: the rectangles it fills, the diagonals it lays out. */
export function FramingDrawing({ g, preset, frame }: { g: FramingGuides; preset: FramingPreset; frame: FramingFrameBox }) {
  const c = useMemo(() => compilePreset(preset), [preset]);
  const rects = useMemo(() => framingRects(c, frame), [c, frame]);
  return (
    <>
      {rects.map((r, k) => <rect key={k} x={r.x} y={r.y} width={r.w} height={r.h} fill={css(g.palette[r.colour])} shapeRendering="crispEdges" />)}
      {c.diagonals.map((d, k) => (d
        ? <line key={`d${k}`} x1={frame.x} y1={k === 0 ? frame.y : frame.y + frame.h} x2={frame.x + frame.w} y2={k === 0 ? frame.y + frame.h : frame.y} stroke={css(g.palette[d.colour])} strokeWidth={d.width} />
        : null))}
    </>
  );
}

/** The picture behind the guides: the photo or the camera's grey, black outside the camera's aspect. */
function Backdrop({ frame, photo }: { frame: FramingFrameBox; photo: string | null }) {
  return (
    <>
      <rect x={0} y={0} width={W} height={H} fill="#000" />
      {photo
        ? <image href={photo} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid slice" clipPath="url(#fr-clip)" />
        : <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="#8a8a8a" />}
      <defs><clipPath id="fr-clip"><rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} /></clipPath></defs>
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
          <FramingDrawing g={g} preset={g.presets[i]} frame={ASPECTS['3:2']} />
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

/** A colour of the palette (or none, for a mask). */
function ColourPick({ g, value, onChange, none }: { g: FramingGuides; value: number | null; onChange: (v: number | null) => void; none?: boolean }) {
  return (
    <div className="fr-swatches">
      {none && <button type="button" className={`fr-swatch none ${value === null ? 'on' : ''}`} title={t('frNone')} aria-label={t('frNone')} aria-pressed={value === null} onClick={() => onChange(null)} />}
      {g.palette.map((c, i) => (
        <button key={i} type="button" className={`fr-swatch ${value === i ? 'on' : ''}`} aria-pressed={value === i} aria-label={`${t('frColour')} ${i + 1}`} onClick={() => onChange(i)}>
          <i style={{ backgroundImage: `linear-gradient(${css(c)}, ${css(c)}), repeating-conic-gradient(#c8c8c8 0 25%, #fff 0 50%)`, backgroundSize: '100% 100%, 8px 8px' }} />
        </button>
      ))}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <Segmented<T> still value={value} onChange={onChange} options={options.map(([v, label]) => ({ value: v, label }))} />;
}

/** The picture or one of the frame lines before... any frame line of the preset (box 1..n). */
function WithinPick({ preset, value, onChange }: { preset: FramingPreset; value: number; onChange: (v: 0 | 1 | 2 | 3) => void }) {
  const frames = preset.elements.filter((e) => e.kind === 'frame').length;
  const options: [string, string][] = [['0', t('frPicture')], ...Array.from({ length: frames }, (_, k) => [String(k + 1), t('frFrame', { l: frameLetter(k + 1) })] as [string, string])];
  return <Seg value={String(value)} options={options} onChange={(v) => onChange(Number(v) as 0 | 1 | 2 | 3)} />;
}

/** A frame line's ratio: the usual ones, or typed. */
function RatioPick({ num, den, onChange }: { num: number; den: number; onChange: (num: number, den: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseRatio(text) === null;
  return (
    <div className="fr-ratios">
      {RATIOS.map(([label, n, d]) => (
        <button key={label} type="button" className="btn small" aria-pressed={n * den === d * num} onClick={() => { setText(null); onChange(n, d); }}>{label}</button>
      ))}
      <input type="text" className={`fr-ratio-input ${bad ? 'bad' : ''}`} placeholder={t('frCustom')} value={text ?? ratioText(num, den)} aria-label={t('frCustom')}
        onChange={(e) => { setText(e.target.value); const r = parseRatio(e.target.value); if (r) onChange(r[0], r[1]); }}
        onBlur={() => setText(null)} />
    </div>
  );
}

// ---------------------------------------------------------------- one element

function summary(e: FramingElement): string {
  const within = 'box' in e && e.box > 0 ? ` · ${t('frFrame', { l: frameLetter(e.box) })}` : '';
  switch (e.kind) {
    case 'frame': return `${ratioText(e.num, e.den)} · ${e.scale}% · ${t(e.style === 'box' ? 'frBox' : e.style === 'corners' ? 'frCorners' : 'frDashed')}`;
    case 'grid': return `${e.cols} × ${e.rows}${within}`;
    case 'golden': return within.replace(/^ · /, '');
    case 'line': return `${t(e.axis === 'h' ? 'frHorizontal' : 'frVertical')} ${(e.at / 100).toFixed(1).replace(/\.0$/, '')}%${within}`;
    case 'safe': return `${e.percent}%${within}`;
    case 'centre': return `${t(e.mark === 'cross' ? 'frCross' : 'frDot')} ${e.size} px${within}`;
    case 'diagonals': return [e.down ? '↘' : '', e.up ? '↗' : ''].filter(Boolean).join(' ') || '—';
  }
}

function ElementFields({ g, preset, i, e }: { g: FramingGuides; preset: 0 | 1; i: number; e: FramingElement }) {
  const set = (change: Partial<FramingElement>): void => setFramingElement(preset, i, change);
  const p = g.presets[preset];
  const stroke = (
    <>
      <Field label={t('frColour')}><ColourPick g={g} value={e.colour} onChange={(v) => set({ colour: v ?? 0 })} /></Field>
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
          <Field label={t('frRatio')}><RatioPick num={e.num} den={e.den} onChange={(num, den) => set({ num, den })} /></Field>
          <Field label={t('frSize')}><Range value={e.scale} min={30} max={100} unit="%" onChange={(v) => set({ scale: v })} /></Field>
          <Field label={t('frMoveX')}><Range value={e.x} min={-50} max={50} unit="%" onChange={(v) => set({ x: v })} /></Field>
          <Field label={t('frMoveY')}><Range value={e.y} min={-50} max={50} unit="%" onChange={(v) => set({ y: v })} /></Field>
          {outline(e.style)}
          {e.style === 'corners' && <Field label={t('frCorner')}><Range value={e.corner} min={5} max={50} unit="%" onChange={(v) => set({ corner: v })} /></Field>}
          {stroke}
          <Field label={t('frMask')}><ColourPick g={g} none value={e.mask} onChange={(v) => set({ mask: v })} /></Field>
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
    case 'safe':
      return (
        <>
          <Field label={t('frSize')}><Range value={e.percent} min={50} max={99} unit="%" onChange={(v) => set({ percent: v })} /></Field>
          {within}{outline(e.style)}{stroke}
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

function ElementCard({ g, preset, i, open, onToggle }: { g: FramingGuides; preset: 0 | 1; i: number; open: boolean; onToggle: () => void }) {
  const e = g.presets[preset].elements[i];
  const letter = e.kind === 'frame' ? frameLetter(g.presets[preset].elements.slice(0, i + 1).filter((x) => x.kind === 'frame').length) : '';
  return (
    <div className={`fr-el ${open ? 'open' : ''}`}>
      <div className="fr-el-head">
        <button type="button" className="fr-el-toggle" aria-expanded={open} onClick={onToggle}>
          <i className="fr-el-swatch" style={{ backgroundImage: `linear-gradient(${css(g.palette[e.colour])}, ${css(g.palette[e.colour])}), repeating-conic-gradient(#c8c8c8 0 25%, #fff 0 50%)`, backgroundSize: '100% 100%, 6px 6px' }} />
          <b>{t(KIND_NAMES[e.kind])}{letter && ` ${letter}`}</b>
          <span className="muted small ellipsis">{summary(e)}</span>
          <span className="fr-el-chev" aria-hidden>{open ? Ico.up : Ico.down}</span>
        </button>
        <button type="button" className="btn ghost icon-only mini" title={t('frRemove')} aria-label={t('frRemove')} onClick={() => removeFramingElement(preset, i)}>{Ico.trash}</button>
      </div>
      {open && <div className="fr-el-body"><ElementFields g={g} preset={preset} i={i} e={e} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- the palette

function PaletteEditor({ g }: { g: FramingGuides }) {
  const [sel, setSel] = useState<number | null>(null);
  const c = sel === null ? null : g.palette[sel];
  return (
    <div className="fr-palette">
      <div className="fr-palette-row">
        <span className="fr-label">{t('frPalette')}</span>
        <ColourPick g={g} value={sel} onChange={(v) => setSel(v === sel ? null : v)} />
      </div>
      {c && sel !== null && (
        <div className="fr-palette-edit">
          <label className="fr-colour-input"><input type="color" value={hex(c)} onChange={(e) => {
            const v = e.target.value;
            setFramingColour(sel, { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: c.a });
          }} /><span>{hex(c).toUpperCase()}</span></label>
          <Field label={t('frOpacity')}><Range value={Math.round((c.a / 255) * 100)} min={0} max={100} unit="%" onChange={(v) => setFramingColour(sel, { ...c, a: Math.round((v / 100) * 255) })} /></Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the editor

/** The grid shown in the editor (kept while the program runs; pages/grid.tsx moves its picture into the capsule). */
export function FramingEditor({ preset, setPreset }: { preset: 0 | 1; setPreset: (p: 0 | 1) => void }) {
  const g = useStore((s) => s.framing);
  const backdrop = useStore((s) => s.ratioBackdrop);
  const [aspect, setAspect] = useState<Aspect>('3:2');
  const [open, setOpen] = useState<number>(-1);
  const photo = usePhotoUrl();
  const p = g.presets[preset];
  const frame = ASPECTS[aspect];
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
        <Segmented<Aspect> still value={aspect} onChange={setAspect} options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: a }))} />
        {photo && <Segmented<'photo' | 'gray'> still value={backdrop} onChange={setRatioBackdrop} options={[{ value: 'photo', label: t('previewPhoto') }, { value: 'gray', label: t('ratioGray') }]} />}
      </div>
      <div className="fr-body">
        <div className="fr-view">
          <svg viewBox={`0 0 ${W} ${H}`} className="grid-edit-preview fr-preview">
            <Backdrop frame={frame} photo={backdrop === 'photo' ? photo : null} />
            <FramingDrawing g={g} preset={p} frame={frame} />
          </svg>
          <PaletteEditor g={g} />
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
