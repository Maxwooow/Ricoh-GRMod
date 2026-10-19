// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import {
  HDR_INTENSE_ASCII_CMP,
  HDR_INTENSE_COUNT_CMP,
  HDR_INTENSE_COUNT_MOV,
  HDR_INTENSE_TABLE,
  HLG_CURVE,
  HLG_HOOK,
  HLG_ICC,
  HLG_MATRIX,
  ISP_HOOK_SITE,
} from '../src/fw/aspect/hlg';
import { branchTarget } from '../src/fw/aspect/arm';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const have = existsSync(P + 'official.bin');

describe('HLG HDR photo assets & calibration data', () => {
  it('HLG matrix is valid Q13 with unity row sums', () => {
    expect(HLG_MATRIX.length).toBe(18);
    const m = new Int16Array(HLG_MATRIX.buffer, HLG_MATRIX.byteOffset, 9);
    for (let r = 0; r < 3; r++) {
      const sum = m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2];
      expect(sum).toBe(8192); // exactly 1.0 in Q13
    }
  });

  it('HLG tone curve is 256-point 14-bit monotonic ARIB STD-B67 curve', () => {
    expect(HLG_CURVE.length).toBe(512);
    const c = new Uint16Array(HLG_CURVE.buffer, HLG_CURVE.byteOffset, 256);
    expect(c[0]).toBe(0);
    expect(c[255]).toBe(16214); // 14-bit pre-compensated highlight ceiling
    for (let i = 1; i < 256; i++) {
      expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    }
  });

  it('HLG ICC profile contains valid acsp signature and CICP tags', () => {
    expect(HLG_ICC.length).toBe(532);
    const text = new TextDecoder('latin1').decode(HLG_ICC);
    expect(text.includes('acsp')).toBe(true);
    expect(text.includes('cicp')).toBe(true);
  });

  it('HLG hook code is valid ARM binary and includes level 0 check', () => {
    expect(HLG_HOOK.length).toBe(176);
    const view = new DataView(HLG_HOOK.buffer, HLG_HOOK.byteOffset, HLG_HOOK.byteLength);
    // 0x24: ldrb r2, [r1, #0x79c] (toneId)
    expect(view.getUint32(0x24, true)).toBe(0xe5d1279c);
    // 0x28: cmp r2, #0x16
    expect(view.getUint32(0x28, true)).toBe(0xe3520016);
    // 0x30: ldrb r2, [r1, #0x7b8] (hdrToneLevel)
    expect(view.getUint32(0x30, true)).toBe(0xe5d127b8);
    // 0x34: cmp r2, #0
    expect(view.getUint32(0x34, true)).toBe(0xe3520000);
  });
});

describe.skipIf(!have)('HLG HDR photo firmware build & inspection', () => {
  const raw = have ? new Uint8Array(readFileSync(P + 'official.bin')) : new Uint8Array();
  let eng: Engine;

  it('opens official firmware', async () => {
    eng = await Engine.open(raw);
  });

  it('builds HLG photo standalone and passes self-check', async () => {
    const b = await eng.buildFirmware([], [], [], { hlgPhoto: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);

    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.hlgPhoto).toBe(true);
    expect(s.adjSoftFocus).toBe(false);
    expect(s.dateStamp).toBe(false);
    expect(s.monoUnlock).toBe(false);

    // Slot 22 uses factory icon, so ICONBIN should not grow
    const decoded = new fw.Firmware(b.file).decoded;
    const list = fw.sectionsOf(decoded);
    const rtos = list.find((sec) => sec.name === 'RTOS')!;
    const icon = list.find((sec) => sec.name === 'ICONBIN')!;
    expect(rtos.size).toBeGreaterThan(fw.RTOS_LENGTH);
    expect(icon.size).toBe(fw.ICONBIN_LENGTH);

    // Verify HDR Tone Level 0 patches and ISP dispatch hook in the generated RTOS image
    const rtosData = decoded.subarray(rtos.offset, rtos.offset + rtos.size);
    const rtosVa = (va: number) => {
      const off = va - 0x53000000;
      return new DataView(rtosData.buffer, rtosData.byteOffset + off, 4).getUint32(0, true);
    };

    expect(rtosVa(HDR_INTENSE_TABLE)).toBe(0x03020100);
    expect(rtosVa(HDR_INTENSE_COUNT_CMP)).toBe(0xe3500004);
    expect(rtosVa(HDR_INTENSE_COUNT_MOV)).toBe(0x93a00004);
    expect(rtosVa(HDR_INTENSE_ASCII_CMP)).toBe(0x9a00000d);

    const ispHookTarget = branchTarget(ISP_HOOK_SITE, rtosVa(ISP_HOOK_SITE));
    expect(ispHookTarget).toBeGreaterThan(0x53000000 + fw.RTOS_LENGTH);
    expect(rtosVa(ispHookTarget)).toBe(0xe51ba034); // ldr sl, [fp, #-0x34]
    expect(rtosVa(ispHookTarget + 4)).toBe(0xe35a0016); // cmp sl, #22
    expect(rtosVa(ispHookTarget + 8)).toBe(0x1a000003); // bne .not_hdr
    expect(rtosVa(ispHookTarget + 12)).toBe(0xe5d717b8); // ldrb r1, [r7, #0x7b8]
    expect(rtosVa(ispHookTarget + 16)).toBe(0xe3510000); // cmp r1, #0
    expect(rtosVa(ispHookTarget + 20)).toBe(0x03a0a000); // moveq sl, #0
    expect(rtosVa(ispHookTarget + 24)).toBe(0x050ba034); // streq sl, [fp, #-0x34]
    expect(branchTarget(ispHookTarget + 28, rtosVa(ispHookTarget + 28))).toBe(0x53912d40);
  });

  it('builds HLG photo combined with custom ratios, soft focus, date stamp, and mono unlock', async () => {
    const b = await eng.buildFirmware(
      [],
      [{ name: '65:24', ratio: '65:24' }],
      [],
      { adjSoftFocus: true, dateStamp: true, monoUnlock: true, hlgPhoto: true }
    );
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);

    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.hlgPhoto).toBe(true);
    expect(s.adjSoftFocus).toBe(true);
    expect(s.dateStamp).toBe(true);
    expect(s.monoUnlock).toBe(true);
    expect(s.ratios.length).toBe(1);
    expect(s.ratios[0].name).toBe('65:24');
  });
});
