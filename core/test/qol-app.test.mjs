// SPDX-License-Identifier: GPL-2.0-only
// QoL wave A: save-failure toast, error hints, project export / import, app UI language.
// The store and i18n are the real modules. Only external boundaries are replaced: the host (HTTP API,
// here an in-memory file store), the engine (a Web Worker) and pixels / preview (browser canvas APIs).
// @mock-exempt: host = HTTP boundary, engine = Web Worker boundary, pixels/preview = browser canvas; same pattern as gr3x-ui.test.mjs
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map(),
  engine: { open: vi.fn(), reset: vi.fn(), ratio: vi.fn(), heartbeat: vi.fn() },
  host: { available: true, info: { token: 't', kind: 'test', version: '9.9.9', os: 'linux' }, sep: '/', join: (...p) => p.join('/'),
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), volumes: vi.fn(), sidecar: vi.fn() },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error { constructor(code, message) { super(message); this.code = code; } } }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error { constructor(code, message) { super(message); this.code = code; } }, sha256Hex: async () => 'h', isAndroid: false, isMobile: false }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

const local = new Map(), session = new Map();
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
let store, i18n, EngineError, HostError;
beforeEach(async () => {
  local.clear(); session.clear();
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.files.clear();
  mocks.host.available = true;
  mocks.host.storeGet.mockImplementation(async (k) => mocks.files.get(k) ?? null);
  mocks.host.storeSet.mockImplementation(async (k, d) => { mocks.files.set(k, typeof d === 'string' ? enc(d) : d); });
  mocks.host.storeDel.mockImplementation(async (k) => { mocks.files.delete(k); });
  mocks.host.storeList.mockImplementation(async () => [...mocks.files].map(([key, v]) => ({ key, size: v.length })));
  mocks.host.volumes.mockResolvedValue([]);
  mocks.host.sidecar.mockResolvedValue(null);
  mocks.engine.heartbeat.mockResolvedValue(true);
  vi.stubGlobal('document', { hidden: true });
  // the page's storage (the app language lives in localStorage; sessionStorage guards the one-off adoption reload); kept across vi.resetModules() like a restart
  const storageOf = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } });
  vi.stubGlobal("localStorage", storageOf(local)); vi.stubGlobal("sessionStorage", storageOf(session));
  store = await import('../../ui/src/store');
  i18n = await import('../../ui/src/i18n');
  ({ EngineError } = await import('../../ui/src/engine'));
  ({ HostError } = await import('../../ui/src/host'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const errorToasts = () => store.getState().toasts.filter((x) => x.kind === 'error');
const save = async () => { await vi.advanceTimersByTimeAsync(500); };
const okSet = async (k, d) => { mocks.files.set(k, typeof d === 'string' ? enc(d) : d); };

describe('save failure toast', () => {
  it('toasts once per failure streak and again after a successful save', async () => {
    await store.init();
    mocks.host.storeSet.mockRejectedValue(new Error('disk full'));
    store.setSoft(true); await save();
    expect(errorToasts()).toHaveLength(1);
    store.setSoft(false); await save(); store.setSoft(true); await save(); // still failing: no further toast
    expect(errorToasts()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith('save failed', expect.anything());
    mocks.host.storeSet.mockImplementation(okSet);
    store.setSoft(false); await save(); // success resets the streak
    mocks.host.storeSet.mockRejectedValue(new Error('disk full'));
    store.setSoft(true); await save();
    expect(errorToasts()).toHaveLength(2);
  });
});

describe('plain-language error hints', () => {
  it('maps known codes to a hint plus the short code, and leaves unknown codes alone', () => {
    store.fail(new EngineError('bad-hlg', 'the HLG photo mode cannot be combined with the HDR gain map'));
    store.fail(new HostError('not-found', 'open /x: no such file'));
    store.fail(new HostError('io', 'write: no space left on device'));
    store.fail(new HostError('io', 'weird failure'));
    store.fail(new EngineError('bad-edit', 'edit 7 out of range'));
    const texts = store.getState().toasts.map((x) => x.text); // the list keeps the last three
    expect(texts[0]).toContain(i18n.t('hintCardFull'));
    expect(texts[0]).toContain('(io)');
    expect(texts[1]).toMatch(/io · weird failure$/);
    expect(texts[2]).toMatch(/bad-edit · edit 7 out of range$/);
  });
  it('covers the user-actionable engine and host codes', () => {
    for (const c of ['unsupported-firmware', 'too-short', 'bad-hlg', 'no-space', 'not-found', 'forbidden', 'offline', 'network']) expect(store.errorHint(c), c).toBeTruthy();
    expect(store.errorHint('io', 'The device is not ready.')).toBe('hintRemoved');
    expect(store.errorHint('io', 'There is not enough space on the disk.')).toBe('hintCardFull');
    for (const c of ['bad-edit', 'internal', 'toString', '__proto__', 'cancelled']) expect(store.errorHint(c), c).toBeUndefined();
    expect(store.isBadFirmwareCode('bad-anything')).toBe(true);
  });
});

describe('app language (one setting; the camera menu language follows it)', () => {
  const fresh = async () => { vi.resetModules(); const s = await import('../../ui/src/store'); const i = await import('../../ui/src/i18n'); return { s, i }; };
  const system = (...languages) => vi.stubGlobal('navigator', { language: languages[0], languages });
  it('a fresh install follows the system for the app and the camera', async () => {
    system('zh-CN');
    let { s, i } = await fresh();
    expect(i.uiLangPref()).toBe('');
    expect(i.uiLangCode()).toBe('zh');
    expect(s.getState().lang).toBe('zh-CN'); expect(s.getState().langAuto).toBe(true);
    system('en-GB', 'en');
    ({ s, i } = await fresh());
    expect(i.uiLangCode()).toBe('en'); expect(i.t('projectExport')).toBe('Export project…');
  });
  it('简体中文 switches the app and gives zh-CN camera names; it is saved in the project and kept across a restart', async () => {
    await store.init();
    await store.setAppLanguage('zh');
    expect(JSON.parse(dec(mocks.files.get('project.json'))).uiLang).toBe('zh');
    expect(local.get('grmod.uiLang')).toBe('zh');
    const { s, i } = await fresh(); // the restart: the page reloads in the new language
    expect(i.t('projectExport')).toBe('导出项目…'); expect(i.uiLangCode()).toBe('zh');
    await s.init();
    expect(s.getState().lang).toBe('zh-CN');
    await s.setAppLanguage('en');
    const r2 = await fresh(); await r2.s.init();
    expect(r2.i.t('projectExport')).toBe('Export project…'); expect(r2.s.getState().lang).toBe('en');
  });
  it('Follow system follows the system for both: Chinese system, a language the camera has, one it does not', async () => {
    await store.init(); await store.setAppLanguage('zh'); await store.setAppLanguage('');
    expect(local.get('grmod.uiLang')).toBe('auto');
    expect(JSON.parse(dec(mocks.files.get('project.json'))).uiLang).toBe('');
    system('zh-TW', 'en');
    let r = await fresh(); await r.s.init();
    expect(r.i.uiLangCode()).toBe('zh'); expect(r.s.getState().lang).toBe('zh-TW'); expect(r.s.getState().langAuto).toBe(true);
    system('fr-FR', 'en');
    r = await fresh(); await r.s.init();
    expect(r.i.uiLangCode()).toBe('en'); expect(r.s.getState().lang).toBe('fr'); // the app has no French: English; the camera has
    system('xx-YY');
    r = await fresh(); await r.s.init();
    expect(r.s.getState().lang).toBe('en');
  });
  it('a saved language the page has lost (storage cleared) is taken back once; an earlier "auto" means follow system', async () => {
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', uiLang: 'zh' })));
    await store.init();
    expect(local.get('grmod.uiLang')).toBe('zh'); // the page would reload in it
    expect(store.getState().lang).toBe('zh-CN');
    local.clear(); session.clear(); system('de-DE');
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', uiLang: 'auto' })));
    const { s } = await fresh(); await s.init();
    expect(local.get('grmod.uiLang') ?? 'auto').toBe('auto'); expect(s.getState().lang).toBe('de'); // follows the system (nothing stored is the same)
  });
  it('the production sequence: switch, restart, import a project saved in the other language', async () => {
    await store.init(); await store.setAppLanguage('zh');
    const { s, i } = await fresh(); await s.init();
    const p = await s.buildProjectExport();
    expect(p.project.uiLang).toBe('zh');
    await s.applyProjectExport({ ...p, project: { ...p.project, uiLang: 'en', lang: 'ja' } });
    expect(i.uiLangCode()).toBe('zh'); expect(s.getState().lang).toBe('zh-CN'); expect(local.get('grmod.uiLang')).toBe('zh');
    expect(JSON.parse(dec(mocks.files.get('project.json'))).uiLang).toBe('zh');
  });
});

describe('project export and import', () => {
  const seed = () => {
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', lang: 'en', soft: true, slots: { CY: { preset: { fileName: 'a.cube', kind: 'cube' }, names: {}, icon: { mode: 'keep', text: '', style: 'film' } } } })));
    mocks.files.set('project-gr3.json', enc(JSON.stringify({ v: 1, filmCount: 3 })));
    mocks.files.set('preset-cy', enc('LUT_3D_SIZE 2\n0 0 0\n'));
    mocks.files.set('gr3-preset-cy', enc('gr3 preset'));
    mocks.files.set('wall-abc', new Uint8Array([0xff, 0xd8, 0, 1, 2, 255]));
    mocks.files.set('firmware-gr4.bin', new Uint8Array([1, 2, 3]));
    mocks.files.set('builds.json', enc('[]'));
  };
  it('exports docs and dependent files, but not the official firmware', async () => {
    seed();
    await store.init();
    const p = await store.buildProjectExport();
    expect(p).toMatchObject({ format: 'grmod-project', formatVersion: 1, appVersion: '9.9.9' });
    expect(Object.keys(p.files).sort()).toEqual(['gr3-preset-cy', 'preset-cy', 'wall-abc']);
    expect(p.project.soft).toBe(true);
    expect(p.projectGr3.filmCount).toBe(3);
  });
  it('round-trips: import into another store restores the docs, the preset and the picture', async () => {
    seed();
    await store.init();
    const text = JSON.stringify(await store.buildProjectExport());
    mocks.files.clear();
    mocks.files.set('preset-old', enc('stale')); // a project file the import does not contain goes away
    mocks.files.set('firmware-gr4.bin', new Uint8Array([7]));
    vi.resetModules();
    const s2 = await import('../../ui/src/store');
    await s2.init();
    const done = s2.importProject(new File([text], 'p.grmod.json'));
    await vi.advanceTimersByTimeAsync(1);
    expect(s2.getState().confirm?.title).toBeTruthy(); // the existing ask() dialog
    s2.answerConfirm(true);
    await done;
    expect(s2.getState()).toMatchObject({ soft: true, busy: undefined });
    expect(s2.getState().slots.CY.preset).toMatchObject({ fileName: 'a.cube', kind: 'cube', text: 'LUT_3D_SIZE 2\n0 0 0\n' });
    expect([...mocks.files.get('wall-abc')]).toEqual([0xff, 0xd8, 0, 1, 2, 255]);
    expect(dec(mocks.files.get('gr3-preset-cy'))).toBe('gr3 preset');
    expect(mocks.files.has('preset-old')).toBe(false);
    expect([...mocks.files.get('firmware-gr4.bin')]).toEqual([7]); // firmware untouched
    expect(JSON.parse(dec(mocks.files.get('project-gr3.json'))).filmCount).toBe(3);
  });
  it('declining the confirmation changes nothing', async () => {
    seed();
    await store.init();
    const text = JSON.stringify(await store.buildProjectExport());
    mocks.files.set('preset-cy', enc('mine'));
    const done = store.importProject(new File([text], 'p.json'));
    await vi.advanceTimersByTimeAsync(1);
    store.answerConfirm(false); await done;
    expect(dec(mocks.files.get('preset-cy'))).toBe('mine');
  });
  it.each([
    ['not json', 'nope{'],
    ['wrong format', JSON.stringify({ format: 'other', formatVersion: 1 })],
    ['no project doc', JSON.stringify({ format: 'grmod-project', formatVersion: 1, files: {} })],
    ['bad file key', JSON.stringify({ format: 'grmod-project', formatVersion: 1, project: { v: 1 }, files: { 'firmware-gr4.bin': 'AA==' } })],
    ['bad base64', JSON.stringify({ format: 'grmod-project', formatVersion: 1, project: { v: 1 }, files: { 'preset-cy': '***' } })],
    ['newer version', JSON.stringify({ format: 'grmod-project', formatVersion: 99, project: { v: 1 }, files: {} })],
  ])('rejects a malformed file loudly and writes nothing: %s', async (_n, text) => {
    await store.init();
    mocks.host.storeSet.mockClear();
    await store.importProject(new File([text], 'bad.json'));
    expect(errorToasts()).toHaveLength(1);
    expect(store.getState().confirm).toBeUndefined();
    expect(mocks.host.storeSet).not.toHaveBeenCalled();
  });
});
