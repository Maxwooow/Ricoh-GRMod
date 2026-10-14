// SPDX-License-Identifier: GPL-2.0-only
// T6-C1 is a colour-data release within the T6 container/recipe format.
// It deliberately leaves the engine and existing T6 reconstruction unchanged.
import { registerHooks } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
registerHooks({ resolve(s, c, next) {
  try { return next(s, c); } catch (error) {
    if (s.startsWith('.') && !/\.[a-z]+$/i.test(s)) for (const suffix of ['.ts', '/index.ts']) {
      try { return next(s + suffix, c); } catch { /* try next */ }
    }
    throw error;
  }
} });
const [input, t6Input, directory, python, reference, ...extra] = process.argv.slice(2);
if (!input || !t6Input || !directory || !python || !reference || extra.length)
  throw new Error('Usage: node build-t6-c1.mjs OFFICIAL.bin RELEASED-T6.bin NEW-directory PYTHON PINNED-gr-custom-tool-directory');
const { buildGr3xTestFirmware } = await import('../../core/src/fw/gr3x/research-package.ts');
const { buildGr3xAdjResearch } = await import('../../core/src/fw/gr3x/adj.ts');
const { openGr3xOfficial, GR3X_160 } = await import('../../core/src/fw/gr3x/profile.ts');
const { readGr3xLookRecipe } = await import('../../core/src/fw/gr3x/look-recipe.ts');
const { T6_FILM_NAMES } = await import('../../core/src/fw/gr3x/film-icons.ts');
const { Engine } = await import('../../core/src/app/engine.ts');
const { Firmware, sectionsOf, sha256Hex } = await import('../../core/src/fw/container.ts');
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const raw = new Uint8Array(await readFile(input)), t6 = new Uint8Array(await readFile(t6Input));
const t6Sha = await sha256Hex(t6);
assert.equal(t6Sha, 'b236813463a3da13d9d3000a0769f655654e7a10f855efb1e4def48f7694aa37', 'Only the released, camera-tested T6 is a valid predecessor');
const engine = await Engine.open(raw), t6Decoded = new Firmware(t6).decoded;
const rt6 = sectionsOf(t6Decoded).find(s => s.name === 'RTOS');
assert(rt6);
const previous = readGr3xLookRecipe(t6Decoded.subarray(rt6.offset + GR3X_160.rtosLength, rt6.offset + rt6.size));
assert(previous && previous.displayRevision === 3 && !previous.monoReplicas && previous.films.length === 9);
assert.deepEqual(previous.films.map(f => f.name), [...T6_FILM_NAMES]);
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }];
const baseline = await buildGr3xTestFirmware(raw, soft, previous);
assert.equal(baseline.report.outputSha256, t6Sha, 'Current source must reproduce T6 before changing any data');
const correctionPath = join(root, 'examples/gr3x/T6-C1');
const correction = JSON.parse(await readFile(join(correctionPath, 'correction.json'), 'utf8'));
const correctedName = 'CineStill-800T-T6-C1.cube';
const cube = await readFile(join(correctionPath, correctedName), 'utf8');
assert.equal(await sha256Hex(new TextEncoder().encode(cube)), correction.correctedCubeSha256);
assert.deepEqual(previous.films[8].preset.matrixQ13, correction.before.matrixQ13);
assert.deepEqual(previous.films[8].preset.curves, correction.before.curves);
const conversion = engine.convertPreset('cube', cube);
assert.deepEqual([...conversion.matrixQ13], correction.after.matrixQ13);
assert.deepEqual(conversion.curves.map(c => [...c]), correction.after.curves);
const films = previous.films.map((f, i) => i === 8 ? { ...f, preset: { matrixQ13: conversion.matrixQ13, curves: conversion.curves } } : f);
const result = await buildGr3xTestFirmware(raw, soft, { ...previous, films });
const target = resolve(directory);
await mkdir(target);
const json = (name, value) => writeFile(join(target, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, 'UNVALIDATED.bin'), result.bytes, { flag: 'wx' });

// Exact scope gate: old ROM, executable hooks, all runtime code, geometry, RAW,
// native controls, eight films and all icons must be byte-identical to T6.
assert.deepEqual(result.manifest.sites, baseline.manifest.sites);
assert.deepEqual(result.manifest.iconAddition, baseline.manifest.iconAddition);
assert.deepEqual(result.manifest.addedLooks, baseline.manifest.addedLooks);
assert.deepEqual(result.manifest.ratios, baseline.manifest.ratios);
for (let i = 0; i < 8; i++) assert.deepEqual(films[i], previous.films[i]);
for (let i = 0; i < 9; i++) assert.deepEqual(films[i].icon, previous.films[i].icon);
assert.equal(result.manifest.append.address, baseline.manifest.append.address);
const oldApp = Buffer.from(baseline.manifest.append.bytes, 'hex'), newApp = Buffer.from(result.manifest.append.bytes, 'hex');
assert.equal(newApp.length, oldApp.length);
const slot = result.manifest.addedLooks[8], appBase = result.manifest.append.address;
const matrixAt = oldApp.readUInt32LE(slot.record - appBase + 4) - appBase;
const curveAt = slot.curves - appBase;
const allowedRuntime = [[matrixAt, 18], [curveAt, 1536]];
let runtimeChanged = 0;
for (let i = 0; i < oldApp.length; i++) if (oldApp[i] !== newApp[i]) {
  assert(allowedRuntime.some(([at, size]) => i >= at && i < at + size), `Unexpected runtime change at ${i}`);
  runtimeChanged++;
}
assert(runtimeChanged > 0);
const finalDecoded = new Firmware(result.bytes).decoded;
const sections = sectionsOf(finalDecoded), rt = sections.find(s => s.name === 'RTOS');
assert.deepEqual(sections, sectionsOf(t6Decoded), 'Section boundaries must remain identical');
const recipeStart = rt.offset + GR3X_160.rtosLength + oldApp.length;
const scopeRanges = allowedRuntime.map(([at, size]) => ({ what: 'CineStill ' + (size === 18 ? 'matrix' : 'curves'),
  offset: rt.offset + GR3X_160.rtosLength + at, length: size }));
scopeRanges.push({ what: 'embedded reproducible recipe/padding', offset: recipeStart, length: rt.offset + rt.size - 4 - recipeStart },
  { what: 'RTOS payload checksum', offset: rt.offset + rt.size - 4, length: 4 });
let decodedChanged = 0;
for (let i = 0; i < finalDecoded.length; i++) if (finalDecoded[i] !== t6Decoded[i]) {
  assert(scopeRanges.some(r => i >= r.offset && i < r.offset + r.length), `Unexpected decoded change at ${i}`);
  decodedChanged++;
}
const newRecipe = readGr3xLookRecipe(finalDecoded.subarray(rt.offset + GR3X_160.rtosLength, rt.offset + rt.size));
for (let i = 0; i < 8; i++) assert.deepEqual(newRecipe.films[i], previous.films[i]);
assert.deepEqual(newRecipe.films[8].icon, previous.films[8].icon);
assert.equal(newRecipe.films[8].name, previous.films[8].name);
const scope = { verified: true, predecessorSha256: t6Sha, outputSha256: result.report.outputSha256,
  onlyChangedFilm: 'CineStill 800T', eightOtherPresetsByteIdentical: true, allNineIconsByteIdentical: true,
  executablePatchSitesByteIdentical: true, allOtherRuntimeCodeAndDataByteIdentical: true,
  originalFirmwareAreasByteIdenticalToT6: true, geometryAndRawHandlingByteIdentical: true,
  softFocusByteIdentical: true, sectionBoundariesIdentical: true, runtimeChangedBytes: runtimeChanged,
  decodedChangedBytes: decodedChanged, allowedDecodedRanges: scopeRanges, cameraTested: false };
const report = { ...result.report, releaseRevision: 'T6-C1', predecessorSha256: t6Sha,
  predecessorHardwareEvidence: 'The owner installed T6 and captured R0001542-R0001552; all 11 JPG/DNG pairs decode, full 3:2 colour RAW retained. R0001544-R0001552 are the nine films in order. CineStill is dark/green; this colour-only C1 correction awaits a new physical test.',
  scope: 'T6-C1 changes only CineStill matrix/curve data and the embedded rebuild recipe/checksum. Other eight films, all icons, native controls, T4 geometry/full RAW and SF1 are exact T6 copies.' };
await json('patch-manifest.json', result.manifest);
await json('build-report.json', report);
await json('T6-preservation-check.json', scope);
await copyFile(join(correctionPath, 'correction.json'), join(target, 'CineStill-correction.json'));
const provenance = JSON.parse(await readFile(join(root, 'examples/gr3x/T6/SOURCES.json'), 'utf8'));
const conversions = [];
await mkdir(join(target, 'CUBE'));
await mkdir(join(target, 'icons'));
for (let i = 0; i < 9; i++) {
  const p = provenance[i];
  if (i === 8) {
    p.derived_from_cube_sha256 = p.cube_sha256;
    p.file = correctedName;
    p.cube_sha256 = correction.correctedCubeSha256;
    p.local_adaptation = 'T6-C1 neutral-axis correction and smooth shadow/midtone lift; camera test pending';
    await writeFile(join(target, 'CUBE', correctedName), cube, { flag: 'wx' });
  } else {
    const source = await readFile(join(root, 'examples/gr3x/T6', p.file));
    assert.equal(await sha256Hex(source), p.cube_sha256);
    await writeFile(join(target, 'CUBE', p.file), source, { flag: 'wx' });
  }
  await writeFile(join(target, 'icons', films[i].name.replaceAll(' ', '-') + '.rgba'), films[i].icon, { flag: 'wx' });
  conversions.push({ name: films[i].name, unchangedFromT6: i !== 8, ...(i === 8 ? {
    meanDE: conversion.meanDE, p95DE: conversion.p95DE,
    meaning: 'fit against the locally corrected CUBE, not accuracy against real film or a camera capture' } : {}) });
}
await json('SOURCES.json', provenance);
await json('CUBE-fit-report.json', conversions);
for (const name of ['ICON-SOURCES.json', 'LICENSE-t3mujinpack.txt'])
  await copyFile(join(root, 'examples/gr3x/T6', name), join(target, name));

const temporary = await mkdtemp(join(tmpdir(), 'gr3x-t6-c1-'));
try {
  const { decoded } = await openGr3xOfficial(raw);
  for (const name of ['RTOS', 'BOOT']) {
    const s = sectionsOf(decoded).find(x => x.name === name);
    assert(s);
    await writeFile(join(temporary, name.toLowerCase() + '.bin'), decoded.subarray(s.offset, s.offset + s.size));
  }
  await writeFile(join(temporary, 'base.json'), JSON.stringify(await buildGr3xAdjResearch(raw)));
  const run = spawnSync(python, [join(here, 'validate_test.py'), '--official', resolve(input),
    '--container', join(target, 'UNVALIDATED.bin'), '--manifest', join(target, 'patch-manifest.json'),
    '--build-report', join(target, 'build-report.json'), '--rtos', join(temporary, 'rtos.bin'),
    '--boot', join(temporary, 'boot.bin'), '--reference', resolve(reference),
    '--base-look-manifest', join(temporary, 'base.json'), '--output', join(target, 'validation')],
    { stdio: 'inherit', timeout: 600000 });
  if (run.error || run.status !== 0) throw new Error('C1 validation failed; UNVALIDATED.bin is not a released update');
  const summary = JSON.parse(await readFile(join(target, 'validation/summary.json'), 'utf8'));
  assert(summary.all_checks_passed && summary.candidate_sha256 === result.report.outputSha256);
  const inspected = await (await Engine.open(raw)).inspect(result.bytes);
  assert(inspected.verified && !inspected.monoUnlock);
  assert.deepEqual(inspected.slots.map(s => s.names.en), [...T6_FILM_NAMES]);
  await json('reconstruction-check.json', { verified: true, sha256: inspected.sha256,
    baseContainerRevision: 'T6', releaseRevision: 'T6-C1', existingT6EngineCompatible: true,
    slotNames: inspected.slots.map(s => s.names.en), hardwareTested: false });
  await copyFile(join(root, 'docs/GR3X_T6_C1_TEST.txt'), join(target, '请先阅读.txt'));
  await writeFile(join(target, 'SHA256SUMS.txt'), result.report.outputSha256 + '  fwdc243b.bin\n', { flag: 'wx' });
  await rename(join(target, 'UNVALIDATED.bin'), join(target, 'fwdc243b.bin'));
  console.log(JSON.stringify({ directory: target, sha256: result.report.outputSha256, bytes: result.bytes.length,
    releaseRevision: 'T6-C1', nativeCases: summary.native_function_cases, hardwareTested: false, cameraOrCardWritten: false }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
