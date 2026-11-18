import { useMemo } from 'react';
import { batteryIcons } from '@grmod/core';
import { DropZone, Ico, RatioIcon } from '../components';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import { loadFirmwareFile, setBattery, useStore } from '../store';
import { FeatureRow } from './features';
import { isFirmware } from './files';

// ---------------------------------------------------------------- battery percentage
/** The icons the build adds, from full to nearly empty (100, 70, 40, 20, 10 %). */
const BATTERY_PREVIEW = [10, 7, 4, 2, 1];

export function BatteryPage() {
  const info = useStore((s) => s.info);
  const battery = useStore((s) => s.battery);
  const icons = useMemo(() => { const all = batteryIcons(); return BATTERY_PREVIEW.map((step) => all[step - 1]); }, []);
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.battery}</span>
        <h1>{t('navBatteryPage')}</h1>
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="battery-page" data-tour-page="battery">
          <div className="card extras">
            <FeatureRow icon={Ico.battery} title={t('navBattery')} sub={t('batterySub')} on={battery} onChange={setBattery} tour="battery-switch" />
          </div>
          <div className="battery-look">
            <span className="muted small">{t('batteryLook')}</span>
            <div className="battery-icons">{icons.map((x) => <RatioIcon key={x.id} pixels={x.px} width={120} />)}</div>
          </div>
          <p className="muted small">{t('batteryNote')}</p>
        </div>
      )}
    </DropZone>
  );
}
