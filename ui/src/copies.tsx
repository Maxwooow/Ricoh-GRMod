// Files that writes moved aside on the card (GRMOD\parked-*), and the backups of them kept on this
// computer. The only page whose content can be longer than the window: its list scrolls by itself.
import { useMemo } from 'react';
import type { LangCode } from '@grmod/core';
import { Ico, IconCanvas, Segmented } from './components';
import type { ParkedEntry } from './host';
import { t } from './i18n';
import type { Key } from './i18n';
import { copyKey, copyList, fmtSize, setCopySource, toggleCopies, useStore } from './store';
import type { BuildRecord, CopyInfo, CopySource } from './store';

const folderOf = (p: string): string => p.slice(0, p.indexOf('/'));
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** "parked-20261007-104625-2" -> "2026-10-07 10:46:25 (2)". */
export function folderLabel(folder: string): string {
  const m = /^parked-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/.exec(folder);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${m[7] ? ` (${m[7]})` : ''}` : folder.replace(/^parked-/, '');
}

function kindOf(e: ParkedEntry): Key {
  const n = nameOf(e.path).toLowerCase();
  if (n.endsWith('.bin')) return 'fileFirmware';
  if (n === 'startup.ttl') return 'fileScript';
  if (n === 'develop.mod' || /^\d{8}\.\d{3}$/.test(n)) return 'fileEntry';
  if (n === 'gbrstop.txt') return 'filePause';
  return 'fileOther';
}

function FirmwareLine({ info, builds, lang, name }: { info: CopyInfo | undefined; builds: BuildRecord[]; lang: LangCode; name: string }) {
  if (!info || info.busy) return <><span className="copy-file">{Ico.chip}</span><div className="copy-text"><div className="copy-title">{name}</div><div className="copy-sub">{info?.busy && <><span className="spinner small" />{t('copyReading')}</>}</div></div></>;
  const s = info.summary;
  if (!s || s.kind === 'unknown') return <><span className="copy-file">{Ico.chip}</span><div className="copy-text"><div className="copy-title">{name}</div><div className="copy-sub"><span className="chip warn tiny">{t('copyUnknown')}</span></div></div></>;
  const build = builds.find((b) => b.sha256 === s.sha256);
  return (
    <>
      <span className="copy-icons">{s.slots.map((sl) => <IconCanvas key={sl.id} pixels={sl.icon} scale={1} />)}</span>
      <div className="copy-text">
        <div className="copy-title ellipsis">{s.slots.map((sl) => sl.names[lang]).join('  ·  ')}</div>
        <div className="copy-sub">
          {s.kind === 'official' && <span className="chip ok tiny">{t('copyOfficial')}</span>}
          {s.kind === 'modified' && <span className="chip tiny">{t('copyModified')}</span>}
          {s.kind === 'modified' && !s.verified && <span className="chip warn tiny">{t('copyUnverified')}</span>}
          {s.kind === 'modified' && s.slots.map((sl) => {
            const preset = build?.slots.find((x) => x.id === sl.id)?.preset;
            const parts = [sl.colorChanged ? preset || t('copyColor') : '', sl.iconChanged ? t('copyIcon') : '', sl.nameChanged ? t('copyName') : ''].filter(Boolean);
            return parts.length ? <span key={sl.id} className="chip tiny" title={parts.join(' · ')}><b>{t(('slotShort' + sl.id) as Key)}</b><span className="ellipsis">{parts.join(' · ')}</span></span> : null;
          })}
        </div>
      </div>
    </>
  );
}

export function CopiesPage() {
  const source = useStore((s) => s.copySource);
  const list = useStore((s) => copyList(s));
  const nCard = useStore((s) => s.parked.length);
  const nPc = useStore((s) => s.backups.length);
  const sel = useStore((s) => s.copySel);
  const infos = useStore((s) => s.copyInfo);
  const builds = useStore((s) => s.builds);
  const lang = useStore((s) => s.lang);
  const hasCard = useStore((s) => s.volumes.some((v) => v.id === s.volumeId));
  const groups = useMemo(() => {
    const m = new Map<string, ParkedEntry[]>();
    for (const e of list) { const f = folderOf(e.path); if (!m.has(f)) m.set(f, []); m.get(f)!.push(e); }
    // newest first; inside a folder the firmware first
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([folder, items]) => ({ folder, items: items.slice().sort((a, b) => b.size - a.size) }));
  }, [list]);
  const selected = new Set(sel);
  const selSize = list.reduce((a, e) => a + (selected.has(e.path) ? e.size : 0), 0);
  const total = list.reduce((a, e) => a + e.size, 0);
  const allOn = list.length > 0 && list.every((e) => selected.has(e.path));
  return (
    <div className="page">
      <header className="page-head">
        <span className="page-icon">{Ico.archive}</span>
        <h1>{t('navCopies')}</h1>
        <div className="head-right">
          <Segmented<CopySource> value={source} onChange={setCopySource} options={[{ value: 'card', label: `${t('copiesCardTab')}${nCard ? ` ${nCard}` : ''}` }, { value: 'pc', label: `${t('copiesPcTab')}${nPc ? ` ${nPc}` : ''}` }]} />
        </div>
      </header>
      <div className="copies">
        <div className="copies-bar">
          <label className="check"><input type="checkbox" checked={allOn} disabled={list.length === 0} onChange={() => toggleCopies(list.map((e) => e.path), !allOn)} />{t('copiesAll')}</label>
          <span className="grow" />
          <span className="muted small">{sel.length ? t('copiesSelected', { n: sel.length, s: fmtSize(selSize) }) : list.length ? t('copiesCount', { n: list.length, s: fmtSize(total) }) : ''}</span>
        </div>
        {list.length === 0 && <div className="copies-empty">{source === 'pc' ? t('copiesEmptyPc') : hasCard ? t('copiesEmptyCard') : t('noCard')}</div>}
        {list.length > 0 && (
          <div className="copies-list">
            {groups.map((g) => {
              const paths = g.items.map((e) => e.path);
              const on = paths.every((p) => selected.has(p));
              return (
                <section key={g.folder} className="copy-group">
                  <label className="copy-group-head">
                    <input type="checkbox" checked={on} onChange={() => toggleCopies(paths, !on)} />
                    <span>{folderLabel(g.folder)}</span>
                    <span className="grow" />
                    <span className="muted small">{fmtSize(g.items.reduce((a, e) => a + e.size, 0))}</span>
                  </label>
                  {g.items.map((e) => {
                    const kind = kindOf(e);
                    return (
                      <label key={e.path} className={`copy-row ${selected.has(e.path) ? 'on' : ''}`}>
                        <input type="checkbox" checked={selected.has(e.path)} onChange={() => toggleCopies([e.path])} />
                        {kind === 'fileFirmware'
                          ? <FirmwareLine info={infos[copyKey(source, e)]} builds={builds} lang={lang} name={nameOf(e.path)} />
                          : <><span className="copy-file">{Ico.file}</span><div className="copy-text"><div className="copy-title">{t(kind)}</div><div className="copy-sub">{e.path.slice(e.path.indexOf('/') + 1)}</div></div></>}
                        <span className="copy-size">{fmtSize(e.size)}</span>
                      </label>
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
