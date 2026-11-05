// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, GR3X_160, GFX_RATIOS, gr3xOffset, openGr3xOfficial, planGr3xRatio } from '../src';
import { Firmware, build as buildPatchAware, sha256Hex } from '../src/fw/container';
import { cardRole, planFirmwareCard } from '../src/card';
import { rotationScript } from '../src/wallpaper';

describe('GR IIIx target isolation and geometry', () => {
  it('plans seven additions to its two factory ratios, on the IIIx sensor', () => {
    for (const ratio of GFX_RATIOS) {
      if (ratio === '3:2' || ratio === '1:1') {
        expect(() => planGr3xRatio(ratio)).toThrow('already has');
        continue;
      }
      const p = planGr3xRatio(ratio);
      expect(p.status).toBe('planning-only');
      for (const [w, h] of p.sizes) {
        expect(w % 4).toBe(0); expect(h % 4).toBe(0);
        expect(w).toBeLessThanOrEqual(6000); expect(h).toBeLessThanOrEqual(4000);
      }
    }
    // In particular these must not be classified as factory ratios just because GR IV has them.
    expect(planGr3xRatio('4:3').sizes[0]).toEqual([5332, 4000]);
    expect(planGr3xRatio('3:4').sizes[0]).toEqual([3000, 4000]);
  });
  it('does not propagate the LCD rounding error into the recorded photo proposal', () => {
    const p = planGr3xRatio('65:24');
    expect(p.screenActual).toBe('30:11');
    expect(p.sizes).toEqual([[6000, 2216], [4800, 1772], [3360, 1240], [1920, 708]]);
    expect(Math.abs(p.errorPercent)).toBeLessThan(0.03);
    expect(p.playbackRows).toEqual([2216, 1776, 1240, 712]);
  });
  it('uses the IIIx RAM mapping and rejects addresses outside it', () => {
    expect(gr3xOffset(0x55000000)).toBe(GR3X_160.rtosOffset + 0x107b540);
    expect(() => gr3xOffset(0x5505747f)).toThrow(); // GR IV-only RAM extent
    expect(() => gr3xOffset(NaN)).toThrow();
  });
  it('writes the correct filename and parks a GR IV update instead of leaving two updates', () => {
    const listing = { root: [{ name: 'FWDC248B.BIN', dir: false, size: 42 }], script: [] };
    const bytes = new Uint8Array([1, 2]);
    const steps = planFirmwareCard(listing, bytes, 'test', GR3X_160.filename);
    expect(steps).toEqual([
      { op: 'move', from: ['FWDC248B.BIN'], to: ['GRMOD', 'parked-test', 'FWDC248B.BIN'] },
      { op: 'write', path: ['fwdc243b.bin'], data: bytes },
    ]);
    expect(cardRole({ root: [{ name: 'fwdc243b.bin', dir: false, size: 42 }], script: [] })).toBe('firmware');
    expect(planFirmwareCard({ root: [], script: [] }, bytes, 'test')[0]).toMatchObject({ path: ['fwdc248b.bin'] });
    expect(() => planFirmwareCard(listing, bytes, 'test', '../other' as typeof GR3X_160.filename)).toThrow();
  });
  it('uses the IIIx HDF product and B-drive resource in its wallpaper script', () => {
    const script = rotationScript({ model: 'GR3X_HDF', count: 1, size: 7264 });
    expect(script).toContain("target = 'B:\\Resource\\Jpeg\\GoodBye.jpg'");
    expect(script).toContain("filesearch 'C:\\fwdc243b.bin'");
    expect(script).toContain('if code <> 156 then'); // HDF 0x1329c, not generic IIIx 0x1329a
    expect(script).not.toContain('GB_HDF.jpg');
  });
});

// Firmware is supplied by the developer, never committed. Set GRMOD_GR3X_FIRMWARE in CI to
// require these tests; an invalid explicit path fails instead of silently skipping them.
const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('GR IIIx official 1.60 integration', () => {
  let raw: Uint8Array; let engine: Engine;
  beforeAll(async () => {
    expect(existsSync(input!)).toBe(true);
    raw = new Uint8Array(readFileSync(input!));
    engine = await Engine.open(raw);
  });
  it('verifies the container, decoded payload, RTOS and startup copy against independent hashes', async () => {
    const { fw } = await openGr3xOfficial(raw);
    expect(fw.frames).toHaveLength(2430);
    expect(engine.info).toMatchObject({ family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF', 'GR3X'], factoryRatios: ['3:2', '1:1'] });
    expect(engine.info.slots.map(s => s.defaultName)).toEqual(Array.from({ length: 20 }, (_, i) => `Film ${i + 1}`));
    // Power-off images and the factory entry needed a start-up script on the card; GR Mod 0.8 dropped that route.
    expect(engine.info.capabilities).toEqual({ build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false, menuPictures: true, lookLayout: true });
  });
  it('round-trips the unmodified official container byte for byte', async () => {
    const fw = new Firmware(raw);
    const built = buildPatchAware(fw, fw.decoded);
    expect(await sha256Hex(built.out)).toBe(GR3X_160.sha256);
    const original = engine.official(); original[0] ^= 1;
    expect(await sha256Hex(engine.official())).toBe(GR3X_160.sha256);
  });
  it('rejects altered input before using fixed addresses and never recognises it as writable', async () => {
    const changed = raw.slice(); changed[0x10000] ^= 1;
    await expect(Engine.open(changed)).rejects.toMatchObject({ code: 'unsupported-firmware' });
    expect(await engine.inspect(changed)).toMatchObject({ kind: 'unknown', verified: false });
    expect(await engine.inspect(raw)).toMatchObject({ kind: 'official', verified: true });
  });
  it('blocks every unported mutation even when invoked directly, without the UI', async () => {
    await expect(engine.buildFirmware([], [{ name: '65:24', ratio: '65:24' }], [], { extraSlots: [{} as never] })).rejects.toMatchObject({ code: 'gr3x-unsupported' });
    await expect(engine.bridgeFirmware()).rejects.toMatchObject({ code: 'gr3x-port-incomplete' });
    expect(() => engine.convertPreset('cube', '')).toThrow('LUT_3D_SIZE');
    expect(() => engine.convertPreset('xmp', '')).toThrow('not an XML document');
    expect(() => engine.encodeShutdownImage(new Uint8Array(), 'GR3X_HDF')).toThrow('power-off images is not ported');
    expect(() => engine.rotationScript('HDF', 1)).toThrow('startup scripts is not ported');
    expect(engine.previewRatio('65:24')).toMatchObject({ status: 'planning-only', sizes: [[6000, 2216], [4800, 1772], [3360, 1240], [1920, 708]] });
    expect(engine.previewRatio('65:24', ['130:48'])).toMatchObject({ problem: 'ratio-duplicate' });
  });
  it('extracts the IIIx menu entry and original shutdown image from verified firmware', () => {
    const entry = engine.info.factoryEntry;
    expect(entry.modeSetName).toBe('00078490.609');
    expect(entry.keyName).toBe('DEVELOP.MOD');
    expect(entry.files.map(f => [f.name, f.data.length])).toEqual([
      ['DEVELOP.MOD', 10], ['00078490.609', 27],
    ]);
    expect(new TextDecoder().decode(entry.files[1].data)).toBe('[OPEN_FACTORY_DEBUG_MENU]\r\n');
    expect(engine.info.shutdown.GR3X_HDF).toMatchObject({ size: 7264, sampling: '420' });
    // read and checked, but no longer offered (no start-up script route in GR Mod 0.8)
    expect(() => engine.rotationScript('GR3X_HDF', 2)).toThrow('startup scripts is not ported');
  });
});
