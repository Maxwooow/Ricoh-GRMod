import { useEffect, useMemo, useRef } from 'react';
import { GR3X_RATIO_NAME_MAX } from '@grmod/core';
import { DropZone, FileButton, Ico, RatioIcon, Segmented } from '../components';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import { addRatio, loadFirmwareFile, loadPreviewFile, previewPhoto, maxRatios, ratioName, ratioProblem, removeRatio, setActiveRatio, setRatio, setRatioBackdrop, liveViewOf, setLiveView, useStore } from '../store';
import type { LiveView, RatioItem } from '../store';
import { isFirmware, isImage } from './files';
import { pick } from './slot-cards';

// ---------------------------------------------------------------- added aspect ratios
// in the camera's menu order
const FACTORY_RATIOS = ['3:2', '4:3', '1:1', '16:9'];
const COMMON_RATIOS = ['65:24', '2.39:1', '2:1', '5:4', '7:6'];
const size = (s: [number, number]): string => `${s[0]}×${s[1]}`;

function RatioRow({ r, active, tour }: { r: RatioItem; active: boolean; tour?: string }) {
  const gr3x = useStore(s => s.info?.family === 'gr3x');
  const p = r.preview;
  // A ratio narrower than 1:1 is only marked (the input in red, the reason as its tooltip).
  const portrait = p?.problem === 'ratio-portrait';
  const problem = portrait ? null : ratioProblem(r);
  const busy = !!r.ratio.trim() && !p;
  return (
    <div className={`ratio-row ${active ? 'on' : ''}`} data-tour={tour} {...pick(() => setActiveRatio(r.id))}>
      <RatioIcon pixels={p?.icon} width={48} />
      <input
        className={`input ratio-in ${p?.problem ? 'bad' : ''}`} title={portrait ? ratioProblem(r) ?? undefined : undefined} value={r.ratio} maxLength={16} spellCheck={false} placeholder={t('ratioPlaceholder')} aria-label={t('navRatio')}
        autoFocus={!r.ratio} onChange={(e) => setRatio(r.id, { ratio: e.target.value.replace(/[^0-9:.：/xX×]/g, '').replace(/[：/xX×]/g, ':') })}
      />
      <input
        className={`input ratio-name ${problem && !p?.problem ? 'bad' : ''}`} value={r.name} maxLength={gr3x ? GR3X_RATIO_NAME_MAX : 24} spellCheck={false} placeholder={p?.label || t('name')} aria-label={t('name')}
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
  // With the live-view shade the camera darkens the outside (black at 50 % or grey at 25 %); the preview does the same.
  // GR IV 1.20 / 1.21: always, as bright as chosen in the camera (Matte Brightness); the preview shows its default, 75 %.
  const menu = useStore((s) => !!s.info?.features.shadeMenu);
  const shade = useStore((s) => (s.ratioShade || menu) && !!s.info?.features.ratioShade);
  const tone = useStore((s) => (menu ? 'level-75' : `tone-${s.ratioShadeTone}`));
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
        <div className={`ratio-frame ${showPhoto ? '' : 'gray'} ${shade ? `live-shade ${tone}` : ''}`}>
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
          {p?.problem && p.problem !== 'ratio-portrait' && <span className="chip bad">{r ? ratioProblem(r) : ''}</span>}
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
  const max = useStore((s) => maxRatios(s));
  const full = ratios.length >= max;
  const used = new Set(ratios.map((r) => r.ratio.trim()));
  const shadeOk = !!info?.features.ratioShade;
  const live = useStore((s) => liveViewOf(s));
  const shadeMenu = !!info?.features.shadeMenu;
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.ratio}</span>
        <h1>{t('navRatio')}</h1>
        {info && <div className="head-right"><span className="chip">{`${ratios.filter(r => r.ratio.trim()).length}/${max}`}</span></div>}
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="ratio" data-tour-page="ratio">
          <div className="ratio-list">
            <div className="ratio-factory" data-tour="ratio-factory">
              <span className="muted small">{t('ratioFactory')}</span>
              {(info.factoryRatios || FACTORY_RATIOS).map((f) => <span key={f} className="chip muted">{f}</span>)}
            </div>
            {info.family === 'gr3x' && <p className="muted small">{t('gr3xRatioAdj')}</p>}
            {ratios.map((r, i) => <RatioRow key={r.id} r={r} active={r.id === active?.id} tour={i === 0 ? 'ratio-row' : undefined} />)}
            {!full && (
              <div className="ratio-add">
                <button className="btn dashed fill" data-tour="ratio-add" onClick={() => addRatio()}>{Ico.plus}<span>{t('ratioAdd')}</span></button>
                <div className="chips" data-tour="ratio-common">
                  {COMMON_RATIOS.filter((c) => !used.has(c)).map((c) => <button key={c} className="btn ghost small" onClick={() => addRatio(c)}>{c}</button>)}
                </div>
              </div>
            )}
            {shadeOk && shadeMenu && (
              <p className="ratio-live muted small" data-tour="ratio-live">{t('ratioLiveMenuTip')}</p>
            )}
            {shadeOk && !shadeMenu && (
              <div className="ratio-live" data-tour="ratio-live">
                <span className="muted small">{t('ratioLive')}</span>
                <Segmented<LiveView> value={live} onChange={setLiveView}
                  options={[{ value: '100', label: '100%' }, { value: '50', label: '50%' }, { value: '25', label: '25%' }]} />
                <p className="muted small">{t('ratioLiveTip')}</p>
              </div>
            )}
          </div>
          <RatioPane r={active} />
        </div>
      )}
    </DropZone>
  );
}
