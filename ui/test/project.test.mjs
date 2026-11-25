// SPDX-License-Identifier: GPL-2.0-only
// Project export / import, automatic snapshots and New project, on the real UI store with an in-memory host store
// (storeGet / storeSet / storeDel / storeList behave as the Go host's key/value store does).
// @mock-exempt: the host (HTTP API), the engine (Web Worker) and pixels / preview (canvas) are external boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const mocks = vi.hoisted(() => ({
  files: new Map(),
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: true, info: { token: 't', kind: 'test', version: '9.9.9' }, join: (...p) => p.join('/'),
    storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), storeList: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), list: vi.fn(), move: vi.fn(), sidecar: vi.fn(),
  },
}));
vi.mock('../src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error { constructor(code, message) { super(message); this.code = code; } } }));
vi.mock('../src/host', () => ({ host: mocks.host, HostError: class extends Error { constructor(code, message) { super(message); this.code = code; } }, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../src/preview', () => ({ decodePreview: vi.fn() }));

const info = () => ({
  family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF'],
  capabilities: { build: true, presets: false, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
const gr4Info = () => ({
  family: 'gr4', version: '1.11', filename: 'fwdc248b.bin', models: ['HDF', 'STANDARD', 'MONO'],
  capabilities: { build: true, presets: true, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'adj', dateStamp: true, monoUnlock: true },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
const enc = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
const dec = (b) => new TextDecoder().decode(b);
const local = new Map(), session = new Map();
let store;
const stored = () => [...mocks.files.keys()];
const snapIndex = () => JSON.parse(mocks.files.has('snapshots.json') ? dec(mocks.files.get('snapshots.json')) : '{"entries":[]}').entries;
const flush = () => vi.advanceTimersByTimeAsync(1);
const confirmed = async (p, yes = true) => { await flush(); expect(store.getState().confirm).toBeTruthy(); store.answerConfirm(yes); await p; await flush(); };
const errorToasts = () => store.getState().toasts.filter((x) => x.kind === 'error');
const fileOf = (text) => ({ size: text.length, text: async () => text });

beforeEach(async () => {
  local.clear(); session.clear(); mocks.files.clear();
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.host.available = true;
  mocks.engine.open.mockReset().mockResolvedValue(gr4Info()); // a kept GR IV file opens again at start-up
  mocks.engine.ratio.mockImplementation(async (ratio) => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  mocks.engine.build.mockResolvedValue({ file: new Uint8Array([9, 2]), checks: { integrity: true } });
  mocks.engine.heartbeat.mockResolvedValue(true);
  mocks.host.storeGet.mockImplementation(async (k) => mocks.files.get(k) ?? null);
  mocks.host.storeSet.mockImplementation(async (k, d) => { mocks.files.set(k, enc(d)); });
  mocks.host.storeDel.mockImplementation(async (k) => { mocks.files.delete(k); });
  mocks.host.storeList.mockImplementation(async () => [...mocks.files].map(([key, v]) => ({ key, size: v.length })));
  mocks.host.pickDirectory.mockReset().mockResolvedValue('/chosen');
  mocks.host.write.mockImplementation(async (_p, data) => ({ size: data.length, sha256: 'test-hash' }));
  mocks.host.volumes.mockResolvedValue([]);
  mocks.host.sidecar.mockResolvedValue(null);
  mocks.host.list.mockResolvedValue([]); mocks.host.move.mockResolvedValue();
  vi.stubGlobal('document', { hidden: true });
  // setAppLanguage reloads the page in the new language; here the page is not reloaded
  vi.stubGlobal('window', { setTimeout: () => 0, location: { reload: vi.fn() } });
  // the page's storage (the app language lives in localStorage); kept across vi.resetModules() like a restart
  const storageOf = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } });
  vi.stubGlobal('localStorage', storageOf(local)); vi.stubGlobal('sessionStorage', storageOf(session));
  store = await import('../src/store');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const seed = () => {
  mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', lang: 'en', soft: true, slots: { CY: { preset: { fileName: 'a.cube', kind: 'cube' }, names: {}, icon: { mode: 'keep', text: '', style: 'film' } } } })));
  mocks.files.set('project-gr3.json', enc(JSON.stringify({ v: 1, filmCount: 3 })));
  mocks.files.set('preset-cy', enc('LUT_3D_SIZE 2\n0 0 0\n'));
  mocks.files.set('gr3-preset-cy', enc('gr3 preset'));
  mocks.files.set('wall-abc', new Uint8Array([0xff, 0xd8, 0, 1, 2, 255]));
  mocks.files.set('firmware-gr4.bin', new Uint8Array([1, 2, 3]));
  mocks.files.set('builds.json', enc('[]'));
};
const doImport = async (s, text) => { const p = s.importProject(fileOf(text)); await confirmed(p); };

describe('project export and import', () => {
  it('exports docs and dependent files, but not the official firmware, the build list or snapshots', async () => {
    seed(); mocks.files.set('snapshots.json', enc('{"v":1,"entries":[]}')); mocks.files.set('snapshot-1.json', enc('{}'));
    await store.init();
    const p = await store.buildProjectExport();
    expect(p).toMatchObject({ format: 'grmod-project', formatVersion: 1, appVersion: '9.9.9' });
    expect(Object.keys(p.files).sort()).toEqual(['gr3-preset-cy', 'preset-cy', 'wall-abc']);
    expect(p.project.soft).toBe(true);
    expect(p.projectGr3.filmCount).toBe(3);
  });
  it('round-trips: an import into an empty store restores the docs, the preset and the picture', async () => {
    seed();
    await store.init();
    const text = JSON.stringify(await store.buildProjectExport());
    mocks.files.clear();
    mocks.files.set('preset-old', enc('stale')); // a project file the import does not contain goes away
    mocks.files.set('firmware-gr4.bin', new Uint8Array([7]));
    vi.resetModules();
    const s2 = await import('../src/store');
    store = s2; // the helpers read the current module
    await s2.init();
    await doImport(s2, text);
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
    const done = store.importProject(fileOf(text));
    await confirmed(done, false);
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
    await store.importProject(fileOf(text));
    expect(errorToasts()).toHaveLength(1);
    expect(store.getState().confirm).toBeUndefined();
    expect(mocks.host.storeSet).not.toHaveBeenCalled();
  });
  it('names the two failures with the codes the dialog texts hang on: bad-project and project-too-new', () => {
    const code = (text) => { try { store.parseProjectExport(text); } catch (e) { expect(e).toBeInstanceOf(store.ProjectFileError); return e.code; } return 'none'; };
    expect(code('nope{')).toBe('bad-project');
    expect(code(JSON.stringify({ format: 'grmod-project', formatVersion: 2, project: { v: 1 }, files: {} }))).toBe('project-too-new');
    expect(code(JSON.stringify({ format: 'grmod-project', formatVersion: 1, project: { v: 1 }, files: {} }))).toBe('none');
  });
  it('a too-new file gets its own text, any other bad file the generic one', async () => {
    await store.init();
    await store.importProject(fileOf(JSON.stringify({ format: 'grmod-project', formatVersion: 99, project: { v: 1 }, files: {} })));
    const i18n = await import('../src/i18n');
    expect(errorToasts().at(-1).text).toBe(i18n.t('projectTooNew'));
    await store.importProject(fileOf('{}'));
    expect(errorToasts().at(-1).text).toBe(i18n.t('projectBad'));
  });
});

describe('every option the project saves is in the file', () => {
  // The options 0.9.2's familyData() saves, set away from their defaults. When upstream adds one, the
  // "saved keys" test below fails until it is listed here, and the round trip then covers it.
  const OPTIONS = ['brightAuto', 'soft', 'dateStamp', 'monoUnlock', 'directFlash', 'hdr', 'exposurePreview', 'flashTtl', 'videoAf', 'awbLearn', 'movieExposure', 'sensorShift', 'movie4k', 'movieSr', 'distanceFeet', 'constantLight', 'filmGrain', 'shadowLearn', 'ratioShade', 'ratioShadeTone', 'battery', 'customGrid', 'gridLines', 'framing', 'adjSlots', 'filmCount'];
  const nonDefaultDoc = async () => {
    await store.init();
    const g = store.getState().gridLines;
    return { v: 1, model: 'HDF', lang: 'en', brightAuto: 'balanced', soft: true, dateStamp: true, monoUnlock: true, directFlash: true, hdr: true, exposurePreview: true, flashTtl: true, videoAf: true, awbLearn: true,
      movieExposure: true, sensorShift: true, movie4k: true, movieSr: true, distanceFeet: true, constantLight: true, filmGrain: true, shadowLearn: true, ratioShade: true, ratioShadeTone: 'light', battery: true, customGrid: true,
      gridLines: { g3: g.g3.map((b) => !b), g4: g.g4.map((b) => !b) }, framing: store.templateGuides(store.FRAMING_TEMPLATES.find((x) => x.id === 'cinema')), adjSlots: 7, filmCount: 4,
      ratios: [{ id: 'r1', ratio: '4:3', name: 'Four three' }], lookHidden: ['CY'], page: 'extras', showAll: true, previewMode: 'swatch', ratioBackdrop: 'gray', fwName: 'fwdc248b.bin' };
  };
  it('the saved documents carry exactly the options listed here', async () => {
    await store.init();
    const keys = Object.keys(store.projectDocuments().doc);
    for (const k of OPTIONS) expect(keys, k).toContain(k);
    const rest = keys.filter((k) => !OPTIONS.includes(k)).sort();
    expect(rest).toEqual(['extras', 'fwName', 'lang', 'langAuto', 'lookHidden', 'lookHidden3', 'lookOrder', 'lookOrder3', 'model', 'page', 'previewMode', 'ratioBackdrop', 'ratios', 'showAll', 'slots', 'toursV', 'tours', 'uiLang', 'v', 'wall'].sort());
  });
  it('a project with every option set survives export, import into an empty store and a save, key for key', async () => {
    const doc = await nonDefaultDoc();
    mocks.files.set('project.json', enc(JSON.stringify(doc)));
    vi.resetModules(); store = await import('../src/store'); await store.init();
    const s = store.getState();
    for (const k of OPTIONS.filter((x) => x !== 'filmCount')) expect(s[k], k).toEqual(doc[k]);
    const exported = await store.buildProjectExport();
    for (const k of OPTIONS) expect(exported.project[k], k).toEqual(doc[k]);
    const text = JSON.stringify(exported);

    mocks.files.clear(); local.clear();
    vi.resetModules(); store = await import('../src/store'); await store.init();
    await doImport(store, text);
    const after = store.getState();
    for (const k of OPTIONS.filter((x) => x !== 'filmCount')) expect(after[k], `after import: ${k}`).toEqual(doc[k]);
    const again = await store.buildProjectExport();
    expect(again.project).toEqual(exported.project);
    // and what the import wrote to disk is what the next start reads
    const onDisk = JSON.parse(dec(mocks.files.get('project.json')));
    for (const k of OPTIONS) expect(onDisk[k], `on disk: ${k}`).toEqual(doc[k]);
  });
});

describe('an import keeps the app language and the guides already seen', () => {
  it('keeps the current language, and the saved language is still taken at start-up', async () => {
    await store.init(); await store.setAppLanguage('en');
    expect(local.get('grmod.uiLang')).toBe('en');
    await doImport(store, JSON.stringify({ format: 'grmod-project', formatVersion: 1, appVersion: '1', exported: '', files: {}, project: { v: 1, model: 'HDF', uiLang: 'zh', lang: 'ja' }, projectGr3: null }));
    expect(local.get('grmod.uiLang') ?? 'en').toBe('en'); expect(store.getState().lang).toBe('en');
    expect(JSON.parse(dec(mocks.files.get('project.json'))).uiLang).toBe('en'); // not left as the file's for the next start
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', lang: 'en', uiLang: 'zh' })));
    vi.resetModules(); const s2 = await import('../src/store'); await s2.init();
    expect(local.get('grmod.uiLang')).toBe('zh'); expect(s2.getState().lang).toBe('zh-CN');
  });
  it('the guides seen are the union of the app\'s and the file\'s, so an old project does not start them again', async () => {
    mocks.files.set('project.json', enc(JSON.stringify({ v: 1, model: 'HDF', lang: 'en', tours: ['overview', 'ic', 'ratio'], toursV: 2 })));
    await store.init();
    const file = (tours) => JSON.stringify({ format: 'grmod-project', formatVersion: 1, appVersion: '1', exported: '', files: {}, project: { v: 1, model: 'HDF', tours, toursV: 2 }, projectGr3: null });
    await doImport(store, file(['wall']));
    expect([...store.getState().toursSeen].sort()).toEqual(['ic', 'overview', 'ratio', 'wall']);
    await doImport(store, file([]));
    expect([...store.getState().toursSeen].sort()).toEqual(['ic', 'overview', 'ratio', 'wall']);
  });
});

describe('project snapshots', () => {
  const start = async () => { mocks.engine.open.mockResolvedValue(info()); await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1])); store.addRatio('4:3'); await flush(); };
  it('takes one before an import, and the import then replaces the project', async () => {
    store.addExtraSlot();
    const exported = await store.buildProjectExport();
    store.addExtraSlot();
    expect(store.getState().extras).toHaveLength(2);
    await confirmed(store.importProject(fileOf(JSON.stringify(exported))));
    const idx = snapIndex();
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ reason: 'import', extras: 2 });
    expect(stored()).toContain(`snapshot-${idx[0].id}.json`);
    expect(store.getState().extras).toHaveLength(1);
    // never part of a project export
    expect(Object.keys((await store.buildProjectExport()).files).some((k) => k.startsWith('snapshot'))).toBe(false);
  });
  it('takes one after a successful build to a folder, not after a failed one', async () => {
    await start();
    mocks.engine.build.mockRejectedValueOnce(new Error('boom'));
    await store.outputFirmware({ kind: 'folder' });
    expect(snapIndex()).toHaveLength(0);
    await store.outputFirmware({ kind: 'folder' }); await flush();
    expect(snapIndex().map((e) => e.reason)).toEqual(['build']);
    expect(snapIndex()[0]).toMatchObject({ ratios: 1 });
  });
  it('keeps the newest 10 and deletes the files of the rest; an unchanged project is not snapshotted twice', async () => {
    for (let i = 0; i < 13; i++) { store.setSoft(i % 2 === 0); store.setAdjSlots(5 + (i % 3)); store.setDateStamp(i % 4 < 2); await store.takeSnapshot('build'); }
    const idx = snapIndex();
    expect(idx.length).toBe(10);
    expect(stored().filter((k) => k.startsWith('snapshot-')).sort()).toEqual(idx.map((e) => `snapshot-${e.id}.json`).sort());
    const n = idx.length; await store.takeSnapshot('build'); await store.takeSnapshot('build');
    expect(snapIndex().length).toBe(n);
    expect(stored().every((k) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(k))).toBe(true);
  });
  it('restores through the import path, and snapshots the current state first so the restore can be undone', async () => {
    store.setSoft(true);
    await store.takeSnapshot('build');
    const old = snapIndex()[0];
    store.setSoft(false); store.addExtraSlot();
    await store.openSnapshots(); await flush();
    expect(store.getState().snapshotsView.entries.map((e) => e.id)).toEqual([old.id]);
    await confirmed(store.restoreSnapshot(old.id));
    expect(store.getState().soft).toBe(true);
    expect(store.getState().extras).toHaveLength(0);
    const idx = snapIndex();
    expect(idx.map((e) => e.reason)).toEqual(['build', 'restore']);
    expect(idx[1]).toMatchObject({ extras: 1 }); // what was open before: one added slot
    expect(JSON.parse(dec(mocks.files.get(`snapshot-${idx[1].id}.json`))).project.soft).toBe(false);
    await store.openSnapshots(); await flush();
    await confirmed(store.restoreSnapshot(idx[1].id));
    expect(store.getState().extras).toHaveLength(1);
  });
  it('restoring the oldest of a full list works even though the new snapshot prunes it', async () => {
    for (let i = 0; i < 12; i++) { store.setSoft(i % 2 === 0); store.setAdjSlots(5 + (i % 3)); store.setDateStamp(i % 4 < 2); await store.takeSnapshot('build'); }
    expect(snapIndex().length).toBe(10);
    const oldest = snapIndex()[0]; const want = JSON.parse(dec(mocks.files.get(`snapshot-${oldest.id}.json`))).project.soft;
    store.setSoft(!want); store.addExtraSlot();
    await store.openSnapshots(); await flush();
    await confirmed(store.restoreSnapshot(oldest.id));
    expect(store.getState().soft).toBe(want);
    expect(stored().includes(`snapshot-${oldest.id}.json`)).toBe(false);
    expect(snapIndex().length).toBe(10);
  });
  it('a failing store does not block the build and warns once', async () => {
    await start();
    mocks.host.storeSet.mockRejectedValue(new Error('disk full'));
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.host.write).toHaveBeenCalledTimes(1);
    await store.takeSnapshot('build'); await store.takeSnapshot('build');
    expect(store.getState().toasts.filter((x) => /automatic backup/.test(x.text))).toHaveLength(1);
  });
});

describe('New project', () => {
  it('resets only the open family, keeps the other family and the interface language, and snapshots first', async () => {
    const doc = (extra = {}) => ({ v: 1, ratios: [{ id: 'r1', ratio: '4:3', name: '' }, { id: 'r2', ratio: '16:9', name: '' }], ...extra });
    await store.applyProjectExport({ format: 'grmod-project', formatVersion: 1, appVersion: '1', exported: '', files: {}, project: doc({ model: 'GR3X_HDF', tours: ['overview'], toursV: 2 }), projectGr3: doc() });
    expect(store.getState().ratios).toHaveLength(2);
    await store.setAppLanguage('zh');
    mocks.files.set('gr3-preset-cy', enc('<xmp/>')); mocks.files.set('preset-cy', enc('<other-family/>')); mocks.files.set('preview.jpg', enc('photo'));
    store.setSoft(true);
    await confirmed(store.newProject());
    const s = store.getState();
    expect(s.ratios).toEqual([]); expect(s.soft).toBe(false); expect(s.extras).toEqual([]);
    expect(local.get('grmod.uiLang')).toBe('zh');
    expect(s.model).toBe('GR3X_HDF'); expect(s.toursSeen).toEqual(['overview']);
    expect(snapIndex().map((e) => e.reason)).toEqual(['new']);
    expect(snapIndex()[0]).toMatchObject({ ratios: 2 });
    // files: this family's preset gone, everything else kept
    expect(stored()).not.toContain('gr3-preset-cy');
    for (const k of ['preset-cy', 'preview.jpg']) expect(stored()).toContain(k);
    // docs: the other family's work is untouched, this one is empty
    const gr4 = JSON.parse(dec(mocks.files.get('project.json'))), gr3 = JSON.parse(dec(mocks.files.get('project-gr3.json')));
    expect(gr4.ratios).toHaveLength(2); expect(gr4.uiLang).toBe('zh');
    expect(gr3.ratios).toEqual([]); expect(gr3.soft).toBe(false);
    // the snapshot brings the old work back
    await store.openSnapshots(); await flush();
    await confirmed(store.restoreSnapshot(snapIndex()[0].id));
    expect(store.getState().ratios).toHaveLength(2); expect(store.getState().soft).toBe(true);
  });
  it('clears the 0.9 movie switches too', async () => {
    await store.init();
    store.setMovie4k(true); store.setSensorShift(true); store.setMovieSr(true); store.setMovieExposure(true); store.setConstantLight(true);
    await confirmed(store.newProject());
    expect(store.getState()).toMatchObject({ movie4k: false, sensorShift: false, movieSr: false, movieExposure: false, constantLight: false });
  });
  it('Cancel changes nothing and snapshots nothing', async () => {
    store.setSoft(true);
    await confirmed(store.newProject(), false);
    expect(store.getState().soft).toBe(true);
    expect(snapIndex()).toEqual([]);
  });
  it('production sequence: build, import another project, restore the build, then start a new project', async () => {
    mocks.engine.open.mockResolvedValue(info());
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1])); store.addRatio('4:3'); await flush();
    store.setSoft(true);
    await store.outputFirmware({ kind: 'folder' }); await flush();
    store.addRatio('16:9'); // work done after the build, so that the import's own snapshot differs from the build's
    const mine = await store.buildProjectExport();
    await doImport(store, JSON.stringify({ ...mine, project: { ...mine.project, soft: false }, projectGr3: { ...mine.projectGr3, soft: false } }));
    expect(store.getState().soft).toBe(false); expect(store.getState().ratios).toHaveLength(2);
    await store.openSnapshots(); await flush();
    const entries = store.getState().snapshotsView.entries;
    expect(entries.map((e) => e.reason)).toEqual(['import', 'build']);
    await confirmed(store.restoreSnapshot(entries[1].id));
    expect(store.getState().soft).toBe(true); expect(store.getState().ratios).toHaveLength(1);
    await confirmed(store.newProject());
    expect(store.getState().soft).toBe(false);
    expect(snapIndex().map((e) => e.reason)).toEqual(['build', 'import', 'restore', 'new']);
    expect(errorToasts()).toEqual([]);
  });
});
