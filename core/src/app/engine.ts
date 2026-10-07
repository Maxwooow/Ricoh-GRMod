/**
 * One object that the UI (through a worker) talks to: it holds the user's official firmware file
 * and offers everything the app does with it. Pure TypeScript, no platform APIs.
 */
import {
  CONTENT_AREA,
  DECODED_SIZE,
  FIRMWARE_VERSION,
  Firmware,
  FirmwareError,
  LANGS,
  LEN,
  SLOTS,
  allowedChars,
  buildFirmware,
  countChangedBytes,
  editableRanges,
  equalRange,
  foff,
  listResources,
  openOfficial,
  readIcon,
  readFactoryEntry,
  readName,
  resolveLayout,
  selfCheck,
  sha256Hex,
  tileTemplate,
  validateName,
} from '../fw';
import type { BuildResult, FactoryEntry, LangCode, Layout, NameValidation, Range, SlotEdit, SlotId } from '../fw';
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

export type FirmwareBuild = Omit<BuildResult, 'decoded'>;

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
    if (sha256 === this.info.sha256) return { sha256, kind: 'official', changedBytes: 0, verified: true, slots: describe(this.decoded) };
    try {
      const fw = new Firmware(raw);
      if (fw.decoded.length !== DECODED_SIZE || !equalRange(fw.header, 0, this.raw, 0, fw.header.length)) throw new Error('not 1.11');
      if (!this.editable) this.editable = editableRanges(this.decoded);
      const checks = selfCheck(this.raw, raw, this.editable);
      const verified = Object.values(checks).every((v) => v === true);
      return { sha256, kind: 'modified', changedBytes: countChangedBytes(fw.decoded, this.decoded), verified, slots: describe(fw.decoded) };
    } catch {
      return { sha256, kind: 'unknown', changedBytes: 0, verified: false, slots: [] };
    }
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
  async buildFirmware(requests: SlotRequest[]): Promise<FirmwareBuild> {
    const edits: SlotEdit[] = [];
    for (const r of requests) {
      const e: SlotEdit = { slot: r.slot };
      if (r.preset) e.color = { matrixQ13: r.preset.matrixQ13, curves: r.preset.curves };
      if (r.icon) e.icon = r.icon;
      if (r.names && Object.keys(r.names).length > 0) e.names = r.names;
      if (e.color || e.icon || e.names) edits.push(e);
    }
    if (edits.length === 0) throw new FirmwareError('bad-edit', 'nothing to change');
    const { decoded: _decoded, ...rest } = await buildFirmware(this.raw, edits);
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
