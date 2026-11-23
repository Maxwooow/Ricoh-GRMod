// SPDX-License-Identifier: GPL-2.0-only
/**
 * Exposure modes for movies (`gr4v120/aspect/movieexp.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * What the changed code does in the camera's own functions is checked by tools/movieexp/check.py (Unicorn); here: which
 * words a build with it changes, and that it is recorded, verified and read back.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

const NOP = 0xe1a00000, MOV_R2_0 = 0xe3a02000;
// Per release: the three no-ops (virtual mode, ISO setting, ISO button); the dial function's branch; the two calls that go
// to appended code, with the function the second one's code ends in; the item table and the position table of the
// shooting screen; the seven places that hand "movie" to the texts.
const releases = [
  { version: '1.20', path: file120, NOPS: [0x53258e14, 0x53258f3c, 0x53396400], DIAL: 0x533f7888, GATE: 0x53259aec, STEP: 0x5325aa78, ISO_AUTO: 0x53258b68,
    ITEMS: 0x53dc08e0, POSITIONS: 0x53dbf9bc, ARGUMENTS: [0x533a841c, 0x5318c344, 0x531bd80c, 0x5318c514, 0x533a89c8, 0x5318c57c, 0x533a8b10] },
  { version: '1.21', path: file121, NOPS: [0x53259660, 0x53259788, 0x53396cb0], DIAL: 0x533f81b0, GATE: 0x5325a338, STEP: 0x5325b2c4, ISO_AUTO: 0x532593b4,
    ITEMS: 0x53dc1ee8, POSITIONS: 0x53dc0fc4, ARGUMENTS: [0x533a8ccc, 0x5318c31c, 0x531bde18, 0x5318c4ec, 0x533a9278, 0x5318c554, 0x533a93c0] },
];
// ldrb r1, [r0, #0xb76]; ldrb r0, [r0, #0xb74]; cmp r1, #1; moveq r0, #1; bx lr
const GATE_CODE = [0xe5d01b76, 0xe5d00b74, 0xe3510001, 0x03a00001, 0xe12fff1e];
// ldrb r1, [r5, #0xb76]; cmp r1, #1; moveq r0, #1; bxeq lr; b <ISO auto now>
const STEP_CODE = [0xe5d51b76, 0xe3510001, 0x03a00001, 0x012fff1e];

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const rgb = (v: number) => new Uint8Array(720 * 480 * 3).fill(v);

for (const { version, path, NOPS, DIAL, GATE, STEP, ISO_AUTO, ITEMS, POSITIONS, ARGUMENTS } of releases) describe.skipIf(!existsSync(path))(`exposure modes for movies ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  // What the build changes inside the official image: address -> word.
  const expected = new Map<number, number>();
  for (const at of NOPS) expected.set(at, NOP);
  expected.set(DIAL, 0xea000001);
  expected.set(ITEMS + 0x30 + 28, 0x01010000);
  expected.set(ITEMS + 0x30 + 32, 0x00010101);
  for (const [layout, y] of [[1, 440], [3, 680]] as const) {
    for (const [item, x] of [[30, 40], [31, 200], [32, 330]] as const) {
      expected.set(POSITIONS + layout * 0x180 + item * 8, x);
      expected.set(POSITIONS + layout * 0x180 + item * 8 + 4, y);
    }
  }
  for (const at of ARGUMENTS) expected.set(at, MOV_R2_0);

  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['with the date imprint', () => ({ dateStamp: true })],
    ['with the other additions and power-off pictures', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced',
      shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true, videoAf: true, awbLearn: true, shutdownPictures: [{ id: 0x2001, name: 'Test', jpeg: e.encodeMenuPicture(rgb(90)) }] } as BuildOptions)],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: only its own words differ from the build without it; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.movieExposure).toBe(true);
      const o = options(e);
      const off = await e.buildFirmware([], [], [], o);
      const on = await e.buildFirmware([], [], [], { ...o, movieExposure: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const official = rtos(new Uint8Array(raw)), a = rtos(off.file), b = rtos(on.file);
      // Inside the official image: exactly the expected words and the two calls.
      const changed: number[] = [];
      for (let i = 0; i < official.length; i += 4) if (word(a, 0x53000000 + i) !== word(b, 0x53000000 + i)) changed.push(0x53000000 + i);
      expect(changed.sort()).toEqual([...expected.keys(), GATE, STEP].sort());
      for (const [at, w] of expected) {
        expect(word(a, at)).toBe(word(official, at));
        expect(word(b, at)).toBe(w);
      }
      // The two calls go to code appended after everything the build without it has.
      const gate = branchTarget(GATE, word(b, GATE)), step = branchTarget(STEP, word(b, STEP));
      for (const [at, to] of [[GATE, gate], [STEP, step]] as const) {
        expect(word(a, at)).toBe(word(official, at));
        expect(word(b, at) >>> 24).toBe(0xeb);
        expect(to - 0x53000000).toBeGreaterThanOrEqual(official.length);
      }
      expect(GATE_CODE.map((_, k) => word(b, gate + 4 * k))).toEqual(GATE_CODE);
      expect(STEP_CODE.map((_, k) => word(b, step + 4 * k))).toEqual(STEP_CODE);
      expect(word(b, step + 16) >>> 24).toBe(0xea);
      expect(branchTarget(step + 16, word(b, step + 16))).toBe(ISO_AUTO);
      for (const at of [gate, step]) for (let k = 0; k < 5; k++) if (at + 4 * k - 0x53000000 < a.length) expect(word(a, at + 4 * k)).toBe(0);
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.movieExposure).toBe(true);
      expect(summary.dateStamp).toBe(true);
      expect((await e.inspect(off.file)).movieExposure).toBeUndefined();
    }, 240000);
  }
  it('alone: builds, verified and read back', async () => {
    const e = await Engine.open(raw);
    const on = await e.buildFirmware([], [], [], { movieExposure: true });
    expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
    const summary = await e.inspect(on.file);
    expect(summary.verified).toBe(true);
    expect(summary.movieExposure).toBe(true);
  }, 120000);
  it('omitted and false build the same bytes', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, movieExposure: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
  }, 60000);
  it('refuses a non-boolean switch', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { movieExposure: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('exposure modes for movies: where they are not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.movieExposure).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, movieExposure: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
