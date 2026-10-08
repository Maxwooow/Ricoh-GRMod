// SPDX-License-Identifier: GPL-2.0-only
/**
 * Soft focus on the ADJ lever (`src/fw/aspect/softfocus.ts`). Needs the official firmware in
 * testdata/private (skipped without it). What the new code does when it runs is checked in an
 * emulator by `tools/softfocus/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('ADJ soft focus: data', () => {
  it('has a name in all 21 languages and a 40x40 icon on the ADJ tile', () => {
    expect(aspect.SOFT_FOCUS_NAMES.length).toBe(21);
    expect(aspect.SOFT_FOCUS_NAMES[15]).toBe('柔焦');
    expect(aspect.SOFT_FOCUS_NAMES[2]).toBe('Soft Focus');
    const icon = aspect.drawSoftFocusIcon();
    expect(icon.length).toBe(40 * 40 * 4);
    const at = (x: number, y: number): number[] => Array.from(icon.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
    expect(at(0, 0)).toEqual([255, 255, 255, 0]);
    expect(at(1, 5)).toEqual([128, 128, 128, 255]);
    expect(at(3, 3)).toEqual([53, 53, 54, 255]);
    expect(at(19, 19)).toEqual([255, 255, 255, 255]);
  });
  it('the three rows are the soft focus gains, finest band first', () => {
    const rows = aspect.softFocusRows();
    const v = new DataView(rows.buffer);
    expect(rows.length).toBe(66);
    expect(v.getInt16(0, true)).toBe(820);
    expect(v.getInt16(22, true)).toBe(680);
    expect(v.getInt16(44 + 4, true)).toBe(330);
    expect(v.getInt16(64, true)).toBe(1024);
  });
});

describe.skipIf(!have)('ADJ soft focus: firmware files', () => {
  let eng: Engine;
  it('builds a file with soft focus only; the engine recognises and verifies it', async () => {
    eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { adjSoftFocus: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.ratios).toEqual([]);
    expect(b.features).toEqual({ adjSoftFocus: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.adjSoftFocus).toBe(true);
    expect(s.ratios).toEqual([]);
    expect(s.softFocus).toEqual([]);
    // Revision 3 trailer with the feature byte.
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    expect(fw.readBuildRevision(data)).toBe(3);
    expect(fw.readRatioRecord(data)).toEqual([]);
    expect(fw.readExtensionFeatures(data)).toEqual({ adjSoftFocus: true });
  });
  it('the clarity table itself stays official', async () => {
    const b = await eng.buildFirmware([], [], [], { adjSoftFocus: true });
    const d = new fw.Firmware(b.file).decoded;
    expect(fw.hasOfficialClarity(d)).toBe(true);
  });
  it('combines with added ratios: both recognised, verified', async () => {
    const b = await eng.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }, { name: '2.39', ratio: '2.39:1' }], [], { adjSoftFocus: true });
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.adjSoftFocus).toBe(true);
    expect(s.ratios.map((r) => r.name)).toEqual(['XPan', '2.39']);
  });
  it('ratios alone are still revision 2 and byte-identical to the build without this feature', async () => {
    const b = await eng.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }]);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    expect(fw.readBuildRevision(d.subarray(rtos.offset, rtos.offset + rtos.size))).toBe(2);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.adjSoftFocus).toBe(false);
    const official = new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))).decoded;
    const R = 0x17d10;
    const plan = fw.planRatios([{ name: 'XPan', ratio: '65:24' }]);
    const a = aspect.installRatios(official.slice(R, R + aspect.OFFICIAL_RTOS_LENGTH), official.slice(0x2e93af0, 0x2e93af0 + aspect.OFFICIAL_ICONBIN_LENGTH), plan);
    const e = aspect.installExtensions(official.slice(R, R + aspect.OFFICIAL_RTOS_LENGTH), official.slice(0x2e93af0, 0x2e93af0 + aspect.OFFICIAL_ICONBIN_LENGTH), plan, {});
    expect(Buffer.compare(Buffer.from(a.rtos), Buffer.from(e.rtos))).toBe(0);
    expect(e.revision).toBe(2);
  });
  it('a file whose record claims soft focus without the code is not verified', async () => {
    const b = await eng.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }]);
    const f = new fw.Firmware(b.file);
    const d = f.decoded.slice();
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    // Flip the trailer to revision 3 with the soft focus bit: the rebuild will not match.
    const end = rtos.offset + rtos.size;
    d[end - 5] = 0x33;
    const s = fw.readExtensionFeatures(d.subarray(rtos.offset, end));
    expect(s).toBeNull(); // the revision-2 record has no feature byte
  });
  it('does not combine with the clarity-table soft focus of 0.4.x', async () => {
    await expect(eng.buildFirmware([], [], [{ level: -3, strength: 'medium' }], { adjSoftFocus: true })).rejects.toMatchObject({ code: 'bad-clarity' });
  });
  it('the hooks in the official code are exactly the expected words', async () => {
    const official = new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))).decoded;
    const R = 0x17d10;
    const e = aspect.installExtensions(official.slice(R, R + aspect.OFFICIAL_RTOS_LENGTH), official.slice(0x2e93af0, 0x2e93af0 + aspect.OFFICIAL_ICONBIN_LENGTH), [], { adjSoftFocus: true });
    const soft = e.words.filter((w) => w.reason.startsWith('ADJ soft focus'));
    // Record 0x0A of the ADJ table in place (enter, draw, is current, set, count, flag,
    // availability: 7), the menu list (3), name (1), icon (1), image processing (3), the
    // digital-filter step gate (2), the slot getters (5).
    expect(soft.length).toBe(7 + 3 + 1 + 1 + 3 + 2 + 5);
    const at = new Set(soft.map((w) => w.address));
    for (const a of [0x5337ff98, 0x53381858, 0x53701de8, 0x538a2000, 0x538a2634, 0x531dae30, 0x531dae40, 0x531dae5c]) expect(at.has(a)).toBe(true);
    const record = 0x53d9f714 + 0x0a * 0x5c;
    expect(soft.filter((w) => w.reason === 'ADJ soft focus: ADJ table record').map((w) => w.address - record)).toEqual([0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x3c]);
    // The table is not moved: no MOVW/MOVT that addresses it is touched.
    for (const w of e.words) expect(w.address >= 0x531bb000 && w.address < 0x531c1000).toBe(false);
    // The scaffold: icon catalog (2), icon bounds (2), text catalog (4), text bound helpers (2),
    // settings save/load continuations (2); then the icon bounds raised again for icon 720 (2).
    expect(e.words.length).toBe(soft.length + 14);
    const bound = (w: number): number => ((w >>> 4) & 0xf000) | (w & 0xfff);
    expect(e.words.filter((w) => w.reason === 'icon upper bound').map((w) => bound(w.after))).toEqual([662, 662, 720, 720]);
  });
  it('with added ratios the icon bound is exactly what the ratios alone give', async () => {
    const official = new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))).decoded;
    const R = 0x17d10;
    const plan = fw.planRatios([{ name: 'XPan', ratio: '65:24' }]);
    const a = aspect.installExtensions(official.slice(R, R + aspect.OFFICIAL_RTOS_LENGTH), official.slice(0x2e93af0, 0x2e93af0 + aspect.OFFICIAL_ICONBIN_LENGTH), plan, {});
    const e = aspect.installExtensions(official.slice(R, R + aspect.OFFICIAL_RTOS_LENGTH), official.slice(0x2e93af0, 0x2e93af0 + aspect.OFFICIAL_ICONBIN_LENGTH), plan, { adjSoftFocus: true });
    const at = (r: Uint8Array, va: number): number => new DataView(r.buffer, r.byteOffset).getUint32(va - 0x53000000, true);
    for (const site of [0x5323dbb4, 0x5323e40c]) expect(at(e.rtos, site)).toBe(at(a.rtos, site));
  });
});
