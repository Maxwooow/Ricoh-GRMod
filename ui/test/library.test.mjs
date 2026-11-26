// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: the engine worker, the host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs); the store under test is real
// The preset library on the real UI store with an in-memory host.
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
const file = (name, body) => ({ name, size: 10, arrayBuffer: async () => new TextEncoder().encode(body).buffer });

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
  await store.loadPresetFile('CY', file('warm.cube', 'LUT_3D_SIZE 2 warm'));
  mocks.engine.convert.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const index = () => JSON.parse(new TextDecoder().decode(files.get('library.json')));

describe('preset library', () => {
  it('starts empty: the library ships no presets of its own', async () => {
    await store.loadLibrary();
    expect(store.getState().library).toEqual([]);
    expect(store.libraryFor()).toEqual([]);
  });
  it('saving a preset writes the index, the source and the fit to the library files', async () => {
    expect(await store.saveToLibrary('CY', 'Warm')).toBe(true);
    const [e] = index().entries;
    expect(index().v).toBe(1);
    expect(e).toMatchObject({ name: 'Warm', kind: 'cube', family: 'gr4', fileName: 'warm.cube' });
    expect(new TextDecoder().decode(files.get('library-' + e.id))).toBe('LUT_3D_SIZE 2 warm');
    expect(files.has('library-' + e.id + '-fit')).toBe(true);
    expect(store.getState().library).toHaveLength(1);
    // shell/internal/server/store.go keyPattern: the desktop host accepts only these keys
    for (const k of mocks.host.storeSet.mock.calls.map((c) => c[0])) expect(k, k).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });
  it('defaults the name to the preset title and replaces an entry saved under the same name', async () => {
    expect(store.defaultLibraryName('CY')).toBe(store.getState().slots.CY.preset.result.title);
    await store.saveToLibrary('CY', 'Warm'); await store.saveToLibrary('CY', 'Warm');
    expect(index().entries).toHaveLength(1);
  });
  it('saves nothing for a slot without a fitted preset or a blank name', async () => {
    expect(await store.saveToLibrary('CG', 'Nothing')).toBe(false);
    expect(await store.saveToLibrary('CY', '   ')).toBe(false);
    expect(files.has('library.json')).toBe(false);
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
    expect(store.getState().libraryPicker).toBeUndefined();
  });
  it('refits the stored source when the options differ (an added slot fits with hue sectors)', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    store.setExtraCount(1);
    const x = store.getState().extras[0].key;
    mocks.engine.convert.mockClear();
    await store.applyFromLibrary(x, id);
    expect(mocks.engine.convert).toHaveBeenCalledWith('cube', 'LUT_3D_SIZE 2 warm', { hue: true });
    expect(store.getState().extras[0].preset).toMatchObject({ fileName: 'warm.cube', busy: false });
  });
  it('refits when the stored fit cannot be read back', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    files.set('library-' + id + '-fit', new TextEncoder().encode('{broken'));
    mocks.engine.convert.mockClear();
    expect(await store.applyFromLibrary('CG', id)).toBe(true);
    expect(mocks.engine.convert).toHaveBeenCalledWith('cube', 'LUT_3D_SIZE 2 warm', {});
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
    const again = await import('../src/store');
    await again.loadLibrary();
    expect(again.getState().library.map((e) => e.name)).toEqual(['Warm']);
  });
  it('opens and closes the dialog for a slot in either mode', () => {
    store.openLibrary('CG', 'apply');
    expect(store.getState().libraryPicker).toEqual({ slot: 'CG', mode: 'apply' });
    store.closeLibrary();
    expect(store.getState().libraryPicker).toBeUndefined();
  });
  it('deletes an entry and its files only after confirmation', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    const declined = store.deleteLibraryEntry(id);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().confirm).toBeTruthy();
    store.answerConfirm(false);
    await declined;
    expect(index().entries).toHaveLength(1);
    expect(files.has('library-' + id)).toBe(true);
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
  it('save, apply, rename, apply again, delete: the sequence a user actually goes through', async () => {
    await store.saveToLibrary('CY', 'Warm');
    const id = index().entries[0].id;
    await store.applyFromLibrary('CG', id);
    expect(await store.renameLibraryEntry(id, 'Golden')).toBe('ok');
    await store.applyFromLibrary('CG', id); // the renamed entry still applies: files are keyed by id
    expect(store.getState().slots.CG.preset.fileName).toBe('warm.cube');
    const done = store.deleteLibraryEntry(id);
    await vi.advanceTimersByTimeAsync(1); store.answerConfirm(true); await done;
    expect(await store.applyFromLibrary('CG', id)).toBe(false);
    expect(store.getState().slots.CG.preset).toBeTruthy(); // the slot keeps its own copy
  });
});

describe('library rename, search and sort', () => {
  beforeEach(async () => {
    await store.saveToLibrary('CY', 'Warm');
    await store.loadPresetFile('CY', file('Cool-Tone.cube', 'LUT_3D_SIZE 2 cool'));
    await store.saveToLibrary('CY', 'Cool');
  });
  it('renames an entry, persists it to library.json and keeps id, date and files', async () => {
    const before = index().entries.find((e) => e.name === 'Warm');
    expect(await store.renameLibraryEntry(before.id, '  Golden hour ')).toBe('ok');
    const after = index().entries.find((e) => e.id === before.id);
    expect(after).toMatchObject({ name: 'Golden hour', date: before.date, fileName: 'warm.cube' });
    expect(store.getState().library.find((e) => e.id === before.id).name).toBe('Golden hour');
    expect(files.has('library-' + before.id)).toBe(true);
    expect(await store.renameLibraryEntry(before.id, 'Golden hour')).toBe('ok'); // unchanged: no clash with itself
  });
  it('rejects a duplicate name in the same family, a blank name and an unknown id, writing nothing', async () => {
    const warm = index().entries.find((e) => e.name === 'Warm');
    const raw = files.get('library.json');
    expect(await store.renameLibraryEntry(warm.id, 'Cool')).toBe('exists');
    expect(await store.renameLibraryEntry(warm.id, '   ')).toBe('empty');
    expect(await store.renameLibraryEntry('nope', 'X')).toBe('missing');
    expect(files.get('library.json')).toBe(raw);
    expect(store.getState().library.map((e) => e.name).sort()).toEqual(['Cool', 'Warm']);
  });
  it('a name used by the other camera family is allowed', async () => {
    const warm = index().entries.find((e) => e.name === 'Warm');
    files.set('library.json', new TextEncoder().encode(JSON.stringify({ v: 1, entries: [...index().entries, { id: 'g3', name: 'Mine', kind: 'cube', family: 'gr3', fileName: 'm.cube', date: 1 }] })));
    vi.resetModules();
    const again = await import('../src/store');
    await again.loadLibrary();
    expect(await again.renameLibraryEntry(warm.id, 'Mine')).toBe('ok');
  });
  it('search matches name and file name case-insensitively; sort is newest first or by name', () => {
    const e = (id, name, fileName, date) => ({ id, name, kind: 'cube', family: 'gr4', fileName, date });
    const list = [e('a', 'Warm', 'one.cube', 1), e('b', 'cool', 'Film-TONE.cube', 3), e('c', 'Amber', 'two.xmp', 2)];
    expect(store.searchLibrary(list, ' WARM ').map((x) => x.id)).toEqual(['a']);
    expect(store.searchLibrary(list, 'tone').map((x) => x.id)).toEqual(['b']);
    expect(store.searchLibrary(list, '.xmp').map((x) => x.id)).toEqual(['c']);
    expect(store.searchLibrary(list, 'zzz')).toEqual([]);
    expect(store.searchLibrary(list, '  ')).toHaveLength(3);
    expect(store.sortLibrary(list, 'new').map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(store.sortLibrary(list, 'name').map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(store.LIBRARY_SEARCH_MIN).toBe(5);
  });
});
