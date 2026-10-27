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
  monoUnlockWords,
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
  readExtraSlotCount,
  readShutdownCount,
  readRatioRecord,
  resolveLayout,
  sectionsOf,
  selfCheck,
  selfCheckGrown,
  buildGrown,
  sha256Hex,
  tileTemplate,
  validateName,
  validateRatioName,
  SOFT_FOCUS_GAINS,
  SOFT_FOCUS_LEVELS,
  SOFT_FOCUS_STRENGTHS,
  clarityChanges,
} from '../fw';
import type { BuildResult, BuiltRatio, ClarityChange, ClarityEdit, ExtensionFeatures, ExtraSlotSpec, LookLayout, ShutdownPictureSpec, SoftFocusLevel, SoftFocusStrength, FactoryEntry, LangCode, Layout, NameValidation, Range, RatioSpec, SlotEdit, SlotId as NativeSlotId } from '../fw';
import { grownRanges, growPayload } from '../fw/aspect/package';
import { BRIDGE_SHA256, BRIDGE_SIZE, isBridgeFirmware, makeBridgeFirmware, officialFromBridge } from '../fw/bridge';
import { convertCube, convertXmp, hueCopy0, hueFromQ10, HUE_BLOCK_BYTES, quantizeSlot } from '../color';
import type { SlotParams } from '../color';
import { JpegError, checkShutdownJpeg, decodeBaselineJpeg, encodeExactJpeg, inspectJpeg } from '../jpeg';
import type { Sampling } from '../jpeg';
import { MODEL_INFO, rotationScript } from '../wallpaper';
import { GR3X_160, gr3ProfileOf, openGr3xOfficial, requireGr3xPort } from '../fw/gr3x/profile';
import { planGr3xRatio } from '../fw/gr3x/geometry';
import { GR3X_MAX_CUSTOM_RATIOS, GR3X_T4_MENU, gr3xCustoms, planGr3xMenu } from '../fw/gr3x/geometry';
import type { Gr3xMenuRatio } from '../fw/gr3x/geometry';
import { readGr3xBuildRecipe } from '../fw/gr3x/ratio-recipe';
import { isGr3xFactoryLayout, validateGr3xLookLayout } from '../fw/gr3x/look-layout';
import type { Gr3xLookLayout } from '../fw/gr3x/look-layout';
import { encodeGr3xPicture, GR3X_MAX_PICTURES, gr3xPicturePath } from '../fw/gr3x/shutdown';
import { encodeShutdownPicture } from '../fw/aspect/shutdown';
import type { Gr3xPictureSpec } from '../fw/gr3x/shutdown';
import { readRes, resFile } from '../fw/aspect/res';
import { buildGr3xTestFirmware } from '../fw/gr3x/research-package';
import { readGr3xFactoryEntry } from '../fw/gr3x/factory';
import { GR3X_CLARITY_OFFSET } from '../fw/gr3x/clarity';
import { GR3X_FILM_IDS, GR3X_FILM_NAMES, GR3X_LOOK_CHARS, gr3xAllowedChars, gr3xLookResources, validateGr3xLookName } from '../fw/gr3x/look-resources';
import { readGr3xLookRecipe } from '../fw/gr3x/look-recipe';
import type { Gr3xLookOptions } from '../fw/gr3x/image-control';
import { GR3X_MAX_FILMS } from '../fw/gr3x/image-control';
import { convertGr3xCube, convertGr3xXmp } from '../color/gr3x-import';
import type { CameraModel } from '../wallpaper';

export const SHUTDOWN_W = 720;
export const SHUTDOWN_H = 480;
/** App identities include IIIx additions; GR IV's native patch API stays CY/CG. */
export type SlotId = NativeSlotId | typeof GR3X_FILM_IDS[number];

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
  family: 'gr4' | 'gr3x';
  filename: string;
  models: CameraModel[];
  factoryRatios: string[];
  /** `menuPictures`: power-off pictures chosen in the camera's menu (End Screen submenu on both; GR III builds of round 5 had a Setup line after End Screen). */
  capabilities: { build: boolean; presets: boolean; wallpaper: boolean; factoryEntry: boolean; bridge: boolean; menuPictures: boolean;
    /** The Image Control menu order and hidden looks (GR IV; GR III 2.10 from round 8). */
    lookLayout?: boolean };
  features: { softFocus: 'clarity' | 'adj'; dateStamp: boolean; monoUnlock: boolean;
    /** Direct Flash, a fifth Flash Mode (GR IV; GR III / IIIx have the GF-2 mode of their own). */
    directFlash?: boolean;
    /** GR III / IIIx: the most films a build can have (9; 20 on GR III 2.10, where
     * the number is chosen with BuildOptions.filmCount and Halation is set in the camera). */
    maxFilms?: number };
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
  /**
   * True when the file opened was the 1.12 bridge firmware (see `fw/bridge.ts`). Everything else
   * describes the official 1.11 file recovered from it; builds are refused until the official file
   * is opened.
   */
  bridge: boolean;
}

export interface PresetResult {
  kind: 'xmp' | 'cube';
  title: string;
  /** CIE76 mean / p95 on the fixed reporting colours (see `Conversion`). */
  meanDE: number;
  p95DE: number;
  /** The same as CIEDE2000. */
  meanDE2000?: number;
  p95DE2000?: number;
  warnings: string[];
  unsupported: string[];
  params: SlotParams;
  matrixQ13: Int16Array;
  curves: [Uint16Array, Uint16Array, Uint16Array];
  /** The post-curve ("second") matrix in Q9, rows summing to 512. */
  postQ9?: Int16Array;
  /** Converted with `hue` and kept: the added slot's own hue sectors (copy 0, Q10, 12 x 9). */
  hueQ10?: number[];
}

export interface SlotRequest {
  slot: SlotId;
  preset?: { matrixQ13: ArrayLike<number>; curves: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]; postQ9?: ArrayLike<number> };
  icon?: Uint8Array;
  names?: Partial<Record<LangCode, string>>;
  /** Halation. GR IV (0.8.2): on or off for Cinema Yellow / Green with a preset (its Toning becomes
   * the Halation row). GR III / IIIx legacy builds (no film count): level fixed in the build (0 off,
   * 1 weak, 2 strong); with a film count every film has it, set in the camera. */
  halation?: boolean | 0 | 1 | 2;
}

/** Soft focus on one negative clarity setting: its row of the clarity table gets the gains of `strength`. */
export interface SoftFocusRequest {
  level: SoftFocusLevel;
  strength: SoftFocusStrength;
}

export type FirmwareBuild = Omit<BuildResult, 'decoded'>;

/** What adding a ratio would give, for the UI; `problem` is set (and the rest absent) when it cannot be added. */
export interface RatioPreview {
  status?: 'planning-only';
  screenActual?: string;
  problem?: 'bad-ratio' | 'ratio-factory' | 'ratio-portrait' | 'ratio-too-extreme' | 'ratio-quick-view' | 'ratio-metering' | 'ratio-conflict' | 'ratio-duplicate';
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
  /** `official`: the unmodified file; `modified`: a valid 1.11 container with changes; `bridge`: the 1.12 bridge firmware; `unknown`: anything else. */
  kind: 'official' | 'modified' | 'bridge' | 'unknown';
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
  /** True when the file adds the date imprint (with its camera-menu entry). */
  dateStamp: boolean;
  /** True when the file unlocks the six looks of the GR IV Monochrome. */
  monoUnlock: boolean;
  /** Image Control slots the file adds (empty when none, or when they cannot be read). */
  extraSlots: { name: string; icon: Uint8Array }[];
  /** Power-off pictures chosen in the camera's End Screen menu (absent when none, or when they cannot be read). */
  shutdownPictures?: ShutdownPictureSpec[];
  /** Image Control menu order and hidden looks (0.8.4), as recorded in the file. */
  lookLayout?: LookLayout;
  /** True when the file adds Direct Flash, a fifth Flash Mode (0.8.4). */
  directFlash?: boolean;
}

/** Additions besides the slots and the ratios. */
export interface BuildOptions {
  /** Put soft focus (off / weak / medium / strong) on the ADJ lever. */
  adjSoftFocus?: boolean;
  /** Date imprint on the JPEG, switched in the camera's menu. */
  dateStamp?: boolean;
  /** The six black-and-white looks of the GR IV Monochrome. */
  monoUnlock?: boolean;
  /** Added Image Control slots (1 to 20), after the factory ones. */
  extraSlots?: ExtraSlotSpec[];
  /** Image Control menu order and hidden looks (factory ids 11..30 plus added styles 34..;
   * GR III: the camera's 11..22 plus films 64..). */
  lookLayout?: LookLayout;
  /** GR III / IIIx: 7 or 8 build round 7's or round 8's files (camera-tested T7, T8) instead of round 9's (the default). */
  gr3Round?: 7 | 8 | 9 | 10;
  /** Power-off pictures (1 to 8) chosen in the camera's End Screen menu; see `encodeShutdownPicture`. */
  shutdownPictures?: ShutdownPictureSpec[];
  /** Direct Flash, a fifth Flash Mode (0.8.4); its guide number is chosen in the camera. */
  directFlash?: boolean;
  /**
   * The settings guard and what comes with it from 0.8.2 (see `aspect/guard.ts`); default true.
   * False only to build files as GR Mod 0.8.1 and earlier did (regression tests).
   */
  guard?: boolean;
  /** Test builds only: a fixed setting byte (1 short, 3 long style) instead of the camera menu. */
  dateStampFixed?: number;
  /** Test builds only: print the encoder configuration on the 720x480 picture. */
  dateStampDiag?: boolean;
  /** GR III 2.10: the number of films, 1..20 (`features.maxFilms`), each with a Halation
   * line in the camera. Absent: the nine-film T6 build. */
  filmCount?: number;
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
  private readonly layout: Layout | null;
  private editable: Range[] | null = null;
  private monoWords: { offset: number; bytes: Uint8Array }[] | null = null;
  private gr3xCandidates = new Map<string, Promise<FirmwareBuild>>();

  private fixedGr3x(softFocus: readonly SoftFocusRequest[] = [], looks?: Gr3xLookOptions, menu: readonly Gr3xMenuRatio[] = GR3X_T4_MENU, adjSoftFocus = false, dateImprint = false, pictures: readonly Gr3xPictureSpec[] = [], dateMenu: 'list' | 'submenu' = 'submenu', pictureMenu: 'list' | 'submenu' = 'submenu',
    round: { round7?: boolean; round8?: boolean; round9?: boolean; round10?: boolean; lookLayout?: Gr3xLookLayout } = {}): Promise<FirmwareBuild> {
    const requests = [...softFocus].sort((a, b) => a.level - b.level);
    const round7 = round.round7 === true, round8 = round7 && round.round8 === true, round9 = round8 && round.round9 === true, round10 = round9 && round.round10 === true, lookLayout = round8 ? round.lookLayout : undefined;
    const key = JSON.stringify({ requests, looks, menu, adjSoftFocus, dateImprint, dateMenu, pictureMenu, round7, round8, round9, round10, lookLayout, pictures: pictures.map(p => ({ id: p.id, name: p.name, jpeg: Array.from(p.jpeg) })) });
    let candidate = this.gr3xCandidates.get(key);
    if (candidate) return candidate;
    candidate = buildGr3xTestFirmware(this.raw, requests, looks, menu, { adjSoftFocus, ...(dateImprint ? { dateImprint, dateMenu } : {}), ...(pictures.length ? { pictures, pictureMenu } : {}), ...(round7 ? { round7 } : {}),
      ...(round8 ? { round8 } : {}), ...(round9 ? { round9 } : {}), ...(round10 ? { round10 } : {}), ...(lookLayout ? { lookLayout } : {}) }).then(r => ({
      file: r.bytes, sha256: r.report.outputSha256, decodedSha256: r.decodedSha256,
      changedFrames: r.changedFrames, changedBytes: r.changedBytes,
      ranges: r.report.ranges, checks: r.report.checks, features: { ...(looks?.monoReplicas ? { monoUnlock: true } : {}), ...(adjSoftFocus ? { adjSoftFocus: true } : {}), ...(dateImprint ? { dateStamp: true } : {}),
        ...(pictures.length ? { shutdown: { pictures: pictures.map((p, k) => ({ id: p.id ?? k + 1, name: p.name, jpeg: p.jpeg })), factory: [] } } : {}),
        ...(lookLayout ? { lookLayout: { order: [...lookLayout.order], hidden: [...lookLayout.hidden] } } : {}) },
      ratios: gr3xCustoms(r.manifest.menu).map(x => {
        const plan = planGr3xRatio(x.ratio);
        return { id: x.id, name: x.name, ratio: x.ratio, actual: plan.actual, sizes: plan.sizes };
      }),
    }));
    this.gr3xCandidates.set(key, candidate);
    return candidate;
  }

  private constructor(raw: Uint8Array, decoded: Uint8Array, info: FirmwareInfo, mStd: Int16Array, layout: Layout | null) {
    this.raw = raw;
    this.decoded = decoded;
    this.info = info;
    this.mStdQ13 = mStd;
    this.layout = layout;
  }

  /**
   * Accepts the official 1.11 file, or the 1.12 bridge firmware (opened as the official file it
   * was made from, with `info.bridge` set); throws `FirmwareError('unsupported-firmware')` otherwise.
   */
  static async open(input: Uint8Array): Promise<Engine> {
    if (await gr3ProfileOf(input)) {
      const { decoded, profile } = await openGr3xOfficial(input);
      const target = MODEL_INFO.GR3X_HDF.target.toLowerCase();
      const resource = listResources(decoded).find(r => r.path.toLowerCase() === target);
      if (!resource || resource.length !== 7264) throw new FirmwareError('unexpected-layout', 'IIIx shutdown resource changed');
      const data = decoded.slice(resource.offset, resource.offset + resource.length);
      // The IIIx factory JPEG uses optimized Huffman tables. The generated-file
      // checker deliberately requires Annex K tables and is not an input parser.
      const checked = inspectJpeg(data);
      const lookResources = gr3xLookResources(decoded);
      if (!checked.baseline || checked.width !== SHUTDOWN_W || checked.height !== SHUTDOWN_H ||
          checked.precision !== 8 || checked.scans !== 1 || checked.trailingBytes !== 0 ||
          checked.components.length !== 3 || samplingOf(data) !== '420') {
        throw new FirmwareError('unexpected-layout', 'IIIx shutdown JPEG format changed');
      }
      const info: FirmwareInfo = {
        // The standard camera and the HDF one (and the other editions) take the same official file.
        family: 'gr3x', filename: profile.filename, models: [profile.model, profile.standardModel],
        factoryRatios: [...profile.factoryRatios],
        // Power-off images and the factory-menu entry reached the camera through a start-up script.
        // GR Mod 0.8 dropped that route, and it was never tested on these cameras: not offered.
        // Power-off pictures, the date imprint, 20 films, the menu order: GR III 2.10 and GR IIIx 1.60 (one program).
        capabilities: { build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false, menuPictures: profile.fullFeatures, lookLayout: profile.fullFeatures },
        features: { softFocus: 'adj', dateStamp: profile.fullFeatures, monoUnlock: false, maxFilms: profile.fullFeatures ? GR3X_MAX_FILMS : 9 },
        version: profile.version, sha256: profile.sha256, bridge: false,
        slots: GR3X_FILM_IDS.slice(0, profile.fullFeatures ? GR3X_MAX_FILMS : 9).map((id, i) => ({
          id, defaultName: GR3X_FILM_NAMES[i], icon: lookResources.film.slice(),
          names: Object.fromEntries(LANGS.map(l => [l, { text: GR3X_FILM_NAMES[i], capacity: 24 }])) as SlotInfoView['names'],
        })), tiles: lookResources.tiles, contentArea: CONTENT_AREA,
        allowed: Object.fromEntries(LANGS.map(l => [l, gr3xAllowedChars(decoded, l)])) as Record<LangCode, string>,
        shutdown: Object.fromEntries([profile.model, profile.standardModel].map(m => [m, { size: resource.length, sampling: samplingOf(data), data }])), factoryEntry: readGr3xFactoryEntry(decoded, profile),
      };
      return new Engine(input.slice(), decoded, info, lookResources.matrix, null);
    }
    const bridge = await isBridgeFirmware(input);
    const raw = bridge ? await officialFromBridge(input) : input;
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
    for (const model of Object.keys(MODEL_INFO) as (keyof typeof MODEL_INFO)[]) {
      const want = MODEL_INFO[model]!.target.toLowerCase();
      const r = res.find((x) => x.path.toLowerCase() === want);
      if (!r) continue;
      const data = decoded.slice(r.offset, r.offset + r.length);
      shutdown[model] = { size: r.length, sampling: samplingOf(data), data };
    }
    const info: FirmwareInfo = {
      family: 'gr4', filename: 'fwdc248b.bin', models: ['STANDARD', 'HDF', 'MONO'],
      factoryRatios: ['3:2', '4:3', '16:9', '1:1'],
      capabilities: { build: true, presets: true, wallpaper: true, factoryEntry: true, bridge: !bridge, menuPictures: true, lookLayout: true },
      features: { softFocus: 'adj', dateStamp: true, monoUnlock: true, directFlash: true },
      version: FIRMWARE_VERSION,
      sha256: await sha256Hex(raw),
      slots,
      tiles: { film: tileTemplate(decoded, 'film'), plain: tileTemplate(decoded, 'plain') },
      contentArea: CONTENT_AREA,
      allowed,
      shutdown,
      factoryEntry: readFactoryEntry(decoded),
      bridge,
    };
    return new Engine(raw, decoded, info, mStd, layout);
  }

  /** Set by `extendVerified` while it inspects a file: the additions to build on top of it. */
  private extendWith: Partial<ExtensionFeatures> | null = null;
  private extendTest: aspect.TestOptions = {};
  private extended: Uint8Array | null = null;

  /**
   * Development tool (tools/testfw/extend.ts), not used by the program: a verified file of this
   * program rebuilt with more additions (e.g. Direct Flash on top of a test firmware), everything
   * else the same, through the same self-check as any build. Throws when the file is not verified.
   */
  async extendVerified(raw: Uint8Array, add: Partial<ExtensionFeatures>, test: aspect.TestOptions = {}): Promise<Uint8Array> {
    this.extendWith = add;
    this.extendTest = test;
    this.extended = null;
    try {
      const s = await this.inspect(raw);
      if (!s.verified || !this.extended) throw new FirmwareError('selfcheck-failed', 'the file is not a verified file of this program');
      return this.extended;
    } finally {
      this.extendWith = null;
    }
  }

  /** The 1.12 bridge firmware, made from the official file this engine holds (see `fw/bridge.ts`). */
  async bridgeFirmware(): Promise<Uint8Array> {
    if (this.layout === null) requireGr3xPort('bridge firmware');
    return makeBridgeFirmware(this.raw);
  }

  /**
   * Describe a firmware file: is it the official one, a modified 1.11 file (and what its two
   * slots look like), or something else. Never throws on a damaged file.
   */
  async inspect(raw: Uint8Array): Promise<FirmwareSummary> {
    const sha256 = await sha256Hex(raw);
    if (this.layout === null) {
      const official = sha256 === this.info.sha256 && raw.length === this.raw.length;
      let candidate: FirmwareBuild | null = null;
      let softFocus: ClarityChange[] = [];
      let looks: Gr3xLookOptions | null = null;
      let adjSoftFocus = false, dateImprint = false;
      let pictures: Gr3xPictureSpec[] = [];
      let dateMenu: 'list' | 'submenu' = 'list';
      let pictureMenu: 'list' | 'submenu' = 'list';
      let round7 = false, round8 = false, round9 = false, round10 = false;
      let lookLayout: Gr3xLookLayout | undefined;
      if (!official) try {
        // Read only recognized negative gain rows, rebuild from the verified
        // original, and compare the entire file. A valid container or metadata
        // label alone never authorizes restoring an arbitrary firmware file.
        const decoded = new Firmware(raw).decoded;
        const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS');
        let menu: Gr3xMenuRatio[] = [...GR3X_T4_MENU];
        if (rtos && rtos.offset === GR3X_160.rtosOffset && rtos.size > GR3X_160.rtosLength) {
          const appended = decoded.subarray(rtos.offset + GR3X_160.rtosLength, rtos.offset + rtos.size);
          looks = readGr3xLookRecipe(appended);
          const build = readGr3xBuildRecipe(appended);
          if (build) {
            menu = planGr3xMenu(build.ratios); adjSoftFocus = build.adjSoftFocus; dateImprint = build.dateImprint; dateMenu = build.dateMenu; pictureMenu = build.pictureMenu; round7 = build.round7;
            round8 = build.round8; round9 = build.round9; round10 = build.round10; lookLayout = build.lookLayout;
            // Power-off pictures: the names from the recipe, the JPEGs from the file's own RES section.
            if (build.pictures.length) {
              if (build.pictures.length > GR3X_MAX_PICTURES) throw new FirmwareError('bad-edit', 'IIIx picture recipe');
              const dir = readRes(decoded);
              pictures = build.pictures.map((name, k) => {
                const jpeg = resFile(decoded, gr3xPicturePath(k), dir);
                if (!jpeg) throw new FirmwareError('bad-edit', 'IIIx picture missing');
                return { name, jpeg, ...(build.pictureMenu === 'submenu' ? { id: build.pictureIds[k] } : {}) };
              });
            }
          }
        }
        const changes = clarityChanges(decoded, GR3X_CLARITY_OFFSET);
        if (changes.every(c => SOFT_FOCUS_LEVELS.includes(c.level as SoftFocusLevel) && c.strength !== 'custom')) {
          candidate = await this.fixedGr3x(changes as SoftFocusRequest[], looks ?? undefined, menu, adjSoftFocus, dateImprint, pictures, dateMenu, pictureMenu, { round7, round8, round9, round10, ...(lookLayout ? { lookLayout } : {}) });
          softFocus = changes;
        }
      } catch { /* unrecognized input remains non-writable */ }
      const matched = candidate !== null && sha256 === candidate.sha256 && raw.length === candidate.file.length;
      return { sha256, kind: official ? 'official' : matched ? 'modified' : 'unknown', verified: official || matched,
        changedBytes: matched ? candidate!.changedBytes : 0,
        slots: matched && looks ? GR3X_FILM_IDS.slice(0, looks.filmCount ?? (looks.displayRevision === 3 ? 9 : 2)).map((id, i) => ({ id, icon: this.info.slots[i]?.icon ?? this.info.tiles.film })).map((s, i) => ({
          id: s.id, names: Object.fromEntries(LANGS.map(l => [l, looks!.films?.[i]?.names?.[l] || looks!.films?.[i]?.name || GR3X_FILM_NAMES[i]])) as Record<LangCode, string>,
          icon: looks!.films?.[i]?.icon ?? s.icon, colorChanged: !!(looks!.films?.[i]?.preset || looks!.films?.[i]?.params),
          nameChanged: (!!looks!.films?.[i]?.name && looks!.films?.[i]?.name !== GR3X_FILM_NAMES[i]) || !!looks!.films?.[i]?.names,
          iconChanged: !!looks!.films?.[i]?.icon,
        })) : [], ratios: matched ? candidate!.ratios : [], softFocus: matched ? softFocus : [],
        adjSoftFocus: matched && adjSoftFocus, dateStamp: matched && dateImprint, monoUnlock: matched && looks?.monoReplicas === true, extraSlots: [],
        ...(matched && pictures.length ? { shutdownPictures: pictures.map((p, k) => ({ id: p.id ?? k + 1, name: p.name, jpeg: p.jpeg })) } : {}),
        ...(matched && lookLayout ? { lookLayout: { order: [...lookLayout.order], hidden: [...lookLayout.hidden] } } : {}) };
    }
    if (raw.length === BRIDGE_SIZE && sha256 === BRIDGE_SHA256) return { sha256, kind: 'bridge', changedBytes: 0, verified: true, slots: [], ratios: [], softFocus: [], adjSoftFocus: false, dateStamp: false, monoUnlock: false, extraSlots: [] };
    const describe = (d: Uint8Array): FirmwareSummary['slots'] =>
      SLOTS.map((s) => {
        const names = {} as Record<LangCode, string>;
        let nameChanged = false;
        for (const lang of LANGS) {
          names[lang] = readName(d, lang, s.nameIndex).text;
          if (names[lang] !== readName(this.decoded, lang, s.nameIndex).text) nameChanged = true;
        }
        const li = this.layout![s.id];
        const same = (va: number, len: number): boolean => equalRange(d, foff(va), this.decoded, foff(va), len);
        const colorChanged = !(same(li.matrix, LEN.matrix) && same(li.desc, LEN.desc) && same(li.R, LEN.R) && same(li.G, LEN.G) && same(li.B, LEN.B) && same(li.maBlock, LEN.ma_block));
        const icon = readIcon(d, s.iconOffset);
        const iconChanged = !equalRange(d, s.iconOffset, this.decoded, s.iconOffset, icon.length);
        return { id: s.id, names, icon, colorChanged, nameChanged, iconChanged };
      });
    if (sha256 === this.info.sha256) return { sha256, kind: 'official', changedBytes: 0, verified: true, slots: describe(this.decoded), ratios: [], softFocus: [], adjSoftFocus: false, dateStamp: false, monoUnlock: false, extraSlots: [] };
    try {
      const fw = new Firmware(raw);
      if (!equalRange(fw.header, 0, this.raw, 0, fw.header.length)) throw new Error('not 1.11');
      if (!this.editable) this.editable = editableRanges(this.decoded);
      if (fw.decoded.length !== DECODED_SIZE) return this.inspectGrown(sha256, raw, fw.decoded, describe);
      // The monochrome looks on their own are written in place: all of their words, or none.
      if (!this.monoWords) this.monoWords = monoUnlockWords(this.decoded);
      const monoUnlock = this.monoWords.every((w) => equalRange(fw.decoded, w.offset, w.bytes, 0, 4));
      const allowed = monoUnlock ? [...this.editable, ...this.monoWords.map((w) => ({ what: 'monochrome looks', offset: w.offset, length: 4 }))] : this.editable;
      const checks = selfCheck(this.raw, raw, allowed);
      const verified = Object.values(checks).every((v) => v === true);
      return { sha256, kind: 'modified', changedBytes: countChangedBytes(fw.decoded, this.decoded), verified, slots: describe(fw.decoded), ratios: [], softFocus: clarityChanges(fw.decoded), adjSoftFocus: false, dateStamp: false, monoUnlock, extraSlots: [] };
    } catch {
      return { sha256, kind: 'unknown', changedBytes: 0, verified: false, slots: [], ratios: [], softFocus: [], adjSoftFocus: false, dateStamp: false, monoUnlock: false, extraSlots: [] };
    }
  }

  /**
   * A file whose payload is longer than the official one: recognised when RTOS and ICONBIN grew
   * by whole frames and the end of RTOS carries this program's record of added ratios. It is
   * `verified` when building the same ratios (on top of the same slot edits) gives exactly this
   * payload, and the file passes the self-check for grown files.
   */
  private inspectGrown(sha256: string, raw: Uint8Array, dec: Uint8Array, describe: (d: Uint8Array) => FirmwareSummary['slots']): FirmwareSummary {
    const unknown: FirmwareSummary = { sha256, kind: 'unknown', changedBytes: 0, verified: false, slots: [], ratios: [], softFocus: [], adjSoftFocus: false, dateStamp: false, monoUnlock: false, extraSlots: [] };
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
    // ICONBIN grows only when icons were added (a build that only appends code leaves it as it is).
    // RES grows only by power-off pictures: one run of files inserted between official ones.
    const resGrowth = dec.length - DECODED_SIZE - rtosGrowth - iconGrowth;
    if (!(rtosGrowth > 0 && iconGrowth >= 0 && resGrowth >= 0 && rtosGrowth % FRAME_SIZE === 0 && iconGrowth % FRAME_SIZE === 0 && resGrowth % FRAME_SIZE === 0)) return unknown;
    const resInsert = resGrowth > 0 ? aspect.findResInsertion(this.decoded, dec, FRAME_SIZE) : null;
    if (resGrowth > 0 && !(resInsert && resInsert.length === resGrowth)) return unknown;
    // The payload with the added blocks taken out again: official layout.
    const aligned = new Uint8Array(DECODED_SIZE);
    const rtosEnd = RTOS_OFFSET + RTOS_LENGTH;
    const iconEnd = ICONBIN_OFFSET + ICONBIN_LENGTH;
    aligned.set(dec.subarray(0, rtosEnd), 0);
    aligned.set(dec.subarray(rtosEnd + rtosGrowth, iconEnd + rtosGrowth), rtosEnd);
    if (resInsert) {
      const after = rtosGrowth + iconGrowth;
      aligned.set(dec.subarray(iconEnd + after, resInsert.at + after), iconEnd);
      aligned.set(dec.subarray(resInsert.at + after + resGrowth), resInsert.at);
      const count = aspect.readRes(this.decoded).countOffset;
      aligned.set(this.decoded.subarray(count, count + 4), count);
    } else {
      aligned.set(dec.subarray(iconEnd + rtosGrowth + iconGrowth), iconEnd);
    }
    aligned.set(this.decoded.subarray(RTOS_OFFSET - 4, RTOS_OFFSET), RTOS_OFFSET - 4);
    aligned.set(this.decoded.subarray(ICONBIN_OFFSET - 4, ICONBIN_OFFSET), ICONBIN_OFFSET - 4);
    const specs = readRatioRecord(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth));
    const features = readExtensionFeatures(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth)) ?? {};
    // Added slots: their data is read back from the file and built again like everything else.
    const extraCount = readExtraSlotCount(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth)) ?? 0;
    if (extraCount > 0) {
      const iconStart = ICONBIN_OFFSET + rtosGrowth;
      const slots = aspect.readExtraSlots(dec.slice(RTOS_OFFSET, rtosEnd + rtosGrowth), dec.subarray(iconStart, iconStart + ICONBIN_LENGTH + iconGrowth), extraCount);
      if (!slots) return { ...unknown, kind: 'modified' };
      features.extraSlots = slots;
    }
    // Halation of Cinema Yellow / Green (0.8.2): from the image as well.
    const halation = aspect.readHalation(new aspect.Patch(dec.slice(RTOS_OFFSET, rtosEnd + rtosGrowth)), aspect.EXTRA_FIRST_STYLE, extraCount);
    const cinemaHalation: Partial<Record<'CY' | 'CG', true>> = {};
    for (const [id, style] of [['CY', 18], ['CG', 19]] as const) if (halation?.has(style)) cinemaHalation[id] = true;
    if (Object.keys(cinemaHalation).length > 0) features.cinemaHalation = cinemaHalation;
    // Power-off pictures: names and identities from the image, JPEGs from RES.
    const pictureCount = readShutdownCount(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth)) ?? 0;
    if (pictureCount > 0 || resInsert) {
      const menu = aspect.readShutdownMenu(new aspect.Patch(dec.slice(RTOS_OFFSET, rtosEnd + rtosGrowth)));
      const jpegs = aspect.readShutdownJpegs(dec, pictureCount);
      if (!menu || !jpegs || menu.length !== pictureCount || !resInsert) return { ...unknown, kind: 'modified' };
      features.shutdown = { pictures: menu.map((m, k) => ({ ...m, jpeg: jpegs[k] })), factory: aspect.factoryShutdownJpegs(this.decoded) };
    }
    // Files of GR Mod 0.2.x are revision 1; they are checked against what that revision builds.
    const revision = readBuildRevision(dec.subarray(RTOS_OFFSET, rtosEnd + rtosGrowth)) ?? 1;
    const modified = (verified: boolean, ratios: BuiltRatio[], slotsFrom: Uint8Array): FirmwareSummary => ({
      sha256, kind: 'modified', changedBytes: countChangedBytes(aligned, this.decoded) + rtosGrowth + iconGrowth + resGrowth, verified, slots: describe(slotsFrom), ratios, softFocus: clarityChanges(slotsFrom),
      adjSoftFocus: !!features.adjSoftFocus,
      dateStamp: !!features.dateStamp,
      monoUnlock: !!features.monoUnlock,
      extraSlots: (features.extraSlots ?? []).map((x) => ({ name: x.name, icon: x.icon })),
      ...(features.shutdown ? { shutdownPictures: [...features.shutdown.pictures] } : {}),
      ...(features.lookLayout ? { lookLayout: features.lookLayout } : {}),
      ...(features.directFlash ? { directFlash: true } : {}),
    });
    if (!specs) return modified(false, [], aligned);
    let ratios: BuiltRatio[] = [];
    try {
      // Files of earlier versions may hold ratios narrower than 1:1, which are no longer built.
      const plan = planRatios(specs, { portrait: true });
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
      const ranges: Range[] = editable.map((r) => (r.offset >= ICONBIN_OFFSET ? { ...r, offset: r.offset + grown.rtosGrowth + (r.offset >= ICONBIN_OFFSET + ICONBIN_LENGTH ? grown.iconGrowth : 0) } : r));
      ranges.push(...grownRanges(grown, built));
      const checks = selfCheckGrown(this.raw, raw, ranges, grown.decoded);
      const ok = Object.values(checks).every((v) => v === true);
      if (ok && this.extendWith) {
        const more = { ...features, ...this.extendWith };
        const built2 = aspect.installExtensions(aligned.slice(RTOS_OFFSET, rtosEnd), aligned.slice(ICONBIN_OFFSET, iconEnd), plan, more, 3, this.extendTest);
        const grown2 = growPayload(aligned, built2, specs);
        const ranges2: Range[] = editable.map((r) => (r.offset >= ICONBIN_OFFSET ? { ...r, offset: r.offset + grown2.rtosGrowth + (r.offset >= ICONBIN_OFFSET + ICONBIN_LENGTH ? grown2.iconGrowth : 0) } : r));
        ranges2.push(...grownRanges(grown2, built2));
        const out = buildGrown(new Firmware(this.raw), grown2.decoded, grown2.insertions).out;
        const checks2 = selfCheckGrown(this.raw, out, ranges2, grown2.decoded);
        if (Object.values(checks2).every((v) => v === true)) this.extended = out;
      }
      return modified(ok, ratios, aligned);
    } catch {
      return modified(false, ratios, aligned);
    }
  }

  /**
   * What a ratio would become in the camera. `others` are the ratios already in the list (the
   * new one must not collide with them). Never throws.
   */
  previewRatio(ratio: string, others: readonly string[] = []): RatioPreview {
    return this.ratioPreview(ratio, others, true);
  }

  /** `suggest`: look for the nearest ratios that work; the candidates themselves are checked without it (else each would search again, without end). */
  private ratioPreview(ratio: string, others: readonly string[], suggest: boolean): RatioPreview {
    if (this.layout === null) {
      try {
        const g = planGr3xRatio(ratio);
        for (const text of others) {
          try {
            const o = planGr3xRatio(text);
            if (o.screen.width === g.screen.width && o.screen.height === g.screen.height) return { problem: 'ratio-duplicate' };
          } catch { /* Invalid neighbouring rows are reported individually. */ }
        }
        const valid = others.filter(o => { try { planGr3xRatio(o); return true; } catch { return false; } });
        try {
          if (valid.length < GR3X_MAX_CUSTOM_RATIOS) planGr3xMenu([...valid, ratio].map(r => ({ ratio: r })));
        } catch (e) {
          if (e instanceof FirmwareError && e.code === 'ratio-conflict') return { problem: 'ratio-conflict' };
        }
        return { ...g, icon: aspect.drawRatioIcon(ratio), label: aspect.ratioLabel(ratio) };
      } catch (e) {
        return { problem: e instanceof FirmwareError && e.code === 'ratio-factory' ? 'ratio-factory'
          : e instanceof FirmwareError && e.code === 'ratio-too-extreme' ? 'ratio-too-extreme' : 'bad-ratio' };
      }
    }
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
        const known = ['bad-ratio', 'ratio-factory', 'ratio-portrait', 'ratio-too-extreme', 'ratio-quick-view', 'ratio-metering', 'ratio-conflict'];
        const problem = (known.includes(e.code) ? e.code : 'bad-ratio') as RatioPreview['problem'];
        if (problem !== 'ratio-quick-view' || !suggest) return { problem };
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
                if (this.ratioPreview(candidate, others, false).problem === undefined) {
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
    return this.raw.slice();
  }

  /**
   * Fit a preset to a slot: matrix, curves and (unless `post` is false) the post-curve matrix.
   * Without it the result is what GR Mod 0.6.1 and earlier made. `refine` (.cube only, default
   * off) adds the guarded CIEDE2000 refinement. GR III / IIIx take .xmp and .cube too.
   */
  convertPreset(kind: 'xmp' | 'cube', text: string, onProgress?: (f: number) => void, options: { post?: boolean; refine?: boolean; hue?: boolean; legacyFit?: boolean } = {}): PresetResult {
    if (this.info.family === 'gr3x') {
      // The second (post-curve) matrix, as on GR IV: GR III's matrix module has the stage (films only).
      const post = options.post !== false;
      const c = kind === 'xmp' ? convertGr3xXmp(text, { onProgress, post }) : convertGr3xCube(text, { onProgress, post, refine: options.refine === true, legacyFit: options.legacyFit === true });
      const q = quantizeSlot(c.params, this.mStdQ13);
      // A (toned) black-and-white fit has equal rows; rounding each row to 8192 on its own diagonal
      // can leave them 1 apart: the camera gets the first row three times (still black and white,
      // and recognised as such by the date imprint's black-and-white test).
      if (!q.postQ9 && c.params.M1.every(r => r.every((v, k) => v === c.params.M1[0][k])))
        for (let r = 1; r < 3; r++) for (let k = 0; k < 3; k++) q.matrixQ13[r * 3 + k] = q.matrixQ13[k];
      return { ...c, ...q };
    }
    if (this.layout === null || !this.info.capabilities.presets) requireGr3xPort('preset conversion');
    const post = options.post !== false;
    // Hue sectors (experimental, added slots only): fitted against Standard's own block of this firmware.
    const hueStd = options.hue === true && post ? this.standardHue() : undefined;
    const c = kind === 'xmp' ? convertXmp(text, { onProgress, post, ...(hueStd ? { hueStd } : {}) }) : convertCube(text, { onProgress, post, refine: options.refine === true, ...(hueStd ? { hueStd } : {}) });
    const q = quantizeSlot(c.params, this.mStdQ13);
    return { kind: c.kind, title: c.title, meanDE: c.meanDE, p95DE: c.p95DE, meanDE2000: c.meanDE2000, p95DE2000: c.p95DE2000, warnings: c.warnings, unsupported: c.unsupported, params: c.params, matrixQ13: q.matrixQ13, curves: q.curves, ...(q.postQ9 ? { postQ9: q.postQ9 } : {}), ...(c.hueQ10 ? { hueQ10: c.hueQ10 } : {}) };
  }

  /** Standard's hue-sector block (copy 0) as 12 matrices. */
  private standardHue(): number[][] {
    if (!this.layout) requireGr3xPort('hue sectors');
    const o = foff(this.layout.standard.maBlock);
    return hueFromQ10(hueCopy0(this.decoded.subarray(o, o + HUE_BLOCK_BYTES)));
  }

  validateName(slot: SlotId, lang: LangCode, text: string): NameValidation {
    if (this.info.family === 'gr3x') {
      if (!this.info.slots.some(s => s.id === slot) || !LANGS.includes(lang)) throw new FirmwareError('bad-edit', 'unknown IIIx slot/language');
      if (!text.trim()) return { ok: false, reason: 'empty', capacity: 24 };
      if (text.length > 24) return { ok: false, reason: 'too-long', capacity: 24 };
      const allowed = this.info.allowed[lang] ?? GR3X_LOOK_CHARS;
      const badChars = [...new Set(Array.from(text).filter(c => !allowed.includes(c)))];
      if (text !== text.trim()) badChars.push(text[0] === ' ' ? ' ' : text[text.length - 1]);
      return badChars.length ? { ok: false, reason: 'bad-char', badChars, capacity: 24 } : { ok: true, capacity: 24 };
    }
    if (this.layout === null || !this.info.capabilities.presets) requireGr3xPort('Image Control names');
    const def = SLOTS.find((s) => s.id === slot);
    if (!def) throw new FirmwareError('bad-edit', `unknown slot ${String(slot)}`);
    return validateName(this.decoded, lang, def.nameIndex, text);
  }

  /** Build a firmware file. The result has passed the built-in self-check (otherwise this throws). */
  async buildFirmware(requests: SlotRequest[], ratios: readonly RatioSpec[] = [], softFocus: readonly SoftFocusRequest[] = [], options: BuildOptions = {}): Promise<FirmwareBuild> {
    if (this.info.family === 'gr3x') {
      if (Object.entries(options).some(([k, v]) => k !== 'monoUnlock' && k !== 'adjSoftFocus' && k !== 'dateStamp' && k !== 'shutdownPictures' && k !== 'filmCount' && k !== 'guard' && k !== 'lookLayout' && k !== 'gr3Round' && v !== undefined && v !== false && !(Array.isArray(v) && !v.length)))
        throw new FirmwareError('gr3x-unsupported', 'added Image Control slots and the test settings of the date imprint are not ported to GR III / IIIx');
      if (options.shutdownPictures?.length && !this.info.capabilities.menuPictures)
        throw new FirmwareError('gr3x-unsupported', 'this GR III / IIIx file has no End Screen pictures');
      if (options.dateStamp && !this.info.features.dateStamp)
        throw new FirmwareError('gr3x-unsupported', 'this GR III / IIIx file has no date imprint');
      // 1..7 added ratios; the T4 seven keep the tested T4 menu (see planGr3xMenu).
      const menu = planGr3xMenu(ratios.map(r => ({ ratio: r.ratio, name: r.name })));
      // 0: no films (as when nothing is chosen).
      const filmCount = options.filmCount || undefined;
      if (options.filmCount === 0 && requests.length) throw new FirmwareError('bad-edit', 'film changes without films');
      if (filmCount !== undefined && (options.monoUnlock || !Number.isInteger(filmCount) || filmCount < 1 || filmCount > (this.info.features.maxFilms ?? 9) || filmCount > GR3X_MAX_FILMS || (this.info.features.maxFilms ?? 9) < GR3X_MAX_FILMS))
        throw new FirmwareError('bad-edit', 'the number of films is 1..20');
      // Legacy replica builds remain reproducible, but T6 uses all nine slots for films (round 6: filmCount).
      const ids = options.monoUnlock ? GR3X_FILM_IDS.slice(0, 2) : GR3X_FILM_IDS.slice(0, filmCount ?? 9);
      if (requests.length > ids.length || new Set(requests.map(r => r.slot)).size !== requests.length ||
          requests.some(r => !ids.includes(r.slot))) throw new FirmwareError('bad-edit', 'unknown or duplicate IIIx film slot');
      const looks: Gr3xLookOptions | undefined = requests.length || options.monoUnlock || filmCount !== undefined ? {
        displayRevision: options.monoUnlock ? 2 : 3,
        monoReplicas: !!options.monoUnlock,
        // Each film keeps its own parameters (T6d); recipes without the flag rebuild T6c.
        ...(options.monoUnlock ? {} : { ownParameters: true }),
        ...(filmCount !== undefined ? { filmCount } : {}),
        films: ids.map((slot, i) => {
          const r = requests.find(r => r.slot === slot);
          // Each camera language may have its own name. Languages without one show the default:
          // the English name, else any plain-ASCII name given, else the slot's default name.
          const given = Object.entries(r?.names ?? {}).filter(([, v]) => typeof v === 'string' && v.length > 0) as [string, string][];
          const ascii = given.find(([l, v]) => l === 'en' && /^[\x20-\x7e]+$/.test(v)) ?? given.find(([, v]) => /^[\x20-\x7e]+$/.test(v));
          const name = ascii?.[1] ?? GR3X_FILM_NAMES[i]; validateGr3xLookName(name);
          const own = Object.fromEntries(given.filter(([, v]) => v !== name));
          return { name, ...(Object.keys(own).length ? { names: own } : {}), ...(r?.preset ? { preset: r.preset } : {}), ...(r?.icon ? { icon: r.icon } : {}),
            // Round 6: Halation is set in the camera (each film has the line).
            ...(typeof r?.halation === 'number' && r.halation > 0 && filmCount === undefined ? { halation: r.halation as 1 | 2 } : {}) };
        }),
      } : undefined;
      if (options.adjSoftFocus && softFocus.length) throw new FirmwareError('bad-clarity', 'soft focus on the ADJ lever and on the clarity table cannot be combined');
      // Round 7 (as GR Mod 0.8.2: settings guard, date imprint by look, halation strength and colour):
      // every GR III 2.10 build but the black-and-white replicas and the legacy
      // nine-film builds without a film count; `guard: false` builds as round 6 did (as GR IV's option).
      // Round 8 (as GR Mod 0.8.4: the date imprint follows the camera and can add the look's name,
      // the Image Control order and hidden looks): every round 7 build, unless `gr3Round: 7` asks
      // for round 7's files (camera-tested T7).
      const round7 = options.guard !== false && !options.monoUnlock && (this.info.features.maxFilms ?? 9) >= GR3X_MAX_FILMS && (!looks || looks.filmCount !== undefined);
      const round8 = round7 && options.gr3Round !== 7;
      // Round 9: round 8 with the live view refreshed between films; `gr3Round: 8` builds round 8's files.
      const round9 = round8 && options.gr3Round !== 8;
      // Round 10 (the default from 0.8.5, camera-tested): GR IV's ways throughout (films as looks of their
      // own, ...); `gr3Round: 9` builds round 9's files.
      const round10 = round9 && options.gr3Round !== 9;
      if (options.lookLayout && !round8) throw new FirmwareError('bad-look-layout', 'the Image Control order needs a round 8 build');
      const lookLayout = options.lookLayout && !isGr3xFactoryLayout(options.lookLayout, filmCount ?? 0) ? options.lookLayout : undefined;
      if (options.lookLayout) validateGr3xLookLayout(options.lookLayout, filmCount ?? 0);
      const r = await this.fixedGr3x(softFocus, looks, menu, !!options.adjSoftFocus, !!options.dateStamp,
        (options.shutdownPictures ?? []).map(p => ({ id: p.id, name: p.name, jpeg: p.jpeg })), 'submenu', 'submenu',
        { round7, round8, round9, round10, ...(lookLayout ? { lookLayout } : {}) });
      return { ...r, file: r.file.slice() };
    }
    if (this.layout === null || !this.info.capabilities.build) requireGr3xPort('custom firmware');
    if (this.info.bridge) throw new FirmwareError('bridge-firmware', 'open the official firmware: the bridge firmware is not a base for builds');
    const edits: SlotEdit[] = [];
    const cinemaHalation: Partial<Record<'CY' | 'CG', true>> = {};
    for (const r of requests) {
      if (r.slot !== 'CY' && r.slot !== 'CG') throw new FirmwareError('bad-edit', 'IIIx film slot is not a GR IV slot');
      if (r.halation !== undefined && r.halation !== false) {
        if (r.halation !== true) throw new FirmwareError('bad-halation', `${r.slot}: halation is on or off`);
        if (!r.preset) throw new FirmwareError('bad-halation', `${r.slot}: halation needs a preset`);
        cinemaHalation[r.slot] = true;
      }
      const e: SlotEdit = { slot: r.slot };
      if (r.preset) e.color = { matrixQ13: r.preset.matrixQ13, curves: r.preset.curves, ...(r.preset.postQ9 ? { postQ9: r.preset.postQ9 } : {}) };
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
    const extraSlots = options && options.extraSlots ? options.extraSlots : [];
    const pictures = options && options.shutdownPictures ? options.shutdownPictures : [];
    const lookLayout = options && options.lookLayout ? options.lookLayout : undefined;
    const directFlash = !!(options && options.directFlash);
    if (directFlash && clarity.length > 0) throw new FirmwareError('bad-clarity', 'Direct Flash cannot be combined with the clarity-table soft focus of 0.4.x');
    if (pictures.length > 0 && clarity.length > 0) throw new FirmwareError('bad-clarity', 'power-off pictures cannot be combined with the clarity-table soft focus of 0.4.x');
    if (adjSoftFocus && clarity.length > 0) throw new FirmwareError('bad-clarity', 'soft focus on the ADJ lever and on the clarity table cannot be combined');
    if (dateStamp && clarity.length > 0) throw new FirmwareError('bad-clarity', 'the date imprint cannot be combined with the clarity-table soft focus of 0.4.x');
    if (extraSlots.length > 0 && clarity.length > 0) throw new FirmwareError('bad-clarity', 'added slots cannot be combined with the clarity-table soft focus of 0.4.x');
    if (edits.length === 0 && ratios.length === 0 && clarity.length === 0 && !adjSoftFocus && !dateStamp && !monoUnlock && extraSlots.length === 0 && pictures.length === 0 && !lookLayout && !directFlash) throw new FirmwareError('bad-edit', 'nothing to change');
    if (Object.keys(cinemaHalation).length > 0 && clarity.length > 0) throw new FirmwareError('bad-clarity', 'halation cannot be combined with the clarity-table soft focus of 0.4.x');
    const features = { adjSoftFocus, guard: clarity.length === 0 && options.guard !== false, ...(Object.keys(cinemaHalation).length > 0 ? { cinemaHalation } : {}), ...(dateStamp ? { dateStamp } : {}), ...(monoUnlock ? { monoUnlock } : {}), ...(extraSlots.length > 0 ? { extraSlots } : {}), ...(pictures.length > 0 ? { shutdown: { pictures, factory: aspect.factoryShutdownJpegs(this.decoded) } } : {}), ...(lookLayout ? { lookLayout } : {}), ...(directFlash ? { directFlash } : {}) };
    const test = {
      ...(options && options.dateStampFixed ? { dateStampFixed: options.dateStampFixed, dateStampDiag: !!options.dateStampDiag } : {}),
    };
    const { decoded: _decoded, ...rest } = await buildFirmware(this.raw, edits, ratios, clarity, features, test);
    return rest;
  }

  /**
   * Encode a 720x480 RGB picture as a power-off image for `model`: same length, sampling and
   * structure as the factory file. A picture that is too plain to fill the file gets a little
   * grain; one that is too detailed for it is softened. Throws `JpegError('unreachable-size')` if
   * neither helps.
   */
  /** A 720 x 480 RGB picture as a power-off picture of the camera menu, in this firmware's format
   * (GR IV: 4:2:2; GR III: 4:2:0 like its own end-screen pictures). */
  encodeMenuPicture(rgb: Uint8Array, onProgress?: (f: number) => void): Uint8Array {
    return this.info.family === 'gr3x' ? encodeGr3xPicture(rgb, onProgress) : encodeShutdownPicture(rgb, onProgress);
  }

  encodeShutdownImage(rgb: Uint8Array, model: CameraModel, onProgress?: (f: number) => void): ShutdownImage {
    if (!this.info.capabilities.wallpaper) requireGr3xPort('power-off images');
    const res = this.info.models.includes(model) ? this.info.shutdown[model] : undefined;
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
    const res = this.info.models.includes(model) ? this.info.shutdown[model] : undefined;
    if (!res) return null;
    return decodeBaselineJpeg(res.data);
  }

  rotationScript(model: CameraModel, count: number): string {
    if (!this.info.capabilities.wallpaper) requireGr3xPort('startup scripts');
    const res = this.info.models.includes(model) ? this.info.shutdown[model] : undefined;
    if (!res) throw new FirmwareError('unexpected-layout', `no power-off image for ${model} in this firmware`);
    return rotationScript({ model, size: res.size, count });
  }
}
