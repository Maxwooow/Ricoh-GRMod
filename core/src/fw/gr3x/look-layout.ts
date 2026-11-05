// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60, round 8 (as GR Mod 0.8.4, ../aspect/looks.ts): the Image Control menu
 * order and hidden looks.
 *
 * GR III builds its lists from ImageControlModel (Model/ImageControlModel.cpp): the value count
 * (0x532c2a9c), the look of list entry i (0x532c2c80, GetImageControlFromUserDataValues) and the
 * entry of a look (0x532c2f08, GetImageControlIndexFromUserDataValues; the count when the look is
 * not in the list). Every list reads them: the Image Control list and the ADJ lever's, the movie
 * Image Control list and RAW development's. The model's byte +0x1b says which: 0 still (Image
 * Control and ADJ), 1 movie (set from the shooting mode, 0x531a0154 / 0x531ab4d4 / 0x531acd54),
 * 2 RAW development (RawDevelopmentModel, 0x5327f110). Per active set (0..2) the camera has a table
 * of the looks, all alike: still and RAW development twelve looks (0x53b59224, 0x53b58fcc,
 * 0x53b5919c), movie ten (0x53b59234, 0x53b591c8, 0x53b5936c: no Soft Monotone, no HDR Tone);
 * only the three functions read them. Films (looks 64..) are in the still list only (as up to round
 * 7: image-control-research.ts).
 *
 * With a layout, the three functions answer from three tables made here, for the byte's three
 * values: the layout's order without the hidden looks, of the looks the list has (still: the
 * camera's twelve and the films; movie: its ten; RAW development: the twelve). The count follows
 * (the movie count is the immediate of `movls r0,#10`, 0x532c2ae0; still / RAW development the
 * branch of 0x532c2acc, as the films' count was). Anything else (another byte value, an entry past
 * the count) goes to the camera's code as before. The widget allocation (0x532c2b7c) keeps its
 * largest count. A hidden look selected in the standard photo or movie set becomes Standard at
 * start, power off and mode recall (guard.ts; films: native/slots3.c -DHIDDEN_FILMS keeps its
 * values); Standard (11) cannot be hidden.
 */
import { branchWord } from '../aspect/arm';
import { FirmwareError } from '../types';

/** The camera's lists in its own order (the tables above). */
export const GR3X_STILL_LOOKS: readonly number[] = [11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21];
export const GR3X_MOVIE_LOOKS: readonly number[] = [11, 12, 13, 15, 16, 22, 17, 18, 19, 21];
export const GR3X_FIRST_FILM_LOOK = 64;

export interface Gr3xLookLayout {
  /** Looks in menu order: a permutation of the camera's twelve and the build's films (64..63 + n). */
  order: readonly number[];
  /** Looks hidden from the lists (never Standard, 11). */
  hidden: readonly number[];
}

const COUNT = 0x532c2a9c, COUNT_STILL = 0x532c2acc, COUNT_MOVIE = 0x532c2ae0, ITEM = 0x532c2c80, INDEX = 0x532c2f08;
/** RawDevelopmentModel's own count of its Image Control values (`mov r0,#12; bx lr`): the range of
 * RAW development's Image Control dial, whose entries come from ITEM with the byte 2. */
const RAW_COUNT = 0x53283c08;
const STILL_TABLES = [0x53b59224, 0x53b58fcc, 0x53b5919c], MOVIE_TABLES = [0x53b59234, 0x53b591c8, 0x53b5936c];
const fail = (code: string, m: string): never => { throw new FirmwareError(code, `IIIx look layout: ${m}`); };
const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const addr = (r: string, a: number) => `movw ${r},#${lo(a)};movt ${r},#${hi(a)};`;

/** The movie list's count (`movls r0,#10`). */
export const GR3X_MOVIE_COUNT = COUNT_MOVIE;

export function gr3xFactoryLookOrder(films: number): number[] {
  return [...GR3X_STILL_LOOKS, ...Array.from({ length: films }, (_, k) => GR3X_FIRST_FILM_LOOK + k)];
}

export function validateGr3xLookLayout(layout: Gr3xLookLayout, films: number): void {
  if (!layout || !Array.isArray(layout.order) || !Array.isArray(layout.hidden)) fail('bad-look-layout', 'order and hidden looks are required');
  if (!Number.isInteger(films) || films < 0 || films > 20) fail('internal', 'films');
  const expected = gr3xFactoryLookOrder(films);
  if (layout.order.length !== expected.length || new Set(layout.order).size !== expected.length || layout.order.some(id => !expected.includes(id)))
    fail('bad-look-layout', `the order must hold each of ${expected.join(', ')} once`);
  if (new Set(layout.hidden).size !== layout.hidden.length || layout.hidden.some(id => !expected.includes(id))) fail('bad-look-layout', 'hidden looks');
  if (layout.hidden.includes(11)) fail('bad-look-layout', 'Standard (11) must stay visible');
}

/** True for the camera's order with nothing hidden (such a layout changes nothing and is not built). */
export function isGr3xFactoryLayout(layout: Gr3xLookLayout, films: number): boolean {
  const f = gr3xFactoryLookOrder(films);
  return layout.hidden.length === 0 && layout.order.length === f.length && layout.order.every((v, i) => v === f[i]);
}

/** The three lists: still (Image Control, ADJ), movie, RAW development. Round 10: the films are in the movie list too. */
export function gr3xLookLists(layout: Gr3xLookLayout, films: number, round10 = false) {
  validateGr3xLookLayout(layout, films);
  const shown = layout.order.filter(id => !layout.hidden.includes(id));
  return {
    still: shown,
    movie: shown.filter(id => GR3X_MOVIE_LOOKS.includes(id) || (round10 && id >= GR3X_FIRST_FILM_LOOK)),
    raw: shown.filter(id => GR3X_STILL_LOOKS.includes(id)),
  };
}

export interface Gr3xLookLayoutProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  /** The original word at an address (the camera's, before any patch). */
  u32(address: number): number;
  read(address: number, size: number): Uint8Array;
}

/** The camera's code and tables this relies on (checked before anything is changed). */
export function checkGr3xLookLayoutSites(p: Pick<Gr3xLookLayoutProgram, 'u32' | 'read'>): void {
  const guards: readonly (readonly [number, number])[] = [
    [COUNT, 0xe1a0c00d], [COUNT + 0x18, 0xe5d4301b], [COUNT + 0x24, 0xe21340fd], [COUNT_STILL - 4, 0xe3500002], [COUNT_STILL, 0x93a0000c], [COUNT_STILL + 4, 0x8a00001d],
    [COUNT_MOVIE - 4, 0xe3500002], [COUNT_MOVIE, 0x93a0000a], [COUNT_MOVIE + 4, 0x9afffffa],
    [ITEM, 0xe1a0c00d], [ITEM + 4, 0xe92dd870], [ITEM + 0x58, 0xe5d5301b],
    [INDEX, 0xe1a0c00d], [INDEX + 4, 0xe92dd870], [INDEX + 0x28, 0xe5d4001b],
    [RAW_COUNT, 0xe3a0000c], [RAW_COUNT + 4, 0xe12fff1e],
  ];
  for (const [at, w] of guards) if (p.u32(at) !== w >>> 0) fail('unexpected-instruction', `guard at ${at.toString(16)}`);
  for (const t of STILL_TABLES) if ([...p.read(t, 12)].join() !== GR3X_STILL_LOOKS.join()) fail('unexpected-layout', `still look table ${t.toString(16)}`);
  for (const t of MOVIE_TABLES) if ([...p.read(t, 10)].join() !== GR3X_MOVIE_LOOKS.join()) fail('unexpected-layout', `movie look table ${t.toString(16)}`);
}

/**
 * The lists of a layout. `films`: the build's films (their entries come from here too: in a build
 * with films this replaces image-control-research.ts's count, entry and reverse lookups).
 */
export function installGr3xLookLayout(p: Gr3xLookLayoutProgram, layout: Gr3xLookLayout, films: number, round10 = false) {
  checkGr3xLookLayoutSites(p);
  const L = gr3xLookLists(layout, films, round10);
  if (!L.still.length || !L.movie.length || !L.raw.length || L.still.length > 255 || L.movie.length > GR3X_MOVIE_LOOKS.length + (round10 ? films : 0)) fail('internal', 'list lengths');
  const still = p.append(Uint8Array.from(L.still)), movie = p.append(Uint8Array.from(L.movie)), raw = p.append(Uint8Array.from(L.raw));
  // Count: still (byte 0) or RAW development (2); r3 holds the byte, the flags are those of `cmp r0,#2`.
  const count = p.code(`bhi #${COUNT_STILL + 4};cmp r3,#0;moveq r0,#${L.still.length};movne r0,#${L.raw.length};b #${COUNT_STILL + 8};`);
  p.patch(COUNT_STILL, 0x93a0000c, branchWord(COUNT_STILL, count), 'look layout: still / RAW development list count');
  p.patch(COUNT_MOVIE, 0x93a0000a, (0x93a00000 | L.movie.length) >>> 0, 'look layout: movie list count');
  // RAW development's dial counts its values itself (twelve): its list's length.
  p.patch(RAW_COUNT, 0xe3a0000c, (0xe3a00000 | L.raw.length) >>> 0, 'look layout: RAW development dial count');
  // Entry i of the list (this = r0, i = r1).
  const item = p.code(`ldrb ip,[r0,#0x1b];cmp ip,#1;beq imovie;cmp ip,#2;beq iraw;cmp ip,#0;bne inative;
    cmp r1,#${L.still.length};bhs inative;${addr('ip', still)}ldrb r0,[ip,r1];bx lr;
    imovie:cmp r1,#${L.movie.length};bhs inative;${addr('ip', movie)}ldrb r0,[ip,r1];bx lr;
    iraw:cmp r1,#${L.raw.length};bhs inative;${addr('ip', raw)}ldrb r0,[ip,r1];bx lr;
    inative:mov ip,sp;b #${ITEM + 4};`);
  p.patch(ITEM, 0xe1a0c00d, branchWord(ITEM, item), 'look layout: entry of the list');
  // The entry of look r1, or the count when the list does not have it (as the camera's).
  const index = p.code(`ldrb ip,[r0,#0x1b];cmp ip,#1;beq xmovie;cmp ip,#2;beq xraw;cmp ip,#0;bne xnative;
    ${addr('r2', still)}mov r3,#${L.still.length};b xsearch;
    xmovie:${addr('r2', movie)}mov r3,#${L.movie.length};b xsearch;
    xraw:${addr('r2', raw)}mov r3,#${L.raw.length};
    xsearch:mov r0,#0;xloop:cmp r0,r3;bhs xdone;ldrb ip,[r2,r0];cmp ip,r1;beq xdone;add r0,r0,#1;b xloop;xdone:bx lr;
    xnative:mov ip,sp;b #${INDEX + 4};`);
  p.patch(INDEX, 0xe1a0c00d, branchWord(INDEX, index), 'look layout: entry of a look');
  return { lookLayoutCount: count, lookLayoutItem: item, lookLayoutIndex: index, lookLayoutStill: still, lookLayoutMovie: movie, lookLayoutRaw: raw };
}
