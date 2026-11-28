// SPDX-License-Identifier: GPL-2.0-only
import {describe,it,expect} from 'vitest';
import {packEqualRgbaRuns} from '../src/fw/gr4v120/aspect/uiskin/lossless';
import {assertUiSkinSizeBudget,UI_SKIN_SIZE_BUDGET} from '../src/fw/gr4v120/aspect/uiskin/budget';
const rgba=(...pixels:number[][])=>Uint8Array.from(pixels.flat());
describe('Modern theme lossless pixel storage',()=>{
 it('keeps the original prefix and every complete resource byte string',()=>{
  const prefix=rgba([1,2,3,4],[5,6,7,8]),a=rgba([9,8,7,255],[255,255,255,0],[255,255,255,0]),b=rgba([255,255,255,0],[255,255,255,0],[0,0,0,255]);
  const packed=packEqualRgbaRuns(prefix,[a,b]);
  expect(packed.bytes.subarray(0,prefix.length)).toEqual(prefix);expect(packed.saved).toBe(8);
  for(const [i,pixels]of[a,b].entries()){expect(packed.offsets[i]%4).toBe(0);expect(packed.bytes.subarray(packed.offsets[i],packed.offsets[i]+pixels.length)).toEqual(pixels);}
 });
 it('preserves RGB even where alpha is zero',()=>{
  const a=rgba([100,2,3,255],[0,0,0,0]),b=rgba([255,255,255,0],[8,7,6,255]);
  const p=packEqualRgbaRuns(new Uint8Array(),[a,b]);expect(p.saved).toBe(0);expect(p.bytes.length).toBe(a.length+b.length);
 });
 it('handles uniform resources and cycles without corrupting a shared span',()=>{
  const a=rgba([1,2,3,0],[8,7,6,0],[1,2,3,0]),b=rgba([1,2,3,0],[1,2,3,0]),c=rgba([8,7,6,0],[1,2,3,0],[8,7,6,0]);
  const p=packEqualRgbaRuns(new Uint8Array(),[a,b,c]);for(const[i,x]of[a,b,c].entries())expect(p.bytes.subarray(p.offsets[i],p.offsets[i]+x.length)).toEqual(x);
 });
 it('leaves an empty catalog prefix intact and rejects incomplete pixels',()=>{
  const prefix=rgba([1,2,3,4]);expect(packEqualRgbaRuns(prefix,[]).bytes).toEqual(prefix);expect(()=>packEqualRgbaRuns(prefix,[new Uint8Array(3)])).toThrow(/RGBA/);
 });
});
describe('Modern theme firmware size budget',()=>{
 it('is 99 % of the largest file a camera took',()=>{
  expect(UI_SKIN_SIZE_BUDGET.fileBytes).toBe(Math.floor(81_000_780*.99));expect(UI_SKIN_SIZE_BUDGET.decodedBytes).toBe(Math.floor(110_600_932*.99));expect(()=>assertUiSkinSizeBudget(UI_SKIN_SIZE_BUDGET,{modernTheme:true})).not.toThrow();
 });
 it.each(['fileBytes','decodedBytes']as const)('rejects one byte beyond %s',key=>{
  expect(()=>assertUiSkinSizeBudget({[key]:UI_SKIN_SIZE_BUDGET[key]+1},{modernTheme:true})).toThrow(/checked budget/);
 });
 it('leaves a build without the theme alone',()=>{
  expect(()=>assertUiSkinSizeBudget({fileBytes:91_000_000,decodedBytes:121_000_000},{})).not.toThrow();
 });
 it('rejects the sizes of a file a camera refused',()=>{
  expect(()=>assertUiSkinSizeBudget({fileBytes:90_954_872,decodedBytes:120_554_212},{modernTheme:true})).toThrow(/ui-skin-size-limit/);
 });
});
