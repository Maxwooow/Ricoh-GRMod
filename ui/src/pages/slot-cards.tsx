import { useRef, useState } from 'react';
import { EXTRA_NAME_MAX, MAX_EXTRA_SLOTS } from '@grmod/core';
import type { SlotId } from '@grmod/core';
import { DropZone, FileButton, Ico, IconCanvas, Prop, Segmented, Select } from '../components';
import { isMobile } from '../host';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { loadIconImage, loadPresetFile, nameProblem, exportSlotCubeFile, removePreset, setActiveSlot, setIcon, setName, useStore, extraName, extraNameProblem, extraProblem, halationOf, removeExtraSlot, setExtraCount, setExtraName, setHalation, filmCountChoosable, removeFilm, setFilmCount, duplicateExtraProblem, duplicateExtraSlot, loadPresetFiles, halationAllOffered } from '../store';
import type { ExtraSlot, SlotKey } from '../store';
import { isPreset } from './files';

/** A slot card lights up for a drag that may hold a preset: anything but only pictures (.cube and .xmp have no fixed MIME type). */
const notOnlyImages = (types: readonly string[]): boolean => types.length === 0 || types.some((x) => !x.startsWith('image/'));
import { LibraryButtons } from '../library';

export function SlotCard({ id }: { id: SlotId }) {
  const slot = useStore((s) => s.slots[id]);
  // GR III / IIIx: Halation is set in the camera; here only the preview level.
  const choosable = useStore((s) => filmCountChoosable(s));
  const info = useStore((s) => s.info)!;
  const lang = useStore((s) => s.lang);
  const active = useStore((s) => s.activeSlot === id);
  const off = info.slots.find((x) => x.id === id)!;
  const gr3x = info.family === 'gr3x';
  const name = slot.names[lang] ?? '';
  const cap = off.names[lang].capacity;
  const problem = nameProblem(info, id, lang, name);
  const p = slot.preset;
  const first = id === 'CY'; // the one the tour points at
  const haloAll = useStore((st) => halationAllOffered(st));
  return (
    <DropZone className={`card ${active ? 'on' : ''}`} tour={first ? 'ic-slot' : undefined} accept={isPreset} highlight={notOnlyImages} onFiles={(f) => { void loadPresetFiles(f, id); }}>
      <div className="card-in" {...pick(() => setActiveSlot(id))}>
        <div className="card-head">
          <IconCanvas pixels={slot.icon.mode !== 'keep' && slot.icon.pixels ? slot.icon.pixels : off.icon} />
          <div className="card-title" data-tour={first ? 'ic-name' : undefined}>
            <NameInput className={`title-input ${problem ? 'bad' : ''}`} value={name} placeholder={off.names[lang].text} onChange={(v) => setName(id, lang, v)} />
            <div className="sub">
              <span className="ellipsis">{gr3x ? off.defaultName : t(('slot' + id) as Key)}</span>
              <span className={`count ${problem ? 'bad' : ''}`}>{problem || `${name.length || off.names[lang].text.length}/${cap}`}</span>
            </div>
          </div>
          {choosable && <button className="btn ghost icon-only extra-x" title={t('extraRemove')} aria-label={t('extraRemove')} onClick={() => removeFilm(id)}>{Ico.x}</button>}
        </div>
        <div className="props">
          <Prop label={t('preset')} tour={first ? 'ic-preset' : undefined}>
            <div className="preset">
              {!p && <FileButton className="btn dashed fill" accept=".xmp,.cube" multiple onFiles={(f) => { void loadPresetFiles(f, id); }}>{Ico.plus}<span>{t('dropPreset')}</span></FileButton>}
              {p && (
                <div className={`file-chip ${p.error ? 'bad' : ''}`}>
                  <FileButton className="file-main" accept=".xmp,.cube" title={t('replace')} onFiles={(f) => { void loadPresetFile(id, f[0]); }}>{Ico.file}<span className="ellipsis">{p.result?.title || p.fileName}</span></FileButton>
                  <button className="file-x" title={t('remove')} aria-label={t('remove')} onClick={() => removePreset(id)}>{Ico.x}</button>
                </div>
              )}
              {gr3x && p?.result && <p className="small muted">{t('gr3xFit', { mean: p.result.meanDE.toFixed(1), p95: p.result.p95DE.toFixed(1) })}{p.result.p95DE > 6 && <><br />{t('gr3xFitPoor')}</>}</p>}
              {(p?.busy || p?.error) && (
                <div className="chips">
                  {p.busy && <span className="chip muted"><span className="spinner small" />{t('converting')}</span>}
                  {p.error && <span className="chip bad" title={p.error}><span className="ellipsis">{p.error}</span></span>}
                </div>
              )}
              {/* the preset's small actions in one row under the file (or the drop area) */}
              <div className="chips preset-actions">
                {p?.result && <button className="btn small" title={t('exportCubeTip')} onClick={() => { void exportSlotCubeFile(id); }}>{t('exportCube')}</button>}
                <LibraryButtons k={id} />
              </div>
            </div>
          </Prop>
          <Prop label={t('icon')} tour={first ? 'ic-icon' : undefined}>
            <div className="chips">
              <Segmented value={slot.icon.mode} onChange={(mode) => setIcon(id, { mode })} options={[{ value: 'keep', label: t('iconKeep') }, { value: 'text', label: t('iconText') }, { value: 'image', label: t('iconImage') }]} />
              {slot.icon.mode !== 'keep' && <Segmented value={slot.icon.style} onChange={(style) => setIcon(id, { style })} options={[{ value: 'film', label: t('styleFilm') }, { value: 'plain', label: t('stylePlain') }]} />}
              {slot.icon.mode === 'text' && <input className="input short" value={slot.icon.text} maxLength={8} spellCheck={false} placeholder="400" aria-label={t('iconText')} onChange={(e) => setIcon(id, { text: e.target.value })} />}
              {slot.icon.mode === 'image' && <FileButton className="btn small" accept="image/*" onFiles={(f) => { void loadIconImage(id, f[0]); }}>{t('chooseImage')}</FileButton>}
            </div>
          </Prop>
          {(gr3x || p?.result) && !haloAll && <HalationProp k={id} />}
        </div>
      </div>
    </DropZone>
  );
}

/** GR III / IIIx: how many films are added (0 to maxFilms), laid out as GR IV's added slots (ExtrasHead). */
export function FilmCountHead() {
  const n = useStore((s) => s.filmCount);
  const max = useStore((s) => s.info?.features.maxFilms ?? 9);
  const options = Array.from({ length: max + 1 }, (_, i) => ({ value: String(i), label: String(i) }));
  return (
    <div className="card extras-head" data-tour="ic-extra">
      <div className="extras-row">
        <span className="page-icon soft-ico">{Ico.plus}</span>
        <div className="soft-text">
          <b>{t('extraTitle')}</b>
          <span className="muted small ellipsis">{t('filmCountSub', { n: max })}</span>
        </div>
      </div>
      <div className="extras-count"><Select variant="box" value={String(n)} onChange={(v) => setFilmCount(Number(v))} options={options} label={t('extraTitle')} /></div>
    </div>
  );
}

/** How many slots are added (0 to MAX_EXTRA_SLOTS). */
export function ExtrasHead() {
  const n = useStore((s) => s.extras.length);
  const options = Array.from({ length: MAX_EXTRA_SLOTS + 1 }, (_, i) => ({ value: String(i), label: String(i) }));
  return (
    <div className="card extras-head" data-tour="ic-extra">
      <div className="extras-row">
        <span className="page-icon soft-ico">{Ico.plus}</span>
        <div className="soft-text">
          <b>{t('extraTitle')}</b>
          <span className="muted small ellipsis">{t('extraSub', { n: MAX_EXTRA_SLOTS })}</span>
        </div>
      </div>
      <div className="extras-count"><Select variant="box" value={String(n)} onChange={(v) => setExtraCount(Number(v))} options={options} label={t('extraTitle')} /></div>
    </div>
  );
}

/**
 * A look's name. On the desktop a field that is always editable; on a phone the name is plain text and a pencil
 * beside it opens it for editing (a touch near the name while scrolling must not bring up the keyboard).
 */
function NameInput({ className, value, placeholder, maxLength, onChange }: { className: string; value: string; placeholder: string; maxLength?: number; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const field = (
    <input
      ref={ref} className={className} value={value} placeholder={placeholder} maxLength={maxLength} spellCheck={false} aria-label={t('name')}
      readOnly={isMobile && !editing} tabIndex={isMobile && !editing ? -1 : undefined} enterKeyHint="done"
      onChange={(e) => onChange(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={(e) => { if (isMobile && e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
  if (!isMobile) return field;
  const edit = (): void => {
    setEditing(true);
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); } });
  };
  return (
    <div className={`name-edit ${editing ? 'on' : ''}`}>
      {field}
      <button type="button" className="btn ghost icon-only name-pen" aria-label={t('rename')} onPointerDown={(e) => { if (editing) e.preventDefault(); }} onClick={() => (editing ? ref.current?.blur() : edit())}>{editing ? Ico.check : Ico.pen}</button>
    </div>
  );
}

/**
 * Makes a card the current one when it is used. On the desktop as soon as it is pressed; on a phone only on a
 * tap or when one of its fields takes the focus, so that scrolling the page over the cards does not pick one.
 */
export function pick(run: () => void): React.HTMLAttributes<HTMLDivElement> {
  return isMobile ? { onClickCapture: run, onFocusCapture: run } : { onPointerDownCapture: run, onFocusCapture: run };
}

/** An added slot: one name for every language (ASCII), a preset, an icon. */
export function ExtraSlotCard({ x, index }: { x: ExtraSlot; index: number }) {
  const active = useStore((s) => s.activeSlot === x.key);
  const name = useStore((s) => extraName(x, s));
  const nameBad = useStore((s) => extraNameProblem(x, s));
  const dupProblem = useStore((s) => duplicateExtraProblem(s));
  const problem = useStore((s) => extraProblem(x, s));
  const tile = useStore((s) => s.info!.tiles[x.icon.style]);
  const p = x.preset;
  const k = x.key;
  const haloAll = useStore((st) => halationAllOffered(st));
  return (
    <DropZone className={`card ${active ? 'on' : ''}`} accept={isPreset} highlight={notOnlyImages} onFiles={(f) => { void loadPresetFiles(f, k); }}>
      <div className="card-in" {...pick(() => setActiveSlot(k))}>
        <div className="card-head">
          <IconCanvas pixels={x.icon.pixels ?? tile} />
          <div className="card-title">
            <NameInput className={`title-input ${nameBad ? 'bad' : ''}`} value={x.name} placeholder={name} maxLength={40} onChange={(v) => setExtraName(k, v)} />
            <div className="sub">
              <span className="ellipsis">{t('extraSlot', { n: index + 1 })}</span>
              <span className={`count ${nameBad ? 'bad' : ''}`}>{nameBad || `${name.length}/${EXTRA_NAME_MAX}`}</span>
            </div>
          </div>
          <button className="btn ghost icon-only extra-x" title={dupProblem ?? t('extraDuplicate')} aria-label={t('extraDuplicate')} disabled={!!dupProblem} onClick={() => duplicateExtraSlot(k)}>{Ico.copy}</button>
          <button className="btn ghost icon-only extra-x" title={t('extraRemove')} aria-label={t('extraRemove')} onClick={() => removeExtraSlot(k)}>{Ico.x}</button>
        </div>
        <div className="props">
          <Prop label={t('preset')}>
            <div className="preset">
              {!p && <FileButton className="btn dashed fill" accept=".xmp,.cube" multiple onFiles={(f) => { void loadPresetFiles(f, k); }}>{Ico.plus}<span>{t('dropPreset')}</span></FileButton>}
              {p && (
                <div className={`file-chip ${p.error ? 'bad' : ''}`}>
                  <FileButton className="file-main" accept=".xmp,.cube" title={t('replace')} onFiles={(f) => { void loadPresetFile(k, f[0]); }}>{Ico.file}<span className="ellipsis">{p.result?.title || p.fileName}</span></FileButton>
                  <button className="file-x" title={t('remove')} aria-label={t('remove')} onClick={() => removePreset(k)}>{Ico.x}</button>
                </div>
              )}
              {(p?.busy || p?.error) && (
                <div className="chips">
                  {p.busy && <span className="chip muted"><span className="spinner small" />{t('converting')}</span>}
                  {p.error && <span className="chip bad" title={p.error}><span className="ellipsis">{p.error}</span></span>}
                </div>
              )}
              {/* the preset's small actions in one row under the file (or the drop area) */}
              <div className="chips preset-actions">
                {p?.result && <button className="btn small" title={t('exportCubeTip')} onClick={() => { void exportSlotCubeFile(k); }}>{t('exportCube')}</button>}
                <LibraryButtons k={k} />
              </div>
            </div>
          </Prop>
          <Prop label={t('icon')}>
            <div className="chips">
              <Segmented value={x.icon.mode === 'image' ? 'image' : 'text'} onChange={(mode) => setIcon(k, { mode })} options={[{ value: 'text', label: t('iconText') }, { value: 'image', label: t('iconImage') }]} />
              <Segmented value={x.icon.style} onChange={(style) => setIcon(k, { style })} options={[{ value: 'film', label: t('styleFilm') }, { value: 'plain', label: t('stylePlain') }]} />
              {x.icon.mode !== 'image' && <input className="input short" value={x.icon.text} maxLength={8} spellCheck={false} placeholder="400" aria-label={t('iconText')} onChange={(e) => setIcon(k, { text: e.target.value })} />}
              {x.icon.mode === 'image' && <FileButton className="btn small" accept="image/*" onFiles={(f) => { void loadIconImage(k, f[0]); }}>{t('chooseImage')}</FileButton>}
            </div>
          </Prop>
          {!haloAll && <HalationProp k={x.key} />}
          {problem && !p?.busy && !p?.error && !nameBad && <div className="chips extra-problem"><span className="chip warn"><span className="ellipsis">{problem}</span></span></div>}
        </div>
      </div>
    </DropZone>
  );
}

/**
 * A slot's halation, and the level and colour the preview shows. The look is fixed (fitted to
 * CineStill 800T); in the camera it is set on the slot's parameter screen ("Halation": Off / On, Fn
 * for Strength Weak / Medium / Strong and Colour red / white). Every added slot has it; Cinema
 * Yellow / Green only with a preset (their Toning then does nothing and becomes Halation) and when
 * it is switched on here.
 */
function HalationProp({ k }: { k: SlotKey }) {
  const on = useStore((s) => halationOf(k, s).on);
  const preview = useStore((s) => halationOf(k, s).preview);
  const colour = useStore((s) => halationOf(k, s).colour ?? 'red');
  // GR III / IIIx films all have it, as GR IV's added slots (legacy builds without a film count fix the level).
  const gr3x = useStore((s) => s.info?.family === 'gr3x');
  const fixed = useStore((s) => s.info?.family === 'gr3x' && !filmCountChoosable(s));
  const cinema = !k.startsWith('x-') && !gr3x;
  return (
    <Prop label={t('haloLabel')}>
      <div className="halo">
        {cinema && (
          <div className="chips">
            <Segmented value={on ? 'on' : 'off'} onChange={(v) => setHalation(k, { on: v === 'on' })} options={[{ value: 'off', label: t('haloOff') }, { value: 'on', label: t('haloOn') }]} />
          </div>
        )}
        {on && (
          <div className="chips">
            <span className="muted small">{t('haloPreview')}</span>
            {/* GR III / IIIx legacy builds (no film count) fix Weak or Strong red in the build: those only. */}
            <Segmented value={String(fixed && preview === 2 ? 3 : preview)} onChange={(v) => setHalation(k, { preview: Number(v) as 0 | 1 | 2 | 3 })} options={fixed
              ? [{ value: '0', label: t('haloOff') }, { value: '1', label: t('haloWeak') }, { value: '3', label: t('haloStrong') }]
              : [{ value: '0', label: t('haloOff') }, { value: '1', label: t('haloWeak') }, { value: '2', label: t('haloMedium') }, { value: '3', label: t('haloStrong') }]} />
            {preview > 0 && !fixed && <Segmented value={colour} onChange={(v) => setHalation(k, { colour: v as 'red' | 'white' })} options={[{ value: 'red', label: t('haloRed') }, { value: 'white', label: t('haloWhite') }]} />}
          </div>
        )}
      </div>
    </Prop>
  );
}
