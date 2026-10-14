// Real UI actions, persisted host contents and delayed conversions; no camera writes.
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { LANGS } from '../src/fw/names';
const m = vi.hoisted(() => ({ files: new Map(),
  engine: { open:vi.fn(), reset:vi.fn(), convert:vi.fn(), ratio:vi.fn(), heartbeat:vi.fn(), build:vi.fn() },
  library: { loadFilmCatalog:vi.fn(), loadFilmFit:vi.fn(), loadFilmSource:vi.fn(), filmIconData:vi.fn() },
  host: { available:true, info:{token:'test'},storeGet:vi.fn(),storeSet:vi.fn(),storeDel:vi.fn(),volumes:vi.fn(),sidecar:vi.fn(),pickDirectory:vi.fn() }
}));
vi.mock('../../ui/src/engine',()=>({engine:m.engine,EngineError:class extends Error{}}));
vi.mock('../../ui/src/host',()=>({host:m.host,HostError:class extends Error{},sha256Hex:async()=> 'source'}));
vi.mock('../../ui/src/library',()=>m.library);
vi.mock('../../ui/src/pixels',()=>({ensureIconFont:vi.fn(),imageIcon:tile=>tile}));
vi.mock('../../ui/src/preview',()=>({decodePreview:vi.fn()}));
const stock={id:'film-one',name:'Film One',cameraName:'Film One',shortName:'FILM1',cubeSha256:'source',status:'ready',fits:{gr3x:{},gr4:{}}};
const fit = family => ({kind:'cube',title:family,meanDE:1,p95DE:2,params:{M1:[],ck:[]},matrixQ13:new Int16Array(9),curves:[new Uint16Array(256),new Uint16Array(256),new Uint16Array(256)]});
function info(family) {
  const ids=['CY','CG','F3','F4','F5','F6','F7','F8','F9'];
  return {family,sha256:family,filename:family==='gr3x'?'fwdc243b.bin':'fwdc248b.bin',
    version:family==='gr3x'?'1.60':'1.11',models:family==='gr3x'?['GR3X_HDF']:['STANDARD','HDF','MONO'],
    capabilities:{build:true,presets:true,wallpaper:false},features:{softFocus:family==='gr3x'?'clarity':'adj',monoUnlock:false},
    slots:ids.map((id,i)=>({id,defaultName:'Film '+(i+1),names:Object.fromEntries(LANGS.map(l=>[l,{text:'Film '+(i+1),capacity:24}]))})),
    allowed:Object.fromEntries(LANGS.map(l=>[l,'Film One123456789 '])),
    tiles:{film:new Uint8Array([family==='gr3x'?3:4])},contentArea:{film:{}},
    factoryRatios:family==='gr3x'?['3:2','1:1']:['3:2','1:1','4:3','16:9'],factoryEntry:{files:[]}};
}
let store;
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();m.files.clear();
  m.host.storeGet.mockImplementation(async k=>m.files.get(k)||null);
  m.host.storeSet.mockImplementation(async(k,v)=>m.files.set(k,typeof v==='string'?new TextEncoder().encode(v):v));
  m.host.storeDel.mockImplementation(async k=>m.files.delete(k));m.host.volumes.mockResolvedValue([]);m.host.sidecar.mockResolvedValue(null);
  m.engine.open.mockImplementation(async b=>info(b[0]===3?'gr3x':'gr4'));
  m.engine.reset.mockResolvedValue(true);m.engine.ratio.mockImplementation(async r=>({actual:r,label:r,sizes:[[6000,4000]]}));
  m.library.loadFilmCatalog.mockResolvedValue({stocks:[stock]});m.library.loadFilmSource.mockResolvedValue('LUT source');
  m.library.loadFilmFit.mockImplementation(async(_,f)=>({result:fit(f),firmwareSha256:f}));m.library.filmIconData.mockResolvedValue('data:image/png;base64,AA==');
  vi.stubGlobal('document',{hidden:true});vi.stubGlobal('createImageBitmap',async()=>({width:36,height:22}));
  vi.stubGlobal('fetch',async()=>new Response(new Uint8Array([0])));
  store=await import('../../ui/src/store');
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

it('keeps IIIx looks, icons, soft focus and nine ratios through IV selection and restart',async()=>{
  await store.adoptFirmware('IIIx','1.60',new Uint8Array([3]));
  store.setSoft(true);await store.applyLibraryFilm(stock,'F9');
  const before=store.getState().ratios.map(r=>r.ratio);
  m.files.set('firmware-gr4.bin',new Uint8Array([4]));
  await store.setModel('STANDARD');await settle();
  expect(store.getState().info.family).toBe('gr4');expect(store.getState().slots.F9.preset).toBeUndefined();
  expect(store.getState().ratios).toHaveLength(5);
  await store.applyLibraryFilm(stock,'CY');
  await store.applyLibraryFilm({...stock,id:'film-nine',cameraName:'Film Nine'},'F9');
  expect(store.getState().slots.F9.names.en).toBe('Film Nine');
  expect(store.getState().slots.CY.preset.result.title).toBe('gr4');
  await store.setModel('GR3X_HDF');await settle();
  expect(store.getState().ratios.map(r=>r.ratio)).toEqual(before);expect(before).toHaveLength(7);
  expect(store.getState().soft).toBe(true);
  expect(store.getState().slots.F9.preset.result.title).toBe('gr3x');
  expect(store.getState().slots.F9.preset.photo).toEqual({name:'Film One',revision:'120-L1'});
  expect(store.pendingChanges().find(s=>s.id==='F9').request.photo).toEqual({name:'Film One',revision:'120-L1'});
  expect(store.getState().slots.F9.icon.pixels[0]).toBe(3);
  expect(store.getState().slots.CY.preset).toBeUndefined();
  const doc=JSON.parse(new TextDecoder().decode(m.files.get('project.json')));
  expect(doc.families.gr3x.slots.F9.preset.libraryId).toBe(stock.id);
  expect(doc.families.gr4.slots.CY.preset.libraryId).toBe(stock.id);
  expect(doc.families.gr4.slots.F9.preset.libraryId).toBe('film-nine');
  // Restart from the same host data, with no in-memory family snapshots.
  vi.resetModules();store=await import('../../ui/src/store');await store.init();await settle();
  expect(store.getState().slots.F9.preset.result.title).toBe('gr3x');
  await store.setModel('STANDARD');await settle();
  expect(store.getState().slots.CY.preset.result.title).toBe('gr4');
  expect(store.pendingChanges().every(s=>s.request.photo===undefined)).toBe(true);
  expect(store.getState().slots.F9.names.en).toBe('Film Nine');
  expect(store.getState().slots.F9.icon.pixels[0]).toBe(4);
});
it('preserves the previous family when the user directly opens the other firmware',async()=>{
  await store.adoptFirmware('IIIx','1.60',new Uint8Array([3]));await store.applyLibraryFilm(stock,'F9');
  await store.adoptFirmware('IV','1.11',new Uint8Array([4]));
  expect(store.getState().slots.F9.preset).toBeUndefined();
  await store.setModel('GR3X_HDF');await settle();
  expect(store.getState().slots.F9.preset.result.title).toBe('gr3x');
});
it('never exports a selected preset whose conversion is still running or failed',async()=>{
  await store.adoptFirmware('IIIx','1.60',new Uint8Array([3]));
  store.getState().slots.CY.preset={busy:true,text:'pending',kind:'cube',fileName:'pending.cube'};
  await store.outputFirmware({kind:'folder'});
  expect(m.host.pickDirectory).not.toHaveBeenCalled();expect(m.engine.build).not.toHaveBeenCalled();
});
it('automatically enables JPG identity and passes full film metadata on IIIx export',async()=>{
  await store.adoptFirmware('IIIx','1.60',new Uint8Array([3]));
  await store.applyLibraryFilm(stock,'F9');
  m.host.pickDirectory.mockResolvedValue('/fixture-not-written');
  m.engine.build.mockRejectedValueOnce(new Error('stop before any output write'));
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  await store.outputFirmware({kind:'folder'});
  const args=m.engine.build.mock.calls.at(-1);
  expect(args[0][0].photo).toEqual({name:'Film One',revision:'120-L1'});
  expect(args[3].jpegMetadata).toBe(true);log.mockRestore();
});
it('does not install a cached fit from the wrong official firmware',async()=>{
  await store.adoptFirmware('IIIx','1.60',new Uint8Array([3]));
  m.library.loadFilmFit.mockResolvedValueOnce({result:fit('gr4'),firmwareSha256:'gr4'});
  vi.spyOn(console,'error').mockImplementation(()=>{});
  await store.applyLibraryFilm(stock,'CY');
  expect(store.getState().slots.CY.preset).toBeUndefined();
  expect(store.getState().toasts.at(-1).kind).toBe('error');
});
it('ignores a late conversion result after switching families',async()=>{
  await store.adoptFirmware('IIIx','1.60',new Uint8Array([3]));
  m.library.loadFilmCatalog.mockResolvedValue({stocks:[]});
  let done;m.engine.convert.mockImplementation(()=>new Promise(resolve=>{done=resolve}));
  const pending=store.loadPresetFile('CY',{name:'custom.cube',size:10,arrayBuffer:async()=>new TextEncoder().encode('custom').buffer});
  await settle();expect(done).toBeTypeOf('function');
  m.files.set('firmware-gr4.bin',new Uint8Array([4]));await store.setModel('STANDARD');
  done(fit('gr3x'));await pending;
  expect(store.getState().info.family).toBe('gr4');expect(store.getState().slots.CY.preset).toBeUndefined();
});

it('migrates the old GR IV Cinema aliases and synchronizes film names across languages',async()=>{
  store.getState().slots.CY.names={en:'Provia 100F','zh-CN':'P100F'};
  await store.adoptFirmware('IV','1.11',new Uint8Array([4]));
  expect(store.getState().info.slots).toHaveLength(9);
  expect(store.getState().slots.CY.names['zh-CN']).toBe('Provia 100F');
  store.setName('F9','zh-CN','CineStill 800T');
  expect(Object.values(store.getState().slots.F9.names)).toEqual(LANGS.map(()=> 'CineStill 800T'));
});
