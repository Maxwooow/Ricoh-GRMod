import { describe, expect, it } from 'vitest';
import { decodeHalation, encodeHalation, HALATION_STATES, halationLevelOf, halationTables } from '../src/fw/aspect/halation-ui';

describe('halation setting in the Toning byte', () => {
  it('keeps the meaning of 0, 1, 2 (off, weak red, strong red: tests 036..042 and 0.8.1)', () => {
    expect(decodeHalation(0)).toEqual({ on: false, strength: 0, white: false });
    expect(decodeHalation(1)).toEqual({ on: true, strength: 0, white: false });
    expect(decodeHalation(2)).toEqual({ on: true, strength: 2, white: false });
    expect([0, 1, 2].map((v) => halationLevelOf(v))).toEqual([{ level: 0, white: false }, { level: 1, white: false }, { level: 3, white: false }]);
  });

  it('has every setting once: on / off x three strengths x two colours, off remembering the rest', () => {
    expect(HALATION_STATES.length).toBe(12);
    const keys = new Set(HALATION_STATES.map((s) => `${s.on}${s.strength}${s.white}`));
    expect(keys.size).toBe(12);
    for (let v = 0; v < 12; v++) expect(encodeHalation(decodeHalation(v))).toBe(v);
    // switching off and on again keeps strength and colour
    for (let v = 0; v < 12; v++) {
      const s = decodeHalation(v);
      const off = encodeHalation({ ...s, on: false });
      expect(decodeHalation(encodeHalation({ ...decodeHalation(off), on: true }))).toEqual({ ...s, on: true });
    }
  });

  it('anything else reads as off', () => {
    for (const v of [12, 13, 200, 255, -1, 1.5]) expect(decodeHalation(v)).toEqual(HALATION_STATES[0]);
  });

  it('levels and colours for the JPEG step: Weak 1, Medium 2, Strong 3; white only when on', () => {
    const got = HALATION_STATES.map((_, v) => halationLevelOf(v));
    expect(got).toEqual([
      { level: 0, white: false }, { level: 1, white: false }, { level: 3, white: false }, { level: 2, white: false },
      { level: 1, white: true }, { level: 2, white: true }, { level: 3, white: true },
      { level: 0, white: false }, { level: 0, white: false }, { level: 0, white: true }, { level: 0, white: true }, { level: 0, white: true },
    ]);
  });

  it('tables for the firmware: bits on | strength << 1 | white << 3 and back', () => {
    const { dec, enc } = halationTables();
    HALATION_STATES.forEach((s, v) => {
      expect(dec[v]).toBe((s.on ? 1 : 0) | (s.strength << 1) | (s.white ? 8 : 0));
      expect(enc[dec[v]]).toBe(v);
    });
  });
});
