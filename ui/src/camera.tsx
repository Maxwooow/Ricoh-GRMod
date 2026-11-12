// Android: sends a firmware file to the camera over Wi-Fi, the way GR WORLD does (mobile/android …/push/PushSession).
// Bluetooth turns the camera's Wi-Fi on, the file goes up in one PUT, then "start update" goes over Bluetooth.
import { useEffect, useRef, useState } from 'react';
import { Ico } from './components';
import { Gr, upload, useBack } from './host-android';
import { t } from './i18n';
import { closePush, fmtSize, useStore } from './store';

interface Cam { address: string; name?: string; bonded: boolean; rssi?: number }
interface Line { text: string; detail: boolean }
type Phase = 'pick' | 'run' | 'done';

export function PushDialog() {
  const job = useStore((s) => s.push);
  return job ? <Dialog key={job.file.length + job.label} /> : null;
}

function Dialog() {
  const job = useStore((s) => s.push)!;
  const [cams, setCams] = useState<Cam[]>([]);
  const [address, setAddress] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [vpn, setVpn] = useState(false);
  const [phase, setPhase] = useState<Phase>('pick');
  const [stage, setStage] = useState<{ id: string; text: string }>();
  const [progress, setProgress] = useState<{ sent: number; total: number }>();
  const [lines, setLines] = useState<Line[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; log?: string }>();
  const logRef = useRef<HTMLPreElement>(null);

  const add = (c: Cam): void => {
    setCams((list) => {
      const old = list.find((x) => x.address === c.address);
      const next = old ? list.map((x) => (x.address === c.address ? { ...x, ...c, bonded: c.bonded || x.bonded } : x)) : [...list, c];
      return next;
    });
    setAddress((a) => a ?? c.address);
  };

  const scan = async (): Promise<void> => {
    setProblem(undefined);
    setScanning(true);
    try {
      const st = await Gr.ensurePermissions();
      setVpn(!!st.vpn);
      if (!st.bluetooth) { setProblem(t('pushBtOff')); return; }
      for (const d of (await Gr.bondedCameras()).devices as Cam[]) add(d);
      for (const d of (await Gr.scan({ ms: 7000 })).devices as Cam[]) add(d);
    } catch (e) {
      const x = e as { code?: string; message?: string };
      setProblem(x.code === 'permission' ? t('pushPerm') : String(x.message ?? e));
    } finally { setScanning(false); }
  };

  useEffect(() => {
    const subs = [
      Gr.addListener('found', (d: Cam) => add(d)),
      Gr.addListener('log', (l: Line) => setLines((x) => [...x.slice(-1500), l])),
      Gr.addListener('stage', (s: { id: string; text: string }) => setStage(s)),
      Gr.addListener('progress', (p: { sent: number; total: number }) => setProgress(p)),
      Gr.addListener('finished', (r: { ok: boolean; log?: string }) => { setResult(r); setPhase('done'); }),
    ];
    void scan();
    return () => { for (const s of subs) void s.then((h) => h.remove()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, showLog]);

  const start = async (): Promise<void> => {
    if (!address) return;
    setPhase('run');
    setStage({ id: 'prepare-file', text: t('pushPreparing') });
    try {
      const info = await upload(job.file, { to: 'push' }) as { container: boolean; error?: string };
      if (!info.container) throw new Error(info.error || 'not a firmware file');
      await Gr.start({ address, mode: 'PUSH' });
    } catch (e) {
      setStage({ id: 'failed', text: String((e as Error).message ?? e) });
      setResult({ ok: false });
      setPhase('done');
    }
  };

  // back closes the dialog unless a push is under way (it is never left half done)
  useBack(true, () => { if (phase !== 'run') closePush(); });

  const running = phase === 'run';
  const updating = stage?.id === 'updating';
  const kind = stage?.id === 'done' ? 'ok' : stage?.id === 'failed' ? 'bad' : '';
  const pct = progress && progress.total > 0 ? (progress.sent / progress.total) * 100 : 0;
  const shown = lines.filter((l) => showLog || !l.detail);

  return (
    <div className="overlay">
      <div className="dialog push" role="dialog" aria-modal="true" aria-label={t('pushTitle')}>
        <h3>{t('pushTitle')}<span className="push-file">{job.label} · {fmtSize(job.file.length)}</span></h3>
        {phase === 'pick' && (
          <>
            {vpn && <p className="dialog-warn">{t('pushVpn')}</p>}
            <p className="push-hint muted">{t('pushFirstPair')}</p>
            <div className="push-cams">
              {cams.map((c) => (
                <button key={c.address} type="button" className={`push-cam ${c.address === address ? 'on' : ''}`} onClick={() => setAddress(c.address)}>
                  <span className="push-cam-ico">{Ico.chip}</span>
                  <span className="push-cam-text"><b>{c.name || c.address}</b><small>{c.bonded ? t('pushPaired') : t('pushUnpaired')}{c.rssi ? ` · ${c.rssi} dBm` : ''}</small></span>
                  {c.address === address && <span className="push-cam-check">{Ico.check}</span>}
                </button>
              ))}
              {scanning && <div className="push-cam idle"><span className="spinner small" /><span className="muted">{t('pushFinding')}</span></div>}
              {!scanning && cams.length === 0 && <div className="push-cam idle"><span className="muted">{problem || t('pushNoCam')}</span></div>}
            </div>
            <ul className="push-warn">
              <li>{t('pushWarn1')}</li>
              <li>{t('pushWarn2')}</li>
              <li>{t('pushWarn3')}</li>
            </ul>
            <div className="dialog-actions">
              <button type="button" className="btn" disabled={scanning} onClick={() => { void scan(); }}>{Ico.refresh}<span>{t('pushRescan')}</span></button>
              <span className="grow" />
              <button type="button" className="btn" onClick={closePush}>{t('cancel')}</button>
              <button type="button" className="btn primary" disabled={!address || scanning} onClick={() => { void start(); }}>{t('pushStart')}</button>
            </div>
          </>
        )}
        {phase !== 'pick' && (
          <>
            <p className={`push-stage ${kind}`}>{kind === '' && <span className="spinner small" />}<span>{stage?.text}</span></p>
            {progress && stage?.id === 'upload' && <div className="push-bar"><i style={{ width: `${pct}%` }} /></div>}
            <button type="button" className="push-log-toggle" onClick={() => setShowLog((v) => !v)}>{t('pushDetails')}{showLog ? Ico.up : Ico.down}</button>
            <pre className={`push-log ${showLog ? 'open' : ''}`} ref={logRef}>{shown.map((l) => l.text).join('\n')}</pre>
            <div className="dialog-actions">
              {phase === 'done' && result?.log && <button type="button" className="btn" onClick={() => { void Gr.shareLog({ path: result.log }); }}>{t('pushShareLog')}</button>}
              <span className="grow" />
              {running && !updating && <button type="button" className="btn" onClick={() => { void Gr.cancel(); }}>{t('pushStop')}</button>}
              {phase === 'done' && <button type="button" className="btn primary" onClick={closePush}>{t('pushClose')}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
