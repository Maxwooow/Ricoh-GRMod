// SPDX-License-Identifier: GPL-2.0-only
/**
 * Direct Flash ("直闪模式", 0.8.4): a fifth choice of the camera's Flash Mode (firmware 1.20; ported from 1.11).
 *
 * The flash fires at a fixed power and the camera plans the exposure from the subject distance and
 * the flash's guide number, the way the GR III's GF-2 Flash Mode works as Ricoh describes it
 * (f-number = GN x sqrt(ISO / 100) / distance): aperture, ISO and shutter speed, in P, Tv, Av and M
 * (what was dialled in for Tv, Av and M is overridden). Not in bulb / time, not in Snap Distance
 * Priority, not for movies; a flash that communicates with the camera (P-TTL) works as Flash On.
 * Limits: f/2.8..f/16 (and the camera's own), the ISO range the user set (ISO Auto) or the ISO set,
 * shutter speeds the flash syncs with (the camera's own rule, 0x5369E39C) and not slower than the
 * slowest shutter speed chosen (1/30 s by default).
 * Flash Output 1/4 (the GF-2's quarter power, which the camera sets itself) is planned two stops
 * lower; an ND filter in front of the lens takes two stops of the flash as well.
 *
 * Flash and ambient light add up on the subject, so the exposure is planned for the two together:
 * the shutter speed sets how they share it (the background, lit by the ambient light only, gets the
 * ambient share), aperture and ISO make the sum right.
 *
 * Chosen in the camera, not in GR Mod (three lines of the Flash submenu, `directflash-menu.ts`):
 * the flash's guide number (byte 0x99A; 0, what it is on every camera, is the GF-2's, 3), the
 * background (how much darker than a correct exposure; -1.0 EV, half each, by default) and the
 * slowest shutter speed (1/30 s by default), bits of byte 0x99B.
 *
 * Independent work: everything below was found in the official 1.11 firmware, starting from its
 * texts ("Flash On", "Flash Mode"), its menu record tables and the class names of its exposure code
 * (AeProgramDiagramFlash, AeFlashComData, ...). How the choice is kept and where the exposure is
 * taken over are this program's own design.
 *
 *  - Where the choice is kept. Not as a new Flash Mode value: the camera stores Flash Mode at byte
 *    0x10C of the user settings (CURRENT() = 0x550832A8; the live value at +0xC50, 1.11 +0xBF8: the mirror moved with the longer 1.20 settings) and many places
 *    look it up (menus, ADJ, Fn, flash control, exposure). Direct Flash is Flash Mode 0 (Flash On)
 *    plus bit 0 of byte 0x99B of the live user settings structure (CURRENT() + 4): alignment padding
 *    (bytes 0x997..0x999, then a word at 0x99C) that the factory-defaults initialiser
 *    (UserDataInitValue, 0x5354754C, run in an emulator on all 30 default records) never writes,
 *    like 0x90F (soft focus) and 0x94B (date imprint). It is saved, loaded and copied to U1..U3 with
 *    the structure, and a settings reset makes it 0. The firmware itself only ever sees Flash Mode
 *    0..3; written back to the official firmware the camera simply has Flash On. (Up to test 055
 *    the byte was 1 for on and anything else off; 1 is still on.)
 *  - Menus. Flash Mode has 4 values with slow sync, else 2; Direct Flash is one more, last:
 *     * the menu lists (SelectMenuController records 11 and 12 of the table at 0x53DCEB08: count,
 *       draw value i, set value i, is value i current), patched in place (before `datestamp-menu.ts`
 *       copies the table);
 *     * the ADJ lever (record 0x09 of AdjModeController's table at 0x53DCB494: text, icon, is
 *       current, set, count; slow sync when the controller's byte +0x282 is set);
 *     * the Fn list (record id 0x16 at 0x53DCC734 of the table at 0x53DCC4AC: text, icon, is
 *       current, set, count; slow sync when byte +0x197 is set).
 *    The other values go to the camera's own handlers. Picking Direct Flash sets Flash Mode 0
 *    (SetFlashMode, 0x532B7730) and bit 0; picking any other value clears bit 0 (the other bits
 *    are the camera-menu choices and stay).
 *  - The current value's icon: three places draw the icon of the current Flash Mode
 *    (0x53390bd8(resources, value, variant)): the still menu's Flash Mode line (0x531B2154), the
 *    submenu line (0x531E2D78) and the shooting screen (0x533A77E0). For value 0 with bit 0 set
 *    they show the Direct Flash icon.
 *  - Exposure. The still exposure (0x5369FD18 -> 0x5369FAA4) runs the flash program (0x5369F870,
 *    called once, at 0x5369FB64), which leaves Tv, Av and Sv for the picture at +0xD0, +0xD4, +0xD8
 *    of the exposure record and the ND decision at +0x560; after it, the flash data for the
 *    picture is prepared from those (0x536A5DE0). The call at 0x5369FB64 goes through a wrapper
 *    that runs the flash program and then the module `tools/gr4v121/directflash/directflash.c`, which
 *    replaces the result when Direct Flash applies (see the module for the fields it reads).
 *  - Guide number: byte 0x99A (CURRENT() + 4), the same kind of padding as 0x99B
 *    (UserDataInitValue never writes it).
 *  - Name: text 926 (1.11: 882), "Direct Flash" in the 21 languages; icon 733 (the ratio icon number of
 *    identity 17, never given out: added ratios use 7..14, the date imprint 5, 6, 15, 16; 1.20's own icons end at 708).
 *
 * Nothing changes unless the user picks Direct Flash.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, NATIVE_TEXT_ROOTS, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z } from './build';
import { DIRECTFLASH_CODE, DIRECTFLASH_DIAG_CODE, DIRECTFLASH_DIAG_ENTRY, DIRECTFLASH_ENTRY } from './directflash-code';

export const DIRECT_FLASH_TEXT_ID = 926; // 1.11: 882 (+ TEXT_SHIFT)
export const DIRECT_FLASH_ICON_ID = 733;
/**
 * The setting byte (0 on every camera): bit 0 Direct Flash (with Flash Mode 0); bits 1..4 and 5..7
 * the background and the slowest shutter speed chosen in the camera menu (`directflash-menu.ts`).
 */
export const DIRECT_FLASH_BYTE = 0x550832a8 + 4 + 0x99b;
/** The guide number chosen in the camera menu (`directflash-menu.ts`); 0 on every camera: DIRECT_FLASH_GN_DEFAULT. */
export const DIRECT_FLASH_GN_BYTE = 0x550832a8 + 4 + 0x99a;
/**
 * Test 062: the fastest shutter speed chosen in the camera menu (`directflash-menu.ts`), bits 0..2;
 * 0 on every camera: the camera's own flash-sync limit. Byte 0x109 of the user settings: alignment padding between a byte
 * field (0x108) and a word (0x10C) that UserDataInitValue (run in the emulator, all 30 records)
 * never writes; inside the 0xB44 bytes the settings save keeps (0x533F3F9C; 1.11: 0xAE9).
 */
export const DIRECT_FLASH_TV_BYTE = 0x550832a8 + 4 + 0x109;
/**
 * Test builds only: the RAM word that holds the planner's diagnostic buffer (allocated by the module
 * on its first call), the last of the 44 bytes before the heap that the start-up zero fill clears
 * once it is extended (see slots.ts / lookstash.ts). The date imprint's diagnostic build prints it.
 */
export const DIRECT_FLASH_DIAG_SLOT = 0x5583903c;
const HEAP_ALLOC = 0x53909154;
const ZERO_FILL_END = 0x53000460;
/** The guide number (ISO 100, metres) while none is chosen: the GF-2's (9.8 ft / 3 m). */
export const DIRECT_FLASH_GN_DEFAULT = 3;

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const DIRECT_FLASH_NAMES: readonly string[] = [
  'Přímý blesk', 'Direkte blitz', 'Direct Flash', 'Suora salama', 'Flash direct', 'Direktblitz', 'Άμεσο φλας',
  'Közvetlen vaku', 'Flash diretto', 'ダイレクト発光', '다이렉트 플래시', 'Directe flits', 'Błysk bezpośredni', 'Flash direto',
  'Прямая вспышка', '直闪模式', 'Flash directo', 'Direktblixt', 'แฟลชตรง', '直閃模式', 'Doğrudan flaş',
];

const CURRENT = 0x550832a8;
export const LIVE_FLASH_MODE = CURRENT + 0xc50; // 1.11: + 0xbf8
const FLASH_OUTPUT = CURRENT + 0x114;

// Camera functions (checked below by their first instructions or their callers).
const APP = 0x53240cac;
const SETTINGS = 0x53241240;
const GET_FLASH_MODE = 0x5329bd64;
const SET_FLASH_MODE = 0x532b7730;
const FLASH_ICON = 0x53390bd8;
const SYNC_TV = 0x5369e39c;
const LIST_ITEM = 0x5359468c; // (list, index) -> item
const ITEM_SET_ICON = 0x535a198c; // (item, icon)
const LABEL_SET_TEXT = 0x53596f7c; // (label, text, 0)
const ROW_SET = 0x5359eae4; // (row, icon, text)

// The still exposure's call of the flash program.
const FLASH_PROGRAM = 0x5369f870;
const FLASH_PROGRAM_CALL = 0x5369fb64;

/** A handler set: table, slot offsets and the camera's own handlers there. */
interface Handlers {
  what: string;
  /** Where the slow-sync flag is (a byte of the controller), or the fixed number of camera values. */
  values: { flag: number } | { fixed: number };
  slots: Record<string, readonly [number, number]>;
}

const ADJ_RECORD = 0x53dcb494 + 0x09 * 0x5c;
const FN_RECORD = 0x53dcc734;
const LIST_RECORDS = [0x53dceb08 + 11 * 0x4c, 0x53dceb08 + 12 * 0x4c] as const;

const ADJ: Handlers = {
  what: 'ADJ lever',
  values: { flag: 0x282 },
  slots: { text: [0x10, 0x531bbf9c], icon: [0x18, 0x531bfef8], current: [0x20, 0x531bcf54], set: [0x28, 0x531bcb18], count: [0x30, 0x531bbcb0] },
};
const FN: Handlers = {
  what: 'Fn list',
  values: { flag: 0x197 },
  slots: { text: [0x04, 0x531c279c], icon: [0x0c, 0x531c3e28], current: [0x14, 0x531c2e04], set: [0x1c, 0x531c2a50], count: [0x24, 0x531c2384] },
};
const LISTS: readonly Handlers[] = [
  { what: 'menu list (with slow sync)', values: { fixed: 4 }, slots: { count: [0x0c, 0x531d0fc4], draw: [0x14, 0x531d21a8], set: [0x24, 0x531d49f4], current: [0x2c, 0x531d62fc] } },
  { what: 'menu list', values: { fixed: 2 }, slots: { count: [0x0c, 0x531d0fcc], draw: [0x14, 0x531d220c], set: [0x24, 0x531d4a24], current: [0x2c, 0x531d6330] } },
];
/** Text / icon list objects of the ADJ and Fn controllers. */
const VIEW = { adj: { text: 0x164, icons: 0x1f8 }, fn: { text: 0x160, icons: 0x178 } } as const;
/** Calls of the Flash Mode icon function for the current value: [site, bl (true) or b]. */
const CURRENT_ICON_SITES: readonly (readonly [number, boolean])[] = [[0x531b2154, true], [0x531e2d78, true], [0x533a77e0, false]];

/** First language table (in `LANGS` order) as the program sees it in RAM; tables are 0xDC4 apart (see softfocus.ts). */
const FIRST_TABLE_RAM = 0x55000000 + (0x543b6a70 - 0x543b4900);
const TABLE_STRIDE = 0xdc4;

export const DIRECT_FLASH_ICON_W = 40;
export const DIRECT_FLASH_ICON_H = 40;
/** The icon's white pixels ('#'): "GN" over a bolt; a black edge is drawn around them. */
const ICON_MASK: readonly string[] = [
  '........................................',
  '........................................',
  '..........######......##......##........',
  '..........######......##......##........',
  '........##......##....####....##........',
  '........##......##....####....##........',
  '........##............##..##..##........',
  '........##............##..##..##........',
  '........##..######....##....####........',
  '........##..######....##....####........',
  '........##......##....##......##........',
  '........##......##....##......##........',
  '........##......##....##......##........',
  '........##......##....##......##........',
  '..........########....##......##........',
  '..........########....##......##........',
  '........................................',
  '........................................',
  '........................######..........',
  '.......................######...........',
  '......................######............',
  '.....................######.............',
  '....................######..............',
  '...................######...............',
  '..................######................',
  '.................######.................',
  '................############............',
  '...............############.............',
  '..............############..............',
  '.............############...............',
  '..................######................',
  '..................#####.................',
  '.................####...................',
  '.................###....................',
  '................###.....................',
  '................##......................',
  '...............##.......................',
  '...............#........................',
  '..............#.........................',
  '........................................',
];

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** 40x40 RGBA, transparent, white with a black edge (as the camera's Flash Mode icons). */
export function drawDirectFlashIcon(): Uint8Array {
  const W = DIRECT_FLASH_ICON_W;
  const H = DIRECT_FLASH_ICON_H;
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && ICON_MASK[y][x] === '#';
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (on(x, y)) {
        px.set([255, 255, 255, 255], i);
        continue;
      }
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1 && !edge; dx++) edge = on(x + dx, y + dy);
      px.set(edge ? [0, 0, 0, 255] : [255, 255, 255, 0], i);
    }
  }
  return px;
}

/** 2 log2(GN), the guide number as an aperture value, as a float32 bit pattern. */
export function guideNumberWord(gn: number): number {
  const f = new Float32Array([2 * Math.log2(gn)]);
  return new Uint32Array(f.buffer)[0];
}

function decodeBase64(text: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    const v = table.indexOf(ch);
    if (v < 0) fail('internal', 'bad module encoding');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** `r3` = number of camera values (4 or 2) for a controller-flag handler set, this in r0. */
function countAsm(h: Handlers, reg = 'r3'): string {
  if ('fixed' in h.values) return `mov ${reg}, #${h.values.fixed}`;
  return `ldrb ${reg}, [r0, #${h.values.flag}]; cmp ${reg}, #0; movne ${reg}, #4; moveq ${reg}, #2`;
}

/** r0 = 1 when Direct Flash is the current choice (bit 0 of the byte, Flash Mode 0); keeps r4..r11. */
function activeAsm(): string {
  return `bl #${APP}; bl #${SETTINGS}; bl #${GET_FLASH_MODE}
    movw ip, #${lo(DIRECT_FLASH_BYTE)}; movt ip, #${hi(DIRECT_FLASH_BYTE)}; ldrb ip, [ip]
    tst ip, #1; moveq r0, #0; beq active_done
    cmp r0, #0; moveq r0, #1; movne r0, #0
    active_done:`;
}

function setAsm(h: Handlers, official: number): string {
  return `push {r4, lr}
    ${countAsm(h)}
    movw r2, #${lo(DIRECT_FLASH_BYTE)}; movt r2, #${hi(DIRECT_FLASH_BYTE)}
    cmp r1, r3; beq set_direct
    ldrb r3, [r2]; bic r3, r3, #1; strb r3, [r2]
    pop {r4, lr}; b #${official}
    set_direct: ldrb r3, [r2]; orr r3, r3, #1; strb r3, [r2]
    bl #${APP}; bl #${SETTINGS}; mov r1, #0
    pop {r4, lr}; b #${SET_FLASH_MODE}`;
}

function currentAsm(h: Handlers, official: number): string {
  return `push {r4, r5, r6, lr}
    mov r5, r0; mov r4, r1
    ${countAsm(h, 'r6')}
    ${activeAsm()}
    cmp r4, r6; beq cur_done
    cmp r0, #0; movne r0, #0; bne cur_done
    mov r0, r5; mov r1, r4; pop {r4, r5, r6, lr}; b #${official}
    cur_done: pop {r4, r5, r6, pc}`;
}

function countHandlerAsm(h: Handlers): string {
  return `${countAsm(h, 'r0')}; add r0, r0, #1; bx lr`;
}

function textAsm(h: Handlers, official: number, label: number): string {
  return `${countAsm(h)}
    cmp r1, r3; bne #${official}
    ldr r0, [r0, #${label}]; movw r1, #${DIRECT_FLASH_TEXT_ID}; mov r2, #0; b #${LABEL_SET_TEXT}`;
}

function iconAsm(h: Handlers, official: number, list: number): string {
  return `${countAsm(h)}
    cmp r1, r3; bne #${official}
    push {r4, lr}
    ldr r0, [r0, #${list}]; uxtb r1, r1; bl #${LIST_ITEM}
    movw r1, #${DIRECT_FLASH_ICON_ID}; pop {r4, lr}; b #${ITEM_SET_ICON}`;
}

/** List row draw (this, row, i). */
function drawAsm(h: Handlers, official: number): string {
  if (!('fixed' in h.values)) fail('internal', 'list handlers have a fixed count');
  return `cmp r2, #${h.values.fixed}; bne #${official}
    mov r0, r1; movw r1, #${DIRECT_FLASH_ICON_ID}; movw r2, #${DIRECT_FLASH_TEXT_ID}; b #${ROW_SET}`;
}

function checkSlots(patch: Patch, record: number, h: Handlers): void {
  for (const [off, fn] of Object.values(h.slots)) {
    expectWord(patch, record + off, fn);
    expectWord(patch, record + off + 4, 0); // member-function pointer: no this-adjustment
  }
}

function branchTo(at: number, target: number, link: boolean): number {
  return branchWord(at, target, 14, link);
}

/** Install Direct Flash. Returns the new ICONBIN data. `diag`: test builds only (see DIRECT_FLASH_DIAG_SLOT). */
export function installDirectFlash(patch: Patch, iconbin: Uint8Array, diag = false): Uint8Array {
  if (diag && patch.word(ZERO_FILL_END) !== 0x55839040) {
    expectWord(patch, ZERO_FILL_END, 0x55839014);
    patch.setWord(ZERO_FILL_END, 0x55839040, 'start-up zero fill also clears the 44 unused bytes before the heap');
  }

  // --- Checks of the official code this relies on.
  checkSlots(patch, ADJ_RECORD, ADJ);
  checkSlots(patch, FN_RECORD, FN);
  expectWord(patch, FN_RECORD, 0x16);
  LISTS.forEach((h, k) => {
    checkSlots(patch, LIST_RECORDS[k], h);
    expectWord(patch, LIST_RECORDS[k] + 4, 0x84); // title: Flash Mode (text 132; 1.11: 127)
  });
  expectWord(patch, 0x531bbcb0, 0xe5d03282); // ldrb r3, [r0, #0x282]  (ADJ count)
  expectWord(patch, 0x531c2384, 0xe5d03197); // ldrb r3, [r0, #0x197]  (Fn count)
  expectWord(patch, 0x531d0fc4, 0xe3a00004); // mov r0, #4
  expectWord(patch, 0x531d0fcc, 0xe3a00002); // mov r0, #2
  expectWord(patch, GET_FLASH_MODE, 0xe5d00c50); // ldrb r0, [r0, #0xc50] (1.11: #0xbf8)
  expectWord(patch, 0x532a0b7c, 0xe5d00114); // ldrb r0, [r0, #0x114]  (Flash Output)
  expectWord(patch, 0x531bcb54, branchWord(0x531bcb54, SET_FLASH_MODE)); // the ADJ setter's tail call
  expectWord(patch, 0x531bbff0, branchWord(0x531bbff0, LABEL_SET_TEXT));
  expectWord(patch, 0x531bbfe4, 0xe5940164); // ldr r0, [r4, #0x164]
  expectWord(patch, 0x531bff58, 0xe59501f8); // ldr r0, [r5, #0x1f8]
  expectWord(patch, 0x531bff60, branchWord(0x531bff60, LIST_ITEM, 14, true));
  expectWord(patch, 0x531bff70, branchWord(0x531bff70, ITEM_SET_ICON));
  expectWord(patch, 0x531c27e4, 0xe5940160); // ldr r0, [r4, #0x160]
  expectWord(patch, 0x531c3e88, 0xe5950178); // ldr r0, [r5, #0x178]
  expectWord(patch, 0x531d2208, branchWord(0x531d2208, ROW_SET));
  expectWord(patch, 0x53241260, movWord(0, lo(CURRENT))); // CURRENT() returns 0x550832A8
  expectWord(patch, 0x53241264, movWord(0, hi(CURRENT), true));
  for (const [site, link] of CURRENT_ICON_SITES) expectWord(patch, site, branchWord(site, FLASH_ICON, 14, link));
  expectWord(patch, FLASH_PROGRAM_CALL, branchWord(FLASH_PROGRAM_CALL, FLASH_PROGRAM, 14, true));
  expectWord(patch, FLASH_PROGRAM, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, SYNC_TV, 0xe5900004); // ldr r0, [r0, #4]
  if (patch.word(ICON_CATALOG + DIRECT_FLASH_ICON_ID * 4) !== 0) fail('unexpected-layout', 'icon number already in use');

  // --- Exposure: the module and its context, the wrapper of the flash program.
  const code = decodeBase64(diag ? DIRECTFLASH_DIAG_CODE : DIRECTFLASH_CODE);
  const entry = diag ? DIRECTFLASH_DIAG_ENTRY : DIRECTFLASH_ENTRY;
  const module = patch.append(code, 16);
  const ctx = patch.append(u32le([
    DIRECT_FLASH_BYTE, LIVE_FLASH_MODE, FLASH_OUTPUT, SYNC_TV, DIRECT_FLASH_GN_BYTE, guideNumberWord(DIRECT_FLASH_GN_DEFAULT), DIRECT_FLASH_TV_BYTE,
    ...(diag ? [DIRECT_FLASH_DIAG_SLOT, HEAP_ALLOC] : []),
  ]), 16);
  const wrapper = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r0
     bl #${FLASH_PROGRAM}
     mov r0, r4
     movw r1, #${lo(ctx)}; movt r1, #${hi(ctx)}
     pop {r4, lr}
     b #${module + entry}`, at), 16);
  patch.setWord(FLASH_PROGRAM_CALL, branchTo(FLASH_PROGRAM_CALL, wrapper, true), 'Direct Flash: exposure after the flash program');

  // --- Menu lists (records 11 and 12), in place.
  LISTS.forEach((h, k) => {
    const rec = LIST_RECORDS[k];
    const handlers: Record<string, number> = {
      count: patch.append((at) => assembleWords(countHandlerAsm(h), at), 16),
      draw: patch.append((at) => assembleWords(drawAsm(h, h.slots.draw[1]), at), 16),
      set: patch.append((at) => assembleWords(setAsm(h, h.slots.set[1]), at), 16),
      current: patch.append((at) => assembleWords(currentAsm(h, h.slots.current[1]), at), 16),
    };
    for (const [name, [off]] of Object.entries(h.slots)) patch.setWord(rec + off, handlers[name], `Direct Flash: ${h.what}, ${name}`);
  });

  // --- ADJ lever and Fn list, in place.
  for (const [h, rec, view] of [[ADJ, ADJ_RECORD, VIEW.adj], [FN, FN_RECORD, VIEW.fn]] as const) {
    const handlers: Record<string, number> = {
      text: patch.append((at) => assembleWords(textAsm(h, h.slots.text[1], view.text), at), 16),
      icon: patch.append((at) => assembleWords(iconAsm(h, h.slots.icon[1], view.icons), at), 16),
      current: patch.append((at) => assembleWords(currentAsm(h, h.slots.current[1]), at), 16),
      set: patch.append((at) => assembleWords(setAsm(h, h.slots.set[1]), at), 16),
      count: patch.append((at) => assembleWords(countHandlerAsm(h), at), 16),
    };
    for (const [name, [off]] of Object.entries(h.slots)) patch.setWord(rec + off, handlers[name], `Direct Flash: ${h.what}, ${name}`);
  }

  // --- The current value's icon (resources, value, variant): value 0 with the byte set.
  const currentIcon = patch.append((at) => assembleWords(
    `cmp r1, #0; bne #${FLASH_ICON}
     cmp r2, #0; bne #${FLASH_ICON}
     movw ip, #${lo(DIRECT_FLASH_BYTE)}; movt ip, #${hi(DIRECT_FLASH_BYTE)}; ldrb ip, [ip]
     tst ip, #1; beq #${FLASH_ICON}
     movw r0, #${DIRECT_FLASH_ICON_ID}; bx lr`, at), 16);
  for (const [site, link] of CURRENT_ICON_SITES) patch.setWord(site, branchTo(site, currentIcon, link), 'Direct Flash: icon of the current Flash Mode');

  // --- Name: text 926 in all 21 languages.
  const descriptors: number[] = [];
  DIRECT_FLASH_NAMES.forEach((text) => {
    const encoded = utf16z(text);
    const units = encoded.length / 2;
    if (!(units > 1 && units < 256) || text.includes('\n')) fail('internal', 'bad Direct Flash name');
    const address = patch.append(encoded, 4);
    descriptors.push(patch.append(concat([Uint8Array.from([units, 1, 0, 0]), u32le([address])]), 4));
  });
  const roots = new DataView(patch.readMapped(NATIVE_TEXT_ROOTS, LANGUAGES * 4).buffer);
  const seen = new Set<number>();
  for (let l = 0; l < LANGUAGES; l++) {
    const k = (roots.getUint32(l * 4, true) + 4 - FIRST_TABLE_RAM) / TABLE_STRIDE;
    if (!(Number.isInteger(k) && k >= 0 && k < LANGUAGES) || seen.has(k)) fail('unexpected-layout', 'language tables are not where they were expected');
    seen.add(k);
    const row = patch.word(TEXT_CATALOG + l * 4);
    if (patch.word(row + DIRECT_FLASH_TEXT_ID * 4) !== 0) fail('unexpected-layout', 'text number already in use');
    patch.write(row + DIRECT_FLASH_TEXT_ID * 4, u32le([descriptors[k]]));
  }
  for (const site of patch.textBoundSites) patch.setWord(site, movWord(3, Math.max(DIRECT_FLASH_TEXT_ID, movImmediate(patch.word(site)))), 'text upper bound');

  // --- Icon 733.
  const pad = (4 - (iconbin.length % 4)) % 4;
  const iconOffset = iconbin.length + pad;
  const icon = drawDirectFlashIcon();
  const descriptor = patch.append(concat([u16le([1, DIRECT_FLASH_ICON_W, DIRECT_FLASH_ICON_H, 0]), u32le([iconOffset / 4])]), 16);
  patch.write(ICON_CATALOG + DIRECT_FLASH_ICON_ID * 4, u32le([descriptor]));
  for (const [site, register] of LOOKUP_BOUNDS) {
    patch.setWord(site, movWord(register, Math.max(DIRECT_FLASH_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  const out = new Uint8Array(iconOffset + icon.length);
  out.set(iconbin);
  out.set(icon, iconOffset);
  return out;
}


