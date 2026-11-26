// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs)
// Duplicate an added slot and batch preset import, on the real UI store with an in-memory host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@grmod/core';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), convert: vi.fn(), heartbeat: vi.fn(), ratio: vi.fn() },
  host: {
    available: true, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async (b) => (await import('node:crypto')).createHash('sha256').update(b).digest('hex'), isAndroid: false, isMobile: false }));
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
  vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = await import('../src/store');
  await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
}, 60000);
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('duplicate an added slot', () => {
  it('copies params, icon, name suffix and the preset file under the new key, right after the source in extras and look order', async () => {
    store.setExtraCount(2);
    await vi.advanceTimersByTimeAsync(5);
    const [a, b] = store.getState().extras.map((x) => x.key);
    store.setExtraName(a, 'Warm 400');
    await store.loadPresetFile(a, file('warm.cube', 'LUT_3D_SIZE 2 warm'));
    store.setIcon(a, { text: '400' });
    await vi.advanceTimersByTimeAsync(5);
    const k = store.duplicateExtraSlot(a);
    expect(k).toBeTruthy();
    const s = store.getState();
    expect(s.extras.map((x) => x.key)).toEqual([a, k, b]);
    const [src, dup] = s.extras;
    expect(dup.name).toBe('Warm 400 2');
    expect(core.validateExtraSlotName(dup.name)).toBeNull();
    expect(dup.name.length).toBeLessThanOrEqual(core.EXTRA_NAME_MAX);
    expect(dup.preset.result.params).toEqual(src.preset.result.params);
    expect(dup.preset.fileName).toBe('warm.cube');
    expect(dup.icon.text).toBe('400');
    expect(dup.icon.pixels).not.toBe(src.icon.pixels); // copied, not shared
    expect(new TextDecoder().decode(files.get('preset-' + k))).toBe('LUT_3D_SIZE 2 warm');
    const order = store.lookOrderNow();
    expect(order.indexOf(k)).toBe(order.indexOf(a) + 1);
    expect(s.activeSlot).toBe(k);
    // a second copy takes the next free number, and a long name is cut to fit
    store.setExtraName(a, 'ABCDEFGHIJKL');
    const k2 = store.duplicateExtraSlot(a);
    expect(store.getState().extras.find((x) => x.key === k2).name).toBe('ABCDEFGHIJ 2');
    expect(core.validateExtraSlotName(store.getState().extras.find((x) => x.key === k2).name)).toBeNull();
  });
  it('is refused at MAX_EXTRA_SLOTS with a reason, and changes nothing', async () => {
    store.setExtraCount(core.MAX_EXTRA_SLOTS);
    await vi.advanceTimersByTimeAsync(5);
    const before = store.getState().extras.map((x) => x.key);
    expect(store.duplicateExtraProblem()).toMatch(String(core.MAX_EXTRA_SLOTS));
    expect(store.duplicateExtraSlot(before[0])).toBeUndefined();
    expect(store.getState().extras.map((x) => x.key)).toEqual(before);
    expect(store.getState().toasts.at(-1).text).toMatch(String(core.MAX_EXTRA_SLOTS));
  });
  it('copying a slot whose fit is still running refits the copy instead of copying a half-done state', async () => {
    store.addExtraSlot();
    const a = store.getState().extras[0].key;
    let release;
    mocks.engine.convert.mockImplementationOnce(() => new Promise((r) => { release = () => r(fitted('slow')); }));
    const pending = store.loadPresetFile(a, file('slow.cube'));
    await vi.advanceTimersByTimeAsync(5);
    const k = store.duplicateExtraSlot(a);
    expect(store.getState().extras[1].preset.busy).toBe(true);
    release(); await pending; await vi.advanceTimersByTimeAsync(5);
    expect(store.getState().extras.find((x) => x.key === k).preset.busy).toBe(false);
    expect(store.getState().extras.find((x) => x.key === k).preset.result).toBeTruthy();
  });
});

describe('batch preset import', () => {
  const lastToast = () => store.getState().toasts.at(-1);
  it('one file behaves as before: it replaces whatever the given slot holds and asks nothing', async () => {
    await store.loadPresetFile('CY', file('old.cube', 'LUT_3D_SIZE 2 old'));
    await store.loadPresetFiles([file('new.cube', 'LUT_3D_SIZE 2 new')], 'CY');
    expect(store.getState().slots.CY.preset.fileName).toBe('new.cube');
    expect(store.getState().confirm).toBeUndefined();
  });
  it('3 files into a project with 2 empty slots fill them in order, then ask before adding a slot', async () => {
    const files3 = [file('a.cube'), file('b.cube'), file('c.cube')];
    const done = store.loadPresetFiles(files3, 'CG'); // dropped on Green: it goes first, then the free slot (Yellow)
    await vi.advanceTimersByTimeAsync(5);
    expect(store.getState().confirm.title).toBe('Add slots for the remaining presets?');
    expect(store.getState().confirm.lines.join(' ')).toContain('c.cube');
    expect(store.getState().slots.CG.preset.fileName).toBe('a.cube'); // the two free slots are filled before it asks
    expect(store.getState().slots.CY.preset.fileName).toBe('b.cube');
    expect(store.getState().extras).toHaveLength(0);
    store.answerConfirm(true);
    await vi.advanceTimersByTimeAsync(5); await done;
    const s = store.getState();
    expect(s.slots.CG.preset.fileName).toBe('a.cube');
    expect(s.slots.CY.preset.fileName).toBe('b.cube');
    expect(s.extras).toHaveLength(1);
    expect(s.extras[0].preset.fileName).toBe('c.cube');
    expect(s.busy).toBeUndefined();
    expect(lastToast()).toMatchObject({ kind: 'ok', text: '3 presets applied' });
  });
  it('declining the extra slot skips the rest; a failing file is reported by name; a slot with a preset is never overwritten', async () => {
    await store.loadPresetFile('CY', file('keep.cube', 'LUT_3D_SIZE 2 keep'));
    mocks.engine.convert.mockImplementation(async (_k, text) => { if (text.includes('BAD')) throw new Error('nope'); return fitted('ok ' + text.length); });
    const done = store.loadPresetFiles([file('bad.cube', 'BAD'), file('good.cube'), file('late.cube')], 'CY');
    await vi.advanceTimersByTimeAsync(5);
    store.answerConfirm(false);
    await vi.advanceTimersByTimeAsync(5); await done;
    const s = store.getState();
    expect(s.slots.CY.preset.fileName).toBe('keep.cube'); // untouched although it was the drop target
    expect(s.slots.CG.preset.fileName).toBe('bad.cube');
    expect(s.slots.CG.preset.error).toBeTruthy();
    expect(s.extras).toHaveLength(0);
    expect(lastToast().kind).toBe('error');
    expect(lastToast().text).toBe('0 presets applied · 2 skipped (no free slot) · 1 failed: bad.cube');
  });
  it('every key it stores is one the desktop host accepts', async () => {
    mocks.engine.convert.mockImplementation(async (_k, text) => fitted(text));
    store.setExtraCount(1); await vi.advanceTimersByTimeAsync(5);
    const done = store.loadPresetFiles([file('1.cube', 'one'), file('2.cube', 'two')]);
    await vi.advanceTimersByTimeAsync(5); await done; await vi.advanceTimersByTimeAsync(5);
    const keys = mocks.host.storeSet.mock.calls.map((c) => c[0]);
    expect(keys.length).toBeGreaterThan(0);
    // shell/internal/server/store.go keyPattern
    for (const k of keys) expect(k, k).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });
  it('runs fits one after another and shows progress', async () => {
    const order = []; const seen = [];
    mocks.engine.convert.mockImplementation(async (_k, text) => { order.push(text); seen.push(store.getState().busy); await Promise.resolve(); return fitted(text); });
    store.setExtraCount(1); await vi.advanceTimersByTimeAsync(5);
    const done = store.loadPresetFiles([file('1.cube', 'one'), file('2.cube', 'two'), file('3.cube', 'three')]);
    await vi.advanceTimersByTimeAsync(5); await done;
    expect(order).toEqual(['one', 'two', 'three']);
    expect(seen).toEqual(['Importing preset 1 of 3', 'Importing preset 2 of 3', 'Importing preset 3 of 3']);
    expect(store.getState().confirm).toBeUndefined(); // enough slots, nothing to ask
    expect(store.batchTargets()).toEqual([]);
  });
});
