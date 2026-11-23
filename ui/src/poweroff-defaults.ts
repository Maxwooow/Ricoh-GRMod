// SPDX-License-Identifier: GPL-2.0-only
/**
 * Built-in power-off pictures: eight original designs the app draws itself, 720 x 480 like
 * every power-off picture (core aspect/shutdown.ts), offered on the Power-off page.
 *
 * @decision DEC-POWEROFF-001: drawn on a canvas instead of shipped as image files: nothing to license,
 * no logos or trade names (the film edge says ISO 400, not a camera name), a few kilobytes of code instead
 * of half a megabyte of JPEGs, and sharp at the camera's own size. A picked design becomes a PNG File and
 * goes through addWallFiles like a chosen file, so crop, name, order, saving and building are unchanged.
 * The text uses the app's own font (Barlow Condensed); rounded rectangles are drawn by hand so that older
 * web views without CanvasRenderingContext2D.roundRect draw them too.
 */
import { SHUTDOWN_H, SHUTDOWN_W } from '@grmod/core';

const W = SHUTDOWN_W, H = SHUTDOWN_H;
const FONT = '"Barlow Condensed", "Helvetica Neue", Arial, sans-serif';
type G = CanvasRenderingContext2D;

export interface BuiltInPicture { id: string; /** Also the camera-menu name: printable ASCII, at most 20. */ name: string; draw(g: G): void }

/** A small seeded generator, so a design draws the same every time. */
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
/** Text with letter spacing, centred on x (canvas letterSpacing is not everywhere). */
function spaced(g: G, text: string, x: number, y: number, spacing: number): void {
  const chars = [...text], widths = chars.map((c) => g.measureText(c).width);
  let cx = x - (widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1)) / 2;
  const align = g.textAlign; g.textAlign = 'center';
  chars.forEach((c, i) => { g.fillText(c, cx + widths[i] / 2, y); cx += widths[i] + spacing; });
  g.textAlign = align;
}
function rounded(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const text = (g: G, weight: number, size: number, color: string, align: CanvasTextAlign = 'center'): void => {
  g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
};

export const BUILT_IN_PICTURES: readonly BuiltInPicture[] = [
  { id: 'night', name: 'Good Night', draw(g) {
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#0b1026'); gr.addColorStop(1, '#1c2a4a');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const r = rng(7); g.fillStyle = '#fff';
    for (let i = 0; i < 140; i++) { g.globalAlpha = 0.25 + r() * 0.6; const s = r() < 0.9 ? 1 : 2; g.fillRect(r() * W, r() * H * 0.8, s, s); }
    g.globalAlpha = 1;
    g.fillStyle = '#f3e9c6'; g.beginPath(); g.arc(360, 190, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#121a35'; g.beginPath(); g.arc(382, 176, 42, 0, Math.PI * 2); g.fill();
    text(g, 600, 46, '#e9edf7'); spaced(g, 'GOOD NIGHT', 360, 322, 10);
  } },
  { id: 'roll', name: 'End of Roll', draw(g) {
    g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#2a2016'; g.fillRect(0, 70, W, 340);
    g.fillStyle = '#111';
    for (let x = 14; x < W; x += 36) { rounded(g, x, 22, 20, 30, 4); g.fill(); rounded(g, x, 428, 20, 30, 4); g.fill(); }
    text(g, 700, 22, '#e8892b', 'left'); g.fillText('36A', 30, 88); g.fillText('ISO 400', 30, 392);
    text(g, 700, 22, '#e8892b', 'right'); g.fillText('37 ▶', 690, 88);
    text(g, 700, 78, '#f0a04b'); spaced(g, 'END OF ROLL', 360, 240, 6);
  } },
  { id: 'horizon', name: 'Horizon', draw(g) {
    const gr = g.createLinearGradient(0, 0, 0, 300); gr.addColorStop(0, '#1d1d22'); gr.addColorStop(1, '#5a4a44');
    g.fillStyle = gr; g.fillRect(0, 0, W, 300);
    g.fillStyle = '#d9643a'; g.beginPath(); g.arc(360, 300, 70, Math.PI, 0); g.fill();
    g.fillStyle = '#121214'; g.fillRect(0, 300, W, H - 300);
    g.strokeStyle = 'rgba(217,100,58,0.5)';
    for (let i = 0; i < 6; i++) { g.lineWidth = 3 - i * 0.4; const y = 318 + i * 14; g.beginPath(); g.moveTo(300 + i * 9, y); g.lineTo(420 - i * 9, y); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(0, 299, W, 1.5);
  } },
  { id: 'grain', name: 'Grain', draw(g) {
    const img = g.createImageData(W, H), r = rng(11);
    for (let i = 0; i < W * H; i++) {
      const d = Math.hypot((i % W) - 360, ((i / W) | 0) - 240) / 430;
      const v = Math.max(0, Math.min(255, 52 - d * 40 + (r() - 0.5) * 46 + (r() - 0.5) * 20));
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    text(g, 700, 150, 'rgba(245,245,240,0.92)'); spaced(g, 'OFF', 360, 244, 18);
  } },
  { id: 'contact', name: 'Contact Sheet', draw(g) {
    g.fillStyle = '#ecebe6'; g.fillRect(0, 0, W, H);
    const r = rng(3), cw = 150, ch = 100, gx = 24, gy = 42;
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
      const x = 33 + col * (cw + gx), y = 40 + row * (ch + gy);
      g.fillStyle = '#1b1b1b'; g.fillRect(x - 6, y - 6, cw + 12, ch + 12);
      const tone = 60 + r() * 120, gr = g.createLinearGradient(x, y, x + cw, y + ch);
      gr.addColorStop(0, `rgb(${tone},${tone},${tone})`); gr.addColorStop(1, `rgb(${tone / 2},${tone / 2},${tone / 2})`);
      g.fillStyle = gr; g.fillRect(x, y, cw, ch);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, y + ch * (0.55 + r() * 0.2), cw, 2);
      text(g, 600, 13, '#e8892b', 'left'); g.fillText(`${row * 4 + col + 1}A`, x - 4, y + ch + 16);
    }
    g.strokeStyle = '#d23a2a'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.ellipse(33 + 2 * (cw + gx) + cw / 2, 40 + (ch + gy) + ch / 2, 98, 70, -0.08, 0.2, Math.PI * 2.05); g.stroke();
  } },
  { id: 'snap', name: 'Snap Focus', draw(g) {
    g.fillStyle = '#151515'; g.fillRect(0, 0, W, H);
    const marks = ['0.3', '0.5', '0.7', '1', '1.5', '2', '2.5', '5', '∞'];
    g.strokeStyle = '#8c8c8c'; g.lineWidth = 2; g.beginPath(); g.moveTo(80, 250); g.lineTo(640, 250); g.stroke();
    marks.forEach((m, i) => {
      const x = 80 + i * 70; g.beginPath(); g.moveTo(x, 236); g.lineTo(x, 264); g.stroke();
      text(g, 600, 28, m === '2' ? '#f0a04b' : '#cfcfcf'); g.fillText(m, x, 296);
    });
    g.fillStyle = '#f0a04b'; g.beginPath(); g.moveTo(430, 220); g.lineTo(442, 200); g.lineTo(418, 200); g.closePath(); g.fill();
    text(g, 600, 30, '#e6e6e6'); spaced(g, 'SNAP  2 M', 360, 132, 8);
    text(g, 600, 20, '#6f6f6f'); spaced(g, 'SEE YOU OUT THERE', 360, 380, 6);
  } },
  { id: 'thirds', name: 'Thirds', draw(g) {
    g.fillStyle = '#0e0e0e'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 1.5;
    for (const x of [240, 480]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (const y of [160, 320]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    for (const [x, y] of [[240, 160], [480, 160], [240, 320], [480, 320]]) { g.beginPath(); g.moveTo(x - 10, y); g.lineTo(x + 10, y); g.moveTo(x, y - 10); g.lineTo(x, y + 10); g.stroke(); }
    g.fillStyle = '#e04a3a'; g.beginPath(); g.arc(480, 320, 9, 0, Math.PI * 2); g.fill();
    text(g, 600, 26, 'rgba(255,255,255,0.85)', 'left'); g.fillText('until next time', 498, 352);
  } },
  { id: 'bokeh', name: 'Bokeh', draw(g) {
    const gr = g.createRadialGradient(360, 240, 40, 360, 240, 480); gr.addColorStop(0, '#1a1420'); gr.addColorStop(1, '#060508');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const r = rng(23), cols = ['255,176,90', '255,120,90', '120,170,255', '255,220,140', '200,140,255'];
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 38; i++) {
      const x = r() * W, y = r() * H, rad = 18 + r() * 58, c = cols[(r() * cols.length) | 0], a = 0.06 + r() * 0.16;
      const rg = g.createRadialGradient(x, y, rad * 0.2, x, y, rad); rg.addColorStop(0, `rgba(${c},${a})`); rg.addColorStop(0.85, `rgba(${c},${a * 1.4})`); rg.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  } },
];

/** The app's font, before anything is drawn with it (a design drawn first would fall back to Arial). */
export async function builtInFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.all([document.fonts.load(`600 20px ${FONT}`), document.fonts.load(`700 20px ${FONT}`)]).catch(() => undefined);
}

/** Draw a design at full size on a new canvas. */
export function drawBuiltIn(p: BuiltInPicture): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  p.draw(c.getContext('2d')!);
  return c;
}

/** A design as a PNG file named after it (its camera-menu name comes from the file name). */
export async function builtInFile(p: BuiltInPicture): Promise<File> {
  await builtInFontsReady();
  const c = drawBuiltIn(p);
  const blob = await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('the picture could not be drawn'))), 'image/png'));
  return new File([blob], `${p.name}.png`, { type: 'image/png' });
}
