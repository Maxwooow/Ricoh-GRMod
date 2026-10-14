// Build every ready stock in batches through the real firmware patcher and self-checks.
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
registerHooks({resolve(s,c,next){try{return next(s,c)}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const ext of ['.ts','/index.ts'])try{return next(s+ext,c)}catch{}throw e}}});
const {Engine}=await import('../../core/src/app/engine.ts');
const {GFX_RATIOS}=await import('../../core/src/fw/gr3x/geometry.ts');
const {filmSlotName}=await import('../../ui/src/film-names.ts');
const family=process.argv[2]||'gr3x';
const root='ui/public/film-library';
const stocks=JSON.parse(await readFile(root+'/catalog.json','utf8')).stocks.filter(s=>s.status==='ready');
const e=await Engine.open(new Uint8Array(await readFile('../inputs/'+(family==='gr3x'?'fwdc243b.bin':'fwdc248b.bin'))));
const info=e.info;
const ratios=GFX_RATIOS.filter(r=>!info.factoryRatios.includes(r)).map(r=>({ratio:r,name:r}));
const ids=info.slots.map(s=>s.id), report=[];
for(let index=0;index<stocks.length;index+=ids.length){
  const batch=stocks.slice(index,index+ids.length), requests=[];
  for(let i=0;i<batch.length;i++){
    const s=batch[i], off=info.slots[i];
    const f=JSON.parse(await readFile(root+`/fits/${s.id}-${family}.json`,'utf8'));
    assert.equal(f.firmwareSha256,info.sha256);assert.equal(f.sourceSha256,s.cubeSha256);
    const names={};
    for(const [lang,desc]of Object.entries(off.names)){
      const cap=desc.capacity;
      names[lang]=filmSlotName(s,cap);
      assert(names[lang].length<=cap);
      assert([...names[lang]].every(c=>info.allowed[lang].includes(c)),`${s.id} ${lang}: invalid name ${names[lang]}`);
    }
    const label=await readFile('research/film-library-120/labels-rgba/'+s.id+'.rgba');
    const icon=info.tiles.film.slice(),a=info.contentArea.film,w=a.x1-a.x0+1,h=a.y1-a.y0+1;
    assert.equal(label.length,w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const at=((y+a.y0)*40+x+a.x0)*4,src=(y*w+x)*4;
      icon.set(label.subarray(src,src+3),at);icon[at+3]=255;
    }
    const r=f.result;
    requests.push({slot:ids[i],names,icon,preset:{matrixQ13:Int16Array.from(r.matrixQ13),curves:r.curves.map(c=>Uint16Array.from(c))}});
  }
  try{
    const built=await e.buildFirmware(requests,ratios,family==='gr3x'?[{level:-1,strength:'weak'},{level:-2,strength:'medium'},{level:-3,strength:'strong'}]:[],{monoUnlock:false});
    assert(Object.values(built.checks).every(v=>v===true));
    report.push({stocks:batch.map(s=>s.id),passed:true,sha256:built.sha256,checks:built.checks});
  }catch(error){report.push({stocks:batch.map(s=>s.id),passed:false,error:String(error)});}
  console.log(JSON.stringify({family,batch:report.length,passed:report.at(-1).passed,error:report.at(-1).error}));
}
await writeFile(`research/film-library-120/builds-${family}.json`,JSON.stringify({family,firmware:info.version,ratios,stockCount:stocks.length,report},null,2));
if(report.some(r=>!r.passed))process.exitCode=1;
