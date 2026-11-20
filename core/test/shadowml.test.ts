// SPDX-License-Identifier: GPL-2.0-only
/**
 * The learned Auto for Shadow Correction (`aspect/shadowml.ts`, GR IV 1.11, the 1.20 port and 1.21 through its address table).
 * Needs testdata/private/official.bin (1.11), GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and
 * GRMOD_GR4_121_FIRMWARE (or testdata/private/official121.bin).
 * The module itself is checked by tools/shadowml (test_host.py, test_arm.py, test_fw.py on a built RTOS).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
// hook: ldr r2,[fp,#-0x450] after the Y-array builder; gain: Auto's entry of the gain table (TB[4]).
const files = [
  { version: '1.11', path: P + 'official.bin', hook: 0x5391f3a4, gain: 0x5404938c, zeroFill: 0x53000460, heap: 0x55837300 },
  { version: '1.20', path: process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin', hook: 0x539473a4, gain: 0x54080044, zeroFill: 0x53000460, heap: 0x55839040 },
  { version: '1.21', path: process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin', hook: 0x5394896c, gain: 0x54081834, zeroFill: 0x53000460, heap: 0x55839040 },
];
function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const recordStart = (v: Uint8Array) => v.length - 16 - new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(v.length - 16, true);

for (const f of files) describe.skipIf(!existsSync(f.path))(`learned shadow correction ${f.version}`, () => {
  const raw = existsSync(f.path) ? new Uint8Array(readFileSync(f.path)) : new Uint8Array();
  for (const options of [{}, { dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced' as const }]) {
    it(`${Object.keys(options).length ? 'with the other additions' : 'alone'}: one hook, Auto's gain, appended last; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.shadowLearn).toBe(true);
      const plain = Object.keys(options).length ? await e.buildFirmware([], [], [], options) : null;
      const on = await e.buildFirmware([], [], [], { ...options, shadowLearn: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const b = rtos(on.file), a = rtos(new Uint8Array(raw));
      expect(word(a, f.hook)).toBe(0xe51b2450);
      expect(word(a, f.gain)).toBe(0x100);
      expect(word(b, f.gain)).toBe(0x400);
      expect(word(b, f.zeroFill)).toBe(f.heap);
      const w = word(b, f.hook);
      expect(w >>> 24).toBe(0xea);
      const stub = branchTarget(f.hook, w);
      expect(stub - 0x53000000).toBeGreaterThanOrEqual(a.length);
      if (plain) {
        // Everything the other additions build stays where it was: the shadow correction is appended after them.
        // Images are padded to whole container frames: what is added lands in the zero padding after the
        // other additions (and in a further frame when it does not fit).
        const p = rtos(plain.file);
        expect(b.length).toBeGreaterThanOrEqual(p.length);
        const end = recordStart(p);
        const allowed = new Set([f.hook, f.gain, f.zeroFill]);
        let first = end;
        for (let i = 0; i < end; i += 4) {
          const at = 0x53000000 + i;
          if (word(p, at) === word(b, at) || allowed.has(at)) continue;
          expect(word(p, at)).toBe(0);
          first = Math.min(first, i);
        }
        for (let i = first; i < recordStart(p); i += 4) expect(word(p, 0x53000000 + i)).toBe(0);
        expect(stub - 0x53000000).toBeGreaterThan(first);
      }
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.shadowLearn).toBe(true);
      if (Object.keys(options).length) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced' });
    }, 120000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, shadowLearn: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).shadowLearn).toBeUndefined();
  }, 60000);
  it('refuses a non-boolean switch and the diagnostics builds that use its RAM words', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { shadowLearn: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(e.buildFirmware([], [], [], { shadowLearn: true, hdrGainMap: true, hdrDiag: true })).rejects.toThrow();
  }, 60000);
});

describe('learned shadow correction: the 1.21 program', () => {
  it('loads: the module looks its addresses up only when installed', async () => {
    const m = await import('../src/fw/gr4v121');
    expect(typeof m.buildFirmware).toBe('function');
  });
});
