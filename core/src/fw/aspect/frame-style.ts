// SPDX-License-Identifier: GPL-2.0-only
/** One shared frame identity capture for halation and the date/LUT imprint. */
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord } from './build';

/** Existing zeroed scratch word immediately before the slot-parameter state. */
export const FRAME_STYLE_STASH = 0x558372e4;
const captured = new WeakMap<Patch, number>();

export function installFrameStyleCapture(p: Patch, extraCount: number): void {
  if (captured.get(p) === extraCount) return;
  if (captured.has(p)) throw new Error('frame style capture installed with another slot count');
  const site = 0x539113f8;
  expectWord(p, site, 0xe5d3279c);
  const map = extraCount > 0 ? `sub ip,r2,#34;cmp ip,#${extraCount - 1};movls r2,#18;` : '';
  const stub = p.append((at) => assembleWords(
    `push {r0,r1};ldrb r0,[r3,#0x79c];ldrb r1,[r3,#0x7a6];orr r0,r0,r1,lsl #8;orr r0,r0,#0x10000;
     movw r1,#${FRAME_STYLE_STASH & 65535};movt r1,#${FRAME_STYLE_STASH >>> 16};str r0,[r1];pop {r0,r1};
     ldrb r2,[r3,#0x79c];${map}b #${site + 4}`, at), 16);
  p.setWord(site, branchWord(site, stub), 'frame identity: preserve the developed look for JPEG effects');
  captured.set(p, extraCount);
}
