// SPDX-License-Identifier: GPL-2.0-only
/** Function-level research patches. This module is deliberately absent from the public
 * Engine/API: it emits a guarded patch manifest, never a camera update container.
 * New IDs are only valid in the probed functions; menu, ISP and persisted settings remain unported. */
import { assembleWords, branchWord, encodeImmediate, wordsToBytes } from '../aspect/arm';
import { alignedCrop, parseRatio } from '../aspect/geometry';
import { FirmwareError } from '../types';
import { GR3X_160, openGr3xOfficial } from './profile';
import { GR3X_T4_MENU, checkGr3xMenu, gr3xCustoms, gr3xMaxId, gr3xWide } from './geometry';
import type { Gr3xMenuRatio } from './geometry';

/** `mov` where the value encodes as a modified immediate (all T4 values do), else `movw`. */
export const gr3xImm = (reg: string, value: number) => `${encodeImmediate(value) === null ? 'movw' : 'mov'} ${reg},#${value}`;
const BASE = GR3X_160.rtosBase;
const DIMENSION_ENTRY = 0x536a2a30;
// Keep the PC-relative VFP literal load at the original entry; replace the following MOV.
const DIMENSION_HOOK = DIMENSION_ENTRY + 4;
const PREVIEW_ENTRY = 0x5366632c;
const PREVIEW_SETUP = 0x5366634c;
const PREVIEW_RELEASE = 0x53666500;
const UDIV = 0x5313d850;
const ASPECT_GETTER = 0x53245260;
const ASPECT_SETTER = 0x532525a4;
const APPEND = BASE + GR3X_160.rtosLength;
const GUARDS = [
  [DIMENSION_ENTRY, 'f87adfed0dc0a0e1f0db2de9124f6fe1'],
  [PREVIEW_ENTRY, '0dc0a0e1f0df2de904b04ce22cd04de2'],
  [PREVIEW_SETUP, '36feffeb000055e3'],
  [PREVIEW_RELEASE, '920d84e23c0080e2'],
  [UDIV, '000051e30100000a10f130e71eff2fe1'],
  [ASPECT_GETTER, '043090e5c204d3e51eff2fe1043090e5'],
  [ASPECT_SETTER, '043090e50dc0a0e130d82de904b04ce2'],
] as const;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

function additionsOf(menu: readonly Gr3xMenuRatio[]) {
  return gr3xCustoms(menu).map(({ ratio, id, n, d }) => {
    const screen = alignedCrop(720, 480, parseRatio(ratio))!;
    const wide = gr3xWide({ n, d });
    const span = wide ? screen.height : screen.width;
    const full = wide ? 480 : 720;
    const divisor = gcd(span, full);
    return { ratio, id, n, d, wide, screen, factor: [span / divisor, full / divisor] };
  });
}
type Additions = ReturnType<typeof additionsOf>;

function dimensionAssembly(additions: Additions, max: number): string {
  return `
    cmp r2,#4; blo original; cmp r2,#${max}; bhi original
    push {r4-r8,lr}
    mov r4,r3; ldr r5,[sp,#24]; mov r6,r2
    sub sp,sp,#8; str r5,[sp]; mov r2,#0
    bl #${DIMENSION_ENTRY}; add sp,sp,#8; mov r8,r0
    ${additions.map(a => `cmp r6,#${a.id}; beq ratio_${a.id}`).join('\n')}
    b finish
    ${additions.map(a => `ratio_${a.id}:
      ldrh r0,[${a.wide ? 'r4' : 'r5'}]
      ${a.wide ? '' : 'mov r5,r4'}
      ${gr3xImm('r6', a.wide ? a.d : a.n)}; ${gr3xImm('r7', a.wide ? a.n : a.d)}
      b crop`).join('\n')}
    crop:
    mul r0,r0,r6; add r0,r0,r7,lsl #1; mov r1,r7,lsl #2
    bl #${UDIV}; mov r0,r0,lsl #2; strh r0,[r5]
    finish: mov r0,r8; pop {r4-r8,pc}
    original: mov ip,sp; b #${DIMENSION_HOOK + 4}
  `;
}

// FP-0x4c is unused inside the original 0x2c-byte local frame, next to FP-0x48.
// Record the ID for this invocation and use the native full-frame path for additions.
function previewSetupAssembly(max: number): string {
  return `
    str r7,[fp,#-0x4c]; cmp r7,#4; blo original; cmp r7,#${max}; movls r7,#0
    original: bl #0x53665c2c; b #${PREVIEW_SETUP + 4}
  `;
}

// This runs at the epilogue join, before the original mutex release. Rectangle scaling
// uses 64-bit multiplication/division to keep Q16 products exact.
function previewAssembly(additions: Additions, max: number): string {
  return `
    push {r4-r8,lr}; ldr r5,[fp,#-0x4c]
    cmp r5,#4; blo finish; cmp r5,#${max}; bhi finish
    ${additions.map(a => `cmp r5,#${a.id}; beq ratio_${a.id}`).join('\n')}
    b finish
    ${additions.map(a => `ratio_${a.id}:
      add r5,r4,#${a.wide ? 40 : 36}
      ${gr3xImm('r6', a.factor[0])}; ${gr3xImm('r7', a.factor[1])}; b apply`).join('\n')}
    apply:
    mov r0,r5; mov r1,r6; mov r2,r7; bl rect
    add r0,r5,#16; mov r1,r6; mov r2,r7; bl rect
    finish: pop {r4-r8,lr}; add r0,r4,#0x2480; b #${PREVIEW_RELEASE + 4}
    rect:
    push {r4-r6,lr}; mov r4,r0; ldr r5,[r4]
    mov r6,r2; umull r0,r3,r5,r1; mov r1,r3; mov r2,r6; mov r3,#0
    bl #0x5313db54
    str r0,[r4]; sub r0,r5,r0; add r0,r0,#1; mov r0,r0,lsr #1
    ldr r1,[r4,#8]; add r0,r1,r0; str r0,[r4,#8]; pop {r4-r6,pc}
  `;
}

/** Isolated directed step, called only by the probe. Direction 1 advances, 0 reverses.
 * It executes the original getter/setter notification chain. It is not installed as a
 * rear-dial hook until the physical control and every context gate are verified. */
function cycleAssembly(ids: readonly number[]): string {
  const n = ids.length;
  return `
    cmp r1,#1; bhi invalid
    push {r4-r8,lr}; mov r4,r0; mov r5,r1; bl #${ASPECT_GETTER}
    ${ids.map((id, i) => `cmp r0,#${id}; beq slot_${i}`).join('\n')}
    mov r0,#0; pop {r4-r8,pc}
    ${ids.map((_, i) => `slot_${i}:
      cmp r5,#0; moveq r1,#${ids[(i + n - 1) % n]}; movne r1,#${ids[(i + 1) % n]}; b set`).join('\n')}
    set: mov r0,r4; bl #${ASPECT_SETTER}; pop {r4-r8,pc}
    invalid: mov r0,#0; bx lr
  `;
}

export async function buildGr3xExperiment(raw: Uint8Array, ratioMenu: readonly Gr3xMenuRatio[] = GR3X_T4_MENU) {
  const menu = checkGr3xMenu(ratioMenu);
  const additions = additionsOf(menu), max = gr3xMaxId(menu);
  const { decoded, profile } = await openGr3xOfficial(raw);
  const rtos = decoded.subarray(GR3X_160.rtosOffset, GR3X_160.rtosOffset + GR3X_160.rtosLength);
  for (const [at, expected] of GUARDS) {
    if (hex(rtos.subarray(at - BASE, at - BASE + expected.length / 2)) !== expected) {
      throw new FirmwareError('unexpected-instruction', `GR IIIx experimental guard failed at ${at.toString(16)}`);
    }
  }
  const dimensions = wordsToBytes(assembleWords(dimensionAssembly(additions, max), APPEND));
  const setupAt = APPEND + dimensions.length;
  const setup = wordsToBytes(assembleWords(previewSetupAssembly(max), setupAt));
  const previewAt = setupAt + setup.length;
  const preview = wordsToBytes(assembleWords(previewAssembly(additions, max), previewAt));
  const directedCycle = previewAt + preview.length;
  const cycle = wordsToBytes(assembleWords(cycleAssembly(menu.map(r => r.id)), directedCycle));
  const payload = new Uint8Array(dimensions.length + setup.length + preview.length + cycle.length);
  payload.set(dimensions); payload.set(setup, dimensions.length);
  payload.set(preview, dimensions.length + setup.length);
  payload.set(cycle, dimensions.length + setup.length + preview.length);
  // This checks the probe mapping only. No claim is made about camera loader allocation.
  const pageSlack = Math.ceil(rtos.length / 4096) * 4096 - rtos.length;
  if (payload.length > pageSlack) throw new FirmwareError('probe-capacity', 'Experiment exceeds the original RTOS final probe page');
  const sites = [[DIMENSION_HOOK, APPEND], [PREVIEW_SETUP, setupAt], [PREVIEW_RELEASE, previewAt]].map(([address, target]) => ({
    address, expected: hex(rtos.subarray(address - BASE, address - BASE + 4)),
    replacement: hex(wordsToBytes([branchWord(address, target)])),
  }));
  return {
    schema: 1, kind: 'gr3x-function-experiment' as const,
    profile: profile.id, originalRtosSha256: profile.rtosSha256,
    originalLength: rtos.length, base: BASE, sites,
    append: { address: APPEND, bytes: hex(payload) },
    entries: { directedCycle },
    ratios: menu.map(({ ratio, id }) => ({ ratio, id })),
    menu: menu.map(r => ({ ...r })),
    firmwareGenerated: false, hardwareTested: false, rearDialPatched: false,
    scope: 'Dimensions, both preview rectangles, native DNG crop window. No ISP/JPEG/RAW serialization/menu/settings/playback/update loader.',
  };
}
