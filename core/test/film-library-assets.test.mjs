import {it, expect, vi, afterEach} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
const stock = {id:'example',name:'Example Film',status:'ready',fits:{gr3x:{sha256:'x'},gr4:{sha256:'y'}}};
const catalog = {schema:1,count:120,version:'test',stocks:Array.from({length:120},(_,i)=>({...stock,id:i?'film-'+i:'example'}))};
it('offers import on a clean source build instead of advertising absent LUTs',async()=>{
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(catalog)));
  vi.stubGlobal('__GRMOD_INSTALLED_FILMS__',{gr3x:[],gr4:[]});
  const {loadFilmCatalog}=await import('../../ui/src/library');
  const read=await loadFilmCatalog();
  expect(read.stocks.every(s=>s.status==='pending' && Object.keys(s.fits).length===0)).toBe(true);
  expect(read.stocks[0].reason).toContain('CUBE');expect(catalog.stocks[0].status).toBe('ready');
});
it('retains only installed per-camera fits without changing a stock’s photo identity',async()=>{
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(catalog)));
  vi.stubGlobal('__GRMOD_INSTALLED_FILMS__',{gr3x:['example'],gr4:[]});
  const {loadFilmCatalog}=await import('../../ui/src/library');
  const s=(await loadFilmCatalog()).stocks[0];
  expect(s.status).toBe('ready');expect(s.name).toBe('Example Film');expect(s.fits).toEqual({gr3x:{sha256:'x'}});
});
