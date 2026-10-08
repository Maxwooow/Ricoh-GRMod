// SPDX-License-Identifier: GPL-2.0-only
/**
 * Put an RTOS image and ICONBIN data that have grown (see `build.ts`) into the decoded payload.
 *
 * Both sections grow by a whole number of container frames (0x6000 bytes), zero-padded, so that
 * the container can be rebuilt from official frames and full-length stored frames only. The end of
 * the new RTOS section holds, in this order: zero padding, a small record of the added ratios
 * (so that the program can recognise and re-create its own files), and one word that keeps the
 * 32-bit sum of the whole payload at zero. The payload's own last word is therefore unchanged.
 *
 *   ... appended code and data | 00 .. 00 | record | u32 record length | "GRMODAR<n>" | u32 sum word
 *
 * <n> is the build revision (`BuildRevision` in `build.ts`): which additions of this program the
 * appended code holds. Up to revision 2 the record lists 1 to 8 ratios. From revision 3 it may list
 * none, and one more byte follows the ratios: the other additions (bit 0: soft focus on the ADJ
 * lever).
 */
import { FRAME_SIZE, sectionsOf, sum32 } from '../container';
import type { Insertion, Section } from '../container';
import { FirmwareError } from '../types';
import type { Range } from '../types';
import { MAX_CUSTOM_RATIOS, OFFICIAL_ICONBIN_LENGTH, OFFICIAL_RTOS_LENGTH } from './build';
import type { AspectResult, BuildRevision, ExtensionFeatures, RatioSpec } from './build';

const MAGIC_STEM = 'GRMODAR';
const MAGIC_LENGTH = MAGIC_STEM.length + 1;
const TRAILER_FIXED = 4 + MAGIC_LENGTH + 4;
const magicOf = (revision: BuildRevision): string => MAGIC_STEM + String(revision);

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!(c >= 0x20 && c <= 0x7e)) fail('bad-name', 'only printable ASCII can be recorded');
    out[i] = c;
  }
  return out;
}

const FEATURE_ADJ_SOFT_FOCUS = 1;
const FEATURE_DATE_STAMP = 2;

/**
 * `u8 count, then per ratio: u8 length + ratio text, u8 length + name`, (revision 3: `u8 features`),
 * zero-padded to 4 bytes.
 */
function encodeRecord(specs: readonly RatioSpec[], revision: BuildRevision, features: ExtensionFeatures): Uint8Array {
  const bytes: number[] = [specs.length];
  for (const s of specs) {
    const r = ascii(s.ratio.trim());
    const n = ascii(s.name);
    if (r.length > 64 || n.length > 80 || r.length === 0 || n.length === 0) fail('bad-ratio', 'ratio or name too long to record');
    bytes.push(r.length, ...r, n.length, ...n);
  }
  if (revision >= 3) bytes.push((features.adjSoftFocus ? FEATURE_ADJ_SOFT_FOCUS : 0) | (features.dateStamp ? FEATURE_DATE_STAMP : 0));
  while (bytes.length % 4) bytes.push(0);
  return Uint8Array.from(bytes);
}

/** The build revision named at the end of a grown RTOS section, or null when there is no record of this program. */
export function readBuildRevision(rtos: Uint8Array): BuildRevision | null {
  if (rtos.length < OFFICIAL_RTOS_LENGTH + TRAILER_FIXED || rtos.length % 4 !== 0) return null;
  const at = rtos.length - 4 - MAGIC_LENGTH;
  for (let i = 0; i < MAGIC_STEM.length; i++) if (rtos[at + i] !== MAGIC_STEM.charCodeAt(i)) return null;
  const digit = rtos[at + MAGIC_STEM.length] - 0x30;
  return digit === 1 || digit === 2 || digit === 3 ? digit : null;
}

interface ParsedRecord {
  specs: RatioSpec[];
  features: ExtensionFeatures;
}

function parseRecord(rtos: Uint8Array): ParsedRecord | null {
  const revision = readBuildRevision(rtos);
  if (revision === null) return null;
  const end = rtos.length - 4;
  const lp = end - MAGIC_LENGTH - 4;
  const length = (rtos[lp] | (rtos[lp + 1] << 8) | (rtos[lp + 2] << 16) | (rtos[lp + 3] << 24)) >>> 0;
  if (length % 4 !== 0 || length < 4 || lp - length < OFFICIAL_RTOS_LENGTH) return null;
  const rec = rtos.subarray(lp - length, lp);
  const count = rec[0];
  if (!(count >= (revision >= 3 ? 0 : 1) && count <= MAX_CUSTOM_RATIOS)) return null;
  let p = 1;
  const text = (): string | null => {
    if (p >= rec.length) return null;
    const n = rec[p++];
    if (n === 0 || p + n > rec.length) return null;
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = rec[p + i];
      if (!(c >= 0x20 && c <= 0x7e)) return null;
      s += String.fromCharCode(c);
    }
    p += n;
    return s;
  };
  const out: RatioSpec[] = [];
  for (let k = 0; k < count; k++) {
    const ratio = text();
    const name = text();
    if (ratio === null || name === null) return null;
    out.push({ name, ratio });
  }
  const features: ExtensionFeatures = {};
  if (revision >= 3) {
    if (p >= rec.length) return null;
    const f = rec[p++];
    if ((f & ~(FEATURE_ADJ_SOFT_FOCUS | FEATURE_DATE_STAMP)) !== 0) return null;
    if (f & FEATURE_ADJ_SOFT_FOCUS) features.adjSoftFocus = true;
    if (f & FEATURE_DATE_STAMP) features.dateStamp = true;
    if (count === 0 && !features.adjSoftFocus && !features.dateStamp) return null;
  }
  for (; p < rec.length; p++) if (rec[p] !== 0) return null;
  return { specs: out, features };
}

/** The ratios recorded at the end of a grown RTOS section (possibly none, from revision 3), or null when there is no (valid) record. */
export function readRatioRecord(rtos: Uint8Array): RatioSpec[] | null {
  const r = parseRecord(rtos);
  return r ? r.specs : null;
}

/** This program's other additions recorded at the end of a grown RTOS section, or null when there is no (valid) record. */
export function readExtensionFeatures(rtos: Uint8Array): ExtensionFeatures | null {
  const r = parseRecord(rtos);
  return r ? r.features : null;
}

const roundUp = (n: number, unit: number): number => Math.ceil(n / unit) * unit;

export interface GrownPayload {
  decoded: Uint8Array;
  /** For `buildGrown`: where, in official payload offsets, the new blocks were inserted. */
  insertions: Insertion[];
  rtosGrowth: number;
  iconGrowth: number;
  /** Offset of the grown sections' data in the NEW payload. */
  rtosOffset: number;
  iconOffset: number;
}

function section(sections: Section[], name: string): Section {
  const s = sections.find((x) => x.name === name);
  if (!s) fail('unexpected-layout', `no ${name} section`);
  return s;
}

function putU32(d: Uint8Array, o: number, v: number): void {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff;
  d[o + 3] = v >>> 24;
}

/**
 * `payload` is a decoded payload of official layout (possibly with same-length edits);
 * `aspect` was built from ITS RTOS and ICONBIN data. Returns the longer payload, word sum zero.
 */
export function growPayload(payload: Uint8Array, aspect: AspectResult, specs: readonly RatioSpec[]): GrownPayload {
  const sections = sectionsOf(payload);
  const rtos = section(sections, 'RTOS');
  const icon = section(sections, 'ICONBIN');
  if (rtos.size !== OFFICIAL_RTOS_LENGTH || icon.size !== OFFICIAL_ICONBIN_LENGTH || !(rtos.offset < icon.offset)) fail('unexpected-layout', 'payload sections are not the official ones');
  if (aspect.rtos.length <= OFFICIAL_RTOS_LENGTH || aspect.rtos.length % 4 !== 0 || aspect.iconbin.length <= OFFICIAL_ICONBIN_LENGTH) fail('internal', 'nothing was appended');
  if (specs.length !== aspect.ratios.length) fail('internal', 'ratio list does not match the build');
  for (let i = 0; i < OFFICIAL_ICONBIN_LENGTH; i += 4096) {
    // The official part of ICONBIN is passed through untouched; a cheap spot check of that.
    if (aspect.iconbin[i] !== payload[icon.offset + i]) fail('internal', 'ICONBIN prefix changed');
  }
  const record = encodeRecord(specs, aspect.revision, aspect.features ?? {});
  const appended = aspect.rtos.length - OFFICIAL_RTOS_LENGTH;
  const rtosGrowth = roundUp(appended + record.length + TRAILER_FIXED, FRAME_SIZE);
  const iconGrowth = roundUp(aspect.iconbin.length - OFFICIAL_ICONBIN_LENGTH, FRAME_SIZE);

  const out = new Uint8Array(payload.length + rtosGrowth + iconGrowth);
  const rtosEnd = rtos.offset + OFFICIAL_RTOS_LENGTH; // official offsets
  const iconEnd = icon.offset + OFFICIAL_ICONBIN_LENGTH;
  // [0, RTOS data) | RTOS | growth | (RTOS end, ICONBIN end) | growth | rest
  out.set(payload.subarray(0, rtos.offset), 0);
  out.set(aspect.rtos, rtos.offset);
  out.set(payload.subarray(rtosEnd, icon.offset), rtosEnd + rtosGrowth);
  const iconOffset = icon.offset + rtosGrowth;
  out.set(aspect.iconbin, iconOffset);
  out.set(payload.subarray(iconEnd), iconEnd + rtosGrowth + iconGrowth);
  // Section sizes (the u32 before each section's data).
  putU32(out, rtos.offset - 4, OFFICIAL_RTOS_LENGTH + rtosGrowth);
  putU32(out, iconOffset - 4, OFFICIAL_ICONBIN_LENGTH + iconGrowth);
  // Record, its length, the magic, and the sum word at the very end of the RTOS section.
  const newRtosEnd = rtos.offset + OFFICIAL_RTOS_LENGTH + rtosGrowth;
  let p = newRtosEnd - TRAILER_FIXED - record.length;
  if (p < rtos.offset + aspect.rtos.length) fail('internal', 'record overlaps the appended area');
  out.set(record, p);
  p += record.length;
  putU32(out, p, record.length);
  p += 4;
  const magic = magicOf(aspect.revision);
  for (let i = 0; i < magic.length; i++) out[p + i] = magic.charCodeAt(i);
  p += magic.length;
  putU32(out, p, (-sum32(out)) >>> 0);
  if (sum32(out) !== 0) fail('internal', 'payload word sum is not zero');
  return {
    decoded: out,
    insertions: [{ at: rtosEnd, length: rtosGrowth }, { at: iconEnd, length: iconGrowth }],
    rtosGrowth, iconGrowth, rtosOffset: rtos.offset, iconOffset,
  };
}

/** Planned ranges (NEW payload offsets) of everything `growPayload` adds or changes, for the self-check. */
export function grownRanges(g: GrownPayload, aspect: AspectResult): Range[] {
  const out: Range[] = [];
  for (const w of aspect.words) out.push({ what: `ratio hook 0x${w.address.toString(16)}`, offset: g.rtosOffset + (w.address - 0x53000000), length: 4 });
  out.push({ what: 'RTOS section size', offset: g.rtosOffset - 4, length: 4 });
  out.push({ what: 'RTOS appended area', offset: g.rtosOffset + OFFICIAL_RTOS_LENGTH, length: g.rtosGrowth });
  out.push({ what: 'ICONBIN section size', offset: g.iconOffset - 4, length: 4 });
  out.push({ what: 'ICONBIN appended icons', offset: g.iconOffset + OFFICIAL_ICONBIN_LENGTH, length: g.iconGrowth });
  return out;
}
