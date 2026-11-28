// SPDX-License-Identifier: GPL-2.0-only
/**
 * Handheld Night (`gr4v120/aspect/handnight.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * The module and the hooks are checked in the emulator by tools/gr4v120/handnight (test_groups.py, test_screen.py, test_fe.py,
 * test_tap.py, test_hold.py, test_keep.py, test_review.py, test_ae.py, test_ui.py; the 1.21 copies in tools/gr4v121/handnight).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';
import { testRatios } from './fw-helpers/test-firmware';
import * as code120 from '../src/fw/gr4v120/aspect/handnight-code';
import * as code121 from '../src/fw/gr4v121/aspect/handnight-code';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

type Hook = [what: string, site: number, kind: 'call' | 'load' | 'entry' | 'vtable', word: number];
// Per release: the hooks (a bl to the stub, a byte load replaced by a bl, the first word of a function replaced by a b, a vtable slot
// (GroupView's is left alone: the live view's root is drawn by the layer render's bl):
// what is there in the official image), the heap's
// movw, the module compiled for the release.
const releases: { version: string; path: string; HOOKS: Hook[]; HEAP: number; code: { MF_CODE: string; MF_CODE_LENGTH: number } }[] = [
  { version: '1.20', path: file120, HEAP: 0x53ad3684, code: code120, HOOKS: [
    ['back end', 0x53745688, 'call', 0x53733ce4], ['front end', 0x5367f904, 'load', 0xe5d410f1], ['tap', 0x5367e6ac, 'load', 0xe5d430f1],
    ['pool free', 0x53905db0, 'entry', 0xe1a0c00d], ['live view start', 0x53653478, 'call', 0x536520e0], ['AE slowest Tv', 0x536a7d1c, 'entry', 0xed900a1d],
    ['App dispatch', 0x5325e4dc, 'entry', 0xe1d120b0], ['live view update', 0x53dbf76c, 'vtable', 0x5318f5a8], ['layer render: Draw', 0x53591178, 'call', 0x5359332c]] },
  { version: '1.21', path: file121, HEAP: 0x53ad4c4c, code: code121, HOOKS: [
    ['back end', 0x537460d8, 'call', 0x53734734], ['front end', 0x53680244, 'load', 0xe5d410f1], ['tap', 0x5367efec, 'load', 0xe5d430f1],
    ['pool free', 0x53906a48, 'entry', 0xe1a0c00d], ['live view start', 0x53653db8, 'call', 0x53652a20], ['AE slowest Tv', 0x536a865c, 'entry', 0xed900a1d],
    ['App dispatch', 0x5325ed28, 'entry', 0xe1d120b0], ['live view update', 0x53dc0d74, 'vtable', 0x5318f580], ['layer render: Draw', 0x53591aa0, 'call', 0x53593c54]] },
];
const MAGIC = 0x5846464d, SLOT = 0x55839280, SWITCH = 0x550832a8 + 4 + 0x9ae, ZERO_FILL_END = 0x53000460, HEAP_AFTER = 0x55839300;

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const rgb = (v: number) => new Uint8Array(720 * 480 * 3).fill(v);

for (const { version, path, HOOKS, HEAP, code } of releases) describe.skipIf(!existsSync(path))(`handheld night ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const module = Uint8Array.from(Buffer.from(code.MF_CODE, 'base64'));
  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['alone', () => ({})],
    ['with the other additions and power-off pictures', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced',
      shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, sensorShift: true, movie4k: true, movieSr: true, movieExposure: true, distanceFeet: true,
      shutdownPictures: [{ id: 0x2001, name: 'Test', jpeg: e.encodeMenuPicture(rgb(90)) }] } as BuildOptions)],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: the hooks to code appended last, the module and its context, the heap after the state word; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.handheldNight).toBe(true);
      const o = options(e);
      const plain = Object.keys(o).length ? await e.buildFirmware([], [], [], o) : null;
      const on = await e.buildFirmware([], [], [], { ...o, handheldNight: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const a = rtos(new Uint8Array(raw)), b = rtos(on.file), q = plain ? rtos(plain.file) : a;
      for (const [what, site, kind, w] of HOOKS) {
        if (kind === 'call') { expect(word(a, site) >>> 24, what).toBe(0xeb); expect(branchTarget(site, word(a, site)), what).toBe(w); }
        else expect(word(a, site), what).toBe(w);
        expect(word(q, site), what).toBe(word(a, site));           // no other addition changes them
        const stub = kind === 'vtable' ? word(b, site) : branchTarget(site, word(b, site));
        if (kind !== 'vtable') expect(word(b, site) >>> 24, what).toBe(kind === 'entry' ? 0xea : 0xeb);
        expect(stub - 0x53000000, what).toBeGreaterThanOrEqual(q.length - 0x1000);
      }
      expect([word(b, HEAP), word(b, HEAP + 4)]).toEqual([0xe3093300, 0xe3453583]);
      expect(word(b, ZERO_FILL_END)).toBe(HEAP_AFTER);
      // The module (this release's compile) once, after everything else the other additions appended; its context before it.
      expect(module.length).toBe(code.MF_CODE_LENGTH);
      const at = Buffer.from(b).indexOf(Buffer.from(module));
      expect(at).toBeGreaterThanOrEqual(a.length);
      expect(Buffer.from(b).indexOf(Buffer.from(module), at + 1)).toBe(-1);
      let ctx = -1;
      for (let i = at - 4; i > at - 0x400; i -= 4) if (word(b, 0x53000000 + i) === MAGIC) { ctx = 0x53000000 + i; break; }
      expect(ctx).toBeGreaterThan(0);
      expect([word(b, ctx + 4), word(b, ctx + 8)]).toEqual([SLOT, SWITCH]);
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.handheldNight).toBe(true);
      if (plain) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced', exposurePreview: true, shadowLearn: true, filmGrain: true, flashTtl: true,
        batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, sensorShift: true, movie4k: true, movieSr: true, movieExposure: true, distanceFeet: true });
    }, 240000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, handheldNight: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).handheldNight).toBeUndefined();
  }, 60000);
  // 0.9.7: the still menu's wide layout holds 49 lines when 42 are not enough (`menuwide.ts`; checked in the emulator by tools/menuwide/check.py).
  it('besides the six other added lines (refused before 0.9.7): a still menu of 43 lines, the layout for 49; 42 without it, as before', async () => {
    const e = await Engine.open(raw);
    const [OK_SITE, ALLOC] = version === '1.21' ? [0x531b3a48, 0x53188890] : [0x531b3664, 0x53188530];
    // HDR, Soft Focus, Exposure Preview, the live-view shade (with a ratio), Constant Light, the date imprint
    const six: BuildOptions = { hdrGainMap: true, adjSoftFocus: true, exposurePreview: true, constantLight: true, dateStamp: true };
    const ratios = testRatios(e);
    const without = await e.buildFirmware([], ratios, [], six);
    const withNight = await e.buildFirmware([], ratios, [], { ...six, handheldNight: true });
    expect(Object.values(withNight.checks).every((v) => v === true)).toBe(true);
    expect(await e.inspect(withNight.file)).toMatchObject({ verified: true, handheldNight: true, ratioShade: true, hdrGainMap: true, exposurePreview: true, dateStamp: true, constantLight: true });
    const a = rtos(without.file), b = rtos(withNight.file);
    // OK on a line: `mov r3, #lines`; the controller's allocation: 0x13EC + 5 tabs * lines * 20 bytes
    expect([word(a, OK_SITE), word(a, ALLOC)]).toEqual([0xe3a0302a, 0xe3020454]);
    expect([word(b, OK_SITE), word(b, ALLOC)]).toEqual([0xe3a03031, 0xe3020710]);
    // five added lines and Handheld Night still fit the layout for 42
    const five = await e.buildFirmware([], [], [], { ...six, handheldNight: true });
    expect(word(rtos(five.file), OK_SITE)).toBe(0xe3a0302a);
  }, 240000);
  it('refuses a non-boolean switch', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { handheldNight: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('handheld night: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.handheldNight).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, handheldNight: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
