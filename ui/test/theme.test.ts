// SPDX-License-Identifier: GPL-2.0-only
// The appearance choice (theme.ts, DEC-THEME-001): upstream's dark rules are switched on, off, or
// back to following the system, and nothing else is touched. Plain Node: the style sheet objects are stand-ins.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

class FakeMediaRule { media: { mediaText: string }; cssRules: unknown[]; constructor(text: string, inner: unknown[] = []) { this.media = { mediaText: text }; this.cssRules = inner; } }
(globalThis as Record<string, unknown>).CSSMediaRule = FakeMediaRule;
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
const { applyTheme, isThemePref, themePref } = await import('../src/theme');

// Every dark block of the real styles.css, as rules (their conditions as written), plus two that are not dark.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const darkConditions = [...css.matchAll(/@media\s*([^{]*prefers-color-scheme\s*:\s*dark[^{]*)\{/g)].map((m) => m[1].trim());
const sheetOf = () => {
  const dark = darkConditions.map((c) => new FakeMediaRule(c));
  const other = [new FakeMediaRule('(max-width: 720px)'), new FakeMediaRule('(prefers-reduced-motion: reduce)')];
  return { dark, other, sheets: [{ cssRules: [...dark, ...other] }] as unknown as CSSStyleSheet[] };
};

describe('appearance', () => {
  beforeEach(() => store.clear());
  it('styles.css has dark rules to switch', () => {
    expect(darkConditions.length).toBeGreaterThanOrEqual(5);
  });
  it('Dark turns every dark rule on, Light turns them off, Follow system puts back their own condition', () => {
    const { dark, other, sheets } = sheetOf();
    expect(applyTheme('dark', sheets)).toBe(dark.length);
    expect(dark.every((r) => r.media.mediaText === 'all')).toBe(true);
    applyTheme('light', sheets);
    expect(dark.every((r) => r.media.mediaText === 'not all')).toBe(true);
    applyTheme('system', sheets);
    expect(dark.map((r) => r.media.mediaText)).toEqual(darkConditions);
    expect(other.map((r) => r.media.mediaText)).toEqual(['(max-width: 720px)', '(prefers-reduced-motion: reduce)']);
  });
  it('a rule inside another media rule is switched too', () => {
    const inner = new FakeMediaRule('(prefers-color-scheme: dark)');
    const sheets = [{ cssRules: [new FakeMediaRule('screen', [inner])] }] as unknown as CSSStyleSheet[];
    expect(applyTheme('dark', sheets)).toBe(1);
    expect(inner.media.mediaText).toBe('all');
  });
  it('a sheet that cannot be read is skipped', () => {
    const sheets = [{ get cssRules() { throw new Error('cross-origin'); } }] as unknown as CSSStyleSheet[];
    expect(applyTheme('dark', sheets)).toBe(0);
  });
  it('the kept choice defaults to Follow system and ignores anything else', () => {
    expect(themePref()).toBe('system');
    store.set('grmod.theme', 'dark'); expect(themePref()).toBe('dark');
    store.set('grmod.theme', 'purple'); expect(themePref()).toBe('system');
    expect([isThemePref('light'), isThemePref('auto'), isThemePref(undefined)]).toEqual([true, false, false]);
  });
});
