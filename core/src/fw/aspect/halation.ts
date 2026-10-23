// SPDX-License-Identifier: GPL-2.0-only
/**
 * Halation for the added Image Control slots and for Cinema Yellow / Green with a preset: the light
 * of the highlights spread around them in a warm red, as on film without an anti-halation layer
 * (CineStill 800T and the like).
 *
 * In the camera the level is chosen per look on the parameter screen: the slider of Cinema's
 * "Toning" (parameter 8, values 0..2) becomes "Halation" with Off / Weak / Strong. Toning does
 * nothing for those looks: an added slot's curves, and the curves of a Cinema slot with a preset,
 * apply as they are (gamma descriptor byte 5 is 0). Its value travels with the other parameters
 * (own values per slot and set, the frame's record at +0x7A6, RAW development, the maker note).
 * GR Mod chooses per look whether it has halation.
 *
 * The effect is applied to the finished pictures, before they are compressed: the module of
 * `tools/halation/halation.c` runs at the start of JpegEncodeMacroProcess::Execute (0x537034B4),
 * before the date imprint when that is installed. Which look and level the picture has is left in
 * a word by the development step that reads the frame's record (0x539113F8, see `lookstash.ts`).
 * The look of the glow is fixed (`HALATION`, fitted to CineStill 800T).
 *
 * Not shown: live view (the effect is only in the JPEG, and in the camera's playback of it). RAW
 * files are not changed; a JPEG developed from one in the camera has the effect.
 *
 * GR Mod 0.8.2 (context 'HAL3'): the light starts softly. Up to 0.8.1 it rose in a straight line
 * from a fixed level (235 of 255 as Standard renders it), so a lamp that brightened a little made
 * the glow pop in, with a hard edge where the spread light ended. Now each look has a table: the
 * value is taken back through the look to the level Standard would give it, to linear light, and
 * the light is the square of how far that is above `start`, up to the look's white.
 */
import { FirmwareError } from '../types';
import { assembleWords, branchTarget, movImmediate } from './arm';
import { Patch, concat, u16le, u32le } from './build';
import { HALATION_CODE, HALATION_CODE_LENGTH } from './halation-code';

/**
 * The look of the glow, the same for every look that has it: fitted to CineStill 800T pictures
 * (night street lamps, platform tubes, LED boards): a saturated red fringe close to the light and a
 * wider, fainter red glow; orange near strong light; white highlights stay white. Only light near
 * clipping spreads, so a daylight picture shows it on lamps and specular highlights only.
 */
export const HALATION = {
  /** Level (of 255, as Standard renders grey) where light starts; it rises with the square of linear light above it, to 1 at white. */
  start: 220,
  /** Least Standard levels from where light starts to where the look reaches its white. */
  minRange: 35,
  /** Box radius of the narrow and the wide spread, as a fraction of the picture's width (three box passes each way: about a gaussian of this sigma). */
  narrow: 0.0035,
  wide: 0.012,
  /** Share of the narrow spread. */
  mix: 0.6,
  /**
   * The camera's Weak, Medium and Strong: how strongly the spread light lifts the colours. 0.8.2:
   * Weak as test 036's "weak" Weak, Strong as its "normal" Weak (chosen on the camera), Medium
   * between; up to 0.8.1 Weak was 25, Strong 60 (with the harder start).
   */
  gain: [12, 18, 24] as const,
  /** Lift of red, green and blue per unit of light (red first: the red layer is exposed again from behind, a little the green). */
  channels: [1, 0.06, 0.03] as const,
  /** White (0.8.2, chosen on the camera): every channel lifted alike, a soft white bloom like the GR IV HDF's highlight diffusion. */
  white: [0.6, 0.6, 0.6] as const,
};

/** Colour of the glow: red (film halation) or white (highlight diffusion). */
export type HalationColour = 'red' | 'white';


/** JpegEncodeMacroProcess::Execute. */
const JPEG_EXECUTE = 0x537034b4;
const CACHE = 0x538f0448;
const CACHE_FLUSH_FOR_READ = 0x538f04d8;
const CACHE_CLEAN = 0x538f04c4;
const HEAP_ALLOC = 0x538e09b0;
const HEAP_FREE = 0x538e09ec;
const LUT_N = 4096;
const PARAM_BYTES = 16;
const E_MAX = 16384;
/** Looks the module knows (style numbers below this). */
export const HALATION_LOOKS = 64;
/**
 * Marks the context so that a built file can be read back: 'HAL4' (0.8.2: three levels, entries of
 * 4 gains and the light table); 'HAL3' (0.8.2 tests 036..042: two levels); 'HAL2' (0.7.3..0.8.1) and
 * 'HALO' (0.7.2) for added slots only.
 */
const CTX_MAGIC = 0x344c4148; // 'HAL4'
const CTX_MAGIC_TEST = 0x334c4148; // 'HAL3'
const CTX_MAGIC_081 = 0x324c4148; // 'HAL2'
const CTX_MAGIC_072 = 0x4f4c4148; // 'HALO'
/** Words of the context before its parameters (see `struct ctx`); the magic follows the parameters, the look map the magic. */
const CTX_WORDS = 10;
const MAGIC_AT = CTX_WORDS * 4 + PARAM_BYTES;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** struct params in halation.c. */
export function paramBytes(): Uint8Array {
  const out = new Uint8Array(PARAM_BYTES);
  const v = new DataView(out.buffer);
  const H = HALATION;
  v.setUint16(0, Math.round(H.narrow * 4096), true);
  v.setUint16(2, Math.round(H.wide * 4096), true);
  v.setUint16(4, Math.round(H.mix * 256), true);
  return out;
}

/** The camera's levels: 1 Weak, 2 Medium, 3 Strong. */
export type HalationLevel = 1 | 2 | 3;

/** The module's gains (table index = light * gain >> 10) of the camera's Weak, Medium and Strong. */
export function halationGains(): [number, number, number] {
  return [Math.round(HALATION.gain[0] * 4), Math.round(HALATION.gain[1] * 4), Math.round(HALATION.gain[2] * 4)];
}

/** A look's light: 256 values (0..16384), for the brighter of Y and red of a pixel. */
export interface HalationLight { table: Uint16Array }

const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * A look's light. Grey goes through the look's matrix unchanged (its rows sum to 1), so its look
 * on grey is its tone curves (256 values, 0..16383, for display input i * 64 / 16383) and the
 * post-curve matrix (Q9); measured as the module does (the brighter of Y and red). A value is taken
 * back to the level Standard gives the same grey; the look's white (and anything above) is full
 * light. Without curves: Standard's own levels.
 */
export function halationLight(curves?: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>], postQ9?: ArrayLike<number>): HalationLight {
  const level = (v: number): number => {
    if (!curves) return v;
    const x = (v / 255) * (16383 / 64);
    // the table ends at input 255 * 64 / 16383: white continues the last step
    const i = Math.min(254, Math.floor(x)), f = x - i;
    let o = curves.map((c) => Math.min(16383, c[i] + (c[i + 1] - c[i]) * f) / 16383);
    if (postQ9) o = [0, 1, 2].map((r) => (postQ9[r * 3] * o[0] + postQ9[r * 3 + 1] * o[1] + postQ9[r * 3 + 2] * o[2]) / 512);
    const [R, G, B] = o.map((c) => (c < 0 ? 0 : c > 1 ? 1 : c) * 255);
    return Math.max(R, 0.299 * R + 0.587 * G + 0.114 * B);
  };
  // What the look gives each Standard level (kept rising), then back from a value to a level.
  const out: number[] = [];
  let top = 0;
  for (let d = 0; d <= 255; d++) out.push((top = Math.max(top, level(d))));
  const white = out[255];
  // The Standard level where the look reaches its white; light rises from `start` to there (from
  // `minRange` below it when the look clips early, so that the light still fades in).
  let dw = 255;
  while (dw > 0 && out[dw - 1] >= white - 0.5) dw--;
  const L0 = linear(Math.min(HALATION.start, dw - HALATION.minRange) / 255);
  const Lw = linear(dw / 255);
  const table = new Uint16Array(256);
  let d = 0;
  for (let v = 0; v < 256; v++) {
    if (v >= white - 0.5) { table[v] = E_MAX; continue; }
    while (d < 255 && out[d + 1] <= v) d++;
    // between Standard levels d and d + 1
    const a = out[d], b = d < 255 ? out[d + 1] : a;
    const lv = b > a ? d + Math.min(1, Math.max(0, (v - a) / (b - a))) : d;
    const t = (linear(lv / 255) - L0) / (Lw - L0);
    table[v] = t <= 0 ? 0 : Math.min(E_MAX, Math.round(E_MAX * Math.min(1, t) * Math.min(1, t)));
  }
  return { table };
}

/** Without a look (the camera's Standard). */
export const PLAIN_LIGHT: HalationLight = halationLight();

const lutCache: Partial<Record<HalationColour, Uint8Array>> = {};
/** The table of halation.c: lift of red, green, blue (of 255) for light index i (i / 64 units). */
export function halationLut(colour: HalationColour = 'red'): Uint8Array {
  const cached = lutCache[colour];
  if (cached) return cached;
  const out = new Uint8Array(3 * LUT_N);
  (colour === 'white' ? HALATION.white : HALATION.channels).forEach((wc, c) => {
    for (let i = 0; i < LUT_N; i++) out[c * LUT_N + i] = Math.round(255 * (1 - Math.exp(-(i / 64) * wc)));
  });
  lutCache[colour] = out;
  return out;
}

export function halationModule(): Uint8Array {
  const raw = Uint8Array.from(atob(HALATION_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== HALATION_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'halation module length');
  return raw;
}

/** A look with halation: its style number and its light. */
export interface HalationLook { style: number; light: HalationLight }

/**
 * Install the module at the JPEG encode step for `looks`; `stash` is the word the development
 * step writes. Chains to the date imprint when that is installed (it runs after the halation).
 */
export function installHalationModule(p: Patch, looks: readonly HalationLook[], stash: number): void {
  if (looks.length < 1 || looks.length > HALATION_LOOKS) fail('internal', 'halation: number of looks');
  const map = new Uint8Array(HALATION_LOOKS);
  const entries: Uint8Array[] = [];
  looks.forEach((l, k) => {
    if (!(Number.isInteger(l.style) && l.style >= 0 && l.style < HALATION_LOOKS) || map[l.style]) fail('internal', 'halation: style of a look');
    if (!(l.light.table instanceof Uint16Array) || l.light.table.length !== 256 || l.light.table.some((v) => v > E_MAX)) fail('internal', 'halation: light of a look');
    map[l.style] = k + 1;
    entries.push(u16le([...halationGains(), 0, ...l.light.table]));
  });
  const first = p.word(JPEG_EXECUTE);
  let tail: string;
  if (first === 0xe1a0c00d) tail = `mov ip,sp;b #${JPEG_EXECUTE + 4}`;
  else if (first >>> 24 === 0xea) tail = `b #${branchTarget(JPEG_EXECUTE, first)}`;
  else fail('unexpected-layout', 'halation: unexpected JPEG encode entry');
  // Red (three channels), then the white glow's table (one, the same for every channel).
  const lut = p.append(concat([halationLut('red'), halationLut('white').subarray(0, LUT_N)]), 16);
  const table = p.append(new Uint8Array(entries.flatMap((e) => [...e])), 16);
  const ctx = p.append(new Uint8Array([
    ...u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, HEAP_ALLOC, HEAP_FREE, stash, lut, table, looks.length, 0]),
    ...paramBytes(),
    ...u32le([CTX_MAGIC]),
    ...map,
  ]), 16);
  const code = p.append(halationModule(), 16);
  const stub = p.append((at) => assembleWords(
    `push {r0-r3,ip,lr}
     ldr r1,[r1,#8]
     movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}
     bl #${code}
     pop {r0-r3,ip,lr}
     ${tail}`, at), 16);
  p.setWord(JPEG_EXECUTE, (0xea000000 | (((stub - (JPEG_EXECUTE + 8)) >> 2) & 0xffffff)) >>> 0, 'halation at the JPEG encode step');
}

function contextOf(p: Patch): number | null {
  const first = p.word(JPEG_EXECUTE);
  if (first >>> 24 !== 0xea) return null;
  const stub = branchTarget(JPEG_EXECUTE, first);
  if (p.word(stub + 4) !== 0xe5911008) return null; // ldr r1,[r1,#8]: the halation stub, not the date imprint's
  // push; ldr r1,[r1,#8]; movw r0; movt r0
  return (movImmediate(p.word(stub + 8)) | (movImmediate(p.word(stub + 12)) << 16)) >>> 0;
}

/**
 * The styles of a built image's looks that have halation, or null when none has. Files of
 * 0.7.2..0.8.1 had it for added slots only (`firstStyle` on, `count` of them).
 */
export function readHalation(p: Patch, firstStyle: number, count: number): Set<number> | null {
  try {
    const ctx = contextOf(p);
    if (ctx === null) return null;
    const magic = p.word(ctx + MAGIC_AT);
    const out = new Set<number>();
    if (magic === CTX_MAGIC || magic === CTX_MAGIC_TEST) {
      const map = p.read(ctx + MAGIC_AT + 4, HALATION_LOOKS);
      const n = p.word(ctx + 8 * 4);
      map.forEach((e, style) => { if (e && e <= n) out.add(style); });
    } else if (magic === CTX_MAGIC_081 || magic === CTX_MAGIC_072) {
      const mask = p.word(ctx + 8 * 4);
      for (let k = 0; k < count; k++) if ((mask >>> k) & 1) out.add(firstStyle + k);
    } else return null;
    return out.size ? out : null;
  } catch {
    return null;
  }
}

/** The light of a look of a built image ('HAL4', or the tests' 'HAL3'), or null. */
export function readHalationLight(p: Patch, style: number): HalationLight | null {
  try {
    const ctx = contextOf(p);
    if (ctx === null) return null;
    const magic = p.word(ctx + MAGIC_AT);
    if (magic !== CTX_MAGIC && magic !== CTX_MAGIC_TEST) return null;
    const e = p.read(ctx + MAGIC_AT + 4 + style, 1)[0];
    if (!e || e > p.word(ctx + 8 * 4)) return null;
    const [stride, at] = magic === CTX_MAGIC ? [520, 8] : [516, 4];
    const b = p.read(p.word(ctx + 7 * 4) + (e - 1) * stride + at, 512);
    return { table: Uint16Array.from({ length: 256 }, (_, i) => b[2 * i] | (b[2 * i + 1] << 8)) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------- pictures

/** Colour and coverage (0..255) of a pixel, or null. */
type Paint = (x: number, y: number) => [number, number, number, number] | null;

/**
 * Pixels as the camera's icons have them: no partial transparency. A pixel at least half covered
 * becomes opaque, its colour mixed with black by the coverage (the native icons have black
 * edges); the others stay as `base` has them (transparent: FF FF FF 00).
 */
function render(w: number, h: number, paint: Paint, base?: Uint8Array): Uint8Array {
  const out = base ? base.slice() : new Uint8Array(w * h * 4).fill(255).map((v, i) => (i % 4 === 3 ? 0 : v));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y);
    if (!c || c[3] < 128) continue;
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) out[i + k] = Math.round((c[k] * c[3]) / 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Coverage of a disc / ring, 4x4 supersampled. */
function cover(x: number, y: number, cx: number, cy: number, r0: number, r1: number): number {
  let n = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const dx = x + (sx + 0.5) / 4 - cx, dy = y + (sy + 0.5) / 4 - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= r0 && d <= r1) n++;
  }
  return n / 16;
}

const RED: [number, number, number] = [255, 84, 40];

/** A light with a red ring: the list icon of the parameter (40 x 40, like the other parameters). */
export function halationIcon(): Uint8Array {
  return render(40, 40, (x, y) => {
    const core = cover(x, y, 20, 20, 0, 6);
    const ring = cover(x, y, 20, 20, 10, 15.5);
    if (core) return [255, 255, 255, Math.round(255 * core)];
    if (ring) return [...RED, Math.round(255 * ring)];
    return null;
  });
}

/**
 * The colour slider's scale in the Halation submenu (400 x 60, as the native ones): the panel and the
 * track of `native` (the two-position Off / On scale 0x3A), its labels replaced by a red and a white
 * light at x = 20 and 380 (the two positions).
 */
export function halationColourScale(native: Uint8Array): Uint8Array {
  if (native.length !== 400 * 60 * 4) fail('unexpected-layout', 'halation: the native scale has another size');
  const base = native.slice();
  // Clear the labels (above the track): back to the panel colour.
  for (let y = 2; y < 34; y++) for (let x = 0; x < 400; x++) {
    const i = (y * 400 + x) * 4;
    base[i] = 0; base[i + 1] = 0; base[i + 2] = 0; base[i + 3] = 191;
  }
  return render(400, 60, (x, y) => {
    for (const [cx, colour] of [[20, RED], [380, [255, 255, 255]]] as const) {
      const c = cover(x, y, cx, 17, 0, 7);
      if (c) return [...colour, Math.round(255 * c)] as [number, number, number, number];
    }
    return null;
  }, base);
}

/** The colour row's icon in the Halation submenu (40 x 40): a red or a white light. */
export function halationColourIcon(colour: HalationColour): Uint8Array {
  const rgb: readonly [number, number, number] = colour === 'white' ? [255, 255, 255] : RED;
  return render(40, 40, (x, y) => {
    const c = cover(x, y, 20, 20, 0, 13);
    return c ? [...rgb, Math.round(255 * c)] : null;
  });
}

/**
 * The name of the parameter, per row of the text catalog (21; see build.ts): 0 Japanese, 1 English,
 * 2 French, 3 German, 4 Spanish, 5 Portuguese, 6 Italian, 7 Dutch, 8 Danish, 9 Swedish, 10 Finnish,
 * 11 Polish, 12 Czech, 13 Hungarian, 14 Turkish, 15 Greek, 16 Russian, 17 Korean, 18 Traditional
 * Chinese, 19 Simplified Chinese, 20 Thai (as the rows hold "OK" / "Toning").
 */
export const HALATION_NAMES: readonly string[] = [
  'ハレーション', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation',
  'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Ореол', '할레이션', '光暈',
  '光晕', 'Halation',
];

/** The colour row's name in the Halation submenu, per row of the text catalog (as `HALATION_NAMES`). */
export const HALATION_COLOUR_NAMES: readonly string[] = [
  'カラー', 'Colour', 'Couleur', 'Farbe', 'Color', 'Cor', 'Colore', 'Kleur', 'Farve',
  'Färg', 'Väri', 'Kolor', 'Barva', 'Szín', 'Renk', 'Χρώμα', 'Цвет', '색상', '顏色',
  '颜色', 'สี',
];

// -------------------------------------------------------------------------------- preview

const c8 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : n);
/** Lift towards white by h (0..255 of 255), as `lift` in halation.c. */
const lift = (v: number, h: number): number => v + Math.floor(((255 - v) * h * 257 + 32768) / 65536);

/**
 * The module's computation (halation.c, `halate`) in TypeScript, on a YCbCr 4:2:2 picture (Y and
 * the interleaved CbCr plane, `w` bytes per row each), for GR Mod's preview. Same integer steps.
 */
export function halateYcc(Y: Uint8Array, C: Uint8Array, w: number, h: number, level: HalationLevel, light: HalationLight = PLAIN_LIGHT, colour: HalationColour = 'red'): void {
  if (colour === 'white') halateYccWhite(Y, C, w, h, level, light);
  else halateYccRed(Y, C, w, h, level, light);
}

/**
 * White (highlight diffusion): the light of each highlight spreads in its own colour (three maps,
 * red, green and blue, each the light times that channel over the brightest one), and each channel
 * is lifted by its own map. A white lamp gives a white bloom, a red sign a red one.
 */
function halateYccWhite(Y: Uint8Array, C: Uint8Array, w: number, h: number, level: HalationLevel, light: HalationLight): void {
  const P = paramBytes();
  const v = new DataView(P.buffer);
  const tab = light.table;
  const narrow = v.getUint16(0, true), wideR = v.getUint16(2, true), mix = v.getUint16(4, true);
  const gain = halationGains()[level - 1];
  const lut = halationLut('white');
  let s = 0;
  while ((w >>> s) > 1024 || (h >>> s) > 1024) s++;
  const F = 1 << s;
  const sw = (w + F - 1) >>> s, sh = (h + F - 1) >>> s, n = sw * sh;
  const maps = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
  const acc = [new Uint32Array(sw), new Uint32Array(sw), new Uint32Array(sw)];
  const q = s >= 2 ? 1 : 0;
  for (let y = 0; y < h; y += F) {
    const by = y >>> s, ylim = Math.min(h, y + F);
    for (const a of acc) a.fill(0);
    for (let yy = y; yy < ylim; yy += 1 << q) {
      const row = yy * w;
      for (let x = 0; x < w; x += 1 << q) {
        const y0 = Y[row + x], cb = C[row + (x & ~1)] - 128, cr = C[row + (x | 1)] - 128;
        const R = c8(y0 + ((91881 * cr + 32768) >> 16));
        const G = c8(y0 - ((22554 * cb + 46802 * cr - 32768) >> 16));
        const B = c8(y0 + ((116130 * cb + 32768) >> 16));
        const m = R > G ? (R > B ? R : B) : (G > B ? G : B);
        const l = tab[m];
        if (!l || !m) continue;
        const k = Math.floor((l << 8) / m);
        acc[0][x >>> s] += (k * R) >>> 8;
        acc[1][x >>> s] += (k * G) >>> 8;
        acc[2][x >>> s] += (k * B) >>> 8;
      }
    }
    for (let c = 0; c < 3; c++) for (let x = 0; x < sw; x++) maps[c][by * sw + x] = Math.min(16384, acc[c][x] >>> (2 * (s - q)));
  }
  const tmp = new Uint16Array(Math.max(sw, sh));
  const spread = (a: Uint16Array, rad: number): void => {
    let r = (rad * sw + 2048) >>> 12;
    if (r < 1) return;
    if (r > 200) r = 200;
    const recip = Math.floor(65536 / (2 * r + 1));
    const box = (off: number, len: number, step: number): void => {
      if (len < 2) return;
      for (let i = 0; i < len; i++) tmp[i] = a[off + i * step];
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += tmp[j < 0 ? 0 : j >= len ? len - 1 : j];
      for (let i = 0; i < len; i++) {
        const out = i - r, inn = i + r + 1;
        a[off + i * step] = (sum * recip) >>> 16;
        sum -= tmp[out < 0 ? 0 : out];
        sum += tmp[inn >= len ? len - 1 : inn];
      }
    };
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < sh; y++) box(y * sw, sw, 1);
      for (let x = 0; x < sw; x++) box(x, sh, sw);
    }
  };
  for (const m of maps) {
    const wide = m.slice();
    spread(m, narrow);
    spread(wide, wideR);
    for (let i = 0; i < n; i++) m[i] = (m[i] * mix + wide[i] * (256 - mix)) >>> 8;
  }
  const rowv = [new Uint32Array(sw), new Uint32Array(sw), new Uint32Array(sw)];
  const at = (i: number): number => (i >= LUT_N ? LUT_N - 1 : i);
  for (let y = 0; y < h; y++) {
    let fy = (((y << 8) + 128) >> s) - 128;
    if (fy < 0) fy = 0;
    let sy0 = fy >> 8; const wy = fy & 255; let sy1 = sy0 + 1;
    if (sy0 >= sh) sy0 = sh - 1;
    if (sy1 >= sh) sy1 = sh - 1;
    let maxv = 0;
    for (let c = 0; c < 3; c++) {
      const m = maps[c], rv = rowv[c];
      for (let i = 0; i < sw; i++) {
        const val = (m[sy0 * sw + i] * (256 - wy) + m[sy1 * sw + i] * wy) >>> 8;
        rv[i] = val;
        if (val > maxv) maxv = val;
      }
    }
    if (lut[at(Math.floor((maxv * gain) / 1024))] === 0) continue;
    const row = y * w;
    for (let x = 0; x + 1 < w; x += 2) {
      let fx = (((x << 8) + 128) >> s) - 128;
      if (fx < 0) fx = 0;
      const sx0 = fx >> 8, wx = fx & 255;
      let sx1 = sx0 + 1;
      if (sx1 >= sw) sx1 = sw - 1;
      const hc = [0, 1, 2].map((c) => lut[at(Math.floor((((rowv[c][sx0] * (256 - wx) + rowv[c][sx1] * wx) >>> 8) * gain) / 1024))]);
      if (!hc[0] && !hc[1] && !hc[2]) continue;
      const cb = C[row + x] - 128, cr = C[row + x + 1] - 128;
      let sb = 0, sr = 0;
      for (let j = 0; j < 2; j++) {
        const y0 = Y[row + x + j];
        const R = lift(c8(y0 + ((91881 * cr + 32768) >> 16)), hc[0]);
        const G = lift(c8(y0 - ((22554 * cb + 46802 * cr - 32768) >> 16)), hc[1]);
        const B = lift(c8(y0 + ((116130 * cb + 32768) >> 16)), hc[2]);
        Y[row + x + j] = c8((19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
        sb += -11059 * R - 21709 * G + 32768 * B;
        sr += 32768 * R - 27439 * G - 5329 * B;
      }
      C[row + x] = c8(128 + ((sb + 65536) >> 17));
      C[row + x + 1] = c8(128 + ((sr + 65536) >> 17));
    }
  }
}

function halateYccRed(Y: Uint8Array, C: Uint8Array, w: number, h: number, level: HalationLevel, light: HalationLight): void {
  const P = paramBytes();
  const v = new DataView(P.buffer);
  const tab = light.table;
  const narrow = v.getUint16(0, true), wideR = v.getUint16(2, true), mix = v.getUint16(4, true);
  const gain = halationGains()[level - 1];
  const lut = halationLut('red');
  let s = 0;
  while ((w >>> s) > 1024 || (h >>> s) > 1024) s++;
  const F = 1 << s;
  const sw = (w + F - 1) >>> s, sh = (h + F - 1) >>> s, n = sw * sh;
  const small = new Uint16Array(n);
  const acc = new Uint32Array(sw);
  const q = s >= 2 ? 1 : 0;
  for (let y = 0; y < h; y += F) {
    const by = y >>> s, ylim = Math.min(h, y + F);
    acc.fill(0);
    for (let yy = y; yy < ylim; yy += 1 << q) {
      const row = yy * w;
      for (let x = 0; x < w; x += 1 << q) {
        let val = Y[row + x];
        const red = val + ((91881 * (C[row + (x | 1)] - 128) + 32768) >> 16);
        if (red > val) val = red;
        acc[x >>> s] += tab[val > 255 ? 255 : val];
      }
    }
    for (let x = 0; x < sw; x++) small[by * sw + x] = Math.min(16384, acc[x] >>> (2 * (s - q)));
  }
  const tmp = new Uint16Array(Math.max(sw, sh));
  const spread = (a: Uint16Array, rad: number): void => {
    let r = (rad * sw + 2048) >>> 12;
    if (r < 1) return;
    if (r > 200) r = 200;
    const recip = Math.floor(65536 / (2 * r + 1));
    const box = (off: number, len: number, step: number): void => {
      if (len < 2) return;
      for (let i = 0; i < len; i++) tmp[i] = a[off + i * step];
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += tmp[j < 0 ? 0 : j >= len ? len - 1 : j];
      for (let i = 0; i < len; i++) {
        const out = i - r, inn = i + r + 1;
        a[off + i * step] = (sum * recip) >>> 16;
        sum -= tmp[out < 0 ? 0 : out];
        sum += tmp[inn >= len ? len - 1 : inn];
      }
    };
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < sh; y++) box(y * sw, sw, 1);
      for (let x = 0; x < sw; x++) box(x, sh, sw);
    }
  };
  const wide = small.slice();
  spread(small, narrow);
  spread(wide, wideR);
  for (let i = 0; i < n; i++) small[i] = (small[i] * mix + wide[i] * (256 - mix)) >>> 8;
  const rowv = new Uint32Array(sw);
  const at = (i: number): number => (i >= LUT_N ? LUT_N - 1 : i);
  for (let y = 0; y < h; y++) {
    let fy = (((y << 8) + 128) >> s) - 128;
    if (fy < 0) fy = 0;
    let sy0 = fy >> 8; const wy = fy & 255; let sy1 = sy0 + 1;
    if (sy0 >= sh) sy0 = sh - 1;
    if (sy1 >= sh) sy1 = sh - 1;
    let maxv = 0;
    for (let i = 0; i < sw; i++) {
      const val = (small[sy0 * sw + i] * (256 - wy) + small[sy1 * sw + i] * wy) >>> 8;
      rowv[i] = val;
      if (val > maxv) maxv = val;
    }
    if (lut[at(Math.floor((maxv * gain) / 1024))] === 0) continue;
    const row = y * w;
    for (let x = 0; x + 1 < w; x += 2) {
      let fx = (((x << 8) + 128) >> s) - 128;
      if (fx < 0) fx = 0;
      const sx0 = fx >> 8, wx = fx & 255;
      let sx1 = sx0 + 1;
      if (sx1 >= sw) sx1 = sw - 1;
      const l = (rowv[sx0] * (256 - wx) + rowv[sx1] * wx) >>> 8;
      const idx = at(Math.floor((l * gain) / 1024));
      const hr = lut[idx];
      if (!hr) continue;
      const hg = lut[LUT_N + idx], hb = lut[2 * LUT_N + idx];
      const cb = C[row + x] - 128, cr = C[row + x + 1] - 128;
      let sb = 0, sr = 0;
      for (let j = 0; j < 2; j++) {
        const y0 = Y[row + x + j];
        const R = lift(c8(y0 + ((91881 * cr + 32768) >> 16)), hr);
        const G = lift(c8(y0 - ((22554 * cb + 46802 * cr - 32768) >> 16)), hg);
        const B = lift(c8(y0 + ((116130 * cb + 32768) >> 16)), hb);
        Y[row + x + j] = c8((19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
        sb += -11059 * R - 21709 * G + 32768 * B;
        sr += 32768 * R - 27439 * G - 5329 * B;
      }
      C[row + x] = c8(128 + ((sb + 65536) >> 17));
      C[row + x + 1] = c8(128 + ((sr + 65536) >> 17));
    }
  }
}

/** Halation on an RGBA picture (sRGB, through YCbCr 4:2:2 as in the camera), in place; `light` of the slot (`halationLight`). */
export function halateRgba(data: Uint8ClampedArray, width: number, height: number, level: HalationLevel, light: HalationLight = PLAIN_LIGHT, colour: HalationColour = 'red'): void {
  const w = width & ~1;
  if (w < 2 || height < 2) return;
  const Y = new Uint8Array(w * height), C = new Uint8Array(w * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x += 2) {
    let cb = 0, cr = 0;
    for (let k = 0; k < 2; k++) {
      const i = (y * width + x + k) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      Y[y * w + x + k] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
      cb += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      cr += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    C[y * w + x] = Math.max(0, Math.min(255, Math.round(cb / 2)));
    C[y * w + x + 1] = Math.max(0, Math.min(255, Math.round(cr / 2)));
  }
  const before = Y.slice(), cbefore = C.slice();
  halateYcc(Y, C, w, height, level, light, colour);
  // Only the change is put back, so the rest of the picture keeps its full colour resolution.
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x += 2) {
    const dcb = C[y * w + x] - cbefore[y * w + x], dcr = C[y * w + x + 1] - cbefore[y * w + x + 1];
    for (let k = 0; k < 2; k++) {
      const dy = Y[y * w + x + k] - before[y * w + x + k];
      if (!dy && !dcb && !dcr) continue;
      const i = (y * width + x + k) * 4;
      data[i] += dy + 1.402 * dcr;
      data[i + 1] += dy - 0.344136 * dcb - 0.714136 * dcr;
      data[i + 2] += dy + 1.772 * dcb;
    }
  }
}
