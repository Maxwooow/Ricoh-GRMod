// SPDX-License-Identifier: GPL-2.0-only
// W2: add a normally updated A: resource and redirect the generic shutdown descriptor.
import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const x of ['.ts','/index.ts'])try{return next(s+x,c);}catch{}throw e;}}});
const { Firmware, buildGrown, sha256Hex, sectionsOf, sum32 } = await import('../../core/src/fw/container.ts');
const { listResources } = await import('../../core/src/fw/resources.ts');
const { checkShutdownJpeg } = await import('../../core/src/jpeg/index.ts');
const { Engine } = await import('../../core/src/app/engine.ts');

const [officialPath, parentDirectory, jpegPath, outputDirectory, python, reference, ...extra] = process.argv.slice(2);
assert(officialPath && parentDirectory && jpegPath && outputDirectory && python && reference && !extra.length,
  'Usage: OFFICIAL.bin T6-J1-directory CLEAR-ANNIVERSARY.jpg NEW-directory PYTHON PINNED-reference');
const root = resolve(import.meta.dirname, '../..');
const out = resolve(outputDirectory), parent = resolve(parentDirectory);
const official = new Uint8Array(await readFile(officialPath));
const prior = new Uint8Array(await readFile(join(parent, 'fwdc243b.bin')));
const jpeg = new Uint8Array(await readFile(jpegPath));
const parentSha256 = await sha256Hex(prior);
assert.equal(parentSha256, 'ad8ad418004d5eed20644e396f1361d081033fb050c172047b7614bc92934a91');
assert.equal(await sha256Hex(jpeg), 'd30f49e8fd7c8ab7b368efcf37383d1e29812246e8db5e6127c12da4908285f5');
assert.deepEqual(checkShutdownJpeg(jpeg, {byteLength:49116, sampling:'420'}), {ok:true, problems:[]});
assert((await (await Engine.open(official)).inspect(prior)).verified,
  'Parent T6-J1 must reconstruct exactly from the official firmware');

const fw = new Firmware(prior), sections = sectionsOf(fw.decoded);
const rtos = sections.find(s => s.name === 'RTOS'), res = sections.find(s => s.name === 'RES');
assert.equal(rtos.offset, 67696); assert.equal(rtos.size, 17962432);
assert.equal(res.offset, 53712936); assert.equal(res.size, 35);
const originals = listResources(fw.decoded);
const path = 'A:\\GR20J2.JPG', encodedPath = new TextEncoder().encode(path + '\0');
assert(!originals.some(r => r.path.toLowerCase() === path.toLowerCase()));
assert(encodedPath.length <= 32);
const resourceRecord = new Uint8Array(36 + jpeg.length);
resourceRecord.set(encodedPath);
new DataView(resourceRecord.buffer).setUint32(32, jpeg.length, true);
resourceRecord.set(jpeg, 36);
assert.equal(resourceRecord.length, 2 * 0x6000);
const decoded = new Uint8Array(fw.decoded.length + resourceRecord.length);
decoded.set(fw.decoded.subarray(0, res.offset));
decoded.set(resourceRecord, res.offset);
decoded.set(fw.decoded.subarray(res.offset), res.offset + resourceRecord.length);
const view = new DataView(decoded.buffer);
view.setUint32(res.offset - 4, res.size + 1, true);

// Verified unused padding after the complete J1 recipe and before its original marker.
const extensionOffset = rtos.offset + 0x1121500, extensionBytes = 128;
assert(fw.decoded.subarray(extensionOffset, extensionOffset + extensionBytes).every(x => x === 0));
decoded.set(new TextEncoder().encode('GR3X-SHUTDOWN-W2\0'), extensionOffset);
decoded.set(encodedPath, extensionOffset + 32);
const pointerOffset = rtos.offset + 0xb5f544;
assert.equal(view.getUint32(pointerOffset, true), 0x53b22abc);
assert.equal(view.getUint32(pointerOffset - 4, true), (480 << 16) | 720);
view.setUint32(pointerOffset, 0x54121520, true);
const checksumOffset = rtos.offset + rtos.size - 4;
const marker = new TextEncoder().encode('GR3X-HDF-160-ADJ9-T6-J1-HARDWARE-UNTESTED\0');
assert.deepEqual(decoded.subarray(checksumOffset - marker.length, checksumOffset), marker);
assert(extensionOffset + extensionBytes <= checksumOffset - marker.length);
view.setUint32(checksumOffset, 0, true);
view.setUint32(checksumOffset, (-sum32(decoded)) >>> 0, true);
const changes = [
  {what:'Generic shutdown JPEG path pointer', offset:pointerOffset, length:4},
  {what:'W2 image path in verified unused RTOS padding', offset:extensionOffset, length:extensionBytes},
  {what:'Existing payload checksum compensation', offset:checksumOffset, length:4},
  {what:'RES file count: 35 to 36', offset:res.offset - 4, length:4},
];
const restored = new Uint8Array(fw.decoded.length);
restored.set(decoded.subarray(0, res.offset));
restored.set(decoded.subarray(res.offset + resourceRecord.length), res.offset);
for (const change of changes)
  restored.set(fw.decoded.subarray(change.offset, change.offset + change.length), change.offset);
assert.deepEqual(restored, fw.decoded, 'No undeclared parent byte may change');
const resources = listResources(decoded);
assert.deepEqual(resources[0], {path, offset:res.offset + 36, length:jpeg.length});
for (let i = 0; i < originals.length; i++) {
  const before = originals[i], after = resources[i + 1];
  assert.deepEqual(after, {...before, offset:before.offset + resourceRecord.length});
  assert.deepEqual(decoded.subarray(after.offset - 36, after.offset + after.length),
    fw.decoded.subarray(before.offset - 36, before.offset + before.length));
}
const insertion = {at:res.offset, length:resourceRecord.length};
const built = buildGrown(fw, decoded, [insertion]);
const candidate = new Firmware(built.out);
assert.deepEqual(candidate.decoded, decoded);
assert.deepEqual(candidate.header, fw.header);
assert.equal(sum32(built.out), 0); assert.equal(sum32(decoded), 0);
const parentReport = JSON.parse(await readFile(join(parent, 'build-report.json'), 'utf8'));
assert.equal(parentReport.outputSha256, parentSha256);
const report = {
  ...parentReport, deliveryRevision:'T6-J1-W2', parentSha256,
  outputSha256:await sha256Hex(built.out), outputBytes:built.out.length,
  decodedSha256:await sha256Hex(decoded), decodedBytes:decoded.length,
  resGrowth:resourceRecord.length, resInsertion:insertion,
  checks:{parentPinned:true, parentReconstructed:true, containerRoundTrip:true,
    payloadChecksum:true, fileChecksum:true, originalResourcesUnchanged:true},
  parentReencodedFrames:parentReport.reencodedFrames, reencodedFrames:undefined,
  reencodedFramesFromParent:built.reencoded,
  shutdownImage:{path, offset:res.offset + 36, bytes:jpeg.length,
    sha256:await sha256Hex(jpeg), width:720, height:480, sampling:'420',
    qualitySearchStartingPoint:98, addedBlur:false, descriptorPointerAddress:0x53b5f544,
    pathAddress:0x54121520, anniversaryText:'GR DIGITAL 20th ANNIVERSARY 2005–2025',
    embeddedInFirmware:true, startupScriptRequired:false, hardwareTested:false},
  parentPreservation:{ranges:changes, allOtherParentBytesIdentical:true,
    runtimeCodeIdentical:true, jpgMetadataIdentical:true, nineFilmsAndIconsIdentical:true,
    nineRatiosIdentical:true, rawProcessingIdentical:true, allOriginalResourcesIdentical:true},
};
await mkdir(out);
const json = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
await writeFile(join(out, 'UNVALIDATED.bin'), built.out, {flag:'wx'});
await writeFile(join(out, '关机图片-固件内实际编码.jpg'), jpeg, {flag:'wx'});
await json('build-report.json', report);
await copyFile(join(parent, 'patch-manifest.json'), join(out, 'patch-manifest.json'));
await copyFile(join(parent, 'JPG-film-identities.json'), join(out, 'JPG-film-identities.json'));
const run = spawnSync(python, [join(root, 'tools/gr3x/wallpaper_v2_package_probe.py'),
  '--official', resolve(officialPath), '--parent', parent, '--candidate', join(out, 'UNVALIDATED.bin'),
  '--report', join(out, 'build-report.json'), '--jpeg', resolve(jpegPath), '--reference', resolve(reference),
  '--output', join(out, 'validation')], {stdio:'inherit', timeout:300000});
assert(!run.error && run.status === 0, 'Independent validation failed: do not use UNVALIDATED.bin');
const result = JSON.parse(await readFile(join(out, 'validation/summary.json'), 'utf8'));
assert(result.all_checks_passed && result.candidate_sha256 === report.outputSha256);
await copyFile(join(root, 'docs/GR3X_T6_J1_W2_TEST.txt'), join(out, '请先阅读.txt'));
await writeFile(join(out, 'SHA256SUMS.txt'), report.outputSha256 + '  fwdc243b.bin\n', {flag:'wx'});
await rename(join(out, 'UNVALIDATED.bin'), join(out, 'fwdc243b.bin'));
console.log(JSON.stringify({directory:out, revision:'T6-J1-W2', bytes:built.out.length,
  sha256:report.outputSha256, nativeCases:result.native_function_cases,
  hardwareTested:false, cardWritten:false}));
