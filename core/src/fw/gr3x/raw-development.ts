// SPDX-License-Identifier: GPL-2.0-only
import { branchWord, wordsToBytes } from '../aspect/arm';
import { alignedCrop, parseRatio } from '../aspect/geometry';
import { gr3xMaxId } from './geometry';
import type { Gr3xProgram } from './image-pipeline';
const addr = (r: string, v: number) => `movw ${r},#${v & 65535};movt ${r},#${v >>> 16};`;

export function installGr3xRawDevelopment(p: Gr3xProgram) {
  // IIIx transient menu codes: 0 = unchanged, 1 = 3:2, 2 = square, 3.. = custom (identity - 1).
  const code = (id: number) => id === 0 ? 1 : id === 3 ? 2 : id - 1;
  const max = gr3xMaxId(p.menu);
  const sizes = p.menu.map(r => ({ id: r.id, ...alignedCrop(6000,4000,parseRatio(r.ratio))! }));
  const pointers = Array.from({ length: 256 }, (_, id) => {
    const source = sizes.find(s => s.id === id);
    const targets = source ? sizes.filter(t => t.width <= source.width && t.height <= source.height).map(t => code(t.id)) : [1,2];
    return p.append(Uint8Array.from([targets.length,...targets]));
  });
  const table = p.append(wordsToBytes(pointers));
  const packet = `ldr r3,[r0,#0x24];ldrb r3,[r3,#0x7b6];${addr('r2',table)}ldr r2,[r2,r3,lsl #2];`;
  const hook = (site: number, expected: number, s: string) => {
    const at = p.code(s);p.patch(site,expected,branchWord(site,at),'IIIx RAW development: retain and select supported crop identities');return at;
  };
  const count = hook(0x5328330c,0xe5902024,packet + 'ldrb r1,[r0,#5];ldrb r0,[r2];cmp r1,#0;addne r0,r0,#1;bx lr;');
  const item = hook(0x532833e4,0xe5d03005,
    'ldrb r3,[r0,#5];cmp r3,#0;beq source;cmp r1,#0;moveq r0,#0;bxeq lr;sub r1,r1,#1;source:' + packet +
    'ldrb r3,[r2];cmp r1,r3;movhs r0,#0;bxhs lr;add r2,r2,#1;ldrb r0,[r2,r1];bx lr;');
  const reverse = hook(0x53289e8c,0xe3510001,
    `cmp r1,#3;blo native;cmp r1,#${max - 1};addls r0,r1,#1;bxls lr;native:cmp r1,#1;b #0x53289e90;`);
  hook(0x53289af4,0xe3520000,
    `cmp r2,#4;blo native;cmp r2,#${max};subls r0,r2,#1;bls #0x53289b14;native:cmp r2,#0;b #0x53289af8;`);
  hook(0x5328a000,0xe3530003,
    `cmp r0,#4;blo native;cmp r0,#${max};movls r1,r0;bls #0x5328a00c;native:cmp r3,#3;b #0x5328a004;`);
  // Custom settings observe the same shooting-mode restriction as native aspects.
  hook(0x5355445c,0xe3510000,
    `cmp r1,#4;blo native;cmp r1,#${max};bls #0x53554484;native:cmp r1,#0;b #0x53554460;`);
  return { rawCount:count,rawItem:item,rawReverse:reverse,rawPackets:table };
}
