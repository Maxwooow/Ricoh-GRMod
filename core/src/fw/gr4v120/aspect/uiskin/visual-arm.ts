// SPDX-License-Identifier: GPL-2.0-only
/** Host-only expansion for validated visual constants. Native addresses/branches are untouched. */
import {assembleWords,encodeImmediate} from '../arm';
import {FirmwareError} from '../../../types';
const conditions=new Set(['','eq','ne','cs','hs','lo','cc','mi','pl','vs','vc','hi','ls','ge','lt','gt','le','al']);
const regNumber=(r:string):number=>({ip:12,sp:13,lr:14,pc:15} as Record<string,number>)[r]??Number(r.slice(1));
export function expandVisualImmediates(source:string):string{
 const out:string[]=[];
 for(const token of source.replace(/\/\/[^\n]*/g,'').split(/[;\n]/)){
  let s=token.trim();if(!s)continue;let label='';
  for(;;){const m=/^([a-zA-Z_]\w*):\s*(.*)$/.exec(s);if(!m)break;label+=m[1]+': ';s=m[2];}
  const m=/^(mov|cmp|add|sub|rsb)([a-z]*)\s+(.+),\s*#(-?(?:0x[0-9a-f]+|\d+))$/i.exec(s);
  if(!m){out.push(label+s);continue;}
  const op=m[1].toLowerCase(),suffix=m[2].toLowerCase(),operands=m[3],value=Number(m[4]);
  if(op==='mov'&&(suffix.startsWith('w')||suffix.startsWith('t'))){out.push(label+s);continue;}
  if(encodeImmediate(value)!==null){out.push(label+s);continue;}
  const sets=suffix.startsWith('s')&&!conditions.has(suffix),cond=sets?suffix.slice(1):suffix;
  if(!conditions.has(cond))throw new FirmwareError('ui-design-asm','invalid visual condition');
  const used=[...operands.matchAll(/\b(?:r(?:1[0-5]|[0-9])|ip|lr|sp|pc)\b/gi)].map(x=>regNumber(x[0].toLowerCase()));
  if(used.includes(13)||used.includes(15))throw new FirmwareError('ui-design-asm','visual constants cannot resize the stack or change PC');
  const n=value>>>0,load=(r:string)=>[`movw${cond} ${r},#${n&65535}`,...(n>>>16?[`movt${cond} ${r},#${n>>>16}`]:[])];
  if(op==='mov'){
   const r=operands.trim();out.push(label+load(r).join('; '));if(sets)out.push(`tst${cond} ${r},${r}`);continue;
  }
  const spare=['ip','lr','r3','r2','r1','r0'].filter(r=>!used.includes(regNumber(r))).slice(0,2),temp=spare[0];
  const saved=[...spare].sort((a,b)=>regNumber(a)-regNumber(b)).join(',');
  out.push(label+`push {${saved}}`,...load(temp),`${op}${sets?'s':''}${cond} ${operands},${temp}`,`pop {${saved}}`);
 }
 return out.join(';\n');
}
export function assembleVisualWords(source:string,origin:number):number[]{return assembleWords(expandVisualImmediates(source),origin);}
