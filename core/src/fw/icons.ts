/**
 * Pixel helpers for the 40x40 RGBA8888 Image Control icons. No canvas: plain byte arrays,
 * row-major, 4 bytes per pixel (R, G, B, A).
 *
 * What the official tiles look like (Cinema Yellow, Cinema Green and the "Nega" template are
 * identical in this respect): rows 2..37 x cols 1..38 are opaque (alpha 255), everything else
 * (232 pixels) has alpha 0. The outermost one-pixel ring of the opaque rectangle is exactly
 * (128,128,128); the background inside it is (53,53,54).
 */
import { FirmwareError } from './types';
import { ICON_BYTES, NEGA_ICON_OFFSET, slotDef } from './profile';

export const ICON_W = 40;
export const ICON_H = 40;

/** Tile background and border colours of the camera's own icons. */
export const TILE_BG: readonly [number, number, number] = [53, 53, 54];
export const TILE_BORDER: readonly [number, number, number] = [128, 128, 128];

/** Inclusive pixel bounds of where content may be drawn, per tile style. */
export const CONTENT_AREA = {
  plain: { x0: 2, y0: 3, x1: 37, y1: 36 },
  film: { x0: 2, y0: 9, x1: 37, y1: 30 },
} as const;

export type TileStyle = keyof typeof CONTENT_AREA;

function checkIcon(icon: Uint8Array, what: string): void {
  if (!(icon instanceof Uint8Array) || icon.length !== ICON_BYTES) {
    throw new FirmwareError('bad-icon', `${what} must be ${ICON_BYTES} bytes of 40x40 RGBA`);
  }
}

/** Copy of the 6400 icon bytes at a decoded offset. */
export function readIcon(decoded: Uint8Array, offset: number): Uint8Array {
  if (!(offset >= 0 && offset + ICON_BYTES <= decoded.length)) throw new FirmwareError('bad-icon', 'icon offset is outside the payload');
  return decoded.slice(offset, offset + ICON_BYTES);
}

function setTransparent(px: Uint8Array, i: number): void {
  px[i] = 255;
  px[i + 1] = 255;
  px[i + 2] = 255;
  px[i + 3] = 0;
}

/**
 * An empty tile to draw on.
 *  'film'  = the Nega icon with rows 9..30, cols 2..37 (inclusive) set to (53,53,54): this clears
 *            its lettering and keeps the two sprocket rows.
 *  'plain' = the official Cinema Yellow icon's alpha layout; outermost ring of the opaque
 *            rectangle (128,128,128), interior (53,53,54).
 * Transparent pixels are FF FF FF 00 in both.
 */
export function tileTemplate(decoded: Uint8Array, style: TileStyle): Uint8Array {
  if (style === 'film') {
    const a = readIcon(decoded, NEGA_ICON_OFFSET);
    const c = CONTENT_AREA.film;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const i = (y * ICON_W + x) * 4;
        a[i] = TILE_BG[0];
        a[i + 1] = TILE_BG[1];
        a[i + 2] = TILE_BG[2];
      }
    }
    for (let i = 0; i < ICON_BYTES; i += 4) if (a[i + 3] === 0) setTransparent(a, i);
    return a;
  }
  if (style !== 'plain') throw new FirmwareError('bad-icon', `unknown tile style ${String(style)}`);
  const ref = readIcon(decoded, slotDef('CY').iconOffset);
  let x0 = ICON_W;
  let y0 = ICON_H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < ICON_H; y++) {
    for (let x = 0; x < ICON_W; x++) {
      if (ref[(y * ICON_W + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const a = new Uint8Array(ICON_BYTES);
  for (let y = 0; y < ICON_H; y++) {
    for (let x = 0; x < ICON_W; x++) {
      const i = (y * ICON_W + x) * 4;
      if (ref[i + 3] === 0) {
        setTransparent(a, i);
        continue;
      }
      const ring = x === x0 || x === x1 || y === y0 || y === y1;
      const c = ring ? TILE_BORDER : TILE_BG;
      a[i] = c[0];
      a[i + 1] = c[1];
      a[i + 2] = c[2];
      a[i + 3] = 255;
    }
  }
  return a;
}

/** Round half to even (numpy `round`), for non-negative finite x. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Draw white content on a tile: per pixel `rgb = round(bg + cov * (255 - bg))` with round half to
 * even, where bg is the tile's own colour; alpha comes from the tile. Pixels with tile alpha 0
 * stay FF FF FF 00. `coverage` holds 1600 values in 0..1, row-major.
 */
export function composeIcon(tile: Uint8Array, coverage: Float32Array): Uint8Array {
  checkIcon(tile, 'tile');
  if (coverage.length !== ICON_W * ICON_H) throw new FirmwareError('bad-icon', 'coverage must have 1600 values');
  const out = new Uint8Array(ICON_BYTES);
  for (let p = 0; p < ICON_W * ICON_H; p++) {
    const i = p * 4;
    if (tile[i + 3] === 0) {
      setTransparent(out, i);
      continue;
    }
    let cov = coverage[p];
    if (!(cov > 0)) cov = 0; // also NaN
    if (cov > 1) cov = 1;
    for (let k = 0; k < 3; k++) {
      const bg = tile[i + k];
      out[i + k] = roundHalfEven(bg + cov * (255 - bg));
    }
    out[i + 3] = tile[i + 3];
  }
  return out;
}

/**
 * Force a candidate icon into the official icon's alpha layout: where the official alpha is 0 the
 * pixel becomes FF FF FF 00; elsewhere alpha is 255 and RGB comes from the candidate (a candidate
 * pixel with alpha < 255 is composited over the plain background (53,53,54)).
 */
export function normalizeIcon(officialIcon: Uint8Array, candidate: Uint8Array): Uint8Array {
  checkIcon(officialIcon, 'official icon');
  checkIcon(candidate, 'icon');
  const out = new Uint8Array(ICON_BYTES);
  for (let i = 0; i < ICON_BYTES; i += 4) {
    if (officialIcon[i + 3] === 0) {
      setTransparent(out, i);
      continue;
    }
    const a = candidate[i + 3];
    for (let k = 0; k < 3; k++) {
      // Integer rounding; an exact .5 cannot occur with a divisor of 255.
      out[i + k] = a === 255 ? candidate[i + k] : Math.floor((candidate[i + k] * a + TILE_BG[k] * (255 - a) + 127) / 255);
    }
    out[i + 3] = 255;
  }
  return out;
}
