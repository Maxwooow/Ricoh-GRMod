// SPDX-License-Identifier: GPL-2.0-only
/** Offline menu/catalog experiment. Deliberately not connected to a firmware builder.
 * An extra menu item is not an implemented image-processing mode. Do not serialize
 * this patch set into a camera update until the named pipeline blockers are resolved.
 */
import { assembleWords, branchWord, movWord, wordsToBytes } from '../aspect/arm';
import { sectionsOf } from '../container';
import { normalizeIcon } from '../icons';
import { FirmwareError } from '../types';
import { buildGr3xAdjResearch, GR3X_ADJ } from './adj';
import type { Gr3xAdjFeatures } from './adj';
import type { Gr3xMenuRatio } from './geometry';
import { GR3X_160, openGr3xOfficial } from './profile';
import { GR3X_FONT_VERIFIED_CHARS, GR3X_TEXT_ROWS, gr3xAllowedChars, validateGr3xLookNameFor } from './look-resources';
import { GR3X_MOVIE_COUNT, installGr3xLookLayout, isGr3xFactoryLayout, validateGr3xLookLayout } from './look-layout';

export const GR3X_LOOK_RESEARCH = {
  // The native list has 12 + n + 2 widgets: twelve originals, n films and Custom 1/2 (nine films
  // in the camera-tested T6 builds; round 6 up to twenty, looks 64..83).
  firstId: 64, maxAdditions: 20,
  count: 0x532c2a9c, countHook: 0x532c2acc,
  item: 0x532c2c80, index: 0x532c2f08, maximumCount: 0x532c2b7c,
  name: 0x532a985c, icon: 0x532a9988, shortName: 0x532922b4,
  tileIcon: 0x532935dc,
  nativeStill: [11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21],
  blockers: [
    'native setting validation, power-cycle and U-mode persistence',
    'IIIx color matrices, per-channel curves and ISP consumers',
    'GR IV Monochrome processing and its IIIx equivalents',
    'capture metadata, playback and RAW-development look enums',
    'physical camera startup, preview and JPEG/RAW capture',
  ],
} as const;

export interface Gr3xResearchLook {
  name: string;
  /** Per camera language (GR3X_TEXT_ROWS codes); rows without one use `name`. */
  names?: Partial<Record<string, string>>;
  /** Optional 40x40 RGBA pixels, normalized against the IIIx native film tile. */
  icon?: Uint8Array;
  source: 'cube' | 'gr4m-research' | 'gr4m-replica';
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const addr = (r: number, a: number) => `movw r${r},#${a & 65535};movt r${r},#${a >>> 16};`;

/** More texts (one per camera text row, GR3X_TEXT_ROWS order) and icons after the looks' own. */
export interface Gr3xLookExtras {
  texts: readonly (readonly string[])[];
  icons: readonly { w: number; h: number; pixels: Uint8Array }[];
}

export async function buildGr3xLookMenuResearch(raw: Uint8Array, looks: readonly Gr3xResearchLook[], displayIcons = false, ratioMenu?: readonly Gr3xMenuRatio[], features: Gr3xAdjFeatures = {}, extras?: Gr3xLookExtras, monoFilms?: readonly boolean[], filmNames?: readonly string[]) {
  if (!looks.length || looks.length > GR3X_LOOK_RESEARCH.maxAdditions)
    throw new FirmwareError('bad-edit', 'research menu requires 1..20 extra looks');
  const extraTexts = extras?.texts ?? [], extraIcons = extras?.icons ?? [];
  if (extraTexts.some(t => t.length !== 21) || extraIcons.some(i => i.pixels.length !== i.w * i.h * 4 || i.w > 0xffff || i.h > 0xffff))
    throw new FirmwareError('internal', 'IIIx extra texts / icons');
  const names = new Set<string>();
  for (const look of looks) {
    // Names use one native text line. Do not silently truncate a user-supplied name.
    if (typeof look.name !== 'string' || !look.name.trim() || look.name.length > 24 ||
        /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(look.name) || names.has(look.name))
      throw new FirmwareError('bad-edit', 'look names must be unique, single-line BMP text of 1..24 units');
    if (!['cube', 'gr4m-research', 'gr4m-replica'].includes(look.source))
      throw new FirmwareError('bad-edit', 'unknown research look source');
    names.add(look.name);
    for (const [lang, text] of Object.entries(look.names ?? {})) {
      if (!(GR3X_TEXT_ROWS as readonly string[]).includes(lang) || typeof text !== 'string')
        throw new FirmwareError('bad-edit', 'unknown look name language');
    }
  }
  // The image-control layer follows: it installs the settings guard and the look word itself (round 7).
  const base = await buildGr3xAdjResearch(raw, ratioMenu, features, { looksFollow: true, ...(monoFilms ? { monoFilms } : {}), ...(filmNames ? { filmNames } : {}) });
  const { decoded } = await openGr3xOfficial(raw);
  for (const look of looks) for (const [lang, text] of Object.entries(look.names ?? {}))
    if (text) validateGr3xLookNameFor(text, gr3xAllowedChars(decoded, lang as typeof GR3X_TEXT_ROWS[number]));
  const p = GR3X_160, m = GR3X_ADJ, cfg = GR3X_LOOK_RESEARCH;
  const rtos = decoded.subarray(p.rtosOffset, p.rtosOffset + p.rtosLength);
  const parts: Uint8Array[] = [unhex(base.append.bytes)];
  let length = parts[0].length;
  const originalRead = (va: number, size: number) => {
    let image = va;
    if (va >= p.ramBase && va + size <= p.ramBase + p.ramLength) image = p.ramSource + va - p.ramBase;
    if (image < p.rtosBase || image + size > p.rtosBase + rtos.length)
      throw new FirmwareError('bad-address', 'research read outside the original IIIx image');
    return rtos.slice(image - p.rtosBase, image - p.rtosBase + size);
  };
  const read = (va: number, size: number): Uint8Array => {
    if (va < base.append.address || va >= p.ramBase) return originalRead(va, size);
    const offset = va - base.append.address;
    if (offset < 0 || offset + size > parts[0].length)
      throw new FirmwareError('bad-address', 'research read outside the base patch payload');
    return parts[0].slice(offset, offset + size);
  };
  const u32 = (va: number) => new DataView(read(va, 4).buffer).getUint32(0, true);
  const append = (bytes: Uint8Array) => {
    const pad = (-length) & 3;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    const va = base.append.address + length;
    if (va + bytes.length >= p.ramBase) throw new FirmwareError('no-space', 'look payload overlaps initialized RAM');
    parts.push(bytes); length += bytes.length;
    return va;
  };
  const code = (source: string) => {
    const at = base.append.address + ((length + 3) & ~3);
    return append(wordsToBytes(assembleWords(source, at)));
  };
  const sites = base.sites.map(s => ({ ...s }));
  const patch = (at: number, old: number, next: number, reason: string) => {
    if (hex(originalRead(at, 4)) !== hex(wordsToBytes([old])))
      throw new FirmwareError('unexpected-layout', `IIIx look guard at ${at.toString(16)}`);
    const existing = sites.find(s => s.address === at);
    if (existing) {
      // Only replace the existing catalog relocation, never a T4 image/RAW patch.
      if (!/extended IIIx (language directory|text bound|icon directory|icon bound)/.test(existing.reason))
        throw new FirmwareError('unexpected-layout', 'look experiment overlaps a non-catalog T4 patch');
      existing.replacement = hex(wordsToBytes([next])); existing.reason = reason;
    } else sites.push({ address: at, expected: hex(wordsToBytes([old])), replacement: hex(wordsToBytes([next])), reason });
  };
  const pair = (lo: number, hi: number, r: number, old: number, next: number, what: string) => {
    patch(lo, movWord(r, old & 65535), movWord(r, next & 65535), what);
    patch(hi, movWord(r, old >>> 16, true), movWord(r, next >>> 16, true), what);
  };

  const columns = base.catalogs.textColumns + looks.length + extraTexts.length;
  const rows = Array.from({ length: m.languages }, (_, language) => {
    const row = new Uint8Array(columns * 4);
    row.set(read(u32(base.catalogs.textRoots + language * 4), base.catalogs.textColumns * 4));
    return row;
  });
  const slots = looks.map((look, index) => ({
    id: cfg.firstId + index, name: look.name, names: look.names, source: look.source,
    textId: base.catalogs.textColumns + index, iconId: base.catalogs.iconCount + index,
    renderingImplemented: false as const,
  }));
  for (const slot of slots) {
    const records = new Map<string, number>();
    const recordFor = (text: string) => {
      let record = records.get(text);
      if (record !== undefined) return record;
      const string = new Uint8Array((text.length + 1) * 2);
      const view = new DataView(string.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
      const pointer = append(string);
      record = append(Uint8Array.of(text.length + 1, 1, 0, 0, ...wordsToBytes([pointer])));
      records.set(text, record);
      return record;
    };
    rows.forEach((row, language) => {
      const text = slot.names?.[GR3X_TEXT_ROWS[language]] || slot.name;
      new DataView(row.buffer).setUint32(slot.textId * 4, recordFor(text), true);
    });
  }
  const extraTextIds = extraTexts.map((names, k) => {
    const id = base.catalogs.textColumns + looks.length + k;
    rows.forEach((row, language) => {
      const text = names[language];
      if (language > 0) validateGr3xLookNameFor(text, gr3xAllowedChars(decoded, GR3X_TEXT_ROWS[language]) + GR3X_FONT_VERIFIED_CHARS);
      const string = new Uint8Array((text.length + 1) * 2), view = new DataView(string.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
      new DataView(row.buffer).setUint32(id * 4, append(Uint8Array.of(text.length + 1, 1, 0, 0, ...wordsToBytes([append(string)]))), true);
    });
    return id;
  });
  const textRoots = append(wordsToBytes(rows.map(row => append(row))));
  for (const [lo, hi] of m.textRootSites) pair(lo, hi, 3, m.textRoots, textRoots, 'research: extended look language directory');
  for (const at of m.textBounds) patch(at, movWord(3, m.textCount - 1), movWord(3, columns - 1), 'research: extended look text bound');

  const icons = sectionsOf(decoded).find(s => s.name === 'ICONBIN');
  if (!icons) throw new FirmwareError('unexpected-layout', 'IIIx ICONBIN missing');
  const film = new DataView(originalRead(u32(m.iconRoot + 23 * 4), 8).buffer);
  if (film.getUint16(0, true) !== 40 || film.getUint16(2, true) !== 40)
    throw new FirmwareError('unexpected-layout', 'IIIx native film icon is not 40x40');
  const nativeOffset = film.getUint32(4, true) * 4;
  if (nativeOffset + 6400 > icons.size) throw new FirmwareError('unexpected-layout', 'native film icon out of bounds');
  const nativeIcon = decoded.slice(icons.offset + nativeOffset, icons.offset + nativeOffset + 6400);
  const iconTotal = base.catalogs.iconCount + looks.length + extraIcons.length;
  const iconCatalog = new Uint8Array(iconTotal * 4);
  iconCatalog.set(read(base.catalogs.iconRoot, base.catalogs.iconCount * 4));
  const pixelParts: Uint8Array[] = [unhex(base.iconAddition.bytes)];
  let pixelLength = pixelParts[0].length;
  slots.forEach((slot, i) => {
    // Placeholder native film icon only in this offline experiment; a logo can be supplied.
    const px = looks[i].icon ? normalizeIcon(nativeIcon, looks[i].icon!) : nativeIcon.slice();
    const pointer = append(Uint8Array.of(40, 0, 40, 0, ...wordsToBytes([(icons.size + pixelLength) / 4])));
    new DataView(iconCatalog.buffer).setUint32(slot.iconId * 4, pointer, true);
    pixelParts.push(px); pixelLength += px.length;
  });
  const extraIconIds = extraIcons.map((icon, k) => {
    const id = base.catalogs.iconCount + looks.length + k;
    const pointer = append(Uint8Array.of(icon.w & 255, icon.w >> 8, icon.h & 255, icon.h >> 8, ...wordsToBytes([(icons.size + pixelLength) / 4])));
    new DataView(iconCatalog.buffer).setUint32(id * 4, pointer, true);
    pixelParts.push(icon.pixels); pixelLength += icon.pixels.length;
    return id;
  });
  const iconRoot = append(iconCatalog);
  for (const [lo, r] of m.iconRootSites) pair(lo, lo + 4, r, m.iconRoot, iconRoot, 'research: extended look icon directory');
  for (const [at, r] of m.iconBounds) patch(at, movWord(r, m.iconCount - 1), movWord(r, iconTotal - 1), 'research: extended look icon bound');

  const hookLookup = (entry: number, nativeWord: number, key: 'textId' | 'iconId') => {
    const target = code(slots.map(s => `cmp r1,#${s.id};movweq r0,#${s[key]};bxeq lr;`).join('') +
      // These three entry points have no PC-relative instruction in their displaced word.
      (nativeWord === 0xe1a0c00d ? 'mov ip,sp;' : 'cmp r1,#10;') + `b #${entry + 4};`);
    patch(entry, nativeWord, branchWord(entry, target), 'research: extra look display identity');
    return target;
  };
  const lookName = hookLookup(cfg.name, 0xe1a0c00d, 'textId');
  const lookIcon = hookLookup(cfg.icon, 0xe1a0c00d, 'iconId');
  const lookShortName = hookLookup(cfg.shortName, 0xe351000a, 'textId');
  // The actual list, ADJ tiles and shooting-status wrappers call this second
  // lookup. T5 only extended icon(), leaving these consumers to return zero.
  const lookTileIcon = displayIcons ? hookLookup(cfg.tileIcon, 0xe351000a, 'iconId') : undefined;
  // Round 8: with an Image Control order or hidden looks, the lists come from look-layout.ts (the
  // films included); otherwise the films follow the camera's twelve looks.
  const layout = features.round8 && features.lookLayout && !isGr3xFactoryLayout(features.lookLayout, slots.length) ? features.lookLayout : undefined;
  if (features.lookLayout) validateGr3xLookLayout(features.lookLayout, slots.length);
  let count: number, item: number, index: number, layoutEntries: Record<string, number> = {};
  if (layout) {
    if (slots.some((s, i) => s.id !== cfg.firstId + i)) throw new FirmwareError('bad-edit', 'IIIx look layout: the films are looks 64..');
    layoutEntries = installGr3xLookLayout({ code, append, patch, u32: va => new DataView(originalRead(va, 4).buffer).getUint32(0, true), read: originalRead }, layout, slots.length, !!features.round10);
    count = layoutEntries.lookLayoutCount; item = layoutEntries.lookLayoutItem; index = layoutEntries.lookLayoutIndex;
  } else {
    const order = append(Uint8Array.from(slots.map(s => s.id)));
    count = code(`bhi #0x532c2ad0;cmp r3,#0;moveq r0,#${12 + slots.length};movne r0,#12;b #0x532c2ad4;`);
    patch(cfg.countHook, 0x93a0000c, branchWord(cfg.countHook, count), 'research: extra still-photo look count');
    if (features.round10) {
      // Round 10 (GR IV: the added slots are in the movie list too): the films after the movie list's ten.
      patch(GR3X_MOVIE_COUNT, 0x93a0000a, (0x93a00000 | (10 + slots.length)) >>> 0, 'films: in the movie Image Control list too');
      item = code(`ldrb ip,[r0,#0x1b];cmp ip,#1;beq imovie;cmp ip,#0;bne native;cmp r1,#12;blo native;
        cmp r1,#${12 + slots.length};bhs native;sub ip,r1,#12;${addr(2, order)}ldrb r0,[r2,ip];bx lr;
        imovie:cmp r1,#10;blo native;cmp r1,#${10 + slots.length};bhs native;sub ip,r1,#10;${addr(2, order)}ldrb r0,[r2,ip];bx lr;
        native:mov ip,sp;b #${cfg.item + 4};`);
      index = code(`ldrb ip,[r0,#0x1b];cmp ip,#1;beq xmovie;cmp ip,#0;bne native;` +
        slots.map((s, i) => `cmp r1,#${s.id};moveq r0,#${12 + i};bxeq lr;`).join('') + 'b native;xmovie:' +
        slots.map((s, i) => `cmp r1,#${s.id};moveq r0,#${10 + i};bxeq lr;`).join('') +
        `native:mov ip,sp;b #${cfg.index + 4};`);
    } else {
      item = code(`ldrb ip,[r0,#0x1b];cmp ip,#0;bne native;cmp r1,#12;blo native;
        cmp r1,#${12 + slots.length};bhs native;sub ip,r1,#12;${addr(2, order)}ldrb r0,[r2,ip];bx lr;
        native:mov ip,sp;b #${cfg.item + 4};`);
      index = code(`ldrb ip,[r0,#0x1b];cmp ip,#0;bne native;` +
        slots.map((s, i) => `cmp r1,#${s.id};moveq r0,#${12 + i};bxeq lr;`).join('') +
        `native:mov ip,sp;b #${cfg.index + 4};`);
    }
    patch(cfg.item, 0xe1a0c00d, branchWord(cfg.item, item), 'research: append still-photo look entries');
    patch(cfg.index, 0xe1a0c00d, branchWord(cfg.index, index), 'research: extra still-photo look reverse lookup');
  }
  const maximum = code(`mov r0,#${12 + slots.length};bx lr;`);
  patch(cfg.maximumCount, movWord(3, 0xd368), branchWord(cfg.maximumCount, maximum), 'research: maximum look menu allocation count');

  const payload = new Uint8Array((length + 3) & ~3);
  let cursor = 0; for (const part of parts) { payload.set(part, cursor); cursor += part.length; }
  const pixels = new Uint8Array(pixelLength);
  cursor = 0; for (const part of pixelParts) { pixels.set(part, cursor); cursor += part.length; }
  return {
    ...base, kind: 'gr3x-image-control-menu-research' as const,
    sites, append: { address: base.append.address, bytes: hex(payload) },
    catalogs: { ...base.catalogs, textRoots, textColumns: columns, iconRoot, iconCount: iconTotal },
    extraTextIds, extraIconIds,
    iconAddition: { ...base.iconAddition, bytes: hex(pixels) },
    entries: { ...base.entries, lookName, lookIcon, lookShortName, ...(lookTileIcon ? { lookTileIcon } : {}), lookCount: count, lookItem: item, lookIndex: index, lookMaximum: maximum, ...layoutEntries },
    addedLooks: slots, flashable: false as const, cameraUpdateCandidate: false as const,
    renderingImplemented: false as const, persistenceImplemented: false as const,
    baseT4PatchCount: base.sites.length, blockers: [...cfg.blockers],
  };
}
