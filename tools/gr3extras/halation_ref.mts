// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR Mod's reference of the halation module (halateYcc, core/src/fw/aspect/halation.ts) for
 * tools/gr3extras/halation_check.py, as tools/halation/ref.mts but for a list of cases at once:
 *
 *   npx tsx tools/gr3extras/halation_ref.mts CASES.json   [{w, h, level, colour, white, table, strong, y, c, outY, outC}, ...]
 *
 * `table` / `strong` are the film's light tables as the built image holds them (base64 of 256
 * little-endian u16); `white` is 'scatter' (GR Mod 0.9) or 'classic' (the 0.8.2 glow).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { halateYcc } from '../../core/src/fw/aspect/halation';

const u16 = (b64: string | null): Uint16Array | undefined => {
  if (!b64) return undefined;
  const b = Buffer.from(b64, 'base64');
  return Uint16Array.from({ length: 256 }, (_, i) => b[2 * i] | (b[2 * i + 1] << 8));
};
for (const c of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  const Y = new Uint8Array(readFileSync(c.y)), C = new Uint8Array(readFileSync(c.c));
  halateYcc(Y, C, c.w, c.h, c.level, { table: u16(c.table)!, strong: u16(c.strong) }, c.colour, c.white);
  writeFileSync(c.outY, Y);
  writeFileSync(c.outC, C);
}
