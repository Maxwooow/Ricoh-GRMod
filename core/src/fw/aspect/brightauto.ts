// SPDX-License-Identifier: GPL-2.0-only
/**
 * A brighter rear screen when Setup > Outdoor View Setting is Auto (GR IV / HDF / Monochrome, firmware 1.11).
 *
 * The function at 0x5326811c(this, x) maps the ambient-light reading x to a backlight luminance
 * target by piecewise-linear interpolation over an 18-entry table of (x, y) word pairs at
 * 0x53dba138 (stride 8; x = 1, 2, 4, ... 131072, y at 0x53dba13c + 8 * i). x <= 1 returns 53
 * (0x532681cc), x >= 0x20000 returns 1050 (`movw r0,#0x41a` at 0x532681c4), and the result is
 * clamped to 1050 (`movw r3,#0x41a` at 0x532681a4). The `mov r3,#10` / mul / divide-by-10 at
 * 0x53268198 is left alone.
 *
 * This replaces the 18 y words with a brighter curve and raises the two 1050 limits to 1500, the
 * value the fixed Outdoor View +2 already uses (+1 uses 800), so the panel is driven that far
 * already. Data and two immediates only; no code is added. Read from a disassembly of the official
 * 1.11 file; not tried on a camera.
 */
import { Patch, expectWord } from './build';

export const CURVE_X = 0x53dba138;
const CURVE_Y = 0x53dba13c;
const CLAMP = 0x532681a4;
const TOP = 0x532681c4;

/** x values of the table (powers of two). */
export const BRIGHT_AUTO_X = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
export const OFFICIAL_AUTO_Y = [53, 63, 75, 90, 110, 150, 210, 260, 280, 285, 290, 320, 356, 470, 610, 770, 930, 1050];
export const BRIGHT_AUTO_Y = [53, 65, 80, 100, 140, 210, 300, 400, 480, 540, 600, 660, 740, 840, 970, 1130, 1320, 1500];

export const BRIGHT_AUTO_CLAMP = { address: CLAMP, official: 0xe300341a, bright: 0xe30035dc };
export const BRIGHT_AUTO_TOP = { address: TOP, official: 0xe300041a, bright: 0xe30005dc };

export function installBrightAuto(patch: Patch): void {
  for (let i = 0; i < BRIGHT_AUTO_X.length; i++) {
    expectWord(patch, CURVE_X + 8 * i, BRIGHT_AUTO_X[i]);
    expectWord(patch, CURVE_Y + 8 * i, OFFICIAL_AUTO_Y[i]);
  }
  expectWord(patch, CLAMP, 0xe300341a); // movw r3, #0x41a
  expectWord(patch, TOP, 0xe300041a); // movw r0, #0x41a
  for (let i = 1; i < BRIGHT_AUTO_Y.length; i++) if (BRIGHT_AUTO_Y[i] < BRIGHT_AUTO_Y[i - 1]) throw new Error('bright auto curve must not decrease');
  for (let i = 0; i < BRIGHT_AUTO_Y.length; i++) {
    if (BRIGHT_AUTO_Y[i] !== OFFICIAL_AUTO_Y[i]) patch.setWord(CURVE_Y + 8 * i, BRIGHT_AUTO_Y[i], `brighter Auto screen: curve point ${i}`);
  }
  patch.setWord(CLAMP, 0xe30035dc, 'brighter Auto screen: upper limit 1500'); // movw r3, #0x5dc
  patch.setWord(TOP, 0xe30005dc, 'brighter Auto screen: value above the last point 1500'); // movw r0, #0x5dc
}
