// Read the saved local project, re-import its exact sources, and reproduce J1.
import {registerHooks} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const x of ['.ts','/index.ts'])try{return next(s+x,c);}catch{}throw e;}}});
const {Engine}=await import('../../core/src/app/engine.ts');
const {Firmware,sectionsOf,sha256Hex}=await import('../../core/src/fw/container.ts');
const {GR3X_160}=await import('../../core/src/fw/gr3x/profile.ts');
const {readGr3xLookRecipe}=await import('../../core/src/fw/gr3x/look-recipe.ts');
const {photoIdentity}=await import('../../ui/src/film-identity.ts');
const [store,release,backup,output]=process.argv.slice(2);assert(store&&release&&backup&&output);
const p=JSON.parse(await readFile(join(store,'project.json'),'utf8'));
const before=JSON.parse(await readFile(join(backup,'project.json'),'utf8'));
assert(p.model==='GR3X_HDF'&&p.soft&&!p.monoUnlock);
const catalog=JSON.parse(await readFile(resolve(import.meta.dirname,'../../ui/public/film-library/catalog.json'),'utf8'));
const engine=await Engine.open(new Uint8Array(await readFile(join(store,'firmware-gr3x.bin'))));
const file=new Uint8Array(await readFile(join(release,'fwdc243b.bin'))),d=new Firmware(file).decoded;
const rt=sectionsOf(d).find(s=>s.name==='RTOS'),recipe=readGr3xLookRecipe(d.subarray(rt.offset+GR3X_160.rtosLength,rt.offset+rt.size));
const requests=[];
for(const [i,id] of ['CY','CG','F3','F4','F5','F6','F7','F8','F9'].entries()){
  const slot=p.slots[id],old=before.families.gr3x.slots[id];
  assert.deepEqual(slot.names,old.names);assert.deepEqual(slot.icon,old.icon);
  const data=await readFile(join(store,'preset-gr3x-'+id.toLowerCase()));
  assert.deepEqual(data,await readFile(join(backup,'preset-gr3x-'+id.toLowerCase())));
  const stock=catalog.stocks.find(s=>s.cubeSha256===shaCache(data));
  assert(stock,'Exact source hash must resolve to the film catalog');
  const q=engine.convertPreset(slot.preset.kind,data.toString('utf8'));
  assert.deepEqual([...q.matrixQ13],recipe.films[i].preset.matrixQ13);
  assert.deepEqual(q.curves.map(c=>[...c]),recipe.films[i].preset.curves);
  const photo=photoIdentity(stock,slot.preset.fileName,true);assert.deepEqual(photo,recipe.films[i].photo);
  requests.push({slot:id,preset:{matrixQ13:q.matrixQ13,curves:q.curves},names:slot.names,icon:recipe.films[i].icon,photo});
}
assert.deepEqual(p.ratios,before.families.gr3x.ratios);
assert.deepEqual(p.families.gr4,before.families.gr4);
const built=await engine.buildFirmware(requests,p.ratios.map(({name,ratio})=>({name,ratio})),
  [{level:-1,strength:'weak'},{level:-2,strength:'medium'},{level:-3,strength:'strong'}],{jpegMetadata:true});
const hash=await sha256Hex(file);assert.equal(built.sha256,hash);
await writeFile(output,JSON.stringify({passed:true,sha256:hash,source:'Saved project exact CUBE sources/names + unchanged stored icon inputs + released icon pixels',
  allSourcesAndIconInputsUnchanged:true,allNineImportedColourParametersExact:true,allJpgIdentitiesMatch:true,gr4ProjectUnchanged:true,
  publicApiRebuildsReleaseExactly:true,hardwareTested:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,sha256:hash}));
function shaCache(b){return createHash('sha256').update(b).digest('hex');}
import {createHash} from 'node:crypto';
