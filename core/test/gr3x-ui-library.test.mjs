// SPDX-License-Identifier: GPL-2.0-only
// QoL wave C: the preset library and the compare selection, on the real UI store with an in-memory host
// (same mocking pattern as gr3x-ui.test.mjs: only the engine and host boundaries are replaced).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), convert: vi.fn(), heartbeat: vi.fn(), ratio: vi.fn() },
  host: {
    available: true, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn(), textIcon: vi.fn(() => new Uint8Array(1)), imageIcon: vi.fn(() => new Uint8Array(1)) }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

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
  vi.stubGlobal('document', { hidden: true });
  store = await import('../../ui/src/store');
  await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
  await store.loadPresetFile('CY', cube('warm.cube', 'LUT_3D_SIZE 2 warm'));
  mocks.engine.convert.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const index = () => JSON.parse(new TextDecoder().decode(files.get('library.json')));

describe('preset library', () => {
  it('saving a preset writes the index, the source and the fit to the library files', async () => {
    expect(await store.saveToLibrary('CY', 'Warm')).toBe(true);
    const [e] = index().entries;
    expect(index().v).toBe(1);
    expect(e).toMatchObject({ name: 'Warm', kind: 'cube', family: 'gr4', fileName: 'warm.cube' });
    expect(new TextDecoder().decode(files.get('library-' + e.id))).toBe('LUT_3D_SIZE 2 warm');
    expect(files.has('library-' + e.id + '-fit')).toBe(true);
    expect(store.getState().library).toHaveLength(1);
  });
  it('defaults the name to the preset title and replaces an entry saved under the same name', async () => {
    expect(store.defaultLibraryName('CY')).toBe(store.getState().slots.CY.preset.result.title);
    await store.saveToLibrary('CY', 'Warm'); await store.saveToLibrary('CY', 'Warm');
    expect(index().entries).toHaveLength(1);
  });
  it('applies to another slot with the same params and no fitting when the options match', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    expect(await store.applyFromLibrary('CG', id)).toBe(true);
    expect(mocks.engine.convert).not.toHaveBeenCalled();
    const a = store.getState().slots.CY.preset.result, b = store.getState().slots.CG.preset.result;
    expect(b.params).toEqual(a.params);
    expect(b.params.ck[0]).toBeInstanceOf(Float64Array);
    expect(b.matrixQ13).toBeInstanceOf(Int16Array);
    expect(store.getState().slots.CG.preset).toMatchObject({ fileName: 'warm.cube', busy: false });
    expect(new TextDecoder().decode(files.get('preset-cg'))).toBe('LUT_3D_SIZE 2 warm'); // kept in the project like an imported file
  });
  it('refits from the stored source when the options differ (an added slot with hue sectors)', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    store.setExtraCount(1);
    mocks.engine.convert.mockClear();
    const x = store.getState().extras[0].key;
    await store.applyFromLibrary(x, id);
    expect(mocks.engine.convert).toHaveBeenCalledWith('cube', 'LUT_3D_SIZE 2 warm', { hue: true });
  });
  it('never offers or applies a GR III entry on a GR IV slot', async () => {
    files.set('library.json', new TextEncoder().encode(JSON.stringify({ v: 1, entries: [{ id: 'g3', name: 'Film', kind: 'cube', family: 'gr3', fileName: 'f.cube', date: 1 }] })));
    files.set('library-g3', new TextEncoder().encode('LUT_3D_SIZE 2 g3'));
    await store.saveToLibrary('CY', 'Warm'); // loads the index too
    expect(store.getState().library.map((e) => e.id)).toContain('g3');
    expect(store.libraryFor().map((e) => e.name)).toEqual(['Warm']);
    expect(await store.applyFromLibrary('CG', 'g3')).toBe(false);
    expect(mocks.engine.convert).not.toHaveBeenCalled();
    expect(store.getState().slots.CG.preset).toBeUndefined();
  });
  it('offers each family its own entries across a camera switch and survives a restart', async () => {
    await store.saveToLibrary('CY', 'Warm');
    store.setModel('GR3_HDF');
    expect(store.libraryFor()).toEqual([]);
    vi.resetModules();
    const again = await import('../../ui/src/store');
    await again.loadLibrary();
    expect(again.getState().library.map((e) => e.name)).toEqual(['Warm']);
  });
  it('deletes an entry and its files after confirmation', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    const done = store.deleteLibraryEntry(id);
    await vi.advanceTimersByTimeAsync(1);
    store.answerConfirm(true);
    await done;
    expect(index().entries).toEqual([]);
    expect(files.has('library-' + id)).toBe(false);
    expect(files.has('library-' + id + '-fit')).toBe(false);
  });
  it('treats a damaged index as an empty library', async () => {
    files.set('library.json', new TextEncoder().encode('{not json'));
    await store.loadLibrary();
    expect(store.getState().library).toEqual([]);
  });
});

describe('compare two slots', () => {
  it('defaults to the original and offers only other slots that have a fitted look', async () => {
    expect(store.getState().compareWith).toBe('orig');
    expect(store.compareSlot()).toBeUndefined();
    expect(store.slotsWithLook()).toEqual(['CY']);
    await store.loadPresetFile('CG', cube('cool.cube', 'LUT_3D_SIZE 2 cool'));
    expect(store.slotsWithLook()).toEqual(['CY', 'CG']);
  });
  it('shows another slot on the left, and falls back to the original for the active slot, a removed preset or a slot without one', async () => {
    await store.loadPresetFile('CG', cube('cool.cube', 'LUT_3D_SIZE 2 cool'));
    store.setActiveSlot('CG');
    store.setCompareWith('CY');
    expect(store.compareSlot()).toBe('CY');
    store.setActiveSlot('CY'); // comparing a slot with itself means nothing
    expect(store.compareSlot()).toBeUndefined();
    store.setActiveSlot('CG');
    store.removePreset('CY');
    expect(store.compareSlot()).toBeUndefined();
    expect(store.getState().compareWith).toBe('CY'); // the choice is kept: it applies again once CY has a look
  });
  it('is saved with the project like the preview mode, and a restart brings it back', async () => {
    await store.init(); // saving starts once the project is ready
    store.setCompareWith('CY');
    await vi.advanceTimersByTimeAsync(401);
    expect(JSON.parse(new TextDecoder().decode(files.get('project.json')))).toMatchObject({ previewMode: 'photo', compareWith: 'CY' });
    vi.resetModules();
    const again = await import('../../ui/src/store');
    await again.init();
    await vi.advanceTimersByTimeAsync(1);
    expect(again.getState().compareWith).toBe('CY');
  });
});
