// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs)
// The card space check before writing firmware (output.ts preflightCard, DEC-CARD-PREFLIGHT-001), on the real UI store
// with an in-memory host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), inspect: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: true, info: { token: 'test', kind: 'test', version: '9.9.9' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), list: vi.fn(), move: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn() }));

const info = () => ({
  family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF'],
  capabilities: { build: true, presets: false, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
const MB = 1 << 20;
const card = (free) => ({ id: 'E:', root: '/card', label: 'CARD', fs: 'FAT32', total: 64 * 1024 * MB, free, removable: true, bus: 'USB' });
let store;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.host.available = true;
  mocks.engine.open.mockReset().mockResolvedValue(info());
  mocks.engine.ratio.mockImplementation(async (ratio) => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  mocks.engine.build.mockResolvedValue({ file: new Uint8Array([9, 2]), checks: { integrity: true } });
  mocks.host.storeGet.mockReset().mockResolvedValue(null);
  mocks.host.storeSet.mockResolvedValue(); mocks.host.storeDel.mockResolvedValue(); mocks.host.storeList.mockResolvedValue([]);
  mocks.host.pickDirectory.mockReset().mockResolvedValue('/chosen');
  mocks.host.write.mockImplementation(async (_p, data) => ({ size: data.length, sha256: 'test-hash' }));
  mocks.host.list.mockResolvedValue([]); mocks.host.move.mockResolvedValue();
  mocks.host.volumes.mockResolvedValue([card(8 * 1024 * MB)]);
  vi.stubGlobal('document', { hidden: true });
  store = await import('../src/store');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
/** The build is confirmed in a dialog first: wait for it, answer it, let the action finish. */
const confirmed = async (p, yes = true) => { await flush(); expect(store.getState().confirm).toBeTruthy(); store.answerConfirm(yes); await p; await flush(); };
const start = async () => { await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1])); store.addRatio('4:3'); await flush(); await store.refreshVolumes(); };
const lastToast = () => store.getState().toasts.at(-1)?.text ?? '';

describe('card preflight', () => {
  it('refuses a card write when free space is short, says needed vs free, and writes and builds nothing', async () => {
    await start();
    mocks.host.volumes.mockResolvedValue([card(300_000)]); // the cached list (8 GB) is stale
    await confirmed(store.outputFirmware({ kind: 'card' }));
    expect(mocks.host.write).not.toHaveBeenCalled();
    expect(mocks.host.move).not.toHaveBeenCalled();
    expect(mocks.engine.build).not.toHaveBeenCalled();
    expect(lastToast()).toMatch(/Not enough space on card E:/);
    expect(lastToast()).toMatch(/needed/); expect(lastToast()).toMatch(/free/);
    expect(store.getState().busy).toBeUndefined();
  });
  it('refuses a stock copy and a copy-sized file the same way, through preflightCard', async () => {
    await start();
    const v = card(5 * MB);
    mocks.host.volumes.mockResolvedValue([v]);
    expect(await store.preflightCard(v, 4 * MB + 1)).toBe(false);
    expect(await store.preflightCard(v, 4 * MB)).toBe(true); // exactly the free space once the 1 MiB margin is added
    expect(await store.preflightCard(v, 3 * MB)).toBe(true);
  });
  it('refuses a card that is gone, and writes when the card has room (the real sequence: gone, reinserted, retried)', async () => {
    await start();
    mocks.host.volumes.mockResolvedValue([]);
    await confirmed(store.outputFirmware({ kind: 'card' }));
    expect(mocks.host.write).not.toHaveBeenCalled();
    expect(lastToast()).toMatch(/no longer there/);
    expect(store.getState().busy).toBeUndefined();
    mocks.host.volumes.mockResolvedValue([card(8 * 1024 * MB)]);
    await store.refreshVolumes();
    await confirmed(store.outputFirmware({ kind: 'card' }));
    expect(mocks.host.write).toHaveBeenCalledTimes(1);
    expect(mocks.engine.build).toHaveBeenCalledTimes(1);
  });
  it('a card with no size reported is not refused', async () => {
    await start();
    const v = { ...card(0), total: 0 };
    mocks.host.volumes.mockResolvedValue([v]);
    expect(await store.preflightCard(v, 50 * MB)).toBe(true);
  });
  it('does not look at volumes for a folder export, even when the card list says it is full', async () => {
    await start();
    mocks.host.volumes.mockClear();
    mocks.host.volumes.mockResolvedValue([card(1)]);
    // a modified folder export asks the build summary first, as the card does (output.ts DEC-EXPORT-SUMMARY-001)
    await confirmed(store.outputFirmware({ kind: 'folder' }));
    expect(mocks.host.write).toHaveBeenCalledTimes(1);
    // the only volume query is the list refresh after the write, never a check before it
    for (const o of mocks.host.volumes.mock.invocationCallOrder) expect(o).toBeGreaterThan(mocks.host.write.mock.invocationCallOrder[0]);
  });
});
