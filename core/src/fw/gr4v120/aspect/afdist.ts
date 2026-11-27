// SPDX-License-Identifier: GPL-2.0-only
/**
 * The focus distance while autofocusing (test builds only, `TestOptions.afDistance`; GR IV 1.20 and 1.21): the
 * camera's distance scale is shown in the autofocus settings while an autofocus is asked for, and the distance is
 * written under it as a number. NOT YET TRIED ON A CAMERA: whether the distance the camera keeps follows the lens
 * after an autofocus is what the first test build is for.
 *
 * What the camera has (1.20 addresses).
 *  - The shooting screen (LiveViewController) builds 0x5E views from a table (0x53DBFFBC, 0x18 bytes a view: the
 *    type, x, y, width, height, the parent's number; built by 0x53184428, called at 0x5318BB90; the view factory is
 *    0x535AD1B4). View 0 is the root; the first 0x30 are the screen's items: item i's view is at screen + 0x15C +
 *    4 i, its place for each of the four layouts in 0x53DBF9BC, and a function (table 0x53DBF798) shows or hides it
 *    at every update of the screen.
 *  - Item 26 is the manual focus distance scale (view type 4, constructor 0x53592D24, 60 x 200 at the left edge,
 *    allocated with 0x128 bytes at 0x535AD788). Its function (0x53189E30) decides by the Focus setting (settings byte
 *    0xC1D, in the screen's record + 0x998): manual focus always; 10 and 11 when the depth of field is known; the
 *    autofocus settings (0..4, 14, 15, the case at 0x5318A0F0) only while the autofocus was started the way that
 *    sets byte 0xC of the focus request state (0x5324105C; 0x533AEAAC sets it) and record + 0x549 is set. When
 *    shown it updates the scale (0x53593040) with the focus distance in mm (record + 0x6E8, a copy of the live
 *    record's + 0x6B8, which the app's own "move the lens to a distance" 0x533ACB20 compares with what it wants
 *    before it moves the lens; 30000 is the far end) and the depth of field. All its paths leave through
 *    0x53189E58 (r4 the screen, r6 the view, r5 shown or not).
 *  - The focus request state has a byte for each way an autofocus is asked for: 8 the half-press (the shooting
 *    screen reads it for its focus frames, 0x533ACE38), 0xB, 0xC, 0xD and 0x11 the others, 0x12 "started for the
 *    half-press"; every one starts the autofocus through 0x533ACC90.
 *
 * The change.
 *  - The scale in the autofocus settings: the case at 0x5318A0F0 first looks at the bytes 8, 0xB, 0xD, 0x11 and
 *    0x12; with one of them set the scale is shown (the function's "show" 0x53189F88), else the camera's own test.
 *  - The number: a small text view (type 0, the kind the screen's own small texts are) is made when the screen has
 *    built its views, as a child of the root view. Its address and what it shows are kept in three words after the
 *    scale's view (allocated with 0x134 bytes; the scale's constructor 0x53592D24 clears them, in every screen that
 *    has a scale). A view does not free its children: a screen frees the views of its table (0x531844E8), and the
 *    scale's destructor (0x535925A8) frees the scale's own children one by one. The number is freed there too,
 *    before the scale's base destructor, the way those are (the view's deleting destructor). Where item 26's function leaves,
 *    the module (tools/afdist/afdist.c) shows it with the scale in the autofocus settings, 2 px in and 202 px
 *    down from the scale's place in the layout, with the distance: "0.35M", "1.8M", "12M", "INF"; with distances
 *    in feet "13.8IN", "5.9FT", "41FT". (Capitals: the camera's own texts of this kind have no small letters.)
 *
 * No state outside the views. 1.21 through the address table.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord, movWord } from './arm';
import { Patch, expectWord, u32le } from './build';
import { AFDIST_CODE, AFDIST_CODE_LENGTH } from './afdist-code';
import { adr } from '../target';

export const AFDIST_MAGIC = 0x41464453; // "SDFA" (bytes)

/** The shooting screen: its view table, the call that builds the views, the places of the items, the item functions. */
const LV_VIEWS = adr(0x53dbffbc);
const LV_BUILD_CALL = adr(0x5318bb90);
const BUILD_VIEWS = adr(0x53184428);
const LV_LAYOUT = adr(0x5318bbb0);
const LV_PLACES = adr(0x53dbf9bc);
const LV_ITEMS = adr(0x53dbf798);
const SCALE_ITEM = 26;
/** Item 26's function: the autofocus settings' case, "show", "hide", the way out. */
const SCALE_FN = adr(0x53189e30);
const SCALE_AF_CASE = adr(0x5318a0f0);
const SCALE_SHOW = adr(0x53189f88);
const SCALE_HIDE = adr(0x53189ec8);
const SCALE_EXIT = adr(0x53189e58);
/** The scale's allocation in the view factory: mov r0, #0x128. */
const SCALE_ALLOC = adr(0x535ad788);
const SCALE_CTOR = adr(0x53592d24);
const SCALE_BYTES = 0x128;
/** In the constructor: str r5, [r4, #0xec] (r5 = 0), the first of the children's addresses. In the destructor: mov r0, r4 before the base destructor. */
const SCALE_CTOR_CLEARS = adr(0x53592da0);
const SCALE_DTOR = adr(0x535925a8);
const SCALE_DTOR_BASE = adr(0x535926b0);
const VIEW_BASE_DTOR = adr(0x53593234);
/** The focus request state and three of its readers (bytes 8, 0xB, 0x12). */
const FOCUS_REQUESTS = adr(0x5324105c);
const REQUEST_C = adr(0x533ace10);
const REQUEST_READERS: readonly (readonly [number, number])[] = [[adr(0x533ace38), 8], [adr(0x533ace08), 0xb], [adr(0x533ace30), 0x12]];
/** Views. */
const VIEW_FACTORY = adr(0x535ad1b4);
const ADD_CHILD = adr(0x535ab428);
const SET_VISIBLE = adr(0x535acd84);
const SET_TEXT = adr(0x53590490);
const SET_ALIGN = adr(0x5359043c);
const SET_FONT = adr(0x53590458);
const SET_EDGE = adr(0x53590590);
const MOVE = adr(0x535ac024);

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** `feet`: the number in feet and inches (with `distanceFeet`). */
export function installAfDistance(patch: Patch, feet: boolean): void {
  // The views: view 0 the root, item 26 the scale, 60 x 200; the scale's function; its place in the first layout.
  if ((patch.word(LV_VIEWS) & 0xff) !== 1 || (patch.word(LV_VIEWS + SCALE_ITEM * 0x18) & 0xff) !== 4) fail('unexpected-layout', 'focus distance: the shooting screen\'s views are not as expected');
  expectWord(patch, LV_VIEWS + SCALE_ITEM * 0x18 + 0xc, 60);
  expectWord(patch, LV_VIEWS + SCALE_ITEM * 0x18 + 0x10, 200);
  expectWord(patch, LV_ITEMS + SCALE_ITEM * 8, SCALE_FN);
  expectWord(patch, LV_PLACES + SCALE_ITEM * 8, 0);
  expectWord(patch, LV_PLACES + SCALE_ITEM * 8 + 4, 160);
  expectWord(patch, LV_LAYOUT + 0x48, 0xe5d432d4); // ldrb r3, [r4, #0x2d4]: the layout
  expectWord(patch, LV_LAYOUT + 0x60, movWord(2, lo(LV_PLACES))); // the places
  expectWord(patch, LV_BUILD_CALL, branchWord(LV_BUILD_CALL, BUILD_VIEWS, 14, true));
  expectWord(patch, LV_BUILD_CALL + 4, 0xe1a00004); // mov r0, r4: the builder's result is not used
  expectWord(patch, SCALE_ALLOC, 0xe3a00f4a); // mov r0, #0x128
  expectWord(patch, SCALE_ALLOC + 0x14, branchWord(SCALE_ALLOC + 0x14, SCALE_CTOR, 14, true));
  expectWord(patch, SCALE_CTOR_CLEARS - 4, 0xe3a08014); // mov r8, #0x14
  expectWord(patch, SCALE_CTOR_CLEARS, 0xe58450ec); // str r5, [r4, #0xec]
  expectWord(patch, SCALE_CTOR_CLEARS + 4, 0xe58450f0);
  expectWord(patch, SCALE_CTOR + 0x40, 0xe3a05000); // mov r5, #0
  expectWord(patch, SCALE_DTOR, 0xe1a0c00d);
  expectWord(patch, SCALE_DTOR_BASE - 0x18, 0xe5940110); // ldr r0, [r4, #0x110]: the last of the scale's own children
  expectWord(patch, SCALE_DTOR_BASE - 0xc, 0xe5903000); // ldr r3, [r0]
  expectWord(patch, SCALE_DTOR_BASE - 8, 0xe5933004); // ldr r3, [r3, #4]: the deleting destructor
  expectWord(patch, SCALE_DTOR_BASE - 4, 0xe12fff33); // blx r3
  expectWord(patch, SCALE_DTOR_BASE, 0xe1a00004); // mov r0, r4
  expectWord(patch, SCALE_DTOR_BASE + 4, branchWord(SCALE_DTOR_BASE + 4, VIEW_BASE_DTOR, 14, true));
  // Item 26's function.
  expectWord(patch, SCALE_FN, 0xe1a0c00d);
  expectWord(patch, SCALE_FN + 0x20, 0xe591615c); // ldr r6, [r1, #0x15c]: the view
  expectWord(patch, SCALE_EXIT, 0xe24bc030); // sub ip, fp, #0x30
  expectWord(patch, SCALE_EXIT + 4, 0xe1a00006); // mov r0, r6
  expectWord(patch, SCALE_EXIT + 8, 0xe1a01005); // mov r1, r5
  expectWord(patch, SCALE_EXIT + 0x18, branchWord(SCALE_EXIT + 0x18, SET_VISIBLE));
  expectWord(patch, SCALE_HIDE, 0xe3a05000); // mov r5, #0
  expectWord(patch, SCALE_HIDE + 4, branchWord(SCALE_HIDE + 4, SCALE_EXIT));
  expectWord(patch, SCALE_AF_CASE, 0xe1a00009); // mov r0, sb
  expectWord(patch, SCALE_AF_CASE + 4, branchWord(SCALE_AF_CASE + 4, FOCUS_REQUESTS, 14, true));
  expectWord(patch, SCALE_AF_CASE + 8, branchWord(SCALE_AF_CASE + 8, REQUEST_C, 14, true));
  expectWord(patch, SCALE_AF_CASE + 0x10, branchWord(SCALE_AF_CASE + 0x10, SCALE_HIDE, 0));
  expectWord(patch, SCALE_AF_CASE + 0x14, 0xe59434ec); // ldr r3, [r4, #0x4ec]: the screen's record
  expectWord(patch, SCALE_AF_CASE + 0x20, branchWord(SCALE_AF_CASE + 0x20, SCALE_SHOW, 1));
  expectWord(patch, SCALE_AF_CASE - 0x50, 0xe5d33998); // ldrb r3, [r3, #0x998]: the Focus setting
  expectWord(patch, SCALE_SHOW + 0x3c, 0xe59396e8); // ldr sb, [r3, #0x6e8]: the distance, mm
  expectWord(patch, REQUEST_C, 0xe5d0000c);
  for (const [reader, byte] of REQUEST_READERS) expectWord(patch, reader, 0xe5d00000 | byte); // ldrb r0, [r0, #byte]
  for (const f of [BUILD_VIEWS, VIEW_FACTORY, ADD_CHILD, SET_TEXT, MOVE, SCALE_CTOR]) expectWord(patch, f, 0xe1a0c00d);
  expectWord(patch, SET_VISIBLE, 0xe5d0209e); // ldrb r2, [r0, #0x9e]
  expectWord(patch, SET_ALIGN, 0xe5d020ec);
  expectWord(patch, SET_FONT + 4, 0xe5d00108);
  expectWord(patch, SET_EDGE, 0xe5d020f4);

  const module = Uint8Array.from(atob(AFDIST_CODE), (c) => c.charCodeAt(0));
  if (module.length !== AFDIST_CODE_LENGTH) fail('internal', 'focus distance: embedded module length');
  const code = patch.append(module, 16);
  const ctx = patch.append(u32le([AFDIST_MAGIC, VIEW_FACTORY, ADD_CHILD, SET_VISIBLE, SET_TEXT, SET_ALIGN, SET_FONT, SET_EDGE, MOVE, LV_PLACES, feet ? 1 : 0]), 16);
  const loadCtx = `movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}`;

  // The scale's view with three more words (afdist.c: VIEW_WORDS).
  patch.setWord(SCALE_ALLOC, 0xe3a00f4d, 'focus distance: three more words after the distance scale\'s view'); // mov r0, #0x134
  if (SCALE_BYTES + 12 !== 0x134) fail('internal', 'focus distance: the view\'s size');
  const clears = patch.append((at) => assembleWords(
    `str r5, [r4, #0xec]
     str r5, [r4, #${SCALE_BYTES}]; str r5, [r4, #${SCALE_BYTES + 4}]; str r5, [r4, #${SCALE_BYTES + 8}]
     b #${SCALE_CTOR_CLEARS + 4}`, at), 16);
  patch.setWord(SCALE_CTOR_CLEARS, branchWord(SCALE_CTOR_CLEARS, clears), 'focus distance: a new distance scale has no number yet');
  const frees = patch.append((at) => assembleWords(
    `ldr r0, [r4, #${SCALE_BYTES}]
     cmp r0, #0; beq done
     mov r3, #0; str r3, [r4, #${SCALE_BYTES}]
     ldr r3, [r0]; ldr r3, [r3, #4]
     mov lr, pc; bx r3
     done: mov r0, r4
     b #${SCALE_DTOR_BASE + 4}`, at), 16);
  patch.setWord(SCALE_DTOR_BASE, branchWord(SCALE_DTOR_BASE, frees), 'focus distance: the number is freed with the distance scale');
  // The screen has built its views (r1 the views): the number's view.
  const create = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     bl #${BUILD_VIEWS}
     mov r2, r4; mov r1, #0
     ${loadCtx}; bl #${code}
     pop {r4, pc}`, at), 16);
  patch.setWord(LV_BUILD_CALL, branchWord(LV_BUILD_CALL, create, 14, true), 'focus distance: the number\'s view, when the shooting screen has built its views');
  // The autofocus settings: the scale while an autofocus is asked for (half-press and the other ways); else the camera's own test.
  const asked = patch.append((at) => assembleWords(
    `mov r0, sb
     bl #${FOCUS_REQUESTS}
     ldrb r1, [r0, #8]
     ldrb r2, [r0, #0xb]; orr r1, r1, r2
     ldrb r2, [r0, #0xd]; orr r1, r1, r2
     ldrb r2, [r0, #0x11]; orr r1, r1, r2
     ldrb r2, [r0, #0x12]; orrs r1, r1, r2
     bne #${SCALE_SHOW}
     mov r0, sb
     b #${SCALE_AF_CASE + 4}`, at), 16);
  patch.setWord(SCALE_AF_CASE, branchWord(SCALE_AF_CASE, asked), 'focus distance: the distance scale while an autofocus is asked for');
  // The way out of the scale's function (r4 the screen, r6 the scale, r5 shown): the number with it.
  const number = patch.append((at) => assembleWords(
    `mov r2, r4; mov r3, r6
     cmp r5, #0
     moveq r1, #1; movne r1, #2
     ${loadCtx}; bl #${code}
     sub ip, fp, #0x30
     b #${SCALE_EXIT + 4}`, at), 16);
  patch.setWord(SCALE_EXIT, branchWord(SCALE_EXIT, number), 'focus distance: the number under the distance scale');
}
