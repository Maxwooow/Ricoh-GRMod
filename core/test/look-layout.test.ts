import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORDER_COUNT, buildFirmware, foff, openOfficial } from '../src/fw';
import { Engine } from '../src/app';
import { COLOR_HIDDEN, COLOR_VIS_TABLE, MONO_HIDDEN, MONO_VIS_TABLE, ORDER_TABLE } from '../src/fw/aspect';

const OFFICIAL = process.env.GRMOD_OFFICIAL ?? new URL('../testdata/private/official.bin', import.meta.url).pathname;
const have = existsSync(OFFICIAL);
const read = (): Uint8Array => new Uint8Array(readFileSync(OFFICIAL));
const FACTORY = [11, 12, 13, 14, 15, 16, 24, 17, 18, 19, 23, 20, 21, 22, 25, 29, 26, 27, 28, 30];
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

describe.skipIf(!have)('Image Control order / hidden looks (in place)', () => {
  it('writes only the order table and the visibility words', async () => {
    const raw = read();
    const { decoded } = await openOfficial(raw);
    const order = [12, 11, ...FACTORY.slice(2)];
    const res = await buildFirmware(raw, [], [], [], { lookLayout: { order, hidden: [20, 22] } });
    const img = res.decoded;
    expect(img.slice(foff(ORDER_TABLE), foff(ORDER_TABLE) + ORDER_COUNT)).toEqual(Uint8Array.from(order));
    expect(u32(img, foff(COLOR_VIS_TABLE + 9 * 4))).toBe(COLOR_HIDDEN); // style 20
    expect(u32(img, foff(COLOR_VIS_TABLE + 11 * 4))).toBe(COLOR_HIDDEN); // style 22
    expect(u32(img, foff(MONO_VIS_TABLE))).toBe(u32(decoded, foff(MONO_VIS_TABLE))); // untouched
    expect(res.features.lookLayout).toEqual({ order, hidden: [20, 22] });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
    // Only 20 order bytes + 2 visibility words + the compensation word may change.
    let changed = 0;
    for (let i = 0; i < img.length; i++) if (img[i] !== decoded[i]) changed++;
    expect(changed).toBeLessThanOrEqual(20 + 8 + 4);
    expect(u32(img, foff(MONO_VIS_TABLE))).not.toBe(MONO_HIDDEN);
  });

  it('rejects hiding Standard, duplicates and missing styles', async () => {
    const raw = read();
    await expect(buildFirmware(raw, [], [], [], { lookLayout: { order: FACTORY, hidden: [11] } })).rejects.toThrow();
    await expect(buildFirmware(raw, [], [], [], { lookLayout: { order: [11, 11, ...FACTORY.slice(2)], hidden: [] } })).rejects.toThrow();
    await expect(buildFirmware(raw, [], [], [], { lookLayout: { order: FACTORY.slice(1), hidden: [] } })).rejects.toThrow();
  });
});

describe.skipIf(!have)('Image Control order with an added slot', () => {
  it('puts style 34 at the front and hides a factory look', async () => {
    const raw = read();
    const curves = [0, 1, 2].map(() => Uint16Array.from({ length: 256 }, (_, i) => Math.round((i / 255) * 16383)));
    const icon = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i++) icon[i * 4 + 3] = 255;
    const order = [34, 11, 12, ...FACTORY.slice(2)];
    const res = await buildFirmware(raw, [], [], [], {
      extraSlots: [{ name: 'TEST', matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: curves as never, icon }],
      lookLayout: { order, hidden: [20] },
    });
    expect(res.features.extraSlots?.length).toBe(1);
    expect(res.features.lookLayout).toEqual({ order, hidden: [20] });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
  });
});

describe.skipIf(!have)('hiding an added slot', () => {
  it('builds the visibility hook with the hidden added style', async () => {
    const raw = read();
    const curves = [0, 1, 2].map(() => Uint16Array.from({ length: 256 }, (_, i) => Math.round((i / 255) * 16383)));
    const icon = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i++) icon[i * 4 + 3] = 255;
    const order = [11, 12, ...FACTORY.slice(2), 34];
    const res = await buildFirmware(raw, [], [], [], {
      extraSlots: [{ name: 'HIDE', matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: curves as never, icon }],
      lookLayout: { order, hidden: [34] },
    });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
    expect(res.features.lookLayout?.hidden).toEqual([34]);
  });
});


describe.skipIf(!have)('Engine.buildFirmware', () => {
  it('passes the look layout through the public API', async () => {
    const order = [12, 11, ...FACTORY.slice(2)];
    const eng = await Engine.open(read());
    const res = await eng.buildFirmware([], [], [], { lookLayout: { order, hidden: [20] } });
    expect(res.features.lookLayout).toEqual({ order, hidden: [20] });
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
  });
});


describe.skipIf(!have)('0.8.4: read back, Standard of the monochrome looks, the settings guard', () => {
  it('a file with a look layout (and added slots, the guard) is recognised and verified; the layout is read back', async () => {
    const eng = await Engine.open(read());
    const curves = [0, 1, 2].map(() => Uint16Array.from({ length: 256 }, (_, i) => Math.round((i / 255) * 16383)));
    const icon = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i++) icon[i * 4 + 3] = 255;
    const slot = { matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: curves as never, icon };
    const order = [35, 18, 11, 12, ...FACTORY.slice(2).filter((s) => s !== 18), 34];
    const layout = { order, hidden: [20, 34] };
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, extraSlots: [{ ...slot, name: 'A' }, { ...slot, name: 'B' }], lookLayout: layout });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.lookLayout).toEqual(layout);
    // Another layout gives another file, also verified.
    const c = await eng.buildFirmware([], [], [], { dateStamp: true, extraSlots: [{ ...slot, name: 'A' }, { ...slot, name: 'B' }], lookLayout: { order, hidden: [20] } });
    expect(c.sha256).not.toBe(b.sha256);
    expect((await eng.inspect(c.file)).verified).toBe(true);
  });
  it('rejects hiding the monochrome looks\' Standard (25)', async () => {
    const eng = await Engine.open(read());
    await expect(eng.buildFirmware([], [], [], { lookLayout: { order: FACTORY, hidden: [25] } })).rejects.toThrow();
  });
  it('with the monochrome looks unlocked, one of them can be hidden (the guard turns it into 25); the file verifies', async () => {
    const eng = await Engine.open(read());
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, monoUnlock: true, lookLayout: { order: FACTORY, hidden: [12, 26] } });
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.lookLayout).toEqual({ order: FACTORY, hidden: [12, 26] });
    // (What the guard and the lists do with it is run in tools/looks/looks_check.py.)
  });
});
