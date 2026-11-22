// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as gr3x-ui.test.mjs)
// QoL wave B: undo for deletes, the export summary and the keyboard shortcuts, on the real UI store with an in-memory host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), inspect: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: false, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
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
  mocks.engine.ratio.mockImplementation(async ratio => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  mocks.engine.build.mockResolvedValue({ file: new Uint8Array([9, 2]), checks: { integrity: true } });
  mocks.host.storeSet.mockResolvedValue(); mocks.host.storeDel.mockResolvedValue();
  mocks.host.storeGet.mockReset().mockResolvedValue(null);
  mocks.host.pickDirectory.mockReset().mockResolvedValue('/chosen');
  mocks.host.write.mockImplementation(async (_p, data) => ({ size: data.length, sha256: 'test-hash' }));
  mocks.host.volumes.mockResolvedValue([]);
  vi.stubGlobal('document', { hidden: true });
  store = await import('../../ui/src/store');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = () => vi.advanceTimersByTimeAsync(1);
/** Press the Undo button of the newest toast, as a user would. */
const pressUndo = () => store.getState().toasts.at(-1).action.run();

describe('undo for deletes', () => {
  it('brings a removed added slot back at its place, with its hidden state and as the active slot', async () => {
    for (let i = 0; i < 3; i++) store.addExtraSlot();
    const [a, b, c] = store.getState().extras.map(x => x.key);
    store.setLookHidden(b, true); store.setActiveSlot(b);
    const order = store.lookOrderNow();
    store.removeExtraSlot(b);
    expect(store.getState().extras.map(x => x.key)).toEqual([a, c]);
    expect(store.getState().activeSlot).toBe('CY');
    expect(store.getState().lookHidden).not.toContain(b);
    expect(store.getState().toasts.at(-1).action.label).toBeTruthy();
    expect(store.undoPending()).toBe(true);
    pressUndo();
    expect(store.getState().extras.map(x => x.key)).toEqual([a, b, c]);
    expect(store.getState().lookHidden).toContain(b);
    expect(store.getState().activeSlot).toBe(b);
    expect(store.lookOrderNow()).toEqual(order);
    expect(store.undoPending()).toBe(false);
  });
  it('keeps the host file until the undo window closes, then deletes it; undo keeps it for good', async () => {
    mocks.host.available = true;
    store.addExtraSlot(); store.addExtraSlot();
    const [a, b] = store.getState().extras.map(x => x.key);
    store.removeExtraSlot(a);
    expect(mocks.host.storeDel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(13000);
    expect(mocks.host.storeDel).toHaveBeenCalledWith('preset-' + a);
    expect(store.undoPending()).toBe(false);
    mocks.host.storeDel.mockClear();
    store.removeExtraSlot(b); pressUndo();
    await vi.advanceTimersByTimeAsync(13000);
    expect(mocks.host.storeDel).not.toHaveBeenCalled();
  });
  it('a new delete replaces the record and commits the earlier one', async () => {
    mocks.host.available = true;
    store.addExtraSlot(); store.addExtraSlot();
    const [a, b] = store.getState().extras.map(x => x.key);
    store.removeExtraSlot(a); store.removeExtraSlot(b);
    expect(mocks.host.storeDel).toHaveBeenCalledWith('preset-' + a);
    expect(mocks.host.storeDel).not.toHaveBeenCalledWith('preset-' + b);
    pressUndo();
    expect(store.getState().extras.map(x => x.key)).toEqual([b]);
  });
  it('brings a removed ratio back at its index and as the active ratio', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    for (const r of ['4:3', '16:9', '5:4']) store.addRatio(r);
    await flush();
    const ids = store.getState().ratios.map(r => r.id);
    store.setActiveRatio(ids[1]);
    store.removeRatio(ids[1]);
    expect(store.getState().ratios.map(r => r.ratio)).toEqual(['4:3', '5:4']);
    pressUndo();
    await flush();
    expect(store.getState().ratios.map(r => r.ratio)).toEqual(['4:3', '16:9', '5:4']);
    expect(store.getState().activeRatio).toBe(ids[1]);
  });
  it('Undo does nothing once the window has closed', async () => {
    store.addExtraSlot(); const k = store.getState().extras[0].key;
    store.removeExtraSlot(k);
    await vi.advanceTimersByTimeAsync(13000);
    store.undoDelete();
    expect(store.getState().extras).toEqual([]);
  });
});

const file = (name, size, bytes = [1]) => ({ name, size, arrayBuffer: async () => new Uint8Array(bytes).buffer });

describe('inspect any firmware file', () => {
  it('asks for an open official firmware first, without calling the engine', async () => {
    await store.inspectFile(file('x.bin', 20_000_000));
    expect(store.getState().inspectView).toMatchObject({ name: 'x.bin', busy: false, error: 'needs-open' });
    expect(mocks.engine.inspect).not.toHaveBeenCalled();
  });
  it('shows the summary the engine returns, and closes', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    const summary = { kind: 'modified', verified: true, changedBytes: 12, slots: [], ratios: [], softFocus: [], adjSoftFocus: true, dateStamp: false, monoUnlock: false, hlgPhoto: false, extraSlots: [] };
    mocks.engine.inspect.mockResolvedValue(summary);
    await store.inspectFile(file('mod.bin', 20_000_000));
    expect(mocks.engine.inspect).toHaveBeenCalledTimes(1);
    expect(store.getState().inspectView).toMatchObject({ busy: false, summary });
    store.closeInspect();
    expect(store.getState().inspectView).toBeUndefined();
  });
  it('reports an unreadable file and a file of the wrong size as errors', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.engine.inspect.mockRejectedValue(new Error('bad'));
    await store.inspectFile(file('junk.bin', 20_000_000));
    expect(store.getState().inspectView).toMatchObject({ busy: false, error: 'unreadable' });
    await store.inspectFile(file('tiny.bin', 10));
    expect(store.getState().inspectView).toMatchObject({ error: 'size' });
  });
});

describe('summary before export', () => {
  const start = async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.addRatio('4:3'); store.addRatio('16:9');
    store.setSoft(true);
    await flush();
  };
  it('lists what the build contains, and Cancel builds nothing and writes nothing', async () => {
    await start();
    const pending = store.outputFirmware({ kind: 'folder' });
    await flush();
    const c = store.getState().confirm;
    expect(c).toBeTruthy();
    // 0.8.12's short form: the ratios as one line with their count, not by name
    expect(c.lines).toContain('Added aspect ratios  ·  2');
    expect(c.lines.length).toBeGreaterThanOrEqual(2); // the ratios and the soft-focus switch
    store.answerConfirm(false); await pending;
    expect(mocks.engine.build).not.toHaveBeenCalled();
    expect(mocks.host.pickDirectory).not.toHaveBeenCalled();
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('builds and writes once the summary is confirmed', async () => {
    await start();
    const pending = store.outputFirmware({ kind: 'folder' });
    await flush();
    store.answerConfirm(true); await pending;
    expect(mocks.engine.build).toHaveBeenCalledTimes(1);
    expect(mocks.host.write).toHaveBeenCalledTimes(1);
  });
  it('does not ask for the factory firmware copy (that keeps its own reset confirm)', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    const pending = store.outputFirmware({ kind: 'folder' }, true);
    await flush();
    expect(store.getState().confirm).toMatchObject({ reset: true });
    store.answerConfirm(false); await pending;
    expect(mocks.engine.build).not.toHaveBeenCalled();
  });
});

describe('keyboard shortcuts', () => {
  const press = (key, extra = {}) => { const e = { key, preventDefault: vi.fn(), ...extra }; return { taken: store.handleShortcut(e), e }; };
  it('ignores keys typed in an input, a textarea or a contenteditable, and does not undo there', async () => {
    store.addExtraSlot(); store.removeExtraSlot(store.getState().extras[0].key);
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
      const { taken, e } = press('z', { metaKey: true, target });
      expect(taken).toBe(false); expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(store.getState().extras).toEqual([]);
    expect(store.undoPending()).toBe(true);
    expect(press('z', { ctrlKey: true, target: { tagName: 'BODY' } }).taken).toBe(true);
    expect(store.getState().extras).toHaveLength(1);
  });
  it('Cmd/Ctrl+Z does nothing when no delete is pending', () => {
    const { taken, e } = press('z', { metaKey: true });
    expect(taken).toBe(false); expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('Cmd/Ctrl+E starts the export through the summary; a field or an open dialog blocks it', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.addRatio('4:3'); await flush();
    expect(press('e', { metaKey: true, target: { tagName: 'INPUT' } }).taken).toBe(false);
    expect(press('e', { ctrlKey: true }).taken).toBe(true);
    await flush();
    expect(store.getState().confirm).toBeTruthy();
    expect(mocks.engine.build).not.toHaveBeenCalled(); // the summary comes first
    expect(press('e', { ctrlKey: true }).taken).toBe(false); // a dialog is open now
    store.answerConfirm(false);
    await flush();
    expect(mocks.engine.build).not.toHaveBeenCalled();
  });
  it('arrows move the active slot on the Image Control page and the active ratio on the Ratio page', async () => {
    store.addExtraSlot();
    const x = store.getState().extras[0].key;
    expect(store.getState().activeSlot).toBe('CY');
    expect(press('ArrowRight').taken).toBe(true); expect(store.getState().activeSlot).toBe('CG');
    press('ArrowRight'); expect(store.getState().activeSlot).toBe(x);
    press('ArrowRight'); expect(store.getState().activeSlot).toBe(x); // clamped at the end
    press('ArrowLeft'); expect(store.getState().activeSlot).toBe('CG');
    expect(press('ArrowLeft', { target: { tagName: 'INPUT' } }).taken).toBe(false);
    expect(press('ArrowDown').taken).toBe(false); // not the ratio page
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    for (const r of ['4:3', '16:9', '5:4']) store.addRatio(r);
    await flush();
    store.setPage('ratio');
    const ids = store.getState().ratios.map(r => r.id);
    store.setActiveRatio(ids[0]);
    press('ArrowDown'); expect(store.getState().activeRatio).toBe(ids[1]);
    press('ArrowDown'); press('ArrowDown'); expect(store.getState().activeRatio).toBe(ids[2]);
    press('ArrowUp'); expect(store.getState().activeRatio).toBe(ids[1]);
    expect(press('ArrowRight').taken).toBe(false);
  });
  it('production sequence: delete a ratio, press Undo by key, then export', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    for (const r of ['4:3', '16:9']) store.addRatio(r);
    await flush();
    store.removeRatio(store.getState().ratios[0].id);
    expect(press('z', { metaKey: true }).taken).toBe(true);
    await flush();
    expect(store.getState().ratios.map(r => r.ratio)).toEqual(['4:3', '16:9']);
    expect(press('e', { metaKey: true }).taken).toBe(true);
    await flush();
    expect(store.getState().confirm.lines).toContain('Added aspect ratios  ·  2');
    store.answerConfirm(true); await flush(); await flush();
    expect(mocks.engine.build).toHaveBeenCalledTimes(1);
  });
});
