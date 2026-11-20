import { useState } from 'react';
import { usermode } from '@grmod/core';
import { DropZone, Ico, Menu, Segmented, Select } from '../components';
import { FirmwareHero } from '../firmware';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { MAX_RECIPES, addRecipe, addSuggested, loadFirmwareFile, recipeCount, recipeNameProblem, recipeProblem, removeRecipe, renameRecipe, selectRecipe, setRecipeValue, useStore } from '../store';
import { isFirmware } from './files';

// ---------------------------------------------------------------- user mode recipes (GR IV)
const KEEP = '__keep';
/** The groups of the settings list, in the camera's menu order (A1 focus, A2 exposure, A4 file, A5 image). */
const GROUPS: { title: Key; ids: usermode.RecipeSettingId[] }[] = [
  { title: 'rcpGroupExposure', ids: ['aperture', 'exposureComp', 'metering', 'isoAuto', 'isoUpper', 'isoLower', 'minShutter', 'nd'] },
  { title: 'rcpGroupFocus', ids: ['focus', 'snapDistance', 'fullPressSnap'] },
  { title: 'rcpGroupImage', ids: ['fileFormat', 'imageControl', 'whiteBalance', 'highlightCorrection', 'shadowCorrection', 'shakeReduction'] },
];

function SettingRow({ index, id, mono }: { index: number; id: usermode.RecipeSettingId; mono: boolean }) {
  const value = useStore((s) => s.recipes[index]?.values[id]);
  const why = useStore((s) => s.recipes[index]?.why?.[id]);
  const s = usermode.recipeSetting(id);
  const label = t(`rcp_${id}` as Key);
  if (s.colourOnly && mono) return null;
  return (
    <div className={`recipe-row ${value === undefined ? 'keep' : ''}`}>
      <div className="recipe-line">
        <span className="recipe-label">{label}</span>
        <Select<string>
          variant="box" label={label} value={value ?? KEEP}
          onChange={(v) => setRecipeValue(index, id, v === KEEP ? undefined : v)}
          options={[{ value: KEEP, label: t('rcpKeep') }, ...s.choices.map((c) => ({ value: c.id, label: c.label }))]}
        />
      </div>
      {why && value !== undefined && <p className="recipe-why">{t(`why_${why}` as Key)}</p>}
    </div>
  );
}

function RecipeEditor({ index }: { index: number }) {
  const r = useStore((s) => s.recipes[index]);
  const problem = useStore((s) => (s.recipes[index] ? recipeNameProblem(s.recipes[index], s) : null));
  const other = useStore((s) => (s.recipes[index] && !problem ? recipeProblem(s.recipes[index], s) : null));
  const count = useStore((s) => (s.recipes[index] ? recipeCount(s.recipes[index], s) : 0));
  const mono = useStore((s) => s.model === 'MONO');
  if (!r) return null;
  return (
    <div className="card recipe-card" data-tour="recipe-editor">
      <div className="recipe-head">
        <input
          className={`input recipe-name ${problem ? 'bad' : ''}`} value={r.name} maxLength={usermode.RECIPE_NAME_MAX} spellCheck={false}
          placeholder={t('name')} aria-label={t('name')} title={problem ?? undefined} onChange={(e) => renameRecipe(index, e.target.value)}
        />
        <span className="muted small">{t('rcpCount', { n: count })}</span>
        <span className="grow" />
        <button className="btn ghost icon-only" title={t('remove')} aria-label={t('remove')} onClick={() => removeRecipe(index)}>{Ico.trash}</button>
      </div>
      {(problem || (other && count > 0)) && <p className="small bad-text">{problem ?? other}</p>}
      <div className="recipe-groups">
        {GROUPS.map((g) => (
          <div key={g.title} className="recipe-group">
            <span className="muted small">{t(g.title)}</span>
            {g.ids.map((id) => <SettingRow key={id} index={index} id={id} mono={mono} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- guided questions
/** Each question: its title key and its answers (text keys `<key>_<answer>`). */
const QUESTIONS: Record<keyof usermode.Answers, { key: 'qPlace' | 'qLight' | 'qSubject' | 'qLook' | 'qFile'; values: readonly string[] }> = {
  place: { key: 'qPlace', values: usermode.PLACES },
  light: { key: 'qLight', values: usermode.LIGHTS },
  subject: { key: 'qSubject', values: usermode.SUBJECTS },
  look: { key: 'qLook', values: usermode.LOOKS },
  file: { key: 'qFile', values: usermode.FILES },
};

/** A few plain questions; the recipe they give comes with the reason of each value. */
function RecipeWizard({ onDone }: { onDone: () => void }) {
  const [a, setA] = useState<usermode.Answers>({ place: 'outdoor', light: 'sun', subject: 'street', look: 'warm', file: 'raw' });
  const row = (k: keyof usermode.Answers) => {
    const q = QUESTIONS[k];
    return (
      <div className="wizard-q" key={k}>
        <span className="recipe-label">{t(q.key)}</span>
        <Segmented<string> value={a[k]} onChange={(v) => setA({ ...a, [k]: v })} options={q.values.map((v) => ({ value: v, label: t(`${q.key}_${v}` as Key) }))} />
      </div>
    );
  };
  return (
    <div className="card recipe-card wizard" data-tour="recipe-wizard">
      <b>{t('qTitle')}</b>
      {row('place')}
      {a.place === 'outdoor' || a.light === 'overcast' ? row('light') : null}
      {a.place === 'indoor' && <p className="muted small">{t('qIndoorNote')}</p>}
      {row('subject')}
      {row('look')}
      {row('file')}
      <div className="recipe-head">
        <span className="grow" />
        <button className="btn" onClick={onDone}>{t('cancel')}</button>
        <button className="btn primary" onClick={() => { addSuggested(a); onDone(); }}>{t('qCreate')}</button>
      </div>
    </div>
  );
}

/** How the card is used in the camera: the factory menu once, then one power-on, then the camera's own menus. */
function RecipeSteps() {
  return (
    <div className="card recipe-steps" data-tour="recipe-steps">
      <b>{t('rcpStepsTitle')}</b>
      <ol className="small">
        <li>{t('rcpStep1')}</li>
        <li>{t('rcpStep2')}</li>
        <li>{t('rcpStep3')}</li>
        <li>{t('rcpStep4')}</li>
      </ol>
      <p className="muted small">{t('rcpNote')}</p>
    </div>
  );
}

export function ModesPage() {
  const info = useStore((s) => s.info);
  const recipes = useStore((s) => s.recipes);
  const active = useStore((s) => s.activeRecipe);
  const full = recipes.length >= MAX_RECIPES;
  const [wizard, setWizard] = useState(false);
  const addItems = [
    { label: t('rcpAddGuided'), run: () => setWizard(true), disabled: full },
    { label: t('rcpAddEmpty'), run: () => addRecipe(), disabled: full },
    ...usermode.EXAMPLE_RECIPES.map((x, i) => ({ label: t('rcpAddExample', { name: x.name }), run: () => addRecipe(i), disabled: full })),
  ];
  return (
    <DropZone className="page" accept={isFirmware} onFiles={(f) => { void loadFirmwareFile(f[0]); }}>
      <header className="page-head">
        <span className="page-icon">{Ico.dial}</span>
        <h1>{t('navModes')}</h1>
      </header>
      {!info && <FirmwareHero />}
      {info && (
        <div className="modes-page" data-tour-page="modes">
          <p className="muted small">{t('rcpSub')}</p>
          <div className="recipe-tabs" data-tour="recipe-add">
            {recipes.map((r, i) => (
              <button key={i} type="button" className={`btn small ${i === active ? 'primary' : ''}`} onClick={() => selectRecipe(i)}>{r.name || t('rcpUnnamed')}</button>
            ))}
            <span className="grow" />
            {/* at the end of the row: the menu opens towards the left, over the page */}
            <Menu items={addItems}><span className="btn small">{Ico.plus}<span>{t('rcpAdd')}</span></span></Menu>
          </div>
          {wizard && <RecipeWizard onDone={() => setWizard(false)} />}
          {!wizard && (recipes.length === 0 ? <p className="muted">{t('rcpEmptyList')}</p> : <RecipeEditor index={Math.min(active, recipes.length - 1)} />)}
          <RecipeSteps />
        </div>
      )}
    </DropZone>
  );
}
