// SPDX-License-Identifier: GPL-2.0-only
/** Optional UI catalog expansion. The native getter keeps its original three-instruction ABI. */
import {Patch,ICON_CATALOG,LOOKUP_BOUNDS,expectWord,u32le} from '../build';
import {packEqualRgbaRuns} from './lossless';
import {movWord} from '../arm';
import {adr} from '../../target';
export interface SkinResource {id:number;width:number;height:number;ink?:readonly number[]}
export interface SkinCatalogOptions {catalogAddress:number;catalogCapacity:number;catalogHighestId:number;inkTableAddress:number}
export interface SkinResourceRecord {name:string;id:number;width:number;height:number;descriptorAddress:number;pixelOffset:number;key:string;reused:boolean;ink:readonly number[]}
export interface SkinCatalogReport extends SkinCatalogOptions {originalCatalogAddress:number;records:SkinResourceRecord[];providerWords:{site:number;before:number;after:number}[];iconbinBytes:number;deferredNativeWideIDs?:number[];pixelStorage?:{immutablePrefixBytes:number;unsharedAppendBytes:number;sharedAppendBytes:number;equalRgbaRunSavings:number}}
export function createSkinCatalog(patch:Patch,iconbin:Uint8Array){
 const capacity=8192,table=patch.append(new Uint8Array(capacity*4),16);
 patch.write(table,patch.read(ICON_CATALOG,1280*4));
 const blobs:{descriptor:number;bytes:Uint8Array}[]=[];let size=iconbin.length,next=1300,highest=0;
 for(let id=0;id<1280;id++)if(patch.word(table+id*4))highest=id;
 const assets:Record<string,SkinResource>={},records:SkinResourceRecord[]=[],ink=new Array<number>(capacity*4).fill(0);
 for(let id=0;id<1280;id++){
  const ptr=patch.word(table+id*4);if(!ptr)continue;
  const d=new DataView(patch.read(ptr,12).buffer),w=d.getUint16(2,true),h=d.getUint16(4,true);ink.splice(id*4,4,0,w,w,h);
 }
 const dedupe=new Map<string,{descriptor:number;offset:number}>();
 const put=(id:number,descriptor:number,mirror=true)=>{patch.setWord(table+id*4,descriptor,'uiSkin expanded icon entry');if(mirror&&id<1280)patch.setWord(ICON_CATALOG+id*4,descriptor,'uiSkin compatibility catalog mirror');highest=Math.max(highest,id);};
 const allocate=():number=>{while(next<capacity&&patch.word(table+next*4))next++;if(next>=capacity)throw new Error('uiSkin expanded catalog is full');return next++;};
 const register=(name:string,id:number,width:number,height:number,bytes:Uint8Array,key:string,bounds?:readonly number[],replace=false,mirror=true):SkinResource=>{
  if(!Number.isInteger(id)||id<0||id>=capacity||width<1||height<1||width>2048||height>2048||bytes.length!==width*height*4)throw new Error(`uiSkin invalid resource ${name}`);
  if(!replace&&patch.word(table+id*4)!==0)throw new Error(`uiSkin occupied resource ${id}`);
  let data=dedupe.get(`${width}x${height}:${key}`),reused=!!data;
  if(!data){
   if(size%4)throw new Error('uiSkin unaligned RGBA storage');
   const descriptor=new Uint8Array(12),v=new DataView(descriptor.buffer);v.setUint16(0,1,true);v.setUint16(2,width,true);v.setUint16(4,height,true);v.setUint32(8,size/4,true);
   data={descriptor:patch.append(descriptor,16),offset:size};dedupe.set(`${width}x${height}:${key}`,data);blobs.push({descriptor:data.descriptor,bytes});size+=bytes.length;
  }
  put(id,data.descriptor,mirror);const bb=bounds??[0,0,width,height];ink.splice(id*4,4,bb[0],Math.max(0,bb[2]-bb[0]),width,height);
  const a={id,width,height,ink:bb};assets[name]=a;records.push({name,id,width,height,descriptorAddress:data.descriptor,pixelOffset:data.offset,key,reused,ink:bb});return a;
 };
 const aliasNative=(name:string,id:number,bounds?:readonly number[]):SkinResource=>{
  const ptr=patch.word(table+id*4);if(!ptr)throw new Error(`uiSkin missing native icon ${id}`);const d=new DataView(patch.read(ptr,12).buffer),width=d.getUint16(2,true),height=d.getUint16(4,true),bb=bounds??[0,0,width,height];
  const a={id,width,height,ink:bb};assets[name]=a;ink.splice(id*4,4,bb[0],Math.max(0,bb[2]-bb[0]),width,height);records.push({name,id,width,height,descriptorAddress:ptr,pixelOffset:d.getUint32(8,true)*4,key:'native-original',reused:true,ink:bb});return a;
 };
 const aliasOriginal=(name:string,id:number,native:number,bounds?:readonly number[]):SkinResource=>{
  const ptr=patch.word(ICON_CATALOG+native*4);if(!ptr)throw new Error('design original icon missing '+native);const d=new DataView(patch.read(ptr,12).buffer),width=d.getUint16(2,true),height=d.getUint16(4,true),bb=bounds??[0,0,width,height];
  put(id,ptr);ink.splice(id*4,4,bb[0],Math.max(0,bb[2]-bb[0]),width,height);const a={id,width,height,ink:bb};assets[name]=a;records.push({name,id,width,height,descriptorAddress:ptr,pixelOffset:d.getUint32(8,true)*4,key:'native-original',reused:true,ink:bb});return a;
 };
 const finish=():{iconbin:Uint8Array;assets:Record<string,SkinResource>;options:SkinCatalogOptions;report:SkinCatalogReport}=>{
  // Keep every native pixel and its offset unchanged, including update UI resources.
  // Appended resources only share equal RGBA pixels at their complete-word boundaries.
  const packed=packEqualRgbaRuns(iconbin,blobs.map(b=>b.bytes));
  const relocated=new Map<number,number>();
  blobs.forEach((b,i)=>{const offset=packed.offsets[i];patch.setWord(b.descriptor+8,offset/4,'uiSkin lossless shared pixel offset');relocated.set(b.descriptor,offset);});
  for(const r of records){const offset=relocated.get(r.descriptorAddress);if(offset!==undefined)r.pixelOffset=offset;}
  const pixelStorage={immutablePrefixBytes:iconbin.length,unsharedAppendBytes:size-iconbin.length,sharedAppendBytes:packed.bytes.length-iconbin.length,equalRgbaRunSavings:packed.saved};
  size=packed.bytes.length;
  const words=[];
  for(const [site,expected,value]of [[adr(0x534013f8),movWord(0,ICON_CATALOG&65535),movWord(0,table&65535)],[adr(0x534013fc),movWord(0,ICON_CATALOG>>>16,true),movWord(0,table>>>16,true)]]as const){expectWord(patch,site,expected);patch.setWord(site,value,'uiSkin: relocated read-only icon catalog');words.push({site,before:expected,after:value});}
  for(const [site,reg]of LOOKUP_BOUNDS)patch.setWord(site,movWord(reg,highest),'uiSkin: expanded icon upper bound');
  const inkTable=patch.append(u32le(ink),16),options={catalogAddress:table,catalogCapacity:capacity,catalogHighestId:highest,inkTableAddress:inkTable};
  const report={...options,originalCatalogAddress:ICON_CATALOG,records,providerWords:words,iconbinBytes:size,pixelStorage};
  if(size>128*1024*1024)throw new Error("uiSkin ICONBIN exceeds128MiB");
  return{iconbin:packed.bytes,assets,options,report};
 };
 return {assets,register,aliasNative,aliasOriginal,allocate,finish,catalogAddress:table,catalogCapacity:capacity};
}
