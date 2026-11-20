// User mode recipes (GR IV): a set of shooting settings put on the card as a start-up script that
// the camera runs once, so that a whole setup can be saved to a User Mode Box or the mode dial in
// one menu action instead of setting each value by hand.
//
// How the camera takes them (GR IV 1.11 / 1.20 / 1.21, static analysis of 1.21; addresses are
// run-time addresses of 1.21):
//  - with Script enabled in the factory menu, the camera runs `C:\script\startup.ttl` at power-on
//    (the same interpreter as the power-off image rotation of GR Mod 0.7, wallpaper/script.ts);
//  - the script's `sendln` hands a line to the camera's debug shell (SHELLCMD section);
//  - the shell's `UserData` command (0x53008038) takes `Set <name> <value>` (0x534be364): one
//    branch per named property, each parsing its value (a word from a fixed list, or a number read
//    with strtof) and calling the setter on the settings object in use (0x550832A8, GR Mod's
//    CURRENT()); `Get` (0x53533214) prints the value on the debug console only;
//  - numbers are APEX values, as the camera keeps them: Av = 2 log2(N) (F8 = 6), Sv = log2(ISO/3.125)
//    (ISO 100 = 5), Tv = log2(1/t) (1/250 s = 8, the nominal 1/256), exposure compensation in EV;
//  - the settings in use are saved at power-off; stored modes (U1..U3) and boxes (BOX1..6) are not
//    reachable this way, and the name setters keep two characters only: the user saves the result
//    with Assign User Mode Dial / Save User Mode Box and types the name there.
// Checked on a GR IV 1.21: every kind of value below (word, snap distance, APEX number, negative
// EV) set from a card script and read back in the camera's menus.

import { RECIPE_SCRIPT_HEAD } from '../card/layout';
import { MODEL_FILE, MODEL_FILE_MAGIC, MODEL_INFO } from '../wallpaper/script';

/** The GR IV models a recipe script runs on (product bytes of `E:\BlkCtl15.bin`). */
export type RecipeModel = 'STANDARD' | 'HDF' | 'MONO';
export const RECIPE_MODELS: readonly RecipeModel[] = ['STANDARD', 'HDF', 'MONO'];

/** One choice of a setting: `id` is kept in projects, `value` is what the camera's shell takes, `label` is shown. */
export interface RecipeChoice { id: string; value: string; label: string }
/** A setting a recipe can change: the camera's property name and its choices, in menu order. */
export interface RecipeSetting { id: RecipeSettingId; property: string; choices: readonly RecipeChoice[]; /** Not offered on the GR IV Monochrome. */ colourOnly?: boolean }

const word = (value: string, label = value): RecipeChoice => ({ id: value, value, label });
/** APEX numbers go to the camera with four decimals (thirds: 3.3333, -0.6667). */
const apex = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return (Object.is(r, -0) ? 0 : r).toFixed(4).replace(/\.?0+$/, '');
};
/** Choices one third of a stop apart from `from`; the id is the label in ASCII (− as -). */
const thirds = (from: number, labels: readonly string[]): RecipeChoice[] =>
  labels.map((label, i) => ({ id: label.replace('−', '-'), value: apex(from + i / 3), label }));

const F_NUMBERS = ['F2.8', 'F3.2', 'F3.5', 'F4', 'F4.5', 'F5', 'F5.6', 'F6.3', 'F7.1', 'F8', 'F9', 'F10', 'F11', 'F13', 'F14', 'F16'] as const;
const ISO = ['100', '125', '160', '200', '250', '320', '400', '500', '640', '800', '1000', '1250', '1600', '2000', '2500', '3200', '4000', '5000', '6400', '8000', '10000', '12800', '16000', '20000', '25600'] as const;
/** Minimum shutter speed of ISO Auto, 1/8 s to 1/1000 s (APEX Tv 3 to 10). */
const SHUTTER = ['1/8', '1/10', '1/13', '1/15', '1/20', '1/25', '1/30', '1/40', '1/50', '1/60', '1/80', '1/100', '1/125', '1/160', '1/200', '1/250', '1/320', '1/400', '1/500', '1/640', '1/800', '1/1000'] as const;
/** Exposure compensation, -5 to +5 EV in thirds. */
const EV: string[] = Array.from({ length: 31 }, (_, i) => {
  const n = i - 15;
  if (n === 0) return '0.0';
  const whole = Math.trunc(Math.abs(n) / 3), third = Math.abs(n) % 3;
  return `${n < 0 ? '−' : '+'}${whole}.${third === 0 ? 0 : third === 1 ? 3 : 7}`;
});

export type RecipeSettingId =
  | 'aperture' | 'exposureComp' | 'focus' | 'snapDistance' | 'fullPressSnap' | 'metering'
  | 'isoAuto' | 'isoUpper' | 'isoLower' | 'minShutter' | 'nd' | 'fileFormat' | 'imageControl'
  | 'whiteBalance' | 'highlightCorrection' | 'shadowCorrection' | 'shakeReduction';

/**
 * The settings, in the order the script sets them (ISO Auto before its limits, the Image Control
 * set before the look). Words and number formats as the camera's `UserData Set` takes them.
 */
export const RECIPE_SETTINGS: readonly RecipeSetting[] = [
  { id: 'aperture', property: 'CommonAv', choices: thirds(3, F_NUMBERS) },
  { id: 'focus', property: 'StillFocus', choices: [word('AutoArea', 'Auto-area AF'), word('ZoneSelect', 'Zone Select AF'), word('Select', 'Select AF'), word('Pinpoint', 'Pinpoint AF'), word('Follow', 'Tracking AF'), word('Continuous', 'Continuous AF'), word('Snap', 'Snap'), word('Infinity', '∞')] },
  { id: 'snapDistance', property: 'StillSnapDistanceCm', choices: [word('100', '1m'), word('150', '1.5m'), word('200', '2m'), word('250', '2.5m'), word('350', '3.5m'), word('500', '5m'), word('Infinity', '∞')] },
  { id: 'fullPressSnap', property: 'StillFullPressSnap', choices: [word('On'), word('Off')] },
  { id: 'metering', property: 'StillAeMode', choices: [word('Multi', 'Multi-segment'), word('Center', 'Center-weighted'), word('Spot', 'Spot'), word('Highlight', 'Highlight-weighted')] },
  { id: 'isoAuto', property: 'StillSvAuto', choices: [word('On', 'AUTO'), word('Off', 'Manual')] },
  { id: 'isoUpper', property: 'StillSvAutoUpper', choices: thirds(5, ISO) },
  { id: 'isoLower', property: 'StillSvAutoLower', choices: thirds(5, ISO) },
  { id: 'minShutter', property: 'StillSvAutoLowerTv', choices: thirds(3, SHUTTER) },
  { id: 'nd', property: 'StillNdFilter', choices: [word('Auto'), word('Off')] },
  { id: 'fileFormat', property: 'StillStillRecordForm', choices: [word('Jpeg', 'JPEG'), word('Raw', 'RAW'), word('RawPlus', 'RAW+JPEG')] },
  { id: 'imageControl', property: 'StillImageControlNo0', colourOnly: true, choices: [
    word('Standard'), word('Vivid'), word('MonotoneGR', 'Monotone'), word('SoftMonotone', 'Soft Monotone'), word('HardMonotone', 'Hard Monotone'),
    word('HighContrastBW', 'Hi-Contrast B&W'), word('NegativeFilm', 'Negative Film'), word('PositiveFilm', 'Positive Film'), word('CinemaYellow', 'Cinema (Yellow)'),
    word('CinemaGreen', 'Cinema (Green)'), word('CrossProcess', 'Cross Processing'), word('BleechBypass_GR', 'Bleach Bypass'), word('Retro'), word('HdrCuisine', 'HDR Tone'),
  ] },
  { id: 'whiteBalance', property: 'StillWhiteBalance', colourOnly: true, choices: [
    word('AutoStandard', 'Auto WB'), word('AutoWarm', 'Auto WB (warm)'), word('AutoWhite', 'Auto WB (white)'), word('Daylight'), word('Shade'), word('Cloudiness', 'Cloudy'),
    word('Flu_D', 'Fluorescent D'), word('Flu_N', 'Fluorescent N'), word('Flu_W', 'Fluorescent W'), word('Flu_L', 'Fluorescent L'), word('Tungsten'), word('Cte', 'CTE'),
  ] },
  { id: 'highlightCorrection', property: 'StillHighlightCorrect', choices: [word('Auto'), word('Off')] },
  { id: 'shadowCorrection', property: 'StillShadowCorrect', choices: [word('Auto'), word('Low'), word('Mid', 'Medium'), word('High'), word('Off')] },
  { id: 'shakeReduction', property: 'StillShakeReduction', choices: [word('On'), word('Off')] },
  { id: 'exposureComp', property: 'CommonXv', choices: thirds(-5, EV) },
];

/** A recipe: its name (shown in the app and in the script's first line) and the settings it changes (choice ids). */
export interface Recipe { name: string; values: Partial<Record<RecipeSettingId, string>> }

export const RECIPE_NAME_MAX = 32;
/** A name that can go into the script's comment line: printable ASCII, no quotes, 1..32 characters. */
export function validRecipeName(name: string): boolean {
  return name.length >= 1 && name.length <= RECIPE_NAME_MAX && /^[\x20-\x7e]+$/.test(name) && !/['"]/.test(name) && name.trim() === name;
}

export function recipeSetting(id: RecipeSettingId): RecipeSetting {
  const s = RECIPE_SETTINGS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown setting "${id}"`);
  return s;
}
export function recipeChoice(id: RecipeSettingId, choice: string): RecipeChoice | undefined {
  return recipeSetting(id).choices.find((c) => c.id === choice);
}

/** The settings of a recipe this model takes (the Monochrome has no colour settings). */
export function recipeSettingsFor(recipe: Recipe, model: RecipeModel): RecipeSetting[] {
  return RECIPE_SETTINGS.filter((s) => recipe.values[s.id] !== undefined && !(s.colourOnly && model === 'MONO'));
}

/** What keeps a recipe from being written, apart from its name: nothing to set, or ISO Auto limits the wrong way round. */
export function recipeProblem(recipe: Recipe, model: RecipeModel): 'empty' | 'iso-limits' | null {
  if (recipeSettingsFor(recipe, model).length === 0) return 'empty';
  const up = recipe.values.isoUpper !== undefined ? recipeChoice('isoUpper', recipe.values.isoUpper) : undefined;
  const low = recipe.values.isoLower !== undefined ? recipeChoice('isoLower', recipe.values.isoLower) : undefined;
  if (up && low && Number(low.value) > Number(up.value)) return 'iso-limits';
  return null;
}

/** The settings of a recipe that this model takes, in script order, as `[property, value]`. */
export function recipeLines(recipe: Recipe, model: RecipeModel): [string, string][] {
  const out: [string, string][] = [];
  for (const s of RECIPE_SETTINGS) {
    const v = recipe.values[s.id];
    if (v === undefined) continue;
    if (s.colourOnly && model === 'MONO') continue;
    const c = s.choices.find((x) => x.id === v);
    if (!c) throw new RangeError(`"${v}" is not a choice of ${s.id}`);
    out.push([s.property, c.value]);
    // The look goes into the Image Control set that is used (No0, the camera's own; No1..No3 are the Custom ones).
    if (s.id === 'imageControl') out.splice(out.length - 1, 0, ['StillActiveImageControlSet', 'No0']);
  }
  return out;
}

/** The file the script leaves on the card once it has run; `id` (4 hex digits) is new at every write. */
export const recipeDoneFile = (id: string): string => `GRUM${id}.TXT`;
const DONE_FILE = /^GRUM[0-9A-F]{4}\.TXT$/i;
export const isRecipeDoneFile = (name: string): boolean => DONE_FILE.test(name);

const HEADER = RECIPE_SCRIPT_HEAD;

/**
 * The start-up script for one recipe. At power-on it
 *  1. exits if a firmware update file is on the card (the update must not be mixed with it);
 *  2. exits if the recipe already ran from this card (its done file is there): it runs once;
 *  3. exits unless the first 8 bytes of E:\BlkCtl15.bin identify a GR IV (standard, HDF, Monochrome);
 *  4. sends one `UserData Set` line per setting to the camera's shell;
 *  5. writes the done file.
 * ASCII only, LF line endings, 4-space indentation, ends with a newline.
 */
export function recipeScript(recipe: Recipe, model: RecipeModel, doneId: string): string {
  if (!validRecipeName(recipe.name)) throw new RangeError('recipe name must be 1..32 printable ASCII characters without quotes');
  if (!RECIPE_MODELS.includes(model)) throw new RangeError(`unknown model "${String(model)}"`);
  if (!/^[0-9A-F]{4}$/.test(doneId)) throw new RangeError('done id must be 4 upper-case hex digits');
  const problem = recipeProblem(recipe, model);
  if (problem === 'empty') throw new RangeError('the recipe changes nothing');
  if (problem === 'iso-limits') throw new RangeError('the ISO Auto lower limit is above the upper limit');
  const lines = recipeLines(recipe, model);
  const done = `'C:\\${recipeDoneFile(doneId)}'`;
  const L: string[] = [];
  const exitIf = (condition: string): void => { L.push(`if ${condition} then`, '    exit', 'endif'); };
  L.push(`${HEADER}${recipe.name}`, `; ${model}, ${lines.length} settings, run once (done file ${recipeDoneFile(doneId)})`);
  L.push("filesearch 'C:\\fwdc248b.bin'");
  exitIf('result <> 0');
  L.push(`filesearch ${done}`);
  exitIf('result <> 0');
  L.push('; camera model check (GR IV)');
  L.push('sz = -1', `filestat '${MODEL_FILE}' sz`);
  exitIf('sz < 8');
  L.push(`fileopen fh '${MODEL_FILE}' 0`);
  exitIf('fh < 0');
  L.push('ok = 1');
  for (const byte of MODEL_FILE_MAGIC) L.push('code = 0', 'fileread fh 1 chunk', 'str2code code chunk', `if code <> ${byte} then`, '    ok = 0', 'endif');
  // Product id: 4 bytes, little-endian (STANDARD E0 32 01 00, HDF E1 32 01 00, Monochrome 30 33 01 00).
  // One flag per model, cleared at the first byte that differs; flat ifs and literal assignments
  // only, as in the power-off image script that ran on the camera.
  const flags = RECIPE_MODELS.map((_, k) => `m${k}`);
  for (const f of flags) L.push(`${f} = 1`);
  for (let i = 0; i < 4; i++) {
    L.push('code = 0', 'fileread fh 1 chunk', 'str2code code chunk');
    RECIPE_MODELS.forEach((m, k) => L.push(`if code <> ${MODEL_INFO[m].productBytes[i]} then`, `    ${flags[k]} = 0`, 'endif'));
  }
  L.push('fileclose fh');
  L.push('gr4 = 0');
  for (const f of flags) L.push(`if ${f} = 1 then`, '    gr4 = 1', 'endif');
  exitIf('ok = 0');
  exitIf('gr4 = 0');
  L.push('; the settings');
  for (const [property, value] of lines) L.push(`sendln 'UserData Set ${property} ${value}'`);
  L.push(`filecreate fh ${done}`);
  exitIf('fh < 0');
  L.push(`filewrite fh '${recipe.name}'`, 'fileclose fh', 'exit');
  return L.join('\n') + '\n';
}

/** The recipe name of a script this module wrote (by its first line), or null. */
export function recipeScriptName(script: string): string | null {
  if (!script.startsWith(HEADER)) return null;
  const end = script.indexOf('\n');
  const name = script.slice(HEADER.length, end < 0 ? undefined : end);
  return validRecipeName(name) ? name : null;
}

/** Two recipes to start from (street photography in a city, sunny day and golden hour). */
export const EXAMPLE_RECIPES: readonly Recipe[] = [
  {
    name: 'NYC Day',
    values: {
      aperture: 'F8', focus: 'Snap', snapDistance: '200', fullPressSnap: 'On', metering: 'Highlight',
      isoAuto: 'On', isoUpper: '3200', isoLower: '100', minShutter: '1/250', nd: 'Auto', fileFormat: 'RawPlus',
      imageControl: 'PositiveFilm', whiteBalance: 'AutoStandard', highlightCorrection: 'Auto', exposureComp: '-0.7',
    },
  },
  {
    name: 'Golden',
    values: {
      aperture: 'F2.8', focus: 'AutoArea', fullPressSnap: 'On', metering: 'Multi',
      isoAuto: 'On', isoUpper: '6400', isoLower: '100', minShutter: '1/60', nd: 'Off', fileFormat: 'RawPlus',
      imageControl: 'PositiveFilm', whiteBalance: 'Daylight', highlightCorrection: 'Auto', shakeReduction: 'On', exposureComp: '-0.3',
    },
  },
];
