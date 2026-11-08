// SPDX-License-Identifier: GPL-2.0-only
import {describe,it,expect} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {Engine,fw} from '../src';
const p=new URL('../testdata/private/',import.meta.url).pathname;
function fixture(): string {
 const N=17, lines=['TITLE "white import test"',`LUT_3D_SIZE ${N}`];
 for(let b=0;b<N;b++)for(let g=0;g<N;g++)for(let r=0;r<N;r++){
  const R=r/(N-1),G=g/(N-1),B=b/(N-1);
  lines.push([R,G,B-0.2*B*B*(1-Math.min(R,G,B))].map(v=>Math.min(1,Math.max(0,v)).toFixed(6)).join(' '));
 }
 return lines.join('\n');
}
for(const [version,path] of [['1.11',p+'official.bin'],['1.20',process.env.GRMOD_GR4_120_FIRMWARE||p+'official120.bin']]){
 describe.skipIf(!existsSync(path))('white-anchor-import '+version,()=>{
  it('forwards the explicit option and writes the fitted payload without loss',async()=>{
   const e=await Engine.open(new Uint8Array(readFileSync(path))),text=fixture();
   const off=e.convertPreset('cube',text,undefined,{hue:true});
   const on=e.convertPreset('cube',text,undefined,{hue:true,keepWhite:true});
   expect(on).not.toEqual(off);
   const slot={name:'Fit test',matrixQ13:on.matrixQ13,curves:on.curves,...(on.postQ9?{postQ9:on.postQ9}:{}),...(on.hueQ10?{hueQ10:on.hueQ10}:{}),icon:new Uint8Array(6400),halation:false};
   const b=await e.buildFirmware([],[],[],{extraSlots:[slot]});
   expect(Object.values(b.checks).every(v=>v===true)).toBe(true);expect((await e.inspect(b.file)).verified).toBe(true);
   const d=new fw.Firmware(b.file).decoded,ss=fw.sectionsOf(d),r=ss.find(s=>s.name==='RTOS')!,i=ss.find(s=>s.name==='ICONBIN')!;
   const m=version==='1.20'?await import('../src/fw/gr4v120/aspect/slots'):await import('../src/fw/aspect/slots');
   const back=m.readExtraSlots(d.slice(r.offset,r.offset+r.size),d.slice(i.offset,i.offset+i.size),1)![0];
   expect(back.matrixQ13).toEqual(Array.from(on.matrixQ13));expect(back.curves).toEqual(on.curves.map(c=>Array.from(c)));expect(back.postQ9).toEqual(on.postQ9?Array.from(on.postQ9):undefined);expect(back.hueQ10).toEqual(on.hueQ10);
  },240000);
 });
}
