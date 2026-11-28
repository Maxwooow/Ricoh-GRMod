// SPDX-License-Identifier: GPL-2.0-only
/** Instance-scoped GR IV 1.20 skin. Pixels are registered verbatim by install.ts. */
import {UI_SKIN_DESIGN as D,rgbaWord,designAsset} from './design';
import {checkedUiVtable} from './vtable';
import { Patch, expectWord, u32le } from '../build';
import {branchWord} from '../arm';
import {assembleVisualWords as assembleWords} from './visual-arm';
import { installUiSkinPrivateFrame } from './privateframe';
import {installUiSkinDirect} from './direct';
import { installUiSkinWheel } from './wheel';
import type {UiSkinWheelOptions} from './wheel';
import {adr,adrHex,byRelease} from '../../target';
/** The two factory instructions the palette hooks displace and replay: their immediates are table addresses that moved in
 * 1.21 (factory palette 0x540781ec -> 0x540799dc, its first 52 words equal; factory glyph ramp 0x53de3aa4 -> 0x53de513c). */
const PALETTE_MOVW = byRelease({'1.20': 0xe30831ec, '1.21': 0xe30939dc}); // movw r3, #lo(factory palette)
const GLYPH_MOVW = byRelease({'1.20': 0xe3031aa4, '1.21': 0xe305113c});   // movw r1, #lo(factory glyph ramp)
const imm16 = (w: number) => ((w >>> 4) & 0xf000) | (w & 0xfff);
if (imm16(GLYPH_MOVW) !== (adr(0x53de3aa4) & 0xffff)) throw new Error('uiSkin glyph ramp instruction and address table disagree');
export interface SkinCatalogOptions extends UiSkinWheelOptions {}

export interface SkinAsset { id: number; width: number; height: number; ink?: readonly number[] }
export interface UiSkinRuntimeReport { hooks: { site: number; target: number; expected: number; reason: string }[]; symbols: Record<string, number>; fallbacks: string[]; regions?: {name:string; address:number; length:number; purpose:string}[] }
export let UI_SKIN_LAST_RUNTIME_REPORT: UiSkinRuntimeReport | null = null;

/** Private color aliases can be installed independently for a LiveView-only build. */
export function installUiSkinPalette(patch: Patch): UiSkinRuntimeReport {
  const report:UiSkinRuntimeReport={hooks:[],symbols:{},fallbacks:[]};
  const addr=(r:string,n:number)=>`movw ${r}, #${n&65535}; movt ${r}, #${n>>>16}`;
  const emit=(name:string,text:string):number=>{const at=patch.append(a=>assembleWords(text,a),16);report.symbols[name]=at;return at;};
  const hook=(site:number,target:number,original:number,reason:string,link=true):void=>{expectWord(patch,site,original);patch.setWord(site,branchWord(site,target,14,link),`uiSkin: ${reason}`);report.hooks.push({site,target,expected:original,reason});};
  // Only new skin fields carry these indices. All 48 factory palette entries are byte-identical.
  const colors = [...D.palette.colors.map(rgbaWord),...D.playback.top.shadow.map(l=>rgbaWord(l.color)),rgbaWord(D.playback.top.color),rgbaWord(D.playback.bottom.color)];
  const palette = patch.append(u32le(colors), 16); report.symbols.palette = palette;
  // factory palette 26/27 (#3CFF3C) is the live-view AF frame green. It now resolves to white. Only these two indices change; every other factory entry is untouched.
  const AF_FRAME = 0xffffffff;
  const paletteHook = emit('palette_lookup', `mrs ip,cpsr; cmp r0, #26; beq af_accent; cmp r0, #27; beq af_accent; cmp r0, #232; blo original; cmp r0, #${232+colors.length}; bhs original; sub r0, r0, #232; ${addr('r3',palette)}; ldr r0, [r3, r0, lsl #2]; msr cpsr_f,ip; bx lr; original: movw r3, #${imm16(PALETTE_MOVW)}; msr cpsr_f,ip; b #${adrHex(0x53926300)}; af_accent: ${addr('r0',AF_FRAME)}; msr cpsr_f,ip; bx lr`);
  hook(adr(0x539262fc),paletteHook,PALETTE_MOVW,'private palette aliases; factory indices unchanged',false);
  const factoryRamp = Array.from(new Uint32Array(patch.read(adr(0x53de3aa4),64).buffer));
  const rampWords: number[] = [];
  const CAPSULE = 168; // the glass capsules' alpha (#141416 at 66 %), which the white text ramp is pre-composited over
  colors.forEach((color,k) => {
    const target = [color & 255,(color >>> 8)&255,(color >>> 16)&255], alpha = color >>> 24;
    const bg = k===9 || k===10 ? D.palette.aaWhiteBackground : D.palette.aaDarkBackground;
    factoryRamp.forEach((word,j) => {
      if (!j) { rampWords.push(0); return; }
      const coverage=(word&255)/255;
      // glyphs are raw-copied, not blended. On the flat dark capsules (black, alpha CAPSULE)
      // an edge pixel with alpha below the capsule punches a see-through ring around every letter.
      // k=0 (232, white a75 text): pre-composite over the capsule, so alpha never drops below it.
      // k=4 (236, its outline/shadow): exactly the capsule colour, invisible on a capsule, a flat soft edge elsewhere.
      // 236, the outline the text helpers give 232 text, is 232's own ramp (no dark ring; the letters'
      // edge is the text itself). 8.11: 240 (white 60 %, the live-view remaining-shots count) pre-composited the same way.
      if(k===0||k===4||k===8){const ca=k===4?colors[0]>>>24:alpha,a=coverage*ca/255,c=CAPSULE/255,o=a+(1-a)*c;const v=Math.round(255*a/o);rampWords.push((v|(v<<8)|(v<<16)|(Math.round(o*255)<<24))>>>0);return;}
      if(k<8||k>=17){rampWords.push(((color&0xffffff)|(Math.round((word&255)*alpha/255)<<24))>>>0);return;}
      if(k===16){rampWords.push(((color&0xffffff)|((word&255)<<24))>>>0);return;}
      const rgb=target.map((v,c) => Math.round(bg[c]+(v-bg[c])*coverage));
      rampWords.push((rgb[0]|(rgb[1]<<8)|(rgb[2]<<16)|(alpha<<24))>>>0);
    });
  });
  const ramps = patch.append(u32le(rampWords),16); report.symbols.ramps = ramps;
  const aa = emit('glyph_palette_dispatch',`cmp r3, #232; blo original; cmp r3, #${232+colors.length}; bhs original; sub r3, r3, #232; ${addr('sl',ramps)}; add sl, sl, r3, lsl #6; b #${adrHex(0x5323e7c4)}; original: movw r1, #${imm16(GLYPH_MOVW)}; b #${adrHex(0x5323e7b0)}`);
  hook(adr(0x5323e7ac),aa,GLYPH_MOVW,'private glyph ramps; factory AA dispatch unchanged',false);

  return report;
}

export function installUiSkinRuntime(patch: Patch, assets: Record<string, SkinAsset>, options:SkinCatalogOptions={}): UiSkinRuntimeReport {
  const report: UiSkinRuntimeReport = { hooks: [], symbols: {}, fallbacks: [
    'White focus outer glow uses the native root clip; surface edges still clip.',
    'X3: retain native title; additional subtitle omitted',
    'X6: retain native text shadows; full raster/alpha shadow composition not established',
    'F2: hide text IDs On/Off only for TopMenu value StringViews paired with visible329/330; scoped switch remap preserves shared catalog and firmware-update UI',
  ] };
  const addr = (r: string, n: number) => `movw ${r}, #${n & 65535}; movt ${r}, #${n >>> 16}`;
  const emit = (name: string, text: string): number => {
    const at = patch.append(a => assembleWords(text, a), 16); report.symbols[name] = at; return at;
  };
  const hook = (site: number, target: number, original: number, reason: string, link = true): void => {
    expectWord(patch, site, original); patch.setWord(site, branchWord(site, target, 14, link), `uiSkin: ${reason}`);
    report.hooks.push({ site, target, expected: original, reason });
  };
  const asset = (name: string): number => {
    const a = assets[designAsset(name)]; if (!a) throw new Error(`uiSkin missing asset ${name}`);
    const at = patch.append(u32le([a.id, a.width, a.height]), 4); report.symbols[`asset_${name}`] = at; return at;
  };
  const A = Object.fromEntries(['menu-bg','menu-focus-row-inrow','menu-focus-row-glass','select-focus-row-inrow','select-focus-row-glass','adj-list-bg','ic-list-bg','adj-cell-focus-glass','select-message-panel','wheel-glass-left','wheel-glass-mid','wheel-glass-right','wheel-focus-left','wheel-focus-mid','wheel-focus-right','menu-focus-outer-glow','select-focus-outer-glow','scroll-thumb-top','scroll-thumb-mid','scroll-thumb-bottom','submenu-chevron-focus'].map(n => [n,asset(n)]));
  const clone = (name: string, native: number): number => {
    // Retain offset-to-top/RTTI and all the native virtual slots; clone identity is the scope tag.
    const at = patch.append(checkedUiVtable(patch,native), 16) + 8; report.symbols[name] = at; return at;
  };
  const sectionIcon=clone('menu_section_icon_vtable',adr(0x53ecec40));
  const topRoot = clone('top_root_vtable',adr(0x53ece290)), selectRoot = clone('select_root_vtable',adr(0x53ece290));
  const topList = clone('top_list_vtable',adr(0x53ece690)), selectList = clone('select_list_vtable',adr(0x53ece690));
  const adjList = clone('adj_list_vtable',adr(0x53ece690)), icList = clone('ic_list_vtable',adr(0x53ece690));
  const transparentLine = clone('transparent_line_vtable',adr(0x53ece550)), dividerLine = clone('divider_line_vtable',adr(0x53ece550));
  const selectMark = clone('select_mark_vtable',adr(0x53ecec40));
  const suppressedIcon=clone('suppressed_icon_vtable',adr(0x53ecec40)), switchIcon=clone('switch_icon_vtable',adr(0x53ecec40));
  const hideOnOff=clone('hide_onoff_string_vtable',adr(0x53ece708)), wheelMark=clone('wheel_mark_vtable',adr(0x53ecec40));
  const trailingIcon=clone('menu_trailing_chevron_vtable',adr(0x53ecec40));
  const darkIcon=clone('dark_value_icon_vtable',adr(0x53ecec40)), wheelIcon=clone('wheel_value_icon_vtable',adr(0x53ecec40));
  // the TopMenu / SubMenu value column's icons, the SubMenu list, its focus-row chevron, the scroll thumb.
  const valueIcon=clone('menu_value_icon_vtable',adr(0x53ecec40)), valueDark=clone('menu_value_dark_icon_vtable',adr(0x53ecec40));
  const submenuList=clone('submenu_list_vtable',adr(0x53ece690)), chevronFocus=clone('submenu_chevron_focus_vtable',adr(0x53ecec40)), thumbLine=clone('scroll_thumb_vtable',adr(0x53ece550));
  const adjCell = clone('adj_cell_vtable',adr(0x53ecec40)), pageIcon = clone('page_icon_vtable',adr(0x53ecec40)), messageIcon = clone('select_message_icon_vtable',adr(0x53ecec40));

  // Exact native-ID pairs. Light IDs may alias their original catalog slot.
  const variants=Object.entries(assets).flatMap(([name,a])=>{
    const m=/^icon-(\d+)-dark$/.exec(name);if(!m)return[];const old=Number(m[1]);
    const light=assets[`icon-${old}-menu-light`]??assets[`icon-${old}-light`];
    return light?[[old,light.id,a.id]]:[];
  }).sort((a,b)=>a[0]-b[0]);
  const variantTable=patch.append(u32le([...variants.flat(),0,0,0]),4);
  report.symbols.icon_variant_table=variantTable;report.symbols.icon_variant_count=variants.length;
  const variantLookup=emit('icon_variant_lookup',`
    ${addr('r2',variantTable)}
    loop: ldr r3,[r2]; cmp r3,#0; bxeq lr; cmp r3,r0; beq found; add r2,r2,#12; b loop
    found: cmp r1,#0; ldreq r0,[r2,#4]; ldrne r0,[r2,#8]; bx lr
  `);
  const valueIconDraw=(name:string,dark:boolean,lookupFn=variantLookup):number=>emit(name,`
    push {r4,r5,r6,lr}; mov r4,r0; mov r6,r1; ldrh r5,[r0,#0xea]
    mov r0,r5; mov r1,#${dark?1:0}; bl #${lookupFn}; mov r2,r0
    movw ip,#329; cmp r5,ip; movweq r2,#${assets[designAsset(dark?'switch-off-dark':'switch-off')].id}
    movw ip,#330; cmp r5,ip; movweq r2,#${assets[designAsset(dark?'switch-on-dark':'switch-on')].id}
    strh r2,[r4,#0xea]; mov r0,r4; mov r1,r6; bl #${adrHex(0x5359a3fc)}
    strh r5,[r4,#0xea]; pop {r4,r5,r6,pc}
  `);
  patch.setWord(darkIcon+0x4c,valueIconDraw('dark_value_icon_draw',true),'uiSkin: exact white-focus icon instance uses dark variant');
  // Value-column variants (icon-N-value: white 60 %, 21 px high; icon-N-value-dark: ink 65 % on the white focus block); an icon without
  // them keeps the menu-light / dark pair (variant table above).
  const valueRows=Object.entries(assets).flatMap(([name,a])=>{const m=/^icon-(\d+)-value$/.exec(name);if(!m)return[];const d=assets[`icon-${m[1]}-value-dark`];return d?[[Number(m[1]),a.id,d.id]]:[];}).sort((a,b)=>a[0]-b[0]);
  const valueTable=patch.append(u32le([...valueRows.flat(),0,0,0]),4);report.symbols.value_icon_table=valueTable;report.symbols.value_icon_count=valueRows.length;
  const valueLookup=emit('value_icon_lookup',`
    ${addr('r2',valueTable)}
    loop: ldr r3,[r2]; cmp r3,#0; beq fallback; cmp r3,r0; beq found; add r2,r2,#12; b loop
    found: cmp r1,#0; ldreq r0,[r2,#4]; ldrne r0,[r2,#8]; bx lr
    fallback: b #${variantLookup}
  `);
  patch.setWord(valueIcon+0x4c,valueIconDraw('menu_value_icon_draw',false,valueLookup),'uiSkin H: TopMenu / SubMenu value icon, white 60 %');
  patch.setWord(valueDark+0x4c,valueIconDraw('menu_value_dark_icon_draw',true,valueLookup),'uiSkin H: TopMenu / SubMenu value icon on the focus block, ink 65 %');
  const trailingDraw=emit('menu_trailing_chevron_draw',`push {r4,r5,r6,lr}; mov r4,r0; mov r6,r1; ldrh r5,[r0,#0xea]; movw r2,#${assets[designAsset('menu-trailing-chevron')].id}; strh r2,[r4,#0xea]; mov r0,r4; mov r1,r6; bl #${adrHex(0x5359a3fc)}; strh r5,[r4,#0xea]; pop {r4,r5,r6,pc}`);
  patch.setWord(trailingIcon+0x4c,trailingDraw,'uiSkin: only native TopMenuLine submenu indicator; no backing/shadow');
  const chevronDraw=emit('submenu_chevron_focus_draw',`push {r4,r5,r6,lr}; mov r4,r0; mov r6,r1; ldrh r5,[r0,#0xea]; movw r2,#${assets[designAsset('submenu-chevron-focus')].id}; strh r2,[r4,#0xea]; mov r0,r4; mov r1,r6; bl #${adrHex(0x5359a3fc)}; strh r5,[r4,#0xea]; pop {r4,r5,r6,pc}`);
  patch.setWord(chevronFocus+0x4c,chevronDraw,'uiSkin H: SubMenu focus-row chevron, ink 60 %');


  const paletteReport=installUiSkinPalette(patch);
  report.hooks.push(...paletteReport.hooks);Object.assign(report.symbols,paletteReport.symbols);

  // r0=surface, r1=x, r2=y, r3={iconId,width,height}, fifth arg=clip rectangle.
  // Native Rect stores x,y,width,height. Both full destination and clipped rectangle retain this format.
  const draw = emit('draw_asset', `
    push {r4,r5,r6,r7,r8,lr}; sub sp, sp, #48
    mov r4,r0; mov r5,r1; mov r6,r2; mov r7,r3; ldr r8,[sp,#72]
    str r4,[sp]; str r5,[sp,#4]; str r6,[sp,#8]
    ldr r0,[r7,#4]; str r0,[sp,#12]; add r0,r5,r0
    ldr r1,[r7,#8]; str r1,[sp,#16]; add r1,r6,r1
    ldr r2,[r8]; cmp r5,r2; movlt r5,r2; str r5,[sp,#20]
    ldr r2,[r8,#4]; cmp r6,r2; movlt r6,r2; str r6,[sp,#24]
    ldr r2,[r8]; ldr r3,[r8,#8]; add r2,r2,r3; cmp r0,r2; movgt r0,r2
    ldr r2,[r8,#4]; ldr r3,[r8,#12]; add r2,r2,r3; cmp r1,r2; movgt r1,r2
    sub r0,r0,r5; sub r1,r1,r6; cmp r0,#0; ble done; cmp r1,#0; ble done
    str r0,[sp,#28]; str r1,[sp,#32]
    ldr r0,[r7]; str r0,[sp,#36]; mov r0,#0; str r0,[sp,#40]
    bl #${adrHex(0x5323d7f0)}; bl #${adrHex(0x5323da14)}; mov r1,sp; bl #${adrHex(0x53240038)}
    done: add sp,sp,#48; pop {r4,r5,r6,r7,r8,pc}
  `);
  // the scroll bar keeps only its thumb (the camera's own geometry: its third LineView, 4 px wide), drawn as a
  // white 30 % bar with fully round ends: top cap, middle pieces clipped to the bar between the caps, bottom cap.
  const thumbDraw = emit('scroll_thumb_draw',`
    push {r4,r5,r6,r7,r8,r9,r10,lr}; sub sp,sp,#48; mov r4,r0; mov r5,r1
    ldrb r0,[r4,#0x9e]; cmp r0,#0; beq end
    ldr r6,[r4,#0x30]; ldr r7,[r4,#0x34]; ldr r8,[r4,#0x3c]; cmp r8,#4; blt end
    str r6,[sp,#8]; add r0,r7,#2; str r0,[sp,#12]; ldr r0,[r4,#0x38]; str r0,[sp,#16]; sub r0,r8,#4; str r0,[sp,#20]
    add r0,sp,#24; add r1,sp,#8; add r2,r4,#0x64; bl #${adrHex(0x539118dc)}; cmp r0,#0; beq caps
    add r9,r7,#2; add r10,r7,r8; sub r10,r10,#2
    mid: cmp r9,r10; bge caps; add r0,sp,#24; str r0,[sp]; mov r0,r5; mov r1,r6; mov r2,r9; ${addr('r3',A['scroll-thumb-mid'])}; bl #${draw}; add r9,r9,#64; b mid
    caps: add r0,r4,#0x64; str r0,[sp]; mov r0,r5; mov r1,r6; mov r2,r7; ${addr('r3',A['scroll-thumb-top'])}; bl #${draw}
    add r0,r4,#0x64; str r0,[sp]; mov r0,r5; mov r1,r6; add r2,r7,r8; sub r2,r2,#2; ${addr('r3',A['scroll-thumb-bottom'])}; bl #${draw}
    end: mov r0,r4; mov r1,r5; bl #${adrHex(0x535ab380)}; add sp,sp,#48; pop {r4,r5,r6,r7,r8,r9,r10,pc}
  `);
  patch.setWord(thumbLine+0x4c,thumbDraw,'uiSkin H: scroll thumb only');
  const noDraw = emit('transparent_line_draw',`b #${adrHex(0x535ab380)}`);
  patch.setWord(transparentLine+0x4c,noDraw,'uiSkin: line background omitted only on tagged instances');
  patch.setWord(suppressedIcon+0x4c,noDraw,'uiSkin F1: suppress TopMenu view4 yellow backing only');
  // the hairline is 1 px. LineView::Draw fills the view's clip (+0x64 x, y, w, h): a 2 px line is drawn as
  // its first row (the clip's height restored after the call).
  // A taller LineView given this class (SubMenu's info band behind its description) draws nothing, as a transparent line.
  const lineDraw = emit('divider_line_draw',`push {r4,r5,r6,lr}; mov r4,r0; mov r6,r1; ldr r5,[r4,#0x3c]; cmp r5,#2; bgt band; mov r2,#244; strb r2,[r4,#0xea]; ldr r5,[r4,#0x70]; cmp r5,#2; moveq r2,#1; streq r2,[r4,#0x70]; mov r0,r4; mov r1,r6; bl #${adrHex(0x53593418)}; str r5,[r4,#0x70]; pop {r4,r5,r6,pc}; band: mov r0,r4; mov r1,r6; bl #${adrHex(0x535ab380)}; pop {r4,r5,r6,pc}`);
  patch.setWord(dividerLine+0x4c,lineDraw,'uiSkin: scoped separator');
  const iconDraw = (name: string, descriptor: number): number => emit(name,`
    ldrb r2,[r0,#0x9e]; cmp r2,#0; beq native
    push {r4,r5,r6,lr}; mov r4,r0; mov r5,r1; sub sp,sp,#8
    add r2,r4,#0x64; str r2,[sp]; ldr r1,[r4,#0x30]; ldr r2,[r4,#0x34]
    mov r0,r5; ${addr('r3',descriptor)}; bl #${draw}; add sp,sp,#8
    mov r0,r4; mov r1,r5; bl #${adrHex(0x535ab380)}; pop {r4,r5,r6,pc}
    native: b #${adrHex(0x535ab380)}
  `);
  patch.setWord(adjCell+0x4c,iconDraw('adj_cell_draw',A['adj-cell-focus-glass']),'uiSkin: preserve white function icon with glass focus');
  patch.setWord(messageIcon+0x4c,iconDraw('message_panel_draw',A['select-message-panel']),'uiSkin: SelectMenu message child only');
  const pages = {99:assets[designAsset('page-focus')].id,495:assets[designAsset('page-current')].id,496:assets[designAsset('page-normal')].id};
  const pg = emit('page_draw',`push {r4,r5,r6,lr}; mov r4,r0; ldrh r5,[r0,#0xea]; mov r2,r5; ${Object.entries(pages).map(([old,n])=>`movw r3,#${old}; cmp r5,r3; movweq r2,#${n}`).join(';')}; strh r2,[r4,#0xea]; bl #${adrHex(0x5359a3fc)}; strh r5,[r4,#0xea]; pop {r4,r5,r6,pc}`);
  patch.setWord(pageIcon+0x4c,pg,'uiSkin: category icon instance remap');
  const mark=emit('select_mark_draw',`push {r4,r5,r6,lr}; mov r4,r0; ldrh r5,[r0,#0xea]; mov r2,r5; cmp r5,#100; movweq r2,#${assets[designAsset('select-current-dot')].id}; beq draw; movw ip,#499; cmp r5,ip; movweq r2,#${assets[designAsset('select-current-dot')].id}; draw: strh r2,[r4,#0xea]; bl #${adrHex(0x5359a3fc)}; strh r5,[r4,#0xea]; pop {r4,r5,r6,pc}`);
  patch.setWord(selectMark+0x4c,mark,'uiSkin: exact SelectMenu current-value marker only');

  // Read actual SingleItemLineView native state; known icon pairs can use dark on white.
  const solid=emit('wheel_uses_solid',`
    ldr r1,[r0,#0xf4]; ldr r2,[r0,#0xf8]; add ip,r0,#0x100; ldrh ip,[ip,#0x10]
    add r1,r1,ip,lsl #2; cmp r1,r2; bhs no; ldr r1,[r1]; ldr r1,[r1]
    ldr r2,[r1,#0xf0]; cmp r2,#0; beq string; ldrb r3,[r2,#0x9e]; cmp r3,#0; beq string; ldrh r3,[r2,#0xea]
    push {r4,lr}; mov r4,r3; mov r0,r3; mov r1,#1; bl #${variantLookup}; cmp r0,r4; movne r0,#1; moveq r0,#0; pop {r4,pc}
    string: ldr r2,[r1,#0xf4]; cmp r2,#0; beq ascii; ldrb r3,[r2,#0x9e]; cmp r3,#0; beq ascii
    ldrb r3,[r2,#0xee]; cmp r3,#28; moveq r0,#1; bxeq lr; b no
    ascii: ldr r2,[r1,#0xf8]; cmp r2,#0; beq no; ldrb r3,[r2,#0x9e]; cmp r3,#0; beq no
    ldrb r3,[r2,#0xea]; cmp r3,#28; moveq r0,#1; bxeq lr
    no: mov r0,#0; bx lr
  `);
  const wheelValueDraw=emit('wheel_value_icon_draw',`
    push {r4,r5,r6,r7,ip,lr}; mov r4,r0; mov r6,r1; ldrh r5,[r0,#0xea]; mov r7,#0
    ldr r1,[r4,#4]; cmp r1,#0; beq lookup; ldrb r2,[r1,#0x101]; cmp r2,#0; beq lookup
    ldr r2,[r1,#0x3c]; cmp r2,#53; blt lookup
    ldr r0,[r1,#4]; cmp r0,#0; beq lookup; ldr r2,[r0,#0x30]; rsb r2,r2,#704
    cmp r2,#56; blt lookup; cmp r2,#400; bgt lookup
    bl #${solid}; mov r7,r0
    lookup: mov r0,r5; mov r1,r7; bl #${variantLookup}; mov r2,r0
    movw ip,#329; cmp r5,ip; movweq r2,#${assets[designAsset('switch-off')].id}
    movw ip,#330; cmp r5,ip; movweq r2,#${assets[designAsset('switch-on')].id}
    strh r2,[r4,#0xea]; mov r0,r4; mov r1,r6; bl #${adrHex(0x5359a3fc)}
    strh r5,[r4,#0xea]; pop {r4,r5,r6,r7,ip,pc}
  `);
  patch.setWord(wheelIcon+0x4c,wheelValueDraw,'uiSkin: legal white wheel focus uses per-icon dark variant');
  const darkMark=assets[designAsset('wheel-current-dot-dark')].id;
  const wheelMarkDraw=emit('wheel_mark_draw',`
    push {r4,r5,r6,lr}; mov r4,r0; mov r6,r1; ldrh r5,[r0,#0xea]
    cmp r5,#100; beq known; movw ip,#499; cmp r5,ip; bne native
    known: movw r2,#${assets[designAsset('select-current-dot')].id}; strh r2,[r4,#0xea]
    ldr r1,[r4,#4]; cmp r1,#0; beq native; ldrb r2,[r1,#0x101]; cmp r2,#0; beq native
    ldr r2,[r1,#0x3c]; cmp r2,#53; blt native
    ldr r0,[r1,#4]; cmp r0,#0; beq native; ldr r2,[r0,#0x30]; rsb r2,r2,#704
    cmp r2,#56; blt native; cmp r2,#400; bgt native
    bl #${solid}; cmp r0,#0; movwne r2,#${darkMark}; strhne r2,[r4,#0xea]
    native: mov r0,r4; mov r1,r6; bl #${adrHex(0x5359a3fc)}; strh r5,[r4,#0xea]; pop {r4,r5,r6,pc}
  `);
  patch.setWord(wheelMark+0x4c,wheelMarkDraw,'uiSkin: native-position wheel current marker dark only on solid focused capsule');
  const sectionConfig=patch.append(u32le([D.menu.sectionLabel.visible?1:0]),4);
  const sw=valueIconDraw('switch_icon_draw',false);
  const sectionDraw=emit('menu_section_icon_draw',`${addr('r2',sectionConfig)}; ldr r2,[r2]; cmp r2,#0; beq omitted; b #${sw}; omitted: b #${adrHex(0x535ab380)}`);
  patch.setWord(sectionIcon+0x4c,sectionDraw,'uiSkin configurable native category page icon');
  patch.setWord(switchIcon+0x4c,sw,'uiSkin: scoped light/switch icon mapping');
  const hide=emit('hide_onoff_draw',`
    ldrh r2,[r0,#0xea]; cmp r2,#1; beq paired; cmp r2,#2; bne native
    paired: ldr r2,[r0,#4]; cmp r2,#0; beq native
    ldr r3,[r2,#0xf4]; cmp r3,#0; beq second; ldrb ip,[r3,#0x9e]; cmp ip,#0; beq second
    ldrh r3,[r3,#0xea]; movw ip,#329; cmp r3,ip; beq omit; movw ip,#330; cmp r3,ip; beq omit
    second: ldr r3,[r2,#0xf8]; cmp r3,#0; beq native; ldrb ip,[r3,#0x9e]; cmp ip,#0; beq native
    ldrh r3,[r3,#0xea]; movw ip,#329; cmp r3,ip; beq omit; movw ip,#330; cmp r3,ip; beq omit
    native: b #${adrHex(0x53596774)}
    omit: b #${adrHex(0x535ab380)}
  `);
  patch.setWord(hideOnOff+0x4c,hide,'uiSkin F2: suppress only paired TopMenu On/Off value labels during drawing');
  const whitePieces=patch.append(u32le([A['wheel-focus-left'],A['wheel-focus-mid'],A['wheel-focus-right']]),4);
  const glassPieces=patch.append(u32le([A['wheel-glass-left'],A['wheel-glass-mid'],A['wheel-glass-right']]),4);
  report.symbols.wheel_white_pieces=whitePieces; report.symbols.wheel_glass_pieces=glassPieces;

  // Native icon state IDs are distinct across type/state, so updater mapping needs no new state.
  const typeNames=['still','movie','play','custom','setup'];
  const typeIds=[[150,698,101],[152,700,103],[153,701,105],[151,699,102],[154,702,106]];
  const remap=emit('type_icon_remap',`${typeIds.flatMap((row,k)=>row.map((id,s)=>`movw r2,#${id}; cmp r1,r2; movweq r1,#${assets[`type-${k}-${typeNames[k]}-${['normal','current','focus'][s]}`].id}; beq done`)).join(';')}; done: b #${adrHex(0x5359a104)}`);
  hook(adr(0x531b43b8),remap,branchWord(adr(0x531b43b8),adr(0x5359a104),14,true),'type icon states, fixed original slots');

  const canvas = (name:string,expanded:boolean):number => {
    const extra=expanded? `
      ldr r6,[r4,#0xc]; mov r7,#0
      ${typeIds.map((ids,k)=>`ldr r8,[r6,#${16+4*k}]; ldrh r2,[r8,#0xea]; movw r3,#${assets[`type-${k}-${typeNames[k]}-focus`].id}; cmp r2,r3; moveq r7,#1`).join(';')}
      cmp r7,#0; beq done
      ${typeNames.map((n,k)=>{const normal=asset(`type-x-${k}-${n}-normal`),focus=asset(`type-x-${k}-${n}-focus`);return `ldr r8,[r6,#${16+4*k}]; ldrh r2,[r8,#0xea]; movw r3,#${assets[`type-${k}-${n}-focus`].id}; cmp r2,r3; ${addr('r3',normal)}; ${addr('r2',focus)}; moveq r3,r2; ldr r1,[r8,#0x30]; ldr r2,[r8,#0x34]; mov r0,r5; add ip,r4,#0x64; str ip,[sp]; bl #${draw}`;}).join(';')}
    `:'';
    return emit(name,`
      ldrb r2,[r0,#0x9e]; cmp r2,#0; beq native
      push {r4,r5,r6,r7,r8,lr}; mov r4,r0; mov r5,r1; sub sp,sp,#8
      add r2,r4,#0x64; str r2,[sp]; ldr r1,[r4,#0x30]; ldr r2,[r4,#0x34]
      mov r0,r5; ${addr('r3',A['menu-bg'])}; bl #${draw}
      mov r0,r4; mov r1,r5; bl #${adrHex(0x5359332c)}
      ${extra}; done: add sp,sp,#8; pop {r4,r5,r6,r7,r8,pc}
      native: b #${adrHex(0x5359332c)}
    `);
  };
  patch.setWord(topRoot+0x4c,canvas('top_canvas_draw',false),'uiSkin: TopMenu collapsed focus only');
  patch.setWord(selectRoot+0x4c,canvas('select_canvas_draw',false),'uiSkin: SelectMenu background');
  // Canvas::Frame statically calls native Canvas::OnDraw. Private controller/frame copies
  // route only these menu roots through their replacements, including child-only dirty frames.
  const topController=clone('top_controller_vtable',adr(0x53dc6af8)), selectController=clone('select_controller_vtable',adr(0x53dcd3d0));
  const menuRects=patch.append(u32le([D.menu.sectionLabel.x,D.menu.sectionLabel.y,D.menu.sectionLabel.width,D.menu.sectionLabel.height,D.menu.title.xCategory,D.menu.title.y,D.menu.title.width,D.menu.title.height,D.menu.title.xList,D.menu.title.y,D.menu.title.width,D.menu.title.height]),4);
  // SelectMenu's title in the menu title's colour; its two FunctionGuideViews (MENU / OK) styled and
  // placed by the direct pages' hint code (direct_hints, reached through this stub, set once direct.ts is installed).
  const hintsStub=patch.append(u32le([0xe12fff1e]),4);report.symbols.menu_hints_stub=hintsStub;
  const menuPrepare=emit('menu_prepare',`push {r4,r5,r6,lr}; mov r4,r0; ldr r1,[r4]; ${addr('r2',topController)}; cmp r1,r2; beq top; ${addr('r2',selectController)}; cmp r1,r2; bne done
    ldr r0,[r4,#0x160]; cmp r0,#0; beq select_hints; ldr r1,[r0]; ${addr('r2',adr(0x53ece708))}; cmp r1,r2; bne select_hints
    mov r1,#${D.menu.title.colorIndex}; strb r1,[r0,#0xee]; mov r1,#${D.menu.title.outlineIndex}; strb r1,[r0,#0xef]
    select_hints: ldr r0,[r4,#0x158]; cmp r0,#0; blne #${hintsStub}; b done
    top: ${addr('r5',menuRects)}; ldr r0,[r4,#0x15c]; mov r1,r5; bl #${adrHex(0x535aaf0c)}; ldr r6,[r4,#0x160]; mov r0,r6; ldrb r2,[r4,#0x1f0]; cmp r2,#2; bhi done; cmp r2,#0; addeq r1,r5,#16; addne r1,r5,#32; bl #${adrHex(0x535aaf0c)}; mov r0,r6; mov r1,#1; mov r2,#${D.menu.title.fontSize}; mov r3,r2; bl #${adrHex(0x53595ca0)}; mov r1,#${D.menu.title.colorIndex}; strb r1,[r6,#0xee]; mov r1,#${D.menu.title.outlineIndex}; strb r1,[r6,#0xef]; mov r1,#0; strb r1,[r6,#0x108]; done: pop {r4,r5,r6,pc}`);
  const frames=installUiSkinPrivateFrame(patch,{
    [topRoot]:report.symbols.top_canvas_draw,
    [selectRoot]:report.symbols.select_canvas_draw,
  },{forceFullRootVtables:[topRoot,selectRoot],beforeCanvasFrame:menuPrepare});
  for (const [name,address] of Object.entries(frames.symbols)) report.symbols[`menu_${name}`]=address;
  report.regions=frames.regions;
  patch.setWord(topController+0x30,frames.controllerFrame,'uiSkin: TopMenu private controller frame');
  patch.setWord(selectController+0x30,frames.controllerFrame,'uiSkin: SelectMenu private controller frame');
  const invalidate=emit('type_update_invalidate',`push {r0,r1,r2,r3,ip,lr}; ldr r0,[sl,#0x158]; bl #${adrHex(0x535acccc)}; pop {r0,r1,r2,r3,ip,lr}; sub sp,fp,#0x28; b #${adrHex(0x531b4458)}`);
  hook(adr(0x531b4454),invalidate,0xe24bd028,'invalidate original full root on type/focus update',false);

  // Color the native row child widgets immediately before native list rendering.
  // TopMenuLine: String ec/fc/100; Ascii f0/104/108. SelectMenuLine: String fc; Ascii 100.
  const setText=(off:number,ascii:boolean,reg:string)=> `ldr r0,[r9,#${off}]; cmp r0,#0; strbne ${reg},[r0,#${ascii?0xea:0xee}]; strbne ${reg},[r0,#${ascii?0xeb:0xef}]`;
  const tagValue=(offset:number,normal=switchIcon,focused=darkIcon)=>`ldr r0,[r9,#${offset}]; cmp r0,#0; ${addr('r2',normal)}; ${addr('r3',focused)}; add r1,r4,#0x100; ldrh r1,[r1,#0x10]; ldrb ip,[r4,#0x18d]; cmp r1,r8; cmpeq ip,#9; moveq r2,r3; cmp r0,#0; strne r2,[r0]`;
  const tagChild=(offset:number,vt:number)=>`ldr r0,[r9,#${offset}]; cmp r0,#0; ${addr('r2',vt)}; strne r2,[r0]`;
  // The list's scroll bar ([list+0xEC], ScrollBarView: background, track, thumb, three LineViews): only the thumb is drawn (8.2).
  const lineVts=[adr(0x53ece550),transparentLine,thumbLine];
  const scrollBar=`ldr r0,[r4,#0xec]; cmp r0,#0; beq sb_done; ldr r1,[r0,#0xc]; ldr r2,[r0,#0x10]; sub r3,r2,r1; cmp r3,#12; bne sb_done
    ${[0,4,8].map(o=>`ldr r0,[r1,#${o}]; cmp r0,#0; beq sb_done; ldr r2,[r0]; ${lineVts.map(v=>`${addr('r3',v)}; cmp r2,r3; beq sb_ok_${o}`).join(';')}; b sb_done; sb_ok_${o}:`).join(';')}
    ldr r0,[r1]; ${addr('r2',transparentLine)}; str r2,[r0]; ldr r0,[r1,#4]; str r2,[r0]; ldr r0,[r1,#8]; ${addr('r2',thumbLine)}; str r2,[r0]
    sb_done:`;
  const recolor=(kind:'top'|'select'|'sub'):string=>`
    ${scrollBar}
    ldr r6,[r4,#0xf4]; ldr r7,[r4,#0xf8]; mov r8,#0
    rows: cmp r6,r7; bhs after_rows; ldr r9,[r6]; ldr r9,[r9]
    mov r10,#${D.menu.row.normalColor}; mov r11,#${D.menu.row.normalSecondaryColor}; add ip,r4,#0x100; ldrh r0,[ip,#0x10]
    cmp r0,r8; bne apply_color; ldrb r0,[r4,#0x18d]; cmp r0,#9; bne apply_color
    mov r10,#${D.menu.row.focusColor}; mov r11,#${D.menu.row.focusSecondaryColor}
    apply_color: ${kind==='sub'?[tagValue(0xf0,valueIcon,valueDark),tagValue(0xf4,valueIcon,valueDark),tagValue(0xf8,valueIcon,valueDark),tagValue(0x104,trailingIcon,chevronFocus),setText(0xec,false,'r10'),setText(0xfc,false,'r11'),setText(0x100,true,'r11')].join(';'):kind==='top'?[tagValue(0xf4,valueIcon,valueDark),tagValue(0xf8,valueIcon,valueDark),tagChild(0x10c,trailingIcon),tagChild(0xfc,hideOnOff),tagChild(0x100,hideOnOff),setText(0xec,false,'r10'),setText(0xf0,true,'r10'),setText(0xfc,false,'r11'),setText(0x100,false,'r11'),setText(0x104,true,'r11'),setText(0x108,true,'r11')].join(';'):[tagValue(0xf0),tagValue(0xf4),`ldr r0,[r9,#0xec]; ${addr('r2',selectMark)}; str r2,[r0]`,setText(0xf8,false,'r10'),setText(0xfc,false,'r10'),setText(0x100,true,'r10'),setText(0x104,true,'r10')].join(';')}
    add r6,r6,#4; add r8,r8,#1; b rows; after_rows:
  `;
  // SubMenu rows (SubMenuLineView: label +0xEC, value icons +0xF0..0xF8, value text +0xFC / Ascii +0x100,
  // chevron +0x104) as SelectMenu's: the same colours, the value column as TopMenu's, the list drawn by the camera's own list draw.
  for (const [name,vt,kind] of [['top_list_draw',topList,'top'],['select_list_draw',selectList,'select'],['submenu_list_draw',submenuList,'sub']] as const) {
    const f=emit(name,`push {r4,r5,r6,r7,r8,r9,r10,r11,ip,lr}; mov r4,r0; mov r5,r1; ${recolor(kind)}; mov r0,r4; mov r1,r5; bl #${adrHex(0x53594c9c)}; pop {r4,r5,r6,r7,r8,r9,r10,r11,ip,pc}`);
    patch.setWord(vt+0x4c,f,'uiSkin: scoped row colors');
  }

  const wheelPre=emit('wheel_list_draw',`
    push {r4,r5,r6,r7,r8,r9,ip,lr}; mov r4,r0; mov r5,r1
    ldr r6,[r4,#0xf4]; ldr r7,[r4,#0xf8]
    loop: cmp r6,r7; bhs paint; ldr r9,[r6]; ldr r9,[r9]
    ${tagChild(0xec,wheelMark)}; ${tagChild(0xf0,wheelIcon)}
    add r6,r6,#4; b loop
    paint: mov r0,r4; mov r1,r5; bl #${adrHex(0x53594c9c)}; pop {r4,r5,r6,r7,r8,r9,ip,pc}
  `);
  patch.setWord(adjList+0x4c,wheelPre,'uiSkin: wheel marker/value icon scope');
  patch.setWord(icList+0x4c,wheelPre,'uiSkin: wheel marker/value icon scope');

  const bg = emit('list_background',`
    push {r0,r1,r2,r3,r4,r5,r6,lr}; ldr r4,[sl]
    ${addr('r2',topList)}; cmp r4,r2; beq done; ${addr('r2',selectList)}; cmp r4,r2; beq done; ${addr('r2',submenuList)}; cmp r4,r2; beq done
    ${addr('r2',adjList)}; cmp r4,r2; beq adj; ${addr('r2',icList)}; cmp r4,r2; bne native
    ${addr('r3',A['ic-list-bg'])}; b draw
    adj: ${addr('r3',A['adj-list-bg'])}
    draw: mov r4,r1; sub sp,sp,#8; add r2,sl,#0x64; str r2,[sp]
    ldr r0,[r4]; ldr r1,[sl,#0x30]; ldr r2,[sl,#0x38]; add r1,r1,r2; sub r1,r1,#500; ldr r2,[sl,#0x34]
    bl #${draw}; add sp,sp,#8
    done: pop {r0,r1,r2,r3,r4,r5,r6,pc}
    native: pop {r0,r1,r2,r3,r4,r5,r6,lr}; b #${adrHex(0x5323e1c0)}
  `);
  hook(adr(0x53594d80),bg,branchWord(adr(0x53594d80),adr(0x5323e1c0),14,true),'backgrounds on tagged list instances');
  const focus=emit('list_focus',`
    push {r0,r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,ip,lr}
    mrs ip,cpsr; push {ip,lr}; ldr r4,[sl]
    ${addr('r2',topList)}; cmp r4,r2; beq menu
    ${addr('r2',selectList)}; cmp r4,r2; beq select
    ${addr('r2',submenuList)}; cmp r4,r2; beq select
    ${addr('r2',adjList)}; cmp r4,r2; beq wheel
    ${addr('r2',icList)}; cmp r4,r2; beq wheel; b native
    select: ${addr('r8',A['select-focus-outer-glow'])}; ${addr('r3',A['select-focus-row-inrow'])}; ldrb r2,[r1,#20]; cmp r2,#9; beq render
    mov r8,#0; ${addr('r3',A['select-focus-row-glass'])}; b render
    menu: ${addr('r8',A['menu-focus-outer-glow'])}; ${addr('r3',A['menu-focus-row-inrow'])}; ldrb r2,[r1,#20]; cmp r2,#9; beq render
    mov r8,#0; ${addr('r3',A['menu-focus-row-glass'])}
    render: mov r4,r1; ldr r5,[r4,#4]; ldr r6,[r4,#8]; ldr r7,[r4]; sub sp,sp,#8; add r2,sl,#0x64; str r2,[sp]
    ldr r0,[r4]; ldr r1,[r4,#4]; ldr r2,[r4,#8]
    add r1,r1,#${D.menu.glassInset}; add r2,r2,#${D.menu.glassInset}
    bl #${draw}; cmp r8,#0; beq rendered; ldr r0,[sl,#4]; cmp r0,#0; moveq r0,sl; add r0,r0,#0x64; str r0,[sp]; mov r0,r7; sub r1,r5,#${D.menu.glow.offsetX}; sub r2,r6,#${D.menu.glow.offsetY}; mov r3,r8; bl #${draw}; rendered: add sp,sp,#8; b done
    wheel: mov r4,r1; ldr r5,[sl,#0x30]; add r5,r5,#8; rsb r7,r5,#712
    cmp r7,#56; blt native; cmp r7,#400; bgt native
    ldr r6,[r4,#16]; cmp r6,#53; blt native
    ldr r6,[r4,#8]; add r6,r6,#6; ldr r11,[r4]
    mov r0,sl; bl #${solid}; cmp r0,#0; ${addr('r8',glassPieces)}; ${addr('r2',whitePieces)}; movne r8,r2
    sub sp,sp,#8; add r2,sl,#0x64; str r2,[sp]
    mov r0,r11; mov r1,r5; mov r2,r6; ldr r3,[r8]; bl #${draw}
    add r5,r5,#23; sub r9,r7,#46
    middle: cmp r9,#0; beq right
    mov r0,r11; mov r1,r5; mov r2,r6; ldr r3,[r8,#4]; bl #${draw}
    add r5,r5,#1; sub r9,r9,#1; b middle
    right: mov r0,r11; mov r1,r5; mov r2,r6; ldr r3,[r8,#8]; bl #${draw}
    add sp,sp,#8
    done: pop {ip,lr}; msr cpsr_f,ip; pop {r0,r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,ip,pc}
    native: pop {ip,lr}; msr cpsr_f,ip; pop {r0,r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,ip,lr}; b #${adrHex(0x5323e1c0)}
  `);
  hook(adr(0x53594edc),focus,branchWord(adr(0x53594edc),adr(0x5323e1c0),14,true),'in-row focus resources on TopMenu/SelectMenu only');
  const sep=emit('list_separator',`
    ldr ip,[r7]; ${addr('r2',topList)}; cmp ip,r2; beq color; ${addr('r2',selectList)}; cmp ip,r2; beq color; ${addr('r2',submenuList)}; cmp ip,r2; beq color
    ${addr('r2',adjList)}; cmp ip,r2; beq wheel_clear; ${addr('r2',icList)}; cmp ip,r2; bne original
    wheel_clear: ldr r2,[r1,#16]; cmp r2,#2; bxgt lr; b original
    color: ldr r2,[r1,#16]; cmp r2,#2; bxgt lr; cmp r2,#0; bxle lr; cmp r2,#2; moveq r2,#1; streq r2,[r1,#16]; mov r2,#244; strb r2,[r1,#20]
    original: b #${adrHex(0x5323e1c0)}
  `);
  hook(adr(0x53594e08),sep,branchWord(adr(0x53594e08),adr(0x5323e1c0),14,true),'native row separator extents, scoped color');

  const wheel05=installUiSkinWheel(patch,assets,options);
  report.hooks.push(...wheel05.report.hooks);Object.assign(report.symbols,wheel05.report.symbols);report.regions=[...(report.regions??[]),...(wheel05.report.regions??[])];report.fallbacks.push(...wheel05.report.fallbacks);
  const tag=(i:number,vt:number)=>`ldr r0,[r4,#${i*4}]; ${addr('r2',vt)}; str r2,[r0]`;
  const bind=(name:string,site:number,body:string):void=>{
    const f=emit(name,`push {r4,r5,r6,lr}; mov r4,r1; mov r5,r0; bl #${adrHex(0x53184428)}; push {r0,r1,r2,r3,ip,lr}; ${body}; pop {r0,r1,r2,r3,ip,lr}; pop {r4,r5,r6,pc}`);
    hook(site,f,branchWord(site,adr(0x53184428),14,true),`${name}: tag exact bound instances`);
  };
  bind('bind_top',adr(0x531b58f4),[tag(0,topRoot),tag(1,sectionIcon),tag(3,transparentLine),tag(4,suppressedIcon),tag(21,topList),...Array.from({length:11},(_,k)=>tag(10+k,pageIcon)),`${addr('r2',topController)}; str r2,[r5]`].join(';'));
  bind('bind_adj',adr(0x531c1a60),[...Array.from({length:5},(_,k)=>tag(4+k,transparentLine)),tag(9,adjCell),tag(24,adjList),`mov r0,r5; mov r1,r4; bl #${wheel05.bindAdj}`].join(';'));
  bind('bind_ic',adr(0x531c7384),tag(7,icList)+`; mov r0,r5; mov r1,r4; bl #${wheel05.bindIc}`);
  bind('bind_playback',adr(0x53191330),tag(109,transparentLine));
  report.fallbacks.push('Playback: remove only confirmed WLAN-status fill (#109), keep children; other bottom/top fill and unbound star/shadow consumers retain native behavior');
  bind('bind_select',adr(0x531dcd1c),[tag(0,selectRoot),tag(4,switchIcon),tag(6,switchIcon),...[1,10,13].map(i=>tag(i,transparentLine)),...[3,15].map(i=>tag(i,dividerLine)),tag(16,selectList),`ldr r0,[r4,#68]; ldr r0,[r0,#0xec]; ${addr('r2',messageIcon)}; str r2,[r0]`,`${addr('r2',selectController)}; str r2,[r5]`].join(';'));
  const direct=installUiSkinDirect(patch,assets,options,report);report.hooks.push(...direct.hooks);Object.assign(report.symbols,direct.symbols);
  patch.setWord(hintsStub,branchWord(hintsStub,direct.symbols.direct_hints,14,false),'uiSkin H: SelectMenu hints through the direct pages\' hint code');report.regions=[...(report.regions??[]),...(direct.regions??[])];report.fallbacks.push(...direct.fallbacks);
  UI_SKIN_LAST_RUNTIME_REPORT=report;
  return report;
}
