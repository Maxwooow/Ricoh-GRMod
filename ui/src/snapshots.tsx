// The "Restore an earlier version" dialog: the automatic project snapshots (see store.ts, DEC-QOLD1-SNAP-001), newest first.
import { useEffect } from 'react';
import { t } from './i18n';
import type { Key } from './i18n';
import { closeSnapshots, restoreSnapshot, snapshotSummary, useStore } from './store';

export function SnapshotsDialog() {
  const v = useStore((s) => s.snapshotsView);
  useEffect(() => {
    if (!v) return;
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeSnapshots(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [!!v]);
  if (!v) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeSnapshots(); }}>
      <div className="dialog snap-dialog" role="dialog" aria-modal="true" aria-label={t('snapshotTitle')}>
        <h3>{t('snapshotTitle')}</h3>
        {v.busy && <p><span className="spinner small" /> {t('projectWorking')}</p>}
        {!v.busy && v.entries.length === 0 && <p className="small muted">{t('snapshotEmpty')}</p>}
        <ul className="snap-list">
          {v.entries.map((e) => (
            <li key={e.id}>
              <div className="snap-text">
                <span>{new Date(e.time).toLocaleString()} · {t(('snapshotReason_' + e.reason) as Key)}</span>
                <span className="small muted ellipsis">{snapshotSummary(e)}</span>
              </div>
              <button className="btn" onClick={() => { void restoreSnapshot(e.id); }}>{t('snapshotRestoreBtn')}</button>
            </li>
          ))}
        </ul>
        <div className="dialog-actions"><button className="btn primary" onClick={closeSnapshots}>{t('closeLabel')}</button></div>
      </div>
    </div>
  );
}
