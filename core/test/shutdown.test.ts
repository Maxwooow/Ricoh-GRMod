// SPDX-License-Identifier: GPL-2.0-only
/**
 * Power-off pictures chosen in the camera's End Screen menu (aspect/shutdown.ts). The data part
 * runs everywhere; the firmware part needs the official firmware in testdata/private. What the
 * camera-side code does when it runs (the submenu, the End Screen list in both modes, rows, ticks,
 * confirm, thumbnails, the picture request, the store record) is checked in an emulator by
 * tools/shutdown/menu_check.py on builds of this code (2 and 8 pictures, with and without the
 * other additions).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { ExtraSlotSpec, ShutdownPictureSpec } from '../src/fw';
import { Patch } from '../src/fw/aspect/build';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

function picture(seed: number): Uint8Array {
  const rgb = new Uint8Array(720 * 480 * 3);
  for (let y = 0; y < 480; y++) for (let x = 0; x < 720; x++) {
    const i = (y * 720 + x) * 3;
    rgb[i] = (x * seed) & 255;
    rgb[i + 1] = (y * 2 + seed * 40) & 255;
    rgb[i + 2] = Math.hypot(x - 360, y - 240) < 100 ? 255 : 30;
  }
  return rgb;
}
const jpegs = new Map<number, Uint8Array>();
const jpeg = (seed: number): Uint8Array => {
  if (!jpegs.has(seed)) jpegs.set(seed, aspect.encodeShutdownPicture(picture(seed)));
  return jpegs.get(seed)!;
};
const pictures = (n: number): ShutdownPictureSpec[] => Array.from({ length: n }, (_, k) => ({ id: 0x100 + 7 * k, name: `Picture ${k + 1}`, jpeg: jpeg(k + 1) }));

describe('power-off pictures: data', () => {
  it('names are 1 to 20 printable ASCII characters', () => {
    expect(aspect.validateShutdownName('chikawa')).toBeNull();
    expect(aspect.validateShutdownName('')).toBe('empty');
    expect(aspect.validateShutdownName('x'.repeat(21))).toBe('too-long');
    expect(aspect.validateShutdownName('吉伊')).toBe('bad-char');
  });

  it('a picture is a 720x480 baseline JPEG of exactly two frames with its RES header; its thumbnail is 520x200', () => {
    const j = jpeg(1);
    expect(j.length).toBe(aspect.SHUTDOWN_JPEG_BYTES);
    expect(j.length + 36).toBe(2 * 0x6000);
    const t = aspect.shutdownThumbnail(j);
    expect(t.length).toBe(520 * 200 * 4);
    const at = (x: number, y: number): number[] => Array.from(t.slice((y * 520 + x) * 4, (y * 520 + x) * 4 + 4));
    expect(at(5, 100)).toEqual([0, 0, 0, 255]); // black side
    expect(at(260, 100)[2]).toBeGreaterThan(200); // the disc in the middle
    expect(() => aspect.encodeShutdownPicture(new Uint8Array(10))).toThrow();
  });
});

describe.skipIf(!have)('power-off pictures: firmware files', () => {
  const raw = (): Uint8Array => new Uint8Array(readFileSync(P + 'official.bin'));
  const slot = (eng: Engine): ExtraSlotSpec => {
    const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, i * 64));
    return { name: 'Look', matrixQ13: [8192, 0, 0, 0, 8192, 0, 0, 0, 8192], curves: [curve, curve, curve], icon: fw.composeIcon(eng.info.tiles.film, new Float32Array(1600).fill(0.5)), halation: true };
  };

  it('builds 1, 2 and 8 pictures alone and with everything else; inspect reads them back and verifies', async () => {
    const eng = await Engine.open(raw());
    for (const [n, all] of [[1, false], [2, true], [8, false], [8, true]] as const) {
      const list = pictures(n);
      const b = await eng.buildFirmware([], all ? [{ name: '65:24', ratio: '65:24' }] : [], [], {
        shutdownPictures: list, ...(all ? { extraSlots: [slot(eng)], dateStamp: true, adjSoftFocus: true, monoUnlock: true } : {}),
      });
      expect(Object.entries(b.checks).filter(([, v]) => v !== true)).toEqual([]);
      const s = await eng.inspect(b.file);
      expect(s.kind).toBe('modified');
      expect(s.verified).toBe(true);
      expect(s.shutdownPictures?.map((p) => [p.id, p.name])).toEqual(list.map((p) => [p.id, p.name]));
      expect(s.shutdownPictures?.every((p, k) => p.jpeg.every((v, i) => v === list[k].jpeg[i]))).toBe(true);
      if (all) {
        expect(s.ratios.length).toBe(1);
        expect(s.extraSlots.length).toBe(1);
        expect(s.dateStamp && s.adjSoftFocus && s.monoUnlock).toBe(true);
      }
      // the RES section: the pictures after SymKey.jpg, everything else as it was
      const d = new fw.Firmware(b.file).decoded;
      const off = new fw.Firmware(raw()).decoded;
      const files = aspect.readRes(d).files.map((f) => f.path);
      const official = aspect.readRes(off).files.map((f) => f.path);
      const anchor = official.indexOf('A:\\Resource\\Jpeg\\SymKey.jpg') + 1;
      expect(files).toEqual([...official.slice(0, anchor), ...list.map((_, k) => `A:\\Resource\\Jpeg\\GRMOD${k + 1}.jpg`), ...official.slice(anchor)]);
      for (const f of official) expect(aspect.resFile(d, f)).toEqual(aspect.resFile(off, f));
      // camera menu data
      const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
      const built = new Patch(d.slice(rtos.offset, rtos.offset + rtos.size));
      expect(aspect.readShutdownMenu(built)).toEqual(list.map((p) => ({ id: p.id, name: p.name })));
      // Setup > Display > End Screen opens the submenu; its line names in Simplified Chinese / English
      expect(built.word(0x53d9ca10 + 0x1bc + 10 * 4)).toBe(aspect.SHUTDOWN_MENU_ID);
      const text = (row: number, id: number): string => {
        const desc = built.word(built.word(0x543d4ac0 + row * 4) + id * 4);
        const units = built.read(desc, 1)[0];
        const bytes = built.read(built.word(desc + 4), 2 * (units - 1));
        return String.fromCharCode(...Array.from({ length: units - 1 }, (_, i) => bytes[2 * i] | (bytes[2 * i + 1] << 8)));
      };
      expect([aspect.SHUTDOWN_TYPE_TEXT, aspect.SHUTDOWN_PICTURE_TEXT, aspect.SHUTDOWN_FACTORY_TEXT].map((id) => text(19, id))).toEqual(['类型', '图片', '原厂']);
      expect([aspect.SHUTDOWN_TYPE_TEXT, aspect.SHUTDOWN_PICTURE_TEXT, aspect.SHUTDOWN_FACTORY_TEXT].map((id) => text(1, id))).toEqual(['Type', 'Picture', 'Original']);
    }
  }, 300_000);

  it('another picture, name, identity or order gives another file', async () => {
    const eng = await Engine.open(raw());
    const base = pictures(2);
    const sha = async (list: ShutdownPictureSpec[]): Promise<string> => (await eng.buildFirmware([], [], [], { shutdownPictures: list })).sha256;
    const a = await sha(base);
    expect(await sha([{ ...base[0], name: 'Other' }, base[1]])).not.toBe(a);
    expect(await sha([{ ...base[0], id: 999 }, base[1]])).not.toBe(a);
    expect(await sha([base[1], base[0]])).not.toBe(a);
    expect(await sha([base[0], { ...base[1], jpeg: jpeg(9) }])).not.toBe(a);
    expect(await sha(base)).toBe(a);
  }, 300_000);

  it('refuses bad lists', async () => {
    const eng = await Engine.open(raw());
    const err = async (list: ShutdownPictureSpec[]): Promise<string> => {
      try {
        await eng.buildFirmware([], [], [], { shutdownPictures: list });
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
      return 'no error';
    };
    const p = pictures(1)[0];
    expect(await err(pictures(9).map((x, k) => ({ ...x, jpeg: jpeg(1), id: k + 1 })))).toBe('too-many-pictures');
    expect(await err([p, { ...p, name: 'B' }])).toBe('bad-picture'); // same identity
    expect(await err([{ ...p, id: 0 }])).toBe('bad-picture');
    expect(await err([{ ...p, name: '吉伊' }])).toBe('bad-name');
    expect(await err([{ ...p, jpeg: p.jpeg.slice(1) }])).toBe('bad-picture');
  }, 120_000);
});
