// SPDX-License-Identifier: GPL-2.0-only
/**
 * A build with subject recognition for the emulator checks (evaluation/): the engine's own build of an official file,
 * with the layout the checks need read back from the image.
 *
 *   node node_modules/vite-node/vite-node.mjs tools/gr4v121/afplain/build.ts OFFICIAL.bin OUT_DIR ['{"batteryPercent":true,...}']
 *
 * Writes OUT_DIR/fwdc248b.bin, OUT_DIR/patched-RTOS.bin (the decoded RTOS section) and OUT_DIR/manifest.json: the hashes,
 * where the module, model, context, native getter trampoline and each adapter are, and the module's entry and state sizes.
 * The options JSON is added to `subjectAf: true` (other additions in the same build); its `ratios` ([{name, ratio}]) are
 * added ratios (the replay's live-view aspects 7 and 8 exist only with two of them: 65:24 and 2.39:1).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Engine, fw } from '../../../core/src';
import { subjectAfHooks, subjectAfModel, subjectAfModule, SUBJECTAF_FLAGS } from '../../../core/src/fw/gr4v121/aspect/subjectaf';
import { SUBJECTAF_ENTRY, SUBJECTAF_STATE_BYTES, SUBJECTAF_STATIC_BYTES } from '../../../core/src/fw/gr4v121/aspect/subjectaf-code';

const [input, output, extra = '{}'] = process.argv.slice(2);
if (!input || !output) throw Error('usage: build.ts OFFICIAL.bin OUT_DIR [OPTIONS_JSON]');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const eng = await Engine.open(new Uint8Array(await fs.readFile(input)));
if (!eng.info.features.subjectAf) throw Error(`subject recognition is not offered for ${eng.info.version}`);
const { ratios = [], ...options } = JSON.parse(extra) as { ratios?: { name: string; ratio: string }[] };
const built = await eng.buildFirmware([], ratios, [], { ...options, subjectAf: true });
if (!Object.values(built.checks).every((v) => v === true)) throw Error('build checks failed: ' + JSON.stringify(built.checks));
const decoded = new fw.Firmware(built.file).decoded, section = fw.sectionsOf(decoded).find((s) => s.name === 'RTOS')!;
const rtos = decoded.slice(section.offset, section.offset + section.size);
const BASE = 0x53000000, word = (a: number) => new DataView(rtos.buffer).getUint32(a - BASE, true);
const find = (needle: Uint8Array): number => {
  const at = Buffer.from(rtos).indexOf(Buffer.from(needle));
  if (at < 0 || Buffer.from(rtos).indexOf(Buffer.from(needle), at + 1) >= 0) throw Error('module or model not found once in the build');
  return BASE + at;
};
const module = subjectAfModule(), model = subjectAfModel();
const align = (v: number) => Math.ceil(v / 16) * 16;
const moduleAt = find(module), modelAt = align(moduleAt + module.length), context = align(modelAt + model.length);
if (find(model) !== modelAt || word(context) !== 0x31464741 || word(context + 60) !== SUBJECTAF_FLAGS) throw Error('unexpected layout');
const hooks = subjectAfHooks().map((h) => {
  const w = word(h.site), off = ((w & 0xffffff) ^ 0x800000) - 0x800000;
  return { ...h, stub: h.kind === 'vtable' ? w : h.site + 8 + 4 * off, hookWord: w };
});
const origin = 0x54450000;
const manifest = {
  design: 'subjectAf (engine build)', input: path.basename(input), version: eng.info.version, inputSha256: sha(new Uint8Array(await fs.readFile(input))),
  outputSha256: sha(built.file), rtosSha256: sha(rtos),
  switches: { afPlain: true, aiCue: true, aiFrame: true, faceFollow: true }, options: JSON.parse(extra),
  installed: { module: moduleAt, moduleBytes: module.length, model: modelAt, modelBytes: model.length, context, contextBytes: 80,
    nativeGetterTrampoline: context + 80, dispatch: moduleAt + SUBJECTAF_ENTRY, state: word(context + 8), hooks },
  assets: { moduleSha256: sha(module), modelSha256: sha(model) },
  moduleBuild: { code_sha256: sha(module), code_bytes: module.length, layout: { state_bytes: SUBJECTAF_STATE_BYTES, photo_store_offset: SUBJECTAF_STATIC_BYTES },
    maps: [{ origin, symbols: { af_s1_dispatch: origin + SUBJECTAF_ENTRY } }] },
};
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'fwdc248b.bin'), built.file);
await fs.writeFile(path.join(output, 'patched-RTOS.bin'), rtos);
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(JSON.stringify({ version: eng.info.version, sha256: manifest.outputSha256, module: '0x' + moduleAt.toString(16), state: '0x' + manifest.installed.state.toString(16), output }));
