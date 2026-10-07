// SPDX-License-Identifier: GPL-2.0-only
/**
 * A very small ARM (A32) assembler: exactly the instruction forms the aspect-ratio hooks are
 * written in, nothing else. Anything it does not know is an error, never a guess.
 *
 * The reference implementation hands these same source strings to clang; the tests assemble every
 * snippet of the reference with both and require identical bytes.
 *
 * Syntax: statements separated by ';' or newline; `label:` (optionally followed by an instruction);
 * registers r0-r15, sb, sl, fp, ip, sp, lr, pc; immediates `#123`, `#0x7b`, `#-4`; branch targets
 * are a label or an absolute address (`b #0x53153EEC`, `bl #1413457364`).
 */
import { FirmwareError } from '../types';

const REGS: Record<string, number> = { sb: 9, sl: 10, fp: 11, ip: 12, sp: 13, lr: 14, pc: 15 };
for (let i = 0; i < 16; i++) REGS['r' + i] = i;

const CONDS: Record<string, number> = {
  eq: 0, ne: 1, cs: 2, hs: 2, cc: 3, lo: 3, mi: 4, pl: 5, vs: 6, vc: 7, hi: 8, ls: 9, ge: 10, lt: 11, gt: 12, le: 13, al: 14, '': 14,
};

/** Data-processing opcodes; `kind` says which operands the mnemonic takes. */
const DP: Record<string, { op: number; kind: 'rd-rn-op2' | 'rd-op2' | 'rn-op2' }> = {
  and: { op: 0, kind: 'rd-rn-op2' }, eor: { op: 1, kind: 'rd-rn-op2' }, sub: { op: 2, kind: 'rd-rn-op2' }, rsb: { op: 3, kind: 'rd-rn-op2' },
  add: { op: 4, kind: 'rd-rn-op2' }, adc: { op: 5, kind: 'rd-rn-op2' }, sbc: { op: 6, kind: 'rd-rn-op2' }, orr: { op: 12, kind: 'rd-rn-op2' },
  bic: { op: 14, kind: 'rd-rn-op2' }, mov: { op: 13, kind: 'rd-op2' }, mvn: { op: 15, kind: 'rd-op2' },
  cmp: { op: 10, kind: 'rn-op2' }, cmn: { op: 11, kind: 'rn-op2' }, tst: { op: 8, kind: 'rn-op2' }, teq: { op: 9, kind: 'rn-op2' },
};
const SHIFTS: Record<string, number> = { lsl: 0, lsr: 1, asr: 2, ror: 3 };

/** Mnemonics that take a condition suffix (and, for data processing, an optional `s` before it). */
const BASES = [
  'umull', 'movw', 'movt', 'ldrb', 'ldrh', 'strb', 'strh', 'uxtb', 'vldr', 'push', 'pop', 'mrs', 'msr', 'mul', 'ldr', 'str',
  ...Object.keys(DP),
];

function fail(message: string): never {
  throw new FirmwareError('asm', message);
}

function reg(text: string): number {
  const r = REGS[text.trim().toLowerCase()];
  if (r === undefined) fail(`not a register: ${text}`);
  return r;
}

function num(text: string): number {
  const t = text.trim();
  if (!/^-?(0x[0-9a-f]+|[0-9]+)$/i.test(t)) fail(`not a number: ${text}`);
  const neg = t.startsWith('-');
  const v = Number(neg ? t.slice(1) : t);
  if (!Number.isSafeInteger(v)) fail(`number out of range: ${text}`);
  return neg ? -v : v;
}

function imm(text: string): number {
  const t = text.trim();
  if (!t.startsWith('#')) fail(`expected an immediate: ${text}`);
  return num(t.slice(1));
}

/** ARM "modified immediate": the encoding with the smallest rotation, as clang emits; null if none. */
export function encodeImmediate(value: number): number | null {
  const v = value >>> 0;
  for (let rot = 0; rot < 16; rot++) {
    const r = rot * 2;
    const x = r === 0 ? v : ((v << r) | (v >>> (32 - r))) >>> 0;
    if (x < 256) return (rot << 8) | x;
  }
  return null;
}

/** Split at top-level commas (not inside [] or {}). */
function operands(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

interface Mnemonic { base: string; s: boolean; cond: number }

function splitMnemonic(m: string): Mnemonic {
  // Branches first: `bls` is b+ls, `blo` is b+lo, `bleq` is bl+eq, `bxeq` is bx+eq.
  if (m.startsWith('b') && !m.startsWith('bic')) {
    for (const base of ['b', 'bl', 'bx']) {
      const rest = m.slice(base.length);
      if (m.startsWith(base) && rest in CONDS) return { base, s: false, cond: CONDS[rest] };
    }
    fail(`unknown mnemonic: ${m}`);
  }
  for (const base of BASES) {
    if (!m.startsWith(base)) continue;
    let rest = m.slice(base.length);
    if (rest in CONDS) return { base, s: false, cond: CONDS[rest] };
    if (base in DP && rest.startsWith('s')) {
      rest = rest.slice(1);
      if (rest in CONDS) return { base, s: true, cond: CONDS[rest] };
    }
  }
  return fail(`unknown mnemonic: ${m}`);
}

/** Shifter operand of a data-processing instruction, from the operand strings after Rd/Rn. */
function operand2(ops: string[]): number {
  if (ops.length === 1 && ops[0].startsWith('#')) {
    const enc = encodeImmediate(imm(ops[0]));
    if (enc === null) fail(`immediate cannot be encoded: ${ops[0]}`);
    return (1 << 25) | enc;
  }
  if (ops.length === 1) return reg(ops[0]);
  if (ops.length === 2) {
    const m = /^(lsl|lsr|asr|ror)\s*#\s*(\d+)$/i.exec(ops[1]);
    if (!m) fail(`unsupported shift: ${ops[1]}`);
    const type = SHIFTS[m[1].toLowerCase()];
    let amount = Number(m[2]);
    if (type === 0 ? !(amount >= 0 && amount <= 31) : type === 3 ? !(amount >= 1 && amount <= 31) : !(amount >= 1 && amount <= 32)) fail(`shift amount out of range: ${ops[1]}`);
    if (amount === 32) amount = 0;
    return (amount << 7) | (type << 5) | reg(ops[0]);
  }
  return fail('bad operand');
}

interface Mem { rn: number; pre: boolean; up: boolean; immediate: number | null; rm: number; shift: number }

/** `[rn]`, `[rn,#imm]`, `[rn,rm]`, `[rn,rm,lsl #n]`, and post-indexed `[rn],#imm` (two operands). */
function memory(ops: string[]): Mem {
  const first = ops[0];
  if (!first.startsWith('[') || !first.endsWith(']')) fail(`expected a memory operand: ${first}`);
  const inner = operands(first.slice(1, -1));
  const rn = reg(inner[0]);
  if (ops.length === 2) {
    if (inner.length !== 1) fail('bad post-indexed operand');
    const v = imm(ops[1]);
    return { rn, pre: false, up: v >= 0, immediate: Math.abs(v), rm: 0, shift: 0 };
  }
  if (ops.length !== 1) fail('bad memory operand');
  if (inner.length === 1) return { rn, pre: true, up: true, immediate: 0, rm: 0, shift: 0 };
  if (inner[1].startsWith('#')) {
    if (inner.length !== 2) fail('bad memory operand');
    const v = imm(inner[1]);
    return { rn, pre: true, up: v >= 0, immediate: Math.abs(v), rm: 0, shift: 0 };
  }
  let shift = 0;
  if (inner.length === 3) {
    const m = /^lsl\s*#\s*(\d+)$/i.exec(inner[2]);
    if (!m) fail(`unsupported index shift: ${inner[2]}`);
    shift = Number(m[1]);
    if (!(shift >= 0 && shift <= 31)) fail('index shift out of range');
  } else if (inner.length !== 2) fail('bad memory operand');
  return { rn, pre: true, up: true, immediate: null, rm: reg(inner[1]), shift };
}

function regList(text: string): number {
  if (!text.startsWith('{') || !text.endsWith('}')) fail(`expected a register list: ${text}`);
  let mask = 0;
  for (const part of text.slice(1, -1).split(',')) {
    const range = part.split('-');
    if (range.length === 1) mask |= 1 << reg(range[0]);
    else if (range.length === 2) {
      const a = reg(range[0]);
      const b = reg(range[1]);
      if (b < a) fail(`bad register range: ${part}`);
      for (let r = a; r <= b; r++) mask |= 1 << r;
    } else fail(`bad register list: ${text}`);
  }
  if (mask === 0) fail('empty register list');
  return mask;
}

/** `B`/`BL` from `at` to `target` (both absolute addresses). */
export function branchWord(at: number, target: number, cond = 14, link = false): number {
  const delta = target - at - 8;
  if (delta % 4 !== 0 || !(delta >= -(1 << 25) && delta < 1 << 25)) fail(`branch target out of range: 0x${at.toString(16)} -> 0x${target.toString(16)}`);
  return ((cond << 28) | (link ? 0x0b000000 : 0x0a000000) | ((delta >> 2) & 0xffffff)) >>> 0;
}

/** Destination of the `B`/`BL` word found at `at`. */
export function branchTarget(at: number, word: number): number {
  if ((word & 0x0e000000) !== 0x0a000000) fail(`not a branch at 0x${at.toString(16)}`);
  let d = word & 0xffffff;
  if (d & 0x800000) d -= 0x1000000;
  return at + 8 + d * 4;
}

/** `MOVW rd,#imm16` (or `MOVT` with `high`). */
export function movWord(rd: number, value: number, high = false, cond = 14): number {
  if (!(value >= 0 && value <= 0xffff)) fail('MOVW/MOVT immediate out of range');
  return ((cond << 28) | (high ? 0x03400000 : 0x03000000) | ((value & 0xf000) << 4) | (rd << 12) | (value & 0xfff)) >>> 0;
}

/** The 16-bit immediate of a `MOVW`/`MOVT` word. */
export function movImmediate(word: number): number {
  return ((word >>> 4) & 0xf000) | (word & 0xfff);
}

function encode(m: Mnemonic, ops: string[], at: number, labels: Map<string, number>): number {
  const c = m.cond << 28;
  const need = (n: number): void => {
    if (ops.length !== n) fail(`${m.base}: expected ${n} operands, got ${ops.length}`);
  };
  switch (m.base) {
    case 'b':
    case 'bl': {
      need(1);
      const t = ops[0];
      let target: number;
      if (t.startsWith('#')) target = num(t.slice(1));
      else if (/^(0x[0-9a-f]+|[0-9]+)$/i.test(t)) target = num(t);
      else {
        const l = labels.get(t);
        if (l === undefined) fail(`unknown label: ${t}`);
        target = l;
      }
      return branchWord(at, target, m.cond, m.base === 'bl');
    }
    case 'bx':
      need(1);
      return (c | 0x012fff10 | reg(ops[0])) >>> 0;
    case 'movw':
    case 'movt': {
      need(2);
      return movWord(reg(ops[0]), imm(ops[1]), m.base === 'movt', m.cond);
    }
    case 'mul': {
      need(3);
      return (c | (reg(ops[0]) << 16) | (reg(ops[2]) << 8) | 0x90 | reg(ops[1])) >>> 0;
    }
    case 'umull': {
      need(4);
      return (c | 0x00800000 | (reg(ops[1]) << 16) | (reg(ops[0]) << 12) | (reg(ops[3]) << 8) | 0x90 | reg(ops[2])) >>> 0;
    }
    case 'ldr':
    case 'str':
    case 'ldrb':
    case 'strb': {
      if (ops.length < 2) fail(`${m.base}: missing operands`);
      const rd = reg(ops[0]);
      const mem = memory(ops.slice(1));
      const load = m.base.startsWith('ldr') ? 1 << 20 : 0;
      const byte = m.base.endsWith('b') ? 1 << 22 : 0;
      let w = c | 0x04000000 | load | byte | (mem.pre ? 1 << 24 : 0) | (mem.up ? 1 << 23 : 0) | (mem.rn << 16) | (rd << 12);
      if (mem.immediate !== null) {
        if (mem.immediate > 0xfff) fail(`${m.base}: offset out of range`);
        w |= mem.immediate;
      } else w |= (1 << 25) | (mem.shift << 7) | mem.rm;
      return w >>> 0;
    }
    case 'ldrh':
    case 'strh': {
      if (ops.length < 2) fail(`${m.base}: missing operands`);
      const rd = reg(ops[0]);
      const mem = memory(ops.slice(1));
      if (mem.immediate === null || mem.immediate > 0xff) fail(`${m.base}: unsupported addressing`);
      const load = m.base === 'ldrh' ? 1 << 20 : 0;
      return (c | (mem.pre ? 1 << 24 : 0) | (mem.up ? 1 << 23 : 0) | (1 << 22) | load | (mem.rn << 16) | (rd << 12) | ((mem.immediate & 0xf0) << 4) | 0xb0 | (mem.immediate & 0xf)) >>> 0;
    }
    case 'push':
    case 'pop': {
      need(1);
      const mask = regList(ops[0]);
      const single = (mask & (mask - 1)) === 0;
      if (single) {
        const r = 31 - Math.clz32(mask);
        // One register: `str r,[sp,#-4]!` / `ldr r,[sp],#4`, as assemblers encode it.
        return (c | (m.base === 'push' ? 0x052d0004 : 0x049d0004) | (r << 12)) >>> 0;
      }
      return (c | (m.base === 'push' ? 0x092d0000 : 0x08bd0000) | mask) >>> 0;
    }
    case 'mrs': {
      need(2);
      const src = ops[1].toLowerCase();
      if (src !== 'apsr' && src !== 'cpsr') fail(`mrs: unsupported source ${ops[1]}`);
      return (c | 0x010f0000 | (reg(ops[0]) << 12)) >>> 0;
    }
    case 'msr': {
      need(2);
      const dst = ops[0].toLowerCase();
      if (dst !== 'apsr_nzcvq' && dst !== 'cpsr_f') fail(`msr: unsupported destination ${ops[0]}`);
      return (c | 0x0128f000 | reg(ops[1])) >>> 0;
    }
    case 'uxtb':
      need(2);
      return (c | 0x06ef0070 | (reg(ops[0]) << 12) | reg(ops[1])) >>> 0;
    case 'vldr': {
      need(2);
      const sm = /^s(\d+)$/i.exec(ops[0]);
      if (!sm || Number(sm[1]) > 31) fail(`vldr: unsupported register ${ops[0]}`);
      const s = Number(sm[1]);
      const mem = memory([ops[1]]);
      if (mem.immediate === null || !mem.pre || mem.immediate % 4 !== 0 || mem.immediate > 1020) fail('vldr: unsupported addressing');
      return (c | 0x0d100a00 | (mem.up ? 1 << 23 : 0) | ((s & 1) << 22) | (mem.rn << 16) | ((s >> 1) << 12) | (mem.immediate >> 2)) >>> 0;
    }
    default: {
      const d = DP[m.base];
      if (!d) fail(`unknown mnemonic: ${m.base}`);
      if (d.kind === 'rd-rn-op2') {
        if (ops.length < 3) fail(`${m.base}: missing operands`);
        return (c | (d.op << 21) | (m.s ? 1 << 20 : 0) | (reg(ops[1]) << 16) | (reg(ops[0]) << 12) | operand2(ops.slice(2))) >>> 0;
      }
      if (d.kind === 'rd-op2') {
        if (ops.length < 2) fail(`${m.base}: missing operands`);
        return (c | (d.op << 21) | (m.s ? 1 << 20 : 0) | (reg(ops[0]) << 12) | operand2(ops.slice(1))) >>> 0;
      }
      if (ops.length < 2) fail(`${m.base}: missing operands`);
      if (m.s) fail(`${m.base}: no s form`);
      return (c | (d.op << 21) | (1 << 20) | (reg(ops[0]) << 16) | operand2(ops.slice(1))) >>> 0;
    }
  }
}

/** Assemble `source` for loading at `address`. Returns little-endian instruction words. */
export function assembleWords(source: string, address: number): number[] {
  if (address % 4 !== 0) fail('unaligned address');
  const statements: { text: string; at: number }[] = [];
  const labels = new Map<string, number>();
  let at = address;
  for (const raw of source.split(/[;\n]/)) {
    let text = raw.trim();
    for (;;) {
      const m = /^([A-Za-z_.$][\w.$]*):\s*/.exec(text);
      if (!m) break;
      if (labels.has(m[1])) fail(`label defined twice: ${m[1]}`);
      labels.set(m[1], at);
      text = text.slice(m[0].length);
    }
    if (text === '') continue;
    statements.push({ text, at });
    at += 4;
  }
  return statements.map(({ text, at: where }) => {
    const sp = text.search(/\s/);
    const mn = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
    return encode(splitMnemonic(mn), operands(rest), where, labels);
  });
}

export function wordsToBytes(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return out;
}

export function assemble(source: string, address: number): Uint8Array {
  return wordsToBytes(assembleWords(source, address));
}
