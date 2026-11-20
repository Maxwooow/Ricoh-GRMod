// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR Mod's film grain in place of the camera's Grain Effect (`gr4v120/aspect/grain.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * The module and the hooks are checked by tools/gr4v120/grain (check.py: the module against the model;
 * fw_check.py: the hooks inside a built RTOS).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions, ExtraSlotSpec } from '../src';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

// Per release: the camera's grain wrapper, the development step's compare, the JPEG step's second
// instruction, and the Grain Effect row's Fn guide and Fn (shooting, RAW development).
const releases = [
  { version: '1.20', path: file120, NATIVE_GRAIN: 0x538c9854, DEV_SITE: 0x5393914c, JPEG_HOOK: 0x53727e14, MENU: [0x531cc004, 0x531cc988, 0x531aa590, 0x531ab760] },
  { version: '1.21', path: file121, NATIVE_GRAIN: 0x538ca4fc, DEV_SITE: 0x5393a714, JPEG_HOOK: 0x53728864, MENU: [0x531cc60c, 0x531ccf90, 0x531aa974, 0x531abb44] },
];

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const recordStart = (v: Uint8Array) => v.length - 16 - new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(v.length - 16, true);
const curve = (g: number): number[] => Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, g))));

for (const { version, path, NATIVE_GRAIN, DEV_SITE, JPEG_HOOK, MENU } of releases) describe.skipIf(!existsSync(path))(`film grain ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const halo = (e: Engine): ExtraSlotSpec => ({ name: 'Halo', matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [curve(0.9), curve(1), curve(1.1)],
    postQ9: [512, 0, 0, 0, 512, 0, 0, 0, 512], icon: fw.composeIcon(e.info.tiles.film, new Float32Array(1600).fill(0.6)), halation: true } as ExtraSlotSpec);
  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['alone', () => ({})],
    ['with the other additions', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced', extraSlots: [halo(e)] })],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: the camera's grain off, three hooks, appended last; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.filmGrain).toBe(true);
      const o = options(e);
      const plain = Object.keys(o).length ? await e.buildFirmware([], [], [], o) : null;
      const on = await e.buildFirmware([], [], [], { ...o, filmGrain: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const a = rtos(new Uint8Array(raw)), b = rtos(on.file);
      expect([word(a, NATIVE_GRAIN), word(a, NATIVE_GRAIN + 4)]).toEqual([0xe92d4070, 0xe59dc010]);
      expect([word(b, NATIVE_GRAIN), word(b, NATIVE_GRAIN + 4)]).toEqual([0xe3a00001, 0xe12fff1e]); // mov r0,#1; bx lr
      for (const at of [DEV_SITE, JPEG_HOOK]) {
        expect(word(b, at) >>> 24).toBe(0xea);
        expect(branchTarget(at, word(b, at)) - 0x53000000).toBeGreaterThanOrEqual(a.length);
      }
      for (const at of MENU) expect(word(b, at)).not.toBe(word(a, at));
      if (plain) {
        // Everything the other additions build stays where it was: the grain is appended after them,
        // in the zero padding after their code (and in a further container frame when it does not fit).
        const p = rtos(plain.file);
        expect(b.length).toBeGreaterThanOrEqual(p.length);
        const end = recordStart(p);
        const own = new Set([NATIVE_GRAIN, NATIVE_GRAIN + 4, DEV_SITE, JPEG_HOOK, ...MENU]);
        let first = end;
        for (let i = 0; i < end; i += 4) {
          const at = 0x53000000 + i;
          if (word(p, at) === word(b, at) || own.has(at)) continue;
          expect(word(p, at)).toBe(0);
          first = Math.min(first, i);
        }
        for (let i = first; i < end; i += 4) expect(word(p, 0x53000000 + i)).toBe(0);
        for (const at of [DEV_SITE, JPEG_HOOK]) expect(branchTarget(at, word(b, at)) - 0x53000000).toBeGreaterThanOrEqual(first);
      }
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.filmGrain).toBe(true);
      if (plain) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced', exposurePreview: true });
    }, 120000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, filmGrain: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).filmGrain).toBeUndefined();
  }, 60000);
  it('refuses a non-boolean switch', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { filmGrain: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('film grain: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.filmGrain).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, filmGrain: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
  it('the 1.21 program loads: the grain looks its addresses up only when installed', async () => {
    const m = await import('../src/fw/gr4v121');
    expect(typeof m.buildFirmware).toBe('function');
  });
});
