// SPDX-License-Identifier: GPL-2.0-only
/**
 * The six black-and-white looks of the GR IV Monochrome on the colour GR IV (firmware 1.11).
 *
 * The firmware is the same for the three models; looks 25..30 (Monochrome Standard, Soft, High
 * Contrast, Grainy, Solid, HDR) are only hidden on the colour ones. Two things hide them:
 *  - the look-visibility check (0x533CC6E0) branches on the camera model; it now branches on the
 *    look number (looks above 24 take the monochrome-look branch);
 *  - a byte per look in the look table (from 0x53DBF381, 7 bytes apart) marks it unavailable.
 *
 * Found and tested on a camera by GR4-MonoUnlock (github.com/lemonadesaltbagel/GR4-MonoUnlock):
 * Standard, Soft, High Contrast and Solid worked, Grainy was in builds that ran, HDR was not tried.
 * Written here from those eight changes; no code of that project is used.
 */
import { Patch, expectWord } from './build';

const CHECK = 0x533cc6e0;
const LOOK_FLAGS = [0x53dbf381, 0x53dbf388, 0x53dbf38f, 0x53dbf396, 0x53dbf39d, 0x53dbf3a4];

export function installMonoUnlock(patch: Patch): void {
  expectWord(patch, CHECK, 0xe3520000); // cmp r2, #0      (r2: camera is the Monochrome model)
  expectWord(patch, CHECK + 4, 0x1a000019); // bne 0x533cc750 (the monochrome-look branch)
  for (const at of LOOK_FLAGS) {
    const word = patch.word(at & ~3);
    const shift = (at & 3) * 8;
    if (((word >>> shift) & 0xff) !== 0) throw new Error(`look flag at ${at.toString(16)} is not 0`);
  }
  patch.setWord(CHECK, 0xe3510018, 'monochrome looks: look number > 24'); // cmp r1, #24
  patch.setWord(CHECK + 4, 0x8a000019, 'monochrome looks: to the monochrome-look branch'); // bhi
  for (const at of LOOK_FLAGS) {
    const base = at & ~3;
    const shift = (at & 3) * 8;
    patch.setWord(base, (patch.word(base) | (1 << shift)) >>> 0, 'monochrome looks: look available');
  }
}
