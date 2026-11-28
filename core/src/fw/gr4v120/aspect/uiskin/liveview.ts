// SPDX-License-Identifier: GPL-2.0-only
/** GR IV 1.20 LiveView skin. All hooks are reachable only through LiveViewController. */
import {UI_SKIN_DESIGN as D,designAsset} from './design';
import {checkedUiVtable} from './vtable';
import { Patch, expectWord, u32le } from '../build';
import {branchWord} from '../arm';
import {assembleVisualWords as assembleWords} from './visual-arm';
import type { SkinAsset } from './runtime';
import { installUiSkinPrivateFrame } from './privateframe';
import { installUiSkinTop } from './top';
import { installUiSkinBottom } from './bottom';
import type {SkinCatalogOptions} from './resources';
import {adr,adrHex} from '../../target';

export interface UiSkinLiveReport {
  hooks: { site: number; target: number; expected: number; reason: string }[];
  symbols: Record<string, number>;
  regions: { name: string; address: number; length: number; purpose: string }[];
  fallbacks: string[];
}
export let UI_SKIN_LAST_LIVE_REPORT: UiSkinLiveReport | null = null;

export function installUiSkinLiveView(patch: Patch, assets: Record<string, SkinAsset>, options:SkinCatalogOptions): UiSkinLiveReport {
  const report: UiSkinLiveReport = { hooks: [], symbols: {}, regions: [], fallbacks: [
    'Level B: retain the complete factory level whenever the native type uses the auxiliary reference-line family (type 2), pitch is visible, roll is hidden, orientation is nonzero, or the native roll is not a finite half-degree value.',
  ] };
  const addr = (r: string, n: number) => `movw ${r}, #${n & 65535}; movt ${r}, #${n >>> 16}`;
  const emit = (name: string, text: string): number => {
    const at = patch.append(a => assembleWords(text, a), 16);
    report.symbols[name] = at;
    report.regions.push({ name, address: at, length: assembleWords(text, at).length * 4, purpose: 'LiveView-only code' });
    return at;
  };
  const hook = (site: number, target: number, expected: number, reason: string, link = true): void => {
    expectWord(patch, site, expected);
    patch.setWord(site, branchWord(site, target, 14, link), `uiSkinLiveView: ${reason}`);
    report.hooks.push({ site, target, expected, reason });
  };
  const asset = (name: string): number => {
    const a = assets[designAsset(name)]; if (!a) throw new Error(`uiSkinLiveView missing asset ${name}`);
    const at = patch.append(u32le([a.id, a.width, a.height]), 4);
    report.symbols[`asset_${name}`] = at;
    return at;
  };
  const A = Object.fromEntries(['level-arc', 'level-arc-level', 'level-dot', 'level-dot-level'].map(n => [n, asset(n)]));
  const clone = (name: string, native: number): number => {
    const at = patch.append(checkedUiVtable(patch,native), 16) + 8;
    report.symbols[name] = at;
    report.regions.push({ name, address: at - 8, length: 0x108, purpose: 'Instance vtable; native RTTI and negative slots retained' });
    return at;
  };
  const top=installUiSkinTop(patch,assets,options),bottom=installUiSkinBottom(patch,assets,{...options,yellowPalette:248,inkTableAddress:top.symbols.top_ink_table});
  Object.assign(report.symbols,top.symbols,bottom.symbols);
  report.regions.push(...top.regions,...bottom.regions);
  report.fallbacks.push(...top.fallbacks,...bottom.fallbacks);
  const prepare=emit('live_prepare_layout',`push {r4,lr}; mov r4,r0; bl #${top.prepare}; mov r0,r4; bl #${bottom.prepare}; pop {r4,pc}`);
  const rootVtable = clone('live_root_vtable', adr(0x53ece290));
  const levelVtable = clone('live_level_vtable', adr(0x53ecf240));
  const controllerVtable = clone('live_controller_vtable', adr(0x53dbf740));
  // Identity-only clone: both native auxiliary reference lines keep every original slot.
  const auxiliaryVtable = clone('live_auxiliary_vtable', adr(0x53eceab8));

  // Native roll is already quantized to 0.5 degree. Lookup exact IEEE-754 values without
  // introducing floating-point instructions, FPSCR changes, or a runtime trigonometry library.
  const pointWords: number[] = [];
  for (let i = 0; i <= 30; i++) {
    const angle = i / 2, theta = angle * Math.PI / 180;
    const f = new Float32Array([angle]);
    pointWords.push(new Uint32Array(f.buffer)[0], Math.round(D.viewfinder.level.radius * Math.sin(theta)), Math.round(D.viewfinder.level.centerY - D.viewfinder.level.radius * Math.cos(theta)));
  }
  const points = patch.append(u32le(pointWords), 16);
  report.symbols.level_points = points;
  report.regions.push({ name: 'level_points', address: points, length: pointWords.length * 4, purpose: 'Position-only half-degree sine/cosine lookup' });

  // r0 = SpiritLevelView. Return r0=1,r1=dot-left,r2=dot-top only for a complete
  // native roll-only state; all other states return r0=0 and keep factory rendering.
  const eligible = emit('live_level_eligible', `
    ldrb r3,[r0,#0x9e]; cmp r3,#0; beq no
    ldrb r3,[r0,#0x11f]; cmp r3,#1; bhi no
    ldr r3,[r0,#0x120]; cmp r3,#0; bne no
    push {r4,r5,r6,lr}; ldr r4,[r0,#4]; cmp r4,#0; beq auxiliary_no
    ldr r2,[r4]; ${addr('r3', rootVtable)}; cmp r2,r3; bne auxiliary_no
    ldr r2,[r4,#0xc]; ldr r3,[r4,#0x10]; mov ip,#0
    auxiliary_scan: cmp r2,r3; bhs auxiliary_done; ldr r5,[r2],#4; ldr r6,[r5]
    ${addr('r4', auxiliaryVtable)}; cmp r6,r4; bne auxiliary_scan
    ldrb r6,[r5,#0x9e]; cmp r6,#0; bne auxiliary_no
    add ip,ip,#1; b auxiliary_scan
    auxiliary_done: cmp ip,#2; bne auxiliary_no
    pop {r4,r5,r6,lr}; b auxiliary_ok
    auxiliary_no: pop {r4,r5,r6,lr}; mov r0,#0; bx lr
    auxiliary_ok:
    ldr r3,[r0,#0x100]; cmp r3,#0; beq no
    ldrb r3,[r3,#0x9e]; cmp r3,#0; bne no
    ldr r3,[r0,#0x104]; cmp r3,#0; beq no
    ldrb r3,[r3,#0x9e]; cmp r3,#0; beq no
    ldr ip,[r0,#0x10c]; bic r3,ip,#0x80000000
    movw r2,#0; movt r2,#0x4334; cmp r3,r2; bhi no
    movw r2,#0; movt r2,#0x4170; cmp r3,r2; movhi r3,r2
    ${addr('r2', points)}; mov r1,#31
    search: ldr r0,[r2]; cmp r0,r3; beq found
    add r2,r2,#12; sub r1,r1,#1; cmp r1,#0; bne search
    no: mov r0,#0; bx lr
    found: ldr r1,[r2,#4]; ldr r2,[r2,#8]
    tst ip,#0x80000000; rsbne r1,r1,#0; add r1,r1,#${D.viewfinder.level.centerX-12}
    mov r0,#1; bx lr
  `);

  // Original bitmap request ABI, with every destination intersected with the root clip.
  const draw = emit('live_draw_asset', `
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
    str r0,[sp,#28]; str r1,[sp,#32]
    ldr r0,[r7]; str r0,[sp,#36]; mov r0,#0; str r0,[sp,#40]
    bl #${adrHex(0x5323d7f0)}; bl #${adrHex(0x5323da14)}; mov r1,sp; bl #${adrHex(0x53240038)}
    done: add sp,sp,#48; pop {r4,r5,r6,r7,r8,pc}
  `);

  // The native base draw clears the same flags and updates the previous rectangle even when
  // a view has no children. Temporarily use that exact empty-list path for eligible levels.
  const levelDraw = emit('live_level_draw', `
    push {r4,r5,r6,lr}; mov r4,r0; mov r5,r1; bl #${eligible}
    cmp r0,#0; beq native
    ldr r6,[r4,#0x10]; ldr r2,[r4,#0xc]; str r2,[r4,#0x10]
    mov r0,r4; mov r1,r5; bl #${adrHex(0x5359332c)}; str r6,[r4,#0x10]
    pop {r4,r5,r6,pc}
    native: mov r0,r4; mov r1,r5; pop {r4,r5,r6,lr}; b #${adrHex(0x5359332c)}
  `);
  patch.setWord(levelVtable + 0x4c, levelDraw, 'uiSkinLiveView: tagged native roll-only group');

  const rootDraw = emit('live_root_draw', `
    push {r4,r5,r6,r7,r8,r9,r10,lr}; mov r4,r0; mov r5,r1
    mov r0,r2; bl #${bottom.drawBackdrop}; mov r0,r4; mov r1,r5
    bl #${adrHex(0x5359332c)}; ldrb r2,[r4,#0x9e]; cmp r2,#0; beq done
    ldr r6,[r4,#0xc]; ldr r7,[r4,#0x10]
    scan: cmp r6,r7; bhs done; ldr r10,[r6],#4; ldr r2,[r10]
    ${addr('r3', levelVtable)}; cmp r2,r3; bne scan
    mov r0,r10; bl #${eligible}; cmp r0,#0; beq done
    mov r8,r1; mov r9,r2; sub sp,sp,#8
    add r2,r4,#0x64; str r2,[sp]
    mov r0,r5; movw r1,#${D.viewfinder.level.assetX}; movw r2,#${D.viewfinder.level.assetY}
    ldrb ip,[r10,#0x119]; cmp ip,#0
    ${addr('r3', A['level-arc'])}; ${addr('ip', A['level-arc-level'])}; movne r3,ip
    bl #${draw}
    mov r0,r5; mov r1,r8; mov r2,r9
    ldrb ip,[r10,#0x119]; cmp ip,#0
    ${addr('r3', A['level-dot'])}; ${addr('ip', A['level-dot-level'])}; movne r3,ip
    bl #${draw}; add sp,sp,#8
    done: pop {r4,r5,r6,r7,r8,r9,r10,pc}
  `);
  // Keep the public two-argument root virtual slot native. Only the private Frame dispatcher
  // supplies the controller context required by this three-argument paint function.

  const frames = installUiSkinPrivateFrame(patch, { [rootVtable]: rootDraw }, { forceFullRootVtables: [rootVtable], beforeCanvasFrame:prepare, controllerContextRootVtables:[rootVtable] });
  Object.assign(report.symbols, frames.symbols);
  report.regions.push(...frames.regions);
  patch.setWord(controllerVtable + 0x30, frames.controllerFrame, 'uiSkinLiveView: private native frame loop on LiveView controller only');


  const bind = emit('live_bind_views', `
    push {r4,r5,r6,lr}; mov r4,r1; bl #${adrHex(0x53184428)}
    ldr r5,[r4]; ${addr('r6', rootVtable)}; str r6,[r5]
    ldr r5,[r4,#144]; ${addr('r6', levelVtable)}; str r6,[r5]
    ${addr('r6', auxiliaryVtable)}; ldr r5,[r4,#368]; str r6,[r5]
    ldr r5,[r4,#372]; str r6,[r5]
    sub r5,r4,#0x15c; ${addr('r6', controllerVtable)}; str r6,[r5]
    push {r0,r1,r2,r3,ip,lr}; mov r0,r5; bl #${bottom.bind}; pop {r0,r1,r2,r3,ip,lr}
    pop {r4,r5,r6,pc}
  `);
  hook(adr(0x5318bb90), bind, branchWord(adr(0x5318bb90), adr(0x53184428), 14, true), 'only LiveView BindViews controller, root, level, and identity-only auxiliary-line instances');

  // This is the common success/hidden exit of callback 36. Mark the actual full-screen
  // root, so eligibility/orientation/DISP changes clear both the factory and new positions.
  const invalidate = emit('live_level_invalidate', `
    push {r0,r1,r2,r3,ip,lr}; mrs ip,cpsr; push {ip,lr}
    ldr r0,[r4,#0x15c]; bl #${adrHex(0x535acccc)}
    pop {ip,lr}; msr cpsr_f,ip; pop {r0,r1,r2,r3,ip,lr}
    sub sp,fp,#0x28; b #${adrHex(0x5318ebe0)}
  `);
  hook(adr(0x5318ebdc), invalidate, 0xe24bd028, 'invalidate full LiveView root after native level visibility/data update', false);
  UI_SKIN_LAST_LIVE_REPORT = report;
  return report;
}
