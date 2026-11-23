// The "Inspect a firmware file" dialog: what any firmware .bin is (official or modified, verified,
// the features it switches on, ratios, added slots), read by the engine against the open official firmware.
import { useEffect } from 'react';
import { DropZone, FileButton, Ico, IconCanvas } from './components';
import { modelLabel } from './firmware';
import { t } from './i18n';
import type { Key } from './i18n';
import { compareRows, featureRows, KIND } from './compare';
import { closeCompare, closeInspect, fmtSize, inspectCompare, inspectFile, useStore } from './store';

const ERROR: Record<'needs-open' | 'unreadable' | 'size', Key> = { 'needs-open': 'inspectNeedsOpen', unreadable: 'inspectUnreadable', size: 'inspectSize' };

export function InspectDialog() {
  const v = useStore((s) => s.inspectView);
  const info = useStore((s) => s.info);
  const model = useStore((s) => s.model);
  const lang = useStore((s) => s.lang);
  useEffect(() => {
    if (!v) return;
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeInspect(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [!!v]);
  if (!v) return null;
  const s = v.summary;
  const pick = (f: File[]): void => { void inspectFile(f[0]); };
  const o = v.other;
  const rows = s && o?.summary ? compareRows(s, o.summary, lang) : null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeInspect(); }}>
      <DropZone onFiles={pick} accept={(f) => /\.bin$/i.test(f.name)} className={`dialog inspect${o ? ' wide' : ''}`}>
        <div role="dialog" aria-modal="true" aria-label={t('inspectTitle')}>
          <h3>{t('inspectTitle')}</h3>
          <p className="muted ellipsis" title={v.name}>{v.name} · {fmtSize(v.size)}</p>
          {v.busy && <p><span className="spinner small" /> {t('inspectBusy')}</p>}
          {v.error && <p className="dialog-warn">{t(ERROR[v.error])}</p>}
          {o && (
            <>
              <p className="muted ellipsis" title={o.name}>{t('cmpFileWith')}: {o.name} · {fmtSize(o.size)}</p>
              {o.busy && <p><span className="spinner small" /> {t('inspectBusy')}</p>}
              {o.error && <p className="dialog-warn">{t(ERROR[o.error])}</p>}
            </>
          )}
          {rows && (
            <table className="compare-table">
              <thead><tr><th /><th className="ellipsis" title={v.name}>{v.name}</th><th className="ellipsis" title={o!.name}>{o!.name}</th></tr></thead>
              <tbody>{rows.map((r) => <tr key={r.label} className={r.differs ? 'diff' : ''}><th scope="row">{r.label}</th><td>{r.a}</td><td>{r.b}</td></tr>)}</tbody>
            </table>
          )}
          {s && !rows && (
            <ul className="dialog-lines last">
              <li><b>{t('inspectKind')}</b>: {t(KIND[s.kind])}{s.kind === 'modified' && <> · {t('inspectChanged')} {s.changedBytes}</>}</li>
              <li><b>{t('inspectVerified')}</b>: {t(s.verified ? 'inspectYes' : 'inspectNo')}</li>
              {info && <li><b>{t('inspectRef')}</b>: {modelLabel(model)} {info.version}</li>}
              {s.kind !== 'unknown' && (
                <>
                  <li><b>{t('inspectFeatures')}</b></li>
                  {featureRows(s).map((f) => <li key={f.label}>{f.label}: {f.on ? <>{t('inspectYes')}{f.detail ? ` · ${f.detail}` : ''}</> : t('inspectNo')}</li>)}
                  <li><b>{t('inspectRatios')}</b>: {s.ratios.length ? s.ratios.map((r) => `${r.name} (${r.ratio})`).join(' / ') : t('inspectNone')}</li>
                  <li><b>{t('inspectExtras')}</b>: {s.extraSlots.length ? s.extraSlots.map((x) => x.name).join(' / ') : t('inspectNone')}</li>
                  <li><b>{t('inspectPictures')}</b>: {s.shutdownPictures?.length ? s.shutdownPictures.map((p) => p.name).join(' / ') : t('inspectNone')}</li>
                  {s.lookLayout && <li><b>{t('inspectLayout')}</b>: {t('inspectLayoutValue', { n: s.lookLayout.hidden.length })}</li>}
                  <li><b>{t('inspectSlots')}</b></li>
                  {s.slots.map((sl) => (
                    <li key={sl.id} className="inspect-slot"><IconCanvas pixels={sl.icon} scale={1} /> {sl.names[lang]}{sl.colorChanged || sl.nameChanged || sl.iconChanged ? ` · ${[sl.colorChanged ? t('copyColor') : '', sl.iconChanged ? t('copyIcon') : '', sl.nameChanged ? t('copyName') : ''].filter(Boolean).join(' / ')}` : ''}</li>
                  ))}
                </>
              )}
            </ul>
          )}
          <div className="dialog-actions">
            {s && <FileButton accept=".bin" onFiles={(f) => { void inspectCompare(f[0]); }}>{Ico.folder}<span>{t(o ? 'cmpFileAnother' : 'cmpFileBtn')}</span></FileButton>}
            {o && <button type="button" className="btn" onClick={closeCompare}>{t('cmpFileBack')}</button>}
            <FileButton accept=".bin" onFiles={pick}>{Ico.folder}<span>{t('inspectAgain')}</span></FileButton>
            <button type="button" className="btn primary" onClick={closeInspect}>{t('closeLabel')}</button>
          </div>
        </div>
      </DropZone>
    </div>
  );
}
