import { card, usermode } from '@grmod/core';
import type { CameraModel } from '@grmod/core';
import { host, isMobile } from '../host';
import { t } from '../i18n';
import { State, ask, fail, isGr3, set, state, toast } from './core';
import { scheduleSave } from './families';
import { doneToast, freshStamp, listing, refreshVolumes, runPlan } from './output';

type Recipe = usermode.Recipe;
type SettingId = usermode.RecipeSettingId;

/**
 * User mode recipes (GR IV): settings the camera applies once from a start-up script on the card,
 * to be saved there to a User Mode Box or the mode dial (core usermode/recipe.ts). Kept with the
 * GR IV's work; the firmware is only needed for the factory-menu entry files.
 */
export const MAX_RECIPES = 12;

/** The recipes page: GR IV firmware (or none open yet with a GR IV chosen), on a computer (it writes a card). */
export function recipesOffered(s: State = state): boolean {
  if (isMobile) return false;
  return s.info ? s.info.family === 'gr4' && s.info.capabilities.factoryEntry : !isGr3(s.model);
}

/**
 * Recipes as saved in the project, with known settings and choices only. A name is kept as typed,
 * even one that cannot be written yet (being edited when the app closed): it is checked on writing.
 */
export function savedRecipes(v: unknown): Recipe[] {
  if (!Array.isArray(v)) return [];
  const out: Recipe[] = [];
  for (const r of v.slice(0, MAX_RECIPES)) {
    if (!r || typeof r !== 'object') continue;
    const values: Recipe['values'] = {};
    for (const s of usermode.RECIPE_SETTINGS) {
      const c = r.values?.[s.id];
      if (typeof c === 'string' && s.choices.some((x) => x.id === c)) values[s.id] = c;
    }
    out.push({ name: typeof r.name === 'string' ? r.name.slice(0, 40) : '', values });
  }
  return out;
}

const copy = (r: Recipe): Recipe => ({ name: r.name, values: { ...r.values } });
/** A name not used yet: `base`, else `base 2`, `base 3`, ... */
function freeName(base: string, s: State = state): string {
  const used = new Set(s.recipes.map((r) => r.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) { const name = `${base.slice(0, usermode.RECIPE_NAME_MAX - 3)} ${n}`; if (!used.has(name.toLowerCase())) return name; }
}

function patchRecipe(index: number, f: (r: Recipe) => Recipe): void {
  set((s) => ({ recipes: s.recipes.map((r, i) => (i === index ? f(r) : r)) }));
  scheduleSave();
}
export function selectRecipe(index: number): void { if (index >= 0 && index < state.recipes.length) set({ activeRecipe: index }); }
/** A new recipe: empty, or a copy of an example. */
export function addRecipe(example?: number): void {
  if (state.recipes.length >= MAX_RECIPES) return;
  const from = example !== undefined ? usermode.EXAMPLE_RECIPES[example] : undefined;
  const r: Recipe = from ? copy(from) : { name: '', values: {} };
  // The script takes ASCII names only: the default is the same in every language.
  r.name = freeName(from ? from.name : 'Recipe');
  set((s) => ({ recipes: [...s.recipes, r], activeRecipe: s.recipes.length }));
  scheduleSave();
}
export function removeRecipe(index: number): void {
  set((s) => {
    const recipes = s.recipes.filter((_, i) => i !== index);
    return { recipes, activeRecipe: Math.max(0, Math.min(s.activeRecipe, recipes.length - 1)) };
  });
  scheduleSave();
}
/** The name as typed; checked when written (recipeNameProblem). */
export function renameRecipe(index: number, name: string): void { patchRecipe(index, (r) => ({ ...r, name: name.slice(0, 40) })); }
/** One setting: a choice id, or undefined to leave it as the camera has it. */
export function setRecipeValue(index: number, id: SettingId, choice: string | undefined): void {
  patchRecipe(index, (r) => {
    const values = { ...r.values };
    if (choice === undefined) delete values[id]; else values[id] = choice;
    return { ...r, values };
  });
}

/** The model the script is written for: the chosen GR IV model (the Monochrome has no colour settings). */
const recipeModel = (m: CameraModel): usermode.RecipeModel => (m === 'MONO' || m === 'HDF' ? m : 'STANDARD');

export function recipeNameProblem(r: Recipe, s: State = state): string | null {
  if (!usermode.validRecipeName(r.name)) return t('recipeNameRule', { n: usermode.RECIPE_NAME_MAX });
  if (s.recipes.filter((x) => x.name.toLowerCase() === r.name.toLowerCase()).length > 1) return t('recipeNameTaken');
  return null;
}
/** What keeps the recipe from being written, as shown: its name, nothing to set, or the ISO Auto limits. */
export function recipeProblem(r: Recipe, s: State = state): string | null {
  const name = recipeNameProblem(r, s);
  if (name) return name;
  const p = usermode.recipeProblem(r, recipeModel(s.model));
  return p === 'empty' ? t('recipeEmpty') : p === 'iso-limits' ? t('recipeIsoLimits') : null;
}
/** The settings the recipe changes on the chosen model. */
export const recipeCount = (r: Recipe, s: State = state): number => usermode.recipeSettingsFor(r, recipeModel(s.model)).length;
export const recipeReady = (r: Recipe | undefined, s: State = state): boolean => !!r && !recipeProblem(r, s);
const doneId = (): string => Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
/** A write in progress (set before the first await: a second click waits for nothing and does nothing). */
let writing = false;

/**
 * Write the selected recipe: to the selected card (the firmware file and an earlier script are moved
 * aside, the factory-menu entry files added where missing), or as files into a folder.
 */
export async function writeRecipe(dest: 'card' | 'folder'): Promise<void> {
  const r = state.recipes[state.activeRecipe];
  const info = state.info;
  if (!r || !info || state.busy || writing || !recipesOffered()) return;
  const problem = recipeProblem(r);
  if (problem) { toast(problem, 'error'); return; }
  writing = true;
  try {
    const model = recipeModel(state.model);
    const lines = usermode.recipeSettingsFor(r, model).map((s) => `${t(('rcp_' + s.id) as Parameters<typeof t>[0])}  ·  ${usermode.recipeChoice(s.id, r.values[s.id]!)!.label}`);
    if (!(await ask(t('recipeConfirmTitle', { name: r.name }), lines, t('confirmOk')))) return;
    const volume = dest === 'card' ? state.volumes.find((v) => v.id === state.volumeId) : undefined;
    if (dest === 'card' && !volume) { toast(t('noCard'), 'error'); return; }
    const root = volume ? volume.root : await host.pickDirectory(t('pickFolder'));
    if (!root) return;
    set({ busy: t('writing') });
    const script = usermode.recipeScript(r, model, doneId());
    const steps = card.planRecipeCard(volume ? await listing(root) : { root: [], script: [] }, info.factoryEntry.files, script, usermode.isRecipeDoneFile, await freshStamp(root));
    const moved = await runPlan(root, steps);
    set({ busy: undefined });
    doneToast(root, volume, moved, host.join(card.SCRIPT_DIR, card.SCRIPT_FILE));
  } catch (e) { set({ busy: undefined }); fail(e); } finally { writing = false; }
  void refreshVolumes();
}
