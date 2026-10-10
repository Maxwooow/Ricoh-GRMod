import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const word = (d: Uint8Array, va: number): number => new DataView(d.buffer, d.byteOffset).getUint32(fw.RTOS_OFFSET + va - 0x53000000, true);

describe.skipIf(!have)('live-view shade of added ratios', () => {
  it('keeps the live view 3:2, draws the shade on the grid view and is recorded in the file', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const ratios = [{ name: '65:24', ratio: '65:24' }];
    const plain = await eng.buildFirmware([], ratios);
    const shaded = await eng.buildFirmware([], ratios, [], { ratioShade: true });
    expect(shaded.features.ratioShade).toBe(true);
    const a = new fw.Firmware(plain.file).decoded;
    const b = new fw.Firmware(shaded.file).decoded;
    const o = new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))).decoded;
    // the live-view rectangle and ROI entries stay native with the shade, hooked without it
    for (const va of [0x538876b8, 0x53646310, 0x53646c1c]) {
      expect(word(b, va)).toBe(word(o, va));
      expect(word(a, va)).not.toBe(word(o, va));
    }
    expect(word(b, 0x53e98bd8 + 19 * 4)).not.toBe(0x53578848);
    expect(word(a, 0x53e98bd8 + 19 * 4)).toBe(0x53578848);
    const s = await eng.inspect(shaded.file);
    expect(s.verified).toBe(true);
    expect(s.ratioShade).toBe(true);
    await expect(eng.buildFirmware([], [], [], { ratioShade: true })).rejects.toThrow();
  });
});
