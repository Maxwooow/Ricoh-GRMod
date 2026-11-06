// SPDX-License-Identifier: GPL-2.0-only
/**
 * Build a test firmware for the camera (development tool, not part of the program).
 *
 *   npx vite-node tools/testfw/build.ts OFFICIAL.bin OUT.bin '{"adjSoftFocus":true,"dateStamp":true}' [full]
 *
 * The third argument is `BuildOptions` as JSON. With `full`, the build also holds the contents of
 * the earlier test firmware (two presets, four ratios; see core/test/fw-helpers/test-firmware.ts).
 * Writes OUT.bin and OUT.bin.rtos (the decoded RTOS section) and prints the SHA-256 and the summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../../core/src';
import { testPresetRequests, testRatios } from '../../core/test/fw-helpers/test-firmware';

const [official, out, options = '{}', full] = process.argv.slice(2);
const eng = await Engine.open(new Uint8Array(readFileSync(official)));
const withContents = full === 'full';
// The third argument may also be @FILE (JSON in a file); icons of added slots / pictures come as number arrays.
const opts = JSON.parse(options.startsWith('@') ? readFileSync(options.slice(1), 'utf8') : options);
for (const s of opts.extraSlots ?? []) s.icon = Uint8Array.from(s.icon);
for (const p of opts.shutdownPictures ?? []) if (Array.isArray(p.jpeg)) p.jpeg = Uint8Array.from(p.jpeg);
const b = await eng.buildFirmware(withContents ? testPresetRequests(eng) : [], withContents ? testRatios(eng) : [], [], opts);
writeFileSync(out, b.file);
const d = new fw.Firmware(b.file).decoded;
const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
writeFileSync(out + '.rtos', d.subarray(r.offset, r.offset + r.size));
const s = await eng.inspect(b.file);
console.log(JSON.stringify({
  sha256: b.sha256, bytes: b.file.length, checks: Object.values(b.checks).every((v) => v === true), features: b.features,
  inspect: { kind: s.kind, verified: s.verified, adjSoftFocus: s.adjSoftFocus, dateStamp: s.dateStamp, monoUnlock: s.monoUnlock, ratios: s.ratios.map((x) => x.name) },
}));
