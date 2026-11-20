// SPDX-License-Identifier: GPL-2.0-only
/**
 * A learned auto white balance (GR IV 1.20 and 1.21; tools/gr4v120/awb2: README.md, awb2.c, golden.py).
 *
 * One estimator and one state for the three Auto modes (Auto, Warmth Priority, White Priority). The estimate is a learned
 * illuminant model (two log-chroma histograms, two learned filters, brightness-dependent priors, softmax: the FFCC family),
 * trained on public data sets with measured illuminants and computed in integers. Live view filters the single-frame
 * estimates; a still takes the live view state, so the picture has the white balance the screen showed, unless its own
 * estimate is far from it (another scene) or there is no state. The modes share the estimate and differ only in how much of a
 * warm light's colour is deliberately left: none in White Priority, a little in Auto, more in Warmth Priority, nothing in any
 * mode at and beyond daylight. A picture taken with the flash keeps the camera's own result; so do the preset and manual modes.
 *
 * The hook: the Auto estimate 0x53960b8c (vtable 0x54252890 slot 2; only the white balance manager's Auto object reaches it)
 * keeps the object in r4, the settings block S in r5 and its third argument (0 in live view, the capture record for a still)
 * in r7, and calls the final stage 0x539609d4(object, accumulators) at 0x53960e90. That call is replaced by a stub which makes
 * the same call and then calls the module with (ctx, r4, r5, r7): the camera's own result is computed first and stays where the
 * module writes nothing.
 *
 * Memory: the module and its tables are appended; its state (two work areas, about 130 KB) is one operator-new allocation
 * (0x539084bc) made on the first call, its pointer in AWB_STATE_WORD: a word of the C library's sbrk arena before the heap,
 * which nothing in the firmware calls (`battery.ts`), cleared at start-up by `extendBatteryZeroFill` (build.ts runs it for
 * this option as for the battery percentage).
 *
 * The flash: the flash data manager's pointer 0x5537e7c0 (+0x10 of the static object 0x5537e7b0 its getter 0x53797a30 returns)
 * and the shooting sequence controller's "still waiting for the flash charge" byte 0x550b896c (static object 0x550b8848,
 * +0x124; set in the release sequence before the exposure) are passed in the context: flash type not 0 and that byte 0 means
 * the main flash fires, and the picture keeps the camera's result.
 *
 * GR IV 1.20 and 1.21 (not 1.11). 1.21 runs this through its address table: the Auto estimate, its final stage and the code
 * around the hooked call are the same there, moved. The addresses are looked up (adr) when the option is installed.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget } from './arm';
import { Patch, expectWord, u32le } from './build';
import { AWB2_CODE, AWB2_CODE_LENGTH, AWB2_MAGIC, AWB2_DATA, AWB2_DATA_LENGTH, AWB2_OFFSETS } from './awb2-code';
import { extendZeroFill } from './lookstash';
import { adr } from '../target';

/** The places the module relies on (addresses of this program's release). */
function places() {
  return {
    sToR5: adr(0x53960ba4), // mov r5, r1
    thisToR4: adr(0x53960bb0), // mov r4, r0
    arg3ToR7: adr(0x53960bb8), // mov r7, r2
    finalCall: adr(0x53960e90), // bl final stage
    finalStage: adr(0x539609d4),
    alloc: adr(0x539084bc),
    /** The state pointer: a word of the sbrk arena (0x55839040 .. 0x55839080, see battery.ts); the battery percentage keeps the first. */
    slot: adr(0x55839078),
    flashManager: adr(0x5537e7c0),
    seqWaiting: adr(0x550b896c),
  };
}

/** The state pointer's RAM word. */
export function awbLearnSlot(): number {
  return places().slot;
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export interface AwbLearnLayout {
  stub: number;
  code: number;
  ctx: number;
  data: number;
}

/** The hooked word (for tests). */
export function awbLearnSite(): number {
  return places().finalCall;
}

/** The learned auto white balance (option awbLearn). */
export function installAwbLearn(p: Patch): AwbLearnLayout {
  const a = places();
  expectWord(p, a.sToR5, 0xe1a05001);
  expectWord(p, a.thisToR4, 0xe1a04000);
  expectWord(p, a.arg3ToR7, 0xe1a07002);
  expectWord(p, a.finalCall - 8, 0xe1a00004); // mov r0, r4
  expectWord(p, a.finalCall - 4, 0xe24b1038); // sub r1, fp, #0x38
  const call = p.word(a.finalCall);
  if (call >>> 24 !== 0xeb || branchTarget(a.finalCall, call) !== a.finalStage) throw new FirmwareError('unexpected-layout', 'auto WB: unexpected call of the final stage');
  // The other additions expect the zero fill at 0x55839040 (or its official end); build.ts extends it over the sbrk arena last.
  extendZeroFill(p);
  const module = unbase64(AWB2_CODE);
  const data = unbase64(AWB2_DATA);
  if (module.length !== AWB2_CODE_LENGTH || data.length !== AWB2_DATA_LENGTH) throw new FirmwareError('internal', 'auto WB: embedded module length');
  // struct awb2_ctx: magic, alloc, slot, the nine tables, the flash manager's word, the sequence controller's byte.
  const ctx = p.append(u32le([AWB2_MAGIC, a.alloc, a.slot, ...AWB2_OFFSETS.map(() => 0), a.flashManager, a.seqWaiting]), 16);
  const code = p.append(module, 16);
  const stub = p.append((at) => assembleWords(
    `push {r4-r6,lr}
     bl #${a.finalStage}
     movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}
     mov r1,r4
     mov r2,r5
     mov r3,r7
     bl #${code}
     pop {r4-r6,pc}`, at), 16);
  const tables = p.append(data, 16);
  AWB2_OFFSETS.forEach((off, k) => p.setWord(ctx + 12 + 4 * k, tables + off, `auto WB: table ${k}`));
  p.setWord(a.finalCall, (0xeb000000 | (((stub - (a.finalCall + 8)) >> 2) & 0xffffff)) >>> 0, 'auto WB: the learned estimate after the final stage');
  return { stub, code, ctx, data: tables };
}
