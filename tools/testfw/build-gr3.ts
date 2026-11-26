// SPDX-License-Identifier: GPL-2.0-only
/**
 * Build a GR III / IIIx test firmware for the camera (development tool, not part of the program).
 *
 *   npx vite-node tools/testfw/build-gr3.ts OFFICIAL.bin OUT.bin '{"customGrid":{...}}' ['[{"ratio":"16:9","name":"16:9"}]']
 *
 * The third argument is `BuildOptions` as JSON; the fourth the added ratios (a GR III build has at
 * least one; default 16:9 and 4:3). No films. Writes OUT.bin and OUT.bin.rtos (the decoded RTOS
 * section) and prints the SHA-256 and the summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../../core/src';

const [official, out, options = '{}', ratios = '[{"ratio":"16:9","name":"16:9"},{"ratio":"4:3","name":"4:3"}]'] = process.argv.slice(2);
const eng = await Engine.open(new Uint8Array(readFileSync(official)));
if (eng.info.family !== 'gr3x') throw new Error('not a GR III / IIIx file');
const b = await eng.buildFirmware([], JSON.parse(ratios), [], JSON.parse(options));
writeFileSync(out, b.file);
const d = new fw.Firmware(b.file).decoded;
const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
writeFileSync(out + '.rtos', d.subarray(r.offset, r.offset + r.size));
const s = await eng.inspect(b.file);
console.log(JSON.stringify({ model: eng.info.model, version: eng.info.version, sha256: b.sha256, bytes: b.file.length, checks: Object.values(b.checks).every(Boolean), features: b.features,
  inspect: { kind: s.kind, verified: s.verified, ratios: s.ratios.map((x) => x.name) } }));
