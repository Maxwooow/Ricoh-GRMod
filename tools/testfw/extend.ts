// SPDX-License-Identifier: GPL-2.0-only
/**
 * Rebuild a verified test firmware of this program with more additions (development tool, not part
 * of the program).
 *
 *   npx vite-node tools/testfw/extend.ts OFFICIAL.bin IN.bin OUT.bin '{"directFlash":true}' ['{"directFlashDiag":true}']
 *
 * Everything IN.bin holds (presets, slots, ratios, menus, ...) is kept; the additions given as JSON
 * (`ExtensionFeatures`) are added. Writes OUT.bin and OUT.bin.rtos (decoded RTOS) and prints the
 * SHA-256 and what the program reads back from OUT.bin.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../../core/src';

const [official, input, out, add = '{}', test = '{}'] = process.argv.slice(2);
const eng = await Engine.open(new Uint8Array(readFileSync(official)));
const file = await eng.extendVerified(new Uint8Array(readFileSync(input)), JSON.parse(add), JSON.parse(test));
writeFileSync(out, file);
const d = new fw.Firmware(file).decoded;
const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
writeFileSync(out + '.rtos', d.subarray(r.offset, r.offset + r.size));
const s = await eng.inspect(file);
console.log(JSON.stringify({
  sha256: s.sha256, bytes: file.length, kind: s.kind, verified: s.verified, adjSoftFocus: s.adjSoftFocus, dateStamp: s.dateStamp,
  monoUnlock: s.monoUnlock, ratios: s.ratios.map((x) => x.name), extraSlots: s.extraSlots.length, lookLayout: !!s.lookLayout,
  shutdownPictures: s.shutdownPictures?.length ?? 0, directFlash: !!s.directFlash,
  slots: s.slots.map((x) => ({ id: x.id, name: x.names.en, colorChanged: x.colorChanged })),
}));
