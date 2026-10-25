// SPDX-License-Identifier: GPL-2.0-only
/** GR IIIx 1.60 fixed-nine ADJ/menu patch set. No general-purpose UI builder.
 * Every address below was located in the exact IIIx image, not shifted from GR IV.
 * The format checks cover IIIx's 8-byte icon descriptors and 21 native text rows.
 * Camera startup, persistent storage and the physical ISP remain hardware-unverified. */
import { assembleWords, branchWord, movWord, wordsToBytes } from '../aspect/arm';
import { drawRatioIcon } from '../aspect/icon';
import { drawSoftFocusIcon, SOFT_FOCUS_NAMES } from '../aspect/softfocus';
import { installGr3xAdjSoftFocus } from './adj-softfocus';
import { DATESTAMP_LONG_TEXT, DATESTAMP_NAMES, DATESTAMP_ON_OFF_NAMES, DATESTAMP_ORIENT_NAMES, DATESTAMP_SHORT_TEXT, DATESTAMP_STYLE_NAMES, datestampNameTexts, drawStyleIcon } from '../aspect/datestamp-menu';
import type { Gr3xDateForm } from './datestamp';
import { GR3X_FACTORY_LOOK_NAMES, GR3X_FACTORY_LOOK_TEXTS, gr3xRawDevelopmentWords, installGr3xDateImprintStage, installGr3xMenuAdditions } from './datestamp';
import { GR3X_MAX_PICTURES, checkGr3xPictures, gr3xPictureIcon, GR3X_PICTURE_LINE_NAMES, GR3X_PICTURE_ORIGINAL, installGr3xPictureStage, GR3X_JPEG_TABLE_COUNT } from './shutdown';
import { GR3X_FACTORY_PICTURES, GR3X_PICTURE_NAMES, GR3X_PREVIEW_H, GR3X_PREVIEW_W, GR3X_TYPE_NAMES, gr3xPreview, installGr3xEndScreen } from './endscreen';
import { readRes, resFile } from '../aspect/res';
import type { Gr3xPictureSpec } from './shutdown';
import { sectionsOf, sha256Hex } from '../container';
import { FirmwareError } from '../types';
import { buildGr3xExperiment } from './experimental';
import { GR3X_T4_MENU, gr3xCustoms, gr3xMaxId } from './geometry';
import { installGr3xGuard } from './guard';
import { GR3X_DEVELOP_LOOK_READ, GR3X_HALATION_STASH } from './jpeg-stage';
import { GR3X_STASH_FILM } from './datestamp';
import { installGr3xLookLayout, isGr3xFactoryLayout, validateGr3xLookLayout } from './look-layout';
import type { Gr3xLookLayout } from './look-layout';
import { GR3X_GAP, GR3X_HEAP_BASE, GR3X_ZERO_FILL_END } from './look-addresses';
import { GR3X_FILL_OFFICIAL, GR3X_FILL_R10, GR3X_ZERO_FILL_LITERAL, installGr3xSettingsScaffold } from './round10';
import { installGr3xGuardR10 } from './guard';
import { gr3xRawDevelopmentWordsR10 } from './datestamp';
import type { Gr3xMenuRatio } from './geometry';
import { GR3X_160, openGr3xOfficial } from './profile';
import { installGr3xImageIdentity, installGr3xDevelopAndPlayback, installGr3xAutofocus } from './image-pipeline';
import { installGr3xMetering } from './metering';
import { installGr3xLiveView } from './liveview';
import { installGr3xRawDevelopment } from './raw-development';
import { installGr3xShading } from './shading';
import { installGr3xFullFrameRaw } from './raw-full-frame';

export const GR3X_ADJ = {
  order: 0x53b5a520,
  orderSites: [0x531a0df0, 0x531a1234, 0x531a3438, 0x531b4e08,
    0x531b6bd0, 0x531b82f8, 0x53227144],
  countSites: [0x5319fea0, 0x531b3aac],
  select: 0x531a0dd8, selected: 0x531a1218, renderIcon: 0x531a3408,
  menuSelect: 0x531b6bb8, menuSelected: 0x531b82f0, renderText: 0x531b4dec,
  ratioText: 0x53292544, ratioIcon: 0x53293800,
  textRoots: 0x55002bac, textCount: 786, languages: 21,
  textBounds: [0x533966d4, 0x533970ec],
  textRootSites: [[0x533966e8, 0x533966f0], [0x533970fc, 0x53397100]],
  iconRoot: 0x550020fc, iconCount: 671,
  iconBounds: [[0x53209fb8, 3], [0x53209fec, 3], [0x5320a7cc, 1]],
  iconRootSites: [[0x53209fcc, 3], [0x5320a000, 3], [0x5320a804, 2]],
  fnCycle: 0x53227114, fnHook: 0x5322714c, fnJoin: 0x5322716c,
} as const;

const BASE = GR3X_160.rtosBase;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16));
const words = (n: readonly number[]) => wordsToBytes(n);
function utf16z(s: string): Uint8Array {
  const out = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}
function fail(message: string): never { throw new FirmwareError('unexpected-layout', message); }
/** GR III text rows (ja en fr de es pt it nl da sv fi pl cs hu tr el ru ko zh-TW zh-CN th) as indices of `LANGS`. */
const GR3X_SOFT_FOCUS_ROWS = [9, 2, 4, 5, 16, 13, 8, 11, 1, 17, 3, 12, 0, 7, 20, 6, 14, 10, 19, 15, 18];

export interface Gr3xAdjFeatures {
  /** Soft focus on the ADJ lever (function 0x13, see adj-softfocus.ts). */
  adjSoftFocus?: boolean;
  /** Date imprint: a still-menu line and the JPEG module (datestamp.ts). */
  dateImprint?: boolean;
  /** Its menu: 'submenu' (as GR IV) or 'list' (round 4; the default, so older recipes rebuild). */
  dateMenu?: Gr3xDateForm;
  /** Power-off pictures: a Setup line after End Screen, the files in RES (shutdown.ts). */
  pictures?: readonly Gr3xPictureSpec[];
  /** Their menu: 'submenu' (round 6, as GR IV: End Screen opens Type / Picture, endscreen.ts; the
   * pictures need their `id`) or 'list' (round 5; the default, so older recipes rebuild). */
  pictureMenu?: 'list' | 'submenu';
  /** Round 7 (as GR Mod 0.8.2): the settings guard (guard.ts), the date imprint light only for
   * black-and-white looks (from the look the development step leaves), the date imprint's On /
   * Off as the camera's boxed OFF / ON, and with films their Halation strength and colour
   * (halation-rows.ts, native/slots3.c) and 0.8.2's halation. Absent: the files of rounds 4..6,
   * byte for byte as before. */
  round7?: boolean;
  /** Round 8 (as GR Mod 0.8.4; needs round 7): the date imprint follows the camera's orientation
   * (third submenu line, default on), two more styles with the look's name (and their labels as
   * wide as the row allows), and with films the Image Control order and hidden looks
   * (image-control.ts). Absent: the files of round 7, byte for byte as before. */
  round8?: boolean;
  /** Round 9 (needs round 8): with films, the live view's change detection sees each film as a look
   * of its own (image-control.ts); without films only the recorded round differs from round 8. */
  round9?: boolean;
  /** Round 10 (needs round 9): GR IV's ways throughout (round10.ts): films as looks of their own,
   * soft focus on the flash's exposure compensation (0x09), the settings scaffold, the RAM words,
   * the End Screen choice as a record of the settings store. Absent: the files of round 9. */
  round10?: boolean;
  /** Round 8: the Image Control order and hidden looks (look-layout.ts; the camera's order with
   * nothing hidden is the same as none). */
  lookLayout?: Gr3xLookLayout;
}
/** How the image-control layer builds on this one (not recorded: it follows from the films). */
export interface Gr3xAdjLayer {
  /** The image-control layer follows: it installs the guard and the look word itself. */
  looksFollow?: boolean;
  /** Round 7: which films are black and white (the date imprint's table of looks). */
  monoFilms?: readonly boolean[];
  /** Round 8: the films' names for the date imprint (English, as the camera's English menu shows them). */
  filmNames?: readonly string[];
}

export async function buildGr3xAdjResearch(raw: Uint8Array, ratioMenu: readonly Gr3xMenuRatio[] = GR3X_T4_MENU, features: Gr3xAdjFeatures = {}, layer: Gr3xAdjLayer = {}) {
  const softFocus = features.adjSoftFocus === true, dateImprint = features.dateImprint === true, round7 = features.round7 === true;
  const round8 = features.round8 === true;
  if (round8 && !round7) fail('IIIx round 8 builds on round 7');
  const round9 = features.round9 === true;
  if (round9 && !round8) fail('IIIx round 9 builds on round 8');
  const round10 = features.round10 === true;
  if (round10 && !round9) fail('IIIx round 10 builds on round 9');
  if (features.lookLayout && !round8) fail('IIIx look layout: round 8');
  if (round7 && dateImprint && features.dateMenu !== 'submenu') fail('IIIx round 7: the date imprint submenu');
  const dateForm: Gr3xDateForm = features.dateMenu === 'submenu' ? 'submenu' : 'list';
  // Texts of the date imprint: name, short, long (both forms), then On/Off and Style (submenu),
  // then (round 8) Follow Orientation and the two styles with the look's name.
  const date8 = round8 && dateImprint;
  const dateTexts = dateImprint ? (dateForm === 'submenu' ? (date8 ? 8 : 5) : 3) : 0;
  const dateIconCount = dateImprint ? (date8 ? 4 : 2) : 0;
  const pictures = features.pictures ?? [];
  if (pictures.length) checkGr3xPictures(pictures);
  const pictureCount = pictures.length;
  const pictureSub = pictureCount > 0 && features.pictureMenu === 'submenu';
  if (pictureSub && (new Set(pictures.map(x => x.id)).size !== pictureCount || pictures.some(x => !(Number.isInteger(x.id) && x.id! >= 1 && x.id! <= 0xffffffff) ||
    // Round 5 kept a picture number k (1..8) in the top byte the identity shares: never an identity.
    ((x.id! & 0xffffff) === 0 && x.id! >>> 24 <= GR3X_MAX_PICTURES))))
    fail('IIIx power-off picture identities');
  const geometry = await buildGr3xExperiment(raw, ratioMenu);
  const menu = geometry.menu, count = menu.length, spelled = count === 9 ? 'nine' : String(count);
  const { decoded, profile } = await openGr3xOfficial(raw);
  const p = GR3X_160, m = GR3X_ADJ;
  const rtos = decoded.subarray(p.rtosOffset, p.rtosOffset + p.rtosLength);
  const iconSection = sectionsOf(decoded).find(s => s.name === 'ICONBIN');
  if (!iconSection) fail('Missing IIIx ICONBIN');
  const originalIcons = decoded.subarray(iconSection.offset, iconSection.offset + iconSection.size);
  const read = (address: number, size: number): Uint8Array => {
    let at = address;
    if (at >= p.ramBase && at + size <= p.ramBase + p.ramLength) at = p.ramSource + at - p.ramBase;
    if (at < BASE || at + size > BASE + rtos.length) fail(`Read outside IIIx image: ${address.toString(16)}`);
    return rtos.slice(at - BASE, at - BASE + size);
  };
  const word = (at: number) => new DataView(read(at, 4).buffer).getUint32(0, true);
  const expect = (at: number, expected: Uint8Array) => {
    if (hex(read(at, expected.length)) !== hex(expected)) fail(`IIIx ADJ guard at ${at.toString(16)}`);
  };
  expect(m.order, Uint8Array.of(0, 3));
  expect(m.ratioText, words([0xe3510000]));
  expect(m.ratioIcon, words([0xe3510000]));
  expect(m.fnHook, words([0xe5d31000, 0xe1500001]));
  // Confirm the two native 60x40 records have IIIx's {u16 width,height;u32 offset/4} layout.
  for (const id of [256, 257]) {
    const descriptor = read(word(m.iconRoot + id * 4), 8);
    const v = new DataView(descriptor.buffer);
    if (v.getUint16(0, true) !== 60 || v.getUint16(2, true) !== 40 ||
      v.getUint32(4, true) * 4 + 9600 > originalIcons.length) fail('Unexpected IIIx native ratio icon layout');
  }
  const sites = [...geometry.sites.map(s => ({ ...s, reason: 'geometry research hook' }))];
  const parts: Uint8Array[] = [unhex(geometry.append.bytes)];
  let length = parts[0].length;
  const append = (bytes: Uint8Array): number => {
    const pad = (4 - length % 4) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    const address = geometry.append.address + length;
    parts.push(bytes); length += bytes.length;
    if (address + bytes.length >= p.ramBase) fail('IIIx append reaches initialized RAM');
    return address;
  };
  const code = (source: string): number => {
    const at = geometry.append.address + ((length + 3) & ~3);
    if (append(wordsToBytes(assembleWords(source, at))) !== at) fail('Assembler address changed');
    return at;
  };
  const patch = (address: number, expected: number, replacement: number, reason: string) => {
    expect(address, words([expected]));
    if (sites.some(s => s.address === address)) fail('Overlapping IIIx ADJ patch');
    sites.push({ address, expected: hex(words([expected])), replacement: hex(words([replacement])), reason });
  };
  const pair = (low: number, high: number, register: number, old: number, next: number, reason: string) => {
    patch(low, movWord(register, old & 65535), movWord(register, next & 65535), reason);
    patch(high, movWord(register, old >>> 16, true), movWord(register, next >>> 16, true), reason);
  };

  // Round 10 (round10.ts): the settings scaffold, and the zero fill over the 76 bytes before the heap.
  const scaffold = round10 ? installGr3xSettingsScaffold({ code, sites, u32: word }) : {};
  if (round10) patch(GR3X_ZERO_FILL_LITERAL, GR3X_FILL_OFFICIAL, GR3X_FILL_R10, 'start-up zero fill over the 76 bytes before the heap (round 10\'s RAM words)');
  const order = append(Uint8Array.from(geometry.ratios.map(r => r.id)));
  for (const at of m.orderSites) pair(at, at + 4, 3, m.order, order, `${spelled}-entry native menu order`);
  for (const at of m.countSites) patch(at, 0xe3a00002, 0xe3a00000 | count, `${spelled}-entry native menu count`);

  const additions = gr3xCustoms(menu);
  const textIds = new Map([[0, 241], [3, 243]]);
  const iconIds = new Map([[0, 257], [3, 256]]);
  // Pictures: round 5 line name, Original, names; round 6 Type, Picture, Original, names.
  const pictureTexts = pictureCount ? (pictureSub ? 3 : 2) + pictureCount : 0;
  const columns = m.textCount + additions.length + (softFocus ? 1 : 0) + dateTexts + pictureTexts;
  const softText = m.textCount + additions.length, softIcon = m.iconCount + additions.length;
  // Date imprint: name, the two style names; two style icons (after the soft-focus ones).
  const dateText = softText + (softFocus ? 1 : 0), dateIcon = softIcon + (softFocus ? 1 : 0);
  const dateIds = { name: dateText, short: dateText + 1, long: dateText + 2, iconShort: dateIcon, iconLong: dateIcon + 1,
    ...(dateForm === 'submenu' ? { onOff: dateText + 3, style: dateText + 4 } : {}),
    ...(date8 ? { orient: dateText + 5, shortName: dateText + 6, longName: dateText + 7, iconShortName: dateIcon + 2, iconLongName: dateIcon + 3 } : {}) };
  // Power-off pictures: the line name, the original's name, the pictures' names; a thumbnail each.
  const pictureText = dateText + dateTexts, pictureIcon = dateIcon + dateIconCount;
  const pictureIds = { title: pictureText, original: pictureText + 1, names: pictures.map((_, k) => pictureText + 2 + k), icons: pictures.map((_, k) => pictureIcon + k) };
  // Round 6: thumbnails 520 x 200, the five factory pictures (by camera variant) first.
  const endIds = { typeText: pictureText, pictureText: pictureText + 1, factoryText: pictureText + 2,
    factoryIcons: GR3X_FACTORY_PICTURES.map((_, k) => pictureIcon + k), icons: pictures.map((_, k) => pictureIcon + GR3X_FACTORY_PICTURES.length + k) };
  const rows = Array.from({ length: m.languages }, (_, l) => {
    const row = new Uint8Array(columns * 4);
    row.set(read(word(m.textRoots + l * 4), m.textCount * 4));
    return row;
  });
  additions.forEach((r, i) => {
    const text = append(utf16z(r.name));
    const record = append(Uint8Array.from([r.name.length + 1, 1, 0, 0, ...words([text])]));
    const id = m.textCount + i;
    textIds.set(r.id, id);
    rows.forEach(row => new DataView(row.buffer).setUint32(id * 4, record, true));
  });
  if (softFocus) GR3X_SOFT_FOCUS_ROWS.forEach((lang, row) => {
    const name = SOFT_FOCUS_NAMES[lang];
    const text = append(utf16z(name));
    const record = append(Uint8Array.from([name.length + 1, 1, 0, 0, ...words([text])]));
    new DataView(rows[row].buffer).setUint32(softText * 4, record, true);
  });
  if (dateImprint) GR3X_SOFT_FOCUS_ROWS.forEach((lang, row) => {
    [DATESTAMP_NAMES[lang], DATESTAMP_SHORT_TEXT, DATESTAMP_LONG_TEXT,
      ...(dateForm === 'submenu' ? [DATESTAMP_ON_OFF_NAMES[lang], DATESTAMP_STYLE_NAMES[lang]] : []),
      ...(date8 ? [DATESTAMP_ORIENT_NAMES[lang], datestampNameTexts(DATESTAMP_SHORT_TEXT)[lang], datestampNameTexts(DATESTAMP_LONG_TEXT)[lang]] : [])].forEach((name, k) => {
      const text = append(utf16z(name));
      const record = append(Uint8Array.from([name.length + 1, 1, 0, 0, ...words([text])]));
      new DataView(rows[row].buffer).setUint32((dateText + k) * 4, record, true);
    });
  });
  if (pictureCount) {
    const names = pictures.map(pic => { const text = append(utf16z(pic.name)); return append(Uint8Array.from([pic.name.length + 1, 1, 0, 0, ...words([text])])); });
    const head = pictureSub ? 3 : 2;
    rows.forEach((row, r) => {
      (pictureSub ? [GR3X_TYPE_NAMES[r], GR3X_PICTURE_NAMES[r], GR3X_PICTURE_ORIGINAL[r]] : [GR3X_PICTURE_LINE_NAMES[r], GR3X_PICTURE_ORIGINAL[r]]).forEach((name, k) => {
        const text = append(utf16z(name));
        const record = append(Uint8Array.from([name.length + 1, 1, 0, 0, ...words([text])]));
        new DataView(row.buffer).setUint32((pictureText + k) * 4, record, true);
      });
      names.forEach((record, k) => new DataView(row.buffer).setUint32((pictureText + head + k) * 4, record, true));
    });
  }
  const textRoots = append(words(rows.map(row => append(row))));
  for (const [low, high] of m.textRootSites) pair(low, high, 3, m.textRoots, textRoots, 'extended IIIx language directory');
  for (const at of m.textBounds) patch(at, movWord(3, m.textCount - 1), movWord(3, columns - 1), 'extended IIIx text bound');

  const iconCount = m.iconCount + additions.length + (softFocus ? 1 : 0) + dateIconCount + pictureCount + (pictureSub ? GR3X_FACTORY_PICTURES.length : 0);
  const iconCatalog = new Uint8Array(iconCount * 4);
  iconCatalog.set(read(m.iconRoot, m.iconCount * 4));
  const pixels = additions.map(r => drawRatioIcon(r.ratio));
  let iconOffset = originalIcons.length;
  additions.forEach((r, i) => {
    if (iconOffset % 4) fail('IIIx ICONBIN alignment');
    const descriptor = append(Uint8Array.from([60, 0, 40, 0, ...words([iconOffset / 4])]));
    const id = m.iconCount + i;
    new DataView(iconCatalog.buffer).setUint32(id * 4, descriptor, true);
    iconIds.set(r.id, id); iconOffset += pixels[i].length;
  });
  if (softFocus) {
    const icon = drawSoftFocusIcon();
    if (iconOffset % 4) fail('IIIx ICONBIN alignment');
    const descriptor = append(Uint8Array.from([40, 0, 40, 0, ...words([iconOffset / 4])]));
    new DataView(iconCatalog.buffer).setUint32(softIcon * 4, descriptor, true);
    pixels.push(icon); iconOffset += icon.length;
  }
  if (dateImprint) [[false, false], [true, false], ...(date8 ? [[false, true], [true, true]] : [])].forEach(([long, name], k) => {
    const icon = drawStyleIcon(long, name);
    if (iconOffset % 4) fail('IIIx ICONBIN alignment');
    const descriptor = append(Uint8Array.from([40, 0, 40, 0, ...words([iconOffset / 4])]));
    new DataView(iconCatalog.buffer).setUint32((dateIcon + k) * 4, descriptor, true);
    pixels.push(icon); iconOffset += icon.length;
  });
  if (pictureSub) {
    const dir = readRes(decoded);
    const factory = GR3X_FACTORY_PICTURES.map(path => { const jpeg = resFile(decoded, path, dir); if (!jpeg) fail(`IIIx RES has no ${path}`); return jpeg!; });
    [...factory, ...pictures.map(pic => pic.jpeg)].forEach((jpeg, k) => {
      const icon = gr3xPreview(jpeg);
      if (iconOffset % 4) fail('IIIx ICONBIN alignment');
      const descriptor = append(Uint8Array.from([GR3X_PREVIEW_W & 255, GR3X_PREVIEW_W >> 8, GR3X_PREVIEW_H, 0, ...words([iconOffset / 4])]));
      new DataView(iconCatalog.buffer).setUint32((pictureIcon + k) * 4, descriptor, true);
      pixels.push(icon); iconOffset += icon.length;
    });
  } else pictures.forEach((pic, k) => {
    const icon = gr3xPictureIcon(pic.jpeg);
    if (iconOffset % 4) fail('IIIx ICONBIN alignment');
    const descriptor = append(Uint8Array.from([40, 0, 40, 0, ...words([iconOffset / 4])]));
    new DataView(iconCatalog.buffer).setUint32((pictureIcon + k) * 4, descriptor, true);
    pixels.push(icon); iconOffset += icon.length;
  });
  const iconRoot = append(iconCatalog);
  for (const [low, r] of m.iconRootSites) pair(low, low + 4, r, m.iconRoot, iconRoot, 'extended IIIx icon directory');
  for (const [at, r] of m.iconBounds) patch(at, movWord(r, m.iconCount - 1), movWord(r, iconCount - 1), 'extended IIIx icon bound');
  const lookup = (ids: Map<number, number>): number => code([...ids].map(([id, value]) =>
    `cmp r1,#${id}; movweq r0,#${value}; bxeq lr;`).join('\n') + 'mov r0,#0;bx lr;');
  const ratioText = lookup(textIds), ratioIcon = lookup(iconIds);
  patch(m.ratioText, 0xe3510000, branchWord(m.ratioText, ratioText), 'ratio identity to IIIx text ID');
  patch(m.ratioIcon, 0xe3510000, branchWord(m.ratioIcon, ratioIcon), 'ratio identity to IIIx icon ID');
  // Fn cycling uses the same menu entries. It does not intercept a physical dial.
  const fnCycle = code(geometry.ratios.map((r, i) =>
    `cmp r0,#${r.id}; moveq r1,#${geometry.ratios[(i + 1) % count].id}; beq selected;`).join('\n') +
    `mov r1,#${geometry.ratios[0].id}; selected:b #${m.fnJoin};`);
  patch(m.fnHook, 0xe5d31000, branchWord(m.fnHook, fnCycle), `Fn cycle through the ${spelled} menu entries`);
  const program = { code, patch, append, next: () => geometry.append.address + ((length + 3) & ~3), menu };
  const imageEntries = installGr3xImageIdentity(program);
  const developEntries = installGr3xDevelopAndPlayback(program);
  const afEntries = installGr3xAutofocus(program);
  const mapEntries = installGr3xMetering(program);
  const liveEntries = installGr3xLiveView(program);
  const rawEntries = installGr3xRawDevelopment(program);
  const shadingEntries = installGr3xShading(program);
  const softEntries = softFocus ? installGr3xAdjSoftFocus({ code, append, patch, word }, softText, softIcon, round10) : {};
  const fullRawEntries = installGr3xFullFrameRaw(program);
  const endScreen = pictureSub ? installGr3xEndScreen({ code, append, patch, word }, { ...endIds,
    choices: pictures.map(x => x.id!), resources: pictures.map((_, k) => GR3X_JPEG_TABLE_COUNT + k), ...(date8 ? { modeByte: true } : {}),
    ...(round10 ? { r10: { sites, u32: word } } : {}) }) : undefined;
  // Round 8: the names for the date imprint, per look of the stash word: the camera's own (checked
  // against its English texts), films (32 + k) by the names the image-control layer gives.
  const lookNames = date8 ? (() => {
    const en = word(m.textRoots + 1 * 4);
    const cameraText = (index: number) => {
      const desc = word(en + index * 4), n = read(desc, 1)[0], t = read(word(desc + 4), Math.max(0, n - 1) * 2);
      let out = ''; for (let i = 0; i + 1 < n; i++) out += String.fromCharCode(t[2 * i] | (t[2 * i + 1] << 8));
      return out;
    };
    for (const [look, text] of Object.entries(GR3X_FACTORY_LOOK_TEXTS)) if (cameraText(text) !== GR3X_FACTORY_LOOK_NAMES[Number(look)]) fail(`IIIx English name of look ${look}`);
    const films = layer.filmNames ?? [];
    if (films.length > 20) fail('IIIx film names');
    return { ...GR3X_FACTORY_LOOK_NAMES, ...Object.fromEntries(films.map((n, k) => [GR3X_STASH_FILM + k, n])) } as Record<number, string>;
  })() : undefined;
  const dateEntries = dateImprint || pictureCount ? {
    ...(endScreen ?? {}),
    ...installGr3xMenuAdditions({ code, append, patch, word, read }, { ...(dateImprint ? { date: dateIds, dateForm } : {}),
      ...(pictureCount && !pictureSub ? { picture: pictureIds } : {}),
      ...(endScreen ? { endScreen: { typeText: endIds.typeText, pictureText: endIds.pictureText, lineType: endScreen.endScreenLineType, linePicture: endScreen.endScreenLinePicture } } : {}),
      ...(round7 ? { onOffText: true } : {}), ...(date8 ? { round8: true } : {}), ...(round10 ? { zeroFillDone: true } : {}) }),
    ...(dateImprint ? installGr3xDateImprintStage({ code, append, patch, word, read },
      round7 ? { stash: GR3X_HALATION_STASH, monoFilms: layer.monoFilms ?? [], ...(lookNames ? { names: lookNames } : {}), ...(round10 ? { r10: true } : {}) } : undefined) : {}),
    ...(pictureCount ? installGr3xPictureStage({ code, append, patch, word, read }, pictureCount, { pick: !pictureSub }) : {}) } : {};
  // Round 7 without films: the look word for the date imprint (the image-control layer's
  // development adapter writes it when there are films), and the settings guard.
  const lookEntries = round7 && !layer.looksFollow ? (() => {
    const out: Record<string, number> = {};
    if (dateImprint) {
      // ldrb r2,[r3,#0x77c] (the frame's look): also store look | 0x10000 (level 0: no halation).
      // Round 8: in RAW development also the orientation and the look of the picture (datestamp.ts).
      const stash = date8 ? code(`push {r0,r1,r4,r5,ip,lr};mrs r0,cpsr;ldrb r2,[r3,#0x77c];orr r4,r2,#0x10000;
        movw r5,#${GR3X_HALATION_STASH & 0xffff};movt r5,#${GR3X_HALATION_STASH >>> 16};str r4,[r5];${(round10 ? gr3xRawDevelopmentWordsR10 : gr3xRawDevelopmentWords)('r1', 'r4', 'r5', 'ip')}
        msr cpsr_f,r0;pop {r0,r1,r4,r5,ip,lr};b #${GR3X_DEVELOP_LOOK_READ + 4};`)
        : code(`push {r0,r1};mrs r0,cpsr;ldrb r2,[r3,#0x77c];orr r1,r2,#0x10000;push {r2};
        movw r2,#${GR3X_HALATION_STASH & 0xffff};movt r2,#${GR3X_HALATION_STASH >>> 16};str r1,[r2];pop {r2};msr cpsr_f,r0;pop {r0,r1};b #${GR3X_DEVELOP_LOOK_READ + 4};`);
      patch(GR3X_DEVELOP_LOOK_READ, 0xe5d3277c, branchWord(GR3X_DEVELOP_LOOK_READ, stash), 'date imprint: the look of the picture, for the steps after development');
      if (!sites.some(s => s.address === GR3X_ZERO_FILL_END))
        patch(GR3X_ZERO_FILL_END, GR3X_GAP, GR3X_HEAP_BASE, 'start-up zero fill reaches the heap base (clears the added RAM words)');
      out.lookStash = stash;
    }
    // Round 8: the Image Control order and hidden looks of the camera's own looks (with films the
    // image-control layer installs them).
    const layout = features.lookLayout && !isGr3xFactoryLayout(features.lookLayout, 0) ? features.lookLayout : undefined;
    if (features.lookLayout) validateGr3xLookLayout(features.lookLayout, 0);
    const layoutEntries = layout ? installGr3xLookLayout({ code, append, patch, u32: word, read }, layout, 0) : {};
    const guardOptions = { films: 0, maxRatio: gr3xMaxId(menu), ...(layout ? { hidden: layout.hidden } : {}), ...(round10 && softFocus ? { softFocusR10: true } : {}) };
    return { ...out, ...layoutEntries, ...(round10 ? installGr3xGuardR10({ code, patch, u32: word, sites }, guardOptions) : installGr3xGuard({ code, patch, u32: word }, guardOptions)) };
  })() : {};
  const payload = new Uint8Array((length + 3) & ~3);
  let at = 0; for (const part of parts) { payload.set(part, at); at += part.length; }
  const iconAddition = new Uint8Array(iconOffset - originalIcons.length);
  at = 0; for (const px of pixels) { iconAddition.set(px, at); at += px.length; }
  return {
    schema: 1, kind: 'gr3x-adj-patchset' as const, profile: profile.id,
    originalRtosSha256: profile.rtosSha256, originalLength: p.rtosLength, base: BASE,
    sites, append: { address: geometry.append.address, bytes: hex(payload) }, geometry,
    entries: { ...geometry.entries, ...scaffold, ratioText, ratioIcon, fnCycle, ...imageEntries, ...developEntries, ...afEntries, ...mapEntries, ...liveEntries, ...rawEntries, ...shadingEntries, ...fullRawEntries, ...softEntries, ...dateEntries, ...lookEntries },
    catalogs: { order, textRoots, textColumns: columns, iconRoot, iconCount },
    adjSoftFocus: softFocus,
    dateImprint: dateImprint ? { ...dateIds, form: dateForm, ...(round7 ? { iconOff: 296, iconOn: 297 } : {}), ...(lookNames ? { names: lookNames } : {}) } : undefined,
    round7,
    ...(round8 ? { round8 } : {}), ...(round9 ? { round9 } : {}), ...(round10 ? { round10 } : {}),
    ...(round8 && !layer.looksFollow && features.lookLayout && !isGr3xFactoryLayout(features.lookLayout, 0) ? { lookLayout: { order: [...features.lookLayout.order], hidden: [...features.lookLayout.hidden] } } : {}),
    pictures: pictureCount ? (pictureSub ? { form: 'submenu' as const, count: pictureCount, ...endIds, names: pictures.map((_, k) => endIds.factoryText + 1 + k),
      factoryIcons: [...endIds.factoryIcons], icons: [...endIds.icons], choices: pictures.map(x => x.id!) }
      : { ...pictureIds, count: pictureCount, names: [...pictureIds.names], icons: [...pictureIds.icons] }) : undefined,
    iconAddition: { originalLength: originalIcons.length, originalSha256: await sha256Hex(originalIcons), bytes: hex(iconAddition) },
    ratios: geometry.ratios.map(r => ({ ...r, textId: textIds.get(r.id)!, iconId: iconIds.get(r.id)! })),
    menu: menu.map(r => ({ ...r })),
    firmwareGenerated: false, hardwareTested: false, rearDialPatched: false,
    blockers: ['physical update and camera startup', 'power-cycle and U-mode storage',
      'real ADJ rendering, AF/AE/ISP, JPEG/RAW capture and playback'],
  };
}
