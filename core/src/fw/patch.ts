/**
 * The builder: official firmware 1.11 + slot edits -> new firmware file.
 *
 * Port of `build.py` (variants A and B: colour data + checksum compensation word) and
 * `build_c.py` (variant C: icon replacement + transparent-pixel compensation), generalised to
 * names and to single-icon edits. The ORDER of operations below is what makes the output
 * byte-identical to the Python-built files that were installed on a camera; do not reorder.
 */
import { build, buildGrown, sectionData, sectionsOf, sha256Hex, sum32 } from './container';
import type { Firmware } from './container';
import { FirmwareError } from './types';
import type { Range } from './types';
import { COMP_OFFSET, ICONBIN_LENGTH, ICONBIN_OFFSET, ICON_BYTES, LEN, RTOS_LENGTH, RTOS_OFFSET, SLOTS, foff, openOfficial, resolveLayout, slotDef } from './profile';
import type { SlotId, SlotInfo } from './profile';
import { LANGS, applyName, nameRanges, validateName } from './names';
import type { LangCode } from './names';
import { normalizeIcon, readIcon } from './icons';
import { countChangedBytes, selfCheck, selfCheckGrown } from './selfcheck';
import { gr4Sizes, installRatios, planRatios, ratioText } from './aspect';
import type { RatioSpec } from './aspect';
import { grownRanges, growPayload } from './aspect/package';
import { CLARITY_BYTES, CLARITY_OFFSET, clarityBytes, hasOfficialClarity } from './clarity';
import type { ClarityEdit } from './clarity';

export type { Range } from './types';

export interface ColorData {
  /** 9 int16, row-major 3x3, Q13 (8192 = 1.0); each row must sum to exactly 8192. */
  matrixQ13: ArrayLike<number>;
  /** R, G, B tone curves: 256 uint16 each, non-decreasing, 0..16383. Absent = write only the matrix. */
  curves?: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
}

export interface SlotEdit {
  slot: 'CY' | 'CG';
  color?: ColorData;
  /** 6400 bytes, 40x40 RGBA. */
  icon?: Uint8Array;
  names?: Partial<Record<LangCode, string>>;
}

export interface BuildResult {
  file: Uint8Array;
  sha256: string;
  decoded: Uint8Array;
  decodedSha256: string;
  /** Indices of the container frames that differ from the official file. */
  changedFrames: number[];
  /** Number of decoded bytes that differ from the official payload. */
  changedBytes: number;
  /** Every planned edit (decoded offsets). All changed bytes lie inside these. */
  ranges: Range[];
  /** The self-check results; all true (otherwise `buildFirmware` throws). */
  checks: Record<string, boolean>;
  /** The aspect ratios that were added, in menu order (empty when none). */
  ratios: BuiltRatio[];
}

/** One added aspect ratio as it will behave in the camera. */
export interface BuiltRatio {
  /** Identity stored in the camera's settings and in each photo. */
  id: number;
  name: string;
  /** As requested. */
  ratio: string;
  /** What the pixel grid makes of it, reduced: e.g. `30:11` for a requested 65:24. */
  actual: string;
  /** JPEG sizes L, M, S, XS on a GR IV without crop. */
  sizes: [number, number][];
}

const SLOT_ORDER: readonly SlotId[] = SLOTS.map((s) => s.id);

function bad(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

function matrixBytes(slot: SlotId, m: ArrayLike<number>): Uint8Array {
  if (!m || m.length !== 9) bad('bad-color', `${slot}: the matrix must have 9 values`);
  const out = new Uint8Array(LEN.matrix);
  for (let r = 0; r < 3; r++) {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const v = m[r * 3 + c];
      if (!Number.isInteger(v) || v < -32768 || v > 32767) bad('bad-color', `${slot}: matrix value ${String(v)} is not an int16`);
      sum += v;
      const u = v & 0xffff;
      out[(r * 3 + c) * 2] = u & 0xff;
      out[(r * 3 + c) * 2 + 1] = u >>> 8;
    }
    if (sum !== 8192) bad('bad-color', `${slot}: matrix row ${r} sums to ${sum}, must be 8192`);
  }
  return out;
}

function curveBytes(slot: SlotId, ch: string, c: ArrayLike<number>): Uint8Array {
  if (!c || c.length !== 256) bad('bad-color', `${slot}: curve ${ch} must have 256 values`);
  const out = new Uint8Array(512);
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const v = c[i];
    if (!Number.isInteger(v) || v < 0 || v > 16383) bad('bad-color', `${slot}: curve ${ch}[${i}] = ${String(v)} is not an integer in 0..16383`);
    if (v < prev) bad('bad-color', `${slot}: curve ${ch} decreases at ${i}`);
    prev = v;
    out[2 * i] = v & 0xff;
    out[2 * i + 1] = v >>> 8;
  }
  return out;
}

function sortEdits(edits: readonly SlotEdit[]): SlotEdit[] {
  if (!Array.isArray(edits)) bad('bad-edit', 'edits must be an array');
  const seen = new Set<string>();
  for (const e of edits) {
    if (!e || !SLOT_ORDER.includes(e.slot)) bad('bad-edit', `unknown slot ${String(e && e.slot)}`);
    if (seen.has(e.slot)) bad('bad-edit', `slot ${e.slot} is edited twice`);
    seen.add(e.slot);
  }
  return [...edits].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
}

function transparentPixels(icon: Uint8Array): number[] {
  const px: number[] = [];
  for (let p = 0; p < ICON_BYTES / 4; p++) if (icon[p * 4 + 3] === 0) px.push(p); // row-major: y then x
  return px;
}

/**
 * Build a firmware file from the official 1.11 file and a list of slot edits.
 * Throws `FirmwareError` on any invalid input or failed assertion; never returns a file that did
 * not pass the self-check.
 */
export async function buildFirmware(officialRaw: Uint8Array, edits: SlotEdit[], ratios: readonly RatioSpec[] = [], clarity: readonly ClarityEdit[] = []): Promise<BuildResult> {
  const { fw, DEC, img, ranges } = await editPayload(officialRaw, edits, clarity);
  if (ratios.length > 0) return buildWithRatios(officialRaw, fw, DEC, img, ranges, ratios);

  // 7. Container.
  const built = build(fw, img);

  // 8. Independent self-check.
  const checks = selfCheck(officialRaw, built.out, ranges, img);
  const failed = Object.keys(checks).filter((k) => checks[k] !== true);
  if (failed.length > 0) throw new FirmwareError('selfcheck-failed', failed.join(', '), checks);

  return {
    file: built.out,
    sha256: await sha256Hex(built.out),
    decoded: img,
    decodedSha256: await sha256Hex(img),
    changedFrames: built.reencoded,
    changedBytes: countChangedBytes(DEC, img),
    ranges,
    checks,
    ratios: [],
  };
}

/**
 * The same, plus added aspect ratios: the RTOS and ICONBIN sections grow (see `aspect/`), so the
 * container is rebuilt with `buildGrown` and checked with `selfCheckGrown`.
 */
async function buildWithRatios(officialRaw: Uint8Array, fw: Firmware, DEC: Uint8Array, img: Uint8Array, ranges: Range[], ratios: readonly RatioSpec[]): Promise<BuildResult> {
  const specs = ratios.map((r) => ({ name: r.name, ratio: r.ratio.trim() }));
  const plan = planRatios(specs);
  const aspect = installRatios(img.slice(RTOS_OFFSET, RTOS_OFFSET + RTOS_LENGTH), img.slice(ICONBIN_OFFSET, ICONBIN_OFFSET + ICONBIN_LENGTH), plan);
  const grown = growPayload(img, aspect, specs);
  // Edits made before growing keep their place in RTOS; those in ICONBIN move with it.
  const all: Range[] = ranges.map((r) => (r.offset >= ICONBIN_OFFSET ? { ...r, offset: r.offset + grown.rtosGrowth } : r));
  const added = grownRanges(grown, aspect);
  const hooks = added.filter((r) => r.length === 4 && r.what.startsWith('ratio hook'));
  for (const h of hooks) {
    for (const r of ranges) {
      if (r.offset < h.offset + h.length && h.offset < r.offset + r.length) bad('assert-failed', `${h.what} overlaps ${r.what}`);
    }
  }
  all.push(...added);
  if (sum32(grown.decoded) !== 0) bad('assert-failed', 'payload word sum is not zero');
  for (let i = 1; i <= 4; i++) {
    if (grown.decoded[grown.decoded.length - i] !== DEC[DEC.length - i]) bad('assert-failed', 'last payload word changed');
  }

  const built = buildGrown(fw, grown.decoded, grown.insertions);
  const checks = selfCheckGrown(officialRaw, built.out, all, grown.decoded);
  const failed = Object.keys(checks).filter((k) => checks[k] !== true);
  if (failed.length > 0) throw new FirmwareError('selfcheck-failed', failed.join(', '), checks);

  let hookBytes = 0;
  for (const h of hooks) for (let i = 0; i < 4; i++) if (grown.decoded[h.offset + i] !== img[h.offset + i]) hookBytes++;
  return {
    file: built.out,
    sha256: await sha256Hex(built.out),
    decoded: grown.decoded,
    decodedSha256: await sha256Hex(grown.decoded),
    changedFrames: built.reencoded,
    changedBytes: countChangedBytes(DEC, img) + hookBytes + grown.rtosGrowth + grown.iconGrowth + 8,
    ranges: all,
    checks,
    ratios: plan.map((r) => ({ id: r.id, name: r.name, ratio: r.ratio, actual: ratioText(r.geometry.actual.n, r.geometry.actual.d), sizes: gr4Sizes(r.geometry) })),
  };
}

/** Steps 1-6: open the official file and apply the same-length slot (and clarity) edits to a copy of its payload. */
async function editPayload(officialRaw: Uint8Array, edits: SlotEdit[], clarity: readonly ClarityEdit[] = []): Promise<{ fw: Firmware; DEC: Uint8Array; img: Uint8Array; ranges: Range[] }> {
  // 1. Open the official file, copy the payload.
  const { fw, decoded: DEC } = await openOfficial(officialRaw);
  const sorted = sortEdits(edits);
  const layout = resolveLayout(DEC);
  const img = DEC.slice();
  const ranges: Range[] = [];
  const write = (what: string, offset: number, bytes: Uint8Array, expectLen: number): void => {
    if (bytes.length !== expectLen) bad('internal', `${what}: wrong length`);
    img.set(bytes, offset);
    ranges.push({ what, offset, length: bytes.length });
  };
  let rtosTouched = false;

  // 2. Colour data, CY then CG.
  for (const e of sorted) {
    if (!e.color) continue;
    const s: SlotInfo = layout[e.slot];
    const mb = matrixBytes(e.slot, e.color.matrixQ13);
    let curves: Uint8Array[] | null = null;
    if (e.color.curves !== undefined) {
      const cv = e.color.curves;
      if (!cv || cv.length !== 3) bad('bad-color', `${e.slot}: curves must be [R, G, B]`);
      curves = [curveBytes(e.slot, 'R', cv[0]), curveBytes(e.slot, 'G', cv[1]), curveBytes(e.slot, 'B', cv[2])];
    }
    write(`${e.slot} matrix`, foff(s.matrix), mb, LEN.matrix);
    rtosTouched = true;
    if (curves) {
      const dOff = foff(s.desc);
      const d = DEC.slice(dOff, dOff + LEN.desc);
      if (!(d[4] === 1 && d[5] === 1)) bad('unexpected-layout', `${e.slot}: gamma descriptor flags are not 01 01`);
      d[5] = 0;
      write(`${e.slot} gamma descriptor`, dOff, d, LEN.desc);
      write(`${e.slot} curve R`, foff(s.R), curves[0], LEN.R);
      write(`${e.slot} curve G`, foff(s.G), curves[1], LEN.G);
      write(`${e.slot} curve B`, foff(s.B), curves[2], LEN.B);
      const stdMa = foff(layout.standard.maBlock);
      write(`${e.slot} multi-axis block (copy of Standard)`, foff(s.maBlock), DEC.slice(stdMa, stdMa + LEN.ma_block), LEN.ma_block);
    }
  }

  // 3. Names.
  for (const e of sorted) {
    if (!e.names) continue;
    for (const k of Object.keys(e.names)) {
      if (!(LANGS as readonly string[]).includes(k)) bad('bad-language', `${e.slot}: unknown language ${k}`);
    }
    const def = slotDef(e.slot);
    for (const lang of LANGS) {
      const text = e.names[lang];
      if (text === undefined) continue;
      const v = validateName(DEC, lang, def.nameIndex, text);
      if (!v.ok) {
        const extra = v.badChars ? ` (${v.badChars.join(' ')})` : '';
        bad('bad-name', `${e.slot} name ${lang}: ${v.reason}${extra}, capacity ${v.capacity}`);
      }
      const r = applyName(img, lang, def.nameIndex, text, DEC);
      ranges.push({ what: `${e.slot} name ${lang} text`, offset: r[0].offset, length: r[0].length });
      ranges.push({ what: `${e.slot} name ${lang} length`, offset: r[1].offset, length: r[1].length });
      rtosTouched = true;
    }
  }

  // 3b. Clarity table (soft focus): rows of the negative settings replaced, same length.
  if (!Array.isArray(clarity)) bad('bad-clarity', 'clarity edits must be an array');
  if (clarity.length > 0) {
    if (!hasOfficialClarity(DEC)) bad('unexpected-layout', 'the clarity table is not where it is expected');
    write('clarity table', CLARITY_OFFSET, clarityBytes(clarity), CLARITY_BYTES);
    rtosTouched = true;
  }

  // 4. Keep the payload's word sum at zero WITHOUT touching its last word: absorb the difference
  //    in the compensation word (exactly build.py).
  if (rtosTouched) {
    const delta = sum32(img);
    const old = (img[COMP_OFFSET] | (img[COMP_OFFSET + 1] << 8) | (img[COMP_OFFSET + 2] << 16) | (img[COMP_OFFSET + 3] << 24)) >>> 0;
    const word = (old - delta) >>> 0;
    img[COMP_OFFSET] = word & 0xff;
    img[COMP_OFFSET + 1] = (word >>> 8) & 0xff;
    img[COMP_OFFSET + 2] = (word >>> 16) & 0xff;
    img[COMP_OFFSET + 3] = word >>> 24;
    ranges.push({ what: 'checksum compensation word', offset: COMP_OFFSET, length: 4 });
  }
  // Everything so far is inside the RTOS section; the icons below are inside ICONBIN.
  for (const r of ranges) {
    if (!(r.offset >= RTOS_OFFSET && r.offset + r.length <= RTOS_OFFSET + RTOS_LENGTH)) bad('assert-failed', `${r.what} is outside RTOS`);
  }

  // 5. Icons, with the transparent-pixel compensation of build_c.py: the icon data's word sum is
  //    kept by lowering the (invisible) colour of fully transparent pixels a little.
  const iconEdits = sorted.filter((e) => e.icon !== undefined);
  if (iconEdits.length > 0) {
    const official = {} as Record<SlotId, Uint8Array>;
    for (const s of SLOTS) official[s.id] = readIcon(DEC, s.iconOffset);
    const fresh = {} as Record<SlotId, Uint8Array>; // normalised, transparent pixels still FF FF FF 00
    const replaced = new Set<SlotId>();
    for (const e of iconEdits) {
      fresh[e.slot] = normalizeIcon(official[e.slot], e.icon as Uint8Array);
      replaced.add(e.slot);
    }
    const plan = (pool: SlotId[]) => {
      let oldWords = 0;
      let newWords = 0;
      let n = 0;
      for (const id of pool) {
        oldWords = (oldWords + sum32(official[id])) >>> 0;
        newWords = (newWords + sum32(fresh[id])) >>> 0;
        n += transparentPixels(fresh[id]).length;
      }
      const D = (newWords - oldWords) >>> 0;
      const dB = Math.floor(D / 65536);
      const r = D % 65536;
      const dG = Math.floor(r / 256);
      const dR = r % 256;
      return { n, dB, dG, dR, fits: n > 0 && dB <= 255 * n && dG <= 255 * n && dR <= 255 * n };
    };
    let pool = SLOT_ORDER.filter((id) => replaced.has(id));
    let p = plan(pool);
    if (!p.fits && pool.length < SLOT_ORDER.length) {
      // Pool too small: also use the transparent pixels of the other Cinema icon (its opaque
      // pixels stay exactly as official), pool order still CY then CG.
      for (const id of SLOT_ORDER) if (!replaced.has(id)) fresh[id] = normalizeIcon(official[id], official[id]);
      pool = [...SLOT_ORDER];
      p = plan(pool);
    }
    if (!p.fits) bad('icon-pool-too-small', 'cannot compensate the icon checksum with the transparent pixels');
    const per = Math.floor(p.dB / p.n);
    const extra = p.dB % p.n;
    const perG = Math.floor(p.dG / p.n);
    const extraG = p.dG % p.n;
    const perR = Math.floor(p.dR / p.n);
    const extraR = p.dR % p.n;
    let k = 0;
    for (const id of pool) {
      const icon = fresh[id];
      for (const px of transparentPixels(icon)) {
        icon[px * 4 + 2] = 255 - per - (k < extra ? 1 : 0);
        icon[px * 4 + 1] = 255 - perG - (k < extraG ? 1 : 0);
        icon[px * 4] = 255 - perR - (k < extraR ? 1 : 0);
        k++;
      }
    }
    for (const id of pool) {
      const def = slotDef(id);
      const what = replaced.has(id) ? `${id} icon` : `${id} icon (transparent pixels only, checksum compensation)`;
      if (!(def.iconOffset >= ICONBIN_OFFSET && def.iconOffset + ICON_BYTES <= ICONBIN_OFFSET + ICONBIN_LENGTH)) bad('assert-failed', 'icon is outside ICONBIN');
      write(what, def.iconOffset, fresh[id], ICON_BYTES);
    }
  }

  // 6. Assertions on the final payload.
  const byOffset = [...ranges].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byOffset.length; i++) {
    if (byOffset[i].offset < byOffset[i - 1].offset + byOffset[i - 1].length) bad('assert-failed', `${byOffset[i - 1].what} overlaps ${byOffset[i].what}`);
  }
  if (img.length !== DEC.length) bad('assert-failed', 'payload length changed');
  if (sum32(img) !== 0) bad('assert-failed', 'payload word sum is not zero');
  for (let i = 1; i <= 4; i++) {
    if (img[img.length - i] !== DEC[DEC.length - i]) bad('assert-failed', 'last payload word changed');
  }
  const so = sectionsOf(DEC);
  const sn = sectionsOf(img);
  if (so.length !== sn.length) bad('assert-failed', 'section list changed');
  for (let i = 0; i < so.length; i++) {
    if (so[i].name !== sn[i].name || so[i].offset !== sn[i].offset || so[i].size !== sn[i].size) bad('assert-failed', `section ${so[i].name} moved`);
    if (sum32(sectionData(DEC, so[i])) !== sum32(sectionData(img, sn[i]))) bad('assert-failed', `section ${so[i].name} word sum changed`);
  }

  return { fw, DEC, img, ranges };
}

/**
 * Every part of the decoded payload that `buildFirmware` can ever change: both slots' colour data,
 * names in all languages and icons, the clarity table, plus the checksum compensation word. A file that differs
 * from the official one only inside these ranges (and passes the self-check with them) is one
 * this builder could have produced.
 */
export function editableRanges(official: Uint8Array): Range[] {
  const layout = resolveLayout(official);
  const out: Range[] = [];
  for (const s of SLOTS) {
    const li = layout[s.id];
    out.push({ what: `${s.id} matrix`, offset: foff(li.matrix), length: LEN.matrix });
    out.push({ what: `${s.id} gamma descriptor`, offset: foff(li.desc), length: LEN.desc });
    out.push({ what: `${s.id} curve R`, offset: foff(li.R), length: LEN.R });
    out.push({ what: `${s.id} curve G`, offset: foff(li.G), length: LEN.G });
    out.push({ what: `${s.id} curve B`, offset: foff(li.B), length: LEN.B });
    out.push({ what: `${s.id} multi-axis block`, offset: foff(li.maBlock), length: LEN.ma_block });
    for (const lang of LANGS) out.push(...nameRanges(official, lang, s.nameIndex));
    out.push({ what: `${s.id} icon`, offset: s.iconOffset, length: ICON_BYTES });
  }
  out.push({ what: 'clarity table', offset: CLARITY_OFFSET, length: CLARITY_BYTES });
  out.push({ what: 'checksum compensation word', offset: COMP_OFFSET, length: 4 });
  return out;
}
