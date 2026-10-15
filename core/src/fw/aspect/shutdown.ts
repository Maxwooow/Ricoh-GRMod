// SPDX-License-Identifier: GPL-2.0-only
/**
 * Power-off pictures chosen in the camera: the "End Screen" menu (Setup > Display) gets a row for
 * the factory picture and one per added picture (1..SHUTDOWN_MAX_PICTURES, by name, with a
 * thumbnail); the power-off screen shows the chosen one. The camera side is the module of
 * `tools/shutdown/shutdown.c` (see there for the menu and the record of the choice).
 *
 * What a build adds:
 *  - the pictures as files of the RES section, `A:\Resource\Jpeg\GRMOD<k>.jpg` (720x480 baseline
 *    JPEG of exactly SHUTDOWN_JPEG_BYTES bytes, so that each file with its 36-byte header is two
 *    container frames and the RES section grows by whole frames; see `package.ts`). The firmware
 *    update writes them to the camera's A: drive with the factory files. Named by position, so a
 *    later build overwrites the same files instead of leaving old ones behind;
 *  - a copy of the table of full-screen JPEGs (0x55013E70, 12 entries {u16 w, u16 h, path}) with one
 *    entry per picture (numbers 12, 13, ...), used by both of its readers (0x5326232C, 0x53262558);
 *  - 520x200 thumbnails (as the native ones of the menu, icons 17 and 18) of the four factory
 *    pictures and of the added ones, icons SHUTDOWN_ICON_ID..;
 *  - texts: SHUTDOWN_TEXT_ID the factory row ("Original" / オリジナル / 原廠 / 原厂: glyphs the camera's own texts in those languages use), then the names;
 *  - the module, its context and stubs: the picture request (0x531B9488), the settings save, and
 *    the five handlers of the menu's controller (0x532240E4 refresh, 0x53223FA4 confirm,
 *    0x53223F14 / 0x53223F58 up / down, 0x5322419C footer); the controller's constructor builds
 *    3 + n rows (0x53223BA4) from an appended array of row types (0x53223BD4);
 *  - the settings store APData (0x53A80ADC) is created for SHUTDOWN_RECORD + 1 records instead of
 *    16 (the choice is record SHUTDOWN_RECORD).
 *
 * The approach is that of gr-custom-tool's End Screen list (Copyright (C) 2026 DoYitNow,
 * GPL-2.0-only); the code is GR Mod's own.
 */
import { decodeBaselineJpeg } from '../../jpeg/decoder';
import { encodeCoefficients, forwardTransform, makeLayout } from '../../jpeg/encoder';
import { qualityTables } from '../../jpeg/tables';
import { FirmwareError } from '../types';
import { branchTarget, branchWord, movImmediate, movWord } from './arm';
import { BASE, ICON_CATALOG, LOOKUP_BOUNDS, OFFICIAL_RTOS_LENGTH, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z } from './build';
import { SHUTDOWN_CODE, SHUTDOWN_CODE_LENGTH, SHUTDOWN_EXPORTS } from './shutdown-code';
import { readRes, resFile } from './res';

export const SHUTDOWN_MAX_PICTURES = 8;
/** Longest picture name (printable ASCII: the same in every camera language and font). */
export const SHUTDOWN_NAME_MAX = 20;
/** Text of the factory row; the pictures' names follow it. */
export const SHUTDOWN_TEXT_ID = 853;
/** Thumbnails: the factory pictures 1, 2, 3, 11, then the added pictures. */
export const SHUTDOWN_ICON_ID = 992;
/** APData record of the choice. */
export const SHUTDOWN_RECORD = 74;
export const SHUTDOWN_WIDTH = 720;
export const SHUTDOWN_HEIGHT = 480;
/** Every picture file: two container frames (0x6000) with its 36-byte RES header. */
export const SHUTDOWN_JPEG_BYTES = 2 * 0x6000 - 36;
export const PREVIEW_WIDTH = 520;
export const PREVIEW_HEIGHT = 200;
/** Factory pictures (numbers of the JPEG table) in the order of the context's factory_icon. */
export const FACTORY_PICTURES = [
  { resource: 1, path: 'A:\\Resource\\Jpeg\\GoodBye.jpg' },
  { resource: 2, path: 'A:\\Resource\\Jpeg\\GB_HDF.jpg' },
  { resource: 3, path: 'A:\\Resource\\Jpeg\\GB_Mono.jpg' },
  { resource: 11, path: 'A:\\Resource\\Jpeg\\GB_20th.jpg' },
] as const;
/** The added pictures go into RES after this file. */
export const RES_ANCHOR = 'A:\\Resource\\Jpeg\\SymKey.jpg';

/** An added power-off picture. */
export interface ShutdownPictureSpec {
  /** Stable identity (1..0xFFFFFFFF), remembered by the camera as the choice. */
  id: number;
  /** Name in the camera's list: 1..SHUTDOWN_NAME_MAX printable ASCII characters. */
  name: string;
  /** 720x480 baseline JPEG of exactly SHUTDOWN_JPEG_BYTES bytes. */
  jpeg: Uint8Array;
}

const JPEG_TABLE = 0x55013e70;
const JPEG_TABLE_COUNT = 12;
const TABLE_SITES = [[0x5326255c, 0x5326256c, 3], [0x53262324, 0x5326232c, 12]] as const;
const BACKGROUND = 0x531b9488;
const BACKGROUND_BODY = 0x531b948c;
const SETTINGS_SAVE = 0x533e1c04;
const MENU = { refresh: 0x532240e4, confirm: 0x53223fa4, left: 0x53223f14, right: 0x53223f58, footer: 0x5322419c } as const;
const MENU_ROWS_AT = 0x53223ba4;
const MENU_TYPES_AT = 0x53223bd4;
const MENU_TYPES_NEXT = 0x53223bd8;
const ROW_TYPE = 0x15;
const APDATA_BOUND_AT = 0x53a80adc;
const APDATA_BOUND_NEXT = 0x53a80ae0;
const CTX_MAGIC = 0x31445347; // 'GSD1'
const CTX_BYTES = 6 * 4 + 4 * 2 + SHUTDOWN_MAX_PICTURES * 2 + SHUTDOWN_MAX_PICTURES * 4 * 2;
/** The factory row's text per row of the text catalog (0 Japanese, 18 / 19 Traditional / Simplified Chinese, others English; every glyph is in the camera's own texts of that language). */
const FACTORY_LABELS: Readonly<Record<number, string>> = { 0: 'オリジナル', 18: '原廠', 19: '原厂' };

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

export function shutdownPath(index: number): string {
  return `A:\\Resource\\Jpeg\\GRMOD${index + 1}.jpg`;
}

export function validateShutdownName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (name.length > SHUTDOWN_NAME_MAX) return 'too-long';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!(c >= 0x20 && c <= 0x7e)) return 'bad-char';
  }
  return null;
}

/**
 * The menu thumbnail of a 720x480 picture: scaled to 300x200 (area average) in the middle of a
 * black 520x200 RGBA icon, fully opaque.
 */
export function shutdownThumbnail(jpeg: Uint8Array): Uint8Array {
  const { width, height, rgb } = decodeBaselineJpeg(jpeg);
  if (width !== SHUTDOWN_WIDTH || height !== SHUTDOWN_HEIGHT) fail('bad-picture', 'a power-off picture is 720 x 480');
  const tw = Math.round((PREVIEW_HEIGHT * width) / height);
  const th = PREVIEW_HEIGHT;
  const x0 = Math.floor((PREVIEW_WIDTH - tw) / 2);
  const out = new Uint8Array(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const sx = width / tw, sy = height / th;
  for (let y = 0; y < th; y++) {
    const ya = y * sy, yb = ya + sy;
    for (let x = 0; x < tw; x++) {
      const xa = x * sx, xb = xa + sx;
      let r = 0, g = 0, b = 0, w = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
          const ww = wy * (Math.min(xb, xx + 1) - Math.max(xa, xx));
          const s = (yy * width + xx) * 3;
          r += rgb[s] * ww; g += rgb[s + 1] * ww; b += rgb[s + 2] * ww; w += ww;
        }
      }
      const o = (y * PREVIEW_WIDTH + x0 + x) * 4;
      out[o] = Math.round(r / w); out[o + 1] = Math.round(g / w); out[o + 2] = Math.round(b / w);
    }
  }
  return out;
}

/** Problems of a list of pictures (empty when it can be built). */
export function checkShutdownPictures(pictures: readonly ShutdownPictureSpec[]): void {
  if (!(pictures.length >= 1 && pictures.length <= SHUTDOWN_MAX_PICTURES)) fail('too-many-pictures', `1 to ${SHUTDOWN_MAX_PICTURES} power-off pictures`);
  const ids = new Set<number>();
  pictures.forEach((s, k) => {
    if (!(Number.isInteger(s.id) && s.id >= 1 && s.id <= 0xffffffff) || ids.has(s.id)) fail('bad-picture', `power-off picture ${k + 1}: identity`);
    ids.add(s.id);
    const problem = validateShutdownName(s.name);
    if (problem) fail('bad-name', `power-off picture ${k + 1}: name is ${problem}`);
    if (!(s.jpeg instanceof Uint8Array) || s.jpeg.length !== SHUTDOWN_JPEG_BYTES) fail('bad-picture', `power-off picture ${k + 1}: JPEG of ${SHUTDOWN_JPEG_BYTES} bytes expected`);
  });
}

/** The RES files of the pictures, in list order. */
export function shutdownFiles(pictures: readonly ShutdownPictureSpec[]): { path: string; data: Uint8Array }[] {
  return pictures.map((s, k) => ({ path: shutdownPath(k), data: s.jpeg }));
}

/**
 * Install the pictures' menu into an RTOS image that has the catalog scaffold of `build.ts`.
 * `factoryJpegs` are the four factory pictures (FACTORY_PICTURES order) from the payload's RES
 * section, for their thumbnails. Returns the new ICONBIN data. The RES files themselves are added
 * by `growPayload` (`shutdownFiles`).
 */
export function installShutdownMenu(p: Patch, iconbin: Uint8Array, pictures: readonly ShutdownPictureSpec[], factoryJpegs: readonly Uint8Array[]): Uint8Array {
  checkShutdownPictures(pictures);
  if (factoryJpegs.length !== FACTORY_PICTURES.length) fail('internal', 'four factory pictures expected');
  if (p.textBoundSites.length === 0) fail('internal', 'the catalog scaffold is not installed');
  const n = pictures.length;

  // --- Thumbnails (icons): factory 992..995, pictures 996...
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  const thumbs = [...factoryJpegs.map((j) => shutdownThumbnail(j)), ...pictures.map((s) => shutdownThumbnail(s.jpeg))];
  const iconIds: number[] = [];
  thumbs.forEach((px, i) => {
    const id = SHUTDOWN_ICON_ID + i;
    const pad = (4 - (length % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    expectWord(p, ICON_CATALOG + id * 4, 0);
    const desc = p.append(concat([u16le([1, PREVIEW_WIDTH, PREVIEW_HEIGHT, 0]), u32le([length / 4])]), 16);
    p.setWord(ICON_CATALOG + id * 4, desc, 'power-off picture thumbnail');
    parts.push(px);
    length += px.length;
    iconIds.push(id);
  });
  const lastIcon = iconIds[iconIds.length - 1];
  for (const [site, r] of LOOKUP_BOUNDS) p.setWord(site, movWord(r, Math.max(lastIcon, movImmediate(p.word(site)))), 'icon upper bound');

  // --- Texts: the factory row per language, then the names (the same in every language).
  const desc = (text: string): number => {
    const encoded = utf16z(text);
    const at = p.append(encoded, 4);
    return p.append(concat([Uint8Array.from([encoded.length / 2, 1, 0, 0]), u32le([at])]), 4);
  };
  const english = desc('Original');
  const own: Record<number, number> = {};
  for (const [row, text] of Object.entries(FACTORY_LABELS)) own[Number(row)] = desc(text);
  const names = pictures.map((s) => desc(s.name));
  for (let l = 0; l < 21; l++) {
    const row = p.word(TEXT_CATALOG + l * 4);
    for (let k = 0; k <= n; k++) expectWord(p, row + (SHUTDOWN_TEXT_ID + k) * 4, 0);
    p.write(row + SHUTDOWN_TEXT_ID * 4, u32le([own[l] ?? english, ...names]));
  }
  const lastText = SHUTDOWN_TEXT_ID + n;
  for (const site of p.textBoundSites) p.setWord(site, movWord(3, Math.max(lastText, movImmediate(p.word(site)))), 'text upper bound');

  // --- The table of full-screen JPEGs, extended.
  const original = p.readMapped(JPEG_TABLE, JPEG_TABLE_COUNT * 4);
  const entries = pictures.map((_, k) => {
    const path = p.append(concat([Uint8Array.from(shutdownPath(k), (c) => c.charCodeAt(0)), new Uint8Array(1)]), 4);
    return p.append(concat([u16le([SHUTDOWN_WIDTH, SHUTDOWN_HEIGHT]), u32le([path])]), 4);
  });
  const table = p.append(concat([original, u32le(entries)]), 16);
  for (const [low, high, r] of TABLE_SITES) {
    expectWord(p, low, movWord(r, JPEG_TABLE & 0xffff));
    expectWord(p, high, movWord(r, JPEG_TABLE >>> 16, true));
    p.setWord(low, movWord(r, table & 0xffff), 'full-screen JPEG table with the power-off pictures');
    p.setWord(high, movWord(r, table >>> 16, true), 'full-screen JPEG table with the power-off pictures');
  }

  // --- Module, context, stubs.
  expectWord(p, BACKGROUND, 0xe1a0c00d);
  expectWord(p, MENU.refresh, 0xe1a0c00d);
  expectWord(p, MENU.confirm, 0xe5900168);
  expectWord(p, MENU.left, 0xe1a0c00d);
  expectWord(p, MENU.right, 0xe1a0c00d);
  expectWord(p, MENU.footer, 0xe1a0c00d);
  expectWord(p, MENU_ROWS_AT, 0xe3a02002);
  expectWord(p, MENU_TYPES_AT, 0xe54b3034);
  expectWord(p, APDATA_BOUND_AT, 0xe58d9000);
  const priorSave = branchTarget(SETTINGS_SAVE, p.word(SETTINGS_SAVE));
  if (priorSave < BASE + OFFICIAL_RTOS_LENGTH) fail('internal', 'the settings save/load scaffold is not installed');

  const raw = Uint8Array.from(atob(SHUTDOWN_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== SHUTDOWN_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'power-off module length');
  const code = p.append(raw, 16);
  const body = p.append((at) => [0xe1a0c00d, branchWord(at + 4, BACKGROUND_BODY)], 16);
  const ctxBytes = new Uint8Array(CTX_BYTES);
  const v = new DataView(ctxBytes.buffer);
  [CTX_MAGIC, SHUTDOWN_RECORD, n, SHUTDOWN_TEXT_ID, body, priorSave].forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  let o = 24;
  for (let i = 0; i < 4; i++, o += 2) v.setUint16(o, iconIds[i], true);
  for (let k = 0; k < SHUTDOWN_MAX_PICTURES; k++, o += 2) v.setUint16(o, k < n ? iconIds[4 + k] : 0, true);
  for (let k = 0; k < SHUTDOWN_MAX_PICTURES; k++, o += 4) v.setUint32(o, k < n ? pictures[k].id >>> 0 : 0, true);
  for (let k = 0; k < SHUTDOWN_MAX_PICTURES; k++, o += 4) v.setUint32(o, k < n ? JPEG_TABLE_COUNT + k : 0, true);
  const ctx = p.append(ctxBytes, 16);
  const stub = (reg: number, fn: keyof typeof SHUTDOWN_EXPORTS): number =>
    p.append((at) => [movWord(reg, ctx & 0xffff), movWord(reg, ctx >>> 16, true), branchWord(at + 8, code + SHUTDOWN_EXPORTS[fn])], 16);
  p.setWord(BACKGROUND, branchWord(BACKGROUND, stub(1, 'sd_background')), 'power-off picture: the one chosen in the menu');
  p.setWord(SETTINGS_SAVE, branchWord(SETTINGS_SAVE, stub(1, 'sd_save')), 'settings save, then the power-off picture choice');
  p.setWord(MENU.refresh, branchWord(MENU.refresh, stub(1, 'sd_refresh')), 'End Screen menu: rows and ticks');
  p.setWord(MENU.confirm, branchWord(MENU.confirm, stub(1, 'sd_confirm')), 'End Screen menu: confirm');
  p.setWord(MENU.left, branchWord(MENU.left, stub(2, 'sd_left')), 'End Screen menu: up');
  p.setWord(MENU.right, branchWord(MENU.right, stub(2, 'sd_right')), 'End Screen menu: down');
  p.setWord(MENU.footer, branchWord(MENU.footer, stub(1, 'sd_footer')), 'End Screen menu: thumbnail');
  // The constructor: 3 + n rows, their types from an appended array (the native one is 2 bytes on the stack).
  const rows = 3 + n;
  const types = p.append(new Uint8Array(rows).fill(ROW_TYPE), 4);
  const typesAt = p.append((at) => [movWord(1, types & 0xffff), movWord(1, types >>> 16, true), branchWord(at + 8, MENU_TYPES_NEXT)], 16);
  p.setWord(MENU_ROWS_AT, (0xe3a02000 | rows) >>> 0, 'End Screen menu: rows');
  p.setWord(MENU_TYPES_AT, branchWord(MENU_TYPES_AT, typesAt), 'End Screen menu: row types');
  // The settings store APData with room for the choice's record.
  // movw r3,#records; str r3,[sp] (the count argument); continue after the original `str sb,[sp]`.
  const bound = p.append((at) => [movWord(3, SHUTDOWN_RECORD + 1), 0xe58d3000, branchWord(at + 8, APDATA_BOUND_NEXT)], 16);
  p.setWord(APDATA_BOUND_AT, branchWord(APDATA_BOUND_AT, bound), 'settings store APData: room for the power-off picture record');
  return concat(parts);
}

/** What a built image holds: the pictures' identities and names (their JPEGs are RES files), or null. */
export function readShutdownMenu(p: Patch): { id: number; name: string }[] | null {
  try {
    const first = p.word(BACKGROUND);
    if (first >>> 24 !== 0xea) return null;
    const stub = branchTarget(BACKGROUND, first);
    const ctx = (movImmediate(p.word(stub)) | (movImmediate(p.word(stub + 4)) << 16)) >>> 0;
    const v = new DataView(p.read(ctx, CTX_BYTES).buffer);
    if (v.getUint32(0, true) !== CTX_MAGIC || v.getUint32(4, true) !== SHUTDOWN_RECORD) return null;
    const n = v.getUint32(8, true);
    const textId = v.getUint32(12, true);
    if (!(n >= 1 && n <= SHUTDOWN_MAX_PICTURES) || textId !== SHUTDOWN_TEXT_ID) return null;
    const row = p.word(TEXT_CATALOG + 1 * 4);
    const out: { id: number; name: string }[] = [];
    for (let k = 0; k < n; k++) {
      const id = v.getUint32(24 + 8 + 2 * SHUTDOWN_MAX_PICTURES + 4 * k, true);
      const d = p.word(row + (textId + 1 + k) * 4);
      const units = p.read(d, 1)[0];
      const at = p.word(d + 4);
      const bytes = p.read(at, units * 2);
      let name = '';
      for (let i = 0; i < units - 1; i++) name += String.fromCharCode(bytes[2 * i] | (bytes[2 * i + 1] << 8));
      out.push({ id, name });
    }
    return out;
  } catch {
    return null;
  }
}

/** The four factory pictures (FACTORY_PICTURES order) from a payload's RES section. */
export function factoryShutdownJpegs(payload: Uint8Array): Uint8Array[] {
  const dir = readRes(payload);
  return FACTORY_PICTURES.map((f) => {
    const data = resFile(payload, f.path, dir);
    if (!data) fail('unexpected-layout', `RES has no ${f.path}`);
    return data;
  });
}

/** The power-off pictures' JPEGs in a grown payload's RES section (list order), or null. */
export function readShutdownJpegs(payload: Uint8Array, count: number): Uint8Array[] | null {
  try {
    const dir = readRes(payload);
    const out: Uint8Array[] = [];
    for (let k = 0; k < count; k++) {
      const data = resFile(payload, shutdownPath(k), dir);
      if (!data || data.length !== SHUTDOWN_JPEG_BYTES) return null;
      out.push(data);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A 720x480 RGB picture (3 bytes per pixel) as a power-off picture file: baseline JPEG, 4:2:2 like
 * the factory HDF picture, at the highest standard quality (IJG scale, 1..100) that fits, padded
 * to exactly SHUTDOWN_JPEG_BYTES bytes with comment segments (FF FE) after SOI, which decoders
 * skip. Deterministic. Throws 'bad-picture' when even quality 1 does not fit.
 */
export function encodeShutdownPicture(rgb: Uint8Array | Uint8ClampedArray, onProgress?: (f: number) => void): Uint8Array {
  if (rgb.length !== SHUTDOWN_WIDTH * SHUTDOWN_HEIGHT * 3) fail('bad-picture', 'a power-off picture is 720 x 480 RGB');
  const layout = makeLayout(SHUTDOWN_WIDTH, SHUTDOWN_HEIGHT, '422');
  const coef = forwardTransform(rgb, layout);
  const at = (q: number): Uint8Array => {
    const [l, c] = qualityTables(q);
    return encodeCoefficients(coef, layout, l, c);
  };
  // Room for at least one comment segment (4 bytes).
  const room = SHUTDOWN_JPEG_BYTES - 4;
  let best = at(1);
  if (best.length > room) fail('bad-picture', 'the picture is too detailed for a power-off picture');
  let lo = 2, hi = 100, steps = 0;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const data = at(q);
    onProgress?.(Math.min(0.95, ++steps / 8));
    if (data.length <= room) { best = data; lo = q + 1; } else hi = q - 1;
  }
  const out = padJpeg(best, SHUTDOWN_JPEG_BYTES);
  onProgress?.(1);
  return out;
}

/** `jpeg` (starting with SOI) made exactly `length` bytes by comment segments after SOI (each 4..65537 bytes). */
function padJpeg(jpeg: Uint8Array, length: number): Uint8Array {
  let pad = length - jpeg.length;
  if (pad < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('internal', 'cannot pad the picture');
  const segments: Uint8Array[] = [];
  while (pad > 0) {
    // a segment is 2 marker bytes + its length field value (2..65535); never leave 1..3 bytes over
    let size = Math.min(pad, 65537);
    if (pad - size > 0 && pad - size < 4) size -= 4;
    const seg = new Uint8Array(size);
    seg[0] = 0xff; seg[1] = 0xfe; seg[2] = (size - 2) >> 8; seg[3] = (size - 2) & 0xff;
    segments.push(seg);
    pad -= size;
  }
  return concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}
