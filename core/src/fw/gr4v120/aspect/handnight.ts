// SPDX-License-Identifier: GPL-2.0-only
/**
 * Handheld Night (GR IV 1.20 and 1.21; tools/gr4v120/handnight: README.md, mfmod.c, c/mf_core.c, c/night_tone.c, NOTES.md).
 *
 * In the dark one press of the shutter takes 4 frames; the camera aligns and merges them (HDR+ style: tile alignment on a
 * pyramid, per-pixel weights from the expected noise) and keeps only the merged photo (DNG and JPEG). A line of the still
 * menu, "Handheld Night" (off by default), switches it on in the camera:
 *  - on: RAW+JPEG, long exposure NR off, self-timer off, Instant Review > Display Time Off, set with the camera's own setters
 *    (the user's values are kept and put back at Off, each only if it still has the value the switch gave it, and written back
 *    before the settings are saved at power-off);
 *  - in single drive the drive goes to continuous while the live view is dark (EV100 <= 3.9 for 1 s; back at >= 4.9 for 1 s);
 *    a shot is merged at ISO 1600 and up, or at EV100 <= 3.9; for P / Av stills with auto ISO the shutter goes no slower than
 *    1/30 s and the ISO upper limit is at least 25600 while the switch is on;
 *  - the merge (about 10 - 13 s) runs on three cores in the back end, with a processing screen (a dark full-screen panel, the
 *    camera's spinner, a bar and one line of text) drawn in the live view; the power key stops it; the merged frame is
 *    brightened by at most 0.5 stop (rule of libcamera's AGC, see tools/gr4v120/handnight/c/night_tone.c) and developed with
 *    the camera's own high-ISO NR at the equivalent ISO and frame 1's white balance; it is shown, then the live view returns.
 *  Anything that does not fit (fewer than 4 frames, memory, the time limit, a frame that changed) leaves the photos the camera's
 *  own: every frame is then stored as usual.  Frame 1, whose storing usually starts before the merge's result, is stored without a file
  once frame 2 is in the group (so the card keeps frames 2.. or the merged photo whatever happens next; mfmod.c KEEP_FIRST).
 *
 * Hooks (each asserts the word it replaces; appended after every other addition):
 *  - 0x53745688 `bl SetupModuleConfig` in the back end's module dispatch: every module of every recipe through the module (which 0).
 *  - 0x5367F904 `ldrb r1, [r4, #0xF1]` in the per-frame decision of continuous drive: with the switch on, 4 frames per press (which 1).
 *  - 0x5367E6AC `ldrb r3, [r4, #0xF1]` in the between-frames release check: a tap is not a stop while the group is open (which 3).
 *  - 0x53905DB0, the entry of the variable memory pool's free method: a held Bayer buffer (frames 1 - 3) is kept until the merge.
 *  - 0x533F3674, the settings save at power-off (already the scaffold's branch): the user's values back into the settings first (which 4).
 *  - 0x536A7D1C, the AE's absolute slowest Tv getter: at most 1/30 s for P / Av stills with auto ISO, switch on.
 *  - 0x5325E4DC, the App's per-event dispatch: counts the key / switch events (the merged frame's review end).
 *  - 0x53653478 `bl StartLiveView` in the live-view control: live view is not restarted while a group merges.
 *  - LiveViewController's vtable 0x53DBF740, slot +0x2C (the per-loop update, UI task): the original, then the module (which 5)
 *    with the switch on, and the live view's root (LiveViewController +0x15C) invalidated when the processing screen changes.
 *  - 0x531848B0 `bl 0x535910AC` (the layer render) in LiveViewController's frame: while a group merges, the live view's root is marked
 *    fully invalidated first, so it is drawn whole (its children, then the processing screen over them) instead of children alone.
 *  - 0x53591178 `bl 0x5359332C` (GroupView Draw) in the layer render 0x535910AC: a layer root that was invalidated is drawn here
 *    (the frame of LiveViewController, vt +0x30, renders its layers with it; the live view's root is layer 0's): the original, then,
 *    only for the live view's root, the processing screen over it.
 * State: the switch byte (alignment padding 0x9AE of the user settings), flag and value bytes 0x49, 0x4A / 0x7A, 0xFA / 0x46E
 * (padding that UserDataInitValue never writes in any of its 30 records, emulated), and the module's state pointer, a RAM word
 * at 0x55839280 after the 512 bytes the subject recognition reserves (0x55839080 .. 0x55839280): the heap starts at 0x55839300
 * and the start-up zero fill reaches it.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord, movWord } from './arm';
import { LANGUAGES, Patch, expectWord, u32le, widenTextRows } from './build';
import { ICON_OFF, ICON_ON, LIST_CONTROLLER_ID, LIST_SET_ITEM, StillLine, TEXT_OFF, TEXT_ON, TOP_SET_TITLE, addListRecords, hookControllerFactory, installTexts, listTemplate } from './datestamp-menu';
import { MF_CODE, MF_CODE_LENGTH, MF_DATA, MF_NS_B, MF_NS_WORDS, MF_PBAR, MF_PROBES, MF_PTEXT, MF_RCP_WORDS } from './handnight-code';
import { adr, byRelease } from '../target';

function fail(code: string, message: string): never {
  throw new FirmwareError(code, 'handheld night: ' + message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;
const k = (r: string, v: number): string => `movw ${r}, #${lo(v)}; movt ${r}, #${hi(v)}`;

/** The saved user settings (CURRENT() + 4). */
const USER = adr(0x550832a8) + 4;
/** The switch, bit 0 (alignment padding 0x9AE of the user settings; 0 on every camera = off). */
export const HN_SWITCH_BYTE = USER + 0x9ae;
/** The module's bytes in the saved user settings (offsets from CURRENT() + 4; mfmod.c NB_*: flags, the user's slowest shutter and ISO
 *  upper limit as u16 halves, 0x79 read only (a research build's menu byte, 0 here), the switch). */
export const HN_SETTING_BYTES: readonly number[] = [0x49, 0x4a, 0x4b, 0x79, 0x7a, 0x7b, 0xfa, 0xfb, 0x46e, 0x46f, 0x9ae];
/** The module's state pointer (0 at start-up: the zero fill reaches it). */
const SLOT = adr(0x55839280);
/** The heap's first block (`movw r3, #0x9080` / `#0x9280`; movt #0x5583) and the start-up zero fill's end (a literal). */
const HEAP_START = adr(0x53ad3684);
const ZERO_FILL_END = adr(0x53000460);
const HEAP_AFTER = adr(0x55839300);
export const HN_MAGIC = 0x5846464d; // "MFFX"
export const HN_TEXT_ID = 1022;
export const HN_PTEXT_ID = 1024;
export const HN_LIST_ID = 0x020001d5;
/** The still-menu line follows Color Space (after the HDR line when that is there too: it is listed first). */
const COLOR_SPACE_ID = 0x0200008d;
/** The still-menu line's icon setter (menu line, icon), as lamp.ts and the HDR line. */
const TOP_SET_ICON = adr(0x5359d6f4);

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
const EN = 'Handheld Night';
export const HN_NAMES: readonly string[] = [
  EN, EN, EN, EN, EN, 'Nacht aus der Hand', EN, EN, EN, '手持ち夜景', '핸드헬드 야경', EN, EN, EN, EN, '手持夜景', 'Noche a pulso', EN, EN, '手持夜景', EN,
];
const PEN = 'Multi-frame NR processing';
export const HN_PTEXT_NAMES: readonly string[] = [
  PEN, PEN, PEN, PEN, PEN, 'Mehrbild-NR wird verarbeitet', PEN, PEN, PEN, 'マルチフレームNR処理中', '멀티 프레임 NR 처리 중', PEN, PEN, PEN, PEN, '多帧降噪处理中',
  'Procesando NR de varias tomas', PEN, PEN, '多幀降噪處理中', PEN,
];

const BE_CALL = adr(0x53745688);
const SETUP_MODULE_CONFIG = adr(0x53733ce4);
const FE_SITE = adr(0x5367f904);
/** ctx natives, in the order of struct ctx (mfmod.c) after magic, slot and switch. */
const natives = (): number[] => [
  0x539084bc, 0x539084f8, // operator new / delete
  0x53919d68, 0x5391ca64, 0x5391ca74, // timer holder, tick, elapsed
  0x537cf950, // file service holder
  0x538f6604, 0x538f6a28, 0x538f666c, 0x538f677c, // ImageBufferAllocator: object, Alloc, Free, FreeMemorySize
  0x53918010, 0x539180a0, 0x5391808c, // cache: object, clean + invalidate, invalidate (not used)
  0x532406a4, 0x53240c38, // application, CURRENT()
  0x532fd208, 0x532fdcf4, 0x532fbacc, 0x532fb170, // setters: file format, long exposure NR, self-timer, drive mode
  0x53157380, // the stock memcpy
].map(adr);

/**
 * SMP T-Kernel calls for the merge's worker tasks, after the data words of struct ctx (mfmod.c, "the merge on three cores"):
 * each an SVC stub of 9 words (`push {r4}; add r4, sp, #4; push {lr}; ldr ip, =fncode; svc #6; pop {lr}; pop {r4}; bx lr;
 * fncode`) with its function code, called by the stock wrapper at `site` (Task.cpp / Semaphore.cpp).
 */
const kernel = (): { stub: number; code: number; site: number; link: boolean; what: string }[] => [
  { stub: adr(0x5306764c), code: 0x80010100, site: adr(0x5390ad78), link: true, what: 'tk_cre_tsk (CreateTask)' },
  { stub: adr(0x530683f0), code: 0x80030200, site: adr(0x53909e0c), link: true, what: 'tk_sta_tsk (StartTask)' },
  { stub: adr(0x53067aa8), code: 0x80050000, site: adr(0x53909aa8), link: false, what: 'tk_exd_tsk (task trampoline)' },
  { stub: adr(0x53067820), code: 0x80020100, site: adr(0x5390a61c), link: true, what: 'tk_del_tsk' },
  { stub: adr(0x53067628), code: 0x80220100, site: adr(0x53909800), link: true, what: 'tk_cre_sem (Semaphore::Create)' },
  { stub: adr(0x530682f4), code: 0x80240200, site: adr(0x5390928c), link: true, what: 'tk_sig_sem (Semaphore::Signal)' },
  { stub: adr(0x530684ec), code: 0x80250300, site: adr(0x53909348), link: true, what: 'tk_wai_sem (Semaphore::Wait)' },
  { stub: adr(0x530677fc), code: 0x80230100, site: adr(0x53909500), link: true, what: 'tk_del_sem' },
];
const SVC_STUB = [0xe92d0010, 0xe28d4004, 0xe92d4000, 0xe59fc00c, 0xef000006, 0xe8bd4000, 0xe8bd0010, 0xe12fff1e];

function callTo(p: Patch, at: number, target: number, what: string, op = 0xeb): void {
  const word = p.word(at);
  if (word >>> 24 !== op || branchTarget(at, word) !== target) fail('unexpected-layout', `unexpected ${what}`);
}

/** A singleton getter (`mov ip, sp; push; movw / movt r4, guard; ...; tst r3, #1; beq; movw / movt r0, object`). */
function expectGetter(p: Patch, at: number, guard: number, object: number, what: string): void {
  const words = [0xe1a0c00d, 0xe92dd818, movWord(4, lo(guard)), movWord(4, hi(guard), true), 0xe24cb004, 0xe5943000, 0xe3130001, 0x0a000002,
    movWord(0, lo(object)), movWord(0, hi(object), true)];
  words.forEach((w, i) => { if (p.word(at + 4 * i) !== w) fail('unexpected-layout', `${what} getter is not as expected`); });
}

/** tk_rot_rdq (fn 11) for the workers: the stub, and the stock Task.cpp wrapper that is only `b stub`. */
function rotRdq(p: Patch): number {
  const stub = adr(0x530681b0), wrapper = adr(0x53909ce0);
  SVC_STUB.forEach((w, i) => expectWord(p, stub + 4 * i, w));
  expectWord(p, stub + 32, 0x800b0100);
  callTo(p, wrapper, stub, 'tk_rot_rdq wrapper', 0xea);
  // tk_chg_slt (fn 10) is called only by two wrappers nothing calls: no task gets a time slice, tasks of one priority run until
  // they block or rotate
  SVC_STUB.forEach((v, i) => expectWord(p, adr(0x53067478) + 4 * i, v));
  expectWord(p, adr(0x53067478) + 32, 0x800a0200);
  return stub;
}

/** The front end's post: `FE_POST(SEQ + 0x10, msg)` = `ldr r0, [r0, #0x3c]; b` (`ldr r0, [r0]; b` the mailbox), as its shutdown
 *  preparation sends the live-view restart 0x67C40802. */
const FE_POST = adr(0x53643344);
function fePost(p: Patch): number {
  expectWord(p, FE_POST, 0xe590003c);
  callTo(p, FE_POST + 4, adr(0x53aac558), 'front-end post', 0xea);
  expectWord(p, adr(0x53aac558), 0xe5900000);
  callTo(p, adr(0x53aac55c), adr(0x53aab1f4), 'front-end post (mailbox)', 0xea);
  expectWord(p, adr(0x5368163c), 0xe34637c4); // movt r3, #0x67c4: the shutdown preparation's 0x67C40802
  callTo(p, adr(0x53681654), FE_POST, 'shutdown preparation post');
  return FE_POST;
}

/** The recipe preparation's ELA byte function, the two auto-ISO setters (hard float), the saved user settings, the ComPropIf
 *  slot (the singleton +4), the ISO table. */
function nightNatives(p: Patch): number[] {
  const ela = adr(0x53739840), comprop = adr(0x5537b29c);
  expectWord(p, ela, 0xe1a0c00d); expectWord(p, ela + 4, 0xe92ddff0);
  callTo(p, adr(0x53739f04), ela, 'the recipe preparation\'s ELA byte call');
  for (const f of [adr(0x532b6d50), adr(0x532b6a28)]) { expectWord(p, f, 0xe1a0c00d); expectWord(p, f + 4, 0xe3a03000); expectWord(p, f + 8, 0xe92dd870); }
  expectWord(p, adr(0x53750028), movWord(0, lo(comprop))); expectWord(p, adr(0x5375002c), movWord(0, hi(comprop), true));
  return [ela, adr(0x532b6d50), adr(0x532b6a28), USER, comprop + 4, ISO_TABLE];
}

/** The App's playback command model getter and its post, as CaptureImageModel's StopReview calls them; the stock setter of
 *  Instant Review > Display Time (CUR, ms), whose inner function stores CUR+0x914 and queues the copy to CUR+0x1458. */
function reviewNatives(p: Patch): number[] {
  const model = adr(0x53240998), post = adr(0x53262d1c), setter = adr(0x5333e5f8);
  expectWord(p, model, 0xe1a0c00d); expectWord(p, model + 8, movWord(4, lo(adr(0x5508317c))));
  expectWord(p, post, 0xe1a0c00d);
  callTo(p, adr(0x533ea808), model, 'StopReview\'s playback model'); callTo(p, adr(0x533ea82c), post, 'StopReview\'s playback post');
  expectWord(p, setter, 0xe1a0c00d); expectWord(p, setter + 4, 0xe3a03000); expectWord(p, setter + 8, 0xe92dd870);
  expectWord(p, adr(0x5333e538), 0xe5900914); expectWord(p, adr(0x5333e554), 0xe5851914);
  expectWord(p, adr(0x53277af0), 0xe5903914); expectWord(p, adr(0x53277af8), 0xe5902458); expectWord(p, adr(0x53277b00), 0x15803458);
  expectWord(p, adr(0x5329ec14), 0xe2800a01); expectWord(p, adr(0x5329ec18), 0xe5900458);
  callTo(p, adr(0x5333e630), adr(0x5333e520), 'the Display Time setter\'s inner call');
  callTo(p, adr(0x531d5314), setter, 'the Display Time menu set', 0xea);
  return [model, post, setter];
}

function kernelCalls(p: Patch): number[] {
  const calls = kernel();
  for (const c of calls) {
    SVC_STUB.forEach((w, i) => expectWord(p, c.stub + 4 * i, w));
    expectWord(p, c.stub + 32, c.code);
    callTo(p, c.site, c.stub, c.what, c.link ? 0xeb : 0xea);
  }
  // CreateTask builds T_CTSK as the module does: attribute 0x00021003, stksz 0; Semaphore::Wait tells a time-out by E_TMOUT
  expectWord(p, adr(0x5390ad0c), 0xe301e003);
  expectWord(p, adr(0x5390ad1c), 0xe340e002);
  expectWord(p, adr(0x53909350), 0xe3700832);
  return calls.map((c) => c.stub);
}
/** The application's event queue getter and its post (queue, event, a, b), for the module's UI wake-up (event 0x17D). */
const APP_QUEUE = adr(0x53240818);
const TICK = adr(0x5391ca64);
const APP_POST = adr(0x5325e2d8);
/** The camera's nominal ISO per step i = round(3 (Sv - 1)) (EXIF ISO). */
const ISO_TABLE = adr(0x5401cd84);

/**
 * Noise slope per ISO step for mfmod.c's noise table: K * lam_s(ISO) * 2^16, K = 1024^2 / pi, lam_s = 1.24e-6 ISO^0.71 (the noise
 * fit measured on GR IV bursts, with the ISO the camera writes to EXIF).
 */
export function noiseSlopes(p: Patch): number[] {
  const isos = Array.from({ length: MF_NS_WORDS }, (_, i) => p.word(ISO_TABLE + 4 * i));
  if (isos[0] !== 6 || isos[12] !== 100 || isos[24] !== 1600 || isos[25] !== 2000 || isos[27] !== 3200 || isos[36] !== 25600 || isos[51] !== 819200 || isos.some((v, i) => i > 0 && v <= isos[i - 1])) {
    fail('unexpected-layout', 'ISO table is not where it was expected');
  }
  return isos.map((iso) => Math.round(((1024 * 1024) / Math.PI) * 1.24e-6 * Math.pow(iso, 0.71) * 65536));
}

/** The weights' own noise model per ISO step (ref.py weights_noise_consts), u64 A and B as (lo, hi) word pairs. */
export function weightsNoise(p: Patch): number[] {
  const isos = Array.from({ length: MF_NS_WORDS }, (_, i) => p.word(ISO_TABLE + 4 * i));
  const wk = ((1024.0 * 1024.0) / Math.PI) * 65536;
  const split = (v: number): number[] => [v % 4294967296, Math.floor(v / 4294967296)];
  return isos.flatMap((iso) => [...split(Math.round(wk * 1.004e-2 * Math.pow(iso, 0.843))), ...split(Math.round((wk * iso) / 50))]);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** assembleWords plus `ldrex`, `strex`, `dmb`, `clrex`, `mrs rX, cpsr`, `msr cpsr_fs, rX` (each a placeholder `mov r0, r0`, then replaced). */
const REG_NAMES: Record<string, number> = { sb: 9, sl: 10, fp: 11, ip: 12, sp: 13, lr: 14, pc: 15 };
function regNumber(r: string): number {
  const t = r.trim().toLowerCase(), m = /^r(\d+)$/.exec(t);
  const n = m ? Number(m[1]) : REG_NAMES[t];
  if (n === undefined || n > 15) fail('internal', `bad register ${r}`);
  return n;
}
export function assembleX(source: string, at: number): number[] {
  const special = new Map<number, number>();
  const lines: string[] = [];
  let index = 0;
  for (const raw of source.split(/[;\n]/)) {
    let text = raw.trim(), label = '';
    for (;;) {
      const m = /^([A-Za-z_.$][\w.$]*):\s*/.exec(text);
      if (!m) break;
      label += m[0]; text = text.slice(m[0].length);
    }
    if (text === '') { if (label) lines.push(label); continue; }
    let w: number | null = null, m: RegExpExecArray | null;
    if (/^dmb$/i.test(text)) w = 0xf57ff05f;
    else if ((m = /^mrs\s+(\w+)\s*,\s*cpsr$/i.exec(text))) w = (0xe10f0000 | (regNumber(m[1]) << 12)) >>> 0;
    else if ((m = /^msr\s+cpsr_fs\s*,\s*(\w+)$/i.exec(text))) w = (0xe12cf000 | regNumber(m[1])) >>> 0;
    else if (/^clrex$/i.test(text)) w = 0xf57ff01f;
    else if ((m = /^ldrex\s+(\w+)\s*,\s*\[\s*(\w+)\s*\]$/i.exec(text))) w = (0xe1900f9f | (regNumber(m[2]) << 16) | (regNumber(m[1]) << 12)) >>> 0;
    else if ((m = /^strex\s+(\w+)\s*,\s*(\w+)\s*,\s*\[\s*(\w+)\s*\]$/i.exec(text))) {
      const rd = regNumber(m[1]), rt = regNumber(m[2]), rn = regNumber(m[3]);
      if (rd === rt || rd === rn) fail('internal', 'strex register overlap');
      w = (0xe1800f90 | (rn << 16) | (rd << 12) | rt) >>> 0;
    }
    if (w !== null) { special.set(index, w); text = 'mov r0, r0'; }
    lines.push(label + text);
    index++;
  }
  const words = assembleWords(lines.join('\n'), at);
  if (words.length !== index) fail('internal', 'assembleX statement count');
  special.forEach((w, i) => { words[i] = w; });
  return words;
}

interface Core { ctx: number; code: number; data: number; beStub: number; feStub: number; tickProbe: number; shown: number }

/** The module, its context and the back-end / front-end hooks. */
function installCore(p: Patch): Core {
  expectWord(p, BE_CALL - 4, 0xe0869105); // add sb, r6, r5, lsl #2
  callTo(p, BE_CALL, SETUP_MODULE_CONFIG, 'SetupModuleConfig call');
  expectWord(p, BE_CALL + 4, 0xe3a03018); // mov r3, #0x18
  expectWord(p, FE_SITE, 0xe5d410f1); // ldrb r1, [r4, #0xf1]
  expectWord(p, FE_SITE + 4, 0xe1510006); // cmp r1, r6
  const module = unbase64(MF_CODE);
  if (module.length !== MF_CODE_LENGTH) fail('internal', 'embedded module length');
  const rcpBytes = unbase64(MF_DATA);
  if (rcpBytes.length !== 4 * MF_RCP_WORDS) fail('internal', 'embedded data length');
  const dataBytes = new Uint8Array(4 * (MF_RCP_WORDS + MF_NS_WORDS + 4 * MF_NS_WORDS));
  dataBytes.set(rcpBytes);
  dataBytes.set(u32le(noiseSlopes(p)), 4 * MF_RCP_WORDS);
  dataBytes.set(u32le(weightsNoise(p)), 4 * (MF_RCP_WORDS + MF_NS_WORDS));
  const data = p.append(dataBytes, 16);
  expectWord(p, APP_QUEUE, 0xe1a0c00d); // mov ip, sp
  expectWord(p, APP_QUEUE + 8, movWord(4, lo(adr(0x550831c8)))); // the queue singleton's guard
  expectWord(p, APP_POST, 0xe1a0c00d);
  callTo(p, APP_POST + 0x44, adr(0x53907930), 'App post: the queue\'s mutex');
  // The module's clock readings for its records go through this one-word trampoline (the emulator tells them apart).
  expectWord(p, TICK, 0xe5900004); // ldr r0, [r0, #4]
  const tickProbe = p.append((at) => [branchWord(at, TICK, 14, false)], 4);
  // The processing screen's displayed percent of a true percent p: round(100 (p / 100)^1.3).
  const shown = p.append(Uint8Array.from({ length: 104 }, (_, i) => (i <= 100 ? Math.round(100 * Math.pow(i / 100, 1.3)) : 0)), 4);
  const ctx = p.append(u32le([HN_MAGIC, SLOT, HN_SWITCH_BYTE, ...natives(), data, data + 4 * MF_RCP_WORDS, MF_NS_B, APP_QUEUE, APP_POST, ...kernelCalls(p), tickProbe, shown, rotRdq(p), fePost(p),
    data + 4 * (MF_RCP_WORDS + MF_NS_WORDS), ...nightNatives(p), ...reviewNatives(p),
    0 /* ctx version 15: log_sink, 0 on the camera (mfmod.c PROBES) */]), 16);
  const code = p.append(module, 16);
  const loadCtx = k('r0', ctx);
  const beStub = p.append((at) => assembleWords(
    `push {r4, lr}
     bl #${SETUP_MODULE_CONFIG}
     ${loadCtx}
     mov r1, #0
     mov r2, r4
     mov r3, r5
     bl #${code}
     pop {r4, pc}`, at), 16);
  // Keeps every register but r1 (the answer) and the flags (the next instruction is `cmp r1, r6`). r3 is the frame's
  // ShootingInfo here; it goes to the module as its 5th argument.
  const feStub = p.append((at) => assembleWords(
    `push {r0, r2, r3, ip}
     ldrb r1, [r4, #0xf1]
     ${k('r0', HN_SWITCH_BYTE)}
     ldrb r0, [r0]
     tst r0, #1
     beq done
     push {lr}
     sub sp, sp, #4
     str r3, [sp]
     ${loadCtx}
     mov r3, r1
     mov r2, r4
     mov r1, #1
     bl #${code}
     mov r1, r0
     add sp, sp, #4
     pop {lr}
     done: pop {r0, r2, r3, ip}
     bx lr`, at), 16);
  p.setWord(BE_CALL, branchWord(BE_CALL, beStub, 14, true), 'handheld night: every module of a burst frame goes through the module');
  p.setWord(FE_SITE, branchWord(FE_SITE, feStub, 14, true), 'handheld night: with the switch on, a burst stops after 4 frames');
  return { ctx, code, data, beStub, feStub, tickProbe, shown };
}

/** The still-menu line's draw function (icon On / Off and the title; the menu line in r1): before the still menu is built. */
export function handNightStillLine(p: Patch): StillLine {
  HN_LAST_LINE = 0;
  expectWord(p, TOP_SET_ICON, 0xe1a0c00d);
  expectWord(p, TOP_SET_TITLE, 0xe1a0c00d);
  const draw = p.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     ${k('r2', HN_SWITCH_BYTE)}; ldrb r3, [r2]
     tst r3, #1; movweq r1, #${ICON_OFF}; movwne r1, #${ICON_ON}
     mov r0, r4; bl #${TOP_SET_ICON}
     mov r0, r4; movw r1, #${HN_TEXT_ID}
     pop {r4, lr}; b #${TOP_SET_TITLE}`, at), 16);
  HN_LAST_LINE = draw;
  return { draw, id: HN_LIST_ID, after: COLOR_SPACE_ID };
}
/** The still-menu line's draw function of the last build (for the checks). */
export let HN_LAST_LINE = 0;

/** The list the line opens (Off / On, the camera's texts and icons); its "set" calls the module (which 2). */
function installList(p: Patch, ctx: number, code: number): { set: number; current: number; draw: number } {
  expectWord(p, LIST_SET_ITEM, 0xe1a0c00d);
  const count = p.append((at) => assembleWords('mov r0, #2; bx lr', at), 16);
  const draw = p.append((at) => assembleWords(
    `cmp r2, #1; bxhi lr
     mov r0, r1; cmp r2, #0
     movweq r1, #${ICON_OFF}; movweq r2, #${TEXT_OFF}
     movwne r1, #${ICON_ON}; movwne r2, #${TEXT_ON}
     b #${LIST_SET_ITEM}`, at), 16);
  // Values 0 Off, 1 On (this = r0, value = r1): the module saves and changes the settings.
  const set = p.append((at) => assembleWords(
    `cmp r1, #1; bxhi lr
     push {r4, lr}
     mov r2, r1
     ${k('r0', ctx)}
     mov r1, #2
     mov r3, #0
     bl #${code}
     pop {r4, pc}`, at), 16);
  const current = p.append((at) => assembleWords(
    `${k('r2', HN_SWITCH_BYTE)}; ldrb r3, [r2]
     and r3, r3, #1
     cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  const rec = listTemplate(p);
  const v = new DataView(rec.buffer);
  v.setUint16(4, HN_TEXT_ID, true);
  v.setUint32(0x0c, count, true);
  v.setUint32(0x14, draw, true);
  v.setUint32(0x24, set, true);
  v.setUint32(0x2c, current, true);
  for (const off of [0x10, 0x18, 0x28, 0x30]) v.setUint32(off, 0, true);
  addListRecords(p, [{ id: HN_LIST_ID, record: rec }], 'handheld night');
  hookControllerFactory(p, `movw ip, #${lo(HN_LIST_ID)}; movt ip, #${hi(HN_LIST_ID)}
     cmp r1, ip; bne prior
     movw r1, #${lo(LIST_CONTROLLER_ID)}; movt r1, #${hi(LIST_CONTROLLER_ID)}`, 'handheld night: the list controller');
  return { set, current, draw };
}

// ---- the live view: the per-loop update and the processing screen ---------------------------------------------------------
/** LiveViewController: its vtable (RTTI at -4), slot +0x2C the per-loop update (UI task), +0x15C its root view. */
const LVC_VT = adr(0x53dbf740), LVC_RTTI = adr(0x53dc08a4), LIVE_UPDATE = adr(0x5318f5a8);
/** GroupView (the live view's root is one): its vtable (RTTI at -4) and Draw(view, context) 0x5359332c.  The layer render 0x535910AC
 *  (a controller frame's render of one layer root) draws a root it finds invalidated (+0xA0) with `bl` Draw at RENDER_DRAW, after
 *  filling it with its colour: the live view's root (layer 0 of LiveViewController) is drawn there, never through vt +0x4C. */
const GROUP_VT = adr(0x53ece290), GROUP_RTTI = adr(0x53ece26c), GROUP_DRAW = adr(0x5359332c), RENDER = adr(0x535910ac), RENDER_DRAW = adr(0x53591178);
/** LiveViewController's frame (vt +0x30): its `bl` layer render of each dirty layer root (r0 = the root).  A root whose children only are dirty
 *  (+0xA2) is rendered in part: those children draw over what is there.  While the module merges, the frame's call marks the live view's
 *  root fully invalidated (+0xA0) first, so the render draws the whole root, its children and then the processing screen over them
 *  (the camera's own mechanism; nothing of the children or the user's settings is changed; after the merge the root's next redraw is
 *  its own again). */
const LVC_FRAME = adr(0x5318480c), FRAME_RENDER = adr(0x531848b0);
const INVALIDATE = adr(0x535acccc); // View::Invalidate (sets +0xA0 unless set)
/** The UI's rectangle fill (as shade.ts: the renderer, its fill target, the fill of {context, x, y, w, h, colour, 0, 0}) and the bitmap
 *  request ({surface, x, y, w, h, clip x, y, w, h, icon, 0}: the renderer's bitmap target and its submission). */
const FILL_FACTORY = adr(0x5323d7f0), FILL_GET = adr(0x5323d968), FILL_RECT = adr(0x5323e1c0), BITMAP_GET = adr(0x5323da14), BITMAP = adr(0x53240038);
/** UI palette (48 ARGB words): colour 20 0xFF191919 (opaque dark grey: the panel), 2 0xFFFFFFFF (opaque white: track and bar). */
const PALETTE = adr(0x540781ec), BG_COLOUR = 20, WHITE = 2;
/** The small indicator (busy without the full-screen panel), 300 x 64 at (210, 292), with the spinner at (218, 294) and a bar; the
 *  full-screen panel: the spinner in the middle (330, 210), the bar 240 wide under it, the text line (MF_PTEXT_BOX) under the bar. */
export const HN_INDICATOR = { x: 210, y: 292, w: 300, h: 64, barX: 284, barW: 210, barY: 321, barH: 6, trackY: 323, trackH: 2 } as const;
export const HN_SPINNER = { firstIcon: 640, size: 60, x: 218, y: 294 } as const;
export const HN_FULL_BAR = { x: 240, w: 240, barY: 296, barH: 6, trackY: 298, trackH: 2 } as const;
export const HN_PTEXT_BOX = { x: 0, y: 316, w: 720, h: 40 } as const;
const STRING_VIEW_CTOR = adr(0x53596018), STRING_VIEW_DRAW = adr(0x53596774), STRING_VIEW_SIZE = 0x110, STRING_VIEW_VT = adr(0x53ece708);
const TIMER_HOLDER = adr(0x53919d68);
const STATE_MAGIC = 0x5453464d; // "MFST" (mfmod.c MAGIC_STATE)
// struct state offsets (mfmod.c, checked there by offsetof)
const OSD_FULL = 0x122c, CANVAS_W = 720, CANVAS_H = 480;
const STATE_BUSY = 4, STATE_UI_BUSY = 8, STATE_PROGRESS = 0xc, UI_DRAWS = 0x10, UI_FIRST = 0x14, UI_LAST = 0x18, UI_GAP = 0x1c, UI_VT_FAIL = 0x20, UI_CORE = 0x24;
const LV_ARMED = 0x28, LV_DEFERRED = 0x2c, LV_OBJ = 0x30, LV_SKIPS = 0x34, LV_SEQ = 0x38, LV_ARM_TICK = 0x3c, LV_UI_NET = 0x40, LV_UI_RET = 0x44, ACTIVE = 0x48, UI_FRAME = 0x4c;
const LV_WATCH = 0xfc, LV_START_RET = 0x100, LV_START_TICK = 0x104;
const UI_HOLD = 0x214, LVC_SHUT = 0xe3, EV_KEYS = 0xbc, EV_CTRL = 0x224;
/** The recording build (MF_PROBES 1, a test build only): counters in state words the module samples with its merge samples (log version
 *  23, mfmod.c rd): the live view's root rendered (it reached our draw), root invalidations asked, those that left +0xA0 set. */
const REC_ROOT = 0x50, REC_INV = 0x54, REC_INV_OK = 0x58;
const LV_CALL = adr(0x53653478), START_LV = adr(0x536520e0), LV_RESTART = 0x67c40802, LV_RUNNING = 0x58;
const WATCHDOG_TICKS = (30 + 5) * 27000000; // the merge's limit + 5 s at the 27 MHz tick
const SCREEN_ID = adr(0x5325e674); // ldr r0, [r0]; bx lr: the application queue's current screen

/** The vtable slot `slot` as it is now: the stock function or an earlier addition's appended code. */
function priorSlot(p: Patch, slot: number, stock: number, what: string): number {
  const w = p.word(slot);
  if (w !== stock) fail('unexpected-layout', `${what} is not the camera's`);
  return w;
}

interface Screen { wrapper: number; draw: number; lvStub: number; tickFn: number; ptext: number; fullRender: number }

/** The per-loop update, the processing screen and the live-view start (see the header). */
function installScreen(p: Patch, module: Core): Screen {
  expectWord(p, LVC_VT - 4, LVC_RTTI);
  expectWord(p, GROUP_VT - 4, GROUP_RTTI);
  const update = priorSlot(p, LVC_VT + 0x2c, LIVE_UPDATE, 'LiveViewController\'s per-loop update');
  callTo(p, RENDER_DRAW, GROUP_DRAW, 'layer render: the root\'s Draw');
  expectWord(p, RENDER_DRAW - 8, 0xe59410ec); expectWord(p, RENDER_DRAW - 4, 0xe1a00004); // ldr r1, [r4, #0xec]; mov r0, r4
  expectWord(p, RENDER, 0xe1a0c00d);
  const groupDraw = GROUP_DRAW;
  expectWord(p, LIVE_UPDATE, 0xe1a0c00d);
  expectWord(p, GROUP_DRAW, branchWord(GROUP_DRAW, adr(0x535ab380), 14, false)); // b View::Draw (the children's Draw, vt +0x4C)
  expectWord(p, INVALIDATE, 0xe5d030a0); // ldrb r3, [r0, #0xa0]
  expectWord(p, PALETTE + 4 * BG_COLOUR, 0xff191919); expectWord(p, PALETTE + 4 * WHITE, 0xffffffff);
  for (const f of [FILL_FACTORY, FILL_GET, FILL_RECT, BITMAP_GET, BITMAP]) if (p.word(f) === 0) fail('unexpected-layout', 'UI renderer functions');
  expectWord(p, TIMER_HOLDER, 0xe1a0c00d);
  expectWord(p, TICK, 0xe5900004);
  // r6 = the module's state if the slot holds a valid one (as get_state: in RAM, aligned, magic), else branch to `none`
  const state = (none: string): string => `${k('r6', SLOT)}; ldr r6, [r6]
     cmp r6, #0x55000000; blo ${none}
     cmp r6, #0xe0000000; bhs ${none}
     tst r6, #3; bne ${none}
     ldr r0, [r6]; ${k('r1', STATE_MAGIC)}; cmp r0, r1; bne ${none}`;
  expectWord(p, LV_CALL - 4, 0xe1a01008); // mov r1, r8
  callTo(p, LV_CALL, START_LV, 'StartLiveView call');
  expectWord(p, LV_CALL + 4, 0xe3500000); // cmp r0, #0
  expectWord(p, LV_CALL + 8, 0x15c58058); // strbne r8, [r5, #0x58]
  expectWord(p, START_LV, 0xe1a0c00d);
  expectWord(p, SCREEN_ID, 0xe5900000); expectWord(p, SCREEN_ID + 4, 0xe12fff1e);
  // xchg0(r0 = address) -> r0 = old word, 0 stored: dmb; ldrex r1,[r0]; mov r2,#0; strex r3,r2,[r0]; cmp r3,#0; bne .-16; dmb; mov r0,r1; bx lr
  const xchg0 = p.append(() => [0xf57ff05f, 0xe1901f9f, 0xe3a02000, 0xe1803f92, 0xe3530000, 0x1afffffa, 0xf57ff05f, 0xe1a00001, 0xe12fff1e], 4);
  const dmbFn = p.append(() => [0xf57ff05f, 0xe12fff1e], 4);
  // r0 = the 27 MHz tick, 0 if there is no timer yet (mfmod.c timer_of)
  const tickFn = p.append((at) => assembleWords(
    `push {r4, lr}
     bl #${TIMER_HOLDER}
     cmp r0, #0
     beq none
     ldr r0, [r0, #0xc]
     cmp r0, #0
     beq none
     bl #${TICK}
     pop {r4, pc}
     none: mov r0, #0
     pop {r4, pc}`, at), 4);
  // r0 = tick -> spinner frame 0..7, 8 steps a second (5 x tick >> 24), forward as the stock animation
  const frameFn = p.append((at) => assembleWords(
    `add r0, r0, r0, lsl #2
     mov r0, r0, lsr #24
     and r0, r0, #7
     rsb r0, r0, #7
     bx lr`, at), 4);
  // In place of `bl StartLiveView` (task LiveViewCtrl, its mutex held): while lv_armed, skip the start (r0 = 0: the caller then
  // leaves live view marked off) and note it; re-check lv_armed after noting: if it was cleared meanwhile, take the note back
  // (atomic exchange) and start as stock, unless the releaser took it first (then it posts the restart). Else the stock call
  // with its registers and stack arguments untouched.
  const lvStub = p.append((at) => assembleWords(
    `push {r0, r1, r2, r3, r4, r6, ip, lr}
     ${state('call')}
     ldr r4, [sp]
     str r4, [r6, #${LV_OBJ}]
     ldrb r4, [r4, #${LVC_SHUT}]
     cmp r4, #0
     bne call
     ldr r4, [r6, #${LV_ARMED}]
     cmp r4, #0
     beq watch
     mov r4, #1
     str r4, [r6, #${LV_DEFERRED}]
     ldr r4, [sp]
     str r4, [r6, #${LV_OBJ}]
     ldr r4, [r6, #${LV_SKIPS}]
     add r4, r4, #1
     str r4, [r6, #${LV_SKIPS}]
     bl #${dmbFn}
     ldr r4, [r6, #${LV_ARMED}]
     cmp r4, #0
     bne skip
     add r0, r6, #${LV_DEFERRED}
     bl #${xchg0}
     cmp r0, #0
     beq skip
     call: pop {r0, r1, r2, r3, r4, r6, ip, lr}
     b #${START_LV}
     skip: pop {r0, r1, r2, r3, r4, r6, ip, lr}
     mov r0, #0
     bx lr
     watch: ldr r4, [r6, #${LV_WATCH}]
     cmp r4, #0
     beq call
     add r0, r6, #${LV_WATCH}
     bl #${xchg0}
     cmp r0, #0
     beq call
     pop {r0, r1, r2, r3, r4, r6, ip, lr}
     push {r4, lr}
     ldr r4, [sp, #12]; push {r4}
     ldr r4, [sp, #12]; push {r4}
     ldr r4, [sp, #8]
     bl #${START_LV}
     add sp, sp, #8
     push {r0, r5}
     bl #${tickFn}
     ${k('r5', SLOT)}; ldr r5, [r5]
     str r0, [r5, #${LV_START_TICK}]
     ldr r0, [sp]
     add r0, r0, #1
     str r0, [r5, #${LV_START_RET}]
     pop {r0, r5}
     pop {r4, pc}`, at), 16);
  // LiveViewController slot +0x2C (UI task, once per loop before Render): the original; with the switch on the module (which 5);
  // then, only while a group is active, a restart is deferred or the screen shows or was shown (else nothing more): the
  // watchdog (a deferral older than the limit + 5 s with no merge: the restart posted from here, unless live view runs again),
  // and the root (+0x15C, a GroupView) invalidated when busy changed or, while busy, the spinner frame of the UI's clock changed.
  const wrapper = p.append((at) => assembleWords(
    `push {r3, r4, r5, r6, r7, r8, r9, lr}
     mov r4, r0
     bl #${update}
     mov r5, r0
     ${k('r0', HN_SWITCH_BYTE)}; ldrb r0, [r0]
     tst r0, #1
     beq nonight
     ${k('r0', module.ctx)}
     mov r1, #5
     mov r2, #0
     mov r3, #0
     sub sp, sp, #8
     str r2, [sp]
     bl #${module.code}
     add sp, sp, #8
     nonight: ${state('out')}
     str r4, [r6, #${EV_CTRL}]
     ldr r0, [r6, #${ACTIVE}]
     ldr r1, [r6, #${LV_DEFERRED}]; orr r0, r0, r1
     ldr r1, [r6, #${STATE_BUSY}]; orr r0, r0, r1
     ldr r1, [r6, #${STATE_UI_BUSY}]; orr r0, r0, r1
     cmp r0, #0
     beq out
     bl #${tickFn}
     mov r7, r0
     ldr r0, [r6, #${LV_DEFERRED}]; cmp r0, #0; beq nowd
     ldr r0, [r6, #${STATE_BUSY}]; cmp r0, #0; bne nowd
     ldr r0, [r6, #${UI_HOLD}]; cmp r0, #0; bne nowd
     cmp r7, #0; beq nowd
     ldr r0, [r6, #${LV_ARM_TICK}]; sub r0, r0, r7; ${k('r1', WATCHDOG_TICKS)}; cmp r0, r1; blo nowd
     mov r0, #0; str r0, [r6, #${LV_ARMED}]
     add r0, r6, #${LV_DEFERRED}
     bl #${xchg0}
     cmp r0, #0
     beq nowd
     mov r9, #2
     ldr r0, [r6, #${LV_OBJ}]
     cmp r0, #0x55000000; blo post
     cmp r0, #0xe0000000; bhs post
     ldrb r1, [r0, #${LV_RUNNING}]
     cmp r1, #0
     orrne r9, r9, #0x100
     bne wdlog
     post: ldr r0, [r6, #${LV_SEQ}]
     cmp r0, #0x55000000; blo wdfail
     cmp r0, #0xe0000000; bhs wdfail
     add r0, r0, #0x10
     sub sp, sp, #32
     mov r1, #0
     str r1, [sp, #4]; str r1, [sp, #8]; str r1, [sp, #12]; str r1, [sp, #16]; str r1, [sp, #20]; str r1, [sp, #24]
     ${k('r1', LV_RESTART)}; str r1, [sp]
     mov r1, sp
     bl #${FE_POST}
     add sp, sp, #32
     str r0, [r6, #${LV_UI_RET}]
     b wdlog
     wdfail: mvn r0, #0; str r0, [r6, #${LV_UI_RET}]
     wdlog: str r9, [r6, #${LV_UI_NET}]
     nowd: ldr r0, [r6, #${STATE_BUSY}]
     ldr r1, [r6, #${STATE_UI_BUSY}]
     cmp r0, r1
     bne inval
     cmp r0, #0
     beq out
     mov r0, r7
     bl #${frameFn}
     ldr r1, [r6, #${UI_FRAME}]
     cmp r0, r1
     beq out
     inval: ldr r0, [r6, #${STATE_BUSY}]; str r0, [r6, #${STATE_UI_BUSY}]
     mov r0, r7
     bl #${frameFn}
     str r0, [r6, #${UI_FRAME}]
     ldr r0, [r4, #0x15c]
     cmp r0, #0
     beq out
     ldr r1, [r0]
     ${k('r2', GROUP_VT)}
     cmp r1, r2
     movne r1, #1
     strne r1, [r6, #${UI_VT_FAIL}]
     bne out
     ${MF_PROBES ? `ldr r1, [r6, #${REC_INV}]; add r1, r1, #1; str r1, [r6, #${REC_INV}]` : ''}
     bl #${INVALIDATE}
     ${MF_PROBES ? `ldr r0, [r4, #0x15c]; ldrb r0, [r0, #0xa0]; cmp r0, #0
     ldrne r1, [r6, #${REC_INV_OK}]; addne r1, r1, #1; strne r1, [r6, #${REC_INV_OK}]` : ''}
     out: mov r0, r5
     pop {r3, r4, r5, r6, r7, r8, r9, pc}`, at), 16);

  // fill(context r0, x r1, y r2, w r3, [sp] h, [sp + 4] colour): the UI's rectangle fill. Keeps r4-r11.
  const fillFn = p.append((at) => assembleWords(
    `push {r4, lr}
     ldr ip, [sp, #8]
     ldr lr, [sp, #12]
     sub sp, sp, #32
     str r0, [sp]; str r1, [sp, #4]; str r2, [sp, #8]; str r3, [sp, #12]; str ip, [sp, #16]; str lr, [sp, #20]
     mov r0, #0; str r0, [sp, #24]; str r0, [sp, #28]
     bl #${FILL_FACTORY}
     bl #${FILL_GET}
     mov r1, sp
     bl #${FILL_RECT}
     add sp, sp, #32
     pop {r4, pc}`, at), 16);
  // icon(surface r0, x r1, y r2, {id, w, h}* r3, clip* [sp]): the bitmap request with the destination intersected with the clip.
  const iconFn = p.append((at) => assembleWords(
    `push {r4, r5, r6, r7, r8, lr}; sub sp, sp, #48
     mov r4, r0; mov r5, r1; mov r6, r2; mov r7, r3; ldr r8, [sp, #72]
     str r4, [sp]; str r5, [sp, #4]; str r6, [sp, #8]
     ldr r0, [r7, #4]; str r0, [sp, #12]; add r0, r5, r0
     ldr r1, [r7, #8]; str r1, [sp, #16]; add r1, r6, r1
     ldr r2, [r8]; cmp r5, r2; movlt r5, r2; str r5, [sp, #20]
     ldr r2, [r8, #4]; cmp r6, r2; movlt r6, r2; str r6, [sp, #24]
     ldr r2, [r8]; ldr r3, [r8, #8]; add r2, r2, r3; cmp r0, r2; movgt r0, r2
     ldr r2, [r8, #4]; ldr r3, [r8, #12]; add r2, r2, r3; cmp r1, r2; movgt r1, r2
     sub r0, r0, r5; sub r1, r1, r6; cmp r0, #0; ble done; cmp r1, #0; ble done
     str r0, [sp, #28]; str r1, [sp, #32]
     ldr r0, [r7]; str r0, [sp, #36]; mov r0, #0; str r0, [sp, #40]
     bl #${FILL_FACTORY}; bl #${BITMAP_GET}; mov r1, sp; bl #${BITMAP}
     done: add sp, sp, #48; pop {r4, r5, r6, r7, r8, pc}`, at), 16);
  const ptext = MF_PTEXT ? installProcText(p) : 0;
  // r0 = this core's number + 1 (MPIDR & 3): mrc p15, 0, r0, c0, c0, 5; and r0, r0, #3; add r0, r0, #1; bx lr
  const coreFn = p.append(() => [0xee100fb0, 0xe2000003, 0xe2800001, 0xe12fff1e], 4);
  const I = HN_INDICATOR, S = HN_SPINNER, FB = HN_FULL_BAR, X1 = I.x + I.w, Y1 = I.y + I.h;
  // a fill at (x, y, w, h) in `colour`; h and colour on the stack (8 bytes, the frame stays 8-byte aligned); w in a register or a number
  const fill = (x: number, y: number, w: number | string, h: number, colour: number): string => `
     ${k('r0', h)}; str r0, [sp]; mov r0, #${colour}; str r0, [sp, #4]
     mov r0, r5; ${k('r1', x)}; ${k('r2', y)}; ${typeof w === 'number' ? k('r3', w) : `mov r3, ${w}`}
     bl #${fillFn}`;
  // the spinner icon at (x, y), clipped to (cx, cy, cw, ch): {id, w, h} at [sp + 8], the clip at [sp + 20], its address at [sp]
  const spinner = (x: number, y: number, cx: number, cy: number, cw: number, ch: number): string => `
     str r7, [sp, #8]; mov r0, #${S.size}; str r0, [sp, #12]; str r0, [sp, #16]
     ${k('r0', cx)}; str r0, [sp, #20]; ${k('r0', cy)}; str r0, [sp, #24]; ${k('r0', cw)}; str r0, [sp, #28]; ${k('r0', ch)}; str r0, [sp, #32]
     add r0, sp, #20; str r0, [sp]
     mov r0, r5; ${k('r1', x)}; ${k('r2', y)}; add r3, sp, #8
     bl #${iconFn}`;
  // r9 = the bar's width for `width` pixels at the state's percent (+1; 0 none)
  const barWidth = (width: number): string => `ldr r9, [r6, #${STATE_PROGRESS}]
     subs r9, r9, #1
     movmi r9, #0
     cmp r9, #100
     movhi r9, #100
     mov r0, #${width}
     mul r0, r9, r0
     ${k('r2', 0x51eb851f)}
     umull r3, r9, r0, r2
     mov r9, r9, lsr #5`;
  // In place of the layer render's `bl GroupView Draw` (r0 = the layer root, r1 = its context): the original first; then, for the live
  // view's root only (LiveViewController +0x15C
  // of the controller the per-loop update noted, its vtable checked), while busy and the root's clip holds the indicator: the full-screen
  // panel (osd_full and the root the whole 720 x 480 canvas) or the small indicator, then the module's draw counters.
  const draw = p.append((at) => assembleWords(
    `push {r4, r5, r6, r7, r8, sb, sl, lr}
     mov r4, r0
     mov r5, r1
     bl #${groupDraw}
     mov r8, r0
     ${state('done')}
     ldr r0, [r6, #${EV_CTRL}]
     cmp r0, #0x55000000; blo done
     cmp r0, #0xe0000000; bhs done
     tst r0, #3; bne done
     ldr r1, [r0]; ${k('r2', LVC_VT)}; cmp r1, r2; bne done
     ldr r0, [r0, #0x15c]; cmp r0, r4; bne done
     ${MF_PROBES ? `ldr r0, [r6, #${REC_ROOT}]; add r0, r0, #1; str r0, [r6, #${REC_ROOT}]` : ''}
     ldr r7, [r6, #${STATE_BUSY}]
     cmp r7, #0
     beq done
     ldrb r0, [r4, #0x9e]
     cmp r0, #0
     beq done
     ldr r0, [r4, #0x64]; cmp r0, #${I.x}; bgt done
     ldr r1, [r4, #0x68]; cmp r1, #${I.y}; bgt done
     ldr r2, [r4, #0x6c]; add r2, r2, r0; ${k('r3', X1)}; cmp r2, r3; blt done
     ldr r2, [r4, #0x70]; add r2, r2, r1; ${k('r3', Y1)}; cmp r2, r3; blt done
     bl #${tickFn}
     mov r10, r0
     bl #${frameFn}
     add r7, r0, #${S.firstIcon}
     sub sp, sp, #40
     add r0, r6, #${OSD_FULL & 0xf000}; ldr r0, [r0, #${OSD_FULL & 0xfff}]; cmp r0, #0; beq nofull
     ldr r0, [r4, #0x64]; cmp r0, #0; bgt nofull
     ldr r0, [r4, #0x68]; cmp r0, #0; bgt nofull
     ldr r0, [r4, #0x6c]; ${k('r1', CANVAS_W)}; cmp r0, r1; blt nofull
     ldr r0, [r4, #0x70]; ${k('r1', CANVAS_H)}; cmp r0, r1; blt nofull
     ${fill(0, 0, CANVAS_W, CANVAS_H, BG_COLOUR)}
     ${spinner((CANVAS_W - S.size) / 2, (CANVAS_H - S.size) / 2, (CANVAS_W - S.size) / 2, (CANVAS_H - S.size) / 2, S.size, S.size)}
     ${ptext ? `mov r0, r5; bl #${ptext}` : ''}
     ${MF_PBAR ? `${fill(FB.x, FB.trackY, FB.w, FB.trackH, WHITE)}
     ${barWidth(FB.w)}
     cmp r9, #0
     beq probes
     ${fill(FB.x, FB.barY, 'r9', FB.barH, WHITE)}` : ''}
     b probes
     nofull:
     ${fill(I.x, I.y, I.w, I.h, BG_COLOUR)}
     ${spinner(S.x, S.y, I.x, I.y, I.w, I.h)}
     ${fill(I.barX, I.trackY, I.barW, I.trackH, WHITE)}
     ${barWidth(I.barW)}
     cmp r9, #0
     beq probes
     ${fill(I.barX, I.barY, 'r9', I.barH, WHITE)}
     probes: add sp, sp, #40
     ldr r0, [r6, #${UI_DRAWS}]; add r0, r0, #1; str r0, [r6, #${UI_DRAWS}]
     bl #${coreFn}; str r0, [r6, #${UI_CORE}]
     movs r0, r10
     beq done
     ldr r1, [r6, #${UI_DRAWS}]
     cmp r1, #1
     streq r0, [r6, #${UI_FIRST}]
     beq last
     ldr r1, [r6, #${UI_LAST}]
     sub r1, r1, r0
     ldr r2, [r6, #${UI_GAP}]
     cmp r1, r2
     strhi r1, [r6, #${UI_GAP}]
     last: str r0, [r6, #${UI_LAST}]
     done: mov r0, r8
     pop {r4, r5, r6, r7, r8, sb, sl, pc}`, at), 16);
  callTo(p, FRAME_RENDER, RENDER, 'LiveViewController frame: the layer render');
  expectWord(p, FRAME_RENDER - 4, 0xe1a00009); // mov r0, sb (the layer root)
  expectWord(p, LVC_VT + 0x30, LVC_FRAME);
  expectWord(p, LVC_FRAME, 0xe1a0c00d);
  // In place of the frame's `bl` layer render: while busy, the live view's root (the controller the per-loop update noted, its vtable
  // checked) gets +0xA0 = 1 (fully invalidated) before the render; every register as it was, then on to the render.
  const fullRender = p.append((at) => assembleWords(
    `push {r0, r1, r2, r3, r4, r6, ip, lr}
     ${k('r6', SLOT)}; ldr r6, [r6]
     cmp r6, #0x55000000; blo go
     cmp r6, #0xe0000000; bhs go
     tst r6, #3; bne go
     ldr r1, [r6]; ${k('r2', STATE_MAGIC)}; cmp r1, r2; bne go
     ldr r1, [r6, #${STATE_BUSY}]; cmp r1, #0; beq go
     ldr r1, [r6, #${EV_CTRL}]
     cmp r1, #0x55000000; blo go
     cmp r1, #0xe0000000; bhs go
     tst r1, #3; bne go
     ldr r2, [r1]; ${k('r3', LVC_VT)}; cmp r2, r3; bne go
     ldr r1, [r1, #0x15c]; cmp r1, r0; bne go
     mov r1, #1; strb r1, [r0, #0xa0]
     go: pop {r0, r1, r2, r3, r4, r6, ip, lr}
     b #${RENDER}`, at), 16);
  p.setWord(FRAME_RENDER, branchWord(FRAME_RENDER, fullRender, 14, true), 'handheld night: while merging, the live view\'s root is rendered whole (children under the processing screen)');
  p.setWord(LV_CALL, branchWord(LV_CALL, lvStub, 14, true), 'handheld night: live view start held while a group merges');
  p.setWord(LVC_VT + 0x2c, wrapper, 'handheld night: the live view\'s per-loop update also runs the module and invalidates the root when the processing screen changes');
  p.setWord(RENDER_DRAW, branchWord(RENDER_DRAW, draw, 14, true), 'handheld night: the layer render draws a root, then the processing screen over the live view\'s root');
  return { wrapper, draw, lvStub, tickFn, ptext, fullRender };
}

/**
 * The processing screen's text line: ptext(surface), a StringView made by the stock constructor in a 0x110-byte stack frame (it
 * allocates nothing), text number HN_PTEXT_ID, centred (+0xF1 / +0xF2 = 1), its draw rectangle (+0x30) and clip (+0x64) the box,
 * then the stock draw with the root draw's context; the camera's language picks the string and the font.
 */
function installProcText(p: Patch): number {
  const B = HN_PTEXT_BOX;
  [0xe1a0c00d, 0xe92ddbf0, 0xe24cb004, 0xe24dd008, 0xe59b7004, 0xe1a04000].forEach((w, i) => expectWord(p, STRING_VIEW_CTOR + 4 * i, w));
  expectWord(p, STRING_VIEW_CTOR + 0x38, 0xe5843000); // str r3 (the vtable), [r4]
  expectWord(p, STRING_VIEW_CTOR + 0xe4, STRING_VIEW_VT); // its literal
  [0xe1a0c00d, 0xe92ddff0].forEach((w, i) => expectWord(p, STRING_VIEW_DRAW + 4 * i, w));
  expectWord(p, STRING_VIEW_VT + 0x4c, STRING_VIEW_DRAW);
  const rect = (off: number): string => `${k('r0', B.x)}; str r0, [r4, #${off}]; ${k('r0', B.y)}; str r0, [r4, #${off + 4}]
     ${k('r0', B.w)}; str r0, [r4, #${off + 8}]; ${k('r0', B.h)}; str r0, [r4, #${off + 12}]`;
  return p.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r5, r0
     sub sp, sp, #${STRING_VIEW_SIZE + 8}
     ${k('r0', B.h)}; str r0, [sp]
     add r0, sp, #8
     ${k('r1', B.x)}; ${k('r2', B.y)}; ${k('r3', B.w)}
     bl #${STRING_VIEW_CTOR}
     add r4, sp, #8
     ${k('r0', HN_PTEXT_ID)}; strh r0, [r4, #0xea]
     mov r0, #1; strb r0, [r4, #0xf1]; strb r0, [r4, #0xf2]
     ${rect(0x30)}
     ${rect(0x64)}
     mov r0, r4
     mov r1, r5
     bl #${STRING_VIEW_DRAW}
     add sp, sp, #${STRING_VIEW_SIZE + 8}
     pop {r4, r5, r6, pc}`, at), 16);
}

/**
 * Hold instead of copy: one hook at the entry of the variable-size memory pool's free method 0x53905DB0 (vt[3] of the class with
 * vtable 0x540183C8; every release of an IMAGE1 / IMAGE2 block passes here: the ImageBufferAllocator Free 0x538F666C tail-calls it).
 * Entry: r0 = the pool, r1 = the pointer, r2 = a flag, lr = the caller. For a pointer held in one of the module's 3 slots (state
 * +0xC0, 16 bytes each: word = address | state, +4 site, +8 repeated frees, +0xC the caller's return address) the word is switched
 * with LDREX / STREX: from the relocation (return address 0x5374AAE4: the data was moved) HELD -> DROPPED and the stock free; from
 * any other caller HELD -> RELEASED and the free skipped (r0 = 1); RELEASED -> skipped too (counted). Anything else: the original
 * first instruction (`mov ip, sp`) and on, every register as it was. Site codes: 1 ReleaseBufferSingle, 2 ReleaseAll, 3 relocation,
 * 4 any other caller.
 */
const HOLD_SLOTS = 0xc0;
function installHoldFreeHook(p: Patch): number {
  const FREE = adr(0x538f666c), POOL_FREE = adr(0x53905db0), POOL_VTABLE = adr(0x540183c8), RELOC_RET = adr(0x5374aae4);
  const RELEASE_SINGLE_RET = adr(0x5374b398), RELEASE_ALL_RET = adr(0x5374b034);
  expectWord(p, POOL_FREE, 0xe1a0c00d); // mov ip, sp
  expectWord(p, POOL_FREE + 4, byRelease({ '1.20': 0xe3053350, '1.21': 0xe3063b30 })); // movw r3, #0x5350 (1.21 #0x6b30)
  expectWord(p, POOL_FREE + 8, 0xe92ddff0);
  expectWord(p, POOL_VTABLE + 0xc, POOL_FREE);
  expectWord(p, POOL_VTABLE + 0x18, adr(0x53905a28)); // vt[6] "owns"
  callTo(p, adr(0x53905e90), adr(0x53068144), 'the pool free method\'s tk_rel_mpl');
  expectWord(p, adr(0x53068144) + 0x20, 0x80480200); // tk_rel_mpl function code
  // Free ends with pool->vt[0xC](pool, ptr, flag) as a tail call, lr = its caller
  [0xe5963000, 0xe1a01004, 0xe1a02007, 0xe1a00006, 0xe593300c, 0xe24bd01c, 0xe89d68f0, 0xe12fff13].forEach((w, i) => expectWord(p, adr(0x538f66d8) + 4 * i, w));
  // the three stock Bayer frees (they reach the method through Free) and the return addresses the stub names
  for (const ret of [RELEASE_SINGLE_RET, RELEASE_ALL_RET, RELOC_RET]) callTo(p, ret - 4, FREE, 'Bayer Free call');
  expectWord(p, RELOC_RET, 0xe5943000);
  const stub = p.append((at) => assembleX(
    `push {r4, r5, r6}
     ${k('r4', SLOT)}; ldr r4, [r4]
     cmp r4, #0x55000000; blo real
     cmp r4, #0xe0000000; bhs real
     tst r4, #3; bne real
     ldr r5, [r4]; ${k('r6', STATE_MAGIC)}; cmp r5, r6; bne real
     cmp r1, #0; beq real
     add r4, r4, #${HOLD_SLOTS}
     mov r6, #3
     loop: ldr r5, [r4]
     bic r5, r5, #3
     cmp r5, r1
     bne next
     dmb
     retry: ldrex r5, [r4]
     bic ip, r5, #3
     cmp ip, r1
     bne miss
     and ip, r5, #3
     cmp ip, #1
     bne nothold
     ${k('r3', RELOC_RET)}
     cmp lr, r3
     moveq ip, #3
     orrne ip, r1, #2
     strex r3, ip, [r4]
     cmp r3, #0
     bne retry
     dmb
     str lr, [r4, #12]
     mov r3, #4
     ${k('r5', RELOC_RET)}; cmp lr, r5; moveq r3, #3
     ${k('r5', RELEASE_SINGLE_RET)}; cmp lr, r5; moveq r3, #1
     ${k('r5', RELEASE_ALL_RET)}; cmp lr, r5; moveq r3, #2
     str r3, [r4, #4]
     cmp r3, #3
     beq real
     pop {r4, r5, r6}
     mov r0, #1
     bx lr
     nothold: clrex
     cmp ip, #2
     bne next
     ldr r3, [r4, #8]; add r3, r3, #1; str r3, [r4, #8]
     pop {r4, r5, r6}
     mov r0, #1
     bx lr
     miss: clrex
     next: add r4, r4, #16
     subs r6, r6, #1
     bne loop
     real: pop {r4, r5, r6}
     mov ip, sp
     b #${POOL_FREE + 4}`, at), 16);
  p.setWord(POOL_FREE, branchWord(POOL_FREE, stub, 14, false), 'handheld night: every free of a pool block through the hold check (a held Bayer buffer is kept)');
  return stub;
}

/**
 * One press = 4 frames: at 0x5367E6AC `ldrb r3, [r4, #0xF1]` in step 0x206 of the between-frames release check (0x5367E680), whose
 * stock code stores that byte (the stop request) into SEQ+0xF2 (which ended a tapped burst after frame 1). The stub loads the same
 * byte into r3; with the switch on it asks the module (which 3: a = SEQ, b = r3 | ip << 8 | r2 << 16, e = r1 = the plan entry's
 * ShootingInfo) and returns its answer in r3. r0, r1, r2, ip and r4..r11, sp are kept; the flags are dead.
 */
function installTapHook(p: Patch, ctx: number, code: number): number {
  const entry = adr(0x5367e680), site = adr(0x5367e6ac);
  expectWord(p, entry, 0xe1a0c00d);
  expectWord(p, entry + 4, 0xe92dd870);
  expectWord(p, entry + 8, 0xe1a04000);
  expectWord(p, entry + 0x18, 0xe5d0c0f3);
  expectWord(p, entry + 0x20, 0xe5911010);
  expectWord(p, entry + 0x28, 0xe5d4211a);
  expectWord(p, site, 0xe5d430f1);
  expectWord(p, site + 4, 0xe5c1c974);
  expectWord(p, site + 8, 0xe5c4211b);
  expectWord(p, site + 12, 0xe5c430f2);
  callTo(p, site + 16, adr(0x53684210), 'shutdown-preparation check after the F2 store');
  expectWord(p, site + 20, 0xe3500000);
  callTo(p, adr(0x536827f0), entry, 'the step dispatcher\'s branch to 0x206', 0xea);
  const stub = p.append((at) => assembleWords(
    `ldrb r3, [r4, #0xf1]
     push {r0, r1, r2, ip}
     ${k('r0', HN_SWITCH_BYTE)}
     ldrb r0, [r0]
     tst r0, #1
     beq done
     push {lr}
     sub sp, sp, #4
     str r1, [sp]
     orr r3, r3, ip, lsl #8
     orr r3, r3, r2, lsl #16
     ${k('r0', ctx)}
     mov r2, r4
     mov r1, #3
     bl #${code}
     mov r3, r0
     add sp, sp, #4
     pop {lr}
     done: pop {r0, r1, r2, ip}
     bx lr`, at), 16);
  p.setWord(site, branchWord(site, stub, 14, true), 'handheld night: a tap is not a stop while the 4-frame group is open');
  return stub;
}

/** The settings save at power-off (0x533F3674, already the scaffold's branch): the module first (which 4: the user's auto-ISO values,
 *  Display Time and drive back into CURRENT()), every register kept, then on to that branch's target. */
function installSaveHook(p: Patch, ctx: number, code: number): number {
  const save = adr(0x533f3674);
  const first = p.word(save);
  if (first >>> 24 !== 0xea) fail('unexpected-layout', 'the settings save is not hooked by the scaffold');
  const next = branchTarget(save, first);
  expectWord(p, save + 4, 0xe92ddff0);
  callTo(p, adr(0x533f37a0), adr(0x5329b218), 'the settings save\'s copy of CUR + 4');
  const stub = p.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     ${k('r0', ctx)}
     mov r1, #4
     mov r2, #0
     mov r3, #0
     sub sp, sp, #8
     str r2, [sp]
     bl #${code}
     add sp, sp, #8
     pop {r0, r1, r2, r3, ip, lr}
     b #${next}`, at), 16);
  p.setWord(save, branchWord(save, stub, 14, false), 'handheld night: the settings save at power-off puts the user\'s values back first');
  return stub;
}

/**
 * The shutter limit: every reader of the AE's absolute slowest Tv I+0x74 goes through its getter 0x536A7D1C `vldr s0, [r0, #0x74];
 * bx lr`. The stub loads the same value and, only with the switch on, for a still (byte [r0+8] = 0), auto ISO ([r0+0x9C] = 1) and AE
 * mode P or Av ([r0+0x39] 0 or 2), returns at most Tv 5.0 (1/30 s). Only ip and s0 (and the flags, dead at every caller) change.
 */
const TV_NIGHT_BITS = 0x40a00000;
function installShutterCap(p: Patch): number {
  const get = adr(0x536a7d1c);
  expectWord(p, get, 0xed900a1d);
  expectWord(p, get + 4, 0xe12fff1e);
  expectWord(p, get + 8, 0xed800a1d); // the setter next to it
  const stub = p.append((at) => {
    const pre = assembleWords(
      `ldrb ip, [r0, #8]
       cmp ip, #0
       bxne lr
       ldrb ip, [r0, #0x9c]
       cmp ip, #1
       bxne lr
       ldrb ip, [r0, #0x39]
       cmp ip, #0
       cmpne ip, #2
       bxne lr
       ${k('ip', HN_SWITCH_BYTE)}
       ldrb ip, [ip]
       tst ip, #1
       bxeq lr
       push {r1}
       ${k('r1', TV_NIGHT_BITS)}`, at + 4);
    // vldr s0, [r0, #0x74] first; then vmov ip, s0; cmp ip, r1; movlt ip, r1; vmovlt s0, ip; pop {r1}; bx lr
    return [0xed900a1d, ...pre, 0xee10ca10, 0xe15c0001, 0xb1a0c001, 0xbe00ca10, 0xe49d1004, 0xe12fff1e];
  }, 16);
  p.setWord(get, branchWord(get, stub, 14, false), 'handheld night: the AE\'s absolute slowest Tv at most 1/30 s for P / Av stills with auto ISO');
  return stub;
}

/** The App's per-event dispatch (0x5325E4DC, UI task; r1 = {u16 event, a, b}): the switch / key events 1..0x2D counted in state +0xBC
 *  (mfmod.c ev_keys: "a key since the group's end"). Every register and the flags kept; the replaced `ldrh r2, [r1]` then on. */
function installKeyCount(p: Patch): number {
  const dispatch = adr(0x5325e4dc);
  expectWord(p, dispatch, 0xe1d120b0); // ldrh r2, [r1]
  expectWord(p, dispatch + 4, 0xe1a0c00d);
  expectWord(p, dispatch + 8, 0xe92dd818);
  const stub = p.append((at) => assembleX(
    `push {r0, r1, r2, r3, r4, r5, r6, lr}
     mrs r4, cpsr
     ${k('r0', HN_SWITCH_BYTE)}; ldrb r0, [r0]; tst r0, #1; beq out
     ${k('r6', SLOT)}; ldr r6, [r6]
     cmp r6, #0x55000000; blo out; cmp r6, #0xe0000000; bhs out; tst r6, #3; bne out
     ldr r0, [r6]; ${k('r1', STATE_MAGIC)}; cmp r0, r1; bne out
     ldr r5, [sp, #4]
     ldrh r2, [r5]
     sub r0, r2, #1
     cmp r0, #0x2c
     ldrls r0, [r6, #${EV_KEYS}]
     addls r0, r0, #1
     strls r0, [r6, #${EV_KEYS}]
     out: msr cpsr_fs, r4
     pop {r0, r1, r2, r3, r4, r5, r6, lr}
     ldrh r2, [r1]
     b #${dispatch + 4}`, at), 16);
  p.setWord(dispatch, branchWord(dispatch, stub, 14, false), 'handheld night: the App\'s per-event dispatch counts the switch / key events');
  return stub;
}

/** The module's state pointer after the subject recognition's 512 bytes: the heap starts at 0x55839300, the zero fill reaches it. */
function installRam(p: Patch): void {
  const w = p.word(HEAP_START), t = p.word(HEAP_START + 4);
  const from = [0x55839080, 0x55839280].map(adr);
  if (!from.some((a) => w === movWord(3, lo(a)) && t === movWord(3, hi(a), true))) fail('unexpected-layout', 'the heap does not start where it was expected');
  const fill = p.word(ZERO_FILL_END);
  if (![0x55839014, 0x55839040, 0x55839080, 0x55839280].map(adr).includes(fill)) fail('unexpected-layout', 'unexpected end of the start-up zero fill');
  if (hi(HEAP_AFTER) !== hi(from[0]) || SLOT + 4 > HEAP_AFTER || SLOT < from[1]) fail('internal', 'state word layout');
  p.setWord(HEAP_START, movWord(3, lo(HEAP_AFTER)), 'handheld night: the heap starts later (0x55839300), the module\'s state word before it');
  p.setWord(ZERO_FILL_END, HEAP_AFTER, 'handheld night: the start-up zero fill also clears the state word before the heap');
}

export interface HandNightLayout { ctx: number; code: number; data: number; beStub: number; feStub: number; tickProbe: number; shown: number;
  listSet: number; listCurrent: number; listDraw: number; wrapper: number; draw: number; lvStub: number; tickFn: number; ptext: number; fullRender: number;
  holdStub: number; tapStub: number; saveStub: number; shutterStub: number; keyStub: number; slot: number; switchByte: number }

/** Handheld Night (option handheldNight): everything but the still-menu line's draw function (`handNightStillLine`, before the still
 *  menu is built). Last of all the additions. */
export function installHandNight(p: Patch): HandNightLayout {
  if (HN_NAMES.length !== LANGUAGES || HN_PTEXT_NAMES.length !== LANGUAGES) fail('internal', 'texts');
  installRam(p);
  const core = installCore(p);
  const list = installList(p, core.ctx, core.code);
  widenTextRows(p, Math.max(HN_TEXT_ID, HN_PTEXT_ID));
  installTexts(p, [{ id: HN_TEXT_ID, names: HN_NAMES }, ...(MF_PTEXT ? [{ id: HN_PTEXT_ID, names: HN_PTEXT_NAMES }] : [])]);
  const screen = installScreen(p, core);
  const holdStub = installHoldFreeHook(p);
  const tapStub = installTapHook(p, core.ctx, core.code);
  const saveStub = installSaveHook(p, core.ctx, core.code);
  const shutterStub = installShutterCap(p);
  const keyStub = installKeyCount(p);
  HN_LAST_LAYOUT = { ...core, listSet: list.set, listCurrent: list.current, listDraw: list.draw, ...screen, holdStub, tapStub, saveStub, shutterStub, keyStub, slot: SLOT, switchByte: HN_SWITCH_BYTE };
  return HN_LAST_LAYOUT;
}

/** The layout of the last install (for tools/gr4v120/handnight/build.ts, which hands it to the emulator checks). */
export let HN_LAST_LAYOUT: HandNightLayout | null = null;

/** Every official word this changes (for tests). */
export function handNightSites(): number[] {
  return [HEAP_START, ZERO_FILL_END, BE_CALL, FE_SITE, LV_CALL, LVC_VT + 0x2c, RENDER_DRAW, FRAME_RENDER, adr(0x53905db0), adr(0x5367e6ac), adr(0x533f3674), adr(0x536a7d1c), adr(0x5325e4dc)];
}
