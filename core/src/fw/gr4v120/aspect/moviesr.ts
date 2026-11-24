// SPDX-License-Identifier: GPL-2.0-only
/**
 * Shake reduction for movies by sensor shift (GR IV firmware 1.20 and 1.21): the movie menu's
 * Movie SR offers Off, Sensor Shift and Electronic instead of Off and On.
 *
 * What the firmware does. The shake reduction unit (a microcontroller of its own) moves the sensor
 * when the main processor reports "shake reduction on" in the state it sends (field 0x13; built by
 * 0x537BB254 from the still / movie mode and the two settings, sent again for the properties 0xF9,
 * Shake Reduction, and 0x89, all settings). For a movie the firmware always reports off and, with
 * Movie SR on, field 0x14: the unit's own movie parameters, for the electronic shake reduction that
 * the main processor does by moving a window of the picture. For that window every movie is read
 * with a margin of 5 % on each side (2064 x 1160, of which 1858 x 1044 are recorded as 1920 x 1080),
 * also with Movie SR off: the flag is set for every movie live view by 0x5365C850 (when the live
 * view is set up) and 0x5365AB38 (while it runs).
 * Camera tests 090 to 093 (hand-patched test firmware) on a GR IV 1.21: with field 0x13 reported
 * for a movie the unit stabilises as for stills, and without the margin the whole read-out is
 * recorded.
 *
 * The setting. Movie SR itself (0x77B of the user settings; property 0xFA) stays what it is, the
 * electronic shake reduction: 0 or 1, read by the camera's own code. "Sensor Shift" is bit 0 of
 * MOVIE_BYTE (`movie4k.ts`), with Movie SR 0. So: Off = 0 / 0, Sensor Shift = 0 / bit, Electronic
 * = 1 (the bit is cleared when it is chosen; Movie SR switched on another way, by an Fn button's
 * Shake Reduction, counts as Electronic whatever the bit). A firmware without this sees Off or On.
 *
 * What is changed:
 *  - Movie SR's list (record 62 of the list table): three rows, their set and "current";
 *  - the icon of the setting on the menu line and on the shooting screen (the calls of the icon
 *    function 0x53390E18 at 0x531B2C78 and 0x533A6AEC): the hand of the still shake reduction for
 *    Sensor Shift, the hand with an "E" for Electronic;
 *  - the state for the unit, a movie's field 0x13 (0x537BB2D8, `mov r2, #0`): on with Sensor
 *    Shift, unless Sensor Shift's composition adjustment (`shift.ts`) holds the sensor;
 *  - the state is sent again for property 0xFA too (0x536AF4DC), and at once when the list sets
 *    the value;
 *  - the margin: only with Electronic. As in test 093 it is decided when the live view is set up
 *    (Movie SR as the camera side has it then) and kept for as long as that live view runs, in a
 *    byte of the sbrk arena (`battery.ts`), so that window and margin cannot disagree: a change of
 *    the setting moves the picture's edge at the next set-up (the shooting mode changed, or the
 *    camera switched on).
 * Off therefore records the whole read-out as well: about 11 % more of the scene than the
 * official firmware's movies.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, Patch, concat, expectWord, u16le, u32le, widenTextRows } from './build';
import { LIST_SET_ITEM, TEXT_OFF, installTexts, listTable } from './datestamp-menu';
import { MOVIE_BYTE, MOVIE_SENSOR_SR_BIT } from './movie4k';
import type { ShiftCode } from './shift';
import { adr } from '../target';

export const MOVIESR_TEXT_IDS = { sensor: 1050, electronic: 1051 } as const;
/** Identity 24 of the ratio icon numbers, never given out (as 734..739). */
export const MOVIESR_ICON_ID = 740;
/** "No margin in this live view": a byte of the sbrk arena (0x55839040..0x55839080, `battery.ts`), zero at start-up. */
export const MOVIESR_LATCH = adr(0x55839044);

const ICON_SR_OFF = 467;
const ICON_SR_ON = 469;
const SETTINGS = adr(0x550832a8);
const MOVIE_SR_LIVE = 0x12c3; // Movie SR in effect (the setting kept is at 0x77f)
const MOVIE_SR_SET = adr(0x533337ac); // (settings, value)
const APP = adr(0x532406a4);
const GET_SETTINGS = adr(0x53240c38);
const ICON_OF = adr(0x53390e18); // (resources + 4, Movie SR, variant) -> icon 467 / 469
const LINE_ICON_CALL = adr(0x531b2c78); // bl ICON_OF in the movie menu line's draw function (0x531B2C44)
const SCREEN_ICON_TAIL = adr(0x533a6aec); // b ICON_OF: the shooting screen's icon, for a movie
const SR_HOLDER = adr(0x550b9b20); // +4: SrMessage; its +0x60 the state
const SR_STATE = adr(0x537bb254); // (state): build and send
const SR_STATE_MOVIE = adr(0x537bb2d8); // mov r2, #0: field 0x13 for a movie
const SR_PROPERTY = adr(0x536af4dc); // cmp r3, #0xf9 in the unit's property handler (0x536AF4BC)
const MARGIN_SETUP = adr(0x5365c87c); // mov r3, #1 (then strb r3, [r5, #0x74c])
const MARGIN_UPDATE = adr(0x5365ab70); // mov r3, #1 (then strb r3, [r6, #0x74c])
const CAMERA_MOVIE_SR = adr(0x5377db4c); // (camera properties) -> Movie SR
/** Movie SR's list record (62 of the list table) and its handlers. */
const SR_RECORD = 62;
const LIST_RECORD = 0x4c;
const SR_TITLE = 415;
const SR_COUNT = adr(0x531d0b4c);
const SR_DRAW = adr(0x531d2c28);
const SR_SET = adr(0x531d4e08);
const SR_CURRENT = adr(0x531d67f0);

/**
 * In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). The two Chinese say "SR" as the
 * camera's own texts do ("自动关闭SR"): the characters of 防抖 / 防震 are not in its texts of those languages.
 * Where a language would use Sensor Shift's own name (`shift.ts`), the option says "mechanical" instead, so that the two
 * are not taken for one thing (the comments here go on calling the option Sensor Shift).
 */
export const MOVIESR_SENSOR_NAMES: readonly string[] = [
  'Mechanická', 'Mekanisk', 'Mechanical', 'Mekaaninen', 'Capteur', 'Sensor-Shift', 'Αισθητήρας', 'Érzékelő',
  'Sensore', 'メカ式', '기계식', 'Mechanisch', 'Matryca', 'Sensor', 'Механическая', '传感器SR',
  'Sensor', 'Mekanisk', 'เซ็นเซอร์', '感測器SR', 'Sensör',
];
export const MOVIESR_ELECTRONIC_NAMES: readonly string[] = [
  'Elektronická', 'Elektronisk', 'Electronic', 'Elektroninen', 'Électronique', 'Elektronisch', 'Ηλεκτρονική', 'Elektronikus',
  'Elettronica', '電子式', '전자식', 'Elektronisch', 'Elektroniczna', 'Eletrónica', 'Электронная', '电子SR',
  'Electrónica', 'Elektronisk', 'อิเล็กทรอนิกส์', '電子SR', 'Elektronik',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** The icon of Electronic: the camera's shake reduction hand (40 x 40 RGBA) with an "E" at its lower right. */
export function drawElectronicIcon(hand: Uint8Array): Uint8Array {
  if (hand.length !== 40 * 40 * 4) fail('internal', 'movie shake reduction: icon size');
  const px = hand.slice();
  const E = ['######', '######', '##....', '#####.', '#####.', '##....', '##....', '######', '######'];
  const X = 33, Y = 30;
  const on = (x: number, y: number): boolean => y >= 0 && y < E.length && x >= 0 && x < 6 && E[y][x] === '#';
  for (let y = -1; y <= E.length; y++) {
    for (let x = -1; x <= 6; x++) {
      let near = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near = near || on(x + dx, y + dy);
      if (!near || X + x > 39 || Y + y > 39) continue;
      px.set(on(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255], ((Y + y) * 40 + X + x) * 4);
    }
  }
  return px;
}

/** The texts and the icon (before the menus use them). Returns ICONBIN with the icon appended. */
export function installMovieSrAssets(patch: Patch, iconbin: Uint8Array): Uint8Array {
  if (MOVIESR_SENSOR_NAMES.length !== LANGUAGES || MOVIESR_ELECTRONIC_NAMES.length !== LANGUAGES) fail('internal', 'movie shake reduction: texts');
  widenTextRows(patch, MOVIESR_TEXT_IDS.electronic);
  installTexts(patch, [{ id: MOVIESR_TEXT_IDS.sensor, names: MOVIESR_SENSOR_NAMES }, { id: MOVIESR_TEXT_IDS.electronic, names: MOVIESR_ELECTRONIC_NAMES }]);
  // The camera's icon: {u16 kind = 1, width, height, flags = 0, u32 offset in 4-byte units}.
  const d = new DataView(patch.readMapped(patch.word(ICON_CATALOG + ICON_SR_ON * 4), 12).buffer);
  if (d.getUint16(0, true) !== 1 || d.getUint16(2, true) !== 40 || d.getUint16(4, true) !== 40 || d.getUint16(6, true) !== 0) fail('unexpected-layout', 'shake reduction icon is not as expected');
  const at = d.getUint32(8, true) * 4;
  if (at + 6400 > iconbin.length) fail('unexpected-layout', 'shake reduction icon is not in ICONBIN');
  if (patch.word(ICON_CATALOG + MOVIESR_ICON_ID * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
  const pad = (4 - (iconbin.length % 4)) % 4;
  const offset = iconbin.length + pad;
  const descriptor = patch.append(concat([u16le([1, 40, 40, 0]), u32le([offset / 4])]), 16);
  patch.write(ICON_CATALOG + MOVIESR_ICON_ID * 4, u32le([descriptor]));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(MOVIESR_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat([iconbin, new Uint8Array(pad), drawElectronicIcon(iconbin.slice(at, at + 6400))]);
}

/**
 * The list, the icons, the state for the unit and the margin. `shift`: Sensor Shift's module when
 * it is in the build (its composition adjustment holds the sensor: no shake reduction then).
 * Before any addition that copies the list table is fine, and after: the record is changed where
 * the table is.
 */
export function installMovieSr(patch: Patch, shift: ShiftCode | null): void {
  const BYTE = `movw r3, #${lo(MOVIE_BYTE)}; movt r3, #${hi(MOVIE_BYTE)}`;
  const LIVE = `movw ip, #${lo(SETTINGS + MOVIE_SR_LIVE)}; movt ip, #${hi(SETTINGS + MOVIE_SR_LIVE)}; ldrb ip, [ip]`;
  // --- What this relies on.
  expectWord(patch, ICON_OF, 0xe3510000); // cmp r1, #0
  expectWord(patch, LINE_ICON_CALL, branchWord(LINE_ICON_CALL, ICON_OF, 14, true));
  expectWord(patch, LINE_ICON_CALL - 8, 0xe3a02000); // mov r2, #0 (variant)
  expectWord(patch, SCREEN_ICON_TAIL, branchWord(SCREEN_ICON_TAIL, ICON_OF));
  expectWord(patch, MOVIE_SR_SET, 0xe1a0c00d);
  expectWord(patch, SR_STATE, 0xe1a0c00d);
  expectWord(patch, SR_STATE_MOVIE - 8, 0xe1a00004); // mov r0, r4
  expectWord(patch, SR_STATE_MOVIE - 4, 0xe3a01013); // mov r1, #0x13
  expectWord(patch, SR_STATE_MOVIE, 0xe3a02000); // mov r2, #0
  expectWord(patch, SR_STATE_MOVIE + 8, 0xe3560000); // cmp r6, #0 (Movie SR: field 0x14)
  expectWord(patch, SR_PROPERTY, 0xe35300f9); // cmp r3, #0xf9
  expectWord(patch, SR_PROPERTY + 4, 0x0a000018); // beq: the state built and sent
  expectWord(patch, SR_PROPERTY + 8, 0xe35300fb); // cmp r3, #0xfb
  for (const [site, register] of [[MARGIN_SETUP, 5], [MARGIN_UPDATE, 6]] as const) {
    expectWord(patch, site, 0xe3a03001); // mov r3, #1
    expectWord(patch, site + 4, (0xe5c0374c | (register << 16)) >>> 0); // strb r3, [rX, #0x74c]
  }
  expectWord(patch, CAMERA_MOVIE_SR + 4, 0xe1a0c00d); // mov ip, sp
  const record = listTable(patch) + SR_RECORD * LIST_RECORD;
  const rv = new DataView(patch.read(record, LIST_RECORD).buffer);
  if (rv.getUint32(0, true) !== 0x00010000 || rv.getUint16(4, true) !== SR_TITLE || rv.getUint32(0x0c, true) !== SR_COUNT || rv.getUint32(0x14, true) !== SR_DRAW || rv.getUint32(0x24, true) !== SR_SET
    || rv.getUint32(0x2c, true) !== SR_CURRENT || [0x10, 0x18, 0x1c, 0x20, 0x28, 0x30, 0x34, 0x38, 0x3c, 0x40, 0x44, 0x48].some((off) => rv.getUint32(off, true) !== 0)) fail('unexpected-layout', 'Movie SR list record is not as expected');
  expectWord(patch, SR_SET + 0x2c, branchWord(SR_SET + 0x2c, MOVIE_SR_SET));

  // --- The list: Off, Sensor Shift, Electronic (this = r0; draw: item = r1, row = r2; set, current: row = r1).
  const count = patch.append((at) => assembleWords('mov r0, #3; bx lr', at), 16);
  const draw = patch.append((at) => assembleWords(
    `cmp r2, #2; bxhi lr
     mov r0, r1
     movw r1, #${ICON_SR_OFF}; movw r3, #${TEXT_OFF}
     cmp r2, #1
     movweq r1, #${ICON_SR_ON}; movweq r3, #${MOVIESR_TEXT_IDS.sensor}
     movwhi r1, #${MOVIESR_ICON_ID}; movwhi r3, #${MOVIESR_TEXT_IDS.electronic}
     mov r2, r3
     b #${LIST_SET_ITEM}`, at), 16);
  // set: the bit, then Movie SR through the camera's own setter (its property goes to the camera side), then the state for the unit.
  const set = patch.append((at) => assembleWords(
    `cmp r1, #2; bxhi lr
     push {r4, lr}
     mov r4, r1
     ${BYTE}; ldrb ip, [r3]; bic ip, ip, #${MOVIE_SENSOR_SR_BIT}
     cmp r4, #1; orreq ip, ip, #${MOVIE_SENSOR_SR_BIT}
     strb ip, [r3]
     bl #${APP}; bl #${GET_SETTINGS}
     cmp r4, #2; moveq r1, #1; movne r1, #0
     bl #${MOVIE_SR_SET}
     movw r0, #${lo(SR_HOLDER + 4)}; movt r0, #${hi(SR_HOLDER + 4)}; ldr r0, [r0]
     cmp r0, #0; ldrne r0, [r0, #0x60]; cmpne r0, #0
     pop {r4, lr}
     bxeq lr
     b #${SR_STATE}`, at), 16);
  // current: 2 with Movie SR on, else 1 with the bit, else 0.
  const MODE = `${LIVE}; cmp ip, #0; movne r0, #2; bne have
     ${BYTE}; ldrb r0, [r3]; and r0, r0, #${MOVIE_SENSOR_SR_BIT}
     have:`;
  const current = patch.append((at) => assembleWords(
    `${MODE} cmp r0, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  patch.setWord(record + 0x0c, count, 'movie shake reduction: three rows');
  patch.setWord(record + 0x14, draw, 'movie shake reduction: Off, Sensor Shift, Electronic');
  patch.setWord(record + 0x24, set, 'movie shake reduction: the row chosen');
  patch.setWord(record + 0x2c, current, 'movie shake reduction: the row current');

  // --- The icon of the setting: (resources + 4, Movie SR, variant).
  const icon = patch.append((at) => assembleWords(
    `cmp r2, #0; bne native
     cmp r1, #0; movwne r0, #${MOVIESR_ICON_ID}; bxne lr
     ${BYTE}; ldrb r3, [r3]; tst r3, #${MOVIE_SENSOR_SR_BIT}
     movwne r0, #${ICON_SR_ON}; bxne lr
     native: b #${ICON_OF}`, at), 16);
  patch.setWord(LINE_ICON_CALL, branchWord(LINE_ICON_CALL, icon, 14, true), 'movie shake reduction: the menu line\'s icon');
  patch.setWord(SCREEN_ICON_TAIL, branchWord(SCREEN_ICON_TAIL, icon), 'movie shake reduction: the shooting screen\'s icon');

  // --- The state for the unit, a movie: field 0x13 = Sensor Shift chosen, Movie SR off, the sensor not held. r0, r1 kept.
  // Movie SR as the function itself has it (r6, from the camera side, what field 0x14 is made of just after): the two
  // fields then always belong to the same value, also while a change of the setting is still on its way to the camera side.
  const held = shift ? `cmp r2, #0; bxeq lr
     push {r0, r1, r2, r3, ip, lr}
     mov r1, #4; ${shift.loadCtx}; bl #${shift.code}
     cmp r0, #0
     pop {r0, r1, r2, r3, ip, lr}
     movne r2, #0` : '';
  const state = patch.append((at) => assembleWords(
    `${BYTE}; ldrb r2, [r3]; and r2, r2, #${MOVIE_SENSOR_SR_BIT}
     cmp r6, #0; movne r2, #0
     ${held}
     bx lr`, at), 16);
  patch.setWord(SR_STATE_MOVIE, branchWord(SR_STATE_MOVIE, state, 14, true), 'movie shake reduction: the sensor shift on for a movie');
  // --- The state is sent again when Movie SR changes (property 0xFA), as for Shake Reduction (0xF9).
  const again = branchTarget(SR_PROPERTY + 4, patch.word(SR_PROPERTY + 4));
  const property = patch.append((at) => assembleWords(
    `cmp r3, #0xf9; cmpne r3, #0xfa
     beq #${again}
     b #${SR_PROPERTY + 8}`, at), 16);
  patch.setWord(SR_PROPERTY, branchWord(SR_PROPERTY, property), 'movie shake reduction: the state sent again when Movie SR changes');

  // --- The margin: with Electronic only; decided when the live view is set up (r4 = the live view), kept while it runs.
  const LATCH = `movw r3, #${lo(MOVIESR_LATCH)}; movt r3, #${hi(MOVIESR_LATCH)}`;
  const setup = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     ldr r0, [r4, #0x3bc]; bl #${CAMERA_MOVIE_SR}
     cmp r0, #0; moveq r1, #1; movne r1, #0
     ${LATCH}; strb r1, [r3]
     eor r1, r1, #1; str r1, [sp, #0xc]
     pop {r0, r1, r2, r3, ip, pc}`, at), 16);
  const update = patch.append((at) => assembleWords(
    `${LATCH}; ldrb r3, [r3]
     eor r3, r3, #1
     bx lr`, at), 16);
  patch.setWord(MARGIN_SETUP, branchWord(MARGIN_SETUP, setup, 14, true), 'movie shake reduction: the margin with Electronic only');
  patch.setWord(MARGIN_UPDATE, branchWord(MARGIN_UPDATE, update, 14, true), 'movie shake reduction: the margin as decided at set-up');
}
