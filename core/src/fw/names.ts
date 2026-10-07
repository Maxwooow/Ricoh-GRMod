/**
 * UI strings of firmware 1.11.
 *
 * There are 21 language tables in the RAM image, each 836 u32 pointers. Each pointer is the VA of
 * an 8-byte descriptor `{u32 count, u32 strVA}`; the string is UTF-16LE at strVA followed by a
 * 0x0000 terminator.
 *
 * `count` packs two things (verified on all 21 x 836 = 17556 entries of the official file):
 *   low byte  = number of UTF-16 code units + 1 (i.e. including the terminator)
 *   next byte = number of lines (1 + number of '\n' in the string)
 * so for a single-line string, such as every style name, `count = 0x101 + nChars`. Multi-line
 * help texts have counts 0x2xx / 0x3xx and must NOT be read as `count - 0x101` characters.
 *
 * Descriptors and strings are interleaved in one read-only area of the RTOS image, each string
 * directly followed (after its terminator and padding) by other data, so a name can never grow
 * beyond its official length ("capacity").
 */
import { FirmwareError } from './types';
import type { Range } from './types';
import { RTOS_LENGTH, RTOS_OFFSET, RTOS_VA } from './profile';

/** Language codes, in table order. */
export const LANGS = [
  'cs', 'da', 'en', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'ja', 'ko',
  'nl', 'pl', 'pt', 'ru', 'zh-CN', 'es', 'sv', 'th', 'zh-TW', 'tr',
] as const;
export type LangCode = (typeof LANGS)[number];

/** Start of each language's pointer table as an offset inside the RTOS section, in `LANGS` order. */
export const NAME_TABLE_RTOS_OFFSETS: readonly number[] = [
  0x137d7b0, 0x137e4c4, 0x137f1d8, 0x137feec, 0x1380c00, 0x1381914, 0x1382628,
  0x138333c, 0x1384050, 0x1384d64, 0x1385a78, 0x138678c, 0x13874a0, 0x13881b4,
  0x1388ec8, 0x1389bdc, 0x138a8f0, 0x138b604, 0x138c318, 0x138d02c, 0x138dd40,
];
export const NAME_TABLE_ENTRIES = 836;

export interface NameInfo {
  text: string;
  /**
   * Number of UTF-16 code units of the string AS STORED IN THE PAYLOAD THAT WAS PASSED IN.
   * On the official payload this is the storage capacity of the name (a replacement may be at
   * most this long). On an already patched payload it is just the current text length; the real
   * capacity can only be read from the official payload.
   */
  capacity: number;
  /** Decoded offset of the 8-byte descriptor. */
  descOffset: number;
  /** Decoded offset of the first UTF-16 code unit. */
  strOffset: number;
}

export interface NameValidation {
  ok: boolean;
  reason?: 'empty' | 'too-long' | 'bad-char';
  /** The offending characters (each once), for 'bad-char'. */
  badChars?: string[];
  capacity: number;
}

interface Entry {
  /** VA stored in the table. */
  ptr: number;
  descOffset: number;
  strOffset: number;
  count: number;
  lines: number;
  nChars: number;
}

function langIndex(lang: LangCode): number {
  const i = (LANGS as readonly string[]).indexOf(lang);
  if (i < 0) throw new FirmwareError('bad-language', `unknown language ${String(lang)}`);
  return i;
}

function u32at(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function u16at(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function tablePointer(decoded: Uint8Array, li: number, index: number): number {
  return u32at(decoded, RTOS_OFFSET + NAME_TABLE_RTOS_OFFSETS[li] + 4 * index);
}

/**
 * Decode one table entry; null when it is not a plain descriptor (count outside 0x101..0x7FF,
 * pointers outside RTOS, or no terminator where the count says the string ends).
 */
function entryAt(decoded: Uint8Array, li: number, index: number): Entry | null {
  if (decoded.length < RTOS_OFFSET + RTOS_LENGTH) throw new FirmwareError('unexpected-layout', 'payload is too short');
  const ptr = tablePointer(decoded, li, index);
  const a = ptr - RTOS_VA;
  if (!(a >= 0 && a + 8 <= RTOS_LENGTH)) return null;
  const count = u32at(decoded, RTOS_OFFSET + a);
  if (!(count >= 0x101 && count <= 0x7ff)) return null;
  const nChars = (count & 0xff) - 1;
  if (nChars < 0) return null;
  const s = u32at(decoded, RTOS_OFFSET + a + 4) - RTOS_VA;
  if (!(s >= 0 && s + 2 * (nChars + 1) <= RTOS_LENGTH)) return null;
  if (u16at(decoded, RTOS_OFFSET + s + 2 * nChars) !== 0) return null;
  return { ptr, descOffset: RTOS_OFFSET + a, strOffset: RTOS_OFFSET + s, count, lines: count >>> 8, nChars };
}

function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= NAME_TABLE_ENTRIES) {
    throw new FirmwareError('bad-name-index', `string index ${index} is out of range`);
  }
}

function entryText(decoded: Uint8Array, e: Entry): string {
  let text = '';
  for (let i = 0; i < e.nChars; i++) text += String.fromCharCode(u16at(decoded, e.strOffset + 2 * i));
  return text;
}

/** Read string `index` of a language. Offsets are decoded-payload offsets. */
export function readName(decoded: Uint8Array, lang: LangCode, index: number): NameInfo {
  checkIndex(index);
  const e = entryAt(decoded, langIndex(lang), index);
  if (!e) throw new FirmwareError('bad-name-entry', `string ${lang} #${index} is not a plain descriptor`);
  return { text: entryText(decoded, e), capacity: e.nChars, descOffset: e.descOffset, strOffset: e.strOffset };
}

/**
 * Every UTF-16 code unit that occurs in any of the language's 836 strings, plus ASCII 0x20-0x7E.
 * (This is a proxy for "the camera's font for this language has the glyph".) Note that the set
 * contains '\n' because of multi-line help texts; `validateName` rejects control characters itself.
 */
export function allowedChars(decoded: Uint8Array, lang: LangCode): Set<number> {
  const li = langIndex(lang);
  const set = new Set<number>();
  for (let c = 0x20; c <= 0x7e; c++) set.add(c);
  for (let i = 0; i < NAME_TABLE_ENTRIES; i++) {
    const e = entryAt(decoded, li, i);
    if (!e) continue;
    for (let k = 0; k < e.nChars; k++) set.add(u16at(decoded, e.strOffset + 2 * k));
  }
  return set;
}

function isControl(u: number): boolean {
  return u < 0x20 || (u >= 0x7f && u <= 0x9f);
}

/**
 * Check a replacement text for string `index` against the OFFICIAL decoded payload:
 * 1..capacity UTF-16 code units, every unit in `allowedChars`, no control characters, no lone
 * surrogates, no leading/trailing white space. Leading/trailing white space and control
 * characters are reported as 'bad-char'.
 */
export function validateName(decoded: Uint8Array, lang: LangCode, index: number, text: string): NameValidation {
  const { capacity } = readName(decoded, lang, index);
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty', capacity };
  if (text.length > capacity) return { ok: false, reason: 'too-long', capacity };
  const allowed = allowedChars(decoded, lang);
  const bad: string[] = [];
  const addBad = (ch: string): void => {
    if (!bad.includes(ch)) bad.push(ch);
  };
  for (const ch of text) {
    // `ch` is one code point: one unit, or a well-formed surrogate pair.
    let ok = true;
    for (let i = 0; i < ch.length; i++) {
      const u = ch.charCodeAt(i);
      if (isControl(u) || !allowed.has(u)) ok = false;
      if (ch.length === 1 && u >= 0xd800 && u <= 0xdfff) ok = false;
    }
    if (!ok) addBad(ch);
  }
  const first = text[0];
  const last = text[text.length - 1];
  if (/\s/.test(first)) addBad(first);
  if (/\s/.test(last)) addBad(last);
  if (bad.length > 0) return { ok: false, reason: 'bad-char', badChars: bad, capacity };
  return { ok: true, capacity };
}

/**
 * Write a new text for string `index` into `image` (a working copy of the decoded payload).
 *
 * The text goes to the official string position; the rest of the official string storage (up to
 * `capacity` units) is filled with 0x0000; the descriptor count becomes `0x101 + newLen`.
 * Returns the edited ranges: string storage (`2 * capacity` bytes) and descriptor count (4 bytes).
 *
 * `official` is the untouched official decoded payload: positions, capacity and the safety
 * assertions are taken from it. It defaults to `image`, which is only correct while `image`
 * still holds the official string data (e.g. it is a fresh copy).
 *
 * Asserted on the official bytes before anything is written:
 *  (a) exactly one pointer across all 21 tables references this descriptor;
 *  (b) no other descriptor in any table has a string range overlapping
 *      [strOffset, strOffset + 2 * (capacity + 1));
 *  (c) no descriptor of any table lies inside that string range;
 *  and the entry is a single-line string, and the text passes `validateName`.
 */
export function applyName(image: Uint8Array, lang: LangCode, index: number, text: string, official: Uint8Array = image): Range[] {
  checkIndex(index);
  const li = langIndex(lang);
  if (image.length !== official.length) throw new FirmwareError('size-mismatch', 'image and official payload differ in size');
  const e = entryAt(official, li, index);
  if (!e) throw new FirmwareError('bad-name-entry', `string ${lang} #${index} is not a plain descriptor`);
  if (e.lines !== 1 || e.count !== 0x101 + e.nChars) {
    throw new FirmwareError('bad-name-entry', `string ${lang} #${index} is not a single-line string`);
  }
  const v = validateName(official, lang, index, text);
  if (!v.ok) {
    const extra = v.badChars ? ` (${v.badChars.join(' ')})` : '';
    throw new FirmwareError('bad-name', `${lang} #${index}: ${v.reason}${extra}, capacity ${v.capacity}`);
  }
  const capacity = e.nChars;
  const lo = e.strOffset;
  const hi = e.strOffset + 2 * (capacity + 1);

  let refs = 0;
  for (let l = 0; l < LANGS.length; l++) {
    for (let i = 0; i < NAME_TABLE_ENTRIES; i++) {
      const ptr = tablePointer(official, l, i);
      if (ptr === e.ptr) {
        refs++;
        continue;
      }
      const a = ptr - RTOS_VA;
      if (a >= 0 && a + 8 <= RTOS_LENGTH) {
        const dOff = RTOS_OFFSET + a;
        if (dOff < hi && dOff + 8 > lo) {
          throw new FirmwareError('name-not-exclusive', `a descriptor (${LANGS[l]} #${i}) lies inside the string storage of ${lang} #${index}`);
        }
      }
      const o = entryAt(official, l, i);
      if (!o) continue;
      const oLo = o.strOffset;
      const oHi = o.strOffset + 2 * (o.nChars + 1);
      if (oLo < hi && oHi > lo) {
        throw new FirmwareError('name-not-exclusive', `string ${LANGS[l]} #${i} overlaps the string storage of ${lang} #${index}`);
      }
    }
  }
  if (refs !== 1) throw new FirmwareError('name-not-exclusive', `${refs} table entries reference the descriptor of ${lang} #${index}`);
  if (e.descOffset < hi && e.descOffset + 8 > lo) throw new FirmwareError('name-not-exclusive', 'descriptor overlaps its own string');

  for (let i = 0; i < capacity; i++) {
    const u = i < text.length ? text.charCodeAt(i) : 0;
    image[lo + 2 * i] = u & 0xff;
    image[lo + 2 * i + 1] = u >>> 8;
  }
  const count = 0x101 + text.length;
  image[e.descOffset] = count & 0xff;
  image[e.descOffset + 1] = (count >>> 8) & 0xff;
  image[e.descOffset + 2] = 0;
  image[e.descOffset + 3] = 0;
  return [
    { what: `name ${lang} #${index} text`, offset: lo, length: 2 * capacity },
    { what: `name ${lang} #${index} length`, offset: e.descOffset, length: 4 },
  ];
}

/** The two ranges `applyName` may write for a string: its text storage and its length field. */
export function nameRanges(official: Uint8Array, lang: LangCode, index: number): Range[] {
  const n = readName(official, lang, index);
  return [
    { what: `name ${lang} #${index} text`, offset: n.strOffset, length: 2 * n.capacity },
    { what: `name ${lang} #${index} length`, offset: n.descOffset, length: 4 },
  ];
}
