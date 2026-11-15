// SPDX-License-Identifier: GPL-2.0-only
// The guides' state in the real UI store, with an in-memory host (as gr3x-ui.test.mjs): skipping a
// replayed guide ends it alone, "Skip guides" on one that started by itself marks every guide seen,
// and "Start all guides again" brings them back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  host: { available: false, info: { token: 'test', kind: 'test' }, storeGet: vi.fn(), storeSet: vi.fn(), join: (...p) => p.join('/') },
}));
vi.mock('../../ui/src/engine', () => ({ engine: {}, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

let store;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('document', { hidden: true });
  store = await import('../../ui/src/store');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('guides', () => {
  it('Skip on a replayed guide ends that guide only', () => {
    store.startTour('ic', [0, 1, 2], true);
    store.endTour();
    expect(store.getState().tour).toBeUndefined();
    expect(store.getState().toursSeen).toEqual(['ic']);
  });

  it('Skip guides on a guide that started by itself marks every guide seen; Start all guides again undoes it', () => {
    store.startTour('overview', [0, 1, 2], false);
    store.tourStep(1);
    store.skipTours();
    expect(store.getState().tour).toBeUndefined();
    expect([...store.getState().toursSeen].sort()).toEqual([...store.TOUR_IDS].sort());
    store.resetTours();
    expect(store.getState().toursSeen).toEqual([]);
  });
});
