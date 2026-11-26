import { useEffect, useMemo, useRef, useState } from 'react';
import { color, halateRgba, halationLight } from '@grmod/core';
import type { ReactNode } from 'react';
import { DropZone, FileButton, Ico, Segmented, Select, Switch } from '../components';
import { isMobile } from '../host';
import { t } from '../i18n';
import { applySlot } from '../preview';
import { loadPreviewFile, previewPhoto, setActiveSlot, setPreviewMode, useStore, extraName, halationOf, slotOf, filmCountChoosable, compareSlot, setCompareWith, slotsWithLook, halationAllOffered, setHalationAll } from '../store';
import type { SlotKey } from '../store';
import { isImage } from './files';

// 24 reference patches (sRGB), shown before / after a preset
const CC24 = [[115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170], [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161], [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52]];

function Swatches({ params }: { params?: color.SlotParams }) {
  const gr3x = useStore(s => s.info?.family === 'gr3x');
  const out = useMemo(() => {
    if (!params) return null;
    const inp = new Float64Array(CC24.length * 3);
    CC24.forEach((c, i) => { inp[i * 3] = c[0] / 255; inp[i * 3 + 1] = c[1] / 255; inp[i * 3 + 2] = c[2] / 255; });
    const o = gr3x ? color.GR3X_CAMERA.slotApply(params, inp) : color.previewSlot(params, inp);
    return CC24.map((_, i) => `rgb(${Math.round(o[i * 3] * 255)},${Math.round(o[i * 3 + 1] * 255)},${Math.round(o[i * 3 + 2] * 255)})`);
  }, [params, gr3x]);
  return (
    <div className="swatches" aria-hidden>
      {CC24.map((c, i) => {
        const before = `rgb(${c[0]},${c[1]},${c[2]})`;
        return <span key={i} className="swatch"><i style={{ background: before }} /><i style={{ background: out ? out[i] : before }} /></span>;
      })}
    </div>
  );
}

/** A slot's halation as the preview draws it: the level chosen for the preview (0 = none), its colour and where its light starts. Undefined key: none. */
function useHalation(key: SlotKey | undefined): { level: number; colour: 'red' | 'white'; light: ReturnType<typeof halationLight> | undefined } {
  // (primitive selections: the store hook needs a stable value)
  const level = useStore((s) => { if (!key) return 0; const h = halationOf(key, s); return h.on ? h.preview : 0; });
  const colour = useStore((s): 'red' | 'white' => (!key ? 'red' : s.info?.family === 'gr3x' && !filmCountChoosable(s) ? 'red' : halationOf(key, s).colour ?? 'red'));
  // where the slot's light starts: its own look decides how bright the highlights end up
  const result = useStore((s) => (key ? slotOf(key, s)?.preset?.result : undefined));
  const light = useMemo(() => (result ? halationLight(result.curves, result.postQ9) : undefined), [result]);
  return { level, colour, light };
}
/** `base` with a slot's halation at its preview level, as the camera computes it (a copy; `base` itself when the slot has none). */
function withHalation(base: ImageData, h: { level: number; colour: 'red' | 'white'; light: ReturnType<typeof halationLight> | undefined }, gr3x: boolean): ImageData {
  if (!h.level) return base;
  const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  // GR IV's white from 0.9 scatters at Weak / Medium; GR III / IIIx keep the 0.8.2 white glow
  halateRgba(out.data, out.width, out.height, h.level as 1 | 2 | 3, h.light, h.colour, gr3x ? 'classic' : 'scatter');
  return out;
}

/** The sample photograph with the original (or, with `left`, another slot's look and halation) on the left of a draggable divider and the active slot's preset, labelled `label`, on the right. */
function PhotoCompare({ params, label, left }: { params?: color.SlotParams; label: string; left?: { slot: SlotKey; params: color.SlotParams; label: string } }) {
  const photo = usePhoto();
  const gr3x = useStore(s => s.info?.family === 'gr3x');
  const active = useStore((s) => s.activeSlot);
  const halo = useHalation(active);
  const base = useMemo(() => (photo && params ? applySlot(params, photo, gr3x) : null), [photo, params, gr3x]);
  // The added slot's halation at the level chosen for the preview, as the camera computes it.
  const after = useMemo(() => (base ? withHalation(base, halo, gr3x) : null), [base, halo.level, halo.light, halo.colour, gr3x]); // eslint-disable-line react-hooks/exhaustive-deps
  // The left side is another slot's look, with that slot's own halation, so two looks are compared the same way.
  // Rendered a tick after the choice so the picker closes at once; until then the photo shows.
  const leftHalo = useHalation(left?.slot);
  const [leftImg, setLeftImg] = useState<ImageData | null>(null);
  const leftParams = left?.params;
  useEffect(() => {
    setLeftImg(null);
    if (!photo || !leftParams) return;
    const h = setTimeout(() => setLeftImg(withHalation(applySlot(leftParams, photo, gr3x), leftHalo, gr3x)), 0);
    return () => clearTimeout(h);
  }, [photo, leftParams, gr3x, leftHalo.level, leftHalo.light, leftHalo.colour]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = left && leftImg ? leftImg : null;
  return <Compare photo={photo} after={after} label={label} before={ready} beforeLabel={ready && left ? left.label : undefined} />;
}

function usePhoto(): ImageData | null {
  const rev = useStore((s) => s.photoRev);
  return useMemo(() => previewPhoto(), [rev]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** `photo` on the left of a draggable divider, `after` (labelled `label`) on the right; `before` (labelled `beforeLabel`) replaces the photo on the left when given. */
function Compare({ photo, after, label, before, beforeLabel }: { photo: ImageData | null; after: ImageData | null; label: string; before?: ImageData | null; beforeLabel?: string }) {
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0.5);
  const dragging = useRef(false);
  useEffect(() => {
    const c = beforeRef.current;
    if (!c || !photo) return;
    const img = before ?? photo;
    c.width = img.width; c.height = img.height; c.getContext('2d')!.putImageData(img, 0, 0);
  }, [photo, before]);
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
      onPointerDown={(e) => {
        if (!after || (e.target as HTMLElement).closest('button')) return;
        // on a phone only the divider is dragged; the rest of the picture scrolls the page (a tap moves the divider)
        if (isMobile && !(e.target as HTMLElement).closest('.compare-line')) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); dragging.current = true; if (!isMobile) at(e.clientX);
      }}
      onPointerMove={(e) => { if (dragging.current) at(e.clientX); }}
      onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
      onClick={isMobile ? (e) => { if (after && !(e.target as HTMLElement).closest('.compare-line, button')) { boxRef.current?.classList.add('glide'); at(e.clientX); window.setTimeout(() => boxRef.current?.classList.remove('glide'), 320); } } : undefined}
      onDoubleClick={() => setPos(0.5)}
    >
      {after && <canvas ref={afterRef} className="compare-img" />}
      <canvas ref={beforeRef} className="compare-img" style={after ? { clipPath: `inset(0 ${(100 - pos * 100).toFixed(2)}% 0 0)` } : undefined} />
      {after && (
        <>
          <span className="compare-tag l" style={{ opacity: pos < 0.16 ? 0 : 1 }}>{beforeLabel ?? t('original')}</span>
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
/** The preview; `below` (with its height in `belowH`) goes under the picture, which leaves room for it. */
/**
 * Halation for every look (GR IV 1.20 / 1.21): one switch for all looks of the camera, under the photo: a compact row in
 * the style of the Add-ons page's switches, at the left. On, what the preview shows (off by default; the strength and colour are chosen in the
 * camera, on each look's parameter screen). `onHeight` reports its height, which the photo leaves free.
 */
function HaloBar({ onHeight }: { onHeight: (h: number) => void }) {
  const on = useStore((s) => s.halationAll);
  const level = useStore((s) => s.haloPreview);
  const colour = useStore((s) => s.haloColour);
  const noExtras = useStore((s) => s.extras.length === 0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => { ro.disconnect(); onHeight(0); };
  }, [onHeight]);
  return (
    <div className="pane-below halo-bar">
      <div ref={ref} className={`halo-cap ${on ? 'on' : ''}`} data-tour="ic-halo">
        {/* the switch right after the title, on or off; then the line (off) or the preview's choices (on) */}
        <span className="halo-cap-head" title={t('haloAllSub')}>
          <span className="page-icon soft-ico">{Ico.halo}</span>
          <b>{t('haloLabel')}</b>
          <Switch checked={on} onChange={(v) => setHalationAll({ halationAll: v })} label={t('haloLabel')} />
        </span>
        {!on && <span className="muted small halo-cap-sub">{t('haloAllSub')}</span>}
        {on && (
          <span className="halo-cap-row">
            <span className="muted small">{t('haloPreview')}</span>
            <Segmented value={String(level)} onChange={(v) => setHalationAll({ haloPreview: Number(v) as 0 | 1 | 2 | 3 })} options={[{ value: '0', label: t('haloOff') }, { value: '1', label: t('haloWeak') }, { value: '2', label: t('haloMedium') }, { value: '3', label: t('haloStrong') }]} />
            {level > 0 && <Segmented value={colour} onChange={(v) => setHalationAll({ haloColour: v as 'red' | 'white' })} options={[{ value: 'red', label: t('haloRed') }, { value: 'white', label: t('haloWhite') }]} />}
          </span>
        )}
        {on && noExtras && <span className="small halo-warn">{t('haloAllNeedsExtra')}</span>}
      </div>
    </div>
  );
}

export function PreviewPane({ below, belowH = 0 }: { below?: ReactNode; belowH?: number }) {
  const gr3x = useStore(s => s.info?.family === 'gr3x');
  const allSlots = useStore(s => s.info?.slots);
  const filmCount = useStore(s => (filmCountChoosable(s) ? s.filmCount : -1));
  const slotOptions = useMemo(() => (allSlots ? (filmCount >= 0 ? allSlots.slice(0, filmCount) : allSlots) : []), [allSlots, filmCount]);
  const slots = useStore(s => s.slots);
  const mode = useStore((s) => s.previewMode);
  const active = useStore((s) => s.activeSlot);
  const params = useStore((s) => slotOf(s.activeSlot, s)?.preset?.result?.params);
  const extras = useStore((s) => s.extras);
  const haloBar = useStore((s) => halationAllOffered(s));
  const [haloH, setHaloH] = useState(0);
  const extraLabels = useStore((s) => s.extras.map((x) => extraName(x, s)).join('\u0000'));
  const lang = useStore((s) => s.lang);
  const withLook = useStore((s) => slotsWithLook(s).join('\u0000'));
  const compareKey = useStore((s) => compareSlot(s));
  const leftParams = useStore((s) => { const k = compareSlot(s); return k ? slotOf(k, s)?.preset?.result?.params : undefined; });
  // GR III / IIIx: every slot is an added film (named as in the camera's menu, else its default name).
  const tabs = gr3x ? slotOptions.map((x) => ({ value: x.id, label: slots[x.id].names[lang] || x.names[lang]?.text || x.defaultName }))
    : [{ value: 'CY', label: t('slotCY') }, { value: 'CG', label: t('slotCG') }, ...extras.map((x, i) => ({ value: x.key, label: extraLabels.split('\u0000')[i] }))];
  const labelOf = (k: string): string => tabs.find((x) => x.value === k)?.label ?? k;
  const compareOptions = [{ value: 'orig', label: t('original') }, ...withLook.split('\u0000').filter((k) => k && k !== active).map((k) => ({ value: k, label: labelOf(k) }))];
  const tabsRef = useRef<HTMLDivElement>(null);
  // Bring the current tab into view by scrolling the tab strip only (scrollIntoView would also scroll the page,
  // which on a phone jumps back up to the tabs whenever a card below is touched).
  useEffect(() => {
    const box = tabsRef.current;
    const el = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const k = b.width / (box.clientWidth || 1) || 1; // window px per CSS px (the interface may be zoomed)
    const d = r.left < b.left ? r.left - b.left - 16 * k : r.right > b.right ? r.right - b.right + 16 * k : 0;
    if (d) box.scrollBy({ left: d / k, behavior: 'smooth' });
  }, [active]);
  // With many added slots in a narrow window the tabs do not all fit: arrows step through them.
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    // the edges fade where more tabs are scrolled out of view (on a phone, where there are no arrows)
    const edges = (): void => {
      el.classList.toggle('more-l', el.scrollLeft > 1);
      el.classList.toggle('more-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    const check = (): void => { setOverflow(el.scrollWidth > el.clientWidth + 1); edges(); };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('scroll', edges, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', edges); };
  }, [tabs.length]);
  const at = Math.max(0, tabs.findIndex((x) => x.value === active));
  const step = (d: number): void => { const n = tabs[at + d]; if (n) setActiveSlot(n.value); };
  const wheel = (e: React.WheelEvent<HTMLDivElement>): void => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; };
  return (
    <DropZone className="pane" accept={isImage} highlight={(types) => types.some((x) => x.startsWith('image/'))} onFiles={(f) => { void loadPreviewFile(f[0]); }}>
      <div className="pane-head">
        {tabs.length > 0 && <>
        {overflow && <button className="btn ghost icon-only seg-arrow" title={t('prevSlot')} aria-label={t('prevSlot')} disabled={at === 0} onClick={() => step(-1)}>{Ico.left}</button>}
        <div className="seg-scroll" ref={tabsRef} onWheel={wheel}><Segmented tour="ic-tabs" value={tabs.some((x) => x.value === active) ? active : tabs[0].value} onChange={setActiveSlot} options={tabs} /></div>
        {overflow && <button className="btn ghost icon-only seg-arrow" title={t('nextSlot')} aria-label={t('nextSlot')} disabled={at === tabs.length - 1} onClick={() => step(1)}>{Ico.right}</button>}
        </>}
        <span className="grow" />
        {mode === 'photo' && compareOptions.length > 1 && <div className="compare-with"><Select variant="box" value={compareKey ?? 'orig'} onChange={setCompareWith} options={compareOptions} label={t('compareWith')} lead={<span className="small muted compare-with-lead">{t('compareWith')}</span>} /></div>}
        {/* on a phone the looks need the width: the two views as icons */}
        <Segmented tour="ic-mode" className={isMobile ? 'seg-icons' : undefined} value={mode} onChange={setPreviewMode} options={isMobile
          ? [{ value: 'photo', label: Ico.image, title: t('previewPhoto') }, { value: 'swatch', label: Ico.swatch, title: t('previewSwatch') }]
          : [{ value: 'photo', label: t('previewPhoto') }, { value: 'swatch', label: t('previewSwatch') }]} />
      </div>
      <div className="pane-body" style={{ '--below': below ? `${belowH + 10}px` : haloBar && mode === 'photo' && haloH ? `${haloH + 10}px` : '0px' } as React.CSSProperties}>
        <div className="pane-fit" data-tour="ic-preview" data-tour-fit="">{mode === 'photo' ? <PhotoCompare params={params} label={compareKey ? labelOf(active) : t('preset')} left={compareKey && leftParams ? { slot: compareKey, params: leftParams, label: labelOf(compareKey) } : undefined} /> : <Swatches params={params} />}</div>
        {below && <div className="pane-below">{below}</div>}
        {!below && haloBar && mode === 'photo' && <HaloBar onHeight={setHaloH} />}
      </div>
    </DropZone>
  );
}
