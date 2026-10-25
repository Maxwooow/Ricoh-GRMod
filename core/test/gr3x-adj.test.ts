// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src';
import { Firmware, sha256Hex, sum32, verifyContainer } from '../src/fw/container';
import { selfCheck, selfCheckGrown } from '../src/fw/selfcheck';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';
import { GR3X_160 } from '../src/fw/gr3x/profile';
import { buildGr3xResearchContainer, buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';

const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('IIIx ADJ research container integrity and isolation', () => {
  let raw: Uint8Array;
  let result: Awaited<ReturnType<typeof buildGr3xResearchContainer>>;
  beforeAll(async () => {
    raw = new Uint8Array(readFileSync(input!));
    result = await buildGr3xResearchContainer(raw);
  }, 60000);
  it('preserves the exact empty model-record area in the official IIIx container', () => {
    expect(new Firmware(raw).models.length).toBe(0);
    expect(Object.values(selfCheck(raw, raw, [])).every(v => v)).toBe(true);
    expect(Object.values(result.report.checks).every(v => v)).toBe(true);
    expect(result.report.checks.model_records_identical).toBe(true);
  });
  it('rejects adding model records even after repairing the container checksum', () => {
    const built = result.bytes;
    const footer = built.length - 24;
    const altered = new Uint8Array(built.length + 128);
    altered.set(built.subarray(0, footer));
    altered.set(built.subarray(footer), footer + 128);
    new DataView(altered.buffer).setUint32(altered.length - 4,
      (-sum32(altered.subarray(0, altered.length - 4))) >>> 0, true);
    expect(Object.values(verifyContainer(altered).checks).every(v => v)).toBe(true);
    const checks = selfCheckGrown(raw, altered, result.report.ranges);
    expect(Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)).toEqual(['model_records_identical']);
  });
  it('packages the nine entries without claiming a camera-ready build or enabling public writes', async () => {
    expect(result.manifest.sites.length).toBe(94);
    expect(result.report.ratios.map(r => r.ratio)).toEqual(['4:3', '3:2', '16:9', '65:24', '17:6', '3:4', '1:1', '7:6', '5:4']);
    expect(result.report).toMatchObject({ flashable: false, hardwareTested: false, rearDialPatched: false, versionRaised: false });
    expect(result.report.blockers).toHaveLength(3);
    expect(await sha256Hex(raw)).toBe(GR3X_160.sha256);
    expect(await sha256Hex(result.bytes)).toBe(result.report.outputSha256);
    const engine = await Engine.open(raw);
    await expect(engine.buildFirmware([], []))
      .rejects.toMatchObject({ code: 'too-many-ratios' });
    expect(await engine.inspect(result.bytes)).toMatchObject({ kind: 'unknown', verified: false });
  });
  it('builds a fixed-nine camera-update candidate without raising the version or claiming hardware validation', async () => {
    const candidate = await buildGr3xTestFirmware(raw);
    expect(candidate.report).toMatchObject({ kind: 'gr3x-adj9-test-firmware', revision: 'T4',
      filename: 'fwdc243b.bin', cameraUpdateCandidate: true, hardwareTested: false,
      rearDialPatched: false, versionRaised: false });
    expect(Object.values(candidate.report.checks).every(v => v)).toBe(true);
    expect(candidate.manifest).toEqual(result.manifest);
    expect(await sha256Hex(candidate.bytes)).not.toBe(result.report.outputSha256);
    expect(candidate.bytes.slice(0x38, 0x3c)).toEqual(raw.slice(0x38, 0x3c));
    expect(candidate.bytes.slice(0x50, 0x54)).toEqual(raw.slice(0x50, 0x54));
    expect(await sha256Hex(candidate.bytes)).toBe(candidate.report.outputSha256);
    expect(candidate.report).toMatchObject({ rawFullFrame: true, rawDefaultCrop: [6000, 4000], faceDetectionModeInitialized: true, wideDevelopmentApertureUsesNative3x2Width: true, wideLiveViewHeightAlignment: 4 });
    const engine = await Engine.open(raw);
    const ratios = GFX_RATIOS.filter(r => r !== '3:2' && r !== '1:1').map(r => ({ ratio: r, name: r }));
    const built = await engine.buildFirmware([], ratios, [], { guard: false });
    expect(built.sha256).toBe(candidate.report.outputSha256);
    expect(await sha256Hex(built.file)).toBe(candidate.report.outputSha256);
    expect(await engine.inspect(built.file)).toMatchObject({ kind: 'modified', verified: true });
    const damaged = built.file.slice(); damaged[damaged.length - 100] ^= 1;
    expect(await engine.inspect(damaged)).toMatchObject({ kind: 'unknown', verified: false });
    await expect(engine.buildFirmware([], ratios, [], { extraSlots: [{} as never] })).rejects.toMatchObject({ code: 'gr3x-unsupported' });
    // Another order is another (custom) menu, not the tested T4 one.
    expect((await engine.buildFirmware([], ratios.slice().reverse())).sha256).not.toBe(candidate.report.outputSha256);
    // Consumers cannot mutate the cached candidate through the returned file.
    built.file[0] ^= 1;
    expect(await sha256Hex((await engine.buildFirmware([], ratios, [], { guard: false })).file)).toBe(candidate.report.outputSha256);
  });
  it('rejects an altered official baseline before creating an offline package', async () => {
    const altered = raw.slice(); altered[0x10000] ^= 1;
    await expect(buildGr3xResearchContainer(altered)).rejects.toMatchObject({ code: 'unsupported-firmware' });
  });
});
