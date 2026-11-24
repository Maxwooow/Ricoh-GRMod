// SPDX-License-Identifier: GPL-2.0-only
/**
 * The lamp on the front of the camera (AF assist light and self-timer lamp, one LED) kept lit:
 * "Constant Light", Off / On (GR IV firmware 1.20 and 1.21).
 *
 * Where it can be switched:
 *  - a line of the still shooting menu, "Constant Light", after AF Assist Light, opening a list
 *    Off / On (controller id LAMP_LIST_ID, Horizon Correction's list controller, as HDR's);
 *  - an ADJ lever function (the next number after the camera's 0x14 and exposure preview's 0x15),
 *    offered by ADJ Mode Setting, with the values Off / On;
 *  - an Fn function, 0x29, offered for the Fn, ISO, Drive and White Balance / Image Control
 *    buttons (the list those four share) and for the Movie button, pressed and held (a list
 *    each): each press, or hold, switches the lamp on or off.
 * It is not a setting: the lamp is off when the camera starts, and is switched off when the camera
 * shuts down. Nothing is kept in the user settings.
 *
 * Everything below was found by reading the official 1.20 code, starting from the class names and
 * the texts of its LED code ("SelfAfAssistCommonLed", "AfAssistLed", "AF LED  ON").
 *
 * The lamp. LedControlFactory (one object, 0x5396783C returns it; its fields are set by its build
 * function 0x53967678) keeps the LED objects. +0xC is the lamp itself: a 0x14-byte object (vtable
 * 0x54335C78; constructor 0x53966EEC) with "lit" at +4, "initialised" at +5, a mutex at +8 and the
 * device at +0x10 (+0xC on another board). Its on (0x53966C48) and off (0x53966A78) are reached
 * through its vtable only, by the two small objects through which the self-timer (+0x10, SelfLed)
 * and the auto focus (+0x14, AfAssistLed) ask for the lamp: each takes the mutex, sets its own flag
 * at +8 and calls on; its off calls off, gives the mutex back and clears the flag.
 * (+8 of the factory is another LED, a 0x74-byte StatusLed with its own task and a device handle
 * at +0x60: test 095 took that one for the lamp, read past the lamp's 0x14 bytes and the camera
 * lost power the moment Constant Light was switched on.)
 *
 * What is changed:
 *  - LAMP_WORD (a word of the unused sbrk arena before the heap, zero at start-up, see
 *    `battery.ts`) holds the lamp object's address while Constant Light is on, else 0;
 *  - the lamp's off (0x53966A78), at its entry: nothing while LAMP_WORD is set. So the camera's own
 *    uses of the lamp (AF assist, the self-timer) run as they do, with their mutex and flags, and
 *    leave the lamp lit;
 *  - `set` (appended): on = LAMP_WORD and the lamp's on; off = LAMP_WORD 0 and, unless the
 *    self-timer or the auto focus has the lamp just now (their flags), the lamp's off. Nothing
 *    when the lamp object is not there or not initialised. Neither takes the mutex;
 *  - the shutdown model's handler of the preparation state (0x5325F81C, AppShutDownModel.cpp), at
 *    its entry: Constant Light off;
 *  - the menus: a list record and the still-menu line (`datestamp-menu.ts`), the ADJ function
 *    table copied with one more record (as `exposure.ts` does for 0x15; after it when both are in
 *    the build), the function's name and icon;
 *  - the Fn functions: 0x29 is a number the camera does not use. 0x26..0x29 share the name and the
 *    icon of Preview, but only 0x26 is in a list (the held Movie button's) and has a case; 0x27..0x29
 *    are in no list and go to the default of both function switches (0x533990E0, 0x53397A70), so
 *    no button can hold them. The list of the functions the four
 *    buttons offer (39 bytes at 0x53DE50C4, read by 0x531DCAFC into the list controller's vector
 *    +0x1B4) is copied with 0x29 at its end; name (0x5338FBAC) and icon (0x533914BC) get a case at
 *    their entries; the function switch gets a case before its bounds check (0x5339910C): on a
 *    press (r6 = 0, as the camera's own cases) the lamp is switched over, then the switch's common
 *    end (0x5339927C). The Movie button has its own lists (pressed: 35 bytes at 0x53DE515C, vector
 *    +0x1C0; held: 37 bytes at 0x53DE52BC, vector +0x1CC), copied the same way, and its own switch
 *    0x53397A70 (this, shared pointer, event): event 2 takes the pressed function, 3 the held one,
 *    both to the jump table at 0x53397BD8, which gets the case before its bounds check (the lamp
 *    switched over, then the switch's end 0x53397AD0, where function 0 goes); event 4 has a table of
 *    its own for the held function (0x53397CA0: nothing but for Preview, an assertion for the
 *    functions the held list does not offer), where 0x29 gets the entry of the functions that do
 *    nothing.
 *
 * Going back to a firmware without this: an Fn button left on 0x29 does nothing there (the
 * official switch logs it and returns); an ADJ slot left on the added function must be set to
 * something else first, as for exposure preview (the settings guard of a GR Mod build does it).
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchTarget, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, Patch, concat, expectWord, u16le, u32le, widenTextRows } from './build';
import { ICON_OFF, ICON_ON, LIST_CONTROLLER_ID, LIST_SET_ITEM, StillLine, TEXT_OFF, TEXT_ON, TOP_SET_TITLE, addListRecords, hookControllerFactory, installTexts, listTemplate } from './datestamp-menu';
import { adr } from '../target';

/** The lamp object's address while Constant Light is on, else 0 (the sbrk arena, 0x55839040..0x55839080: `battery.ts`). */
export const LAMP_WORD = adr(0x55839074);
export const LAMP_TEXT_ID = 1040;
/** Identity 22 of the ratio icon numbers, never given out (as 734..737, `exposure.ts`). */
export const LAMP_ICON_ID = 738;
export const LAMP_LIST_ID = 0x020001d4;
/** The Fn function: a number the camera does not use (in no list, no case in its function switches). */
export const FN_LAMP = 0x29;
/** AF Assist Light, the still-menu line the new one follows. */
export const AF_ASSIST_LINE_ID = 0x02000075;

const FACTORY_GET = adr(0x5396783c); // LedControlFactory: the one object
const FACTORY_BUILD = adr(0x53967678); // makes the LED objects
const LAMP_VTABLE = adr(0x54335c78);
const LAMP_CONSTRUCTOR = adr(0x53966eec);
const LAMP_ON = adr(0x53966c48); // (lamp object)
const LAMP_OFF = adr(0x53966a78); // (lamp object)
const SHUTDOWN_PREPARATION = adr(0x5325f81c); // AppShutDownModel: the preparation state's handler
const TOP_SET_ICON = adr(0x5359d6f4); // (menu line, icon)
const LIST_ITEM = adr(0x53593d64); // (list, index) -> item (the ADJ controller's list view)
const ITEM_SET_TEXT = adr(0x535a1138); // (item, text number)

const ADJ_TABLE = adr(0x53dc9dfc);
const ADJ_RECORD = 0x5c;
const ADJ_OFFICIAL_FUNCTIONS = 21;
const CROP = 0x13;
const H_DRAW = 0x18;
const H_IS_CURRENT = 0x20;
const H_SET = 0x28;
const H_COUNT = 0x30;
/** Every MOVW / MOVT pair that loads the ADJ function table's address: [movw, movt, register] (as `exposure.ts`). */
const ADJ_TABLE_SITES: readonly (readonly [number, number, number])[] = [
  [adr(0x531bd4c4), adr(0x531bd4d4), 4], [adr(0x531bee8c), adr(0x531bee94), 2], [adr(0x531bf028), adr(0x531bf030), 3], [adr(0x531bf0c4), adr(0x531bf0cc), 2],
  [adr(0x531bf5c0), adr(0x531bf5c8), 2], [adr(0x531bffd4), adr(0x531bffdc), 2], [adr(0x531c0030), adr(0x531c0038), 2], [adr(0x531c0128), adr(0x531c0130), 2],
  [adr(0x531c01b4), adr(0x531c01bc), 2], [adr(0x531c0240), adr(0x531c0248), 2], [adr(0x531c02e8), adr(0x531c02f0), 7], [adr(0x531c0434), adr(0x531c043c), 2],
  [adr(0x531c05d4), adr(0x531c05dc), 2], [adr(0x531c06d0), adr(0x531c06e8), 4], [adr(0x531c09dc), adr(0x531c09e4), 6], [adr(0x531c0ae8), adr(0x531c0af0), 2],
  [adr(0x531c0b94), adr(0x531c0b9c), 2], [adr(0x531c0bfc), adr(0x531c0c0c), 7], [adr(0x531c0cb8), adr(0x531c0cc8), 7], [adr(0x531c0e9c), adr(0x531c0ea4), 2],
  [adr(0x531c1060), adr(0x531c1064), 3], [adr(0x531c1220), adr(0x531c1228), 2],
];
const ADJ_TABLE_END = adr(0x531bd600); // the initialiser's end of the table (a literal word)
const ADJ_NAME_OF = adr(0x5338f484); // (resources, function) -> text: cmp r1, #0 first
const ADJ_ICON_OF = adr(0x53390e40); // (resources, function, variant) -> icon: cmp r1, #0 first
const ADJ_LIST_LOW = adr(0x531dc834); // movw r4, #lo(list)
const ADJ_LIST_HIGH = adr(0x531dc844); // movt r4, #hi(list)
const ADJ_LIST_LENGTH = adr(0x531dc860); // add r6, r4, #length

const FN_NAME_OF = adr(0x5338fbac); // (resources, function) -> text: cmp r1, #0 first
const FN_ICON_OF = adr(0x533914bc); // (resources, function, variant) -> icon: cmp r1, #0 first
const FN_LIST_OFFICIAL = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x2d, 0x2c, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x2b, 0x23, 0x24,
];
const FN_LIST_LOW = adr(0x531dcb04); // movw r4, #lo(list)
const FN_LIST_HIGH = adr(0x531dcb08); // movt r4, #hi(list)
const FN_LIST_LENGTH = adr(0x531dcb18); // add r6, r4, #length
const FN_AVAILABLE = adr(0x531d75d8); // (function) -> offered on this model: only 0x19..0x2d have cases, 0x29 none
const FN_SWITCH = adr(0x533990e0); // (this, shared pointer, function, released, key)
const FN_SWITCH_BOUND = adr(0x5339910c); // cmp r2, #0x2d
const FN_SWITCH_END = adr(0x5339927c); // the cases' common end
const FN_SWITCH_DEFAULT = adr(0x5339b0d4);
/** The Movie button's lists: [list, its official bytes, movw r4, movt r4, add r6 r4 #length]. */
const MOVIE_LIST_PRESSED = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x2d, 0x2c, 0x1e, 0x1f, 0x20, 0x22, 0x2b, 0x23, 0x24,
];
const FN_LISTS: readonly (readonly [number, readonly number[], number, number, number, string])[] = [
  [adr(0x53de50c4), FN_LIST_OFFICIAL, FN_LIST_LOW, FN_LIST_HIGH, FN_LIST_LENGTH, 'Fn'],
  [adr(0x53de515c), MOVIE_LIST_PRESSED, adr(0x531dcb88), adr(0x531dcb8c), adr(0x531dcb9c), 'Movie button'],
  [adr(0x53de52bc), [...MOVIE_LIST_PRESSED, 0x25, 0x26], adr(0x531dcc0c), adr(0x531dcc10), adr(0x531dcc20), 'held Movie button'],
];
const MOVIE_SWITCH = adr(0x53397a70); // (this, shared pointer, event 2 / 3 / 4)
const MOVIE_SWITCH_BOUND = adr(0x53397bd8); // cmp sl, #0x2d (events 2 and 3: the function in sl)
const MOVIE_SWITCH_END = adr(0x53397ad0); // the stack check and the return
const MOVIE_SWITCH_DEFAULT = adr(0x533990a4);
const MOVIE_HELD_BOUND = adr(0x53397ca0); // cmp r0, #0x2d (event 4: the held function)
const MOVIE_HELD_DEFAULT = adr(0x53397e3c);

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const LAMP_NAMES: readonly string[] = [
  'Trvalé světlo', 'Konstant lys', 'Constant Light', 'Jatkuva valo', 'Lumière continue', 'Dauerlicht', 'Συνεχές φως', 'Folyamatos fény',
  'Luce continua', '補助光常時点灯', '보조광 상시 점등', 'Continu licht', 'Światło ciągłe', 'Luz contínua', 'Постоянный свет', '辅助灯常亮',
  'Luz continua', 'Konstant ljus', 'ไฟส่องต่อเนื่อง', '輔助燈常亮', 'Sürekli ışık',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** The ADJ lever function's number: after the camera's 21 and, with exposure preview on the ADJ lever, its 0x15. */
export function lampAdjFunction(exposurePreview: boolean): number {
  return ADJ_OFFICIAL_FUNCTIONS + (exposurePreview ? 1 : 0);
}

/** The 40x40 icon: a lamp (a disc with eight rays) on the tile of the camera's ADJ and Fn icons. */
export function drawLampIcon(): Uint8Array {
  const px = new Uint8Array(40 * 40 * 4);
  const cover = (x: number, y: number): number => {
    const dx = x - 20, dy = y - 20;
    const r = Math.hypot(dx, dy);
    if (r <= 6.5) return 1;
    if (r < 9.5 || r > 15) return 0;
    // eight rays, 2.4 px wide
    const a = Math.atan2(dy, dx);
    const nearest = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    return Math.abs(r * Math.sin(a - nearest)) <= 1.2 ? 1 : 0;
  };
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const i = (y * 40 + x) * 4;
      if (x < 1 || y < 1 || x > 38 || y > 38) px.set([255, 255, 255, 0], i);
      else if (x === 1 || y === 1 || x === 38 || y === 38) px.set([128, 128, 128, 255], i);
      else {
        let sum = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) sum += cover(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
        const v = sum / 16;
        px.set([Math.round(53 + (255 - 53) * v), Math.round(53 + (255 - 53) * v), Math.round(54 + (255 - 54) * v), 255], i);
      }
    }
  }
  return px;
}

/** The name and the icon (once, before the menus use them). Returns ICONBIN with the icon appended. */
export function installLampAssets(patch: Patch, iconbin: Uint8Array): Uint8Array {
  if (LAMP_NAMES.length !== LANGUAGES) fail('internal', 'constant light: texts');
  widenTextRows(patch, LAMP_TEXT_ID);
  installTexts(patch, [{ id: LAMP_TEXT_ID, names: LAMP_NAMES }]);
  if (patch.word(ICON_CATALOG + LAMP_ICON_ID * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
  const pad = (4 - (iconbin.length % 4)) % 4;
  const offset = iconbin.length + pad;
  const descriptor = patch.append(concat([u16le([1, 40, 40, 0]), u32le([offset / 4])]), 16);
  patch.write(ICON_CATALOG + LAMP_ICON_ID * 4, u32le([descriptor]));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(LAMP_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat([iconbin, new Uint8Array(pad), drawLampIcon()]);
}

export interface LampCode {
  /** (on: 0 / 1): Constant Light off / on. */
  set: number;
  /** (): the other of the two. */
  toggle: number;
}

/**
 * The lamp itself: `set`, the off function's redirection and the shutdown. Before the menus, which
 * call `set`.
 */
export function installLampCore(patch: Patch): LampCode {
  expectWord(patch, FACTORY_GET, 0xe1a0c00d); // mov ip, sp
  // The factory's build function: the lamp (0x14 bytes, its constructor) into +0xC, SelfLed (made with the lamp) into +0x10, AfAssistLed into +0x14.
  expectWord(patch, FACTORY_BUILD + 0xb8, 0xe3a00014); // mov r0, #0x14
  expectWord(patch, FACTORY_BUILD + 0xc4, branchWord(FACTORY_BUILD + 0xc4, LAMP_CONSTRUCTOR, 14, true));
  expectWord(patch, FACTORY_BUILD + 0xd8, 0xe584800c); // str r8, [r4, #0xc]
  expectWord(patch, FACTORY_BUILD + 0x10c, 0xe594100c); // ldr r1, [r4, #0xc]
  expectWord(patch, FACTORY_BUILD + 0x128, 0xe5848010); // str r8, [r4, #0x10]
  expectWord(patch, FACTORY_BUILD + 0x160, 0xe594100c);
  expectWord(patch, FACTORY_BUILD + 0x17c, 0xe5848014); // str r8, [r4, #0x14]
  // The lamp's constructor and vtable: on at +8, off at +0xc.
  expectWord(patch, LAMP_CONSTRUCTOR + 0x24, LAMP_VTABLE);
  expectWord(patch, LAMP_VTABLE + 8, LAMP_ON);
  expectWord(patch, LAMP_VTABLE + 0xc, LAMP_OFF);
  // on: initialised (+5), the device (+0xc or +0x10), lit (+4).
  expectWord(patch, LAMP_ON, 0xe1a0c00d);
  expectWord(patch, LAMP_ON + 0xc, 0xe5d03005); // ldrb r3, [r0, #5]
  expectWord(patch, LAMP_ON + 0x1c, 0xe590000c); // ldr r0, [r0, #0xc]
  expectWord(patch, LAMP_ON + 0x34, 0xe5c43004); // strb r3, [r4, #4]
  expectWord(patch, LAMP_ON + 0x3c, 0xe5940010); // ldr r0, [r4, #0x10]
  expectWord(patch, LAMP_ON + 0x44, 0xe5933058); // ldr r3, [r3, #0x58]
  expectWord(patch, LAMP_OFF, 0xe1a0c00d);
  expectWord(patch, LAMP_OFF + 4, 0xe92dd818); // push {r3, r4, fp, ip, lr, pc}
  expectWord(patch, LAMP_OFF + 0x38, 0xe5933054); // ldr r3, [r3, #0x54]
  // SelfLed and AfAssistLed: the lamp at +4, "has the lamp" at +8 (AfAssistLed's off-if-on, 0x53967430).
  expectWord(patch, adr(0x53967430), 0xe5d03008); // ldrb r3, [r0, #8]
  expectWord(patch, adr(0x53966f14) + 8, 0xe5801004); // SelfLed's constructor: str r1, [r0, #4]
  expectWord(patch, adr(0x53966f14) + 0x10, 0xe5c02008); // strb r2, [r0, #8]
  expectWord(patch, adr(0x53967390) + 8, 0xe5801004); // AfAssistLed's constructor
  expectWord(patch, adr(0x53967390) + 0x10, 0xe5c02008);
  expectWord(patch, SHUTDOWN_PREPARATION, 0xe1a0c00d);
  expectWord(patch, SHUTDOWN_PREPARATION + 4, 0xe92dd830);

  const set = patch.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r5, r0
     bl #${FACTORY_GET}
     mov r6, r0
     ldr r4, [r6, #0xc]
     cmp r4, #0; beq out
     ldrb r1, [r4, #5]
     cmp r1, #0; beq out
     movw r2, #${lo(LAMP_WORD)}; movt r2, #${hi(LAMP_WORD)}
     cmp r5, #0; beq off
     str r4, [r2]
     mov r0, r4
     pop {r4, r5, r6, lr}
     b #${LAMP_ON}
     off: mov r1, #0; str r1, [r2]
     ldr r1, [r6, #0x10]
     cmp r1, #0; ldrbne r1, [r1, #8]
     cmp r1, #0; bne out
     ldr r1, [r6, #0x14]
     cmp r1, #0; ldrbne r1, [r1, #8]
     cmp r1, #0; bne out
     mov r0, r4
     pop {r4, r5, r6, lr}
     b #${LAMP_OFF}
     out: pop {r4, r5, r6, pc}`, at), 16);
  const toggle = patch.append((at) => assembleWords(
    `movw r0, #${lo(LAMP_WORD)}; movt r0, #${hi(LAMP_WORD)}; ldr r0, [r0]
     cmp r0, #0; moveq r0, #1; movne r0, #0
     b #${set}`, at), 16);
  // The lamp's off: nothing while Constant Light is on.
  const off = patch.append((at) => assembleWords(
    `movw ip, #${lo(LAMP_WORD)}; movt ip, #${hi(LAMP_WORD)}; ldr ip, [ip]
     cmp ip, #0; bxne lr
     mov ip, sp
     b #${LAMP_OFF + 4}`, at), 16);
  patch.setWord(LAMP_OFF, branchWord(LAMP_OFF, off), 'constant light: the lamp is not switched off while it is on');
  // Shutdown: off (every register kept; the handler's own first instruction, then on).
  const shutdown = patch.append((at) => assembleWords(
    `movw ip, #${lo(LAMP_WORD)}; movt ip, #${hi(LAMP_WORD)}; ldr ip, [ip]
     cmp ip, #0; beq native
     push {r0, r1, r2, r3, ip, lr}
     mov r0, #0; bl #${set}
     pop {r0, r1, r2, r3, ip, lr}
     native: mov ip, sp
     b #${SHUTDOWN_PREPARATION + 4}`, at), 16);
  patch.setWord(SHUTDOWN_PREPARATION, branchWord(SHUTDOWN_PREPARATION, shutdown), 'constant light: off when the camera shuts down');
  return { set, toggle };
}

/** r3 = 1 while Constant Light is on, else 0. */
const LOAD = `movw r3, #${lo(LAMP_WORD)}; movt r3, #${hi(LAMP_WORD)}; ldr r3, [r3]
    cmp r3, #0; movne r3, #1`;

/** The still-menu line (its draw function; before the still menu is built). */
export function lampStillLine(patch: Patch): StillLine {
  expectWord(patch, TOP_SET_ICON, 0xe1a0c00d);
  expectWord(patch, TOP_SET_TITLE, 0xe1a0c00d);
  const draw = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     ${LOAD}
     cmp r3, #0; movweq r1, #${ICON_OFF}; movwne r1, #${ICON_ON}
     mov r0, r4; bl #${TOP_SET_ICON}
     mov r0, r4; movw r1, #${LAMP_TEXT_ID}
     pop {r4, lr}; b #${TOP_SET_TITLE}`, at), 16);
  return { draw, id: LAMP_LIST_ID, after: AF_ASSIST_LINE_ID };
}

/** The list the line opens (after the additions that copy the list table first). */
export function installLampList(patch: Patch, code: LampCode): void {
  expectWord(patch, LIST_SET_ITEM, 0xe1a0c00d);
  // Count (this = r0), draw (item = r1, value i = r2), set and is current (value i = r1): Off, On.
  const count = patch.append((at) => assembleWords('mov r0, #2; bx lr', at), 16);
  const draw = patch.append((at) => assembleWords(
    `cmp r2, #1; bxhi lr
     mov r0, r1
     movweq r1, #${ICON_ON}; movweq r2, #${TEXT_ON}
     movwne r1, #${ICON_OFF}; movwne r2, #${TEXT_OFF}
     b #${LIST_SET_ITEM}`, at), 16);
  const set = patch.append((at) => assembleWords(
    `cmp r1, #1; bxhi lr
     mov r0, r1
     b #${code.set}`, at), 16);
  const current = patch.append((at) => assembleWords(
    `${LOAD}
     cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  const record = listTemplate(patch);
  const v = new DataView(record.buffer);
  v.setUint16(4, LAMP_TEXT_ID, true);
  v.setUint32(0x0c, count, true);
  v.setUint32(0x14, draw, true);
  v.setUint32(0x24, set, true);
  v.setUint32(0x2c, current, true);
  for (const off of [0x10, 0x18, 0x28, 0x30]) v.setUint32(off, 0, true);
  addListRecords(patch, [{ id: LAMP_LIST_ID, record }], 'constant light');
  hookControllerFactory(patch, `movw ip, #${lo(LAMP_LIST_ID)}; movt ip, #${hi(LAMP_LIST_ID)}
     cmp r1, ip; bne prior
     movw r1, #${lo(LIST_CONTROLLER_ID)}; movt r1, #${hi(LIST_CONTROLLER_ID)}`, 'constant light: the list controller');
}

/** What the word at `at` (the entry of a lookup: `cmp r1, #0`, or an earlier addition's branch) goes on to. */
function entryTail(patch: Patch, at: number): string {
  const first = patch.word(at);
  if (first === 0xe3510000) return `cmp r1, #0; b #${at + 4}`;
  if (first >>> 24 === 0xea) return `b #${branchTarget(at, first)}`;
  return fail('unexpected-layout', 'constant light: a lookup does not start as expected');
}

/**
 * The ADJ lever function (after every addition that changes the function table's records in place
 * or copies it: soft focus, Direct Flash, exposure preview). `fn` is its number, `lampAdjFunction`.
 * Returns the table's new address.
 */
export function installLampAdj(patch: Patch, code: LampCode, fn: number): number {
  const at = ADJ_TABLE_SITES.map(([low, high, r]) => {
    const a = patch.word(low), b = patch.word(high);
    if (a !== movWord(r, movImmediate(a)) || b !== movWord(r, movImmediate(b), true)) fail('unexpected-layout', 'ADJ function table site is not a MOVW/MOVT pair');
    return (movImmediate(a) | (movImmediate(b) << 16)) >>> 0;
  });
  const old = at[0];
  if (at.some((t) => t !== old)) fail('unexpected-layout', 'ADJ function table is not where it was expected');
  const functions = (patch.word(ADJ_TABLE_END) - old) / ADJ_RECORD;
  if (functions !== fn || (fn !== ADJ_OFFICIAL_FUNCTIONS && fn !== ADJ_OFFICIAL_FUNCTIONS + 1) || (old === ADJ_TABLE) !== (fn === ADJ_OFFICIAL_FUNCTIONS)) fail('unexpected-layout', 'ADJ function table does not have the functions expected');
  const crop = patch.read(old + CROP * ADJ_RECORD, ADJ_RECORD);
  const cv = new DataView(crop.buffer);
  if (cv.getUint32(0x10, true) !== adr(0x531bb654) || cv.getUint32(0x38, true) !== 0 || cv.getUint32(0x3c, true) !== adr(0x531bdf1c) || cv.getUint32(0x40, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');
  for (const off of [H_DRAW, H_IS_CURRENT, H_SET, H_COUNT]) if (cv.getUint32(off, true) === 0 || cv.getUint32(off + 4, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');

  // --- Handlers (this = r0, value index = r1), as soft focus's: Off, On.
  const draw = patch.append((a) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r5, r0; mov r4, r1; mov r6, #0
     cmp r4, #0; movweq r6, #${TEXT_OFF}
     cmp r4, #1; movweq r6, #${TEXT_ON}
     ldr r0, [r5, #0x1f8]; uxtb r1, r4; bl #${LIST_ITEM}
     mov r1, r6; pop {r4, r5, r6, lr}; b #${ITEM_SET_TEXT}`, a), 16);
  const current = patch.append((a) => assembleWords(
    `${LOAD}
     cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, a), 16);
  const set = patch.append((a) => assembleWords(
    `cmp r1, #1; bxhi lr
     mov r0, r1
     b #${code.set}`, a), 16);
  const count = patch.append((a) => assembleWords('mov r0, #2; bx lr', a), 16);
  const record = crop.slice();
  const rv = new DataView(record.buffer);
  rv.setUint32(H_DRAW, draw, true);
  rv.setUint32(H_IS_CURRENT, current, true);
  rv.setUint32(H_SET, set, true);
  rv.setUint32(H_COUNT, count, true);
  rv.setUint32(0x3c, 0, true); // no "disabled" check (Crop's would disable it with Crop)

  // --- The table, copied with the record; every reference moved.
  const table = patch.append(concat([patch.read(old, fn * ADJ_RECORD), record]), 16);
  for (const [low, high, r] of ADJ_TABLE_SITES) {
    patch.setWord(low, movWord(r, lo(table)), 'constant light: ADJ function table, low half');
    patch.setWord(high, movWord(r, hi(table), true), 'constant light: ADJ function table, high half');
  }
  patch.setWord(ADJ_TABLE_END, table + (fn + 1) * ADJ_RECORD, 'constant light: end of the ADJ function table');

  // --- Name and icon (before the camera's own cases, or an earlier addition's).
  const nameTail = entryTail(patch, ADJ_NAME_OF);
  const name = patch.append((a) => assembleWords(
    `cmp r1, #${fn}; movweq r0, #${LAMP_TEXT_ID}; bxeq lr
     ${nameTail}`, a), 16);
  patch.setWord(ADJ_NAME_OF, branchWord(ADJ_NAME_OF, name), 'constant light: ADJ function name');
  const iconTail = entryTail(patch, ADJ_ICON_OF);
  const icon = patch.append((a) => assembleWords(
    `cmp r1, #${fn}; bne other
     cmp r2, #0; movne r0, #0; movweq r0, #${LAMP_ICON_ID}; bx lr
     other: ${iconTail}`, a), 16);
  patch.setWord(ADJ_ICON_OF, branchWord(ADJ_ICON_OF, icon), 'constant light: ADJ function icon');

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
  patch.setWord(ADJ_LIST_LOW, movWord(4, lo(newList)), 'constant light: ADJ function list, low half');
  patch.setWord(ADJ_LIST_HIGH, movWord(4, hi(newList), true), 'constant light: ADJ function list, high half');
  patch.setWord(ADJ_LIST_LENGTH, 0xe2846000 | list.length, 'constant light: ADJ function list length');
  return table;
}

/** The Fn function 0x29: the four buttons that share the first function list, and the Movie button (pressed, held). */
export function installLampFn(patch: Patch, code: LampCode): void {
  expectWord(patch, FN_NAME_OF, 0xe3510000); // cmp r1, #0
  expectWord(patch, FN_NAME_OF + 4, 0x1a000001); // bne 0x5338FBBC
  expectWord(patch, FN_ICON_OF, 0xe3510000); // cmp r1, #0
  expectWord(patch, FN_ICON_OF + 4, 0x1a000003); // bne 0x533914D4
  for (const [at, bytes, low, high, length] of FN_LISTS) {
    expectWord(patch, low, movWord(4, lo(at)));
    expectWord(patch, high, movWord(4, hi(at), true));
    expectWord(patch, length, 0xe2846000 | bytes.length); // add r6, r4, #length
    const official = patch.read(at, bytes.length);
    if (!bytes.every((v, i) => official[i] === v) || bytes.includes(FN_LAMP)) fail('unexpected-layout', 'Fn function list is not the official one');
  }
  // The Movie button's switch: the function in sl for events 2 and 3; 0x29 goes to the defaults.
  expectWord(patch, MOVIE_SWITCH, 0xe1a0c00d);
  expectWord(patch, MOVIE_SWITCH_BOUND, 0xe35a002d); // cmp sl, #0x2d
  expectWord(patch, MOVIE_SWITCH_BOUND + 4, 0x979ff10a); // ldrls pc, [pc, sl, lsl #2]
  expectWord(patch, MOVIE_SWITCH_BOUND + 12, MOVIE_SWITCH_END); // function 0 (none): the end
  expectWord(patch, MOVIE_SWITCH_BOUND + 12 + FN_LAMP * 4, MOVIE_SWITCH_DEFAULT);
  expectWord(patch, MOVIE_SWITCH_END, 0xe51b2030); // ldr r2, [fp, #-0x30]
  expectWord(patch, MOVIE_HELD_BOUND, 0xe350002d); // cmp r0, #0x2d
  expectWord(patch, MOVIE_HELD_BOUND + 4, 0x979ff100); // ldrls pc, [pc, r0, lsl #2]
  expectWord(patch, MOVIE_HELD_BOUND + 12, MOVIE_SWITCH_END);
  expectWord(patch, MOVIE_HELD_BOUND + 12 + FN_LAMP * 4, MOVIE_HELD_DEFAULT);
  // "Offered on this model": cases for 0x19..0x2d only, 0x29 with those that are always offered.
  expectWord(patch, FN_AVAILABLE, 0xe2400019); // sub r0, r0, #0x19
  expectWord(patch, FN_AVAILABLE + 0x10, 0xe3500014); // cmp r0, #0x14
  expectWord(patch, FN_AVAILABLE + 0x1c + (FN_LAMP - 0x19) * 4, FN_AVAILABLE + 0xd0); // mov r0, #1
  expectWord(patch, FN_AVAILABLE + 0xd0, 0xe3a00001);
  // The function switch: r5 = the shared pointer's address, r6 = released, the guard stored; 0x29 goes to the default.
  expectWord(patch, FN_SWITCH + 0x1c, 0xe1a05001); // mov r5, r1
  expectWord(patch, FN_SWITCH + 0x24, 0xe1a06003); // mov r6, r3
  expectWord(patch, FN_SWITCH_BOUND, 0xe352002d); // cmp r2, #0x2d
  expectWord(patch, FN_SWITCH_BOUND + 4, 0x979ff102); // ldrls pc, [pc, r2, lsl #2]
  expectWord(patch, FN_SWITCH_BOUND + 12 + FN_LAMP * 4, FN_SWITCH_DEFAULT);
  expectWord(patch, FN_SWITCH_BOUND + 12, FN_SWITCH_END); // function 0 (none): the common end
  expectWord(patch, FN_SWITCH_END, 0xe3560000); // cmp r6, #0

  const name = patch.append((a) => assembleWords(
    `cmp r1, #${FN_LAMP}; movweq r0, #${LAMP_TEXT_ID}; bxeq lr
     cmp r1, #0; b #${FN_NAME_OF + 4}`, a), 16);
  patch.setWord(FN_NAME_OF, branchWord(FN_NAME_OF, name), 'constant light: Fn function name');
  const icon = patch.append((a) => assembleWords(
    `cmp r1, #${FN_LAMP}; bne other
     cmp r2, #0; movne r0, #0; movweq r0, #${LAMP_ICON_ID}; bx lr
     other: cmp r1, #0; b #${FN_ICON_OF + 4}`, a), 16);
  patch.setWord(FN_ICON_OF, branchWord(FN_ICON_OF, icon), 'constant light: Fn function icon');

  for (const [, bytes, low, high, length, name] of FN_LISTS) {
    const list = patch.append(Uint8Array.from([...bytes, FN_LAMP]), 16);
    patch.setWord(low, movWord(4, lo(list)), `constant light: ${name} function list, low half`);
    patch.setWord(high, movWord(4, hi(list), true), `constant light: ${name} function list, high half`);
    patch.setWord(length, 0xe2846000 | (bytes.length + 1), `constant light: ${name} function list length`);
  }

  // The switch: on a press (r6 = 0) the lamp is switched over; then the common end, as function 0.
  const press = patch.append((a) => assembleWords(
    `cmp r2, #${FN_LAMP}; bne native
     cmp r6, #0; bne #${FN_SWITCH_END}
     bl #${code.toggle}
     b #${FN_SWITCH_END}
     native: cmp r2, #0x2d
     b #${FN_SWITCH_BOUND + 4}`, a), 16);
  patch.setWord(FN_SWITCH_BOUND, branchWord(FN_SWITCH_BOUND, press), 'constant light: Fn function');

  // The Movie button, pressed (event 2) or held (event 3): the lamp switched over, then the end.
  const movie = patch.append((a) => assembleWords(
    `cmp sl, #${FN_LAMP}; bne native
     bl #${code.toggle}
     b #${MOVIE_SWITCH_END}
     native: cmp sl, #0x2d
     b #${MOVIE_SWITCH_BOUND + 4}`, a), 16);
  patch.setWord(MOVIE_SWITCH_BOUND, branchWord(MOVIE_SWITCH_BOUND, movie), 'constant light: the Movie button');
  // Event 4 of the held function: nothing, as for the functions the held list offers.
  patch.setWord(MOVIE_HELD_BOUND + 12 + FN_LAMP * 4, MOVIE_SWITCH_END, 'constant light: the held Movie button, event 4');
}
