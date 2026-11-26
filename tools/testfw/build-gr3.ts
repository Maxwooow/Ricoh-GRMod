// SPDX-License-Identifier: GPL-2.0-only
/**
 * Build a GR III / IIIx test firmware for the camera (development tool, not part of the program).
 *
 *   npx vite-node tools/testfw/build-gr3.ts OFFICIAL.bin OUT.bin '{"customGrid":{...}}' ['[{"ratio":"16:9","name":"16:9"}]']
 *
 * The third argument is `BuildOptions` as JSON; the fourth the added ratios (a GR III build has at
 * least one; default 16:9 and 4:3). Films: with `filmCount` in the options, that many films named
 * Film 1.. (as the golden builds' gr3Recipes, without their colour presets; every fifth from the
 * second with halation). `shutdownPictures` as a number: that many End Screen pictures made from a
 * pattern (as the golden builds'). Writes OUT.bin, OUT.bin.rtos and OUT.bin.iconbin (the decoded RTOS
 * and ICONBIN sections) and prints the SHA-256 and the summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../../core/src';

const [official, out, options = '{}', ratios = '[{"ratio":"16:9","name":"16:9"},{"ratio":"4:3","name":"4:3"}]'] = process.argv.slice(2);
const eng = await Engine.open(new Uint8Array(readFileSync(official)));
if (eng.info.family !== 'gr3x') throw new Error('not a GR III / IIIx file');
const opts = JSON.parse(options);
if (typeof opts.shutdownPictures === 'number') opts.shutdownPictures = Array.from({ length: opts.shutdownPictures }, (_, k) =>
  ({ id: 0x1007 + k, name: `Picture ${k + 1}`, jpeg: eng.encodeMenuPicture(new Uint8Array(720 * 480 * 3).map((_, i) => (i * (7 + k) + (i >> 11)) & 255)) }));
const films = typeof opts.filmCount === 'number' ? eng.info.slots.slice(0, opts.filmCount).map((x, i) => ({ slot: x.id, names: { en: `Film ${i + 1}` }, ...(i % 5 === 1 ? { halation: 1 as const } : {}) })) : [];
const b = await eng.buildFirmware(films as Parameters<typeof eng.buildFirmware>[0], JSON.parse(ratios), [], opts);
writeFileSync(out, b.file);
const d = new fw.Firmware(b.file).decoded;
const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
writeFileSync(out + '.rtos', d.subarray(r.offset, r.offset + r.size));
const ic = fw.sectionsOf(d).find((x) => x.name === 'ICONBIN')!;
writeFileSync(out + '.iconbin', d.subarray(ic.offset, ic.offset + ic.size));
const s = await eng.inspect(b.file);
console.log(JSON.stringify({ model: eng.info.model, version: eng.info.version, sha256: b.sha256, bytes: b.file.length, checks: Object.values(b.checks).every(Boolean), features: b.features,
  inspect: { kind: s.kind, verified: s.verified, ratios: s.ratios.map((x) => x.name) } }));
