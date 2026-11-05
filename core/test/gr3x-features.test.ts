// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sha256Hex, sectionsOf, buildGrown, FRAME_SIZE, sum32 } from '../src/fw/container';
import { GR3X_CLARITY_OFFSET, gr3xClarityBytes } from '../src/fw/gr3x/clarity';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { readClarity, SOFT_FOCUS_GAINS, OFFICIAL_CLARITY } from '../src/fw/clarity';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';
import { planFirmwareCard } from '../src/card';

const input = process.env.GRMOD_GR3X_FIRMWARE;
const soft = [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }] as const;
const ratios = GFX_RATIOS.filter(r => r !== '3:2' && r !== '1:1').map(r => ({ name: r, ratio: r }));

describe.skipIf(!input)('IIIx additional features from the verified original', () => {
  let raw: Uint8Array; let engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('keeps the hardware-tested T4 exact when optional features are off', async () => {
    // Without the settings guard (every build since round 7 has it, on GR IIIx as on GR III): T4 itself.
    const result = await engine.buildFirmware([], ratios, [], { guard: false });
    expect(result.sha256).toBe('799304fa1866352e68041aa430deed027cece2e64a26ac6b54dd69931c77d004');
    expect((await engine.buildFirmware([], ratios)).sha256).not.toBe(result.sha256);
  });
  it('changes only the selected gain rows plus the release record/checksum relative to T4', async () => {
    const base = await buildGr3xTestFirmware(raw);
    const next = await buildGr3xTestFirmware(raw, soft);
    const a = new Firmware(base.bytes).decoded, b = new Firmware(next.bytes).decoded;
    const rtos = sectionsOf(a).find(s => s.name === 'RTOS')!;
    expect(b.length).toBe(a.length);
    const gains = readClarity(b, GR3X_CLARITY_OFFSET);
    for (let row = 0; row < 9; row++) {
      const edit = soft.find(s => s.level + 4 === row);
      expect(gains[row]).toEqual(edit ? SOFT_FOCUS_GAINS[edit.strength] : OFFICIAL_CLARITY[row]);
    }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
      expect((i >= GR3X_CLARITY_OFFSET && i < GR3X_CLARITY_OFFSET + 198) ||
        (i >= rtos.offset + rtos.size - 64 && i < rtos.offset + rtos.size), `unexpected difference at ${i.toString(16)}`).toBe(true);
    }
    expect(next.manifest).toEqual(base.manifest); // Includes all live-view / RAW hooks and appended code.
    expect(Object.values(next.report.checks).every(Boolean)).toBe(true);
    expect(await engine.inspect(next.bytes)).toMatchObject({ verified: true, adjSoftFocus: false,
      softFocus: [...soft].reverse() });
    const official = new Firmware(raw).decoded;
    expect(() => gr3xClarityBytes(official, [{ level: 0, strength: 'weak' }] as never)).toThrow('bad-clarity');
    expect(() => gr3xClarityBytes(official, [...soft, soft[0]])).toThrow('edited twice');
  });
  it('rejects an unrecognized gain edit even in a repaired and otherwise valid container', async () => {
    const built = await buildGr3xTestFirmware(raw, soft);
    const d = new Firmware(built.bytes).decoded.slice();
    const rtos = sectionsOf(d).find(s => s.name === 'RTOS')!;
    d[GR3X_CLARITY_OFFSET + 3 * 22] ^= 1;
    const comp = rtos.offset + rtos.size - 4;
    const view = new DataView(d.buffer); view.setUint32(comp, 0, true); view.setUint32(comp, (-sum32(d)) >>> 0, true);
    const fw = new Firmware(raw), sections = sectionsOf(fw.decoded);
    const insertions = ['RTOS','ICONBIN'].map(name => {
      const old = sections.find(s => s.name === name)!, next = sectionsOf(d).find(s => s.name === name)!;
      return { at: old.offset + old.size, length: next.size - old.size };
    });
    expect(insertions.every(i => i.length % FRAME_SIZE === 0)).toBe(true);
    const changed = buildGrown(fw, d, insertions).out;
    expect(await engine.inspect(changed)).toMatchObject({ kind: 'unknown', verified: false });
  });
  it('refuses power-off images and start-up scripts (dropped with GR Mod 0.8)', () => {
    const preview = new Uint8Array(720 * 480 * 3);
    expect(() => engine.encodeShutdownImage(preview, 'GR3X_HDF')).toThrow('power-off images is not ported');
    expect(() => engine.rotationScript('GR3X_HDF', 1)).toThrow('startup scripts is not ported');
  });
  it('parks interfering firmware files of either family without touching photos', () => {
    const listing = { root: ['FWDC243B.BIN','FWDC248B.BIN','FWDC239B.BIN','00078560.636','00078490.609','DEVELOP.MOD','DCIM'].map(name => ({ name, dir: name === 'DCIM', size: 10 })),
      script: [{ name: 'startup.ttl', dir: false, size: 10 }] };
    for (const name of ['fwdc243b.bin', 'fwdc239b.bin'] as const) {
      const plan = planFirmwareCard(listing, raw, 'test', name);
      expect(plan.some(s => JSON.stringify(s.op === 'move' ? s.from : s.path).includes('DCIM'))).toBe(false);
      const moved = plan.filter(s => s.op === 'move').map(s => s.from[0]);
      expect(new Set(moved).size).toBe(moved.length);
      expect(moved).toContain('00078490.609');
      // every other camera's update file is moved aside; the written one replaces its own name
      for (const other of ['FWDC243B.BIN', 'FWDC248B.BIN', 'FWDC239B.BIN'].filter(n => n.toLowerCase() !== name)) expect(moved).toContain(other);
      expect(plan.some(s => s.op === 'write' && s.path.join('/') === name)).toBe(true);
    }
  });
});
