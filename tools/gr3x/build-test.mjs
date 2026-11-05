// SPDX-License-Identifier: GPL-2.0-only
// Fixed-nine local hardware-test candidate. This command never discovers or writes a camera/card.
import { registerHooks } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (original) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        try { return next(specifier + suffix, context); } catch { /* next suffix */ }
      }
    }
    throw original;
  }
} });
const [input, directory, python, reference, ...extra] = process.argv.slice(2);
if (!input || !directory || !python || !reference || extra.length > 1 || (extra.length && extra[0] !== '--soft-focus')) {
  console.error('Usage: node tools/gr3x/build-test.mjs OFFICIAL.bin NEW-directory PYTHON PINNED-gr-custom-tool-directory [--soft-focus]');
  process.exit(2);
}
const { buildGr3xTestFirmware } = await import('../../core/src/fw/gr3x/research-package.ts');
const { planGr3xMenu, GR3X_T4_MENU } = await import('../../core/src/fw/gr3x/geometry.ts');
// GR3X_RATIOS='[{"ratio":"2.39:1","name":"Scope"},…]' builds another ratio list (default: the T4 seven).
const menu = process.env.GR3X_RATIOS ? planGr3xMenu(JSON.parse(process.env.GR3X_RATIOS)) : GR3X_T4_MENU;
const { openGr3xOfficial } = await import('../../core/src/fw/gr3x/profile.ts');
const { sectionsOf } = await import('../../core/src/fw/container.ts');
const raw = new Uint8Array(await readFile(input));
const softFocus = extra.length ? [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }] : [];
// GR3X_ADJSF=1: soft focus on the ADJ lever (function 0x13) instead of the clarity rows.
const adjSoftFocus = process.env.GR3X_ADJSF === '1';
if (adjSoftFocus && softFocus.length) throw new Error('ADJ soft focus replaces the clarity-table soft focus');
const result = await buildGr3xTestFirmware(raw, softFocus, undefined, menu, { adjSoftFocus });
const { decoded } = await openGr3xOfficial(raw);
const target = resolve(directory), here = dirname(fileURLToPath(import.meta.url));
await mkdir(target); // Never overwrite an existing release or the official input.
const json = async (name, value) => writeFile(join(target, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(target, 'UNVALIDATED.bin'), result.bytes, { flag: 'wx' });
await json('patch-manifest.json', result.manifest);
await json('build-report.json', result.report);
const temporary = await mkdtemp(join(tmpdir(), 'gr3x-adj9-'));
try {
  for (const name of ['RTOS', 'BOOT']) {
    const section = sectionsOf(decoded).find(s => s.name === name);
    if (!section) throw new Error('Missing native section: ' + name);
    await writeFile(join(temporary, name.toLowerCase() + '.bin'), decoded.subarray(section.offset, section.offset + section.size), { flag: 'wx' });
  }
  const run = spawnSync(python, [join(here, 'validate_test.py'), '--official', resolve(input),
    '--container', join(target, 'UNVALIDATED.bin'), '--manifest', join(target, 'patch-manifest.json'),
    '--build-report', join(target, 'build-report.json'), '--rtos', join(temporary, 'rtos.bin'),
    '--boot', join(temporary, 'boot.bin'), '--reference', resolve(reference), '--output', join(target, 'validation')],
    { stdio: 'inherit', timeout: 600000 });
  if (run.error || run.status !== 0) throw new Error('Candidate validation failed; UNVALIDATED.bin is not an update release', { cause: run.error });
  const summary = JSON.parse(await readFile(join(target, 'validation/summary.json'), 'utf8'));
  if (!summary.all_checks_passed || summary.candidate_sha256 !== result.report.outputSha256) {
    throw new Error('Validation is not bound to this candidate');
  }
  await copyFile(join(here, '../../docs/' + (result.report.filename === 'fwdc239b.bin' ? 'GR3_HDF_210_TEST.txt' : softFocus.length ? 'GR3X_FEATURES_TEST.txt' : 'GR3X_ADJ9_TEST.txt')), join(target, '请先阅读.txt'));
  await writeFile(join(target, 'SHA256SUMS.txt'), result.report.outputSha256 + '  ' + result.report.filename + '\n', { flag: 'wx' });
  await rename(join(target, 'UNVALIDATED.bin'), join(target, result.report.filename));
  console.log(JSON.stringify({ directory: target, filename: result.report.filename, sha256: result.report.outputSha256,
    bytes: result.bytes.length, revision: result.report.revision, nativeFunctionCases: summary.native_function_cases,
    hardwareTested: false, cameraOrCardWritten: false }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
