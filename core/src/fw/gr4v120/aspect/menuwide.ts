// SPDX-License-Identifier: GPL-2.0-only
/**
 * Camera menus of more than 38 lines (firmware 1.20; test 080): the still shooting menu gets room
 * for the lines of soft focus and exposure preview besides the official ones and GR Mod's HDR and
 * date imprint lines.
 *
 * Why 38: the five menu tabs (still, movie, playback, customize, setup) are built once, when the
 * menu is first opened, by TopMenuController's builder (0x531B5494) from five static descriptors
 * listed at 0x55001E78 (0x38C bytes: page titles and first items, the item count at +0x8B, then per
 * item a draw function at +0x8C, a controller id at +0x1BC and a visibility function at +0x254,
 * room for 38 each). The controller (0x13EC bytes, allocated at 0x53188530) keeps a copy of each
 * descriptor, with the items the model does not show left out, at this + 0x230 + tab * 0x38C, in
 * the same layout, so 38 items there too; its list view is created with 38 rows (0x531B3800, one
 * row-kind byte each, read from 0x53B7318C into a 38-byte stack buffer).
 *
 * Read in the official code, everything that touches the item arrays of those copies:
 *  - the builder (writes draw / id / visibility of each item shown; 0x531B5660..0x531B56E8);
 *  - OK on a line (0x531B3648): the id of the line, this + 0x3EC + (tab * 0xE3 + line) * 4;
 *  - drawing the lines (0x531B46E4): the draw function of each, this + tab * 0x38C + 0x2BC + 8 * line.
 * Nothing reads the visibility array back. The item count (+0x8B, a byte), the pages (+0x384, at
 * most 7 seven-line pages; 0x531B449C draws up to 11 page marks) and the per-tab state at
 * this + 0x1B4 + tab * 12 do not depend on 38.
 *
 * What changes (all five tabs, so the builder keeps one layout):
 *  - descriptors: the same header, then room for WIDE_ITEMS items (draw +0x8C, id +0x1DC,
 *    visibility +0x284; 0x3D4 bytes). Five are appended (the still menu one per model, see
 *    `stillMenuForModels`) and the builder hook stores all five at 0x55001E78;
 *  - the builder reads the descriptor's ids and visibility at the new offsets (0x531B5664,
 *    0x531B5684) and stores what it keeps in arrays after the controller's own 0x13EC bytes
 *    (ids at +0x13EC, draw functions at +0x1734, visibility at +0x1DC4, WIDE_ITEMS per tab), the
 *    controller is allocated that much larger (0x2454 bytes);
 *  - OK and the line drawing read those arrays;
 *  - the list view is created with WIDE_ITEMS rows of the same kind (0x13).
 * The old arrays in the controller are left as they are (never written, never read).
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord } from './build';

export const WIDE_ITEMS = 42;
export const OFFICIAL_ITEMS = 38;
const DESCRIPTOR = 0x38c;
const D_DRAW = 0x8c;
const D_ID = 0x1bc;
const D_VISIBLE = 0x254;
export const W_DRAW = 0x8c;
export const W_ID = W_DRAW + WIDE_ITEMS * 8;
export const W_VISIBLE = W_ID + WIDE_ITEMS * 4;
export const WIDE_DESCRIPTOR = W_VISIBLE + WIDE_ITEMS * 8;

const TABS = 5;
const MENU_TABLE = 0x55001e78;
/** The other four tabs' descriptors (movie, playback, customize, setup), as listed at MENU_TABLE. */
const OTHER_TABS = [0x53dc7bd0, 0x53dc783c, 0x53dc6b38, 0x53dc7110] as const;

const ALLOC = 0x53188530; // movw r0, #0x13ec (operator new for TopMenuController)
const OBJECT = 0x13ec;
/** The controller's own arrays, after its official fields: ids, then draw functions, then visibility. */
export const C_ID = OBJECT;
export const C_DRAW = C_ID + TABS * WIDE_ITEMS * 4;
export const C_VISIBLE = C_DRAW + TABS * WIDE_ITEMS * 8;
export const WIDE_OBJECT = C_VISIBLE + TABS * WIDE_ITEMS * 8;

const B_ID_INDEX = 0x531b5664; // add sl, r4, #0x6f (sl = descriptor + (item + 0x6f) * 4: its id)
const B_VISIBLE = 0x531b5684; // add r3, r3, #0x254 (r3 = descriptor + item * 8 + 0x254)
const B_STORE = 0x531b5690; // add r3, r5, #0x11 (first of the stores of an item shown)
const B_STORE_END = 0x531b56ec; // cmp r4, sb
const OK_SITES = [0x531b3664, 0x531b3668, 0x531b366c, 0x531b3670] as const;
const DRAW_BASE = 0x531b4700; // mla r5, r5, sb, r0
const DRAW_COUNT = 0x531b4704; // ldrb r3, [r5, #0x2bb]
const DRAW_KEEP = 0x531b4710; // movne r8, r5
const ROWS_COUNT = 0x531b3860; // mov r2, #0x26
const ROWS_CALL = 0x531b387c; // bl 0x53593C14 (list view: create rows)
const LIST_ROWS = 0x53593c14;
const ROW_KINDS = 0x53b7318c; // 38 x 0x13
const ROW_KIND = 0x13;

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/**
 * The wide copies made in a build: official descriptor -> its appended wide copy. A later addition that
 * changes an item of one of the other tabs (the power-off pictures: Setup's End Screen line) must
 * change the copy, which is what the camera reads once the menus are wide.
 */
const wideCopies = new WeakMap<Patch, Map<number, number>>();

/**
 * Where an item of a menu descriptor is read from: its draw function and its controller id. The
 * official arrays always; with the wide layout installed, also the wide copy's (the one in use).
 */
export function menuItemWords(patch: Patch, descriptor: number, item: number): { draw: number; id: number }[] {
  const out = [{ draw: descriptor + D_DRAW + item * 8, id: descriptor + D_ID + item * 4 }];
  const copy = wideCopies.get(patch)?.get(descriptor);
  if (copy !== undefined) out.push({ draw: copy + W_DRAW + item * 8, id: copy + W_ID + item * 4 });
  return out;
}

/** A descriptor (official layout) in the wide layout. */
export function widen(official: Uint8Array): Uint8Array {
  if (official.length !== DESCRIPTOR) fail('internal', 'menu descriptor: not the official size');
  const count = official[0x8b];
  if (count > OFFICIAL_ITEMS) fail('unexpected-layout', 'menu descriptor: more items than it has room for');
  const d = new Uint8Array(WIDE_DESCRIPTOR);
  d.set(official.subarray(0, D_DRAW));
  for (let i = 0; i < OFFICIAL_ITEMS; i++) {
    d.set(official.subarray(D_DRAW + i * 8, D_DRAW + i * 8 + 8), W_DRAW + i * 8);
    d.set(official.subarray(D_ID + i * 4, D_ID + i * 4 + 4), W_ID + i * 4);
    d.set(official.subarray(D_VISIBLE + i * 8, D_VISIBLE + i * 8 + 8), W_VISIBLE + i * 8);
  }
  return d;
}

/**
 * Install the wide layout. `still` are the appended still-menu descriptors (wide layout) for the
 * GR IV, the HDF and the Monochrome; returns the address of the builder hook's entry (it replaces
 * the builder's first instruction, as `stillMenuForModels` does for the narrow layout).
 */
export function installWideMenus(patch: Patch, still: { gr4: number; hdf: number; mono: number }, model: { app: number; specModel: number; number: number; builder: number }, what: string): void {
  expectWord(patch, ALLOC, 0xe30103ec);
  expectWord(patch, ALLOC + 4, branchWord(ALLOC + 4, 0x539084bc, 14, true));
  expectWord(patch, ALLOC + 12, branchWord(ALLOC + 12, 0x531b57e4, 14, true));
  expectWord(patch, B_ID_INDEX, 0xe284a06f);
  expectWord(patch, B_VISIBLE, 0xe2833f95);
  expectWord(patch, B_STORE, 0xe2853011);
  expectWord(patch, 0x531b56b0, 0xe286ef95); // add lr, r6, #0x254 (the visibility the store copies)
  expectWord(patch, 0x531b56a4, 0xe286108c); // add r1, r6, #0x8c (the draw function it copies)
  expectWord(patch, 0x531b56d4, 0xe59a3000); // ldr r3, [sl] (the id it copies)
  expectWord(patch, 0x531b5698, 0xe51b0034); // ldr r0, [fp, #-0x34] (the tab)
  expectWord(patch, B_STORE_END, 0xe1540009);
  expectWord(patch, OK_SITES[0], 0xe3a030e3);
  expectWord(patch, OK_SITES[1], 0xe0200593);
  expectWord(patch, OK_SITES[2], 0xe0844100);
  expectWord(patch, OK_SITES[3], 0xe59443ec);
  expectWord(patch, DRAW_BASE - 0x14, 0xe3a05fe3); // mov r5, #0x38c
  expectWord(patch, DRAW_BASE, 0xe0250995);
  expectWord(patch, DRAW_COUNT, 0xe5d532bb);
  expectWord(patch, DRAW_KEEP, 0x11a08005);
  expectWord(patch, 0x531b4738, 0xe59532c0); // ldr r3, [r5, #0x2c0]
  expectWord(patch, 0x531b4754, 0x159532b4); // ldrne r3, [r5, #0x2b4]
  expectWord(patch, 0x531b4758, 0x059532b4); // ldreq r3, [r5, #0x2b4]
  expectWord(patch, 0x531b4764, 0xe5d832bb); // ldrb r3, [r8, #0x2bb]
  expectWord(patch, ROWS_COUNT, 0xe3a02026);
  expectWord(patch, ROWS_CALL, branchWord(ROWS_CALL, LIST_ROWS, 14, true));
  const kinds = patch.read(ROW_KINDS, OFFICIAL_ITEMS + 1);
  if (!kinds.subarray(0, OFFICIAL_ITEMS).every((k) => k === ROW_KIND) || kinds[OFFICIAL_ITEMS] !== 0) fail('unexpected-layout', 'menu rows are not as expected');
  const table = new DataView(patch.readMapped(MENU_TABLE, TABS * 4).buffer);
  OTHER_TABS.forEach((d, k) => {
    if (table.getUint32((k + 1) * 4, true) !== d) fail('unexpected-layout', 'menu descriptors are not where they were expected');
  });
  if (WIDE_OBJECT > 0xffff || C_ID > 0xfff + 0x1000) fail('internal', 'menu: controller size');

  // --- Descriptors of the other four tabs, wide.
  const others = OTHER_TABS.map((d) => patch.append(widen(patch.read(d, DESCRIPTOR)), 16));
  wideCopies.set(patch, new Map(OTHER_TABS.map((d, k) => [d, others[k]])));

  // --- Builder: all five descriptors, the still menu's for the model.
  const lo = (v: number): number => v & 0xffff;
  const hi = (v: number): number => v >>> 16;
  const builder = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     bl #${model.app}; bl #${model.specModel}; bl #${model.number}
     movw r1, #${lo(still.hdf)}; movt r1, #${hi(still.hdf)}
     cmp r0, #0
     movweq r1, #${lo(still.gr4)}; movteq r1, #${hi(still.gr4)}
     cmp r0, #2
     movweq r1, #${lo(still.mono)}; movteq r1, #${hi(still.mono)}
     movw r2, #${lo(MENU_TABLE)}; movt r2, #${hi(MENU_TABLE)}
     str r1, [r2]
     ${others.map((d, k) => `movw r1, #${lo(d)}; movt r1, #${hi(d)}; str r1, [r2, #${(k + 1) * 4}]`).join('\n')}
     pop {r0, r1, r2, r3, ip, lr}
     mov ip, sp
     b #${model.builder + 4}`, at), 16);
  patch.setWord(model.builder, branchWord(model.builder, builder), `${what}: menus for this model, wide layout`);

  // --- The controller, larger.
  patch.setWord(ALLOC, 0xe3000000 | ((WIDE_OBJECT & 0xf000) << 4) | (WIDE_OBJECT & 0xfff), `${what}: menu controller with room for ${WIDE_ITEMS} lines a tab`);

  // --- Builder: the descriptor's arrays at the wide offsets, the controller's after its fields.
  patch.setWord(B_ID_INDEX, 0xe284a000 | (W_ID / 4), `${what}: menu builder, ids of the wide descriptor`);
  const visImm = assembleWords(`add r3, r3, #${W_VISIBLE}`, B_VISIBLE)[0];
  patch.setWord(B_VISIBLE, visImm, `${what}: menu builder, visibility of the wide descriptor`);
  // At B_STORE: r0 = whether the item is shown, r5 = lines kept so far, r6 = descriptor + item * 8,
  // sl = the item's id in the descriptor, r7 = the controller, [fp, #-0x34] = the tab. r0..r3, ip
  // and lr are free (the official code uses them as scratch there).
  const store = patch.append((at) => assembleWords(
    `cmp r0, #0
     beq done
     ldr r0, [fp, #-0x34]
     movw ip, #${WIDE_ITEMS}
     mul r1, r0, ip
     add r1, r1, r5
     add r2, r7, #${C_ID & 0xff000}
     add r2, r2, r1, lsl #2
     ldr r3, [sl]
     str r3, [r2, #${C_ID & 0xfff}]
     movw ip, #${C_DRAW}
     add r2, r7, ip
     add r2, r2, r1, lsl #3
     ldr r3, [r6, #${W_DRAW}]; str r3, [r2]
     ldr r3, [r6, #${W_DRAW + 4}]; str r3, [r2, #4]
     movw ip, #${C_VISIBLE}
     add r2, r7, ip
     add r2, r2, r1, lsl #3
     ldr r3, [r6, #${W_VISIBLE}]; str r3, [r2]
     ldr r3, [r6, #${W_VISIBLE + 4}]; str r3, [r2, #4]
     add r5, r5, #1
     done: b #${B_STORE_END}`, at), 16);
  patch.setWord(B_STORE, branchWord(B_STORE, store), `${what}: menu builder, the lines kept`);

  // --- OK: the line's controller id (r4 = this, r5 = tab, r0 = line).
  const okId = patch.append((at) => assembleWords(
    `add r4, r4, #${C_ID & 0xff000}
     ldr r4, [r4, #${C_ID & 0xfff}]
     bx lr`, at), 16);
  patch.setWord(OK_SITES[0], 0xe3a03000 | WIDE_ITEMS, `${what}: menu OK, the line's id`); // mov r3, #WIDE_ITEMS
  patch.setWord(OK_SITES[3], branchWord(OK_SITES[3], okId, 14, true), `${what}: menu OK, the line's id`);

  // --- Drawing the lines: r8 = the tab's block (for the count), r5 = the draw functions - 0x2BC.
  const drawBase = patch.append((at) => assembleWords(
    `mul r8, r5, sb
     add r8, r8, r0
     movw ip, #${WIDE_ITEMS * 8}
     mul r5, ip, sb
     add r5, r5, r0
     movw ip, #${C_DRAW - 0x2bc}
     add r5, r5, ip
     bx lr`, at), 16);
  patch.setWord(DRAW_BASE, branchWord(DRAW_BASE, drawBase, 14, true), `${what}: menu lines, the draw functions`);
  patch.setWord(DRAW_COUNT, 0xe5d832bb, `${what}: menu lines, the count`); // ldrb r3, [r8, #0x2bb]
  patch.setWord(DRAW_KEEP, 0xe1a08008, `${what}: menu lines (r8 set above)`); // mov r8, r8

  // --- List view rows.
  const kindsAt = patch.append(new Uint8Array(WIDE_ITEMS + 2).fill(ROW_KIND).fill(0, WIDE_ITEMS), 4);
  const rows = patch.append((at) => assembleWords(
    `movw r1, #${lo(kindsAt)}; movt r1, #${hi(kindsAt)}
     mov r2, #${WIDE_ITEMS}
     b #${LIST_ROWS}`, at), 16);
  patch.setWord(ROWS_CALL, branchWord(ROWS_CALL, rows, 14, true), `${what}: menu list view with ${WIDE_ITEMS} rows`);
}
