// SPDX-License-Identifier: GPL-2.0-only
/**
 * Added aspect ratios: geometry and helpers (no firmware needed), then complete firmware files
 * built from the official one (needs testdata/private/official.bin; skipped without it).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src';
import {
  DECODED_SIZE, FRAME_SIZE, Firmware, FirmwareError, ICONBIN_LENGTH, ICONBIN_OFFSET, OFFICIAL_SIZE, RTOS_LENGTH, RTOS_OFFSET, buildFirmware,
  openOfficial, readRatioRecord, sectionData, sectionsOf, sum32, verifyContainer,
} from '../src/fw';
import type { BuildResult } from '../src/fw';
import {
  Frac, RATIO_ICON_BYTES, alignedCrop, drawRatioIcon, fullSize, gr4Sizes, installRatios, parseRatio, planRatio, planRatios, ratioLabel, ratioText,
  sourceRectangles, validateRatioName,
} from '../src/fw/aspect';
import { NATIVE } from '../src/fw/aspect/native';
import { linkNative } from '../src/fw/aspect/native-link';
import { QUICK_VIEW_FULL } from '../src/fw/aspect/facts';

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'private', 'official.bin');
const have = existsSync(OFFICIAL);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof FirmwareError ? e.code : 'other: ' + String(e);
  }
  return '';
};

describe('aspect: ratios and geometry', () => {
  it('parses ratios like the reference', () => {
    expect(parseRatio('65:24').eq(new Frac(65, 24))).toBe(true);
    expect(parseRatio(' 2.35 : 1 ').eq(new Frac(47, 20))).toBe(true);
    expect(parseRatio('2.35').eq(new Frac(47, 20))).toBe(true);
    expect(parseRatio('16：9').eq(new Frac(16, 9))).toBe(true);
    expect(parseRatio('7/6').eq(new Frac(7, 6))).toBe(true);
    for (const bad of ['', 'a', '1:', ':1', '1:2:3', '-1:2', '1e3', '0:1', '1:0', '1.:2', '.5:1', '1'.repeat(65)]) expect(code(() => parseRatio(bad)), bad).toBe('bad-ratio');
  });
  it('rounds like Python fractions', () => {
    expect(new Frac(5, 2).round()).toBe(2n);
    expect(new Frac(7, 2).round()).toBe(4n);
    expect(new Frac(-5, 2).round()).toBe(-2n);
    expect(new Frac(-7, 4).floor()).toBe(-2n);
    expect(new Frac(10, 4).d).toBe(2n);
    expect(new Frac(3, -6).n).toBe(-1n);
  });
  it('65:24 becomes 720x264 on screen and 6192x2272 as a photo', () => {
    const g = planRatio('65:24');
    expect(g.screen).toEqual({ left: 0, top: 108, width: 720, height: 264 });
    expect(g.thumb).toEqual({ left: 0, top: 30, width: 160, height: 60 });
    expect(ratioText(g.actual.n, g.actual.d)).toBe('30:11');
    expect(fullSize(g)).toEqual([6192, 2272]);
    expect(gr4Sizes(g)).toEqual([[6192, 2272], [4944, 1812], [3504, 1284], [1920, 704]]);
    expect(gr4Sizes(g, 1)[0]).toEqual([4944, 1812]);
    expect(g.dims).toEqual([
      [6000, 4000, 6000, 2200], [4800, 3200, 4800, 1760], [3360, 2240, 3360, 1232], [1920, 1280, 1920, 704],
      [6192, 4128, 6192, 2272], [4944, 3296, 4944, 1812], [3504, 2336, 3504, 1284],
    ]);
    expect([g.fx, g.fy]).toEqual([[1, 1], [11, 20]]);
    expect([g.af, g.afSize, g.afSmall, g.tracking, g.modeAlias]).toEqual([[80, 108, 640, 372], [560, 264], [336, 158], [778, 543], 5]);
    expect(g.preview).toEqual({ width: 2949120, height: 1081344, left: 0, top: 442368 });
    expect(sourceRectangles(g)).toEqual([[2949120, 1081344, 0, 442368], [2354697, 863384, 297212, 551343], [1668913, 611935, 640104, 677073]]);
  });
  it('a ratio narrower than 3:2 keeps the height', () => {
    const g = planRatio('5:4');
    expect(g.screen).toEqual({ left: 60, top: 0, width: 600, height: 480 });
    expect(fullSize(g)).toEqual([5160, 4128]);
    expect([g.modeAlias, g.tracking]).toEqual([3, [667, 750]]);
    expect(planRatio('6:7').tracking).toEqual([573, 750]);
  });
  it('every photo size is a multiple of 4 and centred', () => {
    for (const r of ['65:24', '2.39:1', '16:10', '5:4', '6:7', '2:1', '7:6']) {
      const g = planRatio(r);
      for (const s of g.photoSizes) expect(s.width % 4 === 0 && s.height % 4 === 0 && s.width >= 4 && s.height >= 4, r).toBe(true);
      expect(g.screen.left * 2 + g.screen.width).toBe(720);
      expect(g.screen.top * 2 + g.screen.height).toBe(480);
    }
    expect(alignedCrop(720, 480, new Frac(1000, 1))).toBeNull();
  });
  it('refuses what cannot work, with a reason', () => {
    expect(code(() => planRatio('3:2'))).toBe('ratio-factory');
    expect(code(() => planRatio('1.5'))).toBe('ratio-factory');
    expect(code(() => planRatio('16:9'))).toBe('ratio-factory');
    expect(code(() => planRatio('720:268'))).toBe('ratio-quick-view');
    expect(code(() => planRatio('1000:1'))).toBe('ratio-too-extreme');
    expect(code(() => planRatio('1:20'))).toBe('ratio-metering');
    expect(code(() => planRatio('wide'))).toBe('bad-ratio');
    // 719:480 rounds to the 3:2 screen but with another thumbnail: its photos could not be told from 3:2 ones.
    expect(code(() => planRatios([{ name: 'x', ratio: '719:480' }]))).toBe('ratio-conflict');
    expect(code(() => planRatios(Array.from({ length: 9 }, (_, i) => ({ name: `r${i}`, ratio: '65:24' }))))).toBe('too-many-ratios');
    expect(code(() => planRatios([{ name: '', ratio: '65:24' }]))).toBe('bad-name');
    expect(QUICK_VIEW_FULL.length).toBe(299);
  });
  it('names: printable ASCII, 1 to 80 characters', () => {
    expect(validateRatioName('65:24')).toBeNull();
    expect(validateRatioName('XPan 65:24')).toBeNull();
    expect(validateRatioName('')).toBe('empty');
    expect(validateRatioName('   ')).toBe('empty');
    expect(validateRatioName(' x')).toBe('bad-char');
    expect(validateRatioName('宽幅')).toBe('bad-char');
    expect(validateRatioName('a\tb')).toBe('bad-char');
    expect(validateRatioName('x'.repeat(81))).toBe('too-long');
  });
  it('draws a 60x40 icon in the style of the camera', () => {
    const px = drawRatioIcon('65:24');
    expect(px.length).toBe(RATIO_ICON_BYTES);
    const at = (x: number, y: number): number[] => [...px.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([255, 255, 255, 0]);
    expect(at(3, 1)).toEqual([128, 128, 128, 255]);
    expect(at(4, 2)).toEqual([53, 53, 54, 255]);
    expect(at(56, 38)).toEqual([128, 128, 128, 255]);
    const colours = new Set<string>();
    let white = 0;
    for (let i = 0; i < px.length; i += 4) {
      colours.add([...px.subarray(i, i + 4)].join());
      if (px[i] === 255 && px[i + 3] === 255) white++;
    }
    expect([...colours].sort()).toEqual(['128,128,128,255', '255,255,255,0', '255,255,255,255', '53,53,54,255']);
    expect(white).toBeGreaterThan(150);
    expect(ratioLabel('2.350:1')).toBe('2.35:1');
    expect(ratioLabel('2.39')).toBe('2.39:1');
    expect(ratioLabel('65 : 24')).toBe('65:24');
    expect(ratioLabel('1234567:1000000').length).toBeLessThanOrEqual(9);
    for (const r of ['6:17', '4:1', '1.375:1', '9:16', '2.76:1']) expect(drawRatioIcon(r).length).toBe(RATIO_ICON_BYTES);
  });
  it('links the pre-compiled modules', () => {
    expect(Object.keys(NATIVE.state.variants).length).toBe(8);
    expect(Object.keys(NATIVE.map.variants).length).toBe(8);
    expect(Object.keys(NATIVE.identity.variants).length).toBe(57);
    const a = linkNative('map', 1, 0x543fb890, { ratios: 0x543fb870 });
    const b = linkNative('map', 1, 0x543fb8a0, { ratios: 0x543fb870 });
    expect(a.code.length).toBe(b.code.length);
    expect(a.symbols.crop_make_view - 0x543fb890).toBe(b.symbols.crop_make_view - 0x543fb8a0);
    expect(code(() => linkNative('map', 9, 0x543fb890, { ratios: 1 }))).toBe('too-many-ratios');
    expect(code(() => linkNative('map', 1, 0x543fb890, {}))).toBe('internal');
    expect(code(() => linkNative('state', 3, 0x543fb890, { crop_active_bitmap: 0x40000000, crop_source_rectangles: 4, prior_native_save: 0x10000000, prior_native_load: 8, factory_source_rectangle_body: 12 }))).toBe('internal');
  });
});

describe.skipIf(!have)('aspect: firmware files', () => {
  let raw: Uint8Array;
  let dec: Uint8Array;
  let one: BuildResult;
  const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  it('builds a file with 65:24 that passes every check', async () => {
    raw = new Uint8Array(readFileSync(OFFICIAL));
    dec = (await openOfficial(raw)).decoded;
    one = await buildFirmware(raw, [], [{ name: '65:24', ratio: '65:24' }]);
    expect(Object.entries(one.checks).filter(([, v]) => v !== true)).toEqual([]);
    expect(Object.keys(one.checks).length).toBeGreaterThanOrEqual(22);
    expect(one.ratios).toEqual([{ id: 7, name: '65:24', ratio: '65:24', actual: '30:11', sizes: [[6192, 2272], [4944, 1812], [3504, 1284], [1920, 704]] }]);
    expect(one.file.length).toBeGreaterThan(OFFICIAL_SIZE);
    const v = verifyContainer(one.file, one.decoded);
    expect(Object.values(v.checks).every((x) => x)).toBe(true);
  });

  it('only RTOS and ICONBIN grow, by whole frames; everything else is byte-identical', () => {
    const fw = new Firmware(one.file);
    const so = sectionsOf(dec);
    const sn = sectionsOf(fw.decoded);
    expect(sn.map((s) => s.name)).toEqual(so.map((s) => s.name));
    let shift = 0;
    for (let i = 0; i < so.length; i++) {
      const a = so[i];
      const b = sn[i];
      expect([b.v1, b.v2, b.offset]).toEqual([a.v1, a.v2, a.offset + shift]);
      if (a.name === 'RTOS' || a.name === 'ICONBIN') {
        const grown = b.size - a.size;
        expect(grown > 0 && grown % FRAME_SIZE === 0).toBe(true);
        expect(Buffer.compare(sectionData(fw.decoded, b).subarray(0, a.size), sectionData(dec, a)) === 0).toBe(a.name === 'ICONBIN');
        shift += grown;
      } else {
        expect(b.size).toBe(a.size);
        expect(Buffer.compare(sectionData(fw.decoded, b), sectionData(dec, a))).toBe(0);
      }
    }
    expect(fw.decoded.length).toBe(DECODED_SIZE + shift);
    expect(sum32(fw.decoded)).toBe(0);
    expect(u32(fw.decoded, fw.decoded.length - 4)).toBe(u32(dec, dec.length - 4));
    // The firmware's version number is untouched (so the official file can be installed over it).
    for (const va of [0x53fe50f8, 0x53a78498, 0x53a784bc]) expect(u32(fw.decoded, RTOS_OFFSET + va - 0x53000000)).toBe(u32(dec, RTOS_OFFSET + va - 0x53000000));
  });

  it('the stream is made of official frames and full stored frames only', () => {
    const fo = new Firmware(raw);
    const fn = new Firmware(one.file);
    const official = new Set(fo.frames.map((f) => Buffer.from(raw.subarray(f.start, f.end)).toString('latin1')));
    let stored = 0;
    for (const [i, f] of fn.frames.entries()) {
      if (official.has(Buffer.from(one.file.subarray(f.start, f.end)).toString('latin1'))) continue;
      expect([f.stored, f.outLen, one.file[f.start], one.file[f.start + 1], i > 0 && i < fn.frames.length - 1]).toEqual([true, FRAME_SIZE, 0xe0, 0, true]);
      stored++;
    }
    expect(stored).toBe(one.changedFrames.length);
    expect(stored).toBeGreaterThan(8);
    expect(stored).toBeLessThan(120);
    expect(fn.frames.length).toBeGreaterThan(fo.frames.length);
  });

  it('the new RTOS is the builder output, then padding, the record and the sum word', () => {
    const fw = new Firmware(one.file);
    const s = sectionsOf(fw.decoded).find((x) => x.name === 'RTOS')!;
    const rtos = sectionData(fw.decoded, s);
    const built = installRatios(dec.slice(RTOS_OFFSET, RTOS_OFFSET + RTOS_LENGTH), dec.slice(ICONBIN_OFFSET, ICONBIN_OFFSET + ICONBIN_LENGTH), planRatios([{ name: '65:24', ratio: '65:24' }]));
    expect(Buffer.compare(rtos.subarray(0, built.rtos.length), built.rtos)).toBe(0);
    expect(readRatioRecord(rtos)).toEqual([{ name: '65:24', ratio: '65:24' }]);
    const tail = rtos.subarray(built.rtos.length, rtos.length - 32);
    expect(tail.every((b) => b === 0)).toBe(true);
    expect(Buffer.from(rtos.subarray(rtos.length - 12, rtos.length - 4)).toString('latin1')).toBe('GRMODAR1');
    expect(0x53000000 + rtos.length).toBeLessThan(0x55000000);
    const ic = sectionsOf(fw.decoded).find((x) => x.name === 'ICONBIN')!;
    const icons = sectionData(fw.decoded, ic);
    expect(Buffer.compare(icons.subarray(ICONBIN_LENGTH, ICONBIN_LENGTH + 9600), drawRatioIcon('65:24'))).toBe(0);
    expect(icons.subarray(ICONBIN_LENGTH + 9600).every((b) => b === 0)).toBe(true);
    expect(readRatioRecord(dec.subarray(RTOS_OFFSET, RTOS_OFFSET + RTOS_LENGTH))).toBeNull();
  });

  it('the factory ratios keep their numbers; only jumps and addresses change in the official code', () => {
    const built = installRatios(dec.slice(RTOS_OFFSET, RTOS_OFFSET + RTOS_LENGTH), dec.slice(ICONBIN_OFFSET, ICONBIN_OFFSET + ICONBIN_LENGTH), planRatios([{ name: 'a', ratio: '65:24' }, { name: 'b', ratio: '5:4' }]));
    const changed = new Set(built.words.filter((w) => w.before !== w.after).map((w) => w.address));
    expect(changed.size).toBe(93);
    for (const w of built.words) {
      if (w.before === w.after) continue;
      const branch = (w.after & 0x0e000000) === 0x0a000000;
      const mov = (w.after & 0x0fb00000) === 0x03000000; // MOVW / MOVT
      expect(branch || mov, w.address.toString(16)).toBe(true);
      if (branch) {
        let d = w.after & 0xffffff;
        if (d & 0x800000) d -= 0x1000000;
        expect(w.address + 8 + d * 4).toBeGreaterThanOrEqual(0x53000000 + RTOS_LENGTH);
      }
    }
    // the menu order begins with the factory order 3:2, 4:3, 1:1, 16:9
    const low = built.words.find((w) => w.address === 0x531baf88)!.after;
    const high = built.words.find((w) => w.address === 0x531baf8c)!.after;
    const half = (w: number): number => ((w >>> 4) & 0xf000) | (w & 0xfff);
    const order = (half(low) | (half(high) << 16)) >>> 0;
    expect([...built.rtos.subarray(order - 0x53000000, order - 0x53000000 + 6)]).toEqual([0, 1, 3, 2, 7, 8]);
  });

  it('the engine recognises and verifies its own files, and nothing else', async () => {
    const eng = await Engine.open(raw);
    const good = await eng.inspect(one.file);
    expect([good.kind, good.verified, good.ratios.map((r) => r.ratio), good.slots.map((s) => s.colorChanged || s.nameChanged || s.iconChanged)]).toEqual(['modified', true, ['65:24'], [false, false]]);
    expect(good.slots[0].names.en).toBe('Cinema (Yellow)');

    const fix = (d: Uint8Array, at: number): Uint8Array => {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      dv.setUint32(at, (dv.getUint32(at, true) - sum32(d)) >>> 0, true);
      return d;
    };
    const { buildGrown } = await import('../src/fw');
    const fwo = new Firmware(raw);
    const insertions = [{ at: RTOS_OFFSET + RTOS_LENGTH, length: one.decoded.length - DECODED_SIZE - FRAME_SIZE }, { at: ICONBIN_OFFSET + ICONBIN_LENGTH, length: FRAME_SIZE }];
    const tamper = async (change: (d: Uint8Array) => void, sumAt: number): Promise<{ kind: string; verified: boolean }> => {
      const d = one.decoded.slice();
      change(d);
      fix(d, sumAt);
      const s = await eng.inspect(buildGrown(fwo, d, insertions).out);
      return { kind: s.kind, verified: s.verified };
    };
    const appended = RTOS_OFFSET + RTOS_LENGTH;
    // one instruction of the appended code
    expect(await tamper((d) => { d[appended + 0x2a000 - 0x1000] ^= 1; }, appended + 0x100)).toEqual({ kind: 'modified', verified: false });
    expect(await tamper((d) => { d[appended + 0x27a00] ^= 4; }, appended + 0x100)).toEqual({ kind: 'modified', verified: false });
    // a byte of official code somewhere else
    expect(await tamper((d) => { d[RTOS_OFFSET + 0x400000] ^= 1; }, RTOS_OFFSET + 0x400010)).toEqual({ kind: 'modified', verified: false });
    // one of the hook words pointing elsewhere
    expect(await tamper((d) => { d[RTOS_OFFSET + 0x8876b8] ^= 4; }, RTOS_OFFSET + 0x400010)).toEqual({ kind: 'modified', verified: false });
    // an unchanged copy rebuilt the same way is fine (the test's own rebuild is not the problem)
    expect(await tamper(() => undefined, appended + 0x100)).toEqual({ kind: 'modified', verified: true });
    // the official file and plain garbage
    expect((await eng.inspect(raw)).kind).toBe('official');
    expect((await eng.inspect(one.file.subarray(0, one.file.length - 4))).kind).toBe('unknown');
  });

  it('eight ratios with names; nine are refused', async () => {
    const eng = await Engine.open(raw);
    const list = ['65:24', '2.39:1', '16:10', '5:4', '6:7', '2:1', '7:6', '3:1'].map((r, i) => ({ name: i % 2 ? r : `Frame ${r}`, ratio: r }));
    const b = await eng.buildFirmware([], list);
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.ratios.map((r) => [r.id, r.name, r.sizes[0]])).toEqual([
      [7, 'Frame 65:24', [6192, 2272]], [8, '2.39:1', [6192, 2580]], [9, 'Frame 16:10', [6192, 3888]], [10, '5:4', [5160, 4128]],
      [11, 'Frame 6:7', [3544, 4128]], [12, '2:1', [6192, 3096]], [13, 'Frame 7:6', [4816, 4128]], [14, '3:1', [6192, 2064]],
    ]);
    const s = await eng.inspect(b.file);
    expect([s.kind, s.verified, s.ratios.length]).toEqual(['modified', true, 8]);
    await expect(eng.buildFirmware([], [...list, { name: 'x', ratio: '4:5' }])).rejects.toMatchObject({ code: 'too-many-ratios' });
    await expect(eng.buildFirmware([], [{ name: 'x', ratio: '3:2' }])).rejects.toMatchObject({ code: 'ratio-factory' });
    await expect(eng.buildFirmware([], [{ name: '宽', ratio: '2:1' }])).rejects.toMatchObject({ code: 'bad-name' });
    await expect(eng.buildFirmware([], [])).rejects.toMatchObject({ code: 'bad-edit' });
  });

  it('ratios and Image Control edits combine, in either order of thinking', async () => {
    const eng = await Engine.open(raw);
    const matrix = [8192, 0, 0, 100, 8000, 92, -50, 250, 7992];
    const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, i * 64));
    const slot = [{ slot: 'CY' as const, preset: { matrixQ13: matrix, curves: [curve, curve, curve] as [number[], number[], number[]] }, names: { en: 'Scope' } }];
    const colour = await eng.buildFirmware(slot);
    const both = await eng.buildFirmware(slot, [{ name: '65:24', ratio: '65:24' }]);
    const ratio = await eng.buildFirmware([], [{ name: '65:24', ratio: '65:24' }]);
    expect(Object.values(both.checks).every((v) => v === true)).toBe(true);
    // The combined payload is the ratio payload with exactly the colour edits laid over it
    // (apart from the two words that keep the sums at zero).
    const dBoth = new Firmware(both.file).decoded;
    const dRatio = new Firmware(ratio.file).decoded;
    const dColour = new Firmware(colour.file).decoded;
    expect(dBoth.length).toBe(dRatio.length);
    const growth = dRatio.length - DECODED_SIZE;
    let differing = 0;
    for (let i = 0; i < RTOS_OFFSET + RTOS_LENGTH; i++) {
      if (dBoth[i] !== dRatio[i]) {
        differing++;
        if (dBoth[i] !== dColour[i]) throw new Error(`combined payload differs from both at 0x${i.toString(16)}`);
      } else if (dColour[i] !== dec[i] && dBoth[i] !== dColour[i]) throw new Error(`a colour edit was lost at 0x${i.toString(16)}`);
    }
    expect(differing).toBeGreaterThan(1000);
    for (let i = RTOS_OFFSET + RTOS_LENGTH; i < dBoth.length - 4; i++) {
      if (dBoth[i] !== dRatio[i] && !(i >= RTOS_OFFSET + RTOS_LENGTH + growth - FRAME_SIZE - 8 && i < RTOS_OFFSET + RTOS_LENGTH + growth)) throw new Error(`unexpected difference at 0x${i.toString(16)}`);
    }
    const s = await eng.inspect(both.file);
    expect([s.kind, s.verified, s.ratios.map((r) => r.name), s.slots[0].colorChanged, s.slots[0].names.en, s.slots[1].colorChanged]).toEqual(['modified', true, ['65:24'], true, 'Scope', false]);
    expect((await eng.inspect(colour.file)).ratios).toEqual([]);
  });

  it('previews a ratio for the interface', async () => {
    const eng = await Engine.open(raw);
    const p = eng.previewRatio('65:24');
    expect(p.problem).toBeUndefined();
    expect([p.actual, p.screen, p.sizes![0], p.icon!.length]).toEqual(['30:11', { left: 0, top: 108, width: 720, height: 264 }, [6192, 2272], 9600]);
    expect(Math.abs(p.errorPercent! - 0.699)).toBeLessThan(0.01);
    expect(eng.previewRatio('3:2').problem).toBe('ratio-factory');
    expect(eng.previewRatio('30:11', ['65:24']).problem).toBe('ratio-duplicate'); // 65:24 already rounds to 30:11
    const refused = eng.previewRatio('1.85:1');
    expect([refused.problem, refused.nearest]).toEqual(['ratio-quick-view', ['15:8', '90:49']]);
    for (const r of refused.nearest!) expect(eng.previewRatio(r).problem).toBeUndefined();
    expect(eng.previewRatio('2.39:1', ['65:24']).problem).toBeUndefined();
    expect(eng.previewRatio('hello').problem).toBe('bad-ratio');
    expect(eng.previewRatio('720:268').problem).toBe('ratio-quick-view');
    expect(eng.validateRatioName('65:24')).toBeNull();
  });
});
