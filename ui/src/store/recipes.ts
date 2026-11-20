import { card, usermode } from '@grmod/core';
import type { CameraModel } from '@grmod/core';
import { host, HostError, isMobile, sha256Hex } from '../host';
import { t } from '../i18n';
import { State, ask, fail, isGr3, set, state, toast } from './core';
import { scheduleSave } from './families';
import { doneToast, refreshVolumes } from './output';

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

/** Recipes as saved in the project: valid names, known settings and choices only (else none). */
export function savedRecipes(v: unknown): Recipe[] {
  if (!Array.isArray(v)) return [];
  const out: Recipe[] = [];
  for (const r of v.slice(0, MAX_RECIPES)) {
    if (!r || typeof r.name !== 'string' || !usermode.validRecipeName(r.name)) continue;
    const values: Recipe['values'] = {};
    for (const s of usermode.RECIPE_SETTINGS) {
      const c = r.values?.[s.id];
      if (typeof c === 'string' && s.choices.some((x) => x.id === c)) values[s.id] = c;
    }
    out.push({ name: r.name, values });
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
  r.name = freeName(from ? from.name : t('recipeNew'));
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

export function recipeNameProblem(r: Recipe, s: State = state): string | null {
  if (!usermode.validRecipeName(r.name)) return t('recipeNameRule', { n: usermode.RECIPE_NAME_MAX });
  if (s.recipes.filter((x) => x.name.toLowerCase() === r.name.toLowerCase()).length > 1) return t('recipeNameTaken');
  return null;
}
export const recipeCount = (r: Recipe): number => Object.keys(r.values).length;
/** A recipe can be written: a usable name and at least one setting. */
export const recipeReady = (r: Recipe | undefined, s: State = state): boolean => !!r && !recipeNameProblem(r, s) && recipeCount(r) > 0;

/** The model the script is written for: the chosen GR IV model (the script itself runs on any GR IV). */
const recipeModel = (m: CameraModel): usermode.RecipeModel => (m === 'MONO' || m === 'HDF' ? m : 'STANDARD');
const doneId = (): string => Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
const stamp = (): string => { const d = new Date(); const p = (n: number): string => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

/**
 * Write the selected recipe: to the selected card (the firmware file and an earlier script are moved
 * aside, the factory-menu entry files added where missing), or as files into a folder.
 */
export async function writeRecipe(dest: 'card' | 'folder'): Promise<void> {
  const r = state.recipes[state.activeRecipe];
  const info = state.info;
  if (!r || !info || state.busy || !recipesOffered()) return;
  if (!recipeReady(r)) { toast(recipeNameProblem(r) ?? t('recipeEmpty'), 'error'); return; }
  const model = recipeModel(state.model);
  const lines = usermode.RECIPE_SETTINGS.filter((s) => r.values[s.id] !== undefined && !(s.colourOnly && model === 'MONO'))
    .map((s) => `${t(('rcp_' + s.id) as Parameters<typeof t>[0])}  ·  ${usermode.recipeChoice(s.id, r.values[s.id]!)!.label}`);
  if (!(await ask(t('recipeConfirmTitle', { name: r.name }), lines, t('confirmOk')))) return;
  let root: string; let volume = undefined as (typeof state.volumes)[number] | undefined;
  if (dest === 'card') {
    volume = state.volumes.find((v) => v.id === state.volumeId);
    if (!volume) { toast(t('noCard'), 'error'); return; }
    root = volume.root;
  } else {
    const p = await host.pickDirectory(t('pickFolder'));
    if (!p) return;
    root = p;
  }
  try {
    set({ busy: t('writing') });
    const script = usermode.recipeScript(r, model, doneId());
    let steps: card.PlanStep[];
    if (volume) {
      const rootEntries = await host.list(root);
      const scriptDir = rootEntries.find((e) => e.dir && e.name.toLowerCase() === card.SCRIPT_DIR);
      const listing: card.CardListing = { root: rootEntries, script: scriptDir ? await host.list(host.join(root, scriptDir.name)) : [] };
      steps = card.planRecipeCard(listing, info.factoryEntry.files, script, usermode.isRecipeDoneFile, stamp());
    } else {
      steps = card.planRecipeCard({ root: [], script: [] }, info.factoryEntry.files, script, usermode.isRecipeDoneFile, stamp());
    }
    let moved = 0;
    for (const st of steps) {
      if (st.op === 'move') { await host.move(host.join(root, ...st.from), host.join(root, ...st.to)); moved++; continue; }
      const res = await host.write(host.join(root, ...st.path), st.data);
      if (res.size !== st.data.length || res.sha256 !== (await sha256Hex(st.data))) throw new HostError('verify', t('verifyFailed'));
    }
    set({ busy: undefined });
    doneToast(root, volume, moved, host.join(card.SCRIPT_DIR, card.SCRIPT_FILE));
  } catch (e) { set({ busy: undefined }); fail(e); }
  void refreshVolumes();
}
