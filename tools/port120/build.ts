// SPDX-License-Identifier: GPL-2.0-only
/**
 * Build a firmware file for the emulator checks (development tool, not part of the program).
 *
 *   npx vite-node tools/port120/build.ts OFFICIAL.bin OUT.bin [OPTIONS-JSON] [RATIOS-JSON] [PICTURES]
 *
 * OPTIONS is `BuildOptions` (without the pictures), RATIOS a list of {name, ratio}, PICTURES a
 * number of synthetic power-off pictures. OFFICIAL is the official 1.11 or 1.20 file. Writes
 * OUT.bin, OUT.bin.rtos and OUT.bin.iconbin (decoded sections) and prints a summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../../core/src';
import type { ShutdownPictureSpec } from '../../core/src/fw';

const [official, out, options = '{}', ratios = '[]', pictures = '0'] = process.argv.slice(2);

function picture(seed: number): Uint8Array {
  const rgb = new Uint8Array(720 * 480 * 3);
  for (let y = 0; y < 480; y++) for (let x = 0; x < 720; x++) {
    const i = (y * 720 + x) * 3;
    rgb[i] = (x * seed) & 255;
    rgb[i + 1] = (y * 2 + seed * 40) & 255;
    rgb[i + 2] = Math.hypot(x - 360, y - 240) < 100 ? 255 : 30;
  }
  return rgb;
}

const eng = await Engine.open(new Uint8Array(readFileSync(official)));
const n = Number(pictures);
const shutdownPictures: ShutdownPictureSpec[] = Array.from({ length: n }, (_, k) => ({ id: 0x300 + 11 * k, name: `Picture ${k + 1}`, jpeg: fw.aspect.encodeShutdownPicture(picture(k + 2)) }));
const b = await eng.buildFirmware([], JSON.parse(ratios), [], { ...JSON.parse(options), ...(n > 0 ? { shutdownPictures } : {}) });
writeFileSync(out, b.file);
const d = new fw.Firmware(b.file).decoded;
for (const name of ['RTOS', 'ICONBIN']) {
  const r = fw.sectionsOf(d).find((x) => x.name === name)!;
  writeFileSync(`${out}.${name.toLowerCase()}`, d.subarray(r.offset, r.offset + r.size));
}
const s = await eng.inspect(b.file);
console.log(JSON.stringify({
  target: eng.info.target, sha256: b.sha256, bytes: b.file.length, checks: Object.values(b.checks).every((v) => v === true),
  inspect: { kind: s.kind, verified: s.verified, adjSoftFocus: s.adjSoftFocus, dateStamp: s.dateStamp, ratios: s.ratios.map((x) => x.name), pictures: (s.shutdownPictures ?? []).length },
}));
