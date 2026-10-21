// SPDX-License-Identifier: GPL-2.0-only
/**
 * Firmware 1.20: the file of GR IV / GR IV HDF 1.20 and GR IV Monochrome 1.10 (see
 * src/fw/target.ts). Needs it in testdata/private/official-120.bin (skipped without it).
 *
 * Every addition that applies to the Monochrome (ratios, soft focus on the ADJ lever, the date
 * imprint, power-off pictures) builds alone and with the others, passes the self-check and reads
 * back as verified; the colour work is refused. What the hooks do when they run is checked in an
 * emulator by the tools of tools/port120/ on builds of this code.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';
import type { ShutdownPictureSpec } from '../src/fw';
import { TARGET_120 } from '../src/fw/target';
import { VA_120 } from '../src/fw/target120';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official-120.bin');
const { aspect } = fw;

function picture(seed: number): Uint8Array {
  const rgb = new Uint8Array(720 * 480 * 3);
  for (let y = 0; y < 480; y++) for (let x = 0; x < 720; x++) {
    const i = (y * 720 + x) * 3;
    rgb[i] = (x * seed) & 255;
    rgb[i + 1] = (y * 2 + seed * 40) & 255;
    rgb[i + 2] = Math.hypot(x - 360, y - 240) < 100 ? 255 : 30;
  }
  return rgb;
}
const pictures = (n: number): ShutdownPictureSpec[] => Array.from({ length: n }, (_, k) => ({ id: 0x200 + 5 * k, name: `Mono ${k + 1}`, jpeg: aspect.encodeShutdownPicture(picture(k + 3)) }));
const RATIOS = [{ name: 'XPan', ratio: '65:24' }, { name: '5:4', ratio: '5:4' }, { name: '2.39:1', ratio: '2.39:1' }];

describe('firmware 1.20: the address table', () => {
  it('maps every address to another place in the RTOS image or RAM, and none twice', () => {
    expect(VA_120.size).toBeGreaterThan(250);
    const seen = new Map<number, number>();
    for (const [a, b] of VA_120) {
      expect(b >= 0x53000000 && b < 0x56000000).toBe(true);
      expect(seen.has(b) ? `0x${b.toString(16)} for 0x${a.toString(16)} and 0x${seen.get(b)!.toString(16)}` : '').toBe('');
      seen.set(b, a);
    }
    expect(() => TARGET_120.va(0x53000004)).toThrow(/no place in firmware 1.20/);
  });
});

describe.skipIf(!have)('firmware 1.20 (GR IV 1.20, GR IV Monochrome 1.10)', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official-120.bin')) : new Uint8Array();
  let eng: Engine;

  it('opens as 1.20 with the Monochrome as 1.10, without the colour work', async () => {
    eng = await Engine.open(raw);
    expect(eng.info.target).toBe('1.20');
    expect(eng.info.version).toBe('1.20');
    expect(eng.info.versions).toEqual({ STANDARD: '1.20', HDF: '1.20', MONO: '1.10' });
    expect(eng.info.colour).toBe(false);
    expect(eng.info.bridge).toBe(false);
    expect(eng.info.slots).toEqual([]);
    expect(eng.info.shutdown.MONO?.size).toBe(56571);
    expect(eng.info.factoryEntry.files.length).toBe(2);
    expect(eng.info.allowed.en).toContain('A');
    const summary = await eng.inspect(raw);
    expect(summary.kind).toBe('official');
  });

  const cases: { name: string; ratios: boolean; options: BuildOptions }[] = [
    { name: 'ratios', ratios: true, options: {} },
    { name: 'soft focus on the ADJ lever', ratios: false, options: { adjSoftFocus: true } },
    { name: 'date imprint', ratios: false, options: { dateStamp: true } },
    { name: 'power-off pictures', ratios: false, options: { shutdownPictures: pictures(2) } },
    { name: 'everything', ratios: true, options: { adjSoftFocus: true, dateStamp: true, shutdownPictures: pictures(3) } },
  ];
  for (const c of cases) {
    it(`builds ${c.name}, passes the self-check, reads back verified`, async () => {
      eng ??= await Engine.open(raw);
      const b = await eng.buildFirmware([], c.ratios ? RATIOS : [], [], c.options);
      expect(Object.values(b.checks).every((x) => x === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect(s.ratios.map((r) => r.name)).toEqual(c.ratios ? RATIOS.map((r) => r.name) : []);
      expect(s.adjSoftFocus).toBe(!!c.options.adjSoftFocus);
      expect(s.dateStamp).toBe(!!c.options.dateStamp);
      expect((s.shutdownPictures ?? []).map((x) => x.name)).toEqual((c.options.shutdownPictures ?? []).map((x) => x.name));
      // the model records (the Monochrome's 1.10.10.4 among them) are the official ones
      const f = new fw.Firmware(b.file);
      expect(Array.from(f.models)).toEqual(Array.from(new fw.Firmware(raw).models));
    });
  }

  it('refuses the colour work', async () => {
    eng ??= await Engine.open(raw);
    await expect(eng.buildFirmware([], [], [], { monoUnlock: true })).rejects.toMatchObject({ code: 'unsupported-feature' });
    await expect(eng.buildFirmware([], [], [{ level: -2, strength: 'weak' }])).rejects.toMatchObject({ code: 'unsupported-feature' });
    expect(() => eng.convertPreset('cube', 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n')).toThrow(/not available for firmware 1.20/);
  });
});
