// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs)
// Undo for deleted added slots, ratios and power-off pictures, on the real UI store with an in-memory host.
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

describe('undo for deletes', () => {
  it('brings a removed added slot back at its place, with its hidden state and as the active slot', async () => {
    const [a, b, c] = addSlots(3);
    store.setLookHidden(b, true); store.setActiveSlot(b);
    const order = store.lookOrderNow();
    store.removeExtraSlot(b);
    expect(store.getState().extras.map((x) => x.key)).toEqual([a, c]);
    expect(store.getState().activeSlot).toBe('CY');
    expect(store.getState().lookHidden).not.toContain(b);
    expect(lastToast().action.label).toBe(i18n.t('undo'));
    expect(store.undoPending()).toBe(true);
    pressUndo();
    expect(store.getState().extras.map((x) => x.key)).toEqual([a, b, c]);
    expect(store.getState().lookHidden).toContain(b);
    expect(store.getState().activeSlot).toBe(b);
    expect(store.lookOrderNow()).toEqual(order);
    expect(store.undoPending()).toBe(false);
    expect(store.getState().toasts.some((x) => x.action)).toBe(false); // the toast goes with the record
  });
  it('keeps the host file until the undo window closes, then deletes it; undo keeps it for good', async () => {
    const [a, b] = addSlots(2);
    mocks.files.set('preset-' + a, enc('a')); mocks.files.set('preset-' + b, enc('b'));
    store.removeExtraSlot(a);
    expect(mocks.host.storeDel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(13000);
    expect(mocks.host.storeDel).toHaveBeenCalledWith('preset-' + a);
    expect(store.undoPending()).toBe(false);
    mocks.host.storeDel.mockClear();
    store.removeExtraSlot(b); pressUndo();
    await vi.advanceTimersByTimeAsync(13000);
    expect(mocks.host.storeDel).not.toHaveBeenCalled();
    expect(mocks.files.has('preset-' + b)).toBe(true);
  });
  it('a new delete replaces the record and commits the earlier one', async () => {
    const [a, b] = addSlots(2);
    store.removeExtraSlot(a); store.removeExtraSlot(b);
    expect(mocks.host.storeDel).toHaveBeenCalledWith('preset-' + a);
    expect(mocks.host.storeDel).not.toHaveBeenCalledWith('preset-' + b);
    pressUndo();
    expect(store.getState().extras.map((x) => x.key)).toEqual([b]);
  });
  it('brings a removed ratio back at its index and as the active ratio', async () => {
    for (const r of ['4:3', '16:9', '5:4']) store.addRatio(r);
    await flush();
    const ids = store.getState().ratios.map((r) => r.id);
    store.setActiveRatio(ids[1]);
    store.removeRatio(ids[1]);
    expect(store.getState().ratios.map((r) => r.ratio)).toEqual(['4:3', '5:4']);
    pressUndo(); await flush();
    expect(store.getState().ratios.map((r) => r.ratio)).toEqual(['4:3', '16:9', '5:4']);
    expect(store.getState().activeRatio).toBe(ids[1]);
  });
  it('brings a removed power-off picture back at its index, and keeps or drops its host file as the window decides', async () => {
    await store.addWallFiles(['p1', 'p2', 'p3'].map((n) => new File([n], n + '.jpg', { type: 'image/jpeg' })));
    await flush();
    const ids = store.getState().wall.map((w) => w.id);
    expect(ids).toHaveLength(3);
    for (const id of ids) mocks.files.set('wall-' + id, enc(id));
    store.removeWall(ids[1]);
    expect(store.getState().wall.map((w) => w.id)).toEqual([ids[0], ids[2]]);
    expect(lastToast().text).toBe(i18n.t('undoWall'));
    expect(mocks.host.storeDel).not.toHaveBeenCalled();
    pressUndo();
    expect(store.getState().wall.map((w) => w.id)).toEqual(ids);
    await vi.advanceTimersByTimeAsync(13000);
    expect(mocks.files.has('wall-' + ids[1])).toBe(true);
    store.removeWall(ids[2]);
    await vi.advanceTimersByTimeAsync(13000);
    expect(mocks.files.has('wall-' + ids[2])).toBe(false);
  });
  it('Undo does nothing once the window has closed', async () => {
    const [k] = addSlots(1);
    store.removeExtraSlot(k);
    await vi.advanceTimersByTimeAsync(13000);
    store.undoDelete();
    expect(store.getState().extras).toEqual([]);
  });
  it('setting the count lower is not undoable', async () => {
    addSlots(3);
    store.setExtraCount(1);
    expect(store.undoPending()).toBe(false);
    expect(store.getState().extras).toHaveLength(1);
  });
});

describe('undo respects the caps', () => {
  it('refuses to restore an added slot when the list is full again, still deletes the file, and says so', async () => {
    while (store.getState().extras.length < 99) { const n = store.getState().extras.length; store.addExtraSlot(); if (store.getState().extras.length === n) break; }
    const cap = store.getState().extras.length; expect(cap).toBeGreaterThan(0); expect(cap).toBeLessThan(99);
    const gone = store.getState().extras[0].key;
    mocks.files.set('preset-' + gone, enc('x'));
    store.removeExtraSlot(gone);
    store.addExtraSlot();
    expect(store.getState().extras).toHaveLength(cap);
    store.undoDelete();
    expect(store.getState().extras).toHaveLength(cap);
    expect(store.getState().extras.map((x) => x.key)).not.toContain(gone);
    expect(mocks.files.has('preset-' + gone)).toBe(false);
    expect(lastToast().text).toBe(i18n.t('undoFull'));
  });
  it('refuses to restore a ratio past the maximum', async () => {
    const cap = store.maxRatios();
    for (let i = 0; i < cap; i++) store.addRatio(`${i + 2}:1`);
    await flush();
    expect(store.getState().ratios).toHaveLength(cap);
    store.removeRatio(store.getState().ratios[0].id);
    store.addRatio('99:1'); await flush();
    store.undoDelete(); await flush();
    expect(store.getState().ratios).toHaveLength(cap);
    expect(lastToast().text).toBe(i18n.t('undoFull'));
  });
});

describe('an Undo toast is bound to its own delete', () => {
  it('delete A then B: A\'s toast is dismissed, a stale press restores nothing, B stays undoable', async () => {
    const [a, b] = addSlots(2);
    store.removeExtraSlot(a); const toastA = lastToast();
    store.removeExtraSlot(b); const toastB = lastToast();
    expect(store.getState().toasts.map((x) => x.id)).not.toContain(toastA.id);
    toastA.action.run(); // a press that still got through
    expect(store.getState().extras).toEqual([]);
    expect(lastToast().text).toBe(i18n.t('undoGone'));
    expect(store.undoPending()).toBe(true);
    toastB.action.run();
    expect(store.getState().extras.map((x) => x.key)).toEqual([b]);
  });
});

describe('undo across models of one family', () => {
  it('HDF to Standard still restores; another family commits instead', async () => {
    const [k] = addSlots(1);
    mocks.files.set('preset-' + k, enc('x'));
    store.removeExtraSlot(k);
    store.setModel('STANDARD'); await flush();
    expect(store.undoPending()).toBe(true);
    store.undoDelete();
    expect(store.getState().extras.map((x) => x.key)).toEqual([k]);
    store.removeExtraSlot(k);
    store.setModel('GR3'); await flush();
    store.undoDelete();
    expect(store.getState().extras).toEqual([]);
    expect(mocks.files.has('preset-' + k)).toBe(false);
  });
});
