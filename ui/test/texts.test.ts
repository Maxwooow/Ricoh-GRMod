// SPDX-License-Identifier: GPL-2.0-only
// The interface texts: every language says the same things with the same variables.
import { describe, expect, it } from 'vitest';
import { DICTS } from '../src/i18n';

const vars = (s: string): string[] => [...new Set(s.match(/\{[a-zA-Z0-9]+\}/g) ?? [])].sort();

describe('interface texts', () => {
  const zh = DICTS.zh as Record<string, string>;
  const others = Object.entries(DICTS).filter(([l]) => l !== 'zh') as [string, Record<string, string>][];
  it('every language has the same entries', () => {
    for (const [l, d] of others) expect(Object.keys(d).sort(), l).toEqual(Object.keys(zh).sort());
  });
  it('no entry is empty', () => {
    for (const d of Object.values(DICTS) as Record<string, string>[]) for (const [k, v] of Object.entries(d)) expect(v, k).not.toBe('');
  });
  it('an entry takes the same variables in every language', () => {
    for (const [l, d] of others) {
      const differ = Object.keys(zh).filter((k) => vars(zh[k]).join() !== vars(d[k] ?? '').join());
      expect(differ, l).toEqual([]);
    }
  });
});
