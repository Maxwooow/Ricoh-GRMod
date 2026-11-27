// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60 (round 10, with films): the two Custom entries (the photo sets 1 and 2, the
 * wrench icons) of the still Image Control lists placed before the films instead of after them.
 *
 * Both lists put the looks of ImageControlModel's list at entries 0..n-1 and Custom 1 / Custom 2 at n
 * and n + 1 (n: the model's count, look-layout.ts), each time by comparing an entry with n:
 *   - the Image Control menu row's list (its member functions in the row table 0x53b39d54..: text
 *     0x531a0538, icon 0x531a0690, "is the current one" 0x531a1500, select 0x531a0ba0; the count
 *     0x531a0514 is n + 2), entered with the entry in r1;
 *   - the icon strip (this + 0x174): filled by 0x531ab7e4 (looks, then the two Customs, through the
 *     strip's item getter 0x53394758), its entry read back from the strip (0x53394820) by the name
 *     line 0x531ab750 and the selection 0x531ab998, and "is entry e the current one" 0x531abe0c (r2).
 * Here the entries the lists show are mapped to the camera's: shown entry P is Custom 1, P + 1
 * Custom 2, the looks before P stay, the ones from P on move down by two (`forward`); the strip's
 * filling and the menu row's icon function (which draws in the ADJ lever's list) go the other way
 * (`inverse`: the camera's entry i is drawn at the shown one). P is the
 * number of looks the list shows before the first film. Only for the still list (the model's byte
 * +0x1b is 0); the movie and RAW development lists, and the detail screen's look selector (looks
 * only, 0x531aeab4), are as before. The count is not changed.
 */
import { branchWord } from '../aspect/arm';
import { FirmwareError } from '../types';
import { adr, adrHex } from './target';
import { gr3xLiveQuery } from './look-layout';

const fail = (code: string, m: string): never => { throw new FirmwareError(code, `IIIx Custom entries: ${m}`); };

/** Entries of the menu row's list functions (each begins `mov ip,sp`). */
const MENU_FUNCTIONS = () => [adr(0x531a0538), adr(0x531a0690), adr(0x531a1500), adr(0x531a0ba0)];
/** The strip's "is entry r2 the current one" (`mov ip,sp`). */
const STRIP_IS_CURRENT = () => adr(0x531abe0c);
/** `bl` to the strip's entry getter (0x53394820): the name line, the selection. */
const STRIP_READS = () => [adr(0x531ab764), adr(0x531ab9ac)];
/** `bl` to the strip's item getter (0x53394758) for look i, Custom 1, Custom 2. */
const STRIP_FILLS = () => [adr(0x531ab854), adr(0x531ab884), adr(0x531ab8ac)];
/** `bl` to the strip's item getter in the menu row's icon function (the entry's item of this + 0x1f0). */
const MENU_ICON_ITEM = () => adr(0x531a06f0);

export interface Gr3xCustomPositionProgram {
  code(source: string): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  /** The original word at an address. */
  u32(address: number): number;
}

/** `position`: the number of looks shown before the two Custom entries (the looks before the first film). */
/** `live`: the order kept in the camera (films.c -DLIVE_LAYOUT): the module maps the entries first (ll_query op 3). */
export function installGr3xCustomPosition(p: Gr3xCustomPositionProgram, position: number, live = false) {
  if (!Number.isInteger(position) || position < 0 || position > 250) fail('internal', 'position');
  const singleton = adr(0x5320ad88), model = adr(0x5320ba9c), count = adr(0x532c2a9c);
  const getEntry = adr(0x53394820), getItem = adr(0x53394758);
  // The camera's code as audited.
  for (const at of [...MENU_FUNCTIONS(), STRIP_IS_CURRENT()]) if (p.u32(at) !== 0xe1a0c00d) fail('unexpected-instruction', `entry at ${at.toString(16)}`);
  for (const at of STRIP_READS()) if (p.u32(at) !== branchWord(at, getEntry, 14, true)) fail('unexpected-instruction', `strip read at ${at.toString(16)}`);
  for (const at of STRIP_FILLS()) if (p.u32(at) !== branchWord(at, getItem, 14, true)) fail('unexpected-instruction', `strip fill at ${at.toString(16)}`);
  // map(r0 = entry, r1 = 0 forward / 1 inverse) -> r0; every other register kept, the flags not.
  const map = p.code(`push {r1,r2,r3,r4,ip,lr};mov r4,r0;bl #${singleton};bl #${model};ldrb r1,[r0,#0x1b];cmp r1,#0;bne same;
    ${live ? `ldr r1,[sp];${gr3xLiveQuery(3, 'r4', 'r1', 'mstatic')}mov r4,r0;b same;mstatic:bl #${singleton};bl #${model};` : ''}
    bl #${count};mov r2,#${position};cmp r2,r0;bhs same;ldr r1,[sp];cmp r1,#0;bne inv;
    cmp r4,r2;blo same;beq c1;add r3,r2,#1;cmp r4,r3;beq c2;add r3,r0,#2;cmp r4,r3;bhs same;sub r4,r4,#2;b same;
    c1:mov r4,r0;b same;c2:add r4,r0,#1;b same;
    inv:cmp r4,r2;blo same;cmp r4,r0;addlo r4,r4,#2;blo same;beq i1;add r3,r0,#1;cmp r4,r3;addeq r4,r2,#1;b same;
    i1:mov r4,r2;
    same:mov r0,r4;pop {r1,r2,r3,r4,ip,lr};bx lr;`);
  const menu = MENU_FUNCTIONS().map(at => {
    const stub = p.code(`push {r0,r2,r3,lr};mov r0,r1;mov r1,#0;bl #${map};mov r1,r0;pop {r0,r2,r3,lr};mov ip,sp;b #${at + 4};`);
    p.patch(at, 0xe1a0c00d, branchWord(at, stub), 'Custom entries before the films: the Image Control list\'s entry');
    return stub;
  });
  const isCurrent = (() => {
    const at = STRIP_IS_CURRENT();
    const stub = p.code(`push {r0,r1,r3,lr};mov r0,r2;mov r1,#0;bl #${map};mov r2,r0;pop {r0,r1,r3,lr};mov ip,sp;b #${at + 4};`);
    p.patch(at, 0xe1a0c00d, branchWord(at, stub), 'Custom entries before the films: the strip\'s current entry');
    return stub;
  })();
  const read = p.code(`push {r4,lr};bl #${getEntry};mov r1,#0;bl #${map};pop {r4,pc};`);
  for (const at of STRIP_READS()) p.patch(at, branchWord(at, getEntry, 14, true), branchWord(at, read, 14, true), 'Custom entries before the films: the strip\'s entry');
  // Where the strip draws an entry: the camera's entry i at the shown one (`inverse`).
  const fill = p.code(`push {r0,r2,r3,lr};mov r0,r1;mov r1,#1;bl #${map};mov r1,r0;pop {r0,r2,r3,lr};b #${getItem};`);
  for (const at of STRIP_FILLS()) p.patch(at, branchWord(at, getItem, 14, true), branchWord(at, fill, 14, true), 'Custom entries before the films: where the strip draws an entry');
  // The menu row's icon function also draws its entry's icon in a list (the ADJ lever's Image Control
  // list, this + 0x1f0): the icon is the camera's entry's, drawn at the shown entry (`inverse` again).
  const iconItem = MENU_ICON_ITEM();
  if (p.u32(iconItem) !== branchWord(iconItem, getItem, 14, true)) fail('unexpected-instruction', `menu icon item at ${iconItem.toString(16)}`);
  p.patch(iconItem, branchWord(iconItem, getItem, 14, true), branchWord(iconItem, fill, 14, true), 'Custom entries before the films: where the ADJ list draws an entry');
  void adrHex;
  return { customMap: map, customMenu: menu, customIsCurrent: isCurrent, customRead: read, customFill: fill, customIconItem: iconItem, customPosition: position };
}
