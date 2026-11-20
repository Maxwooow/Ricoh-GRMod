// SPDX-License-Identifier: GPL-2.0-only
// The interface texts: both languages say the same things with the same variables.
import { describe, expect, it } from 'vitest';
import { usermode } from '@grmod/core';
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
  it('user mode recipes: every setting, question, answer and reason has a text', () => {
    const keys = [
      ...usermode.RECIPE_SETTINGS.map((x) => `rcp_${x.id}`),
      ...usermode.WHY_CODES.map((c) => `why_${c}`),
      ...([['qPlace', usermode.PLACES], ['qLight', usermode.LIGHTS], ['qSubject', usermode.SUBJECTS], ['qLook', usermode.LOOKS], ['qFile', usermode.FILES]] as const)
        .flatMap(([q, vs]) => [q, ...vs.map((v) => `${q}_${v}`)]),
    ];
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });
});
