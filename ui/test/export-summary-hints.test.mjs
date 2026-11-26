// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as store-gr3.test.mjs)
// The build summary before a folder export (output.ts DEC-EXPORT-SUMMARY-001), the plain-language error hints
// (core.ts DEC-ERROR-HINT-001) and the one toast per run of failed project saves (families.ts saveProject), on the
// real UI store with an in-memory host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  /** Errors with a code, as the real engine and host throw them. */
  const coded = () => class extends Error { constructor(code, message = code) { super(message); this.code = code; } };
  return {
    EngineError: coded(), HostError: coded(),
    engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), inspect: vi.fn(), heartbeat: vi.fn() },
    host: {
      available: true, info: { token: 'test', kind: 'test', version: '9.9.9' },
      storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
      volumes: vi.fn(), list: vi.fn(), move: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
    },
  };
});
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: mocks.EngineError }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: mocks.HostError, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn() }));

const info = () => ({
  family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF'],
  capabilities: { build: true, presets: false, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
const MB = 1 << 20;
const card = { id: 'E:', root: '/card', label: 'CARD', fs: 'FAT32', total: 64 * 1024 * MB, free: 8 * 1024 * MB, removable: true, bus: 'USB' };
let store, t;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.host.available = true;
  mocks.engine.open.mockReset().mockResolvedValue(info());
  mocks.engine.ratio.mockImplementation(async (ratio) => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  mocks.engine.build.mockReset().mockResolvedValue({ file: new Uint8Array([9, 2]), checks: { integrity: true } });
  mocks.host.storeGet.mockReset().mockResolvedValue(null);
  mocks.host.storeSet.mockReset().mockResolvedValue(); mocks.host.storeDel.mockResolvedValue(); mocks.host.storeList.mockResolvedValue([]);
  mocks.host.pickDirectory.mockReset().mockResolvedValue('/chosen');
  mocks.host.write.mockReset().mockImplementation(async (_p, data) => ({ size: data.length, sha256: 'test-hash' }));
  mocks.host.list.mockResolvedValue([]); mocks.host.move.mockResolvedValue();
  mocks.host.volumes.mockResolvedValue([card]);
  vi.stubGlobal('document', { hidden: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = await import('../src/store');
  ({ t } = await import('../src/i18n'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
const lastToast = () => store.getState().toasts.at(-1);
const start = async () => {
  await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
  store.addRatio('4:3'); store.addRatio('16:9'); store.setSoft(true);
  await flush();
};
/** Start an export, wait for the summary, answer it, let the action finish. */
const answered = async (p, yes = true) => { await flush(); expect(store.getState().confirm).toBeTruthy(); store.answerConfirm(yes); await p; await flush(); };

describe('the build summary before a folder export', () => {
  it('lists what the build contains under the export title; Cancel picks no folder, builds nothing and writes nothing', async () => {
    await start();
    const pending = store.outputFirmware({ kind: 'folder' });
    await flush();
    const c = store.getState().confirm;
    expect(c).toMatchObject({ title: t('exportConfirmTitle'), ok: t('exportConfirmOk') });
    expect(c.reset).toBeFalsy();
    // the ratios as one line with their count, and the soft-focus switch
    expect(c.lines).toEqual(expect.arrayContaining([`${t('chkRatios')}  ·  ${t('chkCount', { n: 2 })}`, t('navSoft')]));
    store.answerConfirm(false); await pending; await flush();
    expect(mocks.host.pickDirectory).not.toHaveBeenCalled();
    expect(mocks.engine.build).not.toHaveBeenCalled();
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('picks the folder, builds and writes once the summary is confirmed', async () => {
    await start();
    await answered(store.outputFirmware({ kind: 'folder' }));
    expect(mocks.host.pickDirectory).toHaveBeenCalledTimes(1);
    expect(mocks.engine.build).toHaveBeenCalledTimes(1);
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', new Uint8Array([9, 2]));
  });
  it('the card keeps its own title', async () => {
    await start();
    await store.refreshVolumes();
    const pending = store.outputFirmware({ kind: 'card' });
    await flush();
    expect(store.getState().confirm).toMatchObject({ title: t('confirmTitle'), ok: t('confirmOk') });
    store.answerConfirm(false); await pending;
    expect(mocks.engine.build).not.toHaveBeenCalled();
  });
  it('the factory copy asks only its reset confirm, not the summary', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1, 2, 3]));
    const pending = store.outputFirmware({ kind: 'folder' }, true);
    await flush();
    expect(store.getState().confirm).toMatchObject({ reset: true, title: t('resetConfirmTitle') });
    store.answerConfirm(true); await pending; await flush();
    expect(store.getState().confirm).toBeUndefined();
    expect(mocks.engine.build).not.toHaveBeenCalled();
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', new Uint8Array([1, 2, 3]));
  });
});

describe('plain-language error hints', () => {
  // Every mapped code: the hint it gives, and for the host's `io` the system text that selects it.
  const cases = [
    ['engine', 'unsupported-firmware', '', 'hintFirmware'], ['engine', 'too-short', '', 'hintFirmware'],
    ['engine', 'unexpected-layout', '', 'hintFirmware'], ['engine', 'bad-checksum', '', 'hintFirmware'],
    ['engine', 'bad-footer', '', 'hintFirmware'], ['engine', 'bad-stream', '', 'hintFirmware'],
    ['engine', 'bad-stream-length', '', 'hintFirmware'], ['engine', 'bad-decoded-length', '', 'hintFirmware'],
    ['engine', 'bad-models', '', 'hintFirmware'], ['engine', 'gr3x-unsupported', '', 'hintUnsupportedHere'],
    ['engine', 'no-space', '', 'hintFwFull'], ['engine', 'too-many-ratios', '', 'hintTooMany'], ['engine', 'too-many-pictures', '', 'hintTooMany'],
    ['host', 'not-found', '', 'hintNotFound'], ['host', 'forbidden', '', 'hintDenied'], ['host', 'too-large', '', 'errTooBig'],
    ['host', 'network', '', 'fwNetError'], ['host', 'checksum', '', 'fwChecksum'], ['host', 'offline', '', 'hintOffline'], ['host', 'no-host', '', 'hintOffline'],
    ['host', 'io', 'write /card/fwdc243b.bin: no space left on device', 'hintCardFull'],
    ['host', 'io', 'There is not enough space on the disk.', 'hintCardFull'],
    ['host', 'io', 'open /card/fwdc243b.bin: read-only file system', 'hintWriteProtected'],
    ['host', 'io', 'The media is write protected.', 'hintWriteProtected'],
    ['host', 'io', 'Access is denied.', 'hintWriteProtected'],
    ['host', 'io', 'The device is not ready.', 'hintRemoved'],
    ['host', 'io', 'write /card/fwdc243b.bin: input/output error', 'hintRemoved'],
  ];
  it.each(cases)('%s %s %j: toasts its hint with the short code', (kind, code, message, hint) => {
    const E = kind === 'engine' ? mocks.EngineError : mocks.HostError;
    expect(store.errorHint(code, message)).toBe(hint);
    store.fail(new E(code, message || code));
    expect(lastToast()).toMatchObject({ kind: 'error', text: `${t('error')} · ${t(hint)} (${code})` });
  });
  it('an unknown code, or an io error with unknown text, keeps the code and the message', () => {
    expect(store.errorHint('bad-edit')).toBeUndefined();
    store.fail(new mocks.EngineError('bad-edit', 'slot CY: bad edit'));
    expect(lastToast().text).toBe(`${t('error')} · bad-edit · slot CY: bad edit`);
    expect(store.errorHint('io', 'something odd')).toBeUndefined();
    store.fail(new mocks.HostError('io', 'something odd'));
    expect(lastToast().text).toBe(`${t('error')} · io · something odd`);
    expect(store.errorHint('constructor')).toBeUndefined(); // not read off the object's prototype
  });
  it('a build that fails toasts the hint', async () => {
    await start();
    mocks.engine.build.mockRejectedValueOnce(new mocks.EngineError('no-space', 'IIIx RTOS exceeds its partition'));
    await answered(store.outputFirmware({ kind: 'folder' }));
    expect(lastToast().text).toBe(`${t('error')} · ${t('hintFwFull')} (no-space)`);
    expect(store.getState().busy).toBeUndefined();
  });
  it('a card write refused by a write-protected card toasts the write-protected hint', async () => {
    await start();
    await store.refreshVolumes();
    mocks.host.write.mockRejectedValueOnce(new mocks.HostError('io', 'open /card/fwdc243b.bin: read-only file system'));
    await answered(store.outputFirmware({ kind: 'card' }));
    expect(mocks.host.write).toHaveBeenCalledTimes(1);
    expect(lastToast().text).toBe(`${t('error')} · ${t('hintWriteProtected')} (io)`);
  });
});

describe('a failed project save', () => {
  const saveToasts = () => store.getState().toasts.filter((x) => x.text === t('saveFailed'));
  it('toasts once per run of failures, and the next good save starts a new run', async () => {
    mocks.host.storeSet.mockRejectedValue(new mocks.HostError('io', 'no space left on device'));
    await store.saveProject();
    await store.saveProject();
    await store.saveProject();
    expect(saveToasts()).toHaveLength(1);
    expect(saveToasts()[0].kind).toBe('error');
    mocks.host.storeSet.mockResolvedValue();
    await store.saveProject();
    expect(saveToasts()).toHaveLength(1);
    store.getState().toasts.forEach((x) => store.dismissToast(x.id));
    mocks.host.storeSet.mockRejectedValue(new mocks.HostError('io', 'no space left on device'));
    await store.saveProject();
    await store.saveProject();
    expect(saveToasts()).toHaveLength(1);
  });
  it('edits after start-up: the debounced saves toast once while they keep failing', async () => {
    await store.init();
    await vi.advanceTimersByTimeAsync(401);
    expect(store.getState().ready).toBe(true);
    mocks.host.storeSet.mockRejectedValue(new mocks.HostError('io', 'no space left on device'));
    store.addRatio('4:3'); store.scheduleSave(); await vi.advanceTimersByTimeAsync(401);
    store.addRatio('16:9'); store.scheduleSave(); await vi.advanceTimersByTimeAsync(401);
    expect(mocks.host.storeSet.mock.calls.filter(([k]) => k === 'project.json').length).toBeGreaterThanOrEqual(2);
    expect(saveToasts()).toHaveLength(1);
  });
});
