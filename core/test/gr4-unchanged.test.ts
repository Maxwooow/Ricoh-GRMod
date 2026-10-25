// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR IV files are built exactly as GR Mod 0.8.4 built them (wip-0.8.4, 1bcc42b), with the GR III /
 * IIIx support in the same program: the SHA-256 of each file and of each preset conversion below was
 * made by that version and by this one, and they agree. A change for GR III that touches GR IV's
 * output fails here. Needs the official GR IV firmware in testdata/private (skipped without it).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Engine } from '../src';
import { testPresetRequests, testRatios } from './fw-helpers/test-firmware';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(!have)('GR IV output unchanged by the GR III support', () => {
  const curves = [0, 1, 2].map(() => Uint16Array.from({ length: 256 }, (_, i) => Math.round((i / 255) * 16383)));
  const icon = new Uint8Array(40 * 40 * 4);
  for (let i = 0; i < 1600; i++) icon[i * 4 + 3] = 255;
  const extra = (name: string) => ({ name, matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: curves as never, icon });
  const FACTORY_TAIL = [13, 14, 15, 16, 24, 17, 18, 19, 23, 20, 21, 22, 25, 29, 26, 27, 28, 30];

  it('builds the same files as GR Mod 0.8.4', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    expect(eng.info.family).toBe('gr4');
    const cases: [string, () => Promise<{ file: Uint8Array }>, string][] = [
      ['ratios', () => eng.buildFirmware([], testRatios(eng)), '6e8de8e2edd17955e2a1dfdf7645ecc51b2ae5f3ed7e84c820bbbbadee407668'],
      ['date imprint and ADJ soft focus', () => eng.buildFirmware([], [], [], { dateStamp: true, adjSoftFocus: true }), '3cc84b31a619d8d96cf3b230c104648c86a8cabcbf9229584544e4f48892c844'],
      ['two presets, ratios, clarity soft focus, monochrome looks', () => eng.buildFirmware(testPresetRequests(eng), testRatios(eng), [{ level: -1, strength: 'weak' }], { monoUnlock: true }),
        '3a01bdcf406de6e5cf4cb07bf5dce04a150cf4bd7c496d52627eb405deae2b66'],
      ['added slots and a menu order', () => eng.buildFirmware([], [], [], { dateStamp: true, extraSlots: [extra('A1'), extra('B2')], lookLayout: { order: [35, 34, 12, 11, ...FACTORY_TAIL], hidden: [20, 35] } }),
        'aec40fb3cf0a309c6aaf043fc7ace956753749e533a0e32598a4e06cd63e9a7f'],
      ['menu order only', () => eng.buildFirmware([], [], [], { lookLayout: { order: [12, 11, ...FACTORY_TAIL], hidden: [21] } }), '79eab5b6f386e55706942f1e6bc0e1fa9b4c8d6ef764544a05eaffeb23dec3e2'],
    ];
    for (const [name, build, want] of cases) expect(sha((await build()).file), name).toBe(want);
  }, 900_000);

  it('converts presets as GR Mod 0.8.4', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const cube = readFileSync(new URL('../../examples/gr3x/Demo-Warm.cube', import.meta.url), 'utf8');
    expect(sha(JSON.stringify(eng.convertPreset('cube', cube)))).toBe('9cdbb9a0502729d10804de17ea41c625fd9654f68fea2d27a99ff93835c29838');
    expect(sha(JSON.stringify(eng.convertPreset('cube', cube, undefined, { post: false })))).toBe('4239dab048bb59b581f4a5f9fcc55ba91943e8ecd879914d91f38ea7614b959d');
  }, 300_000);
});
