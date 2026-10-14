// Native input fixtures stay outside the repository; no SD/camera I/O.
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sectionsOf } from '../src/fw/container';
import { buildFirmware } from '../src/fw/patch';
import { RTOS_OFFSET, RTOS_LENGTH, ICONBIN_OFFSET, ICONBIN_LENGTH } from '../src/fw/profile';
import { installExtensions, planRatios, TEXT_CATALOG, ICON_CATALOG, Patch } from '../src/fw/aspect/build';
import { branchTarget, movWord } from '../src/fw/aspect/arm';
import { readExtensionFeatures } from '../src/fw/aspect/package';
import { GR4_FILM_IDS, GR4_FILM_RECIPE_MAGIC, readGr4FilmRecipe } from '../src/fw/gr4/film-slots';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';
import { LANGS } from '../src/fw/names';
const input = process.env.GRMOD_GR4_FIRMWARE || new URL('../testdata/private/official.bin', import.meta.url);
const ids = ['fujifilm-provia-100f','fujifilm-provia-400f','fujifilm-velvia-50','fujifilm-velvia-100','kodak-portra-400','kodak-gold-200','kodak-ektar-100','kodak-kodachrome-64','cinestill-800t'];
const films = ids.map((id,i) => {
 const path = new URL(`../../ui/public/film-library/fits/${id}-gr4.json`,import.meta.url);
 const fixture = {matrixQ13:[8192-i*8,i*8,0,0,8192,0,0,0,8192],curves:Array.from({length:3},()=>Array.from({length:256},(_,v)=>Math.round(16383*(v/255)**(1+i*.01))))};
 return {name:`Test film ${i+1}`,preset:existsSync(path)?JSON.parse(readFileSync(path,'utf8')).result:fixture};
});
const requests = films.map((f,i)=>({slot:GR4_FILM_IDS[i],names:{en:f.name},preset:f.preset}));
const ratios=GFX_RATIOS.filter(r=>!['3:2','1:1','4:3','16:9'].includes(r)).map(r=>({name:r,ratio:r}));
const word=(b:Uint8Array,p:number)=>new DataView(b.buffer,b.byteOffset).getUint32(p,true);

describe.skipIf(!existsSync(input))('GR IV 1.11 independent film slots',()=>{
 let raw:Uint8Array,dec:Uint8Array,eng:Engine,rtos:Uint8Array,icons:Uint8Array;
 beforeAll(async()=>{
  raw=new Uint8Array(readFileSync(input));dec=new Firmware(raw).decoded;eng=await Engine.open(raw);
  rtos=dec.slice(RTOS_OFFSET,RTOS_OFFSET+RTOS_LENGTH);icons=dec.slice(ICONBIN_OFFSET,ICONBIN_OFFSET+ICONBIN_LENGTH);
 });
 it('offers nine independent slots with full shared names',()=>{
  expect(eng.info.slots.map(s=>s.id)).toEqual(GR4_FILM_IDS);
  for(let i=0;i<9;i++)for(const l of LANGS)expect(eng.info.slots[i].names[l]).toEqual({text:`Film ${i+1}`,capacity:24});
  expect(eng.validateName('F9','zh-CN','CineStill 800T').ok).toBe(true);
  expect(eng.validateName('F9','en','A'.repeat(25))).toMatchObject({ok:false,reason:'too-long'});
 });
 it('preserves all factory data, icons, language entries and aspect payload while appending private records',()=>{
  const baseline=installExtensions(rtos,icons,planRatios(ratios),{});
  const result=installExtensions(rtos,icons,planRatios(ratios),{filmSlots:true},undefined,{},films);
  const before=new Patch(baseline.rtos),after=new Patch(result.rtos);
  const additions=result.films!;
  expect(additions.slots.map(s=>s.id)).toEqual([64,65,66,67,68,69,70,71,72]);
  expect(new Set(additions.slots.map(s=>s.record)).size).toBe(9);
  expect(new Set(additions.slots.map(s=>s.gamma)).size).toBe(9);
  expect(Buffer.from(result.iconbin.subarray(0,baseline.iconbin.length)).equals(Buffer.from(baseline.iconbin))).toBe(true);
  // Every factory byte changed is an explicitly audited instruction; factory data starts later.
  const patchedWords=new Set(result.words.map(w=>w.address-0x53000000));
  for(let p=0;p<rtos.length;p+=4)if(word(rtos,p)!==word(result.rtos,p))expect(patchedWords.has(p)).toBe(true);
  for(let l=0;l<21;l++){
   const a=before.word(TEXT_CATALOG+l*4),b=after.word(TEXT_CATALOG+l*4);
   expect(Buffer.from(after.read(b,896*4)).equals(Buffer.from(before.read(a,896*4)))).toBe(true);
   for(const slot of additions.slots)expect(after.word(b+slot.textId*4)).toBe(slot.textAt);
  }
  expect(Buffer.from(after.read(ICON_CATALOG,663*4)).equals(Buffer.from(before.read(ICON_CATALOG,663*4)))).toBe(true);
  // Ratios' functions, geometry and RAW/JPEG handlers in appended code remain byte-identical.
  const roots=new Set(Array.from({length:21},(_,i)=>TEXT_CATALOG+i*4));
  for(const w of baseline.words)if(!roots.has(w.address)&&!w.reason?.includes('bound')) {
   // Resource lookup bounds legitimately grow for the film names and icons.
   if(result.words.some(n=>n.address===w.address&&n.reason?.startsWith('film:')))continue;
   expect(after.word(w.address),w.address.toString(16)).toBe(before.word(w.address));
  }
  const boundSites=[0x535734f4,0x53572ae0].map(a=>branchTarget(a,before.word(a))+4);
  for(const a of boundSites)expect(after.word(a)).toBe(movWord(3,968));
  const extendedBounds=new Set(boundSites.map(a=>a-0x53000000));
  const unexpected=[];
  for(let p=RTOS_LENGTH+0x2100;p<baseline.rtos.length;p+=4)
   if(word(result.rtos,p)!==word(baseline.rtos,p)&&!extendedBounds.has(p))unexpected.push((p+0x53000000).toString(16));
  expect(unexpected).toEqual([]);
  for(let i=0;i<9;i++){
   const slot=additions.slots[i],rec=after.read(slot.record,84),matrix=after.read(word(rec,4),18);
   expect(Array.from(new Int16Array(matrix.buffer))).toEqual(films[i].preset.matrixQ13);
   expect(after.read(slot.gamma,20)[5]).toBe(0);
   slot.curves.forEach((p,c)=>expect(Array.from(new Uint16Array(after.read(p,512).buffer))).toEqual(films[i].preset.curves[c]));
  }
 });
 it.each([false,true])('builds and inspects nine slots and nine ratios, optional additions=%s',async all=>{
  const built=await eng.buildFirmware(requests,ratios,[],all?{adjSoftFocus:true,dateStamp:true,monoUnlock:true}:{});
  expect(Object.values(built.checks).every(Boolean)).toBe(true);
  const d=new Firmware(built.file).decoded,section=sectionsOf(d).find(s=>s.name==='RTOS')!;
  const rr=d.subarray(section.offset,section.offset+section.size);
  expect(readExtensionFeatures(rr)?.filmSlots).toBe(true);
  expect(readGr4FilmRecipe(rr)?.map(f=>f.name)).toEqual(films.map(f=>f.name));
  const inspected=await eng.inspect(built.file);
  expect(inspected.verified).toBe(true);expect(inspected.slots).toHaveLength(9);expect(inspected.ratios).toHaveLength(5);
  expect(inspected.slots.map(s=>s.names.en)).toEqual(films.map(f=>f.name));
  expect(inspected.adjSoftFocus).toBe(all);expect(inspected.dateStamp).toBe(all);expect(inspected.monoUnlock).toBe(all);
 });
 it('supports a ninth-slot-only edit with stable empty identities and no added ratios',async()=>{
  const built=await eng.buildFirmware([requests[8]]);
  const inspected=await eng.inspect(built.file);expect(inspected.verified).toBe(true);
  expect(inspected.slots.map(s=>s.names.en)).toEqual([...Array.from({length:8},(_,i)=>`Film ${i+1}`),'Test film 9']);
 });
 it('rejects collisions, invalid curves, absent film data, and factory-slot replacements combined with films',async()=>{
  await expect(eng.buildFirmware([requests[0],requests[0]])).rejects.toMatchObject({code:'bad-edit'});
  await expect(eng.buildFirmware([{slot:'CY'}])).rejects.toMatchObject({code:'bad-edit'});
  await expect(eng.buildFirmware([{slot:'CY',names:{en:'x','zh-CN':'y'}}])).rejects.toMatchObject({code:'bad-name'});
  await expect(eng.buildFirmware([{slot:'CY',names:{en:'Film 9'}}])).rejects.toMatchObject({code:'bad-name'});
  const invalid=structuredClone(films);invalid[8].preset.curves[0][32]=-1;
  expect(()=>installExtensions(rtos,icons,[],{filmSlots:true},undefined,{},invalid)).toThrow();
  await expect(buildFirmware(raw,[],[],[],{}, {},films)).rejects.toMatchObject({code:'bad-edit'});
  await expect(buildFirmware(raw,[{slot:'CY',names:{en:'Old'}}],[],[],{filmSlots:true},{},films)).rejects.toMatchObject({code:'bad-edit'});
  const bad=new Uint8Array(RTOS_LENGTH+GR4_FILM_RECIPE_MAGIC.length+8);bad.set(GR4_FILM_RECIPE_MAGIC,RTOS_LENGTH);
  new DataView(bad.buffer).setUint32(RTOS_LENGTH+GR4_FILM_RECIPE_MAGIC.length,512001,true);
  expect(()=>readGr4FilmRecipe(bad)).toThrow();
 });
});
