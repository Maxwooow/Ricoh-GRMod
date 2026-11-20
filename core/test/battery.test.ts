// SPDX-License-Identifier: GPL-2.0-only
/**
 * Battery percentage (aspect/battery.ts, `BuildOptions.batteryPercent`). Needs the official
 * firmware in testdata/private (skipped without it).
 *
 *  - without the option every file is as before (gr4-unchanged.test.ts pins the hashes);
 *  - with it GetBatteryIcon starts with a branch to the hook, icons 1009..1020 are 60x40 and hold
 *    exactly the drawn icons, a bigger battery in the camera's style (the same code with the
 *    camera's measurements gives its 1-bar icon, 0xF7, outside the inside) with the number inside,
 *    and the file records it in the third feature byte, which `inspect` reads back and verifies;
 *  - it composes with every other addition: the same words are written as without it, apart from
 *    its own entry and the icon bound;
 *  - the diagnostic variant differs only in its own code; it builds with the HDR gain map's test
 *    counters (the shown step is no longer kept in their words).
 * What the hook does when it runs is checked in an emulator by tools/battery/check.py.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';
import type { ExtraSlotSpec, ShutdownPictureSpec } from '../src/fw';
import { BATTERY_ICON_DISAGREES, BATTERY_ICON_H, BATTERY_ICON_ID, BATTERY_ICON_W, BATTERY_SHOWN, CAMERA_BATTERY, ICON_BATTERY, batteryIcons, batteryInside, drawBatteryIcon } from '../src/fw/aspect/battery';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const have = existsSync(P + 'official.bin');
const { aspect } = fw;
const BASE = 0x53000000;
const GET_BATTERY_ICON = 0x5339a1e8;
const ICON_BOUNDS = [0x5323dbb4, 0x5323e40c];
const ZERO_FILL_END = 0x53000460;
const NATIVE_ONE_BAR = 0xf7;

interface Sections { rtos: Uint8Array; iconbin: Uint8Array }
function sections(file: Uint8Array): Sections {
  const d = new fw.Firmware(file).decoded;
  const s = fw.sectionsOf(d);
  const r = s.find((x) => x.name === 'RTOS')!;
  const i = s.find((x) => x.name === 'ICONBIN')!;
  return { rtos: d.subarray(r.offset, r.offset + r.size), iconbin: d.subarray(i.offset, i.offset + i.size) };
}
const wordAt = (rtos: Uint8Array, va: number): number => new DataView(rtos.buffer, rtos.byteOffset, rtos.length).getUint32(va - BASE, true);
const half = (rtos: Uint8Array, va: number): number => new DataView(rtos.buffer, rtos.byteOffset, rtos.length).getUint16(va - BASE, true);

/** An icon's pixels through the extended catalog (0x543D3AC0), or through the RAM copy of the native one. */
function iconOf(s: Sections, id: number, native = false): { w: number; h: number; px: Uint8Array } {
  // The native catalog is in initialised RAM (0x55013410), copied at start-up from 0x5437B640 in the image.
  const at = native ? 0x55013410 - 0x55000000 + 0x5437b640 + id * 4 : aspect.ICON_CATALOG + id * 4;
  const desc = wordAt(s.rtos, at);
  const desc2 = desc >= 0x55000000 ? desc - 0x55000000 + 0x5437b640 : desc;
  expect(half(s.rtos, desc2)).toBe(1);
  const w = half(s.rtos, desc2 + 2);
  const h = half(s.rtos, desc2 + 4);
  const offset = wordAt(s.rtos, desc2 + 8) * 4;
  return { w, h, px: s.iconbin.subarray(offset, offset + w * h * 4) };
}

// The app shows the icons with its ratio-icon canvas (ui/src/components.tsx RatioIcon), which is 60x40.
it('the battery icons are the size of a ratio icon', () => {
  expect([BATTERY_ICON_W, BATTERY_ICON_H]).toEqual([aspect.RATIO_ICON_W, aspect.RATIO_ICON_H]);
  for (const x of batteryIcons()) expect(x.px.length).toBe(BATTERY_ICON_W * BATTERY_ICON_H * 4);
});

describe.skipIf(!have)('battery percentage', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;

  it('is offered for the GR IV 1.11', async () => {
    eng = await Engine.open(raw);
    expect(eng.info.features.batteryPercent).toBe(true);
  });

  it('hooks the icon choice, adds its icons in the camera\'s battery style and is recorded in the file', async () => {
    const official = sections(raw);
    const plain = await eng.buildFirmware([], [], [], { adjSoftFocus: true });
    const off = await eng.buildFirmware([], [], [], { adjSoftFocus: true, batteryPercent: false });
    expect(off.sha256).toBe(plain.sha256);
    const built = await eng.buildFirmware([], [], [], { batteryPercent: true });
    expect(Object.values(built.checks).every((v) => v === true)).toBe(true);
    expect(built.features.batteryPercent).toBe(true);
    const s = sections(built.file);
    expect(wordAt(official.rtos, GET_BATTERY_ICON)).toBe(0xe3510001);
    expect(wordAt(s.rtos, GET_BATTERY_ICON) >>> 24).toBe(0xea);
    // The zero fill reaches the heap over the unused sbrk arena, where the shown step is kept.
    expect(wordAt(s.rtos, ZERO_FILL_END)).toBe(0x55837340);
    expect(BATTERY_SHOWN).toBe(0x55837300);
    const drawn = batteryIcons();
    expect(drawn.map((x) => x.id)).toEqual(Array.from({ length: 12 }, (_, k) => BATTERY_ICON_ID + k));
    for (const { id, px } of drawn) {
      const got = iconOf(s, id);
      expect([got.w, got.h]).toEqual([BATTERY_ICON_W, BATTERY_ICON_H]);
      expect(Buffer.from(got.px).equals(Buffer.from(px))).toBe(true);
    }
    expect(wordAt(s.rtos, aspect.ICON_CATALOG + (BATTERY_ICON_DISAGREES + 1) * 4)).toBe(0);
    // The battery is drawn in the camera's style: with the camera's measurements the same code gives
    // its 1-bar icon, every pixel outside the inside (x 11..53, y 11..28).
    const native = iconOf(official, NATIVE_ONE_BAR, true);
    expect([native.w, native.h]).toEqual([60, 40]);
    const camera = drawBatteryIcon('', [254, 254, 254], [254, 254, 254], CAMERA_BATTERY);
    const [cx0, cy0, cx1, cy1] = batteryInside(CAMERA_BATTERY);
    expect([cx0, cy0, cx1, cy1]).toEqual([11, 11, 53, 28]);
    let differ = 0;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 60; x++) {
        if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) continue;
        for (let c = 0; c < 4; c++) if (camera[(y * 60 + x) * 4 + c] !== native.px[(y * 60 + x) * 4 + c]) differ++;
      }
    }
    expect(differ).toBe(0);
    // The icons' bigger battery: nothing outside its body and tip, and every number inside it.
    const [ix0, iy0, ix1, iy1] = batteryInside(ICON_BATTERY);
    const inBox = (x: number, y: number, [x0, y0, x1, y1]: readonly number[]): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    for (const { id, px } of drawn) {
      // 10 % has a red outline, the rest a white one.
      const empty = drawBatteryIcon('', [254, 254, 254], id === BATTERY_ICON_ID ? [255, 51, 51] : [254, 254, 254]);
      let outside = 0;
      let spill = 0;
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 60; x++) {
          const o = (y * 60 + x) * 4;
          if (!inBox(x, y, ICON_BATTERY.body) && !inBox(x, y, ICON_BATTERY.tip) && px[o + 3] !== 0) outside++;
          if (!inBox(x, y, [ix0, iy0, ix1, iy1]) && [0, 1, 2, 3].some((c) => px[o + c] !== empty[o + c])) spill++;
        }
      }
      expect([outside, spill]).toEqual([0, 0]);
    }
    const i = await eng.inspect(built.file);
    expect([i.kind, i.verified, i.batteryPercent]).toEqual(['modified', true, true]);
    expect((await eng.inspect(plain.file)).batteryPercent).toBeUndefined();
    expect(fw.readExtensionFeatures(s.rtos)?.batteryPercent).toBe(true);
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
    const built = await eng.buildFirmware([], ratios, [], { ...everything, batteryPercent: true });
    expect(Object.values(built.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(built.file);
    expect([s.verified, s.batteryPercent, s.hdrGainMap, s.adjSlots, s.brightAuto]).toEqual([true, true, true, 8, 'balanced']);
    expect([s.adjSoftFocus, s.dateStamp, s.monoUnlock, s.directFlash, s.extraSlots.length, s.shutdownPictures?.length, !!s.lookLayout]).toEqual([true, true, true, true, 2, 1, true]);
    const o = sections(raw).rtos;
    const changed = (rtos: Uint8Array): Set<number> => {
      const out = new Set<number>();
      for (let va = BASE; va < BASE + aspect.OFFICIAL_RTOS_LENGTH; va += 4) if (wordAt(rtos, va) !== wordAt(o, va)) out.add(va);
      return out;
    };
    const ca = changed(sections(without.file).rtos);
    const cb = changed(sections(built.file).rtos);
    expect(ca.has(GET_BATTERY_ICON)).toBe(false);
    expect(cb.has(GET_BATTERY_ICON)).toBe(true);
    for (const va of [GET_BATTERY_ICON, ...ICON_BOUNDS]) cb.delete(va);
    for (const va of ICON_BOUNDS) ca.delete(va);
    expect([...cb].sort()).toEqual([...ca].sort());
  }, 1_800_000);

  it('the diagnostic variant differs only in its own code', async () => {
    const opts: BuildOptions = { adjSoftFocus: true, batteryPercent: true };
    const ratios = [{ name: '2:1', ratio: '2:1' }];
    const normal = (await eng.buildFirmware([], ratios, [], opts)).file;
    const diag = (await eng.buildFirmware([], ratios, [], { ...opts, batteryDiag: true })).file;
    expect((await eng.inspect(normal)).verified).toBe(true);
    const a = sections(normal).rtos;
    const b = sections(diag).rtos;
    expect(b.length).toBe(a.length);
    const differ: number[] = [];
    for (let va = BASE; va < BASE + a.length; va += 4) if (wordAt(a, va) !== wordAt(b, va)) differ.push(va);
    // The two fallbacks branch to the "?" / "!" icon instead of the camera's: two words in the hook,
    // and the record's sum word at the very end.
    expect(differ.length).toBe(3);
    expect(differ.pop()).toBe(BASE + a.length - 4);
    const hook = GET_BATTERY_ICON + 8 + (((wordAt(a, GET_BATTERY_ICON) & 0xffffff) << 8) >> 6);
    for (const va of differ) {
      expect(va).toBeGreaterThanOrEqual(hook);
      expect(va).toBeLessThan(hook + 0x180);
    }
    // The HDR gain map's test counters no longer share a word with the shown step.
    const hdrDiag = await eng.buildFirmware([], [], [], { batteryPercent: true, hdrGainMap: true, hdrDiag: true });
    expect(Object.values(hdrDiag.checks).every((v) => v === true)).toBe(true);
  }, 600_000);
});
