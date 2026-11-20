// SPDX-License-Identifier: GPL-2.0-only
/**
 * A learned Auto for Shadow Correction (GR IV / HDF / Monochrome, firmware 1.11; the 1.20 port in fw/gr4v120). Off unless
 * asked for (`shadowLearn`).
 *
 * What Auto now does: a learned estimate of how much the median of five professional retouchers (MIT-Adobe FiveK, 975 images)
 * would lift the shadows of the scene. The model (100 gradient-boosted trees, `tools/shadowml/model/model_final.bin`, embedded
 * as `shadowml-data.ts`) sees relative-brightness features only: log2 percentiles of the block luminance (the green plane of the
 * AWB's block statistics), the share of blocks 1..5 stops below the median, near-clipped blocks, centre against border, the
 * ISO index, the mode, the R/G and B/G colour cast. Its output t = 0 .. 0x800 is still capped by the camera's own ISO limiter.
 * On held-out images the regret is 0.0256, against 0.0310 for applying no lift and 0.0334 for the camera's own Auto rule computed
 * on non-wrapped data. The camera's own Auto computes 0 on real shots: the shadow-correction core (ToneControlTuning,
 * 0x5391F230) takes the strength from a histogram of a block-luminance array (sb[0x54] == 0) whose block sums wrap at 16 bits.
 * The module of `tools/shadowml/shadowml.c` (integer only, bit-exact with `tools/shadowml/ref.py`) replaces that decision. The
 * model is data: a new blob (`gen.py [model.bin]`) needs no new code.
 *
 * Hook (0x5391F3A4, directly after the call of the Y-array builder 0x538F75FC; the live-view call at 0x5391F800 branches back
 * to the same word, so both paths pass it): the instruction `ldr r2,[fp,#-0x450]` is replaced by a branch to a stub that
 *   - keeps the camera's forced-zero cases (sb[0x8A] or sb[0x8B] set: branch to 0x5391F784, the stock zero path),
 *   - calls `shadowml(ctx, P = sl, mode = sb[0x8D], hl = [fp-0x438], idx = r7)` with the stack 8-byte aligned,
 *   - on a negative result continues at the stock zero path 0x5391F784,
 *   - otherwise continues at 0x5391F4D8 with r3 = t and r7 = 1, exactly where the camera's own Auto joins its common code:
 *     strength = (min(t, ISO cap) * gain) >> 11, the live-view five-frame smoothing, the level thresholds and the gain table.
 * The fixed levels (Low / Medium / High / Off) jump from 0x5391F334 to 0x5391F4E8 and never reach this word.
 *
 * Auto's gain (TB[4] at 0x5404938C, used by Auto only) goes from 0x100 to 0x400, so that Auto can reach High:
 * strength = min(t, cap) / 2, t = 2 * strength (the gain of Low is 0x100, of High 0x400, of the old Auto 0x100).
 *
 * Live view / movie (mode 1, 2) run the core on every frame: the module computes on every 4th call and holds the result in
 * between (one RAM word, SHADOWML_SLOT, below the heap; zero at start-up). Stills (mode 0, 3) always compute and never touch it.
 *
 * Working memory: one operator-new allocation (two disjoint halves, stills and live view, 776 bytes each; its pointer in the free
 * RAM word SHADOWML_SCRATCH_SLOT, zero at start-up) keeps the module's stack at about 300 bytes. If the allocation fails the
 * call gives the camera's no-correction result and the next one retries.
 *
 * Layout: the context, the module, the stub and the model blob are appended after everything else, so every other addition
 * keeps its place without this one. The state word is in the free RAM words before the heap at
 * 0x55837300; the start-up zero fill (the literal at 0x53000460) is extended to 0x55837300 if it is not already. The two words
 * (SHADOWML_SLOT, SHADOWML_SCRATCH_SLOT) are otherwise used only by test builds (Direct Flash / halation diagnostics and the HDR
 * gain map's counters), which `build.ts` refuses together with this.
 *
 * Every address is looked up (`adr`) when the module is installed, not when this file loads. GR IV 1.21 runs the 1.20 port through
 * its address table (tools/port/gr4-121-map.json): the core is the same code there, moved, with only its address constants relocated.
 */
import { FirmwareError } from '../types';
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord, u32le } from './build';
import { SHADOWML_CODE, SHADOWML_CODE_LENGTH, SHADOWML_MAGIC } from './shadowml-code';
import { SHADOWML_DATA, SHADOWML_DATA_LENGTH } from './shadowml-data';
import { adr } from '../target';

/** The hook word and the places around it that the stub relies on (addresses of this program's release). */
function places() {
  return {
    hook: adr(0x5391f3a4),
    callYBuilder: adr(0x5391f3a0), // bl Y-array builder (stills / RAW)
    yBuilder: adr(0x538f75fc),
    lvCall: adr(0x5391f800), // the live-view call of the same builder, followed by b hook
    lvBack: adr(0x5391f804),
    common: adr(0x5391f4d8), // ldrb r5,[sb,#0x8D]: where Auto joins the common code with r3 = t, r7 = 1
    zeroPath: adr(0x5391f784), // the stock forced-zero path
    autoOne: adr(0x5391f448), // mov r7,#1
    levelLoad: adr(0x5391f4f0), // ldr r2,[fp,#-0x448]
    saveSb: adr(0x5391f240), // mov sb,r3
    modeLoad: adr(0x5391f258), // ldrb ip,[r3,#0x8D]
    modeCmp: adr(0x5391f508), // cmp r5,#1
    /** Auto's gain table entry (TB[4]). */
    gain: adr(0x5404938c),
    /** The throttling state word and the scratch pointer (free RAM before the heap; zeroed at start-up). */
    slot: adr(0x558372fc),
    scratchSlot: adr(0x558372d4),
    /** The firmware's operator new (the module calls it once). */
    alloc: adr(0x538e09b0),
    /** Literal: end of the start-up zero fill, and the heap start that it is extended to. */
    zeroFillEnd: adr(0x53000460),
    zeroFillOld: adr(0x558372d4),
    heap: adr(0x55837300),
  };
}

/** The hook word (for tests). */
export const shadowmlHook = (): number => places().hook;
/** The two RAM words the module keeps (for tests): the live-view throttling state and the scratch pointer. */
export const shadowmlWords = (): { slot: number; scratch: number } => { const a = places(); return { slot: a.slot, scratch: a.scratchSlot }; };
/** Auto's gain (TB[4]) and its values. */
export const shadowmlGain = (): number => places().gain;
export const SHADOWML_GAIN_OLD = 0x100;
export const SHADOWML_GAIN_NEW = 0x400;
/** Live view / movie: compute on every this-many-th call. */
export const SHADOWML_PERIOD = 4;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function shadowmlModule(): Uint8Array {
  const raw = unbase64(SHADOWML_CODE);
  if (raw.length !== SHADOWML_CODE_LENGTH) fail('internal', 'learned shadow correction module: length');
  return raw;
}

export function shadowmlData(): Uint8Array {
  const raw = unbase64(SHADOWML_DATA);
  if (raw.length !== SHADOWML_DATA_LENGTH) fail('internal', 'learned shadow correction model: length');
  return raw;
}

/** What `installShadowLearn` appended (for tests). */
export interface ShadowLearnLayout {
  ctx: number;
  code: number;
  stub: number;
  blob: number;
}

/** The learned Auto for Shadow Correction. */
export function installShadowLearn(p: Patch, options: { model?: Uint8Array } = {}): ShadowLearnLayout {
  const a = places();
  // The words the hook and the stub rely on.
  expectWord(p, a.callYBuilder, branchWord(a.callYBuilder, a.yBuilder, 14, true)); // bl Y-array builder
  expectWord(p, a.hook, 0xe51b2450); // ldr r2,[fp,#-0x450]
  expectWord(p, a.common, 0xe5d9508d); // ldrb r5,[sb,#0x8D]
  expectWord(p, a.zeroPath, 0xe5d9508d); // ldrb r5,[sb,#0x8D]
  expectWord(p, a.autoOne, 0xe3a07001); // mov r7,#1
  expectWord(p, a.levelLoad, 0xe51b2448); // ldr r2,[fp,#-0x448]
  expectWord(p, a.lvCall, branchWord(a.lvCall, a.yBuilder, 14, true)); // bl Y-array builder (live view)
  expectWord(p, a.lvBack, branchWord(a.lvBack, a.hook)); // b hook
  expectWord(p, a.saveSb, 0xe1a09003); // mov sb,r3
  expectWord(p, a.modeLoad, 0xe5d3c08d); // ldrb ip,[r3,#0x8D]
  expectWord(p, a.modeCmp, 0xe3550001); // cmp r5,#1
  if (p.word(a.gain) !== SHADOWML_GAIN_OLD) fail('unexpected-layout', 'learned shadow correction: the gain table is not the official one');
  if (p.word(a.zeroFillEnd) !== a.heap) {
    expectWord(p, a.zeroFillEnd, a.zeroFillOld);
    p.setWord(a.zeroFillEnd, a.heap, 'start-up zero fill also clears the 44 unused bytes before the heap');
  }
  const module = shadowmlModule();
  const blob = options.model ?? shadowmlData();
  const ctx = p.append(u32le([SHADOWML_MAGIC, 0, blob.length, SHADOWML_PERIOD, a.slot, a.alloc, a.scratchSlot]), 16);
  const code = p.append(module, 16);
  const stub = p.append((at) => assembleWords(
    `ldrb r0,[r9,#0x8a]
     ldrb r1,[r9,#0x8b]
     orrs r0,r0,r1
     bne #${a.zeroPath}
     mov r4,sp
     bic sp,sp,#7
     sub sp,sp,#8
     str r7,[sp]
     movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}
     mov r1,r10
     ldrb r2,[r9,#0x8d]
     ldr r3,[fp,#-0x438]
     bl #${code}
     mov sp,r4
     cmp r0,#0
     blt #${a.zeroPath}
     mov r3,r0
     mov r7,#1
     b #${a.common}`, at), 16);
  const data = p.append(blob, 16);
  p.setWord(ctx + 4, data, 'learned shadow correction: model blob');
  p.setWord(a.hook, branchWord(a.hook, stub), 'learned Auto for Shadow Correction');
  p.setWord(a.gain, SHADOWML_GAIN_NEW, 'Auto shadow correction can reach High');
  return { ctx, code, stub, blob: data };
}
