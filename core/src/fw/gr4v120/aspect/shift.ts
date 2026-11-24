// SPDX-License-Identifier: GPL-2.0-only
/**
 * Sensor Shift (GR IV firmware 1.20 and 1.21): the picture moved and turned by hand with the shake
 * reduction unit, as the "Composition Adjustment" of Pentax bodies.
 *
 * While the adjustment is on, the shooting screen shows X, Y and R in place of shutter speed,
 * aperture and ISO, and a key guide "DISP  Center"; the four-way controller shifts the sensor (28
 * steps of about 0.04 mm each way), the dials turn it (18 steps of 0.125 degrees each way; the more
 * it is turned, the less it can be shifted), DISP brings it back to the centre, OK or Fn ends the
 * adjustment and leaves the sensor where it is. Shake reduction is off as long as the adjustment is
 * on or the sensor is away from the centre. Nothing is kept when the camera is switched off.
 *
 * Where it is started:
 *  - an ADJ lever function (the next number after the camera's 0x14, exposure preview's and
 *    Constant Light's), offered by ADJ Mode Setting, with the values Off / Adjust: carried out when
 *    the lever's strip closes on it;
 *  - an Fn function, 0x2E, offered for the Fn button (a row of its own at the end of that
 *    button's list: the other three buttons that share the list move the sensor in the adjustment)
 *    and for the Movie button, pressed and held: a press, or a hold, starts and ends the adjustment.
 *
 * The camera-side logic is one position-independent module, tools/shift/shift.c (compiled into
 * `shift-code.ts`); it gets every address in a context written here. Camera tests 107 to 111 on a
 * GR IV HDF 1.21.
 *
 * How the sensor is moved. The shake reduction unit (a microcontroller of its own, the same program
 * in 1.20 and 1.21 but for its date) writes its three actuator offsets, the auto horizon
 * correction's, through three pointers (0x200009F8..) into the position registers 0x40114400,
 * 0x40114430 and 0x40114460. The module turns the pointers onto the unit's own buffer
 * (0x2000ADF4..) with the unit's "write a word" command (0x6B; 0x536B2180 sends it), so that the
 * unit no longer touches the registers, and writes the registers itself; back at the centre it
 * restores the pointers. Measured: 256 units are about 0.14 mm; actuator 0 moves the picture
 * sideways, 1 and 2 together move it up and down and, against each other, turn it.
 *
 * What is changed in the camera's code:
 *  - SwitchModel::Notify (0x53272A80), at its entry: the module sees every key event of the
 *    shooting screen first and uses up those of the adjustment;
 *  - the capture-ready fast path of a switch message (the call at 0x53183C14): left out for Fn when
 *    Fn starts or ends the adjustment and for left / right during it (that path runs the buttons'
 *    functions in another task, before Notify);
 *  - the shooting screen's shutter speed, aperture and ISO texts (the six calls of
 *    AsciiView::SetText in 0x5318C118, 0x5318C30C and 0x5318C544) and the ISO icon (the call at
 *    0x5318C518): X, Y, R and no icon during the adjustment;
 *  - the key guide's content (0x5318E8F4, at its entry): DISP and "Center" during the adjustment;
 *  - what is reported to the unit as "shake reduction on" (0x537BB2B0, in the function that builds
 *    the unit's state, 0x537BB254): off while the sensor is shifted or the adjustment is on;
 *  - the ADJ function table copied with one more record, the function's name and icon (as
 *    `lamp.ts`); the Fn button's list record: four handlers that add a row; the held Movie button's
 *    list with one more function; the Fn functions' name and icon; a case of the three function
 *    switches before their bounds checks: nothing (the module acts on the key events themselves).
 *
 * Going back to a firmware without this: an Fn or Movie button left on 0x2E does nothing there (the
 * official switches log it and return; its name and icon are empty); an ADJ slot left on the added function must be set to
 * something else first, as for exposure preview (the settings guard of a GR Mod build does it).
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, Patch, concat, expectWord, u16le, u32le, widenTextRows } from './build';
import { LIST_SET_ITEM, TEXT_OFF, installTexts, listTable } from './datestamp-menu';
import { SHIFT_CODE, SHIFT_CODE_LENGTH } from './shift-code';
import { adr } from '../target';

/** The module's state: 0x29 bytes of the sbrk arena (0x55839040..0x55839080, `battery.ts`: 0x40 the battery's byte, 0x74 Constant Light's word, 0x78 and 0x7C the white balance's and movie AF's pointers). */
export const SHIFT_STATE = adr(0x55839048);
export const SHIFT_STATE_BYTES = 0x29;
export const SHIFT_TEXT_IDS = { name: 1041, adjust: 1042, center: 1043 } as const;
/** Identity 23 of the ratio icon numbers, never given out (as 734..738, `exposure.ts`, `lamp.ts`). */
export const SHIFT_ICON_ID = 739;
/** The Fn function: the first number after the camera's last (0x2d): in no list, beyond its function switches' tables. */
export const FN_SHIFT = 0x2e;
export const SHIFT_MAGIC = 0x74666873; // "shft"
/** The DISP button's icon (50 x 40), the camera's own. */
const ICON_DISP = 542;

const NOTIFY = adr(0x53272a80); // SwitchModel::Notify(model, switch, event)
const FAST_CALL = adr(0x53183c14); // bl: the capture-ready fast path of a switch message
const FAST_PATH = adr(0x5325e67c);
const SET_TEXT = adr(0x53590490); // AsciiView::SetText(view, text)
const TV_TEXT = adr(0x5318c118); // LiveViewController: the shutter speed's text
const AV_TEXT = adr(0x5318c30c);
const SV_TEXT = adr(0x5318c544);
const SV_ICON = adr(0x5318c4f0); // the ISO icon in front of the value
const SV_ICON_CALL = adr(0x5318c518); // bl: the icon of the ISO setting
const SV_ICON_OF = adr(0x533a88fc);
/** The six calls of SetText: [call, which value]. */
const LABEL_CALLS: readonly (readonly [number, number])[] = [
  [adr(0x5318c1d0), 0], [adr(0x5318c208), 0], [adr(0x5318c3c8), 1], [adr(0x5318c400), 1], [adr(0x5318c60c), 2], [adr(0x5318c644), 2],
];
const GUIDE = adr(0x5318e8f4); // (LV, icon*, ascii*, text*, icon 2*) -> 1 when there is a key guide
const OSD_ITEM_36 = adr(0x5318eb48); // (LV, 36, shown): the item the key guide replaces
const OSD_ITEM_38 = adr(0x5318ea8c); // (LV, 38, shown): the key guide
const OSD_UPDATE = adr(0x5318bee0); // calls every item with what the two tables say
const OSD_SHOWN_A = adr(0x53dc08e0);
const OSD_SHOWN_B = adr(0x53dbf95c);
const LV_HOLDER = adr(0x55081d40); // the object that keeps the LiveViewController at +4
const LV_HOLDER_GET = adr(0x53187154);
const LV_VTABLE = adr(0x53dbf740);
const SCREEN_ID = adr(0x55088534);
const SETTINGS = adr(0x550832a8);
const APP_STATE = adr(0x55083138); // +0x25: nothing on the screen
const VIEW_STATE = adr(0x5508a010); // +0x0B: nothing on the screen
const SR_HOLDER = adr(0x550b9b20); // +4: SrMessage
const SR_WRITE = adr(0x536b2180); // (SrMessage, address, value): the unit's command 0x6B
const SR_STATE = adr(0x537bb254); // (DspState): the state reported to the unit
const SR_STATE_ON = adr(0x537bb2b0); // cmp r7, #0: shake reduction on
const GET_APP = adr(0x532406a4);
const GET_SETTINGS = adr(0x53240c38);
const SET_FN = adr(0x5333fbd8); // (settings model, function): the Fn button's function
const LIST_ITEM = adr(0x53593d64); // (list, index) -> item (the ADJ controller's list view)
const ITEM_SET_TEXT = adr(0x535a1138); // (item, text number)

const ADJ_TABLE = adr(0x53dc9dfc);
const ADJ_RECORD = 0x5c;
const ADJ_OFFICIAL_FUNCTIONS = 21;
const CROP = 0x13;
const H_ENTER = 0x00;
const H_LEAVE = 0x08;
const H_DRAW = 0x18;
const H_IS_CURRENT = 0x20;
const H_SET = 0x28;
const H_COUNT = 0x30;
/** Every MOVW / MOVT pair that loads the ADJ function table's address: [movw, movt, register] (as `exposure.ts`, `lamp.ts`). */
const ADJ_TABLE_SITES: readonly (readonly [number, number, number])[] = [
  [adr(0x531bd4c4), adr(0x531bd4d4), 4], [adr(0x531bee8c), adr(0x531bee94), 2], [adr(0x531bf028), adr(0x531bf030), 3], [adr(0x531bf0c4), adr(0x531bf0cc), 2],
  [adr(0x531bf5c0), adr(0x531bf5c8), 2], [adr(0x531bffd4), adr(0x531bffdc), 2], [adr(0x531c0030), adr(0x531c0038), 2], [adr(0x531c0128), adr(0x531c0130), 2],
  [adr(0x531c01b4), adr(0x531c01bc), 2], [adr(0x531c0240), adr(0x531c0248), 2], [adr(0x531c02e8), adr(0x531c02f0), 7], [adr(0x531c0434), adr(0x531c043c), 2],
  [adr(0x531c05d4), adr(0x531c05dc), 2], [adr(0x531c06d0), adr(0x531c06e8), 4], [adr(0x531c09dc), adr(0x531c09e4), 6], [adr(0x531c0ae8), adr(0x531c0af0), 2],
  [adr(0x531c0b94), adr(0x531c0b9c), 2], [adr(0x531c0bfc), adr(0x531c0c0c), 7], [adr(0x531c0cb8), adr(0x531c0cc8), 7], [adr(0x531c0e9c), adr(0x531c0ea4), 2],
  [adr(0x531c1060), adr(0x531c1064), 3], [adr(0x531c1220), adr(0x531c1228), 2],
];
const ADJ_TABLE_END = adr(0x531bd600);
const ADJ_NAME_OF = adr(0x5338f484); // (resources, function) -> text: cmp r1, #0 first
const ADJ_ICON_OF = adr(0x53390e40); // (resources, function, variant) -> icon: cmp r1, #0 first
const ADJ_LIST_LOW = adr(0x531dc834);
const ADJ_LIST_HIGH = adr(0x531dc844);
const ADJ_LIST_LENGTH = adr(0x531dc860);

const FN_NAME_OF = adr(0x5338fbac); // (resources, function) -> text: cmp r1, #0 first
const FN_ICON_OF = adr(0x533914bc); // (resources, function, variant) -> icon: cmp r1, #0 first
const FN_AVAILABLE = adr(0x531d75d8); // (function) -> offered on this model
const FN_SWITCH_BOUND = adr(0x5339910c); // cmp r2, #0x2d; the jump table follows
const FN_SWITCH_END = adr(0x5339927c);
const MOVIE_SWITCH_BOUND = adr(0x53397bd8); // events 2 and 3 of the Movie button
const MOVIE_SWITCH_END = adr(0x53397ad0);
const MOVIE_HELD_BOUND = adr(0x53397ca0); // event 4: the end of a hold
/** The held Movie button's list: its MOVW / MOVT / length, the official list and its bytes. */
const HELD_LIST = adr(0x53de52bc);
const HELD_LIST_LOW = adr(0x531dcc0c);
const HELD_LIST_HIGH = adr(0x531dcc10);
const HELD_LIST_LENGTH = adr(0x531dcc20);
const HELD_LIST_OFFICIAL = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x2d, 0x2c, 0x1e, 0x1f, 0x20, 0x22, 0x2b, 0x23, 0x24, 0x25, 0x26,
];
/** The Fn button's list: record 73 of the list table (title 505), with the camera's handlers. */
const FN_LIST_RECORD = 73;
const FN_LIST_TITLE = 505;
const FN_LIST_COUNT = adr(0x531d0be0);
const FN_LIST_DRAW = adr(0x531d3080);
const FN_LIST_SET = adr(0x531d5018);
const FN_LIST_CURRENT = adr(0x531d6a18);
const LIST_RECORD = 0x4c;

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const SHIFT_NAMES: readonly string[] = [
  'Posun snímače', 'Sensorforskydning', 'Sensor Shift', 'Kennon siirto', 'Décalage du capteur', 'Sensorverschiebung', 'Μετατόπιση αισθητήρα', 'Érzékelő eltolása',
  'Spostamento sensore', 'センサーシフト', '구도 미세 조정', 'Sensorverschuiving', 'Przesunięcie matrycy', 'Deslocamento do sensor', 'Сдвиг матрицы', '传感器位移',
  'Desplazamiento del sensor', 'Sensorförskjutning', 'เลื่อนเซ็นเซอร์', '感測器位移', 'Sensör kaydırma',
];
export const SHIFT_ADJUST_NAMES: readonly string[] = [
  'Upravit', 'Justér', 'Adjust', 'Säädä', 'Régler', 'Einstellen', 'Ρύθμιση', 'Beállítás',
  'Regola', '調整', '조정', 'Aanpassen', 'Dostosuj', 'Ajustar', 'Настроить', '调整',
  'Ajustar', 'Justera', 'ปรับ', '調整', 'Ayarla',
];
/** The key guide beside the DISP icon: back to the centre. */
export const SHIFT_CENTER_NAMES: readonly string[] = [
  'Střed', 'Centrér', 'Center', 'Keskitä', 'Centrer', 'Zentrieren', 'Κέντρο', 'Középre',
  'Centra', 'センター', '중앙', 'Centreren', 'Wyśrodkuj', 'Centrar', 'В центр', '复位',
  'Centrar', 'Centrera', 'กึ่งกลาง', '復位', 'Ortala',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** The ADJ lever function's number: after the camera's 21, exposure preview's and Constant Light's. */
export function shiftAdjFunction(exposurePreview: boolean, constantLight: boolean): number {
  return ADJ_OFFICIAL_FUNCTIONS + (exposurePreview ? 1 : 0) + (constantLight ? 1 : 0);
}

/**
 * The 40x40 icon on the tile of the camera's ADJ and Fn icons: a dashed rectangle (where the sensor
 * was) and, in front of it, a solid one four pixels to the right and three down (where it is now).
 */
export function drawShiftIcon(): Uint8Array {
  const px = new Uint8Array(40 * 40 * 4);
  const put = (x: number, y: number, c: readonly number[]): void => px.set(c, (y * 40 + x) * 4);
  const BG = [0x35, 0x35, 0x36, 255], WHITE = [255, 255, 255, 255], FRAME = [0x80, 0x80, 0x80, 255];
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) put(x, y, x < 1 || y < 1 || x > 38 || y > 38 ? [255, 255, 255, 0] : x === 1 || y === 1 || x === 38 || y === 38 ? FRAME : BG);
  }
  const T = 2, ON = 3, OFF = 2;
  // Dashes that start and end with a dash, so that the corners are closed.
  const dashed = (i: number, n: number): boolean => {
    const period = ON + OFF;
    const i2 = i - Math.floor(((n - ON) % period) / 2);
    return i < ON || i >= n - ON || ((i2 % period) + period) % period < ON;
  };
  const solid = (): boolean => true;
  const rect = (x0: number, y0: number, x1: number, y1: number, on: (i: number, n: number) => boolean): void => {
    for (let x = x0; x <= x1; x++) if (on(x - x0, x1 - x0 + 1)) for (let k = 0; k < T; k++) { put(x, y0 + k, WHITE); put(x, y1 - T + 1 + k, WHITE); }
    for (let y = y0; y <= y1; y++) if (on(y - y0, y1 - y0 + 1)) for (let k = 0; k < T; k++) { put(x0 + k, y, WHITE); put(x1 - T + 1 + k, y, WHITE); }
  };
  rect(5, 9, 29, 27, dashed);
  for (let y = 12; y <= 30; y++) for (let x = 9; x <= 33; x++) put(x, y, BG);
  rect(9, 12, 33, 30, solid);
  return px;
}

/** The texts and the icon (once, before the menus use them). Returns ICONBIN with the icon appended. */
export function installShiftAssets(patch: Patch, iconbin: Uint8Array): Uint8Array {
  if (SHIFT_NAMES.length !== LANGUAGES || SHIFT_ADJUST_NAMES.length !== LANGUAGES || SHIFT_CENTER_NAMES.length !== LANGUAGES) fail('internal', 'sensor shift: texts');
  widenTextRows(patch, SHIFT_TEXT_IDS.center);
  installTexts(patch, [{ id: SHIFT_TEXT_IDS.name, names: SHIFT_NAMES }, { id: SHIFT_TEXT_IDS.adjust, names: SHIFT_ADJUST_NAMES }, { id: SHIFT_TEXT_IDS.center, names: SHIFT_CENTER_NAMES }]);
  if (patch.word(ICON_CATALOG + SHIFT_ICON_ID * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
  const pad = (4 - (iconbin.length % 4)) % 4;
  const offset = iconbin.length + pad;
  const descriptor = patch.append(concat([u16le([1, 40, 40, 0]), u32le([offset / 4])]), 16);
  patch.write(ICON_CATALOG + SHIFT_ICON_ID * 4, u32le([descriptor]));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(SHIFT_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat([iconbin, new Uint8Array(pad), drawShiftIcon()]);
}

export interface ShiftCode {
  /** The module's entry and its context. */
  code: number;
  ctx: number;
  /** `movw r0 / movt r0` of the context. */
  loadCtx: string;
}

/** Words of the context (struct ctx in shift.c). */
const CTX = { fnDraw: 28, fnSet: 29, fnCurrent: 30, words: 47 } as const;

/**
 * The module, its context and the hooks of the shooting screen: the keys, the three values, the key
 * guide and the shake reduction state.
 */
export function installShiftCore(patch: Patch): ShiftCode {
  // --- What the hooks rely on.
  expectWord(patch, NOTIFY, 0xe5903760); // ldr r3, [r0, #0x760]
  expectWord(patch, NOTIFY + 4, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, FAST_CALL, branchWord(FAST_CALL, FAST_PATH, 14, true));
  expectWord(patch, FAST_CALL - 8, 0xe1a00006); // mov r0, r6
  expectWord(patch, FAST_CALL - 4, 0xe1a01004); // mov r1, r4 (the message)
  for (const [call] of LABEL_CALLS) expectWord(patch, call, branchWord(call, SET_TEXT, 14, true));
  for (const f of [TV_TEXT, AV_TEXT, SV_TEXT, SV_ICON, OSD_ITEM_36, OSD_ITEM_38, OSD_UPDATE, SR_WRITE, SR_STATE, GET_APP, GET_SETTINGS, SET_FN]) expectWord(patch, f, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, SV_ICON_CALL, branchWord(SV_ICON_CALL, SV_ICON_OF, 14, true));
  expectWord(patch, GUIDE, 0xe1a0c00d);
  expectWord(patch, GUIDE + 4, 0xe92ddff0); // push {r4-r9, sl, fp, ip, lr, pc}
  // The key guide (item 38) asks the content function, then shows the view or not; the item before it in the same place (36) hides when there is a guide.
  expectWord(patch, OSD_ITEM_38 + 0x88, branchWord(OSD_ITEM_38 + 0x88, GUIDE, 14, true));
  expectWord(patch, OSD_ITEM_36 + 0xd8, branchWord(OSD_ITEM_36 + 0xd8, GUIDE, 14, true));
  // The screen's update: what hides everything (two bytes of the view, a byte each of two models), then the two tables.
  expectWord(patch, OSD_UPDATE + 0x30, branchWord(OSD_UPDATE + 0x30, adr(0x533ead4c), 14, true));
  expectWord(patch, adr(0x533ead4c), 0xe5d00025); // ldrb r0, [r0, #0x25]
  expectWord(patch, OSD_UPDATE + 0x3c, 0xe5d534e6); // ldrb r3, [r5, #0x4e6]
  expectWord(patch, OSD_UPDATE + 0x100, 0xe5d532d6); // ldrb r3, [r5, #0x2d6]
  expectWord(patch, OSD_UPDATE + 0x108, 0xe5d572dd); // ldrb r7, [r5, #0x2dd]
  expectWord(patch, OSD_UPDATE + 0x10c, movWord(10, lo(OSD_SHOWN_A)));
  expectWord(patch, OSD_UPDATE + 0x110, movWord(2, lo(OSD_SHOWN_B)));
  expectWord(patch, adr(0x533a13e0), 0xe5d0000b); // ldrb r0, [r0, #0xb]
  expectWord(patch, adr(0x5318f504) + 0x28, 0xe5d454e5); // ldrb r5, [r4, #0x4e5]: the update's caller
  // The LiveViewController's holder and its class.
  expectWord(patch, LV_HOLDER_GET + 0x20, movWord(0, lo(LV_HOLDER)));
  expectWord(patch, LV_VTABLE + 0xc, adr(0x5318ae30));
  // The shake reduction state: r7 = shake reduction on, decided here; the unit's command.
  expectWord(patch, SR_STATE_ON, 0xe3570000); // cmp r7, #0
  expectWord(patch, SR_STATE_ON + 4, 0xe1a00004); // mov r0, r4
  expectWord(patch, SR_STATE_ON + 8, 0x0a000010); // beq: field 0x13 = 0
  expectWord(patch, SR_STATE_ON + 0xc, 0xe3a01013); // mov r1, #0x13

  const module = Uint8Array.from(atob(SHIFT_CODE), (c) => c.charCodeAt(0));
  if (module.length !== SHIFT_CODE_LENGTH) fail('internal', 'sensor shift: embedded module length');
  const code = patch.append(module, 16);
  const ctx = patch.append(u32le([
    SHIFT_MAGIC, SHIFT_STATE, SR_HOLDER + 4, LV_HOLDER + 4, LV_VTABLE, SCREEN_ID,
    SETTINGS + 0x1469, SETTINGS + 0x146e, SETTINGS + 0xb69, SETTINGS + 0x925, APP_STATE + 0x25, VIEW_STATE + 0x0b,
    OSD_SHOWN_A, OSD_SHOWN_B,
    SR_WRITE, SR_STATE, TV_TEXT, AV_TEXT, SV_TEXT, SV_ICON, OSD_ITEM_36, OSD_ITEM_38,
    LIST_ITEM, ITEM_SET_TEXT, LIST_SET_ITEM, GET_APP, GET_SETTINGS, SET_FN,
    FN_LIST_DRAW, FN_LIST_SET, FN_LIST_CURRENT,
    FN_SHIFT, SHIFT_ICON_ID, ICON_DISP, SHIFT_TEXT_IDS.name, SHIFT_TEXT_IDS.adjust, TEXT_OFF, SHIFT_TEXT_IDS.center,
    0x200009f8, 0x200009fc, 0x20000a00, 0x40114400, 0x40114430, 0x40114460, 0x2000adf4, 0x2000adf8, 0x2000adfc,
  ]), 16);
  if (patch.word(ctx + (CTX.words - 1) * 4) !== 0x2000adfc || patch.word(ctx + CTX.fnDraw * 4) !== FN_LIST_DRAW) fail('internal', 'sensor shift: context');
  const loadCtx = `movw r0, #${lo(ctx)}; movt r0, #${hi(ctx)}`;

  // --- The keys: (model, switch, event). 1 = used up: return; else the function's first instruction, then on.
  const key = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     mov r3, r2; mov r2, r1; mov r1, #0
     ${loadCtx}; bl #${code}
     cmp r0, #0
     pop {r0, r1, r2, r3, ip, lr}
     bxne lr
     ldr r3, [r0, #0x760]
     b #${NOTIFY + 4}`, at), 16);
  patch.setWord(NOTIFY, branchWord(NOTIFY, key), 'sensor shift: the keys');
  // --- The fast path of a switch message: (model, message). 1 = left out.
  const fast = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     mov r2, r1; mov r1, #1
     ${loadCtx}; bl #${code}
     cmp r0, #0
     pop {r0, r1, r2, r3, ip, lr}
     bxne lr
     b #${FAST_PATH}`, at), 16);
  patch.setWord(FAST_CALL, branchWord(FAST_CALL, fast, 14, true), 'sensor shift: the fast path of a switch message');
  // --- The three values: (view, text). The module's text in place of the camera's during the adjustment.
  const labels = [0, 1, 2].map((which) => patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     mov r2, #${which}; mov r1, #2
     ${loadCtx}; bl #${code}
     mov ip, r0
     pop {r0, r1, r2, r3}
     cmp ip, #0; movne r1, ip
     pop {ip, lr}
     b #${SET_TEXT}`, at), 16));
  for (const [call, which] of LABEL_CALLS) patch.setWord(call, branchWord(call, labels[which], 14, true), 'sensor shift: X, Y and R in place of shutter speed, aperture and ISO');
  // --- The ISO icon: none during the adjustment.
  const icon = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     mov r1, #3
     ${loadCtx}; bl #${code}
     cmp r0, #0
     pop {r0, r1, r2, r3, ip, lr}
     movne r0, #0; bxne lr
     b #${SV_ICON_OF}`, at), 16);
  patch.setWord(SV_ICON_CALL, branchWord(SV_ICON_CALL, icon, 14, true), 'sensor shift: no ISO icon in front of R');
  // --- The key guide: (LV, icon*, ascii*, text*). 1 = filled in.
  const guide = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     sub sp, sp, #8; str r3, [sp]
     mov r3, r2; mov r2, r1; mov r1, #5
     ${loadCtx}; bl #${code}
     add sp, sp, #8
     cmp r0, #0
     pop {r0, r1, r2, r3, ip, lr}
     movne r0, #1; bxne lr
     mov ip, sp
     b #${GUIDE + 4}`, at), 16);
  patch.setWord(GUIDE, branchWord(GUIDE, guide), 'sensor shift: the key guide');
  // --- Shake reduction on (r7): off while the sensor is shifted or the adjustment is on.
  const srOff = patch.append((at) => assembleWords(
    `push {r0, r1, r2, r3, ip, lr}
     mov r1, #4
     ${loadCtx}; bl #${code}
     cmp r0, #0
     pop {r0, r1, r2, r3, ip, lr}
     movne r7, #0
     cmp r7, #0
     bx lr`, at), 16);
  patch.setWord(SR_STATE_ON, branchWord(SR_STATE_ON, srOff, 14, true), 'sensor shift: shake reduction off while the sensor is shifted');
  return { code, ctx, loadCtx };
}

/** What the word at `at` (the entry of a lookup: `cmp r1, #0`, or an earlier addition's branch) goes on to. */
function entryTail(patch: Patch, at: number): string {
  const first = patch.word(at);
  if (first === 0xe3510000) return `cmp r1, #0; b #${at + 4}`;
  if (first >>> 24 === 0xea) return `b #${branchTarget(at, first)}`;
  return fail('unexpected-layout', 'sensor shift: a lookup does not start as expected');
}

/**
 * The ADJ lever function (after every addition that changes the function table's records in place
 * or copies it: soft focus, Direct Flash, exposure preview, Constant Light). `fn` is its number,
 * `shiftAdjFunction`. Returns the table's new address.
 */
export function installShiftAdj(patch: Patch, core: ShiftCode, fn: number): number {
  const at = ADJ_TABLE_SITES.map(([low, high, r]) => {
    const a = patch.word(low), b = patch.word(high);
    if (a !== movWord(r, movImmediate(a)) || b !== movWord(r, movImmediate(b), true)) fail('unexpected-layout', 'ADJ function table site is not a MOVW/MOVT pair');
    return (movImmediate(a) | (movImmediate(b) << 16)) >>> 0;
  });
  const old = at[0];
  if (at.some((t) => t !== old)) fail('unexpected-layout', 'ADJ function table is not where it was expected');
  const functions = (patch.word(ADJ_TABLE_END) - old) / ADJ_RECORD;
  if (functions !== fn || !(fn >= ADJ_OFFICIAL_FUNCTIONS && fn <= ADJ_OFFICIAL_FUNCTIONS + 2) || (old === ADJ_TABLE) !== (fn === ADJ_OFFICIAL_FUNCTIONS)) fail('unexpected-layout', 'ADJ function table does not have the functions expected');
  const crop = patch.read(old + CROP * ADJ_RECORD, ADJ_RECORD);
  const cv = new DataView(crop.buffer);
  if (cv.getUint32(0x10, true) !== adr(0x531bb654) || cv.getUint32(0x38, true) !== 0 || cv.getUint32(0x3c, true) !== adr(0x531bdf1c) || cv.getUint32(0x40, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');
  for (const off of [H_DRAW, H_IS_CURRENT, H_SET, H_COUNT]) if (cv.getUint32(off, true) === 0 || cv.getUint32(off + 4, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');
  for (const off of [H_ENTER, H_ENTER + 4, H_LEAVE, H_LEAVE + 4]) if (cv.getUint32(off, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');

  // --- Handlers (this = r0, value index = r1): into the module.
  const { loadCtx, code } = core;
  const enter = patch.append((a) => assembleWords(`mov r1, #6; ${loadCtx}; b #${code}`, a), 16);
  const leave = patch.append((a) => assembleWords(`mov r1, #7; ${loadCtx}; b #${code}`, a), 16);
  const draw = patch.append((a) => assembleWords(`mov r3, r1; mov r2, r0; mov r1, #8; ${loadCtx}; b #${code}`, a), 16);
  const current = patch.append((a) => assembleWords(`mov r2, r1; mov r1, #9; ${loadCtx}; b #${code}`, a), 16);
  const set = patch.append((a) => assembleWords(`mov r2, r1; mov r1, #10; ${loadCtx}; b #${code}`, a), 16);
  const count = patch.append((a) => assembleWords('mov r0, #2; bx lr', a), 16);
  const record = crop.slice();
  const rv = new DataView(record.buffer);
  rv.setUint32(H_ENTER, enter, true);
  rv.setUint32(H_LEAVE, leave, true);
  rv.setUint32(H_DRAW, draw, true);
  rv.setUint32(H_IS_CURRENT, current, true);
  rv.setUint32(H_SET, set, true);
  rv.setUint32(H_COUNT, count, true);
  rv.setUint32(0x3c, 0, true); // no "disabled" check (Crop's would disable it with Crop)

  // --- The table, copied with the record; every reference moved.
  const table = patch.append(concat([patch.read(old, fn * ADJ_RECORD), record]), 16);
  for (const [low, high, r] of ADJ_TABLE_SITES) {
    patch.setWord(low, movWord(r, lo(table)), 'sensor shift: ADJ function table, low half');
    patch.setWord(high, movWord(r, hi(table), true), 'sensor shift: ADJ function table, high half');
  }
  patch.setWord(ADJ_TABLE_END, table + (fn + 1) * ADJ_RECORD, 'sensor shift: end of the ADJ function table');

  // --- Name and icon (before the camera's own cases, or an earlier addition's).
  const nameTail = entryTail(patch, ADJ_NAME_OF);
  const name = patch.append((a) => assembleWords(
    `cmp r1, #${fn}; movweq r0, #${SHIFT_TEXT_IDS.name}; bxeq lr
     ${nameTail}`, a), 16);
  patch.setWord(ADJ_NAME_OF, branchWord(ADJ_NAME_OF, name), 'sensor shift: ADJ function name');
  const iconTail = entryTail(patch, ADJ_ICON_OF);
  const icon = patch.append((a) => assembleWords(
    `cmp r1, #${fn}; bne other
     cmp r2, #0; movne r0, #0; movweq r0, #${SHIFT_ICON_ID}; bx lr
     other: ${iconTail}`, a), 16);
  patch.setWord(ADJ_ICON_OF, branchWord(ADJ_ICON_OF, icon), 'sensor shift: ADJ function icon');

  // --- ADJ Mode Setting: the functions offered, the new one last.
  const listAt = (movImmediate(patch.word(ADJ_LIST_LOW)) | (movImmediate(patch.word(ADJ_LIST_HIGH)) << 16)) >>> 0;
  expectWord(patch, ADJ_LIST_LOW, movWord(4, lo(listAt)));
  expectWord(patch, ADJ_LIST_HIGH, movWord(4, hi(listAt), true));
  const lengthWord = patch.word(ADJ_LIST_LENGTH);
  if ((lengthWord & 0xffffff00) >>> 0 !== 0xe2846000) fail('unexpected-layout', 'ADJ function list length is not as expected');
  const list = [...patch.read(listAt, lengthWord & 0xff)];
  if (list.includes(fn) || list.some((f) => f >= fn)) fail('unexpected-layout', 'ADJ function list is not as expected');
  list.push(fn);
  const newList = patch.append(Uint8Array.from(list), 16);
  patch.setWord(ADJ_LIST_LOW, movWord(4, lo(newList)), 'sensor shift: ADJ function list, low half');
  patch.setWord(ADJ_LIST_HIGH, movWord(4, hi(newList), true), 'sensor shift: ADJ function list, high half');
  patch.setWord(ADJ_LIST_LENGTH, 0xe2846000 | list.length, 'sensor shift: ADJ function list length');
  return table;
}

/**
 * The Fn function 0x2E: a row at the end of the Fn button's list, and in the held Movie button's
 * list (after Constant Light's Fn function, which copies the lists and takes the lookups' entries first).
 */
export function installShiftFn(patch: Patch, core: ShiftCode): void {
  const { loadCtx, code } = core;
  // "Offered on this model": cases for 0x19..0x2d only; a higher number is offered.
  expectWord(patch, FN_AVAILABLE, 0xe2400019); // sub r0, r0, #0x19
  expectWord(patch, FN_AVAILABLE + 0x10, 0xe3500014); // cmp r0, #0x14
  expectWord(patch, FN_AVAILABLE + 0x14, 0x979ff100); // ldrls pc, [pc, r0, lsl #2]
  expectWord(patch, FN_AVAILABLE + 0x18, branchWord(FN_AVAILABLE + 0x18, FN_AVAILABLE + 0xd0)); // b: mov r0, #1
  expectWord(patch, FN_AVAILABLE + 0xd0, 0xe3a00001);
  // The three function switches: a number above 0x2d goes to their defaults (an assertion's log). Each gets a case
  // before its bounds check (the camera's, or Constant Light's case in its place): nothing, then the end that
  // function 0 (none) goes to. The module acts on the key events themselves.
  for (const [bound, register, end, what] of [[FN_SWITCH_BOUND, 'r2', FN_SWITCH_END, 'the buttons'], [MOVIE_SWITCH_BOUND, 'sl', MOVIE_SWITCH_END, 'the Movie button'], [MOVIE_HELD_BOUND, 'r0', MOVIE_SWITCH_END, 'the end of a hold']] as const) {
    if ((patch.word(bound + 4) & 0xfffffff0) >>> 0 !== 0x979ff100) fail('unexpected-layout', 'sensor shift: a function switch is not as expected'); // ldrls pc, [pc, rX, lsl #2]
    expectWord(patch, bound + 12, end); // function 0 (none): the end
    const first = patch.word(bound);
    const tail = (first & 0xfff0ffff) >>> 0 === 0xe350002d ? `cmp ${register}, #0x2d; b #${bound + 4}` : first >>> 24 === 0xea ? `b #${branchTarget(bound, first)}` : fail('unexpected-layout', 'sensor shift: a function switch does not start as expected');
    const skip = patch.append((a) => assembleWords(
      `cmp ${register}, #${FN_SHIFT}; beq #${end}
       ${tail}`, a), 16);
    patch.setWord(bound, branchWord(bound, skip), `sensor shift: the Fn function does nothing in the switch of ${what}`);
  }

  // --- Name and icon (before the camera's own cases, or Constant Light's).
  const nameTail = entryTail(patch, FN_NAME_OF);
  const name = patch.append((a) => assembleWords(
    `cmp r1, #${FN_SHIFT}; movweq r0, #${SHIFT_TEXT_IDS.name}; bxeq lr
     ${nameTail}`, a), 16);
  patch.setWord(FN_NAME_OF, branchWord(FN_NAME_OF, name), 'sensor shift: Fn function name');
  const iconTail = entryTail(patch, FN_ICON_OF);
  const icon = patch.append((a) => assembleWords(
    `cmp r1, #${FN_SHIFT}; bne other
     cmp r2, #0; movne r0, #0; movweq r0, #${SHIFT_ICON_ID}; bx lr
     other: ${iconTail}`, a), 16);
  patch.setWord(FN_ICON_OF, branchWord(FN_ICON_OF, icon), 'sensor shift: Fn function icon');

  // --- The held Movie button's list (the official one, or Constant Light's copy): one more function.
  const heldAt = (movImmediate(patch.word(HELD_LIST_LOW)) | (movImmediate(patch.word(HELD_LIST_HIGH)) << 16)) >>> 0;
  expectWord(patch, HELD_LIST_LOW, movWord(4, lo(heldAt)));
  expectWord(patch, HELD_LIST_HIGH, movWord(4, hi(heldAt), true));
  const heldLength = patch.word(HELD_LIST_LENGTH);
  if ((heldLength & 0xffffff00) >>> 0 !== 0xe2846000) fail('unexpected-layout', 'the held Movie button\'s function list length is not as expected');
  const held = [...patch.read(heldAt, heldLength & 0xff)];
  const official = patch.read(HELD_LIST, HELD_LIST_OFFICIAL.length);
  if (!HELD_LIST_OFFICIAL.every((v, i) => official[i] === v && held[i] === v) || held.length > HELD_LIST_OFFICIAL.length + 1 || held.includes(FN_SHIFT)) fail('unexpected-layout', 'the held Movie button\'s function list is not as expected');
  held.push(FN_SHIFT);
  const heldList = patch.append(Uint8Array.from(held), 16);
  patch.setWord(HELD_LIST_LOW, movWord(4, lo(heldList)), 'sensor shift: held Movie button function list, low half');
  patch.setWord(HELD_LIST_HIGH, movWord(4, hi(heldList), true), 'sensor shift: held Movie button function list, high half');
  patch.setWord(HELD_LIST_LENGTH, 0xe2846000 | held.length, 'sensor shift: held Movie button function list length');

  // --- The Fn button's list: the record's handlers, with a row of their own after the camera's.
  const record = listTable(patch) + FN_LIST_RECORD * LIST_RECORD;
  const rv = new DataView(patch.read(record, LIST_RECORD).buffer);
  if (rv.getUint16(4, true) !== FN_LIST_TITLE || rv.getUint32(0x0c, true) !== FN_LIST_COUNT || rv.getUint32(0x14, true) !== FN_LIST_DRAW || rv.getUint32(0x24, true) !== FN_LIST_SET || rv.getUint32(0x2c, true) !== FN_LIST_CURRENT
    || [0x10, 0x18, 0x28, 0x30].some((off) => rv.getUint32(off, true) !== 0)) fail('unexpected-layout', 'the Fn button\'s list record is not as expected');
  expectWord(patch, FN_LIST_COUNT, 0xe59031b8); // ldr r3, [r0, #0x1b8]
  expectWord(patch, FN_LIST_COUNT + 4, 0xe59001b4); // ldr r0, [r0, #0x1b4]
  expectWord(patch, FN_LIST_DRAW + 0x60, branchWord(FN_LIST_DRAW + 0x60, LIST_SET_ITEM)); // b: the row's icon and text
  expectWord(patch, FN_LIST_SET + 0x2c, branchWord(FN_LIST_SET + 0x2c, SET_FN));
  expectWord(patch, SET_FN - 0xd8 + 0x18, 0xe5d00925); // ldrb r0, [r0, #0x925]: the function kept
  if (patch.word(ctxWord(core, CTX.fnDraw)) !== FN_LIST_DRAW || patch.word(ctxWord(core, CTX.fnSet)) !== FN_LIST_SET || patch.word(ctxWord(core, CTX.fnCurrent)) !== FN_LIST_CURRENT) fail('internal', 'sensor shift: context');
  const count = patch.append((a) => assembleWords(`mov r2, r0; mov r1, #11; ${loadCtx}; b #${code}`, a), 16);
  const draw = patch.append((a) => assembleWords(
    `push {r4, lr}
     sub sp, sp, #8; str r2, [sp]
     mov r3, r1; mov r2, r0; mov r1, #12
     ${loadCtx}; bl #${code}
     add sp, sp, #8
     pop {r4, pc}`, a), 16);
  const set = patch.append((a) => assembleWords(`mov r3, r1; mov r2, r0; mov r1, #13; ${loadCtx}; b #${code}`, a), 16);
  const current = patch.append((a) => assembleWords(`mov r3, r1; mov r2, r0; mov r1, #14; ${loadCtx}; b #${code}`, a), 16);
  patch.setWord(record + 0x0c, count, 'sensor shift: the Fn button\'s list, one more row');
  patch.setWord(record + 0x14, draw, 'sensor shift: the Fn button\'s list, the row');
  patch.setWord(record + 0x24, set, 'sensor shift: the Fn button\'s list, the row chosen');
  patch.setWord(record + 0x2c, current, 'sensor shift: the Fn button\'s list, the row current');
}

function ctxWord(core: ShiftCode, index: number): number {
  return core.ctx + index * 4;
}
