// SPDX-License-Identifier: GPL-2.0-only
/**
 * Live view of the added ratios with the whole frame and the part outside darkened (aspect/shade.ts,
 * `BuildOptions.ratioShade`). Needs the official firmware in testdata/private (skipped without it).
 *
 *  - without the option every file is as before (gr4-unchanged.test.ts pins the hashes);
 *  - with it every geometry hook stays, the live-view mode reads an added ratio as 3:2 (the two
 *    capture aspect calls of the live-view mode function and its check), the grid view draws the
 *    shade, the layout's two diagonals go through a wrapper that keeps them in the photo area, and
 *    the file records it, with its tone, in the third feature byte, which `inspect` reads back and
 *    verifies;
 *  - it composes with every other addition: the same words are written as without it, apart from
 *    the seven words of its own (three grid-view words, the two live-mode calls, the two diagonal
 *    point-setter calls of the grid view's layout).
 * What the drawing code does when it runs is checked in an emulator by tools/shade/draw_check.py.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';
import type { ExtraSlotSpec, ShutdownPictureSpec } from '../src/fw';
import { testRatios } from './fw-helpers/test-firmware';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const have = existsSync(P + 'official.bin');
const { aspect } = fw;
const word = (d: Uint8Array, va: number): number => new DataView(d.buffer, d.byteOffset).getUint32(fw.RTOS_OFFSET + va - 0x53000000, true);

const CROP_HOOKS = [0x538876b8, 0x53646310, 0x53646c1c];
const GRID_DRAW_SLOT = 0x53e98bd8 + 19 * 4;
const GRID_DRAW = 0x53578848;
/** The grid view's Draw slot, its constructor's clear, UpdateViewGrid's tail, and the layout's two diagonal point-setter calls. */
const SHADE_WORDS = [GRID_DRAW_SLOT, 0x535784b4, 0x5318f0c0, 0x53578770, 0x535787b0];
const LIVE_MODE_CALLS = [0x5388c7d0, 0x5363fa9c];
const CAPTURE_ASPECT_BL = (at: number): number => (0xeb000000 | (((0x5375840c - at - 8) >> 2) & 0xffffff)) >>> 0;

function rtosOf(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded;
  const rtos = fw.sectionsOf(d).find((s) => s.name === 'RTOS')!;
  return d.subarray(rtos.offset, rtos.offset + rtos.size);
}

describe.skipIf(!have)('live-view shade of added ratios', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;
  const official = (): Uint8Array => new fw.Firmware(raw).decoded;

  it('is offered for the GR IV 1.11', async () => {
    eng = await Engine.open(raw);
    expect(eng.info.features.ratioShade).toBe(true);
  });

  it('off, or without added ratios, changes nothing', async () => {
    const ratios = testRatios(eng);
    const plain = await eng.buildFirmware([], ratios);
    const off = await eng.buildFirmware([], ratios, [], { ratioShade: false });
    expect(off.sha256).toBe(plain.sha256);
    const date = await eng.buildFirmware([], [], [], { dateStamp: true });
    const dateShade = await eng.buildFirmware([], [], [], { dateStamp: true, ratioShade: true });
    expect(dateShade.sha256).toBe(date.sha256);
    expect(dateShade.features.ratioShade).toBeUndefined();
    // Nothing else asked for: nothing to build.
    await expect(eng.buildFirmware([], [], [], { ratioShade: true })).rejects.toThrow();
  }, 300_000);

  it('reads an added ratio as 3:2 for the live view, draws the shade on the grid view and is recorded in the file', async () => {
    const ratios = [{ name: '2:1', ratio: '2:1' }, { name: 'XPan', ratio: '65:24' }];
    const plain = await eng.buildFirmware([], ratios);
    const shaded = await eng.buildFirmware([], ratios, [], { ratioShade: true });
    expect(Object.values(shaded.checks).every((v) => v === true)).toBe(true);
    expect(shaded.features.ratioShade).toBe(true);
    const a = new fw.Firmware(plain.file).decoded;
    const b = new fw.Firmware(shaded.file).decoded;
    const o = official();
    // Every geometry hook stays as without the shade.
    for (const va of CROP_HOOKS) {
      expect(word(a, va)).not.toBe(word(o, va));
      expect(word(b, va)).toBe(word(a, va));
    }
    for (const va of LIVE_MODE_CALLS) {
      expect(word(o, va)).toBe(CAPTURE_ASPECT_BL(va));
      expect(word(a, va)).toBe(word(o, va));
      expect(word(b, va)).not.toBe(word(o, va));
      expect(word(b, va) >>> 24).toBe(0xeb);
    }
    expect(word(o, GRID_DRAW_SLOT)).toBe(GRID_DRAW);
    expect(word(a, GRID_DRAW_SLOT)).toBe(GRID_DRAW);
    expect(word(b, GRID_DRAW_SLOT)).not.toBe(GRID_DRAW);
    for (const va of SHADE_WORDS) expect(word(a, va)).toBe(word(o, va));
    for (const va of SHADE_WORDS) expect(word(b, va)).not.toBe(word(o, va));
    expect(fw.readExtensionFeatures(rtosOf(shaded.file))?.ratioShade).toBe(true);
    expect(fw.readExtensionFeatures(rtosOf(plain.file))?.ratioShade).toBeUndefined();
    const s = await eng.inspect(shaded.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.ratioShade).toBe(true);
    expect(s.ratios.map((r) => r.ratio)).toEqual(['2:1', '65:24']);
    expect(s.ratioShadeTone).toBeUndefined();
    const p = await eng.inspect(plain.file);
    expect(p.verified).toBe(true);
    expect(p.ratioShade).toBeUndefined();
    const light = await eng.buildFirmware([], ratios, [], { ratioShade: true, ratioShadeTone: 'light' });
    const l = await eng.inspect(light.file);
    expect([l.verified, l.ratioShade, l.ratioShadeTone]).toEqual([true, true, 'light']);
    // The tone is one colour byte in the drawing code.
    expect(new fw.Firmware(light.file).decoded.length).toBe(b.length);
  }, 300_000);

  it('a file with an unknown bit in the third feature byte has no valid record', async () => {
    const shaded = await eng.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }], [], { ratioShade: true });
    const rtos = rtosOf(shaded.file).slice();
    // The record ends just before its length word, the magic and the sum word.
    const lp = rtos.length - 4 - 8 - 4;
    const length = new DataView(rtos.buffer).getUint32(lp, true);
    const rec = rtos.subarray(lp - length, lp);
    // count, ratio text, name, the features byte (the guard only), the second byte (bit 7: a third
    // byte follows), then the third.
    let p = 1;
    p += 1 + rec[p];
    p += 1 + rec[p];
    expect(rec[0]).toBe(1);
    expect(rec[p]).toBe(32);
    expect(rec[p + 1]).toBe(0x80);
    expect(rec[p + 2]).toBe(1);
    expect(fw.readExtensionFeatures(rtos)?.ratioShade).toBe(true);
    // Bit 1 is the lighter shade.
    rec[p + 2] = 3;
    expect(fw.readExtensionFeatures(rtos)?.ratioShadeTone).toBe('light');
    rec[p + 2] = 1 | 0x40;
    expect(fw.readExtensionFeatures(rtos)).toBeNull();
    // The lighter shade without the shade, or an empty third byte, is not valid either.
    rec[p + 2] = 2;
    expect(fw.readExtensionFeatures(rtos)).toBeNull();
    rec[p + 2] = 0;
    expect(fw.readExtensionFeatures(rtos)).toBeNull();
    // Without bit 7 of the second byte there is no third: the byte reads as padding that is not zero.
    rec[p + 1] = 0;
    rec[p + 2] = 1;
    expect(fw.readExtensionFeatures(rtos)).toBeNull();
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
    const ratios = [{ name: '2:1', ratio: '2:1' }, { name: 'XPan', ratio: '65:24' }, { name: '2.35:1', ratio: '2.35:1' }, { name: '5:4', ratio: '5:4' }];
    const without = await eng.buildFirmware([], ratios, [], everything);
    const shaded = await eng.buildFirmware([], ratios, [], { ...everything, ratioShade: true });
    expect(Object.values(shaded.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(shaded.file);
    expect(s.verified).toBe(true);
    expect(s.ratioShade).toBe(true);
    expect([s.adjSoftFocus, s.dateStamp, s.monoUnlock, s.directFlash, s.extraSlots.length, s.shutdownPictures?.length, !!s.lookLayout]).toEqual([true, true, true, true, 2, 1, true]);
    expect([s.hdrGainMap, s.adjSlots, s.brightAuto]).toEqual([true, 8, 'balanced']);
    // Which official words are changed: the same, but for the shade's own.
    const o = official();
    const a = new fw.Firmware(without.file).decoded;
    const b = new fw.Firmware(shaded.file).decoded;
    const changed = (d: Uint8Array): Set<number> => {
      const out = new Set<number>();
      for (let va = 0x53000000; va < 0x53000000 + aspect.OFFICIAL_RTOS_LENGTH; va += 4) if (word(d, va) !== word(o, va)) out.add(va);
      return out;
    };
    const ca = changed(a);
    const cb = changed(b);
    for (const va of CROP_HOOKS) {
      expect(ca.has(va)).toBe(true);
      expect(cb.has(va)).toBe(true);
    }
    for (const va of [...SHADE_WORDS, ...LIVE_MODE_CALLS]) {
      expect(ca.has(va)).toBe(false);
      expect(cb.has(va)).toBe(true);
      cb.delete(va);
    }
    expect([...cb].sort()).toEqual([...ca].sort());
  }, 1_800_000);
});
