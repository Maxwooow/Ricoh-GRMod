// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: halation as one switch for the whole firmware (extra `halationSwitch`),
 * as GR IV's `halationAll` (../gr4v120/aspect/halation-all.ts, build.ts) as far as GR III's films
 * allow. GR IV's switch gives every look, the camera's own and the added ones, the Halation row and
 * the JPEG step's halation; off, no look has any. GR III's looks with halation are its films only
 * (the camera's own looks stay without: out of scope, see the image-pipeline study, section 6), so:
 *
 *  - absent: the films of round 10 as they are (every film has the Halation and Colour rows,
 *    halation-rows.ts, and the 0.8.2 module, white the 0.8.2 glow at every level), byte for byte;
 *  - on (true): the same rows for every film, the JPEG step runs the halation module of GR Mod 0.9
 *    (../aspect/halation-code.ts, the module GR IV's builds install; the same C source and compiler
 *    as the 0.8.2 one, halation-code-089.ts, and the same `struct ctx` but for its word 9), and the
 *    context gets the `struct scatter` it reads there: white's Weak and Medium are the diffusion
 *    filter (Black Pro-Mist 1/8, 1/4), white's Strong the glow from a lower start (150) with its own
 *    light table per film; red is unchanged. As GR IV's switch, a black-and-white film (grey preset,
 *    `monoLook`) takes white whatever its Colour row says (GR IV: `stashAsm({ mono })`);
 *  - off (false): no halation anywhere: no Halation / Colour rows (and none of their texts and
 *    icons), no module at the JPEG step (Execute's entry is the official one, or the date imprint's
 *    when that is built). A film's parameter screen then shows Standard's lines, the lines the
 *    camera's own default case gives any look it does not know (GetBaseKindDetailControl
 *    0x531aca98: looks 11..22 through a jump table, any other look the assert at 0x531acbbc, which
 *    logs ImageControlDetailController.cpp line 0x375, then column 0). That default case is not
 *    left to the assert: a film of this build in photo set 0..2 gets column 0 directly (the hook
 *    halation-rows.ts puts at the same word for its columns 36 + set); any other look goes on to
 *    the official default case. Column 0 is Standard's lines in every set (the table 0x53b3488c is
 *    indexed 12 x set + column), the lines halation-rows.ts copies before its two rows.
 *    The film's Toning byte (films-r10.ts: its Halation state) stays in the settings and in the
 *    maker note as before; nothing shows or uses it.
 *
 * GR IV's switch needs an added slot (the module of the added looks keeps the factory looks'
 * settings); GR III's needs a film (the rows and the module are the films'). GR IV's also adds the
 * Halation row to RAW development and to the factory looks (not here). GR IV shows Halation as one
 * row with a submenu (Fn), GR III as two rows (halation-rows.ts): its Grain Effect has no submenu.
 *
 * Where the module runs (jpeg-stage.ts): at JpegEncodeMacroProcess::Execute's entry, on the finished
 * YCbCr pictures, as on GR IV. Both cameras give it pictures whose colour is final, so the scatter's
 * knee (0.55 of white in linear light) and the light tables mean the same on both: a table takes a
 * pixel's value back to the level the camera's Standard gives the same grey (halationLight). GR III
 * applies its saturation matrices before the tone curves and GR IV after; the tables are made from
 * grey, which the look's matrices leave grey (rows summing to 1), so the order does not enter them.
 * They are the same function of the film's curves and post-curve matrix as the 0.8.2 table round 7
 * already installs (only the start differs: 150 instead of 220).
 */
import { FirmwareError } from '../types';
import { branchWord, wordsToBytes } from '../aspect/arm';
import { HALATION_CODE, HALATION_CODE_LENGTH } from '../aspect/halation-code';
import { HALATION, scatterParams, scatterTables } from '../aspect/halation';
import type { HalationLight } from '../aspect/halation';
import { adr } from './target';

const FIRST = 64;
/** GetBaseKindDetailControl's default case (`b` to the assert), the assert, the common return. */
const BASE_DEFAULT = adr(0x531acb24), BASE_DEFAULT_TARGET = adr(0x531acbbc), BASE_RETURN = adr(0x531acb5c);
/** 'HSC1', `struct scatter` in tools/halation/halation.c. */
const SCATTER_MAGIC = 0x31435348;
const E_MAX = 16384;

const fail = (m: string): never => { throw new FirmwareError('unexpected-instruction', `IIIx halation switch: ${m}`); };

export interface Gr3xHalationSwitchProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  u32(address: number): number;
}

/** Off: a film of this build (sets 0..2) gets Standard's lines (column 0) without the assert. */
export function installGr3xHalationOff(p: Gr3xHalationSwitchProgram, films: number) {
  if (!Number.isInteger(films) || films < 1 || films > 20) fail('number of films');
  // cmp r4,#0xb; ldrls pc,[pc,r4,lsl #2]; b default (r4 = look - 11, r6 the controller); the return
  // `sub sp,fp,#0x18`; the default case `str r5,[sp]` (then the assert with r0 = 0, column 0).
  const guards: readonly (readonly [number, number])[] = [
    [BASE_DEFAULT - 8, 0xe354000b], [BASE_DEFAULT - 4, 0x979ff104], [BASE_DEFAULT, branchWord(BASE_DEFAULT, BASE_DEFAULT_TARGET)],
    [BASE_RETURN, 0xe24bd018], [BASE_DEFAULT_TARGET, 0xe58d5000], [BASE_DEFAULT_TARGET + 0x20, 0xe3a00000],
  ];
  for (const [at, w] of guards) if (p.u32(at) !== w >>> 0) fail(`guard at ${at.toString(16)}`);
  const base = p.code(`sub r0,r4,#${FIRST - 11};cmp r0,#${films - 1};bhi native;ldrb r0,[r6,#0x199];cmp r0,#2;bhi native;
    mov r0,#0;b #${BASE_RETURN};native:b #${BASE_DEFAULT_TARGET};`);
  p.patch(BASE_DEFAULT, branchWord(BASE_DEFAULT, BASE_DEFAULT_TARGET), branchWord(BASE_DEFAULT, base), 'halation off: a film\'s parameter lines are Standard\'s');
  return { halationOffBase: base };
}

const u16le = (v: readonly number[]) => { const b = new Uint8Array(v.length * 2), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint16(i * 2, x, true)); return b; };

/** GR Mod 0.9's module (white's scatter when the context has a `struct scatter`). */
export function gr3xHalationModule09(): Uint8Array {
  const raw = Uint8Array.from(atob(HALATION_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== HALATION_CODE_LENGTH || raw.length % 4 !== 0) throw new FirmwareError('internal', 'halation module length');
  return raw;
}

/**
 * `struct scatter` for the films' context word 9 (as ../aspect/halation.ts installHalationModule):
 * its tables, Strong's light of each film (in the order of the context's entries), the struct.
 */
export function appendGr3xHalationScatter(append: (bytes: Uint8Array) => number, light: readonly HalationLight[]): number {
  if (light.some(l => !(l.strong instanceof Uint16Array) || l.strong.length !== 256 || l.strong.some(v => v > E_MAX)))
    throw new FirmwareError('internal', 'IIIx halation: Strong white light of the films');
  if (HALATION.whiteStrong.gain <= 0) throw new FirmwareError('internal', 'IIIx halation: Strong white gain');
  const T = scatterTables(), SP = scatterParams();
  const lin = append(u16le(Array.from(T.lin)));
  const expand = append(u16le(Array.from(T.expand)));
  const srgb = append(T.srgb);
  const strong = append(u16le(light.flatMap(l => Array.from(l.strong!))));
  return append(new Uint8Array([
    ...wordsToBytes([SCATTER_MAGIC]),
    ...u16le([...SP.k, ...SP.rad, ...SP.weight, SP.strongGain, 0]),
    ...wordsToBytes([lin, expand, srgb, strong]),
  ]));
}

/**
 * On: the development adapter's stash level (image-control.ts, round 10), at `level:` with r1 the
 * level (0..3), r0 the white bit so far, ip the film's index (0..films - 1): a black-and-white film's
 * halation is white (as GR IV's `stashAsm({ mono })`). Flags only (the adapter restores them).
 */
export function gr3xMonoWhiteAsm(monoFilms: readonly boolean[]): string {
  const mono = monoFilms.flatMap((m, k) => (m ? [k] : []));
  if (!mono.length) return '';
  return `cmp r1,#0;beq monodone;${mono.map(k => `cmp ip,#${k};orreq r0,r0,#0x20000;`).join('')}monodone:`;
}
