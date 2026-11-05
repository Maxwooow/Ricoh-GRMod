// SPDX-License-Identifier: GPL-2.0-only
/** IIIx 1.60 extra still-photo Image Controls. Native IDs and banks are retained.
 * Fixed presets use private public IDs, translated at audited native consumers.
 * No shared CommonProperty mutation is used during rendering.
 */
import { assembleWords, branchWord, wordsToBytes } from '../aspect/arm';
import { FirmwareError } from '../types';
import { buildGr3xLookMenuResearch } from './image-control-research';
import type { Gr3xMenuRatio } from './geometry';
import type { Gr3xAdjFeatures } from './adj';
import type { Gr3xResearchLook } from './image-control-research';
import { GR3X_160, openGr3xOfficial } from './profile';
import { GR3X_PARAMETER_SETTER_LOOKS, GR3X_STANDARD_ACTIVE_CHECKS, GR3X_STANDARD_ACTIVE_CHECKS_SET0, GR3X_TONE_READS,
  GR3X_PHOTO_STYLE_SETTERS, GR3X_LOAD_CALL, GR3X_LOAD_DATA, GR3X_SAVE_CALL, GR3X_SAVE_DATA,
  GR3X_ZERO_FILL_END, GR3X_GAP, GR3X_HEAP_BASE, GR3X_R10_TONE_READS } from './look-addresses';
import { GR3X_TONE_RECORD_TAIL, installGr3xR10Parameters, installGr3xR10PictureInfo, installGr3xR10Raw, installGr3xR10Tables } from './films-r10';
import { gr3xFactoryLookOrder } from './look-layout';
import { installGr3xGuardR10 } from './guard';
import { gr3xRawDevelopmentWordsR10 } from './datestamp';
import { GR3X_SLOTS_NATIVE } from './slots-native';
import { GR3X_SLOTS2_NATIVE } from './slots2-native';
import { GR3X_SLOTS3_NATIVE } from './slots3-native';
import { GR3X_SLOTS4_NATIVE } from './slots4-native';
import { isGr3xFactoryLayout } from './look-layout';
import { installGr3xHalationRows } from './halation-rows';
import { installGr3xGuardCode, installGr3xGuardRecall } from './guard';
import { gr3xMaxId } from './geometry';
import { monoLook } from '../aspect/lookstash';
import { installGr3xHalationScreen } from './halation-screen';
import { GR3X_DEVELOP_LOOK_READ, GR3X_FIRST_FILM, GR3X_HALATION_STASH, GR3X_MATRIX_CALL, GR3X_MATRIX_PROCESS, installGr3xJpegStage } from './jpeg-stage';
import { HALATION_COLOUR_NAMES, HALATION_NAMES, halationColourIcon, halationColourScale, halationIcon, halationLight, PLAIN_LIGHT } from '../aspect/halation';
import { halationLightR6, halationScaleR6, PLAIN_LIGHT_R6 } from './halation-r6';
import { sectionsOf } from '../container';
import { gr3xOffset } from './profile';
import { GR3X_TONING_SCALE } from './halation-screen';
import { GR3X_STASH_FILM, gr3xRawDevelopmentWords } from './datestamp';

/** The live view's change detection reads the frame's look here (round 9: unmapped). */
const GR3X_LIVE_LOOK_READ = 0x536dc998;
/** The change detection's last flag store of its partial set-up (`strb r1,[r4,#0x1a5]`), before it returns. */
const GR3X_LIVE_FLAGS_END = 0x536dd0b4;
import { quantizeSlot } from '../../color/camera';
import type { SlotParams } from '../../color/camera';
import type { QuantizedSlot } from '../../color/camera';
import { GR3X_FILM_NAMES, gr3xLookResources, validateGr3xLookName } from './look-resources';
import { gr3xLookBadge } from './look-icons';

export interface Gr3xFilmLook {
  /** Default name (menus of languages without their own name). */
  name: string;
  /** Names for particular camera languages (checked against that language's font characters). */
  names?: Partial<Record<string, string>>;
  params?: SlotParams;
  preset?: { matrixQ13: ArrayLike<number>; curves: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]; postQ9?: ArrayLike<number> };
  icon?: Uint8Array;
  /** T6 (nine films) only: halation level of this film, fixed in the build (0 off, 1 weak, 2 strong).
   * With `filmCount` every film has the Halation line on the camera's parameter screen instead. */
  halation?: 0 | 1 | 2;
}
export interface Gr3xLookOptions {
  /** 1/2 reproduce T5/T5-L1; 3 provides nine independent T6 film slots. */
  displayRevision?: 1 | 2 | 3;
  /** Legacy revisions reserve two films; T6 reserves nine. Native controls stay intact. */
  films?: readonly Gr3xFilmLook[];
  monoReplicas?: boolean;
  /** T6 only: each film keeps its own parameters (T6d) instead of sharing Standard's (T6c). */
  ownParameters?: boolean;
  /** Test builds only: print the JPEG encoder's picture descriptors on every JPEG (date-imprint diagnostics). */
  jpegDiagnostics?: boolean;
  /** Round 6 (as GR IV's added slots): 1..20 films (looks 64..63+n), each with its own parameters
   * and a Halation line (Off / Weak / Strong) on the camera's parameter screen, kept per film and
   * photo set (native/slots2.c). Needs displayRevision 3 and ownParameters. Absent: the nine-film
   * T6 builds (camera-tested), byte for byte as before. */
  filmCount?: number;
}
/** Round 7: a film's fingerprint (FNV-1a over its matrix, curves and post-curve matrix as built;
 * never 0, which an empty table holds): a film whose preset changed starts again from neutral. */
export function gr3xFilmPrint(matrixQ13: ArrayLike<number>, curves: readonly ArrayLike<number>[], postQ9?: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  const add = (v: number) => { for (let k = 0; k < 4; k++) { h ^= (v >>> (8 * k)) & 255; h = Math.imul(h, 0x01000193) >>> 0; } };
  Array.from(matrixQ13).forEach(add);
  curves.forEach(c => Array.from(c).forEach(add));
  add(0x51); if (postQ9) Array.from(postQ9).forEach(add);
  return h || 1;
}
/** Round 6: the most films, and the looks reserved for them (64..83) whatever a build has. */
export const GR3X_MAX_FILMS = 20;
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const addr = (r: number, a: number) => `movw r${r},#${a & 65535};movt r${r},#${a >>> 16};`;
const DEFAULTS = [
  [0x532c34e8, 0x77d], [0x532c3b54, 0x77e], [0x532c41c0, 0x77f],
  [0x532c494c, 0x780], [0x532c50d8, 0x781], [0x532c5864, 0x782],
  [0x532c5ff0, 0x784], [0x532c677c, 0x785], [0x532c6b94, 0x786],
  [0x532c6e38, 0x787], [0x532c70e4, 0x788], [0x532c7270, 0x789],
  [0x532c7520, 0x78a], [0x532c78a8, 0x78c], [0x532c7f0c, 0x78e],
  [0x532c8570, 0x790], [0x532c8bd4, 0x793], [0x532c9360, 0x794],
  [0x532c9744, 0x795], [0x532c9a20, 0x796],
] as const;
/** CommonProperty offsets of the parameters Standard has (its default getters answer, 2.10/1.60). */
const STANDARD_PARAMETERS: readonly number[] = [0x77d, 0x77e, 0x77f, 0x780, 0x781, 0x782, 0x784, 0x793, 0x794];
// CommonProperty 0x77d..0x796, including the native neutral filter/enum values.
const neutral = () => Uint8Array.from([
  4,4,4,4,4,4,1,4,0,1,4,0,0,0,0,0,0,0,0,0,0,4,4,4,0,0,
]);
function filmBytes(film: Gr3xFilmLook, matrix: number[]): QuantizedSlot {
  if (film.params && film.preset) throw new FirmwareError('bad-edit', 'give either fitted or quantized IIIx film data');
  const p = film.preset;
  if (!p) return quantizeSlot(film.params ?? {
    M1: [[1,0,0],[0,1,0],[0,0,1]],
    ck: [0,1,2].map(() => Float64Array.from({ length: 17 }, (_, i) => i / 16)),
  }, matrix);
  if (p.matrixQ13?.length !== 9 || p.curves?.length !== 3 ||
      Array.from(p.matrixQ13).some(v => !Number.isInteger(v) || v < -32768 || v > 32767) ||
      [0,1,2].some(r => p.matrixQ13[r*3] + p.matrixQ13[r*3+1] + p.matrixQ13[r*3+2] !== 8192) ||
      p.curves.some(c => c?.length !== 256 || Array.from(c).some((v, i, a) =>
        !Number.isInteger(v) || v < 0 || v > 16383 || (i > 0 && v < a[i-1]))))
    throw new FirmwareError('bad-edit', 'invalid IIIx matrix/RGB-curve data');
  const post = p.postQ9;
  if (post !== undefined && (post.length !== 9 || Array.from(post).some(v => !Number.isInteger(v) || v < -2047 || v > 2047) ||
      [0,1,2].some(r => post[r*3] + post[r*3+1] + post[r*3+2] !== 512)))
    throw new FirmwareError('bad-edit', 'invalid IIIx post-curve matrix');
  return { matrixQ13: Int16Array.from(p.matrixQ13), curves: p.curves.map(c => Uint16Array.from(c)) as QuantizedSlot['curves'],
    ...(post ? { postQ9: Int16Array.from(post) } : {}) };
}
const Q9_IDENTITY = [512, 0, 0, 0, 512, 0, 0, 0, 512];
const isIdentityQ9 = (q?: ArrayLike<number>) => !q || Array.from(q).every((v, i) => v === Q9_IDENTITY[i]);
function q9Bytes(q: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(18), v = new DataView(out.buffer);
  Array.from(q).forEach((x, i) => v.setInt16(i * 2, x, true));
  return out;
}
const REPLICAS = [
  { name: 'M Standard Replica', base: 13, icon: 354, params: { 0x781: 3, 0x782: 5 } },
  { name: 'M Solid Replica', base: 15, icon: 350, params: { 0x780: 5, 0x781: 3, 0x782: 3, 0x784: 5 } },
  { name: 'M Soft Replica', base: 14, icon: 357, params: { 0x77f: 5, 0x780: 3, 0x781: 2, 0x782: 5, 0x784: 3 } },
  { name: 'M Hi BW Replica', base: 16, icon: 352, params: { 0x780: 6, 0x782: 2, 0x784: 5 } },
  { name: 'M Grainy Replica', base: 13, icon: 354, params: { 0x780: 6, 0x781: 3, 0x782: 2, 0x795: 3 } },
  { name: 'M HDR Replica', base: 20, icon: 351, params: { 0x796: 2 } },
] as const;

/** The Halation row's name in GR III's Chinese menus: their fonts have no 晕 / 暈 (GR IV's 光晕 /
 * 光暈). Round 6 (red only): "red light diffusion"; round 7 (red or white): "light diffusion". */
export const GR3X_HALATION_ZH_R6 = ['紅光漫射', '红光漫射'] as const;
export const GR3X_HALATION_ZH = ['光漫射', '光漫射'] as const;
/** The Halation row's name per text row: GR IV's, Chinese as GR III's fonts allow. */
export function gr3xHalationNames(round7: boolean): string[] {
  const zh = round7 ? GR3X_HALATION_ZH : GR3X_HALATION_ZH_R6;
  return HALATION_NAMES.map((n, row) => row === 18 ? zh[0] : row === 19 ? zh[1] : n);
}

/** Round 6: the Halation line's name (21 rows, GR IV's names), its list icon and slider scale
 * (GR IV's pictures; the scale drawn on GR III's own three-position scale 211, 400 x 60).
 * Round 7: the Halation and Colour rows' names (GR IV's), the halation icon, the colour scale
 * (GR IV's red and white lights drawn on scale 211) and the red and white light icons. */
function halationResources(decoded: Uint8Array, round7: boolean, round8 = false) {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const icons = sectionsOf(decoded).find(s => s.name === 'ICONBIN');
  if (!icons) throw new FirmwareError('unexpected-layout', 'IIIx icon section missing');
  const d = gr3xOffset(view.getUint32(gr3xOffset(0x550020fc + GR3X_TONING_SCALE * 4), true));
  if (view.getUint16(d, true) !== 400 || view.getUint16(d + 2, true) !== 60) throw new FirmwareError('unexpected-layout', 'IIIx Toning scale size');
  const at = view.getUint32(d + 4, true) * 4;
  if (at + 400 * 60 * 4 > icons.size) throw new FirmwareError('unexpected-layout', 'IIIx Toning scale pointer');
  const scale = decoded.slice(icons.offset + at, icons.offset + at + 400 * 60 * 4);
  // Round 8: GR IV's names (光晕 / 光暈 too: GR III's fonts are GR IV's, byte for byte).
  const names = round8 ? [...HALATION_NAMES] : gr3xHalationNames(round7);
  if (round7) return { texts: [names, [...HALATION_COLOUR_NAMES]], icons: [{ w: 40, h: 40, pixels: halationIcon() },
    { w: 400, h: 60, pixels: halationColourScale(scale) }, { w: 40, h: 40, pixels: halationColourIcon('red') }, { w: 40, h: 40, pixels: halationColourIcon('white') }] };
  return { texts: [names], icons: [{ w: 40, h: 40, pixels: halationIcon() }, { w: 400, h: 60, pixels: halationScaleR6(scale) }] };
}

export async function buildGr3xImageControls(raw: Uint8Array, options: Gr3xLookOptions, ratioMenu?: readonly Gr3xMenuRatio[], features: Gr3xAdjFeatures = {}) {
  if (options.displayRevision !== undefined && ![1, 2, 3].includes(options.displayRevision))
    throw new FirmwareError('bad-edit', 'unknown IIIx display revision');
  const displayIcons = options.displayRevision !== 1;
  const extended = options.displayRevision === 3;
  const round6 = options.filmCount !== undefined;
  // Round 7 (as GR Mod 0.8.2) builds on round 6's films.
  const round7 = features.round7 === true;
  if (round7 && !round6) throw new FirmwareError('bad-edit', 'IIIx round 7: films need the film count');
  // Round 8 (as GR Mod 0.8.4) builds on round 7; the date imprint's parts here: RAW development's orientation and look.
  const round8 = features.round8 === true;
  if (round8 && !round7) throw new FirmwareError('bad-edit', 'IIIx round 8 builds on round 7');
  const round8Date = round8 && features.dateImprint === true;
  // Round 9: the live view's change detection (0x536dc860) reads the look at 0x536dc998 only to
  // compare it with the one it saw last ([r4,#0x1a8]) and to remember it; up to round 8 that read
  // gave a film's native base (Standard), so going from one film to another (or Standard to a
  // film) changed nothing it compared: the live view kept the previous film's matrix, second
  // matrix and curves until a parameter changed (a colour film shown black and white after a
  // black-and-white one). From round 9 it reads the look itself (no adapter there).
  const round9 = features.round9 === true;
  if (round9 && !round8) throw new FirmwareError('bad-edit', 'IIIx round 9 builds on round 8');
  // Round 10 (films-r10.ts): the films as looks of their own, GR IV's way.
  const round10 = features.round10 === true;
  if (round10 && !round9) throw new FirmwareError('bad-edit', 'IIIx round 10 builds on round 9');
  if (round6 && (!extended || options.ownParameters !== true || options.jpegDiagnostics || !Number.isInteger(options.filmCount) ||
      options.filmCount! < 1 || options.filmCount! > GR3X_MAX_FILMS || options.films?.some(f => f.halation !== undefined)))
    throw new FirmwareError('bad-edit', 'IIIx film count: 1..20 films with their own parameters (Halation is set in the camera)');
  // The diagnostic halation status word is the End Screen list's mode word (0x5580437c).
  if (options.jpegDiagnostics && features.pictures?.length && features.pictureMenu === 'submenu')
    throw new FirmwareError('bad-edit', 'IIIx JPEG diagnostics and the End Screen submenu are not combined');
  const capacity = round6 ? options.filmCount! : extended ? 9 : 2;
  if ((options.films?.length ?? 0) > capacity || (extended && options.monoReplicas))
    throw new FirmwareError('bad-edit', round6 ? 'more films than the film count' : 'T6 supports nine film slots without legacy monochrome replicas');
  const { decoded } = await openGr3xOfficial(raw);
  const resources = gr3xLookResources(decoded);
  // Reserve both film identities even when a file has not been imported, so
  // saved replica identities never shift between successive firmware builds.
  const films = Array.from({ length: capacity }, (_, i): Gr3xFilmLook => options.films?.[i] ?? { name: GR3X_FILM_NAMES[i] });
  const specs = [
    ...films.map((f, i) => ({ name: f.name, names: f.names, icon: f.icon ?? (displayIcons ? gr3xLookBadge(resources.tiles.film, 'F', i + 1) : undefined), source: 'cube' as const, base: 11, parameters: neutral(), film: f })),
    ...(options.monoReplicas ? REPLICAS.map((r, i) => {
      const parameters = neutral();
      for (const [offset, value] of Object.entries(r.params)) parameters[Number(offset) - 0x77d] = value;
      return { name: r.name, icon: displayIcons ? gr3xLookBadge(resources.tiles.film, 'M', i + 1) : resources.icon(r.icon), source: 'gr4m-replica' as const, base: r.base, parameters, film: undefined };
    }) : []),
  ];
  if (!specs.length) throw new FirmwareError('bad-edit', 'no IIIx extra image controls requested');
  specs.forEach(s => validateGr3xLookName(s.name));
  // Round 7: which films are black and white (the date imprint is then light only, as on GR IV).
  const monoFilms = round7 ? films.map(f => !!f.preset && monoLook(Array.from(f.preset.matrixQ13), f.preset.curves.map(c => Array.from(c)), f.preset.postQ9 ? Array.from(f.preset.postQ9) : undefined)) : undefined;
  // Round 8: the films' names for the date imprint, as the camera's English menu shows them.
  const filmNames = round8Date ? films.map(f => f.names?.en || f.name) : undefined;
  const menu = await buildGr3xLookMenuResearch(raw, specs as Gr3xResearchLook[], displayIcons, ratioMenu, features,
    round6 ? halationResources(decoded, round7, round8) : undefined, monoFilms, filmNames);
  const p = GR3X_160;
  const rtos = decoded.subarray(p.rtosOffset, p.rtosOffset + p.rtosLength);
  const originalRead = (va: number, size: number) => {
    const image = va >= p.ramBase && va + size <= p.ramBase + p.ramLength ? p.ramSource + va - p.ramBase : va;
    if (image < p.rtosBase || image + size > p.rtosBase + rtos.length)
      throw new FirmwareError('bad-address', 'IIIx look read outside original image');
    return rtos.slice(image - p.rtosBase, image - p.rtosBase + size);
  };
  const u32 = (va: number) => new DataView(originalRead(va, 4).buffer).getUint32(0, true);
  const parts: Uint8Array[] = [unhex(menu.append.bytes)];
  let length = parts[0].length;
  const next = () => menu.append.address + ((length + 3) & ~3);
  const append = (bytes: Uint8Array) => {
    const pad = (-length) & 3;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    const at = next();
    if (at + bytes.length >= p.ramBase) throw new FirmwareError('no-space', 'IIIx look code overlaps RAM');
    parts.push(bytes); length += bytes.length;
    return at;
  };
  const code = (s: string) => append(wordsToBytes(assembleWords(s, next())));
  const sites = menu.sites.map(s => ({ ...s }));
  const patch = (at: number, expected: number, replacement: number, reason: string) => {
    if (u32(at) !== (expected >>> 0) || sites.some(s => s.address === at))
      throw new FirmwareError('unexpected-instruction', `IIIx look guard/overlap at ${at.toString(16)}`);
    sites.push({ address: at, expected: hex(wordsToBytes([expected])), replacement: hex(wordsToBytes([replacement])), reason });
  };
  const mstd = new DataView(originalRead(u32(u32(0x55018d94 + 11 * 4) + 4), 18).buffer);
  const matrix = Array.from({ length: 9 }, (_, i) => mstd.getInt16(i * 2, true));
  const slots = specs.map((spec, i) => {
    const id = menu.addedLooks[i].id;
    let record = 0, curves = 0, postQ9: Int16Array | undefined, quantizedCurves: QuantizedSlot['curves'] | undefined, print = 0;
    const curveId = 0x47430000 + id;
    if (spec.film || spec.base === 20) {
      const rec = originalRead(u32(0x55018d94 + spec.base * 4), 84);
      // Round 10: words 17..20 as the camera's start-up gives its own records (0x536eb0e4).
      if (round10) rec.set(originalRead(GR3X_TONE_RECORD_TAIL, 16), 68);
      const quantized = spec.film ? filmBytes(spec.film, matrix) : undefined;
      // HDR uses IIIx's own local-tone processing with a neutral luma matrix.
      const q = quantized?.matrixQ13 ?? Int16Array.from([2449,4809,934,2449,4809,934,2449,4809,934]);
      const bytes = new Uint8Array(18), view = new DataView(bytes.buffer);
      q.forEach((v, j) => view.setInt16(j * 2, v, true));
      new DataView(rec.buffer).setUint32(4, append(bytes), true);
      record = append(rec);
      // Round 7: the film's fingerprint (its matrix, curves and post-curve matrix as built).
      if (quantized) print = gr3xFilmPrint(q, quantized.curves, quantized.postQ9);
      if (quantized) {
        const bytes = new Uint8Array(1536), v = new DataView(bytes.buffer);
        quantized.curves.forEach((c, channel) => c.forEach((x, j) => v.setUint16(channel * 512 + j * 2, x, true)));
        curves = append(bytes);
        quantizedCurves = quantized.curves;
        if (!isIdentityQ9(quantized.postQ9)) postQ9 = quantized.postQ9;
      }
    }
    const halation = extended ? spec.film?.halation ?? 0 : 0;
    if (![0, 1, 2].includes(halation)) throw new FirmwareError('bad-edit', 'IIIx halation level is 0, 1 or 2');
    return { ...menu.addedLooks[i], nativeBase: spec.base, parameters: Array.from(spec.parameters),
      parameterAddress: append(spec.parameters), record, curves, curveId, renderingImplemented: true as const,
      halation, ...(postQ9 ? { postQ9: Array.from(postQ9) } : {}), quantizedCurves, print };
  });
  // Round 6: every film has halation, its level set in the camera (sp_hal_level gives it).
  const halationSlots = round6 ? slots : slots.filter(s => s.halation > 0);
  if (halationSlots.length && !round6 && (!extended || slots.some(s => s.id < GR3X_FIRST_FILM || s.id >= GR3X_FIRST_FILM + 9)))
    throw new FirmwareError('bad-edit', 'IIIx halation needs the nine T6 film slots');
  // Round 6: slots2.c (Halation Off / Weak / Strong); round 7: slots3.c (strength and colour,
  // preset fingerprints).
  // Round 8: slots3.c with -DHIDDEN_FILMS (a hidden film in the standard set handled like a removed one).
  const own2 = round10 ? undefined : round8 ? GR3X_SLOTS4_NATIVE : round7 ? GR3X_SLOTS3_NATIVE : round6 ? GR3X_SLOTS2_NATIVE : undefined;
  const own2Origin = own2 ? append(unhex(own2.code)) : 0;
  const own2Entry = (name: keyof typeof GR3X_SLOTS3_NATIVE.exports) => {
    const exports = own2!.exports as Record<string, number>;
    if (exports[name] === undefined) throw new FirmwareError('internal', `IIIx own parameters: ${name}`);
    return own2Origin + exports[name];
  };
  // The halation stash: the development step that reads the frame's look (0x536db7f8) leaves the
  // look, the film's level and a valid bit in a word the JPEG stage reads (halation.c).
  const stashLevels = halationSlots.length && !round6 ? append(Uint8Array.from(slots.slice(0, 9).map(s => s.halation))) : 0;
  // Round 6 maps every reserved film look (64..83) to Standard, also those this build does not
  // have (a set left on one renders as Standard until the start-up check gives it Standard).
  const mapped = round6 ? Array.from({ length: GR3X_MAX_FILMS }, (_, k) => ({ id: GR3X_FIRST_FILM + k, nativeBase: 11 })) : slots;
  const map = (r: number) => mapped.map(s => `cmp r${r},#${s.id};moveq r${r},#${s.nativeBase};`).join('');
  // Translate on read without modifying shared state, pointer provenance, flags
  // or another register. Keep these adapters specific to the audited IIIx image.
  if (round9) {
    // The read and the only uses of its value (the frame slot fp-0x34, the remembered byte
    // [r4,#0x1a8], written at start-up by 0x536daf64), as audited: nothing else may read them.
    const live: readonly (readonly [number, number])[] = [[GR3X_LIVE_LOOK_READ, 0xe5d5c77c], [0x536dc9a0, 0xe50bc034], [0x536dcb64, 0xe51b2034],
      [0x536dcb6c, 0xe5d431a8], [0x536dcdf4, 0xe55b2034], [0x536dcdfc, 0xe5c421a8], [0x536daf64, 0xe5c431a8]];
    for (const [at, w] of live) if (u32(at) !== w) throw new FirmwareError('unexpected-instruction', `IIIx live view look comparison at ${at.toString(16)}`);
  }
  // Round 9: a changed look marks the matrix and second matrix (obj+5, +6) but not the gamma
  // module (obj+0xe), whose curves a film brings (the curve hook at 0x536f028c below); the
  // camera's own looks do not change the gamma. At the end of the change detection's partial
  // set-up (the full one marks everything), "the look changed" ([fp,#-0xcc], written at
  // 0x536dcb80 on every path to it) also marks the gamma.
  const liveGamma = round9 ? (() => {
    const tail: readonly (readonly [number, number])[] = [[0x536dcb80, 0xe50b30cc], [GR3X_LIVE_FLAGS_END, 0xe5c411a5], [GR3X_LIVE_FLAGS_END + 4, 0xe24bd028], [GR3X_LIVE_FLAGS_END + 8, 0xe89daff0]];
    for (const [at, w] of tail) if (u32(at) !== w) throw new FirmwareError('unexpected-instruction', `IIIx live view flags at ${at.toString(16)}`);
    const stub = code(`strb r1,[r4,#0x1a5];ldr r1,[fp,#-0xcc];cmp r1,#0;movne r1,#1;strbne r1,[r4,#0xe];b #${GR3X_LIVE_FLAGS_END + 4};`);
    patch(GR3X_LIVE_FLAGS_END, 0xe5c411a5, branchWord(GR3X_LIVE_FLAGS_END, stub), 'films: a look change also marks the live view\'s gamma (curves)');
    return stub;
  })() : undefined;
  const adapters = (round10 ? GR3X_R10_TONE_READS : GR3X_TONE_READS.filter(([at]) => !(round9 && at === GR3X_LIVE_LOOK_READ))).map(([at, word]) => {
    const dst = (word >>> 12) & 15, src = (word >>> 16) & 15;
    const scratch = [0,1,2,3].find(r => r !== dst && r !== src)!;
    const entry = at === GR3X_DEVELOP_LOOK_READ && round10 ? (() => {
      if (word !== 0xe5d3277c) throw new FirmwareError('unexpected-instruction', 'IIIx development look read changed');
      // Round 10 (GR IV's STASH_ASM): ldrb r2,[r3,#0x77c]; the stash gets look | level << 8 | 0x10000
      // (| 0x20000 white), the level from a film's Toning byte (+0x786, GR IV's states: 0 off, 1 / 3 / 2
      // weak / medium / strong red, 4..6 white, 7..11 off); a film 64 + k as 32 + k. In RAW
      // development also GR IV's frame look and orientation words. Registers and flags as before, but
      // r2 (the look, a film as Standard).
      return code(`push {r0-r5,ip,lr};mrs r4,cpsr;ldrb r2,[r3,#0x77c];mov r0,#0;sub ip,r2,#${GR3X_FIRST_FILM};cmp ip,#${capacity - 1};bhi nolevel;
        ldrb r1,[r3,#0x786];cmp r1,#7;movhs r1,#0;cmp r1,#4;subhs r1,r1,#3;orrhs r0,r0,#0x20000;bhs level;
        cmp r1,#3;moveq r1,#2;beq level;cmp r1,#2;moveq r1,#3;level:orr r0,r0,r1,lsl #8;
        nolevel:cmp r2,#${GR3X_FIRST_FILM};subhs ip,r2,#${GR3X_FIRST_FILM - GR3X_STASH_FILM};movlo ip,r2;orr ip,ip,r0;orr ip,ip,#0x10000;
        ${addr(1, GR3X_HALATION_STASH)}str ip,[r1];` +
        (round8Date ? `ldr r1,[sp,#4];${gr3xRawDevelopmentWordsR10('r1', 'ip', 'r0', 'r5')}` : '') +
        map(2) + `str r2,[sp,#8];msr cpsr_f,r4;pop {r0-r5,ip,lr};b #${at + 4};`);
    })() : at === GR3X_DEVELOP_LOOK_READ && round6 ? (() => {
      if (word !== 0xe5d3277c) throw new FirmwareError('unexpected-instruction', 'IIIx development look read changed');
      // ldrb r2,[r3,#0x77c]: also store look | level << 8 | valid in the stash, the level being the
      // film's Halation in the active photo set (slots2.c; 0 for any other look). Registers and
      // flags as before, but r2 (the mapped look); eight words pushed (the stack stays aligned).
      // Round 7: sp_hal_level gives the strength with white at bit 9, and a film 64 + k is left as
      // 32 + k (the halation's and the date imprint's tables have 64 looks).
      // Round 8: in RAW development also the orientation and the look of the picture (datestamp.ts).
      return code(`push {r0-r5,ip,lr};mrs r4,cpsr;ldrb r0,[r3,#0x77c];bl #${own2Entry('sp_hal_level')};ldr r3,[sp,#12];` +
        `ldrb r2,[r3,#0x77c];${round7 ? `cmp r2,#${GR3X_FIRST_FILM};subhs ip,r2,#${GR3X_FIRST_FILM - GR3X_STASH_FILM};movlo ip,r2;orr ip,ip,r0,lsl #8;` : 'orr ip,r2,r0,lsl #8;'}orr ip,ip,#0x10000;${addr(1, GR3X_HALATION_STASH)}str ip,[r1];` +
        (round8Date ? `ldr r1,[sp,#4];${gr3xRawDevelopmentWords('r1', 'ip', 'r0', 'r5')}` : '') +
        map(2) + `str r2,[sp,#8];msr cpsr_f,r4;pop {r0-r5,ip,lr};b #${at + 4};`);
    })() : at === GR3X_DEVELOP_LOOK_READ && halationSlots.length ? (() => {
      if (word !== 0xe5d3277c) throw new FirmwareError('unexpected-instruction', 'IIIx development look read changed');
      // ldrb r2,[r3,#0x77c]: also store look | level << 8 | valid in the stash (r0, r1, ip saved).
      return code(`push {r0,r1,ip};mrs r0,cpsr;ldrb r2,[r3,#0x77c];mov ip,#0;sub r1,r2,#${GR3X_FIRST_FILM};cmp r1,#8;bhi stash;` +
        `${addr(12, stashLevels)}ldrb ip,[ip,r1];stash:orr ip,r2,ip,lsl #8;orr ip,ip,#0x10000;${addr(1, GR3X_HALATION_STASH)}str ip,[r1];` +
        map(2) + `msr cpsr_f,r0;pop {r0,r1,ip};b #${at + 4};`);
    })() : code(`push {r${scratch}};mrs r${scratch},cpsr;ldrb r${dst},[r${src},#0x77c];` +
      map(dst) + `msr cpsr_f,r${scratch};pop {r${scratch}};b #${at + 4};`);
    patch(at, word, branchWord(at, entry), 'image control: native base for typed property/ISP/file consumer');
    return { address: at, entry, sourceRegister: src, destinationRegister: dst };
  });
  // The aggregate is CommonProperty[0x6c4..0x819]. Preserve the private tone ID,
  // replacing only its fixed look parameters before the original queued commit.
  // T6 (displayRevision 3): film parameters are adjustable and shared with Standard. The
  // camera only stores Image Control parameters for its own looks, so a film reads and writes
  // Standard's stored values (per Image Control set) and renders through Standard's path with
  // its own matrix/curves. Earlier revisions keep fixed parameters (reproducible T5/T5-L1).
  const adjustable = extended;
  const aggregate = adjustable ? undefined : code(`push {r0-r3,ip,lr};ldrb r2,[r6,#0xb8];` +
    slots.map(s => `cmp r2,#${s.id};beq slot${s.id};`).join('') +
    `b done;` + slots.map(s => `slot${s.id}:${addr(1, s.parameterAddress)}
      add r0,r6,#0xb9;mov r2,#26;bl #0x5313fd80;b done;`).join('') +
    `done:pop {r0-r3,ip,lr};mov r1,r6;b #0x53279a0c;`);
  if (aggregate !== undefined) patch(0x53279a08, 0xe1a01006, branchWord(0x53279a08, aggregate), 'image control: fixed preset parameters in native property transaction');
  // RAW development safely falls back to each original base. It does not
  // pretend an imported film can be reconstructed from the native EXIF enum.
  const rawEnum = round10 ? undefined : code(map(1) + 'sub r1,r1,#11;b #0x53288d60;');
  if (rawEnum !== undefined) patch(0x53288d5c, 0xe241100b, branchWord(0x53288d5c, rawEnum), 'image control: RAW development native-base fallback');
  const restriction = code(map(1) + 'cmp r1,#0;b #0x53553ad8;');
  patch(0x53553ad4, 0xe3510000, branchWord(0x53553ad4, restriction), 'image control: preserve native shooting-mode restrictions');
  // Native default getters assert on unknown IDs. Fixed new presets have their
  // own values; every other ID still executes the original validation.
  const defaults = round10 ? [] : DEFAULTS.map(([at, offset]) => {
    // Only parameters Standard has (its native default getter answers) follow Standard;
    // the others keep the fixed value, as Standard's getter would assert.
    const entry = adjustable && STANDARD_PARAMETERS.includes(offset) ? code(map(1) + `mov ip,sp;b #${at + 4};`)
      : code(slots.map(s => `cmp r1,#${s.id};moveq r0,#${s.parameters[offset - 0x77d]};bxeq lr;`).join('') +
      `mov ip,sp;b #${at + 4};`);
    patch(at, 0xe1a0c00d, branchWord(at, entry), adjustable && STANDARD_PARAMETERS.includes(offset) ? 'image control: film parameter default is Standard\'s'
      : 'image control: fixed new-slot default parameter');
    return { address: at, offset, entry };
  });
  // Films render through the native Standard path, which reads the live parameter bytes
  // CommonProperty[0x77d..0x796]. The camera's Image Control detail page can leave other
  // values there (it cannot store parameters for an added look), which washed out the
  // colours on GR III T6 until the next settings transaction. Every descriptor build now
  // restores the film's fixed parameters first, before any consumer reads them.
  const enforce = adjustable ? undefined : code(`push {r0-r3,ip,lr};ldrb r2,[r7,#0x77c];` +
    slots.map(s => `cmp r2,#${s.id};beq slot${s.id};`).join('') +
    `b done;` + slots.map(s => `slot${s.id}:${addr(1, s.parameterAddress)}add r0,r7,#0x700;add r0,r0,#0x7d;mov r2,#26;bl #0x5313fd80;b done;`).join('') +
    `done:pop {r0-r3,ip,lr};b #0x536db7d8;`);
  if (enforce !== undefined) patch(0x536dc124, branchWord(0x536dc124, 0x536db7d8, 14, true),
    branchWord(0x536dc124, enforce, 14, true), 'image control: films always render with their fixed parameters');
  // Parameter setters (SetSaturation etc.) take the current look from 0x53549ee8 and do
  // nothing for an unknown one; for a film they now act on Standard.
  const setters = adjustable && !round10 ? GR3X_PARAMETER_SETTER_LOOKS.map(at => {
    const entry = code(`push {lr};bl #0x53549ee8;` + map(0) + `pop {pc};`);
    patch(at, branchWord(at, 0x53549ee8, 14, true), branchWord(at, entry, 14, true), 'image control: film parameter write uses Standard storage');
    return { address: at, entry };
  }) : [];
  // After a stored write, each Standard setter updates the live value only when the stored
  // look of the active set is Standard (ldrb [..,#0x1c2/0x1c4/0x1c6]; cmp #11).
  const activeChecks = adjustable && !round10 ? GR3X_STANDARD_ACTIVE_CHECKS.map(([at, word]) => {
    const dst = (word >>> 12) & 15, src = (word >>> 16) & 15, offset = word & 0xfff;
    const scratch = [0,1,2,3].find(r => r !== dst && r !== src)!;
    const entry = code(`push {r${scratch}};mrs r${scratch},cpsr;ldrb r${dst},[r${src},#${offset}];` +
      map(dst) + `msr cpsr_f,r${scratch};pop {r${scratch}};b #${at + 4};`);
    patch(at, word, branchWord(at, entry), 'image control: a film counts as Standard for the live-value update');
    return { address: at, entry, sourceRegister: src, destinationRegister: dst };
  }) : [];
  const activeChecksSet0 = adjustable && !round10 ? GR3X_STANDARD_ACTIVE_CHECKS_SET0.map(at => {
    // ldr r3,[r3,#0x1c0] reads the active set (byte 0) and set 0's stored look (byte 2).
    const entry = code(`push {r0,r1};mrs r0,cpsr;ldr r3,[r3,#0x1c0];and r1,r3,#0xff0000;` +
      mapped.map(s => `cmp r1,#${s.id << 16};biceq r3,r3,#0xff0000;orreq r3,r3,#${s.nativeBase << 16};`).join('') +
      `msr cpsr_f,r0;pop {r0,r1};b #${at + 4};`);
    patch(at, 0xe59331c0, branchWord(at, entry), 'image control: a film counts as Standard for the live-value update (set 0)');
    return { address: at, entry };
  }) : [];
  // Own parameters (T6d): each film keeps its own values per photo set (native/slots.c).
  // Before a set's look changes, the old owner's values leave Standard's fields for a table and
  // the new owner's values come back; the firmware's setter then pushes the record to the live
  // values as always. The table is HTData record 12, loaded after the settings and saved after
  // them at power off. Its pointer lives in the 12 unused bytes between the zero-filled data and
  // the heap: the start-up fill is extended to cover them, so the pointer is 0 at every start.
  // Round 10: the films' module (native/films.c), the settings guard through the scaffold, the
  // picture's information and RAW development (films-r10.ts).
  const r10Program = { code, append, patch, u32, read: originalRead, sites, next };
  const r10 = round10 ? (() => {
    const layout = features.lookLayout && !isGr3xFactoryLayout(features.lookLayout, capacity) ? features.lookLayout : undefined;
    const hiddenMask = (layout?.hidden ?? []).filter(id => id >= GR3X_FIRST_FILM && id < GR3X_FIRST_FILM + capacity).reduce((m, id) => (m | (1 << (id - GR3X_FIRST_FILM))) >>> 0, 0);
    const tables = installGr3xR10Tables(r10Program, slots.filter(s => s.record).map(s => ({ id: s.id, record: s.record, iconId: s.iconId, print: s.print })));
    const params = installGr3xR10Parameters(r10Program, { films: capacity, prints: slots.slice(0, capacity).map(s => s.print >>> 0), hiddenMask, setterSites: GR3X_PARAMETER_SETTER_LOOKS });
    const guard = installGr3xGuardR10({ code, patch, u32, sites }, { films: capacity, maxRatio: gr3xMaxId(menu.menu), ...(layout ? { hidden: layout.hidden } : {}),
      ...(features.adjSoftFocus ? { softFocusR10: true } : {}) }, params.moduleSymbols.sp_before_recall);
    const order = (layout ? layout.order.filter(id => !layout.hidden.includes(id)) : gr3xFactoryLookOrder(capacity));
    const raw = installGr3xR10Raw(r10Program, { films: capacity, order, module: params.moduleSymbols });
    const info = installGr3xR10PictureInfo(r10Program, capacity, slots[0].iconId);
    return { ...tables, ...params, ...guard, ...raw, ...info };
  })() : undefined;
  const own = adjustable && options.ownParameters === true && !round10 ? (() => {
    const native = own2 ?? GR3X_SLOTS_NATIVE;
    const origin = own2 ? own2Origin : append(unhex(native.code));
    const entry = (name: 'sp_style' | 'sp_after_load' | 'sp_after_save' | 'sp_before_recall') => origin + (native.exports as Record<string, number>)[name];
    const styles = GR3X_PHOTO_STYLE_SETTERS.map((at, set) => {
      const stub = code(`push {r0-r3,ip,lr};mov r2,#${set};bl #${entry('sp_style')};pop {r0-r3,ip,lr};` +
        `ldr r3,[r0,#4];b #${at + 4};`);
      patch(at, 0xe5903004, branchWord(at, stub), `own film parameters: look change of photo set ${set}`);
      return stub;
    });
    if (round7) {
      // Round 7: the films' fingerprints go with the load (slots3.c), then the settings guard
      // (guard.ts) puts back looks and ratios this build does not know, at the load (after the
      // table), the save (before the settings) and a mode recall.
      // Round 8: then a word of the hidden films (bit k: film k; slots3.c -DHIDDEN_FILMS), and the
      // hidden looks for the guard.
      const layout = round8 && features.lookLayout && !isGr3xFactoryLayout(features.lookLayout, capacity) ? features.lookLayout : undefined;
      const hiddenFilms = (layout?.hidden ?? []).filter(id => id >= GR3X_FIRST_FILM && id < GR3X_FIRST_FILM + capacity).reduce((m, id) => (m | (1 << (id - GR3X_FIRST_FILM))) >>> 0, 0);
      const prints = append(wordsToBytes([...slots.slice(0, capacity).map(s => s.print >>> 0), ...(round8 ? [hiddenFilms] : [])]));
      const guard = installGr3xGuardCode({ code, patch, u32 }, { films: capacity, maxRatio: gr3xMaxId(menu.menu), ...(layout ? { hidden: layout.hidden } : {}) });
      const load = code(`push {r4,r5,r6,lr};mov r4,r0;bl #${GR3X_LOAD_DATA};mov r5,r0;mov r0,r4;mov r1,#${capacity};${addr(2, prints)}bl #${entry('sp_after_load')};
        mov r0,r4;bl #${guard.fixAll};mov r0,r5;pop {r4,r5,r6,pc};`);
      patch(GR3X_LOAD_CALL, branchWord(GR3X_LOAD_CALL, GR3X_LOAD_DATA, 14, true), branchWord(GR3X_LOAD_CALL, load, 14, true),
        'own film parameters and settings guard: after the settings load');
      const save = code(`push {r4,lr};mov r4,r0;bl #${guard.fixAll};mov r0,r4;bl #${GR3X_SAVE_DATA};mov r4,r0;bl #${entry('sp_after_save')};mov r0,r4;pop {r4,pc};`);
      patch(GR3X_SAVE_CALL, branchWord(GR3X_SAVE_CALL, GR3X_SAVE_DATA), branchWord(GR3X_SAVE_CALL, save),
        'settings guard and own film parameters: the settings save, then the table');
      const recall = installGr3xGuardRecall({ code, patch, u32 }, guard.fix, entry('sp_before_recall'));
      return { module: origin, moduleSha256: native.sourceSha256, styles, load, save, prints, guardFix: guard.fix, guardFixAll: guard.fixAll, guardRecall: recall, exports: { ...native.exports } };
    }
    // Round 6: the build's number of films goes with the load (slots2.c checks the sets' looks).
    const load = code(`push {r4,lr};mov r4,r0;bl #${GR3X_LOAD_DATA};mov r0,r4;${own2 ? `mov r1,#${capacity};` : ''}bl #${entry('sp_after_load')};pop {r4,pc};`);
    patch(GR3X_LOAD_CALL, branchWord(GR3X_LOAD_CALL, GR3X_LOAD_DATA, 14, true), branchWord(GR3X_LOAD_CALL, load, 14, true),
      'own film parameters: read the table after the settings load');
    const save = code(`push {r4,lr};bl #${GR3X_SAVE_DATA};mov r4,r0;bl #${entry('sp_after_save')};mov r0,r4;pop {r4,pc};`);
    patch(GR3X_SAVE_CALL, branchWord(GR3X_SAVE_CALL, GR3X_SAVE_DATA), branchWord(GR3X_SAVE_CALL, save),
      'own film parameters: write the table after the settings save');
    return { module: origin, moduleSha256: native.sourceSha256, styles, load, save, exports: { ...native.exports } };
  })() : undefined;
  // Round 7: the Halation and Colour rows of a film on the parameter screen (halation-rows.ts).
  const sym = r10?.moduleSymbols;
  const halationRows = round7 ? installGr3xHalationRows({ code, append, patch, u32: (a: number) => u32(a), read: originalRead },
    { films: capacity, halationText: menu.extraTextIds[0], colourText: menu.extraTextIds[1], halationIcon: menu.extraIconIds[0],
      colourScale: menu.extraIconIds[1], redIcon: menu.extraIconIds[2], whiteIcon: menu.extraIconIds[3],
      ...(sym ? { hal: sym.sp_hal, halPut: sym.sp_hal_put, halText: sym.sp_hal_text, col: sym.sp_col, colPut: sym.sp_col_put }
        : { hal: own2Entry('sp_hal'), halPut: own2Entry('sp_hal_put'), halText: own2Entry('sp_hal_text'), col: own2Entry('sp_col'), colPut: own2Entry('sp_col_put'),
          backup: own2Entry('sp_hal_backup'), restore: own2Entry('sp_hal_restore') }) }) : undefined;
  // Round 6: the Halation line of a film on the parameter screen (halation-screen.ts).
  const halationScreen = round6 && !round7 ? installGr3xHalationScreen({ code, append, patch, u32: (a: number) => u32(a), read: originalRead },
    { films: capacity, textId: menu.extraTextIds[0], iconId: menu.extraIconIds[0], scaleIconId: menu.extraIconIds[1],
      hal: own2Entry('sp_hal'), put: own2Entry('sp_hal_put'), text: own2Entry('sp_hal_text'),
      backup: own2Entry('sp_hal_backup'), restore: own2Entry('sp_hal_restore') }) : undefined;
  // Both the table pointer of own parameters and the halation stash live in the 12 bytes between
  // the zero-filled data and the heap; the start-up fill is extended to clear them at every start.
  // (Already done by the End Screen submenu, whose list mode is the third of those words.)
  if ((own || halationSlots.length) && !sites.some(s => s.address === GR3X_ZERO_FILL_END))
    patch(GR3X_ZERO_FILL_END, GR3X_GAP, GR3X_HEAP_BASE, 'start-up zero fill reaches the heap base (clears the added RAM words)');
  // Second (post-curve) matrix: the matrix module's process call (0x536df3e8) is followed by
  // copying the film's Q9 matrix, found by its matrix record (desc+8), into the module's post-curve
  // fields (obj+0x32, 9 x int16); every other record gets the identity the firmware itself sets
  // there at start-up. GR III's own processing never writes these fields per picture.
  const postSlots = slots.filter(s => s.postQ9 && s.record);
  const postMatrix = postSlots.length ? (() => {
    const identity = append(q9Bytes(Q9_IDENTITY));
    const tables = postSlots.map(s => append(q9Bytes(s.postQ9!)));
    const entry = code(`push {r0,r1,r4,lr};bl #${GR3X_MATRIX_PROCESS};pop {r0,r1};ldr r2,[r1,#8];` +
      postSlots.map((s, k) => `${addr(3, s.record)}cmp r2,r3;${addr(1, tables[k])}beq copy;`).join('') +
      `${addr(1, identity)}copy:add r0,r0,#0x32;mov r2,#18;bl #0x5313fd80;pop {r4,pc};`);
    patch(GR3X_MATRIX_CALL, branchWord(GR3X_MATRIX_CALL, GR3X_MATRIX_PROCESS, 14, true), branchWord(GR3X_MATRIX_CALL, entry, 14, true),
      'films: post-curve (second) matrix');
    return { entry, identity, tables };
  })() : undefined;
  // The date imprint (adj layer) already sits at Execute's entry: the halation goes in front of it.
  const dateStage = (menu.entries as Record<string, number>).dateStage;
  const retarget = (at: number, replacement: number, reason: string) => {
    const site = sites.find(s => s.address === at);
    if (!site || !site.reason.startsWith('date imprint')) throw new FirmwareError('unexpected-instruction', 'IIIx JPEG entry is not the date imprint');
    site.replacement = hex(wordsToBytes([replacement])); site.reason = reason;
  };
  const jpeg = installGr3xJpegStage({ code, append, patch, u32, retarget }, {
    after: dateStage,
    halation: halationSlots.length && !round7 ? { levels: round6 ? slots.map(() => 1) : slots.slice(0, 9).map(s => s.halation),
      light: (round6 ? slots : slots.slice(0, 9)).map(s => s.quantizedCurves ? halationLightR6(s.quantizedCurves, s.postQ9) : PLAIN_LIGHT_R6) } : undefined,
    // Round 7: 0.8.2's halation (soft start, Weak / Medium / Strong, red or white) for every film.
    ...(round7 ? { halation7: { light: slots.slice(0, capacity).map(s => s.quantizedCurves ? halationLight(s.quantizedCurves, s.postQ9) : PLAIN_LIGHT) } } : {}),
    diagnostics: options.jpegDiagnostics === true,
  });
  // Round 10: the film's record comes from the descriptor's own table (films-r10.ts).
  const descriptor = round10 ? undefined : code(`push {r1-r3,ip};ldrb r2,[r7,#0x77c];` +
    slots.filter(s => s.record).map(s => `cmp r2,#${s.id};beq slot${s.id};`).join('') +
    `b done;` + slots.filter(s => s.record).map(s => `slot${s.id}:${addr(3, s.record)}str r3,[r4,#8];` +
      (s.nativeBase === 20 ? 'mov r3,#1;strb r3,[r4,#0x79];' : '') + 'b done;').join('') +
    'done:pop {r1-r3,ip};b #0x536f00c4;');
  if (descriptor !== undefined) patch(0x536dc690, branchWord(0x536dc690, 0x536f00c4, 14, true),
    branchWord(0x536dc690, descriptor, 14, true), 'image control: selected immutable matrix record');
  const imported = slots.filter(s => s.curves);
  const gamma = code(`cmp r2,#0;bne native;ldrb ip,[r1,#0x77c];` +
    imported.map(s => `cmp ip,#${s.id};beq slot${s.id};`).join('') +
    `native:mov ip,sp;b #0x536f0290;` +
    imported.map(s => `slot${s.id}:push {r4-r8,lr};mov r4,r0;${addr(5, s.curves)}${addr(6, s.curveId)}b copy;`).join('') +
    `copy:bl #0x536eff34;
      ldr r0,[r4];mov r1,r5;mov r2,#512;bl #0x5313fd80;
      ldr r0,[r4,#4];add r1,r5,#512;mov r2,#512;bl #0x5313fd80;
      ldr r0,[r4,#8];add r1,r5,#1024;mov r2,#512;bl #0x5313fd80;
      mov r3,#1;strb r3,[r4,#12];strb r3,[r4,#13];str r6,[r4,#20];pop {r4-r8,pc};`);
  patch(0x536f028c, 0xe1a0c00d, branchWord(0x536f028c, gamma), 'image control: per-film RGB curves and native cache identity');
  const payload = new Uint8Array((length + 3) & ~3);
  let cursor = 0; for (const part of parts) { payload.set(part, cursor); cursor += part.length; }
  return {
    ...menu, kind: 'gr3x-image-control-patchset' as const, sites,
    append: { address: menu.append.address, bytes: hex(payload) },
    addedLooks: slots, renderingImplemented: true as const,
    lookEntries: { aggregate, rawEnum, restriction, enforce, descriptor, gamma, defaults, adapters, setters, activeChecks, activeChecksSet0, ...(liveGamma ? { liveGamma } : {}),
      ...(own ? { ownParameters: own } : {}), ...(r10 ? { films: r10 } : {}), ...(postMatrix ? { postMatrix } : {}), ...(jpeg ? { jpeg } : {}),
      ...(halationScreen ? { halationScreen } : {}), ...(halationRows ? { halationRows } : {}) },
    ...(round6 ? { filmCount: capacity, halationInCamera: true } : {}),
    ...(round7 ? { round7: true, monoFilms } : {}),
    ...(round9 ? { round9: true } : {}),
    ...(round10 ? { round10: true } : {}),
    ...(round8 ? { round8: true, ...(features.lookLayout && !isGr3xFactoryLayout(features.lookLayout, capacity) ? { lookLayout: { order: [...features.lookLayout.order], hidden: [...features.lookLayout.hidden] } } : {}) } : {}),
    // sharedParameters: films use Standard's storage (T6c). ownParameters: on top of it, each film's
    // values are swapped into that storage when it is selected (T6d).
    sharedParameters: adjustable && !round10, ownParameters: !!own || !!r10,
    // A patch-set is not a firmware update. Packaging and native regression checks
    // are separate; camera behavior remains unverified until the user tests it.
    flashable: false as const, cameraUpdateCandidate: false as const, hardwareTested: false,
    blockers: ['native look-path regression suite', 'physical camera test and persistent storage'],
    limitations: ['GR IV Monochrome-inspired replicas, not original GR IV algorithms',
      ...(own ? ['films keep their own parameters per photo Image Control set; movie sets share Standard\'s']
        : adjustable ? ['film parameters are shared with Standard (per Image Control set)'] : ['fixed new-slot parameters']), 'RAW development/EXIF use native base identities',
      'CUBE matrix/curve approximation; camera color accuracy needs sample verification'],
  };
}
