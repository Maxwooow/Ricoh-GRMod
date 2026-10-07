/**
 * Independent check of a built firmware file (port of `check()` in `verify.py`, plus the section
 * sums). It deliberately takes only the two files and the planned ranges and re-derives everything
 * else; it shares nothing with the builder except the container parser.
 */
import { FOOTER_LEN, HDR, equalRange, parseFrames, sectionData, sectionsOf, sum32, verifyContainer } from './container';
import type { Frame } from './container';
import type { Range } from './types';

/** The updater checks of `verifyContainer` that must all be present and true. */
const UPDATER_CHECKS = [
  'hdr_proj2',
  'hdr_magic',
  'ftr_proj2',
  'ftr_magic',
  'file_sum_zero',
  'stream_len_matches',
  'decoded_len_matches',
  'decoded_sum_zero',
] as const;

/** All check names `selfCheck` can return (except the optional `decoded_equals_intended`). */
export const SELF_CHECK_NAMES = [
  ...UPDATER_CHECKS.map((k) => `updater_${k}`),
  'completed',
  'file_length_multiple_of_4',
  'header_identical',
  'model_records_identical',
  'footer_consistent',
  'terminator_present',
  'decoded_length_unchanged',
  'decoded_last_word_identical',
  'frame_count_unchanged',
  'frame_layout_unchanged',
  'frames_identical_or_stored_full',
  'first_frame_identical',
  'last_frame_identical',
  'changes_inside_planned_ranges',
  'section_layout_identical',
  'section_sums_identical',
] as const;

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function frameBytesEqual(a: Uint8Array, fa: Frame, b: Uint8Array, fb: Frame): boolean {
  return fa.end - fa.start === fb.end - fb.start && equalRange(a, fa.start, b, fb.start, fa.end - fa.start);
}

/**
 * Check `newRaw` against the official file.
 *
 * Returns a map of named booleans; the file is acceptable only if every value is true.
 * `intendedDecoded`, when given, adds `decoded_equals_intended` (decoding `newRaw` gives exactly
 * that payload). Never throws on a malformed `newRaw`: every check that could not be evaluated is
 * reported false and `completed` is false.
 */
export function selfCheck(officialRaw: Uint8Array, newRaw: Uint8Array, ranges: readonly Range[], intendedDecoded?: Uint8Array): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  for (const k of SELF_CHECK_NAMES) checks[k] = false;
  if (intendedDecoded !== undefined) checks.decoded_equals_intended = false;
  try {
    run(checks, officialRaw, newRaw, ranges, intendedDecoded);
    checks.completed = true;
  } catch {
    checks.completed = false;
  }
  return checks;
}

function run(checks: Record<string, boolean>, officialRaw: Uint8Array, newRaw: Uint8Array, ranges: readonly Range[], intendedDecoded?: Uint8Array): void {
  // 1. The updater's own checks.
  const v = verifyContainer(newRaw, intendedDecoded);
  for (const k of UPDATER_CHECKS) checks[`updater_${k}`] = v.checks[k] === true;
  if (intendedDecoded !== undefined) checks.decoded_equals_intended = v.checks.decoded_equals_expected === true;
  const dec = v.decoded;
  const fn = v.frames;
  const endN = v.streamEnd;

  // 2. Decode the official file from scratch.
  const off = parseFrames(officialRaw, u32(officialRaw, officialRaw.length - FOOTER_LEN + 16));
  const deco = off.decoded;
  const fo = off.frames;
  const endO = off.streamEnd;

  checks.file_length_multiple_of_4 = newRaw.length % 4 === 0;
  checks.header_identical = equalRange(newRaw, 0, officialRaw, 0, HDR);

  const padO = (4 - (endO % 4)) % 4;
  const padN = (4 - (endN % 4)) % 4;
  const mO = officialRaw.subarray(Math.min(endO + padO, officialRaw.length), Math.max(Math.min(endO + padO, officialRaw.length), officialRaw.length - FOOTER_LEN));
  const mN = newRaw.subarray(Math.min(endN + padN, newRaw.length), Math.max(Math.min(endN + padN, newRaw.length), newRaw.length - FOOTER_LEN));
  let padZero = true;
  for (let i = endN; i < endN + padN && i < newRaw.length; i++) if (newRaw[i] !== 0) padZero = false;
  checks.model_records_identical = padZero && mO.length === mN.length && mN.length > 0 && equalRange(mO, 0, mN, 0, mO.length);

  // Footer: project, magic, type and decoded length as official; stream length = what was parsed.
  const tO = officialRaw.length - FOOTER_LEN;
  const tN = newRaw.length - FOOTER_LEN;
  checks.footer_consistent =
    u32(officialRaw, tO) === u32(newRaw, tN) &&
    u32(officialRaw, tO + 4) === u32(newRaw, tN + 4) &&
    u32(officialRaw, tO + 8) === u32(newRaw, tN + 8) &&
    u32(officialRaw, tO + 16) === u32(newRaw, tN + 16) &&
    u32(newRaw, tN + 12) === endN - HDR;
  checks.terminator_present = endN >= HDR + 2 && newRaw[endN - 2] === 0 && newRaw[endN - 1] === 0;

  checks.decoded_length_unchanged = dec.length === deco.length;
  checks.decoded_last_word_identical = dec.length === deco.length && dec.length >= 4 && equalRange(dec, dec.length - 4, deco, deco.length - 4, 4);

  // 3. Frames.
  const sameCount = fn.length === fo.length && fo.length > 0;
  checks.frame_count_unchanged = sameCount;
  if (sameCount) {
    let layout = true;
    let form = true;
    for (let i = 0; i < fo.length; i++) {
      const a = fo[i];
      const b = fn[i];
      if (a.outStart !== b.outStart || a.outLen !== b.outLen) layout = false;
      if (frameBytesEqual(officialRaw, a, newRaw, b)) continue;
      // A changed frame must be stored, full length (prefix bytes exactly E0 00), with a body equal
      // to the decoded bytes it stands for: the same form as 308 frames of the official file.
      const ok =
        b.stored &&
        b.outLen === 0x6000 &&
        b.end - b.start === 2 + 0x6000 &&
        newRaw[b.start] === 0xe0 &&
        newRaw[b.start + 1] === 0x00 &&
        equalRange(newRaw, b.start + 2, dec, b.outStart, 0x6000);
      if (!ok) form = false;
    }
    checks.frame_layout_unchanged = layout;
    checks.frames_identical_or_stored_full = form;
    checks.first_frame_identical = frameBytesEqual(officialRaw, fo[0], newRaw, fn[0]);
    checks.last_frame_identical = frameBytesEqual(officialRaw, fo[fo.length - 1], newRaw, fn[fn.length - 1]);
  }

  // 4. Every differing decoded byte lies inside a planned range (per byte, union of ranges).
  if (dec.length === deco.length) {
    let rangesOk = true;
    for (const r of ranges) {
      if (!(Number.isInteger(r.offset) && Number.isInteger(r.length) && r.offset >= 0 && r.length >= 0 && r.offset + r.length <= dec.length)) rangesOk = false;
    }
    let inside = rangesOk;
    if (inside) {
      // Walk the bytes in order; `coverEnd` is the largest end among the ranges starting at or
      // before the current byte, so a byte is inside the union exactly when it is < coverEnd.
      const sorted = [...ranges].sort((x, y) => x.offset - y.offset);
      let ri = 0;
      let coverEnd = -1;
      for (let i = 0; i < dec.length; i++) {
        if (dec[i] === deco[i]) continue;
        while (ri < sorted.length && sorted[ri].offset <= i) {
          const end = sorted[ri].offset + sorted[ri].length;
          if (end > coverEnd) coverEnd = end;
          ri++;
        }
        if (i >= coverEnd) {
          inside = false;
          break;
        }
      }
    }
    checks.changes_inside_planned_ranges = inside;
  }

  // 5. Sections: same layout, same word sum for every section.
  const so = sectionsOf(deco);
  const sn = sectionsOf(dec);
  let layoutSame = so.length === sn.length && so.length > 0;
  if (layoutSame) {
    for (let i = 0; i < so.length; i++) {
      const a = so[i];
      const b = sn[i];
      if (a.name !== b.name || a.offset !== b.offset || a.size !== b.size || a.v1 !== b.v1 || a.v2 !== b.v2) layoutSame = false;
    }
  }
  checks.section_layout_identical = layoutSame;
  if (layoutSame) {
    let sums = true;
    for (let i = 0; i < so.length; i++) {
      if (sum32(sectionData(deco, so[i])) !== sum32(sectionData(dec, sn[i]))) sums = false;
    }
    checks.section_sums_identical = sums;
  }
}

/** Number of decoded bytes that differ (payloads of equal length). */
export function countChangedBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let c = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) c++;
  return c;
}

/** All check names `selfCheckGrown` can return (except the optional `decoded_equals_intended`). */
export const SELF_CHECK_GROWN_NAMES = [
  ...UPDATER_CHECKS.map((k) => `updater_${k}`),
  'completed',
  'file_length_multiple_of_4',
  'header_identical',
  'model_records_identical',
  'footer_consistent',
  'terminator_present',
  'sections_grown_by_whole_frames',
  'decoded_last_word_identical',
  'frame_layout_regular',
  'frames_official_or_stored_full',
  'first_frame_identical',
  'last_frame_identical',
  'changes_inside_planned_ranges',
] as const;

/** Sections that may be longer than in the official file. */
const GROWABLE = ['RTOS', 'ICONBIN'];
const FRAME = 0x6000;

/**
 * The counterpart of `selfCheck` for a file whose RTOS and ICONBIN sections are longer than the
 * official ones (added aspect ratios). `ranges` are offsets in the NEW payload and must cover the
 * appended parts and the two changed section-size fields as well as every edit inside the
 * official parts. Like `selfCheck` it only takes the two files, re-derives everything else and
 * never throws.
 *
 * What it establishes: the updater's own checks pass; header, model records and footer are the
 * official ones apart from the two lengths; only RTOS and ICONBIN grew, each by whole frames;
 * every byte that existed in the official payload is unchanged outside the planned ranges; and
 * the stream consists solely of official frames at their (shifted) places and of full-length
 * stored frames, with the first and last frame untouched.
 */
export function selfCheckGrown(officialRaw: Uint8Array, newRaw: Uint8Array, ranges: readonly Range[], intendedDecoded?: Uint8Array): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  for (const k of SELF_CHECK_GROWN_NAMES) checks[k] = false;
  if (intendedDecoded !== undefined) checks.decoded_equals_intended = false;
  try {
    runGrown(checks, officialRaw, newRaw, ranges, intendedDecoded);
    checks.completed = true;
  } catch {
    checks.completed = false;
  }
  return checks;
}

function runGrown(checks: Record<string, boolean>, officialRaw: Uint8Array, newRaw: Uint8Array, ranges: readonly Range[], intendedDecoded?: Uint8Array): void {
  const v = verifyContainer(newRaw, intendedDecoded);
  for (const k of UPDATER_CHECKS) checks[`updater_${k}`] = v.checks[k] === true;
  if (intendedDecoded !== undefined) checks.decoded_equals_intended = v.checks.decoded_equals_expected === true;
  const dec = v.decoded;
  const fn = v.frames;
  const endN = v.streamEnd;

  const off = parseFrames(officialRaw, u32(officialRaw, officialRaw.length - FOOTER_LEN + 16));
  const deco = off.decoded;
  const fo = off.frames;
  const endO = off.streamEnd;

  checks.file_length_multiple_of_4 = newRaw.length % 4 === 0;
  checks.header_identical = equalRange(newRaw, 0, officialRaw, 0, HDR);

  const padO = (4 - (endO % 4)) % 4;
  const padN = (4 - (endN % 4)) % 4;
  const mO = officialRaw.subarray(Math.min(endO + padO, officialRaw.length), Math.max(Math.min(endO + padO, officialRaw.length), officialRaw.length - FOOTER_LEN));
  const mN = newRaw.subarray(Math.min(endN + padN, newRaw.length), Math.max(Math.min(endN + padN, newRaw.length), newRaw.length - FOOTER_LEN));
  let padZero = true;
  for (let i = endN; i < endN + padN && i < newRaw.length; i++) if (newRaw[i] !== 0) padZero = false;
  checks.model_records_identical = padZero && mO.length === mN.length && mN.length > 0 && equalRange(mO, 0, mN, 0, mO.length);
  checks.terminator_present = endN >= HDR + 2 && newRaw[endN - 2] === 0 && newRaw[endN - 1] === 0;

  // Sections: same list; only RTOS and ICONBIN longer, by whole frames. From that, the map from
  // official payload offsets to new ones: `shiftAt[k]` applies from official offset `cut[k]` on.
  const so = sectionsOf(deco);
  const sn = sectionsOf(dec);
  let layout = so.length === sn.length && so.length > 0;
  const cut: number[] = [];
  const shiftAt: number[] = [];
  let shift = 0;
  if (layout) {
    for (let i = 0; i < so.length; i++) {
      const a = so[i];
      const b = sn[i];
      if (a.name !== b.name || a.v1 !== b.v1 || a.v2 !== b.v2 || b.offset !== a.offset + shift) layout = false;
      if (a.name === 'RES') {
        if (a.size !== b.size) layout = false;
        continue;
      }
      const grown = b.size - a.size;
      if (grown !== 0) {
        if (!GROWABLE.includes(a.name) || grown < 0 || grown % FRAME !== 0) layout = false;
        shift += grown;
        cut.push(a.offset + a.size);
        shiftAt.push(shift);
      }
    }
  }
  if (dec.length !== deco.length + shift || shift === 0) layout = false;
  checks.sections_grown_by_whole_frames = layout;
  if (!layout) return;

  const tO = officialRaw.length - FOOTER_LEN;
  const tN = newRaw.length - FOOTER_LEN;
  checks.footer_consistent =
    u32(officialRaw, tO) === u32(newRaw, tN) &&
    u32(officialRaw, tO + 4) === u32(newRaw, tN + 4) &&
    u32(officialRaw, tO + 8) === u32(newRaw, tN + 8) &&
    u32(newRaw, tN + 16) === u32(officialRaw, tO + 16) + shift &&
    u32(newRaw, tN + 12) === endN - HDR;
  checks.decoded_last_word_identical = dec.length >= 4 && equalRange(dec, dec.length - 4, deco, deco.length - 4, 4);
  const mapOffset = (x: number): number => {
    let s = 0;
    for (let k = 0; k < cut.length; k++) if (x >= cut[k]) s = shiftAt[k];
    return x + s;
  };

  // Frames: contiguous, first as official, last as official, everything between FRAME bytes long.
  let regular = fn.length === fo.length + shift / FRAME && fo.length > 1;
  let pos = 0;
  for (let i = 0; i < fn.length && regular; i++) {
    const f = fn[i];
    const want = i === 0 ? fo[0].outLen : i === fn.length - 1 ? fo[fo.length - 1].outLen : FRAME;
    if (f.outStart !== pos || f.outLen !== want) regular = false;
    pos += f.outLen;
  }
  checks.frame_layout_regular = regular && pos === dec.length;
  // Each frame is the next official frame, at its shifted place, or a full stored frame.
  let form = regular;
  let oi = 0;
  for (let i = 0; i < fn.length && form; i++) {
    const b = fn[i];
    while (oi < fo.length && mapOffset(fo[oi].outStart) < b.outStart) oi++;
    if (oi < fo.length && mapOffset(fo[oi].outStart) === b.outStart && frameBytesEqual(officialRaw, fo[oi], newRaw, b)) {
      oi++;
      continue;
    }
    const ok =
      b.stored && b.outLen === FRAME && b.end - b.start === 2 + FRAME && newRaw[b.start] === 0xe0 && newRaw[b.start + 1] === 0x00 &&
      equalRange(newRaw, b.start + 2, dec, b.outStart, FRAME);
    if (!ok) form = false;
  }
  checks.frames_official_or_stored_full = form;
  checks.first_frame_identical = fn.length > 0 && frameBytesEqual(officialRaw, fo[0], newRaw, fn[0]);
  checks.last_frame_identical = fn.length > 0 && frameBytesEqual(officialRaw, fo[fo.length - 1], newRaw, fn[fn.length - 1]);

  // Every byte of the official payload, at its new place, is unchanged outside the planned ranges;
  // the inserted blocks must be covered by ranges entirely.
  let rangesOk = true;
  for (const r of ranges) {
    if (!(Number.isInteger(r.offset) && Number.isInteger(r.length) && r.offset >= 0 && r.length >= 0 && r.offset + r.length <= dec.length)) rangesOk = false;
  }
  let inside = rangesOk;
  if (inside) {
    const sorted = [...ranges].sort((x, y) => x.offset - y.offset);
    let ri = 0;
    let coverEnd = -1;
    const covered = (i: number): boolean => {
      while (ri < sorted.length && sorted[ri].offset <= i) {
        const end = sorted[ri].offset + sorted[ri].length;
        if (end > coverEnd) coverEnd = end;
        ri++;
      }
      return i < coverEnd;
    };
    // Walk the new payload in order: official stretches are compared, inserted stretches must be planned.
    let o = 0; // official offset
    let n = 0; // new offset
    for (let k = 0; k <= cut.length && inside; k++) {
      const stop = k < cut.length ? cut[k] : deco.length;
      for (; o < stop; o++, n++) {
        if (dec[n] !== deco[o] && !covered(n)) {
          inside = false;
          break;
        }
      }
      if (k < cut.length && inside) {
        const insEnd = cut[k] + shiftAt[k];
        for (; n < insEnd; n++) {
          if (!covered(n)) {
            inside = false;
            break;
          }
        }
      }
    }
    if (inside && n !== dec.length) inside = false;
  }
  checks.changes_inside_planned_ranges = inside;
}
