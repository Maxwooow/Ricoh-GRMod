// SPDX-License-Identifier: GPL-2.0-only
/**
 * Interface theme Modern: its images go into the resource catalog (createSkinCatalog), then its drawing code (runtime, playback,
 * live view). The images are final pixels (theme-data.ts); the camera's own pixels stay where they are, the theme's are appended.
 */
import type {Patch} from '../build';
import {THEME_ASSETS,THEME_ICONS,THEME_WHEEL,THEME_MENU,THEME_EXTRA,THEME_ADDED,themePixels,type ThemeImage} from '../../../theme/modern-data';
import {createSkinCatalog,type SkinCatalogReport} from './resources';
import {installUiSkinRuntime} from './runtime';
import {installUiSkinLiveView} from './liveview';
import {installUiSkinPlayback} from './playback';
export interface UiSkinAsset {id:number;width:number;height:number;ink?:readonly number[]}
export let UI_SKIN_LAST_CATALOG_REPORT:SkinCatalogReport|null=null;
/** The first resource number of the theme's own assets in the last install (1100 unless an addition owns numbers there). */
export let UI_SKIN_LAST_ASSET_BASE=1100;
export function installUiSkin(patch:Patch,iconbin:Uint8Array):Uint8Array{
 const c=createSkinCatalog(patch,iconbin);
 const put=(a:ThemeImage,id:number,replace=false,mirror=true)=>c.register(a.n,id,a.w,a.h,themePixels(a),'image '+a.p,a.i,replace,mirror);
 // The theme's own assets take one block of numbers from 1100 (below 1280, mirrored into the stock catalog). An addition
 // installed before it may own numbers there (battery percent: 1100..1111): the block then starts after them, at the first
 // number from which the whole block is free.
 const blockFree=(b:number)=>{for(let i=0;i<THEME_ASSETS.length;i++)if(patch.word(c.catalogAddress+(b+i)*4))return false;return true;};
 let baseId=1100;while(!blockFree(baseId)){baseId++;if(baseId+THEME_ASSETS.length>1280)throw new Error('theme: no free block of resource numbers below 1280');}
 UI_SKIN_LAST_ASSET_BASE=baseId;
 for(const a of THEME_ASSETS){const id=baseId++;if(a.p>=0)put(a,id);}
 for(const row of THEME_ICONS){
  const native=row.native;
  if([514,590,627].includes(native)&&row.variants.some(v=>v.p!==undefined))throw new Error('theme: firmware update icon changed');
  if(!row.variants.some(v=>v.p!==undefined)){
   // Kept as the camera's, but for the current-value dot (499), redrawn in place: every page that draws it shows the theme's.
   if(row.opened){put(row.opened,native,true);for(const v of row.variants)if(v.variant!=='light')c.aliasNative(v.n!,native,v.ink);continue;}
   for(const v of row.variants){if(row.action==='preserve-upgrade'&&v.variant==='dark')continue;c.aliasNative(v.n!,native,v.ink);}continue;
  }
  for(const v of row.variants){
   const own=v as ThemeImage;put(own,v.variant===row.def?native:c.allocate(),v.variant===row.def);
   for(const a of v.alpha??[])put(a,c.allocate());
  }
 }
 for(const a of THEME_WHEEL)put(a,c.allocate());
 for(const a of THEME_MENU)put(a,c.allocate());
 // Icons of GR Mod additions, where the build has them.
 for(const row of THEME_EXTRA){
  const native=row.native;if(!Number.isInteger(native)||native<=708||native>=1300)throw new Error('theme: extra icon number must be 709..1299');
  if(!patch.word(c.catalogAddress+native*4))continue;
  c.aliasNative(`extra-original-${native}`,native);
  const {light,dark}=row;
  if(light.unchanged)c.aliasNative(light.n,native,light.i);else put(light,native,true,false);
  if(dark.unchanged){if(light.unchanged)c.aliasNative(dark.n,native,dark.i);else c.aliasOriginal(dark.n,c.allocate(),native,dark.i);}
  else put(dark,c.allocate());
  if(row.menuLight)put(row.menuLight,c.allocate());
  for(const a of row.alpha??[])put(a,c.allocate());
 }
 for(const a of THEME_ADDED){if(c.assets[a.n])throw new Error('theme: duplicate asset '+a.n);put(a,c.allocate());}
 const done=c.finish();UI_SKIN_LAST_CATALOG_REPORT=done.report;
 if(done.iconbin.length>128*1024*1024)throw new Error('theme: ICONBIN exceeds the native memory budget');
 installUiSkinRuntime(patch,done.assets,done.options);installUiSkinPlayback(patch,done.options);
 installUiSkinLiveView(patch,done.assets,done.options);
 return done.iconbin;
}
