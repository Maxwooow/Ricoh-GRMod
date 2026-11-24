// SPDX-License-Identifier: GPL-2.0-only
/**
 * 4K movies (GR IV firmware 1.20 and 1.21): the movie menu's Frame Rate line becomes
 * "Frame Rate / Resolution", a submenu with the camera's Frame Rate list (60p / 30p / 24p) and a
 * new list, Resolution: FHD / 4K.
 *
 * What the firmware has. A complete 4K path, behind a switch that always answers no (0x538AD500:
 * `mov r0, #0; bx lr`; one of its callers logs "[LVC] for Debug 4K Movie!"). Asked when the live
 * view of a movie is set up:
 *  - the sensor's drive mode (0x536568D4): 60p is mode 4 whatever the answer; 30p is mode 3, or 6
 *    with the switch; 24p is mode 2, or 5 with it (a 4592 x 2584 read-out, 1.35x narrower than the
 *    FHD picture);
 *  - the size recorded (0x538B376C): FHD, or 3840 x 2160 at 30p and 24p with the switch;
 *  - the buffers of the live view (0x53652DBC), at 30p.
 * Camera tests 094 to 097 (hand-patched test firmware, the switch answering yes) on a GR IV 1.21.
 *
 * What is changed:
 *  - the switch answers bit 1 of MOVIE_BYTE, a byte of the user settings that nothing in the
 *    firmware uses (alignment padding before a word; the factory-defaults initialiser, run in an
 *    emulator on all 30 default records of 1.20 and of 1.21, never writes 0x771..0x773). It is
 *    kept with the settings and copied with the user modes; every camera has 0 there: FHD;
 *  - the movie menu's item 12 (Frame Rate): its line shows "4K 30p" / "4K 24p" or the camera's
 *    60p / 30p / 24p under the title "Frame Rate / Resolution", and opens a submenu record of two
 *    lines (as Setup's End Screen in `shutdown.ts`): Frame Rate, which opens the camera's own list
 *    under its own number, and Resolution, a list record made from Frame Rate's;
 *  - the two settings cannot disagree: choosing 4K at 60p sets 30p (the camera's own setter);
 *    choosing 60p sets FHD. The Frame Rate list sets the row under the cursor at once and, left
 *    without OK, the row that was current again; only OK (the record's set function) clears the
 *    bit, so passing over 60p does not lose 4K. The Resolution list has no such functions: its
 *    row is set by OK. Wherever the bit is still set at 60p (the list left another way), it
 *    counts as FHD: the camera's own code records 60p in FHD whatever the switch says, and the
 *    menu shows it so.
 *  - one answer for as long as a live view runs. The switch is asked again later (the size recorded
 *    is set again by 0x5365B8E4, which the live view's sequences call), while the drive mode and
 *    the buffers are those of the live view's start; a setting changed in between would give a 4K
 *    recording from the FHD read-out or the other way round. So the setting is copied into a byte
 *    of the sbrk arena (`battery.ts`) where the live view is started (the call of 0x538B376C at
 *    0x5365BA0C, in 0x5365B9A8, before any of the other three questions), and the switch answers
 *    that byte: zero from start-up until the first live view.
 * After the resolution is changed the camera therefore takes it at the next start of the live
 * view (the shooting mode changed, or the camera switched on).
 *
 * Going back to a firmware without this: the bit means nothing there.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord } from './arm';
import { LANGUAGES, Patch, expectWord, widenTextRows } from './build';
import { LIST_CONTROLLER_ID, SUBMENU_CONTROLLER_ID, TOP_SET_TITLE, addListRecords, addSubmenuRecord, hookControllerFactory, installTexts, listTable, readTexts, submenuTemplate } from './datestamp-menu';
import { menuItemWords } from './menuwide';
import { adr } from '../target';

/** Byte 0x771 of the user settings (0x775 of the settings object): bit 0 the movie shake reduction by sensor shift (`moviesr.ts`), bit 1 4K. */
export const MOVIE_BYTE = adr(0x550832a8) + 4 + 0x771;
export const MOVIE_BYTE_OFFSET = 0x775;
export const MOVIE_SENSOR_SR_BIT = 1;
export const MOVIE_4K_BIT = 2;
export const MOVIE4K_TEXT_IDS = { title: 1044, resolution: 1045, fhd: 1046, uhd: 1047, uhd30: 1048, uhd24: 1049 } as const;
export const FRAME_RATE_MENU_ID = 0x020001e0;
export const RESOLUTION_LIST_ID = 0x020001e1;

const SWITCH = adr(0x538ad500); // the "debug 4K movie" switch
const SWITCH_CALLS = [adr(0x53652dd8), adr(0x53656934), adr(0x53656a20), adr(0x538b3788)] as const;
const MOVIE_SIZE = adr(0x538b376c); // (movie settings object): the size recorded, by the switch and the frame rate
const START_SIZE_CALL = adr(0x5365ba0c); // bl MOVIE_SIZE where the live view is started (0x5365B9A8)
/** "4K in this live view": the byte after the movie shake reduction's (`moviesr.ts`, 0x55839044) in the sbrk arena, zero at start-up. */
export const MOVIE4K_LATCH = adr(0x55839044) + 1;
const SETTINGS = adr(0x550832a8);
const FRAME_RATE = 0x772; // the Frame Rate setting: 0 60p, 1 30p, 2 24p
const FRAME_RATE_SET = adr(0x53332cb0); // (settings, value)
const APP = adr(0x532406a4);
const RESOURCES = adr(0x53240f98);
const GET_SETTINGS = adr(0x53240c38);
const FRAME_RATE_TEXT = adr(0x5338f348); // (resources + 4, frame rate) -> text 301..303
const LINE_VALUE_TEXT = adr(0x5359d740); // (menu line, text)
const SUBMENU_LINE_TEXT = adr(0x535a64b4); // (submenu line, text)
const LIST_TEXT_ROW = adr(0x5359e0ac); // (list item, text)
const LIST_AFTER_SET = adr(0x531daa64);
const MOVIE_MENU = adr(0x53dc7bd0);
const MOVIE_ITEM = 12;
const FRAME_RATE_LIST_ID = 0x020000a0;
const FRAME_RATE_LINE_DRAW = adr(0x531b2a0c);
const FRAME_RATE_TITLE = 299;
/** Frame Rate's list record (57 of the list table) and its handlers. */
const FRAME_RATE_RECORD = 57;
const LIST_RECORD = 0x4c;
const FR_COUNT = adr(0x531d0b24);
const FR_DRAW = adr(0x531d2b80);
const FR_SET = adr(0x531d4d08);
const FR_CURRENT = adr(0x531d66ec);
const FR_SET_CLOSE = adr(0x531dc390); // +0x34: set, then LIST_AFTER_SET
const FR_SET_KEPT = adr(0x531d4d38); // +0x3c: set with the row kept at +0x1a6

/** "Resolution", in `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const RESOLUTION_NAMES: readonly string[] = [
  'Rozlišení', 'Opløsning', 'Resolution', 'Tarkkuus', 'Résolution', 'Auflösung', 'Ανάλυση', 'Felbontás',
  'Risoluzione', '解像度', '해상도', 'Resolutie', 'Rozdzielczość', 'Resolução', 'Разрешение', '分辨率',
  'Resolución', 'Upplösning', 'ความละเอียด', '解析度', 'Çözünürlük',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;
const BYTE = `movw r3, #${lo(MOVIE_BYTE)}; movt r3, #${hi(MOVIE_BYTE)}`;
const RATE = `movw r2, #${lo(SETTINGS + FRAME_RATE)}; movt r2, #${hi(SETTINGS + FRAME_RATE)}; ldrb r2, [r2]`;

/** The texts (before the menus use them): the title is the camera's own "Frame Rate" of each language, " / " and "Resolution". */
export function movie4kTitles(patch: Patch): string[] {
  return readTexts(patch, FRAME_RATE_TITLE).map((rate, k) => `${rate} / ${RESOLUTION_NAMES[k]}`);
}

/**
 * The switch, the texts, the menu line, its submenu and the Resolution list. After every other
 * addition that copies the submenu or the list table (it adds records the same way), and after the
 * menus are made wide when they are (`menuItemWords` then names the copy the camera reads).
 */
export function installMovie4k(patch: Patch): void {
  if (RESOLUTION_NAMES.length !== LANGUAGES) fail('internal', '4K movies: texts');
  // --- The switch and its four callers.
  expectWord(patch, SWITCH, 0xe3a00000); // mov r0, #0
  expectWord(patch, SWITCH + 4, 0xe12fff1e); // bx lr
  for (const call of SWITCH_CALLS) expectWord(patch, call, branchWord(call, SWITCH, 14, true));
  expectWord(patch, MOVIE_SIZE, 0xe1a0c00d);
  expectWord(patch, START_SIZE_CALL - 4, 0xe5c65740); // strb r5, [r6, #0x740]
  expectWord(patch, START_SIZE_CALL, branchWord(START_SIZE_CALL, MOVIE_SIZE, 14, true));
  expectWord(patch, START_SIZE_CALL + 4, 0xe3580001); // cmp r8, #1
  // --- The Frame Rate setting and its line.
  expectWord(patch, FRAME_RATE_SET, 0xe1a0c00d);
  expectWord(patch, FRAME_RATE_LINE_DRAW, 0xe1a0c00d);
  expectWord(patch, FRAME_RATE_LINE_DRAW + 0x30, branchWord(FRAME_RATE_LINE_DRAW + 0x30, FRAME_RATE_TEXT, 14, true));
  expectWord(patch, FRAME_RATE_LINE_DRAW + 0x3c, branchWord(FRAME_RATE_LINE_DRAW + 0x3c, LINE_VALUE_TEXT, 14, true));
  expectWord(patch, FRAME_RATE_LINE_DRAW + 0x44, 0xe300112b); // movw r1, #299
  expectWord(patch, FRAME_RATE_LINE_DRAW + 0x50, branchWord(FRAME_RATE_LINE_DRAW + 0x50, TOP_SET_TITLE));
  expectWord(patch, FRAME_RATE_TEXT, 0xe3510000); // cmp r1, #0
  expectWord(patch, FRAME_RATE_TEXT + 8, 0xe300012d); // movw r0, #301 ("60p")
  // --- Frame Rate's list record: text rows, the set function reached three ways.
  const table = listTable(patch);
  const official = patch.read(table + FRAME_RATE_RECORD * LIST_RECORD, LIST_RECORD);
  const ov = new DataView(official.buffer);
  if (ov.getUint32(0, true) !== 0x00010200 || ov.getUint32(4, true) !== 0 || ov.getUint32(0x0c, true) !== FR_COUNT || ov.getUint32(0x14, true) !== FR_DRAW || ov.getUint32(0x24, true) !== FR_SET
    || ov.getUint32(0x2c, true) !== FR_CURRENT || ov.getUint32(0x34, true) !== FR_SET_CLOSE || ov.getUint32(0x3c, true) !== FR_SET_KEPT || [0x10, 0x18, 0x1c, 0x20, 0x28, 0x30, 0x38, 0x40, 0x44, 0x48].some((off) => ov.getUint32(off, true) !== 0)) {
    fail('unexpected-layout', 'Frame Rate list record is not as expected');
  }
  expectWord(patch, FR_DRAW + 0x40, branchWord(FR_DRAW + 0x40, LIST_TEXT_ROW));
  expectWord(patch, FR_SET, 0xe1a0c00d);
  expectWord(patch, FR_SET + 4, 0xe92dd818); // push {r3, r4, fp, ip, lr, pc}
  expectWord(patch, FR_SET + 0x2c, branchWord(FR_SET + 0x2c, FRAME_RATE_SET));
  expectWord(patch, FR_SET_CLOSE + 0x10, branchWord(FR_SET_CLOSE + 0x10, FR_SET, 14, true));
  expectWord(patch, FR_SET_CLOSE + 0x20, branchWord(FR_SET_CLOSE + 0x20, LIST_AFTER_SET));
  expectWord(patch, FR_SET_KEPT, 0xe5d011a6); // ldrb r1, [r0, #0x1a6]
  expectWord(patch, FR_SET_KEPT + 4, branchWord(FR_SET_KEPT + 4, FR_SET));

  // --- Texts.
  const T = MOVIE4K_TEXT_IDS;
  const same = (text: string): string[] => new Array<string>(LANGUAGES).fill(text);
  widenTextRows(patch, T.uhd24);
  installTexts(patch, [{ id: T.title, names: movie4kTitles(patch) }, { id: T.resolution, names: RESOLUTION_NAMES }, { id: T.fhd, names: same('FHD') }, { id: T.uhd, names: same('4K') },
    { id: T.uhd30, names: same('4K 30p') }, { id: T.uhd24, names: same('4K 24p') }]);

  // --- The switch: 4K chosen, as it was when this live view was started (the call there has only r0 for the function).
  const latch = patch.append((at) => assembleWords(
    `${BYTE}; ldrb r3, [r3]
     ands r3, r3, #${MOVIE_4K_BIT}; movne r3, #1
     movw ip, #${lo(MOVIE4K_LATCH)}; movt ip, #${hi(MOVIE4K_LATCH)}; strb r3, [ip]
     b #${MOVIE_SIZE}`, at), 16);
  patch.setWord(START_SIZE_CALL, branchWord(START_SIZE_CALL, latch, 14, true), '4K movies: the Resolution setting is taken when the live view is started');
  const answer = patch.append((at) => assembleWords(
    `movw r0, #${lo(MOVIE4K_LATCH)}; movt r0, #${hi(MOVIE4K_LATCH)}; ldrb r0, [r0]
     and r0, r0, #1
     bx lr`, at), 16);
  patch.setWord(SWITCH, branchWord(SWITCH, answer), '4K movies: the switch answers the Resolution setting of this live view');

  // --- 60p confirmed in the Frame Rate list (row 0): FHD. Only the record's own set function, which the list's OK calls:
  // the row under the cursor is set while the list is open (+0x34) and the row that was current is set again when the list
  // is left without OK (+0x3c), both by calling 0x531D4D08 directly, and neither must lose the Resolution.
  const rate = patch.append((at) => assembleWords(
    `cmp r1, #0; bne #${FR_SET}
     ${BYTE}; ldrb ip, [r3]; bic ip, ip, #${MOVIE_4K_BIT}; strb ip, [r3]
     b #${FR_SET}`, at), 16);

  // --- The Resolution list: FHD, 4K (this = r0; draw: item = r1, row = r2; set, current: row = r1).
  const count = patch.append((at) => assembleWords('mov r0, #2; bx lr', at), 16);
  const draw = patch.append((at) => assembleWords(
    `cmp r2, #1; bxhi lr
     mov r0, r1
     movweq r1, #${T.uhd}; movwne r1, #${T.fhd}
     b #${LIST_TEXT_ROW}`, at), 16);
  const set = patch.append((at) => assembleWords(
    `cmp r1, #1; bxhi lr
     ${BYTE}; ldrb ip, [r3]; bic ip, ip, #${MOVIE_4K_BIT}; orreq ip, ip, #${MOVIE_4K_BIT}; strb ip, [r3]
     bxne lr
     ${RATE}; cmp r2, #0; bxne lr
     push {r4, lr}
     bl #${APP}; bl #${GET_SETTINGS}
     mov r1, #1
     pop {r4, lr}
     b #${FRAME_RATE_SET}`, at), 16);
  // current: 4K only with the setting and a frame rate that has it (as the line and the submenu show it).
  const current = patch.append((at) => assembleWords(
    `${BYTE}; ldrb r3, [r3]; ${RATE}
     tst r3, #${MOVIE_4K_BIT}; cmpne r2, #0
     movne r3, #1; moveq r3, #0
     cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  // The record: Frame Rate's (rows of text), without its two functions that set a row before OK: the row is set by OK alone.
  const record = official.slice();
  const rv = new DataView(record.buffer);
  rv.setUint32(0x0c, count, true);
  rv.setUint32(0x14, draw, true);
  rv.setUint32(0x24, set, true);
  rv.setUint32(0x2c, current, true);
  rv.setUint32(0x34, 0, true);
  rv.setUint32(0x3c, 0, true);
  addListRecords(patch, [{ id: RESOLUTION_LIST_ID, record }], '4K movies');
  // Frame Rate's record, in the table the camera reads now.
  const rateRecord = listTable(patch) + FRAME_RATE_RECORD * LIST_RECORD;
  expectWord(patch, rateRecord + 0x24, FR_SET);
  patch.setWord(rateRecord + 0x24, rate, '4K movies: 60p confirmed sets FHD');

  // --- The submenu: Frame Rate (the camera's list, its value as the line showed it), Resolution.
  const lineRate = patch.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r4, r1
     bl #${APP}; bl #${RESOURCES}
     ${RATE}; mov r1, r2
     add r0, r0, #4; bl #${FRAME_RATE_TEXT}
     mov r1, r0; mov r0, r4
     pop {r4, r5, r6, lr}
     b #${SUBMENU_LINE_TEXT}`, at), 16);
  const lineResolution = patch.append((at) => assembleWords(
    `mov r0, r1
     ${BYTE}; ldrb r3, [r3]; ${RATE}
     tst r3, #${MOVIE_4K_BIT}; cmpne r2, #0
     movwne r1, #${T.uhd}; movweq r1, #${T.fhd}
     b #${SUBMENU_LINE_TEXT}`, at), 16);
  const sub = submenuTemplate(patch);
  {
    const r = new DataView(sub.buffer);
    r.setUint16(2, T.title, true);
    r.setUint16(8, FRAME_RATE_TITLE, true);
    r.setUint16(10, T.resolution, true);
    r.setUint32(0x14, FRAME_RATE_LIST_ID, true);
    r.setUint32(0x18, RESOLUTION_LIST_ID, true);
    r.setUint32(0x3c, lineRate, true);
    r.setUint32(0x40, 0, true);
    r.setUint32(0x44, lineResolution, true);
    r.setUint32(0x48, 0, true);
  }
  addSubmenuRecord(patch, FRAME_RATE_MENU_ID, sub, '4K movies');
  hookControllerFactory(patch, `movw ip, #${lo(FRAME_RATE_MENU_ID)}; movt ip, #${hi(FRAME_RATE_MENU_ID)}
     cmp r1, ip; bne list
     movw r1, #${lo(SUBMENU_CONTROLLER_ID)}; movt r1, #${hi(SUBMENU_CONTROLLER_ID)}; b prior
     list: add ip, ip, #${RESOLUTION_LIST_ID - FRAME_RATE_MENU_ID}; cmp r1, ip; bne prior
     movw r1, #${lo(LIST_CONTROLLER_ID)}; movt r1, #${hi(LIST_CONTROLLER_ID)}`, '4K movies: the submenu and the Resolution list');

  // --- The movie menu's line: the value (4K with the frame rate, or the frame rate), the title; it opens the submenu.
  const line = patch.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r4, r1
     ${BYTE}; ldrb r3, [r3]; ${RATE}
     tst r3, #${MOVIE_4K_BIT}; beq plain
     cmp r2, #1; movweq r1, #${T.uhd30}; beq have
     cmp r2, #2; movweq r1, #${T.uhd24}; beq have
     plain: mov r5, r2
     bl #${APP}; bl #${RESOURCES}
     mov r1, r5; add r0, r0, #4; bl #${FRAME_RATE_TEXT}
     mov r1, r0
     have: mov r0, r4; bl #${LINE_VALUE_TEXT}
     mov r0, r4; movw r1, #${T.title}
     pop {r4, r5, r6, lr}
     b #${TOP_SET_TITLE}`, at), 16);
  for (const at of menuItemWords(patch, MOVIE_MENU, MOVIE_ITEM)) {
    if (patch.word(at.id) !== FRAME_RATE_LIST_ID || patch.word(at.draw) !== FRAME_RATE_LINE_DRAW) fail('unexpected-layout', 'movie menu > Frame Rate line is not the official one');
    patch.setWord(at.draw, line, '4K movies: Frame Rate / Resolution, line of a submenu');
    patch.setWord(at.id, FRAME_RATE_MENU_ID, '4K movies: Frame Rate / Resolution opens the submenu');
  }
}
