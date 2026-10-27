// SPDX-License-Identifier: GPL-2.0-only
/**
 * The brighter Auto screen (`src/fw/aspect/brightauto.ts`): the 18 y words of the auto-brightness
 * curve at 0x53dba13c and the two 1050 limits (movw at 0x532681a4 and 0x532681c4) become the
 * brighter curve and 1500. Alone it is written in place (official layout + the compensation word);
 * with anything that appends code it goes into the grown build, whose record then has revision 4
 * and a second feature byte. Needs the official firmware in testdata/private (skipped without it).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';
import { testPresetRequests, testRatios } from './fw-helpers/test-firmware';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');

const X = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
const OFFICIAL_Y = [53, 63, 75, 90, 110, 150, 210, 260, 280, 285, 290, 320, 356, 470, 610, 770, 930, 1050];
const BRIGHT_Y = [53, 65, 80, 100, 140, 210, 300, 400, 480, 540, 600, 660, 740, 840, 970, 1130, 1320, 1500];
const TABLE = 0x53dba138;

const extra = (name: string) => ({ name, matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [0, 1, 2].map(() => Array.from({ length: 256 }, (_, i) => i * 16)) as [number[], number[], number[]], icon: new Uint8Array(40 * 40 * 4) });

describe.skipIf(!have)('brighter Auto screen', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  const rtosOf = (file: Uint8Array): Uint8Array => {
    const d = new fw.Firmware(file).decoded;
    const r = fw.sectionsOf(d).find((s) => s.name === 'RTOS')!;
    return d.subarray(r.offset, r.offset + r.size);
  };
  const wordOf = (rtos: Uint8Array, va: number): number => new DataView(rtos.buffer, rtos.byteOffset).getUint32(va - 0x53000000, true);
  const bytesOf = (rtos: Uint8Array, va: number): number[] => Array.from(rtos.subarray(va - 0x53000000, va - 0x53000000 + 4));

  it('the official file has the curve and the limits the patch expects', () => {
    const r = rtosOf(raw);
    expect(X.map((_, i) => wordOf(r, TABLE + 8 * i))).toEqual(X);
    expect(X.map((_, i) => wordOf(r, TABLE + 4 + 8 * i))).toEqual(OFFICIAL_Y);
    expect(bytesOf(r, 0x532681a4)).toEqual([0x1a, 0x34, 0x00, 0xe3]);
    expect(bytesOf(r, 0x532681c4)).toEqual([0x1a, 0x04, 0x00, 0xe3]);
  });

  function expectBright(file: Uint8Array): void {
    const r = rtosOf(file);
    expect(X.map((_, i) => wordOf(r, TABLE + 8 * i))).toEqual(X); // x words unchanged
    expect(X.map((_, i) => wordOf(r, TABLE + 4 + 8 * i))).toEqual(BRIGHT_Y);
    for (let i = 1; i < BRIGHT_Y.length; i++) expect(BRIGHT_Y[i]).toBeGreaterThanOrEqual(BRIGHT_Y[i - 1]);
    expect(bytesOf(r, 0x532681a4)).toEqual([0xdc, 0x35, 0x00, 0xe3]);
    expect(bytesOf(r, 0x532681c4)).toEqual([0xdc, 0x05, 0x00, 0xe3]);
  }

  it('alone and in place (no guard): official layout, 19 words and the compensation word', async () => {
    const eng = await Engine.open(raw);
    expect(eng.info.features.brightAuto).toBe(true);
    const b = await eng.buildFirmware([], [], [], { brightAuto: true, guard: false });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, brightAuto: true });
    expectBright(b.file);
    const d = new fw.Firmware(b.file).decoded;
    const o = new fw.Firmware(raw).decoded;
    expect(d.length).toBe(o.length);
    const changed: string[] = [];
    for (let i = 0; i < o.length; i += 4) if (!fw.equalRange(d, i, o, i, 4)) changed.push((i - fw.RTOS_OFFSET + 0x53000000).toString(16));
    const want = [0x532681a4, 0x532681c4, ...BRIGHT_Y.map((_, i) => TABLE + 4 + 8 * i).filter((_, i) => BRIGHT_Y[i] !== OFFICIAL_Y[i]), fw.COMP_VA].sort((a, c) => a - c).map((a) => a.toString(16));
    expect(changed).toEqual(want);
    expect(changed.length).toBe(17 + 2 + 1);
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.brightAuto).toBe(true);
    expect(s.monoUnlock).toBe(false);
  });

  it('in place with the monochrome looks: both are recognised', async () => {
    const eng = await Engine.open(raw);
    const b = await eng.buildFirmware([], [], [], { brightAuto: true, monoUnlock: true, guard: false });
    expectBright(b.file);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.brightAuto).toBe(true);
    expect(s.monoUnlock).toBe(true);
  });

  const cases: { name: string; options: BuildOptions; ratios?: boolean; presets?: boolean }[] = [
    { name: 'alone (with the settings guard, as the program builds)', options: { brightAuto: true } },
    { name: 'with a ratio', options: { brightAuto: true }, ratios: true },
    { name: 'with ADJ soft focus', options: { brightAuto: true, adjSoftFocus: true } },
    { name: 'with the date imprint', options: { brightAuto: true, dateStamp: true } },
    { name: 'with an added slot', options: { brightAuto: true, extraSlots: [extra('GR Mod 1')] } },
    { name: 'with the monochrome looks and a preset', options: { brightAuto: true, monoUnlock: true, adjSoftFocus: true }, ratios: true, presets: true },
    { name: 'with Direct Flash', options: { brightAuto: true, directFlash: true } },
  ];
  for (const c of cases) {
    it(`grown: ${c.name}: passes the self-check, reads back, curve as specified`, async () => {
      const eng = await Engine.open(raw);
      const b = await eng.buildFirmware(c.presets ? testPresetRequests(eng) : [], c.ratios ? testRatios(eng) : [], [], c.options);
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      expectBright(b.file);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect(s.brightAuto).toBe(true);
      expect(s.monoUnlock).toBe(!!c.options.monoUnlock);
      expect(s.dateStamp).toBe(!!c.options.dateStamp);
      expect(s.adjSoftFocus).toBe(!!c.options.adjSoftFocus);
      expect(s.extraSlots.length).toBe(c.options.extraSlots?.length ?? 0);
      expect(!!s.directFlash).toBe(!!c.options.directFlash);
      if (c.ratios) expect(s.ratios.length).toBeGreaterThan(0);
      const rtos = rtosOf(b.file);
      expect(fw.readBuildRevision(rtos)).toBe(4);
      expect(fw.readExtensionFeatures(rtos)?.brightAuto).toBe(true);
    });
  }

  it('without the switch nothing changes: revision 3, no brighter curve, same file as before', async () => {
    const eng = await Engine.open(raw);
    const a = await eng.buildFirmware([], [], [], { dateStamp: true });
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, brightAuto: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect(fw.readBuildRevision(rtosOf(a.file))).toBe(3);
    const r = rtosOf(a.file);
    expect(X.map((_, i) => wordOf(r, TABLE + 4 + 8 * i))).toEqual(OFFICIAL_Y);
    const s = await eng.inspect(a.file);
    expect(s.verified).toBe(true);
    expect(s.brightAuto).toBeFalsy();
  });

  it('a file with one curve word missing is not recognised as the brighter Auto screen', async () => {
    const eng = await Engine.open(raw);
    const b = await eng.buildFirmware([], [], [], { brightAuto: true, guard: false });
    const d = new fw.Firmware(b.file).decoded.slice();
    const o = new fw.Firmware(raw).decoded;
    const at = fw.RTOS_OFFSET + TABLE + 4 + 8 * 10 - 0x53000000;
    d.set(o.subarray(at, at + 4), at);
    const delta = fw.sum32(d);
    const comp = new DataView(d.buffer, d.byteOffset).getUint32(fw.COMP_OFFSET, true);
    new DataView(d.buffer, d.byteOffset).setUint32(fw.COMP_OFFSET, (comp - delta) >>> 0, true);
    const s = await eng.inspect(fw.build(new fw.Firmware(raw), d).out);
    expect(s.brightAuto).toBeFalsy();
    expect(s.verified).toBe(false);
  });

  it('refuses a layout it does not know', async () => {
    const eng = await Engine.open(raw);
    // A patch on a payload whose limit is not the official instruction fails with unexpected-layout.
    const d = new fw.Firmware(raw).decoded.slice();
    const at = fw.RTOS_OFFSET + 0x532681a4 - 0x53000000;
    d[at] ^= 0xff;
    expect(() => fw.brightAutoWords(d)).toThrowError(expect.objectContaining({ code: 'unexpected-layout' }));
    expect(eng.info.family).toBe('gr4');
  });
});
