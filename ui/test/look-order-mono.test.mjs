// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs)
// The Image Control menu order and the Monochrome's black-and-white looks (25..30), on the real UI store with an in-memory host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map(),
  engine: { open: vi.fn(), reset: vi.fn(), ratio: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: true, info: { token: 't', kind: 'test', version: '9.9.9', os: 'linux' }, sep: '/', join: (...p) => p.join('/'),
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), volumes: vi.fn(), sidecar: vi.fn(),
  },
}));
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'h', isAndroid: false, isMobile: false }));
vi.mock('../src/pixels', () => ({
  ensureIconFont: vi.fn(),
  loadBitmap: vi.fn(async () => ({ close: () => {} })),
  workingCopy: vi.fn(async () => ({ blob: new Blob(['x']), width: 8, height: 8 })),
  defaultCrop: (w, h) => ({ x: 0, y: 0, w, h }),
  cropToRgb: vi.fn(),
}));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn() }));

const enc = (s) => new TextEncoder().encode(s);
const MONO = ['f25', 'f26', 'f27', 'f28', 'f29', 'f30'];
let store, i18n;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.files.clear();
  mocks.host.available = true;
  mocks.host.storeGet.mockImplementation(async (k) => mocks.files.get(k) ?? null);
  mocks.host.storeSet.mockImplementation(async (k, d) => { mocks.files.set(k, typeof d === 'string' ? enc(d) : d); });
  mocks.host.storeDel.mockImplementation(async (k) => { mocks.files.delete(k); });
  mocks.host.storeList.mockImplementation(async () => [...mocks.files].map(([key, v]) => ({ key, size: v.length })));
  mocks.host.volumes.mockResolvedValue([]); mocks.host.sidecar.mockResolvedValue(null);
  mocks.engine.heartbeat.mockResolvedValue(true);
  mocks.engine.ratio.mockImplementation(async (ratio) => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  vi.stubGlobal('document', { hidden: true });
  vi.stubGlobal('fetch', async () => { throw new Error('offline'); }); // init() loads the sample photo
  store = await import('../src/store');
  i18n = await import('../src/i18n');
  await store.init();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}, 60000);
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = () => vi.advanceTimersByTimeAsync(1);
const lastToast = () => store.getState().toasts.at(-1);
/** Press the Undo button of the newest toast, as a user would. */
const pressUndo = () => lastToast().action.run();
const addSlots = (n) => { for (let i = 0; i < n; i++) store.addExtraSlot(); return store.getState().extras.map((x) => x.key); };

/** A GR IV 1.21 colour camera as the order needs it: the looks of the firmware, the B&W unlock offered. */
const colourCamera = (monoUnlock) => store.set({ model: 'HDF', monoUnlock, info: { family: 'gr4', features: { monoUnlock: true }, looks: { factory: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32], monoOnly: [25, 26, 27, 28, 29, 30], extraFirst: 34 }, slots: [], capabilities: { lookLayout: true } } });

describe('menu order and the black-and-white looks', () => {
  it('lists them only with the B&W unlock (or on the Monochrome)', () => {
    colourCamera(false);
    expect(store.lookOrderNow().filter((k) => MONO.includes(k))).toEqual([]);
    colourCamera(true);
    expect(store.lookOrderNow().filter((k) => MONO.includes(k))).toEqual(MONO);
    store.set({ model: 'MONO', monoUnlock: false });
    expect(store.lookOrderNow().filter((k) => MONO.includes(k))).toEqual(MONO);
  });
  it('builds them back where the firmware has them when they are not listed', () => {
    colourCamera(false);
    store.moveLook('f12', -1);
    const spec = store.lookLayoutSpec();
    expect(spec.order.slice(0, 2)).toEqual([12, 11]);
    expect(spec.order.slice(spec.order.indexOf(24), spec.order.indexOf(24) + 9)).toEqual([24, 25, 26, 27, 28, 29, 30, 31, 32]);
  });
  it('keeps their place and hidden state while they are not listed', () => {
    colourCamera(true);
    store.moveLook('f26', -1); store.setLookHidden('f27', true);
    const order = store.lookOrderNow();
    colourCamera(false);
    store.moveLook('f12', -1); store.setLookHidden('f13', true);
    expect(store.lookHiddenNow()).toEqual(['f13']);
    colourCamera(true);
    const now = store.lookOrderNow();
    expect(now.filter((k) => MONO.includes(k))).toEqual(order.filter((k) => MONO.includes(k)));
    expect(now.indexOf('f26')).toBe(order.indexOf('f26'));
    expect(now.slice(0, 2)).toEqual(['f12', 'f11']);
    expect(store.lookHiddenNow().sort()).toEqual(['f13', 'f27']);
  });
});
