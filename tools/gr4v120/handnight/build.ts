// SPDX-License-Identifier: GPL-2.0-only
/**
 * A build with Handheld Night for the emulator checks (test_*.py): the engine's own build of an official file, with the layout the
 * checks read (where the module, its context and every stub are).
 *
 *   node node_modules/vite-node/vite-node.mjs tools/gr4v120/handnight/build.ts OFFICIAL.bin OUT_DIR ['{"batteryPercent":true,...}' [off]]
 *
 * Writes OUT_DIR/fwdc248b.bin, OUT_DIR/patched-RTOS.bin (the decoded RTOS section), OUT_DIR/res.bin (the decoded RES section: the
 * camera's fonts, for test_screen.py) and OUT_DIR/manifest.json. The options JSON is
 * added to `handheldNight: true` (other additions in the same build); its `ratios` ([{name, ratio}]) are added ratios. With `off`
 * the same build without Handheld Night (the checks' base build).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engine, fw } from '../../../core/src';
import * as handnight from '../../../core/src/fw/gr4v120/aspect/handnight';
import { release } from '../../../core/src/fw/gr4v120/target';

const [input, output, extra = '{}', which = 'on'] = process.argv.slice(2);
if (!input || !output) throw Error('usage: build.ts OFFICIAL.bin OUT_DIR [OPTIONS_JSON [off]]');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const raw = new Uint8Array(await fs.readFile(input));
const eng = await Engine.open(raw);
if (!eng.info.features.handheldNight) throw Error(`Handheld Night is not offered for ${eng.info.version}`);
// this tool's release (tools/gr4v121/handnight is the 1.21 copy): its program's module instance has the layout of the last install
if (eng.info.version !== release) throw Error(`this is the ${release} tool; ${eng.info.version} is built with its own copy`);
const { ratios = [], ...options } = JSON.parse(extra) as { ratios?: { name: string; ratio: string }[] };
const on = which !== 'off';
// `off` without other additions: the official file itself (the engine has nothing to change)
const bare = !on && Object.keys(options).length === 0 && ratios.length === 0;
const built = bare ? { file: raw, checks: {} } : await eng.buildFirmware([], ratios, [], { ...options, ...(on ? { handheldNight: true } : {}) } as never);
if (!Object.values(built.checks).every((v) => v === true)) throw Error('build checks failed: ' + JSON.stringify(built.checks));
const decoded = new fw.Firmware(built.file).decoded, section = fw.sectionsOf(decoded).find((s) => s.name === 'RTOS')!;
const rtos = decoded.slice(section.offset, section.offset + section.size);
const layout = on ? handnight.HN_LAST_LAYOUT : null;
if (on && !layout) throw Error('no layout recorded');
const hex = (v: number) => '0x' + v.toString(16);
const manifest = {
  design: on ? 'handheldNight (engine build)' : 'base (engine build, without handheldNight)', input: path.basename(input), version: eng.info.version, options: JSON.parse(extra),
  inputSha256: sha(raw), outputSha256: sha(built.file), rtosSha256: sha(rtos), resFiles: fw.sectionsOf(decoded).find((s) => s.name === 'RES')!.size,
  layout: layout ? Object.fromEntries(Object.entries({ ...layout, topDraw: handnight.HN_LAST_LINE }).map(([k, v]) => [k, hex(v as number)])) : {},
};
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'fwdc248b.bin'), built.file);
await fs.writeFile(path.join(output, 'patched-RTOS.bin'), rtos);
const res = fw.sectionsOf(decoded).find((s) => s.name === 'RES')!;
await fs.writeFile(path.join(output, 'res.bin'), decoded.slice(res.offset));
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(JSON.stringify({ version: eng.info.version, on, sha256: manifest.outputSha256, output }));
