// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { gr3xJpegFrame, GR3X_PICTURE_JPEG_BYTES } from '../src/fw/gr3x/shutdown';
import { readRes } from '../src/fw/aspect/res';
import { Firmware } from '../src/fw/container';

const input = process.env.GRMOD_GR3_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));
const card = (k: number) => {
  const rgb = new Uint8Array(720 * 480 * 3);
  for (let i = 0; i < rgb.length; i += 3) { const x = (i / 3) % 720, y = Math.floor(i / 3 / 720); rgb[i] = (x * k) & 255; rgb[i + 1] = y & 255; rgb[i + 2] = (x + y) & 255; }
  return rgb;
};

describe.skipIf(!input)('GR III round 5: power-off pictures', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('encodes pictures like the camera\'s own (4:2:0, fixed size)', () => {
    expect(engine.info.capabilities.menuPictures).toBe(true);
    const jpeg = engine.encodeMenuPicture(card(1));
    expect(jpeg.length).toBe(GR3X_PICTURE_JPEG_BYTES);
    expect(gr3xJpegFrame(jpeg)).toEqual({ width: 720, height: 480, sampling: '420' });
  });
  it('builds them into A: files of RES and recognises the file again', async () => {
    const pictures = [{ id: 1, name: 'Sunset', jpeg: engine.encodeMenuPicture(card(1)) }, { id: 2, name: 'Card', jpeg: engine.encodeMenuPicture(card(3)) }];
    const built = await engine.buildFirmware([], ratios, [], { adjSoftFocus: true, dateStamp: true, shutdownPictures: pictures });
    const dir = readRes(new Firmware(built.file).decoded);
    expect(dir.files.map(f => f.path).slice(20, 26)).toEqual(['A:\\sound\\STF_Beep.bin', 'A:\\sound\\STS_Beep.bin',
      'A:\\Resource\\Jpeg\\GRMOD1.jpg', 'A:\\Resource\\Jpeg\\GRMOD2.jpg', 'B:\\Resource\\Jpeg\\AlpKey.jpg', 'B:\\Resource\\Jpeg\\AlpKeyR.jpg']);
    const summary = await (await Engine.open(raw)).inspect(built.file);
    expect(summary).toMatchObject({ kind: 'modified', verified: true, dateStamp: true, adjSoftFocus: true });
    expect(summary.shutdownPictures?.map(p => p.name)).toEqual(['Sunset', 'Card']);
    await expect(engine.buildFirmware([], ratios, [], { shutdownPictures: Array.from({ length: 9 }, (_, k) => ({ ...pictures[0], id: k + 1 })) }))
      .rejects.toMatchObject({ code: 'too-many-pictures' });
    await expect(engine.buildFirmware([], ratios, [], { shutdownPictures: [{ ...pictures[0], name: 'Ünicode' }] }))
      .rejects.toMatchObject({ code: 'bad-name' });
  }, 300000);
});
