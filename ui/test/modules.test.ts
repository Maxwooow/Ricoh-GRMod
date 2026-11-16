// SPDX-License-Identifier: GPL-2.0-only
// Every part of the store and every page loads: the parts import one another, and a part that used
// another at load time (instead of inside a function) would fail here rather than in the app.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/engine', () => ({ engine: {}, EngineError: class extends Error {} }));
vi.mock('../src/host', () => ({ host: { available: false }, HostError: class extends Error {}, sha256Hex: async () => '', isAndroid: false, isIOS: false, isMobile: false }));
vi.mock('../src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn(), applySlot: vi.fn() }));

const STORE = import.meta.glob('../src/store/*.ts');
const PAGES = import.meta.glob('../src/pages/*.{ts,tsx}');

describe('modules load', () => {
  it('there are parts to load', () => {
    expect(Object.keys(STORE).length).toBeGreaterThan(5);
    expect(Object.keys(PAGES).length).toBeGreaterThan(5);
  });
  // Each part first, on its own: whichever the app happens to load first must work.
  for (const [path, load] of [...Object.entries(STORE), ...Object.entries(PAGES)]) it(path.replace('../src/', ''), async () => {
    vi.resetModules();
    expect(Object.keys((await load()) as object).length).toBeGreaterThan(0);
  });
  it('the store as a whole has every name of its parts, none twice', async () => {
    vi.resetModules();
    const all = await import('../src/store');
    let n = 0;
    for (const load of Object.values(STORE)) for (const k of Object.keys((await load()) as object)) { expect(all, k).toHaveProperty(k); n++; }
    expect(Object.keys(all).length).toBe(n);
  });
  it('the pages app.tsx shows', async () => {
    const pages = await import('../src/pages');
    for (const k of ['ImageControlPage', 'RatioPage', 'WallpaperPage', 'CropEditor']) expect(typeof (pages as Record<string, unknown>)[k]).toBe('function');
  });
});
