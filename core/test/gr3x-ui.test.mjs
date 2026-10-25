// SPDX-License-Identifier: GPL-2.0-only
// Exercise the real UI state/actions with an in-memory host. No camera or disk writes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGS } from '../src/fw/names';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), bridge: vi.fn(), script: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: false, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash' }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

const info = () => ({
  family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF'],
  capabilities: { build: true, presets: false, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
let store;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.host.available = false;
  mocks.engine.open.mockReset().mockResolvedValue(info());
  mocks.engine.reset.mockResolvedValue(true);
  mocks.engine.ratio.mockImplementation(async ratio => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  mocks.engine.build.mockResolvedValue({ file: new Uint8Array([9, 2]), checks: { integrity: true } });
  mocks.host.storeSet.mockResolvedValue();
  mocks.host.storeGet.mockReset().mockResolvedValue(null);
  mocks.host.pickDirectory.mockReset().mockResolvedValue('/chosen');
  mocks.host.write.mockImplementation(async (_p, data) => ({ size: data.length, sha256: 'test-hash' }));
  mocks.host.volumes.mockResolvedValue([]);
  vi.stubGlobal('document', { hidden: true });
  store = await import('../../ui/src/store');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('GR IIIx UI family isolation', () => {
  it('selects IIIx when opening its firmware; the page and the (empty) ratio list stay as they are', async () => {
    expect(await store.adoptFirmware('arbitrary.bin', '1.60', new Uint8Array([1]))).toBe(true);
    expect(store.getState()).toMatchObject({ model: 'GR3X_HDF', page: 'ic', fwName: 'fwdc243b.bin', ratios: [] });
  });
  it('adds no ratios by default and asks for one before building', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(1);
    store.setSoft(true);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build).not.toHaveBeenCalled();
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('blocks all unported output actions before a destination can be selected', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    await store.outputBridge({ kind: 'folder' });
    expect(store.outputEntry).toBeUndefined();
    expect(store.outputWallpaper).toBeUndefined();
    store.setBridgeOpen(true);
    expect(store.getState().bridgeOpen).toBe(false);
    for (const fn of [mocks.host.pickDirectory, mocks.host.write, mocks.engine.build, mocks.engine.bridge, mocks.engine.script]) expect(fn).not.toHaveBeenCalled();
  });
  it('exports exactly the ratios added through the real build action', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    for (const r of ['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4']) store.addRatio(r);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().ratios.map(r => r.ratio)).toEqual(['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4']);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build).toHaveBeenCalledWith([], ['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4'].map(ratio => ({ ratio, name: ratio })), [], { adjSoftFocus: false, dateStamp: false, monoUnlock: false });
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', new Uint8Array([9, 2]));
  });
  it('exports IIIx negative-clarity soft focus while preserving the ADJ function list', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.addRatio('4:3');
    store.setSoft(true);
    store.setDateStamp(true); store.setMonoUnlock(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({ soft: true, dateStamp: false, monoUnlock: false });
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build.mock.calls[0].slice(2)).toEqual([
      [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }],
      { adjSoftFocus: false, dateStamp: false, monoUnlock: false },
    ]);
  });
  it('retains the selected IIIx page and soft-focus choice when reopening its firmware', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setPage('script'); store.setSoft(true);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    expect(store.getState()).toMatchObject({ page: 'script', soft: true });
  });
  it('exports T5 film data, uniform names and replicas together with SF1 and the nine-ratio recipe', async () => {
    const current = info();
    current.capabilities.presets = true; current.features.monoUnlock = true;
    current.allowed = Object.fromEntries(LANGS.map(l => [l, ' Film1WarmDemo']));
    current.slots = ['CY','CG'].map((id, i) => ({ id, defaultName: `Film ${i+1}`,
      names: Object.fromEntries(LANGS.map(l => [l, { text: `Film ${i+1}`, capacity: 24 }])) }));
    mocks.engine.open.mockResolvedValue(current);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setName('CY', 'zh-CN', 'Warm Demo');
    const preset = { matrixQ13: new Int16Array(9), curves: [new Uint16Array(256),new Uint16Array(256),new Uint16Array(256)] };
    store.getState().slots.CY.preset = { fileName: 'demo.cube', kind: 'cube', text: '', result: preset };
    store.setSoft(true); store.setMonoUnlock(true);
    for (const r of ['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4']) store.addRatio(r);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    expect(store.getState()).toMatchObject({ soft: true, monoUnlock: true });
    await vi.advanceTimersByTimeAsync(1);
    await store.outputFirmware({ kind: 'folder' });
    const [requests, ratios, soft, options] = mocks.engine.build.mock.calls.at(-1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ slot: 'CY', preset });
    expect(new Set(Object.values(requests[0].names))).toEqual(new Set(['Warm Demo']));
    expect(ratios).toHaveLength(7); expect(soft.map(s => s.level)).toEqual([-1,-2,-3]);
    expect(options).toEqual({ adjSoftFocus: false, dateStamp: false, monoUnlock: true });
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', new Uint8Array([9,2]));
  });
  it('exports the ninth film and suppresses retired replicas with the T6 capabilities', async () => {
    const current = info(); current.capabilities.presets = true;
    const ids = ['CY','CG','F3','F4','F5','F6','F7','F8','F9'];
    current.allowed = Object.fromEntries(LANGS.map(l => [l, 'Film 123456789CineStl80T']));
    current.slots = ids.map((id, i) => ({ id, defaultName: `Film ${i+1}`,
      names: Object.fromEntries(LANGS.map(l => [l, { text: `Film ${i+1}`, capacity: 24 }])) }));
    mocks.engine.open.mockResolvedValue(current);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setName('F9', 'zh-CN', 'CineStill 800T'); store.setMonoUnlock(true); store.addRatio('4:3');
    const preset = { matrixQ13: new Int16Array(9), curves: [new Uint16Array(256),new Uint16Array(256),new Uint16Array(256)] };
    store.getState().slots.F9.preset = { fileName: 'CineStill-800T.cube', kind: 'cube', text: '', result: preset };
    store.setActiveSlot('F9');
    await vi.advanceTimersByTimeAsync(1);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build.mock.calls.at(-1)[0][0]).toMatchObject({ slot: 'F9', preset });
    expect(mocks.engine.build.mock.calls.at(-1)[3].monoUnlock).toBe(false);
    store.setModel('HDF');
    expect(store.getState().activeSlot).toBe('CY');
    expect(store.getState().slots.F9.preset).toBeUndefined();
  });
  it('keeps each camera family’s own work apart when switching or opening a different model', async () => {
    store.getState().slots.CY = { ...store.getState().slots.CY, names: { en: 'GR IV film' }, preset: { result: {} } };
    store.setModel('GR3X_HDF');
    expect(store.getState().slots.CY.preset).toBeUndefined();
    expect(store.getState().slots.CY.names).toEqual({});
    store.getState().slots.CY = { ...store.getState().slots.CY, names: { en: 'GR III film' } };
    store.setModel('HDF');
    expect(store.getState().slots.CY.names).toEqual({ en: 'GR IV film' });
    store.getState().slots.CY.preset = { result: {} };
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    expect(store.getState().slots.CY.preset).toBeUndefined();
    expect(store.getState().slots.CY.names).toEqual({ en: 'GR III film' });
  });
  it('saves GR IV and GR III work in their own files and brings both back after a restart', async () => {
    await store.init();
    mocks.host.available = true;
    const files = new Map();
    mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); });
    mocks.host.storeDel = vi.fn(async key => { files.delete(key); });
    mocks.host.storeGet.mockImplementation(async key => files.get(key) ?? null);
    const presets = { capabilities: { ...info().capabilities, presets: true } };
    mocks.engine.convert = vi.fn(async () => ({ matrixQ13: [] }));
    const gr4 = { ...info(), ...presets, family: 'gr4', models: ['HDF'], filename: 'fwdc248b.bin', slots: [{ id: 'CY' }, { id: 'CG' }] };
    mocks.engine.open.mockResolvedValueOnce(gr4);
    await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
    store.setName('CY', 'en', 'Warm IV');
    await store.loadPresetFile('CY', { name: 'iv.cube', size: 10, arrayBuffer: async () => new TextEncoder().encode('LUT_3D_SIZE 2 four').buffer });
    store.setModel('GR3_HDF');
    store.setName('CY', 'en', 'Film III');
    await store.loadPresetFile('CY', { name: 'iii.cube', size: 10, arrayBuffer: async () => new TextEncoder().encode('LUT_3D_SIZE 2 three').buffer });
    await vi.advanceTimersByTimeAsync(401);
    expect(new TextDecoder().decode(files.get('preset-cy'))).toBe('LUT_3D_SIZE 2 four');
    expect(new TextDecoder().decode(files.get('gr3-preset-cy'))).toBe('LUT_3D_SIZE 2 three');
    const p4 = JSON.parse(new TextDecoder().decode(files.get('project.json')));
    const p3 = JSON.parse(new TextDecoder().decode(files.get('project-gr3.json')));
    expect(p4).toMatchObject({ model: 'GR3_HDF', slots: { CY: { names: { en: 'Warm IV' }, preset: { fileName: 'iv.cube' } } } });
    expect(p3).toMatchObject({ slots: { CY: { names: { en: 'Film III' }, preset: { fileName: 'iii.cube' } } } });
    // Restart on GR III, then switch to GR IV: each gets its own back.
    vi.resetModules();
    const restarted = await import('../../ui/src/store');
    await restarted.init();
    await vi.advanceTimersByTimeAsync(1);
    expect(restarted.getState()).toMatchObject({ model: 'GR3_HDF' });
    expect(restarted.getState().slots.CY).toMatchObject({ names: { en: 'Film III' }, preset: { fileName: 'iii.cube', text: 'LUT_3D_SIZE 2 three' } });
    // GR IV's official file was kept: it opens again by itself (no download).
    mocks.engine.open.mockResolvedValue(gr4);
    restarted.setModel('HDF');
    await vi.advanceTimersByTimeAsync(1);
    expect(restarted.getState().slots.CY).toMatchObject({ names: { en: 'Warm IV' }, preset: { fileName: 'iv.cube', text: 'LUT_3D_SIZE 2 four' } });
    expect(restarted.getState()).toMatchObject({ model: 'HDF', fwName: 'fwdc248b.bin' });
    expect(files.has('firmware-gr4.bin')).toBe(true);
  });
  it('takes over a GR III project of the test builds kept in project.json, presets included', async () => {
    mocks.host.available = true;
    const files = new Map([
      ['project.json', new TextEncoder().encode(JSON.stringify({ v: 1, model: 'GR3_HDF', slots: { CY: { names: { en: 'Old III' }, preset: { fileName: 'old.cube', kind: 'cube' } } }, filmCount: 20 }))],
      ['preset-cy', new TextEncoder().encode('LUT_3D_SIZE 2 old')],
    ]);
    mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); });
    mocks.host.storeGet.mockImplementation(async key => files.get(key) ?? null);
    await store.init();
    await vi.advanceTimersByTimeAsync(401);
    expect(store.getState()).toMatchObject({ model: 'GR3_HDF', filmCount: 20, slots: { CY: { names: { en: 'Old III' }, preset: { fileName: 'old.cube' } } } });
    expect(new TextDecoder().decode(files.get('gr3-preset-cy'))).toBe('LUT_3D_SIZE 2 old');
    expect(JSON.parse(new TextDecoder().decode(files.get('project-gr3.json')))).toMatchObject({ filmCount: 20, slots: { CY: { names: { en: 'Old III' } } } });
    // GR IV's part of project.json is now empty (it was GR III's).
    expect(JSON.parse(new TextDecoder().decode(files.get('project.json'))).slots).toBeUndefined();
  });
  it('exports only the unchanged original using the IIIx update filename', async () => {
    const original = new Uint8Array([1, 2, 3]);
    await store.adoptFirmware('fwdc243b.bin', '1.60', original);
    const pending = store.outputFirmware({ kind: 'folder' }, true);
    await vi.advanceTimersByTimeAsync(0);
    // the factory firmware is only written after confirming the camera's settings were reset
    expect(store.getState().confirm).toMatchObject({ reset: true });
    store.answerConfirm(true); await pending;
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', original);
    expect(mocks.engine.build).not.toHaveBeenCalled();
  });
  it('clears the engine and prevents output after switching to a GR IV model', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setModel('HDF');
    expect(store.getState()).toMatchObject({ model: 'HDF', info: undefined, raw: undefined, fwName: undefined });
    expect(mocks.engine.reset).toHaveBeenCalledOnce();
    await store.outputFirmware({ kind: 'folder' }, true);
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('cancels an export if the family changes while the folder picker is open', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    let finish;
    mocks.host.pickDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.outputFirmware({ kind: 'folder' }, true);
    await vi.advanceTimersByTimeAsync(0); store.answerConfirm(true); await vi.advanceTimersByTimeAsync(0);
    store.setModel('HDF'); finish('/chosen'); await pending;
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('invalidates the previous firmware when opening another one fails', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    mocks.engine.open.mockRejectedValueOnce(new Error('unsupported firmware'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.adoptFirmware('other.bin', '1.50', new Uint8Array([2]))).toBe(false);
    expect(store.getState()).toMatchObject({ info: undefined, raw: undefined, fwName: undefined });
    await store.outputFirmware({ kind: 'folder' }, true); // nothing open: returns before asking
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it.each(['outputBridge'])('cancels GR IV %s when the user switches to IIIx in the folder picker', async action => {
    const gr4 = { ...info(), family: 'gr4', models: ['HDF'], filename: 'fwdc248b.bin' };
    gr4.capabilities = { ...gr4.capabilities, factoryEntry: true, bridge: true };
    mocks.engine.open.mockResolvedValueOnce(gr4);
    await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
    let finish;
    mocks.host.pickDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = store[action]({ kind: 'folder' });
    store.setModel('GR3X_HDF'); finish('/chosen'); await pending;
    expect(mocks.host.write).not.toHaveBeenCalled();
    expect(mocks.engine.bridge).not.toHaveBeenCalled();
  });
  it('opens GR III 2.10 as its own model in the same family and writes fwdc239b.bin', async () => {
    mocks.engine.open.mockResolvedValue({ ...info(), version: '2.10', filename: 'fwdc239b.bin', models: ['GR3_HDF'], });
    expect(await store.adoptFirmware('fwdc239b.bin', '2.10', new Uint8Array([1]))).toBe(true);
    expect(store.getState()).toMatchObject({ model: 'GR3_HDF', page: 'ic', fwName: 'fwdc239b.bin' });
    expect(store.isGr3('GR3_HDF') && store.isGr3('GR3X_HDF') && store.isGr3('GR3') && store.isGr3('GR3X') && !store.isGr3('HDF')).toBe(true);
    store.addRatio('4:3');
    await vi.advanceTimersByTimeAsync(1);
    store.setSoft(true);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build.mock.calls.at(-1).slice(2)).toEqual([
      [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }],
      { adjSoftFocus: false, dateStamp: false, monoUnlock: false },
    ]);
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc239b.bin', new Uint8Array([9, 2]));
    // no bridge firmware for this family
    store.setBridgeOpen(true);
    expect(store.getState().bridgeOpen).toBe(false);
  });
  it('switching between GR III and GR IIIx closes the other camera\'s firmware', async () => {
    mocks.engine.open.mockResolvedValue({ ...info(), version: '2.10', filename: 'fwdc239b.bin', models: ['GR3_HDF'], });
    await store.adoptFirmware('fwdc239b.bin', '2.10', new Uint8Array([1]));
    store.setModel('GR3X_HDF');
    expect(store.getState()).toMatchObject({ model: 'GR3X_HDF', info: undefined, raw: undefined, fwName: undefined });
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('does not open another camera\'s kept firmware; a 0.8.x kept file moves to its camera\'s place', async () => {
    await store.init(); // no host: mark the project ready without side effects
    mocks.host.available = true;
    let saved;
    mocks.host.storeSet.mockImplementation(async (key, value) => { if (key === 'project.json') saved = value; });
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setModel('HDF');
    await vi.advanceTimersByTimeAsync(401);
    expect(JSON.parse(saved)).toMatchObject({ model: 'HDF' });
    expect(JSON.parse(saved).fwName).toBeUndefined();
    vi.resetModules(); mocks.engine.open.mockClear();
    // 0.8.x kept the one file open last (here GR IIIx's, told apart by its size) as firmware.bin.
    const files = new Map([['project.json', new TextEncoder().encode(saved)], ['firmware.bin', new Uint8Array(30391788)], ['preview.jpg', new Uint8Array([1])]]);
    mocks.host.storeGet.mockImplementation(async key => files.get(key) ?? null);
    mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, value); });
    mocks.host.storeDel = vi.fn(async key => { files.delete(key); });
    const restarted = await import('../../ui/src/store');
    await restarted.init();
    expect(restarted.getState().model).toBe('HDF');
    expect(restarted.getState().info).toBeUndefined();
    expect(mocks.engine.open).not.toHaveBeenCalled();
    expect(files.has('firmware.bin')).toBe(false);
    expect(files.get('firmware-gr3x.bin')?.length).toBe(30391788);
    // Back on GR IIIx: its kept file opens again without a download.
    restarted.setModel('GR3X_HDF');
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.engine.open).toHaveBeenCalledOnce();
    expect(restarted.getState()).toMatchObject({ model: 'GR3X_HDF', fwName: 'fwdc243b.bin' });
  });
  it('keeps 0.8.x\'s firmware.bin when it cannot be copied to its new place', async () => {
    mocks.host.available = true;
    const files = new Map([['project.json', new TextEncoder().encode(JSON.stringify({ v: 1, model: 'HDF' }))], ['firmware.bin', new Uint8Array(30391788)]]);
    mocks.host.storeGet.mockImplementation(async key => files.get(key) ?? null);
    mocks.host.storeSet.mockImplementation(async (key, value) => { if (key.startsWith('firmware-')) throw new Error('disk full'); files.set(key, value); });
    mocks.host.storeDel = vi.fn(async key => { files.delete(key); });
    await store.init();
    store.setModel('GR3X_HDF');
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.host.storeDel).not.toHaveBeenCalled();
    expect(files.get('firmware.bin')?.length).toBe(30391788);
  });
  it('brings back the nine films of GR III work saved before the film count was saved', async () => {
    mocks.host.available = true;
    const files = new Map([['project.json', new TextEncoder().encode(JSON.stringify({ v: 1, model: 'HDF' }))],
      ['project-gr3.json', new TextEncoder().encode(JSON.stringify({ v: 1, model: 'GR3_HDF', slots: { CY: { names: { en: 'Old III' } } } }))]]);
    mocks.host.storeGet.mockImplementation(async key => files.get(key) ?? null);
    mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, value); });
    await store.init();
    store.setModel('GR3_HDF');
    await vi.advanceTimersByTimeAsync(401);
    expect(store.getState()).toMatchObject({ model: 'GR3_HDF', filmCount: 9, slots: { CY: { names: { en: 'Old III' } } } });
  });
  it('opens a file the user drops while the kept one is still opening', async () => {
    await store.init();
    mocks.host.available = true;
    const files = new Map([['firmware-gr3x.bin', new Uint8Array([7])]]);
    mocks.host.storeGet.mockImplementation(async key => files.get(key) ?? null);
    mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, value); });
    let finish;
    mocks.engine.open.mockImplementationOnce(() => new Promise(r => { finish = () => r(info()); }));
    store.setModel('GR3X_HDF');
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.engine.open).toHaveBeenCalledOnce();
    const dropped = store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([8]));
    finish();
    expect(await dropped).toBe(true);
    expect(mocks.engine.open).toHaveBeenCalledTimes(2);
    expect(mocks.engine.open.mock.calls[1][0]).toEqual(new Uint8Array([8]));
  });
});
