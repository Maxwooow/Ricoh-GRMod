// SPDX-License-Identifier: GPL-2.0-only
/**
 * 0.8.11 (GR IV 1.20): exposure preview as a camera setting and soft focus's still-menu line
 * (`src/fw/gr4v120/aspect/exposure.ts`, `menuwide.ts`, `lvpreview.ts`). Needs the official 1.20 file
 * (GRMOD_GR4_120_FIRMWARE). What the firmware does with them (the menus of 42 lines, the ADJ table
 * of 22 functions, the live view) is checked in an emulator by `tools/gr4v120/exposure/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { EXPOSURE_PREVIEW_BYTE, EP_LIST_ID, SOFT_FOCUS_LIST_ID } from '../src/fw/gr4v120/aspect/exposure';

const file120 = process.env.GRMOD_GR4_120_FIRMWARE;
const have120 = !!file120 && existsSync(file120);

const rtosOf = (file: Uint8Array): Uint8Array => {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.subarray(r.offset, r.offset + r.size);
};
const count = (rtos: Uint8Array, w: number): number => {
  const dv = new DataView(rtos.buffer, rtos.byteOffset);
  let n = 0;
  for (let i = 0x01000000; i + 4 <= rtos.length; i += 4) if (dv.getUint32(i, true) === w) n++;
  return n;
};
const word = (rtos: Uint8Array, a: number): number => new DataView(rtos.buffer, rtos.byteOffset).getUint32(a - 0x53000000, true);

describe.skipIf(!have120)('exposure preview and soft focus line: GR IV 1.20', () => {
  it('builds, verifies and reads back; soft focus alone gets its line, nothing else changes', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file120!)), { newFirmware: true });
    expect(eng.info.features.exposurePreview).toBe(true);
    expect(EXPOSURE_PREVIEW_BYTE).toBe(0x550832a8 + 4 + 0x10b);
    const opts = { adjSoftFocus: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8 };
    const b = await eng.buildFirmware([], [], [], { ...opts, exposurePreview: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.exposurePreview).toBe(true);
    const rtos = rtosOf(b.file);
    expect(fw.readExtensionFeatures(rtos)).toMatchObject({ exposurePreview: true, softFocusMenu: true, adjSoftFocus: true, hdrGainMap: true, adjSlots: 8 });
    // three still descriptors per model hold each line; the ADJ table moved (its end word with it)
    expect(count(rtos, EP_LIST_ID)).toBeGreaterThanOrEqual(3);
    expect(count(rtos, SOFT_FOCUS_LIST_ID)).toBeGreaterThanOrEqual(3);
    expect(word(rtos, 0x531bd600)).not.toBe(0x53dc9dfc + 21 * 0x5c);
    expect(word(rtos, 0x53188530)).toBe(0xe3020454); // movw r0, #0x2454: the menu controller, larger

    // soft focus without exposure preview: its line (wide menus), the ADJ table where it is
    const sf = await eng.buildFirmware([], [], [], opts);
    const s2 = await eng.inspect(sf.file);
    expect(s2.verified).toBe(true);
    expect(s2.exposurePreview).toBeUndefined();
    const r2 = rtosOf(sf.file);
    expect(fw.readExtensionFeatures(r2)).toMatchObject({ softFocusMenu: true });
    expect(count(r2, EP_LIST_ID)).toBe(0);
    expect(count(r2, SOFT_FOCUS_LIST_ID)).toBeGreaterThanOrEqual(3);
    expect(word(r2, 0x531bd600)).toBe(0x53dc9dfc + 21 * 0x5c);

    // without soft focus or exposure preview: the official menus' layout (38 lines), as 0.8.10
    const plain = rtosOf((await eng.buildFirmware([], [], [], { dateStamp: true, hdrGainMap: true })).file);
    expect(word(plain, 0x53188530)).toBe(0xe30103ec);
    expect(count(plain, SOFT_FOCUS_LIST_ID)).toBe(0);
  }, 300_000);
  it('not on 1.11 files', async () => {
    const p = new URL('../testdata/private/official.bin', import.meta.url).pathname;
    if (!existsSync(p)) return;
    const eng = await Engine.open(new Uint8Array(readFileSync(p)));
    expect(eng.info.features.exposurePreview).toBeUndefined();
    await expect(eng.buildFirmware([], [], [], { exposurePreview: true })).rejects.toThrow();
  });
});
