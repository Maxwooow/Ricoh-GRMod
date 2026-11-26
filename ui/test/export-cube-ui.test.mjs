// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs)
// "Export look as .cube" (store/cube.ts, DEC-EXPORTCUBE-UI-001) on the real UI store with an in-memory host; the
// .cube itself is made by the real core exportSlotCube.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), convert: vi.fn(), heartbeat: vi.fn(), ratio: vi.fn() },
  host: {
    available: true, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), pickDirectory: vi.fn(), saveFile: vi.fn(), write: vi.fn(),
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
const ident = () => [0, 1, 2].map(() => Float64Array.from({ length: 17 }, (_, i) => i / 16));
const fitted = (title) => ({
  kind: 'cube', title, meanDE: 1, p95DE: 2, warnings: [], unsupported: [],
  params: { M1: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ck: ident() },
  matrixQ13: new Int16Array([8192, 0, 0, 0, 8192, 0, 0, 0, 8192]), curves: [new Uint16Array([0, 65535]), new Uint16Array([0, 65535]), new Uint16Array([0, 65535])],
});
const file = (name, body = 'LUT_3D_SIZE 2 ' + name) => ({ name, size: 10, arrayBuffer: async () => new TextEncoder().encode(body).buffer });

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
  vi.stubGlobal('document', { hidden: true });
  store = await import('../src/store');
  await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('export a slot as a .cube', () => {
  it('asks where to save <slot name>.cube (a 33^3 table) and writes it there; nothing on cancel or without a fitted look', async () => {
    const written = [];
    mocks.host.write.mockImplementation(async (path, data) => { written.push({ path, text: new TextDecoder().decode(data) }); return { size: data.length, sha256: 'x' }; });
    await store.exportSlotCubeFile('CY');
    expect(mocks.host.saveFile).not.toHaveBeenCalled(); // nothing fitted
    expect(store.getState().toasts.at(-1).kind).toBe('error');
    store.setExtraCount(1);
    const k = store.getState().extras[0].key;
    store.setExtraName(k, 'Warm 400');
    await store.loadPresetFile(k, file('w.cube'));
    mocks.host.saveFile.mockResolvedValueOnce('');
    await store.exportSlotCubeFile(k);
    expect(mocks.host.saveFile).toHaveBeenLastCalledWith(expect.any(String), 'Warm 400.cube');
    expect(written).toEqual([]); // cancelled: nothing written
    mocks.host.saveFile.mockResolvedValueOnce('/Users/me/LUTs/Warm.cube');
    await store.exportSlotCubeFile(k);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe('/Users/me/LUTs/Warm.cube');
    expect(written[0].text.split('\n').slice(0, 3)).toEqual(['TITLE "Warm 400"', 'LUT_3D_SIZE 33', 'DOMAIN_MIN 0.0 0.0 0.0']);
    expect(written[0].text.split('\n').filter((l) => /^[\d.]/.test(l))).toHaveLength(33 ** 3);
    expect(store.getState().toasts.at(-1)).toMatchObject({ kind: 'ok' });
    expect(store.getState().toasts.at(-1).text).toContain('/Users/me/LUTs/Warm.cube');
  });
  it('names a built-in slot after what the camera menu shows and keeps the file name safe', async () => {
    await store.loadPresetFile('CY', file('c.cube'));
    store.setName('CY', store.getState().lang, 'A/B: "x"?');
    const c = store.slotCube('CY');
    expect(c.name).toBe('A B x.cube');
    expect(c.text.split('\n')[0]).toBe('TITLE "A/B: x ?"'); // quotes dropped from the title, the rest kept
  });
});
