// SPDX-License-Identifier: GPL-2.0-only
// Inspect any firmware file, and compare two, on the real UI store, the real dialog (server-rendered) and, when an
// official GR IV 1.21 file is at hand (GRMOD_GR4_121_FIRMWARE), the real engine's summary of a build with every addition on.
// @mock-exempt: the host (HTTP API), the engine worker (ui/src/engine.ts) and pixels / preview (canvas) are external boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CAMERA_GRID, Engine } from '@grmod/core';
import { testRatios } from '../../core/test/fw-helpers/test-firmware';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), inspect: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: true, info: { token: 't', kind: 'test', version: '9.9.9' }, join: (...p) => p.join('/'),
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), volumes: vi.fn(), sidecar: vi.fn(), parked: vi.fn(), backups: vi.fn(),
  },
}));
// Server rendering needs a server snapshot for useSyncExternalStore; the store has none (it is only ever rendered in a browser): the client one serves.
vi.mock('react', async (orig) => { const r = await orig(); return { ...r, useSyncExternalStore: (sub, get, server) => r.useSyncExternalStore(sub, get, server ?? get) }; });
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error { constructor(code, message) { super(message); this.code = code; } } }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: class extends Error { constructor(code, message) { super(message); this.code = code; } }, sha256Hex: async () => 'h', isAndroid: false, isMobile: false }));
vi.mock('../src/pixels', () => ({ ensureIconFont: vi.fn(), textIcon: vi.fn(() => new Uint8Array(1)), imageIcon: vi.fn(() => new Uint8Array(1)) }));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn() }));

const info = () => ({
  family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF'],
  capabilities: { build: true, presets: false, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
const file = (name, size = 20_000_000) => ({ name, size, arrayBuffer: async () => new Uint8Array([1]).buffer });
const sum = (over = {}) => ({ kind: 'modified', verified: true, changedBytes: 12, sha256: 'x', slots: [{ id: 'CY', names: { en: 'Yellow' }, icon: new Uint8Array(0), colorChanged: false, iconChanged: false, nameChanged: false }],
  ratios: [], softFocus: [], adjSoftFocus: false, dateStamp: false, monoUnlock: false, extraSlots: [], ...over });
let store, compare, i18n;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.host.available = true;
  mocks.host.storeGet.mockResolvedValue(null); mocks.host.storeSet.mockResolvedValue(); mocks.host.storeDel.mockResolvedValue(); mocks.host.storeList.mockResolvedValue([]);
  mocks.host.volumes.mockResolvedValue([]); mocks.host.sidecar.mockResolvedValue(null); mocks.host.parked.mockResolvedValue([]); mocks.host.backups.mockResolvedValue({ dir: '', entries: [] });
  mocks.engine.open.mockReset().mockResolvedValue(info());
  mocks.engine.heartbeat.mockResolvedValue(true);
  mocks.engine.ratio.mockImplementation(async (ratio) => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  const mem = new Map();
  vi.stubGlobal('localStorage', { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } });
  vi.stubGlobal('document', { hidden: true, getElementById: () => null });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = await import('../src/store');
  compare = await import('../src/compare');
  i18n = await import('../src/i18n');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('inspect any firmware file', () => {
  it('asks for an open official firmware first, without calling the engine', async () => {
    await store.inspectFile(file('x.bin'));
    expect(store.getState().inspectView).toMatchObject({ name: 'x.bin', busy: false, error: 'needs-open' });
    expect(mocks.engine.inspect).not.toHaveBeenCalled();
  });
  it('shows the summary the engine returns, and closes', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    const summary = sum({ adjSoftFocus: true });
    mocks.engine.inspect.mockResolvedValue(summary);
    await store.inspectFile(file('mod.bin'));
    expect(mocks.engine.inspect).toHaveBeenCalledTimes(1);
    expect(store.getState().inspectView).toMatchObject({ busy: false, summary });
    store.closeInspect();
    expect(store.getState().inspectView).toBeUndefined();
  });
  it('reports an unreadable file and a file of the wrong size as errors', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    mocks.engine.inspect.mockRejectedValue(new Error('bad'));
    await store.inspectFile(file('junk.bin'));
    expect(store.getState().inspectView).toMatchObject({ busy: false, error: 'unreadable' });
    await store.inspectFile(file('tiny.bin', 10));
    expect(store.getState().inspectView).toMatchObject({ error: 'size' });
    await store.inspectFile(file('huge.bin', 300_000_000));
    expect(store.getState().inspectView).toMatchObject({ error: 'size' });
  });
  it('an answer for a file the dialog has already left is dropped', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    let release;
    mocks.engine.inspect.mockImplementationOnce(() => new Promise((r) => { release = () => r(sum()); }));
    const pending = store.inspectFile(file('slow.bin'));
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().inspectView).toMatchObject({ busy: true });
    store.closeInspect();
    release(); await pending;
    expect(store.getState().inspectView).toBeUndefined();
  });
});

describe('compare two firmware files', () => {
  it('shows both summaries and marks only the rows that differ', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    const a = sum(), b = sum({ kind: 'official', changedBytes: 0, ratios: [{ name: 'Wide', ratio: '16:9', sizes: [[1, 1]] }], dateStamp: true, movie4k: true, slots: [{ id: 'CY', names: { en: 'Yellow' }, icon: new Uint8Array(0), colorChanged: true, iconChanged: false, nameChanged: false }] });
    mocks.engine.inspect.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    await store.inspectFile(file('a.bin'));
    await store.inspectCompare(file('b.bin'));
    const v = store.getState().inspectView;
    expect(v.other).toMatchObject({ name: 'b.bin', busy: false, summary: b });
    const rows = compare.compareRows(v.summary, v.other.summary, store.getState().lang);
    const diff = rows.filter((r) => r.differs).map((r) => r.label);
    expect(diff).toEqual(expect.arrayContaining([i18n.t('inspectKind'), i18n.t('inspectRatios'), i18n.t('navDate'), i18n.t('navMovie4k'), `${i18n.t('inspectSlots')} · ${i18n.t('slotShortCY')}`]));
    expect(rows.find((r) => r.label === i18n.t('inspectVerified'))).toMatchObject({ differs: false });
    expect(rows.find((r) => r.label === i18n.t('inspectRatios'))).toMatchObject({ a: i18n.t('inspectNone'), b: 'Wide (16:9)' });
    expect(rows.filter((r) => !r.differs).length).toBeGreaterThan(5);
    // the single-file view returns when the compare is closed or a new first file is chosen
    store.closeCompare(); expect(store.getState().inspectView.other).toBeUndefined();
    await store.inspectCompare(file('b.bin'));
    mocks.engine.inspect.mockResolvedValueOnce(a);
    await store.inspectFile(file('c.bin'));
    expect(store.getState().inspectView.other).toBeUndefined();
  });
  it('reports an unreadable second file without losing the first', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    mocks.engine.inspect.mockResolvedValueOnce(sum()).mockRejectedValueOnce(new Error('bad'));
    await store.inspectFile(file('a.bin')); await store.inspectCompare(file('junk.bin'));
    expect(store.getState().inspectView).toMatchObject({ summary: expect.anything(), other: { error: 'unreadable', busy: false } });
  });
  it('a second file needs a first that was read', async () => {
    await store.inspectCompare(file('b.bin'));
    expect(store.getState().inspectView).toBeUndefined();
    expect(mocks.engine.inspect).not.toHaveBeenCalled();
  });
});

describe('the dialog renders', () => {
  // React's server render puts <!-- --> between adjacent text parts; the text a user reads is without them
  const html = async () => { const { InspectDialog } = await import('../src/inspect'); return renderToString(createElement(InspectDialog)).replaceAll('<!-- -->', ''); };
  it('nothing while closed; the summary, the features it reports and the slots when open; the error when needed', async () => {
    expect(await html()).toBe('');
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    mocks.engine.inspect.mockResolvedValue(sum({ movieSr: true, adjSlots: 7, brightAuto: 'balanced' }));
    await store.inspectFile(file('mod.bin'));
    const out = await html();
    expect(out).toContain('mod.bin');
    expect(out).toContain(i18n.t('inspectKindModified'));
    expect(out).toContain(`${i18n.t('navMovieSr')}: ${i18n.t('inspectYes')}`);
    expect(out).toContain(`${i18n.t('navAdjSlots')}: ${i18n.t('inspectYes')} · 7`);
    expect(out).toContain(`${i18n.t('navMovie4k')}: ${i18n.t('inspectNo')}`);
    expect(out).toContain('Yellow');
    store.closeInspect();
    await store.inspectFile(file('x.bin', 5));
    expect(await html()).toContain(i18n.t('inspectSize'));
  });
  it('the side-by-side view renders both file names and the differing rows', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    mocks.engine.inspect.mockResolvedValueOnce(sum()).mockResolvedValueOnce(sum({ constantLight: true }));
    await store.inspectFile(file('a.bin')); await store.inspectCompare(file('b.bin'));
    const out = await html();
    expect(out).toContain('compare-table');
    expect(out).toContain('a.bin'); expect(out).toContain('b.bin');
    expect(out).toMatch(new RegExp(`class="diff"><th scope="row">${i18n.t('navLamp')}</th>`));
  });
});

describe('the features 0.9.2 reports all show', () => {
  it('featureRows has a row for every feature flag of the summary, under the build summary\'s names', () => {
    const flags = { adjSoftFocus: true, dateStamp: true, monoUnlock: true, brightAuto: 'bright', directFlash: true, hdrGainMap: true, exposurePreview: true, batteryPercent: true,
      customGrid: { g3: [], g4: [] }, shadowLearn: true, filmGrain: true, flashTtl: true, videoAf: true, awbLearn: true, movieExposure: true, constantLight: true, sensorShift: true,
      movie4k: true, movieSr: true, distanceFeet: true, adjSlots: 8, ratioShade: true, ratioShadeTone: 'light' };
    const rows = compare.featureRows(sum(flags), 'gr4');
    expect(rows.filter((r) => !r.on).map((r) => r.label)).toEqual([]);
    expect(rows.map((r) => r.label)).toEqual(['navSoft', 'navDate', 'navMono', 'navBrightAuto', 'navFlash', 'navHdr', 'navPreview', 'navBattery', 'navGrid', 'navShadow', 'navGrain', 'navFlashTtl', 'navVideoAf', 'navAwb', 'navMovieExp', 'navLamp', 'navShift', 'navMovie4k', 'navMovieSr', 'navUnits', 'navAdjSlots', 'ratioLive'].map((k) => i18n.t(k)));
    expect(rows.find((r) => r.label === i18n.t('navAdjSlots')).detail).toBe('8');
    expect(rows.find((r) => r.label === i18n.t('navUnits')).detail).toBe(i18n.t('unitsFeet'));
    // framing guides (1.20 / 1.21) take the custom grid's place, under the same name as in the build summary
    expect(compare.featureRows(sum({ framing: { palette: [], presets: [{ elements: [] }, { elements: [] }] } }), 'gr4').filter((r) => r.on).map((r) => r.label)).toEqual([i18n.t('navGrid')]);
    expect(compare.featureRows(sum(), 'gr4').every((r) => !r.on)).toBe(true);
    expect(compare.featureRows(sum({ monoUnlock: true }), 'gr3x').find((r) => r.on).label).toBe(i18n.t('gr3xReplicaTitle'));
  });
});

const path121 = process.env.GRMOD_GR4_121_FIRMWARE;
describe.skipIf(!path121 || !existsSync(path121))('the real engine\'s summary of GR IV 1.21 builds', () => {
  it('a build with every addition on is read back by inspect, and every feature shows in the dialog rows', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(path121)));
    const all = { adjSoftFocus: true, dateStamp: true, monoUnlock: true, directFlash: true, hdrGainMap: true, adjSlots: 8, exposurePreview: true, ratioShade: true, batteryPercent: true,
      videoAf: true, awbLearn: true, constantLight: true, movieExposure: true, sensorShift: true, movie4k: true, movieSr: true, distanceFeet: true, shadowLearn: true, filmGrain: true, flashTtl: true, brightAuto: 'balanced',
      customGrid: { g3: CAMERA_GRID.g3.map((b, i) => (i === 0 ? !b : b)), g4: [...CAMERA_GRID.g4] } };
    const built = await eng.buildFirmware([], testRatios(eng), [], all);
    const s = await eng.inspect(built.file);
    expect(s).toMatchObject({ kind: 'modified', verified: true });
    const rows = compare.featureRows(s, eng.info.family);
    expect(rows.filter((r) => !r.on).map((r) => r.label), 'a build with all on shows every feature').toEqual([]);
    const official = await eng.inspect(new Uint8Array(readFileSync(path121)));
    expect(compare.featureRows(official, eng.info.family).every((r) => !r.on)).toBe(true);
    const diff = compare.compareRows(official, s, 'en', eng.info.family);
    expect(diff.filter((r) => r.differs).length).toBeGreaterThan(20);
  });
});
