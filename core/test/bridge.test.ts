import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine, fw } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('bridge patch format', () => {
  it('rejects anything that is not a patch', () => {
    expect(() => fw.applyPatch(new Uint8Array(4), new Uint8Array([0x78, 0x9c, 3, 0]))).toThrow();
  });
});

describe.skipIf(!have)('1.12 bridge firmware', () => {
  const official = new Uint8Array(readFileSync(P + 'official.bin'));
  let bridge: Uint8Array;
  it('is made from the official file, byte for byte the tested file', async () => {
    bridge = await fw.makeBridgeFirmware(official);
    expect(bridge.length).toBe(fw.BRIDGE_SIZE);
    expect(sha(bridge)).toBe(fw.BRIDGE_SHA256);
    expect(await fw.isBridgeFirmware(bridge)).toBe(true);
    expect(await fw.isBridgeFirmware(official)).toBe(false);
  });
  it('turns back into the official file', async () => {
    expect(sha(await fw.officialFromBridge(bridge))).toBe(sha(official));
  });
  it('refuses other files as a base', async () => {
    const other = official.slice(); other[1000] ^= 1;
    await expect(fw.makeBridgeFirmware(other)).rejects.toThrow();
    await expect(fw.officialFromBridge(other)).rejects.toThrow();
  });
  it('opens as the official firmware with the bridge flag, refuses builds, and is described as such', async () => {
    const eng = await Engine.open(bridge.slice());
    expect(eng.info.bridge).toBe(true);
    expect(eng.info.sha256).toBe(sha(official));
    await expect(eng.buildFirmware([], [], [], { dateStamp: true })).rejects.toMatchObject({ code: 'bridge-firmware' });
    expect(sha(await eng.bridgeFirmware())).toBe(fw.BRIDGE_SHA256);
    const off = await Engine.open(official.slice());
    expect(off.info.bridge).toBe(false);
    const s = await off.inspect(bridge.slice());
    expect(s.kind).toBe('bridge');
    expect((await off.inspect(official.slice())).kind).toBe('official');
  });
});
