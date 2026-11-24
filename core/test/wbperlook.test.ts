// SPDX-License-Identifier: GPL-2.0-only
/**
 * White balance per look (`gr4v120/aspect/slots.ts` with the slot-parameters module compiled with SP_WB, GR IV 1.20
 * and 1.21). Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * What the module does in the camera's settings (look changes, photo set changes, save and load, the version 4
 * record) is checked in an emulator by tools/gr4v121/slotparams/test_wb_per_look.py.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions, ExtraSlotSpec } from '../src';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';
const file111 = P + 'official.bin';

// Per release: the "photo set in use" setter the option hooks, and the first and last of the 30 WB setters the module calls.
const releases = [
  { version: '1.20', path: file120, ACTIVE: 0x532bbcf4, WB_FIRST: 0x532b7ff8, WB_LAST: 0x532bace8 },
  { version: '1.21', path: file121, ACTIVE: 0x532bc544, WB_FIRST: 0x532b8848, WB_LAST: 0x532bb538 },
];

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const findWord = (b: Uint8Array, v: number, from = 0) => { for (let i = from; i + 4 <= b.length; i += 4) if (word(b, 0x53000000 + i) === v) return 0x53000000 + i; return -1; };

function slotSpec(eng: Engine, k: number): ExtraSlotSpec {
  const icon = fw.composeIcon(eng.info.tiles.film, new Float32Array(40 * 40).fill(k % 2 ? 0.3 : 0.7));
  const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(i * 64 * (1 + 0.01 * k))));
  return { name: `Look ${k + 1}`, matrixQ13: [8192 + 100 * k, -50 * k, -50 * k, 0, 8192, 0, 0, -20 * k, 8192 + 20 * k], curves: [curve, curve, curve], icon };
}

for (const { version, path, ACTIVE, WB_FIRST, WB_LAST } of releases) describe.skipIf(!existsSync(path))(`white balance per look ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const official = existsSync(path) ? rtos(raw) : new Uint8Array();

  for (const n of [1, 7, 20]) it(`${n} added slot(s): the photo-set setter goes to the module, which holds the WB setter table; verified and read back`, async () => {
    const e = await Engine.open(raw);
    expect(e.info.features.wbPerLook).toBe(true);
    const extraSlots = Array.from({ length: n }, (_, k) => slotSpec(e, k));
    const off = await e.buildFirmware([], [], [], { extraSlots });
    const on = await e.buildFirmware([], [], [], { extraSlots, wbPerLook: true });
    expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
    const a = rtos(off.file), b = rtos(on.file);
    expect(word(official, ACTIVE)).toBe(0xe1a0c00d); // mov ip,sp
    expect(word(a, ACTIVE)).toBe(0xe1a0c00d); // not hooked without the option
    expect(word(b, ACTIVE) >>> 24).toBe(0xea);
    const stub = branchTarget(ACTIVE, word(b, ACTIVE));
    expect(stub - 0x53000000).toBeGreaterThanOrEqual(official.length);
    // movw r2 / movt r2 = the setter itself (the module calls it past the hooked word), then b sp_active_set
    expect((word(b, stub) & 0xfff0f000) >>> 0).toBe(0xe3002000);
    expect((word(b, stub + 4) & 0xfff0f000) >>> 0).toBe(0xe3402000);
    const imm = (w: number) => ((w >> 4) & 0xf000) | (w & 0xfff);
    expect(((imm(word(b, stub + 4)) << 16) | imm(word(b, stub))) >>> 0).toBe(ACTIVE);
    // The 30 WB setters, as one table in the appended code, and none of them changed.
    const table = findWord(b, WB_FIRST, official.length);
    expect(table).toBeGreaterThan(0);
    expect(word(b, table + 29 * 4)).toBe(WB_LAST);
    for (let k = 0; k < 30; k++) expect(word(b, word(b, table + 4 * k))).toBe(word(official, word(b, table + 4 * k)));
    expect(findWord(a, WB_FIRST, official.length)).toBe(-1);
    const summary = await e.inspect(on.file);
    expect(summary.verified).toBe(true);
    expect(summary.wbPerLook).toBe(true);
    expect(summary.extraSlots.map((s) => s.name)).toEqual(extraSlots.map((s) => s.name));
  }, 180000);

  it('with the other additions: verified and read back', async () => {
    const e = await Engine.open(raw);
    const on = await e.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }], [], { extraSlots: [slotSpec(e, 0), slotSpec(e, 1)], wbPerLook: true, monoUnlock: true, dateStamp: true, adjSlots: 8,
      filmGrain: true, awbLearn: true, batteryPercent: true, ratioShade: true, customGrid: { g3: [true, false, true, false, true, false, true, false], g4: [false, true, false, true, false, true, false, true] } } as BuildOptions);
    expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
    const summary = await e.inspect(on.file);
    expect(summary.verified).toBe(true);
    expect(summary).toMatchObject({ wbPerLook: true, monoUnlock: true, dateStamp: true, adjSlots: 8, filmGrain: true, awbLearn: true, batteryPercent: true, ratioShade: true });
  }, 180000);

  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const extraSlots = [slotSpec(e, 0)];
    const a = await e.buildFirmware([], [], [], { extraSlots });
    const b = await e.buildFirmware([], [], [], { extraSlots, wbPerLook: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).wbPerLook).toBeUndefined();
  }, 60000);

  it('refuses a non-boolean switch, and a build without added slots', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { extraSlots: [slotSpec(e, 0)], wbPerLook: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(e.buildFirmware([], [], [], { dateStamp: true, wbPerLook: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('white balance per look: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.wbPerLook).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { extraSlots: [slotSpec(e, 0)], wbPerLook: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
