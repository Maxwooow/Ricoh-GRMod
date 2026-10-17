// SPDX-License-Identifier: GPL-2.0-only
/**
 * Added Image Control slots (`src/fw/aspect/slots.ts`) and the post-curve matrix fit. The firmware
 * part needs the official firmware in testdata/private (skipped without it). What the new code
 * does when it runs (MultiAxial, ColorMatrix, the live-view parameter generator, the own-parameter
 * module and the look checks) was checked in an emulator on builds of this code with 1, 4 and 6
 * slots; the hooks are those of test firmwares 023..034, which ran on a GR IV HDF.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, color, fw } from '../src';
import { syntheticSamples } from '../src/color/convert';
import type { ExtraSlotSpec } from '../src/fw';
import { Patch } from '../src/fw/aspect/build';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'no error';
};

describe('post-curve matrix fit', () => {
  it('recovers a slot with a known post matrix and quantises it to rows of 512', () => {
    const P = syntheticSamples(800, 3, 1);
    const ck = [0, 1, 2].map((c) => Float64Array.from(color.KN, (x) => Math.min(1, Math.pow(x, 0.9 + 0.08 * c))));
    const truth: color.SlotParams = {
      M1: [[1.1, -0.05, -0.05], [0.02, 0.96, 0.02], [-0.03, 0.08, 0.95]],
      ck,
      P2: [[1.12, -0.08, -0.04], [0.05, 0.9, 0.05], [-0.02, 0.16, 0.86]],
    };
    const target = color.slotApply(truth, P);
    const plain = color.fitSlot(P, target);
    const post = color.fitSlot(P, target, { post: true });
    expect(plain.P2).toBeUndefined();
    expect(post.P2).toBeDefined();
    expect(post.meanDE).toBeLessThan(plain.meanDE);
    expect(post.meanDE).toBeLessThan(0.3);
    const q = color.quantizeSlot(post, [8192, 0, 0, 0, 8192, 0, 0, 0, 8192]);
    expect(q.postQ9).toBeDefined();
    for (let r = 0; r < 3; r++) expect(q.postQ9![r * 3] + q.postQ9![r * 3 + 1] + q.postQ9![r * 3 + 2]).toBe(512);
    // a slot without P2 gives no post matrix
    expect(color.quantizeSlot(plain, [8192, 0, 0, 0, 8192, 0, 0, 0, 8192]).postQ9).toBeUndefined();
  });
});

describe('added slots: data', () => {
  it('names are 1 to 12 printable ASCII characters', () => {
    expect(aspect.validateExtraSlotName('GR Mod 1')).toBeNull();
    expect(aspect.validateExtraSlotName('')).toBe('empty');
    expect(aspect.validateExtraSlotName('ABCDEFGHIJKLM')).toBe('too-long');
    expect(aspect.validateExtraSlotName('胶片')).toBe('bad-char');
    expect(aspect.validateExtraSlotName(' x')).toBe('bad-char');
    expect(aspect.MAX_EXTRA_SLOTS).toBe(6);
  });
});

describe.skipIf(!have)('added slots: firmware files', () => {
  const raw = (): Uint8Array => new Uint8Array(readFileSync(P + 'official.bin'));
  const slotSpec = (eng: Engine, k: number): ExtraSlotSpec => {
    const info = eng.info;
    const icon = fw.composeIcon(info.tiles.film, new Float32Array(40 * 40).fill(k % 2 ? 0.3 : 0.7));
    const m = [8192 + 100 * k, -50 * k, -50 * k, 0, 8192, 0, 0, -20 * k, 8192 + 20 * k].map((v) => v | 0);
    const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(i * 64 * (1 + 0.01 * k))));
    return { name: `Look ${k + 1}`, matrixQ13: m, curves: [curve, curve, curve], postQ9: [512 + 10 * k, -10 * k, 0, 0, 512, 0, 0, 5 * k, 512 - 5 * k].map((v) => v | 0), icon };
  };

  it('builds 1 to 6 slots alone or with everything else; the engine recognises and verifies them', async () => {
    const eng = await Engine.open(raw());
    for (const [n, opts] of [[1, {}], [6, { adjSoftFocus: true, dateStamp: true, monoUnlock: true }]] as const) {
      const slots = Array.from({ length: n }, (_, k) => slotSpec(eng, k));
      const ratios = n === 6 ? [{ name: '65:24', ratio: '65:24' }] : [];
      const b = await eng.buildFirmware([], ratios, [], { ...opts, extraSlots: slots });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect(s.extraSlots.map((x) => x.name)).toEqual(slots.map((x) => x.name));
      const dec = new fw.Firmware(b.file).decoded;
      const rtos = fw.sectionsOf(dec).find((x) => x.name === 'RTOS')!;
      expect(fw.readExtraSlotCount(dec.subarray(rtos.offset, rtos.offset + rtos.size))).toBe(n);
    }
  }, 120_000);

  it('installs the own-parameter module for every slot count', async () => {
    const eng = await Engine.open(raw());
    const word = (b: Uint8Array, a: number): number => new DataView(b.buffer, b.byteOffset).getUint32(a - 0x53000000, true);
    const target = (b: Uint8Array, a: number): number => {
      let off = word(b, a) & 0xffffff;
      if (off & 0x800000) off -= 0x1000000;
      return a + 8 + off * 4;
    };
    for (const n of [1, 3, 6]) {
      const b = await eng.buildFirmware([], [], [], { extraSlots: Array.from({ length: n }, (_, k) => slotSpec(eng, k)) });
      const d = new fw.Firmware(b.file).decoded;
      const sec = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
      const r = d.subarray(sec.offset, sec.offset + sec.size);
      expect(word(r, 0x53000460)).toBe(0x55837300); // the module's state pointer is cleared at start
      // settings load/save, the 13 getters and setters and the 8 "style of set" setters go into the module
      const end = 0x53000000 + 0x13d2ac0;
      for (const at of [0x533e17cc, 0x533e1c04, 0x533b7130, 0x533ad4e0, 0x533be620, 0x533b5c48, 0x532b6f80, 0x53300f5c]) {
        expect(word(r, at) >>> 24).toBe(0xea);
        expect(target(r, at)).toBeGreaterThanOrEqual(end);
      }
      const sp = target(r, 0x533e17cc);
      expect(target(r, 0x533e1c04) - sp).toBeLessThan(0x1000);
      // RAW development: room in its list for the added looks (mov r0,#24+n)
      expect(word(r, 0x5336b89c)).toBe((0xe3a00000 | (24 + n)) >>> 0);
    }
  }, 120_000);

  it('reads back exactly what was built; other slot data gives another file, verified as well', async () => {
    const eng = await Engine.open(raw());
    const slots = [slotSpec(eng, 0), { ...slotSpec(eng, 1), postQ9: undefined }];
    const b = await eng.buildFirmware([], [], [], { extraSlots: slots });
    const d = new fw.Firmware(b.file).decoded;
    const secs = fw.sectionsOf(d);
    const rtos = secs.find((x) => x.name === 'RTOS')!;
    const icons = secs.find((x) => x.name === 'ICONBIN')!;
    const back = aspect.readExtraSlots(d.slice(rtos.offset, rtos.offset + rtos.size), d.subarray(icons.offset, icons.offset + icons.size), 2)!;
    expect(back).not.toBeNull();
    expect(back[0].name).toBe('Look 1');
    expect(Array.from(back[0].matrixQ13)).toEqual(Array.from(slots[0].matrixQ13));
    expect(Array.from(back[0].postQ9!)).toEqual(Array.from(slots[0].postQ9!));
    expect(back[1].postQ9).toBeUndefined();
    expect(Array.from(back[1].curves[0])).toEqual(Array.from(slots[1].curves[0]));
    // a file built with a different matrix in slot 1 is a different file
    const other = await eng.buildFirmware([], [], [], { extraSlots: [{ ...slots[0], matrixQ13: [8292, -100, 0, 0, 8192, 0, 0, 0, 8192] }, slots[1]] });
    expect(other.sha256).not.toBe(b.sha256);
    expect((await eng.inspect(other.file)).verified).toBe(true);
  }, 120_000);

  it('halation: built for the slots that have it (with the date imprint), read back, a change gives another file', async () => {
    const eng = await Engine.open(raw());
    const slots = [{ ...slotSpec(eng, 0), halation: true }, slotSpec(eng, 1), { ...slotSpec(eng, 2), halation: true }];
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, extraSlots: slots });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect((await eng.inspect(b.file)).verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const secs = fw.sectionsOf(d);
    const rtos = secs.find((x) => x.name === 'RTOS')!;
    const icons = secs.find((x) => x.name === 'ICONBIN')!;
    const back = aspect.readExtraSlots(d.slice(rtos.offset, rtos.offset + rtos.size), d.subarray(icons.offset, icons.offset + icons.size), 3)!;
    expect(back.map((x) => x.halation)).toEqual([true, undefined, true]);
    // each slot's own light, from its look
    const patch = new Patch(d.slice(rtos.offset, rtos.offset + rtos.size));
    expect(aspect.readHalationLight(patch, 3)).toEqual(slots.map((x) => aspect.halationLight(x.curves, x.postQ9)));
    // the parameter's name in the camera's languages (rows of the text catalog: 0 Japanese, 1 English, 19 Simplified Chinese)
    const r = d.subarray(rtos.offset, rtos.offset + rtos.size);
    const word = (va: number): number => new DataView(r.buffer, r.byteOffset).getUint32(va - 0x53000000, true);
    const text = (row: number, id: number): string => {
      const desc = word(word(aspect.TEXT_CATALOG + row * 4) + id * 4);
      const units = r[desc - 0x53000000];
      const at = word(desc + 4) - 0x53000000;
      return String.fromCharCode(...Array.from({ length: units - 1 }, (_, i) => r[at + 2 * i] | (r[at + 2 * i + 1] << 8)));
    };
    expect([text(0, 852), text(1, 852), text(18, 852), text(19, 852), text(19, 339)]).toEqual(['ハレーション', 'Halation', '光暈', '光晕', '色调']);
    const other = await eng.buildFirmware([], [], [], { dateStamp: true, extraSlots: [slots[0], slots[1], { ...slots[2], halation: false }] });
    expect(other.sha256).not.toBe(b.sha256);
    expect((await eng.inspect(other.file)).verified).toBe(true);
    const none = await eng.buildFirmware([], [], [], { extraSlots: [slotSpec(eng, 0)] });
    const plain = await eng.buildFirmware([], [], [], { extraSlots: [{ ...slotSpec(eng, 0), halation: false }] });
    expect(plain.sha256).toBe(none.sha256);
  }, 120_000);

  it('halation on all six added slots (what GR Mod 0.7.4 always builds), with soft focus and the date imprint', async () => {
    const eng = await Engine.open(raw());
    const slots = Array.from({ length: 6 }, (_, i) => ({ ...slotSpec(eng, i % 3), name: `Look ${i + 1}`, halation: true }));
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, adjSoftFocus: true, extraSlots: slots });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect((await eng.inspect(b.file)).verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const secs = fw.sectionsOf(d);
    const rtos = secs.find((x) => x.name === 'RTOS')!;
    const icons = secs.find((x) => x.name === 'ICONBIN')!;
    const back = aspect.readExtraSlots(d.slice(rtos.offset, rtos.offset + rtos.size), d.subarray(icons.offset, icons.offset + icons.size), 6)!;
    expect(back.map((x) => x.halation)).toEqual([true, true, true, true, true, true]);
  }, 180_000);

  it('halation preview: the fixed look lifts red first and leaves dark pictures alone', () => {
    const w = 400, h = 300;
    const img = (light: boolean): Uint8ClampedArray => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, on = light && Math.hypot(x - 200, y - 150) < 6;
        d.set(on ? [255, 255, 255, 255] : [30, 30, 30, 255], i);
      }
      return d;
    };
    const dark = img(false);
    aspect.halateRgba(dark, w, h, 2);
    expect(Array.from(dark.slice(0, 4))).toEqual([30, 30, 30, 255]);
    const weak = img(true), strong = img(true);
    aspect.halateRgba(weak, w, h, 1);
    aspect.halateRgba(strong, w, h, 2);
    const at = (d: Uint8ClampedArray, x: number, y: number): number[] => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
    const [r, g, b] = at(strong, 212, 150);
    expect(r).toBeGreaterThan(g + 40);
    expect(g).toBeGreaterThanOrEqual(b - 2);
    expect(at(strong, 212, 150)[0]).toBeGreaterThan(at(weak, 212, 150)[0]);
    expect(at(strong, 390, 10)).toEqual([30, 30, 30]);
  });

  it('halation light follows the look: a look whose white is 238 still spreads its highlights', () => {
    const curve = (top: number): Uint16Array => Uint16Array.from({ length: 256 }, (_, i) => Math.round(Math.min(1, (i * 64) / 16383) * top * 16383));
    const plain = aspect.halationLight([curve(1), curve(1), curve(1)]);
    expect(plain).toEqual(aspect.PLAIN_LIGHT);
    expect(plain).toEqual({ threshold: 235, escale: 819 });
    const dim = aspect.halationLight([curve(238 / 255), curve(238 / 255), curve(238 / 255)]);
    expect(dim.threshold).toBe(219); // 235 * 238 / 255
    expect(dim.escale).toBe(Math.round(16384 / (238 - 219)));
    // a look that clips early keeps a few levels
    const clip = aspect.halationLight([curve(1.2), curve(1.2), curve(1.2)]);
    expect(clip.threshold).toBe(255 - aspect.HALATION.minRange);
    const w = 400, h = 300;
    const img = (): Uint8ClampedArray => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(Math.hypot(x - 200, y - 150) < 6 ? [232, 232, 232, 255] : [30, 30, 30, 255], (y * w + x) * 4);
      return d;
    };
    const fixed = img(), own = img();
    aspect.halateRgba(fixed, w, h, 2);
    aspect.halateRgba(own, w, h, 2, dim);
    const at = (d: Uint8ClampedArray, x: number, y: number): number[] => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
    expect(at(fixed, 212, 150)).toEqual([30, 30, 30]); // below the fixed 235: nothing
    expect(at(own, 212, 150)[0]).toBeGreaterThan(at(own, 212, 150)[1] + 40);
  });

  it('refuses more than six slots, bad names and bad colour data', async () => {
    const eng = await Engine.open(raw());
    const s = slotSpec(eng, 0);
    const err = async (slots: ExtraSlotSpec[]): Promise<string> => {
      try {
        await eng.buildFirmware([], [], [], { extraSlots: slots });
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
      return 'no error';
    };
    expect(await err(Array.from({ length: 7 }, () => s))).toBe('too-many-slots');
    expect(await err([{ ...s, name: 'é' }])).toBe('bad-name');
    expect(await err([{ ...s, matrixQ13: [8192, 1, 0, 0, 8192, 0, 0, 0, 8192] }])).toBe('bad-color');
    expect(await err([{ ...s, postQ9: [512, 1, 0, 0, 512, 0, 0, 0, 512] }])).toBe('bad-color');
    expect(await err([{ ...s, icon: new Uint8Array(10) }])).toBe('bad-icon');
    expect(await err([{ ...s, halation: {} as unknown as boolean }])).toBe('bad-halation');
    expect(code(() => aspect.validateExtraSlotName('x'))).toBe('no error');
  }, 120_000);
});
