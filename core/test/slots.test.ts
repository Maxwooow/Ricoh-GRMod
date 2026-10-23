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
import { Engine, color, fw } from '../src';
import { syntheticSamples } from '../src/color/convert';
import type { ExtraSlotSpec } from '../src/fw';
import { Patch } from '../src/fw/aspect/build';
import { branchTarget } from '../src/fw/aspect/arm';

const P = new URL('../testdata/private/', import.meta.url).pathname;
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
    expect(aspect.MAX_EXTRA_SLOTS).toBe(20);
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

  it('builds 1 to 20 slots alone or with everything else; the engine recognises and verifies them', async () => {
    const eng = await Engine.open(raw());
    for (const [n, opts] of [[1, {}], [20, { adjSoftFocus: true, dateStamp: true, monoUnlock: true }]] as const) {
      const slots = Array.from({ length: n }, (_, k) => ({ ...slotSpec(eng, k), name: `Look ${k + 1}`, halation: k % 3 === 2 ? undefined : true }));
      const ratios = n === 20 ? [{ name: '65:24', ratio: '65:24' }] : [];
      const b = await eng.buildFirmware([], ratios, [], { ...opts, extraSlots: slots });
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect(s.extraSlots.map((x) => x.name)).toEqual(slots.map((x) => x.name));
      const dec = new fw.Firmware(b.file).decoded;
      const rtos = fw.sectionsOf(dec).find((x) => x.name === 'RTOS')!;
      expect(fw.readExtraSlotCount(dec.subarray(rtos.offset, rtos.offset + rtos.size))).toBe(n);
      if (n === 20) {
        // names and icons: 846..851, then 864..877; 768..779, then 782..789
        const icons = fw.sectionsOf(dec).find((x) => x.name === 'ICONBIN')!;
        const back = aspect.readExtraSlots(dec.slice(rtos.offset, rtos.offset + rtos.size), dec.subarray(icons.offset, icons.offset + icons.size), n)!;
        expect(back.map((x) => x.name)).toEqual(slots.map((x) => x.name));
        expect(back.map((x) => Array.from(x.icon.slice(0, 64)))).toEqual(slots.map((x) => Array.from(x.icon.slice(0, 64))));
        expect(back.map((x) => x.halation)).toEqual(slots.map((x) => x.halation));
        expect([aspect.extraTextId(5), aspect.extraTextId(6), aspect.extraTextId(19), aspect.extraIconId(11), aspect.extraIconId(12), aspect.extraIconId(19)]).toEqual([851, 864, 877, 779, 782, 789]);
      }
    }
  }, 240_000);

  it('installs the own-parameter module for every slot count', async () => {
    const eng = await Engine.open(raw());
    const word = (b: Uint8Array, a: number): number => new DataView(b.buffer, b.byteOffset).getUint32(a - 0x53000000, true);
    const target = (b: Uint8Array, a: number): number => {
      let off = word(b, a) & 0xffffff;
      if (off & 0x800000) off -= 0x1000000;
      return a + 8 + off * 4;
    };
    for (const n of [1, 7, 20]) {
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
    const slots: ExtraSlotSpec[] = [{ ...slotSpec(eng, 0), halation: true }, slotSpec(eng, 1), { ...slotSpec(eng, 2), halation: true }];
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
    expect(aspect.readHalationLight(patch, 34)).toEqual(aspect.halationLight(slots[0].curves, slots[0].postQ9));
    expect(aspect.readHalationLight(patch, 35)).toBeNull();
    expect(aspect.readHalationLight(patch, 36)).toEqual(aspect.halationLight(slots[2].curves, slots[2].postQ9));
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
    // the submenu's colour row (0.8.2), next to Grain Effect's own Strength (347)
    expect([text(0, 878), text(1, 878), text(19, 878), text(20, 878), text(19, 347)]).toEqual(['カラー', 'Colour', '颜色', 'สี', '强度']);
    // icons: list, colour scale (400 x 60), red and white
    const iconSize = (id: number): number[] => { const desc = word(aspect.ICON_CATALOG + id * 4); const b = r.subarray(desc - 0x53000000, desc - 0x53000000 + 6); return [b[2] | (b[3] << 8), b[4] | (b[5] << 8)]; };
    expect([780, 781, 790, 791].map(iconSize)).toEqual([[40, 40], [400, 60], [40, 40], [40, 40]]);
    // the parameter screens' hooks (shooting and RAW development) and the native readers' clamps
    for (const at of [0x531c7aa0, 0x531caa94, 0x531c9728, 0x531cb448, 0x531ca810, 0x531cb1bc, 0x531ca698, 0x531cbd9c, 0x531cc7f8, 0x531a6a8c, 0x531a9d64, 0x531aa1e8, 0x531ab4b8, 0x53911afc, 0x537dd7c4, 0x537d7768]) {
      expect(patch.word(at) >>> 24, at.toString(16)).toBe(0xea);
    }
    // the submenus' title hooks sit inside a prologue (`mov ip,sp; push …; <hook>; …; sub fp,ip,#4`): their code
    // must not write ip (test 043 did, and the camera froze on pressing Fn for either submenu)
    for (const at of [0x531cbd9c, 0x531aaa34]) {
      const back = (pc: number): boolean => (patch.word(pc) & 0x0f000000) === 0x0a000000 && branchTarget(pc, patch.word(pc)) === at + 4;
      let pc = branchTarget(at, patch.word(at));
      for (let n = 0; n < 16 && !back(pc); n++, pc += 4) {
        expect((patch.word(pc) >>> 12) & 15, `${at.toString(16)}: ${pc.toString(16)}`).not.toBe(12);
      }
      expect(back(pc)).toBe(true);
    }
    const other = await eng.buildFirmware([], [], [], { dateStamp: true, extraSlots: [slots[0], slots[1], { ...slots[2], halation: false }] });
    expect(other.sha256).not.toBe(b.sha256);
    expect((await eng.inspect(other.file)).verified).toBe(true);
    const none = await eng.buildFirmware([], [], [], { extraSlots: [slotSpec(eng, 0)] });
    const plain = await eng.buildFirmware([], [], [], { extraSlots: [{ ...slotSpec(eng, 0), halation: false }] });
    expect(plain.sha256).toBe(none.sha256);
    // without halation the screens and the Toning readers stay native
    const dn = new fw.Firmware(none.file).decoded;
    const rn = fw.sectionsOf(dn).find((x) => x.name === 'RTOS')!;
    const pn = new Patch(dn.slice(rn.offset, rn.offset + rn.size));
    expect([0x531cb1bc, 0x531ca698, 0x53911afc, 0x537dd7c4].map((a) => pn.word(a))).toEqual([0xe3500010, 0xe3500010, 0xe5d367a6, 0xe30f3150]);
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

  it('halation for Cinema Yellow / Green with a preset, with and without added slots; read back and verified', async () => {
    const eng = await Engine.open(raw());
    const x = slotSpec(eng, 1);
    const preset = { matrixQ13: x.matrixQ13, curves: x.curves, postQ9: x.postQ9 };
    const rtosOf = (file: Uint8Array): Patch => {
      const d = new fw.Firmware(file).decoded;
      const sec = fw.sectionsOf(d).find((y) => y.name === 'RTOS')!;
      return new Patch(d.slice(sec.offset, sec.offset + sec.size));
    };
    // alone: the development step's hook is installed for it
    const a = await eng.buildFirmware([{ slot: 'CY', preset, halation: true }, { slot: 'CG', preset }], [], [], {});
    expect((await eng.inspect(a.file)).verified).toBe(true);
    const pa = rtosOf(a.file);
    expect([...aspect.readHalation(pa, 34, 0)!]).toEqual([18]);
    expect(pa.word(0x539113f8) >>> 24).toBe(0xea);
    expect(aspect.readHalationLight(pa, 18)).toEqual(aspect.halationLight(x.curves, x.postQ9));
    // with added slots and the date imprint
    const b = await eng.buildFirmware([{ slot: 'CY', preset }, { slot: 'CG', preset, halation: true }], [], [], { dateStamp: true, extraSlots: [{ ...slotSpec(eng, 0), halation: true }, slotSpec(eng, 2)] });
    expect((await eng.inspect(b.file)).verified).toBe(true);
    expect([...aspect.readHalation(rtosOf(b.file), 34, 2)!].sort()).toEqual([19, 34]);
    // without a preset there is no Halation slider (Toning is Cinema's own)
    let err = '';
    try { await eng.buildFirmware([{ slot: 'CY', halation: true }], [], [], {}); } catch (e) { err = (e as { code?: string }).code ?? ''; }
    expect(err).toBe('bad-halation');
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
    const weak = img(true), medium = img(true), strong = img(true);
    aspect.halateRgba(weak, w, h, 1);
    aspect.halateRgba(medium, w, h, 2);
    aspect.halateRgba(strong, w, h, 3);
    const at = (d: Uint8ClampedArray, x: number, y: number): number[] => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
    const [r, g, b] = at(strong, 212, 150);
    expect(r).toBeGreaterThan(g + 40);
    expect(g).toBeGreaterThanOrEqual(b - 2);
    expect(at(strong, 212, 150)[0]).toBeGreaterThan(at(medium, 212, 150)[0]);
    expect(at(medium, 212, 150)[0]).toBeGreaterThan(at(weak, 212, 150)[0]);
    // the camera's three gains: Weak 12, Medium 18, Strong 24 (x 4 in the module)
    expect(aspect.halationGains()).toEqual([48, 72, 96]);
    expect(at(strong, 390, 10)).toEqual([30, 30, 30]);
  });

  it('halation light follows the look and starts softly: a look whose white is 238 still spreads its highlights', () => {
    const curve = (top: number): Uint16Array => Uint16Array.from({ length: 256 }, (_, i) => Math.round(Math.min(1, (i * 64) / 16383) * top * 16383));
    const plain = aspect.halationLight([curve(1), curve(1), curve(1)]);
    expect(Array.from(plain.table)).toEqual(Array.from(aspect.PLAIN_LIGHT.table));
    const t = plain.table;
    // nothing below the start, then rising ever faster (the square), full at white
    expect(t[aspect.HALATION.start]).toBe(0);
    expect(t[aspect.HALATION.start + 3]).toBeGreaterThan(0);
    expect(t[aspect.HALATION.start + 3]).toBeLessThan(200);
    for (let v = aspect.HALATION.start + 1; v < 255; v++) {
      expect(t[v]).toBeGreaterThan(t[v - 1]);
      expect(t[v + 1] - t[v]).toBeGreaterThanOrEqual(t[v] - t[v - 1] - 1);
    }
    expect(t[255]).toBe(16384);
    const dim = aspect.halationLight([curve(238 / 255), curve(238 / 255), curve(238 / 255)]);
    expect(dim.table[238]).toBe(16384);
    expect(dim.table[230]).toBeGreaterThan(t[230]);
    // a look that clips early: full from its white on
    const clip = aspect.halationLight([curve(1.2), curve(1.2), curve(1.2)]);
    expect(clip.table[255]).toBe(16384);
    expect(clip.table[230]).toBeGreaterThan(0); // a soft start below its white
    expect(clip.table[230]).toBeLessThan(clip.table[250]);
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
    expect(at(own, 212, 150)[0]).toBeGreaterThan(at(fixed, 212, 150)[0] + 20);
    expect(at(own, 212, 150)[0]).toBeGreaterThan(at(own, 212, 150)[1] + 40);
    // the camera's Weak: less
    const weak = img();
    aspect.halateRgba(weak, w, h, 1, dim);
    expect(at(weak, 212, 150)[0]).toBeLessThan(at(own, 212, 150)[0]);
    expect(at(weak, 212, 150)[0]).toBeGreaterThan(30);
  });

  it('refuses more than twenty slots, bad names and bad colour data', async () => {
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
    expect(await err(Array.from({ length: 21 }, () => s))).toBe('too-many-slots');
    expect(await err([{ ...s, name: 'é' }])).toBe('bad-name');
    expect(await err([{ ...s, matrixQ13: [8192, 1, 0, 0, 8192, 0, 0, 0, 8192] }])).toBe('bad-color');
    expect(await err([{ ...s, postQ9: [512, 1, 0, 0, 512, 0, 0, 0, 512] }])).toBe('bad-color');
    expect(await err([{ ...s, icon: new Uint8Array(10) }])).toBe('bad-icon');
    expect(await err([{ ...s, halation: {} as unknown as boolean }])).toBe('bad-halation');
    expect(code(() => aspect.validateExtraSlotName('x'))).toBe('no error');
  }, 120_000);
});
