// SPDX-License-Identifier: GPL-2.0-only
/** GR IV 1.20 bottom strip; all state belongs to existing LiveView instances. */
import {UI_SKIN_DESIGN as D,designAsset} from './design';
import {checkedUiVtable} from './vtable';
import { Patch, u32le, expectWord } from '../build';

import {assembleVisualWords as assembleWords} from './visual-arm';
import type { SkinAsset } from './runtime';
import {adr,adrHex} from '../../target';

export interface UiSkinBottomReport {
  prepare: number;
  drawBackdrop: number;
  bind: number;
  symbols: Record<string, number>;
  regions: {name:string;address:number;length:number;purpose:string}[];
  fallbacks: string[];
}
export function installUiSkinBottom(patch:Patch,assets:Record<string,SkinAsset>,options:{yellowPalette:number;catalogAddress:number;catalogCapacity:number;inkTableAddress:number}):UiSkinBottomReport {
  const symbols:Record<string,number>={bottom_ink_table:options.inkTableAddress,bottom_ink_count:options.catalogCapacity},regions:UiSkinBottomReport['regions']=[];
  const addr=(r:string,n:number)=>`movw ${r},#${n&65535}; movt ${r},#${n>>>16}`;
  const emit=(name:string,src:string):number=>{const at=patch.append(a=>assembleWords(src,a),16);symbols[name]=at;regions.push({name,address:at,length:assembleWords(src,at).length*4,purpose:'LiveView-only bottom drawing/layout'});return at;};
  const clone=(name:string,native:number):number=>{const at=patch.append(checkedUiVtable(patch,native),16)+8;symbols[name]=at;regions.push({name,address:at-8,length:0x108,purpose:'Exact instance clone with negative RTTI slots retained'});return at;};
  const asset=(name:string):number=>{const a=assets[designAsset(name)];if(!a)throw new Error(`uiSkin bottom missing ${name}`);const at=patch.append(u32le([a.id,a.width,a.height]),4);symbols['asset_'+name]=at;return at;};
  const A=Object.fromEntries(['vf-capsule-left','vf-capsule-mid','vf-capsule-right','vf-mode-circle'].map(n=>[n,asset(n)]));
  if(assets[designAsset('vf-capsule-left')].width!==23 || assets[designAsset('vf-capsule-right')].width!==23 || assets[designAsset('vf-capsule-mid')].width!==1 || assets[designAsset('vf-capsule-left')].height!==46 || assets[designAsset('vf-capsule-mid')].height!==46 || assets[designAsset('vf-capsule-right')].height!==46 || assets[designAsset('vf-mode-circle')].width!==34 || assets[designAsset('vf-mode-circle')].height!==34)throw new Error('uiSkin bottom resource dimensions');
  for(const [vt,draw]of [[adr(0x53ece550),adr(0x53593418)],[adr(0x53ece4e0),adr(0x5359332c)],[adr(0x53ecec40),adr(0x5359a3fc)],[adr(0x53ecf988),adr(0x535a5e1c)],[adr(0x53ece200),adr(0x53590c40)]])expectWord(patch,vt+0x4c,draw);
  const notify=clone('bottom_notification_vtable',adr(0x53ece550));
  const group=clone('bottom_group_vtable',adr(0x53ece4e0));
  const mode=clone('bottom_mode_vtable',adr(0x53ecec40));
  const hist=clone('bottom_histogram_vtable',adr(0x53ecf988));
  const ev=clone('bottom_ev_vtable',adr(0x53ece200));
  // Only known mode glyphs get a white circle. An unknown future mode keeps its own light icon.
  const modePairs=[39,677,678,680,681].flatMap(n=>{const a=assets[`icon-${n}-dark`];return a?[n,a.id]:[];});modePairs.push(0,0);
  const mt=patch.append(u32le(modePairs),16);symbols.bottom_mode_map=mt;
  const lookup=emit('bottom_mode_dark_id',`
    ${addr('r1',mt)}
    scan: ldr r2,[r1],#8; cmp r2,#0; beq no; cmp r2,r0; bne scan
    ldr r0,[r1,#-4]; bx lr
    no: mov r0,#0; bx lr
  `);
  // r0=root. Return1 only when the exact tagged native notification is currently visible.
  // The root direct-child vector has fewer than94 entries; no stored controller pointer is needed.
  const blocked=emit('bottom_notification_visible',`
    cmp r0,#0; moveq r0,#0; bxeq lr
    push {r4,r5,r6,lr}; ldr r1,[r0,#0xc]; ldr r2,[r0,#0x10]
    sub r3,r2,r1; cmp r3,#376; bhi no; tst r3,#3; bne no
    ${addr('r5',notify)}
    scan: cmp r1,r2; bhs no; ldr r4,[r1],#4; cmp r4,#0; beq scan
    ldr r6,[r4]; cmp r6,r5; bne scan
    ldrb r0,[r4,#0x9e]; cmp r0,#0; movne r0,#1; pop {r4,r5,r6,pc}
    no: mov r0,#0; pop {r4,r5,r6,pc}
  `);
  // Use the native empty-list path to clear draw/old-rect state without drawing descendants.
  const empty=emit('bottom_empty_group_draw',`
    push {r4,r5,r6,lr}; mov r4,r0; ldr r5,[r0,#0x10]; ldr r6,[r0,#0xc]; str r6,[r0,#0x10]
    bl #${adrHex(0x535ab380)}; str r5,[r4,#0x10]; pop {r4,r5,r6,pc}
  `);
  const gd=emit('bottom_group_draw',`
    push {r4,r5,r6,lr}; mov r4,r0; mov r5,r1; ldr r0,[r0,#4]; bl #${blocked}
    cmp r0,#0; mov r0,r4; mov r1,r5; pop {r4,r5,r6,lr}; bne #${empty}; b #${adrHex(0x5359332c)}
  `);patch.setWord(group+0x4c,gd,'uiSkinLiveView bottom: notification yields this group only');
  const md=emit('bottom_mode_draw',`
    push {r4,r5,r6,r7,r8,lr}; mov r4,r0; mov r5,r1
    ldr r0,[r0,#4]; bl #${blocked}; cmp r0,#0; bne hidden
    ldrh r6,[r4,#0xea]; mov r0,r6; bl #${lookup}; cmp r0,#0; beq native
    strh r0,[r4,#0xea]; mov r0,r4; mov r1,r5; bl #${adrHex(0x5359a3fc)}; strh r6,[r4,#0xea]; pop {r4,r5,r6,r7,r8,pc}
    native: mov r0,r4; mov r1,r5; pop {r4,r5,r6,r7,r8,lr}; b #${adrHex(0x5359a3fc)}
    hidden: mov r0,r4; mov r1,r5; pop {r4,r5,r6,r7,r8,lr}; b #${empty}
  `);patch.setWord(mode+0x4c,md,'uiSkinLiveView bottom: native mode icon temporary dark mapping');
  const hd=emit('bottom_histogram_draw',`b #${empty}`);patch.setWord(hist+0x4c,hd,'uiSkinLiveView: omit this histogram instance in every display mode');
  // AsciiView stores its UTF16 buffer at+f0. Require exact EV prefix and bounded valid decimal.
  // Zero, flash(|...), alternative time and ruler paths retain their native foreground/outline.
  const nonzero=emit('bottom_ev_nonzero',`
    ldr r1,[r0,#0xf0]; cmp r1,#0; beq no
    ldrh r2,[r1]; cmp r2,#69; bne no; ldrh r2,[r1,#2]; cmp r2,#86; bne no
    add r1,r1,#4; mov r2,#12; mov r3,#0; mov ip,#0
    scan: ldrh r0,[r1],#2; cmp r0,#0; beq end
    cmp r0,#48; blo punctuation; cmp r0,#57; bhi punctuation
    mov ip,#1; cmp r0,#48; movne r3,#1; b next
    punctuation: cmp r0,#43; beq next; cmp r0,#45; beq next; cmp r0,#46; beq next; cmp r0,#32; beq next; cmp r0,#177; bne no
    next: subs r2,r2,#1; bne scan
    no: mov r0,#0; bx lr
    end: and r0,r3,ip; bx lr
  `);
  const ed=emit('bottom_ev_draw',`
    push {r4,r5,r6,lr}; mov r4,r0; mov r5,r1; bl #${nonzero}; cmp r0,#0; beq native
    ldrb r6,[r4,#0xea]; mov r0,#${options.yellowPalette}; strb r0,[r4,#0xea]
    mov r0,r4; mov r1,r5; bl #${adrHex(0x53590c40)}; strb r6,[r4,#0xea]; pop {r4,r5,r6,pc}
    native: mov r0,r4; mov r1,r5; pop {r4,r5,r6,lr}; b #${adrHex(0x53590c40)}
  `);patch.setWord(ev+0x4c,ed,'uiSkinLiveView bottom: nonzero EV foreground only; native secondary outline retained');
  // Group-local parts retain the original view/meaning/order. Only their frames are compacted.
  const partLists=[[49,50],[51,52],[53,54,55],[56,57,58,59,60,61]];
  const parts=patch.append(u32le(partLists.flatMap(xs=>[...xs,...Array(7-xs.length).fill(0)])),4);symbols.bottom_parts=parts;
  const groups=patch.append(u32le([27,30,31,32,33]),4);symbols.bottom_group_order=groups;
  const setRect=emit('bottom_set_rect',`ldr r3,[r0]; ldr r3,[r3,#0x18]; bx r3`);
  // r0=iconID -> r0=inkLeft,r1=inkWidth,r2=sourceW,r3=sourceH.
  const iconInk=emit('bottom_icon_ink',`
    movw r1,#${options.catalogCapacity}; cmp r0,r1; bhs no
    ${addr('r1',options.inkTableAddress)}; add r1,r1,r0,lsl #4; mov ip,r1; ldr r0,[ip]; ldr r1,[ip,#4]; ldr r2,[ip,#8]; ldr r3,[ip,#12]; bx lr
    no: mov r0,#0; mov r1,#0; mov r2,#0; mov r3,#0; bx lr
  `);
  // r0=controller,r1=group index -> {r0=visible ink span,r1=min local inkX}.
  // No mutation: it also measures the native scale/pointer overlay without flattening its semantics.
  const union=emit('bottom_group_ink_union',`
    push {r4,r5,r6,r7,r8,r9,r10,lr}; mov r4,r0; mov r5,r1
    sub r1,r1,#30; mov r2,#28; mul r1,r2,r1; ${addr('r6',parts)}; add r6,r6,r1
    movw r9,#32767; mov r10,#0
    loop: ldr r7,[r6],#4; cmp r7,#0; beq done
    add r0,r4,r7,lsl #2; ldr r8,[r0,#0x15c]; ldrb r0,[r8,#0x9e]; cmp r0,#0; beq loop
    ${[50,52,55,57,59].map(n=>`cmp r7,#${n}; beq text`).join(';')}
    ldrh r0,[r8,#0xea]; bl #${iconInk}; cmp r1,#0; ble loop; b bound
    text: mov r0,#0; ldr r1,[r8,#0x28]; cmp r1,#0; ble loop
    bound: ldr r2,[r8,#0x20]; add r0,r0,r2; add r1,r1,r0
    cmp r0,r9; movlt r9,r0; cmp r1,r10; movgt r10,r1; b loop
    done: movw r0,#32767; cmp r9,r0; beq empty
    sub r0,r10,r9; cmp r0,#0; ble empty; mov r1,r9; pop {r4,r5,r6,r7,r8,r9,r10,pc}
    empty: mov r0,#0; mov r1,#0; pop {r4,r5,r6,r7,r8,r9,r10,pc}
  `);
  // r0=controller,r1=group index,r2=native text size. Return the compacted ink span/offset.
  // Native source-frame padding is preserved so baked shadows are not clipped at the strong ink edge.
  const pack=emit('bottom_pack_group',`
    push {r4,r5,r6,r7,r8,r9,r10,lr}; sub sp,sp,#64
    mov r4,r0; mov r5,r1; mov r9,r2; add r0,r4,r5,lsl #2; ldr r10,[r0,#0x15c]
    ldrb r0,[r10,#0x9e]; cmp r0,#0; beq invisible
    cmp r5,#33; bne normal
    ldr r0,[r4,#0x24c]; ldrb r0,[r0,#0x9e]; ldr r1,[r4,#0x250]; ldrb r1,[r1,#0x9e]; orr r0,r0,r1; cmp r0,#0; bne ruler
    normal:
    sub r0,r5,#30; mov r1,#28; mul r0,r1,r0; ${addr('r6',parts)}; add r6,r6,r0
    mov r7,#0; mov r0,#0; str r0,[sp,#16]; str r0,[sp,#20]
    loop: ldr r0,[r6],#4; cmp r0,#0; beq finish
    str r0,[sp,#24]; add r1,r4,r0,lsl #2; ldr r8,[r1,#0x15c]
    ldrb r1,[r8,#0x9e]; cmp r1,#0; beq loop
    ${[50,52,55,57,59].map(n=>`cmp r0,#${n}; beq text`).join(';')}
    ldrh r0,[r8,#0xea]; bl #${iconInk}; cmp r1,#0; ble loop
    str r0,[sp,#28]; str r1,[sp,#32]; str r2,[sp,#36]; str r3,[sp,#40]
    ldr r1,[sp,#16]; cmp r1,#0; moveq r7,r0
    sub r0,r7,r0; str r0,[sp]; mov r0,r3,asr #1; rsb r0,r0,#${D.viewfinder.bottom.partCenterY}; str r0,[sp,#4]
    str r2,[sp,#8]; str r3,[sp,#12]; b place
    text:
    mov r0,r8; mov r1,r9; mov r2,r9; bl #${adrHex(0x53590458)}
    mov r0,r8; mov r1,#0; bl #${adrHex(0x53590590)}; mov r0,r8; mov r1,#1; bl #${adrHex(0x535905a4)}
    add r0,sp,#48; mov r1,r8; bl #${adrHex(0x535907b0)}; ldr r1,[sp,#48]; cmp r1,#0; ble loop
    cmp r1,#${D.viewfinder.bottom.textMaxWidth}; movgt r1,#${D.viewfinder.bottom.textMaxWidth}; str r1,[sp,#32]; str r1,[sp,#36]
    mov r0,#0; str r0,[sp,#28]; str r0,[sp,#4]; str r7,[sp]; str r1,[sp,#8]
    mov r0,#${D.viewfinder.bottom.groupHeight}; str r0,[sp,#40]; str r0,[sp,#12]
    place:
    mov r0,r8; mov r1,sp; bl #${setRect}
    ldr r0,[sp]; ldr r1,[sp,#36]; add r0,r0,r1; ldr r1,[sp,#20]; cmp r0,r1; strgt r0,[sp,#20]
    ldr r0,[sp,#32]; add r7,r7,r0; add r7,r7,#${D.viewfinder.bottom.innerGap}
    ldr r0,[sp,#16]; add r0,r0,#1; str r0,[sp,#16]; b loop
    finish:
    ldr r0,[r10,#0x20]; str r0,[sp]; movw r0,#${D.viewfinder.bottom.groupY}; str r0,[sp,#4]
    ldr r0,[sp,#20]; str r0,[sp,#8]; mov r0,#${D.viewfinder.bottom.groupHeight}; str r0,[sp,#12]
    mov r0,r10; mov r1,sp; bl #${setRect}; mov r0,r4; mov r1,r5; bl #${union}; b done
    ruler:
    ldr r0,[r10,#0x20]; str r0,[sp]; movw r0,#${D.viewfinder.bottom.groupY}; str r0,[sp,#4]; mov r0,#150; str r0,[sp,#8]; mov r0,#${D.viewfinder.bottom.groupHeight}; str r0,[sp,#12]
    mov r0,r10; mov r1,sp; bl #${setRect}; mov r0,r4; mov r1,r5; bl #${union}; b done
    invisible: mov r0,#0; mov r1,#0
    done: add sp,sp,#64; pop {r4,r5,r6,r7,r8,r9,r10,pc}
  `);
  const prepare=emit('bottom_prepare',`
    push {r4,r5,r6,r7,r8,r9,r10,lr}; sub sp,sp,#128; mov r4,r0; ldrb r5,[r4,#0x2d4]
    ldr r0,[r4,#0x1f0]; ${addr('r1',hist)}; str r1,[r0]
    ldr r0,[r4,#0x218]; ${addr('r1',notify)}; str r1,[r0]
    cmp r5,#1; bhi external
    ldr r0,[r4,#0x1c8]; ${addr('r1',mode)}; str r1,[r0]
    ${[30,31,32,33].map(n=>`ldr r0,[r4,#${0x15c+n*4}]; ${addr('r1',group)}; str r1,[r0]`).join(';')}
    ldr r0,[r4,#0x240]; ${addr('r1',ev)}; str r1,[r0]
    mov r10,#${D.viewfinder.bottom.fontMax}
    collect: mov r8,#0; mov r9,#0; mov r6,#0; mov r7,sp
    row: ${addr('r0',groups)}; ldr r5,[r0,r6,lsl #2]; add r0,r4,r5,lsl #2; ldr r0,[r0,#0x15c]; str r0,[r7]
    cmp r5,#27; bne regular
    ldrb r1,[r0,#0x9e]; cmp r1,#0; moveq r0,#0; moveq r1,#0; beq measured
    ldrh r0,[r0,#0xea]; bl #${lookup}; cmp r0,#0; moveq r0,#40; moveq r1,#0; movne r0,#34; movne r1,#3; b measured
    regular: mov r0,r4; mov r1,r5; mov r2,r10; bl #${pack}
    measured: str r0,[r7,#4]; str r1,[r7,#8]; cmp r0,#0; addgt r8,r8,r0; addgt r9,r9,#1
    add r7,r7,#12; add r6,r6,#1; cmp r6,#5; blo row
    cmp r9,#0; beq aux
    sub r0,r9,#1; mov r1,#${D.viewfinder.bottom.groupGap}; mul r0,r1,r0; add r8,r8,r0
    movw r0,#${720-D.viewfinder.bottom.extraWidth}; cmp r8,r0; ble fits; cmp r10,#${D.viewfinder.bottom.fontMin}; ble fits; sub r10,r10,#${D.viewfinder.bottom.fontStep}; cmp r10,#${D.viewfinder.bottom.fontMin}; movlt r10,#${D.viewfinder.bottom.fontMin}; b collect
    fits: add r0,r8,#${D.viewfinder.bottom.extraWidth}; movw r1,#720; sub r1,r1,r0; mov r1,r1,asr #1; add r9,r1,#${D.viewfinder.bottom.paddingX}
    mov r6,#0; mov r7,sp
    place: ldr r8,[r7]; ldr r0,[r7,#4]; cmp r0,#0; ble next
    ldr r1,[r7,#8]; sub r1,r9,r1; str r1,[sp,#84]; movw r1,#${D.viewfinder.bottom.groupY}; str r1,[sp,#88]
    ldr r1,[r8,#0x28]; str r1,[sp,#92]; ldr r1,[r8,#0x2c]; str r1,[sp,#96]
    mov r0,r8; add r1,sp,#84; bl #${setRect}
    ldr r0,[r7,#4]; add r9,r9,r0; add r9,r9,#${D.viewfinder.bottom.groupGap}
    next: add r7,r7,#12; add r6,r6,#1; cmp r6,#5; blo place
    aux:
    ldrb r5,[r4,#0x2d4]; cmp r5,#0; bne movie_aux
    ldr r0,[r4,#0x1c8]; ldr r0,[r0,#0x20]; add r6,r0,#${D.viewfinder.bottom.auxAnchorOffset}
    ldr r0,[r4,#0x1cc]; sub r1,r6,#${D.viewfinder.bottom.auxFirstOffset}; cmp r1,#0; movlt r1,#0; bl #${adrHex(0x535abf2c)}
    ldr r0,[r4,#0x1cc]; movw r1,#${D.viewfinder.bottom.auxFirstY}; bl #${adrHex(0x535abfa8)}
    ldr r0,[r4,#0x1d0]; sub r1,r6,#${D.viewfinder.bottom.auxSecondOffset}; cmp r1,#0; movlt r1,#0; bl #${adrHex(0x535abf2c)}
    ldr r0,[r4,#0x1d0]; movw r1,#${D.viewfinder.bottom.auxSecondY}; bl #${adrHex(0x535abfa8)}; b guide
    movie_aux: ${[28,29].map(n=>`ldr r0,[r4,#${0x15c+n*4}]; mov r1,#0; bl #${adrHex(0x535abf2c)}; ldr r0,[r4,#${0x15c+n*4}]; mov r1,#0; bl #${adrHex(0x535abfa8)}`).join(';')}
    guide: ldr r0,[r4,#0x1f4]; movw r1,#${D.viewfinder.bottom.guideY}; bl #${adrHex(0x535abfa8)}; b done
    external:
    cmp r5,#3; bhi done
    ldr r0,[r4,#0x1c8]; ${addr('r1',adr(0x53ecec40))}; str r1,[r0]
    ldr r0,[r4,#0x240]; ${addr('r1',adr(0x53ece200))}; str r1,[r0]
    ${[[27,40],[28,60],[29,40],[30,160],[31,120],[32,180],[33,150],[38,500]].map(([n,w])=>`
      ldr r8,[r4,#${0x15c+n*4}]; ${n>=30&&n<=33?`${addr('r1',adr(0x53ece4e0))}; str r1,[r8]`:''}
      add r2,r5,r5,lsl #1; mov r2,r2,lsl #7; ${addr('r3',adr(0x53dbf9bc)+n*8)}; add r3,r3,r2
      ldr r0,[r3]; str r0,[sp,#84]; ldr r0,[r3,#4]; str r0,[sp,#88]; movw r0,#${w}; str r0,[sp,#92]; mov r0,#${n===28||n===29?20:40}; str r0,[sp,#96]
      mov r0,r8; add r1,sp,#84; bl #${setRect}
    `).join(';')}
    ${[[49,0,40],[50,40,120],[51,0,40],[52,40,80],[53,0,40],[54,40,40],[55,80,100],[56,0,40],[57,40,110],[58,0,40],[59,40,110]].map(([n,x,w])=>`
      ldr r8,[r4,#${0x15c+n*4}]; mov r0,#${x}; str r0,[sp,#84]; mov r0,#0; str r0,[sp,#88]; mov r0,#${w}; str r0,[sp,#92]; mov r0,#40; str r0,[sp,#96]
      mov r0,r8; add r1,sp,#84; bl #${setRect}
      ${[50,52,55,57,59].includes(n)?`mov r0,r8; mov r1,#32; mov r2,#32; bl #${adrHex(0x53590458)};`:''}
    `).join(';')}
    done: add sp,sp,#128; pop {r4,r5,r6,r7,r8,r9,r10,pc}
  `);
  // Native bitmap-request ABI. Source bytes remain unscaled; each destination is root-clipped.
  const draw=emit('bottom_draw_asset',`
    push {r4,r5,r6,r7,r8,lr}; sub sp,sp,#48
    mov r4,r0; mov r5,r1; mov r6,r2; mov r7,r3; ldr r8,[sp,#72]
    str r4,[sp]; str r5,[sp,#4]; str r6,[sp,#8]
    ldr r0,[r7,#4]; str r0,[sp,#12]; add r0,r5,r0
    ldr r1,[r7,#8]; str r1,[sp,#16]; add r1,r6,r1
    ldr r2,[r8]; cmp r5,r2; movlt r5,r2; str r5,[sp,#20]
    ldr r2,[r8,#4]; cmp r6,r2; movlt r6,r2; str r6,[sp,#24]
    ldr r2,[r8]; ldr r3,[r8,#8]; add r2,r2,r3; cmp r0,r2; movgt r0,r2
    ldr r2,[r8,#4]; ldr r3,[r8,#12]; add r2,r2,r3; cmp r1,r2; movgt r1,r2
    sub r0,r0,r5; sub r1,r1,r6; cmp r0,#0; ble done; cmp r1,#0; ble done
    str r0,[sp,#28]; str r1,[sp,#32]; ldr r0,[r7]; str r0,[sp,#36]; mov r0,#0; str r0,[sp,#40]
    bl #${adrHex(0x5323d7f0)}; bl #${adrHex(0x5323da14)}; mov r1,sp; bl #${adrHex(0x53240038)}
    done: add sp,sp,#48; pop {r4,r5,r6,r7,r8,pc}
  `);
  // flat dark capsules behind the two top status groups, drawn in the same
  // root pre-draw as the bottom bar so native icons land on top. Extents come from the item rects that
  // top_prepare has already placed; second-row overflow items (y>=44) and hidden items are ignored.
  // Reuses the 36px hint capsule (31x66 pieces, body y10..46, x pad 12) centred on the top row.
  const T=Object.fromEntries(['wheel05-hint-glass-left','wheel05-hint-glass-mid','wheel05-hint-glass-right'].map(n=>[n,asset(n)]));
  for(const [n,w] of [['wheel05-hint-glass-left',31],['wheel05-hint-glass-mid',1],['wheel05-hint-glass-right',31]] as const){const a=assets[designAsset(n)];if(a.width!==w||a.height!==66)throw new Error('uiSkin top capsule resource dimensions');}
  const TOP_PAD=3,TOP_Y=D.viewfinder.top.rowCenterY-18-10;
  if(TOP_Y>=0||TOP_Y<-10)throw new Error('uiSkin top capsule: rowCenterY must keep the 36px capsule on screen');
  const topGroupRow=(ids:number[])=>[...ids,...Array(16-ids.length).fill(0)];
  const topGroups=patch.append(u32le([...topGroupRow([2,3,4,5,11,6,7,8,9,10]),...topGroupRow([12,13,14,15,40,16,17,34])]),16);symbols.top_backdrop_groups=topGroups;
  const backdrop=emit('bottom_draw_backdrop',`
    push {r4,r5,r6,r7,r8,r9,r10,lr}; sub sp,sp,#32
    mov r4,r0; mov r5,r1; ldrb r2,[r4,#0x2d4]; cmp r2,#1; bhi done
    ldr r6,[r4,#0x15c]; ldrb r2,[r6,#0x9e]; cmp r2,#0; beq done
    mov r0,r6; bl #${blocked}; cmp r0,#0; bne done
    add r0,r6,#0x64; str r0,[sp]; mov r10,#0
    tgroup: movw r8,#32767; mov r9,#0; mov r7,#0
    tscan: ${addr('r0',topGroups)}; add r0,r0,r10,lsl #6; ldr r1,[r0,r7,lsl #2]; cmp r1,#0; beq tmeasured
    add r0,r4,r1,lsl #2; ldr r0,[r0,#0x15c]; cmp r0,#0; beq tnext
    ldrb r1,[r0,#0x9e]; cmp r1,#0; beq tnext
    ldr r1,[r0,#0x24]; cmp r1,#44; bge tnext
    ldr r2,[r0,#0x28]; cmp r2,#0; ble tnext
    ldr r1,[r0,#0x20]; add r2,r2,r1; cmp r1,r8; movlt r8,r1; cmp r2,r9; movgt r9,r2
    tnext: add r7,r7,#1; cmp r7,#15; blo tscan
    tmeasured: movw r0,#32767; cmp r8,r0; beq tgroup_next
    sub r8,r8,#${TOP_PAD+12}; sub r9,r9,#${19-TOP_PAD}; add r0,r8,#31; cmp r9,r0; movlt r9,r0
    mov r0,r5; mov r1,r8; mvn r2,#${-TOP_Y-1}; ${addr('r3',T['wheel05-hint-glass-left'])}; bl #${draw}
    add r7,r8,#31
    tmid: cmp r7,r9; bhs tright
    mov r0,r5; mov r1,r7; mvn r2,#${-TOP_Y-1}; ${addr('r3',T['wheel05-hint-glass-mid'])}; bl #${draw}; add r7,r7,#1; b tmid
    tright: mov r0,r5; mov r1,r9; mvn r2,#${-TOP_Y-1}; ${addr('r3',T['wheel05-hint-glass-right'])}; bl #${draw}
    tgroup_next: add r10,r10,#1; cmp r10,#2; blo tgroup
    movw r8,#32767; mov r9,#0; mov r7,#0
    scan: ${addr('r0',groups)}; ldr r10,[r0,r7,lsl #2]; add r0,r4,r10,lsl #2; ldr r0,[r0,#0x15c]; str r0,[sp,#4]
    ldrb r1,[r0,#0x9e]; cmp r1,#0; beq next
    cmp r10,#27; bne regular
    ldrh r0,[r0,#0xea]; bl #${lookup}; cmp r0,#0; movne r0,#34; movne r1,#3; bne measured
    ldr r0,[sp,#4]; ldr r0,[r0,#0x28]; mov r1,#0; b measured
    regular: mov r0,r4; mov r1,r10; bl #${union}
    measured: cmp r0,#0; ble next; ldr r2,[sp,#4]; ldr r2,[r2,#0x20]; add r1,r1,r2; add r0,r0,r1
    cmp r1,r8; movlt r8,r1; cmp r0,r9; movgt r9,r0
    next: add r7,r7,#1; cmp r7,#5; blo scan
    movw r0,#32767; cmp r8,r0; beq done
    sub r7,r9,r8; add r7,r7,#${D.viewfinder.bottom.extraWidth}; sub r8,r8,#${D.viewfinder.bottom.paddingX}
    cmp r7,#46; movlt r7,#46
    add r6,r6,#0x64; str r6,[sp]
    mov r0,r5; mov r1,r8; movw r2,#${D.viewfinder.bottom.backdropY}; ${addr('r3',A['vf-capsule-left'])}; bl #${draw}
    add r9,r8,#23; add r10,r8,r7; sub r10,r10,#23
    middle: cmp r9,r10; bhs right
    mov r0,r5; mov r1,r9; movw r2,#${D.viewfinder.bottom.backdropY}; ${addr('r3',A['vf-capsule-mid'])}; bl #${draw}; add r9,r9,#1; b middle
    right: mov r0,r5; mov r1,r10; movw r2,#${D.viewfinder.bottom.backdropY}; ${addr('r3',A['vf-capsule-right'])}; bl #${draw}
    ldr r8,[r4,#0x1c8]; ldrb r0,[r8,#0x9e]; cmp r0,#0; beq done
    ldrh r0,[r8,#0xea]; bl #${lookup}; cmp r0,#0; beq done
    ldr r1,[r8,#0x20]; add r1,r1,#3; mov r0,r5; movw r2,#${D.viewfinder.bottom.modeCircleY}; ${addr('r3',A['vf-mode-circle'])}; bl #${draw}
    done: add sp,sp,#32; pop {r4,r5,r6,r7,r8,r9,r10,pc}
  `);
  const bind=emit('bottom_bind',`
    push {r4,r5,r6,lr}; mov r4,r0
    ldr r0,[r4,#0x218]; ${addr('r1',notify)}; str r1,[r0]
    ldr r0,[r4,#0x1f0]; ${addr('r1',hist)}; str r1,[r0]
    pop {r4,r5,r6,pc}
  `);
  return {prepare,drawBackdrop:backdrop,bind,symbols,regions,fallbacks:[
    'The exact physical front-dial ownership is still not bound; redesigned native control glyphs remain with their own native value group.',
    'External layouts2/3 retain native group/part positions and32px value fonts; this histogram instance remains disabled.',
    'A native ruler/pointer state is measured as one ink union and repositioned as a group, preserving its internal pointer position and semantics.',
    'Only a width-overflow LCD state reduces regular native value-font requests from32 toward16; all visible parts,22px group gaps and exact source icons remain.',
    'Unexpected future mode glyphs omit only their white circle. Bounded unexpected outlier text frames are capped at240px; native legal formats are verified separately.'
  ]};
}
