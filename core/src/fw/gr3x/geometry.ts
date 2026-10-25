// SPDX-License-Identifier: GPL-2.0-only
/** Ratio planning for GR III / IIIx. The photo is derived from the requested ratio, independently
 * of the rounded LCD rectangle. Every bound below stays inside what the IIIx T4 build exercised on
 * the camera: at most seven added ratios (identities 4..10, nine menu entries in all) between 3:4
 * and 17:6 were tested; wider limits only reach ratios the emulator checks cover. */
import { FirmwareError } from '../types';
import { alignedCrop, parseRatio, ratioText } from '../aspect/geometry';
import { Frac } from '../aspect/fraction';
import { GR3X_160 } from './profile';

/** The T4 menu: order and names as built, tested and released for the camera. */
export const GFX_RATIOS = ['4:3', '3:2', '16:9', '65:24', '17:6', '3:4', '1:1', '7:6', '5:4'] as const;
const T4_IDS = [4, 0, 5, 6, 7, 8, 3, 9, 10] as const;
/** Measured by executing the original 1.60 dimension function, no digital crop, L/M/S/XS. */
export const GR3X_BASE_SIZES: readonly (readonly [number, number])[] = [[6000, 4000], [4800, 3200], [3360, 2240], [1920, 1280]];
/** Identities 4..10: the range of every bound check and of the AE map module's seven views. */
export const GR3X_MAX_CUSTOM_RATIOS = 7;
export const GR3X_FIRST_CUSTOM_ID = 4;
export const GR3X_RATIO_NAME_MAX = 12;
const MIN_RATIO = new Frac(1, 2), MAX_RATIO = new Frac(3, 1);
const FACTORY_SIZES = new Set([...GR3X_BASE_SIZES.map(([w, h]) => `${w}x${h}`), ...GR3X_BASE_SIZES.map(([, h]) => `${h}x${h}`)]);

/** One line of the camera's aspect-ratio menu. `n:d` is the reduced requested ratio. */
export interface Gr3xMenuRatio { ratio: string; name: string; id: number; n: number; d: number }
export interface Gr3xRatioRequest { ratio: string; name?: string }

function fail(code: string, message: string): never { throw new FirmwareError(code, message); }

export function planGr3xRatio(text: string) {
  const requested = parseRatio(text);
  if (GR3X_160.factoryRatios.some(r => requested.eq(parseRatio(r)))) fail('ratio-factory', 'the camera already has this ratio');
  if (requested.cmp(MIN_RATIO) < 0 || requested.cmp(MAX_RATIO) > 0) fail('ratio-too-extreme', 'GR III / IIIx take ratios from 1:2 to 3:1');
  if (requested.n > 65535n || requested.d > 65535n) fail('bad-ratio', 'write the ratio with fewer digits');
  const screen = alignedCrop(720, 480, requested);
  const thumb = alignedCrop(160, 120, requested);
  const photos = GR3X_BASE_SIZES.map(([w, h]) => alignedCrop(w, h, requested));
  if (!screen || !thumb || photos.some(p => !p)) fail('ratio-too-extreme', 'ratio leaves no usable rectangle');
  const sizes = photos.map(p => [p!.width, p!.height] as [number, number]);
  if (sizes.some(([w, h]) => FACTORY_SIZES.has(`${w}x${h}`))) fail('ratio-factory', 'the photo would have the size of a factory ratio');
  const actual = ratioText(sizes[0][0], sizes[0][1]);
  return {
    requested: text, actual, screenActual: ratioText(screen.width, screen.height), screen, sizes,
    n: Number(requested.n), d: Number(requested.d),
    errorPercent: (sizes[0][0] / sizes[0][1] / requested.toNumber() - 1) * 100,
    playbackRows: sizes.map(([, h]) => Math.ceil(h / 8) * 8),
    status: 'planning-only' as const,
  };
}

/** Printable ASCII: all 21 language rows of the camera have these glyphs. */
export function validateGr3xRatioName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (typeof name !== 'string' || !name.trim()) return 'empty';
  if (name.length > GR3X_RATIO_NAME_MAX) return 'too-long';
  if (!/^[\x20-\x7e]+$/.test(name) || name !== name.trim()) return 'bad-char';
  return null;
}

function entry(ratio: string, name: string, id: number): Gr3xMenuRatio {
  const r = parseRatio(ratio);
  return { ratio, name, id, n: Number(r.n), d: Number(r.d) };
}

export const GR3X_T4_MENU: readonly Gr3xMenuRatio[] = GFX_RATIOS.map((r, i) => entry(r, r, T4_IDS[i]));
/** The seven added ratios of the T4 menu, as the app lists them. */
export const GR3X_T4_CUSTOM: readonly Gr3xRatioRequest[] = GR3X_T4_MENU.filter(r => r.id >= GR3X_FIRST_CUSTOM_ID).map(r => ({ ratio: r.ratio, name: r.name }));

/**
 * The menu for a list of added ratios. The T4 list keeps its tested order; any other list is
 * 3:2, 1:1, then the added ratios in the order given, with identities 4, 5, ... in that order.
 * Throws on a bad, duplicate or conflicting ratio, a bad name, or more than seven ratios.
 */
export function planGr3xMenu(requests: readonly Gr3xRatioRequest[]): Gr3xMenuRatio[] {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > GR3X_MAX_CUSTOM_RATIOS)
    fail('too-many-ratios', `GR III / IIIx take 1 to ${GR3X_MAX_CUSTOM_RATIOS} added ratios`);
  const customs = requests.map((r, i) => {
    const name = r.name?.trim() ? r.name : r.ratio.trim();
    const problem = validateGr3xRatioName(name);
    if (problem) fail('bad-name', `ratio ${i + 1}: name is ${problem}`);
    return { plan: planGr3xRatio(r.ratio.trim()), ratio: r.ratio.trim(), name };
  });
  const seen = new Map<string, number>();
  customs.forEach((c, i) => {
    for (const key of [`s${c.plan.screen.width}x${c.plan.screen.height}`, ...c.plan.sizes.map(([w, h]) => `${w}x${h}`)]) {
      const prior = seen.get(key);
      if (prior !== undefined && prior !== i) fail('ratio-conflict', `ratios ${prior + 1} and ${i + 1} give the same picture size`);
      seen.set(key, i);
    }
  });
  const t4 = customs.length === GR3X_T4_CUSTOM.length &&
    customs.every((c, i) => c.ratio === GR3X_T4_CUSTOM[i].ratio && c.name === GR3X_T4_CUSTOM[i].name);
  if (t4) return GR3X_T4_MENU.map(r => ({ ...r }));
  return [entry('3:2', '3:2', 0), entry('1:1', '1:1', 3),
    ...customs.map((c, i) => entry(c.ratio, c.name, GR3X_FIRST_CUSTOM_ID + i))];
}

/** Check a menu read back from a recipe: native entries once each, identities 4.. consecutive. */
export function checkGr3xMenu(menu: readonly Gr3xMenuRatio[]): Gr3xMenuRatio[] {
  const customs = menu.filter(r => r.id >= GR3X_FIRST_CUSTOM_ID).sort((a, b) => a.id - b.id);
  const rebuilt = planGr3xMenu(customs.map(r => ({ ratio: r.ratio, name: r.name })));
  const same = rebuilt.length === menu.length && rebuilt.every((r, i) =>
    r.ratio === menu[i].ratio && r.name === menu[i].name && r.id === menu[i].id);
  if (!same) fail('bad-edit', 'IIIx ratio menu does not follow the build rules');
  return rebuilt;
}

/** The added ratios in identity order. */
export const gr3xCustoms = (menu: readonly Gr3xMenuRatio[]) => menu.filter(r => r.id >= GR3X_FIRST_CUSTOM_ID).sort((a, b) => a.id - b.id);
export const gr3xMaxId = (menu: readonly Gr3xMenuRatio[]) => GR3X_FIRST_CUSTOM_ID - 1 + gr3xCustoms(menu).length;
export const gr3xIsT4Menu = (menu: readonly Gr3xMenuRatio[]) => menu.length === GR3X_T4_MENU.length &&
  menu.every((r, i) => r.ratio === GR3X_T4_MENU[i].ratio && r.name === GR3X_T4_MENU[i].name && r.id === GR3X_T4_MENU[i].id);
/** Wide: the camera's hardware-wide live-view family (wider than 3:2). */
export const gr3xWide = (r: { n: number; d: number }) => r.n * 2 > r.d * 3;
