// SPDX-License-Identifier: GPL-2.0-only
// Fixed-resource successor to T6-J1. No new hooks or startup scripts.
import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const x of ['.ts','/index.ts'])try{return next(s+x,c);}catch{}throw e;}}});

const { Firmware, build, sha256Hex, sectionsOf, sum32 } = await import('../../core/src/fw/container.ts');
const { listResources } = await import('../../core/src/fw/resources.ts');
const { selfCheckGrown, countChangedBytes } = await import('../../core/src/fw/selfcheck.ts');
const { checkShutdownJpeg, decodeBaselineJpeg } = await import('../../core/src/jpeg/index.ts');
const { Engine } = await import('../../core/src/app/engine.ts');
const [officialPath, parentDirectory, jpegPath, outputDirectory, python, reference, ...extra] = process.argv.slice(2);
assert(officialPath && parentDirectory && jpegPath && outputDirectory && python && reference && !extra.length,
  'Usage: OFFICIAL.bin T6-J1-directory ANNIVERSARY.jpg NEW-directory PYTHON PINNED-reference');
const root = resolve(import.meta.dirname, '../..');
const out = resolve(outputDirectory), parent = resolve(parentDirectory);
const raw = new Uint8Array(await readFile(officialPath));
const prior = new Uint8Array(await readFile(join(parent, 'fwdc243b.bin')));
const jpeg = new Uint8Array(await readFile(jpegPath));
const parentSha256 = await sha256Hex(prior);
assert.equal(parentSha256, 'ad8ad418004d5eed20644e396f1361d081033fb050c172047b7614bc92934a91');
assert.equal(await sha256Hex(jpeg), '60704ffd3c4775c33e78f9404b3676db4edf3f78aec59773e3407b4f1fc54c17');
assert.deepEqual(checkShutdownJpeg(jpeg, { byteLength: 7264, sampling: '420' }), { ok: true, problems: [] });
assert.equal(decodeBaselineJpeg(jpeg).rgb.length, 720 * 480 * 3);
assert((await (await Engine.open(raw)).inspect(prior)).verified, 'T6-J1 must reconstruct exactly from the official firmware');
const fw = new Firmware(prior), decoded = fw.decoded.slice();
const originalResources = listResources(new Firmware(raw).decoded);
const resources = listResources(decoded);
const target = resources.find(r => r.path === 'B:\\Resource\\Jpeg\\GoodBye.jpg');
const factoryTarget = originalResources.find(r => r.path === target?.path);
assert(target && factoryTarget && target.length === 7264 && factoryTarget.length === target.length);
assert.equal(await sha256Hex(decoded.subarray(target.offset, target.offset + target.length)),
  'dff9ba0ad2c7ea2697b19470cf6c695337651ee0ef415a6d3359a7f318ff3c79');
const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS');
const checksumOffset = rtos.offset + rtos.size - 4;
const record = new TextEncoder().encode('GR3X-HDF-160-ADJ9-T6-J1-HARDWARE-UNTESTED\0');
assert.deepEqual(decoded.subarray(checksumOffset - record.length, checksumOffset), record);
decoded.set(jpeg, target.offset);
const dv = new DataView(decoded.buffer);
dv.setUint32(checksumOffset, 0, true);
dv.setUint32(checksumOffset, (-sum32(decoded)) >>> 0, true);
const changes = [
  { what: 'IIIx HDF GoodBye.jpg: user-supplied GR DIGITAL 20th anniversary', offset: target.offset, length: target.length },
  { what: 'Existing T6-J1 payload checksum compensation', offset: checksumOffset, length: 4 },
];
for (let i = 0; i < decoded.length; i++) if (decoded[i] !== fw.decoded[i])
  assert(changes.some(r => i >= r.offset && i < r.offset + r.length), `Unplanned byte at ${i.toString(16)}`);
assert.deepEqual(listResources(decoded), resources);
const built = build(fw, decoded);
const parentReport = JSON.parse(await readFile(join(parent, 'build-report.json'), 'utf8'));
assert.equal(parentReport.outputSha256, parentSha256);
const ranges = [...parentReport.ranges, changes[0]];
const checks = selfCheckGrown(raw, built.out, ranges, decoded);
assert(Object.values(checks).every(x => x === true), JSON.stringify(checks));
const manifest = JSON.parse(await readFile(join(parent, 'patch-manifest.json'), 'utf8'));
const restored = decoded.slice();
restored.set(fw.decoded.subarray(target.offset, target.offset + target.length), target.offset);
restored.set(fw.decoded.subarray(checksumOffset, checksumOffset + 4), checksumOffset);
assert.deepEqual(restored, fw.decoded);
const report = {
  ...parentReport, deliveryRevision: 'T6-J1-W1', parentSha256,
  outputSha256: await sha256Hex(built.out), outputBytes: built.out.length,
  decodedSha256: await sha256Hex(decoded), ranges, checks,
  parentReencodedFrames: parentReport.reencodedFrames, reencodedFrames: undefined,
  reencodedFramesFromParent: built.reencoded,
  changedBytesFromParent: countChangedBytes(fw.decoded, decoded),
  shutdownImage: { path: target.path, offset: target.offset, bytes: target.length,
    sha256: await sha256Hex(jpeg), width: 720, height: 480, sampling: '420',
    anniversaryText: 'GR DIGITAL 20th ANNIVERSARY 2005–2025',
    embeddedInFirmware: true, startupScriptRequired: false, hardwareTested: false },
  parentPreservation: { ranges: changes, runtimeExceptChecksumIdentical: true,
    jpgMetadataIdentical: true, nineFilmsAndIconsIdentical: true, nineRatiosIdentical: true,
    rawProcessingIdentical: true, allOtherResourcesIdentical: true },
};
await mkdir(out);
const json = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
await writeFile(join(out, 'UNVALIDATED.bin'), built.out, {flag:'wx'});
await writeFile(join(out, '关机图片-固件内实际编码.jpg'), jpeg, {flag:'wx'});
await json('build-report.json', report);
await json('patch-manifest.json', manifest);
await copyFile(join(parent, 'JPG-film-identities.json'), join(out, 'JPG-film-identities.json'));
const run = spawnSync(python, [join(root, 'tools/gr3x/wallpaper_package_probe.py'),
  '--official', resolve(officialPath), '--parent', parent, '--candidate', join(out, 'UNVALIDATED.bin'),
  '--report', join(out, 'build-report.json'), '--jpeg', resolve(jpegPath), '--reference', resolve(reference),
  '--output', join(out, 'validation')], {stdio:'inherit', timeout:300000});
assert(!run.error && run.status === 0, 'Independent validation failed: do not use UNVALIDATED.bin');
const result = JSON.parse(await readFile(join(out, 'validation/summary.json'), 'utf8'));
assert(result.all_checks_passed && result.candidate_sha256 === report.outputSha256);
await copyFile(join(root, 'docs/GR3X_T6_J1_W1_TEST.txt'), join(out, '请先阅读.txt'));
await writeFile(join(out, 'SHA256SUMS.txt'), report.outputSha256 + '  fwdc243b.bin\n', {flag:'wx'});
await rename(join(out, 'UNVALIDATED.bin'), join(out, 'fwdc243b.bin'));
console.log(JSON.stringify({directory:out, revision:'T6-J1-W1', bytes:built.out.length,
  sha256:report.outputSha256, nativeCases:result.native_function_cases, hardwareTested:false, cardWritten:false}));
