// SPDX-License-Identifier: GPL-2.0-only
/**
 * The learned auto white balance (`gr4v120/aspect/awb2.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * The module is checked by tools/gr4v120/awb2 (test_observe.py, test_entry.py: the integer module against the float model;
 * test_fw.py: the stub and the module inside a built RTOS, in an emulator).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';
import { AWB2_CODE, AWB2_CODE_LENGTH, AWB2_DATA, AWB2_DATA_LENGTH, AWB2_MAGIC, AWB2_OFFSETS } from '../src/fw/gr4v120/aspect/awb2-code';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

// Per release: the hooked call and its target (the final stage of the Auto estimate); alloc, the flash manager's word, the
// sequence controller's byte.
const releases: { version: string; path: string; CALL: number; STAGE: number; ALLOC: number; FLASH: number; WAIT: number }[] = [
  { version: '1.20', path: file120, CALL: 0x53960e90, STAGE: 0x539609d4, ALLOC: 0x539084bc, FLASH: 0x5537e7c0, WAIT: 0x550b896c },
  { version: '1.21', path: file121, CALL: 0x53962458, STAGE: 0x53961f9c, ALLOC: 0x53909154, FLASH: 0x5537e7c8, WAIT: 0x550b8974 },
];
const SLOT = 0x55839078, ZERO_FILL_END = 0x53000460;

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const recordStart = (v: Uint8Array) => v.length - 16 - new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(v.length - 16, true);
const findWord = (b: Uint8Array, v: number) => { for (let i = 0; i + 4 <= b.length; i += 4) if (word(b, 0x53000000 + i) === v) return 0x53000000 + i; return -1; };
const bytesAt = (b: Uint8Array, at: number, n: number) => Buffer.from(b.slice(at - 0x53000000, at - 0x53000000 + n));
const rgb = (v: number) => new Uint8Array(720 * 480 * 3).fill(v);

for (const { version, path, CALL, STAGE, ALLOC, FLASH, WAIT } of releases) describe.skipIf(!existsSync(path))(`learned auto WB ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const module = Buffer.from(AWB2_CODE, 'base64'), tables = Buffer.from(AWB2_DATA, 'base64');
  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['alone', () => ({})],
    ['with the other additions, the battery percentage and power-off pictures', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced',
      shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true, shutdownPictures: [{ id: 0x2001, name: 'Test', jpeg: e.encodeMenuPicture(rgb(90)) }] } as BuildOptions)],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: the final-stage call goes to a stub appended last, the module, its tables and context; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.awbLearn).toBe(true);
      const o = options(e);
      const plain = Object.keys(o).length ? await e.buildFirmware([], [], [], o) : null;
      const on = await e.buildFirmware([], [], [], { ...o, awbLearn: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const a = rtos(new Uint8Array(raw)), b = rtos(on.file);
      expect(word(a, CALL) >>> 24).toBe(0xeb);
      expect(branchTarget(CALL, word(a, CALL))).toBe(STAGE);
      expect(word(b, CALL) >>> 24).toBe(0xeb);
      const stub = branchTarget(CALL, word(b, CALL));
      expect(stub - 0x53000000).toBeGreaterThanOrEqual(a.length);
      expect(branchTarget(stub + 4, word(b, stub + 4))).toBe(STAGE); // push; bl final stage
      // The zero fill reaches the end of the sbrk arena, over the state pointer's word.
      expect(word(b, ZERO_FILL_END)).toBe(0x55839080);
      // The context: magic, alloc, the state pointer's word, the nine tables, the flash manager's word, the controller's byte.
      const ctx = findWord(b, AWB2_MAGIC);
      expect(ctx - 0x53000000).toBeGreaterThanOrEqual(a.length);
      expect([word(b, ctx + 4), word(b, ctx + 8)]).toEqual([ALLOC, SLOT]);
      expect([word(b, ctx + 48), word(b, ctx + 52)]).toEqual([FLASH, WAIT]);
      const t0 = word(b, ctx + 12);
      AWB2_OFFSETS.forEach((off, k) => expect(word(b, ctx + 12 + 4 * k)).toBe(t0 + off));
      expect(module.length).toBe(AWB2_CODE_LENGTH);
      expect(tables.length).toBe(AWB2_DATA_LENGTH);
      expect(bytesAt(b, ctx + 0x40, module.length).equals(module)).toBe(true);
      expect(bytesAt(b, t0, tables.length).equals(tables)).toBe(true);
      if (plain) {
        // Everything the other additions build stays where it was: the white balance is appended after them.
        const p = rtos(plain.file);
        const end = recordStart(p);
        let first = end;
        for (let i = 0; i < end; i += 4) {
          const at = 0x53000000 + i;
          if (word(p, at) === word(b, at) || at === CALL) continue;
          expect(word(p, at)).toBe(0);
          first = Math.min(first, i);
        }
        for (let i = first; i < end; i += 4) expect(word(p, 0x53000000 + i)).toBe(0);
        expect(ctx - 0x53000000).toBeGreaterThanOrEqual(first);
      }
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.awbLearn).toBe(true);
      if (plain) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced', exposurePreview: true, shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true });
    }, 180000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, awbLearn: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).awbLearn).toBeUndefined();
  }, 60000);
  it('refuses a non-boolean switch', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { awbLearn: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('learned auto WB: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.awbLearn).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, awbLearn: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
