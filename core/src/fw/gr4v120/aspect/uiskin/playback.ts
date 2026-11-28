// SPDX-License-Identifier: GPL-2.0-only
/** Playback positions only. DISP visibility and metadata callbacks remain native. */
import {UI_SKIN_DESIGN as D} from './design';
import {checkedUiVtable} from './vtable';
import {Patch,expectWord,u32le} from '../build';
import {branchWord} from '../arm';
import {assembleVisualWords as assembleWords} from './visual-arm';
import {installUiSkinPrivateFrame} from './privateframe';
import type {SkinCatalogOptions} from './resources';
import {adr,adrHex} from '../../target';
export interface UiSkinPlaybackReport {hooks:{site:number;target:number;expected:number;reason:string}[];symbols:Record<string,number>;regions:{name:string;address:number;length:number;purpose:string}[];fallbacks:string[]}
export let UI_SKIN_LAST_PLAYBACK_REPORT:UiSkinPlaybackReport|null=null;
export function installUiSkinPlayback(patch:Patch,options:SkinCatalogOptions):UiSkinPlaybackReport{
 const report:UiSkinPlaybackReport={hooks:[],symbols:{},regions:[],fallbacks:['Native Standard/Detailed/No Information DISP controls visibility; no information is forced on.','Movie seek/time footer retains native geometry, using the same24px regular footer text, when seek view18 is visible.','No verified rating-star consumer exists in the native112 views; no synthetic rating is drawn.']};
 const addr=(r:string,n:number)=>`movw ${r},#${n&65535};movt ${r},#${n>>>16}`;
 const emit=(name:string,s:string)=>{s=s.replace(/^\s*\/\/.*$/gm,'');const at=patch.append(a=>assembleWords(s,a),16);report.symbols[name]=at;report.regions.push({name,address:at,length:assembleWords(s,at).length*4,purpose:'PlaybackSingleController instance only'});return at;};
 const clone=(name:string,native:number)=>{const a=patch.append(checkedUiVtable(patch,native),16)+8;report.symbols[name]=a;report.regions.push({name,address:a-8,length:0x108,purpose:'Native RTTI/vtable clone; instance tag'});return a;};
 const topText=clone('playback_top_text_vtable',adr(0x53ece200));
 const root=clone('playback_root_vtable',adr(0x53ece290)),controller=clone('playback_controller_vtable',adr(0x53dc17a8)),line=clone('playback_line_vtable',adr(0x53ece550));
 const layers=patch.append(u32le(D.playback.top.shadow.flatMap(s=>[s.dx,s.dy])),4);
 const topTextDraw=emit('playback_top_text_draw',`push {r4,r5,r6,r7,r8,r9,r10,lr}; sub sp,sp,#288; mov r4,r0; mov r5,r1; mov r6,#0; ${addr('r7',layers)}
 layer: mov r0,r4; mov r1,sp; mov r8,#68; copy: ldr r2,[r0],#4; str r2,[r1],#4; subs r8,r8,#1; bne copy
 ${addr('r0',adr(0x53ece200))}; str r0,[sp]; mov r0,#0; str r0,[sp,#4]; str r0,[sp,#12]; str r0,[sp,#16]
 ldr r0,[sp,#0x30]; ldr r1,[r7]; add r0,r0,r1; str r0,[sp,#0x30]; ldr r0,[sp,#0x34]; ldr r1,[r7,#4]; add r0,r0,r1; str r0,[sp,#0x34]
 ldr r0,[r4,#4]; cmp r0,#0; beq clip_done; add r0,r0,#0x64; add r1,sp,#0x64; ldr r8,[r0]; ldr r9,[r0,#4]; ldr r10,[r0,#8]; ldr ip,[r0,#12]; str r8,[r1]; str r9,[r1,#4]; str r10,[r1,#8]; str ip,[r1,#12]
 clip_done: add r0,r6,#249; strb r0,[sp,#0xea]; strb r0,[sp,#0xeb]; mov r0,sp; mov r1,r5; bl #${adrHex(0x53590c40)}; add r7,r7,#8; add r6,r6,#1; cmp r6,#2; blo layer
 add sp,sp,#288; mov r0,r4; mov r1,r5; bl #${adrHex(0x53590c40)}; pop {r4,r5,r6,r7,r8,r9,r10,pc}`);
 patch.setWord(topText+0x4c,topTextDraw,'uiSkin playback date/count two configurable shadows');
 const nodraw=emit('playback_line_draw',`b #${adrHex(0x535ab380)}`);patch.setWord(line+0x4c,nodraw,'uiSkin playback private separators omitted');
 const order=patch.append(u32le([2,3,4,5,6,7,8,9,12,11,13,14,15,16,17]),4);report.symbols.playback_order=order;
 // 15 records {view,inkLeft,inkWidth,frameWidth,frameHeight,index}; stack+360 rect;
 // totals/counts: top-left368,top-right372/376,bottom380/384; width388,height392.
 const place=emit('playback_place',`
  push {r4,r5,r8,lr};ldr r8,[r7];ldr r5,[r7,#8];cmp r8,#0;beq end;cmp r5,#0;ble end
  add r4,sp,#376;ldr r0,[r7,#4];sub r0,r9,r0;str r0,[r4]
  ldr r3,[r7,#16];mov r0,r3,asr #1;sub r0,r11,r0;str r0,[r4,#4]
  ldr r2,[r7,#12];str r2,[r4,#8];str r3,[r4,#12]
  mov r0,r8;mov r1,r4;ldr r3,[r8];ldr r3,[r3,#0x18];mov lr,pc;bx r3
  add r9,r9,r5;mov r0,r10;ldr r1,[r7,#20];cmp r1,#15;bne gap;ldr r1,[r7,#32];cmp r1,#0;movne r0,#${D.playback.bottom.isoGap};gap:add r9,r9,r0
  end:pop {r4,r5,r8,pc}
 `);
 const movieRestore=emit('playback_movie_footer_restore',`push {r4,r5,r6,lr};sub sp,sp,#16;mov r4,r0;mov r5,#9;${addr('r6',order)}
 restore_loop:ldr r2,[r6,r5,lsl #2];add r0,r4,r2,lsl #2;ldr r0,[r0,#0x15c];cmp r0,#0;beq restore_next
 mov r3,#24;mul r2,r3,r2;${addr('r1',adr(0x53dc0c80))};add r1,r1,r2;ldr r2,[r1,#4];str r2,[sp];ldr r2,[r1,#8];str r2,[sp,#4];ldr r2,[r1,#12];str r2,[sp,#8];ldr r2,[r1,#16];str r2,[sp,#12];mov r1,sp;ldr r3,[r0];ldr r3,[r3,#0x18];mov lr,pc;bx r3
 restore_next:add r5,r5,#1;cmp r5,#15;blo restore_loop;add sp,sp,#16;pop {r4,r5,r6,pc}`);
 const prepare=emit('playback_prepare',`
  push {r4,r5,r6,r7,r8,r9,r10,r11,r12,lr};sub sp,sp,#416;mov r4,r0
  ldr r0,[r4,#0x15c];cmp r0,#0;beq done;ldr r1,[r0,#0x28];str r1,[sp,#404];ldr r1,[r0,#0x2c];str r1,[sp,#408]
  mov r0,#0;str r0,[sp,#384];str r0,[sp,#388];str r0,[sp,#392];str r0,[sp,#396];str r0,[sp,#400]
  ${addr('r5',order)};mov r6,#0;mov r7,sp
  collect:ldr r9,[r5,r6,lsl #2];add r0,r4,r9,lsl #2;ldr r8,[r0,#0x15c];mov r0,#0;str r0,[r7];str r0,[r7,#8];str r9,[r7,#20]
   cmp r8,#0;beq next;ldrb r0,[r8,#0x9e];cmp r0,#0;beq next;str r8,[r7]
   cmp r9,#2;beq text;cmp r9,#8;beq text;cmp r9,#11;beq text;cmp r9,#13;beq text;cmp r9,#14;beq text;cmp r9,#16;beq text;cmp r9,#17;beq text
   ldrh r0,[r8,#0xea];${addr('r1',options.catalogCapacity)};cmp r0,r1;bhs unknown
   ${addr('r1',options.inkTableAddress)};add ip,r1,r0,lsl #4;ldr r0,[ip];ldr r1,[ip,#4];ldr r2,[ip,#8];ldr r3,[ip,#12];cmp r2,#0;beq unknown
   str r0,[r7,#4];str r1,[r7,#8];str r2,[r7,#12];str r3,[r7,#16];b measured
   unknown:mov r0,#0;str r0,[r7,#4];ldr r0,[r8,#0x28];str r0,[r7,#8];str r0,[r7,#12];ldr r0,[r8,#0x2c];str r0,[r7,#16];b measured
   text:cmp r6,#9;movlo r1,#${D.playback.top.fontSize};movhs r1,#${D.playback.bottom.fontSize};mov r2,r1;mov r0,r8;bl #${adrHex(0x53590458)}
    mov r0,r8;mov r1,#0;bl #${adrHex(0x5359043c)};mov r0,r8;cmp r6,#9;movlo r1,#251;movhs r1,#252;bl #${adrHex(0x53590414)}
    mov r0,r8;mov r1,#0;bl #${adrHex(0x53590590)};mov r0,r8;mov r1,#1;bl #${adrHex(0x535905a4)}
    add r0,sp,#360;mov r1,r8;bl #${adrHex(0x535907b0)};ldr r0,[sp,#360];cmp r0,#0;movlt r0,#0
    str r0,[r7,#8];str r0,[r7,#12];mov r0,#0;str r0,[r7,#4];mov r0,#40;str r0,[r7,#16]
   measured:ldr r0,[r7,#8];cmp r0,#0;beq next;cmp r6,#0;streq r0,[sp,#384];beq next
    cmp r6,#9;addlo r1,sp,#388;addhs r1,sp,#396;ldr r2,[r1];add r2,r2,r0;str r2,[r1];ldr r2,[r1,#4];add r2,r2,#1;str r2,[r1,#4]
   next:add r7,r7,#24;add r6,r6,#1;cmp r6,#15;blo collect
  // Top: actual date left18; right statuses right18, common16/11 gap.
  mov r10,#${D.playback.top.gap};ldr r0,[sp,#384];ldr r1,[sp,#388];add r0,r0,r1;ldr r1,[sp,#392];mul r2,r1,r10;add r2,r2,r0;ldr r3,[sp,#404];sub r3,r3,#${2*D.playback.top.marginX};cmp r2,r3;movhi r10,#${D.playback.top.minGap}
  movw r9,#${D.playback.top.marginX};movw r11,#${D.playback.top.centerY};mov r7,sp;bl #${place}
  ldr r0,[sp,#388];ldr r1,[sp,#392];cmp r1,#0;beq bottom;sub r1,r1,#1;mul r1,r10,r1;add r0,r0,r1;ldr r9,[sp,#404];sub r9,r9,#${D.playback.top.marginX};sub r9,r9,r0
  add r7,sp,#24;mov r6,#1;toploop:bl #${place};add r7,r7,#24;add r6,r6,#1;cmp r6,#9;blo toploop
  bottom:ldr r0,[r4,#0x1a4];cmp r0,#0;beq photo;ldrb r0,[r0,#0x9e];cmp r0,#0;beq photo;mov r0,r4;bl #${movieRestore};b done
  photo:ldr r0,[sp,#396];ldr r1,[sp,#400];cmp r1,#0;beq done;sub r1,r1,#1;mov r10,#${D.playback.bottom.gap};mul r1,r10,r1;add r0,r0,r1
   // ISO icon+number is one group with an internal6px gap.
   ldr r1,[sp,#296];cmp r1,#0;beq total;ldr r1,[sp,#320];cmp r1,#0;subne r0,r0,#${D.playback.bottom.gap-D.playback.bottom.isoGap}
   total:ldr r9,[sp,#404];sub r9,r9,r0;mov r9,r9,asr #1;ldr r11,[sp,#408];sub r11,r11,#${D.playback.bottom.marginBottom};add r7,sp,#216;mov r6,#9
   botloop:bl #${place};add r7,r7,#24;add r6,r6,#1;cmp r6,#15;blo botloop
  done:add sp,sp,#416;pop {r4,r5,r6,r7,r8,r9,r10,r11,r12,pc}
 `);
 const frame=installUiSkinPrivateFrame(patch,{[root]:adr(0x5359332c)},{forceFullRootVtables:[root],beforeCanvasFrame:prepare});
 Object.assign(report.symbols,frame.symbols);report.regions.push(...frame.regions);patch.setWord(controller+0x30,frame.controllerFrame,'uiSkin playback private native frame loop');
 const bind=emit('playback_bind',`
  push {r0,r1,r2,r3,ip,lr};mrs ip,cpsr;push {ip,lr};mov r0,r4
  ${addr('r1',controller)};str r1,[r0];ldr r1,[r0,#0x15c];${addr('r2',root)};str r2,[r1]
  ${[2,8].map(i=>`ldr r1,[r0,#${0x15c+i*4}];${addr('r2',topText)};str r2,[r1]`).join(';')}
  ${[10,21].map(i=>`ldr r1,[r0,#${0x15c+i*4}];${addr('r2',line)};str r2,[r1]`).join(';')}
  // WLAN banner retains its native background so white notification text is readable.
  ldr r1,[r0,#0x310];${addr('r2',adr(0x53ece550))};str r2,[r1]
  pop {ip,lr};msr cpsr_f,ip;pop {r0,r1,r2,r3,ip,lr};mov r0,r4;b #${adrHex(0x531913cc)}
 `);
 const site=adr(0x531913c8),expected=0xe1a00004;expectWord(patch,site,expected);patch.setWord(site,branchWord(site,bind),'uiSkin playback ctor instance bind');report.hooks.push({site,target:bind,expected,reason:'Playback ctor after native BindViews and guide setup'});
 UI_SKIN_LAST_PLAYBACK_REPORT=report;return report;
}
