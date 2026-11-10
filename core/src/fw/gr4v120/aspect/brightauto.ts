// SPDX-License-Identifier: GPL-2.0-only
/**
 * A brighter rear screen when Setup > Outdoor View Setting is Auto (GR IV / HDF / Monochrome, firmware 1.20).
 *
 * The function at 0x53269f74(this, x) maps the Auto-brightness input x to a backlight luminance
 * target by piecewise-linear interpolation over an 18-entry table of (x, y) word pairs at
 * 0x53de4968 (stride 8; x = 1, 2, 4, ... 131072, y at 0x53de496c + 8 * i). x <= 1 returns 53
 * (0x5326a024), x >= 0x20000 returns 1050 (`movw r0,#0x41a` at 0x5326a01c), and the result is
 * clamped to 1050 (`movw r3,#0x41a` at 0x53269ffc). The `mov r3,#10` / mul / divide-by-10 at
 * 0x53269ff0 is left alone.
 *
 * This replaces the 18 y words with a brighter curve and raises the two 1050 limits to 1500, the
 * value the fixed Outdoor View +2 already uses (+1 uses 800), so the panel is driven that far
 * already. Data and two immediates only; no code is added. Read from a disassembly of the official
 * 1.20 file. The balanced curve is used daily by the owner on GR IV HDF 1.11 and 1.20.
 */
import { Patch, expectWord } from './build';

export const CURVE_X = 0x53de4968;
const CURVE_Y = 0x53de496c;
const CLAMP = 0x53269ffc;
const TOP = 0x5326a01c;

/** x values of the table (powers of two). */
export const BRIGHT_AUTO_X = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
export const OFFICIAL_AUTO_Y = [53, 63, 75, 90, 110, 150, 210, 260, 280, 285, 290, 320, 356, 470, 610, 770, 930, 1050];
export const BRIGHT_AUTO_Y = [53, 65, 80, 100, 140, 210, 300, 400, 480, 540, 600, 660, 740, 840, 970, 1130, 1320, 1500];
/**
 * Balanced, from the camera: the official curve is too dark indoors, BRIGHT_AUTO_Y a little too
 * bright there. Up to x = 1024 each point is 65% of the way from the official value to the bright
 * one in log luminance (about 1.5x official, 0.8x bright indoors), then 75%, 85%, 95%, and the
 * bright curve itself from x = 16384 on (strong light, where the screen is hard to see).
 */
export const BALANCED_AUTO_Y = [53, 64, 78, 96, 128, 185, 265, 345, 400, 435, 465, 550, 660, 815, 970, 1130, 1320, 1500];
export type BrightAutoCurve = 'bright' | 'balanced';

export const BRIGHT_AUTO_CLAMP = { address: CLAMP, official: 0xe300341a, bright: 0xe30035dc };
export const BRIGHT_AUTO_TOP = { address: TOP, official: 0xe300041a, bright: 0xe30005dc };

export function installBrightAuto(patch: Patch, curve: BrightAutoCurve = 'bright'): void {
  const Y = curve === 'balanced' ? BALANCED_AUTO_Y : BRIGHT_AUTO_Y;
  for (let i = 0; i < BRIGHT_AUTO_X.length; i++) {
    expectWord(patch, CURVE_X + 8 * i, BRIGHT_AUTO_X[i]);
    expectWord(patch, CURVE_Y + 8 * i, OFFICIAL_AUTO_Y[i]);
  }
  expectWord(patch, CLAMP, 0xe300341a); // movw r3, #0x41a
  expectWord(patch, TOP, 0xe300041a); // movw r0, #0x41a
  if (Y.length !== BRIGHT_AUTO_X.length || Y[Y.length - 1] !== 1500) throw new Error('auto curve: 18 points ending at 1500');
  for (let i = 1; i < Y.length; i++) if (Y[i] < Y[i - 1]) throw new Error('bright auto curve must not decrease');
  for (let i = 0; i < Y.length; i++) {
    if (Y[i] !== OFFICIAL_AUTO_Y[i]) patch.setWord(CURVE_Y + 8 * i, Y[i], `brighter Auto screen (${curve}): curve point ${i}`);
  }
  patch.setWord(CLAMP, 0xe30035dc, 'brighter Auto screen: upper limit 1500'); // movw r3, #0x5dc
  patch.setWord(TOP, 0xe30005dc, 'brighter Auto screen: value above the last point 1500'); // movw r0, #0x5dc
}
