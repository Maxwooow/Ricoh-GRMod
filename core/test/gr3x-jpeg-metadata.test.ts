import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { filmPhotoComment, validateFilmPhotoIdentity } from '../src/fw/gr3x/jpeg-metadata';
import { encodeGr3xLookRecipe, readGr3xLookRecipe } from '../src/fw/gr3x/look-recipe';
import { photoIdentity } from '../../ui/src/film-identity';
import { Engine } from '../src/app/engine';
import { GR3X_FILM_IDS } from '../src/fw/gr3x/look-resources';
import { GFX_RATIOS } from '../src/fw/gr3x/geometry';

const catalog=JSON.parse(readFileSync(new URL('../../ui/public/film-library/catalog.json',import.meta.url),'utf8'));
const fit=(id:string)=>JSON.parse(readFileSync(new URL(`../../ui/public/film-library/fits/${id}-gr3x.json`,import.meta.url),'utf8')).result;
const haveFits=catalog.stocks.filter((s:any)=>s.status==='ready').every((s:any)=>existsSync(new URL(`../../ui/public/film-library/fits/${s.id}-gr3x.json`,import.meta.url)));
it('accepts all 120 catalog identities, including a user-supplied source for the pending stock',()=>{
  expect(catalog.stocks).toHaveLength(120);
  for(const s of catalog.stocks) {
    const identity=photoIdentity(s,s.id+'.cube',s.status==='ready');
    validateFilmPhotoIdentity(identity);expect(identity.name).toBe(s.name);
    expect(identity.revision).toBe(s.status==='ready'?s.recipeVersion:'Custom-1');
  }
});
it.skipIf(!haveFits)('records versions/fingerprints of all 119 locally installed fits',async()=>{
  expect(catalog.stocks).toHaveLength(120);
  let ready=0;
  for(const s of catalog.stocks){
    const identity=photoIdentity(s,s.id+'.cube',s.status==='ready');
    validateFilmPhotoIdentity(identity);
    expect(identity.name).toBe(s.name);
    if(s.status!=='ready'){expect(identity.revision).toBe('Custom-1');continue;}
    ready++;
    const q=fit(s.id),m=await filmPhotoComment(identity,q);
    const bytes=Buffer.alloc(1554);q.matrixQ13.forEach((v:number,i:number)=>bytes.writeInt16LE(v,i*2));
    q.curves.forEach((c:number[],ch:number)=>c.forEach((v,i)=>bytes.writeUInt16LE(v,18+ch*512+i*2)));
    expect(m.parameterSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(m.payload).toHaveLength(192);
    expect(new TextDecoder().decode(m.payload.slice(0,8))).toBe('ASCII\0\0\0');
    expect(m.text).toContain('Film='+s.name+';Recipe='+s.recipeVersion+';');
  }
  expect(ready).toBe(119);
});
it('changes the fingerprint when actual rendering changes, not when a menu is renamed',async()=>{
  const q={matrixQ13:[8192,0,0,0,8192,0,0,0,8192],curves:Array.from({length:3},()=>Array.from({length:256},(_,i)=>Math.round(i*16383/255)))};
  const identity={name:'Example Film',revision:'test-1'};
  const a=await filmPhotoComment(identity,q);
  expect((await filmPhotoComment({...identity,name:'CineStill renamed'},q)).parameterSha256).toBe(a.parameterSha256);
  q.curves[0][100]++;
  expect((await filmPhotoComment(identity,q)).parameterSha256).not.toBe(a.parameterSha256);
  expect(photoIdentity(catalog.stocks.find((s:any)=>s.id==='cinestill-800t'),'edited.cube',false).revision).toBe('Custom-1');
});
it('rejects malformed/ambiguous EXIF names, versions and quantized parameters',async()=>{
  for(const name of ['','x'.repeat(65),'x;Recipe=wrong','x\nwrong','中文'])
    expect(()=>validateFilmPhotoIdentity({name,revision:'v1'})).toThrow();
  for(const revision of ['', 'x;Film=wrong','x'.repeat(25)])
    expect(()=>validateFilmPhotoIdentity({name:'Film',revision})).toThrow();
  await expect(filmPhotoComment({name:'Film',revision:'v1'},{matrixQ13:[1],curves:[]})).rejects.toThrow();
  expect(photoIdentity(undefined,'中文.cube',false).name).toBe('Custom Film');
});
it('round-trips metadata in the firmware recipe without changing the legacy recipe format',()=>{
  const identity={name:'Fujifilm Provia 100F',revision:'T6'};
  const options={displayRevision:3 as const,jpegMetadata:true,films:[{name:'Provia 100F',photo:identity}]};
  expect(readGr3xLookRecipe(encodeGr3xLookRecipe(options))).toMatchObject(options);
  const old={displayRevision:3 as const,films:[{name:'Provia 100F'}]};
  expect(new TextDecoder().decode(encodeGr3xLookRecipe(old))).not.toContain('jpegMetadata');
  expect(readGr3xLookRecipe(encodeGr3xLookRecipe(old))?.jpegMetadata).toBeUndefined();
  expect(()=>readGr3xLookRecipe(encodeGr3xLookRecipe({...options,films:[{name:'Film',photo:{name:'x;bad',revision:'1'}}]}))).toThrow();
});
describe.skipIf(!process.env.GRMOD_GR3X_FIRMWARE || !haveFits)('JPG identity through the public build/inspect API',()=>{
  it('reconstructs nine shuffled full identities with unchanged RAW and ratios',async()=>{
    const engine=await Engine.open(new Uint8Array(readFileSync(process.env.GRMOD_GR3X_FIRMWARE!)));
    const stocks=catalog.stocks.filter((s:any)=>s.status==='ready').slice(-9).reverse();
    const req=stocks.map((s:any,i:number)=>({slot:GR3X_FILM_IDS[i],names:{en:s.cameraName},
      photo:photoIdentity(s,s.id+'.cube',true),preset:fit(s.id)}));
    const ratios=GFX_RATIOS.filter(r=>!['3:2','1:1'].includes(r)).map(r=>({ratio:r,name:r}));
    const built=await engine.buildFirmware(req,ratios,[],{jpegMetadata:true});
    expect(Object.values(built.checks).every(Boolean)).toBe(true);
    const inspected=await engine.inspect(built.file);
    expect(inspected.verified).toBe(true);expect(inspected.slots).toHaveLength(9);expect(inspected.ratios).toHaveLength(7);
  });
});
