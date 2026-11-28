// SPDX-License-Identifier: GPL-2.0-only
/** Private native frame loops: no shared Canvas code or startup path is modified. */
import { Patch, expectWord } from '../build';
import { assembleWords, branchWord } from '../arm';
import {adr,adrHex,byRelease} from '../../target';

export interface UiSkinPrivateFrameReport {
  controllerFrame: number;
  canvasFrame: number;
  symbols: Record<string, number>;
  regions: { name: string; address: number; length: number; purpose: string }[];
}

/** Validate the exact A32 forms in these two native routines. Unhandled PC use is fatal. */
function validatePositionIndependentWord(word: number, address: number): void {
  const fail = () => { throw new Error(`uiSkin private frame unsupported PC/encoding at 0x${address.toString(16)}`); };
  if ((word >>> 28) === 15) fail();
  if ((word & 0x0e000000) === 0x0a000000) return; // B/BL: explicitly relocated below.
  if ((word & 0x0ffffff0) === 0x012fff10 || (word & 0x0ffffff0) === 0x012fff30) { if ((word & 15) === 15) fail(); return; }
  const kind = (word >>> 25) & 7, rn = (word >>> 16) & 15, rd = (word >>> 12) & 15;
  if (kind === 4) {
    if (rn === 15) fail();
    // Only the existing stack-frame pushes/pops may include pc in a register list.
    if ((word & 0x8000) && rn !== 13) fail();
    return;
  }
  if (kind === 2 || kind === 3) {
    if (rn === 15 || rd === 15 || (kind === 3 && (word & 15) === 15)) fail();
    return;
  }
  if (kind === 0 || kind === 1) {
    // MOVW/MOVT contain immediate fragments in fields which otherwise hold registers.
    if ((word & 0x0ff00000) === 0x03000000 || (word & 0x0ff00000) === 0x03400000) {
      if (rd === 15) fail(); return;
    }
    const opcode = (word >>> 21) & 15;
    if (rd === 15 || (rn === 15 && opcode !== 13 && opcode !== 15)) fail();
    if (kind === 0 && ((word & 15) === 15 || ((word & 0x10) && ((word >>> 8) & 15) === 15))) fail();
    return;
  }
  fail();
}

/** Return a private Controller::Render pointer for the caller's cloned controller slot +0x30.
 * All source instructions are checked against the release's originals (expectWord, word by word). No runtime allocation.
 * 1.21's two routines are 1.20's up to relocation: the BL targets (each the 1.20 target mapped) and, in Canvas::Frame,
 * the stack-guard canary pointer 0x5438c484 -> 0x5438dc74 (same bytes); every other word is equal.
 */
export function installUiSkinPrivateFrame(patch: Patch, roots: Readonly<Record<number, number>>, options: { forceFullRootVtables?: readonly number[]; beforeCanvasFrame?: number; controllerContextRootVtables?: readonly number[] } = {}): UiSkinPrivateFrameReport {
  const symbols: Record<string, number> = {}, regions: UiSkinPrivateFrameReport['regions'] = [];
  const addr = (r: string, n: number) => `movw ${r}, #${n & 65535}; movt ${r}, #${n >>> 16}`;
  const mapping = Object.entries(roots).map(([vtable, draw]) => [Number(vtable), draw] as const);
  if (!mapping.length) throw new Error('uiSkin private frame requires an exact instance vtable mapping');
  const contexts=options.controllerContextRootVtables??[];
  if(contexts.some(v=>!(v in roots)))throw new Error('uiSkin context root not mapped');
  const source = `push {r2,r3,ip,lr}; mrs ip,cpsr; push {ip,lr}; ldr r2,[r0];
    ${mapping.map(([vtable], i) => `${addr('r3', vtable)}; cmp r2,r3; beq target_${i}`).join(';')};
    pop {ip,lr}; msr cpsr_f,ip; pop {r2,r3,ip,lr}; b #${adrHex(0x5359332c)};
    ${mapping.map(([vtable, draw], i) => `target_${i}: pop {ip,lr}; msr cpsr_f,ip; pop {r2,r3,ip,lr}; ${contexts.includes(vtable)?'mov r2,r8;':''} b #${draw}`).join(';')}`;
  const dispatcher = patch.append(a => assembleWords(source, a), 16);
  symbols.private_root_dispatch = dispatcher;
  regions.push({ name: 'private_root_dispatch', address: dispatcher, length: assembleWords(source, dispatcher).length * 4, purpose: 'Private exact-instance root draw dispatch; all original argument registers, CPSR and SP restored' });
  const relocate = (name: string, original: number, words: readonly number[], replacements: Record<number, number>): number => {
    for (let i = 0; i < words.length; i++) {
      validatePositionIndependentWord(words[i], original + i * 4);
      expectWord(patch, original + i * 4, words[i]);
    }
    const at = patch.append(destination => words.map((word, i) => {
      if ((word & 0x0e000000) !== 0x0a000000) return word;
      const offset = (word << 8) >> 8;
      const nativeTarget = original + i * 4 + 8 + offset * 4;
      const target = replacements[original + i * 4] ?? (nativeTarget >= original && nativeTarget < original + words.length * 4 ? destination + nativeTarget - original : nativeTarget);
      return branchWord(destination + i * 4, target, word >>> 28, !!(word & 0x01000000));
    }), 16);
    symbols[name] = at;
    regions.push({ name, address: at, length: words.length * 4, purpose: 'Exact native A32 copy; explicit B/BL relocation and one private call replacement' });
    return at;
  };
  const privateCanvasFrame = relocate('private_canvas_frame', adr(0x535910ac), byRelease({'1.20': [
    0xe1a0c00d,0xe92dd870,0xe30c5484,0xe3455438,0xe24cb004,0xe24dd024,0xe5903000,0xe1a04000,
    0xe5952000,0xe5933048,0xe50b2020,0xe12fff33,0xe5d4309d,0xe3530000,0x1a00000e,0xe5d4309c,
    0xe3530000,0x1a00000b,0xe5d430a0,0xe3530000,0x1a00000f,0xe5d430a2,0xe3530000,0x1a00001e,
    0xe51b2020,0xe5953000,0xe1520003,0x1a000022,0xe24bd018,0xe89da870,0xe1a00004,0xeb006caa,
    0xe1a00004,0xeb006e31,0xe5d430a0,0xe3530000,0x0affffef,0xe5d4e0f0,0xe2843020,0xe594c0ec,
    0xe24b6034,0xe893000f,0xe54be024,0xe886000f,0xe50bc038,0xebf2b1a2,0xebf2b1ff,0xe24b1038,
    0xebf2b413,0xe59410ec,0xe1a00004,0xeb00086b,0xe1a00006,0xeb0e0123,0xeaffffe0,0xe59410ec,
    0xe1a00004,0xe5d420f0,0xeb006f40,0xe59410ec,0xe1a00004,0xeb006f0b,0xeaffffd8,0xeb143dc9
  ], '1.21': [
    0xe1a0c00d,0xe92dd870,0xe30d5c74,0xe3455438,0xe24cb004,0xe24dd024,0xe5903000,0xe1a04000,
    0xe5952000,0xe5933048,0xe50b2020,0xe12fff33,0xe5d4309d,0xe3530000,0x1a00000e,0xe5d4309c,
    0xe3530000,0x1a00000b,0xe5d430a0,0xe3530000,0x1a00000f,0xe5d430a2,0xe3530000,0x1a00001e,
    0xe51b2020,0xe5953000,0xe1520003,0x1a000022,0xe24bd018,0xe89da870,0xe1a00004,0xeb006caa,
    0xe1a00004,0xeb006e31,0xe5d430a0,0xe3530000,0x0affffef,0xe5d4e0f0,0xe2843020,0xe594c0ec,
    0xe24b6034,0xe893000f,0xe54be024,0xe886000f,0xe50bc038,0xebf2b0da,0xebf2b137,0xe24b1038,
    0xebf2b34b,0xe59410ec,0xe1a00004,0xeb00086b,0xe1a00006,0xeb0e01ff,0xeaffffe0,0xe59410ec,
    0xe1a00004,0xe5d420f0,0xeb006f40,0xe59410ec,0xe1a00004,0xeb006f0b,0xeaffffd8,0xeb1440f1
  ]}), { [adr(0x53591178)]: dispatcher });
  // Execute after the unchanged native pre-draw virtual call and before native dirty checks.
  // This closes child-only clearing for overlays painted outside the native child bounds.
  const forced = options.forceFullRootVtables ?? [];
  if (forced.length) {
    if (forced.some(vtable => !(vtable in roots))) throw new Error('uiSkin full-frame root must have a mapped draw handler');
    const resume = privateCanvasFrame + (adr(0x535910e0) - adr(0x535910ac));
    const text = `push {r0,r1,r2,r3,ip,lr}; mrs ip,cpsr; push {ip,lr}; ldr r2,[r4];
      ${forced.map(vtable => `${addr('r3', vtable)}; cmp r2,r3; beq scope`).join(';')}; b done;
      scope: ldrb r2,[r4,#0xa0]; ldrb r3,[r4,#0xa2]; orr r2,r2,r3; cmp r2,#0; movne r2,#1; strbne r2,[r4,#0xa0];
      done: pop {ip,lr}; msr cpsr_f,ip; pop {r0,r1,r2,r3,ip,lr}; ldrb r3,[r4,#0x9d]; b #${resume}`;
    const at = patch.append(a => assembleWords(text, a), 16);
    const site = privateCanvasFrame + (adr(0x535910dc) - adr(0x535910ac));
    expectWord(patch, site, 0xe5d4309d);
    patch.setWord(site, branchWord(site, at), 'uiSkin: private tagged root full clear after native pre-draw');
    symbols.private_full_dirty_guard = at;
    regions.push({ name: 'private_full_dirty_guard', address: at, length: assembleWords(text, at).length * 4, purpose: 'Promote a0/a2 dirty only on the mapped full-root instances; no-dirty and non-scope state preserved' });
  }
  // Only this private Controller copy passes its preserved r8 controller to layout preparation.
  // It runs after native prepare and display-lock acquisition, immediately before Canvas::Frame.
  let canvasEntry=privateCanvasFrame;
  if(options.beforeCanvasFrame!==undefined){
    const text=`push {r0,r1,r2,r3,ip,lr}; mrs ip,cpsr; push {ip,lr}; mov r0,r8; bl #${options.beforeCanvasFrame}; pop {ip,lr}; msr cpsr_f,ip; pop {r0,r1,r2,r3,ip,lr}; b #${privateCanvasFrame}`;
    canvasEntry=patch.append(a=>assembleWords(text,a),16);symbols.private_before_canvas=canvasEntry;
    regions.push({name:'private_before_canvas',address:canvasEntry,length:assembleWords(text,canvasEntry).length*4,purpose:'Scoped controller layout preparation inside native display lock; original registers and flags restored'});
  }
  const privateControllerFrame = relocate('private_controller_frame', adr(0x5318480c), byRelease({'1.20': [
    0xe1a0c00d,0xe92ddbf0,0xe24cb004,0xe1a08000,0xeb02efa0,0xeb02f08c,0xe1a07000,0xeb03962d,
    0xe2501000,0x1a00002a,0xe5d8914e,0xe1a05008,0xe2886e12,0xe1a04008,0xe5943004,0xe2844030,
    0xe2530000,0x0a000002,0xeb103254,0xe3500000,0x1a000003,0xe1540006,0x1afffff6,0xe3590000,
    0x089dabf0,0xe1a00008,0xebffffb0,0xe5959004,0xe1a00007,0xe5d54008,0xe3590000,0xe1a01004,
    0x0a00000b,0xe5d52009,0xeb0395e9,0xe3500000,0xe1a01004,0xe1a00007,0x0a000005,0xeb03964d,
    0xe1a00009,0xeb1031fd,0xe1a00007,0xe1a01004,0xeb039652,0xe2855030,0xe1560005,0x1affffea,
    0xe1a00008,0xebffff57,0xe3a03000,0xe5c8314e,0xe89dabf0,0xe1a00007,0xe24bd024,0xe89d6bf0,
    0xea03960d
  ], '1.21': [
    0xe1a0c00d,0xe92ddbf0,0xe24cb004,0xe1a08000,0xeb02f122,0xeb02f20e,0xe1a07000,0xeb039841,
    0xe2501000,0x1a00002a,0xe5d8914e,0xe1a05008,0xe2886e12,0xe1a04008,0xe5943004,0xe2844030,
    0xe2530000,0x0a000002,0xeb10349e,0xe3500000,0x1a000003,0xe1540006,0x1afffff6,0xe3590000,
    0x089dabf0,0xe1a00008,0xebffffb0,0xe5959004,0xe1a00007,0xe5d54008,0xe3590000,0xe1a01004,
    0x0a00000b,0xe5d52009,0xeb0397fd,0xe3500000,0xe1a01004,0xe1a00007,0x0a000005,0xeb039861,
    0xe1a00009,0xeb103447,0xe1a00007,0xe1a01004,0xeb039866,0xe2855030,0xe1560005,0x1affffea,
    0xe1a00008,0xebffff57,0xe3a03000,0xe5c8314e,0xe89dabf0,0xe1a00007,0xe24bd024,0xe89d6bf0,
    0xea039821
  ]}), { [adr(0x531848b0)]: canvasEntry });
  return { controllerFrame: privateControllerFrame, canvasFrame: privateCanvasFrame, symbols, regions };
}
