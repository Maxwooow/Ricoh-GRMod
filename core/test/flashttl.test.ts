// SPDX-License-Identifier: GPL-2.0-only
/**
 * Pre-flash (TTL) metering for a GF-2 class flash (`gr4v120/aspect/flttl.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * The module and the stubs are checked by tools/gr4v120/flash/ttl (host_test.c: the module against a
 * floating-point version; test_arm.py: the stubs and the module inside a built RTOS).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';
import { FLTTL_CODE, FLTTL_CODE_LENGTH } from '../src/fw/gr4v120/aspect/flttl-code';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

// Per release: the six hooked calls (live view AE, pre-emission, free-live-view step, status store, X, output level) and
// their targets; the natives of the context (alloc, timer holder, tick, elapsed, flash holder, AE holder, settings holder, flash mode).
const releases: { version: string; path: string; SITES: [number, number][]; NATIVES: number[] }[] = [
  { version: '1.20', path: file120, SITES: [[0x5368b3d0, 0x536918c0], [0x53797070, 0x537964f8], [0x5368774c, 0x53684ca4], [0x53a9b70c, 0x537986e0], [0x536a5198, 0x5369ceb8], [0x536a562c, 0x536a3a04]],
    NATIVES: [0x539084bc, 0x53919d68, 0x5391ca64, 0x5391ca74, 0x53797a30, 0x536ac0b8, 0x53750008, 0x5377ccc4] },
  { version: '1.21', path: file121, SITES: [[0x5368bd10, 0x53692200], [0x53797d00, 0x53797188], [0x5368808c, 0x536855e4], [0x53a9ccd4, 0x53799370], [0x536a5ad8, 0x5369d7f8], [0x536a5f6c, 0x536a4344]],
    NATIVES: [0x53909154, 0x5391aaa0, 0x5391d79c, 0x5391d7ac, 0x537986c0, 0x536ac9f8, 0x53750a58, 0x5377d954] },
];
const MAGIC = 0x4c54464c, SLOT = 0x55839018, ZERO_FILL_END = 0x53000460;

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const recordStart = (v: Uint8Array) => v.length - 16 - new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(v.length - 16, true);
const findWord = (b: Uint8Array, v: number) => { for (let i = 0; i + 4 <= b.length; i += 4) if (word(b, 0x53000000 + i) === v) return 0x53000000 + i; return -1; };
const rgb = (v: number) => new Uint8Array(720 * 480 * 3).fill(v);

for (const { version, path, SITES, NATIVES } of releases) describe.skipIf(!existsSync(path))(`flash TTL ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const module = Uint8Array.from(Buffer.from(FLTTL_CODE, 'base64'));
  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['alone', () => ({})],
    ['with the other additions and power-off pictures', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced',
      shutdownPictures: [{ id: 0x2001, name: 'Test', jpeg: e.encodeMenuPicture(rgb(90)) }] } as BuildOptions)],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: six calls go to stubs appended last, the module and its context; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.flashTtl).toBe(true);
      const o = options(e);
      const plain = Object.keys(o).length ? await e.buildFirmware([], [], [], o) : null;
      const on = await e.buildFirmware([], [], [], { ...o, flashTtl: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const a = rtos(new Uint8Array(raw)), b = rtos(on.file);
      for (const [at, to] of SITES) {
        expect(word(a, at) >>> 24).toBe(0xeb);
        expect(branchTarget(at, word(a, at))).toBe(to);
        expect(word(b, at) >>> 24).toBe(0xeb);
        expect(branchTarget(at, word(b, at)) - 0x53000000).toBeGreaterThanOrEqual(a.length);
      }
      expect(word(b, ZERO_FILL_END)).toBe(0x55839040);
      // The context: magic, the state pointer's word, the natives; word 7 (file service) is a stub returning 0.
      const ctx = findWord(b, MAGIC);
      expect(ctx - 0x53000000).toBeGreaterThanOrEqual(a.length);
      expect(word(b, ctx + 4)).toBe(SLOT);
      expect([2, 3, 4, 5, 6, 8, 9, 10].map((k) => word(b, ctx + 4 * k))).toEqual(NATIVES);
      const noFiles = word(b, ctx + 28);
      expect([word(b, noFiles), word(b, noFiles + 4)]).toEqual([0xe3a00000, 0xe12fff1e]); // mov r0,#0; bx lr
      const code = ctx + 0x30;
      expect(module.length).toBe(FLTTL_CODE_LENGTH);
      expect(Buffer.from(b.slice(code - 0x53000000, code - 0x53000000 + module.length)).equals(Buffer.from(module))).toBe(true);
      if (plain) {
        // Everything the other additions build stays where it was: flash TTL is appended after them.
        const p = rtos(plain.file);
        const end = recordStart(p);
        // ... and the two red-eye Flash Modes' names (texts 135 and 137, "(TTL)" added: viewmenu.ts), each language row.
        const catalog = version === '1.20' ? 0x5440da00 : 0x5440f200;
        const names = Array.from({ length: 21 }, (_, l) => [135, 137].map((id) => word(p, catalog + 4 * l) + 4 * id)).flat();
        const own = new Set([...SITES.map(([at]) => at), ...names]);
        let first = end;
        for (let i = 0; i < end; i += 4) {
          const at = 0x53000000 + i;
          if (word(p, at) === word(b, at) || own.has(at)) continue;
          expect(word(p, at)).toBe(0);
          first = Math.min(first, i);
        }
        for (let i = first; i < end; i += 4) expect(word(p, 0x53000000 + i)).toBe(0);
        expect(ctx - 0x53000000).toBeGreaterThanOrEqual(first);
      }
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.flashTtl).toBe(true);
      if (plain) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced', exposurePreview: true });
    }, 120000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, flashTtl: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).flashTtl).toBeUndefined();
  }, 60000);
  it('refuses a non-boolean switch, and the HDR test counters (same RAM word)', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { flashTtl: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(e.buildFirmware([], [], [], { hdrGainMap: true, hdrDiag: true, flashTtl: true } as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('flash TTL: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.flashTtl).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, flashTtl: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
  it('the 1.21 program loads: flash TTL looks its addresses up only when installed', async () => {
    const m = await import('../src/fw/gr4v121');
    expect(typeof m.buildFirmware).toBe('function');
  });
});
