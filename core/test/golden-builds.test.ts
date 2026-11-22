// SPDX-License-Identifier: GPL-2.0-only
/**
 * The files GR Mod builds, pinned: for every official release, a set of recipes that between them use every
 * feature, and the SHA-256 of what each makes (or the error it is refused with). The hashes are in
 * golden-builds.json, recorded from the program as it was before its per-release copies were merged into one;
 * a change to the engine that alters a single byte of any build, on any release, fails here.
 *
 * Needs the official files (each release is skipped without its file):
 *   testdata/private/official.bin (GR IV 1.11), GRMOD_GR4_120_FIRMWARE, GRMOD_GR4_121_FIRMWARE,
 *   GRMOD_GR3_FIRMWARE (2.10), GRMOD_GR3_220_FIRMWARE, GRMOD_GR3_221_FIRMWARE,
 *   GRMOD_GR3X_FIRMWARE (1.60), GRMOD_GR3X_170_FIRMWARE, GRMOD_GR3X_171_FIRMWARE
 *
 * GRMOD_GOLDEN=record writes golden-builds.json instead of comparing (only for a change that is meant to alter
 * the builds, and then with the reason in the commit).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src';
import * as fw from '../src/fw';
import type { BuildOptions, ExtraSlotSpec } from '../src';
import { testPresetRequests, testRatios } from './fw-helpers/test-firmware';

const GOLDEN = fileURLToPath(new URL('./golden-builds.json', import.meta.url));
const record = process.env.GRMOD_GOLDEN === 'record';
const FILES: Record<string, string | undefined> = {
  'gr4-1.11': fileURLToPath(new URL('../testdata/private/official.bin', import.meta.url)),
  'gr4-1.20': process.env.GRMOD_GR4_120_FIRMWARE, 'gr4-1.21': process.env.GRMOD_GR4_121_FIRMWARE,
  'gr3-2.10': process.env.GRMOD_GR3_FIRMWARE, 'gr3-2.20': process.env.GRMOD_GR3_220_FIRMWARE, 'gr3-2.21': process.env.GRMOD_GR3_221_FIRMWARE,
  'gr3x-1.60': process.env.GRMOD_GR3X_FIRMWARE, 'gr3x-1.70': process.env.GRMOD_GR3X_170_FIRMWARE, 'gr3x-1.71': process.env.GRMOD_GR3X_171_FIRMWARE,
};
// @decision DEC-HLG-GOLDEN-001: the HLG photo mode adds `hlgPhoto` to the file information and to what a file reads
// back as; it is left out of those two hashes, so the hashes pinned before HLG stay valid while every built file must
// still be byte for byte the same. HLG builds have their own tests (hlg-121.test.ts).
const HLG_FIELD = 'hlgPhoto';
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
type Args = Parameters<Engine['buildFirmware']>;

const curve = (g: number): number[] => Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, g))));
const rgb = (seed: number): Uint8Array => new Uint8Array(720 * 480 * 3).map((_, i) => (i * seed + (i >> 11)) & 255);

/** The recipes of a GR IV release. */
function gr4Recipes(eng: Engine): [string, () => Args][] {
  const looks = eng.info.looks!;
  const icon = (v: number): Uint8Array => fw.composeIcon(eng.info.tiles.film, new Float32Array(40 * 40).fill(v));
  const slot = (name: string, halation = false): ExtraSlotSpec => ({ name, matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [curve(0.9), curve(1), curve(1.1)],
    postQ9: [512, 0, 0, 0, 512, 0, 0, 0, 512], icon: icon(halation ? 0.7 : 0.4), ...(halation ? { halation: true } : {}) } as ExtraSlotSpec);
  const order = [looks.extraFirst + 1, looks.extraFirst, ...looks.factory];
  const preview = eng.info.features.exposurePreview ? { exposurePreview: true } : {};
  const pictures = () => [1, 2].map((k) => ({ id: 0x2000 + k, name: `Golden ${k}`, jpeg: eng.encodeMenuPicture(rgb(5 + 2 * k)) }));
  const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }] as Args[2];
  const grid = { g3: [true, true, true, true, true, true, true, false], g4: [false, true, false, false, true, false, true, true] };
  const all: BuildOptions = { dateStamp: true, adjSoftFocus: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8, ...preview, brightAuto: 'balanced' };
  return [
    ['ratios', () => [[], testRatios(eng)]],
    ['ratios, no guard', () => [[], testRatios(eng), [], { guard: false }]],
    ['date imprint, ADJ soft focus', () => [[], [], [], { dateStamp: true, adjSoftFocus: true }]],
    ['presets, ratios, clarity soft focus, monochrome looks', () => [testPresetRequests(eng), testRatios(eng), soft, { monoUnlock: true }]],
    ['presets with halation', () => [testPresetRequests(eng).map((r) => ({ ...r, halation: true })), [], [], {}]],
    ['added slots, menu order', () => [[], [], [], { dateStamp: true, extraSlots: [slot('A1'), slot('B2')], lookLayout: { order, hidden: [looks.factory[9]] } }]],
    ['added slot with halation', () => [[], [], [], { extraSlots: [slot('Halo', true)] }]],
    ['direct flash', () => [[], [], [], { directFlash: true }]],
    ['HDR gain map', () => [[], [], [], { hdrGainMap: true }]],
    ['HDR gain map, date imprint, halation slot', () => [[], [], [], { hdrGainMap: true, dateStamp: true, extraSlots: [slot('Halo', true)] }]],
    ['ADJ slots 6', () => [[], [], [], { adjSlots: 6 }]],
    ['ADJ slots 8 with everything on the lever', () => [[], [], [], { adjSlots: 8, adjSoftFocus: true, dateStamp: true, directFlash: true, monoUnlock: true }]],
    ['exposure preview', () => [[], [], [], { exposurePreview: true }]],
    ['exposure preview, ADJ soft focus, direct flash', () => [[], [], [], { exposurePreview: true, adjSoftFocus: true, directFlash: true }]],
    ['exposure preview always off (test build)', () => [[], [], [], { exposurePreviewOff: true }]],
    ['exposure preview always off, date imprint (test build)', () => [[], [], [], { exposurePreviewOff: true, dateStamp: true }]],
    ['auto brightness: bright', () => [[], [], [], { brightAuto: 'bright' }]],
    ['auto brightness: balanced', () => [[], [], [], { brightAuto: 'balanced' }]],
    ['power-off pictures', () => [[], [], [], { shutdownPictures: pictures() }]],
    ['monochrome looks', () => [[], [], [], { monoUnlock: true }]],
    ['everything', () => [testPresetRequests(eng).map((r) => ({ ...r, halation: true })), testRatios(eng), [],
      { ...all, extraSlots: [slot('A1'), slot('Halo', true), slot('C3')], shutdownPictures: pictures(), lookLayout: { order: [looks.extraFirst + 2, ...order], hidden: [looks.factory[3], looks.extraFirst + 1] } }]],
    ['everything, test diagnostics', () => [[], [], [], { ...all, dateStampDiag: true, halationDiag: true, hdrDiag: true, dateStampFixed: 3 }]],
    ['battery percentage', () => [[], [], [], { batteryPercent: true }]],
    ['battery percentage, diagnostics', () => [[], [], [], { batteryPercent: true, batteryDiag: true }]],
    ['custom grid', () => [[], [], [], { customGrid: grid }]],
    ['live-view shade', () => [[], testRatios(eng), [], { ratioShade: true }]],
    ['live-view shade (light), custom grid, battery percentage, everything', () => [[], testRatios(eng), [], { ...all, ratioShade: true, ratioShadeTone: 'light', customGrid: grid, batteryPercent: true }]],
  ];
}

/** The recipes of a GR III / IIIx release. */
function gr3Recipes(eng: Engine): [string, () => Args][] {
  const ids = eng.info.slots.map((s) => s.id);
  const preset = { matrixQ13: Int16Array.from([9100, -600, -308, -300, 8800, -308, -100, -700, 8992]), curves: [Uint16Array.from(curve(0.8)), Uint16Array.from(curve(0.8)), Uint16Array.from(curve(0.8))] as [Uint16Array, Uint16Array, Uint16Array] };
  const films = (n: number): Args[0] => ids.slice(0, n).map((slot, i) => ({ slot, names: { en: `Film ${i + 1}` }, ...(i % 4 === 0 ? { preset } : {}), ...(i % 5 === 1 ? { halation: 1 as const } : {}) })) as Args[0];
  const ratios = [{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:3', name: '4:3' }];
  const pictures = () => [{ id: 0x1007, name: 'Golden', jpeg: eng.encodeMenuPicture(rgb(7)) }];
  const order = [64, 11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21, ...Array.from({ length: 19 }, (_, k) => 65 + k)];
  const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }] as Args[2];
  return [
    ['ratios', () => [[], ratios]],
    ['ratios, no guard', () => [[], ratios, [], { guard: false }]],
    ['nine films (T6)', () => [films(9), ratios, soft]],
    ['nine films, ADJ soft focus', () => [films(9), ratios.slice(0, 1), [], { adjSoftFocus: true }]],
    ['20 films, date, pictures, order (round 8)', () => [films(20), ratios, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, shutdownPictures: pictures(), lookLayout: { order, hidden: [18, 83] } }]],
    ['20 films, date (round 7)', () => [films(20), ratios, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, gr3Round: 7 }]],
    ['20 films, date (round 8)', () => [films(20), ratios, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, gr3Round: 8 }]],
    ['20 films, date (round 10)', () => [films(20), ratios, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, gr3Round: 10 }]],
    ['9 films, date, no guard (round 6)', () => [films(9), ratios, [], { filmCount: 9, dateStamp: true, guard: false }]],
    ['5 films', () => [films(5), ratios, [], { filmCount: 5 }]],
    ['1 film, order', () => [films(1), ratios, [], { filmCount: 1, lookLayout: { order: [64, 11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21], hidden: [12] } }]],
    ['date imprint and pictures without films', () => [[], ratios, [], { dateStamp: true, shutdownPictures: pictures() }]],
    ['date imprint only', () => [[], ratios.slice(1), [], { dateStamp: true }]],
    ['order only', () => [[], ratios, [], { lookLayout: { order: [12, 11, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21], hidden: [21] } }]],
    ['GR IV options are refused or ignored', () => [[], ratios, [], { directFlash: true, hdrGainMap: true, adjSlots: 8, monoUnlock: true, exposurePreview: true, brightAuto: true }]],
    ['seven ratios', () => [[], [['65:24', 'XPan'], ['2.39:1', 'Scope'], ['4:3', '4:3'], ['16:9', '16:9'], ['5:4', '5:4'], ['2:1', '2:1'], ['7:6', '7:6']].map(([ratio, name]) => ({ ratio, name }))]],
  ];
}

const golden: Record<string, Record<string, string>> = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};

describe('golden builds', () => {
  for (const [release, path] of Object.entries(FILES)) {
    it.skipIf(!path || !existsSync(path))(release, async () => {
      const raw = new Uint8Array(readFileSync(path!));
      const eng = await Engine.open(raw);
      const got: Record<string, string> = { version: eng.info.version, info: sha(JSON.stringify(eng.info, (k, v) => k === HLG_FIELD ? undefined : (ArrayBuffer.isView(v) ? sha(new Uint8Array((v as Uint8Array).buffer, (v as Uint8Array).byteOffset, (v as Uint8Array).byteLength)) : v))) };
      for (const [name, args] of eng.info.family === 'gr4' ? gr4Recipes(eng) : gr3Recipes(eng)) {
        try {
          const built = await eng.buildFirmware(...args());
          got[name] = sha(built.file);
          // what the program reads back from its own file is part of the contract too
          const seen = await eng.inspect(built.file);
          got[name + ' / inspect'] = sha(JSON.stringify(seen, (k, v) => k === HLG_FIELD ? undefined : (ArrayBuffer.isView(v) ? sha(new Uint8Array((v as Uint8Array).buffer, (v as Uint8Array).byteOffset, (v as Uint8Array).byteLength)) : v)));
        } catch (e) {
          got[name] = 'refused: ' + String((e as Error).message).slice(0, 160);
        }
      }
      if (record) {
        golden[release] = got;
        writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n');
        return;
      }
      expect(golden[release], `no golden hashes for ${release}: record them first`).toBeDefined();
      for (const k of Object.keys({ ...golden[release], ...got })) expect(got[k], `${release}: ${k}`).toBe(golden[release][k]);
    }, 3_600_000);
  }
});
