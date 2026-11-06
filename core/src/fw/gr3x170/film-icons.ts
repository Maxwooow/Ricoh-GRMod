// SPDX-License-Identifier: GPL-2.0-only
/** Packaging-inspired colour labels inside the established native 40px frame.
 * Palettes and panel choices: examples/gr3x/T6/ICON-SOURCES.json.
 * Short stock names remain legible at 1x. No external bitmap is embedded.
 */
import { FirmwareError } from '../types';

export const T6_FILM_NAMES = ['Provia 100F', 'Provia 400F', 'Velvia 50', 'Velvia 100',
  'Portra 400', 'Gold 200', 'Ektar 100', 'Kodachrome 64', 'CineStill 800T'] as const;
const LABELS = [
  { top: 'PROVIA', bottom: '100F' },
  { top: 'PROVIA', bottom: '400F' },
  { top: 'VELVIA', bottom: '50' },
  { top: 'VELVIA', bottom: '100' },
  { top: 'PORTRA', bottom: '400' },
  { top: 'GOLD', bottom: '200' },
  { top: 'EKTAR', bottom: '100' },
  { top: 'KODACHR', bottom: '64' },
  { top: 'CINESTILL', bottom: '800T' },
] as const;
const FONT: Record<string, string[]> = {
  A: ['010','101','111','101','101'], C: ['111','100','100','100','111'],
  D: ['110','101','101','101','110'], E: ['111','100','110','100','111'],
  F: ['111','100','110','100','100'], G: ['111','100','101','101','111'],
  H: ['101','101','111','101','101'], I: ['111','010','010','010','111'],
  K: ['101','101','110','101','101'], L: ['100','100','100','100','111'],
  N: ['101','111','111','111','101'], O: ['111','101','101','101','111'],
  P: ['110','101','110','100','100'], R: ['110','101','110','101','101'],
  S: ['111','100','111','001','111'], T: ['111','010','010','010','010'],
  V: ['101','101','101','101','010'],
  '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
  '2': ['110','001','010','100','111'], '4': ['101','101','111','001','001'],
  '5': ['111','100','110','001','110'], '6': ['011','100','111','101','111'],
  '8': ['111','101','111','101','111'],
};

export function gr3xFilmIcon(template: Uint8Array, index: number): Uint8Array {
  if (template.length !== 6400 || !Number.isInteger(index) || !LABELS[index])
    throw new FirmwareError('bad-icon', 'unknown T6 colour film label');
  const out = template.slice(), label = LABELS[index];
  const pixel = (x: number, y: number, rgb: readonly number[]) => out.set([...rgb, 255], (y * 40 + x) * 4);
  const box = (x0: number, y0: number, x1: number, y1: number, rgb: readonly number[]) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pixel(x, y, rgb);
  };
  const black = [23, 24, 23], white = [255, 252, 241], cream = [249, 233, 180];
  const green = [73, 162, 78], blue = [40, 97, 157], yellow = [248, 191, 39];
  let titleInk = white, numberInk = white, numberY = 17;
  switch (index) {
    case 0: // Provia 100F: green header, violet body, cream lettering on black.
      box(2, 9, 37, 30, [62, 45, 133]);
      box(2, 9, 37, 15, green);
      box(4, 16, 35, 28, [189, 186, 201]);
      box(5, 17, 34, 27, black);
      numberInk = cream;
      break;
    case 1: // Discontinued 400F: green/sky-blue, with a silver dividing strip.
      box(2, 9, 37, 30, [57, 145, 201]);
      box(2, 9, 37, 15, green);
      box(2, 16, 37, 17, [192, 197, 199]);
      box(2, 28, 8, 30, [192, 197, 199]);
      numberY = 18;
      break;
    case 2: // Velvia 50: gold speed panel, black numerals.
    case 3: // Velvia 100: cream lettering on the black speed panel.
      box(2, 9, 37, 30, blue);
      box(2, 9, 37, 15, green);
      box(5, 16, 34, 28, cream);
      box(6, 17, 33, 27, index === 2 ? [207, 178, 108] : black);
      numberInk = index === 2 ? black : cream;
      break;
    case 4: // Portra's purple/lavender package and Kodak-yellow footer.
      box(2, 9, 37, 30, [116, 86, 154]);
      box(2, 17, 37, 25, [118, 112, 176]);
      box(2, 26, 37, 30, yellow);
      box(4, 27, 8, 29, [194, 39, 48]);
      numberY = 16;
      break;
    case 5: // Classic Gold: yellow upper block, red type, purple lower block.
      box(2, 9, 37, 15, yellow);
      box(2, 16, 37, 30, [151, 39, 136]);
      titleInk = [192, 32, 46];
      break;
    case 6: // Ektar: near-black with a restrained diagonal red streak, yellow base.
      box(2, 9, 37, 30, [30, 27, 23]);
      for (let y = 9; y <= 25; y++) for (let x = 2; x <= 37; x++) {
        const d = Math.abs(x + y - 37);
        if (d < 4) pixel(x, y, d < 2 ? [123, 50, 40] : [67, 35, 29]);
      }
      box(2, 26, 37, 30, yellow);
      box(4, 27, 8, 29, [194, 39, 48]);
      numberY = 16;
      break;
    case 7: { // Classic Kodachrome: red face, spectral stripe and yellow footer.
      box(2, 9, 37, 25, [194, 44, 53]);
      box(2, 26, 37, 30, yellow);
      const rainbow = [[208,44,71],[177,42,132],[93,40,131],[31,71,152],[30,148,180],[50,155,81]];
      for (let x = 2; x <= 37; x++) pixel(x, 26, rainbow[Math.floor((x - 2) / 6)]);
      numberY = 16;
      break;
    }
    case 8: // CineStill 800T: red disc on a black field, white lettering.
      box(2, 9, 37, 30, black);
      for (let y = 9; y <= 30; y++) for (let x = 2; x <= 37; x++)
        if ((x - 19.5) ** 2 + (y - 19.5) ** 2 < 16.8 ** 2) pixel(x, y, [211, 38, 49]);
      break;
  }
  const text = (value: string, y0: number, scale: number, ink: readonly number[]) => {
    const width = value.length * (3 * scale + 1) - 1, x0 = Math.floor((40 - width) / 2);
    [...value].forEach((ch, i) => FONT[ch].forEach((row, y) => [...row].forEach((on, x) => {
      if (on === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++)
        pixel(x0 + i * (3 * scale + 1) + x * scale + dx, y0 + y * scale + dy, ink);
    })));
  };
  text(label.top, 10, 1, titleInk); text(label.bottom, numberY, 2, numberInk);
  return out;
}
