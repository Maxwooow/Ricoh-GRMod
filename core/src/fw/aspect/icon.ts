// SPDX-License-Identifier: GPL-2.0-only
/**
 * The 60x40 menu icon of an added ratio, drawn in the style of the camera's own ratio icons:
 * a grey-bordered dark tile, a white frame in the shape of the ratio and the ratio written in it.
 * Plain byte arrays (RGBA, row-major); the two small fonts below were drawn for this file.
 */
import { FirmwareError } from '../types';
import { Frac } from './fraction';
import { parseRatio } from './geometry';

export const RATIO_ICON_W = 60;
export const RATIO_ICON_H = 40;
export const RATIO_ICON_BYTES = RATIO_ICON_W * RATIO_ICON_H * 4;

/** Tile rectangle of the factory ratio icons (inclusive), border and background colours. */
const TILE = { x0: 3, y0: 1, x1: 56, y1: 38 };
const BORDER = [128, 128, 128];
const BG = [53, 53, 54];

interface Font { height: number; gap: number; glyphs: Record<string, string[]> }

const BIG: Font = {
  height: 11,
  gap: 1,
  glyphs: {
    '0': ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    '1': ['..##.', '.###.', '####.', '..##.', '..##.', '..##.', '..##.', '..##.', '..##.', '..##.', '#####'],
    '2': ['.#####.', '##...##', '.....##', '.....##', '....##.', '...##..', '..##...', '.##....', '##.....', '##.....', '#######'],
    '3': ['.#####.', '##...##', '.....##', '.....##', '.....##', '..####.', '.....##', '.....##', '.....##', '##...##', '.#####.'],
    '4': ['....##.', '...###.', '..####.', '.##.##.', '##..##.', '##..##.', '#######', '....##.', '....##.', '....##.', '....##.'],
    '5': ['#######', '##.....', '##.....', '##.....', '######.', '.....##', '.....##', '.....##', '.....##', '##...##', '.#####.'],
    '6': ['.#####.', '##...##', '##.....', '##.....', '######.', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    '7': ['#######', '.....##', '.....##', '....##.', '....##.', '...##..', '...##..', '..##...', '..##...', '..##...', '..##...'],
    '8': ['.#####.', '##...##', '##...##', '##...##', '##...##', '.#####.', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    '9': ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '.######', '.....##', '.....##', '##...##', '.#####.'],
    ':': ['..', '..', '..', '##', '##', '..', '..', '##', '##', '..', '..'],
    '.': ['..', '..', '..', '..', '..', '..', '..', '..', '..', '##', '##'],
  },
};

const SMALL: Font = {
  height: 7,
  gap: 1,
  glyphs: {
    '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    '1': ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '...#.', '..#..', '..#..', '..#..'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
    ':': ['.', '.', '#', '.', '#', '.', '.'],
    '.': ['.', '.', '.', '.', '.', '.', '#'],
  },
};

function textWidth(font: Font, text: string): number {
  let w = 0;
  for (const ch of text) {
    const g = font.glyphs[ch];
    if (!g) throw new FirmwareError('bad-ratio', `no glyph for "${ch}"`);
    w += g[0].length + font.gap;
  }
  return w - font.gap;
}

/**
 * What is written on the icon: the ratio as typed (`2.39` becomes `2.39:1`), shortened to the
 * reduced fraction or to two decimals when it would not fit.
 */
export function ratioLabel(value: string): string {
  const ratio = parseRatio(value);
  const fields = value.trim().split(/[:：/]/).map((f) => f.trim());
  if (fields.length === 1) fields.push('1');
  const tidy = (f: string): string => {
    if (!f.includes('.')) return String(BigInt(f));
    const [whole, fraction] = f.split('.');
    const fr = fraction.replace(/0+$/, '');
    return String(BigInt(whole)) + (fr ? '.' + fr : '');
  };
  const typed = fields.map(tidy).join(':');
  const fits = (s: string): boolean => textWidth(SMALL, s) <= 46;
  if (fits(typed)) return typed;
  const reduced = `${ratio.n}:${ratio.d}`;
  if (fits(reduced)) return reduced;
  const x = ratio.toNumber();
  return (x >= 1 ? `${x.toFixed(2)}:1` : `1:${(1 / x).toFixed(2)}`).replace(/\.?0+(?=:|$)/g, (m) => (m.startsWith('.') ? '' : m));
}

/** Draw the icon for a ratio. `value` is the ratio as the user wrote it. */
export function drawRatioIcon(value: string): Uint8Array {
  const ratio: Frac = parseRatio(value);
  const label = ratioLabel(value);
  const px = new Uint8Array(RATIO_ICON_BYTES);
  const put = (x: number, y: number, c: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= RATIO_ICON_W || y >= RATIO_ICON_H) return;
    const i = (y * RATIO_ICON_W + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };
  for (let i = 0; i < RATIO_ICON_BYTES; i += 4) {
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = 0;
  }
  for (let y = TILE.y0; y <= TILE.y1; y++) {
    for (let x = TILE.x0; x <= TILE.x1; x++) {
      put(x, y, x === TILE.x0 || x === TILE.x1 || y === TILE.y0 || y === TILE.y1 ? BORDER : BG);
    }
  }
  const WHITE = [255, 255, 255];
  const r = ratio.toNumber();
  const frame = (maxW: number, maxH: number): [number, number] => {
    let w = Math.round(maxH * r);
    let h = maxH;
    if (w > maxW) {
      w = maxW;
      h = Math.round(maxW / r);
    }
    return [Math.max(6, w), Math.max(6, h)];
  };
  const drawFrame = (w: number, h: number, cy: number): [number, number] => {
    const left = Math.floor((RATIO_ICON_W - w) / 2);
    const top = cy - Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) put(left + x, top + y, WHITE);
      }
    }
    return [left, top];
  };
  const drawText = (font: Font, cx2: number, top: number): void => {
    // cx2 = twice the centre x, so that odd widths centre on the half pixel like even ones.
    let x = Math.floor((cx2 - textWidth(font, label)) / 2);
    for (const ch of label) {
      const g = font.glyphs[ch];
      for (let gy = 0; gy < g.length; gy++) for (let gx = 0; gx < g[gy].length; gx++) if (g[gy][gx] === '#') put(x + gx, top + gy, WHITE);
      x += g[0].length + font.gap;
    }
  };

  let [fw, fh] = frame(48, 30);
  const inside = (font: Font): boolean => textWidth(font, label) <= fw - 8 && font.height <= fh - 8;
  if (inside(BIG) || inside(SMALL)) {
    const font = inside(BIG) ? BIG : SMALL;
    drawFrame(fw, fh, 20);
    drawText(font, RATIO_ICON_W, 20 - Math.floor(font.height / 2));
  } else {
    // Too narrow or too flat for the text: a smaller frame on top, the ratio underneath.
    [fw, fh] = frame(48, 19);
    drawFrame(fw, fh, 14);
    drawText(SMALL, RATIO_ICON_W, 28);
  }
  return px;
}
