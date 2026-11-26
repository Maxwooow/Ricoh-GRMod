// SPDX-License-Identifier: GPL-2.0-only
// The preset library in the interface: two buttons on a slot's preset row and one dialog.
// The logic (files, compatibility, reuse of a stored fit) is in store/library.ts.
import { useEffect, useMemo, useState } from 'react';
import { Ico, Segmented } from './components';
import { t } from './i18n';
import { host } from './host';
import {
  applyFromLibrary, closeLibrary, defaultLibraryName, deleteLibraryEntry, LIBRARY_SEARCH_MIN, libraryFor, loadLibrary, openLibrary, renameLibraryEntry, saveToLibrary, searchLibrary, slotOf, sortLibrary, useStore,
} from './store';
import type { LibrarySort, SlotKey, State } from './store';

/** "Save to library" (when the slot has a fitted preset) and "Apply from library" under a slot's preset. Both need the host: the library is its files. */
/** The library's two buttons for a slot's preset row (inside its row of small buttons). */
export function LibraryButtons({ k }: { k: SlotKey }) {
  const ready = useStore((s) => !!slotOf(k, s)?.preset?.result);
  useEffect(() => { void loadLibrary(); }, []);
  if (!host.available) return null;
  return (
    <>
      {ready && <button className="btn small" onClick={() => openLibrary(k, 'save')}>{t('libSave')}</button>}
      <button className="btn small" onClick={() => openLibrary(k, 'apply')}>{t('libApply')}</button>
    </>
  );
}

/** The dialog behind both buttons: a name field in save mode, in apply mode the entries of this camera family, with search and sort from LIBRARY_SEARCH_MIN entries, a rename and a delete each. */
export function LibraryDialog() {
  const picker = useStore((s) => s.libraryPicker);
  // Stable fields only: libraryFor filters and sorts into a fresh array, which as a selector never settles (React error #185).
  const library = useStore((s) => s.library); const model = useStore((s) => s.model);
  const entries = useMemo(() => libraryFor({ library, model }), [library, model]);
  const [name, setName] = useState('');
  // Search text, sort choice and the entry being renamed (with its text and the last refusal)
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('new');
  const [edit, setEdit] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (!picker) return;
    setName(defaultLibraryName(picker.slot));
    setQuery(''); setEdit(null);
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeLibrary(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [picker]);
  const shown = useMemo(() => sortLibrary(searchLibrary(entries, query), sort), [entries, query, sort]);
  if (!picker) return null;
  const save = picker.mode === 'save';
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeLibrary(); }}>
      <div className="dialog lib-dialog" role="dialog" aria-modal="true" aria-label={save ? t('libTitleSave') : t('libTitleApply')}>
        <h3>{save ? t('libTitleSave') : t('libTitleApply')}</h3>
        {save ? (
          <form className="lib-save" onSubmit={(e) => { e.preventDefault(); void saveToLibrary(picker.slot, name).then((ok) => { if (ok) closeLibrary(); }); }}>
            <label className="small muted" htmlFor="lib-name">{t('libName')}</label>
            <input id="lib-name" className="input" value={name} maxLength={60} autoFocus spellCheck={false} onChange={(e) => setName(e.target.value)} />
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={closeLibrary}>{t('cancel')}</button>
              <button type="submit" className="btn primary" disabled={!name.trim()}>{t('libSaveBtn')}</button>
            </div>
          </form>
        ) : (
          <>
            {entries.length === 0 && <p className="small muted">{t('libEmpty')}</p>}
            {entries.length > LIBRARY_SEARCH_MIN && (
              <div className="lib-tools">
                <input className="input" type="search" value={query} placeholder={t('libSearch')} aria-label={t('libSearch')} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
                <Segmented value={sort} onChange={setSort} options={[{ value: 'new', label: t('libSortNew') }, { value: 'name', label: t('libSortName') }]} />
              </div>
            )}
            {entries.length > 0 && shown.length === 0 && <p className="small muted">{t('libNoMatch')}</p>}
            <ul className="lib-list">
              {shown.map((e) => (
                <li key={e.id}>
                  {edit?.id === e.id ? (
                    <form className="lib-rename" onSubmit={(ev) => { ev.preventDefault(); void renameLibraryEntry(e.id, edit.text).then((r) => { if (r === 'ok') setEdit(null); else setEdit({ ...edit, bad: true }); }); }}>
                      <input className={`input ${edit.bad ? 'bad' : ''}`} value={edit.text} maxLength={60} autoFocus spellCheck={false} aria-label={t('libRename')} title={edit.bad ? t('libRenameExists') : undefined}
                        onChange={(ev) => setEdit({ id: e.id, text: ev.target.value })} onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); setEdit(null); } }} />
                      <button type="submit" className="btn small" disabled={!edit.text.trim()}>{t('libSaveBtn')}</button>
                      {edit.bad && <span className="small bad">{t('libRenameExists')}</span>}
                    </form>
                  ) : (
                    <>
                      <button className="lib-pick" onClick={() => { void applyFromLibrary(picker.slot, e.id); }}>
                        <span className="lib-name ellipsis">{e.name}</span>
                        <span className="lib-meta small muted">{e.kind.toUpperCase()} · {t(e.family === 'gr3' ? 'libFamilyGr3' : 'libFamilyGr4')} · {e.date ? new Date(e.date).toLocaleDateString() : ''}</span>
                      </button>
                      <button className="btn ghost small" title={t('libRename')} aria-label={t('libRename')} onClick={() => setEdit({ id: e.id, text: e.name })}>{t('libRename')}</button>
                    </>
                  )}
                  <button className="btn ghost icon-only" title={t('libDelete')} aria-label={t('libDelete')} onClick={() => { void deleteLibraryEntry(e.id); }}>{Ico.x}</button>
                </li>
              ))}
            </ul>
            <div className="dialog-actions"><button className="btn" onClick={closeLibrary}>{t('done')}</button></div>
          </>
        )}
      </div>
    </div>
  );
}
