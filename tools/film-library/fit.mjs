import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
registerHooks({ resolve(s,c,next) { try {return next(s,c);} catch(e) {
  if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const ext of ['.ts','/index.ts'])try{return next(s+ext,c);}catch{}
  throw e;
} } });
const {Engine}=await import('../../core/src/app/engine.ts');
const family=process.argv[2]||'gr3x';
const base=resolve('ui/public/film-library');
const data=JSON.parse(await readFile(base+'/catalog.json','utf8'));
const raw=new Uint8Array(await readFile(resolve('../inputs',family==='gr3x'?'fwdc243b.bin':'fwdc248b.bin')));
const fwSha=createHash('sha256').update(raw).digest('hex');
const engine=await Engine.open(raw);
const report=[];
for(const stock of data.stocks) {
  if(stock.status!=='ready')continue;
  const path=base+`/fits/${stock.id}-${family}.json`;
  try{
    let old;try{old=JSON.parse(await readFile(path,'utf8'));}catch{}
    if(old?.sourceSha256===stock.cubeSha256&&old?.firmwareSha256===fwSha){report.push({id:stock.id,ok:true,meanDE:old.result.meanDE,p95DE:old.result.p95DE});continue;}
    const cube=gunzipSync(await readFile(base+'/'+stock.cube));
    if(createHash('sha256').update(cube).digest('hex')!==stock.cubeSha256)throw new Error('CUBE hash mismatch');
    const result=engine.convertPreset('cube',cube.toString('utf8'));
    const all=[...result.matrixQ13,...result.curves.flatMap(c=>[...c]),...result.params.M1.flat(),...result.params.ck.flatMap(c=>[...c])];
    if(all.some(x=>!Number.isFinite(x)))throw new Error('Nonfinite fit');
    await writeFile(path,JSON.stringify({schema:1,id:stock.id,family,firmwareSha256:fwSha,sourceSha256:stock.cubeSha256,result},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v));
    const item={id:stock.id,ok:true,meanDE:result.meanDE,p95DE:result.p95DE};report.push(item);console.log(JSON.stringify(item));
  }catch(error){report.push({id:stock.id,ok:false,error:String(error)});console.log(JSON.stringify(report.at(-1)));}
}
await writeFile(resolve(`research/film-library-120/fits-${family}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify({family,passed:report.filter(x=>x.ok).length,failed:report.filter(x=>!x.ok).length}));
