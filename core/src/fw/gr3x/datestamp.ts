// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: the date imprint (GR IV: ../aspect/datestamp.ts, datestamp-menu.ts).
 *
 * The picture side is GR IV's module (tools/datestamp/datestamp.c), built for GR III with
 * -DSTRICT_PLANES -DSETTING_RECORD (tools/gr3x/compile_diag.py): it reads its setting through the
 * settings-record pointer and writes only picture planes above 0x5d000000. It runs at the start of
 * JpegEncodeMacroProcess::Execute (0x535047d4), after the halation when both are built
 * (jpeg-stage.ts chains in front of it). Confirmed on a GR III with the diagnostic build 7b: the
 * pictures are YCbCr 4:2:2 (format 1), the main picture 6000 x 4000 with a 6144 pitch at 0x62..,
 * the configuration at 0x5c00.. (2026-10-22).
 *
 * The setting is byte 0x9a2 of the user-settings record (*0x55063f34), padding between
 * SetupMovieTransmit's flag (0x9a0) and the word SetupAutoPowerOff (0x9a4), next to the ADJ soft
 * focus byte 0x9a1 (adj-softfocus.ts: the default builder clears the block, the default merge
 * only copies flagged fields, nothing else reads or writes 0x9a1..3; the record is saved, loaded
 * and copied to U1-U3 whole). 0 off, 1 "'26 10 22", 3 "2026.10.22 17:34" (bit 0 on, bit 1 long,
 * as GR IV); any other value counts as, and is reset to, off.
 *
 * The menu: one line "Date Imprint" at the end of the still menu's last page (Shooting Assist,
 * after Horizon Correction). Two forms:
 *  - 'submenu' (round 6, as GR IV's datestamp-menu.ts): the line shows two icons (on/off, style)
 *    and opens a submenu like D-Range Correction's (SubMenuController, record 6) with two lines,
 *    each a list of two values: On/Off (Off / On) and Style ('26 10 08 / 2026.10.08 17:34). The
 *    byte holds bit 0 on and bit 1 long, so all four values 0..3 are valid.
 *  - 'list' (round 4, camera-tested; kept so those files are recognised): one list of three
 *    values Off / short / long (bytes 0, 1, 3).
 *  - Submenu records (0x64 bytes: +2 title, +6 line count, +8.. line texts, +0x14.. line
 *    controller ids, +0x3c.. line value draw functions) in a table of 17 at 0x53b3fb10 addressed
 *    from 5 places; copied with the added records from 18 on (17 is the constructor's start value,
 *    0x531c66ac); SetCurrentMenu (0x531c5950, record byte +0x174) maps the new ids to them. The
 *    factory hands out the submenu controller (D-Range's id 0x020000ba) for a new submenu id and
 *    the key map gives it D-Range's keys.
 *
 *  - Still menu. TopMenuController's builder (0x5319a778) reads the five tab descriptors
 *    (0x384 bytes) from the table at 0x55001eb8; the still descriptor (0x53b36dec) already has
 *    38 items, the most a descriptor holds. Two of them are model-specific and never both
 *    visible: ND Filter (item 13, only on the GR III with ND filter, visibility 0x531966e4) and
 *    HDF (item 25, only on the HDF, 0x53196708). Two copies of the descriptor are appended, each
 *    without one of them and with the new line at the end; on entry the builder stores the one
 *    for the camera's model (0x532dbee8: 0 ND, 1 HDF) in the table. Every model sees exactly the
 *    official menu plus the new line. The builder is the table's only reader.
 *  - Controller id 0x020001a0 (unused; GR III's ids end at 0x02000140). The factory (0x5316f3b8)
 *    hands out Horizon Correction's list controller (0x0200007d) for it, and ActionModel::OnEvent
 *    (key handling: an unknown id asserts and ignores every key) gets Horizon's id for it from
 *    its single read at 0x53221a4c. The other readers of the current id compare it with live-view
 *    ids and fall through for any other id.
 *  - List records (SelectMenuController, 0x40 bytes: +4 title, +8 count, +0x10 draw(item, value),
 *    +0x18 set(value), +0x20 is current(value), each a member pointer with a zero adjustment) in a
 *    table of 117 at 0x53b3c6c0 addressed from 15 places; the table is copied with one more record,
 *    118 (117 is the value the constructor starts with), modelled on Horizon's record 44.
 *    SetCurrentMenu (0x531b9640) maps the new id to it. The constructor's scan for the longest
 *    list ends 117 records after the table start (an immediate), so it still covers exactly the
 *    official records.
 *  - Texts: the name (21 languages, GR IV's) and the two value names; Off is the camera's text 2.
 *  - Icons: Off as Horizon Correction's (344; the submenu's On 345) up to round 6; from round 7 the
 *    camera's boxed OFF / ON text icons (296, 297), as GR IV's 310 / 311. Two new 40 x 40 style
 *    icons (GR IV's).
 */
import { assembleWords, branchWord, movWord } from '../aspect/arm';
import { FirmwareError } from '../types';
import { GR3X_DATESTAMP_CODE } from './picture-modules';
import { GR3X_DATESTAMP_R6_CODE } from './picture-modules-r6';
import { GR3X_DATESTAMP_R7_CODE } from './picture-modules-r7';
import { lookNameGlyphs } from '../aspect/datestamp';
import { GR3X_JPEG_EXECUTE } from './jpeg-stage';
import { GR3X_PICTURE_MENU_ID, installGr3xEndScreenSetup, installGr3xPictureList, installGr3xPictureSetupLine } from './shutdown';
import { GR3X_END_SCREEN_ID as END_SCREEN_ID, GR3X_PICTURE_LIST_ID, GR3X_PICTURE_MODE } from './endscreen';
import { GR3X_FRAME_LOOK, GR3X_GAP, GR3X_HEAP_BASE, GR3X_ORIENT_BYTE, GR3X_ZERO_FILL_END } from './look-addresses';
import { GR3X_DATESTAMP_R10_CODE } from './picture-modules-r10';
import { GR3X_R10 } from './round10';
import type { Gr3xPictureIds } from './shutdown';

export const GR3X_DATE_SETTINGS_POINTER = 0x55063f34;
export const GR3X_DATE_OFFSET = 0x9a2;
export const GR3X_DATE_MENU_ID = 0x020001a0;
const HORIZON_ID = 0x0200007d;

const BUILDER = 0x5319a778, MENU_TABLE = 0x55001eb8, STILL_MENU = 0x53b36dec;
const DESCRIPTOR = 0x384, MAX_ITEMS = 38;
const D_PAGES = 0x68, D_FIRST = 0x80, D_COUNT = 0x8b, D_DRAW = 0x8c, D_ID = 0x1bc, D_VISIBLE = 0x254;
const ND_ITEM = 13, HDF_ITEM = 25;
const OFFICIAL_FIRSTS = [0, 8, 16, 19, 26, 31, 35];
const FIRSTS_WITHOUT_ND = [0, 8, 15, 18, 25, 30, 34];
const FIRSTS_WITHOUT_HDF = [0, 8, 16, 19, 25, 30, 34];
const APP = 0x5320ad88, SPEC_MODEL = 0x5320c09c, MODEL_NUMBER = 0x532dbee8;
const FACTORY = 0x5316f3b8;
const KEY_MAP_READ = 0x53221a4c, CURRENT_ID_GETTER = 0x53228c4c;
const SELECT_SET_CURRENT = 0x531b9640, SELECT_RECORD_BYTE = 0x198;
const SELECT_TABLE = 0x53b3c6c0, SELECT_RECORD = 0x40, SELECT_RECORDS = 117, HORIZON_RECORD = 44;
const SELECT_CONSTRUCTOR_START = 0x531be7c4;
const SELECT_SCAN_END = 0x531ba534;
/** The 15 places that address the list table (movw/movt pairs and their register). */
const SELECT_SITES: readonly (readonly [number, number, number])[] = [
  [0x531b9fdc, 0x531b9fe8, 4], [0x531ba154, 0x531ba158, 3], [0x531ba19c, 0x531ba1a4, 4], [0x531ba24c, 0x531ba250, 3],
  [0x531ba2b0, 0x531ba2b4, 3], [0x531ba4c0, 0x531ba4c4, 3], [0x531ba520, 0x531ba524, 4], [0x531ba648, 0x531ba64c, 3],
  [0x531ba800, 0x531ba804, 5], [0x531ba9a0, 0x531ba9a8, 3], [0x531baa60, 0x531baa68, 3], [0x531bab3c, 0x531bab44, 3],
  [0x531bdfc4, 0x531bdfc8, 3], [0x531be084, 0x531be08c, 8], [0x531be400, 0x531be404, 3],
];
export const GR3X_DATE_RECORD = SELECT_RECORDS + 1;
const LINE_VALUE_ICON = 0x5339de20, TOP_SET_TITLE = 0x5339dc70, LIST_SET_ITEM = 0x5339e8b0;
/** Horizon Correction's line icons (rounds 4..6) and, from round 7, the camera's boxed OFF / ON texts. */
const ICON_OFF = 344, TEXT_OFF = 2, TEXT_ICON_OFF = 296;
const HORIZON_HANDLERS = { title: 362, count: 0x531b3b04, draw: 0x531b5310, set: 0x531b6de4, isCurrent: 0x531b8544 };

const CACHE = 0x536bbc30, CACHE_FLUSH_FOR_READ = 0x536bbcc0, CACHE_CLEAN = 0x536bbcac, PLATFORM = 0x536bd838, GET_TIME = 0x536b6510;

export interface Gr3xDateProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
  read(address: number, size: number): Uint8Array;
}
export interface Gr3xDateIds {
  name: number; short: number; long: number; iconShort: number; iconLong: number;
  /** 'submenu' form only: the line names On/Off and Style. */
  onOff?: number; style?: number;
  /** Round 8 (as GR Mod 0.8.4): the third line "Follow Orientation" and the two styles with the look's name. */
  orient?: number; shortName?: number; longName?: number; iconShortName?: number; iconLongName?: number;
}
export type Gr3xDateForm = 'list' | 'submenu';
export const GR3X_DATE_SWITCH_ID = 0x020001a1;
export const GR3X_DATE_STYLE_ID = 0x020001a2;
/** Round 8: the "Follow Orientation" list (0x020001a3 / a4 are the power-off pictures', as on GR IV). */
export const GR3X_DATE_ORIENT_ID = 0x020001a5;
/** Bits of the setting byte from round 8 (GR IV's datestamp.ts): bit 2 "Follow Orientation" off, bit 3 the look's name. */
export const GR3X_DATE_AS_STORED = 4, GR3X_DATE_NAME = 8;
const INSTANT_REVIEW_RECORD = 10;
/**
 * Round 8 (GR IV test 052): the rows of SelectMenuController lists are widgets of class 0x5339e51c
 * (vtable 0x53c0ada8; as GR IV's 0x5357AB24): the value's text label (+0xfc, vtable 0x53c0a378) at
 * x 100, 400 wide, whatever the row's width; the widest own widget (+0x100) spans x 40..680. The
 * longest Style values ("2026.10.08 17:34 + ...") do not fit in 400 (GR IV test 051), so for the
 * Style list only, after a value is drawn its label is made as wide as the row allows (to 20 px
 * before the row's right edge, never beyond x 680), through the label's own SetRect (vtable +0x18,
 * 0x533ab548). Nothing else changes; other lists are not touched.
 */
const ROW_VTABLE = 0x53c0ada8, ROW_VTABLE_LITERAL = 0x5339e734;
const LABEL_VTABLE = 0x53c0a378, LABEL_VTABLE_LITERAL = 0x53396a28, LABEL_SET_RECT = 0x533ab548;
const ROW_RIGHT_MARGIN = 20, ROW_CONTENT_RIGHT = 680;
const D_RANGE_ID = 0x020000ba, D_RANGE_RECORD = 6;
const SUB_SET_CURRENT = 0x531c5950, SUB_RECORD_BYTE = 0x174;
const SUB_TABLE = 0x53b3fb10, SUB_RECORD = 0x64, SUB_RECORDS = 17, SUB_CONSTRUCTOR_START = 0x531c66ac;
export const GR3X_SUB_FIRST_RECORD = SUB_RECORDS + 1;
const SUB_SITES: readonly (readonly [number, number, number])[] = [
  [0x531c5d18, 0x531c5d20, 3], [0x531c5d80, 0x531c5d88, 2], [0x531c60e8, 0x531c60f4, 8], [0x531c6318, 0x531c631c, 5], [0x531c63e4, 0x531c63f0, 3],
];
const TOP_SET_TWO_ICONS = 0x5339df08, SUB_SET_ICON = 0x533a6a70;
const ICON_ON = 345, TEXT_ON = 1, TEXT_ICON_ON = 297;
const END_SCREEN_TITLE = 665;

const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const fail = (message: string): never => { throw new FirmwareError('unexpected-layout', message); };
const u32 = (v: readonly number[]) => { const b = new Uint8Array(v.length * 4), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true)); return b; };
const bl = (at: number, target: number) => (0xeb000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;

/** r2 = settings record (or 0), r3 = setting byte, normalised: 1 or 3 as stored, anything else 0
 * (and stored back as 0). Flags are not kept. `n` makes the label unique. */
const load = (n: string) => `movw r2,#${lo(GR3X_DATE_SETTINGS_POINTER)};movt r2,#${hi(GR3X_DATE_SETTINGS_POINTER)};ldr r2,[r2];mov r3,#0;
  cmp r2,#0;beq ld${n};ldrb r3,[r2,#${GR3X_DATE_OFFSET}];cmp r3,#1;cmpne r3,#3;movne r3,#0;strbne r3,[r2,#${GR3X_DATE_OFFSET}];ld${n}:`;

/** As `load`, for the submenu form: 0..3 kept, anything above 3 stored back as 0. */
const load4 = (n: string) => `movw r2,#${lo(GR3X_DATE_SETTINGS_POINTER)};movt r2,#${hi(GR3X_DATE_SETTINGS_POINTER)};ldr r2,[r2];mov r3,#0;
  cmp r2,#0;beq ld${n};ldrb r3,[r2,#${GR3X_DATE_OFFSET}];cmp r3,#3;movhi r3,#0;strbhi r3,[r2,#${GR3X_DATE_OFFSET}];ld${n}:`;

/** Round 8: 0..15 kept (bit 0 on, 1 long, 2 as stored, 3 with the name), anything above stored back as 0. */
const load16 = (n: string) => `movw r2,#${lo(GR3X_DATE_SETTINGS_POINTER)};movt r2,#${hi(GR3X_DATE_SETTINGS_POINTER)};ldr r2,[r2];mov r3,#0;
  cmp r2,#0;beq ld${n};ldrb r3,[r2,#${GR3X_DATE_OFFSET}];cmp r3,#15;movhi r3,#0;strbhi r3,[r2,#${GR3X_DATE_OFFSET}];ld${n}:`;

/** The module: round 8's (0.8.4 sources: orientation and the look's name, -DGR3_PACKED), round 7's
 * (0.8.2 sources: with the look fields) or, for the files of rounds 4..6, theirs. */
export function gr3xDateModule(round: 6 | 7 | 8 | 10 = 8): Uint8Array {
  const raw = Uint8Array.from(atob(round === 10 ? GR3X_DATESTAMP_R10_CODE : round === 8 ? GR3X_DATESTAMP_CODE : round === 7 ? GR3X_DATESTAMP_R7_CODE : GR3X_DATESTAMP_R6_CODE), c => c.charCodeAt(0));
  if (raw.length % 4) fail('date imprint module length');
  return raw;
}

/** GR III's black-and-white looks: Monotone, Soft Monotone, Hard Monotone, Hi-Contrast B&W (as GR IV's 13..16). */
export const GR3X_MONO_LOOKS = [13, 14, 15, 16] as const;
/** Films in the look word the development step leaves (look 64 + k as 32 + k: the modules' tables have 64 entries). */
export const GR3X_STASH_FILM = 32;

/** Round 7 (as GR Mod 0.8.2): the imprint is light only exactly for black-and-white looks, from the
 * look word the development step leaves (the halation stash, jpeg-stage.ts): `stash` its address,
 * `monoFilms` which films are black and white (their presets give grey for every colour). */
export interface Gr3xDateLook {
  stash: number; monoFilms: readonly boolean[];
  /** Round 8 (as GR Mod 0.8.4): the look's name after the date and the imprint turned with the
   * camera, per look of the stash word (11..22 the camera's own, 32 + k film k) its name. */
  names?: Readonly<Record<number, string>>;
  /** Round 10: GR IV's words for the orientation and the frame look (round10.ts's RAM words). */
  r10?: boolean;
}

/** The camera's English names of its looks (GR III 2.10's texts 4, 268..278 through the name
 * lookup 0x532a985c, checked by the build against the firmware's own English texts). */
export const GR3X_FACTORY_LOOK_NAMES: Readonly<Record<number, string>> = {
  11: 'Standard', 12: 'Vivid', 13: 'Monotone', 14: 'Soft Monotone', 15: 'Hard Monotone', 16: 'Hi-Contrast B&W',
  17: 'Positive Film', 18: 'Bleach Bypass', 19: 'Retro', 20: 'HDR Tone', 21: 'Cross Processing', 22: 'Negative Film',
};
/** Their text numbers (the name lookup's table). */
export const GR3X_FACTORY_LOOK_TEXTS: Readonly<Record<number, number>> = {
  11: 4, 12: 268, 13: 269, 14: 270, 15: 271, 16: 272, 17: 274, 18: 275, 19: 276, 20: 277, 21: 278, 22: 273,
};

/** The module's table of names (GR IV's lookNameTable): 64 pointers by look to {u16 count, u16 glyphs...}, 0 for none. */
function gr3xLookNameTable(p: Gr3xDateProgram, names: Readonly<Record<number, string>>): number {
  const table = new Array<number>(64).fill(0);
  for (const [key, name] of Object.entries(names)) {
    const look = Number(key);
    if (!(Number.isInteger(look) && look >= 0 && look < 64)) fail('IIIx date imprint: look name index');
    const g = lookNameGlyphs(name);
    if (!g.length) continue;
    const b = new Uint8Array(2 + g.length * 2), v = new DataView(b.buffer);
    v.setUint16(0, g.length, true); g.forEach((x, i) => v.setUint16(2 + i * 2, x, true));
    table[look] = p.append(b);
  }
  return p.append(u32(table));
}

/**
 * Round 8 (GR IV's installExposureOrientation, datestamp.ts): SetShootingInfoResultBeforeExpose
 * (0x534322d8; it names itself in its assertion and writes the frame's date and time into the
 * shooting record at +0x944..+0x94b, which the EXIF writer's setter (0x535f6368) reads back) runs
 * at the start of each still exposure. Its hook leaves the camera's direction at that moment in
 * GR3X_ORIENT_BYTE: byte 0xC8 of the live shooting record that the display rotation reads (the
 * singleton 0x553458b0 (getter 0x53525d5c), its +0 -> +0x518 -> the record; 0x53547ff4 ->
 * 0x53550e68 `ldrb r0,[r3,#0xc8]`), 1..3 kept and anything else 0, as the EXIF writer
 * (0x535f673c: 1, 2, 3 -> Orientation 8, 3, 6 through 0x53d30188 / 0x53d30190; the fallback is
 * the frame record's byte 0xC8, the setter's +0x14) maps it. Every pointer is checked (RAM, word
 * aligned). It also leaves the look live view is being developed with (the stash's look) in
 * GR3X_FRAME_LOOK, for the imprint's name. Nothing but those three bytes is written; every
 * register is kept, and the hook runs `mov ip, sp` itself.
 */
export const GR3X_BEFORE_EXPOSE = 0x534322d8;
const DIRECTION_SINGLETON = 0x553458b0;
const ram = (r: string, label: string) => `cmp ${r},#0x40000000;blo ${label};cmp ${r},#0xc0000000;bhs ${label};tst ${r},#3;bne ${label};`;
export function installGr3xExposureOrientation(p: Gr3xDateProgram, stash: number, r10 = false) {
  const guards: readonly (readonly [number, number])[] = [
    [GR3X_BEFORE_EXPOSE, 0xe1a0c00d], [GR3X_BEFORE_EXPOSE + 4, 0xe92dd830], // mov ip, sp; push {r4, r5, fp, ip, lr, pc}
    [GR3X_BEFORE_EXPOSE + 0x88, 0xe5c41946], // strb r1, [r4, #0x946] (the frame's date)
    [0x53550e68, 0xe5903000], [0x53550e6c, 0xe5d300c8], // the direction getter: ldr r3, [r0]; ldrb r0, [r3, #0xc8]
    [0x5354801c, 0xe5950518], // ldr r0, [r5, #0x518]
    [0x53525d7c, movWord(0, 0x58b0)], [0x53525d80, movWord(0, 0x5534, true)], // the singleton's address
    [0x535f63d0, 0xe28320c8], // the EXIF setter's +0x14: the record + 0xc8
  ];
  for (const [at, w] of guards) if (p.word(at) !== w >>> 0) fail(`IIIx exposure orientation guard at ${at.toString(16)}`);
  // Round 10 (GR IV): the stash's word as it is (FRAME_LOOK), the direction | 0x100 (ORIENT_WORD).
  const stub = r10 ? p.code(`push {r0,r1};
    movw r0,#${lo(stash)};movt r0,#${hi(stash)};ldr r0,[r0];
    movw r1,#${lo(GR3X_R10.frameLook)};movt r1,#${hi(GR3X_R10.frameLook)};str r0,[r1];
    movw r0,#${lo(DIRECTION_SINGLETON)};movt r0,#${hi(DIRECTION_SINGLETON)};ldr r0,[r0];${ram('r0', 'done')}
    ldr r0,[r0,#0x518];${ram('r0', 'done')}
    ldr r0,[r0];${ram('r0', 'done')}
    ldrb r0,[r0,#0xc8];cmp r0,#3;movhi r0,#0;orr r0,r0,#0x100;
    movw r1,#${lo(GR3X_R10.orientWord)};movt r1,#${hi(GR3X_R10.orientWord)};str r0,[r1];
    done:pop {r0,r1};mov ip,sp;b #${GR3X_BEFORE_EXPOSE + 4};`) : p.code(`push {r0,r1};
    movw r0,#${lo(stash)};movt r0,#${hi(stash)};ldr r0,[r0];tst r0,#0x10000;and r0,r0,#0xff;orrne r0,r0,#0x8000;moveq r0,#0;
    movw r1,#${lo(GR3X_FRAME_LOOK)};movt r1,#${hi(GR3X_FRAME_LOOK)};strh r0,[r1];
    movw r0,#${lo(DIRECTION_SINGLETON)};movt r0,#${hi(DIRECTION_SINGLETON)};ldr r0,[r0];${ram('r0', 'done')}
    ldr r0,[r0,#0x518];${ram('r0', 'done')}
    ldr r0,[r0];${ram('r0', 'done')}
    ldrb r0,[r0,#0xc8];cmp r0,#3;movhi r0,#0;orr r0,r0,#0x80;
    movw r1,#${lo(GR3X_ORIENT_BYTE)};movt r1,#${hi(GR3X_ORIENT_BYTE)};strb r0,[r1];
    done:pop {r0,r1};mov ip,sp;b #${GR3X_BEFORE_EXPOSE + 4};`);
  p.patch(GR3X_BEFORE_EXPOSE, 0xe1a0c00d, branchWord(GR3X_BEFORE_EXPOSE, stub), 'date imprint: camera direction at the start of the exposure');
  return { exposureOrientation: stub };
}

/**
 * Round 8: in RAW development (the development step's flag, its argument + 0x82ac, is 0; r3 is the
 * record of the RAW file, as the step itself chose), the orientation by the EXIF writer's rule
 * (byte 0x71e04 when byte 0x71e03 is set, else byte 0xc8; 1..3 kept, else 0) and the look (`look`,
 * a register holding the stash word) of the record, for the date imprint. Code for the development
 * step's hooks (image-control.ts, adj.ts): `arg` holds the argument + 0x8000, `a` and `b` are free
 * registers, r3 the record; the flags change.
 */
/** Round 10 (GR IV's STASH_ASM): in RAW development the stash's word as FRAME_LOOK and the orientation | 0x100 as ORIENT_WORD. */
export function gr3xRawDevelopmentWordsR10(arg: string, look: string, a: string, b: string): string {
  return `ldrb ${a},[${arg},#0x2ac];cmp ${a},#0;bne rawdone;
    movw ${b},#${lo(GR3X_R10.frameLook)};movt ${b},#${hi(GR3X_R10.frameLook)};str ${look},[${b}];
    add ${b},r3,#0x71000;ldrb ${a},[${b},#0xe03];cmp ${a},#0;ldrbne ${a},[${b},#0xe04];ldrbeq ${a},[r3,#0xc8];cmp ${a},#3;movhi ${a},#0;orr ${a},${a},#0x100;
    movw ${b},#${lo(GR3X_R10.orientWord)};movt ${b},#${hi(GR3X_R10.orientWord)};str ${a},[${b}];rawdone:`;
}

export function gr3xRawDevelopmentWords(arg: string, look: string, a: string, b: string): string {
  return `ldrb ${a},[${arg},#0x2ac];cmp ${a},#0;bne rawdone;
    tst ${look},#0x10000;and ${a},${look},#0xff;orrne ${a},${a},#0x8000;moveq ${a},#0;movw ${b},#${lo(GR3X_FRAME_LOOK)};movt ${b},#${hi(GR3X_FRAME_LOOK)};strh ${a},[${b}];
    add ${b},r3,#0x71000;ldrb ${a},[${b},#0xe03];cmp ${a},#0;ldrbne ${a},[${b},#0xe04];ldrbeq ${a},[r3,#0xc8];cmp ${a},#3;movhi ${a},#0;orr ${a},${a},#0x80;
    movw ${b},#${lo(GR3X_ORIENT_BYTE)};movt ${b},#${hi(GR3X_ORIENT_BYTE)};strb ${a},[${b}];rawdone:`;
}

/** The 64-byte table of black-and-white looks of the stash word (GR IV's monoTable). */
export function gr3xMonoTable(monoFilms: readonly boolean[]): Uint8Array {
  const t = new Uint8Array(64);
  for (const l of GR3X_MONO_LOOKS) t[l] = 1;
  monoFilms.forEach((m, k) => { if (m) t[GR3X_STASH_FILM + k] = 1; });
  return t;
}

/** The picture side: the module behind a stub at the start of Execute. Returns the stub, which
 * ends by carrying on with Execute; the halation (jpeg-stage.ts) goes in front of it. */
export function installGr3xDateImprintStage(p: Gr3xDateProgram, look?: Gr3xDateLook) {
  const guards: readonly (readonly [number, number])[] = [
    [GR3X_JPEG_EXECUTE, 0xe1a0c00d], [GR3X_JPEG_EXECUTE + 4, 0xe92ddff0], [GR3X_JPEG_EXECUTE + 0x18, 0xe5914008],
    [CACHE, 0xe30d01b4], [CACHE_FLUSH_FOR_READ, 0xe1a0c00d], [CACHE_CLEAN, 0xe1a00001], [PLATFORM, 0xe1a0c00d], [GET_TIME, 0xe5d0300c],
  ];
  for (const [at, w] of guards) if (p.word(at) !== w) fail(`IIIx date imprint guard at ${at.toString(16)}`);
  if (look && (look.monoFilms.length > 20)) fail('IIIx date imprint: films');
  // Round 7: the look word, the table of black-and-white looks and the model check (GR III has no
  // Monochrome model: always 0). Round 8: the orientation byte, the frame look and the names.
  const round8 = !!look?.names;
  const lookWords = look ? [look.stash, p.append(gr3xMonoTable(look.monoFilms)), p.code('mov r0,#0;bx lr;')] : [];
  const r10 = !!look?.r10;
  const r8Words = round8 ? [r10 ? GR3X_R10.orientWord : GR3X_ORIENT_BYTE, r10 ? GR3X_R10.frameLook : GR3X_FRAME_LOOK, gr3xLookNameTable(p, look!.names!)] : [];
  const ctx = p.append(u32([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, PLATFORM, GET_TIME, GR3X_DATE_SETTINGS_POINTER, GR3X_DATE_OFFSET, ...lookWords, ...r8Words]));
  if (r10 && !round8) fail('IIIx date imprint: round 10 builds on round 8');
  const exposure = round8 ? installGr3xExposureOrientation(p, look!.stash, r10) : {};
  const module = p.append(gr3xDateModule(r10 ? 10 : round8 ? 8 : look ? 7 : 6));
  const stub = p.code(`push {r0-r3,ip,lr};ldr r1,[r1,#8];movw r0,#${lo(ctx)};movt r0,#${hi(ctx)};bl #${module};pop {r0-r3,ip,lr};
    mov ip,sp;b #${GR3X_JPEG_EXECUTE + 4};`);
  p.patch(GR3X_JPEG_EXECUTE, 0xe1a0c00d, branchWord(GR3X_JPEG_EXECUTE, stub), 'date imprint: JPEG encode step');
  return { dateStage: stub, dateModule: module, dateContext: ctx, ...exposure };
}

/** The menu line, its list and the controller plumbing (the date imprint alone). */
export function installGr3xDateImprintMenu(p: Gr3xDateProgram, ids: Gr3xDateIds) {
  return installGr3xMenuAdditions(p, { date: ids });
}

/**
 * The added menu lists: the date imprint's (still menu) and the power-off pictures' (Setup menu,
 * shutdown.ts), in that order as list records 118 and up. With the date imprint alone the bytes
 * are those of round 4 (camera-tested): the pictures' parts are only added when there are pictures.
 */
/** Round 6: Setup's End Screen line opens a submenu (Type / Picture, endscreen.ts). */
export interface Gr3xEndScreenMenu { typeText: number; pictureText: number; lineType: number; linePicture: number }

export function installGr3xMenuAdditions(p: Gr3xDateProgram, o: { date?: Gr3xDateIds; dateForm?: Gr3xDateForm; picture?: Gr3xPictureIds; endScreen?: Gr3xEndScreenMenu;
  /** Round 7: the submenu's On / Off as the camera's boxed OFF / ON texts (round 6: Horizon's line icons). */
  onOffText?: boolean;
  /** Round 8 (as GR Mod 0.8.4): the third line Follow Orientation, four styles (with the look's name),
   * the Style values' labels as wide as the row allows. Needs `onOffText` and the submenu. */
  round8?: boolean;
  /** Round 10: the start-up fill is already extended (round10.ts). */
  zeroFillDone?: boolean }) {
  const iconOff = o.onOffText ? TEXT_ICON_OFF : ICON_OFF, iconOn = o.onOffText ? TEXT_ICON_ON : ICON_ON;
  const ids = o.date;
  if (o.picture && o.endScreen) fail('IIIx pictures: list or submenu');
  const sub = !!ids && o.dateForm === 'submenu';
  if (sub && (ids!.onOff === undefined || ids!.style === undefined)) fail('IIIx date imprint submenu texts');
  const r8 = o.round8 === true;
  if (r8 && (!sub || !o.onOffText || [ids!.orient, ids!.shortName, ids!.longName, ids!.iconShortName, ids!.iconLongName].some(v => v === undefined)))
    fail('IIIx round 8 date imprint: the submenu, OFF / ON texts and the texts and icons of the third line and the two styles');
  if (!ids && !o.picture && !o.endScreen) fail('no IIIx menu additions');
  // --- Checks of the official code and data this relies on.
  const guards: readonly (readonly [number, number])[] = [
    ...(ids ? [[BUILDER, 0xe1a0c00d], [BUILDER + 4, movWord(3, lo(MENU_TABLE))], [BUILDER + 0x10, movWord(3, hi(MENU_TABLE), true)]] as const : []),
    [FACTORY, movWord(3, 0x13b)], [FACTORY + 4, 0xe1a0c00d], [FACTORY + 8, movWord(3, 0x200, true)],
    [KEY_MAP_READ, bl(KEY_MAP_READ, CURRENT_ID_GETTER)], [CURRENT_ID_GETTER, 0xe5900000], [CURRENT_ID_GETTER + 4, 0xe12fff1e],
    [SELECT_SET_CURRENT, 0xe28134fe], [SELECT_SET_CURRENT + 4, 0xe1a0c00d],
    [SELECT_CONSTRUCTOR_START, 0xe3a0e075], // mov lr,#117: the list constructor starts with record 117
    [SELECT_SCAN_END, 0xe2847d75], // add r7,r4,#0x1d40: the longest-list scan ends 117 records on
    [APP, 0xe1a0c00d], [SPEC_MODEL, 0xe1a0c00d], [LINE_VALUE_ICON, 0xe1a0c00d], [TOP_SET_TITLE, 0xe1a0c00d], [LIST_SET_ITEM, 0xe1a0c00d],
    ...(sub || o.endScreen ? [[SUB_SET_CURRENT, 0xe28134fe], [SUB_SET_CURRENT + 4, 0xe1a0c00d], [SUB_CONSTRUCTOR_START, 0xe3a02011], // mov r2,#17
      [TOP_SET_TWO_ICONS, 0xe1a0c00d], [SUB_SET_ICON, 0xe1a0c00d]] as const : []),
    ...(r8 ? [[ROW_VTABLE_LITERAL, ROW_VTABLE], [LABEL_VTABLE_LITERAL, LABEL_VTABLE], [LABEL_SET_RECT, 0xe1a0c00d], [LABEL_VTABLE + 0x18, LABEL_SET_RECT]] as const : []),
  ];
  for (const [at, w] of guards) if (p.word(at) !== w >>> 0) fail(`IIIx date imprint menu guard at ${at.toString(16)}`);
  const still = p.read(STILL_MENU, DESCRIPTOR), dv = new DataView(still.buffer);
  if (ids) {
    if (new DataView(p.read(MENU_TABLE, 4).buffer).getUint32(0, true) !== STILL_MENU) fail('IIIx still menu descriptor');
    if (still[D_PAGES] !== 7 || [...still.subarray(D_FIRST, D_FIRST + 7)].join() !== OFFICIAL_FIRSTS.join() || still[D_COUNT] !== MAX_ITEMS)
      fail('IIIx still menu pages');
    const id = (i: number) => dv.getUint32(D_ID + i * 4, true), visible = (i: number) => dv.getUint32(D_VISIBLE + i * 8, true);
    if (id(ND_ITEM) !== 0x02000069 || visible(ND_ITEM) !== 0x531966e4 || id(HDF_ITEM) !== 0x0200013f || visible(HDF_ITEM) !== 0x53196708)
      fail('IIIx ND / HDF menu items');
    if (id(35) !== 0x0200007b || id(36) !== 0x0200007c || id(37) !== HORIZON_ID) fail('IIIx Shooting Assist items');
    for (let i = 0; i < MAX_ITEMS; i++) if (id(i) === GR3X_DATE_MENU_ID) fail('IIIx date imprint id in use');
    // Both visibility functions ask the same model number (0 ND, 1 HDF).
    for (const v of [0x531966e4, 0x53196708]) {
      if (p.word(v + 0xc) !== bl(v + 0xc, APP) || p.word(v + 0x10) !== bl(v + 0x10, SPEC_MODEL) || p.word(v + 0x14) !== bl(v + 0x14, MODEL_NUMBER))
        fail('IIIx model visibility');
    }
  }
  const horizon = p.read(SELECT_TABLE + HORIZON_RECORD * SELECT_RECORD, SELECT_RECORD), hv = new DataView(horizon.buffer);
  const H = HORIZON_HANDLERS;
  if (hv.getUint32(0, true) !== 0x10000 || hv.getUint32(4, true) !== H.title || hv.getUint32(8, true) !== H.count || hv.getUint32(0x10, true) !== H.draw ||
    hv.getUint32(0x18, true) !== H.set || hv.getUint32(0x20, true) !== H.isCurrent || [0xc, 0x14, 0x1c, 0x24].some(o => hv.getUint32(o, true) !== 0) ||
    horizon.subarray(0x28).some(b => b !== 0)) fail('IIIx Horizon Correction list record');
  for (const [low, high, r] of SELECT_SITES)
    if (p.word(low) !== movWord(r, lo(SELECT_TABLE)) || p.word(high) !== movWord(r, hi(SELECT_TABLE), true)) fail('IIIx list table site');

  const lists: { id: number; title: number; count: number; draw: number; set: number; isCurrent: number }[] = [];
  const entries: Record<string, number> = {};
  let line = 0;
  const submenus: { id: number; record: Uint8Array }[] = [];
  if (ids && sub && r8) {
    const I = ids as Required<Gr3xDateIds>;
    /** rX = the icon of the style in the setting r3 (bits 1 and 3; ip changes). */
    const styleIcon = (rX: string) => `and ip,r3,#${2 | GR3X_DATE_NAME};cmp ip,#0;movweq ${rX},#${I.iconShort};cmp ip,#2;movweq ${rX},#${I.iconLong};
      cmp ip,#${GR3X_DATE_NAME};movweq ${rX},#${I.iconShortName};cmp ip,#${2 | GR3X_DATE_NAME};movweq ${rX},#${I.iconLongName};`;
    // --- The line of the still menu: both values' icons (on/off, style) and the name.
    line = p.code(`push {r4,lr};mov r4,r1;${load16('a')}
      tst r3,#1;movweq r1,#${iconOff};movwne r1,#${iconOn};${styleIcon('r2')}
      mov r0,r4;bl #${TOP_SET_TWO_ICONS};mov r0,r4;movw r1,#${I.name};mov r2,r1;pop {r4,lr};b #${TOP_SET_TITLE};`);
    // --- Submenu lines: the icon of the current value (this = r0, line = r1).
    const lineOnOff = p.code(`${load16('b')}mov r0,r1;tst r3,#1;movweq r1,#${iconOff};movwne r1,#${iconOn};b #${SUB_SET_ICON};`);
    const lineStyle = p.code(`${load16('c')}mov r0,r1;${styleIcon('r1')}b #${SUB_SET_ICON};`);
    // "Follow Orientation": On while bit 2 is clear.
    const lineOrient = p.code(`${load16('h')}mov r0,r1;tst r3,#${GR3X_DATE_AS_STORED};movweq r1,#${iconOn};movwne r1,#${iconOff};b #${SUB_SET_ICON};`);
    // --- The lists (this = r0; draw: item r1, value r2; set / is current: value r1).
    const count = p.code('mov r0,#2;bx lr;');
    const styleCount = p.code('mov r0,#4;bx lr;');
    const drawOnOff = p.code(`mov r0,r1;cmp r2,#0;movweq r1,#${iconOff};moveq r2,#${TEXT_OFF};movwne r1,#${iconOn};movne r2,#${TEXT_ON};b #${LIST_SET_ITEM};`);
    const setOnOff = p.code(`cmp r1,#1;bxhi lr;push {r4};mov r4,r1;${load16('d')}cmp r2,#0;beq so;bic r3,r3,#1;orr r3,r3,r4;strb r3,[r2,#${GR3X_DATE_OFFSET}];so:pop {r4};bx lr;`);
    const isOnOff = p.code(`${load16('e')}and r3,r3,#1;cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
    // The value's label made as wide as the row allows (see ROW_VTABLE; GR IV's widenLabel): r0 = the
    // row; every register but r0..r3, ip is kept. Only for a row and a label of the expected classes, only wider.
    const widenLabel = p.code(`push {r4,r5,lr};sub sp,sp,#20;
      ${ram('r0', 'wdone')}ldr r3,[r0];movw ip,#${lo(ROW_VTABLE)};movt ip,#${hi(ROW_VTABLE)};cmp r3,ip;bne wdone;
      ldr r5,[r0,#0x28];cmp r5,#200;blt wdone;cmp r5,#720;bgt wdone;sub r5,r5,#${ROW_RIGHT_MARGIN};cmp r5,#${ROW_CONTENT_RIGHT};movgt r5,#${ROW_CONTENT_RIGHT};
      ldr r4,[r0,#0xfc];${ram('r4', 'wdone')}ldr r3,[r4];movw ip,#${lo(LABEL_VTABLE)};movt ip,#${hi(LABEL_VTABLE)};cmp r3,ip;bne wdone;
      ldr r0,[r4,#0x20];ldr r1,[r4,#0x24];ldr r2,[r4,#0x28];ldr r3,[r4,#0x2c];cmp r0,#0;blt wdone;
      add ip,r0,r2;cmp ip,r5;bge wdone;sub r2,r5,r0;str r0,[sp];str r1,[sp,#4];str r2,[sp,#8];str r3,[sp,#12];
      ldr r3,[r4];ldr r3,[r3,#0x18];mov r0,r4;mov r1,sp;mov lr,pc;bx r3;
      wdone:add sp,sp,#20;pop {r4,r5,pc};`);
    // Style values: 0 short, 1 long, 2 short + name, 3 long + name (bit 0: bit 1 of the byte, bit 1: bit 3).
    const drawStyle = p.code(`cmp r2,#3;bxhi lr;push {r4,lr};mov r4,r1;mov r0,r1;mov ip,r2;
      cmp ip,#0;movweq r1,#${I.iconShort};movweq r2,#${I.short};cmp ip,#1;movweq r1,#${I.iconLong};movweq r2,#${I.long};
      cmp ip,#2;movweq r1,#${I.iconShortName};movweq r2,#${I.shortName};cmp ip,#3;movweq r1,#${I.iconLongName};movweq r2,#${I.longName};
      bl #${LIST_SET_ITEM};mov r0,r4;bl #${widenLabel};pop {r4,pc};`);
    const setStyle = p.code(`cmp r1,#3;bxhi lr;push {r4};mov r4,r1;${load16('f')}cmp r2,#0;beq ss;bic r3,r3,#${2 | GR3X_DATE_NAME};
      tst r4,#1;orrne r3,r3,#2;tst r4,#2;orrne r3,r3,#${GR3X_DATE_NAME};strb r3,[r2,#${GR3X_DATE_OFFSET}];ss:pop {r4};bx lr;`);
    const isStyle = p.code(`cmp r1,#3;movhi r0,#0;bxhi lr;${load16('g')}and ip,r3,#2;mov ip,ip,lsr #1;tst r3,#${GR3X_DATE_NAME};orrne ip,ip,#2;
      cmp ip,r1;moveq r0,#1;movne r0,#0;bx lr;`);
    // Values 0 Off, 1 On (as the On/Off list draws them); stored inverted in bit 2.
    const setOrient = p.code(`cmp r1,#1;bxhi lr;push {r4};mov r4,r1;${load16('i')}cmp r2,#0;beq sr;bic r3,r3,#${GR3X_DATE_AS_STORED};
      cmp r4,#0;orreq r3,r3,#${GR3X_DATE_AS_STORED};strb r3,[r2,#${GR3X_DATE_OFFSET}];sr:pop {r4};bx lr;`);
    const isOrient = p.code(`${load16('j')}tst r3,#${GR3X_DATE_AS_STORED};moveq r3,#1;movne r3,#0;cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
    lists.push({ id: GR3X_DATE_SWITCH_ID, title: I.onOff, count, draw: drawOnOff, set: setOnOff, isCurrent: isOnOff });
    lists.push({ id: GR3X_DATE_STYLE_ID, title: I.style, count: styleCount, draw: drawStyle, set: setStyle, isCurrent: isStyle });
    lists.push({ id: GR3X_DATE_ORIENT_ID, title: I.orient, count, draw: drawOnOff, set: setOrient, isCurrent: isOrient });
    // Three lines, laid out as Instant Review's record (10): D-Range's record (6) with a third line
    // (text, controller id, its value icon at x 540, value-draw function), equal to record 10 but for
    // the title, the texts, the ids and the functions (GR IV test 049: a third line without its x
    // drew its icon over the name).
    const tpl = p.read(SUB_TABLE + D_RANGE_RECORD * SUB_RECORD, SUB_RECORD), tv = new DataView(tpl.buffer);
    if (tv.getUint16(2, true) !== 337 || tpl[6] !== 2 || tv.getUint32(0x14, true) !== 0x02000077 || tv.getUint32(0x18, true) !== 0x02000078 ||
      tv.getUint32(0x1c, true) !== 0x10000000 || tv.getUint32(0x20, true) !== 0x10000000 || tv.getUint32(0x28, true) !== 540 || tv.getUint32(0x2c, true) !== 540 ||
      tv.getUint32(0x30, true) !== 0 || [0x40, 0x48, 0x4c, 0x50, 0x54, 0x58, 0x5c, 0x60].some(o => tv.getUint32(o, true) !== 0))
      fail('IIIx D-Range Correction submenu record');
    const record = tpl.slice(), rv = new DataView(record.buffer);
    record[6] = 3;
    rv.setUint16(2, I.name, true); rv.setUint16(8, I.onOff, true); rv.setUint16(10, I.style, true); rv.setUint16(12, I.orient, true); rv.setUint16(14, 0, true);
    rv.setUint32(0x14, GR3X_DATE_SWITCH_ID, true); rv.setUint32(0x18, GR3X_DATE_STYLE_ID, true); rv.setUint32(0x1c, GR3X_DATE_ORIENT_ID, true); rv.setUint32(0x20, 0x10000000, true);
    rv.setUint32(0x30, rv.getUint32(0x28, true), true);
    rv.setUint32(0x3c, lineOnOff, true); rv.setUint32(0x40, 0, true); rv.setUint32(0x44, lineStyle, true); rv.setUint32(0x48, 0, true);
    rv.setUint32(0x4c, lineOrient, true); rv.setUint32(0x50, 0, true);
    const ref = p.read(SUB_TABLE + INSTANT_REVIEW_RECORD * SUB_RECORD, SUB_RECORD);
    const own = new Set([2, 3, 8, 9, 10, 11, 12, 13, ...Array.from({ length: 12 }, (_, k) => 0x14 + k), ...Array.from({ length: 12 }, (_, k) => 0x3c + k), 0x4c, 0x4d, 0x4e, 0x4f]);
    if (ref[6] !== 3 || [...record].some((b, i) => !own.has(i) && b !== ref[i])) fail('IIIx Instant Review submenu record (the three-line layout)');
    submenus.push({ id: GR3X_DATE_MENU_ID, record });
    Object.assign(entries, { dateLine: line, dateLineOnOff: lineOnOff, dateLineStyle: lineStyle, dateLineOrient: lineOrient, dateCount: count, dateStyleCount: styleCount,
      dateDrawOnOff: drawOnOff, dateSetOnOff: setOnOff, dateIsOnOff: isOnOff, dateDrawStyle: drawStyle, dateSetStyle: setStyle, dateIsStyle: isStyle,
      dateSetOrient: setOrient, dateIsOrient: isOrient, dateWidenLabel: widenLabel });
  } else if (ids && sub) {
    const I = ids;
    // --- The line of the still menu: both values' icons (on/off, style) and the name.
    line = p.code(`push {r4,lr};mov r4,r1;${load4('a')}
      tst r3,#1;movweq r1,#${iconOff};movwne r1,#${iconOn};tst r3,#2;movweq r2,#${I.iconShort};movwne r2,#${I.iconLong};
      mov r0,r4;bl #${TOP_SET_TWO_ICONS};mov r0,r4;movw r1,#${I.name};mov r2,r1;pop {r4,lr};b #${TOP_SET_TITLE};`);
    // --- Submenu lines: the icon of the current value (this = r0, line = r1).
    const lineOnOff = p.code(`${load4('b')}mov r0,r1;tst r3,#1;movweq r1,#${iconOff};movwne r1,#${iconOn};b #${SUB_SET_ICON};`);
    const lineStyle = p.code(`${load4('c')}mov r0,r1;tst r3,#2;movweq r1,#${I.iconShort};movwne r1,#${I.iconLong};b #${SUB_SET_ICON};`);
    // --- The two lists (this = r0; draw: item r1, value r2; set / is current: value r1).
    const count = p.code('mov r0,#2;bx lr;');
    const drawOnOff = p.code(`mov r0,r1;cmp r2,#0;movweq r1,#${iconOff};moveq r2,#${TEXT_OFF};movwne r1,#${iconOn};movne r2,#${TEXT_ON};b #${LIST_SET_ITEM};`);
    const setOnOff = p.code(`cmp r1,#1;bxhi lr;push {r4};mov r4,r1;${load4('d')}cmp r2,#0;beq so;bic r3,r3,#1;orr r3,r3,r4;strb r3,[r2,#${GR3X_DATE_OFFSET}];so:pop {r4};bx lr;`);
    const isOnOff = p.code(`${load4('e')}and r3,r3,#1;cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
    const drawStyle = p.code(`mov r0,r1;cmp r2,#0;movweq r1,#${I.iconShort};movweq r2,#${I.short};movwne r1,#${I.iconLong};movwne r2,#${I.long};b #${LIST_SET_ITEM};`);
    const setStyle = p.code(`cmp r1,#1;bxhi lr;push {r4};mov r4,r1;${load4('f')}cmp r2,#0;beq ss;bic r3,r3,#2;cmp r4,#0;orrne r3,r3,#2;strb r3,[r2,#${GR3X_DATE_OFFSET}];ss:pop {r4};bx lr;`);
    const isStyle = p.code(`cmp r1,#1;movhi r0,#0;bxhi lr;${load4('g')}and r3,r3,#2;cmp r1,#0;movne r1,#2;cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
    lists.push({ id: GR3X_DATE_SWITCH_ID, title: I.onOff!, count, draw: drawOnOff, set: setOnOff, isCurrent: isOnOff });
    lists.push({ id: GR3X_DATE_STYLE_ID, title: I.style!, count, draw: drawStyle, set: setStyle, isCurrent: isStyle });
    const tpl = p.read(SUB_TABLE + D_RANGE_RECORD * SUB_RECORD, SUB_RECORD), tv = new DataView(tpl.buffer);
    if (tv.getUint16(2, true) !== 337 || tpl[6] !== 2 || tv.getUint32(0x14, true) !== 0x02000077 || tv.getUint32(0x18, true) !== 0x02000078 ||
      tv.getUint32(0x1c, true) !== 0x10000000 || [0x40, 0x48, 0x4c, 0x50, 0x54, 0x58, 0x5c, 0x60].some(o => tv.getUint32(o, true) !== 0))
      fail('IIIx D-Range Correction submenu record');
    const record = tpl.slice(), rv = new DataView(record.buffer);
    rv.setUint16(2, I.name, true); rv.setUint16(8, I.onOff!, true); rv.setUint16(10, I.style!, true);
    rv.setUint32(0x14, GR3X_DATE_SWITCH_ID, true); rv.setUint32(0x18, GR3X_DATE_STYLE_ID, true);
    rv.setUint32(0x3c, lineOnOff, true); rv.setUint32(0x40, 0, true); rv.setUint32(0x44, lineStyle, true); rv.setUint32(0x48, 0, true);
    submenus.push({ id: GR3X_DATE_MENU_ID, record });
    Object.assign(entries, { dateLine: line, dateLineOnOff: lineOnOff, dateLineStyle: lineStyle, dateCount: count,
      dateDrawOnOff: drawOnOff, dateSetOnOff: setOnOff, dateIsOnOff: isOnOff, dateDrawStyle: drawStyle, dateSetStyle: setStyle, dateIsStyle: isStyle });
  } else if (ids) {
    // --- The line of the still menu: the current value's icon and the name.
    const icon = (dst: string, n: string) => `cmp r3,#1;movwlo ${dst},#${ICON_OFF};beq i${n}s;bhi i${n}l;b i${n}d;
      i${n}s:movw ${dst},#${ids.iconShort};b i${n}d;i${n}l:movw ${dst},#${ids.iconLong};i${n}d:`;
    line = p.code(`push {r4,lr};mov r4,r1;${load('a')}${icon('r1', 'a')}mov r0,r4;bl #${LINE_VALUE_ICON};
      mov r0,r4;movw r1,#${ids.name};mov r2,r1;pop {r4,lr};b #${TOP_SET_TITLE};`);
    // --- The list (this = r0; draw: item r1, value r2; set / is current: value r1).
    const count = p.code('mov r0,#3;bx lr;');
    const draw = p.code(`mov r0,r1;cmp r2,#1;beq ds;bhi dl;movw r1,#${ICON_OFF};mov r2,#${TEXT_OFF};b #${LIST_SET_ITEM};
      ds:movw r1,#${ids.iconShort};movw r2,#${ids.short};b #${LIST_SET_ITEM};
      dl:movw r1,#${ids.iconLong};movw r2,#${ids.long};b #${LIST_SET_ITEM};`);
    const set = p.code(`cmp r1,#2;bxhi lr;movw r2,#${lo(GR3X_DATE_SETTINGS_POINTER)};movt r2,#${hi(GR3X_DATE_SETTINGS_POINTER)};ldr r2,[r2];
      cmp r2,#0;bxeq lr;cmp r1,#2;moveq r1,#3;strb r1,[r2,#${GR3X_DATE_OFFSET}];bx lr;`);
    // Exactly one value is current (the byte is normalised first).
    const isCurrent = p.code(`${load('c')}cmp r3,#3;moveq r3,#2;cmp r3,r1;moveq r0,#1;movne r0,#0;bx lr;`);
    lists.push({ id: GR3X_DATE_MENU_ID, title: ids.name, count, draw, set, isCurrent });
    Object.assign(entries, { dateLine: line, dateCount: count, dateDraw: draw, dateSet: set, dateIsCurrent: isCurrent });
  }
  if (o.endScreen) {
    // The End Screen submenu (D-Range's record as the model): title End Screen, Type / Picture.
    const E = o.endScreen;
    const tpl = p.read(SUB_TABLE + D_RANGE_RECORD * SUB_RECORD, SUB_RECORD), tv = new DataView(tpl.buffer);
    if (tv.getUint16(2, true) !== 337 || tpl[6] !== 2 || tv.getUint32(0x14, true) !== 0x02000077 || tv.getUint32(0x18, true) !== 0x02000078 ||
      tv.getUint32(0x1c, true) !== 0x10000000 || [0x40, 0x48, 0x4c, 0x50, 0x54, 0x58, 0x5c, 0x60].some(o => tv.getUint32(o, true) !== 0))
      fail('IIIx D-Range Correction submenu record');
    const record = tpl.slice(), rv = new DataView(record.buffer);
    rv.setUint16(2, END_SCREEN_TITLE, true); rv.setUint16(8, E.typeText, true); rv.setUint16(10, E.pictureText, true);
    rv.setUint32(0x14, END_SCREEN_ID, true); rv.setUint32(0x18, GR3X_PICTURE_LIST_ID, true);
    rv.setUint32(0x3c, E.lineType, true); rv.setUint32(0x40, 0, true); rv.setUint32(0x44, E.linePicture, true); rv.setUint32(0x48, 0, true);
    submenus.push({ id: GR3X_PICTURE_MENU_ID, record });
  }
  if (o.picture) {
    const pe = installGr3xPictureList(p, o.picture);
    lists.push({ id: GR3X_PICTURE_MENU_ID, title: o.picture.title, count: pe.pictureCount, draw: pe.pictureDraw, set: pe.pictureSet, isCurrent: pe.pictureIsCurrent });
    Object.assign(entries, pe);
  }
  const what = o.picture ? 'added menu lists' : 'date imprint';
  const records = lists.map(l => {
    const record = horizon.slice(), rv = new DataView(record.buffer);
    rv.setUint32(4, l.title, true); rv.setUint32(8, l.count, true); rv.setUint32(0x10, l.draw, true); rv.setUint32(0x18, l.set, true); rv.setUint32(0x20, l.isCurrent, true);
    return record;
  });
  const table = p.append(new Uint8Array([...p.read(SELECT_TABLE, GR3X_DATE_RECORD * SELECT_RECORD), ...records.flatMap(r => [...r])]));
  for (const [low, high, r] of SELECT_SITES) {
    p.patch(low, movWord(r, lo(SELECT_TABLE)), movWord(r, lo(table)), `${what}: list records, low half`);
    p.patch(high, movWord(r, hi(SELECT_TABLE), true), movWord(r, hi(table), true), `${what}: list records, high half`);
  }
  const current = p.code(lists.map((l, k) => `movw ip,#${lo(l.id)};movt ip,#${hi(l.id)};cmp r1,ip;
    moveq r3,#${GR3X_DATE_RECORD + k};strbeq r3,[r0,#${SELECT_RECORD_BYTE}];bxeq lr;`).join('') + `
    add r3,r1,#0xfe000000;b #${SELECT_SET_CURRENT + 4};`);
  p.patch(SELECT_SET_CURRENT, 0xe28134fe, branchWord(SELECT_SET_CURRENT, current), o.picture ? `${what}: list record` : 'date imprint: list record');
  if (submenus.length) {
    for (const [low, high, r] of SUB_SITES)
      if (p.word(low) !== movWord(r, lo(SUB_TABLE)) || p.word(high) !== movWord(r, hi(SUB_TABLE), true)) fail('IIIx submenu table site');
    const subTable = p.append(new Uint8Array([...p.read(SUB_TABLE, GR3X_SUB_FIRST_RECORD * SUB_RECORD), ...submenus.flatMap(m => [...m.record])]));
    for (const [low, high, r] of SUB_SITES) {
      p.patch(low, movWord(r, lo(SUB_TABLE)), movWord(r, lo(subTable)), 'added menus: submenu records, low half');
      p.patch(high, movWord(r, hi(SUB_TABLE), true), movWord(r, hi(subTable), true), 'added menus: submenu records, high half');
    }
    const subCurrent = p.code(submenus.map((m, k) => `movw ip,#${lo(m.id)};movt ip,#${hi(m.id)};cmp r1,ip;
      moveq r3,#${GR3X_SUB_FIRST_RECORD + k};strbeq r3,[r0,#${SUB_RECORD_BYTE}];bxeq lr;`).join('') + `
      add r3,r1,#0xfe000000;b #${SUB_SET_CURRENT + 4};`);
    p.patch(SUB_SET_CURRENT, 0xe28134fe, branchWord(SUB_SET_CURRENT, subCurrent), 'added menus: submenu record');
    Object.assign(entries, { submenuTable: subTable, submenuSetCurrent: subCurrent });
  }

  if (ids) {
    // --- Two still-menu descriptors, one per model.
    const descriptor = (drop: number, firsts: readonly number[]) => {
      const d = still.slice(), v = new DataView(d.buffer);
      const items = Array.from({ length: MAX_ITEMS }, (_, i) => i).filter(i => i !== drop);
      items.forEach((i, j) => {
        d.set(still.subarray(D_DRAW + i * 8, D_DRAW + i * 8 + 8), D_DRAW + j * 8);
        d.set(still.subarray(D_ID + i * 4, D_ID + i * 4 + 4), D_ID + j * 4);
        d.set(still.subarray(D_VISIBLE + i * 8, D_VISIBLE + i * 8 + 8), D_VISIBLE + j * 8);
      });
      const last = MAX_ITEMS - 1;
      v.setUint32(D_DRAW + last * 8, line, true); v.setUint32(D_DRAW + last * 8 + 4, 0, true);
      v.setUint32(D_ID + last * 4, GR3X_DATE_MENU_ID, true);
      v.setUint32(D_VISIBLE + last * 8, 0, true); v.setUint32(D_VISIBLE + last * 8 + 4, 0, true);
      d.set(firsts, D_FIRST);
      d[D_COUNT] = MAX_ITEMS;
      return d;
    };
    const withoutNd = p.append(descriptor(ND_ITEM, FIRSTS_WITHOUT_ND));
    const withoutHdf = p.append(descriptor(HDF_ITEM, FIRSTS_WITHOUT_HDF));
    const builder = p.code(`push {r0-r3,ip,lr};bl #${APP};bl #${SPEC_MODEL};bl #${MODEL_NUMBER};
      movw r1,#${lo(withoutHdf)};movt r1,#${hi(withoutHdf)};cmp r0,#1;movweq r1,#${lo(withoutNd)};movteq r1,#${hi(withoutNd)};
      movw r2,#${lo(MENU_TABLE)};movt r2,#${hi(MENU_TABLE)};str r1,[r2];
      pop {r0-r3,ip,lr};mov ip,sp;b #${BUILDER + 4};`);
    p.patch(BUILDER, 0xe1a0c00d, branchWord(BUILDER, builder), 'date imprint: still menu for this model');
    Object.assign(entries, { dateMenuWithoutNd: withoutNd, dateMenuWithoutHdf: withoutHdf, dateBuilder: builder });
  }
  if (o.picture) Object.assign(entries, installGr3xPictureSetupLine(p, entries.pictureLine));
  if (o.endScreen) {
    // Setup's End Screen line opens the submenu, drawn as Setup's other submenu lines.
    const setupLine = p.code(`push {r4,lr};mov r4,r1;mov r0,r4;mov r1,#0;bl #${LINE_VALUE_ICON};mov r0,r4;movw r1,#${END_SCREEN_TITLE};mov r2,r1;
      pop {r4,lr};b #${TOP_SET_TITLE};`);
    Object.assign(entries, { endScreenSetupLine: setupLine }, installGr3xEndScreenSetup(p, setupLine));
    // The picture list's mode is in the gap before the heap: the start-up fill clears it.
    if (!o.zeroFillDone) p.patch(GR3X_ZERO_FILL_END, GR3X_GAP, GR3X_HEAP_BASE, 'start-up zero fill reaches the heap base (clears the added RAM words)');
  }

  // --- Controller ids: Horizon Correction's list controller and key map.
  const mapped = [...lists.map(l => [l.id, HORIZON_ID] as const), ...submenus.map(m => [m.id, D_RANGE_ID] as const),
    ...(o.endScreen ? [[GR3X_PICTURE_LIST_ID, END_SCREEN_ID] as const] : [])];
  // With the End Screen submenu the factory also sets the End Screen list's mode: picture list
  // (asked for GR3X_PICTURE_LIST_ID) or the camera's own (asked for End Screen itself).
  const factory = o.endScreen ? p.code([...mapped.map(([id, to]) => [id, to, id === GR3X_PICTURE_LIST_ID ? 1 : -1] as const), [END_SCREEN_ID, END_SCREEN_ID, 0] as const]
    .map(([id, to, mode], k) => `movw ip,#${lo(id)};movt ip,#${hi(id)};cmp r1,ip;bne f${k};movw r1,#${lo(to)};movt r1,#${hi(to)};` +
      (mode >= 0 ? `mov ip,#${mode};movw r3,#${lo(GR3X_PICTURE_MODE)};movt r3,#${hi(GR3X_PICTURE_MODE)};${r8 ? 'strb' : 'str'} ip,[r3];` : '') + `b done;f${k}:`).join('') +
    `done:movw r3,#0x13b;b #${FACTORY + 4};`)
    : p.code(mapped.map(([id, to]) => `movw ip,#${lo(id)};movt ip,#${hi(id)};cmp r1,ip;
    movweq r1,#${lo(to)};movteq r1,#${hi(to)};`).join('') + `movw r3,#0x13b;b #${FACTORY + 4};`);
  p.patch(FACTORY, movWord(3, 0x13b), branchWord(FACTORY, factory), o.picture ? `${what}: list controller` : 'date imprint: list controller');
  const keys = p.code('ldr r0,[r0];' + mapped.map(([id, to]) => `movw ip,#${lo(id)};movt ip,#${hi(id)};cmp r0,ip;
    movweq r0,#${lo(to)};movteq r0,#${hi(to)};`).join('') + 'bx lr;');
  p.patch(KEY_MAP_READ, bl(KEY_MAP_READ, CURRENT_ID_GETTER), bl(KEY_MAP_READ, keys), o.picture ? `${what}: key map of the lists` : 'date imprint: key map of the list');
  void assembleWords;
  return { ...entries, dateListTable: table, dateSetCurrent: current, dateFactory: factory, dateKeys: keys };
}
