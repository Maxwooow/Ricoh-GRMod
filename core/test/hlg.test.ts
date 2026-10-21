// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import {
  HDR_FORMATTER1_B,
  HDR_FORMATTER1_MOV,
  HDR_FORMATTER2_B,
  HDR_FORMATTER2_MOV,
  HDR_INTENSE_ASCII_CMP,
  HDR_INTENSE_COUNT_CMP,
  HDR_INTENSE_COUNT_MOV,
  HDR_INTENSE_TABLE_0,
  HDR_INTENSE_TABLE_1,
  HDR_INTENSE_TABLE_2,
  HDR_INTENSE_TABLE_3,
  HDR_INTENSE_TABLE,
  HDR_SCALE_PLAYBACK,
  HDR_SCALE_SHOOTING,
  HLG_CURVE,
  HLG_HOOK,
  HLG_ICC,
  HLG_MATRIX,
  HOOK_SITE,
  STD_MA_DESC_VA,
  TARGET_TONE_ID,
  T_GAM_BASE,
  T_MA_BASE,
  T_REC_BASE,
  romVa,
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

  it('HLG hook code is valid ARM binary and checks toneId 22', () => {
    expect(HLG_HOOK.length).toBe(176);
    const view = new DataView(HLG_HOOK.buffer, HLG_HOOK.byteOffset, HLG_HOOK.byteLength);
    // 0x24: ldrb r1, [r1, #0x79c] (toneId)
    expect(view.getUint32(0x24, true)).toBe(0xe5d1179c);
    // 0x28: cmp r1, #0x16 (toneId == 22)
    expect(view.getUint32(0x28, true)).toBe(0xe3510016);
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

    // Custom HDR scale icon (ID 782) is appended to ICONBIN
    const decoded = new fw.Firmware(b.file).decoded;
    const list = fw.sectionsOf(decoded);
    const rtos = list.find((sec) => sec.name === 'RTOS')!;
    const icon = list.find((sec) => sec.name === 'ICONBIN')!;
    expect(rtos.size).toBeGreaterThan(fw.RTOS_LENGTH);
    expect(icon.size).toBeGreaterThan(fw.ICONBIN_LENGTH);

    // Verify HDR Tone Level 0 UI patches in the generated RTOS image
    const rtosData = decoded.subarray(rtos.offset, rtos.offset + rtos.size);
    const rtosVa = (va: number) => {
      const off = va - 0x53000000;
      return new DataView(rtosData.buffer, rtosData.byteOffset + off, 4).getUint32(0, true);
    };

    expect(rtosVa(HDR_SCALE_SHOOTING)).toBe(0xe300330e); // movw r3, #782 (0x30e)
    expect(rtosVa(HDR_SCALE_PLAYBACK)).toBe(0xe300330e); // movw r3, #782 (0x30e)
    expect(rtosVa(HDR_INTENSE_TABLE_0)).toBe(0x00020100);
    expect(rtosVa(HDR_INTENSE_TABLE_1)).toBe(0x00020100);
    expect(rtosVa(HDR_INTENSE_TABLE_2)).toBe(0x00020100);
    expect(rtosVa(HDR_INTENSE_TABLE_3)).toBe(0x00020100);
    expect(rtosVa(HDR_INTENSE_TABLE)).toBe(0x00020100);
    expect(rtosVa(HDR_INTENSE_COUNT_CMP)).toBe(0xe3500003);
    expect(rtosVa(HDR_INTENSE_COUNT_MOV)).toBe(0x93a00003);
    expect(rtosVa(HDR_INTENSE_ASCII_CMP)).toBe(0x9a00000d);
    expect(rtosVa(HDR_FORMATTER1_MOV)).toBe(0xe1a03002);
    expect(rtosVa(HDR_FORMATTER1_B)).toBe(0xea000004);
    expect(rtosVa(HDR_FORMATTER2_MOV)).toBe(0xe1a03002);
    expect(rtosVa(HDR_FORMATTER2_B)).toBe(0xea000004);

    // Verify APP2 injection hook is branched from HOOK_SITE
    const hookTarget = branchTarget(HOOK_SITE, rtosVa(HOOK_SITE));
    expect(hookTarget).toBeGreaterThan(0x53000000 + fw.RTOS_LENGTH);

    // Verify T_REC[22], T_GAM[22], T_MA[22]
    const recVa = rtosVa(romVa(T_REC_BASE + TARGET_TONE_ID * 4));
    expect(recVa).toBeGreaterThan(0x53000000 + fw.RTOS_LENGTH);
    const gamVa = rtosVa(romVa(T_GAM_BASE + TARGET_TONE_ID * 4));
    expect(gamVa).toBeGreaterThan(0x53000000 + fw.RTOS_LENGTH);
    const maVa = rtosVa(romVa(T_MA_BASE + TARGET_TONE_ID * 4));
    expect(maVa).toBe(STD_MA_DESC_VA);
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
