// A recipe from a few plain answers (where, light, subject, look, file), each value with the reason
// it was picked. Street-photography rules of thumb for a 28 mm (GR IV: 18.3 mm, F2.8) compact; the
// reasons are codes the app turns into text (ui i18n `why_<code>`).

import type { Recipe, RecipeSettingId } from './recipe';

export type Place = 'outdoor' | 'indoor';
export type Light = 'sun' | 'overcast' | 'golden' | 'low';
export type Subject = 'street' | 'landscape' | 'portrait' | 'everyday';
export type Look = 'warm' | 'natural' | 'soft' | 'bw';
export type FileChoice = 'raw' | 'jpeg';
export interface Answers { place: Place; light: Light; subject: Subject; look: Look; file: FileChoice }

export const PLACES: readonly Place[] = ['outdoor', 'indoor'];
export const LIGHTS: readonly Light[] = ['sun', 'overcast', 'golden', 'low'];
export const SUBJECTS: readonly Subject[] = ['street', 'landscape', 'portrait', 'everyday'];
export const LOOKS: readonly Look[] = ['warm', 'natural', 'soft', 'bw'];
export const FILES: readonly FileChoice[] = ['raw', 'jpeg'];

/** A recipe with the reason of each value (a code per setting). */
export interface Suggestion { recipe: Recipe; why: Partial<Record<RecipeSettingId, string>> }

const NAME: Record<Light | Subject, string> = {
  sun: 'Sun', overcast: 'Overcast', golden: 'Golden', low: 'Low Light',
  street: 'Street', landscape: 'Landscape', portrait: 'Portrait', everyday: 'Everyday',
};

/** The light indoors is low light whatever was answered (only window light comes close to overcast). */
export function suggestRecipe(a: Answers): Suggestion {
  const light: Light = a.place === 'indoor' && a.light !== 'overcast' ? 'low' : a.light;
  const bright = light === 'sun';
  const dim = light === 'low';
  const v: Recipe['values'] = {};
  const why: Suggestion['why'] = {};
  const put = (id: RecipeSettingId, value: string, reason: string): void => { v[id] = value; why[id] = reason; };

  // Aperture and focus go together: snap focus needs the depth of field of F8 (or F5.6 at 1 m..).
  if (a.subject === 'street') {
    if (bright || light === 'overcast') {
      put('aperture', bright ? 'F8' : 'F5.6', bright ? 'apStreetSun' : 'apStreetOvercast');
      put('focus', 'Snap', 'focusSnap');
      put('snapDistance', bright ? '200' : '250', bright ? 'snap2m' : 'snap25m');
    } else {
      put('aperture', 'F2.8', 'apWideOpen');
      put('focus', 'AutoArea', 'focusAfDim');
    }
    put('fullPressSnap', 'On', 'fullPressStreet');
  } else if (a.subject === 'landscape') {
    put('aperture', dim ? 'F4' : 'F8', dim ? 'apLandscapeDim' : 'apLandscape');
    put('focus', 'AutoArea', 'focusLandscape');
    put('fullPressSnap', 'Off', 'fullPressOff');
  } else if (a.subject === 'portrait') {
    put('aperture', 'F2.8', 'apPortrait');
    put('focus', 'AutoArea', 'focusPortrait');
    put('fullPressSnap', 'Off', 'fullPressOff');
  } else {
    put('aperture', dim ? 'F2.8' : 'F5.6', dim ? 'apWideOpen' : 'apEveryday');
    put('focus', 'AutoArea', 'focusEveryday');
    put('fullPressSnap', 'On', 'fullPressEveryday');
  }

  // Metering and compensation: protect highlights in hard light, trust the meter in soft light.
  if (bright) { put('metering', 'Highlight', 'meterHighlight'); put('exposureComp', '-0.7', 'evSun'); }
  else if (light === 'golden') { put('metering', 'Multi', 'meterMulti'); put('exposureComp', '-0.3', 'evGolden'); }
  else if (dim) { put('metering', 'Multi', 'meterMulti'); put('exposureComp', '-0.3', 'evLow'); }
  else { put('metering', 'Multi', 'meterMulti'); put('exposureComp', a.subject === 'portrait' ? '+0.3' : '0.0', a.subject === 'portrait' ? 'evOvercastFaces' : 'evOvercast'); }

  // ISO Auto: the slowest shutter speed the subject allows, then the highest ISO the light needs.
  put('isoAuto', 'On', 'isoAuto');
  put('isoLower', '100', 'isoLower');
  put('isoUpper', bright ? '3200' : dim ? '12800' : '6400', bright ? 'isoUpSun' : dim ? 'isoUpLow' : 'isoUpMid');
  const moving = a.subject === 'street' || a.subject === 'everyday';
  if (moving) put('minShutter', bright ? '1/250' : '1/125', bright ? 'tvStreetSun' : 'tvStreet');
  else if (a.subject === 'portrait') put('minShutter', '1/125', 'tvPortrait');
  else put('minShutter', dim ? '1/30' : '1/60', dim ? 'tvStillDim' : 'tvStill');
  put('nd', bright ? 'Auto' : 'Off', bright ? 'ndAuto' : 'ndOff');
  put('shakeReduction', 'On', bright ? 'srOn' : 'srOnDim');

  // The look, then the white balance that keeps it.
  const ic = a.look === 'warm' ? 'PositiveFilm' : a.look === 'natural' ? 'Standard' : a.look === 'soft' ? 'NegativeFilm' : bright || a.subject === 'street' ? 'HighContrastBW' : 'MonotoneGR';
  put('imageControl', ic, `ic_${ic}`);
  if (a.look !== 'bw') {
    if (light === 'golden') put('whiteBalance', 'Daylight', 'wbGolden');
    else if (dim && a.place === 'indoor') put('whiteBalance', 'AutoWarm', 'wbIndoor');
    else if (light === 'overcast' && a.look === 'warm') put('whiteBalance', 'Cloudiness', 'wbOvercastWarm');
    else put('whiteBalance', 'AutoStandard', 'wbAuto');
  }
  put('highlightCorrection', 'Auto', bright || light === 'golden' ? 'hlHard' : 'hlSoft');
  put('fileFormat', a.file === 'raw' ? 'RawPlus' : 'Jpeg', a.file === 'raw' ? (bright ? 'rawSun' : 'raw') : 'jpeg');

  const name = `${NAME[a.subject]} ${a.place === 'indoor' ? 'Indoor' : NAME[light]}`.slice(0, 32);
  return { recipe: { name, values: v }, why };
}

/** The answers behind the two examples (a sunny day and golden hour on city streets). */
export const EXAMPLE_ANSWERS: readonly { name: string; answers: Answers }[] = [
  { name: 'NYC Day', answers: { place: 'outdoor', light: 'sun', subject: 'street', look: 'warm', file: 'raw' } },
  { name: 'Golden', answers: { place: 'outdoor', light: 'golden', subject: 'street', look: 'warm', file: 'raw' } },
];

/** Every reason code `suggestRecipe` can give (the app has a text for each). */
export const WHY_CODES: readonly string[] = [
  'apStreetSun', 'apStreetOvercast', 'apWideOpen', 'apLandscape', 'apLandscapeDim', 'apPortrait', 'apEveryday',
  'focusSnap', 'snap2m', 'snap25m', 'focusAfDim', 'focusLandscape', 'focusPortrait', 'focusEveryday',
  'fullPressStreet', 'fullPressOff', 'fullPressEveryday',
  'meterHighlight', 'meterMulti', 'evSun', 'evGolden', 'evLow', 'evOvercast', 'evOvercastFaces',
  'isoAuto', 'isoLower', 'isoUpSun', 'isoUpMid', 'isoUpLow',
  'tvStreetSun', 'tvStreet', 'tvPortrait', 'tvStill', 'tvStillDim', 'ndAuto', 'ndOff', 'srOn', 'srOnDim',
  'ic_PositiveFilm', 'ic_Standard', 'ic_NegativeFilm', 'ic_HighContrastBW', 'ic_MonotoneGR',
  'wbGolden', 'wbIndoor', 'wbOvercastWarm', 'wbAuto', 'hlHard', 'hlSoft', 'rawSun', 'raw', 'jpeg',
];
