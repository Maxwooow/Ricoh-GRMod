import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
registerHooks({resolve(s,c,next){try{return next(s,c)}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))for(const ext of ['.ts','/index.ts'])try{return next(s+ext,c)}catch{}throw e}}});
const {Engine}=await import('../../core/src/app/engine.ts');
const {installExtensions,planRatios}=await import('../../core/src/fw/aspect/build.ts');
const {openOfficial,RTOS_OFFSET,RTOS_LENGTH,ICONBIN_OFFSET,ICONBIN_LENGTH}=await import('../../core/src/fw/profile.ts');
const {GFX_RATIOS}=await import('../../core/src/fw/gr3x/geometry.ts');
const out='research/gr4-film9';await mkdir(out,{recursive:true});
const raw=new Uint8Array(await readFile('../inputs/fwdc248b.bin'));
const {decoded}=await openOfficial(raw);const e=await Engine.open(raw);const info=e.info;
const catalog=JSON.parse(await readFile('ui/public/film-library/catalog.json','utf8')).stocks;
const ids=['fujifilm-provia-100f','fujifilm-provia-400f','fujifilm-velvia-50','fujifilm-velvia-100','kodak-portra-400','kodak-gold-200','kodak-ektar-100','kodak-kodachrome-64','cinestill-800t'];
const stocks=ids.map(id=>catalog.find(s=>s.id===id));
if(stocks.some(s=>!s)){console.log(catalog.filter(s=>/Provia|Velvia|Portra 400|Gold 200|Ektar 100|Kodachrome 64|CineStill 800T/i.test(s.name)).map(s=>({id:s.id,name:s.name})));throw Error('ids');}
const films=[],requests=[];
for(let i=0;i<9;i++){
 const s=stocks[i],fit=JSON.parse(await readFile('ui/public/film-library/fits/'+s.id+'-gr4.json','utf8')).result;
 const label=await readFile('research/film-library-120/labels-rgba/'+s.id+'.rgba');
 const icon=info.tiles.film.slice(),a=info.contentArea.film,w=a.x1-a.x0+1,h=a.y1-a.y0+1;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=((y+a.y0)*40+x+a.x0)*4,t=(y*w+x)*4;icon.set(label.subarray(t,t+4),d);}
 const film={name:s.cameraName,icon,preset:{matrixQ13:fit.matrixQ13,curves:fit.curves}};films.push(film);
 requests.push({slot:info.slots[i].id,names:{en:film.name},icon,preset:film.preset});
}
const ratios=GFX_RATIOS.filter(r=>!info.factoryRatios.includes(r)).map(r=>({name:r,ratio:r}));
const as=installExtensions(decoded.slice(RTOS_OFFSET,RTOS_OFFSET+RTOS_LENGTH),decoded.slice(ICONBIN_OFFSET,ICONBIN_OFFSET+ICONBIN_LENGTH),planRatios(ratios),{filmSlots:true},undefined,{},films);

await writeFile(out+'/rtos.bin',as.rtos);await writeFile(out+'/icons.bin',as.iconbin);
await writeFile(out+'/manifest.json',JSON.stringify({...as.films,words:as.words,ratios},null,2));
const built=await e.buildFirmware(requests,ratios);
await writeFile(out+'/fwdc248b.bin',built.file);
const summary=await e.inspect(built.file);
await writeFile(out+'/build.json',JSON.stringify({sha256:built.sha256,checks:built.checks,slots:info.slots.map(s=>({id:s.id,name:s.defaultName})),summary:{verified:summary.verified,kind:summary.kind,slots:summary.slots.map(s=>s.names.en),ratios:summary.ratios},hardwareTested:false},null,2));
console.log({sha256:built.sha256,checks:built.checks,verified:summary.verified,slots:summary.slots.length});
if(!summary.verified)throw Error('inspection failed');
