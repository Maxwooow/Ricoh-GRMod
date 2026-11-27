// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60 (round 10, with films and `liveLayout`): a screen in the camera's menu to order the
 * Image Control lists and show or hide their looks (the layout kept in the camera, native/films.c -DLIVE_LAYOUT).
 *
 * A line at the end of the still menu's last page (as datestamp.ts adds the date imprint's: two copies of the
 * still descriptor, each without one of the two model-specific items, ND or HDF; the builder stores the one of
 * the camera's model) opens the End Screen list (GoodByeDisplaySetController, endscreen.ts) in a mode of its own:
 * the factory hands that controller out for the line's id and sets LOOKS_MODE (a word of the gap before the heap,
 * cleared at every start), and clears it when asked for the End Screen list itself; the key map gives the line's
 * id the keys of GR3X_LOOK_MENU_KEYS_ID (see below). The list is built with one row more than the layout has entries (two in the
 * camera's mode, as before: refresh shows them, under the End Screen picture). In the looks mode the list is made
 * taller (six rows, ScrollListView's SetRect; lm_camera puts it back for the End Screen) and its handlers go to the
 * films' module: the rows are the shown entries in order, a separator ("Hidden"), the hidden entries;
 *   refresh   lm_refresh: the rows by name, the title;
 *   OK        lm_toggle: takes the row under the cursor (the title says so, the row is ticked) or puts it down;
 *   up / down lm_up / lm_down: the row taken one place up / down (across the separator: hidden / shown again, not
 *             Standard, the Custom entries or a look selected in a set), else the cursor;
 *   footer    lm_footer: no picture.
 * Only up, down and OK: on this list the camera takes left as Back and gives right nothing (camera test, round 2).
 * The keys: ActionModel::OnEvent (0x53221a1c) turns a key into the current controller's events by its id (read at
 * 0x53221a4c, where the key map comes in). The End Screen list's (0x532157f8) posts 0xd8 (confirm) then 0xa2 (back to
 * the parent menu) for OK: the End Screen list closes on OK (camera test, round 2 and 3). The key is in r5 where the
 * key map is read (0x53221a38 `mov r5,r1`): for OK (keys 14 and 50) the line's id takes the keys of 0x04000023
 * (handler 0x53214138: 0xd8 alone), for every other key the End Screen list's (left, key 11, 0xd8 then 0xa2, back
 * to the menu; MENU 0xda then 0x35). Camera tests: round 4 gave every key 0x04000023's (left took the row too, MENU
 * 0x35 alone did nothing); round 5 D-Range's (0x020000ba, 0x53215d50: left 0xa2 alone and MENU did nothing).
 * The layout is saved at power off (record 15). Not with the date imprint or the End Screen pictures (they use
 * the same sites).
 */
import { branchWord, movWord } from '../aspect/arm';
import { FirmwareError } from '../types';
import { GR3X_MENU_SITES as M } from './datestamp';
import { GR3X_END_SCREEN_ID, GR3X_END_SCREEN_SITES as E } from './endscreen';
import { adr } from './target';

/** The line's (and the screen's) controller id: unused (GR III's end at 0x02000140; GR Mod's from 0x020001a0). */
export const GR3X_LOOK_MENU_ID = 0x020001a8;
/** The End Screen list's looks mode: a word of the gap before the heap (round 10's fill clears it). */
export const GR3X_LOOK_MENU_MODE = () => adr(0x55804390);
/** The camera's functions the module calls, in native/films.c's LM_ order, then the title. */
export const GR3X_LOOK_MENU_FUNCTIONS = () => [adr(0x53394820), adr(0x53394758), adr(0x53395430), adr(0x53395260), adr(0x5339e738), adr(0x5339e7a0),
  adr(0x533ad3c0), adr(0x53394e8c), adr(0x533a2ba0), adr(0x5320ad88), adr(0x5320b67c), adr(0x532a985c)];
/** The texts, one per camera language (GR3X_TEXT_ROWS order), each at most 24 characters and only characters that
 * language's own camera texts use (so its font has them), built from the camera's words ("Image Control", the "Order"
 * of "Bracketing Order"): the line's and screen's name, the separator, the title while moving. */
export const GR3X_LOOK_MENU_NAMES: readonly string[] = [
  /* ja */ 'イメージコントロール順序',
  /* en */ 'Image Control Order',
  /* fr */ 'Ordre contrôle image',
  /* de */ 'Reihenf. Bildsteuerung',
  /* es */ 'Orden control de imagen',
  /* pt */ 'Ordem Controlo Imagem',
  /* it */ 'Ordine controllo immag.',
  /* nl */ 'Volgorde beeldregeling',
  /* da */ 'Rækkefølge billedkontr.',
  /* sv */ 'Ordning bildkontroll',
  /* fi */ 'Kuvansäädön järjestys',
  /* pl */ 'Kolejność ster. obrazem',
  /* cs */ 'Pořadí ovládání obrazu',
  /* hu */ 'Képvezérlés sorrendje',
  /* tr */ 'Görüntü Kontrolü Sırası',
  /* el */ 'Σειρά Ελέγχου Εικόνας',
  /* ru */ 'Порядок упр. изобр.',
  /* ko */ '화상 컨트롤 순서',
  /* zh-TW */ '影像控制順序',
  /* zh-CN */ '影像控制顺序',
  /* th */ 'ลำดับควบคุมภาพ',
];
export const GR3X_LOOK_MENU_SEPARATOR: readonly string[] = [
  /* ja */ '--- 表示しない ---',
  /* en */ '--- Hidden ---',
  /* fr */ '--- Masqués ---',
  /* de */ '--- Ausgeblendet ---',
  /* es */ '--- Ocultos ---',
  /* pt */ '--- Ocultos ---',
  /* it */ '--- Nascosti ---',
  /* nl */ '--- Verborgen ---',
  /* da */ '--- Skjulte ---',
  /* sv */ '--- Dolda ---',
  /* fi */ '--- Piilotetut ---',
  /* pl */ '--- Ukryte ---',
  /* cs */ '--- Skryté ---',
  /* hu */ '--- Rejtett ---',
  /* tr */ '--- Gizli ---',
  /* el */ '--- Κρυφά ---',
  /* ru */ '--- Скрытые ---',
  /* ko */ '--- 표시 안 함 ---',
  /* zh-TW */ '--- 不顯示 ---',
  /* zh-CN */ '--- 不显示 ---',
  /* th */ '--- ซ่อน ---',
];
export const GR3X_LOOK_MENU_MOVING: readonly string[] = [
  /* ja */ '上下で移動、OKで決定',
  /* en */ 'Move: up/down, then OK',
  /* fr */ 'Déplacer : haut/bas, OK',
  /* de */ 'Auf/ab verschieben, OK',
  /* es */ 'Mover: arriba/abajo, OK',
  /* pt */ 'Mover: cima/baixo, OK',
  /* it */ 'Sposta: alto/basso, OK',
  /* nl */ 'Verplaats: op/neer, OK',
  /* da */ 'Flyt: op/ned, så OK',
  /* sv */ 'Flytta: upp/ner, OK',
  /* fi */ 'Siirrä: ylös/alas, OK',
  /* pl */ 'Przesuń: góra/dół, OK',
  /* cs */ 'Přesun: nahoru/dolů, OK',
  /* hu */ 'Mozgatás: fel/le, OK',
  /* tr */ 'Taşı: yukarı/aşağı, OK',
  /* el */ 'Μετακ.: πάνω/κάτω, OK',
  /* ru */ 'Вверх/вниз, затем OK',
  /* ko */ '위/아래로 이동, OK',
  /* zh-TW */ '上下移動，按 OK 確定',
  /* zh-CN */ '上下移动，按 OK 确定',
  /* th */ 'เลื่อนขึ้น/ลง แล้ว OK',
];

/** A controller id whose keys (ActionModel's handler 0x53214138, reached at 0x53222a74) are the End Screen list's but OK
 * confirms without going back. */
export const GR3X_LOOK_MENU_KEYS_ID = 0x04000023;
const KEYS_HANDLER = () => adr(0x53214138), KEYS_CALL = () => adr(0x53222a74), KEY_IN_R5 = () => adr(0x53221a38);
/** OK and its twin (key numbers of ActionModel::OnEvent's handlers). */
const OK_KEYS = [14, 50];
const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const addr = (r: string, a: number) => `movw ${r},#${lo(a)};movt ${r},#${hi(a)};`;
const bl = (at: number, target: number) => branchWord(at, target, 14, true);
const fail = (m: string): never => { throw new FirmwareError('unexpected-layout', `IIIx look menu: ${m}`); };

export interface Gr3xLookMenuProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  u32(address: number): number;
  read(address: number, size: number): Uint8Array;
}

export interface Gr3xLookMenuOptions {
  /** The films' module's entry points (lm_refresh, lm_footer, lm_up, lm_down, lm_toggle, lm_camera). */
  module: Record<string, number>;
  /** The layout's entries (rows of the screen). */
  entries: number;
  /** The line's text. */
  text: number;
}

export function installGr3xLookMenu(p: Gr3xLookMenuProgram, o: Gr3xLookMenuOptions) {
  const n = o.entries;
  if (!Number.isInteger(n) || n < 3 || n > 40) fail('entries');
  for (const name of ['lm_refresh', 'lm_footer', 'lm_up', 'lm_down', 'lm_toggle', 'lm_camera']) if (o.module[name] === undefined) fail(`module ${name}`);
  const MODE = GR3X_LOOK_MENU_MODE(), ID = GR3X_LOOK_MENU_ID, END = GR3X_END_SCREEN_ID;
  // --- The camera's code and data as audited.
  const guards: readonly (readonly [number, number])[] = [
    [M.BUILDER, 0xe1a0c00d], [M.BUILDER + 4, movWord(3, lo(M.MENU_TABLE))], [M.BUILDER + 0x10, movWord(3, hi(M.MENU_TABLE), true)],
    [M.FACTORY, movWord(3, M.FACTORY_LAST)], [M.FACTORY + 4, 0xe1a0c00d], [M.FACTORY + 8, movWord(3, 0x200, true)],
    [M.KEY_MAP_READ, bl(M.KEY_MAP_READ, M.CURRENT_ID_GETTER)], [M.CURRENT_ID_GETTER, 0xe5900000], [M.CURRENT_ID_GETTER + 4, 0xe12fff1e],
    [M.APP, 0xe1a0c00d], [M.SPEC_MODEL, 0xe1a0c00d], [M.LINE_VALUE_ICON, 0xe1a0c00d], [M.TOP_SET_TITLE, 0xe1a0c00d],
    [E.REFRESH, 0xe1a0c00d], [E.CONFIRM, 0xe5900168], [E.UP, 0xe1a0c00d], [E.DOWN, 0xe1a0c00d], [E.FOOTER, 0xe1a0c00d],
    [E.ROWS_AT, 0xe3a02002], [E.TYPES_AT, 0xe54b3034], [E.TYPES_AT - 4, 0xe3a03015], [E.TYPES_AT + 8, 0xe54b3033],
    [E.LIST_SHOWN, 0xe1a0c00d], [E.TITLE_SET, 0xe1a0c00d], [E.GRAPHIC_VISIBLE, 0xe5d0209e],
    [KEYS_HANDLER(), 0xe2411001], [KEYS_HANDLER() + 0x10, 0xe351003f], [KEYS_CALL(), bl(KEYS_CALL(), KEYS_HANDLER())], [KEY_IN_R5(), 0xe1a05001],
  ];
  for (const [at, w] of guards) if (p.u32(at) !== w >>> 0) fail(`guard at ${at.toString(16)}`);
  const still = p.read(M.STILL_MENU, M.DESCRIPTOR), dv = new DataView(still.buffer);
  if (new DataView(p.read(M.MENU_TABLE, 4).buffer).getUint32(0, true) !== M.STILL_MENU) fail('still menu descriptor');
  if (still[M.D_PAGES] !== 7 || [...still.subarray(M.D_FIRST, M.D_FIRST + 7)].join() !== M.OFFICIAL_FIRSTS.join() || still[M.D_COUNT] !== M.MAX_ITEMS) fail('still menu pages');
  const id = (i: number) => dv.getUint32(M.D_ID + i * 4, true), visible = (i: number) => dv.getUint32(M.D_VISIBLE + i * 8, true);
  if (id(M.ND_ITEM) !== 0x02000069 || visible(M.ND_ITEM) !== adr(0x531966e4) || id(M.HDF_ITEM) !== 0x0200013f || visible(M.HDF_ITEM) !== adr(0x53196708)) fail('ND / HDF items');
  for (let i = 0; i < M.MAX_ITEMS; i++) if (id(i) === ID) fail('id in use');
  for (const v of [adr(0x531966e4), adr(0x53196708)])
    if (p.u32(v + 0xc) !== bl(v + 0xc, M.APP) || p.u32(v + 0x10) !== bl(v + 0x10, M.SPEC_MODEL) || p.u32(v + 0x14) !== bl(v + 0x14, M.MODEL_NUMBER)) fail('model visibility');

  const mod = o.module;
  const inMode = `${addr('ip', MODE)}ldr ip,[ip];cmp ip,#0;`;
  // --- The End Screen list in the looks mode.
  const handler = (at: number, original: string, name: string, what: string) => {
    const target = p.code(`${inMode}beq native;b #${mod[name]};native:${original};b #${at + 4};`);
    p.patch(at, p.u32(at), branchWord(at, target), what);
    return target;
  };
  const confirm = handler(E.CONFIRM, 'ldr r0,[r0,#0x168]', 'lm_toggle', 'look menu: OK takes / puts down the row');
  const up = handler(E.UP, 'mov ip,sp', 'lm_up', 'look menu: up');
  const down = handler(E.DOWN, 'mov ip,sp', 'lm_down', 'look menu: down');
  const footer = handler(E.FOOTER, 'mov ip,sp', 'lm_footer', 'look menu: no footer picture');
  // Refresh: the camera's mode its place, two rows (the list has n + 1), its title and footer picture (the looks
  // mode changed them); the looks mode is the module's.
  const refresh = p.code(`${inMode}bne mode;push {r4,lr};mov r4,r0;bl #${mod.lm_camera};ldr r0,[r4,#0x168];mov r1,#2;bl #${E.LIST_SHOWN};
    ldr r0,[r4,#0x15c];movw r1,#${E.TITLE};bl #${E.TITLE_SET};ldr r0,[r4,#0x164];mov r1,#1;bl #${E.GRAPHIC_VISIBLE};mov r0,r4;pop {r4,lr};
    mov ip,sp;b #${E.REFRESH + 4};mode:b #${mod.lm_refresh};`);
  p.patch(E.REFRESH, 0xe1a0c00d, branchWord(E.REFRESH, refresh), 'look menu: the End Screen list\'s rows, or the looks');
  // n + 1 rows (the separator; row type 0x15, as the camera's two).
  const rows = Math.max(2, n + 1);
  const types = p.append(new Uint8Array(rows).fill(E.ROW_TYPE));
  p.patch(E.ROWS_AT, 0xe3a02002, (0xe3a02000 | rows) >>> 0, 'look menu: rows of the End Screen list');
  const typesAt = p.code(`strb r3,[fp,#-0x34];${addr('r1', types)}b #${E.TYPES_AT + 4};`);
  p.patch(E.TYPES_AT, 0xe54b3034, branchWord(E.TYPES_AT, typesAt), 'look menu: row types');

  // --- The still menu's line (this r0, line r1): no value, the name.
  const line = p.code(`push {r4,lr};mov r4,r1;mov r0,r4;mov r1,#0;bl #${M.LINE_VALUE_ICON};mov r0,r4;movw r1,#${o.text};mov r2,r1;
    pop {r4,lr};b #${M.TOP_SET_TITLE};`);
  const descriptor = (drop: number, firsts: readonly number[]) => {
    const d = still.slice(), v = new DataView(d.buffer);
    const items = Array.from({ length: M.MAX_ITEMS }, (_, i) => i).filter(i => i !== drop);
    items.forEach((i, j) => {
      d.set(still.subarray(M.D_DRAW + i * 8, M.D_DRAW + i * 8 + 8), M.D_DRAW + j * 8);
      d.set(still.subarray(M.D_ID + i * 4, M.D_ID + i * 4 + 4), M.D_ID + j * 4);
      d.set(still.subarray(M.D_VISIBLE + i * 8, M.D_VISIBLE + i * 8 + 8), M.D_VISIBLE + j * 8);
    });
    const last = M.MAX_ITEMS - 1;
    v.setUint32(M.D_DRAW + last * 8, line, true); v.setUint32(M.D_DRAW + last * 8 + 4, 0, true);
    v.setUint32(M.D_ID + last * 4, ID, true);
    v.setUint32(M.D_VISIBLE + last * 8, 0, true); v.setUint32(M.D_VISIBLE + last * 8 + 4, 0, true);
    d.set(firsts, M.D_FIRST);
    d[M.D_COUNT] = M.MAX_ITEMS;
    return d;
  };
  const withoutNd = p.append(descriptor(M.ND_ITEM, M.FIRSTS_WITHOUT_ND));
  const withoutHdf = p.append(descriptor(M.HDF_ITEM, M.FIRSTS_WITHOUT_HDF));
  const builder = p.code(`push {r0-r3,ip,lr};bl #${M.APP};bl #${M.SPEC_MODEL};bl #${M.MODEL_NUMBER};
    ${addr('r1', withoutHdf)}cmp r0,#1;movweq r1,#${lo(withoutNd)};movteq r1,#${hi(withoutNd)};
    ${addr('r2', M.MENU_TABLE)}str r1,[r2];pop {r0-r3,ip,lr};mov ip,sp;b #${M.BUILDER + 4};`);
  p.patch(M.BUILDER, 0xe1a0c00d, branchWord(M.BUILDER, builder), 'look menu: still menu with its line, for this model');
  // --- The factory: the End Screen list for the line's id (looks mode) or its own (camera's mode).
  const factory = p.code(`${addr('ip', ID)}cmp r1,ip;bne fend;${addr('r1', END)}mov ip,#1;b fset;
    fend:${addr('ip', END)}cmp r1,ip;bne fdone;mov ip,#0;fset:${addr('r3', MODE)}str ip,[r3];
    fdone:movw r3,#${M.FACTORY_MOVW};b #${M.FACTORY + 4};`);
  p.patch(M.FACTORY, movWord(3, M.FACTORY_LAST), branchWord(M.FACTORY, factory), 'look menu: the End Screen list for its line');
  const keys = p.code(`ldr r0,[r0];${addr('ip', ID)}cmp r0,ip;bxne lr;${addr('r0', END)}cmp r5,#${OK_KEYS[0]};cmpne r5,#${OK_KEYS[1]};
    movweq r0,#${lo(GR3X_LOOK_MENU_KEYS_ID)};movteq r0,#${hi(GR3X_LOOK_MENU_KEYS_ID)};bx lr;`);
  p.patch(M.KEY_MAP_READ, bl(M.KEY_MAP_READ, M.CURRENT_ID_GETTER), bl(M.KEY_MAP_READ, keys), 'look menu: OK confirms only, the other keys as the End Screen list\'s');
  return { lookMenuConfirm: confirm, lookMenuUp: up, lookMenuDown: down, lookMenuFooter: footer, lookMenuRefresh: refresh,
    lookMenuTypes: types, lookMenuTypesAt: typesAt, lookMenuLine: line, lookMenuWithoutNd: withoutNd, lookMenuWithoutHdf: withoutHdf,
    lookMenuBuilder: builder, lookMenuFactory: factory, lookMenuKeys: keys, lookMenuRows: rows, lookMenuText: o.text };
}
