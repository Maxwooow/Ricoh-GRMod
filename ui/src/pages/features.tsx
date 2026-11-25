import { useRef } from 'react';
import type { ReactNode } from 'react';
import { DropZone, Ico, Segmented, Switch } from '../components';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import {
  useStore, loadFirmwareFile, gridOffered, setSoft, setDateStamp, setMonoUnlock, setFlashPlus, flashPlusOn, setAdjSlots, adjSlotsOf, setHdr, setExposurePreview, setFilmGrain,
  setShadowLearn, setBattery, setVideoAf, setMovieExposure, setAwbLearn, setConstantLight, setSensorShift, setMovie4k, setMovieSr, setDistanceFeet, setBrightAuto, setCustomGrid,
} from '../store';
import { isFirmware } from './files';
import { GridDetail, GridThumb, closeGrid, openGrid, useGridArrival } from './grid';

/**
 * One addition as a capsule: icon, name and its control on top, what it does below, and under that
 * a wider control (a choice of a few values) or a way into its own settings. The capsules fill the
 * page in as many columns as fit (styles.css `.capsules`).
 */
function Capsule({ icon, title, sub, on, control, foot, tour, onOpen, morph }: {
  icon: ReactNode; title: string; sub: string; on: boolean; control?: ReactNode; foot?: ReactNode; tour?: string; onOpen?: () => void; morph?: string;
}) {
  return (
    <div className={`capsule ${on ? 'on' : ''} ${onOpen ? 'opens' : ''}`} data-tour={tour} data-morph={morph}>
      <div className="capsule-top">
        <span className="page-icon soft-ico">{icon}</span>
        <b className="capsule-title">{title}</b>
        {control}
      </div>
      <p className="capsule-sub muted small">{sub}</p>
      {foot}
      {onOpen && (
        <button type="button" className="capsule-open" onClick={onOpen}>
          <span>{t('gridEdit')}</span>
          <span className="capsule-chev" aria-hidden>›</span>
        </button>
      )}
    </div>
  );
}

/** A switch of an addition. */
function FeatureCapsule({ on, onChange, ...rest }: { icon: ReactNode; title: string; sub: string; on: boolean; onChange: (v: boolean) => void; tour?: string }) {
  return <Capsule {...rest} on={on} control={<Switch checked={on} onChange={onChange} label={rest.title} />} />;
}

/** A choice of a few values (the camera's / GR Mod's grain, the ADJ items, the screen brightness). */
function ChoiceCapsule<T extends string>({ value, options, onChange, ...rest }: {
  icon: ReactNode; title: string; sub: string; on: boolean; tour?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return <Capsule {...rest} foot={<div className="capsule-choice"><Segmented value={value} onChange={onChange} options={options} /></div>} />;
}

/** The custom grid: its switch, and its editor on a page of its own (the capsule opens it). */
function GridCapsule() {
  const on = useStore((s) => s.customGrid);
  const menu = useStore((s) => !!s.info?.features.gridMenu);
  return (
    <Capsule
      icon={Ico.grid} title={t('navGrid')} sub={t(menu ? 'gridSubMenu' : 'gridSub')} on={on} tour="ex-f-grid"
      control={<Switch checked={on} onChange={setCustomGrid} label={t('navGrid')} />}
      foot={<GridThumb />}
      onOpen={openGrid} morph="grid-card"
    />
  );
}

/** Every addition the open firmware has, as capsules. `mono`: the Monochrome model (no B&W looks to unlock). */
function ExtrasList() {
  const mono = useStore((s) => s.model === 'MONO');
  const soft = useStore((s) => s.soft);
  const date = useStore((s) => s.dateStamp);
  const looks = useStore((s) => s.monoUnlock);
  const gr3x = useStore((s) => s.info?.family === 'gr3x');
  const dateOk = useStore((s) => !!s.info?.features.dateStamp);
  const flash = useStore((s) => flashPlusOn(s));
  const flashOk = useStore((s) => !!s.info?.features.directFlash || !!s.info?.features.flashTtl);
  const adjMax = useStore((s) => s.info?.features.maxAdjSlots ?? 5);
  const adj = useStore((s) => adjSlotsOf(s));
  const hdr = useStore((s) => s.hdr);
  const brightAuto = useStore((s) => s.brightAuto);
  const brightAutoOk = useStore((s) => !!s.info?.features.brightAuto);
  const hdrOk = useStore((s) => !!s.info?.features.hdrGainMap);
  const preview = useStore((s) => s.exposurePreview);
  const previewOk = useStore((s) => !!s.info?.features.exposurePreview);
  const shadow = useStore((s) => s.shadowLearn);
  const shadowOk = useStore((s) => !!s.info?.features.shadowLearn);
  const grain = useStore((s) => s.filmGrain);
  const grainOk = useStore((s) => !!s.info?.features.filmGrain);
  const ttlOk = useStore((s) => !!s.info?.features.flashTtl);
  const battery = useStore((s) => s.battery);
  const batteryOk = useStore((s) => !!s.info?.features.batteryPercent);
  const vaf = useStore((s) => s.videoAf);
  const vafOk = useStore((s) => !!s.info?.features.videoAf);
  const mexp = useStore((s) => s.movieExposure);
  const mexpOk = useStore((s) => !!s.info?.features.movieExposure);
  const awb = useStore((s) => s.awbLearn);
  const awbOk = useStore((s) => !!s.info?.features.awbLearn);
  const lamp = useStore((s) => s.constantLight);
  const lampOk = useStore((s) => !!s.info?.features.constantLight);
  const shift = useStore((s) => s.sensorShift);
  const shiftOk = useStore((s) => !!s.info?.features.sensorShift);
  const m4k = useStore((s) => s.movie4k);
  const m4kOk = useStore((s) => !!s.info?.features.movie4k);
  const msr = useStore((s) => s.movieSr);
  const msrOk = useStore((s) => !!s.info?.features.movieSr);
  const feet = useStore((s) => s.distanceFeet);
  const unitsOk = useStore((s) => !!s.info?.features.distanceFeet);
  const gridOk = useStore((s) => gridOffered(s));
  // the level names without their "Auto brightness · " prefix, first letter up
  const level = (key: 'brightAutoOff' | 'brightAutoBalanced' | 'brightAutoBright'): string => ((x) => x.charAt(0).toUpperCase() + x.slice(1))(t(key).split(' · ').pop()!);
  const list = useRef<HTMLDivElement>(null);
  useGridArrival(list);
  return (
    <div className="capsules" data-tour="ex-list" data-tour-page="extras" ref={list}><div className="capsules-flow">
      <FeatureCapsule icon={Ico.soft} title={t('navSoft')} sub={t(gr3x ? 'gr3xSoftSub' : 'softAdjSub')} on={soft} onChange={setSoft} tour="ex-f-soft" />
      {(!gr3x || dateOk) && <FeatureCapsule icon={Ico.date} title={t('navDate')} sub={t('dateSub')} on={date} onChange={setDateStamp} tour="ex-f-date" />}
      {!mono && !gr3x && <FeatureCapsule icon={Ico.mono} title={t('navMono')} sub={t('monoSub')} on={looks} onChange={setMonoUnlock} tour="ex-f-mono" />}
      {flashOk && <FeatureCapsule icon={Ico.flash} title={t('navFlash')} sub={t(ttlOk ? 'flashPlusSub' : 'flashSub')} on={flash} onChange={setFlashPlus} tour="ex-f-flash" />}
      {hdrOk && <FeatureCapsule icon={Ico.hdr} title={t('navHdr')} sub={t('hdrSub')} on={hdr} onChange={setHdr} tour="ex-f-hdr" />}
      {previewOk && <FeatureCapsule icon={Ico.preview} title={t('navPreview')} sub={t('previewSub')} on={preview} onChange={setExposurePreview} tour="ex-f-preview" />}
      {shadowOk && <FeatureCapsule icon={Ico.shadow} title={t('navShadow')} sub={t('shadowSub')} on={shadow} onChange={setShadowLearn} tour="ex-f-shadow" />}
      {batteryOk && <FeatureCapsule icon={Ico.battery} title={t('navBattery')} sub={t('batterySub')} on={battery} onChange={setBattery} tour="ex-f-battery" />}
      {grainOk && (
        <ChoiceCapsule icon={Ico.grain} title={t('navGrain')} sub={t('grainSub')} on={grain} tour="ex-f-grain"
          value={grain ? 'mod' : 'camera'} onChange={(v) => setFilmGrain(v === 'mod')}
          options={[{ value: 'camera', label: t('grainCamera') }, { value: 'mod', label: t('grainMod') }]} />
      )}
      {vafOk && <FeatureCapsule icon={Ico.movie} title={t('navVideoAf')} sub={t('videoAfSub')} on={vaf} onChange={setVideoAf} tour="ex-f-vaf" />}
      {mexpOk && <FeatureCapsule icon={Ico.movieExp} title={t('navMovieExp')} sub={t('movieExpSub')} on={mexp} onChange={setMovieExposure} tour="ex-f-mexp" />}
      {m4kOk && <FeatureCapsule icon={Ico.movie4k} title={t('navMovie4k')} sub={t('movie4kSub')} on={m4k} onChange={setMovie4k} tour="ex-f-4k" />}
      {msrOk && <FeatureCapsule icon={Ico.movieSr} title={t('navMovieSr')} sub={t('movieSrSub')} on={msr} onChange={setMovieSr} tour="ex-f-msr" />}
      {awbOk && <FeatureCapsule icon={Ico.wb} title={t('navAwb')} sub={t('awbSub')} on={awb} onChange={setAwbLearn} tour="ex-f-awb" />}
      {lampOk && <FeatureCapsule icon={Ico.lamp} title={t('navLamp')} sub={t('lampSub')} on={lamp} onChange={setConstantLight} tour="ex-f-lamp" />}
      {shiftOk && <FeatureCapsule icon={Ico.shift} title={t('navShift')} sub={t('shiftSub')} on={shift} onChange={setSensorShift} tour="ex-f-shift" />}
      {unitsOk && (
        <ChoiceCapsule icon={Ico.units} title={t('navUnits')} sub={t('unitsSub')} on={feet} tour="ex-f-units"
          value={feet ? 'ft' : 'm'} onChange={(v) => setDistanceFeet(v === 'ft')}
          options={[{ value: 'm', label: t('unitsMetre') }, { value: 'ft', label: t('unitsFeet') }]} />
      )}
      {gridOk && <GridCapsule />}
      {adjMax > 5 && (
        <ChoiceCapsule icon={Ico.adj} title={t('navAdjSlots')} sub={t('adjSlotsSub')} on={adj > 5} tour="ex-f-adj"
          value={String(adj)} onChange={(v) => setAdjSlots(Number(v))}
          options={Array.from({ length: adjMax - 4 }, (_, i) => ({ value: String(5 + i), label: String(5 + i) }))} />
      )}
      {brightAutoOk && (
        <ChoiceCapsule icon={Ico.bright} title={t('navBrightAuto')} sub={t('brightAutoSub')} on={!!brightAuto} tour="ex-f-bright"
          value={brightAuto || 'off'} onChange={(v) => setBrightAuto(v === 'off' ? false : v as 'bright' | 'balanced')}
          options={([['off', 'brightAutoOff'], ['balanced', 'brightAutoBalanced'], ['bright', 'brightAutoBright']] as const).map(([value, key]) => ({ value, label: level(key) }))} />
      )}
    </div></div>
  );
}

/** The additions page: every addition as a capsule; the custom grid opens its own editor. */
export function ExtrasPage() {
  const info = useStore((s) => s.info);
  const grid = useStore((s) => s.extrasView === 'grid' && gridOffered(s));
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className={`page-head ${grid ? 'sub' : ''}`}>
        {grid
          ? <>
            <button type="button" className="btn ghost icon-only back-btn" data-tour="ex-back" title={t('navExtras')} aria-label={t('navExtras')} onClick={closeGrid}>{Ico.left}</button>
            <h1 className="crumbs"><span className="crumb-up" onClick={closeGrid}>{t('navExtras')}</span><span className="crumb-sep" aria-hidden>›</span><span>{t('navGrid')}</span></h1>
            <span className="m-crumb">{t('navGrid')}</span>
          </>
          : <><span className="page-icon">{Ico.extras}</span><h1>{t('navExtras')}</h1></>}
      </header>
      {!info && <FirmwareHero />}
      {info && (grid ? <GridDetail /> : <ExtrasList />)}
    </DropZone>
  );
}
