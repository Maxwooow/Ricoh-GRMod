// SPDX-License-Identifier: GPL-2.0-only
// Local T6 candidate builder. An update filename is assigned only after the
// independent codec, native loader, T4 regressions and new look probes pass.
import { registerHooks } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
registerHooks({ resolve(s, c, next) {
  try { return next(s, c); } catch (error) {
    if (s.startsWith('.') && !/\.[a-z]+$/i.test(s)) for (const suffix of ['.ts', '/index.ts']) {
      try { return next(s + suffix, c); } catch { /* try the next extension */ }
    }
    throw error;
  }
} });
const [input, directory, python, reference, ...extra] = process.argv.slice(2);
if (!input || !directory || !python || !reference || extra.length) {
  console.error('Usage: node tools/gr3x/build-t6.mjs OFFICIAL.bin NEW-directory PYTHON PINNED-gr-custom-tool-directory');
  process.exit(2);
}
const { buildGr3xTestFirmware } = await import('../../core/src/fw/gr3x/research-package.ts');
const { buildGr3xAdjResearch } = await import('../../core/src/fw/gr3x/adj.ts');
const { openGr3xOfficial } = await import('../../core/src/fw/gr3x/profile.ts');
const { gr3xLookResources } = await import('../../core/src/fw/gr3x/look-resources.ts');
const { gr3xFilmIcon, T6_FILM_NAMES } = await import('../../core/src/fw/gr3x/film-icons.ts');
const { sha256Hex } = await import('../../core/src/fw/container.ts');
const { Engine } = await import('../../core/src/app/engine.ts');
const { sectionsOf } = await import('../../core/src/fw/container.ts');
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const raw = new Uint8Array(await readFile(input));
const engine = await Engine.open(raw);
const { decoded } = await openGr3xOfficial(raw), resources = gr3xLookResources(decoded);
const films = [], conversions = [], sources = [];
const provenance = JSON.parse(await readFile(join(root, 'examples/gr3x/T6/SOURCES.json'), 'utf8'));
for (const [index, name] of T6_FILM_NAMES.entries()) {
  const source = provenance[index];
  if (source.name !== name) throw new Error('T6 source order changed');
  const filename = source.file;
  const text = await readFile(join(root, 'examples/gr3x/T6', filename), 'utf8');
  if (await sha256Hex(new TextEncoder().encode(text)) !== source.cube_sha256) throw new Error('T6 source hash changed');
  const result = engine.convertPreset('cube', text);
  const icon = gr3xFilmIcon(resources.tiles.film, index);
  films.push({ name, icon, preset: { matrixQ13: result.matrixQ13, curves: result.curves } });
  conversions.push({ name, filename, source: source.source, sourceSha256: source.cube_sha256,
    meanDE: result.meanDE, p95DE: result.p95DE, warnings: result.warnings, hardwareTested: false });
  sources.push({ filename, text });
}
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }];
const result = await buildGr3xTestFirmware(raw, soft, { films, monoReplicas: false, displayRevision: 3 });
const target = resolve(directory);
await mkdir(target);
const json = async (name, value) => writeFile(join(target, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, 'UNVALIDATED.bin'), result.bytes, { flag: 'wx' });
await json('patch-manifest.json', result.manifest);
await json('build-report.json', result.report);
await json('CUBE-fit-report.json', conversions);
await json('SOURCES.json', provenance);
await copyFile(join(root, 'examples/gr3x/T6/ICON-SOURCES.json'), join(target, 'ICON-SOURCES.json'));
await mkdir(join(target, 'CUBE'));
await mkdir(join(target, 'icons'));
for (const film of films) await writeFile(join(target, 'icons', film.name.replaceAll(' ', '-') + '.rgba'), film.icon, { flag: 'wx' });
await copyFile(join(root, 'examples/gr3x/T6/LICENSE-t3mujinpack.txt'), join(target, 'LICENSE-t3mujinpack.txt'));
for (const source of sources) await writeFile(join(target, 'CUBE', source.filename), source.text, { flag: 'wx' });
const temporary = await mkdtemp(join(tmpdir(), 'gr3x-t6-'));
try {
  for (const name of ['RTOS', 'BOOT']) {
    const section = sectionsOf(decoded).find(s => s.name === name);
    if (!section) throw new Error('Missing original section: ' + name);
    await writeFile(join(temporary, name.toLowerCase() + '.bin'), decoded.subarray(section.offset, section.offset + section.size));
  }
  await writeFile(join(temporary, 'base.json'), JSON.stringify(await buildGr3xAdjResearch(raw)));
  const run = spawnSync(python, [join(here, 'validate_test.py'), '--official', resolve(input),
    '--container', join(target, 'UNVALIDATED.bin'), '--manifest', join(target, 'patch-manifest.json'),
    '--build-report', join(target, 'build-report.json'), '--rtos', join(temporary, 'rtos.bin'),
    '--boot', join(temporary, 'boot.bin'), '--reference', resolve(reference),
    '--base-look-manifest', join(temporary, 'base.json'), '--output', join(target, 'validation')],
    { stdio: 'inherit', timeout: 600000 });
  if (run.error || run.status !== 0) throw new Error('T6 validation failed; UNVALIDATED.bin is not a released update');
  const summary = JSON.parse(await readFile(join(target, 'validation/summary.json'), 'utf8'));
  if (!summary.all_checks_passed || summary.candidate_sha256 !== result.report.outputSha256) throw new Error('T6 validation/hash mismatch');
  // Fresh Engine inspection must rebuild identical bytes from the embedded recipe.
  const inspected = await (await Engine.open(raw)).inspect(result.bytes);
  if (!inspected.verified || inspected.monoUnlock || inspected.slots.length !== 9 || inspected.slots.some((s, i) => s.names.en !== T6_FILM_NAMES[i])) throw new Error('T6 fresh-engine reconstruction failed');
  await json('reconstruction-check.json', { verified: true, sha256: inspected.sha256, monoReplicas: inspected.monoUnlock,
    slotNames: inspected.slots.map(s => s.names.en), hardwareTested: false });
  await copyFile(join(root, 'docs/GR3X_T6_TEST.txt'), join(target, '请先阅读.txt'));
  await writeFile(join(target, 'SHA256SUMS.txt'), result.report.outputSha256 + '  fwdc243b.bin\n', { flag: 'wx' });
  await rename(join(target, 'UNVALIDATED.bin'), join(target, 'fwdc243b.bin'));
  console.log(JSON.stringify({ directory: target, sha256: result.report.outputSha256, bytes: result.bytes.length,
    revision: 'T6', nativeCases: summary.native_function_cases, hardwareTested: false, cameraOrCardWritten: false }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
