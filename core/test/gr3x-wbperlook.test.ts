// SPDX-License-Identifier: GPL-2.0-only
/**
 * White balance per look on GR III 2.10 (`gr3x/wbperlook.ts`, films.c with -DWB_PER_LOOK, hooks in
 * films-r10.ts). Needs GRMOD_GR3_FIRMWARE (2.10); GRMOD_GR3_220_FIRMWARE / GRMOD_GR3_221_FIRMWARE for
 * "not offered". GRMOD_WB_OUT, when set, gets the built file (for tools/gr3x/wbperlook_probe.py).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sectionsOf } from '../src/fw/container';

const RATIOS = [{ ratio: '16:9', name: '16:9' }];
const F210 = process.env.GRMOD_GR3_FIRMWARE;
const have = (p?: string): p is string => !!p && existsSync(p);
const film = [{ slot: 'CY' as const, names: { en: 'Film 1' } }];

/** The RTOS words a build changed (address -> [official, built]), for a diff of two builds. */
function rtosWords(file: Uint8Array): Uint32Array {
  const decoded = new Firmware(file).decoded;
  const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS')!;
  return new Uint32Array(decoded.slice(rtos.offset, rtos.offset + rtos.size).buffer);
}

describe.skipIf(!have(F210))('white balance per look, GR III 2.10', () => {
  it('is offered, builds with a film, reads back, and leaves the other builds unchanged', async () => {
    const raw = new Uint8Array(readFileSync(F210!));
    const engine = await Engine.open(raw);
    expect(engine.info.features.wbPerLook).toBe(true);
    const plain = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1 });
    const wb = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, wbPerLook: true });
    const off = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, wbPerLook: false });
    expect(off.sha256).toBe(plain.sha256);
    expect(wb.sha256).not.toBe(plain.sha256);
    expect(wb.features.wbPerLook).toBe(true);
    const back = await engine.inspect(wb.file);
    expect(back.kind).toBe('modified');
    expect(back.verified).toBe(true);
    expect(back.wbPerLook).toBe(true);
    const plainBack = await engine.inspect(plain.file);
    expect(plainBack.kind).toBe('modified');
    expect(plainBack.wbPerLook).toBeUndefined();
    // The photo-set setter is patched only with the option.
    const at = (0x5327b374 - 0x53000000) / 4;
    expect(rtosWords(plain.file)[at]).toBe(0xe5903004);
    expect(rtosWords(wb.file)[at]).not.toBe(0xe5903004);
    if (process.env.GRMOD_WB_OUT) {
      writeFileSync(process.env.GRMOD_WB_OUT, wb.file);
      writeFileSync(process.env.GRMOD_WB_OUT + '.manifest.json', JSON.stringify(wb.checks ?? null));
    }
  }, 600_000);
  it('puts the Custom entries before the films on request, alone and with the white balance per look', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(F210!)));
    expect(engine.info.features.customsBeforeFilms).toBe(true);
    const plain = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1 });
    const off = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, customsBeforeFilms: false });
    expect(off.sha256).toBe(plain.sha256);
    for (const options of [{ customsBeforeFilms: true }, { customsBeforeFilms: true, wbPerLook: true }]) {
      const b = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, ...options });
      expect(b.sha256).not.toBe(plain.sha256);
      const back = await engine.inspect(b.file);
      expect(back.kind).toBe('modified');
      expect(back.verified).toBe(true);
      expect(back.customsBeforeFilms).toBe(true);
      expect(back.wbPerLook).toBe(options.wbPerLook);
      // The menu row's text function goes through the map.
      expect(rtosWords(b.file)[(0x531a0538 - 0x53000000) / 4]).not.toBe(0xe1a0c00d);
    }
    expect(rtosWords(plain.file)[(0x531a0538 - 0x53000000) / 4]).toBe(0xe1a0c00d);
    await expect(engine.buildFirmware([], RATIOS, [], { customsBeforeFilms: true })).rejects.toThrow(/film/);
  }, 600_000);
  it('keeps the lists\' order in the camera on request, with the other options, and reads back', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(F210!)));
    expect(engine.info.features.liveLayout).toBe(true);
    const plain = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1 });
    expect((await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, liveLayout: false })).sha256).toBe(plain.sha256);
    for (const options of [{ liveLayout: true }, { liveLayout: true, wbPerLook: true, customsBeforeFilms: true }]) {
      const b = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, ...options });
      const back = await engine.inspect(b.file);
      expect(back.kind).toBe('modified');
      expect(back.verified).toBe(true);
      expect(back.liveLayout).toBe(true);
      expect(back.customsBeforeFilms).toBe(options.customsBeforeFilms);
    }
    await expect(engine.buildFirmware([], RATIOS, [], { liveLayout: true })).rejects.toThrow(/film/);
  }, 600_000);
  it('has the order\'s screen in the still menu on request, with the layout kept in the camera only', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(F210!)));
    expect(engine.info.features.lookMenu).toBe(true);
    const b = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, liveLayout: true, lookMenu: true });
    const back = await engine.inspect(b.file);
    expect(back.kind).toBe('modified');
    expect(back.verified).toBe(true);
    expect(back.lookMenu).toBe(true);
    expect(back.liveLayout).toBe(true);
    const live = await engine.buildFirmware(film, RATIOS, [], { filmCount: 1, liveLayout: true });
    expect((await engine.inspect(live.file)).lookMenu).toBeUndefined();
    await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, lookMenu: true })).rejects.toThrow(/liveLayout/);
    await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, liveLayout: true, lookMenu: true, dateStamp: true })).rejects.toThrow(/date imprint/);
  }, 600_000);
  it('needs a film and a boolean', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(F210!)));
    await expect(engine.buildFirmware([], RATIOS, [], { wbPerLook: true })).rejects.toThrow(/film/);
    await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, wbPerLook: 1 as unknown as boolean })).rejects.toThrow(/boolean/);
    await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, gr3Round: 9, wbPerLook: true })).rejects.toThrow(/round 10/);
  }, 600_000);
});

for (const [name, path] of [['2.20', process.env.GRMOD_GR3_220_FIRMWARE], ['2.21', process.env.GRMOD_GR3_221_FIRMWARE]] as const) {
  describe.skipIf(!have(path))(`white balance per look, GR III ${name}`, () => {
    it('is not offered', async () => {
      const engine = await Engine.open(new Uint8Array(readFileSync(path!)));
      expect(engine.info.features.wbPerLook).toBeUndefined();
      expect(engine.info.features.customsBeforeFilms).toBeUndefined();
      expect(engine.info.features.liveLayout).toBeUndefined();
      expect(engine.info.features.lookMenu).toBeUndefined();
      await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, liveLayout: true })).rejects.toThrow(/2\.10/);
      await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, customsBeforeFilms: true })).rejects.toThrow(/2\.10/);
      await expect(engine.buildFirmware(film, RATIOS, [], { filmCount: 1, wbPerLook: true })).rejects.toThrow(/2\.10/);
    }, 600_000);
  });
}
