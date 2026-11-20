// SPDX-License-Identifier: GPL-2.0-only
/**
 * Movie AF driven by the phase data (GR IV 1.20 and 1.21; tools/gr4v120/videoaf: README.md, vafquick.c).
 *
 * While a movie is recorded the GR IV focuses by contrast only: it wobbles the lens around the focus and, when it loses
 * it, runs a whole search at the slow recording speed (120 lens units/s), with the image going soft and back ("breathing").
 * The sensor's phase data is computed in every focusing frame but not used for that. With this option it is: while the
 * lens rests the focus is kept by steps straight to where the phase data says, at the lens's ordinary speed; the camera's
 * own new searches are refused while that data is usable; a search that does run is steered by it (direction, one fast
 * step). Where the phase data says nothing (no reliable area), the camera's own search is let through, as without the
 * option. Two small changes of the camera's own movie AF come with it: the wobbling module may travel up to 16 basic
 * steps at once, and the focus area while recording (without a touch) is the one middle frame of the Select modes.
 *
 * Words changed in place:
 *  - 0x5362a8ac..0x5362a8bc, the wobbling module's step cap (set once per search): max(speed / 100, 16 x basic step)
 *    instead of max(speed / 100, basic step); with the module's flag + 0xd60 set as before (speed / 100).
 *  - 0x533ae094 and 0x533ae690, the two jump table entries of focus mode 8 (MovieRecording, no touch yet): the frame size
 *    and area type of mode 3 (SelectMovieRecording, 64 x 52, one frame) instead of 590 x 380 auto area; still in the
 *    middle. A touch while recording still moves the frame (mode 3); standby (mode 7) is not touched.
 * Eight hooks, the code and stubs appended:
 *  - 0x53626104 `bl 0x5361ed88`, the wobbling step of every focusing frame of a recording: through the module.
 *  - 0x53edf068, the CafProcess vtable's "movie record state 0" callback (0x53611a84): the recording has ended.
 *  - 0x5362f6fc `bl 0x5362c1c8`, the vote of the wobbling module's travel state: the module may replace it by a direction.
 *  - 0x536266e0 `bl 0x53621f6c`, the standby monitor of every frame in which the camera does not search: afterwards the
 *    module looks at the phase data, may send the lens a step, or ask for a search the way the camera's own decision
 *    0x53614584 does.
 *  - 0x536304e0 `mov r7, r2` in the wobbling module's lens move 0x536304bc: the one move the module names (state + 0x54)
 *    asks 40 x amount units/s, at most 2500, marked with bit 15; every other move asks what the camera asks (120).
 *  - 0x53951b34 `tst ip, #1` in the lens control's relative move 0x53951b04: a marked speed takes the ordinary branch
 *    (the lens's ordinary limits and motor setting) instead of the recording one; every other speed as before.
 *  - 0x5362208c `bne 0x536220d4` in the standby monitor: while recording, a scene change no longer empties the phase
 *    computation every frame (the still-shooting rule alone).
 *  - 0x536147f0 `bl 0x53609bb0` in the camera's own decision to search again from standby: the module is asked first;
 *    when it says no the request is left out and 0 returned (what the request returns when refused).
 * The module takes the lens for a step in standby the way the movie AF does when a search begins (0x5360d980 (lens, 2))
 * and gives it back when the lens has stopped (0x5360de18): the lens takes a move only from who holds it.
 *
 * State: one operator-new allocation (on the first focusing frame of a recording), its pointer in VIDEOAF_SLOT, the last
 * word of the unused sbrk arena before the heap (see battery.ts; zero at start-up once the start-up zero fill reaches
 * 0x55839080, which build.ts makes it do). The module can write a record of each recording to the card; this build gives
 * it no file service (the `file_holder` native is a stub that returns 0), so nothing is written. The record is kept in RAM.
 *
 * The module bytes are those of the build its camera rounds were made with (module version 13, README.md).
 * GR IV 1.20 and 1.21 (not 1.11). 1.21 runs this through its address table: the hooked code and everything the context
 * checks below names is the same there, moved, with only branches and movw/movt address constants relocated; the struct
 * offsets the module reads are those of the same instructions. The addresses are looked up (adr) when the option is installed.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget } from './arm';
import { Patch, u32le } from './build';
import { VAFQUICK_CODE, VAFQUICK_CODE_LENGTH } from './videoaf-code';
import { adr } from '../target';

export const VIDEOAF_MAGIC = 0x51414656; // "VFAQ"
/** Module flags (struct ctx in vafquick.c): step size, direction, the record, standby, keeping the focus without a search. */
const FLAGS = 0x1f;
/** Units/s asked per unit of a marked move, and the most a marked move asks (the lens's own ordinary limit). */
const PER_UNIT = 40, FASTEST = 2500;
/** struct state, mark_from (vafquick.c checks the offset). */
const MARK_OFFSET = 0x54;

const fail = (message: string): never => { throw new FirmwareError('unexpected-layout', 'movie AF: ' + message); };

/** The places the module relies on (addresses of this program's release). */
function places() {
  return {
    wobbleCall: adr(0x53626104), wobbleStep: adr(0x5361ed88),
    stopSlot: adr(0x53edf068), stopCallback: adr(0x53611a84),
    voteCall: adr(0x5362f6fc), vote: adr(0x5362c1c8),
    speedWord: adr(0x536304e0),
    monitorCall: adr(0x536266e0), monitor: adr(0x53621f6c),
    keepPhase: adr(0x5362208c), phaseReset: adr(0x536220d4),
    askCall: adr(0x536147f0), ask: adr(0x53609bb0),
    wobbleMove: adr(0x536304bc),
    lensTake: adr(0x5360d980), lensGiveBack: adr(0x5360de18),
    lensTest: adr(0x53951b34), lensQuiet: adr(0x53951bac), lensOrdinary: adr(0x53951b3c), lensLimits: adr(0x53951b44),
    /** The state pointer: the last word of the sbrk arena before the heap (battery.ts). */
    slot: adr(0x5583907c),
    /** struct ctx in vafquick.c: operator new, timer holder, raw tick, elapsed microseconds, (file service: a stub), the
     * wobbling step, the lens position getter, the request for a new search, the lens state, the wobbling lens move,
     * the lens taken and given back. */
    alloc: adr(0x539084bc), timerHolder: adr(0x53919d68), tick: adr(0x5391ca64), elapsed: adr(0x5391ca74),
    lensPosition: adr(0x5360dff4), lensState: adr(0x5360e7b0),
    /** The wobbling module's step cap and the focus area of mode 8. */
    cap: adr(0x5362a8ac), capEnd: adr(0x5362a8c4),
    areaSize: adr(0x533ae094), areaSize8: adr(0x533ae120), areaSize3: adr(0x533ae0e8),
    areaType: adr(0x533ae690), areaType8: adr(0x533ae7a4), areaType3: adr(0x533ae79c),
  };
}

/**
 * What must be the official code for the hooks to mean what this file says (1.20 addresses):
 * ['w', at, word] a word; ['b', at, top byte, target] a branch (condition and kind, and where it goes);
 * ['a', at, address] a data word holding an address; ['m', at, movw without its immediate, address] `movw` of the
 * address's low half.
 */
type Context = readonly ['w', number, number, string] | readonly ['b', number, number, number, string] | readonly ['a', number, number, string] | readonly ['m', number, number, number, string];
const CONTEXT: readonly Context[] = [
  ['w', 0x53626100, 0xe3a01001, 'mov r1, #1 before the wobbling step call'],
  ['w', 0x53626108, 0xe3500001, 'cmp r0, #1 after it'],
  ['w', 0x53626100, 0xe3a01001, 'mov r1, #1 before the wobbling step call'],
  ['w', 0x53626108, 0xe3500001, 'cmp r0, #1 after it'],
  ['a', 0x53edf05c, 0x53611a74, 'the movie-state-1 callback, same vtable'],
  ['w', 0x5360e000, 0xe3051205, 'lens position getter: movw r1, #0x5205'],
  ['w', 0x5362f6f4, 0xe1a00004, 'mov r0, r4'],
  ['w', 0x5362f6f8, 0xe3a01001, 'mov r1, #1'],
  ['w', 0x5362f700, 0xe5d43c88, 'ldrb r3, [r4, #0xc88]'],
  ['w', 0x5362f704, 0xe3500000, 'cmp r0, #0'],
  ['w', 0x5362f708, 0xe5c400e6, 'strb r0, [r4, #0xe6]'],
  ['b', 0x5362f714, 0x1a, 0x5362f8e0, 'bne 0x5362f8e0'],
  ['w', 0x5362f8e4, 0xe3500002, 'cmp r0, #2'],
  ['b', 0x5362f8e8, 0x0a, 0x5362fc14, 'beq 0x5362fc14'],
  ['w', 0x5362f8ec, 0xe3500001, 'cmp r0, #1'],
  ['b', 0x5362f8f0, 0x0a, 0x53630004, 'beq 0x53630004'],
  ['w', 0x53630120, 0xe5c43021, 'strb r3, [r4, #0x21] (direction 0 after vote 1)'],
  ['w', 0x5363027c, 0xe5c43021, 'strb r3, [r4, #0x21] (direction 1 after vote 2)'],
  ['w', 0x5362c1c8, 0xe1a0c00d, 'the vote starts here'],
  ['w', 0x5362fa60, 0xe5943c78, 'ldr r3, [r4, #0xc78]'],
  ['w', 0x5362fa74, 0xe1690983, 'smulbb sb, r3, sb'],
  ['w', 0x536304c4, 0xe1a04000, 'mov r4, r0'],
  ['w', 0x536304d0, 0xe5d43022, 'ldrb r3, [r4, #0x22]'],
  ['w', 0x536304d4, 0xe3a00000, 'mov r0, #0'],
  ['w', 0x536304d8, 0xe1a05001, 'mov r5, r1'],
  ['w', 0x536304dc, 0xe1530000, 'cmp r3, r0'],
  ['w', 0x536304e4, 0xe5c40009, 'strb r0, [r4, #9]'],
  ['b', 0x536304e8, 0x0a, 0x53630548, 'beq 0x53630548'],
  ['w', 0x53630524, 0xe1a03007, 'mov r3, r7 (the speed of the move)'],
  ['b', 0x53630534, 0xeb, 0x5360d9a8, 'bl 0x5360d9a8'],
  ['w', 0x5360d9e0, 0xe58d2000, 'str r2, [sp] (amount)'],
  ['w', 0x5360d9e8, 0xe58d3004, 'str r3, [sp, #4] (speed)'],
  ['w', 0x5360d9e4, 0xe3a02c89, 'mov r2, #0x8900'],
  ['w', 0x53951160, 0xe58c30e0, 'str r3, [ip, #0xe0] (speed kept for the lens task)'],
  ['w', 0x53952fe4, 0xe891000e, 'ldm r1, {r1, r2, r3}'],
  ['b', 0x53952ff0, 0xea, 0x53951b04, 'b 0x53951b04'],
  ['b', 0x5361a8e0, 0xeb, 0x5360dfa8, 'speed slot from lens property 0x8251 (no wobbleFast / wobbleMid)'],
  ['b', 0x5361a8c0, 0xeb, 0x5360dfc8, 'speed slot from lens property 0x8255 (no wobbleDrive)'],
  ['w', 0x5362a7c8, 0x31c020be, 'strhlo r2, [r0, #0xe] (no wobbleDriveMax)'],
  ['w', 0x536304fc, 0xe3a01003, 'mov r1, #3 (no wobbleKind1)'],
  ['w', 0x5363056c, 0xe3a01004, 'mov r1, #4 (no wobbleKind1)'],
  ['w', 0x5362bf84, 0xe3e01903, 'mvn r1, #0xc000 (the sweep amount 0x3fff)'],
  ['w', 0x5362bf90, 0xe18010be, 'strh r1, [r0, lr]'],
  ['w', 0x53951b0c, 0xe5d040d4, 'ldrb r4, [r0, #0xd4]'],
  ['w', 0x53951b1c, 0xe3540000, 'cmp r4, #0'],
  ['w', 0x53951b20, 0xe5c0c1e0, 'strb ip, [r0, #0x1e0] (ordinary motor setting)'],
  ['w', 0x53951b28, 0xe5d0c371, 'ldrb ip, [r0, #0x371]'],
  ['b', 0x53951b2c, 0x1a, 0x53951b8c, 'bne 0x53951b8c'],
  ['w', 0x53951b30, 0xe5d0e078, 'ldrb lr, [r0, #0x78]'],
  ['b', 0x53951b38, 0x1a, 0x53951bac, 'bne 0x53951bac'],
  ['w', 0x53951b3c, 0xe6ffc073, 'uxth ip, r3'],
  ['w', 0x53951b40, 0xe1a0408e, 'lsl r4, lr, #1'],
  ['m', 0x53951b44, 0xe3003000, 0x54211e50, 'movw r3, #lo(0x54211e50): the ordinary limits'],
  ['m', 0x53951bac, 0xe3006000, 0x54211d38, 'movw r6, #lo(0x54211d38): the recording limits'],
  ['w', 0x54211d38, 0x00780078, 'recording limit 120 (no lensQuiet switch)'],
  ['w', 0x54211d3c, 0x00780078, 'recording limit 120'],
  ['w', 0x542120fc, 0x1e1e1e1e, 'recording motor setting 30'],
  ['w', 0x54211e50, 0x07d005dc, 'ordinary limit 1500, 2000'],
  ['w', 0x54211e54, 0x09c409c4, 'ordinary limit 2500, 2500'],
  ['w', 0x54212080, 0x2d2d2d2d, 'ordinary motor setting 45'],
  ['w', 0x536266b8, 0xe5d435c9, 'ldrb r3, [r4, #0x5c9] (not searching)'],
  ['w', 0x536266dc, 0xe1a00005, 'mov r0, r5'],
  ['b', 0x536266e4, 0xea, 0x53626578, 'b 0x53626578 (the monitor\'s result is not used)'],
  ['w', 0x5362209c, 0xe5d935ca, 'ldrb r3, [sb, #0x5ca]'],
  ['b', 0x536220cc, 0xeb, 0x53614584, 'bl 0x53614584'],
  ['w', 0x536145f0, 0xe5d335cc, 'ldrb r3, [r3, #0x5cc]'],
  ['w', 0x53614604, 0xe5d31ce4, 'ldrb r1, [r3, #0xce4]'],
  ['w', 0x53614738, 0xe5950050, 'ldr r0, [r5, #0x50]'],
  ['b', 0x53614744, 0xeb, 0x5360e7b0, 'bl 0x5360e7b0'],
  ['w', 0x5361474c, 0xe3500001, 'cmp r0, #1'],
  ['w', 0x5361475c, 0xe5d335e5, 'ldrb r3, [r3, #0x5e5]'],
  ['w', 0x536147dc, 0xe5950048, 'ldr r0, [r5, #0x48]'],
  ['w', 0x536147e0, 0xe3a01002, 'mov r1, #2'],
  ['w', 0x536147ec, 0xe1a02001, 'mov r2, r1'],
  ['b', 0x536147f0, 0xeb, 0x53609bb0, 'bl 0x53609bb0'],
  ['w', 0x536147fc, 0xe5c305cb, 'strb r0, [r3, #0x5cb]'],
  ['w', 0x53609c50, 0xe1a01002, 'mov r1, r2'],
  ['b', 0x53609c5c, 0xea, 0x53608bdc, 'b 0x53608bdc'],
  ['w', 0x53608bdc, 0xe5903088, 'ldr r3, [r0, #0x88]'],
  ['w', 0x53608c00, 0xe5801088, 'str r1, [r0, #0x88] (the request)'],
  ['w', 0x5361ef84, 0xe5d91cb0, 'ldrb r1, [sb, #0xcb0] (ramp flag of the next search)'],
  ['w', 0x5361ef94, 0xe5c93cb0, 'strb r3, [sb, #0xcb0]'],
  ['w', 0x5360e7b0, 0xe590302c, 'ldr r3, [r0, #0x2c] (lens state)'],
  ['b', 0x5362207c, 0x0a, 0x536220d4, 'beq 0x536220d4 (last search state 2: the still rule)'],
  ['w', 0x53622084, 0xe5d33548, 'ldrb r3, [r3, #0x548] (recording)'],
  ['w', 0x53622088, 0xe3530000, 'cmp r3, #0'],
  ['w', 0x536220d4, 0xe5940060, 'ldr r0, [r4, #0x60]'],
  ['b', 0x536220d8, 0xeb, 0x5361171c, 'bl 0x5361171c (phase computation emptied)'],
  ['b', 0x536220dc, 0xea, 0x53622090, 'b 0x53622090'],
  ['w', 0x536145b0, 0xe1a05000, 'mov r5, r0 (the decision keeps the object in r5)'],
  ['w', 0x536147e8, 0xe1a0300c, 'mov r3, ip'],
  ['w', 0x536147f4, 0xe51b3048, 'ldr r3, [fp, #-0x48]'],
  ['w', 0x536147f8, 0xe51bc04c, 'ldr ip, [fp, #-0x4c]'],
  ['w', 0x53630684, 0xe1d511ba, 'ldrh r1, [r5, #0x1a] (the travel step: amount)'],
  ['w', 0x53630690, 0xe3a03001, 'mov r3, #1'],
  ['b', 0x53630694, 0xeb, 0x536304bc, 'bl 0x536304bc'],
  ['w', 0x5362a924, 0xe3a03001, 'mov r3, #1'],
  ['w', 0x5362a928, 0xe5c03009, 'strb r3, [r0, #9] (the lens has arrived)'],
  ['b', 0x53612554, 0xeb, 0x5362a924, 'bl 0x5362a924 (from the lens callback)'],
  ['w', 0x5360d9bc, 0xe5900014, 'ldr r0, [r0, #0x14] (the lens move: who holds the lens)'],
  ['w', 0x5360d9c4, 0xe1500001, 'cmp r0, r1'],
  ['b', 0x5360d9c8, 0x0a, 0x5360d9d8, 'beq (else return 0: not taken)'],
  ['w', 0x5360d980, 0xe5903014, 'ldr r3, [r0, #0x14] (take the lens)'],
  ['w', 0x5360d984, 0xe3530000, 'cmp r3, #0'],
  ['w', 0x5360d988, 0x05801014, 'streq r1, [r0, #0x14]'],
  ['w', 0x5360de24, 0xe5903014, 'ldr r3, [r0, #0x14] (give the lens back)'],
  ['w', 0x5360de2c, 0xe1530001, 'cmp r3, r1'],
  ['b', 0x5360de3c, 0xeb, 0x5360dde4, 'bl 0x5360dde4 (the lens state)'],
  ['w', 0x5360de58, 0xe5843014, 'str r3, [r4, #0x14] (nobody)'],
  ['w', 0x53626358, 0xe3a01002, 'mov r1, #2 (the movie AF is user 2)'],
  ['b', 0x5362635c, 0xeb, 0x5360d980, 'bl 0x5360d980 (a search begins: the lens is taken)'],
  ['w', 0x53613e1c, 0xe3a01002, 'mov r1, #2'],
  ['b', 0x53613e2c, 0xeb, 0x5360de18, 'bl 0x5360de18 (a search ends: the lens is given back)'],
  // the wobbling module's step cap as the camera has it
  ['w', 0x5362a8ac, 0xe1520003, 'cmp r2, r3'], ['w', 0x5362a8b0, 0x21c421be, 'strhhs r2, [r4, #0x1e]'], ['b', 0x5362a8b4, 0x2a, 0x5362a8c4, 'bhs 0x5362a8c4'],
  ['w', 0x5362a8b8, 0xe3500000, 'cmp r0, #0'], ['w', 0x5362a8bc, 0x11a03002, 'movne r3, r2'], ['w', 0x5362a8c0, 0xe1c431be, 'strh r3, [r4, #0x1e]'],
  // the focus area of mode 8
  ['a', 0x533ae094, 0x533ae120, 'mode 8 frame size: 590 x 380'], ['a', 0x533ae080, 0x533ae0e8, 'mode 3 frame size: 64 x 52'],
  ['a', 0x533ae690, 0x533ae7a4, 'mode 8 area type: 5'], ['a', 0x533ae67c, 0x533ae79c, 'mode 3 area type: 1'],
];

function checkContext(p: Patch): void {
  for (const c of CONTEXT) {
    const at = adr(c[1]), w = p.word(at);
    if (c[0] === 'w') { if (w !== c[2] >>> 0) fail(`unexpected word at 0x${at.toString(16)} (${c[3]})`); }
    else if (c[0] === 'b') { if (w >>> 24 !== c[2] || branchTarget(at, w) !== adr(c[3])) fail(`unexpected branch at 0x${at.toString(16)} (${c[4]})`); }
    else if (c[0] === 'a') { if (w !== adr(c[2])) fail(`unexpected address at 0x${at.toString(16)} (${c[3]})`); }
    else { const v = adr(c[3]) & 0xffff; if (w !== ((c[2] | ((v >>> 12) << 16) | (v & 0xfff)) >>> 0)) fail(`unexpected movw at 0x${at.toString(16)} (${c[4]})`); }
  }
}

export function videoAfModule(): Uint8Array {
  const module = Uint8Array.from(atob(VAFQUICK_CODE), (c) => c.charCodeAt(0));
  if (module.length !== VAFQUICK_CODE_LENGTH) throw new FirmwareError('internal', 'movie AF: embedded module length');
  return module;
}

/** The state pointer's RAM word. */
export function videoAfSlot(): number {
  return places().slot;
}

function callTo(p: Patch, at: number, target: number, what: string): void {
  const word = p.word(at);
  if (word >>> 24 !== 0xeb || branchTarget(at, word) !== target) fail(`unexpected ${what}`);
}

export interface VideoAfLayout {
  ctx: number; code: number; noFiles: number;
  wobbleStub: number; stopStub: number; voteStub: number; monitorStub: number; speedStub: number; lensStub: number; askStub: number;
}

/** The words changed in place and the hooked words (for tests). */
export function videoAfSites(): number[] {
  const a = places();
  return [a.cap, a.cap + 4, a.cap + 8, a.cap + 12, a.cap + 16, a.areaSize, a.areaType, a.wobbleCall, a.stopSlot, a.voteCall, a.monitorCall, a.speedWord, a.lensTest, a.keepPhase, a.askCall];
}

/** Movie AF driven by the phase data (option videoAf). */
export function installVideoAf(p: Patch): VideoAfLayout {
  const a = places();
  callTo(p, a.wobbleCall, a.wobbleStep, 'wobbling step call');
  if (p.word(a.stopSlot) !== a.stopCallback) fail('unexpected movie-state-0 callback');
  callTo(p, a.voteCall, a.vote, 'vote call');
  callTo(p, a.monitorCall, a.monitor, 'standby monitor call');
  if (p.word(a.speedWord) !== 0xe1a07002) fail('unexpected speed word in the wobbling lens move');
  if (p.word(a.lensTest) !== 0xe31c0001) fail('unexpected recording test in the lens relative move');
  const keep = p.word(a.keepPhase);
  if (keep >>> 24 !== 0x1a || branchTarget(a.keepPhase, keep) !== a.phaseReset) fail('unexpected branch to the phase reset');
  callTo(p, a.askCall, a.ask, 'request call in the decision to search again');
  checkContext(p);
  // The wobbling module's step cap: cmp r0,#0; movne r3,r2; lsleq r3,r3,#4; cmp r2,r3; movhi r3,r2 (then strh r3, [r4, #0x1e]).
  const capWords = [0xe3500000, 0x11a03002, 0x01a03203, 0xe1520003, 0x81a03002];
  capWords.forEach((w, i) => p.setWord(a.cap + 4 * i, w, 'movie AF: the wobbling step cap is 16 basic steps (max with speed / 100; with flag + 0xd60 as before)'));
  p.setWord(a.areaSize, a.areaSize3, 'movie AF: focus mode 8 (MovieRecording) gets the 64 x 52 frame of the Select modes');
  p.setWord(a.areaType, a.areaType3, 'movie AF: focus mode 8 (MovieRecording) gets area type 1 (one frame) instead of 5 (auto area)');
  const module = videoAfModule();
  // ctx word 7 (`file_holder`) is set below to a stub that returns 0: no file service, the record stays in RAM.
  const ctx = p.append(u32le([VIDEOAF_MAGIC, a.slot, FLAGS, a.alloc, a.timerHolder, a.tick, a.elapsed, 0, a.wobbleStep, a.lensPosition, a.ask, a.lensState, a.wobbleMove, a.lensTake, a.lensGiveBack]), 16);
  const code = p.append(module, 16);
  const loadCtx = `movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}`;
  const wobbleStub = p.append((at) => assembleWords(
    `push {r4,lr}
     mov r2,r0
     ${loadCtx}
     mov r1,#0
     mov r3,#0
     bl #${code}
     pop {r4,pc}`, at), 16);
  const stopStub = p.append((at) => assembleWords(
    `push {r4,lr}
     mov r4,r0
     bl #${a.stopCallback}
     ${loadCtx}
     mov r1,#1
     mov r2,r4
     mov r3,#0
     bl #${code}
     pop {r4,pc}`, at), 16);
  const voteStub = p.append((at) => assembleWords(
    `push {r4,lr}
     bl #${a.vote}
     mov r2,r0
     ${loadCtx}
     mov r1,#2
     mov r3,#0
     bl #${code}
     pop {r4,pc}`, at), 16);
  // in: r0 = object, r1, r2, r3 = "scene changed" as the monitor takes them; the caller does not use the result
  const monitorStub = p.append((at) => assembleWords(
    `push {r4,r5,r6,lr}
     mov r4,r0
     mov r5,r3
     bl #${a.monitor}
     ${loadCtx}
     mov r1,#3
     mov r2,r4
     mov r3,r5
     bl #${code}
     pop {r4,r5,r6,pc}`, at), 16);
  // in: r4 = wobbling module, r5 = amount, r2 = speed the camera asks, r3 = module + 0x22, r0 = 0; out: r7 = speed, flags of `cmp r3, r0`
  const speedStub = p.append((at) => assembleWords(
    `movw r7,#${a.slot & 65535}
     movt r7,#${a.slot >>> 16}
     ldr r7,[r7]
     cmp r7,#0
     beq #${at + 18 * 4}
     ldrh r7,[r7,#${MARK_OFFSET}]
     cmp r5,r7
     blo #${at + 18 * 4}
     cmp r5,#0x1000
     bhs #${at + 18 * 4}
     mov r7,#${PER_UNIT}
     mul r7,r5,r7
     movw ip,#${FASTEST}
     cmp r7,ip
     movhi r7,ip
     cmp r7,r2
     orrhi r7,r7,#0x8000
     bhi #${at + 19 * 4}
     mov r7,r2
     cmp r3,r0
     bx lr`, at), 16);
  // in: r0 = lens control object, r3 = speed, ip = object + 0x371, lr = object + 0x78; as at 0x53951b34
  const lensStub = p.append((at) => assembleWords(
    `tst r3,#0x8000
     bne #${at + 5 * 4}
     tst ip,#1
     bne #${a.lensQuiet}
     b #${a.lensOrdinary}
     mov r4,lr,lsl #1
     mov ip,r3,lsl #17
     mov ip,ip,lsr #17
     b #${a.lensLimits}`, at), 16);
  // in: r5 = object, r0 .. r3 = the request's arguments (object + 0x48, 2, 2, 0); out: r0 = what the request returns, or 0 when the module says no
  const askStub = p.append((at) => assembleWords(
    `push {r0,r1,r2,r3,r4,lr}
     ${loadCtx}
     mov r1,#4
     mov r2,r5
     mov r3,#0
     bl #${code}
     cmp r0,#0
     pop {r0,r1,r2,r3,r4,lr}
     moveq r0,#0
     bxeq lr
     b #${a.ask}`, at), 16);
  const noFiles = p.append((at) => assembleWords('mov r0,#0;bx lr', at), 16);
  p.setWord(ctx + 28, noFiles, 'movie AF: no file service (the record of each recording is not written to the card)');
  const bl = (at: number, to: number) => (0xeb000000 | (((to - (at + 8)) >> 2) & 0xffffff)) >>> 0;
  const b = (at: number, to: number) => (0xea000000 | (((to - (at + 8)) >> 2) & 0xffffff)) >>> 0;
  p.setWord(a.wobbleCall, bl(a.wobbleCall, wobbleStub), 'movie AF: the wobbling step of a recording goes through the module');
  p.setWord(a.stopSlot, stopStub, 'movie AF: the module hears when the recording ends');
  p.setWord(a.voteCall, bl(a.voteCall, voteStub), 'movie AF: the travel state\'s vote goes through the module');
  p.setWord(a.monitorCall, bl(a.monitorCall, monitorStub), 'movie AF: after the standby monitor the module may step the lens or ask for a new search');
  p.setWord(a.speedWord, bl(a.speedWord, speedStub), 'movie AF: the one step the module names asks the ordinary lens speed and marks it');
  p.setWord(a.lensTest, b(a.lensTest, lensStub), 'movie AF: a marked relative move takes the ordinary branch while recording');
  p.setWord(a.askCall, bl(a.askCall, askStub), 'movie AF: the camera\'s own decision to search again asks the module first');
  p.setWord(a.keepPhase, 0xe1a00000, 'movie AF: a scene change while recording no longer empties the phase computation (the still rule alone)');
  return { ctx, code, noFiles, wobbleStub, stopStub, voteStub, monitorStub, speedStub, lensStub, askStub };
}
