// SPDX-License-Identifier: GPL-2.0-only
/**
 * Custom grid lines (aspect/grid.ts, `BuildOptions.customGrid`). Needs the official firmware in
 * testdata/private (skipped without it).
 *
 *  - the camera's own grids, or none, change nothing;
 *  - with it exactly two official words change (the hooks in GridView::Draw and in its layout), the
 *    file records the lines in the third feature byte, and `inspect` reads them back and verifies
 *    the file;
 *  - it composes with every other addition: the same words are written as without it, apart from
 *    its two hooks;
 *  - with the live-view shade (when the program has it), the diagonals take the shade's point
 *    setter and the shade's words are as without the grid;
 *  - lines must be eight booleans per style; a record with the camera's own grids or an unknown bit
 *    is not valid.
 * What the code does when it runs is checked in an emulator by tools/grid/check.py.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { CustomGrid } from '../src';
import type { BuildOptions } from '../src/app/engine';
import type { ExtraSlotSpec, ShutdownPictureSpec } from '../src/fw';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const have = existsSync(P + 'official.bin');
const { aspect } = fw;
const word = (d: Uint8Array, va: number): number => new DataView(d.buffer, d.byteOffset).getUint32(fw.RTOS_OFFSET + va - 0x53000000, true);
const DRAW_HOOK = 0x5357891c;
const LAYOUT_HOOK = 0x535786f8;
const DIAGONAL_CALLS = [0x53578770, 0x535787b0];
const T = true;
const F = false;
/** 3x3: the centre cross and both diagonals, no thirds; 4x4: the quarters without the centre, one diagonal. */
const GRID: CustomGrid = { g3: [F, T, F, F, T, F, T, T], g4: [T, F, T, T, F, T, F, T] };
const CAMERA: CustomGrid = { g3: [T, F, T, T, F, T, F, F], g4: [T, T, T, T, T, T, T, T] };

function changed(a: Uint8Array, o: Uint8Array): Set<number> {
  const out = new Set<number>();
  const end = fw.RTOS_OFFSET + aspect.OFFICIAL_RTOS_LENGTH;
  for (let i = fw.RTOS_OFFSET; i < end; i += 4) {
    if (a[i] !== o[i] || a[i + 1] !== o[i + 1] || a[i + 2] !== o[i + 2] || a[i + 3] !== o[i + 3]) out.add(0x53000000 + i - fw.RTOS_OFFSET);
  }
  return out;
}

function rtosOf(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded;
  const rtos = fw.sectionsOf(d).find((s) => s.name === 'RTOS')!;
  return d.subarray(rtos.offset, rtos.offset + rtos.size);
}

describe.skipIf(!have)('custom grid lines', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;

  it('is offered for the GR IV 1.11', async () => {
    eng = await Engine.open(raw);
    expect(eng.info.features.customGrid).toBe(true);
  });

  it('the camera’s own grids change nothing', async () => {
    const ratios = [{ name: '2:1', ratio: '2:1' }];
    const plain = await eng.buildFirmware([], ratios);
    const camera = await eng.buildFirmware([], ratios, [], { customGrid: CAMERA });
    expect(camera.sha256).toBe(plain.sha256);
    expect(camera.features.customGrid).toBeUndefined();
    await expect(eng.buildFirmware([], [], [], { customGrid: CAMERA })).rejects.toThrow();
  }, 300_000);

  it('hooks GridView::Draw and its layout, records the lines and reads them back', async () => {
    const o = new fw.Firmware(raw).decoded;
    const b = await eng.buildFirmware([], [], [], { customGrid: GRID });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features.customGrid).toEqual(GRID);
    const d = new fw.Firmware(b.file).decoded;
    for (const va of [DRAW_HOOK, LAYOUT_HOOK]) {
      expect(word(d, va)).not.toBe(word(o, va));
      expect(word(d, va) >>> 24).toBe(0xea);
    }
    // Without the shade the layout's own point-setter calls stay.
    for (const va of DIAGONAL_CALLS) expect(word(d, va)).toBe(word(o, va));
    expect(fw.readExtensionFeatures(rtosOf(b.file))?.customGrid).toEqual(GRID);
    const s = await eng.inspect(b.file);
    expect([s.kind, s.verified]).toEqual(['modified', true]);
    expect(s.customGrid).toEqual(GRID);
    // Besides the settings guard and the brighter Auto curve (data words only), only its two words.
    const bright = changed(new fw.Firmware((await eng.buildFirmware([], [], [], { brightAuto: 'bright' })).file).decoded, o);
    const both = changed(new fw.Firmware((await eng.buildFirmware([], [], [], { brightAuto: 'bright', customGrid: GRID })).file).decoded, o);
    for (const va of [DRAW_HOOK, LAYOUT_HOOK]) {
      expect(bright.has(va)).toBe(false);
      expect(both.delete(va)).toBe(true);
    }
    expect([...both].sort()).toEqual([...bright].sort());
  }, 300_000);

  it('composes with every other addition', async () => {
    const curves = [0, 1, 2].map(() => Uint16Array.from({ length: 256 }, (_, i) => Math.round((i / 255) * 16383)));
    const icon = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < 1600; i++) icon[i * 4 + 3] = 255;
    const slot = (name: string): ExtraSlotSpec => ({ name, matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: curves as never, icon, halation: true });
    const rgb = new Uint8Array(720 * 480 * 3).map((_, i) => (i * 7) & 255);
    const pictures: ShutdownPictureSpec[] = [{ id: 0x100, name: 'Picture 1', jpeg: aspect.encodeShutdownPicture(rgb) }];
    const FACTORY_TAIL = [13, 14, 15, 16, 24, 17, 18, 19, 23, 20, 21, 22, 25, 29, 26, 27, 28, 30];
    const everything: BuildOptions = {
      adjSoftFocus: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced',
      extraSlots: [slot('A1'), slot('B2')], lookLayout: { order: [35, 34, 12, 11, ...FACTORY_TAIL], hidden: [20] }, shutdownPictures: pictures,
    };
    const ratios = [{ name: '2:1', ratio: '2:1' }, { name: 'XPan', ratio: '65:24' }];
    const without = await eng.buildFirmware([], ratios, [], everything);
    const built = await eng.buildFirmware([], ratios, [], { ...everything, customGrid: GRID });
    expect(Object.values(built.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(built.file);
    expect([s.verified, s.customGrid, s.hdrGainMap, s.adjSlots, s.brightAuto]).toEqual([true, GRID, true, 8, 'balanced']);
    expect([s.adjSoftFocus, s.dateStamp, s.monoUnlock, s.directFlash, s.extraSlots.length, s.shutdownPictures?.length, !!s.lookLayout]).toEqual([true, true, true, true, 2, 1, true]);
    const o = new fw.Firmware(raw).decoded;
    const ca = changed(new fw.Firmware(without.file).decoded, o);
    const cb = changed(new fw.Firmware(built.file).decoded, o);
    for (const va of [DRAW_HOOK, LAYOUT_HOOK]) {
      expect(ca.has(va)).toBe(false);
      expect(cb.delete(va)).toBe(true);
    }
    expect([...cb].sort()).toEqual([...ca].sort());
  }, 1_800_000);

  // Only when the program also has the live-view shade (aspect/shade.ts): its diagonal wrapper is
  // what the layout calls then, and the grid's diagonals go through it as well.
  it.skipIf(!have)('with the live-view shade: the shade’s words stay, the diagonals take its point setter', async (ctx) => {
    if (!(eng.info.features as Record<string, unknown>).ratioShade) return ctx.skip();
    const o = new fw.Firmware(raw).decoded;
    const ratios = [{ name: '2:1', ratio: '2:1' }];
    const shadeOnly = { ratioShade: true } as BuildOptions;
    const shade = new fw.Firmware((await eng.buildFirmware([], ratios, [], shadeOnly)).file).decoded;
    const both = await eng.buildFirmware([], ratios, [], { ...shadeOnly, customGrid: GRID });
    expect(Object.values(both.checks).every((v) => v === true)).toBe(true);
    const d = new fw.Firmware(both.file).decoded;
    for (const va of DIAGONAL_CALLS) {
      expect(word(shade, va)).not.toBe(word(o, va));
      expect(word(d, va)).not.toBe(word(o, va));
    }
    const s = await eng.inspect(both.file);
    expect([s.verified, (s as unknown as Record<string, unknown>).ratioShade, s.customGrid]).toEqual([true, true, GRID]);
    const cs = changed(shade, o);
    const cb = changed(d, o);
    for (const va of [DRAW_HOOK, LAYOUT_HOOK]) expect(cb.delete(va)).toBe(true);
    // The same words apart from the two hooks (branch targets into the appended area may differ).
    expect([...cb].sort()).toEqual([...cs].sort());
  }, 300_000);

  it('refuses bad lines', async () => {
    await expect(eng.buildFirmware([], [], [], { customGrid: { g3: [2, 0, 0, 0, 0, 0, 0, 0], g4: CAMERA.g4 } as unknown as CustomGrid })).rejects.toThrow();
    await expect(eng.buildFirmware([], [], [], { customGrid: { g3: [T, F, T], g4: CAMERA.g4 } })).rejects.toThrow();
  }, 300_000);

  it('a record with the camera’s own grids or an unknown bit is not valid', async () => {
    const b = await eng.buildFirmware([], [], [], { customGrid: GRID });
    const rtos = rtosOf(b.file).slice();
    const lp = rtos.length - 4 - 8 - 4;
    const length = new DataView(rtos.buffer).getUint32(lp, true);
    const rec = rtos.subarray(lp - length, lp);
    // count 0, the features byte (the guard only), the second byte (bit 7: a third follows), the
    // third (bit 3), then the 3x3 and the 4x4 style's lines (line i in bit i).
    expect([rec[0], rec[1], rec[2], rec[3], rec[4], rec[5]]).toEqual([0, 32, 0x80, 8, 0b11010010, 0b10101101]);
    expect(fw.readExtensionFeatures(rtos)?.customGrid).toEqual(GRID);
    rec[3] |= 0x40;
    expect(fw.readExtensionFeatures(rtos)).toBeNull();
    rec[3] = 8;
    // The camera's own grids are never recorded.
    rec[4] = 0b00101101;
    rec[5] = 0xff;
    expect(fw.readExtensionFeatures(rtos)).toBeNull();
  }, 300_000);
});
