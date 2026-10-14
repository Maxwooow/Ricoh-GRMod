// SPDX-License-Identifier: GPL-2.0-only
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, build, sectionsOf, sum32 } from '../src/fw/container';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';
import { GR3X_FILM_IDS } from '../src/fw/gr3x/look-resources';
import { readGr3xLookRecipe } from '../src/fw/gr3x/look-recipe';
import { GR3X_160 } from '../src/fw/gr3x/profile';
import { encodeGr3xFirmwareShutdown, readGr3xShutdown } from '../src/fw/gr3x/shutdown';
import { checkShutdownJpeg } from '../src/jpeg';

const ratios = GFX_RATIOS.filter(r => !['3:2','1:1'].includes(r)).map(r => ({name:r,ratio:r}));
const pixels = () => Uint8Array.from({length:720*480*3},(_,i) => {
  const x = Math.floor(i/3)%720, y = Math.floor(i/2160);
  return 128 + 90*Math.sin(x/9)*Math.cos(y/13) + 30*Math.sin(x*y/700 + i%3);
});
it('encodes the larger W2 image budget without blurring or adding noise', () => {
  const p = pixels(), before = p.slice(), result = encodeGr3xFirmwareShutdown(p);
  expect(result.data.length).toBe(49116);
  expect(result.grain).toBe(0); expect(result.soften).toBe(0);
  expect(p).toEqual(before);
  expect(checkShutdownJpeg(result.data,{byteLength:49116,sampling:'420'}).ok).toBe(true);
  expect(()=>encodeGr3xFirmwareShutdown(new Uint8Array(720*480*3))).toThrow();
});

describe.skipIf(!process.env.GRMOD_GR3X_FIRMWARE)('IIIx embedded shutdown through the application API', () => {
  it('combines an image with T4, reconstructs it, restores factory, and rejects unrelated edits', async () => {
    const engine = await Engine.open(new Uint8Array(readFileSync(process.env.GRMOD_GR3X_FIRMWARE!)));
    const image = encodeGr3xFirmwareShutdown(pixels()).data;
    const base = await engine.buildFirmware([], ratios);
    const made = await engine.buildFirmware([], ratios, [], {shutdownImage:image});
    expect(Object.values(made.checks).every(Boolean)).toBe(true);
    expect(await engine.inspect(made.file)).toMatchObject({verified:true,shutdownImage:{bytes:49116}});
    expect((await engine.buildFirmware([],ratios)).sha256).toBe(base.sha256);
    await expect(engine.buildFirmware([],ratios,[],{shutdownImage:new Uint8Array(49116)})).rejects.toThrow();
    const fw = new Firmware(made.file), d = fw.decoded.slice();
    d[GR3X_160.rtosOffset + 0x1000] ^= 1;
    const rt = sectionsOf(d).find(s=>s.name==='RTOS')!, at = rt.offset+rt.size-4;
    const v = new DataView(d.buffer); v.setUint32(at,(v.getUint32(at,true)-sum32(d))>>>0,true);
    expect((await engine.inspect(build(fw,d).out)).verified).toBe(false);
  });
});

describe.skipIf(!process.env.GRMOD_GR3X_FIRMWARE || !process.env.GRMOD_GR3X_W2)('camera-tested W2 binary regression', () => {
  it('reproduces the complete installed W2 firmware byte for byte, including all film metadata', async () => {
    const expected = new Uint8Array(readFileSync(process.env.GRMOD_GR3X_W2!));
    const engine = await Engine.open(new Uint8Array(readFileSync(process.env.GRMOD_GR3X_FIRMWARE!)));
    const fw = new Firmware(expected), rt = sectionsOf(fw.decoded).find(s=>s.name==='RTOS')!;
    const recipe = readGr3xLookRecipe(fw.decoded.subarray(rt.offset+GR3X_160.rtosLength,rt.offset+rt.size))!;
    const requests = recipe.films!.map((f,i) => ({slot:GR3X_FILM_IDS[i], names:{en:f.name}, photo:f.photo, preset:f.preset, icon:f.icon}));
    const result = await engine.buildFirmware(requests, ratios,
      [{level:-1,strength:'weak'},{level:-2,strength:'medium'},{level:-3,strength:'strong'}],
      {jpegMetadata:true,shutdownImage:readGr3xShutdown(fw.decoded)});
    expect(result.sha256).toBe('57e7366e50c1391f2b8e6f4d7e5b3df722db2524bc60de14125d4208311485f9');
    expect(Buffer.compare(result.file,expected)).toBe(0);
    expect(await engine.inspect(expected)).toMatchObject({verified:true,kind:'modified',shutdownImage:{bytes:49116}});
  });
});
