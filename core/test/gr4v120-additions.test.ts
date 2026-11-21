// SPDX-License-Identifier: GPL-2.0-only
/**
 * The battery percentage, custom grid lines and the live-view shade of added ratios on GR IV 1.20 and
 * 1.21 (the program in fw/gr4v120, ported from the 1.11 one: aspect/battery.ts, grid.ts, shade.ts).
 * Needs GRMOD_GR4_120_FIRMWARE / GRMOD_GR4_121_FIRMWARE (each release is skipped without its file).
 *
 *  - all three are offered, each builds on its own and together with every other addition (exposure
 *    preview included, whose bits share the second feature byte with the third byte's flag), and the
 *    file records them, which `inspect` reads back and verifies;
 *  - off, the files are those of before (golden-builds.test.ts pins the hashes);
 *  - test 084 (`viewmenu.ts`): the shade comes with every added ratio (how dark is chosen in the camera; the
 *    1.11 tone does not apply), the custom grids are values of the camera's Grid Style list, and flash TTL renames
 *    the two red-eye Flash Modes;
 *  - with GRMOD_DUMP=<dir>, the RTOS sections of the official file and of the builds are written there
 *    for the emulator checks (tools/gr4v120/{battery,grid,shade}, tools/gr4v121/...).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';
import { testRatios } from './fw-helpers/test-firmware';

const FILES: Record<string, string | undefined> = { '1.20': process.env.GRMOD_GR4_120_FIRMWARE, '1.21': process.env.GRMOD_GR4_121_FIRMWARE };
const DUMP = process.env.GRMOD_DUMP;
const GRID = { g3: [true, true, true, true, true, true, true, false], g4: [false, true, false, false, true, false, true, true] };

function rtosOf(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((s) => s.name === 'RTOS')!;
  return d.subarray(r.offset, r.offset + r.size);
}

for (const [release, path] of Object.entries(FILES)) {
  describe.skipIf(!path || !existsSync(path))(`GR IV ${release}: battery percentage, custom grid, live-view shade`, () => {
    const raw = path && existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
    let eng: Engine;
    const dump = (name: string, file: Uint8Array): void => {
      if (!DUMP) return;
      const dir = `${DUMP}/${release}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${name}.rtos`, rtosOf(file));
    };

    it('offers all three', async () => {
      eng = await Engine.open(raw);
      expect(eng.info.version).toBe(release);
      expect([eng.info.features.batteryPercent, eng.info.features.customGrid, eng.info.features.ratioShade, eng.info.features.exposurePreview]).toEqual([true, true, true, true]);
      expect([eng.info.features.shadeMenu, eng.info.features.gridMenu]).toEqual([true, true]);
      dump('official', raw);
    });

    const cases: [string, () => [Parameters<Engine['buildFirmware']>[1], BuildOptions], (i: Awaited<ReturnType<Engine['inspect']>>) => void][] = [
      ['battery', () => [[], { batteryPercent: true }], (i) => expect(i.batteryPercent).toBe(true)],
      ['battery-diag', () => [[], { batteryPercent: true, batteryDiag: true }], (i) => expect(i.batteryPercent).toBe(true)],
      ['grid', () => [[], { customGrid: GRID }], (i) => expect(i.customGrid).toEqual(GRID)],
      ['shade', () => [testRatios(eng), { ratioShade: true }], (i) => expect([i.ratioShade, i.ratioShadeTone]).toEqual([true, undefined])],
      ['shade-auto', () => [testRatios(eng), {}], (i) => expect([i.ratioShade, i.ratioShadeTone]).toEqual([true, undefined])],
      ['shade-tone', () => [testRatios(eng), { ratioShade: true, ratioShadeTone: 'light' }], (i) => expect([i.ratioShade, i.ratioShadeTone]).toEqual([true, undefined])],
      ['shade-off', () => [testRatios(eng), { shadeOff: true }], (i) => expect(i.ratioShade).toBeUndefined()],
      ['ttl', () => [[], { flashTtl: true }], (i) => expect(i.flashTtl).toBe(true)],
      ['shade-grid', () => [testRatios(eng), { ratioShade: true, customGrid: GRID }], (i) => expect([i.ratioShade, i.customGrid]).toEqual([true, GRID])],
      ['all', () => [testRatios(eng), {
        batteryPercent: true, customGrid: GRID, ratioShade: true, ratioShadeTone: 'light',
        dateStamp: true, adjSoftFocus: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8, exposurePreview: true, brightAuto: 'balanced',
        shadowLearn: true, filmGrain: true, flashTtl: true,
      }], (i) => {
        expect([i.batteryPercent, i.customGrid, i.ratioShade, i.ratioShadeTone, i.shadowLearn, i.filmGrain, i.flashTtl]).toEqual([true, GRID, true, undefined, true, true, true]);
        expect([i.exposurePreview, i.hdrGainMap, i.adjSlots, i.brightAuto, i.dateStamp, i.directFlash]).toEqual([true, true, 8, 'balanced', true, true]);
      }],
    ];
    for (const [name, args, seen] of cases) {
      it(`builds ${name} and reads it back`, async () => {
        const [ratios, options] = args();
        const built = await eng.buildFirmware([], ratios, [], options);
        expect(Object.values(built.checks).every((v) => v === true)).toBe(true);
        // A test build (diagnostics) is not one the program would make: it reads back unverified.
        const i = await eng.inspect(built.file);
        expect([i.kind, i.verified]).toEqual(['modified', !name.endsWith('-diag')]);
        if (i.verified) seen(i);
        dump(name, built.file);
        // The emulator check of the shade compares with the same build without it.
        if (DUMP && ratios && ratios.length > 0 && !options.shadeOff) dump(`${name}-plain`, (await eng.buildFirmware([], ratios, [], { ...options, shadeOff: true })).file);
      }, 600_000);
    }

    it('without an added ratio the shade is left out, and the camera\'s own grid is no custom grid', async () => {
      const plain = await eng.buildFirmware([], [], [], { dateStamp: true });
      expect((await eng.buildFirmware([], [], [], { dateStamp: true, ratioShade: true })).sha256).toBe(plain.sha256);
      expect((await eng.buildFirmware([], [], [], { dateStamp: true, customGrid: fw.aspect.CAMERA_GRID })).sha256).toBe(plain.sha256);
      expect((await eng.buildFirmware([], [], [], { dateStamp: true, batteryPercent: false })).sha256).toBe(plain.sha256);
    }, 600_000);

    it('builds the battery percentage with the HDR gain map\'s test counters (they no longer share a word)', async () => {
      const b = await eng.buildFirmware([], [], [], { batteryPercent: true, hdrGainMap: true, hdrDiag: true });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    }, 600_000);
  });
}
