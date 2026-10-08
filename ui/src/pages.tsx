import { useEffect, useMemo, useRef, useState } from 'react';
import { color, MAX_CUSTOM_RATIOS, SHUTDOWN_H, SHUTDOWN_W } from '@grmod/core';
import type { SlotId } from '@grmod/core';
import { DropZone, FileButton, Ico, IconCanvas, Menu, Prop, RatioIcon, RgbCanvas, Segmented, Switch } from './components';
import { FirmwareHero } from './firmware';
import { t } from './i18n';
import type { Key } from './i18n';
import type { Crop } from './pixels';
import { onUiScale, uiScale } from './fit';
import { applySlot } from './preview';
import {
  addFactoryWall, addRatio, addWallFiles, loadFirmwareFile, loadIconImage, loadPresetFile, loadPreviewFile, moveWall, nameProblem, openCrop, outputFirmware, previewPhoto, removePreset, removeWall,
  ratioName, ratioProblem, removeRatio, setActiveRatio, setActiveSlot, setCrop, setIcon, setName, setPreviewMode, setRatio, setRatioBackdrop, useStore, wallBitmap,
  setSoft,
} from './store';
import type { RatioItem, WallItem } from './store';

const isPreset = (f: File): boolean => /\.(xmp|cube)$/i.test(f.name);
const isFirmware = (f: File): boolean => /\.bin$/i.test(f.name);
const isImage = (f: File): boolean => /^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp|gif|avif)$/i.test(f.name);

// 24 reference patches (sRGB), shown before / after a preset
const CC24 = [[115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170], [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161], [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52]];

function Swatches({ params }: { params?: color.SlotParams }) {
  const out = useMemo(() => {
    if (!params) return null;
    const inp = new Float64Array(CC24.length * 3);
    CC24.forEach((c, i) => { inp[i * 3] = c[0] / 255; inp[i * 3 + 1] = c[1] / 255; inp[i * 3 + 2] = c[2] / 255; });
    const o = color.previewSlot(params, inp);
    return CC24.map((_, i) => `rgb(${Math.round(o[i * 3] * 255)},${Math.round(o[i * 3 + 1] * 255)},${Math.round(o[i * 3 + 2] * 255)})`);
  }, [params]);
  return (
    <div className="swatches" aria-hidden>
      {CC24.map((c, i) => {
        const before = `rgb(${c[0]},${c[1]},${c[2]})`;
        return <span key={i} className="swatch"><i style={{ background: before }} /><i style={{ background: out ? out[i] : before }} /></span>;
      })}
    </div>
  );
}

/** The sample photograph with the original on the left of a draggable divider and the preset on the right. */
function PhotoCompare({ params }: { params?: color.SlotParams }) {
  const photo = usePhoto();
  const after = useMemo(() => (photo && params ? applySlot(params, photo) : null), [photo, params]);
  return <Compare photo={photo} after={after} label={t('preset')} />;
}

function usePhoto(): ImageData | null {
  const rev = useStore((s) => s.photoRev);
  return useMemo(() => previewPhoto(), [rev]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** `photo` on the left of a draggable divider, `after` (labelled `label`) on the right. */
function Compare({ photo, after, label }: { photo: ImageData | null; after: ImageData | null; label: string }) {
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0.5);
  const dragging = useRef(false);
  useEffect(() => {
    const c = beforeRef.current;
    if (!c || !photo) return;
    c.width = photo.width; c.height = photo.height; c.getContext('2d')!.putImageData(photo, 0, 0);
  }, [photo]);
  useEffect(() => {
    const c = afterRef.current;
    if (!c || !after) return;
    c.width = after.width; c.height = after.height; c.getContext('2d')!.putImageData(after, 0, 0);
  }, [after]);
  if (!photo) {
    return <FileButton className="compare-empty" accept="image/*" onFiles={(f) => { void loadPreviewFile(f[0]); }}>{Ico.image}<span>{t('choosePhoto')}</span></FileButton>;
  }
  const at = (clientX: number): void => {
    const r = boxRef.current?.getBoundingClientRect();
    if (r && r.width > 0) setPos(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
  };
  const pct = `${(pos * 100).toFixed(2)}%`;
  return (
    <div
      ref={boxRef} className={`compare ${after ? '' : 'plain'}`} style={{ '--ar': String(photo.width / photo.height) } as React.CSSProperties}
      onPointerDown={(e) => { if (!after || (e.target as HTMLElement).closest('button')) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); dragging.current = true; at(e.clientX); }}
      onPointerMove={(e) => { if (dragging.current) at(e.clientX); }}
      onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
      onDoubleClick={() => setPos(0.5)}
    >
      {after && <canvas ref={afterRef} className="compare-img" />}
      <canvas ref={beforeRef} className="compare-img" style={after ? { clipPath: `inset(0 ${(100 - pos * 100).toFixed(2)}% 0 0)` } : undefined} />
      {after && (
        <>
          <span className="compare-tag l" style={{ opacity: pos < 0.16 ? 0 : 1 }}>{t('original')}</span>
          <span className="compare-tag r" style={{ opacity: pos > 0.84 ? 0 : 1 }}>{label}</span>
          <div
            className="compare-line" style={{ left: pct }} role="slider" tabIndex={0} aria-label={t('compare')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos * 100)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.02;
              if (e.key === 'ArrowLeft') { e.preventDefault(); setPos((p) => Math.max(0, p - step)); }
              else if (e.key === 'ArrowRight') { e.preventDefault(); setPos((p) => Math.min(1, p + step)); }
              else if (e.key === 'Home') { e.preventDefault(); setPos(0); } else if (e.key === 'End') { e.preventDefault(); setPos(1); }
            }}
          ><span className="compare-knob"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 6L4 10l3.5 4M12.5 6L16 10l-3.5 4" /></svg></span></div>
        </>
      )}
      <FileButton className="btn mini compare-swap" accept="image/*" title={t('changePhoto')} onFiles={(f) => { void loadPreviewFile(f[0]); }}>{Ico.image}</FileButton>
    </div>
  );
}

/** The one preview of the page: it shows whichever slot is active and fills the space the window leaves. */
function PreviewPane() {
  const mode = useStore((s) => s.previewMode);
  const active = useStore((s) => s.activeSlot);
  const params = useStore((s) => s.slots[s.activeSlot].preset?.result?.params);
  return (
    <DropZone className="pane" accept={isImage} onFiles={(f) => { void loadPreviewFile(f[0]); }}>
      <div className="pane-head">
        <Segmented tour="ic-tabs" value={active} onChange={setActiveSlot} options={[{ value: 'CY', label: t('slotCY') }, { value: 'CG', label: t('slotCG') }]} />
        <span className="grow" />
        <Segmented tour="ic-mode" value={mode} onChange={setPreviewMode} options={[{ value: 'photo', label: t('previewPhoto') }, { value: 'swatch', label: t('previewSwatch') }]} />
      </div>
      <div className="pane-body" data-tour="ic-preview" data-tour-fit="">{mode === 'photo' ? <PhotoCompare params={params} /> : <Swatches params={params} />}</div>
    </DropZone>
  );
}

function SlotCard({ id }: { id: SlotId }) {
  const slot = useStore((s) => s.slots[id]);
  const info = useStore((s) => s.info)!;
  const lang = useStore((s) => s.lang);
  const active = useStore((s) => s.activeSlot === id);
  const off = info.slots.find((x) => x.id === id)!;
  const name = slot.names[lang] ?? '';
  const cap = off.names[lang].capacity;
  const problem = nameProblem(info, id, lang, name);
  const p = slot.preset;
  const first = id === 'CY'; // the one the tour points at
  return (
    <DropZone className={`card ${active ? 'on' : ''}`} tour={first ? 'ic-slot' : undefined} accept={isPreset} onFiles={(f) => { void loadPresetFile(id, f[0]); }}>
      <div className="card-in" onPointerDownCapture={() => setActiveSlot(id)} onFocusCapture={() => setActiveSlot(id)}>
        <div className="card-head">
          <IconCanvas pixels={slot.icon.mode !== 'keep' && slot.icon.pixels ? slot.icon.pixels : off.icon} />
          <div className="card-title" data-tour={first ? 'ic-name' : undefined}>
            <input className={`title-input ${problem ? 'bad' : ''}`} value={name} placeholder={off.names[lang].text} spellCheck={false} aria-label={t('name')} onChange={(e) => setName(id, lang, e.target.value)} />
            <div className="sub">
              <span className="ellipsis">{t(('slot' + id) as Key)}</span>
              <span className={`count ${problem ? 'bad' : ''}`}>{problem || `${name.length || off.names[lang].text.length}/${cap}`}</span>
            </div>
          </div>
        </div>
        <div className="props">
          <Prop label={t('preset')} tour={first ? 'ic-preset' : undefined}>
            {!p && <FileButton className="btn dashed fill" accept=".xmp,.cube" onFiles={(f) => { void loadPresetFile(id, f[0]); }}>{Ico.plus}<span>{t('dropPreset')}</span></FileButton>}
            {p && (
              <div className="preset">
                <div className={`file-chip ${p.error ? 'bad' : ''}`}>
                  <FileButton className="file-main" accept=".xmp,.cube" title={t('replace')} onFiles={(f) => { void loadPresetFile(id, f[0]); }}>{Ico.file}<span className="ellipsis">{p.result?.title || p.fileName}</span></FileButton>
                  <button className="file-x" title={t('remove')} aria-label={t('remove')} onClick={() => removePreset(id)}>{Ico.x}</button>
                </div>
                {(p.busy || p.error || p.result) && (
                  <div className="chips">
                    {p.busy && <span className="chip muted"><span className="spinner small" />{t('converting')}</span>}
                    {p.error && <span className="chip bad" title={p.error}><span className="ellipsis">{p.error}</span></span>}
                    {p.result && <span className="chip" title="CIE76">{t('deltaE')} {p.result.meanDE.toFixed(1)}</span>}
                    {p.result && p.result.unsupported.length > 0 && <span className="chip warn" title={p.result.unsupported.join(', ')}>{t('warnUnsupported')} {p.result.unsupported.length}</span>}
                    {p.result && p.result.warnings.length > 0 && <span className="chip warn" title={p.result.warnings.join(', ')}>{t('warnApprox')}</span>}
                  </div>
                )}
              </div>
            )}
          </Prop>
          <Prop label={t('icon')} tour={first ? 'ic-icon' : undefined}>
            <div className="chips">
              <Segmented value={slot.icon.mode} onChange={(mode) => setIcon(id, { mode })} options={[{ value: 'keep', label: t('iconKeep') }, { value: 'text', label: t('iconText') }, { value: 'image', label: t('iconImage') }]} />
              {slot.icon.mode !== 'keep' && <Segmented value={slot.icon.style} onChange={(style) => setIcon(id, { style })} options={[{ value: 'film', label: t('styleFilm') }, { value: 'plain', label: t('stylePlain') }]} />}
              {slot.icon.mode === 'text' && <input className="input short" value={slot.icon.text} maxLength={8} spellCheck={false} placeholder="400" aria-label={t('iconText')} onChange={(e) => setIcon(id, { text: e.target.value })} />}
              {slot.icon.mode === 'image' && <FileButton className="btn small" accept="image/*" onFiles={(f) => { void loadIconImage(id, f[0]); }}>{t('chooseImage')}</FileButton>}
            </div>
          </Prop>
        </div>
      </div>
    </DropZone>
  );
}

/** Soft focus: on or off; on puts it on the ADJ lever with fixed strengths (off / weak / medium / strong). */
function SoftSwitch() {
  const on = useStore((s) => s.soft);
  return (
    <div className={`card soft-switch ${on ? 'on' : ''}`} data-tour="ic-soft">
      <span className="page-icon soft-ico">{Ico.soft}</span>
      <div className="soft-text">
        <b>{t('navSoft')}</b>
        <span className="muted small ellipsis">{t('softAdjSub')}</span>
      </div>
      <Switch checked={on} onChange={setSoft} label={t('navSoft')} />
    </div>
  );
}

export function ImageControlPage() {
  const info = useStore((s) => s.info);
  const fwName = useStore((s) => s.fwName);
  const model = useStore((s) => s.model);
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.aperture}</span>
        <h1>{t('navIC')}</h1>
        {info && (
          <div className="head-right" data-tour="ic-stock">
            <span className="chip ok">{Ico.check}<span className="ellipsis">{fwName || 'fwdc248b.bin'} · {info.version}</span></span>
            <Menu items={[
              { label: t('writeStock'), run: () => { void outputFirmware({ kind: 'card' }, true); } },
              { label: t('exportStock'), run: () => { void outputFirmware({ kind: 'folder' }, true); } },
            ]}>{Ico.more}</Menu>
          </div>
        )}
      </header>
      {!info && <FirmwareHero />}
      {info && model !== 'MONO' && (
        <div className="ic" data-tour-page="ic">
          <div className="cards"><SlotCard id="CY" /><SlotCard id="CG" /><SoftSwitch /></div>
          <PreviewPane />
        </div>
      )}
      {info && model === 'MONO' && <div className="mono-ic" data-tour-page="ic"><p className="muted">{t('monoNoSlots')}</p><SoftSwitch /></div>}
    </DropZone>
  );
}

// ---------------------------------------------------------------- added aspect ratios
// in the camera's menu order
const FACTORY_RATIOS = ['3:2', '4:3', '1:1', '16:9'];
const COMMON_RATIOS = ['65:24', '2.39:1', '2:1', '5:4', '7:6', '4:5'];
const size = (s: [number, number]): string => `${s[0]}×${s[1]}`;

function RatioRow({ r, active, tour }: { r: RatioItem; active: boolean; tour?: string }) {
  const problem = ratioProblem(r);
  const p = r.preview;
  const busy = !!r.ratio.trim() && !p;
  return (
    <div className={`ratio-row ${active ? 'on' : ''}`} data-tour={tour} onPointerDownCapture={() => setActiveRatio(r.id)} onFocusCapture={() => setActiveRatio(r.id)}>
      <RatioIcon pixels={p?.icon} width={48} />
      <input
        className={`input ratio-in ${p?.problem ? 'bad' : ''}`} value={r.ratio} maxLength={16} spellCheck={false} placeholder={t('ratioPlaceholder')} aria-label={t('navRatio')}
        autoFocus={!r.ratio} onChange={(e) => setRatio(r.id, { ratio: e.target.value.replace(/[^0-9:.：/xX×]/g, '').replace(/[：/xX×]/g, ':') })}
      />
      <input
        className={`input ratio-name ${problem && !p?.problem ? 'bad' : ''}`} value={r.name} maxLength={24} spellCheck={false} placeholder={p?.label || t('name')} aria-label={t('name')}
        onChange={(e) => setRatio(r.id, { name: e.target.value })}
      />
      <span className={`ratio-size ${problem ? 'bad' : ''}`} title={problem || undefined}>
        {busy ? <span className="spinner small" /> : problem ? <span className="ellipsis">{problem}</span> : p?.sizes ? size(p.sizes[0]) : ''}
      </span>
      <button className="btn ghost icon-only ratio-x" title={t('remove')} aria-label={t('remove')} onClick={() => removeRatio(r.id)}>{Ico.x}</button>
    </div>
  );
}

/** The 3:2 picture area with the part an added ratio keeps; the rest is what the camera masks. */
function RatioPane({ r }: { r?: RatioItem }) {
  const rev = useStore((s) => s.photoRev);
  const backdrop = useStore((s) => s.ratioBackdrop);
  const photo = useMemo(() => previewPhoto(), [rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLCanvasElement>(null);
  const showPhoto = backdrop === 'photo' && !!photo;
  useEffect(() => {
    const c = ref.current;
    if (!c || !photo || !showPhoto) return;
    c.width = photo.width; c.height = photo.height; c.getContext('2d')!.putImageData(photo, 0, 0);
  }, [photo, showPhoto]);
  const p = r?.preview;
  const sc = p?.screen;
  const pct = (v: number, of: number): string => `${((v / of) * 100).toFixed(3)}%`;
  const labels = ['L', 'M', 'S', 'XS'];
  return (
    <DropZone className="pane ratio-pane" accept={isImage} onFiles={(f) => { void loadPreviewFile(f[0]); }}>
      <div className="pane-head">
        {p?.icon && r && <><RatioIcon pixels={p.icon} width={42} /><b className="ratio-title ellipsis">{ratioName(r)}</b></>}
        <span className="grow" />
        <Segmented tour="ratio-backdrop" value={backdrop} onChange={setRatioBackdrop} options={[{ value: 'photo', label: t('previewPhoto') }, { value: 'gray', label: t('ratioGray') }]} />
      </div>
      <div className="ratio-body" data-tour="ratio-frame" data-tour-fit="">
        <div className={`ratio-frame ${showPhoto ? '' : 'gray'}`}>
          {showPhoto && <canvas ref={ref} className="ratio-photo" />}
          {sc && (
            <>
              <div className="ratio-shade" style={{ left: 0, top: 0, width: '100%', height: pct(sc.top, 480) }} />
              <div className="ratio-shade" style={{ left: 0, bottom: 0, width: '100%', height: pct(480 - sc.top - sc.height, 480) }} />
              <div className="ratio-shade" style={{ left: 0, top: pct(sc.top, 480), width: pct(sc.left, 720), height: pct(sc.height, 480) }} />
              <div className="ratio-shade" style={{ right: 0, top: pct(sc.top, 480), width: pct(720 - sc.left - sc.width, 720), height: pct(sc.height, 480) }} />
              <div className="ratio-window" style={{ left: pct(sc.left, 720), top: pct(sc.top, 480), width: pct(sc.width, 720), height: pct(sc.height, 480) }} />
            </>
          )}
          {showPhoto && <FileButton className="btn mini compare-swap" accept="image/*" title={t('changePhoto')} onFiles={(f) => { void loadPreviewFile(f[0]); }}>{Ico.image}</FileButton>}
        </div>
        <div className={`chips ratio-out ${p?.sizes ? 'sizes' : ''}`}>
          {p?.sizes && p.sizes.map((s, i) => <span key={i} className="chip"><b>{labels[i]}</b>{size(s)}</span>)}
          {p?.problem && <span className="chip bad">{r ? ratioProblem(r) : ''}</span>}
          {p?.problem && r && (p.nearest || []).map((n) => <button key={n} className="btn small" onClick={() => setRatio(r.id, { ratio: n })}>{n}</button>)}
        </div>
      </div>
    </DropZone>
  );
}

export function RatioPage() {
  const info = useStore((s) => s.info);
  const ratios = useStore((s) => s.ratios);
  const activeId = useStore((s) => s.activeRatio);
  const active = ratios.find((r) => r.id === activeId) || ratios[0];
  const full = ratios.length >= MAX_CUSTOM_RATIOS;
  const used = new Set(ratios.map((r) => r.ratio.trim()));
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.ratio}</span>
        <h1>{t('navRatio')}</h1>
        {info && <div className="head-right"><span className="chip">{ratios.filter((r) => r.ratio.trim()).length}/{MAX_CUSTOM_RATIOS}</span></div>}
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="ratio" data-tour-page="ratio">
          <div className="ratio-list">
            <div className="ratio-factory" data-tour="ratio-factory">
              <span className="muted small">{t('ratioFactory')}</span>
              {FACTORY_RATIOS.map((f) => <span key={f} className="chip muted">{f}</span>)}
            </div>
            {ratios.map((r, i) => <RatioRow key={r.id} r={r} active={r.id === active?.id} tour={i === 0 ? 'ratio-row' : undefined} />)}
            {!full && (
              <div className="ratio-add">
                <button className="btn dashed fill" data-tour="ratio-add" onClick={() => addRatio()}>{Ico.plus}<span>{t('ratioAdd')}</span></button>
                <div className="chips" data-tour="ratio-common">
                  {COMMON_RATIOS.filter((c) => !used.has(c)).map((c) => <button key={c} className="btn ghost small" onClick={() => addRatio(c)}>{c}</button>)}
                </div>
              </div>
            )}
          </div>
          <RatioPane r={active} />
        </div>
      )}
    </DropZone>
  );
}

// ---------------------------------------------------------------- power-off images
function WallCard({ w, index }: { w: WallItem; index: number }) {
  const tour = index === 0 ? 'wall-card' : undefined;
  const info = useStore((s) => s.info);
  const model = useStore((s) => s.model);
  const [over, setOver] = useState(false);
  const factory = w.kind === 'factory' ? info?.shutdown[model] : undefined;
  const ref = useRef<HTMLImageElement>(null);
  const url = useMemo(() => (factory ? URL.createObjectURL(new Blob([factory.data as unknown as BlobPart], { type: 'image/jpeg' })) : ''), [factory]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
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
        {factory && <img ref={ref} src={url} alt="" draggable={false} />}
        {w.busy && <span className="thumb-state"><span className="spinner" /></span>}
        {w.error && <span className="thumb-state bad">{w.error}</span>}
        <span className="wall-index">{index + 1}</span>
        <span className="wall-actions">
          {w.kind === 'image' && <button className="btn mini" title={t('wallCrop')} onClick={() => openCrop(w.id)}>{Ico.crop}</button>}
          <button className="btn mini" title={t('remove')} onClick={() => removeWall(w.id)}>{Ico.x}</button>
        </span>
      </div>
      <div className="wall-meta">
        <span className="ellipsis">{w.name}</span>
        {w.quality !== undefined && w.quality < 25 && <span className="chip warn tiny">{t('lowQuality')}</span>}
        {!!w.grain && <span className="chip tiny">{t('grain')}</span>}
        {!!w.soften && <span className="chip warn tiny">{t('softened')}</span>}
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
  const [ref, box] = useBox<HTMLDivElement>();
  const tiles = wall.length + (wall.length < 9 ? 1 : 0);
  const fit = fitTiles(tiles, box.w, box.h);
  return (
    <DropZone className="page" accept={(f) => isImage(f) || isFirmware(f)} onFiles={(f) => { const fwFile = f.find(isFirmware); if (fwFile) void loadFirmwareFile(fwFile); const imgs = f.filter(isImage); if (imgs.length) void addWallFiles(imgs); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.image}</span>
        <h1>{t('navWall')}</h1>
        {info && wall.length > 0 && <div className="head-right"><span className="chip">{wall.length}/9</span></div>}
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="wall-fit" ref={ref} data-tour-page="wall">
          {fit.tile > 0 && (
            <div className="wall-grid" style={{ gridTemplateColumns: `repeat(${fit.cols}, ${fit.tile}px)` }}>
              {wall.map((w, i) => <WallCard key={w.id} w={w} index={i} />)}
              {wall.length < 9 && (
                <div className="wall-add" data-tour="wall-add">
                  <FileButton className="wall-add-btn" accept="image/*" multiple onFiles={(f) => { void addWallFiles(f); }}>{Ico.plus}<span>{wall.length ? t('wallAdd') : t('wallEmpty')}</span></FileButton>
                  <button className="btn ghost small" onClick={() => addFactoryWall()}>{t('wallFactory')}</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </DropZone>
  );
}

// ---------------------------------------------------------------- switching Script on
export function ScriptPage() {
  const info = useStore((s) => s.info);
  const onCard = useStore((s) => s.entryOnCard);
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.tool}</span>
        <h1>{t('navScript')}</h1>
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="guide" data-tour-page="script" data-tour="script-hint">
          <p className="guide-line">{t('scriptHint')}</p>
          <div className="chips">
            {info.factoryEntry.files.map((f) => <span key={f.name} className="chip file">{Ico.file}{f.name}</span>)}
            {onCard && <span className="chip ok">{Ico.check}{t('entryOnCard')}</span>}
          </div>
        </div>
      )}
    </DropZone>
  );
}

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
