import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Ico, Segmented, Select, Switch } from '../components';
import { isMobile } from '../host';
import { t } from '../i18n';
import { uiScale } from '../fit';
import { useStore, setSoft, setDateStamp, setMonoUnlock, setFlashPlus, flashPlusOn, setAdjSlots, adjSlotsOf, setHdr, setExposurePreview, setFilmGrain, setShadowLearn, setBattery, setBrightAuto } from '../store';

/** One switch of the firmware additions: icon, name, one line of detail. */
export function FeatureRow({ icon, title, sub, on, onChange, tour }: { icon: ReactNode; title: string; sub: string; on: boolean; onChange: (v: boolean) => void; tour?: string }) {
  return (
    <div className={`soft-switch ${on ? 'on' : ''}`} data-tour={tour}>
      <span className="page-icon soft-ico">{icon}</span>
      <div className="soft-text">
        <b>{title}</b>
        <span className="muted small ellipsis">{sub}</span>
      </div>
      <Switch checked={on} onChange={onChange} label={title} />
    </div>
  );
}

/** A choice of a few values in the row of an addition (icon, name, one line of detail). */
function ChoiceRow<T extends string>({ icon, title, sub, value, on, options, onChange, tour }: { icon: ReactNode; title: string; sub: string; value: T; on: boolean; options: { value: T; label: string }[]; onChange: (v: T) => void; tour?: string }) {
  return (
    <div className={`soft-switch ${on ? 'on' : ''}`} data-tour={tour}>
      <span className="page-icon soft-ico">{icon}</span>
      <div className="soft-text">
        <b>{title}</b>
        <span className="muted small ellipsis">{sub}</span>
      </div>
      <Segmented value={value} onChange={onChange} options={options} />
    </div>
  );
}

/** ADJ lever slots: the camera's five, or 6..8 (set in the camera, Customize Settings). */
function AdjSlotsRow({ max }: { max: number }) {
  const n = useStore((s) => adjSlotsOf(s));
  const options = Array.from({ length: max - 4 }, (_, i) => ({ value: String(5 + i), label: String(5 + i) }));
  return (
    <div className={`soft-switch ${n > 5 ? 'on' : ''}`} data-tour="ic-f-adj">
      <span className="page-icon soft-ico">{Ico.adj}</span>
      <div className="soft-text">
        <b>{t('navAdjSlots')}</b>
        <span className="muted small ellipsis">{t('adjSlotsSub')}</span>
      </div>
      <Segmented value={String(n)} onChange={(v) => setAdjSlots(Number(v))} options={options} />
    </div>
  );
}

/**
 * The additions that are not slots: soft focus on the ADJ lever (off / weak / medium / strong),
 * the date imprint with its menu, and the six monochrome looks (colour models only).
 */
export function FeatureSwitches({ mono, boxRef, from }: { mono: boolean; boxRef?: (el: HTMLDivElement | null) => void; from?: React.MutableRefObject<DOMRect | null> }) {
  const soft = useStore((s) => s.soft);
  const date = useStore((s) => s.dateStamp);
  const looks = useStore((s) => s.monoUnlock);
  const gr3x = useStore(s => s.info?.family === 'gr3x');
  const dateOk = useStore(s => !!s.info?.features.dateStamp);
  const flash = useStore((s) => flashPlusOn(s));
  const flashOk = useStore((s) => !!s.info?.features.directFlash || !!s.info?.features.flashTtl);
  const adjMax = useStore((s) => s.info?.features.maxAdjSlots ?? 5);
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
  const own = useRef<HTMLDivElement | null>(null);
  // Moved to the other column: glide from where it was (FLIP). Rectangles are in window pixels,
  // the transform is in the zoomed interface's pixels.
  useLayoutEffect(() => {
    const el = own.current; const r0 = from?.current;
    if (!el || !r0 || !from) return;
    from.current = null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r1 = el.getBoundingClientRect(); const k = uiScale();
    const dx = (r0.left - r1.left) / k; const dy = (r0.top - r1.top) / k;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' });
  }, [from]);
  return (
    <div className="card extras" data-tour="ic-soft" ref={(el) => { own.current = el; boxRef?.(el); }}>
      <FeatureRow icon={Ico.soft} title={t('navSoft')} sub={t(gr3x ? 'gr3xSoftSub' : 'softAdjSub')} on={soft} onChange={setSoft} tour="ic-f-soft" />
      {(!gr3x || dateOk) && <FeatureRow icon={Ico.date} title={t('navDate')} sub={t('dateSub')} on={date} onChange={setDateStamp} tour="ic-f-date" />}
      {!mono && !gr3x && <FeatureRow icon={Ico.mono} title={t(gr3x ? 'gr3xReplicaTitle' : 'navMono')} sub={t(gr3x ? 'gr3xReplicaSub' : 'monoSub')} on={looks} onChange={setMonoUnlock} tour="ic-f-mono" />}
      {flashOk && <FeatureRow icon={Ico.flash} title={t('navFlash')} sub={t(ttlOk ? 'flashPlusSub' : 'flashSub')} on={flash} onChange={setFlashPlus} tour="ic-f-flash" />}
      {hdrOk && <FeatureRow icon={Ico.hdr} title={t('navHdr')} sub={t('hdrSub')} on={hdr} onChange={setHdr} tour="ic-f-hdr" />}
      {previewOk && <FeatureRow icon={Ico.preview} title={t('navPreview')} sub={t('previewSub')} on={preview} onChange={setExposurePreview} tour="ic-f-preview" />}
      {shadowOk && <FeatureRow icon={Ico.shadow} title={t('navShadow')} sub={t('shadowSub')} on={shadow} onChange={setShadowLearn} tour="ic-f-shadow" />}
      {batteryOk && <FeatureRow icon={Ico.battery} title={t('navBattery')} sub={t('batterySub')} on={battery} onChange={setBattery} tour="ic-f-battery" />}
      {grainOk && (
        <ChoiceRow icon={Ico.grain} title={t('navGrain')} sub={t('grainSub')} on={grain} tour="ic-f-grain"
          value={grain ? 'mod' : 'camera'} onChange={(v) => setFilmGrain(v === 'mod')}
          options={[{ value: 'camera', label: t('grainCamera') }, { value: 'mod', label: t('grainMod') }]} />
      )}
      {adjMax > 5 && <AdjSlotsRow max={adjMax} />}
      {brightAutoOk && !isMobile && <div className="soft-switch" data-tour="ic-f-bright"><Select value={brightAuto || 'off'} options={[{ value: 'off', label: t('brightAutoOff') }, { value: 'balanced', label: t('brightAutoBalanced') }, { value: 'bright', label: t('brightAutoBright') }]} onChange={(v) => setBrightAuto(v === 'off' ? false : v as 'bright' | 'balanced')} label={t('navBrightAuto')} variant="row" /></div>}
      {/* on a phone: a row like the others, the three levels side by side (as the ADJ items) */}
      {brightAutoOk && isMobile && (
        <div className={`soft-switch bright-row ${brightAuto ? 'on' : ''}`} data-tour="ic-f-bright">
          <span className="page-icon soft-ico">{Ico.bright}</span>
          <div className="soft-text"><b>{t('navBrightAuto')}</b></div>
          <Segmented
            value={brightAuto || 'off'} onChange={(v) => setBrightAuto(v === 'off' ? false : v as 'bright' | 'balanced')}
            options={([['off', 'brightAutoOff'], ['balanced', 'brightAutoBalanced'], ['bright', 'brightAutoBright']] as const).map(([value, key]) => ({ value, label: ((x) => x.charAt(0).toUpperCase() + x.slice(1))(t(key).split(' · ').pop()!) }))}
          />
        </div>
      )}
    </div>
  );
}
