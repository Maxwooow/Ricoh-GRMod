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
const { planGr3xMenu, GR3X_T4_MENU } = await import('../../core/src/fw/gr3x/geometry.ts');
// GR3X_RATIOS='[{"ratio":"2.39:1","name":"Scope"},…]' builds another ratio list (default: the T4 seven).
const menu = process.env.GR3X_RATIOS ? planGr3xMenu(JSON.parse(process.env.GR3X_RATIOS)) : GR3X_T4_MENU;
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
// GR3X_ROUND=2 rebuilds the round-two films (no second matrix, no halation). Round 3 (default):
// second matrix fitted, CineStill 800T with strong halation. GR3X_DIAG=1: test build that prints the
// JPEG encoder's picture descriptors on every JPEG and turns film 1 into a red/blue swap through the
// second matrix (an unmistakable check that the camera applies that stage).
// GR3X_DATE=1 (round 4): the date imprint with its still-menu line (datestamp.ts); not with GR3X_DIAG.
const round = Number(process.env.GR3X_ROUND ?? 3), diagnostics = process.env.GR3X_DIAG === '1', dateImprint = process.env.GR3X_DATE === '1';
if (dateImprint && diagnostics) throw new Error('GR3X_DATE and GR3X_DIAG are not combined');
// GR3X_PICTURES='[{"name":"Sunset","rgb":"/path/720x480.rgb"},…]' (round 5): power-off pictures (shutdown.ts).
const { encodeGr3xPicture } = await import('../../core/src/fw/gr3x/shutdown.ts');
// GR3X_PICTURE_MENU=list rebuilds round 5's Setup line; the default is round 6's End Screen submenu
// (as GR IV), where each picture has a stable identity ("id" in GR3X_PICTURES, else 0x1000 * k + 7).
const pictureMenu = process.env.GR3X_PICTURE_MENU ?? 'submenu';
if (!['list', 'submenu'].includes(pictureMenu)) throw new Error('GR3X_PICTURE_MENU is list or submenu');
const pictures = process.env.GR3X_PICTURES ? await Promise.all(JSON.parse(process.env.GR3X_PICTURES).map(async (p, k) => ({ name: p.name, jpeg: encodeGr3xPicture(new Uint8Array(await readFile(p.rgb))),
  ...(pictureMenu === 'submenu' ? { id: p.id ?? 0x1000 * (k + 1) + 7 } : {}) }))) : [];
// GR3X_DATE_MENU=list rebuilds round 4's single list; the default is round 6's submenu (as GR IV).
const dateMenu = process.env.GR3X_DATE_MENU ?? 'submenu';
if (!['list', 'submenu'].includes(dateMenu)) throw new Error('GR3X_DATE_MENU is list or submenu');
// GR3X_R7=1 (round 7, as GR Mod 0.8.2): settings guard, date imprint by look and OFF / ON icons,
// with GR3X_FILMS the films' Halation strength and colour and 0.8.2's halation.
const round7 = process.env.GR3X_R7 === '1';
if (round7 && (diagnostics || (dateImprint && dateMenu !== 'submenu'))) throw new Error('GR3X_R7 needs the date submenu and no GR3X_DIAG');
// GR3X_R8=1 (round 8, as GR Mod 0.8.4; with GR3X_R7): the date imprint follows the camera and can add
// the look's name; GR3X_LAYOUT='{"order":[...],"hidden":[...]}' the Image Control order and hidden
// looks. The films are fitted as 0.8.4 does (#7's colours); without it as up to 0.8.2.
const round8 = process.env.GR3X_R8 === '1';
if (round8 && !round7) throw new Error('GR3X_R8 needs GR3X_R7');
const lookLayout = process.env.GR3X_LAYOUT ? JSON.parse(process.env.GR3X_LAYOUT) : undefined;
if (lookLayout && !round8) throw new Error('GR3X_LAYOUT needs GR3X_R8');
// GR3X_R9=1 (round 9, with GR3X_R8): the live view refreshed between films (image-control.ts).
const round9 = process.env.GR3X_R9 === '1';
if (round9 && !round8) throw new Error('GR3X_R9 needs GR3X_R8');
// GR3X_R10=1 (round 10, with GR3X_R9): GR IV's ways throughout (round10.ts, films-r10.ts).
const round10 = process.env.GR3X_R10 === '1';
if (round10 && !round9) throw new Error('GR3X_R10 needs GR3X_R9');
const features = { adjSoftFocus: round >= 3, ...(dateImprint ? { dateImprint, dateMenu } : {}), ...(pictures.length ? { pictures, pictureMenu } : {}), ...(round7 ? { round7 } : {}),
  ...(round8 ? { round8 } : {}), ...(round9 ? { round9 } : {}), ...(round10 ? { round10 } : {}), ...(lookLayout ? { lookLayout } : {}) };
// GR3X_BUILD_ONLY=1: build and print the file's SHA-256, nothing written (regression checks).
const buildOnly = process.env.GR3X_BUILD_ONLY === '1';
// GR3X_FILMS=n (round 6): n films (1..20; the nine T6 films first, then plain ones), each with the
// Halation line in the camera (no level in the build). Not with GR3X_DIAG.
const filmCount = process.env.GR3X_FILMS ? Number(process.env.GR3X_FILMS) : undefined;
if (filmCount !== undefined && (!Number.isInteger(filmCount) || filmCount < 1 || filmCount > 20 || diagnostics)) throw new Error('GR3X_FILMS is 1..20, not with GR3X_DIAG');
const provenance = JSON.parse(await readFile(join(root, 'examples/gr3x/T6/SOURCES.json'), 'utf8'));
for (const [index, name] of T6_FILM_NAMES.entries()) {
  const source = provenance[index];
  if (source.name !== name) throw new Error('T6 source order changed');
  const filename = source.file;
  const text = await readFile(join(root, 'examples/gr3x/T6', filename), 'utf8');
  if (await sha256Hex(new TextEncoder().encode(text)) !== source.cube_sha256) throw new Error('T6 source hash changed');
  const result = engine.convertPreset('cube', text, undefined, { post: round >= 3, legacyFit: !round8 });
  const icon = gr3xFilmIcon(resources.tiles.film, index);
  films.push({ name, icon, preset: { matrixQ13: result.matrixQ13, curves: result.curves, ...(result.postQ9 ? { postQ9: result.postQ9 } : {}) },
    ...(round >= 3 && name === 'CineStill 800T' && filmCount === undefined ? { halation: 2 } : {}) });
  conversions.push({ name, filename, source: source.source, sourceSha256: source.cube_sha256,
    meanDE: result.meanDE, p95DE: result.p95DE, warnings: result.warnings, hardwareTested: false });
  sources.push({ filename, text });
}
if (filmCount !== undefined) {
  films.length = Math.min(films.length, filmCount);
  for (let k = films.length; k < filmCount; k++) films.push({ name: `Film ${k + 1}` });
}
if (diagnostics) {
  films[0] = { ...films[0], name: 'RB Swap Test', preset: { ...films[0].preset, postQ9: [0, 0, 512, 0, 512, 0, 512, 0, 0] } };
}
// Round 3: soft focus on the ADJ lever (function 0x13) instead of the negative clarity rows.
const adjSoftFocus = round >= 3;
const soft = adjSoftFocus ? [] : [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }];
// Films keep their own parameters (T6d) unless GR3X_SHARED=1 rebuilds T6c (shared with Standard).
const ownParameters = process.env.GR3X_SHARED !== '1';
const result = await buildGr3xTestFirmware(raw, soft, { films, monoReplicas: false, displayRevision: 3, ...(ownParameters ? { ownParameters } : {}), ...(filmCount !== undefined ? { filmCount } : {}), ...(diagnostics ? { jpegDiagnostics: true } : {}) }, menu, features);
if (buildOnly) { console.log(JSON.stringify({ sha256: result.report.outputSha256, bytes: result.bytes.length, revision: result.report.revision ?? null })); process.exit(0); }
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
for (const film of films) if (film.icon) await writeFile(join(target, 'icons', film.name.replaceAll(' ', '-') + '.rgba'), film.icon, { flag: 'wx' });
await copyFile(join(root, 'examples/gr3x/T6/LICENSE-t3mujinpack.txt'), join(target, 'LICENSE-t3mujinpack.txt'));
for (const source of sources) await writeFile(join(target, 'CUBE', source.filename), source.text, { flag: 'wx' });
// The halation module's expected result on the synthetic picture of picture_stage_probe.py,
// from GR Mod's own reference (halateYcc), per film with halation.
const { halateYcc, halationLight } = await import('../../core/src/fw/aspect/halation.ts');
const W = 320, H = 240, parts = [];
// Round 7 only: GR Mod's reference is 0.8.2's halation now (0.8.0's, which round 6 builds carry, is
// not kept as a reference; their probe runs without one).
for (const [k, film] of (round7 ? films : []).entries()) {
  // The strength and colour come from the camera: the reference is made at 1..3, red for even films, white for odd.
  const level = 1 + (k % 3), white = k % 2 === 1;
  const Y = new Uint8Array(W * H), C = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    Y[y * W + x] = 140 < x && x < 180 && 100 < y && y < 140 ? 252 : 16 + ((x * 3 + y * 5) % 220);
    C[y * W + x] = 128 + ((Math.floor(x / 2) + y) % 40) - 20;
  }
  const post = film.preset?.postQ9 && !Array.from(film.preset.postQ9).every((v, i) => v === [512,0,0,0,512,0,0,0,512][i]) ? film.preset.postQ9 : undefined;
  // As the build: the film's quantized curves when it has a preset (image-control.ts), else Standard's.
  const look = result.manifest.addedLooks[k];
  halateYcc(Y, C, W, H, level, look.quantizedCurves ? halationLight(look.quantizedCurves, look.postQ9) : halationLight(), white ? 'white' : 'red');
  void post;
  const head = new Uint8Array(4); new DataView(head.buffer).setUint32(0, (32 + k) | level << 8 | (white ? 0x20000 : 0), true);
  parts.push(head, Y, C);
}
const halationReference = join(target, 'halation-reference.bin');
await writeFile(halationReference, Buffer.concat(parts.map(p => Buffer.from(p))), { flag: 'wx' });
// GR3X_NO_VALIDATE=1: the files of the build (UNVALIDATED.bin, manifest, reports), no validation (development only).
if (process.env.GR3X_NO_VALIDATE === '1') { console.log(JSON.stringify({ directory: target, sha256: result.report.outputSha256, validated: false })); process.exit(0); }
const temporary = await mkdtemp(join(tmpdir(), 'gr3x-t6-'));
try {
  for (const name of ['RTOS', 'BOOT']) {
    const section = sectionsOf(decoded).find(s => s.name === name);
    if (!section) throw new Error('Missing original section: ' + name);
    await writeFile(join(temporary, name.toLowerCase() + '.bin'), decoded.subarray(section.offset, section.offset + section.size));
  }
  // The base layer as before (with films the order and hidden looks belong to the image-control layer).
  const { lookLayout: _layout, ...baseFeatures } = features;
  await writeFile(join(temporary, 'base.json'), JSON.stringify(await buildGr3xAdjResearch(raw, menu, baseFeatures)));
  const run = spawnSync(python, [join(here, 'validate_test.py'), '--official', resolve(input),
    '--container', join(target, 'UNVALIDATED.bin'), '--manifest', join(target, 'patch-manifest.json'),
    '--build-report', join(target, 'build-report.json'), '--rtos', join(temporary, 'rtos.bin'),
    '--boot', join(temporary, 'boot.bin'), '--reference', resolve(reference),
    '--base-look-manifest', join(temporary, 'base.json'), '--halation-reference', halationReference, '--output', join(target, 'validation')],
    { stdio: 'inherit', timeout: 4 * 3600000 });
  if (run.error || run.status !== 0) throw new Error('T6 validation failed; UNVALIDATED.bin is not a released update');
  const summary = JSON.parse(await readFile(join(target, 'validation/summary.json'), 'utf8'));
  if (!summary.all_checks_passed || summary.candidate_sha256 !== result.report.outputSha256) throw new Error('T6 validation/hash mismatch');
  // Fresh Engine inspection must rebuild identical bytes from the embedded recipe.
  const inspected = await (await Engine.open(raw)).inspect(result.bytes);
  if (!inspected.verified || inspected.monoUnlock || inspected.dateStamp !== dateImprint || (inspected.shutdownPictures?.length ?? 0) !== pictures.length || inspected.slots.length !== (filmCount ?? 9) || inspected.slots.some((s, i) => s.names.en !== films[i].name)) throw new Error('T6 fresh-engine reconstruction failed');
  await json('reconstruction-check.json', { verified: true, sha256: inspected.sha256, monoReplicas: inspected.monoUnlock,
    slotNames: inspected.slots.map(s => s.names.en), dateImprint: inspected.dateStamp, pictures: (inspected.shutdownPictures ?? []).map(p => p.name), hardwareTested: false });
  await copyFile(join(root, 'docs/' + (result.report.filename === 'fwdc239b.bin' ? 'GR3_HDF_210_TEST.txt' : 'GR3X_T6_TEST.txt')), join(target, '请先阅读.txt'));
  await writeFile(join(target, 'SHA256SUMS.txt'), result.report.outputSha256 + '  ' + result.report.filename + '\n', { flag: 'wx' });
  await rename(join(target, 'UNVALIDATED.bin'), join(target, result.report.filename));
  console.log(JSON.stringify({ directory: target, sha256: result.report.outputSha256, bytes: result.bytes.length,
    revision: 'T6', nativeCases: summary.native_function_cases, hardwareTested: false, cameraOrCardWritten: false }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
