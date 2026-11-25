// SPDX-License-Identifier: GPL-2.0-only
/**
 * The app's appearance: follow the system, or always light, or always dark.
 *
 * @decision DEC-THEME-001: upstream's dark theme is the `@media (prefers-color-scheme: dark)` blocks of
 * styles.css, which follow the system only. Instead of copying their colours under a class (two copies to
 * keep in step on every merge), the choice is applied to those same rules: each such media rule's condition
 * becomes `all` (Dark) or `not all` (Light), and its own text again for Follow system. Upstream can change or
 * add dark rules and they keep working with the switch; styles.css is not edited.
 * The choice is kept in the page's storage and in the saved project (as the language is, since the desktop
 * page's storage goes with its port), and is applied before the first render.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'grmod.theme';
const DARK = /prefers-color-scheme\s*:\s*dark/;
/** Each dark media rule's own condition, so Follow system can put it back. */
const original = new WeakMap<CSSMediaRule, string>();

export const isThemePref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark';

export function themePref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return isThemePref(v) ? v : 'system'; } catch { return 'system'; }
}

/** The media rules of the page's own style sheets (a sheet of another origin cannot be read and is skipped). */
function mediaRules(sheets: Iterable<CSSStyleSheet>): CSSMediaRule[] {
  const out: CSSMediaRule[] = [];
  const walk = (rules: CSSRuleList): void => {
    for (const r of Array.from(rules)) {
      if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) { out.push(r); walk(r.cssRules); }
    }
  };
  for (const s of sheets) { try { walk(s.cssRules); } catch { /* not readable */ } }
  return out;
}

/** Point every dark rule at the choice; returns how many rules it set (for the tests). */
export function applyTheme(pref: ThemePref = themePref(), sheets: Iterable<CSSStyleSheet> | undefined = typeof document !== 'undefined' ? Array.from(document.styleSheets) : undefined): number {
  if (!sheets) return 0;
  let n = 0;
  for (const r of mediaRules(sheets)) {
    const own = original.get(r) ?? r.media.mediaText;
    if (!DARK.test(own)) continue;
    original.set(r, own);
    const want = pref === 'dark' ? 'all' : pref === 'light' ? 'not all' : own;
    if (r.media.mediaText !== want) r.media.mediaText = want;
    n++;
  }
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = pref;
  return n;
}

/** Keep the choice and show it at once. */
export function setThemePref(v: ThemePref): void {
  try { localStorage.setItem(KEY, v); } catch { /* not kept */ }
  applyTheme(v);
}

/** Apply now, and again once every style sheet has loaded (a sheet added later is read then). */
export function installTheme(): void {
  applyTheme();
  if (typeof window !== 'undefined' && document.readyState !== 'complete') window.addEventListener('load', () => applyTheme(), { once: true });
}
