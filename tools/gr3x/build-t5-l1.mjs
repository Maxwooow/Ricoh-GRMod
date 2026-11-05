// SPDX-License-Identifier: GPL-2.0-only
// Local T5-L1 candidate builder. An update filename is assigned only after the
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
  console.error('Usage: node tools/gr3x/build-t5-l1.mjs OFFICIAL.bin NEW-directory PYTHON PINNED-gr-custom-tool-directory');
  process.exit(2);
}
const { buildGr3xTestFirmware } = await import('../../core/src/fw/gr3x/research-package.ts');
const { buildGr3xAdjResearch } = await import('../../core/src/fw/gr3x/adj.ts');
const { openGr3xOfficial } = await import('../../core/src/fw/gr3x/profile.ts');
const { gr3xLookResources } = await import('../../core/src/fw/gr3x/look-resources.ts');
const { Engine } = await import('../../core/src/app/engine.ts');
const { sectionsOf } = await import('../../core/src/fw/container.ts');
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const raw = new Uint8Array(await readFile(input));
const engine = await Engine.open(raw);
const { decoded } = await openGr3xOfficial(raw), resources = gr3xLookResources(decoded);
const films = [], conversions = [], sources = [];
const glyphs = { F: ['111','100','110','100','100'], 1: ['010','110','010','010','111'], 2: ['110','001','010','100','111'] };
for (const [index, name] of ['Demo Warm', 'Demo Cool'].entries()) {
  const filename = name.replace(' ', '-') + '.cube';
  const text = await readFile(join(root, 'examples/gr3x', filename), 'utf8');
  const result = engine.convertPreset('cube', text);
  const icon = resources.tiles.film.slice();
  [...'F' + (index + 1)].forEach((letter, j) => glyphs[letter].forEach((row, y) =>
    [...row].forEach((on, x) => { if (on === '1') for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++)
      icon.set([235,235,235,255], ((12+y*3+dy)*40+9+j*12+x*3+dx)*4); })));
  films.push({ name, icon, preset: { matrixQ13: result.matrixQ13, curves: result.curves } });
  conversions.push({ name, filename, meanDE: result.meanDE, p95DE: result.p95DE, warnings: result.warnings });
  sources.push({ filename, text });
}
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }];
const result = await buildGr3xTestFirmware(raw, soft, { films, monoReplicas: true, displayRevision: 2 });
const target = resolve(directory);
await mkdir(target);
const json = async (name, value) => writeFile(join(target, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, 'UNVALIDATED.bin'), result.bytes, { flag: 'wx' });
await json('patch-manifest.json', result.manifest);
await json('build-report.json', result.report);
await json('CUBE-fit-report.json', conversions);
for (const source of sources) await writeFile(join(target, source.filename), source.text, { flag: 'wx' });
const temporary = await mkdtemp(join(tmpdir(), 'gr3x-t5-l1-'));
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
  if (run.error || run.status !== 0) throw new Error('T5-L1 validation failed; UNVALIDATED.bin is not a released update');
  const summary = JSON.parse(await readFile(join(target, 'validation/summary.json'), 'utf8'));
  if (!summary.all_checks_passed || summary.candidate_sha256 !== result.report.outputSha256) throw new Error('T5-L1 validation/hash mismatch');
  // Fresh Engine inspection must rebuild identical bytes from the embedded recipe.
  const inspected = await (await Engine.open(raw)).inspect(result.bytes);
  if (!inspected.verified || !inspected.monoUnlock) throw new Error('T5-L1 fresh-engine reconstruction failed');
  await json('reconstruction-check.json', { verified: true, sha256: inspected.sha256, monoReplicas: inspected.monoUnlock,
    slotNames: inspected.slots.map(s => s.names.en), hardwareTested: false });
  await copyFile(join(root, 'docs/GR3X_T5-L1_TEST.txt'), join(target, '请先阅读.txt'));
  await writeFile(join(target, 'SHA256SUMS.txt'), result.report.outputSha256 + '  ' + result.report.filename + '\n', { flag: 'wx' });
  await rename(join(target, 'UNVALIDATED.bin'), join(target, result.report.filename));
  console.log(JSON.stringify({ directory: target, sha256: result.report.outputSha256, bytes: result.bytes.length,
    revision: 'T5-L1', nativeCases: summary.native_function_cases, hardwareTested: false, cameraOrCardWritten: false }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
