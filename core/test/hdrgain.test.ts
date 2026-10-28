// SPDX-License-Identifier: GPL-2.0-only
/**
 * HDR gain map (`src/fw/aspect/hdrgain.ts`). The build tests need the official firmware in
 * testdata/private (skipped without it). What the module does when it runs (the gain map against
 * a reference encoder, the files the camera's writer makes, libultrahdr decoding them, the
 * fallbacks) is checked in an emulator by `tools/hdrgain/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine, fw } from '../src';
import { HDRGAIN_SOURCE_SHA256 } from '../src/fw/aspect/hdrgain-code';
import { HDR_GAIN, WRITER_VTABLE, ZIGZAG, gainCodes, hdrTables, huffCodes, isoMetadata, quantTable } from '../src/fw/aspect/hdrgain';
import { JPEG_EXECUTE } from '../src/fw/aspect/datestamp';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');

describe('HDR gain map: tables', () => {
  it('quantisers as libjpeg makes them for quality 85, zigzag order a permutation', () => {
    const q = quantTable(85);
    expect(q.slice(0, 8)).toEqual([5, 3, 3, 5, 7, 12, 15, 18]);
    expect(quantTable(50)[0]).toBe(16);
    expect([...ZIGZAG].sort((a, b) => a - b)).toEqual([...Array(64).keys()]);
  });
  it('Huffman codes of the standard luminance tables', () => {
    const t = hdrTables();
    expect(t.dc[0]).toBe(0 | (2 << 16)); // 00
    expect(t.dc[11]).toBe(0x1fe | (9 << 16));
    expect(t.ac[0x00]).toBe(0xa | (4 << 16)); // EOB 1010
    expect(t.ac[0xf0]).toBe(0x7f9 | (11 << 16)); // ZRL
    expect(t.ac[0x01]).toBe(0 | (2 << 16));
    expect(huffCodes([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12)).toEqual(t.dc);
  });
  it('lifts nothing below the highlights, up to the full gain at white, never down', () => {
    const c = gainCodes();
    expect(c[0]).toBe(0);
    expect(c[150]).toBe(0);
    expect(c[255]).toBe(255);
    for (let i = 1; i < 256; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
  });
  it('gain map JPEG header: XMP and ISO 21496-1 metadata, then a one-component baseline frame', () => {
    const t = hdrTables();
    const h = Buffer.from(t.head);
    expect(h.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(h.indexOf('hdrgm:GainMapMax="2"')).toBeGreaterThan(0);
    expect(h.indexOf('urn:iso:std:iso:ts:21496:-1\0')).toBeGreaterThan(0);
    expect(h[t.sof - 5]).toBe(0xff);
    expect(h[t.sof - 4]).toBe(0xc0);
    expect(h.subarray(h.length - 10)).toEqual(Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]));
    expect(isoMetadata(HDR_GAIN.stops).length).toBe(61);
    expect(Buffer.from(t.iso).toString('latin1')).toBe('\xff\xe2\0\x22urn:iso:std:iso:ts:21496:-1\0\0\0\0\0');
    expect(Buffer.from(t.xmpPre).toString('latin1').endsWith('Item:Length="')).toBe(true);
  });
  it('the compiled module is the one of the committed source', () => {
    const src = readFileSync(new URL('../../tools/hdrgain/hdrgain.c', import.meta.url));
    expect(createHash('sha256').update(src).digest('hex')).toBe(HDRGAIN_SOURCE_SHA256);
  });
});

describe.skipIf(!have)('HDR gain map: builds', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;
  const rtosOf = (file: Uint8Array): Uint8Array => {
    const d = new fw.Firmware(file).decoded;
    const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    return d.subarray(r.offset, r.offset + r.size);
  };
  const word = (rtos: Uint8Array, a: number): number => new DataView(rtos.buffer, rtos.byteOffset).getUint32(a - 0x53000000, true);

  it('opens the official file', async () => {
    eng = await Engine.open(raw);
  });
  it('with the date imprint: builds, passes the self-check, reads back, wraps the JPEG step', async () => {
    const b = await eng.buildFirmware([], [], [], { dateStamp: true, hdrGainMap: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features.hdrGainMap).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.hdrGainMap).toBe(true);
    expect(s.dateStamp).toBe(true);
    const rtos = rtosOf(b.file);
    expect(fw.readExtensionFeatures(rtos)).toEqual({ guard: true, dateStamp: true, hdrGainMap: true });
    expect(word(rtos, WRITER_VTABLE + 36)).not.toBe(0x5380bc74);
    expect(word(rtos, WRITER_VTABLE + 40)).not.toBe(0x5380bc6c);
    expect(word(rtos, JPEG_EXECUTE) >>> 24).toBe(0xea);
  });
  it('without it nothing of it is there; earlier records read as before', async () => {
    const b = await eng.buildFirmware([], [], [], { dateStamp: true });
    const rtos = rtosOf(b.file);
    expect(word(rtos, WRITER_VTABLE + 36)).toBe(0x5380bc74);
    expect(word(rtos, WRITER_VTABLE + 40)).toBe(0x5380bc6c);
    expect(fw.readExtensionFeatures(rtos)).toEqual({ guard: true, dateStamp: true });
    expect((await eng.inspect(b.file)).hdrGainMap).toBeUndefined();
  });
  it('on its own and with the other additions that hook the JPEG step', async () => {
    for (const options of [{ hdrGainMap: true }, { hdrGainMap: true, adjSoftFocus: true, dateStamp: true, directFlash: true }]) {
      const b = await eng.buildFirmware([], [], [], options);
      expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
      const s = await eng.inspect(b.file);
      expect(s.verified).toBe(true);
      expect(s.hdrGainMap).toBe(true);
    }
  });
  it('a test build with the diagnostics segment differs from the plain one only in that flag', async () => {
    const a = rtosOf((await eng.buildFirmware([], [], [], { hdrGainMap: true })).file);
    const b = rtosOf((await eng.buildFirmware([], [], [], { hdrGainMap: true, hdrDiag: true })).file);
    expect(a.length).toBe(b.length);
    const diff: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    // the flag word of the context, and the sum word at the end
    expect(diff.length).toBeLessThanOrEqual(8);
    expect(diff.every((i) => i >= a.length - 8 || (a[i] === 0 && b[i] === 1) || Math.abs(i - diff[0]) < 4)).toBe(true);
  });
});
