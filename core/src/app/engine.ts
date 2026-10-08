/**
 * One object that the UI (through a worker) talks to: it holds the user's official firmware file
 * and offers everything the app does with it. Pure TypeScript, no platform APIs.
 */
import {
  CONTENT_AREA,
  DECODED_SIZE,
  FIRMWARE_VERSION,
  FRAME_SIZE,
  Firmware,
  FirmwareError,
  ICONBIN_LENGTH,
  ICONBIN_OFFSET,
  LANGS,
  LEN,
  MAX_CUSTOM_RATIOS,
  RTOS_LENGTH,
  RTOS_OFFSET,
  SLOTS,
  allowedChars,
  aspect,
  buildFirmware,
  countChangedBytes,
  editableRanges,
  equalRange,
  foff,
  gr4Sizes,
  listResources,
  openOfficial,
  planRatio,
  planRatios,
  ratioText,
  readIcon,
  readFactoryEntry,
  readName,
  readBuildRevision,
  readExtensionFeatures,
  readRatioRecord,
  resolveLayout,
  sectionsOf,
  selfCheck,
  selfCheckGrown,
  sha256Hex,
  tileTemplate,
  validateName,
  validateRatioName,
  SOFT_FOCUS_GAINS,
  SOFT_FOCUS_LEVELS,
  SOFT_FOCUS_STRENGTHS,
  clarityChanges,
} from '../fw';
import type { BuildResult, BuiltRatio, ClarityChange, ClarityEdit, SoftFocusLevel, SoftFocusStrength, FactoryEntry, LangCode, Layout, NameValidation, Range, RatioSpec, SlotEdit, SlotId } from '../fw';
import { grownRanges, growPayload } from '../fw/aspect/package';
import { convertCube, convertXmp, quantizeSlot } from '../color';
import type { SlotParams } from '../color';
import { JpegError, checkShutdownJpeg, decodeBaselineJpeg, encodeExactJpeg, inspectJpeg } from '../jpeg';
import type { Sampling } from '../jpeg';
import { MODEL_INFO, rotationScript } from '../wallpaper';
import type { CameraModel } from '../wallpaper';

export const SHUTDOWN_W = 720;
export const SHUTDOWN_H = 480;

export interface SlotInfoView {
  id: SlotId;
  defaultName: string;
  /** Official icon, 40x40 RGBA. */
  icon: Uint8Array;
  names: Record<LangCode, { text: string; capacity: number }>;
}

export interface ShutdownResource {
  size: number;
  sampling: Sampling;
  /** The factory image itself (for "restore"). */
  data: Uint8Array;
}

export interface FirmwareInfo {
  version: string;
  sha256: string;
  slots: SlotInfoView[];
  tiles: { film: Uint8Array; plain: Uint8Array };
  contentArea: typeof CONTENT_AREA;
  /** Characters usable in names, per language. */
  allowed: Record<LangCode, string>;
  shutdown: Partial<Record<CameraModel, ShutdownResource>>;
  /** Card files that open the camera's factory menu, as found in this firmware. */
  factoryEntry: FactoryEntry;
}

export interface PresetResult {
  kind: 'xmp' | 'cube';
  title: string;
  meanDE: number;
  p95DE: number;
  warnings: string[];
  unsupported: string[];
  params: SlotParams;
  matrixQ13: Int16Array;
  curves: [Uint16Array, Uint16Array, Uint16Array];
}

export interface SlotRequest {
  slot: SlotId;
  preset?: { matrixQ13: ArrayLike<number>; curves: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] };
  icon?: Uint8Array;
  names?: Partial<Record<LangCode, string>>;
}

/** Soft focus on one negative clarity setting: its row of the clarity table gets the gains of `strength`. */
export interface SoftFocusRequest {
  level: SoftFocusLevel;
  strength: SoftFocusStrength;
}

export type FirmwareBuild = Omit<BuildResult, 'decoded'>;

/** What adding a ratio would give, for the UI; `problem` is set (and the rest absent) when it cannot be added. */
export interface RatioPreview {
  problem?: 'bad-ratio' | 'ratio-factory' | 'ratio-too-extreme' | 'ratio-quick-view' | 'ratio-metering' | 'ratio-conflict' | 'ratio-duplicate';
  /** The ratio the pixel grid really gives, reduced (e.g. `30:11` for 65:24). */
  actual?: string;
  /** Relative difference between the actual and the requested ratio, in percent. */
  errorPercent?: number;
  /** Crop of the 720x480 screen image: also the shape of the live-view frame. */
  screen?: { left: number; top: number; width: number; height: number };
  /** JPEG sizes L, M, S, XS on a GR IV without crop. */
  sizes?: [number, number][];
  /** 60x40 RGBA menu icon. */
  icon?: Uint8Array;
  /** The ratio as written on the icon; also the default menu name. */
  label?: string;
  /** With `ratio-quick-view`: the closest ratios that do work, wider first (at most two). */
  nearest?: string[];
}

/** What a firmware file found on a card (or in a backup) is, compared with the official one. */
export interface FirmwareSummary {
  sha256: string;
  /** `official`: the unmodified file; `modified`: a valid 1.11 container with changes; `unknown`: anything else. */
  kind: 'official' | 'modified' | 'unknown';
  /** Bytes of the decoded payload that differ from the official one. */
  changedBytes: number;
  /**
   * True for the official file, and for a modified file that passes the complete self-check
   * against it with every difference inside the parts this program edits. Only such a file is
   * offered for writing back to a card.
   */
  verified: boolean;
  slots: {
    id: SlotId;
    names: Record<LangCode, string>;
    /** 40x40 RGBA. */
    icon: Uint8Array;
    colorChanged: boolean;
    nameChanged: boolean;
    iconChanged: boolean;
  }[];
  /** Aspect ratios this file adds to the camera (empty when none, or when they cannot be read). */
  ratios: BuiltRatio[];
  /** Clarity settings whose row of the clarity table differs from the official one (soft focus of GR Mod 0.4.x). */
  softFocus: ClarityChange[];
  /** True when the file adds soft focus to the ADJ lever (GR Mod 0.5 and later). */
  adjSoftFocus: boolean;
}

/** Additions besides the slots and the ratios. */
export interface BuildOptions {
  /** Put soft focus (off / weak / medium / strong) on the ADJ lever. */
  adjSoftFocus?: boolean;
  /** Date imprint on the JPEG, switched in the camera's menu. */
  dateStamp?: boolean;
  /** The six black-and-white looks of the GR IV Monochrome. */
  monoUnlock?: boolean;
  /** Test builds only: a fixed setting byte (1 short, 3 long style) instead of the camera menu. */
  dateStampFixed?: number;
  /** Test builds only: print the encoder configuration on the 720x480 picture. */
  dateStampDiag?: boolean;
}

export interface ShutdownImage {
  data: Uint8Array;
  /** Starting JPEG quality the encoder ended up at (low values mean visible loss). */
  quality: number;
  /** Amplitude of the fine grain that had to be added to a too-plain image (0 = none). */
  grain: number;
  /** Blur radius that had to be applied to a too-detailed image (0 = none). */
  soften: number;
  /** What the camera will decode: SHUTDOWN_W x SHUTDOWN_H RGB. */
  preview: Uint8Array;
}

function samplingOf(data: Uint8Array): Sampling {
  const info = inspectJpeg(data);
  const y = info.components[0];
  if (y && y.h === 2 && y.v === 1) return '422';
  if (y && y.h === 2 && y.v === 2) return '420';
  throw new FirmwareError('unexpected-layout', 'unexpected power-off image sampling');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withGrain(rgb: Uint8Array, amp: number): Uint8Array {
  const out = new Uint8Array(rgb.length);
  const rnd = mulberry32(0x9e3779b9 ^ amp);
  for (let i = 0; i < rgb.length; i += 3) {
    const n = Math.round((rnd() * 2 - 1) * amp); // same offset on the three channels: luminance grain
    for (let c = 0; c < 3; c++) {
      const v = rgb[i + c] + n;
      out[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

function boxBlur(rgb: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const tmp = new Float32Array(rgb.length);
  const out = new Uint8Array(rgb.length);
  const win = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += rgb[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = acc / win;
        acc += rgb[(y * w + Math.min(w - 1, x + radius + 1)) * 3 + c] - rgb[(y * w + Math.max(0, x - radius)) * 3 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = Math.round(acc / win);
        acc += tmp[(Math.min(h - 1, y + radius + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - radius) * w + x) * 3 + c];
      }
    }
  }
  return out;
}

export class Engine {
  readonly info: FirmwareInfo;
  private readonly raw: Uint8Array;
  private readonly decoded: Uint8Array;
  private readonly mStdQ13: Int16Array;
  private readonly layout: Layout;
  private editable: Range[] | null = null;

  private constructor(raw: Uint8Array, decoded: Uint8Array, info: FirmwareInfo, mStd: Int16Array, layout: Layout) {
    this.raw = raw;
    this.decoded = decoded;
    this.info = info;
    this.mStdQ13 = mStd;
    this.layout = layout;
  }

  /** Accepts only the official 1.11 file; throws `FirmwareError('unsupported-firmware')` otherwise. */
  static async open(raw: Uint8Array): Promise<Engine> {
    const { decoded } = await openOfficial(raw);
    const layout = resolveLayout(decoded);
    const mo = foff(layout.standard.matrix);
    const mStd = new Int16Array(9);
    const dv = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    for (let i = 0; i < 9; i++) mStd[i] = dv.getInt16(mo + 2 * i, true);

    const allowed = {} as Record<LangCode, string>;
    for (const lang of LANGS) {
      const set = allowedChars(decoded, lang);
      const chars: number[] = [];
      for (const u of set) if (u >= 0x20 && !(u >= 0x7f && u <= 0x9f) && !(u >= 0xd800 && u <= 0xdfff)) chars.push(u);
      chars.sort((a, b) => a - b);
      allowed[lang] = String.fromCharCode(...chars);
    }
    const slots: SlotInfoView[] = SLOTS.map((s) => {
      const names = {} as Record<LangCode, { text: string; capacity: number }>;
      for (const lang of LANGS) {
        const n = readName(decoded, lang, s.nameIndex);
        names[lang] = { text: n.text, capacity: n.capacity };
      }
      return { id: s.id, defaultName: s.defaultName, icon: readIcon(decoded, s.iconOffset), names };
    });
    const shutdown: Partial<Record<CameraModel, ShutdownResource>> = {};
    const res = listResources(decoded);
    for (const model of Object.keys(MODEL_INFO) as CameraModel[]) {
      const want = MODEL_INFO[model].target.toLowerCase();
      const r = res.find((x) => x.path.toLowerCase() === want);
      if (!r) continue;
      const data = decoded.slice(r.offset, r.offset + r.length);
      shutdown[model] = { size: r.length, sampling: samplingOf(data), data };
    }
    const info: FirmwareInfo = {
      version: FIRMWARE_VERSION,
      sha256: await sha256Hex(raw),
      slots,
      tiles: { film: tileTemplate(decoded, 'film'), plain: tileTemplate(decoded, 'plain') },
      contentArea: CONTENT_AREA,
      allowed,
      shutdown,
      factoryEntry: readFactoryEntry(decoded),
    };
    return new Engine(raw, decoded, info, mStd, layout);
  }

  /**
   * Describe a firmware file: is it the official one, a modified 1.11 file (and what its two
   * slots look like), or something else. Never throws on a damaged file.
   */
  async inspect(raw: Uint8Array): Promise<FirmwareSummary> {
    const sha256 = await sha256Hex(raw);
    const describe = (d: Uint8Array): FirmwareSummary['slots'] =>
      SLOTS.map((s) => {
        const names = {} as Record<LangCode, string>;
        let nameChanged = false;
        for (const lang of LANGS) {
          names[lang] = readName(d, lang, s.nameIndex).text;
          if (names[lang] !== readName(this.decoded, lang, s.nameIndex).text) nameChanged = true;
        }
        const li = this.layout[s.id];
        const same = (va: number, len: number): boolean => equalRange(d, foff(va), this.decoded, foff(va), len);
        const colorChanged = !(same(li.matrix, LEN.matrix) && same(li.desc, LEN.desc) && same(li.R, LEN.R) && same(li.G, LEN.G) && same(li.B, LEN.B) && same(li.maBlock, LEN.ma_block));
        const icon = readIcon(d, s.iconOffset);
        const iconChanged = !equalRange(d, s.iconOffset, this.decoded, s.iconOffset, icon.length);
        return { id: s.id, names, icon, colorChanged, nameChanged, iconChanged };
      });
    if (sha256 === this.info.sha256) return { sha256, kind: 'official', changedBytes: 0, verified: true, slots: describe(this.decoded), ratios: [], softFocus: [], adjSoftFocus: false };
    try {
      const fw = new Firmware(raw);
      if (!equalRange(fw.header, 0, this.raw, 0, fw.header.length)) throw new Error('not 1.11');
      if (!this.editable) this.editable = editableRanges(this.decoded);
      if (fw.decoded.length !== DECODED_SIZE) return this.inspectGrown(sha256, raw, fw.decoded, describe);
      const checks = selfCheck(this.raw, raw, this.editable);
      const verified = Object.values(checks).every((v) => v === true);
      return { sha256, kind: 'modified', changedBytes: countChangedBytes(fw.decoded, this.decoded), verified, slots: describe(fw.decoded), ratios: [], softFocus: clarityChanges(fw.decoded), adjSoftFocus: false };
    } catch {
      return { sha256, kind: 'unknown', changedBytes: 0, verified: false, slots: [], ratios: [], softFocus: [], adjSoftFocus: false };
    }
  }

  /**
   * A file whose payload is longer than the official one: recognised when RTOS and ICONBIN grew
   * by whole frames and the end of RTOS carries this program's record of added ratios. It is
   * `verified` when building the same ratios (on top of the same slot edits) gives exactly this
   * payload, and the file passes the self-check for grown files.
   */
  private inspectGrown(sha256: string, raw: Uint8Array, dec: Uint8Array, describe: (d: Uint8Array) => FirmwareSummary['slots']): FirmwareSummary {
    const unknown: FirmwareSummary = { sha256, kind: 'unknown', changedBytes: 0, verified: false, slots: [], ratios: [], softFocus: [], adjSoftFocus: false };
    const so = sectionsOf(this.decoded);
    const sn = sectionsOf(dec);
    if (so.length !== sn.length) return unknown;
    let rtosGrowth = 0;
    let iconGrowth = 0;
    for (let i = 0; i < so.length; i++) {
      if (so[i].name !== sn[i].name) return unknown;
      if (so[i].name === 'RES') continue;
      const grown = sn[i].size - so[i].size;
      if (so[i].name === 'RTOS') rtosGrowth = grown;
      else if (so[i].name === 'ICONBIN') iconGrowth = grown;
      else if (grown !== 0) return unknown;
    }
    if (!(rtosGrowth > 0 && iconGrowth > 0 && rtosGrowth % FRAME_SIZE === 0 && iconGrowth % FRAME_SIZE === 0 && dec.length === DECODED_SIZE + rtosGrowth + iconGrowth)) return unknown;
    // The payload with the added blocks taken out again: official layout.
    const aligned = new Uint8Array(DECODED_SIZE);
    const rtosEnd = RTOS_OFFSET + RTOS_LENGTH;
    const iconEnd = ICONBIN_OFFSET + ICONBIN_LENGTH;
    aligned.set(dec.subarray(0, rtosEnd), 0);
    aligned.set(dec.subarray(rtosEnd + rtosGrowth, iconEnd + rtosGrowth), rtosEnd);
    aligned.set(dec.subarray(iconEnd + rtosGrowth + iconGrowth), iconEnd);
    aligned.set(this.decoded.subarray(RTOS_OFFSET - 4, RTOS_OFFSET), RTOS_OFFSET - 4);
    aligned.set(this.decoded.subarray(ICONBIN_OFFSET - 4, ICONBIN_OFFSET), ICONBIN_OFFSET - 4);
    const specs = readRatioRecord(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth));
    const features = readExtensionFeatures(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth)) ?? {};
    // Files of GR Mod 0.2.x are revision 1; they are checked against what that revision builds.
    const revision = readBuildRevision(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth)) ?? 1;
    const modified = (verified: boolean, ratios: BuiltRatio[], slotsFrom: Uint8Array): FirmwareSummary => ({
      sha256, kind: 'modified', changedBytes: countChangedBytes(aligned, this.decoded) + rtosGrowth + iconGrowth, verified, slots: describe(slotsFrom), ratios, softFocus: clarityChanges(slotsFrom),
      adjSoftFocus: !!features.adjSoftFocus,
    });
    if (!specs) return modified(false, [], aligned);
    let ratios: BuiltRatio[] = [];
    try {
      const plan = planRatios(specs);
      ratios = plan.map((r) => ({ id: r.id, name: r.name, ratio: r.ratio, actual: ratioText(r.geometry.actual.n, r.geometry.actual.d), sizes: gr4Sizes(r.geometry) }));
      // Undo the hook words (their places are the same for every list of ratios of this length
      // or any other: they are found by building once on the official image).
      const probe = aspect.installExtensions(this.decoded.slice(RTOS_OFFSET, rtosEnd), this.decoded.slice(ICONBIN_OFFSET, iconEnd), plan, features, revision);
      for (const w of probe.words) {
        const o = RTOS_OFFSET + (w.address - 0x53000000);
        aligned.set(this.decoded.subarray(o, o + 4), o);
      }
      // What is left must be this program's same-length edits only...
      const editable = this.editable as Range[];
      const sorted = [...editable].sort((a, b) => a.offset - b.offset);
      let ri = 0;
      let cover = -1;
      for (let i = 0; i < DECODED_SIZE; i++) {
        if (aligned[i] === this.decoded[i]) continue;
        while (ri < sorted.length && sorted[ri].offset <= i) {
          cover = Math.max(cover, sorted[ri].offset + sorted[ri].length);
          ri++;
        }
        if (i >= cover) return modified(false, ratios, aligned);
      }
      // ... and building the ratios on top of them must give this very payload.
      const built = aspect.installExtensions(aligned.slice(RTOS_OFFSET, rtosEnd), aligned.slice(ICONBIN_OFFSET, iconEnd), plan, features, revision);
      const grown = growPayload(aligned, built, specs);
      const same = grown.decoded.length === dec.length && equalRange(grown.decoded, 0, dec, 0, dec.length);
      if (!same) return modified(false, ratios, aligned);
      const ranges: Range[] = editable.map((r) => (r.offset >= ICONBIN_OFFSET ? { ...r, offset: r.offset + grown.rtosGrowth } : r));
      ranges.push(...grownRanges(grown, built));
      const checks = selfCheckGrown(this.raw, raw, ranges, grown.decoded);
      return modified(Object.values(checks).every((v) => v === true), ratios, aligned);
    } catch {
      return modified(false, ratios, aligned);
    }
  }

  /**
   * What a ratio would become in the camera. `others` are the ratios already in the list (the
   * new one must not collide with them). Never throws.
   */
  previewRatio(ratio: string, others: readonly string[] = []): RatioPreview {
    try {
      const g = planRatio(ratio);
      for (const o of others) {
        let og;
        try {
          og = planRatio(o);
        } catch {
          continue;
        }
        if (og.screen.width === g.screen.width && og.screen.height === g.screen.height) return { problem: 'ratio-duplicate' };
      }
      const all: RatioSpec[] = [...others, ratio].map((r, i) => ({ name: `r${i}`, ratio: r }));
      try {
        if (all.length <= MAX_CUSTOM_RATIOS) planRatios(all);
      } catch (e) {
        if (e instanceof FirmwareError && e.code === 'ratio-conflict') return { problem: 'ratio-conflict' };
      }
      const requested = g.requested.toNumber();
      return {
        actual: ratioText(g.actual.n, g.actual.d),
        errorPercent: (g.actual.toNumber() / requested - 1) * 100,
        screen: { ...g.screen },
        sizes: gr4Sizes(g),
        icon: aspect.drawRatioIcon(ratio),
        label: aspect.ratioLabel(ratio),
      };
    } catch (e) {
      if (e instanceof FirmwareError) {
        const known = ['bad-ratio', 'ratio-factory', 'ratio-too-extreme', 'ratio-quick-view', 'ratio-metering', 'ratio-conflict'];
        const problem = (known.includes(e.code) ? e.code : 'bad-ratio') as RatioPreview['problem'];
        if (problem !== 'ratio-quick-view') return { problem };
        // Step the screen rectangle 4 pixels at a time in both directions until a ratio works.
        const nearest: string[] = [];
        try {
          const want = aspect.parseRatio(ratio);
          const screen = aspect.alignedCrop(aspect.SCREEN_W, aspect.SCREEN_H, want);
          if (screen) {
            const wideFrame = screen.width === aspect.SCREEN_W;
            for (const direction of [-1, 1]) {
              for (let k = 1; k <= 12; k++) {
                const w = wideFrame ? aspect.SCREEN_W : screen.width - direction * 4 * k;
                const h = wideFrame ? screen.height + direction * 4 * k : aspect.SCREEN_H;
                if (!(w >= 4 && w <= aspect.SCREEN_W && h >= 4 && h <= aspect.SCREEN_H)) break;
                const candidate = ratioText(w, h);
                if (this.previewRatio(candidate, others).problem === undefined) {
                  nearest.push(candidate);
                  break;
                }
              }
            }
          }
        } catch {
          /* no suggestion */
        }
        return { problem, nearest };
      }
      return { problem: 'bad-ratio' };
    }
  }

  /** Null when `name` can be a ratio's menu name. */
  validateRatioName(name: string): 'empty' | 'too-long' | 'bad-char' | null {
    return validateRatioName(name);
  }

  /** The official file, for "write factory firmware". */
  official(): Uint8Array {
    return this.raw;
  }

  convertPreset(kind: 'xmp' | 'cube', text: string, onProgress?: (f: number) => void): PresetResult {
    const c = kind === 'xmp' ? convertXmp(text, { onProgress }) : convertCube(text, { onProgress });
    const q = quantizeSlot(c.params, this.mStdQ13);
    return { kind: c.kind, title: c.title, meanDE: c.meanDE, p95DE: c.p95DE, warnings: c.warnings, unsupported: c.unsupported, params: c.params, matrixQ13: q.matrixQ13, curves: q.curves };
  }

  validateName(slot: SlotId, lang: LangCode, text: string): NameValidation {
    const def = SLOTS.find((s) => s.id === slot);
    if (!def) throw new FirmwareError('bad-edit', `unknown slot ${String(slot)}`);
    return validateName(this.decoded, lang, def.nameIndex, text);
  }

  /** Build a firmware file. The result has passed the built-in self-check (otherwise this throws). */
  async buildFirmware(requests: SlotRequest[], ratios: readonly RatioSpec[] = [], softFocus: readonly SoftFocusRequest[] = [], options: BuildOptions = {}): Promise<FirmwareBuild> {
    const edits: SlotEdit[] = [];
    for (const r of requests) {
      const e: SlotEdit = { slot: r.slot };
      if (r.preset) e.color = { matrixQ13: r.preset.matrixQ13, curves: r.preset.curves };
      if (r.icon) e.icon = r.icon;
      if (r.names && Object.keys(r.names).length > 0) e.names = r.names;
      if (e.color || e.icon || e.names) edits.push(e);
    }
    const clarity: ClarityEdit[] = softFocus.map((f) => {
      if (!f || !SOFT_FOCUS_LEVELS.includes(f.level)) throw new FirmwareError('bad-clarity', `soft focus cannot go on clarity ${String(f && f.level)}`);
      if (!SOFT_FOCUS_STRENGTHS.includes(f.strength)) throw new FirmwareError('bad-clarity', `unknown soft focus strength ${String(f.strength)}`);
      return { level: f.level, gains: SOFT_FOCUS_GAINS[f.strength] };
    });
    const adjSoftFocus = !!(options && options.adjSoftFocus);
    const dateStamp = !!(options && options.dateStamp);
    const monoUnlock = !!(options && options.monoUnlock);
    if (adjSoftFocus && clarity.length > 0) throw new FirmwareError('bad-clarity', 'soft focus on the ADJ lever and on the clarity table cannot be combined');
    if (dateStamp && clarity.length > 0) throw new FirmwareError('bad-clarity', 'the date imprint cannot be combined with the clarity-table soft focus of 0.4.x');
    if (edits.length === 0 && ratios.length === 0 && clarity.length === 0 && !adjSoftFocus && !dateStamp && !monoUnlock) throw new FirmwareError('bad-edit', 'nothing to change');
    const features = { adjSoftFocus, ...(dateStamp ? { dateStamp } : {}), ...(monoUnlock ? { monoUnlock } : {}) };
    const test = options && options.dateStampFixed ? { dateStampFixed: options.dateStampFixed, dateStampDiag: !!options.dateStampDiag } : {};
    const { decoded: _decoded, ...rest } = await buildFirmware(this.raw, edits, ratios, clarity, features, test);
    return rest;
  }

  /**
   * Encode a 720x480 RGB picture as a power-off image for `model`: same length, sampling and
   * structure as the factory file. A picture that is too plain to fill the file gets a little
   * grain; one that is too detailed for it is softened. Throws `JpegError('unreachable-size')` if
   * neither helps.
   */
  encodeShutdownImage(rgb: Uint8Array, model: CameraModel, onProgress?: (f: number) => void): ShutdownImage {
    const res = this.info.shutdown[model];
    if (!res) throw new FirmwareError('unexpected-layout', `no power-off image for ${model} in this firmware`);
    if (rgb.length !== SHUTDOWN_W * SHUTDOWN_H * 3) throw new JpegError('bad-input', 'picture must be 720x480 RGB');
    const base = { width: SHUTDOWN_W, height: SHUTDOWN_H, sampling: res.sampling, byteLength: res.size };
    const attempt = (pix: Uint8Array) => encodeExactJpeg(pix, { ...base, onProgress });
    const finish = (data: Uint8Array, quality: number, grain: number, soften: number): ShutdownImage => {
      const chk = checkShutdownJpeg(data, { byteLength: res.size, sampling: res.sampling });
      if (!chk.ok) throw new JpegError('corrupt', `self-check failed: ${chk.problems.join('; ')}`);
      return { data, quality, grain, soften, preview: decodeBaselineJpeg(data).rgb };
    };
    let first: JpegError | null = null;
    try {
      const r = attempt(rgb);
      return finish(r.data, r.quality, 0, 0);
    } catch (e) {
      if (!(e instanceof JpegError) || e.code !== 'unreachable-size') throw e;
      first = e;
    }
    if (first.details.maxBytes !== undefined) {
      for (const amp of [1, 2, 3, 4, 6, 8]) {
        try {
          const r = attempt(withGrain(rgb, amp));
          return finish(r.data, r.quality, amp, 0);
        } catch (e) {
          if (!(e instanceof JpegError) || e.code !== 'unreachable-size') throw e;
          if (e.details.minBytes !== undefined) break; // overshot: now too detailed
        }
      }
    } else if (first.details.minBytes !== undefined && first.details.minBytes > res.size) {
      for (const radius of [1, 2, 3, 5, 8, 12]) {
        try {
          const r = attempt(boxBlur(rgb, SHUTDOWN_W, SHUTDOWN_H, radius));
          return finish(r.data, r.quality, 0, radius);
        } catch (e) {
          if (!(e instanceof JpegError) || e.code !== 'unreachable-size') throw e;
          if (e.details.maxBytes !== undefined) break;
        }
      }
    } else {
      // the search ran out of trials: a different seed usually lands
      for (const seed of [2, 3, 5, 7]) {
        try {
          const r = encodeExactJpeg(rgb, { ...base, seed, onProgress });
          return finish(r.data, r.quality, 0, 0);
        } catch (e) {
          if (!(e instanceof JpegError) || e.code !== 'unreachable-size') throw e;
        }
      }
    }
    throw first;
  }

  /** The factory power-off image of `model`, decoded, for display. */
  factoryShutdownPreview(model: CameraModel): { rgb: Uint8Array; width: number; height: number } | null {
    const res = this.info.shutdown[model];
    if (!res) return null;
    return decodeBaselineJpeg(res.data);
  }

  rotationScript(model: CameraModel, count: number): string {
    const res = this.info.shutdown[model];
    if (!res) throw new FirmwareError('unexpected-layout', `no power-off image for ${model} in this firmware`);
    return rotationScript({ model, size: res.size, count });
  }
}
