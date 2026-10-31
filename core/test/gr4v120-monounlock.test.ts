// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR IV 1.20, B&W looks unlocked: the availability table rows of the six monochrome looks (3..8)
 * and of Solarized (10, the GR IV Monochrome 1.10 look) get every model column but the
 * Monochrome's; Pictorialist (row 9, no model in the official firmware) and every other row stay
 * as they are, and nothing outside the table and the visibility check is written.
 *
 * Needs the official 1.20 file at testdata/private/official120.bin (or GRMOD_GR4_120_FIRMWARE).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Firmware, monoUnlockWords } from '../src/fw/gr4v120';
import { RTOS_OFFSET } from '../src/fw/gr4v120/profile';

const path = process.env.GRMOD_GR4_120_FIRMWARE ?? new URL('../testdata/private/official120.bin', import.meta.url).pathname;
const TABLE = 0x53de9cc4;
const CHECK = 0x533de144;
const off = (va: number): number => RTOS_OFFSET + va - 0x53000000;

describe('GR IV 1.20 B&W looks', () => {
  it.skipIf(!existsSync(path))('unlocks the six looks and Solarized, not Pictorialist', () => {
    const dec = new Firmware(new Uint8Array(readFileSync(path))).decoded;
    const out = dec.slice();
    for (const w of monoUnlockWords(dec)) out.set(w.bytes, w.offset);
    const row = (d: Uint8Array, r: number): number[] => [...d.subarray(off(TABLE + r * 7), off(TABLE + r * 7) + 7)];
    for (let r = 0; r < 13; r++) {
      if ((r >= 3 && r <= 8) || r === 10) {
        expect(row(dec, r), `row ${r} official`).toEqual([0, 1, 0, 0, 0, 0, 0]);
        expect(row(out, r), `row ${r} unlocked`).toEqual([1, 1, 1, 1, 1, 1, 1]);
      } else {
        expect(row(out, r), `row ${r} unchanged`).toEqual(row(dec, r));
      }
    }
    expect(row(dec, 9)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // Only the check (2 words) and the table's words differ.
    const lo = off(TABLE + 3 * 7) & ~3, hi = (off(TABLE + 11 * 7) + 3) & ~3;
    for (let i = 0; i < dec.length; i++) {
      if (dec[i] === out[i]) continue;
      const inCheck = i >= off(CHECK) && i < off(CHECK) + 8;
      expect(inCheck || (i >= lo && i < hi), `byte 0x${i.toString(16)}`).toBe(true);
    }
  });
});
