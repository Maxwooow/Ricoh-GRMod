// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as gr3x-ui-library.test.mjs)
// Render guard: the whole <App/> is server-rendered against the real store. A useStore selector that returns a fresh array or object
// per call never settles under useSyncExternalStore and blanks the app (React error #185); the store's dev guard turns that into an error here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { LANGS } from '../src/fw/names';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), convert: vi.fn(), heartbeat: vi.fn(), ratio: vi.fn() },
  host: {
    available: true, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), parked: vi.fn(), backups: vi.fn(), storeList: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn(), textIcon: vi.fn(() => new Uint8Array(1)), imageIcon: vi.fn(() => new Uint8Array(1)) }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

const caps = { build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false };
const gr4 = () => ({
  family: 'gr4', version: '1.11', filename: 'fwdc248b.bin', models: ['HDF'], capabilities: caps,
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false }, allowed: Object.fromEntries(LANGS.map(l => [l, ' Film1WarmDemo'])),
  slots: ['CY', 'CG'].map((id, i) => ({ id, defaultName: `Film ${i + 1}`, names: Object.fromEntries(LANGS.map(l => [l, { text: `Film ${i + 1}`, capacity: 24 }])) })),
  contentArea: { film: { x0: 0, y0: 0, x1: 1, y1: 1 }, plain: { x0: 0, y0: 0, x1: 1, y1: 1 } }, factoryRatios: ['3:2'], factoryEntry: { files: [] }, tiles: { film: new Uint8Array(1), plain: new Uint8Array(1) },
});

let store, App, files;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  files = new Map();
  mocks.host.available = true;
  mocks.host.storeSet.mockImplementation(async (key, value) => { files.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); });
  mocks.host.storeDel.mockImplementation(async (key) => { files.delete(key); });
  mocks.host.storeGet.mockImplementation(async (key) => files.get(key) ?? null);
  mocks.host.volumes.mockResolvedValue([]); mocks.host.sidecar.mockResolvedValue(null);
  mocks.host.parked.mockResolvedValue([]); mocks.host.backups.mockResolvedValue({ dir: '', entries: [] }); mocks.host.storeList.mockResolvedValue([]);
  mocks.engine.reset.mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // the preview photo cannot be fetched outside a browser
  mocks.engine.open.mockResolvedValue(gr4());
  vi.stubGlobal('document', { hidden: true, getElementById: () => null });
  store = await import('../../ui/src/store');
  ({ App } = await import('../../ui/src/app'));
  await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
  store.getState().ready || await store.init();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const html = () => renderToString(createElement(App));
const entry = (id, family, date) => ({ id, name: 'Look ' + id, kind: 'cube', family, fileName: id + '.cube', date });

describe('the whole app renders', () => {
  it('renders the sidebar and the page with a firmware open', () => {
    const out = html();
    expect(out).toContain('class="sidebar"');
    expect(out).toContain('data-tour="nav-ic"');
  });
  it('renders with a non-empty library, and with the library picker open in both modes', async () => {
    files.set('library.json', new TextEncoder().encode(JSON.stringify({ v: 1, entries: [entry('a', 'gr4', 1), entry('b', 'gr4', 2), entry('c', 'gr3', 3)] })));
    await store.loadLibrary();
    expect(store.getState().library).toHaveLength(3);
    expect(html()).toContain('class="sidebar"');
    store.openLibrary('CY', 'apply');
    const apply = html();
    expect(apply).toContain('lib-dialog');
    expect(apply).toContain('Look b');
    expect(apply).not.toContain('Look c'); // another camera family
    store.openLibrary('CY', 'save');
    expect(html()).toContain('lib-save');
  });
  it('renders every page, with an added slot, a ratio and a copy listed', () => {
    store.addExtraSlot();
    for (const page of ['ic', 'ratio', 'wall', 'copies']) { store.setPage(page); expect(html(), page).toContain('class="sidebar"'); }
  });
  it('the dev guard rejects a selector that returns a new object on every call', () => {
    const Bad = () => { store.useStore((s) => [...s.library]); return null; };
    expect(() => renderToString(createElement(Bad))).toThrow(/unstable|new (array|object)|every call/i);
  });
});
