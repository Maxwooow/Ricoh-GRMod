// SPDX-License-Identifier: GPL-2.0-only
/**
 * RTOS images for tools/gr4v120/adjslots/check.py (development tool, not part of the program).
 *
 *   npx vite-node tools/gr4v120/adjslots/images.ts OFFICIAL.bin OUT-DIR
 *
 * Writes OUT-DIR/official.rtos, n5.rtos (the controller changes of `adjslots.ts` with the camera's
 * five slots: the new code must behave as the official), n6.rtos .. n8.rtos (the settings guard and
 * N slots, nothing else), n8sf.rtos (with soft focus on the ADJ lever) and n8all.rtos (with every
 * other addition that touches the menus: date imprint, Direct Flash, power-off pictures need a
 * project, so not here).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fw } from '../../../core/src';
import { Patch, installAdjSlots, installExtensions } from '../../../core/src/fw/gr4v120/aspect';

const [official, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const firmware = new fw.Firmware(new Uint8Array(readFileSync(official)));
const d = firmware.decoded;
const section = (name: string): Uint8Array => {
  const s = fw.sectionsOf(d).find((x) => x.name === name)!;
  return d.slice(s.offset, s.offset + s.size);
};
const rtos = section('RTOS');
const iconbin = section('ICONBIN');
writeFileSync(`${out}/official.rtos`, rtos);
const p = new Patch(rtos);
installAdjSlots(p, 5, { menu: false });
writeFileSync(`${out}/n5.rtos`, p.bytes());
for (const n of [6, 7, 8]) writeFileSync(`${out}/n${n}.rtos`, installExtensions(rtos, iconbin, [], { guard: true, adjSlots: n }).rtos);
writeFileSync(`${out}/n8sf.rtos`, installExtensions(rtos, iconbin, [], { guard: true, adjSlots: 8, adjSoftFocus: true }).rtos);
writeFileSync(`${out}/n8all.rtos`, installExtensions(rtos, iconbin, [], { guard: true, adjSlots: 8, adjSoftFocus: true, dateStamp: true, directFlash: true }).rtos);
writeFileSync(`${out}/n5all.rtos`, installExtensions(rtos, iconbin, [], { guard: true, adjSoftFocus: true, dateStamp: true, directFlash: true }).rtos);
console.log('ok');
