// SPDX-License-Identifier: GPL-2.0-only
/**
 * The small assembler against clang: every source snippet the reference implementation assembled
 * for three configurations (1, 2 and 8 added ratios), with the bytes clang 18 produced for it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, branchTarget, branchWord, encodeImmediate, movImmediate, movWord } from '../src/fw/aspect/arm';

interface Snippet { address: number; source: string; hex: string }
const corpus = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fw-helpers', 'aspect-asm.json'), 'utf8')) as Snippet[];

describe('aspect: assembler', () => {
  it(`matches clang on ${corpus.length} snippets`, () => {
    expect(corpus.length).toBeGreaterThan(300);
    const bad: string[] = [];
    for (const s of corpus) {
      let got: string;
      try {
        got = Buffer.from(assemble(s.source, s.address)).toString('hex');
      } catch (e) {
        got = String(e);
      }
      if (got !== s.hex) bad.push(`0x${s.address.toString(16)} ${s.source.slice(0, 80)}\n  want ${s.hex.slice(0, 80)}\n  got  ${got.slice(0, 80)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
  it('refuses what it does not know', () => {
    for (const src of ['nop', 'mov r0,#0x12345', 'ldr r0,=1', 'add r0,r1', 'b nowhere', 'mov r16,r0', 'ldrh r0,[r1,r2]', 'push {}', 'x: x: mov r0,r0', 'movw r0,#0x10000', 'blx r0', 'strb r0,[r1,#4096]']) {
      expect(() => assemble(src, 0x54000000), src).toThrow();
    }
    expect(() => assemble('mov r0,r0', 0x54000002)).toThrow();
    expect(() => assemble('b #0x58000004', 0x54000000)).toThrow();
  });
  it('helpers', () => {
    expect(encodeImmediate(0)).toBe(0);
    expect(encodeImmediate(0xff)).toBe(0xff);
    expect(encodeImmediate(0x100)).toBe(0xc01);
    expect(encodeImmediate(0x2d0)).toBe(0xe2d);
    expect(encodeImmediate(0x101)).toBeNull();
    expect(branchWord(0x5388c7dc, 0x543fa580)).toBe(0xea2db767);
    expect(branchTarget(0x5388c7dc, 0xea2db767)).toBe(0x543fa580);
    expect(branchTarget(0x533e1c04, branchWord(0x533e1c04, 0x543e7200))).toBe(0x543e7200);
    expect(movWord(3, 0x7230)).toBe(0xe3073230);
    expect(movWord(3, 0x543e, true)).toBe(0xe345343e);
    expect(movImmediate(0xe30b3034)).toBe(0xb034);
  });
});
