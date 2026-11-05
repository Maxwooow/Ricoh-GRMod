// SPDX-License-Identifier: GPL-2.0-only
/**
 * The six black-and-white looks of the GR IV Monochrome on the colour GR IV (firmware 1.20).
 *
 * The firmware is the same for the three models; looks 25..30 (Monochrome Standard, Soft, High
 * Contrast, Grainy, Solid, HDR) are only hidden on the colour ones. Two things hide them:
 *  - the look-visibility check (0x533DE144) branches on the camera model; it now branches on the
 *    look number (looks above 24 take the monochrome-look branch);
 *  - the availability table (0x53DE9CC4, read by 0x533F1DC8): one row of 7 bytes per entry, one
 *    byte per camera model (column 1 is the Monochrome). Rows 3..8 are the six looks; only the
 *    Monochrome's column is set.
 * 1.20 added two looks to the monochrome branch:
 *  - 32, Solarized (row 10, set for the Monochrome only; GR IV Monochrome 1.10 offers it with its
 *    three types). Row 10 is read only by this visibility check, so it is unlocked like the six
 *    looks: every column but the Monochrome's is set (0.8.8; before, the look stayed hidden on the
 *    colour models while GR Mod listed it with the monochrome looks).
 *  - 31, Pictorialist (row 9): no column is set in the official firmware, not even the
 *    Monochrome's, and row 9 is read in four other places as well; Ricoh has not released it, so it
 *    is left alone (hidden on every model).
 *
 * Found and tested on a camera by GR4-MonoUnlock (github.com/lemonadesaltbagel/GR4-MonoUnlock):
 * Standard, Soft, High Contrast and Solid worked, Grainy was in builds that ran, HDR was not tried.
 * That project sets column 0 only (the standard GR IV); on a GR IV HDF the looks stayed hidden
 * (tried with GR Mod test firmware 012), so here every column but the Monochrome's is set.
 * Written here from those changes; no code of that project is used.
 */
import { Patch, expectWord } from './build';

const CHECK = 0x533de144;
const TABLE = 0x53de9cc4;
const MONOCHROME_COLUMN = 1;
/** Rows 3..8 (the six looks) and 10 (Solarized), every column but the Monochrome's. */
const ROWS = [3, 4, 5, 6, 7, 8, 10];
const LOOK_FLAGS: number[] = [];
for (const row of ROWS) for (let col = 0; col < 7; col++) if (col !== MONOCHROME_COLUMN) LOOK_FLAGS.push(TABLE + row * 7 + col);

export function installMonoUnlock(patch: Patch): void {
  expectWord(patch, CHECK, 0xe3520000); // cmp r2, #0      (r2: camera is the Monochrome model)
  expectWord(patch, CHECK + 4, 0x1a000019); // bne 0x533de1b4 (the monochrome-look branch)
  for (const row of ROWS) {
    if (patch.read(TABLE + row * 7, 7).join(',') !== '0,1,0,0,0,0,0') throw new Error(`availability row ${row} is not the official one`);
  }
  // 32 (Solarized) goes through the table: `mov r1, #10 ; ... ; b 0x533F1DC8`.
  expectWord(patch, 0x533de080 + (32 - 25) * 4, 0x533de0b8);
  expectWord(patch, 0x533de0b8, 0xe3a0100a);
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
