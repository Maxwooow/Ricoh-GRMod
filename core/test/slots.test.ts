// SPDX-License-Identifier: GPL-2.0-only
/**
 * Added Image Control slots (`src/fw/aspect/slots.ts`) and the post-curve matrix fit. The firmware
 * part needs the official firmware in testdata/private (skipped without it). What the new code
 * does when it runs (MultiAxial, ColorMatrix, the live-view parameter generator) was checked in an
 * emulator; the hooks are those of test firmware 023, which ran on a GR IV HDF.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, color, fw } from '../src';
import { syntheticSamples } from '../src/color/convert';
import type { ExtraSlotSpec } from '../src/fw';

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
    expect(code(() => aspect.validateExtraSlotName('x'))).toBe('no error');
  }, 120_000);
});
