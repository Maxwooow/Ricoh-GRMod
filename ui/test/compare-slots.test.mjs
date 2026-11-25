// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: the engine worker, the host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs); the store under test is real
// Compare two slots: which slots the choice offers, when it falls back to the original, and that it is saved with the project.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), convert: vi.fn(), heartbeat: vi.fn(), ratio: vi.fn() },
  host: {
    available: true, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../src/pixels', () => ({ ensureIconFont: vi.fn(), textIcon: vi.fn(() => new Uint8Array(1)), imageIcon: vi.fn(() => new Uint8Array(1)) }));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn() }));

const caps = { build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false };
const gr4 = () => ({
  family: 'gr4', version: '1.11', filename: 'fwdc248b.bin', models: ['HDF'], capabilities: caps,
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false }, slots: [{ id: 'CY' }, { id: 'CG' }],
  contentArea: { film: { x0: 0, y0: 0, x1: 1, y1: 1 }, plain: { x0: 0, y0: 0, x1: 1, y1: 1 } }, factoryRatios: ['3:2'], factoryEntry: { files: [] }, tiles: { film: new Uint8Array(1), plain: new Uint8Array(1) },
});
const fitted = (title) => ({
  kind: 'cube', title, meanDE: 1, p95DE: 2, warnings: [], unsupported: [],
  params: { M1: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ck: [new Float64Array([0, 0.5, 1]), new Float64Array([0, 0.5, 1]), new Float64Array([0, 0.5, 1])] },
  matrixQ13: new Int16Array([8192, 0, 0, 0, 8192, 0, 0, 0, 8192]), curves: [new Uint16Array([0, 65535]), new Uint16Array([0, 65535]), new Uint16Array([0, 65535])],
});
const cube = (name, body) => ({ name, size: 10, arrayBuffer: async () => new TextEncoder().encode(body).buffer });

let store, files;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  files = new Map();
  mocks.host.available = true;
  mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); });
  mocks.host.storeDel.mockImplementation(async (key) => { files.delete(key); });
  mocks.host.storeGet.mockImplementation(async (key) => files.get(key) ?? null);
  mocks.host.volumes.mockResolvedValue([]); mocks.host.sidecar.mockResolvedValue(null);
  mocks.engine.reset.mockResolvedValue(true);
  mocks.engine.convert.mockImplementation(async (_kind, text) => fitted('Look ' + text.length));
  mocks.engine.open.mockResolvedValue(gr4());
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // the preview photo cannot be fetched outside a browser
  vi.stubGlobal('document', { hidden: true });
  store = await import('../src/store');
  await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
  await store.loadPresetFile('CY', cube('warm.cube', 'LUT_3D_SIZE 2 warm'));
}, 60000); // the first import of the store is slow on a cold start
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('compare two slots', () => {
  it('defaults to the original and offers the slots that have a fitted look', async () => {
    expect(store.getState().compareWith).toBe('orig');
    expect(store.compareSlot()).toBeUndefined();
    expect(store.slotsWithLook()).toEqual(['CY']);
    await store.loadPresetFile('CG', cube('cool.cube', 'LUT_3D_SIZE 2 cool'));
    expect(store.slotsWithLook()).toEqual(['CY', 'CG']);
  });
  it('shows another slot on the left', async () => {
    await store.loadPresetFile('CG', cube('cool.cube', 'LUT_3D_SIZE 2 cool'));
    store.setActiveSlot('CG');
    store.setCompareWith('CY');
    expect(store.compareSlot()).toBe('CY');
  });
  it('falls back to the original for the active slot, a removed preset and a slot that never had one', async () => {
    await store.loadPresetFile('CG', cube('cool.cube', 'LUT_3D_SIZE 2 cool'));
    store.setActiveSlot('CG');
    store.setCompareWith('CY');
    store.setActiveSlot('CY'); // comparing a slot with itself means nothing
    expect(store.compareSlot()).toBeUndefined();
    store.setActiveSlot('CG');
    store.removePreset('CY');
    expect(store.compareSlot()).toBeUndefined();
    expect(store.getState().compareWith).toBe('CY'); // the choice is kept: it applies again once CY has a look
    store.setCompareWith('x-gone'); // an added slot that no longer exists
    expect(store.compareSlot()).toBeUndefined();
  });
  it('follows an added slot and drops it when the slot is removed', async () => {
    store.setExtraCount(1);
    const x = store.getState().extras[0].key;
    await store.loadPresetFile(x, cube('x.cube', 'LUT_3D_SIZE 2 x'));
    store.setActiveSlot('CY');
    store.setCompareWith(x);
    expect(store.compareSlot()).toBe(x);
    expect(store.slotsWithLook()).toEqual(['CY', x]);
    store.removeExtraSlot(x, false);
    expect(store.compareSlot()).toBeUndefined();
  });
  it('is saved with the project like the preview mode, and a restart brings it back', async () => {
    await store.init(); // saving starts once the project is ready
    store.setCompareWith('CY');
    await vi.advanceTimersByTimeAsync(401);
    expect(JSON.parse(new TextDecoder().decode(files.get('project.json')))).toMatchObject({ previewMode: 'photo', compareWith: 'CY' });
    vi.resetModules();
    const again = await import('../src/store');
    await again.init();
    await vi.advanceTimersByTimeAsync(1);
    expect(again.getState().compareWith).toBe('CY');
  });
  it('a project saved before the choice existed opens on the original', async () => {
    files.set('project.json', new TextEncoder().encode(JSON.stringify({ v: 1, model: 'HDF', previewMode: 'photo' })));
    vi.resetModules();
    const again = await import('../src/store');
    await again.init();
    await vi.advanceTimersByTimeAsync(1);
    expect(again.getState().compareWith).toBe('orig');
  });
});
