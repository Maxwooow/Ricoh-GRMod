// SPDX-License-Identifier: GPL-2.0-only
/**
 * Development tool for menu_check.py: a GR III / IIIx build with two End Screen pictures (whose submenu changes the
 * Setup tab, which the wide menus must carry over), films and the given options; writes OUT.bin.rtos.
 *
 *   npx vite-node tools/gr3extras/build_pictures.mts OFFICIAL.bin OUT.bin '{"adjSoftFocus":true,...}' FILMS
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../../core/src';

const [official, out, options = '{}', films = '0'] = process.argv.slice(2);
const eng = await Engine.open(new Uint8Array(readFileSync(official)));
const rgb = new Uint8Array(720 * 480 * 3).map((_, i) => (i * 7) & 255);
const jpeg = eng.encodeMenuPicture(rgb);
const pictures = [{ id: 0x9000001, name: 'Pic 1', jpeg }, { id: 0x9000002, name: 'Pic 2', jpeg }];
const b = await eng.buildFirmware([], [{ ratio: '16:9', name: '16:9' }, { ratio: '4:3', name: '4:3' }], [], { ...JSON.parse(options), filmCount: Number(films), shutdownPictures: pictures });
writeFileSync(out, b.file);
const d = new fw.Firmware(b.file).decoded;
const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
writeFileSync(out + '.rtos', d.subarray(r.offset, r.offset + r.size));
console.log(JSON.stringify({ sha256: b.sha256, checks: Object.values(b.checks).every(Boolean), features: b.features }));
