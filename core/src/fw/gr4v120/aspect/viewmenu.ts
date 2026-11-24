// SPDX-License-Identifier: GPL-2.0-only
/**
 * Live-view settings in the camera menu (GR IV 1.20 / 1.21; test 084), and the names of the two
 * Flash Modes that flash TTL meters.
 *
 *  - The shade of the added ratios (`shade.ts`) is chosen in the camera: a line of the still
 *    shooting menu after Aspect Ratio, "Matte Brightness", opening a list Black / 75% / 50% /
 *    25% / 0% (how dark the part outside the photo is drawn; 75 % by default). Built with every
 *    added ratio; without one there is neither the shade nor the line.
 *     * Kept in bits 3..5 of byte 0x109 of the user settings (Direct Flash's fastest shutter speed
 *       keeps bits 0..2 of that padding byte, see `directflash.ts`, and reads only those): 0 (what
 *       the byte is on every camera and after a reset) is 75 %, 1 black, 2 50 %, 3 25 %, 4 none;
 *       5..7 count as 75 %.
 *     * Colours: black is UI palette colour 1 (0xFF000000), 50 % colour 16 (0x80000000). The
 *       palette (48 ARGB words at 0x540781EC, read by the 32-bit rectangle fill through
 *       0x539262FC: `ldr r0, [palette, index, lsl #2]`, the index a byte the caller gives) has no
 *       black at 75 % or 25 %; the lookup reads a copy of 256 words instead (the first 48 the
 *       palette, the rest what follows it in the image, as before), with 0xC0000000 at 0xF0 and
 *       0x40000000 at 0xF1.
 *  - The custom grid lines (`grid.ts`) are values of their own in the camera's Grid Style list
 *    (SelectMenuController record 93: count 0x531D0CE0, draw 0x531D36CC, set 0x531D53D8, is current
 *    0x531D6E08; the style is byte 0x8D9 of the settings object, 0 3x3, 1 4x4, through the values
 *    table 0x53DE5658), after the camera's 3x3 and 4x4: "Custom 3x3 Grid" when the custom 3x3
 *    lines are not the camera's, "Custom 4x4 Grid" likewise. Picking one sets the camera's style and
 *    bit 6 of byte 0x109; picking a camera value clears it. The Grid Style line of the setup menu
 *    (0x531B3070) shows the custom value's icon.
 *  - Flash TTL (`flttl.ts`): texts 135 and 137, the Flash Modes "Flash On+Red-eye" and "Slow
 *    Sync+Red-eye" (menus, ADJ lever, Fn list), get " (TTL)" in every language ("（TTL）" in
 *    Japanese and Chinese).
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z, widenTextRows } from './build';
import { LIST_CONTROLLER_ID, LIST_SET_ITEM, StillLine, TOP_SET_TITLE, addListRecords, hookControllerFactory, installTexts, listTemplate } from './datestamp-menu';
import { DIRECT_FLASH_TV_BYTE } from './directflash';
import type { CustomGrid, GridSelect } from './grid';
import type { FramingGuides } from './framing';
import { drawFramingIcon, framingValues } from './framing';
import { CAMERA_GRID } from './grid';
import type { ShadeSetting } from './shade';
import { adr } from '../target';

/** The setting byte (byte 0x109 of the user settings): bits 0..2 Direct Flash's, 3..5 the shade, 6 the custom grid. */
export const VIEW_BYTE = DIRECT_FLASH_TV_BYTE;
export const SHADE_SHIFT = 3;
export const SHADE_MASK = 7;
export const GRID_CUSTOM_BIT = 0x40;
/** Added UI palette colours: black at 75 % and at 25 %. */
export const PALETTE_BLACK_75 = 0xf0;
export const PALETTE_BLACK_25 = 0xf1;
/** The list in menu order: the stored code and the palette colour (0: no shade). */
export const SHADE_LEVELS: readonly { code: number; colour: number; name: string }[] = [
  { code: 1, colour: 1, name: 'black' },
  { code: 0, colour: PALETTE_BLACK_75, name: '75%' },
  { code: 2, colour: 16, name: '50%' },
  { code: 3, colour: PALETTE_BLACK_25, name: '25%' },
  { code: 4, colour: 0, name: '0%' },
];
/** What `shade.ts` draws by the setting: colour per stored code (5..7 as 0, 75 %). */
export const SHADE_SETTING: ShadeSetting = {
  byte: VIEW_BYTE,
  shift: SHADE_SHIFT,
  mask: SHADE_MASK,
  colours: Array.from({ length: SHADE_MASK + 1 }, (_, code) => (SHADE_LEVELS.find((l) => l.code === code) ?? SHADE_LEVELS[1]).colour),
};
export const GRID_SELECT: GridSelect = { byte: VIEW_BYTE, bit: GRID_CUSTOM_BIT };

export const SHADE_LIST_ID = 0x020001d3;
/** Aspect Ratio, the line the shade's line follows. */
export const ASPECT_RATIO_ID = 0x0200008a;
export const VIEW_TEXT_IDS = { custom3: 1030, custom4: 1031, shade: 1032, black: 1033, p75: 1034, p50: 1035, p25: 1036, p0: 1037 } as const;
export const GRID_ICON_IDS = { custom3: 1120, custom4: 1121 } as const;
export const SHADE_ICON_IDS = [1122, 1123, 1124, 1125, 1126] as const;
/** The Flash Modes flash TTL meters: Flash On+Red-eye, Slow Sync+Red-eye. */
export const TTL_FLASH_TEXTS = [135, 137] as const;

const PALETTE = adr(0x540781ec);
const PALETTE_LOOKUP = adr(0x539262fc);
const PALETTE_WORDS = 48;

const APP = adr(0x532406a4);
const SETTINGS = adr(0x53240c38);
const TOP_SET_ICON = adr(0x5359d6f4); // (menu line, icon)
const SELECT_TABLE = adr(0x53dcd470);
const SELECT_RECORD = 0x4c;
const GRID_RECORD = SELECT_TABLE + 93 * SELECT_RECORD;
const GRID_SLOTS = { count: [0x0c, adr(0x531d0ce0)], draw: [0x14, adr(0x531d36cc)], set: [0x24, adr(0x531d53d8)], current: [0x2c, adr(0x531d6e08)] } as const;
const GRID_TITLE = 558;
const GRID_GET = adr(0x532a04f4); // (settings) -> style
const GRID_VALUES = adr(0x53de5658); // {0, 1}
const GRID_ICON = adr(0x53391238); // (resources, style, variant) -> icon
/** The Grid Style line of the setup menu: its call of GRID_ICON for the current style. */
const GRID_LINE_ICON_CALL = adr(0x531b3080);
const GRID_LIST_ICON_CALL = adr(0x531d3704);

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const CUSTOM_GRID_NAMES: Readonly<Record<'custom3' | 'custom4', readonly string[]>> = {
  custom3: [
    'Vlastní mřížka 3x3', 'Eget 3x3 gitter', 'Custom 3x3 Grid', 'Oma 3x3 ruudukko', 'Grille 3x3 perso', 'Eigenes 3x3 Gitter', 'Δικό σας πλέγμα 3x3',
    'Egyéni 3x3-as rács', 'Griglia 3x3 pers.', 'カスタム9分割', '사용자 9분할', 'Eigen raster 3 x 3', 'Własna siatka 3x3', 'Grelha 3x3 pers.',
    'Своя сетка 3х3', '自定义9网格', 'Cuadrícula 3x3 pers.', 'Eget rutnät 3x3', '3x3 กริดกำหนดเอง', '自訂9網格', 'Özel 3x3 Izgara',
  ],
  custom4: [
    'Vlastní mřížka 4x4', 'Eget 4x4 gitter', 'Custom 4x4 Grid', 'Oma 4x4 ruudukko', 'Grille 4x4 perso', 'Eigenes 4x4 Gitter', 'Δικό σας πλέγμα 4x4',
    'Egyéni 4x4-es rács', 'Griglia 4x4 pers.', 'カスタム16分割', '사용자 16분할', 'Eigen raster 4 x 4', 'Własna siatka 4x4', 'Grelha 4x4 pers.',
    'Своя сетка 4х4', '自定义16网格', 'Cuadrícula 4x4 pers.', 'Eget rutnät 4x4', '4x4 กริดกำหนดเอง', '自訂16網格', 'Özel 4x4 Izgara',
  ],
};
/**
 * The framing guides' presets (`framing.ts`) in the Grid Style list: "Custom Grid 1" in the place of the camera's
 * 3x3, "Custom Grid 2" in the place of its 4x4 (the same words as the names above, without the size).
 */
export const FRAMING_GRID_NAMES: Readonly<Record<'custom3' | 'custom4', readonly string[]>> = {
  custom3: [
    'Vlastní mřížka 1', 'Eget gitter 1', 'Custom Grid 1', 'Oma ruudukko 1', 'Grille perso 1', 'Eigenes Gitter 1', 'Δικό σας πλέγμα 1',
    'Egyéni rács 1', 'Griglia pers. 1', 'カスタム分割1', '사용자 분할 1', 'Eigen raster 1', 'Własna siatka 1', 'Grelha pers. 1',
    'Своя сетка 1', '自定义网格1', 'Cuadrícula pers. 1', 'Eget rutnät 1', 'กริดกำหนดเอง 1', '自定義網格1', 'Özel Izgara 1',
  ],
  custom4: [
    'Vlastní mřížka 2', 'Eget gitter 2', 'Custom Grid 2', 'Oma ruudukko 2', 'Grille perso 2', 'Eigenes Gitter 2', 'Δικό σας πλέγμα 2',
    'Egyéni rács 2', 'Griglia pers. 2', 'カスタム分割2', '사용자 분할 2', 'Eigen raster 2', 'Własna siatka 2', 'Grelha pers. 2',
    'Своя сетка 2', '自定义网格2', 'Cuadrícula pers. 2', 'Eget rutnät 2', 'กริดกำหนดเอง 2', '自定義網格2', 'Özel Izgara 2',
  ],
};
export const SHADE_NAMES: readonly string[] = [
  'Jas masky', 'Maskens lysstyrke', 'Matte Brightness', 'Maskin kirkkaus', 'Luminosité du cache', 'Maskenhelligkeit',
  'Φωτεινότητα μάσκας', 'Maszk fényereje', 'Luminosità maschera', 'マスクの明るさ', '마스크 밝기', 'Helderheid masker',
  'Jasność maski', 'Brilho da máscara', 'Яркость маски', '遮幅亮度', 'Brillo de máscara', 'Maskens ljusstyrka',
  'ความสว่างมาสก์', '遮幅亮度', 'Maske parlaklığı',
];
export const SHADE_BLACK_NAMES: readonly string[] = [
  'Černá', 'Sort', 'Black', 'Musta', 'Noir', 'Schwarz', 'Μαύρο', 'Fekete', 'Nero', '黒', '검정', 'Zwart', 'Czarny', 'Preto',
  'Чёрный', '全黑', 'Negro', 'Svart', 'ดำ', '全黑', 'Siyah',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;
const same = (text: string): string[] => Array(LANGUAGES).fill(text) as string[];

/** The custom styles that are values of their own: lines that are not the camera's. */
export function customGridValues(grid: CustomGrid): ('custom3' | 'custom4')[] {
  const differs = (s: 'g3' | 'g4'): boolean => grid[s].some((v, i) => v !== CAMERA_GRID[s][i]);
  return [...(differs('g3') ? ['custom3' as const] : []), ...(differs('g4') ? ['custom4' as const] : [])];
}

// --------------------------------------------------------------------------------------------
// Icons

/** Blend `grey` over pixel (x, y) of a w-wide RGBA image with coverage a. */
function blend(px: Uint8Array, w: number, x: number, y: number, a: number, grey: number): void {
  if (a <= 0) return;
  const i = (y * w + x) * 4;
  for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] + (grey - px[i + c]) * Math.min(1, a));
}

/** 4x4 supersampled coverage of `inside` over the pixels of (x0, y0)..(x1, y1). */
function paint(px: Uint8Array, w: number, box: readonly [number, number, number, number], inside: (x: number, y: number) => boolean, grey = 255): void {
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let sum = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) sum += inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) ? 1 : 0;
      blend(px, w, x, y, sum / 16, grey);
    }
  }
}

/** A tile as the camera's: transparent edge, grey border, dark inside. */
function tile(w: number, h: number, inset: readonly [number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  const [ix, iy] = inset;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < ix || y < iy || x >= w - ix || y >= h - iy) px.set([255, 255, 255, 0], i);
      else if (x === ix || y === iy || x === w - ix - 1 || y === h - iy - 1) px.set([128, 128, 128, 255], i);
      else px.set([53, 53, 54, 255], i);
    }
  }
  return px;
}

/**
 * A Grid Style value's icon, 60x40 as the camera's 3x3 / 4x4 (icons 367 / 366): the frame and the
 * custom lines of the style, 2 pixels wide, at the places the camera's icons have them.
 */
export function drawGridIcon(lines: readonly boolean[], divisions: 3 | 4): Uint8Array {
  const W = 60;
  const px = tile(W, 40, [3, 1]);
  // White frame (2 px) inside: x 5..54, y 3..36; the lines' area x 7..52 (46), y 5..34 (30).
  const rect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) blend(px, W, x, y, 1, 255);
  };
  rect(5, 3, 55, 5);
  rect(5, 35, 55, 37);
  rect(5, 3, 7, 37);
  rect(53, 3, 55, 37);
  const X0 = 7, LW = 46, Y0 = 5, LH = 30;
  const at = (o: number, len: number, k: number, n: number): number => o + Math.round((k * (len + 2)) / n) - 2;
  const places: readonly (readonly [boolean, number, number])[] = divisions === 3
    ? [[false, 1, 3], [false, 1, 2], [false, 2, 3], [true, 1, 3], [true, 1, 2], [true, 2, 3]]
    : [[false, 1, 4], [false, 2, 4], [false, 3, 4], [true, 1, 4], [true, 2, 4], [true, 3, 4]];
  places.forEach(([vertical, k, n], i) => {
    if (!lines[i]) return;
    if (vertical) {
      const x = at(X0, LW, k, n);
      rect(x, Y0, x + 2, Y0 + LH);
    } else {
      const y = at(Y0, LH, k, n);
      rect(X0, y, X0 + LW, y + 2);
    }
  });
  // Diagonals: corner to corner of the lines' area, about 2 px wide.
  for (const d of [0, 1]) {
    if (!lines[6 + d]) continue;
    const [ax, ay, bx, by] = d === 0 ? [X0, Y0, X0 + LW, Y0 + LH] : [X0, Y0 + LH, X0 + LW, Y0];
    const len = Math.hypot(bx - ax, by - ay);
    paint(px, W, [X0, Y0, X0 + LW, Y0 + LH], (x, y) => Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / len <= 1.1);
  }
  return px;
}

/**
 * A shade level's icon, 40x40 on the camera's tile: the 3:2 frame with a wide window (the photo)
 * light and the bands above and below it darkened by `opacity` (1 black, 0 as light as the window).
 */
export function drawShadeIcon(opacity: number): Uint8Array {
  const W = 40;
  const px = tile(W, W, [1, 1]);
  const light = 200, dark = 53;
  const band = Math.round(light + (dark - light) * opacity);
  // Frame x 5..34 (30), y 10..29 (20); window y 15..24.
  for (let y = 10; y < 30; y++) for (let x = 5; x < 35; x++) blend(px, W, x, y, 1, y >= 15 && y < 25 ? light : band);
  // The frame's outline (grey) and the window's edges (white).
  for (let x = 5; x < 35; x++) for (const y of [10, 29]) blend(px, W, x, y, 1, 128);
  for (let y = 10; y < 30; y++) for (const x of [5, 34]) blend(px, W, x, y, 1, 128);
  for (let x = 5; x < 35; x++) for (const y of [15, 24]) blend(px, W, x, y, 1, 255);
  return px;
}

function addIcons(patch: Patch, iconbin: Uint8Array, icons: readonly { id: number; w: number; h: number; px: Uint8Array }[]): Uint8Array {
  if (icons.length === 0) return iconbin;
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  for (const { id, w, h, px } of icons) {
    if (px.length !== w * h * 4) fail('internal', 'icon size');
    if (patch.word(ICON_CATALOG + id * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const offset = length;
    parts.push(px);
    length += px.length;
    // {u16 kind = 1, u16 width, u16 height, u16 flags = 0, u32 offset in 4-byte units}
    const descriptor = patch.append(concat([u16le([1, w, h, 0]), u32le([offset / 4])]), 16);
    patch.write(ICON_CATALOG + id * 4, u32le([descriptor]));
  }
  const upper = Math.max(...icons.map((x) => x.id));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(upper, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat(parts);
}

export interface ViewMenuOptions {
  /** The custom grid lines (values of their own in the Grid Style list). */
  grid?: CustomGrid;
  /** The framing guides' presets instead (values of their own in the Grid Style list). */
  framing?: FramingGuides;
  /** The shade of the added ratios (its line in the still menu). */
  shade?: boolean;
}

/** Texts and icons (call once, before the menus use them). Returns ICONBIN with the icons appended. */
export function installViewAssets(patch: Patch, iconbin: Uint8Array, o: ViewMenuOptions): Uint8Array {
  const grid = o.grid;
  const framing = o.framing;
  if (grid && framing) fail('internal', 'custom grid lines and framing guides together');
  const grids = grid ? customGridValues(grid) : framing ? framingValues(framing) : [];
  const texts: { id: number; names: readonly string[] }[] = grids.map((g) => ({ id: VIEW_TEXT_IDS[g], names: (framing ? FRAMING_GRID_NAMES : CUSTOM_GRID_NAMES)[g] }));
  const icons: { id: number; w: number; h: number; px: Uint8Array }[] = grid
    ? grids.map((g) => ({ id: GRID_ICON_IDS[g], w: 60, h: 40, px: drawGridIcon(g === 'custom3' ? grid.g3 : grid.g4, g === 'custom3' ? 3 : 4) }))
    : framing ? grids.map((g) => ({ id: GRID_ICON_IDS[g], w: 60, h: 40, px: drawFramingIcon(framing, g === 'custom3' ? 0 : 1) })) : [];
  if (o.shade) {
    texts.push(
      { id: VIEW_TEXT_IDS.shade, names: SHADE_NAMES },
      { id: VIEW_TEXT_IDS.black, names: SHADE_BLACK_NAMES },
      { id: VIEW_TEXT_IDS.p75, names: same('75%') },
      { id: VIEW_TEXT_IDS.p50, names: same('50%') },
      { id: VIEW_TEXT_IDS.p25, names: same('25%') },
      { id: VIEW_TEXT_IDS.p0, names: same('0%') },
    );
    [1, 0.75, 0.5, 0.25, 0].forEach((opacity, k) => icons.push({ id: SHADE_ICON_IDS[k], w: 40, h: 40, px: drawShadeIcon(opacity) }));
  }
  if (texts.length) {
    widenTextRows(patch, Math.max(...texts.map((t) => t.id)));
    installTexts(patch, texts);
  }
  return addIcons(patch, iconbin, icons);
}

// --------------------------------------------------------------------------------------------
// The shade

/** The UI palette with black at 75 % and 25 %: the lookup of the 32-bit fill reads a copy. */
export function installShadePalette(patch: Patch): void {
  expectWord(patch, PALETTE_LOOKUP, movWord(3, lo(PALETTE)));
  expectWord(patch, PALETTE_LOOKUP + 4, movWord(3, hi(PALETTE), true));
  expectWord(patch, PALETTE_LOOKUP + 8, 0xe7930100); // ldr r0, [r3, r0, lsl #2]
  expectWord(patch, PALETTE + 4, 0xff000000);
  expectWord(patch, PALETTE + 16 * 4, 0x80000000);
  if (PALETTE_BLACK_75 < PALETTE_WORDS || PALETTE_BLACK_25 < PALETTE_WORDS) fail('internal', 'added palette colours inside the palette');
  const words = patch.read(PALETTE, 256 * 4);
  const v = new DataView(words.buffer);
  v.setUint32(PALETTE_BLACK_75 * 4, 0xc0000000, true);
  v.setUint32(PALETTE_BLACK_25 * 4, 0x40000000, true);
  const copy = patch.append(words, 16);
  patch.setWord(PALETTE_LOOKUP, movWord(3, lo(copy)), 'live-view shade: UI palette with more colours, low half');
  patch.setWord(PALETTE_LOOKUP + 4, movWord(3, hi(copy), true), 'live-view shade: UI palette with more colours, high half');
}

/** r3 = the list position of the stored shade (r2 = the byte's address; uses ip). */
const LOAD_SHADE = `movw r2, #${lo(VIEW_BYTE)}; movt r2, #${hi(VIEW_BYTE)}; ldrb r3, [r2]
  mov r3, r3, lsr #${SHADE_SHIFT}; and r3, r3, #${SHADE_MASK}; cmp r3, #4; movhi r3, #0
  ${SHADE_LEVELS.map((l, i) => `cmp r3, #${l.code}; moveq ip, #${i}`).join('\n')}
  mov r3, ip`;

const SHADE_TEXTS = [VIEW_TEXT_IDS.black, VIEW_TEXT_IDS.p75, VIEW_TEXT_IDS.p50, VIEW_TEXT_IDS.p25, VIEW_TEXT_IDS.p0] as const;

/** The still-menu line (before the still menu is built). */
export function shadeStillLine(patch: Patch): StillLine {
  expectWord(patch, TOP_SET_ICON, 0xe1a0c00d);
  expectWord(patch, TOP_SET_TITLE, 0xe1a0c00d);
  const draw = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     ${LOAD_SHADE}
     ${SHADE_ICON_IDS.map((id, i) => `cmp r3, #${i}; movweq r1, #${id}`).join('\n')}
     mov r0, r4; bl #${TOP_SET_ICON}
     mov r0, r4; movw r1, #${VIEW_TEXT_IDS.shade}
     pop {r4, lr}; b #${TOP_SET_TITLE}`, at), 16);
  return { draw, id: SHADE_LIST_ID, after: ASPECT_RATIO_ID };
}

/** The list the line opens (after the additions that copy the list table first). */
export function installShadeList(patch: Patch): void {
  expectWord(patch, LIST_SET_ITEM, 0xe1a0c00d);
  const n = SHADE_LEVELS.length;
  const count = patch.append((at) => assembleWords(`mov r0, #${n}; bx lr`, at), 16);
  // draw (item = r1, i = r2), set and is current (i = r1).
  const draw = patch.append((at) => assembleWords(
    `cmp r2, #${n - 1}; bxhi lr
     mov r0, r1; mov ip, r2
     ${SHADE_LEVELS.map((_, i) => `cmp ip, #${i}; movweq r1, #${SHADE_ICON_IDS[i]}; movweq r2, #${SHADE_TEXTS[i]}`).join('\n')}
     b #${LIST_SET_ITEM}`, at), 16);
  const set = patch.append((at) => assembleWords(
    `cmp r1, #${n - 1}; bxhi lr
     ${SHADE_LEVELS.map((l, i) => `cmp r1, #${i}; moveq r3, #${l.code << SHADE_SHIFT}`).join('\n')}
     movw r2, #${lo(VIEW_BYTE)}; movt r2, #${hi(VIEW_BYTE)}; ldrb ip, [r2]
     bic ip, ip, #${SHADE_MASK << SHADE_SHIFT}; orr ip, ip, r3; strb ip, [r2]; bx lr`, at), 16);
  const current = patch.append((at) => assembleWords(
    `${LOAD_SHADE}
     cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  const r = listTemplate(patch);
  const v = new DataView(r.buffer);
  v.setUint16(4, VIEW_TEXT_IDS.shade, true);
  v.setUint32(0x0c, count, true);
  v.setUint32(0x14, draw, true);
  v.setUint32(0x24, set, true);
  v.setUint32(0x2c, current, true);
  for (const off of [0x10, 0x18, 0x28, 0x30]) v.setUint32(off, 0, true);
  addListRecords(patch, [{ id: SHADE_LIST_ID, record: r }], 'live-view shade');
  hookControllerFactory(patch, `movw ip, #${lo(SHADE_LIST_ID)}; movt ip, #${hi(SHADE_LIST_ID)}
     cmp r1, ip; bne prior
     movw r1, #${lo(LIST_CONTROLLER_ID)}; movt r1, #${hi(LIST_CONTROLLER_ID)}`, 'live-view shade: the list controller');
}

// --------------------------------------------------------------------------------------------
// Grid Style

/**
 * The custom styles as values of the Grid Style list (record 93, in place: before any addition
 * copies the list table) and the setup menu line's icon.
 */
export function installGridStyleMenu(patch: Patch, grid: CustomGrid | readonly ('custom3' | 'custom4')[]): void {
  const values = Array.isArray(grid) ? [...grid] as ('custom3' | 'custom4')[] : customGridValues(grid as CustomGrid);
  if (values.length === 0) fail('internal', 'custom grid: no style of its own');
  if (patch.listRecords !== 0) fail('internal', 'Grid Style list: the list table is already copied');
  for (const [off, fn] of Object.values(GRID_SLOTS)) {
    expectWord(patch, GRID_RECORD + off, fn);
    expectWord(patch, GRID_RECORD + off + 4, 0);
  }
  expectWord(patch, GRID_RECORD + 4, GRID_TITLE);
  expectWord(patch, GRID_SLOTS.count[1], 0xe3a00002); // mov r0, #2
  expectWord(patch, GRID_GET, 0xe5d008d9); // ldrb r0, [r0, #0x8d9]
  if (patch.read(GRID_VALUES, 2).join() !== '0,1') fail('unexpected-layout', 'Grid Style values are not 3x3, 4x4');
  expectWord(patch, GRID_LINE_ICON_CALL, branchWord(GRID_LINE_ICON_CALL, GRID_ICON, 14, true));
  expectWord(patch, GRID_LIST_ICON_CALL, branchWord(GRID_LIST_ICON_CALL, GRID_ICON, 14, true));
  expectWord(patch, GRID_ICON, 0xe3510000); // cmp r1, #0
  expectWord(patch, adr(0x531d372c), branchWord(adr(0x531d372c), LIST_SET_ITEM)); // the draw's tail
  for (const f of [APP, SETTINGS]) expectWord(patch, f, 0xe1a0c00d);
  const style = (v: 'custom3' | 'custom4'): number => (v === 'custom3' ? 0 : 1);

  // r0 = 1 when the current style draws its custom lines (the bit set and the style has a value
  // of its own); r1 = the style. Keeps r4..r11.
  const active = patch.append((at) => assembleWords(
    `push {r4, lr}
     bl #${APP}; bl #${SETTINGS}; bl #${GRID_GET}; mov r1, r0
     movw r0, #${lo(VIEW_BYTE)}; movt r0, #${hi(VIEW_BYTE)}; ldrb r0, [r0]
     ands r0, r0, #${GRID_CUSTOM_BIT}; beq active_done
     cmp r1, #0; mov r0, #${values.includes('custom3') ? 1 : 0}; movne r0, #${values.includes('custom4') ? 1 : 0}
     active_done: pop {r4, pc}`, at), 16);

  const n = 2 + values.length;
  const count = patch.append((at) => assembleWords(`mov r0, #${n}; bx lr`, at), 16);
  // draw (this, row = r1, i = r2): the camera's values as the camera; the custom ones here.
  const draw = patch.append((at) => assembleWords(
    `cmp r2, #2; blo #${GRID_SLOTS.draw[1]}
     cmp r2, #${n - 1}; bxhi lr
     mov r0, r1
     ${values.map((v, k) => `cmp r2, #${2 + k}; movweq r1, #${GRID_ICON_IDS[v]}; movweq r2, #${VIEW_TEXT_IDS[v]}`).join('\n')}
     b #${LIST_SET_ITEM}`, at), 16);
  // set (this, i = r1): the bit, then the camera's own setter with the style.
  const set = patch.append((at) => assembleWords(
    `cmp r1, #${n - 1}; bxhi lr
     movw r2, #${lo(VIEW_BYTE)}; movt r2, #${hi(VIEW_BYTE)}; ldrb r3, [r2]
     cmp r1, #2; biclo r3, r3, #${GRID_CUSTOM_BIT}; orrhs r3, r3, #${GRID_CUSTOM_BIT}; strb r3, [r2]
     ${values.map((v, k) => `cmp r1, #${2 + k}; moveq r1, #${style(v)}`).join('\n')}
     b #${GRID_SLOTS.set[1]}`, at), 16);
  // is current (this, i = r1)
  const current = patch.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r5, r0; mov r4, r1
     bl #${active}; mov r6, r1
     cmp r4, #2; bhs custom
     cmp r0, #0; movne r0, #0; popne {r4, r5, r6, pc}
     mov r0, r5; mov r1, r4; pop {r4, r5, r6, lr}; b #${GRID_SLOTS.current[1]}
     custom: cmp r0, #0; popeq {r4, r5, r6, pc}
     mov r0, #0
     ${values.map((v, k) => `cmp r4, #${2 + k}; bne skip${k}; cmp r6, #${style(v)}; moveq r0, #1; skip${k}:`).join('\n')}
     pop {r4, r5, r6, pc}`, at), 16);
  const handlers: Record<keyof typeof GRID_SLOTS, number> = { count, draw, set, current };
  for (const name of Object.keys(GRID_SLOTS) as (keyof typeof GRID_SLOTS)[]) {
    patch.setWord(GRID_RECORD + GRID_SLOTS[name][0], handlers[name], `custom grid: Grid Style list, ${name}`);
  }

  // The setup menu line (resources r0, style r1, variant r2): the custom value's icon.
  const lineIcon = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r4, r5, lr}
     mov r5, r2
     bl #${active}
     cmp r0, #0; beq native
     cmp r5, #0; bne native
     add sp, sp, #12
     cmp r1, #0
     ${values.includes('custom3') ? `movweq r0, #${GRID_ICON_IDS.custom3}` : ''}
     ${values.includes('custom4') ? `movwne r0, #${GRID_ICON_IDS.custom4}` : ''}
     pop {r4, r5, pc}
     native: pop {r0, r1, r2, r4, r5, lr}; b #${GRID_ICON}`, at), 16);
  patch.setWord(GRID_LINE_ICON_CALL, branchWord(GRID_LINE_ICON_CALL, lineIcon, 14, true), 'custom grid: Grid Style line icon');
}

// --------------------------------------------------------------------------------------------
// Flash TTL

function readText(patch: Patch, descriptor: number): string {
  const head = patch.readMapped(descriptor, 8);
  const units = head[0];
  const address = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
  const raw = patch.readMapped(address, units * 2);
  let s = '';
  for (let i = 0; i < units; i++) {
    const c = raw[i * 2] | (raw[i * 2 + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** The names of the Flash Modes flash TTL meters, with "(TTL)" in every language. */
export function installTtlFlashNames(patch: Patch): void {
  // Row 1 of the program's language rows is English.
  const english = TTL_FLASH_TEXTS.map((id) => readText(patch, patch.word(patch.word(TEXT_CATALOG + 4) + id * 4)));
  if (english.join('|') !== 'Flash On+Red-eye|Slow Sync+Red-eye') fail('unexpected-layout', 'flash mode texts are not the red-eye ones');
  for (const id of TTL_FLASH_TEXTS) {
    for (let l = 0; l < LANGUAGES; l++) {
      const row = patch.word(TEXT_CATALOG + l * 4);
      const old = patch.word(row + id * 4);
      if (old === 0) fail('unexpected-layout', 'flash mode text is missing');
      const text = readText(patch, old);
      const name = /[぀-ヿ一-鿿]/.test(text) ? `${text}（TTL）` : `${text} (TTL)`;
      const encoded = utf16z(name);
      if (encoded.length / 2 >= 256) fail('internal', 'flash mode text too long');
      const address = patch.append(encoded, 4);
      const descriptor = patch.append(concat([Uint8Array.from([encoded.length / 2, 1, 0, 0]), u32le([address])]), 4);
      patch.write(row + id * 4, u32le([descriptor]));
    }
  }
}
