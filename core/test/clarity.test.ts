import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, color, fw } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');

describe('clarity table data', () => {
  it('builds the table bytes and reads them back', () => {
    const bytes = fw.clarityBytes([{ level: -2, gains: fw.SOFT_FOCUS_GAINS.weak }]);
    expect(bytes.length).toBe(198);
    const rows = fw.readClarity(bytes, 0);
    expect(rows[2]).toEqual([...fw.SOFT_FOCUS_GAINS.weak]);
    rows.forEach((row, r) => { if (r !== 2) expect(row).toEqual([...fw.OFFICIAL_CLARITY[r]]); });
    expect(fw.clarityChanges(bytes, 0)).toEqual([{ level: -2, strength: 'weak' }]);
    expect(fw.clarityChanges(fw.clarityBytes([]), 0)).toEqual([]);
    expect(fw.clarityChanges(fw.clarityBytes([{ level: 3, gains: [1024, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }]), 0)).toEqual([{ level: 3, strength: 'custom' }]);
  });
  it('rejects edits it cannot make', () => {
    const g = fw.SOFT_FOCUS_GAINS.medium;
    expect(() => fw.clarityBytes([{ level: 0, gains: g }])).toThrow(/cannot be changed/);
    expect(() => fw.clarityBytes([{ level: -5, gains: g }])).toThrow(/cannot be changed/);
    expect(() => fw.clarityBytes([{ level: -1, gains: g }, { level: -1, gains: g }])).toThrow(/twice/);
    expect(() => fw.clarityBytes([{ level: -1, gains: g.slice(1) }])).toThrow(/11 gains/);
    expect(() => fw.clarityBytes([{ level: -1, gains: [...g.slice(1), 4096] }])).toThrow(/0\.\.2048/);
    expect(() => fw.clarityBytes([{ level: -1, gains: [...g.slice(1), 1.5] }])).toThrow(/integer/);
  });
});

describe('clarity model', () => {
  const W = 192, H = 128;
  const photo = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = (y * W + x) * 4;
    const v = ((x >> 3) + (y >> 3)) % 2 ? 200 : 40; // checkerboard of 8 px squares plus noise
    photo[q] = v + rnd() * 30; photo[q + 1] = v * 0.8 + rnd() * 30; photo[q + 2] = v * 0.6 + 20; photo[q + 3] = 255;
  }
  const lum = (d: ArrayLike<number>, p: number): number => 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  const detail = (d: ArrayLike<number>): number => {
    let s = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      s += Math.abs(4 * lum(d, p) - lum(d, p - 1) - lum(d, p + 1) - lum(d, p - W) - lum(d, p + W));
    }
    return s;
  };
  it('follows the camera rule for the level sizes', () => {
    expect(color.clarityLevels(6192, 4128).length).toBe(11);
    expect(color.clarityLevels(4944, 3296).length).toBe(10);
    expect(color.clarityLevels(3504, 2336).length).toBe(10);
    expect(color.clarityLevels(3504, 2336).at(-1)).toEqual([8, 6]);
    expect(color.clarityLevels(1920, 1280).length).toBe(9);
    expect(color.clarityLevels(6192, 4128)[1]).toEqual([3096, 2064]);
  });
  it('gives back the picture when every gain is 1.0', () => {
    const out = color.simulateClarity(photo, W, H, fw.OFFICIAL_CLARITY[4]);
    let max = 0;
    for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i] - photo[i]));
    expect(max).toBeLessThanOrEqual(1);
  });
  it('softens more with each strength, keeps the overall brightness and the colour', () => {
    const d0 = detail(photo);
    const ds = (['weak', 'medium', 'strong'] as const).map((s) => detail(color.simulateClarity(photo, W, H, fw.SOFT_FOCUS_GAINS[s])));
    expect(ds[0]).toBeLessThan(d0 * 0.95);
    expect(ds[1]).toBeLessThan(ds[0]);
    expect(ds[2]).toBeLessThan(ds[1]);
    const out = color.simulateClarity(photo, W, H, fw.SOFT_FOCUS_GAINS.strong);
    let m0 = 0, m1 = 0;
    for (let p = 0; p < W * H; p++) { m0 += lum(photo, p); m1 += lum(out, p); }
    expect(Math.abs(m1 - m0) / (W * H)).toBeLessThan(2);
    // the official -4 is much milder than soft focus
    expect(detail(color.simulateClarity(photo, W, H, fw.OFFICIAL_CLARITY[0]))).toBeGreaterThan(ds[0]);
  });
});

describe.skipIf(!have)('soft focus in a firmware', () => {
  let eng: Engine;
  const soft = [{ level: -2, strength: 'weak' }, { level: -3, strength: 'medium' }, { level: -4, strength: 'strong' }] as const;
  it('finds the official table where it is expected', async () => {
    eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const dec = new Uint8Array(readFileSync(P + 'official.decoded'));
    expect(fw.readClarity(dec)).toEqual(fw.OFFICIAL_CLARITY.map((r) => [...r]));
    expect(fw.CLARITY_OFFSET).toBe(0xb64570);
    expect(fw.hasOfficialClarity(dec)).toBe(true);
  });
  it('changes the table and the compensation word only', async () => {
    const official = new Uint8Array(readFileSync(P + 'official.bin'));
    const dec = new Uint8Array(readFileSync(P + 'official.decoded'));
    const r = await fw.buildFirmware(official, [], [], soft.map((s) => ({ level: s.level, gains: fw.SOFT_FOCUS_GAINS[s.strength] })));
    expect(Object.values(r.checks).every((v) => v === true)).toBe(true);
    expect(r.ranges.map((x) => x.what)).toEqual(['clarity table', 'checksum compensation word']);
    for (let i = 0; i < dec.length; i++) {
      if (dec[i] === r.decoded[i]) continue;
      const inTable = i >= fw.CLARITY_OFFSET && i < fw.CLARITY_OFFSET + fw.CLARITY_BYTES;
      const inComp = i >= fw.COMP_OFFSET && i < fw.COMP_OFFSET + 4;
      expect(inTable || inComp).toBe(true);
    }
    expect(fw.readClarity(r.decoded).slice(0, 4)).toEqual([fw.SOFT_FOCUS_GAINS.strong, fw.SOFT_FOCUS_GAINS.medium, fw.SOFT_FOCUS_GAINS.weak, fw.OFFICIAL_CLARITY[3]].map((x) => [...x]));
  });
  it('builds soft focus alone and recognises it on a card', async () => {
    const built = await eng.buildFirmware([], [], [...soft]);
    const s = await eng.inspect(built.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.softFocus).toEqual([{ level: -4, strength: 'strong' }, { level: -3, strength: 'medium' }, { level: -2, strength: 'weak' }]);
    expect(s.slots.every((x) => !x.colorChanged && !x.nameChanged && !x.iconChanged)).toBe(true);
    const official = await eng.inspect(new Uint8Array(readFileSync(P + 'official.bin')));
    expect(official.softFocus).toEqual([]);
    // without soft focus nothing changes compared with before
    const plain = await eng.buildFirmware([{ slot: 'CG', names: { en: 'C200' } }]);
    expect((await eng.inspect(plain.file)).softFocus).toEqual([]);
  });
  it('goes into the same firmware as slot edits and added ratios', async () => {
    const built = await eng.buildFirmware([{ slot: 'CY', names: { en: 'Soft' } }], [{ name: '65:24', ratio: '65:24' }], [{ level: -1, strength: 'weak' }]);
    const s = await eng.inspect(built.file);
    expect(s.verified).toBe(true);
    expect(s.ratios.map((r) => r.ratio)).toEqual(['65:24']);
    expect(s.softFocus).toEqual([{ level: -1, strength: 'weak' }]);
    expect(s.slots[0].names.en).toBe('Soft');
  });
  it('checks the requests', async () => {
    await expect(eng.buildFirmware([], [], [{ level: 1 as -1, strength: 'weak' }])).rejects.toThrow(/clarity 1/);
    await expect(eng.buildFirmware([], [], [{ level: -1, strength: 'mild' as 'weak' }])).rejects.toThrow(/strength/);
    await expect(eng.buildFirmware([], [], [])).rejects.toThrow(/nothing to change/);
  });
});
