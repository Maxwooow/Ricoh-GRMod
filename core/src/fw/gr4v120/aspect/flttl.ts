// SPDX-License-Identifier: GPL-2.0-only
/**
 * Pre-flash (TTL) metering for a GF-2 class flash (GR IV 1.20 and 1.21; tools/gr4v120/flash/ttl: README.md, flttl.c).
 *
 * By itself the camera sets the GF-2's output from the focus distance. In the two flash modes with red-eye reduction it
 * also fires a small emission before the picture. With this option the live view frame that catches that emission is
 * compared with the frame before it, and the result replaces the distance in the camera's own output formula; when the
 * comparison is not usable the distance stays. The other two flash modes and the manual output are not touched.
 *
 * Six hooks, each a `bl` replaced by a `bl` to a stub that calls the module:
 *  - 0x5368b3d0 `bl 0x536918c0`: after the per-frame live view AE the module gets the live view exposure object.
 *  - 0x53797070 `bl 0x537964f8`: right before the pre-emission pulse.
 *  - 0x5368774c `bl 0x53684ca4`: the release plan's "free live view" step starts 150 ms later in the red-eye modes with
 *    a GF-2 class flash, so that the frame with the pre-emission still arrives.
 *  - 0x53a9b70c `bl 0x537986e0`: for 600 ms after a pre-emission the flash's "not ready" (it recharges) is not stored,
 *    or the camera cancels the picture's flash.
 *  - 0x536a5198, in the GF-2 output level calculation 0x536a50b8 (auto branch): `bl 0x5369ceb8`, which returns
 *    X = Dv + Av - (Sv - 5) + compensation in s0; the level is then 8 X + 52, limited to the flash's range. The stub makes
 *    the call, hands X (as bits) and the calculation object to the module, and returns what the module returns in s0.
 *    The manual output branch does not come here.
 *  - 0x536a562c, where the flash data for a GF-2 class flash is filled (0x536a5610): `bl 0x536a3a04` stores the output
 *    level (r1); two instructions earlier the level is 0x40 for state 0xA, the red-eye pre-emission (r7 is the state). The
 *    stub passes level and state through the module: near subjects get a weaker pre-emission, so the frame does not clip.
 * The first four were run on the camera in a probe build before the metering itself (the red-eye modes still fire their
 * main flash with them); all six are in the builds of the camera rounds in README.md.
 *
 * State: one operator-new allocation (on the first live view frame with a GF-2 class flash attached), its
 * pointer in FLTTL_SLOT, the second word of the HDR gain map's test counters (`hdrgain.ts`, HDR_COUNTERS + 4; zero at
 * start-up once the start-up zero fill reaches 0x55839040). `build.ts` refuses this option together with those test
 * counters.
 *
 * The module can write its record of each shot (644 bytes, struct log in flttl.c) to the card; this build gives it no file
 * service (the `file_holder` native is a stub that returns 0), so nothing is written. The record is still kept in RAM.
 *
 * GR IV 1.20 and 1.21 (not 1.11). 1.21 runs this through its address table: the hooked calls, their targets and the code
 * around them are the same there, moved, with only branches and movw/movt address constants relocated; the struct offsets the
 * module reads are those of the same instructions. The addresses are looked up (adr) when the option is installed.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget } from './arm';
import { Patch, expectWord, u32le } from './build';
import { FLTTL_CODE, FLTTL_CODE_LENGTH } from './flttl-code';
import { extendZeroFill } from './lookstash';
import { adr } from '../target';

export const FLTTL_MAGIC = 0x4c54464c; // "LFTL"
const VMOV_R2_S0 = 0xee102a10;
const VMOV_S0_R0 = 0xee000a10;

/** The places the module relies on (addresses of this program's release). */
function places() {
  return {
    frameCall: adr(0x5368b3d0),
    frameAe: adr(0x536918c0),
    pulseCall: adr(0x53797070),
    pulse: adr(0x537964f8),
    freeStepCall: adr(0x5368774c),
    addStep: adr(0x53684ca4),
    statusCall: adr(0x53a9b70c),
    statusSet: adr(0x537986e0),
    xCall: adr(0x536a5198),
    xFn: adr(0x5369ceb8),
    levelCall: adr(0x536a562c),
    levelSet: adr(0x536a3a04),
    /** The state pointer: the second HDR test counter (`hdrgain.ts`, HDR_COUNTERS + 4). */
    slot: adr(0x55839018),
    /** struct ctx in flttl.c: alloc, timer holder, tick, elapsed, flash holder, (file holder: a stub), AE holder, settings holder, flash mode. */
    alloc: adr(0x539084bc),
    timerHolder: adr(0x53919d68),
    tick: adr(0x5391ca64),
    elapsed: adr(0x5391ca74),
    flashHolder: adr(0x53797a30),
    aeHolder: adr(0x536ac0b8),
    settingsHolder: adr(0x53750008),
    flashMode: adr(0x5377ccc4),
  };
}

/** The state pointer's RAM word. */
export function flashTtlSlot(): number {
  return places().slot;
}

export function flashTtlModule(): Uint8Array {
  const module = Uint8Array.from(atob(FLTTL_CODE), (c) => c.charCodeAt(0));
  if (module.length !== FLTTL_CODE_LENGTH) throw new FirmwareError('internal', 'flash TTL: embedded module length');
  return module;
}

function callTo(p: Patch, at: number, target: number, what: string): void {
  const word = p.word(at);
  if (word >>> 24 !== 0xeb || branchTarget(at, word) !== target) throw new FirmwareError('unexpected-layout', `flash TTL: unexpected ${what}`);
}

export interface FlashTtlLayout {
  ctx: number;
  code: number;
  noFiles: number;
  frameStub: number;
  pulseStub: number;
  delayStub: number;
  statusStub: number;
  xStub: number;
  levelStub: number;
}

/** The six hooked words (for tests). */
export function flashTtlSites(): number[] {
  const a = places();
  return [a.frameCall, a.pulseCall, a.freeStepCall, a.statusCall, a.xCall, a.levelCall];
}

/** Pre-flash metering for a GF-2 class flash (option flashTtl). */
export function installFlashTtl(p: Patch): FlashTtlLayout {
  const a = places();
  expectWord(p, a.frameCall - 4, 0xe5940034); // ldr r0, [r4, #0x34]
  callTo(p, a.frameCall, a.frameAe, 'live view AE call');
  expectWord(p, a.frameCall + 4, 0xe5940040); // ldr r0, [r4, #0x40]
  expectWord(p, a.pulseCall - 4, 0xe1a00005); // mov r0, r5
  callTo(p, a.pulseCall, a.pulse, 'pre-emission call');
  expectWord(p, a.freeStepCall - 4, 0xe3a03fc3); // mov r3, #0x30c
  expectWord(p, a.freeStepCall - 0x20, 0xe58d4000); // str r4, [sp]: the delay, 0
  callTo(p, a.freeStepCall, a.addStep, 'add-step call');
  expectWord(p, a.statusCall - 8, 0xe55b1024); // ldrb r1, [fp, #-0x24]
  expectWord(p, a.statusCall - 4, 0xe55b2023); // ldrb r2, [fp, #-0x23]
  callTo(p, a.statusCall, a.statusSet, 'status setter call');
  expectWord(p, a.xCall - 4, 0xe595001c); // ldr r0, [r5, #0x1c]
  callTo(p, a.xCall, a.xFn, 'flash level formula call');
  expectWord(p, a.xCall + 4, 0xeeb27a00); // vmov.f32 s14, #8.0
  expectWord(p, a.levelCall - 0x10, 0xe357000a); // cmp r7, #0xa
  expectWord(p, a.levelCall - 0xc, 0x11a01000); // movne r1, r0
  expectWord(p, a.levelCall - 8, 0x03a01040); // moveq r1, #0x40
  expectWord(p, a.levelCall - 4, 0xe5950024); // ldr r0, [r5, #0x24]
  callTo(p, a.levelCall, a.levelSet, 'output level setter call');
  extendZeroFill(p);
  const module = flashTtlModule();
  // ctx word 7 (`file_holder`) is set below to a stub that returns 0: no file service, the record stays in RAM.
  const ctx = p.append(u32le([FLTTL_MAGIC, a.slot, a.alloc, a.timerHolder, a.tick, a.elapsed, a.flashHolder, 0, a.aeHolder, a.settingsHolder, a.flashMode]), 16);
  const code = p.append(module, 16);
  const loadCtx = `movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}`;
  const frameStub = p.append((at) => assembleWords(
    `push {r4,lr}
     bl #${a.frameAe}
     ${loadCtx}
     mov r1,#0
     ldr r2,[r4,#0x34]
     bl #${code}
     pop {r4,pc}`, at), 16);
  const pulseStub = p.append((at) => assembleWords(
    `push {r0-r2,lr}
     ${loadCtx}
     mov r1,#1
     mov r2,#0
     bl #${code}
     pop {r0-r2,lr}
     b #${a.pulse}`, at), 16);
  const delayStub = p.append((at) => assembleWords(
    `push {r0-r3,r12,lr}
     ${loadCtx}
     mov r1,#2
     mov r2,#0
     bl #${code}
     str r0,[sp,#24]
     pop {r0-r3,r12,lr}
     b #${a.addStep}`, at), 16);
  const statusStub = p.append((at) => assembleWords(
    `push {r0-r3,r12,lr}
     ${loadCtx}
     mov r2,r1
     mov r1,#3
     bl #${code}
     str r0,[sp,#4]
     pop {r0-r3,r12,lr}
     b #${a.statusSet}`, at), 16);
  // X comes back in s0 and goes on in s0; the module is soft float, so it travels as bits in r2 / r0.
  const xStub = p.append((at) => [
    ...assembleWords(
      `push {r4,lr}
       mov r4,r0
       bl #${a.xFn}`, at),
    VMOV_R2_S0,
    ...assembleWords(
      `mov r3,r4
       ${loadCtx}
       mov r1,#4
       bl #${code}`, at + 16),
    VMOV_S0_R0,
    ...assembleWords('pop {r4,pc}', at + 40),
  ], 16);
  const levelStub = p.append((at) => assembleWords(
    `push {r0-r3,r12,lr}
     ${loadCtx}
     mov r2,r1
     mov r3,r7
     mov r1,#5
     bl #${code}
     str r0,[sp,#4]
     pop {r0-r3,r12,lr}
     b #${a.levelSet}`, at), 16);
  const noFiles = p.append((at) => assembleWords('mov r0,#0;bx lr', at), 16);
  p.setWord(ctx + 28, noFiles, 'flash TTL: no file service (the record of each shot is not written to the card)');
  const bl = (at: number, to: number) => (0xeb000000 | (((to - (at + 8)) >> 2) & 0xffffff)) >>> 0;
  p.setWord(a.frameCall, bl(a.frameCall, frameStub), 'flash TTL: look at the frame after the live view AE');
  p.setWord(a.pulseCall, bl(a.pulseCall, pulseStub), 'flash TTL: stamp the pre-emission');
  p.setWord(a.freeStepCall, bl(a.freeStepCall, delayStub), 'flash TTL: live view stays 150 ms after the pre-emission');
  p.setWord(a.statusCall, bl(a.statusCall, statusStub), 'flash TTL: the flash stays "ready" for 600 ms after the pre-emission');
  p.setWord(a.xCall, bl(a.xCall, xStub), 'flash TTL: the pre-flash result replaces the distance in the output formula');
  p.setWord(a.levelCall, bl(a.levelCall, levelStub), 'flash TTL: weaker pre-emission for near subjects');
  return { ctx, code, noFiles, frameStub, pulseStub, delayStub, statusStub, xStub, levelStub };
}
