// SPDX-License-Identifier: GPL-2.0-only
// The interface texts: both languages say the same things with the same variables.
import { describe, expect, it } from 'vitest';
import { DICTS } from '../src/i18n';

const vars = (s: string): string[] => [...new Set(s.match(/\{[a-zA-Z0-9]+\}/g) ?? [])].sort();

describe('interface texts', () => {
  const zh = DICTS.zh as Record<string, string>, en = DICTS.en as Record<string, string>;
  it('the two languages have the same entries', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it('no entry is empty', () => {
    for (const d of [zh, en]) for (const [k, v] of Object.entries(d)) expect(v, k).not.toBe('');
  });
  it('an entry takes the same variables in both languages', () => {
    const differ = Object.keys(zh).filter((k) => vars(zh[k]).join() !== vars(en[k] ?? '').join());
    expect(differ).toEqual([]);
  });
});
