// Canvas helpers: icon rendering, picture loading, cropping to the power-off image size.
import { fw, ICON_W, ICON_H, SHUTDOWN_W, SHUTDOWN_H } from '@grmod/core';

export const ICON_FONT = '"Barlow Condensed"';
const FONT_STACK = `${ICON_FONT}, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
let fontReady: Promise<unknown> | null = null;
export function ensureIconFont(): Promise<unknown> {
  if (!fontReady) fontReady = Promise.all([document.fonts.load(`700 32px ${ICON_FONT}`), document.fonts.load(`600 32px ${ICON_FONT}`)]).catch(() => undefined);
  return fontReady;
}

type Area = { x0: number; y0: number; x1: number; y1: number };

/** Coverage map (0..1, 40x40) of `text` drawn in white inside `area`, as large as fits. */
export function textCoverage(text: string, area: Area): Float32Array {
  const SS = 8; // supersampling
  const aw = area.x1 - area.x0 + 1; const ah = area.y1 - area.y0 + 1;
  const pad = 2; // keep a little air left and right
  const c = document.createElement('canvas'); c.width = ICON_W * SS; c.height = ICON_H * SS;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  const out = new Float32Array(ICON_W * ICON_H);
  const s = text.trim();
  if (!s) return out;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.fillStyle = '#fff';
  const maxW = (aw - 2 * pad) * SS; const maxH = Math.min(ah - 6, 18) * SS; // cap height target, like the camera's own labels
  let size = maxH / 0.7; let m = g.measureText(s);
  for (let i = 0; i < 40; i++) {
    g.font = `700 ${size}px ${FONT_STACK}`;
    m = g.measureText(s);
    const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight; const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (w <= maxW && h <= maxH) break;
    size *= Math.min(0.97, Math.max(0.6, Math.min(maxW / Math.max(w, 1), maxH / Math.max(h, 1))));
  }
  const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight; const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const cx = (area.x0 + aw / 2) * SS; const cy = (area.y0 + ah / 2) * SS;
  // snap to whole device pixels so stems stay crisp
  const x = Math.round((cx - w / 2 + m.actualBoundingBoxLeft) / SS) * SS; const y = Math.round((cy + h / 2 - m.actualBoundingBoxDescent) / SS) * SS;
  g.fillText(s, x, y);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  for (let py = 0; py < ICON_H; py++) for (let px = 0; px < ICON_W; px++) {
    let acc = 0;
    for (let yy = 0; yy < SS; yy++) { let o = ((py * SS + yy) * c.width + px * SS) * 4; for (let xx = 0; xx < SS; xx++, o += 4) acc += d[o]; }
    out[py * ICON_W + px] = acc / (SS * SS * 255);
  }
  return out;
}

export function textIcon(tile: Uint8Array, text: string, area: Area): Uint8Array {
  return fw.composeIcon(tile, textCoverage(text, area));
}

/** Fit a picture into the content area of a tile (cover, centred). */
export function imageIcon(tile: Uint8Array, img: CanvasImageSource, iw: number, ih: number, area: Area): Uint8Array {
  const aw = area.x1 - area.x0 + 1; const ah = area.y1 - area.y0 + 1;
  const c = document.createElement('canvas'); c.width = aw; c.height = ah;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const scale = Math.max(aw / iw, ah / ih); const sw = aw / scale; const sh = ah / scale;
  g.fillStyle = 'rgb(53,53,54)'; g.fillRect(0, 0, aw, ah);
  drawScaled(g, img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, aw, ah);
  const d = g.getImageData(0, 0, aw, ah).data;
  const out = tile.slice();
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const o = ((area.y0 + y) * ICON_W + area.x0 + x) * 4; const s = (y * aw + x) * 4;
    if (out[o + 3] === 0) continue;
    const a = d[s + 3] / 255;
    out[o] = Math.round(d[s] * a + 53 * (1 - a)); out[o + 1] = Math.round(d[s + 1] * a + 53 * (1 - a)); out[o + 2] = Math.round(d[s + 2] * a + 54 * (1 - a));
  }
  return out;
}

/** drawImage with step-wise halving so large reductions do not alias. */
function drawScaled(g: CanvasRenderingContext2D, img: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): void {
  let cur: CanvasImageSource = img; let cx = sx; let cy = sy; let cw = sw; let ch = sh;
  while (cw > dw * 2 && ch > dh * 2) {
    const nw = Math.max(dw, Math.round(cw / 2)); const nh = Math.max(dh, Math.round(ch / 2));
    const t = document.createElement('canvas'); t.width = nw; t.height = nh;
    const tg = t.getContext('2d')!; tg.imageSmoothingEnabled = true; tg.imageSmoothingQuality = 'high';
    tg.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    cur = t; cx = 0; cy = 0; cw = nw; ch = nh;
  }
  g.drawImage(cur, cx, cy, cw, ch, 0, 0, dw, dh);
}

export interface Crop { x: number; y: number; w: number; h: number }

export function defaultCrop(iw: number, ih: number): Crop {
  const ar = SHUTDOWN_W / SHUTDOWN_H;
  let w = iw; let h = w / ar;
  if (h > ih) { h = ih; w = h * ar; }
  return { x: (iw - w) / 2, y: (ih - h) / 2, w, h };
}

/** Render the crop of a picture to 720x480 RGB. */
export function cropToRgb(img: CanvasImageSource, crop: Crop): Uint8Array {
  const c = document.createElement('canvas'); c.width = SHUTDOWN_W; c.height = SHUTDOWN_H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  drawScaled(g, img, crop.x, crop.y, crop.w, crop.h, SHUTDOWN_W, SHUTDOWN_H);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(SHUTDOWN_W * SHUTDOWN_H * 3);
  for (let i = 0, o = 0; i < d.length; i += 4, o += 3) { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; }
  return out;
}

export async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

/** A working copy of a picture, at most `max` pixels on the long side, as JPEG bytes. */
export async function workingCopy(bmp: ImageBitmap, max = 2400): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)); const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  drawScaled(g, bmp, 0, 0, bmp.width, bmp.height, w, h);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.93));
  return { blob, width: w, height: h };
}

export function rgbToCanvas(canvas: HTMLCanvasElement, rgb: Uint8Array, w: number, h: number): void {
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!; const im = g.createImageData(w, h);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) { im.data[o] = rgb[i]; im.data[o + 1] = rgb[i + 1]; im.data[o + 2] = rgb[i + 2]; im.data[o + 3] = 255; }
  g.putImageData(im, 0, 0);
}
export function rgbaToCanvas(canvas: HTMLCanvasElement, rgba: Uint8Array, w: number, h: number): void {
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!; const im = g.createImageData(w, h); im.data.set(rgba); g.putImageData(im, 0, 0);
}
