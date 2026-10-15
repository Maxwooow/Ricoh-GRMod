// SPDX-License-Identifier: GPL-2.0-only
/**
 * Put an RTOS image and ICONBIN data that have grown (see `build.ts`) into the decoded payload.
 *
 * RTOS, and ICONBIN when icons were added, grow by a whole number of container frames (0x6000
 * bytes; ICONBIN may also stay as it is), zero-padded, so that
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
 * lever, bit 1: date imprint, bit 2: monochrome looks, bit 3: added Image Control slots, in which
 * case their number follows in one more byte; bit 4: power-off pictures, their number follows in
 * one more byte; the data of both is read back from the image itself).
 *
 * Power-off pictures (`shutdown.ts`) also add files to the RES section, the last one: their records
 * (two container frames each) are inserted after RES_ANCHOR, and the section's file count grows.
 */
import { FRAME_SIZE, sectionsOf, sum32 } from '../container';
import type { Insertion, Section } from '../container';
import { FirmwareError } from '../types';
import type { Range } from '../types';
import { MAX_CUSTOM_RATIOS, OFFICIAL_ICONBIN_LENGTH, OFFICIAL_RTOS_LENGTH } from './build';
import type { AspectResult, BuildRevision, ExtensionFeatures, RatioSpec } from './build';
import { MAX_EXTRA_SLOTS } from './slots';
import { RES_ANCHOR, SHUTDOWN_MAX_PICTURES, shutdownFiles } from './shutdown';
import { readRes, resRecords } from './res';

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
const FEATURE_MONO_UNLOCK = 4;
const FEATURE_EXTRA_SLOTS = 8;
const FEATURE_SHUTDOWN = 16;

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
  const slots = features.extraSlots?.length ?? 0;
  const pictures = features.shutdown?.pictures.length ?? 0;
  if (revision >= 3) bytes.push((features.adjSoftFocus ? FEATURE_ADJ_SOFT_FOCUS : 0) | (features.dateStamp ? FEATURE_DATE_STAMP : 0) | (features.monoUnlock ? FEATURE_MONO_UNLOCK : 0) | (slots > 0 ? FEATURE_EXTRA_SLOTS : 0) | (pictures > 0 ? FEATURE_SHUTDOWN : 0));
  if (revision >= 3 && slots > 0) bytes.push(slots);
  else if (slots > 0) fail('internal', 'added slots need revision 3');
  if (revision >= 3 && pictures > 0) bytes.push(pictures);
  else if (pictures > 0) fail('internal', 'power-off pictures need revision 3');
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
  /** Number of added Image Control slots (their data is in the image, see `slots.ts`). */
  extraSlots: number;
  /** Number of power-off pictures (their data is in the image, see `shutdown.ts`). */
  shutdownPictures: number;
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
  let extraSlots = 0;
  let shutdownPictures = 0;
  if (revision >= 3) {
    if (p >= rec.length) return null;
    const f = rec[p++];
    if ((f & ~(FEATURE_ADJ_SOFT_FOCUS | FEATURE_DATE_STAMP | FEATURE_MONO_UNLOCK | FEATURE_EXTRA_SLOTS | FEATURE_SHUTDOWN)) !== 0) return null;
    if (f & FEATURE_ADJ_SOFT_FOCUS) features.adjSoftFocus = true;
    if (f & FEATURE_DATE_STAMP) features.dateStamp = true;
    if (f & FEATURE_MONO_UNLOCK) features.monoUnlock = true;
    if (f & FEATURE_EXTRA_SLOTS) {
      if (p >= rec.length) return null;
      extraSlots = rec[p++];
      if (!(extraSlots >= 1 && extraSlots <= MAX_EXTRA_SLOTS)) return null;
    }
    if (f & FEATURE_SHUTDOWN) {
      if (p >= rec.length) return null;
      shutdownPictures = rec[p++];
      if (!(shutdownPictures >= 1 && shutdownPictures <= SHUTDOWN_MAX_PICTURES)) return null;
    }
    if (count === 0 && !features.adjSoftFocus && !features.dateStamp && !features.monoUnlock && extraSlots === 0 && shutdownPictures === 0) return null;
  }
  for (; p < rec.length; p++) if (rec[p] !== 0) return null;
  return { specs: out, features, extraSlots, shutdownPictures };
}
/** How many power-off pictures a grown RTOS section's record says were added (0 when none, null without a valid record). */
export function readShutdownCount(rtos: Uint8Array): number | null {
  const r = parseRecord(rtos);
  return r ? r.shutdownPictures : null;
}

/** How many Image Control slots a grown RTOS section's record says were added (0 when none, null without a valid record). */
export function readExtraSlotCount(rtos: Uint8Array): number | null {
  const r = parseRecord(rtos);
  return r ? r.extraSlots : null;
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
  /** Power-off pictures: bytes of RES files inserted (0 when none), where (NEW payload offset), and the NEW offset of RES's file count. */
  resGrowth: number;
  resOffset: number;
  resCountOffset: number;
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
  // RTOS always grows (at least by the record at its end); ICONBIN only when icons were added
  // (an addition that only adds code, like the date imprint of a test build, leaves it as it is).
  if (aspect.rtos.length <= OFFICIAL_RTOS_LENGTH || aspect.rtos.length % 4 !== 0 || aspect.iconbin.length < OFFICIAL_ICONBIN_LENGTH) fail('internal', 'nothing was appended');
  if (specs.length !== aspect.ratios.length) fail('internal', 'ratio list does not match the build');
  for (let i = 0; i < OFFICIAL_ICONBIN_LENGTH; i += 4096) {
    // The official part of ICONBIN is passed through untouched; a cheap spot check of that.
    if (aspect.iconbin[i] !== payload[icon.offset + i]) fail('internal', 'ICONBIN prefix changed');
  }
  const record = encodeRecord(specs, aspect.revision, aspect.features ?? {});
  const appended = aspect.rtos.length - OFFICIAL_RTOS_LENGTH;
  const rtosGrowth = roundUp(appended + record.length + TRAILER_FIXED, FRAME_SIZE);
  const iconGrowth = roundUp(aspect.iconbin.length - OFFICIAL_ICONBIN_LENGTH, FRAME_SIZE);

  // Power-off pictures: RES files after RES_ANCHOR (official payload offset `resAt`).
  const pictures = aspect.features.shutdown?.pictures ?? [];
  let resAt = 0;
  let resBlock: Uint8Array = new Uint8Array(0);
  let resCount = 0;
  let resCountOffset = 0;
  if (pictures.length > 0) {
    const dir = readRes(payload);
    const anchor = dir.files.find((f) => f.path === RES_ANCHOR);
    if (!anchor || dir.countOffset < icon.offset + OFFICIAL_ICONBIN_LENGTH) fail('unexpected-layout', 'RES section is not the official one');
    const files = shutdownFiles(pictures);
    if (dir.files.some((f) => files.some((x) => x.path === f.path))) fail('unexpected-layout', 'RES already holds power-off pictures');
    resAt = anchor.data + anchor.size;
    resBlock = resRecords(files);
    if (resBlock.length % FRAME_SIZE !== 0) fail('internal', 'power-off pictures are not whole frames');
    resCount = dir.files.length + files.length;
    resCountOffset = dir.countOffset;
  }
  const resGrowth = resBlock.length;
  const out = new Uint8Array(payload.length + rtosGrowth + iconGrowth + resGrowth);
  const rtosEnd = rtos.offset + OFFICIAL_RTOS_LENGTH; // official offsets
  const iconEnd = icon.offset + OFFICIAL_ICONBIN_LENGTH;
  // [0, RTOS data) | RTOS | growth | (RTOS end, ICONBIN end) | growth | rest
  out.set(payload.subarray(0, rtos.offset), 0);
  out.set(aspect.rtos, rtos.offset);
  out.set(payload.subarray(rtosEnd, icon.offset), rtosEnd + rtosGrowth);
  const iconOffset = icon.offset + rtosGrowth;
  out.set(aspect.iconbin, iconOffset);
  const after = rtosGrowth + iconGrowth;
  if (resGrowth > 0) {
    out.set(payload.subarray(iconEnd, resAt), iconEnd + after);
    out.set(resBlock, resAt + after);
    out.set(payload.subarray(resAt), resAt + after + resGrowth);
    putU32(out, resCountOffset + after, resCount);
  } else {
    out.set(payload.subarray(iconEnd), iconEnd + after);
  }
  // Section sizes (the u32 before each section's data).
  putU32(out, rtos.offset - 4, OFFICIAL_RTOS_LENGTH + rtosGrowth);
  if (iconGrowth > 0) putU32(out, iconOffset - 4, OFFICIAL_ICONBIN_LENGTH + iconGrowth);
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
    insertions: [{ at: rtosEnd, length: rtosGrowth }, ...(iconGrowth > 0 ? [{ at: iconEnd, length: iconGrowth }] : []), ...(resGrowth > 0 ? [{ at: resAt, length: resGrowth }] : [])],
    rtosGrowth, iconGrowth, rtosOffset: rtos.offset, iconOffset,
    resGrowth, resOffset: resGrowth > 0 ? resAt + rtosGrowth + iconGrowth : 0, resCountOffset: resGrowth > 0 ? resCountOffset + rtosGrowth + iconGrowth : 0,
  };
}

/** Planned ranges (NEW payload offsets) of everything `growPayload` adds or changes, for the self-check. */
export function grownRanges(g: GrownPayload, aspect: AspectResult): Range[] {
  const out: Range[] = [];
  for (const w of aspect.words) out.push({ what: `ratio hook 0x${w.address.toString(16)}`, offset: g.rtosOffset + (w.address - 0x53000000), length: 4 });
  out.push({ what: 'RTOS section size', offset: g.rtosOffset - 4, length: 4 });
  out.push({ what: 'RTOS appended area', offset: g.rtosOffset + OFFICIAL_RTOS_LENGTH, length: g.rtosGrowth });
  if (g.iconGrowth > 0) {
    out.push({ what: 'ICONBIN section size', offset: g.iconOffset - 4, length: 4 });
    out.push({ what: 'ICONBIN appended icons', offset: g.iconOffset + OFFICIAL_ICONBIN_LENGTH, length: g.iconGrowth });
  }
  if (g.resGrowth > 0) {
    out.push({ what: 'RES file count', offset: g.resCountOffset, length: 4 });
    out.push({ what: 'RES power-off pictures', offset: g.resOffset, length: g.resGrowth });
  }
  return out;
}
