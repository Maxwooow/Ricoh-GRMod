// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR Mod's reference of the halation module (halateYcc, core/src/fw/gr4v120/aspect/halation.ts) for
 * tools/gr4v120/halation/check.py: reads a case (JSON) and the picture's planes, writes the planes after.
 *
 *   npx tsx tools/gr4v120/halation/ref.mts CASE.json   {w, h, level, colour, white, table, strong, y, c, outY, outC}
 *
 * `table` / `strong` are the look's light tables as the built image holds them (base64 of 256
 * little-endian u16), so the reference runs on exactly the module's data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { halateYcc } from '../../../core/src/fw/gr4v120/aspect/halation';

const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const u16 = (b64: string | null): Uint16Array | undefined => {
  if (!b64) return undefined;
  const b = Buffer.from(b64, 'base64');
  return Uint16Array.from({ length: 256 }, (_, i) => b[2 * i] | (b[2 * i + 1] << 8));
};
const Y = new Uint8Array(readFileSync(c.y)), C = new Uint8Array(readFileSync(c.c));
halateYcc(Y, C, c.w, c.h, c.level, { table: u16(c.table)!, strong: u16(c.strong) }, c.colour, c.white);
writeFileSync(c.outY, Y);
writeFileSync(c.outC, C);
