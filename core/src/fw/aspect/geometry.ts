// SPDX-License-Identifier: GPL-2.0-only
/**
 * Geometry of an added aspect ratio: everything the camera needs to know about it, computed from
 * the ratio alone.
 *
 * This is a port of the planning part of DoYitNow/gr-custom-tool (gr4_editor/crops.py,
 * crop_geometry.py `record` / `planned_record`, crop_state.py `_source_rectangles`,
 * crop_raw.py `_factors` / `_validate_map`, crop_image_identity.py `_playback_rectangles`),
 * Copyright (C) 2026 DoYitNow, GPL-2.0-only. Where the reference runs firmware functions in an
 * emulator, the recorded results in `facts.ts` are used instead.
 *
 * How a ratio becomes pixels: the 720x480 screen image is cropped to the largest centred rectangle
 * of the requested ratio whose width and height are multiples of 4. THAT rectangle's ratio (the
 * "actual" ratio) is then applied to every photo size the same way. So 65:24 becomes 720x264 on
 * screen (30:11, 0.7 % off) and 6192x2272 as a full-size JPEG.
 */
import { FirmwareError } from '../types';
import { BASE_DIMS, FACTORY, MAP_TEMPLATES, QUICK_VIEW_FULL, RECT_BASES } from './facts';
import { Frac, toInt } from './fraction';

export interface Rect { left: number; top: number; width: number; height: number }

/** The virtual plane the firmware lays live view out on: 45 x 30 in Q16. */
export const PLANE_W = 45 << 16;
export const PLANE_H = 30 << 16;

export const SCREEN_W = 720;
export const SCREEN_H = 480;
export const THUMB_W = 160;
export const THUMB_H = 120;

const THREE_HALVES = new Frac(3, 2);

function bad(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** `5:4`, `2.35:1`, `2.35`, also with a full-width colon or a slash (reference: `parse_ratio`). */
export function parseRatio(value: string): Frac {
  if (typeof value !== 'string' || value.length > 64) bad('bad-ratio', 'a ratio is width:height or a positive number');
  const fields = value.trim().split(/[:：/]/);
  if (!(fields.length === 1 || fields.length === 2) || fields.some((f) => !/^\d+(?:\.\d+)?$/.test(f.trim()))) {
    bad('bad-ratio', 'write the ratio like 5:4, 2.35:1 or 2.35');
  }
  const one = (text: string): Frac => {
    const [whole, fraction = ''] = text.trim().split('.');
    return new Frac(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  };
  const a = one(fields[0]);
  const b = fields.length === 2 ? one(fields[1]) : new Frac(1);
  if (b.n === 0n || a.n === 0n) bad('bad-ratio', 'both sides of a ratio must be greater than zero');
  return a.div(b);
}

export function ratioText(width: number | bigint, height: number | bigint): string {
  const f = new Frac(width, height);
  return `${f.n}:${f.d}`;
}

/** Python `4 * ((value + 2) // 4)` on an exact fraction. */
function nearest4(value: Frac): bigint {
  return 4n * value.add(2).div(4).floor();
}

/**
 * The largest centred `ratio` rectangle inside width x height with both sides a multiple of 4
 * (reference: `_aligned_crop`). Null when nothing of at least 4x4 fits.
 */
export function alignedCrop(width: number, height: number, ratio: Frac): Rect | null {
  let w: bigint;
  let h: bigint;
  if (ratio.cmp(new Frac(width, height)) >= 0) {
    w = BigInt(width);
    h = nearest4(new Frac(width).div(ratio));
  } else {
    w = nearest4(new Frac(height).mul(ratio));
    h = BigInt(height);
  }
  if (!(w >= 4n && w <= BigInt(width) && h >= 4n && h <= BigInt(height))) return null;
  const wi = toInt(w);
  const hi = toInt(h);
  return { width: wi, height: hi, left: Math.floor((width - wi) / 2), top: Math.floor((height - hi) / 2) };
}

/** Index into `QUICK_VIEW_FULL` of a screen rectangle (one side full, the other a multiple of 4). */
function screenIndex(width: number, height: number): number {
  if (width === SCREEN_W && height % 4 === 0 && height >= 4 && height <= SCREEN_H) return height / 4 - 1;
  if (height === SCREEN_H && width % 4 === 0 && width >= 4 && width < SCREEN_W) return SCREEN_H / 4 + width / 4 - 1;
  return -1;
}

export interface PhotoSize { model: string; selector: number; magIndex: number; width: number; height: number }

export interface RatioGeometry {
  /** The ratio as asked for. */
  requested: Frac;
  /** The ratio of the aligned screen rectangle; every size below follows this one. */
  actual: Frac;
  /** Crop of the 720x480 screen image. */
  screen: Rect;
  /** Crop of the 160x120 thumbnail. */
  thumb: Rect;
  /** Output size for every model / quality / crop step, in the firmware's order (24 entries). */
  photoSizes: PhotoSize[];
  /** [3:2 width, 3:2 height, width, height] for each distinct 3:2 size, in first-seen order. */
  dims: [number, number, number, number][];
  /** Width and height of the ratio as fractions of the 3:2 frame: [numerator, denominator]. */
  fx: [number, number];
  fy: [number, number];
  /** AF area: [left, top, right, bottom] on the 720x480 screen, its size and the small-frame size. */
  af: [number, number, number, number];
  afSize: [number, number];
  afSmall: [number, number];
  /** Tracking window scale. */
  tracking: [number, number];
  /** Which factory code path the AF hardware modes borrow: 5 (wide) or 3 (square/tall). */
  modeAlias: 3 | 5;
  /** The live-view rectangle on the 45x30 Q16 plane, as the installed hook will compute it. */
  preview: Rect;
  /** fx / fy re-derived from the rounded `preview` (what the AE/WB grid and photo info use). */
  planeX: Frac;
  planeY: Frac;
}

function fracPair(f: Frac): [number, number] {
  return [toInt(f.n), toInt(f.d)];
}

/** The hook's rounding: `(value * n + (d >> 1)) / d`, unsigned, truncating. */
function scaleRound(value: number, n: number, d: number): number {
  return toInt((BigInt(value) * BigInt(n) + BigInt(d >>> 1)) / BigInt(d));
}

export type RatioProblem = 'bad-ratio' | 'ratio-factory' | 'ratio-too-extreme' | 'ratio-quick-view' | 'ratio-metering';

/**
 * Plan one ratio. Throws `FirmwareError` with one of the `RatioProblem` codes when the ratio
 * cannot be used; these are the same refusals as the reference's.
 */
export function planRatio(text: string): RatioGeometry {
  const requested = parseRatio(text);
  // A ratio the camera already has would silently take that ratio's (differently rounded)
  // geometry in the reference. There is no point in adding one, so it is refused here.
  for (const f of FACTORY) {
    if (factoryRatio(f.id).eq(requested)) bad('ratio-factory', 'the camera already has this ratio');
  }
  const screen = alignedCrop(SCREEN_W, SCREEN_H, requested);
  if (!screen) bad('ratio-too-extreme', 'this ratio leaves nothing on the screen');
  const actual = new Frac(screen.width, screen.height);
  const thumb = alignedCrop(THUMB_W, THUMB_H, actual);
  if (!thumb) bad('ratio-too-extreme', 'this ratio leaves nothing of the thumbnail');

  const photoSizes: PhotoSize[] = [];
  const mapped = new Map<string, [number, number, number, number]>();
  for (const [model, selector, magIndex, bw, bh] of BASE_DIMS) {
    const region = alignedCrop(bw, bh, actual);
    if (!region) bad('ratio-too-extreme', 'this ratio leaves nothing of the photo');
    photoSizes.push({ model, selector, magIndex, width: region.width, height: region.height });
    const key = `${bw}x${bh}`;
    const prior = mapped.get(key);
    if (prior && (prior[2] !== region.width || prior[3] !== region.height)) bad('internal', 'inconsistent size map');
    if (!prior) mapped.set(key, [bw, bh, region.width, region.height]);
  }
  const qi = screenIndex(screen.width, screen.height);
  if (qi < 0 || QUICK_VIEW_FULL[qi] !== '1') {
    bad('ratio-quick-view', 'with this ratio the photo sizes do not fill the review screen exactly; try a slightly different ratio');
  }

  const fxF = Frac.min(new Frac(1), actual.div(THREE_HALVES));
  const fyF = Frac.min(new Frac(1), THREE_HALVES.div(actual));
  const fx = fracPair(fxF);
  const fy = fracPair(fyF);
  const af: [number, number, number, number] = [
    Math.max(80, screen.left), Math.max(60, screen.top), Math.min(640, screen.left + screen.width), Math.min(420, screen.top + screen.height),
  ];
  const afSize: [number, number] = [af[2] - af[0], af[3] - af[1]];
  const afSmall: [number, number] = [Math.floor((afSize[0] * 3) / 5), Math.floor((afSize[1] * 3) / 5)];
  const wide = actual.cmp(THREE_HALVES) > 0;
  const tracking: [number, number] = wide
    ? [778, Math.max(1, toInt(new Frac(634).mul(new Frac(180, 77)).div(actual).round()))]
    : [Math.max(1, toInt(new Frac(667).mul(Frac.min(actual, new Frac(1))).round())), 750];

  const pw = scaleRound(PLANE_W, fx[0], fx[1]);
  const ph = scaleRound(PLANE_H, fy[0], fy[1]);
  const preview: Rect = { width: pw, height: ph, left: (PLANE_W - pw + 1) >>> 1, top: (PLANE_H - ph + 1) >>> 1 };
  if (!(pw > 0 && ph > 0)) bad('ratio-too-extreme', 'this ratio leaves nothing of the live view');
  const planeX = new Frac(pw, PLANE_W);
  const planeY = new Frac(ph, PLANE_H);

  // AE/WB grid: every block must stay at least 2 sensor units wide and high (reference: _validate_map).
  for (const [bw, bh, nx, ny] of MAP_TEMPLATES) {
    const h = ((BigInt(bw) * BigInt(nx) * planeX.n) / planeX.d / BigInt(nx)) & ~1n;
    const v = ((BigInt(bh) * BigInt(ny) * planeY.n) / planeY.d / BigInt(ny)) & ~1n;
    if (h === 0n || v === 0n) bad('ratio-metering', 'this ratio is too narrow for the metering grid');
    if (h > 65535n || v > 65535n || h > BigInt(bw) || v > BigInt(bh)) bad('internal', 'metering grid out of range');
  }

  return {
    requested, actual, screen, thumb, photoSizes, dims: [...mapped.values()], fx, fy, af, afSize, afSmall, tracking,
    modeAlias: wide ? 5 : 3, preview, planeX, planeY,
  };
}

function factoryRatio(id: number): Frac {
  return [new Frac(3, 2), new Frac(4, 3), new Frac(16, 9), new Frac(1, 1)][id];
}

/** Photo-info rectangles per crop step: [width, height, left, top] in Q16 (reference: `_source_rectangles`). */
export function sourceRectangles(g: RatioGeometry): number[][] {
  if (!(g.planeX.cmp(0) > 0 && g.planeX.cmp(1) <= 0 && g.planeY.cmp(0) > 0 && g.planeY.cmp(1) <= 0)) bad('internal', 'plane factors out of range');
  return RECT_BASES.map(([bw, bh, bl, bt]) => {
    const w = toInt(new Frac(bw).mul(g.planeX).round());
    const h = toInt(new Frac(bh).mul(g.planeY).round());
    return [w, h, bl + Math.floor((bw - w) / 2), bt + Math.floor((bh - h) / 2)];
  });
}

/** The full-size GR IV output of a ratio (quality L, no crop). */
export function fullSize(g: RatioGeometry): [number, number] {
  const row = g.dims.find((d) => d[0] === FACTORY[0].full[0] && d[1] === FACTORY[0].full[1]);
  if (!row) bad('internal', 'no full-size entry');
  return [row[2], row[3]];
}

/** L / M / S / XS output sizes of the GR IV at crop step `magIndex` (0 = 28 mm), for display. */
export function gr4Sizes(g: RatioGeometry, magIndex = 0): [number, number][] {
  return [0, 1, 2, 3].map((selector) => {
    const s = g.photoSizes.find((p) => p.model === 'Kb636' && p.selector === selector && p.magIndex === magIndex);
    if (!s) bad('internal', 'missing size');
    return [s.width, s.height] as [number, number];
  });
}

export interface ReplayRect { size: [number, number]; rects: number[] }

/**
 * Playback rectangles by exact photo size (reference: `_playback_rectangles`): a photo's size
 * selects the screen / thumbnail rectangle it is shown with. Throws 'ratio-conflict' when two
 * ratios (or a ratio and a factory one) give the same photo size but different rectangles.
 */
export function playbackRectangles(list: readonly RatioGeometry[]): ReplayRect[] {
  const signature = (g: RatioGeometry): number[] => [g.screen.left, g.screen.top, g.screen.width, g.screen.height, g.thumb.left, g.thumb.top, g.thumb.width, g.thumb.height];
  const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
  const factory = new Map<string, number[]>();
  for (const f of FACTORY) for (const [w, h] of f.sizes) factory.set(`${w}x${h}`, [...f.screen, ...f.thumb]);
  const out = new Map<string, ReplayRect>();
  for (const g of list) {
    const rect = signature(g);
    for (const s of g.photoSizes) {
      const key = `${s.width}x${s.height}`;
      const fr = factory.get(key);
      if (fr) {
        if (!same(rect, fr)) bad('ratio-conflict', `photos of ${s.width}x${s.height} would look like a factory ratio's but need a different frame`);
        continue;
      }
      const prior = out.get(key);
      if (prior && !same(prior.rects, rect)) bad('ratio-conflict', `two ratios produce ${s.width}x${s.height} photos with different frames`);
      if (!prior) out.set(key, { size: [s.width, s.height], rects: rect });
    }
  }
  return [...out.values()].sort((a, b) => a.size[0] - b.size[0] || a.size[1] - b.size[1]);
}
