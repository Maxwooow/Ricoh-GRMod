// SPDX-License-Identifier: GPL-2.0-only
/**
 * Movie AF driven by the phase data (`gr4v120/aspect/videoaf.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * The module and the stubs are checked by tools/gr4v120/videoaf (test_quick.py: the stubs and the module inside a built
 * RTOS with the camera's own code round them; sim_quick.py / sim_follow.py: closed loops; test_inplace.py: the step cap and
 * the focus area).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';
import { VAFQUICK_CODE, VAFQUICK_CODE_LENGTH } from '../src/fw/gr4v120/aspect/videoaf-code';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

// Per release: the four hooked calls (wobbling step, travel vote, standby monitor, the decision's request) and their
// targets; the movie-state-0 vtable slot and its callback; the three words changed by a branch or a no-op (speed word, the
// lens control's recording test, the phase reset branch); the step cap; the two focus area table entries and what they
// get; the natives of the context.
const releases: { version: string; path: string; CALLS: [number, number][]; STOP: [number, number]; WORDS: number[]; CAP: number; AREA: [number, number][]; NATIVES: number[] }[] = [
  { version: '1.20', path: file120, CALLS: [[0x53626104, 0x5361ed88], [0x5362f6fc, 0x5362c1c8], [0x536266e0, 0x53621f6c], [0x536147f0, 0x53609bb0]], STOP: [0x53edf068, 0x53611a84],
    WORDS: [0x536304e0, 0x53951b34, 0x5362208c], CAP: 0x5362a8ac, AREA: [[0x533ae094, 0x533ae0e8], [0x533ae690, 0x533ae79c]],
    NATIVES: [0x539084bc, 0x53919d68, 0x5391ca64, 0x5391ca74, 0x5361ed88, 0x5360dff4, 0x53609bb0, 0x5360e7b0, 0x536304bc, 0x5360d980, 0x5360de18] },
  { version: '1.21', path: file121, CALLS: [[0x53626a44, 0x5361f6c8], [0x5363003c, 0x5362cb08], [0x53627020, 0x536228ac], [0x53615130, 0x5360a4f0]], STOP: [0x53ee06f8, 0x536123c4],
    WORDS: [0x53630e20, 0x539530fc, 0x536229cc], CAP: 0x5362b1ec, AREA: [[0x533ae944, 0x533ae998], [0x533aef40, 0x533af04c]],
    NATIVES: [0x53909154, 0x5391aaa0, 0x5391d79c, 0x5391d7ac, 0x5361f6c8, 0x5360e934, 0x5360a4f0, 0x5360f0f0, 0x53630dfc, 0x5360e2c0, 0x5360e758] },
];
const MAGIC = 0x51414656, SLOT = 0x5583907c, FLAGS = 0x1f, ZERO_FILL_END = 0x53000460, ARENA_END = 0x55839080;
const CAP_WORDS = [0xe3500000, 0x11a03002, 0x01a03203, 0xe1520003, 0x81a03002];

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const recordStart = (v: Uint8Array) => v.length - 16 - new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(v.length - 16, true);
const findWord = (b: Uint8Array, v: number) => { for (let i = 0; i + 4 <= b.length; i += 4) if (word(b, 0x53000000 + i) === v) return 0x53000000 + i; return -1; };
const rgb = (v: number) => new Uint8Array(720 * 480 * 3).fill(v);

for (const { version, path, CALLS, STOP, WORDS, CAP, AREA, NATIVES } of releases) describe.skipIf(!existsSync(path))(`movie AF ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const module = Uint8Array.from(Buffer.from(VAFQUICK_CODE, 'base64'));
  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['alone', () => ({})],
    ['with the other additions and power-off pictures', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced',
      shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true, shutdownPictures: [{ id: 0x2001, name: 'Test', jpeg: e.encodeMenuPicture(rgb(90)) }] } as BuildOptions)],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: four calls and two words go to stubs appended last, the step cap and the focus area changed, the module and its context; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.videoAf).toBe(true);
      const o = options(e);
      const plain = Object.keys(o).length ? await e.buildFirmware([], [], [], o) : null;
      const on = await e.buildFirmware([], [], [], { ...o, videoAf: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const a = rtos(new Uint8Array(raw)), b = rtos(on.file);
      for (const [at, to] of CALLS) {
        expect(word(a, at) >>> 24).toBe(0xeb);
        expect(branchTarget(at, word(a, at))).toBe(to);
        expect(word(b, at) >>> 24).toBe(0xeb);
        expect(branchTarget(at, word(b, at)) - 0x53000000).toBeGreaterThanOrEqual(a.length);
      }
      expect(word(a, STOP[0])).toBe(STOP[1]);
      expect(word(b, STOP[0]) - 0x53000000).toBeGreaterThanOrEqual(a.length);
      const [speed, lens, keep] = WORDS;
      expect([word(a, speed), word(a, lens), word(a, keep) >>> 24]).toEqual([0xe1a07002, 0xe31c0001, 0x1a]);
      expect(word(b, speed) >>> 24).toBe(0xeb);
      expect(word(b, lens) >>> 24).toBe(0xea);
      for (const at of [speed, lens]) expect(branchTarget(at, word(b, at)) - 0x53000000).toBeGreaterThanOrEqual(a.length);
      expect(word(b, keep)).toBe(0xe1a00000);
      expect(CAP_WORDS.map((_, i) => word(b, CAP + 4 * i))).toEqual(CAP_WORDS);
      for (const [at, to] of AREA) expect(word(b, at)).toBe(to);
      expect(word(b, ZERO_FILL_END)).toBe(ARENA_END);
      // The context: magic, the state pointer's word, flags, the natives; word 7 (file service) is a stub returning 0.
      const ctx = findWord(b, MAGIC);
      expect(ctx - 0x53000000).toBeGreaterThanOrEqual(a.length);
      expect([word(b, ctx + 4), word(b, ctx + 8)]).toEqual([SLOT, FLAGS]);
      expect([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14].map((k) => word(b, ctx + 4 * k))).toEqual(NATIVES);
      const noFiles = word(b, ctx + 28);
      expect([word(b, noFiles), word(b, noFiles + 4)]).toEqual([0xe3a00000, 0xe12fff1e]); // mov r0,#0; bx lr
      const code = ctx + 0x40;
      expect(module.length).toBe(VAFQUICK_CODE_LENGTH);
      expect(Buffer.from(b.slice(code - 0x53000000, code - 0x53000000 + module.length)).equals(Buffer.from(module))).toBe(true);
      if (plain) {
        // Within the official image, against the same build without it, only the declared words differ.
        const own = new Set([...CALLS.map(([at]) => at), STOP[0], ...WORDS, ...CAP_WORDS.map((_, i) => CAP + 4 * i), ...AREA.map(([at]) => at), ZERO_FILL_END]);
        const q = rtos(plain.file);
        const changed: string[] = [];
        for (let i = 0; i < a.length - 16; i += 4) if (!own.has(0x53000000 + i) && word(q, 0x53000000 + i) !== word(b, 0x53000000 + i)) changed.push((0x53000000 + i).toString(16));
        expect(changed).toEqual([]);
        // Everything the other additions build stays where it was: the movie AF is appended after them.
        const p = rtos(plain.file);
        const end = recordStart(p);
        let first = end;
        for (let i = a.length; i < end; i += 4) {
          const at = 0x53000000 + i;
          if (word(p, at) === word(b, at)) continue;
          expect(word(p, at)).toBe(0);
          first = Math.min(first, i);
        }
        for (let i = first; i < end; i += 4) expect(word(p, 0x53000000 + i)).toBe(0);
        expect(ctx - 0x53000000).toBeGreaterThanOrEqual(first);
      }
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.videoAf).toBe(true);
      if (plain) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced', exposurePreview: true, shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true });
    }, 180000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, videoAf: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).videoAf).toBeUndefined();
  }, 60000);
  it('refuses a non-boolean switch', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { videoAf: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('movie AF: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.videoAf).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, videoAf: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
