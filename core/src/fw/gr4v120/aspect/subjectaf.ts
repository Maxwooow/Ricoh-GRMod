// SPDX-License-Identifier: GPL-2.0-only
/**
 * Subject recognition for photo AF (GR IV 1.20 and 1.21; tools/gr4v120/afplain: README.md, runtime/, model/).
 *
 * At half-press a small integer convolutional network looks at a 96 x 64 thumbnail of the live view and decides where the
 * subject is (human and cat / dog heads first, then bodies, then the most salient object); the AF area is put there. The
 * focusing itself is the camera's own AF. Manual points, movies, temporary focus modes and the camera's own face / eye
 * detection come first: the camera's answer is always taken when it has one. Where the camera would otherwise choose
 * among its multi-point areas, the network's box is offered as the "selected face"; without a usable answer (no frame
 * yet, blank, a thumbnail too old) the box is the centre 2 x 2 cells.
 * In Follow and Continuous AF the network places the start frame through the camera's own frame move (the camera tracks
 * from there), and in Follow the camera's face detection is kept on (three words of the settings recompute): a face or
 * eye found by the camera starts the frame there, else the network.
 * When the box was used the in-focus sound is the camera's short shutter sound; every JPEG / DNG gets a 96-byte record
 * (private maker note tag 0xc7a3) and a 10 x 8 luminance thumbnail (0xc7a2), read by tools/gr4v120/afplain/metadata.
 *
 * Eight hooks, each an adapter that keeps every register, the flags, FPSCR and d0-d31 and calls the module's dispatch
 * af_s1_dispatch(op, frame, 0, ctx):
 *  - 0x533acd04 `bl 0x5325e104`, before the AF START of a half-press (UI task): op 1.
 *  - 0x5365cba8 `bl 0x5366bc80`, the live-view display hand-over of every frame (LV task): op 2, the thumbnail.
 *  - 0x53831044 and 0x538299f4, the entries of the JPEG and DNG maker-note writers: ops 5 and 6, the record.
 *  - 0x53fddf34, the maker-note serializer's data setter in its vtable (0x53835ac0): op 7 for the two tags above only,
 *    so that the camera's setter does not write their payload as zeros; every other tag goes to the camera's setter.
 *  - 0x5360ebd0, the entry of the AF task's "selected face" getter: op 8 (the camera's answer first, through a copy of
 *    the replaced word and a branch back, the native getter trampoline).
 *  - 0x53626410, the end of an AF pass: op 12.
 *  - 0x533b060c `b 0x533b0530`, the in-focus sound: op 26.
 * State: 512 bytes from 0x55839080, after the sbrk arena the other additions use (0x55839040 .. 0x55839080,
 * `battery.ts`): the camera's heap starts 512 bytes later (one word, 0x53ad3684) and the start-up zero fill reaches it.
 * The working memory (153 KB: three thumbnails, the network's scratch) is one allocation of the camera's heap 2.
 *
 * The module and model are the bytes of the camera build (tools/gr4v120/afplain/README.md). 1.21 runs its own compile of
 * the same source (tools/gr4v121/afplain, its addresses mapped); the model is shared. Not on 1.11.
 */
import { FirmwareError } from '../../types';
import { branchTarget } from './arm';
import { Patch, expectWord, u32le } from './build';
import { adr } from '../target';
import { SUBJECTAF_CODE, SUBJECTAF_CODE_LENGTH, SUBJECTAF_ENTRY } from './subjectaf-code';
import { SUBJECTAF_MODEL, SUBJECTAF_MODEL_LENGTH, SUBJECTAF_MODEL_SHA256 } from './subjectaf-model-code';

const fail = (message: string): never => { throw new FirmwareError('unexpected-layout', 'subject recognition: ' + message); };

/** struct s1_module_ctx in runtime/runtime.h (80 bytes): magic "AGF1". */
export const SUBJECTAF_MAGIC = 0x31464741;
/** Name kept in the context (its last 16 bytes). */
const NAME = 'GRMOD_AF_PLN';
/** reserved[1] of the context: on, sound cue, start frame in Follow / Continuous, faces kept in Follow (camera build). */
export const SUBJECTAF_FLAGS = 1 | 2 | 4 | 8;
/** The model budgets of the context, as in the camera build (max samples, max steps, min score / gain Q12, min variance). */
const BUDGETS = [6300, 32256, 1024, 512, 4];
/** Bytes reserved for the module's counters (struct pl_static, 276 bytes; the runtime checks it fits). */
export const SUBJECTAF_RESERVED = 0x200;

type Kind = 'call' | 'entry' | 'vtable';
interface HookSpec { name: string; op: number; site: number; kind: Kind; target: number; replay?: number; words: readonly number[]; fixups: readonly [number, number, number, number, number] }

/**
 * The adapters (tools/gr4v120/afplain/README.md): exact words of the camera build, with five fixups each:
 * movw / movt r3 (context), movw / movt ip (dispatch), and the branch back.
 */
const SAVE = [0xe92d5fff, 0xe1a0c00d, 0xe3cdd007, 0xe24dd010, 0xe58dc008, 0xe10fc000, 0xe58dc000, 0xeef1ca10, 0xe58dc004, 0xed2d0b20, 0xed6d0b20, 0xe59dc108];
const RESTORE = [0xecfd0b20, 0xecbd0b20, 0xe59dc004, 0xeee1ca10, 0xe59dc000, 0xe12cf00c, 0xe59dc008, 0xe1a0d00c, 0xe8bd5fff];
const FRAME_ARGS = [0xe1a0100c, 0xe3a02000];      // mov r1, ip; mov r2, #0
const RECORD_ARGS = [0xe59c1000, 0xe59c2004];     // ldr r1, [ip]; ldr r2, [ip, #4]
const CALL = [0, 0, 0, 0, 0xe12fff3c];             // the four movw / movt, blx ip
const op = (n: number) => 0xe3a00000 | n;         // mov r0, #n
function hooks(): HookSpec[] {
  const simple = (name: string, n: number, site: number, kind: Kind, target: number, args: number[], replay?: number): HookSpec => {
    const words = [...SAVE, ...args, op(n), ...CALL, ...RESTORE, ...(replay !== undefined ? [replay] : []), 0];
    return { name, op: n, site, kind, target, ...(replay !== undefined ? { replay } : {}), words, fixups: [15, 16, 17, 18, words.length - 1] };
  };
  const setter: number[] = [...SAVE, ...RECORD_ARGS, 0xe1d200b4, 0xe30cc7a2, 0xe150000c, 0x0a000002, 0xe30cc7a3, 0xe150000c, 0x1a000010, op(7), ...CALL, ...RESTORE, 0xe3a00001, 0xe12fff1e, ...RESTORE, 0];
  const getter: number[] = [...SAVE, ...FRAME_ARGS, op(8), ...CALL, 0xe3500001, 0x0a00000a, ...RESTORE, 0xe590c02c, 0, ...RESTORE, 0xe12fff1e];
  const sound: number[] = [0xe92d5fff, 0xe1a0c00d, 0xe3cdd007, 0xe24dd010, 0xe58dc008, 0xe10fc000, 0xe58dc000, 0xe59dc008, 0xe59c0004, 0xe58d0004, 0xe59c0008, 0xe58d000c,
    ...FRAME_ARGS, op(26), ...CALL, 0xe3500001, 0x0a000004, 0xe59dc008, 0xe59d0004, 0xe58c0004, 0xe59d000c, 0xe58c0008, 0xe59dc000, 0xe12cf00c, 0xe59dc008, 0xe1a0d00c, 0xe8bd5fff, 0];
  return [
    simple('run', 1, adr(0x533acd04), 'call', adr(0x5325e104), FRAME_ARGS),
    simple('collect', 2, adr(0x5365cba8), 'call', adr(0x5366bc80), FRAME_ARGS),
    simple('jpeg', 5, adr(0x53831044), 'entry', adr(0x53831048), RECORD_ARGS, 0xe1a0c00d),
    simple('dng', 6, adr(0x538299f4), 'entry', adr(0x538299f8), RECORD_ARGS, 0xe1a0c00d),
    { name: 'setter', op: 7, site: adr(0x53fddf34), kind: 'vtable', target: adr(0x53835ac0), words: setter, fixups: [22, 23, 24, 25, 47] },
    { name: 'getter', op: 8, site: adr(0x5360ebd0), kind: 'entry', target: adr(0x5360ebd4), replay: 0xe590c02c, words: getter, fixups: [15, 16, 17, 18, 32] },
    simple('afEnd', 12, adr(0x53626410), 'entry', adr(0x53626414), FRAME_ARGS, 0xe3a06000),
    { name: 'sound', op: 26, site: adr(0x533b060c), kind: 'entry', target: adr(0x533b0530), words: sound, fixups: [15, 16, 17, 18, 32] },
  ];
}

function places() {
  return {
    /** The module's counters (struct pl_static; the runtime names this address). */
    state: adr(0x55839080),
    /** `movw r3, #0x9080` of the heap's first block (the camera's heap starts at 0x55839080). */
    heapStart: adr(0x53ad3684),
    /** Literal: end of the start-up zero fill (0x55839014; 0x55839040 or 0x55839080 once another addition extends it). */
    zeroFillEnd: adr(0x53000460),
    /** faceFollow: inside the UserData recompute 0x532adc18, "Common AF kind == 1" keeps the face setting On. */
    faceRule: adr(0x532adc20),
  };
}

const B = (at: number, to: number, link = false): number => (((link ? 0xeb000000 : 0xea000000) | (((to - (at + 8)) >> 2) & 0xffffff)) >>> 0);
const movHalf = (reg: number, value: number, top: boolean): number => ((top ? 0xe3400000 : 0xe3000000) | ((value & 0xf000) << 4) | (reg << 12) | (value & 0xfff)) >>> 0;

/** The runtime and the model as embedded (for tests). */
export function subjectAfModule(): Uint8Array {
  const m = Uint8Array.from(atob(SUBJECTAF_CODE), (c) => c.charCodeAt(0));
  if (m.length !== SUBJECTAF_CODE_LENGTH) throw new FirmwareError('internal', 'subject recognition: embedded module length');
  return m;
}
export function subjectAfModel(): Uint8Array {
  const m = Uint8Array.from(atob(SUBJECTAF_MODEL), (c) => c.charCodeAt(0));
  if (m.length !== SUBJECTAF_MODEL_LENGTH) throw new FirmwareError('internal', 'subject recognition: embedded model length');
  return m;
}

/** Every word changed in the official image (for tests): the heap start, the zero fill end, the face rule, the hooks. */
export function subjectAfSites(): number[] {
  const a = places();
  return [a.heapStart, a.zeroFillEnd, a.faceRule, a.faceRule + 4, a.faceRule + 8, ...hooks().map((h) => h.site)];
}

/** The hooks: name, op, site, kind and adapter length (for the tools that read a build, tools/gr4v120/afplain/build.ts). */
export function subjectAfHooks(): { name: string; op: number; site: number; kind: Kind; stubLength: number }[] {
  return hooks().map((h) => ({ name: h.name, op: h.op, site: h.site, kind: h.kind, stubLength: h.words.length * 4 }));
}

export interface SubjectAfLayout {
  module: number; moduleBytes: number; model: number; modelBytes: number; context: number; contextBytes: number;
  nativeGetterTrampoline: number; dispatch: number; state: number;
  hooks: { name: string; op: number; site: number; stub: number; stubLength: number; kind: Kind }[];
}

/** Subject recognition for photo AF (option subjectAf). */
export function installSubjectAf(p: Patch): SubjectAfLayout {
  const a = places(), specs = hooks();
  // Preflight: every word this changes must be the camera's before anything is appended.
  for (const h of specs) {
    const w = p.word(h.site);
    if (h.kind === 'vtable') { if (w !== h.target) fail(`unexpected vtable slot at 0x${h.site.toString(16)} (${h.name})`); }
    else if (h.replay !== undefined) { if (w !== h.replay) fail(`unexpected instruction at 0x${h.site.toString(16)} (${h.name})`); }
    else if (w >>> 24 !== (h.kind === 'call' ? 0xeb : 0xea) || branchTarget(h.site, w) !== h.target) fail(`unexpected branch at 0x${h.site.toString(16)} (${h.name})`);
  }
  expectWord(p, a.heapStart, 0xe3093080);
  expectWord(p, a.heapStart + 4, 0xe3453583);
  const fill = p.word(a.zeroFillEnd);
  if (fill !== adr(0x55839014) && fill !== adr(0x55839040) && fill !== adr(0x55839080)) fail('unexpected end of the start-up zero fill');
  const faceWords = [[0xe3500001, 0xe3100001], [0x03a02000, 0x13a02000], [0x13a02002, 0x03a02002]] as const;
  faceWords.forEach(([before], i) => expectWord(p, a.faceRule + 4 * i, before));

  const module = subjectAfModule(), model = subjectAfModel();
  const moduleAt = p.append(module, 16), modelAt = p.append(model, 16);
  const context = new Uint8Array(80), v = new DataView(context.buffer);
  const contextAt = p.next(16), trampoline = contextAt + 80;
  [SUBJECTAF_MAGIC, 1, a.state, modelAt, model.length, contextAt + 64, 0, ...BUDGETS].forEach((x, i) => v.setUint32(4 * i, x, true));
  for (let i = 0; i < 8; i++) context[48 + i] = parseInt(SUBJECTAF_MODEL_SHA256.slice(2 * i, 2 * i + 2), 16);
  v.setUint32(56, trampoline, true);
  v.setUint32(60, SUBJECTAF_FLAGS, true);
  context.set(new TextEncoder().encode(NAME), 64);
  if (p.append(context, 16) !== contextAt) fail('context moved');
  const getter = specs.find((h) => h.name === 'getter')!;
  if (p.append((at) => [getter.replay!, B(at + 4, getter.target)], 16) !== trampoline) fail('getter trampoline moved');
  const dispatch = moduleAt + SUBJECTAF_ENTRY;
  const installed = specs.map((h) => {
    const stub = p.append((at) => {
      const w = [...h.words];
      const [cw, ct, dw, dt, back] = h.fixups;
      w[cw] = movHalf(3, contextAt & 0xffff, false); w[ct] = movHalf(3, contextAt >>> 16, true);
      w[dw] = movHalf(12, dispatch & 0xffff, false); w[dt] = movHalf(12, dispatch >>> 16, true);
      w[back] = B(at + back * 4, h.target);
      return w;
    }, 16);
    return { name: h.name, op: h.op, site: h.site, stub, stubLength: h.words.length * 4, kind: h.kind };
  });
  // The words in place: the state, the face rule, then the hooks.
  p.setWord(a.heapStart, 0xe3093280, 'subject recognition: the heap starts 512 bytes later (0x55839280), the module\'s counters before it');
  p.setWord(a.zeroFillEnd, adr(0x55839280), 'subject recognition: the start-up zero fill also clears the module\'s 512 bytes before the heap');
  faceWords.forEach(([, after], i) => p.setWord(a.faceRule + 4 * i, after, 'subject recognition: the face setting stays On in Follow as well (Common AF kind 1 or 3)'));
  for (const h of installed) {
    p.setWord(h.site, h.kind === 'vtable' ? h.stub : B(h.site, h.stub, h.kind === 'call'), `subject recognition: ${h.name} adapter (op ${h.op})`);
  }
  return { module: moduleAt, moduleBytes: module.length, model: modelAt, modelBytes: model.length, context: contextAt, contextBytes: 80,
    nativeGetterTrampoline: trampoline, dispatch, state: a.state, hooks: installed };
}
