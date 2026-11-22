// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: host = HTTP boundary (in-memory file store), engine = Web Worker boundary, pixels/preview = browser canvas (same pattern as qol-app.test.mjs)
// Review hotfixes: project import vs a pending undo, undo caps, toast-bound undo, family-wide undo, menu shortcut guard,
// compareWith in the export, the interface language on import, and the export / import wording.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map(),
  engine: { open: vi.fn(), reset: vi.fn(), ratio: vi.fn(), heartbeat: vi.fn() },
  host: { available: true, info: { token: 't', kind: 'test', version: '9.9.9', os: 'linux' }, sep: '/', join: (...p) => p.join('/'),
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), volumes: vi.fn(), sidecar: vi.fn() },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'h', isAndroid: false, isMobile: false }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

const local = new Map(), session = new Map();
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
let store, i18n;
beforeEach(async () => {
  local.clear(); session.clear();
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
  // the page's storage (the app language lives in localStorage; sessionStorage guards the one-off adoption reload); kept across vi.resetModules() like a restart
  const storageOf = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } });
  vi.stubGlobal("localStorage", storageOf(local)); vi.stubGlobal("sessionStorage", storageOf(session));
  store = await import('../../ui/src/store');
  i18n = await import('../../ui/src/i18n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = () => vi.advanceTimersByTimeAsync(1);
const lastToast = () => store.getState().toasts.at(-1);
const projectText = (extra = {}) => JSON.stringify({ format: 'grmod-project', formatVersion: 1, appVersion: '1', exported: '', project: { v: 1, model: 'HDF', lang: 'en', ...extra }, projectGr3: null, files: { 'preset-zz': 'AQID' } });
const doImport = async (s, text) => { const done = s.importProject(new File([text], 'p.grmod.json')); await flush(); s.answerConfirm(true); await done; };

describe('project import and a pending undo', () => {
  it('commits the pending delete before the import writes, and Undo no longer re-inserts the old item', async () => {
    await store.init();
    store.addExtraSlot(); const k = store.getState().extras[0].key;
    mocks.files.set('preset-' + k, enc('mine'));
    store.removeExtraSlot(k);
    expect(store.undoPending()).toBe(true);
    const order = [];
    mocks.host.storeDel.mockImplementation(async (key) => { order.push('del ' + key); mocks.files.delete(key); });
    mocks.host.storeSet.mockImplementation(async (key, d) => { order.push('set ' + key); mocks.files.set(key, typeof d === 'string' ? enc(d) : d); });
    await doImport(store, projectText());
    expect(order[0]).toBe('del preset-' + k); // the deferred delete runs first, never after the import's writes
    expect(order.indexOf('set preset-zz')).toBeGreaterThan(0);
    expect(store.undoPending()).toBe(false);
    store.undoDelete();
    expect(store.getState().extras).toEqual([]);
    expect(mocks.files.has('preset-zz')).toBe(true);
  });
});

describe('undo respects the caps', () => {
  it('refuses to restore an added slot when the list is full again, still deletes the file, and says so', async () => {
    await store.init();
    while (store.getState().extras.length < 99) { // fill to whatever the cap is
      const n = store.getState().extras.length; store.addExtraSlot(); if (store.getState().extras.length === n) break; }
    const cap = store.getState().extras.length; expect(cap).toBeGreaterThan(0); expect(cap).toBeLessThan(99);
    const gone = store.getState().extras[0].key;
    mocks.files.set('preset-' + gone, enc('x'));
    store.removeExtraSlot(gone);
    store.addExtraSlot();
    expect(store.getState().extras).toHaveLength(cap);
    store.undoDelete();
    expect(store.getState().extras).toHaveLength(cap);
    expect(store.getState().extras.map(x => x.key)).not.toContain(gone);
    expect(mocks.files.has('preset-' + gone)).toBe(false);
    expect(lastToast().text).toBe(i18n.t('undoFull'));
  });
  it('refuses to restore a ratio past the maximum', async () => {
    await store.init();
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
    await store.init();
    store.addExtraSlot(); store.addExtraSlot();
    const [a, b] = store.getState().extras.map(x => x.key);
    store.removeExtraSlot(a); const toastA = lastToast();
    store.removeExtraSlot(b); const toastB = lastToast();
    expect(store.getState().toasts.map(x => x.id)).not.toContain(toastA.id);
    toastA.action.run(); // a press that still got through (the button was already clicked)
    expect(store.getState().extras).toEqual([]);
    expect(lastToast().text).toBe(i18n.t('undoGone'));
    expect(store.undoPending()).toBe(true);
    toastB.action.run();
    expect(store.getState().extras.map(x => x.key)).toEqual([b]);
  });
});

describe('undo across models of one family', () => {
  it('HDF to Standard still restores; another family commits instead', async () => {
    await store.init();
    store.addExtraSlot(); const k = store.getState().extras[0].key;
    mocks.files.set('preset-' + k, enc('x'));
    store.removeExtraSlot(k);
    store.setModel('STANDARD'); await flush();
    expect(store.undoPending()).toBe(true);
    store.undoDelete();
    expect(store.getState().extras.map(x => x.key)).toEqual([k]);
    store.removeExtraSlot(k);
    store.setModel('GR3'); await flush();
    store.undoDelete();
    expect(store.getState().extras).toEqual([]);
    expect(mocks.files.has('preset-' + k)).toBe(false);
  });
});

describe('shortcuts and an open menu', () => {
  it('Cmd+Z and the arrows stay quiet while a [role=menu] is open', async () => {
    await store.init();
    store.addExtraSlot(); store.removeExtraSlot(store.getState().extras[0].key);
    vi.stubGlobal('document', { hidden: true, querySelector: (sel) => (sel.split(',').includes('[role="menu"]') ? {} : null) });
    expect(store.handleShortcut({ key: 'z', metaKey: true, preventDefault: vi.fn(), target: { tagName: 'BUTTON' } })).toBe(false);
    expect(store.handleShortcut({ key: 'ArrowRight', preventDefault: vi.fn(), target: { tagName: 'BUTTON' } })).toBe(false);
    expect(store.undoPending()).toBe(true);
    vi.stubGlobal('document', { hidden: true, querySelector: () => null });
    expect(store.handleShortcut({ key: 'z', metaKey: true, preventDefault: vi.fn(), target: { tagName: 'BODY' } })).toBe(true);
  });
});

describe('project file: compareWith and the interface language', () => {
  it('exports compareWith and restores it on import', async () => {
    await store.init();
    store.setCompareWith('CG');
    const p = await store.buildProjectExport();
    expect(p.project.compareWith).toBe('CG');
    await doImport(store, JSON.stringify(p));
    expect(store.getState().compareWith).toBe('CG');
  });
  it('import keeps the current app language; startup still restores the saved one', async () => {
    await store.init(); await store.setAppLanguage('en');
    expect(local.get('grmod.uiLang')).toBe('en');
    await doImport(store, projectText({ uiLang: 'zh', lang: 'ja' }));
    expect(local.get('grmod.uiLang') ?? 'en').toBe('en'); expect(store.getState().lang).toBe('en');
    expect(JSON.parse(dec(mocks.files.get('project.json'))).uiLang).toBe('en'); // not left as the file's for the next start
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', lang: 'en', uiLang: 'zh' })));
    vi.resetModules(); const s2 = await import('../../ui/src/store'); await s2.init();
    expect(local.get('grmod.uiLang')).toBe('zh'); expect(s2.getState().lang).toBe('zh-CN');
  });
});

describe('guides seen survive an import, and can all be skipped', () => {
  it('an import of a project with no guides seen does not start them again; the file\'s own are added', async () => {
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', lang: 'en', tours: ['overview', 'ic', 'ratio'], toursV: 2 })));
    await store.init();
    expect(store.getState().toursSeen).toEqual(['overview', 'ic', 'ratio']);
    await doImport(store, projectText({ tours: ['wall'], toursV: 2 }));
    expect([...store.getState().toursSeen].sort()).toEqual(['ic', 'overview', 'ratio', 'wall']);
    await doImport(store, projectText({}));
    expect([...store.getState().toursSeen].sort()).toEqual(['ic', 'overview', 'ratio', 'wall']);
    await flush(); await vi.advanceTimersByTimeAsync(2000);
    expect(JSON.parse(dec(mocks.files.get('project.json'))).tours.sort()).toEqual(['ic', 'overview', 'ratio', 'wall']);
  });
  it('Skip all guides ends the running one, marks every guide seen and saves it; Start all guides again undoes it', async () => {
    await store.init();
    store.startTour('overview', [0, 1, 2], false);
    expect(store.getState().tour?.id).toBe('overview');
    store.skipTours();
    expect(store.getState().tour).toBeUndefined();
    expect([...store.getState().toursSeen].sort()).toEqual([...store.TOUR_IDS].sort());
    await vi.advanceTimersByTimeAsync(2000);
    expect(JSON.parse(dec(mocks.files.get('project.json'))).tours.sort()).toEqual([...store.TOUR_IDS].sort());
    store.resetTours();
    expect(store.getState().toursSeen).toEqual([]);
  });
});

describe('export and import wording', () => {
  it('counts attached files in plain words, in both languages; the confirm button is "Import"', async () => {
    local.set('grmod.uiLang', 'zh'); vi.resetModules(); const zhI18n = await import('../../ui/src/i18n'); // the app reloaded in Chinese
    await store.init();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    const a = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { hidden: true, createElement: () => a, body: { appendChild: () => {} } });
    mocks.files.set('preset-cy', enc('x'));
    await store.exportProject();
    expect(lastToast().text).toBe('Project exported (1 attached file)');
    mocks.files.set('preset-cg', enc('y')); mocks.files.set('wall-a', enc('z'));
    await store.exportProject();
    expect(lastToast().text).toBe('Project exported (3 attached files)');
    for (const k of [...mocks.files.keys()]) mocks.files.delete(k);
    await store.exportProject();
    expect(lastToast().text).toBe('Project exported');
    const done = store.importProject(new File([projectText()], 'p.json')); await flush();
    expect(store.getState().confirm.ok).toBe('Import');
    store.answerConfirm(false); await done;
    expect(zhI18n.t('projectExported', { n: 3 })).toBe('项目已导出（含 3 个附属文件）');
    expect(zhI18n.t('projectImportOk')).toBe('导入');
  });
});
