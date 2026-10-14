// SPDX-License-Identifier: GPL-2.0-only
// Strict metadata-only successor to the camera-tested T6-C1 release.
import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const x of ['.ts','/index.ts'])try{return next(s+x,c);}catch{}throw e;}}});
const {Firmware,sectionsOf,sha256Hex}=await import('../../core/src/fw/container.ts');
const {GR3X_160}=await import('../../core/src/fw/gr3x/profile.ts');
const {readGr3xLookRecipe}=await import('../../core/src/fw/gr3x/look-recipe.ts');
const {buildGr3xTestFirmware}=await import('../../core/src/fw/gr3x/research-package.ts');
const {buildGr3xAdjResearch}=await import('../../core/src/fw/gr3x/adj.ts');
const {GR3X_JPEG_METADATA}=await import('../../core/src/fw/gr3x/jpeg-metadata.ts');
const {Engine}=await import('../../core/src/app/engine.ts');
const [official,predecessor,directory,python,reference,...extra]=process.argv.slice(2);
assert(official&&predecessor&&directory&&python&&reference&&!extra.length,'Usage: OFFICIAL.bin T6-C1.bin NEW-directory PYTHON PINNED-reference');
const target=resolve(directory),root=resolve(import.meta.dirname,'../..');
const raw=new Uint8Array(await readFile(official)),old=new Uint8Array(await readFile(predecessor));
const oldSha=await sha256Hex(old);
assert.equal(oldSha,'343b91609154109b9b067fadd77acf2728ef38bd93accd0fc43521eecd547ec6');
const oldDecoded=new Firmware(old).decoded,oldSections=sectionsOf(oldDecoded);
const oldRt=oldSections.find(s=>s.name==='RTOS');
const previous=readGr3xLookRecipe(oldDecoded.subarray(oldRt.offset+GR3X_160.rtosLength,oldRt.offset+oldRt.size));
assert(previous.displayRevision===3&&!previous.monoReplicas&&!previous.jpegMetadata&&previous.films.length===9);
const soft=[{level:-1,strength:'weak'},{level:-2,strength:'medium'},{level:-3,strength:'strong'}];
const baseline=await buildGr3xTestFirmware(raw,soft,previous);
assert.equal(baseline.report.outputSha256,oldSha,'Existing C1 reconstruction must remain byte-identical');
const catalog=JSON.parse(await readFile(join(root,'ui/public/film-library/catalog.json'),'utf8'));
const films=previous.films.map(f=>{
  const s=catalog.stocks.find(s=>s.cameraName===f.name);assert(s?.recipeVersion);
  return {...f,photo:{name:s.name,revision:s.recipeVersion}};
});
const result=await buildGr3xTestFirmware(raw,soft,{...previous,jpegMetadata:true,films});
const m=result.manifest,base=baseline.manifest;
assert.deepEqual(m.addedLooks,base.addedLooks);
assert.deepEqual(m.iconAddition,base.iconAddition);
assert.deepEqual(m.ratios,base.ratios);
assert(m.append.bytes.startsWith(base.append.bytes),'Every existing instruction, film parameter and table must be unchanged');
for(const s of base.sites) assert.deepEqual(m.sites.find(n=>n.address===s.address),s);
const newSites=m.sites.filter(s=>!base.sites.some(b=>b.address===s.address));
assert.deepEqual(newSites.map(s=>s.address).sort((a,b)=>a-b),[GR3X_JPEG_METADATA.setter,GR3X_JPEG_METADATA.createSite]);
const dec=new Firmware(result.bytes).decoded,newSections=sectionsOf(dec),rt=newSections.find(s=>s.name==='RTOS');
for(const oldS of oldSections){
  const newS=newSections.find(s=>s.name===oldS.name);assert(newS);
  if(oldS.name!=='RTOS') assert.deepEqual(dec.subarray(newS.offset,newS.offset+newS.size),oldDecoded.subarray(oldS.offset,oldS.offset+oldS.size));
}
const prefixEnd=GR3X_160.rtosLength+base.append.bytes.length/2;
let changed=0;
for(let i=0;i<prefixEnd;i++) if(dec[rt.offset+i]!==oldDecoded[oldRt.offset+i]){
  assert(newSites.some(s=>i>=s.address-GR3X_160.rtosBase&&i<s.address-GR3X_160.rtosBase+4));changed++;
}
await mkdir(target);
const json=(f,v)=>writeFile(join(target,f),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
await writeFile(join(target,'UNVALIDATED.bin'),result.bytes,{flag:'wx'});
await json('patch-manifest.json',m);await json('build-report.json',result.report);
await json('T6-C1-preservation-check.json',{passed:true,predecessorSha256:oldSha,candidateSha256:result.report.outputSha256,
  oldRuntimeUnchanged:true,allNineFilmParametersUnchanged:true,allIconsUnchanged:true,nineRatiosUnchanged:true,
  rawWriterAndGeometryUnchanged:true,allOtherSectionsUnchanged:true,originalRtosChangedBytes:changed,newSites,
  legacyRebuildExact:true});
await json('JPG-film-identities.json',m.jpegMetadata);
await mkdir(join(target,'validation-inputs'));
const d=new Firmware(raw).decoded;
for(const name of ['RTOS','BOOT']){const s=sectionsOf(d).find(s=>s.name===name);await writeFile(join(target,'validation-inputs',name.toLowerCase()+'.bin'),d.subarray(s.offset,s.offset+s.size));}
await json('validation-inputs/base.json',await buildGr3xAdjResearch(raw));
const run=spawnSync(python,[join(root,'tools/gr3x/validate_test.py'),'--official',resolve(official),'--container',join(target,'UNVALIDATED.bin'),
  '--manifest',join(target,'patch-manifest.json'),'--build-report',join(target,'build-report.json'),
  '--rtos',join(target,'validation-inputs/rtos.bin'),'--boot',join(target,'validation-inputs/boot.bin'),
  '--base-look-manifest',join(target,'validation-inputs/base.json'),'--reference',resolve(reference),'--output',join(target,'validation')],{stdio:'inherit',timeout:600000});
assert(!run.error&&run.status===0,'Native validation failed; UNVALIDATED.bin is not a release');
const summary=JSON.parse(await readFile(join(target,'validation/summary.json'),'utf8'));
assert(summary.all_checks_passed&&summary.candidate_sha256===result.report.outputSha256);
const inspect=await (await Engine.open(raw)).inspect(result.bytes);assert(inspect.verified);
await json('reconstruction-check.json',{verified:true,sha256:inspect.sha256,hardwareTested:false});
await copyFile(join(root,'docs/GR3X_T6_J1_TEST.txt'),join(target,'请先阅读.txt'));
await writeFile(join(target,'SHA256SUMS.txt'),result.report.outputSha256+'  fwdc243b.bin\n',{flag:'wx'});
await rename(join(target,'UNVALIDATED.bin'),join(target,'fwdc243b.bin'));
console.log(JSON.stringify({directory:target,sha256:result.report.outputSha256,bytes:result.bytes.length,nativeCases:summary.native_function_cases,hardwareTested:false,cardWritten:false}));
