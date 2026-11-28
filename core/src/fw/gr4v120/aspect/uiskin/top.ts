// SPDX-License-Identifier: GPL-2.0-only
/** Instance-only live status layout. Called inside the private display lock, before native Canvas pre-draw. */
import {UI_SKIN_DESIGN as D} from './design';
import { Patch, u32le } from '../build';

import {assembleVisualWords as assembleWords} from './visual-arm';
import type { SkinAsset } from './runtime';
import {adr,adrHex} from '../../target';
export interface UiSkinTopReport { prepare:number; symbols:Record<string,number>; regions:{name:string;address:number;length:number;purpose:string}[]; fallbacks:string[] }
const NATIVE_INK:readonly (readonly number[])[]=[[0,0,0,0],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[4,4,136,116],[4,4,136,116],[3,4,37,36],[0,5,37,38],[0,5,40,38],[0,5,40,38],[0,2,400,58],[22,0,218,40],[22,0,218,40],[22,0,218,40],[0,0,520,200],[0,0,520,200],[1,2,39,38],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[0,0,40,40],[1,2,39,38],[2,7,38,33],[1,1,39,39],[1,1,39,39],[1,1,39,39],[0,0,26,20],[3,2,57,38],[3,2,57,38],[1,1,39,39],[0,2,400,58],[3,1,59,39],[3,1,59,39],[1,5,39,35],[1,5,39,35],[1,5,39,35],[7,4,33,36],[2,0,58,20],[2,0,58,20],[0,0,26,20],[1,1,39,39],[1,2,39,38],[0,2,400,58],[1,1,39,39],[1,1,39,39],[1,1,39,39],[0,0,160,160],[0,0,160,160],[0,0,16,16],[1,1,39,39],[5,5,95,95],[0,2,400,58],[5,5,95,95],[3,6,57,34],[3,4,37,23],[0,4,40,40],[2,4,18,16],[0,0,340,160],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[0,7,10,33],[5,1,15,19],[1,2,39,38],[0,0,120,160],[1,5,39,35],[0,2,340,76],[0,2,160,76],[0,2,80,76],[0,2,60,76],[0,0,10,10],[0,0,10,10],[0,0,10,10],[0,0,10,10],[0,0,10,10],[0,0,20,20],[6,16,14,24],[0,0,40,40],[0,0,40,40],[0,0,40,40],[0,0,60,60],[0,0,40,40],[0,0,40,40],[0,0,50,50],[0,0,12,12],[2,0,58,20],[2,0,58,20],[5,5,95,95],[5,5,95,95],[5,5,95,95],[3,4,37,23],[0,4,40,40],[8,12,24,28],[4,1,27,18],[3,1,26,18],[4,7,36,33],[3,2,38,39],[3,11,38,29],[2,11,37,29],[3,2,57,38],[0,0,40,40],[0,0,40,40],[0,0,40,40],[0,0,40,40],[4,12,36,28],[2,3,38,37],[6,3,34,37],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[0,6,29,24],[6,1,25,29],[5,8,35,24],[5,16,35,32],[3,3,37,37],[3,7,38,33],[6,4,32,36],[3,0,10,20],[0,0,23,20],[0,0,23,20],[0,0,23,20],[0,0,13,20],[0,0,26,20],[0,0,13,20],[0,0,13,20],[2,6,38,35],[5,5,35,35],[3,9,37,31],[3,8,35,32],[5,6,34,34],[0,5,40,35],[1,1,39,39],[1,1,39,39],[9,1,39,31],[1,1,39,39],[1,1,39,39],[1,1,67,67],[6,10,54,30],[1,1,39,39],[7,10,33,30],[17,1,263,38],[4,1,27,18],[3,1,26,18],[0,1,8,18],[0,1,8,18],[0,1,8,18],[0,1,8,18],[0,1,8,18],[3,6,37,34],[0,0,60,60],[0,0,60,60],[0,0,60,60],[0,0,60,60],[9,3,31,37],[1,1,39,39],[0,5,40,35],[0,5,40,35],[0,5,40,35],[0,5,40,35],[20,0,220,40],[20,0,220,40],[20,18,220,22],[20,17,220,23],[2,2,20,18],[0,2,18,18],[2,0,18,18],[2,2,18,20],[3,2,57,38],[3,2,57,38],[3,2,57,38],[0,2,400,58],[2,7,8,33],[8,5,389,42],[0,2,400,58],[20,0,220,40],[1,1,39,39],[0,0,284,60],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,2,40,39],[2,2,38,39],[1,1,39,39],[1,1,39,39],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,11,40,29],[0,3,40,37],[0,3,40,37],[1,7,39,33],[9,6,32,34],[0,11,40,29],[2,2,38,38],[1,2,39,39],[1,2,39,39],[1,2,39,39],[1,2,39,39],[1,5,39,35],[2,6,38,33],[2,6,38,37],[0,1,20,9],[1,1,39,39],[1,1,39,39],[1,9,39,31],[1,2,39,38],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[3,6,37,33],[2,2,10,10],[3,8,17,312],[2,4,18,16],[6,2,15,18],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,2,39,38],[1,1,39,39],[1,1,39,39],[1,1,39,39],[3,1,57,39],[3,1,57,39],[3,1,57,39],[3,1,57,39],[3,8,60,32],[3,8,60,32],[0,8,53,32],[4,8,57,32],[4,8,57,32],[4,8,57,32],[3,2,60,32],[3,2,60,32],[3,2,60,32],[1,1,39,39],[3,1,57,39],[1,1,39,39],[1,1,39,39],[0,0,57,40],[4,4,36,36],[4,4,36,36],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,4,39,36],[1,4,39,36],[1,1,39,39],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[11,21,169,99],[8,0,132,193],[0,0,160,160],[0,0,160,160],[9,0,211,80],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[3,6,57,34],[3,6,57,34],[3,6,57,34],[3,6,57,34],[7,4,34,36],[7,4,34,36],[1,1,39,39],[1,10,40,30],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[0,0,57,40],[1,1,57,39],[1,1,57,39],[0,2,57,38],[0,2,57,38],[0,2,57,38],[3,1,59,39],[3,1,59,39],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[3,1,57,39],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,1,39,39],[3,1,57,39],[3,1,57,39],[3,1,57,39],[8,11,32,29],[3,1,57,39],[2,3,40,34],[0,0,120,160],[0,0,360,160],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[1,2,39,38],[3,3,37,37],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[3,6,57,34],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[5,5,35,35],[6,5,34,34],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,3,40,37],[1,3,39,37],[1,1,39,39],[4,11,37,34],[3,11,37,34],[4,11,37,34],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[3,6,37,34],[3,6,37,34],[3,6,37,34],[3,6,37,34],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[3,3,37,37],[1,1,39,39],[1,1,39,39],[5,4,35,36],[8,4,32,36],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,5,39,35],[1,0,39,40],[1,5,39,33],[1,0,39,40],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[5,5,35,35],[5,6,34,34],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[1,1,39,39],[4,4,36,36],[1,1,39,39],[1,1,39,39],[1,1,39,39],[4,5,36,35],[5,6,57,35],[5,6,57,30],[1,1,39,39],[1,1,39,39],[4,4,233,38],[5,3,107,36],[5,3,107,36],[0,0,20,20],[0,0,20,20],[2,0,58,20],[2,0,58,20],[6,16,14,24],[3,3,39,40],[3,3,37,37],[0,5,38,35],[0,5,38,35],[0,5,38,35],[1,5,39,35],[1,5,49,35],[5,7,35,33],[1,5,39,35],[1,5,39,35],[1,5,39,35],[1,5,49,35],[1,5,39,35],[3,2,37,39],[1,5,39,35],[1,5,39,35],[1,5,79,35],[1,5,39,35],[3,3,39,37],[3,3,37,37],[3,3,37,37],[3,3,39,37],[3,3,39,37],[7,3,33,37],[3,3,37,37],[3,3,37,37],[3,3,37,37],[3,3,37,37],[3,3,37,37],[3,3,37,37],[2,2,38,38],[3,3,37,35],[3,3,37,37],[3,3,37,37],[3,3,37,37],[5,3,35,37],[5,5,39,35],[2,5,35,35],[5,3,40,35],[5,5,38,35],[5,5,40,37],[3,3,39,40],[1,5,49,35],[2,2,111,33],[2,2,111,33],[2,10,89,33],[2,10,89,33],[2,10,105,38],[2,10,105,38],[1,10,88,33],[1,10,88,33],[2,10,128,38],[2,10,128,38],[2,9,121,33],[2,9,121,33],[2,8,141,38],[2,8,141,38],[1,10,110,38],[1,10,110,38],[2,9,114,33],[2,9,114,33],[5,3,106,36],[5,3,106,36],[2,3,103,36],[2,3,103,36],[1,10,170,33],[1,10,170,33],[2,10,89,33],[2,10,89,33],[2,7,154,38],[2,7,154,38],[2,8,138,38],[2,8,138,38],[4,3,142,37],[4,3,142,37],[2,8,119,38],[2,8,119,38],[1,10,124,33],[1,10,124,33],[0,3,60,34],[0,3,60,34],[2,3,142,37],[2,3,142,37],[2,8,104,38],[2,8,104,38],[0,0,68,68],[1,1,67,67],[0,2,480,58],[0,2,480,58],[0,2,480,58],[7,10,35,30],[6,6,34,34],[1,1,39,39],[1,1,39,39],[9,1,31,39],[3,8,37,33],[3,8,37,33],[1,6,39,34],[1,4,40,34],[1,6,39,34],[1,6,39,34],[1,2,39,38],[3,2,39,34],[3,3,37,37],[0,2,280,58],[0,2,280,58],[0,2,280,58],[0,2,280,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[0,2,400,58],[4,4,36,36],[3,4,17,56],[0,0,200,240],[0,5,40,35],[0,0,340,160],[0,2,40,38],[0,2,20,18],[5,4,135,38],[3,4,7,16],[0,0,680,400],[5,11,15,29],[0,0,10,10],[0,0,10,10],[0,0,10,10],[0,0,10,10],[0,0,30,30],[0,0,30,30],[1,1,39,39],[3,2,57,38],[3,3,37,37],[3,3,37,37],[9,5,31,36],[8,8,52,52],[8,8,52,52],[8,8,52,52],[8,8,52,52],[8,8,52,52],[8,8,52,52],[8,8,52,52],[8,8,52,52],[9,3,31,37],[3,2,57,38],[3,2,57,38],[7,1,53,19],[0,0,140,160],[0,0,30,30],[0,0,30,30],[0,0,30,30],[0,0,30,30],[0,0,30,30],[0,0,30,30],[0,0,30,30],[0,0,30,30],[0,0,30,30],[2,15,69,45],[0,4,80,56],[1,5,39,35],[1,5,39,35],[0,8,40,32],[2,3,38,36],[0,0,20,10],[9,9,52,31],[2,0,40,40],[4,4,35,35],[2,10,38,30],[2,5,38,35],[2,6,38,36],[2,8,38,32],[2,8,38,32],[0,7,40,33],[9,8,32,33],[2,8,38,32],[10,8,30,33],[2,8,39,33],[9,1,30,19],[9,1,34,19],[9,1,33,19],[7,2,53,38],[7,2,53,38],[4,4,36,36],[1,17,29,22],[3,7,37,33],[0,5,40,35],[0,0,40,40],[6,2,54,38],[4,4,36,36],[2,4,38,36],[0,0,340,160],[0,0,340,160],[0,0,340,160],[1,5,39,36],[4,4,36,36],[2,8,38,32],[2,7,36,33],[4,5,35,35],[4,0,16,160],[0,0,30,20],[0,2,30,18],[0,3,30,17],[6,2,25,18],[3,7,35,33]];
export function installUiSkinTop(patch:Patch,assets:Record<string,SkinAsset & {ink?:readonly number[]}>,options:{catalogAddress:number;catalogCapacity:number;inkTableAddress?:number}):UiSkinTopReport {
 const symbols:Record<string,number>={},regions:UiSkinTopReport['regions']=[];
 // Only native status-role consumers and installed GRMod ratio/recipe IDs are bounded here.
 // Native View::OnUpdateOverLap asserts when a child frame exceeds its parent even if its
 // absolute clip is already intersected. Source height53 at center24 produces localY=-2.
 const topSafeSources:readonly(readonly number[])[]=[
  [164,173,671,672,673,674],[500,541],[412,417,418],[467,468,469,470],[336,337,339,205,206],
  [38,87,355,356,357,358,359,360,361,362,363,364],Array.from({length:14},(_,i)=>213+i),[],
  [19,29,30,32,33,34,35,36,37,58,231,377,381,382,383,384,385,386,387,601,...Array.from({length:12},(_,i)=>768+i),...Array.from({length:8},(_,i)=>782+i)],
  [597,598,600],[157,158],[178,648],[155,180,181,182,183,621,483],
  [334,335,432,433,434,435],[116],[],[595,596,599],[258,259,260,261,262,263,264,265,266,669]
 ];
 for(const[slot,ids]of topSafeSources.entries()){
  const dy=D.viewfinder.top.itemOffsets[slot].y,c1=D.viewfinder.top.rowCenterY+dy,c2=D.viewfinder.top.secondRowCenterY+dy,maxHeight=2*Math.min(c1,c2,480-c1,480-c2);
  for(const id of ids){
   const name=`icon-${id}-light`,a=assets[name];if(!a)continue;
   if(a.width>160||a.height>maxHeight)throw new Error(`uiSkin LiveView ${name} ${a.width}x${a.height} exceeds role${slot} safe frame160x${maxHeight}; adjust source dimensions or that role's vertical center`);
  }
 }

 // Extra ratio consumers may use a different top role; use all18 centers conservatively.
 const ratioMaxHeight=2*Math.min(...D.viewfinder.top.itemOffsets.flatMap(q=>{
  const c1=D.viewfinder.top.rowCenterY+q.y,c2=D.viewfinder.top.secondRowCenterY+q.y;return[c1,c2,480-c1,480-c2];
 }));
 for(let id=723;id<=730;id++){
  const name=`icon-${id}-light`,a=assets[name];if(a&&(a.width>160||a.height>ratioMaxHeight))throw new Error(`uiSkin LiveView ${name} ${a.width}x${a.height} exceeds extra-ratio safe frame160x${ratioMaxHeight}`);
 }
 const addr=(r:string,n:number)=>`movw ${r},#${n&65535};movt ${r},#${n>>>16}`;
 const emit=(name:string,text:string)=>{const at=patch.append(a=>assembleWords(text,a),16);symbols[name]=at;regions.push({name,address:at,length:assembleWords(text,at).length*4,purpose:'LiveView status layout only'});return at;};
 let ink=options.inkTableAddress;
 if(ink===undefined){
  const table:number[]=[];
  for(let id=0;id<options.catalogCapacity;id++){
   const ptr=patch.word(options.catalogAddress+id*4);let w=0,h=0,left=0,right=0;
   if(ptr){const d=new DataView(patch.read(ptr,12).buffer);w=d.getUint16(2,true);h=d.getUint16(4,true);left=NATIVE_INK[id]?.[0]??0;right=NATIVE_INK[id]?.[2]??w;}
   const a=assets[`icon-${id}-light`];if(a){w=a.width;h=a.height;left=a.ink?.[0]??0;right=a.ink?.[2]??w;}
   table.push(left,Math.max(0,right-left),w,h);
  }
  ink=patch.append(u32le(table),16);regions.push({name:'top_ink_table',address:ink,length:table.length*4,purpose:'Original ink facts overridden by exact new resource metadata'});
 }
 symbols.top_ink_table=ink;symbols.top_ink_count=options.catalogCapacity;
 const order=patch.append(u32le([2,3,4,5,11,6,7,8,9,10,12,13,14,15,40,16,17,34]),4);symbols.top_order=order;
 // Row record = {view, inkLeft, inkWidth, frameWidth, frameHeight, nativeViewIndex}.
 // Scratch is per invocation on stack. No allocation, shared mutable state, or controller fields are added.
 const external=emit('top_external_restore',`
   push {r4,r5,r6,r7,r8,r9,r10,lr};sub sp,sp,#16;mov r4,r0;mov r8,r1
   ${addr('r5',adr(0x53dbf9bc))};add r5,r5,r8,lsl #8;add r5,r5,r8,lsl #7
   ${addr('r9',order)};mov r10,#0
   extloop:ldr r6,[r9,r10,lsl #2];add r0,r4,r6,lsl #2;ldr r7,[r0,#0x15c];cmp r7,#0;beq extnext
    cmp r6,#8;beq extfont;cmp r6,#16;bne extposition
    extfont:mov r0,r7;cmp r6,#8;moveq r1,#20;movne r1,#32;mov r2,r1;bl #${adrHex(0x53590458)}
    mov r0,r7;mov r1,#1;bl #${adrHex(0x5359043c)}
    mov r0,r7;cmp r6,#8;moveq r1,#1;movne r1,#2;bl #${adrHex(0x53590590)}
    extposition:add r3,r5,r6,lsl #3;ldr r0,[r3];ldr r1,[r3,#4];str r0,[sp];str r1,[sp,#4]
    mov r2,#40;mov r3,#40
    cmp r6,#9;bne ext_native_size
    ldrh r0,[r7,#0xea];movw ip,#${options.catalogCapacity};cmp r0,ip;bhs ext_native_size
    ${addr('ip',ink)};add ip,ip,r0,lsl #4;ldr ip,[ip,#8];cmp ip,#80;movhi ip,#80;cmp ip,#0;movgt r2,ip
    ext_native_size:cmp r6,#8;moveq r2,#80;moveq r3,#20
    cmp r6,#15;moveq r2,#60;cmp r6,#34;moveq r2,#60;cmp r6,#40;moveq r2,#30;cmp r6,#16;bne extrect
    mov r2,#80;tst r8,#1;movne r2,#130
    extrect:str r2,[sp,#8];str r3,[sp,#12];mov r0,r7;mov r1,sp;ldr r3,[r7];ldr r3,[r3,#0x18];mov lr,pc;bx r3
    extnext:add r10,r10,#1;cmp r10,#18;blo extloop
   extdone:add sp,sp,#16;pop {r4,r5,r6,r7,r8,r9,r10,pc}
 `);

 const itemOffsets=patch.append(u32le(D.viewfinder.top.itemOffsets.flatMap(q=>[q.x,q.y])),4);symbols.top_item_offsets=itemOffsets;
 const place=emit('top_place_item',`
  push {r4,r5,r8,lr};ldr r8,[r7];ldr r5,[r7,#8];cmp r8,#0;beq end;cmp r5,#0;ble end
  add r4,sp,#448;ldr r1,[r7,#4];sub r1,r9,r1;str r1,[r4]
  ldr r3,[r7,#16];mov r2,r3,asr #1;ldr r0,[r7,#20];tst r0,#65536;rsbeq r2,r2,#${D.viewfinder.top.rowCenterY};rsbne r2,r2,#${D.viewfinder.top.secondRowCenterY};str r2,[r4,#4]
  ldr r2,[r7,#12];str r2,[r4,#8];str r3,[r4,#12]
  ${addr('ip',itemOffsets)};add ip,ip,r6,lsl #3;ldr r0,[ip];ldr r1,[r4];add r1,r1,r0;str r1,[r4];ldr r0,[ip,#4];ldr r1,[r4,#4];add r1,r1,r0;str r1,[r4,#4];ldr r1,[r4]
  ldr r0,[r8,#0x20];cmp r0,r1;bne set;ldr r0,[r8,#0x24];ldr r1,[r4,#4];cmp r0,r1;bne set;ldr r0,[r8,#0x28];cmp r0,r2;bne set;ldr r0,[r8,#0x2c];cmp r0,r3;beq next
  set:mov r0,r8;mov r1,r4;ldr r3,[r8];ldr r3,[r3,#0x18];mov lr,pc;bx r3
  next:add r9,r9,r5;add r9,r9,r10
  end:pop {r4,r5,r8,pc}
 `);
 const priority=patch.append(u32le([7,10,1,0,2,11,12,3,4,16]),4);symbols.top_overflow_priority=priority;
 const prepare=emit('top_prepare',`
   push {r4,r5,r6,r7,r8,r9,r10,lr};sub sp,sp,#512;mov r4,r0
   ldrb r1,[r4,#0x2d4];cmp r1,#1;bls local;cmp r1,#3;bhi done;mov r0,r4;bl #${external};b done;local:
   mov r0,#0;str r0,[sp,#456];str r0,[sp,#460];str r0,[sp,#464];str r0,[sp,#468];str r0,[sp,#480];str r0,[sp,#484];str r0,[sp,#488];str r0,[sp,#492]
   ${addr('r5',order)};mov r6,#0;mov r7,sp
   collect:
     ldr r9,[r5,r6,lsl #2];add r0,r4,r9,lsl #2;ldr r8,[r0,#0x15c]
     mov r0,#0;str r0,[r7];str r0,[r7,#8];str r9,[r7,#20]
     cmp r8,#0;beq collected;cmp r9,#40;bne regular_visible;ldrb r0,[r4,#0x2d4];cmp r0,#1;bne collected;b visible_ok;regular_visible:ldrb r0,[r8,#0x9e];cmp r0,#0;beq collected;visible_ok:
     str r8,[r7];cmp r9,#8;beq text;cmp r9,#16;beq text
     ldrh r0,[r8,#0xea];movw r1,#${options.catalogCapacity};cmp r0,r1;bhs unknown
     ${addr('r1',ink)};add r1,r1,r0,lsl #4;mov ip,r1;ldr r0,[ip];ldr r1,[ip,#4];ldr r2,[ip,#8];ldr r3,[ip,#12]
     cmp r2,#160;bhi oversize;cmp r3,#80;bls icon_size_ok
     oversize:mov r0,#0;cmp r1,#160;movhi r1,#160;cmp r2,#160;movhi r2,#160;cmp r3,#40;movhi r3,#40
     icon_size_ok:str r0,[r7,#4];str r1,[r7,#8];str r2,[r7,#12];str r3,[r7,#16];b measured
     unknown:mov r0,#0;str r0,[r7,#4];ldr r2,[r8,#0x28];cmp r2,#720;movhi r2,#720;str r2,[r7,#8];str r2,[r7,#12];ldr r3,[r8,#0x2c];str r3,[r7,#16];b measured
     text:
       mov r0,r8;mov r1,#${D.viewfinder.top.fontSize};mov r2,r1;bl #${adrHex(0x53590458)}
       mov r0,r8;mov r1,#0;bl #${adrHex(0x5359043c)}
       mov r0,r8;cmp r9,#16;moveq r1,#${D.viewfinder.top.counterColorIndex};movne r1,#${D.viewfinder.top.colorIndex};bl #${adrHex(0x53590414)}
       mov r0,r8;mov r1,#0;bl #${adrHex(0x53590590)}
       mov r0,r8;mov r1,#1;bl #${adrHex(0x535905a4)}
       add r0,sp,#448;mov r1,r8;bl #${adrHex(0x535907b0)}
       ldr r0,[sp,#448];cmp r0,#0;movlt r0,#0
       cmp r9,#8;moveq r1,#${D.viewfinder.top.wbTextMaxWidth};movne r1,#${D.viewfinder.top.counterTextMaxWidth};cmp r0,r1;movgt r0,r1
       mov r1,#0;str r1,[r7,#4];str r0,[r7,#8];str r0,[r7,#12];mov r1,#40;str r1,[r7,#16]
     measured:
       ldr r0,[r7,#8];cmp r0,#0;beq collected
       cmp r6,#10;addlo r1,sp,#456;addhs r1,sp,#460;ldr r2,[r1];add r2,r2,r0;str r2,[r1]
       cmp r6,#10;addlo r1,sp,#464;addhs r1,sp,#468;ldr r2,[r1];add r2,r2,#1;str r2,[r1]
     collected:add r7,r7,#24;add r6,r6,#1;cmp r6,#18;blo collect
   ldr r0,[sp,#456];ldr r1,[sp,#460];add r0,r0,r1;ldr r1,[sp,#464];ldr r2,[sp,#468];add r1,r1,r2
   cmp r1,#0;beq done;sub r1,r1,#1;mov r10,#${D.viewfinder.top.gap};mul r2,r1,r10;add r2,r2,r0;movw r3,#${D.viewfinder.top.usableWidth};cmp r2,r3;movhi r10,#${D.viewfinder.top.minGap}
   mul r2,r1,r10;add r2,r2,r0;cmp r2,r3;ble place
   mov r6,#0
   overflow:
    ${addr('r0',priority)};ldr r5,[r0,r6,lsl #2];mov r0,#24;mul r7,r0,r5;add r7,sp,r7
    ldr r0,[r7,#8];cmp r0,#0;ble overflow_next
    cmp r5,#10;addlo r8,sp,#480;addhs r8,sp,#484;addlo r9,sp,#488;addhs r9,sp,#492
    ldr r1,[r8];add r1,r1,r0;ldr r2,[r9];mov r3,#${D.viewfinder.top.minGap};mul r3,r2,r3;add r3,r3,r1;cmp r3,#${D.viewfinder.top.secondaryWidth};bhi overflow_next
    str r1,[r8];add r2,r2,#1;str r2,[r9]
    ldr r1,[r7,#20];orr r1,r1,#65536;str r1,[r7,#20]
    cmp r5,#10;addlo r8,sp,#456;addhs r8,sp,#460;addlo r9,sp,#464;addhs r9,sp,#468
    ldr r1,[r8];sub r1,r1,r0;str r1,[r8];ldr r1,[r9];sub r1,r1,#1;str r1,[r9]
    ldr r0,[sp,#456];ldr r1,[sp,#460];add r0,r0,r1;ldr r1,[sp,#464];ldr r2,[sp,#468];add r1,r1,r2
    cmp r1,#0;beq place;sub r1,r1,#1;mov r10,#${D.viewfinder.top.gap};mul r2,r1,r10;add r2,r2,r0;movw r3,#${D.viewfinder.top.usableWidth};cmp r2,r3;movhi r10,#${D.viewfinder.top.minGap}
    mul r2,r1,r10;add r2,r2,r0;cmp r2,r3;ble place
    overflow_next:add r6,r6,#1;cmp r6,#10;blo overflow
   place:
   mov r6,#0;mov r7,sp;mov r9,#${D.viewfinder.top.marginX}
   left:cmp r6,#10;bhs right_start;ldr r0,[r7,#20];tst r0,#65536;bne left_next;bl #${place}
   left_next:add r7,r7,#24;add r6,r6,#1;b left
   right_start:ldr r0,[sp,#460];ldr r1,[sp,#468];cmp r1,#0;beq secondary_left;sub r1,r1,#1;mul r1,r10,r1;add r0,r0,r1;movw r9,#${D.viewfinder.top.right};sub r9,r9,r0
   mov r6,#10
   right:cmp r6,#18;bhs secondary_left;ldr r0,[r7,#20];tst r0,#65536;bne right_next;bl #${place}
   right_next:add r7,r7,#24;add r6,r6,#1;b right
   secondary_left:
   ldr r0,[sp,#480];ldr r1,[sp,#488];cmp r1,#0;beq secondary_right
   sub r1,r1,#1;mov r10,#${D.viewfinder.top.gap};mul r2,r1,r10;add r2,r2,r0;cmp r2,#${D.viewfinder.top.secondaryWidth};movhi r10,#${D.viewfinder.top.minGap}
   mov r6,#0;mov r7,sp;mov r9,#${D.viewfinder.top.marginX}
   second_left_loop:cmp r6,#10;bhs secondary_right;ldr r0,[r7,#20];tst r0,#65536;beq second_left_next;bl #${place}
   second_left_next:add r7,r7,#24;add r6,r6,#1;b second_left_loop
   secondary_right:
   ldr r0,[sp,#484];ldr r1,[sp,#492];cmp r1,#0;beq done
   sub r1,r1,#1;mov r10,#${D.viewfinder.top.gap};mul r2,r1,r10;add r2,r2,r0;cmp r2,#${D.viewfinder.top.secondaryWidth};movhi r10,#${D.viewfinder.top.minGap}
   mul r1,r10,r1;add r0,r0,r1;movw r9,#${D.viewfinder.top.right};sub r9,r9,r0
   mov r6,#10;add r7,sp,#240
   second_right_loop:cmp r6,#18;bhs done;ldr r0,[r7,#20];tst r0,#65536;beq second_right_next;bl #${place}
   second_right_next:add r7,r7,#24;add r6,r6,#1;b second_right_loop
   done:add sp,sp,#512;pop {r4,r5,r6,r7,r8,r9,r10,pc}
 `);
 // Patch internal helper labels via separately emitted functions before assembling actual prepare.
 return {prepare,symbols,regions,fallbacks:['External layouts2/3 keep native positions/font; only view9 uses its actual new source width within the native80px slot.','Only an overflowing substate moves selected low-priority items to a second row centered66 in left18..260/right460..702 lanes; each lane uses uniform16 or11 gaps, keeping the levelB arc zone free.','Core AF/WB/IC/metering, format/count/battery and all native visibility/text are retained; unexpected outlier text frames have bounded108/140px clips.']};
}
