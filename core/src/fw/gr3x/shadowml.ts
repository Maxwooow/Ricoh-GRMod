// SPDX-License-Identifier: GPL-2.0-only
/**
 * A learned Auto for Shadow Correction on GR III 2.10 / IIIx 1.60 (as GR IV's, ../gr4v120/aspect/shadowml.ts). Off unless
 * asked for (`shadowLearn`). GR III offers the same Shadow Correction as GR IV (Auto, Low, Medium, High, Off; also in RAW
 * development) and its core is GR IV's recompiled, so Auto becomes GR IV's learned estimate of how much the shadows should be
 * lifted, with GR IV's model (100 gradient-boosted trees, ../gr4v120/aspect/shadowml-data.ts) and GR IV's module compiled with
 * GR III's offsets (tools/gr3extras/shadowml/shadowml.c, generated into shadowml-code.ts).
 *
 * The core, ToneControlTuning 0x536E9558 (GR IV 0x53947230; same four functions in the same order, the same code up to register
 * allocation: r8 = settings S (GR IV sb), sb = the shooting record P = [S+0x130] (GR IV sl), stack slots 4 bytes lower):
 *  - S+0x54 the setting (0 Auto, 1..3 Low..High, else Off), S+0x53 the highlight shift hl (stored at fp-0x43C), S+0x44 the ISO
 *    index (r7, at most 0x60), S+0x8D the mode (0 still, 1 live view, 2 movie, 3), S+0x8A / S+0x8B force no correction.
 *  - The fixed levels jump from 0x536E965C to 0x536E9808 (r3 = 0x800, r7 = [fp-0x438]); Auto calls the Y-array builder
 *    0x536C2A30 with P+0xB80 (stills, 0x536E96C0) or P+0x39270 (live view / movie, 0x536E9B50, which branches back to
 *    0x536E96C4), takes the 1 % point of a histogram of the block luminance and joins the common code at 0x536E97F8 with
 *    r3 = t and r7 = 1: strength = min(t, cap[idx]) * gain >> 11 with the gain table 0x53DC22D8 (index 4 = Auto, 0x100), the
 *    live-view smoothing, the levels. The camera's own Auto is GR IV's instruction for instruction (so presumably also GR IV's
 *    16-bit wrap of the block sums; not tried on GR III data). Tables: cap 0x53DC22F4 and gains are GR IV's, value for value.
 *
 * Hook (0x536E96C4, `ldr r2,[fp,#-0x454]`, directly after the stills' call of the builder and the target of the live view's
 * branch back): a stub keeps the forced-zero cases (to the stock zero path 0x536E9AD4), calls
 * shadowml(ctx, P = sb, mode = S[0x8D], hl = [fp-0x43C], idx = r7) on an 8-byte aligned stack, goes to the zero path for a
 * negative result and otherwise to 0x536E97F8 with r3 = t, r7 = 1. r4 (the stub keeps sp in it) is written by both targets
 * before it is read; sl (Auto's gain) and r5-r11 are preserved by the module. Auto's gain (index 4) goes from 0x100 to 0x400
 * so that Auto can reach High, as on GR IV.
 *
 * The statistics: the module reads the block planes of the statistics structure the builder fills (the builder's code is GR IV's,
 * the same structure: w, h, R +0x14018, Gr +0x18018, B +0x20018, count +0x26018) at GR III's places in P (0xB80, 0x39270,
 * GR IV's 0xBB8, 0x392A8). The words that encode these places are checked below.
 *
 * Working memory: one operator-new allocation (0x536AF2A8, GR IV's 0x539084BC instruction for instruction) of 1560 bytes, its
 * pointer in the RAM word GR3X_SHADOWML_WORD (round 10's zero-filled words); the live-view throttling state (compute on every
 * 4th call) lives in that allocation. If the allocation fails the call gives the camera's no-correction result.
 *
 * Layout: blob, module, context and stub are appended. Every address is looked up (`adr`) at install time.
 */
import { branchWord } from '../aspect/arm';
import { SHADOWML_DATA, SHADOWML_DATA_LENGTH } from '../gr4v120/aspect/shadowml-data';
import { FirmwareError } from '../types';
import { GR3X_SHADOWML_CODE, GR3X_SHADOWML_CODE_LENGTH, GR3X_SHADOWML_MAGIC } from './shadowml-code';
import { adr } from './target';

export const GR3X_SHADOWML_GAIN_OLD = 0x100;
export const GR3X_SHADOWML_GAIN_NEW = 0x400;
export const GR3X_SHADOWML_PERIOD = 4;

function places() {
  return {
    core: adr(0x536e9558),
    hook: adr(0x536e96c4),
    callYBuilder: adr(0x536e96c0),
    yBuilder: adr(0x536c2a30),
    lvCall: adr(0x536e9b50),
    lvBack: adr(0x536e9b54),
    common: adr(0x536e97f8),
    zeroPath: adr(0x536e9ad4),
    fixedJump: adr(0x536e965c),
    fixedJoin: adr(0x536e9808),
    autoOne: adr(0x536e9768),
    forced8b: adr(0x536e976c),
    forced8a: adr(0x536e9778),
    saveS: adr(0x536e9568),
    loadP: adr(0x536e9578),
    loadHl: adr(0x536e95a4),
    storeHl: adr(0x536e95c0),
    loadIdx: adr(0x536e95c4),
    capIdx: adr(0x536e960c),
    clampIdx: adr(0x536e9614),
    stillGrid: adr(0x536e95b0),
    lvGridHigh: adr(0x536e9b20),
    lvGridLow: adr(0x536e9b30),
    lvCountHigh: adr(0x536e9a00),
    lvCountLow: adr(0x536e9a10),
    /** Auto's gain table: 0 (Off), Low, Medium, High, Auto, 0. */
    gains: adr(0x53dc22d8),
    /** The firmware's operator new. */
    alloc: adr(0x536af2a8),
  };
}

/** The RAM word that keeps the module's allocation (round 10's free, zero-filled words; this one is the shadow correction's). */
export const gr3xShadowmlWord = (): number => adr(0x5580439c);
/** The hook word (for the checks). */
export const gr3xShadowmlHook = (): number => places().hook;

export interface Gr3xShadowmlProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}

const bytesOf = (text: string, length: number, what: string): Uint8Array => {
  const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (raw.length !== length) throw new FirmwareError('internal', `learned shadow correction: ${what} length`);
  return raw;
};
const u32le = (values: number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 4), v = new DataView(out.buffer);
  values.forEach((x, i) => v.setUint32(i * 4, x >>> 0, true));
  return out;
};

/** The learned Auto for Shadow Correction. */
export function installGr3xShadowLearn(p: Gr3xShadowmlProgram): Record<string, number> {
  const a = places();
  const bad = (what: string): never => { throw new FirmwareError('unexpected-layout', `IIIx learned shadow correction: ${what}`); };
  const want = (at: number, expected: number, what: string) => { if (p.word(at) !== expected) bad(what); };
  // The core's words the stub and the module rely on (GR III 2.10's; 2.20 / 2.21 through the address tables).
  want(a.callYBuilder, branchWord(a.callYBuilder, a.yBuilder, 14, true), 'the stills\' call of the Y-array builder');
  want(a.lvCall, branchWord(a.lvCall, a.yBuilder, 14, true), 'the live view\'s call of the Y-array builder');
  want(a.lvBack, branchWord(a.lvBack, a.hook), 'the live view\'s branch back to the hook word');
  want(a.fixedJump, branchWord(a.fixedJump, a.fixedJoin, 0), 'the fixed levels\' jump past Auto'); // beq
  want(a.fixedJoin, 0xe51b7438, 'the fixed levels\' join'); // ldr r7,[fp,#-0x438]
  want(a.common, 0xe5d8508d, 'the common code'); // ldrb r5,[r8,#0x8d]
  want(a.zeroPath, 0xe5d8508d, 'the zero path'); // ldrb r5,[r8,#0x8d]
  want(a.autoOne, 0xe3a07001, 'Auto\'s r7 = 1'); // mov r7,#1
  want(a.forced8b, 0xe5d8208b, 'the forced-zero byte 0x8B'); // ldrb r2,[r8,#0x8b]
  want(a.forced8a, 0xe5d8508a, 'the forced-zero byte 0x8A'); // ldrb r5,[r8,#0x8a]
  want(a.saveS, 0xe1a08003, 'S in r8'); // mov r8,r3
  want(a.loadP, 0xe5989130, 'P in sb'); // ldr sb,[r8,#0x130]
  want(a.loadHl, 0xe5d8e053, 'hl'); // ldrb lr,[r8,#0x53]
  want(a.storeHl, 0xe50be43c, 'hl at fp-0x43C'); // str lr,[fp,#-0x43c]
  want(a.loadIdx, 0xe1d874b4, 'the ISO index in r7'); // ldrh r7,[r8,#0x44]
  want(a.capIdx, 0xe3570060, 'the ISO index bound'); // cmp r7,#0x60
  want(a.clampIdx, 0x23a07060, 'the ISO index bound'); // movhs r7,#0x60
  want(a.stillGrid, 0xe2893d2e, 'the stills\' statistics at P+0xB80'); // add r3,sb,#0xb80
  want(a.lvGridHigh, 0xe2891a39, 'the live view\'s statistics at P+0x39270'); // add r1,sb,#0x39000
  want(a.lvGridLow, 0xe2811e27, 'the live view\'s statistics at P+0x39270'); // add r1,r1,#0x270
  want(a.lvCountHigh, 0xe2892a39, 'the live view\'s grid at P+0x39270'); // add r2,sb,#0x39000
  want(a.lvCountLow, 0xe2822e27, 'the live view\'s grid at P+0x39270'); // add r2,r2,#0x270
  want(a.alloc, 0xe1a0c00d, 'operator new'); // mov ip,sp
  want(a.alloc + 12, 0xe1a05000, 'operator new'); // mov r5,r0
  const gains = [0, 1, 2].map((k) => p.word(a.gains + 4 * k));
  if (gains[0] !== 0x01000000 || gains[1] !== 0x04000200 || gains[2] !== GR3X_SHADOWML_GAIN_OLD) bad('the gain table is not the official one');

  const blob = bytesOf(SHADOWML_DATA, SHADOWML_DATA_LENGTH, 'model');
  const data = p.append(blob);
  const code = p.append(bytesOf(GR3X_SHADOWML_CODE, GR3X_SHADOWML_CODE_LENGTH, 'module'));
  const ctx = p.append(u32le([GR3X_SHADOWML_MAGIC, data, blob.length, GR3X_SHADOWML_PERIOD, a.alloc, gr3xShadowmlWord()]));
  const stub = p.code(
    `ldrb r0,[r8,#0x8a]
     ldrb r1,[r8,#0x8b]
     orrs r0,r0,r1
     bne #${a.zeroPath}
     mov r4,sp
     bic sp,sp,#7
     sub sp,sp,#8
     str r7,[sp]
     movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}
     mov r1,r9
     ldrb r2,[r8,#0x8d]
     ldr r3,[fp,#-0x43c]
     bl #${code}
     mov sp,r4
     cmp r0,#0
     blt #${a.zeroPath}
     mov r3,r0
     mov r7,#1
     b #${a.common}`);
  p.patch(a.hook, 0xe51b2454 /* ldr r2,[fp,#-0x454] */, branchWord(a.hook, stub), 'learned Auto for Shadow Correction');
  p.patch(a.gains + 8, GR3X_SHADOWML_GAIN_OLD, GR3X_SHADOWML_GAIN_NEW, 'Auto shadow correction can reach High (gain 0x100 -> 0x400)');
  return { shadowmlStub: stub, shadowmlCode: code, shadowmlCtx: ctx, shadowmlBlob: data };
}
