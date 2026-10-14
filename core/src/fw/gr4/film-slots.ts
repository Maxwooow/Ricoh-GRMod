// SPDX-License-Identifier: GPL-2.0-only
/** GR IV 1.11: nine immutable still-photo looks, after the untouched factory list.
 * Public identities 64..72 are preserved in settings; audited native consumers
 * see Standard. Matrix records and Cinema-format RGB descriptors are private.
 * No camera-global tone byte is temporarily rewritten during rendering.
 */
import { Patch, ICON_CATALOG, TEXT_CATALOG, LANGUAGES, LOOKUP_BOUNDS, expectWord, u16le, u32le, concat, utf16z } from '../aspect/build';
import { assembleWords, branchWord, movWord, movImmediate, wordsToBytes } from '../aspect/arm';
import { normalizeIcon } from '../icons';
import { FirmwareError } from '../types';
import { GR4_TONE_READS, GR4_DEFAULTS } from './look-addresses';
import { gr3xLookBadge } from '../gr3x/look-icons';

export const GR4_FILM_IDS = ['CY','CG','F3','F4','F5','F6','F7','F8','F9'] as const;
export const GR4_FILM_NAMES = GR4_FILM_IDS.map((_, i) => `Film ${i + 1}`);
export const GR4_FILM_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('');
export interface Gr4Film {
  name: string;
  icon?: Uint8Array;
  preset?: { matrixQ13: ArrayLike<number>; curves: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] };
}
export function validateGr4FilmName(name: string): void {
  if (typeof name !== 'string' || !name.trim() || name.length > 24 || /[^\x20-\x7e]/.test(name))
    throw new FirmwareError('bad-name', 'GR IV film names use 1..24 printable ASCII characters');
}
const addr = (r: number, a: number) => `movw r${r},#${a & 65535};movt r${r},#${a >>> 16};`;
export const GR4_FILM_RECIPE_MAGIC = new TextEncoder().encode('GR4-FILM9-RECIPE\0');
export function readGr4FilmRecipe(rtos: Uint8Array): Gr4Film[] | null {
  const magic = GR4_FILM_RECIPE_MAGIC;
  for (let at = 0x13d2ac0; at + magic.length + 4 < rtos.length; at++) {
    if (!magic.every((v,i) => rtos[at+i] === v)) continue;
    const size = new DataView(rtos.buffer, rtos.byteOffset).getUint32(at + magic.length, true);
    const start = at + magic.length + 4;
    if (size > 512000 || start + size > rtos.length) throw new FirmwareError('bad-edit', 'invalid GR IV film recipe extent');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rtos.subarray(start,start+size)));
    if (value.schema !== 1 || !Array.isArray(value.films) || value.films.length !== 9)
      throw new FirmwareError('bad-edit', 'invalid GR IV film recipe');
    return value.films.map((f: any) => {
      validateGr4FilmName(f.name);
      if (f.icon && (!Array.isArray(f.icon) || f.icon.length !== 6400 || f.icon.some((v: number) => !Number.isInteger(v) || v < 0 || v > 255)))
        throw new FirmwareError('bad-icon', 'invalid GR IV film recipe icon');
      return { name: f.name, ...(f.icon ? { icon: Uint8Array.from(f.icon) } : {}), ...(f.preset ? { preset: f.preset } : {}) };
    });
  }
  return null;
}
export function installGr4Films(p: Patch, iconbin: Uint8Array, films: readonly Gr4Film[]) {
  if (films.length !== 9) throw new FirmwareError('bad-edit', 'GR IV reserves nine stable film identities');
  films.forEach(f => validateGr4FilmName(f.name));
  if (new Set(films.map(f=>f.name)).size !== 9) throw new FirmwareError('bad-name', 'film names must be unique');
  const u32 = (a: number) => new DataView(p.readMapped(a,4).buffer).getUint32(0,true);
  const code = (s: string) => p.append(wordsToBytes(assembleWords(s,p.next(4))));
  const hook = (at: number, old: number, target: number, why: string, link = false) => {
    expectWord(p,at,old); p.setWord(at,branchWord(at,target,14,link),`film: ${why}`);
  };
  const neutral = Uint8Array.from([4,4,4,4,4,4,1,4,0,1,4,0,0,0,0,0,0,0,0,0,0,4,4,4,0,0]);
  const neutralAt = p.append(neutral);
  // Read the factory Standard record and Cinema RGB format; never mutate either.
  const standard = p.readMapped(u32(0x55053780 + 11*4),84);
  const standardMatrix = p.readMapped(new DataView(standard.buffer).getUint32(4,true),18);
  const matrix = Array.from({length:9},(_,i)=>new DataView(standardMatrix.buffer).getInt16(i*2,true));
  const templateDesc = p.readMapped(u32(0x55053138 + 18*4),20);
  if (templateDesc[4] !== 1 || templateDesc[5] !== 1) throw new FirmwareError('unexpected-layout','GR IV RGB descriptor flags');
  // Original Nega frame pixels are shared with the UI's template.
  const tileRecord = p.readMapped(u32(0x55013410 + 19*4),12);
  const tv = new DataView(tileRecord.buffer);
  if (tv.getUint16(2,true)!==40 || tv.getUint16(4,true)!==40) throw new FirmwareError('unexpected-layout','GR IV film tile dimensions');
  const template = iconbin.slice(tv.getUint32(8,true)*4,tv.getUint32(8,true)*4+6400);
  const pixels: Uint8Array[] = [iconbin];
  const slots = films.map((f,i)=>{
    const q = f.preset ?? {matrixQ13:matrix,curves:[0,1,2].map(()=>Array.from({length:256},(_,j)=>j*64))};
    if (q.matrixQ13?.length!==9 || Array.from(q.matrixQ13).some(v=>!Number.isInteger(v)||v < -32768||v>32767) ||
      [0,1,2].some(r=>q.matrixQ13[r*3]+q.matrixQ13[r*3+1]+q.matrixQ13[r*3+2]!==8192) ||
      q.curves?.length!==3 || q.curves.some(c=>c?.length!==256 || Array.from(c).some((v,j,a)=>!Number.isInteger(v)||v<0||v>16383||(j>0&&v<a[j-1]))))
      throw new FirmwareError('bad-color','invalid GR IV matrix/RGB curves');
    const record=standard.slice(), rv=new DataView(record.buffer);
    rv.setUint32(4,p.append(u16le(Array.from(q.matrixQ13,x=>x&65535))),true);
    const curves=q.curves.map(c=>p.append(u16le(Array.from(c))));
    const gamma=templateDesc.slice(), gv=new DataView(gamma.buffer); gamma[5]=0;
    curves.forEach((a,j)=>gv.setUint32(8+j*4,a,true));
    const recordAt=p.append(record), gammaAt=p.append(gamma);
    const px=normalizeIcon(template,f.icon ?? gr3xLookBadge(template,'F',i+1));
    const iconAt=p.append(concat([u16le([1,40,40,0]),u32le([(iconbin.length+i*6400)/4])]));
    const iconId=960+i, textId=960+i;
    if(p.word(ICON_CATALOG+iconId*4)!==0) throw new FirmwareError('unexpected-layout','film icon identity is occupied');
    p.setWord(ICON_CATALOG+iconId*4,iconAt,'film: icon record'); pixels.push(px);
    const nameAt=p.append(utf16z(f.name));
    const textAt=p.append(concat([Uint8Array.of(f.name.length+1,1,0,0),u32le([nameAt])]));
    return {id:64+i,name:f.name,record:recordAt,gamma:gammaAt,curves,iconId,iconAt,textId,textAt};
  });
  let priorColumns=896;
  for(const at of p.textBoundSites) priorColumns=Math.max(priorColumns,movImmediate(p.word(at))+1);
  if(priorColumns>960) throw new FirmwareError('unexpected-layout','film text identities are occupied');
  for(let l=0;l<LANGUAGES;l++){
    const row=new Uint8Array(969*4);row.set(p.read(p.word(TEXT_CATALOG+l*4),priorColumns*4));
    const v=new DataView(row.buffer);for(const s of slots)v.setUint32(s.textId*4,s.textAt,true);
    p.setWord(TEXT_CATALOG+l*4,p.append(row),'film: language row');
  }
  for(const at of p.textBoundSites)p.setWord(at,movWord(3,968),'film: text bound');
  for(const [at,r] of LOOKUP_BOUNDS)p.setWord(at,movWord(r,968),'film: icon bound');
  const map=(r:number)=>slots.map(s=>`cmp r${r},#${s.id};moveq r${r},#11;`).join('');
  const display=(at:number,old:number,key:'textId'|'iconId',replay:string)=>{
    const entry=code(slots.map(s=>`cmp r1,#${s.id};movweq r0,#${s[key]};bxeq lr;`).join('')+replay+`b #${at+4};`);
    hook(at,old,entry,key);return entry;
  };
  const entries: Record<string,number> = {
    name:display(0x53397044,0xe1a0c00d,'textId','mov ip,sp;'),
    icon:display(0x533971cc,0xe1a0c00d,'iconId','mov ip,sp;'),
    shortName:display(0x5337f824,0xe351000a,'textId','cmp r1,#10;'),
    tileIcon:display(0x53380fac,0xe351000a,'iconId','cmp r1,#10;'),
  };
  // Extend the actual dynamic factory vector, its constructor reserve and maximum.
  const order=p.read(0x53dbe388,20);
  if(Array.from(order).join(',')!=='11,12,13,14,15,16,24,17,18,19,23,20,21,22,25,29,26,27,28,30')
    throw new FirmwareError('unexpected-layout','GR IV factory look order changed');
  const orderAt=p.append(Uint8Array.from([...order,...slots.map(s=>s.id)]));
  for(const [at,old,value] of [[0x533cc78c,movWord(4,0xe388),movWord(4,orderAt&65535)],
    [0x533cc794,movWord(4,0x53db,true),movWord(4,orderAt>>>16,true)],
    [0x533cc7a4,0xe2847014,0xe284701d],[0x533bebf0,0xe3a00014,0xe3a0001d],
    [0x533cc8c8,0xe3a00014,0xe3a0001d],[0x533cc90c,0xe2853014,0xe285301d]]){
    expectWord(p,at,old);p.setWord(at,value,'film: expanded factory vector capacity');
  }
  const mono = p.word(0x533cc6e0)===0xe3510018;
  expectWord(p,0x533cc6e0,mono?0xe3510018:0xe3520000);
  entries.visible=code(`cmp r1,#64;blo native;cmp r1,#72;bhi native;cmp r2,#0;movne r0,#0;bxne lr;
    ldrb ip,[r0,#0x1f];cmp ip,#0;moveq r0,#1;movne r0,#0;bx lr;
    native:${mono?'cmp r1,#24;':'cmp r2,#0;'}b #0x533cc6e4;`);
  hook(0x533cc6e0,mono?0xe3510018:0xe3520000,entries.visible,'additional still looks visibility');
  const adapters=GR4_TONE_READS.map(([at,word])=>{
    const dst=word>>>12&15,src=word>>>16&15,scratch=[0,1,2,3].find(r=>r!==dst&&r!==src)!;
    const entry=code(`push {r${scratch}};mrs r${scratch},cpsr;ldrb r${dst},[r${src},#0x79c];`+map(dst)+`msr cpsr_f,r${scratch};pop {r${scratch}};b #${at+4};`);
    hook(at,word,entry,'typed native consumer');return {address:at,entry,sourceRegister:src,destinationRegister:dst};
  });
  // Aggregate CommonProperty starts at 0x6e4: tone is at 0xb8, parameters at 0xb9.
  entries.aggregate=code(`push {r0-r3,ip,lr};ldrb r2,[r6,#0xb8];cmp r2,#64;blo done;cmp r2,#72;bhi done;
    add r0,r6,#0xb9;${addr(1,neutralAt)}mov r2,#26;bl #0x53156140;
    done:pop {r0-r3,ip,lr};mov r1,r6;b #0x5329f660;`);
  hook(0x5329f65c,0xe1a01006,entries.aggregate,'fixed neutral parameters in native transaction');
  entries.rawEnum=code(map(1)+'sub r1,r1,#11;b #0x53373bc4;');
  hook(0x53373bc0,0xe241100b,entries.rawEnum,'RAW development native-base fallback');
  entries.restriction=code(map(1)+'cmp r1,#0;b #0x5375f0b4;');
  hook(0x5375f0b0,0xe3510000,entries.restriction,'native shooting restrictions');
  const defaults=GR4_DEFAULTS.map(([at,value])=>{
    const entry=code(slots.map(s=>`cmp r1,#${s.id};moveq r0,#${value};bxeq lr;`).join('')+`mov ip,sp;b #${at+4};`);hook(at,0xe1a0c00d,entry,'Standard default parameters');return {address:at,entry,value};
  });
  // The same private Cinema-format RGB descriptors as the old importer used,
  // paired with private Standard matrices. The factory gamma object's reset stays native.
  entries.descriptor=code('push {r1-r3,ip};ldrb r2,[r7,#0x79c];'+
    slots.map(s=>`cmp r2,#${s.id};beq slot${s.id};`).join('')+'b done;'+
    slots.map(s=>`slot${s.id}:${addr(3,s.record)}str r3,[r4,#8];${addr(3,s.gamma)}str r3,[r4,#20];b done;`).join('')+
    'done:pop {r1-r3,ip};b #0x53927228;');
  hook(0x5391318c,branchWord(0x5391318c,0x53927228,14,true),entries.descriptor,'private matrix and RGB descriptor',true);
  const recipe=new TextEncoder().encode(JSON.stringify({schema:1,films:films.map(f=>({name:f.name,
    ...(f.icon?{icon:Array.from(f.icon)}:{}),...(f.preset?{preset:{matrixQ13:Array.from(f.preset.matrixQ13),curves:f.preset.curves.map(c=>Array.from(c))}}:{})}))}));
  if(recipe.length>512000)throw new FirmwareError('bad-edit','GR IV recipe too large');
  p.append(concat([GR4_FILM_RECIPE_MAGIC,u32le([recipe.length]),recipe]));p.extendTo((p.length+3)&~3);
  return {iconbin:concat(pixels),manifest:{slots,entries,adapters,defaults,orderAt,neutralAt,hardwareTested:false}};
}
